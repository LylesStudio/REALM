import {
  LOCAL_RECORD_SCOPE,
  LocalRecordServiceError,
  getLocalRecordService,
  type LocalRecordService,
} from "../../../../modules/application/local-record-service.ts";
import {
  resolveRequestPrincipal,
  unauthorizedResponse,
} from "../../auth-context.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const encoder = new TextEncoder();

/**
 * M4 流式 Preview SSE。只广播内存中的 Preview 事件（chunk/end），
 * 不读取、不写入任何持久层；正式事件仍走 /api/record/events。
 * 授权：session principal 先过 Record scope + world membership +
 * viewer 可见性窄检查（authorizeRecordViewer），未通过不创建 SSE
 * body、不订阅任何 preview 事件；principal 绝不来自 query/body。
 */
export async function GET(request: Request) {
  try {
    return await handlePreviewGet(request, await getLocalRecordService());
  } catch (error) {
    return previewRouteError(error);
  }
}

export async function handlePreviewGet(
  request: Request,
  service: LocalRecordService,
): Promise<Response> {
  const principalId = resolveRequestPrincipal(
    request,
    LOCAL_RECORD_SCOPE.principalId,
  );
  if (!principalId) return unauthorizedResponse();
  const url = new URL(request.url);
  const recordId = url.searchParams.get("recordId") ?? LOCAL_RECORD_SCOPE.recordId;
  try {
    // 未知 Record / 非成员 / 无 viewer projection → 404；未初始化 → 503。
    await service.authorizeRecordViewer(recordId, principalId);
  } catch (error) {
    return previewRouteError(error);
  }

  // cleanup 在 start 内赋值；cancel 经此引用调用（与 lobby/graph SSE 同构）。
  let closeFn: () => void = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // 单一幂等清理：heartbeat 失败、subscriber 推送失败、request abort、
      // stream cancel 都汇入同一路径（interval + unsubscribe + close 各一次，
      // 不重复 close/unsubscribe）。此前 heartbeat 失败只 clearInterval——
      // subscriber 残留泄漏进 previewHub。
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // 已关闭。
        }
      };
      const unsubscribe = service.subscribePreviews(recordId, (event) => {
        if (cleaned) return;
        try {
          const name = event.kind === "chunk" ? "preview" : "preview-end";
          controller.enqueue(
            encoder.encode(`event: ${name}\ndata: ${JSON.stringify(event)}\n\n`),
          );
        } catch {
          cleanup();
        }
      });
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          cleanup();
        }
      }, 15_000);
      closeFn = cleanup;
      request.signal.addEventListener("abort", cleanup, { once: true });
    },
    cancel() {
      closeFn();
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

function previewRouteError(error: unknown): Response {
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
        message: "The preview stream could not be opened.",
      },
    },
    { status: 500 },
  );
}
