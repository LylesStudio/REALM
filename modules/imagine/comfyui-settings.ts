/**
 * ComfyUI 设置存储（server-only，node:fs）：独立于模型 provider 配置
 * （不复用 model-providers.json）。目录 0700、文件 0600、临时文件 rename
 * 原子写——与 modules/inference/local-settings.ts 同一手法。
 * 安全边界：baseUrl 仅 http/https、禁内嵌凭据/query/fragment；apiKey 只存
 * 服务端，public snapshot 只回显 apiKeyConfigured，永不回显明文。
 * 默认值经 REALM_COMFYUI_BASE_URL 覆盖；缺省值不进入 client bundle
 * （本模块与 settings 卡之间只走 /api/settings/comfyui 的 public snapshot）。
 */
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface ComfyUiSettings {
  enabled: boolean;
  baseUrl: string;
  requestTimeoutMs: number;
  workflowId: string;
  /** server-only：绝不进入 public snapshot。 */
  apiKey: string;
  updatedAt: string;
}

export interface PublicComfyUiSettings {
  enabled: boolean;
  baseUrl: string;
  requestTimeoutMs: number;
  workflowId: string;
  apiKeyConfigured: boolean;
  updatedAt: string;
}

export class ComfyUiSettingsError extends Error {
  readonly code = "COMFYUI_SETTINGS_INVALID" as const;

  constructor(message: string) {
    super(message);
    this.name = "ComfyUiSettingsError";
  }
}

export const COMFYUI_DEFAULT_WORKFLOW_ID = "anima-scene-t2i-v0";
export const COMFYUI_TIMEOUT_LIMITS = { min: 5_000, max: 120_000 } as const;

/**
 * 出站地址分类（M7 收口）：REALM 定位本机/内部 LAN——只允许 loopback
 * （127/8、::1）与 RFC1918（10/8、172.16/12、192.168/16）/IPv6 ULA
 * （fc00::/7）。link-local（169.254/16、fe80::/10，含云 metadata 段）、
 * CGNAT（100.64/10）、unspecified、multicast、公网一律拒绝。
 * IPv4-mapped IPv6（::ffff:a.b.c.d）按嵌入 v4 同规则判定。
 * hostname 名字不在此判定（连接时解析全集校验，见 comfyui-client）。
 */
export type ComfyUiAddressClass = "loopback" | "private" | "blocked" | "not-ip";

function classifyIpv4(a: number, b: number): ComfyUiAddressClass {
  if (a === 127) return "loopback";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
    return "private";
  }
  return "blocked";
}

const IPV4_TEXT = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function classifyComfyUiAddress(rawHost: string): ComfyUiAddressClass {
  // WHATWG URL 的 hostname：IPv6 带方括号、已归一化（如 127.1 → 127.0.0.1、
  // ::ffff:127.0.0.1 → [::ffff:7f00:1]）。
  const host = rawHost.startsWith("[") && rawHost.endsWith("]")
    ? rawHost.slice(1, -1)
    : rawHost;
  const v4 = IPV4_TEXT.exec(host);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    if (octets.some((octet) => octet > 255)) return "not-ip";
    return classifyIpv4(octets[0]!, octets[1]!);
  }
  if (!host.includes(":")) return "not-ip";
  // 展开 v6 groups（含 :: 压缩）。
  const [head, tail] = host.split("::");
  if (host.split("::").length > 2) return "not-ip";
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail ? tail.split(":") : [];
  if (headGroups.concat(tailGroups).some((group) => !/^[0-9a-fA-F]{1,4}$/.test(group))) {
    return "not-ip";
  }
  const missing = 8 - headGroups.length - tailGroups.length;
  if (missing < 0 || (missing === 0 && host.includes("::"))) return "not-ip";
  const groups = [
    ...headGroups,
    ...Array.from({ length: Math.max(missing, 0) }, () => "0"),
    ...tailGroups,
  ].map((group) => parseInt(group, 16));
  if (groups.length !== 8) return "not-ip";
  // IPv4-mapped ::ffff:a.b.c.d → 按嵌入 v4 分类。
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return classifyIpv4(groups[6]! >> 8, groups[6]! & 0xff);
  }
  if (groups.every((group, index) => group === (index === 7 ? 1 : 0))) return "loopback";
  if ((groups[0]! & 0xfe00) === 0xfc00) return "private"; // fc00::/7 ULA
  return "blocked";
}

type SettingsEnvironment = Readonly<Record<string, string | undefined>>;

function defaultSettings(environment: SettingsEnvironment, clock: () => Date): ComfyUiSettings {
  return {
    enabled: environment.REALM_COMFYUI_ENABLED === "1",
    // server-only 默认值：ComfyUI 官方默认 loopback 端口；可用环境变量或
    // 设置页显式覆盖。不得内置任何真实内网/私网地址。
    baseUrl: environment.REALM_COMFYUI_BASE_URL?.trim() || "http://127.0.0.1:8188",
    requestTimeoutMs: 30_000,
    workflowId: COMFYUI_DEFAULT_WORKFLOW_ID,
    apiKey: "",
    updatedAt: clock().toISOString(),
  };
}

export function validateComfyUiSettings(raw: unknown): ComfyUiSettings {
  if (!isObject(raw)) throw invalid("ComfyUI settings must be an object.");
  if (typeof raw.enabled !== "boolean") throw invalid("enabled must be a boolean.");
  const baseUrl = requireText(raw.baseUrl, "baseUrl", 256).replace(/\/+$/, "");
  let endpoint: URL;
  try {
    endpoint = new URL(baseUrl);
  } catch {
    throw invalid("baseUrl must be a valid URL.");
  }
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw invalid("baseUrl must use http or https.");
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw invalid("baseUrl must not embed credentials, query, or fragment.");
  }
  // 保存期 IP literal 校验（M7）：loopback/RFC1918/ULA 之外的 literal 直接
  // 拒绝；hostname 名字留到连接时全答案校验+pinning（comfyui-client）。
  // 错误文案不含地址本体。
  if (classifyComfyUiAddress(endpoint.hostname) === "blocked") {
    throw invalid("baseUrl must target a loopback or private LAN address.");
  }
  if (
    typeof raw.requestTimeoutMs !== "number"
    || !Number.isSafeInteger(raw.requestTimeoutMs)
    || raw.requestTimeoutMs < COMFYUI_TIMEOUT_LIMITS.min
    || raw.requestTimeoutMs > COMFYUI_TIMEOUT_LIMITS.max
  ) {
    throw invalid(
      `requestTimeoutMs must be between ${COMFYUI_TIMEOUT_LIMITS.min} and ${COMFYUI_TIMEOUT_LIMITS.max}.`,
    );
  }
  const workflowId = requireText(raw.workflowId, "workflowId", 128);
  if (!/^[a-z0-9][a-z0-9_.-]*$/i.test(workflowId)) {
    throw invalid("workflowId contains unsupported characters.");
  }
  const apiKey = typeof raw.apiKey === "string" ? raw.apiKey.trim() : "";
  if (apiKey.length > 256) throw invalid("apiKey is too long.");
  const updatedAt = requireText(raw.updatedAt, "updatedAt", 64);
  if (!Number.isFinite(Date.parse(updatedAt))) throw invalid("updatedAt must be ISO 8601.");
  return {
    enabled: raw.enabled,
    baseUrl,
    requestTimeoutMs: raw.requestTimeoutMs,
    workflowId,
    apiKey,
    updatedAt,
  };
}

export function publicComfyUiSettings(settings: ComfyUiSettings): PublicComfyUiSettings {
  return {
    enabled: settings.enabled,
    baseUrl: settings.baseUrl,
    requestTimeoutMs: settings.requestTimeoutMs,
    workflowId: settings.workflowId,
    apiKeyConfigured: settings.apiKey.length > 0,
    updatedAt: settings.updatedAt,
  };
}

export interface ComfyUiSettingsStore {
  load(): Promise<ComfyUiSettings>;
  save(patch: {
    enabled?: unknown;
    baseUrl?: unknown;
    requestTimeoutMs?: unknown;
    workflowId?: unknown;
    apiKey?: unknown;
  }): Promise<ComfyUiSettings>;
}

export function createComfyUiSettingsStore(options: {
  filePath?: string;
  environment?: SettingsEnvironment;
  clock?: () => Date;
} = {}): ComfyUiSettingsStore {
  // 每次创建时读取环境（desktop launcher REALM_DATA_HOME / 测试隔离目录）。
  const environment = options.environment ?? process.env;
  const clock = options.clock ?? (() => new Date());
  const settingsRoot = environment.REALM_DATA_HOME?.trim() || resolve(process.cwd(), ".local");
  const filePath = options.filePath ?? resolve(settingsRoot, "settings", "comfyui.json");

  async function load(): Promise<ComfyUiSettings> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(filePath, "utf8"));
    } catch (error) {
      if (isObject(error) && error.code === "ENOENT") {
        return defaultSettings(environment, clock);
      }
      throw invalid("The ComfyUI settings file is not valid JSON.");
    }
    return validateComfyUiSettings(raw);
  }

  return {
    load,
    async save(patch) {
      const current = await load();
      const next = validateComfyUiSettings({
        ...current,
        enabled: typeof patch.enabled === "boolean" ? patch.enabled : current.enabled,
        baseUrl: patch.baseUrl ?? current.baseUrl,
        requestTimeoutMs: patch.requestTimeoutMs ?? current.requestTimeoutMs,
        workflowId: patch.workflowId ?? current.workflowId,
        // 空字符串 = 沿用现有密钥（公开快照回填后保存不会误清空）。
        apiKey: typeof patch.apiKey === "string" && patch.apiKey.trim()
          ? patch.apiKey.trim()
          : current.apiKey,
        updatedAt: clock().toISOString(),
      });
      await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
      const temporaryPath = `${filePath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, filePath);
      await chmod(filePath, 0o600);
      return next;
    },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw invalid(`${field} must be a non-empty string of at most ${maxLength} characters.`);
  }
  return value.trim();
}

function invalid(message: string): ComfyUiSettingsError {
  return new ComfyUiSettingsError(message);
}
