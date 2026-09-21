/**
 * 图谱自动刷新围栏——批次 T11-A2 起为实现后正向契约（本文件在 T10-B22-A
 * 时是 deferred 资格负断言，历史形态见 Git 记录）。
 *
 * T11-A2（docs/development/T11-A2-GRAPH-SSE-INVALIDATION.md）已实现
 * graph-specific SSE 自动刷新：持久化失效账本 + LISTEN/NOTIFY 唤醒 +
 * 既有 GET 权威回读。本测试锚定：①T10-B10 手动刷新闭环仍在位；
 * ②面板订阅正确的 graph-specific route（不冒充 record/events）；
 * ③SSE route 清单含且仅含三条；④读 API 不夹带游标（契约分工不变）；
 * ⑤实现规范的关键不变量在位。只解析目标文件的目标原语，不做全仓
 * 字符串禁用（注释/文档字样合法）。
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const PANEL = "app/components/knowledge-graph-panel.tsx";
const GRAPH_EVENTS_ROUTE = "app/api/world-knowledge/events/route.ts";

function walkSources(directory) {
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(entry.name)) files.push(path);
    }
  };
  walk(directory);
  return files;
}

test("the manual refresh loop from T10-B10-A stays intact", () => {
  const panel = readFileSync(join(projectRoot, PANEL), "utf8");
  // 显式按钮与双端点一致性（aria-label 已接入 i18n 键表，zh 渲染仍为「刷新图谱」）。
  assert.match(panel, /aria-label=\{uiText\("ui\.knowledge\.refresh", uiLanguage\)\}/);
  assert.match(panel, /Promise\.all/);
  assert.match(panel, /\/api\/world-knowledge\$\{query\}/);
  assert.match(panel, /\/api\/canon\$\{query\}/);
  assert.match(panel, /cache: "no-store"/);
  assert.match(panel, /encodeURIComponent\(worldId\)/);
  // 竞态/卸载/状态机语义。
  assert.match(panel, /loadSeqRef/);
  assert.match(panel, /mountedRef/);
  assert.match(panel, /loadedOnce/);
  assert.match(panel, /setLoading\(true\)/);
  // 失败提示与重试路径（notice 文案已接入 i18n 键表，zh 渲染仍为原文）。
  assert.match(panel, /uiText\("ui\.knowledge\.loadFailed", readUiLanguage\(\)\)/);
});

test("the panel subscribes the graph-specific SSE route and never record events", () => {
  const panel = readFileSync(join(projectRoot, PANEL), "utf8");
  // T11-A2：面板必须订阅 graph-specific route，事件只触发权威回读。
  assert.match(panel, /new EventSource\(\s*`\/api\/world-knowledge\/events\?worldId=/);
  assert.match(panel, /addEventListener\("graph-invalidation"/);
  // 突发合并（防抖）与卸载/worldId 变化关闭。
  assert.match(panel, /clearTimeout\(refreshTimerRef\.current\)/);
  assert.match(panel, /source\.close\(\)/);
  // 绝不订阅记录级 SSE，无轮询定时器。
  assert.doesNotMatch(panel, /\/api\/record\/events/);
  assert.doesNotMatch(panel, /setInterval/);
});

test("the SSE route set is exactly record events, record preview, lobby and graph invalidation", () => {
  // 全 app/api 的 SSE route 清单——出现未登记的新推送通道即评审。
  // record/events 与 record/preview 语义不变（record-scoped）；
  // lobby/events 是大厅失效唤醒（帧只携带 workspace 标记，无房间内容）；
  // world-knowledge/events 走账本重放。
  const sseRoutes = [];
  for (const path of walkSources(join(projectRoot, "app", "api"))) {
    if (/text\/event-stream/.test(readFileSync(path, "utf8"))) {
      sseRoutes.push(relative(projectRoot, path));
    }
  }
  assert.deepEqual(sseRoutes.sort(), [
    "app/api/lobby/events/route.ts",
    "app/api/record/events/route.ts",
    "app/api/record/preview/route.ts",
    "app/api/world-knowledge/events/route.ts",
  ]);
});

test("graph read APIs stay cursor-free; the invalidation contract lives in the ledger", () => {
  // 契约分工：GET 仍是权威快照（不夹带游标），cursor/replay 由账本+SSE 承担。
  const knowledge = readFileSync(
    join(projectRoot, "app/api/world-knowledge/route.ts"),
    "utf8",
  );
  assert.doesNotMatch(knowledge, /snapshotVersion|graphCursor|ETag/i);
  const canon = readFileSync(join(projectRoot, "app/api/canon/route.ts"), "utf8");
  assert.doesNotMatch(canon, /snapshotVersion|graphCursor|ETag/i);
  // 账本与唤醒机制的持久化证据：迁移 0024 + NOTIFY 仅唤醒的注释纪律。
  const migration = readFileSync(
    join(projectRoot, "database/postgres/migrations/0024_graph_invalidation_events.sql"),
    "utf8",
  );
  assert.match(migration, /CREATE TABLE IF NOT EXISTS graph_invalidation_events/);
  assert.match(migration, /GENERATED ALWAYS AS IDENTITY/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  const route = readFileSync(join(projectRoot, GRAPH_EVENTS_ROUTE), "utf8");
  assert.match(route, /LISTEN \$\{GRAPH_INVALIDATION_CHANNEL\}/);
  assert.match(route, /Last-Event-ID/);
});

test("the T11-A2 spec keeps the ledger-first invariants", () => {
  const doc = readFileSync(
    join(projectRoot, "docs/development/T11-A2-GRAPH-SSE-INVALIDATION.md"),
    "utf8",
  );
  assert.match(doc, /graph_invalidation_events/);
  assert.match(doc, /NOTIFY 只是低延迟唤醒|NOTIFY 仅作/);
  assert.match(doc, /事务回滚则失效记录同样\s*回滚/);
  // T10-B22-A 评审文档是历史记录（当时结论），不静默改写。
  const review = readFileSync(
    join(projectRoot, "docs/development/T10-B22-A-GRAPH-AUTO-REFRESH-REVIEW.md"),
    "utf8",
  );
  assert.match(review, /维持手动刷新/);
});
