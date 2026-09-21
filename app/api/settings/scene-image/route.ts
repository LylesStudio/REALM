import {
  LOCAL_RECORD_SCOPE,
} from "../../../../modules/application/local-record-service.ts";
import {
  createPostgresAccountRepository,
} from "../../../../database/postgres/public.ts";
import { getSharedRuntimePool } from "../../world-scope.ts";
import {
  normalizeSceneImageMode,
  SCENE_IMAGE_MODES,
} from "../../../../modules/imagine/public.ts";
import {
  resolveRequestPrincipal,
  unauthorizedResponse,
} from "../../auth-context.ts";
import {
  readSceneImageWorkerStatus,
} from "../../../../modules/application/scene-image-status.ts";

export const runtime = "nodejs";

/**
 * 场景图自动模式（账号级）：GET 读当前 principal 偏好；PUT 严格枚举校验
 * 后持久化。只读写当前 session principal——绝不接受/修改他人账号。
 * GET 同时返回 worker 心跳投影（data-home 文件，无 DB 迁移）：online /
 * unavailable（stale/missing/invalid），让 UI 区分「等待后台 Worker」与
 * 真正的「排队中」；不透出 provider URL/prompt_id/凭据。
 */
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
  const mode = await createPostgresAccountRepository(
    getSharedRuntimePool(connectionString),
  ).findSceneImageMode(LOCAL_RECORD_SCOPE.workspaceId, principalId);
  return Response.json(
    { ok: true as const, mode, worker: readSceneImageWorkerStatus() },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function PUT(request: Request) {
  const principalId = resolveRequestPrincipal(request, LOCAL_RECORD_SCOPE.principalId);
  if (!principalId) return unauthorizedResponse();
  const connectionString = process.env.REALM_RUNTIME_DATABASE_URL;
  if (!connectionString) {
    return Response.json(
      { ok: false as const, error: { code: "LOCAL_RUNTIME_NOT_INITIALIZED" } },
      { status: 503 },
    );
  }
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return Response.json(
      { ok: false as const, error: { code: "INVALID_MODE", message: "未知的场景图模式。" } },
      { status: 400 },
    );
  }
  const raw = typeof parsed === "object" && parsed !== null
    ? (parsed as Record<string, unknown>).mode
    : undefined;
  // 严格枚举（不做 fail-closed 静默纠错——写路径必须显式合法）。
  if (typeof raw !== "string" || !(SCENE_IMAGE_MODES as readonly string[]).includes(raw)) {
    return Response.json(
      { ok: false as const, error: { code: "INVALID_MODE", message: "未知的场景图模式。" } },
      { status: 400 },
    );
  }
  const mode = normalizeSceneImageMode(raw);
  await createPostgresAccountRepository(
    getSharedRuntimePool(connectionString),
  ).saveSceneImageMode(LOCAL_RECORD_SCOPE.workspaceId, principalId, mode);
  return Response.json(
    { ok: true as const, mode },
    { headers: { "Cache-Control": "no-store" } },
  );
}
