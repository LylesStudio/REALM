/**
 * v37 H.1：GET /api/world/import/jobs?limit=<1..50, 默认 20>&offset=<≥0,
 * 默认 0>——仅 operator 本人；updated_at DESC；超界 offset 返回空数组。
 */
import { createWorldImportService } from "../../../../../modules/application/world-import-service.ts";
import { WorldImportError } from "../../../../../modules/application/world-import-service.ts";
import { LOCAL_RECORD_SCOPE } from "../../../../../modules/application/local-record-service.ts";
import {
  resolveRequestPrincipal,
  unauthorizedResponse,
} from "../../../auth-context.ts";
import { getTransferPool, transferRouteError } from "../../transfer-shared.ts";

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
    const params = new URL(request.url).searchParams;
    const limit = Number(params.get("limit") ?? "20");
    const offset = Number(params.get("offset") ?? "0");
    if (!Number.isInteger(limit) || limit < 1 || limit > 50
      || !Number.isInteger(offset) || offset < 0) {
      throw new WorldImportError("INVALID_REQUEST", "limit must be 1..50 and offset >= 0");
    }
    const service = createWorldImportService({
      transferPool,
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
    });
    await service.reconcile();
    const jobs = await service.listJobs({
      operatorPrincipal: principalId,
      limit,
      offset,
    });
    return Response.json(
      { ok: true as const, jobs },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return transferRouteError(error);
  }
}
