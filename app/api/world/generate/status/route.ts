import { LOCAL_RECORD_SCOPE } from "../../../../../modules/application/local-record-service.ts";
import { GENESIS_CREATION_REQUEST_ID } from "../../../../../modules/application/world-genesis.ts";
import {
  resolveRequestPrincipal,
  sessionProofFromRequest,
  unauthorizedResponse,
} from "../../../auth-context.ts";
import { createPostgresLibraryService } from "../../../../../modules/application/library-service.ts";
import { getSharedRuntimePool } from "../../../world-scope.ts";

export const runtime = "nodejs";

/**
 * 创世请求回读。只返回状态和已提交的记录入口，不返回草稿或指纹。
 */
export async function GET(request: Request) {
  try {
    const principalId = resolveRequestPrincipal(
      request,
      LOCAL_RECORD_SCOPE.principalId,
    );
    if (!principalId) return unauthorizedResponse();
    const requestId = new URL(request.url).searchParams.get("requestId")?.trim() ?? "";
    if (!GENESIS_CREATION_REQUEST_ID.test(requestId)) {
      return Response.json(
        {
          ok: false as const,
          error: { code: "INVALID_COMMAND", message: "Creation request id is invalid." },
        },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    const connectionString = process.env.REALM_RUNTIME_DATABASE_URL;
    if (!connectionString) {
      return Response.json(
        {
          ok: false as const,
          error: { code: "INTERNAL_ERROR", message: "The local library could not complete this request." },
        },
        { status: 500, headers: { "Cache-Control": "no-store" } },
      );
    }
    const service = createPostgresLibraryService(getSharedRuntimePool(connectionString));
    const committed = await service.readGenesisCreation(
      {
        workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
        principalId,
        sessionProof: sessionProofFromRequest(request) ?? "",
      },
      requestId,
    );
    if (!committed) {
      return Response.json(
        { ok: true as const, state: "not_committed" as const },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    return Response.json(
      { ok: true as const, state: "committed" as const, ...committed },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      {
        ok: false as const,
        error: { code: "INTERNAL_ERROR", message: "The local library could not complete this request." },
      },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
