/**
 * scene-image-worker-host（跨平台 supervisor）单元测试：fake spawn 注入。
 *
 * 覆盖：spawn 参数与 strip-types、子环境白名单脱敏（provider key/token/
 * 连接串绝不透传出白名单）、缺连接串不启动、单实例（重复 start no-op）、
 * 意外退出传播（unavailable/exit）、优雅停止（unix SIGTERM / Windows
 * kill 分支、幂等）、日志隔离文件无敏感值。
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createSceneImageWorkerHost } from "../launcher/scene-image-worker-host.mjs";

function makeFakeChild(pid = 4242) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = pid;
  child.killSignals = [];
  child.kill = (signal) => {
    child.killSignals.push(signal ?? "SIGTERM-default");
    return true;
  };
  child.emitExit = (code, signal = null) => {
    child.stdout.end();
    child.stderr.end();
    child.emit("exit", code, signal);
  };
  return child;
}

function makeHarness(t, options = {}) {
  const dataHome = mkdtempSync(join(tmpdir(), "realm-worker-host-"));
  t.after(() => rmSync(dataHome, { recursive: true, force: true }));
  const spawns = [];
  const children = [];
  const states = [];
  const fakeSpawn = (command, args, spawnOptions) => {
    spawns.push({ command, args, spawnOptions });
    const child = makeFakeChild(4242 + children.length);
    children.push(child);
    return child;
  };
  const host = createSceneImageWorkerHost({
    dataHome,
    spawn: fakeSpawn,
    stopTimeoutMs: 50,
    onState: (frame) => states.push(frame),
    parentEnv: {
      PATH: "/usr/bin",
      COMFYUI_API_KEY: "secret-provider-key",
      REALM_ACCESS_TOKEN: "secret-token",
      DATABASE_URL: "postgresql://postgres@127.0.0.1:55432/realm_local",
    },
    environment: {
      REALM_RUNTIME_DATABASE_URL: "postgresql://realm_runtime@127.0.0.1:55432/realm_local",
      REALM_SCENE_IMAGE_WORKSPACES: "ws_demo",
    },
    ...options,
  });
  return { host, spawns, children, states, dataHome };
}

test("start：spawn 参数 + 子环境白名单脱敏", (t) => {
  const { host, spawns } = makeHarness(t);
  assert.equal(host.start(), true);
  assert.equal(spawns.length, 1);
  const { command, args, spawnOptions } = spawns[0];
  assert.equal(command, process.execPath);
  assert.deepEqual(args.slice(0, 1), ["--experimental-strip-types"]);
  assert.match(args[1], /scripts[/\\]scene-image-worker\.mjs$/);
  const env = spawnOptions.env;
  // 注入的运行必需键。
  assert.equal(
    env.REALM_RUNTIME_DATABASE_URL,
    "postgresql://realm_runtime@127.0.0.1:55432/realm_local",
  );
  assert.equal(env.REALM_SCENE_IMAGE_WORKSPACES, "ws_demo");
  assert.ok(typeof env.REALM_DATA_HOME === "string" && env.REALM_DATA_HOME.length > 0);
  // 白名单外敏感键绝不透传。
  assert.equal(env.COMFYUI_API_KEY, undefined);
  assert.equal(env.REALM_ACCESS_TOKEN, undefined);
  assert.equal(env.DATABASE_URL, undefined);
  // 白名单内非敏感键透传。
  assert.equal(env.PATH, "/usr/bin");
  // Windows 下不弹控制台窗口。
  assert.equal(spawnOptions.windowsHide, true);
});

test("缺 REALM_RUNTIME_DATABASE_URL：不 spawn，上报 not_configured", (t) => {
  const dataHome = mkdtempSync(join(tmpdir(), "realm-worker-host-"));
  t.after(() => rmSync(dataHome, { recursive: true, force: true }));
  const states = [];
  let spawnCount = 0;
  const host = createSceneImageWorkerHost({
    dataHome,
    spawn: () => {
      spawnCount += 1;
      return makeFakeChild();
    },
    onState: (frame) => states.push(frame),
    environment: {},
  });
  assert.equal(host.start(), false);
  assert.equal(spawnCount, 0);
  assert.deepEqual(states, [{ state: "unavailable", reason: "not_configured" }]);
});

test("单实例：重复 start 是 no-op；意外退出传播 unavailable/exit", async (t) => {
  const { host, spawns, children, states } = makeHarness(t);
  assert.equal(host.start(), true);
  assert.equal(host.start(), false, "重复 start 不得再次 spawn");
  assert.equal(spawns.length, 1);
  assert.deepEqual(states[0], { state: "starting" });
  // 意外退出（非 stop）：传播 unavailable。
  children[0].emitExit(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(states.at(-1), { state: "unavailable", reason: "exit" });
  assert.equal(host.isRunning(), false);
});

test("优雅停止（unix）：SIGTERM → stopped；幂等", async (t) => {
  const { host, children, states } = makeHarness(t, { platform: "linux" });
  host.start();
  const child = children[0];
  const stopping = host.stop();
  assert.deepEqual(child.killSignals, ["SIGTERM"]);
  child.emitExit(0, "SIGTERM");
  await stopping;
  await host.stop();
  assert.deepEqual(child.killSignals, ["SIGTERM"], "重复 stop 不得再次 kill");
  assert.deepEqual(states.at(-1), { state: "stopped" });
});

test("优雅停止（Windows）：child.kill() 默认信号分支", async (t) => {
  const { host, children } = makeHarness(t, { platform: "win32" });
  host.start();
  const child = children[0];
  const stopping = host.stop();
  assert.deepEqual(child.killSignals, ["SIGTERM-default"], "Windows 走无参 kill");
  child.emitExit(0);
  await stopping;
});

test("stop 超时强杀（unix SIGKILL）", async (t) => {
  const { host, children } = makeHarness(t, { platform: "linux" });
  host.start();
  const child = children[0];
  const stopping = host.stop();
  // 不响应 SIGTERM：等 stopTimeoutMs(50ms) 后强杀。
  await new Promise((resolve) => setTimeout(resolve, 200));
  child.emitExit(137, "SIGKILL");
  await stopping;
  assert.deepEqual(child.killSignals, ["SIGTERM", "SIGKILL"]);
});

test("日志隔离：worker 输出与 supervisor 行写入独立 log，无敏感值", async (t) => {
  const { host, children, dataHome } = makeHarness(t);
  host.start();
  const child = children[0];
  child.stdout.write("[scene-image-worker] advisory lock acquired\n");
  child.stdout.write("[scene-image-worker] request failed permanently: COMFYUI_TIMEOUT\n");
  await new Promise((resolve) => setImmediate(resolve));
  child.emitExit(0);
  await new Promise((resolve) => setImmediate(resolve));
  const logFile = join(dataHome, "logs", "scene-image-worker.log");
  assert.ok(existsSync(logFile), "日志必须写入隔离文件");
  const content = readFileSync(logFile, "utf8");
  assert.match(content, /\[worker\] \[scene-image-worker\] advisory lock acquired/);
  assert.match(content, /\[host\] worker started pid=4242/);
  assert.match(content, /\[host\] worker exited code=0 signal=null/);
  // supervisor 行与透传的 worker 行都不得出现敏感值。
  assert.doesNotMatch(content, /secret-provider-key|secret-token/);
  assert.doesNotMatch(content, /postgresql:\/\//);
});
