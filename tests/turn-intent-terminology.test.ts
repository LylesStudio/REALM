import assert from "node:assert/strict";
import test from "node:test";
import { createPostgresRuntimeRepository } from "../database/postgres/runtime-repository.ts";
import {
  createLocalM2TurnOrchestrator,
  normalizeM2TurnCheckpoint,
  normalizeM2TurnPlanBody,
  normalizeM2TurnValidationBody,
  type M2TurnCandidate,
  type M2TurnPlan,
  type M2TurnValidation,
} from "../modules/orchestration/public.ts";
import {
  createInMemoryRuntimeRepository,
  resumeTurn,
  RuntimeInvariantError,
  type RuntimeCommand,
} from "../modules/runtime/public.ts";

const SCOUT = {
  characterInstanceId: "char_inst_scout",
  participantId: "participant_scout",
  displayName: "塞娜",
} as const;

const COMMAND: RuntimeCommand<{ text: string }> = {
  commandType: "player.utterance",
  recordId: "record-turn-intent",
  expectedRecordVersion: 1,
  idempotencyKey: "turn-intent-1",
  actorId: "participant_player",
  payload: { text: "我观察四周。" },
};

type Plan = M2TurnPlan;
type Validation = M2TurnValidation;

const LEGACY_PLAN = {
  goal: "继续推进当前场景",
  constraints: [],
  activatedCharacters: [],
  narratorEnabled: true,
  actionBudgetPerCharacter: 0,
  visibility: { kind: "public" as const },
};

const LEGACY_VALIDATION = {
  accepted: true,
  goalSatisfied: true,
  worldCompatible: true,
  actionTransactionsComplete: true,
  narratorChecked: true,
  activatedCharacterCount: 0,
};

function candidate(): M2TurnCandidate {
  return {
    narration: null,
    characterResponses: [],
    actionTransactions: [],
  };
}

function releaseBundle() {
  return {
    formalEvents: [{
      eventId: "turn-intent-event-1",
      kind: "utterance.committed",
      payload: {
        role: "narrator",
        content: "夜色继续向前。",
      },
    }],
    outbox: [],
  } as const;
}

test("新 DM contract 使用 turnIntent / turnIntentSatisfied，且不再写旧键", async () => {
  const orchestrator = createLocalM2TurnOrchestrator({ characters: [SCOUT] });
  const plan = await orchestrator.plan({
    turnId: "turn-intent-new",
    playerText: "我观察四周。",
  });
  const draft = await orchestrator.draft({
    turnId: "turn-intent-new",
    playerText: "我观察四周。",
    plan,
  });
  const validation = await orchestrator.validate({ plan, candidate: draft });

  assert.equal(typeof plan.turnIntent, "string");
  assert.equal("goal" in plan, false);
  assert.equal(validation.turnIntentSatisfied, true);
  assert.equal("goalSatisfied" in validation, false);
});

test("legacy plan checkpoint 只在 hydration 时读 goal，并归一化为 turnIntent", () => {
  const normalized = normalizeM2TurnPlanBody(LEGACY_PLAN);
  assert.equal(normalized.turnIntent, LEGACY_PLAN.goal);
  assert.equal("goal" in normalized, false);
  assert.deepEqual(normalized.constraints, []);
});

test("legacy validation checkpoint 只在 hydration 时读 goalSatisfied，并归一化为 turnIntentSatisfied", () => {
  const normalized = normalizeM2TurnValidationBody(LEGACY_VALIDATION);
  assert.equal(normalized.turnIntentSatisfied, true);
  assert.equal("goalSatisfied" in normalized, false);
});

test("新旧字段同时存在但值冲突时 fail-closed", () => {
  assert.throws(
    () => normalizeM2TurnPlanBody({ ...LEGACY_PLAN, turnIntent: "另一条意图" }),
    (error: unknown) =>
      error instanceof RuntimeInvariantError
      && error.code === "TURN_INTENT_CHECKPOINT_CONFLICT",
  );
  assert.throws(
    () => normalizeM2TurnValidationBody({ ...LEGACY_VALIDATION, turnIntentSatisfied: false }),
    (error: unknown) =>
      error instanceof RuntimeInvariantError
      && error.code === "TURN_INTENT_CHECKPOINT_CONFLICT",
  );
});

test("repository hydration normalizes legacy plan/validation before resume and persists only new keys", async () => {
  type Plan = M2TurnPlan;
  type Validation = M2TurnValidation;
  const repository = createInMemoryRuntimeRepository<
    { text: string },
    Plan,
    M2TurnCandidate,
    Validation,
    { role: string; content: string },
    never
  >({
    recordHeads: [{ recordId: COMMAND.recordId, version: 1, nextOrdinal: 1 }],
    normalizeCheckpoint: normalizeM2TurnCheckpoint,
  });
  const accepted = await repository.acceptCommand({
    turnId: "turn-intent-legacy-resume",
    command: COMMAND,
    commandFingerprint: "fingerprint",
    now: "2026-01-02T03:04:05.000Z",
  });
  const planning = await repository.advanceTurn({
    turnId: accepted.run.turnId,
    expectedRevision: accepted.run.revision,
    expectedState: "accepted",
    nextState: "planning",
    now: "2026-01-02T03:04:05.000Z",
  });
  await repository.advanceTurn({
    turnId: accepted.run.turnId,
    expectedRevision: planning.revision,
    expectedState: "planning",
    nextState: "drafting",
    plan: {
      planId: "legacy-plan",
      body: LEGACY_PLAN as unknown as Plan,
      createdAt: "2026-01-02T03:04:05.000Z",
    },
    now: "2026-01-02T03:04:05.000Z",
  });

  let observedIntent = "";
  let observedValidation = false;
  const resumed = await resumeTurn(accepted.run.turnId, {
    repository,
    drafter: {
      async draft(context) {
        observedIntent = context.plan.body.turnIntent;
        return candidate();
      },
    },
    validator: {
      async validate(context) {
        observedValidation = context.plan.body.turnIntent === LEGACY_PLAN.goal;
        return {
          ...LEGACY_VALIDATION,
          turnIntentSatisfied: true,
        } as Validation;
      },
    },
    planner: { async plan() { throw new Error("planner must not run"); } },
    releaseBuilder: { async build() { return releaseBundle(); } },
    clock: () => "2026-01-02T03:04:05.000Z",
    idFactory: () => "fixed-id",
  });

  assert.equal(observedIntent, LEGACY_PLAN.goal);
  assert.equal(observedValidation, true);
  assert.equal(resumed.state, "completed");
  assert.equal(resumed.plan?.body.turnIntent, LEGACY_PLAN.goal);
  assert.equal("goal" in (resumed.plan?.body ?? {}), false);
  assert.equal("goalSatisfied" in (resumed.validation?.body ?? {}), false);
});

test("PostgreSQL adapter hydrates legacy checkpoint JSON through the repository seam", async () => {
  const legacyRun = {
    turnId: "turn-intent-postgres-hydration",
    command: COMMAND,
    commandFingerprint: "fingerprint",
    state: "drafting",
    revision: 2,
    attempts: { planning: 1, drafting: 1, validating: 0, releasing: 0 },
    plan: {
      planId: "legacy-plan",
      body: LEGACY_PLAN,
      createdAt: "2026-01-02T03:04:05.000Z",
    },
    validation: {
      validationId: "legacy-validation",
      body: LEGACY_VALIDATION,
      createdAt: "2026-01-02T03:04:05.000Z",
    },
    failures: [],
    transitions: [],
    acceptedAt: "2026-01-02T03:04:05.000Z",
    updatedAt: "2026-01-02T03:04:05.000Z",
  };
  const client = {
    async query(sql: string) {
      if (sql.includes("SELECT run_checkpoint")) {
        return { rowCount: 1, rows: [{ run_checkpoint: legacyRun }] };
      }
      return { rowCount: 0, rows: [] };
    },
    release() {},
  };
  const pool = {
    async connect() {
      return client;
    },
  };
  const repository = createPostgresRuntimeRepository<
    { text: string },
    Plan,
    M2TurnCandidate,
    Validation,
    { role: string; content: string },
    never
  >({
    pool: pool as never,
    workspaceId: "workspace-turn-intent",
    mapFormalEvent: () => ({
      sceneId: "scene",
      visibilityPolicyId: "public",
      eventKind: "utterance.committed" as const,
    }),
    normalizeCheckpoint: normalizeM2TurnCheckpoint,
  });

  const loaded = await repository.loadTurn(legacyRun.turnId);
  assert.equal(loaded?.plan?.body.turnIntent, LEGACY_PLAN.goal);
  assert.equal(loaded?.validation?.body.turnIntentSatisfied, true);
  assert.equal("goal" in (loaded?.plan?.body ?? {}), false);
  assert.equal("goalSatisfied" in (loaded?.validation?.body ?? {}), false);
});
