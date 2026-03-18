import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "../../src/plugins/types.js";
import { createCodingTaskTool } from "./src/coding-task-tool.js";

export default function register(api: OpenClawPluginApi) {
  // Use factory so the tool receives the calling agent's context (incl. agentDir),
  // which is needed to resolve auth credentials from the correct agent's store.
  api.registerTool(
    (ctx: OpenClawPluginToolContext) => createCodingTaskTool(api, ctx) as unknown as AnyAgentTool,
    { optional: true },
  );
}
