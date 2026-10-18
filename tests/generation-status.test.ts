import assert from "node:assert/strict";
import test from "node:test";
import { createGenerationStatusHub, trackGeneration, type GenerationActivity } from "../modules/streaming/generation-status.ts";

test("generation is visible before the first token and remains busy until all concurrent work finishes", () => {
  const hub = createGenerationStatusHub();
  const finishA = hub.begin("r", { phase: "character", speaker: "霁川" }, { kind: "public" });
  const finishB = hub.begin("r", { phase: "narrator" }, { kind: "public" });
  assert.equal(hub.read("r").busy, true);
  assert.deepEqual(hub.read("r").activities, [{ phase: "character", speaker: "霁川" }, { phase: "narrator" }]);
  finishA(); finishA();
  assert.deepEqual(hub.read("r").activities, [{ phase: "narrator" }]);
  finishB();
  assert.deepEqual(hub.read("r"), { busy: false, activities: [] });
});

test("restricted work only reveals a generic busy signal outside its audience, never names or phases", () => {
  const hub = createGenerationStatusHub();
  const done = hub.begin("r", { phase: "character", speaker: "秘密身份" }, { kind: "restricted", domainId: "secret", audienceCharacterInstanceIds: ["inside"] });
  assert.deepEqual(hub.read("r", "inside").activities, [{ phase: "character", speaker: "秘密身份" }]);
  assert.deepEqual(hub.read("r", "outside"), { busy: true, activities: [] });
  assert.deepEqual(hub.read("r"), { busy: true, activities: [] });
  assert.deepEqual(hub.read("other"), { busy: false, activities: [] });
  done();
});

test("tracked model stages clean up after success, cancellation and exceptions", async () => {
  const hub = createGenerationStatusHub();
  const sink = (activity: GenerationActivity) => hub.begin("r", activity, { kind: "public" });
  await assert.rejects(trackGeneration(sink, { phase: "reviewer" }, async () => { throw new Error("provider unavailable"); }));
  assert.equal(hub.read("r").busy, false);
  const controller = new AbortController();
  const done = hub.begin("r", { phase: "planner" }, { kind: "public" }, controller.signal);
  controller.abort();
  done();
  assert.equal(hub.read("r").busy, false);
  assert.equal(await trackGeneration(sink, { phase: "reviewer" }, async () => 42), 42);
});
