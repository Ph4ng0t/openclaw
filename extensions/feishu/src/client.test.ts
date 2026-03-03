import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeishuConfig, ResolvedFeishuAccount } from "./types.js";

const clientCtorMock = vi.hoisted(() =>
  vi.fn(function clientCtor(options) {
    return { options };
  }),
);
const defaultHttpInstanceMock = vi.hoisted(() => ({
  request: vi.fn(),
  get: vi.fn(),
  delete: vi.fn(),
  head: vi.fn(),
  options: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  patch: vi.fn(),
}));
const wsClientCtorMock = vi.hoisted(() =>
  vi.fn(function wsClientCtor(options) {
    return { connected: true, options };
  }),
);
const httpsProxyAgentCtorMock = vi.hoisted(() =>
  vi.fn(function httpsProxyAgentCtor(proxyUrl: string) {
    return { proxyUrl };
  }),
);

vi.mock("@larksuiteoapi/node-sdk", () => ({
  AppType: { SelfBuild: "self" },
  Domain: { Feishu: "https://open.feishu.cn", Lark: "https://open.larksuite.com" },
  LoggerLevel: { info: "info" },
  defaultHttpInstance: defaultHttpInstanceMock,
  Client: clientCtorMock,
  WSClient: wsClientCtorMock,
  EventDispatcher: vi.fn(),
}));

vi.mock("https-proxy-agent", () => ({
  HttpsProxyAgent: httpsProxyAgentCtorMock,
}));

import { createFeishuClient, createFeishuWSClient } from "./client.js";

const proxyEnvKeys = ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY"] as const;
type ProxyEnvKey = (typeof proxyEnvKeys)[number];

let priorProxyEnv: Partial<Record<ProxyEnvKey, string | undefined>> = {};

const baseAccount: ResolvedFeishuAccount = {
  accountId: "main",
  selectionSource: "explicit",
  enabled: true,
  configured: true,
  appId: "app_123",
  appSecret: "secret_123",
  domain: "feishu",
  config: {} as FeishuConfig,
};

function firstWsClientOptions(): { agent?: unknown; httpInstance?: unknown } {
  const calls = wsClientCtorMock.mock.calls as unknown as Array<
    [options: { agent?: unknown; httpInstance?: unknown }]
  >;
  return calls[0]?.[0] ?? {};
}

function firstClientOptions(): { httpInstance?: unknown } {
  const calls = clientCtorMock.mock.calls as unknown as Array<
    [options: { httpInstance?: unknown }]
  >;
  return calls[0]?.[0] ?? {};
}

beforeEach(() => {
  priorProxyEnv = {};
  for (const key of proxyEnvKeys) {
    priorProxyEnv[key] = process.env[key];
    delete process.env[key];
  }
  vi.clearAllMocks();
});

afterEach(() => {
  for (const key of proxyEnvKeys) {
    const value = priorProxyEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("createFeishuWSClient proxy handling", () => {
  it("does not set a ws proxy agent when proxy env is absent", () => {
    createFeishuWSClient(baseAccount);

    expect(httpsProxyAgentCtorMock).not.toHaveBeenCalled();
    const options = firstWsClientOptions();
    expect(options?.agent).toBeUndefined();
  });

  it("prefers HTTPS proxy vars over HTTP proxy vars across runtimes", () => {
    process.env.https_proxy = "http://lower-https:8001";
    process.env.HTTPS_PROXY = "http://upper-https:8002";
    process.env.http_proxy = "http://lower-http:8003";
    process.env.HTTP_PROXY = "http://upper-http:8004";

    createFeishuWSClient(baseAccount);

    // On Windows env keys are case-insensitive, so setting HTTPS_PROXY may
    // overwrite https_proxy. We assert https proxies still win over http.
    const expectedProxy = process.env.https_proxy || process.env.HTTPS_PROXY;
    expect(expectedProxy).toBeTruthy();
    expect(httpsProxyAgentCtorMock).toHaveBeenCalledTimes(2);
    expect(httpsProxyAgentCtorMock).toHaveBeenCalledWith(expectedProxy);
    const options = firstWsClientOptions();
    expect(options.agent).toEqual({ proxyUrl: expectedProxy });
  });

  it("accepts lowercase https_proxy when it is the configured HTTPS proxy var", () => {
    process.env.https_proxy = "http://lower-https:8001";

    createFeishuWSClient(baseAccount);

    const expectedHttpsProxy = process.env.https_proxy || process.env.HTTPS_PROXY;
    expect(httpsProxyAgentCtorMock).toHaveBeenCalledTimes(2);
    expect(expectedHttpsProxy).toBeTruthy();
    expect(httpsProxyAgentCtorMock).toHaveBeenCalledWith(expectedHttpsProxy);
    const options = firstWsClientOptions();
    expect(options.agent).toEqual({ proxyUrl: expectedHttpsProxy });
  });

  it("passes HTTP_PROXY to ws client when https vars are unset", () => {
    process.env.HTTP_PROXY = "http://upper-http:8999";

    createFeishuWSClient(baseAccount);

    expect(httpsProxyAgentCtorMock).toHaveBeenCalledTimes(2);
    expect(httpsProxyAgentCtorMock).toHaveBeenCalledWith("http://upper-http:8999");
    const options = firstWsClientOptions();
    expect(options.agent).toEqual({ proxyUrl: "http://upper-http:8999" });
  });

  it("prefers explicit Feishu proxy config over env vars for ws and rest clients", () => {
    process.env.HTTPS_PROXY = "http://env-proxy:8002";
    const account = {
      ...baseAccount,
      proxy: "http://explicit-proxy:9010",
    };

    createFeishuClient(account);
    createFeishuWSClient(account);

    expect(httpsProxyAgentCtorMock).toHaveBeenNthCalledWith(1, "http://explicit-proxy:9010");
    expect(httpsProxyAgentCtorMock).toHaveBeenNthCalledWith(2, "http://explicit-proxy:9010");
    expect(httpsProxyAgentCtorMock).toHaveBeenNthCalledWith(3, "http://explicit-proxy:9010");
    expect(firstClientOptions().httpInstance).toBeTruthy();
    expect(firstWsClientOptions().agent).toEqual({ proxyUrl: "http://explicit-proxy:9010" });
    expect(firstWsClientOptions().httpInstance).toBeTruthy();
  });
});
