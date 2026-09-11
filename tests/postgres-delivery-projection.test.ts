import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg, { type PoolClient } from "pg";
import {
  createPostgresDeliveryProjectionRepository,
  PlayerDeliveryScopeError,
  POSTGRES_DEMO_IDS,
  seedPostgresDemo,
  withWorkspaceTransaction,
  type PlayerDeliveryScope,
} from "../database/postgres/public.ts";

const connectionString = process.env.DATABASE_URL;

test(
  "player Delivery Projection is workspace, perspective, time and visibility safe",
  { skip: !connectionString },
  async () => {
    const url = requireLoopbackUrl(connectionString!);
    const pool = new pg.Pool({ connectionString: url.href, max: 1 });
    const client = await pool.connect();
    const nonce = randomUUID();
    const fogWorkspace = `ws_delivery_fog_${nonce}`;
    const omniscientWorkspace = `ws_delivery_ooc_${nonce}`;
    const hiddenPanelsWorkspace = `ws_delivery_hidden_${nonce}`;
    const principalId = `principal_delivery_${nonce}`;

    try {
      await client.query("BEGIN");
      await client.query("SET ROLE realm_control");
      await assertApplicationRole(client, "realm_control");

      const fogSeed = {
        workspaceId: fogWorkspace,
        principalId,
        omniscientPlayerCharacter: false,
        canViewDynamicKnowledge: true,
      } as const;
      await seedPostgresDemo(client, fogSeed);
      await seedPostgresDemo(client, fogSeed);
      await assertSeedIsIdempotent(client, fogWorkspace);
      await assert.rejects(
        seedPostgresDemo(client, {
          ...fogSeed,
          omniscientPlayerCharacter: true,
        }),
        /conflicts with existing data/i,
      );

      await withWorkspaceTransaction(client, fogWorkspace, async (scoped) => {
        await addVisibilityAndTimeFixture(scoped, fogWorkspace);
        await scoped.query(
          `UPDATE participants
           SET is_active = false
           WHERE workspace_id = $1 AND id = $2`,
          [fogWorkspace, POSTGRES_DEMO_IDS.playerParticipant],
        );
      });
      await seedPostgresDemo(client, fogSeed);
      await assertAdvancedHeadIsPreserved(client, fogWorkspace);

      await client.query("SET ROLE realm_runtime");
      await assertApplicationRole(client, "realm_runtime");
      const repository = createPostgresDeliveryProjectionRepository(client);
      const fogScope: PlayerDeliveryScope = {
        workspaceId: fogWorkspace,
        recordId: POSTGRES_DEMO_IDS.record,
        principalId,
      };
      const characterView = await repository.loadForPlayer(fogScope);
      assert.ok(characterView);
      const characterDelivery = await repository.loadDeliveryForPlayer(fogScope);
      assert.deepEqual(characterDelivery?.suggestions, ["问问灯塔看守", "检查雾中船影"]);
      assert.deepEqual(eventIds(characterView), [
        POSTGRES_DEMO_IDS.openingEvent,
        "event_public_extra",
      ]);
      assert.equal(characterView.version, 2);
      assert.equal(characterView.record.version, 2);
      assert.deepEqual(
        characterView.events[0]?.segments.map((segment) => segment.kind),
        ["environment", "story", "fact"],
      );
      assert.deepEqual(
        characterView.events.map((event) => event.ordinal),
        [1, 2],
        "viewer ordinals must not expose canonical gaps",
      );
      assert.equal(characterView.scene.location, "灰鲸港 · 北防波堤");
      assert.equal(characterView.scene.worldTime, "公开时刻");
      assert.equal(JSON.stringify(characterView).includes("DM绝密时刻"), false);
      assert.equal(JSON.stringify(characterView).includes("未来王座厅"), false);
      assert.equal(JSON.stringify(characterView).includes("event_future_public"), false);
      assert.equal(JSON.stringify(characterView).includes("event_dm_only"), false);
      assert.equal(JSON.stringify(characterView).includes("context_manifest"), false);
      assert.equal(
        characterView.cast.find(
          (member) => member.characterInstanceId === POSTGRES_DEMO_IDS.playerInstance,
        )?.isActive,
        false,
        "an inactive participant remains visible in cast history but is not a perspective",
      );

      const injectedPerspective = await repository.loadForPlayer({
        ...fogScope,
        perspective: "omniscient",
      } as PlayerDeliveryScope & { perspective: "omniscient" });
      assert.deepEqual(
        eventIds(injectedPerspective),
        eventIds(characterView),
        "unknown request fields cannot elevate immutable Membership perspective",
      );

      await client.query("SET ROLE realm_control");
      await withWorkspaceTransaction(client, fogWorkspace, async (scoped) => {
        await scoped.query(
          `UPDATE participants
           SET principal_id = $3
           WHERE workspace_id = $1 AND id = $2`,
          [fogWorkspace, POSTGRES_DEMO_IDS.scoutParticipant, principalId],
        );
      });
      await client.query("SET ROLE realm_runtime");
      const activeView = await repository.loadForPlayer(fogScope);
      const scoutView = await repository.loadForPlayer({
        ...fogScope,
        characterInstanceId: POSTGRES_DEMO_IDS.scoutInstance,
      });
      assert.deepEqual(eventIds(activeView), eventIds(scoutView));
      assert.deepEqual(eventIds(scoutView), [
        POSTGRES_DEMO_IDS.openingEvent,
        "event_public_extra",
        "event_scene_scout",
        "event_restricted_scout",
        "event_private_scout",
      ]);
      assert.equal(scoutView?.scene.worldTime, "塞娜私有时刻");
      await assert.rejects(
        repository.loadForPlayer({
          ...fogScope,
          characterInstanceId: POSTGRES_DEMO_IDS.playerInstance,
        }),
        (error: unknown) => error instanceof PlayerDeliveryScopeError
          && error.code === "CHARACTER_NOT_CONTROLLED",
      );
      await assert.rejects(
        repository.loadForPlayer({
          ...fogScope,
          characterInstanceId: POSTGRES_DEMO_IDS.scholarInstance,
        }),
        (error: unknown) => error instanceof PlayerDeliveryScopeError
          && error.code === "CHARACTER_NOT_CONTROLLED",
      );

      await client.query("SET ROLE realm_control");
      await seedPostgresDemo(client, {
        workspaceId: omniscientWorkspace,
        principalId,
        omniscientPlayerCharacter: true,
        canViewDynamicKnowledge: true,
      });
      await withWorkspaceTransaction(client, omniscientWorkspace, (scoped) =>
        addVisibilityAndTimeFixture(scoped, omniscientWorkspace));
      await client.query("SET ROLE realm_runtime");
      const omniscientView = await repository.loadForPlayer({
        workspaceId: omniscientWorkspace,
        recordId: POSTGRES_DEMO_IDS.record,
        principalId,
      });
      assert.ok(omniscientView);
      assert.deepEqual(eventIds(omniscientView), [
        POSTGRES_DEMO_IDS.openingEvent,
        "event_public_extra",
        "event_scene_player",
        "event_scene_scout",
        "event_restricted_player",
        "event_restricted_scout",
        "event_private_player",
        "event_private_scout",
      ]);
      assert.equal(omniscientView.version, 8);
      assert.equal(omniscientView.scene.worldTime, "塞娜私有时刻");
      assert.equal(JSON.stringify(omniscientView).includes("DM绝密时刻"), false);
      assert.equal(JSON.stringify(omniscientView).includes("event_dm_only"), false);
      assert.deepEqual(
        omniscientView.events
          .filter((event) => event.visibility !== "public")
          .map((event) => event.visibility),
        [
          "ooc:scene",
          "ooc:scene",
          "ooc:restricted",
          "ooc:restricted",
          "ooc:private",
          "ooc:private",
        ],
      );

      await client.query("SET ROLE realm_control");
      await seedPostgresDemo(client, {
        workspaceId: hiddenPanelsWorkspace,
        principalId,
        omniscientPlayerCharacter: false,
        canViewDynamicKnowledge: false,
      });
      await client.query("SET ROLE realm_runtime");
      const hiddenPanelsView = await repository.loadForPlayer({
        workspaceId: hiddenPanelsWorkspace,
        recordId: POSTGRES_DEMO_IDS.record,
        principalId,
      });
      assert.ok(hiddenPanelsView);
      assert.equal(hiddenPanelsView.world.name, "烬海诸国");
      assert.equal(hiddenPanelsView.story.title, "无声钟的来客");
      assert.equal(hiddenPanelsView.record.title, "第一幕 · 雾港来信");
      assert.deepEqual(hiddenPanelsView.cast, []);
      assert.deepEqual(hiddenPanelsView.participants, []);
      assert.deepEqual(
        {
          era: hiddenPanelsView.world.era,
          worldSummary: hiddenPanelsView.world.summary,
          worldTime: hiddenPanelsView.world.timeCursor,
          storyStatus: hiddenPanelsView.story.status,
          premise: hiddenPanelsView.story.premise,
          recordStatus: hiddenPanelsView.record.status,
          location: hiddenPanelsView.record.location,
          scene: hiddenPanelsView.scene,
        },
        {
          era: "",
          worldSummary: "",
          worldTime: "",
          storyStatus: "",
          premise: "",
          recordStatus: "",
          location: "",
          scene: {
            location: "",
            worldTime: "",
            weather: "",
            tension: "",
            objective: "",
          },
        },
      );
      await client.query("SET ROLE realm_control");
      await withWorkspaceTransaction(
        client,
        hiddenPanelsWorkspace,
        async (scoped) => {
          await scoped.query(
            `UPDATE player_world_memberships
             SET can_view_dynamic_knowledge = true
             WHERE workspace_id = $1
               AND world_id = $2
               AND principal_id = $3`,
            [hiddenPanelsWorkspace, POSTGRES_DEMO_IDS.world, principalId],
          );
        },
      );
      await seedPostgresDemo(client, {
        workspaceId: hiddenPanelsWorkspace,
        principalId,
        omniscientPlayerCharacter: false,
        canViewDynamicKnowledge: false,
      });
      await client.query("SET ROLE realm_runtime");
      const enabledPanelsView = await repository.loadForPlayer({
        workspaceId: hiddenPanelsWorkspace,
        recordId: POSTGRES_DEMO_IDS.record,
        principalId,
      });
      assert.ok(enabledPanelsView);
      assert.equal(enabledPanelsView.world.era, "停战纪元 17 年");
      assert.equal(enabledPanelsView.scene.location, "灰鲸港 · 北防波堤");
      assert.equal(enabledPanelsView.cast.length, 3);

      assert.equal(
        await repository.loadForPlayer({
          workspaceId: `foreign_${nonce}`,
          recordId: POSTGRES_DEMO_IDS.record,
          principalId,
        }),
        null,
      );
      await assertNestedWorkspaceRestoration(
        client,
        fogWorkspace,
        omniscientWorkspace,
      );
      await client.query("SELECT set_config('realm.workspace_id', '', true)");
      const withoutScope = await client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM records WHERE id = $1",
        [POSTGRES_DEMO_IDS.record],
      );
      assert.equal(withoutScope.rows[0]?.count, 0);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
      await pool.end();
    }
  },
);

function requireLoopbackUrl(value: string): URL {
  const url = new URL(value);
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(url.hostname)) {
    throw new Error("PostgreSQL integration tests only accept a loopback DATABASE_URL.");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error("DATABASE_URL must use the PostgreSQL protocol.");
  }
  return url;
}

async function assertApplicationRole(
  client: PoolClient,
  expectedRole: "realm_runtime" | "realm_control",
): Promise<void> {
  const identity = await client.query<{
    current_user: string;
    rolsuper: boolean;
    rolbypassrls: boolean;
  }>(`
    SELECT current_user, role.rolsuper, role.rolbypassrls
    FROM pg_roles AS role
    WHERE role.rolname = current_user
  `);
  assert.deepEqual(identity.rows[0], {
    current_user: expectedRole,
    rolsuper: false,
    rolbypassrls: false,
  });
}

async function assertSeedIsIdempotent(
  client: PoolClient,
  workspaceId: string,
): Promise<void> {
  await withWorkspaceTransaction(client, workspaceId, async (scoped) => {
    const counts = await scoped.query<{
      records: number;
      participants: number;
      events: number;
    }>(`
      SELECT
        (SELECT count(*)::int FROM records WHERE workspace_id = $1) AS records,
        (SELECT count(*)::int FROM participants WHERE workspace_id = $1) AS participants,
        (SELECT count(*)::int FROM events WHERE workspace_id = $1) AS events
    `, [workspaceId]);
    assert.deepEqual(counts.rows[0], {
      records: 1,
      participants: 3,
      events: 1,
    });
  });
}

async function assertAdvancedHeadIsPreserved(
  client: PoolClient,
  workspaceId: string,
): Promise<void> {
  await withWorkspaceTransaction(client, workspaceId, async (scoped) => {
    const head = await scoped.query<{
      record_version: string;
      next_record_ordinal: string;
      last_event_id: string;
      last_world_ordinal: string;
    }>(`
      SELECT record_version, next_record_ordinal, last_event_id, last_world_ordinal
      FROM record_heads
      WHERE workspace_id = $1 AND record_id = $2
    `, [workspaceId, POSTGRES_DEMO_IDS.record]);
    assert.deepEqual(head.rows[0], {
      record_version: "77",
      next_record_ordinal: "11",
      last_event_id: "event_dm_only",
      last_world_ordinal: "9",
    });
  });
}

async function assertNestedWorkspaceRestoration(
  client: PoolClient,
  outerWorkspaceId: string,
  innerWorkspaceId: string,
): Promise<void> {
  await client.query(
    "SELECT set_config('realm.workspace_id', 'scope_before_helper', true)",
  );
  await withWorkspaceTransaction(client, outerWorkspaceId, async (outer) => {
    assert.equal(await currentWorkspace(outer), outerWorkspaceId);
    await withWorkspaceTransaction(outer, innerWorkspaceId, async (inner) => {
      assert.equal(await currentWorkspace(inner), innerWorkspaceId);
    });
    assert.equal(await currentWorkspace(outer), outerWorkspaceId);
  });
  assert.equal(await currentWorkspace(client), "scope_before_helper");
  await assert.rejects(
    withWorkspaceTransaction(client, outerWorkspaceId, async (outer) => {
      assert.equal(await currentWorkspace(outer), outerWorkspaceId);
      await withWorkspaceTransaction(outer, innerWorkspaceId, async (inner) => {
        assert.equal(await currentWorkspace(inner), innerWorkspaceId);
        throw new Error("rollback nested scope");
      });
    }),
    /rollback nested scope/,
  );
  assert.equal(await currentWorkspace(client), "scope_before_helper");
}

async function currentWorkspace(client: PoolClient): Promise<string | null> {
  const result = await client.query<{ workspace_id: string | null }>(
    "SELECT current_setting('realm.workspace_id', true) AS workspace_id",
  );
  return result.rows[0]?.workspace_id ?? null;
}

function eventIds(
  projection: Awaited<ReturnType<
    ReturnType<typeof createPostgresDeliveryProjectionRepository>["loadForPlayer"]
  >>,
): string[] {
  return projection?.events.map((event) => event.id) ?? [];
}

async function addVisibilityAndTimeFixture(
  client: PoolClient,
  workspaceId: string,
): Promise<void> {
  await client.query(`
    INSERT INTO scenes (
      workspace_id, world_id, worldline_id, record_id, id, title, status,
      location, objective, start_tick, start_ordinal
    ) VALUES (
      $1, $2, $3, $4, 'scene_future', '未来场景', 'planned',
      '未来王座厅', '这段未来信息不得被当前投影读取', 17121219, 50
    )
  `, [
    workspaceId,
    POSTGRES_DEMO_IDS.world,
    POSTGRES_DEMO_IDS.worldline,
    POSTGRES_DEMO_IDS.record,
  ]);

  const policies = [
    ["policy_scene_player", "scene-player", "scene", POSTGRES_DEMO_IDS.scene, null, null, [POSTGRES_DEMO_IDS.playerInstance]],
    ["policy_scene_scout", "scene-scout", "scene", POSTGRES_DEMO_IDS.scene, null, null, [POSTGRES_DEMO_IDS.scoutInstance]],
    ["policy_restricted_player", "restricted-player", "restricted", null, "cabal-player", null, [POSTGRES_DEMO_IDS.playerInstance]],
    ["policy_restricted_scout", "restricted-scout", "restricted", null, "cabal-scout", null, [POSTGRES_DEMO_IDS.scoutInstance]],
    ["policy_private_player", "private-player", "private", null, null, POSTGRES_DEMO_IDS.playerInstance, []],
    ["policy_private_scout", "private-scout", "private", null, null, POSTGRES_DEMO_IDS.scoutInstance, []],
    ["policy_dm_only", "dm-only", "dm_only", null, null, null, []],
  ] as const;
  for (const [id, key, kind, sceneId, domainId, privateId, audience] of policies) {
    await client.query(`
      INSERT INTO visibility_policies (
        workspace_id, world_id, worldline_id, record_id, id,
        policy_key, policy_version, policy_kind, scene_id,
        restricted_domain_id, private_character_instance_id,
        audience_character_instance_ids
      ) VALUES (
        $1, $2, $3, $4, $5, $6, 1, $7, $8, $9, $10, $11::text[]
      )
    `, [
      workspaceId,
      POSTGRES_DEMO_IDS.world,
      POSTGRES_DEMO_IDS.worldline,
      POSTGRES_DEMO_IDS.record,
      id,
      key,
      kind,
      sceneId,
      domainId,
      privateId,
      audience,
    ]);
  }

  const events = [
    ["event_public_extra", POSTGRES_DEMO_IDS.publicPolicy, "旁白", null, 2, "公开时刻"],
    ["event_scene_player", "policy_scene_player", "洛川", POSTGRES_DEMO_IDS.playerParticipant, 3, "洛川场景时刻"],
    ["event_scene_scout", "policy_scene_scout", "塞娜", POSTGRES_DEMO_IDS.scoutParticipant, 4, "塞娜场景时刻"],
    ["event_restricted_player", "policy_restricted_player", "洛川", POSTGRES_DEMO_IDS.playerParticipant, 5, "洛川密谈时刻"],
    ["event_restricted_scout", "policy_restricted_scout", "塞娜", POSTGRES_DEMO_IDS.scoutParticipant, 6, "塞娜密谈时刻"],
    ["event_private_player", "policy_private_player", "洛川", POSTGRES_DEMO_IDS.playerParticipant, 7, "洛川私有时刻"],
    ["event_private_scout", "policy_private_scout", "塞娜", POSTGRES_DEMO_IDS.scoutParticipant, 8, "塞娜私有时刻"],
    ["event_dm_only", "policy_dm_only", "DM", null, 9, "DM绝密时刻"],
    ["event_future_public", POSTGRES_DEMO_IDS.publicPolicy, "未来旁白", null, 50, "未来时刻"],
  ] as const;
  for (const [index, [
    id,
    policyId,
    speaker,
    participantId,
    worldOrdinal,
    displayTime,
  ]] of events.entries()) {
    const recordOrdinal = index + 2;
    await client.query(`
      INSERT INTO events (
        workspace_id, world_id, worldline_id, record_id, scene_id, id,
        record_version, record_ordinal, batch_index, event_kind,
        actor_participant_id, speaker_name, content, payload,
        visibility_policy_id, world_tick, world_ordinal, calendar_id,
        display_time, recorded_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        2, $7, $8,
        CASE WHEN $6 = 'event_public_extra'
          THEN 'narration.committed' ELSE 'utterance.committed' END,
        $9, $10, $6,
      CASE WHEN $6 = 'event_public_extra'
        THEN '{"suggestions":["问问灯塔看守","检查雾中船影"]}'::jsonb
        ELSE '{}'::jsonb END,
        $11, 17121219, $12, 'truce_calendar',
        $13, CURRENT_TIMESTAMP
      )
    `, [
      workspaceId,
      POSTGRES_DEMO_IDS.world,
      POSTGRES_DEMO_IDS.worldline,
      POSTGRES_DEMO_IDS.record,
      POSTGRES_DEMO_IDS.scene,
      id,
      recordOrdinal,
      index,
      participantId,
      speaker,
      policyId,
      worldOrdinal,
      displayTime,
    ]);
  }

  await client.query(`
    UPDATE record_heads
    SET record_version = 77,
        next_record_ordinal = 11,
        last_event_id = 'event_dm_only',
        last_world_tick = 17121219,
        last_world_ordinal = 9,
        updated_at = CURRENT_TIMESTAMP
    WHERE workspace_id = $1 AND record_id = $2
  `, [workspaceId, POSTGRES_DEMO_IDS.record]);
}
