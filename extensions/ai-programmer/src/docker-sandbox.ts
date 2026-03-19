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

// Explicit proxy overrides — take precedence over host env vars when set.
export type ProxyOverrides = {
  httpProxy?: string;
  httpsProxy?: string;
  allProxy?: string;
  noProxy?: string;
};

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

function buildDockerProxyEnvArgs(
  overrides?: ProxyOverrides,
  // When true (--network=host), 127.0.0.1 is directly reachable — skip rewriting.
  skipLoopbackRewrite?: boolean,
): {
  envArgs: string[];
  needsHostGateway: boolean;
} {
  // Merge env vars with explicit overrides (overrides take precedence).
  const merged: Partial<Record<(typeof PROXY_ENV_NAMES)[number], string>> = {};
  for (const name of PROXY_ENV_NAMES) {
    const raw = process.env[name]?.trim();
    if (raw) merged[name] = raw;
  }
  if (overrides?.httpProxy) {
    merged["HTTP_PROXY"] = overrides.httpProxy;
    merged["http_proxy"] = overrides.httpProxy;
  }
  if (overrides?.httpsProxy) {
    merged["HTTPS_PROXY"] = overrides.httpsProxy;
    merged["https_proxy"] = overrides.httpsProxy;
  }
  if (overrides?.allProxy) {
    merged["ALL_PROXY"] = overrides.allProxy;
    merged["all_proxy"] = overrides.allProxy;
  }
  if (overrides?.noProxy) {
    merged["NO_PROXY"] = overrides.noProxy;
    merged["no_proxy"] = overrides.noProxy;
  }

  const envArgs: string[] = [];
  let needsHostGateway = false;

  for (const name of PROXY_ENV_NAMES) {
    const raw = merged[name]?.trim();
    if (!raw) continue;
    const rewritten =
      !skipLoopbackRewrite && name.toLowerCase().endsWith("_proxy")
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
  proxyOverrides?: ProxyOverrides; // explicit proxy settings from plugin config
  // Share host network namespace so 127.0.0.1 proxy is reachable directly.
  // Linux only; resolves stream-disconnect issues caused by Docker bridge NAT.
  useHostNetwork?: boolean;
}): Promise<DockerSandboxHandle> {
  const codexAuthDir = params.codexAuthDir?.trim() || path.join(homedir(), ".codex");
  const id = randomBytes(8).toString("hex");
  const containerName = `ai-programmer-sandbox-${id}`;
  const wrapperScriptPath = path.join(tmpdir(), `ai-programmer-wrapper-${id}.sh`);
  const { envArgs, needsHostGateway } = buildDockerProxyEnvArgs(
    params.proxyOverrides,
    params.useHostNetwork,
  );

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
    // --network=host lets the container reach 127.0.0.1 directly (same as host),
    // avoiding Docker bridge NAT which can drop long-lived proxy streams.
    // Mutually exclusive with --add-host, so only one branch runs.
    ...(params.useHostNetwork
      ? ["--network", "host"]
      : needsHostGateway
        ? ["--add-host", "host.docker.internal:host-gateway"]
        : []),
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
