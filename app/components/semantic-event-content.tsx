"use client";

import { useEffect, useMemo, useState } from "react";
import {
  semanticSegmentLabel,
  type SemanticSegment,
} from "../../modules/presentation/semantic-segments.ts";
import { streamSemanticSegments } from "../../modules/streaming/semantic-stream.ts";

interface SemanticEventContentProps {
  segments: readonly SemanticSegment[];
  reveal?: boolean;
}

/**
 * Segment nodes are also future speech boundaries. No visible sentinel or
 * punctuation is injected into the narrative content.
 */
export function SemanticEventContent({ segments, reveal = false }: SemanticEventContentProps) {
  const [visible, setVisible] = useState<{
    signature: string;
    values: Record<string, string>;
  }>({ signature: "", values: {} });
  // 自演期间 /api/record 每 2.5s 返回新的数组引用，但同一 committed
  // Event 的内容没有变化。用内容签名保持动画输入稳定，避免 effect
  // 重启后把同一段全文再次追加成“重复文本”。
  const segmentSignature = JSON.stringify(segments);
  const stableSegments = useMemo(
    () => JSON.parse(segmentSignature) as readonly SemanticSegment[],
    [segmentSignature],
  );

  useEffect(() => {
    if (!reveal) return;
    const controller = new AbortController();
    void (async () => {
      for await (const chunk of streamSemanticSegments(stableSegments, controller.signal)) {
        setVisible((current) => {
          const values = current.signature === segmentSignature ? current.values : {};
          return {
            signature: segmentSignature,
            values: {
              ...values,
              [chunk.segmentId]: `${values[chunk.segmentId] ?? ""}${chunk.content}`,
            },
          };
        });
        await new Promise((resolve) => window.setTimeout(resolve, 24));
      }
    })();
    return () => controller.abort();
  }, [reveal, segmentSignature, stableSegments]);

  return (
    <p className="semantic-content" data-speech-sequence="semantic-v1">
      {stableSegments.map((segment) => (
        <span
          aria-label={`${semanticSegmentLabel(segment.kind)}：${segment.content}`}
          className={`semantic-segment semantic-${segment.kind}`}
          data-segment-id={segment.id}
          data-segment-kind={segment.kind}
          data-speech-boundary="segment"
          data-speech-mode={segment.speechMode}
          key={segment.id}
          title={semanticSegmentLabel(segment.kind)}
        >
          {reveal
            ? (visible.signature === segmentSignature ? visible.values[segment.id] ?? "" : "")
            : segment.content}
        </span>
      ))}
    </p>
  );
}
