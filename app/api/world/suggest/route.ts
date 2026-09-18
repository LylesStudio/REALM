import {
  LOCAL_RECORD_SCOPE,
} from "../../../../modules/application/local-record-service.ts";
import { getModelSettingsService } from "../../../../modules/application/model-settings-service.ts";
import {
  generateGenesisSuggestions,
  isGuidedGenesisStep,
} from "../../../../modules/application/genesis-suggestions.ts";
import {
  resolveRequestPrincipal,
  unauthorizedResponse,
} from "../../auth-context.ts";
import type { ModelGateway } from "../../../../modules/inference/public.ts";

export const runtime = "nodejs";

const MAX_INTENT_LENGTH = 200;

/**
 * AI 建议不可用时的安全提示（绝不含 key/Authorization/完整 URL/
 * 连接串/prompt/玩家内容/provider 原始错误）。
 */
const SAFE_UNAVAILABLE_MESSAGE = "AI 建议暂时不可用，请检查模型设置或稍后重试。";

/**
 * AI 引导创建 · AI 代写：POST { step, intent?, context? }
 * 返回 { ok, suggestions }；模型未配置/缺 key/请求失败/结构化解析失败
 * 一律 ok:false + 固定安全提示（fail-closed，手动填写不受影响）。
 */
export async function POST(request: Request) {
  return handleSuggestPost(request);
}

/** 可注入 gateway 的处理器（生产走 settings service；测试注入 fake）。 */
export async function handleSuggestPost(
  request: Request,
  options: { gateway?: ModelGateway } = {},
): Promise<Response> {
  try {
    const principalId = resolveRequestPrincipal(
      request,
      LOCAL_RECORD_SCOPE.principalId,
    );
    if (!principalId) return unauthorizedResponse();

    const parsed: unknown = await request.json();
    if (!isObject(parsed) || !isGuidedGenesisStep(parsed.step)) {
      return Response.json(
        {
          ok: false as const,
          error: { code: "INVALID_COMMAND", message: "Unknown suggestion step." },
        },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    const intent = typeof parsed.intent === "string"
      ? parsed.intent.trim().slice(0, MAX_INTENT_LENGTH)
      : "";
    const context = isObject(parsed.context) ? parsed.context : {};

    try {
      const gateway = options.gateway ?? await getModelSettingsService().gateway();
      const suggestions = await generateGenesisSuggestions(gateway, {
        step: parsed.step,
        intent,
        context: context as Record<string, never>,
      });
      if (!suggestions) {
        return Response.json(
          {
            ok: false as const,
            error: { code: "NO_SUGGESTION", message: SAFE_UNAVAILABLE_MESSAGE },
          },
          { status: 200, headers: { "Cache-Control": "no-store" } },
        );
      }
      return Response.json(
        { ok: true as const, suggestions },
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch (error) {
      // 网关加载失败（未配置/密钥缺失）/ provider 错误同样 fail-closed。
      // 只记录固定事件，避免把原始 provider 错误写入日志。
      void error;
      console.warn("[realm] genesis suggestion unavailable");
      return Response.json(
        {
          ok: false as const,
          error: { code: "NO_SUGGESTION", message: SAFE_UNAVAILABLE_MESSAGE },
        },
        { status: 200, headers: { "Cache-Control": "no-store" } },
      );
    }
  } catch {
    return Response.json(
      {
        ok: false as const,
        error: { code: "NO_SUGGESTION", message: SAFE_UNAVAILABLE_MESSAGE },
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
