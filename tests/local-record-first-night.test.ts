import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createFirstNightCoordinator,
  type FirstNightMarker,
  type FirstNightMarkerSource,
} from "../modules/application/local-record-first-night.ts";
import {
  LOCAL_RECORD_SCOPE,
  loadConsistentEnvelope,
  type LocalRecordReadModelDependencies,
  type WriteTokenRegistry,
} from "../modules/application/local-record-read-model.ts";
import { createInMemoryRuntimeRepository } from "../modules/runtime/public.ts";
import type { RecordProjection } from "../modules/application/legacy-record-projection-types.ts";
import type { ActionAffordanceCatalog } from "../modules/actions/public.ts";

/**
 * Phase 2G-C：first-night application coordinator 垂直切片。
 * 一组直接调用 coordinator factory 的行为测试 + 一组经
 * `loadConsistentEnvelope` 真实 read-model 路径的接线测试 + seam guard
 * （coordinator 无 facade/DB/routes import、归一化/调度/fail-closed
 * 只有一份实现、read-model 真实调用 coordinator）。
 */

const RECORD_ID = LOCAL_RECORD_SCOPE.recordId;

function marker(
  state: "pending" | "ready" | "degraded",
  overrides: Partial<FirstNightMarker> = {},
): FirstNightMarker {
  return {
    state,
    hookContent: "灯塔在无风夜点亮。",
    suggestions: [" 走向灯塔 ", "", "  ", "拆开密函"],
    ...overrides,
  };
}

async function captureWarnings(run: () => Promise<unknown>): Promise<string[]> {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown) => warnings.push(String(message));
  try {
    await run();
  } finally {
    console.warn = originalWarn;
  }
  return warnings;
}

test("coordinator：未装配 source → null", async () => {
  const coordinator = createFirstNightCoordinator();
  assert.equal(await coordinator.load(RECORD_ID), null);
});

test("coordinator：source.load 返回 null → null 且不调度", async () => {
  let scheduled = 0;
  const coordinator = createFirstNightCoordinator({
    load: async () => null,
    schedule: () => {
      scheduled += 1;
    },
  });
  assert.equal(await coordinator.load(RECORD_ID), null);
  assert.equal(scheduled, 0);
});

test("coordinator：ready 保留 hookContent，suggestions trim/filter 保序，不调度", async () => {
  let scheduled = 0;
  const coordinator = createFirstNightCoordinator({
    load: async () => marker("ready"),
    schedule: () => {
      scheduled += 1;
    },
  });
  assert.deepEqual(await coordinator.load(RECORD_ID), {
    state: "ready",
    hookContent: "灯塔在无风夜点亮。",
    openingSuggestions: ["走向灯塔", "拆开密函"],
  });
  assert.equal(scheduled, 0);
});

test("coordinator：degraded 保留 hookContent，不调度", async () => {
  let scheduled = 0;
  const coordinator = createFirstNightCoordinator({
    load: async () => marker("degraded", { suggestions: [] }),
    schedule: () => {
      scheduled += 1;
    },
  });
  assert.deepEqual(await coordinator.load(RECORD_ID), {
    state: "degraded",
    hookContent: "灯塔在无风夜点亮。",
    openingSuggestions: [],
  });
  assert.equal(scheduled, 0);
});

test("coordinator：pending 保留 marker 内容并恰好触发一次 fire-and-forget 调度", async () => {
  const scheduled: string[] = [];
  const coordinator = createFirstNightCoordinator({
    load: async () => marker("pending", { hookContent: "", suggestions: [] }),
    schedule: (recordId) => {
      scheduled.push(recordId);
    },
  });
  assert.deepEqual(await coordinator.load(RECORD_ID), {
    state: "pending",
    hookContent: "",
    openingSuggestions: [],
  });
  assert.deepEqual(scheduled, [RECORD_ID]);
});

test("coordinator：pending 且 source 无 schedule → 不抛错仍返回内容", async () => {
  const coordinator = createFirstNightCoordinator({
    load: async () => marker("pending", { hookContent: "", suggestions: [] }),
  });
  assert.deepEqual(await coordinator.load(RECORD_ID), {
    state: "pending",
    hookContent: "",
    openingSuggestions: [],
  });
});

test("coordinator：load 抛错 fail-closed warn-only，且 warn 不携带原始错误/secret", async () => {
  const source: FirstNightMarkerSource = {
    load: async () => {
      throw new Error("connect postgres://user:top-secret-token@db.internal:5432/realm");
    },
  };
  const coordinator = createFirstNightCoordinator(source);
  const warnings = await captureWarnings(async () => {
    assert.equal(await coordinator.load(RECORD_ID), null);
  });
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes("first night"));
  assert.ok(!warnings[0].includes("top-secret-token"), "warn 不得携带连接串/token");
  assert.ok(!warnings[0].includes("db.internal"), "warn 不得携带原始错误文本");
});

test("coordinator：schedule 抛错 warn-only，pending 内容仍返回且 warn 不泄漏原始错误", async () => {
  const coordinator = createFirstNightCoordinator({
    load: async () => marker("pending", { hookContent: "", suggestions: [] }),
    schedule: () => {
      throw new Error("scheduler token=top-secret-token");
    },
  });
  let result: unknown;
  const warnings = await captureWarnings(async () => {
    result = await coordinator.load(RECORD_ID);
  });
  assert.deepEqual(result, {
    state: "pending",
    hookContent: "",
    openingSuggestions: [],
  });
  assert.equal(warnings.length, 1);
  assert.ok(!warnings[0].includes("top-secret-token"), "warn 不得携带 secret");
});

// ---------- 真实 read-model 路径（loadConsistentEnvelope）接线 ----------

function stubProjection(): RecordProjection {
  return {
    id: RECORD_ID,
    version: 3,
    world: {
      id: "world_first_night",
      name: "初夜世界",
      era: "测试纪元",
      summary: "coordinator 测试。",
      timeCursor: "测试纪元 · 夜",
      style: "classical",
      language: "zh-CN",
    },
    story: {
      id: "story_first_night",
      title: "初夜故事",
      status: "active",
      premise: "前提。",
    },
    record: {
      id: RECORD_ID,
      title: "初夜场景",
      status: "active",
      version: 3,
      location: "测试地点",
      worldTime: "测试纪元 · 夜",
    },
    scene: {
      location: "测试地点",
      worldTime: "测试纪元 · 夜",
      weather: "无风",
      tension: "平静",
      objective: "验证 coordinator 接线",
    },
    cast: [],
    participants: [],
    events: [],
    stories: [],
    records: [],
  };
}

function createReadModelInput(options: { firstNight?: FirstNightMarkerSource } = {}) {
  const repository = createInMemoryRuntimeRepository({
    recordHeads: [{ recordId: RECORD_ID, version: 3, nextOrdinal: 4 }],
  });
  const projection = {
    async loadDeliveryForPlayer() {
      return {
        record: stubProjection(),
        viewer: {
          cursor: "viewer-local" as const,
          perspective: "omniscient" as const,
          dynamicKnowledgeVisible: true,
          characterInstanceId: "char_inst_player",
          membershipRole: "owner" as const,
        },
        suggestions: [],
      };
    },
  };
  const dependencies: LocalRecordReadModelDependencies = {
    repository,
    projection,
    ...(options.firstNight ? { firstNight: options.firstNight } : {}),
  };
  const tokens: WriteTokenRegistry = {
    issue: () => "write-token-test",
    authorize: () => ({ replay: false, expectedRecordVersion: 3 }),
    bind: () => {},
  };
  const actionCatalog: ActionAffordanceCatalog = {
    async listAuthorized() {
      return [];
    },
  };
  return { dependencies, tokens, actionCatalog };
}

test("read-model path：内存 fixture 不装 first-night → envelope.firstNight 为 null", async () => {
  const { dependencies, tokens, actionCatalog } = createReadModelInput();
  const envelope = await loadConsistentEnvelope(dependencies, tokens, actionCatalog, RECORD_ID);
  assert.equal(envelope.firstNight, null);
  assert.equal(envelope.record.version, 3);
});

test("read-model path：pending 经 envelope 触发一次懒调度并保留 marker 内容", async () => {
  const scheduled: string[] = [];
  const { dependencies, tokens, actionCatalog } = createReadModelInput({
    firstNight: {
      load: async () => marker("pending", { hookContent: "", suggestions: [] }),
      schedule: (recordId) => {
        scheduled.push(recordId);
      },
    },
  });
  const envelope = await loadConsistentEnvelope(dependencies, tokens, actionCatalog, RECORD_ID);
  assert.deepEqual(envelope.firstNight, {
    state: "pending",
    hookContent: "",
    openingSuggestions: [],
  });
  assert.deepEqual(scheduled, [RECORD_ID]);
});

test("read-model path：ready 经 envelope 保留 hookContent 与保序归一化 suggestions", async () => {
  let scheduled = 0;
  const { dependencies, tokens, actionCatalog } = createReadModelInput({
    firstNight: {
      load: async () => marker("ready"),
      schedule: () => {
        scheduled += 1;
      },
    },
  });
  const envelope = await loadConsistentEnvelope(dependencies, tokens, actionCatalog, RECORD_ID);
  assert.deepEqual(envelope.firstNight, {
    state: "ready",
    hookContent: "灯塔在无风夜点亮。",
    openingSuggestions: ["走向灯塔", "拆开密函"],
  });
  assert.equal(scheduled, 0);
});

test("read-model path：degraded 经 envelope 保留 hookContent", async () => {
  const { dependencies, tokens, actionCatalog } = createReadModelInput({
    firstNight: { load: async () => marker("degraded", { suggestions: [" 仅一条 "] }) },
  });
  const envelope = await loadConsistentEnvelope(dependencies, tokens, actionCatalog, RECORD_ID);
  assert.deepEqual(envelope.firstNight, {
    state: "degraded",
    hookContent: "灯塔在无风夜点亮。",
    openingSuggestions: ["仅一条"],
  });
});

test("read-model path：source.load 返回 null → envelope.firstNight 为 null", async () => {
  const { dependencies, tokens, actionCatalog } = createReadModelInput({
    firstNight: { load: async () => null },
  });
  const envelope = await loadConsistentEnvelope(dependencies, tokens, actionCatalog, RECORD_ID);
  assert.equal(envelope.firstNight, null);
});

test("read-model path：load 抛错 fail-closed → envelope.firstNight 为 null 且主路径正常", async () => {
  const { dependencies, tokens, actionCatalog } = createReadModelInput({
    firstNight: {
      load: async () => {
        throw new Error("store down top-secret-token");
      },
    },
  });
  const warnings = await captureWarnings(async () => {
    const envelope = await loadConsistentEnvelope(dependencies, tokens, actionCatalog, RECORD_ID);
    assert.equal(envelope.firstNight, null);
    assert.equal(envelope.record.version, 3);
    assert.equal(envelope.writeToken, "write-token-test");
  });
  assert.equal(warnings.length, 1);
  assert.ok(!warnings[0].includes("top-secret-token"), "warn 不得携带原始错误文本");
});

// ---------- seam guard ----------

test("seam：coordinator 不 import facade/database/routes/first-night-runtime", () => {
  const source = readFileSync(
    new URL("../modules/application/local-record-first-night.ts", import.meta.url),
    "utf8",
  );
  const importLines = source.match(/^import[\s\S]*?from\s+"[^"]+";?$/gm) ?? [];
  for (const line of importLines) {
    assert.ok(
      !/local-record-service|database\/postgres|first-night-runtime|routes|\/api\//.test(line),
      `coordinator 越界依赖：${line}`,
    );
  }
  // 不复制 runner/scheduler/SQL 装配。
  assert.ok(!source.includes("createFirstNightRunner"));
  assert.ok(!source.includes("createFirstNightScheduler"));
  assert.ok(!source.includes("REALM_RUNTIME_DATABASE_URL"));
});

test("seam：read-model 真实调用 coordinator，归一化/调度/fail-closed 只有一份实现", () => {
  const readModel = readFileSync(
    new URL("../modules/application/local-record-read-model.ts", import.meta.url),
    "utf8",
  );
  const coordinator = readFileSync(
    new URL("../modules/application/local-record-first-night.ts", import.meta.url),
    "utf8",
  );
  // read-model 真实接线：import 并调用 coordinator。
  assert.match(readModel, /from "\.\/local-record-first-night\.ts"/);
  assert.match(readModel, /createFirstNightCoordinator\(/);
  // 旧的内部实现已移除。
  assert.ok(!readModel.includes("loadFirstNightState"), "read-model 不得保留旧 first-night 实现");
  // fail-closed warn 与 suggestions 归一化只存在于 coordinator。
  assert.ok(!readModel.includes("first night"), "read-model 不得保留 first-night warn 实现");
  assert.ok(
    !readModel.includes(".filter((item) => item.length > 0)"),
    "read-model 不得保留 suggestions trim/filter 归一化",
  );
  assert.ok(coordinator.includes(".trim()"), "coordinator 必须拥有 suggestions 归一化");
});
