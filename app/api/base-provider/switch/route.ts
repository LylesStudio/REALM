/**
 * POST /api/base-provider/switch — 切换 operator 活动 base 内容版本。
 *
 * 目标版本必须可 serve 且不同于当前（同版本幂等 replay 200）；切换记录
 * previousVersion 作为回滚目标。引擎 base 版本变化后，不再兼容的已安装
 * RealmWorld 包在 mount/install/restore 闸 fail-closed
 *（BASE_VERSION_INCOMPATIBLE），rollback 可恢复兼容基线。
 */
import { LOCAL_RECORD_SCOPE } from "../../../../modules/application/local-record-service.ts";
import { switchRealmWorldTrustStoreBase } from "../../../../modules/world-transfer/realmworld-trust-store.ts";
import {
  resolveRequestPrincipal,
  unauthorizedResponse,
} from "../../auth-context.ts";
import {
  baseErrorResponse,
  baseLifecycleErrorResponse,
  baseProviderStatus,
  mutateBaseProviderDocument,
  parseBaseVersionField,
  readBaseProviderDocument,
} from "../env.ts";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const principalId = resolveRequestPrincipal(request, LOCAL_RECORD_SCOPE.principalId);
  if (!principalId) return unauthorizedResponse();
  const idempotencyKey = request.headers.get("idempotency-key")?.trim() ?? "";
  if (!idempotencyKey || idempotencyKey.length > 128) {
    return baseErrorResponse("INVALID_IDEMPOTENCY_KEY", "idempotency-key is required.", 400);
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return baseErrorResponse("INVALID_REQUEST", "A JSON request body is required.", 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return baseErrorResponse("INVALID_REQUEST", "The request body is invalid.", 400);
  }
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "targetVersion")) {
    return baseErrorResponse("INVALID_REQUEST", "Unknown base switch request field.", 400);
  }
  const targetVersion = parseBaseVersionField(input.targetVersion);
  if (!targetVersion) {
    return baseErrorResponse("BASE_VERSION_INVALID", "base version is invalid.", 400);
  }
  const store = await readBaseProviderDocument();
  if (!store) {
    return baseErrorResponse("BASE_PROVIDER_UNAVAILABLE", "base provider store is unavailable.", 503);
  }
  try {
    const result = await mutateBaseProviderDocument(store.path, (document) =>
      switchRealmWorldTrustStoreBase({ document, targetVersion }));
    return Response.json(
      {
        ok: true as const,
        replayed: !result.changed,
        base: baseProviderStatus(result.document),
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const mapped = baseLifecycleErrorResponse(error);
    if (mapped) return mapped;
    return baseErrorResponse("BASE_PROVIDER_FAILED", "base provider operation failed.", 500);
  }
}
