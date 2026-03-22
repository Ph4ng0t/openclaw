import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "../../../src/plugins/types.js";
import { startDockerSandbox, stopDockerSandbox, type FsGrant } from "./docker-sandbox.js";
import { fallbackResult, summarizeCodingTask } from "./summarizer.js";
import type { CodingTaskResult } from "./types.js";

const DEFAULT_CODEX_COMMAND = "codex";
const DEFAULT_SANDBOX_IMAGE = "ai-programmer-sandbox:latest";
const DEFAULT_CODEX_TIMEOUT_MS = 300_000; // 5 minutes
const DEFAULT_SUMMARIZER_TIMEOUT_MS = 60_000;
const DEFAULT_AI_PROGRAMMER_WORKSPACE = path.join(
  os.homedir(),
  ".openclaw",
  "workspace",
  "ai-programmer",
);
const MAX_PROJECT_NAME_LENGTH = 48;

type SandboxCfg = {
  enabled?: boolean;
  // Retained for backward-compatible config parsing. The tool now runs the host
  // Codex CLI directly because codex-acp's OAuth streaming path is unstable in
  // this environment.
  image?: string;
  codexAuthDir?: string;
  command?: string;
  proxy?: {
    httpProxy?: string;
    httpsProxy?: string;
    allProxy?: string;
    noProxy?: string;
  };
  useHostNetwork?: boolean;
};

type PluginCfg = {
  codexCommand?: string;
  workspaceDir?: string;
  allowTaskWorkspaceOverride?: boolean;
  summarizerProvider?: string;
  summarizerModel?: string;
  codexTimeoutMs?: number;
  summarizerTimeoutMs?: number;
  maxSummaryChars?: number;
  sandbox?: SandboxCfg;
};

type CodexLaunchTarget = {
  command: string;
  bypassInnerSandbox?: boolean;
  cleanup?: () => Promise<void>;
};

const AI_PROGRAMMER_DEPLOY_SCRIPT = "scripts/deploy-ai-programmer.sh";
const AI_PROGRAMMER_DEPLOY_COMMAND_ID = "openclaw.deploy.ai-programmer";

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function toModelKey(provider?: string, model?: string): { provider: string; model: string } | null {
  const p = provider?.trim();
  const m = model?.trim();
  if (!p || !m) return null;
  return { provider: p, model: m };
}

function resolveDefaultModel(config: unknown): { provider: string; model: string } | null {
  // oxlint-disable-next-line typescript/no-explicit-any
  const agents = (config as any)?.agents;
  const defaultsModel = agents?.defaults?.model;
  if (typeof defaultsModel === "string") {
    const parts = defaultsModel.trim().split("/");
    if (parts.length >= 2) {
      return { provider: parts[0] ?? "", model: parts.slice(1).join("/") };
    }
  }
  if (typeof defaultsModel === "object" && defaultsModel !== null) {
    const primary = (defaultsModel as Record<string, unknown>).primary;
    if (typeof primary === "string") {
      const parts = primary.trim().split("/");
      if (parts.length >= 2) {
        return { provider: parts[0] ?? "", model: parts.slice(1).join("/") };
      }
    }
  }
  return null;
}

function buildTimeoutResult(durationMs: number): CodingTaskResult {
  return {
    status: "timeout",
    summary: "Codex exceeded the configured timeout.",
    filesChanged: [],
    filesCreated: [],
    filesDeleted: [],
    testOutcome: "unknown",
    durationMs,
  };
}

function buildErrorResult(err: unknown, durationMs: number): CodingTaskResult {
  const msg = err instanceof Error ? err.message : String(err ?? "unknown error");
  return fallbackResult(durationMs, msg.slice(0, 300));
}

function createTempFile(prefix: string, suffix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${randomHex(6)}${suffix}`);
}

function resolveWorkspaceRoot(
  paramsWorkspaceDir: unknown,
  pluginWorkspaceDir: unknown,
  allowTaskWorkspaceOverride?: boolean,
): string {
  if (
    allowTaskWorkspaceOverride &&
    typeof paramsWorkspaceDir === "string" &&
    paramsWorkspaceDir.trim()
  ) {
    return paramsWorkspaceDir.trim();
  }
  if (typeof pluginWorkspaceDir === "string" && pluginWorkspaceDir.trim()) {
    return pluginWorkspaceDir.trim();
  }
  return DEFAULT_AI_PROGRAMMER_WORKSPACE;
}

function slugifyProjectName(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_PROJECT_NAME_LENGTH);
  return slug || "project";
}

function inferProjectNameFromTask(task: string): string {
  return slugifyProjectName(task.replace(/\s+/g, " ").trim().slice(0, 80));
}

function buildGeneratedProjectName(task: string): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14);
  return `${stamp}-${inferProjectNameFromTask(task)}`;
}

function resolveProjectDir(params: {
  workspaceRoot: string;
  task: string;
  projectName?: unknown;
}): { projectDir: string; projectName: string } {
  const explicitProjectName =
    typeof params.projectName === "string" && params.projectName.trim()
      ? slugifyProjectName(params.projectName.trim())
      : "";
  const projectName = explicitProjectName || buildGeneratedProjectName(params.task);
  return {
    projectDir: path.join(params.workspaceRoot, projectName),
    projectName,
  };
}

async function ensureProjectTemplate(projectDir: string, projectName: string): Promise<void> {
  const memoryDir = path.join(projectDir, "memory");
  await fs.mkdir(memoryDir, { recursive: true });

  const templateFiles = [
    {
      path: path.join(projectDir, "AGENTS.md"),
      content: `# ${projectName}

Project rules:
- Read \`memory/current.md\` before making changes.
- Record durable technical decisions in \`memory/decisions.md\`.
- Record pending follow-up work in \`memory/todo.md\`.
- Keep \`memory/current.md\` focused on the latest project state.
`,
    },
    {
      path: path.join(memoryDir, "current.md"),
      content: `# Current State

- Project initialized.
- Update this file with the latest architecture, active goals, and important constraints.
`,
    },
    {
      path: path.join(memoryDir, "decisions.md"),
      content: `# Decisions

- Record durable technical decisions here with brief rationale.
`,
    },
    {
      path: path.join(memoryDir, "todo.md"),
      content: `# Todo

- Record pending tasks, follow-ups, and verification gaps here.
`,
    },
  ];

  for (const file of templateFiles) {
    const exists = await fs
      .access(file.path)
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      await fs.writeFile(file.path, file.content, "utf8");
    }
  }
}

type CodexRunRecord = {
  executor: "codex-cli";
  codexCommand: string;
  workspaceDir: string;
  status: "invoked" | "started" | "completed" | "failed" | "timed_out";
  startedAt: string;
  finishedAt?: string;
  rawOutputBytes?: number;
  errorMessage?: string;
};

async function writeRunRecord(workspaceDir: string, record: CodexRunRecord): Promise<void> {
  const runStateDir = path.join(workspaceDir, ".openclaw", "ai-programmer");
  const runStatePath = path.join(runStateDir, "last-run.json");
  await fs.mkdir(runStateDir, { recursive: true });
  await fs.writeFile(runStatePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

async function writeRunRawOutput(workspaceDir: string, rawOutput: string): Promise<void> {
  const runStateDir = path.join(workspaceDir, ".openclaw", "ai-programmer");
  const runOutputPath = path.join(runStateDir, "last-run-output.txt");
  await fs.mkdir(runStateDir, { recursive: true });
  await fs.writeFile(runOutputPath, rawOutput, "utf8");
}

async function writeRunError(workspaceDir: string, errorText: string): Promise<void> {
  const runStateDir = path.join(workspaceDir, ".openclaw", "ai-programmer");
  const runErrorPath = path.join(runStateDir, "last-run-error.txt");
  await fs.mkdir(runStateDir, { recursive: true });
  await fs.writeFile(runErrorPath, errorText, "utf8");
}

function annotateDeployment(summary: CodingTaskResult): CodingTaskResult {
  const touched = new Set([
    ...summary.filesChanged,
    ...summary.filesCreated,
    ...summary.filesDeleted,
  ]);
  const touchesAiProgrammer =
    Array.from(touched).some((file) => file.startsWith("extensions/ai-programmer/")) ||
    touched.has(AI_PROGRAMMER_DEPLOY_SCRIPT);
  if (!touchesAiProgrammer) {
    return summary;
  }

  const needsImageRebuild = Array.from(touched).some(
    (file) => file === "extensions/ai-programmer/Dockerfile.sandbox",
  );
  const deploymentSummary = needsImageRebuild
    ? "ai-programmer changed extension code and sandbox image inputs; request owner approval through the OpenClaw privileged gate to run the ai-programmer deploy command (rebuild image + restart gateway)."
    : "ai-programmer changed extension code; request owner approval through the OpenClaw privileged gate to run the ai-programmer deploy command (restart gateway, image rebuild optional).";

  return {
    ...summary,
    needsDeployment: true,
    deploymentScript: AI_PROGRAMMER_DEPLOY_SCRIPT,
    deploymentCommandId: AI_PROGRAMMER_DEPLOY_COMMAND_ID,
    deploymentSummary,
  };
}

async function runCodexTask(params: {
  prompt: string;
  workspaceDir: string;
  timeoutMs: number;
  launchCommand: string;
  bypassInnerSandbox?: boolean;
}): Promise<{
  timedOut: boolean;
  rawOutput: string;
  errorMessage: string;
}> {
  const startedAt = new Date().toISOString();
  const lastMessagePath = createTempFile("ai-programmer-codex-last", ".txt");
  const args = params.bypassInnerSandbox
    ? [
        "--dangerously-bypass-approvals-and-sandbox",
        "exec",
        "--json",
        "-C",
        params.workspaceDir,
        "--skip-git-repo-check",
        "-o",
        lastMessagePath,
        "-",
      ]
    : [
        "-a",
        "never",
        "exec",
        "-s",
        "workspace-write",
        "--json",
        "-C",
        params.workspaceDir,
        "--skip-git-repo-check",
        "-o",
        lastMessagePath,
        "-",
      ];

  let stdout = "";
  let stderr = "";
  let timedOut = false;

  try {
    await writeRunRecord(params.workspaceDir, {
      executor: "codex-cli",
      codexCommand: params.launchCommand,
      workspaceDir: params.workspaceDir,
      status: "started",
      startedAt,
    }).catch(() => {});

    await new Promise<void>((resolve, reject) => {
      const child = spawn(params.launchCommand, args, {
        cwd: params.workspaceDir,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
      }, params.timeoutMs);

      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (timedOut) {
          resolve();
          return;
        }
        if (code === 0) {
          resolve();
          return;
        }
        const suffix = signal ? ` (signal ${signal})` : code != null ? ` (exit ${code})` : "";
        reject(
          new Error(`codex exec failed${suffix}: ${(stderr || stdout).trim() || "no output"}`),
        );
      });

      child.stdin.end(params.prompt);
    });

    const lastMessage = await fs.readFile(lastMessagePath, "utf8").catch(() => "");
    const rawOutput = [stdout.trim(), stderr.trim(), lastMessage.trim()]
      .filter(Boolean)
      .join("\n\n");
    await writeRunRawOutput(params.workspaceDir, rawOutput).catch(() => {});
    await writeRunRecord(params.workspaceDir, {
      executor: "codex-cli",
      codexCommand: params.launchCommand,
      workspaceDir: params.workspaceDir,
      status: timedOut ? "timed_out" : "completed",
      startedAt,
      finishedAt: new Date().toISOString(),
      rawOutputBytes: Buffer.byteLength(rawOutput, "utf8"),
      ...(stderr.trim() ? { errorMessage: stderr.trim().slice(0, 500) } : {}),
    }).catch(() => {});
    return {
      timedOut,
      rawOutput,
      errorMessage: stderr.trim(),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err ?? "unknown error");
    await writeRunRecord(params.workspaceDir, {
      executor: "codex-cli",
      codexCommand: params.launchCommand,
      workspaceDir: params.workspaceDir,
      status: "failed",
      startedAt,
      finishedAt: new Date().toISOString(),
      errorMessage: message.slice(0, 500),
    }).catch(() => {});
    throw err;
  } finally {
    await fs.rm(lastMessagePath, { force: true }).catch(() => {});
  }
}

export function createCodingTaskTool(api: OpenClawPluginApi, ctx?: OpenClawPluginToolContext) {
  const agentDir = ctx?.agentDir;
  return {
    name: "ai-programmer",
    label: "AI Programmer",
    description:
      "Run a coding task via codex and return a compact structured result (status, summary, filesChanged, testOutcome). All verbosity from codex stays internal — only compact JSON is returned. Use for all coding/programming tasks.",
    parameters: Type.Object(
      {
        task: Type.String({ description: "Coding task description for codex." }),
        projectName: Type.Optional(
          Type.String({
            description:
              "Optional project name under the ai-programmer workspace root. When omitted, ai-programmer creates a new project directory and seeds it with AGENTS.md and memory templates.",
          }),
        ),
        workspaceDir: Type.Optional(
          Type.String({
            description:
              "Optional workspace root override for ai-programmer projects. When enabled in plugin config, ai-programmer creates or reuses a project directory inside this root.",
          }),
        ),
        timeoutMs: Type.Optional(
          Type.Integer({ description: "Codex timeout in milliseconds (default: 300000)." }),
        ),
        context: Type.Optional(
          Type.String({ description: "Optional extra context to append to the task." }),
        ),
      },
      { additionalProperties: false },
    ),

    async execute(_id: string, params: Record<string, unknown>) {
      const task = typeof params.task === "string" ? params.task.trim() : "";
      if (!task) {
        throw new Error("task is required");
      }

      const pluginCfg = (api.pluginConfig ?? {}) as PluginCfg;

      const workspaceRoot = resolveWorkspaceRoot(
        params.workspaceDir,
        pluginCfg.workspaceDir,
        pluginCfg.allowTaskWorkspaceOverride === true,
      );
      await fs.mkdir(workspaceRoot, { recursive: true });
      const { projectDir: workspaceDir, projectName } = resolveProjectDir({
        workspaceRoot,
        task,
        projectName: params.projectName,
      });
      await fs.mkdir(workspaceDir, { recursive: true });
      await ensureProjectTemplate(workspaceDir, projectName);

      const codexTimeoutMs =
        (typeof params.timeoutMs === "number" && params.timeoutMs > 0 ? params.timeoutMs : null) ??
        (typeof pluginCfg.codexTimeoutMs === "number" && pluginCfg.codexTimeoutMs > 0
          ? pluginCfg.codexTimeoutMs
          : null) ??
        DEFAULT_CODEX_TIMEOUT_MS;

      const summarizerTimeoutMs =
        (typeof pluginCfg.summarizerTimeoutMs === "number" && pluginCfg.summarizerTimeoutMs > 0
          ? pluginCfg.summarizerTimeoutMs
          : null) ?? DEFAULT_SUMMARIZER_TIMEOUT_MS;

      const sandboxCfg = pluginCfg.sandbox;
      const sandboxEnabled = sandboxCfg?.enabled !== false;
      const codexCommand = pluginCfg.codexCommand?.trim() || DEFAULT_CODEX_COMMAND;
      const startedAt = new Date().toISOString();
      await writeRunRecord(workspaceDir, {
        executor: "codex-cli",
        codexCommand,
        workspaceDir,
        status: "invoked",
        startedAt,
      }).catch(() => {});

      // Resolve summarizer provider/model from plugin config or global defaults
      const summarizerModel =
        toModelKey(pluginCfg.summarizerProvider, pluginCfg.summarizerModel) ??
        resolveDefaultModel(api.config);
      if (!summarizerModel) {
        throw new Error(
          "ai-programmer: summarizerProvider/summarizerModel not configured and no default model found in config",
        );
      }

      const context = typeof params.context === "string" ? params.context.trim() : "";
      const fullTask = context ? `${task}\n\nAdditional context:\n${context}` : task;

      const startTime = Date.now();
      let timedOut = false;
      let rawOutput = "";
      let errorMessage = "";
      let launchTarget: CodexLaunchTarget | null = null;
      try {
        if (sandboxEnabled) {
          // oxlint-disable-next-line typescript/no-explicit-any
          const fsGrants = ((api.config as any)?.tools?.fs?.grants ?? []) as FsGrant[];
          const sandboxHandle = await startDockerSandbox({
            image: sandboxCfg?.image?.trim() || DEFAULT_SANDBOX_IMAGE,
            workspaceDir,
            fsGrants,
            codexAuthDir: sandboxCfg?.codexAuthDir,
            sandboxCommand: sandboxCfg?.command?.trim() || "codex",
            proxyOverrides: sandboxCfg?.proxy,
            useHostNetwork: sandboxCfg?.useHostNetwork,
          });
          launchTarget = {
            command: sandboxHandle.wrapperScriptPath,
            bypassInnerSandbox: true,
            cleanup: async () => stopDockerSandbox(sandboxHandle),
          };
        } else {
          launchTarget = { command: codexCommand, bypassInnerSandbox: false };
        }
        const result = await runCodexTask({
          prompt: fullTask,
          workspaceDir,
          timeoutMs: codexTimeoutMs,
          launchCommand: launchTarget.command,
          bypassInnerSandbox: launchTarget.bypassInnerSandbox,
        });
        timedOut = result.timedOut;
        rawOutput = result.rawOutput;
        errorMessage = result.errorMessage;
      } catch (err) {
        const errorText = err instanceof Error ? err.message : String(err ?? "unknown error");
        await writeRunError(workspaceDir, errorText).catch(() => {});
        await writeRunRecord(workspaceDir, {
          executor: "codex-cli",
          codexCommand,
          workspaceDir,
          status: "failed",
          startedAt,
          finishedAt: new Date().toISOString(),
          errorMessage: errorText.slice(0, 500),
        }).catch(() => {});
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ...buildErrorResult(err, Date.now() - startTime),
                  errorDetails: errorText,
                },
                null,
                2,
              ),
            },
          ],
          details: { executor: "codex-cli", codexCommand, workspaceDir },
        };
      } finally {
        await launchTarget?.cleanup?.().catch(() => {});
      }

      const durationMs = Date.now() - startTime;

      if (timedOut) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(buildTimeoutResult(durationMs), null, 2),
            },
          ],
          details: { executor: "codex-cli", codexCommand, workspaceDir },
        };
      }

      // If codex produced no output and reported an error, return structured failure
      if (!rawOutput && errorMessage) {
        const result = fallbackResult(durationMs, errorMessage.slice(0, 300));
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: { executor: "codex-cli", codexCommand, workspaceDir },
        };
      }

      // Summarize — all codex verbosity stays in plugin memory, only compact JSON returned
      const summary = await summarizeCodingTask(rawOutput, {
        provider: summarizerModel.provider,
        model: summarizerModel.model,
        workspaceDir,
        timeoutMs: summarizerTimeoutMs,
        config: api.config,
        agentDir,
      });

      // Fill in actual duration (summarizer sets durationMs=0 per schema contract)
      summary.durationMs = durationMs;
      const annotatedSummary = annotateDeployment(summary);

      return {
        content: [{ type: "text", text: JSON.stringify(annotatedSummary, null, 2) }],
        details: {
          result: annotatedSummary,
          executor: "codex-cli",
          codexCommand,
          workspaceDir,
        },
      };
    },
  };
}
