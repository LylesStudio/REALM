import {
  createPostgresCanonRepository,
  createPostgresWorldKnowledgeRepository,
  PropagationTopologyError,
} from "../../../database/postgres/public.ts";
import { createPostgresCanonQualificationReader } from "../../../database/postgres/canon-qualification.ts";
import { createPostgresCanonPropagation } from "../../../database/postgres/canon-propagation.ts";
import { createWorldKnowledgeService } from "../../../modules/world-knowledge/public.ts";
import {
  CanonError,
  createCanonService,
} from "../../../modules/worldline/canon.ts";
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
 * 批次 T9：canon 作用域去 demo 硬编码——worldId 显式必填（缺失 400），
 * 世界不存在/非成员 404；按目标世界当前 active 世界线解析。
 */
async function resolveScope(
  request: Request,
  principalId: string,
  bodyWorldId?: unknown,
): Promise<{ scope: Awaited<ReturnType<typeof resolveWorldScopeForMember>>; error?: Response }> {
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
    getSharedRuntimePool(connectionString), {
    workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
    principalId,
    worldId: raw,
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
  return { scope };
}

function canonService() {
  const connectionString = process.env.REALM_RUNTIME_DATABASE_URL;
  if (!connectionString) return null;
  const pool = getSharedRuntimePool(connectionString);
  return createCanonService({
    repository: createPostgresCanonRepository(pool),
    knowledge: createWorldKnowledgeService(
      createPostgresWorldKnowledgeRepository(pool),
    ),
    // 批次 T11-B：传播原子入队端口（merge + propagate:"public" 时同事务生效）。
    propagation: createPostgresCanonPropagation(),
  });
}

/** 列出 Canon 提案（默认待审）；view=qualification 返回只读资格预检。 */
export async function GET(request: Request) {
  const principalId = resolveRequestPrincipal(request, LOCAL_RECORD_SCOPE.principalId);
  if (!principalId) return unauthorizedResponse();
  const service = canonService();
  if (!service) {
    return Response.json(
      { ok: false as const, error: { code: "LOCAL_RUNTIME_NOT_INITIALIZED" } },
      { status: 503 },
    );
  }
  const resolved = await resolveScope(request, principalId);
  if (resolved.error) return resolved.error;
  const url = new URL(request.url);
  // 批次 T11-H：只读资格预检（owner operator surface 数据源）。
  // 成员可见；非成员 404 不泄露。合并资格仍由 POST 的 owner gate 决定。
  if (url.searchParams.get("view") === "qualification") {
    const qualification = await createPostgresCanonQualificationReader(
      getSharedRuntimePool(process.env.REALM_RUNTIME_DATABASE_URL!),
    ).load(resolved.scope!, principalId);
    if (!qualification) {
      return Response.json(
        { ok: false as const, error: { code: "WORLD_NOT_FOUND", message: "World not found." } },
        { status: 404 },
      );
    }
    return Response.json(
      { ok: true as const, qualification },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  const status = url.searchParams.get("status");
  const proposals = await service.listPending(resolved.scope!, {
    all: status === "all",
  });
  return Response.json({ ok: true as const, proposals });
}

/** 提出或决定 Canon 提案。 */
export async function POST(request: Request) {
  const principalId = resolveRequestPrincipal(request, LOCAL_RECORD_SCOPE.principalId);
  if (!principalId) return unauthorizedResponse();
  const service = canonService();
  if (!service) {
    return Response.json(
      { ok: false as const, error: { code: "LOCAL_RUNTIME_NOT_INITIALIZED" } },
      { status: 503 },
    );
  }
  try {
    const body = (await request.json()) as Record<string, unknown>;
    if (body.action === "propose") {
      const resolved = await resolveScope(request, principalId, body.worldId);
      if (resolved.error) return resolved.error;
      const proposal = await service.propose({
        scope: resolved.scope!,
        targetLevel: body.targetLevel === "worldline" ? "worldline" : "story",
        claimIds: Array.isArray(body.claimIds)
          ? body.claimIds.filter((id): id is string => typeof id === "string")
          : [],
        rationale: typeof body.rationale === "string" ? body.rationale : "",
        proposedBy: "dm",
      });
      // 低于审核层级时不产生提案（普通 Record 事实不打扰用户）。
      return Response.json(
        { ok: true as const, proposal, belowReviewLevel: proposal === null },
        { status: proposal ? 201 : 200 },
      );
    }
    if (body.action === "decide") {
      const decision = body.decision;
      if (
        typeof body.proposalId !== "string"
        || (decision !== "merge" && decision !== "reject" && decision !== "defer")
      ) {
        return Response.json(
          { ok: false as const, error: { code: "INVALID_REQUEST" } },
          { status: 400 },
        );
      }
      // 批次 T11-G：propagate 只接受 public/restricted/secret；其余值 400
      // （不得当成「不传播但照常 merge」吞掉）。
      let propagatePublic = false;
      let propagationClass: "restricted" | "secret" | undefined;
      let audienceContinuityIds: string[] | undefined;
      if (body.propagate !== undefined) {
        if (
          body.propagate !== "public"
          && body.propagate !== "restricted"
          && body.propagate !== "secret"
        ) {
          return invalid("propagate must be public, restricted or secret.");
        }
        if (body.propagate === "public") {
          propagatePublic = true;
        } else {
          propagationClass = body.propagate;
        }
      }
      const resolved = await resolveScope(request, principalId, body.worldId);
      if (resolved.error) return resolved.error;
      if (decision === "merge" && propagationClass) {
        // non-public 资格（T11-F/T11-G）：决定者必须是 owner；audience
        // 是非空字符串数组（去重在服务层）；缺任何一项 4xx，不降级。
        const role = await resolveMembershipRole(
          getSharedRuntimePool(process.env.REALM_RUNTIME_DATABASE_URL!),
          {
            workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
            worldId: resolved.scope!.worldId,
            principalId,
          },
        );
        if (role !== "owner") {
          return Response.json(
            { ok: false as const, error: { code: "PROPAGATION_SECURITY_UNAVAILABLE" } },
            { status: 409 },
          );
        }
        if (
          !Array.isArray(body.audienceContinuityIds)
          || !body.audienceContinuityIds.every(
            (id): id is string => typeof id === "string" && id.trim() !== "",
          )
        ) {
          return invalid("audienceContinuityIds must be a non-empty string array.");
        }
        audienceContinuityIds = body.audienceContinuityIds.map((id) => id.trim());
        if (audienceContinuityIds.length === 0) {
          return invalid("audienceContinuityIds must be a non-empty string array.");
        }
      }
      const proposal = await service.decide({
        scope: resolved.scope!,
        proposalId: body.proposalId,
        decision,
        // 批次 T11-H：审计主体只取已解析 principalId，不再信任 body.decidedBy。
        decidedBy: principalId,
        // 批次 T11-B：仅显式 propagate:"public" 才在同事务创建传播任务；
        // 缺省 fail-closed 零传播任务，Canon 正史照常成立。
        propagatePublic: decision === "merge" && propagatePublic,
        propagationClass: decision === "merge" ? propagationClass : undefined,
        audienceContinuityIds,
      });
      return Response.json({ ok: true as const, proposal });
    }
    return invalid("未知操作。");
  } catch (error) {
    if (error instanceof CanonError) {
      return Response.json(
        { ok: false as const, error: { code: error.code, message: error.message } },
        { status: 409 },
      );
    }
    // 批次 T11-B：拓扑校验失败——整个 merge 已回滚，返回安全 409 形态。
    if (error instanceof PropagationTopologyError) {
      return Response.json(
        { ok: false as const, error: { code: error.code, message: "Propagation topology is not ready for this world." } },
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
