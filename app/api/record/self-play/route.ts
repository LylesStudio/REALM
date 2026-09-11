import {
  LOCAL_RECORD_SCOPE,
  LocalRecordServiceError,
  getLocalRecordService,
} from "../../../../modules/application/local-record-service.ts";
import type { SelfPlaySession } from "../../../../modules/application/self-play.ts";
import {
  resolveRequestPrincipal,
  unauthorizedResponse,
} from "../../auth-context.ts";

export const runtime = "nodejs";

/**
 * 批次 T7：世界自演控制面（docs/development/T7-OBSERVATION-VISION.md §2.5）。
 * POST {recordId, action: "start" | "stop"}：
 * - start 幂等——活动会话在 → 返回现状不重复起拍；
 * - stop 幂等——在途拍跑完，拍边界收束 cancelled；无活动会话返回最近状态。
 * 权限：会话鉴权 + 记录所属世界 membership（服务层快照解析，无则 404 形态）。
 */
export async function POST(request: Request) {
  try {
    const parsed: unknown = await request.json();
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return Response.json(
        {
          ok: false as const,
          error: { code: "INVALID_BODY", message: "Request body must be an object." },
        },
        { status: 400 },
      );
    }
    const principalId = resolveRequestPrincipal(
      request,
      LOCAL_RECORD_SCOPE.principalId,
    );
    if (!principalId) return unauthorizedResponse();
    const body = parsed as { recordId?: unknown; action?: unknown };
    const recordId = typeof body.recordId === "string"
      && body.recordId.trim()
      ? body.recordId.trim()
      : LOCAL_RECORD_SCOPE.recordId;
    const action = body.action;
    if (action !== "start" && action !== "stop") {
      return Response.json(
        {
          ok: false as const,
          error: {
            code: "INVALID_SELF_PLAY_ACTION",
            message: "action must be \"start\" or \"stop\".",
          },
        },
        { status: 400 },
      );
    }
    const service = await getLocalRecordService();
    const session: SelfPlaySession | null = action === "start"
      ? await service.startSelfPlay(recordId, principalId)
      : await service.stopSelfPlay(recordId, principalId);
    return Response.json(
      { ok: true as const, selfPlay: session },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof SyntaxError) {
      return Response.json(
        {
          ok: false as const,
          error: { code: "INVALID_JSON", message: "Request body must be valid JSON." },
        },
        { status: 400 },
      );
    }
    if (error instanceof LocalRecordServiceError) {
      const status = error.code === "NOT_FOUND"
        ? 404
        : error.code === "LOCAL_RUNTIME_NOT_INITIALIZED"
          ? 503
          : 409;
      return Response.json(
        {
          ok: false as const,
          error: { code: error.code, message: error.message },
        },
        { status },
      );
    }
    return Response.json(
      {
        ok: false as const,
        error: {
          code: "INTERNAL_ERROR",
          message: "The local runtime could not complete this request.",
        },
      },
      { status: 500 },
    );
  }
}
