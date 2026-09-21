#!/usr/bin/env node
/**
 * REALM Tauri service host：把 `startRealm`（realm-launcher.mjs）包装成
 * JSON-lines 进程协议，供 Tauri Rust controller spawn/逐行解析。
 *
 * 协议（stdout，一行一个 JSON）：
 *   {"type":"step","step":"lock|postgres|provision|migrations|seed|server|health|ready"}
 *   {"type":"ready","url":"http://127.0.0.1:PORT/","appPort":N,"pgPort":N,"dataHome":"…","advertisedOrigin":"http://…"|null}
 *   {"type":"error","kind":"already-running|failed","message":"…"}
 *   {"type":"worker","state":"starting|unavailable|stopped","reason?":"…"}
 *   {"type":"stopping"} / {"type":"stopped"}
 *
 * 语义：stdout 只放协议帧（连接串/密码绝不出现）；诊断仍写 launcher.log。
 * Web ready 之后以非阻塞方式启动 scene image worker（supervisor 见
 * scene-image-worker-host.mjs）；worker 失败只经 worker 帧上报，绝不伪装成
 * Web 失败。SIGINT/SIGTERM → 优雅 stop（先停 worker → 停 app server →
 * 停 PG → 放锁）→ stopped。退出码：ready 后被停 = 0；启动失败 = 1。
 *
 * 参数：--home <dir> --data-home <dir> --app-port <n> --pg-port <n>
 * --lan <ip> --advertised-origin <origin>（与 realm-launcher.mjs 同义）。
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LauncherError, launcherPgUrl, startRealm } from "./realm-launcher.mjs";
import { createSceneImageWorkerHost } from "./scene-image-worker-host.mjs";

function emit(frame) {
  // 协议帧绝不包含 env/连接串；message 只传 launcher 的安全文案。
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function parseArgs(argv) {
  const value = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const port = (name) => {
    const raw = value(name);
    if (raw === undefined) return undefined;
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
      throw new LauncherError(`invalid port for ${name}: ${raw}`);
    }
    return parsed;
  };
  return {
    home: value("--home"),
    dataHome: value("--data-home"),
    appPort: port("--app-port"),
    pgPort: port("--pg-port"),
    lan: value("--lan"),
    advertisedOrigin: value("--advertised-origin"),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let handle = null;
  let workerHost = null;
  let stopped = false;
  const stop = async (reason) => {
    if (stopped || !handle) return;
    stopped = true;
    emit({ type: "stopping", reason });
    // 先停 worker 再停 app/PG：worker 使用 runtime DB，不能比 PG 后死。
    if (workerHost) await workerHost.stop();
    await handle.stop();
    emit({ type: "stopped" });
    process.exit(0);
  };
  process.once("SIGINT", () => void stop("sigint"));
  process.once("SIGTERM", () => void stop("sigterm"));

  try {
    handle = await startRealm({
      noBrowser: true,
      onStep: (step) => emit({ type: "step", step }),
      ...(args.home ? { home: resolve(args.home) } : {}),
      ...(args.dataHome ? { dataHome: resolve(args.dataHome) } : {}),
      ...(args.appPort ? { appPort: args.appPort } : {}),
      ...(args.pgPort ? { pgPort: args.pgPort } : {}),
      ...(args.lan ? { lanBind: args.lan } : {}),
      ...(args.advertisedOrigin ? { advertisedOrigin: args.advertisedOrigin } : {}),
    });
    emit({
      type: "ready",
      url: handle.url,
      appPort: handle.appPort,
      pgPort: handle.pgPort,
      dataHome: handle.dataHome,
      // 非敏感诊断：分享来源（显式 advertised origin 或 null）。
      advertisedOrigin: handle.advertisedOrigin ?? null,
    });
    // Web 已 ready：非阻塞启动 scene image worker（worker 启动失败只经
    // worker 帧上报，不影响 ready 语义）。连接串与 realm-launcher
    // buildChildEnv 同形态（loopback realm_runtime 最小权限），只注入
    // worker 子进程环境，绝不写入协议帧。
    workerHost = createSceneImageWorkerHost({
      dataHome: handle.dataHome,
      environment: {
        REALM_RUNTIME_DATABASE_URL: launcherPgUrl("realm_runtime", handle.pgPort),
        ...(process.env.REALM_SCENE_IMAGE_WORKSPACES
          ? { REALM_SCENE_IMAGE_WORKSPACES: process.env.REALM_SCENE_IMAGE_WORKSPACES }
          : {}),
      },
      onState: ({ state, reason }) => {
        // worker 帧只有安全状态码；reason 是 supervisor 的固定分类码。
        emit(reason === undefined
          ? { type: "worker", state }
          : { type: "worker", state, reason });
      },
    });
    workerHost.start();
  } catch (error) {
    const message = error instanceof LauncherError
      ? error.message
      : `service failed to start: ${error instanceof Error ? error.message : String(error)}`;
    emit({
      type: "error",
      kind: message.includes("already running") ? "already-running" : "failed",
      message,
    });
    process.exitCode = 1;
  }
}

const isDirectRun = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((error) => {
    emit({
      type: "error",
      kind: "failed",
      message: `host failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    process.exitCode = 1;
  });
}
