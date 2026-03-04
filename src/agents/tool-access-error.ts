import type { ToolFsRoot } from "./tool-fs-policy.js";

export type ToolAccessErrorKind = "fs_access_denied";

export type SuggestedFsGrant = {
  path: string;
  access: "ro" | "rw";
  expiresInMs: number;
  reason: string;
};

export class ToolAccessError extends Error {
  readonly kind: ToolAccessErrorKind;
  readonly toolName?: string;
  readonly path?: string;
  readonly requestedAccess?: "read" | "write";
  readonly allowedRoots?: ToolFsRoot[];
  readonly suggestedGrant?: SuggestedFsGrant;

  constructor(params: {
    message: string;
    kind: ToolAccessErrorKind;
    toolName?: string;
    path?: string;
    requestedAccess?: "read" | "write";
    allowedRoots?: ToolFsRoot[];
    suggestedGrant?: SuggestedFsGrant;
  }) {
    super(params.message);
    this.name = "ToolAccessError";
    this.kind = params.kind;
    this.toolName = params.toolName;
    this.path = params.path;
    this.requestedAccess = params.requestedAccess;
    this.allowedRoots = params.allowedRoots;
    this.suggestedGrant = params.suggestedGrant;
  }
}

export function isToolAccessError(value: unknown): value is ToolAccessError {
  return value instanceof ToolAccessError;
}
