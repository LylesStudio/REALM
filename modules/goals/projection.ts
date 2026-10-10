import type { JsonValue } from "../runtime/public.ts";
import type { GoalDefinition, GoalInstanceSnapshot, GoalState } from "./public.ts";

/** Runtime row shape needed to join a Goal instance to its content definition. */
export interface GoalProjectionInstance extends GoalInstanceSnapshot {
  goalKey: string;
}

export interface GoalProjection {
  goalKey: string;
  state: GoalState;
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
    state: input.instance.state,
    progress: { ...input.instance.progress },
    outcome: isTerminal(input.instance.state) ? { ...input.definition.outcome } : null,
  };
}

function isTerminal(state: GoalState): boolean {
  return state === "completed" || state === "failed" || state === "settled";
}
