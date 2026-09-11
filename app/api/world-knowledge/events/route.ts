import pg from "pg";
import {
  GRAPH_INVALIDATION_CHANNEL,
  listGraphInvalidationsAfter,
  type GraphInvalidationEvent,
  type GraphInvalidationScope,
} from "../../../../database/postgres/graph-invalidation.ts";
import { LOCAL_RECORD_SCOPE } from "../../../../modules/application/local-record-service.ts";
import {
  resolveRequestPrincipal,
  unauthorizedResponse,
} from "../../auth-context.ts";
import {
  getSharedRuntimePool,
  resolveWorldScopeForMember,
} from "../../world-scope.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const encoder = new TextEncoder();
const HEARTBEAT_INTERVAL_MS = 25_000;
const RETRY_MS = 5_000;

/**
 * 批次 T11-A2：图谱 graph-specific SSE（规范 §三）。
 * 事件只携带失效标记（cursor/作用域/kind），不携带实体/Claim/提案内容；
 * NOTIFY 仅作唤醒，持久化账本（graph_invalidation_events）负责重放恢复。
 * 不复用 /api/record/events，不做轮询降级。
 */
export async function GET(request: Request) {
  const principalId = resolveRequestPrincipal(request, LOCAL_RECORD_SCOPE.principalId);
  if (!principalId) return unauthorizedResponse();
  const connectionString = process.env.REALM_RUNTIME_DATABASE_URL;
  if (!connectionString || !isLoopbackPostgresUrl(connectionString)) {
    return Response.json(
      { ok: false as const, error: { code: "LOCAL_RUNTIME_NOT_INITIALIZED" } },
      { status: 503 },
    );
  }
  const url = new URL(request.url);
  const worldId = url.searchParams.get("worldId")?.trim() ?? "";
  if (!worldId) {
    return Response.json(
      { ok: false as const, error: { code: "INVALID_REQUEST", message: "worldId is required." } },
      { status: 400 },
    );
  }
  let afterCursor: number;
  try {
    afterCursor = parseLastEventId(request.headers.get("Last-Event-ID"));
  } catch {
    return Response.json(
      { ok: false as const, error: { code: "INVALID_REQUEST", message: "Last-Event-ID must be a non-negative integer." } },
      { status: 400 },
    );
  }
  // 成员门禁与 active 世界线解析——未知/非成员 404，不泄露存在性。
  const scope = await resolveWorldScopeForMember(
    getSharedRuntimePool(connectionString),
    { workspaceId: LOCAL_RECORD_SCOPE.workspaceId, principalId, worldId },
  );
  if (!scope) {
    return Response.json(
      { ok: false as const, error: { code: "WORLD_NOT_FOUND", message: "World not found." } },
      { status: 404 },
    );
  }
  const body = createGraphInvalidationStream(connectionString, scope, afterCursor, request.signal);
  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

function parseLastEventId(value: string | null): number {
  if (value === null || value === "") return 0;
  if (!/^\d+$/.test(value)) throw new Error("invalid cursor");
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor)) throw new Error("invalid cursor");
  return cursor;
}

/** 与 createLocalPostgresPool 同级的回环校验：LISTEN 专用连接不得越界。 */
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

export function createGraphInvalidationStream(
  connectionString: string,
  scope: GraphInvalidationScope,
  initialCursor: number,
  signal: AbortSignal,
  options: { heartbeatIntervalMs?: number } = {},
): ReadableStream<Uint8Array> {
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  let stopped = false;
  let lastSentCursor = initialCursor;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let detachAbort: (() => void) | undefined;
  // 每连接一个专用 client（realm_runtime）：LISTEN 长连接不占共享池；
  // 同一连接兼做账本重查（pg 查询串行排队，通知在查询间隙送达）。
  const client = new pg.Client({ connectionString });
  // close 在 start 内赋为携带 controller 的实现；cancel 时经此引用调用。
  let closeFn: () => void = () => {
    stopped = true;
  };

  function formatEvent(event: GraphInvalidationEvent): Uint8Array {
    return encoder.encode(
      `id: ${event.cursor}\nevent: graph-invalidation\ndata: ${JSON.stringify({
        cursor: event.cursor,
        worldId: event.worldId,
        worldlineId: event.worldlineId,
        kind: event.kind,
      })}\n\n`,
    );
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let draining: Promise<void> = Promise.resolve();

      const close = () => {
        if (stopped) return;
        stopped = true;
        if (heartbeat !== undefined) clearInterval(heartbeat);
        heartbeat = undefined;
        client.removeAllListeners("notification");
        void client.end().catch(() => undefined);
        try {
          controller.close();
        } catch {
          // 流已关闭。
        }
      };
      closeFn = close;
      signal.addEventListener("abort", close, { once: true });
      detachAbort = () => signal.removeEventListener("abort", close);
      if (signal.aborted) {
        close();
        return;
      }

      // 账本重查（按作用域 + cursor 过滤——异世界/世界线事件绝不发送，
      // 不依赖客户端过滤）；串行化避免并发重查乱序。
      const drain = () => {
        draining = draining.then(async () => {
          if (stopped) return;
          await client.query("BEGIN READ ONLY");
          try {
            await client.query(
              `SELECT set_config('realm.workspace_id', $1, true)`,
              [scope.workspaceId],
            );
            const events = await listGraphInvalidationsAfter(
              client,
              scope,
              lastSentCursor,
            );
            for (const event of events) {
              if (stopped) return;
              controller.enqueue(formatEvent(event));
              lastSentCursor = event.cursor;
            }
          } finally {
            await client.query("COMMIT").catch(() => undefined);
          }
        }).catch(() => {
          // LISTEN/查询失败：关闭流，浏览器 EventSource 自动携带
          // Last-Event-ID 重连并从账本恢复（账本才是事实来源）。
          close();
        });
      };

      void (async () => {
        try {
          await client.connect();
          // 先 LISTEN 再补发——初次连接竞态：LISTEN 建立后到达的 NOTIFY
          // 触发按 lastSentCursor 去重的重查，不丢不重。
          await client.query(`LISTEN ${GRAPH_INVALIDATION_CHANNEL}`);
          client.on("notification", drain);
          heartbeat = setInterval(() => {
            if (stopped) return;
            try {
              controller.enqueue(encoder.encode(": ping\n\n"));
            } catch {
              close();
            }
          }, heartbeatIntervalMs);
          // 初次重放 Last-Event-ID 之后的账本记录。
          controller.enqueue(encoder.encode(`retry: ${RETRY_MS}\n\n`));
          drain();
        } catch {
          close();
        }
      })();
    },
    cancel() {
      closeFn();
      detachAbort?.();
      detachAbort = undefined;
    },
  });
}
