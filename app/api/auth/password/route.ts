import {
  LOCAL_RECORD_SCOPE,
} from "../../../../modules/application/local-record-service.ts";
import {
  createPostgresAccountRepository,
} from "../../../../database/postgres/public.ts";
import { AccountAuthError } from "../../../../database/postgres/account-repository.ts";
import { PasswordPolicyError } from "../../../../modules/identity/password.ts";
import { getSharedRuntimePool } from "../../world-scope.ts";
import {
  resolveRequestPrincipal,
  unauthorizedResponse,
} from "../../auth-context.ts";

export const runtime = "nodejs";

/**
 * 已登录账户的密码管理：set/change（有密码须校验旧密码）与明确清除
 * （confirmClear:true + 校验当前密码）。只作用当前 session principal——
 * 绝不接受客户端传入的 principal。
 */
export async function POST(request: Request) {
  const principalId = resolveRequestPrincipal(request, LOCAL_RECORD_SCOPE.principalId);
  if (!principalId) return unauthorizedResponse();
  const connectionString = process.env.REALM_RUNTIME_DATABASE_URL;
  if (!connectionString) {
    return Response.json(
      { ok: false as const, error: { code: "LOCAL_RUNTIME_NOT_INITIALIZED" } },
      { status: 503 },
    );
  }
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const currentPassword = typeof body?.currentPassword === "string" ? body.currentPassword : "";
  const newPassword = typeof body?.newPassword === "string" ? body.newPassword : "";
  const confirmClear = body?.confirmClear === true;

  const accounts = createPostgresAccountRepository(
    getSharedRuntimePool(connectionString),
  );
  try {
    if (newPassword.trim()) {
      await accounts.setAccountPassword(LOCAL_RECORD_SCOPE.workspaceId, principalId, {
        currentPassword,
        newPassword,
      });
      return Response.json({ ok: true as const, mode: "set" as const });
    }
    if (confirmClear) {
      await accounts.clearAccountPassword(LOCAL_RECORD_SCOPE.workspaceId, principalId, {
        currentPassword,
      });
      return Response.json({ ok: true as const, mode: "cleared" as const });
    }
    return Response.json(
      { ok: false as const, error: { code: "INVALID_REQUEST", message: "请填写新密码，或明确确认清除密码。" } },
      { status: 400 },
    );
  } catch (error) {
    if (error instanceof AccountAuthError || error instanceof PasswordPolicyError) {
      return Response.json(
        { ok: false as const, error: { code: "INVALID_CREDENTIALS", message: error.message } },
        { status: 401 },
      );
    }
    return Response.json(
      { ok: false as const, error: { code: "INTERNAL_ERROR", message: "密码设置失败，请稍后重试。" } },
      { status: 500 },
    );
  }
}
