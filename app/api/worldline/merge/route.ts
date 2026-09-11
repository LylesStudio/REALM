import {
  createPostgresWorldlineMergeRepository,
} from "../../../../database/postgres/public.ts";
import {
  WorldlineMergeError,
  createWorldlineMergeService,
} from "../../../../modules/worldline/merge.ts";
import { LOCAL_RECORD_SCOPE } from "../../../../modules/application/local-record-service.ts";
import {
  getSharedRuntimePool,
  resolveWorldScopeForMember,
} from "../../world-scope.ts";
import {
  resolveRequestPrincipal,
  unauthorizedResponse,
} from "../../auth-context.ts";
import { logRouteInternalError } from "../../route-observability.ts";

export const runtime = "nodejs";

/**
 * M5：通用 Worldline 合并；dryRun 只预览冲突不落库。
 * 批次 T10-B1：worldId 显式必填（缺失 400）；作用域经 membership 解析
 * （不存在/非成员 404，不泄露存在性）；审计 operator 恒为已解析
 * principalId，请求体 operator 一律忽略；workspace 只取本地常量。
 */
export async function POST(request: Request) {
  const principalId = resolveRequestPrincipal(request, LOCAL_RECORD_SCOPE.principalId);
  if (!principalId) return unauthorizedResponse();
  const connectionString = process.env.REALM_RUNTIME_DATABASE_URL;
  if (!connectionString) {
    return Response.json(
      { ok: false as const, error: { code: "LOCAL_RUNTIME_NOT_INITIALIZED" } },
      { status: 503 },
    );
  }
  try {
    const body = (await request.json()) as Record<string, unknown>;
    if (
      typeof body.sourceA !== "string"
      || typeof body.sourceB !== "string"
      || typeof body.idempotencyKey !== "string"
    ) {
      return Response.json(
        { ok: false as const, error: { code: "INVALID_REQUEST" } },
        { status: 400 },
      );
    }
    const worldId = typeof body.worldId === "string" ? body.worldId.trim() : "";
    if (!worldId) {
      return Response.json(
        {
          ok: false as const,
          error: { code: "INVALID_REQUEST", message: "worldId is required." },
        },
        { status: 400 },
      );
    }
    const pool = getSharedRuntimePool(connectionString);
    const scope = await resolveWorldScopeForMember(pool, {
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      principalId,
      worldId,
    });
    if (!scope) {
      return Response.json(
        { ok: false as const, error: { code: "WORLD_NOT_FOUND" } },
        { status: 404 },
      );
    }
    const service = createWorldlineMergeService({
      repository: createPostgresWorldlineMergeRepository(pool),
    });
    const result = await service.merge({
      workspaceId: scope.workspaceId,
      worldId: scope.worldId,
      sourceA: body.sourceA,
      sourceB: body.sourceB,
      idempotencyKey: body.idempotencyKey,
      // 审计主体只能来自已解析身份，请求体 operator 不得覆盖。
      operator: principalId,
      dryRun: body.dryRun === true,
    });
    return Response.json(
      { ok: true as const, ...result },
      { status: result.status === "rejected" ? 409 : 200 },
    );
  } catch (error) {
    if (error instanceof WorldlineMergeError) {
      return Response.json(
        { ok: false as const, error: { code: error.code, message: error.message } },
        { status: 404 },
      );
    }
    // 批次 T10-B3：内部故障脱敏结构化诊断（业务 404 已在上方分流，不伪报）。
    logRouteInternalError({ route: "worldline/merge", stage: "request", error });
    return Response.json(
      { ok: false as const, error: { code: "INTERNAL_ERROR" } },
      { status: 500 },
    );
  }
}
