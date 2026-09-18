/**
 * 批次 T10-B12-A：从 db/record-store.ts 提取的 delivery projection 纯类型边界。
 *
 * 本文件是 **delivery projection**（交付/UI 投影：导航树、cast、events 的
 * segments/presence/dice/selfPlay）的唯一类型来源——不是
 * modules/story-record/public.ts 的 Core `RecordProjection`
 * （persistence-neutral 回合/上下文契约），两者同名不同语义，不得合并、
 * 不得互相 re-export（见 public documentation §一）。
 *
 * 纯度约束：只允许 `import type` 依赖其他模块的纯类型；不得出现值导入，
 * 不得 import db/、drizzle、database/postgres 或 HTTP/路由层。
 * `db/record-store.ts` 以 `import type` + `export type` re-export 本文件，
 * 作为 legacy D1 链的兼容桥；生产与测试一律直接引用本文件。
 */
import type { SemanticSegment } from "../presentation/semantic-segments.ts";
import type { MechanicDetail } from "../actions/public.ts";

export type ProjectionEvent = {
  id: string;
  ordinal: number;
  type: "narration" | "utterance" | "action" | "system";
  speaker: string;
  speakerParticipantId: string | null;
  role: "player" | "character" | "narrator" | "system";
  content: string;
  segments: readonly SemanticSegment[];
  worldTime: string;
  visibility: string;
  status: string;
  createdAt: string;
  /**
   * 对话主体标记（内部字段；UI 不展示、不改变可见文本）：发言者有明确
   * 对话对象时为对方 participantId，无明确对象/旧事件缺省（读作 null）。
   */
  recipientId?: string | null;
  /** 批次 T3：在场发声标记（回合外角色自主发声；非在场事件缺省）。 */
  presence?: {
    characterInstanceId: string;
    triggerKind: "environment" | "peer" | "hook";
  };
  /** 批次 T5：判定骰点物化结果（仅带 check 的 action.transaction 事件）。 */
  dice?: MechanicDetail;
  /** 批次 T7：世界自演拍标记（自治回合产出；非自演事件缺省）。 */
  selfPlay?: {
    beat: number;
  };
};

export type RecordProjection = {
  id: string;
  version: number;
  world: {
    id: string;
    name: string;
    era: string;
    summary: string;
    timeCursor: string;
    /** 世界文风（缺省 modern）。 */
    style: string;
    /** 世界内系统文本语言（缺省 zh-CN）。 */
    language: string;
  };
  story: {
    id: string;
    title: string;
    status: string;
    premise: string;
  };
  record: {
    id: string;
    title: string;
    status: string;
    version: number;
    location: string;
    worldTime: string;
  };
  scene: {
    location: string;
    worldTime: string;
    weather: string;
    tension: string;
    objective: string;
  };
  cast: Array<{
    id: string;
    participantId: string;
    characterInstanceId: string;
    name: string;
    role: string;
    summary: string;
    status: string;
    controlledBy: "human" | "ai" | "hybrid";
    isActive: boolean;
  }>;
  participants: RecordProjection["cast"];
  events: ProjectionEvent[];
  /** 当前 worldline 下的全部故事（导航树）。 */
  stories: Array<{ id: string; title: string; status: string }>;
  /** 当前故事下的全部记录（导航树）。 */
  records: Array<{ id: string; title: string; status: string; worldTime: string }>;
};
