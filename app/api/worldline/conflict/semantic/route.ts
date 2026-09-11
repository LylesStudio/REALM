import {
  createPostgresSemanticConflictEvidenceStore,
  createPostgresWorldKnowledgeRepository,
} from "../../../../../database/postgres/public.ts";
import { createWorldKnowledgeService } from "../../../../../modules/world-knowledge/public.ts";
import {
  detectCausalConflicts,
  type CausalConflictReport,
} from "../../../../../modules/worldline/conflict-detection.ts";
import {
  createModelSemanticConflictAssessor,
  needsSemanticReview,
  type SemanticConflictAssessor,
  type SemanticConflictEvidence,
} from "../../../../../modules/worldline/semantic-conflict.ts";
import type { WorldScope } from "../../../../../modules/world-knowledge/public.ts";
import { LOCAL_RECORD_SCOPE } from "../../../../../modules/application/local-record-service.ts";
import { getModelSettingsService } from "../../../../../modules/application/model-settings-service.ts";
import {
  getSharedRuntimePool,
  resolveWorldScopeForMember,
} from "../../../world-scope.ts";
import {
  resolveRequestPrincipal,
  unauthorizedResponse,
} from "../../../auth-context.ts";
import { logRouteInternalError } from "../../../route-observability.ts";
import {
  CausalInputError,
  parseChangeSet,
  parseCursor,
} from "../route.ts";

export const runtime = "nodejs";

/** 批次 T11-B：语义复审硬预算（preflight §6.1）——8 秒真实可取消截止。 */
export const SEMANTIC_REVIEW_TIMEOUT_MS = 8_000;
/** 输入上界：超过即 400，不调用模型。 */
export const SEMANTIC_REVIEW_MAX_CLAIMS = 64;

/**
 * 批次 T11-B：用户显式请求的语义复审（独立于既有 deterministic preview）。
 * - 服务端重读成员作用域内的 Claims/CausalEdges，不接受客户端注入事实；
 * - none/hard 不调模型直接返回确定性结论；high-risk 最多一次模型调用；
 * - 同进程同 workspace 单飞（忙 409 可重试）；
 * - evidence 落库失败 → 503，不声称复审完成，正式状态不变。
 */
export const POST = createSemanticReviewPost({
  resolveScope: (worldId, principalId) => {
    const connectionString = process.env.REALM_RUNTIME_DATABASE_URL;
    if (!connectionString) return Promise.resolve(null);
    return resolveWorldScopeForMember(getSharedRuntimePool(connectionString), {
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      principalId,
      worldId,
    });
  },
  loadFacts: async (scope) => {
    const connectionString = process.env.REALM_RUNTIME_DATABASE_URL!;
    const knowledge = createWorldKnowledgeService(
      createPostgresWorldKnowledgeRepository(getSharedRuntimePool(connectionString)),
    );
    const [existingClaims, causalEdges] = await Promise.all([
      knowledge.listClaims(scope),
      knowledge.listCausalEdges(scope),
    ]);
    return { existingClaims, causalEdges };
  },
  createAssessor: () =>
    createModelSemanticConflictAssessor({
      getGateway: () => getModelSettingsService().gateway(),
      evidenceStore: createPostgresSemanticConflictEvidenceStore(
        getSharedRuntimePool(process.env.REALM_RUNTIME_DATABASE_URL!),
        LOCAL_RECORD_SCOPE.workspaceId,
      ),
      timeoutMs: SEMANTIC_REVIEW_TIMEOUT_MS,
    }),
  hasRuntime: () => Boolean(process.env.REALM_RUNTIME_DATABASE_URL),
});

export function createSemanticReviewPost(deps: {
  resolveScope(
    worldId: string,
    principalId: string,
  ): Promise<WorldScope | null>;
  loadFacts(scope: WorldScope): Promise<{
    existingClaims: Parameters<typeof detectCausalConflicts>[0]["existingClaims"];
    causalEdges: Parameters<typeof detectCausalConflicts>[0]["causalEdges"];
  }>;
  createAssessor(): SemanticConflictAssessor;
  hasRuntime(): boolean;
}) {
  // 同进程同 workspace 单飞闸门：忙时返回可重试错误，不无限排队。
  const inFlight = new Set<string>();

  return async function POST(request: Request): Promise<Response> {
    const principalId = resolveRequestPrincipal(request, LOCAL_RECORD_SCOPE.principalId);
    if (!principalId) return unauthorizedResponse();
    try {
      const parsed: unknown = await request.json();
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return invalid("Semantic review input must be an object.");
      }
      const body = parsed as Record<string, unknown>;
      const worldId = typeof body.worldId === "string" ? body.worldId.trim() : "";
      if (!worldId) throw new CausalInputError("worldId is required.");
      const existingFuture = parseCursor(body.existingFuture);
      if (!existingFuture) throw new CausalInputError("existingFuture is required.");
      const changeSet = parseChangeSet(body.changeSet);

      if (!deps.hasRuntime()) {
        return Response.json(
          { ok: false as const, error: { code: "LOCAL_RUNTIME_NOT_INITIALIZED" } },
          { status: 503 },
        );
      }
      const scope = await deps.resolveScope(worldId, principalId);
      if (!scope) {
        return Response.json(
          { ok: false as const, error: { code: "WORLD_NOT_FOUND" } },
          { status: 404 },
        );
      }
      const { existingClaims, causalEdges } = await deps.loadFacts(scope);
      if (existingClaims.length > SEMANTIC_REVIEW_MAX_CLAIMS) {
        return Response.json(
          { ok: false as const, error: { code: "SEMANTIC_REVIEW_INPUT_TOO_LARGE" } },
          { status: 400 },
        );
      }
      const report = detectCausalConflicts({
        changeSet,
        existingClaims,
        causalEdges,
        existingFutureCursor: existingFuture,
      });
      const severity = report.classification.conflict;

      // 分流：none/hard 不调模型，直接返回确定性结论。
      if (!needsSemanticReview(severity)) {
        return Response.json(
          {
            ok: true as const,
            mode: "semantic" as const,
            scope: { worldId: scope.worldId, worldlineId: scope.worldlineId },
            deterministic: publicReport(report),
            semantic: null,
          },
          { headers: { "Cache-Control": "no-store" } },
        );
      }

      if (inFlight.has(scope.workspaceId)) {
        return Response.json(
          { ok: false as const, error: { code: "SEMANTIC_REVIEW_BUSY" } },
          { status: 409 },
        );
      }
      inFlight.add(scope.workspaceId);
      try {
        const requestId = `sr_${crypto.randomUUID().replaceAll("-", "").slice(0, 18)}`;
        const assessor = deps.createAssessor();
        // high-risk：最多一次模型调用（评估器内部不 retry）；超时/网关
        // 错误/非法 JSON 一律 fallback 确定性结论。evidence 落库失败时
        // evaluate 抛错——不返回复审结果，正式状态不变。
        const evidence: SemanticConflictEvidence = await assessor.evaluate({
          changeSet,
          existingClaims,
          deterministicSeverity: severity,
          deterministicReason: report.classification.reason,
          scope,
          requestId,
        });
        return Response.json(
          {
            ok: true as const,
            mode: "semantic" as const,
            scope: { worldId: scope.worldId, worldlineId: scope.worldlineId },
            deterministic: publicReport(report),
            semantic: evidence,
          },
          { headers: { "Cache-Control": "no-store" } },
        );
      } finally {
        inFlight.delete(scope.workspaceId);
      }
    } catch (error) {
      if (error instanceof CausalInputError) return invalid(error.message);
      // evidence 写失败 / 内部失败：脱敏诊断 + 安全 503/500，不返回
      // 未持久化的复审结果，不改任何正式状态。
      logRouteInternalError({
        route: "worldline/conflict/semantic",
        stage: "semantic-review",
        error,
      });
      return Response.json(
        { ok: false as const, error: { code: "SEMANTIC_REVIEW_UNAVAILABLE" } },
        { status: 503 },
      );
    }
  };
}

function publicReport(report: CausalConflictReport) {
  return {
    classification: report.classification,
    deterministic: report.deterministic,
    dependency: report.dependency,
    algorithm: "realm-causal-conflict/v1" as const,
  };
}

function invalid(message: string): Response {
  return Response.json(
    { ok: false as const, error: { code: "INVALID_CONFLICT_INPUT", message } },
    { status: 400 },
  );
}
