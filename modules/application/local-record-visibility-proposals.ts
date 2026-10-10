/**
 * Local Record 受限可见性提案 registry（Phase 2C）：从
 * local-record-service.ts 拆出的提案签发/授权/绑定边界。行为保持——
 * TTL prune、scope/canonicalVersion/content/idempotency 校验与
 * INVALID_VISIBILITY_CONFIRMATION 各分支文案与拆分前逐行一致。
 *
 * 依赖方向硬边界：本模块只依赖 read-model 的共享类型/错误与
 * orchestration 的可见性类型，绝不 import local-record-service.ts
 *（反向依赖由 facade 以 re-export 维持公开 API 不变）。
 */
import {
  LOCAL_RECORD_DEMO_ACTORS,
  LocalRecordServiceError,
  sameWriteScope,
  type LocalVisibilityProposal,
  type WriteScope,
} from "./local-record-read-model.ts";
import type {
  TurnVisibilityAssessment,
  TurnVisibilityPlan,
} from "../orchestration/public.ts";

const VISIBILITY_PROPOSAL_TTL_MS = 5 * 60 * 1_000;

interface VisibilityProposalEntry extends WriteScope {
  canonicalVersion: number;
  content: string;
  expiresAt: number;
  assessment: Extract<TurnVisibilityPlan, { kind: "restricted" }>;
  reason: string;
  usedByIdempotencyKey?: string;
}

export interface VisibilityProposalRegistry {
  issue(input: {
    scope: WriteScope;
    canonicalVersion: number;
    content: string;
    assessment: TurnVisibilityAssessment;
    audienceNames?: readonly string[];
  }): LocalVisibilityProposal;
  authorize(input: {
    proposalId: string;
    scope: WriteScope;
    canonicalVersion: number;
    content: string;
    idempotencyKey: string;
  }): VisibilityProposalEntry;
  bind(proposalId: string, idempotencyKey: string): void;
}

export function createMemoryVisibilityProposalRegistry(options: {
  clock?: () => Date;
  randomToken?: () => string;
  ttlMs?: number;
} = {}): VisibilityProposalRegistry {
  const entries = new Map<string, VisibilityProposalEntry>();
  const clock = options.clock ?? (() => new Date());
  const randomToken = options.randomToken ?? (() => crypto.randomUUID());
  const ttlMs = options.ttlMs ?? VISIBILITY_PROPOSAL_TTL_MS;

  function prune(now: number): void {
    for (const [proposalId, entry] of entries) {
      if (entry.expiresAt <= now) entries.delete(proposalId);
    }
  }

  return {
    issue({ scope, canonicalVersion, content, assessment, audienceNames: proposedNames }) {
      if (assessment.visibility.kind !== "restricted") {
        throw new LocalRecordServiceError(
          "INVALID_VISIBILITY_CONFIRMATION",
          "Only a restricted visibility assessment can be confirmed.",
        );
      }
      const now = clock().getTime();
      prune(now);
      const proposalId = randomToken();
      entries.set(proposalId, {
        ...scope,
        canonicalVersion,
        content,
        expiresAt: now + ttlMs,
        assessment: assessment.visibility,
        reason: assessment.reason,
      });
      return {
        proposalId,
        kind: "restricted",
        audienceCharacterInstanceIds: assessment.visibility.audienceCharacterInstanceIds,
        audienceNames: proposedNames
          ?? audienceNames(assessment.visibility.audienceCharacterInstanceIds),
        reason: assessment.reason,
      };
    },

    authorize({ proposalId, scope, canonicalVersion, content, idempotencyKey }) {
      const now = clock().getTime();
      prune(now);
      const entry = entries.get(proposalId);
      if (
        !entry
        || !sameWriteScope(entry, scope)
        || entry.canonicalVersion !== canonicalVersion
        || entry.content !== content
      ) {
        throw new LocalRecordServiceError(
          "INVALID_VISIBILITY_CONFIRMATION",
          "The visibility confirmation is missing, expired, or no longer matches this draft.",
        );
      }
      if (
        entry.usedByIdempotencyKey !== undefined
        && entry.usedByIdempotencyKey !== idempotencyKey
      ) {
        throw new LocalRecordServiceError(
          "INVALID_VISIBILITY_CONFIRMATION",
          "The visibility confirmation was already used by another Command.",
        );
      }
      return entry;
    },

    bind(proposalId, idempotencyKey) {
      const now = clock().getTime();
      prune(now);
      const entry = entries.get(proposalId);
      if (!entry) {
        throw new LocalRecordServiceError(
          "INVALID_VISIBILITY_CONFIRMATION",
          "The visibility confirmation is missing or expired.",
        );
      }
      if (
        entry.usedByIdempotencyKey !== undefined
        && entry.usedByIdempotencyKey !== idempotencyKey
      ) {
        throw new LocalRecordServiceError(
          "INVALID_VISIBILITY_CONFIRMATION",
          "The visibility confirmation was already used by another Command.",
        );
      }
      entry.usedByIdempotencyKey ??= idempotencyKey;
    },
  };
}

function audienceNames(characterInstanceIds: readonly string[]): readonly string[] {
  const actors = LOCAL_RECORD_DEMO_ACTORS;
  return characterInstanceIds.map((id) =>
    actors.find((actor) => actor.characterInstanceId === id)?.displayName
    ?? "未知角色"
  );
}
