import { createPostgresCanonQualificationReader } from "../../../../database/postgres/canon-qualification.ts";
import {
  createPostgresPropagationNodeAudienceGovernance,
  PropagationNodeAudienceError,
} from "../../../../database/postgres/propagation-node-audiences.ts";
import { LOCAL_RECORD_SCOPE } from "../../../../modules/application/local-record-service.ts";
import {
  resolveRequestPrincipal,
  unauthorizedResponse,
} from "../../auth-context.ts";
import {
  getSharedRuntimePool,
  resolveWorldScopeForMember,
} from "../../world-scope.ts";

export const runtime = "nodejs";

function runtimePool() {
  const connectionString = process.env.REALM_RUNTIME_DATABASE_URL;
  return connectionString ? getSharedRuntimePool(connectionString) : null;
}

async function resolveScope(
  request: Request,
  principalId: string,
  bodyWorldId?: unknown,
) {
  const rawWorldId = typeof bodyWorldId === "string" && bodyWorldId.trim()
    ? bodyWorldId.trim()
    : new URL(request.url).searchParams.get("worldId")?.trim() ?? "";
  if (!rawWorldId) {
    return {
      scope: null,
      error: Response.json(
        { ok: false as const, error: { code: "INVALID_REQUEST", message: "worldId is required." } },
        { status: 400 },
      ),
    };
  }
  const pool = runtimePool();
  if (!pool) {
    return {
      scope: null,
      error: Response.json(
        { ok: false as const, error: { code: "LOCAL_RUNTIME_NOT_INITIALIZED" } },
        { status: 503 },
      ),
    };
  }
  const scope = await resolveWorldScopeForMember(pool, {
    workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
    principalId,
    worldId: rawWorldId,
  });
  if (!scope) {
    return {
      scope: null,
      error: Response.json(
        { ok: false as const, error: { code: "WORLD_NOT_FOUND", message: "World not found." } },
        { status: 404 },
      ),
    };
  }
  return { scope, error: undefined };
}

async function qualification(request: Request, principalId: string) {
  const pool = runtimePool();
  if (!pool) {
    return Response.json(
      { ok: false as const, error: { code: "LOCAL_RUNTIME_NOT_INITIALIZED" } },
      { status: 503 },
    );
  }
  const resolved = await resolveScope(request, principalId);
  if (resolved.error) return resolved.error;
  const value = await createPostgresCanonQualificationReader(pool).load(
    resolved.scope!,
    principalId,
  );
  if (!value) {
    return Response.json(
      { ok: false as const, error: { code: "WORLD_NOT_FOUND", message: "World not found." } },
      { status: 404 },
    );
  }
  return Response.json(
    { ok: true as const, qualification: value },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * T11-I-A：映射管理面共用资格 payload；读操作不泄露跨 workspace/worldline。
 */
export async function GET(request: Request) {
  const principalId = resolveRequestPrincipal(request, LOCAL_RECORD_SCOPE.principalId);
  if (!principalId) return unauthorizedResponse();
  return qualification(request, principalId);
}

function requestText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 160 ? normalized : null;
}

function errorResponse(error: PropagationNodeAudienceError) {
  const status = error.code === "PROPAGATION_AUDIENCE_OWNER_REQUIRED" ? 403
    : error.code === "PROPAGATION_AUDIENCE_INVALID_INPUT" || error.code === "PROPAGATION_AUDIENCE_SCOPE_REQUIRED"
      ? 400
      : 409;
  return Response.json(
    { ok: false as const, error: { code: error.code } },
    { status },
  );
}

/** T11-I-A：只允许 owner 通过单动作 append function 新增映射；无 update/delete。 */
export async function POST(request: Request) {
  const principalId = resolveRequestPrincipal(request, LOCAL_RECORD_SCOPE.principalId);
  if (!principalId) return unauthorizedResponse();
  const pool = runtimePool();
  if (!pool) {
    return Response.json(
      { ok: false as const, error: { code: "LOCAL_RUNTIME_NOT_INITIALIZED" } },
      { status: 503 },
    );
  }
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return Response.json(
        { ok: false as const, error: { code: "INVALID_REQUEST" } },
        { status: 400 },
      );
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return Response.json(
      { ok: false as const, error: { code: "INVALID_REQUEST" } },
      { status: 400 },
    );
  }
  const worldId = requestText(body.worldId);
  const nodeKey = requestText(body.nodeKey);
  const continuityId = requestText(body.continuityId);
  if (!worldId || !nodeKey || !continuityId) {
    return Response.json(
      { ok: false as const, error: { code: "INVALID_REQUEST" } },
      { status: 400 },
    );
  }
  const resolved = await resolveScope(request, principalId, worldId);
  if (resolved.error) return resolved.error;
  try {
    const added = await createPostgresPropagationNodeAudienceGovernance(pool).append(
      resolved.scope!,
      principalId,
      { nodeKey, continuityId },
    );
    return Response.json({
      ok: true as const,
      added,
      nodeKey,
      continuityId,
    });
  } catch (error) {
    if (error instanceof PropagationNodeAudienceError) return errorResponse(error);
    return Response.json(
      { ok: false as const, error: { code: "INTERNAL_ERROR" } },
      { status: 500 },
    );
  }
}
