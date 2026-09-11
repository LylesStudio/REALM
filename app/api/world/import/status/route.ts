/**
 * v37 H.1：GET /api/world/import/status?jobId=<id>——operator 或目标 world
 * owner；其他/不存在 → 404。懒 reconcile 先行。
 */
import { createWorldImportService } from "../../../../../modules/application/world-import-service.ts";
import { LOCAL_RECORD_SCOPE } from "../../../../../modules/application/local-record-service.ts";
import { getSharedRuntimePool } from "../../../world-scope.ts";
import {
  resolveRequestPrincipal,
  unauthorizedResponse,
} from "../../../auth-context.ts";
import { getTransferPool, transferRouteError } from "../../transfer-shared.ts";
import { withWorkspaceTransaction } from "../../../../../database/postgres/workspace-transaction.ts";

export const runtime = "nodejs";

export async function GET(request: Request) {
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
    const jobId = new URL(request.url).searchParams.get("jobId")?.trim() ?? "";
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
    await service.reconcile();
    const job = await service.getStatus(jobId);
    if (!job) {
      return Response.json(
        { ok: false as const, error: { code: "JOB_NOT_FOUND", message: "import job not found." } },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      );
    }
    let allowed = job.operatorPrincipal === principalId;
    if (!allowed && job.targetWorldId) {
      // 目标 world owner 可读（导入者经 bootstrap 已是 owner；导入前由
      // operator 读）。
      const runtimeUrl = process.env.REALM_RUNTIME_DATABASE_URL;
      if (runtimeUrl) {
        const role = await withWorkspaceTransaction(
          getSharedRuntimePool(runtimeUrl),
          LOCAL_RECORD_SCOPE.workspaceId,
          async (client) => {
            const membership = await client.query<{ role: string }>(
              `SELECT role FROM player_world_memberships
               WHERE workspace_id = $1 AND world_id = $2 AND principal_id = $3`,
              [LOCAL_RECORD_SCOPE.workspaceId, job.targetWorldId, principalId],
            );
            return membership.rows[0]?.role ?? null;
          },
          { readOnly: true },
        );
        allowed = role === "owner";
      }
    }
    if (!allowed) {
      return Response.json(
        { ok: false as const, error: { code: "JOB_NOT_FOUND", message: "import job not found." } },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      );
    }
    return Response.json(
      {
        ok: true as const,
        job: {
          id: job.id,
          status: job.status,
          mode: job.mode,
          errorCode: job.errorCode,
          result: job.result,
          updatedAt: job.updatedAt,
          events: job.events,
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return transferRouteError(error);
  }
}
