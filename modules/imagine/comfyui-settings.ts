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

type SettingsEnvironment = Readonly<Record<string, string | undefined>>;

function defaultSettings(environment: SettingsEnvironment, clock: () => Date): ComfyUiSettings {
  return {
    enabled: environment.REALM_COMFYUI_ENABLED === "1",
    // server-only 默认值：本批实测的 LAN 实例；可用环境变量覆盖。
    baseUrl: environment.REALM_COMFYUI_BASE_URL?.trim() || "http://192.168.31.242:8000",
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
