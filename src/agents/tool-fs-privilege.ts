import path from "node:path";
import type { SuggestedFsGrant } from "./tool-access-error.js";
import type { ToolFsPolicy } from "./tool-fs-policy.js";

const READ_GRANT_TTL_MS = 30 * 60 * 1000;
const WRITE_GRANT_TTL_MS = 15 * 60 * 1000;

const AUTO_DENY_PREFIXES = [
  "/",
  "/bin",
  "/dev",
  "/etc",
  "/proc",
  "/sbin",
  "/sys",
  "/System",
  "/usr",
  "/var/run/docker.sock",
] as const;

function isDeniedPrefix(candidatePath: string): boolean {
  const resolved = path.resolve(candidatePath);
  return AUTO_DENY_PREFIXES.some((prefix) => {
    if (prefix === "/") {
      return resolved === "/";
    }
    return resolved === prefix || resolved.startsWith(`${prefix}/`);
  });
}

export function suggestFsGrant(params: {
  filePath: string;
  access: "read" | "write";
  policy: ToolFsPolicy;
}): SuggestedFsGrant | undefined {
  const resolved = path.resolve(params.filePath);
  const grantPath = params.access === "read" ? resolved : path.dirname(resolved);
  if (!grantPath || isDeniedPrefix(grantPath)) {
    return undefined;
  }
  return {
    path: grantPath,
    access: params.access === "read" ? "ro" : "rw",
    expiresInMs: params.access === "read" ? READ_GRANT_TTL_MS : WRITE_GRANT_TTL_MS,
    reason:
      params.access === "read"
        ? "Temporary read access required outside workspace"
        : "Temporary write access required outside workspace",
  };
}
