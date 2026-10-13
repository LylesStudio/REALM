/**
 * RealmWorld 版本切换（Phase 4D）：POST /api/realmworld/switch-version。
 * 显式控制面动作：session + owner membership + 必填 idempotency-key +
 * operation=upgrade|downgrade + 严格 semver 方向校验 + 目标包 mount/验签/
 * runtime plan 解析（事务外）+ 单事务锁内 CAS 写 records.world_version +
 * 审计台账。规范与错误矩阵：docs/development/REALMWORLD-VERSION-LIFECYCLE.md。
 */
import { LOCAL_RECORD_SCOPE } from "../../../../modules/application/local-record-service.ts";
import {
  RealmWorldBindingError,
  createRealmWorldBindingService,
} from "../../../../modules/application/realmworld-binding-service.ts";
import { RealmWorldLoaderError } from "../../../../modules/world-transfer/realmworld-loader.ts";
import {
  RealmWorldRuntimeContentError,
  createInstalledRealmWorldInstantiationResolver,
} from "../../../../modules/world-transfer/realmworld-runtime-content.ts";
import { getSharedRuntimePool } from "../../world-scope.ts";
import {
  resolveRequestPrincipal,
  unauthorizedResponse,
} from "../../auth-context.ts";
import { readRealmWorldVerifier } from "../env.ts";

export const runtime = "nodejs";

function errorResponse(code: string, message: string, status: number): Response {
  return Response.json(
    { ok: false as const, error: { code, message } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

class RequestError extends Error {
  readonly code = "INVALID_REQUEST" as const;
}

function requiredIdentity(value: unknown, field: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 256
    || value.trim() !== value
    || !/^[A-Za-z0-9._:-]+$/.test(value)
  ) {
    throw new RequestError(`${field} is invalid.`);
  }
  return value;
}

function parseOperation(value: unknown): "upgrade" | "downgrade" {
  if (value !== "upgrade" && value !== "downgrade") {
    throw new RequestError("operation must be upgrade or downgrade.");
  }
  return value;
}

export async function POST(request: Request): Promise<Response> {
  const principalId = resolveRequestPrincipal(request, LOCAL_RECORD_SCOPE.principalId);
  if (!principalId) return unauthorizedResponse();
  const idempotencyKey = request.headers.get("idempotency-key")?.trim() ?? "";
  if (!idempotencyKey || idempotencyKey.length > 128) {
    return errorResponse("INVALID_IDEMPOTENCY_KEY", "idempotency-key is required.", 400);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("INVALID_REQUEST", "A JSON request body is required.", 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return errorResponse("INVALID_REQUEST", "The request body is invalid.", 400);
  }

  let recordId: string;
  let targetWorldVersion: string;
  let operation: "upgrade" | "downgrade";
  try {
    const input = body as Record<string, unknown>;
    recordId = requiredIdentity(input.recordId, "recordId");
    targetWorldVersion = requiredIdentity(input.targetWorldVersion, "targetWorldVersion");
    operation = parseOperation(input.operation);
  } catch (error) {
    if (error instanceof RequestError) return errorResponse(error.code, error.message, 400);
    return errorResponse("INVALID_REQUEST", "The request body is invalid.", 400);
  }

  const runtimeUrl = process.env.REALM_RUNTIME_DATABASE_URL;
  if (!runtimeUrl) {
    return errorResponse("RUNTIME_NOT_PROVISIONED", "The runtime database is not provisioned.", 503);
  }
  const verifier = await readRealmWorldVerifier();
  if (!verifier) {
    return errorResponse("REALMWORLD_CONTENT_UNAVAILABLE", "RealmWorld content is not installed or trusted.", 503);
  }

  // 目标内容闸：mount（重验签）+ runtime plan 解析——在写事务前完成；
  // 缺包/签名/identity/schema 任一失败 fail-closed，绝不回退 base/当前版本。
  const resolver = createInstalledRealmWorldInstantiationResolver({
    installRoot: verifier.installRoot,
    verifySignature: verifier.verifySignature,
    locale: "zh-CN",
    engineBaseVersion: verifier.engineBaseVersion,
  });
  const service = createRealmWorldBindingService({
    database: getSharedRuntimePool(runtimeUrl),
    validateTargetContent: async (worldId, worldVersion) => {
      // 目标必须 world-bound：base 哨兵不是已安装包（resolver 对 base 返回
      // null）；缺包/签名/identity/schema 错误由 loader/resolver 原样上抛。
      const plan = await resolver({ kind: "world", worldId, worldVersion });
      if (!plan) {
        throw new RealmWorldLoaderError(
          "WORLD_NOT_INSTALLED",
          "RealmWorld target content is not installed.",
        );
      }
    },
  });

  try {
    const result = await service.switchRecordWorldVersion(
      { workspaceId: LOCAL_RECORD_SCOPE.workspaceId, principalId },
      { recordId, targetWorldVersion, operation },
      idempotencyKey,
    );
    return Response.json(
      { ok: true as const, ...result },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof RealmWorldLoaderError) {
      if (error.code === "BASE_VERSION_INCOMPATIBLE") {
        return errorResponse("BASE_VERSION_INCOMPATIBLE", "RealmWorld package is not compatible with the active engine base version.", 409);
      }
      return errorResponse(error.code, "RealmWorld target content is not installed or trusted.", 503);
    }
    if (error instanceof RealmWorldRuntimeContentError) {
      if (error.code === "RUNTIME_IDENTITY_MISMATCH") {
        return errorResponse("REALMWORLD_IDENTITY_MISMATCH", "RealmWorld identity does not match the requested binding.", 409);
      }
      if (error.code === "RUNTIME_INVALID") {
        return errorResponse("REALMWORLD_CONTENT_INVALID", "RealmWorld content is invalid.", 422);
      }
      return errorResponse("REALMWORLD_CONTENT_UNAVAILABLE", "RealmWorld content is unavailable.", 503);
    }
    if (error instanceof RealmWorldBindingError) {
      switch (error.code) {
        case "RECORD_NOT_FOUND":
          return errorResponse(error.code, error.message, 404);
        case "NOT_OWNER":
          return errorResponse(error.code, error.message, 403);
        case "RECORD_ARCHIVED":
        case "WORLD_ARCHIVED":
        case "REALMWORLD_SWITCH_CONFLICT":
          return errorResponse(error.code, error.message, 409);
        case "INVALID_VERSION":
        case "INVALID_VERSION_DIRECTION":
          return errorResponse(error.code, error.message, 400);
      }
    }
    return errorResponse("REALMWORLD_SWITCH_FAILED", "RealmWorld version switch failed.", 500);
  }
}
