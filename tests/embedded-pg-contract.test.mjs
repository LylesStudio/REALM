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

test("setup-web resolves Windows .exe/.cmd/.bat executables", () => {
  // 嵌入式构件的 pg_config 是 .cmd 批处理 shim，真实安装是 .exe——都要认。
  assert.match(setupWeb, /resolveExecutablePath/);
  assert.match(setupWeb, /\.cmd/);
  assert.match(setupWeb, /\.bat/);
});

test("install.ps1 installs the embedded artifact instead of refusing", () => {
  const ps1 = readFileSync(new URL("../scripts/install.ps1", import.meta.url), "utf8");
  assert.match(ps1, /embedded-pg\.mjs/);
  assert.match(ps1, /install --artifact/);
  assert.doesNotMatch(ps1, /linux-x64 only/);
});

test("install.sh exposes the embedded PG path as explicit opt-in", () => {
  assert.match(installer, /--pg-artifact/);
  assert.match(installer, /embedded-pg\.mjs/);
  // 透传前剔除自定义参数，setup-web 不收到未知 flag。
  assert.match(installer, /SETUP_ARGS/);
});

test("install.sh --embedded-pg resolves the platform artifact with integrity check", () => {
  assert.match(installer, /--embedded-pg/);
  assert.match(installer, /realm-embedded-pg-\$\{PG_PLATFORM\}/);
  assert.match(installer, /sha256sum -c/);
  // mac 仅 Apple Silicon；Intel Mac 诚实拒绝（无 darwin-x64 构件）。
  assert.match(installer, /Apple Silicon/);
  assert.doesNotMatch(installer, /darwin-x64/);
});

test("install.ps1 -EmbeddedPg resolves windows-x64 with integrity check", () => {
  const ps1 = readFileSync(new URL("../scripts/install.ps1", import.meta.url), "utf8");
  assert.match(ps1, /EmbeddedPg/);
  assert.match(ps1, /realm-embedded-pg-windows-x64/);
  assert.match(ps1, /Get-FileHash/);
});

test("embedded-pg manager supports safe upgrade with rollback", () => {
  assert.match(manager, /upgrade\({/);
  assert.match(manager, /rolled back/);
  // 运行中拒绝替换二进制。
  assert.match(manager, /PostgreSQL is running/);
  // 版本探测支撑安装器的版本比较。
  assert.match(manager, /installedVersion/);
});

test("local-postgres defaults data to user dir with legacy migration", () => {
  const lp = readFileSync(new URL("../scripts/local-postgres.mjs", import.meta.url), "utf8");
  // 默认数据落 ~/.local/realm-pgsql/data（与源码分离），日志同目录旁。
  assert.match(lp, /\.local., .realm-pgsql., .data./);
  // 旧项目内 .local/postgres 数据自动整体搬迁，不是另起新库。
  assert.match(lp, /migrated data directory/);
  assert.match(lp, /renameSync/);
});

test("install.cmd bridges cmd.exe users into PowerShell", () => {
  const cmd = readFileSync(new URL("../install.cmd", import.meta.url), "utf8");
  assert.match(cmd, /powershell/);
  assert.match(cmd, /install\.ps1/);
  assert.match(cmd, /-EmbeddedPg/);
  // cmd 不认识 iex/irm：入口必须显式交给 PowerShell。
  assert.match(cmd, /iex/);
});
