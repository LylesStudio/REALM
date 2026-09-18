/**
 * 批次 T10-B7——迁移 0023 后 library/创世/导入全量下沉受限角色
 *（public documentation §五）。
 * 双临时库（t.after 强制 DROP）：pre-0023 库记录授权缺口实锤，
 * 0023 库上 runtime-only 逐项真实成功；RLS 跨 workspace 隔离；
 * T6/T8 门禁不回退；路由层不再需要 DATABASE_URL。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
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
  t: test.TestContext,
  maintenance: pg.Client,
  adminUrl: URL,
  label: string,
  migrations: readonly string[],
) {
  const databaseName = `realm_t10b7_${label}_${randomUUID().replaceAll("-", "")}`;
  await maintenance.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
  const ownerUrl = new URL(adminUrl);
  ownerUrl.pathname = `/${databaseName}`;
  const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 2 });
  const runtimeUrl = new URL(requireLoopbackUrl(runtimeConnectionString!).href);
  runtimeUrl.pathname = `/${databaseName}`;
  const runtimePool = new pg.Pool({ connectionString: runtimeUrl.href, max: 2 });
  t.after(async () => {
    await ownerPool.end();
    await runtimePool.end();
    await maintenance.query(
      `DROP DATABASE ${quoteIdentifier(databaseName)} WITH (FORCE)`,
    );
  });
  for (const filename of migrations) {
    const sql = await readFile(
      new URL(`../database/postgres/migrations/${filename}`, import.meta.url),
      "utf8",
    );
    await ownerPool.query(sql);
  }
  await seedPostgresDemo(ownerPool);
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
    await maintenance.connect();

    // ---- 迁移前缺口证据（0001–0022 库）：world 创建被授权拒绝 ----
    const pre = await createDatabase(t, maintenance, adminUrl, "pre", MIGRATIONS.slice(0, -1));
    const preService = createPostgresLibraryService(pre.runtimePool);
    const scope = { workspaceId: "ws_demo", principalId: "principal_demo_player" };
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
    const post = await createDatabase(t, maintenance, adminUrl, "post", CURRENT_MIGRATIONS);
    const postGrants = await post.ownerPool.query(
      `SELECT has_table_privilege('realm_runtime', 'worlds', 'INSERT') AS worlds_insert,
              has_table_privilege('realm_runtime', 'participants', 'INSERT') AS participants_insert,
              has_column_privilege('realm_runtime', 'player_world_memberships', 'role', 'UPDATE') AS role_update,
              has_column_privilege('realm_runtime', 'skill_definitions', 'metadata', 'UPDATE') AS skill_metadata_update,
              has_column_privilege('realm_runtime', 'character_instances', 'status', 'UPDATE') AS instance_status_update`,
    );
    assert.equal(postGrants.rows[0].worlds_insert, true);
    assert.equal(postGrants.rows[0].participants_insert, true);
    assert.equal(postGrants.rows[0].role_update, true);
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
    const genesis = await library.createGenesis(scope, {
      world: { name: "下沉创世", era: "新纪元", summary: "创世下沉。" },
      style: "modern",
      story: { title: "开幕", premise: "……" },
      record: { title: "第一幕" },
      playerRole: "记录者",
      companions: [{ name: "同行者", role: "旅伴", summary: "" }],
      scene: { location: "渡口", weather: "", tension: "", objective: "" },
      playerStance: "player",
      opening: "",
    });
    assert.ok(genesis.recordId);
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
    delete process.env.DATABASE_URL;
    delete process.env.REALM_ACCESS_TOKEN;
    try {
      const created = await libraryPOST(
        new Request("http://localhost/api/library", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
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
        new Request("http://localhost/api/library"),
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
    // 最后拆维护连接（t.after 按注册顺序执行——必须晚于各库 DROP）。
    t.after(async () => {
      await maintenance.end();
    });
  },
);
