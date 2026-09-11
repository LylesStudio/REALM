import {
  createPostgresCharacterMemoryRepository,
  createPostgresRecordRuntimeScopeRepository,
} from "../../../../database/postgres/public.ts";
import {
  createCharacterMemoryService,
} from "../../../../modules/memory/public.ts";
import { LOCAL_RECORD_SCOPE } from "../../../../modules/application/local-record-service.ts";
import { getSharedRuntimePool } from "../../world-scope.ts";
import {
  resolveRequestPrincipal,
  unauthorizedResponse,
} from "../../auth-context.ts";

export const runtime = "nodejs";

/**
 * 批次 T10-B4：记忆快照增量读取（M3 §2.3 生产入口）。
 * delta.stale=true 表示 cache epoch 已递进（update/retract 后），调用方应
 * 重新 snapshot；缺 snapshot/伪造/越界/非成员统一 404。
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const snapshotId = url.searchParams.get("snapshotId")?.trim() ?? "";
    if (!snapshotId) {
      return Response.json(
        {
          ok: false as const,
          error: {
            code: "INVALID_SNAPSHOT_ID",
            message: "snapshotId is required.",
          },
        },
        { status: 400 },
      );
    }
    const recordId = url.searchParams.get("recordId")?.trim()
      || LOCAL_RECORD_SCOPE.recordId;
    const principalId = resolveRequestPrincipal(
      request,
      LOCAL_RECORD_SCOPE.principalId,
    );
    if (!principalId) return unauthorizedResponse();
    const connectionString = process.env.REALM_RUNTIME_DATABASE_URL;
    if (!connectionString) {
      return Response.json(
        { ok: false as const, error: { code: "LOCAL_RUNTIME_NOT_INITIALIZED" } },
        { status: 503 },
      );
    }
    const pool = getSharedRuntimePool(connectionString);
    const scope = await createPostgresRecordRuntimeScopeRepository(pool).resolve({
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      principalId,
      recordId,
    });
    if (!scope) {
      return Response.json(
        { ok: false as const, error: { code: "NOT_FOUND" } },
        { status: 404 },
      );
    }
    const memory = createCharacterMemoryService({
      repository: createPostgresCharacterMemoryRepository(pool),
    });
    const delta = await memory.delta({
      workspaceId: scope.workspaceId,
      worldId: scope.worldId,
      worldlineId: scope.worldlineId,
      recordId: scope.recordId,
      characterInstanceId: scope.playerActor.characterInstanceId,
    }, snapshotId);
    if (!delta) {
      return Response.json(
        { ok: false as const, error: { code: "NOT_FOUND" } },
        { status: 404 },
      );
    }
    return Response.json(
      { ok: true as const, delta },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      {
        ok: false as const,
        error: { code: "INTERNAL_ERROR", message: "暂时无法读取记忆增量。" },
      },
      { status: 500 },
    );
  }
}
