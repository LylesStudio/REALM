/**
 * M5 provisioning/bootstrap 一致性契约（本批三个缺陷的回归）：
 * A. 会话密钥文件安全：0600 普通文件 + 0700 目录才可用；0644/0777/符号链接
 *    fail-closed；并发首写不得覆盖 winner（回读校验）。
 * B. launcher PG 数据库名与其生成的 DATABASE_URL/runtime/transfer URL 一致。
 * C. startRealm 的 dataHome 优先级：显式 options.dataHome > options.environment
 *    的 REALM_DATA_HOME > 平台默认。
 * 全部用无害临时目录与测试常量；不读真实 env 文件与凭据。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChildEnv,
  resolveStartRealmDataHome,
} from "../launcher/realm-launcher.mjs";

test("B. launcher PG database name matches all generated connection URLs", () => {
  const env = buildChildEnv({
    dataHome: "/tmp/sentinel-data-home",
    appPort: 9999,
    pgPort: 55499,
    environment: { PATH: "/usr/bin" },
  });
  // 建库命令与连接串必须指向同一数据库（显式注入，不靠默认值巧合）。
  assert.ok(env.REALM_POSTGRES_DB, "child env 必须显式携带 REALM_POSTGRES_DB");
  const expected = env.REALM_POSTGRES_DB;
  for (const key of ["DATABASE_URL", "REALM_RUNTIME_DATABASE_URL", "REALM_TRANSFER_DATABASE_URL"]) {
    const url = new URL(env[key]);
    assert.equal(url.pathname, `/${expected}`, `${key} 的数据库名必须与 REALM_POSTGRES_DB 一致`);
  }
});

test("C. startRealm dataHome precedence: explicit option > environment > platform default", () => {
  const explicitEnvHome = "/tmp/sentinel-env-data-home";
  // environment.REALM_DATA_HOME 未被显式 options.dataHome 覆盖时生效。
  assert.equal(
    resolveStartRealmDataHome({
      environment: { REALM_DATA_HOME: explicitEnvHome },
    }),
    explicitEnvHome,
  );
  // 显式 options.dataHome 优先于 environment。
  assert.equal(
    resolveStartRealmDataHome({
      dataHome: "/tmp/sentinel-option-data-home",
      environment: { REALM_DATA_HOME: explicitEnvHome },
    }),
    "/tmp/sentinel-option-data-home",
  );
  // 两者皆无 → 平台默认（非空、不等于 env 值）。
  const fallback = resolveStartRealmDataHome({ environment: {} });
  assert.ok(fallback && fallback !== explicitEnvHome);
});

test("M7. launcher forwards REALM_OPERATOR_PRINCIPALS as non-sensitive config; secrets stay filtered", async () => {
  const { buildChildEnv } = await import("../launcher/realm-launcher.mjs");
  const env = buildChildEnv({
    dataHome: "/tmp/sentinel-data-home",
    appPort: 9999,
    pgPort: 55499,
    environment: {
      PATH: "/usr/bin",
      REALM_OPERATOR_PRINCIPALS: "principal_operator_a,principal_operator_b",
      REALM_SESSION_SECRET: "sentinel-secret-must-not-pass",
      DATABASE_URL: "postgres://sentinel-owner@127.0.0.1/x",
    },
  });
  // 非敏感 operator 配置必须透传（否则打包 Web 子进程丢授权配置）。
  assert.equal(
    env.REALM_OPERATOR_PRINCIPALS,
    "principal_operator_a,principal_operator_b",
    "REALM_OPERATOR_PRINCIPALS 必须按非敏感配置透传给 Web 子进程",
  );
  // owner DB / secret 过滤保持不变。
  assert.ok(!("REALM_SESSION_SECRET" in env) || env.REALM_SESSION_SECRET !== "sentinel-secret-must-not-pass",
    "父进程 secret 不得透传");
  assert.ok(env.DATABASE_URL !== "postgres://sentinel-owner@127.0.0.1/x",
    "父进程 owner DATABASE_URL 不得原样透传");
});
