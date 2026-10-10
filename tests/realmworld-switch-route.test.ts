/**
 * POST /api/realmworld/switch-version 的路由级负路径（无 DB）：
 * 幂等键/body/operation/identity 校验、无 runtime 配置 503、无 trust-store
 * 配置 503。正路径与状态矩阵验收在 tests/postgres-realmworld-version.test.ts
 *（scratch PG 套件）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { POST as switchVersion } from "../app/api/realmworld/switch-version/route.ts";

const call = (init?: {
  headers?: Record<string, string>;
  body?: unknown;
}) => switchVersion(new Request("http://127.0.0.1/api/realmworld/switch-version", {
  method: "POST",
  headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  ...(init?.body !== undefined
    ? { body: typeof init.body === "string" ? init.body : JSON.stringify(init.body) }
    : {}),
}));

test("switch-version route: idempotency-key 必填且长度有界", async () => {
  const missing = await call({ body: { recordId: "record_x", targetWorldVersion: "1.3.0", operation: "upgrade" } });
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error.code, "INVALID_IDEMPOTENCY_KEY");
  const tooLong = await call({
    headers: { "idempotency-key": "k".repeat(129) },
    body: { recordId: "record_x", targetWorldVersion: "1.3.0", operation: "upgrade" },
  });
  assert.equal(tooLong.status, 400);
});

test("switch-version route: body/operation/identity 校验 fail-closed 400", async () => {
  const notJson = await call({ headers: { "idempotency-key": "k1" }, body: "{bad json" });
  assert.equal(notJson.status, 400);
  const notObject = await call({ headers: { "idempotency-key": "k2" }, body: [1] });
  assert.equal(notObject.status, 400);
  const badOperation = await call({
    headers: { "idempotency-key": "k3" },
    body: { recordId: "record_x", targetWorldVersion: "1.3.0", operation: "sideways" },
  });
  assert.equal(badOperation.status, 400);
  assert.equal((await badOperation.json()).error.code, "INVALID_REQUEST");
  const badIdentity = await call({
    headers: { "idempotency-key": "k4" },
    body: { recordId: "record_x", targetWorldVersion: "1.3.0 ", operation: "upgrade" },
  });
  assert.equal(badIdentity.status, 400);
});

test("switch-version route: 无 runtime DB 配置 → 503 fail-closed", async () => {
  const saved = process.env.REALM_RUNTIME_DATABASE_URL;
  delete process.env.REALM_RUNTIME_DATABASE_URL;
  try {
    const response = await call({
      headers: { "idempotency-key": "k5" },
      body: { recordId: "record_x", targetWorldVersion: "1.3.0", operation: "upgrade" },
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, "RUNTIME_NOT_PROVISIONED");
  } finally {
    if (saved !== undefined) process.env.REALM_RUNTIME_DATABASE_URL = saved;
  }
});
