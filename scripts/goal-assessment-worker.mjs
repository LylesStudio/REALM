import { createGoalAssessmentWorkerRuntime } from "../modules/goals/assessment-worker-runtime.ts";
import { createModelGoalJudge } from "../modules/goals/model-judge.ts";
import { getModelSettingsService } from "../modules/application/model-settings-service.ts";
import {
  createRealmWorldSignatureVerifierFromTrustStoreFile,
  readRealmWorldTrustStoreFile,
} from "../modules/world-transfer/realmworld-trust-store.ts";

/**
 * Production Goal assessment worker entrypoint. This process is separate from
 * the Web process and requires a versioned public-key trust-store document.
 * Semantic Goals are judged through the shared ModelGateway adapter
 * (modules/goals/model-judge.ts), which reads the existing local model
 * settings store lazily: deterministic jobs never touch model configuration,
 * and a semantic job without a configured model fails closed as
 * GOAL_JUDGE_FAILED. This script never reads provider endpoints or secrets
 * itself and never creates a second provider client.
 *
 * Required environment:
 * - REALM_RUNTIME_DATABASE_URL: loopback realm_runtime connection
 * - REALM_GOAL_WORKER_INSTALL_ROOT: installed RealmWorld root
 * - REALM_REALMWORLD_TRUST_STORE: path to the operator trust-store JSON
 *   (re-read and re-validated on every verification, so operator rotation or
 *   revocation takes effect without a worker restart; any store failure
 *   fails closed)
 *
 * Optional:
 * - REALM_GOAL_WORKER_WORKSPACES (comma-separated, default local demo workspace)
 * - REALM_GOAL_WORKER_LEASE_DURATION_MS / RETRY_DELAY_MS / IDLE_MIN_MS /
 *   IDLE_MAX_MS
 * - REALM_GOAL_JUDGE_TIMEOUT_MS / REALM_GOAL_JUDGE_MAX_TOKENS (bounded Judge
 *   per-call deadline/output cap)
 */

const connectionString = required("REALM_RUNTIME_DATABASE_URL");
const installRoot = required("REALM_GOAL_WORKER_INSTALL_ROOT");
const trustStorePath = required("REALM_REALMWORLD_TRUST_STORE");
// Initial configuration validation stays fail-fast: an unreadable or invalid
// trust store aborts worker startup instead of degrading verification.
await readRealmWorldTrustStoreFile(trustStorePath);
const verifySignature = createRealmWorldSignatureVerifierFromTrustStoreFile({
  path: trustStorePath,
});

// Lazy semantic Judge: the gateway is only loaded when a semantic job is
// assessed, so missing model configuration keeps deterministic jobs running
// and fails semantic jobs closed inside the worker's GOAL_JUDGE_FAILED path.
const judge = createModelGoalJudge({
  getGateway: () => getModelSettingsService().gateway(),
  timeoutMs: positiveInteger(process.env.REALM_GOAL_JUDGE_TIMEOUT_MS, 20_000),
  maxTokens: positiveInteger(process.env.REALM_GOAL_JUDGE_MAX_TOKENS, 800),
});

const runtime = createGoalAssessmentWorkerRuntime({
  connectionString,
  installRoot,
  verifySignature,
  judge,
  workspaces: csv(process.env.REALM_GOAL_WORKER_WORKSPACES, "ws_demo"),
  leaseDurationMs: positiveInteger(process.env.REALM_GOAL_WORKER_LEASE_DURATION_MS, 30_000),
  retryDelayMs: positiveInteger(process.env.REALM_GOAL_WORKER_RETRY_DELAY_MS, 1_000),
  idleMinMs: positiveInteger(process.env.REALM_GOAL_WORKER_IDLE_MIN_MS, 1_000),
  idleMaxMs: positiveInteger(process.env.REALM_GOAL_WORKER_IDLE_MAX_MS, 15_000),
});

process.once("SIGTERM", () => void runtime.stop());
process.once("SIGINT", () => void runtime.stop());

try {
  await runtime.start();
} finally {
  await runtime.stop();
}

function required(name) {
  const value = process.env[name];
  if (!value || value.trim() === "") throw new Error(`${name} is required.`);
  return value;
}

function csv(value, fallback) {
  const values = (value ?? fallback)
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (values.length === 0) throw new Error("Goal worker workspace list is empty.");
  return [...new Set(values)];
}

function positiveInteger(value, fallback) {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("Goal worker numeric configuration is invalid.");
  }
  return parsed;
}
