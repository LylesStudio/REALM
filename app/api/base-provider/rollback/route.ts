/**
 * POST /api/base-provider/rollback — 回滚到最近一次 switch 前的活动
 * base 内容版本。无回滚目标 fail-closed 409 BASE_ROLLBACK_UNAVAILABLE。
 */
import { LOCAL_RECORD_SCOPE } from "../../../../modules/application/local-record-service.ts";
import { rollbackRealmWorldTrustStoreBase } from "../../../../modules/world-transfer/realmworld-trust-store.ts";
import {
  resolveRequestPrincipal,
  unauthorizedResponse,
} from "../../auth-context.ts";
import {
  baseErrorResponse,
  baseLifecycleErrorResponse,
  baseProviderStatus,
  mutateBaseProviderDocument,
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
  // 无请求体语义：rollback 不接受任何参数（目标恒为 previousVersion）。
  const store = await readBaseProviderDocument();
  if (!store) {
    return baseErrorResponse("BASE_PROVIDER_UNAVAILABLE", "base provider store is unavailable.", 503);
  }
  try {
    const result = await mutateBaseProviderDocument(store.path, (document) =>
      rollbackRealmWorldTrustStoreBase({ document }));
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
