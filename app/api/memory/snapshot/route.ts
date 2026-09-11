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
 * 批次 T10-B4：记忆快照创建（M3 §2.2 生产入口）。
 * 受限入口：客户端只能传 recordId/kind；workspace/world/worldline/
 * characterInstanceId 与 content/itemIds/cursor/epoch 全服务端生成，
 * 请求体携带这些字段一律忽略。规范：T10-B4-MEMORY-D1-RETIREMENT.md。
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return Response.json(
        { ok: false as const, error: { code: "INVALID_BODY" } },
        { status: 400 },
      );
    }
    const recordId = typeof body.recordId === "string" && body.recordId.trim()
      ? body.recordId.trim()
      : LOCAL_RECORD_SCOPE.recordId;
    const kind = body.kind === undefined
      ? "representation"
      : body.kind === "representation" || body.kind === "recall"
        ? body.kind
        : null;
    if (kind === null) {
      return Response.json(
        {
          ok: false as const,
          error: {
            code: "INVALID_SNAPSHOT_KIND",
            message: "kind must be representation or recall.",
          },
        },
        { status: 400 },
      );
    }
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
    const snapshot = await memory.snapshot({
      workspaceId: scope.workspaceId,
      worldId: scope.worldId,
      worldlineId: scope.worldlineId,
      recordId: scope.recordId,
      characterInstanceId: scope.playerActor.characterInstanceId,
    }, kind);
    if (!snapshot) {
      return Response.json(
        { ok: false as const, error: { code: "NOT_FOUND" } },
        { status: 404 },
      );
    }
    return Response.json(
      { ok: true as const, snapshot },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      {
        ok: false as const,
        error: { code: "INTERNAL_ERROR", message: "暂时无法创建记忆快照。" },
      },
      { status: 500 },
    );
  }
}
