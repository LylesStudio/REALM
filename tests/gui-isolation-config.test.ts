import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = readFileSync(resolve(root, "playwright.config.ts"), "utf8");
const runner = readFileSync(resolve(root, "scripts/test-gui-with-scratch.mjs"), "utf8");
const scratchConfig = readFileSync(resolve(root, "scripts/gui-scratch-config.mjs"), "utf8");
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

test("write-capable Playwright runs are gated by the disposable GUI runner", () => {
  assert.match(config, /REALM_GUI_SCRATCH\s*===\s*["']1["']/);
  assert.match(config, /process\.argv[\s\S]*--list/);
  assert.match(runner, /REALM_GUI_SCRATCH:\s*["']1["']/);
});

test("fake-provider GUI uses a private custom-openai profile under REALM_DATA_HOME", () => {
  assert.match(runner, /createFakeProviderProfile/);
  assert.match(scratchConfig, /providerId:\s*["']custom-openai["']/);
  assert.match(runner, /model-provider\.json/);
  assert.match(runner, /REALM_DATA_HOME:\s*stateDirectory/);
  assert.match(runner, /REALM_DETERMINISTIC_FAKE_PROVIDER/);
});

test("targeted advertised-origin GUI run requires the exact TEST-NET fixture", () => {
  assert.match(runner, /resolveGuiTestAdvertisedOrigin/);
  assert.match(runner, /targetsGuiAdvertisedOriginSpec/);
  assert.match(scratchConfig, /http:\/\/192\.0\.2\.10:9999/);
  assert.match(packageJson.scripts["test:gui:origin"] ?? "", /REALM_GUI_TEST_ADVERTISED_ORIGIN/);
});

test("F7 operator fixture marker derives only from the exact-target resolver (never host env)", () => {
  // marker 存在于 testEnv，且唯一来源是 resolver 结果的显式派生。
  assert.match(runner, /const guiOperatorFixture = resolveGuiTestOperatorPrincipals\(args\)/);
  assert.match(runner, /REALM_GUI_OPERATOR_FIXTURE:\s*"1"/);
  assert.ok(
    !/process\.env\.REALM_GUI_OPERATOR_FIXTURE/.test(runner),
    "runner 不得读取/透传宿主 REALM_GUI_OPERATOR_FIXTURE",
  );
  assert.ok(
    !/testEnv[\s\S]{0,600}process\.env\.REALM_OPERATOR_PRINCIPALS/.test(runner),
    "runner 不得向 testEnv 透传宿主 REALM_OPERATOR_PRINCIPALS",
  );
});

test("F7 positive journey skips only on the runner marker; with fixture, 403 fails instead of skip", () => {
  const spec = readFileSync(resolve(root, "tests/gui/f-comfyui-operator.spec.ts"), "utf8");
  // skip 条件必须是 marker（在 API probe 之前）。
  assert.match(spec, /REALM_GUI_OPERATOR_FIXTURE/);
  assert.ok(
    !spec.includes("gateProbe.status() === 403"),
    "正向 journey 不得以 403 probe 作为 skip 条件（会掩盖授权回归）",
  );
  // marker 存在时 GET 必须断言 200（403 = 失败而非跳过）。
  assert.match(spec, /gateProbe\.status\(\)[\s\S]{0,120}toBe\(200\)/);
  // 负向 journey 无条件运行（不得带 marker skip）。
  const negativeIndex = spec.indexOf("普通玩家无表单/动作");
  const skipIndex = spec.indexOf("test.skip(");
  assert.ok(skipIndex > -1 && negativeIndex > skipIndex, "skip 门必须在正向用例内、负向用例之前");
});
