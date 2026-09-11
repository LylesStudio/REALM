import {
  LOCAL_RECORD_SCOPE,
  LocalRecordServiceError,
  getLocalRecordService,
  type LocalRecordService,
} from "../../../../../modules/application/local-record-service.ts";
import {
  resolveRequestPrincipal,
  unauthorizedResponse,
} from "../../../auth-context.ts";

export const runtime = "nodejs";

/**
 * M4：用户显式打断进行中的回合。
 * 授权：session principal 先过 Record scope + world membership +
 * viewer 可见性窄检查（authorizeRecordViewer），未通过不得调用
 * cancelMessage（不能 abort 任何在途 Turn）。product 决策：凡该 Record
 * 的已授权 viewer 均可取消其上的在途回合（与 Preview 同一授权面），
 * 本批不做更严格的发起人绑定。principal/workspace/worldline/viewer
 * 身份绝不来自 body。
 */
export async function POST(request: Request) {
  try {
    return await handleCancelPost(request, await getLocalRecordService());
  } catch (error) {
    return cancelRouteError(error);
  }
}

export async function handleCancelPost(
  request: Request,
  service: LocalRecordService,
): Promise<Response> {
  try {
    const body: unknown = await request.json();
    if (
      typeof body !== "object"
      || body === null
      || typeof (body as Record<string, unknown>).recordId !== "string"
      || typeof (body as Record<string, unknown>).clientMessageId !== "string"
    ) {
      return Response.json(
        { ok: false as const, error: { code: "INVALID_REQUEST" } },
        { status: 400 },
      );
    }
    const { recordId, clientMessageId } = body as {
      recordId: string;
      clientMessageId: string;
    };
    const principalId = resolveRequestPrincipal(
      request,
      LOCAL_RECORD_SCOPE.principalId,
    );
    if (!principalId) return unauthorizedResponse();
    // 未知 Record / 非成员 / 无 viewer projection → 404；未初始化 → 503。
    await service.authorizeRecordViewer(recordId, principalId);
    const cancelled = service.cancelMessage(recordId, clientMessageId);
    return Response.json(
      { ok: true as const, cancelled },
      { status: cancelled ? 202 : 404 },
    );
  } catch (error) {
    return cancelRouteError(error);
  }
}

function cancelRouteError(error: unknown): Response {
  if (error instanceof LocalRecordServiceError) {
    const status = error.code === "NOT_FOUND"
      ? 404
      : error.code === "LOCAL_RUNTIME_NOT_INITIALIZED"
        ? 503
        : 409;
    return Response.json(
      { ok: false as const, error: { code: error.code, message: error.message } },
      { status },
    );
  }
  return Response.json(
    { ok: false as const, error: { code: "INTERNAL_ERROR" } },
    { status: 500 },
  );
}
