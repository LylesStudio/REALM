import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

import { endSharedRuntimePools } from "../app/api/world-scope.ts";
import { createPostgresCommittedFactCommandStore } from "../database/postgres/committed-fact-command-repository.ts";
import { createCommittedFactCommandService } from "../modules/application/committed-fact-command.ts";
import { createPerformanceCommandTrust, executePerformanceAssessmentCommand } from "../modules/application/performance-command-executor.ts";
import { POSTGRES_DEMO_IDS, seedPostgresDemo } from "../database/postgres/public.ts";

const adminConnectionString = process.env.DATABASE_URL;
const runtimeConnectionString = process.env.REALM_RUNTIME_DATABASE_URL;
const skipReason = "requires the isolated PostgreSQL runtime runner";
const DEMO_SCOPE = {
  workspaceId: "ws_demo",
  worldId: "world_ember_coast",
  worldlineId: "worldline_origin",
} as const;

test(
  "inventory update, member relationship revision, and structured score read back from PostgreSQL",
  { skip: !adminConnectionString || !runtimeConnectionString ? skipReason : false, timeout: 120_000 },
  async (t) => {
    assert.ok(process.env.REALM_SCRATCH_POSTGRES_CONTAINER?.startsWith("realm"), "disposable runtime runner required before pool allocation");
    const admin = new pg.Pool({ connectionString: adminConnectionString!, max: 1 });
    const runtime = new pg.Pool({ connectionString: runtimeConnectionString!, max: 1 });
    t.after(async () => {
      // Immutable facts and their private witnesses belong to cluster teardown.
      // Close resources even when setup fails; never disable history/FK triggers.
      await endSharedRuntimePools();
      await Promise.all([admin.end(), runtime.end()]);
    });
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    // Retained immutable rows must not change another file's demo/default scope.
    const SCOPE = { ...DEMO_SCOPE, workspaceId: `ws_fact_${suffix}` };
    await seedPostgresDemo(admin, { workspaceId: SCOPE.workspaceId, principalId: POSTGRES_DEMO_IDS.principal });
    const storyId = `story_fact_${suffix}`;
    const recordId = `record_fact_${suffix}`;
    const sceneId = `scene_fact_${suffix}`;
    const policyId = `policy_fact_${suffix}`;
    const continuityId = `continuity_fact_${suffix}`;
    const instanceId = `instance_fact_${suffix}`;
    const assetId = `asset_fact_${suffix}`;
    const grantAssetId = `asset_grant_${suffix}`;
    const projectId = `project_fact_${suffix}`;
    const milestoneId = `milestone_fact_${suffix}`;
    const eventId = `event_fact_${suffix}`;
    const memoryBefore = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM relationship_states WHERE workspace_id = $1`,
      [SCOPE.workspaceId],
    );
    const cursor = await admin.query<{ calendar_id: string; next_ordinal: string }>(
      `SELECT calendar_id,
              (SELECT COALESCE(max(world_ordinal), 0) + 1 FROM events
                WHERE workspace_id = $1 AND worldline_id = $3)::text AS next_ordinal
       FROM events
       WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND id = 'event_opening'`,
      [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId],
    );
    const calendarId = cursor.rows[0]?.calendar_id;
    const nextOrdinal = cursor.rows[0]?.next_ordinal;
    assert.ok(calendarId && nextOrdinal);



    await admin.query(
      `INSERT INTO stories (
         workspace_id, world_id, worldline_id, id, title, status, premise, start_tick, start_ordinal
       ) VALUES ($1, $2, $3, $4, 'Fact story', 'active', '', 0, 0)`,
      [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, storyId],
    );
    await admin.query(
      `INSERT INTO records (
         workspace_id, world_id, worldline_id, story_id, id, title, status, start_tick, start_ordinal
       ) VALUES ($1, $2, $3, $4, $5, 'Fact record', 'active', 0, 0)`,
      [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, storyId, recordId],
    );
    await admin.query(
      `INSERT INTO scenes (
         workspace_id, world_id, worldline_id, record_id, id, title, status,
         location, objective, start_tick, start_ordinal
       ) VALUES ($1, $2, $3, $4, $5, 'Fact scene', 'active', '', '', 0, 0)`,
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
       ) VALUES ($1, $2, $3, $4, 1, 2)`,
      [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, recordId],
    );
    await admin.query(
      `INSERT INTO character_continuities (
         workspace_id, world_id, worldline_id, definition_id, id,
         continuity_key, status, born_tick, born_ordinal
       ) VALUES ($1, $2, $3, 'char_def_player', $4, $5, 'active', 0, 0)`,
      [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, continuityId, `fact_${suffix}`],
    );
    await admin.query(
      `INSERT INTO character_instances (
         workspace_id, world_id, worldline_id, record_id, continuity_id, id,
         controller_mode, instantiated_tick, instantiated_ordinal,
         inheritance_cutoff_tick, inheritance_cutoff_ordinal
       ) VALUES ($1, $2, $3, $4, $5, $6, 'ai', 0, 0, 0, 0)`,
      [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, recordId, continuityId, instanceId],
    );
    await admin.query(
      `INSERT INTO asset_definitions (
         workspace_id, world_id, id, asset_key, title, rule_pack_key, consumable
       ) VALUES ($1, $2, $3, $4, 'Fact asset', 'test-pack', true)`,
      [SCOPE.workspaceId, SCOPE.worldId, assetId, `fact_${suffix}`],
    );
    await admin.query(
      `INSERT INTO asset_definitions (
         workspace_id, world_id, id, asset_key, title, rule_pack_key, consumable
       ) VALUES ($1, $2, $3, $4, 'Granted asset', 'test-pack', false)`,
      [SCOPE.workspaceId, SCOPE.worldId, grantAssetId, `grant_${suffix}`],
    );
    await admin.query(
      `INSERT INTO character_assets (
         workspace_id, world_id, worldline_id, record_id,
         character_instance_id, asset_definition_id, quantity
       ) VALUES ($1, $2, $3, $4, $5, $6, 2)`,
      [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, recordId, instanceId, assetId],
    );
    await admin.query(
      `INSERT INTO events (
         workspace_id, world_id, worldline_id, record_id, scene_id, id,
         record_version, record_ordinal, batch_index, event_kind,
         speaker_name, content, payload, visibility_policy_id,
         world_tick, world_ordinal, calendar_id, display_time
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         1, 1, 0, 'narration.committed',
         '', 'fact', $7::jsonb, $8,
         9, $9, $10, ''
       )`,
      [
        SCOPE.workspaceId,
        SCOPE.worldId,
        SCOPE.worldlineId,
        recordId,
        sceneId,
        eventId,
        JSON.stringify({ note: "client score is not authority" }),
        policyId,
        nextOrdinal,
        calendarId,
      ],
    );

    // Keep the source head coherent with the actually inserted opening fact.
    await admin.query(
      `UPDATE record_heads SET last_event_id=$3,last_world_tick=9,last_world_ordinal=$4::bigint
       WHERE workspace_id=$1 AND record_id=$2`,
      [SCOPE.workspaceId, recordId, eventId, nextOrdinal],
    );
    await admin.query(
      `UPDATE worldlines SET head_tick=9,head_ordinal=$4::bigint
       WHERE workspace_id=$1 AND world_id=$2 AND id=$3`,
      [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, nextOrdinal],
    );
    const service = createCommittedFactCommandService({
      store: createPostgresCommittedFactCommandStore(runtime),
      // Explicit test-owned enablement; production remains durableTransport:false.
      atomicPerformanceExecutor: async (scope, intent) => (await executePerformanceAssessmentCommand(runtime, {
        ...createPerformanceCommandTrust(scope, POSTGRES_DEMO_IDS.principal),
        enablement: { schema: true, durableTransport: true },
      }, intent)).result,
    });
    const adjusted = await service.adjustInventory({
      scope: SCOPE,
      recordId,
      characterInstanceId: instanceId,
      assetDefinitionId: assetId,
      delta: -1,
      sourceEventId: eventId,
      expectedRevision: 0,
      idempotencyKey: `inv_${suffix}`,
    });
    assert.equal(adjusted.quantity, 1);
    assert.equal(adjusted.revision, 1);
    const holding = await admin.query<{ quantity: string; revision: string }>(
      `SELECT quantity::text, revision::text
       FROM character_assets
       WHERE workspace_id = $1 AND record_id = $2 AND asset_definition_id = $3`,
      [SCOPE.workspaceId, recordId, assetId],
    );
    assert.equal(holding.rows[0]?.quantity, "1");
    assert.equal(holding.rows[0]?.revision, "1");

    const granted = await service.grantInventory({
      scope: SCOPE,
      recordId,
      characterInstanceId: instanceId,
      assetDefinitionId: grantAssetId,
      quantity: 1,
      sourceEventId: eventId,
      idempotencyKey: `grant_${suffix}`,
    });
    assert.equal(granted.quantity, 1);
    assert.equal(granted.revision, 0);
    const grantedHolding = await admin.query<{ quantity: string }>(
      `SELECT quantity::text FROM character_assets
       WHERE workspace_id = $1 AND record_id = $2 AND asset_definition_id = $3`,
      [SCOPE.workspaceId, recordId, grantAssetId],
    );
    assert.equal(grantedHolding.rows[0]?.quantity, "1");

    await admin.query(
      `INSERT INTO projects (
         workspace_id, world_id, worldline_id, id, kind, status, stage, title
       ) VALUES ($1, $2, $3, $4, 'production', 'active', 'delivery', 'Fact project')`,
      [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, projectId],
    );
    await admin.query(
      `INSERT INTO project_milestones (
         workspace_id, world_id, worldline_id, id, project_id, sequence, title,
         status, completion_record_id, completion_event_id
       ) VALUES ($1, $2, $3, $4, $5, 1, 'First show', 'completed', $6, $7)`,
      [SCOPE.workspaceId, SCOPE.worldId, SCOPE.worldlineId, milestoneId, projectId, recordId, eventId],
    );

    const revised = await service.reviseRelationship({
      scope: SCOPE,
      subjectEntityKey: `member_a_${suffix}`,
      objectEntityKey: `member_b_${suffix}`,
      relationKind: "kept_word",
      sourceEventId: eventId,
      idempotencyKey: `rel_${suffix}`,
    });
    assert.equal(revised.revisionOrdinal, 1);
    const revision = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM member_relationship_revisions
       WHERE workspace_id = $1 AND source_event_id = $2`,
      [SCOPE.workspaceId, eventId],
    );
    assert.equal(revision.rows[0]?.n, "1");
    const memoryAfter = await admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM relationship_states WHERE workspace_id = $1`,
      [SCOPE.workspaceId],
    );
    assert.equal(memoryAfter.rows[0]?.n, memoryBefore.rows[0]?.n);

    const assessed = await service.recordPerformanceAssessment({
      scope: SCOPE,
      recordId,
      policyVersion: "structured-factors:v1",
      evidenceEventIds: [eventId],
      idempotencyKey: `judge_${suffix}`,
    });
    assert.equal(assessed.score, 30);
    assert.equal(assessed.goalTransition, null);
    const stored = await admin.query<{ score: string }>(
      `SELECT score::text FROM performance_assessments WHERE workspace_id = $1 AND record_id = $2`,
      [SCOPE.workspaceId, recordId],
    );
    assert.equal(stored.rows[0]?.score, "30");
    const witness = await admin.query<{ command_id: string; assessment_id: string }>(
      `SELECT command_id,assessment_id FROM performance_evidence_snapshots
       WHERE workspace_id=$1 AND assessment_id=$2`,
      [SCOPE.workspaceId, assessed.assessmentId],
    );
    assert.deepEqual(witness.rows, [{ command_id: assessed.commandId, assessment_id: assessed.assessmentId }]);
  },
);
