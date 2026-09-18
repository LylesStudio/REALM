import pg from "pg";
import {
  createLobbyService,
  LOBBY_CHANGED_CHANNEL,
} from "../../../../modules/application/lobby-service.ts";
import { getSharedRuntimePool } from "../../world-scope.ts";
import { LOCAL_RECORD_SCOPE } from "../../../../modules/application/local-record-service.ts";
import { resolveRequestPrincipal, unauthorizedResponse } from "../../auth-context.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const encoder = new TextEncoder();
const HEARTBEAT_INTERVAL_MS = 25_000;

/**
 * 大厅 SSE：连接即发 snapshot 帧；pg_notify 仅作失效唤醒（载荷只是
 * workspace id），客户端收到 changed 帧后权威重读 GET /api/lobby。
 * 断线由浏览器 EventSource 自动重连（重连即拿到新 snapshot）；
 * 不建账本——大厅状态是小集合，失效即全量重读。
 * 每个 heartbeat tick 还执行一次 lazy reap（过期房间回收），回收事务内的
 * pg_notify 会唤醒全部观察者；无连接则无回收动作。
 */
/** 与 route.ts 同一规则：测试/隔离环境可注入更短租约。 */
function lobbyLeaseTtlMs() {
  const raw = process.env.REALM_LOBBY_LEASE_MS?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1000 ? value : undefined;
}
export async function GET(request: Request) {
  const principalId = resolveRequestPrincipal(request, LOCAL_RECORD_SCOPE.principalId);
  if (!principalId) return unauthorizedResponse();
  const connectionString = process.env.REALM_RUNTIME_DATABASE_URL;
  if (!connectionString) {
    return Response.json(
      { ok: false as const, error: { code: "LOCAL_RUNTIME_NOT_INITIALIZED" } },
      { status: 503 },
    );
  }
  const workspaceId = LOCAL_RECORD_SCOPE.workspaceId;
  // close 由 start 内赋值；cancel 经此引用调用（与图谱 SSE 同构）。
  let closeFn: () => void = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let stopped = false;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const client = new pg.Client({ connectionString });
      const send = (event: string, data: Record<string, unknown>) => {
        if (stopped) return;
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };
      const close = () => {
        if (stopped) return;
        stopped = true;
        if (heartbeat !== undefined) clearInterval(heartbeat);
        client.removeAllListeners("notification");
        void client.end().catch(() => undefined);
        try {
          controller.close();
        } catch { /* already closed */ }
      };
      closeFn = close;
      request.signal.addEventListener("abort", close, { once: true });
      client.on("notification", (message) => {
        // 载荷只作唤醒；内容不可信，客户端总是权威重读。
        if (message.channel === LOBBY_CHANGED_CHANNEL && message.payload === workspaceId) {
          send("changed", { at: Date.now() });
        }
      });
      // lazy reap 的大厅侧触发边界：仅在有客户端连接时，每个 tick 回收过期
      // 房间（回收事务内的 pg_notify 会唤醒本连接与其他观察者）。没有连接
      // 就没有回收动作——文档与 UI 均以此为准。
      const reapTickMs = (() => {
        const raw = process.env.REALM_LOBBY_REAP_MS?.trim();
        const value = Number(raw);
        return Number.isSafeInteger(value) && value >= 500 ? value : HEARTBEAT_INTERVAL_MS;
      })();
      const reapService = createLobbyService(getSharedRuntimePool(connectionString), {
        leaseTtlMs: lobbyLeaseTtlMs(),
      });
      void (async () => {
        await client.connect();
        await client.query(`LISTEN ${LOBBY_CHANGED_CHANNEL}`);
        send("snapshot", { at: Date.now() });
        heartbeat = setInterval(() => {
          if (stopped) return;
          // enqueue 与 close 之间存在固有竞态（abort 与 tick 同帧）——
          // 已关闭的 controller 直接丢弃该拍，不炸进程。
          try {
            controller.enqueue(encoder.encode(`: heartbeat\n\n`));
          } catch {
            close();
          }
          // 回收失败不杀流（下次 tick 再试）；连接级错误由 PG 客户端事件兜底。
          void reapService
            .reapExpired({ workspaceId, principalId })
            .catch(() => undefined);
        }, reapTickMs);
      })().catch(() => close());
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
