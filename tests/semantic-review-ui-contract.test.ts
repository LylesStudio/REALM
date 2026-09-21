/**
 * 批次 T11-D——semantic review 操作面 UI/静态契约
 * （docs/development/T11-D-SEMANTIC-REVIEW-OPERATOR-SURFACE.md §五.2）。
 * 纯函数层：三种 change kind 的 payload 形态、context 游标来源、结果白名单、
 * 错误码映射；静态层：面板不渲染内部 evidence 字段、无自动 merge、
 * 无轮询/自动 POST。全程不依赖真实模型输出。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildSemanticReviewChange,
  normalizeSemanticReviewContext,
  normalizeSemanticReviewOutcome,
  semanticReviewErrorKey,
} from "../app/components/semantic-review-types.ts";

const CURSOR = { tick: 41, ordinal: 7, calendarId: "native", display: "" };
const CLAIM = {
  id: "claim_1",
  subjectEntityId: "entity_milo",
  predicate: "状态",
  objectValue: "存活",
};

test("assert change keeps subject/predicate and edits object, no targetClaimId", () => {
  const change = buildSemanticReviewChange({
    kind: "assert",
    claim: CLAIM,
    objectValue: "失踪",
    cursor: CURSOR,
  });
  assert.deepEqual(change, {
    kind: "assert",
    subjectEntityId: "entity_milo",
    predicate: "状态",
    objectValue: "失踪",
    effectiveCursor: CURSOR,
  });
  assert.ok(!("targetClaimId" in change!), "assert 不携带 targetClaimId");
});

test("terminate change targets the current claim and carries no new value", () => {
  const change = buildSemanticReviewChange({
    kind: "terminate",
    claim: CLAIM,
    objectValue: "",
    cursor: CURSOR,
  });
  assert.deepEqual(change, {
    kind: "terminate",
    subjectEntityId: "entity_milo",
    predicate: "状态",
    objectValue: "",
    targetClaimId: "claim_1",
    effectiveCursor: CURSOR,
  });
});

test("supersede change targets the current claim with an edited object", () => {
  const change = buildSemanticReviewChange({
    kind: "supersede",
    claim: CLAIM,
    objectValue: "死亡",
    cursor: CURSOR,
  });
  assert.deepEqual(change, {
    kind: "supersede",
    subjectEntityId: "entity_milo",
    predicate: "状态",
    objectValue: "死亡",
    targetClaimId: "claim_1",
    effectiveCursor: CURSOR,
  });
});

test("change builder fails closed and never invents subject/predicate/value", () => {
  for (const input of [
    { kind: "assert" as const, claim: { ...CLAIM, predicate: "  " }, objectValue: "x", cursor: CURSOR },
    { kind: "assert" as const, claim: CLAIM, objectValue: "   ", cursor: CURSOR },
    { kind: "supersede" as const, claim: CLAIM, objectValue: "", cursor: CURSOR },
  ]) {
    assert.equal(buildSemanticReviewChange(input), null);
  }
});

test("context cursor comes from the server response, fail-closed otherwise", () => {
  const context = normalizeSemanticReviewContext({
    ok: true,
    scope: { worldId: "world_1", worldlineId: "wl_1" },
    existingFuture: CURSOR,
  });
  assert.deepEqual(context, {
    worldId: "world_1",
    worldlineId: "wl_1",
    existingFuture: CURSOR,
  });
  // 客户端注入/畸形载荷一律 null——没有游标就不能提交。
  for (const bad of [
    null,
    { ok: false },
    { ok: true, scope: { worldId: "w" } },
    { ok: true, scope: { worldId: "w", worldlineId: "l" }, existingFuture: { tick: "x" } },
    { ok: true, scope: { worldId: "w", worldlineId: "l" }, existingFuture: { tick: 1.5, ordinal: 0 } },
  ]) {
    assert.equal(normalizeSemanticReviewContext(bad), null);
  }
});

test("deterministic none/hard outcome shows classification and reason only", () => {
  const outcome = normalizeSemanticReviewOutcome({
    ok: true,
    mode: "semantic",
    scope: { worldId: "w", worldlineId: "l" },
    deterministic: {
      classification: { conflict: "hard", reason: "确定性生死矛盾。", shouldBranch: true },
      deterministic: [],
      dependency: [],
      algorithm: "realm-causal-conflict/v1",
    },
    semantic: null,
  });
  assert.deepEqual(outcome, {
    classification: "hard",
    recommendation: null,
    rationale: "确定性生死矛盾。",
    source: null,
  });
});

test("semantic outcome keeps only whitelisted display fields", () => {
  const outcome = normalizeSemanticReviewOutcome({
    ok: true,
    mode: "semantic",
    scope: { worldId: "w", worldlineId: "l" },
    deterministic: {
      classification: { conflict: "high-risk", reason: "无法确定。", shouldBranch: true },
      deterministic: [],
      dependency: [],
      algorithm: "realm-causal-conflict/v1",
    },
    semantic: {
      source: "fallback",
      model: "none",
      promptVersion: "semantic-conflict-v1",
      inputDigest: "deadbeef",
      requestId: "sr_internal",
      result: {
        kind: "other",
        severity: "high-risk",
        recommendation: "branch",
        rationale: "模型不可用，回落确定性结论。",
      },
    },
  });
  assert.deepEqual(outcome, {
    classification: "high-risk",
    recommendation: "branch",
    rationale: "模型不可用，回落确定性结论。",
    source: "fallback",
  });
  // 白名单断言：输出形态不可能携带 prompt/inputDigest/requestId。
  assert.deepEqual(
    Object.keys(outcome!).sort(),
    ["classification", "rationale", "recommendation", "source"],
  );
  assert.equal(JSON.stringify(outcome).includes("deadbeef"), false);
  assert.equal(JSON.stringify(outcome).includes("sr_internal"), false);
});

test("malformed semantic responses fail closed to null", () => {
  for (const bad of [
    null,
    { ok: false },
    { ok: true, deterministic: { classification: { conflict: "chaos" } }, semantic: null },
    {
      ok: true,
      deterministic: { classification: { conflict: "high-risk", reason: "r" } },
      semantic: { source: "fallback", result: { severity: "high-risk" } },
    },
  ]) {
    assert.equal(normalizeSemanticReviewOutcome(bad), null);
  }
});

test("error mapping: 409 busy is retryable, 503 is a stable unavailable notice", () => {
  assert.equal(semanticReviewErrorKey(409, "SEMANTIC_REVIEW_BUSY"), "ui.semanticReview.errBusy");
  assert.equal(semanticReviewErrorKey(503, "SEMANTIC_REVIEW_UNAVAILABLE"), "ui.semanticReview.errUnavailable");
  assert.equal(semanticReviewErrorKey(503, "LOCAL_RUNTIME_NOT_INITIALIZED"), "ui.semanticReview.errUnavailable");
  assert.equal(semanticReviewErrorKey(404, "WORLD_NOT_FOUND"), "ui.semanticReview.errNotFound");
  assert.equal(semanticReviewErrorKey(401, "UNAUTHORIZED"), "ui.semanticReview.errUnauthorized");
  assert.equal(semanticReviewErrorKey(400, "INVALID_CONFLICT_INPUT"), "ui.semanticReview.errGeneric");
  assert.equal(semanticReviewErrorKey(500, undefined), "ui.semanticReview.errGeneric");
});

test("panel source: explicit submit-only POST, server cursor, no internal evidence fields", () => {
  const source = readFileSync(
    new URL("../app/components/semantic-review-panel.tsx", import.meta.url),
    "utf8",
  );
  // 服务端游标来源：context GET。
  assert.match(source, /\/api\/worldline\/conflict\/semantic\/context\?worldId=/);
  // 显式触发：唯一 POST 绑定在表单 onSubmit；无自动重试/轮询/后台触发。
  assert.match(source, /onSubmit=\{submit\}/);
  assert.equal(
    source.match(/fetch\("\/api\/worldline\/conflict\/semantic"/g)?.length,
    1,
    "POST 调用点唯一",
  );
  assert.doesNotMatch(source, /setInterval|setTimeout/);
  // 绝不渲染内部 evidence 字段。
  assert.doesNotMatch(source, /inputDigest|requestId|promptVersion|prompt/);
  // 无「直接合并」动作（recommendation 只作文本展示，不绑定任何写入）。
  assert.doesNotMatch(source, /action:\s*"decide"|\/api\/canon|\/api\/worldline\/merge/);
  // 固定提示：草稿与证据边界。
  assert.match(source, /ui\.semanticReview\.draftNotice/);
  assert.match(source, /ui\.semanticReview\.evidenceNote/);
});

test("graph panel wiring: per-claim entry, uiLanguage prop, result survives refresh", () => {
  const source = readFileSync(
    new URL("../app/components/knowledge-graph-panel.tsx", import.meta.url),
    "utf8",
  );
  // 入口在实体详情 Claim 列表内。
  assert.match(source, /ui\.semanticReview\.request/);
  assert.match(source, /<SemanticReviewPanel/);
  // uiLanguage 入参经 normalizeUiLanguage 收敛。
  assert.match(source, /uiLanguage\?:\s*UiLanguage/);
  assert.match(source, /normalizeUiLanguage\(uiLanguageProp\)/);
  // 复审状态是独立局部 state（SSE 的 load() 不触碰 reviewClaimId）。
  const loadBody = source.match(/const load = useCallback\(async \(\) => \{[\s\S]*?\}, \[worldId\]\);/);
  assert.ok(loadBody, "load() 存在");
  assert.ok(
    !loadBody![0].includes("reviewClaimId"),
    "SSE/手动刷新不得清除复审结果",
  );
});

test("realm client passes uiLanguage into the graph panel", () => {
  const source = readFileSync(
    new URL("../app/realm-client.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /<KnowledgeGraphPanel[\s\S]*?uiLanguage=\{uiLanguage\}/);
});
