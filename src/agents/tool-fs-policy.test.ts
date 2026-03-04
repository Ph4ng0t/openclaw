import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  createToolFsPolicy,
  isToolFsPathAllowed,
  resolveEffectiveToolFsWorkspaceOnly,
  resolveToolFsConfig,
} from "./tool-fs-policy.js";

describe("resolveEffectiveToolFsWorkspaceOnly", () => {
  it("returns false by default when tools.fs.workspaceOnly is unset", () => {
    expect(resolveEffectiveToolFsWorkspaceOnly({ cfg: {}, agentId: "main" })).toBe(false);
  });

  it("uses global tools.fs.workspaceOnly when no agent override exists", () => {
    const cfg: OpenClawConfig = {
      tools: { fs: { workspaceOnly: true } },
    };
    expect(resolveEffectiveToolFsWorkspaceOnly({ cfg, agentId: "main" })).toBe(true);
  });

  it("prefers agent-specific tools.fs.workspaceOnly override over global setting", () => {
    const cfg: OpenClawConfig = {
      tools: { fs: { workspaceOnly: true } },
      agents: {
        list: [
          {
            id: "main",
            tools: {
              fs: { workspaceOnly: false },
            },
          },
        ],
      },
    };
    expect(resolveEffectiveToolFsWorkspaceOnly({ cfg, agentId: "main" })).toBe(false);
  });

  it("supports agent-specific enablement when global workspaceOnly is off", () => {
    const cfg: OpenClawConfig = {
      tools: { fs: { workspaceOnly: false } },
      agents: {
        list: [
          {
            id: "main",
            tools: {
              fs: { workspaceOnly: true },
            },
          },
        ],
      },
    };
    expect(resolveEffectiveToolFsWorkspaceOnly({ cfg, agentId: "main" })).toBe(true);
  });

  it("resolves grants from agent override", () => {
    const cfg: OpenClawConfig = {
      tools: { fs: { grants: [{ path: "/tmp/global", access: "ro" }] } },
      agents: {
        list: [
          {
            id: "main",
            tools: {
              fs: { grants: [{ path: "/tmp/agent", access: "rw" }] },
            },
          },
        ],
      },
    };
    expect(resolveToolFsConfig({ cfg, agentId: "main" }).grants).toEqual([
      { path: "/tmp/agent", access: "rw" },
    ]);
  });
});

describe("createToolFsPolicy", () => {
  it("allows reads from granted roots and writes only to rw grants", () => {
    const policy = createToolFsPolicy({
      workspaceOnly: true,
      workspaceRoot: "/workspace",
      grants: [
        { path: "/grants/ro", access: "ro" },
        { path: "/grants/rw", access: "rw" },
      ],
    });

    expect(isToolFsPathAllowed(policy, "/workspace/file.ts", "read")).toBe(true);
    expect(isToolFsPathAllowed(policy, "/grants/ro/doc.txt", "read")).toBe(true);
    expect(isToolFsPathAllowed(policy, "/grants/ro/doc.txt", "write")).toBe(false);
    expect(isToolFsPathAllowed(policy, "/grants/rw/doc.txt", "write")).toBe(true);
    expect(isToolFsPathAllowed(policy, "/outside/doc.txt", "read")).toBe(false);
  });
});
