import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "../app/api/realmworld/instantiate/route.ts";

async function responseError(response: Response): Promise<{ code: string; message: string }> {
  const body = await response.json() as { error: { code: string; message: string } };
  return body.error;
}

test("RealmWorld instantiate route requires an idempotency key before runtime access", async () => {
  const response = await POST(new Request("http://127.0.0.1/api/realmworld/instantiate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ worldId: "world_harbor", worldVersion: "1.2.0" }),
  }));
  assert.equal(response.status, 400);
  assert.deepEqual(await responseError(response), {
    code: "INVALID_IDEMPOTENCY_KEY",
    message: "idempotency-key is required.",
  });
});

test("RealmWorld instantiate route rejects malformed content identity and locale", async () => {
  const identityResponse = await POST(new Request("http://127.0.0.1/api/realmworld/instantiate", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "route-fixture",
    },
    body: JSON.stringify({ worldId: "world harbor", worldVersion: "1.2.0" }),
  }));
  assert.equal(identityResponse.status, 400);
  assert.equal((await responseError(identityResponse)).code, "INVALID_REQUEST");

  const localeResponse = await POST(new Request("http://127.0.0.1/api/realmworld/instantiate", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "route-fixture-locale",
    },
    body: JSON.stringify({ worldId: "world_harbor", worldVersion: "1.2.0", locale: "zh_CN" }),
  }));
  assert.equal(localeResponse.status, 400);
  assert.equal((await responseError(localeResponse)).code, "INVALID_REQUEST");
});
