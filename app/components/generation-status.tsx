"use client";

import { useEffect, useRef, useState } from "react";
import { uiText, type UiLanguage } from "../../modules/i18n/public.ts";
import type { GenerationStatus } from "../../modules/streaming/generation-status.ts";

export async function readGenerationStatus(recordId: string, signal?: AbortSignal): Promise<GenerationStatus> {
  const response = await fetch(`/api/record/generation?recordId=${encodeURIComponent(recordId)}`, {
    cache: "no-store", signal: signal ?? AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error("Generation status unavailable");
  const data: unknown = await response.json();
  if (!data || typeof data !== "object") throw new Error("Invalid generation status");
  const payload = data as { recordId?: unknown; generation?: GenerationStatus };
  const status = payload.generation;
  if (payload.recordId !== recordId || !status || typeof status.busy !== "boolean" || !Array.isArray(status.activities)) throw new Error("Invalid generation status");
  const phases = ["queued", "opening", "preparing", "planner", "character", "narrator", "reviewer", "committing", "scene"];
  if (status.activities.some((item) => !item || !phases.includes(item.phase) || (item.speaker !== undefined && typeof item.speaker !== "string"))) throw new Error("Invalid generation phase");
  return status;
}

export function useGenerationStatus(recordId: string, refresh: (recordId: string) => Promise<boolean>) {
  const [state, setState] = useState<{ recordId: string; generation: GenerationStatus | null }>({ recordId: "", generation: null });
  const refreshRef = useRef(refresh);
  useEffect(() => { refreshRef.current = refresh; }, [refresh]);
  useEffect(() => {
    if (!recordId) return;
    let stopped = false;
    let hadWork = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    async function poll() {
      try {
        const generation = await readGenerationStatus(recordId, AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)]));
        if (stopped) return;
        // Keep submission blocked until the post-generation head/write token is reloaded.
        if (!generation.busy && hadWork && !await refreshRef.current(recordId)) throw new Error("Record refresh unavailable");
        if (stopped) return;
        hadWork = generation.busy;
        setState({ recordId, generation });
      } catch {
        if (stopped) return;
        hadWork = true;
        setState({ recordId, generation: null });
      }
      if (!stopped) timer = setTimeout(() => void poll(), document.hidden ? 5_000 : 750);
    }
    void poll();
    return () => { stopped = true; controller.abort(); clearTimeout(timer); };
  }, [recordId]);
  const generation = state.recordId === recordId ? state.generation : null;
  return { generation, blocked: generation === null || generation.busy };
}

export function GenerationIndicator({ generation, uiLanguage }: { generation: GenerationStatus | null; uiLanguage: UiLanguage }) {
  if (generation && !generation.busy) return null;
  const detailed = generation?.activities.filter((activity) => activity.phase !== "preparing") ?? [];
  const messages = detailed.map((activity) => activity.phase === "character"
    ? uiText("ui.generation.character", uiLanguage, { name: activity.speaker ?? "…" })
    : uiText(`ui.generation.${activity.phase}`, uiLanguage));
  return <div className="generation-indicator" role="status" aria-live="polite" data-generation-state={generation ? "busy" : "unknown"}>
    <span aria-hidden="true">◌</span>
    <div><strong>{generation ? messages.join(" · ") || uiText("ui.generation.preparing", uiLanguage) : uiText("ui.generation.unknown", uiLanguage)}</strong>
      <small>{uiText("ui.generation.draftHint", uiLanguage)}</small></div>
  </div>;
}
