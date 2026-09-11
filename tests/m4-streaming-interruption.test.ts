import assert from "node:assert/strict";
import test from "node:test";
import {
  PreviewSessionError,
  createPreviewSession,
} from "../modules/streaming/preview-session.ts";
import { createJsonFieldPreviewExtractor } from "../modules/streaming/json-preview.ts";
import { generateWithToolPause } from "../modules/streaming/tool-pause.ts";
import {
  TurnControlError,
  createTurnControl,
} from "../modules/runtime/turn-control.ts";
import {
  CandidateRaceError,
  raceCandidates,
} from "../modules/orchestration/parallel-candidates.ts";
import { createRuleBasedInterjectionPolicy } from "../modules/orchestration/interjection.ts";
import type { ActivatedCharacter } from "../modules/orchestration/public.ts";
import {
  createLocalPreviewHub,
  type LocalPreviewEvent,
} from "../modules/application/local-record-service.ts";

function character(id: string, name: string): ActivatedCharacter {
  return {
    characterInstanceId: id,
    participantId: `participant_${id}`,
    displayName: name,
  } as ActivatedCharacter;
}

test("preview session only releases content through complete()", () => {
  const session = createPreviewSession({ id: "p1" });
  session.push("雾");
  session.push("沿着石阶。");
  assert.equal(session.partialText, "雾沿着石阶。");
  assert.equal(session.complete(), "雾沿着石阶。");
  assert.equal(session.readCommitted(), "雾沿着石阶。");
  assert.throws(() => session.push("再写"), PreviewSessionError);
  assert.throws(() => session.abort(), PreviewSessionError);
});

test("aborted preview discards content and refuses reads", () => {
  const session = createPreviewSession({ id: "p2" });
  session.push("未提交的内容");
  session.abort("user");
  assert.equal(session.state, "aborted");
  assert.throws(() => session.partialText, PreviewSessionError);
  assert.throws(() => session.readCommitted(), PreviewSessionError);
  assert.throws(() => session.complete(), PreviewSessionError);
});

test("external abort signal aborts the preview session", () => {
  const controller = new AbortController();
  const session = createPreviewSession({ id: "p3", signal: controller.signal });
  session.push("半句");
  controller.abort();
  assert.equal(session.state, "aborted");
  assert.equal(session.abortReason, "external");
});

test("json field extractor turns streamed JSON into readable deltas", () => {
  const extract = createJsonFieldPreviewExtractor(["action", "dialogue"]);
  const chunks = ['{"act', 'ion":"塞娜抬', '起手","dial', 'ogue":"“停', '下。”"}'];
  const deltas = chunks.map((chunk) => extract(chunk)).filter(Boolean);
  assert.deepEqual(deltas, ["塞娜抬", "起手", "“停", "下。”"]);
});

test("tool pause keeps event order chunks → pause → resolved → chunks", async () => {
  const result = await generateWithToolPause({
    async first(emit) {
      emit("我点亮信号灯");
      return { toolRequest: { name: "use_asset" } };
    },
    async runTool(tool) {
      assert.equal(tool, "use_asset");
      return { balance: 1 };
    },
    async continue_(toolResult, emit) {
      assert.deepEqual(toolResult, { balance: 1 });
      emit("，灯光照亮雾幕。");
    },
  });
  assert.equal(result.committed, true);
  assert.equal(result.content, "我点亮信号灯，灯光照亮雾幕。");
  assert.deepEqual(
    result.events.map((event) => event.kind),
    ["chunk", "tool.pause", "tool.resolved", "chunk"],
  );
});

test("tool pause cancellation leaves the generation uncommitted", async () => {
  const controller = new AbortController();
  const result = await generateWithToolPause({
    async first(emit) {
      emit("半句");
      controller.abort();
      return { toolRequest: { name: "use_asset" } };
    },
    async runTool() {
      throw new Error("must not run after abort");
    },
    async continue_() {},
    signal: controller.signal,
  });
  assert.equal(result.committed, false);
  assert.equal(result.content, "");
});

test("parallel candidates: first accepted wins and losers are aborted", async () => {
  const flags = { slow: false, rejected: false };
  const { winner, winnerIndex } = await raceCandidates([
    async (signal) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      if (signal.aborted) flags.slow = true;
      return "slow";
    },
    async () => "rejected",
    async (signal) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (signal.aborted) flags.rejected = true;
      return "accepted";
    },
  ], (candidate) => candidate === "accepted");
  assert.equal(winner, "accepted");
  assert.equal(winnerIndex, 2);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(flags.slow, true);
});

test("parallel candidates throw when nothing is accepted", async () => {
  await assert.rejects(
    raceCandidates([async () => "a", async () => "b"], () => false),
    CandidateRaceError,
  );
});

test("turn control lease serializes holders FIFO per record", async () => {
  const control = createTurnControl({ cooldownMs: 1000 });
  const order: string[] = [];
  const first = await control.acquire("record", "player");
  const secondPromise = control.acquire("record", "塞娜")
    .then((lease) => {
      order.push("塞娜");
      lease.release();
    });
  const thirdPromise = control.acquire("record", "弥洛")
    .then((lease) => {
      order.push("弥洛");
      lease.release();
    });
  assert.equal(control.isFree("record"), false);
  assert.equal(control.queuedCount("record"), 2);
  order.push("player");
  first.release();
  await Promise.all([secondPromise, thirdPromise]);
  assert.deepEqual(order, ["player", "塞娜", "弥洛"]);
  assert.equal(control.isFree("record"), true);
  // 同一持有者重复获取报错；重复释放是安全无操作。
  const held = await control.acquire("record", "player");
  await assert.rejects(
    async () => control.acquire("record", "player"),
    TurnControlError,
  );
  held.release();
  held.release();
  assert.equal(control.isFree("record"), true);
});

test("interjection policy enforces silence bias, budget, cooldown and lease", async () => {
  let now = 0;
  const control = createTurnControl({ now: () => now, cooldownMs: 1000 });
  const policy = createRuleBasedInterjectionPolicy({ turnControl: control });
  const sena = character("char_inst_scout", "塞娜");
  const milo = character("char_inst_scholar", "弥洛");
  const available = [sena, milo];

  // 未点名：沉默。
  assert.equal(
    policy.evaluate({
      recordId: "r",
      playerText: "我环顾四周。",
      activatedCharacters: [],
      availableCharacters: available,
    }).kind,
    "silent",
  );
  // 点名且未激活：插话。
  const decision = policy.evaluate({
    recordId: "r",
    playerText: "弥洛，你怎么看这段铭文？",
    activatedCharacters: [sena],
    availableCharacters: available,
  });
  assert.equal(decision.kind, "interject");
  // 点名但已激活：不重复插话。
  assert.equal(
    policy.evaluate({
      recordId: "r",
      playerText: "弥洛，你怎么看？",
      activatedCharacters: [milo],
      availableCharacters: available,
    }).kind,
    "silent",
  );
  // 冷却期内：沉默。
  control.recordInterjection("char_inst_scholar");
  assert.equal(
    policy.evaluate({
      recordId: "r",
      playerText: "弥洛，你怎么看？",
      activatedCharacters: [sena],
      availableCharacters: available,
    }).kind,
    "silent",
  );
  // 冷却结束：恢复可插话。
  now += 1001;
  assert.equal(
    policy.evaluate({
      recordId: "r",
      playerText: "弥洛，你怎么看？",
      activatedCharacters: [sena],
      availableCharacters: available,
    }).kind,
    "interject",
  );
  // 发言权被占用：沉默。
  const lease = await control.acquire("r", "player");
  assert.equal(
    policy.evaluate({
      recordId: "r",
      playerText: "弥洛，你怎么看？",
      activatedCharacters: [sena],
      availableCharacters: available,
    }).kind,
    "silent",
  );
  lease.release();
});

test("preview hub drops chunks after abort and always delivers end", () => {
  const hub = createLocalPreviewHub();
  const events: LocalPreviewEvent[] = [];
  hub.subscribe("record", (event) => events.push(event));
  const controller = new AbortController();
  hub.begin("record", "p1", controller.signal);
  hub.publishChunk("record", "塞娜", "第一句");
  controller.abort();
  hub.publishChunk("record", "塞娜", "被打断的半句");
  hub.end("record", "aborted");
  assert.deepEqual(
    events.map((event) => event.kind),
    ["chunk", "end"],
  );
  assert.equal(events[0]?.kind === "chunk" ? events[0].content : "", "第一句");
  assert.equal(events[1]?.kind === "end" ? events[1].outcome : "", "aborted");
});
