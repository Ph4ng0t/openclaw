import { requestRegisteredHostExecPrivilege } from "../../src/agents/privilege-broker.js";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  PluginHookAfterToolCallEvent,
  PluginHookToolContext,
  OpenClawPluginToolContext,
} from "../../src/plugins/types.js";
import { createCodingTaskTool } from "./src/coding-task-tool.js";

function extractDeploymentRequest(result: unknown): {
  needsDeployment: boolean;
  commandId?: string;
} {
  if (!result || typeof result !== "object") {
    return { needsDeployment: false };
  }
  const candidate = result as {
    details?: { result?: { needsDeployment?: boolean; deploymentCommandId?: string } };
  };
  const payload = candidate.details?.result;
  if (!payload || typeof payload !== "object") {
    return { needsDeployment: false };
  }
  return {
    needsDeployment: payload.needsDeployment === true,
    commandId:
      typeof payload.deploymentCommandId === "string"
        ? payload.deploymentCommandId.trim()
        : undefined,
  };
}

async function maybeRequestAiProgrammerDeployment(
  api: OpenClawPluginApi,
  event: PluginHookAfterToolCallEvent,
  ctx: PluginHookToolContext,
): Promise<void> {
  if (event.toolName !== "ai-programmer" || event.error) {
    return;
  }
  const deployment = extractDeploymentRequest(event.result);
  if (!deployment.needsDeployment || !deployment.commandId) {
    return;
  }
  await requestRegisteredHostExecPrivilege({
    cfg: api.config,
    sessionKey: ctx.sessionKey,
    agentId: ctx.agentId,
    request: {
      commandId: deployment.commandId,
    },
  });
}

export default function register(api: OpenClawPluginApi) {
  // Use factory so the tool receives the calling agent's context (incl. agentDir),
  // which is needed to resolve auth credentials from the correct agent's store.
  api.registerTool(
    (ctx: OpenClawPluginToolContext) => createCodingTaskTool(api, ctx) as unknown as AnyAgentTool,
    { optional: true },
  );
  api.on("after_tool_call", async (event, ctx) => {
    await maybeRequestAiProgrammerDeployment(api, event, ctx);
  });
}

export { extractDeploymentRequest, maybeRequestAiProgrammerDeployment };
