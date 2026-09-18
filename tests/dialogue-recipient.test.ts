/**
 * 对话主体标记（recipientId）——Core 聚焦测试。
 *
 * 覆盖：普通 character react 有/无明确对象、未知/自身 recipient 安全归 null、
 * presence react 同型支持、带主体信息的最近公开对话摘要注入 Character Runner、
 * 多 NPC react 保持 Promise.all 并行且主体不混淆、recipientId 随正式事件
 * payload 投递、delivery 投影把 metadata 读回为内部字段。
 * 所有异步用例带短超时，不用无限等待的 Promise。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  createModelPoweredM2TurnOrchestrator,
  createLocalM2TurnOrchestrator,
  createRuleBasedDMController,
  type M2TurnPlan,
  type SemanticOutputDraft,
} from "../modules/orchestration/public.ts";
import type {
  ModelChatRequest,
  ModelChatResponse,
  ModelGateway,
} from "../modules/inference/public.ts";
import type { SemanticSegment } from "../modules/presentation/semantic-segments.ts";
import { parseEventRecipientId } from "../database/postgres/delivery-projection.ts";
import {
  LOCAL_RECORD_SCOPE,
  createLocalRecordService,
  createMemoryWriteTokenRegistry,
  type FormalEventPayload,
  type PlayerUtterancePayload,
} from "../modules/application/local-record-service.ts";
import {
  createInMemoryRuntimeRepository,
  type RuntimeRepository,
} from "../modules/runtime/public.ts";
import type {
  M2TurnCandidate,
  M2TurnValidation,
} from "../modules/orchestration/public.ts";

const PLAYER = {
  characterInstanceId: "char_inst_player",
  participantId: "participant_player",
  displayName: "洛川",
};
const SCOUT = {
  characterInstanceId: "char_inst_scout",
  participantId: "participant_scout",
  displayName: "塞娜",
};
const SCHOLAR = {
  characterInstanceId: "char_inst_scholar",
  participantId: "participant_scholar",
  displayName: "弥洛",
};
const ROSTER = [PLAYER, SCOUT, SCHOLAR] as const;

function jsonResponse(value: unknown): ModelChatResponse {
  return {
    model: "fake-model",
    content: JSON.stringify(value),
    toolCalls: [],
    finishReason: "stop",
    usage: null,
  };
}

function reactPlan(
  characters: readonly {
    characterInstanceId: string;
    participantId: string;
    displayName: string;
  }[],
): M2TurnPlan {
  return {
    goal: "回应玩家",
    constraints: [],
    activatedCharacters: characters,
    narratorEnabled: false,
    actionBudgetPerCharacter: 0,
    visibility: { kind: "public" },
  };
}

test("ordinary react carries recipientId when the model names an addressee", { timeout: 10_000 }, async () => {
  const captured: ModelChatRequest[] = [];
  const gateway: ModelGateway = {
    async discoverModels() {
      return [];
    },
    async chat(request) {
      captured.push(request);
      return jsonResponse({
        action: "塞娜转向洛川。",
        dialogue: "“这件事我只跟你说。”",
        recipientId: "participant_player",
      });
    },
  };
  const orchestrator = createModelPoweredM2TurnOrchestrator({
    characters: [SCOUT],
    getGateway: async () => gateway,
    subjectContext: {
      roster: ROSTER,
      recentPublicDialogue: [],
    },
  });
  const candidate = await orchestrator.draft({
    turnId: "turn-recipient-1",
    playerText: "塞娜，过来一下。",
    plan: reactPlan([SCOUT]),
  });
  assert.equal(candidate.characterResponses.length, 1);
  const response = candidate.characterResponses[0]!;
  assert.equal(response.participantId, "participant_scout");
  assert.equal(response.recipientId, "participant_player");

  const reactCall = captured.find((request) =>
    (request.messages[0]?.content ?? "").includes("You speak only as the character")
  );
  assert.ok(reactCall, "ordinary react 链被触发");
  const system = reactCall!.messages[0]?.content ?? "";
  const user = reactCall!.messages[1]?.content ?? "";
  // schema 要求 recipientId（无对象返回 null）；system 保持静态 English 策略。
  assert.ok(system.includes("recipientId"), "react schema 必须声明 recipientId");
  assert.ok(!/[一-鿿]/.test(system), "system 保持静态 English 策略");
  // 可寻址名册进 user context（canonical participantId 对齐）。
  assert.ok(user.includes("[Addressable participants]"));
  assert.ok(user.includes("participant_player"));
  assert.ok(user.includes("participant_scout"));
  assert.ok(user.includes("participant_scholar"));
  assert.ok(user.includes("塞娜"));
});

test("ordinary react normalizes missing, unknown, or self recipientId to null", { timeout: 10_000 }, async () => {
  const cases = [
    { name: "null-addressee", body: { action: "塞娜望向海面。", dialogue: "“雾更浓了。”", recipientId: null } },
    { name: "field-omitted", body: { action: "塞娜望向海面。", dialogue: "“雾更浓了。”" } },
    { name: "unknown-participant", body: { action: "塞娜回头。", dialogue: "“谁在那里？”", recipientId: "participant_ghost" } },
    { name: "self-recipient", body: { action: "塞娜低语。", dialogue: "“冷静。”", recipientId: "participant_scout" } },
  ];
  for (const entry of cases) {
    const gateway: ModelGateway = {
      async discoverModels() {
        return [];
      },
      async chat() {
        return jsonResponse(entry.body);
      },
    };
    const orchestrator = createModelPoweredM2TurnOrchestrator({
      characters: [SCOUT],
      getGateway: async () => gateway,
      subjectContext: { roster: ROSTER, recentPublicDialogue: [] },
    });
    const candidate = await orchestrator.draft({
      turnId: `turn-recipient-null-${entry.name}`,
      playerText: "你感觉到什么？",
      plan: reactPlan([SCOUT]),
    });
    assert.equal(
      candidate.characterResponses[0]!.recipientId ?? null,
      null,
      `${entry.name}: recipientId 必须 fail-closed 为 null`,
    );
  }
});

test("presence react supports recipientId with the same roster mapping", { timeout: 10_000 }, async () => {
  const captured: ModelChatRequest[] = [];
  const gateway: ModelGateway = {
    async discoverModels() {
      return [];
    },
    async chat(request) {
      captured.push(request);
      return jsonResponse({
        action: "弥洛抬眼看向塞娜。",
        dialogue: "“你也听见了，对吗？”",
        recipientId: "participant_scout",
      });
    },
  };
  const orchestrator = createModelPoweredM2TurnOrchestrator({
    characters: [SCHOLAR],
    getGateway: async () => gateway,
    subjectContext: { roster: ROSTER, recentPublicDialogue: [] },
  });
  const plan: M2TurnPlan = {
    ...reactPlan([SCHOLAR]),
    presence: {
      characterInstanceId: SCHOLAR.characterInstanceId,
      triggerKind: "peer",
      triggerText: "塞娜：「钟声又响了。」",
      memories: "",
      relationships: "",
    },
  };
  const candidate = await orchestrator.draft({
    turnId: "turn-presence-recipient",
    playerText: "塞娜：「钟声又响了。」",
    plan,
  });
  const response = candidate.characterResponses[0]!;
  assert.equal(response.participantId, "participant_scholar");
  assert.equal(response.recipientId, "participant_scout");
  const presenceCall = captured.find((request) =>
    (request.messages[0]?.content ?? "").includes("presence")
  );
  assert.ok(presenceCall, "presence react 链被触发");
  assert.ok(
    (presenceCall!.messages[0]?.content ?? "").includes("recipientId"),
    "presence schema 必须声明 recipientId",
  );
});

test("recent public dialogue with speaker/recipient ids reaches the character runner", { timeout: 10_000 }, async () => {
  const captured: ModelChatRequest[] = [];
  const gateway: ModelGateway = {
    async discoverModels() {
      return [];
    },
    async chat(request) {
      captured.push(request);
      return jsonResponse({
        action: "塞娜点头。",
        dialogue: "“我记得他刚才的话。”",
        recipientId: "participant_scholar",
      });
    },
  };
  const orchestrator = createModelPoweredM2TurnOrchestrator({
    characters: [SCOUT],
    getGateway: async () => gateway,
    subjectContext: {
      roster: ROSTER,
      recentPublicDialogue: [{
        speaker: "弥洛",
        speakerParticipantId: "participant_scholar",
        recipientId: "participant_player",
        text: "“洛川，钟声来自灯塔。”",
      }],
    },
  });
  await orchestrator.draft({
    turnId: "turn-dialogue-context",
    playerText: "你怎么看？",
    plan: reactPlan([SCOUT]),
  });
  const reactCall = captured.find((request) =>
    (request.messages[0]?.content ?? "").includes("You speak only as the character")
  );
  const user = reactCall!.messages[1]?.content ?? "";
  assert.ok(user.includes("[Recent public dialogue]"));
  assert.ok(user.includes("participant_scholar"), "摘要携带 speaker participantId");
  assert.ok(user.includes("participant_player"), "摘要携带 recipientId");
  assert.ok(user.includes("钟声来自灯塔"), "摘要携带文本");
});

test("multiple NPC reactions stay parallel and never mix up subjects", { timeout: 10_000 }, async () => {
  // 每个 react 调用记录 start/end 事件；50ms 固定延迟自然放行，绝不死等。
  // 并行实现下第二个 start 先于第一个 end；串行实现则相反。
  const events: string[] = [];
  const gateway: ModelGateway = {
    async discoverModels() {
      return [];
    },
    async chat(request) {
      const user = request.messages[1]?.content ?? "";
      // 以 [Character] 块判定当前说话者——名册块包含全部参与者，不能据整体
      // user 内容区分。
      const characterBlock = user.match(/\[Character\]\n(\{[^}]*\})/)?.[1] ?? "";
      const isScout = characterBlock.includes("char_inst_scout");
      const key = isScout ? "scout" : "scholar";
      events.push(`start:${key}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
      events.push(`end:${key}`);
      return jsonResponse(
        isScout
          ? { action: "塞娜看向洛川。", dialogue: "“你先说。”", recipientId: "participant_player" }
          : { action: "弥洛望向塞娜。", dialogue: "“让他说完。”", recipientId: "participant_scout" },
      );
    },
  };
  const orchestrator = createModelPoweredM2TurnOrchestrator({
    characters: [SCOUT, SCHOLAR],
    getGateway: async () => gateway,
    subjectContext: { roster: ROSTER, recentPublicDialogue: [] },
  });
  const candidate = await orchestrator.draft({
    turnId: "turn-parallel",
    playerText: "你们两个都听听这个。",
    plan: reactPlan([SCOUT, SCHOLAR]),
  });
  const firstEnd = events.findIndex((event) => event.startsWith("end:"));
  const secondStart = events.findIndex((event, index) => index > 0 && event.startsWith("start:"));
  assert.ok(events.filter((event) => event.startsWith("start:")).length === 2);
  assert.ok(
    secondStart !== -1 && firstEnd !== -1 && secondStart < firstEnd,
    `两个 react 必须并行发起（实际事件序列：${events.join(", ")}）`,
  );
  assert.equal(candidate.characterResponses.length, 2);
  assert.equal(candidate.characterResponses[0]!.participantId, "participant_scout");
  assert.equal(candidate.characterResponses[0]!.recipientId, "participant_player");
  assert.equal(candidate.characterResponses[1]!.participantId, "participant_scholar");
  assert.equal(candidate.characterResponses[1]!.recipientId, "participant_scout");
});

test("recipientId rides the committed formal event payload without changing dialogue text", { timeout: 10_000 }, async () => {
  const draft: SemanticOutputDraft = {
    speaker: "塞娜",
    participantId: "participant_scout",
    characterInstanceId: "char_inst_scout",
    content: "“洛川，这封信你怎么看？”",
    segments: [{
      id: "dialogue-1",
      kind: "dialogue",
      content: "“洛川，这封信你怎么看？”",
      speechMode: "speaker",
    }],
    recipientId: "participant_player",
  };
  // 旧实现缺省字段读作 null（向后兼容）。
  const legacy: SemanticOutputDraft = {
    speaker: "塞娜",
    participantId: "participant_scout",
    characterInstanceId: "char_inst_scout",
    content: "“雾更浓了。”",
    segments: [{
      id: "dialogue-1",
      kind: "dialogue",
      content: "“雾更浓了。”",
      speechMode: "speaker",
    }],
  };
  assert.equal(draft.recipientId, "participant_player");
  assert.equal(legacy.recipientId ?? null, null);
});

test("delivery projection reads recipientId back from event payload metadata", { timeout: 10_000 }, () => {
  assert.equal(
    parseEventRecipientId({ recipientId: "participant_player" }),
    "participant_player",
  );
  // 旧事件无该字段 → null；形状非法 → null。
  assert.equal(parseEventRecipientId({ schemaVersion: 1 }), null);
  assert.equal(parseEventRecipientId(null), null);
  assert.equal(parseEventRecipientId({ recipientId: 42 }), null);
  assert.equal(parseEventRecipientId({ recipientId: "   " }), null);
});

test("committed turn persists recipientId in the formal event payload", { timeout: 10_000 }, async () => {
  type OutboxPayload = { recordId: string; eventIds: readonly string[] };
  const repository: RuntimeRepository<
    PlayerUtterancePayload,
    M2TurnPlan,
    M2TurnCandidate,
    M2TurnValidation,
    FormalEventPayload,
    OutboxPayload
  > = createInMemoryRuntimeRepository({
    recordHeads: [
      { recordId: LOCAL_RECORD_SCOPE.recordId, version: 1, nextOrdinal: 2 },
    ],
  });
  let tokenSequence = 0;
  let idSequence = 0;
  const baseProjection = () => ({
    id: LOCAL_RECORD_SCOPE.recordId,
    version: 1,
    world: {
      id: "world_ember_coast",
      name: "烬海诸国",
      era: "停战纪元 17 年",
      summary: "",
      timeCursor: "",
      style: "classical",
      language: "zh-CN",
    },
    story: {
      id: "story_silent_bell",
      title: "无声钟的来客",
      status: "active",
      premise: "",
    },
    record: {
      id: LOCAL_RECORD_SCOPE.recordId,
      title: "初更",
      status: "active",
      version: 1,
      location: "灰鲸港 · 北防波堤",
      worldTime: "",
    },
    scene: {
      location: "灰鲸港 · 北防波堤",
      worldTime: "",
      weather: "冷雾",
      tension: "",
      objective: "",
    },
    cast: [],
    participants: [],
    events: [],
    stories: [],
    records: [],
  });
  const projection = {
    async loadRecentAuthorizedEvents() {
      return [];
    },
    async loadForPlayer() {
      return baseProjection();
    },
    async hasViewerProjection() {
      return true;
    },
    async loadDeliveryForPlayer() {
      return {
        record: baseProjection(),
        viewer: {
          cursor: "viewer-local" as const,
          perspective: "omniscient" as const,
          dynamicKnowledgeVisible: true,
          characterInstanceId: null,
          membershipRole: "owner" as const,
        },
      };
    },
  };
  const runner = {
    async propose({ character }: { character: typeof SCOUT }) {
      return { character, requestedActions: [] };
    },
    async react({ character }: { character: typeof SCOUT }) {
      const segments: SemanticSegment[] = [{
        id: "dialogue-1",
        kind: "dialogue",
        content: "“洛川，这封信你怎么看？”",
        speechMode: "speaker",
      }];
      return {
        speaker: character.displayName,
        participantId: character.participantId,
        characterInstanceId: character.characterInstanceId,
        content: "“洛川，这封信你怎么看？”",
        segments,
        recipientId: "participant_player",
      };
    },
  };
  const service = createLocalRecordService({
    repository,
    projection,
    tokens: createMemoryWriteTokenRegistry({
      randomToken: () => `recipient-token-${++tokenSequence}`,
      clock: () => new Date("2026-08-13T02:00:00.000Z"),
    }),
    clock: () => new Date("2026-08-13T02:00:00.000Z"),
    idFactory: () => `recipient-${++idSequence}`,
    orchestrator: createLocalM2TurnOrchestrator({
      characters: [SCOUT],
      characterRunner: runner,
      // 无旁白（本地 narrator 的 fact 段需要行动事务背书，本用例无行动）；
      // 结构校验仍走规则 DM。
      dmController: {
        async plan({ availableCharacters }) {
          return {
            goal: "回应玩家",
            constraints: [],
            activatedCharacters: availableCharacters.slice(0, 1),
            narratorEnabled: false,
            actionBudgetPerCharacter: 0,
            visibility: { kind: "public" as const },
          };
        },
        approveActions: (input) =>
          createRuleBasedDMController().approveActions(input),
        validate: (input) => createRuleBasedDMController().validate(input),
      },
    }),
  });
  const initial = await service.loadRecord();
  const committed = await service.submitMessage({
    recordId: LOCAL_RECORD_SCOPE.recordId,
    content: "我展开密函。",
    idempotencyKey: "recipient-turn-1",
    writeToken: initial.writeToken,
  });
  assert.equal(committed.disposition, "committed");
  const events = await repository.listCommittedEvents(LOCAL_RECORD_SCOPE.recordId);
  const characterEvent = events.find(
    (event) => event.payload.role === "character",
  );
  assert.ok(characterEvent, "角色事件已提交");
  assert.equal(
    characterEvent!.payload.recipientId,
    "participant_player",
    "recipientId 随 FormalEventPayload 持久化",
  );
  const playerEvent = events.find(
    (event) => event.payload.role === "player",
  );
  assert.equal(
    playerEvent!.payload.recipientId ?? null,
    null,
    "玩家事件不伪造 recipientId",
  );
});
