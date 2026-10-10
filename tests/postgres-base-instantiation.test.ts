/**
 * Base provider 统一内容层 · disposable PostgreSQL application acceptance。
 *
 * 证明（引擎升级计划 §6 的 base 接线 bounded slice）：
 * - base 经统一 plan → draft → createGenesis 物化契约创建世界/记录，落库
 *   worlds.world_version 与 records.world_version 恒为 LOCAL_WORLD_VERSION
 *   哨兵，Library 读回 binding 恒为 { kind: "base" }；
 * - 全程无 install root / trust-store / 签名 / 网络（测试显式清空相关 env）；
 * - engine-owned Goal 定义随 genesis 物化为 goal_instances，并对真实
 *   opening 事件 enqueue durable assessment job（records.world_version
 *   哨兵 → claim 路径走 base resolver）；
 * - preset 入口改经 provider 后行为不变（仍写哨兵 binding）；
 * - 失败路径（未知 Goal key / world-bound 计划 / 夹带身份的伪 base
 *   binding）零残留。
 *
 * 自包含隔离：在本集群新建专属一次性数据库、应用完整 migration chain、
 * 结束时 DROP DATABASE，绝不写共享数据库。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import {
  seedPostgresDemo,
} from "../database/postgres/public.ts";
import {
  LibraryServiceError,
  createPostgresLibraryService,
} from "../modules/application/library-service.ts";
import {
  LOCAL_RECORD_SCOPE,
} from "../modules/application/local-record-service.ts";
import {
  BaseContentError,
  createBaseInstantiationPlan,
  type BaseInstantiationPlan,
} from "../modules/world-transfer/base-content.ts";
import { LOCAL_WORLD_VERSION } from "../modules/world-transfer/realm-save.ts";
import {
  goalAssessmentJobIdFor,
  goalInstanceIdFor,
} from "../modules/goals/public.ts";
import {
  installTestSessionSecret,
  seedCapabilitySessionKey,
  sessionProofFor,
} from "./helpers/session-proof.ts";

installTestSessionSecret();

const adminConnectionString = process.env.DATABASE_URL;

const migrationDir = new URL("../database/postgres/migrations/", import.meta.url);

const BASE_PARAMETERS = {
  world: { name: "BaseAcc 雾港", era: "长雾纪元 7 年", summary: "灯塔熄灭的港口。" },
  language: "zh-CN",
  style: "classical",
  story: { title: "熄灯之夜", premise: "守灯人失踪了。" },
  record: { title: "第一夜" },
  playerRole: "新任守灯人",
  playerStance: "player",
  characters: [
    { displayName: "阿汐", role: "潮汐记录员", summary: "记得每一次涨潮。" },
  ],
  scene: {
    title: "旧灯塔",
    location: "灯塔顶层",
    weather: "浓雾",
    tension: "灯油将尽",
    displayTime: "子时",
    objective: "重新点灯",
  },
  opening: "雾把灯塔吞到只剩一圈昏黄。",
  goals: ["base.first-narration"],
} as const;

test(
  "base instantiation unifies on the genesis materialization contract without any package/trust config",
  { skip: !adminConnectionString, timeout: 300_000 },
  async (t) => {
    const adminUrl = requireLoopbackUrl(adminConnectionString!);
    const databaseName = `realm_base_inst_${randomUUID().replaceAll("-", "")}`;
    const maintenanceUrl = new URL(adminUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
    await maintenance.connect();
    await maintenance.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);

    const ownerUrl = new URL(adminUrl);
    ownerUrl.pathname = `/${databaseName}`;
    const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 2 });
    ownerPool.on("error", () => {});

    // 显式证明：base 路径无 package/trust 配置也可用。
    const previousInstallRoot = process.env.REALM_REALMWORLD_INSTALL_ROOT;
    const previousTrustStore = process.env.REALM_REALMWORLD_TRUST_STORE;
    delete process.env.REALM_REALMWORLD_INSTALL_ROOT;
    delete process.env.REALM_REALMWORLD_TRUST_STORE;

    t.after(async () => {
      if (previousInstallRoot === undefined) delete process.env.REALM_REALMWORLD_INSTALL_ROOT;
      else process.env.REALM_REALMWORLD_INSTALL_ROOT = previousInstallRoot;
      if (previousTrustStore === undefined) delete process.env.REALM_REALMWORLD_TRUST_STORE;
      else process.env.REALM_REALMWORLD_TRUST_STORE = previousTrustStore;
      await ownerPool.end();
      await maintenance.query(
        `DROP DATABASE ${quoteIdentifier(databaseName)} WITH (FORCE)`,
      );
      await maintenance.end();
    });

    for (const filename of (await readdir(migrationDir)).sort()) {
      if (!filename.endsWith(".sql")) continue;
      await ownerPool.query(await readFile(new URL(`../database/postgres/migrations/${filename}`, import.meta.url), "utf8"));
    }
    await seedPostgresDemo(ownerPool);
    await seedCapabilitySessionKey(ownerPool, LOCAL_RECORD_SCOPE.workspaceId);
    await ownerPool.query(
      `INSERT INTO accounts (workspace_id, principal_id, display_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, display_name) DO NOTHING`,
      [LOCAL_RECORD_SCOPE.workspaceId, LOCAL_RECORD_SCOPE.principalId, "测试旅人"],
    );

    const service = createPostgresLibraryService(ownerPool);
    const scope = {
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      principalId: LOCAL_RECORD_SCOPE.principalId,
      sessionProof: sessionProofFor(LOCAL_RECORD_SCOPE.principalId),
    };

    // ===== 正向：base plan 经统一物化契约落库 =====
    const plan = createBaseInstantiationPlan(BASE_PARAMETERS);
    const created = await service.instantiateBaseWorld(scope, plan);

    const worldRow = await ownerPool.query<{
      world_version: string;
      settings: Record<string, unknown>;
    }>(
      `SELECT world_version, settings
       FROM worlds WHERE workspace_id = $1 AND id = $2`,
      [scope.workspaceId, created.worldId],
    );
    assert.equal(worldRow.rows[0]?.world_version, LOCAL_WORLD_VERSION);
    assert.equal(worldRow.rows[0]?.settings.style, "classical");
    assert.equal(worldRow.rows[0]?.settings.language, "zh-CN");
    assert.equal(worldRow.rows[0]?.settings.displayTime, "子时");

    const recordRow = await ownerPool.query<{ world_version: string }>(
      `SELECT world_version
       FROM records WHERE workspace_id = $1 AND id = $2`,
      [scope.workspaceId, created.recordId],
    );
    assert.equal(recordRow.rows[0]?.world_version, LOCAL_WORLD_VERSION);

    // Library 读模型：哨兵版本 → 精确 base binding（绝不偷绑 worldId）。
    const snapshot = await service.list(scope);
    const baseWorld = snapshot.worlds.find((world) => world.id === created.worldId);
    assert.ok(baseWorld);
    assert.equal(baseWorld.worldVersion, LOCAL_WORLD_VERSION);
    assert.deepEqual(baseWorld.binding, { kind: "base" });

    // 场景与阵容按草稿装配（人类玩家 + 内容层角色）。
    const sceneRow = await ownerPool.query<{ title: string; display_time: string }>(
      `SELECT title, display_time
       FROM scenes WHERE workspace_id = $1 AND record_id = $2`,
      [scope.workspaceId, created.recordId],
    );
    assert.equal(sceneRow.rows[0]?.title, "旧灯塔");
    assert.equal(sceneRow.rows[0]?.display_time, "子时");
    const characterRows = await ownerPool.query<{ display_name: string }>(
      `SELECT display_name
       FROM character_definitions
       WHERE workspace_id = $1 AND world_id = $2
       ORDER BY display_name`,
      [scope.workspaceId, created.worldId],
    );
    assert.deepEqual(
      characterRows.rows.map((row) => row.display_name),
      // 人类玩家定义由物化层自动装配，内容层角色来自 base plan。
      ["测试旅人", "阿汐"].sort(),
    );

    // opening 旁白事件真实落库（draft.opening 非空 → 直接使用内容层文本）。
    const openingEvent = await ownerPool.query<{ id: string; content: string }>(
      `SELECT id, content
       FROM events
       WHERE workspace_id = $1 AND record_id = $2
         AND event_kind = 'narration.committed'
       ORDER BY record_ordinal
       LIMIT 1`,
      [scope.workspaceId, created.recordId],
    );
    assert.equal(openingEvent.rows.length, 1);
    assert.equal(openingEvent.rows[0]?.content, "雾把灯塔吞到只剩一圈昏黄。");

    // engine-owned Goal 物化：goal_instances + 对 opening 事件的 durable job。
    const goalScope = {
      workspaceId: scope.workspaceId,
      worldId: created.worldId,
      worldlineId: (
        await ownerPool.query<{ worldline_id: string }>(
          `SELECT worldline_id FROM records
           WHERE workspace_id = $1 AND id = $2`,
          [scope.workspaceId, created.recordId],
        )
      ).rows[0]!.worldline_id,
      recordId: created.recordId,
    };
    const goalInstances = await ownerPool.query<{
      id: string;
      goal_key: string;
      state: string;
      policy_version: string;
    }>(
      `SELECT id, goal_key, state, policy_version
       FROM goal_instances
       WHERE workspace_id = $1 AND record_id = $2`,
      [scope.workspaceId, created.recordId],
    );
    assert.equal(goalInstances.rows.length, 1);
    assert.equal(goalInstances.rows[0]?.goal_key, "base.first-narration");
    assert.equal(goalInstances.rows[0]?.policy_version, "base-v1");
    assert.equal(goalInstances.rows[0]?.state, "active");
    assert.equal(
      goalInstances.rows[0]?.id,
      goalInstanceIdFor(goalScope, "base.first-narration"),
    );
    const goalJobs = await ownerPool.query<{
      id: string;
      goal_instance_id: string;
      source_event_id: string;
      state: string;
    }>(
      `SELECT id, goal_instance_id, source_event_id, state
       FROM goal_assessment_jobs
       WHERE workspace_id = $1 AND record_id = $2`,
      [scope.workspaceId, created.recordId],
    );
    assert.equal(goalJobs.rows.length, 1);
    assert.equal(goalJobs.rows[0]?.goal_instance_id, goalInstances.rows[0]!.id);
    assert.equal(goalJobs.rows[0]?.source_event_id, openingEvent.rows[0]!.id);
    assert.equal(goalJobs.rows[0]?.state, "pending");
    assert.equal(
      goalJobs.rows[0]?.id,
      goalAssessmentJobIdFor(
        scope.workspaceId,
        goalInstances.rows[0]!.id,
        openingEvent.rows[0]!.id,
      ),
    );

    // ===== preset 入口经 provider 后行为不变（仍写哨兵 binding）=====
    const preset = await service.create(scope, {
      kind: "preset-world",
      presetKey: "anime-hero",
      language: "en",
    });
    assert.ok(preset?.recordId);
    const presetVersion = await ownerPool.query<{ world_version: string }>(
      `SELECT world_version FROM records
       WHERE workspace_id = $1 AND id = $2`,
      [scope.workspaceId, preset.recordId],
    );
    assert.equal(presetVersion.rows[0]?.world_version, LOCAL_WORLD_VERSION);
    const presetSnapshot = await service.list(scope);
    const presetWorld = presetSnapshot.worlds.find(
      (world) => world.name === "The Village Before the Demon King's Castle",
    );
    assert.ok(presetWorld);
    assert.deepEqual(presetWorld.binding, { kind: "base" });

    // ===== 失败路径零残留 =====
    // 快照在正向用例之后、失败用例之前采集：失败路径不得新增任何
    // worlds（BaseAcc 前缀）/records（BaseAcc 前缀）/goal_instances/jobs。
    const residueSnapshot = async () => {
      const rows = await ownerPool.query<{
        worlds: string;
        records: string;
        goal_instances: string;
        goal_jobs: string;
      }>(
        `SELECT
           (SELECT count(*) FROM worlds
             WHERE workspace_id = $1 AND name LIKE 'BaseAcc%')::text AS worlds,
           (SELECT count(*) FROM records
             WHERE workspace_id = $1 AND title LIKE 'BaseAcc%')::text AS records,
           (SELECT count(*) FROM goal_instances
             WHERE workspace_id = $1)::text AS goal_instances,
           (SELECT count(*) FROM goal_assessment_jobs
             WHERE workspace_id = $1)::text AS goal_jobs`,
        [scope.workspaceId],
      );
      return rows.rows[0]!;
    };
    const preFailure = await residueSnapshot();
    // 1) 未知 engine-owned Goal key：plan 构建 fail-closed，零 DB 写入。
    assert.throws(
      () => createBaseInstantiationPlan({
        ...BASE_PARAMETERS,
        world: { name: "BaseAcc 未知目标" },
        record: { title: "BaseAcc 未知目标" },
        goals: ["missing.goal"],
      }),
      (error: unknown) => error instanceof BaseContentError
        && error.code === "BASE_GOAL_UNKNOWN",
    );
    // 2) world-bound 计划绝不走 base 通道（不降级、不伪装）。
    const worldBound = {
      ...plan,
      world: { ...plan.world, name: "BaseAcc 越界世界" },
      record: { title: "BaseAcc 越界记录" },
      binding: { kind: "world", worldId: "world_harbor", worldVersion: "1.2.0" },
    } as unknown as BaseInstantiationPlan;
    await assert.rejects(
      service.instantiateBaseWorld(scope, worldBound),
      (error: unknown) => error instanceof LibraryServiceError
        && error.code === "INVALID_COMMAND",
    );
    // 3) 夹带身份键的伪 base binding 同样 fail-closed。
    const forged = {
      ...plan,
      world: { ...plan.world, name: "BaseAcc 伪造世界" },
      record: { title: "BaseAcc 伪造记录" },
      binding: { kind: "base", worldId: "world_harbor" },
    } as unknown as BaseInstantiationPlan;
    await assert.rejects(
      service.instantiateBaseWorld(scope, forged),
      (error: unknown) => error instanceof LibraryServiceError
        && error.code === "INVALID_COMMAND",
    );
    const after = await residueSnapshot();
    assert.deepEqual(after, preFailure);
  },
);

function requireLoopbackUrl(value: string): URL {
  const url = new URL(value);
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(url.hostname)) {
    throw new Error("PostgreSQL integration tests only accept a loopback DATABASE_URL.");
  }
  return url;
}

function quoteIdentifier(value: string): string {
  if (!/^realm_base_inst_[a-f0-9]+$/.test(value)) {
    throw new Error("Unsafe temporary database identifier.");
  }
  return `"${value}"`;
}
