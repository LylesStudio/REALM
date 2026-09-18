#!/usr/bin/env node
/**
 * REALM 唯一服务启动入口。
 *
 * PORT      监听端口（默认 9999）
 * HOST_BIND 绑定地址（默认 127.0.0.1 回环；设 0.0.0.0 或具体内网 IP 才放开）
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const host = process.env.HOST_BIND ?? "127.0.0.1";
const port = process.env.PORT ?? "9999";
const mode = process.argv[2] === "start" ? "start" : "dev";

const cli = fileURLToPath(
  new URL("../node_modules/vinext/dist/cli.js", import.meta.url),
);
const child = spawn(
  process.execPath,
  [cli, mode, "--hostname", host, "--port", port],
  { stdio: "inherit" },
);

// launcher/Tauri/systemd 结束的是这个 wrapper；必须把信号转发给 Vinext，
// 否则 wrapper 退出后会留下仍监听端口的孤儿子进程。
let stopping = false;
function forwardSignal(signal) {
  if (stopping || child.exitCode !== null) return;
  stopping = true;
  try {
    child.kill(signal);
  } catch {
    // child 已经退出，exit 监听会完成 wrapper 收尾。
  }
  const forceTimer = setTimeout(() => {
    if (child.exitCode === null) {
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
    }
  }, 5_000);
  forceTimer.unref();
}
process.once("SIGINT", () => forwardSignal("SIGINT"));
process.once("SIGTERM", () => forwardSignal("SIGTERM"));
child.on("exit", (code) => process.exit(code ?? 0));
