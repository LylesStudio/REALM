import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { RuntimeInvariantError, type JsonValue } from "../runtime/public.ts";
import { projectGoal } from "./projection.ts";
import {
  goalInstanceIdFor,
  type GoalDefinition,
  type GoalEvent,
  type GoalInstanceSnapshot,
  type GoalRuntimeScope,
} from "./public.ts";

import { normalizeRecordGoalDraft as normalizeDraftData, RecordGoalDraftError, type RecordGoalDraft } from './authoring-contract.ts';
export type { RecordGoalChangePolicy, RecordGoalDraft } from './authoring-contract.ts';
export interface RecordGoalHead { recordVersion: number; ordinal: number }
export interface RecordGoalDefinitionVersion extends GoalDefinition {
  source: "record";
  goalId: string;
  definitionId: string;
  definitionVersion: number;
  goalInstanceId: string;
  scope: GoalRuntimeScope;
  draft: RecordGoalDraft;
  activationHead: RecordGoalHead;
  supersedesDefinitionId: string | null;
  changeReason: string | null;
  changeKind: "created" | "manual" | "automatic";
  basisEventIds: readonly string[];
}

function invalid(code: string): never {
  throw new RuntimeInvariantError(code, "Record Goal authoring contract rejected the operation.");
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid("GOAL_DRAFT_INVALID");
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\0")) invalid("GOAL_DRAFT_INVALID");
  return value.trim();
}
export function normalizeRecordGoalDraft(value: unknown): RecordGoalDraft {
  try { return normalizeDraftData(value); }
  catch (error) { invalid(error instanceof RecordGoalDraftError ? error.code : 'GOAL_DRAFT_INVALID'); }
}
function identity(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(value)) invalid("GOAL_IDENTITY_INVALID");
  return value;
}
function normalizeScope(scope: GoalRuntimeScope): GoalRuntimeScope {
  if (scope.kind !== undefined && scope.kind !== "record") invalid("GOAL_SCOPE_MISMATCH");
  return Object.freeze({
    workspaceId: identity(scope.workspaceId), worldId: identity(scope.worldId),
    worldlineId: identity(scope.worldlineId), recordId: identity(scope.recordId),
  });
}
function normalizeHead(head: RecordGoalHead): RecordGoalHead {
  if (![head.recordVersion, head.ordinal].every((value) => Number.isSafeInteger(value) && value >= 0)) invalid("GOAL_HEAD_INVALID");
  if ((head.recordVersion === 0) !== (head.ordinal === 0)) invalid("GOAL_HEAD_INVALID");
  return Object.freeze({ recordVersion: head.recordVersion, ordinal: head.ordinal });
}
export function createRecordGoalDefinition(input: {
  scope: GoalRuntimeScope; goalId: string; draft: unknown; activationHead: RecordGoalHead;
}): RecordGoalDefinitionVersion {
  const scope = normalizeScope(input.scope);
  const goalId = identity(input.goalId);
  const draft = normalizeRecordGoalDraft(input.draft);
  const activationHead = normalizeHead(input.activationHead);
  const digest = createHash("sha256").update(JSON.stringify([scope, goalId, 1, draft, activationHead])).digest("hex");
  const goalKey = `record.authored.${goalId}.v1`;
  return Object.freeze({
    source: "record", goalId, definitionId: `goal_definition_${digest}`,
    definitionVersion: 1, goalKey, goalInstanceId: goalInstanceIdFor(scope, goalKey),
    scope, draft, activationHead, supersedesDefinitionId: null,
    changeReason: null, changeKind: "created", basisEventIds: Object.freeze([]),
    policyVersion: `record-goal:${digest}`, mode: "semantic", visible: draft.visible,
    rubric: Object.freeze({ kind: "semantic", promptKey: "record.authored.v1" }),
    outcome: Object.freeze({ title: draft.title }),
  });
}
/** Rebuild stored authoring data; JSONB key order is irrelevant, semantic edits are not. */
export function decodeRecordGoalDefinition(value: unknown): RecordGoalDefinitionVersion {
  try {
    const row = object(value);
    if (typeof row.definitionVersion !== "number" || !Number.isSafeInteger(row.definitionVersion)
      || row.definitionVersion < 1) invalid("GOAL_DEFINITION_INVALID");
    const storedScope = object(row.scope);
    const base = createRecordGoalDefinition({
      scope: storedScope as unknown as GoalRuntimeScope, goalId: row.goalId as string,
      draft: row.draft, activationHead: object(row.activationHead) as unknown as RecordGoalHead,
    });
    let expected = base;
    if (row.definitionVersion > 1) {
      if (typeof row.supersedesDefinitionId !== "string"
        || !/^goal_definition_[a-f0-9]{64}$/.test(row.supersedesDefinitionId)
        || (row.changeKind !== "manual" && row.changeKind !== "automatic")
        || !Array.isArray(row.basisEventIds) || row.basisEventIds.length > 16
        || (row.changeKind === "automatic" && row.basisEventIds.length === 0)) invalid("GOAL_DEFINITION_INVALID");
      const basisEventIds = Object.freeze(row.basisEventIds.map((id) => identity(id as string)).sort());
      if (new Set(basisEventIds).size !== basisEventIds.length) invalid("GOAL_DEFINITION_INVALID");
      const changeReason = text(row.changeReason, 2048);
      const digest = createHash("sha256").update(JSON.stringify([
        row.supersedesDefinitionId, row.definitionVersion, base.draft, base.activationHead,
        changeReason, basisEventIds, row.changeKind,
      ])).digest("hex");
      const goalKey = `record.authored.${base.goalId}.v${row.definitionVersion}`;
      expected = Object.freeze({ ...base, definitionVersion: row.definitionVersion,
        definitionId: `goal_definition_${digest}`, policyVersion: `record-goal:${digest}`,
        goalKey, goalInstanceId: goalInstanceIdFor(base.scope, goalKey),
        supersedesDefinitionId: row.supersedesDefinitionId, changeReason,
        changeKind: row.changeKind, basisEventIds,
      });
    }
    if (!isDeepStrictEqual(row, expected)) invalid("GOAL_DEFINITION_INVALID");
    return expected;
  } catch {
    invalid("GOAL_DEFINITION_INVALID");
  }
}

/** Caller supplies a server-computed capability, never the request body flag. */
export function projectRecordAuthoredGoal(input: {
  definition: RecordGoalDefinitionVersion;
  instance: GoalInstanceSnapshot & { goalKey: string };
  managementAllowed: boolean;
}) {
  const { definition, instance } = input;
  if (instance.recordId !== definition.scope.recordId
    || (instance.scopeKind !== undefined && instance.scopeKind !== "record")
    || instance.goalInstanceId !== goalInstanceIdFor(definition.scope, definition.goalKey, instance.attempt ?? 1)) return null;
  const base = projectGoal({ definition, instance });
  if (!base) return null;
  const progress: Record<string, JsonValue> = {};
  if (typeof instance.progress.summary === "string" && instance.progress.summary.length <= 1600) {
    progress.summary = instance.progress.summary;
  }
  const completedCriteria = instance.progress.completedCriteria;
  if (Array.isArray(completedCriteria) && completedCriteria.length <= definition.draft.successConditions.length
    && completedCriteria.every((item) => typeof item === "number" && Number.isSafeInteger(item)
      && item >= 0 && item < definition.draft.successConditions.length)
    && new Set(completedCriteria).size === completedCriteria.length) {
    progress.completedCriteria = [...completedCriteria];
  }
  return {
    ...base, progress,
    source: "record" as const, goalId: definition.goalId,
    definitionId: definition.definitionId, definitionVersion: definition.definitionVersion,
    goalInstanceId: instance.goalInstanceId, revision: instance.revision,
    title: definition.draft.title, description: definition.draft.description,
    changePolicy: definition.draft.changePolicy,
    capabilities: {
      canRevise: input.managementAllowed === true && instance.state === "active" && definition.draft.changePolicy === "evolving",
      canWithdraw: input.managementAllowed === true && instance.state === "active",
    },
  };
}

export interface RecordGoalReplacementInput {
  previous: RecordGoalDefinitionVersion;
  scope: GoalRuntimeScope;
  instance: GoalInstanceSnapshot;
  expectedDefinitionVersion: number;
  expectedInstanceRevision: number;
  nextDraft: unknown;
  reason: string;
  evidenceEventIds: readonly string[];
  events: readonly GoalEvent[];
  observedHead: RecordGoalHead;
}
/** Re-scope immutable archive history; this is not a new authoring/evolution decision. */
export function rebaseRecordGoalDefinitions(input: {
  definitions: readonly unknown[]; scope: GoalRuntimeScope; eventIds: ReadonlyMap<string,string>;
}): readonly RecordGoalDefinitionVersion[] {
  const scope=normalizeScope(input.scope);
  const sources=input.definitions.map(decodeRecordGoalDefinition).sort((a,b)=>a.goalId.localeCompare(b.goalId)||a.definitionVersion-b.definitionVersion);
  const mapped=new Map<string,RecordGoalDefinitionVersion>();
  const result:RecordGoalDefinitionVersion[]=[];
  for(const source of sources) {
    if(mapped.has(source.definitionId)) invalid('GOAL_DEFINITION_INVALID');
    if(sources[0] && !isDeepStrictEqual(source.scope,sources[0].scope)) invalid('GOAL_SCOPE_MISMATCH');
    const base=createRecordGoalDefinition({scope,goalId:source.goalId,draft:source.draft,activationHead:source.activationHead});
    let target=base;
    if(source.definitionVersion>1) {
      const previous=mapped.get(source.supersedesDefinitionId!);
      if(!previous || previous.goalId!==source.goalId || previous.definitionVersion+1!==source.definitionVersion
        || previous.draft.changePolicy==='fixed') invalid('GOAL_DEFINITION_INVALID');
      const basisEventIds=Object.freeze(source.basisEventIds.map(id=>{
        const mappedId=input.eventIds.get(id);if(!mappedId) invalid('GOAL_EVOLUTION_EVIDENCE_INVALID');return identity(mappedId);
      }).sort());
      const digest=createHash('sha256').update(JSON.stringify([previous.definitionId,source.definitionVersion,
        base.draft,base.activationHead,source.changeReason,basisEventIds,source.changeKind])).digest('hex');
      const goalKey=`record.authored.${source.goalId}.v${source.definitionVersion}`;
      target=decodeRecordGoalDefinition({...base,definitionId:`goal_definition_${digest}`,policyVersion:`record-goal:${digest}`,
        definitionVersion:source.definitionVersion,goalKey,goalInstanceId:goalInstanceIdFor(scope,goalKey),
        supersedesDefinitionId:previous.definitionId,changeReason:source.changeReason,changeKind:source.changeKind,basisEventIds});
    }
    mapped.set(source.definitionId,target);result.push(target);
  }
  return Object.freeze(result);
}

export interface RecordGoalManagementTransition {
  goalInstanceId: string;
  from: "active";
  to: "settled";
  revision: number;
  resolutionKind: "withdrawn" | "superseded";
  reason: string;
  evidenceEventIds: readonly string[];
}
export interface RecordGoalReplacement {
  definition: RecordGoalDefinitionVersion;
  instance: GoalInstanceSnapshot;
  previousTransition: RecordGoalManagementTransition;
}
export interface RecordGoalSuccessor {
  definition: RecordGoalDefinitionVersion;
  instance: GoalInstanceSnapshot;
  previousTransition: null;
}
export type RecordGoalEvolutionPlan = RecordGoalReplacement | RecordGoalSuccessor;

export interface RecordGoalWithdrawalInput {
  previous: RecordGoalDefinitionVersion;
  scope: GoalRuntimeScope;
  instance: GoalInstanceSnapshot;
  expectedDefinitionVersion: number;
  expectedInstanceRevision: number;
  reason: string;
}

export function planRecordGoalWithdrawal(input: RecordGoalWithdrawalInput): RecordGoalManagementTransition {
  assertCurrent(input);
  return Object.freeze({
    goalInstanceId: input.instance.goalInstanceId, from: "active", to: "settled",
    revision: input.instance.revision + 1, resolutionKind: "withdrawn",
    reason: text(input.reason, 2048), evidenceEventIds: Object.freeze([]),
  });
}

/** Only repository-loaded committed world results may justify automatic evolution. */
export const RECORD_GOAL_BASIS_EVENT_KINDS: readonly string[] = Object.freeze([
  "narration.committed", "world.consequence.committed", "action.resolved", "scene.crystallized",
]);

function assertCurrent(input: {
  previous: RecordGoalDefinitionVersion; scope: GoalRuntimeScope;
  instance: GoalInstanceSnapshot; expectedDefinitionVersion: number; expectedInstanceRevision: number;
}, naturalTerminalSuccessor = false): void {
  const scope = normalizeScope(input.scope);
  if (["workspaceId", "worldId", "worldlineId", "recordId"].some((key) =>
    scope[key as keyof GoalRuntimeScope] !== input.previous.scope[key as keyof GoalRuntimeScope])
    || input.instance.recordId !== scope.recordId
    || (input.instance.worldlineId !== undefined && input.instance.worldlineId !== scope.worldlineId)
    || input.instance.goalInstanceId !== goalInstanceIdFor(scope, input.previous.goalKey, input.instance.attempt ?? 1)) {
    invalid("GOAL_SCOPE_MISMATCH");
  }
  if (!Number.isSafeInteger(input.instance.revision) || input.instance.revision < 1
    || !Number.isSafeInteger(input.expectedDefinitionVersion) || input.expectedDefinitionVersion < 1
    || input.expectedDefinitionVersion !== input.previous.definitionVersion
    || input.expectedInstanceRevision !== input.instance.revision) invalid("GOAL_WRITE_CONFLICT");
  if (naturalTerminalSuccessor) {
    if (!["completed", "failed", "settled"].includes(input.instance.state) || input.instance.resolutionKind !== "natural") {
      invalid("GOAL_SUCCESSOR_REQUIRES_NATURAL_TERMINAL");
    }
  } else if (input.instance.state !== "active") invalid("GOAL_INSTANCE_TERMINAL");
}

export function planRecordGoalReplacement(input: RecordGoalReplacementInput): RecordGoalReplacement {
  return planReplacement(input, "automatic");
}

/** Append a genuine next stage; never rewrite, settle again or revive the terminal predecessor. */
export function planRecordGoalSuccessor(input: RecordGoalReplacementInput): RecordGoalSuccessor {
  return planReplacement(input, "automatic", true);
}

/** Must be invoked only after the repository has authorized a management command. */
export function planRecordGoalRevision(input: RecordGoalReplacementInput): RecordGoalReplacement {
  return planReplacement(input, "manual");
}

function planReplacement(input: RecordGoalReplacementInput, changeKind: "manual" | "automatic", terminalSuccessor?: false): RecordGoalReplacement;
function planReplacement(input: RecordGoalReplacementInput, changeKind: "automatic", terminalSuccessor: true): RecordGoalSuccessor;
function planReplacement(input: RecordGoalReplacementInput, changeKind: "manual" | "automatic", terminalSuccessor = false): RecordGoalEvolutionPlan {
  assertCurrent(input, terminalSuccessor);
  if (input.previous.draft.changePolicy === "fixed") invalid("GOAL_DEFINITION_FIXED");
  const nextDraft = normalizeRecordGoalDraft(input.nextDraft);
  if (changeKind === "automatic" && nextDraft.changePolicy !== input.previous.draft.changePolicy) invalid("GOAL_CHANGE_POLICY_CONFLICT");
  if (changeKind === "automatic" && nextDraft.visible !== input.previous.draft.visible) invalid("GOAL_VISIBILITY_CHANGE_REQUIRES_AUTHORIZATION");
  const reason = text(input.reason, 2048);
  const observedHead = normalizeHead(input.observedHead);
  if (observedHead.recordVersion < input.previous.activationHead.recordVersion
    || observedHead.ordinal < input.previous.activationHead.ordinal) invalid("GOAL_HEAD_INVALID");
  if (!Array.isArray(input.evidenceEventIds) || (changeKind === "automatic" && input.evidenceEventIds.length < 1)
    || input.evidenceEventIds.length > 16 || new Set(input.evidenceEventIds).size !== input.evidenceEventIds.length) invalid("GOAL_EVOLUTION_EVIDENCE_INVALID");
  if (input.events.some((event) => event.recordId !== input.scope.recordId)
    || new Set(input.events.map((event) => event.eventId)).size !== input.events.length) invalid("GOAL_SCOPE_MISMATCH");
  const events = new Map(input.events.map((event) => [event.eventId, event]));
  for (const id of input.evidenceEventIds) {
    const event = events.get(id);
    if (!event || !RECORD_GOAL_BASIS_EVENT_KINDS.includes(event.kind)
      || !Number.isSafeInteger(event.recordVersion) || !Number.isSafeInteger(event.ordinal)
      || event.recordVersion <= input.previous.activationHead.recordVersion
      || event.ordinal <= input.previous.activationHead.ordinal
      || event.recordVersion > observedHead.recordVersion || event.ordinal > observedHead.ordinal) invalid("GOAL_EVOLUTION_EVIDENCE_INVALID");
  }
  if (JSON.stringify(nextDraft) === JSON.stringify(input.previous.draft)) invalid("GOAL_DEFINITION_UNCHANGED");
  const version = input.previous.definitionVersion + 1;
  if (!Number.isSafeInteger(version)) invalid("GOAL_WRITE_CONFLICT");
  const basisEventIds = Object.freeze([...input.evidenceEventIds].sort());
  const digest = createHash("sha256").update(JSON.stringify([
    input.previous.definitionId, version, nextDraft, observedHead, reason, basisEventIds, changeKind,
  ])).digest("hex");
  const goalKey = `record.authored.${input.previous.goalId}.v${version}`;
  const goalInstanceId = goalInstanceIdFor(input.previous.scope, goalKey);
  const definition: RecordGoalDefinitionVersion = Object.freeze({
    ...input.previous, definitionId: `goal_definition_${digest}`, definitionVersion: version,
    goalKey, goalInstanceId, draft: nextDraft, visible: nextDraft.visible,
    policyVersion: `record-goal:${digest}`, activationHead: observedHead,
    supersedesDefinitionId: input.previous.definitionId, changeReason: reason, changeKind, basisEventIds,
    outcome: Object.freeze({ title: nextDraft.title }),
  });
  return Object.freeze({
    definition,
    instance: Object.freeze({
      goalInstanceId, recordId: input.scope.recordId, state: "active", revision: 1,
      progress: Object.freeze({}), outcome: null, scopeKind: "record", attempt: 1,
      supersedesInstanceId: input.instance.goalInstanceId,
    }),
    previousTransition: terminalSuccessor ? null : Object.freeze({
      goalInstanceId: input.instance.goalInstanceId, from: "active", to: "settled",
      revision: input.instance.revision + 1, resolutionKind: "superseded", reason,
      evidenceEventIds: basisEventIds,
    }),
  });
}
