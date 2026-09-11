/**
 * 路由鉴权上下文：门禁启用时要求有效会话，否则回落本地单用户 principal。
 */
import {
  isAccessGateEnabled,
  principalFromRequest,
} from "../../modules/identity/auth.ts";

export function resolveRequestPrincipal(
  request: Request,
  fallbackPrincipalId: string,
): string | null {
  if (!isAccessGateEnabled()) return fallbackPrincipalId;
  return principalFromRequest(request);
}

export function unauthorizedResponse(): Response {
  return Response.json(
    { ok: false as const, error: { code: "UNAUTHORIZED", message: "需要登录。" } },
    { status: 401 },
  );
}
