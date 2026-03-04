import { beforeEach, describe, expect, it, vi } from "vitest";

const { callGatewayMock } = vi.hoisted(() => ({
  callGatewayMock: vi.fn(async () => ({
    id: "priv-req-1",
    status: "accepted",
    expiresAtMs: 1_700_000_000_000,
  })),
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: callGatewayMock,
}));

import "./test-helpers/fast-core-tools.js";
import { createOpenClawTools } from "./openclaw-tools.js";

describe("request_privilege tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function requireRequestPrivilegeTool() {
    const tool = createOpenClawTools({
      sandboxed: true,
      agentSessionKey: "agent:main:feishu:direct:ou_requester",
      agentChannel: "feishu",
      agentAccountId: "default",
      requesterSenderId: "ou_requester",
      config: {} as never,
    }).find((candidate) => candidate.name === "request_privilege");
    expect(tool).toBeDefined();
    if (!tool) {
      throw new Error("missing request_privilege tool");
    }
    return tool;
  }

  it("creates a feishu fs_grant request with requester context for read-only path access", async () => {
    const tool = requireRequestPrivilegeTool();

    const result = await tool.execute("call1", {
      kind: "fs_grant",
      justification: "Request read-only access to /home/lawliet/src/openclaw/skills/coding-agent/",
      path: "/home/lawliet/src/openclaw/skills/coding-agent/",
      access: "ro",
    });

    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "privileged.request",
        params: {
          kind: "fs_grant",
          justification:
            "Request read-only access to /home/lawliet/src/openclaw/skills/coding-agent/",
          payload: {
            path: "/home/lawliet/src/openclaw/skills/coding-agent/",
            access: "ro",
          },
          requestedBy: {
            channel: "feishu",
            accountId: "default",
            senderId: "ou_requester",
            sessionKey: "agent:main:feishu:direct:ou_requester",
            agentId: "main",
          },
        },
      }),
    );
    expect(result.content).toEqual([
      {
        type: "text",
        text: "Created privileged request priv-req-1 (accepted). Await owner approval.",
      },
    ]);
  });

  it("creates a host_exec request with the raw command payload", async () => {
    const tool = requireRequestPrivilegeTool();

    await tool.execute("call2", {
      kind: "host_exec",
      justification: "Create a marker file outside the workspace",
      command: "touch /home/lawliet/ai/foo",
      cwd: "/home/lawliet",
    });

    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "privileged.request",
        params: expect.objectContaining({
          kind: "host_exec",
          justification: "Create a marker file outside the workspace",
          payload: {
            command: "touch /home/lawliet/ai/foo",
            cwd: "/home/lawliet",
          },
          requestedBy: {
            channel: "feishu",
            accountId: "default",
            senderId: "ou_requester",
            sessionKey: "agent:main:feishu:direct:ou_requester",
            agentId: "main",
          },
        }),
      }),
    );
  });
});
