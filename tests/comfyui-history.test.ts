/**
 * ComfyUI history/viewImage 测试（注入 resolver+transport）：状态映射、
 * 输出图引用提取、路径注入/超大/坏 magic fail-closed，错误不回显
 * URL/body/key。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  COMFYUI_IMAGE_MAX_BYTES,
  ComfyUiError,
  createComfyUiClient,
} from "../modules/imagine/public.ts";
import type {
  ComfyUiResolver,
  ComfyUiTransport,
} from "../modules/imagine/comfyui-client.ts";

const SETTINGS = {
  baseUrl: "http://comfy-fixture.internal:8000",
  requestTimeoutMs: 5_000,
  apiKey: "",
};

const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const loopbackResolver: ComfyUiResolver = async () => [{ address: "127.0.0.1", family: 4 }];

/** fetch 风格假响应 → transport seam 适配器。 */
function fakeTransport(handler: (url: string) => {
  status?: number;
  body: string | Uint8Array;
  headers?: Record<string, string>;
}): { resolver: ComfyUiResolver; transport: ComfyUiTransport } {
  return {
    resolver: loopbackResolver,
    transport: async (input) => {
      const result = handler(input.url.href);
      return {
        status: result.status ?? 200,
        headers: result.headers ?? {},
        body: (async function* () { yield Buffer.from(result.body); })(),
        cancel() {},
      };
    },
  };
}

function historyBody(status: string, images?: unknown) {
  return {
    "pid-1": {
      status: { status_str: status, completed: status === "success" },
      outputs: images
        ? { "9": { images } }
        : {},
    },
  };
}

test("history: pending / failed / ready 三态映射", async () => {
  const pending = createComfyUiClient(SETTINGS, fakeTransport(() => ({ body: "{}" })));
  assert.deepEqual(await pending.history("pid-1"), { status: "pending" });

  const failed = createComfyUiClient(SETTINGS, fakeTransport(() => ({
    body: JSON.stringify(historyBody("error")),
  })));
  assert.deepEqual(await failed.history("pid-1"), { status: "failed" });

  const ready = createComfyUiClient(SETTINGS, fakeTransport(() => ({
    body: JSON.stringify(historyBody("success", [
      { filename: "realm_out_00001_.png", subfolder: "", type: "output" },
    ])),
  })));
  const result = await ready.history("pid-1");
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.equal(result.image.filename, "realm_out_00001_.png");
});

test("history: 拒绝回显 promptId 注入与错误 body", async () => {
  const client = createComfyUiClient(SETTINGS, fakeTransport(() => ({
    status: 500,
    body: "internal node trace secret",
  })));
  await assert.rejects(client.history("pid-1"), (error: unknown) => {
    assert.ok(error instanceof ComfyUiError);
    assert.equal(error.code, "COMFYUI_REJECTED");
    assert.ok(!error.message.includes("secret"));
    assert.ok(!error.message.includes("comfy-fixture"));
    return true;
  });
  // promptId 注入（路径穿越形态）fail-closed。
  await assert.rejects(client.history("../escape"), (error: unknown) => {
    assert.ok(error instanceof ComfyUiError);
    return true;
  });
});

test("viewImage: 合法 PNG 通过；path traversal/超大/坏 magic 拒绝", async () => {
  const ok = createComfyUiClient(SETTINGS, fakeTransport((url) => {
    assert.ok(url.startsWith("http://comfy-fixture.internal:8000/view?"));
    return { body: new Uint8Array(TINY_PNG) };
  }));
  const image = await ok.viewImage({ filename: "a.png", subfolder: "", type: "output" });
  assert.equal(image.contentType, "image/png");
  assert.equal(image.data.length, TINY_PNG.length);

  for (const ref of [
    { filename: "../escape.png", subfolder: "", type: "output" },
    { filename: "a.png", subfolder: "../up", type: "output" },
    { filename: "/abs/path.png", subfolder: "", type: "output" },
  ]) {
    await assert.rejects(ok.viewImage(ref), (error: unknown) => {
      assert.ok(error instanceof ComfyUiError);
      assert.equal(error.code, "COMFYUI_INVALID_RESPONSE");
      return true;
    }, JSON.stringify(ref));
  }

  const huge = createComfyUiClient(SETTINGS, fakeTransport(() => ({
    body: new Uint8Array(8),
    headers: { "content-length": String(COMFYUI_IMAGE_MAX_BYTES + 1) },
  })));
  await assert.rejects(huge.viewImage({ filename: "a.png", subfolder: "", type: "output" }));

  const notImage = createComfyUiClient(SETTINGS, fakeTransport(() => ({
    body: new TextEncoder().encode("<html>not an image</html>"),
  })));
  await assert.rejects(
    notImage.viewImage({ filename: "a.png", subfolder: "", type: "output" }),
    (error: unknown) => {
      assert.ok(error instanceof ComfyUiError);
      assert.equal(error.code, "COMFYUI_INVALID_RESPONSE");
      return true;
    },
  );
});
