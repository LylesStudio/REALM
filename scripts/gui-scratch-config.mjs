export const GUI_TEST_ADVERTISED_ORIGIN = "http://192.0.2.10:9999";

export function resolveGuiTestAdvertisedOrigin(value, required = false) {
  const candidate = typeof value === "string" ? value.trim() : "";
  if (!candidate) {
    if (required) {
      throw new Error("Targeted advertised-origin GUI tests require the fixed TEST-NET-1 origin.");
    }
    return null;
  }
  if (candidate !== GUI_TEST_ADVERTISED_ORIGIN) {
    throw new Error("GUI advertised-origin override must use the documented TEST-NET-1 fixture.");
  }
  return GUI_TEST_ADVERTISED_ORIGIN;
}

export function targetsGuiAdvertisedOriginSpec(args) {
  return args.some((arg) =>
    String(arg).replaceAll("\\", "/").endsWith("z3-lobby-invite-origin.spec.ts"),
  );
}

export function createFakeProviderProfile(baseUrl, model, now = new Date()) {
  let endpoint;
  try {
    endpoint = new URL(baseUrl);
  } catch {
    throw new Error("Fake provider URL must be valid.");
  }
  if (endpoint.protocol !== "http:"
    || endpoint.hostname !== "127.0.0.1"
    || !endpoint.port
    || endpoint.pathname !== "/v1"
    || endpoint.username
    || endpoint.password) {
    throw new Error("Fake provider must use a credential-free loopback /v1 endpoint.");
  }
  if (typeof model !== "string" || !model.trim()) {
    throw new Error("Fake provider model id must be non-empty.");
  }
  if (!(now instanceof Date) || Number.isNaN(now.valueOf())) {
    throw new Error("Fake provider settings timestamp must be a valid Date.");
  }
  return {
    schemaVersion: 1,
    providerId: "custom-openai",
    baseUrl: endpoint.toString().replace(/\/$/, ""),
    apiKey: "",
    selectedModel: model,
    thinking: "disabled",
    timeoutMs: 60_000,
    maxTokens: 2_048,
    availableModels: [],
    lastDiscoveredAt: null,
    updatedAt: now.toISOString(),
  };
}

/**
 * F7 ComfyUI operator GUI fixture（M7 收口）：仅当 runner 参数包含**精确
 * positional 目标** `tests/gui/f-comfyui-operator.spec.ts`（允许 Windows
 * 反斜杠形态）时才注入固定 fixture operator principal。判定 fail-closed：
 * - 未知选项（无论分离/= 形态、无论与目标隔多少 token）直接否决整条命令；
 * - 分离式 `--project`/`-p` 按真实 CLI 语义消费后续全部非选项 token
 *   （variadic project 值），目标落其中即不启用；
 * - 其它任何以 `-` 开头且不含 `=` 的 token 使其后一个参数按「可能是选项
 *   值」处理（必需/可选值/无值 flag 一律保守，假阴性可接受）；
 * - `--opt=value` 单 token 忽略；`--` 之后按 POSIX 惯例是 positional；
 * - 裸 basename、任意目录/绝对路径不启用。
 * 唯一受支持的 canonical 形态：
 * `--project=chromium tests/gui/f-comfyui-operator.spec.ts`
 * （本机 `cli.js test --list` 实证该形态枚举恰为 F7 两条用例）。
 * 该值是全局登录账户「GUI 测试员」经
 * principalIdForDisplayName 的 HMAC 派生结果；不接受 CLI 任意 principal，
 * 不透传宿主 REALM_OPERATOR_PRINCIPALS。其它 GUI 命令返回 null。
 */
export const GUI_TEST_OPERATOR_SPEC = "f-comfyui-operator.spec.ts";
export const GUI_TEST_OPERATOR_TARGET = "tests/gui/f-comfyui-operator.spec.ts";
export const GUI_TEST_OPERATOR_PRINCIPAL = "principal_f1716031a4a75d60ea";

/**
 * 本机 Playwright CLI（`node_modules/@playwright/test/cli.js test --help`
 * 全量重读）的已知选项名集合（值选项/可选值/flag 全含）。集合之外的任何
 * 选项一律把整条命令否决为 null——宁可假阴性，绝不猜测未知选项的值消费。
 */
const GUI_OPERATOR_KNOWN_OPTIONS = new Set([
  // flag（无值）
  "--fail-on-flaky-tests", "--forbid-only", "--fully-parallel", "--headed",
  "--ignore-snapshots", "--last-failed", "--list", "--no-deps",
  "--pass-with-no-tests", "--quiet", "--ui", "-x", "-h", "--help",
  // 必需值 / 可选值 / variadic
  "--browser", "-c", "--config", "--debug", "-g", "--grep", "-G",
  "--grep-invert", "--global-timeout", "-j", "--workers",
  "--last-failed-file", "--max-failures", "--only-changed", "--output",
  "--project", "-p", "--repeat-each", "--reporter", "--retries",
  "--run-agents", "--shard", "--test-list", "--test-list-invert",
  "--timeout", "--trace", "--tsconfig", "-u", "--update-snapshots",
  "--ui-host", "--ui-port", "--update-source-method",
]);

export function resolveGuiTestOperatorPrincipals(args) {
  const list = (args ?? []).map(String);
  let afterDoubleDash = false;
  let projectValues = false; // 分离式 --project/-p 正在消费 variadic 值
  for (let index = 0; index < list.length; index += 1) {
    const raw = list[index];
    if (!afterDoubleDash && raw === "--") {
      afterDoubleDash = true;
      projectValues = false;
      continue;
    }
    if (!afterDoubleDash && raw.startsWith("-")) {
      const name = raw.includes("=") ? raw.slice(0, raw.indexOf("=")) : raw;
      if (!GUI_OPERATOR_KNOWN_OPTIONS.has(name)) return null; // 未知选项否决整条命令
      // 分离式 variadic --project：后续非选项 token 全是 project 值。
      projectValues = (name === "--project" || name === "-p") && !raw.includes("=");
      continue;
    }
    if (projectValues) continue; // 目标是 variadic project 值之一：fail closed
    if (!afterDoubleDash && index > 0) {
      const previous = list[index - 1];
      if (previous.startsWith("-") && !previous.includes("=") && previous !== "--") {
        continue; // 前驱是分离式选项：本参数可能是其值，fail closed
      }
    }
    if (raw.replaceAll("\\", "/") === GUI_TEST_OPERATOR_TARGET) {
      return GUI_TEST_OPERATOR_PRINCIPAL;
    }
  }
  return null;
}
