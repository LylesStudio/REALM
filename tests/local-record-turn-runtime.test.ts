import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as turnRuntime from "../modules/application/local-record-turn-runtime.ts";
import { demoRecordRuntimeScope } from "../modules/application/local-record-read-model.ts";
import {
  FatalTurnError,
  type RuntimeCommand,
} from "../modules/runtime/public.ts";
import type {
  M2TurnCandidate,
  M2TurnOrchestrator,
  M2TurnPlan,
  M2TurnValidation,
  SemanticOutputDraft,
} from "../modules/orchestration/public.ts";

/**
 * Phase 2E：turn runtime dependency bridge（planner/drafter/validator/
 * releaser、presence/interjection 固定计划、取消 signal 检查、orchestrator
 * 选择、action catalog 接线）已从 facade 拆入
 * modules/application/local-record-turn-runtime.ts。本文件是拆分边界测试：
 * ① seam——facade 真实接线到新模块（import + 既有参数序调用 + 类型
 *    re-export），不再自带第二份 factory/LocalTurnRun，新模块不反向
 *    import facade；
 * ② behavior——缺省本地 orchestrator、presence/interjection 固定计划、
 *    取消 signal 在四段边界 fail-closed、release 形态与 runtime dependency
 *    形状，全部与拆分前逐行一致。
 */

const RUNTIME_SCOPE = demoRecordRuntimeScope();
const CLOCK = () => new Date("2026-01-02T03:04:05.000Z");
const REPO = { marker: "repo" } as unknown as turnRuntime.LocalRuntimeRepository;

function command(
  payload: Partial<turnRuntime.PlayerUtterancePayload>,
): RuntimeCommand<turnRuntime.PlayerUtterancePayload> {
  return {
    commandType: "player.utterance",
    recordId: "record-local",
    expectedRecordVersion: 3,
    idempotencyKey: "cmd-1",
    actorId: "participant-player",
    payload: { text: "我观察四周。", visibility: { kind: "public" }, ...payload },
  };
}

function throwingOrchestrator(): M2TurnOrchestrator {
  return {
    plan: async () => {
      throw new Error("orchestrator.plan must not be called");
    },
    draft: async () => {
      throw new Error("orchestrator.draft must not be called");
    },
    validate: async () => {
      throw new Error("orchestrator.validate must not be called");
    },
  };
}

const STUB_PLAN: M2TurnPlan = {
  turnIntent: "stub goal",
  constraints: [],
  activatedCharacters: [],
  narratorEnabled: false,
  actionBudgetPerCharacter: 0,
  visibility: { kind: "public" },
};

const VALIDATION_BODY: M2TurnValidation = {
  accepted: true,
  turnIntentSatisfied: true,
  worldCompatible: true,
  actionTransactionsComplete: true,
  narratorChecked: true,
  activatedCharacterCount: 1,
};

function stubOrchestrator(plan: M2TurnPlan = STUB_PLAN): M2TurnOrchestrator {
  return {
    plan: async () => plan,
    draft: async () => ({
      narration: null,
      characterResponses: [],
      actionTransactions: [],
    }),
    validate: async () => VALIDATION_BODY,
  };
}

const CREATED_AT = "2026-01-02T03:04:05.000Z";

function turnPlan(body: M2TurnPlan) {
  return { planId: "plan-1", body, createdAt: CREATED_AT };
}

function turnCandidate(body: M2TurnCandidate) {
  return { candidateId: "candidate-1", body, createdAt: CREATED_AT, draftingAttempt: 1 };
}

function turnValidation(body: M2TurnValidation) {
  return { validationId: "validation-1", body, createdAt: CREATED_AT };
}

const PRESENCE_RESPONSE: SemanticOutputDraft = {
  speaker: RUNTIME_SCOPE.aiCharacters[0]!.displayName,
  participantId: RUNTIME_SCOPE.aiCharacters[0]!.participantId,
  characterInstanceId: RUNTIME_SCOPE.aiCharacters[0]!.characterInstanceId,
  recipientId: null,
  content: "塞娜握紧了短弓。",
  segments: [
    { id: "dialogue-1", kind: "dialogue", content: "塞娜握紧了短弓。", speechMode: "speaker" },
  ],
};

function releasingContext(payload: Partial<turnRuntime.PlayerUtterancePayload>) {
  return {
    turnId: "turn-9",
    command: command(payload),
    attempt: 1,
    plan: turnPlan(STUB_PLAN),
    candidate: turnCandidate({
      narration: null,
      characterResponses: [PRESENCE_RESPONSE],
      actionTransactions: [],
    }),
    validation: turnValidation(VALIDATION_BODY),
  };
}

test("seam：facade 真实接线到新模块且无第二份实现/反向 import", () => {
  assert.equal(typeof turnRuntime.createLocalTurnDependencies, "function");

  const facadeSource = readFileSync(
    new URL("../modules/application/local-record-service.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    facadeSource.includes('from "./local-record-turn-runtime.ts"'),
    "facade 必须 import local-record-turn-runtime.ts",
  );
  assert.ok(
    /createLocalTurnDependencies\(\s*\n?\s*dependencies\.repository,/.test(facadeSource),
    "facade 必须以既有参数序真实调用新模块 factory",
  );
  assert.ok(
    !/function createLocalTurnDependencies/.test(facadeSource),
    "facade 不得再自行定义 createLocalTurnDependencies",
  );
  assert.ok(
    !/type LocalTurnRun\s*=/.test(facadeSource),
    "facade 不得再自行定义 LocalTurnRun",
  );
  // 旧 public 类型路径不变：payload 三类型仍由 facade 导出（re-export 新模块）。
  for (const name of ["PlayerUtterancePayload", "FormalEventPayload", "OutboxPayload"]) {
    assert.ok(
      new RegExp(
        `export\\s+type\\s*\\{[\\s\\S]*?\\b${name}\\b[\\s\\S]*?\\}\\s*from\\s*["']\\.\\/local-record-turn-runtime\\.ts["']`,
      ).test(facadeSource),
      `facade 必须 re-export ${name} 保持旧类型路径`,
    );
  }

  const moduleSource = readFileSync(
    new URL("../modules/application/local-record-turn-runtime.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    !/from\s+["'][^"']*local-record-service/.test(moduleSource)
      && !/import\(\s*["'][^"']*local-record-service/.test(moduleSource),
    "新模块不得反向 import local-record-service",
  );
});

test("runtime dependency shape：repository 透传、四段齐备、clock/idFactory 接线不变", () => {
  const dependencies = turnRuntime.createLocalTurnDependencies(
    REPO,
    CLOCK,
    () => "id-fixed",
  );
  assert.equal(dependencies.repository, REPO);
  assert.equal(typeof dependencies.planner.plan, "function");
  assert.equal(typeof dependencies.drafter.draft, "function");
  assert.equal(typeof dependencies.validator.validate, "function");
  assert.equal(typeof dependencies.releaseBuilder.build, "function");
  assert.equal(dependencies.clock?.(), "2026-01-02T03:04:05.000Z");
  assert.equal(dependencies.idFactory?.(), "id-fixed");
  assert.equal(dependencies.signal, undefined);
});

test("缺省 orchestrator：本地 rule-based 编排（固定 goal、激活首名在场角色）", async () => {
  const dependencies = turnRuntime.createLocalTurnDependencies(REPO, CLOCK);
  const plan = await dependencies.planner.plan({
    turnId: "turn-1",
    command: command({}),
    attempt: 1,
  });
  assert.equal(
    plan.turnIntent,
    "Advance one coherent public scene without assigning a character's stance.",
  );
  assert.equal(plan.narratorEnabled, true);
  assert.equal(plan.actionBudgetPerCharacter, 1);
  assert.deepEqual(plan.activatedCharacters, RUNTIME_SCOPE.aiCharacters.slice(0, 1));
  assert.deepEqual(plan.visibility, { kind: "public" });
});

test("orchestration factory：按 payload runtimeScope 选择并真实调用", async () => {
  const seen: unknown[] = [];
  const dependencies = turnRuntime.createLocalTurnDependencies(
    REPO,
    CLOCK,
    undefined,
    (scope) => {
      seen.push(scope);
      return stubOrchestrator();
    },
  );
  const plan = await dependencies.planner.plan({
    turnId: "turn-2",
    command: command({ runtimeScope: RUNTIME_SCOPE }),
    attempt: 1,
  });
  assert.equal(plan, STUB_PLAN);
  assert.deepEqual(seen, [RUNTIME_SCOPE]);
});

test("presence 固定计划：不调用 orchestrator，无 Narrator/行动预算，载荷透传", async () => {
  const character = RUNTIME_SCOPE.aiCharacters[0]!;
  const dependencies = turnRuntime.createLocalTurnDependencies(
    REPO,
    CLOCK,
    undefined,
    throwingOrchestrator(),
  );
  const plan = await dependencies.planner.plan({
    turnId: "turn-3",
    command: command({
      runtimeScope: RUNTIME_SCOPE,
      presence: {
        characterInstanceId: character.characterInstanceId,
        triggerKind: "peer",
        triggerText: "同伴的一句话",
        memories: "memories-text",
        relationships: "relationships-text",
      },
    }),
    attempt: 1,
  });
  assert.equal(plan.turnIntent, `让 ${character.displayName} 对刚发生的变化自发作出一个简短反应。`);
  assert.deepEqual(plan.constraints, ["在场反应不得开启 Narrator，不得包含行动事务。"]);
  assert.deepEqual(plan.activatedCharacters, [character]);
  assert.equal(plan.narratorEnabled, false);
  assert.equal(plan.actionBudgetPerCharacter, 0);
  assert.deepEqual(plan.visibility, { kind: "public" });
  assert.deepEqual(plan.presence, {
    characterInstanceId: character.characterInstanceId,
    triggerKind: "peer",
    triggerText: "同伴的一句话",
    memories: "memories-text",
    relationships: "relationships-text",
  });
});

test("presence 角色不在名册：FatalTurnError PRESENCE_CHARACTER_UNKNOWN", async () => {
  const dependencies = turnRuntime.createLocalTurnDependencies(REPO, CLOCK);
  await assert.rejects(
    dependencies.planner.plan({
      turnId: "turn-4",
      command: command({
        runtimeScope: RUNTIME_SCOPE,
        presence: {
          characterInstanceId: "char_inst_unknown",
          triggerKind: "environment",
          triggerText: "潮声变了。",
          memories: "",
          relationships: "",
        },
      }),
      attempt: 1,
    }),
    (error: unknown) =>
      error instanceof FatalTurnError && error.code === "PRESENCE_CHARACTER_UNKNOWN",
  );
});

test("interjection 固定计划与校验：不调用 orchestrator，仅结构校验", async () => {
  const character = RUNTIME_SCOPE.aiCharacters[0]!;
  const dependencies = turnRuntime.createLocalTurnDependencies(
    REPO,
    CLOCK,
    undefined,
    throwingOrchestrator(),
  );
  const plan = await dependencies.planner.plan({
    turnId: "turn-5",
    command: command({
      runtimeScope: RUNTIME_SCOPE,
      interjection: {
        characterInstanceId: character.characterInstanceId,
        triggerText: "我提起旧港的名字。",
      },
    }),
    attempt: 1,
  });
  assert.equal(plan.narratorEnabled, false);
  assert.equal(plan.actionBudgetPerCharacter, 0);
  assert.deepEqual(plan.activatedCharacters, [character]);

  // validator 走 rule-based 结构校验：恰好一条目标角色回应、无行动事务 → 通过。
  const validation = await dependencies.validator.validate({
    turnId: "turn-5",
    command: command({
      runtimeScope: RUNTIME_SCOPE,
      interjection: {
        characterInstanceId: character.characterInstanceId,
        triggerText: "我提起旧港的名字。",
      },
    }),
    attempt: 1,
    plan: turnPlan(plan),
    candidate: turnCandidate({
      narration: null,
      characterResponses: [PRESENCE_RESPONSE],
      actionTransactions: [],
    }),
  });
  assert.equal(validation.turnIntentSatisfied, true);
});

test("cancel signal fail-closed：已 abort 回合在四段边界一律 FatalTurnError", async () => {
  const controller = new AbortController();
  controller.abort();
  const signals = new Map<string, turnRuntime.ActiveTurnSignal>([
    ["cmd-1", { recordId: "record-local", controller }],
  ]);
  const dependencies = turnRuntime.createLocalTurnDependencies(
    REPO,
    CLOCK,
    undefined,
    stubOrchestrator(),
    signals,
  );
  const assertCancelled = async (stage: Promise<unknown>) => {
    await assert.rejects(
      stage,
      (error: unknown) =>
        error instanceof FatalTurnError && error.code === "TURN_CANCELLED",
    );
  };
  await assertCancelled(
    dependencies.planner.plan({ turnId: "t", command: command({}), attempt: 1 }),
  );
  await assertCancelled(
    dependencies.drafter.draft({
      turnId: "t",
      command: command({}),
      attempt: 1,
      plan: turnPlan(STUB_PLAN),
    }),
  );
  await assertCancelled(
    dependencies.validator.validate({
      turnId: "t",
      command: command({}),
      attempt: 1,
      plan: turnPlan(STUB_PLAN),
      candidate: turnCandidate({
        narration: null,
        characterResponses: [],
        actionTransactions: [],
      }),
    }),
  );
  await assertCancelled(
    dependencies.releaseBuilder.build(releasingContext({})),
  );
});

test("cancel signal 未 abort：四段边界正常放行", async () => {
  const signals = new Map<string, turnRuntime.ActiveTurnSignal>([
    ["cmd-1", { recordId: "record-local", controller: new AbortController() }],
  ]);
  const dependencies = turnRuntime.createLocalTurnDependencies(
    REPO,
    CLOCK,
    undefined,
    stubOrchestrator(),
    signals,
  );
  const plan = await dependencies.planner.plan({
    turnId: "t",
    command: command({}),
    attempt: 1,
  });
  assert.equal(plan, STUB_PLAN);
});

test("presence release：只发布在场角色事件 + 单条 delivery outbox（无玩家事件）", async () => {
  const character = RUNTIME_SCOPE.aiCharacters[0]!;
  const dependencies = turnRuntime.createLocalTurnDependencies(REPO, CLOCK);
  const release = await dependencies.releaseBuilder.build(
    releasingContext({
      runtimeScope: RUNTIME_SCOPE,
      presence: {
        characterInstanceId: character.characterInstanceId,
        triggerKind: "peer",
        triggerText: "同伴的一句话",
        memories: "",
        relationships: "",
      },
    }),
  );
  assert.deepEqual(
    release.formalEvents.map((event) => event.eventId),
    ["turn-9:presence:1"],
  );
  const event = release.formalEvents[0]!;
  assert.equal(event.kind, "utterance.committed");
  assert.equal(event.payload.role, "character");
  assert.deepEqual(event.payload.presence, {
    characterInstanceId: character.characterInstanceId,
    triggerKind: "peer",
  });
  assert.deepEqual(
    release.outbox.map((message) => message.dedupeKey),
    ["turn-9:delivery:v1"],
  );
  assert.deepEqual(release.outbox[0]!.payload, {
    recordId: "record-local",
    eventIds: ["turn-9:presence:1"],
  });
});
