import { randomUUID } from "node:crypto";
import type { PrivilegedRequestKind } from "../config/types.privileged.js";
import type { PrivilegedRequestPayload, PrivilegedRequestRecord } from "../privileged/types.js";

const RESOLVED_ENTRY_GRACE_MS = 15_000;

type PendingEntry = {
  record: PrivilegedRequestRecord;
  resolve: (record: PrivilegedRequestRecord) => void;
  timer: ReturnType<typeof setTimeout>;
  promise: Promise<PrivilegedRequestRecord>;
};

export class PrivilegedRequestManager {
  private readonly pending = new Map<string, PendingEntry>();

  create(params: {
    id?: string | null;
    kind: PrivilegedRequestKind;
    justification: string;
    payload: PrivilegedRequestPayload;
    singleUse?: boolean;
    timeoutMs: number;
    requestedBy?: PrivilegedRequestRecord["requestedBy"];
  }): PrivilegedRequestRecord {
    const now = Date.now();
    return {
      id: params.id?.trim() || randomUUID(),
      kind: params.kind,
      createdAtMs: now,
      expiresAtMs: now + params.timeoutMs,
      requestedBy: params.requestedBy,
      justification: params.justification,
      payload: params.payload,
      singleUse: params.singleUse !== false,
      status: "pending",
    };
  }

  register(record: PrivilegedRequestRecord): Promise<PrivilegedRequestRecord> {
    const existing = this.pending.get(record.id);
    if (existing) {
      return existing.promise;
    }
    let resolvePromise!: (record: PrivilegedRequestRecord) => void;
    const promise = new Promise<PrivilegedRequestRecord>((resolve) => {
      resolvePromise = resolve;
    });
    const entry: PendingEntry = {
      record,
      resolve: resolvePromise,
      timer: null as unknown as ReturnType<typeof setTimeout>,
      promise,
    };
    entry.timer = setTimeout(
      () => {
        this.expire(record.id, "auto-expire");
      },
      Math.max(1, record.expiresAtMs - Date.now()),
    );
    this.pending.set(record.id, entry);
    return promise;
  }

  resolve(params: {
    id: string;
    status: "approved" | "denied" | "executed" | "failed";
    resolvedBy?: string | null;
    message?: string;
  }): PrivilegedRequestRecord | null {
    const entry = this.pending.get(params.id);
    if (!entry || entry.record.status !== "pending") {
      return null;
    }
    clearTimeout(entry.timer);
    entry.record.status = params.status;
    entry.record.resolvedAtMs = Date.now();
    entry.record.resolvedBy = params.resolvedBy ?? null;
    entry.record.result = {
      ok: params.status === "approved" || params.status === "executed",
      message: params.message,
    };
    entry.resolve(entry.record);
    setTimeout(() => {
      if (this.pending.get(params.id) === entry) {
        this.pending.delete(params.id);
      }
    }, RESOLVED_ENTRY_GRACE_MS);
    return entry.record;
  }

  expire(id: string, resolvedBy?: string | null): PrivilegedRequestRecord | null {
    const entry = this.pending.get(id);
    if (!entry || entry.record.status !== "pending") {
      return null;
    }
    clearTimeout(entry.timer);
    entry.record.status = "expired";
    entry.record.resolvedAtMs = Date.now();
    entry.record.resolvedBy = resolvedBy ?? null;
    entry.resolve(entry.record);
    setTimeout(() => {
      if (this.pending.get(id) === entry) {
        this.pending.delete(id);
      }
    }, RESOLVED_ENTRY_GRACE_MS);
    return entry.record;
  }

  awaitDecision(id: string): Promise<PrivilegedRequestRecord> | null {
    return this.pending.get(id)?.promise ?? null;
  }

  getSnapshot(id: string): PrivilegedRequestRecord | null {
    return this.pending.get(id)?.record ?? null;
  }

  list(): PrivilegedRequestRecord[] {
    return [...this.pending.values()].map((entry) => entry.record);
  }
}
