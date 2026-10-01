/**
 * 原生 ComfyUI REST client（server-only，node:http/https）：GET /system_stats
 * 连接测试 + POST /prompt 提交 patched graph + GET /history / /view。
 *
 * M7 收口安全边界：
 * - 建连前地址校验 + 连接 pinning：hostname 一次解析 A+AAAA 全集，任一答案
 *   超出批准类别（loopback/RFC1918/ULA，见 comfyui-settings 分类器）即在
 *   connect 之前拒绝；自定义 lookup 只返回本次已验证的答案（无二次未校验
 *   解析，无 check-connect TOCTOU）。HTTPS 保留默认证书校验与原始 host
 *   SNI（servername 取 URL hostname，非解析结果）。
 * - redirect fail-closed：node:http 从不自动跟随重定向；任何 3xx 按
 *   COMFYUI_REJECTED 处理，Authorization 与 body 绝不离开原始目标。
 * - 总 deadline 覆盖 DNS/连接/headers/完整 body 消费（单一定时器 +
 *   AbortController；body 读一半超时同样算 COMFYUI_TIMEOUT）。
 * - 响应上限流式执行：JSON ≤ COMFYUI_JSON_MAX_BYTES，图片 ≤ 20MiB；
 *   chunked/无 Content-Length 越界即 cancel 中止（绝不先完整载入）。
 * - 错误映射为静态分类，绝不回显 provider body/URL/凭据。
 * 注意：只接原生 REST；comfyui-mcp 包装层不是 REALM 的 provider。
 */
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import type { ApiGraph } from "./workflow-patch.ts";
import {
  classifyComfyUiAddress,
  type ComfyUiSettings,
} from "./comfyui-settings.ts";

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
  /** 下载输出图（/view）：路径白名单 + 20MB 流式上限 + magic sniff。 */
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
/** JSON 端点（system_stats/prompt/history）响应上限：1 MiB 流式计数。 */
export const COMFYUI_JSON_MAX_BYTES = 1024 * 1024;

/** 地址解析答案（dns.promises.lookup({all:true}) 同形）。 */
export interface ComfyUiAddressAnswer {
  address: string;
  family: 4 | 6;
}

/** 测试注入：全答案解析器（默认 dns.promises.lookup all+verbatim）。 */
export type ComfyUiResolver = (hostname: string) => Promise<readonly ComfyUiAddressAnswer[]>;

/** 传输层响应（body 为流；cancel 中止并销毁底层连接）。 */
export interface ComfyUiTransportResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Uint8Array>;
  cancel(): void;
}

type PinnedLookup = (
  hostname: string,
  options: unknown,
  callback: (
    error: Error | null,
    addressOrAddresses?: string | readonly ComfyUiAddressAnswer[],
    family?: number,
  ) => void,
) => void;

/** 测试注入：传输层（默认 node:http/https，见文件头安全边界）。 */
export type ComfyUiTransport = (input: {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
  /** 只返回本次已验证答案的 pinning lookup（连接必须用同一解析结果）。 */
  lookup: PinnedLookup;
}) => Promise<ComfyUiTransportResponse>;

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

const defaultResolver: ComfyUiResolver = async (hostname) => {
  const answers = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return answers.map((answer) => ({
    address: answer.address,
    family: answer.family === 6 ? 6 as const : 4 as const,
  }));
};

/**
 * resolver 与 deadline 竞争：DNS await 必须随 AbortSignal 一并结束，
 * 否则永不返回的 resolver 会让调用方挂死。abort 时 reject；迟到 settle
 * 只是让已完结的 race 空转（listener 已清），绝不启动 socket/transport。
 */
function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    if (signal.aborted) {
      reject(new ComfyUiError("COMFYUI_TIMEOUT", "ComfyUI 连接超时。"));
      return;
    }
    const onAbort = () => {
      reject(new ComfyUiError("COMFYUI_TIMEOUT", "ComfyUI 连接超时。"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    promise.then(
      (value) => {
        cleanup();
        resolvePromise(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * 建连前校验 + pinning：hostname 解析全集（IP literal 直接分类，不走 DNS），
 * 任一答案越类即在 connect 之前拒绝；lookup 闭包只携带本次已验证答案。
 */
async function resolveAndPin(
  hostname: string,
  resolveHost: ComfyUiResolver,
  signal: AbortSignal,
): Promise<PinnedLookup> {
  const literalClass = classifyComfyUiAddress(hostname);
  let answers: readonly ComfyUiAddressAnswer[];
  if (literalClass !== "not-ip") {
    if (literalClass === "blocked") throw unreachable();
    answers = [{
      address: hostname.startsWith("[") ? hostname.slice(1, -1) : hostname,
      family: classifyComfyUiAddress(hostname) === "loopback" || hostname.includes(":") || hostname.startsWith("[") ? 6 : 4,
    }];
  } else {
    try {
      answers = await raceWithSignal(resolveHost(hostname), signal);
    } catch (error) {
      if (error instanceof ComfyUiError) throw error; // deadline 超时原样上抛
      throw unreachable();
    }
    if (answers.length === 0) throw unreachable();
    for (const answer of answers) {
      if (classifyComfyUiAddress(answer.address) === "blocked"
        || classifyComfyUiAddress(answer.address) === "not-ip") {
        throw unreachable();
      }
    }
  }
  const pinned = answers[0]!;
  // Node v22 的 http.request 调 custom lookup 时传 options.all=true——此时
  // callback 必须收地址对象数组（dns.lookup 官方契约）；标量形状会触发
  // ERR_INVALID_IP_ADDRESS。两种形状都支持，且都只回本次已验证的答案。
  return (_host, lookupOptions, callback) => {
    const wantsAll = typeof lookupOptions === "object" && lookupOptions !== null
      && (lookupOptions as { all?: boolean }).all === true;
    if (wantsAll) {
      callback(null, [{ address: pinned.address, family: pinned.family }]);
    } else {
      callback(null, pinned.address, pinned.family);
    }
  };
}

function unreachable(): ComfyUiError {
  return new ComfyUiError("COMFYUI_UNREACHABLE", "无法连接 ComfyUI 服务。");
}

/** 默认传输：node:http/https，signal 驱动中止；agent 关闭（每请求独立连接）。 */
const nodeTransport: ComfyUiTransport = (input) => new Promise((resolvePromise, reject) => {
  const mod = input.url.protocol === "https:" ? https : http;
  const request = mod.request(input.url, {
    method: input.method,
    headers: input.headers,
    signal: input.signal,
    lookup: input.lookup as http.RequestOptions["lookup"],
    agent: false,
  }, (response) => {
    resolvePromise({
      status: response.statusCode ?? 0,
      headers: response.headers,
      body: response,
      cancel: () => response.destroy(),
    });
  });
  request.on("error", reject);
  request.end(input.body);
});

export function createComfyUiClient(
  settings: Pick<ComfyUiSettings, "baseUrl" | "requestTimeoutMs" | "apiKey">,
  options: { resolver?: ComfyUiResolver; transport?: ComfyUiTransport } = {},
): ComfyUiClient {
  const resolveHost = options.resolver ?? defaultResolver;
  const transport = options.transport ?? nodeTransport;

  function headers(): Record<string, string> {
    return settings.apiKey
      ? { Authorization: `Bearer ${settings.apiKey}` }
      : {};
  }

  /** 总 deadline：DNS/连接/headers/完整 body 消费共用一个定时器。 */
  async function withDeadline<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), settings.requestTimeoutMs);
    try {
      return await run(controller.signal);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ComfyUiError("COMFYUI_TIMEOUT", "ComfyUI 连接超时。");
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function request(
    path: string,
    signal: AbortSignal,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<ComfyUiTransportResponse> {
    const url = new URL(`${settings.baseUrl}${path}`);
    const lookup = await resolveAndPin(url.hostname, resolveHost, signal);
    try {
      return await transport({
        method: init?.method ?? "GET",
        url,
        headers: { ...headers(), ...(init?.headers ?? {}) },
        ...(init?.body !== undefined ? { body: init.body } : {}),
        signal,
        lookup,
      });
    } catch {
      if (signal.aborted) throw new ComfyUiError("COMFYUI_TIMEOUT", "ComfyUI 连接超时。");
      throw unreachable();
    }
  }

  function requireOk(response: ComfyUiTransportResponse, message: string): void {
    // 3xx 同样拒绝：redirect 显式 fail-closed（node:http 本就不跟随；
    // 此处钉住契约——Authorization/body 绝不离开原始目标）。
    if (response.status < 200 || response.status >= 300) {
      response.cancel();
      throw new ComfyUiError("COMFYUI_REJECTED", message);
    }
  }

  /** 流式上限读取：越界即 cancel（无 Content-Length / chunked 同样受控）。 */
  async function readBody(
    response: ComfyUiTransportResponse,
    signal: AbortSignal,
    maxBytes: number,
  ): Promise<Buffer> {
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for await (const chunk of response.body) {
        total += chunk.length;
        if (total > maxBytes) {
          response.cancel();
          throw new ComfyUiError("COMFYUI_INVALID_RESPONSE", "ComfyUI 返回了无法识别的响应。");
        }
        chunks.push(chunk);
      }
    } catch (error) {
      if (error instanceof ComfyUiError) throw error;
      if (signal.aborted) throw new ComfyUiError("COMFYUI_TIMEOUT", "ComfyUI 连接超时。");
      throw unreachable();
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  }

  async function readJson(
    response: ComfyUiTransportResponse,
    signal: AbortSignal,
  ): Promise<unknown> {
    const data = await readBody(response, signal, COMFYUI_JSON_MAX_BYTES);
    try {
      return JSON.parse(data.toString("utf8")) as unknown;
    } catch {
      throw new ComfyUiError("COMFYUI_INVALID_RESPONSE", "ComfyUI 返回了无法识别的响应。");
    }
  }

  return {
    async systemStats() {
      const startedAt = Date.now();
      await withDeadline(async (signal) => {
        const response = await request("/system_stats", signal, { method: "GET" });
        requireOk(response, "ComfyUI 拒绝了连接测试。");
        const body = await readJson(response, signal);
        if (typeof body !== "object" || body === null) {
          throw new ComfyUiError("COMFYUI_INVALID_RESPONSE", "ComfyUI 返回了无法识别的响应。");
        }
      });
      return { latencyMs: Date.now() - startedAt };
    },

    async queuePrompt(graph) {
      return withDeadline(async (signal) => {
        const response = await request("/prompt", signal, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: graph }),
        });
        // 不回读/回显错误 body（可能含节点内部细节）。
        requireOk(response, "ComfyUI 拒绝了本次场景图任务。");
        const body = await readJson(response, signal);
        const promptId = typeof body === "object" && body !== null
          ? (body as { prompt_id?: unknown }).prompt_id
          : null;
        if (typeof promptId !== "string" || !promptId.trim()) {
          throw new ComfyUiError("COMFYUI_INVALID_RESPONSE", "ComfyUI 返回了无法识别的响应。");
        }
        return { promptId };
      });
    },

    async history(promptId) {
      if (!/^[a-zA-Z0-9_.-]+$/.test(promptId)) {
        throw new ComfyUiError("COMFYUI_INVALID_RESPONSE", "ComfyUI 返回了无法识别的响应。");
      }
      return withDeadline(async (signal) => {
        const response = await request(`/history/${encodeURIComponent(promptId)}`, signal, { method: "GET" });
        requireOk(response, "ComfyUI 拒绝了生成状态查询。");
        const body = await readJson(response, signal);
        if (typeof body !== "object" || body === null) {
          throw new ComfyUiError("COMFYUI_INVALID_RESPONSE", "ComfyUI 返回了无法识别的响应。");
        }
        const entry = (body as Record<string, unknown>)[promptId];
        if (typeof entry !== "object" || entry === null) return { status: "pending" as const };
        const status = (entry as { status?: { status_str?: unknown } }).status;
        if (status?.status_str === "error") return { status: "failed" as const };
        const outputs = (entry as { outputs?: Record<string, { images?: unknown }> }).outputs;
        if (!outputs || typeof outputs !== "object") return { status: "pending" as const };
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
                status: "ready" as const,
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
        return { status: "pending" as const };
      });
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
      return withDeadline(async (signal) => {
        const query = new URLSearchParams({
          filename: ref.filename,
          subfolder: ref.subfolder,
          type: "output",
        });
        const response = await request(`/view?${query.toString()}`, signal, { method: "GET" });
        requireOk(response, "ComfyUI 拒绝了输出图下载。");
        const declared = Number(response.headers["content-length"] ?? 0);
        if (declared > COMFYUI_IMAGE_MAX_BYTES) {
          response.cancel();
          throw new ComfyUiError("COMFYUI_INVALID_RESPONSE", "ComfyUI 输出图超出大小上限。");
        }
        // 无 Content-Length / chunked：流式计数上限（越界即中止，绝不先完整载入）。
        const data = await readBody(response, signal, COMFYUI_IMAGE_MAX_BYTES);
        if (data.length === 0) {
          throw new ComfyUiError("COMFYUI_INVALID_RESPONSE", "ComfyUI 输出图超出大小上限。");
        }
        const contentType = sniffImageContentType(data);
        if (!contentType) {
          throw new ComfyUiError("COMFYUI_INVALID_RESPONSE", "ComfyUI 输出不是可识别的图片格式。");
        }
        return { data, contentType };
      });
    },
  };
}
