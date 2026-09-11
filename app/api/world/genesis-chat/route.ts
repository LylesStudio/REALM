import {
  LOCAL_RECORD_SCOPE,
} from "../../../../modules/application/local-record-service.ts";
import { getModelSettingsService } from "../../../../modules/application/model-settings-service.ts";
import {
  generateGenesisChatReply,
  truncateTranscript,
} from "../../../../modules/application/genesis-chat.ts";
import type { WorldGenesisDraft } from "../../../../modules/application/world-genesis.ts";
import {
  resolveRequestPrincipal,
  unauthorizedResponse,
} from "../../auth-context.ts";

export const runtime = "nodejs";

const MAX_MESSAGE_LENGTH = 500;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 批次 S · 司卷对谈：POST { message, transcript?, draft? }
 * 无状态——客户端携带截断后的对话历史，服务端再截断（最近 16 条、
 * 单条 ≤500 字）。成功返回 { ok, reply, draftPatch, phase, opening }；
 * 任何模型/格式失败一律 ok:false（fail-closed，前端提示「司卷暂时沉默」，
 * 可转旧表单，不阻塞创建）。
 */
export async function POST(request: Request) {
  try {
    const principalId = resolveRequestPrincipal(
      request,
      LOCAL_RECORD_SCOPE.principalId,
    );
    if (!principalId) return unauthorizedResponse();

    const parsed: unknown = await request.json();
    if (!isObject(parsed)) {
      return Response.json(
        {
          ok: false as const,
          error: { code: "INVALID_COMMAND", message: "Malformed genesis chat request." },
        },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    const message = typeof parsed.message === "string"
      ? parsed.message.trim().slice(0, MAX_MESSAGE_LENGTH)
      : "";
    const transcript = truncateTranscript(parsed.transcript);
    const draft = isObject(parsed.draft)
      ? (parsed.draft as Partial<WorldGenesisDraft>)
      : null;

    try {
      const service = getModelSettingsService();
      const [gateway, snapshot] = await Promise.all([service.gateway(), service.get()]);
      const settings = snapshot.providers.find(
        (profile) => profile.providerId === snapshot.activeProviderId,
      );
      if (!settings) throw new Error("Active model provider profile is missing.");
      const fallbackModel = settings.availableModels.find(
        (model) => model.id !== settings.selectedModel,
      )?.id;
      const outcome = await generateGenesisChatReply(gateway, {
        message,
        transcript,
        draft,
        fallbackModel,
      });
      if (!outcome) {
        return Response.json(
          { ok: false as const, error: { code: "SCRIBE_SILENT", message: "" } },
          { status: 200, headers: { "Cache-Control": "no-store" } },
        );
      }
      return Response.json(
        { ok: true as const, ...outcome },
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch (error) {
      // 网关加载失败（未配置/密钥缺失）同样 fail-closed。
      console.warn(
        `[realm] genesis chat unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return Response.json(
        { ok: false as const, error: { code: "SCRIBE_SILENT", message: "" } },
        { status: 200, headers: { "Cache-Control": "no-store" } },
      );
    }
  } catch {
    return Response.json(
      { ok: false as const, error: { code: "SCRIBE_SILENT", message: "" } },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }
}
