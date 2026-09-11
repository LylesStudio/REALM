import assert from "node:assert/strict";
import test from "node:test";
import {
  splitReadableSentences,
  streamSemanticSegments,
} from "../modules/streaming/semantic-stream.ts";
import {
  classifyWorldlineConflict,
} from "../modules/worldline/branching.ts";

test("semantic streaming emits complete short sentences and honors cancellation", async () => {
  const chunks = [];
  for await (const chunk of streamSemanticSegments([
    { id: "a", kind: "action", content: "她抬头看向灯塔。浓雾仍在。", speechMode: "narrator" },
  ])) {
    chunks.push(chunk);
  }
  assert.deepEqual(chunks.map((chunk) => chunk.content), ["她抬头看向灯塔。", "浓雾仍在。"]);
  assert.equal(chunks.at(-1)?.done, true);

  const controller = new AbortController();
  controller.abort();
  const cancelled = [];
  for await (const chunk of streamSemanticSegments([
    { id: "a", kind: "action", content: "不应出现。", speechMode: "narrator" },
  ], controller.signal)) {
    cancelled.push(chunk);
  }
  assert.equal(cancelled.length, 0);
});

test("readable sentence splitting keeps original punctuation boundaries", () => {
  assert.deepEqual(splitReadableSentences("第一句。第二句！第三句？"), [
    "第一句。",
    "第二句！",
    "第三句？",
  ]);
});

test("worldline conflict detection recommends branching for earlier hard changes", () => {
  const hard = classifyWorldlineConflict({
    pastChange: { tick: 10, ordinal: 1, calendarId: "c", display: "过去" },
    existingFuture: { tick: 20, ordinal: 1, calendarId: "c", display: "未来" },
    hardCausalAnchors: ["future_character"],
  });
  assert.equal(hard.conflict, "hard");
  assert.equal(hard.shouldBranch, true);

  const late = classifyWorldlineConflict({
    pastChange: { tick: 30, ordinal: 1, calendarId: "c", display: "之后" },
    existingFuture: { tick: 20, ordinal: 1, calendarId: "c", display: "之前" },
  });
  assert.equal(late.conflict, "none");
  assert.equal(late.shouldBranch, false);
});
