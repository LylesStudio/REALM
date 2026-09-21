/**
 * 批次 T7 世界自演——Core 纯函数契约（docs/development/T7-OBSERVATION-VISION.md §4.1）。
 * 覆盖：状态规整 fail-closed、终态/活动态判定、预算钳制（默认 3、硬上限 5）、
 * 三语引导语与未知语言回落。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  SELF_PLAY_BEAT_BUDGET,
  SELF_PLAY_BEAT_HARD_CAP,
  clampSelfPlayBeatBudget,
  isSelfPlayActive,
  isSelfPlayTerminal,
  normalizeSelfPlayState,
  selfPlayInstruction,
  selfPlaySessionNeedsBeats,
  type SelfPlaySession,
} from "../modules/application/self-play.ts";

test("self-play state normalization accepts only the five documented states", () => {
  for (const state of ["running", "stopping", "completed", "failed", "cancelled"]) {
    assert.equal(normalizeSelfPlayState(state), state);
  }
  for (const bad of ["", "RUNNING", "pending", "deleted", null, undefined, 3]) {
    assert.equal(normalizeSelfPlayState(bad), null);
  }
});

test("terminal and active sets are disjoint and cover every state", () => {
  assert.equal(isSelfPlayTerminal("completed"), true);
  assert.equal(isSelfPlayTerminal("failed"), true);
  assert.equal(isSelfPlayTerminal("cancelled"), true);
  assert.equal(isSelfPlayTerminal("running"), false);
  assert.equal(isSelfPlayTerminal("stopping"), false);
  assert.equal(isSelfPlayActive("running"), true);
  assert.equal(isSelfPlayActive("stopping"), true);
  assert.equal(isSelfPlayActive("completed"), false);
  assert.equal(isSelfPlayActive("failed"), false);
  assert.equal(isSelfPlayActive("cancelled"), false);
});

test("beat budget clamps to [0, hard cap] with the documented default", () => {
  assert.equal(SELF_PLAY_BEAT_BUDGET, 3);
  assert.equal(SELF_PLAY_BEAT_HARD_CAP, 5);
  assert.equal(clampSelfPlayBeatBudget(undefined), 3);
  assert.equal(clampSelfPlayBeatBudget(2), 2);
  assert.equal(clampSelfPlayBeatBudget(0), 0);
  assert.equal(clampSelfPlayBeatBudget(-4), 0);
  assert.equal(clampSelfPlayBeatBudget(99), 5);
  assert.equal(clampSelfPlayBeatBudget(2.9), 2);
  assert.equal(clampSelfPlayBeatBudget(Number.NaN), 3);
  assert.equal(clampSelfPlayBeatBudget("9"), 3);
});

function session(partial: Partial<SelfPlaySession>): SelfPlaySession {
  return {
    id: "selfplay_x",
    recordId: "record_x",
    worldId: "world_x",
    state: "running",
    beatBudget: 3,
    beatsCompleted: 0,
    requestedBy: "principal_x",
    lastError: null,
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
    ...partial,
  };
}

test("a session needs beats only while active and under budget", () => {
  assert.equal(selfPlaySessionNeedsBeats(session({})), true);
  assert.equal(selfPlaySessionNeedsBeats(session({ state: "stopping" })), true);
  assert.equal(
    selfPlaySessionNeedsBeats(session({ beatsCompleted: 3 })),
    false,
  );
  assert.equal(
    selfPlaySessionNeedsBeats(session({ state: "completed", beatsCompleted: 1 })),
    false,
  );
  assert.equal(
    selfPlaySessionNeedsBeats(session({ beatBudget: 0 })),
    false,
  );
});

test("self-play instruction ships three languages and falls back to zh-CN", () => {
  const zh = selfPlayInstruction("zh-CN");
  const en = selfPlayInstruction("en");
  const ja = selfPlayInstruction("ja");
  assert.ok(zh.includes("没有玩家输入"));
  assert.ok(en.includes("No player input"));
  assert.ok(ja.includes("プレイヤー入力"));
  assert.notEqual(zh, en);
  assert.notEqual(en, ja);
  // 未知/缺失语言 fail-closed 回落 zh-CN，绝不暴露裸 key 或空串。
  assert.equal(selfPlayInstruction("fr"), zh);
  assert.equal(selfPlayInstruction(""), zh);
});
