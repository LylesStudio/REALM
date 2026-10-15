import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as previewModule from "../modules/application/local-record-preview.ts";
import {
  createLocalPreviewHub,
  createLocalRecordService,
  type LocalPreviewEvent,
} from "../modules/application/local-record-service.ts";
import {
  createInMemoryRuntimeRepository,
  type RuntimeRepository,
} from "../modules/runtime/public.ts";
import type { RecordProjection } from "../modules/application/legacy-record-projection-types.ts";
import type {
  M2TurnCandidate,
  M2TurnPlan,
  M2TurnValidation,
  TurnVisibilityPlan,
} from "../modules/orchestration/public.ts";
import type { SemanticSegment } from "../modules/presentation/semantic-segments.ts";

/**
 * Phase 2B：preview 内存广播/可见性过滤生命周期已从 facade 拆入
 * modules/application/local-record-preview.ts。本文件是拆分边界测试：
 * ① seam——facade 公开导出与新模块同一对象，facade 不再自带实现，
 *    新模块不反向 import facade；
 * ② behavior——begin/publishChunk/end/subscribe 生命周期、restricted
 *    audience 过滤、无身份 fail-closed、abort 后不发 committed end、
 *    end/unsubscribe 幂等清理。
 */

function collect(hub: ReturnType<typeof createLocalPreviewHub>, options: {
  recordId?: string;
  viewerCharacterInstanceId?: string;
} = {}) {
  const events: LocalPreviewEvent[] = [];
  const unsubscribe = hub.subscribe(
    options.recordId ?? "record",
    (event) => events.push(event),
    options.viewerCharacterInstanceId,
  );
  return { events, unsubscribe };
}

const RESTRICTED: TurnVisibilityPlan = {
  kind: "restricted",
  domainId: "domain_private",
  audienceCharacterInstanceIds: ["char_inst_player"],
};

test("seam：facade 的 preview 公开导出与 local-record-preview 模块是同一对象", () => {
  assert.equal(typeof previewModule.createLocalPreviewHub, "function");
  // facade re-export 不得复制第二份实现。
  assert.equal(createLocalPreviewHub, previewModule.createLocalPreviewHub);

  const facadeSource = readFileSync(
    new URL("../modules/application/local-record-service.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    facadeSource.includes('from "./local-record-preview.ts"'),
    "facade 必须 import local-record-preview.ts",
  );
  assert.ok(
    !/function createLocalPreviewHub/.test(facadeSource),
    "facade 不得再自行定义 createLocalPreviewHub",
  );
  assert.ok(
    !/function canViewPreview/.test(facadeSource),
    "facade 不得再自行定义可见性过滤",
  );

  const moduleSource = readFileSync(
    new URL("../modules/application/local-record-preview.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    !/from\s+["'][^"']*local-record-service/.test(moduleSource)
      && !/import\(\s*["'][^"']*local-record-service/.test(moduleSource),
    "preview 模块不得反向 import facade",
  );
});

test("seam：facade 默认路径使用新模块的 hub（缺省 previewHub 依赖可订阅/退订）", () => {
  type Repository = RuntimeRepository<
    { text: string; visibility: TurnVisibilityPlan },
    M2TurnPlan,
    M2TurnCandidate,
    M2TurnValidation,
    {
      schemaVersion: 1;
      role: "player" | "character" | "narrator" | "system";
      speaker: string;
      participantId: string | null;
      content: string;
      segments: readonly SemanticSegment[];
    },
    { recordId: string; eventIds: readonly string[] }
  >;
  const repository: Repository = createInMemoryRuntimeRepository({
    recordHeads: [{ recordId: "record_default_hub", version: 1, nextOrdinal: 2 }],
  });
  const projection = {
    async loadRecentAuthorizedEvents() {
      return [];
    },
    async loadForPlayer() {
      return null as unknown as RecordProjection;
    },
    async hasViewerProjection() {
      return true;
    },
    async loadDeliveryForPlayer() {
      return null;
    },
  };
  const service = createLocalRecordService({ repository, projection });
  // 默认 hub 来自新模块：订阅返回幂等 unsubscribe，重复调用不抛错。
  const unsubscribe = service.subscribePreviews(
    "record_default_hub",
    () => {},
    "char_inst_player",
  );
  unsubscribe();
  unsubscribe();
});

test("facade 注入 spy hub 时 subscribePreviews 委托而非自实现", () => {
  type Repository = RuntimeRepository<
    { text: string; visibility: TurnVisibilityPlan },
    M2TurnPlan,
    M2TurnCandidate,
    M2TurnValidation,
    {
      schemaVersion: 1;
      role: "player" | "character" | "narrator" | "system";
      speaker: string;
      participantId: string | null;
      content: string;
      segments: readonly SemanticSegment[];
    },
    { recordId: string; eventIds: readonly string[] }
  >;
  const repository: Repository = createInMemoryRuntimeRepository({
    recordHeads: [{ recordId: "record_spy", version: 1, nextOrdinal: 2 }],
  });
  const projection = {
    async loadRecentAuthorizedEvents() {
      return [];
    },
    async loadForPlayer() {
      return null as unknown as RecordProjection;
    },
    async hasViewerProjection() {
      return true;
    },
    async loadDeliveryForPlayer() {
      return null;
    },
  };
  const calls: { recordId: string; viewer?: string }[] = [];
  let disposed = 0;
  const service = createLocalRecordService({
    repository,
    projection,
    previewHub: {
      begin() {},
      publishChunk() {},
      end() {},
      subscribe(recordId, _listener, viewerCharacterInstanceId) {
        calls.push({ recordId, viewer: viewerCharacterInstanceId });
        return () => {
          disposed += 1;
        };
      },
    },
  });
  const unsubscribe = service.subscribePreviews(
    "record_spy",
    () => {},
    "char_inst_player",
  );
  assert.deepEqual(calls, [
    { recordId: "record_spy", viewer: "char_inst_player" },
  ]);
  unsubscribe();
  assert.equal(disposed, 1);
});

test("public 广播：有无身份的订阅者都收到 chunk 与 end", () => {
  const hub = createLocalPreviewHub();
  const named = collect(hub, { viewerCharacterInstanceId: "char_inst_player" });
  const anonymous = collect(hub);
  hub.begin("record", "p1", undefined, { kind: "public" });
  hub.publishChunk("record", "旁白", "潮水漫过石阶。");
  hub.end("record", "committed");

  const expected: LocalPreviewEvent[] = [
    { kind: "chunk", previewId: "p1", turnId: "p1", segmentIndex: 0, phase: "preview", speaker: "旁白", content: "潮水漫过石阶。", status: "preview", visibility: "player" },
    { kind: "end", previewId: "p1", turnId: "p1", status: "committed", outcome: "committed" },
  ];
  assert.deepEqual(named.events, expected);
  assert.deepEqual(anonymous.events, expected);
});

test("restricted：只有 audience 身份收到 chunk 与 end，end 元数据同样受约束", () => {
  const hub = createLocalPreviewHub();
  const insider = collect(hub, { viewerCharacterInstanceId: "char_inst_player" });
  const outsider = collect(hub, { viewerCharacterInstanceId: "char_inst_stranger" });
  hub.begin("record", "p2", undefined, RESTRICTED);
  hub.publishChunk("record", "旁白", "密函里写着真名。");
  hub.end("record", "committed");

  assert.deepEqual(insider.events, [
    { kind: "chunk", previewId: "p2", turnId: "p2", segmentIndex: 0, phase: "preview", speaker: "旁白", content: "密函里写着真名。", status: "preview", visibility: "player" },
    { kind: "end", previewId: "p2", turnId: "p2", status: "committed", outcome: "committed" },
  ]);
  assert.deepEqual(outsider.events, [], "非 audience 不得收到 restricted chunk/end");
});

test("restricted 无身份 fail-closed：缺 viewer 身份订阅者收不到任何事件", () => {
  const hub = createLocalPreviewHub();
  const anonymous = collect(hub);
  const empty = collect(hub, { viewerCharacterInstanceId: "" });
  hub.begin("record", "p3", undefined, RESTRICTED);
  hub.publishChunk("record", "旁白", "只有你能看见。");
  hub.end("record", "aborted");

  assert.deepEqual(anonymous.events, []);
  assert.deepEqual(empty.events, []);
});

test("abort 后迟到的 committed cleanup 必须发 aborted；abort 后 chunk 被丢弃", () => {
  const hub = createLocalPreviewHub();
  const { events } = collect(hub);
  const controller = new AbortController();
  hub.begin("record", "p4", controller.signal, { kind: "public" });
  hub.publishChunk("record", "塞娜", "第一句");
  controller.abort();
  hub.publishChunk("record", "塞娜", "被打断的半句");
  hub.end("record", "committed");

  assert.deepEqual(events, [
    { kind: "chunk", previewId: "p4", turnId: "p4", segmentIndex: 0, phase: "preview", speaker: "塞娜", content: "第一句", status: "preview", visibility: "player" },
    { kind: "end", previewId: "p4", turnId: "p4", status: "cancelled", outcome: "aborted" },
  ]);
});

test("只有 streaming 才能 push：begin 前/end 后的 chunk 与空 chunk 都不广播", () => {
  const hub = createLocalPreviewHub();
  const { events } = collect(hub);
  hub.publishChunk("record", "旁白", "会话不存在");
  hub.begin("record", "p5", undefined, { kind: "public" });
  hub.publishChunk("record", "旁白", "");
  hub.publishChunk("record", "旁白", "有效内容");
  hub.end("record", "committed");
  hub.publishChunk("record", "旁白", "结束后的迟到 chunk");

  assert.deepEqual(events, [
    { kind: "chunk", previewId: "p5", turnId: "p5", segmentIndex: 0, phase: "preview", speaker: "旁白", content: "有效内容", status: "preview", visibility: "player" },
    { kind: "end", previewId: "p5", turnId: "p5", status: "committed", outcome: "committed" },
  ]);
});

test("重复 end 幂等：第二次 end 不再广播；未知 record 的 end 是无操作", () => {
  const hub = createLocalPreviewHub();
  const { events } = collect(hub);
  hub.end("record", "committed");
  hub.begin("record", "p6", undefined, { kind: "public" });
  hub.publishChunk("record", "旁白", "内容");
  hub.end("record", "committed");
  hub.end("record", "committed");

  assert.deepEqual(events, [
    { kind: "chunk", previewId: "p6", turnId: "p6", segmentIndex: 0, phase: "preview", speaker: "旁白", content: "内容", status: "preview", visibility: "player" },
    { kind: "end", previewId: "p6", turnId: "p6", status: "committed", outcome: "committed" },
  ]);
});

test("重复 unsubscribe 幂等：退订后不再接收，监听器零残留", () => {
  const hub = createLocalPreviewHub();
  const { events, unsubscribe } = collect(hub);
  unsubscribe();
  unsubscribe();
  hub.begin("record", "p7", undefined, { kind: "public" });
  hub.publishChunk("record", "旁白", "退订后不得送达");
  hub.end("record", "committed");
  assert.deepEqual(events, []);

  // 退订清空 listener 集合后，重新订阅仍能工作。
  const again = collect(hub);
  hub.begin("record", "p8", undefined, { kind: "public" });
  hub.publishChunk("record", "旁白", "新一轮");
  hub.end("record", "committed");
  assert.deepEqual(again.events, [
    { kind: "chunk", previewId: "p8", turnId: "p8", segmentIndex: 0, phase: "preview", speaker: "旁白", content: "新一轮", status: "preview", visibility: "player" },
    { kind: "end", previewId: "p8", turnId: "p8", status: "committed", outcome: "committed" },
  ]);
});

test("跨 record 隔离：事件只送达同 record 的订阅者", () => {
  const hub = createLocalPreviewHub();
  const a = collect(hub, { recordId: "record_a" });
  const b = collect(hub, { recordId: "record_b" });
  hub.begin("record_a", "pa", undefined, { kind: "public" });
  hub.publishChunk("record_a", "旁白", "只在 A");
  hub.end("record_a", "committed");

  assert.equal(a.events.length, 2);
  assert.deepEqual(b.events, []);
});
