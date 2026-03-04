import { readFile } from "node:fs/promises";
import net from "node:net";
import { loadConfig } from "../config/config.js";
import { resolvePrivilegedGatePaths } from "./gate-paths.js";
import type { PrivilegedGateExecuteRequest, PrivilegedGateExecuteResponse } from "./gate-types.js";
import type { PrivilegedRequestRecord } from "./types.js";

export async function executePrivilegedViaGate(record: PrivilegedRequestRecord): Promise<string> {
  const cfg = loadConfig();
  const { socketPath, tokenPath } = resolvePrivilegedGatePaths(cfg);
  const token = (await readFile(tokenPath, "utf8")).trim();
  if (!token) {
    throw new Error(`privileged gate token missing: ${tokenPath}`);
  }
  const request: PrivilegedGateExecuteRequest = {
    token,
    action: "execute",
    record,
  };
  const response = await requestPrivilegedGate(socketPath, request);
  if (!response.ok) {
    throw new Error(response.error);
  }
  return response.message;
}

function requestPrivilegedGate(
  socketPath: string,
  request: PrivilegedGateExecuteRequest,
): Promise<PrivilegedGateExecuteResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      socket.end();
      try {
        resolve(JSON.parse(line) as PrivilegedGateExecuteResponse);
      } catch (error) {
        reject(error);
      }
    });
    socket.on("error", (error) => {
      reject(
        new Error(
          `privileged gate unavailable at ${socketPath}: ${
            error instanceof Error ? error.message : String(error)
          }. Gateway should start it automatically when privileged.enabled=true; for manual debugging you can also run: openclaw privileged gate run`,
        ),
      );
    });
  });
}
