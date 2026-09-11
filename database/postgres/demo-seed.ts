import type { PoolClient } from "pg";
import {
  DEMO_ASSET_DEFINITION,
  DEMO_SKILL_DEFINITION,
  DEMO_STANCE_DEFINITION,
} from "../../modules/actions/demo-definitions.ts";
import {
  withWorkspaceTransaction,
  type WorkspaceDatabase,
} from "./workspace-transaction.ts";

export const POSTGRES_DEMO_IDS = {
  workspace: "ws_demo",
  world: "world_ember_coast",
  worldline: "worldline_origin",
  story: "story_silent_bell",
  record: "record_first_watch",
  scene: "scene_north_breakwater",
  principal: "principal_demo_player",
  playerDefinition: "char_def_player",
  scoutDefinition: "char_def_scout",
  scholarDefinition: "char_def_scholar",
  playerContinuity: "continuity_player",
  scoutContinuity: "continuity_scout",
  scholarContinuity: "continuity_scholar",
  playerInstance: "char_inst_player",
  scoutInstance: "char_inst_scout",
  scholarInstance: "char_inst_scholar",
  playerParticipant: "participant_player",
  scoutParticipant: "participant_scout",
  scholarParticipant: "participant_scholar",
  publicPolicy: "visibility_public_v1",
  openingEvent: "event_opening",
  observationSkill: "skill_careful_observation",
  signalLanternAsset: "asset_signal_lantern",
  guardedWatchEffect: "effect_guarded_watch",
} as const;

export interface DemoSeedScope {
  workspaceId?: string;
  principalId?: string;
  /** Immutable world-creation choice. Existing fixtures are never rewritten. */
  omniscientPlayerCharacter?: boolean;
  /** Initial preference only. A later user change is preserved by repeat seeding. */
  canViewDynamicKnowledge?: boolean;
}

interface RequiredDemoFixture {
  workspaceId: string;
  principalId: string;
  omniscientPlayerCharacter: boolean;
  canViewDynamicKnowledge: boolean;
}

interface SeedInsert {
  sql: string;
  values(input: RequiredDemoFixture): unknown[];
}

/** Idempotently inserts the local demonstration world without deleting data. */
export async function seedPostgresDemo(
  database: WorkspaceDatabase,
  scope: DemoSeedScope = {},
): Promise<{ workspaceId: string; principalId: string; recordId: string }> {
  const fixture: RequiredDemoFixture = {
    workspaceId: scope.workspaceId?.trim() || POSTGRES_DEMO_IDS.workspace,
    principalId: scope.principalId?.trim() || POSTGRES_DEMO_IDS.principal,
    omniscientPlayerCharacter: scope.omniscientPlayerCharacter ?? true,
    canViewDynamicKnowledge: scope.canViewDynamicKnowledge ?? true,
  };

  return withWorkspaceTransaction(database, fixture.workspaceId, async (client) => {
    await insertWorkspace(client, fixture.workspaceId);
    // Each parent is visible to the next FK-dependent statement. Do not merge
    // these into sibling data-modifying CTEs: Event/policy validation triggers
    // and FK checks must observe the already-inserted topology.
    for (const insert of TOPOLOGY_INSERTS) {
      await client.query(insert.sql, insert.values(fixture));
    }
    await client.query(OPENING_EVENT_SQL, [fixture.workspaceId]);
    await client.query(RECORD_HEAD_SQL, [fixture.workspaceId]);
    await assertDemoFixture(client, fixture);
    return {
      workspaceId: fixture.workspaceId,
      principalId: fixture.principalId,
      recordId: POSTGRES_DEMO_IDS.record,
    };
  });
}

async function insertWorkspace(client: PoolClient, workspaceId: string) {
  await client.query(
    `INSERT INTO workspaces (id, name)
     VALUES ($1, '方舟叙事工作台')
     ON CONFLICT (id) DO NOTHING`,
    [workspaceId],
  );
}

/**
 * 批次 T11-B：demo 世界传播拓扑种子（迁移 0025 的表）。
 * 拓扑治理写入只走 owner 通道种子（postgres-seed-demo.mjs 要求 migration
 * owner 权限）；realm_runtime 只读。幂等可重复执行。独立于
 * seedPostgresDemo——迁移清单不含 0025 的临时库不受本函数影响。
 */
export async function seedPostgresDemoPropagationTopology(
  database: WorkspaceDatabase,
  workspaceId = POSTGRES_DEMO_IDS.workspace,
): Promise<void> {
  await withWorkspaceTransaction(database, workspaceId, async (client) => {
    await client.query(
      `INSERT INTO propagation_nodes (
         workspace_id, world_id, worldline_id, node_key, clearance, active
       ) VALUES
         ($1, '${POSTGRES_DEMO_IDS.world}', '${POSTGRES_DEMO_IDS.worldline}', 'canon_origin', 'public', TRUE),
         ($1, '${POSTGRES_DEMO_IDS.world}', '${POSTGRES_DEMO_IDS.worldline}', 'harbor_tavern', 'public', TRUE),
         ($1, '${POSTGRES_DEMO_IDS.world}', '${POSTGRES_DEMO_IDS.worldline}', 'market_square', 'public', TRUE)
       ON CONFLICT DO NOTHING`,
      [workspaceId],
    );
    await client.query(
      `INSERT INTO propagation_routes (
         workspace_id, world_id, worldline_id, id,
         from_node, to_node, channel, distance, recipient
       ) VALUES
         ($1, '${POSTGRES_DEMO_IDS.world}', '${POSTGRES_DEMO_IDS.worldline}', 'route_demo_bulletin',
          'canon_origin', 'harbor_tavern', 'official_bulletin', 1, NULL),
         ($1, '${POSTGRES_DEMO_IDS.world}', '${POSTGRES_DEMO_IDS.worldline}', 'route_demo_rumor',
          'harbor_tavern', 'market_square', 'market_rumor', 1, NULL)
       ON CONFLICT DO NOTHING`,
      [workspaceId],
    );
  });
}

async function assertDemoFixture(
  client: PoolClient,
  expected: RequiredDemoFixture,
): Promise<void> {
  const result = await client.query<{ fixture_ok: boolean }>(FIXTURE_ASSERTION_SQL, [
    expected.workspaceId,
    expected.principalId,
    expected.omniscientPlayerCharacter,
  ]);
  if (result.rows[0]?.fixture_ok !== true) {
    throw new Error(
      "The PostgreSQL demo fixture conflicts with existing data; seed aborted without rewriting it.",
    );
  }
}

const TICK = 17_121_219;
const DISPLAY_TIME = "停战纪元17年 · 雾月12日 · 入夜";
const workspaceValues = (input: RequiredDemoFixture) => [input.workspaceId];

const TOPOLOGY_INSERTS: readonly SeedInsert[] = [
  {
    sql: `
      INSERT INTO worlds (
        workspace_id, id, name, status, calendar_id, summary, settings
      ) VALUES (
        $1, '${POSTGRES_DEMO_IDS.world}', '烬海诸国', 'active',
        'truce_calendar', '人魔停战十七年后，海上的无声钟再次响起。',
        '{"era":"停战纪元 17 年","weather":"冷雾，无风","tension":"钟声已经响过三次","displayTime":"${DISPLAY_TIME}","style":"classical"}'::jsonb
      ) ON CONFLICT (workspace_id, id) DO NOTHING
    `,
    values: workspaceValues,
  },
  {
    sql: `
      INSERT INTO worldlines (
        workspace_id, world_id, id, label, status, head_tick, head_ordinal
      ) VALUES (
        $1, '${POSTGRES_DEMO_IDS.world}', '${POSTGRES_DEMO_IDS.worldline}',
        '原初世界线', 'active', ${TICK}, 1
      ) ON CONFLICT (workspace_id, id) DO NOTHING
    `,
    values: workspaceValues,
  },
  {
    sql: `
      INSERT INTO stories (
        workspace_id, world_id, worldline_id, id, title, status, premise,
        start_tick, start_ordinal
      ) VALUES (
        $1, '${POSTGRES_DEMO_IDS.world}', '${POSTGRES_DEMO_IDS.worldline}',
        '${POSTGRES_DEMO_IDS.story}', '无声钟的来客', 'active',
        '北岸灯塔在无风夜自行点亮，一封不属于任何阵营的密函被送上岸。',
        ${TICK}, 0
      ) ON CONFLICT (workspace_id, id) DO NOTHING
    `,
    values: workspaceValues,
  },
  {
    sql: `
      INSERT INTO records (
        workspace_id, world_id, worldline_id, story_id, id, title, status,
        start_tick, start_ordinal
      ) VALUES (
        $1, '${POSTGRES_DEMO_IDS.world}', '${POSTGRES_DEMO_IDS.worldline}',
        '${POSTGRES_DEMO_IDS.story}', '${POSTGRES_DEMO_IDS.record}',
        '第一幕 · 雾港来信', 'active', ${TICK}, 0
      ) ON CONFLICT (workspace_id, id) DO NOTHING
    `,
    values: workspaceValues,
  },
  {
    sql: `
      INSERT INTO scenes (
        workspace_id, world_id, worldline_id, record_id, id, title, status,
        location, objective, start_tick, start_ordinal
      ) VALUES (
        $1, '${POSTGRES_DEMO_IDS.world}', '${POSTGRES_DEMO_IDS.worldline}',
        '${POSTGRES_DEMO_IDS.record}', '${POSTGRES_DEMO_IDS.scene}', '北防波堤',
        'active', '灰鲸港 · 北防波堤', '决定是否当众拆开密函', ${TICK}, 0
      ) ON CONFLICT (workspace_id, id) DO NOTHING
    `,
    values: workspaceValues,
  },
  {
    sql: `
      INSERT INTO player_world_memberships (
        workspace_id, world_id, principal_id, role,
        omniscient_player_character, can_view_dynamic_knowledge
      ) VALUES (
        $1, '${POSTGRES_DEMO_IDS.world}', $2, 'owner', $3::boolean, $4::boolean
      ) ON CONFLICT (workspace_id, world_id, principal_id) DO NOTHING
    `,
    values: (input) => [
      input.workspaceId,
      input.principalId,
      input.omniscientPlayerCharacter,
      input.canViewDynamicKnowledge,
    ],
  },
  {
    sql: `
      INSERT INTO character_definitions (
        workspace_id, world_id, id, display_name, profile
      ) VALUES
        ($1, '${POSTGRES_DEMO_IDS.world}', '${POSTGRES_DEMO_IDS.playerDefinition}',
         '洛川', '{"role":"人类使节","summary":"停战议会派来的年轻调停人。"}'::jsonb),
        ($1, '${POSTGRES_DEMO_IDS.world}', '${POSTGRES_DEMO_IDS.scoutDefinition}',
         '塞娜', '{"role":"港卫斥候","summary":"熟悉灰鲸港每一条暗巷，对异常极度警觉。"}'::jsonb),
        ($1, '${POSTGRES_DEMO_IDS.world}', '${POSTGRES_DEMO_IDS.scholarDefinition}',
         '弥洛', '{"role":"魔族铭文学者","summary":"温和寡言，能辨认战前的禁忌铭文。"}'::jsonb)
      ON CONFLICT (workspace_id, id) DO NOTHING
    `,
    values: workspaceValues,
  },
  {
    sql: `
      INSERT INTO character_continuities (
        workspace_id, world_id, worldline_id, definition_id, id,
        continuity_key, status, born_tick, born_ordinal
      ) VALUES
        ($1, '${POSTGRES_DEMO_IDS.world}', '${POSTGRES_DEMO_IDS.worldline}',
         '${POSTGRES_DEMO_IDS.playerDefinition}', '${POSTGRES_DEMO_IDS.playerContinuity}',
         'player', 'active', 0, 0),
        ($1, '${POSTGRES_DEMO_IDS.world}', '${POSTGRES_DEMO_IDS.worldline}',
         '${POSTGRES_DEMO_IDS.scoutDefinition}', '${POSTGRES_DEMO_IDS.scoutContinuity}',
         'scout', 'active', 0, 0),
        ($1, '${POSTGRES_DEMO_IDS.world}', '${POSTGRES_DEMO_IDS.worldline}',
         '${POSTGRES_DEMO_IDS.scholarDefinition}', '${POSTGRES_DEMO_IDS.scholarContinuity}',
         'scholar', 'active', 0, 0)
      ON CONFLICT (workspace_id, id) DO NOTHING
    `,
    values: workspaceValues,
  },
  {
    sql: `
      INSERT INTO character_instances (
        workspace_id, world_id, worldline_id, record_id, continuity_id, id,
        controller_mode, status, instantiated_tick, instantiated_ordinal,
        inheritance_cutoff_tick, inheritance_cutoff_ordinal
      ) VALUES
        ($1, '${POSTGRES_DEMO_IDS.world}', '${POSTGRES_DEMO_IDS.worldline}',
         '${POSTGRES_DEMO_IDS.record}', '${POSTGRES_DEMO_IDS.playerContinuity}',
         '${POSTGRES_DEMO_IDS.playerInstance}', 'human', 'present', ${TICK}, 0, ${TICK}, 0),
        ($1, '${POSTGRES_DEMO_IDS.world}', '${POSTGRES_DEMO_IDS.worldline}',
         '${POSTGRES_DEMO_IDS.record}', '${POSTGRES_DEMO_IDS.scoutContinuity}',
         '${POSTGRES_DEMO_IDS.scoutInstance}', 'ai', 'present', ${TICK}, 0, ${TICK}, 0),
        ($1, '${POSTGRES_DEMO_IDS.world}', '${POSTGRES_DEMO_IDS.worldline}',
         '${POSTGRES_DEMO_IDS.record}', '${POSTGRES_DEMO_IDS.scholarContinuity}',
         '${POSTGRES_DEMO_IDS.scholarInstance}', 'ai', 'present', ${TICK}, 0, ${TICK}, 0)
      ON CONFLICT (workspace_id, id) DO NOTHING
    `,
    values: workspaceValues,
  },
  {
    sql: `
      INSERT INTO participants (
        workspace_id, world_id, worldline_id, record_id, id, participant_kind,
        character_instance_id, principal_id, controller_mode, is_active, speaking_order
      ) VALUES
        ($1, '${POSTGRES_DEMO_IDS.world}', '${POSTGRES_DEMO_IDS.worldline}',
         '${POSTGRES_DEMO_IDS.record}', '${POSTGRES_DEMO_IDS.playerParticipant}',
         'character', '${POSTGRES_DEMO_IDS.playerInstance}', $2, 'human', true, 0),
        ($1, '${POSTGRES_DEMO_IDS.world}', '${POSTGRES_DEMO_IDS.worldline}',
         '${POSTGRES_DEMO_IDS.record}', '${POSTGRES_DEMO_IDS.scoutParticipant}',
         'character', '${POSTGRES_DEMO_IDS.scoutInstance}', NULL, 'ai', true, 1),
        ($1, '${POSTGRES_DEMO_IDS.world}', '${POSTGRES_DEMO_IDS.worldline}',
         '${POSTGRES_DEMO_IDS.record}', '${POSTGRES_DEMO_IDS.scholarParticipant}',
         'character', '${POSTGRES_DEMO_IDS.scholarInstance}', NULL, 'ai', true, 2)
      ON CONFLICT (workspace_id, id) DO NOTHING
    `,
    values: (input) => [input.workspaceId, input.principalId],
  },
  {
    sql: `
      INSERT INTO visibility_policies (
        workspace_id, world_id, worldline_id, record_id, id,
        policy_key, policy_version, policy_kind
      ) VALUES (
        $1, '${POSTGRES_DEMO_IDS.world}', '${POSTGRES_DEMO_IDS.worldline}',
        '${POSTGRES_DEMO_IDS.record}', '${POSTGRES_DEMO_IDS.publicPolicy}',
        'public', 1, 'public'
      ) ON CONFLICT (workspace_id, id) DO NOTHING
    `,
    values: workspaceValues,
  },
  {
    sql: `
      INSERT INTO skill_definitions (
        workspace_id, world_id, id, skill_key, title, description, rule_pack_key,
        metadata
      ) VALUES (
        $1, '${POSTGRES_DEMO_IDS.world}', '${POSTGRES_DEMO_IDS.observationSkill}',
        '${DEMO_SKILL_DEFINITION.skillKey}', '${DEMO_SKILL_DEFINITION.title}',
        '${DEMO_SKILL_DEFINITION.description}', '${DEMO_SKILL_DEFINITION.rulePackKey}',
        $2::jsonb
      ) ON CONFLICT (workspace_id, id) DO UPDATE
        SET metadata = EXCLUDED.metadata
    `,
    values: (input) => [input.workspaceId, JSON.stringify(DEMO_SKILL_DEFINITION.metadata)],
  },
  {
    sql: `
      INSERT INTO character_skills (
        workspace_id, world_id, worldline_id, record_id,
        character_instance_id, skill_definition_id, acquired_tick, acquired_ordinal
      ) VALUES (
        $1, '${POSTGRES_DEMO_IDS.world}', '${POSTGRES_DEMO_IDS.worldline}',
        '${POSTGRES_DEMO_IDS.record}', '${POSTGRES_DEMO_IDS.playerInstance}',
        '${POSTGRES_DEMO_IDS.observationSkill}', 0, 0
      ), (
        $1, '${POSTGRES_DEMO_IDS.world}', '${POSTGRES_DEMO_IDS.worldline}',
        '${POSTGRES_DEMO_IDS.record}', '${POSTGRES_DEMO_IDS.scoutInstance}',
        '${POSTGRES_DEMO_IDS.observationSkill}', 0, 0
      ), (
        $1, '${POSTGRES_DEMO_IDS.world}', '${POSTGRES_DEMO_IDS.worldline}',
        '${POSTGRES_DEMO_IDS.record}', '${POSTGRES_DEMO_IDS.scholarInstance}',
        '${POSTGRES_DEMO_IDS.observationSkill}', 0, 0
      ) ON CONFLICT (
        workspace_id, record_id, character_instance_id, skill_definition_id
      ) DO NOTHING
    `,
    values: workspaceValues,
  },
  {
    sql: `
      INSERT INTO asset_definitions (
        workspace_id, world_id, id, asset_key, title, description,
        rule_pack_key, consumable, metadata
      ) VALUES (
        $1, '${POSTGRES_DEMO_IDS.world}', '${POSTGRES_DEMO_IDS.signalLanternAsset}',
        '${DEMO_ASSET_DEFINITION.assetKey}', '${DEMO_ASSET_DEFINITION.title}',
        '${DEMO_ASSET_DEFINITION.description}', '${DEMO_ASSET_DEFINITION.rulePackKey}',
        ${DEMO_ASSET_DEFINITION.consumable}, $2::jsonb
      ) ON CONFLICT (workspace_id, id) DO UPDATE
        SET metadata = EXCLUDED.metadata
    `,
    values: (input) => [input.workspaceId, JSON.stringify(DEMO_ASSET_DEFINITION.metadata)],
  },
  {
    sql: `
      INSERT INTO character_assets (
        workspace_id, world_id, worldline_id, record_id,
        character_instance_id, asset_definition_id, quantity
      ) VALUES (
        $1, '${POSTGRES_DEMO_IDS.world}', '${POSTGRES_DEMO_IDS.worldline}',
        '${POSTGRES_DEMO_IDS.record}', '${POSTGRES_DEMO_IDS.playerInstance}',
        '${POSTGRES_DEMO_IDS.signalLanternAsset}', 2
      ) ON CONFLICT (
        workspace_id, record_id, character_instance_id, asset_definition_id
      ) DO NOTHING
    `,
    values: workspaceValues,
  },
  {
    sql: `
      INSERT INTO effect_definitions (
        workspace_id, world_id, id, effect_key, title, description,
        rule_pack_key, effect_kind, metadata
      ) VALUES (
        $1, '${POSTGRES_DEMO_IDS.world}', '${POSTGRES_DEMO_IDS.guardedWatchEffect}',
        '${DEMO_STANCE_DEFINITION.effectKey}', '${DEMO_STANCE_DEFINITION.title}',
        '${DEMO_STANCE_DEFINITION.description}', '${DEMO_STANCE_DEFINITION.rulePackKey}',
        '${DEMO_STANCE_DEFINITION.effectKind}', $2::jsonb
      ) ON CONFLICT (workspace_id, id) DO UPDATE
        SET metadata = EXCLUDED.metadata
    `,
    values: (input) => [input.workspaceId, JSON.stringify(DEMO_STANCE_DEFINITION.metadata)],
  },
];

const OPENING_EVENT_SQL = `
  INSERT INTO events (
    workspace_id, world_id, worldline_id, record_id, scene_id, id,
    record_version, record_ordinal, batch_index, event_kind,
    actor_participant_id, speaker_name, content, payload,
    visibility_policy_id, world_tick, world_ordinal, calendar_id,
    display_time, recorded_at
  ) VALUES (
    $1, '${POSTGRES_DEMO_IDS.world}', '${POSTGRES_DEMO_IDS.worldline}',
    '${POSTGRES_DEMO_IDS.record}', '${POSTGRES_DEMO_IDS.scene}',
    '${POSTGRES_DEMO_IDS.openingEvent}', 1, 1, 0, 'narration.committed',
    NULL, '旁白',
    '雾沿着石阶爬上防波堤。信使放下蜡封完好的黑色信函，远处灯塔的光随第三声钟鸣熄灭。',
    '{"presentation":{"schemaVersion":1,"segments":[{"id":"environment-1","kind":"environment","content":"雾沿着石阶爬上防波堤。","speechMode":"narrator"},{"id":"story-1","kind":"story","content":"信使放下蜡封完好的黑色信函。","speechMode":"narrator"},{"id":"fact-1","kind":"fact","content":"远处灯塔的光随第三声钟鸣熄灭。","speechMode":"narrator"}]}}'::jsonb,
    '${POSTGRES_DEMO_IDS.publicPolicy}', ${TICK}, 1,
    'truce_calendar', '${DISPLAY_TIME}', CURRENT_TIMESTAMP
  ) ON CONFLICT (workspace_id, id) DO NOTHING
`;

const RECORD_HEAD_SQL = `
  INSERT INTO record_heads (
    workspace_id, world_id, worldline_id, record_id, record_version,
    next_record_ordinal, last_event_id, last_world_tick, last_world_ordinal
  ) VALUES (
    $1, '${POSTGRES_DEMO_IDS.world}', '${POSTGRES_DEMO_IDS.worldline}',
    '${POSTGRES_DEMO_IDS.record}', 1, 2, '${POSTGRES_DEMO_IDS.openingEvent}', ${TICK}, 1
  ) ON CONFLICT (workspace_id, record_id) DO NOTHING
`;

const FIXTURE_ASSERTION_SQL = `
  SELECT
    EXISTS (
      SELECT 1 FROM workspaces WHERE id = $1 AND name = '方舟叙事工作台'
    )
    AND EXISTS (
      SELECT 1 FROM worlds
      WHERE workspace_id = $1
        AND id = '${POSTGRES_DEMO_IDS.world}'
        AND name = '烬海诸国'
        AND calendar_id = 'truce_calendar'
    )
    AND EXISTS (
      SELECT 1 FROM worldlines
      WHERE workspace_id = $1
        AND id = '${POSTGRES_DEMO_IDS.worldline}'
        AND world_id = '${POSTGRES_DEMO_IDS.world}'
    )
    AND EXISTS (
      SELECT 1 FROM stories
      WHERE workspace_id = $1
        AND id = '${POSTGRES_DEMO_IDS.story}'
        AND world_id = '${POSTGRES_DEMO_IDS.world}'
        AND worldline_id = '${POSTGRES_DEMO_IDS.worldline}'
    )
    AND EXISTS (
      SELECT 1 FROM records
      WHERE workspace_id = $1
        AND id = '${POSTGRES_DEMO_IDS.record}'
        AND world_id = '${POSTGRES_DEMO_IDS.world}'
        AND worldline_id = '${POSTGRES_DEMO_IDS.worldline}'
        AND story_id = '${POSTGRES_DEMO_IDS.story}'
    )
    AND EXISTS (
      SELECT 1 FROM scenes
      WHERE workspace_id = $1
        AND id = '${POSTGRES_DEMO_IDS.scene}'
        AND world_id = '${POSTGRES_DEMO_IDS.world}'
        AND worldline_id = '${POSTGRES_DEMO_IDS.worldline}'
        AND record_id = '${POSTGRES_DEMO_IDS.record}'
    )
    AND EXISTS (
      SELECT 1 FROM player_world_memberships
      WHERE workspace_id = $1
        AND world_id = '${POSTGRES_DEMO_IDS.world}'
        AND principal_id = $2
        AND omniscient_player_character = $3::boolean
    )
    AND NOT EXISTS (
      SELECT 1
      FROM (VALUES
        ('${POSTGRES_DEMO_IDS.playerDefinition}', '${POSTGRES_DEMO_IDS.playerContinuity}',
         '${POSTGRES_DEMO_IDS.playerInstance}', '${POSTGRES_DEMO_IDS.playerParticipant}', $2::text),
        ('${POSTGRES_DEMO_IDS.scoutDefinition}', '${POSTGRES_DEMO_IDS.scoutContinuity}',
         '${POSTGRES_DEMO_IDS.scoutInstance}', '${POSTGRES_DEMO_IDS.scoutParticipant}', NULL::text),
        ('${POSTGRES_DEMO_IDS.scholarDefinition}', '${POSTGRES_DEMO_IDS.scholarContinuity}',
         '${POSTGRES_DEMO_IDS.scholarInstance}', '${POSTGRES_DEMO_IDS.scholarParticipant}', NULL::text)
      ) AS expected(definition_id, continuity_id, instance_id, participant_id, principal_id)
      LEFT JOIN character_definitions AS definition
        ON definition.workspace_id = $1
       AND definition.world_id = '${POSTGRES_DEMO_IDS.world}'
       AND definition.id = expected.definition_id
      LEFT JOIN character_continuities AS continuity
        ON continuity.workspace_id = $1
       AND continuity.world_id = '${POSTGRES_DEMO_IDS.world}'
       AND continuity.worldline_id = '${POSTGRES_DEMO_IDS.worldline}'
       AND continuity.id = expected.continuity_id
       AND continuity.definition_id = expected.definition_id
      LEFT JOIN character_instances AS instance
        ON instance.workspace_id = $1
       AND instance.world_id = '${POSTGRES_DEMO_IDS.world}'
       AND instance.worldline_id = '${POSTGRES_DEMO_IDS.worldline}'
       AND instance.record_id = '${POSTGRES_DEMO_IDS.record}'
       AND instance.id = expected.instance_id
       AND instance.continuity_id = expected.continuity_id
      LEFT JOIN participants AS participant
        ON participant.workspace_id = $1
       AND participant.world_id = '${POSTGRES_DEMO_IDS.world}'
       AND participant.worldline_id = '${POSTGRES_DEMO_IDS.worldline}'
       AND participant.record_id = '${POSTGRES_DEMO_IDS.record}'
       AND participant.id = expected.participant_id
       AND participant.character_instance_id = expected.instance_id
      WHERE definition.id IS NULL
         OR continuity.id IS NULL
         OR instance.id IS NULL
         OR participant.id IS NULL
         OR participant.principal_id IS DISTINCT FROM expected.principal_id
    )
    AND EXISTS (
      SELECT 1 FROM visibility_policies
      WHERE workspace_id = $1
        AND id = '${POSTGRES_DEMO_IDS.publicPolicy}'
        AND world_id = '${POSTGRES_DEMO_IDS.world}'
        AND worldline_id = '${POSTGRES_DEMO_IDS.worldline}'
        AND record_id = '${POSTGRES_DEMO_IDS.record}'
        AND policy_kind = 'public'
    )
    AND EXISTS (
      SELECT 1
      FROM character_skills AS owned_skill
      JOIN skill_definitions AS skill
        ON skill.workspace_id = owned_skill.workspace_id
       AND skill.world_id = owned_skill.world_id
       AND skill.id = owned_skill.skill_definition_id
      WHERE owned_skill.workspace_id = $1
        AND owned_skill.record_id = '${POSTGRES_DEMO_IDS.record}'
        AND owned_skill.character_instance_id = '${POSTGRES_DEMO_IDS.playerInstance}'
        AND skill.skill_key = 'careful_observation'
    )
    AND EXISTS (
      SELECT 1
      FROM character_assets AS owned_asset
      JOIN asset_definitions AS asset
        ON asset.workspace_id = owned_asset.workspace_id
       AND asset.world_id = owned_asset.world_id
       AND asset.id = owned_asset.asset_definition_id
      WHERE owned_asset.workspace_id = $1
        AND owned_asset.record_id = '${POSTGRES_DEMO_IDS.record}'
        AND owned_asset.character_instance_id = '${POSTGRES_DEMO_IDS.playerInstance}'
        AND asset.asset_key = 'signal_lantern'
        AND owned_asset.quantity >= 0
    )
    AND EXISTS (
      SELECT 1 FROM effect_definitions
      WHERE workspace_id = $1
        AND world_id = '${POSTGRES_DEMO_IDS.world}'
        AND id = '${POSTGRES_DEMO_IDS.guardedWatchEffect}'
        AND effect_key = 'guarded_watch'
        AND effect_kind = 'stance'
    )
    AND EXISTS (
      SELECT 1 FROM events
      WHERE workspace_id = $1
        AND id = '${POSTGRES_DEMO_IDS.openingEvent}'
        AND world_id = '${POSTGRES_DEMO_IDS.world}'
        AND worldline_id = '${POSTGRES_DEMO_IDS.worldline}'
        AND record_id = '${POSTGRES_DEMO_IDS.record}'
        AND scene_id = '${POSTGRES_DEMO_IDS.scene}'
        AND visibility_policy_id = '${POSTGRES_DEMO_IDS.publicPolicy}'
        AND record_ordinal = 1
        AND (world_tick, world_ordinal) = (${TICK}, 1)
    )
    AND EXISTS (
      SELECT 1 FROM record_heads
      WHERE workspace_id = $1
        AND world_id = '${POSTGRES_DEMO_IDS.world}'
        AND worldline_id = '${POSTGRES_DEMO_IDS.worldline}'
        AND record_id = '${POSTGRES_DEMO_IDS.record}'
        AND record_version >= 1
        AND next_record_ordinal >= 2
        AND last_event_id IS NOT NULL
        AND (last_world_tick, last_world_ordinal) >= (${TICK}, 1)
    ) AS fixture_ok
`;
