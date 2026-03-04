import { describe, expect, it, vi } from "vitest";
import { createGatewayCloseHandler } from "./server-close.js";

describe("createGatewayCloseHandler", () => {
  it("stops the privileged gate during shutdown", async () => {
    const privilegedGateStop = vi.fn(async () => {});
    const handler = createGatewayCloseHandler({
      bonjourStop: null,
      tailscaleCleanup: null,
      canvasHost: null,
      canvasHostServer: null,
      stopChannel: async () => {},
      pluginServices: null,
      cron: { stop: () => {} },
      heartbeatRunner: { stop: () => {}, updateConfig: () => {} },
      updateCheckStop: null,
      nodePresenceTimers: new Map(),
      broadcast: () => {},
      tickInterval: setInterval(() => {}, 1 << 30),
      healthInterval: setInterval(() => {}, 1 << 30),
      dedupeCleanup: setInterval(() => {}, 1 << 30),
      agentUnsub: null,
      heartbeatUnsub: null,
      chatRunState: { clear: () => {} },
      clients: new Set(),
      configReloader: { stop: async () => {} },
      browserControl: null,
      privilegedGateServer: null,
      privilegedGateStop,
      wss: { close: (cb: () => void) => cb() } as never,
      httpServer: { close: (cb: (err?: Error | null) => void) => cb(null) } as never,
      httpServers: [],
    });

    await handler();

    expect(privilegedGateStop).toHaveBeenCalledOnce();
  });
});
