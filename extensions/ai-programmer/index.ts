import type { AnyAgentTool, OpenClawPluginApi } from "../../src/plugins/types.js";
import { createCodingTaskTool } from "./src/coding-task-tool.js";

export default function register(api: OpenClawPluginApi) {
  api.registerTool(createCodingTaskTool(api) as unknown as AnyAgentTool, { optional: true });
}
