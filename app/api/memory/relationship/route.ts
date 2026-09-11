import {
  createLocalPostgresPool,
  createPostgresCharacterMemoryRepository,
  createPostgresRecordRuntimeScopeRepository,
} from "../../../../database/postgres/public.ts";
import { createCharacterMemoryService } from "../../../../modules/memory/public.ts";
import { LOCAL_RECORD_SCOPE } from "../../../../modules/application/local-record-service.ts";
import {
  resolveRequestPrincipal,
  unauthorizedResponse,
} from "../../auth-context.ts";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const parsed: unknown = await request.json();
    const body = parsed as Record<string, unknown> | null;
    const recordId = typeof body?.recordId === "string" && body.recordId.trim()
      ? body.recordId.trim()
      : LOCAL_RECORD_SCOPE.recordId;
    const principalId = resolveRequestPrincipal(
      request,
      LOCAL_RECORD_SCOPE.principalId,
    );
    if (!principalId) return unauthorizedResponse();
    const targetKey = typeof body?.targetKey === "string" ? body.targetKey.trim() : "";
    const content = typeof body?.content === "string" ? body.content.trim() : "";
    if (!targetKey || !content) {
      return Response.json(
        { ok: false as const, error: { code: "INVALID_INPUT" } },
        { status: 400 },
      );
    }
    const connectionString = process.env.REALM_RUNTIME_DATABASE_URL;
    if (!connectionString) {
      return Response.json(
        { ok: false as const, error: { code: "LOCAL_RUNTIME_NOT_INITIALIZED" } },
        { status: 503 },
      );
    }
    const pool = createLocalPostgresPool(connectionString);
    const scopeRepository = createPostgresRecordRuntimeScopeRepository(pool);
    const scope = await scopeRepository.resolve({
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
    await memory.recordRelationship({
      workspaceId: scope.workspaceId,
      worldId: scope.worldId,
      worldlineId: scope.worldlineId,
      recordId: scope.recordId,
      characterInstanceId: scope.playerActor.characterInstanceId,
      targetKey,
      content,
    });
    return Response.json(
      { ok: true as const },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      { ok: false as const, error: { code: "INTERNAL_ERROR", message: "暂时无法写入关系。" } },
      { status: 500 },
    );
  }
}
