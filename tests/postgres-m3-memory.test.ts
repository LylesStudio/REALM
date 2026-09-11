import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import {
  createPostgresCharacterMemoryRepository,
  seedPostgresDemo,
} from "../database/postgres/public.ts";
import {
  createCharacterMemoryService,
  estimateMemoryTokens,
  extractMemoryKeywords,
  lexicalEmbedding,
} from "../modules/memory/public.ts";

const adminConnectionString = process.env.DATABASE_URL;

const PLAYER_SCOPE = {
  workspaceId: "ws_demo",
  worldId: "world_ember_coast",
  worldlineId: "worldline_origin",
  recordId: "record_first_watch",
  characterInstanceId: "char_inst_player",
} as const;

const SCOUT_SCOPE = { ...PLAYER_SCOPE, characterInstanceId: "char_inst_scout" } as const;

async function createMigratedDatabase(t: test.TestContext) {
  const adminUrl = requireLoopbackUrl(adminConnectionString!);
  const databaseName = `realm_m3_test_${randomUUID().replaceAll("-", "")}`;
  const maintenanceUrl = new URL(adminUrl);
  maintenanceUrl.pathname = "/postgres";
  const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
  await maintenance.connect();
  await maintenance.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);

  const ownerUrl = new URL(adminUrl);
  ownerUrl.pathname = `/${databaseName}`;
  const owner = new pg.Client({ connectionString: ownerUrl.href });
  await owner.connect();
  const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 2 });

  t.after(async () => {
    await ownerPool.end();
    await owner.end();
    await maintenance.query(
      `DROP DATABASE ${quoteIdentifier(databaseName)} WITH (FORCE)`,
    );
    await maintenance.end();
  });

  for (const filename of [
    "0001_runtime_contract.sql",
    "0002_runtime_contract_hardening.sql",
    "0003_runtime_repository.sql",
    "0004_runtime_security_hardening.sql",
    "0005_hybrid_memory.sql",
    "0006_action_state_ledger.sql",
    "0007_dynamic_visibility_policies.sql",
    "0008_record_timeline_kind.sql",
    "0009_memory_m3_completion.sql",
    "0039_scene_weather_snapshot.sql",
      "0040_scene_display_time_snapshot.sql",
  ]) {
    const sql = await readFile(
      new URL(`../database/postgres/migrations/${filename}`, import.meta.url),
      "utf8",
    );
    await owner.query(sql);
  }
  await seedPostgresDemo(ownerPool);
  return ownerPool;
}

test(
  "relationship states are observer-scoped, revisable and evidence-backed",
  { skip: !adminConnectionString },
  async (t) => {
    const ownerPool = await createMigratedDatabase(t);
    const memory = createCharacterMemoryService({
      repository: createPostgresCharacterMemoryRepository(ownerPool),
    });

    await memory.recordRelationship({
      ...PLAYER_SCOPE,
      targetKey: "塞娜",
      relationKind: "trust",
      content: "塞娜救过我一次，值得信赖",
    });
    const first = await memory.relationships(PLAYER_SCOPE);
    assert.ok(first.includes("对 塞娜"));
    assert.ok(first.includes("值得信赖"));

    // 修订：同一观察者、对象、关系种类只有一条当前状态。
    await memory.recordRelationship({
      ...PLAYER_SCOPE,
      targetKey: "塞娜",
      relationKind: "trust",
      content: "塞娜在灯塔前再次掩护了我，信任加深",
    });
    const revised = await memory.relationships(PLAYER_SCOPE);
    assert.ok(revised.includes("信任加深"));
    assert.ok(!revised.includes("值得信赖"));
    const stateRows = await ownerPool.query(
      `SELECT content, created_at::text, updated_at::text
       FROM relationship_states
       WHERE observer_continuity_id = 'continuity_player'`,
    );
    assert.equal(stateRows.rows.length, 1);
    assert.ok(stateRows.rows[0].updated_at >= stateRows.rows[0].created_at);

    // 每次修订都回写 append-only 证据结论。
    const evidence = await ownerPool.query(
      `SELECT content FROM memory_conclusions
       WHERE observer_continuity_id = 'continuity_player'
         AND memory_kind = 'relationship'
       ORDER BY created_at`,
    );
    assert.equal(evidence.rows.length, 2);

    // 召回不能扩大 ACL：塞娜的视角读不到玩家的关系状态与结论。
    const scoutRelationships = await memory.relationships(SCOUT_SCOPE);
    assert.ok(!scoutRelationships.includes("值得信赖"));
    assert.ok(!scoutRelationships.includes("信任加深"));
    const scoutRecall = await memory.recall({
      ...SCOUT_SCOPE,
      query: "值得信赖 信任加深",
      limit: 10,
    });
    assert.ok(
      scoutRecall.every((item) =>
        !item.content.includes("值得信赖") && !item.content.includes("信任加深")
      ),
    );

    // 分域摘要：生成、持久化并携带 domain 元数据。
    const episodic = await memory.summarizeDomain(PLAYER_SCOPE, "episodic");
    const decision = await memory.summarizeDomain(PLAYER_SCOPE, "decision", "dm");
    assert.ok(episodic.startsWith("情景要点："));
    assert.ok(decision.startsWith("决策要点："));
    const domains = await ownerPool.query(
      `SELECT DISTINCT metadata->>'summaryDomain' AS domain
       FROM memory_conclusions
       WHERE observer_continuity_id = 'continuity_player'
         AND memory_kind = 'summary'`,
    );
    assert.deepEqual(
      domains.rows.map((row) => row.domain).sort(),
      ["decision", "episodic"],
    );
  },
);

test(
  "snapshots are immutable, deltas are incremental, epochs invalidate on revision",
  { skip: !adminConnectionString },
  async (t) => {
    const ownerPool = await createMigratedDatabase(t);
    const repository = createPostgresCharacterMemoryRepository(ownerPool);
    const memory = createCharacterMemoryService({ repository });

    const snapshot = await memory.snapshot(PLAYER_SCOPE);
    assert.ok(snapshot);
    assert.equal(snapshot!.cacheEpoch, 0);

    // 快照不可变。
    await assert.rejects(
      ownerPool.query(
        `UPDATE memory_snapshots SET content = '篡改' WHERE id = $1`,
        [snapshot!.id],
      ),
    );
    await assert.rejects(
      ownerPool.query(`DELETE FROM memory_snapshots WHERE id = $1`, [snapshot!.id]),
    );

    // 世界时间推进后新增结论：delta 返回增量，epoch 不变。
    await ownerPool.query(
      `UPDATE worldlines
       SET head_tick = head_tick + 1, head_ordinal = head_ordinal + 1
       WHERE workspace_id = 'ws_demo' AND id = 'worldline_origin'`,
    );
    await repository.appendAuthorized({
      ...PLAYER_SCOPE,
      observedEntityKey: "self",
      content: "快照之后才知道的新事实",
      memoryKind: "explicit",
      fidelity: 1,
      keywords: extractMemoryKeywords("快照之后才知道的新事实"),
      embedding: lexicalEmbedding("快照之后才知道的新事实"),
      embeddingModel: "realm-lexical-v1",
    });
    const incremental = await memory.delta(PLAYER_SCOPE, snapshot!.id);
    assert.ok(incremental);
    assert.equal(incremental!.stale, false);
    assert.equal(incremental!.cacheEpoch, 0);
    assert.ok(
      incremental!.items.some((item) => item.content.includes("快照之后才知道的新事实")),
    );
    const addedId = incremental!.items.find(
      (item) => item.content.includes("快照之后才知道的新事实"),
    )!.id;

    // update/retract 改写历史解释：epoch 递进，旧 delta 判定 stale。
    await repository.appendAuthorized({
      ...PLAYER_SCOPE,
      observedEntityKey: "self",
      content: "修订：新事实需要修正",
      memoryKind: "explicit",
      fidelity: 1,
      keywords: extractMemoryKeywords("修订：新事实需要修正"),
      embedding: lexicalEmbedding("修订：新事实需要修正"),
      embeddingModel: "realm-lexical-v1",
      operation: "update",
      supersedesMemoryId: addedId,
    });
    const stale = await memory.delta(PLAYER_SCOPE, snapshot!.id);
    assert.ok(stale);
    assert.equal(stale!.stale, true);
    assert.equal(stale!.cacheEpoch, 1);
    assert.equal(stale!.items.length, 0);

    // 修订后的召回不再返回被取代的旧结论。
    const recalled = await memory.recall({
      ...PLAYER_SCOPE,
      query: "快照之后才知道的新事实",
      limit: 10,
    });
    assert.ok(
      recalled.every((item) => !item.content.includes("快照之后才知道的新事实")),
    );
  },
);

test(
  "recall never inherits future, parallel-worldline or unauthorized memories",
  { skip: !adminConnectionString },
  async (t) => {
    const ownerPool = await createMigratedDatabase(t);
    const memory = createCharacterMemoryService({
      repository: createPostgresCharacterMemoryRepository(ownerPool),
    });

    // 未来记忆：直接写入一条 available_from 远在未来游标的结论
    // （演示世界线 head tick 为 17_121_219，未来游标必须大于它）。
    await ownerPool.query(
      `INSERT INTO memory_conclusions (
         workspace_id, world_id, worldline_id, observer_continuity_id,
         observed_entity_key, id, operation, memory_kind, content,
         keywords, semantic_embedding, embedding_model, fidelity,
         occurred_tick, occurred_ordinal,
         available_from_tick, available_from_ordinal
       ) VALUES (
         'ws_demo', 'world_ember_coast', 'worldline_origin', 'continuity_player',
         'self', 'mem_future_test', 'add', 'explicit', '未来禁忌知识不应被召回',
         $1::text[], $2::vector, 'realm-lexical-v1', 1.0,
         0, 0, 18000000, 9000
       )`,
      [
        extractMemoryKeywords("未来禁忌知识不应被召回"),
        `[${lexicalEmbedding("未来禁忌知识不应被召回").join(",")}]`,
      ],
    );
    const futureRecall = await memory.recall({
      ...PLAYER_SCOPE,
      query: "未来禁忌知识不应被召回",
      limit: 10,
    });
    assert.ok(
      futureRecall.every((item) => !item.content.includes("未来禁忌知识")),
    );

    // 平行世界线记忆：分支世界线上的结论对原世界线不可见。
    await ownerPool.query(
      `INSERT INTO worldlines (
         workspace_id, world_id, id, label, status,
         parent_worldline_id, fork_tick, fork_ordinal, head_tick, head_ordinal
       ) VALUES (
         'ws_demo', 'world_ember_coast', 'worldline_branch_test', '测试分支', 'active',
         'worldline_origin', 0, 0, 0, 0
       )`,
    );
    await ownerPool.query(
      `INSERT INTO character_continuities (
         workspace_id, world_id, worldline_id, definition_id, id,
         continuity_key, status, born_tick, born_ordinal
       ) VALUES (
         'ws_demo', 'world_ember_coast', 'worldline_branch_test', 'char_def_scout',
         'continuity_branch_test', 'branch_test', 'active', 0, 0
       )`,
    );
    await ownerPool.query(
      `INSERT INTO memory_conclusions (
         workspace_id, world_id, worldline_id, observer_continuity_id,
         observed_entity_key, id, operation, memory_kind, content,
         keywords, semantic_embedding, embedding_model, fidelity,
         occurred_tick, occurred_ordinal,
         available_from_tick, available_from_ordinal
       ) VALUES (
         'ws_demo', 'world_ember_coast', 'worldline_branch_test', 'continuity_branch_test',
         'self', 'mem_branch_test', 'add', 'explicit', '平行世界线的秘密不应泄漏',
         $1::text[], $2::vector, 'realm-lexical-v1', 1.0,
         0, 0, 0, 0
       )`,
      [
        extractMemoryKeywords("平行世界线的秘密不应泄漏"),
        `[${lexicalEmbedding("平行世界线的秘密不应泄漏").join(",")}]`,
      ],
    );
    const branchSanity = await ownerPool.query(
      `SELECT count(*)::int AS count FROM memory_conclusions WHERE id = 'mem_branch_test'`,
    );
    assert.equal(branchSanity.rows[0].count, 1);
    const branchRecall = await memory.recall({
      ...PLAYER_SCOPE,
      query: "平行世界线的秘密不应泄漏",
      limit: 10,
    });
    assert.ok(
      branchRecall.every((item) => !item.content.includes("平行世界线的秘密")),
    );

    // 长 Record 固定 Token 预算：表示输出不超预算。
    const budgeted = await memory.representation(PLAYER_SCOPE, "immersive", 24);
    assert.ok(estimateMemoryTokens(budgeted) <= 24);
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
  if (!/^realm_m3_test_[a-f0-9]+$/.test(value)) {
    throw new Error("Unsafe temporary database identifier.");
  }
  return `"${value}"`;
}
