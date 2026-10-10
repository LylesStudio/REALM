import assert from "node:assert/strict";
import test from "node:test";
import {
  createHttpOutboxDeliverySink,
} from "../modules/application/outbox-delivery-sink.ts";
import {
  PermanentOutboxPublishError,
  RetryableOutboxPublishError,
  type OutboxPublishRequest,
} from "../modules/application/outbox-dispatcher.ts";

const request: OutboxPublishRequest = {
  messageId: "message-1",
  turnId: "turn-1",
  recordId: "record-1",
  topic: "record.events.committed",
  dedupeKey: "turn-1:delivery:v1",
  payload: {
    recordId: "record-1",
    eventIds: ["event-1"],
  },
  attempt: 2,
};

test("HTTP delivery sink posts a bounded, idempotent event envelope", async () => {
  let received: {
    input: RequestInfo | URL;
    init?: RequestInit;
  } | undefined;
  const sink = createHttpOutboxDeliverySink({
    endpoint: "https://delivery.example.test/realm/events",
    fetch: async (input, init) => {
      received = { input, init };
      return new Response(null, { status: 202 });
    },
  });

  await sink.publish(request);

  assert.ok(received);
  assert.equal(String(received.input), "https://delivery.example.test/realm/events");
  assert.equal(received.init?.method, "POST");
  const headers = new Headers(received.init?.headers);
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("idempotency-key"), request.dedupeKey);
  assert.equal(headers.get("x-realm-message-id"), request.messageId);
  assert.equal(headers.get("x-realm-topic"), request.topic);
  assert.deepEqual(JSON.parse(String(received.init?.body)), {
    version: 1,
    messageId: request.messageId,
    turnId: request.turnId,
    recordId: request.recordId,
    topic: request.topic,
    dedupeKey: request.dedupeKey,
    attempt: request.attempt,
    payload: request.payload,
  });
});

test("HTTP delivery sink classifies transient and permanent HTTP responses", async () => {
  const transient = createHttpOutboxDeliverySink({
    endpoint: "https://delivery.example.test/transient",
    fetch: async () => new Response(null, { status: 503 }),
  });
  await assert.rejects(
    transient.publish(request),
    (error: unknown) =>
      error instanceof RetryableOutboxPublishError
      && error.code === "OUTBOX_DELIVERY_HTTP_503",
  );

  const permanent = createHttpOutboxDeliverySink({
    endpoint: "https://delivery.example.test/permanent",
    fetch: async () => new Response(null, { status: 422 }),
  });
  await assert.rejects(
    permanent.publish(request),
    (error: unknown) =>
      error instanceof PermanentOutboxPublishError
      && error.code === "OUTBOX_DELIVERY_HTTP_422",
  );
});

test("HTTP delivery sink turns network and timeout failures into safe retryable errors", async () => {
  const network = createHttpOutboxDeliverySink({
    endpoint: "https://delivery.example.test/network",
    fetch: async () => {
      throw new Error("secret=must-not-be-persisted");
    },
  });
  await assert.rejects(
    network.publish(request),
    (error: unknown) =>
      error instanceof RetryableOutboxPublishError
      && error.code === "OUTBOX_DELIVERY_NETWORK"
      && error.safeMessage === "The delivery endpoint is unreachable.",
  );

  let aborted = false;
  const timeout = createHttpOutboxDeliverySink({
    endpoint: "https://delivery.example.test/timeout",
    timeoutMs: 5,
    fetch: async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      }, { once: true });
    }),
  });
  await assert.rejects(
    timeout.publish(request),
    (error: unknown) =>
      error instanceof RetryableOutboxPublishError
      && error.code === "OUTBOX_DELIVERY_TIMEOUT",
  );
  assert.equal(aborted, true);
});

test("HTTP delivery sink rejects credential-bearing or unsupported endpoints", () => {
  assert.throws(
    () => createHttpOutboxDeliverySink({ endpoint: "file:///tmp/events" }),
    (error: unknown) =>
      error instanceof Error
      && (error as { code?: string }).code === "OUTBOX_DELIVERY_URL_INVALID",
  );
  assert.throws(
    () => createHttpOutboxDeliverySink({ endpoint: "https://user:pass@delivery.example.test/events" }),
    (error: unknown) =>
      error instanceof Error
      && (error as { code?: string }).code === "OUTBOX_DELIVERY_URL_INVALID",
  );
});
