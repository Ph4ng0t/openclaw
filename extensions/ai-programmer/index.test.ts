import { beforeEach, describe, expect, it, vi } from "vitest";

const { requestRegisteredHostExecPrivilegeMock } = vi.hoisted(() => ({
  requestRegisteredHostExecPrivilegeMock: vi.fn(),
}));

vi.mock("../../src/agents/privilege-broker.js", () => ({
  requestRegisteredHostExecPrivilege: requestRegisteredHostExecPrivilegeMock,
}));

import type {
  OpenClawPluginApi,
  PluginHookAfterToolCallEvent,
  PluginHookToolContext,
} from "../../src/plugins/types.js";
import register, { extractDeploymentRequest } from "./index.js";

describe("ai-programmer deployment request hook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requestRegisteredHostExecPrivilegeMock.mockResolvedValue({
      status: "requested",
      requestId: "req-1",
    });
  });

  it("extracts deployment metadata from the ai-programmer tool result", () => {
    expect(
      extractDeploymentRequest({
        details: {
          result: {
            needsDeployment: true,
            deploymentCommandId: "openclaw.deploy.ai-programmer",
          },
        },
      }),
    ).toEqual({
      needsDeployment: true,
      commandId: "openclaw.deploy.ai-programmer",
    });
  });

  it("registers an after_tool_call hook that requests privileged deployment", async () => {
    const hooks = new Map<
      string,
      (event: PluginHookAfterToolCallEvent, ctx: PluginHookToolContext) => Promise<void>
    >();
    const api = {
      config: {},
      registerTool: vi.fn(),
      on: vi.fn(
        (
          hookName: string,
          handler: (
            event: PluginHookAfterToolCallEvent,
            ctx: PluginHookToolContext,
          ) => Promise<void>,
        ) => {
          hooks.set(hookName, handler);
        },
      ),
    } as unknown as OpenClawPluginApi;

    register(api);

    const handler = hooks.get("after_tool_call");
    expect(handler).toBeDefined();
    if (!handler) {
      throw new Error("missing after_tool_call hook");
    }

    await handler(
      {
        toolName: "ai-programmer",
        params: {},
        result: {
          details: {
            result: {
              needsDeployment: true,
              deploymentCommandId: "openclaw.deploy.ai-programmer",
            },
          },
        },
      },
      {
        toolName: "ai-programmer",
        sessionKey: "agent:main:test",
        agentId: "main",
      },
    );

    expect(requestRegisteredHostExecPrivilegeMock).toHaveBeenCalledWith({
      cfg: {},
      sessionKey: "agent:main:test",
      agentId: "main",
      request: {
        commandId: "openclaw.deploy.ai-programmer",
      },
    });
  });

  it("does not request deployment for non-deploy ai-programmer results", async () => {
    const hooks = new Map<
      string,
      (event: PluginHookAfterToolCallEvent, ctx: PluginHookToolContext) => Promise<void>
    >();
    const api = {
      config: {},
      registerTool: vi.fn(),
      on: vi.fn(
        (
          hookName: string,
          handler: (
            event: PluginHookAfterToolCallEvent,
            ctx: PluginHookToolContext,
          ) => Promise<void>,
        ) => {
          hooks.set(hookName, handler);
        },
      ),
    } as unknown as OpenClawPluginApi;

    register(api);
    const handler = hooks.get("after_tool_call");
    if (!handler) {
      throw new Error("missing after_tool_call hook");
    }

    await handler(
      {
        toolName: "ai-programmer",
        params: {},
        result: {
          details: {
            result: {
              needsDeployment: false,
            },
          },
        },
      },
      {
        toolName: "ai-programmer",
      },
    );

    expect(requestRegisteredHostExecPrivilegeMock).not.toHaveBeenCalled();
  });
});
