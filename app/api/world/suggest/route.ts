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

export const runtime = "nodejs";

const MAX_INTENT_LENGTH = 200;

/**
 * 司卷问答 · AI 代笔：POST { step, intent?, context? }
 * 返回 { ok, suggestions }；任何模型/格式失败一律 ok:false（fail-closed，
 * 前端静默退回手动输入，不弹报错）。
 */
export async function POST(request: Request) {
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
      const gateway = await getModelSettingsService().gateway();
      const suggestions = await generateGenesisSuggestions(gateway, {
        step: parsed.step,
        intent,
        context: context as Record<string, never>,
      });
      if (!suggestions) {
        return Response.json(
          { ok: false as const, error: { code: "NO_SUGGESTION", message: "" } },
          { status: 200, headers: { "Cache-Control": "no-store" } },
        );
      }
      return Response.json(
        { ok: true as const, suggestions },
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch (error) {
      // 网关加载失败（未配置/密钥缺失）同样 fail-closed。
      console.warn(
        `[realm] genesis suggestion unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return Response.json(
        { ok: false as const, error: { code: "NO_SUGGESTION", message: "" } },
        { status: 200, headers: { "Cache-Control": "no-store" } },
      );
    }
  } catch {
    return Response.json(
      { ok: false as const, error: { code: "NO_SUGGESTION", message: "" } },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
