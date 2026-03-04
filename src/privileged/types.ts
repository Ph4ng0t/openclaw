import type { PrivilegedRequestKind } from "../config/types.privileged.js";

export type PrivilegedFsGrantPayload = {
  path: string;
  access: "ro" | "rw";
  persistent?: boolean;
  reason?: string;
  expiresAt?: number;
};

export type PrivilegedFsRevokePayload = {
  path: string;
};

export type PrivilegedHostExecPayload = {
  commandId: string;
  argv?: string[];
  cwd?: string;
};

export type PrivilegedConfigPatchPayload = {
  patch: Array<{
    op: "set" | "unset";
    path: string;
    value?: unknown;
  }>;
};

export type PrivilegedRequestPayload =
  | PrivilegedFsGrantPayload
  | PrivilegedFsRevokePayload
  | PrivilegedHostExecPayload
  | PrivilegedConfigPatchPayload
  | Record<string, unknown>;

export type PrivilegedRequestStatus =
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "executed"
  | "failed";

export type PrivilegedRequestedBy = {
  channel?: string;
  accountId?: string;
  senderId?: string;
  sessionKey?: string;
  agentId?: string;
};

export type PrivilegedRequestRecord = {
  id: string;
  kind: PrivilegedRequestKind;
  createdAtMs: number;
  expiresAtMs: number;
  requestedBy?: PrivilegedRequestedBy;
  justification: string;
  payload: PrivilegedRequestPayload;
  singleUse: boolean;
  status: PrivilegedRequestStatus;
  resolvedAtMs?: number;
  resolvedBy?: string | null;
  result?: { ok: boolean; message?: string };
};
