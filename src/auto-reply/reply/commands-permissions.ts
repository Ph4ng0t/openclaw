import { callGateway } from "../../gateway/call.js";
import { logVerbose } from "../../globals.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  isInternalMessageChannel,
} from "../../utils/message-channel.js";
import type { CommandHandler } from "./commands-types.js";

function shouldSilenceFeishuPrivilegedAck(params: Parameters<CommandHandler>[0]) {
  return params.command.channel === "feishu";
}

function hasApprovalScope(scopes: readonly string[]): boolean {
  return scopes.includes("operator.approvals") || scopes.includes("operator.admin");
}

function requireAuthorized(params: Parameters<CommandHandler>[0]) {
  if (params.command.isAuthorizedSender) {
    return null;
  }
  logVerbose(
    `Ignoring permission command from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
  );
  return { shouldContinue: false } as const;
}

function requireGatewayApprovalScope(params: Parameters<CommandHandler>[0]) {
  if (!isInternalMessageChannel(params.command.channel)) {
    return null;
  }
  const scopes = params.ctx.GatewayClientScopes ?? [];
  if (hasApprovalScope(scopes)) {
    return null;
  }
  return {
    shouldContinue: false,
    reply: { text: "❌ Permission commands require operator.approvals for gateway clients." },
  } as const;
}

async function submitPrivilegedRequest(
  params: Parameters<CommandHandler>[0],
  payload: { kind: string; justification: string; payload: Record<string, unknown> },
) {
  return await callGateway({
    method: "privileged.request",
    params: {
      ...payload,
      requestedBy: {
        channel: params.command.channel,
        accountId: params.ctx.AccountId,
        senderId: params.command.senderId,
        sessionKey: params.sessionKey,
      },
    },
    clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
    clientDisplayName: `Permissions (${params.command.channel}:${params.command.senderId ?? "unknown"})`,
    mode: GATEWAY_CLIENT_MODES.BACKEND,
  });
}

export const handlePermissionsCommands: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized.trim();
  if (!/^\/(grant|revoke|permissions|dangerous|privileged)\b/i.test(normalized)) {
    return null;
  }
  const authFailure = requireAuthorized(params);
  if (authFailure) {
    return authFailure;
  }
  const scopeFailure = requireGatewayApprovalScope(params);
  if (scopeFailure) {
    return scopeFailure;
  }

  if (normalized === "/permissions") {
    const res = await callGateway({
      method: "privileged.list",
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientDisplayName: "Permissions list",
      mode: GATEWAY_CLIENT_MODES.BACKEND,
    });
    const requests = Array.isArray(res?.requests) ? res.requests : [];
    const lines = ["Pending privileged requests:"];
    if (requests.length === 0) {
      lines.push("- none");
    } else {
      for (const request of requests) {
        lines.push(`- ${String(request.id)} ${String(request.kind)} ${String(request.status)}`);
      }
    }
    return { shouldContinue: false, reply: { text: lines.join("\n") } };
  }

  if (normalized === "/privileged pending") {
    const res = await callGateway({
      method: "privileged.list",
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientDisplayName: "Permissions list",
      mode: GATEWAY_CLIENT_MODES.BACKEND,
    });
    const requests = Array.isArray(res?.requests) ? res.requests : [];
    return {
      shouldContinue: false,
      reply: {
        text:
          requests
            .map(
              (request) =>
                `${String(request.id)} ${String(request.kind)} ${String(request.status)}`,
            )
            .join("\n") || "No pending privileged requests.",
      },
    };
  }

  const grantMatch = normalized.match(/^\/grant\s+path\s+(\S+)(?:\s+(ro|rw))?$/i);
  if (grantMatch) {
    const [, grantPath, accessRaw] = grantMatch;
    await submitPrivilegedRequest(params, {
      kind: "fs_grant",
      justification: `Grant ${accessRaw ?? "rw"} access to ${grantPath}`,
      payload: { path: grantPath, access: accessRaw === "ro" ? "ro" : "rw" },
    });
    return shouldSilenceFeishuPrivilegedAck(params)
      ? { shouldContinue: false }
      : {
          shouldContinue: false,
          reply: { text: "✅ Privileged fs_grant request created." },
        };
  }

  const revokeMatch = normalized.match(/^\/revoke\s+path\s+(\S+)$/i);
  if (revokeMatch) {
    const [, grantPath] = revokeMatch;
    await submitPrivilegedRequest(params, {
      kind: "fs_revoke",
      justification: `Revoke access to ${grantPath}`,
      payload: { path: grantPath },
    });
    return shouldSilenceFeishuPrivilegedAck(params)
      ? { shouldContinue: false }
      : {
          shouldContinue: false,
          reply: { text: "✅ Privileged fs_revoke request created." },
        };
  }

  if (/^\/dangerous\s+shutdown$/i.test(normalized)) {
    await submitPrivilegedRequest(params, {
      kind: "shutdown",
      justification: "Shutdown host machine",
      payload: {},
    });
    return shouldSilenceFeishuPrivilegedAck(params)
      ? { shouldContinue: false }
      : {
          shouldContinue: false,
          reply: { text: "✅ Privileged shutdown request created." },
        };
  }

  return {
    shouldContinue: false,
    reply: {
      text: "Usage: /permissions | /privileged pending | /grant path <absPath> [ro|rw] | /revoke path <absPath> | /dangerous shutdown",
    },
  };
};
