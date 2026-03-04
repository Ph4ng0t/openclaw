import { describe, expect, it, vi, beforeEach } from "vitest";

const requestMinimumFsPrivilegeMock = vi.hoisted(() => vi.fn());
const requestHostExecPrivilegeMock = vi.hoisted(() => vi.fn());

vi.mock("./privilege-broker.js", () => ({
  requestMinimumFsPrivilege: (params: unknown) => requestMinimumFsPrivilegeMock(params),
  requestHostExecPrivilege: (params: unknown) => requestHostExecPrivilegeMock(params),
}));

import { createSubscribedSessionHarness } from "./pi-embedded-subscribe.e2e-harness.js";

describe("subscribeEmbeddedPiSession host exec approvals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stores an await-approval error after denied host exec", async () => {
    requestHostExecPrivilegeMock.mockResolvedValue({
      status: "requested",
      requestId: "req-host-e2e",
      expiresAtMs: Date.now() + 1_800_000,
    });

    const harness = createSubscribedSessionHarness({
      runId: "run-host-exec",
      sessionKey: "agent:main:feishu:direct:ou_123",
    });

    harness.emit({
      type: "tool_execution_start",
      toolName: "exec",
      toolCallId: "tool-host-exec",
      args: {
        command: "ls /home",
        elevated: true,
        workdir: "/workspace",
      },
    });
    harness.emit({
      type: "tool_execution_end",
      toolName: "exec",
      toolCallId: "tool-host-exec",
      isError: true,
      result: {
        details: {
          status: "error",
          tool: "exec",
          error: "exec denied: host=gateway security=deny",
        },
      },
    });

    await Promise.resolve();

    expect(requestHostExecPrivilegeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:feishu:direct:ou_123",
        request: expect.objectContaining({
          command: "ls /home",
          cwd: "/workspace",
          host: "gateway",
        }),
      }),
    );
    expect(harness.subscription.getLastToolError()).toMatchObject({
      toolName: "exec",
      error: expect.stringContaining("Await owner approval"),
    });
    expect(harness.subscription.getLastToolError()?.error).toContain("req-host-e2e");
  });
});
