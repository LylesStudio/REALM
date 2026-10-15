/**
 * Phase 2B：Local Record 流式 Preview 的内存广播/可见性过滤边界。
 * 从 local-record-service.ts facade 拆出（行为保持）；facade 通过
 * import/re-export 保持既有公开 API 与引用路径不变。
 * 本模块不得反向 import local-record-service.ts。
 */
import type { TurnVisibilityPlan } from "../orchestration/public.ts";
import {
  createPreviewSession,
  type PreviewSession,
} from "../streaming/preview-session.ts";

export type LocalPreviewEvent =
  | {
    kind: "chunk";
    previewId: string;
    turnId: string;
    segmentIndex: number;
    phase: string;
    speaker: string;
    content: string;
    status: "preview";
    visibility: "player";
  }
  | {
    kind: "end";
    previewId: string;
    turnId: string;
    status: "cancelled" | "committed";
    outcome: "committed" | "aborted";
  };

export interface LocalPreviewHub {
  begin(
    recordId: string,
    previewId: string,
    signal: AbortSignal | undefined,
    visibility: TurnVisibilityPlan,
  ): void;
  publishChunk(
    recordId: string,
    speaker: string,
    content: string,
    phase?: string,
  ): void;
  end(recordId: string, outcome: "committed" | "aborted"): void;
  subscribe(
    recordId: string,
    listener: (event: LocalPreviewEvent) => void,
    viewerCharacterInstanceId?: string,
  ): () => void;
}

/**
 * In-memory preview 广播枢纽。public Turn 面向所有已授权 viewer；restricted
 * Turn 在服务端按 principal 绑定的 characterInstanceId 过滤，chunk 与 end
 * 元数据同样受 audience 约束。身份缺失时只允许 public Preview。
 */
type LocalPreviewSubscriber = {
  listener: (event: LocalPreviewEvent) => void;
  viewerCharacterInstanceId?: string;
};
type ActiveLocalPreview = {
  session: PreviewSession;
  visibility: TurnVisibilityPlan;
  segmentIndex: number;
  phase: string;
};

function canViewPreview(
  visibility: TurnVisibilityPlan,
  viewerCharacterInstanceId?: string,
): boolean {
  if (visibility.kind === "public") return true;
  if (
    visibility.kind !== "restricted"
    || !Array.isArray(visibility.audienceCharacterInstanceIds)
    || typeof viewerCharacterInstanceId !== "string"
    || viewerCharacterInstanceId.length === 0
  ) {
    return false;
  }
  return visibility.audienceCharacterInstanceIds.includes(viewerCharacterInstanceId);
}

export function createLocalPreviewHub(): LocalPreviewHub {
  const listeners = new Map<string, Set<LocalPreviewSubscriber>>();
  const sessions = new Map<string, ActiveLocalPreview>();

  function emit(
    recordId: string,
    event: LocalPreviewEvent,
    visibility: TurnVisibilityPlan,
  ) {
    for (const subscriber of listeners.get(recordId) ?? []) {
      if (canViewPreview(visibility, subscriber.viewerCharacterInstanceId)) {
        subscriber.listener(event);
      }
    }
  }

  return {
    begin(recordId, previewId, signal, visibility) {
      sessions.set(recordId, {
        session: createPreviewSession({ id: previewId, signal }),
        visibility,
        segmentIndex: 0,
        phase: "preview",
      });
    },
    publishChunk(recordId, speaker, content, phase = "preview") {
      const active = sessions.get(recordId);
      if (!active || active.session.state !== "streaming" || !content) return;
      active.session.push(content);
      active.phase = phase;
      const segmentIndex = active.segmentIndex;
      active.segmentIndex += 1;
      emit(recordId, {
        kind: "chunk",
        previewId: active.session.id,
        turnId: active.session.id,
        segmentIndex,
        phase,
        speaker,
        content,
        status: "preview",
        visibility: "player",
      }, active.visibility);
    },
    end(recordId, outcome) {
      const active = sessions.get(recordId);
      if (!active) return;
      sessions.delete(recordId);
      // Batch 2D：已 aborted 的会话绝不因迟到的 success cleanup 发出
      // committed end；partial 已被会话状态机清空且不可读取。
      const effectiveOutcome = active.session.state === "aborted"
        ? "aborted"
        : outcome;
      if (active.session.state === "streaming") {
        if (effectiveOutcome === "committed") active.session.complete();
        else active.session.abort(effectiveOutcome);
      }
      emit(recordId, {
        kind: "end",
        previewId: active.session.id,
        turnId: active.session.id,
        status: effectiveOutcome === "aborted" ? "cancelled" : "committed",
        outcome: effectiveOutcome,
      }, active.visibility);
    },
    subscribe(recordId, listener, viewerCharacterInstanceId) {
      const set = listeners.get(recordId) ?? new Set<LocalPreviewSubscriber>();
      const subscriber = { listener, viewerCharacterInstanceId };
      set.add(subscriber);
      listeners.set(recordId, set);
      return () => {
        set.delete(subscriber);
        if (set.size === 0) listeners.delete(recordId);
      };
    },
  };
}
