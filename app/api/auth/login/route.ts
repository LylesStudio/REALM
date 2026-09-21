import {
  POSTGRES_DEMO_IDS,
  createLocalPostgresPool,
  createPostgresAccountRepository,
} from "../../../../database/postgres/public.ts";
import {
  sessionCookieHeader,
} from "../../../../modules/identity/auth.ts";
import {
  AccountAuthError,
} from "../../../../database/postgres/account-repository.ts";
import {
  PasswordPolicyError,
} from "../../../../modules/identity/password.ts";

export const runtime = "nodejs";

/**
 * 账户名 + 可选密码登录（DEPLOY-AUTH 新版语义）：
 * - 账户名即 display_name（1–40 字符）；密码可留空（无密码账户）。
 * - 不再读取/校验 REALM_ACCESS_TOKEN（已退役，存在也忽略）。
 * - 错误统一 INVALID_CREDENTIALS：不泄露账户是否存在/是否有密码。
 * - 30 天 httpOnly session cookie；cookie 只携带 principalId。
 */
export async function POST(request: Request) {
  const connectionString = process.env.REALM_RUNTIME_DATABASE_URL;
  if (!connectionString) {
    return Response.json(
      { ok: false as const, error: { code: "LOCAL_RUNTIME_NOT_INITIALIZED" } },
      { status: 503 },
    );
  }
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const displayName = typeof body?.displayName === "string" ? body.displayName.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!displayName || displayName.length > 40) {
    return Response.json(
      { ok: false as const, error: { code: "INVALID_REQUEST", message: "账户名需要 1–40 个字符。" } },
      { status: 400 },
    );
  }
  const accountRepository = createPostgresAccountRepository(
    createLocalPostgresPool(connectionString),
  );
  try {
    const account = await accountRepository.loginWithCredentials(
      POSTGRES_DEMO_IDS.workspace,
      displayName,
      password,
    );
    // 登录即加入默认世界：新身份立即可见全部 demo 数据（幂等）。
    await accountRepository.ensureDefaultWorldMembership(
      POSTGRES_DEMO_IDS.workspace,
      account.principalId,
    );
    return Response.json(
      {
        ok: true as const,
        principalId: account.principalId,
        displayName: account.displayName,
      },
      {
        headers: { "Set-Cookie": sessionCookieHeader(account.principalId) },
      },
    );
  } catch (error) {
    if (error instanceof AccountAuthError || error instanceof PasswordPolicyError) {
      return Response.json(
        { ok: false as const, error: { code: "INVALID_CREDENTIALS", message: error.message } },
        { status: 401 },
      );
    }
    return Response.json(
      { ok: false as const, error: { code: "INTERNAL_ERROR", message: "登录失败，请稍后重试。" } },
      { status: 500 },
    );
  }
}
