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

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const unsubscribe = service.subscribePreviews(recordId, (event) => {
        try {
          const name = event.kind === "chunk" ? "preview" : "preview-end";
          controller.enqueue(
            encoder.encode(`event: ${name}\ndata: ${JSON.stringify(event)}\n\n`),
          );
        } catch {
          // 连接已关闭；清理由 cancel 路径完成。
        }
      });
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          clearInterval(heartbeat);
        }
      }, 15_000);
      request.signal.addEventListener(
        "abort",
        () => {
          clearInterval(heartbeat);
          unsubscribe();
          try {
            controller.close();
          } catch {
            // 已关闭。
          }
        },
        { once: true },
      );
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
