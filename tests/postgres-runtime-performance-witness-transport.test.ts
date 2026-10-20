/** AUTHORED / PG NOT_RUN. Source read boundary only; complete transport remains unimplemented. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { seedPostgresDemo, POSTGRES_DEMO_IDS } from "../database/postgres/demo-seed.ts";
import { withWorkspaceTransaction } from "../database/postgres/workspace-transaction.ts";
import { readPerformanceEvidenceSource } from "../database/postgres/performance-evidence-transport-repository.ts";
import type { ScopedFactReceiptRow } from "../database/postgres/committed-fact-command-repository.ts";
import { createPerformanceCommandTrust, executePerformanceAssessmentCommand } from "../modules/application/performance-command-executor.ts";

function scratchUrl(value: string | undefined): string {
  assert.ok(process.env.REALM_SCRATCH_POSTGRES_CONTAINER?.startsWith("realm"), "disposable runner required before pool allocation");
  assert.ok(value, "disposable URL required");
  const url = new URL(value);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(url.hostname.replace(/^\[|\]$/g, "")));
  assert.ok(url.pathname.length > 1);
  return value;
}

test("A4-T actual source SQL retains admitted historical provenance and refuses another Record without writes", async t => {
  const ownerUrl = scratchUrl(process.env.DATABASE_URL), runtimeUrl = scratchUrl(process.env.REALM_RUNTIME_DATABASE_URL);
  const ownerIdentity = new URL(ownerUrl), runtimeIdentity = new URL(runtimeUrl);
  assert.equal(runtimeIdentity.hostname, ownerIdentity.hostname);
  assert.equal(runtimeIdentity.port, ownerIdentity.port);
  assert.equal(runtimeIdentity.pathname, ownerIdentity.pathname);
  const suffix = randomUUID().replaceAll("-", ""), workspaceId = `a4t_${suffix}`, principalId = `a4t_actor_${suffix}`;
  const owner = new pg.Pool({ connectionString: ownerUrl, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
  t.after(async () => { await owner.end(); });
  const runtime = new pg.Pool({ connectionString: runtimeUrl, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
  t.after(async () => { await runtime.end(); });
  // No cleanup DELETE of append-only facts: the runner owns cluster destruction.
  const directory = new URL("../database/postgres/migrations/", import.meta.url);
  const files = (await readdir(directory)).filter(name => name.endsWith(".sql")).sort();
  const ledger = await owner.query<{ filename: string; checksum: string }>("SELECT filename, checksum FROM realm_schema_migrations ORDER BY filename");
  assert.deepEqual(ledger.rows.map(row => row.filename), files);
  for (const row of ledger.rows) assert.equal(createHash("sha256").update(await readFile(new URL(row.filename, directory))).digest("hex"), row.checksum);
  assert.equal((await runtime.query<{ role: string }>("SELECT current_user AS role")).rows[0]?.role, "realm_runtime");
  await seedPostgresDemo(owner, { workspaceId, principalId });
  const scope = { workspaceId, worldId: POSTGRES_DEMO_IDS.world, worldlineId: POSTGRES_DEMO_IDS.worldline };
  const intent = { recordId: POSTGRES_DEMO_IDS.record, policyVersion: "structured-factors:v1" as const,
    evidenceEventIds: [POSTGRES_DEMO_IDS.openingEvent], idempotencyKey: `a4t_key_${suffix}` };
  // Fixture admission only, following the inherited A4 specification. Production
  // durableTransport remains false, including after this source-only work.
  const admitted = await executePerformanceAssessmentCommand(runtime, {
    ...createPerformanceCommandTrust(scope, principalId), enablement: { schema: true, durableTransport: true },
  }, intent);
  const counts = () => owner.query(`SELECT
    (SELECT count(*)::text FROM committed_fact_commands WHERE workspace_id=$1) AS commands,
    (SELECT count(*)::text FROM performance_assessments WHERE workspace_id=$1) AS assessments,
    (SELECT count(*)::text FROM performance_evidence_snapshots WHERE workspace_id=$1) AS witnesses`, [workspaceId]);
  const before = (await counts()).rows;
  const stored = await withWorkspaceTransaction(runtime, workspaceId, async client => {
    const found = await client.query<ScopedFactReceiptRow>(`SELECT workspace_id,world_id,worldline_id,id,
      request_fingerprint,kind,result_manifest,false AS receipt_oversized
      FROM committed_fact_commands WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 AND id=$4`,
    [workspaceId, scope.worldId, scope.worldlineId, admitted.result.commandId]);
    assert.equal(found.rowCount, 1);
    const row = found.rows[0];
    const source = await readPerformanceEvidenceSource(client, scope, row);
    assert.ok(source);
    assert.equal(source.snapshot.admission.principalId, principalId);
    assert.equal(source.snapshot.factors.score, admitted.result.score);
    assert.deepEqual(source.receipt.request.evidenceEventIds, intent.evidenceEventIds);
    return row;
  }, { readOnly: true, isolationLevel: "repeatable read" });
  const altered = structuredClone(stored);
  const manifest = altered.result_manifest as { request: { recordId: string } };
  manifest.request.recordId = "a4t_missing_record";
  await assert.rejects(withWorkspaceTransaction(runtime, workspaceId,
    client => readPerformanceEvidenceSource(client, scope, altered), { readOnly: true }), { code: "PERFORMANCE_WITNESS_INVALID" });
  assert.deepEqual((await counts()).rows, before);
});
