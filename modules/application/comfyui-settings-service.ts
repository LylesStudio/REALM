/**
 * ComfyUI 设置应用服务（server-only）：public snapshot 永不回显 apiKey；
 * test 经原生 client 打 GET /system_stats（可用 draft 覆盖未保存值）。
 */
import {
  ComfyUiError,
  ComfyUiSettingsError,
  createComfyUiClient,
  publicComfyUiSettings,
  validateComfyUiSettings,
  type ComfyUiClient,
  type ComfyUiSettings,
  type ComfyUiSettingsStore,
  type PublicComfyUiSettings,
} from "../imagine/public.ts";

export type ComfyUiSettingsDraft = {
  enabled?: unknown;
  baseUrl?: unknown;
  requestTimeoutMs?: unknown;
  workflowId?: unknown;
  apiKey?: unknown;
};

export function createComfyUiSettingsService(options: {
  store: ComfyUiSettingsStore;
  createClient?: (settings: ComfyUiSettings) => ComfyUiClient;
  clock?: () => Date;
}) {
  const createClient = options.createClient ?? createComfyUiClient;
  const clock = options.clock ?? (() => new Date());

  async function mergeDraft(draft: ComfyUiSettingsDraft): Promise<ComfyUiSettings> {
    const current = await options.store.load();
    return validateComfyUiSettings({
      ...current,
      enabled: typeof draft.enabled === "boolean" ? draft.enabled : current.enabled,
      baseUrl: draft.baseUrl ?? current.baseUrl,
      requestTimeoutMs: draft.requestTimeoutMs ?? current.requestTimeoutMs,
      workflowId: draft.workflowId ?? current.workflowId,
      apiKey: typeof draft.apiKey === "string" && draft.apiKey.trim()
        ? draft.apiKey.trim()
        : current.apiKey,
      updatedAt: clock().toISOString(),
    });
  }

  return {
    async get(): Promise<PublicComfyUiSettings> {
      return publicComfyUiSettings(await options.store.load());
    },
    async save(draft: ComfyUiSettingsDraft): Promise<PublicComfyUiSettings> {
      return publicComfyUiSettings(await options.store.save(draft));
    },
    /** 连接测试（draft 语义与模型设置一致：未保存的修改也可试）。 */
    async test(draft: ComfyUiSettingsDraft): Promise<{ latencyMs: number }> {
      const settings = await mergeDraft(draft);
      const { latencyMs } = await createClient(settings).systemStats();
      return { latencyMs };
    },
  };
}

export function comfyUiSettingsErrorResponse(error: unknown): Response {
  if (error instanceof ComfyUiSettingsError) {
    return Response.json(
      { ok: false as const, error: { code: error.code, message: "图像生成配置不合法，请检查地址与超时。" } },
      { status: 400 },
    );
  }
  if (error instanceof ComfyUiError) {
    return Response.json(
      { ok: false as const, error: { code: error.code, message: error.message } },
      { status: 502 },
    );
  }
  return Response.json(
    { ok: false as const, error: { code: "COMFYUI_SETTINGS_FAILED", message: "图像生成设置操作失败，请稍后重试。" } },
    { status: 500 },
  );
}
