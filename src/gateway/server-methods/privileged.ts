import { executePrivilegedRequest } from "../../privileged/executor.js";
import type { PrivilegedRequestManager } from "../privileged-request-manager.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

const DEFAULT_PRIVILEGED_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;

function trimString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function createPrivilegedHandlers(
  manager: PrivilegedRequestManager,
): GatewayRequestHandlers {
  return {
    "privileged.request": async ({ params, respond, context }) => {
      const p = params;
      const kind = trimString(p.kind);
      const justification = trimString(p.justification);
      if (!kind || !justification) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "kind and justification are required"),
        );
        return;
      }
      const timeoutMs =
        typeof p.timeoutMs === "number" && Number.isFinite(p.timeoutMs)
          ? Math.max(1_000, Math.floor(p.timeoutMs))
          : DEFAULT_PRIVILEGED_REQUEST_TIMEOUT_MS;
      const record = manager.create({
        id: trimString(p.id) ?? null,
        kind: kind as never,
        justification,
        payload:
          p.payload && typeof p.payload === "object" && !Array.isArray(p.payload)
            ? (p.payload as Record<string, unknown>)
            : {},
        singleUse: p.singleUse !== false,
        timeoutMs,
        requestedBy:
          p.requestedBy && typeof p.requestedBy === "object" && !Array.isArray(p.requestedBy)
            ? (p.requestedBy as Record<string, string>)
            : undefined,
      });
      await manager.register(record);
      context.broadcast(
        "privileged.requested",
        {
          id: record.id,
          kind: record.kind,
          justification: record.justification,
          payload: record.payload,
          createdAtMs: record.createdAtMs,
          expiresAtMs: record.expiresAtMs,
          requestedBy: record.requestedBy,
        },
        { dropIfSlow: true },
      );
      respond(true, {
        status: "accepted",
        id: record.id,
        createdAtMs: record.createdAtMs,
        expiresAtMs: record.expiresAtMs,
      });
    },
    "privileged.waitDecision": async ({ params, respond }) => {
      const id = trimString(params.id);
      if (!id) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "id is required"));
        return;
      }
      const decisionPromise = manager.awaitDecision(id);
      if (!decisionPromise) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "request expired or not found"),
        );
        return;
      }
      const record = await decisionPromise;
      respond(true, record);
    },
    "privileged.resolve": async ({ params, respond, context }) => {
      const p = params;
      const id = trimString(p.id);
      const decision = trimString(p.decision);
      if (!id || !decision || !["approve", "deny"].includes(decision)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "id and decision=approve|deny are required"),
        );
        return;
      }
      if (decision === "deny") {
        const record = manager.resolve({
          id,
          status: "denied",
          resolvedBy: trimString(p.resolvedBy),
        });
        if (!record) {
          respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "request not found"));
          return;
        }
        context.broadcast("privileged.resolved", record, { dropIfSlow: true });
        respond(true, record);
        return;
      }
      const approved = manager.resolve({
        id,
        status: "approved",
        resolvedBy: trimString(p.resolvedBy),
      });
      if (!approved) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "request not found"));
        return;
      }
      try {
        const message = await executePrivilegedRequest(approved);
        const executed = manager.getSnapshot(id);
        if (executed) {
          executed.status = "executed";
          executed.result = { ok: true, message };
        }
        const finalRecord = executed ?? approved;
        context.broadcast("privileged.resolved", finalRecord, { dropIfSlow: true });
        respond(true, finalRecord);
      } catch (error) {
        const failed = manager.getSnapshot(id);
        if (failed) {
          failed.status = "failed";
          failed.result = { ok: false, message: String(error) };
        }
        const finalRecord = failed ?? approved;
        context.broadcast("privileged.resolved", finalRecord, { dropIfSlow: true });
        respond(true, finalRecord);
      }
    },
    "privileged.list": ({ respond }) => {
      respond(true, { requests: manager.list() });
    },
  };
}
