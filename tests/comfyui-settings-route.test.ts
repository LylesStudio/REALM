/**
 * /api/settings/comfyui route 测试：真实 route 函数 → 真实文件 store
 * （REALM_DATA_HOME 指向临时目录），GET/PUT/POST test 全链。
 * 连接测试打向必死的未监听 loopback 端口（即时 refused），验证 502 安全文案
 * 不回显 URL/内部错误；不依赖真实 ComfyUI。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataHome = await mkdtemp(join(tmpdir(), "realm-comfyui-route-"));
process.env.REALM_DATA_HOME = dataHome;
delete process.env.REALM_ACCESS_TOKEN;
// M7：设置路由已加 operator 门禁；本文件的门禁关闭场景走本地单用户
// fallback principal（principal_demo_player），显式列入 allowlist。
process.env.REALM_OPERATOR_PRINCIPALS = "principal_demo_player";

const { GET, PUT, POST } = await import("../app/api/settings/comfyui/route.ts");

test("comfyui settings route: GET 默认快照 → PUT 保存 → GET 回读（key 不回显）", async (t) => {
  t.after(async () => rm(dataHome, { recursive: true, force: true }));

  const initial = await GET(new Request("http://127.0.0.1/api/settings/comfyui"));
  assert.equal(initial.status, 200);
  const initialBody = await initial.json();
  assert.equal(initialBody.ok, true);
  assert.equal(initialBody.settings.enabled, false);
  assert.equal(initialBody.settings.apiKeyConfigured, false);
  assert.ok(!("apiKey" in initialBody.settings), "public snapshot 不得含 apiKey 字段");

  const saved = await PUT(new Request("http://127.0.0.1/api/settings/comfyui", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      enabled: true,
      baseUrl: "http://127.0.0.1:9/comfy",  // 合法形态；测试不连接它
      requestTimeoutMs: 10_000,
      workflowId: "anima-scene-t2i-v0",
      apiKey: "ck_route_secret_0001",
    }),
  }));
  assert.equal(saved.status, 200);
  const savedBody = await saved.json();
  assert.equal(savedBody.settings.enabled, true);
  assert.equal(savedBody.settings.apiKeyConfigured, true);
  assert.ok(!JSON.stringify(savedBody).includes("ck_route_secret_0001"), "保存响应不得回显 key");

  const reloaded = await GET(new Request("http://127.0.0.1/api/settings/comfyui"));
  const reloadedBody = await reloaded.json();
  assert.equal(reloadedBody.settings.baseUrl, "http://127.0.0.1:9/comfy");
  assert.equal(reloadedBody.settings.requestTimeoutMs, 10_000);

  // 非法 URL 被 400 拒绝。
  const invalid = await PUT(new Request("http://127.0.0.1/api/settings/comfyui", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ baseUrl: "javascript:alert(1)" }),
  }));
  assert.equal(invalid.status, 400);
  const invalidBody = await invalid.json();
  assert.equal(invalidBody.error.code, "COMFYUI_SETTINGS_INVALID");
  assert.ok(!JSON.stringify(invalidBody).includes("javascript:"), "错误不得回显输入");
});

test("comfyui settings route: POST test 连接失败给 502 安全文案", async (t) => {
  const dataHome2 = await mkdtemp(join(tmpdir(), "realm-comfyui-route2-"));
  t.after(async () => rm(dataHome2, { recursive: true, force: true }));
  // 用独立服务实例指向同一目录结构（store 每请求按 REALM_DATA_HOME 解析）。
  const saved = process.env.REALM_DATA_HOME;
  process.env.REALM_DATA_HOME = dataHome2;
  try {
    const response = await POST(new Request("http://127.0.0.1/api/settings/comfyui", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "test",
        baseUrl: "http://127.0.0.1:9/unreachable",
        requestTimeoutMs: 5_000,
      }),
    }));
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "COMFYUI_UNREACHABLE");
    assert.ok(!JSON.stringify(body).includes("127.0.0.1:9"), "错误不得回显目标地址");
  } finally {
    process.env.REALM_DATA_HOME = saved;
  }
});

test("comfyui settings route: 未知 action 400", async () => {
  const response = await POST(new Request("http://127.0.0.1/api/settings/comfyui", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "destroy" }),
  }));
  assert.equal(response.status, 400);
});

/**
 * M7 收口：/api/settings/comfyui 是全局 operator 能力。
 * 唯一授权来源 = 服务端 REALM_OPERATOR_PRINCIPALS（逗号分隔精确 principal
 * 列表；空缺/空白 = 无 operator，fail-closed；无通配符）。principal 只来自
 * 已验证 session / 本地单用户 fallback；body/query 里的 principal 不算数。
 * 授权失败固定 403，不读设置、不发网络请求。
 */
test("operator gate: 无 allowlist / 空 allowlist / 普通 player / 伪造 body principal 一律 403 且零网络", async (t) => {
  const http = await import("node:http");
  const { createSessionValue } = await import("../modules/identity/auth.ts");
  const savedOperator = process.env.REALM_OPERATOR_PRINCIPALS;
  const savedDb = process.env.REALM_RUNTIME_DATABASE_URL;
  const savedSecret = process.env.REALM_SESSION_SECRET;
  process.env.REALM_SESSION_SECRET = "test-only-operator-gate-secret-0001";
  // collector：任何误发请求都会记数（授权失败必须零网络）。
  let hits = 0;
  const collector = http.createServer((req, res) => {
    hits += 1;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolveListen) => collector.listen(0, "127.0.0.1", resolveListen));
  const collectorUrl = `http://127.0.0.1:${(collector.address() as { port: number }).port}`;
  t.after(async () => {
    await new Promise((resolveClose) => collector.close(resolveClose));
    if (savedOperator === undefined) delete process.env.REALM_OPERATOR_PRINCIPALS;
    else process.env.REALM_OPERATOR_PRINCIPALS = savedOperator;
    if (savedDb === undefined) delete process.env.REALM_RUNTIME_DATABASE_URL;
    else process.env.REALM_RUNTIME_DATABASE_URL = savedDb;
    if (savedSecret === undefined) delete process.env.REALM_SESSION_SECRET;
    else process.env.REALM_SESSION_SECRET = savedSecret;
  });
  try {
    // 1) 门禁关闭（本地单用户 fallback principal）但无 operator 配置 → 403。
    delete process.env.REALM_RUNTIME_DATABASE_URL;
    delete process.env.REALM_OPERATOR_PRINCIPALS;
    const getAnon = await GET(new Request("http://127.0.0.1/api/settings/comfyui"));
    assert.equal(getAnon.status, 403, "无 operator 配置时 GET 必须 403");
    const getAnonBody = await getAnon.json();
    assert.equal(getAnonBody.ok, false);
    assert.ok(!("settings" in getAnonBody), "403 不得携带已存设置");

    // 2) 空白 allowlist 视同无 operator。
    process.env.REALM_OPERATOR_PRINCIPALS = "  ,  ";
    assert.equal((await GET(new Request("http://127.0.0.1/api/settings/comfyui"))).status, 403);

    // 3) 门禁开启 + 普通已登录 player（不在 allowlist）→ 403。
    process.env.REALM_RUNTIME_DATABASE_URL = "postgresql://realm_runtime@127.0.0.1:5432/realm";
    process.env.REALM_OPERATOR_PRINCIPALS = "principal_someone_else";
    const playerCookie = `realm_session=${createSessionValue("principal_regular_player")}`;
    const getPlayer = await GET(new Request("http://127.0.0.1/api/settings/comfyui", {
      headers: { cookie: playerCookie },
    }));
    assert.equal(getPlayer.status, 403, "普通 player 不得读取 operator 设置");

    // 4) 伪造 body principal：body 里自称 operator 不算数（授权只认 session）。
    const putForged = await PUT(new Request("http://127.0.0.1/api/settings/comfyui", {
      method: "PUT",
      headers: { "Content-Type": "application/json", cookie: playerCookie },
      body: JSON.stringify({
        principalId: "principal_someone_else",
        baseUrl: collectorUrl,
      }),
    }));
    assert.equal(putForged.status, 403, "body 伪造 principal 不得授权");

    // 5) POST test 未授权 → 403 且 collector 零命中（不发网络请求）。
    const postTest = await POST(new Request("http://127.0.0.1/api/settings/comfyui", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: playerCookie },
      body: JSON.stringify({ action: "test", baseUrl: collectorUrl }),
    }));
    assert.equal(postTest.status, 403);
    assert.equal(hits, 0, "未授权 POST test 不得发起任何 outbound 请求");

    // 6) 通配符不是 operator。
    process.env.REALM_OPERATOR_PRINCIPALS = "*";
    assert.equal(
      (await GET(new Request("http://127.0.0.1/api/settings/comfyui", { headers: { cookie: playerCookie } }))).status,
      403,
      "通配符不得视为 operator",
    );

    // 7) 精确列入 allowlist 的有效 session principal → GET 200。
    process.env.REALM_OPERATOR_PRINCIPALS = `principal_regular_player, principal_another`;
    const getOperator = await GET(new Request("http://127.0.0.1/api/settings/comfyui", {
      headers: { cookie: playerCookie },
    }));
    assert.equal(getOperator.status, 200, "allowlist 精确命中必须放行");
    const operatorBody = await getOperator.json();
    assert.equal(operatorBody.ok, true);
    assert.ok(operatorBody.settings, "operator GET 返回设置快照");
  } finally {
    // t.after 统一恢复。
  }
});
