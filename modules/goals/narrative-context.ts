import type { GoalProjection } from "./projection.ts";
import { RuntimeInvariantError, type JsonValue } from "../runtime/public.ts";

export type RecordGoalNarrativeContext = {
  schemaVersion: 1; headOrdinal: number; omittedGoals: number;
  goals: readonly (Pick<GoalProjection, "goalKey" | "scopeKind" | "state" | "attempt" | "progress" | "resolutionKind">
    & { title?: string; description?: string; changePolicy?: "fixed" | "evolving" })[];
};

/** Bounded closed schema: malformed persisted/client material must not become Goal authority. */
export function parseRecordGoalNarrativeContext(serialized: string): RecordGoalNarrativeContext {
  const invalid = (): never => { throw new RuntimeInvariantError("GOAL_CONTEXT_INVALID", "Record Goal context is invalid."); };
  if (typeof serialized !== "string" || serialized.length > 6000) return invalid();
  let value: unknown;
  try { value = JSON.parse(serialized); } catch { return invalid(); }
  const object = (item: unknown): Record<string, unknown> => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return invalid();
    return item as Record<string, unknown>;
  };
  const keys = (row: Record<string, unknown>, allowed: readonly string[]) => {
    if (Object.keys(row).some(key => !allowed.includes(key))) invalid();
  };
  const ordinal = (item: unknown): number => {
    if (typeof item !== "number" || !Number.isSafeInteger(item) || item < 0) return invalid();
    return item;
  };
  const text = (item: unknown, maximum: number): string => {
    if (typeof item !== "string" || !item.trim() || item.length > maximum || item.includes("\0")) return invalid();
    return item;
  };
  const json = (item: unknown, depth = 0): boolean => {
    if (depth > 24) return false;
    if (item === null || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (typeof item === "string") return !item.includes("\0");
    if (!item || typeof item !== "object") return false;
    return Object.values(item).every(child => json(child, depth + 1));
  };
  const root = object(value);
  keys(root, ["schemaVersion", "headOrdinal", "omittedGoals", "goals"]);
  if (root.schemaVersion !== 1 || !Array.isArray(root.goals) || root.goals.length > 64) return invalid();
  const goals = root.goals.map(item => {
    const row = object(item);
    keys(row, ["goalKey", "scopeKind", "state", "attempt", "progress", "resolutionKind", "title", "description", "changePolicy"]);
    if (typeof row.scopeKind !== "string" || !["record", "story", "worldline"].includes(row.scopeKind)
      || typeof row.state !== "string" || !["active", "completed", "failed", "settled"].includes(row.state)
      || ordinal(row.attempt) < 1) return invalid();
    if (row.resolutionKind !== undefined && (typeof row.resolutionKind !== "string"
      || !["natural", "withdrawn", "superseded"].includes(row.resolutionKind)
      || (row.resolutionKind !== "natural" && row.state !== "settled"))) return invalid();
    if (row.changePolicy !== undefined && (typeof row.changePolicy !== "string"
      || !["fixed", "evolving"].includes(row.changePolicy))) return invalid();
    const progress = object(row.progress);
    if (!json(progress)) return invalid();
    return {
      goalKey: text(row.goalKey, 160), scopeKind: row.scopeKind as GoalProjection["scopeKind"],
      state: row.state as GoalProjection["state"], attempt: row.attempt as number,
      progress: progress as Record<string, JsonValue>,
      ...(row.resolutionKind === undefined ? {} : { resolutionKind: row.resolutionKind as GoalProjection["resolutionKind"] }),
      ...(row.title === undefined ? {} : { title: text(row.title, 160) }),
      ...(row.description === undefined ? {} : { description: text(row.description, 4000) }),
      ...(row.changePolicy === undefined ? {} : { changePolicy: row.changePolicy as "fixed" | "evolving" }),
    };
  });
  return { schemaVersion: 1, headOrdinal: ordinal(root.headOrdinal), omittedGoals: ordinal(root.omittedGoals), goals };
}

/** Narrative direction reuses the player-safe projection, never raw assessment rows. */
export function buildRecordGoalNarrativeContext<T extends GoalProjection>(input: {
  headOrdinal: number; goals: readonly T[];
}): string {
  const goals = input.goals.map(goal => ({
    goalKey: goal.goalKey, scopeKind: goal.scopeKind, state: goal.state, attempt: goal.attempt,
    progress: goal.progress,
    ...(goal.resolutionKind === undefined ? {} : { resolutionKind: goal.resolutionKind }),
    ...("title" in goal && typeof goal.title === "string" ? { title: goal.title } : {}),
    ...("description" in goal && typeof goal.description === "string" ? { description: goal.description } : {}),
    ...("changePolicy" in goal && (goal.changePolicy === "fixed" || goal.changePolicy === "evolving")
      ? { changePolicy: goal.changePolicy } : {}),
  }));
  const ordered = [...goals.filter(goal => goal.state === "active"),
    ...goals.filter(goal => goal.state !== "active").reverse()];
  const included: typeof goals = [];
  const serialize = () => JSON.stringify({ schemaVersion: 1, headOrdinal: input.headOrdinal,
    omittedGoals: goals.length - included.length, goals: included });
  for (const goal of ordered) {
    included.push(goal);
    if (serialize().length > 6000) included.pop();
  }
  const document = serialize();
  parseRecordGoalNarrativeContext(document);
  return document;
}
