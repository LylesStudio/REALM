/**
 * Bridge v1 production alias for GET /api/record.
 *
 * This route is a pure facade: it delegates to the original /api/record
 * handler unchanged and copies no service/repository/permission/projection
 * logic. Auth, session principal resolution, player-safe envelope shaping,
 * writeToken issuance and error mapping all stay in the original route.
 * The /api/record path behavior is unchanged.
 */
import { GET as recordGET } from "../../../record/route.ts";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return recordGET(request);
}
