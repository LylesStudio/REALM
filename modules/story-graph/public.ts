import { createHash } from "node:crypto";

export type StoryNodeState = "locked" | "active" | "completed" | "failed";
export type StoryTerminalNodeState = "completed" | "failed";
export type StoryGoalState = "active" | "completed" | "failed" | "settled";
export type StoryGoalScope = "record" | "story" | "worldline";

export type StoryUnlockRule =
  | { kind: "story_started" }
  | {
      kind: "goal_state";
      goalKey: string;
      scope: StoryGoalScope;
      state: StoryGoalState;
      recordId?: string;
    }
  | {
      kind: "event_count";
      eventKind: string;
      threshold: number;
      recordId?: string;
    }
  | { kind: "node_state"; nodeKey: string; state: StoryNodeState }
  | { kind: "milestone_status"; milestoneId: string; status: "planned" | "active" | "completed" | "cancelled" }
  | { kind: "obligation_outstanding_at_most"; obligationId: string; maximumMinor: number }
  | { kind: "cash_at_least"; minimumMinor: number }
  | { kind: "all"; rules: readonly StoryUnlockRule[] }
  | { kind: "any"; rules: readonly StoryUnlockRule[] }
  | { kind: "not"; rule: StoryUnlockRule };

export interface StoryRecordNodeDefinition {
  kind: "record";
  nodeKey: string;
  recordKey: string;
  title: string;
  sequence: number;
  initial: boolean;
  unlock: StoryUnlockRule;
}

export interface StoryDefinition {
  storyKey: string;
  title: string;
  premise: string;
  policyVersion: string;
  nodes: readonly StoryRecordNodeDefinition[];
}

export type StoryDefinitionInput = {
  storyKey: string;
  title: string;
  premise?: string;
  policyVersion: string;
  nodes: readonly (Omit<StoryRecordNodeDefinition, "initial" | "unlock"> & {
    initial?: boolean;
    unlock?: StoryUnlockRule;
  })[];
};

export interface StoryEventFact {
  id: string;
  kind: string;
  recordId: string;
  ordinal: number;
}

export interface StoryGoalFact {
  goalKey: string;
  scope: StoryGoalScope;
  state: StoryGoalState;
  recordId?: string;
  evidenceEventIds?: readonly string[];
}

export interface StoryNodeRuntimeSnapshot {
  nodeKey: string;
  state: StoryNodeState;
  recordId: string | null;
  revision: number;
}

/** Only server-committed facts may appear here. Free text/model output is absent by design. */
export interface StoryGraphFacts {
  storyStarted: boolean;
  events: readonly StoryEventFact[];
  goals: readonly StoryGoalFact[];
  nodes: readonly StoryNodeRuntimeSnapshot[];
  /** Committed project milestones. Missing means the rule is unsatisfied. */
  milestones?: readonly { id: string; status: "planned" | "active" | "completed" | "cancelled" }[];
  /** Committed funding obligations. Missing means the rule is unsatisfied. */
  obligations?: readonly { id: string; outstandingMinor: number }[];
  /** Ledger-derived cash. Missing means the rule is unsatisfied. */
  cashBalanceMinor?: number;
}

export interface StoryUnlockEvidence {
  eventIds: readonly string[];
  goalKeys: readonly string[];
  nodeKeys: readonly string[];
  milestoneIds?: readonly string[];
  obligationIds?: readonly string[];
}

export interface StoryUnlockEvaluation {
  satisfied: boolean;
  evidence: StoryUnlockEvidence;
}

export interface EligibleStoryRecordNode {
  node: StoryRecordNodeDefinition;
  evidence: StoryUnlockEvidence;
}

export type StoryGraphErrorCode =
  | "STORY_DEFINITION_INVALID"
  | "STORY_IDENTITY_INVALID"
  | "STORY_RULE_INVALID";

export class StoryGraphError extends Error {
  readonly code: StoryGraphErrorCode;

  constructor(code: StoryGraphErrorCode, message: string) {
    super(message);
    this.name = "StoryGraphError";
    this.code = code;
  }
}

const NODE_STATES = new Set<StoryNodeState>(["locked", "active", "completed", "failed"]);
const GOAL_STATES = new Set<StoryGoalState>(["active", "completed", "failed", "settled"]);
const GOAL_SCOPES = new Set<StoryGoalScope>(["record", "story", "worldline"]);
const MAX_NODES = 256;
const MAX_RULE_DEPTH = 12;
const MAX_RULES_PER_COMPOSITE = 64;

export function normalizeStoryDefinition(input: StoryDefinitionInput): StoryDefinition {
  if (!isObject(input)) invalidDefinition("definition must be an object");
  const storyKey = boundedText(input.storyKey, "storyKey", 128);
  const title = boundedText(input.title, "title", 240);
  const premise = boundedText(input.premise ?? "", "premise", 4_000);
  const policyVersion = boundedText(input.policyVersion, "policyVersion", 128);
  if (!Array.isArray(input.nodes) || input.nodes.length === 0 || input.nodes.length > MAX_NODES) {
    invalidDefinition("nodes must be a non-empty bounded array");
  }

  const rawNodes = input.nodes as readonly Record<string, unknown>[];
  const nodeKeys = new Set<string>();
  for (const raw of rawNodes) {
    if (!isObject(raw)) invalidDefinition("each node must be an object");
    const nodeKey = boundedText(raw.nodeKey, "nodeKey", 128);
    if (nodeKeys.has(nodeKey)) invalidDefinition(`duplicate nodeKey ${nodeKey}`);
    nodeKeys.add(nodeKey);
  }

  const nodes = rawNodes.map((raw) => {
    if (raw.kind !== "record") invalidDefinition("only record story nodes are supported");
    const nodeKey = boundedText(raw.nodeKey, "nodeKey", 128);
    const recordKey = boundedText(raw.recordKey, "recordKey", 128);
    const nodeTitle = boundedText(raw.title, "node.title", 240);
    const sequence = raw.sequence;
    if (!Number.isSafeInteger(sequence) || (sequence as number) < 0) {
      invalidDefinition(`node ${nodeKey} sequence must be a non-negative safe integer`);
    }
    const initial = raw.initial === true;
    const unlock = raw.unlock === undefined
      ? (initial ? ({ kind: "story_started" } as const) : undefined)
      : normalizeRule(raw.unlock, nodeKeys, 0);
    if (!unlock) invalidDefinition(`node ${nodeKey} requires unlock or initial=true`);
    return {
      kind: "record" as const,
      nodeKey,
      recordKey,
      title: nodeTitle,
      sequence: sequence as number,
      initial,
      unlock,
    };
  });

  if (nodes.filter((node) => node.initial).length !== 1) {
    invalidDefinition("exactly one initial record node is required");
  }

  const normalized: StoryDefinition = {
    storyKey,
    title,
    premise,
    policyVersion,
    nodes: nodes.toSorted(compareNodes),
  };
  return deepFreeze(normalized);
}

export function evaluateUnlockRule(
  rule: StoryUnlockRule,
  facts: StoryGraphFacts,
): StoryUnlockEvaluation {
  switch (rule.kind) {
    case "story_started":
      return { satisfied: facts.storyStarted === true, evidence: emptyEvidence() };
    case "goal_state": {
      const matched = facts.goals.filter((goal) => (
        goal.goalKey === rule.goalKey
        && goal.scope === rule.scope
        && goal.state === rule.state
        && (rule.recordId === undefined || goal.recordId === rule.recordId)
      ));
      if (matched.length === 0) return { satisfied: false, evidence: emptyEvidence() };
      const explicitEvidence = matched.flatMap((goal) => goal.evidenceEventIds ?? []);
      const fallbackEvidence = facts.events
        .filter((event) => event.kind === "goal.transition.committed")
        .map((event) => event.id);
      return {
        satisfied: true,
        evidence: {
          eventIds: uniqueSorted(explicitEvidence.length > 0 ? explicitEvidence : fallbackEvidence),
          goalKeys: [rule.goalKey],
          nodeKeys: [],
        },
      };
    }
    case "event_count": {
      const matched = facts.events
        .filter((event) => event.kind === rule.eventKind)
        .filter((event) => rule.recordId === undefined || event.recordId === rule.recordId)
        .toSorted(compareEvents);
      return {
        satisfied: matched.length >= rule.threshold,
        evidence: {
          eventIds: matched.map((event) => event.id),
          goalKeys: [],
          nodeKeys: [],
        },
      };
    }
    case "node_state": {
      const matched = facts.nodes.find((node) => node.nodeKey === rule.nodeKey && node.state === rule.state);
      return {
        satisfied: matched !== undefined,
        evidence: matched ? { eventIds: [], goalKeys: [], nodeKeys: [rule.nodeKey] } : emptyEvidence(),
      };
    }
    case "milestone_status": {
      const matched = facts.milestones?.find((milestone) => milestone.id === rule.milestoneId && milestone.status === rule.status);
      return {
        satisfied: matched !== undefined,
        evidence: matched
          ? { eventIds: [], goalKeys: [], nodeKeys: [], milestoneIds: [rule.milestoneId] }
          : emptyEvidence(),
      };
    }
    case "obligation_outstanding_at_most": {
      const matched = facts.obligations?.find((obligation) => obligation.id === rule.obligationId);
      const satisfied = matched !== undefined && matched.outstandingMinor <= rule.maximumMinor;
      return {
        satisfied,
        evidence: satisfied
          ? { eventIds: [], goalKeys: [], nodeKeys: [], obligationIds: [rule.obligationId] }
          : emptyEvidence(),
      };
    }
    case "cash_at_least": {
      const satisfied = facts.cashBalanceMinor !== undefined && facts.cashBalanceMinor >= rule.minimumMinor;
      return { satisfied, evidence: emptyEvidence() };
    }
    case "all": {
      const evaluations = rule.rules.map((child) => evaluateUnlockRule(child, facts));
      return {
        satisfied: evaluations.every((evaluation) => evaluation.satisfied),
        evidence: mergeEvidence(evaluations.filter((evaluation) => evaluation.satisfied).map((evaluation) => evaluation.evidence)),
      };
    }
    case "any": {
      const selected = rule.rules.find((child) => evaluateUnlockRule(child, facts).satisfied);
      if (!selected) return { satisfied: false, evidence: emptyEvidence() };
      const evaluation = evaluateUnlockRule(selected, facts);
      return evaluation;
    }
    case "not": {
      const evaluation = evaluateUnlockRule(rule.rule, facts);
      return { satisfied: !evaluation.satisfied, evidence: emptyEvidence() };
    }
  }
}

export function getEligibleStoryRecordNodes(
  definition: StoryDefinition,
  facts: StoryGraphFacts,
): readonly EligibleStoryRecordNode[] {
  const stateByNode = new Map(facts.nodes.map((node) => [node.nodeKey, node]));
  return definition.nodes
    .filter((node) => (stateByNode.get(node.nodeKey)?.state ?? "locked") === "locked")
    .map((node) => ({ node, evaluation: evaluateUnlockRule(node.unlock, facts) }))
    .filter(({ evaluation }) => evaluation.satisfied)
    .map(({ node, evaluation }) => ({ node, evidence: evaluation.evidence }));
}

export function storyDefinitionHashFor(definition: StoryDefinition): string {
  return hashWithPrefix("story-definition:v1", canonicalize(definition));
}

export function storyUnlockEvidenceHashFor(input: {
  definitionHash: string;
  nodeKey: string;
  evidence: StoryUnlockEvidence;
}): string {
  assertIdentity(
    {
      definitionHash: input.definitionHash,
      nodeKey: input.nodeKey,
    },
    input.definitionHash,
    "definitionHash",
  );
  return hashWithPrefix(
    "story-unlock-evidence:v1",
    canonicalize({
      definitionHash: input.definitionHash,
      nodeKey: input.nodeKey,
      evidence: input.evidence,
    }),
  );
}

export function storyNodeInstanceIdFor(
  scope: { workspaceId: string; worldId: string; worldlineId: string; storyId: string },
  nodeKey: string,
): string {
  assertIdentity(scope, nodeKey, "nodeKey");
  return `story_node_${hashWithPrefix(
    "story-node-instance:v1",
    [scope.workspaceId, scope.worldId, scope.worldlineId, scope.storyId, nodeKey].join("\0"),
  ).slice(0, 24)}`;
}

export function storyRecordIdFor(
  scope: { workspaceId: string; worldId: string; worldlineId: string; storyId: string },
  nodeKey: string,
): string {
  assertIdentity(scope, nodeKey, "nodeKey");
  return `record_${hashWithPrefix(
    "story-node-record:v1",
    [scope.workspaceId, scope.worldId, scope.worldlineId, scope.storyId, nodeKey].join("\0"),
  ).slice(0, 18)}`;
}

export function storyUnlockLedgerIdFor(
  nodeInstanceId: string,
  transition: "unlocked" | "rolled_back",
  evidenceHash: string,
): string {
  assertIdentity({ nodeInstanceId, transition, evidenceHash }, evidenceHash, "evidenceHash");
  return `story_unlock_${hashWithPrefix(
    "story-unlock-ledger:v1",
    [nodeInstanceId, transition, evidenceHash].join("\0"),
  ).slice(0, 24)}`;
}

export function storyUnlockIdempotencyKeyFor(
  nodeInstanceId: string,
  transition: "unlocked" | "rolled_back",
  evidenceHash: string,
): string {
  return `story-unlock:${nodeInstanceId}:${transition}:${evidenceHash}`;
}

function normalizeRule(
  value: unknown,
  nodeKeys: ReadonlySet<string>,
  depth: number,
): StoryUnlockRule {
  if (!isObject(value) || depth > MAX_RULE_DEPTH || typeof value.kind !== "string") {
    invalidDefinition("Story unlock rule is invalid.");
  }
  switch (value.kind) {
    case "story_started":
      return { kind: "story_started" };
    case "goal_state": {
      const goalKey = boundedText(value.goalKey, "goalKey", 128);
      if (!GOAL_SCOPES.has(value.scope as StoryGoalScope) || !GOAL_STATES.has(value.state as StoryGoalState)) {
        invalidDefinition("Goal unlock rule has an invalid scope or state.");
      }
      const recordId = value.recordId === undefined ? undefined : boundedText(value.recordId, "recordId", 128);
      return {
        kind: "goal_state",
        goalKey,
        scope: value.scope as StoryGoalScope,
        state: value.state as StoryGoalState,
        ...(recordId === undefined ? {} : { recordId }),
      };
    }
    case "event_count": {
      const eventKind = boundedText(value.eventKind, "eventKind", 160);
      if (!Number.isSafeInteger(value.threshold) || (value.threshold as number) < 1) {
        invalidDefinition("Event unlock threshold must be a positive safe integer.");
      }
      const recordId = value.recordId === undefined ? undefined : boundedText(value.recordId, "recordId", 128);
      return {
        kind: "event_count",
        eventKind,
        threshold: value.threshold as number,
        ...(recordId === undefined ? {} : { recordId }),
      };
    }
    case "node_state": {
      const nodeKey = boundedText(value.nodeKey, "nodeKey", 128);
      if (!nodeKeys.has(nodeKey) || !NODE_STATES.has(value.state as StoryNodeState)) {
        invalidDefinition("Node unlock rule references an invalid node or state.");
      }
      return { kind: "node_state", nodeKey, state: value.state as StoryNodeState };
    }
    case "milestone_status": {
      const milestoneId = boundedText(value.milestoneId, "milestoneId", 128);
      if (value.status !== "planned" && value.status !== "active" && value.status !== "completed" && value.status !== "cancelled") {
        invalidDefinition("Milestone unlock status is invalid.");
      }
      return { kind: "milestone_status", milestoneId, status: value.status };
    }
    case "obligation_outstanding_at_most": {
      const obligationId = boundedText(value.obligationId, "obligationId", 128);
      if (!Number.isSafeInteger(value.maximumMinor) || (value.maximumMinor as number) < 0) {
        invalidDefinition("Obligation outstanding maximum must be a non-negative safe integer.");
      }
      return {
        kind: "obligation_outstanding_at_most",
        obligationId,
        maximumMinor: value.maximumMinor as number,
      };
    }
    case "cash_at_least": {
      if (!Number.isSafeInteger(value.minimumMinor) || (value.minimumMinor as number) < 0) {
        invalidDefinition("Cash minimum must be a non-negative safe integer.");
      }
      return { kind: "cash_at_least", minimumMinor: value.minimumMinor as number };
    }
    case "all":
    case "any": {
      if (!Array.isArray(value.rules) || value.rules.length === 0 || value.rules.length > MAX_RULES_PER_COMPOSITE) {
        invalidDefinition("Composite unlock rules must have a bounded non-empty rules array.");
      }
      return {
        kind: value.kind,
        rules: value.rules.map((rule) => normalizeRule(rule, nodeKeys, depth + 1)),
      };
    }
    case "not":
      return { kind: "not", rule: normalizeRule(value.rule, nodeKeys, depth + 1) };
    default:
      invalidDefinition(`Unknown story unlock rule kind ${value.kind}.`);
  }
}

function compareNodes(left: StoryRecordNodeDefinition, right: StoryRecordNodeDefinition): number {
  return left.sequence - right.sequence || left.nodeKey.localeCompare(right.nodeKey);
}

function compareEvents(left: StoryEventFact, right: StoryEventFact): number {
  return left.ordinal - right.ordinal || left.id.localeCompare(right.id);
}

function mergeEvidence(evidence: readonly StoryUnlockEvidence[]): StoryUnlockEvidence {
  const milestoneIds = uniqueSorted(evidence.flatMap((item) => item.milestoneIds ?? []));
  const obligationIds = uniqueSorted(evidence.flatMap((item) => item.obligationIds ?? []));
  return {
    eventIds: uniqueSorted(evidence.flatMap((item) => item.eventIds)),
    goalKeys: uniqueSorted(evidence.flatMap((item) => item.goalKeys)),
    nodeKeys: uniqueSorted(evidence.flatMap((item) => item.nodeKeys)),
    ...(milestoneIds.length > 0 ? { milestoneIds } : {}),
    ...(obligationIds.length > 0 ? { obligationIds } : {}),
  };
}

function emptyEvidence(): StoryUnlockEvidence {
  return { eventIds: [], goalKeys: [], nodeKeys: [] };
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function boundedText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") invalidDefinition(`${field} must be a string`);
  const text = value.trim();
  if (!text || text.length > max) invalidDefinition(`${field} is empty or too long`);
  return text;
}

function assertIdentity(scope: Record<string, unknown>, value: string, field: string): void {
  for (const [key, item] of Object.entries(scope)) {
    if (typeof item !== "string" || !item.trim()) {
      throw new StoryGraphError("STORY_IDENTITY_INVALID", `${key} must be a non-empty string`);
    }
  }
  if (!value.trim()) throw new StoryGraphError("STORY_IDENTITY_INVALID", `${field} must be non-empty`);
}

function invalidDefinition(message: string): never {
  throw new StoryGraphError("STORY_DEFINITION_INVALID", message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hashWithPrefix(prefix: string, value: string): string {
  return createHash("sha256").update(`${prefix}\0${value}`).digest("hex");
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new StoryGraphError("STORY_DEFINITION_INVALID", "Non-finite number in story definition.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  throw new StoryGraphError("STORY_DEFINITION_INVALID", "Unsupported value in story definition.");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
