import pg from "pg";
import { randomUUID } from "node:crypto";
import { createLocalPostgresPool } from "../../database/postgres/workspace-transaction.ts";
import {
  createPostgresRuntimeRepository,
} from "../../database/postgres/public.ts";
import {
  createOutboxDispatcher,
  type OutboxDispatcherRepository,
  type OutboxPublishSink,
} from "./outbox-dispatcher.ts";
import {
  createDurableWorkerHost,
  safeWorkerErrorCode,
} from "./durable-worker-host.ts";
import { createHttpOutboxDeliverySink } from "./outbox-delivery-sink.ts";
import type { JsonValue } from "../runtime/public.ts";
import { RuntimeInvariantError } from "../runtime/public.ts";

const ADVISORY_LOCK_NAME = "realm_outbox_worker";
const DEFAULT_TOPICS = ["record.events.committed"] as const;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_LEASE_DURATION_MS = 30_000;
const DEFAULT_BATCH_LIMIT = 25;
const DEFAULT_RETRY_DELAY_MS = 5_000;
const DEFAULT_IDLE_MIN_MS = 1_000;
const DEFAULT_IDLE_MAX_MS = 15_000;
const DEFAULT_DELIVERY_TIMEOUT_MS = 10_000;

/**
 * Production Outbox consumer runtime.
 *
 * The dispatcher remains persistence-neutral; this module supplies the real
 * PostgreSQL repository, process-level advisory lock, HTTP delivery sink and
 * bounded polling lifecycle. It intentionally requires a configured endpoint
 * and never substitutes an in-memory/no-op sink.
 */
export function createOutboxWorkerRuntime(options: {
  connectionString: string;
  deliveryUrl: string;
  workspaces: readonly string[];
  topics?: readonly string[];
  maxAttempts?: number;
  leaseDurationMs?: number;
  batchLimit?: number;
  retryDelayMs?: number;
  deliveryTimeoutMs?: number;
  idleMinMs?: number;
  idleMaxMs?: number;
  logger?: (line: string) => void;
  clock?: () => string;
  sink?: OutboxPublishSink;
}): {
  start(): Promise<void>;
  stop(): Promise<void>;
} {
  const connectionString = requireNonEmpty(
    options.connectionString,
    "OUTBOX_WORKER_DATABASE_URL_INVALID",
  );
  const workspaces = normalizeList(options.workspaces, "OUTBOX_WORKER_WORKSPACES_INVALID");
  const topics = normalizeList(
    options.topics ?? DEFAULT_TOPICS,
    "OUTBOX_WORKER_TOPICS_INVALID",
  );
  const maxAttempts = positiveSafeInteger(
    options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    "OUTBOX_WORKER_MAX_ATTEMPTS_INVALID",
  );
  const leaseDurationMs = positiveFinite(
    options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS,
    "OUTBOX_WORKER_LEASE_INVALID",
  );
  const batchLimit = positiveSafeInteger(
    options.batchLimit ?? DEFAULT_BATCH_LIMIT,
    "OUTBOX_WORKER_BATCH_INVALID",
  );
  const retryDelayMs = positiveFinite(
    options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
    "OUTBOX_WORKER_RETRY_INVALID",
  );
  const deliveryTimeoutMs = positiveSafeInteger(
    options.deliveryTimeoutMs ?? DEFAULT_DELIVERY_TIMEOUT_MS,
    "OUTBOX_WORKER_DELIVERY_TIMEOUT_INVALID",
  );
  const idleMinMs = positiveFinite(
    options.idleMinMs ?? DEFAULT_IDLE_MIN_MS,
    "OUTBOX_WORKER_IDLE_MIN_INVALID",
  );
  const idleMaxMs = positiveFinite(
    options.idleMaxMs ?? DEFAULT_IDLE_MAX_MS,
    "OUTBOX_WORKER_IDLE_MAX_INVALID",
  );
  if (idleMaxMs < idleMinMs) {
    throw new RuntimeInvariantError(
      "OUTBOX_WORKER_IDLE_RANGE_INVALID",
      "Outbox worker idle maximum must not be below its minimum.",
    );
  }
  const clock = options.clock ?? (() => new Date().toISOString());
  if (typeof clock !== "function") {
    throw new RuntimeInvariantError(
      "OUTBOX_WORKER_CLOCK_INVALID",
      "Outbox worker requires an explicit clock.",
    );
  }
  const log = options.logger
    ?? ((line: string) => console.log(`[outbox-worker] ${line}`));
  const sink = options.sink ?? createHttpOutboxDeliverySink({
    endpoint: requireNonEmpty(
      options.deliveryUrl,
      "OUTBOX_WORKER_DELIVERY_URL_INVALID",
    ),
    timeoutMs: deliveryTimeoutMs,
  });

  // createLocalPostgresPool enforces the loopback-only runtime boundary before
  // any worker connection is opened. The URL itself is never logged.
  const pool = createLocalPostgresPool(connectionString, { max: 8 });
  pool.on("error", () => {});
  const leaseOwner = `outbox-worker:${process.pid}:${randomUUID()}`;
  const topicSet = new Set(topics);
  const dispatchers = workspaces.map((workspaceId) => {
    const repository = createTopicScopedRepository(
      createPostgresRuntimeRepository({
        pool,
        workspaceId,
        // This worker only consumes the already-persisted Outbox surface.
        // Formal-event mapping is intentionally unreachable.
        mapFormalEvent() {
          throw new RuntimeInvariantError(
            "OUTBOX_WORKER_FORMAL_EVENT_UNSUPPORTED",
            "The Outbox worker cannot map formal events.",
          );
        },
      }),
      topicSet,
    );
    return {
      workspaceId,
      dispatcher: createOutboxDispatcher({
        repository,
        sink,
        clock,
        leaseOwner: `${leaseOwner}:${workspaceId}`,
        leaseDurationMs,
        batchLimit,
        retryDelayMs,
        maxAttempts,
      }),
    };
  });

  async function runCycle(): Promise<boolean> {
    let didWork = false;
    for (const { workspaceId, dispatcher } of dispatchers) {
      try {
        const report = await dispatcher.runOnce();
        if (report.claimed > 0) {
          didWork = true;
          log(
            `workspace=${workspaceId} claimed=${report.claimed} `
            + `delivered=${report.delivered} retryable=${report.retryable} `
            + `failed=${report.failed}`,
          );
        }
      } catch (error) {
        // Polling stays alive across a database/network outage. Only a bounded
        // error code reaches logs; raw driver messages may contain endpoints.
        log(`poll error for workspace=${workspaceId}: ${safeWorkerErrorCode(error)}`);
      }
    }
    return didWork;
  }

  // The shared host owns lock release ordering, idle backoff, bounded cycle
  // error logging and idempotent stop; this runtime keeps owning its pool,
  // advisory lock name, health query and per-workspace dispatcher cycle.
  const host = createDurableWorkerHost({
    idleMinMs,
    idleMaxMs,
    logger: log,
    hooks: {
      alreadyStartedError: () => new RuntimeInvariantError(
        "OUTBOX_WORKER_ALREADY_STARTED",
        "The Outbox worker runtime cannot be started twice.",
      ),
      async acquireLock() {
        const client = new pg.Client({ connectionString });
        try {
          await client.connect();
          const locked = await client.query<{ locked: boolean }>(
            "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
            [ADVISORY_LOCK_NAME],
          );
          if (locked.rows[0]?.locked !== true) {
            throw new Error("another Outbox worker instance holds the advisory lock");
          }
          log("advisory lock acquired");
          return async () => {
            await client.end().catch(() => undefined);
          };
        } catch (error) {
          // A connect/query/lock failure must not leak the dedicated client;
          // the raw driver error propagates without being logged (it may
          // contain the connection string or endpoint).
          await client.end().catch(() => undefined);
          throw error;
        }
      },
      async checkHealth() {
        const health = await pool.query<{
          outbox: string | null;
          turnRuns: string | null;
        }>(
          `SELECT to_regclass('public.outbox') AS outbox,
                  to_regclass('public.turn_runs') AS "turnRuns"`,
        );
        if (!health.rows[0]?.outbox || !health.rows[0]?.turnRuns) {
          throw new Error("Outbox worker requires the Runtime schema");
        }
      },
      runCycle,
      async close() {
        await pool.end().catch(() => undefined);
      },
    },
  });

  return {
    start: () => host.start(),
    stop: () => host.stop(),
  };
}

function createTopicScopedRepository(
  repository: OutboxDispatcherRepository,
  topics: ReadonlySet<string>,
): OutboxDispatcherRepository {
  return {
    listOutboxMessages: async () => {
      const messages = await repository.listOutboxMessages();
      return messages.filter((message) => topics.has(message.topic));
    },
    claimOutbox: (input) => repository.claimOutbox(input),
    settleOutbox: (input) => repository.settleOutbox(input),
  };
}

function requireNonEmpty(value: string, code: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new RuntimeInvariantError(code, "Outbox worker configuration is required.");
  }
  return value.trim();
}

function normalizeList(values: readonly string[], code: string): string[] {
  if (!Array.isArray(values)) {
    throw new RuntimeInvariantError(code, "Outbox worker configuration must be a list.");
  }
  const normalized = [...new Set(
    values
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  )];
  if (normalized.length === 0) {
    throw new RuntimeInvariantError(code, "Outbox worker configuration cannot be empty.");
  }
  return normalized;
}

function positiveSafeInteger(value: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RuntimeInvariantError(code, "Outbox worker value must be a positive integer.");
  }
  return value;
}

function positiveFinite(value: number, code: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RuntimeInvariantError(code, "Outbox worker value must be positive.");
  }
  return value;
}

// Keep JsonValue referenced in the module's public type boundary so the worker
// cannot silently drift to an unbounded `any` payload in future edits.
export type OutboxWorkerJsonPayload = JsonValue;
