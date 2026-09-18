/**
 * 大厅契约（lobby-contract）：静态钉住安全与接线，不起服务。
 *
 * - 路由：principal 只经 resolveRequestPrincipal（无 body userId 信任）；
 *   密码只在 join 的 body.password；路由/服务源码不含把密码写进
 *   URL/日志的形态；
 * - 列表白名单字段（无 password_hash/host_principal_id 透出）；
 * - SSE 事件只作失效信号（changed/snapshot 帧不携带房间内容）；
 * - scrypt 格式与 timingSafeEqual；迁移 0045 的 RLS/GRANT 边界；
 * - UI：header 大厅入口、lobby-panel 关键状态（创建/加入/离开/关闭/
 *   离线提示/阶段声明）与 i18n 三语完整。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { uiMessageTable } from "../modules/i18n/public.ts";

const read = (path) =>
  readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");

const route = read("app/api/lobby/route.ts");
const eventsRoute = read("app/api/lobby/events/route.ts");
const service = read("modules/application/lobby-service.ts");
const panel = read("app/components/lobby-panel.tsx");
const realmClient = read("app/realm-client.tsx");
const migration = read("database/postgres/migrations/0045_lobby_rooms.sql");

test("路由：principal 只来自 session；密码只在 body；无 URL/日志泄漏形态", () => {
  assert.match(route, /resolveRequestPrincipal\(request, LOCAL_RECORD_SCOPE\.principalId\)/);
  assert.ok(!/body\.userId|body\.principal/.test(route), "不得信任客户端身份字段");
  assert.match(route, /NOT_MEMBER/);
  // 密码只从 POST body 的 password 字段读取；不得出现在 URL/searchParams。
  assert.ok(!/searchParams.*password|password.*searchParams/.test(route));
  assert.ok(!eventsRoute.includes("password"), "SSE 路由不得接触密码");
  // 服务/路由不得把密码写日志。
  assert.ok(!/console\.(log|error|warn)[^)]*password/i.test(service));
  assert.ok(!/console\.(log|error|warn)[^)]*password/i.test(route));
});

test("字段白名单：summary 无 hash/principal；服务不含明文存储路径", () => {
  // 列表组装的返回对象键集合。
  const shape = service.slice(
    service.indexOf("return result.rows.map((row) => ({"),
    service.indexOf("}));", service.indexOf("return result.rows.map((row) => ({")),
  );
  assert.ok(!shape.includes("password_hash"), "summary 不得透出 password_hash");
  assert.ok(!shape.includes("principal_id"), "summary 不得透出 principal id");
  assert.ok(shape.includes("hasPassword"), "hasPassword 布尔标记必须存在");
  // scrypt + timingSafeEqual；无明文比较。格式串由常量插值生成。
  assert.match(service, /`scrypt:\$\{SCRYPT_N\}:\$\{SCRYPT_R\}:\$\{SCRYPT_P\}:/);
  assert.match(service, /const SCRYPT_N = 16384;/);
  assert.match(service, /timingSafeEqual/);
  assert.match(service, /password\.length > 80/);
  // 校验路径必须走 verifyRoomPassword（无明文相等比较形态）。
  assert.ok(!/===\s*password|password\s*===\s*[^"]/i.test(service.replaceAll("input.password", "")), "不得明文比较密码");
  // 世界绑定：owner-only 校验 + 加入同事务写 membership（幂等）。
  assert.match(service, /AND role = 'owner'/);
  assert.match(service, /NOT_WORLD_OWNER/);
  assert.match(service, /INSERT INTO player_world_memberships/);
  assert.match(service, /ON CONFLICT \(workspace_id, world_id, principal_id\) DO NOTHING/);
  // 成员计数必须走单次聚合 JOIN，不退回逐房相关子查询。
  assert.match(service, /COALESCE\(member_counts\.member_count/);
  assert.match(service, /GROUP BY member\.workspace_id, member\.room_id/);
});

test("租约：服务端时钟权威 + lazy reap 边界 + 心跳只续本人房间", () => {
  // 服务层：租约用数据库时钟（CURRENT_TIMESTAMP/interval），无 Date.now()
  // 决定权威状态；客户端本地时间不参与。
  assert.ok(!/Date\.now\(\)/.test(service.slice(service.indexOf("async function heartbeat"))),
    "心跳/回收不得用客户端或进程本地时间作权威");
  assert.match(service, /lease_expires_at IS NOT NULL/);
  assert.match(service, /lease_expires_at <= CURRENT_TIMESTAMP/);
  // 心跳：WHERE host_principal_id 限定本人房间；过期不复活（> CURRENT_TIMESTAMP）。
  const beat = service.slice(
    service.indexOf("async function heartbeat"),
    service.indexOf("reapExpired(scope"),
  );
  assert.match(beat, /host_principal_id = \$2/);
  assert.match(beat, /lease_expires_at > CURRENT_TIMESTAMP/);
  // lazy reap 挂在权威读/写（list/join）与 SSE tick，无 setInterval 常驻后台
  // 在服务层自身。
  assert.ok(!/setInterval|setTimeout/.test(service), "服务层不得自带常驻 timer");
  const events = read("app/api/lobby/events/route.ts");
  assert.match(events, /reapExpired/);
  assert.match(events, /REALM_LOBBY_REAP_MS/);
  // 迁移 0047：只加列不加权限面。
  const lease = read("database/postgres/migrations/0047_lobby_host_lease.sql");
  assert.match(lease, /ADD COLUMN IF NOT EXISTS lease_expires_at/);
  assert.ok(!/GRANT|REVOKE/.test(lease), "0047 不得新增授权");
});


test("邀请链路：链接最小化、深链只导航不授权、分享 fallback 完整", () => {
  // 链接构建：校验后的分享来源（显式 advertised origin 优先，回退当前
  // 浏览器 origin）+ 不透明 roomId；绝不含密码/token/session/凭据形态。
  const linkFn = panel.slice(
    panel.indexOf("function shareOrigin"),
    panel.indexOf("async function shareRoom"),
  );
  assert.match(linkFn, /advertisedOrigin \?\? window\.location\.origin/);
  assert.match(linkFn, /searchParams\.set\("lobby", roomId\)/);
  assert.ok(!/password|token|session|principal|secret/i.test(linkFn), "邀请链接不得携带凭据字段");
  // 深链只作导航：realm-client 读取后剥离参数；面板邀请 effect 内无 join 调用。
  assert.match(realmClient, /searchParams\.get\("lobby"\)/);
  assert.match(realmClient, /cleaned\.searchParams\.delete\("lobby"\)/);
  assert.match(realmClient, /setLobbyInvite\(inviteRoomId\)/);
  assert.match(realmClient, /setLobbyOpen\(true\)/);
  assert.match(realmClient, /inviteRoomId=\{lobbyInvite\}/);
  const inviteEffect = panel.slice(
    panel.indexOf("// 命中后滚动到目标房间"),
    panel.indexOf("useEffect(() => {\n    mountedRef", panel.indexOf("// 命中后滚动到目标房间")),
  );
  assert.ok(!/join-room|send\(/.test(inviteEffect), "邀请落地绝不自动加入");
  // 失效稳定状态 + 可关闭提示；关闭/过期房间仍由列表状态呈现（不额外泄露）。
  assert.match(panel, /ui\.lobby\.inviteMissing/);
  assert.match(panel, /is-invite-target/);
  assert.match(panel, /data-room-id/);
  assert.match(panel, /querySelectorAll<HTMLElement>\("\[data-room-id\]"\)/);
  assert.match(panel, /element\.dataset\.roomId === inviteRoomId/);
  assert.ok(!panel.includes('querySelector(`[data-room-id="${inviteRoomId}"]`)'), "邀请参数不得拼接进 CSS 选择器");
  // 分享三级 fallback：Web Share → clipboard → 手动复制行；AbortError 不算失败。
  assert.match(panel, /navigator\.share/);
  assert.match(panel, /navigator\.clipboard\?\.writeText/);
  assert.match(panel, /AbortError/);
  assert.match(panel, /setManualShare\(room\.id\)/);
  assert.match(panel, /lobby-share-manual/);
  // 分享按钮只在册成员可见。
  assert.match(panel, /room\.viewerRole !== null \? \(\s*<button[\s\S]*?ui\.lobby\.share/);
  // 写入成功后权威重读；离开已展开房间时只重读列表，避免 NOT_MEMBER 污染全局状态。
  assert.match(panel, /body\.kind === "leave-room" \? undefined : expanded/);
  assert.match(panel, /body\.kind === "leave-room" && body\.roomId === expanded/);
  assert.match(panel, /setExpanded\(null\)/);
});

test("迁移 0046：世界绑定为可空 FK，不动 0045 既有表结构语义", () => {
  const link = read("database/postgres/migrations/0046_lobby_room_world_link.sql");
  assert.match(link, /ADD COLUMN IF NOT EXISTS world_id/);
  assert.match(link, /REFERENCES worlds \(workspace_id, id\) ON DELETE CASCADE/);
  assert.ok(!/DROP TABLE|DROP COLUMN/.test(link));
  // 0045 文件未被本批改写（只读核对）。
  assert.match(migration, /CREATE TABLE IF NOT EXISTS lobby_rooms/);
  assert.ok(!migration.includes("world_id"), "0045 不得被回填 world_id（走 0046）");
});

test("迁移 0045：RLS/GRANT 边界与世界零耦合", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS lobby_rooms/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS lobby_room_members/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE ON lobby_rooms TO realm_runtime/);
  assert.ok(!/GRANT .*DELETE/i.test(migration), "realm_runtime 不得获得 DELETE");
  // 与 World/Story/Record 无外键耦合（只有 workspaces FK）。
  assert.ok(!/REFERENCES (worlds|stories|records)\b/.test(migration));
  assert.ok(!/GRANT .*TO realm_transfer/i.test(migration), "transfer 角色不得读大厅");
});

test("UI 入口与状态完整；i18n 三语；SSE 帧只作失效信号", () => {
  // header 入口 + overlay 接线。
  assert.match(realmClient, /setLobbyOpen\(true\)/);
  assert.match(realmClient, /<LobbyPanel/);
  assert.match(realmClient, /function openLibrary\(\)[\s\S]*setLobbyOpen\(false\)[\s\S]*setLibraryOpen\(true\)/);
  assert.match(realmClient, /function openLobby\(\)[\s\S]*setLibraryOpen\(false\)[\s\S]*setLobbyOpen\(true\)/);
  assert.match(realmClient, /uiText\("ui\.header\.lobby"/);
  // 面板关键状态：创建表单/错误/离线提示/阶段声明/成员列表。
  for (const marker of [
    "submitCreate",
    "join-room",
    "leave-room",
    "close-room",
    "ui.lobby.offline",
    "ui.lobby.stageNote",
    'EventSource("/api/lobby/events")',
    "ui.lobby.leaseNote",
  ]) {
    assert.ok(panel.includes(marker), `lobby-panel 缺 ${marker}`);
  }
  // P1-3：大厅 SSE effect 只随 load 重建——expanded 经 ref 读取，
  // 展开/收起不拆建 EventSource、不重复 GET/LISTEN。
  const sseEffect = panel.slice(
    panel.indexOf('const source = new EventSource("/api/lobby/events")'),
    panel.indexOf("async function send"),
  );
  assert.match(sseEffect, /expandedRef\.current/);
  assert.match(panel, /const expandedRef = useRef/);
  assert.match(sseEffect, /\}, \[load\]\);/, "SSE effect 依赖必须只是 [load]");
  assert.ok(!/\}, \[load, expanded\]\);/.test(panel), "expanded 不得再进 SSE effect 依赖");

  // SSE 帧不含房间内容字段。
  assert.ok(!eventsRoute.includes("roomId"), "changed/snapshot 帧不得携带房间内容");
  // 前端心跳：realm-client 根组件 interval + 卸载清理。
  assert.match(realmClient, /kind: "heartbeat"/);
  assert.match(realmClient, /window\.setInterval\(beat, lobbyHeartbeatMs\)/);
  assert.match(realmClient, /window\.clearInterval\(timer\)/);
  // i18n 三语完整。
  const keys = [
    "ui.lobby.leaseNote",
    "ui.lobby.leaseNoteShort",
    "ui.lobby.share",
    "ui.lobby.shareDone",
    "ui.lobby.shareCopied",
    "ui.lobby.shareManual",
    "ui.lobby.shareManualLabel",
    "ui.lobby.inviteMissing",
    "ui.lobby.inviteDismiss",
    "ui.header.lobby",
    "ui.lobby.title",
    "ui.lobby.create",
    "ui.lobby.join",
    "ui.lobby.leave",
    "ui.lobby.closeRoom",
    "ui.lobby.errPassword",
    "ui.lobby.errFull",
    "ui.lobby.errClosed",
  ];
  for (const key of keys) {
    const table = uiMessageTable(key);
    assert.ok(table, `missing key: ${key}`);
    for (const language of ["zh-CN", "en", "ja"]) {
      assert.ok(table[language]?.trim(), `${key} 缺 ${language}`);
    }
  }
});
