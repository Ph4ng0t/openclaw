import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  hasPendingHeartbeatWake,
  resetHeartbeatWakeStateForTests,
} from "../infra/heartbeat-wake.js";
import { peekSystemEvents, resetSystemEventsForTest } from "../infra/system-events.js";

const {
  execFileMock,
  readConfigFileSnapshotMock,
  writeConfigFileMock,
  refreshSandboxForFsGrantMock,
} = vi.hoisted(() => {
  const mock = vi.fn();
  mock[Symbol.for("nodejs.util.promisify.custom")] = (
    file: string,
    args: string[],
    options: Record<string, unknown>,
  ) =>
    new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      mock(file, args, options, (error: Error | null, stdout: string, stderr: string) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      });
    });

  return {
    execFileMock: mock,
    readConfigFileSnapshotMock: vi.fn(),
    writeConfigFileMock: vi.fn(),
    refreshSandboxForFsGrantMock: vi.fn(),
  };
});

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: readConfigFileSnapshotMock,
  writeConfigFile: writeConfigFileMock,
}));

vi.mock("./sandbox-refresh.js", () => ({
  refreshSandboxForFsGrant: refreshSandboxForFsGrantMock,
}));

import { applyPrivilegedRequest } from "./apply.js";

describe("applyPrivilegedRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refreshSandboxForFsGrantMock.mockResolvedValue(null);
    resetSystemEventsForTest();
    resetHeartbeatWakeStateForTests();
  });

  it("refreshes the sandbox after fs grants are applied", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({ config: { tools: { fs: { grants: [] } } } });
    writeConfigFileMock.mockResolvedValue(undefined);
    refreshSandboxForFsGrantMock.mockResolvedValue("Refreshed sandbox openclaw-sbx-a.");

    await expect(
      applyPrivilegedRequest({
        id: "req-fs",
        kind: "fs_grant",
        status: "approved",
        justification: "Grant access",
        createdAtMs: 1,
        expiresAtMs: 2,
        requestedBy: {
          sessionKey: "agent:main:feishu:direct:ou_1",
          agentId: "main",
        },
        payload: {
          path: "/home/lawliet/ai",
          access: "rw",
        },
        singleUse: true,
      }),
    ).resolves.toBe(
      "Granted rw access to /home/lawliet/ai Refreshed sandbox openclaw-sbx-a. Queued an automatic retry for the waiting agent.",
    );

    expect(refreshSandboxForFsGrantMock).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedBy: expect.objectContaining({
          sessionKey: "agent:main:feishu:direct:ou_1",
        }),
      }),
    );
    expect(peekSystemEvents("agent:main:feishu:direct:ou_1")).toEqual([
      "Filesystem permission approved for /home/lawliet/ai (read/write). The sandbox was refreshed automatically. Immediately retry the blocked file operation that needed this path.",
    ]);
    expect(hasPendingHeartbeatWake()).toBe(true);
  });

  it("executes raw gateway host_exec commands through the local shell", async () => {
    execFileMock.mockImplementation(
      (
        file: string,
        args: string[],
        options: Record<string, unknown>,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        expect(file).toBe("/bin/sh");
        expect(args).toEqual(["-lc", "touch /home/lawliet/ai/foo"]);
        expect(options.cwd).toBe("/home/lawliet");
        callback(null, "", "");
      },
    );

    await expect(
      applyPrivilegedRequest({
        id: "req-host",
        kind: "host_exec",
        status: "approved",
        justification: "Allow host exec",
        createdAtMs: 1,
        expiresAtMs: 2,
        requestedBy: {
          sessionKey: "agent:main:feishu:direct:ou_1",
          agentId: "main",
        },
        payload: {
          command: "touch /home/lawliet/ai/foo",
          cwd: "/home/lawliet",
          host: "gateway",
        },
        singleUse: true,
      }),
    ).resolves.toBe("Host command completed.");
    expect(peekSystemEvents("agent:main:feishu:direct:ou_1")).toEqual([
      "Exec finished (gateway privileged, code 0)\nCommand: touch /home/lawliet/ai/foo\nCwd: /home/lawliet\nHost command completed.",
    ]);
    expect(hasPendingHeartbeatWake()).toBe(true);
  });

  it("rejects raw node host_exec commands", async () => {
    await expect(
      applyPrivilegedRequest({
        id: "req-node",
        kind: "host_exec",
        status: "approved",
        justification: "Allow node host exec",
        createdAtMs: 1,
        expiresAtMs: 2,
        payload: {
          command: "touch /tmp/node-marker",
          host: "node",
          nodeId: "node-1",
        },
        singleUse: true,
      }),
    ).rejects.toThrow("host_exec for node:node-1 is not supported by privileged approvals");
  });

  it("keeps supporting registered command ids", async () => {
    execFileMock.mockImplementation(
      (
        file: string,
        args: string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        expect(file).toBe("git");
        expect(args).toEqual(["status", "--short"]);
        callback(null, "M src/file.ts\n", "");
      },
    );

    await expect(
      applyPrivilegedRequest({
        id: "req-legacy",
        kind: "host_exec",
        status: "approved",
        justification: "Run git status",
        createdAtMs: 1,
        expiresAtMs: 2,
        payload: {
          commandId: "git.status",
        },
        singleUse: true,
      }),
    ).resolves.toBe("M src/file.ts");
  });
});
