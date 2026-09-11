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

interface StreamOptions {
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  maxPolls?: number;
}

export async function GET(request: Request) {
  try {
    return handleCommittedEventsGet(request, await getLocalRecordService());
  } catch (error) {
    return streamRouteError(error);
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
  let stopped = false;
  let wakeDelay: (() => void) | undefined;
  let detachAbort: (() => void) | undefined;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let cursor = initialOrdinal;
      let polls = 0;
      let lastWrite = Date.now();

      const close = () => {
        if (stopped) return;
        stopped = true;
        wakeDelay?.();
        controller.close();
      };
      signal.addEventListener("abort", close, { once: true });
      detachAbort = () => signal.removeEventListener("abort", close);
      if (signal.aborted) close();

      void (async () => {
        try {
          while (!stopped && polls < maxPolls) {
            const events = await service.listCommittedEvents(
              recordId,
              cursor,
              principalId,
            );
            for (const event of events) {
              if (stopped) return;
              controller.enqueue(
                encoder.encode(
                  `id: ${event.ordinal}\nevent: committed\ndata: ${JSON.stringify({ event })}\n\n`,
                ),
              );
              cursor = event.ordinal;
              lastWrite = Date.now();
            }
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
