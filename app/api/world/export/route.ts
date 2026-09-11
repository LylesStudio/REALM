/**
 * v37 H.1：POST /api/world/export——json body（D.3）→ 200
 * application/vnd.realm.world+zip 下载。owner-only（导出事务内重验）。
 */
import {
  createWorldExportService,
  normalizeExportScope,
} from "../../../../modules/application/world-export-service.ts";
import { LOCAL_RECORD_SCOPE } from "../../../../modules/application/local-record-service.ts";
import { getSharedRuntimePool } from "../../world-scope.ts";
import {
  resolveRequestPrincipal,
  unauthorizedResponse,
} from "../../auth-context.ts";
import { getTransferPool, transferRouteError } from "../transfer-shared.ts";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const principalId = resolveRequestPrincipal(
      request,
      LOCAL_RECORD_SCOPE.principalId,
    );
    if (!principalId) return unauthorizedResponse();
    const transferPool = getTransferPool();
    const runtimeUrl = process.env.REALM_RUNTIME_DATABASE_URL;
    if (!transferPool || !runtimeUrl) {
      return Response.json(
        { ok: false as const, error: { code: "TRANSFER_NOT_PROVISIONED", message: "realm transfer is not provisioned." } },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
    const body: unknown = await request.json();
    const scope = normalizeExportScope(body);
    const service = createWorldExportService({
      transferPool,
      runtimePool: getSharedRuntimePool(runtimeUrl),
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
      appVersion: "0.1.0",
    });
    const result = await service.exportWorld(scope, principalId);
    const filename = `${result.manifest.source.worldName}.realm`;
    return new Response(Buffer.from(result.bytes) as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.realm.world+zip",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(filename)}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return transferRouteError(error);
  }
}
