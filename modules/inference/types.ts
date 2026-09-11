export const MODEL_PROVIDER_CATALOG = [
  {
    id: "lmstudio",
    name: "LM Studio",
    description: "本地 LAN OpenAI-compatible 推理服务。",
    /** OpenAI-compatible 端点必须含 /v1。 */
    baseUrl: "http://127.0.0.1:8823/v1",
    officialHost: "127.0.0.1",
    path: "/v1",
    /** LAN 本地服务：允许 http；端口钉定 8823，拒绝任意外部/未授权端点。 */
    protocols: ["http:", "https:"],
    port: "8823",
    requiresApiKey: false,
    defaultModel: "unsloth/gemma-4-12b-it-qat",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    description: "统一模型路由；模型目录附当前输入/输出费率。",
    baseUrl: "https://openrouter.ai/api/v1",
    officialHost: "openrouter.ai",
    path: "/api/v1",
    /** OpenRouter 只允许官方 HTTPS API，禁止把它改成任意代理地址。 */
    protocols: ["https:"],
    /** 空字符串表示 HTTPS 默认端口；显式 :443 也会被接受。 */
    port: "",
    requiresApiKey: true,
    defaultModel: "openrouter/auto",
  },
] as const;

export type ModelProviderId = (typeof MODEL_PROVIDER_CATALOG)[number]["id"];
export type ModelThinkingMode = "enabled" | "disabled";
export type ModelCostClass = "free" | "paid" | "unknown";

export type ModelPricing = {
  promptUsdPerToken: number;
  completionUsdPerToken: number;
  requestUsdPerRequest: number | null;
  imageUsdPerImage: number | null;
  internalReasoningUsdPerToken: number | null;
};

export type DiscoveredModel = {
  id: string;
  name: string;
  ownedBy: string;
  contextLength: number | null;
  pricing: ModelPricing | null;
  costClass: ModelCostClass;
  supportsTools: boolean | null;
  supportsStructuredOutputs: boolean | null;
};

export type ModelProviderSettings = {
  schemaVersion: 1;
  providerId: ModelProviderId;
  baseUrl: string;
  apiKey: string;
  selectedModel: string;
  thinking: ModelThinkingMode;
  timeoutMs: number;
  /** 默认单次模型调用的输出 token 上限；调用方显式传值时覆盖。 */
  maxTokens: number;
  availableModels: readonly DiscoveredModel[];
  lastDiscoveredAt: string | null;
  updatedAt: string;
};

export type PublicModelProviderSettings = Omit<ModelProviderSettings, "apiKey"> & {
  apiKeyConfigured: boolean;
  apiKeyHint: string | null;
};

export type ModelSettingsDocument = {
  schemaVersion: 2;
  activeProviderId: ModelProviderId;
  providers: Record<ModelProviderId, ModelProviderSettings>;
  updatedAt: string;
};

export type PublicModelSettingsSnapshot = {
  schemaVersion: 2;
  activeProviderId: ModelProviderId;
  providers: readonly PublicModelProviderSettings[];
  updatedAt: string;
};

export type ChatRole = "system" | "user" | "assistant" | "tool";

export type ChatMessage = {
  role: ChatRole;
  content: string;
  name?: string;
  toolCallId?: string;
};

export type FunctionTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type ModelToolCall = {
  id: string;
  name: string;
  arguments: unknown;
};

export type ModelChatRequest = {
  messages: readonly ChatMessage[];
  tools?: readonly FunctionTool[];
  toolChoice?: "auto" | "required" | "none";
  responseFormat?: "json_object";
  maxTokens?: number;
  temperature?: number;
  /** 单次请求的思考模式覆盖；缺省沿用用户配置。 */
  thinking?: ModelThinkingMode;
  /** 单次请求的模型覆盖；缺省沿用用户配置。 */
  model?: string;
  /**
   * 批次 T11-B：单次调用的真实截止（毫秒）。适配层取
   * min(本值, 设置 timeoutMs) 驱动底层 AbortController——不是外层
   * Promise.race 假装超时。
   */
  timeoutMs?: number;
  /**
   * Cleanup Phase 4 / Batch 2D：本地取消信号（true cancellation）。
   * 仅进程内使用——适配层把它并入 per-call timeout controller 真实传给
   * 底层 fetch；绝不序列化进 provider 请求体（body 由 chatBody 逐字段构造，
   * 本字段不可能进入 wire payload）。
   */
  signal?: AbortSignal;
};

export type ModelChatResponse = {
  model: string;
  content: string;
  toolCalls: readonly ModelToolCall[];
  finishReason: string | null;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  } | null;
};

export interface ModelGateway {
  /**
   * provider/profile 观测身份（方案 A）：构造时由 settings 盖章的
   * catalog 枚举（MODEL_PROVIDER_CATALOG 注册 id）——只读、无
   * baseUrl/apiKey/settings 对象。外部/fake 实现缺省不设，观测回退
   * "unknown"。绝不用于请求构造，只用于 ModelCallObservation 归因。
   */
  readonly providerId?: ModelProviderId;
  discoverModels(): Promise<readonly DiscoveredModel[]>;
  chat(request: ModelChatRequest): Promise<ModelChatResponse>;
  streamChat?(request: ModelChatRequest): AsyncIterable<{ content: string }>;
}

export interface ModelSettingsStore {
  /** 当前 active provider；运行时只通过这个入口取配置。 */
  load(): Promise<ModelProviderSettings>;
  /** 兼容旧调用：保存 profile 并将其设为 active。 */
  save(input: ModelProviderSettings): Promise<ModelProviderSettings>;
  loadSnapshot(): Promise<ModelSettingsDocument>;
  saveProfile(input: ModelProviderSettings, activate?: boolean): Promise<ModelSettingsDocument>;
  activate(providerId: ModelProviderId): Promise<ModelProviderSettings>;
}

export class ModelConfigurationError extends Error {
  readonly code:
    | "MODEL_API_KEY_MISSING"
    | "MODEL_PROVIDER_UNSUPPORTED"
    | "MODEL_ENDPOINT_NOT_ALLOWED"
    | "MODEL_SETTINGS_INVALID";

  constructor(
    code:
      | "MODEL_API_KEY_MISSING"
      | "MODEL_PROVIDER_UNSUPPORTED"
      | "MODEL_ENDPOINT_NOT_ALLOWED"
      | "MODEL_SETTINGS_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "ModelConfigurationError";
    this.code = code;
  }
}

export class ModelProviderError extends Error {
  readonly code:
    | "MODEL_AUTH_FAILED"
    | "MODEL_RATE_LIMITED"
    | "MODEL_TIMEOUT"
    | "MODEL_RESPONSE_INVALID"
    | "MODEL_REQUEST_FAILED";
  readonly status?: number;

  constructor(
    code:
      | "MODEL_AUTH_FAILED"
      | "MODEL_RATE_LIMITED"
      | "MODEL_TIMEOUT"
      | "MODEL_RESPONSE_INVALID"
      | "MODEL_REQUEST_FAILED",
    message: string,
    status?: number,
  ) {
    super(message);
    this.name = "ModelProviderError";
    this.code = code;
    this.status = status;
  }
}
