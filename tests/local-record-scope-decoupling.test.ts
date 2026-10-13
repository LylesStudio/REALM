/**
 * Slice 2.5 验收：local-record-service / read-model 与硬编码演示 ID 解耦。
 *
 * - 有 runtimeScopeProvider：任意 recordId 均可打开——scope/principal/
 *   viewer 全部经 provider 解析；provider miss → fail-closed NOT_FOUND。
 * - 无 provider：仅 LOCAL_RECORD_SCOPE.recordId 的本地 demo 回落可用，
 *   其余 recordId 一律 fail-closed NOT_FOUND（loadRecord /
 *   authorizeRecordViewer / submitMessage / self-play 同一形态）。
 * - 运行时定义读取按 Record 的 WorldBinding 经内容解析层分流：
 *   base → BaseContentResolver；world-bound → 已挂载 RealmWorld 包的
 *   RealmWorldContentResolver（此处以注入工厂替身验证接线与缓存）；
 *   DB 物化定义在冲突时优先（账本身份不被内容层覆盖）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type {
  RecordProjection,
  ProjectionEvent,
} from "../modules/application/legacy-record-projection-types.ts";
import {
  LOCAL_RECORD_SCOPE,
  LocalRecordServiceError,
  createLocalRecordService,
  createMemoryWriteTokenRegistry,
} from "../modules/application/local-record-service.ts";
import { demoRecordRuntimeScope } from "../modules/application/local-record-read-model.ts";
import {
  createRecordContentResolverSource,
  narrowWorldBinding,
} from "../modules/application/record-content-resolver.ts";
import {
  createContentRuleDefinitionProvider,
} from "../modules/actions/content-rule-provider.ts";
import { BASE_CONTENT_RESOLVER } from "../modules/content-resolution/base-resolver.ts";
import type { ContentResolver } from "../modules/content-resolution/public.ts";
import type {
  RecordRuntimeScope,
} from "../database/postgres/public.ts";
import type { WorldBinding } from "../modules/world-transfer/realm-save.ts";
import {
  createInMemoryRuntimeRepository,
  type RuntimeRepository,
} from "../modules/runtime/public.ts";
import type {
  M2TurnCandidate,
  M2TurnPlan,
  M2TurnValidation,
  TurnVisibilityPlan,
} from "../modules/orchestration/public.ts";
import type { SemanticSegment } from "../modules/presentation/semantic-segments.ts";

type CommandPayload = { text: string; visibility: TurnVisibilityPlan };
type EventPayload = {
  schemaVersion: 1;
  role: "player" | "character" | "narrator" | "system";
  speaker: string;
  participantId: string | null;
  content: string;
  segments: readonly SemanticSegment[];
};
type OutboxPayload = { recordId: string; eventIds: readonly string[] };
type Repository = RuntimeRepository<
  CommandPayload,
  M2TurnPlan,
  M2TurnCandidate,
  M2TurnValidation,
  EventPayload,
  OutboxPayload
>;

/** 任意 Record 的自定义运行时 scope（与演示身份完全不同）。 */
function customScope(overrides: Partial<RecordRuntimeScope> = {}): RecordRuntimeScope {
  const base = demoRecordRuntimeScope();
  return {
    ...base,
    workspaceId: "ws_custom",
    principalId: "principal_custom",
    worldId: "world_custom",
    worldlineId: "worldline_custom",
    storyId: "story_custom",
    recordId: "record_custom_1",
    sceneId: "scene_custom",
    publicPolicyId: "visibility_public_custom",
    viewerCharacterInstanceId: "char_inst_custom_player",
    playerActor: {
      characterInstanceId: "char_inst_custom_player",
      participantId: "participant_custom_player",
      displayName: "自定义玩家",
      profileSummary: "自定义世界的旅人。",
    },
    aiCharacters: [{
      characterInstanceId: "char_inst_custom_scout",
      participantId: "participant_custom_scout",
      displayName: "自定义斥候",
      profileSummary: "自定义世界的斥候。",
    }],
    observerCharacterInstanceIds: ["char_inst_custom_player"],
    ...overrides,
  };
}

function openingEvent(recordId: string): ProjectionEvent {
  return {
    id: `${recordId}:opening`,
    ordinal: 1,
    type: "narration",
    speaker: "旁白",
    speakerParticipantId: null,
    role: "narrator",
    content: "开场。",
    segments: [],
    worldTime: "自定义纪元 · 夜",
    visibility: "public",
    status: "committed",
    createdAt: "2026-10-11T00:00:00.000Z",
  };
}

function stubProjection(
  recordId: string,
  version: number,
  events: readonly ProjectionEvent[] = [],
): RecordProjection {
  return {
    id: recordId,
    version,
    world: {
      id: "world_custom",
      name: "自定义世界",
      era: "自定义纪元",
      summary: "解耦测试。",
      timeCursor: "自定义纪元 · 夜",
      style: "classical",
      language: "zh-CN",
    },
    story: {
      id: "story_custom",
      title: "自定义故事",
      status: "active",
      premise: "前提。",
    },
    record: {
      id: recordId,
      title: "自定义场景",
      status: "active",
      version,
      location: "自定义地点",
      worldTime: "自定义纪元 · 夜",
    },
    scene: {
      location: "自定义地点",
      worldTime: "自定义纪元 · 夜",
      weather: "无风",
      tension: "平静",
      objective: "验证 scope 解耦",
    },
    cast: [],
    participants: [],
    events: [...events],
    stories: [],
    records: [],
  };
}

type DeliveryScope = {
  workspaceId: string;
  recordId: string;
  principalId: string;
  characterInstanceId?: string;
};

function createFixture(options: {
  recordId?: string;
  scope?: RecordRuntimeScope | null;
  viewerAuthorized?: boolean;
} = {}) {
  const recordId = options.recordId ?? LOCAL_RECORD_SCOPE.recordId;
  const repository: Repository = createInMemoryRuntimeRepository({
    recordHeads: [
      { recordId, version: 1, nextOrdinal: 2 },
    ],
  });
  const deliveryScopes: DeliveryScope[] = [];
  const resolveCalls: {
    workspaceId: string;
    principalId: string;
    recordId: string;
  }[] = [];
  async function loadProjection() {
    const runtimeEvents = await repository.listCommittedEvents(recordId);
    const mapped: ProjectionEvent[] = runtimeEvents
      .filter((event) => event.kind !== "action.transaction.committed")
      .map((event, index) => ({
        id: event.eventId,
        ordinal: index + 2,
        type:
          event.kind === "narration.committed"
            ? "narration" as const
            : "utterance" as const,
        speaker: event.payload.speaker,
        speakerParticipantId: event.payload.participantId,
        role: event.payload.role,
        content: event.payload.content,
        segments: event.payload.segments,
        worldTime: "自定义纪元 · 夜",
        visibility: "public" as const,
        status: "committed" as const,
        createdAt: event.committedAt,
      }));
    const events: ProjectionEvent[] = [openingEvent(recordId), ...mapped];
    return stubProjection(recordId, 1 + runtimeEvents.length, events);
  }
  const projection = {
    async loadRecentAuthorizedEvents() {
      return [];
    },
    async hasViewerProjection() {
      return options.viewerAuthorized ?? true;
    },
    async loadForPlayer() {
      return loadProjection();
    },
    async loadDeliveryForPlayer(scope: DeliveryScope) {
      deliveryScopes.push(scope);
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
  };
  let tokenSequence = 0;
  const service = createLocalRecordService({
    repository,
    // 结构 stub：与既有内存测试同一形状（partial 结构化满足依赖窄接口）。
    projection: projection as never,
    tokens: createMemoryWriteTokenRegistry({
      randomToken: () => `opaque-${++tokenSequence}`,
      clock: () => new Date("2026-10-11T00:00:00.000Z"),
    }),
    clock: () => new Date("2026-10-11T00:00:00.000Z"),
    ...(options.scope !== undefined
      ? {
        runtimeScopeProvider: {
          async resolve(scope: {
            workspaceId: string;
            principalId: string;
            recordId: string;
          }) {
            resolveCalls.push(scope);
            return options.scope ?? null;
          },
          async resolveViewerCharacterInstanceId() {
            return options.scope?.viewerCharacterInstanceId ?? null;
          },
        },
      }
      : {}),
  });
  return { service, repository, deliveryScopes, resolveCalls };
}

test("provider-present：任意 recordId 经 provider 解析并打开信封", async () => {
  const scope = customScope();
  const { service, deliveryScopes, resolveCalls } = createFixture({
    recordId: scope.recordId,
    scope,
  });
  const envelope = await service.loadRecord(scope.recordId, scope.principalId);
  assert.equal(envelope.record.record.id, scope.recordId);
  // provider 收到了调用方身份 + 任意 recordId（非演示白名单）。
  assert.deepEqual(resolveCalls, [{
    workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
    principalId: scope.principalId,
    recordId: scope.recordId,
  }]);
  // 快照读身份来自已解析 scope（workspace/principal 与演示常量不同）。
  assert.ok(deliveryScopes.length >= 1);
  for (const read of deliveryScopes) {
    assert.equal(read.workspaceId, "ws_custom");
    assert.equal(read.principalId, "principal_custom");
    assert.equal(read.recordId, scope.recordId);
  }
});

test("provider-present：任意 recordId 的完整回合提交（写令牌/回合/信封同 scope）", async () => {
  const scope = customScope();
  const { service } = createFixture({ recordId: scope.recordId, scope });
  const before = await service.loadRecord(scope.recordId, scope.principalId);
  const result = await service.submitMessage({
    recordId: scope.recordId,
    content: "我环顾四周。",
    idempotencyKey: "decouple-turn-1",
    writeToken: before.writeToken,
    principalId: scope.principalId,
  });
  assert.equal(result.disposition, "committed");
  assert.equal(result.record.record.id, scope.recordId);
  assert.ok(
    result.record.events.some((event) => event.content === "我环顾四周。"),
  );
});

test("provider-present：provider miss → fail-closed NOT_FOUND", async () => {
  const { service } = createFixture({
    recordId: "record_custom_1",
    scope: null,
    viewerAuthorized: false,
  });
  await assert.rejects(
    () => service.loadRecord("record_custom_1", "principal_custom"),
    (error: unknown) =>
      error instanceof LocalRecordServiceError && error.code === "NOT_FOUND",
  );
  await assert.rejects(
    () =>
      service.submitMessage({
        recordId: "record_custom_1",
        content: "测试",
        idempotencyKey: "decouple-miss-1",
        writeToken: "opaque-missing",
        principalId: "principal_custom",
      }),
    (error: unknown) =>
      error instanceof LocalRecordServiceError && error.code === "NOT_FOUND",
  );
  await assert.rejects(
    () => service.authorizeRecordViewer("record_custom_1", "principal_custom"),
    (error: unknown) =>
      error instanceof LocalRecordServiceError && error.code === "NOT_FOUND",
  );
});

test("provider-present：authorizeRecordViewer 经 provider 解析 viewer 身份", async () => {
  const scope = customScope();
  const { service } = createFixture({ recordId: scope.recordId, scope });
  const viewer = await service.authorizeRecordViewer(
    scope.recordId,
    scope.principalId,
  );
  assert.equal(viewer, "char_inst_custom_player");
});

test("no-provider：demo Record 回落保持可用", async () => {
  const { service } = createFixture();
  const envelope = await service.loadRecord(LOCAL_RECORD_SCOPE.recordId);
  assert.equal(envelope.record.record.id, LOCAL_RECORD_SCOPE.recordId);
  const viewer = await service.authorizeRecordViewer(
    LOCAL_RECORD_SCOPE.recordId,
  );
  assert.equal(viewer, demoRecordRuntimeScope().viewerCharacterInstanceId);
});

test("no-provider：非 demo recordId 一律 fail-closed NOT_FOUND", async () => {
  const { service } = createFixture();
  await assert.rejects(
    () => service.loadRecord("record_unknown"),
    (error: unknown) =>
      error instanceof LocalRecordServiceError && error.code === "NOT_FOUND",
  );
  await assert.rejects(
    () => service.authorizeRecordViewer("record_unknown"),
    (error: unknown) =>
      error instanceof LocalRecordServiceError && error.code === "NOT_FOUND",
  );
  await assert.rejects(
    () =>
      service.submitMessage({
        recordId: "record_unknown",
        content: "测试",
        idempotencyKey: "decouple-noprovider-1",
        writeToken: "opaque-missing",
      }),
    (error: unknown) =>
      error instanceof LocalRecordServiceError && error.code === "NOT_FOUND",
  );
});

test("narrowWorldBinding：缺省/畸形 fail-closed，world 身份精确窄化", () => {
  assert.deepEqual(narrowWorldBinding(undefined), { kind: "base" });
  assert.deepEqual(narrowWorldBinding(null), { kind: "base" });
  assert.deepEqual(narrowWorldBinding({ kind: "base" }), { kind: "base" });
  assert.deepEqual(
    narrowWorldBinding({ kind: "world", worldId: "w1", worldVersion: "2.0.0" }),
    { kind: "world", worldId: "w1", worldVersion: "2.0.0" },
  );
  // 畸形 world 身份 → null（绝不回落 base 顶替 world-bound 身份）。
  assert.equal(narrowWorldBinding({ kind: "world", worldId: "" }), null);
  assert.equal(
    narrowWorldBinding({ kind: "world", worldId: "w1" }),
    null,
  );
});

test("record content resolver source：base → BaseContentResolver；world-bound 经工厂挂载且按身份缓存", async () => {
  const source = createRecordContentResolverSource({});
  assert.equal(
    await source.forBinding({ kind: "base" }),
    BASE_CONTENT_RESOLVER,
  );
  // 未配置 installRoot/verifier：world-bound fail-closed null。
  assert.equal(
    await source.forBinding({ kind: "world", worldId: "w1", worldVersion: "1.0.0" }),
    null,
  );

  const mounts: string[] = [];
  const fakePackageResolver = { fake: true } as unknown as ContentResolver;
  const mounted = createRecordContentResolverSource({
    installRoot: "/installs",
    verifySignature: () => Promise.resolve(true),
    realmWorldResolverFactory: (binding, locale) => {
      mounts.push(`${binding.worldId}@${binding.worldVersion}:${locale}`);
      return Promise.resolve(fakePackageResolver);
    },
  });
  const binding: WorldBinding = {
    kind: "world",
    worldId: "w1",
    worldVersion: "1.0.0",
  };
  const first = await mounted.forBinding(binding, "zh-CN");
  const second = await mounted.forBinding(binding, "zh-CN");
  assert.equal(first, fakePackageResolver);
  assert.equal(second, fakePackageResolver);
  assert.deepEqual(mounts, ["w1@1.0.0:zh-CN"], "同一身份只挂载一次");
});

test("record content resolver source：挂载失败 fail-closed null 并告警一次", async () => {
  const warnings: string[] = [];
  const source = createRecordContentResolverSource({
    installRoot: "/installs",
    verifySignature: () => Promise.resolve(true),
    realmWorldResolverFactory: () =>
      Promise.reject(new Error("signature rejected")),
    logger: (line) => warnings.push(line),
  });
  const binding: WorldBinding = {
    kind: "world",
    worldId: "w-bad",
    worldVersion: "9.9.9",
  };
  assert.equal(await source.forBinding(binding), null);
  assert.equal(await source.forBinding(binding), null);
  assert.equal(warnings.length, 1);
});

test("内容规则 provider：DB 物化定义冲突优先，内容层补充未物化定义", async () => {
  // DB 物化定义（含账本 definitionId）。
  const fallback = {
    async loadSkill(skillKey: string) {
      return skillKey === "careful_observation"
        ? {
          definitionId: "skill_careful_observation",
          skillKey,
          title: "DB 标题",
          description: "DB 描述",
          metadata: {},
        }
        : null;
    },
    async loadAsset() {
      return null;
    },
    async loadStance() {
      return null;
    },
  };
  const provider = createContentRuleDefinitionProvider({
    resolver: BASE_CONTENT_RESOLVER,
    binding: { kind: "base" },
    language: "zh-CN",
    fallback,
  });
  // 冲突键：DB 物化定义胜出（账本 definitionId 不被内容层覆盖）。
  const shared = await provider.loadSkill("careful_observation");
  assert.equal(shared?.definitionId, "skill_careful_observation");
  assert.equal(shared?.title, "DB 标题");
  // 未物化键：base 内容层补充（"ember-coast" bundle 的 asset/stance）。
  const asset = await provider.loadAsset("signal_lantern");
  assert.equal(asset?.assetKey, "signal_lantern");
  assert.equal(asset?.definitionId, "content:asset:signal_lantern");
  const stance = await provider.loadStance("guarded_watch");
  assert.equal(stance?.effectKey, "guarded_watch");
  // 双 miss → null（fail-closed）。
  assert.equal(await provider.loadSkill("nonexistent_skill"), null);
});

test("内容规则 provider：world-bound binding 经包 resolver 解析包内容", async () => {
  const requests: { actionKind: string; actionKey: string }[] = [];
  const packageResolver: ContentResolver = {
    ...BASE_CONTENT_RESOLVER,
    resolveAction(request) {
      requests.push({
        actionKind: request.actionKind,
        actionKey: request.actionKey,
      });
      return request.actionKey === "tide_reading"
        ? {
          actionKind: "skill",
          actionKey: "tide_reading",
          title: "观潮",
          description: "读懂潮位。",
          rulePackKey: "tide_reading",
          consumable: false,
          effectKind: null,
          metadata: {},
        }
        : null;
    },
  };
  const provider = createContentRuleDefinitionProvider({
    resolver: packageResolver,
    binding: { kind: "world", worldId: "w1", worldVersion: "1.0.0" },
    language: "zh-CN",
  });
  const skill = await provider.loadSkill("tide_reading");
  assert.equal(skill?.skillKey, "tide_reading");
  assert.equal(skill?.definitionId, "content:skill:tide_reading");
  assert.deepEqual(requests, [{
    actionKind: "skill",
    actionKey: "tide_reading",
  }]);
  // 包内 miss → null，绝不回退到其他内容包。
  assert.equal(await provider.loadSkill("careful_observation"), null);
});
