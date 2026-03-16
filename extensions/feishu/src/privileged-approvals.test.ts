import { describe, expect, it } from "vitest";
import {
  buildPendingCard,
  buildRequesterResolvedText,
  buildResolvedCard,
  resolveApproverIds,
  resolveRequesterRecipientId,
} from "./privileged-approvals.js";

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

  it("cannot route requester approval cards without feishu requester context", () => {
    const recipients = resolveApproverIds({
      cfg: {
        channels: {
          feishu: {
            allowFrom: [],
          },
        },
      },
      accountId: "default",
      request: {
        id: "req-missing-origin",
        kind: "host_exec",
        status: "pending",
        justification: "Allow host exec on gateway: ls /home/lawliet/projects",
        createdAtMs: 1,
        expiresAtMs: 2,
        requestedBy: {
          sessionKey: "agent:main:feishu:direct:ou_requester",
        },
      },
    });
    expect(recipients).toEqual([]);
  });

  it("resolves the requester recipient only for same-account feishu requests", () => {
    expect(
      resolveRequesterRecipientId({
        accountId: "default",
        request: {
          id: "req-2b",
          kind: "host_exec",
          status: "executed",
          justification: "Run ls",
          createdAtMs: 1,
          expiresAtMs: 2,
          requestedBy: {
            channel: "feishu",
            accountId: "default",
            senderId: "ou-requester",
          },
        },
      }),
    ).toBe("ou-requester");

    expect(
      resolveRequesterRecipientId({
        accountId: "default",
        request: {
          id: "req-2c",
          kind: "host_exec",
          status: "executed",
          justification: "Run ls",
          createdAtMs: 1,
          expiresAtMs: 2,
          requestedBy: {
            channel: "slack",
            accountId: "default",
            senderId: "ou-requester",
          },
        },
      }),
    ).toBeUndefined();
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
    const markdown = body?.elements?.find((element) => element.tag === "markdown") as
      | { content?: string }
      | undefined;
    expect(markdown?.content).toContain("Status: **Executed**");
    expect(markdown?.content).not.toContain("Result:");
    expect(markdown?.content).not.toContain("ok");
  });

  it("includes host exec details in the pending card", () => {
    const card = buildPendingCard({
      id: "req-4",
      kind: "host_exec",
      status: "pending",
      justification: "Allow host exec on gateway: ls /home",
      createdAtMs: 1,
      expiresAtMs: 2,
      payload: { command: "ls /home", cwd: "/workspace", host: "gateway" },
    });
    const body = card.body as { elements?: Array<Record<string, unknown>> } | undefined;
    const markdown = body?.elements?.find((element) => element.tag === "markdown");
    expect(markdown).toMatchObject({
      content: expect.stringContaining("Command: `ls /home`"),
    });
    expect(markdown).toMatchObject({
      content: expect.stringContaining("Host: `gateway`"),
    });
  });

  it("builds a requester-facing host exec result message with command output", () => {
    expect(
      buildRequesterResolvedText({
        id: "req-5",
        kind: "host_exec",
        status: "executed",
        justification: "Run ls",
        createdAtMs: 1,
        expiresAtMs: 2,
        payload: { command: "ls /home/lawliet/cloud", cwd: "/home/lawliet" },
        result: { ok: true, message: "a.txt\nb.txt" },
      }),
    ).toContain("a.txt\nb.txt");

    expect(
      buildRequesterResolvedText({
        id: "req-6",
        kind: "fs_grant",
        status: "executed",
        justification: "Grant repo access",
        createdAtMs: 1,
        expiresAtMs: 2,
        result: { ok: true, message: "Granted" },
      }),
    ).toBeNull();
  });
});
