/**
 * 同源 RealmWorld WebUI 静态挂载：
 * GET /worlds/<worldId>/<worldVersion>/ui/[[...path]]
 *
 * 只读边界：仅 mount 已安装、已验签、已受 trust-store 信任的 RealmWorld
 *（readRealmWorldVerifier + mountRealmWorld），绝不在请求路径安装/写入包，
 * 绝不执行 bundle，也不暴露私有 API/SQL。请求 path 与精确 worldId/worldVersion
 * 绑定并二次核对 manifest identity；bridge major 不受支持即 fail-closed。
 * 所有错误映射为稳定 machine code，不回显 loader/verifier 原文、路径或签名细节。
 */
import {
  mountRealmWorld,
  RealmWorldLoaderError,
} from "../../../../../../modules/world-transfer/realmworld-loader.ts";
import {
  resolveRealmWorldWebUiAsset,
  RealmWorldWebUiBridgeError,
} from "../../../../../../modules/world-transfer/realmworld-webui-bridge.ts";
import {
  LOCAL_RECORD_SCOPE,
} from "../../../../../../modules/application/local-record-service.ts";
import { readRealmWorldVerifier } from "../../../../../api/realmworld/env.ts";
import {
  resolveRequestPrincipal,
  unauthorizedResponse,
} from "../../../../../api/auth-context.ts";

export const runtime = "nodejs";

/** 安全 MIME allowlist：bundle 只消费声明式静态资产。 */
const WEBUI_CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  wasm: "application/wasm",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  wav: "audio/wav",
  mp4: "video/mp4",
  webm: "video/webm",
};

function errorResponse(code: string, message: string, status: number): Response {
  return Response.json(
    { ok: false as const, error: { code, message } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function safeIdentity(value: unknown): string | null {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 256
    || value === "."
    || value === ".."
    || !/^[A-Za-z0-9._-]+$/.test(value)
  ) {
    return null;
  }
  return value;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ worldId: string; worldVersion: string; path?: string[] }> },
): Promise<Response> {
  const principalId = resolveRequestPrincipal(request, LOCAL_RECORD_SCOPE.principalId);
  if (!principalId) return unauthorizedResponse();

  const params = await context.params;
  const worldId = safeIdentity(params.worldId);
  const worldVersion = safeIdentity(params.worldVersion);
  if (!worldId || !worldVersion) {
    return errorResponse("INVALID_REQUEST", "World identity is invalid.", 400);
  }
  const segments = Array.isArray(params.path) ? params.path : [];
  for (const segment of segments) {
    if (typeof segment !== "string" || segment.length === 0 || segment.length > 256) {
      return errorResponse("INVALID_REQUEST", "WebUI asset path is invalid.", 400);
    }
  }

  const verifier = await readRealmWorldVerifier();
  if (!verifier) {
    return errorResponse(
      "REALMWORLD_CONTENT_UNAVAILABLE",
      "RealmWorld content is not installed or trusted.",
      503,
    );
  }

  let loaded: Awaited<ReturnType<typeof mountRealmWorld>>;
  try {
    loaded = await mountRealmWorld({
      installRoot: verifier.installRoot,
      worldId,
      worldVersion,
      verifySignature: verifier.verifySignature,
      engineBaseVersion: verifier.engineBaseVersion,
    });
  } catch (error) {
    if (error instanceof RealmWorldLoaderError && error.code === "WORLD_NOT_INSTALLED") {
      return errorResponse("REALMWORLD_NOT_INSTALLED", "RealmWorld is not installed.", 404);
    }
    // 验签失败、内容损坏、symlink 等一律 fail-closed 503，不回显原始错误。
    return errorResponse(
      "REALMWORLD_CONTENT_UNAVAILABLE",
      "RealmWorld content is unavailable.",
      503,
    );
  }

  if (loaded.manifest.worldId !== worldId || loaded.manifest.worldVersion !== worldVersion) {
    return errorResponse(
      "REALMWORLD_IDENTITY_MISMATCH",
      "RealmWorld identity does not match the requested binding.",
      409,
    );
  }

  let asset: ReturnType<typeof resolveRealmWorldWebUiAsset>;
  try {
    asset = resolveRealmWorldWebUiAsset(loaded, segments);
  } catch (error) {
    if (error instanceof RealmWorldWebUiBridgeError) {
      if (error.code === "UNSUPPORTED_BRIDGE_MAJOR") {
        return errorResponse(
          "WEBUI_BRIDGE_UNSUPPORTED",
          "RealmWorld WebUI bridge major is not supported.",
          501,
        );
      }
      if (error.code === "NO_WEBUI") {
        return errorResponse(
          "WEBUI_NOT_DECLARED",
          "RealmWorld does not declare a WebUI bundle.",
          404,
        );
      }
      if (error.code === "INVALID_PATH") {
        return errorResponse("INVALID_REQUEST", "WebUI asset path is invalid.", 400);
      }
      return errorResponse("WEBUI_ASSET_NOT_FOUND", "WebUI asset is not available.", 404);
    }
    return errorResponse("WEBUI_UNAVAILABLE", "RealmWorld WebUI is unavailable.", 503);
  }

  const dotIndex = asset.path.lastIndexOf(".");
  const extension = dotIndex === -1 ? "" : asset.path.slice(dotIndex + 1).toLowerCase();
  const contentType = WEBUI_CONTENT_TYPES[extension];
  if (!contentType) {
    return errorResponse(
      "WEBUI_MEDIA_TYPE_NOT_ALLOWED",
      "WebUI asset media type is not allowed.",
      415,
    );
  }

  return new Response(new Uint8Array(asset.bytes), {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
