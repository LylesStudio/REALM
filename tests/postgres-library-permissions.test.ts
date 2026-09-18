/**
 * 批次 T10-B6——Library 非管理命令权限矩阵 + 分池
 * （public documentation §六）。
 * 真实临时 PG（t.after 拆库）：list 成员可见/非成员不见；矩阵逐格
 * （owner/player/observer/非成员 × style/content/stance/archive/delete）；
 * 受限 realm_runtime 池实锤（runtime-capable 命令真实完成、owner 例外在
 * runtime 池上 permission denied 证明分池为真）；路由层 env 缺口 503。
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
import { endSharedRuntimePools } from "../app/api/world-scope.ts";
import {
  GET as libraryGET,
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
    "0039_scene_weather_snapshot.sql",
      "0040_scene_display_time_snapshot.sql",
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

const OWNER = "principal_demo_player";
const PLAYER = "principal_player_two";
const OBSERVER = "principal_observer_one";
const STRANGER = "principal_stranger";

test(
  "T10-B6: library permission matrix and pool split hold on a real database",
  { skip: !adminConnectionString || !runtimeConnectionString },
  async (t) => {
    const adminUrl = requireLoopbackUrl(adminConnectionString!);
    const databaseName = `realm_t10b6_${randomUUID().replaceAll("-", "")}`;
    const maintenanceUrl = new URL(adminUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
    await maintenance.connect();
    await maintenance.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);

    const ownerUrl = new URL(adminUrl);
    ownerUrl.pathname = `/${databaseName}`;
    const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 3 });
    const runtimeUrl = new URL(requireLoopbackUrl(runtimeConnectionString!).href);
    runtimeUrl.pathname = `/${databaseName}`;
    const runtimePool = new pg.Pool({ connectionString: runtimeUrl.href, max: 3 });

    t.after(async () => {
      await ownerPool.end();
      await runtimePool.end();
      await maintenance.query(
        `DROP DATABASE ${quoteIdentifier(databaseName)} WITH (FORCE)`,
      );
      await maintenance.end();
    });

    for (const filename of MIGRATIONS) {
      const sql = await readFile(
        new URL(`../database/postgres/migrations/${filename}`, import.meta.url),
        "utf8",
      );
      await ownerPool.query(sql);
    }
    await seedPostgresDemo(ownerPool);

    // 角色席位：player/observer 加入 demo 世界（owner 由种子自带）。
    for (const [principal, role] of [
      [PLAYER, "player"],
      [OBSERVER, "observer"],
    ] as const) {
      await ownerPool.query(
        `INSERT INTO player_world_memberships (
           workspace_id, world_id, principal_id, role,
           omniscient_player_character, can_view_dynamic_knowledge
         ) VALUES ('ws_demo', 'world_ember_coast', $1, $2, true, true)`,
        [principal, role],
      );
    }

    const library = createPostgresLibraryService(ownerPool);
    const scoped = (principalId: string) => ({
      workspaceId: "ws_demo",
      principalId,
    });

    // ---- list：成员可见、非成员不见、role 如实投影 ----
    const ownerList = await library.list(scoped(OWNER));
    assert.ok(ownerList.worlds.some((world) => world.id === "world_ember_coast"));
    const strangerList = await library.list(scoped(STRANGER));
    assert.equal(strangerList.worlds.length, 0, "非成员不得看见任何世界");
    const observerList = await library.list(scoped(OBSERVER));
    assert.equal(
      observerList.worlds.find((world) => world.id === "world_ember_coast")
        ?.membershipRole,
      "observer",
    );

    // ---- world-style：owner-only ----
    await assert.rejects(
      library.create(scoped(PLAYER), {
        kind: "world-style",
        worldId: "world_ember_coast",
        style: "modern",
      }),
      (error: unknown) =>
        error instanceof LibraryServiceError && error.code === "WORLD_NOT_OWNED",
    );
    await assert.rejects(
      library.create(scoped(OBSERVER), {
        kind: "world-style",
        worldId: "world_ember_coast",
        style: "modern",
      }),
      (error: unknown) =>
        error instanceof LibraryServiceError && error.code === "WORLD_NOT_OWNED",
    );
    // owner-only 命令对非成员沿用 T8 口径（403 WORLD_NOT_OWNED）。
    await assert.rejects(
      library.create(scoped(STRANGER), {
        kind: "world-style",
        worldId: "world_ember_coast",
        style: "modern",
      }),
      (error: unknown) =>
        error instanceof LibraryServiceError && error.code === "WORLD_NOT_OWNED",
    );

    // ---- 内容命令：observer 403 / 非成员 404 / player 放行 ----
    await assert.rejects(
      library.create(scoped(OBSERVER), {
        kind: "story",
        worldId: "world_ember_coast",
        title: "观察者故事",
        premise: "",
      }),
      (error: unknown) =>
        error instanceof LibraryServiceError && error.code === "WORLD_READ_ONLY",
    );
    await assert.rejects(
      library.create(scoped(STRANGER), {
        kind: "story",
        worldId: "world_ember_coast",
        title: "陌生人故事",
        premise: "",
      }),
      (error: unknown) =>
        error instanceof LibraryServiceError && error.code === "WORLD_NOT_FOUND",
    );
    // player 在自己创建的世界（创建者即 owner）放行——先由 player 创建。
    await library.create(scoped(PLAYER), {
      kind: "world",
      name: "玩家领地",
      era: "实测纪元",
      summary: "player 的世界。",
    });
    const playerWorld = (await library.list(scoped(PLAYER))).worlds.find(
      (world) => world.name === "玩家领地",
    )!;
    await library.create(scoped(PLAYER), {
      kind: "story",
      worldId: playerWorld.id,
      title: "玩家故事",
      premise: "",
    });
    const playerStarterRecord = playerWorld.stories[0]?.records[0];
    assert.ok(playerStarterRecord, "player world should have a starter record");
    await library.create(scoped(PLAYER), {
      kind: "branch",
      worldId: playerWorld.id,
      label: "玩家分支",
      sourceRecordId: playerStarterRecord.id,
    });
    // observer 对 player 的世界（非成员）404。
    await assert.rejects(
      library.create(scoped(OBSERVER), {
        kind: "story",
        worldId: playerWorld.id,
        title: "x",
        premise: "",
      }),
      (error: unknown) =>
        error instanceof LibraryServiceError && error.code === "WORLD_NOT_FOUND",
    );

    // ---- player-stance：仅本人；非成员 404 ----
    await assert.rejects(
      library.create(scoped(STRANGER), {
        kind: "player-stance",
        worldId: "world_ember_coast",
        stance: "observer",
      }),
      (error: unknown) =>
        error instanceof LibraryServiceError && error.code === "WORLD_NOT_FOUND",
    );
    // 本人往返（demo owner 在演示记录有既有席位，S 批次已覆盖该路径）。
    await library.create(scoped(OWNER), {
      kind: "player-stance",
      worldId: "world_ember_coast",
      stance: "observer",
    });
    assert.equal(
      (await library.list(scoped(OWNER))).worlds.find(
        (world) => world.id === "world_ember_coast",
      )?.membershipRole,
      "observer",
    );
    await library.create(scoped(OWNER), {
      kind: "player-stance",
      worldId: "world_ember_coast",
      stance: "player",
    });

    // ---- archive/delete：T8 owner 契约不回归 ----
    await assert.rejects(
      library.create(scoped(PLAYER), {
        kind: "world-archive",
        worldId: "world_ember_coast",
        archived: true,
      }),
      (error: unknown) =>
        error instanceof LibraryServiceError && error.code === "WORLD_NOT_OWNED",
    );

    // ---- 分池实锤：runtime 池承载 style/story/branch/archive/delete ----
    const runtimeOnly = createPostgresLibraryService(runtimePool);
    assert.ok(
      (await runtimeOnly.list(scoped(OWNER))).worlds.length >= 1,
      "runtime 池可读 list",
    );
    // 注意：owner 姿态往返后 role='player'（S 语义）——style 用 player
    // 自建的世界（创建者即 owner）。
    await runtimeOnly.create(scoped(PLAYER), {
      kind: "world-style",
      worldId: playerWorld.id,
      style: "modern",
    });
    await runtimeOnly.create(scoped(PLAYER), {
      kind: "story",
      worldId: playerWorld.id,
      title: "受限角色故事",
      premise: "",
    });
    await runtimeOnly.create(scoped(PLAYER), {
      kind: "branch",
      worldId: playerWorld.id,
      label: "受限角色分支",
      sourceRecordId: playerStarterRecord.id,
    });
    // owner 例外在 runtime 池上物理不可写（证明分池不是装饰）。
    await assert.rejects(
      runtimeOnly.create(scoped(PLAYER), {
        kind: "world",
        name: "不应建成",
        era: "x",
        summary: "x",
      }),
      /permission denied/,
    );

    // ---- 路由层：runtime URL 缺失 → 503 ----
    const previousRuntime = process.env.REALM_RUNTIME_DATABASE_URL;
    const previousOwner = process.env.DATABASE_URL;
    const previousToken = process.env.REALM_ACCESS_TOKEN;
    delete process.env.REALM_RUNTIME_DATABASE_URL;
    delete process.env.REALM_ACCESS_TOKEN;
    try {
      // getLibraryService 先查 runtime URL 再碰缓存——缺失时确定性 503。
      const response = await libraryGET(
        new Request("http://localhost/api/library"),
      );
      assert.equal(response.status, 503);
      const body = (await response.json()) as { error?: { code?: string } };
      assert.equal(body.error?.code, "LOCAL_RUNTIME_NOT_INITIALIZED");
    } finally {
      process.env.REALM_RUNTIME_DATABASE_URL = previousRuntime!;
      if (previousToken !== undefined) {
        process.env.REALM_ACCESS_TOKEN = previousToken;
      }
      void previousOwner;
      await endSharedRuntimePools();
    }
  },
);
