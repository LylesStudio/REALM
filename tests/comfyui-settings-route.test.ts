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
