/**
 * POST /api/base-provider/activate — 首次显式激活 operator base 内容版本。
 *
 * 无 GUI；operator session 缺失/无效 fail-closed 401；目标版本必须是引擎
 * 可 serve 集合成员；已激活同版本按幂等 replay 返回 200。
 */
import { LOCAL_RECORD_SCOPE } from "../../../../modules/application/local-record-service.ts";
import { activateRealmWorldTrustStoreBase } from "../../../../modules/world-transfer/realmworld-trust-store.ts";
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
  if (Object.keys(input).some((key) => key !== "version")) {
    return baseErrorResponse("INVALID_REQUEST", "Unknown base activate request field.", 400);
  }
  const version = parseBaseVersionField(input.version);
  if (!version) {
    return baseErrorResponse("BASE_VERSION_INVALID", "base version is invalid.", 400);
  }
  const store = await readBaseProviderDocument();
  if (!store) {
    return baseErrorResponse("BASE_PROVIDER_UNAVAILABLE", "base provider store is unavailable.", 503);
  }
  try {
    const result = await mutateBaseProviderDocument(store.path, (document) =>
      activateRealmWorldTrustStoreBase({ document, version }));
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
