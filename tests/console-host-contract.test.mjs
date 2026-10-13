/**
 * 跨平台服务控制台（launcher/realm-console.mjs）契约：
 * - redactLogLine/readLogTail：日志尾部读取 + 凭据形态 [REDACTED]
 *   （URL userinfo、key=value 敏感键、连接串参数；普通行原样保留）；
 * - applyHostFrame：service-host JSON-lines 帧 → 控制台状态机
 *   （与 Rust 侧 ServicePhase 迁移一致：ready 后 step 帧不回退）；
 * - createServiceController：复用 realm-service-host.mjs 子进程协议，
 *   不另起服务管理语义；stop 发 SIGTERM，close 默认随控制台停服务；
 * - createConsoleServer：loopback HTTP 控制面（UI 静态托管 + REST/SSE），
 *   错误统一 JSON，LauncherError → 409。
 *
 * 网络绑定在本机沙箱被禁（EPERM）时按仓库惯例跳过进程级用例——
 * 与 tests/tauri-service-host.test.mjs 的无 PG skip 同一模式，CI 真跑。
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  applyHostFrame,
  consoleUiPath,
  createConsoleRequestHandler,
  createConsoleServer,
  createServiceController,
  readLogTail,
  redactLogLine,
} from "../launcher/realm-console.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

test("redactLogLine hides url userinfo, sensitive key/value pairs and conninfo params", () => {
  assert.equal(
    redactLogLine("conn postgresql://alice:hunter2@127.0.0.1:55432/realm_dev ok"),
    "conn postgresql://[REDACTED]@127.0.0.1:55432/realm_dev ok",
  );
  assert.equal(
    redactLogLine('password="hunter2" api_key=abcdef token: xyz secret=shh'),
    "password=[REDACTED] api_key=[REDACTED] token: [REDACTED] secret=[REDACTED]",
  );
  assert.equal(
    redactLogLine("pg_ctl -o '-c password=abc' -o sslkey='key.pem'"),
    "pg_ctl -o '-c password=[REDACTED]' -o sslkey=[REDACTED]",
  );
  // 普通诊断行原样保留（redact 不得破坏常规日志可读性）。
  assert.equal(
    redactLogLine("step: ready url=http://127.0.0.1:9999/"),
    "step: ready url=http://127.0.0.1:9999/",
  );
  assert.equal(redactLogLine(""), "");
  assert.equal(redactLogLine(null), "");
});

test("readLogTail returns the last N lines redacted; missing file yields no lines", async () => {
  const dir = await mkdtemp(join(tmpdir(), "realm-console-logs-"));
  try {
    const logFile = join(dir, "launcher.log");
    await writeFile(
      logFile,
      ["line 1", "line 2 password=hunter2", "line 3", "line 4", ""].join("\n"),
    );
    assert.deepEqual(readLogTail(logFile, 2), [
      "line 3",
      "line 4",
    ]);
    assert.deepEqual(readLogTail(logFile, 10), [
      "line 1",
      "line 2 password=[REDACTED]",
      "line 3",
      "line 4",
    ]);
    // 行数上限防御：请求过大时收敛到内部上限，不整读大文件之外的内容。
    assert.equal(readLogTail(logFile, 0).length, 4, "非法行数回退默认 200");
    assert.deepEqual(readLogTail(join(dir, "missing.log")), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("applyHostFrame mirrors the Tauri state machine", () => {
  const idle = { phase: "idle" };
  const starting = applyHostFrame(idle, { type: "step", step: "postgres" });
  assert.deepEqual(starting, { phase: "starting", step: "postgres" });
  const ready = applyHostFrame(starting, {
    type: "ready",
    url: "http://127.0.0.1:9999/",
    advertisedOrigin: null,
  });
  assert.deepEqual(ready, {
    phase: "ready",
    url: "http://127.0.0.1:9999/",
    advertisedOrigin: null,
  });
  // ready 之后 step 帧不回退状态（幂等步骤事件）。
  assert.equal(
    applyHostFrame(ready, { type: "step", step: "health" }),
    ready,
  );
  assert.deepEqual(applyHostFrame(ready, { type: "stopping" }), { phase: "stopping" });
  assert.deepEqual(
    applyHostFrame({ phase: "stopping" }, { type: "stopped" }),
    { phase: "stopped" },
  );
  assert.deepEqual(
    applyHostFrame(idle, { type: "error", kind: "already-running", message: "x" }),
    { phase: "failed", kind: "already-running", message: "x" },
  );
  // 未知/坏帧不改变状态。
  assert.equal(applyHostFrame(idle, { type: "worker", state: "starting" }), idle);
  assert.equal(applyHostFrame(idle, null), idle);
});

function fakeServiceHostChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.signals = [];
  child.kill = (signal) => {
    child.signals.push(signal);
    child.emit("exit", 0, signal);
  };
  return child;
}

test("service controller drives the service-host child protocol and default close stops the service", async () => {
  const children = [];
  const controller = createServiceController({
    home: projectRoot,
    dataHome: join(tmpdir(), "realm-console-controller-test"),
    environment: { PATH: "/usr/bin", OPENAI_API_KEY: "must-not-cross" },
    spawnImpl: () => {
      const child = fakeServiceHostChild();
      children.push(child);
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
  });
  assert.deepEqual(controller.state(), { phase: "idle" });
  await controller.start();
  assert.equal(controller.state().phase, "starting");
  children[0].stdout.emit("data", '{"type":"step","step":"postgres"}\n');
  assert.deepEqual(controller.state(), { phase: "starting", step: "postgres" });
  children[0].stdout.emit(
    "data",
    '{"type":"ready","url":"http://127.0.0.1:9999/","advertisedOrigin":null}\n',
  );
  assert.equal(controller.state().phase, "ready");
  assert.equal(controller.state().url, "http://127.0.0.1:9999/");
  // 重复 start 必须被拒绝（单一管理面）。
  await assert.rejects(() => controller.start(), /already running/);
  // stop → SIGTERM → stopped。
  await controller.stop();
  assert.deepEqual(children[0].signals, ["SIGTERM"]);
  assert.deepEqual(controller.state(), { phase: "stopped" });
  // 意外退出：ready 后子进程死亡 → failed(exited)。
  await controller.start();
  children[1].emit("exit", 1, null);
  assert.equal(controller.state().phase, "failed");
  assert.equal(controller.state().kind, "exited");
  // 默认 close：idle/无子进程时无副作用；stopOnClose=false 时保留服务。
  await controller.close();
  assert.equal(children.length, 2, "close 不得隐式重启服务");
  controller.setConfig({ stopOnClose: false });
  await controller.start();
  await controller.close();
  assert.equal(children.length, 3, "keep-running 时 close 不停止服务");
  assert.notEqual(controller.state().phase, "stopped");
});

// 无 socket 的路由级契约：fake req/res 直接驱动处理器（沙箱可跑）。
function fakeRequest({ method = "GET", url = "/", body = null, headers = {} } = {}) {
  const request = new EventEmitter();
  request.method = method;
  request.url = url;
  request.headers = { host: "127.0.0.1", ...headers };
  request[Symbol.asyncIterator] = async function* iterate() {
    if (body !== null) yield Buffer.from(body);
  };
  return request;
}

function fakeResponse(request) {
  const response = new EventEmitter();
  response.statusCode = 0;
  response.headers = {};
  response.body = "";
  response.writes = [];
  response.writeHead = (status, headers) => {
    response.statusCode = status;
    response.headers = headers;
    return response;
  };
  response.write = (chunk) => {
    response.writes.push(String(chunk));
    response.body += String(chunk);
    return true;
  };
  response.end = (chunk) => {
    if (chunk !== undefined) response.write(chunk);
    response.emit("finished");
    request.emit("close");
  };
  return response;
}

async function drive(handler, requestOptions) {
  const request = fakeRequest(requestOptions);
  const response = fakeResponse(request);
  const done = new Promise((resolve) => response.once("finished", resolve));
  await handler(request, response);
  await done;
  return response;
}

function consoleStub() {
  const calls = [];
  const states = [{ phase: "idle" }];
  return {
    calls,
    stub: {
      state: () => states.at(-1),
      start: () => { calls.push("start"); states.push({ phase: "starting", step: "spawn" }); },
      stop: () => { calls.push("stop"); states.push({ phase: "stopped" }); },
      restart: () => { calls.push("restart"); states.push({ phase: "starting", step: "spawn" }); },
      openBrowser: () => { calls.push("open-browser"); },
      logs: ({ lines } = {}) => [`log-line-${lines}`],
      config: () => ({ stopOnClose: true }),
      setConfig: (body) => ({ stopOnClose: body?.stopOnClose === true }),
      onChange: () => {},
    },
  };
}

test("console request handler serves UI, state, control, logs and config (no socket)", async () => {
  const { calls, stub } = consoleStub();
  const handler = createConsoleRequestHandler({ controller: stub, html: "<html>console</html>" });

  const home = await drive(handler, { url: "/" });
  assert.equal(home.statusCode, 200);
  assert.match(home.headers["content-type"], /text\/html/);
  assert.equal(home.body, "<html>console</html>");

  const state = await drive(handler, { url: "/api/state" });
  assert.deepEqual(JSON.parse(state.body), { phase: "idle" });

  const started = await drive(handler, { method: "POST", url: "/api/start" });
  assert.equal(started.statusCode, 200);
  assert.deepEqual(JSON.parse(started.body), { phase: "starting", step: "spawn" });

  await drive(handler, { method: "POST", url: "/api/restart" });
  await drive(handler, { method: "POST", url: "/api/stop" });
  await drive(handler, { method: "POST", url: "/api/open-browser" });
  assert.deepEqual(calls, ["start", "restart", "stop", "open-browser"]);

  const logs = await drive(handler, { url: "/api/logs?lines=7" });
  assert.deepEqual(JSON.parse(logs.body), { lines: ["log-line-7"] });

  const config = await drive(handler, { url: "/api/config" });
  assert.deepEqual(JSON.parse(config.body), { stopOnClose: true });
  const updated = await drive(handler, {
    method: "POST",
    url: "/api/config",
    body: JSON.stringify({ stopOnClose: false }),
    headers: { "content-type": "application/json" },
  });
  assert.deepEqual(JSON.parse(updated.body), { stopOnClose: false });

  // SSE 连接保持打开（不 end）：只等待首个事件帧即可断言。
  const eventsRequest = fakeRequest({ url: "/api/events" });
  const eventsResponse = fakeResponse(eventsRequest);
  await handler(eventsRequest, eventsResponse);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(eventsResponse.statusCode, 200);
  assert.match(eventsResponse.headers["content-type"], /text\/event-stream/);
  assert.match(eventsResponse.writes[0], /^data: /);

  const missing = await drive(handler, { url: "/api/nope" });
  assert.equal(missing.statusCode, 404);
  assert.equal(JSON.parse(missing.body).error, "not found");
  const wrongMethod = await drive(handler, { method: "DELETE", url: "/api/state" });
  assert.equal(wrongMethod.statusCode, 404);
});

test("console request handler maps controller conflicts to 409 and failures to 500 JSON", async () => {
  const { LauncherError } = await import("../launcher/realm-console.mjs").then(() => import("../launcher/realm-launcher.mjs"));
  const conflicting = {
    state: () => ({ phase: "ready", url: "http://127.0.0.1:9999/" }),
    start: () => { throw new LauncherError("service is already running or starting"); },
    stop: () => {},
    restart: () => {},
    openBrowser: () => {},
    logs: () => [],
    config: () => ({}),
    setConfig: () => ({}),
    onChange: () => {},
  };
  const handler = createConsoleRequestHandler({ controller: conflicting, uiHtml: "x" });
  const response = await drive(handler, { method: "POST", url: "/api/start" });
  assert.equal(response.statusCode, 409);
  assert.match(JSON.parse(response.body).error, /already running/);

  const broken = { ...conflicting, start: () => { throw new Error("boom"); } };
  const brokenHandler = createConsoleRequestHandler({ controller: broken, uiHtml: "x" });
  const brokenResponse = await drive(brokenHandler, { method: "POST", url: "/api/start" });
  assert.equal(brokenResponse.statusCode, 500);
  assert.equal(JSON.parse(brokenResponse.body).error, "boom");
});

/** 沙箱禁 bind（EPERM）时返回 null，调用方 skip（与无 PG skip 同模式）。 */
async function tryListenConsole(serverOptions) {
  try {
    return await createConsoleServer(serverOptions);
  } catch (error) {
    if (error?.code === "EPERM" || /not permitted/i.test(String(error?.message))) {
      return null;
    }
    throw error;
  }
}

test("console server exposes UI, state, control, logs and config over loopback HTTP only", async (t) => {
  const calls = [];
  const states = [{ phase: "idle" }];
  const stub = {
    state: () => states.at(-1),
    start: () => { calls.push("start"); states.push({ phase: "starting", step: "spawn" }); },
    stop: () => { calls.push("stop"); states.push({ phase: "stopped" }); },
    restart: () => { calls.push("restart"); states.push({ phase: "starting", step: "spawn" }); },
    openBrowser: () => { calls.push("open-browser"); },
    logs: ({ lines } = {}) => [`log-line-${lines}`],
    config: () => ({ stopOnClose: true }),
    setConfig: (body) => ({ stopOnClose: body?.stopOnClose === true }),
    onChange: () => {},
  };
  const httpConsole = await tryListenConsole({
    controller: stub,
    uiHtml: "<html>console</html>",
  });
  if (!httpConsole) {
    t.skip("loopback bind is not permitted in this sandbox");
    return;
  }
  try {
    assert.equal(httpConsole.host, "127.0.0.1", "控制台只绑 loopback");
    assert.ok(httpConsole.port > 0);

    const home = await fetch(httpConsole.url);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /console/);

    const state = await fetch(`${httpConsole.url}api/state`).then((r) => r.json());
    assert.deepEqual(state, { phase: "idle" });

    const started = await fetch(`${httpConsole.url}api/start`, { method: "POST" });
    assert.equal(started.status, 200);
    assert.deepEqual(await started.json(), { phase: "starting", step: "spawn" });
    assert.ok(calls.includes("start"));

    await fetch(`${httpConsole.url}api/restart`, { method: "POST" });
    await fetch(`${httpConsole.url}api/stop`, { method: "POST" });
    await fetch(`${httpConsole.url}api/open-browser`, { method: "POST" });
    assert.deepEqual(calls, ["start", "restart", "stop", "open-browser"]);

    const logs = await fetch(`${httpConsole.url}api/logs?lines=7`).then((r) => r.json());
    assert.deepEqual(logs, { lines: ["log-line-7"] });

    const config = await fetch(`${httpConsole.url}api/config`).then((r) => r.json());
    assert.deepEqual(config, { stopOnClose: true });
    const updated = await fetch(`${httpConsole.url}api/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stopOnClose: false }),
    }).then((r) => r.json());
    assert.deepEqual(updated, { stopOnClose: false });

    const events = await fetch(`${httpConsole.url}api/events`);
    assert.match(events.headers.get("content-type"), /text\/event-stream/);
    events.body.cancel();

    const missing = await fetch(`${httpConsole.url}api/nope`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, "not found");
  } finally {
    await httpConsole.close();
  }
});

test("console server maps controller conflicts to 409 JSON errors", async (t) => {
  const { LauncherError } = await import("../launcher/realm-launcher.mjs");
  const stub = {
    state: () => ({ phase: "ready", url: "http://127.0.0.1:9999/" }),
    start: () => { throw new LauncherError("service is already running or starting"); },
    stop: () => {},
    restart: () => {},
    openBrowser: () => {},
    logs: () => [],
    config: () => ({}),
    setConfig: () => ({}),
    onChange: () => {},
  };
  const httpConsole = await tryListenConsole({ controller: stub, uiHtml: "x" });
  if (!httpConsole) {
    t.skip("loopback bind is not permitted in this sandbox");
    return;
  }
  try {
    const response = await fetch(`${httpConsole.url}api/start`, { method: "POST" });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /already running/);
  } finally {
    await httpConsole.close();
  }
});

test("console UI html is served by the console host and supports the HTTP fallback", () => {
  const uiPath = consoleUiPath(join(projectRoot, "launcher"));
  const uiHtml = readFileSync(uiPath, "utf8");
  // Tauri 与浏览器控制台同源复用：__TAURI__ 缺失时回落 HTTP API。
  assert.match(uiHtml, /window\.__TAURI__/);
  assert.match(uiHtml, /\/api\/state/);
  assert.match(uiHtml, /\/api\/start/);
  assert.match(uiHtml, /\/api\/restart/);
  assert.match(uiHtml, /\/api\/open-browser/);
  assert.match(uiHtml, /\/api\/logs/);
  assert.match(uiHtml, /EventSource\("\/api\/events"\)/);
  // 控制台必备能力：状态、URL、开始/停止/重启、打开浏览器、日志。
  for (const text of ["打开客户端", "打开网页", "重启服务", "查看日志", "停止服务并退出"]) {
    assert.ok(uiHtml.includes(text), `console UI missing: ${text}`);
  }
  // 关闭控制台默认停止服务（UI 设置 + beforeunload 确认）。
  assert.match(uiHtml, /stop-on-close/);
  assert.match(uiHtml, /beforeunload/);
  // 渲染安全约定不回归：无 innerHTML 注入。
  assert.doesNotMatch(uiHtml, /\binnerHTML\s*=/);
});

import { readFileSync } from "node:fs";
