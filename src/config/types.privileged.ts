export type PrivilegedRequestKind =
  | "fs_grant"
  | "fs_revoke"
  | "config_patch"
  | "host_exec"
  | "shutdown"
  | "reboot";

export type PrivilegedActionFlags = {
  fsGrant?: boolean;
  fsRevoke?: boolean;
  configPatch?: boolean;
  hostExec?: boolean;
  shutdown?: boolean;
  reboot?: boolean;
};

export type PrivilegedGateConfig = {
  socketPath?: string;
  tokenPath?: string;
};

export type PrivilegedConfig = {
  enabled?: boolean;
  approvalTtlSec?: number;
  requestTtlSec?: number;
  requireOwnerForResolve?: boolean;
  gate?: PrivilegedGateConfig;
  actions?: PrivilegedActionFlags;
};
