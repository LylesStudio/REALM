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

test("install.sh is defensive by default", () => {
  assert.match(installer, /set -euo pipefail/);
  // 管道执行且非 --yes 时必须拒绝静默自动化，而不是无确认继续。
  assert.match(installer, /stdin is a pipe and no terminal is available/);
  // 无 sudo 调用（注释里提到 "no sudo" 不算），状态固定在 REALM_HOME 之下。
  assert.doesNotMatch(installer, /^[ \t]*sudo[ \t]/m);
  assert.match(installer, /REALM_HOME:-\$HOME\/.realm/);
});

test("install.sh follows detect → explain → confirm → install", () => {
  assert.match(installer, /MIN_NODE="22\.13\.0"/);
  // 显式确认（或 --yes），与 setup-web 同一套保守语义。
  assert.match(installer, /confirm\(\)/);
  assert.match(installer, /--yes/);
  assert.match(installer, /read -r -p/);
});

test("install.sh ends at setup-web.sh, never skips the bootstrap", () => {
  assert.match(installer, /exec bash "\$APP_DIR\/scripts\/setup-web\.sh" "\$@"/);
  // 冒烟开关仅用于自动化验收，不能成为默认路径。
  assert.match(installer, /REALM_INSTALL_SKIP_NPM/);
  assert.match(installer, /REALM_INSTALL_SKIP_SETUP/);
});

test("install.sh fetches source without git when possible", () => {
  assert.match(installer, /git clone --depth 1/);
  assert.match(installer, /codeload\.github\.com/);
  // 支持 tar 包直链与分支覆盖。
  assert.match(installer, /REALM_INSTALL_REF/);
  assert.match(installer, /tar -xJ?z?f?/);
});

test("install.sh carries no credentials", () => {
  assert.doesNotMatch(installer, /token|password|secret|api[_-]?key/i);
});
