/**
 * 批次 T10-B7——迁移 0023 后 library/创世/导入全量下沉受限角色
 *（docs/development/T10-B7-LIBRARY-RUNTIME-GRANTS.md §五）。
 * 双临时库（t.after 强制 DROP）：pre-0023 库记录授权缺口实锤，
 * 0023 库上 runtime-only 逐项真实成功；RLS 跨 workspace 隔离；
 * T6/T8 门禁不回退；路由层不再需要 DATABASE_URL。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import {
  installTestSessionSecret,
  seedCapabilitySessionKey,
  sessionProofFor,
} from "./helpers/session-proof.ts";
installTestSessionSecret();
import { seedPostgresDemo } from "../database/postgres/public.ts";
import {
  LibraryServiceError,
  createPostgresLibraryService,
} from "../modules/application/library-service.ts";
import { importTavernBundle } from "../modules/application/tavern-import-service.ts";
import { endSharedRuntimePools } from "../app/api/world-scope.ts";
import {
  GET as libraryGET,
  POST as libraryPOST,
} from "../app/api/library/route.ts";
import { createSessionValue } from "../modules/identity/auth.ts";

const adminConnectionString = process.env.DATABASE_URL;
const runtimeConnectionString = process.env.REALM_RUNTIME_DATABASE_URL;

const MIGRATIONS = [
  "0001_runtime_contract.sql",
  "0002_runtime_contract_hardening.sql",
  "0003_runtime_repository.sql",
  "0004_runtime_security_hardening.sql",
  "0005_hybrid_memory.sql",
  "0006_action_state_ledger.sql",
  "0007_dynamic_visibility_policies.sql",
  "0008_record_timeline_kind.sql",
  "0009_memory_m3_completion.sql",
  "0010_world_governance.sql",
  "0011_worldline_merge_semantic_propagation_jobs.sql",
  "0012_accounts.sql",
  "0013_membership_insert_grant.sql",
  "0014_scene_crystallization_grants.sql",
  "0015_account_ui_language.sql",
  "0016_world_files.sql",
  "0017_account_last_opened.sql",
  "0018_account_last_opened_fk_set_null.sql",
  "0019_record_first_nights.sql",
  "0020_record_self_play_sessions.sql",
  "0021_world_admin.sql",
  "0022_worldline_merge_grants.sql",
  "0023_library_runtime_grants.sql",
];

const CURRENT_MIGRATIONS = [
  ...MIGRATIONS,
  "0024_graph_invalidation_events.sql",
  "0025_propagation_topology_semantic_scope.sql",
  "0026_canon_security_audience.sql",
  "0027_propagation_node_audiences.sql",
  "0028_propagation_node_audiences_owner_append.sql",
  "0029_record_scene_tension.sql",
  "0030_character_instance_state.sql",
  "0031_keen_insight_discovery.sql",
  "0032_character_activity_grants.sql",
  "0033_base_skill_metadata_grant.sql",
  "0034_revoke_broad_skill_metadata_grant.sql",
  "0035_keen_insight_concrete_discovery.sql",
  "0036_keen_insight_location_context.sql",
  "0037_record_archive_grant.sql",
  "0038_remove_base_skill_hidden_clue.sql",
  "0039_scene_weather_snapshot.sql",
      "0040_scene_display_time_snapshot.sql",
  // 0044：records.timeline_kind 增加 'branch'——branch 命令现在创建
  // timeline_kind='branch' 的可玩拓扑，pre-0044 CHECK 会拒绝。
  "0044_record_branch_timeline_kind.sql",
  // 0053 撤销 runtime 的 membership 直写（role UPDATE 改走 capability
  // 窄通道）；0041 提供 pgcrypto 依赖。
  "0041_article_qualification_and_import_entries.sql",
  "0053_membership_capability.sql",
  // Phase 1B：library list 读模型显式 SELECT worlds.world_version（0054 列）。
  "0054_world_version_identity.sql",
  "0055_goal_runtime.sql",
  "0056_runtime_save_restore_grants.sql",
  // Phase 4D：records.world_version（Record 级 binding）+ 切换审计台账；
  // library 的 records INSERT 现在显式携带该列。
  "0057_realmworld_record_binding.sql",
  // B1：branch Goal clone reads the retry-attempt columns。
  "0060_goal_scope_terminal_lifecycle.sql",
  // 创世请求幂等台账（合并后迁移序号为 0063）。
  "0063_genesis_creation_requests.sql",
  // Only the current fixture needs the committed performance read model.
  "0066_committed_fact_commands.sql",
];

function requireLoopbackUrl(value: string): URL {
  const url = new URL(value);
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("PostgreSQL tests are restricted to a loopback host.");
  }
  return url;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function createDatabase(
  registerCleanup: (cleanup: () => Promise<void>) => void,
  maintenance: pg.Client,
  adminUrl: URL,
  label: string,
  migrations: readonly string[],
) {
  const databaseName = `realm_t10b7_${label}_${randomUUID().replaceAll("-", "")}`;
  await maintenance.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
  // Own teardown immediately: setup may fail before either pool is allocated.
  const pools: { owner?: pg.Pool; runtime?: pg.Pool } = {};
  registerCleanup(async () => {
    const shutdowns = await Promise.allSettled([pools.owner?.end(), pools.runtime?.end()]);
    const failures = shutdowns.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length > 0) throw new AggregateError(failures, "Fixture pools did not close.");
    await maintenance.query(
      `DROP DATABASE ${quoteIdentifier(databaseName)} WITH (FORCE)`,
    );
  });
  const ownerUrl = new URL(adminUrl);
  ownerUrl.pathname = `/${databaseName}`;
  const ownerPool = pools.owner = new pg.Pool({ connectionString: ownerUrl.href, max: 2 });
  const runtimeUrl = new URL(requireLoopbackUrl(runtimeConnectionString!).href);
  runtimeUrl.pathname = `/${databaseName}`;
  const runtimePool = pools.runtime = new pg.Pool({ connectionString: runtimeUrl.href, max: 2 });
  for (const filename of migrations) {
    const sql = await readFile(
      new URL(`../database/postgres/migrations/${filename}`, import.meta.url),
      "utf8",
    );
    await ownerPool.query(sql);
  }
  await seedPostgresDemo(ownerPool);
  if (migrations.includes("0053_membership_capability.sql")) {
    await seedCapabilitySessionKey(ownerPool, "ws_demo");
  }
  return { ownerPool, runtimePool, databaseName };
}

const V2_CARD = JSON.stringify({
  spec: "chara_card_v2",
  spec_version: "2.0",
  data: {
    name: "下沉测试员",
    description: "验证导入下沉的角色。",
    personality: "谨慎",
    scenario: "",
    first_mes: "",
    mes_example: "",
  },
});

test(
  "T10-B7: after migration 0023 every library command runs as realm_runtime",
  { skip: !adminConnectionString || !runtimeConnectionString },
  async (t) => {
    const adminUrl = requireLoopbackUrl(adminConnectionString!);
    const maintenance = new pg.Client({
      connectionString: new URL("/postgres", adminUrl).href,
    });
    const fixtureCleanups: (() => Promise<void>)[] = [];
    const registerFixtureCleanup = (cleanup: () => Promise<void>) => { fixtureCleanups.push(cleanup); };
    // Register the owner before any fallible connect/setup. Close every allocated
    // fixture before maintenance, also when the body or another finalizer fails.
    t.after(async () => {
      const failures: unknown[] = [];
      try {
        try { await endSharedRuntimePools(); } catch (error) { failures.push(error); }
        for (const cleanup of [...fixtureCleanups].reverse()) {
          try { await cleanup(); } catch (error) { failures.push(error); }
        }
      } finally {
        try { await maintenance.end(); } catch (error) { failures.push(error); }
      }
      if (failures.length > 0) throw new AggregateError(failures, "Fixture teardown failed.");
    });
    await maintenance.connect();

    // ---- 迁移前缺口证据（0001–0022 库）：world 创建被授权拒绝 ----
    const pre = await createDatabase(registerFixtureCleanup, maintenance, adminUrl, "pre", MIGRATIONS.slice(0, -1));

    // ---- 迁移前缺口证据（0001–0022 库）：world 创建被授权拒绝 ----

    const preService = createPostgresLibraryService(pre.runtimePool);
    const scope = {
      workspaceId: "ws_demo",
      principalId: "principal_demo_player",
      sessionProof: sessionProofFor("principal_demo_player"),
    };
    await assert.rejects(
      preService.create(scope, {
        kind: "world",
        name: "缺口证据",
        era: "x",
        summary: "x",
      }),
      /permission denied/,
    );
    const preGrants = await pre.ownerPool.query(
      `SELECT has_table_privilege('realm_runtime', 'worlds', 'INSERT') AS worlds_insert,
              has_table_privilege('realm_runtime', 'participants', 'INSERT') AS participants_insert`,
    );
    assert.equal(preGrants.rows[0].worlds_insert, false);
    assert.equal(preGrants.rows[0].participants_insert, false);

    // ---- 0023 库：runtime-only 全命令逐项成功 ----
    const post = await createDatabase(registerFixtureCleanup, maintenance, adminUrl, "post", CURRENT_MIGRATIONS);
    const postGrants = await post.ownerPool.query(
      `SELECT has_table_privilege('realm_runtime', 'worlds', 'INSERT') AS worlds_insert,
              has_table_privilege('realm_runtime', 'participants', 'INSERT') AS participants_insert,
              has_column_privilege('realm_runtime', 'player_world_memberships', 'role', 'UPDATE') AS role_update,
              has_column_privilege('realm_runtime', 'skill_definitions', 'metadata', 'UPDATE') AS skill_metadata_update,
              has_column_privilege('realm_runtime', 'character_instances', 'status', 'UPDATE') AS instance_status_update`,
    );
    assert.equal(postGrants.rows[0].worlds_insert, true);
    assert.equal(postGrants.rows[0].participants_insert, true);
    // 0053：runtime 不再持有 memberships.role 直写（capability 通道替代）。
    assert.equal(postGrants.rows[0].role_update, false);
    assert.equal(postGrants.rows[0].skill_metadata_update, false);
    assert.equal(postGrants.rows[0].instance_status_update, true);

    const library = createPostgresLibraryService(post.runtimePool);
    // world → story → record（装配全链）
    await library.create(scope, {
      kind: "world",
      name: "下沉世界",
      era: "实测纪元",
      summary: "runtime-only 全命令。",
    });
    const world = (await library.list(scope)).worlds.find(
      (item) => item.name === "下沉世界",
    )!;
    assert.ok(world);
    await library.create(scope, {
      kind: "story",
      worldId: world.id,
      title: "下沉故事",
      premise: "",
    });
    const story = (await library.list(scope)).worlds.find(
      (item) => item.id === world.id,
    )!.stories[0]!;
    await library.create(scope, {
      kind: "record",
      storyId: story.id,
      title: "下沉记录",
    });
    // character + branch + attach
    await library.create(scope, {
      kind: "character",
      worldId: world.id,
      name: "守塔人",
      role: "哨卫",
      summary: "",
    });
    const withCharacter = (await library.list(scope)).worlds.find(
      (item) => item.id === world.id,
    )!;
    const definitionId = withCharacter.characters.find(
      (character) => character.name === "守塔人",
    )!.id;
    const recordId = withCharacter.stories[0]!.records[0]!.id;
    await library.create(scope, {
      kind: "branch",
      worldId: world.id,
      label: "下沉分支",
      sourceRecordId: recordId,
    });
    await library.create(scope, {
      kind: "attach-character",
      worldId: world.id,
      recordId,
      definitionId,
    });
    // archive/delete（T8 契约不回退）——须在姿态往返之前：S 语义下
    // observer→player 往返后角色是 player 而非 owner（owner 门禁需要 owner）。
    await library.create(scope, {
      kind: "world-archive",
      worldId: world.id,
      archived: true,
    });
    await library.create(scope, {
      kind: "world-archive",
      worldId: world.id,
      archived: false,
    });
    // player-stance 往返（本人，放最后避免角色漂移影响后续 owner 命令）
    await library.create(scope, {
      kind: "player-stance",
      worldId: world.id,
      stance: "observer",
    });
    await library.create(scope, {
      kind: "player-stance",
      worldId: world.id,
      stance: "player",
    });
    // createGenesis（world generate 路径）
    const genesisDraft = {
      world: { name: "下沉创世", era: "新纪元", summary: "创世下沉。" },
      style: "modern" as const,
      story: { title: "开幕", premise: "……" },
      record: { title: "第一幕" },
      playerRole: "记录者",
      companions: [{ name: "同行者", role: "旅伴", summary: "一同赶路。" }],
      scene: {
        title: "渡口夜",
        location: "渡口",
        weather: "",
        tension: "",
        displayTime: "入夜",
        objective: "",
      },
      playerStance: "player" as const,
      opening: "",
    };
    const genesis = await library.createGenesis(scope, genesisDraft, {
      creationRequestId: "genesisreq01",
    });
    assert.ok(genesis.recordId);
    const replay = await library.createGenesis(scope, genesisDraft, {
      creationRequestId: "genesisreq01",
    });
    assert.equal(replay.worldId, genesis.worldId);
    assert.equal(replay.recordId, genesis.recordId);
    const worldsAfterReplay = await post.ownerPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM worlds WHERE workspace_id = $1 AND name = '下沉创世'`,
      [scope.workspaceId],
    );
    assert.equal(worldsAfterReplay.rows[0]?.count, "1");
    await assert.rejects(
      library.createGenesis(scope, {
        ...genesisDraft,
        world: { ...genesisDraft.world, name: "另一份草稿" },
      }, { creationRequestId: "genesisreq01" }),
      (error: unknown) => error instanceof LibraryServiceError
        && error.code === "GENESIS_REQUEST_CONFLICT",
    );
    const other = await library.createGenesis(scope, genesisDraft, {
      creationRequestId: "genesisreq02",
    });
    assert.notEqual(other.worldId, genesis.worldId);
    const readBack = await library.readGenesisCreation(scope, "genesisreq01");
    assert.equal(readBack?.recordId, genesis.recordId);
    const chain = await post.ownerPool.query<{
      display_name: string;
      role: string;
      summary: string;
      continuity_id: string;
      instance_id: string;
      participant_id: string;
      controller_mode: string;
    }>(
      `SELECT definition.display_name,
              definition.profile->>'role' AS role,
              definition.profile->>'summary' AS summary,
              continuity.id AS continuity_id,
              instance.id AS instance_id,
              participant.id AS participant_id,
              participant.controller_mode
       FROM character_definitions AS definition
       JOIN character_continuities AS continuity
         ON continuity.workspace_id = definition.workspace_id
        AND continuity.world_id = definition.world_id
        AND continuity.definition_id = definition.id
       JOIN character_instances AS instance
         ON instance.workspace_id = continuity.workspace_id
        AND instance.worldline_id = continuity.worldline_id
        AND instance.continuity_id = continuity.id
       JOIN participants AS participant
         ON participant.workspace_id = instance.workspace_id
        AND participant.record_id = instance.record_id
        AND participant.character_instance_id = instance.id
       WHERE definition.workspace_id = $1
         AND definition.world_id = $2
         AND definition.display_name = '同行者'`,
      [scope.workspaceId, genesis.worldId],
    );
    assert.equal(chain.rows.length, 1);
    assert.equal(chain.rows[0]?.role, "旅伴");
    assert.equal(chain.rows[0]?.summary, "一同赶路。");
    assert.equal(chain.rows[0]?.controller_mode, "ai");
    assert.ok(chain.rows[0]?.continuity_id);
    assert.ok(chain.rows[0]?.instance_id);
    assert.ok(chain.rows[0]?.participant_id);
    await library.create(scope, {
      kind: "delete-record",
      worldId: genesis.worldId,
      recordId: genesis.recordId,
    });
    assert.equal(
      (await library.list(scope)).worlds.find((item) => item.id === genesis.worldId)
        ?.recordCount,
      0,
    );
    // tavern import（V2 JSON 卡）
    const report = await importTavernBundle(
      post.runtimePool,
      { workspaceId: scope.workspaceId, worldId: world.id },
      Buffer.from(V2_CARD, "utf8"),
      "card.json",
    );
    assert.equal(report.character?.name, "下沉测试员");
    // 自动创建 World 已经包含开幕 Record；物理删除路径因此安全拒绝，
    // 只能归档，不得为了保留旧测试而绕过这一不变量。
    await library.create(scope, {
      kind: "world",
      name: "下沉删除场",
      era: "x",
      summary: "x",
    });
    const bareWorld = (await library.list(scope)).worlds.find(
      (item) => item.name === "下沉删除场",
    )!;
    await assert.rejects(
      library.create(scope, { kind: "delete-world", worldId: bareWorld.id }),
      (error: unknown) => error instanceof LibraryServiceError
        && error.code === "WORLD_NOT_EMPTY",
    );

    // RLS：他 workspace 视角不可见/不可写。
    const foreign = createPostgresLibraryService(post.runtimePool);
    const foreignScope = { workspaceId: "ws_other", principalId: "p_other" };
    assert.equal((await foreign.list(foreignScope)).worlds.length, 0);
    await assert.rejects(
      foreign.create(foreignScope, {
        kind: "story",
        worldId: world.id,
        title: "越界",
        premise: "",
      }),
    );

    // ---- 路由层：不需要 DATABASE_URL 即可完成已下沉命令 ----
    const previousRuntime = process.env.REALM_RUNTIME_DATABASE_URL;
    const previousOwner = process.env.DATABASE_URL;
    const previousToken = process.env.REALM_ACCESS_TOKEN;
    const runtimeUrl = new URL(requireLoopbackUrl(runtimeConnectionString!).href);
    runtimeUrl.pathname = `/${post.databaseName}`;
    process.env.REALM_RUNTIME_DATABASE_URL = runtimeUrl.href;
    // 新门禁：runtime DB 存在即要求账户会话（0051 后语义）。
    const sessionCookie = `realm_session=${createSessionValue("principal_demo_player")}`;
    delete process.env.DATABASE_URL;
    delete process.env.REALM_ACCESS_TOKEN;
    try {
      const created = await libraryPOST(
        new Request("http://localhost/api/library", {
          method: "POST",
          headers: { "Content-Type": "application/json", cookie: sessionCookie },
          body: JSON.stringify({
            kind: "world",
            name: "无 owner 直连世界",
            era: "x",
            summary: "x",
          }),
        }),
      );
      assert.equal(created.status, 201, "world 创建不再需要 owner URL");
      const listed = await libraryGET(
        new Request("http://localhost/api/library", { headers: { cookie: sessionCookie } }),
      );
      assert.equal(listed.status, 200);
      const body = (await listed.json()) as { worlds: { name: string }[] };
      assert.ok(
        body.worlds.some((item) => item.name === "无 owner 直连世界"),
      );
    } finally {
      process.env.REALM_RUNTIME_DATABASE_URL = previousRuntime!;
      process.env.DATABASE_URL = previousOwner!;
      if (previousToken !== undefined) {
        process.env.REALM_ACCESS_TOKEN = previousToken;
      }
      await endSharedRuntimePools();
    }
  },
);
