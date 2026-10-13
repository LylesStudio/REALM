import {
  createLocalPostgresPool,
} from "../../database/postgres/workspace-transaction.ts";
import { createPostgresGoalAssessmentJobQueue } from "../../database/postgres/goal-assessment-job-queue.ts";
import type { RealmWorldSignatureVerifier } from "../world-transfer/realmworld-loader.ts";
import {
  createInstalledRealmWorldDefinitionResolver,
  type RealmWorldDefinitionResolutionJob,
} from "../world-transfer/realmworld-definition-resolver.ts";
import { resolveBaseGoalDefinition } from "../world-transfer/base-content.ts";
import {
  runGoalAssessmentOnce,
  type GoalAssessmentJobRepository,
  type GoalAssessmentRunReport,
  type GoalJudge,
} from "./assessment-worker.ts";
import {
  createDurableWorkerHost,
  safeWorkerErrorCode,
} from "../application/durable-worker-host.ts";
import type { GoalDefinition } from "./public.ts";
import type { JsonValue } from "../runtime/public.ts";
import { RuntimeInvariantError } from "../runtime/public.ts";
import pg from "pg";
import { randomUUID } from "node:crypto";

const ADVISORY_LOCK_NAME = "realm_goal_assessment_worker";
const DEFAULT_LEASE_DURATION_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const DEFAULT_IDLE_MIN_MS = 1_000;
const DEFAULT_IDLE_MAX_MS = 15_000;

export interface GoalAssessmentWorkerCycleSlot {
  workspaceId: string;
  repository: GoalAssessmentJobRepository;
}

export async function runGoalAssessmentWorkerCycle(input: {
  slots: readonly GoalAssessmentWorkerCycleSlot[];
  resolveDefinition: Parameters<typeof runGoalAssessmentOnce>[0]["resolveDefinition"];
  judge?: GoalJudge;
  now: string;
}): Promise<ReadonlyMap<string, GoalAssessmentRunReport>> {
  const reports = new Map<string, GoalAssessmentRunReport>();
  for (const slot of input.slots) {
    try {
      reports.set(slot.workspaceId, await runGoalAssessmentOnce({
        repository: slot.repository,
        resolveDefinition: input.resolveDefinition,
        judge: input.judge,
        now: input.now,
      }));
    } catch (error) {
      // Keep one broken workspace from starving the other leases. The raw
      // database/provider message never enters the worker report or log.
      reports.set(slot.workspaceId, { kind: "failed", code: safeWorkerErrorCode(error) });
    }
  }
  return reports;
}

/**
 * Durable Goal assessment host. It owns one PostgreSQL advisory lock and uses
 * the queue's lease/fencing semantics for every workspace. The Web process
 * must not call this loop; deployment uses a separate worker entrypoint.
 */
export function createGoalAssessmentWorkerRuntime(options: {
  connectionString: string;
  installRoot: string;
  verifySignature: RealmWorldSignatureVerifier;
  workspaces: readonly string[];
  judge?: GoalJudge;
  baseResolver?: (job: RealmWorldDefinitionResolutionJob) => GoalDefinition | null | Promise<GoalDefinition | null>;
  /** operator 活动 base 内容版本（包兼容闸）；缺省引擎当前版本。 */
  engineBaseVersion?: string;
  leaseDurationMs?: number;
  retryDelayMs?: number;
  idleMinMs?: number;
  idleMaxMs?: number;
  logger?: (line: string) => void;
  clock?: () => string;
}): { start(): Promise<void>; stop(): Promise<void> } {
  const connectionString = requiredText(options.connectionString, "GOAL_WORKER_DATABASE_URL_INVALID");
  const installRoot = requiredText(options.installRoot, "GOAL_WORKER_INSTALL_ROOT_INVALID");
  if (typeof options.verifySignature !== "function") {
    throw new RuntimeInvariantError(
      "GOAL_WORKER_SIGNATURE_VERIFIER_INVALID",
      "Goal worker requires a RealmWorld signature verifier.",
    );
  }
  const workspaces = normalizeList(options.workspaces, "GOAL_WORKER_WORKSPACES_INVALID");
  const leaseDurationMs = positiveInteger(
    options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS,
    "GOAL_WORKER_LEASE_INVALID",
  );
  const retryDelayMs = positiveInteger(
    options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
    "GOAL_WORKER_RETRY_INVALID",
  );
  const idleMinMs = positiveInteger(
    options.idleMinMs ?? DEFAULT_IDLE_MIN_MS,
    "GOAL_WORKER_IDLE_MIN_INVALID",
  );
  const idleMaxMs = positiveInteger(
    options.idleMaxMs ?? DEFAULT_IDLE_MAX_MS,
    "GOAL_WORKER_IDLE_MAX_INVALID",
  );
  if (idleMaxMs < idleMinMs) {
    throw new RuntimeInvariantError(
      "GOAL_WORKER_IDLE_RANGE_INVALID",
      "Goal worker idle maximum must not be below its minimum.",
    );
  }
  const clock = options.clock ?? (() => new Date().toISOString());
  if (typeof clock !== "function") {
    throw new RuntimeInvariantError(
      "GOAL_WORKER_CLOCK_INVALID",
      "Goal worker requires an explicit clock.",
    );
  }
  const log = options.logger ?? ((line: string) => console.log(`[goal-worker] ${line}`));
  const pool = createLocalPostgresPool(connectionString, { max: 8 });
  pool.on("error", () => {});
  const leaseOwner = `goal-worker:${process.pid}:${randomUUID()}`;
  const definitionResolver = createInstalledRealmWorldDefinitionResolver({
    installRoot,
    verifySignature: options.verifySignature,
    baseResolver: options.baseResolver ?? resolveBaseGoalDefinition,
    engineBaseVersion: options.engineBaseVersion,
  });
  const slots = workspaces.map((workspaceId) => ({
    workspaceId,
    repository: createPostgresGoalAssessmentJobQueue({
      pool,
      workspaceId,
      leaseOwner: `${leaseOwner}:${workspaceId}`,
      leaseDurationMs,
      retryDelayMs,
    }),
  }));

  async function runCycle(): Promise<boolean> {
    try {
      const reports = await runGoalAssessmentWorkerCycle({
        slots,
        resolveDefinition: definitionResolver,
        judge: options.judge,
        now: clock(),
      });
      let didWork = false;
      for (const [workspaceId, report] of reports) {
        if (report.kind !== "idle") {
          didWork = true;
          log(`workspace=${workspaceId} result=${report.kind}${"status" in report ? ` status=${report.status}` : ""}`);
        }
      }
      return didWork;
    } catch (error) {
      log(`cycle error=${safeWorkerErrorCode(error)}`);
      return false;
    }
  }

  // The shared host owns lock release ordering, idle backoff, bounded cycle
  // error logging and idempotent stop; this runtime keeps owning its pool,
  // advisory lock name, health query and per-workspace cycle.
  const host = createDurableWorkerHost({
    idleMinMs,
    idleMaxMs,
    logger: log,
    hooks: {
      alreadyStartedError: () => new RuntimeInvariantError(
        "GOAL_WORKER_ALREADY_STARTED",
        "Goal worker runtime cannot be started twice.",
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
            throw new RuntimeInvariantError(
              "GOAL_WORKER_ALREADY_RUNNING",
              "Another Goal assessment worker holds the advisory lock.",
            );
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
        const health = await pool.query<{ jobs: string | null; goals: string | null }>(
          `SELECT to_regclass('public.goal_assessment_jobs') AS jobs,
                  to_regclass('public.goal_instances') AS goals`,
        );
        if (!health.rows[0]?.jobs || !health.rows[0]?.goals) {
          throw new RuntimeInvariantError(
            "GOAL_WORKER_SCHEMA_UNAVAILABLE",
            "Goal worker requires the Goal runtime schema.",
          );
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

function requiredText(value: string, code: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new RuntimeInvariantError(code, "Goal worker configuration is required.");
  }
  return value.trim();
}

function normalizeList(values: readonly string[], code: string): string[] {
  if (!Array.isArray(values)) {
    throw new RuntimeInvariantError(code, "Goal worker workspace configuration must be a list.");
  }
  const result = [...new Set(values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0))];
  if (result.length === 0) {
    throw new RuntimeInvariantError(code, "Goal worker workspace configuration cannot be empty.");
  }
  return result;
}

function positiveInteger(value: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RuntimeInvariantError(code, "Goal worker value must be a positive integer.");
  }
  return value;
}

export type GoalWorkerJsonPayload = JsonValue;
