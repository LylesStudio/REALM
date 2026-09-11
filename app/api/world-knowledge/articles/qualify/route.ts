import {
  createArticleQualificationRepository,
} from "../../../../../database/postgres/public.ts";
import { LOCAL_RECORD_SCOPE } from "../../../../../modules/application/local-record-service.ts";
import {
  resolveRequestPrincipal,
  unauthorizedResponse,
} from "../../../auth-context.ts";
import {
  getSharedRuntimePool,
  resolveMembershipRole,
  resolveWorldScopeForMember,
} from "../../../world-scope.ts";

export const runtime = "nodejs";

/**
 * 批次 SWM-G3：article 公共资格 owner attestation（plan v10 §6.2）。
 * 固定 request 形状 { worldId, articleId, decision }——workspace/principal/
 * attestedBy 一律从 session + membership 服务端解析，body 身份字段忽略。
 */
export async function POST(request: Request) {
  const principalId = resolveRequestPrincipal(request, LOCAL_RECORD_SCOPE.principalId);
  if (!principalId) return unauthorizedResponse();

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return invalid("请求体不是合法 JSON。");
  }
  const worldId = typeof body.worldId === "string" ? body.worldId.trim() : "";
  const articleId = typeof body.articleId === "string" ? body.articleId.trim() : "";
  const decision = String(body.decision ?? "");
  if (
    !worldId
    || !articleId
    || !["attest", "reject", "revoke"].includes(decision)
  ) {
    return invalid("worldId/articleId/decision 不合法。");
  }

  const connectionString = process.env.REALM_RUNTIME_DATABASE_URL;
  if (!connectionString) {
    return Response.json(
      { ok: false as const, error: { code: "LOCAL_RUNTIME_NOT_INITIALIZED" } },
      { status: 503 },
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
      { ok: false as const, error: { code: "WORLD_NOT_FOUND", message: "World not found." } },
      { status: 404 },
    );
  }
  // owner-only：membership role 服务端读取，绝不信任 request body。
  const role = await resolveMembershipRole(pool, {
    workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
    worldId,
    principalId,
  });
  if (role !== "owner") {
    return Response.json(
      { ok: false as const, error: { code: "NOT_OWNER", message: "Only the world owner can qualify articles." } },
      { status: 403 },
    );
  }

  const repository = createArticleQualificationRepository(pool);
  const outcome = await repository.qualify(scope, {
    articleId,
    decision: decision as "attest" | "reject" | "revoke",
    attestedBy: principalId,
  });
  if (!outcome.ok) {
    if (outcome.code === "ARTICLE_NOT_FOUND") {
      return Response.json(
        { ok: false as const, error: { code: "ARTICLE_NOT_FOUND", message: "Article not found." } },
        { status: 404 },
      );
    }
    if (outcome.code === "HASH_MISMATCH") {
      return Response.json(
        { ok: false as const, error: { code: "HASH_MISMATCH", message: "Article content changed since attestation; revoke before re-attesting." } },
        { status: 409 },
      );
    }
    if (outcome.code === "WORLD_ARCHIVED") {
      return Response.json(
        { ok: false as const, error: { code: "WORLD_ARCHIVED", message: "The world is archived and read-only." } },
        { status: 409 },
      );
    }
    if (outcome.code === "QUALIFICATION_CONCURRENT") {
      return Response.json(
        { ok: false as const, error: { code: "QUALIFICATION_CONCURRENT", message: "Concurrent qualification conflict; retry the request." } },
        { status: 409 },
      );
    }
    return Response.json(
      { ok: false as const, error: { code: "QUALIFICATION_SCHEMA_MISSING", message: "Article qualification schema is not applied." } },
      { status: 503 },
    );
  }
  return Response.json(
    {
      ok: true as const,
      articleId: outcome.articleId,
      status: outcome.status,
      seq: outcome.seq,
      availableFromTick: outcome.availableFromTick,
      availableFromOrdinal: outcome.availableFromOrdinal,
      ...(outcome.idempotent ? { idempotent: true as const } : {}),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

function invalid(message: string) {
  return Response.json(
    { ok: false as const, error: { code: "INVALID_REQUEST", message } },
    { status: 400 },
  );
}
