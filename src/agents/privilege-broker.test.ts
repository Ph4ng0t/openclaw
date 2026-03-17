import { beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayMock = vi.hoisted(() => vi.fn());

vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

import { requestHostExecPrivilege, requestMinimumFsPrivilege } from "./privilege-broker.js";

describe("requestMinimumFsPrivilege", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a temporary fs_grant request for denied fs access", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-04T10:00:00.000Z"));
    try {
      callGatewayMock
        .mockResolvedValueOnce({ requests: [] })
        .mockResolvedValueOnce({ id: "req-1", expiresAtMs: Date.now() + 1_800_000 });

      const result = await requestMinimumFsPrivilege({
        cfg: {},
        sessionKey: "agent:main:feishu:direct:ou_123",
        agentId: "main",
        channel: "feishu",
        accountId: "default",
        senderId: "ou_123",
        error: {
          kind: "fs_access_denied",
          path: "/tmp/private.txt",
          requestedAccess: "read",
          suggestedGrant: {
            path: "/tmp/private.txt",
            access: "ro",
            expiresInMs: 1_800_000,
            reason: "Temporary read access required outside workspace",
          },
        },
      });

      expect(result).toEqual({
        status: "requested",
        requestId: "req-1",
        expiresAtMs: Date.now() + 1_800_000,
      });
      expect(callGatewayMock).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          method: "privileged.request",
          params: expect.objectContaining({
            kind: "fs_grant",
            payload: expect.objectContaining({
              path: "/tmp/private.txt",
              access: "ro",
            }),
            requestedBy: expect.objectContaining({
              channel: "feishu",
              accountId: "default",
              senderId: "ou_123",
              sessionKey: "agent:main:feishu:direct:ou_123",
              agentId: "main",
            }),
          }),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("reuses an existing pending matching request", async () => {
    callGatewayMock.mockResolvedValueOnce({
      requests: [
        {
          id: "req-existing",
          kind: "fs_grant",
          status: "pending",
          payload: { path: "/tmp/private.txt", access: "ro" },
          requestedBy: { sessionKey: "agent:main:feishu:direct:ou_123", agentId: "main" },
        },
      ],
    });

    const result = await requestMinimumFsPrivilege({
      cfg: {},
      sessionKey: "agent:main:feishu:direct:ou_123",
      agentId: "main",
      error: {
        kind: "fs_access_denied",
        suggestedGrant: {
          path: "/tmp/private.txt",
          access: "ro",
          expiresInMs: 1_800_000,
          reason: "Temporary read access required outside workspace",
        },
      },
    });

    expect(result).toEqual({ status: "duplicate", requestId: "req-existing" });
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
  });

  it("does not re-request when grant already exists in config (exact path)", async () => {
    callGatewayMock.mockResolvedValueOnce({ requests: [] });

    const result = await requestMinimumFsPrivilege({
      cfg: {
        tools: {
          fs: {
            grants: [{ path: "/tmp/private.txt", access: "ro", expiresAt: Date.now() + 1_800_000 }],
          },
        },
      },
      sessionKey: "agent:main:feishu:direct:ou_123",
      agentId: "main",
      error: {
        kind: "fs_access_denied",
        suggestedGrant: {
          path: "/tmp/private.txt",
          access: "ro",
          expiresInMs: 1_800_000,
        },
      },
    });

    expect(result).toEqual({ status: "not-requested", reason: "Grant already exists in config." });
    // privileged.request must NOT be called
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
  });

  it("does not re-request when a parent directory grant covers the requested path", async () => {
    callGatewayMock.mockResolvedValueOnce({ requests: [] });

    const result = await requestMinimumFsPrivilege({
      cfg: {
        tools: {
          fs: {
            grants: [{ path: "/tmp", access: "ro", expiresAt: Date.now() + 1_800_000 }],
          },
        },
      },
      sessionKey: "agent:main:feishu:direct:ou_123",
      agentId: "main",
      error: {
        kind: "fs_access_denied",
        suggestedGrant: {
          path: "/tmp/private.txt",
          access: "ro",
          expiresInMs: 1_800_000,
        },
      },
    });

    expect(result).toEqual({ status: "not-requested", reason: "Grant already exists in config." });
    expect(callGatewayMock).toHaveBeenCalledTimes(1);
  });

  it("re-requests when the only matching grant is expired", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-04T10:00:00.000Z"));
    try {
      callGatewayMock
        .mockResolvedValueOnce({ requests: [] })
        .mockResolvedValueOnce({ id: "req-new", expiresAtMs: Date.now() + 1_800_000 });

      const result = await requestMinimumFsPrivilege({
        cfg: {
          tools: {
            fs: {
              grants: [
                // Expired
                { path: "/tmp/private.txt", access: "ro", expiresAt: Date.now() - 1 },
              ],
            },
          },
        },
        sessionKey: "agent:main:feishu:direct:ou_123",
        agentId: "main",
        error: {
          kind: "fs_access_denied",
          suggestedGrant: {
            path: "/tmp/private.txt",
            access: "ro",
            expiresInMs: 1_800_000,
          },
        },
      });

      expect(result.status).toBe("requested");
      expect(callGatewayMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-requests when config has ro grant but rw is needed", async () => {
    callGatewayMock
      .mockResolvedValueOnce({ requests: [] })
      .mockResolvedValueOnce({ id: "req-rw", expiresAtMs: Date.now() + 900_000 });

    const result = await requestMinimumFsPrivilege({
      cfg: {
        tools: {
          fs: {
            grants: [{ path: "/tmp/private.txt", access: "ro", expiresAt: Date.now() + 1_800_000 }],
          },
        },
      },
      sessionKey: "agent:main:feishu:direct:ou_123",
      agentId: "main",
      error: {
        kind: "fs_access_denied",
        suggestedGrant: {
          path: "/tmp/private.txt",
          access: "rw",
          expiresInMs: 900_000,
        },
      },
    });

    expect(result.status).toBe("requested");
    expect(callGatewayMock).toHaveBeenCalledTimes(2);
  });

  it("creates a host_exec privilege request for denied host commands", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-04T10:00:00.000Z"));
    try {
      callGatewayMock
        .mockResolvedValueOnce({ requests: [] })
        .mockResolvedValueOnce({ id: "req-host", expiresAtMs: Date.now() + 1_800_000 });

      const result = await requestHostExecPrivilege({
        cfg: {},
        sessionKey: "agent:main:feishu:direct:ou_123",
        agentId: "main",
        channel: "feishu",
        accountId: "default",
        senderId: "ou_123",
        request: {
          command: "ls /home",
          cwd: "/workspace",
          host: "gateway",
        },
      });

      expect(result).toEqual({
        status: "requested",
        requestId: "req-host",
        expiresAtMs: Date.now() + 1_800_000,
      });
      expect(callGatewayMock).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          method: "privileged.request",
          params: expect.objectContaining({
            kind: "host_exec",
            payload: expect.objectContaining({
              command: "ls /home",
              cwd: "/workspace",
              host: "gateway",
            }),
            requestedBy: expect.objectContaining({
              channel: "feishu",
              accountId: "default",
              senderId: "ou_123",
              sessionKey: "agent:main:feishu:direct:ou_123",
              agentId: "main",
            }),
          }),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
