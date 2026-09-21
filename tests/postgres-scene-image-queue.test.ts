/**
 * 场景图自动队列 + 账号模式 PG 测试（scratch；串行由 runner 保证）。
 * 覆盖：0049 列默认值/CHECK/列级 UPDATE 授权；0050 入队幂等、归档拒绝、
 * claim lease、同一 Record 串行、complete/fail/retry/recoverStale、
 * latest 查询、RLS 跨 workspace 隔离。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import {
  createPostgresAccountRepository,
  createPostgresSceneImageQueue,
  SceneImageQueueError,
  seedPostgresDemo,
} from "../database/postgres/public.ts";

const adminConnectionString = process.env.DATABASE_URL;
const WS = "ws_demo";
const RECORD = "record_first_watch";

function requireLoopbackUrl(value: string): URL {
  const url = new URL(value);
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("PostgreSQL tests are restricted to a loopback host.");
  }
  return url;
}

test(
  "scene image queue: mode column + idempotent enqueue + claim/lease/retry/stale + RLS",
  { skip: !adminConnectionString, timeout: 300_000 },
  async (t) => {
    const adminUrl = requireLoopbackUrl(adminConnectionString!);
    const databaseName = `realm_sceneq_${randomUUID().replaceAll("-", "")}`;
    const maintenanceUrl = new URL(adminUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
    await maintenance.connect();
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
    const ownerUrl = new URL(adminUrl);
    ownerUrl.pathname = `/${databaseName}`;
    const runtimeUrl = new URL(adminUrl);
    runtimeUrl.pathname = `/${databaseName}`;
    runtimeUrl.username = "realm_runtime";
    const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 2 });
    const runtimePool = new pg.Pool({ connectionString: runtimeUrl.href, max: 3 });
    t.after(async () => {
      await ownerPool.end();
      await runtimePool.end();
      await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await maintenance.end();
    });
    const migrationDir = new URL("../database/postgres/migrations/", import.meta.url);
    for (const filename of (await readdir(migrationDir)).sort()) {
      if (!filename.endsWith(".sql")) continue;
      await ownerPool.query(await readFile(new URL(filename, migrationDir), "utf8"));
    }
    await seedPostgresDemo(ownerPool);

    const meta = await ownerPool.query(
      `SELECT record.world_id,
              (SELECT id FROM scenes WHERE workspace_id = record.workspace_id AND record_id = record.id ORDER BY start_tick ASC LIMIT 1) AS scene_id
       FROM records AS record WHERE record.workspace_id = $1 AND record.id = $2`,
      [WS, RECORD],
    );
    const { world_id: worldId, scene_id: sceneId } = meta.rows[0]!;

    // ---- 0049：默认 off、CHECK 拒绝非法、列级 UPDATE（realm_runtime）----
    const accounts = createPostgresAccountRepository(runtimePool);
    assert.equal(
      await accounts.findSceneImageMode(WS, "principal_demo_player"),
      "off",
      "缺省/未设置必须 off",
    );
    // 无账号 fail-closed off。
    assert.equal(await accounts.findSceneImageMode(WS, "principal_ghost"), "off");
    // 账号行由登录创建（findOrCreate 先例）；测试显式补行后再写模式。
    await ownerPool.query(
      `INSERT INTO accounts (workspace_id, principal_id, display_name)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [WS, "principal_demo_player", "演示玩家"],
    );
    await accounts.saveSceneImageMode(WS, "principal_demo_player", "every_turn");
    assert.equal(
      await accounts.findSceneImageMode(WS, "principal_demo_player"),
      "every_turn",
    );
    await assert.rejects(
      (async () => {
        const client = await runtimePool.connect();
        try {
          await client.query("BEGIN");
          await client.query(
            `SELECT set_config('realm.workspace_id', $1, true)`,
            [WS],
          );
          await client.query(
            `UPDATE accounts SET scene_image_mode = 'always' WHERE workspace_id = $1`,
            [WS],
          );
        } finally {
          await client.query("ROLLBACK").catch(() => undefined);
          client.release();
        }
      })(),
      /check/i,
    );
    // 无账号 fail-closed off。

    // ---- 0050：入队幂等 ----
    const queue = createPostgresSceneImageQueue(runtimePool);
    const base = {
      workspaceId: WS,
      worldId,
      recordId: RECORD,
      sceneId,
      principalId: "principal_demo_player",
    };
    const first = await queue.enqueue({
      ...base,
      triggerKind: "every_turn",
      sourceEventId: "turn-idem-1",
    });
    assert.equal(first.enqueued, true);
    const dup = await queue.enqueue({
      ...base,
      triggerKind: "every_turn",
      sourceEventId: "turn-idem-1",
    });
    assert.equal(dup.enqueued, false, "同 source_event_id 重复入队必须幂等");
    assert.equal(dup.request.id, first.request.id);
    const otherTrigger = await queue.enqueue({
      ...base,
      triggerKind: "scene_change",
      sourceEventId: "turn-idem-1",
    });
    assert.equal(otherTrigger.enqueued, true, "不同 trigger_kind 是不同意图");

    // 归档拒绝：archived 记录不得入队。
    await ownerPool.query(
      `UPDATE records SET status = 'archived' WHERE workspace_id = $1 AND id = $2`,
      [WS, RECORD],
    );
    await assert.rejects(
      queue.enqueue({ ...base, triggerKind: "every_turn", sourceEventId: "turn-archived" }),
      (error: unknown) => {
        assert.ok(error instanceof SceneImageQueueError);
        assert.equal(error.code, "ARCHIVED_SCOPE");
        return true;
      },
    );
    await ownerPool.query(
      `UPDATE records SET status = 'active' WHERE workspace_id = $1 AND id = $2`,
      [WS, RECORD],
    );

    // ---- claim 顺序：同一 Record 按创建序串行 ----
    const claim1 = await queue.claim({ workspaceId: WS }, { leaseMs: 60_000 });
    assert.ok(claim1);
    assert.equal(claim1!.status, "leased");
    // 同 Record 还有更早/并列行时，下一 claim 不得越过（first 在前）。
    const claim2 = await queue.claim({ workspaceId: WS }, { leaseMs: 60_000 });
    assert.equal(claim2, null, "同 Record 有 leased 行时不得并发领取");

    // complete 绑定 generation（需要真实 0048 行——先造一条 ready 生成）。
    await ownerPool.query(
      `INSERT INTO scene_image_generations
         (workspace_id, id, world_id, record_id, scene_id, status, prompt_id)
       VALUES ($1, 'sceneimg_test_ready', $2, $3, $4, 'running', 'pid-x')`,
      [WS, worldId, RECORD, sceneId],
    );
    await queue.complete(
      { workspaceId: WS, id: claim1!.id },
      "sceneimg_test_ready",
    );
    // complete 按 id 直查（findLatestForRecord 取 created_at 最新行，语义在
    // 失败路径末端验证）。
    const completedRow = await ownerPool.query(
      `SELECT status, generation_id FROM scene_image_requests
       WHERE workspace_id = $1 AND id = $2`,
      [WS, claim1!.id],
    );
    assert.equal(completedRow.rows[0]!.status, "completed");
    assert.equal(completedRow.rows[0]!.generation_id, "sceneimg_test_ready");

    // claim 第二条 → 临时失败 retry（attempts+1，回 queued）→ 再 claim → fail。
    const claim3 = await queue.claim({ workspaceId: WS }, { leaseMs: 60_000 });
    assert.ok(claim3);
    assert.equal(claim3!.id, otherTrigger.request.id);
    await queue.retry({ workspaceId: WS, id: claim3!.id });
    const claim4 = await queue.claim({ workspaceId: WS }, { leaseMs: 1 });
    assert.equal(claim4!.attempts, 1, "retry 后 attempts 递增");
    // lease 1ms 立即过期 → stale 恢复回 queued。
    await new Promise((resolve) => setTimeout(resolve, 20));
    const recovered = await queue.recoverStale({ workspaceId: WS });
    assert.equal(recovered, 1);
    const claim5 = await queue.claim({ workspaceId: WS }, { leaseMs: 60_000 });
    assert.ok(claim5);
    await queue.fail({ workspaceId: WS, id: claim5!.id }, "COMFYUI_UNREACHABLE");
    const failedRow = await queue.findLatestForRecord({ workspaceId: WS, recordId: RECORD });
    assert.equal(failedRow?.status, "failed");

    // RLS：另一 workspace 不可见。
    await ownerPool.query(
      `INSERT INTO workspaces (id, name) VALUES ('ws_other_q', 'other') ON CONFLICT DO NOTHING`,
    );
    assert.equal(
      await queue.findLatestForRecord({ workspaceId: "ws_other_q", recordId: RECORD }),
      null,
    );
    // realm_runtime 无 DELETE。
    await assert.rejects(
      runtimePool.query(`DELETE FROM scene_image_requests WHERE workspace_id = $1`, [WS]),
    );
  },
);
