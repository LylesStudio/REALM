/**
 * 场景图台账 + world_files 落库 PG 测试（scratch；--test-concurrency=1 由
 * runner 统一保证）。覆盖：kind CHECK 扩展、台账状态机、active 复用语义、
 * ready 同事务绑定、失败无可见 ready、RLS workspace 隔离、realm_runtime
 * 最小权限（SELECT/INSERT/UPDATE，无 DELETE）。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import {
  createPostgresSceneImageStore,
  seedPostgresDemo,
} from "../database/postgres/public.ts";

const adminConnectionString = process.env.DATABASE_URL;

const WS = "ws_demo";
const RECORD = "record_first_watch";

// 1x1 PNG（magic 正确的最小图）。
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

function requireLoopbackUrl(value: string): URL {
  const url = new URL(value);
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("PostgreSQL tests are restricted to a loopback host.");
  }
  return url;
}

test(
  "scene image store: ledger lifecycle + world_files binding + RLS + least privilege",
  { skip: !adminConnectionString, timeout: 300_000 },
  async (t) => {
    const adminUrl = requireLoopbackUrl(adminConnectionString!);
    const databaseName = `realm_sceneimg_store_${randomUUID().replaceAll("-", "")}`;
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
    const runtimePool = new pg.Pool({ connectionString: runtimeUrl.href, max: 2 });
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

    // demo record 的 world/scene 锚点（真实外键目标）。
    const meta = await ownerPool.query(
      `SELECT record.world_id, record.worldline_id,
              (SELECT id FROM scenes WHERE workspace_id = record.workspace_id AND record_id = record.id ORDER BY start_tick ASC LIMIT 1) AS scene_id
       FROM records AS record
       WHERE record.workspace_id = $1 AND record.id = $2`,
      [WS, RECORD],
    );
    const { world_id: worldId, scene_id: sceneId } = meta.rows[0]!;

    // 台账走 realm_runtime（最小权限验证内嵌）。
    const store = createPostgresSceneImageStore(runtimePool);
    const scope = { workspaceId: WS, recordId: RECORD };

    // kind CHECK：scene_background 允许，未知 kind 拒绝。
    await ownerPool.query(
      `INSERT INTO world_files (workspace_id, world_id, id, kind, content_type, filename, sha256, size_bytes, data)
       VALUES ($1, $2, 'file_kind_ok', 'scene_background', 'image/png', 'ok.png', 'x', 1, '\\x00')`,
      [WS, worldId],
    );
    await assert.rejects(
      ownerPool.query(
        `INSERT INTO world_files (workspace_id, world_id, id, kind, content_type, filename, sha256, size_bytes, data)
         VALUES ($1, $2, 'file_kind_bad', 'rogue_kind', 'image/png', 'bad.png', 'x', 1, '\\x00')`,
        [WS, worldId],
      ),
    );

    // 空态：无 active、无 ready。
    assert.equal(await store.findActiveGeneration(scope), null);
    assert.equal(await store.findLatestReady(scope), null);

    // 两个并发 claim 必须只调用一次 provider queue，第二个复用同一 active。
    let claimQueueCalls = 0;
    const claimInput = {
      workspaceId: WS,
      worldId,
      recordId: RECORD,
      sceneId,
      queuePrompt: async () => {
        claimQueueCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 25));
        return "pid-atomic-claim";
      },
    };
    const [claimA, claimB] = await Promise.all([
      store.claimOrCreateGeneration(claimInput),
      store.claimOrCreateGeneration(claimInput),
    ]);
    assert.equal(claimQueueCalls, 1, "并发 claim 只能 queue 一次");
    assert.equal(claimA.generation.id, claimB.generation.id);
    assert.equal(claimA.reused || claimB.reused, true);
    await store.failGeneration(
      { workspaceId: WS, id: claimA.generation.id },
      "TEST_CLAIM_CLEANUP",
    );

    // 创建（queue accepted 语义：status=running + prompt_id）。
    const generation = await store.createGeneration({
      workspaceId: WS,
      worldId,
      recordId: RECORD,
      sceneId,
      promptId: "pid-test-1",
    });
    assert.equal(generation.status, "running");
    assert.equal(generation.promptId, "pid-test-1");

    // active 复用可见（同一 Record 的 active 唯一语义由 service 保证）。
    const active = await store.findActiveGeneration(scope);
    assert.equal(active?.id, generation.id);
    assert.equal(active?.worldId, worldId);

    // 完成：world_files + 台账 ready 同一事务。
    const { fileId } = await store.completeGeneration(
      { workspaceId: WS, worldId, id: generation.id },
      { contentType: "image/png", filename: "scene_test.png", data: TINY_PNG },
    );
    assert.ok(fileId.startsWith("file_"));
    const ready = await store.findLatestReady(scope);
    assert.equal(ready?.fileId, fileId);
    const fileRow = await ownerPool.query(
      `SELECT kind, content_type, size_bytes, octet_length(data) AS bytes, sha256
       FROM world_files WHERE workspace_id = $1 AND id = $2`,
      [WS, fileId],
    );
    assert.equal(fileRow.rows[0]!.kind, "scene_background");
    assert.equal(fileRow.rows[0]!.bytes, TINY_PNG.length);

    // 失败路径：只记安全分类码，无 ready 残留污染。
    const failed = await store.createGeneration({
      workspaceId: WS,
      worldId,
      recordId: RECORD,
      sceneId,
      promptId: "pid-test-2",
    });
    await store.failGeneration(
      { workspaceId: WS, id: failed.id },
      "COMFYUI_UNREACHABLE",
    );
    const afterFail = await store.findActiveGeneration(scope);
    assert.equal(afterFail, null, "failed 不再是 active");
    // latest ready 仍是第一张（失败不覆盖）。
    assert.equal((await store.findLatestReady(scope))?.fileId, fileId);

    // realm_runtime 无 DELETE（最小权限）。
    await assert.rejects(
      runtimePool.query(
        `DELETE FROM scene_image_generations WHERE workspace_id = $1`,
        [WS],
      ),
    );

    // RLS：另一 workspace 视角看不到台账行（runtime 池 + workspace 切换）。
    await ownerPool.query(
      `INSERT INTO workspaces (id, name) VALUES ('ws_other', 'other') ON CONFLICT DO NOTHING`,
    );
    const otherStore = createPostgresSceneImageStore(runtimePool);
    assert.equal(
      await otherStore.findLatestReady({ workspaceId: "ws_other", recordId: RECORD }),
      null,
    );
  },
);
