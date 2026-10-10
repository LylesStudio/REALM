import { LOCAL_RECORD_SCOPE } from "../modules/application/local-record-service.ts";
import { createOutboxWorkerRuntime } from "../modules/application/outbox-worker-runtime.ts";

/**
 * Production Outbox worker entrypoint. It is deliberately separate from
 * realm-dev.service: delivery failures must not change the Web process pool.
 *
 * Required environment:
 * - REALM_RUNTIME_DATABASE_URL: loopback realm_runtime connection
 * - REALM_OUTBOX_DELIVERY_URL: credential-free HTTP(S) consumer endpoint
 *
 * Optional:
 * - REALM_OUTBOX_WORKSPACES (comma-separated, default local demo workspace)
 * - REALM_OUTBOX_TOPICS (comma-separated, default record.events.committed)
 * - REALM_OUTBOX_MAX_ATTEMPTS / LEASE_DURATION_MS / BATCH_LIMIT /
 *   RETRY_DELAY_MS / DELIVERY_TIMEOUT_MS / IDLE_MIN_MS / IDLE_MAX_MS
 */

const connectionString = process.env.REALM_RUNTIME_DATABASE_URL;
if (!connectionString) {
  throw new Error("REALM_RUNTIME_DATABASE_URL is required for the Outbox worker.");
}
const deliveryUrl = process.env.REALM_OUTBOX_DELIVERY_URL;
if (!deliveryUrl) {
  throw new Error("REALM_OUTBOX_DELIVERY_URL is required for the Outbox worker.");
}

const workspaces = csv(
  process.env.REALM_OUTBOX_WORKSPACES,
  LOCAL_RECORD_SCOPE.workspaceId,
);
const topics = csv(
  process.env.REALM_OUTBOX_TOPICS,
  "record.events.committed",
);

const runtime = createOutboxWorkerRuntime({
  connectionString,
  deliveryUrl,
  workspaces,
  topics,
  maxAttempts: positiveInteger(process.env.REALM_OUTBOX_MAX_ATTEMPTS, 5),
  leaseDurationMs: positiveInteger(process.env.REALM_OUTBOX_LEASE_DURATION_MS, 30_000),
  batchLimit: positiveInteger(process.env.REALM_OUTBOX_BATCH_LIMIT, 25),
  retryDelayMs: positiveInteger(process.env.REALM_OUTBOX_RETRY_DELAY_MS, 5_000),
  deliveryTimeoutMs: positiveInteger(process.env.REALM_OUTBOX_DELIVERY_TIMEOUT_MS, 10_000),
  idleMinMs: positiveInteger(process.env.REALM_OUTBOX_IDLE_MIN_MS, 1_000),
  idleMaxMs: positiveInteger(process.env.REALM_OUTBOX_IDLE_MAX_MS, 15_000),
});

process.once("SIGTERM", () => void runtime.stop());
process.once("SIGINT", () => void runtime.stop());

try {
  await runtime.start();
} finally {
  await runtime.stop();
}

function csv(value, fallback) {
  const values = (value ?? fallback)
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (values.length === 0) throw new Error("Outbox worker list configuration is empty.");
  return [...new Set(values)];
}

function positiveInteger(value, fallback) {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("Outbox worker numeric configuration is invalid.");
  }
  return parsed;
}
