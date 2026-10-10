import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  LOCAL_RECORD_SCOPE,
  LocalRecordServiceError,
  createLocalRecordService,
  createMemoryWriteTokenRegistry,
} from "../modules/application/local-record-service.ts";
import * as readModel from "../modules/application/local-record-read-model.ts";
import type { RecordProjection } from "../modules/application/legacy-record-projection-types.ts";
import type { ActionAffordance } from "../modules/actions/public.ts";
import type {
  M2TurnCandidate,
  M2TurnPlan,
  M2TurnValidation,
  TurnVisibilityPlan,
} from "../modules/orchestration/public.ts";
import type { SemanticSegment } from "../modules/presentation/semantic-segments.ts";
import {
  createInMemoryRuntimeRepository,
  type RuntimeRepository,
} from "../modules/runtime/public.ts";

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

const AFFORDANCE: ActionAffordance = {
  id: "scene.observe_surroundings",
  kind: "scene",
  actorCharacterInstanceId: "char_inst_player",
  actorName: "测试者",
  title: "观察四周",
  description: "观察四周。",
  suggestedText: "我观察四周。",
};

function stubProjection(version: number): RecordProjection {
  return {
    id: LOCAL_RECORD_SCOPE.recordId,
    version,
    world: {
      id: "world_read_model",
      name: "读模型世界",
      era: "测试纪元",
      summary: "读模型测试。",
      timeCursor: "测试纪元 · 夜",
      style: "classical",
      language: "zh-CN",
    },
    story: {
      id: "story_read_model",
      title: "读模型故事",
      status: "active",
      premise: "前提。",
    },
    record: {
      id: LOCAL_RECORD_SCOPE.recordId,
      title: "读模型场景",
      status: "active",
      version,
      location: "测试地点",
      worldTime: "测试纪元 · 夜",
    },
    scene: {
      location: "测试地点",
      worldTime: "测试纪元 · 夜",
      weather: "无风",
      tension: "平静",
      objective: "验证一致性快照",
    },
    cast: [],
    participants: [],
    events: [],
    stories: [],
    records: [],
  };
}

/**
 * 包装内存仓储，使 loadRecordHead 按给定版本序列应答（模拟快照读取
 * 期间的并发写者）。versions 用尽后保持最后一个值。
 */
function wrapHeadVersions(inner: Repository, versions: readonly number[]) {
  let calls = 0;
  const loadRecordHead = async (recordId: string) => {
    const head = await inner.loadRecordHead(recordId);
    if (!head) return null;
    const version = versions[Math.min(calls, versions.length - 1)];
    calls += 1;
    return { ...head, version };
  };
  return {
    repository: new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === "loadRecordHead") return loadRecordHead;
        return Reflect.get(target, prop, receiver);
      },
    }),
    headReads: () => calls,
  };
}

function createService(options: {
  headVersions?: readonly number[];
  sceneImageStore?: unknown;
  sceneImageQueue?: unknown;
  orchestrator?: unknown;
} = {}) {
  const inner: Repository = createInMemoryRuntimeRepository({
    recordHeads: [
      { recordId: LOCAL_RECORD_SCOPE.recordId, version: 3, nextOrdinal: 4 },
    ],
  });
  const wrapped = options.headVersions
    ? wrapHeadVersions(inner, options.headVersions)
    : null;
  const repository = wrapped ? wrapped.repository : inner;
  let deliveryReads = 0;
  const projection = {
    async loadRecentAuthorizedEvents() {
      return [];
    },
    async loadForPlayer() {
      return stubProjection(3);
    },
    async hasViewerProjection() {
      return true;
    },
    async loadDeliveryForPlayer() {
      deliveryReads += 1;
      return {
        record: stubProjection(3),
        viewer: {
          cursor: "viewer-local" as const,
          perspective: "omniscient" as const,
          dynamicKnowledgeVisible: true,
          characterInstanceId: "char_inst_player",
          membershipRole: "owner" as const,
        },
        suggestions: ["拆开密函", "先观察蜡封"],
      };
    },
  };
  let tokenSequence = 0;
  const service = createLocalRecordService({
    repository,
    projection,
    actionCatalog: {
      async listAuthorized() {
        return [AFFORDANCE];
      },
    },
    tokens: createMemoryWriteTokenRegistry({
      randomToken: () => `opaque-${++tokenSequence}`,
      clock: () => new Date("2026-10-01T00:00:00.000Z"),
    }),
    clock: () => new Date("2026-10-01T00:00:00.000Z"),
    ...(options.sceneImageStore
      ? { sceneImageStore: options.sceneImageStore as never }
      : {}),
    ...(options.sceneImageQueue
      ? { sceneImageQueue: options.sceneImageQueue as never }
      : {}),
    ...(options.orchestrator
      ? { orchestrator: options.orchestrator as never }
      : {}),
  });
  return {
    service,
    deliveryReads: () => deliveryReads,
    headReads: () => wrapped?.headReads() ?? 0,
  };
}

test("接线契约：read-model 模块真实存在且被 facade 使用", () => {
  // 模块提供读侧入口。
  assert.equal(typeof readModel.loadConsistentSnapshot, "function");
  assert.equal(typeof readModel.loadConsistentEnvelope, "function");
  // facade 的公开导出与 read-model 是同一对象（不复制定义）。
  assert.equal(LOCAL_RECORD_SCOPE, readModel.LOCAL_RECORD_SCOPE);
  assert.equal(LocalRecordServiceError, readModel.LocalRecordServiceError);
  // facade 源码不再自带快照/信封实现，而是接线到新模块。
  const facadeSource = readFileSync(
    new URL("../modules/application/local-record-service.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    facadeSource.includes('from "./local-record-read-model.ts"'),
    "facade 必须 import local-record-read-model.ts",
  );
  assert.ok(
    !/async function loadConsistentSnapshot/.test(facadeSource),
    "facade 不得再自行定义 loadConsistentSnapshot",
  );
  assert.ok(
    !/async function loadConsistentEnvelope/.test(facadeSource),
    "facade 不得再自行定义 loadConsistentEnvelope",
  );
});

test("稳定快照：loadRecord 返回完整 envelope（writeToken/viewer/affordances/suggestions）", async () => {
  const { service, deliveryReads } = createService();
  const envelope = await service.loadRecord();

  assert.equal(envelope.record.id, LOCAL_RECORD_SCOPE.recordId);
  assert.equal(envelope.record.version, 3);
  assert.equal(envelope.writeToken, "opaque-1");
  assert.deepEqual(envelope.viewer, {
    cursor: "viewer-local",
    perspective: "omniscient",
    dynamicKnowledgeVisible: true,
    characterInstanceId: "char_inst_player",
    membershipRole: "owner",
  });
  assert.deepEqual(envelope.affordances, [AFFORDANCE]);
  assert.deepEqual(envelope.suggestions, ["拆开密函", "先观察蜡封"]);
  // 稳定 head：一次尝试即返回。
  assert.equal(deliveryReads(), 1);
});

test("head 在读取期间变化：版本稳定后重试成功", async () => {
  // 第一次尝试 before=3/after=4 不一致；第二次 4/4 一致。
  const { service, deliveryReads } = createService({
    headVersions: [3, 4, 4, 4],
  });
  const envelope = await service.loadRecord();
  assert.equal(envelope.record.id, LOCAL_RECORD_SCOPE.recordId);
  assert.equal(deliveryReads(), 2);
});

test("head 持续变化：耗尽 SNAPSHOT_ATTEMPTS 后 WRITE_CONFLICT", async () => {
  const { service, deliveryReads } = createService({
    headVersions: [1, 2, 3, 4, 5, 6, 7],
  });
  await assert.rejects(service.loadRecord(), (error: unknown) => {
    assert.ok(error instanceof LocalRecordServiceError);
    assert.equal(error.code, "WRITE_CONFLICT");
    assert.equal(
      error.message,
      "The Record changed while its delivery view was being prepared.",
    );
    return true;
  });
  // 既有语义：恰好 3 次尝试，每次尝试各读一次 delivery。
  assert.equal(deliveryReads(), 3);
});

test("submitMessage 路径同样走一致性快照（head 翻动时在任何回合执行前失败）", async () => {
  const orchestratorSpy = {
    async planTurn(): Promise<never> {
      throw new Error("orchestrator must not be reached");
    },
  };
  const { service } = createService({
    headVersions: [1, 2, 3, 4, 5, 6, 7],
    orchestrator: orchestratorSpy,
  });
  await assert.rejects(
    service.submitMessage({
      recordId: LOCAL_RECORD_SCOPE.recordId,
      content: "我拆开密函。",
      idempotencyKey: "submit-read-model-1",
      writeToken: "irrelevant-token",
    }),
    (error: unknown) => {
      assert.ok(error instanceof LocalRecordServiceError);
      assert.equal(error.code, "WRITE_CONFLICT");
      return true;
    },
  );
});

test("可选状态字段不泄露额外控制面数据", async () => {
  const { service } = createService({
    sceneImageStore: {
      async findLatestReady() {
        // 仓储行带有 prompt_id/error_code 等控制面字段。
        return {
          id: "gen_1",
          worldId: "world_read_model",
          recordId: LOCAL_RECORD_SCOPE.recordId,
          sceneId: "scene_1",
          status: "ready",
          fileId: "file_1",
          promptId: "internal-prompt-id",
          errorCode: null,
        };
      },
    },
    sceneImageQueue: {
      async findLatestForRecord() {
        return {
          id: "req_1",
          worldId: "world_read_model",
          recordId: LOCAL_RECORD_SCOPE.recordId,
          sceneId: "scene_1",
          principalId: LOCAL_RECORD_SCOPE.principalId,
          triggerKind: "scene_change",
          sourceEventId: "evt_internal",
          status: "leased",
          generationId: "gen_1",
          attempts: 2,
          leaseRevision: 7,
        };
      },
    },
  });
  const envelope = await service.loadRecord();

  // sceneImage：只有 fileId/fileUrl/status；fileUrl 恒为相对路径。
  assert.deepEqual(envelope.sceneImage, {
    fileId: "file_1",
    fileUrl: "/api/files/file_1",
    status: "ready",
  });
  // sceneImageJob：只有 status/triggerKind；leased 映射为 running。
  assert.deepEqual(envelope.sceneImageJob, {
    status: "running",
    triggerKind: "scene_change",
  });
  // viewer 恰好五个字段，无内部 principal/participant 信息。
  assert.deepEqual(Object.keys(envelope.viewer).sort(), [
    "characterInstanceId",
    "cursor",
    "dynamicKnowledgeVisible",
    "membershipRole",
    "perspective",
  ]);
  // envelope 顶层恰好是既有公开字段集，不多不少。
  assert.deepEqual(Object.keys(envelope).sort(), [
    "affordances",
    "firstNight",
    "record",
    "sceneImage",
    "sceneImageJob",
    "selfPlay",
    "suggestions",
    "viewer",
    "writeToken",
  ]);
});
