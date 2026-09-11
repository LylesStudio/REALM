import {
  LOCAL_RECORD_SCOPE,
  LocalRecordServiceError,
  getLocalRecordService,
  type LocalRecordService,
} from "../../../modules/application/local-record-service.ts";
import {
  resolveRequestPrincipal,
  unauthorizedResponse,
} from "../auth-context.ts";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    return await handleRecordGet(request, await getLocalRecordService());
  } catch (error) {
    return recordRouteError(error);
  }
}

export async function handleRecordGet(
  request: Request,
  service: LocalRecordService,
): Promise<Response> {
  try {
    const principalId = resolveRequestPrincipal(
      request,
      LOCAL_RECORD_SCOPE.principalId,
    );
    if (!principalId) return unauthorizedResponse();
    const recordId = new URL(request.url).searchParams.get("recordId") ?? undefined;
    if (recordId) {
      // 显式深链：直接打开指定记录（并在成功后写入账号记忆）。
      const result = await service.loadRecord(recordId, principalId);
      return Response.json(
        { ok: true as const, ...result },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    // 批次 S：默认入口解析「上次打开的记录」；无记忆时返回 onboarding
    // 信号，前端渲染创世引导屏，而不是硬编码演示记录。
    const opened = await service.openDefaultRecord(principalId);
    if (opened.kind === "onboarding") {
      return Response.json(
        { ok: true as const, onboarding: true as const },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    return Response.json(
      { ok: true as const, ...opened.envelope },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return recordRouteError(error);
  }
}

function recordRouteError(error: unknown): Response {
  if (error instanceof LocalRecordServiceError) {
    const status = error.code === "NOT_FOUND"
      ? 404
      : error.code === "WRITE_CONFLICT"
        ? 409
        : 503;
    return Response.json(
      {
        ok: false as const,
        error: {
          code: error.code,
          message: error.message,
          ...(error.currentVersion === undefined
            ? {}
            : { currentVersion: error.currentVersion }),
        },
      },
      { status },
    );
  }

  return Response.json(
    {
      ok: false as const,
      error: {
        code: "INTERNAL_ERROR",
        message: "The local runtime could not read this Record.",
      },
    },
    { status: 500 },
  );
}
