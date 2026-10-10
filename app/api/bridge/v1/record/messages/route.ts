/**
 * Bridge v1 production alias for POST /api/record/messages.
 *
 * Pure facade: delegates to the original handler unchanged. Body and
 * idempotency-key validation, opaque writeToken recovery, turn orchestration
 * and safe error mapping stay in the original route.
 */
import { POST as recordMessagesPOST } from "../../../../record/messages/route.ts";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return recordMessagesPOST(request);
}
