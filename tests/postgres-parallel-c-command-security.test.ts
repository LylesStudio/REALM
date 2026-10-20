import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg, { type PoolClient } from "pg";
import { POSTGRES_DEMO_IDS } from "../database/postgres/public.ts";
import { createPostgresCommittedFactCommandStore } from "../database/postgres/committed-fact-command-repository.ts";
import { committedFactCommandIdFor, committedFactRequestFingerprintFor } from "../modules/application/committed-fact-command.ts";
import { authorizeProjectFinanceWrite } from "../app/api/bridge/v1/project-finance-context.ts";
import { createPostgresProjectFinanceCommandStore } from "../database/postgres/project-finance-command-repository.ts";
import { projectFinanceCommandFingerprintFor } from "../modules/projects/public.ts";

// NOT_RUN in the parallel batch. Only Iris's isolated serial PG runner may run
// this file. The two contenders below are actual backend clients; no SQL stub,
// timing sleep, or simulated lock result is used.
const options = { skip: !process.env.DATABASE_URL || !process.env.REALM_RUNTIME_DATABASE_URL ? "requires isolated serial PostgreSQL clearance" : false, timeout: 30_000 };
const scope = { workspaceId: POSTGRES_DEMO_IDS.workspace, worldId: POSTGRES_DEMO_IDS.world, worldlineId: POSTGRES_DEMO_IDS.worldline };

async function begin(client: PoolClient) {
  await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  await client.query("SELECT set_config('realm.workspace_id', $1, true)", [scope.workspaceId]);
}

async function waitingFor(observer: PoolClient, waiter: number, blocker: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const actual = await observer.query<{ blocked: boolean }>("SELECT $2::integer = ANY(pg_blocking_pids($1::integer)) AS blocked", [waiter, blocker]);
    if (actual.rows[0]?.blocked) return;
  }
  assert.fail("backend did not reach the required actual row/advisory lock barrier");
}

test("A6 PG: same-key contenders serialize, re-read the committed receipt, reject changed intent, and isolate workspace", options, async () => {
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const runtime = new pg.Pool({ connectionString: process.env.REALM_RUNTIME_DATABASE_URL, max: 2 });
  const [observer, first, second] = await Promise.all([admin.connect(), runtime.connect(), runtime.connect()]);
  const commandIds: string[] = [];
  const targetWorkspaceIds: string[] = [];
  try {
    const firstPid = Number((await first.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    const secondPid = Number((await second.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    for (const changed of [false, true]) {
      const key = `parallel_c_${randomUUID()}`;
      const request = { command: "relationship.revised", subjectEntityKey: "parallel-c:a", objectEntityKey: "parallel-c:b", relationKind: "trust", sourceEventId: "event_opening" };
      const fingerprint = committedFactRequestFingerprintFor(scope, request);
      const commandId = committedFactCommandIdFor(scope, key, fingerprint);
      commandIds.push(commandId);
      const input = { scope, commandId, idempotencyKey: key, requestFingerprint: fingerprint, request, ...request };
      await begin(first); await begin(second);
      const committed = await createPostgresCommittedFactCommandStore(first).reviseRelationship(input);
      assert.equal(committed.status, "committed");
      const candidate = changed ? { ...request, relationKind: "respect" } : request;
      const pending = createPostgresCommittedFactCommandStore(second).reviseRelationship({ ...input, ...candidate, request: candidate, requestFingerprint: committedFactRequestFingerprintFor(scope, candidate) });
      // Attach the rejection handler immediately; an expected conflict is never
      // an unhandled rejection while the barrier/COMMIT are being observed.
      const outcome = pending.then(value => ({ value, error: null }), error => ({ value: null, error }));
      await waitingFor(observer, secondPid, firstPid);
      await first.query("COMMIT");
      const settled = await outcome;
      if (changed) assert.equal(settled.error?.code, "IDEMPOTENCY_KEY_REUSE");
      else { assert.equal(settled.error, null); assert.deepEqual(settled.value, { ...committed, status: "replayed" }); }
      await second.query("ROLLBACK");
      const count = await observer.query("SELECT count(*)::integer AS n FROM member_relationship_revisions WHERE workspace_id=$1 AND command_id=$2", [scope.workspaceId, commandId]);
      assert.equal(count.rows[0].n, 1);
      const foreign = { ...scope, workspaceId: `parallel_c_foreign_${randomUUID()}` };
      targetWorkspaceIds.push(foreign.workspaceId);
      await observer.query("INSERT INTO workspaces(id,name) VALUES($1,'Parallel C target')", [foreign.workspaceId]);
      await observer.query("INSERT INTO worlds(workspace_id,id,name,calendar_id) SELECT $1,id,'Parallel C target',calendar_id FROM worlds WHERE workspace_id=$2 AND id=$3", [foreign.workspaceId, scope.workspaceId, scope.worldId]);
      await observer.query("INSERT INTO worldlines(workspace_id,world_id,id,label) VALUES($1,$2,$3,'Parallel C target')", [foreign.workspaceId, foreign.worldId, foreign.worldlineId]);
      await begin(second);
      const foreignStore = createPostgresCommittedFactCommandStore(second);
      assert.equal(await foreignStore.loadCommand(foreign, key), null);
      await assert.rejects(foreignStore.reviseRelationship({ ...input, scope: foreign }), { code: "EVENT_NOT_FOUND" });
      await second.query("ROLLBACK");
      assert.equal((await observer.query("SELECT count(*)::integer AS n FROM committed_fact_commands WHERE workspace_id=$1", [foreign.workspaceId])).rows[0].n, 0);
      assert.equal((await observer.query("SELECT count(*)::integer AS n FROM committed_fact_commands WHERE workspace_id=$1 AND id=$2", [scope.workspaceId, commandId])).rows[0].n, 1);
    }
  } finally {
    await Promise.all([first.query("ROLLBACK"), second.query("ROLLBACK")]);
    try {
      await observer.query("BEGIN");
      await observer.query("SET LOCAL session_replication_role = replica");
      await observer.query("DELETE FROM member_relationship_revisions WHERE workspace_id=$1 AND command_id=ANY($2::text[])", [scope.workspaceId, commandIds]);
      await observer.query("DELETE FROM committed_fact_commands WHERE workspace_id=$1 AND id=ANY($2::text[])", [scope.workspaceId, commandIds]);
      // replica suppresses FK cascade triggers: explicitly remove only this
      // fixture's owned child rows before its workspace rows.
      await observer.query("DELETE FROM worldlines WHERE workspace_id=ANY($1::text[])", [targetWorkspaceIds]);
      await observer.query("DELETE FROM worlds WHERE workspace_id=ANY($1::text[])", [targetWorkspaceIds]);
      await observer.query("DELETE FROM workspaces WHERE id=ANY($1::text[])", [targetWorkspaceIds]);
      await observer.query("COMMIT");
    } finally {
      await observer.query("ROLLBACK");
      first.release(); second.release(); observer.release(); await Promise.all([runtime.end(), admin.end()]);
    }
  }
});

test("A3 PG: committed revocation before transaction authorization denies, and authorization locks block later revocation", options, async () => {
  assert.equal(typeof authorizeProjectFinanceWrite, "function", "A3 source candidate must be installed by the cleared fixture");
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const runtime = new pg.Pool({ connectionString: process.env.REALM_RUNTIME_DATABASE_URL, max: 1 });
  const [revoker, observer, writer] = await Promise.all([admin.connect(), admin.connect(), runtime.connect()]);
  const principalId = POSTGRES_DEMO_IDS.principal;
  const where = [scope.workspaceId, scope.worldId, principalId];
  const role = (await observer.query("SELECT role FROM player_world_memberships WHERE workspace_id=$1 AND world_id=$2 AND principal_id=$3", where)).rows[0]?.role;
  assert.ok(role === "owner" || role === "player");
  try {
    const revokerPid = Number((await revoker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    const writerPid = Number((await writer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    await revoker.query("BEGIN");
    await revoker.query("UPDATE player_world_memberships SET role='observer' WHERE workspace_id=$1 AND world_id=$2 AND principal_id=$3", where);
    await begin(writer);
    const denied = authorizeProjectFinanceWrite(writer, { scope, principalId }).then(() => null, error => error);
    await waitingFor(observer, writerPid, revokerPid);
    await revoker.query("COMMIT");
    assert.equal((await denied)?.code, "FORBIDDEN");
    await writer.query("ROLLBACK");
    await revoker.query("UPDATE player_world_memberships SET role=$4 WHERE workspace_id=$1 AND world_id=$2 AND principal_id=$3", [...where, role]);
    await begin(writer);
    await authorizeProjectFinanceWrite(writer, { scope, principalId });
    await revoker.query("BEGIN");
    const revocation = revoker.query("UPDATE player_world_memberships SET role='observer' WHERE workspace_id=$1 AND world_id=$2 AND principal_id=$3", where);
    await waitingFor(observer, revokerPid, writerPid);
    await writer.query("ROLLBACK");
    await revocation;
    await revoker.query("ROLLBACK");
  } finally {
    await Promise.all([writer.query("ROLLBACK"), revoker.query("ROLLBACK")]);
    await observer.query("UPDATE player_world_memberships SET role=$4 WHERE workspace_id=$1 AND world_id=$2 AND principal_id=$3", [...where, role]);
    writer.release(); revoker.release(); observer.release(); await Promise.all([runtime.end(), admin.end()]);
  }
});

test("A6 PG Finance: stage contenders re-read after the actual same-key lock and commit one version", options, async () => {
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const runtime = new pg.Pool({ connectionString: process.env.REALM_RUNTIME_DATABASE_URL, max: 2 });
  const [observer, first, second] = await Promise.all([admin.connect(), runtime.connect(), runtime.connect()]);
  const projectIds: string[] = [], commandIds: string[] = [];
  try {
    const firstPid = Number((await first.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    const secondPid = Number((await second.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    for (const changed of [false, true]) {
      const suffix = randomUUID();
      const projectId = `parallel_c_project_${suffix}`, commandGroupId = `parallel_c_group_${suffix}`, key = `parallel_c_finance_${suffix}`;
      projectIds.push(projectId); commandIds.push(commandGroupId);
      await observer.query("INSERT INTO projects(workspace_id,world_id,worldline_id,id,kind,status,stage,title,currency,version) VALUES($1,$2,$3,$4,'production','active','planning','Parallel C','JPY',1)", [scope.workspaceId, scope.worldId, scope.worldlineId, projectId]);
      const request = { command: "project.stage.changed", projectId, stage: "production" as const, expectedProjectVersion: 1, evidence: null };
      const input = { scope, commandGroupId, idempotencyKey: key, request, requestFingerprint: projectFinanceCommandFingerprintFor(scope, request), projectId, stage: request.stage, expectedProjectVersion: 1, evidence: null };
      await begin(first); await begin(second);
      const committed = await createPostgresProjectFinanceCommandStore(first).changeStage(input);
      const candidate = changed ? { ...request, stage: "delivery" as const } : request;
      const pending = createPostgresProjectFinanceCommandStore(second).changeStage({ ...input, stage: candidate.stage, request: candidate, requestFingerprint: projectFinanceCommandFingerprintFor(scope, candidate) });
      const outcome = pending.then(value => ({ value, error: null }), error => ({ value: null, error }));
      await waitingFor(observer, secondPid, firstPid);
      await first.query("COMMIT");
      const settled = await outcome;
      if (changed) assert.equal(settled.error?.code, "IDEMPOTENCY_KEY_REUSE");
      else { assert.equal(settled.error, null); assert.deepEqual(settled.value, { ...committed, status: "replayed" }); }
      await second.query("ROLLBACK");
      const project = await observer.query("SELECT stage,version::text FROM projects WHERE workspace_id=$1 AND id=$2", [scope.workspaceId, projectId]);
      assert.deepEqual(project.rows[0], { stage: "production", version: "2" });
    }
  } finally {
    await Promise.all([first.query("ROLLBACK"), second.query("ROLLBACK")]);
    try {
      await observer.query("BEGIN");
      await observer.query("SET LOCAL session_replication_role = replica");
      await observer.query("DELETE FROM project_finance_command_groups WHERE workspace_id=$1 AND id=ANY($2::text[])", [scope.workspaceId, commandIds]);
      await observer.query("DELETE FROM projects WHERE workspace_id=$1 AND id=ANY($2::text[])", [scope.workspaceId, projectIds]);
      await observer.query("COMMIT");
    } finally {
      await observer.query("ROLLBACK");
      first.release(); second.release(); observer.release(); await Promise.all([runtime.end(), admin.end()]);
    }
  }
});
