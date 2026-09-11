import {
  LOCAL_RECORD_SCOPE,
} from "../../../../modules/application/local-record-service.ts";
import { createPostgresLibraryService } from "../../../../modules/application/library-service.ts";
import { getSharedRuntimePool } from "../../world-scope.ts";
import { resolveRequestPrincipal, unauthorizedResponse } from "../../auth-context.ts";

export const runtime = "nodejs";

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
    const body = await request.json() as Record<string, unknown>;
    const sourceRecordId = typeof body.recordId === "string" ? body.recordId.trim() : "";
    if (!sourceRecordId) {
      return Response.json(
        { ok: false as const, error: { code: "INVALID_REQUEST", message: "recordId is required." } },
        { status: 400 },
      );
    }
    const service = createPostgresLibraryService(getSharedRuntimePool(connectionString));
    const ids = await service.duplicateRecord(
      { workspaceId: LOCAL_RECORD_SCOPE.workspaceId, principalId },
      sourceRecordId,
    );
    return Response.json(
      { ok: true as const, ...ids },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      {
        ok: false as const,
        error: {
          code: "RECORD_DUPLICATE_FAILED",
          message: "无法复制这条记录，请稍后重试。",
        },
      },
      { status: 400 },
    );
  }
}
