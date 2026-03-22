export type CodingTaskResult = {
  status: "completed" | "failed" | "timeout" | "partial";
  summary: string; // ≤500 chars
  filesChanged: string[];
  filesCreated: string[];
  filesDeleted: string[];
  testOutcome: "passed" | "failed" | "skipped" | "unknown";
  testDetails?: string; // ≤200 chars
  errorDetails?: string; // ≤300 chars
  buildOutput?: string; // ≤200 chars
  needsDeployment?: boolean;
  deploymentScript?: string;
  deploymentCommandId?: string;
  deploymentSummary?: string;
  durationMs: number;
};

export const CODING_TASK_RESULT_SCHEMA = {
  type: "object",
  required: [
    "status",
    "summary",
    "filesChanged",
    "filesCreated",
    "filesDeleted",
    "testOutcome",
    "durationMs",
  ],
  properties: {
    status: { type: "string", enum: ["completed", "failed", "timeout", "partial"] },
    summary: { type: "string" },
    filesChanged: { type: "array", items: { type: "string" } },
    filesCreated: { type: "array", items: { type: "string" } },
    filesDeleted: { type: "array", items: { type: "string" } },
    testOutcome: { type: "string", enum: ["passed", "failed", "skipped", "unknown"] },
    testDetails: { type: "string" },
    errorDetails: { type: "string" },
    buildOutput: { type: "string" },
    needsDeployment: { type: "boolean" },
    deploymentScript: { type: "string" },
    deploymentCommandId: { type: "string" },
    deploymentSummary: { type: "string" },
    durationMs: { type: "number" },
  },
  additionalProperties: false,
} as const;
