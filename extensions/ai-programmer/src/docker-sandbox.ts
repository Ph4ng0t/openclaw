import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DOCKER_BIN = "docker";
const PROXY_ENV_NAMES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
] as const;

export type FsGrant = { path: string; access: "ro" | "rw" };

export type DockerSandboxHandle = {
  containerName: string;
  wrapperScriptPath: string;
};

function rewriteLoopbackProxyUrl(raw: string): { value: string; rewroteLoopback: boolean } {
  try {
    const url = new URL(raw);
    const host = url.hostname.trim().toLowerCase();
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
      return { value: raw, rewroteLoopback: false };
    }
    url.hostname = "host.docker.internal";
    return { value: url.toString(), rewroteLoopback: true };
  } catch {
    return { value: raw, rewroteLoopback: false };
  }
}

function buildDockerProxyEnvArgs(): { envArgs: string[]; needsHostGateway: boolean } {
  const envArgs: string[] = [];
  let needsHostGateway = false;

  for (const name of PROXY_ENV_NAMES) {
    const raw = process.env[name]?.trim();
    if (!raw) {
      continue;
    }
    const rewritten = name.toLowerCase().endsWith("_proxy")
      ? rewriteLoopbackProxyUrl(raw)
      : { value: raw, rewroteLoopback: false };
    envArgs.push("-e", `${name}=${rewritten.value}`);
    needsHostGateway ||= rewritten.rewroteLoopback;
  }

  return { envArgs, needsHostGateway };
}

export async function startDockerSandbox(params: {
  image: string;
  workspaceDir: string;
  fsGrants?: FsGrant[]; // from api.config.tools.fs.grants
  codexAuthDir?: string; // default: ~/.codex
}): Promise<DockerSandboxHandle> {
  const codexAuthDir = params.codexAuthDir?.trim() || path.join(homedir(), ".codex");
  const id = randomBytes(8).toString("hex");
  const containerName = `ai-programmer-sandbox-${id}`;
  const wrapperScriptPath = path.join(tmpdir(), `ai-programmer-wrapper-${id}.sh`);
  const { envArgs, needsHostGateway } = buildDockerProxyEnvArgs();

  const mountArgs: string[] = [
    // workspace at same path (rw)
    "-v",
    `${params.workspaceDir}:${params.workspaceDir}`,
    // codex updates auth/session state during normal operation; keep this writable.
    "-v",
    `${codexAuthDir}:/root/.codex`,
  ];

  // fsGrant mounts at same host paths (matching the Feishu sandbox container)
  for (const grant of params.fsGrants ?? []) {
    const p = grant.path.trim();
    if (!p) continue;
    const suffix = grant.access === "rw" ? "" : ":ro";
    mountArgs.push("-v", `${p}:${p}${suffix}`);
  }

  await execFileAsync(DOCKER_BIN, [
    "run",
    "--name",
    containerName,
    "--rm",
    "-d",
    ...(needsHostGateway ? ["--add-host", "host.docker.internal:host-gateway"] : []),
    ...envArgs,
    ...mountArgs,
    params.image,
    "tail",
    "-f",
    "/dev/null",
  ]);

  const script = `#!/bin/sh\nexec ${DOCKER_BIN} exec -i ${containerName} acpx "$@"\n`;
  try {
    writeFileSync(wrapperScriptPath, script, { mode: 0o700 });
  } catch (err) {
    await stopDockerSandbox({ containerName, wrapperScriptPath }).catch(() => {});
    throw err;
  }
  return { containerName, wrapperScriptPath };
}

export async function stopDockerSandbox(handle: DockerSandboxHandle): Promise<void> {
  try {
    unlinkSync(handle.wrapperScriptPath);
  } catch {
    /* already gone */
  }
  try {
    await execFileAsync(DOCKER_BIN, ["stop", handle.containerName]);
  } catch {
    await execFileAsync(DOCKER_BIN, ["rm", "-f", handle.containerName]).catch(() => {});
  }
}
