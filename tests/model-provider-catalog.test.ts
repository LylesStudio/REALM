import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MODEL_PROVIDER_CATALOG,
  ModelConfigurationError,
  createModelGateway,
  createOpenAICompatibleGateway,
  type ModelProviderSettings,
} from "../modules/inference/public.ts";
import {
  createLocalModelSettingsStore,
  validateModelSettings,
} from "../modules/inference/local-settings.ts";

/**
 * Provider 扩展批：五类供应商目录、端点校验矩阵、向后兼容 defaults、
 * fake fetch 契约（URL/headers/auth/thinking/tool/response_format/错误分类）。
 * 全部 fake fetch，不向真实 provider 发请求；不含真实地址/key。
 */

function settingsOf(
  providerId: ModelProviderSettings["providerId"],
  overrides: Partial<ModelProviderSettings> = {},
): ModelProviderSettings {
  const provider = MODEL_PROVIDER_CATALOG.find((item) => item.id === providerId)!;
  return {
    schemaVersion: 1,
    providerId,
    baseUrl: provider.baseUrl,
    apiKey: provider.requiresApiKey ? "test-key" : "",
    selectedModel: provider.defaultModel,
    thinking: "disabled",
    timeoutMs: 30_000,
    maxTokens: 2_048,
    availableModels: [],
    lastDiscoveredAt: null,
    updatedAt: "2026-09-13T00:00:00.000Z",
    ...overrides,
  };
}

test("catalog registers five providers with safe defaults and no real LAN addresses", () => {
  const ids = MODEL_PROVIDER_CATALOG.map((provider) => provider.id);
  assert.deepEqual(ids, [
    "lmstudio",
    "openrouter",
    "deepseek",
    "kimi-coding",
    "custom-openai",
  ]);
  const serialized = JSON.stringify(MODEL_PROVIDER_CATALOG);
  assert.ok(!/192\.168\.|10\.\d|172\.(?:1[6-9]|2\d|3[01])\./.test(serialized),
    "catalog must not embed real LAN addresses");
  const lmstudio = MODEL_PROVIDER_CATALOG.find((provider) => provider.id === "lmstudio")!;
  assert.equal(lmstudio.baseUrl, "http://127.0.0.1:1234/v1");
  assert.equal(lmstudio.endpointPolicy, "local");
  assert.equal(lmstudio.requiresApiKey, false);
  const deepseek = MODEL_PROVIDER_CATALOG.find((provider) => provider.id === "deepseek")!;
  assert.equal(deepseek.baseUrl, "https://api.deepseek.com");
  assert.equal(deepseek.requiresApiKey, true);
  const kimi = MODEL_PROVIDER_CATALOG.find((provider) => provider.id === "kimi-coding")!;
  assert.equal(kimi.baseUrl, "https://api.kimi.com/coding/v1");
  assert.equal(kimi.requiresApiKey, true);
  const custom = MODEL_PROVIDER_CATALOG.find((provider) => provider.id === "custom-openai")!;
  assert.equal(custom.endpointPolicy, "custom");
  assert.equal(custom.requiresApiKey, false);
});

test("endpoint validation: pinned hosts locked; local policy keeps local-only semantics", () => {
  // pinned 官方端点不可改向。
  for (const baseUrl of [
    "https://api.deepseek.com.evil.example",
    "https://api.deepseek.com:8443",
    "https://api.kimi.com/v1",
    "https://openrouter.ai/api/v2",
  ]) {
    assert.throws(
      () => validateModelSettings({ ...settingsOf("deepseek"), providerId: "deepseek", baseUrl }),
      (error: unknown) => error instanceof ModelConfigurationError
        && error.code === "MODEL_ENDPOINT_NOT_ALLOWED",
      baseUrl,
    );
  }
  // 一律拒绝内嵌凭证/query/fragment。
  for (const providerId of ["lmstudio", "openrouter", "custom-openai"] as const) {
    assert.throws(
      () => validateModelSettings({
        ...settingsOf(providerId),
        baseUrl: "https://user:secret@127.0.0.1:1234/v1",
      }),
      (error: unknown) => error instanceof ModelConfigurationError
        && error.code === "MODEL_ENDPOINT_NOT_ALLOWED",
    );
    assert.throws(
      () => validateModelSettings({
        ...settingsOf(providerId),
        baseUrl: "http://127.0.0.1:1234/v1?token=1",
      }),
      (error: unknown) => error instanceof ModelConfigurationError
        && error.code === "MODEL_ENDPOINT_NOT_ALLOWED",
    );
  }
  // LM Studio local 策略：loopback/私有地址可编辑，公网拒绝，路径钉定 /v1。
  assert.doesNotThrow(() => validateModelSettings({
    ...settingsOf("lmstudio"),
    baseUrl: "http://127.0.0.1:1234/v1",
  }));
  assert.doesNotThrow(() => validateModelSettings({
    ...settingsOf("lmstudio"),
    baseUrl: "http://192.168.1.10:1234/v1",
  }));
  for (const baseUrl of [
    "http://8.8.8.8:1234/v1",
    "http://127.0.0.1:1234/api",
    "https://example.com/v1",
  ]) {
    assert.throws(
      () => validateModelSettings({ ...settingsOf("lmstudio"), baseUrl }),
      (error: unknown) => error instanceof ModelConfigurationError
        && error.code === "MODEL_ENDPOINT_NOT_ALLOWED",
      baseUrl,
    );
  }
  // custom：http 仅本机/私有；远端必须 https；https 远端允许。
  assert.doesNotThrow(() => validateModelSettings({
    ...settingsOf("custom-openai"),
    baseUrl: "http://127.0.0.1:8000/v1",
  }));
  assert.doesNotThrow(() => validateModelSettings({
    ...settingsOf("custom-openai"),
    baseUrl: "https://llm.internal.example/v1",
  }));
  assert.throws(
    () => validateModelSettings({
      ...settingsOf("custom-openai"),
      baseUrl: "http://llm.remote.example/v1",
    }),
    (error: unknown) => error instanceof ModelConfigurationError
      && error.code === "MODEL_ENDPOINT_NOT_ALLOWED",
  );
});

test("a legacy two-provider document is completed with safe defaults for the new providers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "realm-providers-five-"));
  try {
    const legacyDocument = {
      schemaVersion: 2,
      activeProviderId: "openrouter",
      providers: {
        lmstudio: settingsOf("lmstudio"),
        openrouter: settingsOf("openrouter"),
      },
      updatedAt: "2026-09-13T00:00:00.000Z",
    };
    const filePath = join(directory, "model-providers.json");
    await writeFile(filePath, `${JSON.stringify(legacyDocument)}\n`, { mode: 0o600 });
    const store = createLocalModelSettingsStore({ filePath, environment: {} });
    const snapshot = await store.loadSnapshot();
    assert.equal(snapshot.activeProviderId, "openrouter", "旧 active 不得漂移");
    assert.deepEqual(Object.keys(snapshot.providers).sort(), [
      "custom-openai",
      "deepseek",
      "kimi-coding",
      "lmstudio",
      "openrouter",
    ]);
    // 旧 profile 原样保留；新 profile 由 defaults 补齐（无 key、官方/loopback 默认端点）。
    assert.equal(snapshot.providers.openrouter?.apiKey, "test-key");
    assert.equal(snapshot.providers.deepseek?.apiKey, "");
    assert.equal(snapshot.providers.deepseek?.baseUrl, "https://api.deepseek.com");
    assert.equal(snapshot.providers["kimi-coding"]?.selectedModel, "kimi-for-coding");
    assert.equal(snapshot.providers["custom-openai"]?.baseUrl, "http://127.0.0.1:8000/v1");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

type RecordedRequest = {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
};

function contractGateway(
  settings: ModelProviderSettings,
  options: { stream?: boolean; failModels?: boolean } = {},
) {
  const requests: RecordedRequest[] = [];
  const gateway = createOpenAICompatibleGateway({
    settings,
    async fetch(input: string | URL | Request, init?: RequestInit) {
      const url = String(input);
      const headers = new Headers(init?.headers);
      if (url.endsWith("/models") || url.includes("/models?")) {
        if (options.failModels) {
          return Response.json({ error: { message: "models endpoint unavailable" } }, { status: 404 });
        }
        return Response.json({
          data: [{ id: settings.selectedModel, name: "Contract Model" }],
        });
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url, headers, body });
      if (body.stream === true) {
        const sse = [
          `data: ${JSON.stringify({ choices: [{ delta: { content: "{" } }] })}`,
          `data: ${JSON.stringify({ choices: [{ delta: { content: "}" } }] })}`,
          "data: [DONE]",
          "",
        ].join("\n");
        return new Response(sse, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return Response.json({
        model: settings.selectedModel,
        choices: [{
          finish_reason: "stop",
          message: { content: "{\"ok\":true}" },
        }],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      });
    },
  });
  return { gateway, requests };
}

test("DeepSeek contract: pinned URL, Authorization, json_object, thinking mapped to official field", async () => {
  const { gateway, requests } = contractGateway(settingsOf("deepseek"));
  const response = await gateway.chat({
    messages: [{ role: "user", content: "ping" }],
    responseFormat: "json_object",
    thinking: "enabled",
  });
  assert.equal(response.content, "{\"ok\":true}");
  const request = requests[0]!;
  assert.equal(request.url, "https://api.deepseek.com/chat/completions");
  assert.equal(request.headers.get("Authorization"), "Bearer test-key");
  assert.deepEqual(request.body.response_format, { type: "json_object" });
  assert.deepEqual(request.body.thinking, { type: "enabled" });
  assert.equal(request.headers.get("X-OpenRouter-Title"), null, "非 OpenRouter 不得带专有 header");

  const disabled = contractGateway(settingsOf("deepseek"));
  await disabled.gateway.chat({ messages: [{ role: "user", content: "ping" }] });
  assert.deepEqual(disabled.requests[0]!.body.thinking, { type: "disabled" });

  // DeepSeek 缺 key → MODEL_API_KEY_MISSING（不发请求）。
  const noKey = contractGateway(settingsOf("deepseek", { apiKey: "" }));
  await assert.rejects(
    noKey.gateway.chat({ messages: [{ role: "user", content: "ping" }] }),
    (error: unknown) => error instanceof ModelConfigurationError
      && error.code === "MODEL_API_KEY_MISSING",
  );
  assert.equal(noKey.requests.length, 0);

  // discovery：官方 /models，错误安全上抛不吞。
  const discovery = contractGateway(settingsOf("deepseek"));
  const models = await discovery.gateway.discoverModels();
  assert.equal(models[0]?.id, "deepseek-v4-flash");
  const failing = contractGateway(settingsOf("deepseek"), { failModels: true });
  await assert.rejects(failing.gateway.discoverModels());
});

test("Kimi Coding contract: /coding/v1 URLs, auth, tool_choice required downgraded to auto, no invented thinking field", async () => {
  const { gateway, requests } = contractGateway(settingsOf("kimi-coding"));
  await gateway.chat({
    messages: [{ role: "user", content: "ping" }],
    tools: [{
      type: "function",
      function: { name: "use_skill", description: "test", parameters: {} },
    }],
    toolChoice: "required",
    responseFormat: "json_object",
    thinking: "enabled",
  });
  const request = requests[0]!;
  assert.equal(request.url, "https://api.kimi.com/coding/v1/chat/completions");
  assert.equal(request.headers.get("Authorization"), "Bearer test-key");
  assert.equal(request.body.tool_choice, "auto", "required 必须降级为 auto（不得静默失败）");
  assert.equal("thinking" in request.body, false, "不发送臆造 thinking 字段");
  assert.deepEqual(request.body.response_format, { type: "json_object" });

  // tool_choice=auto/none 原样透传；缺 key fail-closed。
  const auto = contractGateway(settingsOf("kimi-coding"));
  await auto.gateway.chat({
    messages: [{ role: "user", content: "ping" }],
    toolChoice: "none",
  });
  assert.equal(auto.requests[0]!.body.tool_choice, "none");
  const noKey = contractGateway(settingsOf("kimi-coding", { apiKey: "" }));
  await assert.rejects(
    noKey.gateway.chat({ messages: [{ role: "user", content: "ping" }] }),
    (error: unknown) => error instanceof ModelConfigurationError
      && error.code === "MODEL_API_KEY_MISSING",
  );

  const models = await contractGateway(settingsOf("kimi-coding")).gateway.discoverModels();
  assert.equal(models[0]?.id, "kimi-for-coding");
});

test("custom-openai contract: custom base URL, optional key, standard fields only, stream SSE", async () => {
  const custom = settingsOf("custom-openai", {
    baseUrl: "http://127.0.0.1:8000/v1",
    apiKey: "",
  });
  const { gateway, requests } = contractGateway(custom);
  await gateway.chat({
    messages: [{ role: "user", content: "ping" }],
    responseFormat: "json_object",
    thinking: "enabled",
  });
  const request = requests[0]!;
  assert.equal(request.url, "http://127.0.0.1:8000/v1/chat/completions");
  assert.equal(request.headers.get("Authorization"), null, "无 key 不发 Authorization");
  assert.deepEqual(request.body.response_format, { type: "json_object" });
  assert.equal("thinking" in request.body, false, "custom 不发送供应商特定扩展字段");

  const keyed = contractGateway(settingsOf("custom-openai", {
    baseUrl: "https://llm.internal.example/v1",
    apiKey: "custom-key",
  }));
  await keyed.gateway.chat({ messages: [{ role: "user", content: "ping" }] });
  assert.equal(keyed.requests[0]!.url, "https://llm.internal.example/v1/chat/completions");
  assert.equal(keyed.requests[0]!.headers.get("Authorization"), "Bearer custom-key");

  // stream：标准 OpenAI-compatible SSE。
  const streaming = contractGateway(custom, { stream: true });
  const chunks: string[] = [];
  for await (const chunk of streaming.gateway.streamChat!({
    messages: [{ role: "user", content: "ping" }],
  })) {
    chunks.push(chunk.content);
  }
  assert.deepEqual(chunks, ["{", "}"]);
  assert.equal(streaming.requests[0]!.body.stream, true);
});

test("provider label and observation identity follow the catalog (no hardcoded two-provider logic)", async () => {
  for (const providerId of ["deepseek", "kimi-coding", "custom-openai"] as const) {
    const { gateway } = contractGateway(settingsOf(providerId));
    assert.equal(gateway.providerId, providerId, "observation 身份必须为 catalog 枚举");
  }
  // 错误信息使用 catalog 名称而非硬编码字符串（无 provider message 时回退
  // `${label} request failed`）。
  const labelGateway = createOpenAICompatibleGateway({
    settings: settingsOf("kimi-coding"),
    async fetch() {
      return new Response("not-json", { status: 404 });
    },
  });
  await assert.rejects(
    labelGateway.discoverModels(),
    (error: unknown) => error instanceof Error && error.message.includes("Kimi Coding"),
  );
});

test("createModelGateway factory covers all five registered providers (no real HTTP)", () => {
  for (const provider of MODEL_PROVIDER_CATALOG) {
    const gateway = createModelGateway(settingsOf(provider.id));
    assert.equal(gateway.providerId, provider.id, `${provider.id} factory 必须返回同身份 gateway`);
    assert.equal(typeof gateway.chat, "function");
    assert.equal(typeof gateway.discoverModels, "function");
    // gateway 对象不得携带 secret/baseUrl/settings 对象。
    const keys = Object.keys(gateway);
    assert.ok(!keys.includes("apiKey") && !keys.includes("baseUrl") && !keys.includes("settings"));
  }
});
