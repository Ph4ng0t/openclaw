import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { isPathInside } from "../infra/path-guards.js";
import { resolveUserPath } from "../utils.js";
import { resolveAgentConfig } from "./agent-scope.js";

export type ToolFsGrant = {
  id?: string;
  path: string;
  access: "ro" | "rw";
  persistent?: boolean;
  expiresAt?: number;
  reason?: string;
};

export type ToolFsRoot = {
  path: string;
  access: "ro" | "rw";
  source: "workspace" | "grant";
  id?: string;
  reason?: string;
};

export type ToolFsPolicy = {
  workspaceOnly: boolean;
  roots?: ToolFsRoot[];
};

export function createToolFsPolicy(params: {
  workspaceOnly?: boolean;
  workspaceRoot: string;
  grants?: ToolFsGrant[];
}): ToolFsPolicy {
  const roots: ToolFsRoot[] = [
    { path: path.resolve(params.workspaceRoot), access: "rw", source: "workspace" },
  ];
  for (const grant of normalizeToolFsGrants(params.grants)) {
    roots.push({
      path: grant.path,
      access: grant.access,
      source: "grant",
      id: grant.id,
      reason: grant.reason,
    });
  }
  return {
    workspaceOnly: params.workspaceOnly === true,
    roots: dedupeToolFsRoots(roots),
  };
}

export function resolveToolFsConfig(params: { cfg?: OpenClawConfig; agentId?: string }): {
  workspaceOnly?: boolean;
  grants?: ToolFsGrant[];
} {
  const cfg = params.cfg;
  const globalFs = cfg?.tools?.fs;
  const agentFs =
    cfg && params.agentId ? resolveAgentConfig(cfg, params.agentId)?.tools?.fs : undefined;
  return {
    workspaceOnly: agentFs?.workspaceOnly ?? globalFs?.workspaceOnly,
    grants: agentFs?.grants ?? globalFs?.grants,
  };
}

export function resolveEffectiveToolFsWorkspaceOnly(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
}): boolean {
  return resolveToolFsConfig(params).workspaceOnly === true;
}

export function normalizeToolFsGrants(grants?: ToolFsGrant[]): ToolFsGrant[] {
  if (!Array.isArray(grants) || grants.length === 0) {
    return [];
  }
  const now = Date.now();
  return grants
    .filter((grant) => typeof grant?.path === "string" && grant.path.trim())
    .filter((grant) => !grant.expiresAt || grant.expiresAt > now)
    .map((grant) => ({
      ...grant,
      path: path.resolve(resolveUserPath(grant.path)),
      access: grant.access === "ro" ? "ro" : "rw",
    }));
}

export function isToolFsPathAllowed(
  policy: ToolFsPolicy,
  candidatePath: string,
  access: "read" | "write",
): boolean {
  if (!policy.workspaceOnly) {
    return true;
  }
  const resolved = path.resolve(candidatePath);
  return (policy.roots ?? []).some((root) => {
    if (!isPathInside(root.path, resolved)) {
      return false;
    }
    if (access === "read") {
      return true;
    }
    return root.access === "rw";
  });
}

export function getToolFsAllowedRoot(
  policy: ToolFsPolicy,
  candidatePath: string,
  access: "read" | "write",
): ToolFsRoot | null {
  if (!policy.workspaceOnly) {
    return null;
  }
  const resolved = path.resolve(candidatePath);
  return (
    (policy.roots ?? []).find((root) => {
      if (!isPathInside(root.path, resolved)) {
        return false;
      }
      if (access === "read") {
        return true;
      }
      return root.access === "rw";
    }) ?? null
  );
}

function dedupeToolFsRoots(roots: ToolFsRoot[]): ToolFsRoot[] {
  const deduped: ToolFsRoot[] = [];
  for (const root of roots) {
    const existing = deduped.find((entry) => entry.path === root.path);
    if (!existing) {
      deduped.push(root);
      continue;
    }
    if (existing.access === "ro" && root.access === "rw") {
      existing.access = "rw";
    }
  }
  return deduped;
}
