import {
  createArticleQualificationRepository,
  createPostgresWorldKnowledgeRepository,
} from "../../../database/postgres/public.ts";
import {
  WorldKnowledgeError,
  createWorldKnowledgeService,
} from "../../../modules/world-knowledge/public.ts";
import { LOCAL_RECORD_SCOPE } from "../../../modules/application/local-record-service.ts";
import {
  resolveRequestPrincipal,
  unauthorizedResponse,
} from "../auth-context.ts";
import {
  getSharedRuntimePool,
  resolveMembershipRole,
  resolveWorldScopeForMember,
} from "../world-scope.ts";

export const runtime = "nodejs";

/**
 * 批次 T9：图谱作用域去 demo 硬编码——worldId 显式必填（缺失 400），
 * 世界不存在/非成员 404；按目标世界当前 active 世界线解析。
 */
async function resolveScope(
  request: Request,
  principalId: string,
  bodyWorldId?: unknown,
) {
  const url = new URL(request.url);
  const raw = typeof bodyWorldId === "string" && bodyWorldId.trim()
    ? bodyWorldId.trim()
    : url.searchParams.get("worldId")?.trim() ?? "";
  if (!raw) {
    return {
      scope: null,
      error: Response.json(
        { ok: false as const, error: { code: "INVALID_REQUEST", message: "worldId is required." } },
        { status: 400 },
      ),
    };
  }
  const connectionString = process.env.REALM_RUNTIME_DATABASE_URL;
  if (!connectionString) {
    return {
      scope: null,
      error: Response.json(
        { ok: false as const, error: { code: "LOCAL_RUNTIME_NOT_INITIALIZED" } },
        { status: 503 },
      ),
    };
  }
  const scope = await resolveWorldScopeForMember(
    getSharedRuntimePool(connectionString),
    { workspaceId: LOCAL_RECORD_SCOPE.workspaceId, principalId, worldId: raw },
  );
  if (!scope) {
    return {
      scope: null,
      error: Response.json(
        { ok: false as const, error: { code: "WORLD_NOT_FOUND", message: "World not found." } },
        { status: 404 },
      ),
    };
  }
  return { scope };
}

const ENTITY_KINDS = new Set([
  "geography",
  "history",
  "setting",
  "faction",
  "person",
  "other",
]);
const CLAIM_SCOPES = new Set(["record", "story", "world"]);
const TRUTH_STATUSES = new Set([
  "mentioned",
  "record_confirmed",
  "story_canon",
  "world_canon",
  "rumor",
  "hypothesis",
  "disputed",
  "deprecated",
]);

function knowledgeService() {
  const connectionString = process.env.REALM_RUNTIME_DATABASE_URL;
  if (!connectionString) return null;
  return createWorldKnowledgeService(
    createPostgresWorldKnowledgeRepository(
      getSharedRuntimePool(connectionString),
    ),
  );
}

/** 世界知识图谱读取：实体、Claim、关系与文章。 */
export async function GET(request: Request) {
  const principalId = resolveRequestPrincipal(request, LOCAL_RECORD_SCOPE.principalId);
  if (!principalId) return unauthorizedResponse();
  const service = knowledgeService();
  if (!service) {
    return Response.json(
      { ok: false as const, error: { code: "LOCAL_RUNTIME_NOT_INITIALIZED" } },
      { status: 503 },
    );
  }
  const resolved = await resolveScope(request, principalId);
  if (resolved.error) return resolved.error;
  const SCOPE = resolved.scope!;
  const pool = getSharedRuntimePool(process.env.REALM_RUNTIME_DATABASE_URL!);
  const [entities, claims, relations, articleRows, membershipRole] = await Promise.all([
    service.listEntities(SCOPE),
    service.listClaims(SCOPE),
    service.listRelations(SCOPE),
    service.listArticles(SCOPE),
    resolveMembershipRole(pool, {
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      worldId: SCOPE.worldId,
      principalId,
    }),
  ]);
  // 批次 SWM-G5（plan v10 §6.3）：article 正文按资格状态 × 角色矩阵门控。
  // 资格读取 fail-closed：缺 0041 的库（42P01/42883）全部按 pending_review。
  let qualificationStates: Awaited<
    ReturnType<ReturnType<typeof createArticleQualificationRepository>["listStates"]>
  > = new Map();
  try {
    qualificationStates = await createArticleQualificationRepository(pool)
      .listStates(SCOPE);
  } catch (error) {
    const code = typeof error === "object" && error !== null
      ? (error as { code?: string }).code
      : undefined;
    if (code !== "42P01" && code !== "42883") throw error;
  }
  const isOwner = membershipRole === "owner";
  const articles = articleRows.map((article) => {
    const state = qualificationStates.get(article.id);
    const qualificationStatus = state?.status ?? "pending_review";
    // owner 控制面可读 pending/rejected 正文；qualified_public 全成员可读；
    // revoked 全员仅 metadata。非 owner 的正文由服务端置空串（前端不做权限判断）。
    const canReadBody = qualificationStatus === "qualified_public"
      || (isOwner && (qualificationStatus === "pending_review"
        || qualificationStatus === "rejected"));
    return {
      ...article,
      body: canReadBody ? article.body : "",
      qualificationStatus,
      // tuple 分量要么齐全要么不展示（禁止丢 ordinal）。
      ...(state
        ? {
            availableFromTick: state.availableFromTick,
            availableFromOrdinal: state.availableFromOrdinal,
          }
        : {}),
    };
  });
  return Response.json(
    { ok: true as const, entities, claims, relations, articles },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/** 图谱编辑入口：全部写入经由服务端契约与校验。 */
export async function POST(request: Request) {
  const principalId = resolveRequestPrincipal(request, LOCAL_RECORD_SCOPE.principalId);
  if (!principalId) return unauthorizedResponse();
  const service = knowledgeService();
  if (!service) {
    return Response.json(
      { ok: false as const, error: { code: "LOCAL_RUNTIME_NOT_INITIALIZED" } },
      { status: 503 },
    );
  }
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const resolved = await resolveScope(request, principalId, body.worldId);
    if (resolved.error) return resolved.error;
    const SCOPE = resolved.scope!;
    if (body.action === "upsertEntity") {
      const kind = String(body.entityKind ?? "");
      const name = String(body.name ?? "").trim();
      if (!ENTITY_KINDS.has(kind) || !name) {
        return invalid("实体类型或名称不合法。");
      }
      const id = typeof body.id === "string" && body.id.trim()
        ? body.id.trim()
        : `entity_${crypto.randomUUID().replaceAll("-", "").slice(0, 18)}`;
      await service.upsertEntity(SCOPE, {
        id,
        entityKind: kind as never,
        name,
        summary: String(body.summary ?? ""),
        validFromTick: 0,
        validToTick: null,
      });
      return Response.json({ ok: true as const, id }, { status: 201 });
    }
    if (body.action === "appendClaim") {
      const subjectEntityId = String(body.subjectEntityId ?? "");
      const predicate = String(body.predicate ?? "").trim();
      const objectValue = String(body.objectValue ?? "").trim();
      const claimScope = String(body.scope ?? "");
      const truthStatus = String(body.truthStatus ?? "mentioned");
      if (
        !subjectEntityId
        || !predicate
        || !objectValue
        || !CLAIM_SCOPES.has(claimScope)
        || !TRUTH_STATUSES.has(truthStatus)
      ) {
        return invalid("Claim 主体、谓词、值、scope 或真值状态不合法。");
      }
      const subject = (await service.listEntities(SCOPE))
        .find((entity) => entity.id === subjectEntityId);
      if (!subject) return invalid("Claim 主体实体不存在。");
      const id = `claim_${crypto.randomUUID().replaceAll("-", "").slice(0, 18)}`;
      await service.appendClaim(SCOPE, {
        id,
        subjectEntityId,
        predicate,
        objectValue,
        scope: claimScope as never,
        truthStatus: truthStatus as never,
        confidence: 1,
        validFromTick: 0,
        validToTick: null,
        sourceRecordId: null,
        sourceEventId: null,
        supersedesClaimId: null,
      });
      return Response.json({ ok: true as const, id }, { status: 201 });
    }
    if (body.action === "appendRelation") {
      const subjectEntityId = String(body.subjectEntityId ?? "");
      const objectEntityId = String(body.objectEntityId ?? "");
      const predicate = String(body.predicate ?? "").trim();
      const claimId = String(body.claimId ?? "");
      if (!subjectEntityId || !objectEntityId || !predicate || !claimId) {
        return invalid("关系两端实体、谓词或来源 Claim 不合法。");
      }
      const entities = await service.listEntities(SCOPE);
      if (
        !entities.some((entity) => entity.id === subjectEntityId)
        || !entities.some((entity) => entity.id === objectEntityId)
      ) {
        return invalid("关系两端实体不存在。");
      }
      await service.projectRelation(SCOPE, {
        claimId,
        objectEntityId,
        relationId: `rel_${crypto.randomUUID().replaceAll("-", "").slice(0, 18)}`,
      });
      return Response.json({ ok: true as const }, { status: 201 });
    }
    return invalid("未知操作。");
  } catch (error) {
    if (error instanceof WorldKnowledgeError) {
      return Response.json(
        { ok: false as const, error: { code: error.code, message: error.message } },
        { status: 409 },
      );
    }
    return Response.json(
      { ok: false as const, error: { code: "INTERNAL_ERROR" } },
      { status: 500 },
    );
  }
}

function invalid(message: string) {
  return Response.json(
    { ok: false as const, error: { code: "INVALID_REQUEST", message } },
    { status: 400 },
  );
}
