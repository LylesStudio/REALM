import type { WorldGenesisDraft } from "../../modules/application/world-genesis.ts";

/**
 * AI 引导创建的分步步骤定义与状态机（纯函数，供组件与契约测试共用）。
 * draft 是已提交步骤的唯一状态源；回退/前进绝不丢已保存内容。
 */

export type GuidedStepId =
  | "world-name"
  | "era"
  | "style"
  | "summary"
  | "story"
  | "player-role"
  | "stance"
  | "companions"
  | "scene"
  | "review";

interface StepDraftValues {
  text: string;
  storyTitle: string;
  storyPremise: string;
}

/** 本步已保存值（回退时重新填回输入控件）。 */
export function stepSavedValue(
  stepId: GuidedStepId,
  draft: WorldGenesisDraft,
): StepDraftValues {
  switch (stepId) {
    case "world-name":
      return { text: draft.world.name, storyTitle: "", storyPremise: "" };
    case "era":
      return { text: draft.world.era, storyTitle: "", storyPremise: "" };
    case "summary":
      return { text: draft.world.summary, storyTitle: "", storyPremise: "" };
    case "story":
      return { text: "", storyTitle: draft.story.title, storyPremise: draft.story.premise };
    case "player-role":
      return { text: draft.playerRole, storyTitle: "", storyPremise: "" };
    default:
      return { text: "", storyTitle: "", storyPremise: "" };
  }
}

/**
 * 提交当前步骤：只更新当前字段，绝不用空输入覆盖已保存内容
 * （留空表示保留旧值；再次前进只影响当前字段）。
 */
export function applyStepConfirm(
  stepId: GuidedStepId,
  draft: WorldGenesisDraft,
  values: StepDraftValues,
): WorldGenesisDraft {
  const text = values.text.trim();
  switch (stepId) {
    case "world-name":
      return text
        ? { ...draft, world: { ...draft.world, name: text } }
        : draft;
    case "era":
      return text
        ? { ...draft, world: { ...draft.world, era: text } }
        : draft;
    case "summary":
      return text
        ? { ...draft, world: { ...draft.world, summary: text } }
        : draft;
    case "story": {
      const title = values.storyTitle.trim();
      const premise = values.storyPremise.trim();
      return {
        ...draft,
        story: {
          title: title || draft.story.title || "序章",
          premise: premise || draft.story.premise,
        },
        record: draft.record.title ? draft.record : { title: "第一章" },
      };
    }
    case "player-role":
      return text ? { ...draft, playerRole: text } : draft;
    default:
      return draft;
  }
}
