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
child.on("exit", (code) => process.exit(code ?? 0));
