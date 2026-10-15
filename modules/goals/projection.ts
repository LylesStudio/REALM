import type { JsonValue } from "../runtime/public.ts";
import type {
  GoalDefinition,
  GoalInstanceSnapshot,
  GoalScopeKind,
  GoalState,
} from "./public.ts";

/** Runtime row shape needed to join a Goal instance to its content definition. */
export interface GoalProjectionInstance extends GoalInstanceSnapshot {
  goalKey: string;
}

export interface GoalProjection {
  goalKey: string;
  /** scope 判别位（record | story | worldline）；B2 起 story Goal 复用同一投影类型。 */
  scopeKind: GoalScopeKind;
  state: GoalState;
  /** 当前 attempt（终态重试产生新 attempt / 新 instance id）。 */
  attempt: number;
  /** 本 attempt 取代的前序终态实例 id（首个 attempt 为 null）。 */
  supersedesInstanceId: string | null;
  progress: Readonly<Record<string, JsonValue>>;
  outcome: Readonly<Record<string, JsonValue>> | null;
}

/**
 * Build the player-facing Goal projection.
 *
 * Visibility is content-owned. Runtime assessment results are deliberately not
 * exposed: a terminal projection uses the declared content outcome, never the
 * raw runtime `goal_instances.outcome` (which may contain Judge details).
 */
export function projectGoal(input: {
  definition: Pick<GoalDefinition, "goalKey" | "visible" | "outcome">;
  instance: GoalProjectionInstance;
}): GoalProjection | null {
  if (!input.definition.visible || input.definition.goalKey !== input.instance.goalKey) return null;
  return {
    goalKey: input.instance.goalKey,
    scopeKind: input.instance.scopeKind ?? "record",
    state: input.instance.state,
    attempt: input.instance.attempt ?? 1,
    supersedesInstanceId: input.instance.supersedesInstanceId ?? null,
    progress: { ...input.instance.progress },
    outcome: isTerminal(input.instance.state) ? { ...input.definition.outcome } : null,
  };
}

function isTerminal(state: GoalState): boolean {
  return state === "completed" || state === "failed" || state === "settled";
}
