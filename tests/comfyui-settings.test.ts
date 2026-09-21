/**
 * ComfyUI 设置存储测试（临时目录隔离，不碰 .local 真实配置）。
 * 钉住：默认值、校验负例（协议/凭据/query/timeout/workflowId）、
 * 0600 原子写、public snapshot 不回显 apiKey、空 key 补丁不清空。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  COMFYUI_DEFAULT_WORKFLOW_ID,
  ComfyUiSettingsError,
  createComfyUiSettingsStore,
  publicComfyUiSettings,
} from "../modules/imagine/public.ts";

async function tempStore(environment: Record<string, string | undefined> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "realm-comfyui-test-"));
  const store = createComfyUiSettingsStore({
    filePath: join(dir, "settings", "comfyui.json"),
    environment,
    clock: () => new Date("2026-09-20T00:00:00.000Z"),
  });
  return { dir, store, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("store: 缺省文件回落默认值（环境覆盖优先于内置缺省）", async () => {
  const plain = await tempStore();
  try {
    const loaded = await plain.store.load();
    assert.equal(loaded.enabled, false);
    assert.equal(loaded.workflowId, COMFYUI_DEFAULT_WORKFLOW_ID);
    assert.equal(loaded.apiKey, "");
  } finally {
    await plain.cleanup();
  }
  const overridden = await tempStore({ REALM_COMFYUI_BASE_URL: "http://10.0.0.8:8000" });
  try {
    assert.equal((await overridden.store.load()).baseUrl, "http://10.0.0.8:8000");
  } finally {
    await overridden.cleanup();
  }
});

test("store: 保存/读取回环，文件 0600，apiKey 不出现在 public snapshot", async () => {
  const { dir, store, cleanup } = await tempStore();
  try {
    const saved = await store.save({
      enabled: true,
      baseUrl: "http://192.168.1.20:8000/",
      requestTimeoutMs: 45_000,
      apiKey: "ck_test_secret_0001",
    });
    assert.equal(saved.enabled, true);
    assert.equal(saved.baseUrl, "http://192.168.1.20:8000", "尾部斜线归一");
    assert.equal(saved.apiKey, "ck_test_secret_0001");
    const fileMode = (await stat(join(dir, "settings", "comfyui.json"))).mode & 0o777;
    assert.equal(fileMode, 0o600, "配置文件必须 0600");
    const snapshot = publicComfyUiSettings(saved);
    assert.equal(snapshot.apiKeyConfigured, true);
    assert.ok(!JSON.stringify(snapshot).includes("ck_test_secret_0001"), "snapshot 不得含 key");
    // 空 key 补丁不清空已有密钥。
    const reSaved = await store.save({ baseUrl: "http://192.168.1.21:8000", apiKey: "" });
    assert.equal(reSaved.apiKey, "ck_test_secret_0001");
  } finally {
    await cleanup();
  }
});

test("store: 非法 URL/协议/内嵌凭据/超时越界 fail-closed", async () => {
  const { store, cleanup } = await tempStore();
  try {
    for (const patch of [
      { baseUrl: "javascript:alert(1)" },
      { baseUrl: "file:///etc/passwd" },
      { baseUrl: "http://user:pw@192.168.1.20:8000" },
      { baseUrl: "http://192.168.1.20:8000/?x=1" },
      { baseUrl: "http://192.168.1.20:8000/#frag" },
      { baseUrl: "not-a-url" },
      { requestTimeoutMs: 100 },
      { requestTimeoutMs: 300_000 },
      { workflowId: "bad id!" },
    ]) {
      await assert.rejects(store.save(patch), (error: unknown) => {
        assert.ok(error instanceof ComfyUiSettingsError);
        return true;
      }, JSON.stringify(patch));
    }
  } finally {
    await cleanup();
  }
});
