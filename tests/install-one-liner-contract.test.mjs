/**
 * 一条命令安装器契约：scripts/install.sh 是面向玩家的分发入口，
 * 必须保持「检测 → 解释 → 明确确认 → 安装 → 启动 → 打开浏览器」的
 * 保守语义（与 setup-web.* 一致），且未经确认不得改动系统。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const installer = readFileSync(join(projectRoot, "scripts/install.sh"), "utf8");
const windowsInstaller = readFileSync(join(projectRoot, "scripts/install.ps1"), "utf8");

test("install.sh is defensive by default", () => {
  assert.match(installer, /set -euo pipefail/);
  // 管道执行且非 --yes 时，确认函数优先从 /dev/tty 读取，而不是把脚本自己的
  // stdin 接走；无终端可确认时必须给出清晰错误并指引 --yes。
  assert.match(installer, /\{ true < \/dev\/tty; \} 2>\/dev\/null/);
  assert.match(installer, /read -r answer < \/dev\/tty/);
  assert.match(installer, /printf '%s \[y\/N\] ' "\$prompt" >&2/);
  assert.match(installer, /no interactive terminal available for confirmation/);
  // 无 sudo 调用（注释里提到 "no sudo" 不算），状态固定在 REALM_HOME 之下。
  assert.doesNotMatch(installer, /^[ \t]*sudo[ \t]/m);
  assert.match(installer, /REALM_HOME:-\$HOME\/.realm/);
});

test("install.sh follows detect → explain → confirm → install", () => {
  assert.match(installer, /MIN_NODE="22\.13\.0"/);
  // 显式确认（或 --yes），与 setup-web 同一套保守语义。
  assert.match(installer, /confirm\(\)/);
  assert.match(installer, /--yes/);
  assert.match(installer, /read -r answer/);
});

test("install.sh creates a user-discoverable launcher entry that opens the service console", () => {
  // 安装完成后生成可检索启动入口，而不是占用当前 terminal 直接启动。
  assert.match(installer, /install_launcher_entry/);
  assert.match(installer, /Launch REALM\.command/);
  assert.match(installer, /realm-launch/);
  assert.match(installer, /realm\.desktop/);
  // 入口指向跨平台服务控制台（状态/启停/日志），不再是裸 launcher。
  assert.match(installer, /launcher\/realm-console\.mjs/);
  assert.doesNotMatch(installer, /launcher\/realm-launcher\.mjs/);
  // Windows 安装器同样 handing off 到控制台。
  assert.match(windowsInstaller, /realm-console\.mjs/);
  assert.doesNotMatch(windowsInstaller, /realm-launcher\.mjs/);
  // 冒烟开关仅用于自动化验收，不能成为默认路径。
  assert.match(installer, /REALM_INSTALL_SKIP_NPM/);
  assert.match(installer, /REALM_INSTALL_SKIP_SETUP/);
});

test("installer launcher entries stop the service when the console closes", () => {
  // 关闭控制台窗口即停止本地服务是默认语义，入口注释必须向用户说明。
  assert.match(installer, /关闭本 Terminal 窗口会同时停止本地服务/);
  assert.match(windowsInstaller, /关闭本窗口会同时停止本地服务/);
  // 入口权限安全：脚本 0755（chmod +x 生成的 wrapper）。
  assert.match(installer, /chmod \+x "\$launch_dir/);
});

test("install.sh fetches source without git when possible", () => {
  assert.match(installer, /git clone --depth 1/);
  assert.match(installer, /codeload\.github\.com/);
  // 支持 tar 包直链与分支覆盖。
  assert.match(installer, /REALM_INSTALL_REF/);
  assert.match(installer, /tar -xJ?z?f?/);
});

test("installers refresh codeload installs and avoid project-local npm", () => {
  assert.match(installer, /refreshing existing non-git source/);
  assert.match(installer, /preserve_tmp/);
  assert.match(windowsInstaller, /refreshing existing non-git source/);
  assert.match(windowsInstaller, /Resolve-NpmCommand/);
  assert.match(windowsInstaller, /Join-Path \(Split-Path -Parent \$nodePath\) 'npm\.cmd'/);
});

test("install.sh carries no credentials", () => {
  assert.doesNotMatch(installer, /token|password|secret|api[_-]?key/i);
});
