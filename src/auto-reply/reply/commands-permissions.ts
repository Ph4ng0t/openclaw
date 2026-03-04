import { parseDurationMs } from "../../cli/parse-duration.js";
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

function parseGrantCommand(raw: string): {
  path: string;
  access: "ro" | "rw";
  expiresAt?: number;
  durationLabel?: string;
} | null {
  const match = raw.match(/^\/grant\s+path\s+(\S+)(?:\s+(\S+))?(?:\s+(\S+))?$/i);
  if (!match) {
    return null;
  }
  const [, grantPath, secondTokenRaw, thirdTokenRaw] = match;
  const secondToken = secondTokenRaw?.trim().toLowerCase();
  const thirdToken = thirdTokenRaw?.trim().toLowerCase();
  let access: "ro" | "rw" = "rw";
  let durationRaw: string | undefined;

  if (secondToken === "ro" || secondToken === "rw") {
    access = secondToken;
    durationRaw = thirdTokenRaw?.trim();
  } else {
    durationRaw = secondTokenRaw?.trim();
  }

  if (thirdTokenRaw && !durationRaw) {
    return null;
  }
  if (
    thirdTokenRaw &&
    thirdToken !== undefined &&
    !(secondToken === "ro" || secondToken === "rw")
  ) {
    return null;
  }

  if (!durationRaw) {
    return { path: grantPath, access };
  }

  const durationMs = parseDurationMs(durationRaw, { defaultUnit: "h" });
  return {
    path: grantPath,
    access,
    expiresAt: Date.now() + durationMs,
    durationLabel: durationRaw,
  };
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

  try {
    const grantRequest = parseGrantCommand(normalized);
    if (grantRequest) {
      const payload: Record<string, unknown> = {
        path: grantRequest.path,
        access: grantRequest.access,
      };
      if (typeof grantRequest.expiresAt === "number") {
        payload.expiresAt = grantRequest.expiresAt;
      }
      const justification =
        typeof grantRequest.expiresAt === "number"
          ? `Grant ${grantRequest.access} access to ${grantRequest.path} for ${grantRequest.durationLabel}`
          : `Grant ${grantRequest.access} access to ${grantRequest.path}`;

      await submitPrivilegedRequest(params, {
        kind: "fs_grant",
        justification,
        payload,
      });
      return shouldSilenceFeishuPrivilegedAck(params)
        ? { shouldContinue: false }
        : {
            shouldContinue: false,
            reply: {
              text:
                typeof grantRequest.expiresAt === "number"
                  ? `✅ Privileged fs_grant request created (expires in ${grantRequest.durationLabel}).`
                  : "✅ Privileged fs_grant request created.",
            },
          };
    }
  } catch (error) {
    return {
      shouldContinue: false,
      reply: {
        text: `❌ Invalid grant duration: ${String(error instanceof Error ? error.message : error)}`,
      },
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
      text: "Usage: /permissions | /privileged pending | /grant path <absPath> [ro|rw] [duration] | /revoke path <absPath> | /dangerous shutdown",
    },
  };
};
