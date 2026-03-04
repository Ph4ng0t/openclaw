import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { resolveStateDir, type OpenClawConfig } from "../config/config.js";

function expandHome(input: string): string {
  if (input === "~") {
    return homedir();
  }
  if (input.startsWith("~/")) {
    return path.join(homedir(), input.slice(2));
  }
  return input;
}

export function resolvePrivilegedGatePaths(cfg?: OpenClawConfig): {
  socketPath: string;
  tokenPath: string;
  auditLogPath: string;
} {
  const stateDir = resolveStateDir(process.env);
  const configuredSocket = cfg?.privileged?.gate?.socketPath?.trim();
  const configuredToken = cfg?.privileged?.gate?.tokenPath?.trim();
  return {
    socketPath: expandHome(configuredSocket || path.join(stateDir, "privileged-gate.sock")),
    tokenPath: expandHome(configuredToken || path.join(stateDir, "privileged-gate-token")),
    auditLogPath: path.join(stateDir, "privileged-gate.audit.jsonl"),
  };
}

export async function ensurePrivilegedGateToken(tokenPath: string): Promise<string> {
  try {
    const existing = (await readFile(tokenPath, "utf8")).trim();
    if (existing) {
      return existing;
    }
  } catch {}
  const token = randomBytes(24).toString("hex");
  await mkdir(path.dirname(tokenPath), { recursive: true });
  await writeFile(tokenPath, `${token}\n`, { mode: 0o600 });
  return token;
}
