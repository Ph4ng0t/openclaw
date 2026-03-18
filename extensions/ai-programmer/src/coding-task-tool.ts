import { randomBytes } from "node:crypto";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "../../../src/plugins/types.js";
import { fallbackResult, summarizeCodingTask } from "./summarizer.js";
import type { CodingTaskResult } from "./types.js";

const DEFAULT_CODEX_AGENT = "codex";
const DEFAULT_CODEX_TIMEOUT_MS = 300_000; // 5 minutes
const DEFAULT_SUMMARIZER_TIMEOUT_MS = 60_000;
const DEFAULT_WORKSPACE_DIR = "/home/lawliet/projects/AutoCompany/AI-Programmer";

type PluginCfg = {
  codexAgent?: string;
  summarizerProvider?: string;
  summarizerModel?: string;
  codexTimeoutMs?: number;
  summarizerTimeoutMs?: number;
  maxSummaryChars?: number;
};

// Minimal interface for the AcpxRuntime we need (avoids importing the full type)
type MinimalAcpEvent = {
  type: string;
  text?: string;
  stream?: string;
  message?: string;
};

type MinimalAcpHandle = Record<string, unknown>;

type MinimalAcpRuntime = {
  ensureSession(input: {
    sessionKey: string;
    agent: string;
    cwd: string;
    mode: "oneshot" | "persistent";
  }): Promise<MinimalAcpHandle>;
  runTurn(input: {
    handle: MinimalAcpHandle;
    text: string;
    signal?: AbortSignal;
  }): AsyncIterable<MinimalAcpEvent>;
  close(input: { handle: MinimalAcpHandle; reason: string }): Promise<void>;
};

type AcpxRuntimeConstructor = new (
  config: Record<string, unknown>,
  opts?: { logger?: unknown },
) => MinimalAcpRuntime;

type ResolveAcpxPluginConfigFn = (params: {
  rawConfig: unknown;
  workspaceDir?: string;
}) => Record<string, unknown>;

async function loadAcpxRuntime(): Promise<{
  AcpxRuntime: AcpxRuntimeConstructor;
  resolveAcpxPluginConfig: ResolveAcpxPluginConfigFn;
}> {
  // Dynamic import — resolves from source checkout or built install
  // oxlint-disable-next-line typescript/no-explicit-any
  const runtimeMod = (await import("../../acpx/src/runtime.js")) as any;
  // oxlint-disable-next-line typescript/no-explicit-any
  const configMod = (await import("../../acpx/src/config.js")) as any;
  if (typeof runtimeMod.AcpxRuntime !== "function") {
    throw new Error("AcpxRuntime not available — ensure the acpx plugin is installed");
  }
  if (typeof configMod.resolveAcpxPluginConfig !== "function") {
    throw new Error("resolveAcpxPluginConfig not available");
  }
  return {
    AcpxRuntime: runtimeMod.AcpxRuntime as AcpxRuntimeConstructor,
    resolveAcpxPluginConfig: configMod.resolveAcpxPluginConfig as ResolveAcpxPluginConfigFn,
  };
}

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
        workspaceDir: Type.Optional(
          Type.String({ description: "Workspace directory for codex to operate in." }),
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

      const workspaceDir =
        (typeof params.workspaceDir === "string" && params.workspaceDir.trim()) ||
        DEFAULT_WORKSPACE_DIR;

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

      const agentName = pluginCfg.codexAgent?.trim() || DEFAULT_CODEX_AGENT;

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

      let acpxRuntime: MinimalAcpRuntime;
      try {
        const { AcpxRuntime, resolveAcpxPluginConfig } = await loadAcpxRuntime();
        const resolvedConfig = resolveAcpxPluginConfig({
          rawConfig: {
            permissionMode: "approve-all",
            nonInteractivePermissions: "deny",
            // Pass timeout to acpx as a belt-and-suspenders guard alongside AbortController
            timeoutSeconds: Math.ceil(codexTimeoutMs / 1000) + 10,
          },
          workspaceDir,
        });
        acpxRuntime = new AcpxRuntime(resolvedConfig);
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(buildErrorResult(err, Date.now() - startTime), null, 2),
            },
          ],
        };
      }

      // Unique session name per invocation for isolation
      const sessionKey = `ai-programmer-${Date.now()}-${randomHex(6)}`;
      let handle: MinimalAcpHandle | null = null;

      try {
        handle = await acpxRuntime.ensureSession({
          sessionKey,
          agent: agentName,
          cwd: workspaceDir,
          mode: "oneshot",
        });
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(buildErrorResult(err, Date.now() - startTime), null, 2),
            },
          ],
        };
      }

      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, codexTimeoutMs);

      const textParts: string[] = [];
      let errorMessage = "";

      try {
        for await (const event of acpxRuntime.runTurn({
          handle,
          text: fullTask,
          signal: controller.signal,
        })) {
          if (event.type === "text_delta" && event.stream === "output") {
            textParts.push(typeof event.text === "string" ? event.text : "");
          } else if (event.type === "error" && typeof event.message === "string") {
            // Capture error message but continue collecting any remaining output
            errorMessage = event.message;
          }
        }
      } catch (err) {
        if (!timedOut) {
          errorMessage = err instanceof Error ? err.message : String(err ?? "");
        }
      } finally {
        clearTimeout(timer);
        // Always close the session to release resources
        try {
          await acpxRuntime.close({ handle, reason: "task-complete" });
        } catch {
          // Ignore close errors
        }
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
        };
      }

      const rawOutput = textParts.join("");

      // If codex produced no output and reported an error, return structured failure
      if (!rawOutput && errorMessage) {
        const result = fallbackResult(durationMs, errorMessage.slice(0, 300));
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
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

      return {
        content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
        details: { result: summary },
      };
    },
  };
}
