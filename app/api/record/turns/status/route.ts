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

/** 玩家可见的回合状态。断线后用它恢复阶段，不必再次提交命令。 */
export async function GET(request: Request) {
  try {
    return await handleTurnStatusGet(request, await getLocalRecordService());
  } catch (error) {
    return statusError(error);
  }
}

export async function handleTurnStatusGet(
  request: Request,
  service: LocalRecordService,
): Promise<Response> {
  const principalId = resolveRequestPrincipal(
    request,
    LOCAL_RECORD_SCOPE.principalId,
  );
  if (!principalId) return unauthorizedResponse();
  const url = new URL(request.url);
  const recordId = url.searchParams.get("recordId")?.trim() ?? "";
  const turnId = url.searchParams.get("turnId")?.trim() ?? "";
  if (!recordId || !turnId) {
    return Response.json(
      { ok: false as const, error: { code: "INVALID_REQUEST", message: "recordId and turnId are required." } },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  const status = await service.readTurnStatus(recordId, turnId, principalId);
  return Response.json(
    { ok: true as const, ...status },
    { headers: { "Cache-Control": "no-store" } },
  );
}

function statusError(error: unknown): Response {
  if (error instanceof LocalRecordServiceError) {
    const http = error.code === "NOT_FOUND" ? 404 : 409;
    return Response.json(
      { ok: false as const, error: { code: error.code, message: error.message } },
      { status: http, headers: { "Cache-Control": "no-store" } },
    );
  }
  return Response.json(
    { ok: false as const, error: { code: "TURN_STATUS_FAILED", message: "Turn status could not be read." } },
    { status: 500, headers: { "Cache-Control": "no-store" } },
  );
}
