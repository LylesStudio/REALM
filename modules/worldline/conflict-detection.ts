/**
 * M5 deterministic conflict detection for causal change sets.
 *
 * Three layers, per SYSTEM-DESIGN §5.5:
 *   1. deterministic conflicts (life-state / validity contradictions);
 *   2. dependency-graph conflicts (claims depending on rewritten claims);
 *   3. semantic grading via the existing none/bridgeable/hard/high-risk
 *      classifier. Major past changes always recommend a Worldline branch.
 *
 * Detection is read-only: it never rewrites existing Records or claims.
 */

import type { WorldCursor } from "../context/public.ts";
import type { CausalEdge, WorldClaim } from "../world-knowledge/public.ts";
import {
  classifyWorldlineConflict,
  type BranchRecommendation,
} from "./branching.ts";

export type CausalChange = {
  kind: "assert" | "terminate" | "supersede";
  subjectEntityId: string;
  predicate: string;
  objectValue: string;
  /** For supersede/terminate: the existing claim being rewritten. */
  targetClaimId?: string;
  effectiveCursor: WorldCursor;
};

export type CausalChangeSet = {
  changes: readonly CausalChange[];
};

export type DeterministicConflict = {
  kind: "life_state";
  changeSubjectEntityId: string;
  conflictingClaimId: string;
  reason: string;
};

export type DependencyConflict = {
  edgeId: string;
  fromClaimId: string;
  toClaimId: string;
  reason: string;
};

export type CausalConflictReport = {
  deterministic: readonly DeterministicConflict[];
  dependency: readonly DependencyConflict[];
  classification: BranchRecommendation;
};

/** Predicates that describe an entity being alive/active in the world. */
const LIFE_TERMINAL_VALUES = new Set(["dead", "destroyed", "dissolved", "死亡", "毁灭", "瓦解"]);

export function detectCausalConflicts(input: {
  changeSet: CausalChangeSet;
  existingClaims: readonly WorldClaim[];
  causalEdges: readonly CausalEdge[];
  existingFutureCursor: WorldCursor;
}): CausalConflictReport {
  const deterministic: DeterministicConflict[] = [];
  const dependency: DependencyConflict[] = [];
  let earliestChange: WorldCursor | null = null;

  for (const change of input.changeSet.changes) {
    if (
      earliestChange === null
      || compareCursor(change.effectiveCursor, earliestChange) < 0
    ) {
      earliestChange = change.effectiveCursor;
    }
  }

  for (const change of input.changeSet.changes) {
    if (change.kind === "assert") continue;

    // 第一层：确定性冲突。过去终止某人物/实体，而更晚游标的既有 Claim
    // 仍以该主体为活动主体（未被取代、未被废弃）。
    if (
      change.kind === "terminate"
      || LIFE_TERMINAL_VALUES.has(change.objectValue)
    ) {
      for (const claim of input.existingClaims) {
        if (claim.subjectEntityId !== change.subjectEntityId) continue;
        if (claim.truthStatus === "deprecated") continue;
        if (claim.supersedesClaimId !== null && claim.id === change.targetClaimId) {
          continue;
        }
        const claimCursor: WorldCursor = {
          tick: claim.validFromTick,
          ordinal: 0,
          calendarId: "",
          display: "",
        };
        if (compareCursor(claimCursor, change.effectiveCursor) <= 0) continue;
        if (
          claim.predicate === change.predicate
          && LIFE_TERMINAL_VALUES.has(claim.objectValue)
        ) {
          continue;
        }
        deterministic.push({
          kind: "life_state",
          changeSubjectEntityId: change.subjectEntityId,
          conflictingClaimId: claim.id,
          reason:
            `变更在过去终止了 ${change.subjectEntityId}，但未来 Claim ${claim.id}（${claim.predicate}=${claim.objectValue}）仍以其为活动主体。`,
        });
      }
    }

    // 第二层：依赖图冲突。被 supersede/terminate 的 Claim 存在后继依赖。
    if (change.targetClaimId) {
      for (const edge of input.causalEdges) {
        if (edge.fromClaimId !== change.targetClaimId) continue;
        if (edge.edgeKind !== "enables" && edge.edgeKind !== "context") continue;
        const dependent = input.existingClaims.find(
          (claim) => claim.id === edge.toClaimId,
        );
        if (!dependent || dependent.truthStatus === "deprecated") continue;
        dependency.push({
          edgeId: edge.id,
          fromClaimId: edge.fromClaimId,
          toClaimId: edge.toClaimId,
          reason: `Claim ${edge.toClaimId} 通过 ${edge.edgeKind} 依赖被改写的 Claim ${edge.fromClaimId}。`,
        });
      }
    }
  }

  // 第三层：语义分级。确定性冲突必为 hard；依赖冲突至少 bridgeable；
  // 过去重大变更默认建议分支。
  const past = earliestChange ?? input.existingFutureCursor;
  const base = classifyWorldlineConflict({
    pastChange: past,
    existingFuture: input.existingFutureCursor,
    hardCausalAnchors: deterministic.map((conflict) => conflict.conflictingClaimId),
    softContinuityAnchors: dependency.map((conflict) => conflict.toClaimId),
  });
  const classification: BranchRecommendation = deterministic.length > 0
    ? {
        conflict: "hard",
        reason: deterministic[0]?.reason ?? base.reason,
        shouldBranch: true,
      }
    : dependency.length > 0
      ? {
          conflict: base.conflict === "none" ? "bridgeable" : base.conflict,
          reason: dependency[0]?.reason ?? base.reason,
          shouldBranch: compareCursor(past, input.existingFutureCursor) <= 0,
        }
      : base;

  return { deterministic, dependency, classification };
}

function compareCursor(left: WorldCursor, right: WorldCursor): number {
  if (left.tick !== right.tick) return left.tick - right.tick;
  return left.ordinal - right.ordinal;
}
