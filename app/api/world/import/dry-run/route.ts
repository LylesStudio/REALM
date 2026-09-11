/**
 * v37 H.1：POST /api/world/import/dry-run——multipart（file 必需 +
 * importMode 必填（preserve|copy）+ copyKey（copy 必填/preserve 禁出现）；
 * 多余字段 400）。有界流式 multipart（不调 formData/arrayBuffer）。
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
    // 字段白名单：file + importMode + copyKey；多余字段 400。
    const allowed = new Set(["file", "importMode", "copyKey"]);
    for (const key of parsed.fields.keys()) {
      if (!allowed.has(key)) {
        throw new WorldImportError("INVALID_REQUEST", `unexpected field: ${key}`);
      }
    }
    const importMode = parsed.fields.get("importMode");
    if (importMode !== "preserve" && importMode !== "copy") {
      throw new WorldImportError("INVALID_REQUEST", "importMode must be preserve|copy");
    }
    const copyKey = parsed.fields.get("copyKey");
    const service = createWorldImportService({
      transferPool,
      workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
    });
    const result = await service.dryRun({
      bytes: parsed.file.bytes,
      importMode,
      copyKey,
      operatorPrincipal: principalId,
    });
    return Response.json(
      {
        ok: true as const,
        jobId: result.jobId,
        report: result.report,
        ...(result.alreadyImported ? { alreadyImported: true as const } : {}),
        ...(result.alreadyValidated ? { alreadyValidated: true as const } : {}),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return transferRouteError(error);
  }
}
