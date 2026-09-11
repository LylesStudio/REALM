/**
 * M5 world knowledge graph: Entity / Claim / Relation / Article / CausalEdge.
 *
 * Claims are the minimal fact unit and are append-only; promotion along the
 * truth ladder appends a superseding claim. Relations are projections of
 * claims. Articles reference the claims they cover. Everything is bound to a
 * Worldline; the shared World Baseline is out of scope for this batch.
 */

export type WorldEntityKind =
  | "geography"
  | "history"
  | "setting"
  | "faction"
  | "person"
  | "other";

export type ClaimScope = "record" | "story" | "world";

export type TruthStatus =
  | "mentioned"
  | "record_confirmed"
  | "story_canon"
  | "world_canon"
  | "rumor"
  | "hypothesis"
  | "disputed"
  | "deprecated";

export type CausalEdgeKind = "enables" | "contradicts" | "supersedes" | "context";

export type WorldScope = {
  workspaceId: string;
  worldId: string;
  worldlineId: string;
};

export type WorldEntity = {
  id: string;
  entityKind: WorldEntityKind;
  name: string;
  summary: string;
  validFromTick: number;
  validToTick: number | null;
};

export type WorldClaim = {
  id: string;
  subjectEntityId: string;
  predicate: string;
  objectValue: string;
  scope: ClaimScope;
  truthStatus: TruthStatus;
  confidence: number;
  validFromTick: number;
  validToTick: number | null;
  sourceRecordId: string | null;
  sourceEventId: string | null;
  supersedesClaimId: string | null;
};

export type WorldRelation = {
  id: string;
  subjectEntityId: string;
  predicate: string;
  objectEntityId: string;
  sourceClaimId: string;
};

/**
 * Batch 4A：对话 growth 写入草稿。valid_from/valid_to 与 source_record/
 * source_event 不由调用方填写——repo 在写事务内用已验证的来源 Event
 * 派生真实 Record cursor 并统一盖章，调用方不可能写入假时序。
 */
export type DialogueGrowthEntityDraft = Omit<
  WorldEntity,
  "validFromTick" | "validToTick"
>;

export type DialogueGrowthClaimDraft = Omit<
  WorldClaim,
  "validFromTick" | "validToTick" | "sourceRecordId" | "sourceEventId"
>;

export type DialogueGrowthInput = {
  /** 当前 Record（来源一致性校验与 source_record_id 盖章）。 */
  recordId: string;
  /** 本次已提交 release 的真实事件 id（绝不来自模型或 request body）。 */
  sourceEventId: string;
  entities: readonly DialogueGrowthEntityDraft[];
  claims: readonly DialogueGrowthClaimDraft[];
};

export type WorldArticle = {
  id: string;
  title: string;
  body: string;
  claimIds: readonly string[];
  sourceEventIds: readonly string[];
};

/**
 * 批次 SWM-G3：article 资格账本（plan v10 §5/§6.2）。owner attestation 是
 * 唯一公共资格来源；pending_review 为默认（无资格行即待审，fail-closed）。
 */
export type ArticleQualificationStatus =
  | "pending_review"
  | "qualified_public"
  | "rejected"
  | "revoked";

export type ArticleQualificationDecision = "attest" | "reject" | "revoke";

export type CausalEdge = {
  id: string;
  fromClaimId: string;
  toClaimId: string;
  edgeKind: CausalEdgeKind;
};

export class WorldKnowledgeError extends Error {
  readonly code: "ENTITY_NOT_FOUND" | "CLAIM_NOT_FOUND" | "INVALID_PROMOTION";

  constructor(code: WorldKnowledgeError["code"], message: string) {
    super(message);
    this.name = "WorldKnowledgeError";
    this.code = code;
  }
}

const TRUTH_LADDER: Record<string, number> = {
  mentioned: 0,
  record_confirmed: 1,
  story_canon: 2,
  world_canon: 3,
};

/** Side states that do not participate in the promotion ladder. */
const SIDE_STATES = new Set<TruthStatus>([
  "rumor",
  "hypothesis",
  "disputed",
  "deprecated",
]);

export function assertPromotionAllowed(from: TruthStatus, to: TruthStatus): void {
  if (SIDE_STATES.has(to)) return;
  const fromRank = TRUTH_LADDER[from] ?? -1;
  const toRank = TRUTH_LADDER[to] ?? -1;
  if (toRank <= fromRank) {
    throw new WorldKnowledgeError(
      "INVALID_PROMOTION",
      `Cannot move truth status from ${from} to ${to}.`,
    );
  }
}

export interface WorldKnowledgeRepository {
  upsertEntity(scope: WorldScope, entity: WorldEntity): Promise<void>;
  appendClaim(scope: WorldScope, claim: WorldClaim): Promise<void>;
  /** 成批追加（单事务 + 单条失效事件；批内失败整批回滚）。 */
  appendClaims(scope: WorldScope, claims: readonly WorldClaim[]): Promise<void>;
  /**
   * 幂等成批追加（对话 growth 专用）：claim 身份由调用方确定性生成，
   * 同 id 重复写入静默跳过（重复调度不产生重复 claim）；至少一条真实
   * 插入时才追加失效事件。
   */
  appendClaimsIdempotent(
    scope: WorldScope,
    claims: readonly WorldClaim[],
  ): Promise<void>;
  /**
   * Batch 4A：对话 growth 单事务写入（entity upsert + 幂等 claims）。
   * 写事务内先按 (workspace/world/worldline/record, sourceEventId) 读已
   * 提交事件的 world_tick 并校验同 scope；来源不存在或跨 scope 时
   * fail-closed 返回 false 且零写入（绝不回退 valid_from_tick=0）。
   * entity 与 claim 使用同一个真实 cursor。
   */
  appendDialogueGrowth(
    scope: WorldScope,
    input: DialogueGrowthInput,
  ): Promise<boolean>;
  getClaim(scope: WorldScope, claimId: string): Promise<WorldClaim | null>;
  listClaims(
    scope: WorldScope,
    filter?: { subjectEntityId?: string; truthStatus?: TruthStatus; scope?: ClaimScope },
  ): Promise<readonly WorldClaim[]>;
  appendRelation(scope: WorldScope, relation: WorldRelation): Promise<void>;
  listRelations(
    scope: WorldScope,
    filter?: { subjectEntityId?: string },
  ): Promise<readonly WorldRelation[]>;
  createArticle(scope: WorldScope, article: WorldArticle): Promise<void>;
  listArticles(scope: WorldScope): Promise<readonly WorldArticle[]>;
  appendCausalEdge(scope: WorldScope, edge: CausalEdge): Promise<void>;
  listCausalEdges(scope: WorldScope): Promise<readonly CausalEdge[]>;
  listEntities(
    scope: WorldScope,
    filter?: { entityKind?: WorldEntityKind },
  ): Promise<readonly WorldEntity[]>;
}

export interface WorldKnowledgeService {
  upsertEntity(scope: WorldScope, entity: WorldEntity): Promise<void>;
  appendClaim(scope: WorldScope, claim: WorldClaim): Promise<void>;
  /** 成批追加（单事务；晶化入图谱等同源多 claim 场景）。 */
  appendClaims(scope: WorldScope, claims: readonly WorldClaim[]): Promise<void>;
  /** 幂等成批追加（growth 重复调度安全；同 id 静默跳过）。 */
  appendClaimsIdempotent(
    scope: WorldScope,
    claims: readonly WorldClaim[],
  ): Promise<void>;
  /**
   * Batch 4A：对话 growth（entity + claims）绑定来源 Event cursor 的单
   * 事务写入；来源不可解析/跨 scope 返回 false 且零写入（fail-closed）。
   */
  appendDialogueGrowth(
    scope: WorldScope,
    input: DialogueGrowthInput,
  ): Promise<boolean>;
  /** Promotion appends a superseding claim at a higher ladder rank. */
  promoteClaim(
    scope: WorldScope,
    claimId: string,
    to: TruthStatus,
    newId: string,
  ): Promise<WorldClaim>;
  projectRelation(
    scope: WorldScope,
    input: { claimId: string; objectEntityId: string; relationId: string },
  ): Promise<void>;
  createArticle(scope: WorldScope, article: WorldArticle): Promise<void>;
  appendCausalEdge(scope: WorldScope, edge: CausalEdge): Promise<void>;
  listEntities(
    scope: WorldScope,
    filter?: { entityKind?: WorldEntityKind },
  ): Promise<readonly WorldEntity[]>;
  listClaims(
    scope: WorldScope,
    filter?: { subjectEntityId?: string; truthStatus?: TruthStatus; scope?: ClaimScope },
  ): Promise<readonly WorldClaim[]>;
  listRelations(
    scope: WorldScope,
    filter?: { subjectEntityId?: string },
  ): Promise<readonly WorldRelation[]>;
  listArticles(scope: WorldScope): Promise<readonly WorldArticle[]>;
  listCausalEdges(scope: WorldScope): Promise<readonly CausalEdge[]>;
}

export function createWorldKnowledgeService(
  repository: WorldKnowledgeRepository,
): WorldKnowledgeService {
  return {
    upsertEntity: (scope, entity) => repository.upsertEntity(scope, entity),
    appendClaim: (scope, claim) => repository.appendClaim(scope, claim),
    appendClaims: (scope, claims) => repository.appendClaims(scope, claims),
    appendClaimsIdempotent: (scope, claims) =>
      repository.appendClaimsIdempotent(scope, claims),
    appendDialogueGrowth: (scope, input) =>
      repository.appendDialogueGrowth(scope, input),

    async promoteClaim(scope, claimId, to, newId) {
      const current = await repository.getClaim(scope, claimId);
      if (!current) {
        throw new WorldKnowledgeError("CLAIM_NOT_FOUND", `Unknown claim ${claimId}.`);
      }
      assertPromotionAllowed(current.truthStatus, to);
      const promoted: WorldClaim = {
        ...current,
        id: newId,
        truthStatus: to,
        supersedesClaimId: claimId,
      };
      await repository.appendClaim(scope, promoted);
      return promoted;
    },

    async projectRelation(scope, input) {
      const claim = await repository.getClaim(scope, input.claimId);
      if (!claim) {
        throw new WorldKnowledgeError("CLAIM_NOT_FOUND", `Unknown claim ${input.claimId}.`);
      }
      await repository.appendRelation(scope, {
        id: input.relationId,
        subjectEntityId: claim.subjectEntityId,
        predicate: claim.predicate,
        objectEntityId: input.objectEntityId,
        sourceClaimId: claim.id,
      });
    },

    createArticle: (scope, article) => repository.createArticle(scope, article),
    appendCausalEdge: (scope, edge) => repository.appendCausalEdge(scope, edge),
    listEntities: (scope, filter) => repository.listEntities(scope, filter),
    listClaims: (scope, filter) => repository.listClaims(scope, filter),
    listRelations: (scope, filter) => repository.listRelations(scope, filter),
    listArticles: (scope) => repository.listArticles(scope),
    listCausalEdges: (scope) => repository.listCausalEdges(scope),
  };
}
