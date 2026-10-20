import type { GoalDefinition, GoalEventCountRubric, GoalSemanticRubric } from "../goals/public.ts";
import { normalizeGoalSemanticCriteria } from "../goals/public.ts";
import type { JsonValue } from "../runtime/public.ts";
import type { RealmWorldManifestV1 } from "./realmworld-manifest.ts";

export type RealmWorldContentErrorCode =
  | "GOALS_UNAVAILABLE"
  | "GOALS_INVALID"
  | "GOAL_NOT_FOUND";

export class RealmWorldContentError extends Error {
  readonly code: RealmWorldContentErrorCode;

  constructor(code: RealmWorldContentErrorCode, message: string) {
    super(message);
    this.name = "RealmWorldContentError";
    this.code = code;
  }
}

export interface RealmWorldGoalsDocumentV1 {
  format: "realmworld-goals";
  schemaVersion: 1;
  goals: readonly GoalDefinition[];
}

export interface RealmWorldContentStore {
  manifest: RealmWorldManifestV1;
  listGoalDefinitions(): readonly GoalDefinition[];
  resolveGoalDefinition(goalKey: string): GoalDefinition | null;
}

const GOALS_PATH = "content/goals.json";
const MAX_GOAL_KEY_LENGTH = 256;
const MAX_POLICY_VERSION_LENGTH = 256;
const MAX_PROMPT_KEY_LENGTH = 512;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isPlainObject(value) && Object.values(value).every(isJsonValue);
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new RealmWorldContentError("GOALS_INVALID", `unknown RealmWorld goals key ${where}.${key}`);
    }
  }
}

function requireField(value: Record<string, unknown>, key: string, where: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(value, key)) {
    throw new RealmWorldContentError("GOALS_INVALID", `RealmWorld goals key ${where}.${key} is required`);
  }
  return value[key];
}

function requireText(value: unknown, where: string, maxLength: number): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maxLength
    || value.trim() !== value
  ) {
    throw new RealmWorldContentError("GOALS_INVALID", `RealmWorld goals ${where} is invalid`);
  }
  return value;
}

function parseGoalDefinition(value: unknown, index: number): GoalDefinition {
  const where = `goals[${index}]`;
  if (!isPlainObject(value)) {
    throw new RealmWorldContentError("GOALS_INVALID", `RealmWorld ${where} must be an object`);
  }
  assertExactKeys(value, ["goalKey", "policyVersion", "mode", "visible", "rubric", "outcome", "terminals", "retryable"], where);
  const goalKey = requireText(requireField(value, "goalKey", where), `${where}.goalKey`, MAX_GOAL_KEY_LENGTH);
  const policyVersion = requireText(
    requireField(value, "policyVersion", where),
    `${where}.policyVersion`,
    MAX_POLICY_VERSION_LENGTH,
  );
  const mode = requireField(value, "mode", where);
  if (mode !== "deterministic" && mode !== "semantic") {
    throw new RealmWorldContentError("GOALS_INVALID", `RealmWorld ${where}.mode is invalid`);
  }
  if (typeof value.visible !== "boolean") {
    throw new RealmWorldContentError("GOALS_INVALID", `RealmWorld ${where}.visible is invalid`);
  }
  const rubricRaw = requireField(value, "rubric", where);
  if (!isPlainObject(rubricRaw)) {
    throw new RealmWorldContentError("GOALS_INVALID", `RealmWorld ${where}.rubric is invalid`);
  }
  let rubric: GoalDefinition["rubric"];
  if (rubricRaw.kind === "event_count") {
    assertExactKeys(rubricRaw, ["kind", "eventKind", "progressKey", "threshold", "failure"], `${where}.rubric`);
    if (
      typeof rubricRaw.eventKind !== "string"
      || rubricRaw.eventKind.trim() !== rubricRaw.eventKind
      || rubricRaw.eventKind.length === 0
      || typeof rubricRaw.progressKey !== "string"
      || rubricRaw.progressKey.trim() !== rubricRaw.progressKey
      || rubricRaw.progressKey.length === 0
      || !Number.isSafeInteger(rubricRaw.threshold)
      || (rubricRaw.threshold as number) <= 0
    ) {
      throw new RealmWorldContentError("GOALS_INVALID", `RealmWorld ${where}.rubric is invalid`);
    }
    rubric = {
      kind: "event_count",
      eventKind: rubricRaw.eventKind,
      progressKey: rubricRaw.progressKey,
      threshold: rubricRaw.threshold as number,
    } satisfies GoalEventCountRubric;
    if (Object.hasOwn(rubricRaw, "failure")) {
      const failure = rubricRaw.failure;
      if (!isPlainObject(failure)) {
        throw new RealmWorldContentError("GOALS_INVALID", `RealmWorld ${where}.rubric.failure is invalid`);
      }
      assertExactKeys(failure, ["eventKind", "progressKey", "threshold"], `${where}.rubric.failure`);
      if (
        typeof failure.eventKind !== "string"
        || failure.eventKind.trim() !== failure.eventKind
        || failure.eventKind.length === 0
        || failure.eventKind === rubric.eventKind
        || typeof failure.progressKey !== "string"
        || failure.progressKey.trim() !== failure.progressKey
        || failure.progressKey.length === 0
        || failure.progressKey === rubric.progressKey
        || !Number.isSafeInteger(failure.threshold)
        || (failure.threshold as number) <= 0
      ) {
        throw new RealmWorldContentError("GOALS_INVALID", `RealmWorld ${where}.rubric.failure is invalid`);
      }
      rubric.failure = { eventKind: failure.eventKind, progressKey: failure.progressKey,
        threshold: failure.threshold as number };
    }
  } else if (rubricRaw.kind === "semantic") {
    assertExactKeys(rubricRaw, ["kind", "promptKey", "criteria"], `${where}.rubric`);
    rubric = {
      kind: "semantic",
      promptKey: requireText(rubricRaw.promptKey, `${where}.rubric.promptKey`, MAX_PROMPT_KEY_LENGTH),
    } satisfies GoalSemanticRubric;
    if (rubricRaw.criteria !== undefined) {
      try { rubric.criteria=normalizeGoalSemanticCriteria(rubricRaw.criteria); }
      catch { throw new RealmWorldContentError('GOALS_INVALID','RealmWorld semantic criteria are invalid'); }
    }
  } else {
    throw new RealmWorldContentError("GOALS_INVALID", `RealmWorld ${where}.rubric.kind is invalid`);
  }
  const outcome = requireField(value, "outcome", where);
  if (!isPlainObject(outcome) || !isJsonValue(outcome)) {
    throw new RealmWorldContentError("GOALS_INVALID", `RealmWorld ${where}.outcome is invalid`);
  }
  const extensions: Pick<GoalDefinition, "terminals" | "retryable"> = {};
  if (Object.hasOwn(value, "terminals")) {
    const terminals = value.terminals;
    if (!Array.isArray(terminals) || terminals.length === 0
      || new Set(terminals).size !== terminals.length
      || terminals.some(terminal => terminal !== "completed" && terminal !== "failed" && terminal !== "settled")) {
      throw new RealmWorldContentError("GOALS_INVALID", `RealmWorld ${where}.terminals is invalid`);
    }
    extensions.terminals = [...terminals];
  }
  if (Object.hasOwn(value, "retryable")) {
    if (typeof value.retryable !== "boolean") {
      throw new RealmWorldContentError("GOALS_INVALID", `RealmWorld ${where}.retryable is invalid`);
    }
    extensions.retryable = value.retryable;
  }
  return {
    goalKey,
    policyVersion,
    mode,
    visible: value.visible,
    rubric,
    outcome: outcome as Readonly<Record<string, JsonValue>>,
    ...extensions,
  };
}

function parseGoalsDocument(value: unknown): RealmWorldGoalsDocumentV1 {
  if (!isPlainObject(value)) {
    throw new RealmWorldContentError("GOALS_INVALID", "RealmWorld goals document must be an object");
  }
  assertExactKeys(value, ["format", "schemaVersion", "goals"], "document");
  if (value.format !== "realmworld-goals" || value.schemaVersion !== 1 || !Array.isArray(value.goals)) {
    throw new RealmWorldContentError("GOALS_INVALID", "RealmWorld goals document schema is unsupported");
  }
  const goals = value.goals.map(parseGoalDefinition);
  const keys = new Set<string>();
  for (const goal of goals) {
    if (keys.has(goal.goalKey)) {
      throw new RealmWorldContentError("GOALS_INVALID", "RealmWorld goalKey values must be unique");
    }
    keys.add(goal.goalKey);
  }
  return { format: "realmworld-goals", schemaVersion: 1, goals };
}

export function createRealmWorldContentStore(input: {
  manifest: RealmWorldManifestV1;
  files: ReadonlyMap<string, Uint8Array>;
}): RealmWorldContentStore {
  let goals: readonly GoalDefinition[] | null = null;
  const loadGoals = (): readonly GoalDefinition[] => {
    if (goals) return goals;
    const bytes = input.files.get(GOALS_PATH);
    if (!bytes) {
      throw new RealmWorldContentError("GOALS_UNAVAILABLE", "RealmWorld goal definitions are not installed");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(bytes).toString("utf8"));
    } catch {
      throw new RealmWorldContentError("GOALS_INVALID", "RealmWorld goals document is not valid JSON");
    }
    goals = parseGoalsDocument(parsed).goals;
    return goals;
  };
  return {
    manifest: input.manifest,
    listGoalDefinitions: () => [...loadGoals()],
    resolveGoalDefinition: (goalKey) => {
      const goal = loadGoals().find((candidate) => candidate.goalKey === goalKey);
      return goal ?? null;
    },
  };
}
