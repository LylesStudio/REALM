import { clearSessionCookieHeader } from "../../../../modules/identity/auth.ts";

export const runtime = "nodejs";

export async function POST() {
  return Response.json(
    { ok: true as const },
    { headers: { "Set-Cookie": clearSessionCookieHeader() } },
  );
}
