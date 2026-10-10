import {
  createPostgresRealmRuntimeSaveRestorer,
  RealmRuntimeSaveRepositoryError,
  type RealmRuntimeSaveWorldBindingValidator,
} from "../../../../database/postgres/public.ts";
import {
  RealmRuntimeSaveError,
  parseRealmRuntimeSaveArchive,
} from "../../../../modules/world-transfer/realm-runtime-save.ts";
import {
  mountRealmWorld,
  RealmWorldLoaderError,
  type RealmWorldSignatureVerifier,
} from "../../../../modules/world-transfer/realmworld-loader.ts";
import { LOCAL_RECORD_SCOPE } from "../../../../modules/application/local-record-service.ts";
import { resolveRequestPrincipal, unauthorizedResponse } from "../../auth-context.ts";
import { getSharedRuntimePool } from "../../world-scope.ts";
import { readRealmWorldVerifier } from "../../realmworld/env.ts";

export const runtime = "nodejs";

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const RUNTIME_SAVE_CONTENT_TYPE = "application/vnd.realm.save+zip";

function errorResponse(code: string, status: number): Response {
  return Response.json(
    { ok: false as const, error: { code } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function repositoryStatus(code: RealmRuntimeSaveRepositoryError["code"]): number {
  if (code === "WORLD_NOT_FOUND" || code === "RECORD_NOT_FOUND") return 404;
  if (code === "WORLD_READ_ONLY") return 403;
  if (code === "RESTORE_ID_COLLISION" || code === "RESTORE_CONFLICT") return 409;
  if (code === "WORLD_ARCHIVED") return 409;
  if (code === "REALMWORLD_IDENTITY_MISMATCH") return 409;
  if (
    code === "REALMWORLD_VALIDATION_UNAVAILABLE"
    || code === "REALMWORLD_PACKAGE_MISSING"
    || code === "REALMWORLD_PACKAGE_UNTRUSTED"
  ) return 503;
  return 422;
}

/**
 * world-bound `.realm` restore 的 RealmWorld 信任闸：复用文件型
 * trust-store verifier + mount/load 语义，只读已安装包（绝不 install/
 * write/import/execute），并核对 mounted manifest identity 与 archive
 * binding 完全一致。缺包/验签/content-hash/identity 失败一律 fail-closed
 * 为稳定 machine code，绝不泄露 installRoot/keyId/签名/原始路径/raw error。
 */
export function createRealmRuntimeSaveWorldBindingValidator(environment: {
  installRoot: string;
  verifySignature: RealmWorldSignatureVerifier;
}): RealmRuntimeSaveWorldBindingValidator {
  return async (binding) => {
    let mounted;
    try {
      mounted = await mountRealmWorld({
        installRoot: environment.installRoot,
        worldId: binding.worldId,
        worldVersion: binding.worldVersion,
        verifySignature: environment.verifySignature,
      });
    } catch (error) {
      if (error instanceof RealmWorldLoaderError && error.code === "WORLD_NOT_INSTALLED") {
        throw new RealmRuntimeSaveRepositoryError(
          "REALMWORLD_PACKAGE_MISSING",
          "The bound RealmWorld package is not installed.",
        );
      }
      throw new RealmRuntimeSaveRepositoryError(
        "REALMWORLD_PACKAGE_UNTRUSTED",
        "The bound RealmWorld package failed trust verification.",
      );
    }
    if (
      mounted.manifest.worldId !== binding.worldId
      || mounted.manifest.worldVersion !== binding.worldVersion
    ) {
      throw new RealmRuntimeSaveRepositoryError(
        "REALMWORLD_IDENTITY_MISMATCH",
        "The mounted RealmWorld identity does not match the save binding.",
      );
    }
  };
}

export async function POST(request: Request) {
  const principalId = resolveRequestPrincipal(request, LOCAL_RECORD_SCOPE.principalId);
  if (!principalId) return unauthorizedResponse();

  const connectionString = process.env.REALM_RUNTIME_DATABASE_URL;
  if (!connectionString) return errorResponse("LOCAL_RUNTIME_NOT_INITIALIZED", 503);

  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== RUNTIME_SAVE_CONTENT_TYPE) {
    return errorResponse("INVALID_CONTENT_TYPE", 415);
  }
  const idempotencyKey = request.headers.get("idempotency-key")?.trim() ?? "";
  if (!idempotencyKey || idempotencyKey.length > 128) {
    return errorResponse("INVALID_IDEMPOTENCY_KEY", 400);
  }
  const targetWorldId = request.headers.get("x-realm-target-world")?.trim() || undefined;
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > MAX_ARCHIVE_BYTES) {
      return errorResponse("ARCHIVE_TOO_LARGE", 413);
    }
  }

  let bytes: Uint8Array;
  try {
    const body = new Uint8Array(await request.arrayBuffer());
    if (body.byteLength === 0 || body.byteLength > MAX_ARCHIVE_BYTES) {
      return errorResponse("ARCHIVE_TOO_LARGE", 413);
    }
    bytes = body;
  } catch {
    return errorResponse("INVALID_ARCHIVE", 400);
  }

  let archive;
  try {
    archive = parseRealmRuntimeSaveArchive(bytes);
  } catch (error) {
    if (error instanceof RealmRuntimeSaveError) {
      return errorResponse(error.code, 400);
    }
    return errorResponse("INVALID_ARCHIVE", 400);
  }

  // world-bound 存档：install/trust 配置缺失或无效同样 fail-closed（503），
  // 绝不退化为未验签；base 存档不读取任何 RealmWorld 配置。
  let validateWorldBinding: RealmRuntimeSaveWorldBindingValidator | undefined;
  if (archive.manifest.mode === "world-bound") {
    const verifier = await readRealmWorldVerifier();
    if (!verifier) {
      return errorResponse("REALMWORLD_VALIDATION_UNAVAILABLE", 503);
    }
    validateWorldBinding = createRealmRuntimeSaveWorldBindingValidator(verifier);
  }

  try {
    const restorer = createPostgresRealmRuntimeSaveRestorer(
      getSharedRuntimePool(connectionString),
      { validateWorldBinding },
    );
    const result = await restorer.restore({
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      principalId,
      archive,
      targetWorldId,
      idempotencyKey,
    });
    return Response.json(
      { ok: true as const, ...result },
      {
        status: result.replayed ? 200 : 201,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (error) {
    if (error instanceof RealmRuntimeSaveRepositoryError) {
      return errorResponse(error.code, repositoryStatus(error.code));
    }
    return errorResponse("RUNTIME_SAVE_RESTORE_FAILED", 500);
  }
}
