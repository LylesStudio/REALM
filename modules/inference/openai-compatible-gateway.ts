import {
  ModelConfigurationError,
  ModelProviderError,
  type DiscoveredModel,
  type ModelChatResponse,
  type ModelGateway,
  type ModelChatRequest,
  type ModelPricing,
  type ModelProviderSettings,
  type ModelToolCall,
} from "./types.ts";

type FetchLike = typeof fetch;

/**
 * OpenAI-compatible 推理网关。
 *
 * 当前注册供应商：
 * - LM Studio：本地 LAN，允许空 API key，保留 json_schema 与 token 下限兼容层；
 * - OpenRouter：官方 HTTPS API，读取标准 Models API pricing，并使用
 *   OpenAI-compatible json_object / tools 请求格式。
 *
 * Source: https://openrouter.ai/docs/api-reference/models/get-models
 * Source: https://openrouter.ai/docs/api-reference/overview
 */
const LM_STUDIO_MIN_MAX_TOKENS = 1024;

type NativeLmStudioRequest = {
  settings: ModelProviderSettings;
  body: Record<string, unknown>;
};

function resolveMaxTokens(input: ModelChatRequest, settings: ModelProviderSettings): number {
  const requested = input.maxTokens ?? settings.maxTokens ?? 2_048;
  return settings.providerId === "lmstudio"
    ? Math.max(requested, LM_STUDIO_MIN_MAX_TOKENS)
    : Math.max(requested, 1);
}

export function createOpenAICompatibleGateway(options: {
  settings: ModelProviderSettings;
  fetch?: FetchLike;
}): ModelGateway {
  const settings = options.settings;
  const request = options.fetch ?? fetch;

  return {
    // 方案 A：观测身份盖章（catalog 枚举，无 secret/settings 对象）。
    providerId: settings.providerId,
    async discoverModels() {
      const path = settings.providerId === "openrouter"
        ? "/models?output_modalities=text&limit=1000"
        : "/models";
      const payload = await requestJson(request, settings, path, {
        method: "GET",
      });
      if (!isObject(payload) || !Array.isArray(payload.data)) {
        throw invalidResponse(`${providerLabel(settings)} returned an invalid model list.`);
      }
      return payload.data
        .map((item) => parseDiscoveredModel(item, settings))
        .sort(compareDiscoveredModels);
    },

    async chat(input) {
      const nativeRequest = createNativeLmStudioRequest(input, settings);
      if (nativeRequest) {
        const payload = await requestJson(
          request,
          nativeRequest.settings,
          "/api/v1/chat",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(nativeRequest.body),
          },
          input.timeoutMs,
          input.signal,
        );
        return parseNativeLmStudioResponse(payload, settings, Boolean(input.responseFormat));
      }
      const payload = await requestJson(
        request,
        settings,
        "/chat/completions",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(chatBody(input, settings, false)),
        },
        // 批次 T11-B：单次调用截止（min(请求覆盖, 设置)）。
        input.timeoutMs,
        input.signal,
      );
      return parseChatResponse(payload, settings);
    },

    async *streamChat(input) {
      const nativeRequest = createNativeLmStudioRequest(input, settings);
      if (nativeRequest) {
        // Native LM Studio has a different SSE event contract. Keep the
        // ModelGateway stream contract stable and yield the filtered final
        // message once, never the separate reasoning output item.
        const payload = await requestJson(
          request,
          nativeRequest.settings,
          "/api/v1/chat",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(nativeRequest.body),
          },
          input.timeoutMs,
          input.signal,
        );
        const response = parseNativeLmStudioResponse(payload, settings, Boolean(input.responseFormat));
        if (response.content) yield { content: response.content };
        return;
      }
      const stream = await requestStream(
        request,
        settings,
        "/chat/completions",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(chatBody(input, settings, true)),
        },
        input.timeoutMs,
        input.signal,
      );
      for await (const content of stream) {
        if (content) yield { content };
      }
    },
  };
}

/**
 * Gemma 4's LM Studio control lives on native `/api/v1/chat`:
 * `reasoning: "off" | "on"`. The OpenAI-compatible endpoint documents no
 * thinking/reasoning parameter and silently ignores those fields. Native chat
 * has no custom-tool or response_format contract. Structured callers therefore
 * rely on the normal REALM JSON parser/normalizer after a local fence cleanup;
 * tool turns stay on `/v1/chat/completions`.
 */
function createNativeLmStudioRequest(
  input: ModelChatRequest,
  settings: ModelProviderSettings,
): NativeLmStudioRequest | null {
  if (settings.providerId !== "lmstudio") return null;
  const model = input.model ?? settings.selectedModel;
  if (!isGemma4Model(model)) return null;
  if ((input.tools?.length ?? 0) > 0 || input.toolChoice) return null;
  const messages = input.messages;
  const userMessages = messages.filter((message) => message.role === "user");
  if (userMessages.length !== 1 || messages.some(
    (message) => message.role !== "system" && message.role !== "user",
  )) {
    return null;
  }
  const systemPrompt = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content.trim())
    .filter(Boolean)
    .join("\n\n");
  const thinking = input.thinking ?? settings.thinking;
  const nativeSettings = {
    ...settings,
    baseUrl: settings.baseUrl.replace(/\/v1\/?$/, ""),
  };
  return {
    settings: nativeSettings,
    body: {
      model,
      input: userMessages[0]!.content,
      ...(systemPrompt ? { system_prompt: systemPrompt } : {}),
      reasoning: thinking === "enabled" ? "on" : "off",
      max_output_tokens: resolveMaxTokens(input, settings),
      temperature: input.temperature ?? 0.35,
      stream: false,
      store: false,
    },
  };
}

function isGemma4Model(model: string): boolean {
  return /(?:^|[/_-])gemma-?4(?:[/_.-]|$)/i.test(model);
}

function parseNativeLmStudioResponse(
  payload: unknown,
  settings: ModelProviderSettings,
  structured: boolean,
): ModelChatResponse {
  if (!isObject(payload) || !Array.isArray(payload.output)) {
    throw invalidResponse(`${providerLabel(settings)} returned an invalid native chat response.`);
  }
  const message = [...payload.output].reverse().find(
    (item) => isObject(item) && item.type === "message" && typeof item.content === "string",
  );
  const stats = isObject(payload.stats) ? payload.stats : null;
  return {
    model: typeof payload.model_instance_id === "string"
      ? payload.model_instance_id
      : settings.selectedModel,
    // Native reasoning items are deliberately ignored; only the final message
    // enters the application response contract.
    content: message && typeof message.content === "string"
      ? structured ? stripJsonCodeFence(message.content) : message.content
      : "",
    toolCalls: [],
    finishReason: "stop",
    usage: stats
      ? {
          promptTokens: numberOrZero(stats.input_tokens),
          completionTokens: numberOrZero(stats.total_output_tokens),
          totalTokens: numberOrZero(stats.input_tokens) + numberOrZero(stats.total_output_tokens),
        }
      : null,
  };
}

function stripJsonCodeFence(content: string): string {
  const trimmed = content.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() ?? trimmed;
}

function parseDiscoveredModel(
  raw: unknown,
  settings: ModelProviderSettings,
): DiscoveredModel {
  if (!isObject(raw) || typeof raw.id !== "string" || !raw.id.trim()) {
    throw invalidResponse(`${providerLabel(settings)} returned an invalid model entry.`);
  }
  const id = raw.id.trim();
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : id;
  const ownedBy = typeof raw.owned_by === "string" && raw.owned_by.trim()
    ? raw.owned_by.trim()
    : settings.providerId;
  const contextLength = typeof raw.context_length === "number"
    && Number.isSafeInteger(raw.context_length)
    && raw.context_length >= 0
    ? raw.context_length
    : null;
  const supportedParameters = Array.isArray(raw.supported_parameters)
    ? raw.supported_parameters.filter((value): value is string => typeof value === "string")
    : null;
  const pricing = settings.providerId === "openrouter"
    ? parseOpenRouterPricing(raw.pricing)
    : null;
  return {
    id,
    name,
    ownedBy,
    contextLength,
    pricing,
    costClass: pricing ? pricingClass(pricing) : "unknown",
    supportsTools: supportedParameters
      ? supportedParameters.includes("tools")
      : null,
    supportsStructuredOutputs: supportedParameters
      ? supportedParameters.includes("structured_outputs")
      : null,
  };
}

function parseOpenRouterPricing(raw: unknown): ModelPricing | null {
  if (!isObject(raw)) return null;
  const prompt = priceNumber(raw.prompt);
  const completion = priceNumber(raw.completion);
  if (prompt === null || completion === null) return null;
  return {
    promptUsdPerToken: prompt,
    completionUsdPerToken: completion,
    requestUsdPerRequest: priceNumber(raw.request),
    imageUsdPerImage: priceNumber(raw.image),
    internalReasoningUsdPerToken: priceNumber(raw.internal_reasoning),
  };
}

function priceNumber(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function pricingClass(pricing: ModelPricing): "free" | "paid" {
  return pricing.promptUsdPerToken === 0 && pricing.completionUsdPerToken === 0
    ? "free"
    : "paid";
}

function compareDiscoveredModels(left: DiscoveredModel, right: DiscoveredModel): number {
  const classRank = { free: 0, paid: 1, unknown: 2 } as const;
  const classDifference = classRank[left.costClass] - classRank[right.costClass];
  if (classDifference !== 0) return classDifference;
  const leftPrice = left.pricing?.promptUsdPerToken ?? Number.POSITIVE_INFINITY;
  const rightPrice = right.pricing?.promptUsdPerToken ?? Number.POSITIVE_INFINITY;
  if (leftPrice !== rightPrice) return leftPrice - rightPrice;
  return left.id.localeCompare(right.id);
}

function chatBody(
  input: ModelChatRequest,
  settings: ModelProviderSettings,
  stream: boolean,
): Record<string, unknown> {
  return {
    model: input.model ?? settings.selectedModel,
    messages: requestMessages(input, settings).map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.name ? { name: message.name } : {}),
      ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
    })),
    ...(input.tools ? { tools: input.tools } : {}),
    ...(input.toolChoice ? { tool_choice: input.toolChoice } : {}),
    ...(input.responseFormat
      ? settings.providerId === "openrouter"
        ? { response_format: { type: "json_object" } }
        : {
            // LM Studio 不接受 OpenAI 式 json_object（仅 json_schema/text）——
            // 适配层翻译为宽松 json_schema，保持既有本地模型契约。
            response_format: {
              type: "json_schema",
              json_schema: {
                name: "realm_structured_output",
                schema: { type: "object" },
              },
            },
          }
      : {}),
    max_tokens: resolveMaxTokens(input, settings),
    temperature: input.temperature ?? 0.35,
    stream,
  };
}

function requestMessages(
  input: ModelChatRequest,
  settings: ModelProviderSettings,
): readonly ModelChatRequest["messages"][number][] {
  // Stealth/Ox Alpha currently rejects system-only chat requests with HTTP 400.
  // OpenRouter accepts a minimal user turn while the business prompt remains
  // in the system message. LM Studio keeps the original sequence unchanged.
  if (
    settings.providerId === "openrouter"
    && input.messages.length > 0
    && input.messages.every((message) => message.role === "system")
  ) {
    return [
      ...input.messages,
      { role: "user", content: "Follow the system instructions and complete the current task." },
    ];
  }
  return input.messages;
}

function authHeaders(settings: ModelProviderSettings): Record<string, string> {
  if (settings.providerId === "openrouter" && !settings.apiKey) {
    throw new ModelConfigurationError(
      "MODEL_API_KEY_MISSING",
      "OpenRouter requires an API key before it can be queried.",
    );
  }
  // apiKey 为空时不发送 Authorization（本地 LM Studio 无需凭证）。
  return settings.apiKey
    ? { Authorization: `Bearer ${settings.apiKey}` }
    : {};
}

/**
 * Batch 2D：把外部取消信号并入 per-call timeout controller。
 * 已 aborted 时立即中止（下游在发起 fetch 前检查，不发请求）；否则注册
 * 一次性转发监听，返回 detach 以便在 timer 清理点一并移除。
 */
function attachExternalSignal(
  controller: AbortController,
  externalSignal: AbortSignal | undefined,
): (() => void) | null {
  if (!externalSignal) return null;
  if (externalSignal.aborted) {
    controller.abort();
    return null;
  }
  const forward = () => controller.abort();
  externalSignal.addEventListener("abort", forward, { once: true });
  return () => externalSignal.removeEventListener("abort", forward);
}

function createAbortError(): Error {
  return Object.assign(new Error("The operation was aborted."), {
    name: "AbortError",
  });
}

function providerHeaders(settings: ModelProviderSettings): Record<string, string> {
  return settings.providerId === "openrouter"
    ? {
        "X-OpenRouter-Title": "REALM",
      }
    : {};
}

async function requestJson(
  fetcher: FetchLike,
  settings: ModelProviderSettings,
  path: string,
  init: RequestInit,
  timeoutOverrideMs?: number,
  externalSignal?: AbortSignal,
): Promise<unknown> {
  const controller = new AbortController();
  // 批次 T11-B：per-call deadline——取 min(请求覆盖, 设置)，到期真正
  // abort 底层 fetch，不是外层 Promise.race 留下后台请求。
  const effectiveTimeoutMs = Math.min(
    timeoutOverrideMs ?? settings.timeoutMs,
    settings.timeoutMs,
  );
  const detach = attachExternalSignal(controller, externalSignal);
  const timeout = setTimeout(() => controller.abort(), effectiveTimeoutMs);
  let response: Response;
  try {
    if (controller.signal.aborted) throw createAbortError();
    response = await fetcher(`${settings.baseUrl}${path}`, {
      ...init,
      headers: {
        ...authHeaders(settings),
        ...providerHeaders(settings),
        Accept: "application/json",
        ...init.headers,
      },
      signal: controller.signal,
    });
  } catch (error) {
    // fetch headers 阶段失败：立即清理（成功路径的清理由 body 阶段 finally 负责）。
    clearTimeout(timeout);
    detach?.();
    if (error instanceof ModelConfigurationError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new ModelProviderError(
        "MODEL_TIMEOUT",
        `${providerLabel(settings)}响应超时，请稍后重试。`,
      );
    }
    throw new ModelProviderError(
      "MODEL_REQUEST_FAILED",
      `无法连接${providerLabel(settings)}，请确认服务在线。`,
    );
  }
  // Batch 2D follow-up：timer/listener 必须覆盖完整 response body 读取与
  // JSON parse 阶段——abort/deadline 在 body 读取中同样真实打断底层流，
  // 并保持既有安全分类（MODEL_TIMEOUT；上层按 signal 归一 TURN_CANCELLED）。
  let payload: unknown;
  try {
    payload = await response.json().catch((error: unknown) => {
      if (error instanceof Error && error.name === "AbortError") throw error;
      return null;
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new ModelProviderError(
        "MODEL_TIMEOUT",
        `${providerLabel(settings)}响应超时，请稍后重试。`,
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    detach?.();
  }
  if (!response.ok) {
    const providerMessage = isObject(payload)
      && isObject(payload.error)
      && typeof payload.error.message === "string"
      ? payload.error.message.slice(0, 300)
      : `${providerLabel(settings)} request failed.`;
    const code = response.status === 401 || response.status === 403
      ? "MODEL_AUTH_FAILED"
      : response.status === 429
        ? "MODEL_RATE_LIMITED"
        : "MODEL_REQUEST_FAILED";
    throw new ModelProviderError(code, providerMessage, response.status);
  }
  return payload;
}

async function requestStream(
  fetcher: FetchLike,
  settings: ModelProviderSettings,
  path: string,
  init: RequestInit,
  timeoutOverrideMs?: number,
  externalSignal?: AbortSignal,
): Promise<AsyncIterable<string>> {
  const controller = new AbortController();
  // 批次 T11-B / Cleanup Phase 4：per-call deadline——取 min(请求覆盖, 设置)，
  // 到期真正 abort 底层 fetch/stream，不是外层 Promise.race 留下后台请求。
  const effectiveTimeoutMs = Math.min(
    timeoutOverrideMs ?? settings.timeoutMs,
    settings.timeoutMs,
  );
  const detach = attachExternalSignal(controller, externalSignal);
  const timeout = setTimeout(() => controller.abort(), effectiveTimeoutMs);
  let response: Response;
  try {
    if (controller.signal.aborted) throw createAbortError();
    response = await fetcher(`${settings.baseUrl}${path}`, {
      ...init,
      headers: {
        ...authHeaders(settings),
        ...providerHeaders(settings),
        Accept: "text/event-stream",
        ...init.headers,
      },
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    detach?.();
    if (error instanceof ModelConfigurationError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new ModelProviderError(
        "MODEL_TIMEOUT",
        `${providerLabel(settings)}响应超时，请稍后重试。`,
      );
    }
    throw new ModelProviderError(
      "MODEL_REQUEST_FAILED",
      `无法连接${providerLabel(settings)}，请确认服务在线。`,
    );
  }
  if (!response.ok || !response.body) {
    clearTimeout(timeout);
    detach?.();
    throw new ModelProviderError(
      response.status === 401 || response.status === 403
        ? "MODEL_AUTH_FAILED"
        : response.status === 429
          ? "MODEL_RATE_LIMITED"
          : "MODEL_REQUEST_FAILED",
      `${providerLabel(settings)} streaming failed with HTTP ${response.status}.`,
      response.status,
    );
  }
  return parseSse(response.body, () => {
    clearTimeout(timeout);
    detach?.();
  });
}

async function* parseSse(
  body: ReadableStream<Uint8Array>,
  onDone: () => void,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        const payload = JSON.parse(data) as unknown;
        const content = streamedContent(payload);
        if (content) yield content;
      }
    }
  } finally {
    onDone();
  }
}

function streamedContent(payload: unknown): string {
  if (!isObject(payload) || !Array.isArray(payload.choices)) return "";
  const choice = payload.choices[0];
  if (!isObject(choice)) return "";
  const delta = choice.delta;
  return isObject(delta) && typeof delta.content === "string" ? delta.content : "";
}

function parseChatResponse(
  payload: unknown,
  settings: ModelProviderSettings,
): ModelChatResponse {
  if (!isObject(payload) || !Array.isArray(payload.choices)) {
    throw invalidResponse(`${providerLabel(settings)} returned an invalid chat response.`);
  }
  const choice = payload.choices[0];
  if (!isObject(choice) || !isObject(choice.message)) {
    throw invalidResponse(`${providerLabel(settings)} returned no assistant message.`);
  }
  const rawToolCalls = Array.isArray(choice.message.tool_calls)
    ? choice.message.tool_calls
    : [];
  const toolCalls = rawToolCalls.map((item): ModelToolCall => {
    if (
      !isObject(item)
      || typeof item.id !== "string"
      || !isObject(item.function)
      || typeof item.function.name !== "string"
      || typeof item.function.arguments !== "string"
    ) {
      throw invalidResponse(`${providerLabel(settings)} returned a malformed tool call.`);
    }
    let parsedArguments: unknown;
    try {
      parsedArguments = JSON.parse(item.function.arguments);
    } catch {
      throw invalidResponse(`${providerLabel(settings)} returned invalid tool arguments.`);
    }
    return { id: item.id, name: item.function.name, arguments: parsedArguments };
  });
  const usage = isObject(payload.usage)
    ? {
        promptTokens: numberOrZero(payload.usage.prompt_tokens),
        completionTokens: numberOrZero(payload.usage.completion_tokens),
        totalTokens: numberOrZero(payload.usage.total_tokens),
      }
    : null;
  return {
    model: typeof payload.model === "string" ? payload.model : "unknown",
    content: typeof choice.message.content === "string" ? choice.message.content : "",
    toolCalls,
    finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : null,
    usage,
  };
}

function providerLabel(settings: ModelProviderSettings): string {
  return settings.providerId === "openrouter" ? "OpenRouter" : "本地 LM Studio";
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidResponse(message: string) {
  return new ModelProviderError("MODEL_RESPONSE_INVALID", message);
}
