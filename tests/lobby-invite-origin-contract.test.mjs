/**
 * advertised origin 契约（lobby-invite-origin-contract）。
 *
 * 钉住信任边界：显式 REALM_ADVERTISED_ORIGIN 校验矩阵；绝不读
 * Host/X-Forwarded-Host；邀请链接只含校验后的 origin + roomId；
 * loopback 无配置时的本机可用提示；非法配置的诊断与回退。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  advertisedOriginFromEnv,
  isLoopbackOrigin,
  normalizeAdvertisedOrigin,
} from "../modules/application/advertised-origin.ts";
import { uiMessageTable } from "../modules/i18n/public.ts";

const read = (path) =>
  readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");

const panel = read("app/components/lobby-panel.tsx");
const route = read("app/api/lobby/route.ts");
const eventsRoute = read("app/api/lobby/events/route.ts");
const launcher = read("launcher/realm-launcher.mjs");

test("normalizeAdvertisedOrigin：合法/非法矩阵", () => {
  assert.deepEqual(normalizeAdvertisedOrigin(undefined), { origin: null, invalid: false });
  assert.deepEqual(normalizeAdvertisedOrigin("  "), { origin: null, invalid: false });
  assert.deepEqual(
    normalizeAdvertisedOrigin("http://192.168.1.20:9999"),
    { origin: "http://192.168.1.20:9999", invalid: false },
  );
  assert.deepEqual(
    normalizeAdvertisedOrigin(" https://realm.example.cn/ "),
    { origin: "https://realm.example.cn", invalid: false },
  );
  for (const bad of [
    "ftp://192.168.1.20",
    "http://user:pass@192.168.1.20:9999",
    "http://token@192.168.1.20",
    "http://192.168.1.20:9999?token=x",
    "http://192.168.1.20:9999#frag",
    "http://192.168.1.20:9999/path",
    "not-a-url",
    "http://",
  ]) {
    const result = normalizeAdvertisedOrigin(bad);
    assert.equal(result.origin, null, `${bad} 必须拒绝`);
    assert.equal(result.invalid, true, `${bad} 必须标 invalid`);
  }
  assert.deepEqual(
    advertisedOriginFromEnv({ REALM_ADVERTISED_ORIGIN: "http://10.0.0.8:9999" }),
    { origin: "http://10.0.0.8:9999", invalid: false },
  );
  assert.deepEqual(advertisedOriginFromEnv({}), { origin: null, invalid: false });
});

test("loopback 判定只用于提示（不参与授权）", () => {
  assert.equal(isLoopbackOrigin("http://127.0.0.1:9999"), true);
  assert.equal(isLoopbackOrigin("http://localhost:9999"), true);
  assert.equal(isLoopbackOrigin("http://[::1]:9999"), true);
  assert.equal(isLoopbackOrigin("http://192.168.1.20:9999"), false);
  assert.equal(isLoopbackOrigin("not-a-url"), true, "非法 origin 按 loopback 处理（提示保守）");
});

test("服务端绝不信任 Host/X-Forwarded-Host；邀请链接用校验后的 origin", () => {
  for (const source of [route, eventsRoute, panel]) {
    assert.ok(
      // 注释里的说明文字不算；只钉真实读取调用。
      !/headers\.get\(\s*["']x-forwarded-host["']/i.test(source)
        && !/headers\.get\(\s*["']host["']/i.test(source),
      "不得读取 Host/X-Forwarded-Host 头",
    );
  }
  // 路由 meta 只输出校验后的 advertisedOrigin/诊断位。
  assert.match(route, /advertisedOriginFromEnv\(\)/);
  assert.match(route, /advertisedOriginInvalid/);
  // 面板：分享来源 = advertisedOrigin ?? 当前 origin；loopback 无配置有提示。
  assert.match(panel, /advertisedOrigin \?\? window\.location\.origin/);
  assert.match(panel, /ui\.lobby\.originLoopback/);
  assert.match(panel, /ui\.lobby\.originInvalid/);
  assert.match(panel, /ui\.lobby\.originLabel/);
  assert.match(panel, /lobby-origin-note/);
  // launcher 白名单透出该非敏感配置。
  assert.match(launcher, /"REALM_ADVERTISED_ORIGIN"/);
  // 三语完整。
  for (const key of ["ui.lobby.originLoopback", "ui.lobby.originInvalid", "ui.lobby.originLabel"]) {
    const table = uiMessageTable(key);
    assert.ok(table, `missing key: ${key}`);
    for (const language of ["zh-CN", "en", "ja"]) {
      assert.ok(table[language]?.trim(), `${key} 缺 ${language}`);
    }
  }
});
