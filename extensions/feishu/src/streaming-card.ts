/**
 * Feishu Streaming Card - Card Kit streaming API for real-time text output
 */

import type { Client } from "@larksuiteoapi/node-sdk";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk";
import { createFeishuHttpInstance, resolveFeishuProxyUrl } from "./client.js";
import type { FeishuDomain } from "./types.js";

type Credentials = { appId: string; appSecret: string; domain?: FeishuDomain; proxy?: string };
type CardState = { cardId: string; messageId: string; sequence: number; currentText: string };

/** Optional header for streaming cards (title bar with color template) */
export type StreamingCardHeader = {
  title: string;
  /** Color template: blue, green, red, orange, purple, indigo, wathet, turquoise, yellow, grey, carmine, violet, lime */
  template?: string;
};

// Token cache (keyed by domain + appId)
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

function resolveApiBase(domain?: FeishuDomain): string {
  if (domain === "lark") {
    return "https://open.larksuite.com/open-apis";
  }
  if (domain && domain !== "feishu" && domain.startsWith("http")) {
    return `${domain.replace(/\/+$/, "")}/open-apis`;
  }
  return "https://open.feishu.cn/open-apis";
}

function resolveAllowedHostnames(domain?: FeishuDomain): string[] {
  if (domain === "lark") {
    return ["open.larksuite.com"];
  }
  if (domain && domain !== "feishu" && domain.startsWith("http")) {
    try {
      return [new URL(domain).hostname];
    } catch {
      return [];
    }
  }
  return ["open.feishu.cn"];
}

function assertAllowedFeishuUrl(url: string, allowedHostnames: string[]): void {
  const hostname = new URL(url).hostname;
  if (!allowedHostnames.includes(hostname)) {
    throw new Error(`Blocked Feishu API hostname: ${hostname}`);
  }
}

async function requestFeishuApi<T>(params: {
  url: string;
  method: "POST" | "PUT" | "PATCH";
  headers?: Record<string, string>;
  data?: unknown;
  allowedHostnames: string[];
  auditContext: string;
  proxy?: string;
}): Promise<T> {
  assertAllowedFeishuUrl(params.url, params.allowedHostnames);
  const proxyUrl = resolveFeishuProxyUrl(params.proxy);
  const httpInstance = createFeishuHttpInstance(proxyUrl);
  if (httpInstance) {
    return (await httpInstance.request({
      url: params.url,
      method: params.method,
      headers: params.headers,
      data: params.data,
    })) as T;
  }

  const { response, release } = await fetchWithSsrFGuard({
    url: params.url,
    init: {
      method: params.method,
      headers: params.headers,
      body: params.data === undefined ? undefined : JSON.stringify(params.data),
    },
    policy: { allowedHostnames: params.allowedHostnames },
    auditContext: params.auditContext,
  });
  const data = (await response.json()) as T;
  await release();
  return data;
}

async function getToken(creds: Credentials): Promise<string> {
  const key = `${creds.domain ?? "feishu"}|${creds.appId}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 60000) {
    return cached.token;
  }

  const allowedHostnames = resolveAllowedHostnames(creds.domain);
  const data = await requestFeishuApi<{
    code: number;
    msg: string;
    tenant_access_token?: string;
    expire?: number;
  }>({
    url: `${resolveApiBase(creds.domain)}/auth/v3/tenant_access_token/internal`,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    data: { app_id: creds.appId, app_secret: creds.appSecret },
    allowedHostnames,
    auditContext: "feishu.streaming-card.token",
    proxy: creds.proxy,
  });
  if (data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`Token error: ${data.msg}`);
  }
  tokenCache.set(key, {
    token: data.tenant_access_token,
    expiresAt: Date.now() + (data.expire ?? 7200) * 1000,
  });
  return data.tenant_access_token;
}

function truncateSummary(text: string, max = 50): string {
  if (!text) {
    return "";
  }
  const clean = text.replace(/\n/g, " ").trim();
  return clean.length <= max ? clean : clean.slice(0, max - 3) + "...";
}

export function mergeStreamingText(
  previousText: string | undefined,
  nextText: string | undefined,
): string {
  const previous = typeof previousText === "string" ? previousText : "";
  const next = typeof nextText === "string" ? nextText : "";
  if (!next) {
    return previous;
  }
  if (!previous || next === previous || next.includes(previous)) {
    return next;
  }
  if (previous.includes(next)) {
    return previous;
  }
  // Fallback for fragmented partial chunks: append as-is to avoid losing tokens.
  return `${previous}${next}`;
}

/** Streaming card session manager */
export class FeishuStreamingSession {
  private client: Client;
  private creds: Credentials;
  private state: CardState | null = null;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private log?: (msg: string) => void;
  private lastUpdateTime = 0;
  private pendingText: string | null = null;
  private updateThrottleMs = 100; // Throttle updates to max 10/sec

  constructor(client: Client, creds: Credentials, log?: (msg: string) => void) {
    this.client = client;
    this.creds = creds;
    this.log = log;
  }

  async start(
    receiveId: string,
    receiveIdType: "open_id" | "user_id" | "union_id" | "email" | "chat_id" = "chat_id",
    options?: {
      replyToMessageId?: string;
      replyInThread?: boolean;
      rootId?: string;
      header?: StreamingCardHeader;
    },
  ): Promise<void> {
    if (this.state) {
      return;
    }

    const apiBase = resolveApiBase(this.creds.domain);
    const cardJson: Record<string, unknown> = {
      schema: "2.0",
      config: {
        streaming_mode: true,
        summary: { content: "[Generating...]" },
        streaming_config: { print_frequency_ms: { default: 50 }, print_step: { default: 2 } },
      },
      body: {
        elements: [{ tag: "markdown", content: "⏳ Thinking...", element_id: "content" }],
      },
    };
    if (options?.header) {
      cardJson.header = {
        title: { tag: "plain_text", content: options.header.title },
        template: options.header.template ?? "blue",
      };
    }

    // Create card entity
    const createData = await requestFeishuApi<{
      code: number;
      msg: string;
      data?: { card_id: string };
    }>({
      url: `${apiBase}/cardkit/v1/cards`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${await getToken(this.creds)}`,
        "Content-Type": "application/json",
      },
      data: { type: "card_json", data: JSON.stringify(cardJson) },
      allowedHostnames: resolveAllowedHostnames(this.creds.domain),
      auditContext: "feishu.streaming-card.create",
      proxy: this.creds.proxy,
    });
    if (createData.code !== 0 || !createData.data?.card_id) {
      throw new Error(`Create card failed: ${createData.msg}`);
    }
    const cardId = createData.data.card_id;
    const cardContent = JSON.stringify({ type: "card", data: { card_id: cardId } });

    // Topic-group replies require root_id routing. Prefer create+root_id when available.
    let sendRes;
    if (options?.rootId) {
      const createData = {
        receive_id: receiveId,
        msg_type: "interactive",
        content: cardContent,
        root_id: options.rootId,
      };
      sendRes = await this.client.im.message.create({
        params: { receive_id_type: receiveIdType },
        data: createData,
      });
    } else if (options?.replyToMessageId) {
      sendRes = await this.client.im.message.reply({
        path: { message_id: options.replyToMessageId },
        data: {
          msg_type: "interactive",
          content: cardContent,
          ...(options.replyInThread ? { reply_in_thread: true } : {}),
        },
      });
    } else {
      sendRes = await this.client.im.message.create({
        params: { receive_id_type: receiveIdType },
        data: {
          receive_id: receiveId,
          msg_type: "interactive",
          content: cardContent,
        },
      });
    }
    if (sendRes.code !== 0 || !sendRes.data?.message_id) {
      throw new Error(`Send card failed: ${sendRes.msg}`);
    }

    this.state = { cardId, messageId: sendRes.data.message_id, sequence: 1, currentText: "" };
    this.log?.(`Started streaming: cardId=${cardId}, messageId=${sendRes.data.message_id}`);
  }

  private async updateCardContent(text: string, onError?: (error: unknown) => void): Promise<void> {
    if (!this.state) {
      return;
    }
    const apiBase = resolveApiBase(this.creds.domain);
    this.state.sequence += 1;
    await requestFeishuApi({
      url: `${apiBase}/cardkit/v1/cards/${this.state.cardId}/elements/content/content`,
      method: "PUT",
      headers: {
        Authorization: `Bearer ${await getToken(this.creds)}`,
        "Content-Type": "application/json",
      },
      data: {
        content: text,
        sequence: this.state.sequence,
        uuid: `s_${this.state.cardId}_${this.state.sequence}`,
      },
      allowedHostnames: resolveAllowedHostnames(this.creds.domain),
      auditContext: "feishu.streaming-card.update",
      proxy: this.creds.proxy,
    }).catch((error) => onError?.(error));
  }

  async update(text: string): Promise<void> {
    if (!this.state || this.closed) {
      return;
    }
    const mergedInput = mergeStreamingText(this.pendingText ?? this.state.currentText, text);
    if (!mergedInput || mergedInput === this.state.currentText) {
      return;
    }

    // Throttle: skip if updated recently, but remember pending text
    const now = Date.now();
    if (now - this.lastUpdateTime < this.updateThrottleMs) {
      this.pendingText = mergedInput;
      return;
    }
    this.pendingText = null;
    this.lastUpdateTime = now;

    this.queue = this.queue.then(async () => {
      if (!this.state || this.closed) {
        return;
      }
      const mergedText = mergeStreamingText(this.state.currentText, mergedInput);
      if (!mergedText || mergedText === this.state.currentText) {
        return;
      }
      this.state.currentText = mergedText;
      await this.updateCardContent(mergedText, (e) => this.log?.(`Update failed: ${String(e)}`));
    });
    await this.queue;
  }

  async close(finalText?: string): Promise<void> {
    if (!this.state || this.closed) {
      return;
    }
    this.closed = true;
    await this.queue;

    const pendingMerged = mergeStreamingText(this.state.currentText, this.pendingText ?? undefined);
    const text = finalText ? mergeStreamingText(pendingMerged, finalText) : pendingMerged;
    const apiBase = resolveApiBase(this.creds.domain);

    // Only send final update if content differs from what's already displayed
    if (text && text !== this.state.currentText) {
      await this.updateCardContent(text);
      this.state.currentText = text;
    }

    // Close streaming mode
    this.state.sequence += 1;
    await requestFeishuApi({
      url: `${apiBase}/cardkit/v1/cards/${this.state.cardId}/settings`,
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${await getToken(this.creds)}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      data: {
        settings: JSON.stringify({
          config: { streaming_mode: false, summary: { content: truncateSummary(text) } },
        }),
        sequence: this.state.sequence,
        uuid: `c_${this.state.cardId}_${this.state.sequence}`,
      },
      allowedHostnames: resolveAllowedHostnames(this.creds.domain),
      auditContext: "feishu.streaming-card.close",
      proxy: this.creds.proxy,
    }).catch((e) => this.log?.(`Close failed: ${String(e)}`));

    this.log?.(`Closed streaming: cardId=${this.state.cardId}`);
  }

  isActive(): boolean {
    return this.state !== null && !this.closed;
  }
}
