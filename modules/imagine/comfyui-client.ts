/**
 * 原生 ComfyUI REST client（server-only）：GET /system_stats 连接测试 +
 * POST /prompt 提交 patched graph。AbortController 超时；错误映射为
 * 静态分类，绝不回显 provider body/URL/凭据。
 * 注意：只接原生 REST；comfyui-mcp 包装层不是 REALM 的 provider。
 */
import type { ApiGraph } from "./workflow-patch.ts";
import type { ComfyUiSettings } from "./comfyui-settings.ts";

export class ComfyUiError extends Error {
  readonly code:
    | "COMFYUI_UNREACHABLE"
    | "COMFYUI_TIMEOUT"
    | "COMFYUI_REJECTED"
    | "COMFYUI_INVALID_RESPONSE";

  constructor(code: ComfyUiError["code"], message: string) {
    super(message);
    this.name = "ComfyUiError";
    this.code = code;
  }
}

export interface ComfyUiClient {
  /** 连接测试：GET /system_stats；返回延迟毫秒数。 */
  systemStats(): Promise<{ latencyMs: number }>;
  /** 提交 patched graph；成功仅代表 queue accepted（不声称图片已生成）。 */
  queuePrompt(graph: ApiGraph): Promise<{ promptId: string }>;
  /** 轮询 /history/<prompt_id>；pending=未就绪，ready=带输出图引用。 */
  history(promptId: string): Promise<ComfyUiHistoryResult>;
  /** 下载输出图（/view）：路径白名单 + 20MB 上限 + magic sniff。 */
  viewImage(ref: ComfyUiImageRef): Promise<ComfyUiImage>;
}

export interface ComfyUiImageRef {
  filename: string;
  subfolder: string;
  type: string;
}

export type ComfyUiHistoryResult =
  | { status: "pending" }
  | { status: "failed" }
  | { status: "ready"; image: ComfyUiImageRef };

export interface ComfyUiImage {
  data: Buffer;
  contentType: "image/png" | "image/jpeg" | "image/webp";
}

export const COMFYUI_IMAGE_MAX_BYTES = 20 * 1024 * 1024;

/** filename 只允许 basename；subfolder 只允许简单相对目录。 */
const SAFE_FILENAME = /^[a-zA-Z0-9_.-]+$/;
const SAFE_SUBFOLDER = /^[a-zA-Z0-9_-]+(\/[a-zA-Z0-9_-]+)*$/;

function sniffImageContentType(data: Buffer): ComfyUiImage["contentType"] | null {
  if (data.length >= 4 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    return "image/png";
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    data.length >= 12
    && data.subarray(0, 4).toString("ascii") === "RIFF"
    && data.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function createComfyUiClient(
  settings: Pick<ComfyUiSettings, "baseUrl" | "requestTimeoutMs" | "apiKey">,
  fetchImpl: FetchLike = fetch,
): ComfyUiClient {
  function headers(): Record<string, string> {
    return settings.apiKey
      ? { Authorization: `Bearer ${settings.apiKey}` }
      : {};
  }

  async function request(path: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), settings.requestTimeoutMs);
    try {
      return await fetchImpl(`${settings.baseUrl}${path}`, {
        ...init,
        headers: { ...headers(), ...(init?.headers as Record<string, string> | undefined) },
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ComfyUiError("COMFYUI_TIMEOUT", "ComfyUI 连接超时。");
      }
      void error;
      throw new ComfyUiError("COMFYUI_UNREACHABLE", "无法连接 ComfyUI 服务。");
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async systemStats() {
      const startedAt = Date.now();
      const response = await request("/system_stats", { method: "GET" });
      if (!response.ok) {
        throw new ComfyUiError("COMFYUI_REJECTED", "ComfyUI 拒绝了连接测试。");
      }
      const body: unknown = await response.json().catch(() => null);
      if (typeof body !== "object" || body === null) {
        throw new ComfyUiError("COMFYUI_INVALID_RESPONSE", "ComfyUI 返回了无法识别的响应。");
      }
      return { latencyMs: Date.now() - startedAt };
    },

    async queuePrompt(graph) {
      const response = await request("/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: graph }),
      });
      if (!response.ok) {
        // 不回读/回显错误 body（可能含节点内部细节）。
        throw new ComfyUiError("COMFYUI_REJECTED", "ComfyUI 拒绝了本次场景图任务。");
      }
      const body: unknown = await response.json().catch(() => null);
      const promptId = typeof body === "object" && body !== null
        ? (body as { prompt_id?: unknown }).prompt_id
        : null;
      if (typeof promptId !== "string" || !promptId.trim()) {
        throw new ComfyUiError("COMFYUI_INVALID_RESPONSE", "ComfyUI 返回了无法识别的响应。");
      }
      return { promptId };
    },

    async history(promptId) {
      if (!/^[a-zA-Z0-9_.-]+$/.test(promptId)) {
        throw new ComfyUiError("COMFYUI_INVALID_RESPONSE", "ComfyUI 返回了无法识别的响应。");
      }
      const response = await request(`/history/${encodeURIComponent(promptId)}`, { method: "GET" });
      if (!response.ok) {
        throw new ComfyUiError("COMFYUI_REJECTED", "ComfyUI 拒绝了生成状态查询。");
      }
      const body: unknown = await response.json().catch(() => null);
      if (typeof body !== "object" || body === null) {
        throw new ComfyUiError("COMFYUI_INVALID_RESPONSE", "ComfyUI 返回了无法识别的响应。");
      }
      const entry = (body as Record<string, unknown>)[promptId];
      if (typeof entry !== "object" || entry === null) return { status: "pending" };
      const status = (entry as { status?: { status_str?: unknown } }).status;
      if (status?.status_str === "error") return { status: "failed" };
      const outputs = (entry as { outputs?: Record<string, { images?: unknown }> }).outputs;
      if (!outputs || typeof outputs !== "object") return { status: "pending" };
      // 只接受 SaveImage 输出节点的 image 引用（filename/subfolder/type）。
      for (const nodeOutput of Object.values(outputs)) {
        const images = nodeOutput?.images;
        if (!Array.isArray(images)) continue;
        for (const image of images) {
          if (
            typeof image === "object" && image !== null
            && (image as { type?: unknown }).type === "output"
            && typeof (image as { filename?: unknown }).filename === "string"
          ) {
            return {
              status: "ready",
              image: {
                filename: (image as { filename: string }).filename,
                subfolder: typeof (image as { subfolder?: unknown }).subfolder === "string"
                  ? (image as { subfolder: string }).subfolder
                  : "",
                type: "output",
              },
            };
          }
        }
      }
      return { status: "pending" };
    },

    async viewImage(ref) {
      if (
        !SAFE_FILENAME.test(ref.filename)
        || ref.filename.includes("..")
        || (ref.subfolder !== "" && !SAFE_SUBFOLDER.test(ref.subfolder))
        || ref.subfolder.includes("..")
      ) {
        throw new ComfyUiError("COMFYUI_INVALID_RESPONSE", "ComfyUI 返回了非法的输出路径。");
      }
      const query = new URLSearchParams({
        filename: ref.filename,
        subfolder: ref.subfolder,
        type: "output",
      });
      const response = await request(`/view?${query.toString()}`, { method: "GET" });
      if (!response.ok) {
        throw new ComfyUiError("COMFYUI_REJECTED", "ComfyUI 拒绝了输出图下载。");
      }
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (declared > COMFYUI_IMAGE_MAX_BYTES) {
        throw new ComfyUiError("COMFYUI_INVALID_RESPONSE", "ComfyUI 输出图超出大小上限。");
      }
      const data = Buffer.from(await response.arrayBuffer());
      if (data.length === 0 || data.length > COMFYUI_IMAGE_MAX_BYTES) {
        throw new ComfyUiError("COMFYUI_INVALID_RESPONSE", "ComfyUI 输出图超出大小上限。");
      }
      const contentType = sniffImageContentType(data);
      if (!contentType) {
        throw new ComfyUiError("COMFYUI_INVALID_RESPONSE", "ComfyUI 输出不是可识别的图片格式。");
      }
      return { data, contentType };
    },
  };
}
