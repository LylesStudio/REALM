/**
 * 批次 L——生成中暂存位与骰点揭示的契约测试。
 * 纯逻辑：DiceRevealTracker 一次性语义与 reduced-motion/未提交分流；
 * 源码静态契约（与 semantic-review-ui-contract 同型）：暂存位只在
 * sendMessage 生命周期内存在、所有出口清空；骰点行保留数据属性、
 * 不重算不随机、一次性 tracker 接线。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createDiceRevealTracker,
  resolveDiceRevealPhase,
} from "../app/components/dice-reveal.ts";

test("dice reveal tracker reveals each event id exactly once", () => {
  const tracker = createDiceRevealTracker();
  assert.equal(tracker.claim("event-1"), true, "首次应播放揭示");
  assert.equal(tracker.claim("event-1"), false, "同 id 重放不重播");
  assert.equal(tracker.claim("event-1"), false, "SSE 重放/轮询后仍不重播");
  assert.equal(tracker.has("event-1"), true);
  assert.equal(tracker.has("event-2"), false, "has 只读不登记");
  assert.equal(tracker.claim("event-2"), true, "不同事件各自独立");
});

test("dice reveal phase honors committed state and reduced motion", () => {
  const tracker = createDiceRevealTracker();
  // 非 committed（pending 事件）不出现滚动态。
  assert.equal(
    resolveDiceRevealPhase({
      tracker,
      eventId: "e-pending",
      committed: false,
      reducedMotion: false,
    }),
    "revealed",
  );
  // reduced-motion：直接给结果。
  assert.equal(
    resolveDiceRevealPhase({
      tracker,
      eventId: "e-reduced",
      committed: true,
      reducedMotion: true,
    }),
    "revealed",
  );
  // 正常路径：首次 rolling，重放直接 revealed。
  assert.equal(
    resolveDiceRevealPhase({
      tracker,
      eventId: "e-live",
      committed: true,
      reducedMotion: false,
    }),
    "rolling",
  );
  assert.equal(
    resolveDiceRevealPhase({
      tracker,
      eventId: "e-live",
      committed: true,
      reducedMotion: false,
    }),
    "revealed",
  );
});

test("pending submission slot lives only inside the send lifecycle", () => {
  const source = readFileSync("app/realm-client.tsx", "utf8");
  // 进入 sendMessage 即建立暂存（携带原文与用户消息 id）。
  assert.match(source, /setPendingSubmission\(\{ id: clientMessageId, content \}\)/);
  // finally 中统一清空——成功/428/409/失败所有出口都不残留。
  assert.match(source, /finally \{[\s\S]*?setPendingSubmission\(null\)/);
  // 暂存位是独立组件而非时间线事件：不向 events 数组注入伪造条目。
  const component = readFileSync("app/components/pending-submission.tsx", "utf8");
  assert.match(component, /role="status"/);
  assert.match(component, /ui\.composer\.pending/);
  assert.doesNotMatch(component, /createOptimisticEvent|events:/);
});

test("dice line keeps server values and data attributes; no recompute or randomness", () => {
  const source = readFileSync("app/components/event-timeline.tsx", "utf8");
  // 一次性 tracker 接线 + reduced-motion 感知。
  assert.match(source, /createDiceRevealTracker\(\)/);
  assert.match(source, /resolveDiceRevealPhase\(/);
  assert.match(source, /prefers-reduced-motion/);
  // 数据属性在滚动与揭示两态都保留（测试/读屏可定位）。
  assert.equal(source.match(/data-dice-system=/g)?.length, 2);
  assert.equal(source.match(/data-dice-outcome=/g)?.length, 2);
  // 揭示态带 role="status"；全文仍由 describeDice 输出服务端值。
  assert.match(source, /role="status"/);
  assert.match(source, /describeDice\(dice, uiLanguage\)/);
  // 骰点路径零随机零重算。
  assert.doesNotMatch(source, /Math\.random/);
});
