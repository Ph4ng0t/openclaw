import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSandboxWorkdir } from "./bash-tools.shared.js";

async function withTempDir(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-bash-workdir-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("resolveSandboxWorkdir", () => {
  it("maps container root workdir to host workspace", async () => {
    await withTempDir(async (workspaceDir) => {
      const warnings: string[] = [];
      const resolved = await resolveSandboxWorkdir({
        workdir: "/workspace",
        sandbox: {
          containerName: "sandbox-1",
          workspaceDir,
          containerWorkdir: "/workspace",
        },
        warnings,
      });

      expect(resolved.hostWorkdir).toBe(workspaceDir);
      expect(resolved.containerWorkdir).toBe("/workspace");
      expect(warnings).toEqual([]);
    });
  });

  it("maps nested container workdir under the container workspace", async () => {
    await withTempDir(async (workspaceDir) => {
      const nested = path.join(workspaceDir, "scripts", "runner");
      await mkdir(nested, { recursive: true });
      const warnings: string[] = [];
      const resolved = await resolveSandboxWorkdir({
        workdir: "/workspace/scripts/runner",
        sandbox: {
          containerName: "sandbox-2",
          workspaceDir,
          containerWorkdir: "/workspace",
        },
        warnings,
      });

      expect(resolved.hostWorkdir).toBe(nested);
      expect(resolved.containerWorkdir).toBe("/workspace/scripts/runner");
      expect(warnings).toEqual([]);
    });
  });

  it("supports custom container workdir prefixes", async () => {
    await withTempDir(async (workspaceDir) => {
      const nested = path.join(workspaceDir, "project");
      await mkdir(nested, { recursive: true });
      const warnings: string[] = [];
      const resolved = await resolveSandboxWorkdir({
        workdir: "/sandbox-root/project",
        sandbox: {
          containerName: "sandbox-3",
          workspaceDir,
          containerWorkdir: "/sandbox-root",
        },
        warnings,
      });

      expect(resolved.hostWorkdir).toBe(nested);
      expect(resolved.containerWorkdir).toBe("/sandbox-root/project");
      expect(warnings).toEqual([]);
    });
  });

  it("maps granted container workdirs outside the workspace root", async () => {
    await withTempDir(async (workspaceDir) => {
      const grantRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-bash-grant-"));
      try {
        const grantedDir = path.join(grantRoot, "repo");
        await mkdir(grantedDir, { recursive: true });
        const warnings: string[] = [];
        const resolved = await resolveSandboxWorkdir({
          workdir: "/grants/projects-ro/repo",
          sandbox: {
            containerName: "sandbox-4",
            workspaceDir,
            containerWorkdir: "/workspace",
            mounts: [
              {
                hostRoot: workspaceDir,
                containerRoot: "/workspace",
                writable: true,
                source: "workspace",
              },
              {
                hostRoot: grantRoot,
                containerRoot: "/grants/projects-ro",
                writable: false,
                source: "bind",
              },
            ],
          },
          warnings,
        });

        expect(resolved.hostWorkdir).toBe(grantedDir);
        expect(resolved.containerWorkdir).toBe("/grants/projects-ro/repo");
        expect(warnings).toEqual([]);
      } finally {
        await rm(grantRoot, { recursive: true, force: true });
      }
    });
  });
});
