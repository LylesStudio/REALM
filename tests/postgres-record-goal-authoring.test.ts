import assert from "node:assert/strict";
import pg from "pg";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { POSTGRES_DEMO_IDS } from "../database/postgres/public.ts";
import { withWorkspaceTransaction } from "../database/postgres/workspace-transaction.ts";
import { createRecordGoalDefinition, planRecordGoalRevision, type RecordGoalDefinitionVersion } from "../modules/goals/record-authoring.ts";

const ownerUrl = process.env.DATABASE_URL;
const runtimeUrl = process.env.REALM_RUNTIME_DATABASE_URL;
const enabled = !!ownerUrl && !!runtimeUrl;

test("Record Goal definitions and command ledger have forced tenant RLS and append-only runtime grants", {
  skip: enabled ? false : "requires isolated scratch runtime runner", timeout: 120_000,
}, async () => {
  const pool = new pg.Pool({ connectionString: ownerUrl!, max: 1 });
  try {
    const tables = await pool.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean;
      can_select: boolean; can_insert: boolean; can_update: boolean; can_delete: boolean }>(`
      SELECT relname, relrowsecurity, relforcerowsecurity,
        has_table_privilege('realm_runtime', oid, 'SELECT') AS can_select,
        has_table_privilege('realm_runtime', oid, 'INSERT') AS can_insert,
        has_table_privilege('realm_runtime', oid, 'UPDATE') AS can_update,
        has_table_privilege('realm_runtime', oid, 'DELETE') AS can_delete
      FROM pg_class WHERE relnamespace = 'public'::regnamespace
        AND relname IN ('record_goal_definitions', 'record_goal_commands') ORDER BY relname`);
    assert.deepEqual(tables.rows, ['record_goal_commands', 'record_goal_definitions'].map((relname) => ({
      relname, relrowsecurity: true, relforcerowsecurity: true,
      can_select: true, can_insert: false, can_update: false, can_delete: false,
    })));
    const columns = await pool.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'goal_instances'
        AND column_name IN ('definition_source', 'definition_id', 'resolution_kind',
          'evidence_start_version', 'evidence_start_ordinal') ORDER BY column_name`);
    assert.deepEqual(columns.rows.map((row) => row.column_name), [
      'definition_id', 'definition_source', 'evidence_start_ordinal', 'evidence_start_version', 'resolution_kind',
    ]);
    const fk = await pool.query<{ conname: string }>(`
      SELECT conname FROM pg_constraint WHERE conrelid = 'goal_instances'::regclass
        AND conname = 'goal_instances_record_definition_fk' AND contype = 'f'`);
    assert.equal(fk.rowCount, 1);
  } finally { await pool.end(); }
});

const scope = { workspaceId: POSTGRES_DEMO_IDS.workspace, worldId: POSTGRES_DEMO_IDS.world,
  worldlineId: POSTGRES_DEMO_IDS.worldline, recordId: POSTGRES_DEMO_IDS.record };
function definitionFixture() {
  return createRecordGoalDefinition({ scope, goalId: `test-${randomUUID()}`,
    activationHead: { recordVersion: 0, ordinal: 0 },
    draft: { title: "Protect the letter", description: "Deliver it intact.", successConditions: ["recipient received letter"],
      changePolicy: "evolving", visible: true } });
}
// Privileged fixture setup only; browser writes use the proof-bound capability.
async function withFixtureWrite<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const admin = new pg.Pool({ connectionString: ownerUrl!, max: 1 });
  try { return await withWorkspaceTransaction(admin, scope.workspaceId, work); }
  finally { await admin.end(); }
}
async function insertFixture(pool: pg.Pool, definition: RecordGoalDefinitionVersion, payload: unknown = definition,
  evidenceHead = definition.activationHead, transactionWorkspaceId: string = scope.workspaceId) {
  const run = transactionWorkspaceId === scope.workspaceId ? withFixtureWrite<void>
    : (work: (client: pg.PoolClient) => Promise<void>) => withWorkspaceTransaction(pool, transactionWorkspaceId, work);
  return run(async (client) => {
    await client.query(`INSERT INTO record_goal_definitions
      (workspace_id, world_id, worldline_id, record_id, id, goal_id, definition_version,
       goal_key, policy_version, definition, supersedes_definition_id, created_by_principal_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)`, [scope.workspaceId, scope.worldId, scope.worldlineId,
      scope.recordId, definition.definitionId, definition.goalId, definition.definitionVersion, definition.goalKey,
      definition.policyVersion, JSON.stringify(payload), definition.supersedesDefinitionId, POSTGRES_DEMO_IDS.principal]);
    await client.query(`INSERT INTO goal_instances
      (workspace_id, world_id, worldline_id, record_id, id, goal_key, policy_version,
       definition_source, definition_id, revision, evidence_start_version, evidence_start_ordinal)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'record',$8,1,$9,$10)`, [scope.workspaceId, scope.worldId, scope.worldlineId,
      scope.recordId, definition.goalInstanceId, definition.goalKey, definition.policyVersion, definition.definitionId,
      evidenceHead.recordVersion, evidenceHead.ordinal]);
    await client.query(`INSERT INTO record_goal_commands
      (workspace_id, world_id, worldline_id, record_id, principal_id, idempotency_key,
       request_fingerprint, operation, goal_instance_id, result)
      VALUES ($1,$2,$3,$4,$5,$6,'test-fingerprint','create',$7,'{}')`, [scope.workspaceId,
      scope.worldId, scope.worldlineId, scope.recordId, POSTGRES_DEMO_IDS.principal,
      definition.goalId, definition.goalInstanceId]);
  });
}

test("Record Goal history rejects owner UPDATE and DELETE as well as runtime writes", {
  skip: enabled ? false : "requires isolated scratch runtime runner", timeout: 120_000,
}, async () => {
  const owner = new pg.Pool({ connectionString: ownerUrl!, max: 1 });
  const runtime = new pg.Pool({ connectionString: runtimeUrl!, max: 1 });
  try {
    const definition = definitionFixture();
    await insertFixture(runtime, definition);
    for (const table of ['record_goal_definitions', 'record_goal_commands']) {
      const [idColumn, id] = table === 'record_goal_definitions'
        ? ['id', definition.definitionId] : ['idempotency_key', definition.goalId];
      for (const pool of [owner, runtime]) {
        for (const sql of [
          `UPDATE ${table} SET created_at = CURRENT_TIMESTAMP WHERE workspace_id = $1 AND ${idColumn} = $2`,
          `DELETE FROM ${table} WHERE workspace_id = $1 AND ${idColumn} = $2`,
        ]) {
          await assert.rejects(withWorkspaceTransaction(pool, scope.workspaceId,
            (client) => client.query(sql, [scope.workspaceId, id])), /append.only|permission denied/i);
        }
      }
    }
  } finally { await runtime.end(); await owner.end(); }
});

test("Record-authored instance bindings and activation evidence cursors are immutable while active", {
  skip: enabled ? false : "requires isolated scratch runtime runner", timeout: 120_000,
}, async () => {
  const runtime = new pg.Pool({ connectionString: runtimeUrl!, max: 1 });
  try {
    const definition = definitionFixture();
    await insertFixture(runtime, definition);
    for (const update of [
      "definition_source = 'content', definition_id = NULL",
      "evidence_start_version = 1, evidence_start_ordinal = 1",
    ]) {
      await assert.rejects(withWorkspaceTransaction(runtime, scope.workspaceId, (client) => client.query(
        `UPDATE goal_instances SET ${update} WHERE workspace_id = $1 AND id = $2`,
        [scope.workspaceId, definition.goalInstanceId])), /binding.*immutable/i);
    }
    const state = await withWorkspaceTransaction(runtime, scope.workspaceId, (client) => client.query(
      `SELECT definition_source, definition_id, evidence_start_version::text, evidence_start_ordinal::text
       FROM goal_instances WHERE workspace_id = $1 AND id = $2`, [scope.workspaceId, definition.goalInstanceId]));
    assert.deepEqual(state.rows, [{ definition_source: 'record', definition_id: definition.definitionId,
      evidence_start_version: '0', evidence_start_ordinal: '0' }]);
  } finally { await runtime.end(); }
});

test("terminal management provenance cannot be rewritten after settlement", {
  skip: enabled ? false : "requires isolated scratch runtime runner", timeout: 120_000,
}, async () => {
  const runtime = new pg.Pool({ connectionString: runtimeUrl!, max: 1 });
  try {
    const definition = definitionFixture();
    await insertFixture(runtime, definition);
    await withWorkspaceTransaction(runtime, scope.workspaceId, (client) => client.query(
      `UPDATE goal_instances SET state = 'settled', resolution_kind = 'superseded', revision = revision + 1, completed_at = CURRENT_TIMESTAMP
       WHERE workspace_id = $1 AND id = $2`, [scope.workspaceId, definition.goalInstanceId]));
    for (const kind of ['natural', 'withdrawn']) {
      await assert.rejects(withWorkspaceTransaction(runtime, scope.workspaceId, (client) => client.query(
        `UPDATE goal_instances SET resolution_kind = $3 WHERE workspace_id = $1 AND id = $2`,
        [scope.workspaceId, definition.goalInstanceId, kind])), /terminal.*immutable/i);
    }
  } finally { await runtime.end(); }
});

test("stored definition JSON cannot disagree with its authoritative identity or scope columns", {
  skip: enabled ? false : "requires isolated scratch runtime runner", timeout: 120_000,
}, async () => {
  const runtime = new pg.Pool({ connectionString: runtimeUrl!, max: 1 });
  try {
    const valid = definitionFixture();
    const patches = [
      { scope: { ...scope, recordId: 'other' } }, { scope: { ...scope, workspaceId: 'other' } },
      { scope: { ...scope, worldId: 'other' } }, { scope: { ...scope, worldlineId: 'other' } },
      { source: 'content' }, { definitionId: 'other' }, { goalId: 'other' },
      { goalKey: 'other' }, { policyVersion: 'other' }, { definitionVersion: '1' },
      { supersedesDefinitionId: 'other' }, { activationHead: { recordVersion: -1, ordinal: -1 } },
    ];
    for (const patch of patches) {
      await assert.rejects(insertFixture(runtime, valid, { ...valid, ...patch }), /definition.*binding.*invalid/i);
    }
    const rows = await withWorkspaceTransaction(runtime, scope.workspaceId, (client) => client.query(
      `SELECT id FROM record_goal_definitions WHERE workspace_id = $1 AND id = $2`,
      [scope.workspaceId, valid.definitionId]));
    assert.equal(rows.rowCount, 0, 'every rejected transaction must roll back fully');
  } finally { await runtime.end(); }
});

test("definition successors must belong to the same goal family and immediately follow the previous version", {
  skip: enabled ? false : "requires isolated scratch runtime runner", timeout: 120_000,
}, async () => {
  const runtime = new pg.Pool({ connectionString: runtimeUrl!, max: 1 });
  try {
    const previous = definitionFixture();
    await insertFixture(runtime, previous);
    const next = planRecordGoalRevision({ previous, scope,
      instance: { goalInstanceId: previous.goalInstanceId, recordId: scope.recordId, state: 'active',
        revision: 1, progress: {}, outcome: null }, expectedDefinitionVersion: 1, expectedInstanceRevision: 1,
      nextDraft: { ...previous.draft, title: 'Find another recipient' }, reason: 'Explicit manual revision',
      events: [], evidenceEventIds: [], observedHead: previous.activationHead }).definition;
    const insert = (definition: RecordGoalDefinitionVersion) => withFixtureWrite(
      (client) => client.query(`INSERT INTO record_goal_definitions
        (workspace_id, world_id, worldline_id, record_id, id, goal_id, definition_version,
         goal_key, policy_version, definition, supersedes_definition_id, created_by_principal_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)`, [scope.workspaceId, scope.worldId,
        scope.worldlineId, scope.recordId, definition.definitionId, definition.goalId, definition.definitionVersion,
        definition.goalKey, definition.policyVersion, JSON.stringify(definition), definition.supersedesDefinitionId,
        POSTGRES_DEMO_IDS.principal]));
    await assert.rejects(insert({ ...next, definitionVersion: 3 }), /definition.*chain.*invalid/i);
    await assert.rejects(insert({ ...next, goalId: 'other-family' }), /definition.*chain.*invalid/i);
    await insert(next);
    const count = await withWorkspaceTransaction(runtime, scope.workspaceId, (client) => client.query(
      `SELECT definition_version FROM record_goal_definitions WHERE workspace_id = $1 AND goal_id = $2
       ORDER BY definition_version`, [scope.workspaceId, previous.goalId]));
    assert.deepEqual(count.rows, [{ definition_version: 1 }, { definition_version: 2 }]);
  } finally { await runtime.end(); }
});

test("instance activation cursor must equal its immutable definition's activation head", {
  skip: enabled ? false : "requires isolated scratch runtime runner", timeout: 120_000,
}, async () => {
  const runtime = new pg.Pool({ connectionString: runtimeUrl!, max: 1 });
  try {
    const seed = definitionFixture();
    const definition = createRecordGoalDefinition({ scope, goalId: seed.goalId, draft: seed.draft,
      activationHead: { recordVersion: 2, ordinal: 4 } });
    await assert.rejects(insertFixture(runtime, definition, definition, { recordVersion: 0, ordinal: 0 }),
      /instance.*binding.*invalid/i);
    await insertFixture(runtime, definition);
  } finally { await runtime.end(); }
});

test("runtime rejects a foreign workspace INSERT and tenant RLS hides definition and command history", {
  skip: enabled ? false : "requires isolated scratch runtime runner", timeout: 120_000,
}, async () => {
  const runtime = new pg.Pool({ connectionString: runtimeUrl!, max: 1 });
  try {
    const definition = definitionFixture();
    await assert.rejects(insertFixture(runtime, definition, definition, definition.activationHead, 'foreign-workspace'),
      { code: '42501' });
    await insertFixture(runtime, definition);
    for (const table of ['record_goal_definitions', 'record_goal_commands']) {
      const visible = await withWorkspaceTransaction(runtime, scope.workspaceId, (client) => client.query(
        `SELECT count(*)::integer AS n FROM ${table} WHERE workspace_id = $1`, [scope.workspaceId]));
      assert.ok(visible.rows[0].n > 0);
      const hidden = await withWorkspaceTransaction(runtime, 'foreign-workspace', (client) => client.query(
        `SELECT count(*)::integer AS n FROM ${table} WHERE workspace_id = $1`, [scope.workspaceId]));
      assert.equal(hidden.rows[0].n, 0);
    }
  } finally { await runtime.end(); }
});

test("authoring persistence stores the canonical initial definition and reads it by exact instance binding", {
  skip: enabled ? false : "requires isolated scratch runtime runner", timeout: 120_000,
}, async () => {
  const repository = await import('../database/postgres/record-goal-authoring-repository.ts');
  const runtime = new pg.Pool({ connectionString: runtimeUrl!, max: 1 });
  try {
    const definition = definitionFixture();
    await withFixtureWrite(async (client) => {
      await repository.materializeRecordAuthoredGoal(client, { definition, principalId: POSTGRES_DEMO_IDS.principal });
      const loaded = await repository.loadRecordAuthoredGoalDefinition(client, scope, {
        definitionId: definition.definitionId, goalKey: definition.goalKey, policyVersion: definition.policyVersion,
      });
      assert.deepEqual(loaded, definition);
      const instance = await client.query(`SELECT definition_source, definition_id, goal_key, policy_version,
        evidence_start_version::text, evidence_start_ordinal::text, revision::text, attempt
        FROM goal_instances WHERE workspace_id = $1 AND id = $2`, [scope.workspaceId, definition.goalInstanceId]);
      assert.deepEqual(instance.rows, [{ definition_source: 'record', definition_id: definition.definitionId,
        goal_key: definition.goalKey, policy_version: definition.policyVersion, evidence_start_version: '0',
        evidence_start_ordinal: '0', revision: '1', attempt: 1 }]);
    });
  } finally { await runtime.end(); }
});

test("authoring replacement atomically preserves history and settles the old instance as management superseded", {
  skip: enabled ? false : "requires isolated scratch runtime runner", timeout: 120_000,
}, async () => {
  const repository = await import('../database/postgres/record-goal-authoring-repository.ts');
  const runtime = new pg.Pool({ connectionString: runtimeUrl!, max: 1 });
  try {
    const previous = definitionFixture();
    await withFixtureWrite((client) => repository.materializeRecordAuthoredGoal(client,
      { definition: previous, principalId: POSTGRES_DEMO_IDS.principal }));
    const replacement = planRecordGoalRevision({ previous, scope,
      instance: { goalInstanceId: previous.goalInstanceId, recordId: scope.recordId, state: 'active',
        revision: 1, progress: {}, outcome: null }, expectedDefinitionVersion: 1, expectedInstanceRevision: 1,
      nextDraft: { ...previous.draft, title: 'Another recipient' }, reason: 'Explicit manual revision',
      events: [], evidenceEventIds: [], observedHead: previous.activationHead });
    await withFixtureWrite(async (client) => {
      await repository.appendRecordGoalReplacement(client, { replacement, principalId: POSTGRES_DEMO_IDS.principal });
      assert.deepEqual(await repository.loadRecordAuthoredGoalDefinition(client, scope, {
        definitionId: previous.definitionId, goalKey: previous.goalKey, policyVersion: previous.policyVersion,
      }), previous);
      assert.deepEqual(await repository.loadRecordAuthoredGoalDefinition(client, scope, {
        definitionId: replacement.definition.definitionId, goalKey: replacement.definition.goalKey,
        policyVersion: replacement.definition.policyVersion,
      }), replacement.definition);
      const states = await client.query(`SELECT id, state, revision::text, resolution_kind, supersedes_instance_id
        FROM goal_instances WHERE workspace_id = $1 AND id = ANY($2::text[]) ORDER BY state`,
        [scope.workspaceId, [previous.goalInstanceId, replacement.definition.goalInstanceId]]);
      assert.deepEqual(states.rows, [
        { id: replacement.definition.goalInstanceId, state: 'active', revision: '1', resolution_kind: 'natural',
          supersedes_instance_id: previous.goalInstanceId },
        { id: previous.goalInstanceId, state: 'settled', revision: '2', resolution_kind: 'superseded',
          supersedes_instance_id: null },
      ]);
    });
  } finally { await runtime.end(); }
});

test("missing or cross-scope definition bindings fail closed instead of silently falling back", {
  skip: enabled ? false : "requires isolated scratch runtime runner", timeout: 120_000,
}, async () => {
  const repository = await import('../database/postgres/record-goal-authoring-repository.ts');
  const runtime = new pg.Pool({ connectionString: runtimeUrl!, max: 1 });
  try {
    const definition = definitionFixture();
    await withFixtureWrite((client) => repository.materializeRecordAuthoredGoal(client,
      { definition, principalId: POSTGRES_DEMO_IDS.principal }));
    const binding = { definitionId: definition.definitionId, goalKey: definition.goalKey, policyVersion: definition.policyVersion };
    for (const field of ['workspaceId', 'worldId', 'worldlineId', 'recordId'] as const) {
      await assert.rejects(withWorkspaceTransaction(runtime, scope.workspaceId, (client) =>
        repository.loadRecordAuthoredGoalDefinition(client, { ...scope, [field]: 'other' }, binding)),
      { code: 'GOAL_DEFINITION_UNAVAILABLE' });
    }
    for (const field of ['definitionId', 'goalKey', 'policyVersion'] as const) {
      await assert.rejects(withWorkspaceTransaction(runtime, scope.workspaceId, (client) =>
        repository.loadRecordAuthoredGoalDefinition(client, scope, { ...binding, [field]: 'other' })),
      { code: 'GOAL_DEFINITION_UNAVAILABLE' });
    }
  } finally { await runtime.end(); }
});

test("a replacement INSERT failure rolls back the prior instance settlement in the same transaction", {
  skip: enabled ? false : "requires isolated scratch runtime runner", timeout: 120_000,
}, async () => {
  const repository = await import('../database/postgres/record-goal-authoring-repository.ts');
  const runtime = new pg.Pool({ connectionString: runtimeUrl!, max: 1 });
  try {
    const previous = definitionFixture();
    await withFixtureWrite((client) => repository.materializeRecordAuthoredGoal(client,
      { definition: previous, principalId: POSTGRES_DEMO_IDS.principal }));
    const replacement = planRecordGoalRevision({ previous, scope,
      instance: { goalInstanceId: previous.goalInstanceId, recordId: scope.recordId, state: 'active',
        revision: 1, progress: {}, outcome: null }, expectedDefinitionVersion: 1, expectedInstanceRevision: 1,
      nextDraft: { ...previous.draft, title: 'Rollback probe' }, reason: 'Test-only duplicate successor injection',
      events: [], evidenceEventIds: [], observedHead: previous.activationHead });
    const next = replacement.definition;
    await withFixtureWrite((client) => client.query(`INSERT INTO record_goal_definitions
      (workspace_id, world_id, worldline_id, record_id, id, goal_id, definition_version, goal_key, policy_version,
       definition, supersedes_definition_id, created_by_principal_id)
      VALUES ($1,$2,$3,$4,$5,$6,2,$7,$8,$9::jsonb,$10,$11)`, [scope.workspaceId, scope.worldId, scope.worldlineId,
      scope.recordId, next.definitionId, next.goalId, next.goalKey, next.policyVersion, JSON.stringify(next),
      previous.definitionId, POSTGRES_DEMO_IDS.principal]));
    await assert.rejects(withFixtureWrite((client) =>
      repository.appendRecordGoalReplacement(client, { replacement, principalId: POSTGRES_DEMO_IDS.principal })),
    { code: '23505' });
    const rows = await withWorkspaceTransaction(runtime, scope.workspaceId, (client) => client.query(
      `SELECT id, state, revision::text, resolution_kind, completed_at FROM goal_instances
       WHERE workspace_id = $1 AND id = ANY($2::text[])`, [scope.workspaceId, [previous.goalInstanceId, next.goalInstanceId]]));
    assert.deepEqual(rows.rows, [{ id: previous.goalInstanceId, state: 'active', revision: '1',
      resolution_kind: 'natural', completed_at: null }]);
  } finally { await runtime.end(); }
});

test("native Goal GET reads authored goals without installed content and never exposes hidden definitions", {
  skip: enabled ? false : "requires isolated scratch runtime runner", timeout: 120_000,
}, async () => {
  const repository = await import('../database/postgres/record-goal-authoring-repository.ts');
  const { GET } = await import('../app/api/record/goals/route.ts');
  const { createSessionValue } = await import('../modules/identity/auth.ts');
  const { endSharedRuntimePools } = await import('../app/api/world-scope.ts');
  const runtime = new pg.Pool({ connectionString: runtimeUrl!, max: 1 });
  const installRoot = process.env.REALM_GOAL_WORKER_INSTALL_ROOT;
  const trustStore = process.env.REALM_REALMWORLD_TRUST_STORE;
  delete process.env.REALM_GOAL_WORKER_INSTALL_ROOT;
  delete process.env.REALM_REALMWORLD_TRUST_STORE;
  try {
    const visible = definitionFixture();
    const hidden = createRecordGoalDefinition({ scope, goalId: `hidden-${randomUUID()}`,
      activationHead: { recordVersion: 0, ordinal: 0 }, draft: { ...visible.draft, title: 'HIDDEN-DEFINITION-PROBE', visible: false } });
    await withFixtureWrite(async (client) => {
      await repository.materializeRecordAuthoredGoal(client, { definition: visible, principalId: POSTGRES_DEMO_IDS.principal });
      await repository.materializeRecordAuthoredGoal(client, { definition: hidden, principalId: POSTGRES_DEMO_IDS.principal });
    });
    const response = await GET(new Request(`http://localhost/api/record/goals?recordId=${scope.recordId}`, {
      headers: { cookie: `realm_session=${createSessionValue(POSTGRES_DEMO_IDS.principal)}` },
    }));
    assert.equal(response.status, 200);
    const body = await response.json();
    const projected = body.goals.find((goal: { goalId?: string }) => goal.goalId === visible.goalId);
    assert.equal(projected.title, visible.draft.title);
    assert.equal(projected.source, 'record');
    assert.equal(projected.definitionVersion, 1);
    assert.deepEqual(projected.capabilities, { canRevise: false, canWithdraw: false });
    const serialized = JSON.stringify(body);
    for (const forbidden of ['HIDDEN-DEFINITION-PROBE', hidden.definitionId, 'rubric', 'basisEventIds', 'policyVersion']) {
      assert.equal(serialized.includes(forbidden), false);
    }
  } finally {
    if (installRoot === undefined) delete process.env.REALM_GOAL_WORKER_INSTALL_ROOT;
    else process.env.REALM_GOAL_WORKER_INSTALL_ROOT = installRoot;
    if (trustStore === undefined) delete process.env.REALM_REALMWORLD_TRUST_STORE;
    else process.env.REALM_REALMWORLD_TRUST_STORE = trustStore;
    await endSharedRuntimePools();
    await runtime.end();
  }
});

test("native Goal SSE uses the same authored definition projection without an installed package", {
  skip: enabled ? false : "requires isolated scratch runtime runner", timeout: 120_000,
}, async () => {
  const repository = await import('../database/postgres/record-goal-authoring-repository.ts');
  const { GET } = await import('../app/api/record/goals/events/route.ts');
  const { createSessionValue } = await import('../modules/identity/auth.ts');
  const { endSharedRuntimePools } = await import('../app/api/world-scope.ts');
  const runtime = new pg.Pool({ connectionString: runtimeUrl!, max: 1 });
  const controller = new AbortController();
  const installRoot = process.env.REALM_GOAL_WORKER_INSTALL_ROOT;
  const trustStore = process.env.REALM_REALMWORLD_TRUST_STORE;
  delete process.env.REALM_GOAL_WORKER_INSTALL_ROOT;
  delete process.env.REALM_REALMWORLD_TRUST_STORE;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const definition = definitionFixture();
    await withFixtureWrite((client) => repository.materializeRecordAuthoredGoal(client,
      { definition, principalId: POSTGRES_DEMO_IDS.principal }));
    const response = await GET(new Request(`http://localhost/api/record/goals/events?recordId=${scope.recordId}`, {
      signal: controller.signal, headers: { cookie: `realm_session=${createSessionValue(POSTGRES_DEMO_IDS.principal)}` },
    }));
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
    reader = response.body!.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    const text = new TextDecoder().decode(first.value);
    assert.match(text, /event: goal.projection/);
    const data = JSON.parse(text.split('\n').find((line) => line.startsWith('data: '))!.slice(6));
    const projected = data.goals.find((goal: { goalId?: string }) => goal.goalId === definition.goalId);
    assert.equal(projected.title, definition.draft.title);
    for (const forbidden of ['HIDDEN-DEFINITION-PROBE', 'rubric', 'basisEventIds', 'policyVersion']) {
      assert.equal(text.includes(forbidden), false);
    }
  } finally {
    controller.abort();
    if (reader) await reader.cancel();
    if (installRoot === undefined) delete process.env.REALM_GOAL_WORKER_INSTALL_ROOT;
    else process.env.REALM_GOAL_WORKER_INSTALL_ROOT = installRoot;
    if (trustStore === undefined) delete process.env.REALM_REALMWORLD_TRUST_STORE;
    else process.env.REALM_REALMWORLD_TRUST_STORE = trustStore;
    await endSharedRuntimePools();
    await runtime.end();
  }
});

test("native Goal GET and SSE reject unauthenticated, non-member and unknown Record reads", {
  skip: enabled ? false : "requires isolated scratch runtime runner", timeout: 120_000,
}, async () => {
  const { GET: get } = await import('../app/api/record/goals/route.ts');
  const { GET: stream } = await import('../app/api/record/goals/events/route.ts');
  const { createSessionValue, principalIdForDisplayName } = await import('../modules/identity/auth.ts');
  const { endSharedRuntimePools } = await import('../app/api/world-scope.ts');
  try {
    for (const [path, handler] of [['goals', get], ['goals/events', stream]] as const) {
      for (const scenario of [
        { recordId: scope.recordId, cookie: '', status: 401 },
        { recordId: scope.recordId, cookie: `realm_session=${createSessionValue(principalIdForDisplayName(`stranger-${randomUUID()}`))}`, status: 404 },
        { recordId: `missing-${randomUUID()}`, cookie: `realm_session=${createSessionValue(POSTGRES_DEMO_IDS.principal)}`, status: 404 },
      ]) {
        const response = await handler(new Request(`http://localhost/api/record/${path}?recordId=${scenario.recordId}`, {
          headers: { cookie: scenario.cookie },
        }));
        assert.equal(response.status, scenario.status, `${path}: ${scenario.status}`);
        const body = await response.json();
        assert.equal(body.ok, false);
        assert.equal('goals' in body, false);
      }
    }
  } finally { await endSharedRuntimePools(); }
});

test("Goal content projection follows the Record's pinned world version rather than an updated World", {
  skip: enabled ? false : "requires isolated scratch runtime runner", timeout: 120_000,
}, async () => {
  const { createPostgresGoalProjectionRepository } = await import('../database/postgres/goal-projection-repository.ts');
  const ownerPool = new pg.Pool({ connectionString: ownerUrl!, max: 1 });
  try {
    await withWorkspaceTransaction(ownerPool, scope.workspaceId, async (client) => {
      const before = await client.query<{ world_version: string }>(
        `SELECT world_version FROM records WHERE workspace_id = $1 AND id = $2`, [scope.workspaceId, scope.recordId]);
      const original = await client.query<{ world_version: string }>(
        `SELECT world_version FROM worlds WHERE workspace_id = $1 AND id = $2`, [scope.workspaceId, scope.worldId]);
      assert.notEqual(before.rows[0]!.world_version, '9.9.9');
      await client.query(`UPDATE worlds SET world_version = '9.9.9' WHERE workspace_id = $1 AND id = $2`,
        [scope.workspaceId, scope.worldId]);
      const projection = await createPostgresGoalProjectionRepository(client).load({ workspaceId: scope.workspaceId, recordId: scope.recordId });
      assert.equal(projection.worldVersion, before.rows[0]!.world_version);
      await client.query(`UPDATE worlds SET world_version = $3 WHERE workspace_id = $1 AND id = $2`,
        [scope.workspaceId, scope.worldId, original.rows[0]!.world_version]);
    });
  } finally { await ownerPool.end(); }
});
