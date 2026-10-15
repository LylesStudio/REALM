import { createHash } from "node:crypto";

import { readScope, type ProjectScope } from "../projects/public.ts";

const STRUCTURED_FACTOR_POLICY = "structured-factors:v1";
const RELATION_KIND = /^[a-z][a-z0-9_]{0,31}$/;

export type CommittedFactCommandErrorCode =
  | "COMMAND_INVALID"
  | "WRITE_CONFLICT"
  | "IDEMPOTENCY_KEY_REUSE"
  | "EVENT_NOT_FOUND"
  | "ASSET_NOT_FOUND"
  | "ASSET_ALREADY_HELD"
  | "INSUFFICIENT_QUANTITY"
  | "FACTORS_MISSING";

export class CommittedFactCommandError extends Error {
  readonly code: CommittedFactCommandErrorCode;

  constructor(code: CommittedFactCommandErrorCode, message: string) {
    super(message);
    this.name = "CommittedFactCommandError";
    this.code = code;
  }
}

export interface InventoryAdjustmentResult {
  status: "committed" | "replayed";
  commandId: string;
  quantity: number;
  revision: number;
}

export interface InventoryGrantResult {
  status: "committed" | "replayed";
  commandId: string;
  quantity: number;
  revision: number;
}

export interface RelationshipRevisionResult {
  status: "committed" | "replayed";
  commandId: string;
  relationKind: string;
  revisionOrdinal: number;
  occurred: { worldTick: number; worldOrdinal: number };
}

export interface PerformanceAssessmentResult {
  status: "committed" | "replayed";
  commandId: string;
  assessmentId: string;
  score: number;
  evidenceSnapshotHash: string;
  goalTransition: null;
}

export interface CommittedFactCommandStore {
  loadCommand(scope: ProjectScope, idempotencyKey: string): Promise<{
    requestFingerprint: string;
    result: InventoryAdjustmentResult | RelationshipRevisionResult | PerformanceAssessmentResult;
  } | null>;
  adjustInventory(input: {
    scope: ProjectScope;
    commandId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    recordId: string;
    characterInstanceId: string;
    assetDefinitionId: string;
    delta: number;
    sourceEventId: string;
    expectedRevision: number;
  }): Promise<InventoryAdjustmentResult>;
  grantInventory(input: {
    scope: ProjectScope;
    commandId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    recordId: string;
    characterInstanceId: string;
    assetDefinitionId: string;
    quantity: number;
    sourceEventId: string;
  }): Promise<InventoryGrantResult>;
  reviseRelationship(input: {
    scope: ProjectScope;
    commandId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    subjectEntityKey: string;
    objectEntityKey: string;
    relationKind: string;
    sourceEventId: string;
  }): Promise<RelationshipRevisionResult>;
  loadPerformanceFacts(input: {
    scope: ProjectScope;
    recordId: string;
    evidenceEventIds: readonly string[];
  }): Promise<{ evidenceCount: number; milestoneCompleted: boolean }>;
  recordPerformanceAssessment(input: {
    scope: ProjectScope;
    commandId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    recordId: string;
    policyVersion: string;
    score: number;
    evidenceEventIds: readonly string[];
    evidenceSnapshotHash: string;
  }): Promise<PerformanceAssessmentResult>;
}

export function createCommittedFactCommandService(options: { store: CommittedFactCommandStore }) {
  return {
    async adjustInventory(command: {
      scope: ProjectScope;
      recordId: string;
      characterInstanceId: string;
      assetDefinitionId: string;
      delta: number;
      sourceEventId: string;
      expectedRevision: number;
      idempotencyKey: string;
      possession?: unknown;
      quantity?: unknown;
      owned?: unknown;
    }): Promise<InventoryAdjustmentResult> {
      rejectClientAuthority(command, ["possession", "quantity", "owned", "balanceMinor"]);
      const scope = readScope(command.scope);
      const delta = nonzeroInteger(command.delta, "delta");
      const requestFingerprint = fingerprint(scope, {
        command: "inventory.adjusted",
        recordId: required(command.recordId, "recordId"),
        characterInstanceId: required(command.characterInstanceId, "characterInstanceId"),
        assetDefinitionId: required(command.assetDefinitionId, "assetDefinitionId"),
        delta,
        sourceEventId: required(command.sourceEventId, "sourceEventId"),
        expectedRevision: revision(command.expectedRevision),
      });
      return replayOrCommit(options.store, scope, command.idempotencyKey, requestFingerprint, (commandId) => (
        options.store.adjustInventory({
          scope,
          commandId,
          idempotencyKey: required(command.idempotencyKey, "idempotencyKey"),
          requestFingerprint,
          recordId: required(command.recordId, "recordId"),
          characterInstanceId: required(command.characterInstanceId, "characterInstanceId"),
          assetDefinitionId: required(command.assetDefinitionId, "assetDefinitionId"),
          delta,
          sourceEventId: required(command.sourceEventId, "sourceEventId"),
          expectedRevision: revision(command.expectedRevision),
        })
      ));
    },
    async grantInventory(command: {
      scope: ProjectScope;
      recordId: string;
      characterInstanceId: string;
      assetDefinitionId: string;
      quantity: number;
      sourceEventId: string;
      idempotencyKey: string;
      possession?: unknown;
      owned?: unknown;
      delta?: unknown;
    }): Promise<InventoryGrantResult> {
      rejectClientAuthority(command, ["possession", "owned", "delta", "balanceMinor"]);
      const scope = readScope(command.scope);
      const quantity = positiveInteger(command.quantity, "quantity");
      const requestFingerprint = fingerprint(scope, {
        command: "inventory.granted",
        recordId: required(command.recordId, "recordId"),
        characterInstanceId: required(command.characterInstanceId, "characterInstanceId"),
        assetDefinitionId: required(command.assetDefinitionId, "assetDefinitionId"),
        quantity,
        sourceEventId: required(command.sourceEventId, "sourceEventId"),
      });
      return replayOrCommit(options.store, scope, command.idempotencyKey, requestFingerprint, (commandId) => (
        options.store.grantInventory({
          scope,
          commandId,
          idempotencyKey: required(command.idempotencyKey, "idempotencyKey"),
          requestFingerprint,
          recordId: required(command.recordId, "recordId"),
          characterInstanceId: required(command.characterInstanceId, "characterInstanceId"),
          assetDefinitionId: required(command.assetDefinitionId, "assetDefinitionId"),
          quantity,
          sourceEventId: required(command.sourceEventId, "sourceEventId"),
        })
      ));
    },
    async reviseRelationship(command: {
      scope: ProjectScope;
      subjectEntityKey: string;
      objectEntityKey: string;
      relationKind: string;
      sourceEventId: string;
      idempotencyKey: string;
      relationshipDelta?: unknown;
      delta?: unknown;
      fidelity?: unknown;
      observerContinuityId?: unknown;
      content?: unknown;
    }): Promise<RelationshipRevisionResult> {
      rejectClientAuthority(command, [
        "relationshipDelta",
        "delta",
        "fidelity",
        "observerContinuityId",
        "content",
        "balanceMinor",
      ]);
      const scope = readScope(command.scope);
      const subjectEntityKey = required(command.subjectEntityKey, "subjectEntityKey");
      const objectEntityKey = required(command.objectEntityKey, "objectEntityKey");
      if (subjectEntityKey === objectEntityKey) {
        throw new CommittedFactCommandError("COMMAND_INVALID", "subjectEntityKey and objectEntityKey must differ.");
      }
      const relationKind = readRelationKind(command.relationKind);
      const requestFingerprint = fingerprint(scope, {
        command: "relationship.revised",
        subjectEntityKey,
        objectEntityKey,
        relationKind,
        sourceEventId: required(command.sourceEventId, "sourceEventId"),
      });
      return replayOrCommit(options.store, scope, command.idempotencyKey, requestFingerprint, (commandId) => (
        options.store.reviseRelationship({
          scope,
          commandId,
          idempotencyKey: required(command.idempotencyKey, "idempotencyKey"),
          requestFingerprint,
          subjectEntityKey,
          objectEntityKey,
          relationKind,
          sourceEventId: required(command.sourceEventId, "sourceEventId"),
        })
      ));
    },
    async recordPerformanceAssessment(command: {
      scope: ProjectScope;
      recordId: string;
      policyVersion: string;
      evidenceEventIds: readonly string[];
      idempotencyKey: string;
      score?: unknown;
      factors?: unknown;
      unlocked?: unknown;
      goalCompleted?: unknown;
      decision?: unknown;
      failed?: unknown;
    }): Promise<PerformanceAssessmentResult> {
      rejectClientAuthority(command, ["score", "factors", "unlocked", "goalCompleted", "decision", "failed", "balanceMinor"]);
      const scope = readScope(command.scope);
      const policyVersion = required(command.policyVersion, "policyVersion");
      if (policyVersion !== STRUCTURED_FACTOR_POLICY) {
        throw new CommittedFactCommandError("COMMAND_INVALID", "policyVersion is invalid.");
      }
      const evidenceEventIds = readEvidenceIds(command.evidenceEventIds);
      const recordId = required(command.recordId, "recordId");
      const facts = await options.store.loadPerformanceFacts({ scope, recordId, evidenceEventIds });
      const score = scoreFromCommittedFacts(facts);
      const requestFingerprint = fingerprint(scope, {
        command: "performance.assessed",
        recordId,
        policyVersion,
        score,
        evidenceEventIds,
      });
      return replayOrCommit(options.store, scope, command.idempotencyKey, requestFingerprint, (commandId) => (
        options.store.recordPerformanceAssessment({
          scope,
          commandId,
          idempotencyKey: required(command.idempotencyKey, "idempotencyKey"),
          requestFingerprint,
          recordId,
          policyVersion,
          score,
          evidenceEventIds,
          evidenceSnapshotHash: evidenceHash(evidenceEventIds),
        })
      ));
    },
  };
}

export function evidenceHash(evidenceEventIds: readonly string[]): string {
  return createHash("sha256")
    .update(["performance-assessment:v1", ...evidenceEventIds].join("\0"))
    .digest("hex");
}

export function readAssessmentFactors(payload: unknown): Record<string, number> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new CommittedFactCommandError("FACTORS_MISSING", "Performance evidence has no structured factors.");
  }
  const factors = (payload as { assessmentFactors?: unknown }).assessmentFactors;
  if (factors === null || typeof factors !== "object" || Array.isArray(factors)) {
    throw new CommittedFactCommandError("FACTORS_MISSING", "Performance evidence has no structured factors.");
  }
  const entries = Object.entries(factors);
  if (entries.length < 1) {
    throw new CommittedFactCommandError("FACTORS_MISSING", "Performance evidence has no structured factors.");
  }
  const parsed: Record<string, number> = {};
  for (const [key, value] of entries) {
    if (!RELATION_KIND.test(key) || !Number.isSafeInteger(value)) {
      throw new CommittedFactCommandError("COMMAND_INVALID", "assessmentFactors are invalid.");
    }
    parsed[key] = value as number;
  }
  return parsed;
}

export function scoreFromCommittedFacts(facts: {
  evidenceCount: number;
  milestoneCompleted: boolean;
}): number {
  if (!Number.isSafeInteger(facts.evidenceCount) || facts.evidenceCount < 1) {
    throw new CommittedFactCommandError("FACTORS_MISSING", "Performance evidence has no structured factors.");
  }
  return boundedScore(facts.evidenceCount * 10 + (facts.milestoneCompleted ? 20 : 0));
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new CommittedFactCommandError("COMMAND_INVALID", `${field} is invalid.`);
  }
  return value;
}

async function replayOrCommit<T extends { status: "committed" | "replayed" }>(
  store: CommittedFactCommandStore,
  scope: ProjectScope,
  idempotencyKey: string,
  requestFingerprint: string,
  commit: (commandId: string) => Promise<T>,
): Promise<T> {
  const key = required(idempotencyKey, "idempotencyKey");
  const existing = await store.loadCommand(scope, key);
  if (existing) {
    if (existing.requestFingerprint !== requestFingerprint) {
      throw new CommittedFactCommandError("IDEMPOTENCY_KEY_REUSE", "This idempotency key was already used for a different command.");
    }
    return { ...existing.result, status: "replayed" } as unknown as T;
  }
  const commandId = createHash("sha256")
    .update(["committed-fact-command:v1", scope.workspaceId, scope.worldId, scope.worldlineId, key, requestFingerprint].join("\0"))
    .digest("hex")
    .slice(0, 24);
  return commit(`fact_${commandId}`);
}

function fingerprint(scope: ProjectScope, request: Record<string, unknown>): string {
  return createHash("sha256").update(`committed-fact-command:v1\0${stable({ scope, request })}`).digest("hex");
}

function rejectClientAuthority(command: object, fields: readonly string[]): void {
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(command, field) && (command as Record<string, unknown>)[field] !== undefined) {
      throw new CommittedFactCommandError("COMMAND_INVALID", `${field} is not an authoritative client field.`);
    }
  }
}

function readRelationKind(value: string): string {
  const kind = value?.trim?.() ?? "";
  if (!RELATION_KIND.test(kind)) {
    throw new CommittedFactCommandError("COMMAND_INVALID", "relationKind is invalid.");
  }
  return kind;
}

function readEvidenceIds(value: readonly string[]): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) {
    throw new CommittedFactCommandError("COMMAND_INVALID", "evidenceEventIds are invalid.");
  }
  const ids = value.map((item) => required(item, "evidenceEventIds"));
  if (new Set(ids).size !== ids.length) {
    throw new CommittedFactCommandError("COMMAND_INVALID", "evidenceEventIds are invalid.");
  }
  return [...ids].sort((left, right) => left.localeCompare(right));
}

function boundedScore(value: number): number {
  if (!Number.isSafeInteger(value) || value < -1_000_000 || value > 1_000_000) {
    throw new CommittedFactCommandError("COMMAND_INVALID", "score is invalid.");
  }
  return value;
}

function nonzeroInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value === 0) {
    throw new CommittedFactCommandError("COMMAND_INVALID", `${field} is invalid.`);
  }
  return value;
}

function revision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CommittedFactCommandError("COMMAND_INVALID", "expectedRevision is invalid.");
  }
  return value;
}

function required(value: string, field: string): string {
  const normalized = value?.trim?.() ?? "";
  if (!normalized || normalized.length > 256) {
    throw new CommittedFactCommandError("COMMAND_INVALID", `${field} is invalid.`);
  }
  return normalized;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stable(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
