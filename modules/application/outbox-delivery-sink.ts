import { RuntimeInvariantError } from "../runtime/public.ts";
import {
  PermanentOutboxPublishError,
  RetryableOutboxPublishError,
  type OutboxPublishRequest,
  type OutboxPublishSink,
} from "./outbox-dispatcher.ts";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_USER_AGENT = "REALM-Outbox-Worker/1";

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface HttpOutboxDeliverySinkOptions {
  /** Operator-configured HTTP(S) endpoint. Credentials in the URL are rejected. */
  endpoint: string;
  timeoutMs?: number;
  userAgent?: string;
  fetch?: FetchLike;
}

/**
 * The public production delivery contract for the current Outbox topic family.
 *
 * The endpoint receives one JSON envelope per committed Outbox message. The
 * `Idempotency-Key` and message metadata headers let an external consumer make
 * delivery at-least-once but application-level idempotent. The response body is
 * deliberately ignored so provider diagnostics never enter the Runtime ledger.
 */
export function createHttpOutboxDeliverySink(
  options: HttpOutboxDeliverySinkOptions,
): OutboxPublishSink {
  const endpoint = validateEndpoint(options.endpoint);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new RuntimeInvariantError(
      "OUTBOX_DELIVERY_TIMEOUT_INVALID",
      "Outbox delivery timeout must be a positive safe integer.",
    );
  }
  const userAgent = options.userAgent?.trim() || DEFAULT_USER_AGENT;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new RuntimeInvariantError(
      "OUTBOX_DELIVERY_FETCH_UNAVAILABLE",
      "The Outbox HTTP delivery sink requires fetch.",
    );
  }

  return {
    async publish(request: OutboxPublishRequest): Promise<void> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "idempotency-key": request.dedupeKey,
            "user-agent": userAgent,
            "x-realm-message-id": request.messageId,
            "x-realm-topic": request.topic,
          },
          body: JSON.stringify({
            version: 1,
            messageId: request.messageId,
            turnId: request.turnId,
            recordId: request.recordId,
            topic: request.topic,
            dedupeKey: request.dedupeKey,
            attempt: request.attempt,
            payload: request.payload,
          }),
          signal: controller.signal,
        });
        await cancelResponseBody(response);
        if (response.status >= 200 && response.status < 300) return;
        if (isRetryableStatus(response.status)) {
          throw new RetryableOutboxPublishError(
            `OUTBOX_DELIVERY_HTTP_${response.status}`,
            "The delivery endpoint temporarily rejected the message.",
          );
        }
        throw new PermanentOutboxPublishError(
          `OUTBOX_DELIVERY_HTTP_${response.status}`,
          "The delivery endpoint rejected the message.",
        );
      } catch (error) {
        if (
          error instanceof RetryableOutboxPublishError
          || error instanceof PermanentOutboxPublishError
        ) {
          throw error;
        }
        if (controller.signal.aborted) {
          throw new RetryableOutboxPublishError(
            "OUTBOX_DELIVERY_TIMEOUT",
            "The delivery endpoint timed out.",
          );
        }
        throw new RetryableOutboxPublishError(
          "OUTBOX_DELIVERY_NETWORK",
          "The delivery endpoint is unreachable.",
        );
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function validateEndpoint(value: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new RuntimeInvariantError(
      "OUTBOX_DELIVERY_URL_INVALID",
      "Outbox delivery requires a non-empty HTTP(S) endpoint.",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new RuntimeInvariantError(
      "OUTBOX_DELIVERY_URL_INVALID",
      "Outbox delivery requires a valid HTTP(S) endpoint.",
    );
  }
  if (
    !["http:", "https:"].includes(parsed.protocol)
    || parsed.username !== ""
    || parsed.password !== ""
  ) {
    throw new RuntimeInvariantError(
      "OUTBOX_DELIVERY_URL_INVALID",
      "Outbox delivery accepts only credential-free HTTP(S) endpoints.",
    );
  }
  return parsed.toString();
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The status already classifies the delivery; body cleanup is best effort.
  }
}
