import { committedFactRequestFingerprintFor, evidenceHash } from "./committed-fact-command.ts";
import {
  decodePerformanceEvidenceSnapshot, performanceEvidenceSnapshotCanonical,
  performanceEvidenceSnapshotHash, type PerformanceEvidenceSnapshotV1,
} from "./performance-evidence-snapshot.ts";

export class PerformanceEvidenceReceiptError extends Error {
  readonly code = "PERFORMANCE_WITNESS_INVALID";
  constructor() { super("Performance evidence receipt is invalid."); this.name = "PerformanceEvidenceReceiptError"; }
}
function invalid(): never { throw new PerformanceEvidenceReceiptError(); }
function same(a: unknown, b: unknown): void { if (a !== b) invalid(); }
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
  const own = Reflect.ownKeys(value), descriptors = Object.getOwnPropertyDescriptors(value);
  if (own.length !== keys.length || own.some(k => typeof k !== "string" || !keys.includes(k)
    || !descriptors[k as string]?.enumerable || !Object.hasOwn(descriptors[k as string], "value"))) invalid();
  return value as Record<string, unknown>;
}
function sameIds(value: unknown, expected: readonly string[]): void {
  if (!Array.isArray(value) || value.length !== expected.length || Reflect.ownKeys(value).length !== value.length + 1) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (let i = 0; i < expected.length; i++) {
    const descriptor = descriptors[String(i)];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) invalid();
    same(descriptor.value, expected[i]);
  }
}

/**
 * Validate the actual source request/result/assessment/sidecar as one fact,
 * BEFORE any target identity/digest substitution. Returns detached historical
 * data only: not a signature, source authorization, target admission, or viewer
 * projection. Legacy receipts must use their existing separate proof path.
 */
export function validatePerformanceEvidenceReceipt(value: unknown): PerformanceEvidenceSnapshotV1 {
  try {
    const row = exact(value, ["scope", "commandId", "requestFingerprint", "request", "result", "marker", "witness", "assessment"]);
    const scope = exact(row.scope, ["workspaceId", "worldId", "worldlineId"]);
    const request = exact(row.request, ["command", "recordId", "policyVersion", "score", "evidenceEventIds"]);
    const result = exact(row.result, ["status", "commandId", "assessmentId", "score", "evidenceSnapshotHash", "goalTransition"]);
    const marker = exact(row.marker, ["version", "manifestHash"]);
    const witness = exact(row.witness, ["recordId", "assessmentId", "commandId", "version", "manifestCanonical", "manifestHash"]);
    const assessment = exact(row.assessment, ["id", "recordId", "commandId", "policyVersion", "score", "evidenceEventIds", "evidenceSnapshotHash"]);
    same(marker.version, 1); same(witness.version, 1);
    if (typeof witness.manifestCanonical !== "string") invalid();
    const snapshot = decodePerformanceEvidenceSnapshot(witness.manifestCanonical);
    same(performanceEvidenceSnapshotCanonical(snapshot), witness.manifestCanonical);
    same(performanceEvidenceSnapshotHash(snapshot), witness.manifestHash);
    same(marker.manifestHash, witness.manifestHash);
    for (const key of ["workspaceId", "worldId", "worldlineId"] as const) same(scope[key], snapshot.scope[key]);
    same(row.commandId, snapshot.commandId);
    same(witness.commandId, snapshot.commandId); same(assessment.commandId, snapshot.commandId); same(result.commandId, snapshot.commandId);
    same(witness.assessmentId, snapshot.assessmentId); same(assessment.id, snapshot.assessmentId); same(result.assessmentId, snapshot.assessmentId);
    same(request.command, "performance.assessed");
    same(request.recordId, snapshot.scope.recordId); same(witness.recordId, snapshot.scope.recordId); same(assessment.recordId, snapshot.scope.recordId);
    same(request.policyVersion, snapshot.policyVersion); same(assessment.policyVersion, snapshot.policyVersion);
    same(request.score, snapshot.factors.score); same(result.score, snapshot.factors.score); same(assessment.score, snapshot.factors.score);
    if (result.status !== "committed" && result.status !== "replayed") invalid();
    same(result.goalTransition, null);
    const ids = snapshot.evidence.map(event => event.id);
    sameIds(request.evidenceEventIds, ids); sameIds(assessment.evidenceEventIds, ids);
    same(result.evidenceSnapshotHash, evidenceHash(ids)); same(assessment.evidenceSnapshotHash, result.evidenceSnapshotHash);
    same(row.requestFingerprint, snapshot.requestFingerprint);
    same(committedFactRequestFingerprintFor(snapshot.scope, request), row.requestFingerprint);
    return snapshot;
  } catch {
    return invalid();
  }
}
