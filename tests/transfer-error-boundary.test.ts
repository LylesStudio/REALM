/**
 * P1-11 transfer 错误边界：内部异常不回显原始 message；领域错误与成功
 * 路径协议不变。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { transferRouteError } from "../app/api/world/transfer-shared.ts";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WorldImportError } from "../modules/application/world-import-service.ts";

async function errorBody(response: Response) {
  return (await response.json()) as {
    ok: boolean;
    error: { code: string; message: string; details?: unknown };
  };
}

test("transfer errors: internal failures get a static generic message", async () => {
  for (const internal of [
    new Error("internal database failure marker: SHOULD_NOT_LEAK"),
    new Error("internal schema failure marker: SHOULD_NOT_LEAK"),
    new Error("internal decompression failure marker: SHOULD_NOT_LEAK"),
    "not-even-an-error",
  ]) {
    const response = transferRouteError(internal);
    assert.equal(response.status, 500);
    const body = await errorBody(response);
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "INTERNAL");
    assert.equal(
      body.error.message,
      "The transfer operation failed.",
      "内部异常必须返回静态通用文案",
    );
    assert.ok(!body.error.message.includes("SHOULD_NOT_LEAK"), "不得泄漏内部异常详情");
    assert.ok(!("details" in body.error), "内部异常不得带 details");
  }
});

test("transfer errors: domain errors keep their code and safe message", async () => {
  const domain = new WorldImportError(
    "MIGRATION_REQUIRED",
    "target database is missing required migrations",
    { missing: ["0042_realm_transfer_and_import_jobs.sql"] },
  );
  const response = transferRouteError(domain);
  assert.equal(response.status, 503);
  const body = await errorBody(response);
  assert.equal(body.error.code, "MIGRATION_REQUIRED");
  assert.equal(body.error.message, "target database is missing required migrations");
  assert.deepEqual(body.error.details, {
    missing: ["0042_realm_transfer_and_import_jobs.sql"],
  });
});

test("import debug scan channel is removed (no table structure in logs)", () => {
  const source = readFileSync(
    fileURLToPath(
      new URL("../modules/application/world-import-service.ts", import.meta.url),
    ),
    "utf8",
  );
  assert.ok(!source.includes('"SCAN"'), "SCAN 调试输出必须删除");
  assert.ok(!source.includes("REALM_DEBUG_SCAN"), "REALM_DEBUG_SCAN 通道必须删除");
});
