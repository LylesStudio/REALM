import { createLobbyService, LobbyError } from "../../../modules/application/lobby-service.ts";
import {
  advertisedOriginFromEnv,
} from "../../../modules/application/advertised-origin.ts";
import { LOCAL_RECORD_SCOPE } from "../../../modules/application/local-record-service.ts";
import { getSharedRuntimePool } from "../world-scope.ts";
import { resolveRequestPrincipal, unauthorizedResponse } from "../auth-context.ts";

export const runtime = "nodejs";

/** 测试/隔离环境可注入更短租约（REALM_LOBBY_LEASE_MS）；缺省 90s。 */
function lobbyLeaseTtlMs(): number | undefined {
  const raw = process.env.REALM_LOBBY_LEASE_MS?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1000 ? value : undefined;
}

function lobbyService(pool: Parameters<typeof createLobbyService>[0]) {
  return createLobbyService(pool, { leaseTtlMs: lobbyLeaseTtlMs() });
}

/**
 * 游戏大厅：GET 列表 / POST 命令面（create-room/join-room/leave-room/
 * close-room）。principal 只来自服务端 session；密码只在 join 的 body
 * 字段（绝不进 URL/日志/错误消息）；列表只返回白名单字段。
 */
function lobbyPool() {
  const connectionString = process.env.REALM_RUNTIME_DATABASE_URL;
  return connectionString ? getSharedRuntimePool(connectionString) : null;
}

function lobbyErrorResponse(error: unknown): Response {
  if (error instanceof LobbyError) {
    const status = error.code === "ROOM_NOT_FOUND"
      ? 404
      : error.code === "NOT_HOST" || error.code === "NOT_MEMBER"
        ? 403
        : error.code === "INVALID_COMMAND"
          ? 400
          : 409;
    return Response.json(
      { ok: false as const, error: { code: error.code, message: error.message } },
      { status },
    );
  }
  return Response.json(
    { ok: false as const, error: { code: "LOBBY_FAILED", message: "大厅操作失败，请稍后重试。" } },
    { status: 500 },
  );
}

export async function GET(request: Request) {
  const principalId = resolveRequestPrincipal(request, LOCAL_RECORD_SCOPE.principalId);
  if (!principalId) return unauthorizedResponse();
  const pool = lobbyPool();
  if (!pool) {
    return Response.json(
      { ok: false as const, error: { code: "LOCAL_RUNTIME_NOT_INITIALIZED" } },
      { status: 503 },
    );
  }
  const url = new URL(request.url);
  const roomId = url.searchParams.get("roomId")?.trim() ?? "";
  const service = lobbyService(pool);
  const scope = { workspaceId: LOCAL_RECORD_SCOPE.workspaceId, principalId };
  try {
    const rooms = await service.listRooms(scope);
    const members = roomId ? await service.listMembers(scope, roomId) : undefined;
    const advertised = advertisedOriginFromEnv();
    return Response.json(
      {
        ok: true as const,
        rooms,
        meta: {
          ...service.describe(),
          // 显式 LAN advertised origin（配置非法时 origin=null + 诊断位，
          // 绝不回退去读 Host/X-Forwarded-Host）。
          advertisedOrigin: advertised.origin,
          advertisedOriginInvalid: advertised.invalid,
        },
        ...(members ? { members } : {}),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return lobbyErrorResponse(error);
  }
}

export async function POST(request: Request) {
  const principalId = resolveRequestPrincipal(request, LOCAL_RECORD_SCOPE.principalId);
  if (!principalId) return unauthorizedResponse();
  const pool = lobbyPool();
  if (!pool) {
    return Response.json(
      { ok: false as const, error: { code: "LOCAL_RUNTIME_NOT_INITIALIZED" } },
      { status: 503 },
    );
  }
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.kind !== "string") {
    return Response.json(
      { ok: false as const, error: { code: "INVALID_REQUEST", message: "kind is required." } },
      { status: 400 },
    );
  }
  const service = lobbyService(pool);
  const scope = { workspaceId: LOCAL_RECORD_SCOPE.workspaceId, principalId };
  try {
    if (body.kind === "create-room") {
      const result = await service.createRoom(scope, {
        name: body.name,
        password: body.password,
        capacity: body.capacity,
        worldId: body.worldId,
      });
      return Response.json(
        { ok: true as const, ...result },
        { status: 201, headers: { "Cache-Control": "no-store" } },
      );
    }
    if (body.kind === "join-room") {
      const result = await service.joinRoom(scope, {
        roomId: body.roomId,
        password: body.password,
      });
      return Response.json(
        { ok: true as const, ...result },
        { status: 200, headers: { "Cache-Control": "no-store" } },
      );
    }
    if (body.kind === "leave-room") {
      await service.leaveRoom(scope, body.roomId);
      return Response.json({ ok: true as const }, { headers: { "Cache-Control": "no-store" } });
    }
    if (body.kind === "close-room") {
      await service.closeRoom(scope, body.roomId);
      return Response.json({ ok: true as const }, { headers: { "Cache-Control": "no-store" } });
    }
    if (body.kind === "heartbeat") {
      // 房主心跳：续租本人 open 房间（服务端时钟权威）；幂等。
      const result = await service.heartbeat(scope);
      return Response.json(
        { ok: true as const, ...result },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    return Response.json(
      { ok: false as const, error: { code: "INVALID_REQUEST", message: "Unknown lobby command." } },
      { status: 400 },
    );
  } catch (error) {
    return lobbyErrorResponse(error);
  }
}
