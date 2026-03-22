import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

import {
  shouldUseHostNetworkByDefault,
  startDockerSandbox,
  stopDockerSandbox,
} from "./docker-sandbox.js";

function createExecFileSuccessMock() {
  execFileMock.mockImplementation(
    (
      _file: string,
      _args: string[],
      callback?: (error: Error | null, stdout?: string, stderr?: string) => void,
    ) => {
      callback?.(null, "", "");
      return {} as never;
    },
  );
}

describe("startDockerSandbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createExecFileSuccessMock();
  });

  it("mounts the full codex auth directory and overlays sandbox config", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-programmer-sandbox-test-"));
    const workspaceDir = path.join(root, "workspace");
    const codexAuthDir = path.join(root, ".codex");
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(codexAuthDir, { recursive: true });
    fs.writeFileSync(path.join(codexAuthDir, "auth.json"), "{}");
    fs.writeFileSync(path.join(codexAuthDir, "state_5.sqlite"), "");

    const handle = await startDockerSandbox({
      image: "ai-programmer-sandbox:latest",
      workspaceDir,
      codexAuthDir,
    });

    const dockerRunCall = execFileMock.mock.calls.find(
      ([file, args]) => file === "docker" && Array.isArray(args) && args[0] === "run",
    );
    expect(dockerRunCall).toBeDefined();
    const dockerArgs = dockerRunCall?.[1] as string[];
    expect(dockerArgs).toContain(`${codexAuthDir}:/root/.codex`);
    expect(dockerArgs).toContain(`${workspaceDir}:${workspaceDir}`);
    expect(dockerArgs.some((arg) => arg.endsWith(":/root/.codex/config.toml:ro"))).toBeTruthy();

    await stopDockerSandbox(handle);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("does not duplicate the workspace mount when fs grants include the same path", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-programmer-sandbox-test-"));
    const workspaceDir = path.join(root, "workspace");
    fs.mkdirSync(workspaceDir, { recursive: true });

    const handle = await startDockerSandbox({
      image: "ai-programmer-sandbox:latest",
      workspaceDir,
      fsGrants: [{ path: workspaceDir, access: "rw" }],
    });

    const dockerRunCall = execFileMock.mock.calls.find(
      ([file, args]) => file === "docker" && Array.isArray(args) && args[0] === "run",
    );
    expect(dockerRunCall).toBeDefined();
    const dockerArgs = dockerRunCall?.[1] as string[];
    const workspaceMounts = dockerArgs.filter((arg) => arg === `${workspaceDir}:${workspaceDir}`);
    expect(workspaceMounts).toHaveLength(1);

    await stopDockerSandbox(handle);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("surfaces docker run stderr when container startup fails", async () => {
    execFileMock.mockImplementationOnce(
      (
        _file: string,
        _args: string[],
        callback?: (error: Error | null, stdout?: string, stderr?: string) => void,
      ) => {
        const error = Object.assign(new Error("Command failed: docker run ..."), {
          code: 125,
          stderr: 'docker: invalid mount config for type "bind"',
        });
        callback?.(error, "", 'docker: invalid mount config for type "bind"');
        return {} as never;
      },
    );

    await expect(
      startDockerSandbox({
        image: "ai-programmer-sandbox:latest",
        workspaceDir: "/tmp/workspace",
      }),
    ).rejects.toThrow(/docker run failed: .*invalid mount config/);
  });
});

describe("shouldUseHostNetworkByDefault", () => {
  it("defaults to host network on Linux when a loopback proxy is configured", () => {
    const originalPlatform = process.platform;
    const originalHttpProxy = process.env.HTTP_PROXY;
    Object.defineProperty(process, "platform", { value: "linux" });
    process.env.HTTP_PROXY = "http://127.0.0.1:10809";

    expect(shouldUseHostNetworkByDefault({})).toBe(true);

    process.env.HTTP_PROXY = originalHttpProxy;
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  it("respects an explicit useHostNetwork=false override", () => {
    expect(
      shouldUseHostNetworkByDefault({
        useHostNetwork: false,
        proxyOverrides: { httpProxy: "http://127.0.0.1:10809" },
      }),
    ).toBe(false);
  });
});
