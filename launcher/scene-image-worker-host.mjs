#!/usr/bin/env node
/**
 * 跨平台 scene image worker host/supervisor。
 *
 * 职责（单一实现，Tauri service host / setup-web / systemd / Task Scheduler /
 * LaunchAgent 共用，不各平台复制一套逻辑）：
 * - spawn scripts/scene-image-worker.mjs 子进程（process.execPath，
 *   Windows 不经 cmd shell；worker 空闲时不产生任何 ComfyUI/GPU 调用）；
 * - 日志隔离：worker stdout/stderr 追加到 <dataHome>/logs/scene-image-worker.log；
 *   supervisor 自身只写安全行（pid/exit code/signal），绝不写环境变量、
 *   连接串、provider URL、prompt_id、token、API key 或密码；
 * - 子进程环境白名单：只透传运行所需的非敏感键 + 显式注入的
 *   REALM_RUNTIME_DATABASE_URL / REALM_SCENE_IMAGE_WORKSPACES / REALM_DATA_HOME；
 * - 优雅停止：unix SIGTERM（worker runtime 有 SIGTERM→stop()），
 *   Windows child.kill()；超时后强杀；stop() 幂等；
 * - 退出传播：子进程意外退出 → onState("unavailable", "exit")（宿主据此
 *   上报；worker 失败绝不静默，也不伪装成 Web 失败）；
 * - 单实例：同一 host 内重复 start() 为 no-op；跨进程单实例由 worker
 *   runtime 的 PG advisory lock 兜底。
 *
 * 直接运行（systemd / Task Scheduler / LaunchAgent 模板入口）：
 *   node --env-file-if-exists=.env.local launcher/scene-image-worker-host.mjs
 * 直接运行需要环境里有 REALM_RUNTIME_DATABASE_URL（loopback realm_runtime）。
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const launcherDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(launcherDir, "..");

/** 子进程可继承的非敏感父环境键（其余一律不透传）。 */
const INHERITED_ENV_KEYS = [
  "PATH",
  "SystemRoot",
  "WINDIR",
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "TZ",
];

export function createSceneImageWorkerHost(options = {}) {
  const nodeExe = options.nodeExe ?? process.execPath;
  const workerScript = options.workerScript
    ?? resolve(projectRoot, "scripts", "scene-image-worker.mjs");
  const dataHome = options.dataHome
    ?? options.environment?.REALM_DATA_HOME
    ?? process.env.REALM_DATA_HOME
    ?? resolve(projectRoot, ".local");
  const logFile = options.logFile
    ?? resolve(dataHome, "logs", "scene-image-worker.log");
  const spawnImpl = options.spawn ?? spawn;
  const platform = options.platform ?? process.platform;
  const parentEnv = options.parentEnv ?? process.env;
  const environment = options.environment ?? {};
  const onState = options.onState ?? (() => {});
  const stopTimeoutMs = options.stopTimeoutMs ?? 5_000;
  const mirrorStdout = options.mirrorStdout ?? false;
  const now = options.now ?? (() => new Date());

  let child = null;
  let stopping = false;
  let started = false;

  const writeLog = (line) => {
    try {
      mkdirSync(dirname(logFile), { recursive: true, mode: 0o700 });
      appendFileSync(logFile, `${now().toISOString()} ${line}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
    } catch {
      // 日志写失败不杀 supervisor/worker。
    }
    if (mirrorStdout) {
      try {
        process.stdout.write(`${line}\n`);
      } catch {
        // stdout 不可写时忽略。
      }
    }
  };

  const setState = (state, reason) => {
    try {
      onState(reason === undefined ? { state } : { state, reason });
    } catch {
      // 宿主回调异常不影响 worker 生命周期。
    }
  };

  /** 白名单子环境：非敏感继承键 + 显式注入的 REALM_*（绝不回显值）。 */
  const buildChildEnv = () => {
    const childEnv = {};
    for (const key of INHERITED_ENV_KEYS) {
      if (typeof parentEnv[key] === "string" && parentEnv[key] !== "") {
        childEnv[key] = parentEnv[key];
      }
    }
    if (typeof environment.REALM_RUNTIME_DATABASE_URL === "string"
      && environment.REALM_RUNTIME_DATABASE_URL !== "") {
      childEnv.REALM_RUNTIME_DATABASE_URL = environment.REALM_RUNTIME_DATABASE_URL;
    }
    if (typeof environment.REALM_SCENE_IMAGE_WORKSPACES === "string"
      && environment.REALM_SCENE_IMAGE_WORKSPACES !== "") {
      childEnv.REALM_SCENE_IMAGE_WORKSPACES = environment.REALM_SCENE_IMAGE_WORKSPACES;
    }
    childEnv.REALM_DATA_HOME = dataHome;
    return childEnv;
  };

  const pipeOutput = (stream) => {
    let pending = "";
    stream.on("data", (chunk) => {
      pending += chunk.toString("utf8");
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        // worker runtime 只输出安全分类码日志；supervisor 原样归档，不附加 env。
        if (line.trim() !== "") writeLog(`[worker] ${line}`);
      }
    });
    stream.on("end", () => {
      if (pending.trim() !== "") writeLog(`[worker] ${pending}`);
      pending = "";
    });
  };

  return {
    /** 重复 start 是 no-op（host 内单实例）。返回是否真正发起了 spawn。 */
    start() {
      if (child || started) return false;
      started = true;
      stopping = false;
      if (typeof environment.REALM_RUNTIME_DATABASE_URL !== "string"
        || environment.REALM_RUNTIME_DATABASE_URL === "") {
        writeLog("[host] worker not started: REALM_RUNTIME_DATABASE_URL missing");
        setState("unavailable", "not_configured");
        return false;
      }
      setState("starting");
      let spawned;
      try {
        spawned = spawnImpl(
          nodeExe,
          ["--experimental-strip-types", workerScript],
          {
            cwd: projectRoot,
            env: buildChildEnv(),
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
          },
        );
      } catch {
        writeLog("[host] worker spawn failed");
        setState("unavailable", "spawn_failed");
        started = false;
        return false;
      }
      child = spawned;
      writeLog(`[host] worker started pid=${spawned.pid ?? "unknown"}`);
      if (spawned.stdout) pipeOutput(spawned.stdout);
      if (spawned.stderr) pipeOutput(spawned.stderr);
      spawned.on("error", () => {
        writeLog("[host] worker spawn failed");
        child = null;
        started = false;
        if (!stopping) setState("unavailable", "spawn_failed");
      });
      spawned.on("exit", (code, signal) => {
        // 只记数字/信号名；绝不记环境或命令行之外的诊断。
        writeLog(`[host] worker exited code=${code ?? "null"} signal=${signal ?? "null"}`);
        child = null;
        started = false;
        if (stopping) setState("stopped");
        else setState("unavailable", "exit");
      });
      return true;
    },

    /** 幂等；先 SIGTERM（unix）/kill（Windows），超时强杀。 */
    async stop() {
      if (stopping) return;
      stopping = true;
      const current = child;
      if (!current) {
        setState("stopped");
        return;
      }
      const exited = new Promise((resolvePromise) => {
        current.once("exit", () => resolvePromise(true));
      });
      try {
        if (platform === "win32") current.kill();
        else current.kill("SIGTERM");
      } catch {
        // 已经退出。
      }
      const deadline = new Promise((resolvePromise) => {
        setTimeout(() => resolvePromise(false), stopTimeoutMs);
      });
      if (!await Promise.race([exited, deadline])) {
        try {
          if (platform === "win32") current.kill();
          else current.kill("SIGKILL");
        } catch {
          // 已经退出。
        }
        await Promise.race([exited, new Promise((resolvePromise) => {
          setTimeout(() => resolvePromise(false), 1_000);
        })]);
      }
      if (child === current) {
        child = null;
        started = false;
        setState("stopped");
      }
    },

    /** 仅用于宿主诊断：当前是否持有活着的子进程。 */
    isRunning() {
      return child !== null;
    },
  };
}

async function main() {
  const host = createSceneImageWorkerHost({
    environment: {
      REALM_RUNTIME_DATABASE_URL: process.env.REALM_RUNTIME_DATABASE_URL,
      ...(process.env.REALM_SCENE_IMAGE_WORKSPACES
        ? { REALM_SCENE_IMAGE_WORKSPACES: process.env.REALM_SCENE_IMAGE_WORKSPACES }
        : {}),
      ...(process.env.REALM_DATA_HOME
        ? { REALM_DATA_HOME: process.env.REALM_DATA_HOME }
        : {}),
    },
    mirrorStdout: true,
    onState: ({ state, reason }) => {
      if (state === "unavailable") {
        // 退出传播：直接运行形态下 worker 失败 = host 失败（systemd
        // Restart=on-failure 等外层策略接管），绝不静默。
        process.exitCode = 1;
        void host.stop().finally(() => {
          if (reason !== "not_configured") process.exit(1);
        });
      }
    },
  });
  const shutdown = () => {
    void host.stop().then(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  if (!host.start()) {
    process.exitCode = 1;
  }
}

const isDirectRun = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main();
}
