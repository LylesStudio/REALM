/**
 * Bridge v1 Local Record API boundary.
 *
 * Covers:
 * - modules/application/local-record-api-v1.ts route builders (exact paths,
 *   URL encoding, fail-closed input validation) and the typed client seam
 *   (fetch/EventSource injection, header/body shape, fail-closed validation,
 *   stable error mapping);
 * - the app/api/bridge/v1/record* aliases proving delegation to the original
 *   /api/record* handlers: identical stable responses on no-DB seams
 *   (missing runtime, invalid cursor/request, auth fail-closed) and preserved
 *   text/event-stream + no-store SSE semantics.
 *
 * Pure in-memory: loopback URLs point at a closed port, session cookies are
 * locally signed with a test-only secret, and no shared database is touched.
 */
import assert from "node:assert/strict";
import test from "node:test";

process.env.REALM_SESSION_SECRET ??= "test-only-local-record-api-v1-secret";

import {
  LOCAL_RECORD_API_V1_BASE,
  LOCAL_RECORD_API_V1_MAJOR,
  LocalRecordApiV1Error,
  createLocalRecordApiV1Client,
  recordEventsRouteV1,
  recordGoalEventsRouteV1,
  recordGoalsRouteV1,
  recordMessagesRouteV1,
  recordRouteV1,
  type LocalRecordApiV1FetchLike,
} from "../modules/application/local-record-api-v1.ts";
import { closeDefaultLocalRecordService } from "../modules/application/local-record-service.ts";
import { SESSION_COOKIE, createSessionValue } from "../modules/identity/auth.ts";
import { GET as recordGET } from "../app/api/record/route.ts";
import { GET as recordEventsGET } from "../app/api/record/events/route.ts";
import { POST as recordMessagesPOST } from "../app/api/record/messages/route.ts";
import { GET as recordGoalsGET } from "../app/api/record/goals/route.ts";
import { GET as recordGoalEventsGET } from "../app/api/record/goals/events/route.ts";
import { GET as bridgeRecordGET } from "../app/api/bridge/v1/record/route.ts";
import { GET as bridgeEventsGET } from "../app/api/bridge/v1/record/events/route.ts";
import { POST as bridgeMessagesPOST } from "../app/api/bridge/v1/record/messages/route.ts";
import { GET as bridgeGoalsGET } from "../app/api/bridge/v1/record/goals/route.ts";
import { GET as bridgeGoalEventsGET } from "../app/api/bridge/v1/record/goals/events/route.ts";

const RUNTIME_ENV = "REALM_RUNTIME_DATABASE_URL";
/** Loopback URL with a closed port: gate on, but no database is reachable. */
const CLOSED_LOOPBACK_URL =
  "postgresql://realm_runtime@127.0.0.1:1/realm_bridge_v1_unavailable";

async function withRuntimeEnv(
  value: string | undefined,
  run: () => Promise<void>,
): Promise<void> {
  const saved = process.env[RUNTIME_ENV];
  if (value === undefined) delete process.env[RUNTIME_ENV];
  else process.env[RUNTIME_ENV] = value;
  try {
    await run();
  } finally {
    if (saved === undefined) delete process.env[RUNTIME_ENV];
    else process.env[RUNTIME_ENV] = saved;
    await closeDefaultLocalRecordService();
  }
}

function sessionCookie(): string {
  return `${SESSION_COOKIE}=${createSessionValue("principal_bridge_v1_test")}`;
}

/** Alias and original must read back the same stable response on a seam. */
async function expectSameJsonResponse(
  alias: Promise<Response>,
  original: Promise<Response>,
  status: number,
): Promise<Record<string, unknown>> {
  const [aliasResponse, originalResponse] = await Promise.all([alias, original]);
  assert.equal(aliasResponse.status, status);
  assert.equal(originalResponse.status, status);
  const aliasBody = await aliasResponse.json() as Record<string, unknown>;
  const originalBody = await originalResponse.json() as Record<string, unknown>;
  assert.deepEqual(aliasBody, originalBody);
  return aliasBody;
}

// ---------------------------------------------------------------------------
// Route builders.
// ---------------------------------------------------------------------------

test("v1 contract: base path and major version are stable", () => {
  assert.equal(LOCAL_RECORD_API_V1_MAJOR, 1);
  assert.equal(LOCAL_RECORD_API_V1_BASE, "/api/bridge/v1/record");
});

test("v1 route builders produce the five fixed Bridge v1 paths", () => {
  assert.equal(recordRouteV1(), "/api/bridge/v1/record");
  assert.equal(
    recordRouteV1({ recordId: "record_first_watch" }),
    "/api/bridge/v1/record?recordId=record_first_watch",
  );
  assert.equal(
    recordEventsRouteV1({ recordId: "r1", afterOrdinal: 42 }),
    "/api/bridge/v1/record/events?recordId=r1&afterOrdinal=42",
  );
  assert.equal(
    recordEventsRouteV1({ recordId: "r1" }),
    "/api/bridge/v1/record/events?recordId=r1",
  );
  assert.equal(
    recordMessagesRouteV1(),
    "/api/bridge/v1/record/messages",
  );
  assert.equal(
    recordGoalsRouteV1({ recordId: "r1" }),
    "/api/bridge/v1/record/goals?recordId=r1",
  );
  assert.equal(
    recordGoalEventsRouteV1({ recordId: "r1", afterOrdinal: 7 }),
    "/api/bridge/v1/record/goals/events?recordId=r1&afterOrdinal=7",
  );
});

test("v1 route builders URL-encode recordId", () => {
  const recordId = "record with space/and?query";
  assert.equal(
    recordRouteV1({ recordId }),
    `/api/bridge/v1/record?${new URLSearchParams({ recordId })}`,
  );
});

test("v1 route builders fail closed on invalid recordId/cursor", () => {
  for (const bad of ["", "  ", " padded", "padded ", "x".repeat(257)]) {
    assert.throws(
      () => recordRouteV1({ recordId: bad }),
      (error: unknown) =>
        error instanceof LocalRecordApiV1Error
        && error.code === "INVALID_ROUTE_INPUT",
      `recordId ${JSON.stringify(bad)} must be rejected`,
    );
  }
  assert.throws(
    () => recordGoalsRouteV1({ recordId: undefined as unknown as string }),
    (error: unknown) =>
      error instanceof LocalRecordApiV1Error
      && error.code === "INVALID_ROUTE_INPUT",
  );
  for (const bad of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
    assert.throws(
      () => recordEventsRouteV1({ recordId: "r1", afterOrdinal: bad }),
      (error: unknown) =>
        error instanceof LocalRecordApiV1Error
        && error.code === "INVALID_ROUTE_INPUT",
      `afterOrdinal ${bad} must be rejected`,
    );
  }
});

// ---------------------------------------------------------------------------
// Typed client seam.
// ---------------------------------------------------------------------------

interface FetchCall {
  url: string;
  init: { method: string; headers: Record<string, string>; body?: string };
}

function fakeFetch(handler: (call: FetchCall) => { status: number; body: unknown }) {
  const calls: FetchCall[] = [];
  const fetchImpl: LocalRecordApiV1FetchLike = async (url, init) => {
    const call: FetchCall = { url, init };
    calls.push(call);
    const result = handler(call);
    return { status: result.status, json: async () => result.body };
  };
  return { calls, fetch: fetchImpl };
}

test("v1 client: loadRecord GETs the record route and returns ok payload", async () => {
  const envelope = {
    ok: true,
    record: { id: "r1" },
    writeToken: "opaque-token",
    viewer: { cursor: "viewer-local" },
  };
  const backend = fakeFetch(() => ({ status: 200, body: envelope }));
  const client = createLocalRecordApiV1Client({ fetch: backend.fetch });
  const result = await client.loadRecord({ recordId: "r1" });
  assert.deepEqual(result, envelope);
  assert.equal(backend.calls.length, 1);
  assert.equal(backend.calls[0].url, "/api/bridge/v1/record?recordId=r1");
  assert.equal(backend.calls[0].init.method, "GET");
  assert.equal(backend.calls[0].init.body, undefined);
});

test("v1 client: baseUrl prefix is applied and trailing slashes trimmed", async () => {
  const backend = fakeFetch(() => ({ status: 200, body: { ok: true, onboarding: true } }));
  const client = createLocalRecordApiV1Client({
    fetch: backend.fetch,
    baseUrl: "http://127.0.0.1:3000/",
  });
  const result = await client.loadRecord();
  assert.deepEqual(result, { ok: true, onboarding: true });
  assert.equal(
    backend.calls[0].url,
    "http://127.0.0.1:3000/api/bridge/v1/record",
  );
});

test("v1 client: submitMessage POSTs JSON with the Idempotency-Key header", async () => {
  const turn = { ok: true, disposition: "committed", record: { id: "r1" } };
  const backend = fakeFetch(() => ({ status: 201, body: turn }));
  const client = createLocalRecordApiV1Client({ fetch: backend.fetch });
  const result = await client.submitMessage({
    recordId: "r1",
    content: "我观察蜡封边缘。",
    clientMessageId: "client-msg-1",
    writeToken: "opaque-token",
    actionSelection: { affordanceId: "skill.careful_observation.letter_seal" },
  });
  assert.deepEqual(result, turn);
  assert.equal(backend.calls[0].url, "/api/bridge/v1/record/messages");
  assert.equal(backend.calls[0].init.method, "POST");
  assert.equal(
    backend.calls[0].init.headers["Content-Type"],
    "application/json",
  );
  assert.equal(
    backend.calls[0].init.headers["Idempotency-Key"],
    "client-msg-1",
  );
  assert.deepEqual(JSON.parse(backend.calls[0].init.body ?? ""), {
    recordId: "r1",
    content: "我观察蜡封边缘。",
    clientMessageId: "client-msg-1",
    writeToken: "opaque-token",
    actionSelection: { affordanceId: "skill.careful_observation.letter_seal" },
  });
});

test("v1 client: submitMessage fails closed before any fetch on invalid input", async () => {
  const backend = fakeFetch(() => ({ status: 200, body: { ok: true } }));
  const client = createLocalRecordApiV1Client({ fetch: backend.fetch });
  const invalidInputs: unknown[] = [
    { content: "", clientMessageId: "m", writeToken: "t" },
    { content: "hi", clientMessageId: "", writeToken: "t" },
    { content: "hi", clientMessageId: "m", writeToken: "" },
    { content: "hi", clientMessageId: "m", writeToken: "t", recordId: "  " },
    { content: "x".repeat(2_001), clientMessageId: "m", writeToken: "t" },
    {
      content: "hi",
      clientMessageId: "m",
      writeToken: "t",
      visibilityConfirmation: { decision: "secret" as "public" },
    },
    {
      content: "hi",
      clientMessageId: "m",
      writeToken: "t",
      visibilityConfirmation: null as never,
    },
  ];
  for (const input of invalidInputs) {
    // Validation throws synchronously (before any fetch); accept sync or
    // async surfaces and assert on the stable error code either way.
    let caught: unknown;
    try {
      await client.submitMessage(input as never);
    } catch (error) {
      caught = error;
    }
    assert.ok(
      caught instanceof LocalRecordApiV1Error
        && (caught.code === "INVALID_REQUEST" || caught.code === "INVALID_ROUTE_INPUT"),
      `input ${JSON.stringify(input)} must fail closed with a typed error`,
    );
  }
  assert.equal(backend.calls.length, 0);
});

test("v1 client: server error body maps to typed error with stable code", async () => {
  const backend = fakeFetch(() => ({
    status: 409,
    body: { ok: false, error: { code: "WRITE_CONFLICT", message: "stale token" } },
  }));
  const client = createLocalRecordApiV1Client({ fetch: backend.fetch });
  await assert.rejects(
    () => client.loadGoals({ recordId: "r1" }),
    (error: unknown) =>
      error instanceof LocalRecordApiV1Error
      && error.code === "WRITE_CONFLICT"
      && error.status === 409
      && error.message === "The bridge request was rejected."
      && !error.message.includes("stale token"),
  );
});

test("v1 client: malformed or failed responses map to safe generic codes", async () => {
  const notEnvelope = fakeFetch(() => ({ status: 200, body: { nope: 1 } }));
  await assert.rejects(
    () => createLocalRecordApiV1Client({ fetch: notEnvelope.fetch }).loadRecord(),
    (error: unknown) =>
      error instanceof LocalRecordApiV1Error && error.code === "INVALID_RESPONSE",
  );
  const failing: LocalRecordApiV1FetchLike = async () => {
    throw new Error("socket hang up (raw detail must not leak)");
  };
  await assert.rejects(
    () => createLocalRecordApiV1Client({ fetch: failing }).loadRecord(),
    (error: unknown) =>
      error instanceof LocalRecordApiV1Error
      && error.code === "REQUEST_FAILED"
      && !error.message.includes("socket hang up"),
  );
  const badStatus = fakeFetch(() => ({ status: 500, body: { ok: true } }));
  await assert.rejects(
    () => createLocalRecordApiV1Client({ fetch: badStatus.fetch }).loadRecord(),
    (error: unknown) =>
      error instanceof LocalRecordApiV1Error
      && error.code === "HTTP_ERROR"
      && error.status === 500,
  );
});

test("v1 client: baseUrl carrying credentials or non-http(s) scheme fails closed", () => {
  for (const bad of [
    "https://user:pass@example.com",
    "ftp://example.com",
    "has space",
    "back\\slash",
    "//evil.example",
    "/api?next=evil.example",
    "https://",
  ]) {
    assert.throws(
      () => createLocalRecordApiV1Client({ baseUrl: bad }),
      (error: unknown) =>
        error instanceof LocalRecordApiV1Error
        && error.code === "INVALID_ROUTE_INPUT",
      `baseUrl ${JSON.stringify(bad)} must be rejected`,
    );
  }
});

test("v1 client: stream openers use the injected EventSource factory", () => {
  const opened: string[] = [];
  const handle = {
    closed: false,
    close() { this.closed = true; },
    addEventListener() { /* test seam */ },
  };
  const client = createLocalRecordApiV1Client({
    eventSource: (url) => {
      opened.push(url);
      return handle;
    },
  });
  assert.equal(
    client.openCommittedEvents({ recordId: "r1", afterOrdinal: 9 }),
    handle,
  );
  assert.equal(client.openGoalEvents({ recordId: "r1" }), handle);
  assert.deepEqual(opened, [
    "/api/bridge/v1/record/events?recordId=r1&afterOrdinal=9",
    "/api/bridge/v1/record/goals/events?recordId=r1",
  ]);
  assert.throws(
    () => client.openCommittedEvents({ recordId: "" }),
    (error: unknown) =>
      error instanceof LocalRecordApiV1Error
      && error.code === "INVALID_ROUTE_INPUT",
  );
  assert.equal(opened.length, 2);
});

test("v1 client: EventSource construction failures are bounded", () => {
  const client = createLocalRecordApiV1Client({
    eventSource: () => {
      throw new Error("raw event source failure");
    },
  });
  assert.throws(
    () => client.openCommittedEvents({ recordId: "r1" }),
    (error: unknown) =>
      error instanceof LocalRecordApiV1Error
      && error.code === "EVENT_SOURCE_FAILED"
      && !error.message.includes("raw event source failure"),
  );
});

// ---------------------------------------------------------------------------
// Bridge v1 route aliases delegate to the original handlers.
// ---------------------------------------------------------------------------

test("bridge v1 record alias: missing runtime reads back the same 503 as /api/record", async () => {
  await withRuntimeEnv(undefined, async () => {
    const body = await expectSameJsonResponse(
      bridgeRecordGET(new Request("http://bridge.local/api/bridge/v1/record")),
      recordGET(new Request("http://bridge.local/api/record")),
      503,
    );
    assert.equal(
      (body.error as { code: string }).code,
      "LOCAL_RUNTIME_NOT_INITIALIZED",
    );
  });
});

test("bridge v1 record alias: auth gate fails closed exactly like /api/record", async () => {
  await withRuntimeEnv(CLOSED_LOOPBACK_URL, async () => {
    const body = await expectSameJsonResponse(
      bridgeRecordGET(new Request("http://bridge.local/api/bridge/v1/record")),
      recordGET(new Request("http://bridge.local/api/record")),
      401,
    );
    assert.equal((body.error as { code: string }).code, "UNAUTHORIZED");
  });
});

test("bridge v1 messages alias: missing runtime reads back the same 503", async () => {
  await withRuntimeEnv(undefined, async () => {
    const init = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    };
    await expectSameJsonResponse(
      bridgeMessagesPOST(new Request("http://bridge.local/api/bridge/v1/record/messages", init)),
      recordMessagesPOST(new Request("http://bridge.local/api/record/messages", init)),
      503,
    );
  });
});

test("bridge v1 messages alias: invalid JSON reads back the same 400", async () => {
  await withRuntimeEnv(CLOSED_LOOPBACK_URL, async () => {
    const init = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    };
    const body = await expectSameJsonResponse(
      bridgeMessagesPOST(new Request("http://bridge.local/api/bridge/v1/record/messages", init)),
      recordMessagesPOST(new Request("http://bridge.local/api/record/messages", init)),
      400,
    );
    assert.equal((body.error as { code: string }).code, "INVALID_JSON");
  });
});

test("bridge v1 messages alias: invalid request body reads back the same 400", async () => {
  await withRuntimeEnv(CLOSED_LOOPBACK_URL, async () => {
    const init = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        cookie: sessionCookie(),
      },
      body: JSON.stringify({
        content: "",
        clientMessageId: "m1",
        writeToken: "opaque",
      }),
    };
    const body = await expectSameJsonResponse(
      bridgeMessagesPOST(new Request("http://bridge.local/api/bridge/v1/record/messages", init)),
      recordMessagesPOST(new Request("http://bridge.local/api/record/messages", init)),
      400,
    );
    assert.equal((body.error as { code: string }).code, "INVALID_CONTENT");
  });
});

test("bridge v1 events alias: missing runtime reads back the same 503", async () => {
  await withRuntimeEnv(undefined, async () => {
    const body = await expectSameJsonResponse(
      bridgeEventsGET(new Request("http://bridge.local/api/bridge/v1/record/events?recordId=r1")),
      recordEventsGET(new Request("http://bridge.local/api/record/events?recordId=r1")),
      503,
    );
    assert.equal(
      (body.error as { code: string }).code,
      "LOCAL_RUNTIME_NOT_INITIALIZED",
    );
  });
});

test("bridge v1 events alias: auth gate fails closed exactly like /api/record/events", async () => {
  await withRuntimeEnv(CLOSED_LOOPBACK_URL, async () => {
    const body = await expectSameJsonResponse(
      bridgeEventsGET(new Request("http://bridge.local/api/bridge/v1/record/events?recordId=r1")),
      recordEventsGET(new Request("http://bridge.local/api/record/events?recordId=r1")),
      401,
    );
    assert.equal((body.error as { code: string }).code, "UNAUTHORIZED");
  });
});

test("bridge v1 events alias: invalid viewer cursor reads back the same 400", async () => {
  await withRuntimeEnv(CLOSED_LOOPBACK_URL, async () => {
    const headers = { cookie: sessionCookie() };
    const body = await expectSameJsonResponse(
      bridgeEventsGET(new Request(
        "http://bridge.local/api/bridge/v1/record/events?recordId=r1&afterOrdinal=abc",
        { headers },
      )),
      recordEventsGET(new Request(
        "http://bridge.local/api/record/events?recordId=r1&afterOrdinal=abc",
        { headers },
      )),
      400,
    );
    assert.equal((body.error as { code: string }).code, "INVALID_CURSOR");
  });
});

test("bridge v1 events alias: preserves text/event-stream and no-store semantics", async () => {
  await withRuntimeEnv(CLOSED_LOOPBACK_URL, async () => {
    const headers = { cookie: sessionCookie() };
    const [aliasResponse, originalResponse] = await Promise.all([
      bridgeEventsGET(new Request(
        "http://bridge.local/api/bridge/v1/record/events?recordId=r1&afterOrdinal=0",
        { headers },
      )),
      recordEventsGET(new Request(
        "http://bridge.local/api/record/events?recordId=r1&afterOrdinal=0",
        { headers },
      )),
    ]);
    try {
      for (const response of [aliasResponse, originalResponse]) {
        assert.equal(response.status, 200);
        assert.equal(
          response.headers.get("Content-Type"),
          "text/event-stream; charset=utf-8",
        );
        const cacheControl = response.headers.get("Cache-Control") ?? "";
        assert.ok(cacheControl.includes("no-store"));
        assert.ok(cacheControl.includes("no-transform"));
        assert.equal(response.headers.get("X-Accel-Buffering"), "no");
      }
      assert.equal(
        aliasResponse.headers.get("Content-Type"),
        originalResponse.headers.get("Content-Type"),
      );
    } finally {
      // The loopback LISTEN port is closed: the stream fails fast and closes;
      // cancel is the client-side cleanup either way.
      await aliasResponse.body?.cancel().catch(() => undefined);
      await originalResponse.body?.cancel().catch(() => undefined);
    }
  });
});

test("bridge v1 goals alias: missing runtime reads back the same 503", async () => {
  await withRuntimeEnv(undefined, async () => {
    const body = await expectSameJsonResponse(
      bridgeGoalsGET(new Request("http://bridge.local/api/bridge/v1/record/goals?recordId=r1")),
      recordGoalsGET(new Request("http://bridge.local/api/record/goals?recordId=r1")),
      503,
    );
    assert.equal((body.error as { code: string }).code, "RUNTIME_NOT_PROVISIONED");
  });
});

test("bridge v1 goals alias: auth gate and recordId validation match /api/record/goals", async () => {
  await withRuntimeEnv(CLOSED_LOOPBACK_URL, async () => {
    const unauthorized = await expectSameJsonResponse(
      bridgeGoalsGET(new Request("http://bridge.local/api/bridge/v1/record/goals?recordId=r1")),
      recordGoalsGET(new Request("http://bridge.local/api/record/goals?recordId=r1")),
      401,
    );
    assert.equal((unauthorized.error as { code: string }).code, "UNAUTHORIZED");
    const headers = { cookie: sessionCookie() };
    const invalid = await expectSameJsonResponse(
      bridgeGoalsGET(new Request("http://bridge.local/api/bridge/v1/record/goals", { headers })),
      recordGoalsGET(new Request("http://bridge.local/api/record/goals", { headers })),
      400,
    );
    assert.equal((invalid.error as { code: string }).code, "INVALID_REQUEST");
  });
});

test("bridge v1 goal events alias: missing runtime reads back the same 503", async () => {
  await withRuntimeEnv(undefined, async () => {
    const body = await expectSameJsonResponse(
      bridgeGoalEventsGET(new Request("http://bridge.local/api/bridge/v1/record/goals/events?recordId=r1")),
      recordGoalEventsGET(new Request("http://bridge.local/api/record/goals/events?recordId=r1")),
      503,
    );
    assert.equal(
      (body.error as { code: string }).code,
      "LOCAL_RUNTIME_NOT_INITIALIZED",
    );
  });
});

test("bridge v1 goal events alias: auth gate and invalid cursor match the original", async () => {
  await withRuntimeEnv(CLOSED_LOOPBACK_URL, async () => {
    const unauthorized = await expectSameJsonResponse(
      bridgeGoalEventsGET(new Request("http://bridge.local/api/bridge/v1/record/goals/events?recordId=r1")),
      recordGoalEventsGET(new Request("http://bridge.local/api/record/goals/events?recordId=r1")),
      401,
    );
    assert.equal((unauthorized.error as { code: string }).code, "UNAUTHORIZED");
    const headers = { cookie: sessionCookie() };
    const invalidCursor = await expectSameJsonResponse(
      bridgeGoalEventsGET(new Request(
        "http://bridge.local/api/bridge/v1/record/goals/events?recordId=r1&afterOrdinal=1.5",
        { headers },
      )),
      recordGoalEventsGET(new Request(
        "http://bridge.local/api/record/goals/events?recordId=r1&afterOrdinal=1.5",
        { headers },
      )),
      400,
    );
    assert.equal((invalidCursor.error as { code: string }).code, "INVALID_CURSOR");
  });
});
