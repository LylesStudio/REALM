/**
 * M8 回归：scene image worker 的 lease fencing 必须贯穿 worker → service →
 * store 生产路径。authority 规则（本文件与实现共同钉住）：过期本身不撤销
 * authority；只有 lease 被恢复后由新 worker 再 claim（lease_revision 前进）
 * 或终态才使旧 worker 失去写入权。判定用原子 DB 谓词
 * （scene_image_requests.status='leased' AND lease_revision=当前值）。
 *
 * 覆盖三个真实切面：
 * 1. 接管后调用：旧 worker A（rev1）在恢复/B（rev2）接管后的迟到
 *    成功/失败/再 claim/retry 都被拒绝或 CAS 落空，零持久/可见副作用。
 * 2. 在途调用（确定性 barrier，不靠竞态 sleep）：A 已创建 generation 并
 *    阻塞在 provider history 轮询时推进到 B（rev2），再释放 A 的 provider
 *    响应——迟到的 ready/failed 到达 store 时一律 SceneImageFenceError。
 * 3. 恢复契约（crash-after-commit）：提交已提交但 worker 未收到确认时，
 *    同一 request+revision+generation 的重放是无副作用幂等读回（返回同一
 *    fileId、零写入）；不同 generation、旧 revision、非 terminal 误放一律
 *    fail-closed（SceneImageFenceError）。
 *
 * generation 状态迁移 + world_files 写入 + request 终态迁移同一事务原子
 * 提交（注入失败回滚零残留）。provider 调用在 DB 事务外（history/view
 * 轮询如此）；DB fencing 无法撤销已发出的 provider 调用（明示限制，
 * 不宣称取消/幂等）。lease 过期用 SQL 回拨 lease_expires_at 实现，无 sleep。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import pg from "pg";
import {
  LOCAL_RECORD_SCOPE,
} from "../modules/application/local-record-service.ts";
import {
  createPostgresRecordRuntimeScopeRepository,
  createPostgresSceneImageQueue,
  createPostgresSceneImageStore,
  seedPostgresDemo,
  type SceneImageQueue,
  type SceneImageStore,
} from "../database/postgres/public.ts";
import { SceneImageFenceError } from "../database/postgres/scene-image-store.ts";
import { createComfyUiSettingsStore } from "../modules/imagine/public.ts";
import { createSceneImageService } from "../modules/application/scene-image-service.ts";

const adminConnectionString = process.env.DATABASE_URL;
const runtimeConnectionString = process.env.REALM_RUNTIME_DATABASE_URL;
const WS = LOCAL_RECORD_SCOPE.workspaceId;
const RECORD = LOCAL_RECORD_SCOPE.recordId;

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

function requireLoopbackUrl(value: string): URL {
  const url = new URL(value);
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("M8 tests require a loopback PostgreSQL host.");
  }
  return url;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/**
 * 确定性 barrier fake client：history() 首次进入即发出 entered 信号，随后
 * 阻塞直到测试 release(outcome)。不依赖 sleep 竞态——A 一定是在 provider
 * 轮询中被 B 接管后才拿到迟到响应。
 */
function makeBarrierClient() {
  let signalEntered!: () => void;
  let releaseGate!: (outcome: "ready" | "failed") => void;
  const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
  const gate = new Promise<"ready" | "failed">((resolve) => { releaseGate = resolve; });
  const factory = () => ({
    async systemStats() { return { latencyMs: 1 }; },
    async queuePrompt() { return { promptId: `pid_${randomUUID().slice(0, 8)}` }; },
    async history() {
      signalEntered();
      const outcome = await gate;
      if (outcome === "failed") return { status: "failed" as const };
      return {
        status: "ready" as const,
        image: { filename: "realm_m8_barrier_.png", subfolder: "", type: "output" },
      };
    },
    async viewImage() {
      return { data: TINY_PNG, contentType: "image/png" as const };
    },
  });
  return { factory, entered, release: releaseGate };
}

interface Fixture {
  ownerPool: pg.Pool;
  queue: SceneImageQueue;
  store: SceneImageStore;
  worldId: string;
  sceneId: string;
  createService: (clientFactory: () => unknown) => ReturnType<typeof createSceneImageService>;
  /** 确定性 lease 过期：直接回拨 lease_expires_at（不用 sleep 等墙钟）。 */
  expireLease: (requestId: string) => Promise<void>;
  countSceneFiles: () => Promise<number>;
}

async function withFixture(
  t: test.TestContext,
  run: (fx: Fixture) => Promise<void>,
): Promise<void> {
  const adminUrl = requireLoopbackUrl(adminConnectionString!);
  const databaseName = `realm_m8fence_${randomUUID().replaceAll("-", "")}`;
  const maintenanceUrl = new URL(adminUrl);
  maintenanceUrl.pathname = "/postgres";
  const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
  maintenance.on("error", () => {});
  await maintenance.connect();
  await maintenance.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
  const ownerUrl = new URL(adminUrl);
  ownerUrl.pathname = `/${databaseName}`;
  const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 2 });
  ownerPool.on("error", () => {});
  const runtimeUrl = new URL(requireLoopbackUrl(runtimeConnectionString!).href);
  runtimeUrl.pathname = `/${databaseName}`;
  const pool = new pg.Pool({ connectionString: runtimeUrl.href, max: 4 });
  pool.on("error", () => {});
  const dataHome = await mkdtemp(join(tmpdir(), "realm-m8fence-"));
  await mkdir(join(dataHome, "settings"), { recursive: true });
  await writeFile(
    join(dataHome, "settings", "comfyui.json"),
    JSON.stringify({
      enabled: true,
      baseUrl: "http://127.0.0.1:9",
      requestTimeoutMs: 5_000,
      workflowId: "anima-scene-t2i-v0",
      apiKey: "",
      updatedAt: "2026-09-30T00:00:00.000Z",
    }),
  );
  const previousDataHome = process.env.REALM_DATA_HOME;
  process.env.REALM_DATA_HOME = dataHome;
  t.after(async () => {
    if (previousDataHome === undefined) delete process.env.REALM_DATA_HOME;
    else process.env.REALM_DATA_HOME = previousDataHome;
    await rm(dataHome, { recursive: true, force: true });
    await pool.end();
    await ownerPool.end();
    await maintenance.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await maintenance.end();
  });

  const { readdir, readFile } = await import("node:fs/promises");
  const migrationDir = new URL("../database/postgres/migrations/", import.meta.url);
  for (const filename of (await readdir(migrationDir)).sort()) {
    if (!filename.endsWith(".sql")) continue;
    await ownerPool.query(await readFile(new URL(filename, migrationDir), "utf8"));
  }
  await seedPostgresDemo(ownerPool);

  const queue = createPostgresSceneImageQueue(pool);
  const store = createPostgresSceneImageStore(pool);
  const meta = await ownerPool.query(
    `SELECT record.world_id,
            (SELECT id FROM scenes WHERE workspace_id = record.workspace_id AND record_id = record.id ORDER BY start_tick ASC LIMIT 1) AS scene_id
     FROM records AS record WHERE record.workspace_id = $1 AND record.id = $2`,
    [WS, RECORD],
  );
  const { world_id: worldId, scene_id: sceneId } = meta.rows[0]!;

  await run({
    ownerPool,
    queue,
    store,
    worldId,
    sceneId,
    createService: (clientFactory) => createSceneImageService({
      scopeRepository: createPostgresRecordRuntimeScopeRepository(pool),
      comfyUiStore: createComfyUiSettingsStore(),
      sceneImageStore: store,
      sceneImageQueue: queue,
      createComfyUiClient: clientFactory as never,
      pollIntervalMs: 5,
      maxWaitMs: 30_000,
    }),
    expireLease: async (requestId) => {
      await ownerPool.query(
        `UPDATE scene_image_requests
         SET lease_expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second'
         WHERE workspace_id = $1 AND id = $2`,
        [WS, requestId],
      );
    },
    countSceneFiles: async () => Number((await ownerPool.query(
      `SELECT count(*)::int AS count FROM world_files
       WHERE workspace_id = $1 AND kind = 'scene_background'`,
      [WS],
    )).rows[0]!.count),
  });
}

test(
  "M8: post-takeover stale settle/claim/retry are rejected; current holder settles atomically; replay is an idempotent readback",
  { skip: !adminConnectionString || !runtimeConnectionString, timeout: 300_000 },
  async (t) => {
    await withFixture(t, async (fx) => {
      const { ownerPool, queue, store, worldId, sceneId } = fx;

      // 请求入队 → A（rev1）claim → A 开始生成（创建 running generation）。
      await queue.enqueue({
        workspaceId: WS,
        worldId,
        recordId: RECORD,
        sceneId,
        principalId: LOCAL_RECORD_SCOPE.principalId,
        triggerKind: "every_turn",
        sourceEventId: "m8-fence-1",
      });
      const claimA = await queue.claim({ workspaceId: WS }, { leaseMs: 60_000 });
      assert.ok(claimA);
      assert.equal(claimA!.leaseRevision, 1);
      const fenceA = { requestId: claimA!.id, leaseRevision: claimA!.leaseRevision };
      const started = await store.claimOrCreateGeneration(
        {
          workspaceId: WS,
          worldId,
          recordId: RECORD,
          sceneId,
          queuePrompt: async () => "pid_m8_a",
        },
        { fence: fenceA },
      );
      assert.equal(started.reused, false, "A 在 authority 内的首次 claim 必须成功");
      const generationId = started.generation.id;

      // lease 过期（SQL 回拨，无 sleep）→ 恢复 → B（rev2）接管。
      await fx.expireLease(claimA!.id);
      assert.equal(await queue.recoverStale({ workspaceId: WS }), 1);
      const claimB = await queue.claim({ workspaceId: WS }, { leaseMs: 60_000 });
      assert.ok(claimB);
      assert.equal(claimB!.leaseRevision, 2);
      const fenceB = { requestId: claimB!.id, leaseRevision: claimB!.leaseRevision };
      const attemptsAfterClaimB = (await ownerPool.query(
        `SELECT attempts FROM scene_image_requests WHERE workspace_id = $1 AND id = $2`,
        [WS, claimA!.id],
      )).rows[0]!.attempts;

      // A 的迟到成功（store 完成路径）：拒绝且零副作用。
      await assert.rejects(
        () => store.completeGenerationAndSettle(
          { workspaceId: WS, worldId, id: generationId },
          { contentType: "image/png", filename: "m8_stale.png", data: TINY_PNG },
          fenceA,
        ),
        SceneImageFenceError,
        "stale worker 的迟到完成必须被拒绝",
      );
      // A 的迟到失败（worker 永久失败路径）不得翻转 generation。
      await assert.rejects(
        () => store.failGenerationAndSettle(
          { workspaceId: WS, id: generationId },
          "GENERATION_FAILED",
          fenceA,
        ),
        SceneImageFenceError,
        "stale worker 的迟到失败必须被拒绝",
      );
      // A 的迟到再 claim（worker 重进 dispatch 路径）同样拒绝。
      await assert.rejects(
        () => store.claimOrCreateGeneration(
          {
            workspaceId: WS,
            worldId,
            recordId: RECORD,
            sceneId,
            queuePrompt: async () => "pid_m8_stale",
          },
          { fence: fenceA },
        ),
        SceneImageFenceError,
        "stale worker 的迟到 claim 必须被拒绝",
      );
      // A 的迟到 retry（worker 临时失败/超时回队列路径）：CAS 谓词落空，
      // 请求行保持 leased/rev2 且 attempts 不变。
      await queue.retry({ workspaceId: WS, id: claimA!.id, leaseRevision: fenceA.leaseRevision });
      const afterStaleRetry = await ownerPool.query(
        `SELECT status, lease_revision, attempts FROM scene_image_requests
         WHERE workspace_id = $1 AND id = $2`,
        [WS, claimA!.id],
      );
      assert.equal(afterStaleRetry.rows[0]?.status, "leased", "stale retry 不得改写状态");
      assert.equal(Number(afterStaleRetry.rows[0]?.lease_revision), 2);
      assert.equal(afterStaleRetry.rows[0]?.attempts, attemptsAfterClaimB, "stale retry 不得递增 attempts");

      // 读回：generation 仍 running（B 持有），零 world_files 行，request 仍
      // leased/rev2，latest-ready 无可见产出。
      const generationAfterStale = await ownerPool.query(
        `SELECT status, file_id FROM scene_image_generations WHERE workspace_id = $1 AND id = $2`,
        [WS, generationId],
      );
      assert.equal(generationAfterStale.rows[0]?.status, "running", "stale 写入不得改变 generation 状态");
      assert.equal(generationAfterStale.rows[0]?.file_id, null, "stale 写入不得绑定文件");
      assert.equal(await fx.countSceneFiles(), 0, "stale 写入不得产生 world_files 行");
      const requestRow = await ownerPool.query(
        `SELECT status, lease_revision, generation_id FROM scene_image_requests
         WHERE workspace_id = $1 AND id = $2`,
        [WS, claimA!.id],
      );
      assert.equal(requestRow.rows[0]?.status, "leased");
      assert.equal(Number(requestRow.rows[0]?.lease_revision), 2);
      assert.equal(requestRow.rows[0]?.generation_id, null);
      assert.equal(
        (await store.findLatestReady({ workspaceId: WS, recordId: RECORD })),
        null,
        "latest-ready 投影不得显示 stale 产出",
      );

      // 原子性注入：B 用错误 generation id 完成 → 回滚（文件/generation/request
      // 全部不变）。
      await assert.rejects(
        () => store.completeGenerationAndSettle(
          { workspaceId: WS, worldId, id: `sceneimg_missing_${randomUUID().slice(0, 6)}` },
          { contentType: "image/png", filename: "m8_atomic.png", data: TINY_PNG },
          fenceB,
        ),
        /no longer active/,
        "错误 generation 的完成必须失败",
      );
      assert.equal(await fx.countSceneFiles(), 0, "回滚不得留下 world_files 行");
      assert.equal(
        (await ownerPool.query(
          `SELECT status FROM scene_image_generations WHERE workspace_id = $1 AND id = $2`,
          [WS, generationId],
        )).rows[0]?.status,
        "running",
      );
      assert.equal(
        (await ownerPool.query(
          `SELECT status FROM scene_image_requests WHERE workspace_id = $1 AND id = $2`,
          [WS, claimA!.id],
        )).rows[0]?.status,
        "leased",
      );

      // B（rev2）合法完成：同一事务 ready + 文件 + request completed。
      const completed = await store.completeGenerationAndSettle(
        { workspaceId: WS, worldId, id: generationId },
        { contentType: "image/png", filename: "m8_ready.png", data: TINY_PNG },
        fenceB,
      );
      assert.equal(completed.replayed, false, "首次完成必须是真实提交");
      const ready = await store.findLatestReady({ workspaceId: WS, recordId: RECORD });
      assert.ok(ready, "B 的合法完成必须产生 latest-ready");
      const settled = await ownerPool.query(
        `SELECT status, generation_id FROM scene_image_requests
         WHERE workspace_id = $1 AND id = $2`,
        [WS, claimB!.id],
      );
      assert.deepEqual(
        { status: settled.rows[0]?.status, generationId: settled.rows[0]?.generation_id },
        { status: "completed", generationId },
        "request 必须与 generation ready 同一事务终态",
      );

      // 恢复契约（crash-after-commit：提交成功但 worker 未收到确认）：
      // 同一 request+revision+generation 的重放 = 幂等读回——返回同一
      // fileId、零写入、状态不变。绝不吞错误伪绿。
      const replay = await store.completeGenerationAndSettle(
        { workspaceId: WS, worldId, id: generationId },
        { contentType: "image/png", filename: "m8_ready.png", data: TINY_PNG },
        fenceB,
      );
      assert.equal(replay.replayed, true, "重放必须走幂等读回路径");
      assert.equal(replay.fileId, completed.fileId, "重放必须返回同一 fileId");
      assert.equal(await fx.countSceneFiles(), 1, "重放不得产生重复文件行");
      const afterReplay = await ownerPool.query(
        `SELECT status, generation_id, lease_revision FROM scene_image_requests
         WHERE workspace_id = $1 AND id = $2`,
        [WS, claimB!.id],
      );
      assert.deepEqual(
        {
          status: afterReplay.rows[0]?.status,
          generationId: afterReplay.rows[0]?.generation_id,
          leaseRevision: Number(afterReplay.rows[0]?.lease_revision),
        },
        { status: "completed", generationId, leaseRevision: 2 },
        "重放不得改写 request 行",
      );

      // 幂等读回精确绑定：不同 generation、旧 revision 一律 fail-closed。
      await assert.rejects(
        () => store.completeGenerationAndSettle(
          { workspaceId: WS, worldId, id: `sceneimg_other_${randomUUID().slice(0, 6)}` },
          { contentType: "image/png", filename: "m8_replay_other.png", data: TINY_PNG },
          fenceB,
        ),
        SceneImageFenceError,
        "不同 generation 的重放必须 fail-closed",
      );
      await assert.rejects(
        () => store.completeGenerationAndSettle(
          { workspaceId: WS, worldId, id: generationId },
          { contentType: "image/png", filename: "m8_replay_stale.png", data: TINY_PNG },
          fenceA,
        ),
        SceneImageFenceError,
        "旧 revision 的重放必须 fail-closed",
      );
      assert.equal(await fx.countSceneFiles(), 1, "fail-closed 重放不得产生文件行");
    });
  },
);

test(
  "M8: worker blocked in provider poll cannot land a late success after takeover (deterministic barrier)",
  { skip: !adminConnectionString || !runtimeConnectionString, timeout: 300_000 },
  async (t) => {
    await withFixture(t, async (fx) => {
      const { ownerPool, queue, store, worldId, sceneId } = fx;

      await queue.enqueue({
        workspaceId: WS,
        worldId,
        recordId: RECORD,
        sceneId,
        principalId: LOCAL_RECORD_SCOPE.principalId,
        triggerKind: "every_turn",
        sourceEventId: "m8-barrier-ready",
      });
      const claimA = await queue.claim({ workspaceId: WS }, { leaseMs: 60_000 });
      assert.ok(claimA);
      const fenceA = { requestId: claimA!.id, leaseRevision: claimA!.leaseRevision };

      // A 走真实 service 路径：claimOrCreateGeneration（fence=rev1 有效）→
      // 阻塞在 provider history 轮询。
      const barrier = makeBarrierClient();
      const serviceA = fx.createService(barrier.factory);
      const runA = serviceA.dispatchAndStoreSceneImage(
        { workspaceId: WS, principalId: LOCAL_RECORD_SCOPE.principalId, recordId: RECORD },
        {},
        { fence: fenceA },
      );
      // 等 A 确实进入 provider 轮询（此时 generation 已创建、lease 仍有效）。
      await barrier.entered;
      const running = await ownerPool.query(
        `SELECT id, status FROM scene_image_generations
         WHERE workspace_id = $1 AND record_id = $2`,
        [WS, RECORD],
      );
      assert.equal(running.rows[0]?.status, "running", "A 必须已创建 running generation");
      const generationId = String(running.rows[0]!.id);

      // A 仍阻塞在 provider 轮询时：lease 过期 → 恢复 → B（rev2）接管。
      await fx.expireLease(claimA!.id);
      assert.equal(await queue.recoverStale({ workspaceId: WS }), 1);
      const claimB = await queue.claim({ workspaceId: WS }, { leaseMs: 60_000 });
      assert.ok(claimB);
      assert.equal(claimB!.leaseRevision, 2);

      // 此刻才释放 A 的迟到 provider 成功响应：view/落库到达 store 时必须
      // 被 fence 拒绝。
      barrier.release("ready");
      const outcomeA = await runA.then(
        () => null,
        (error: unknown) => error,
      );
      assert.ok(outcomeA instanceof SceneImageFenceError, "迟到成功必须是 SceneImageFenceError");

      // 零持久/可见副作用；B 的状态/投影不受污染。
      const generationAfter = await ownerPool.query(
        `SELECT status, file_id FROM scene_image_generations WHERE workspace_id = $1 AND id = $2`,
        [WS, generationId],
      );
      assert.equal(generationAfter.rows[0]?.status, "running");
      assert.equal(generationAfter.rows[0]?.file_id, null);
      assert.equal(await fx.countSceneFiles(), 0, "迟到成功不得产生 world_files 行");
      const requestAfter = await ownerPool.query(
        `SELECT status, lease_revision, generation_id FROM scene_image_requests
         WHERE workspace_id = $1 AND id = $2`,
        [WS, claimA!.id],
      );
      assert.equal(requestAfter.rows[0]?.status, "leased");
      assert.equal(Number(requestAfter.rows[0]?.lease_revision), 2);
      assert.equal(requestAfter.rows[0]?.generation_id, null);
      assert.equal(
        (await store.findLatestReady({ workspaceId: WS, recordId: RECORD })),
        null,
        "latest-ready 投影不得显示 A 的迟到产出",
      );

      // B 路径保持完整：合法完成同一 generation，恰好一行文件。
      const completedB = await store.completeGenerationAndSettle(
        { workspaceId: WS, worldId, id: generationId },
        { contentType: "image/png", filename: "m8_barrier_b.png", data: TINY_PNG },
        { requestId: claimB!.id, leaseRevision: claimB!.leaseRevision },
      );
      assert.equal(completedB.replayed, false);
      assert.equal(await fx.countSceneFiles(), 1);
      assert.ok(await store.findLatestReady({ workspaceId: WS, recordId: RECORD }));
    });
  },
);

test(
  "M8: worker blocked in provider poll cannot land a late failure after takeover (deterministic barrier)",
  { skip: !adminConnectionString || !runtimeConnectionString, timeout: 300_000 },
  async (t) => {
    await withFixture(t, async (fx) => {
      const { ownerPool, queue, store, worldId, sceneId } = fx;

      await queue.enqueue({
        workspaceId: WS,
        worldId,
        recordId: RECORD,
        sceneId,
        principalId: LOCAL_RECORD_SCOPE.principalId,
        triggerKind: "every_turn",
        sourceEventId: "m8-barrier-failed",
      });
      const claimA = await queue.claim({ workspaceId: WS }, { leaseMs: 60_000 });
      assert.ok(claimA);
      const fenceA = { requestId: claimA!.id, leaseRevision: claimA!.leaseRevision };

      const barrier = makeBarrierClient();
      const serviceA = fx.createService(barrier.factory);
      const runA = serviceA.dispatchAndStoreSceneImage(
        { workspaceId: WS, principalId: LOCAL_RECORD_SCOPE.principalId, recordId: RECORD },
        {},
        { fence: fenceA },
      );
      await barrier.entered;

      // A 阻塞中 B 接管，然后 A 收到迟到的 provider 失败。
      await fx.expireLease(claimA!.id);
      assert.equal(await queue.recoverStale({ workspaceId: WS }), 1);
      const claimB = await queue.claim({ workspaceId: WS }, { leaseMs: 60_000 });
      assert.ok(claimB);
      assert.equal(claimB!.leaseRevision, 2);

      barrier.release("failed");
      const outcomeA = await runA.then(
        () => null,
        (error: unknown) => error,
      );
      assert.ok(outcomeA instanceof SceneImageFenceError, "迟到失败必须是 SceneImageFenceError");

      // generation 不被翻转成 failed、不写错误码；request 仍 leased/rev2。
      const generationAfter = await ownerPool.query(
        `SELECT id, status, error_code FROM scene_image_generations
         WHERE workspace_id = $1 AND record_id = $2`,
        [WS, RECORD],
      );
      assert.equal(generationAfter.rows[0]?.status, "running", "迟到失败不得翻转 generation");
      assert.equal(generationAfter.rows[0]?.error_code, null, "迟到失败不得写错误码");
      const requestAfter = await ownerPool.query(
        `SELECT status, lease_revision FROM scene_image_requests
         WHERE workspace_id = $1 AND id = $2`,
        [WS, claimA!.id],
      );
      assert.equal(requestAfter.rows[0]?.status, "leased");
      assert.equal(Number(requestAfter.rows[0]?.lease_revision), 2);
      assert.equal(
        (await store.findLatestReady({ workspaceId: WS, recordId: RECORD })),
        null,
      );

      // B 仍能把同一条请求带到终态（证明未被污染）。
      await store.failGenerationAndSettle(
        { workspaceId: WS, id: String(generationAfter.rows[0]!.id) },
        "GENERATION_FAILED",
        { requestId: claimB!.id, leaseRevision: claimB!.leaseRevision },
      );
      const terminal = await ownerPool.query(
        `SELECT status FROM scene_image_requests WHERE workspace_id = $1 AND id = $2`,
        [WS, claimB!.id],
      );
      assert.equal(terminal.rows[0]?.status, "failed");
    });
  },
);

test(
  "M8: worker blocked inside provider queuePrompt cannot create the generation ledger after takeover (deterministic barrier)",
  { skip: !adminConnectionString || !runtimeConnectionString, timeout: 300_000 },
  async (t) => {
    await withFixture(t, async (fx) => {
      const { ownerPool, queue, store, worldId, sceneId } = fx;

      await queue.enqueue({
        workspaceId: WS,
        worldId,
        recordId: RECORD,
        sceneId,
        principalId: LOCAL_RECORD_SCOPE.principalId,
        triggerKind: "every_turn",
        sourceEventId: "m8-barrier-queueprompt",
      });
      const claimA = await queue.claim({ workspaceId: WS }, { leaseMs: 60_000 });
      assert.ok(claimA);
      const fenceA = { requestId: claimA!.id, leaseRevision: claimA!.leaseRevision };

      // A 在 fence 仍有效时进入 claimOrCreateGeneration，随后阻塞在
      // provider queuePrompt()（真实生产慢调用窗口；recoverStale/claim 不持
      // record advisory lock，B 可以在此窗口接管）。
      let signalEntered!: () => void;
      let releasePrompt!: () => void;
      const entered = new Promise<void>((resolve) => { signalEntered = resolve; });
      const gate = new Promise<void>((resolve) => { releasePrompt = resolve; });
      const runA = store.claimOrCreateGeneration(
        {
          workspaceId: WS,
          worldId,
          recordId: RECORD,
          sceneId,
          queuePrompt: async () => {
            signalEntered();
            await gate;
            return "pid_m8_prompt_a";
          },
        },
        { fence: fenceA },
      );
      await entered;

      // A 仍阻塞在 provider queuePrompt() 时：lease 过期 → 恢复 → B（rev2）
      // 接管。
      await fx.expireLease(claimA!.id);
      assert.equal(await queue.recoverStale({ workspaceId: WS }), 1);
      const claimB = await queue.claim({ workspaceId: WS }, { leaseMs: 60_000 });
      assert.ok(claimB);
      assert.equal(claimB!.leaseRevision, 2);
      const fenceB = { requestId: claimB!.id, leaseRevision: claimB!.leaseRevision };

      // 此刻才释放 A 的迟到 queuePrompt 返回：generation INSERT 前必须重新
      // 验证 authority（锁定），A 已失效 → SceneImageFenceError，零台账副作用。
      // 已发出的 provider prompt 无法撤回（明示限制），但台账不得落行。
      releasePrompt();
      const outcomeA = await runA.then(
        () => null,
        (error: unknown) => error,
      );
      assert.ok(
        outcomeA instanceof SceneImageFenceError,
        "queuePrompt 在途窗口后的迟到台账写入必须被拒绝",
      );
      const generations = await ownerPool.query(
        `SELECT count(*)::int AS count FROM scene_image_generations
         WHERE workspace_id = $1 AND record_id = $2`,
        [WS, RECORD],
      );
      assert.equal(generations.rows[0]!.count, 0, "迟到 queuePrompt 不得留下 generation 台账");
      assert.equal(await fx.countSceneFiles(), 0, "迟到 queuePrompt 不得产生 world_files 行");
      const requestAfter = await ownerPool.query(
        `SELECT status, lease_revision, generation_id FROM scene_image_requests
         WHERE workspace_id = $1 AND id = $2`,
        [WS, claimA!.id],
      );
      assert.equal(requestAfter.rows[0]?.status, "leased");
      assert.equal(Number(requestAfter.rows[0]?.lease_revision), 2);
      assert.equal(requestAfter.rows[0]?.generation_id, null, "request 不得绑定 A 的迟到 generation");
      assert.equal(
        (await store.findLatestReady({ workspaceId: WS, recordId: RECORD })),
        null,
      );

      // B 路径保持完整：正常创建 generation 并原子结算。
      const startedB = await store.claimOrCreateGeneration(
        {
          workspaceId: WS,
          worldId,
          recordId: RECORD,
          sceneId,
          queuePrompt: async () => "pid_m8_prompt_b",
        },
        { fence: fenceB },
      );
      assert.equal(startedB.reused, false, "B 必须能正常创建 generation");
      const completedB = await store.completeGenerationAndSettle(
        { workspaceId: WS, worldId, id: startedB.generation.id },
        { contentType: "image/png", filename: "m8_prompt_b.png", data: TINY_PNG },
        fenceB,
      );
      assert.equal(completedB.replayed, false);
      assert.equal(await fx.countSceneFiles(), 1);
      const terminal = await ownerPool.query(
        `SELECT status, generation_id FROM scene_image_requests
         WHERE workspace_id = $1 AND id = $2`,
        [WS, claimB!.id],
      );
      assert.equal(terminal.rows[0]?.status, "completed");
      assert.equal(terminal.rows[0]?.generation_id, startedB.generation.id);
    });
  },
);
