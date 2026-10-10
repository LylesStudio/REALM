import {
  LOCAL_RECORD_SCOPE,
  LocalRecordServiceError,
  getLocalRecordService,
  type LocalRecordService,
} from "../../../../modules/application/local-record-service.ts";
import {
  listenRecordCommitted,
  type RecordCommittedWakeupScope,
  type RecordCommittedWakeupSource,
} from "../../../../database/postgres/record-events.ts";
import {
  resolveRequestPrincipal,
  unauthorizedResponse,
} from "../../auth-context.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const encoder = new TextEncoder();

interface StreamOptions {
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  maxPolls?: number;
  /**
   * Phase 2G-B：生产 NOTIFY 唤醒装配。提供时流不再轮询事件——LISTEN 建立后
   * 做初次 ledger replay，之后仅由 wakeup 触发按 viewer cursor 重读
   * committed ledger。测试 seam 省略它则保留旧的 pollIntervalMs/maxPolls
   * 内存轮询 fallback（纯内存测试专用）。
   */
  wakeup?: (
    scope: RecordCommittedWakeupScope,
  ) => Promise<RecordCommittedWakeupSource>;
}

export async function GET(request: Request) {
  try {
    const service = await getLocalRecordService();
    const connectionString = process.env.REALM_RUNTIME_DATABASE_URL;
    if (!connectionString || !isLoopbackPostgresUrl(connectionString)) {
      // 无本地 runtime PG 时安全 503——不得偷偷回退 750ms 轮询。
      return Response.json(
        {
          ok: false as const,
          error: {
            code: "LOCAL_RUNTIME_NOT_INITIALIZED" as const,
            message:
              "The local committed-event stream requires the local PostgreSQL runtime.",
          },
        },
        { status: 503 },
      );
    }
    return handleCommittedEventsGet(request, service, {
      wakeup: (scope) => listenRecordCommitted(connectionString, scope),
    });
  } catch (error) {
    return streamRouteError(error);
  }
}

/** 与 world-knowledge events 路由同级的回环校验：LISTEN 专用连接不得越界。 */
function isLoopbackPostgresUrl(connectionString: string): boolean {
  try {
    const url = new URL(connectionString);
    if (!["postgres:", "postgresql:"].includes(url.protocol)) return false;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    return ["127.0.0.1", "localhost", "::1"].includes(host);
  } catch {
    return false;
  }
}

export function handleCommittedEventsGet(
  request: Request,
  service: LocalRecordService,
  options: StreamOptions = {},
): Response {
  try {
    const principalId = resolveRequestPrincipal(
      request,
      LOCAL_RECORD_SCOPE.principalId,
    );
    if (!principalId) return unauthorizedResponse();
    const url = new URL(request.url);
    const recordId = url.searchParams.get("recordId") ?? LOCAL_RECORD_SCOPE.recordId;
    const afterOrdinal = parseCursor(
      request.headers.get("Last-Event-ID") ?? url.searchParams.get("afterOrdinal"),
    );
    const body = createCommittedEventStream(
      service,
      recordId,
      afterOrdinal,
      request.signal,
      options,
      principalId,
    );
    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    if (error instanceof CursorError) {
      return Response.json(
        { ok: false as const, error: { code: error.code, message: error.message } },
        { status: 400 },
      );
    }
    return streamRouteError(error);
  }
}

function streamRouteError(error: unknown): Response {
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
        message: "The local committed-event stream could not be opened.",
      },
    },
    { status: 500 },
  );
}

export function createCommittedEventStream(
  service: LocalRecordService,
  recordId: string,
  initialOrdinal: number,
  signal: AbortSignal,
  options: StreamOptions = {},
  principalId?: string,
): ReadableStream<Uint8Array> {
  const pollIntervalMs = options.pollIntervalMs ?? 750;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;
  const maxPolls = options.maxPolls ?? Number.POSITIVE_INFINITY;
  const wakeupFactory = options.wakeup;
  let stopped = false;
  let wakeDelay: (() => void) | undefined;
  let detachAbort: (() => void) | undefined;
  let wakeupSource: RecordCommittedWakeupSource | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const stopHeartbeat = () => {
    if (heartbeat !== undefined) clearInterval(heartbeat);
    heartbeat = undefined;
  };
  const closeWakeup = () => {
    const source = wakeupSource;
    wakeupSource = undefined;
    if (source) void source.close().catch(() => undefined);
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let cursor = initialOrdinal;
      let polls = 0;
      let lastWrite = Date.now();

      const close = () => {
        if (stopped) return;
        stopped = true;
        wakeDelay?.();
        stopHeartbeat();
        closeWakeup();
        try {
          controller.close();
        } catch {
          // 流已关闭。
        }
      };
      signal.addEventListener("abort", close, { once: true });
      detachAbort = () => signal.removeEventListener("abort", close);
      if (signal.aborted) {
        close();
        return;
      }

      // 按 viewer cursor 重读 committed ledger（service projection + viewer
      // scope 过滤）。串行调用——单循环内 await，重复/并发唤醒由 wakeup 源
      // 缓冲合并，cursor 比较去重，绝不乱序或重复 enqueue。
      const drain = async (): Promise<boolean> => {
        const events = await service.listCommittedEvents(
          recordId,
          cursor,
          principalId,
        );
        for (const event of events) {
          if (stopped) return false;
          controller.enqueue(
            encoder.encode(
              `id: ${event.ordinal}\nevent: committed\ndata: ${JSON.stringify({ event })}\n\n`,
            ),
          );
          cursor = event.ordinal;
          lastWrite = Date.now();
        }
        return true;
      };

      void (async () => {
        try {
          if (wakeupFactory) {
            // 生产路径：专用 LISTEN 唤醒。先建立 LISTEN，再做初次 ledger
            // replay（afterOrdinal/Last-Event-ID）——建立竞态由唤醒缓冲
            // + cursor 去重吸收。
            let source: RecordCommittedWakeupSource;
            try {
              source = await wakeupFactory({
                workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
                recordId,
              });
            } catch {
              // LISTEN/连接失败：安全关流；EventSource 携带 Last-Event-ID
              // 重连并从 committed ledger 恢复，绝不回退轮询。
              close();
              return;
            }
            if (stopped) {
              await source.close().catch(() => undefined);
              return;
            }
            wakeupSource = source;
            if (Number.isFinite(heartbeatIntervalMs)) {
              heartbeat = setInterval(() => {
                if (stopped) return;
                try {
                  controller.enqueue(encoder.encode(": heartbeat\n\n"));
                } catch {
                  close();
                }
              }, heartbeatIntervalMs);
            }
            while (!stopped) {
              if (!(await drain())) return;
              // 通知只是唤醒：payload 不进流，按 cursor 重读去重。
              // wait 返回 false = LISTEN 断开/失败 → 关流由客户端重连恢复。
              if (!(await source.wait())) break;
            }
            close();
            return;
          }

          // Legacy 测试 seam：纯内存 fake 的轮询 fallback（生产 GET 不经过）。
          while (!stopped && polls < maxPolls) {
            if (!(await drain())) return;
            polls += 1;
            if (Date.now() - lastWrite >= heartbeatIntervalMs) {
              controller.enqueue(encoder.encode(": heartbeat\n\n"));
              lastWrite = Date.now();
            }
            if (polls < maxPolls) {
              await new Promise<void>((resolve) => {
                const timeout = setTimeout(done, pollIntervalMs);
                wakeDelay = done;
                function done() {
                  clearTimeout(timeout);
                  if (wakeDelay === done) wakeDelay = undefined;
                  resolve();
                }
              });
            }
          }
          close();
        } catch (error) {
          if (
            !signal.aborted
            && !(error instanceof LocalRecordServiceError)
          ) {
            // No internal error details enter the stream; reconnect performs a
            // projection-backed replay from the last delivered viewer cursor.
          }
          close();
        } finally {
          detachAbort?.();
          detachAbort = undefined;
        }
      })();
    },
    cancel() {
      stopped = true;
      wakeDelay?.();
      stopHeartbeat();
      closeWakeup();
      detachAbort?.();
      detachAbort = undefined;
    },
  });
}

function parseCursor(value: string | null): number {
  if (value === null || value === "") return 0;
  if (!/^\d+$/.test(value)) {
    throw new CursorError("INVALID_CURSOR", "afterOrdinal must be a non-negative integer.");
  }
  const ordinal = Number(value);
  if (!Number.isSafeInteger(ordinal)) {
    throw new CursorError("INVALID_CURSOR", "afterOrdinal is outside the safe range.");
  }
  return ordinal;
}

class CursorError extends Error {
  readonly code: "INVALID_CURSOR";

  constructor(code: "INVALID_CURSOR", message: string) {
    super(message);
    this.name = "CursorError";
    this.code = code;
  }
}
