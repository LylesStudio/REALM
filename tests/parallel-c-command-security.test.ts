import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createPostgresCommittedFactCommandStore } from "../database/postgres/committed-fact-command-repository.ts";
import { createPostgresProjectFinanceCommandStore } from "../database/postgres/project-finance-command-repository.ts";
import { createProjectFinanceCommandService, type ProjectFinanceCommandStore } from "../modules/application/project-finance-command.ts";
import { lockWorkspaceCommandKey } from "../database/postgres/workspace-transaction.ts";
import { committedFactRequestFingerprintFor, evidenceHash, createCommittedFactCommandService, type CommittedFactCommandStore } from "../modules/application/committed-fact-command.ts";
import { createReplayContext } from "../modules/application/command-replay-lineage.ts";
import * as contextModule from "../app/api/bridge/v1/project-finance-context.ts";

type PoolClient = Parameters<typeof lockWorkspaceCommandKey>[0];

const scope = { workspaceId: "c_workspace", worldId: "c_world", worldlineId: "c_line" };
const assessment = { scope, recordId: "c_record", policyVersion: "structured-factors:v1", evidenceEventIds: ["c_event"], idempotencyKey: "c_assessment" };

test("A5: accepted assessment replays its saved score before reading changed runtime facts", async () => {
  const request = { command: "performance.assessed", recordId: "c_record", policyVersion: "structured-factors:v1", score: 10, evidenceEventIds: ["c_event"] };
  const result = { status: "committed" as const, commandId: "c_command", assessmentId: "c_assessment", score: 10, evidenceSnapshotHash: evidenceHash(["c_event"]), goalTransition: null };
  let factReads = 0;
  const store = {
    loadCommand: async () => ({ requestFingerprint: committedFactRequestFingerprintFor(scope, request), request, kind: "performance_assessed", provenance: "request-result-v1", result }),
    loadPerformanceFacts: async () => { factReads++; throw new Error("current runtime is unavailable after the original commit"); },
    recordPerformanceAssessment: async () => { throw new Error("a replay must never write"); },
  } as unknown as CommittedFactCommandStore;
  const service = createCommittedFactCommandService({ store });
  assert.deepEqual(await service.recordPerformanceAssessment(assessment), { ...result, status: "replayed" });
  await assert.rejects(service.recordPerformanceAssessment({ ...assessment, evidenceEventIds: ["changed"] }), { code: "IDEMPOTENCY_KEY_REUSE" });
  await assert.rejects(service.recordPerformanceAssessment({ ...assessment, scope: { ...scope, worldlineId: "changed" } }), { code: "IDEMPOTENCY_KEY_REUSE" });
  assert.equal(factReads, 0);
});

function transcriptClient() {
  const statements: { sql: string; values: unknown[] }[] = [];
  const client = { release() {}, async query(sql: string, values: unknown[] = []) {
    statements.push({ sql, values });
    if (sql.includes("transaction_isolation")) return { rows: [{ isolation_level: "read committed" }], rowCount: 1 };
    if (sql.includes("current_setting('realm.workspace_id'")) return { rows: [{ workspace_id: scope.workspaceId }], rowCount: 1 };
    if (sql.trim() === "SELECT status FROM worlds WHERE workspace_id = $1 AND id = $2 FOR SHARE") { assert.deepEqual(values, [scope.workspaceId, scope.worldId]); return { rows: [{ status: "active" }], rowCount: 1 }; }
    if (sql.trim() === "SELECT status FROM worldlines WHERE workspace_id = $1 AND world_id = $2 AND id = $3 FOR UPDATE") { assert.deepEqual(values, [scope.workspaceId, scope.worldId, scope.worldlineId]); return { rows: [{ status: "active" }], rowCount: 1 }; }
    if (sql.includes("FROM events")) return { rows: [{ record_id: "c_record", world_tick: "1", world_ordinal: "2" }], rowCount: 1 };
    if (sql.includes("next_ordinal")) return { rows: [{ next_ordinal: "1" }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  } } as unknown as PoolClient;
  return { client, statements };
}

test("A6: fact writes acquire a scoped transaction key lock before receipt recheck", async () => {
  const { client, statements } = transcriptClient();
  const request = { command: "relationship.revised", subjectEntityKey: "a", objectEntityKey: "b", relationKind: "trust", sourceEventId: "c_event" };
  await createPostgresCommittedFactCommandStore(client).reviseRelationship({ scope, commandId: "c_relation", idempotencyKey: "c_key", requestFingerprint: committedFactRequestFingerprintFor(scope, request), request, ...request });
  const lock = statements.findIndex((row) => row.sql.includes("pg_advisory_xact_lock"));
  const read = statements.findIndex((row) => row.sql.includes("FROM committed_fact_commands AS command"));
  assert.ok(lock >= 0 && lock < read, "same-key lock must precede transaction receipt recheck");
  const identity = JSON.parse(statements[lock]!.values[0] as string);
  assert.deepEqual(identity, ["realm-command-key:v1", "fact", scope.workspaceId, scope.worldId, scope.worldlineId, "c_key"]);
});

test("A6: finance writes lock before recheck and before touching a missing project", async () => {
  const { client, statements } = transcriptClient();
  const store = createPostgresProjectFinanceCommandStore(client);
  await assert.rejects(store.changeStage({ scope, commandGroupId: "c_stage", idempotencyKey: "c_key", requestFingerprint: "a".repeat(64), request: { command: "project.stage.changed" }, projectId: "missing", stage: "production", expectedProjectVersion: 1, evidence: null }), { code: "PROJECT_NOT_FOUND" });
  const lock = statements.findIndex((row) => row.sql.includes("pg_advisory_xact_lock"));
  const read = statements.findIndex((row) => row.sql.includes("FROM project_finance_command_groups AS command"));
  assert.ok(lock >= 0 && lock < read);
});

test("A3: write authorization is rechecked with row locks using the server principal", async () => {
  const authorize = (contextModule as unknown as { authorizeProjectFinanceWrite: (client: PoolClient, context: unknown) => Promise<void> }).authorizeProjectFinanceWrite;
  assert.equal(typeof authorize, "function");
  const queries: { sql: string; values: unknown[] }[] = [];
  let role = "observer";
  let status = "active";
  const client = { async query(sql: string, values: unknown[]) { queries.push({ sql, values }); return { rows: [{ role, status: sql.includes("FROM worlds") ? "active" : status }], rowCount: 1 }; } } as unknown as PoolClient;
  const context = { scope, principalId: "server_principal" };
  await assert.rejects(authorize(client, context), { code: "FORBIDDEN" });
  role = "player"; status = "frozen";
  await assert.rejects(authorize(client, context), { code: "WORLDLINE_NOT_WRITABLE" });
  status = "active";
  await authorize(client, context);
  assert.match(queries[0]!.sql, /FROM worlds[\s\S]+FOR SHARE/);
  assert.ok(queries.some(({sql,values}) => sql.includes("bridge_command_membership_role") && JSON.stringify(values) === JSON.stringify([scope.workspaceId, scope.worldId, "server_principal"])));
  assert.ok(queries.some(({sql})=>/FROM worldlines[\s\S]+FOR UPDATE/.test(sql)));
});

test("A3: every HTTP command callback authorizes before constructing its store", () => {
  for (const family of ["facts", "finance", "projects"]) {
    const source = readFileSync(new URL(`../app/api/bridge/v1/${family}/commands/route.ts`, import.meta.url), "utf8");
    const callback = source.indexOf("async (client) => {");
    const authorize = source.indexOf("await authorizeProjectFinanceWrite(client, context)", callback);
    const store = source.indexOf("const service =", callback);
    assert.ok(callback >= 0 && authorize > callback && authorize < store, family);
  }
});

test("A5/A6: an accepted assessment receipt replays the original server score without split factors", async () => {
  const originalRequest = { command: "performance.assessed", recordId: "c_record", policyVersion: "structured-factors:v1", score: 10, evidenceEventIds: ["c_event"] };
  const request = { ...originalRequest, score: 30 };
  const result = { status: "committed" as const, commandId: "c_original", assessmentId: "c_original:assessment", score: 10, evidenceSnapshotHash: evidenceHash(["c_event"]), goalTransition: null };
  const { client, statements } = transcriptClient();
  const query = client.query.bind(client);
  client.query = (async (sql: string, values: unknown[] = []) => {
    if (sql.includes("FROM committed_fact_commands AS command")) {
      return { rowCount: 1, rows: [{ workspace_id: scope.workspaceId, world_id: scope.worldId, worldline_id: scope.worldlineId, id: result.commandId, kind: "performance_assessed", request_fingerprint: committedFactRequestFingerprintFor(scope, originalRequest), result_manifest: { request: originalRequest, result }, receipt_oversized: false, anchor_row: null }] };
    }
    return query(sql, values);
  }) as PoolClient["query"];
  const input = { scope, commandId: "c_new", idempotencyKey: "c_key", request, requestFingerprint: committedFactRequestFingerprintFor(scope, request), recordId: "c_record", policyVersion: "structured-factors:v1", score: 30, evidenceEventIds: ["c_event"], evidenceSnapshotHash: "b".repeat(64) };
  const store = createPostgresCommittedFactCommandStore(client);
  store.loadPerformanceFacts = async () => ({ evidenceCount: 3, milestoneCompleted: false });
  assert.deepEqual(await createCommittedFactCommandService({ store }).recordPerformanceAssessment({ ...assessment, idempotencyKey: "c_key" }), { ...result, status: "replayed" });
  for (const patch of [{recordId: "changed"}, {evidenceEventIds: ["changed"]}, {policyVersion: "changed"}, {scope: {...scope, worldlineId: "changed"}}]) {
    await assert.rejects(createCommittedFactCommandService({ store }).recordPerformanceAssessment({ ...assessment, idempotencyKey: "c_key", ...patch }), { code: "policyVersion" in patch ? "COMMAND_INVALID" : "IDEMPOTENCY_KEY_REUSE" });
  }
  await assert.rejects(createPostgresCommittedFactCommandStore(client).recordPerformanceAssessment({ ...input, request: { ...request, recordId: "changed" }, requestFingerprint: committedFactRequestFingerprintFor(scope, { ...request, recordId: "changed" }) }), { code: "IDEMPOTENCY_KEY_REUSE" });
  assert.equal(statements.some(row => row.sql.includes("INSERT INTO")), false);
});

test("A6: pre-existing snapshot transactions fail closed before a command-key lock", async () => {
  const { client, statements } = transcriptClient();
  client.query = (async (sql: string) => { statements.push({ sql, values: [] }); return { rows: [{ isolation_level: "repeatable read" }], rowCount: 1 }; }) as PoolClient["query"];
  await assert.rejects(lockWorkspaceCommandKey(client, "fact", scope, "c_key"), /READ COMMITTED/);
  assert.equal(statements.some(row => row.sql.includes("pg_advisory_xact_lock")), false);
});

test("F6 control: the existing combined-command capacity accepts eight actions and rejects nine", async () => {
  let accepted = 0;
  const store = { loadCommand: async () => null, applyRecordProjectFinance: async (input: { actions: unknown[] }) => { accepted = input.actions.length; return { status: "committed" }; } } as unknown as ProjectFinanceCommandStore;
  const service = createProjectFinanceCommandService({ store });
  const action = { command: "change_stage" as const, projectId: "c_project", stage: "production" as const, expectedProjectVersion: 1 };
  await service.applyRecordProjectFinance({ scope, idempotencyKey: "c_eight", actions: Array.from({ length: 8 }, () => action) });
  assert.equal(accepted, 8);
  await assert.rejects(service.applyRecordProjectFinance({ scope, idempotencyKey: "c_nine", actions: Array.from({ length: 9 }, () => action) }), { code: "COMMAND_INVALID" });
});

for (const format of ["modern", "bare", "tagged", "typed"] as const) test(`Iris C direct-store score intent remains strict for ${format} receipt`, async () => {
  const original = { command: "performance.assessed", recordId: "c_record", policyVersion: "structured-factors:v1", score: 10, evidenceEventIds: ["c_event"] };
  const result = { status: "committed" as const, commandId: "c_original", assessmentId: "c_original:assessment", score: 10, evidenceSnapshotHash: evidenceHash(["c_event"]), goalTransition: null };
  const originScope = { workspaceId: "origin_ws", worldId: "origin_world", worldlineId: "origin_line" };
  const originRequest = { ...original, recordId: "origin_record", evidenceEventIds: ["origin_event"] };
  const lineageContext = createReplayContext({ format: "realm-command-lineage-context", version: 1, family: "fact", originScope, currentScope: scope, identities: { record: [["c_record", "origin_record"]], event: [["c_event", "origin_event"]], scene: [], characterInstance: [], assetDefinition: [], project: [], financeAccount: [], milestone: [], obligation: [] } });
  const originFingerprint = committedFactRequestFingerprintFor(originScope, originRequest);
  const manifest = format === "modern" ? {request: original, result} : format === "bare" ? result : format === "tagged" ? {provenance: "legacy-result-v1", result} : {provenance: "legacy-result-v1", request: null, result, replayLineage: {version: 1, contextId: lineageContext.id, originalRequestFingerprint: originFingerprint, anchorCommandId: result.commandId}, replayContext: lineageContext};
  const { client, statements } = transcriptClient();
  const query = client.query.bind(client);
  client.query = (async (sql: string, values: unknown[] = []) => {
    if (sql.includes("FROM committed_fact_commands AS command")) return { rowCount: 1, rows: [{ workspace_id: scope.workspaceId, world_id: scope.worldId, worldline_id: scope.worldlineId, id: result.commandId, kind: "performance_assessed", request_fingerprint: format === "typed" ? originFingerprint : committedFactRequestFingerprintFor(scope, original), result_manifest: manifest, receipt_oversized: false, anchor_row: null }] };
    return query(sql, values);
  }) as PoolClient["query"];
  const store = createPostgresCommittedFactCommandStore(client);
  const input = { scope, commandId: result.commandId, idempotencyKey: "c_key", request: original, requestFingerprint: committedFactRequestFingerprintFor(scope, original), recordId: "c_record", policyVersion: original.policyVersion, score: 10, evidenceEventIds: ["c_event"], evidenceSnapshotHash: result.evidenceSnapshotHash };
  assert.deepEqual(await store.recordPerformanceAssessment(input), { ...result, status: "replayed" });
  const changed = { ...original, score: 11 };
  await assert.rejects(store.recordPerformanceAssessment({ ...input, score: 11, request: changed, requestFingerprint: committedFactRequestFingerprintFor(scope, changed) }), { code: "IDEMPOTENCY_KEY_REUSE" });
  await assert.rejects(store.recordPerformanceAssessment({ ...input, score: 11, request: changed }), { code: "IDEMPOTENCY_KEY_REUSE" });
  for (const patch of [{recordId: "changed"}, {policyVersion: "changed"}, {evidenceEventIds: ["changed"]}]) {
    const request = {...original, ...patch};
    await assert.rejects(store.recordPerformanceAssessment({...input, request, requestFingerprint: committedFactRequestFingerprintFor(scope, request)}), {code:"IDEMPOTENCY_KEY_REUSE"});
  }
  await assert.rejects(store.recordPerformanceAssessment({...input, requestFingerprint:"0".repeat(64)}), {code:"IDEMPOTENCY_KEY_REUSE"});
  assert.equal(statements.some(row => row.sql.includes("INSERT INTO")), false);
});
