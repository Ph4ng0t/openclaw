import fs from "node:fs/promises";
import path from "node:path";
import Ajv from "ajv";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk";
import { CODING_TASK_RESULT_SCHEMA, type CodingTaskResult } from "./types.js";

// NOTE: same dynamic import pattern as llm-task — src-first, dist-fallback.
type RunEmbeddedPiAgentFn = (params: Record<string, unknown>) => Promise<unknown>;

async function loadRunEmbeddedPiAgent(): Promise<RunEmbeddedPiAgentFn> {
  try {
    const mod = await import("../../../src/agents/pi-embedded-runner.js");
    // oxlint-disable-next-line typescript/no-explicit-any
    if (typeof (mod as any).runEmbeddedPiAgent === "function") {
      // oxlint-disable-next-line typescript/no-explicit-any
      return (mod as any).runEmbeddedPiAgent;
    }
  } catch {
    // ignore — fall through to second attempt
  }
  const mod = await import("../../../src/agents/pi-embedded-runner.js");
  if (typeof mod.runEmbeddedPiAgent !== "function") {
    throw new Error("Internal error: runEmbeddedPiAgent not available");
  }
  return mod.runEmbeddedPiAgent as RunEmbeddedPiAgentFn;
}

function stripCodeFences(s: string): string {
  const trimmed = s.trim();
  const m = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return m ? (m[1] ?? "").trim() : trimmed;
}

function collectText(payloads: Array<{ text?: string; isError?: boolean }> | undefined): string {
  return (payloads ?? [])
    .filter((p) => !p.isError && typeof p.text === "string")
    .map((p) => p.text ?? "")
    .join("\n")
    .trim();
}

const SUMMARIZER_SYSTEM_PROMPT = [
  "You are a JSON-only extractor.",
  "Read the coding session output below and extract a CodingTaskResult.",
  "Return ONLY valid JSON. No markdown fences. No commentary. No extra keys.",
  "Schema: { status: 'completed'|'failed'|'timeout'|'partial', summary: string (≤500 chars),",
  "filesChanged: string[], filesCreated: string[], filesDeleted: string[],",
  "testOutcome: 'passed'|'failed'|'skipped'|'unknown', testDetails?: string (≤200 chars),",
  "errorDetails?: string (≤300 chars), buildOutput?: string (≤200 chars), durationMs: 0 }",
  "Set durationMs to 0 (caller fills in actual value).",
  "status=completed when the task finished successfully, partial when partially done, failed when it errored or did not finish.",
].join(" ");

export type SummarizerParams = {
  provider: string;
  model: string;
  authProfileId?: string;
  workspaceDir: string;
  timeoutMs: number;
  config: unknown;
};

export function fallbackResult(durationMs: number, errorDetails?: string): CodingTaskResult {
  return {
    status: "failed",
    summary: "(summary unavailable)",
    filesChanged: [],
    filesCreated: [],
    filesDeleted: [],
    testOutcome: "unknown",
    ...(errorDetails ? { errorDetails: errorDetails.slice(0, 300) } : {}),
    durationMs,
  };
}

export async function summarizeCodingTask(
  rawOutput: string,
  params: SummarizerParams,
): Promise<CodingTaskResult> {
  const maxOutputChars = 50_000;
  const truncated =
    rawOutput.length > maxOutputChars
      ? rawOutput.slice(rawOutput.length - maxOutputChars)
      : rawOutput;

  const fullPrompt = `${SUMMARIZER_SYSTEM_PROMPT}\n\nCODING SESSION OUTPUT:\n${truncated}\n`;

  let tmpDir: string | null = null;
  try {
    tmpDir = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "openclaw-ai-programmer-"),
    );
    const sessionId = `ai-programmer-summarizer-${Date.now()}`;
    const sessionFile = path.join(tmpDir, "session.json");

    const runEmbeddedPiAgent = await loadRunEmbeddedPiAgent();

    const result = await runEmbeddedPiAgent({
      sessionId,
      sessionFile,
      workspaceDir: params.workspaceDir,
      config: params.config,
      prompt: fullPrompt,
      timeoutMs: params.timeoutMs,
      runId: `ai-programmer-summarizer-${Date.now()}`,
      provider: params.provider,
      model: params.model,
      ...(params.authProfileId ? { authProfileId: params.authProfileId } : {}),
      authProfileIdSource: params.authProfileId ? "user" : "auto",
      disableTools: true,
    });

    // oxlint-disable-next-line typescript/no-explicit-any
    const text = collectText((result as any).payloads);
    if (!text) {
      return fallbackResult(0, "summarizer returned empty output");
    }

    const raw = stripCodeFences(text);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return fallbackResult(0, "summarizer returned invalid JSON");
    }

    const ajv = new Ajv.default({ allErrors: true, strict: false });
    // oxlint-disable-next-line typescript/no-explicit-any
    const validate = ajv.compile(CODING_TASK_RESULT_SCHEMA as any);
    const ok = validate(parsed);
    if (!ok) {
      return fallbackResult(0, "summarizer JSON did not match schema");
    }

    return parsed as CodingTaskResult;
  } catch {
    return fallbackResult(0, "summarizer failed");
  } finally {
    if (tmpDir) {
      try {
        await fs.rm(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
}
