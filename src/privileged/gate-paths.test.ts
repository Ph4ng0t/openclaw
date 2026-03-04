import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensurePrivilegedGateToken, resolvePrivilegedGatePaths } from "./gate-paths.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map(async (entry) => {
      await rm(entry, { recursive: true, force: true });
    }),
  );
});

describe("privileged gate paths", () => {
  it("resolves configured socket and token paths", () => {
    const paths = resolvePrivilegedGatePaths({
      privileged: {
        gate: {
          socketPath: "/tmp/openclaw-test.sock",
          tokenPath: "/tmp/openclaw-test.token",
        },
      },
    });
    expect(paths.socketPath).toBe("/tmp/openclaw-test.sock");
    expect(paths.tokenPath).toBe("/tmp/openclaw-test.token");
    expect(paths.auditLogPath.endsWith("privileged-gate.audit.jsonl")).toBe(true);
  });

  it("creates and reuses a gate token file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openclaw-privileged-token-"));
    cleanupPaths.push(dir);
    const tokenPath = path.join(dir, "gate.token");
    const first = await ensurePrivilegedGateToken(tokenPath);
    const second = await ensurePrivilegedGateToken(tokenPath);
    expect(first).toBe(second);
    expect(first.length).toBeGreaterThan(10);
    expect((await readFile(tokenPath, "utf8")).trim()).toBe(first);
  });
});
