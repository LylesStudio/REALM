import assert from "node:assert/strict";
import test from "node:test";
import { validateModelSettings } from "../modules/inference/local-settings.ts";
import {
  createFakeProviderProfile,
  GUI_TEST_ADVERTISED_ORIGIN,
  resolveGuiTestAdvertisedOrigin,
  targetsGuiAdvertisedOriginSpec,
} from "../scripts/gui-scratch-config.mjs";

test("advertised-origin GUI targeting requires the exact TEST-NET fixture", () => {
  assert.equal(
    targetsGuiAdvertisedOriginSpec(["--project=chromium", "tests/gui/z3-lobby-invite-origin.spec.ts"]),
    true,
  );
  assert.equal(targetsGuiAdvertisedOriginSpec(["tests/gui/u2-fake-provider-turn.spec.ts"]), false);
  assert.equal(resolveGuiTestAdvertisedOrigin(undefined), null);
  assert.equal(resolveGuiTestAdvertisedOrigin(GUI_TEST_ADVERTISED_ORIGIN, true), GUI_TEST_ADVERTISED_ORIGIN);
  assert.throws(() => resolveGuiTestAdvertisedOrigin(undefined, true), /require the fixed TEST-NET-1 origin/);
  assert.throws(() => resolveGuiTestAdvertisedOrigin("http://127.0.0.1:9999"), /TEST-NET-1 fixture/);
});

test("fake GUI profile is custom-openai, schema-valid, and loopback-only", () => {
  const profile = createFakeProviderProfile(
    "http://127.0.0.1:45678/v1",
    "realm/fake-deterministic-v0",
    new Date("2026-09-28T00:00:00.000Z"),
  );
  const validated = validateModelSettings(profile);
  assert.equal(validated.providerId, "custom-openai");
  assert.equal(validated.baseUrl, "http://127.0.0.1:45678/v1");
  assert.equal(validated.selectedModel, "realm/fake-deterministic-v0");
  assert.equal(validated.apiKey, "");
  assert.throws(() => createFakeProviderProfile("https://example.invalid/v1", "model"), /loopback/);
  assert.throws(() => createFakeProviderProfile("http://127.0.0.1/v1", "model"), /loopback/);
});

test("operator fixture allowlist only for the exact f-comfyui-operator spec target", async () => {
  const {
    GUI_TEST_OPERATOR_PRINCIPAL,
    resolveGuiTestOperatorPrincipals,
  } = await import("../scripts/gui-scratch-config.mjs");
  // 精确目标（含 Windows 反斜杠形态）→ 注入固定 fixture principal。
  assert.equal(
    resolveGuiTestOperatorPrincipals(["--project=chromium", "tests/gui/f-comfyui-operator.spec.ts"]),
    GUI_TEST_OPERATOR_PRINCIPAL,
  );
  assert.equal(
    resolveGuiTestOperatorPrincipals(["tests\\gui\\f-comfyui-operator.spec.ts"]),
    GUI_TEST_OPERATOR_PRINCIPAL,
  );
  // fixture 值固定（GUI 测试员 的 HMAC principal），不接受任意注入源。
  assert.equal(GUI_TEST_OPERATOR_PRINCIPAL, "principal_f1716031a4a75d60ea");
  // 普通 spec / 无 target / 相似路径 / 任意参数 → 一律不启用。
  for (const args of [
    ["tests/gui/f-settings.spec.ts"],
    ["--project=chromium"],
    [],
    ["tests/gui/xf-comfyui-operator.spec.ts"],   // 相似前缀不得误中
    ["f-comfyui-operator.spec.ts.bak"],          // 后缀变体不得误中
    ["--grep", "f-comfyui-operator"],            // 非 spec 路径参数不得误中
    ["tests/gui/f-comfyui-operator.spec.ts.evil"],
  ]) {
    assert.equal(resolveGuiTestOperatorPrincipals(args), null, JSON.stringify(args));
  }
});

test("operator fixture selector requires the exact positional spec target (false-positive regression)", async () => {
  const {
    GUI_TEST_OPERATOR_PRINCIPAL,
    resolveGuiTestOperatorPrincipals,
  } = await import("../scripts/gui-scratch-config.mjs");
  // 真实支持的调用形态必须启用。
  assert.equal(
    resolveGuiTestOperatorPrincipals(["--project=chromium", "tests/gui/f-comfyui-operator.spec.ts"]),
    GUI_TEST_OPERATOR_PRINCIPAL,
  );
  // 注：分离式 `--project chromium <target>` 不启用——真实 CLI 证明 target
  // 会被 variadic project 值消费（--list 探针报 Project not found），
  // 该形态的负例在下方全量矩阵断言。
  assert.equal(
    resolveGuiTestOperatorPrincipals(["tests\\gui\\f-comfyui-operator.spec.ts"]),
    GUI_TEST_OPERATOR_PRINCIPAL,
  );
  // Iris 复现的误中：option 值与任意目录前缀一律不启用。
  const falsePositives = [
    ["--grep", "f-comfyui-operator.spec.ts"],
    ["-g", "tests/gui/f-comfyui-operator.spec.ts"],
    ["--grep", "tests/gui/f-comfyui-operator.spec.ts"],
    ["--project", "tests/gui/f-comfyui-operator.spec.ts"],
    ["-p", "tests/gui/f-comfyui-operator.spec.ts"],
    ["--config", "tests/gui/f-comfyui-operator.spec.ts"],
    ["--test-dir", "tests/gui/f-comfyui-operator.spec.ts"],
    ["unrelated/f-comfyui-operator.spec.ts"],
    ["tests/gui/../gui/f-comfyui-operator.spec.ts"],
    ["./tests/gui/f-comfyui-operator.spec.ts"],
    ["f-comfyui-operator.spec.ts"],                          // 裸 basename
    ["/workspace/REALM/tests/gui/f-comfyui-operator.spec.ts"], // 绝对路径
    ["tests/gui/deep/f-comfyui-operator.spec.ts"],
    ["--grep=tests/gui/f-comfyui-operator.spec.ts"],          // --opt=value 形态
  ];
  for (const args of falsePositives) {
    assert.equal(resolveGuiTestOperatorPrincipals(args), null, JSON.stringify(args));
  }
});

test("operator fixture selector is fail-closed across the full Playwright CLI value-option surface", async () => {
  const {
    GUI_TEST_OPERATOR_PRINCIPAL,
    resolveGuiTestOperatorPrincipals,
  } = await import("../scripts/gui-scratch-config.mjs");
  const TARGET = "tests/gui/f-comfyui-operator.spec.ts";

  // —— 正向：canonical 与既存受支持形态 ——
  const positives = [
    ["--project=chromium", TARGET],          // canonical runner 形态
    [TARGET],                                // 裸精确相对目标
    ["tests\\gui\\f-comfyui-operator.spec.ts"], // Windows 分隔符归一化
    ["--grep", "F7", TARGET],                // 其它选项值之后的真 positional
    ["--", TARGET],                          // `--` 之后即 positional
  ];
  for (const args of positives) {
    assert.equal(resolveGuiTestOperatorPrincipals(args), GUI_TEST_OPERATOR_PRINCIPAL, JSON.stringify(args));
  }

  // —— 负向：当前本地 CLI help 的全部必需值选项（分离式 + = 形态）——
  const valueOptions = [
    "--browser", "--config", "-c", "--grep", "-g", "--grep-invert", "-G",
    "--global-timeout", "--workers", "-j", "--last-failed-file",
    "--max-failures", "--output", "--repeat-each", "--reporter", "--retries",
    "--run-agents", "--shard", "--test-list", "--test-list-invert",
    "--timeout", "--trace", "--tsconfig", "--ui-host", "--ui-port",
    "--update-source-method",
  ];
  for (const option of valueOptions) {
    assert.equal(resolveGuiTestOperatorPrincipals([option, TARGET]), null, `${option} <target>`);
    assert.equal(resolveGuiTestOperatorPrincipals([`${option}=${TARGET}`]), null, `${option}=<target>`);
  }
  // 可选值选项：目标紧跟其后同样按值处理（fail-closed；假阴性可接受）。
  for (const option of ["--debug", "--only-changed", "--update-snapshots", "-u"]) {
    assert.equal(resolveGuiTestOperatorPrincipals([option, TARGET]), null, `${option} <target>`);
    assert.equal(resolveGuiTestOperatorPrincipals([`${option}=${TARGET}`]), null, `${option}=<target>`);
  }
  // variadic --project：目标作为（任一）project 值 = 歧义，fail-closed。
  // 本地 CLI 实证：--list --project chromium <target> 报 Project not found。
  assert.equal(resolveGuiTestOperatorPrincipals(["--project", TARGET]), null);
  assert.equal(resolveGuiTestOperatorPrincipals(["-p", TARGET]), null);
  assert.equal(resolveGuiTestOperatorPrincipals(["--project", "chromium", TARGET]), null);
  assert.equal(resolveGuiTestOperatorPrincipals(["-p", "chromium", TARGET]), null);
  assert.equal(resolveGuiTestOperatorPrincipals(["--project", "chromium", "webkit", TARGET]), null);
  // 未知选项：无论中间隔着多少普通 token、是否 = 形态，一律 fail-closed。
  assert.equal(resolveGuiTestOperatorPrincipals(["--bogus", TARGET]), null);
  assert.equal(resolveGuiTestOperatorPrincipals([`--bogus=${TARGET}`]), null);
  assert.equal(resolveGuiTestOperatorPrincipals(["--future-option", "value", TARGET]), null);
  assert.equal(resolveGuiTestOperatorPrincipals([`--future-option=value`, TARGET]), null);
  assert.equal(resolveGuiTestOperatorPrincipals(["--project=chromium", "--future-option", "value", TARGET]), null);
  assert.equal(resolveGuiTestOperatorPrincipals(["-z", TARGET]), null);
  // 无值 flag 后的目标同样是假阴性（fail-closed，不猜测 flag 语义）。
  assert.equal(resolveGuiTestOperatorPrincipals(["--headed", TARGET]), null);
  // 非 positional 形态的历史负例保持关闭。
  for (const args of [
    ["unrelated/f-comfyui-operator.spec.ts"],
    ["f-comfyui-operator.spec.ts"],
    ["/workspace/REALM/tests/gui/f-comfyui-operator.spec.ts"],
    ["./tests/gui/f-comfyui-operator.spec.ts"],
    ["tests/gui/../gui/f-comfyui-operator.spec.ts"],
    ["tests/gui/deep/f-comfyui-operator.spec.ts"],
  ]) {
    assert.equal(resolveGuiTestOperatorPrincipals(args), null, JSON.stringify(args));
  }
});
