import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { applyPrivilegedRequest } from "./apply.js";
import { ensurePrivilegedGateToken, resolvePrivilegedGatePaths } from "./gate-paths.js";
import type { PrivilegedGateExecuteRequest, PrivilegedGateExecuteResponse } from "./gate-types.js";
import type { PrivilegedRequestRecord } from "./types.js";

function writeResponse(socket: net.Socket, response: PrivilegedGateExecuteResponse): void {
  socket.end(`${JSON.stringify(response)}\n`);
}

function isPrivilegedGateRequest(value: unknown): value is PrivilegedGateExecuteRequest {
  if (!value || typeof value !== "object") {
    return false;
  }
  const request = value as Record<string, unknown>;
  return (
    request.action === "execute" &&
    typeof request.token === "string" &&
    request.record !== null &&
    typeof request.record === "object"
  );
}

async function appendAuditLog(params: {
  auditLogPath: string;
  record: PrivilegedRequestRecord;
  ok: boolean;
  message: string;
}): Promise<void> {
  await mkdir(path.dirname(params.auditLogPath), { recursive: true });
  await appendFile(
    params.auditLogPath,
    `${JSON.stringify({
      at: Date.now(),
      requestId: params.record.id,
      kind: params.record.kind,
      ok: params.ok,
      message: params.message,
    })}\n`,
    "utf8",
  );
}

export async function startPrivilegedGateServer(params?: {
  cfg?: OpenClawConfig;
  abortSignal?: AbortSignal;
  log?: (message: string) => void;
}): Promise<net.Server> {
  const cfg = params?.cfg;
  const { socketPath, tokenPath, auditLogPath } = resolvePrivilegedGatePaths(cfg);
  const expectedToken = await ensurePrivilegedGateToken(tokenPath);
  await mkdir(path.dirname(socketPath), { recursive: true });
  try {
    await rm(socketPath);
  } catch {}
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", async (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const line = buffer.slice(0, newlineIndex);
      buffer = "";
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        writeResponse(socket, { ok: false, error: "invalid json" });
        return;
      }
      if (!isPrivilegedGateRequest(parsed)) {
        writeResponse(socket, { ok: false, error: "invalid request" });
        return;
      }
      if (parsed.token.trim() !== expectedToken) {
        writeResponse(socket, { ok: false, error: "unauthorized" });
        return;
      }
      try {
        const message = await applyPrivilegedRequest(parsed.record);
        await appendAuditLog({
          auditLogPath,
          record: parsed.record,
          ok: true,
          message,
        });
        writeResponse(socket, { ok: true, message });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await appendAuditLog({
          auditLogPath,
          record: parsed.record,
          ok: false,
          message,
        });
        writeResponse(socket, { ok: false, error: message });
      }
    });
  });
  if (params?.abortSignal) {
    params.abortSignal.addEventListener(
      "abort",
      () => {
        server.close();
        void rm(socketPath).catch(() => {});
      },
      { once: true },
    );
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  try {
    const tokenStat = await readFile(tokenPath, "utf8");
    params?.log?.(
      `privileged gate listening on ${socketPath} (token ${tokenStat.trim() ? "loaded" : "missing"})`,
    );
  } catch {
    params?.log?.(`privileged gate listening on ${socketPath}`);
  }
  return server;
}
