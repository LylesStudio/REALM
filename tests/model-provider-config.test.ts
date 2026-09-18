import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MODEL_PROVIDER_CATALOG,
  ModelProviderError,
  createOpenAICompatibleGateway,
  type ModelProviderSettings,
} from "../modules/inference/public.ts";
import {
  createLocalModelSettingsStore,
  publicModelSettings,
} from "../modules/inference/local-settings.ts";
import { createModelSettingsService } from "../modules/application/model-settings-service.ts";

const lmstudioSettings: ModelProviderSettings = {
  schemaVersion: 1,
  providerId: "lmstudio",
  baseUrl: "http://127.0.0.1:1234/v1",
  apiKey: "",
  selectedModel: "unsloth/gemma-4-12b-it-qat",
  thinking: "disabled",
  timeoutMs: 30_000,
  maxTokens: 2_048,
  availableModels: [],
  lastDiscoveredAt: null,
  updatedAt: "2026-08-23T00:00:00.000Z",
};

const openrouterSettings: ModelProviderSettings = {
  schemaVersion: 1,
  providerId: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKey: "test-openrouter-key",
  selectedModel: "meta-llama/llama-3.3-70b-instruct:free",
  thinking: "disabled",
  timeoutMs: 30_000,
  maxTokens: 2_048,
  availableModels: [],
  lastDiscoveredAt: null,
  updatedAt: "2026-08-23T00:00:00.000Z",
};

test("the provider catalog includes a locked-down OpenRouter endpoint", () => {
  const provider = MODEL_PROVIDER_CATALOG.find((item) => item.id === "openrouter");
  assert.ok(provider);
  assert.equal(provider.baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(provider.officialHost, "openrouter.ai");
  assert.deepEqual(provider.protocols, ["https:"]);
});

test("the local store migrates the legacy single-provider file and preserves both profiles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "realm-model-providers-"));
  try {
    const multiPath = join(directory, "model-providers.json");
    const legacyPath = join(directory, "model-provider.json");
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(legacyPath, `${JSON.stringify(lmstudioSettings)}\n`, { mode: 0o600 }));

    const store = createLocalModelSettingsStore({
      filePath: multiPath,
      legacyFilePath: legacyPath,
      environment: {},
    });
    const migrated = await store.loadSnapshot();
    assert.equal(migrated.activeProviderId, "lmstudio");
    // 旧双供应商文档：两个 profile 原样保留，新供应商由 defaults 补齐。
    assert.deepEqual(Object.keys(migrated.providers).sort(), [
      "custom-openai",
      "deepseek",
      "kimi-coding",
      "lmstudio",
      "openrouter",
    ]);
    assert.equal(migrated.providers.lmstudio?.selectedModel, lmstudioSettings.selectedModel);
    assert.equal(migrated.providers.lmstudio?.maxTokens, 2_048);

    await store.saveProfile(openrouterSettings, true);
    const saved = await store.loadSnapshot();
    assert.equal(saved.activeProviderId, "openrouter");
    assert.equal(saved.providers.lmstudio?.selectedModel, lmstudioSettings.selectedModel);
    assert.equal(saved.providers.openrouter?.selectedModel, openrouterSettings.selectedModel);
    assert.match(await readFile(multiPath, "utf8"), /openrouter/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the model settings service returns all public profiles without exposing keys", async () => {
  const directory = await mkdtemp(join(tmpdir(), "realm-model-service-"));
  try {
    const store = createLocalModelSettingsStore({
      filePath: join(directory, "model-providers.json"),
      environment: {},
    });
    await store.saveProfile(openrouterSettings, true);
    const service = createModelSettingsService({ store });
    const snapshot = await service.get();
    assert.equal(snapshot.activeProviderId, "openrouter");
    const openrouter = snapshot.providers.find((profile) => profile.providerId === "openrouter");
    assert.ok(openrouter);
    assert.equal("apiKey" in openrouter, false);
    assert.equal(openrouter.apiKeyConfigured, true);
    assert.equal(openrouter.apiKeyHint, "•••• -key");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("OpenRouter discovery parses per-token pricing and free-model status", async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const gateway = createOpenAICompatibleGateway({
    settings: openrouterSettings,
    async fetch(input: string | URL | Request, init?: RequestInit) {
      requests.push({ url: String(input), init });
      return Response.json({
        data: [
          {
            id: "paid/model",
            name: "Paid Model",
            context_length: 128000,
            supported_parameters: ["tools", "structured_outputs"],
            pricing: { prompt: "0.0000015", completion: "0.000004" },
          },
          {
            id: "free/model:free",
            name: "Free Model",
            context_length: 32768,
            supported_parameters: ["tools"],
            pricing: { prompt: "0", completion: "0", request: "0" },
          },
        ],
      });
    },
  });

  const models = await gateway.discoverModels();
  assert.equal(models.length, 2);
  assert.equal(models[0]?.id, "free/model:free");
  assert.equal(models[0]?.pricing?.promptUsdPerToken, 0);
  assert.equal(models[0]?.pricing?.completionUsdPerToken, 0);
  assert.equal(models[0]?.costClass, "free");
  assert.equal(models[1]?.pricing?.promptUsdPerToken, 0.0000015);
  assert.equal(models[1]?.pricing?.completionUsdPerToken, 0.000004);
  assert.equal(models[1]?.supportsTools, true);
  assert.equal(models[1]?.supportsStructuredOutputs, true);
  assert.equal(requests[0]?.url, "https://openrouter.ai/api/v1/models?output_modalities=text&limit=1000");
  assert.equal(
    new Headers(requests[0]?.init?.headers).get("Authorization"),
    "Bearer test-openrouter-key",
  );
});

test("OpenRouter uses json_object without the LM Studio token floor", async () => {
  let requestBody: Record<string, unknown> = {};
  const gateway = createOpenAICompatibleGateway({
    settings: openrouterSettings,
    async fetch(_input: string | URL | Request, init?: RequestInit) {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        model: openrouterSettings.selectedModel,
        choices: [{
          finish_reason: "stop",
          message: { content: "{\"ok\":true}" },
        }],
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      });
    },
  });

  const response = await gateway.chat({
    messages: [{ role: "user", content: "ping" }],
    responseFormat: "json_object",
    maxTokens: 32,
  });
  assert.equal(response.content, "{\"ok\":true}");
  assert.deepEqual(requestBody?.response_format, { type: "json_object" });
  assert.equal(requestBody?.max_tokens, 32);
});

test("OpenRouter adds a minimal user turn for system-only REALM prompts", async () => {
  let requestBody: Record<string, unknown> = {};
  const gateway = createOpenAICompatibleGateway({
    settings: openrouterSettings,
    async fetch(_input: string | URL | Request, init?: RequestInit) {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        model: openrouterSettings.selectedModel,
        choices: [{ finish_reason: "stop", message: { content: "{\"ok\":true}" } }],
      });
    },
  });

  await gateway.chat({
    messages: [{ role: "system", content: "只输出 JSON。" }],
    responseFormat: "json_object",
  });
  const messages = requestBody.messages as Array<{ role: string; content: string }>;
  assert.deepEqual(messages.map((message) => message.role), ["system", "user"]);
  assert.match(messages[1]!.content, /Follow the system instructions/);
});

test("OpenRouter uses the profile output budget when a call has no override", async () => {
  let requestBody: Record<string, unknown> = {};
  const configured = { ...openrouterSettings, maxTokens: 2048 } as ModelProviderSettings;
  const gateway = createOpenAICompatibleGateway({
    settings: configured,
    async fetch(_input: string | URL | Request, init?: RequestInit) {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        model: configured.selectedModel,
        choices: [{ finish_reason: "stop", message: { content: "ok" } }],
      });
    },
  });

  await gateway.chat({ messages: [{ role: "user", content: "ping" }] });
  assert.equal(requestBody.max_tokens, 2048);
});

test("publicModelSettings still removes provider secrets", () => {
  const exposed = publicModelSettings(openrouterSettings);
  assert.equal("apiKey" in exposed, false);
  assert.equal(exposed.apiKeyConfigured, true);
  assert.equal(exposed.apiKeyHint, "•••• -key");
});

/** 连接探针测试：store + 脚本化 fake gateway。 */
async function probeService(script: (string | Error)[]) {
  const directory = await mkdtemp(join(tmpdir(), "realm-model-probe-"));
  const calls: { messages: readonly { role: string; content: string }[] }[] = [];
  const store = createLocalModelSettingsStore({
    filePath: join(directory, "model-providers.json"),
    environment: {},
  });
  await store.saveProfile(lmstudioSettings, true);
  const service = createModelSettingsService({
    store,
    createGateway: () => ({
      async discoverModels() {
        return [];
      },
      async chat(request) {
        calls.push(request);
        const next = script.shift();
        if (next === undefined) throw new Error("unexpected extra probe call");
        if (next instanceof Error) throw next;
        return {
          model: "probe-model",
          content: next,
          toolCalls: [],
          finishReason: "stop",
          usage: null,
        };
      },
    }),
  });
  return { service, calls, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test("connectivity probe issues exactly one format repair for malformed JSON", async () => {
  const { service, calls, cleanup } = await probeService([
    "```json\n{ok: tru}\n```",
    '{"ok":true}',
  ]);
  try {
    const result = await service.test({ providerId: "lmstudio" });
    assert.equal(result.model, "probe-model");
    assert.equal(calls.length, 2, "malformed → 恰好一次 repair → 成功");
    const repair = calls[1]?.messages.at(-1);
    assert.equal(repair?.role, "user");
    assert.match(repair?.content ?? "", /Return the corrected JSON object only/);
    assert.match(repair?.content ?? "", /"ok": boolean/);
    // 修复反馈不得回显模型原文。
    assert.ok(!(repair?.content ?? "").includes("ok: tru"));
  } finally {
    await cleanup();
  }
});

test("connectivity probe treats a valid ok:false as business failure, zero repair", async () => {
  const { service, calls, cleanup } = await probeService(['{"ok":false}']);
  try {
    await assert.rejects(
      service.test({ providerId: "lmstudio" }),
      (error: unknown) =>
        error instanceof ModelProviderError && error.code === "MODEL_RESPONSE_INVALID",
    );
    assert.equal(calls.length, 1, "业务失败不得触发格式 repair");
  } finally {
    await cleanup();
  }
});

test("connectivity probe propagates provider errors without disguising them as repair", async () => {
  const { service, calls, cleanup } = await probeService([
    new ModelProviderError("MODEL_TIMEOUT", "probe timeout"),
  ]);
  try {
    await assert.rejects(
      service.test({ providerId: "lmstudio" }),
      (error: unknown) =>
        error instanceof ModelProviderError && error.code === "MODEL_TIMEOUT",
    );
    assert.equal(calls.length, 1);
  } finally {
    await cleanup();
  }
});
