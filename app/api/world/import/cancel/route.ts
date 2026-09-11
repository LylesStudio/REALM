/**
 * v37 H.1：POST /api/world/import/cancel——json { jobId }；operator 本人
 * （服务端断言会话 principal == job.operator_principal）→ 200；非
 * operator/不存在 → 404；executing/completed/failed → 409。
 */
import { createWorldImportService } from "../../../../../modules/application/world-import-service.ts";
import { LOCAL_RECORD_SCOPE } from "../../../../../modules/application/local-record-service.ts";
import {
  resolveRequestPrincipal,
  unauthorizedResponse,
} from "../../../auth-context.ts";
import { getTransferPool, transferRouteError } from "../../transfer-shared.ts";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const principalId = resolveRequestPrincipal(
      request,
      LOCAL_RECORD_SCOPE.principalId,
    );
    if (!principalId) return unauthorizedResponse();
    const transferPool = getTransferPool();
    if (!transferPool) {
      return Response.json(
        { ok: false as const, error: { code: "TRANSFER_NOT_PROVISIONED", message: "realm transfer is not provisioned." } },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
    const body = (await request.json()) as Record<string, unknown>;
    const jobId = typeof body.jobId === "string" ? body.jobId.trim() : "";
    if (!jobId) {
      return Response.json(
        { ok: false as const, error: { code: "INVALID_REQUEST", message: "jobId is required." } },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    const service = createWorldImportService({
      transferPool,
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
    });
    // operator 断言（服务端；非 operator/不存在 → 404 不泄露存在性）。
    const status = await service.getStatus(jobId);
    if (!status || status.operatorPrincipal !== principalId) {
      return Response.json(
        { ok: false as const, error: { code: "JOB_NOT_FOUND", message: "import job not found." } },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      );
    }
    const result = await service.cancel({ jobId });
    return Response.json(
      { ok: true as const, jobId, status: result.status, idempotent: result.idempotent },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return transferRouteError(error);
  }
}
