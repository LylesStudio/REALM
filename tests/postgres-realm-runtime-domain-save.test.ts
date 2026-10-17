/**
 * Runtime domain save/restore integration: finance, Story Graph, facts and
 * inventory must survive a new worldline with every source identity remapped.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import {
  POSTGRES_DEMO_IDS,
  createPostgresRealmRuntimeSaveReader,
  createPostgresRealmRuntimeSaveRestorer,
} from "../database/postgres/public.ts";
import {
  buildRealmRuntimeSaveArchive,
  parseRealmRuntimeSaveArchive,
} from "../modules/world-transfer/realm-runtime-save.ts";

const adminConnectionString = process.env.DATABASE_URL;
const runtimeConnectionString = process.env.REALM_RUNTIME_DATABASE_URL;

const SCOPE = {
  workspaceId: POSTGRES_DEMO_IDS.workspace,
  worldId: POSTGRES_DEMO_IDS.world,
  worldlineId: POSTGRES_DEMO_IDS.worldline,
  storyId: POSTGRES_DEMO_IDS.story,
  recordId: POSTGRES_DEMO_IDS.record,
};

function hex64(seed: string): string {
  void seed;
  return "0".repeat(64);
}

test(
  "runtime domain save/restore preserves finance, Story unlocks, facts, relationships and inventory",
  { skip: !adminConnectionString || !runtimeConnectionString, timeout: 300_000 },
  async (t) => {
    const owner = new pg.Pool({ connectionString: adminConnectionString, max: 2 });
    const runtime = new pg.Pool({ connectionString: runtimeConnectionString, max: 2 });
    owner.on("error", () => {});
    runtime.on("error", () => {});
    t.after(async () => {
      await runtime.end();
      await owner.end();
    });

    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const projectId = `domain_project_${suffix}`;
    const milestoneId = `domain_milestone_${suffix}`;
    const linkId = `domain_link_${suffix}`;
    const budgetId = `domain_budget_${suffix}`;
    const accountId = `domain_account_${suffix}`;
    const expenseId = `domain_expense_${suffix}`;
    const incomeId = `domain_income_${suffix}`;
    const groupId = `domain_group_${suffix}`;
    const obligationId = `domain_obligation_${suffix}`;
    const settlementId = `domain_settlement_${suffix}`;
    const nodeId = `domain_node_${suffix}`;
    const unlockId = `domain_unlock_${suffix}`;
    const grantCommandId = `domain_grant_${suffix}`;
    const relationshipCommandId = `domain_relation_${suffix}`;
    const assessmentCommandId = `domain_assess_${suffix}`;
    const assessmentId = `domain_assessment_${suffix}`;
    const relationshipId = `domain_revision_${suffix}`;
    const sourceEventId = POSTGRES_DEMO_IDS.openingEvent;

    // These are server-side facts in the source worldline. The test deliberately
    // does not construct runtime/domain.json by hand: the reader must project it.
    await owner.query(
      `INSERT INTO projects (
         workspace_id, world_id, worldline_id, id, kind, status, stage,
         title, currency, deadline, owner_id, version
       ) VALUES ($1, $2, $3, $4, 'production', 'active', 'funding',
                 'Domain restore rehearsal', 'JPY', NULL, NULL, 3)`,
      [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, projectId],
    );
    await owner.query(
      `INSERT INTO project_story_links (
         workspace_id, world_id, worldline_id, id, project_id, story_id, link_kind
       ) VALUES ($1, $2, $3, $4, $5, $6, 'primary')`,
      [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, linkId, projectId, SCOPE.storyId],
    );
    await owner.query(
      `INSERT INTO project_milestones (
         workspace_id, world_id, worldline_id, id, project_id, sequence,
         title, status, due_on, completion_record_id, completion_event_id
       ) VALUES ($1, $2, $3, $4, $5, 1, 'First rehearsal', 'completed', NULL, NULL, NULL)`,
      [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, milestoneId, projectId],
    );
    await owner.query(
      `INSERT INTO budget_allocations (
         workspace_id, world_id, worldline_id, id, project_id, category,
         amount_minor, currency, version
       ) VALUES ($1, $2, $3, $4, $5, 'studio', 9000, 'JPY', 2)`,
      [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, budgetId, projectId],
    );
    await owner.query(
      `INSERT INTO finance_accounts (
         workspace_id, world_id, worldline_id, id, currency, status,
         opening_balance_minor
       ) VALUES ($1, $2, $3, $4, 'JPY', 'active', 10000)`,
      [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, accountId],
    );
    await owner.query(
      `INSERT INTO ledger_entries (
         workspace_id, world_id, worldline_id, id, account_id, kind,
         direction, amount_minor, currency, category, memo, project_id,
         source_record_id, source_event_id, occurred_at, idempotency_key
       ) VALUES
         ($1, $2, $3, $4, $5, 'expense', 'expense', 3000, 'JPY', 'studio',
          'rehearsal fee', $6, $7, $8, CURRENT_TIMESTAMP, $9),
         ($1, $2, $3, $10, $5, 'income', 'income', 5000, 'JPY', 'presale',
          'advance ticket sales', $6, $7, $8, CURRENT_TIMESTAMP, $11)`,
      [
        SCOPE.workspaceId,
        SCOPE.worldId,
        SCOPE.worldlineId,
        expenseId,
        accountId,
        projectId,
        SCOPE.recordId,
        sourceEventId,
        `domain-expense-${suffix}`,
        incomeId,
        `domain-income-${suffix}`,
      ],
    );
    await owner.query(
      `INSERT INTO project_finance_command_groups (
         workspace_id, world_id, worldline_id, id, idempotency_key,
         request_fingerprint, state, result_manifest, rejection_code,
         policy_version, source_record_id, completed_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'committed', $7::jsonb, NULL,
                 'project-finance:v1', $8, CURRENT_TIMESTAMP)`,
      [
        SCOPE.workspaceId,
        SCOPE.worldId,
        SCOPE.worldlineId,
        groupId,
        `domain-group-${suffix}`,
        hex64(`group-${suffix}`),
        JSON.stringify({ projectId, ledgerEntryIds: [expenseId, incomeId] }),
        SCOPE.recordId,
      ],
    );
    await owner.query(
      `INSERT INTO obligations (
         workspace_id, world_id, worldline_id, id, project_id, kind,
         status, principal_minor, outstanding_minor, share_bps,
         undelivered_count, due_on, version
       ) VALUES ($1, $2, $3, $4, $5, 'loan', 'open', 5000, 3000,
                 NULL, 0, NULL, 2)`,
      [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, obligationId, projectId],
    );
    await owner.query(
      `INSERT INTO obligation_settlements (
         workspace_id, world_id, worldline_id, id, obligation_id,
         ledger_entry_id, kind, amount_minor
       ) VALUES ($1, $2, $3, $4, $5, $6, 'repayment', 2000)`,
      [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, settlementId, obligationId, expenseId],
    );
    await owner.query(
      `INSERT INTO story_node_instances (
         workspace_id, world_id, worldline_id, story_id, node_key, id,
         state, revision, record_id, definition_hash,
         unlock_evidence_event_ids, unlock_evidence, unlocked_at, activated_at
       ) VALUES ($1, $2, $3, $4, 'first_rehearsal', $5, 'completed', 4, $6, $7,
                 $8::text[], $9::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        SCOPE.workspaceId,
        SCOPE.worldId,
        SCOPE.worldlineId,
        SCOPE.storyId,
        nodeId,
        SCOPE.recordId,
        hex64("node"),
        [sourceEventId],
        JSON.stringify({ projectId, milestoneId }),
      ],
    );
    await owner.query(
      `INSERT INTO story_unlock_ledger (
         workspace_id, world_id, worldline_id, story_id, id,
         story_node_instance_id, node_key, transition, idempotency_key,
         record_id, evidence_event_ids, evidence_hash, evidence
       ) VALUES ($1, $2, $3, $4, $5, $6, 'first_rehearsal', 'unlocked', $7,
                 $8, $9::text[], $10, $11::jsonb)`,
      [
        SCOPE.workspaceId,
        SCOPE.worldId,
        SCOPE.worldlineId,
        SCOPE.storyId,
        unlockId,
        nodeId,
        `domain-unlock-${suffix}`,
        SCOPE.recordId,
        [sourceEventId],
        hex64("unlock"),
        JSON.stringify({ milestoneId }),
      ],
    );
    await owner.query(
      `INSERT INTO committed_fact_commands (
         workspace_id, world_id, worldline_id, id, idempotency_key,
         request_fingerprint, kind, result_manifest
       ) VALUES
         ($1, $2, $3, $4, $5, $6, 'inventory_granted', $7::jsonb),
         ($1, $2, $3, $8, $9, $10, 'relationship_revised', $11::jsonb),
         ($1, $2, $3, $12, $13, $14, 'performance_assessed', $15::jsonb)`,
      [
        SCOPE.workspaceId,
        SCOPE.worldId,
        SCOPE.worldlineId,
        grantCommandId,
        `domain-grant-${suffix}`,
        hex64(`grant-${suffix}`),
        JSON.stringify({ recordId: SCOPE.recordId, characterInstanceId: POSTGRES_DEMO_IDS.playerInstance, assetDefinitionId: POSTGRES_DEMO_IDS.signalLanternAsset, quantity: 1 }),
        relationshipCommandId,
        `domain-relation-${suffix}`,
        hex64(`relation-${suffix}`),
        JSON.stringify({ recordId: SCOPE.recordId, sourceEventId }),
        assessmentCommandId,
        `domain-assess-${suffix}`,
        hex64(`assess-${suffix}`),
        JSON.stringify({ recordId: SCOPE.recordId, score: 30 }),
      ],
    );
    await owner.query(
      `INSERT INTO performance_assessments (
         workspace_id, world_id, worldline_id, record_id, id,
         policy_version, score, evidence_event_ids,
         evidence_snapshot_hash, command_id
       ) VALUES ($1, $2, $3, $4, $5, 'structured-factors:v1', 30,
                 $6::text[], $7, $8)`,
      [
        SCOPE.workspaceId,
        SCOPE.worldId,
        SCOPE.worldlineId,
        SCOPE.recordId,
        assessmentId,
        [sourceEventId],
        hex64("assessment"),
        assessmentCommandId,
      ],
    );
    await owner.query(
      `INSERT INTO member_relationship_revisions (
         workspace_id, world_id, worldline_id, id, subject_entity_key,
         object_entity_key, relation_kind, revision_ordinal,
         source_event_id, source_record_id, occurred_tick, occurred_ordinal,
         command_id
       ) VALUES ($1, $2, $3, $4, 'member:player', 'member:scout', 'trust', 1,
                 $5, $6, 0, 1, $7)`,
      [
        SCOPE.workspaceId,
        SCOPE.worldId,
        SCOPE.worldlineId,
        relationshipId,
        sourceEventId,
        SCOPE.recordId,
        relationshipCommandId,
      ],
    );
    await owner.query(
      `INSERT INTO character_assets (
         workspace_id, world_id, worldline_id, record_id,
         character_instance_id, asset_definition_id, quantity, revision, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, 1, 0, '{}'::jsonb)
       ON CONFLICT (workspace_id, record_id, character_instance_id, asset_definition_id)
       DO UPDATE SET quantity = EXCLUDED.quantity, revision = EXCLUDED.revision, metadata = EXCLUDED.metadata`,
      [
        SCOPE.workspaceId,
        SCOPE.worldId,
        SCOPE.worldlineId,
        SCOPE.recordId,
        POSTGRES_DEMO_IDS.playerInstance,
        POSTGRES_DEMO_IDS.signalLanternAsset,
      ],
    );

    const reader = createPostgresRealmRuntimeSaveReader(runtime);
    const archive = await reader.load({ workspaceId: SCOPE.workspaceId, recordId: SCOPE.recordId });
    assert.ok(archive);
    assert.ok(archive.domain);
    assert.equal(archive.domain.projects.length, 1);
    assert.equal(archive.domain.projects[0]!.version, 3);
    assert.equal(archive.domain.ledgerEntries.length, 2);
    assert.equal(archive.domain.storyNodes.length, 1);
    assert.equal(archive.domain.storyUnlockLedger.length, 1);
    assert.equal(archive.domain.committedFactCommands.length, 3);
    assert.equal(archive.domain.performanceAssessments.length, 1);
    assert.equal(archive.domain.memberRelationshipRevisions.length, 1);
    assert.equal(archive.domain.characterAssets.length, 1);

    const reparsed = parseRealmRuntimeSaveArchive(buildRealmRuntimeSaveArchive(archive));
    assert.deepEqual(reparsed.domain, archive.domain);

    const restorer = createPostgresRealmRuntimeSaveRestorer(runtime);
    const restored = await restorer.restore({
      workspaceId: SCOPE.workspaceId,
      principalId: POSTGRES_DEMO_IDS.principal,
      archive,
      targetWorldId: SCOPE.worldId,
      idempotencyKey: `domain-restore-${suffix}`,
    });
    assert.equal(restored.replayed, false);
    assert.equal(restored.importedDomainProjectCount, 1);
    assert.equal(restored.importedDomainLedgerEntryCount, 2);
    assert.equal(restored.importedDomainStoryNodeCount, 1);
    assert.equal(restored.importedDomainUnlockCount, 1);
    assert.equal(restored.importedDomainFactCommandCount, 3);
    assert.equal(restored.importedDomainAssessmentCount, 1);
    assert.equal(restored.importedDomainRelationshipRevisionCount, 1);
    assert.equal(restored.importedDomainAssetCount, 1);

    const cash = await owner.query<{ balance: string }>(
      `SELECT (opening_balance_minor + COALESCE(SUM(
         CASE WHEN direction = 'income' THEN amount_minor ELSE -amount_minor END
       ), 0))::text AS balance
       FROM finance_accounts AS account
       LEFT JOIN ledger_entries AS entry
         ON entry.workspace_id = account.workspace_id
        AND entry.world_id = account.world_id
        AND entry.worldline_id = account.worldline_id
        AND entry.account_id = account.id
       WHERE account.workspace_id = $1 AND account.worldline_id = $2
         AND account.id LIKE 'finance_account_restore_%'
       GROUP BY account.opening_balance_minor`,
      [SCOPE.workspaceId, restored.worldlineId],
    );
    assert.equal(cash.rows[0]?.balance, "12000");

    const targetState = await owner.query<{
      projects: string;
      milestones: string;
      obligations: string;
      settlements: string;
      nodes: string;
      unlocks: string;
      facts: string;
      assessments: string;
      relationships: string;
      assets: string;
      ledger: string;
    }>(
      `SELECT
         (SELECT count(*)::text FROM projects WHERE worldline_id = $1) AS projects,
         (SELECT count(*)::text FROM project_milestones WHERE worldline_id = $1) AS milestones,
         (SELECT count(*)::text FROM obligations WHERE worldline_id = $1) AS obligations,
         (SELECT count(*)::text FROM obligation_settlements WHERE worldline_id = $1) AS settlements,
         (SELECT count(*)::text FROM story_node_instances WHERE worldline_id = $1) AS nodes,
         (SELECT count(*)::text FROM story_unlock_ledger WHERE worldline_id = $1) AS unlocks,
         (SELECT count(*)::text FROM committed_fact_commands WHERE worldline_id = $1) AS facts,
         (SELECT count(*)::text FROM performance_assessments WHERE worldline_id = $1) AS assessments,
         (SELECT count(*)::text FROM member_relationship_revisions WHERE worldline_id = $1) AS relationships,
         (SELECT count(*)::text FROM character_assets WHERE worldline_id = $1) AS assets,
         (SELECT count(*)::text FROM ledger_entries WHERE worldline_id = $1) AS ledger`,
      [restored.worldlineId],
    );
    assert.deepEqual(targetState.rows[0], {
      projects: "1",
      milestones: "1",
      obligations: "1",
      settlements: "1",
      nodes: "1",
      unlocks: "1",
      facts: "3",
      assessments: "1",
      relationships: "1",
      assets: "1",
      ledger: "2",
    });

    const replay = await restorer.restore({
      workspaceId: SCOPE.workspaceId,
      principalId: POSTGRES_DEMO_IDS.principal,
      archive,
      targetWorldId: SCOPE.worldId,
      idempotencyKey: `domain-restore-${suffix}`,
    });
    assert.equal(replay.replayed, true);
    assert.deepEqual(
      await owner.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ledger_entries WHERE worldline_id = $1`,
        [restored.worldlineId],
      ).then((result) => result.rows[0]),
      { count: "2" },
    );

    // The source projection and idempotent replay are the acceptance boundary.
    assert.ok(restored.recordId.startsWith("record_restore_"));
  },
);
