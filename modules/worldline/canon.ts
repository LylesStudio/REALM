/**
 * M5 Canon governance: Proposal review flow and immutable CanonRevisions.
 *
 * Only high-level changes reach review: record-scope facts never produce a
 * proposal (they would spam the user). Merging a proposal promotes its
 * claims, writes its article and appends an immutable CanonRevision in one
 * transaction; reject/defer change nothing outside the proposal row.
 */

import { createHash } from "node:crypto";
import type {
  TruthStatus,
  WorldArticle,
  WorldClaim,
  WorldKnowledgeService,
  WorldScope,
} from "../world-knowledge/public.ts";
import type { SecurityClass } from "../propagation/public.ts";

export type CanonTargetLevel = "story" | "worldline";
export type CanonProposalStatus = "pending" | "merged" | "rejected" | "deferred";

export type CanonProposal = {
  id: string;
  targetLevel: CanonTargetLevel;
  articleId: string | null;
  claimIds: readonly string[];
  rationale: string;
  status: CanonProposalStatus;
  proposedBy: string;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
};

export type CanonRevision = {
  id: string;
  parentRevisionId: string | null;
  effectiveTick: number;
  effectiveOrdinal: number;
  acceptedProposalId: string;
  contentHash: string;
  committedAt: string;
  /**
   * 批次 T11-G：传播安全分类的唯一正史承载点（T11-F §二）。
   * 旧构造点/既有行一律 public；restricted/secret 必须带 audience 快照。
   */
  securityClass: SecurityClass;
};

export class CanonError extends Error {
  readonly code:
    | "PROPOSAL_NOT_FOUND"
    | "PROPOSAL_NOT_PENDING"
    | "PROPOSAL_BELOW_REVIEW_LEVEL"
    | "CLAIM_NOT_FOUND"
    | "PROPAGATION_UNAVAILABLE"
    | "PROPAGATION_SECURITY_UNAVAILABLE";

  constructor(code: CanonError["code"], message: string) {
    super(message);
    this.name = "CanonError";
    this.code = code;
  }
}

export interface CanonRepository {
  createProposal(scope: WorldScope, proposal: CanonProposal): Promise<void>;
  getProposal(scope: WorldScope, proposalId: string): Promise<CanonProposal | null>;
  listProposals(
    scope: WorldScope,
    status?: CanonProposalStatus,
  ): Promise<readonly CanonProposal[]>;
  /** Atomically merges: promoted claims + article + revision + proposal mark. */
  mergeProposal(
    scope: WorldScope,
    input: {
      proposalId: string;
      decidedBy: string;
      promotedClaims: readonly WorldClaim[];
      article: WorldArticle | null;
      revision: CanonRevision;
      /**
       * 批次 T11-B：可选的传播原子入队钩子——由持久化层在同一事务内
       * 以真实 client 调用；抛出即整个 merge 回滚（promoted claims、
       * revision、campaign、packet、job 全部不成立）。
       */
      propagation?: { enqueue(client: unknown): Promise<void> };
    },
  ): Promise<void>;
  markDecided(
    scope: WorldScope,
    input: {
      proposalId: string;
      status: "rejected" | "deferred";
      decidedBy: string;
    },
  ): Promise<void>;
  latestRevision(scope: WorldScope): Promise<CanonRevision | null>;
}

export interface CanonService {
  /** Returns null when the change set is below the review level. */
  propose(input: {
    scope: WorldScope;
    targetLevel: CanonTargetLevel;
    claimIds: readonly string[];
    article?: { title: string; body: string; sourceEventIds: readonly string[] };
    rationale: string;
    proposedBy?: string;
  }): Promise<CanonProposal | null>;
  decide(input: {
    scope: WorldScope;
    proposalId: string;
    decision: "merge" | "reject" | "defer";
    decidedBy: string;
    effectiveCursor?: { tick: number; ordinal: number };
    /**
     * 批次 T11-B：显式 public 传播裁决（当前 schema 下唯一的 public
     * 证明）。仅 merge 有效；缺省=不创建传播任务，Canon 正史照常成立。
     */
    propagatePublic?: boolean;
    /**
     * 批次 T11-G：non-public 传播等级（restricted/secret）。必须同时
     * 提供 audienceContinuityIds（非空、去重、当前世界线 active
     * continuities）；资格不齐即失败关闭，不静默降级 public、不
     * 「只 merge 不传播」。
     */
    propagationClass?: "restricted" | "secret";
    audienceContinuityIds?: readonly string[];
  }): Promise<CanonProposal>;
  listPending(
    scope: WorldScope,
    options?: { all?: boolean },
  ): Promise<readonly CanonProposal[]>;
  latestRevision(scope: WorldScope): Promise<CanonRevision | null>;
}

/** truth_status ranks that satisfy each review level. */
function meetsReviewLevel(claim: WorldClaim, targetLevel: CanonTargetLevel): boolean {
  if (targetLevel === "story") {
    return claim.scope === "story" || claim.scope === "world";
  }
  return claim.scope === "world"
    || claim.truthStatus === "story_canon"
    || claim.truthStatus === "world_canon";
}

function targetTruthStatus(targetLevel: CanonTargetLevel): TruthStatus {
  return targetLevel === "story" ? "story_canon" : "world_canon";
}

const TRUTH_RANK: Record<string, number> = {
  mentioned: 0,
  rumor: 0,
  hypothesis: 0,
  record_confirmed: 1,
  disputed: 1,
  story_canon: 2,
  world_canon: 3,
  deprecated: -1,
};

/**
 * 批次 T11-B：Canon merge → propagation 的原子入队端口（preflight §7.1）。
 * 实现方在 merge 事务内加载校验拓扑快照并以确定性身份写入
 * Campaign/root Packet/pending job；任何失败抛出即整体回滚。
 */
export interface CanonPropagationPort {
  planAndEnqueue(
    client: unknown,
    scope: WorldScope,
    input: {
      revision: CanonRevision;
      promotedClaims: readonly WorldClaim[];
      /** 批次 T11-G：冻结进 Campaign/Job input 的安全等级与受众。 */
      securityClass: SecurityClass;
      audienceContinuityIds: readonly string[];
    },
  ): Promise<void>;
}

export function createCanonService(options: {
  repository: CanonRepository;
  knowledge: WorldKnowledgeService;
  idFactory?: () => string;
  /** 批次 T11-B：传播入队端口；未装配时 propagatePublic=true 直接失败关闭。 */
  propagation?: CanonPropagationPort;
}): CanonService {
  const idFactory = options.idFactory ?? (() => crypto.randomUUID());

  return {
    async propose(input) {
      const claims: WorldClaim[] = [];
      for (const claimId of input.claimIds) {
        const claim = await options.knowledge.listClaims(input.scope)
          .then((all) => all.find((item) => item.id === claimId));
        if (!claim) {
          throw new CanonError("CLAIM_NOT_FOUND", `Unknown claim ${claimId}.`);
        }
        claims.push(claim);
      }
      // 层级门禁：普通 Record 事实不进入审核。
      if (
        claims.length === 0
        || !claims.every((claim) => meetsReviewLevel(claim, input.targetLevel))
      ) {
        return null;
      }
      const proposal: CanonProposal = {
        id: `canon_${idFactory()}`,
        targetLevel: input.targetLevel,
        articleId: input.article ? `article_${idFactory()}` : null,
        claimIds: input.claimIds,
        rationale: input.rationale,
        status: "pending",
        proposedBy: input.proposedBy ?? "dm",
        decidedBy: null,
        decidedAt: null,
        createdAt: new Date().toISOString(),
      };
      await options.repository.createProposal(input.scope, proposal);
      return proposal;
    },

    async decide(input) {
      const proposal = await options.repository.getProposal(
        input.scope,
        input.proposalId,
      );
      if (!proposal) {
        throw new CanonError("PROPOSAL_NOT_FOUND", `Unknown proposal ${input.proposalId}.`);
      }
      if (proposal.status !== "pending") {
        throw new CanonError(
          "PROPOSAL_NOT_PENDING",
          `Proposal ${input.proposalId} is already ${proposal.status}.`,
        );
      }
      if (input.decision !== "merge") {
        await options.repository.markDecided(input.scope, {
          proposalId: input.proposalId,
          status: input.decision === "reject" ? "rejected" : "deferred",
          decidedBy: input.decidedBy,
        });
        return { ...proposal, status: input.decision === "reject" ? "rejected" : "deferred" };
      }

      // merge：晋升 Claim（追加 superseding 结论）+ Article + 不可变 Revision。
      const target = targetTruthStatus(proposal.targetLevel);
      const promotedClaims: WorldClaim[] = [];
      for (const claimId of proposal.claimIds) {
        const claim = await options.knowledge.listClaims(input.scope)
          .then((all) => all.find((item) => item.id === claimId));
        if (!claim) {
          throw new CanonError("CLAIM_NOT_FOUND", `Unknown claim ${claimId}.`);
        }
        if ((TRUTH_RANK[claim.truthStatus] ?? 0) >= (TRUTH_RANK[target] ?? 0)) {
          continue;
        }
        promotedClaims.push({
          ...claim,
          id: `claim_${idFactory()}`,
          scope: proposal.targetLevel === "story" ? claim.scope : "world",
          truthStatus: target,
          supersedesClaimId: claim.id,
        });
      }
      const latest = await options.repository.latestRevision(input.scope);
      const cursor = input.effectiveCursor ?? { tick: 0, ordinal: 0 };
      const revision: CanonRevision = {
        id: `revision_${idFactory()}`,
        parentRevisionId: latest?.id ?? null,
        effectiveTick: cursor.tick,
        effectiveOrdinal: cursor.ordinal,
        acceptedProposalId: proposal.id,
        contentHash: createHash("sha256")
          .update([
            proposal.id,
            proposal.claimIds.join(","),
            proposal.articleId ?? "",
          ].join(":"))
          .digest("hex"),
        committedAt: new Date().toISOString(),
        // 批次 T11-G：attest 的等级写入正史；缺省 public（含无 attest merge）。
        securityClass: input.propagationClass ?? "public",
      };
      // 批次 T11-B/T11-G：显式传播裁决——有 promoted Claim 才装配原子
      // 入队钩子（空晋升不创建空 Campaign）；未装配端口时 attest 失败关闭。
      // T11-G：non-public 必须带非空去重 audience；空晋升 + non-public
      // attest 拒绝（不静默降级 public）。
      const securityClass: SecurityClass = input.propagationClass ?? "public";
      let propagation: { enqueue(client: unknown): Promise<void> } | undefined;
      if (input.propagationClass !== undefined) {
        if (promotedClaims.length === 0) {
          throw new CanonError(
            "PROPAGATION_SECURITY_UNAVAILABLE",
            "Non-public propagation requires at least one promoted claim.",
          );
        }
        const rawAudience = input.audienceContinuityIds ?? [];
        if (
          !rawAudience.every((id) => typeof id === "string" && id.trim() !== "")
        ) {
          throw new CanonError(
            "PROPAGATION_SECURITY_UNAVAILABLE",
            "Non-public propagation audience must be a non-empty string array.",
          );
        }
        const audienceContinuityIds = [
          ...new Set(rawAudience.map((id) => id.trim())),
        ];
        if (audienceContinuityIds.length === 0) {
          throw new CanonError(
            "PROPAGATION_SECURITY_UNAVAILABLE",
            "Non-public propagation requires a non-empty audience.",
          );
        }
        if (!options.propagation) {
          throw new CanonError(
            "PROPAGATION_UNAVAILABLE",
            "Propagation enqueue is not wired.",
          );
        }
        const port = options.propagation;
        propagation = {
          enqueue: (client) =>
            port.planAndEnqueue(client, input.scope, {
              revision,
              promotedClaims,
              securityClass,
              audienceContinuityIds,
            }),
        };
      } else if (input.propagatePublic && promotedClaims.length > 0) {
        if (!options.propagation) {
          throw new CanonError(
            "PROPAGATION_UNAVAILABLE",
            "Propagation enqueue is not wired; cannot attest public propagation.",
          );
        }
        const port = options.propagation;
        propagation = {
          enqueue: (client) =>
            port.planAndEnqueue(client, input.scope, {
              revision,
              promotedClaims,
              securityClass: "public",
              audienceContinuityIds: [],
            }),
        };
      }
      await options.repository.mergeProposal(input.scope, {
        proposalId: proposal.id,
        decidedBy: input.decidedBy,
        promotedClaims,
        article: null,
        revision,
        propagation,
      });
      return { ...proposal, status: "merged" };
    },

    listPending: (scope, listOptions) =>
      options.repository.listProposals(
        scope,
        listOptions?.all ? undefined : "pending",
      ),
    latestRevision: (scope) => options.repository.latestRevision(scope),
  };
}
