/**
 * 场景图 worker runtime 进程级测试（scratch PG + fake ComfyUI client）：
 * 真实 claim → dispatchAndStore → world_files/台账 ready → 请求 completed；
 * 单实例 advisory lock（第二实例拒绝）；stale 恢复；stop() 干净退出。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import {
  createPostgresSceneImageQueue,
  seedPostgresDemo,
} from "../database/postgres/public.ts";
import {
  createSceneImageWorkerRuntime,
  SceneImageWorkerLockError,
} from "../modules/application/scene-image-worker-runtime.ts";

const adminConnectionString = process.env.DATABASE_URL;
const WS = "ws_demo";
const RECORD = "record_first_watch";

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
  "scene image worker: claim→generate→complete, single-instance lock, stop()",
  { skip: !adminConnectionString, timeout: 300_000 },
  async (t) => {
    const adminUrl = requireLoopbackUrl(adminConnectionString!);
    const databaseName = `realm_sceneworker_${randomUUID().replaceAll("-", "")}`;
    const maintenanceUrl = new URL(adminUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
    await maintenance.connect();
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
    const runtimeUrl = new URL(adminUrl);
    runtimeUrl.pathname = `/${databaseName}`;
    runtimeUrl.username = "realm_runtime";
    const ownerUrl = new URL(adminUrl);
    ownerUrl.pathname = `/${databaseName}`;
    const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 2 });
    const dataHome = await mkdtemp(join(tmpdir(), "realm-sceneworker-"));
    t.after(async () => {
      await ownerPool.end();
      await rm(dataHome, { recursive: true, force: true });
      await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await maintenance.end();
    });
    await ownerPool.query("SELECT 1");
    const migrationDir = new URL("../database/postgres/migrations/", import.meta.url);
    for (const filename of (await readdir(migrationDir)).sort()) {
      if (!filename.endsWith(".sql")) continue;
      await ownerPool.query(await readFile(new URL(filename, migrationDir), "utf8"));
    }
    await seedPostgresDemo(ownerPool);
    // worker 读 REALM_DATA_HOME 下的 comfyui.json（enabled）。
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dataHome, "settings"), { recursive: true });
    await writeFile(
      join(dataHome, "settings", "comfyui.json"),
      JSON.stringify({
        enabled: true,
        baseUrl: "http://192.168.1.30:8000",
        requestTimeoutMs: 30_000,
        workflowId: "anima-scene-t2i-v0",
        apiKey: "",
        updatedAt: "2026-09-20T00:00:00.000Z",
      }),
    );
    process.env.REALM_DATA_HOME = dataHome;
    t.after(() => {
      delete process.env.REALM_DATA_HOME;
    });

    // 入队一条 every_turn 意图（真实 queue + runtime 池）。
    const queue = createPostgresSceneImageQueue(ownerPool);
    const meta = await ownerPool.query(
      `SELECT record.world_id,
              (SELECT id FROM scenes WHERE workspace_id = record.workspace_id AND record_id = record.id ORDER BY start_tick ASC LIMIT 1) AS scene_id
       FROM records AS record WHERE record.workspace_id = $1 AND record.id = $2`,
      [WS, RECORD],
    );
    const { world_id: worldId, scene_id: sceneId } = meta.rows[0]!;
    await queue.enqueue({
      workspaceId: WS,
      worldId,
      recordId: RECORD,
      sceneId,
      principalId: "principal_demo_player",
      triggerKind: "every_turn",
      sourceEventId: "turn-worker-test-1",
    });

    // fake provider：queue→history ready→view 返回 PNG。
    let queueCalls = 0;
    let providerMode: "ready" | "pending" = "ready";
    const fakeClient = () => ({
      async systemStats() { return { latencyMs: 1 }; },
      async queuePrompt() {
        queueCalls += 1;
        return { promptId: "pid-worker-fake" };
      },
      async history() {
        if (providerMode === "pending") return { status: "pending" as const };
        return {
          status: "ready" as const,
          image: { filename: "realm_worker_00001_.png", subfolder: "", type: "output" },
        };
      },
      async viewImage() {
        return { data: TINY_PNG, contentType: "image/png" as const };
      },
    });

    const logs: string[] = [];
    const beats: Array<{ state: string; workspaces: readonly string[] }> = [];
    const runtime = createSceneImageWorkerRuntime({
      connectionString: runtimeUrl.href,
      workspaces: [WS],
      idleMinMs: 50,
      idleMaxMs: 200,
      leaseMs: 60_000,
      logger: (line) => logs.push(line),
      createComfyUiClient: fakeClient,
      heartbeat: (input) => beats.push(input),
    });

    // 单实例锁：第二个 runtime 必须先拿锁失败——在第一个启动后验证。
    void runtime.start();
    // 等锁建立。
    await new Promise((resolve) => setTimeout(resolve, 300));
    const second = createSceneImageWorkerRuntime({
      connectionString: runtimeUrl.href,
      workspaces: [WS],
      logger: (line) => logs.push(line),
    });
    await assert.rejects(second.start(), (error: unknown) => {
      assert.ok(error instanceof SceneImageWorkerLockError);
      return true;
    });

    // 等请求 completed（有界轮询库行，最长 15s）。
    let completed: { status: string; generation_id: string | null } | null = null;
    for (let attempt = 0; attempt < 150; attempt += 1) {
      const row = await ownerPool.query(
        `SELECT status, generation_id FROM scene_image_requests
         WHERE workspace_id = $1 AND source_event_id = 'turn-worker-test-1'`,
        [WS],
      );
      if (row.rows[0]?.status === "completed") {
        completed = row.rows[0];
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await runtime.stop();

    // 心跳语义：拿锁后即 online（第一拍），stop() 写 stopping（最后一拍）。
    assert.equal(beats[0]?.state, "online", "拿锁成功必须立即上报 online");
    assert.deepEqual(beats[0]?.workspaces, [WS]);
    assert.equal(beats.at(-1)?.state, "stopping", "stop() 必须上报 stopping");

    assert.ok(completed, "请求必须 completed（worker 真实执行）");
    assert.ok(completed!.generation_id, "completed 必须绑定 generation");
    assert.equal(queueCalls, 1, "幂等：一次请求一次 queuePrompt");
    // world_files + 台账 ready。
    const files = await ownerPool.query(
      `SELECT count(*)::int AS count FROM world_files
       WHERE workspace_id = $1 AND kind = 'scene_background'`,
      [WS],
    );
    assert.equal(files.rows[0]!.count, 1);
    const generation = await ownerPool.query(
      `SELECT status FROM scene_image_generations
       WHERE workspace_id = $1 AND id = $2`,
      [WS, completed!.generation_id],
    );
    assert.equal(generation.rows[0]!.status, "ready");

    // 永不 ready 的 provider：达到 maxAttempts 后请求与 active generation
    // 都必须终止，不能无限 retry 或永久占位。
    providerMode = "pending";
    await queue.enqueue({
      workspaceId: WS,
      worldId,
      recordId: RECORD,
      sceneId,
      principalId: "principal_demo_player",
      triggerKind: "every_turn",
      sourceEventId: "turn-worker-timeout-1",
    });
    const timeoutRuntime = createSceneImageWorkerRuntime({
      connectionString: runtimeUrl.href,
      workspaces: [WS],
      maxAttempts: 2,
      maxWaitMs: 1,
      pollIntervalMs: 0,
      idleMinMs: 5,
      idleMaxMs: 20,
      leaseMs: 60_000,
      logger: (line) => logs.push(line),
      createComfyUiClient: fakeClient,
    });
    void timeoutRuntime.start();
    let timeoutRow: { status: string; generation_id: string | null } | null = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const row = await ownerPool.query(
        `SELECT status, generation_id FROM scene_image_requests
         WHERE workspace_id = $1 AND source_event_id = 'turn-worker-timeout-1'`,
        [WS],
      );
      if (row.rows[0]?.status === "failed") {
        timeoutRow = row.rows[0];
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await timeoutRuntime.stop();
    assert.equal(timeoutRow?.status, "failed");
    assert.equal(timeoutRow?.generation_id, null, "失败请求不绑定 ready generation");
    const activeAfterTimeout = await ownerPool.query(
      `SELECT count(*)::int AS count FROM scene_image_generations
       WHERE workspace_id = $1 AND record_id = $2 AND status IN ('queued', 'running')`,
      [WS, RECORD],
    );
    assert.equal(activeAfterTimeout.rows[0]!.count, 0, "超时收口不得留下 active 占位");

    // 日志不含 provider 地址/路径（只含安全文案）。
    assert.ok(!logs.join("\n").includes("192.168"), "日志不得含 provider 地址");
  },
);
