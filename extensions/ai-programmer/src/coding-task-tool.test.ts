import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock, summarizeCodingTaskMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  summarizeCodingTaskMock: vi.fn(),
}));
const { startDockerSandboxMock, stopDockerSandboxMock } = vi.hoisted(() => ({
  startDockerSandboxMock: vi.fn(),
  stopDockerSandboxMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

vi.mock("./summarizer.js", () => ({
  fallbackResult: (durationMs: number, errorDetails?: string) => ({
    status: "failed",
    summary: "(summary unavailable)",
    filesChanged: [],
    filesCreated: [],
    filesDeleted: [],
    testOutcome: "unknown",
    ...(errorDetails ? { errorDetails } : {}),
    durationMs,
  }),
  summarizeCodingTask: summarizeCodingTaskMock,
}));

vi.mock("./docker-sandbox.js", () => ({
  startDockerSandbox: startDockerSandboxMock,
  stopDockerSandbox: stopDockerSandboxMock,
}));

import { createCodingTaskTool } from "./coding-task-tool.js";

function mockSuccessfulSpawn() {
  spawnMock.mockImplementation(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      stdin: { end: (input?: string) => void };
      kill: () => void;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn();
    child.stdin = {
      end: () => {
        child.stdout.write('{"type":"agent_message","delta":"done"}\n');
        child.stdout.end();
        setImmediate(() => child.emit("close", 0, null));
      },
    };
    return child;
  });
}

describe("createCodingTaskTool", () => {
  let workspaceDir: string;
  const dedicatedWorkspace = path.join(os.homedir(), ".openclaw", "workspace", "ai-programmer");

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-programmer-tool-test-"));
    await fs.rm(dedicatedWorkspace, { recursive: true, force: true });
    summarizeCodingTaskMock.mockResolvedValue({
      status: "completed",
      summary: "Updated files successfully.",
      filesChanged: ["src/example.ts"],
      filesCreated: [],
      filesDeleted: [],
      testOutcome: "unknown",
      durationMs: 0,
    });
    startDockerSandboxMock.mockResolvedValue({
      containerName: "ai-programmer-sandbox-test",
      wrapperScriptPath: "/tmp/ai-programmer-wrapper-test.sh",
      configTomlPath: "/tmp/ai-programmer-config-test.toml",
    });
    stopDockerSandboxMock.mockResolvedValue(undefined);
    mockSuccessfulSpawn();
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await fs.rm(workspaceDir, { recursive: true, force: true });
    await fs.rm(dedicatedWorkspace, { recursive: true, force: true });
  });

  it("defaults to a dedicated docker sandbox workspace and ignores caller workspace overrides", async () => {
    const tool = createCodingTaskTool(
      {
        pluginConfig: {
          summarizerProvider: "openai",
          summarizerModel: "gpt-5",
        },
        config: {},
      },
      { workspaceDir },
    );

    const result = await tool.execute("call-1", {
      task: "touch src/example.ts",
      workspaceDir,
    });
    const actualWorkspaceDir = String(
      (result.details as { workspaceDir?: string }).workspaceDir ?? "",
    );

    expect(startDockerSandboxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        image: "ai-programmer-sandbox:latest",
        workspaceDir: actualWorkspaceDir,
        sandboxCommand: "codex",
      }),
    );
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith(
      "/tmp/ai-programmer-wrapper-test.sh",
      expect.arrayContaining([
        "--dangerously-bypass-approvals-and-sandbox",
        "exec",
        "-C",
        actualWorkspaceDir,
      ]),
      expect.objectContaining({ cwd: actualWorkspaceDir }),
    );
    expect(stopDockerSandboxMock).toHaveBeenCalledTimes(1);
    expect(path.dirname(actualWorkspaceDir)).toBe(dedicatedWorkspace);
    expect(result.details).toEqual(
      expect.objectContaining({
        executor: "codex-cli",
        codexCommand: "codex",
        workspaceDir: actualWorkspaceDir,
      }),
    );

    const runRecord = JSON.parse(
      await fs.readFile(
        path.join(actualWorkspaceDir, ".openclaw", "ai-programmer", "last-run.json"),
        "utf8",
      ),
    ) as { status: string; executor: string; workspaceDir: string };
    expect(runRecord).toEqual(
      expect.objectContaining({
        status: "completed",
        executor: "codex-cli",
        workspaceDir: actualWorkspaceDir,
      }),
    );
    await expect(
      fs.readFile(path.join(actualWorkspaceDir, "AGENTS.md"), "utf8"),
    ).resolves.toContain("Read `memory/current.md` before making changes.");
    await expect(
      fs.readFile(path.join(actualWorkspaceDir, "memory", "current.md"), "utf8"),
    ).resolves.toContain("Project initialized.");
    await expect(
      fs.readFile(
        path.join(actualWorkspaceDir, ".openclaw", "ai-programmer", "last-run-output.txt"),
        "utf8",
      ),
    ).resolves.toContain('"type":"agent_message"');
  });

  it("uses the configured plugin workspace root and an explicit project name when provided", async () => {
    const configuredWorkspace = await fs.mkdtemp(
      path.join(os.tmpdir(), "ai-programmer-config-workspace-"),
    );
    try {
      const tool = createCodingTaskTool(
        {
          pluginConfig: {
            workspaceDir: configuredWorkspace,
            sandbox: { enabled: false },
            summarizerProvider: "openai",
            summarizerModel: "gpt-5",
          },
          config: {},
        },
        {},
      );

      const result = await tool.execute("call-2", { task: "list files", projectName: "demo-app" });
      const actualWorkspaceDir = String(
        (result.details as { workspaceDir?: string }).workspaceDir ?? "",
      );

      expect(spawnMock).toHaveBeenCalledWith(
        "codex",
        expect.arrayContaining([
          "-a",
          "never",
          "exec",
          "-C",
          path.join(configuredWorkspace, "demo-app"),
        ]),
        expect.objectContaining({ cwd: path.join(configuredWorkspace, "demo-app") }),
      );
      expect(startDockerSandboxMock).not.toHaveBeenCalled();
      expect(result.details).toEqual(
        expect.objectContaining({
          workspaceDir: path.join(configuredWorkspace, "demo-app"),
        }),
      );
      expect(actualWorkspaceDir).toBe(path.join(configuredWorkspace, "demo-app"));
      await expect(
        fs.readFile(path.join(actualWorkspaceDir, "AGENTS.md"), "utf8"),
      ).resolves.toContain("# demo-app");
    } finally {
      await fs.rm(configuredWorkspace, { recursive: true, force: true });
    }
  });

  it("allows explicit task workspace overrides only when enabled in plugin config", async () => {
    const requestedWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "ai-programmer-requested-"));
    try {
      const tool = createCodingTaskTool(
        {
          pluginConfig: {
            allowTaskWorkspaceOverride: true,
            sandbox: { enabled: false },
            summarizerProvider: "openai",
            summarizerModel: "gpt-5",
          },
          config: {},
        },
        {},
      );

      const result = await tool.execute("call-4", {
        task: "create a file",
        workspaceDir: requestedWorkspace,
        projectName: "shared-project",
      });

      expect(spawnMock).toHaveBeenCalledWith(
        "codex",
        expect.arrayContaining(["-C", path.join(requestedWorkspace, "shared-project")]),
        expect.objectContaining({ cwd: path.join(requestedWorkspace, "shared-project") }),
      );
      expect(result.details).toEqual(
        expect.objectContaining({
          workspaceDir: path.join(requestedWorkspace, "shared-project"),
        }),
      );
    } finally {
      await fs.rm(requestedWorkspace, { recursive: true, force: true });
    }
  });

  it("annotates ai-programmer changes with a deployment hint", async () => {
    summarizeCodingTaskMock.mockResolvedValueOnce({
      status: "completed",
      summary: "Updated ai-programmer deployment flow.",
      filesChanged: ["extensions/ai-programmer/Dockerfile.sandbox"],
      filesCreated: [],
      filesDeleted: [],
      testOutcome: "passed",
      durationMs: 0,
    });

    const tool = createCodingTaskTool(
      {
        pluginConfig: {
          summarizerProvider: "openai",
          summarizerModel: "gpt-5",
        },
        config: {},
      },
      {},
    );

    const result = await tool.execute("call-5", { task: "update ai-programmer deploy flow" });

    expect(result.details).toEqual(
      expect.objectContaining({
        result: expect.objectContaining({
          needsDeployment: true,
          deploymentScript: "scripts/deploy-ai-programmer.sh",
          deploymentCommandId: "openclaw.deploy.ai-programmer",
        }),
      }),
    );
    expect(String(result.content?.[0]?.text ?? "")).toContain("needsDeployment");
  });

  it("writes the full startup error when sandbox launch fails", async () => {
    startDockerSandboxMock.mockRejectedValueOnce(
      new Error("docker run failed: daemon said the bind source path does not exist"),
    );

    const tool = createCodingTaskTool(
      {
        pluginConfig: {
          summarizerProvider: "openai",
          summarizerModel: "gpt-5",
        },
        config: {},
      },
      {},
    );

    const result = await tool.execute("call-3", { task: "create a file" });
    const text = String(result.content?.[0]?.text ?? "");
    const actualWorkspaceDir = String(
      (result.details as { workspaceDir?: string }).workspaceDir ?? "",
    );

    expect(text).toContain("daemon said the bind source path does not exist");
    await expect(
      fs.readFile(
        path.join(actualWorkspaceDir, ".openclaw", "ai-programmer", "last-run-error.txt"),
        "utf8",
      ),
    ).resolves.toContain("daemon said the bind source path does not exist");
  });
});
