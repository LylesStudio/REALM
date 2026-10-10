/**
 * Bridge v1 production alias for GET /api/record/events (committed SSE).
 *
 * Pure facade: delegates to the original handler unchanged. Session
 * principal, viewer-local cursor parsing, loopback LISTEN wiring and the
 * text/event-stream / no-store response semantics stay in the original
 * route. No runtime fallback is introduced here.
 */
import { GET as recordEventsGET } from "../../../../record/events/route.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return recordEventsGET(request);
}
