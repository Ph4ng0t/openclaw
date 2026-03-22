import path from "node:path";
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

type RegisteredHostExecRequest = {
  commandId: string;
  cwd?: string;
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

function sameOptionalString(a: unknown, b: unknown): boolean {
  const left = typeof a === "string" ? a.trim() : "";
  const right = typeof b === "string" ? b.trim() : "";
  return left === right;
}

function normalizeHostExecCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

// Check if an fs grant covering the suggested path already exists in config.
// This prevents re-requesting a card when a grant was already approved but the
// sandbox hasn't finished initializing yet (container restart takes time).
function isGrantAlreadyInConfig(
  cfg: OpenClawConfig | undefined,
  suggestedPath: string,
  suggestedAccess: "ro" | "rw",
): boolean {
  const grants = cfg?.tools?.fs?.grants;
  if (!Array.isArray(grants) || grants.length === 0) {
    return false;
  }
  const resolvedSuggested = path.resolve(suggestedPath);
  const now = Date.now();
  for (const grant of grants) {
    if (typeof grant.path !== "string") {
      continue;
    }
    // Skip expired grants
    if (typeof grant.expiresAt === "number" && grant.expiresAt <= now) {
      continue;
    }
    const resolvedGrant = path.resolve(grant.path);
    // Grant covers suggested path if it's the same path or a parent directory
    const covers =
      resolvedSuggested === resolvedGrant || resolvedSuggested.startsWith(resolvedGrant + "/");
    if (!covers) {
      continue;
    }
    // rw grant covers both ro and rw requests; ro grant only covers ro
    if (suggestedAccess === "rw" && grant.access !== "rw") {
      continue;
    }
    return true;
  }
  return false;
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
      !sameOptionalString(payload.cwd, params.request.cwd) ||
      !sameOptionalString(payload.host, params.request.host) ||
      !sameOptionalString(payload.nodeId, params.request.nodeId)
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

function findExistingRegisteredHostExecRequest(params: {
  requests: NonNullable<PrivilegedListResponse["requests"]>;
  sessionKey?: string;
  agentId?: string;
  request: RegisteredHostExecRequest;
}): string | undefined {
  const commandId =
    typeof params.request.commandId === "string" ? params.request.commandId.trim() : "";
  if (!commandId) {
    return undefined;
  }
  for (const request of params.requests) {
    if (request.kind !== "host_exec" || request.status !== "pending") {
      continue;
    }
    const payload = request.payload ?? {};
    const payloadCommandId = typeof payload.commandId === "string" ? payload.commandId.trim() : "";
    const requestedBy = request.requestedBy;
    if (
      !sameString(payloadCommandId, commandId) ||
      !sameOptionalString(payload.cwd, params.request.cwd)
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
  // Grant was already approved and written to config (e.g. sandbox is mid-restart).
  // Don't create a duplicate card — the agent will succeed once the sandbox is ready.
  if (isGrantAlreadyInConfig(params.cfg, suggestion.path, suggestion.access)) {
    return { status: "not-requested", reason: "Grant already exists in config." };
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

export async function requestRegisteredHostExecPrivilege(params: {
  cfg?: OpenClawConfig;
  sessionKey?: string;
  agentId?: string;
  channel?: GatewayMessageChannel;
  accountId?: string;
  senderId?: string | null;
  request: RegisteredHostExecRequest;
}): Promise<
  | { status: "requested"; requestId: string; expiresAtMs?: number }
  | { status: "duplicate"; requestId: string }
  | { status: "not-requested"; reason: string }
> {
  const commandId =
    typeof params.request.commandId === "string" ? params.request.commandId.trim() : "";
  if (!commandId) {
    return { status: "not-requested", reason: "commandId is empty." };
  }
  const listed = await callGateway({
    method: "privileged.list",
    config: params.cfg,
    clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
    clientDisplayName: "Agent privilege broker",
    mode: GATEWAY_CLIENT_MODES.BACKEND,
  });
  const requests = Array.isArray(listed?.requests) ? listed.requests : [];
  const duplicateId = findExistingRegisteredHostExecRequest({
    requests,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    request: {
      commandId,
      cwd: params.request.cwd,
    },
  });
  if (duplicateId) {
    return { status: "duplicate", requestId: duplicateId };
  }

  const expiresAt = Date.now() + 30 * 60 * 1000;
  const response = await callGateway({
    method: "privileged.request",
    config: params.cfg,
    params: {
      kind: "host_exec",
      justification: `Allow registered host exec command: ${commandId}`,
      payload: {
        commandId,
        cwd: params.request.cwd,
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
