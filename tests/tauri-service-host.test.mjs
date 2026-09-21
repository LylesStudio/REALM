/**
 * Tauri service host 进程级 smoke（真实 PG 起停，不伪造）。
 *
 * 覆盖：JSON-lines 协议帧序列（lock→…→ready）、ready 后 GET / 200 +
 * SSR <title>、第二实例 already-running、SIGTERM 优雅停止（stopping→
 * stopped，exit 0）、协议帧零敏感形态（无连接串/密码）。
 *
 * 环境：REALM_POSTGRES_BIN 必须指向可用 PG17 bin（本机从 pgvector/pg17
 * 镜像提取到 ~/.local/realm-pgsql/17/bin，LD_LIBRARY_PATH 指向其私有
 * lib）。无 PG bin 时 skip（不伪造通过）。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { createServer } from "node:net";
import { resolve } from "node:path";
import test from "node:test";

const PG_BIN = process.env.REALM_HOST_SMOKE_PG_BIN
  ?? resolve(homedir(), ".local", "realm-pgsql", "17", "bin");
const PG_LIB = process.env.REALM_HOST_SMOKE_PG_LIB
  ?? resolve(homedir(), ".local", "realm-pgsql", "lib-only");
const HOST = resolve(
  new URL("../launcher/realm-service-host.mjs", import.meta.url).pathname,
);
const REPO = resolve(new URL("..", import.meta.url).pathname);

function runHost(dataHome, frames, options = {}) {
  const args = [HOST, "--data-home", dataHome];
  if (options.appPort) args.push("--app-port", String(options.appPort));
  if (options.pgPort) args.push("--pg-port", String(options.pgPort));
  if (options.lan) args.push("--lan", options.lan);
  if (options.advertisedOrigin) args.push("--advertised-origin", options.advertisedOrigin);
  const child = spawn(process.execPath, args, {
    cwd: REPO,
    env: {
      ...process.env,
      REALM_POSTGRES_BIN: PG_BIN,
      LD_LIBRARY_PATH: PG_LIB,
      // REALM_ACCESS_TOKEN 已退役：LAN 也不再需要令牌。
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) frames.push(JSON.parse(line));
    }
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exit = new Promise((resolvePromise) => {
    child.once("exit", (code) => resolvePromise(code));
  });
  return { child, exit, getStderr: () => stderr };
}

async function waitForFrame(frames, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = frames.find(predicate);
    if (found) return found;
    const failure = frames.find((frame) => frame.type === "error");
    if (failure) {
      throw new Error(`service host emitted error while waiting for ${label}: ${JSON.stringify(failure)}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`timed out waiting for frame: ${label}; got ${JSON.stringify(frames.slice(-3))}`);
}

async function freePort(excluded = new Set()) {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolvePromise) => server.close(resolvePromise));
  if (!port) throw new Error("could not allocate a temporary TCP port");
  if (excluded.has(port)) return freePort(excluded);
  return port;
}

async function portIsClosed(port) {
  return new Promise((resolvePromise) => {
    const socket = createServer();
    socket.once("error", () => resolvePromise(true));
    socket.listen(port, "127.0.0.1", () => {
      socket.close(() => resolvePromise(true));
    });
  });
}

test(
  "service host: protocol frames, real health, already-running, graceful stop",
  {
    skip: !existsSync(resolve(PG_BIN, "initdb")) || !existsSync(resolve(REPO, "dist", "server"))
      || !existsSync(resolve(REPO, "dist", "client"))
      ? "requires PG17 bin (~/.local/realm-pgsql) and a production build (npm run build)"
      : false,
    timeout: 300_000,
  },
  async (t) => {
    const dataHome = `/tmp/realm-host-smoke-${Math.random().toString(36).slice(2, 10)}`;
    t.after(() => {
      rmSync(dataHome, { recursive: true, force: true });
    });

    const appPort = await freePort();
    const pgPort = await freePort(new Set([appPort]));
    const children = [];
    const frames = [];
    const first = runHost(dataHome, frames, {
      appPort,
      pgPort,
      lan: "127.0.0.1",
      advertisedOrigin: `http://192.0.2.10:${appPort}`,
    });
    children.push(first.child);
    t.after(() => {
      for (const child of children) child.kill("SIGKILL");
    });

    // 帧序列：步骤单调推进到 ready。
    const ready = await waitForFrame(
      frames,
      (frame) => frame.type === "ready",
      240_000,
      "ready",
    );
    assert.equal(ready.url, `http://127.0.0.1:${appPort}/`);
    assert.equal(ready.advertisedOrigin, `http://192.0.2.10:${appPort}`);
    const steps = frames.filter((frame) => frame.type === "step").map((frame) => frame.step);
    assert.deepEqual(steps, [
      "lock", "postgres", "provision", "migrations", "seed", "server", "health", "ready",
    ]);

    // 协议帧零敏感形态。
    const raw = JSON.stringify(frames);
    assert.ok(!raw.includes("postgresql://"), "frames must not contain connection strings");
    assert.ok(!/password|secret|api[-_]?key/i.test(raw), "frames must not contain secrets");

    // 真实服务：GET / 200 + SSR 标题。
    const response = await fetch(ready.url);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.ok(html.includes("<title>"), "home page must render SSR title");

    // 第二实例：同数据目录 → already-running（exit 1，不抢锁）。
    const secondFrames = [];
    const second = runHost(dataHome, secondFrames, {
      appPort,
      pgPort,
      lan: "127.0.0.1",
      advertisedOrigin: `http://192.0.2.10:${appPort}`,
    });
    children.push(second.child);
    const alreadyRunning = await waitForFrame(
      secondFrames,
      (frame) => frame.type === "error",
      30_000,
      "already-running",
    );
    assert.equal(alreadyRunning.kind, "already-running");
    assert.equal(await second.exit, 1);

    // 优雅停止：SIGTERM → stopping → stopped → exit 0。
    first.child.kill("SIGTERM");
    await waitForFrame(frames, (frame) => frame.type === "stopping", 15_000, "stopping");
    await waitForFrame(frames, (frame) => frame.type === "stopped", 60_000, "stopped");
    assert.equal(await first.exit, 0);
    assert.equal(await portIsClosed(appPort), true, "stopping the host must release the Vinext port");
  },
);
