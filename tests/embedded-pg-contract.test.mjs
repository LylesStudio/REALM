import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dockerfile = readFileSync(
  new URL("../scripts/embedded-pg/Dockerfile.linux-x64", import.meta.url),
  "utf8",
);
const manager = readFileSync(new URL("../scripts/embedded-pg.mjs", import.meta.url), "utf8");
const setupWeb = readFileSync(new URL("../scripts/setup-web.mjs", import.meta.url), "utf8");
const installer = readFileSync(new URL("../scripts/install.sh", import.meta.url), "utf8");

test("embedded-pg Dockerfile pins reproducible sources", () => {
  assert.match(dockerfile, /linux-x64-17\.10\.0-beta\.17/);
  assert.match(dockerfile, /pgvector\/tar\.gz\/refs\/tags\/v0\.8\.6/);
  // 禁止 -march=native：产物必须在任意 x86-64 CPU 上运行。
  assert.match(dockerfile, /OPTFLAGS=""/);
  // 构件必须内嵌冒烟（initdb + 启动 + CREATE EXTENSION vector）。
  assert.match(dockerfile, /CREATE EXTENSION vector/);
  assert.match(dockerfile, /initdb/);
});

test("embedded-pg manager is conservative and user-local", () => {
  // 只写用户目录、绝不 sudo。
  assert.doesNotMatch(manager, /\bsudo\b/);
  // 强制构件校验与覆盖保护。
  assert.match(manager, /--artifact/);
  assert.match(manager, /refusing to overwrite/);
  assert.match(manager, /vector\.control/);
});

test("setup-web detects the embedded install on linux", () => {
  assert.match(setupWeb, /realm-pgsql/);
  assert.match(setupWeb, /"linux"/);
});

test("install.sh exposes the embedded PG path as explicit opt-in", () => {
  assert.match(installer, /--pg-artifact/);
  assert.match(installer, /embedded-pg\.mjs/);
  // 透传前剔除自定义参数，setup-web 不收到未知 flag。
  assert.match(installer, /SETUP_ARGS/);
});
