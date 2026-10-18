import { LOCAL_RECORD_SCOPE, LocalRecordServiceError, getLocalRecordService, type LocalRecordService } from "../../../../modules/application/local-record-service.ts";
import { resolveRequestPrincipal, unauthorizedResponse } from "../../auth-context.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Single-host runtime progress. Always authorize afresh; never a durable event or model reasoning feed. */
export async function GET(request: Request): Promise<Response> {
  return handleGenerationGet(request, await getLocalRecordService());
}

export async function handleGenerationGet(request: Request, service: LocalRecordService): Promise<Response> {
  const principalId = resolveRequestPrincipal(request, LOCAL_RECORD_SCOPE.principalId);
  if (!principalId) return unauthorizedResponse();
  const recordId = new URL(request.url).searchParams.get("recordId");
  if (!recordId) return Response.json({ ok: false }, { status: 400 });
  try {
    const viewer = await service.authorizeRecordViewer(recordId, principalId);
    return Response.json({ ok: true, recordId, generation: await service.generationStatus(recordId, viewer) }, {
      headers: { "Cache-Control": "no-store, private" },
    });
  } catch (error) {
    const status = error instanceof LocalRecordServiceError
      ? error.code === "NOT_FOUND" ? 404 : error.code === "LOCAL_RUNTIME_NOT_INITIALIZED" ? 503 : 409
      : 500;
    return Response.json({ ok: false, error: { code: status === 404 ? "NOT_FOUND" : "GENERATION_STATUS_UNAVAILABLE" } }, {
      status, headers: { "Cache-Control": "no-store, private" },
    });
  }
}
