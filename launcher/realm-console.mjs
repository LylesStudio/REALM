#!/usr/bin/env node
/**
 * REALM service console host（跨平台极简服务控制台；安装器生成的启动入口
 * 指向本脚本，Windows/macOS/Linux 共用同一实现）。
 *
 * 职责：
 * - 在 127.0.0.1 上起一个极小的 HTTP 控制台：静态托管
 *   src-tauri/ui/index.html（Tauri 客户端 UI 同源复用，__TAURI__ 缺失时
 *   回落到本服务的 REST/SSE API），暴露 start/stop/restart/status/
 *   open-browser/logs/config 控制面；
 * - 服务管理复用 launcher/realm-service-host.mjs（spawn 为子进程并解析其
 *   JSON-lines 协议帧驱动状态机），不引入第二个服务管理器；
 * - 控制台进程本身即「关闭语义」的载体：默认关闭控制台 = 停止服务
 *   （--keep-running 或 UI 设置可显式改成保留服务）；
 * - 日志接口只返回 launcher.log（realm-service-host 诊断日志）的最后
 *   N 行并逐行 redact（password/token/secret/api key 形态与 URL userinfo
 *   一律 [REDACTED]），绝不回显连接串/凭据。
 *
 * 边界：只绑 loopback；协议帧不含凭据（service-host 已保证）；不写
 * realm_dev；契约测试可注入 controller/uiHtml，不起真实服务。
 */
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LauncherError,
  pickPort,
  portCandidates,
  resolveNodeBinary,
  resolveStartRealmDataHome,
  safeParentEnv,
} from "./realm-launcher.mjs";

// ---- 日志 redaction（契约：凭据形态不得离开本机日志视图） ----

const REDACTED = "[REDACTED]";
/** key=value / key: value 形态的敏感键（与 launcher env 过滤同族）。 */
const SENSITIVE_KEY =
  /(password|passwd|pwd|secret|token|api[-_]?key|access[-_]?key|private[-_]?key)([^\s:="']*)(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s;",'"]*)/gi;
/** URL userinfo：scheme://user:pass@host → scheme://[REDACTED]@host。 */
const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+(?::[^\s/@]*)?@)/gi;
/** PostgreSQL 连接串参数形态：password=… / pass='…'。 */
const CONNINFO_PAIR = /((?:password|pass|sslcert|sslkey|sslpassword)\s*=\s*)('[^']*'|"[^"]*"|\S+?)(?=[\s;',"]|$)/gi;

export function redactLogLine(line) {
  if (typeof line !== "string") return "";
  return line
    .replace(URL_USERINFO, (_match, scheme) => `${scheme}${REDACTED}@`)
    .replace(CONNINFO_PAIR, (_match, key) => `${key}${REDACTED}`)
    .replace(SENSITIVE_KEY, (_match, key, rest, sep) => `${key}${rest}${sep}${REDACTED}`);
}

/** 读取日志文件最后 N 行（不足 N 则全部），逐行 redact；文件缺失 → []。 */
export function readLogTail(logFile, lineCount = 200) {
  const count = Math.min(Math.max(Number(lineCount) || 200, 1), 2_000);
  let contents;
  try {
    contents = readFileSync(logFile, "utf8");
  } catch {
    return [];
  }
  const lines = contents.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.slice(-count).map(redactLogLine);
}

// ---- service-host JSON-lines 帧 → 控制台状态机（纯函数，与 Rust 侧一致） ----

export function applyHostFrame(current, frame) {
  const type = frame?.type;
  if (type === "step") {
    // ready/stopping 之后不再回退到 starting（幂等步骤事件）。
    if (current?.phase === "ready" || current?.phase === "stopping") return current;
    const step = typeof frame.step === "string" ? frame.step : "starting";
    return { phase: "starting", step };
  }
  if (type === "ready") {
    return {
      phase: "ready",
      url: String(frame.url ?? ""),
      advertisedOrigin: typeof frame.advertisedOrigin === "string"
        ? frame.advertisedOrigin
        : null,
    };
  }
  if (type === "error") {
    return {
      phase: "failed",
      kind: typeof frame.kind === "string" ? frame.kind : "failed",
      message: typeof frame.message === "string" ? frame.message : "service failed",
    };
  }
  if (type === "stopping") return { phase: "stopping" };
  if (type === "stopped") return { phase: "stopped" };
  return current;
}

// ---- 服务控制器：spawn realm-service-host.mjs，绝不另起服务管理语义 ----

export function createServiceController(options = {}) {
  const home = options.home
    ?? resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
  const dataHome = resolveStartRealmDataHome({
    dataHome: options.dataHome,
    environment: options.environment ?? process.env,
  });
  const nodeExe = options.nodeExe ?? resolveNodeBinary(home);
  const parentEnvironment = options.environment ?? process.env;
  const spawnImpl = options.spawnImpl ?? spawn;
  const hostScript = resolve(home, "launcher", "realm-service-host.mjs");

  let phase = { phase: "idle" };
  let child = null;
  let childDone = null;
  // 关闭控制台时的服务处置：默认 true（关控制台 = 停服务）。
  let stopOnClose = options.stopOnClose ?? true;
  const listeners = new Set();

  const notify = () => {
    for (const listener of listeners) {
      try {
        listener(phase);
      } catch { /* 通知故障不阻断状态机 */ }
    }
  };
  const setPhase = (next) => {
    phase = next;
    notify();
  };

  const handleLine = (line) => {
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      // 非协议行不进入状态机（service-host 协议保证帧内无敏感值）。
      return;
    }
    const next = applyHostFrame(phase, frame);
    if (next !== phase) setPhase(next);
  };

  const start = () => new Promise((resolvePromise, rejectPromise) => {
    if (child) {
      rejectPromise(new LauncherError("service is already running or starting"));
      return;
    }
    if (!existsSync(hostScript)) {
      rejectPromise(new LauncherError(`service host script not found: ${hostScript}`));
      return;
    }
    let stdoutBuffer = "";
    let settled = false;
    try {
      child = spawnImpl(nodeExe, [hostScript, "--home", home, "--data-home", dataHome], {
        cwd: home,
        env: safeParentEnv(parentEnvironment),
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch (error) {
      child = null;
      rejectPromise(new LauncherError(
        `failed to spawn service host: ${error instanceof Error ? error.message : String(error)}`,
      ));
      return;
    }
    child.once("spawn", () => {
      setPhase({ phase: "starting", step: "spawn" });
      if (!settled) {
        settled = true;
        resolvePromise();
      }
    });
    child.once("error", (error) => {
      child = null;
      if (!settled) {
        settled = true;
        rejectPromise(new LauncherError(`failed to spawn service host: ${error.message}`));
        return;
      }
      setPhase({
        phase: "failed",
        kind: "exited",
        message: `service host error: ${error.message}`,
      });
    });
    childDone = new Promise((resolveDone) => {
      child.once("exit", (code, signal) => {
        child = null;
        if (phase.phase === "starting" || phase.phase === "ready") {
          setPhase({
            phase: "failed",
            kind: "exited",
            message: `service host exited unexpectedly (code ${code ?? signal})`,
          });
        } else if (phase.phase === "stopping") {
          setPhase({ phase: "stopped" });
        }
        resolveDone();
      });
    });
    child.stdout?.on("data", (chunk) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) handleLine(line);
    });
  });

  const stop = async () => {
    if (!child) return;
    setPhase({ phase: "stopping" });
    child.kill("SIGTERM");
    await childDone;
  };

  const openBrowser = async () => {
    if (phase.phase !== "ready" || !phase.url) {
      throw new LauncherError("service is not running");
    }
    const url = phase.url;
    if (process.platform === "win32") {
      spawn("cmd.exe", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  };

  return {
    state: () => phase,
    start,
    stop,
    restart: async () => {
      await stop();
      await start();
    },
    openBrowser,
    logs: ({ lines } = {}) =>
      readLogTail(resolve(dataHome, "logs", "launcher.log"), lines ?? 200),
    config: () => ({ stopOnClose }),
    setConfig: (body) => {
      if (typeof body?.stopOnClose === "boolean") stopOnClose = body.stopOnClose;
      return { stopOnClose };
    },
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** 控制台退出时调用：默认随控制台停止服务（keepRunning 显式覆盖）。 */
    close: async ({ keepRunning } = {}) => {
      const keep = keepRunning ?? !stopOnClose;
      if (!keep && child) await stop();
    },
  };
}

// ---- HTTP 控制台服务器（loopback only；可注入 controller/uiHtml 做测试） ----

export function consoleUiPath(
  launcherDir = fileURLToPath(new URL(".", import.meta.url)),
) {
  return resolve(launcherDir, "..", "src-tauri", "ui", "index.html");
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

async function readBody(request, limit = 16_384) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new LauncherError("request body too large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new LauncherError("request body must be JSON");
  }
}

export async function createConsoleServer(options = {}) {
  const controller = options.controller;
  const html = options.uiHtml
    ?? readFileSync(options.uiHtmlPath ?? consoleUiPath(), "utf8");
  const bindHost = options.host ?? "127.0.0.1";

  const server = createHttpServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(options.port ?? 0, bindHost, resolveListen);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  const events = new Set();
  controller.onChange?.((phase) => {
    for (const response of events) {
      response.write(`data: ${JSON.stringify(phase)}\n\n`);
    }
  });

  server.on("request", createConsoleRequestHandler({ controller, html, events, bindHost }));

  return {
    server,
    port,
    host: bindHost,
    url: `http://${bindHost}:${port}/`,
    close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
  };
}

/**
 * 控制台路由处理器（从 createConsoleServer 抽出以便无 socket 契约测试；
 * 生产路径仍只经 loopback HTTP server 调用）。
 */
export function createConsoleRequestHandler({
  controller,
  html,
  events = new Set(),
  bindHost = "127.0.0.1",
}) {
  return async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? bindHost}`);
    const route = url.pathname;
    const method = request.method ?? "GET";
    try {
      if (route === "/" && method === "GET") {
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(html);
        return;
      }
      if (route === "/api/state" && method === "GET") {
        sendJson(response, 200, controller.state());
        return;
      }
      if (route === "/api/start" && method === "POST") {
        await controller.start();
        sendJson(response, 200, controller.state());
        return;
      }
      if (route === "/api/stop" && method === "POST") {
        await controller.stop();
        sendJson(response, 200, controller.state());
        return;
      }
      if (route === "/api/restart" && method === "POST") {
        await controller.restart();
        sendJson(response, 200, controller.state());
        return;
      }
      if (route === "/api/open-browser" && method === "POST") {
        await controller.openBrowser();
        sendJson(response, 200, { ok: true });
        return;
      }
      if (route === "/api/logs" && method === "GET") {
        sendJson(response, 200, {
          lines: controller.logs({ lines: url.searchParams.get("lines") }),
        });
        return;
      }
      if (route === "/api/config" && method === "GET") {
        sendJson(response, 200, controller.config());
        return;
      }
      if (route === "/api/config" && method === "POST") {
        const body = await readBody(request);
        sendJson(response, 200, controller.setConfig(body));
        return;
      }
      if (route === "/api/events" && method === "GET") {
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          connection: "keep-alive",
        });
        response.write(`data: ${JSON.stringify(controller.state())}\n\n`);
        events.add(response);
        request.once("close", () => events.delete(response));
        return;
      }
      sendJson(response, 404, { error: "not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, error instanceof LauncherError ? 409 : 500, { error: message });
    }
  };
}

// ---- CLI ----

function parseArgs(argv) {
  const value = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const port = (() => {
    const raw = value("--port");
    if (raw === undefined) return undefined;
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
      throw new LauncherError(`invalid port for --port: ${raw}`);
    }
    return parsed;
  })();
  return {
    port,
    home: value("--home"),
    dataHome: value("--data-home"),
    keepRunning: argv.includes("--keep-running"),
    noBrowser: argv.includes("--no-browser"),
  };
}

function openBrowserWindow(url) {
  if (process.platform === "win32") {
    spawn("cmd.exe", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
  } else if (process.platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const home = args.home
    ? resolve(args.home)
    : resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
  const controller = createServiceController({
    home,
    ...(args.dataHome ? { dataHome: args.dataHome } : {}),
    stopOnClose: !args.keepRunning,
  });
  const consolePort = args.port ?? await pickPort(portCandidates(39999));
  const httpConsole = await createConsoleServer({ controller, port: consolePort });

  console.log(`REALM console: ${httpConsole.url}`);
  console.log(args.keepRunning
    ? "控制台关闭后服务将继续运行（--keep-running）。"
    : "关闭本窗口即停止 REALM 服务。");

  if (!args.noBrowser) openBrowserWindow(httpConsole.url);

  // 浏览器控制台模式默认自动启动服务；Tauri 模式由 UI 触发，行为不变。
  controller.start().catch((error) => {
    console.error("service autostart failed:", error instanceof Error ? error.message : String(error));
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void controller.close()
      .then(() => httpConsole.close())
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.once("SIGHUP", shutdown);
}

const isDirectRun = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof LauncherError ? error.message : `console failed: ${error}`);
    process.exitCode = 1;
  });
}
