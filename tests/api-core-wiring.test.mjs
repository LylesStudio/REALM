import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function readProjectFile(relativePath) {
  return readFileSync(
    fileURLToPath(new URL(`../${relativePath}`, import.meta.url)),
    "utf8",
  );
}

const recordRoute = readProjectFile("app/api/record/route.ts");
const messageRoute = readProjectFile("app/api/record/messages/route.ts");
const eventsRoute = readProjectFile("app/api/record/events/route.ts");
const service = readProjectFile("modules/application/local-record-service.ts");

test("GET, POST and SSE delegate through one local Application Service", () => {
  assert.match(recordRoute, /service\.loadRecord\(/);
  assert.match(messageRoute, /service\.submitMessage\(/);
  assert.match(eventsRoute, /service\.listCommittedEvents\(/);
  for (const route of [recordRoute, messageRoute, eventsRoute]) {
    assert.match(route, /local-record-service\.ts/);
    assert.doesNotMatch(route, /record-store|story-record|createD1|submitPlayerTurn/);
  }
});

test("the service uses PostgreSQL Runtime and Delivery ports without request seeding", () => {
  assert.match(service, /createPostgresRuntimeRepository/);
  assert.match(service, /createPostgresDeliveryProjectionRepository/);
  assert.match(service, /executeTurn\(/);
  assert.match(service, /REALM_RUNTIME_DATABASE_URL/);
  assert.doesNotMatch(service, /seedPostgresDemo|process\.env\.DATABASE_URL/);
});

test("request bodies cannot select Workspace, Principal or canonical version", () => {
  assert.doesNotMatch(messageRoute, /workspaceId\??:/);
  assert.doesNotMatch(messageRoute, /principalId\??:/);
  assert.doesNotMatch(messageRoute, /expectedVersion\??:/);
  assert.match(messageRoute, /writeToken/);
  assert.match(service, /LOCAL_RECORD_SCOPE/);
  assert.match(service, /expectedRecordVersion: authorization\.expectedRecordVersion/);
});

test("committed SSE uses only the projected delivery cursor", () => {
  assert.match(eventsRoute, /Last-Event-ID/);
  assert.match(eventsRoute, /afterOrdinal/);
  assert.match(eventsRoute, /event: committed/);
  assert.doesNotMatch(eventsRoute, /candidate|contextManifest|listCommittedEvents\s*\(.*repository/);
});

test("unknown server errors return stable safe messages", () => {
  assert.match(messageRoute, /The local runtime could not complete this request\./);
  assert.match(recordRoute, /The local runtime could not read this Record\./);
  assert.match(eventsRoute, /The local committed-event stream could not be opened\./);
  for (const route of [recordRoute, messageRoute, eventsRoute]) {
    assert.doesNotMatch(route, /error instanceof Error \? error\.message/);
  }
});

/**
 * 批次 T10-B4：D1 退役围栏。D1 兼容链（db/record-store.ts、
 * db/story-record-repository.ts、db/schema.ts、drizzle/）保留为迁移参考，
 * 但任何活动 API 路由不得导入它们——静态扫描全部 route 文件。
 */
test("active API routes never import the retired D1 compatibility chain", () => {
  const apiRoot = fileURLToPath(new URL("../app/api", import.meta.url));
  const routeFiles = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === "route.ts") routeFiles.push(path);
    }
  };
  walk(apiRoot);
  assert.ok(routeFiles.length >= 10, "sanity: 应扫描到全部活动路由");

  const offenders = [];
  for (const file of routeFiles) {
    const source = readFileSync(file, "utf8");
    if (
      /from\s+["'][^"']*(record-store|story-record-repository|db\/schema|drizzle)/.test(source)
      || /createD1|submitPlayerTurn/.test(source)
    ) {
      offenders.push(file);
    }
  }
  assert.deepEqual(offenders, []);
});

/**
 * 批次 T10-B7：library/generate/import 路由全量下沉受限角色共享池——
 * 迁移 0023 补齐最小授权后不再引用 owner DATABASE_URL/owner pool。
 */
test("library, world-generate and import routes run only on the shared runtime pool", () => {
  for (const path of [
    "app/api/library/route.ts",
    "app/api/world/generate/route.ts",
    "app/api/library/import/route.ts",
    // 批次 T10-B8-A：残余 owner-pool 读路由同契约。
    "app/api/files/[id]/route.ts",
    "app/api/settings/language/route.ts",
    "app/api/auth/me/route.ts",
  ]) {
    const route = readProjectFile(path);
    assert.match(route, /REALM_RUNTIME_DATABASE_URL/);
    assert.match(route, /getSharedRuntimePool/);
    assert.doesNotMatch(route, /createLocalPostgresPool/);
    assert.doesNotMatch(route, /process\.env\.DATABASE_URL/);
  }
});
