import {
  POSTGRES_DEMO_IDS,
  createLocalPostgresPool,
  createPostgresAccountRepository,
} from "../../../../database/postgres/public.ts";
import {
  isAccessGateEnabled,
  sessionCookieHeader,
  verifyAccessToken,
} from "../../../../modules/identity/auth.ts";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!isAccessGateEnabled()) {
    return Response.json(
      { ok: false as const, error: { code: "GATE_DISABLED", message: "本地回环未启用访问门禁，无需登录。" } },
      { status: 400 },
    );
  }
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const token = typeof body?.token === "string" ? body.token : "";
  const displayName = typeof body?.displayName === "string" ? body.displayName.trim() : "";
  if (!displayName || displayName.length > 40) {
    return Response.json(
      { ok: false as const, error: { code: "INVALID_REQUEST", message: "昵称需要 1–40 个字符。" } },
      { status: 400 },
    );
  }
  if (!verifyAccessToken(token)) {
    return Response.json(
      { ok: false as const, error: { code: "UNAUTHORIZED", message: "访问令牌不正确。" } },
      { status: 401 },
    );
  }
  const connectionString = process.env.REALM_RUNTIME_DATABASE_URL;
  if (!connectionString) {
    return Response.json(
      { ok: false as const, error: { code: "LOCAL_RUNTIME_NOT_INITIALIZED" } },
      { status: 503 },
    );
  }
  const accountRepository = createPostgresAccountRepository(
    createLocalPostgresPool(connectionString),
  );
  const account = await accountRepository.findOrCreate(POSTGRES_DEMO_IDS.workspace, displayName);
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
}
