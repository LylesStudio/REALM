/**
 * 原生 ComfyUI client 测试（M7 收口版）。
 * 注入 transport/resolver 或真实 loopback server；绝不打真实网络/公网。
 * 钉住：成功解析、错误分类与脱敏、建连前地址校验（connect 前拒绝 +
 * transport 零调用）、连接 pinning、redirect fail-closed（ collector 零
 * 命中、Authorization/body 不外送）、总 deadline 覆盖挂起 body、JSON/图片
 * 流式上限（chunked/无 Content-Length 越界即中止）。
 */
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { ComfyUiError } from "../modules/imagine/public.ts";
import {
  COMFYUI_IMAGE_MAX_BYTES,
  COMFYUI_JSON_MAX_BYTES,
  createComfyUiClient,
  type ComfyUiResolver,
  type ComfyUiTransport,
} from "../modules/imagine/comfyui-client.ts";

const SETTINGS = {
  baseUrl: "http://comfy-fixture.internal:8000",
  requestTimeoutMs: 5_000,
  apiKey: "ck_fixture_secret",
};

/** 默认 fake resolver：fixture hostname 解析为 loopback（不打真实 DNS）。 */
const loopbackResolver: ComfyUiResolver = async () => [{ address: "127.0.0.1", family: 4 }];

function jsonTransport(payload: unknown, status = 200): ComfyUiTransport {
  return async () => ({
    status,
    headers: { "content-length": String(JSON.stringify(payload).length) },
    body: (async function* () { yield Buffer.from(JSON.stringify(payload)); })(),
    cancel() {},
  });
}

test("client: systemStats 成功返回延迟（transport 层钉住 header/URL/pinning lookup）", async () => {
  const seen: string[] = [];
  let capturedLookup: Parameters<ComfyUiTransport>[0]["lookup"] | null = null;
  const transport: ComfyUiTransport = async (input) => {
    seen.push(`${input.method} ${input.url.href}`);
    assert.equal(input.headers.Authorization, "Bearer ck_fixture_secret", "配置 key 时必须带 Authorization");
    capturedLookup = input.lookup;
    return {
      status: 200,
      headers: {},
      body: (async function* () { yield Buffer.from("{}"); })(),
      cancel() {},
    };
  };
  const client = createComfyUiClient(SETTINGS, { resolver: loopbackResolver, transport });
  const { latencyMs } = await client.systemStats();
  assert.ok(latencyMs >= 0);
  assert.deepEqual(seen, ["GET http://comfy-fixture.internal:8000/system_stats"]);
  // pinning：lookup 只回本次已验证的答案。
  assert.ok(capturedLookup);
  const pinned = await new Promise<{ address?: string; family?: number }>((resolvePromise, reject) => {
    capturedLookup!("comfy-fixture.internal", {}, (error, addressOrAddresses, family) => {
      if (error) return reject(error);
      // all 未设置 → 标量形状（dns.lookup 契约）。
      assert.equal(typeof addressOrAddresses, "string");
      resolvePromise({ address: addressOrAddresses as string, family });
    });
  });
  assert.equal(pinned.address, "127.0.0.1");
  assert.equal(pinned.family, 4);
});

test("client: queuePrompt 成功返回 promptId，body 只含 graph", async () => {
  let posted = "";
  const transport: ComfyUiTransport = async (input) => {
    assert.equal(input.url.href, "http://comfy-fixture.internal:8000/prompt");
    assert.equal(input.method, "POST");
    posted = String(input.body);
    return {
      status: 200,
      headers: {},
      body: (async function* () { yield Buffer.from(JSON.stringify({ prompt_id: "pid-fixture-1" })); })(),
      cancel() {},
    };
  };
  const client = createComfyUiClient({ ...SETTINGS, apiKey: "" }, { resolver: loopbackResolver, transport });
  const { promptId } = await client.queuePrompt({
    "9": { class_type: "SaveImage", inputs: { filename_prefix: "x" } },
  });
  assert.equal(promptId, "pid-fixture-1");
  const parsed = JSON.parse(posted);
  assert.ok(parsed.prompt["9"], "POST body 必须是 {prompt: graph}");
  assert.ok(!posted.includes("ck_fixture_secret"));
});

test("client: 非 2xx / 坏 JSON / 传输失败 / 超时的错误分类与脱敏", async () => {
  let cancelCount = 0;
  const rejected = createComfyUiClient(SETTINGS, {
    resolver: loopbackResolver,
    transport: async () => ({
      status: 400,
      headers: {},
      body: (async function* () { yield Buffer.from("secret internal node dump"); })(),
      cancel() { cancelCount += 1; },
    }),
  });
  await assert.rejects(rejected.systemStats(), (error: unknown) => {
    assert.ok(error instanceof ComfyUiError);
    assert.equal(error.code, "COMFYUI_REJECTED");
    assert.ok(!error.message.includes("secret internal"), "不得回显 provider body");
    assert.ok(!error.message.includes("comfy-fixture.internal"), "不得回显 URL");
    return true;
  });
  assert.equal(cancelCount, 1, "非 2xx 必须 cancel 响应流（不读错误 body）");

  const badJson = createComfyUiClient(SETTINGS, {
    resolver: loopbackResolver,
    transport: jsonTransport(null),
  });
  await assert.rejects(badJson.systemStats(), (error: unknown) => {
    assert.ok(error instanceof ComfyUiError && error.code === "COMFYUI_INVALID_RESPONSE");
    return true;
  });

  const down = createComfyUiClient(SETTINGS, {
    resolver: loopbackResolver,
    transport: async () => {
      throw new Error("connect ECONNREFUSED http://comfy-fixture.internal:8000");
    },
  });
  await assert.rejects(down.systemStats(), (error: unknown) => {
    assert.ok(error instanceof ComfyUiError && error.code === "COMFYUI_UNREACHABLE");
    assert.ok(!error.message.includes("comfy-fixture.internal"));
    return true;
  });

  // body 挂起（headers 已到、body 永不产出）也受总 deadline 约束。
  const hangingBody = createComfyUiClient(
    { ...SETTINGS, requestTimeoutMs: 50 },
    {
      resolver: loopbackResolver,
      transport: async (input) => ({
        status: 200,
        headers: {},
        body: (async function* () {
          await new Promise((_, reject) => {
            input.signal.addEventListener("abort", () => reject(new Error("aborted")));
          });
          yield Buffer.from(""); // 不可达；仅满足 require-yield
        })(),
        cancel() {},
      }),
    },
  );
  await assert.rejects(hangingBody.systemStats(), (error: unknown) => {
    assert.ok(error instanceof ComfyUiError && error.code === "COMFYUI_TIMEOUT",
      "body 挂起必须归 COMFYUI_TIMEOUT（总 deadline 覆盖 body 消费）");
    return true;
  });
});

test("client: 建连前地址校验——公网/混合/空答案/解析失败一律 connect 前拒绝", async () => {
  let transportCalls = 0;
  const spyTransport: ComfyUiTransport = async () => {
    transportCalls += 1;
    throw new Error("transport must not be called");
  };
  const cases: Array<{ name: string; resolver: ComfyUiResolver }> = [
    { name: "纯公网", resolver: async () => [{ address: "8.8.8.8", family: 4 }] },
    { name: "混合公私", resolver: async () => [{ address: "127.0.0.1", family: 4 }, { address: "8.8.8.8", family: 4 }] },
    { name: "link-local", resolver: async () => [{ address: "169.254.169.254", family: 4 }] },
    { name: "mapped 公网", resolver: async () => [{ address: "::ffff:8.8.8.8", family: 6 }] },
    { name: "空答案", resolver: async () => [] },
    {
      name: "解析失败",
      resolver: async () => {
        throw new Error("ENOTFOUND comfy-fixture.internal");
      },
    },
  ];
  for (const entry of cases) {
    const client = createComfyUiClient(SETTINGS, { resolver: entry.resolver, transport: spyTransport });
    await assert.rejects(client.systemStats(), (error: unknown) => {
      assert.ok(error instanceof ComfyUiError && error.code === "COMFYUI_UNREACHABLE", entry.name);
      assert.ok(!error.message.includes("8.8.8.8"), `${entry.name}：错误不得含地址`);
      return true;
    });
  }
  assert.equal(transportCalls, 0, "任何越类答案都必须 connect 前拒绝（transport 零调用）");
});

test("client: IP literal 不经 DNS 直接分类 pinning；公网 literal 拒绝", async () => {
  let resolverCalls = 0;
  const resolver: ComfyUiResolver = async () => {
    resolverCalls += 1;
    return [{ address: "127.0.0.1", family: 4 }];
  };
  let capturedLookup: Parameters<ComfyUiTransport>[0]["lookup"] | null = null;
  const transport: ComfyUiTransport = async (input) => {
    capturedLookup = input.lookup;
    return {
      status: 200,
      headers: {},
      body: (async function* () { yield Buffer.from("{}"); })(),
      cancel() {},
    };
  };
  const client = createComfyUiClient(
    { baseUrl: "http://127.0.0.1:8188", requestTimeoutMs: 5_000, apiKey: "" },
    { resolver, transport },
  );
  await client.systemStats();
  assert.equal(resolverCalls, 0, "IP literal 不得走 DNS resolver");
  const pinned = await new Promise<{ address?: string }>((resolvePromise, reject) => {
    capturedLookup!("ignored", {}, (error, addressOrAddresses) => {
      if (error) return reject(error);
      assert.equal(typeof addressOrAddresses, "string");
      resolvePromise({ address: addressOrAddresses as string });
    });
  });
  assert.equal(pinned.address, "127.0.0.1", "lookup 必须 pin 到已验证 literal");

  const blocked = createComfyUiClient(
    { baseUrl: "http://8.8.8.8:8188", requestTimeoutMs: 5_000, apiKey: "" },
    { resolver, transport },
  );
  await assert.rejects(blocked.systemStats(), (error: unknown) => {
    assert.ok(error instanceof ComfyUiError && error.code === "COMFYUI_UNREACHABLE");
    return true;
  });
});

test("client: redirect fail-closed——collector 零命中，Authorization/prompt body 不外送", async (t) => {
  const collectorHits: http.IncomingMessage[] = [];
  const collector = http.createServer((request, response) => {
    collectorHits.push(request);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end("{}");
  });
  await new Promise<void>((resolveListen) => collector.listen(0, "127.0.0.1", resolveListen));
  const collectorPort = (collector.address() as { port: number }).port;
  const redirectorSeenAuth: Array<string | undefined> = [];
  const redirector = http.createServer((request, response) => {
    redirectorSeenAuth.push(request.headers.authorization);
    const status = request.method === "POST" ? 307 : 302;
    response.writeHead(status, { location: `http://127.0.0.1:${collectorPort}/` });
    response.end();
  });
  await new Promise<void>((resolveListen) => redirector.listen(0, "127.0.0.1", resolveListen));
  t.after(async () => {
    await new Promise((resolveClose) => redirector.close(resolveClose));
    await new Promise((resolveClose) => collector.close(resolveClose));
  });
  // 真实默认 transport（node:http），baseUrl 指向 redirector。
  const client = createComfyUiClient({
    baseUrl: `http://127.0.0.1:${(redirector.address() as { port: number }).port}`,
    requestTimeoutMs: 5_000,
    apiKey: "ck_fixture_secret",
  });
  await assert.rejects(client.systemStats(), (error: unknown) => {
    assert.ok(error instanceof ComfyUiError && error.code === "COMFYUI_REJECTED", "302 必须 fail-closed");
    return true;
  });
  await assert.rejects(client.queuePrompt({ "9": { class_type: "SaveImage", inputs: {} } }), (error: unknown) => {
    assert.ok(error instanceof ComfyUiError && error.code === "COMFYUI_REJECTED", "307 必须 fail-closed");
    return true;
  });
  assert.equal(collectorHits.length, 0, "redirect 目标不得收到任何请求（body/key 不外送）");
  assert.ok(redirectorSeenAuth.every((value) => value === "Bearer ck_fixture_secret"),
    "原始请求仍携带 key；collector 零命中即 key 未离开原始目标");
});

test("client: 总 deadline 覆盖挂起 body（真实 loopback server）", async (t) => {
  let sawClose = false;
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.flushHeaders();
    request.socket.on("close", () => { sawClose = true; });
    // body 永不产出。
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  t.after(async () => {
    await new Promise((resolveClose) => server.close(resolveClose));
  });
  const client = createComfyUiClient({
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    requestTimeoutMs: 150,
    apiKey: "",
  });
  await assert.rejects(client.systemStats(), (error: unknown) => {
    assert.ok(error instanceof ComfyUiError && error.code === "COMFYUI_TIMEOUT");
    return true;
  });
  assert.equal(sawClose, true, "超时必须销毁连接（server 侧 socket close）");
});

test("client: 流式上限——无 Content-Length/chunked 越界即中止，不先完整载入", async () => {
  // 图片：无 CL，chunked 无限产出；越界必须 cancel 且 producer 被停掉。
  let cancelled = false;
  let produced = 0;
  const hugeImage = createComfyUiClient(SETTINGS, {
    resolver: loopbackResolver,
    transport: async () => ({
      status: 200,
      headers: {},
      body: (async function* () {
        while (!cancelled) {
          produced += 1;
          yield Buffer.alloc(1024 * 1024, 0x89);
        }
      })(),
      cancel() { cancelled = true; },
    }),
  });
  await assert.rejects(
    hugeImage.viewImage({ filename: "a.png", subfolder: "", type: "output" }),
    (error: unknown) => {
      assert.ok(error instanceof ComfyUiError && error.code === "COMFYUI_INVALID_RESPONSE");
      return true;
    },
  );
  assert.equal(cancelled, true, "越界必须 cancel 响应流");
  assert.ok(produced * 1024 * 1024 <= COMFYUI_IMAGE_MAX_BYTES + 1024 * 1024,
    "producer 必须在越界后立即停止（不得完整载入）");

  // JSON：>1MiB 即拒（流式上限同样生效）。
  let jsonCancelled = false;
  const hugeJson = createComfyUiClient(SETTINGS, {
    resolver: loopbackResolver,
    transport: async () => ({
      status: 200,
      headers: {},
      body: (async function* () {
        yield Buffer.alloc(COMFYUI_JSON_MAX_BYTES, 0x20);
        yield Buffer.from("{}");
      })(),
      cancel() { jsonCancelled = true; },
    }),
  });
  await assert.rejects(hugeJson.systemStats(), (error: unknown) => {
    assert.ok(error instanceof ComfyUiError && error.code === "COMFYUI_INVALID_RESPONSE");
    return true;
  });
  assert.equal(jsonCancelled, true);

  // 已声明 CL 超限：不读 body 直接拒。
  let declaredBodyRead = false;
  const declaredHuge = createComfyUiClient(SETTINGS, {
    resolver: loopbackResolver,
    transport: async () => ({
      status: 200,
      headers: { "content-length": String(COMFYUI_IMAGE_MAX_BYTES + 1) },
      body: (async function* () {
        declaredBodyRead = true;
        yield Buffer.from("x");
      })(),
      cancel() {},
    }),
  });
  await assert.rejects(
    declaredHuge.viewImage({ filename: "a.png", subfolder: "", type: "output" }),
    (error: unknown) => {
      assert.ok(error instanceof ComfyUiError && error.code === "COMFYUI_INVALID_RESPONSE");
      return true;
    },
  );
  assert.equal(declaredBodyRead, false, "CL 超限不得读 body");
});

test("client: 默认 node transport + 注入 resolver——hostname 解析并 pin 到 loopback（Node lookup all=true 契约回归）", async (t) => {
  // 回归：Node v22 的 http.request 调 custom lookup 时传 options.all=true，
  // callback 必须回地址对象数组（dns.lookup 官方契约）；标量形状会得到
  // ERR_INVALID_IP_ADDRESS。fixture.invalid 永不真实解析，resolver 注入
  // 127.0.0.1；不打公网。
  const seenHosts: Array<string | undefined> = [];
  const seenRemote: string[] = [];
  const server = http.createServer((request, response) => {
    seenHosts.push(request.headers.host);
    seenRemote.push(request.socket.remoteAddress ?? "");
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end("{}");
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  t.after(async () => {
    server.close();
    server.closeAllConnections();
  });
  const client = createComfyUiClient(
    {
      baseUrl: `http://fixture.invalid:${(server.address() as { port: number }).port}`,
      requestTimeoutMs: 2_000,
      apiKey: "",
    },
    // 无 transport 注入 = 真实 node:http 生产 transport。
    { resolver: async () => [{ address: "127.0.0.1", family: 4 }] },
  );
  const result = await client.systemStats();
  assert.ok(result.latencyMs >= 0, "注入 resolver 的 hostname 必须经默认 transport 成功连接");
  assert.equal(seenRemote[0], "127.0.0.1", "连接必须 pin 到已验证的 loopback 地址");
  assert.ok(seenHosts[0]?.startsWith("fixture.invalid:"), "Host 头保持原始 hostname（pinning 不改写 host）");
});

test("client: resolver 永不 settle 时 deadline 内 reject COMFYUI_TIMEOUT，迟到解析不得启动 transport", { timeout: 10_000 }, async () => {
  // 回归：deadline 只 abort controller，但 DNS await 未与 AbortSignal 竞争——
  // 永不返回的 resolver 会让调用方挂死。修复后必须在 deadline 内 reject，
  // 且迟到/永不返回的 resolver 结果不得启动 socket/transport。
  let transportCalls = 0;
  const spyTransport: ComfyUiTransport = async () => {
    transportCalls += 1;
    return {
      status: 200,
      headers: {},
      body: (async function* () { yield Buffer.from("{}"); })(),
      cancel() {},
    };
  };
  const hanging = createComfyUiClient(
    { ...SETTINGS, requestTimeoutMs: 25 },
    {
      resolver: () => new Promise<readonly { address: string; family: 4 | 6 }[]>(() => {}),
      transport: spyTransport,
    },
  );
  const startedAt = Date.now();
  await assert.rejects(hanging.systemStats(), (error: unknown) => {
    assert.ok(error instanceof ComfyUiError && error.code === "COMFYUI_TIMEOUT",
      "resolver 挂起必须在 deadline 内归 COMFYUI_TIMEOUT");
    return true;
  });
  assert.ok(Date.now() - startedAt < 1_000, "必须在 deadline 附近 reject，不得挂死");
  assert.equal(transportCalls, 0, "resolver 未返回前不得启动 transport");

  // 迟到 settle 的 resolver：resolve 发生在 deadline 之后，同样不得启动 transport。
  let lateResolve!: (answers: readonly { address: string; family: 4 | 6 }[]) => void;
  const late = createComfyUiClient(
    { ...SETTINGS, requestTimeoutMs: 25 },
    {
      resolver: () => new Promise((resolvePromise) => { lateResolve = resolvePromise; }),
      transport: spyTransport,
    },
  );
  await assert.rejects(late.systemStats(), (error: unknown) => {
    assert.ok(error instanceof ComfyUiError && error.code === "COMFYUI_TIMEOUT");
    return true;
  });
  lateResolve([{ address: "127.0.0.1", family: 4 }]);
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  assert.equal(transportCalls, 0, "deadline 后迟到的解析结果不得启动 transport");
});
