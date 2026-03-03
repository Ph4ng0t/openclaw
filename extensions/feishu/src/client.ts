import * as Lark from "@larksuiteoapi/node-sdk";
import type { HttpInstance, HttpRequestOptions } from "@larksuiteoapi/node-sdk";
import { defaultHttpInstance } from "@larksuiteoapi/node-sdk";
import { HttpsProxyAgent } from "https-proxy-agent";
import type { FeishuDomain, ResolvedFeishuAccount } from "./types.js";

export function resolveFeishuProxyUrl(explicitProxy?: string): string | undefined {
  const proxyUrl =
    explicitProxy ||
    process.env.https_proxy ||
    process.env.HTTPS_PROXY ||
    process.env.http_proxy ||
    process.env.HTTP_PROXY;
  if (!proxyUrl) return undefined;
  const trimmed = proxyUrl.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function getWsProxyAgent(explicitProxy?: string): HttpsProxyAgent<string> | undefined {
  const proxyUrl = resolveFeishuProxyUrl(explicitProxy);
  if (!proxyUrl) return undefined;
  return new HttpsProxyAgent(proxyUrl);
}

export function createFeishuHttpInstance(proxyUrl?: string): HttpInstance | undefined {
  if (!proxyUrl) {
    return undefined;
  }
  const proxyAgent = new HttpsProxyAgent(proxyUrl);
  const withProxy = <D>(
    opts: HttpRequestOptions<D>,
  ): HttpRequestOptions<D> & {
    proxy: false;
    httpAgent: HttpsProxyAgent<string>;
    httpsAgent: HttpsProxyAgent<string>;
  } => ({
    ...opts,
    proxy: false,
    httpAgent: proxyAgent,
    httpsAgent: proxyAgent,
    headers: {
      "User-Agent": "oapi-node-sdk/1.0.0",
      ...(opts.headers ?? {}),
    },
  });

  return {
    request: <T = unknown, R = T, D = unknown>(opts: HttpRequestOptions<D>) =>
      defaultHttpInstance.request<T, R, D>(withProxy(opts)),
    get: <T = unknown, R = T, D = unknown>(url: string, opts?: HttpRequestOptions<D>) =>
      defaultHttpInstance.get<T, R, D>(url, withProxy(opts ?? {})),
    delete: <T = unknown, R = T, D = unknown>(url: string, opts?: HttpRequestOptions<D>) =>
      defaultHttpInstance.delete<T, R, D>(url, withProxy(opts ?? {})),
    head: <T = unknown, R = T, D = unknown>(url: string, opts?: HttpRequestOptions<D>) =>
      defaultHttpInstance.head<T, R, D>(url, withProxy(opts ?? {})),
    options: <T = unknown, R = T, D = unknown>(url: string, opts?: HttpRequestOptions<D>) =>
      defaultHttpInstance.options<T, R, D>(url, withProxy(opts ?? {})),
    post: <T = unknown, R = T, D = unknown>(url: string, data?: D, opts?: HttpRequestOptions<D>) =>
      defaultHttpInstance.post<T, R, D>(url, data, withProxy(opts ?? {})),
    put: <T = unknown, R = T, D = unknown>(url: string, data?: D, opts?: HttpRequestOptions<D>) =>
      defaultHttpInstance.put<T, R, D>(url, data, withProxy(opts ?? {})),
    patch: <T = unknown, R = T, D = unknown>(url: string, data?: D, opts?: HttpRequestOptions<D>) =>
      defaultHttpInstance.patch<T, R, D>(url, data, withProxy(opts ?? {})),
  };
}

// Multi-account client cache
const clientCache = new Map<
  string,
  {
    client: Lark.Client;
    config: { appId: string; appSecret: string; domain?: FeishuDomain; proxy?: string };
  }
>();

function resolveDomain(domain: FeishuDomain | undefined): Lark.Domain | string {
  if (domain === "lark") {
    return Lark.Domain.Lark;
  }
  if (domain === "feishu" || !domain) {
    return Lark.Domain.Feishu;
  }
  return domain.replace(/\/+$/, ""); // Custom URL for private deployment
}

/**
 * Credentials needed to create a Feishu client.
 * Both FeishuConfig and ResolvedFeishuAccount satisfy this interface.
 */
export type FeishuClientCredentials = {
  accountId?: string;
  appId?: string;
  appSecret?: string;
  domain?: FeishuDomain;
  proxy?: string;
};

/**
 * Create or get a cached Feishu client for an account.
 * Accepts any object with appId, appSecret, and optional domain/accountId.
 */
export function createFeishuClient(creds: FeishuClientCredentials): Lark.Client {
  const { accountId = "default", appId, appSecret, domain, proxy } = creds;
  const proxyUrl = resolveFeishuProxyUrl(proxy);

  if (!appId || !appSecret) {
    throw new Error(`Feishu credentials not configured for account "${accountId}"`);
  }

  // Check cache
  const cached = clientCache.get(accountId);
  if (
    cached &&
    cached.config.appId === appId &&
    cached.config.appSecret === appSecret &&
    cached.config.domain === domain &&
    cached.config.proxy === proxyUrl
  ) {
    return cached.client;
  }

  // Create new client
  const client = new Lark.Client({
    appId,
    appSecret,
    appType: Lark.AppType.SelfBuild,
    domain: resolveDomain(domain),
    ...(proxyUrl ? { httpInstance: createFeishuHttpInstance(proxyUrl) } : {}),
  });

  // Cache it
  clientCache.set(accountId, {
    client,
    config: { appId, appSecret, domain, proxy: proxyUrl },
  });

  return client;
}

/**
 * Create a Feishu WebSocket client for an account.
 * Note: WSClient is not cached since each call creates a new connection.
 */
export function createFeishuWSClient(account: ResolvedFeishuAccount): Lark.WSClient {
  const { accountId, appId, appSecret, domain, proxy } = account;

  if (!appId || !appSecret) {
    throw new Error(`Feishu credentials not configured for account "${accountId}"`);
  }

  const proxyUrl = resolveFeishuProxyUrl(proxy);
  const agent = getWsProxyAgent(proxyUrl);
  return new Lark.WSClient({
    appId,
    appSecret,
    domain: resolveDomain(domain),
    loggerLevel: Lark.LoggerLevel.info,
    ...(proxyUrl ? { httpInstance: createFeishuHttpInstance(proxyUrl) } : {}),
    ...(agent ? { agent } : {}),
  });
}

/**
 * Create an event dispatcher for an account.
 */
export function createEventDispatcher(account: ResolvedFeishuAccount): Lark.EventDispatcher {
  return new Lark.EventDispatcher({
    encryptKey: account.encryptKey,
    verificationToken: account.verificationToken,
  });
}

/**
 * Get a cached client for an account (if exists).
 */
export function getFeishuClient(accountId: string): Lark.Client | null {
  return clientCache.get(accountId)?.client ?? null;
}

/**
 * Clear client cache for a specific account or all accounts.
 */
export function clearClientCache(accountId?: string): void {
  if (accountId) {
    clientCache.delete(accountId);
  } else {
    clientCache.clear();
  }
}
