import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requestHostExecPrivilegeMock = vi.hoisted(() => vi.fn());

vi.mock("./privilege-broker.js", () => ({
  requestHostExecPrivilege: (params: unknown) => requestHostExecPrivilegeMock(params),
}));

let createExecTool: typeof import("./bash-tools.exec.js").createExecTool;

describe("exec privileged host rm", () => {
  beforeEach(async () => {
    ({ createExecTool } = await import("./bash-tools.exec.js"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a privileged host_exec request instead of executing rm", async () => {
    requestHostExecPrivilegeMock.mockResolvedValue({
      status: "requested",
      requestId: "priv-rm-1",
      expiresAtMs: Date.now() + 60_000,
    });

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-rm-priv-"));
    try {
      const doomed = path.join(root, "doomed");
      await fs.mkdir(doomed, { recursive: true });

      const tool = createExecTool({
        host: "gateway",
        security: "full",
        ask: "off",
        cwd: root,
        sessionKey: "agent:main:feishu:direct:ou_123",
        messageProvider: "feishu",
        accountId: "default",
        senderId: "ou_123",
      });

      const result = await tool.execute("call-rm", { command: "rm -rf ./doomed" });

      expect(result.details).toMatchObject({
        status: "privileged-pending",
        requestId: "priv-rm-1",
        kind: "host_exec",
        host: "gateway",
        command: "rm -rf ./doomed",
        cwd: root,
      });
      await expect(fs.stat(doomed)).resolves.toBeTruthy();
      expect(requestHostExecPrivilegeMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:main:feishu:direct:ou_123",
          channel: "feishu",
          accountId: "default",
          senderId: "ou_123",
          request: expect.objectContaining({
            command: "rm -rf ./doomed",
            cwd: root,
            host: "gateway",
          }),
        }),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
