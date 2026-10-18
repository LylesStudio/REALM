import assert from "node:assert/strict";
import test from "node:test";
import { normalizeGenesisDraft, sanitizeUntrustedGenesisDraft, settledGenesisView } from "../modules/application/world-genesis-contract.ts";
import { mergeDraftPatch } from "../modules/application/genesis-chat-contract.ts";

test("genesis keeps the explicit in-world player name instead of dropping it", () => {
  const draft = normalizeGenesisDraft({ world: { name: "潮港" }, playerName: "  霁川  " }, "潮港");
  assert.equal(draft?.playerName, "霁川");
  assert.equal(sanitizeUntrustedGenesisDraft({ playerName: "霁川" })?.playerName, "霁川");
  assert.equal(settledGenesisView({ playerName: "" })?.playerName, "");
});

test("scribe name patches preserve, replace and explicitly clear the role name", () => {
  const initial = { playerName: "霁川", playerRole: "领航员" };
  assert.equal(mergeDraftPatch(initial, { playerRole: "船长" })?.playerName, "霁川");
  assert.equal(mergeDraftPatch(initial, { playerName: "夜航" })?.playerName, "夜航");
  assert.equal(mergeDraftPatch(initial, { playerName: "" })?.playerName, "");
  assert.equal(mergeDraftPatch(initial, { playerName: null })?.playerName, "霁川");
});
