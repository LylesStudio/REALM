import assert from "node:assert/strict";
import test from "node:test";
import {
  CONCISE_RATIONALE_RULE,
  NATURAL_VOICE_RULES,
  composeContext,
  contextBlock,
  jsonOutputInstruction,
  outputLanguageRule,
  stylePromptBlock,
} from "../modules/inference/prompt-kit.ts";

const CJK = /[぀-ヿ一-鿿]/;

test("prompt kit fragments are English-only static text", () => {
  for (const fragment of [NATURAL_VOICE_RULES, CONCISE_RATIONALE_RULE]) {
    assert.ok(!CJK.test(fragment), "静态片段不得含中文/日文");
  }
  for (const style of ["modern", "classical", "western_fantasy", "anime"] as const) {
    const block = stylePromptBlock(style);
    assert.ok(!CJK.test(block), `style prompt block 不得含中文/日文：${style}`);
    assert.match(block, /Tone:/);
  }
});

test("natural voice rules carry the anti-AI constraints", () => {
  assert.match(NATURAL_VOICE_RULES, /Never mention AI, models, prompts, schemas/);
  assert.match(NATURAL_VOICE_RULES, /No assistant mannerisms/);
  assert.match(NATURAL_VOICE_RULES, /Do not echo the player's wording/);
  assert.match(NATURAL_VOICE_RULES, /omit the field/i);
});

test("output language rule never enumerates fixed languages", () => {
  const rule = outputLanguageRule();
  assert.match(rule, /latest player input/i);
  assert.ok(!/Chinese|English|Japanese|中文|英文|日文/.test(rule));
  // 可用时传入实际配置语言；不可用时 fail-closed 不臆造。
  const configured = outputLanguageRule("zh-CN");
  assert.match(configured, /configured language \(zh-CN\)/);
  assert.ok(!/Chinese|English|Japanese/.test(configured));
});

test("context blocks keep dynamic data out of system messages", () => {
  const block = contextBlock("World and scene", { worldName: "烬海诸国", weather: "薄雾" });
  assert.match(block, /^\[World and scene\]\n/);
  assert.ok(block.includes("烬海诸国"), "动态值原样保留原始语言");
  const composed = composeContext([
    contextBlock("A", "x"),
    null,
    undefined,
    false,
    "",
    contextBlock("B", "y"),
  ]);
  assert.equal(composed, "[A]\nx\n\n[B]\ny");
});

test("json output instruction derives constraints from caller constants", () => {
  const instruction = jsonOutputInstruction([
    { name: "goal", kind: "string", maxLength: 320 },
    { name: "mode", kind: "enum", values: ["public", "restricted"] },
    { name: "ids", kind: "string[]", required: false, note: "audience member ids" },
  ]);
  assert.ok(!CJK.test(instruction));
  assert.match(instruction, /exactly one JSON object/);
  assert.match(instruction, /"goal": string \(<= 320 chars\)/);
  assert.match(instruction, /"mode": "public" \| "restricted"/);
  assert.match(instruction, /"ids"\?: string\[\] — audience member ids/);
});

test("json output instruction renders object arrays, nested objects and nullable fields", () => {
  const instruction = jsonOutputInstruction([
    { name: "companions", kind: "object[]", note: `{"name","role","summary"}` },
    { name: "scene", kind: "object", note: `{"location","weather"}` },
    { name: "recipientId", kind: "string", nullable: true, note: "addressee id" },
    { name: "triggerKind", kind: "enum", required: false, nullable: true, values: ["greeting"], note: "omit or null when silent" },
  ]);
  assert.ok(!CJK.test(instruction));
  assert.match(instruction, /"companions": array of objects — \{"name","role","summary"\}/);
  assert.match(instruction, /"scene": object — \{"location","weather"\}/);
  assert.match(instruction, /"recipientId": string or null — addressee id/);
  assert.match(instruction, /"triggerKind"\?: "greeting" or null — omit or null when silent/);
});
