import assert from "node:assert/strict";
import test from "node:test";
import { normalizeGenesisDraft } from "../modules/application/world-genesis-contract.ts";
import {
  PRESET_WORLD_KEYS,
  getPresetWorld,
  listPresetWorlds,
} from "../modules/application/preset-worlds.ts";

test("listPresetWorlds exposes the three playable presets", () => {
  const presets = listPresetWorlds();
  assert.deepEqual(
    presets.map((preset) => preset.key).sort(),
    ["anime-hero", "dnd-tavern", "urban-cultivation"].sort(),
  );
});

test("each preset key resolves to a defined world", () => {
  for (const key of PRESET_WORLD_KEYS) {
    const preset = getPresetWorld(key);
    assert.ok(preset, `preset ${key} should exist`);
    assert.ok(preset.titleKey.length > 0);
    assert.ok(preset.descriptionKey.length > 0);
    assert.ok(preset.tagKey.length > 0);
  }
});

test("each preset draft passes genesis normalization", () => {
  for (const preset of listPresetWorlds()) {
    const draft = normalizeGenesisDraft(preset.draft);
    assert.ok(draft, `preset ${preset.key} draft should normalize successfully`);
    assert.ok(draft.world.name.length > 0, `preset ${preset.key} world name required`);
    assert.ok(
      ["modern", "classical", "western_fantasy", "anime"].includes(draft.style),
      `preset ${preset.key} style must be a known world style`,
    );
    assert.ok(draft.story.title.length > 0, `preset ${preset.key} story title required`);
    assert.ok(draft.record.title.length > 0, `preset ${preset.key} record title required`);
    assert.ok(draft.opening.length > 0, `preset ${preset.key} opening required`);
    assert.ok(draft.companions.length <= 2, `preset ${preset.key} has at most two companions`);
  }
});
