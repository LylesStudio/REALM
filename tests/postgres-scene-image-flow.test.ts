/**
 * dispatchAndStoreSceneImage 全链测试（scratch PG 台账 + fake ComfyUI
 * client）：queue → history 轮询 → /view 下载 → world_files + ready 同事务；
 * active 复用（二次调用不新建）；history failed/超时语义；失败无可见 ready。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import {
  createPostgresRecordRuntimeScopeRepository,
  createPostgresSceneImageStore,
  seedPostgresDemo,
} from "../database/postgres/public.ts";
import { createSceneImageService } from "../modules/application/scene-image-service.ts";
import { createComfyUiSettingsStore } from "../modules/imagine/public.ts";

const adminConnectionString = process.env.DATABASE_URL;
const WS = "ws_demo";
const RECORD = "record_first_watch";
const SCOPE = { workspaceId: WS, principalId: "principal_demo_player", recordId: RECORD };

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
  "scene image dispatch+store: real PG ledger with fake provider (reuse/failure/timeout)",
  { skip: !adminConnectionString, timeout: 300_000 },
  async (t) => {
    const adminUrl = requireLoopbackUrl(adminConnectionString!);
    const databaseName = `realm_sceneimg_flow_${randomUUID().replaceAll("-", "")}`;
    const maintenanceUrl = new URL(adminUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
    await maintenance.connect();
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
    const ownerUrl = new URL(adminUrl);
    ownerUrl.pathname = `/${databaseName}`;
    const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 2 });
    const dataHome = await mkdtemp(join(tmpdir(), "realm-scene-flow-"));
    t.after(async () => {
      await ownerPool.end();
      await rm(dataHome, { recursive: true, force: true });
      await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await maintenance.end();
    });
    const migrationDir = new URL("../database/postgres/migrations/", import.meta.url);
    for (const filename of (await readdir(migrationDir)).sort()) {
      if (!filename.endsWith(".sql")) continue;
      await ownerPool.query(await readFile(new URL(filename, migrationDir), "utf8"));
    }
    await seedPostgresDemo(ownerPool);

    // 真实配置存储（tmp 文件），启用并指向 fake provider（baseUrl 不用于
    // 请求——client 工厂注入；baseUrl 只证明配置真实经 store 传递）。
    const comfyStore = createComfyUiSettingsStore({
      filePath: join(dataHome, "comfyui.json"),
    });
    await comfyStore.save({
      enabled: true,
      baseUrl: "http://192.168.1.30:8000",
      requestTimeoutMs: 30_000,
    });

    const sceneImageStore = createPostgresSceneImageStore(ownerPool);
    const scopeRepository = createPostgresRecordRuntimeScopeRepository(ownerPool);

    let queueCalls = 0;
    let historyCalls = 0;
    let viewCalls = 0;
    let historyScript: "pending-then-ready" | "failed" | "never-ready" = "pending-then-ready";
    const fakeClient = () => ({
      async systemStats() { return { latencyMs: 1 }; },
      async queuePrompt() {
        queueCalls += 1;
        return { promptId: `pid-flow-${queueCalls}` };
      },
      async history() {
        historyCalls += 1;
        if (historyScript === "pending-then-ready") {
          return historyCalls === 1
            ? { status: "pending" as const }
            : {
              status: "ready" as const,
              image: { filename: "realm_flow_00001_.png", subfolder: "", type: "output" },
            };
        }
        if (historyScript === "failed") return { status: "failed" as const };
        return { status: "pending" as const };
      },
      async viewImage() {
        // 第二次下载返回不同字节（内容寻址 fileId 才应不同）。
        viewCalls += 1;
        return {
          data: viewCalls === 1 ? TINY_PNG : Buffer.concat([TINY_PNG, Buffer.from([viewCalls])]),
          contentType: "image/png" as const,
        };
      },
    });

    // 假时钟：每次 now() 前进 500ms（配合 90s 预算 = 180 次轮询上限），
    // sleep 瞬返——超时路径快速可测，不空转真实 90 秒。
    let fakeNow = 0;
    const service = createSceneImageService({
      scopeRepository,
      comfyUiStore: comfyStore,
      createComfyUiClient: fakeClient,
      sceneImageStore,
      now: () => (fakeNow += 500),
      sleep: () => Promise.resolve(),
      pollIntervalMs: 1,
    });

    // 第一次：queue → pending → ready → 落库。
    const first = await service.dispatchAndStoreSceneImage(SCOPE);
    assert.equal(first.status, "ready");
    assert.ok(first.fileId?.startsWith("file_"));
    assert.equal(first.fileUrl, `/api/files/${first.fileId}`);
    assert.equal(queueCalls, 1);
    const ledger1 = await ownerPool.query(
      `SELECT status, file_id, prompt_id FROM scene_image_generations
       WHERE workspace_id = $1 AND record_id = $2`,
      [WS, RECORD],
    );
    assert.equal(ledger1.rows.length, 1);
    assert.equal(ledger1.rows[0]!.status, "ready");
    const fileCount = await ownerPool.query(
      `SELECT count(*)::int AS count FROM world_files
       WHERE workspace_id = $1 AND kind = 'scene_background'`,
      [WS],
    );
    assert.equal(fileCount.rows[0]!.count, 1);

    // 第二次点击：无 active（已 ready）→ 新建一次（重新生成语义），
    // 两张图都保留（latest ready 由 findLatestReady 取最新）。
    historyCalls = 0;
    const second = await service.dispatchAndStoreSceneImage(SCOPE);
    assert.equal(second.status, "ready");
    assert.equal(queueCalls, 2, "无 active 时重新生成是合法新建");
    assert.notEqual(second.fileId, first.fileId);
    const latest = await sceneImageStore.findLatestReady(SCOPE);
    assert.equal(latest?.fileId, second.fileId, "latest ready 必须是最新一张");

    // history failed → 台账 failed + 安全码，无 ready 污染。
    historyScript = "failed";
    const failed = await service.dispatchAndStoreSceneImage(SCOPE);
    assert.equal(failed.status, "failed");
    assert.equal(failed.errorCode, "GENERATION_FAILED");
    const ledger2 = await ownerPool.query(
      `SELECT status FROM scene_image_generations
       WHERE workspace_id = $1 AND record_id = $2 ORDER BY created_at`,
      [WS, RECORD],
    );
    assert.deepEqual(ledger2.rows.map((row) => row.status), ["ready", "ready", "failed"]);

    // 超时：永不就绪 → running（不 fail，prompt 保持可续）。
    historyScript = "never-ready";
    const running = await service.dispatchAndStoreSceneImage(SCOPE, { seed: 1 });
    // 上一行失败后无 active，新建 running；立即第二次调用复用同一 prompt。
    assert.equal(running.status, "running");
    const queueCallsBeforeReuse = queueCalls;
    const reused = await service.dispatchAndStoreSceneImage(SCOPE);
    assert.equal(reused.status, "running");
    assert.equal(queueCalls, queueCallsBeforeReuse, "active 复用不得新建 queue 请求");
  },
);
