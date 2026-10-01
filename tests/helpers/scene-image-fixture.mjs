/**
 * z7 场景图 GUI 的离线 fixture（仅测试用）：
 * - 进程内 loopback fake ComfyUI（/system_stats、/prompt、/history、/view）；
 * - 经 scratch admin 连接预置一条 ready 场景图（world_files + generations），
 *   让记录页既有背景读回路径可被断言。
 * 只在 scratch runner（REALM_GUI_SCRATCH=1 + loopback 管理连接）下可用；
 * 绝不连接共享库/真实 ComfyUI/公网。
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pg = require("pg");

/** 1x1 合法 PNG（content-addressed fixture）。 */
export const Z7_TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

function requireScratchAdmin(connectionString) {
  if (process.env.REALM_GUI_SCRATCH !== "1") {
    throw new Error("scene-image fixtures require the isolated GUI scratch runner.");
  }
  const url = new URL(connectionString ?? "");
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("scene-image fixtures require a loopback scratch PostgreSQL.");
  }
  return url.href;
}

/**
 * 预置 ready 场景图：demo 记录当前场景一条 ready generation + 对应
 * world_files 行（与生产 store 相同的 content-addressed file id）。
 * 返回 fileId 供断言。
 */
export async function seedReadySceneImage(adminConnectionString) {
  const client = new pg.Client({
    connectionString: requireScratchAdmin(adminConnectionString),
  });
  await client.connect();
  try {
    const meta = await client.query(
      `SELECT record.world_id,
              (SELECT id FROM scenes WHERE workspace_id = record.workspace_id AND record_id = record.id ORDER BY start_tick ASC LIMIT 1) AS scene_id
       FROM records AS record WHERE record.workspace_id = 'ws_demo' AND record.id = 'record_first_watch'`,
    );
    const row = meta.rows[0];
    if (!row?.world_id || !row?.scene_id) {
      throw new Error("scratch demo record/scene missing for scene-image fixture");
    }
    const sha256 = createHash("sha256").update(Z7_TINY_PNG).digest("hex");
    const fileId = `file_${sha256.slice(0, 32)}`;
    await client.query(
      `INSERT INTO world_files
         (workspace_id, world_id, id, kind, content_type, filename, sha256, size_bytes, data)
       VALUES ('ws_demo', $1, $2, 'scene_background', 'image/png', 'z7_seed.png', $3, $4, $5)
       ON CONFLICT (workspace_id, id) DO NOTHING`,
      [row.world_id, fileId, sha256, Z7_TINY_PNG.length, Z7_TINY_PNG],
    );
    await client.query(
      `INSERT INTO scene_image_generations
         (workspace_id, id, world_id, record_id, scene_id, status, file_id, prompt_id)
       VALUES ('ws_demo', 'sceneimg_z7_seed', $1, 'record_first_watch', $2, 'ready', $3, 'pid_z7_seed')
       ON CONFLICT (workspace_id, id) DO NOTHING`,
      [row.world_id, row.scene_id, fileId],
    );
    return { fileId };
  } finally {
    await client.end();
  }
}

/**
 * 进程内 loopback fake ComfyUI：只实现 z7 用到的四个端点，记录所有请求
 * （含 Authorization 观察）。fake 输出图 = Z7_TINY_PNG。
 */
export async function startFakeComfyUi() {
  const { createServer } = await import("node:http");
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    requests.push({ method: req.method, path: url.pathname, authorization: req.headers.authorization });
    if (req.method === "GET" && url.pathname === "/system_stats") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ system: { os: "fake" }, devices: [] }));
      return;
    }
    if (req.method === "POST" && url.pathname === "/prompt") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ prompt_id: "pid_fake_z7" }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/history/pid_fake_z7") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        pid_fake_z7: {
          status: { status_str: "success", completed: true },
          outputs: { "9": { images: [{ filename: "realm_z7_fake_00001_.png", subfolder: "", type: "output" }] } },
        },
      }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/view") {
      res.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": String(Z7_TINY_PNG.length),
      });
      res.end(Z7_TINY_PNG);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const port = server.address().port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise((resolveClose) => server.close(resolveClose));
    },
  };
}

/** 把 fake endpoint 写进 scratch REALM_DATA_HOME 的设置文件（dispatcher 每请求现读）。 */
export async function enableComfyUiForScratch(baseUrl) {
  const dataHome = process.env.REALM_DATA_HOME;
  if (process.env.REALM_GUI_SCRATCH !== "1" || !dataHome) {
    throw new Error("enableComfyUiForScratch requires the isolated GUI scratch runner.");
  }
  const { mkdir, writeFile, chmod } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const directory = join(dataHome, "settings");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filePath = join(directory, "comfyui.json");
  await writeFile(filePath, `${JSON.stringify({
    enabled: true,
    baseUrl,
    requestTimeoutMs: 10_000,
    workflowId: "anima-scene-t2i-v0",
    apiKey: "",
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(filePath, 0o600);
}
