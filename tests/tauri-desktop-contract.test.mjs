/**
 * Tauri 桌面 + LAN 安全契约（静态 + 行为级，不起服务）。
 *
 * 钉住：
 * - src-tauri 工程关键事实（真实 Tauri 2 依赖、commands 注册、UI 状态机
 *   文案、Android client-only 配置流）；
 * - origin 校验规则双端同源（Rust normalize_server_url 单测覆盖，JS 侧
 *   UI 必须走 invoke("validate_server_url")，不得自行放宽）；
 * - LAN 模式：显式 IPv4、退役令牌不再需要且零副作用
 *   （不创建锁文件）、buildChildEnv 默认 loopback 且不注入令牌；
 * - child env 白名单无敏感形态；host 协议帧无连接串；
 * - Web 端无 CORS 通配、会话 cookie 保持 HttpOnly+SameSite=Lax。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  LauncherError,
  buildChildEnv,
  safeParentEnv,
  startRealm,
  validateLanBind,
} from "../launcher/realm-launcher.mjs";

const read = (path) =>
  readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");

const tauriConf = JSON.parse(read("src-tauri/tauri.conf.json"));
const linuxTauriConf = JSON.parse(read("src-tauri/tauri.linux.bundle.conf.json"));
const windowsTauriConf = JSON.parse(read("src-tauri/tauri.windows.bundle.conf.json"));
const macosTauriConf = JSON.parse(read("src-tauri/tauri.macos.bundle.conf.json"));
const capability = read("src-tauri/capabilities/default.json");
const cargoToml = read("src-tauri/Cargo.toml");
const libRs = read("src-tauri/src/lib.rs");
const uiHtml = read("src-tauri/ui/index.html");
const hostMjs = read("launcher/realm-service-host.mjs");
const launcherMjs = read("launcher/realm-launcher.mjs");
const devServerMjs = read("scripts/dev-server.mjs");
const resourceStage = read("scripts/desktop/prepare-tauri-resources.mjs");
const desktopBuild = read("scripts/desktop/build-tauri-desktop.sh");
const androidPrepare = read("scripts/desktop/prepare-tauri-android.mjs");
const androidBuild = read("scripts/desktop/build-tauri-android.sh");

test("tauri scaffold is a real Tauri 2 project with the registered commands", () => {
  assert.match(cargoToml, /tauri = \{ version = "2"/);
  assert.match(cargoToml, /tauri-build = \{ version = "2"/);
  assert.equal(tauriConf.productName, "REALM");
  assert.equal(tauriConf.app.withGlobalTauri, true);
  for (const command of [
    "service_start",
    "service_stop",
    "service_state",
    "open_in_browser",
    "validate_server_url",
    "validate_advertised_origin",
    "validate_lan_bind",
    "check_server",
    "host_kind",
  ]) {
    assert.ok(
      libRs.includes(`${command},`) || libRs.includes(`${command}\n`),
      `command ${command} must be registered in invoke_handler`,
    );
  }
  // Android 不得具备本地服务能力（client-only 边界）。
  assert.match(libRs, /service hosting is not available on Android/);
});

test("chooser UI covers every visible state and reuses the server URL", () => {
  for (const text of [
    "打开客户端",
    "打开网页",
    "停止服务并退出",
    "重试",
    "已有实例在运行",
    "正在停止",
    "连接 REALM 服务",
  ]) {
    assert.ok(uiHtml.includes(text), `UI must contain state text: ${text}`);
  }
  // 客户端分支 = WebView 直接加载同一服务地址（不 fork 前端）。
  assert.match(uiHtml, /window\.location\.replace\(phase\.url\)/);
  assert.match(uiHtml, /status\.replaceChildren\(\)/);
  assert.doesNotMatch(uiHtml, /\binnerHTML\s*=/);
  // Android 配置流：服务端校验经 Rust 命令，不自建规则（连接入口走
  // validate_invite_url——服务根地址与邀请 URL 的单一白名单入口）。
  assert.match(uiHtml, /invoke\("validate_invite_url"/);
  // 不允许无限 spinner：失败必有重试/退出路径。
  assert.match(uiHtml, /连接失败/);
  assert.match(uiHtml, /invoke\("check_server"/);
  assert.doesNotMatch(uiHtml, /fetch\(normalized/);
  assert.match(uiHtml, /await tauri\.event\.listen\("service-state"/);
  assert.match(uiHtml, /buttons\[0\]\?\.focus\(\)/);
  assert.match(capability, /core:event:allow-listen/);
  assert.match(capability, /core:event:allow-emit/);
});

test("desktop bundle configs and staging recipe provide production service resources", () => {
  for (const config of [linuxTauriConf, windowsTauriConf, macosTauriConf]) {
    assert.ok(config.bundle?.resources, "desktop target must declare resource mapping");
    assert.equal(Object.values(config.bundle.resources)[0], "realm");
  }
  for (const marker of [
    "launcher",
    "dist",
    "node_modules",
    "runtime",
    "node",
    "pgsql",
    "REALM_TAURI_NODE",
    "REALM_TAURI_PG_ROOT",
  ]) {
    assert.ok(resourceStage.includes(marker), `resource staging missing: ${marker}`);
  }
  assert.match(resourceStage, /\.tauri-resources/);
  assert.match(launcherMjs, /platform === "linux" && arch === "x64"/);
  assert.match(desktopBuild, /--config "\$CONFIG"/);
  assert.match(androidBuild, /JAVA_HOME/);
  assert.match(androidBuild, /ANDROID_HOME/);
  assert.match(androidBuild, /tauri android build --apk/);
  assert.match(androidPrepare, /usesCleartextTraffic/);
  assert.match(androidPrepare, /client-only/);
});

test("LAN mode works without the retired access token; invalid bind stays fail-closed", async () => {
  // REALM_ACCESS_TOKEN 已退役：LAN 启动不再要求令牌（账户名+可选密码
  // 门禁由服务端 accounts 承担）。静态围栏：launcher 不含 token 前置文案。
  assert.doesNotMatch(launcherMjs, /LAN mode requires REALM_ACCESS_TOKEN/);
  const dataHome = `/tmp/realm-lan-contract-${Math.random().toString(36).slice(2, 10)}`;
  try {
    // 非法 bind 形态仍在任何副作用之前 fail-closed。
    await assert.rejects(
      startRealm({ dataHome, lanBind: "example.com", noBrowser: true }),
      (error) => error instanceof LauncherError && /IPv4/.test(error.message),
    );
    assert.equal(existsSync(`${dataHome}/realm.lock`), false, "failed LAN start must not leave a lock");
  } finally {
    rmSync(dataHome, { recursive: true, force: true });
  }
});

test("LAN bind validation is numeric and the direct launcher exposes --lan", () => {
  assert.equal(validateLanBind("192.168.1.20"), "192.168.1.20");
  assert.equal(validateLanBind("0.0.0.0"), "0.0.0.0");
  assert.throws(() => validateLanBind("999.1.1.1"), /explicit IPv4/);
  assert.throws(() => validateLanBind("192.168.1"), /explicit IPv4/);
  assert.match(launcherMjs, /optionValue\("--lan"\)/);
});

test("child env stays loopback by default and never leaks secrets", () => {
  const env = buildChildEnv({ dataHome: "/tmp/x", appPort: 9999, pgPort: 55432 });
  assert.equal(env.HOST_BIND, "127.0.0.1");
  assert.equal(env.REALM_ACCESS_TOKEN, undefined);
  // 退役令牌任何模式都不注入（含显式 LAN bind；buildChildEnv 已无此参数）。
  const lanEnv = buildChildEnv({
    dataHome: "/tmp/x",
    appPort: 9999,
    pgPort: 55432,
    hostBind: "192.168.1.20",
  });
  assert.equal(lanEnv.HOST_BIND, "192.168.1.20");
  assert.equal(lanEnv.REALM_ACCESS_TOKEN, undefined, "LAN 也不再注入退役令牌");
  // 父 env 白名单：注入 token/key/password 形态的父变量一律不透出。
  const parent = safeParentEnv({
    PATH: "/usr/bin",
    HOME: "/home/x",
    OPENAI_API_KEY: "sk-contract",
    REALM_ACCESS_TOKEN: "contract",
    DB_PASSWORD: "contract",
    CUSTOM_SECRET: "contract",
  });
  assert.deepEqual(Object.keys(parent).sort(), ["HOME", "PATH"]);
  // 白名单自身不得包含敏感形态键（只检查引号内的条目，注释不算）。
  const whitelistMatch = launcherMjs.match(/SAFE_PARENT_ENV_KEYS = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(whitelistMatch, "SAFE_PARENT_ENV_KEYS must exist");
  const entries = [...whitelistMatch[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(entries.length > 0);
  for (const entry of entries) {
    assert.ok(!/TOKEN|PASSWORD|SECRET|API[-_]?KEY/i.test(entry), `whitelist entry ${entry} looks sensitive`);
  }
});



test("Android 邀请接入：单一校验入口、只存根地址、一次性导航", () => {
  // Rust 命令注册与严格结构。
  assert.match(libRs, /fn validate_invite_url/);
  assert.match(libRs, /validate_invite_url,/);
  assert.match(libRs, /lobby_room_id: Option<String>/);
  // 校验器错误消息不得插值用户输入（可能内嵌凭据）。
  const validator = libRs.slice(
    libRs.indexOf("pub fn normalize_invite_url"),
    libRs.indexOf("struct ServerCheck"),
  );
  assert.ok(
    !/Err\([^)]*(input|trimmed|parsed\.|value)\.*/.test(validator),
    "邀请校验错误不得回显用户输入",
  );
  // UI 流程顺序：validate_invite_url → check_server(serverUrl) → 只存根地址 → 导航。
  const flow = uiHtml.slice(uiHtml.indexOf("async function checkAndConnect"));
  const connectFlow = uiHtml.slice(uiHtml.indexOf('invoke("validate_invite_url"'));
  assert.ok(
    connectFlow.indexOf('invoke("validate_invite_url"')
      < connectFlow.indexOf("checkAndConnect(target.serverUrl"),
    "必须先校验再连接",
  );
  assert.match(flow, /invoke\("check_server", \{ url: normalized \}\)/);
  assert.match(flow, /localStorage\.setItem\(STORAGE_KEY, normalized\)/);
  assert.ok(!/localStorage\.setItem\([^)]*lobby/.test(uiHtml), "roomId/邀请 query 不得落盘");
  assert.match(flow, /\?lobby=\$\{encodeURIComponent\(lobbyRoomId\)\}/);
  assert.match(flow, /checkAndConnect\(normalized, lobbyRoomId\)/);
  // 文案明确可粘贴邀请链接。
  assert.match(uiHtml, /粘贴大厅邀请链接/);
  // 桌面路径不回归：service_start/advertised origin/LAN bind 仍在。
  assert.match(libRs, /fn service_start/);
  assert.match(libRs, /normalize_advertised_origin/);
});

test("advertised origin：launcher/service-host/Tauri 接线一致", () => {
  const launcherSrc = read("launcher/realm-launcher.mjs");
  const hostSrc = read("launcher/realm-service-host.mjs");
  // 单一校验源：launcher 与 TS 入口共用 launcher/advertised-origin.mjs。
  assert.match(launcherSrc, /from "\.\/advertised-origin\.mjs"/);
  const tsEntry = read("modules/application/advertised-origin.ts");
  assert.match(tsEntry, /launcher\/advertised-origin\.mjs/);
  assert.ok(!tsEntry.includes("new URL("), "TS 入口不得另实现校验");
  // launcher CLI 参数 + 纯函数解析 + 推导边界。
  assert.match(launcherSrc, /--advertised-origin/);
  assert.match(launcherSrc, /resolveAdvertisedOrigin/);
  assert.match(launcherSrc, /hostBind !== "0\.0\.0\.0"/);
  // service-host：参数透传 + ready 帧携带非敏感 advertisedOrigin。
  assert.match(hostSrc, /value\("--advertised-origin"\)/);
  assert.match(hostSrc, /advertisedOrigin: handle\.advertisedOrigin/);
  // Tauri：service_start 可选参数先校验（Rust 侧同规则），UI 有配置行。
  assert.match(libRs, /normalize_advertised_origin/);
  assert.match(libRs, /advertised_origin: Option<String>/);
  assert.match(libRs, /lan_bind: Option<String>/);
  assert.match(libRs, /normalize_lan_bind/);
  assert.match(libRs, /command\.arg\("--lan"\)/);
  // 退役令牌：Rust 不再按 LAN 传递/要求 REALM_ACCESS_TOKEN（host_environment
  // 无参数、无 token 注入分支、无 LAN token 硬失败）。
  assert.match(libRs, /host_environment\(\)/);
  assert.doesNotMatch(libRs, /include_lan_token/);
  assert.doesNotMatch(libRs, /LAN mode requires REALM_ACCESS_TOKEN/);
  assert.match(libRs, /validated_lan\.as_deref\(\)/);
  assert.match(libRs, /validate_advertised_origin/);
  assert.match(libRs, /validate_lan_bind/);
  assert.match(libRs, /advertisedOrigin/);
  const spawnCall = libRs.indexOf("spawn_host(\n        &app");
  assert.ok(spawnCall >= 0 && libRs.indexOf("let validated =") < spawnCall,
    "校验必须先于 spawn");
  assert.match(uiHtml, /realm\.advertisedOrigin/);
  assert.match(uiHtml, /realm\.lanBind/);
  assert.match(uiHtml, /LAN 分享地址已配置/);
  assert.match(uiHtml, /LAN 绑定地址/);
  assert.match(uiHtml, /invoke\("validate_advertised_origin"/);
  assert.match(uiHtml, /invoke\("validate_lan_bind"/);
  assert.match(uiHtml, /邀请链接仅本机可用/);
});

test("host protocol and web layer keep the LAN security posture", () => {
  // host 协议帧不含连接串（pgUrl 只出现在 launcher 内部）。
  assert.ok(!hostMjs.includes("postgresql://"), "host must not emit connection strings");
  // launcher 不把 0.0.0.0 当默认；0.0.0.0 只在显式 lanBind 下接受且有警告。
  assert.match(launcherMjs, /HOST_BIND: input\.hostBind \?\? "127\.0\.0\.1"/);
  assert.match(launcherMjs, /WARNING: LAN bind 0\.0\.0\.0/);
  // wrapper 收到 SIGTERM/SIGINT 时必须转发给 Vinext，避免残留监听进程。
  assert.match(devServerMjs, /process\.once\("SIGTERM"/);
  assert.match(devServerMjs, /child\.kill\(signal\)/);
  assert.match(devServerMjs, /child\.kill\("SIGKILL"\)/);
  // Web 端无 CORS 通配。
  const apiFiles = [];
  const walk = (dir) => {
    for (const entry of readdirSync(
      fileURLToPath(new URL(`../${dir}`, import.meta.url)),
      { withFileTypes: true },
    )) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith(".ts")) apiFiles.push(rel);
    }
  };
  walk("app/api");
  for (const file of apiFiles) {
    assert.doesNotMatch(read(file), /Access-Control-Allow-Origin/i, `${file} must not set CORS headers`);
  }
  // 会话 cookie 属性钉住。
  const auth = read("modules/identity/auth.ts");
  assert.match(auth, /HttpOnly/);
  assert.match(auth, /SameSite=Lax/);
});
