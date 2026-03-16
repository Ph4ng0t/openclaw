import {
  buildGatewayConnectionDetails,
  GatewayClient,
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  resolveGatewayCredentialsFromConfig,
  type ClawdbotConfig,
  type EventFrame,
  type RuntimeEnv,
} from "openclaw/plugin-sdk";
import { loadFeishuRuntimeConfig } from "./runtime.js";
import { sendCardFeishu, sendMessageFeishu, updateCardFeishu } from "./send.js";

type PrivilegedRequestRecord = {
  id: string;
  kind: string;
  status: "pending" | "approved" | "denied" | "expired" | "executed" | "failed";
  justification: string;
  payload?: Record<string, unknown>;
  createdAtMs: number;
  expiresAtMs: number;
  requestedBy?: {
    channel?: string;
    accountId?: string;
    senderId?: string;
    sessionKey?: string;
    agentId?: string;
  };
  resolvedBy?: string | null;
  result?: { ok: boolean; message?: string };
};

type SentApprovalCard = {
  recipientId: string;
  messageId: string;
};

function formatTimestamp(timestampMs: number | undefined): string {
  if (typeof timestampMs !== "number" || !Number.isFinite(timestampMs)) {
    return "unknown";
  }
  return new Date(timestampMs).toLocaleString("zh-CN", { hour12: false });
}

function trimString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function summarizePayload(payload?: Record<string, unknown>): string[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const lines: string[] = [];
  const command = trimString(payload.command);
  if (command) {
    lines.push(`- Command: \`${command}\``);
  }
  const requestPath = trimString(payload.path);
  if (requestPath) {
    lines.push(`- Path: \`${requestPath}\``);
  }
  const access = trimString(payload.access);
  if (access) {
    lines.push(`- Access: \`${access}\``);
  }
  const commandId = trimString(payload.commandId);
  if (commandId) {
    lines.push(`- Command: \`${commandId}\``);
  }
  const cwd = trimString(payload.cwd);
  if (cwd) {
    lines.push(`- Cwd: \`${cwd}\``);
  }
  const host = trimString(payload.host);
  if (host) {
    lines.push(`- Host: \`${host}\``);
  }
  const nodeId = trimString(payload.nodeId);
  if (nodeId) {
    lines.push(`- Node: \`${nodeId}\``);
  }
  return lines;
}

function resolveRequesterRecipientId(params: {
  accountId: string;
  request: PrivilegedRequestRecord;
}): string | undefined {
  const senderId = trimString(params.request.requestedBy?.senderId);
  const requestAccountId = trimString(params.request.requestedBy?.accountId);
  if (
    trimString(params.request.requestedBy?.channel) !== "feishu" ||
    !senderId ||
    (requestAccountId && requestAccountId !== params.accountId)
  ) {
    return undefined;
  }
  return senderId;
}

function buildRequesterResolvedText(request: PrivilegedRequestRecord): string | null {
  if (
    request.kind !== "host_exec" ||
    request.status === "pending" ||
    request.status === "approved"
  ) {
    return null;
  }

  const payload = request.payload ?? {};
  const command = trimString(payload.command);
  const cwd = trimString(payload.cwd);
  const resultMessage = trimString(request.result?.message);
  const headline =
    request.status === "executed"
      ? "Privileged host command executed."
      : request.status === "denied"
        ? "Privileged host command request denied."
        : request.status === "expired"
          ? "Privileged host command request expired."
          : "Privileged host command failed.";

  const lines = [
    headline,
    `Request ID: ${request.id}`,
    command ? `Command: ${command}` : "",
    cwd ? `Cwd: ${cwd}` : "",
    resultMessage ? "" : "",
    resultMessage ? resultMessage : "",
  ].filter(Boolean);

  return lines.join("\n");
}

function buildPendingCard(request: PrivilegedRequestRecord): Record<string, unknown> {
  const metadata = [
    `- Kind: \`${request.kind}\``,
    `- Request ID: \`${request.id}\``,
    `- Created: ${formatTimestamp(request.createdAtMs)}`,
    `- Expires: ${formatTimestamp(request.expiresAtMs)}`,
    request.requestedBy?.sessionKey ? `- Session: \`${request.requestedBy.sessionKey}\`` : "",
    request.requestedBy?.agentId ? `- Agent: \`${request.requestedBy.agentId}\`` : "",
    ...summarizePayload(request.payload),
  ].filter(Boolean);

  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
    },
    header: {
      template: "orange",
      title: { tag: "plain_text", content: "OpenClaw Privileged Approval Required" },
    },
    body: {
      vertical_spacing: "8px",
      horizontal_spacing: "8px",
      elements: [
        {
          tag: "markdown",
          content: [`${request.justification}`, "", ...metadata].join("\n"),
        },
        {
          tag: "button",
          element_id: `privileged-approve-${request.id}`,
          type: "primary",
          size: "small",
          text: { tag: "plain_text", content: "Approve" },
          behaviors: [
            {
              type: "callback",
              value: { command: `/approve ${request.id} approve` },
            },
          ],
        },
        {
          tag: "button",
          element_id: `privileged-deny-${request.id}`,
          type: "danger",
          size: "small",
          text: { tag: "plain_text", content: "Deny" },
          behaviors: [
            {
              type: "callback",
              value: { command: `/approve ${request.id} deny` },
            },
          ],
        },
      ],
    },
  };
}

function buildResolvedCard(request: PrivilegedRequestRecord): Record<string, unknown> {
  const template =
    request.status === "denied" || request.status === "failed"
      ? "red"
      : request.status === "expired"
        ? "grey"
        : "green";
  const statusLine =
    request.status === "executed"
      ? "Executed"
      : request.status === "approved"
        ? "Approved"
        : request.status === "denied"
          ? "Denied"
          : request.status === "expired"
            ? "Expired"
            : "Failed";
  const details = [
    request.justification,
    "",
    `- Status: **${statusLine}**`,
    `- Request ID: \`${request.id}\``,
    request.resolvedBy ? `- Resolved By: \`${request.resolvedBy}\`` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
    },
    header: {
      template,
      title: {
        tag: "plain_text",
        content: `OpenClaw Privileged Request ${statusLine}`,
      },
    },
    body: {
      elements: [
        {
          tag: "markdown",
          content: details,
        },
      ],
    },
  };
}

function resolveApproverIds(params: {
  cfg: ClawdbotConfig;
  accountId: string;
  request: PrivilegedRequestRecord;
}): string[] {
  const recipients = new Set<string>();
  const requesterRecipientId = resolveRequesterRecipientId(params);
  if (requesterRecipientId) {
    recipients.add(requesterRecipientId);
  }
  const allowFrom = params.cfg.channels?.feishu?.allowFrom ?? [];
  for (const entry of allowFrom) {
    const normalized = trimString(String(entry));
    if (!normalized || normalized === "*") {
      continue;
    }
    recipients.add(normalized);
  }
  return [...recipients];
}

export class FeishuPrivilegedApprovalHandler {
  private gatewayClient: GatewayClient | null = null;
  private readonly sentCards = new Map<string, SentApprovalCard[]>();
  private started = false;

  constructor(
    private readonly opts: {
      cfg: ClawdbotConfig;
      accountId: string;
      runtime?: RuntimeEnv;
    },
  ) {}

  private resolveCurrentConfig(): ClawdbotConfig {
    return loadFeishuRuntimeConfig(this.opts.cfg);
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    const connection = buildGatewayConnectionDetails({ config: this.opts.cfg });
    const auth = resolveGatewayCredentialsFromConfig({
      cfg: this.opts.cfg,
      localTokenPrecedence: "config-first",
      localPasswordPrecedence: "config-first",
    });
    this.gatewayClient = new GatewayClient({
      url: connection.url,
      token: auth.token,
      password: auth.password,
      clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
      clientDisplayName: `Feishu Privileged Approvals (${this.opts.accountId})`,
      mode: GATEWAY_CLIENT_MODES.BACKEND,
      scopes: ["operator.approvals"],
      onEvent: (event) => this.handleGatewayEvent(event),
      onConnectError: (error) => {
        this.opts.runtime?.error?.(
          `feishu[${this.opts.accountId}]: privileged approval gateway connect error: ${error.message}`,
        );
      },
      onClose: (code, reason) => {
        this.opts.runtime?.log?.(
          `feishu[${this.opts.accountId}]: privileged approval gateway closed: ${code} ${reason}`,
        );
      },
    });
    this.gatewayClient.start();
  }

  async stop(): Promise<void> {
    this.gatewayClient?.stop();
    this.gatewayClient = null;
    this.sentCards.clear();
    this.started = false;
  }

  private handleGatewayEvent(event: EventFrame): void {
    if (event.event === "privileged.requested") {
      void this.handleRequested(event.payload as PrivilegedRequestRecord);
      return;
    }
    if (event.event === "privileged.resolved") {
      void this.handleResolved(event.payload as PrivilegedRequestRecord);
    }
  }

  private async handleRequested(request: PrivilegedRequestRecord): Promise<void> {
    const cfg = this.resolveCurrentConfig();
    const recipients = resolveApproverIds({
      cfg,
      accountId: this.opts.accountId,
      request,
    });
    if (recipients.length === 0) {
      return;
    }
    const card = buildPendingCard(request);
    const sent: SentApprovalCard[] = [];
    for (const recipientId of recipients) {
      try {
        const result = await sendCardFeishu({
          cfg,
          to: recipientId,
          card,
          accountId: this.opts.accountId,
        });
        if (result.messageId) {
          sent.push({ recipientId, messageId: result.messageId });
        }
      } catch (error) {
        this.opts.runtime?.error?.(
          `feishu[${this.opts.accountId}]: failed to send privileged approval card to ${recipientId}: ${String(error)}`,
        );
      }
    }
    if (sent.length > 0) {
      this.sentCards.set(request.id, sent);
    }
  }

  private async handleResolved(request: PrivilegedRequestRecord): Promise<void> {
    const sent = this.sentCards.get(request.id);
    const cfg = this.resolveCurrentConfig();
    if (sent && sent.length > 0) {
      const card = buildResolvedCard(request);
      for (const entry of sent) {
        try {
          await updateCardFeishu({
            cfg,
            messageId: entry.messageId,
            card,
            accountId: this.opts.accountId,
          });
        } catch (error) {
          this.opts.runtime?.error?.(
            `feishu[${this.opts.accountId}]: failed to update privileged approval card ${entry.messageId}: ${String(error)}`,
          );
        }
      }
    }

    const requesterRecipientId = resolveRequesterRecipientId({
      accountId: this.opts.accountId,
      request,
    });
    const requesterText = requesterRecipientId ? buildRequesterResolvedText(request) : null;
    if (requesterRecipientId && requesterText) {
      try {
        await sendMessageFeishu({
          cfg,
          to: requesterRecipientId,
          text: requesterText,
          accountId: this.opts.accountId,
        });
      } catch (error) {
        this.opts.runtime?.error?.(
          `feishu[${this.opts.accountId}]: failed to send privileged result to ${requesterRecipientId}: ${String(error)}`,
        );
      }
    }

    if (request.status !== "pending") {
      this.sentCards.delete(request.id);
    }
  }
}

export {
  buildPendingCard,
  buildRequesterResolvedText,
  buildResolvedCard,
  resolveApproverIds,
  resolveRequesterRecipientId,
};
