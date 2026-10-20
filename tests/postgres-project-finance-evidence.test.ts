import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

import { POST as projectCommandPOST } from "../app/api/bridge/v1/projects/commands/route.ts";
import { endSharedRuntimePools } from "../app/api/world-scope.ts";
import { createPostgresProjectFinanceCommandStore } from "../database/postgres/project-finance-command-repository.ts";
import {
  createProjectFinanceCommandService,
  ProjectFinanceCommandError,
} from "../modules/application/project-finance-command.ts";
import { createSessionValue } from "../modules/identity/auth.ts";

const adminConnectionString = process.env.DATABASE_URL;
const runtimeConnectionString = process.env.REALM_RUNTIME_DATABASE_URL;
const skipReason = "requires the isolated PostgreSQL runtime runner";
const SCOPE = {
  workspaceId: "ws_demo",
  worldId: "world_ember_coast",
  worldlineId: "worldline_origin",
} as const;

test(
  "stage, evidenced ledger, combined rollback, and obligations read back from PostgreSQL",
  { skip: !adminConnectionString || !runtimeConnectionString ? skipReason : false, timeout: 120_000 },
  async (t) => {
    const admin = new pg.Pool({ connectionString: adminConnectionString!, max: 1 });
    const runtime = new pg.Pool({ connectionString: runtimeConnectionString!, max: 1 });
    const suffix = randomUUID().replaceAll("-", "");
    const storyId = `story_evidence_${suffix}`;
    const recordId = `record_evidence_${suffix}`;
    const sceneId = `scene_evidence_${suffix}`;
    const policyId = `policy_evidence_${suffix}`;
    const accountId = `account_evidence_${suffix}`;
    const projectId = `project_evidence_${suffix}`;
    const milestoneId = `milestone_evidence_${suffix}`;
    const stageKey = `stage_${suffix}`;
    const expenseKey = `expense_evidence_${suffix}`;
    const plainKey = `expense_plain_${suffix}`;
    const applyKey = `apply_${suffix}`;
    const loanKey = `loan_${suffix}`;
    const repayKey = `repay_${suffix}`;
    const originalHead = await admin.query<{ head_tick: string; head_ordinal: string }>(
      `SELECT head_tick::text, head_ordinal::text
       FROM worldlines
       WHERE workspace_id = $1 AND world_id = $2 AND id = $3`,
      [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId],
    );
    const savedTick = originalHead.rows[0]?.head_tick;
    const savedOrdinal = originalHead.rows[0]?.head_ordinal;
    assert.ok(savedTick !== undefined && savedOrdinal !== undefined);

    t.after(async () => {
      await endSharedRuntimePools();
      const cleanup = await admin.connect();
      try {
        await cleanup.query("BEGIN");
        await cleanup.query("SET LOCAL session_replication_role = replica");
        await cleanup.query(
          `UPDATE worldlines
           SET head_tick = $4, head_ordinal = $5
           WHERE workspace_id = $1 AND world_id = $2 AND id = $3`,
          [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, savedTick, savedOrdinal],
        );
        await cleanup.query(
          `DELETE FROM events
           WHERE workspace_id = $1 AND record_id = $2`,
          [SCOPE.workspaceId, recordId],
        );
        await cleanup.query(
          `DELETE FROM record_heads WHERE workspace_id = $1 AND record_id = $2`,
          [SCOPE.workspaceId, recordId],
        );
        await cleanup.query(
          `DELETE FROM visibility_policies WHERE workspace_id = $1 AND id = $2`,
          [SCOPE.workspaceId, policyId],
        );
        await cleanup.query(
          `DELETE FROM scenes WHERE workspace_id = $1 AND id = $2`,
          [SCOPE.workspaceId, sceneId],
        );
        await cleanup.query(
          `DELETE FROM obligation_settlements
           WHERE workspace_id = $1 AND obligation_id IN (
             SELECT id FROM obligations WHERE workspace_id = $1 AND project_id = $2
           )`,
          [SCOPE.workspaceId, projectId],
        );
        await cleanup.query(
          `DELETE FROM obligations WHERE workspace_id = $1 AND project_id = $2`,
          [SCOPE.workspaceId, projectId],
        );
        await cleanup.query(
          `DELETE FROM project_finance_command_groups
           WHERE workspace_id = $1 AND worldline_id = $2
             AND idempotency_key = ANY($3::text[])`,
          [SCOPE.workspaceId, SCOPE.worldlineId, [stageKey, expenseKey, plainKey, applyKey, loanKey, repayKey]],
        );
        await cleanup.query(
          `DELETE FROM ledger_entries
           WHERE workspace_id = $1 AND account_id = $2`,
          [SCOPE.workspaceId, accountId],
        );
        await cleanup.query(
          `DELETE FROM records WHERE workspace_id = $1 AND id = $2`,
          [SCOPE.workspaceId, recordId],
        );
        await cleanup.query(
          `DELETE FROM stories WHERE workspace_id = $1 AND id = $2`,
          [SCOPE.workspaceId, storyId],
        );
        await cleanup.query(
          `DELETE FROM project_milestones WHERE workspace_id = $1 AND id = $2`,
          [SCOPE.workspaceId, milestoneId],
        );
        await cleanup.query(
          `DELETE FROM projects WHERE workspace_id = $1 AND id = $2`,
          [SCOPE.workspaceId, projectId],
        );
        await cleanup.query(
          `DELETE FROM finance_accounts WHERE workspace_id = $1 AND id = $2`,
          [SCOPE.workspaceId, accountId],
        );
        await cleanup.query("COMMIT");
      } catch (error) {
        await cleanup.query("ROLLBACK");
        throw error;
      } finally {
        cleanup.release();
      }
      await Promise.all([admin.end(), runtime.end()]);
    });

    await admin.query(
      `INSERT INTO stories (
         workspace_id, world_id, worldline_id, id, title, status, premise, start_tick, start_ordinal
       ) VALUES ($1, $2, $3, $4, 'Evidence story', 'active', '', 0, 0)`,
      [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, storyId],
    );
    await admin.query(
      `INSERT INTO records (
         workspace_id, world_id, worldline_id, story_id, id, title, status, start_tick, start_ordinal
       ) VALUES ($1, $2, $3, $4, $5, 'Evidence record', 'active', 0, 0)`,
      [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, storyId, recordId],
    );
    await admin.query(
      `INSERT INTO scenes (
         workspace_id, world_id, worldline_id, record_id, id, title, status,
         location, objective, start_tick, start_ordinal
       ) VALUES ($1, $2, $3, $4, $5, 'Evidence scene', 'active', '', '', 0, 0)`,
      [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, recordId, sceneId],
    );
    await admin.query(
      `INSERT INTO visibility_policies (
         workspace_id, world_id, worldline_id, record_id, id, policy_key, policy_version, policy_kind
       ) VALUES ($1, $2, $3, $4, $5, 'public', 1, 'public')`,
      [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, recordId, policyId],
    );
    await admin.query(
      `INSERT INTO record_heads (
         workspace_id, world_id, worldline_id, record_id, record_version, next_record_ordinal
       ) VALUES ($1, $2, $3, $4, 0, 0)`,
      [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, recordId],
    );
    await admin.query(
      `INSERT INTO finance_accounts (
         workspace_id, world_id, worldline_id, id, currency, status, opening_balance_minor
       ) VALUES ($1, $2, $3, $4, 'JPY', 'active', 100000)`,
      [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, accountId],
    );
    await admin.query(
      `INSERT INTO projects (
         workspace_id, world_id, worldline_id, id, kind, status, stage, title, currency, version
       ) VALUES ($1, $2, $3, $4, 'production', 'active', 'planning', 'Evidence project', 'JPY', 1)`,
      [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, projectId],
    );
    await admin.query(
      `INSERT INTO project_milestones (
         workspace_id, world_id, worldline_id, id, project_id, sequence, title, status
       ) VALUES ($1, $2, $3, $4, $5, 1, 'Rehearsal', 'active')`,
      [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, milestoneId, projectId],
    );

    const service = createProjectFinanceCommandService({
      store: createPostgresProjectFinanceCommandStore(runtime),
    });
    const staged = await service.changeStage({
      scope: SCOPE,
      projectId,
      stage: "funding",
      expectedProjectVersion: 1,
      idempotencyKey: stageKey,
    });
    assert.equal(staged.projectVersion, 2);
    assert.equal(staged.worldCursor ?? null, null);
    const stageRow = await admin.query<{ stage: string; version: string }>(
      `SELECT stage, version::text FROM projects WHERE workspace_id = $1 AND id = $2`,
      [SCOPE.workspaceId, projectId],
    );
    assert.equal(stageRow.rows[0]?.stage, "funding");
    assert.equal(stageRow.rows[0]?.version, "2");
    const stageReplay = await service.changeStage({
      scope: SCOPE,
      projectId,
      stage: "funding",
      expectedProjectVersion: 1,
      idempotencyKey: stageKey,
    });
    assert.equal(stageReplay.status, "replayed");
    const stageAfterReplay = await admin.query<{ version: string }>(
      `SELECT version::text FROM projects WHERE workspace_id = $1 AND id = $2`,
      [SCOPE.workspaceId, projectId],
    );
    assert.equal(stageAfterReplay.rows[0]?.version, "2");

    const headBeforeEvent = await admin.query<{ head_tick: string; head_ordinal: string }>(
      `SELECT head_tick::text, head_ordinal::text
       FROM worldlines
       WHERE workspace_id = $1 AND id = $2`,
      [SCOPE.workspaceId, SCOPE.worldlineId],
    );
    const evidence = {
      recordId,
      sceneId,
      visibility: "public" as const,
      expectedWorldCursor: {
        worldTick: Number(headBeforeEvent.rows[0]?.head_tick),
        worldOrdinal: Number(headBeforeEvent.rows[0]?.head_ordinal),
      },
    };
    const evidenced = await service.recordExpense({
      scope: SCOPE,
      accountId,
      amountMinor: 1_000,
      category: "venue",
      memo: "Evidenced deposit",
      occurredAt: "2026-10-16T00:00:00.000Z",
      idempotencyKey: expenseKey,
      expectedBalanceMinor: 100_000,
      evidence,
    });
    assert.equal(evidenced.status, "committed");
    assert.equal(evidenced.worldCursor?.worldOrdinal, evidence.expectedWorldCursor.worldOrdinal + 1);
    const evidencedReplay = await service.recordExpense({
      scope: SCOPE,
      accountId,
      amountMinor: 1_000,
      category: "venue",
      memo: "Evidenced deposit",
      occurredAt: "2026-10-16T00:00:00.000Z",
      idempotencyKey: expenseKey,
      expectedBalanceMinor: 100_000,
      evidence,
    });
    assert.equal(evidencedReplay.status, "replayed");
    const eventCount = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM events
       WHERE workspace_id = $1 AND record_id = $2 AND event_kind = 'finance.expense.recorded'`,
      [SCOPE.workspaceId, recordId],
    );
    assert.equal(eventCount.rows[0]?.n, 1);
    const ledgerCount = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ledger_entries WHERE workspace_id = $1 AND account_id = $2`,
      [SCOPE.workspaceId, accountId],
    );
    assert.equal(ledgerCount.rows[0]?.n, 1);

    await service.recordExpense({
      scope: SCOPE,
      accountId,
      amountMinor: 500,
      category: "venue",
      memo: "Operator only",
      occurredAt: "2026-10-16T01:00:00.000Z",
      idempotencyKey: plainKey,
      expectedBalanceMinor: 99_000,
    });
    const eventsAfterPlain = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM events WHERE workspace_id = $1 AND record_id = $2`,
      [SCOPE.workspaceId, recordId],
    );
    assert.equal(eventsAfterPlain.rows[0]?.n, 1);

    const cookie = `realm_session=${createSessionValue("principal_demo_player")}`;
    const partial = await projectCommandPOST(new Request(
      `http://localhost/api/bridge/v1/projects/commands?worldId=${SCOPE.worldId}`,
      {
        method: "POST",
        headers: {
          cookie,
          "content-type": "application/json",
          "idempotency-key": `partial_${suffix}`,
        },
        body: JSON.stringify({
          command: "change_stage",
          projectId,
          stage: "production",
          expectedProjectVersion: 2,
          recordId,
          sceneId,
        }),
      },
    ));
    assert.equal(partial.status, 422);
    const eventsAfterPartial = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM events WHERE workspace_id = $1 AND record_id = $2`,
      [SCOPE.workspaceId, recordId],
    );
    assert.equal(eventsAfterPartial.rows[0]?.n, 1);

    const headBeforeApply = await admin.query<{ head_tick: string; head_ordinal: string }>(
      `SELECT head_tick::text, head_ordinal::text
       FROM worldlines WHERE workspace_id = $1 AND id = $2`,
      [SCOPE.workspaceId, SCOPE.worldlineId],
    );
    await assert.rejects(
      service.applyRecordProjectFinance({
        scope: SCOPE,
        idempotencyKey: applyKey,
        evidence: {
          recordId,
          sceneId,
          visibility: "public",
          expectedWorldCursor: {
            worldTick: Number(headBeforeApply.rows[0]?.head_tick),
            worldOrdinal: Number(headBeforeApply.rows[0]?.head_ordinal),
          },
        },
        actions: [
          {
            command: "confirm_milestone",
            projectId,
            milestoneId,
            expectedProjectVersion: 2,
          },
          {
            command: "record_expense",
            accountId,
            amountMinor: 200_000,
            category: "venue",
            memo: "Too expensive",
            occurredAt: "2026-10-16T02:00:00.000Z",
            expectedBalanceMinor: 98_500,
          },
        ],
      }),
      (error: unknown) => error instanceof ProjectFinanceCommandError && error.code === "INSUFFICIENT_FUNDS",
    );
    const milestone = await admin.query<{ status: string }>(
      `SELECT status FROM project_milestones WHERE workspace_id = $1 AND id = $2`,
      [SCOPE.workspaceId, milestoneId],
    );
    assert.equal(milestone.rows[0]?.status, "active");
    const headAfterReject = await admin.query<{ head_tick: string; head_ordinal: string }>(
      `SELECT head_tick::text, head_ordinal::text
       FROM worldlines WHERE workspace_id = $1 AND id = $2`,
      [SCOPE.workspaceId, SCOPE.worldlineId],
    );
    assert.deepEqual(headAfterReject.rows[0], headBeforeApply.rows[0]);
    const ledgerAfterReject = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ledger_entries WHERE workspace_id = $1 AND account_id = $2`,
      [SCOPE.workspaceId, accountId],
    );
    assert.equal(ledgerAfterReject.rows[0]?.n, 2);

    const created = await service.createObligation({
      scope: SCOPE,
      idempotencyKey: loanKey,
      projectId,
      kind: "loan",
      principalMinor: 200_000,
    });
    assert.equal(created.outstandingMinor, 200_000);
    const ledgerAfterLoan = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ledger_entries WHERE workspace_id = $1 AND account_id = $2`,
      [SCOPE.workspaceId, accountId],
    );
    assert.equal(ledgerAfterLoan.rows[0]?.n, 2);
    await assert.rejects(
      service.settleObligation({
        scope: SCOPE,
        idempotencyKey: repayKey,
        obligationId: created.obligationId,
        settlementKind: "repayment",
        amountMinor: 150_000,
        expectedOutstandingMinor: 200_000,
        expectedBalanceMinor: 98_500,
        accountId,
        category: "loan",
        memo: "Too big",
        occurredAt: "2026-10-16T03:00:00.000Z",
      }),
      (error: unknown) => error instanceof ProjectFinanceCommandError && error.code === "INSUFFICIENT_FUNDS",
    );
    const outstanding = await admin.query<{ outstanding_minor: string; settlements: number }>(
      `SELECT obligation.outstanding_minor::text,
              (SELECT count(*)::int FROM obligation_settlements AS settlement
               WHERE settlement.workspace_id = obligation.workspace_id
                 AND settlement.obligation_id = obligation.id) AS settlements
       FROM obligations AS obligation
       WHERE obligation.workspace_id = $1 AND obligation.id = $2`,
      [SCOPE.workspaceId, created.obligationId],
    );
    assert.equal(outstanding.rows[0]?.outstanding_minor, "200000");
    assert.equal(outstanding.rows[0]?.settlements, 0);
  },
);

// A2 execution belongs exclusively to the parent's disposable PG runner.
// This writer authors and syntax/typechecks this control; it never invokes it.
test("A2 signed install rollback, immutable map constraints, runtime ACL/RLS, backend barriers and two generations", {
  skip: !adminConnectionString || !runtimeConnectionString ? skipReason : false, timeout: 300_000,
}, async t => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const { generateKeyPairSync, verify } = await import("node:crypto");
  const { installSignedRealmWorldFixture, syntheticCommandPolicyFixture } = await import("./helpers/realmworld-package-fixture.ts");
  const { installTestSessionSecret, seedCapabilitySessionKey, sessionProofFor } = await import("./helpers/session-proof.ts");
  const { createInstalledRealmWorldCommandPolicyResolver } = await import("../modules/world-transfer/realmworld-command-policy.ts");
  const { createInstalledRealmWorldInstantiationResolver } = await import("../modules/world-transfer/realmworld-runtime-content.ts");
  const { serializeRealmWorldManifestSigningPayload } = await import("../modules/world-transfer/realmworld-manifest.ts");
  const { createPostgresLibraryService } = await import("../modules/application/library-service.ts");
  const { withWorkspaceTransaction } = await import("../database/postgres/workspace-transaction.ts");
  const { authorizeProjectFinanceWrite } = await import("../app/api/bridge/v1/project-finance-context.ts");
  const { createPostgresRealmRuntimeSaveReader, createPostgresRealmRuntimeSaveRestorer } = await import("../database/postgres/realm-runtime-save-repository.ts");
  const { buildRealmRuntimeSaveArchive, parseRealmRuntimeSaveArchive } = await import("../modules/world-transfer/realm-runtime-save.ts");
  installTestSessionSecret();
  const owner = new pg.Pool({ connectionString: adminConnectionString!, max: 4 });
  const runtime = new pg.Pool({ connectionString: runtimeConnectionString!, max: 3 });
  const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
  const workspaceIds = [`ws_a2_a_${suffix}`, `ws_a2_b_${suffix}`], principalId = `principal_a2_${suffix}`, worldId = `world_a2_${suffix}`;
  const resources: { directory?: string } = {};
  const oldOperator = process.env.REALM_OPERATOR_PRINCIPALS;
  t.after(async () => {
    // Immutable Event history belongs to this disposable cluster. Do not DELETE
    // its workspace or bypass append-only guards to manufacture row cleanup.
    if (oldOperator === undefined) delete process.env.REALM_OPERATOR_PRINCIPALS; else process.env.REALM_OPERATOR_PRINCIPALS = oldOperator;
    const closed = await Promise.allSettled([
      runtime.end(), owner.end(),
      resources.directory ? rm(resources.directory, { recursive: true, force: true }) : Promise.resolve(),
    ]);
    const failures = closed.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), "A2 fixture resource shutdown failed");
  });
  const directory = await mkdtemp(join(tmpdir(), "a2-pg-signed-"));
  resources.directory = directory;
  process.env.REALM_OPERATOR_PRINCIPALS = principalId;
  const provisionWorkspace = async (workspaceId: string) => {
    await owner.query(`INSERT INTO workspaces (id,name) VALUES ($1,'A2 isolated workspace')`, [workspaceId]);
    await owner.query(`INSERT INTO accounts (workspace_id,principal_id,display_name) VALUES ($1,$2,'A2 owner')`, [workspaceId, principalId]);
    await seedCapabilitySessionKey(owner, workspaceId);
  };
  const freshWorkspace = async (label: string) => {
    const workspaceId = `ws_a2_${label}_${suffix}`;
    workspaceIds.push(workspaceId);
    await provisionWorkspace(workspaceId);
    assert.equal((await owner.query(`SELECT count(*)::int AS n FROM player_world_memberships WHERE workspace_id=$1 AND world_id=$2`, [workspaceId, worldId])).rows[0].n, 0);
    return workspaceId;
  };
  for (const workspaceId of workspaceIds) await provisionWorkspace(workspaceId);
  assert.equal((await runtime.query(`SELECT current_user AS role`)).rows[0].role, "realm_runtime");
  const pair = generateKeyPairSync("ed25519");
  await installSignedRealmWorldFixture({ installRoot: directory, worldId, version: "1.2.0", recordTitle: "record_literal_source_id", sceneObjective: "project_literal_source_id", commandPolicy: syntheticCommandPolicyFixture(), declaredEvents: ["synthetic.ready"], keyId: "a2-pg-fixture", keyPair: { privateKey: pair.privateKey, publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString() } });
  const verifier = { installRoot: directory, verifySignature: ({ manifest }: { manifest: import("../modules/world-transfer/realmworld-manifest.ts").RealmWorldManifestV1 }) => verify(null, Buffer.from(serializeRealmWorldManifestSigningPayload(manifest)), pair.publicKey, Buffer.from(manifest.signature.value, "base64url")) };
  const resolveCommandPolicy = createInstalledRealmWorldCommandPolicyResolver(verifier);
  const plan = (await createInstalledRealmWorldInstantiationResolver({ ...verifier, locale: "en" })({ kind: "world", worldId, worldVersion: "1.2.0" }))!;
  const policy = (await resolveCommandPolicy(plan.binding))!;
  const library = createPostgresLibraryService(runtime, undefined, { resolveCommandPolicy });
  const scopeFor = (workspaceId: string) => ({ workspaceId, principalId, sessionProof: sessionProofFor(principalId) });
  const [workspaceA, workspaceB] = workspaceIds as [string, string];
  const source = await library.instantiateRealmWorld(scopeFor(workspaceA), plan, "a2-source");
  const other = await library.instantiateRealmWorld(scopeFor(workspaceB), plan, "a2-target-context");
  const sourceScope = { workspaceId: workspaceA, worldId, worldlineId: source.worldlineId };
  const readMap = async (workspaceId: string, worldlineId: string) => (await owner.query(`SELECT * FROM realmworld_command_materializations WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 ORDER BY milestone_key DESC`, [workspaceId, worldId, worldlineId])).rows;
  const sourceMap = await readMap(workspaceA, source.worldlineId); assert.equal(sourceMap.length, 2);
  assert.equal((await library.instantiateRealmWorld(scopeFor(workspaceA), plan, "a2-source")).replayed, true);
  assert.deepEqual(await readMap(workspaceA, source.worldlineId), sourceMap);
  for (const row of sourceMap) { assert.equal(row.content_hash, policy.contentHash); assert.equal(row.record_id, source.recordId); assert.equal(row.story_id, source.storyId); }
  await t.test("command policy lock helper keeps restricted ACL, RLS and qualified namespace", async () => {
    const catalog = (await owner.query(`SELECT p.prosecdef, p.proconfig, r.rolname, r.rolcanlogin, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolinherit,
      pg_has_role('realm_runtime', r.oid, 'MEMBER') AS runtime_member,
      EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute
      FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner
      WHERE p.oid='public.command_policy_record_version_locked(text,text,text,text,text,text)'::regprocedure`)).rows[0];
    assert.deepEqual(catalog, { prosecdef: true, proconfig: ["search_path=pg_catalog, pg_temp", "row_security=on"], rolname: "realm_command_policy_locker",
      rolcanlogin: false, rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolinherit: false, runtime_member: false, public_execute: false });
    assert.equal((await owner.query(`SELECT has_any_column_privilege('realm_runtime','public.stories','UPDATE') AS writable`)).rows[0].writable, false);
    const { readFile } = await import("node:fs/promises");
    const migration = await readFile(new URL("../database/postgres/migrations/0081_command_policy_record_lock.sql", import.meta.url), "utf8");
    const roleEnd = migration.indexOf("$policy_lock_role$;") + "$policy_lock_role$;".length;
    assert.ok(roleEnd > "$policy_lock_role$;".length);
    const roleSQL = migration.slice(0, roleEnd);
    const roleCheck = await owner.connect();
    try {
      await roleCheck.query("BEGIN");
      await roleCheck.query(roleSQL); // Safe reuse of a cluster-wide role.
      for (const poison of ["ALTER ROLE realm_command_policy_locker BYPASSRLS",
        "COMMENT ON ROLE realm_command_policy_locker IS 'untrusted'",
        "GRANT realm_command_policy_locker TO realm_runtime"]) {
        await roleCheck.query("SAVEPOINT helper_role_guard");
        await roleCheck.query(poison);
        await assert.rejects(roleCheck.query(roleSQL), { code: "P0001", message: "COMMAND_POLICY_LOCK_ROLE_UNSAFE" });
        await roleCheck.query("ROLLBACK TO SAVEPOINT helper_role_guard");
      }
    } finally { await roleCheck.query("ROLLBACK"); roleCheck.release(); }
    const row = sourceMap[0]!;
    const args = [workspaceA, worldId, source.worldlineId, source.recordId, source.storyId, row.project_id];
    const sql = "SELECT world_version FROM public.command_policy_record_version_locked($1, $2, $3, $4, $5, $6)";
    await withWorkspaceTransaction(runtime, workspaceA, async client => {
      await client.query("SAVEPOINT helper_temp_acl");
      await assert.rejects(client.query("CREATE TEMP TABLE records (world_version text) ON COMMIT DROP"), { code: "42501" });
      await client.query("ROLLBACK TO SAVEPOINT helper_temp_acl");
      await client.query("SET LOCAL search_path = pg_temp, public");
      assert.deepEqual((await client.query(sql, args)).rows, [{ world_version: "1.2.0" }]);
      for (const [index, value] of [[1, "wrong_world"], [2, other.worldlineId], [3, other.recordId], [4, other.storyId], [5, "wrong_project"]] as const) {
        const wrong = [...args]; wrong[index] = value;
        assert.deepEqual((await client.query(sql, wrong)).rows, []);
      }
      await client.query("SAVEPOINT helper_acl");
      await assert.rejects(client.query("SET LOCAL ROLE realm_command_policy_locker"), { code: "42501" });
      await client.query("ROLLBACK TO SAVEPOINT helper_acl");
      await assert.rejects(client.query("UPDATE public.stories SET updated_at = CURRENT_TIMESTAMP WHERE false"), { code: "42501" });
      await client.query("ROLLBACK TO SAVEPOINT helper_acl");
    });
    // Prepare hostile temp objects only as fixture owner, then exercise the helper
    // with current_user=realm_runtime. Production runtime retains no TEMP grant.
    const shadow = await owner.connect();
    try {
      await shadow.query("BEGIN");
      await shadow.query("CREATE TEMP TABLE records (world_version text) ON COMMIT DROP");
      await shadow.query("INSERT INTO pg_temp.records VALUES ('forged')");
      await shadow.query("CREATE TEMP TABLE stories (status text) ON COMMIT DROP");
      await shadow.query("CREATE TEMP TABLE project_story_links (link_kind text) ON COMMIT DROP");
      await shadow.query("GRANT SELECT ON pg_temp.records TO realm_runtime");
      await shadow.query("SET LOCAL ROLE realm_runtime");
      await shadow.query("SELECT set_config('realm.workspace_id', $1, true)", [workspaceA]);
      await shadow.query("SET LOCAL search_path = pg_temp, public");
      assert.equal((await shadow.query("SELECT current_user AS role")).rows[0].role, "realm_runtime");
      assert.deepEqual((await shadow.query("SELECT world_version FROM pg_temp.records")).rows, [{ world_version: "forged" }]);
      assert.deepEqual((await shadow.query(sql, args)).rows, [{ world_version: "1.2.0" }]);
    } finally { await shadow.query("ROLLBACK"); shadow.release(); }
    await withWorkspaceTransaction(runtime, workspaceB, async client => {
      await client.query("SAVEPOINT helper_scope");
      await assert.rejects(client.query(sql, args), { code: "P0001", message: "WORKSPACE_SCOPE_MISMATCH" });
      await client.query("ROLLBACK TO SAVEPOINT helper_scope");
    });
  });
  const counts = async (workspaceId = workspaceA) => {
    const result: Record<string, number> = {};
    for (const table of ["worlds", "worldlines", "stories", "records", "record_heads", "projects", "project_milestones", "project_story_links", "realmworld_command_materializations", "events", "project_finance_command_groups", "character_instances", "character_continuities"]) result[table] = (await owner.query(`SELECT count(*)::int AS n FROM ${table} WHERE workspace_id=$1`, [workspaceId])).rows[0].n as number;
    return result;
  };
  const helperSQL = "SELECT world_version FROM public.command_policy_record_version_locked($1, $2, $3, $4, $5, $6)";
  const helperArgs = [workspaceA, worldId, source.worldlineId, source.recordId, source.storyId, sourceMap[0]!.project_id];
  const helperCatalog = async () => (await owner.query(`SELECT p.oid::text,p.proowner::text,p.prosecdef,p.proconfig,p.proacl::text,pg_get_functiondef(p.oid) AS definition,obj_description(p.oid,'pg_proc') AS description FROM pg_proc p WHERE p.oid='public.command_policy_record_version_locked(text,text,text,text,text,text)'::regprocedure`)).rows;
  const helperPrivileges = async () => (await owner.query(`SELECT c.relname,a.attname,
    has_column_privilege('realm_command_policy_locker',c.oid,a.attnum,'SELECT') AS helper_select,
    has_column_privilege('realm_command_policy_locker',c.oid,a.attnum,'UPDATE') AS helper_update,
    has_column_privilege('realm_runtime',c.oid,a.attnum,'SELECT') AS runtime_select,
    has_column_privilege('realm_runtime',c.oid,a.attnum,'UPDATE') AS runtime_update
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
    WHERE n.nspname='public' AND c.relname=ANY($1::text[]) AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum`, [["records", "stories", "project_story_links"]])).rows;
  await t.test("helper fresh runtime backend rejects unset/empty GUC and NULL/empty workspace argument without mutation", async () => {
    const before = await counts(), catalog = await helperCatalog();
    const client = new pg.Client({ connectionString: runtimeConnectionString! });
    try {
      await client.connect();
      assert.equal((await client.query("SELECT current_user AS role")).rows[0].role, "realm_runtime");
      assert.equal((await client.query("SELECT current_setting('realm.workspace_id',true) AS scope")).rows[0].scope, null, "fresh backend is genuinely unset, not an empty setting left by a pooled transaction");
      for (const form of ["unset", "empty-guc", "null-argument", "empty-argument"] as const) {
        await client.query("BEGIN");
        if (form !== "unset") await client.query("SELECT set_config('realm.workspace_id',$1,true)", [form === "empty-guc" ? "" : workspaceA]);
        const settings = (await client.query("SELECT current_user AS role,current_setting('search_path') AS path,current_setting('row_security') AS rls,current_setting('realm.workspace_id',true) AS scope")).rows;
        assert.equal(settings[0].scope, form === "unset" ? null : form === "empty-guc" ? "" : workspaceA);
        const args = [...helperArgs]; if (form === "null-argument") args[0] = null; if (form === "empty-argument") args[0] = "";
        await client.query("SAVEPOINT a2_helper_empty_scope");
        await assert.rejects(client.query(helperSQL, args), { code: "P0001", message: "WORKSPACE_SCOPE_MISMATCH" });
        await client.query("ROLLBACK TO SAVEPOINT a2_helper_empty_scope");
        assert.deepEqual((await client.query("SELECT current_user AS role,current_setting('search_path') AS path,current_setting('row_security') AS rls,current_setting('realm.workspace_id',true) AS scope")).rows, settings);
        await client.query("ROLLBACK");
      }
      await client.query("BEGIN"); await client.query("SELECT set_config('realm.workspace_id',$1,true)", [workspaceA]);
      assert.deepEqual((await client.query(helperSQL, helperArgs)).rows, [{ world_version: "1.2.0" }]);
      await client.query("ROLLBACK");
    } finally { try { await client.query("ROLLBACK"); } finally { await client.end(); } }
    assert.deepEqual(await counts(), before); assert.deepEqual(await helperCatalog(), catalog);
  });
  await t.test("PUBLIC-only role cannot execute helper despite proven schema usage and valid tuple", async () => {
    const catalog = await helperCatalog(), before = await counts(), probe = `a2_public_probe_${suffix}`;
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query(`CREATE ROLE ${probe} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
      await client.query(`GRANT USAGE ON SCHEMA public TO ${probe}`);
      await client.query("SELECT set_config('realm.workspace_id',$1,true)", [workspaceA]);
      await client.query(`SET LOCAL ROLE ${probe}`);
      assert.equal((await client.query("SELECT current_user AS role")).rows[0].role, probe);
      assert.deepEqual((await client.query(`SELECT has_schema_privilege(current_user,'public','USAGE') AS schema_usage,
        has_function_privilege(current_user,'public.command_policy_record_version_locked(text,text,text,text,text,text)','EXECUTE') AS execute,
        pg_has_role(current_user,'realm_runtime','MEMBER') AS runtime_member,pg_has_role(current_user,'realm_command_policy_locker','MEMBER') AS locker_member`)).rows,
      [{ schema_usage: true, execute: false, runtime_member: false, locker_member: false }]);
      await assert.rejects(client.query(helperSQL, helperArgs), { code: "42501" });
    } finally { try { await client.query("ROLLBACK"); } finally { client.release(); } }
    assert.deepEqual((await owner.query("SELECT rolname FROM pg_roles WHERE rolname=$1", [probe])).rows, []);
    assert.deepEqual(await helperCatalog(), catalog); assert.deepEqual(await counts(), before);
  });
  await t.test("runtime cannot replace/drop/alter helper or acquire its owner and cannot propagate EXECUTE", async () => {
    const catalog = await helperCatalog(), privileges = await helperPrivileges(), before = await counts();
    assert.deepEqual((await owner.query("SELECT has_schema_privilege('realm_runtime','public','CREATE') AS runtime_create,has_schema_privilege('realm_command_policy_locker','public','CREATE') AS helper_create")).rows, [{ runtime_create: false, helper_create: false }]);
    await withWorkspaceTransaction(runtime, workspaceA, async client => {
      assert.equal((await client.query("SELECT current_user AS role")).rows[0].role, "realm_runtime");
      const deniedStatements = [
        "CREATE OR REPLACE FUNCTION public.command_policy_record_version_locked(p_workspace_id text,p_world_id text,p_worldline_id text,p_record_id text,p_story_id text,p_project_id text) RETURNS TABLE(world_version text) LANGUAGE sql AS $$ SELECT 'forged'::text $$",
        "DROP FUNCTION public.command_policy_record_version_locked(text,text,text,text,text,text)",
        "ALTER FUNCTION public.command_policy_record_version_locked(text,text,text,text,text,text) SECURITY INVOKER",
        "ALTER FUNCTION public.command_policy_record_version_locked(text,text,text,text,text,text) OWNER TO realm_runtime",
        "ALTER FUNCTION public.command_policy_record_version_locked(text,text,text,text,text,text) SET search_path = public",
        "ALTER ROLE realm_command_policy_locker BYPASSRLS",
        "GRANT realm_command_policy_locker TO realm_runtime",
      ];
      for (const sql of deniedStatements) {
        await client.query("SAVEPOINT a2_helper_ownership");
        await assert.rejects(client.query(sql), { code: "42501" });
        await client.query("ROLLBACK TO SAVEPOINT a2_helper_ownership");
      }
      // A non-owner with EXECUTE but no grant option can receive warnings,
      // not exceptions. Prove the attempted ACL changes are no-ops as well.
      const notices: string[] = []; const onNotice = (notice: { code?: string }) => { notices.push(notice.code ?? ""); };
      client.on("notice", onNotice);
      try {
        await client.query("GRANT EXECUTE ON FUNCTION public.command_policy_record_version_locked(text,text,text,text,text,text) TO PUBLIC");
        assert.deepEqual(notices.splice(0), ["01007"]);
        await client.query("REVOKE ALL ON FUNCTION public.command_policy_record_version_locked(text,text,text,text,text,text) FROM realm_runtime");
        assert.deepEqual(notices.splice(0), ["01006"]);
      } finally { client.off("notice", onNotice); }
      assert.deepEqual((await client.query(helperSQL, helperArgs)).rows, [{ world_version: "1.2.0" }]);
    });
    assert.deepEqual(await helperCatalog(), catalog); assert.deepEqual(await helperPrivileges(), privileges); assert.deepEqual(await counts(), before);
  });
  await t.test("helper owner has only declared columns and runtime direct Story writes remain denied", async () => {
    const before = await helperPrivileges(), catalog = await helperCatalog(); assert.ok(before.length > 0);
    const selected: Record<string, readonly string[]> = {
      records: ["workspace_id", "world_id", "worldline_id", "id", "story_id", "status", "world_version"],
      stories: ["workspace_id", "world_id", "worldline_id", "id", "status"],
      project_story_links: ["workspace_id", "world_id", "worldline_id", "story_id", "project_id", "link_kind"],
    };
    assert.deepEqual(new Set(before.map(row => row.relname)), new Set(Object.keys(selected)));
    const tables = (await owner.query("SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,c.relowner='realm_command_policy_locker'::regrole AS helper_owns FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY($1::text[]) ORDER BY c.relname", [Object.keys(selected)])).rows;
    assert.equal(tables.length, Object.keys(selected).length);
    assert.ok(tables.every(row => row.relrowsecurity && row.relforcerowsecurity && !row.helper_owns));
    for (const row of before) {
      assert.equal(row.helper_select, selected[row.relname]!.includes(row.attname), `${row.relname}.${row.attname} SELECT`);
      assert.equal(row.helper_update, row.relname !== "project_story_links" && row.attname === "updated_at", `${row.relname}.${row.attname} UPDATE`);
    }
    await withWorkspaceTransaction(runtime, workspaceA, async client => {
      for (const sql of ["UPDATE public.stories SET title=title WHERE false", "UPDATE public.stories SET premise=premise WHERE false", "UPDATE public.stories SET status=status WHERE false"]) {
        await client.query("SAVEPOINT a2_story_direct_write"); await assert.rejects(client.query(sql), { code: "42501" }); await client.query("ROLLBACK TO SAVEPOINT a2_story_direct_write");
      }
      assert.deepEqual((await client.query(helperSQL, helperArgs)).rows, [{ world_version: "1.2.0" }]);
    });
    assert.deepEqual(await helperPrivileges(), before); assert.deepEqual(await helperCatalog(), catalog);
  });
  await t.test("actual migration role guard refuses every remaining elevated attribute, config and reverse membership", async () => {
    const { readFile } = await import("node:fs/promises");
    const migration = await readFile(new URL("../database/postgres/migrations/0081_command_policy_record_lock.sql", import.meta.url), "utf8");
    const roleSQL = migration.slice(0, migration.indexOf("$policy_lock_role$;") + "$policy_lock_role$;".length);
    const before = await helperPrivileges(), catalog = await helperCatalog();
    const roleState = async () => (await owner.query("SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls,rolconfig FROM pg_roles WHERE rolname='realm_command_policy_locker'")).rows;
    const roleBefore = await roleState(), client = await owner.connect();
    try {
      await client.query("BEGIN"); await client.query(roleSQL);
      for (const poison of [
        "ALTER ROLE realm_command_policy_locker LOGIN", "ALTER ROLE realm_command_policy_locker SUPERUSER",
        "ALTER ROLE realm_command_policy_locker CREATEDB", "ALTER ROLE realm_command_policy_locker CREATEROLE",
        "ALTER ROLE realm_command_policy_locker INHERIT", "ALTER ROLE realm_command_policy_locker REPLICATION",
        "ALTER ROLE realm_command_policy_locker SET application_name = 'a2-unsafe-role-config'",
        "COMMENT ON ROLE realm_command_policy_locker IS NULL", "GRANT realm_runtime TO realm_command_policy_locker",
      ]) {
        await client.query("SAVEPOINT a2_extended_role_guard"); await client.query(poison);
        await assert.rejects(client.query(roleSQL), { code: "P0001", message: "COMMAND_POLICY_LOCK_ROLE_UNSAFE" });
        await client.query("ROLLBACK TO SAVEPOINT a2_extended_role_guard");
      }
      await client.query(roleSQL);
    } finally { try { await client.query("ROLLBACK"); } finally { client.release(); } }
    assert.deepEqual(await roleState(), roleBefore); assert.deepEqual(await helperPrivileges(), before); assert.deepEqual(await helperCatalog(), catalog);
  });
  await t.test("signed genesis rolls back after exactly one command-map row was inserted", async () => {
    const workspaceId = await freshWorkspace("partial_map");
    const triggerName = `a2_partial_${suffix}`, functionName = `a2_partial_fn_${suffix}`;
    const before = await counts(workspaceId);
    const membershipBefore = (await owner.query(`SELECT count(*)::int AS n FROM player_world_memberships WHERE workspace_id=$1`, [workspaceId])).rows;
    await owner.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE depth integer; BEGIN
      IF NEW.workspace_id = '${workspaceId}' THEN
        SELECT count(*)::integer INTO depth FROM public.realmworld_command_materializations WHERE workspace_id=NEW.workspace_id AND world_id=NEW.world_id AND worldline_id=NEW.worldline_id;
        IF depth = 1 THEN RAISE EXCEPTION 'A2_PARTIAL_MAP_ROLLBACK_AFTER_1'; END IF;
      END IF; RETURN NEW; END $$`);
    try {
      await owner.query(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON realmworld_command_materializations FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
      await assert.rejects(library.instantiateRealmWorld(scopeFor(workspaceId), plan, "a2-partial-map"), { code: "P0001", message: "A2_PARTIAL_MAP_ROLLBACK_AFTER_1" });
      assert.deepEqual(await counts(workspaceId), before);
      assert.deepEqual((await owner.query(`SELECT count(*)::int AS n FROM player_world_memberships WHERE workspace_id=$1`, [workspaceId])).rows, membershipBefore);
    } finally {
      await owner.query(`DROP TRIGGER IF EXISTS ${triggerName} ON realmworld_command_materializations`);
      await owner.query(`DROP FUNCTION ${functionName}()`);
    }
    // Same key succeeds after the fault is removed: no leaked creation receipt.
    const committed = await library.instantiateRealmWorld(scopeFor(workspaceId), plan, "a2-partial-map");
    assert.equal(committed.replayed, false);
    assert.equal((await readMap(workspaceId, committed.worldlineId)).length, 2);
    assert.equal((await library.instantiateRealmWorld(scopeFor(workspaceId), plan, "a2-partial-map")).replayed, true);
  });
  for (const table of ["projects", "project_story_links", "project_milestones", "realmworld_command_materializations"]) await t.test(`real transaction rollback at ${table}`, async () => {
    const workspaceA = await freshWorkspace(`rollback_${table}`);
    const triggerName = `a2_fail_${suffix}`, functionName = `a2_fail_fn_${suffix}`, before = await counts(workspaceA);
    await owner.query(`CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.workspace_id = '${workspaceA}' THEN RAISE EXCEPTION 'A2_PG_INJECTED_FAILURE'; END IF; RETURN NEW; END $$`);
    try {
      await owner.query(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ${functionName}()`);
      await assert.rejects(library.instantiateRealmWorld(scopeFor(workspaceA), plan, `rollback-${table}`), /A2_PG_INJECTED_FAILURE/);
      assert.deepEqual(await counts(workspaceA), before, "genesis rollback preserves the existing thirteen-table count control; partial-map depth is a separate gate");
    } finally { await owner.query(`DROP TRIGGER IF EXISTS ${triggerName} ON ${table}`); await owner.query(`DROP FUNCTION ${functionName}()`); }
  });
  await t.test("same World new instance still refuses populated membership scope", async () => {
    const before = await counts();
    await assert.rejects(library.instantiateRealmWorld(scopeFor(workspaceA), plan, "a2-distinct-instance-refusal"), /CAPABILITY_WORLD_ALREADY_HAS_MEMBERS/);
    assert.deepEqual(await counts(), before);
    assert.deepEqual(await readMap(workspaceA, source.worldlineId), sourceMap);
  });
  await t.test("FORCE RLS and SELECT/INSERT-only runtime grants", async () => {
    const acl = (await owner.query(`SELECT relrowsecurity,relforcerowsecurity,has_table_privilege('realm_runtime',oid,'SELECT') AS can_select,has_table_privilege('realm_runtime',oid,'INSERT') AS can_insert,has_table_privilege('realm_runtime',oid,'UPDATE') AS can_update,has_table_privilege('realm_runtime',oid,'DELETE') AS can_delete FROM pg_class WHERE oid='public.realmworld_command_materializations'::regclass`)).rows[0];
    assert.deepEqual(acl, { relrowsecurity: true, relforcerowsecurity: true, can_select: true, can_insert: true, can_update: false, can_delete: false });
    await withWorkspaceTransaction(runtime, workspaceA, async client => {
      const visible = await client.query(`SELECT workspace_id FROM realmworld_command_materializations WHERE world_id=$1`, [worldId]);
      assert.equal(visible.rows.length, 2); assert.ok(visible.rows.every(r => r.workspace_id === workspaceA));
      await client.query("SAVEPOINT a2_acl");
      await assert.rejects(client.query(`UPDATE realmworld_command_materializations SET policy_version='forbidden' WHERE world_id=$1`, [worldId]), { code: "42501" });
      await client.query("ROLLBACK TO SAVEPOINT a2_acl");
      await assert.rejects(client.query(`DELETE FROM realmworld_command_materializations WHERE world_id=$1`, [worldId]), { code: "42501" });
      await client.query("ROLLBACK TO SAVEPOINT a2_acl");
    });
  });
  await t.test("composite FK identities, duplicate key and append-only enforcement", async () => {
    const client = await owner.connect(); const row = sourceMap[0]!;
    const spareMilestone = `milestone_a2_spare_${suffix}`;
    await owner.query(`INSERT INTO project_milestones(workspace_id,world_id,worldline_id,id,project_id,sequence,title,status) VALUES ($1,$2,$3,$4,$5,3,'Spare','planned')`, [workspaceA, worldId, source.worldlineId, spareMilestone, row.project_id]);
    await client.query("BEGIN");
    try {
      const insert = async (change: Record<string, unknown>) => {
        const r = { ...row, milestone_key: "spare", milestone_id: spareMilestone, ...change };
        return client.query(`INSERT INTO realmworld_command_materializations(workspace_id,world_id,worldline_id,schema_version,world_version,content_hash,policy_version,project_key,milestone_key,project_id,milestone_id,story_id,record_id,link_kind) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [r.workspace_id,r.world_id,r.worldline_id,r.schema_version,r.world_version,r.content_hash,r.policy_version,r.project_key,r.milestone_key,r.project_id,r.milestone_id,r.story_id,r.record_id,r.link_kind]);
      };
      for (const [change, code] of [
        [{ workspace_id: workspaceB, worldline_id: other.worldlineId }, "23503"],
        [{ world_id: "world_foreign" }, "23503"], [{ worldline_id: other.worldlineId }, "23503"],
        [{ project_id: "project_foreign" }, "23503"], [{ story_id: "story_foreign" }, "23503"],
        [{ record_id: other.recordId }, "23503"], [{ link_kind: "related" }, "23514"],
        [{ milestone_key: row.milestone_key, milestone_id: row.milestone_id }, "23505"],
      ] as const) {
        await client.query("SAVEPOINT a2_identity"); await assert.rejects(insert(change), { code }); await client.query("ROLLBACK TO SAVEPOINT a2_identity");
      }
      for (const operation of ["UPDATE realmworld_command_materializations SET policy_version='forbidden'", "DELETE FROM realmworld_command_materializations"]) {
        await client.query("SAVEPOINT a2_immutable"); await assert.rejects(client.query(`${operation} WHERE workspace_id=$1 AND worldline_id=$2`, [workspaceA, source.worldlineId]), /command materializations are immutable/); await client.query("ROLLBACK TO SAVEPOINT a2_immutable");
      }
    } finally { await client.query("ROLLBACK"); client.release(); }
  });
  await t.test("command map INSERT denies a foreign workspace even with independently valid composite FKs", async () => {
    const row = sourceMap[0]!, milestoneId = `milestone_a2_rls_${suffix}`;
    await owner.query(`INSERT INTO project_milestones(workspace_id,world_id,worldline_id,id,project_id,sequence,title,status) VALUES ($1,$2,$3,$4,$5,4,'RLS positive fixture','planned')`, [workspaceA, worldId, source.worldlineId, milestoneId, row.project_id]);
    const sql = "INSERT INTO realmworld_command_materializations(workspace_id,world_id,worldline_id,schema_version,world_version,content_hash,policy_version,project_key,milestone_key,project_id,milestone_id,story_id,record_id,link_kind) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)";
    const args = [row.workspace_id,row.world_id,row.worldline_id,row.schema_version,row.world_version,row.content_hash,row.policy_version,row.project_key,"rls-probe",row.project_id,milestoneId,row.story_id,row.record_id,row.link_kind];
    const beforeA = await readMap(workspaceA, source.worldlineId), beforeB = await readMap(workspaceB, other.worldlineId);
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      assert.equal((await client.query(sql, args)).rowCount, 1, "same tuple satisfies all actual identity/check/unique constraints");
    } finally { await client.query("ROLLBACK"); client.release(); }
    await assert.rejects(withWorkspaceTransaction(runtime, workspaceB, client => client.query(sql, args)), { code: "42501" });
    assert.deepEqual(await readMap(workspaceA, source.worldlineId), beforeA);
    assert.deepEqual(await readMap(workspaceB, other.worldlineId), beforeB);
  });
  const service = (database: pg.Pool | pg.PoolClient, resolver = resolveCommandPolicy) => createProjectFinanceCommandService({ store: createPostgresProjectFinanceCommandStore(database, { resolveCommandPolicy: resolver }) });
  const sceneId = (await owner.query(`SELECT id FROM scenes WHERE workspace_id=$1 AND record_id=$2`, [workspaceA, source.recordId])).rows[0].id as string;
  const prior = sourceMap.find(r => r.milestone_key === "prior")!, target = sourceMap.find(r => r.milestone_key === "target")!;
  const priorIntent = { scope: sourceScope, projectId: prior.project_id as string, milestoneId: prior.milestone_id as string, expectedProjectVersion: 1, idempotencyKey: `a2-historical-${suffix}`, evidence: { recordId: source.recordId, sceneId, visibility: "public" as const, expectedWorldCursor: { worldTick: 0, worldOrdinal: 1 } } };
  const targetIntent = { ...priorIntent, milestoneId: target.milestone_id as string, expectedProjectVersion: 2, semanticEventKey: "synthetic.ready", idempotencyKey: `a2-signed-${suffix}`, evidence: { ...priorIntent.evidence, expectedWorldCursor: { worldTick: 0, worldOrdinal: 2 } } };
  assert.equal((await service(runtime).confirmMilestone(priorIntent)).status, "committed");
  assert.equal((await service(runtime).confirmMilestone(targetIntent)).status, "committed");
  const historical = (await owner.query(`SELECT result_manifest FROM project_finance_command_groups WHERE workspace_id=$1 AND idempotency_key=$2`, [workspaceA, priorIntent.idempotencyKey])).rows[0].result_manifest;
  assert.equal("requestPolicy" in historical.result, false);
  await t.test("real helper rejects existing but mismatched Record Story and primary Project relations", async caseTest => {
    const client = await owner.connect(), before = await counts();
    const storyId = `story_a2_relation_${suffix}`, projectId = `project_a2_relation_${suffix}`;
    try {
      await client.query("BEGIN");
      assert.equal((await client.query("INSERT INTO stories (workspace_id,world_id,worldline_id,id,title,status,premise,start_tick,start_ordinal) VALUES ($1,$2,$3,$4,'Relation sibling','active','',0,0)", [workspaceA,worldId,source.worldlineId,storyId])).rowCount, 1);
      assert.equal((await client.query("INSERT INTO projects (workspace_id,world_id,worldline_id,id,kind,status,stage,title,currency,version) VALUES ($1,$2,$3,$4,'production','planned','planning','Relation sibling','JPY',1)", [workspaceA,worldId,source.worldlineId,projectId])).rowCount, 1);
      assert.equal((await client.query("INSERT INTO project_story_links (workspace_id,world_id,worldline_id,id,project_id,story_id,link_kind) VALUES ($1,$2,$3,$4,$5,$6,'related'),($1,$2,$3,$7,$5,$8,'primary')", [workspaceA,worldId,source.worldlineId,`link_related_${suffix}`,projectId,source.storyId,`link_primary_${suffix}`,storyId])).rowCount, 2);
      assert.equal((await client.query("SELECT id FROM stories WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 AND id=ANY($4::text[]) ORDER BY id", [workspaceA,worldId,source.worldlineId,[source.storyId,storyId]])).rowCount, 2);
      assert.equal((await client.query("SELECT id FROM projects WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 AND id=ANY($4::text[]) ORDER BY id", [workspaceA,worldId,source.worldlineId,[sourceMap[0]!.project_id,projectId]])).rowCount, 2);
      const valid = [workspaceA,worldId,source.worldlineId,source.recordId,source.storyId,sourceMap[0]!.project_id];
      for (const probe of [
        { name: "existing sibling Story is not this Record Story", args: [workspaceA,worldId,source.worldlineId,source.recordId,storyId,sourceMap[0]!.project_id] },
        { name: "existing Project has related-only link to actual Story", args: [workspaceA,worldId,source.worldlineId,source.recordId,source.storyId,projectId] },
        { name: "existing primary Project Story pair does not belong to actual Record", args: [workspaceA,worldId,source.worldlineId,source.recordId,storyId,projectId] },
        { name: "archived Record cannot qualify", sql: "UPDATE records SET status='archived' WHERE workspace_id=$1 AND id=$2", id: source.recordId },
        { name: "archived Story cannot qualify", sql: "UPDATE stories SET status='archived' WHERE workspace_id=$1 AND id=$2", id: source.storyId },
      ]) await caseTest.test(probe.name, async () => {
        await client.query("SAVEPOINT relational_probe");
        try {
          if (probe.sql) assert.equal((await client.query(probe.sql,[workspaceA,probe.id])).rowCount, 1);
          await client.query("SET LOCAL ROLE realm_runtime");
          await withWorkspaceTransaction(client, workspaceA, async scoped => {
            assert.equal((await scoped.query("SELECT current_user AS role")).rows[0].role, "realm_runtime");
            assert.deepEqual((await scoped.query(helperSQL,probe.args ?? valid)).rows, []);
          });
        } finally { await client.query("ROLLBACK TO SAVEPOINT relational_probe"); await client.query("RELEASE SAVEPOINT relational_probe"); }
        await client.query("SET LOCAL ROLE realm_runtime");
        await withWorkspaceTransaction(client,workspaceA,async scoped => assert.deepEqual((await scoped.query(helperSQL,valid)).rows,[{ world_version: policy.worldVersion }]));
        await client.query("RESET ROLE");
      });
    } finally { try { await client.query("ROLLBACK"); } finally { client.release(); } }
    assert.deepEqual(await counts(),before);
  });
  await t.test("real semantic command SQL rejects wrong supporting Event predicates without command writes", async caseTest => {
    const { commandAuthoritySnapshot } = await import("./helpers/native-legacy-replay.ts");
    const workspaceId = await freshWorkspace("relational_support");
    const initial = await library.instantiateRealmWorld(scopeFor(workspaceId),plan,"a2-relational-support");
    const scope = { workspaceId,worldId,worldlineId: initial.worldlineId };
    const map = await readMap(workspaceId,initial.worldlineId), prior = map.find(r => r.milestone_key === "prior")!, target = map.find(r => r.milestone_key === "target")!;
    const sceneId = (await owner.query("SELECT id FROM scenes WHERE workspace_id=$1 AND record_id=$2",[workspaceId,initial.recordId])).rows[0].id as string;
    const first = { scope,projectId: prior.project_id as string,milestoneId: prior.milestone_id as string,expectedProjectVersion: 1,idempotencyKey: `a2-support-prior-${suffix}`,evidence: { recordId: initial.recordId,sceneId,visibility: "public" as const,expectedWorldCursor: { worldTick: 0,worldOrdinal: 1 } } };
    assert.equal((await service(runtime).confirmMilestone(first)).status,"committed");
    const priorState = (await owner.query("SELECT status,completion_record_id,completion_event_id FROM project_milestones WHERE workspace_id=$1 AND id=$2",[workspaceId,prior.milestone_id])).rows[0];
    assert.equal(priorState.status,"completed"); assert.equal(priorState.completion_record_id,initial.recordId);
    const support = (await owner.query("SELECT e.*,v.policy_kind FROM events e JOIN visibility_policies v ON v.workspace_id=e.workspace_id AND v.id=e.visibility_policy_id WHERE e.workspace_id=$1 AND e.id=$2",[workspaceId,priorState.completion_event_id])).rows[0];
    assert.equal(support.event_kind,"project.milestone.confirmed"); assert.equal(support.policy_kind,"public"); assert.equal(support.actor_participant_id,null);
    assert.deepEqual(support.payload,{ projectId: prior.project_id,milestoneId: prior.milestone_id });
    const intent = { ...first,milestoneId: target.milestone_id as string,expectedProjectVersion: 2,idempotencyKey: `a2-support-target-${suffix}`,semanticEventKey: "synthetic.ready",evidence: { ...first.evidence,expectedWorldCursor: { worldTick: 0,worldOrdinal: 2 } } };
    const transactionalState = async (client: pg.PoolClient) => {
      const rows: Record<string,unknown> = {};
      for (const table of ["projects", "project_milestones", "project_story_links", "budget_allocations", "finance_accounts", "ledger_entries", "project_finance_command_groups", "obligations", "obligation_settlements", "committed_fact_commands", "character_assets", "member_relationship_revisions", "performance_assessments", "events", "record_heads", "worldlines"]) rows[table] = (await client.query(
        `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb) AS rows FROM ${table} t WHERE workspace_id=$1 AND ${table === "worldlines" ? "id" : "worldline_id"}=$2`,[workspaceId,scope.worldlineId])).rows[0].rows;
      return rows;
    };
    const baseline = await commandAuthoritySnapshot(owner,scope);
    for (const probe of [
      { name: "support has wrong Event kind", kind: "narration.committed" },
      { name: "support payload references another existing Project", wrongProject: true },
      { name: "support payload references another existing Milestone", wrongMilestone: true },
      { name: "support payload omits projectId", missingProject: true },
      { name: "support has DM-only rather than public visibility", hidden: true },
      { name: "prerequisite status is active despite valid completion tuple", status: "active" },
      { name: "completed prerequisite has no completion evidence", empty: true },
      { name: "prerequisite Event is valid but in another existing Record", foreignRecord: true },
    ]) await caseTest.test(probe.name,async () => {
      const client = await owner.connect();
      try {
        await client.query("BEGIN");
        const projectId = `project_support_other_${suffix}`, recordId = `record_support_other_${suffix}`, otherScene = `scene_support_other_${suffix}`;
        if (probe.wrongProject) assert.equal((await client.query("INSERT INTO projects (workspace_id,world_id,worldline_id,id,kind,status,stage,title,currency,version) VALUES ($1,$2,$3,$4,'production','planned','planning','Support sibling','JPY',1)",[workspaceId,worldId,initial.worldlineId,projectId])).rowCount,1);
        if (probe.foreignRecord) {
          assert.equal((await client.query("INSERT INTO records (workspace_id,world_id,worldline_id,story_id,id,title,status,start_tick,start_ordinal,world_version) VALUES ($1,$2,$3,$4,$5,'Support sibling','active',0,0,$6)",[workspaceId,worldId,initial.worldlineId,initial.storyId,recordId,policy.worldVersion])).rowCount,1);
          assert.equal((await client.query("INSERT INTO scenes (workspace_id,world_id,worldline_id,record_id,id,title,status,location,objective,start_tick,start_ordinal) VALUES ($1,$2,$3,$4,$5,'Support sibling','active','','',0,0)",[workspaceId,worldId,initial.worldlineId,recordId,otherScene])).rowCount,1);
        }
        const eventRecord = probe.foreignRecord ? recordId : initial.recordId, eventScene = probe.foreignRecord ? otherScene : sceneId;
        const visibilityId = `policy_support_probe_${suffix}`, eventId = `event_support_probe_${suffix}`;
        if (probe.hidden || probe.foreignRecord) assert.equal((await client.query("INSERT INTO visibility_policies (workspace_id,world_id,worldline_id,record_id,id,policy_key,policy_version,policy_kind) VALUES ($1,$2,$3,$4,$5,$6,1,$6)",[workspaceId,worldId,initial.worldlineId,eventRecord,visibilityId,probe.hidden ? "dm_only" : "public"])).rowCount,1);
        const payload: Record<string,unknown> = { ...support.payload };
        if (probe.wrongProject) payload.projectId = projectId;
        if (probe.wrongMilestone) payload.milestoneId = target.milestone_id;
        if (probe.missingProject) delete payload.projectId;
        // Append a new legal disposable fixture; never UPDATE a committed Event,
        // disable a trigger or drop a constraint to manufacture the negative.
        if (!probe.status && !probe.empty) {
          assert.equal((await client.query(`INSERT INTO events (workspace_id,world_id,worldline_id,record_id,scene_id,id,record_version,record_ordinal,batch_index,event_kind,actor_participant_id,speaker_name,content,payload,visibility_policy_id,world_tick,world_ordinal,calendar_id,display_time)
            SELECT workspace_id,world_id,worldline_id,$3,$4,$5,100,100,0,$6,NULL,speaker_name,content,$7::jsonb,$8,world_tick,100,calendar_id,display_time FROM events WHERE workspace_id=$1 AND id=$2`,[workspaceId,support.id,eventRecord,eventScene,eventId,probe.kind ?? support.event_kind,JSON.stringify(payload),probe.hidden || probe.foreignRecord ? visibilityId : support.visibility_policy_id])).rowCount,1);
          const actual = (await client.query("SELECT e.record_id,e.event_kind,e.payload,v.policy_kind FROM events e JOIN visibility_policies v ON v.workspace_id=e.workspace_id AND v.id=e.visibility_policy_id WHERE e.workspace_id=$1 AND e.id=$2",[workspaceId,eventId])).rows[0];
          assert.deepEqual(actual,{ record_id: eventRecord,event_kind: probe.kind ?? support.event_kind,payload,policy_kind: probe.hidden ? "dm_only" : "public" });
        }
        assert.equal((await client.query("UPDATE project_milestones SET status=$3,completion_record_id=$4,completion_event_id=$5 WHERE workspace_id=$1 AND id=$2",[workspaceId,prior.milestone_id,probe.status ?? "completed",probe.empty ? null : eventRecord,probe.empty ? null : probe.status ? support.id : eventId])).rowCount,1);
        const before = await transactionalState(client);
        await client.query("SET LOCAL ROLE realm_runtime");
        await withWorkspaceTransaction(client,workspaceId,async scoped => {
          assert.equal((await scoped.query("SELECT current_user AS role")).rows[0].role,"realm_runtime");
          await authorizeProjectFinanceWrite(scoped,{ scope,principalId });
          await assert.rejects(service(scoped).confirmMilestone(intent),{ code: "BUSINESS_PRECONDITION_FAILED" });
        });
        await client.query("RESET ROLE");
        assert.deepEqual(await transactionalState(client),before,"refusal must not write a command, Event, head or business state");
      } finally { try { await client.query("ROLLBACK"); } finally { client.release(); } }
      assert.deepEqual(await commandAuthoritySnapshot(owner,scope),baseline,"fixture transaction must restore authoritative baseline");
    });
    const accepted = await withWorkspaceTransaction(runtime,workspaceId,async client => {
      await authorizeProjectFinanceWrite(client,{ scope,principalId });
      return service(client).confirmMilestone(intent);
    });
    assert.equal(accepted.status,"committed");
    assert.deepEqual(accepted.requestPolicy,{ schemaVersion: 1,contentHash: policy.contentHash,policyVersion: policy.policyVersion,bindingKey: "target.ready" });
    const final = (await owner.query("SELECT status,completion_record_id,completion_event_id FROM project_milestones WHERE workspace_id=$1 AND id=$2",[workspaceId,target.milestone_id])).rows[0];
    assert.equal(final.status,"completed"); assert.equal(final.completion_record_id,initial.recordId); assert.ok(final.completion_event_id);
    assert.deepEqual((await owner.query("SELECT event_kind,payload FROM events WHERE workspace_id=$1 AND id=$2",[workspaceId,final.completion_event_id])).rows,[{ event_kind: "project.milestone.confirmed",payload: { projectId: target.project_id,milestoneId: target.milestone_id,semanticEventKey: "synthetic.ready" } }]);
    assert.equal((await owner.query("SELECT version::text FROM projects WHERE workspace_id=$1 AND id=$2",[workspaceId,target.project_id])).rows[0].version,"3");
    assert.equal((await owner.query("SELECT count(*)::int AS n FROM project_finance_command_groups WHERE workspace_id=$1 AND worldline_id=$2",[workspaceId,initial.worldlineId])).rows[0].n,2);
  });
  for (const purpose of ["record-export", "whole-closure-backup"] as const) await t.test(`new semantic admission after two ${purpose} generations enforces real prerequisites and signed policy`, async () => {
    const workspaceId = await freshWorkspace(purpose === "record-export" ? "new_narrow" : "new_whole");
    const initial = await library.instantiateRealmWorld(scopeFor(workspaceId), plan, `a2-new-${purpose}`);
    const reader = createPostgresRealmRuntimeSaveReader(runtime);
    const restorer = createPostgresRealmRuntimeSaveRestorer(runtime, { resolveCommandPolicy, validateWorldBinding: async binding => { assert.ok(await resolveCommandPolicy(binding)); } });
    const initialData = await reader.load({ workspaceId, recordId: initial.recordId, principalId, purpose }); assert.ok(initialData);
    assert.equal(initialData.domain!.financeCommandGroups.length, 0);
    let archive = parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(initialData));
    for (const [generation, targetWorkspace] of [[1, workspaceB], [2, workspaceA]] as const) {
      const restored = await restorer.restore({ workspaceId: targetWorkspace, targetWorldId: worldId, principalId, sessionProof: sessionProofFor(principalId), archive, idempotencyKey: `a2-new-${purpose}-${generation}-${suffix}` });
      const loaded = await reader.load({ workspaceId: targetWorkspace, recordId: restored.recordId, principalId, purpose }); assert.ok(loaded);
      const next = parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(loaded));
      const map = next.domain!.commandMaterializations!; assert.ok(map); assert.equal(map.rows.length, 2);
      assert.equal(map.contentHash, policy.contentHash); assert.equal(map.policyVersion, policy.policyVersion);
      for (const row of archive.domain!.commandMaterializations!.rows) {
        const matches = map.rows.filter(r => r.projectKey === row.projectKey && r.milestoneKey === row.milestoneKey);
        assert.equal(matches.length, 1);
        for (const field of ["projectId", "milestoneId", "storyId", "recordId"] as const) assert.notEqual(matches[0]![field], row[field]);
      }
      assert.equal(next.domain!.financeCommandGroups.length, 0, "new command proof must not be receipt replay");
      archive = next;
      if (generation !== 2) continue;
      const prior = map.rows.find(r => r.milestoneKey === "prior")!, target = map.rows.find(r => r.milestoneKey === "target")!;
      const scope = { workspaceId: targetWorkspace, worldId, worldlineId: restored.worldlineId };
      const sceneId: string = next.topology!.scenes.find(s => s.title === initialData.topology!.scenes[0]!.title)!.sourceSceneId;
      const state = async () => ({
        project: (await owner.query("SELECT status,version::text FROM projects WHERE workspace_id=$1 AND id=$2", [targetWorkspace, target.projectId])).rows,
        milestones: (await owner.query("SELECT id,status,completion_record_id,completion_event_id FROM project_milestones WHERE workspace_id=$1 AND project_id=$2 ORDER BY id", [targetWorkspace, target.projectId])).rows,
        events: (await owner.query("SELECT id,event_kind,payload FROM events WHERE workspace_id=$1 AND record_id=$2 ORDER BY id", [targetWorkspace, restored.recordId])).rows,
        receipts: (await owner.query("SELECT id,result_manifest FROM project_finance_command_groups WHERE workspace_id=$1 AND worldline_id=$2 ORDER BY id", [targetWorkspace, restored.worldlineId])).rows,
        head: (await owner.query("SELECT head_tick::text,head_ordinal::text FROM worldlines WHERE workspace_id=$1 AND id=$2", [targetWorkspace, restored.worldlineId])).rows,
      });
      const submit = (intent: Parameters<ReturnType<typeof service>["confirmMilestone"]>[0], resolver = resolveCommandPolicy) => withWorkspaceTransaction(runtime, targetWorkspace, async client => {
        await authorizeProjectFinanceWrite(client, { scope, principalId });
        return service(client, resolver).confirmMilestone(intent);
      });
      const before = await state(); assert.equal(before.project[0].version, "1");
      assert.ok(before.milestones.every(m => m.status === "planned")); assert.equal(before.receipts.length, 0);
      const evidence: import("../modules/application/project-finance-command.ts").RecordEvidence = { recordId: restored.recordId, sceneId, visibility: "public" as const, expectedWorldCursor: { worldTick: Number(before.head[0].head_tick), worldOrdinal: Number(before.head[0].head_ordinal) } };
      const firstTarget: Parameters<ReturnType<typeof service>["confirmMilestone"]>[0] = { scope, projectId: target.projectId, milestoneId: target.milestoneId, expectedProjectVersion: 1, semanticEventKey: "synthetic.ready", idempotencyKey: `a2-new-${purpose}-target-${suffix}`, evidence };
      await assert.rejects(submit(firstTarget), { code: "BUSINESS_PRECONDITION_FAILED" });
      assert.deepEqual(await state(), before, "S1 refusal preserves project, milestones, events, receipts and head");
      assert.equal((await submit({ ...firstTarget, milestoneId: prior.milestoneId, semanticEventKey: undefined, idempotencyKey: `a2-new-${purpose}-prior-${suffix}` })).status, "committed");
      const priorDone = await state(); assert.equal(priorDone.project[0].version, "2");
      const intent: Parameters<ReturnType<typeof service>["confirmMilestone"]>[0] = { ...firstTarget, expectedProjectVersion: 2, evidence: { ...evidence, expectedWorldCursor: { worldTick: Number(priorDone.head[0].head_tick), worldOrdinal: Number(priorDone.head[0].head_ordinal) } } };
      let missingCalls = 0;
      await assert.rejects(submit(intent, async () => { missingCalls++; throw Error("A2_PG_MISSING_SIGNED_POLICY"); }), { code: "BUSINESS_POLICY_MISSING" });
      assert.equal(missingCalls, 1); assert.deepEqual(await state(), priorDone);
      const committed = await submit(intent); assert.equal(committed.status, "committed");
      assert.deepEqual(committed.requestPolicy, { schemaVersion: 1, contentHash: policy.contentHash, policyVersion: policy.policyVersion, bindingKey: "target.ready" });
      const after = await state(); assert.equal(after.project[0].version, "3");
      assert.equal(after.receipts.length, 2); assert.equal(after.events.length, before.events.length + 2);
      const confirmed = after.milestones.find(m => m.id === target.milestoneId)!;
      assert.equal(confirmed.status, "completed"); assert.equal(confirmed.completion_record_id, restored.recordId);
      const event = after.events.find(e => e.id === confirmed.completion_event_id)!;
      assert.equal(event.event_kind, "project.milestone.confirmed");
      assert.deepEqual(event.payload, { projectId: target.projectId, milestoneId: target.milestoneId, semanticEventKey: "synthetic.ready" });
      assert.deepEqual(after.receipts.find(r => r.id === committed.commandGroupId)!.result_manifest.result.requestPolicy, committed.requestPolicy);
      let replayResolverCalls = 0;
      assert.equal((await submit(intent, async () => { replayResolverCalls++; throw Error("A2_PG_POLICY_OFFLINE"); })).status, "replayed");
      assert.equal(replayResolverCalls, 0); assert.deepEqual(await state(), after);
      const finalData = await reader.load({ workspaceId: targetWorkspace, recordId: restored.recordId, principalId, purpose }); assert.ok(finalData);
      const finalArchive = parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(finalData));
      assert.equal(finalArchive.domain!.financeCommandGroups.length, 2);
      const archivedGroup = finalArchive.domain!.financeCommandGroups.find(g => g.idempotencyKey === intent.idempotencyKey)!;
      const archivedResult = archivedGroup.resultManifest.result ?? archivedGroup.resultManifest;
      assert.ok(archivedResult && typeof archivedResult === "object" && !Array.isArray(archivedResult));
      assert.deepEqual((archivedResult as Record<string, unknown>).requestPolicy, committed.requestPolicy);
    }
  });
  for (const purpose of ["record-export", "whole-closure-backup"] as const) await t.test(`real PG ${purpose} cross-workspace two generations and complete intent replay`, async () => {
    const reader = createPostgresRealmRuntimeSaveReader(runtime);
    const restorer = createPostgresRealmRuntimeSaveRestorer(runtime, { resolveCommandPolicy, validateWorldBinding: async binding => { assert.ok(await resolveCommandPolicy(binding)); } });
    const original = await reader.load({ workspaceId: workspaceA, recordId: source.recordId, principalId, purpose }); assert.ok(original);
    let archive = parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(original));
    const metadata = archive.domain!.financeCommandGroups.map(g => ({ key: g.idempotencyKey, policy: ((g.resultManifest.result ?? g.resultManifest) as Record<string, unknown>).requestPolicy })).sort((a,b) => a.key.localeCompare(b.key));
    for (const [generation, workspaceId] of [[1, workspaceB], [2, workspaceA]] as const) {
      const restored = await restorer.restore({ workspaceId, targetWorldId: worldId, principalId, sessionProof: sessionProofFor(principalId), archive, idempotencyKey: `a2-${purpose}-${generation}-${suffix}` });
      const targetData = await reader.load({ workspaceId, recordId: restored.recordId, principalId, purpose }); assert.ok(targetData);
      const next = parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(targetData));
      assert.deepEqual(next.domain!.financeCommandGroups.map(g => ({ key: g.idempotencyKey, policy: ((g.resultManifest.result ?? g.resultManifest) as Record<string, unknown>).requestPolicy })).sort((a,b) => a.key.localeCompare(b.key)), metadata);
      const map = next.domain!.commandMaterializations!; assert.equal(map.contentHash, policy.contentHash); assert.equal(map.policyVersion, policy.policyVersion); assert.equal(map.worldVersion, "1.2.0");
      for (const row of archive.domain!.commandMaterializations!.rows) {
        const match = map.rows.find(r => r.projectKey === row.projectKey && r.milestoneKey === row.milestoneKey)!; assert.ok(match);
        for (const field of ["projectId", "milestoneId", "storyId", "recordId"] as const) assert.notEqual(match[field], row[field]);
      }
      const before = await owner.query(`SELECT count(*)::int AS n FROM events WHERE workspace_id=$1 AND record_id=$2`, [workspaceId, restored.recordId]);
      let resolverCalls = 0; const offline = service(runtime, async () => { resolverCalls++; throw Error("A2_PG_PACKAGE_OFFLINE"); });
      for (const intent of [priorIntent, targetIntent]) {
        const bound = map.rows.find(r => r.milestoneKey === (intent === priorIntent ? "prior" : "target"))!;
        const remapped: Parameters<ReturnType<typeof service>["confirmMilestone"]>[0] = { ...intent, scope: { workspaceId, worldId, worldlineId: restored.worldlineId }, projectId: bound.projectId, milestoneId: bound.milestoneId, evidence: { ...intent.evidence, recordId: restored.recordId, sceneId: next.topology!.scenes.find(s => s.title === original.topology!.scenes[0]!.title)!.sourceSceneId } };
        assert.equal((await offline.confirmMilestone(remapped)).status, "replayed");
        for (const change of [{ expectedProjectVersion: remapped.expectedProjectVersion + 1 }, { projectId: "changed" }, { milestoneId: "changed" }, { semanticEventKey: "synthetic.changed" }, { evidence: { ...remapped.evidence!, sceneId: "changed" } }]) await assert.rejects(offline.confirmMilestone({ ...remapped, ...change }), { code: "IDEMPOTENCY_KEY_REUSE" });
      }
      assert.equal(resolverCalls, 0); assert.deepEqual((await owner.query(`SELECT count(*)::int AS n FROM events WHERE workspace_id=$1 AND record_id=$2`, [workspaceId, restored.recordId])).rows, before.rows);
      assert.equal((await restorer.restore({ workspaceId, targetWorldId: worldId, principalId, sessionProof: sessionProofFor(principalId), archive, idempotencyKey: `a2-${purpose}-${generation}-${suffix}` })).replayed, true);
      archive = next;
    }
  });
  for (const purpose of ["record-export", "whole-closure-backup"] as const) await t.test(`genuine result-only receipt survives two ${purpose} generations without invented canonical request`, async () => {
    const { commandAuthoritySnapshot } = await import("./helpers/native-legacy-replay.ts");
    const workspaceId = await freshWorkspace(purpose === "record-export" ? "legacy_narrow" : "legacy_whole");
    const initial = await library.instantiateRealmWorld(scopeFor(workspaceId), plan, `a2-legacy-${purpose}`);
    const scope = { workspaceId, worldId, worldlineId: initial.worldlineId };
    const map = await readMap(workspaceId, initial.worldlineId), prior = map.find(r => r.milestone_key === "prior")!;
    const sceneId = (await owner.query("SELECT id FROM scenes WHERE workspace_id=$1 AND record_id=$2", [workspaceId, initial.recordId])).rows[0].id as string;
    const originalIntent = { scope, projectId: prior.project_id as string, milestoneId: prior.milestone_id as string, expectedProjectVersion: 1,
      idempotencyKey: `a2-result-only-${purpose}-${suffix}`, evidence: { recordId: initial.recordId, sceneId, visibility: "public" as const, expectedWorldCursor: { worldTick: 0, worldOrdinal: 1 } } };
    const accepted = await service(runtime).confirmMilestone(originalIntent); assert.equal(accepted.status, "committed");
    const receiptSQL = "SELECT request_fingerprint,result_manifest FROM project_finance_command_groups WHERE workspace_id=$1 AND worldline_id=$2 AND idempotency_key=$3";
    const originalRow = (await owner.query(receiptSQL, [workspaceId, initial.worldlineId, originalIntent.idempotencyKey])).rows[0];
    assert.ok(originalRow.result_manifest.request); assert.equal(Object.hasOwn(originalRow.result_manifest.result, "requestPolicy"), false);
    // Disposable historical-storage fixture only: retain actual accepted result/hash,
    // remove all modern wrapper metadata, never synthesize the missing request.
    assert.equal((await owner.query("UPDATE project_finance_command_groups SET result_manifest=result_manifest->'result' WHERE workspace_id=$1 AND worldline_id=$2 AND idempotency_key=$3", [workspaceId, initial.worldlineId, originalIntent.idempotencyKey])).rowCount, 1);
    const legacy = (await owner.query(receiptSQL, [workspaceId, initial.worldlineId, originalIntent.idempotencyKey])).rows[0];
    assert.equal(legacy.request_fingerprint, originalRow.request_fingerprint);
    assert.deepEqual(legacy.result_manifest, originalRow.result_manifest.result);
    for (const key of ["request", "result", "provenance", "requestPolicy", "replayLineage", "replayContext"]) assert.equal(Object.hasOwn(legacy.result_manifest, key), false);
    const nativeBefore = await commandAuthoritySnapshot(owner, scope);
    let resolverCalls = 0; const offline = service(runtime, async () => { resolverCalls++; throw Error("A2_LEGACY_PACKAGE_OFFLINE"); });
    assert.equal((await offline.confirmMilestone(originalIntent)).status, "replayed");
    assert.equal(resolverCalls, 0); assert.deepEqual(await commandAuthoritySnapshot(owner, scope), nativeBefore);
    const reader = createPostgresRealmRuntimeSaveReader(runtime);
    const restorer = createPostgresRealmRuntimeSaveRestorer(runtime, { resolveCommandPolicy, validateWorldBinding: async binding => { assert.ok(await resolveCommandPolicy(binding)); } });
    const initialData = await reader.load({ workspaceId, recordId: initial.recordId, principalId, purpose }); assert.ok(initialData);
    let archive = parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(initialData));
    let intent: typeof originalIntent = originalIntent;
    for (const [generation, targetWorkspace] of [[1, workspaceB], [2, workspaceA]] as const) {
      const group = archive.domain!.financeCommandGroups.find(g => g.idempotencyKey === originalIntent.idempotencyKey)!;
      assert.equal(group.provenance, "legacy-result-v1"); assert.equal(group.request, null);
      assert.equal(group.requestFingerprint, originalRow.request_fingerprint);
      const restored = await restorer.restore({ workspaceId: targetWorkspace, targetWorldId: worldId, principalId, sessionProof: sessionProofFor(principalId), archive, idempotencyKey: `a2-result-only-${purpose}-${generation}-${suffix}` });
      const loaded = await reader.load({ workspaceId: targetWorkspace, recordId: restored.recordId, principalId, purpose }); assert.ok(loaded);
      const next = parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(loaded));
      const matches = next.domain!.commandMaterializations!.rows.filter(r => r.projectKey === prior.project_key && r.milestoneKey === "prior"); assert.equal(matches.length, 1);
      const bound = matches[0]!;
      const scenes: readonly { sourceSceneId: string; title: string }[] = next.topology!.scenes.filter(s => s.title === initialData.topology!.scenes[0]!.title); assert.equal(scenes.length, 1);
      assert.notEqual(bound.projectId, intent.projectId); assert.notEqual(bound.milestoneId, intent.milestoneId);
      assert.notEqual(bound.recordId, intent.evidence.recordId); assert.notEqual(scenes[0]!.sourceSceneId, intent.evidence.sceneId);
      intent = { ...intent, scope: { workspaceId: targetWorkspace, worldId, worldlineId: restored.worldlineId }, projectId: bound.projectId, milestoneId: bound.milestoneId,
        evidence: { ...intent.evidence, recordId: restored.recordId, sceneId: scenes[0]!.sourceSceneId } };
      const persisted = (await owner.query(receiptSQL, [targetWorkspace, restored.worldlineId, originalIntent.idempotencyKey])).rows[0];
      assert.equal(persisted.request_fingerprint, originalRow.request_fingerprint);
      assert.equal(persisted.result_manifest.provenance, "legacy-result-v1"); assert.equal(persisted.result_manifest.request, null);
      assert.equal(Object.hasOwn(persisted.result_manifest.result, "requestPolicy"), false);
      const before = await commandAuthoritySnapshot(owner, intent.scope);
      assert.equal((await offline.confirmMilestone(intent)).status, "replayed");
      for (const changed of [{ ...intent, expectedProjectVersion: 2 }, { ...intent, semanticEventKey: "synthetic.ready" },
        { ...intent, milestoneId: "changed" }, { ...intent, evidence: { ...intent.evidence, sceneId: "changed" } },
        { ...intent, evidence: { ...intent.evidence, expectedWorldCursor: { worldTick: 0, worldOrdinal: 2 } } }]) {
        await assert.rejects(offline.confirmMilestone(changed), { code: "IDEMPOTENCY_KEY_REUSE" });
      }
      assert.equal(resolverCalls, 0); assert.deepEqual(await commandAuthoritySnapshot(owner, intent.scope), before);
      archive = next;
    }
  });
  for (const purpose of ["record-export", "whole-closure-backup"] as const) await t.test(`signed A2 ${purpose} carries actual application non-null actor through two cross-workspace generations`, async () => {
    const { createPostgresRuntimeRepository } = await import("../database/postgres/runtime-repository.ts");
    const { executeTurn } = await import("../modules/runtime/public.ts");
    const { mapLocalFormalEvent } = await import("../modules/application/local-record-service.ts");
    const { fallbackCompositeSemanticSegments } = await import("../modules/presentation/semantic-segments.ts");
    const workspaceId = await freshWorkspace(purpose === "record-export" ? "actor_narrow" : "actor_whole");
    const initial = await library.instantiateRealmWorld(scopeFor(workspaceId), plan, `a2-actor-${purpose}`);
    const reader = createPostgresRealmRuntimeSaveReader(runtime);
    const restorer = createPostgresRealmRuntimeSaveRestorer(runtime, { resolveCommandPolicy, validateWorldBinding: async binding => { assert.ok(await resolveCommandPolicy(binding)); } });
    const initialData = await reader.load({ workspaceId, recordId: initial.recordId, principalId, purpose }); assert.ok(initialData);
    const actors = initialData.topology!.participants.filter(p => p.participantKind === "character" && p.sourcePrincipalId === principalId && p.controllerMode === "human");
    assert.equal(actors.length, 1); const actor = actors[0]!; assert.ok(actor.character);
    const sceneId = initialData.topology!.scenes[0]!.sourceSceneId;
    const publicPolicyId = initialData.topology!.visibilityPolicies.find(p => p.policyKind === "public")!.sourceVisibilityPolicyId;
    const literal = actor.sourceParticipantId;
    const payload: import("../modules/application/local-record-turn-runtime.ts").FormalEventPayload = {
      schemaVersion: 1, role: "player", participantId: actor.sourceParticipantId, speaker: literal, content: literal,
      segments: fallbackCompositeSemanticSegments(literal, "dialogue"),
    };
    const repo = createPostgresRuntimeRepository({ pool: runtime, workspaceId, mapFormalEvent: context => mapLocalFormalEvent(context as never) });
    const completed = await executeTurn({ recordId: initial.recordId, expectedRecordVersion: initialData.record.head.recordVersion,
      idempotencyKey: `a2-actor-write-${purpose}-${suffix}`, actorId: actor.sourceParticipantId, commandType: "player.utterance",
      payload: { runtimeScope: { sceneId, publicPolicyId, observerCharacterInstanceIds: [] } } }, {
      repository: repo, planner: { async plan() { return {}; } }, drafter: { async draft() { return {}; } }, validator: { async validate() { return {}; } },
      releaseBuilder: { async build() { return { formalEvents: [{ eventId: `a2-actor-event-${purpose}-${suffix}`, kind: "utterance.committed", payload }], outbox: [] }; } },
      idFactory: () => `a2_actor_turn_${randomUUID()}`, clock: () => new Date().toISOString(),
    }); assert.equal(completed.state, "completed");
    const written = (await owner.query("SELECT actor_participant_id,payload FROM events WHERE workspace_id=$1 AND record_id=$2 AND event_kind='utterance.committed'", [workspaceId, initial.recordId])).rows;
    assert.equal(written.length, 1); assert.equal(written[0].actor_participant_id, actor.sourceParticipantId);
    assert.equal(written[0].payload.__realmRuntimePayload.participantId, actor.sourceParticipantId);
    const map = await readMap(workspaceId, initial.worldlineId), prior = map.find(r => r.milestone_key === "prior")!, target = map.find(r => r.milestone_key === "target")!;
    const scope = { workspaceId, worldId, worldlineId: initial.worldlineId };
    for (const [row, version, semanticEventKey] of [[prior, 1, undefined], [target, 2, "synthetic.ready"]] as const) {
      const head = (await owner.query("SELECT head_tick::text,head_ordinal::text FROM worldlines WHERE workspace_id=$1 AND id=$2", [workspaceId, initial.worldlineId])).rows[0];
      const result = await withWorkspaceTransaction(runtime, workspaceId, async client => {
        await authorizeProjectFinanceWrite(client, { scope, principalId });
        return service(client).confirmMilestone({ scope, projectId: row.project_id, milestoneId: row.milestone_id, expectedProjectVersion: version,
          semanticEventKey, idempotencyKey: `a2-actor-fact-${purpose}-${version}-${suffix}`,
          evidence: { recordId: initial.recordId, sceneId, visibility: "public", expectedWorldCursor: { worldTick: Number(head.head_tick), worldOrdinal: Number(head.head_ordinal) } } });
      }); assert.equal(result.status, "committed");
    }
    const saved = await reader.load({ workspaceId, recordId: initial.recordId, principalId, purpose }); assert.ok(saved);
    assert.equal(saved.domain!.financeCommandGroups.length, 2);
    let archive = parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(saved));
    for (const [generation, targetWorkspace] of [[1, workspaceB], [2, workspaceA]] as const) {
      const input = { workspaceId: targetWorkspace, targetWorldId: worldId, principalId, sessionProof: sessionProofFor(principalId), archive,
        idempotencyKey: `a2-actor-restore-${purpose}-${generation}-${suffix}` };
      const restored = await restorer.restore(input);
      const loaded = await reader.load({ workspaceId: targetWorkspace, recordId: restored.recordId, principalId, purpose }); assert.ok(loaded);
      const next = parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(loaded));
      // Explicit Participant-namespace bijection by independently persisted keys;
      // reverse source order as a control against accidental positional matching.
      const identities = new Map<string, string>(), targets = new Set<string>();
      const addsNarrator = !archive.topology!.participants.some(p => p.participantKind === "narrator");
      assert.equal(next.topology!.participants.length, archive.topology!.participants.length + Number(addsNarrator));
      for (const old of [...archive.topology!.participants].reverse()) {
        const matches = next.topology!.participants.filter(p => p.speakingOrder === old.speakingOrder && p.participantKind === old.participantKind && p.controllerMode === old.controllerMode && p.sourcePrincipalId === old.sourcePrincipalId);
        assert.equal(matches.length, 1); const mapped = matches[0]!;
        assert.ok(!targets.has(mapped.sourceParticipantId)); targets.add(mapped.sourceParticipantId);
        identities.set(old.sourceParticipantId, mapped.sourceParticipantId); assert.notEqual(mapped.sourceParticipantId, old.sourceParticipantId);
        if (old.character) {
          assert.ok(mapped.character); assert.notEqual(mapped.character.sourceCharacterInstanceId, old.character.sourceCharacterInstanceId);
          assert.notEqual(mapped.character.sourceContinuityId, old.character.sourceContinuityId);
          assert.equal(mapped.character.continuity.continuityKey, old.character.continuity.continuityKey);
        }
      }
      const extra = next.topology!.participants.filter(p => !targets.has(p.sourceParticipantId));
      assert.equal(identities.size, archive.topology!.participants.length); assert.equal(targets.size, identities.size);
      assert.equal(extra.length, Number(addsNarrator));
      if (addsNarrator) {
        const narrator = extra[0]!;
        assert.equal(narrator.participantKind, "narrator"); assert.equal(narrator.character, null); assert.equal(narrator.sourcePrincipalId, null);
        assert.equal(narrator.controllerMode, "ai"); assert.equal(narrator.isActive, true); assert.equal(narrator.sharedControlEnabled, false);
        assert.equal(narrator.speakingOrder, Math.max(-1, ...archive.topology!.participants.map(p => p.speakingOrder)) + 1);
      }
      const oldEvents = archive.record.events.filter(e => e.kind === "utterance.committed"), events = next.record.events.filter(e => e.kind === "utterance.committed");
      assert.equal(oldEvents.length, 1); assert.equal(events.length, 1);
      const old = oldEvents[0]!, event = events[0]!;
      const outer = event.payload as Record<string, import("../modules/runtime/public.ts").JsonValue>;
      const oldOuter = old.payload as typeof outer;
      const metadata = outer.eventPayload as typeof outer, oldMetadata = oldOuter.eventPayload as typeof outer;
      const body = metadata.__realmRuntimePayload as typeof outer, oldBody = oldMetadata.__realmRuntimePayload as typeof outer;
      assert.equal(typeof oldOuter.actorParticipantId, "string"); const mapped = identities.get(oldOuter.actorParticipantId as string); assert.ok(mapped);
      assert.equal(outer.actorParticipantId, mapped); assert.equal(body.participantId, mapped);
      assert.notEqual(event.eventId, old.eventId); assert.notEqual(mapped, restored.recordId); assert.notEqual(mapped, event.eventId);
      assert.equal(body.content, literal); assert.equal(body.speaker, literal); assert.deepEqual(body.segments, oldBody.segments);
      const rows = (await owner.query("SELECT actor_participant_id,payload FROM events WHERE workspace_id=$1 AND record_id=$2 AND event_kind='utterance.committed'", [targetWorkspace, restored.recordId])).rows;
      assert.equal(rows.length, 1); assert.equal(rows[0].actor_participant_id, mapped); assert.equal(rows[0].payload.__realmRuntimePayload.participantId, mapped);
      assert.equal(next.domain!.financeCommandGroups.length, 2); assert.equal(next.domain!.commandMaterializations!.rows.length, 2);
      assert.equal((await restorer.restore(input)).replayed, true);
      assert.deepEqual(await reader.load({ workspaceId: targetWorkspace, recordId: restored.recordId, principalId, purpose }), loaded);
      archive = next;
    }
    assert.deepEqual(await reader.load({ workspaceId, recordId: initial.recordId, principalId, purpose }), saved);
  });
  // Backend barriers below use real server-reported lock dependencies, not sleeps
  // as evidence that a command or revocation reached the intended boundary.
  const waitForBlock = async (waiter: number, blocker: number) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const row = (await owner.query(`SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS blocked`, [waiter, blocker])).rows[0];
      if (row.blocked) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail(`backend ${waiter} never blocked on ${blocker}`);
  };
  const leaseBarrierClients = async (blockerPool: pg.Pool, waiterPool: pg.Pool, options: {
    restore?: () => Promise<unknown>;
    rollback?: (client: pg.PoolClient, index: number) => Promise<unknown>;
  } = {}) => {
    const clients: pg.PoolClient[] = [], pids: number[] = [], released = new Set<number>();
    const owned: Promise<PromiseSettledResult<unknown>>[] = [];
    const releaseAudit: { index: number; active: boolean; queued: number; destroyed: boolean }[] = [];
    let failed = false, primary: unknown;
    const settled: PromiseSettledResult<unknown>[] = [];
    const fail = (error: unknown) => { failed = true; primary = error; };
    const track = <T,>(promise: Promise<T>): Promise<T> => {
      // Attach a rejection owner immediately, without replacing the promise
      // subsequently checked by the success-path assertion.
      owned.push(promise.then(value => ({ status: "fulfilled" as const, value }), reason => ({ status: "rejected" as const, reason })));
      return promise;
    };
    const close = async () => {
      const errors: unknown[] = failed ? [primary] : [];
      const release = (index: number, destroy = false) => {
        if (released.has(index)) return;
        const client = clients[index]!;
        const driver = client as pg.PoolClient & { activeQuery?: unknown; queryQueue: unknown[] };
        const audit = { index, active: Boolean(driver.activeQuery), queued: driver.queryQueue.length, destroyed: destroy };
        try { assert.equal(audit.active, false); assert.equal(audit.queued, 0); }
        catch (error) { errors.push(error); destroy = true; audit.destroyed = true; }
        finally { released.add(index); releaseAudit.push(audit); client.release(destroy); }
      };
      const rollback = async (index: number) => {
        if (!clients[index] || released.has(index)) return;
        try { await (options.rollback ? options.rollback(clients[index]!, index) : clients[index]!.query("ROLLBACK")); }
        catch (error) { errors.push(error); release(index, true); }
      };
      try {
        // A broken lock holder is discarded before its waiter is awaited.
        await rollback(0);
        settled.push(...await Promise.all(owned));
        if (failed) for (const result of settled) if (result.status === "rejected" && result.reason !== primary) errors.push(result.reason);
        await rollback(1);
      } finally {
        for (let index = 0; index < clients.length; index++) release(index);
        try { await options.restore?.(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, "A2 barrier fixture failed; primary and cleanup errors preserved");
    };
    try {
      clients.push(await blockerPool.connect()); clients.push(await waiterPool.connect());
      for (const client of clients) pids.push((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number);
    } catch (error) { fail(error); await close(); throw error; }
    return { clients: clients as [pg.PoolClient, pg.PoolClient], pids, track, fail, close, settled, releaseAudit };
  };
  const assertBarrierClean = async (lease: Awaited<ReturnType<typeof leaseBarrierClients>>) => {
    // Do not observe through the just-released owner pool: that query may
    // reuse a barrier PID and report itself active, not a leaked transaction.
    const observer = new pg.Client({ connectionString: adminConnectionString! });
    try {
      await observer.connect();
      const observerPid = (await observer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
      assert.equal(lease.pids.includes(observerPid), false);
      const deadline = Date.now() + 5_000;
      let rows: pg.QueryResultRow[] = [];
      do {
        rows = (await observer.query("SELECT pid,state,xact_start FROM pg_stat_activity WHERE pid=ANY($1::int[])", [lease.pids])).rows;
        if (rows.every(row => row.state === "idle" && row.xact_start === null)) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      } while (Date.now() < deadline);
      assert.ok(rows.every(row => row.state === "idle" && row.xact_start === null), "no active query or idle-in-transaction barrier client remains");
      assert.deepEqual((await observer.query("SELECT pid,locktype FROM pg_locks WHERE pid=ANY($1::int[]) AND locktype IN ('transactionid','tuple','advisory')", [lease.pids])).rows, []);
      assert.equal(lease.releaseAudit.length, 2); assert.deepEqual(lease.releaseAudit.map(x => x.index).sort(), [0, 1]);
      assert.ok(lease.releaseAudit.every(x => !x.active && x.queued === 0));
      for (const pool of [owner, runtime]) { assert.equal(pool.waitingCount, 0); assert.equal(pool.totalCount, pool.idleCount); }
    } finally { await observer.end(); }
  };
  for (const direction of ["revoke-first", "command-first", "version-first", "rollback-error"] as const) await t.test(`barrier ${direction} fault after server-proven blocking preserves error and releases all owned work`, async () => {
    const workspaceId = await freshWorkspace(`cleanup_${direction.replaceAll("-", "_")}`);
    const instance = await library.instantiateRealmWorld(scopeFor(workspaceId), plan, `a2-cleanup-${direction}`);
    const rows = await readMap(workspaceId, instance.worldlineId), prior = rows.find(r => r.milestone_key === "prior")!, target = rows.find(r => r.milestone_key === "target")!;
    const scope = { workspaceId, worldId, worldlineId: instance.worldlineId };
    const sceneId = (await owner.query("SELECT id FROM scenes WHERE workspace_id=$1 AND record_id=$2", [workspaceId, instance.recordId])).rows[0].id as string;
    if (direction === "version-first") await service(runtime).confirmMilestone({ ...priorIntent, scope, projectId: prior.project_id, milestoneId: prior.milestone_id,
      idempotencyKey: `cleanup-prior-${direction}-${suffix}`, evidence: { ...priorIntent.evidence, recordId: instance.recordId, sceneId } });
    const before = await counts(workspaceId);
    const memberBefore = (await owner.query("SELECT role FROM player_world_memberships WHERE workspace_id=$1 AND world_id=$2 AND principal_id=$3", [workspaceId, worldId, principalId])).rows;
    const headBefore = (await owner.query("SELECT head_tick,head_ordinal FROM worldlines WHERE workspace_id=$1 AND id=$2", [workspaceId, instance.worldlineId])).rows;
    const projectBefore = (await owner.query("SELECT id,status,version FROM projects WHERE workspace_id=$1 ORDER BY id", [workspaceId])).rows;
    const milestonesBefore = (await owner.query("SELECT id,status,completion_record_id,completion_event_id FROM project_milestones WHERE workspace_id=$1 ORDER BY id", [workspaceId])).rows;
    const primary = new Error(`A2_BARRIER_PRIMARY_FAULT_${direction}`);
    const lease = await leaseBarrierClients(direction === "command-first" ? runtime : owner, direction === "command-first" ? owner : runtime, {
      restore: async () => owner.query("UPDATE player_world_memberships SET role='owner' WHERE workspace_id=$1 AND world_id=$2 AND principal_id=$3", [workspaceId, worldId, principalId]),
      ...(direction === "rollback-error" ? { rollback: (client: pg.PoolClient, index: number) => client.query(index === 0 ? "ROLLBACK TO SAVEPOINT a2_missing_cleanup" : "ROLLBACK") } : {}),
    });
    const [blocker, waiter] = lease.clients;
    let blocked = false;
    await assert.rejects((async () => {
      try {
        await blocker.query("BEGIN");
        if (direction === "command-first") {
          await blocker.query("SELECT set_config('realm.workspace_id',$1,true)", [workspaceId]);
          await authorizeProjectFinanceWrite(blocker, { scope, principalId });
          lease.track(waiter.query("UPDATE player_world_memberships SET role='observer' WHERE workspace_id=$1 AND world_id=$2 AND principal_id=$3", [workspaceId, worldId, principalId]));
        } else {
          if (direction === "version-first") await blocker.query("SELECT id FROM records WHERE workspace_id=$1 AND id=$2 FOR UPDATE", [workspaceId, instance.recordId]);
          else await blocker.query("UPDATE player_world_memberships SET role='observer' WHERE workspace_id=$1 AND world_id=$2 AND principal_id=$3", [workspaceId, worldId, principalId]);
          await waiter.query("BEGIN"); await waiter.query("SELECT set_config('realm.workspace_id',$1,true)", [workspaceId]);
          if (direction === "version-first") {
            await authorizeProjectFinanceWrite(waiter, { scope, principalId });
            lease.track(service(waiter).confirmMilestone({ ...targetIntent, scope, projectId: target.project_id, milestoneId: target.milestone_id,
              idempotencyKey: `cleanup-target-${suffix}`, evidence: { ...targetIntent.evidence, recordId: instance.recordId, sceneId } }));
          } else lease.track(authorizeProjectFinanceWrite(waiter, { scope, principalId }));
        }
        await waitForBlock(lease.pids[1]!, lease.pids[0]!); blocked = true; throw primary;
      } catch (error) { lease.fail(error); }
      finally { await lease.close(); }
    })(), error => {
      assert.ok(error instanceof AggregateError); assert.equal(error.errors[0], primary);
      assert.equal(error.errors.length, direction === "rollback-error" ? 2 : 1);
      if (direction === "rollback-error") assert.equal(error.errors[1].code, "3B001");
      return true;
    });
    assert.equal(blocked, true); assert.equal(lease.settled.length, 1); assert.equal(lease.settled[0]!.status, "fulfilled");
    assert.equal(lease.releaseAudit.filter(x => x.destroyed).length, Number(direction === "rollback-error"));
    await assertBarrierClean(lease);
    assert.deepEqual(await counts(workspaceId), before);
    assert.deepEqual((await owner.query("SELECT role FROM player_world_memberships WHERE workspace_id=$1 AND world_id=$2 AND principal_id=$3", [workspaceId, worldId, principalId])).rows, memberBefore);
    assert.deepEqual((await owner.query("SELECT head_tick,head_ordinal FROM worldlines WHERE workspace_id=$1 AND id=$2", [workspaceId, instance.worldlineId])).rows, headBefore);
    assert.deepEqual((await owner.query("SELECT id,status,version FROM projects WHERE workspace_id=$1 ORDER BY id", [workspaceId])).rows, projectBefore);
    assert.deepEqual((await owner.query("SELECT id,status,completion_record_id,completion_event_id FROM project_milestones WHERE workspace_id=$1 ORDER BY id", [workspaceId])).rows, milestonesBefore);
  });
  await t.test("concurrent membership revoke wins before runtime authorization; zero command writes", async () => {
    const lease = await leaseBarrierClients(owner, runtime, { restore: async () => owner.query(`UPDATE player_world_memberships SET role='owner' WHERE workspace_id=$1 AND world_id=$2 AND principal_id=$3`, [workspaceA,worldId,principalId]) });
    const [revoker, caller] = lease.clients;
    try {
      await revoker.query("BEGIN"); await revoker.query(`UPDATE player_world_memberships SET role='observer' WHERE workspace_id=$1 AND world_id=$2 AND principal_id=$3`, [workspaceA,worldId,principalId]);
      await caller.query("BEGIN"); await caller.query(`SELECT set_config('realm.workspace_id',$1,true)`, [workspaceA]);
      const blocker = (await revoker.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid as number, waiter = (await caller.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid as number;
      const before = await counts();
      const denied = authorizeProjectFinanceWrite(caller, { scope: sourceScope, principalId });
      const observed = lease.track(assert.rejects(denied, { code: "FORBIDDEN" }));
      await waitForBlock(waiter,blocker); await revoker.query("COMMIT"); await observed;
      await caller.query("ROLLBACK"); assert.deepEqual(await counts(),before);
    } catch (error) { lease.fail(error); }
    finally { await lease.close(); }
    await assertBarrierClean(lease);
  });
  await t.test("runtime outer authorization holds membership until command commit; revoke waits at actual backend", async () => {
    const workspaceA = await freshWorkspace("command_wins");
    const sourceScope = { workspaceId: workspaceA, worldId, worldlineId: source.worldlineId };
    const instance = await library.instantiateRealmWorld(scopeFor(workspaceA),plan,"a2-command-wins-barrier");
    const rows = await readMap(workspaceA,instance.worldlineId), prior = rows.find(r=>r.milestone_key==='prior')!, target = rows.find(r=>r.milestone_key==='target')!;
    const localScope = { ...sourceScope, worldlineId: instance.worldlineId };
    const scene = (await owner.query(`SELECT id FROM scenes WHERE workspace_id=$1 AND record_id=$2`,[workspaceA,instance.recordId])).rows[0].id as string;
    await service(runtime).confirmMilestone({...priorIntent,scope:localScope,projectId:prior.project_id,milestoneId:prior.milestone_id,idempotencyKey:`command-wins-prior-${suffix}`,evidence:{...priorIntent.evidence,recordId:instance.recordId,sceneId:scene}});
    const localTarget = {...targetIntent,scope:localScope,projectId:target.project_id as string,milestoneId:target.milestone_id as string,idempotencyKey:`command-wins-target-${suffix}`,evidence:{...targetIntent.evidence,recordId:instance.recordId,sceneId:scene}};
    const lease = await leaseBarrierClients(runtime, owner, { restore: async () => owner.query(`UPDATE player_world_memberships SET role='owner' WHERE workspace_id=$1 AND world_id=$2 AND principal_id=$3`, [workspaceA,worldId,principalId]) });
    const [caller, revoker] = lease.clients;
    try {
      await caller.query("BEGIN"); await caller.query(`SELECT set_config('realm.workspace_id',$1,true)`, [workspaceA]);
      await authorizeProjectFinanceWrite(caller, { scope: localScope,principalId });
      const blocker = (await caller.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid as number, waiter = (await revoker.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid as number;
      const revoke = lease.track(revoker.query(`UPDATE player_world_memberships SET role='observer' WHERE workspace_id=$1 AND world_id=$2 AND principal_id=$3`, [workspaceA,worldId,principalId]));
      await waitForBlock(waiter,blocker); assert.equal((await service(caller).confirmMilestone(localTarget)).status,"committed");
      await caller.query("COMMIT"); await revoke;
      await withWorkspaceTransaction(runtime, workspaceA, async client => { await assert.rejects(authorizeProjectFinanceWrite(client,{scope:localScope,principalId}),{code:"FORBIDDEN"}); });
    } catch (error) { lease.fail(error); }
    finally { await lease.close(); }
    await assertBarrierClean(lease);
  });
  await t.test("Record version switch committed while qualification waits is re-read and rejects before writes", async () => {
    const workspaceA = await freshWorkspace("version_barrier");
    const sourceScope = { workspaceId: workspaceA, worldId, worldlineId: source.worldlineId };
    const instance = await library.instantiateRealmWorld(scopeFor(workspaceA),plan,"a2-version-barrier");
    const rows = await readMap(workspaceA,instance.worldlineId), p = rows.find(r=>r.milestone_key==='prior')!, target = rows.find(r=>r.milestone_key==='target')!;
    const scene = (await owner.query(`SELECT id FROM scenes WHERE workspace_id=$1 AND record_id=$2`,[workspaceA,instance.recordId])).rows[0].id as string;
    const commandScope = {...sourceScope,worldlineId:instance.worldlineId};
    await service(runtime).confirmMilestone({...priorIntent,scope:commandScope,projectId:p.project_id,milestoneId:p.milestone_id,idempotencyKey:`barrier-prior-${suffix}`,evidence:{...priorIntent.evidence,recordId:instance.recordId,sceneId:scene}});
    const lease = await leaseBarrierClients(owner, runtime);
    const [switcher, caller] = lease.clients;
    try {
      await switcher.query("BEGIN"); await switcher.query(`SELECT id FROM records WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,[workspaceA,instance.recordId]);
      await caller.query("BEGIN"); await caller.query(`SELECT set_config('realm.workspace_id',$1,true)`,[workspaceA]); await authorizeProjectFinanceWrite(caller,{scope:commandScope,principalId});
      const blocker=(await switcher.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid as number,waiter=(await caller.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid as number;
      const before=(await owner.query(`SELECT count(*)::int AS n FROM project_finance_command_groups WHERE workspace_id=$1 AND worldline_id=$2`,[workspaceA,instance.worldlineId])).rows;
      const pending=service(caller).confirmMilestone({...targetIntent,scope:commandScope,projectId:target.project_id,milestoneId:target.milestone_id,idempotencyKey:`barrier-target-${suffix}`,evidence:{...targetIntent.evidence,recordId:instance.recordId,sceneId:scene}});
      const rejected=lease.track(assert.rejects(pending,{code:"BUSINESS_POLICY_MISSING"})); await waitForBlock(waiter,blocker);
      await switcher.query(`UPDATE records SET world_version='1.2.1' WHERE workspace_id=$1 AND id=$2`,[workspaceA,instance.recordId]); await switcher.query("COMMIT"); await rejected; await caller.query("ROLLBACK");
      assert.deepEqual((await owner.query(`SELECT count(*)::int AS n FROM project_finance_command_groups WHERE workspace_id=$1 AND worldline_id=$2`,[workspaceA,instance.worldlineId])).rows,before);
    } catch (error) { lease.fail(error); }
    finally { await lease.close(); }
    await assertBarrierClean(lease);
  });
});

test("full second-database migration reuses safe helper role, refuses poisoned role and resumes without partial helper grants", {
  skip: !adminConnectionString || !runtimeConnectionString || !process.env.REALM_SCRATCH_POSTGRES_CONTAINER ? skipReason : false,
  timeout: 90_000,
}, async t => {
  const { spawn } = await import("node:child_process");
  const { readdir, readFile } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const endEvent = (client: pg.Client) => {
    const ended = new Promise<void>((resolve,reject) => { client.once("end",resolve); client.once("error",reject); });
    void ended.catch(() => {}); // Own rejection immediately; finalizer still awaits the original promise.
    return ended;
  };
  const { withWorkspaceTransaction } = await import("../database/postgres/workspace-transaction.ts");
  const prefix = `realm_a2_multidb_${randomUUID().replaceAll("-", "")}`;
  const names = [`${prefix}_b`, `${prefix}_c`];
  for (const name of names) assert.match(name,/^realm_a2_multidb_[a-f0-9]{32}_[bc]$/);
  const urlFor = (base: string, database: string) => { const url = new URL(base); url.pathname = `/${database}`; return url.toString(); };
  const control = new pg.Client({ connectionString: urlFor(adminConnectionString!,"postgres") });
  const acquired: { client: pg.Client; ended?: Promise<unknown>; connected: boolean }[] = [];
  const created: string[] = [];
  let controlConnected = false, poisoned = false;
  const runtimeB = new pg.Pool({ connectionString: urlFor(runtimeConnectionString!,names[0]!),max: 1 });
  t.after(async () => {
    try {
      if (poisoned) await control.query("ALTER ROLE realm_command_policy_locker NOBYPASSRLS");
      const closures = await Promise.allSettled([
        runtimeB?.end() ?? Promise.resolve(),
        ...acquired.map(async resource => {
          await resource.client.end();
          if (resource.ended) await resource.ended;
        }),
      ]);
      const failures = closures.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map(r => r.reason),"A2 multi-database clients did not close");
      for (const name of created) {
        assert.deepEqual((await control.query("SELECT pid, state FROM pg_stat_activity WHERE datname = $1",[name])).rows,[],"exact target must have no backend before DROP");
        await control.query(`DROP DATABASE "${name}"`);
        assert.equal((await control.query("SELECT datname FROM pg_database WHERE datname=$1",[name])).rowCount,0);
      }
    } finally {
      const ended = controlConnected ? endEvent(control) : undefined;
      await control.end();
      if (ended) await ended;
    }
  });
  await control.connect(); controlConnected = true;
  assert.equal((await control.query("SELECT current_user AS role")).rows[0].role,"postgres");
  const open = async (database: string) => {
    const resource = { client: new pg.Client({ connectionString: urlFor(adminConnectionString!,database) }), connected: false } as { client: pg.Client; ended?: Promise<unknown>; connected: boolean };
    acquired.push(resource);
    await resource.client.connect(); resource.connected = true;
    resource.ended = endEvent(resource.client);
    return resource.client;
  };
  const originalName = decodeURIComponent(new URL(adminConnectionString!).pathname.slice(1));
  assert.ok(!names.includes(originalName));
  const original = await open(originalName);
  const roleSQL = `SELECT r.oid::text,r.rolname,r.rolcanlogin,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolinherit,r.rolreplication,r.rolbypassrls,r.rolconfig,
    shobj_description(r.oid,'pg_authid') AS marker,
    (SELECT count(*)::int FROM pg_auth_members m WHERE m.roleid=r.oid OR m.member=r.oid) AS memberships
    FROM pg_roles r WHERE r.rolname='realm_command_policy_locker'`;
  const baselineRole = (await original.query(roleSQL)).rows;
  assert.equal(baselineRole.length,1); assert.equal(baselineRole[0].rolbypassrls,false); assert.equal(baselineRole[0].memberships,0);
  assert.equal(baselineRole[0].marker,"REALM internal command policy lock owner v1");
  const catalog = async (client: pg.Client) => ({
    function: (await client.query(`SELECT p.prosecdef,p.proconfig,pg_get_functiondef(p.oid) AS definition,r.rolname AS owner,
      p.proacl::text AS acl,has_function_privilege('realm_runtime',p.oid,'EXECUTE') AS runtime_execute,
      EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute
      FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid=to_regprocedure('public.command_policy_record_version_locked(text,text,text,text,text,text)')`)).rows,
    tables: (await client.query("SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,r.rolname AS owner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner WHERE n.nspname='public' AND c.relname=ANY($1::text[]) ORDER BY c.relname",[["records","stories","project_story_links"]])).rows,
    columns: (await client.query(`SELECT c.relname,a.attname,
      has_column_privilege('realm_runtime',c.oid,a.attnum,'SELECT') AS runtime_select,
      has_column_privilege('realm_runtime',c.oid,a.attnum,'UPDATE') AS runtime_update,
      has_column_privilege('realm_command_policy_locker',c.oid,a.attnum,'SELECT') AS helper_select,
      has_column_privilege('realm_command_policy_locker',c.oid,a.attnum,'UPDATE') AS helper_update
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
      WHERE n.nspname='public' AND c.relname=ANY($1::text[]) AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum`,[["records","stories","project_story_links"]])).rows,
  });
  const baselineCatalog = await catalog(original);
  assert.equal(baselineCatalog.function.length,1); assert.equal(baselineCatalog.function[0].runtime_execute,true); assert.equal(baselineCatalog.function[0].public_execute,false);
  const directory = new URL("../database/postgres/migrations/",import.meta.url);
  const filenames = (await readdir(directory)).filter(n => n.endsWith(".sql")).sort();
  const expectedLedger = await Promise.all(filenames.map(async filename => ({ filename,checksum: createHash("sha256").update((await readFile(new URL(filename,directory),"utf8")).replace(/\r\n/g,"\n")).digest("hex") })));
  const ledgerSQL = "SELECT filename,checksum,applied_at::text FROM realm_schema_migrations ORDER BY filename";
  const originalLedger = (await original.query(ledgerSQL)).rows;
  assert.deepEqual(originalLedger.map(({ filename,checksum }) => ({ filename,checksum })),expectedLedger);
  const run = (database: string, script = "scripts/postgres-migrate.mjs") => new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve,reject) => {
    const args = script === "scripts/postgres-seed-demo.mjs"
      ? ["--experimental-strip-types","--import","./tests/helpers/postgres-pool-lifecycle.mjs",script]
      : ["--experimental-strip-types",script];
    const child = spawn(process.execPath,args,{ cwd: new URL("..",import.meta.url).pathname,env: { ...process.env,DATABASE_URL: urlFor(adminConnectionString!,database) },stdio: ["ignore","pipe","pipe"],timeout: 60_000 });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data",value => { stdout += value; });
    child.stderr.setEncoding("utf8").on("data",value => { stderr += value; });
    child.once("error",reject); child.once("close",(code,signal) => resolve({ code,signal,stdout,stderr }));
  });
  for (const name of names) {
    assert.equal((await control.query("SELECT datname FROM pg_database WHERE datname=$1",[name])).rowCount,0);
    await control.query(`CREATE DATABASE "${name}" TEMPLATE template0`); created.push(name);
  }
  const [nameB,nameC] = names as [string,string];
  const b = await open(nameB), c = await open(nameC);
  assert.equal((await b.query("SELECT to_regclass('public.realm_schema_migrations') AS ledger")).rows[0].ledger,null);
  assert.deepEqual((await b.query(roleSQL)).rows,baselineRole);
  const installed = await run(nameB); assert.equal(installed.code,0,installed.stderr); assert.equal(installed.signal,null);
  assert.deepEqual(installed.stdout.split("\n").filter(l => l.startsWith("apply ")).map(l => l.slice(6)),filenames);
  const installedLedger = (await b.query(ledgerSQL)).rows;
  assert.deepEqual(installedLedger.map(({ filename,checksum }) => ({ filename,checksum })),expectedLedger);
  assert.deepEqual(await catalog(b),baselineCatalog); assert.deepEqual((await b.query(roleSQL)).rows,baselineRole);
  const repeated = await run(nameB); assert.equal(repeated.code,0,repeated.stderr); assert.equal(repeated.signal,null);
  assert.deepEqual(repeated.stdout.split("\n").filter(l => l.startsWith("skip  ")).map(l => l.slice(6)),filenames);
  assert.deepEqual((await b.query(ledgerSQL)).rows,installedLedger,"rerun must not rewrite checksums or applied_at");
  assert.deepEqual(await catalog(b),baselineCatalog);
  const seeded = await run(nameB,"scripts/postgres-seed-demo.mjs"); assert.equal(seeded.code,0,seeded.stderr); assert.equal(seeded.signal,null);
  const row = (await b.query("SELECT workspace_id,world_id,worldline_id,id,story_id,world_version FROM records WHERE status='active' ORDER BY id LIMIT 1")).rows[0]; assert.ok(row);
  const projectId = `project_multidb_${prefix}`;
  assert.equal((await b.query("INSERT INTO projects (workspace_id,world_id,worldline_id,id,kind,status,stage,title,currency,version) VALUES ($1,$2,$3,$4,'production','planned','planning','MultiDB helper fixture','JPY',1)",[row.workspace_id,row.world_id,row.worldline_id,projectId])).rowCount,1);
  assert.equal((await b.query("INSERT INTO project_story_links (workspace_id,world_id,worldline_id,id,project_id,story_id,link_kind) VALUES ($1,$2,$3,$4,$5,$6,'primary')",[row.workspace_id,row.world_id,row.worldline_id,`link_${prefix}`,projectId,row.story_id])).rowCount,1);
  await withWorkspaceTransaction(runtimeB,row.workspace_id,async client => {
    assert.equal((await client.query("SELECT current_user AS role")).rows[0].role,"realm_runtime");
    assert.deepEqual((await client.query("SELECT world_version FROM public.command_policy_record_version_locked($1, $2, $3, $4, $5, $6)",[row.workspace_id,row.world_id,row.worldline_id,row.id,row.story_id,projectId])).rows,[{ world_version: row.world_version }]);
  });
  await assert.rejects(withWorkspaceTransaction(runtimeB,row.workspace_id,client => client.query("UPDATE public.stories SET premise = premise WHERE false")),{ code: "42501" });
  const helperMigration = "0081_command_policy_record_lock.sql";
  assert.ok(filenames.includes(helperMigration));
  try {
    await control.query("ALTER ROLE realm_command_policy_locker BYPASSRLS"); poisoned = true;
    assert.equal((await c.query(roleSQL)).rows[0].rolbypassrls,true);
    const refused = await run(nameC);
    assert.equal(refused.code,1); assert.equal(refused.signal,null); assert.match(refused.stderr,/COMMAND_POLICY_LOCK_ROLE_UNSAFE/);
    assert.deepEqual(refused.stdout.split("\n").filter(l => l.startsWith("apply ")).map(l => l.slice(6)),filenames.filter(n => n < helperMigration));
    assert.deepEqual((await c.query(ledgerSQL)).rows.map(({ filename,checksum }) => ({ filename,checksum })),expectedLedger.filter(r => r.filename < helperMigration));
    const partial = await catalog(c);
    assert.deepEqual(partial.function,[]); assert.ok(partial.columns.length>0);
    assert.ok(partial.columns.every(r => !r.helper_select && !r.helper_update),"failed migration must not leave any helper column grants");
    assert.equal((await c.query(roleSQL)).rows[0].rolbypassrls,true,"CLI must reject, not silently repair a poisoned cluster role");
  } finally { await control.query("ALTER ROLE realm_command_policy_locker NOBYPASSRLS"); poisoned = false; }
  assert.deepEqual((await c.query(roleSQL)).rows,baselineRole);
  const resumed = await run(nameC); assert.equal(resumed.code,0,resumed.stderr); assert.equal(resumed.signal,null);
  assert.deepEqual(resumed.stdout.split("\n").filter(l => l.startsWith("apply ")).map(l => l.slice(6)),filenames.filter(n => n >= helperMigration));
  const resumedLedger = (await c.query(ledgerSQL)).rows;
  assert.deepEqual(resumedLedger.map(({ filename,checksum }) => ({ filename,checksum })),expectedLedger);
  assert.deepEqual(await catalog(c),baselineCatalog);
  const resumedRepeat = await run(nameC); assert.equal(resumedRepeat.code,0,resumedRepeat.stderr); assert.equal(resumedRepeat.signal,null);
  assert.deepEqual(resumedRepeat.stdout.split("\n").filter(l => l.startsWith("skip  ")).map(l => l.slice(6)),filenames);
  assert.deepEqual((await c.query(ledgerSQL)).rows,resumedLedger);
  assert.deepEqual((await original.query(roleSQL)).rows,baselineRole);
  assert.deepEqual(await catalog(original),baselineCatalog); assert.deepEqual((await original.query(ledgerSQL)).rows,originalLedger);
  t.diagnostic(`A2 full migration: ${expectedLedger.length} files; second DB fresh+idempotent; third DB poisoned refusal+safe resume+idempotent; source DB catalog/ledger unchanged`);
});
