import {
  listAuthorizedExposures,
  resolveRecordViewerContext,
} from "../../../../database/postgres/propagation-exposure-read.ts";
import { LOCAL_RECORD_SCOPE } from "../../../../modules/application/local-record-service.ts";
import {
  resolveRequestPrincipal,
  unauthorizedResponse,
} from "../../auth-context.ts";
import { getSharedRuntimePool } from "../../world-scope.ts";
import { logRouteInternalError } from "../../route-observability.ts";

export const runtime = "nodejs";

/**
 * 批次 T11-G：Propagation Exposure 读取（T11-F §四读取授权矩阵）。
 * - principal 由会话解析；worldId/recordId 必填；record/世界成员关系
 *   服务端校验——未知或不属于请求者 404，不泄露存在性；
 * - 默认 Character 视角：public 可见；non-public 仅当当前 Record 中
 *   principal 控制的 active continuity 命中 Revision audience；
 * - view=control 是 owner 专属控制面审阅（非 owner 403），响应显式
 *   controlPlane 标记——不等于角色已知；
 * - 绝不 fallback public；observer 无控制角色则只看 public。
 */
export async function GET(request: Request) {
  const principalId = resolveRequestPrincipal(request, LOCAL_RECORD_SCOPE.principalId);
  if (!principalId) return unauthorizedResponse();
  const url = new URL(request.url);
  const worldId = url.searchParams.get("worldId")?.trim() ?? "";
  const recordId = url.searchParams.get("recordId")?.trim() ?? "";
  if (!worldId || !recordId) {
    return Response.json(
      { ok: false as const, error: { code: "INVALID_REQUEST", message: "worldId and recordId are required." } },
      { status: 400 },
    );
  }
  const controlPlane = url.searchParams.get("view") === "control";
  const campaignId = url.searchParams.get("campaignId")?.trim() || undefined;

  const connectionString = process.env.REALM_RUNTIME_DATABASE_URL;
  if (!connectionString) {
    return Response.json(
      { ok: false as const, error: { code: "LOCAL_RUNTIME_NOT_INITIALIZED" } },
      { status: 503 },
    );
  }
  try {
    const pool = getSharedRuntimePool(connectionString);
    const viewer = await resolveRecordViewerContext(pool, {
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      recordId,
      principalId,
    });
    if (!viewer || viewer.worldId !== worldId) {
      return Response.json(
        { ok: false as const, error: { code: "WORLD_NOT_FOUND", message: "World not found." } },
        { status: 404 },
      );
    }
    if (controlPlane && viewer.membershipRole !== "owner") {
      return Response.json(
        { ok: false as const, error: { code: "PROPAGATION_CONTROL_FORBIDDEN" } },
        { status: 403 },
      );
    }
    const exposures = await listAuthorizedExposures(
      pool,
      {
        workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
        worldId: viewer.worldId,
        worldlineId: viewer.worldlineId,
      },
      viewer,
      { controlPlane, campaignId },
    );
    return Response.json(
      {
        ok: true as const,
        scope: { worldId: viewer.worldId, worldlineId: viewer.worldlineId },
        controlPlane,
        exposures,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    // 批次 T10-B3 同型：内部失败脱敏诊断 + 安全 500。
    logRouteInternalError({
      route: "propagation/exposures",
      stage: "authorized-read",
      error,
    });
    return Response.json(
      { ok: false as const, error: { code: "INTERNAL_ERROR" } },
      { status: 500 },
    );
  }
}
