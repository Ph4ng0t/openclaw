import type { OpenClawConfig } from "../config/config.js";
import { callGateway } from "../gateway/call.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  type GatewayMessageChannel,
} from "../utils/message-channel.js";

export type FsAccessDeniedPayload = {
  kind: "fs_access_denied";
  path?: string;
  requestedAccess?: "read" | "write";
  suggestedGrant?: {
    path?: string;
    access?: "ro" | "rw";
    expiresInMs?: number;
    reason?: string;
  };
};

type HostExecRequest = {
  command: string;
  cwd?: string;
  host?: "gateway" | "node";
  nodeId?: string;
};

type PrivilegedListResponse = {
  requests?: Array<{
    id?: string;
    kind?: string;
    status?: string;
    payload?: Record<string, unknown>;
    requestedBy?: {
      sessionKey?: string;
      agentId?: string;
      channel?: string;
      accountId?: string;
      senderId?: string;
    };
  }>;
};

function sameString(a: unknown, b: unknown): boolean {
  return typeof a === "string" && typeof b === "string" && a.trim() === b.trim();
}

function normalizeHostExecCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

function findExistingFsGrantRequest(params: {
  requests: NonNullable<PrivilegedListResponse["requests"]>;
  error: FsAccessDeniedPayload;
  sessionKey?: string;
  agentId?: string;
}): string | undefined {
  const suggestion = params.error.suggestedGrant;
  if (!suggestion) {
    return undefined;
  }
  for (const request of params.requests) {
    if (request.kind !== "fs_grant" || request.status !== "pending") {
      continue;
    }
    const payload = request.payload ?? {};
    const requestedBy = request.requestedBy;
    if (
      !sameString(payload.path, suggestion.path) ||
      !sameString(payload.access, suggestion.access)
    ) {
      continue;
    }
    if (
      (params.sessionKey && !sameString(requestedBy?.sessionKey, params.sessionKey)) ||
      (params.agentId && !sameString(requestedBy?.agentId, params.agentId))
    ) {
      continue;
    }
    return typeof request.id === "string" ? request.id : undefined;
  }
  return undefined;
}

function findExistingHostExecRequest(params: {
  requests: NonNullable<PrivilegedListResponse["requests"]>;
  sessionKey?: string;
  agentId?: string;
  request: HostExecRequest;
}): string | undefined {
  const normalizedCommand = normalizeHostExecCommand(params.request.command);
  if (!normalizedCommand) {
    return undefined;
  }
  for (const request of params.requests) {
    if (request.kind !== "host_exec" || request.status !== "pending") {
      continue;
    }
    const payload = request.payload ?? {};
    const payloadCommand =
      typeof payload.command === "string" ? normalizeHostExecCommand(payload.command) : "";
    const requestedBy = request.requestedBy;
    if (
      !sameString(payloadCommand, normalizedCommand) ||
      !sameString(payload.cwd, params.request.cwd) ||
      !sameString(payload.host, params.request.host) ||
      !sameString(payload.nodeId, params.request.nodeId)
    ) {
      continue;
    }
    if (
      (params.sessionKey && !sameString(requestedBy?.sessionKey, params.sessionKey)) ||
      (params.agentId && !sameString(requestedBy?.agentId, params.agentId))
    ) {
      continue;
    }
    return typeof request.id === "string" ? request.id : undefined;
  }
  return undefined;
}

export async function requestMinimumFsPrivilege(params: {
  cfg?: OpenClawConfig;
  error: FsAccessDeniedPayload;
  sessionKey?: string;
  agentId?: string;
  channel?: GatewayMessageChannel;
  accountId?: string;
  senderId?: string | null;
}): Promise<
  | { status: "requested"; requestId: string; expiresAtMs?: number }
  | { status: "duplicate"; requestId: string }
  | { status: "not-requested"; reason: string }
> {
  const suggestion = params.error.suggestedGrant;
  if (
    !suggestion ||
    typeof suggestion.path !== "string" ||
    (suggestion.access !== "ro" && suggestion.access !== "rw") ||
    typeof suggestion.expiresInMs !== "number" ||
    !Number.isFinite(suggestion.expiresInMs)
  ) {
    return { status: "not-requested", reason: "No safe minimal grant available." };
  }

  const listed = await callGateway({
    method: "privileged.list",
    config: params.cfg,
    clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
    clientDisplayName: "Agent privilege broker",
    mode: GATEWAY_CLIENT_MODES.BACKEND,
  });
  const requests = Array.isArray(listed?.requests) ? listed.requests : [];
  const duplicateId = findExistingFsGrantRequest({
    requests,
    error: params.error,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
  });
  if (duplicateId) {
    return { status: "duplicate", requestId: duplicateId };
  }

  const expiresAt = Date.now() + suggestion.expiresInMs;
  const response = await callGateway({
    method: "privileged.request",
    config: params.cfg,
    params: {
      kind: "fs_grant",
      justification: `Grant ${suggestion.access} access to ${suggestion.path} for ${Math.round(
        suggestion.expiresInMs / 60000,
      )}m`,
      payload: {
        path: suggestion.path,
        access: suggestion.access,
        expiresAt,
        reason: suggestion.reason,
      },
      requestedBy: {
        channel: params.channel,
        accountId: params.accountId,
        senderId: params.senderId ?? undefined,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
      },
    },
    clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
    clientDisplayName: "Agent privilege broker",
    mode: GATEWAY_CLIENT_MODES.BACKEND,
  });

  return {
    status: "requested",
    requestId: typeof response?.id === "string" ? response.id : "<unknown>",
    expiresAtMs:
      typeof response?.expiresAtMs === "number" && Number.isFinite(response.expiresAtMs)
        ? response.expiresAtMs
        : expiresAt,
  };
}

export async function requestHostExecPrivilege(params: {
  cfg?: OpenClawConfig;
  sessionKey?: string;
  agentId?: string;
  channel?: GatewayMessageChannel;
  accountId?: string;
  senderId?: string | null;
  request: HostExecRequest;
}): Promise<
  | { status: "requested"; requestId: string; expiresAtMs?: number }
  | { status: "duplicate"; requestId: string }
  | { status: "not-requested"; reason: string }
> {
  const command = normalizeHostExecCommand(params.request.command);
  if (!command) {
    return { status: "not-requested", reason: "Command is empty." };
  }
  const host = params.request.host === "node" ? "node" : "gateway";
  const listed = await callGateway({
    method: "privileged.list",
    config: params.cfg,
    clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
    clientDisplayName: "Agent privilege broker",
    mode: GATEWAY_CLIENT_MODES.BACKEND,
  });
  const requests = Array.isArray(listed?.requests) ? listed.requests : [];
  const duplicateId = findExistingHostExecRequest({
    requests,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    request: {
      command,
      cwd: params.request.cwd,
      host,
      nodeId: params.request.nodeId,
    },
  });
  if (duplicateId) {
    return { status: "duplicate", requestId: duplicateId };
  }

  const expiresAt = Date.now() + 30 * 60 * 1000;
  const target =
    host === "node" && params.request.nodeId?.trim()
      ? `${host}:${params.request.nodeId.trim()}`
      : host;
  const response = await callGateway({
    method: "privileged.request",
    config: params.cfg,
    params: {
      kind: "host_exec",
      justification: `Allow host exec on ${target}: ${command}`,
      payload: {
        command,
        cwd: params.request.cwd,
        host,
        nodeId: params.request.nodeId,
        expiresAt,
      },
      requestedBy: {
        channel: params.channel,
        accountId: params.accountId,
        senderId: params.senderId ?? undefined,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
      },
    },
    clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
    clientDisplayName: "Agent privilege broker",
    mode: GATEWAY_CLIENT_MODES.BACKEND,
  });

  return {
    status: "requested",
    requestId: typeof response?.id === "string" ? response.id : "<unknown>",
    expiresAtMs:
      typeof response?.expiresAtMs === "number" && Number.isFinite(response.expiresAtMs)
        ? response.expiresAtMs
        : expiresAt,
  };
}
