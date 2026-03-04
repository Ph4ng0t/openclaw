import { describe, expect, it } from "vitest";
import { buildPendingCard, buildResolvedCard, resolveApproverIds } from "./privileged-approvals.js";

describe("feishu privileged approvals", () => {
  it("builds a pending approval card with approve and deny buttons", () => {
    const card = buildPendingCard({
      id: "req-1",
      kind: "fs_grant",
      status: "pending",
      justification: "Grant repo access",
      createdAtMs: 1,
      expiresAtMs: 2,
      payload: { path: "/tmp/project", access: "rw" },
      requestedBy: { channel: "feishu", senderId: "ou-owner", sessionKey: "agent:main:feishu" },
    });
    expect(card.schema).toBe("2.0");
    const body = card.body as { elements?: Array<Record<string, unknown>> } | undefined;
    const buttons = body?.elements?.filter((element) => element.tag === "button");
    expect(buttons).toHaveLength(2);
    expect(buttons?.[0]).toMatchObject({
      tag: "button",
      element_id: "privileged-approve-req-1",
      behaviors: [{ type: "callback", value: { command: "/approve req-1 approve" } }],
    });
    expect(buttons?.[1]).toMatchObject({
      tag: "button",
      element_id: "privileged-deny-req-1",
      behaviors: [{ type: "callback", value: { command: "/approve req-1 deny" } }],
    });
  });

  it("resolves approvers from requester and feishu allowFrom", () => {
    const recipients = resolveApproverIds({
      cfg: {
        channels: {
          feishu: {
            allowFrom: ["ou-admin", "*", "ou-audit"],
          },
        },
      },
      accountId: "default",
      request: {
        id: "req-2",
        kind: "shutdown",
        status: "pending",
        justification: "Shutdown host",
        createdAtMs: 1,
        expiresAtMs: 2,
        requestedBy: {
          channel: "feishu",
          accountId: "default",
          senderId: "ou-admin",
        },
      },
    });
    expect(recipients).toEqual(["ou-admin", "ou-audit"]);
  });

  it("builds a resolved card without action buttons", () => {
    const card = buildResolvedCard({
      id: "req-3",
      kind: "host_exec",
      status: "executed",
      justification: "Run git status",
      createdAtMs: 1,
      expiresAtMs: 2,
      result: { ok: true, message: "ok" },
    });
    expect(card.schema).toBe("2.0");
    const body = card.body as { elements?: Array<Record<string, unknown>> } | undefined;
    expect(body?.elements?.some((element) => element.tag === "button")).toBe(false);
  });
});
