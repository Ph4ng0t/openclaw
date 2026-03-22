import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
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
  configTomlPath?: string;
};

function normalizeMountSource(value: string): string {
  return path.resolve(value.trim());
}

function formatExecFileError(err: unknown): string {
  if (!(err instanceof Error)) {
    return String(err ?? "unknown error");
  }
  const extras: string[] = [];
  const candidate = err as Error & { stdout?: string; stderr?: string; code?: number | string };
  if (candidate.code != null) {
    extras.push(`code=${String(candidate.code)}`);
  }
  const stderr = candidate.stderr?.trim();
  const stdout = candidate.stdout?.trim();
  if (stderr) {
    extras.push(`stderr=${stderr}`);
  } else if (stdout) {
    extras.push(`stdout=${stdout}`);
  }
  return extras.length > 0 ? `${err.message} | ${extras.join(" | ")}` : err.message;
}

function usesLoopbackProxy(raw: string | undefined): boolean {
  const value = raw?.trim();
  if (!value) {
    return false;
  }
  try {
    const url = new URL(value);
    const host = url.hostname.trim().toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

export function shouldUseHostNetworkByDefault(params: {
  useHostNetwork?: boolean;
  proxyOverrides?: ProxyOverrides;
}): boolean {
  if (typeof params.useHostNetwork === "boolean") {
    return params.useHostNetwork;
  }
  if (process.platform !== "linux") {
    return false;
  }
  const candidates = [
    params.proxyOverrides?.httpProxy,
    params.proxyOverrides?.httpsProxy,
    params.proxyOverrides?.allProxy,
    process.env.HTTP_PROXY,
    process.env.HTTPS_PROXY,
    process.env.ALL_PROXY,
    process.env.http_proxy,
    process.env.https_proxy,
    process.env.all_proxy,
  ];
  return candidates.some((value) => usesLoopbackProxy(value));
}

async function verifySandboxCommand(containerName: string, command: string): Promise<void> {
  try {
    await execFileAsync(DOCKER_BIN, [
      "exec",
      containerName,
      "sh",
      "-lc",
      'command -v "$1" >/dev/null 2>&1 || [ -x "$1" ]',
      "sh",
      command,
    ]);
  } catch {
    throw new Error(
      `Sandbox command "${command}" is not available in the container. Install codex in the image, or set ai-programmer sandbox.command to the executable path inside the container.`,
    );
  }
}

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
  sandboxCommand?: string; // default: "codex"
  proxyOverrides?: ProxyOverrides; // explicit proxy settings from plugin config
  // Share host network namespace so 127.0.0.1 proxy is reachable directly.
  // Linux only; resolves stream-disconnect issues caused by Docker bridge NAT.
  useHostNetwork?: boolean;
}): Promise<DockerSandboxHandle> {
  const codexAuthDir = params.codexAuthDir?.trim() || path.join(homedir(), ".codex");
  const sandboxCommand = params.sandboxCommand?.trim() || "codex";
  const useHostNetwork = shouldUseHostNetworkByDefault({
    useHostNetwork: params.useHostNetwork,
    proxyOverrides: params.proxyOverrides,
  });
  const id = randomBytes(8).toString("hex");
  const containerName = `ai-programmer-sandbox-${id}`;
  const wrapperScriptPath = path.join(tmpdir(), `ai-programmer-wrapper-${id}.sh`);
  const configTomlPath = path.join(tmpdir(), `ai-programmer-config-${id}.toml`);
  const { envArgs, needsHostGateway } = buildDockerProxyEnvArgs(
    params.proxyOverrides,
    useHostNetwork,
  );

  const mountArgs: string[] = [
    // workspace at same path (rw)
    "-v",
    `${params.workspaceDir}:${params.workspaceDir}`,
  ];
  const mountedSources = new Set<string>([normalizeMountSource(params.workspaceDir)]);

  // Mount the full Codex state directory so the sandbox sees the same auth +
  // sqlite/session state as the host CLI. Mounting only auth.json proved
  // insufficient for some backends, which then surfaced as "cannot connect to
  // Codex backend" even though login looked present. We still overlay a
  // generated config.toml below so container-specific transport tuning applies
  // and incompatible host config fields do not leak into the image runtime.
  if (existsSync(codexAuthDir)) {
    mountArgs.push("-v", `${codexAuthDir}:/root/.codex`);
    mountedSources.add(normalizeMountSource(codexAuthDir));
  }

  // Write a sandbox-specific config.toml with a generous stream idle timeout.
  // The host config.toml is intentionally NOT mounted to avoid inheriting invalid
  // fields. stream_idle_timeout_ms is a per-provider field under [model_providers.<name>];
  // "chatgpt" matches the built-in ChatGPT OAuth provider's internal name (verified via
  // binary auth method IDs). stream_max_retries auto-retries on mid-stream disconnects.
  const configToml = [
    "# sandbox config — generated by ai-programmer",
    "[model_providers.chatgpt]",
    'name = "chatgpt"',
    "stream_idle_timeout_ms = 600000",
    "stream_max_retries = 5",
    "",
  ].join("\n");
  writeFileSync(configTomlPath, configToml, { mode: 0o600 });
  mountArgs.push("-v", `${configTomlPath}:/root/.codex/config.toml:ro`);

  // fsGrant mounts at same host paths (matching the Feishu sandbox container)
  for (const grant of params.fsGrants ?? []) {
    const p = grant.path.trim();
    if (!p) continue;
    const normalized = normalizeMountSource(p);
    if (mountedSources.has(normalized)) {
      continue;
    }
    const suffix = grant.access === "rw" ? "" : ":ro";
    mountArgs.push("-v", `${p}:${p}${suffix}`);
    mountedSources.add(normalized);
  }

  try {
    await execFileAsync(DOCKER_BIN, [
      "run",
      "--name",
      containerName,
      "--rm",
      "-d",
      // --network=host lets the container reach 127.0.0.1 directly (same as host),
      // avoiding Docker bridge NAT which can drop long-lived proxy streams.
      // Mutually exclusive with --add-host, so only one branch runs.
      ...(useHostNetwork
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
  } catch (err) {
    throw new Error(`docker run failed: ${formatExecFileError(err)}`);
  }

  try {
    await verifySandboxCommand(containerName, sandboxCommand);
  } catch (err) {
    await stopDockerSandbox({ containerName, wrapperScriptPath, configTomlPath }).catch(() => {});
    throw err;
  }

  const script = `#!/bin/sh\nexec ${DOCKER_BIN} exec -i ${containerName} "${sandboxCommand}" "$@"\n`;
  try {
    writeFileSync(wrapperScriptPath, script, { mode: 0o700 });
  } catch (err) {
    await stopDockerSandbox({ containerName, wrapperScriptPath, configTomlPath }).catch(() => {});
    throw err;
  }
  return { containerName, wrapperScriptPath, configTomlPath };
}

export async function stopDockerSandbox(handle: DockerSandboxHandle): Promise<void> {
  try {
    unlinkSync(handle.wrapperScriptPath);
  } catch {
    /* already gone */
  }
  if (handle.configTomlPath) {
    try {
      unlinkSync(handle.configTomlPath);
    } catch {
      /* already gone */
    }
  }
  try {
    await execFileAsync(DOCKER_BIN, ["stop", handle.containerName]);
  } catch {
    await execFileAsync(DOCKER_BIN, ["rm", "-f", handle.containerName]).catch(() => {});
  }
}
