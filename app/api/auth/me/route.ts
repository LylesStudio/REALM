import { LOCAL_RECORD_SCOPE } from "../../../../modules/application/local-record-service.ts";
import {
  createPostgresAccountRepository,
} from "../../../../database/postgres/public.ts";
import { getSharedRuntimePool } from "../../world-scope.ts";
import {
  isAccessGateEnabled,
  principalFromRequest,
} from "../../../../modules/identity/auth.ts";

export const runtime = "nodejs";

export async function GET(request: Request) {
  if (!isAccessGateEnabled()) {
    return Response.json({
      ok: true as const,
      gated: false,
      principalId: LOCAL_RECORD_SCOPE.principalId,
    });
  }
  const principalId = principalFromRequest(request);
  if (!principalId) {
    return Response.json(
      { ok: false as const, error: { code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }
  // 会话 cookie 只携带 principalId；昵称从 accounts 反查（best-effort，
  // 查不到不阻塞身份应答）。
  let displayName: string | null = null;
  let uiLanguage = "zh-CN";
  // 批次 T10-B8-A：accounts 列级 SELECT 下沉受限角色共享池（0012/0015
  // 已授）；缺 runtime URL 或读取失败同样 best-effort 回落，不泄漏错误。
  const connectionString = process.env.REALM_RUNTIME_DATABASE_URL;
  if (connectionString) {
    try {
      const pool = getSharedRuntimePool(connectionString);
      const account = await createPostgresAccountRepository(pool).findByPrincipal(
        LOCAL_RECORD_SCOPE.workspaceId,
        principalId,
      );
      displayName = account?.displayName ?? null;
      uiLanguage = account?.uiLanguage ?? "zh-CN";
  } catch {
      displayName = null;
    }
  }
  return Response.json({
    ok: true as const,
    gated: true,
    principalId,
    displayName,
    uiLanguage,
  });
}
