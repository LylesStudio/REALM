/**
 * GET /api/base-provider/status — operator 活动 base 内容版本状态。
 *
 * 只返回版本号与稳定机器码；trust-store 未配置时报告引擎默认（base 本身
 * 不依赖任何安装/信任配置）。绝不泄露 installRoot/路径/keyId/签名细节。
 */
import { LOCAL_RECORD_SCOPE } from "../../../../modules/application/local-record-service.ts";
import {
  resolveRequestPrincipal,
  unauthorizedResponse,
} from "../../auth-context.ts";
import {
  baseProviderStatus,
  readBaseProviderDocument,
} from "../env.ts";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const principalId = resolveRequestPrincipal(request, LOCAL_RECORD_SCOPE.principalId);
  if (!principalId) return unauthorizedResponse();
  const store = await readBaseProviderDocument();
  return Response.json(
    { ok: true as const, base: baseProviderStatus(store?.document ?? null) },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
