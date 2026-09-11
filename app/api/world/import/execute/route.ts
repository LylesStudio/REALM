/**
 * v37 H.1：POST /api/world/import/execute——multipart（file + jobId +
 * confirm='true'）。重传同包重算双 hash 比对 job（不等 409 PACK_MISMATCH）。
 */
import {
  MULTIPART_LIMITS,
  parseMultipartBounded,
} from "../../../../../modules/world-transfer/realm-pack.ts";
import {
  WorldImportError,
  createWorldImportService,
} from "../../../../../modules/application/world-import-service.ts";
import { LOCAL_RECORD_SCOPE } from "../../../../../modules/application/local-record-service.ts";
import {
  resolveRequestPrincipal,
  unauthorizedResponse,
} from "../../../auth-context.ts";
import {
  contentLengthOversized,
  getTransferPool,
  transferRouteError,
} from "../../transfer-shared.ts";

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
    if (contentLengthOversized(request, MULTIPART_LIMITS.bodyMaxBytes)) {
      return Response.json(
        { ok: false as const, error: { code: "PACK_TOO_LARGE", message: "body exceeds limit." } },
        { status: 413, headers: { "Cache-Control": "no-store" } },
      );
    }
    if (!request.body) {
      return Response.json(
        { ok: false as const, error: { code: "INVALID_REQUEST", message: "multipart body required." } },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    const parsed = await parseMultipartBounded({
      contentType: request.headers.get("content-type") ?? "",
      body: request.body as unknown as AsyncIterable<Uint8Array>,
      signal: request.signal,
    });
    const allowed = new Set(["file", "jobId", "confirm"]);
    for (const key of parsed.fields.keys()) {
      if (!allowed.has(key)) {
        throw new WorldImportError("INVALID_REQUEST", `unexpected field: ${key}`);
      }
    }
    const jobId = parsed.fields.get("jobId")?.trim() ?? "";
    if (!jobId || parsed.fields.get("confirm") !== "true") {
      throw new WorldImportError("INVALID_REQUEST", "jobId and confirm='true' are required");
    }
    const service = createWorldImportService({
      transferPool,
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
    });
    const result = await service.execute({
      bytes: parsed.file.bytes,
      jobId,
      operatorPrincipal: principalId,
    });
    return Response.json(
      {
        ok: true as const,
        jobId: result.jobId,
        worldId: result.worldId,
        alreadyImported: result.alreadyImported,
        report: result.report,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return transferRouteError(error);
  }
}
