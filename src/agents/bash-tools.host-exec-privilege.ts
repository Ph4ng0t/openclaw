import path from "node:path";
import { analyzeShellCommand } from "../infra/exec-approvals-analysis.js";

function normalizeExecutableName(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return path.basename(trimmed).toLowerCase();
}

function segmentHasDeleteTarget(argv: string[]): boolean {
  let operandMode = false;
  for (const arg of argv.slice(1)) {
    const trimmed = arg.trim();
    if (!trimmed) {
      continue;
    }
    if (operandMode) {
      return true;
    }
    if (trimmed === "--") {
      operandMode = true;
      continue;
    }
    if (trimmed.startsWith("-") && trimmed !== "-") {
      continue;
    }
    return true;
  }
  return false;
}

export function isPrivilegedHostExecCommand(params: {
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string | null;
}): boolean {
  const analysis = analyzeShellCommand(params);
  if (!analysis.ok) {
    return false;
  }
  return analysis.segments.some((segment) => {
    const executableName =
      normalizeExecutableName(segment.resolution?.executableName) ??
      normalizeExecutableName(segment.resolution?.rawExecutable) ??
      normalizeExecutableName(segment.argv[0]);
    if (executableName !== "rm") {
      return false;
    }
    return segmentHasDeleteTarget(segment.argv);
  });
}
