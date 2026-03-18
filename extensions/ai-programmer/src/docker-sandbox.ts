import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DOCKER_BIN = "docker";

export type FsGrant = { path: string; access: "ro" | "rw" };

export type DockerSandboxHandle = {
  containerName: string;
  wrapperScriptPath: string;
};

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

  const mountArgs: string[] = [
    // workspace at same path (rw)
    "-v",
    `${params.workspaceDir}:${params.workspaceDir}`,
    // codex auth (ro)
    "-v",
    `${codexAuthDir}:/root/.codex:ro`,
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
