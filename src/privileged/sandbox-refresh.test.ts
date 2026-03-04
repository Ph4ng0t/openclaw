import { beforeEach, describe, expect, it, vi } from "vitest";

const { removeSandboxContainerMock, readRegistryMock } = vi.hoisted(() => ({
  removeSandboxContainerMock: vi.fn(),
  readRegistryMock: vi.fn(),
}));

vi.mock("../agents/sandbox.js", () => ({
  removeSandboxContainer: removeSandboxContainerMock,
}));

vi.mock("../agents/sandbox/registry.js", () => ({
  readRegistry: readRegistryMock,
}));

import { refreshSandboxForFsGrant } from "./sandbox-refresh.js";

describe("refreshSandboxForFsGrant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refreshes the request session sandbox for session scope", async () => {
    readRegistryMock.mockResolvedValue({
      entries: [
        { containerName: "openclaw-sbx-a", sessionKey: "agent:main:feishu:direct:ou_1" },
        { containerName: "openclaw-sbx-b", sessionKey: "shared" },
      ],
    });

    const message = await refreshSandboxForFsGrant({
      cfg: {
        agents: { defaults: { sandbox: { mode: "docker", scope: "session" } } },
      },
      requestedBy: {
        sessionKey: "agent:main:feishu:direct:ou_1",
        agentId: "main",
      },
    });

    expect(removeSandboxContainerMock).toHaveBeenCalledWith("openclaw-sbx-a");
    expect(message).toBe("Refreshed sandbox openclaw-sbx-a.");
  });

  it("refreshes the shared sandbox when the agent uses shared scope", async () => {
    readRegistryMock.mockResolvedValue({
      entries: [{ containerName: "openclaw-sbx-shared", sessionKey: "shared" }],
    });

    const message = await refreshSandboxForFsGrant({
      cfg: {
        agents: { defaults: { sandbox: { mode: "docker", scope: "shared" } } },
      },
      requestedBy: {
        sessionKey: "agent:main:feishu:direct:ou_1",
      },
    });

    expect(removeSandboxContainerMock).toHaveBeenCalledWith("openclaw-sbx-shared");
    expect(message).toBe("Refreshed sandbox openclaw-sbx-shared.");
  });

  it("skips refresh when sandboxing is disabled", async () => {
    const message = await refreshSandboxForFsGrant({
      cfg: {
        agents: { defaults: { sandbox: { mode: "off" } } },
      },
      requestedBy: {
        sessionKey: "agent:main:feishu:direct:ou_1",
      },
    });

    expect(readRegistryMock).not.toHaveBeenCalled();
    expect(removeSandboxContainerMock).not.toHaveBeenCalled();
    expect(message).toBeNull();
  });
});
