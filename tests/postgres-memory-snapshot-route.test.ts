/**
 * 批次 T10-B4——/api/memory/snapshot 与 /api/memory/delta 生产入口
 * （docs/development/T10-B4-MEMORY-D1-RETIREMENT.md §五）。
 * 真实临时 PG 库（t.after 拆库，受限 realm_runtime 池走路由）：
 * snapshot 404/400/伪造字段不生效/合法创建全字段；delta 初次为空、新增后
 * 出现增量、update/retract 后 epoch 递进旧 delta stale、伪造 snapshot 404；
 * memory_snapshots UPDATE/DELETE 被触发器拒绝；零开发库污染。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import {
  POST as snapshotPOST,
} from "../app/api/memory/snapshot/route.ts";
import {
  GET as deltaGET,
} from "../app/api/memory/delta/route.ts";
import {
  POSTGRES_DEMO_IDS,
  createPostgresCharacterMemoryRepository,
  seedPostgresDemo,
} from "../database/postgres/public.ts";
import { endSharedRuntimePools } from "../app/api/world-scope.ts";
import { lexicalEmbedding } from "../modules/memory/public.ts";
import { createSessionValue } from "../modules/identity/auth.ts";

// 新门禁（0051）：runtime DB 存在即要求账户会话；路由请求统一携带。
const sessionCookie = `realm_session=${createSessionValue("principal_demo_player")}`;

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

test(
  "T10-B4: snapshot/delta routes generate server-side scopes and honor epoch staleness",
  { skip: !adminConnectionString || !runtimeConnectionString },
  async (t) => {
    const adminUrl = requireLoopbackUrl(adminConnectionString!);
    const databaseName = `realm_t10b4_${randomUUID().replaceAll("-", "")}`;
    const maintenanceUrl = new URL(adminUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
    await maintenance.connect();
    await maintenance.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);

    const ownerUrl = new URL(adminUrl);
    ownerUrl.pathname = `/${databaseName}`;
    const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 2 });
    const runtimeUrl = new URL(requireLoopbackUrl(runtimeConnectionString!).href);
    runtimeUrl.pathname = `/${databaseName}`;

    const previousRuntimeUrl = process.env.REALM_RUNTIME_DATABASE_URL;
    const previousAccessToken = process.env.REALM_ACCESS_TOKEN;
    process.env.REALM_RUNTIME_DATABASE_URL = runtimeUrl.href;
    delete process.env.REALM_ACCESS_TOKEN;

    t.after(async () => {
      await endSharedRuntimePools();
      if (previousAccessToken === undefined) {
        delete process.env.REALM_ACCESS_TOKEN;
      } else {
        process.env.REALM_ACCESS_TOKEN = previousAccessToken;
      }
      if (previousRuntimeUrl === undefined) {
        delete process.env.REALM_RUNTIME_DATABASE_URL;
      } else {
        process.env.REALM_RUNTIME_DATABASE_URL = previousRuntimeUrl;
      }
      await ownerPool.end();
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

    const recordScope = {
      workspaceId: POSTGRES_DEMO_IDS.workspace,
      worldId: POSTGRES_DEMO_IDS.world,
      worldlineId: POSTGRES_DEMO_IDS.worldline,
      recordId: POSTGRES_DEMO_IDS.record,
      characterInstanceId: POSTGRES_DEMO_IDS.playerInstance,
    };
    const repository = createPostgresCharacterMemoryRepository(ownerPool);
    // sync_turn：把 demo 记录的 observations 物化为记忆结论（快照素材）。
    await repository.extractAuthorized(recordScope);

    // F3：kind 越界 → 400。
    const badKind = await snapshotPOST(
      new Request("http://localhost/api/memory/snapshot", {
        method: "POST",
        headers: { cookie: sessionCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ recordId: recordScope.recordId, kind: "bogus" }),
      }),
    );
    assert.equal(badKind.status, 400);

    // F2：未知记录 → 404。
    const missing = await snapshotPOST(
      new Request("http://localhost/api/memory/snapshot", {
        method: "POST",
        headers: { cookie: sessionCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ recordId: "record_nope" }),
      }),
    );
    assert.equal(missing.status, 404);

    // F4：客户端伪造 content/itemIds/cursor/epoch 一律忽略（服务端生成）。
    const created = await snapshotPOST(
      new Request("http://localhost/api/memory/snapshot", {
        method: "POST",
        headers: { cookie: sessionCookie, "Content-Type": "application/json" },
        body: JSON.stringify({
          recordId: recordScope.recordId,
          kind: "representation",
          content: "伪造内容",
          itemIds: ["forged_item"],
          cursor: { tick: 999, ordinal: 999 },
          cacheEpoch: 999,
        }),
      }),
    );
    assert.equal(created.status, 201);
    const snapshot = ((await created.json()) as {
      snapshot: {
        id: string;
        snapshotKind: string;
        content: string;
        itemIds: string[];
        cacheEpoch: number;
        tokenCount: number;
      };
    }).snapshot;
    assert.equal(snapshot.snapshotKind, "representation");
    assert.ok(snapshot.id.startsWith("snap_"));
    assert.notEqual(snapshot.content, "伪造内容");
    assert.ok(!snapshot.itemIds.includes("forged_item"));
    assert.notEqual(snapshot.cacheEpoch, 999);
    assert.ok(snapshot.tokenCount >= 0);
    const stored = await ownerPool.query(
      `SELECT content, item_ids FROM memory_snapshots WHERE id = $1`,
      [snapshot.id],
    );
    assert.equal(stored.rows.length, 1);
    assert.notEqual(stored.rows[0].content, "伪造内容");

    // delta 初次：epoch 一致，无快照后新增 → 空增量。
    const first = await deltaGET(
      new Request(
        `http://localhost/api/memory/delta?recordId=${recordScope.recordId}&snapshotId=${snapshot.id}`,
        { headers: { cookie: sessionCookie } },
      ),
    );
    assert.equal(first.status, 200);
    const firstDelta = ((await first.json()) as {
      delta: { stale: boolean; cacheEpoch: number; items: unknown[] };
    }).delta;
    assert.equal(firstDelta.stale, false);
    assert.equal(firstDelta.items.length, 0);

    // 快照后 add（世界游标先推进——新增结论须晚于快照游标才计入增量）。
    await ownerPool.query(
      `UPDATE worldlines
       SET head_tick = head_tick + 1, head_ordinal = head_ordinal + 1
       WHERE workspace_id = $1 AND id = $2`,
      [recordScope.workspaceId, recordScope.worldlineId],
    );
    await repository.appendAuthorized({
      ...recordScope,
      observedEntityKey: "entity_test_marker",
      content: "快照后新增的一条测试记忆。",
      memoryKind: "explicit",
      fidelity: 1,
      keywords: ["测试", "标记"],
      embedding: lexicalEmbedding("快照后新增的一条测试记忆。"),
      embeddingModel: "realm-lexical-v1",
    });
    const afterAdd = await deltaGET(
      new Request(
        `http://localhost/api/memory/delta?recordId=${recordScope.recordId}&snapshotId=${snapshot.id}`,
        { headers: { cookie: sessionCookie } },
      ),
    );
    const addDelta = ((await afterAdd.json()) as {
      delta: { stale: boolean; items: { id: string; content: string }[] };
    }).delta;
    assert.equal(addDelta.stale, false);
    assert.ok(
      addDelta.items.some((item) => item.content.includes("快照后新增")),
      "delta must surface conclusions added after the snapshot",
    );

    // update/retract 递进 epoch：旧快照 delta 变 stale（M3 §2.3 契约）。
    await repository.appendAuthorized({
      ...recordScope,
      observedEntityKey: "entity_test_marker",
      content: "修订：测试记忆改写。",
      memoryKind: "explicit",
      fidelity: 1,
      keywords: ["测试", "标记"],
      embedding: lexicalEmbedding("修订：测试记忆改写。"),
      embeddingModel: "realm-lexical-v1",
      operation: "update",
      supersedesMemoryId: addDelta.items.find((item) =>
        item.content.includes("快照后新增")
      )!.id,
    });
    const stale = await deltaGET(
      new Request(
        `http://localhost/api/memory/delta?recordId=${recordScope.recordId}&snapshotId=${snapshot.id}`,
        { headers: { cookie: sessionCookie } },
      ),
    );
    const staleDelta = ((await stale.json()) as {
      delta: { stale: boolean; cacheEpoch: number };
    }).delta;
    assert.equal(staleDelta.stale, true, "epoch 递进后旧 delta 必须 stale");
    assert.ok(staleDelta.cacheEpoch > firstDelta.cacheEpoch);

    // 伪造/缺失 snapshotId → 400/404。
    const noId = await deltaGET(
      new Request(
        `http://localhost/api/memory/delta?recordId=${recordScope.recordId}`,
        { headers: { cookie: sessionCookie } },
      ),
    );
    assert.equal(noId.status, 400);
    const forged = await deltaGET(
      new Request(
        `http://localhost/api/memory/delta?recordId=${recordScope.recordId}&snapshotId=snap_forged`,
        { headers: { cookie: sessionCookie } },
      ),
    );
    assert.equal(forged.status, 404);

    // 不可变：snapshot 表 UPDATE/DELETE 被触发器拒绝（F6）。
    await assert.rejects(
      ownerPool.query(
        `UPDATE memory_snapshots SET content = 'x' WHERE id = $1`,
        [snapshot.id],
      ),
    );
    await assert.rejects(
      ownerPool.query(
        `DELETE FROM memory_snapshots WHERE id = $1`,
        [snapshot.id],
      ),
    );
  },
);
