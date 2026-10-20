/**
 * POST /api/record/save — export one authorized Record as `.realm` runtime-save v2.
 *
 * This endpoint is intentionally separate from /api/world/export: world content
 * packs are not runtime saves, and runtime Goal facts never enter `.realmworld`.
 */
import {
  buildRealmRuntimeSaveBytes,
  createPostgresRealmRuntimeSaveReader,
  createPostgresRecordRuntimeScopeRepository,
  RealmRuntimeSaveRepositoryError,
} from "../../../../database/postgres/public.ts";
import { LOCAL_RECORD_SCOPE } from "../../../../modules/application/local-record-service.ts";
import { getSharedRuntimePool } from "../../world-scope.ts";
import {
  resolveRequestPrincipal,
  unauthorizedResponse,
} from "../../auth-context.ts";

export const runtime = "nodejs";

function invalidRequest(message: string): Response {
  return Response.json(
    { ok: false as const, error: { code: "INVALID_REQUEST", message } },
    { status: 400, headers: { "Cache-Control": "no-store" } },
  );
}

function saveError(error: unknown): Response {
  if (error instanceof RealmRuntimeSaveRepositoryError) {
    const status = error.code === "RECORD_NOT_FOUND" ? 404 : error.code === 'WORLD_READ_ONLY' ? 403 : error.code === "RECORD_ARCHIVED" ? 409 : 422;
    return Response.json(
      { ok: false as const, error: { code: error.code, message: error.message } },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
  return Response.json(
    { ok: false as const, error: { code: "RUNTIME_SAVE_FAILED", message: "The runtime save could not be created." } },
    { status: 500, headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request): Promise<Response> {
  const principalId = resolveRequestPrincipal(request, LOCAL_RECORD_SCOPE.principalId);
  if (!principalId) {
    const response = unauthorizedResponse();
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidRequest("Request body must be JSON.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return invalidRequest("Request body must be an object.");
  }
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "recordId")) {
    return invalidRequest("Unknown runtime save request field.");
  }
  if (typeof input.recordId !== "string" || input.recordId.trim() !== input.recordId || input.recordId.length === 0) {
    return invalidRequest("recordId is required.");
  }
  const runtimeUrl = process.env.REALM_RUNTIME_DATABASE_URL;
  if (!runtimeUrl) {
    return Response.json(
      { ok: false as const, error: { code: "RUNTIME_NOT_PROVISIONED", message: "The runtime database is not provisioned." } },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  try {
    const pool = getSharedRuntimePool(runtimeUrl);
    const scope = await createPostgresRecordRuntimeScopeRepository(pool).resolve({
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      principalId,
      recordId: input.recordId,
    });
    if (!scope) {
      return Response.json(
        { ok: false as const, error: { code: "NOT_FOUND", message: "Record not found." } },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      );
    }
    const reader = createPostgresRealmRuntimeSaveReader(pool, { goalsSchemaVersion: 2 });
    const bytes = await buildRealmRuntimeSaveBytes(reader, {
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      recordId: input.recordId,
      principalId,
      purpose: "record-export",
    });
    if (!bytes) {
      return Response.json(
        { ok: false as const, error: { code: "NOT_FOUND", message: "Record not found." } },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      );
    }
    const safeFilename = encodeURIComponent(input.recordId).replaceAll("%", "");
    return new Response(Buffer.from(bytes) as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.realm.save+zip",
        "Content-Disposition": `attachment; filename="${safeFilename}.realm"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return saveError(error);
  }
}
