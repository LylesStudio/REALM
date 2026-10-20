import assert from "node:assert/strict";
import test from "node:test";

import { createCommittedFactCommandService, committedFactCommandIdFor, committedFactRequestFingerprintFor, evidenceHash, type CommittedFactCommandStore } from "../modules/application/committed-fact-command.ts";
import { createProjectFinanceCommandService, type ProjectFinanceCommandStore } from "../modules/application/project-finance-command.ts";

const scope = { workspaceId: "ws", worldId: "world", worldlineId: "line" };
const evidence = { recordId: "record", sceneId: "scene", visibility: "public", expectedWorldCursor: { worldTick: 0, worldOrdinal: 1 } };
const ledger = { accountId: "account", amountMinor: 100, category: "props", memo: "supplies", occurredAt: "2026-10-16T00:00:00.000Z", expectedBalanceMinor: 1000, evidence };
type Candidate = Record<string, unknown>;
type Case = { family: "fact" | "finance"; method: string; command: Candidate; changes: Candidate[] };
const cases: Case[] = [
  { family: "fact", method: "grantInventory", command: { recordId: "record", characterInstanceId: "actor", assetDefinitionId: "asset", quantity: 3, sourceEventId: "event" }, changes: [{ characterInstanceId: "other" }, { recordId: "other" }, { assetDefinitionId: "other" }, { quantity: 4 }, { sourceEventId: "other" }] },
  { family: "fact", method: "adjustInventory", command: { recordId: "record", characterInstanceId: "actor", assetDefinitionId: "asset", delta: -1, sourceEventId: "event", expectedRevision: 0 }, changes: [{ delta: -2 }, { expectedRevision: 1 }] },
  { family: "fact", method: "reviseRelationship", command: { subjectEntityKey: "subject", objectEntityKey: "object", relationKind: "trust", sourceEventId: "event" }, changes: [{ subjectEntityKey: "other" }, { objectEntityKey: "other" }, { relationKind: "respect" }, { sourceEventId: "other" }] },
  { family: "fact", method: "recordPerformanceAssessment", command: { recordId: "record", policyVersion: "structured-factors:v1", evidenceEventIds: ["event"] }, changes: [{ recordId: "other" }, { evidenceEventIds: ["other"] }] },
  ...["recordExpense", "recordIncome", "recordAdjustment"].map((method): Case => ({ family: "finance", method, command: { ...ledger, ...(method === "recordAdjustment" ? { direction: "income" } : {}) }, changes: [{ amountMinor: 101 }, { expectedBalanceMinor: 999 }, { accountId: "other" }, { evidence: { ...evidence, recordId: "other" } }, ...(method === "recordAdjustment" ? [{ direction: "expense" }] : [])] })),
  { family: "finance", method: "confirmMilestone", command: { projectId: "project", milestoneId: "milestone", expectedProjectVersion: 1, evidence, semanticEventKey: "show.completed" }, changes: [{ milestoneId: "other" }, { expectedProjectVersion: 2 }, { semanticEventKey: "other.completed" }, { evidence: { ...evidence, sceneId: "other" } }, { evidence: { ...evidence, expectedWorldCursor: { worldTick: 0, worldOrdinal: 2 } } }] },
  { family: "finance", method: "changeStage", command: { projectId: "project", stage: "production", expectedProjectVersion: 1, evidence }, changes: [{ projectId: "other" }, { stage: "delivery" }, { expectedProjectVersion: 2 }, { evidence: null }] },
  { family: "finance", method: "allocateBudget", command: { projectId: "project", category: "props", amountMinor: 100, expectedVersion: 0 }, changes: [{ amountMinor: 101 }, { expectedVersion: 1 }, { category: "other" }] },
  ...["loan", "presale", "revenue_share"].map((kind): Case => ({ family: "finance", method: "createObligation", command: { projectId: "project", kind, principalMinor: 100, ...(kind === "presale" ? { undeliveredCount: 2 } : {}), ...(kind === "revenue_share" ? { shareBps: 1000 } : {}) }, changes: [{ principalMinor: 101 }, { projectId: "other" }, ...(kind === "revenue_share" ? [{ shareBps: 2000 }] : kind === "presale" ? [{ undeliveredCount: 3 }] : [{ kind: "presale" }])] })),
  { family: "finance", method: "settleObligation", command: { obligationId: "obligation", amountMinor: 10, expectedOutstandingMinor: 100, expectedBalanceMinor: 1000, accountId: "account", category: "props", memo: "repayment", occurredAt: ledger.occurredAt, settlementKind: "repayment" }, changes: [{ amountMinor: 11 }, { expectedOutstandingMinor: 99 }, { expectedBalanceMinor: 999 }, { accountId: "other" }, { obligationId: "other" }, { settlementKind: "draw" }] },
  { family: "finance", method: "applyRecordProjectFinance", command: { evidence, actions: [{ command: "change_stage", projectId: "project", stage: "production", expectedProjectVersion: 1 }] }, changes: [{ actions: [{ command: "change_stage", projectId: "project", stage: "delivery", expectedProjectVersion: 1 }] }, { evidence: { ...evidence, visibility: "restricted" } }] },
];

for (const [index, entry] of cases.entries()) {
  test(`native bare-result ${entry.method}/${index} requires the full fingerprint`, async () => {
    let saved: { requestFingerprint: string; request: Candidate | null; result: Candidate } | null = null;
    let writes = 0;
    const store = new Proxy({}, {
      get(_target, method) {
        if (method === "loadCommand") return async () => saved;
        if (method === "loadPerformanceFacts") return async () => ({ evidenceCount: 1, milestoneCompleted: false });
        if (method === "loadAccount" || method === "loadDefaultAccount") return async () => ({ ...scope, id: "account", currency: "JPY", status: "active", openingBalanceMinor: 1000 });
        if (method === "loadLedger") return async () => [];
        return async (input: { requestFingerprint: string; request: Candidate }) => {
          writes++;
          const result = { status: "committed", commandId: "fact", commandGroupId: "finance", quantity: 3, relationKind: "trust", score: 10 };
          saved = { requestFingerprint: input.requestFingerprint, request: input.request, result };
          return result;
        };
      },
    });
    const service = (entry.family === "fact"
      ? createCommittedFactCommandService({ store: store as CommittedFactCommandStore, atomicPerformanceExecutor: async (scope, intent) => {
        // Explicit memory atomic adapter. Existing receipts use the real replay service without this seam.
        if (saved) return createCommittedFactCommandService({ store: store as CommittedFactCommandStore }).recordPerformanceAssessment({ scope, ...intent });
        const request = { command: "performance.assessed", recordId: intent.recordId, policyVersion: intent.policyVersion, score: 10, evidenceEventIds: intent.evidenceEventIds };
        const requestFingerprint = committedFactRequestFingerprintFor(scope, request);
        return (store as CommittedFactCommandStore).recordPerformanceAssessment({ scope, ...intent, commandId: committedFactCommandIdFor(scope, intent.idempotencyKey, requestFingerprint), requestFingerprint, score: 10, evidenceSnapshotHash: evidenceHash(intent.evidenceEventIds), request });
      } })
      : createProjectFinanceCommandService({ store: store as ProjectFinanceCommandStore })) as unknown as Record<string, (command: Candidate) => Promise<Candidate>>;
    const original = { scope, idempotencyKey: "occupied", ...entry.command };
    const first = await service[entry.method]!(original);
    assert.ok(saved);
    (saved as { request: Candidate | null }).request = null;
    for (const change of entry.changes) {
      await assert.rejects(service[entry.method]!({ ...original, ...change }), { code: "IDEMPOTENCY_KEY_REUSE" });
    }
    await assert.rejects(service[entry.method]!({ ...original, scope: { ...scope, worldlineId: "other" } }), { code: "IDEMPOTENCY_KEY_REUSE" });
    // Null request cannot conceal a different command kind, even with a
    // result shape shared by grant and adjustment or by the ledger commands.
    if (entry.method === "grantInventory") {
      await assert.rejects(service.adjustInventory!({ ...original, quantity: undefined, delta: -1, expectedRevision: 0 }), { code: "IDEMPOTENCY_KEY_REUSE" });
    }
    if (entry.method === "recordExpense") {
      await assert.rejects(service.recordIncome!(original), { code: "IDEMPOTENCY_KEY_REUSE" });
    }
    assert.deepEqual(await service[entry.method]!(original), { ...first, status: "replayed" });
    assert.equal(writes, 1, "exact replay and all rejections leave the receipt and authoritative state untouched");
    (saved as { requestFingerprint: string }).requestFingerprint = "0".repeat(64);
    await assert.rejects(service[entry.method]!(original), { code: "IDEMPOTENCY_KEY_REUSE" });
    assert.equal(writes, 1, "an unprovable scope fingerprint fails closed");
  });
}
