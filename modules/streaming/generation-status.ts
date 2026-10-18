import type { TurnVisibilityPlan } from "../orchestration/public.ts";

/** Ephemeral public progress, never model reasoning, prompt text or durable history. */
export type GenerationPhase = "queued" | "opening" | "preparing" | "planner" | "character" | "narrator" | "reviewer" | "committing" | "scene";
export interface GenerationActivity {
  phase: GenerationPhase;
  speaker?: string;
}
export interface GenerationStatus {
  busy: boolean;
  activities: readonly GenerationActivity[];
}
export type GenerationSink = (activity: GenerationActivity, signal?: AbortSignal) => () => void;

export function createGenerationStatusHub() {
  const records = new Map<string, Map<symbol, { activity: GenerationActivity; visibility: TurnVisibilityPlan }>>();
  return {
    begin(recordId: string, activity: GenerationActivity, visibility: TurnVisibilityPlan, signal?: AbortSignal): () => void {
      if (signal?.aborted) return () => {};
      const key = Symbol();
      const active = records.get(recordId) ?? new Map();
      active.set(key, { activity: { phase: activity.phase, ...(activity.speaker ? { speaker: activity.speaker.slice(0, 80) } : {}) }, visibility });
      records.set(recordId, active);
      const finish = () => {
        signal?.removeEventListener("abort", finish);
        active.delete(key);
        if (active.size === 0 && records.get(recordId) === active) records.delete(recordId);
      };
      signal?.addEventListener("abort", finish, { once: true });
      return finish;
    },
    read(recordId: string, viewerCharacterInstanceId?: string): GenerationStatus {
      const active = records.get(recordId);
      const activities: GenerationActivity[] = [];
      for (const { activity, visibility } of active?.values() ?? []) {
        if (visibility.kind !== "public" && !(visibility.kind === "restricted"
          && viewerCharacterInstanceId
          && visibility.audienceCharacterInstanceIds.includes(viewerCharacterInstanceId))) continue;
        if (!activities.some((item) => item.phase === activity.phase && item.speaker === activity.speaker)) activities.push({ ...activity });
      }
      // Record occupancy is generic; restricted participant names and phases stay hidden.
      return { busy: (active?.size ?? 0) > 0, activities };
    },
  };
}

export type GenerationStatusHub = ReturnType<typeof createGenerationStatusHub>;

export async function trackGeneration<T>(sink: GenerationSink | undefined, activity: GenerationActivity, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const finish = sink?.(activity, signal);
  try { return await run(); }
  finally { finish?.(); }
}
