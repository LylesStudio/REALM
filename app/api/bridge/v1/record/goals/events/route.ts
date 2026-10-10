/**
 * Bridge v1 production alias for GET /api/record/goals/events (Goal SSE).
 *
 * Pure facade: delegates to the original handler unchanged. NOTIFY wakeup
 * wiring, transition-ledger replay and the text/event-stream / no-store
 * response semantics stay in the original route.
 */
import { GET as recordGoalEventsGET } from "../../../../../record/goals/events/route.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return recordGoalEventsGET(request);
}
