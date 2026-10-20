/** A4-P/S real PostgreSQL specification. AUTHORED, NOT RUN during development.
 * Only the disposable runner may execute this file. No provider/HTTP or shared DB.
 * Local fixture enablement is NOT a claim that A4-T archive transport is complete.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import pg, { type Pool, type PoolClient } from "pg";
import { POSTGRES_DEMO_IDS, seedPostgresDemo } from "../database/postgres/demo-seed.ts";
import { withWorkspaceTransaction, type WorkspaceDatabase } from "../database/postgres/workspace-transaction.ts";
import { createPostgresProjectFinanceCommandStore } from "../database/postgres/project-finance-command-repository.ts";
import { createProjectFinanceCommandService, type MilestoneCommandResult } from "../modules/application/project-finance-command.ts";
import { createPostgresCommittedFactCommandStore } from "../database/postgres/committed-fact-command-repository.ts";
import { PerformanceAdmissionError } from "../database/postgres/performance-evidence-admission.ts";
import { createPerformanceCommandTrust, executePerformanceAssessmentCommand, runAdmittedPerformanceCommand } from "../modules/application/performance-command-executor.ts";
import { committedFactRequestFingerprintFor, evidenceHash } from "../modules/application/committed-fact-command.ts";
import { decodePerformanceEvidenceSnapshot, performanceEvidenceSnapshotHash } from "../modules/application/performance-evidence-snapshot.ts";

function scratchUrl(value: string | undefined): string {
  assert.ok(process.env.REALM_SCRATCH_POSTGRES_CONTAINER?.startsWith("realm"), "authorized disposable runner required BEFORE any pool allocation");
  assert.ok(value, "disposable PostgreSQL URL required");
  const url = new URL(value);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(url.hostname.replace(/^\[|\]$/g, "")));
  assert.ok(url.pathname.length > 1);
  return value;
}

async function fixture(t: test.TestContext) {
  const ownerUrl = scratchUrl(process.env.DATABASE_URL);
  const runtimeUrl = scratchUrl(process.env.REALM_RUNTIME_DATABASE_URL);
  const ownerIdentity = new URL(ownerUrl), runtimeIdentity = new URL(runtimeUrl);
  assert.equal(runtimeIdentity.hostname, ownerIdentity.hostname);
  assert.equal(runtimeIdentity.port, ownerIdentity.port);
  assert.equal(runtimeIdentity.pathname, ownerIdentity.pathname);
  const suffix = randomUUID().replaceAll("-", "");
  const workspaceId = `a4_pg_${suffix}`, principalId = `a4_actor_${suffix}`;
  const errors: string[] = [], closes = new Map<Pool, Promise<void>[]>();
  const allocate = (connectionString: string, applicationName: string) => {
    const pool = new pg.Pool({ connectionString, application_name: applicationName, max: 4, allowExitOnIdle: false, connectionTimeoutMillis: 5000, statement_timeout: 10000, idle_in_transaction_session_timeout: 15000 });
    const ends: Promise<void>[] = []; closes.set(pool, ends);
    pool.on("connect", client => { ends.push(new Promise(resolve => client.once("end", resolve))); });
    pool.on("error", (error: Error & { code?: string }) => { errors.push(error.code ?? "UNEXPECTED_POOL_ERROR"); });
    return pool;
  };
  const close = async (pool: Pool) => { await pool.end(); await Promise.all(closes.get(pool) ?? []); };
  const owner = allocate(ownerUrl, `a4_owner_${suffix}`);
  const runtimeName = `a4_runtime_${suffix}`;
  const ownership: { runtime?: Pool } = {};
  t.after(async () => {
    try {
      if (ownership.runtime) {
        await close(ownership.runtime);
        const remaining = await owner.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1", [runtimeName]);
        assert.deepEqual(remaining.rows, [], "runtime client end events precede independent backend-zero observation");
      }
    } finally {
      await close(owner);
      assert.deepEqual(errors, [], "unexpected client/pool errors must remain visible");
    }
  });
  const runtime = allocate(runtimeUrl, runtimeName);
  ownership.runtime = runtime;
  // Finalizers above own both pools even if full-chain verification or seeding fails.
  // Immutable rows are never deleted; the disposable runner destroys its own cluster.
  const directory = new URL("../database/postgres/migrations/", import.meta.url);
  const files = (await readdir(directory)).filter(name => name.endsWith(".sql")).sort();
  assert.ok(files.includes("0082_performance_evidence_snapshots.sql"));
  const ledger = await owner.query<{ filename: string; checksum: string }>("SELECT filename, checksum FROM realm_schema_migrations ORDER BY filename");
  assert.deepEqual(ledger.rows.map(row => row.filename), files, "the complete actual source chain, not a partial fixture schema");
  for (const row of ledger.rows) assert.equal(createHash("sha256").update(await readFile(new URL(row.filename, directory))).digest("hex"), row.checksum);
  const role = await runtime.query<{ role: string }>("SELECT current_user AS role");
  assert.equal(role.rows[0]?.role, "realm_runtime");
  await seedPostgresDemo(owner, { workspaceId, principalId });
  const scope = { workspaceId, worldId: POSTGRES_DEMO_IDS.world, worldlineId: POSTGRES_DEMO_IDS.worldline };
  const intent = { recordId: POSTGRES_DEMO_IDS.record, policyVersion: "structured-factors:v1" as const, evidenceEventIds: [POSTGRES_DEMO_IDS.openingEvent], idempotencyKey: `a4_assess_${suffix}` };
  const trust = { ...createPerformanceCommandTrust(scope, principalId), enablement: { schema: true, durableTransport: true } };
  const counts = async () => (await owner.query<{ commands: string; assessments: string; witnesses: string }>(
    `SELECT (SELECT count(*)::text FROM committed_fact_commands WHERE workspace_id=$1) AS commands,
      (SELECT count(*)::text FROM performance_assessments WHERE workspace_id=$1) AS assessments,
      (SELECT count(*)::text FROM performance_evidence_snapshots WHERE workspace_id=$1) AS witnesses`, [workspaceId])).rows[0];
  return { owner, runtime, runtimeName, scope, intent, trust, counts };
}

/** Match each intentional refusal to its exact SQL bytes and SQLSTATE, not a global allowlist. */
async function refuses(pool: Pool, workspaceId: string, sql: string, params: unknown[], code: string, message?: string) {
  const fingerprint = createHash("sha256").update(sql).digest("hex");
  await assert.rejects(withWorkspaceTransaction(pool, workspaceId, client => client.query(sql, params)), (error: unknown) => {
    assert.equal((error as { code?: string }).code, code, `negative SQL ${fingerprint}`);
    if (message !== undefined) assert.equal((error as Error).message, message);
    console.log("A4_EXPECTED_SQL_REFUSAL", JSON.stringify({ fingerprint, sqlstate: code, expectedMessage: message }));
    return true;
  });
}

async function milestone(f: Awaited<ReturnType<typeof fixture>>) {
  const projectId = `a4_project_${randomUUID()}`, milestoneId = `a4_milestone_${randomUUID()}`;
  await withWorkspaceTransaction(f.owner, f.scope.workspaceId, async client => {
    await client.query(`INSERT INTO projects (workspace_id,world_id,worldline_id,id,kind,status,stage,title)
      VALUES ($1,$2,$3,$4,'production','active','delivery','A4 persisted factor')`, [f.scope.workspaceId, f.scope.worldId, f.scope.worldlineId, projectId]);
    await client.query(`INSERT INTO project_milestones (workspace_id,world_id,worldline_id,id,project_id,sequence,title,status,completion_record_id,completion_event_id)
      VALUES ($1,$2,$3,$4,$5,1,'A4 persisted completion','completed',$6,$7)`, [f.scope.workspaceId, f.scope.worldId, f.scope.worldlineId, milestoneId, projectId, f.intent.recordId, f.intent.evidenceEventIds[0]]);
  });
}

test("A4 real executor commits receipt/assessment/witness together; replay keeps accepted score after factors change", async t => {
  const f = await fixture(t);
  const first = await executePerformanceAssessmentCommand(f.runtime, f.trust, f.intent);
  assert.equal(first.result.score, 10);
  assert.equal(first.result.goalTransition, null);
  assert.deepEqual(await f.counts(), { commands: "1", assessments: "1", witnesses: "1" });
  const read = await withWorkspaceTransaction(f.runtime, f.scope.workspaceId, client => client.query<{
    manifest_canonical: string; manifest_hash: string; result_manifest: { request: Record<string, unknown>; performanceWitness: { manifestHash: string } };
  }>(`SELECT s.manifest_canonical,s.manifest_hash,c.result_manifest FROM performance_evidence_snapshots s
    JOIN committed_fact_commands c ON (c.workspace_id,c.world_id,c.worldline_id,c.id)=(s.workspace_id,s.world_id,s.worldline_id,s.command_id)
    WHERE s.workspace_id=$1 AND s.assessment_id=$2`, [f.scope.workspaceId, first.result.assessmentId]));
  assert.equal(read.rowCount, 1);
  const row = read.rows[0], witness = decodePerformanceEvidenceSnapshot(row.manifest_canonical);
  assert.equal(performanceEvidenceSnapshotHash(witness), row.manifest_hash);
  assert.equal(row.result_manifest.performanceWitness.manifestHash, row.manifest_hash);
  assert.equal(witness.factors.milestoneCompleted, false);
  assert.equal(witness.admission.evidenceMode, "engine-authoritative-v1");
  assert.equal(witness.admission.principalId, f.trust.principalId);
  await milestone(f);
  const replay = await executePerformanceAssessmentCommand(f.runtime, { ...f.trust, evidencePolicy: null, enablement: undefined }, f.intent);
  assert.equal(replay.result.score, 10);
  assert.equal(replay.result.status, "replayed");
  const fresh = await executePerformanceAssessmentCommand(f.runtime, f.trust, { ...f.intent, idempotencyKey: `${f.intent.idempotencyKey}:new` });
  assert.equal(fresh.result.score, 30);
  const candidate = { ...row.result_manifest.request, score: 30 };
  await assert.rejects(createPostgresCommittedFactCommandStore(f.runtime).recordPerformanceAssessment({
    scope: f.scope, commandId: witness.commandId, idempotencyKey: f.intent.idempotencyKey,
    recordId: f.intent.recordId, policyVersion: f.intent.policyVersion, score: 30,
    evidenceEventIds: f.intent.evidenceEventIds, evidenceSnapshotHash: evidenceHash(f.intent.evidenceEventIds),
    request: candidate, requestFingerprint: committedFactRequestFingerprintFor(f.scope, candidate),
  }), { code: "IDEMPOTENCY_KEY_REUSE" });
  assert.deepEqual(await f.counts(), { commands: "2", assessments: "2", witnesses: "2" });
});

test("A4 actual catalog, workspace RLS and append-only refusal retain the original witness", async t => {
  const f = await fixture(t);
  await executePerformanceAssessmentCommand(f.runtime, f.trust, f.intent);
  const catalog = (await f.owner.query<{ rls: boolean; force: boolean; can_select: boolean; can_insert: boolean; can_update: boolean; can_delete: boolean; can_truncate: boolean }>(
    `SELECT c.relrowsecurity AS rls,c.relforcerowsecurity AS force,
      has_table_privilege('realm_runtime',c.oid,'SELECT') AS can_select,
      has_table_privilege('realm_runtime',c.oid,'INSERT') AS can_insert,
      has_table_privilege('realm_runtime',c.oid,'UPDATE') AS can_update,
      has_table_privilege('realm_runtime',c.oid,'DELETE') AS can_delete,
      has_table_privilege('realm_runtime',c.oid,'TRUNCATE') AS can_truncate
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname='performance_evidence_snapshots'`)).rows;
  assert.deepEqual(catalog, [{ rls: true, force: true, can_select: true, can_insert: true, can_update: false, can_delete: false, can_truncate: false }]);
  const otherRoles = (await f.owner.query<{ role: string; can_select: boolean; can_insert: boolean; can_update: boolean; can_delete: boolean; can_truncate: boolean; can_reference: boolean; can_trigger: boolean }>(
    `SELECT r.role,has_table_privilege(r.role,c.oid,'SELECT') AS can_select,
       has_table_privilege(r.role,c.oid,'INSERT') AS can_insert,
       has_table_privilege(r.role,c.oid,'UPDATE') AS can_update,
       has_table_privilege(r.role,c.oid,'DELETE') AS can_delete,
       has_table_privilege(r.role,c.oid,'TRUNCATE') AS can_truncate,
       has_table_privilege(r.role,c.oid,'REFERENCES') AS can_reference,
       has_table_privilege(r.role,c.oid,'TRIGGER') AS can_trigger
     FROM (VALUES ('realm_control'::text),('realm_transfer'::text)) AS r(role)
     CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relname='performance_evidence_snapshots' ORDER BY r.role`)).rows;
  assert.deepEqual(otherRoles, ["realm_control", "realm_transfer"].map(role => ({ role,
    can_select: false, can_insert: false, can_update: false, can_delete: false, can_truncate: false, can_reference: false, can_trigger: false })));
  const narrowRuntime = (await f.owner.query<{ can_reference: boolean; can_trigger: boolean; public_grants: string }>(
    `SELECT has_table_privilege('realm_runtime',c.oid,'REFERENCES') AS can_reference,
       has_table_privilege('realm_runtime',c.oid,'TRIGGER') AS can_trigger,
       (SELECT count(*)::text FROM aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee=0) AS public_grants
     FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relname='performance_evidence_snapshots'`)).rows;
  assert.deepEqual(narrowRuntime, [{ can_reference: false, can_trigger: false, public_grants: "0" }]);
  const foreign = await withWorkspaceTransaction(f.runtime, `a4_foreign_${randomUUID()}`, client => client.query("SELECT assessment_id FROM performance_evidence_snapshots WHERE workspace_id=$1", [f.scope.workspaceId]));
  assert.equal(foreign.rowCount, 0);
  await refuses(f.runtime, f.scope.workspaceId, "UPDATE performance_evidence_snapshots SET manifest_canonical=manifest_canonical WHERE workspace_id=$1", [f.scope.workspaceId], "42501");
  await refuses(f.owner, f.scope.workspaceId, "UPDATE performance_evidence_snapshots SET manifest_canonical=manifest_canonical WHERE workspace_id=$1", [f.scope.workspaceId], "P0001");
  await refuses(f.owner, f.scope.workspaceId, "DELETE FROM performance_evidence_snapshots WHERE workspace_id=$1", [f.scope.workspaceId], "P0001");
  await refuses(f.owner, f.scope.workspaceId, "TRUNCATE performance_evidence_snapshots", [], "P0001");
  assert.deepEqual(await f.counts(), { commands: "1", assessments: "1", witnesses: "1" });
});

test("A4 real sidecar INSERT failure rolls back command and assessment before same-key recovery", async t => {
  const f = await fixture(t);
  const name = `a4_fault_${randomUUID().replaceAll("-", "")}`;
  assert.match(name, /^[a-z0-9_]+$/);
  // Exact disposable fixture scope only. No disabling guards or editing immutable rows.
  const ddl = `CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql AS $a4$
    BEGIN IF NEW.workspace_id = '${f.scope.workspaceId}' THEN RAISE EXCEPTION 'A4_TEST_SIDECAR_FAILURE'; END IF; RETURN NEW; END; $a4$`;
  await f.owner.query(ddl);
  try {
    await f.owner.query(`CREATE TRIGGER ${name} BEFORE INSERT ON public.performance_evidence_snapshots FOR EACH ROW EXECUTE FUNCTION public.${name}()`);
    try {
      await assert.rejects(executePerformanceAssessmentCommand(f.runtime, f.trust, f.intent), { code: "P0001", message: "A4_TEST_SIDECAR_FAILURE" });
      assert.deepEqual(await f.counts(), { commands: "0", assessments: "0", witnesses: "0" });
    } finally { await f.owner.query(`DROP TRIGGER IF EXISTS ${name} ON public.performance_evidence_snapshots`); }
  } finally { await f.owner.query(`DROP FUNCTION IF EXISTS public.${name}()`); }
  const recovered = await executePerformanceAssessmentCommand(f.runtime, f.trust, f.intent);
  assert.equal(recovered.result.score, 10);
  assert.deepEqual(await f.counts(), { commands: "1", assessments: "1", witnesses: "1" });
});

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function blocked(observer: PoolClient, waiterPid: number, holderPid: number) {
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline) {
    const row = (await observer.query<{ blockers: number[] }>("SELECT pg_blocking_pids($1) AS blockers", [waiterPid])).rows[0];
    if (row.blockers.includes(holderPid)) return;
  }
  assert.fail("server did not report the declared waiter/holder lock relation");
}

test("A4 actual Record writer blocks behind admission until outer transaction releases locks", async t => {
  const f = await fixture(t), held = deferred(), release = deferred();
  let holderPid = 0;
  const holder = runAdmittedPerformanceCommand(f.runtime, f.trust, f.intent, async client => {
    holderPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    held.resolve(); await release.promise;
    return executePerformanceAssessmentCommand(client, f.trust, f.intent);
  });
  const holderSettled = holder.then(value => ({ value }), error => ({ error }));
  let waiter: PoolClient | undefined, observer: PoolClient | undefined;
  let pending: Promise<{ error?: unknown }> | undefined;
  try {
    waiter = await f.owner.connect(); observer = await f.owner.connect();
    await Promise.race([held.promise, holderSettled.then(result => {
      if ("error" in result) throw result.error;
      assert.fail("admission holder ended before reaching its barrier");
    })]);
    const waiterPid = (await waiter.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const observerPid = (await observer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    assert.notEqual(observerPid, holderPid); assert.notEqual(observerPid, waiterPid);
    await waiter.query("BEGIN"); await waiter.query("SET LOCAL statement_timeout='5s'");
    pending = waiter.query("UPDATE records SET status=status WHERE workspace_id=$1 AND id=$2", [f.scope.workspaceId, f.intent.recordId]).then(() => ({}), error => ({ error }));
    await blocked(observer, waiterPid, holderPid);
    assert.deepEqual(await f.counts(), { commands: "0", assessments: "0", witnesses: "0" });
    release.resolve();
    const result = await holderSettled;
    if ("error" in result) throw result.error;
    assert.equal(result.value.result.score, 10);
    assert.deepEqual(await pending, {});
    await waiter.query("ROLLBACK");
    const remaining = await observer.query("SELECT pid FROM pg_stat_activity WHERE pid=ANY($1::integer[]) AND (xact_start IS NOT NULL OR wait_event_type='Lock')", [[holderPid, waiterPid]]);
    assert.deepEqual(remaining.rows, [], "independent observer sees no remaining barrier transaction or lock wait");
  } finally {
    release.resolve();
    await holderSettled;
    if (pending) await pending;
    try { if (waiter) await waiter.query("ROLLBACK"); } finally { waiter?.release(); observer?.release(); }
  }
});

// These controls extend the original G06/S02/S03 cases. Still AUTHORED/NOT_RUN:
// compiling this file is not a live transaction, ACL, locking or rollback result.
for (const mode of [
  { name: "read only", sql: "SET default_transaction_read_only = 'on'", expectedIsolation: "read committed", expectedReadOnly: "on" },
  { name: "repeatable read", sql: "SET default_transaction_isolation = 'repeatable read'", expectedIsolation: "repeatable read", expectedReadOnly: "off" },
  { name: "serializable", sql: "SET default_transaction_isolation = 'serializable'", expectedIsolation: "serializable", expectedReadOnly: "off" },
]) {
  test(`A4 actual pool admission refuses ${mode.name} before any fact write`, async t => {
    const f = await fixture(t);
    // A private one-session fixture pool, not ALTER ROLE/DATABASE/global settings.
    // The production entry still receives its actual Pool and owns BEGIN/ROLLBACK.
    const client = await f.runtime.connect();
    try {
      assert.equal(f.runtime.totalCount, 1);
      await client.query(mode.sql);
      const observed = (await client.query<{ isolation: string; read_only: string }>(
        "SELECT current_setting('default_transaction_isolation') AS isolation,current_setting('default_transaction_read_only') AS read_only")).rows[0];
      assert.deepEqual(observed, { isolation: mode.expectedIsolation, read_only: mode.expectedReadOnly });
    } finally { client.release(); }
    await assert.rejects(executePerformanceAssessmentCommand(f.runtime, f.trust, f.intent), (error: unknown) => {
      assert.ok(error instanceof PerformanceAdmissionError);
      assert.equal(error.code, "PERFORMANCE_TRANSACTION_UNPROVEN");
      assert.equal(error.status, 422);
      return true;
    });
    assert.deepEqual(await f.counts(), { commands: "0", assessments: "0", witnesses: "0" });
    const active = await f.owner.query(
      "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1 AND (xact_start IS NOT NULL OR wait_event_type='Lock')", [f.runtimeName]);
    assert.deepEqual(active.rows, [], "a refused Pool entry leaves no open transaction or lock wait");
  });
}

async function runtimeWaiter(observer: PoolClient, applicationName: string, holderPid: number): Promise<number> {
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline) {
    const rows = (await observer.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND application_name=$1
         AND pid<>$2 AND $2=ANY(pg_blocking_pids(pid))`, [applicationName, holderPid])).rows;
    if (rows.length === 1) return rows[0].pid;
    assert.equal(rows.length, 0, "the owned fixture has at most one competing waiter");
  }
  assert.fail("PostgreSQL did not report the same-key competing executor blocked by its declared holder");
}

test("A4 two actual runtime executors serialize the same key and loser reads the committed witness", async t => {
  const f = await fixture(t), held = deferred(), release = deferred();
  let holderPid = 0, waiterPid = 0;
  const holder = runAdmittedPerformanceCommand(f.runtime, f.trust, f.intent, async client => {
    const mode = (await client.query<{ pid: number; isolation: string; read_only: string }>(
      "SELECT pg_backend_pid() AS pid,current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS read_only")).rows[0];
    assert.equal(mode.isolation, "read committed"); assert.equal(mode.read_only, "off");
    holderPid = mode.pid; held.resolve(); await release.promise;
    return executePerformanceAssessmentCommand(client, f.trust, f.intent);
  });
  const holderSettled = holder.then(value => ({ value }), error => ({ error }));
  let loserSettled: typeof holderSettled | undefined, observer: PoolClient | undefined;
  try {
    observer = await f.owner.connect();
    const observerPid = (await observer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await Promise.race([held.promise, holderSettled.then(result => {
      if ("error" in result) throw result.error;
      assert.fail("the admitted holder ended before its declared barrier");
    })]);
    assert.notEqual(observerPid, holderPid);
    // Own rejection immediately, before waiting on the independent server barrier.
    loserSettled = executePerformanceAssessmentCommand(f.runtime, f.trust, f.intent)
      .then(value => ({ value }), error => ({ error }));
    waiterPid = await runtimeWaiter(observer, f.runtimeName, holderPid);
    assert.notEqual(waiterPid, holderPid); assert.notEqual(waiterPid, observerPid);
    assert.deepEqual(await f.counts(), { commands: "0", assessments: "0", witnesses: "0" });
    release.resolve();
    const winner = await holderSettled, loser = await loserSettled;
    if ("error" in winner) throw winner.error;
    if ("error" in loser) throw loser.error;
    assert.equal(winner.value.result.status, "committed");
    assert.equal(loser.value.result.status, "replayed");
    assert.deepEqual(loser.value.result, { ...winner.value.result, status: "replayed" });
    assert.deepEqual(await f.counts(), { commands: "1", assessments: "1", witnesses: "1" });
    const historical = await createPostgresCommittedFactCommandStore(f.runtime).loadCommand(f.scope, f.intent.idempotencyKey);
    assert.ok(historical); assert.equal(historical.result.commandId, winner.value.result.commandId);
    const active = await observer.query(
      "SELECT pid FROM pg_stat_activity WHERE pid=ANY($1::integer[]) AND (xact_start IS NOT NULL OR wait_event_type='Lock')", [[holderPid, waiterPid]]);
    assert.deepEqual(active.rows, [], "both actual production executor transactions released their locks");
  } finally {
    release.resolve();
    try { await holderSettled; if (loserSettled) await loserSettled; }
    finally { observer?.release(); }
  }
});

test("A4 real store rejects changed score with both retained and recomputed accepted-request fingerprints", async t => {
  const f = await fixture(t);
  const first = await executePerformanceAssessmentCommand(f.runtime, f.trust, f.intent);
  const store = createPostgresCommittedFactCommandStore(f.runtime);
  const accepted = await store.loadCommand(f.scope, f.intent.idempotencyKey);
  assert.ok(accepted?.request);
  const request = { ...accepted.request, score: first.result.score + 20 };
  for (const requestFingerprint of [accepted.requestFingerprint, committedFactRequestFingerprintFor(f.scope, request)]) {
    await assert.rejects(store.recordPerformanceAssessment({
      scope: f.scope, commandId: first.result.commandId, idempotencyKey: f.intent.idempotencyKey,
      recordId: f.intent.recordId, policyVersion: f.intent.policyVersion, score: first.result.score + 20,
      evidenceEventIds: f.intent.evidenceEventIds, evidenceSnapshotHash: evidenceHash(f.intent.evidenceEventIds),
      request, requestFingerprint,
    }), { code: "IDEMPOTENCY_KEY_REUSE" });
    assert.deepEqual(await store.loadCommand(f.scope, f.intent.idempotencyKey), accepted);
    assert.deepEqual(await f.counts(), { commands: "1", assessments: "1", witnesses: "1" });
  }
});

test("A4 actual INSERT guards reject wrong same-scope Record, cross-workspace scope and unsupported version", async t => {
  const f = await fixture(t);
  const first = await executePerformanceAssessmentCommand(f.runtime, f.trust, f.intent);
  const source = (await f.owner.query<{
    workspace_id: string; world_id: string; worldline_id: string; record_id: string;
    assessment_id: string; command_id: string; version: number; manifest_canonical: string; manifest_hash: string;
  }>(`SELECT workspace_id,world_id,worldline_id,record_id,assessment_id,command_id,version,manifest_canonical,manifest_hash
      FROM performance_evidence_snapshots WHERE workspace_id=$1 AND assessment_id=$2`, [f.scope.workspaceId, first.result.assessmentId])).rows;
  assert.equal(source.length, 1);
  const row = source[0];
  const siblingId = `a4_same_scope_record_${randomUUID()}`;
  await withWorkspaceTransaction(f.owner, f.scope.workspaceId, async client => {
    const inserted = await client.query(
      `INSERT INTO records (workspace_id,world_id,worldline_id,story_id,id,title,status,start_tick,start_ordinal,world_version)
        SELECT workspace_id,world_id,worldline_id,story_id,$5,title,status,start_tick,start_ordinal,world_version
        FROM records WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 AND id=$4`,
      [f.scope.workspaceId, f.scope.worldId, f.scope.worldlineId, f.intent.recordId, siblingId]);
    assert.equal(inserted.rowCount, 1, "same-scope negative control requires an actually persisted sibling Record");
  });
  const insertSql = `INSERT INTO performance_evidence_snapshots
    (workspace_id,world_id,worldline_id,record_id,assessment_id,command_id,version,manifest_canonical,manifest_hash)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`;
  const values = (recordId = row.record_id, version = row.version) => [
    row.workspace_id, row.world_id, row.worldline_id, recordId, row.assessment_id, row.command_id,
    version, row.manifest_canonical, row.manifest_hash,
  ];
  // Unchanged tuple passes BEFORE INSERT validation and reaches the real unique key.
  await refuses(f.runtime, f.scope.workspaceId, insertSql, values(), "23505");
  // This Record exists under the SAME workspace/world/line: not a missing-FK stand-in.
  await refuses(f.runtime, f.scope.workspaceId, insertSql, values(siblingId), "P0001", "PERFORMANCE_WITNESS_TUPLE");
  // The explicit invoker scope guard runs before RLS WITH CHECK. Do not relabel its
  // P0001 as an observed 42501 RLS-policy refusal; catalog policy proof is separate.
  await refuses(f.runtime, `a4_foreign_${randomUUID()}`, insertSql, values(), "P0001", "PERFORMANCE_WITNESS_SCOPE");
  await refuses(f.runtime, f.scope.workspaceId, insertSql, values(row.record_id, 2), "23514");
  const after = (await f.owner.query<typeof row>(`SELECT workspace_id,world_id,worldline_id,record_id,assessment_id,command_id,version,manifest_canonical,manifest_hash
      FROM performance_evidence_snapshots WHERE workspace_id=$1 AND assessment_id=$2`, [f.scope.workspaceId, first.result.assessmentId])).rows;
  assert.deepEqual(after, source);
  assert.deepEqual(await f.counts(), { commands: "1", assessments: "1", witnesses: "1" });
});

async function pendingMilestone(f: Awaited<ReturnType<typeof fixture>>) {
  const projectId = `a4_competing_project_${randomUUID()}`, milestoneId = `a4_competing_milestone_${randomUUID()}`;
  await withWorkspaceTransaction(f.owner, f.scope.workspaceId, async client => {
    await client.query(`INSERT INTO projects (workspace_id,world_id,worldline_id,id,kind,status,stage,title,version)
      VALUES ($1,$2,$3,$4,'production','active','delivery','A4 real competing confirmation',1)`,
    [f.scope.workspaceId, f.scope.worldId, f.scope.worldlineId, projectId]);
    await client.query(`INSERT INTO project_milestones
      (workspace_id,world_id,worldline_id,id,project_id,sequence,title,status,completion_record_id,completion_event_id)
      VALUES ($1,$2,$3,$4,$5,1,'A4 not yet completed','active',NULL,NULL)`,
    [f.scope.workspaceId, f.scope.worldId, f.scope.worldlineId, milestoneId, projectId]);
  });
  const actual = (await f.owner.query<{ head_tick: string; head_ordinal: string; scene_id: string }>(
    `SELECT w.head_tick::text,w.head_ordinal::text,e.scene_id
       FROM worldlines w JOIN events e ON (e.workspace_id,e.world_id,e.worldline_id)=(w.workspace_id,w.world_id,w.id)
       WHERE w.workspace_id=$1 AND w.world_id=$2 AND w.id=$3 AND e.record_id=$4 AND e.id=$5`,
    [f.scope.workspaceId, f.scope.worldId, f.scope.worldlineId, f.intent.recordId, f.intent.evidenceEventIds[0]])).rows;
  assert.equal(actual.length, 1);
  const expectedWorldCursor = { worldTick: Number(actual[0].head_tick), worldOrdinal: Number(actual[0].head_ordinal) };
  assert.ok(Number.isSafeInteger(expectedWorldCursor.worldTick) && Number.isSafeInteger(expectedWorldCursor.worldOrdinal));
  return { scope: f.scope, projectId, milestoneId, expectedProjectVersion: 1,
    idempotencyKey: `a4_confirm_${randomUUID()}`,
    evidence: { recordId: f.intent.recordId, sceneId: actual[0].scene_id, visibility: "public" as const, expectedWorldCursor } };
}

async function storedWitness(f: Awaited<ReturnType<typeof fixture>>, assessmentId: string) {
  const rows = (await f.owner.query<{ manifest_canonical: string; manifest_hash: string }>(
    `SELECT manifest_canonical,manifest_hash FROM performance_evidence_snapshots
       WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 AND record_id=$4 AND assessment_id=$5`,
    [f.scope.workspaceId, f.scope.worldId, f.scope.worldlineId, f.intent.recordId, assessmentId])).rows;
  assert.equal(rows.length, 1);
  const snapshot = decodePerformanceEvidenceSnapshot(rows[0].manifest_canonical);
  assert.equal(performanceEvidenceSnapshotHash(snapshot), rows[0].manifest_hash);
  return { canonical: rows[0].manifest_canonical, snapshot };
}

// Original G03: the real finance repository, not a raw milestone UPDATE or fake
// command result. Pool finance and same-client outer composition are distinct
// controls; this does not claim the authenticated Bridge HTTP route was executed.
for (const firstWriter of ["performance", "finance"] as const) {
  test(`A4 actual ${firstWriter}-first milestone competition preserves the accepted factor snapshot`, async t => {
    const f = await fixture(t), command = await pendingMilestone(f), held = deferred(), release = deferred();
    type Outcome = { kind: "performance"; result: Awaited<ReturnType<typeof executePerformanceAssessmentCommand>> }
      | { kind: "finance"; result: MilestoneCommandResult };
    const confirm = (database: WorkspaceDatabase) => createProjectFinanceCommandService({
      store: createPostgresProjectFinanceCommandStore(database),
    }).confirmMilestone(command);
    const state = async () => {
      const rows = (await f.owner.query<{ status: string; completion_record_id: string | null; completion_event_id: string | null }>(
        `SELECT status,completion_record_id,completion_event_id FROM project_milestones
           WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 AND project_id=$4 AND id=$5`,
        [f.scope.workspaceId, f.scope.worldId, f.scope.worldlineId, command.projectId, command.milestoneId])).rows;
      assert.equal(rows.length, 1); return rows[0];
    };
    let holderPid = 0;
    const hold = async (client: PoolClient, work: () => Promise<Outcome>): Promise<Outcome> => {
      const result = await work();
      holderPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      held.resolve(); await release.promise; return result;
    };
    // Both holders retain the REAL production mutations and locks until their
    // actual outer COMMIT. No advisory-lock stand-in for the application locks.
    const holder: Promise<Outcome> = firstWriter === "performance"
      ? runAdmittedPerformanceCommand(f.runtime, f.trust, f.intent, client => hold(client, async () => ({
        kind: "performance", result: await executePerformanceAssessmentCommand(client, f.trust, f.intent),
      })))
      : withWorkspaceTransaction(f.runtime, f.scope.workspaceId, client => hold(client, async () => ({
        kind: "finance", result: await confirm(client),
      })));
    const settle = (promise: Promise<Outcome>) => promise.then(value => ({ value }), (error: unknown) => ({ error }));
    const holderSettled = settle(holder);
    let waiterSettled: ReturnType<typeof settle> | undefined, observer: PoolClient | undefined;
    try {
      observer = await f.owner.connect();
      const observerPid = (await observer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await Promise.race([held.promise, holderSettled.then(result => {
        if ("error" in result) throw result.error;
        assert.fail("the real production writer ended before the declared outer-transaction barrier");
      })]);
      assert.notEqual(observerPid, holderPid);
      const competing: Promise<Outcome> = firstWriter === "performance"
        ? confirm(f.runtime).then(result => ({ kind: "finance", result }))
        : executePerformanceAssessmentCommand(f.runtime, f.trust, f.intent).then(result => ({ kind: "performance", result }));
      waiterSettled = settle(competing);
      const waiterPid = await runtimeWaiter(observer, f.runtimeName, holderPid);
      assert.notEqual(observerPid, waiterPid); assert.notEqual(holderPid, waiterPid);
      assert.deepEqual(await state(), { status: "active", completion_record_id: null, completion_event_id: null },
        "a separate connection cannot see a completion before the holder commits");
      assert.deepEqual(await f.counts(), { commands: "0", assessments: "0", witnesses: "0" });
      release.resolve();
      const first = await holderSettled, second = await waiterSettled;
      if ("error" in first) throw first.error;
      if ("error" in second) throw second.error;
      assert.notEqual(first.value.kind, second.value.kind);
      const outcomes = [first.value, second.value];
      const assessed = outcomes.find((value): value is Extract<Outcome, { kind: "performance" }> => value.kind === "performance");
      const confirmed = outcomes.find((value): value is Extract<Outcome, { kind: "finance" }> => value.kind === "finance");
      assert.ok(assessed); assert.ok(confirmed);
      assert.equal(confirmed.result.status, "committed"); assert.equal(confirmed.result.projectVersion, 2);
      assert.equal(assessed.result.result.score, firstWriter === "performance" ? 10 : 30);
      const completed = await state();
      assert.equal(completed.status, "completed"); assert.equal(completed.completion_record_id, f.intent.recordId);
      assert.ok(completed.completion_event_id); assert.notEqual(completed.completion_event_id, f.intent.evidenceEventIds[0]);
      const witness = await storedWitness(f, assessed.result.result.assessmentId);
      assert.equal(witness.snapshot.factors.milestoneCompleted, firstWriter === "finance");
      assert.equal(witness.snapshot.factors.score, assessed.result.result.score);
      if (firstWriter === "finance") {
        assert.equal(witness.snapshot.milestoneWitness?.id, command.milestoneId);
        assert.equal(witness.snapshot.milestoneWitness?.projectId, command.projectId);
        assert.equal(witness.snapshot.milestoneWitness?.completionEventId, completed.completion_event_id);
        assert.equal(witness.snapshot.head.lastEventId, completed.completion_event_id);
      } else {
        assert.equal(witness.snapshot.milestoneWitness, null);
        assert.equal(witness.snapshot.head.lastEventId, f.intent.evidenceEventIds[0]);
      }
      const replay = await executePerformanceAssessmentCommand(f.runtime, { ...f.trust, evidencePolicy: null, enablement: undefined }, f.intent);
      assert.deepEqual(replay.result, { ...assessed.result.result, status: "replayed" });
      assert.deepEqual(await storedWitness(f, assessed.result.result.assessmentId), witness, "later completion cannot rewrite an accepted witness");
      const fresh = await executePerformanceAssessmentCommand(f.runtime, f.trust, { ...f.intent, idempotencyKey: `${f.intent.idempotencyKey}:after-confirmation` });
      assert.equal(fresh.result.score, 30);
      assert.deepEqual(await f.counts(), { commands: "2", assessments: "2", witnesses: "2" });
      const active = await observer.query(
        "SELECT pid FROM pg_stat_activity WHERE pid=ANY($1::integer[]) AND (xact_start IS NOT NULL OR wait_event_type='Lock')", [[holderPid, waiterPid]]);
      assert.deepEqual(active.rows, [], "both application writers released their real transaction locks");
    } finally {
      release.resolve();
      try { await holderSettled; if (waiterSettled) await waiterSettled; }
      finally { observer?.release(); }
    }
  });
}

test("A4 default production assembly admits NEW; explicit disabled transport persists no partial facts", async t => {
  const f = await fixture(t);
  const productionTrust = createPerformanceCommandTrust(f.scope, f.trust.principalId);
  assert.equal(productionTrust.enablement?.durableTransport, true);
  const disabledTrust = { ...productionTrust, enablement: { schema: true, durableTransport: false } };
  await assert.rejects(executePerformanceAssessmentCommand(f.runtime, disabledTrust, f.intent), (error: unknown) => {
    assert.ok(error instanceof PerformanceAdmissionError);
    assert.equal(error.code, "PERFORMANCE_TRANSPORT_UNAVAILABLE");
    assert.equal(error.status, 503);
    return true;
  });
  assert.deepEqual(await f.counts(), { commands: "0", assessments: "0", witnesses: "0" });
  const accepted = await executePerformanceAssessmentCommand(f.runtime, productionTrust, f.intent);
  assert.equal(accepted.result.score, 10);
  assert.equal(accepted.result.goalTransition, null);
  assert.deepEqual(await f.counts(), { commands: "1", assessments: "1", witnesses: "1" });
});
