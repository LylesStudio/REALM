/**
 * 自动模式真实闭环 smoke（一次性脚本，不入测试门，缺服务 fail-closed）。
 * 真实路径：queue.enqueue（every_turn 意图）→ scene-image worker runtime
 * （真实 ComfyUI 配置 + 原生 client）→ claim → /prompt → history → /view →
 * world_files + 台账 ready → 请求 completed；DB 侧验证 PNG magic。
 *
 * 用法：
 *   REALM_RUNTIME_DATABASE_URL=postgresql://realm_runtime@127.0.0.1:<port>/<db> \
 *   REALM_DATA_HOME=<tmpdir-with-enabled-comfyui.json> \
 *   node scripts/comfyui-auto-smoke.mjs
 */
import { assertLoopbackDatabaseUrl } from "./baseline-common.mjs";

const connectionString = process.env.REALM_RUNTIME_DATABASE_URL ?? "";
assertLoopbackDatabaseUrl(connectionString);
if (!process.env.REALM_DATA_HOME) {
  throw new Error("REALM_DATA_HOME required (isolated settings dir)");
}

const {
  createLocalPostgresPool,
  createPostgresSceneImageQueue,
  withWorkspaceTransaction,
} = await import("../database/postgres/public.ts");
const { createSceneImageWorkerRuntime } = await import(
  "../modules/application/scene-image-worker-runtime.ts"
);

const pool = createLocalPostgresPool(connectionString, { max: 4 });
pool.on("error", () => {});
const queue = createPostgresSceneImageQueue(pool);

// demo record 锚点（workspace 由调用方经 REALM_SCENE_IMAGE_WORKSPACE 指定）。
const workspaceId = process.env.REALM_SCENE_IMAGE_WORKSPACE ?? "ws_demo";
const recordId = process.env.REALM_SCENE_IMAGE_RECORD ?? "record_first_watch";

const meta = await withWorkspaceTransaction(pool, workspaceId, async (client) => {
  const result = await client.query(
    `SELECT record.world_id,
            (SELECT id FROM scenes WHERE workspace_id = record.workspace_id AND record_id = record.id ORDER BY start_tick ASC LIMIT 1) AS scene_id
     FROM records AS record WHERE record.workspace_id = $1 AND record.id = $2`,
    [workspaceId, recordId],
  );
  return result;
}, { readOnly: true });
if (!meta.rows[0]?.world_id || !meta.rows[0]?.scene_id) {
  console.error("[smoke] demo record 不存在（先迁移+seed）");
  process.exit(1);
}

const enqueued = await queue.enqueue({
  workspaceId,
  worldId: meta.rows[0].world_id,
  recordId,
  sceneId: meta.rows[0].scene_id,
  principalId: "principal_demo_player",
  triggerKind: "every_turn",
  sourceEventId: `auto-smoke-${Date.now()}`,
});
console.log(`[smoke] enqueued=${enqueued.enqueued} request=${enqueued.request.id}`);

const runtime = createSceneImageWorkerRuntime({
  connectionString,
  workspaces: [workspaceId],
  idleMinMs: 200,
  idleMaxMs: 1_000,
});
void runtime.start();

let done = false;
const deadline = Date.now() + 150_000;
while (Date.now() < deadline) {
  const row = await withWorkspaceTransaction(pool, workspaceId, async (client) => {
    return client.query(
      `SELECT status, generation_id FROM scene_image_requests
       WHERE workspace_id = $1 AND id = $2`,
      [workspaceId, enqueued.request.id],
    );
  }, { readOnly: true });
  const status = row.rows[0]?.status;
  if (status === "completed" || status === "failed") {
    console.log(`[smoke] request ${status} (generation bound: ${Boolean(row.rows[0]?.generation_id)})`);
    done = status === "completed";
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}
await runtime.stop();

if (!done) {
  console.error("[smoke] 请求未在预算内 completed");
  process.exit(1);
}

const file = await withWorkspaceTransaction(pool, workspaceId, async (client) => {
  return client.query(
    `SELECT octet_length(file.data) AS bytes,
            substring(file.data from 1 for 4) AS magic
     FROM world_files AS file
     JOIN scene_image_generations AS generation
       ON generation.workspace_id = file.workspace_id AND generation.file_id = file.id
     WHERE file.workspace_id = $1 AND file.kind = 'scene_background'
     ORDER BY generation.created_at DESC LIMIT 1`,
    [workspaceId],
  );
}, { readOnly: true });
const magic = file.rows[0]?.magic;
const isPng = Buffer.isBuffer(magic)
  && magic[0] === 0x89 && magic[1] === 0x50 && magic[2] === 0x4e && magic[3] === 0x47;
console.log(`[smoke] world_files: ${file.rows[0]?.bytes} bytes, pngMagic=${isPng}`);
await pool.end();
if (!isPng) process.exit(1);
console.log("[smoke] OK：自动请求→worker→生成→落库闭环完成");
process.exit(0);
