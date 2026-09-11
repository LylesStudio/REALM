import {
  ModelConfigurationError,
  ModelProviderError,
  createModelGateway,
  jsonOutputInstruction,
  requestStructuredObject,
  type ModelGateway,
  type ModelProviderSettings,
  type ModelSettingsStore,
  type PublicModelProviderSettings,
  type PublicModelSettingsSnapshot,
} from "../inference/public.ts";
// server-only：本模块（node:fs/promises）不经 inference/public.ts barrel。
import {
  createLocalModelSettingsStore,
  mergeModelSettings,
  publicModelSettings,
  publicModelSettingsSnapshot,
} from "../inference/local-settings.ts";

export type ModelSettingsDraft = {
  providerId?: unknown;
  baseUrl?: unknown;
  apiKey?: unknown;
  selectedModel?: unknown;
  thinking?: unknown;
  timeoutMs?: unknown;
  maxTokens?: unknown;
};

export interface ModelSettingsService {
  get(): Promise<PublicModelSettingsSnapshot>;
  save(draft: ModelSettingsDraft): Promise<PublicModelSettingsSnapshot>;
  discover(draft: ModelSettingsDraft): Promise<PublicModelSettingsSnapshot>;
  test(draft: ModelSettingsDraft): Promise<{
    settings: PublicModelProviderSettings;
    model: string;
    latencyMs: number;
  }>;
  gateway(): Promise<ModelGateway>;
}

export function createModelSettingsService(options: {
  store: ModelSettingsStore;
  clock?: () => Date;
  createGateway?: (settings: ModelProviderSettings) => ModelGateway;
}): ModelSettingsService {
  const clock = options.clock ?? (() => new Date());
  const gatewayFactory = options.createGateway ?? createModelGateway;

  // Cleanup Phase 4 / Batch 2A→2B：active gateway 的 snapshot cache。
  // key = 不含 secret 的 fingerprint（providerId/selectedModel/thinking/
  // timeoutMs/maxTokens/updatedAt）——服务内 save/discover 都会 bump
  // updatedAt（mergeModelSettings），故设置变化天然 miss；缓存的是同一个
  // Promise，并发请求 single-flight 不重复构造。边界：绕过本服务直接改
  // 设置文件可能保留旧 updatedAt，热更新不在承诺范围（见批次报告）。
  let gatewayCache: { key: string; promise: Promise<ModelGateway> } | null = null;

  function gatewayFingerprint(settings: ModelProviderSettings): string {
    return [
      settings.providerId,
      settings.selectedModel,
      settings.thinking,
      settings.timeoutMs,
      settings.maxTokens,
      settings.updatedAt,
    ].join("|");
  }

  async function cachedGateway(): Promise<ModelGateway> {
    const settings = await options.store.load();
    const key = gatewayFingerprint(settings);
    if (gatewayCache?.key === key) return gatewayCache.promise;
    const promise = Promise.resolve().then(() => gatewayFactory(settings));
    gatewayCache = { key, promise };
    try {
      return await promise;
    } catch (error) {
      // 构造失败不缓存（下次重试重新构造，也不污染旧快照）。
      gatewayCache = null;
      throw error;
    }
  }

  function invalidateGatewayCache(): void {
    gatewayCache = null;
  }

  async function settingsFromDraft(draft: ModelSettingsDraft) {
    const document = await options.store.loadSnapshot();
    const providerId = typeof draft.providerId === "string"
      ? draft.providerId
      : document.activeProviderId;
    const current = document.providers[providerId as keyof typeof document.providers];
    if (!current) {
      throw new ModelConfigurationError(
        "MODEL_PROVIDER_UNSUPPORTED",
        "Only registered model providers can be selected.",
      );
    }
    return mergeModelSettings(current, draft, clock());
  }

  async function snapshot(): Promise<PublicModelSettingsSnapshot> {
    return publicModelSettingsSnapshot(await options.store.loadSnapshot());
  }

  return {
    async get() {
      return snapshot();
    },

    async save(draft) {
      const saved = await settingsFromDraft(draft);
      await options.store.saveProfile(saved, true);
      // 成功落盘后才失效；失败路径不触碰旧缓存（不污染旧快照）。
      invalidateGatewayCache();
      return snapshot();
    },

    async discover(draft) {
      const candidate = await settingsFromDraft(draft);
      // 候选设置的 gateway 直连工厂，不进 active cache（候选 key 不泄漏）。
      const models = await gatewayFactory(candidate).discoverModels();
      const modelId = models.some((model) => model.id === candidate.selectedModel)
        ? candidate.selectedModel
        : models.find((model) => model.costClass === "free")?.id
          ?? models[0]?.id;
      if (!modelId) {
        throw new ModelProviderError(
          "MODEL_RESPONSE_INVALID",
          "模型服务当前没有返回可用模型。",
        );
      }
      await options.store.saveProfile(mergeModelSettings(candidate, {
        selectedModel: modelId,
        availableModels: models,
        lastDiscoveredAt: clock().toISOString(),
      }, clock()), true);
      invalidateGatewayCache();
      return snapshot();
    },

    async test(draft) {
      const candidate = await settingsFromDraft(draft);
      const startedAt = Date.now();
      // Prompt System v2：English-only system + 同源 schema；malformed/schema
      // 失败恰好一次 English 反馈 repair；合法的 {"ok":false} 是业务结果，
      // 不触发 repair；provider/network 错误直接上抛。
      const probeSchema = jsonOutputInstruction([
        { name: "ok", kind: "boolean", note: "true when the connection works" },
      ]);
      const gateway = gatewayFactory(candidate);
      const result = await requestStructuredObject({
        call: async (nextMessages) => {
          const response = await gateway.chat({
            messages: nextMessages,
            responseFormat: "json_object",
            maxTokens: candidate.providerId === "openrouter"
              ? Math.min(candidate.maxTokens, 2_048)
              : 32,
            temperature: 0,
          });
          return {
            content: response.content,
            model: response.model,
            usage: response.usage,
            finishReason: response.finishReason,
          };
        },
        messages: [
          {
            role: "system",
            content: [
              "You are REALM's model connectivity probe.",
              probeSchema,
            ].join("\n"),
          },
          { role: "user", content: "Check the connection. Respond with the JSON object only." },
        ],
        normalize: (body) =>
          typeof body.ok === "boolean" ? { ok: body.ok } : null,
        schemaInstruction: probeSchema,
        code: "MODEL_PROBE_INVALID",
        // Batch 2B-P2：逻辑调用观测（additive；未配置 observer 时 no-op；
        // 观测不改变候选 provider/model 分支或 active cache）。
        observation: {
          stage: "settings-probe",
          providerId: gateway.providerId ?? "unknown",
        },
      });
      if (!result) {
        throw new ModelProviderError(
          "MODEL_RESPONSE_INVALID",
          "模型已响应，但连接探针没有得到有效 JSON。",
        );
      }
      if (result.value.ok !== true) {
        throw new ModelProviderError(
          "MODEL_RESPONSE_INVALID",
          "模型已响应，但没有完成连接探针指令。",
        );
      }
      return {
        settings: publicModelSettings(candidate),
        model: result.model,
        latencyMs: Date.now() - startedAt,
      };
    },

    async gateway() {
      return cachedGateway();
    },
  };
}

let defaultSettingsService: ModelSettingsService | undefined;

export function getModelSettingsService(): ModelSettingsService {
  defaultSettingsService ??= createModelSettingsService({
    store: createLocalModelSettingsStore(),
  });
  return defaultSettingsService;
}

export function modelSettingsErrorResponse(error: unknown): Response {
  if (error instanceof ModelConfigurationError || error instanceof ModelProviderError) {
    const status = error.code === "MODEL_AUTH_FAILED"
      ? 401
      : error.code === "MODEL_RATE_LIMITED"
        ? 429
        : error instanceof ModelConfigurationError
          ? 400
          : 502;
    return Response.json({
      ok: false as const,
      error: { code: error.code, message: error.message },
    }, { status, headers: { "Cache-Control": "no-store" } });
  }
  return Response.json({
    ok: false as const,
    error: {
      code: "MODEL_SETTINGS_INTERNAL_ERROR",
      message: "本机模型设置暂时无法读取。",
    },
  }, { status: 500, headers: { "Cache-Control": "no-store" } });
}
