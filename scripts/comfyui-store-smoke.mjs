/**
 * ComfyUI 输出落库真实冒烟（一次性脚本，不入测试门，缺服务 fail-closed）。
 * 真实调用路径：POST /api/record/scene-image {dispatch:true}（route 直调）
 * → scene-image-service → 原生 client → ComfyUI → history → /view 下载 →
 * world_files + 台账 → GET /api/files/<id> 读回字节。
 * 需要 REALM_RUNTIME_DATABASE_URL（loopback scratch）+ REALM_DATA_HOME
 * （含已启用且校验通过的 comfyui.json；可用环境变量覆盖默认地址后先经
 * 设置 route 保存）。绝不连接共享 realm_dev。
 *
 * 用法：
 *   REALM_RUNTIME_DATABASE_URL=postgresql://realm_runtime@127.0.0.1:<port>/<db> \
 *   REALM_DATA_HOME=<tmpdir> node scripts/comfyui-store-smoke.mjs
 */
import { assertLoopbackDatabaseUrl } from "./baseline-common.mjs";

assertLoopbackDatabaseUrl(process.env.REALM_RUNTIME_DATABASE_URL ?? "");
if (!process.env.REALM_DATA_HOME) {
  throw new Error("REALM_DATA_HOME required (isolated settings dir)");
}
delete process.env.REALM_ACCESS_TOKEN;

const { POST } = await import("../app/api/record/scene-image/route.ts");
// 新门禁（0051 后）：route 需要账户会话 cookie。
const { createSessionValue } = await import("../modules/identity/auth.ts");
const sessionCookie = `realm_session=${createSessionValue("principal_demo_player")}`;
const { GET: getFile } = await import("../app/api/files/[id]/route.ts");

const response = await POST(new Request("http://127.0.0.1/api/record/scene-image", {
  method: "POST",
  headers: { "Content-Type": "application/json", cookie: sessionCookie },
  body: JSON.stringify({ dispatch: true }),
}));
const body = await response.json();
if (!response.ok || !body.ok) {
  console.error(`[smoke] dispatch failed: ${body?.error?.code ?? response.status}`);
  process.exit(1);
}
console.log(`[smoke] dispatch status=${body.status} workflow=${body.workflowId}`);
if (body.status !== "ready") {
  console.error("[smoke] 未在预算内 ready（running 不算失败——下次调用会继续同一 prompt）");
  process.exit(2);
}
const fileId = body.fileId;
console.log(`[smoke] ready: fileId=${fileId} fileUrl=${body.fileUrl}`);

// 经真实 files route 读回（session/membership 由 demo fallback principal 承担）。
const fileResponse = await getFile(new Request(`http://127.0.0.1${body.fileUrl}`, { headers: { cookie: sessionCookie } }), {
  params: Promise.resolve({ id: fileId }),
});
if (!fileResponse.ok) {
  console.error(`[smoke] file read failed: ${fileResponse.status}`);
  process.exit(1);
}
const bytes = Buffer.from(await fileResponse.arrayBuffer());
const isPng = bytes.length > 4
  && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
console.log(
  `[smoke] file read: ${bytes.length} bytes, content-type=${fileResponse.headers.get("content-type")}, pngMagic=${isPng}`,
);
if (!isPng) process.exit(1);
console.log("[smoke] OK：生成→落库→读回闭环完成");
