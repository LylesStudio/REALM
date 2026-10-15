import assert from "node:assert/strict";
import test from "node:test";
import { normalizeGenesisDraft, settledGenesisView } from "../modules/application/world-genesis-contract.ts";
import { applyGenesisFieldEdits, diffEditedGenesisFields, mergeDraftPatch, normalizeGenesisChatResponse } from "../modules/application/genesis-chat-contract.ts";
import { BLANK_FIRST_NIGHT_CONTEXT, buildFirstNightMessages, composeDeterministicOpening, fallbackFirstNightPack, normalizeFirstNightContext, normalizeFirstNightPack } from "../modules/application/first-night.ts";
import { isSuggestionsForStep, applyStepConfirm } from "../app/components/guided-genesis-steps.ts";
import { uiText } from "../modules/i18n/public.ts";

for (const phase of ["exploring", "proposing", "ready"] as const) {
  test(`opening canonical precedence and clearing: ${phase}`, () => {
    const base = normalizeGenesisDraft({ world: { name: "港" }, opening: "旧正文" })!;
    const reply = normalizeGenesisChatResponse({ reply: "提案", phase, opening: "旧兼容字段", draftPatch: { opening: "新正文" } }, base)!;
    assert.equal(mergeDraftPatch(base, reply.draftPatch)?.opening, "新正文");
    assert.equal(mergeDraftPatch(base, normalizeGenesisChatResponse({ reply: "提案", phase, draftPatch: { opening: "" }, opening: "旧兼容字段" }, base)!.draftPatch)?.opening, "");
    assert.equal(mergeDraftPatch(base, normalizeGenesisChatResponse({ reply: "提案", phase, opening: "", draftPatch: { scene: { weather: "雨" } } }, base)!.draftPatch)?.opening, "旧正文");
  });
}

test("in-flight field edits win without discarding unrelated model changes", () => {
  const base = normalizeGenesisDraft({ world: { name: "港", era: "旧时代" }, opening: "旧正文", companions: [{ name: "甲" }] })!;
  const current = { ...base, world: { ...base.world, name: "手改" }, opening: "", companions: [] };
  const merged = mergeDraftPatch(current, { world: { name: "过期", era: "新时代" }, opening: "过期正文", companions: [{ name: "乙" }], scene: { weather: "雨" } })!;
  const result = applyGenesisFieldEdits(merged, current, diffEditedGenesisFields(base, current));
  assert.equal(result.world.name, "手改");
  assert.equal(result.world.era, "新时代");
  assert.equal(result.opening, "");
  assert.deepEqual(result.companions, []);
  assert.equal(result.scene.weather, "雨");
});

test("settled prompt view retains explicit empty values and canonical enums", () => {
  const draft = normalizeGenesisDraft({ world: { name: "港" }, style: "modern", playerStance: "observer", opening: "", companions: [] })!;
  const view = settledGenesisView(draft)!;
  assert.equal(view.style, "modern");
  assert.equal(view.playerStance, "observer");
  assert.equal(view.opening, "");
  assert.deepEqual(view.companions, []);
  assert.equal((view.world as Record<string, string>).summary, "");
});

test("first-night context preserves legal long-text tails", () => {
  const summary = "景".repeat(299) + "尾";
  const title = "题".repeat(59) + "尾";
  const premise = "事".repeat(299) + "尾";
  const context = normalizeFirstNightContext({ ...BLANK_FIRST_NIGHT_CONTEXT, world: { name: "港", era: "", summary }, story: { title, premise } })!;
  assert.equal(context.world.summary, summary);
  assert.equal(context.story.title, title);
  assert.equal(context.story.premise, premise);
  const messages = buildFirstNightMessages(context);
  assert.ok(messages.user.includes(summary));
  assert.ok(messages.user.includes(premise));
});

for (const language of ["zh-CN", "en", "ja"] as const) {
  test(`first-night deterministic opening/fallback language: ${language}`, () => {
    const context = { ...BLANK_FIRST_NIGHT_CONTEXT, language, scene: { location: "Pier 7", objective: "Find the boat", weather: "Rain", tension: "Quiet" } };
    const opening = composeDeterministicOpening(context);
    assert.ok(opening.includes("Pier 7"));
    if (language === "en") assert.ok(!/[\u3400-\u9fff]/u.test(opening + fallbackFirstNightPack(context).scene.environment));
    assert.equal(composeDeterministicOpening({ ...context, opening: "原样保留。" }), "原样保留。");
    assert.notEqual(uiText("ui.genesisChat.field.language", language), "ui.genesisChat.field.language");
  });
}

test("same-named companions retain distinct stable identities", () => {
  const context = { ...BLANK_FIRST_NIGHT_CONTEXT, companions: [
    { definitionId: "definition_a", name: "阿汐", role: "船员", summary: "甲" },
    { definitionId: "definition_b", name: "阿汐", role: "向导", summary: "乙" },
  ] };
  const result = normalizeFirstNightPack({ scene: { environment: "船靠岸。" }, characters: [
    { companionId: "definition_b", name: "阿汐", utterance: "我是向导。" },
    { companionId: "definition_a", name: "阿汐", utterance: "我是船员。" },
  ], hook: { content: "绳子断了。", suggestions: ["拉住绳子", "跳上甲板"] } }, context)!;
  assert.deepEqual(result.characters.map((item) => [item.companionId, item.utterance]), [["definition_a", "我是船员。"], ["definition_b", "我是向导。"]]);
});

test("suggestion shape cannot cross from scene into review/text", () => {
  const scene = { location: ["港"], weather: ["雨"], tension: [], objective: [] };
  assert.equal(isSuggestionsForStep("scene", scene), true);
  assert.equal(isSuggestionsForStep("review", scene), false);
  assert.equal(isSuggestionsForStep("era", scene), false);
  assert.equal(isSuggestionsForStep("era", ["新时代"]), true);
});

test("optional explicit clears do not change the independent opening", () => {
  const base = normalizeGenesisDraft({ world: { name: "港", era: "旧时代" }, story: { premise: "旧前提" }, opening: "正文" })!;
  const changed = applyStepConfirm("story", base, { text: "", storyTitle: "", storyPremise: "" });
  assert.equal(changed.story.premise, "");
  assert.equal(changed.opening, "正文");
});


test("pending creation persists only its opaque key and exact-key completion clears it", async () => {
  const { readPendingGenesisRequest, savePendingGenesisRequest, clearPendingGenesisRequest } = await import("../app/pending-genesis-request.ts");
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const id = "genesis_test_pending_opaque";
  savePendingGenesisRequest(id, storage);
  assert.equal(readPendingGenesisRequest(storage), id);
  assert.deepEqual([...values.values()], [id]);
  clearPendingGenesisRequest("different_request", storage);
  assert.equal(readPendingGenesisRequest(storage), id);
  clearPendingGenesisRequest(id, storage);
  assert.equal(readPendingGenesisRequest(storage), null);
});
