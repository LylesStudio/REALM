import type { Pool } from "pg";
import { createPostgresCommittedFactCommandStore } from "../../database/postgres/committed-fact-command-repository.ts";
import { capturePerformanceEvidence, withPerformanceAdmissionTransaction, type PerformanceCommandTrust, type PerformanceAssessmentIntent } from "../../database/postgres/performance-evidence-admission.ts";
import type { WorkspaceDatabase } from "../../database/postgres/workspace-transaction.ts";
import { CommittedFactCommandError, committedFactRequestFingerprintFor, evidenceHash, normalizePerformanceAssessmentIntent, type PerformanceAssessmentResult } from "./committed-fact-command.ts";
import { compareReplay } from "./command-replay-lineage.ts";
import { runCommandWithStoryContinuation, type StoryContinuationOutcome } from "./story-graph-continuation.ts";

export type { PerformanceCommandTrust, PerformanceAssessmentIntent } from "../../database/postgres/performance-evidence-admission.ts";

const approvedEvidencePolicy = Object.freeze({
  mode: "engine-authoritative-v1" as const,
  policyId: "performance:engine-authoritative:v1",
});
const productionEnablement = Object.freeze({ schema: true, durableTransport: true });

/** Shared trusted assembly contract for existing reader/restorer/native callers.
 * The development override is a factory option; request data never selects it. */
export function performanceTransportConsumerOptions(): { performanceWitnessesSchemaVersion?: 1 } {
  return productionEnablement.durableTransport ? { performanceWitnessesSchemaVersion: 1 } : {};
}

/** Approved server assembly, never selected from request data or environment.
 * Schema=true declares this binary's schema contract, NOT that a target was upgraded:
 * capture still requires its exact zero-row SQL readiness probe.
 * Versioned witness transport is enabled by this trusted binary assembly only.
 * Historical receipt replay does not need either new capability or a factors reread.
 */
export function createPerformanceCommandTrust(scope: PerformanceCommandTrust["scope"], principalId: string): PerformanceCommandTrust {
  return { scope: { ...scope }, principalId, evidencePolicy: approvedEvidencePolicy, enablement: productionEnablement };
}

/** One scoped client carries admission, receipt serialization, capture, append and every Story write. */
export async function executePerformanceAssessmentCommand(database: WorkspaceDatabase, trusted: PerformanceCommandTrust, intent: PerformanceAssessmentIntent): Promise<{ result: PerformanceAssessmentResult; continuation: StoryContinuationOutcome }> {
  const normalized = normalizePerformanceAssessmentIntent({ scope: trusted.scope, ...intent });
  if (typeof trusted.principalId !== "string" || !trusted.principalId.trim() || trusted.principalId.length > 256) throw new CommittedFactCommandError("COMMAND_INVALID", "A trusted principal is required.");
  return withPerformanceAdmissionTransaction(database, { ...trusted, scope: normalized.scope }, normalized.intent, async client => {
    const executed = await runCommandWithStoryContinuation(client, normalized.scope, async sameClient => {
      const store = createPostgresCommittedFactCommandStore(sameClient);
      // This statement runs after the transaction key lock; no pre-lock score/factor read.
      const receipt = await store.loadCommand(normalized.scope, normalized.intent.idempotencyKey);
      if (receipt) {
        const savedScore = receipt.request?.score ?? (receipt.result as Partial<PerformanceAssessmentResult>).score;
        if (!Number.isSafeInteger(savedScore)) throw new CommittedFactCommandError("IDEMPOTENCY_KEY_REUSE", "The performance receipt cannot be replayed.");
        const request = { command: "performance.assessed", recordId: normalized.intent.recordId, policyVersion: normalized.intent.policyVersion, score: savedScore, evidenceEventIds: normalized.intent.evidenceEventIds };
        const { result, ...existing } = receipt;
        if (!compareReplay({ family: "fact", trustedScope: normalized.scope, candidate: request, expectedOperation: "performance.assessed", existing, factFingerprint: committedFactRequestFingerprintFor, suppliedTargetFingerprint: committedFactRequestFingerprintFor(normalized.scope, request) })) throw new CommittedFactCommandError("IDEMPOTENCY_KEY_REUSE", "This key belongs to another performance intent.");
        return { result: { ...result, status: "replayed" } as PerformanceAssessmentResult };
      }
      const snapshot = await capturePerformanceEvidence(sameClient);
      const request = { command: "performance.assessed", recordId: normalized.intent.recordId, policyVersion: normalized.intent.policyVersion, score: snapshot.factors.score, evidenceEventIds: normalized.intent.evidenceEventIds };
      const result = await store.recordPerformanceAssessment({ scope: normalized.scope, commandId: snapshot.commandId, idempotencyKey: normalized.intent.idempotencyKey, requestFingerprint: snapshot.requestFingerprint, recordId: normalized.intent.recordId, policyVersion: normalized.intent.policyVersion, score: snapshot.factors.score, evidenceEventIds: normalized.intent.evidenceEventIds, evidenceSnapshotHash: evidenceHash(normalized.intent.evidenceEventIds), request });
      return { result };
    });
    return { result: executed.command.result, continuation: executed.continuation };
  });
}

/** Caller-owned composition starts here, before any domain locks; arbitrary pre-existing clients are refused. */
export function runAdmittedPerformanceCommand<T>(database: Pool, trusted: PerformanceCommandTrust, intent: PerformanceAssessmentIntent, work: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const normalized = normalizePerformanceAssessmentIntent({ scope: trusted.scope, ...intent });
  return withPerformanceAdmissionTransaction(database, { ...trusted, scope: normalized.scope }, normalized.intent, work);
}
