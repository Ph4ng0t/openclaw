import { removeSandboxContainer } from "../agents/sandbox.js";
import { resolveSandboxConfigForAgent } from "../agents/sandbox/config.js";
import { readRegistry } from "../agents/sandbox/registry.js";
import { resolveSandboxScopeKey } from "../agents/sandbox/shared.js";
import type { OpenClawConfig } from "../config/types.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import type { PrivilegedRequestedBy } from "./types.js";

function trimString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resolveRefreshScope(params: {
  cfg: OpenClawConfig;
  requestedBy?: PrivilegedRequestedBy;
}): { scopeKey: string; agentId?: string } | null {
  const sessionKey = trimString(params.requestedBy?.sessionKey);
  const explicitAgentId = trimString(params.requestedBy?.agentId);
  const agentId =
    explicitAgentId ?? (sessionKey ? resolveAgentIdFromSessionKey(sessionKey) : undefined);
  const sandboxCfg = resolveSandboxConfigForAgent(params.cfg, agentId);
  if (sandboxCfg.mode === "off") {
    return null;
  }

  if (sandboxCfg.scope === "shared") {
    return { scopeKey: "shared", agentId };
  }
  if (sandboxCfg.scope === "agent") {
    const scopeSessionKey = sessionKey ?? (agentId ? `agent:${agentId}` : undefined);
    if (!scopeSessionKey) {
      return null;
    }
    return {
      scopeKey: resolveSandboxScopeKey("agent", scopeSessionKey),
      agentId,
    };
  }
  if (!sessionKey) {
    return null;
  }
  return {
    scopeKey: resolveSandboxScopeKey("session", sessionKey),
    agentId,
  };
}

export async function refreshSandboxForFsGrant(params: {
  cfg: OpenClawConfig;
  requestedBy?: PrivilegedRequestedBy;
}): Promise<string | null> {
  const resolved = resolveRefreshScope(params);
  if (!resolved) {
    return null;
  }

  const registry = await readRegistry();
  const targets = registry.entries.filter((entry) => entry.sessionKey === resolved.scopeKey);
  if (targets.length === 0) {
    return null;
  }

  for (const target of targets) {
    await removeSandboxContainer(target.containerName);
  }

  if (targets.length === 1) {
    return `Refreshed sandbox ${targets[0]?.containerName ?? resolved.scopeKey}.`;
  }
  return `Refreshed ${targets.length} sandbox containers for ${resolved.scopeKey}.`;
}
