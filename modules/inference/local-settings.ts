import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  MODEL_PROVIDER_CATALOG,
  ModelConfigurationError,
  type DiscoveredModel,
  type ModelCostClass,
  type ModelPricing,
  type ModelProviderId,
  type ModelProviderSettings,
  type ModelSettingsDocument,
  type ModelSettingsStore,
  type PublicModelProviderSettings,
  type PublicModelSettingsSnapshot,
} from "./types.ts";

// 重定位（desktop launcher）：REALM_DATA_HOME 设置时 settings 落到数据目录；
// 未设置时保持开发者既有 .local/settings 行为。
const settingsRoot = process.env.REALM_DATA_HOME?.trim() || resolve(process.cwd(), ".local");
const DEFAULT_SETTINGS_PATH = resolve(
  settingsRoot,
  "settings",
  "model-providers.json",
);
const LEGACY_SETTINGS_PATH = resolve(
  settingsRoot,
  "settings",
  "model-provider.json",
);

type SettingsEnvironment = Readonly<Record<string, string | undefined>>;

type ModelSettingsStoreOptions = {
  filePath?: string;
  legacyFilePath?: string;
  environment?: SettingsEnvironment;
  clock?: () => Date;
};

export function createLocalModelSettingsStore(
  options: ModelSettingsStoreOptions = {},
): ModelSettingsStore {
  const filePath = options.filePath ?? DEFAULT_SETTINGS_PATH;
  const legacyFilePath = options.legacyFilePath ?? LEGACY_SETTINGS_PATH;
  const environment = options.environment ?? process.env;
  const clock = options.clock ?? (() => new Date());

  async function loadSnapshot(): Promise<ModelSettingsDocument> {
    try {
      const raw: unknown = JSON.parse(await readFile(filePath, "utf8"));
      return completeDocument(validateModelSettingsDocument(raw), environment, clock);
    } catch (error) {
      if (!isMissingFile(error)) {
        // 供应商切换迁移：旧配置引用已下架的供应商/端点时按缺省重建，
        // 而不是让应用停在不可用配置。新文档的其他结构错误仍然 fail-closed。
        if (
          error instanceof ModelConfigurationError
          && (error.code === "MODEL_PROVIDER_UNSUPPORTED"
            || error.code === "MODEL_ENDPOINT_NOT_ALLOWED")
        ) {
          return defaultsFromEnvironment(environment, clock);
        }
        if (error instanceof ModelConfigurationError) throw error;
        throw new ModelConfigurationError(
          "MODEL_SETTINGS_INVALID",
          "The local model settings file is not valid JSON.",
        );
      }
    }

    // 迁移既有单供应商文件：不覆盖旧文件，第一次保存时再写新文档。
    try {
      const raw: unknown = JSON.parse(await readFile(legacyFilePath, "utf8"));
      const legacy = validateModelSettings(raw);
      return documentFromLegacy(legacy, environment, clock);
    } catch (error) {
      if (!isMissingFile(error)) {
        if (error instanceof ModelConfigurationError) throw error;
        throw new ModelConfigurationError(
          "MODEL_SETTINGS_INVALID",
          "The legacy local model settings file is not valid JSON.",
        );
      }
    }
    return defaultsFromEnvironment(environment, clock);
  }

  async function saveDocument(input: ModelSettingsDocument): Promise<ModelSettingsDocument> {
    const document = validateModelSettingsDocument(input);
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    await writeFile(
      temporaryPath,
      `${JSON.stringify(document, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, filePath);
    await chmod(filePath, 0o600);
    return document;
  }

  return {
    async load() {
      const document = await loadSnapshot();
      return document.providers[document.activeProviderId];
    },

    async save(input) {
      await this.saveProfile(input, true);
      return input;
    },

    loadSnapshot,

    async saveProfile(input, activate = true) {
      const profile = validateModelSettings(input);
      const current = await loadSnapshot();
      return saveDocument({
        ...current,
        activeProviderId: activate ? profile.providerId : current.activeProviderId,
        providers: {
          ...current.providers,
          [profile.providerId]: profile,
        },
        updatedAt: clock().toISOString(),
      });
    },

    async activate(providerId) {
      const current = await loadSnapshot();
      const profile = current.providers[providerId];
      if (!profile) {
        throw new ModelConfigurationError(
          "MODEL_PROVIDER_UNSUPPORTED",
          "Only registered model providers can be activated.",
        );
      }
      const saved = await saveDocument({
        ...current,
        activeProviderId: providerId,
        updatedAt: clock().toISOString(),
      });
      return saved.providers[saved.activeProviderId];
    },
  };
}

export function publicModelSettings(
  settings: ModelProviderSettings,
): PublicModelProviderSettings {
  const apiKey = settings.apiKey.trim();
  const { apiKey: _secret, ...safeSettings } = settings;
  void _secret;
  return {
    ...safeSettings,
    apiKeyConfigured: apiKey.length > 0,
    apiKeyHint: apiKey.length >= 4 ? `•••• ${apiKey.slice(-4)}` : apiKey ? "••••" : null,
  };
}

export function publicModelSettingsSnapshot(
  document: ModelSettingsDocument,
): PublicModelSettingsSnapshot {
  return {
    schemaVersion: 2,
    activeProviderId: document.activeProviderId,
    providers: MODEL_PROVIDER_CATALOG.map((provider) =>
      publicModelSettings(document.providers[provider.id]),
    ),
    updatedAt: document.updatedAt,
  };
}

export function mergeModelSettings(
  current: ModelProviderSettings,
  patch: {
    providerId?: unknown;
    baseUrl?: unknown;
    apiKey?: unknown;
    selectedModel?: unknown;
    thinking?: unknown;
    timeoutMs?: unknown;
    maxTokens?: unknown;
    availableModels?: ModelProviderSettings["availableModels"];
    lastDiscoveredAt?: string | null;
  },
  now = new Date(),
): ModelProviderSettings {
  return validateModelSettings({
    ...current,
    providerId: patch.providerId ?? current.providerId,
    baseUrl: patch.baseUrl ?? current.baseUrl,
    // 空字符串意味着“沿用现有密钥”，这样公开设置响应回填到 UI
    // 后保存不会误清空本机私密配置。
    apiKey: typeof patch.apiKey === "string" && patch.apiKey.trim()
      ? patch.apiKey.trim()
      : current.apiKey,
    selectedModel: patch.selectedModel ?? current.selectedModel,
    thinking: patch.thinking ?? current.thinking,
    timeoutMs: patch.timeoutMs ?? current.timeoutMs,
    maxTokens: patch.maxTokens ?? current.maxTokens,
    availableModels: patch.availableModels ?? current.availableModels,
    lastDiscoveredAt: patch.lastDiscoveredAt === undefined
      ? current.lastDiscoveredAt
      : patch.lastDiscoveredAt,
    updatedAt: now.toISOString(),
  });
}

export function validateModelSettings(raw: unknown): ModelProviderSettings {
  if (!isObject(raw)) throw invalidSettings();
  const providerId = raw.providerId;
  const provider = providerById(providerId);
  const baseUrl = requireText(raw.baseUrl, "baseUrl", 256).replace(/\/$/, "");
  let endpoint: URL;
  try {
    endpoint = new URL(baseUrl);
  } catch {
    throw invalidSettings("baseUrl must be a valid URL.");
  }
  validateEndpoint(provider, endpoint);
  const apiKey = typeof raw.apiKey === "string" ? raw.apiKey.trim() : "";
  const selectedModel = requireText(raw.selectedModel, "selectedModel", 256);
  // OpenAI 风格 id 允许 publisher/model 与 :free/:thinking 变体。
  if (!/^[-a-zA-Z0-9_.:/[\]]+$/.test(selectedModel)) {
    throw invalidSettings("selectedModel contains unsupported characters.");
  }
  if (raw.thinking !== "enabled" && raw.thinking !== "disabled") {
    throw invalidSettings("thinking must be enabled or disabled.");
  }
  if (
    typeof raw.timeoutMs !== "number"
    || !Number.isSafeInteger(raw.timeoutMs)
    || raw.timeoutMs < 5_000
    || raw.timeoutMs > 120_000
  ) {
    throw invalidSettings("timeoutMs must be between 5,000 and 120,000.");
  }
  const maxTokens = raw.maxTokens === undefined ? 2_048 : raw.maxTokens;
  if (
    typeof maxTokens !== "number"
    || !Number.isSafeInteger(maxTokens)
    || maxTokens < 256
    || maxTokens > 16_384
  ) {
    throw invalidSettings("maxTokens must be between 256 and 16,384.");
  }
  const availableModels = Array.isArray(raw.availableModels)
    ? raw.availableModels.map((item) => parseDiscoveredModel(item))
    : [];
  const lastDiscoveredAt = raw.lastDiscoveredAt === null
    ? null
    : requireIsoDate(raw.lastDiscoveredAt, "lastDiscoveredAt");
  const updatedAt = requireIsoDate(raw.updatedAt, "updatedAt");
  return {
    schemaVersion: 1,
    providerId: provider.id,
    baseUrl,
    apiKey,
    selectedModel,
    thinking: raw.thinking,
    timeoutMs: raw.timeoutMs,
    maxTokens,
    availableModels,
    lastDiscoveredAt,
    updatedAt,
  };
}

export function validateModelSettingsDocument(raw: unknown): ModelSettingsDocument {
  if (!isObject(raw)) throw invalidSettings("The model settings document must be an object.");
  const activeProviderId = providerById(raw.activeProviderId).id;
  if (!isObject(raw.providers)) {
    throw invalidSettings("providers must be an object.");
  }
  const providers = {} as Record<ModelProviderId, ModelProviderSettings>;
  for (const provider of MODEL_PROVIDER_CATALOG) {
    const candidate = raw.providers[provider.id];
    if (candidate !== undefined) providers[provider.id] = validateModelSettings(candidate);
  }
  if (!providers[activeProviderId]) {
    throw invalidSettings("The active provider profile is missing.");
  }
  return {
    schemaVersion: 2,
    activeProviderId,
    providers,
    updatedAt: requireIsoDate(raw.updatedAt, "updatedAt"),
  };
}

function defaultsFromEnvironment(
  environment: SettingsEnvironment,
  clock: () => Date,
): ModelSettingsDocument {
  const profiles = Object.fromEntries(
    MODEL_PROVIDER_CATALOG.map((provider) => [
      provider.id,
      defaultProfile(provider.id, environment, clock),
    ]),
  ) as Record<ModelProviderId, ModelProviderSettings>;
  const activeProviderId = providerByIdOrDefault(environment.REALM_MODEL_PROVIDER).id;
  return {
    schemaVersion: 2,
    activeProviderId,
    providers: profiles,
    updatedAt: clock().toISOString(),
  };
}

function documentFromLegacy(
  legacy: ModelProviderSettings,
  environment: SettingsEnvironment,
  clock: () => Date,
): ModelSettingsDocument {
  const defaults = defaultsFromEnvironment(environment, clock);
  return {
    ...defaults,
    activeProviderId: legacy.providerId,
    providers: {
      ...defaults.providers,
      [legacy.providerId]: legacy,
    },
    updatedAt: legacy.updatedAt,
  };
}

function completeDocument(
  document: ModelSettingsDocument,
  environment: SettingsEnvironment,
  clock: () => Date,
): ModelSettingsDocument {
  const defaults = defaultsFromEnvironment(environment, clock);
  return {
    ...document,
    providers: {
      ...defaults.providers,
      ...document.providers,
    },
  };
}

function defaultProfile(
  providerId: ModelProviderId,
  environment: SettingsEnvironment,
  clock: () => Date,
): ModelProviderSettings {
  const provider = providerById(providerId);
  // 每供应商环境变量覆盖（lmstudio/openrouter 沿用既有变量名以兼容旧部署）；
  // 值只来自环境与 catalog 默认，绝不内置真实地址/key。
  const envBaseUrl = providerId === "openrouter"
    ? environment.REALM_OPENROUTER_BASE_URL
    : providerId === "lmstudio"
      ? environment.REALM_MODEL_BASE_URL
      : undefined;
  const envApiKey = providerId === "openrouter"
    ? environment.OPENROUTER_API_KEY || environment.REALM_OPENROUTER_API_KEY
    : providerId === "deepseek"
      ? environment.DEEPSEEK_API_KEY || environment.REALM_DEEPSEEK_API_KEY
      : providerId === "kimi-coding"
        ? environment.KIMI_API_KEY || environment.REALM_KIMI_API_KEY
        : environment.REALM_MODEL_API_KEY;
  const envModel = providerId === "openrouter"
    ? environment.REALM_OPENROUTER_MODEL
    : providerId === "lmstudio"
      ? environment.REALM_MODEL_ID
      : undefined;
  return validateModelSettings({
    schemaVersion: 1,
    providerId,
    baseUrl: envBaseUrl?.trim() || provider.baseUrl,
    apiKey: envApiKey?.trim() ?? "",
    selectedModel: envModel?.trim() || provider.defaultModel,
    thinking: "disabled",
    timeoutMs: 60_000,
    maxTokens: 2_048,
    availableModels: [],
    lastDiscoveredAt: null,
    updatedAt: clock().toISOString(),
  });
}

function parseDiscoveredModel(raw: unknown): DiscoveredModel {
  if (!isObject(raw)) throw invalidSettings("availableModels is invalid.");
  const id = requireText(raw.id, "availableModels.id", 256);
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : id;
  const ownedBy = typeof raw.ownedBy === "string" && raw.ownedBy.trim()
    ? raw.ownedBy.trim()
    : "unknown";
  const contextLength = raw.contextLength === null || raw.contextLength === undefined
    ? null
    : requireNonNegativeInteger(raw.contextLength, "availableModels.contextLength");
  const pricing = raw.pricing === null || raw.pricing === undefined
    ? null
    : parsePricing(raw.pricing);
  const costClass = raw.costClass === "free" || raw.costClass === "paid" || raw.costClass === "unknown"
    ? raw.costClass
    : pricing ? pricingClass(pricing) : "unknown";
  return {
    id,
    name,
    ownedBy,
    contextLength,
    pricing,
    costClass,
    supportsTools: optionalBoolean(raw.supportsTools),
    supportsStructuredOutputs: optionalBoolean(raw.supportsStructuredOutputs),
  };
}

function parsePricing(raw: unknown): ModelPricing {
  if (!isObject(raw)) throw invalidSettings("availableModels.pricing is invalid.");
  return {
    promptUsdPerToken: requireNonNegativeNumber(
      raw.promptUsdPerToken,
      "availableModels.pricing.promptUsdPerToken",
    ),
    completionUsdPerToken: requireNonNegativeNumber(
      raw.completionUsdPerToken,
      "availableModels.pricing.completionUsdPerToken",
    ),
    requestUsdPerRequest: nullableNonNegativeNumber(
      raw.requestUsdPerRequest,
      "availableModels.pricing.requestUsdPerRequest",
    ),
    imageUsdPerImage: nullableNonNegativeNumber(
      raw.imageUsdPerImage,
      "availableModels.pricing.imageUsdPerImage",
    ),
    internalReasoningUsdPerToken: nullableNonNegativeNumber(
      raw.internalReasoningUsdPerToken,
      "availableModels.pricing.internalReasoningUsdPerToken",
    ),
  };
}

function providerById(value: unknown) {
  const provider = MODEL_PROVIDER_CATALOG.find((item) => item.id === value);
  if (!provider) {
    throw new ModelConfigurationError(
      "MODEL_PROVIDER_UNSUPPORTED",
      "Only registered model providers can be selected.",
    );
  }
  return provider;
}

function providerByIdOrDefault(value: string | undefined) {
  return MODEL_PROVIDER_CATALOG.find((item) => item.id === value) ?? MODEL_PROVIDER_CATALOG[0];
}

/**
 * 端点校验（SSRF 防护；不尝试 DNS 级解析——本机受保护语义，custom 的
 * 远端必须 https 且 UI 明确提示；见 settings 页文案与公开文档）：
 * - 一律拒绝 URL 内嵌 username/password、query、fragment；
 * - pinned：host/路径/协议/端口钉定官方注册值；
 * - local（LM Studio）：仅 loopback/私有地址或 localhost 主机名，路径钉定；
 * - custom：http 仅本机/私有地址，远端必须 https。
 */
function validateEndpoint(
  provider: (typeof MODEL_PROVIDER_CATALOG)[number],
  endpoint: URL,
): void {
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw endpointNotAllowed(provider);
  }
  if (provider.endpointPolicy === "pinned") {
    if (
      !provider.protocols.some((protocol) => protocol === endpoint.protocol)
      || endpoint.hostname !== provider.officialHost
      || !isAllowedPort(provider.port, endpoint.port)
      || endpoint.pathname !== provider.path
    ) {
      throw endpointNotAllowed(provider);
    }
    return;
  }
  if (!provider.protocols.some((protocol) => protocol === endpoint.protocol)) {
    throw endpointNotAllowed(provider);
  }
  const hostname = endpoint.hostname.toLowerCase();
  if (provider.endpointPolicy === "local") {
    if (!isLocalHostname(hostname) || endpoint.pathname !== provider.path) {
      throw endpointNotAllowed(provider);
    }
    return;
  }
  // custom：http 仅本机/私有；远端必须 https；路径有界。
  if (endpoint.protocol === "http:" && !isLocalHostname(hostname)) {
    throw new ModelConfigurationError(
      "MODEL_ENDPOINT_NOT_ALLOWED",
      "Custom endpoints over plain HTTP are restricted to loopback or private LAN addresses.",
    );
  }
  if (endpoint.pathname.length > 128) {
    throw endpointNotAllowed(provider);
  }
}

function endpointNotAllowed(provider: (typeof MODEL_PROVIDER_CATALOG)[number]) {
  return new ModelConfigurationError(
    "MODEL_ENDPOINT_NOT_ALLOWED",
    `The ${provider.name} endpoint is not an allowed registered address.`,
  );
}

/** loopback / localhost 主机名 / RFC1918 / ULA / link-local。 */
function isLocalHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
    || hostname === "[::1]") {
    return true;
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) {
    const [a = 0, b = 0] = hostname.split(".").map(Number);
    return a === 10
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 169 && b === 254)
      || a === 127;
  }
  // IPv6 ULA（fc00::/7）与 link-local（fe80::/10）。
  return hostname.startsWith("fc") || hostname.startsWith("fd")
    || hostname.startsWith("[fc") || hostname.startsWith("[fd")
    || hostname.startsWith("fe8") || hostname.startsWith("[fe8");
}

function isAllowedPort(configuredPort: string, actualPort: string): boolean {
  if (configuredPort) return actualPort === configuredPort;
  return actualPort === "" || actualPort === "443";
}

function pricingClass(pricing: ModelPricing): ModelCostClass {
  return pricing.promptUsdPerToken === 0 && pricing.completionUsdPerToken === 0
    ? "free"
    : "paid";
}

function isMissingFile(error: unknown): boolean {
  return isObject(error) && error.code === "ENOENT";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function requireText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw invalidSettings(`${field} must be a non-empty string of at most ${maxLength} characters.`);
  }
  return value.trim();
}

function requireIsoDate(value: unknown, field: string): string {
  const text = requireText(value, field, 64);
  if (!Number.isFinite(Date.parse(text))) throw invalidSettings(`${field} must be ISO 8601.`);
  return text;
}

function requireNonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw invalidSettings(`${field} must be a non-negative number.`);
  }
  return value;
}

function nullableNonNegativeNumber(value: unknown, field: string): number | null {
  if (value === null) return null;
  return requireNonNegativeNumber(value, field);
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw invalidSettings(`${field} must be a non-negative integer.`);
  }
  return value as number;
}

function invalidSettings(message = "The model settings are invalid.") {
  return new ModelConfigurationError("MODEL_SETTINGS_INVALID", message);
}
