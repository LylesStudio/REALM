import assert from "node:assert/strict";
import test from "node:test";
import {
  MEMORY_PREFETCH_TOKEN_BUDGET,
  estimateMemoryTokens,
  formatMemoryPrefetchLines,
} from "../modules/memory/public.ts";
import { createMemoryPrefetchHub } from "../modules/memory/pipeline.ts";
import { createSceneCrystallizer } from "../modules/application/scene-crystallization.ts";
import type { SceneStateSnapshot } from "../modules/application/scene-crystallization.ts";
import type {
  ModelChatResponse,
  ModelGateway,
} from "../modules/inference/types.ts";

/**
 * Cleanup Phase 4 / Batch 2C：context/token 总预算与晶化上下文去重。
 * A. prefetch formatter：预算、顺序、前缀、空值、超长截断、生产装配（hub）。
 * B. extraction canonical 表示：同一事件只出现一次、结构保留、fallback 语义。
 */

const CJK_LINE = "潮声沿着防波堤一遍遍拍上灯塔的旧石阶，守塔人没有再回来。"; // 30 CJK chars ≈ 30 tokens

function longLine(chars: number): string {
  return "灯".repeat(chars);
}

test("prefetch formatter respects the budget and keeps recall order and prefixes", () => {
  const lines = [
    "第一条记忆：守塔人离开前修好了雾灯。",
    "第二条记忆：库房的锁已经坏了。",
    "第三条记忆：阿葵不喜欢海潮声。",
    "第四条记忆：灯塔顶的栏杆松动了。",
  ];
  const result = formatMemoryPrefetchLines(lines);
  assert.ok(estimateMemoryTokens(result) <= MEMORY_PREFETCH_TOKEN_BUDGET);
  const keptLines = result.split("\n");
  assert.deepEqual(
    keptLines.slice(0, 3).map((line) => line.slice(0, 3)),
    ["- 第", "- 第", "- 第"],
    "kept lines keep recall order and the `- ` prefix",
  );
  assert.ok(keptLines[0]!.startsWith("- 第一条"));
  assert.ok(keptLines[1]!.startsWith("- 第二条"));
});

test("prefetch formatter stays within budget for long CJK memories and truncates with ellipsis", () => {
  const lines = Array.from({ length: 6 }, () => longLine(100));
  const result = formatMemoryPrefetchLines(lines);
  assert.ok(
    estimateMemoryTokens(result) <= MEMORY_PREFETCH_TOKEN_BUDGET,
    `over-budget content must be clipped (got ${estimateMemoryTokens(result)} tokens)`,
  );
  assert.ok(result.includes("…"), "a truncated tail line ends with an ellipsis");
  assert.ok(result.split("\n")[0]!.startsWith("- "));
});

test("prefetch formatter is stable for empty, zero-budget and single overlong inputs", () => {
  assert.equal(formatMemoryPrefetchLines([]), "");
  assert.equal(formatMemoryPrefetchLines([CJK_LINE], 0), "");
  const single = formatMemoryPrefetchLines([longLine(500)]);
  assert.ok(single.startsWith("- "));
  assert.ok(single.endsWith("…"));
  assert.ok(estimateMemoryTokens(single) <= MEMORY_PREFETCH_TOKEN_BUDGET);
  const unbounded = formatMemoryPrefetchLines([CJK_LINE], Number.POSITIVE_INFINITY);
  assert.equal(unbounded, `- ${CJK_LINE}`);
});

test("production prefetch assembly (hub + formatter) clips injected memory to the budget", async () => {
  const hub = createMemoryPrefetchHub({
    recall: async () =>
      formatMemoryPrefetchLines(
        Array.from({ length: 6 }, () => longLine(100)),
      ),
  });
  const handle = hub.begin({
    workspaceId: "ws",
    worldId: "world",
    worldlineId: "wl",
    recordId: "record",
    playerText: "你醒了吗？",
    characters: [{ characterInstanceId: "ci-1" }],
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const injected = hub.consume(handle.recordId, "ci-1");
  assert.ok(injected.startsWith("- "));
  assert.ok(
    estimateMemoryTokens(injected) <= MEMORY_PREFETCH_TOKEN_BUDGET,
    "injected representation must respect the shared budget",
  );
  hub.end(handle);
});

const CURRENT: SceneStateSnapshot = {
  worldName: "灯塔港",
  era: "潮声纪元",
  displayTime: "潮声纪元 第三夜",
  location: "灯塔下",
  weather: "浓雾",
  tension: "低",
  objective: "点亮主灯",
};

const DISTINCTIVE = "海鸥撞上了灯塔的玻璃";

function jsonResponse(value: unknown): ModelChatResponse {
  return {
    model: "fake-model",
    content: JSON.stringify(value),
    toolCalls: [],
    finishReason: "stop",
    usage: null,
  };
}

function capturingGateway(capture: { user?: string }): ModelGateway {
  return {
    async discoverModels() {
      return [];
    },
    async chat(request) {
      capture.user = request.messages[1]?.content ?? "";
      return jsonResponse({ location: "灯塔顶", worldClaims: [], characterNotes: [] });
    },
  };
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

test("extraction carries each public event exactly once with structured speaker/recipient", async () => {
  const capture: { user?: string } = {};
  const crystallizer = createSceneCrystallizer({
    getGateway: async () => capturingGateway(capture),
  });
  const result = await crystallizer.extract({
    playerText: "我去看看。",
    // 旧调用方若仍同时给两份，canonical 也只渲染结构化块（不重复）。
    turnSummary: `旁白：${DISTINCTIVE}`,
    current: CURRENT,
    recentDialogue: [
      {
        speaker: "旁白",
        speakerParticipantId: null,
        recipientId: null,
        text: DISTINCTIVE,
      },
      {
        speaker: "阿葵",
        speakerParticipantId: "participant-a",
        recipientId: "participant-b",
        text: "先把窗户关上。",
      },
    ],
    participants: [
      { characterInstanceId: "ci-1", participantId: "participant-a", displayName: "阿葵", profileSummary: "灯塔医师" },
    ],
  });
  assert.ok(result);
  const user = capture.user ?? "";
  assert.equal(
    countOccurrences(user, DISTINCTIVE),
    1,
    "the same public event must appear exactly once in the extraction request",
  );
  assert.ok(user.includes("speakerParticipantId"), "speaker structure is preserved");
  assert.ok(user.includes("participant-b"), "recipient structure is preserved");
  assert.ok(
    !user.includes("[This turn's narration]"),
    "no duplicate narration block when structured dialogue is present",
  );
});

test("extraction falls back to the narration block only when no dialogue lines exist", async () => {
  const capture: { user?: string } = {};
  const crystallizer = createSceneCrystallizer({
    getGateway: async () => capturingGateway(capture),
  });
  await crystallizer.extract({
    playerText: "我去看看。",
    turnSummary: `旁白：${DISTINCTIVE}`,
    current: CURRENT,
  });
  const user = capture.user ?? "";
  assert.ok(user.includes("[This turn's narration]"));
  assert.equal(countOccurrences(user, DISTINCTIVE), 1);

  const captureEmpty: { user?: string } = {};
  const crystallizerEmpty = createSceneCrystallizer({
    getGateway: async () => capturingGateway(captureEmpty),
  });
  await crystallizerEmpty.extract({
    playerText: "我去看看。",
    turnSummary: `旁白：${DISTINCTIVE}`,
    current: CURRENT,
    recentDialogue: [],
  });
  assert.ok((captureEmpty.user ?? "").includes("[This turn's narration]"));
  assert.equal(countOccurrences(captureEmpty.user ?? "", DISTINCTIVE), 1);
});
