export * from "./types.ts";
// Client/Server 边界修复：local-settings.ts（node:fs/promises）为
// server-only，不得经此 barrel 暴露给 client 可达图；server/test 消费方
// 直接 import modules/inference/local-settings.ts。
export * from "./openai-compatible-gateway.ts";
export * from "./prompt-kit.ts";
export * from "./structured-output.ts";
export * from "./model-call-observer.ts";

import { createOpenAICompatibleGateway } from "./openai-compatible-gateway.ts";
import type { ModelGateway, ModelProviderSettings } from "./types.ts";

export function createModelGateway(settings: ModelProviderSettings): ModelGateway {
  // 五类注册供应商共用同一个 OpenAI-compatible 工厂；closed catalog
  // 由 settings 校验保证（validateModelSettings 拒绝未注册 providerId，
  // 不接受任意自由文本 provider）。
  switch (settings.providerId) {
    case "lmstudio":
    case "openrouter":
    case "deepseek":
    case "kimi-coding":
    case "custom-openai":
      return createOpenAICompatibleGateway({ settings });
    default:
      throw new Error(`Unsupported model provider: ${settings.providerId}`);
  }
}
