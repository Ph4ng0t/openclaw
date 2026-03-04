import { beforeEach, describe, expect, it, vi } from "vitest";

const callGatewayMock = vi.hoisted(() => vi.fn());

vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

import { requestMinimumFsPrivilege } from "./privilege-broker.js";

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
});
