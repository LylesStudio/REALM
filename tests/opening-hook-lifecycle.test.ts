/**
 * Record Goal A 批 · A3：opening hook 生命周期——旧初夜钩子不得反复成为
 * presence 的 fresh trigger。
 *
 * 应用层证据（真实 local-record-service 装配 + 内存 runtime）：初夜钩子
 * 的新鲜度必须由持久事件游标判定（hook 事件 identity vs 玩家事件游标），
 * 同一旧 hook 在后续玩家回合/重载/重读后不得再次作为「刚发生」素材进入
 * 门禁上下文；本回合新 narration/同侪素材不受影响。
 * fixture 均为明确测试数据，不冒充真实模型结果。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type {
  RecordProjection,
  ProjectionEvent,
} from "../modules/application/legacy-record-projection-types.ts";
import {
  LOCAL_RECORD_SCOPE,
  createLocalRecordService,
  createMemoryWriteTokenRegistry,
} from "../modules/application/local-record-service.ts";
import { createInMemoryRuntimeRepository } from "../modules/runtime/public.ts";
import type { PlayerUtterancePayload, OutboxPayload } from "../modules/application/local-record-turn-runtime.ts";
import type { M2TurnPlan, M2TurnCandidate, M2TurnValidation } from "../modules/orchestration/public.ts";
import { createTurnControl } from "../modules/runtime/turn-control.ts";
import { fallbackSemanticSegments } from "../modules/presentation/semantic-segments.ts";
import type {
  PresenceAssessor,
  PresenceContext,
} from "../modules/orchestration/presence.ts";
import type { ActionTransaction } from "../modules/actions/public.ts";

const HOOK_TEXT = "无面者的钟还会再响。";

type CommandPayload = PlayerUtterancePayload;
type EventPayload = {
  schemaVersion: 1;
  role: "player" | "character" | "narrator" | "system";
  speaker: string;
  participantId: string | null;
  content: string;
  segments: readonly import("../modules/presentation/semantic-segments.ts").SemanticSegment[];
  actionTransaction?: ActionTransaction;
  presence?: { characterInstanceId: string; triggerKind: "environment" | "peer" | "hook" };
};

function baseProjection(events: ProjectionEvent[]): RecordProjection {
  const cast: RecordProjection["cast"] = [{
    id: "char_def_player",
    participantId: "participant_player",
    characterInstanceId: "char_inst_player",
    name: "洛川",
    role: "人类使节",
    summary: "调停人。",
    status: "present",
    controlledBy: "human",
    isActive: true,
  }];
  return {
    id: LOCAL_RECORD_SCOPE.recordId,
    version: events.length,
    world: {
      id: "world_ember_coast",
      name: "烬海诸国",
      era: "停战纪元17年",
      summary: "人魔停战十七年后。",
      timeCursor: "停战纪元17年 · 雾月12日 · 入夜",
      style: "classical",
      language: "zh-CN",
    },
    story: { id: "story_silent_bell", title: "无声钟的来客", status: "active", premise: "密函。" },
    record: {
      id: LOCAL_RECORD_SCOPE.recordId,
      title: "第一幕",
      status: "active",
      version: events.length,
      location: "灰鲸港",
      worldTime: "入夜",
    },
    scene: { location: "灰鲸港", worldTime: "入夜", weather: "冷雾", tension: "钟声", objective: "拆信" },
    cast,
    participants: cast,
    events,
    stories: [],
    records: [],
  };
}

async function settle(ms = 200) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

test("A3：旧 opening hook 不作后续回合的 fresh trigger；新 narration/peer 仍正常触发", async () => {
  const repository = createInMemoryRuntimeRepository<
    CommandPayload, M2TurnPlan, M2TurnCandidate, M2TurnValidation, EventPayload, OutboxPayload
  >({ recordHeads: [{ recordId: LOCAL_RECORD_SCOPE.recordId, version: 1, nextOrdinal: 2 }] });

  async function loadProjection() {
    const committed = await repository.listCommittedEvents(LOCAL_RECORD_SCOPE.recordId);
    const opening: ProjectionEvent = {
      id: "event_opening",
      ordinal: 1,
      type: "narration",
      speaker: "旁白",
      speakerParticipantId: null,
      role: "narrator",
      content: "雾沿着石阶爬上防波堤。",
      segments: fallbackSemanticSegments("雾沿着石阶爬上防波堤。", "environment"),
      worldTime: "入夜",
      visibility: "public",
      status: "committed",
      createdAt: "2026-08-13T01:00:00.000Z",
    };
    const events: ProjectionEvent[] = [opening, ...committed.map((event, index): ProjectionEvent => ({
      id: event.eventId,
      ordinal: index + 2,
      type: "utterance" as const,
      speaker: event.payload.speaker,
      speakerParticipantId: event.payload.participantId,
      role: event.payload.role,
      content: event.payload.content,
      segments: fallbackSemanticSegments(event.payload.content, "story"),
      worldTime: "入夜",
      visibility: "public",
      status: "committed" as const,
      createdAt: event.committedAt,
    }))];
    return baseProjection(events);
  }

  // 初夜 fake：hook 事件身份固定（event_fn_hook，初夜时已提交）；
  // 新鲜度由「是否存在 hook 之后的其他玩家回合事件」这一持久游标推出——
  // 不用固定轮数/时间窗/进程内集合/字符串比较。
  const freshnessCalls: { recordId: string; sourceEventId: string | null }[] = [];
  const firstNight = {
    async load(recordId: string) {
      if (recordId !== LOCAL_RECORD_SCOPE.recordId) return null;
      return { state: "ready" as const, hookContent: HOOK_TEXT, suggestions: [] };
    },
    async loadHookFreshness(recordId: string, currentTurnId: string | null) {
      freshnessCalls.push({ recordId, sourceEventId: currentTurnId });
      const committed = await repository.listCommittedEvents(recordId);
      // 当前玩家回合本身也是一次应答，不能因为排除它而重播已处理钩子。
      const priorPlayerAnswered = committed.some((event) => event.payload.role === "player");
      return { content: HOOK_TEXT, fresh: !priorPlayerAnswered };
    },
  };

  const gateCalls: PresenceContext[] = [];
  const assessor: PresenceAssessor = {
    async assess({ context, candidates }) {
      gateCalls.push({
        environment: [...context.environment],
        peer: [...context.peer],
        hook: context.hook,
      });
      const scholar = candidates.find(
        (candidate) => candidate.characterInstanceId === "char_inst_scholar",
      );
      return scholar
        ? {
          kind: "speak",
          characterInstanceId: scholar.characterInstanceId,
          triggerKind: context.hook ? "hook" : "peer",
          reason: "测试裁决。",
        }
        : { kind: "silent", reason: "无候选。" };
    },
  };

  const tokens = createMemoryWriteTokenRegistry({
    randomToken: () => `opaque-${Math.random()}`,
    clock: () => new Date("2026-08-13T02:00:00.000Z"),
  });
  const service = createLocalRecordService({
    repository,
    projection: {
      async loadRecentAuthorizedEvents() {
        return [];
      },
      async loadForPlayer() {
        return loadProjection();
      },
      async hasViewerProjection() {
        return true;
      },
      async loadDeliveryForPlayer() {
        return {
          record: await loadProjection(),
          viewer: {
            cursor: "viewer-local" as const,
            perspective: "omniscient" as const,
            dynamicKnowledgeVisible: true,
            characterInstanceId: null,
            membershipRole: "owner" as const,
          },
        };
      },
    },
    tokens,
    clock: () => new Date("2026-08-13T02:00:00.000Z"),
    idFactory: () => crypto.randomUUID(),
    presenceAssessor: assessor,
    turnControl: createTurnControl({ cooldownMs: 0 }),
    firstNight,
  });

  assert.equal((await firstNight.loadHookFreshness(LOCAL_RECORD_SCOPE.recordId, null)).fresh, true);
  // 回合 1 已应答 hook；本回合新 narration/peer 可触发，但不重播历史 hook。
  const first = await service.loadRecord(LOCAL_RECORD_SCOPE.recordId);
  await service.submitMessage({
    recordId: LOCAL_RECORD_SCOPE.recordId,
    content: "我拆开密函。",
    idempotencyKey: "hook-turn-1",
    writeToken: first.writeToken,
  });
  await settle(400);
  assert.equal(gateCalls.length, 1, "回合 1 后应有一次在场门禁评估");
  assert.equal(gateCalls[0]!.hook, null, "当前玩家回合已应答初夜，不能重播为 fresh hook");

  // 回合 2：同一旧 hook 已被回合 1 的玩家事件应答——不得再当「刚发生」。
  const second = await service.loadRecord(LOCAL_RECORD_SCOPE.recordId);
  await service.submitMessage({
    recordId: LOCAL_RECORD_SCOPE.recordId,
    content: "我沿着防波堤追出去。",
    idempotencyKey: "hook-turn-2",
    writeToken: second.writeToken,
  });
  await settle(400);
  assert.equal(gateCalls.length, 2, "回合 2 仍应有在场评估（新 narration/peer 可触发）");
  assert.equal(
    gateCalls[1]!.hook,
    null,
    "旧 hook 不得再次作为 fresh trigger 进入门禁上下文",
  );
  assert.ok(
    gateCalls[1]!.environment.length > 0 || gateCalls[1]!.peer.length > 0,
    "回合 2 的本回合 narration/peer 素材不受影响",
  );

  // 游标判定确定（重载/重读同结果）；freshness 读取确实发生且携带
  // 当前回合 source event identity（非字符串内容比较）。
  assert.ok(freshnessCalls.length >= 2, "freshness 须按持久游标逐回合判定");
  assert.ok(
    freshnessCalls.every((call) => call.sourceEventId !== undefined),
    "freshness 判定须携带当前回合 source event 游标",
  );
});
