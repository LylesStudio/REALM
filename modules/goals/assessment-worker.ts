import {
  evaluateDeterministicGoal,
  goalEvidenceSnapshotHash,
  validateGoalAssessment,
  type GoalAssessmentCandidate,
  type GoalDefinition,
  type GoalEvidenceSummary,
  type GoalEvent,
  type GoalInstanceSnapshot,
  type GoalTransition,
} from "./public.ts";
import type { JsonValue } from "../runtime/public.ts";

export interface GoalAssessmentJob {
  jobId: string;
  workspaceId: string;
  worldId: string;
  worldVersion: string;
  worldlineId: string;
  recordId: string;
  goalInstanceId: string;
  goalKey: string;
  sourceEventId: string;
  attemptCount: number;
  leaseOwner: string;
  leaseExpiresAt: string;
}

export type ClaimedGoalAssessmentJob = GoalAssessmentJob;

export interface GoalAssessmentContext {
  instance: GoalInstanceSnapshot;
  events: readonly GoalEvent[];
  head: { recordVersion: number; ordinal: number };
}

export type GoalAssessmentDecision =
  | {
      status: "accepted";
      source: "deterministic" | "judge";
      policyVersion: string;
      observedHead: { recordVersion: number; ordinal: number };
      transition: GoalTransition;
      evidence: GoalEvidenceSummary;
      result: Readonly<Record<string, JsonValue>>;
    }
  | {
      status: "rejected" | "stale";
      source: "deterministic" | "judge" | "fallback";
      policyVersion: string;
      observedHead: { recordVersion: number; ordinal: number };
      code: string;
      evidence: GoalEvidenceSummary;
      result: Readonly<Record<string, JsonValue>>;
    };

export interface GoalAssessmentJobRepository {
  claimNext(input: { now: string }): Promise<ClaimedGoalAssessmentJob | null>;
  loadContext(job: ClaimedGoalAssessmentJob): Promise<GoalAssessmentContext>;
  settle(input: {
    job: ClaimedGoalAssessmentJob;
    decision: GoalAssessmentDecision;
    now: string;
  }): Promise<"applied" | "retryable">;
  fail(input: {
    job: ClaimedGoalAssessmentJob;
    code: string;
    now: string;
  }): Promise<void>;
}

export interface GoalJudge {
  assess(input: {
    job: ClaimedGoalAssessmentJob;
    definition: GoalDefinition;
    context: GoalAssessmentContext;
  }): Promise<GoalAssessmentCandidate>;
}

export type GoalAssessmentRunReport =
  | { kind: "idle" }
  | { kind: "settled"; status: GoalAssessmentDecision["status"] }
  | { kind: "retryable" }
  | { kind: "failed"; code: string };

export async function runGoalAssessmentOnce(input: {
  repository: GoalAssessmentJobRepository;
  resolveDefinition: (job: ClaimedGoalAssessmentJob) => Promise<GoalDefinition | null>;
  judge?: GoalJudge;
  now: string;
}): Promise<GoalAssessmentRunReport> {
  const job = await input.repository.claimNext({ now: input.now });
  if (!job) return { kind: "idle" };

  let definition: GoalDefinition | null;
  try {
    definition = await input.resolveDefinition(job);
  } catch {
    await input.repository.fail({ job, code: "GOAL_DEFINITION_LOAD_FAILED", now: input.now });
    return { kind: "failed", code: "GOAL_DEFINITION_LOAD_FAILED" };
  }
  if (!definition) {
    await input.repository.fail({
      job,
      code: "GOAL_DEFINITION_UNAVAILABLE",
      now: input.now,
    });
    return { kind: "failed", code: "GOAL_DEFINITION_UNAVAILABLE" };
  }
  if (definition.goalKey !== job.goalKey) {
    await input.repository.fail({ job, code: "GOAL_DEFINITION_SCOPE_MISMATCH", now: input.now });
    return { kind: "failed", code: "GOAL_DEFINITION_SCOPE_MISMATCH" };
  }

  let context: GoalAssessmentContext;
  try {
    context = await input.repository.loadContext(job);
  } catch {
    await input.repository.fail({ job, code: "GOAL_CONTEXT_LOAD_FAILED", now: input.now });
    return { kind: "failed", code: "GOAL_CONTEXT_LOAD_FAILED" };
  }

  if (definition.mode === "deterministic") {
    const evaluation = evaluateDeterministicGoal({ definition, ...context });
    const decision = deterministicDecision(evaluation, definition.policyVersion, context.head);
    const result = await input.repository.settle({ job, decision, now: input.now });
    if (result === "retryable") return { kind: "retryable" };
    return { kind: "settled", status: decision.status };
  }

  if (!input.judge) {
    await input.repository.fail({ job, code: "GOAL_JUDGE_UNAVAILABLE", now: input.now });
    return { kind: "failed", code: "GOAL_JUDGE_UNAVAILABLE" };
  }

  let candidate: GoalAssessmentCandidate;
  try {
    candidate = await input.judge.assess({ job, definition, context });
  } catch {
    await input.repository.fail({ job, code: "GOAL_JUDGE_FAILED", now: input.now });
    return { kind: "failed", code: "GOAL_JUDGE_FAILED" };
  }

  const validation = validateGoalAssessment({
    definition,
    instance: context.instance,
    candidate,
    events: context.events,
    head: context.head,
  });
  const decision = semanticDecision(
    validation,
    candidate,
    definition,
    context,
  );
  const result = await input.repository.settle({ job, decision, now: input.now });
  if (result === "retryable") return { kind: "retryable" };
  return { kind: "settled", status: decision.status };
}

function deterministicDecision(
  evaluation: ReturnType<typeof evaluateDeterministicGoal>,
  policyVersion: string,
  observedHead: { recordVersion: number; ordinal: number },
): GoalAssessmentDecision {
  if (evaluation.kind === "transition") {
    return {
      status: "accepted",
      source: "deterministic",
      policyVersion,
      observedHead,
      transition: evaluation.transition,
      evidence: evaluation.transition,
      result: {
        kind: "transition",
        decision: evaluation.transition.to === "completed"
          ? "complete"
          : evaluation.transition.to === "failed"
            ? "fail"
            : "settle",
      },
    };
  }
  return {
    status: "rejected",
    source: "deterministic",
    policyVersion,
    observedHead,
    code: `GOAL_DETERMINISTIC_${evaluation.kind.toUpperCase()}`,
    evidence: evaluation,
    result: {
      kind: evaluation.kind,
      policyVersion,
    },
  };
}

function semanticDecision(
  validation: ReturnType<typeof validateGoalAssessment>,
  candidate: GoalAssessmentCandidate,
  definition: GoalDefinition,
  context: GoalAssessmentContext,
): GoalAssessmentDecision {
  if (validation.kind === "accepted") {
    return {
      status: "accepted",
      source: "judge",
      policyVersion: definition.policyVersion,
      observedHead: context.head,
      transition: validation.transition,
      evidence: validation.transition,
      result: { kind: "accepted", decision: candidate.decision },
    };
  }

  const selectedEvents = candidate.evidenceEventIds.flatMap((eventId) => {
    const event = context.events.find((item) => item.eventId === eventId);
    return event ? [event] : [];
  });
  const evidence: GoalEvidenceSummary = {
    progress: isRecord(candidate.progress) ? candidate.progress : {},
    evidenceEventIds: [...candidate.evidenceEventIds],
    evidenceHead: context.head,
    evidenceSnapshotHash: goalEvidenceSnapshotHash({
      definition,
      instance: context.instance,
      events: selectedEvents,
      evidenceHead: context.head,
    }),
  };
  return {
    status: validation.kind === "stale" ? "stale" : "rejected",
    source: "judge",
    policyVersion: definition.policyVersion,
    observedHead: context.head,
    code: validation.code,
    evidence,
    result: {
      kind: validation.kind,
      decision: candidate.decision,
    },
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, JsonValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
