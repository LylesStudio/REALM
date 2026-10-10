/**
 * Bridge v1 production alias for GET /api/record/goals.
 *
 * Pure facade: delegates to the original handler unchanged. Player-safe
 * Goal projection, installed-content definition resolution and visibility
 * rules stay in the original route; runtime evidence never crosses here.
 */
import { GET as recordGoalsGET } from "../../../../record/goals/route.ts";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return recordGoalsGET(request);
}
