import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { readConfigFileSnapshot, writeConfigFile } from "../config/config.js";
import { applyMergePatch } from "../config/merge-patch.js";
import type { OpenClawConfig } from "../config/types.js";
import { getPrivilegedCommandSpec, type PrivilegedCommandSpec } from "./command-registry.js";
import type { PrivilegedRequestRecord } from "./types.js";

const execFileAsync = promisify(execFile);

const ALLOWED_CONFIG_PATCH_PREFIXES = [
  "tools.fs.grants",
  "privileged",
  "agents.defaults.sandbox",
  "agents.list",
] as const;

function assertNeverPrivilegedKind(_value: never): never {
  throw new Error(`Unsupported privileged request kind`);
}

export async function applyPrivilegedRequest(record: PrivilegedRequestRecord): Promise<string> {
  if (record.kind === "fs_grant") {
    return await applyFsGrant(record);
  }
  if (record.kind === "fs_revoke") {
    return await applyFsRevoke(record);
  }
  if (record.kind === "config_patch") {
    return await applyConfigPatch(record);
  }
  if (record.kind === "shutdown") {
    return await runRegisteredCommand({
      command: getRequiredCommand("system.shutdown"),
      cwd: undefined,
      argv: [],
    });
  }
  if (record.kind === "reboot") {
    return await runRegisteredCommand({
      command: getRequiredCommand("system.reboot"),
      cwd: undefined,
      argv: [],
    });
  }
  if (record.kind === "host_exec") {
    const payload = record.payload as { commandId?: string; argv?: string[]; cwd?: string };
    const commandId = typeof payload.commandId === "string" ? payload.commandId : "";
    return await runRegisteredCommand({
      command: getRequiredCommand(commandId),
      cwd: typeof payload.cwd === "string" ? payload.cwd : undefined,
      argv: Array.isArray(payload.argv)
        ? payload.argv.filter((value): value is string => typeof value === "string")
        : [],
    });
  }
  return assertNeverPrivilegedKind(record.kind);
}

async function applyFsGrant(record: PrivilegedRequestRecord): Promise<string> {
  const payload = record.payload as {
    path?: string;
    access?: "ro" | "rw";
    persistent?: boolean;
    reason?: string;
    expiresAt?: number;
  };
  const grantPath = typeof payload.path === "string" ? path.resolve(payload.path) : "";
  if (!grantPath) {
    throw new Error("fs_grant requires path");
  }
  const access = payload.access === "ro" ? "ro" : "rw";
  const snapshot = await readConfigFileSnapshot();
  const cfg = structuredClone(snapshot.config);
  const grants = [...(cfg.tools?.fs?.grants ?? [])];
  const next = grants.filter((grant) => path.resolve(grant.path) !== grantPath);
  next.push({
    path: grantPath,
    access,
    persistent: payload.persistent,
    reason: payload.reason,
    expiresAt: payload.expiresAt,
  });
  cfg.tools = { ...cfg.tools, fs: { ...cfg.tools?.fs, grants: next } };
  await writeConfigFile(cfg);
  return `Granted ${access} access to ${grantPath}`;
}

async function applyFsRevoke(record: PrivilegedRequestRecord): Promise<string> {
  const payload = record.payload as { path?: string };
  const grantPath = typeof payload.path === "string" ? path.resolve(payload.path) : "";
  if (!grantPath) {
    throw new Error("fs_revoke requires path");
  }
  const snapshot = await readConfigFileSnapshot();
  const cfg = structuredClone(snapshot.config);
  const next = (cfg.tools?.fs?.grants ?? []).filter(
    (grant) => path.resolve(grant.path) !== grantPath,
  );
  cfg.tools = { ...cfg.tools, fs: { ...cfg.tools?.fs, grants: next } };
  await writeConfigFile(cfg);
  return `Revoked access to ${grantPath}`;
}

async function applyConfigPatch(record: PrivilegedRequestRecord): Promise<string> {
  const payload = record.payload as {
    patch?: Array<{ op?: string; path?: string; value?: unknown }>;
  };
  const operations = Array.isArray(payload.patch) ? payload.patch : [];
  if (operations.length === 0) {
    throw new Error("config_patch requires patch operations");
  }
  const snapshot = await readConfigFileSnapshot();
  let nextConfig = structuredClone(snapshot.config);
  for (const op of operations) {
    const targetPath = typeof op.path === "string" ? op.path.trim() : "";
    if (!isAllowedConfigPath(targetPath)) {
      throw new Error(`config_patch path not allowed: ${targetPath || "<empty>"}`);
    }
    if (op.op === "unset") {
      unsetPath(nextConfig as Record<string, unknown>, splitPath(targetPath));
      continue;
    }
    if (op.op !== "set") {
      throw new Error(`Unsupported config_patch op: ${String(op.op)}`);
    }
    nextConfig = applyMergePatch(
      nextConfig,
      buildMergePatch(splitPath(targetPath), op.value),
    ) as OpenClawConfig;
  }
  await writeConfigFile(nextConfig);
  return `Applied ${operations.length} config change(s)`;
}

function isAllowedConfigPath(targetPath: string): boolean {
  return ALLOWED_CONFIG_PATCH_PREFIXES.some(
    (prefix) => targetPath === prefix || targetPath.startsWith(`${prefix}.`),
  );
}

function splitPath(targetPath: string): string[] {
  return targetPath
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);
}

function unsetPath(root: Record<string, unknown>, parts: string[]): void {
  if (parts.length === 0) {
    return;
  }
  let cursor: Record<string, unknown> | undefined = root;
  for (const part of parts.slice(0, -1)) {
    const next = cursor?.[part];
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      return;
    }
    cursor = next as Record<string, unknown>;
  }
  if (cursor) {
    delete cursor[parts.at(-1)!];
  }
}

function buildMergePatch(parts: string[], value: unknown): Record<string, unknown> {
  if (parts.length === 0) {
    return {};
  }
  const [head, ...rest] = parts;
  if (rest.length === 0) {
    return { [head]: value };
  }
  return { [head]: buildMergePatch(rest, value) };
}

function getRequiredCommand(commandId: string): PrivilegedCommandSpec {
  const command = getPrivilegedCommandSpec(commandId);
  if (!command) {
    throw new Error(`Unknown privileged command: ${commandId}`);
  }
  return command;
}

async function runRegisteredCommand(params: {
  command: PrivilegedCommandSpec;
  argv: string[];
  cwd?: string;
}): Promise<string> {
  const argv = [...params.command.argv, ...params.argv];
  const cwd = params.command.allowCwd ? params.cwd : undefined;
  const { stdout, stderr } = await execFileAsync(argv[0], argv.slice(1), {
    cwd,
    encoding: "utf8",
  });
  return [stdout?.trim(), stderr?.trim()].filter(Boolean).join("\n");
}
