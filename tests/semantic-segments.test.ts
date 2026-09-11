import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseViewerLocalDiscovery } from "../database/postgres/delivery-projection.ts";
import {
  fallbackCompositeSemanticSegments,
  filterUnsafeDeliverySegments,
  parseSemanticPresentation,
  semanticPresentation,
} from "../modules/presentation/semantic-segments.ts";

test("viewer-local discovery is visible only to the controlled action actor", () => {
  const payload = {
    actionTransaction: {
      actor: { characterInstanceId: "player-instance" },
      receipt: {
        privateObservations: [{
          characterInstanceId: "player-instance",
          discovery: {
            subject: "浓雾",
            feature: "雾层边缘短暂变薄",
            nextCheck: "等待下一次变薄",
            certainty: "partial",
          },
        }],
      },
    },
  };
  assert.match(
    parseViewerLocalDiscovery(payload, "player-instance") ?? "",
    /浓雾.*雾层边缘短暂变薄.*等待下一次变薄/,
  );
  assert.equal(parseViewerLocalDiscovery(payload, "other-instance"), undefined);
  assert.equal(parseViewerLocalDiscovery(payload, null), undefined);
});

test("legacy fallback delivery filters generic dialogue and facts but keeps action/environment/story", () => {
  const segments = filterUnsafeDeliverySegments([
    {
      id: "action-1",
      kind: "action",
      content: "克罗姆盯住甲板边缘。",
      speechMode: "narrator",
    },
    {
      id: "dialogue-1",
      kind: "dialogue",
      content: "“你确认目标上有一处可复核的异常，但还不能判断它的来源。”",
      speechMode: "speaker",
    },
    {
      id: "fact-1",
      kind: "fact",
      content: "克罗姆从目标中找到了一个可复核的异常细节。",
      speechMode: "narrator",
    },
    {
      id: "environment-1",
      kind: "environment",
      content: "浓雾压在甲板上。",
      speechMode: "narrator",
    },
    {
      id: "story-1",
      kind: "story",
      content: "搜寻仍在继续。",
      speechMode: "narrator",
    },
  ]);
  assert.deepEqual(segments.map((segment) => segment.kind), ["action", "environment", "story"]);
});

test("legacy compound prose separates character action from quoted dialogue", () => {
  const content = "塞娜望向雾中的灯塔，低声回应：“我听见了。关于‘密函’，我们先确认四周没有异动。”";
  const segments = fallbackCompositeSemanticSegments(content, "dialogue");

  assert.deepEqual(segments.map((segment) => segment.kind), ["action", "dialogue"]);
  assert.equal(segments[0]?.content, "塞娜望向雾中的灯塔，低声回应：");
  assert.equal(
    segments[1]?.content,
    "“我听见了。关于‘密函’，我们先确认四周没有异动。”",
  );
  assert.equal(segments.map((segment) => segment.content).join(""), content);
  assert.deepEqual(segments.map((segment) => segment.speechMode), [
    "narrator",
    "speaker",
  ]);
});

test("unbalanced legacy prose falls back without dropping content", () => {
  const content = "塞娜说道：“雾里有人";
  const segments = fallbackCompositeSemanticSegments(content, "dialogue");
  assert.equal(segments.length, 1);
  assert.equal(segments[0]?.kind, "dialogue");
  assert.equal(segments[0]?.content, content);
});

test("player utterance splits parenthesized action from bare dialogue", () => {
  const content = "（环顾四周）这里好安静。";
  const segments = fallbackCompositeSemanticSegments(content, "action");

  assert.deepEqual(segments.map((segment) => segment.kind), ["action", "dialogue"]);
  assert.equal(segments[0]?.content, "（环顾四周）");
  assert.equal(segments[1]?.content, "这里好安静。");
  assert.equal(segments.map((segment) => segment.content).join(""), content);
  assert.deepEqual(segments.map((segment) => segment.speechMode), [
    "narrator",
    "speaker",
  ]);
});

test("player utterance without parentheses keeps the fallback kind", () => {
  const content = "今晚的雾比昨晚更重。";
  const segments = fallbackCompositeSemanticSegments(content, "action");
  assert.equal(segments.length, 1);
  assert.equal(segments[0]?.kind, "action");
  assert.equal(segments[0]?.content, content);
});

test("semantic presentation rejects partial malformed structures", () => {
  const valid = semanticPresentation([
    {
      id: "action-1",
      kind: "action",
      content: "塞娜抬起手。",
      speechMode: "narrator",
    },
    {
      id: "dialogue-1",
      kind: "dialogue",
      content: "“停下。”",
      speechMode: "speaker",
    },
  ]);
  assert.deepEqual(parseSemanticPresentation({ presentation: valid }), valid.segments);
  assert.equal(
    parseSemanticPresentation({
      presentation: {
        schemaVersion: 1,
        segments: [
          ...valid.segments,
          { ...valid.segments[1], id: "action-1" },
        ],
      },
    }),
    null,
  );
});

test("UI preserves the original paper card and highlights text only", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  const component = readFileSync(
    new URL("../app/components/semantic-event-content.tsx", import.meta.url),
    "utf8",
  );
  const semanticRule = css.match(/\.semantic-segment\s*\{([^}]*)\}/)?.[1] ?? "";
  const contentRule = css.match(/\.semantic-content\s*\{([^}]*)\}/)?.[1] ?? "";

  assert.match(semanticRule, /color:\s*var\(--semantic-color\)/);
  assert.match(semanticRule, /background:\s*transparent/);
  assert.match(semanticRule, /border:\s*0/);
  assert.match(semanticRule, /display:\s*inline/);
  assert.match(semanticRule, /padding:\s*0/);
  assert.match(semanticRule, /width:\s*auto/);
  assert.match(contentRule, /display:\s*block/);
  assert.match(contentRule, /width:\s*100%/);
  assert.match(component, /data-speech-boundary="segment"/);
  assert.match(component, /data-speech-mode=/);
  assert.doesNotMatch(component, /semantic-segment-label/);
});
