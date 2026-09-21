/**
 * launcher advertised origin 单测（无 PG/无子进程，纯函数 + 零副作用断言）。
 * 覆盖：参数优先级、非法值 fail-closed 且不 echo 原值、LAN 推导边界、
 * childEnv 注入、父环境敏感过滤。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildChildEnv,
  LauncherError,
  resolveAdvertisedOrigin,
} from "../launcher/realm-launcher.mjs";
import { normalizeAdvertisedOrigin } from "../launcher/advertised-origin.mjs";
import * as tsEntry from "../modules/application/advertised-origin.ts";

test("resolveAdvertisedOrigin：显式 > 环境 > LAN 推导 > null", () => {
  assert.equal(
    resolveAdvertisedOrigin({
      explicit: "https://realm.example.cn",
      environment: { REALM_ADVERTISED_ORIGIN: "http://10.0.0.9:9999" },
      lanBind: "192.168.1.20",
      appPort: 9999,
    }),
    "https://realm.example.cn",
    "显式值优先于环境与推导",
  );
  assert.equal(
    resolveAdvertisedOrigin({
      explicit: null,
      environment: { REALM_ADVERTISED_ORIGIN: "http://10.0.0.9:9999" },
      lanBind: "192.168.1.20",
      appPort: 9999,
    }),
    "http://10.0.0.9:9999",
    "环境值优先于推导",
  );
  assert.equal(
    resolveAdvertisedOrigin({
      explicit: null,
      environment: {},
      lanBind: "192.168.1.20",
      appPort: 10199,
    }),
    "http://192.168.1.20:10199",
    "具体 IPv4 LAN bind 推导",
  );
  for (const bind of ["0.0.0.0", "127.0.0.1", null]) {
    assert.equal(
      resolveAdvertisedOrigin({ explicit: null, environment: {}, lanBind: bind, appPort: 9999 }),
      null,
      `${bind} 不得推导可分享地址`,
    );
  }
});

test("非法 origin fail-closed 且错误不 echo 原值", () => {
  for (const bad of [
    "http://user:hunter2@192.168.1.20",
    "ftp://192.168.1.20",
    "http://192.168.1.20:9999/admin?token=abc",
  ]) {
    assert.throws(
      () => resolveAdvertisedOrigin({
        explicit: bad,
        environment: {},
        lanBind: null,
        appPort: 9999,
      }),
      (error) => {
        assert.ok(error instanceof LauncherError);
        assert.ok(!error.message.includes("hunter2"), "错误不得回显 userinfo 密码");
        assert.ok(!error.message.includes("token=abc"), "错误不得回显 query 凭据");
        return true;
      },
    );
  }
  // 环境变量中的非法值同样 fail-closed。
  assert.throws(() =>
    resolveAdvertisedOrigin({
      explicit: null,
      environment: { REALM_ADVERTISED_ORIGIN: "not-a-url" },
      lanBind: null,
      appPort: 9999,
    }), LauncherError);
});

test("TS 入口与 launcher 实现是同一函数（单一校验源）", () => {
  assert.equal(tsEntry.normalizeAdvertisedOrigin, normalizeAdvertisedOrigin);
  assert.equal(typeof tsEntry.advertisedOriginFromEnv, "function");
  assert.equal(typeof tsEntry.isLoopbackOrigin, "function");
});

test("childEnv 注入显式 origin；父环境敏感值仍被过滤", () => {
  const env = buildChildEnv({
    dataHome: "/tmp/x",
    appPort: 9999,
    pgPort: 55432,
    advertisedOrigin: "http://192.168.1.20:9999",
    environment: {
      PATH: "/usr/bin",
      REALM_ADVERTISED_ORIGIN: "http://env-should-not-win:1",
      REALM_ACCESS_TOKEN: "contract",
      OPENAI_API_KEY: "sk-contract",
    },
  });
  assert.equal(env.REALM_ADVERTISED_ORIGIN, "http://192.168.1.20:9999");
  assert.equal(env.REALM_ACCESS_TOKEN, undefined, "非 LAN 不透出令牌");
  assert.equal(env.OPENAI_API_KEY, undefined);
  // 无显式字段时白名单透传兜底。
  const passthrough = buildChildEnv({
    dataHome: "/tmp/x",
    appPort: 9999,
    pgPort: 55432,
    environment: { REALM_ADVERTISED_ORIGIN: "http://10.0.0.9:9999" },
  });
  assert.equal(passthrough.REALM_ADVERTISED_ORIGIN, "http://10.0.0.9:9999");
});
