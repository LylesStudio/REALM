import assert from "node:assert/strict";
import test from "node:test";
import { extractExplicitCharacterProfileUpdate } from "../modules/application/character-profile.ts";

const character = { characterInstanceId: "char_player" };

test("explicit player identity updates the current Record profile", () => {
  assert.deepEqual(
    extractExplicitCharacterProfileUpdate("我就是这艘船的船长。", character),
    {
      characterInstanceId: "char_player",
      identity: "船长",
      profileSummary: "当前身份：船长",
      evidence: "我就是这艘船的船长。",
    },
  );
  assert.equal(
    extractExplicitCharacterProfileUpdate("I am the captain.", character)?.identity,
    "captain",
  );
});

test("identity wishes and negations do not mutate the profile", () => {
  assert.equal(
    extractExplicitCharacterProfileUpdate("我想成为船长。", character),
    null,
  );
  assert.equal(
    extractExplicitCharacterProfileUpdate("我不是船长。", character),
    null,
  );
  assert.equal(
    extractExplicitCharacterProfileUpdate("I am not the captain.", character),
    null,
  );
});
