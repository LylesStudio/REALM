"use client";

import { useEffect, useRef, useState } from "react";
import { uiText, type UiLanguage } from "../../modules/i18n/public.ts";

type Preview = {
  speaker: string;
  text: string;
};

type PreviewUpdate = (current: Record<string, Preview>) => Record<string, Preview>;

export function PreviewCards({
  recordId,
  uiLanguage,
}: {
  recordId: string;
  uiLanguage: UiLanguage;
}) {
  const [previews, setPreviews] = useState<Record<string, Preview>>({});
  const pendingUpdatesRef = useRef<PreviewUpdate[]>([]);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    if (!recordId) return;

    const source = new EventSource(
      `/api/record/preview?recordId=${encodeURIComponent(recordId)}`,
    );
    const scheduleUpdate = (update: PreviewUpdate) => {
      pendingUpdatesRef.current.push(update);
      if (frameRef.current !== null) return;
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null;
        const updates = pendingUpdatesRef.current.splice(0);
        if (updates.length === 0) return;
        setPreviews((current) => updates.reduce(
          (next, apply) => apply(next),
          current,
        ));
      });
    };
    const acceptPreview = (rawEvent: Event) => {
      try {
        const event = JSON.parse((rawEvent as MessageEvent<string>).data) as {
          previewId: string;
          speaker: string;
          content: string;
        };
        scheduleUpdate((current) => ({
          ...current,
          [event.previewId]: {
            speaker: event.speaker,
            text: (current[event.previewId]?.text ?? "") + event.content,
          },
        }));
      } catch {
        // 非法 Preview 载荷直接忽略。
      }
    };
    const removePreview = (rawEvent: Event) => {
      try {
        const event = JSON.parse((rawEvent as MessageEvent<string>).data) as {
          previewId: string;
        };
        scheduleUpdate((current) => {
          const next = { ...current };
          delete next[event.previewId];
          return next;
        });
      } catch {
        // 非法 Preview 结束载荷直接忽略。
      }
    };

    source.addEventListener("preview", acceptPreview);
    source.addEventListener("preview-end", removePreview);
    return () => {
      source.removeEventListener("preview", acceptPreview);
      source.removeEventListener("preview-end", removePreview);
      source.close();
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      pendingUpdatesRef.current = [];
    };
  }, [recordId]);

  return Object.entries(previews).map(([previewId, preview]) => (
    <div className="preview-card" key={previewId} role="status">
      <div className="preview-card-heading">
        <strong>{preview.speaker}</strong>
        <span>{uiText("ui.timeline.preview", uiLanguage)}</span>
      </div>
      <p>{preview.text || "…"}</p>
    </div>
  ));
}
