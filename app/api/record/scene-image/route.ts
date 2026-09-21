import {
  LOCAL_RECORD_SCOPE,
  LocalRecordServiceError,
} from "../../../../modules/application/local-record-service.ts";
import { createSceneImageService } from "../../../../modules/application/scene-image-service.ts";
import {
  ComfyUiError,
  createComfyUiSettingsStore,
  SceneWorkflowError,
} from "../../../../modules/imagine/public.ts";
import {
  createPostgresRecordRuntimeScopeRepository,
  createPostgresSceneImageStore,
} from "../../../../database/postgres/public.ts";
import { getSharedRuntimePool } from "../../world-scope.ts";
import { resolveRequestPrincipal, unauthorizedResponse } from "../../auth-context.ts";

export const runtime = "nodejs";

/**
 * 场景建立图（T2I）：缺省 prepare-only（返回 prompt + patched graph，
 * dispatched=false）；body 显式 `dispatch: true` → queue + 有界轮询 +
 * 落库（world_files + 台账同事务），ready 返回 `/api/files/<id>`，
 * 进行中/超时返回 status:"running"，失败 status:"failed" + 安全分类码。
 * principal 只来自服务端 session；recordId/seed/dispatch 只来自 body 字段。
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
  let recordId: string = LOCAL_RECORD_SCOPE.recordId;
  let seed: number | undefined;
  let dispatch = false;
  try {
    const body = (await request.json()) as {
      recordId?: unknown;
      seed?: unknown;
      dispatch?: unknown;
    };
    if (typeof body.recordId === "string" && body.recordId.trim()) {
      recordId = body.recordId.trim();
    }
    if (typeof body.seed === "number" && Number.isSafeInteger(body.seed) && body.seed >= 0) {
      seed = body.seed;
    }
    dispatch = body.dispatch === true;
  } catch {
    // 空/非法 body 按默认 record 处理（与 GET 默认记录语义一致）。
  }
  const service = createSceneImageService({
    scopeRepository: createPostgresRecordRuntimeScopeRepository(
      getSharedRuntimePool(connectionString),
    ),
    comfyUiStore: createComfyUiSettingsStore(),
    sceneImageStore: createPostgresSceneImageStore(getSharedRuntimePool(connectionString)),
  });
  try {
    const scope = {
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      principalId,
      recordId,
    };
    const overrides = seed !== undefined ? { seed } : {};
    if (!dispatch) {
      const payload = await service.prepareSceneImageWorkflow(scope, overrides);
      return Response.json({ ok: true as const, ...payload });
    }
    // dispatch:true → queue + 有界轮询 + 落库；ready 返回 /api/files/<id>。
    const result = await service.dispatchAndStoreSceneImage(scope, overrides);
    return Response.json({ ok: true as const, dispatched: true, ...result });
  } catch (error) {
    if (error instanceof LocalRecordServiceError) {
      const status = error.code === "NOT_FOUND" ? 404 : 409;
      return Response.json(
        { ok: false as const, error: { code: error.code, message: error.message } },
        { status },
      );
    }
    if (error instanceof SceneWorkflowError) {
      const status = error.code === "COMFYUI_DISABLED" ? 409 : 500;
      return Response.json(
        { ok: false as const, error: { code: error.code, message: error.message } },
        { status },
      );
    }
    if (error instanceof ComfyUiError) {
      return Response.json(
        { ok: false as const, error: { code: error.code, message: error.message } },
        { status: 502 },
      );
    }
    return Response.json(
      { ok: false as const, error: { code: "INTERNAL_ERROR", message: "场景图准备失败，请稍后重试。" } },
      { status: 500 },
    );
  }
}
