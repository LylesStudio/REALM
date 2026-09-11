import {
  LOCAL_RECORD_SCOPE,
} from "../../../../modules/application/local-record-service.ts";
import {
  createPostgresAccountRepository,
} from "../../../../database/postgres/public.ts";
import { getSharedRuntimePool } from "../../world-scope.ts";
import {
  normalizeUiLanguage,
} from "../../../../modules/i18n/public.ts";
import {
  resolveRequestPrincipal,
  unauthorizedResponse,
} from "../../auth-context.ts";

export const runtime = "nodejs";

/** 用户级界面语言保存：POST { language }（zh-CN/en/ja，非法值按默认中文）。 */
export async function POST(request: Request) {
  try {
    const principalId = resolveRequestPrincipal(
      request,
      LOCAL_RECORD_SCOPE.principalId,
    );
    if (!principalId) return unauthorizedResponse();
    const parsed: unknown = await request.json();
    const language = normalizeUiLanguage(
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>).language
        : undefined,
    );
    // 批次 T10-B8-A：ui_language 列级 UPDATE 下沉受限角色共享池（0015 已授）。
    const connectionString = process.env.REALM_RUNTIME_DATABASE_URL;
    if (!connectionString) {
      return Response.json(
        { ok: false as const, error: { code: "LOCAL_RUNTIME_NOT_INITIALIZED" } },
        { status: 503 },
      );
    }
    const pool = getSharedRuntimePool(connectionString);
    await createPostgresAccountRepository(pool).saveUiLanguage(
      LOCAL_RECORD_SCOPE.workspaceId,
      principalId,
      language,
    );
    return Response.json(
      { ok: true as const, language },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      { ok: false as const, error: { code: "INTERNAL_ERROR" } },
      { status: 500 },
    );
  }
}
