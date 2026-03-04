import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { readConfigFileSnapshot, writeConfigFile } from "../config/config.js";
import { applyMergePatch } from "../config/merge-patch.js";
import type { OpenClawConfig } from "../config/types.js";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { buildNodeShellCommand } from "../infra/node-shell.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { getPrivilegedCommandSpec, type PrivilegedCommandSpec } from "./command-registry.js";
import { refreshSandboxForFsGrant } from "./sandbox-refresh.js";
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
    const payload = record.payload as {
      command?: string;
      commandId?: string;
      argv?: string[];
      cwd?: string;
      host?: string;
      nodeId?: string;
    };
    const command = typeof payload.command === "string" ? payload.command.trim() : "";
    if (command) {
      const result = await runHostCommand({
        command,
        cwd: typeof payload.cwd === "string" ? payload.cwd : undefined,
        host: payload.host,
        nodeId: payload.nodeId,
      });
      queueHostExecResult({
        record,
        command,
        cwd: typeof payload.cwd === "string" ? payload.cwd : undefined,
        result,
      });
      return result;
    }
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

function queueHostExecResult(params: {
  record: PrivilegedRequestRecord;
  command: string;
  cwd?: string;
  result: string;
}): void {
  const sessionKey = params.record.requestedBy?.sessionKey?.trim();
  if (!sessionKey) {
    return;
  }
  const lines = [
    "Exec finished (gateway privileged, code 0)",
    `Command: ${params.command}`,
    params.cwd ? `Cwd: ${params.cwd}` : "",
    params.result,
  ].filter(Boolean);
  enqueueSystemEvent(lines.join("\n"), { sessionKey });
  requestHeartbeatNow({
    reason: "exec-event",
    sessionKey,
    agentId: params.record.requestedBy?.agentId ?? undefined,
  });
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
  const refreshMessage = await refreshSandboxAfterFsGrant({ cfg, record });
  const retryMessage = queueFsGrantRetry({ record, grantPath, access, refreshMessage });
  return [`Granted ${access} access to ${grantPath}`, refreshMessage, retryMessage]
    .filter(Boolean)
    .join(" ");
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

async function runHostCommand(params: {
  command: string;
  cwd?: string;
  host?: string;
  nodeId?: string;
}): Promise<string> {
  if (params.host === "node") {
    const label = params.nodeId?.trim() ? `:${params.nodeId.trim()}` : "";
    throw new Error(`host_exec for node${label} is not supported by privileged approvals`);
  }
  const argv = buildNodeShellCommand(params.command, process.platform);
  const { stdout, stderr } = await execFileAsync(argv[0], argv.slice(1), {
    cwd: params.cwd,
    encoding: "utf8",
  });
  return [stdout?.trim(), stderr?.trim()].filter(Boolean).join("\n") || "Host command completed.";
}

async function refreshSandboxAfterFsGrant(params: {
  cfg: OpenClawConfig;
  record: PrivilegedRequestRecord;
}): Promise<string | null> {
  try {
    return await refreshSandboxForFsGrant({
      cfg: params.cfg,
      requestedBy: params.record.requestedBy,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Sandbox refresh pending (${message}).`;
  }
}

function queueFsGrantRetry(params: {
  record: PrivilegedRequestRecord;
  grantPath: string;
  access: "ro" | "rw";
  refreshMessage: string | null;
}): string | null {
  const sessionKey = params.record.requestedBy?.sessionKey?.trim();
  if (!sessionKey) {
    return null;
  }
  const accessLabel = params.access === "rw" ? "read/write" : "read-only";
  const refreshLabel = params.refreshMessage
    ? "The sandbox was refreshed automatically."
    : "If a sandbox is active, it will pick up the new grant on the next container start.";
  enqueueSystemEvent(
    [
      `Filesystem permission approved for ${params.grantPath} (${accessLabel}).`,
      refreshLabel,
      "Immediately retry the blocked file operation that needed this path.",
    ].join(" "),
    { sessionKey },
  );
  requestHeartbeatNow({
    reason: "privileged:fs-grant-approved",
    sessionKey,
    agentId: params.record.requestedBy?.agentId ?? undefined,
  });
  return "Queued an automatic retry for the waiting agent.";
}
