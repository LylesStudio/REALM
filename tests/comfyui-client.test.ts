/**
 * 原生 ComfyUI client 测试（注入 fake fetch；不打真实网络）。
 * 钉住：成功解析、超时/拒绝/坏响应的错误分类、错误不泄漏 URL/body/key。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  ComfyUiError,
  createComfyUiClient,
} from "../modules/imagine/public.ts";

const SETTINGS = {
  baseUrl: "http://comfy-fixture.internal:8000",
  requestTimeoutMs: 5_000,
  apiKey: "ck_fixture_secret",
};

test("client: systemStats 成功返回延迟", async () => {
  const seen: string[] = [];
  const client = createComfyUiClient(SETTINGS, async (input, init) => {
    seen.push(`${init?.method ?? "GET"} ${input}`);
    assert.ok(
      (init?.headers as Record<string, string>).Authorization === "Bearer ck_fixture_secret",
      "配置 key 时必须带 Authorization",
    );
    return new Response("{}", { status: 200 });
  });
  const { latencyMs } = await client.systemStats();
  assert.ok(latencyMs >= 0);
  assert.deepEqual(seen, ["GET http://comfy-fixture.internal:8000/system_stats"]);
});

test("client: queuePrompt 成功返回 promptId，body 只含 graph", async () => {
  let posted = "";
  const client = createComfyUiClient({ ...SETTINGS, apiKey: "" }, async (input, init) => {
    assert.equal(input, "http://comfy-fixture.internal:8000/prompt");
    assert.equal(init?.method, "POST");
    posted = String(init?.body);
    return new Response(JSON.stringify({ prompt_id: "pid-fixture-1" }), { status: 200 });
  });
  const { promptId } = await client.queuePrompt({
    "9": { class_type: "SaveImage", inputs: { filename_prefix: "x" } },
  });
  assert.equal(promptId, "pid-fixture-1");
  const parsed = JSON.parse(posted);
  assert.ok(parsed.prompt["9"], "POST body 必须是 {prompt: graph}");
  assert.ok(!posted.includes("ck_fixture_secret"));
});

test("client: 非 200 / 坏 JSON / 网络失败 / 超时的错误分类与脱敏", async () => {
  const rejected = createComfyUiClient(SETTINGS, async () =>
    new Response("secret internal node dump", { status: 400 }));
  await assert.rejects(rejected.systemStats(), (error: unknown) => {
    assert.ok(error instanceof ComfyUiError);
    assert.equal(error.code, "COMFYUI_REJECTED");
    assert.ok(!error.message.includes("secret internal"), "不得回显 provider body");
    assert.ok(!error.message.includes("comfy-fixture.internal"), "不得回显 URL");
    return true;
  });

  const badJson = createComfyUiClient(SETTINGS, async () =>
    new Response("<html>nope</html>", { status: 200 }));
  await assert.rejects(badJson.systemStats(), (error: unknown) => {
    assert.ok(error instanceof ComfyUiError && error.code === "COMFYUI_INVALID_RESPONSE");
    return true;
  });

  const down = createComfyUiClient(SETTINGS, async () => {
    throw new TypeError("fetch failed: http://comfy-fixture.internal:8000 refused");
  });
  await assert.rejects(down.systemStats(), (error: unknown) => {
    assert.ok(error instanceof ComfyUiError && error.code === "COMFYUI_UNREACHABLE");
    assert.ok(!error.message.includes("comfy-fixture.internal"));
    return true;
  });

  const hanging = createComfyUiClient(
    { ...SETTINGS, requestTimeoutMs: 5_000 },
    (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")));
      }),
  );
  const shortTimeout = createComfyUiClient(
    { ...SETTINGS, requestTimeoutMs: 30 },
    (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")));
      }),
  );
  void hanging;
  await assert.rejects(shortTimeout.systemStats(), (error: unknown) => {
    assert.ok(error instanceof ComfyUiError && error.code === "COMFYUI_TIMEOUT");
    return true;
  });
});
