import { Type } from "@sinclair/typebox";
import { callGateway } from "../../gateway/call.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import type { AnyAgentTool } from "./common.js";
import { readStringArrayParam, readStringParam } from "./common.js";

const RequestPrivilegeSchema = Type.Object({
  kind: Type.String({
    description: "Privilege kind: fs_grant, fs_revoke, host_exec, shutdown, config_patch, reboot",
  }),
  justification: Type.String({ description: "Human-facing reason for the request." }),
  path: Type.Optional(Type.String()),
  access: Type.Optional(Type.String()),
  command: Type.Optional(Type.String()),
  commandId: Type.Optional(Type.String()),
  argv: Type.Optional(Type.Array(Type.String())),
  cwd: Type.Optional(Type.String()),
  persist: Type.Optional(Type.Boolean()),
});

function formatPrivilegeRequestResponse(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

export function createRequestPrivilegeTool(opts?: {
  agentSessionKey?: string;
  agentId?: string;
  channel?: string;
  accountId?: string;
  senderId?: string | null;
}): AnyAgentTool {
  return {
    label: "Request Privilege",
    name: "request_privilege",
    description:
      "Create a privileged action proposal for owner approval. Use `kind=fs_grant` with `path` + `access=ro|rw` for filesystem access, or `kind=host_exec` with `command` for host commands. This tool never executes the action itself.",
    parameters: RequestPrivilegeSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const kind = readStringParam(params, "kind", { required: true });
      const justification = readStringParam(params, "justification", { required: true });
      const payload: Record<string, unknown> = {};
      const requestPath = readStringParam(params, "path");
      if (requestPath) {
        payload.path = requestPath;
      }
      const access = readStringParam(params, "access");
      if (access) {
        payload.access = access;
      }
      const command = readStringParam(params, "command");
      if (command) {
        payload.command = command;
      }
      const commandId = readStringParam(params, "commandId");
      if (commandId) {
        payload.commandId = commandId;
      }
      const argv = readStringArrayParam(params, "argv");
      if (argv) {
        payload.argv = argv;
      }
      const cwd = readStringParam(params, "cwd");
      if (cwd) {
        payload.cwd = cwd;
      }
      if (params.persist === true) {
        payload.persistent = true;
      }
      const res = await callGateway({
        method: "privileged.request",
        params: {
          kind,
          justification,
          payload,
          requestedBy: {
            channel: opts?.channel,
            accountId: opts?.accountId,
            senderId: opts?.senderId,
            sessionKey: opts?.agentSessionKey,
            agentId: opts?.agentId,
          },
        },
        clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
        clientDisplayName: "Agent privilege request",
        mode: GATEWAY_CLIENT_MODES.BACKEND,
      });
      const requestId = formatPrivilegeRequestResponse(res.id, "<unknown>");
      const status = formatPrivilegeRequestResponse(res.status, "accepted");
      return {
        content: [
          {
            type: "text",
            text: `Created privileged request ${requestId} (${status}). Await owner approval.`,
          },
        ],
        details: res,
      };
    },
  };
}
