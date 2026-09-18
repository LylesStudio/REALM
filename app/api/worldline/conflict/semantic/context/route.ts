import { LOCAL_RECORD_SCOPE } from "../../../../../../modules/application/local-record-service.ts";
import {
  getSharedRuntimePool,
  resolveWorldHeadContextForMember,
} from "../../../../world-scope.ts";
import {
  resolveRequestPrincipal,
  unauthorizedResponse,
} from "../../../../auth-context.ts";
import { logRouteInternalError } from "../../../../route-observability.ts";

export const runtime = "nodejs";

/**
 * 批次 T11-D：semantic review 的只读 context 读取
 * （public documentation §3.1）。
 * 前端不手填世界时间：复审 change 的 effectiveCursor 固定为服务端解析出的
 * 当前世界线 head 游标。本路由只做 principal + membership + runtime 检查并
 * 返回游标——不写 evidence、不改任何正史、无迁移。
 */
export const GET = createSemanticReviewContextGet({
  loadContext: (worldId, principalId) => {
    const connectionString = process.env.REALM_RUNTIME_DATABASE_URL;
    if (!connectionString) return Promise.resolve(null);
    return resolveWorldHeadContextForMember(
      getSharedRuntimePool(connectionString),
      {
        workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
        principalId,
        worldId,
      },
    );
  },
  hasRuntime: () => Boolean(process.env.REALM_RUNTIME_DATABASE_URL),
});

export function createSemanticReviewContextGet(deps: {
  loadContext(
    worldId: string,
    principalId: string,
  ): Promise<{
    worldId: string;
    worldlineId: string;
    headTick: number;
    headOrdinal: number;
  } | null>;
  hasRuntime(): boolean;
}) {
  return async function GET(request: Request): Promise<Response> {
    const principalId = resolveRequestPrincipal(request, LOCAL_RECORD_SCOPE.principalId);
    if (!principalId) return unauthorizedResponse();
    const worldId = new URL(request.url).searchParams.get("worldId")?.trim() ?? "";
    if (!worldId) {
      return Response.json(
        {
          ok: false as const,
          error: { code: "INVALID_CONFLICT_INPUT", message: "worldId is required." },
        },
        { status: 400 },
      );
    }
    if (!deps.hasRuntime()) {
      return Response.json(
        { ok: false as const, error: { code: "LOCAL_RUNTIME_NOT_INITIALIZED" } },
        { status: 503 },
      );
    }
    try {
      const context = await deps.loadContext(worldId, principalId);
      if (!context) {
        return Response.json(
          { ok: false as const, error: { code: "WORLD_NOT_FOUND" } },
          { status: 404 },
        );
      }
      return Response.json(
        {
          ok: true as const,
          scope: { worldId: context.worldId, worldlineId: context.worldlineId },
          existingFuture: {
            tick: context.headTick,
            ordinal: context.headOrdinal,
            calendarId: "native",
            display: "",
          },
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch (error) {
      // 读库/内部失败：脱敏结构化诊断 + 安全 500（与 conflict 族路由同型）。
      logRouteInternalError({
        route: "worldline/conflict/semantic/context",
        stage: "semantic-review-context",
        error,
      });
      return Response.json(
        { ok: false as const, error: { code: "INTERNAL_ERROR" } },
        { status: 500 },
      );
    }
  };
}
