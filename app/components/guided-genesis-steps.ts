import {
  GENESIS_LIMITS,
  MAX_COMPANIONS,
  type WorldGenesisDraft,
} from "../../modules/application/world-genesis-contract.ts";

/**
 * AI 引导创建的分步步骤定义与状态机（纯函数，供组件与契约测试共用）。
 * draft 是已提交步骤的唯一状态源；回退/前进绝不丢已保存内容。
 * 同伴与场景不走影子文本框：每次编辑都写回 canonical draft。
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

export interface CompanionDraftRow {
  name: string;
  role: string;
  summary: string;
}

export interface SceneDraftFields {
  title: string;
  location: string;
  weather: string;
  tension: string;
  displayTime: string;
  objective: string;
}

export interface StepDraftValues {
  text: string;
  storyTitle: string;
  storyPremise: string;
  companions: CompanionDraftRow[];
  scene: SceneDraftFields;
}

/** 文本步可以不带复合字段；同伴/场景步带上当前编辑行。 */
export interface StepConfirmInput {
  text: string;
  storyTitle: string;
  storyPremise: string;
  companions?: readonly CompanionDraftRow[];
  scene?: SceneDraftFields;
}

export type ScenePatchField = keyof SceneDraftFields;

function clampText(value: string, maxLength: number): string {
  return value.trim().slice(0, maxLength);
}

function sceneFields(draft: WorldGenesisDraft): SceneDraftFields {
  return {
    title: draft.scene.title ?? "",
    location: draft.scene.location,
    weather: draft.scene.weather,
    tension: draft.scene.tension,
    displayTime: draft.scene.displayTime ?? "",
    objective: draft.scene.objective,
  };
}

function companionRows(draft: WorldGenesisDraft): CompanionDraftRow[] {
  return draft.companions.map((item) => ({
    name: item.name,
    role: item.role,
    summary: item.summary,
  }));
}

function savedShell(draft: WorldGenesisDraft): StepDraftValues {
  return {
    text: "",
    storyTitle: "",
    storyPremise: "",
    companions: companionRows(draft),
    scene: sceneFields(draft),
  };
}

/** 本步已保存值（回退时重新填回输入控件，复合字段从 canonical draft 恢复）。 */
export function stepSavedValue(
  stepId: GuidedStepId,
  draft: WorldGenesisDraft,
): StepDraftValues {
  const saved = savedShell(draft);
  switch (stepId) {
    case "world-name":
      return { ...saved, text: draft.world.name };
    case "era":
      return { ...saved, text: draft.world.era };
    case "summary":
      return { ...saved, text: draft.world.summary };
    case "story":
      return {
        ...saved,
        storyTitle: draft.story.title,
        storyPremise: draft.story.premise,
      };
    case "player-role":
      return { ...saved, text: draft.playerRole };
    default:
      return saved;
  }
}

export function namedCompanionCount(draft: WorldGenesisDraft): number {
  return draft.companions.filter((item) => item.name.trim().length > 0).length;
}

export function sceneHasContent(draft: WorldGenesisDraft): boolean {
  const scene = sceneFields(draft);
  return Object.values(scene).some((value) => value.trim().length > 0);
}

/** 空名字不制造角色；超长按创世上限截断；超过两名的行丢弃。 */
export function commitCompanionRows(
  draft: WorldGenesisDraft,
  rows: readonly CompanionDraftRow[],
): WorldGenesisDraft {
  const companions = rows
    .map((row) => ({
      name: clampText(row.name, GENESIS_LIMITS.companionName),
      role: clampText(row.role, GENESIS_LIMITS.companionRole),
      summary: clampText(row.summary, GENESIS_LIMITS.companionSummary),
    }))
    .filter((row) => row.name.length > 0)
    .slice(0, MAX_COMPANIONS);
  return { ...draft, companions };
}

/** 留空保持空字符串，不写入「未记录 / 平稳 / 地点未定」这类占位。 */
export function commitSceneFields(
  draft: WorldGenesisDraft,
  scene: SceneDraftFields,
): WorldGenesisDraft {
  const title = clampText(scene.title, GENESIS_LIMITS.sceneTitle);
  const displayTime = clampText(scene.displayTime, GENESIS_LIMITS.displayTime);
  return {
    ...draft,
    scene: {
      ...(title ? { title } : {}),
      location: clampText(scene.location, GENESIS_LIMITS.sceneField),
      weather: clampText(scene.weather, GENESIS_LIMITS.sceneField),
      tension: clampText(scene.tension, GENESIS_LIMITS.sceneField),
      ...(displayTime ? { displayTime } : {}),
      objective: clampText(scene.objective, GENESIS_LIMITS.objective),
    },
  };
}

export function addCompanionRow(draft: WorldGenesisDraft): WorldGenesisDraft {
  if (draft.companions.length >= MAX_COMPANIONS) return draft;
  return {
    ...draft,
    companions: [...draft.companions, { name: "", role: "", summary: "" }],
  };
}

export function removeCompanionAt(
  draft: WorldGenesisDraft,
  index: number,
): WorldGenesisDraft {
  if (!Number.isInteger(index) || index < 0 || index >= draft.companions.length) {
    return draft;
  }
  return {
    ...draft,
    companions: draft.companions.filter((_, itemIndex) => itemIndex !== index),
  };
}

export function patchCompanionField(
  draft: WorldGenesisDraft,
  index: number,
  field: keyof CompanionDraftRow,
  value: string,
): WorldGenesisDraft {
  if (!Number.isInteger(index) || index < 0 || index >= draft.companions.length) {
    return draft;
  }
  return {
    ...draft,
    companions: draft.companions.map((item, itemIndex) =>
      itemIndex === index ? { ...item, [field]: value } : item,
    ),
  };
}

/**
 * AI 候选写入同一份 canonical companions。
 * 优先填进第一个空名字行；同名不重复追加；满员后不再增加。
 */
export function inviteCompanionRow(
  draft: WorldGenesisDraft,
  companion: CompanionDraftRow,
): WorldGenesisDraft {
  const name = companion.name.trim();
  if (!name) return draft;
  if (draft.companions.some((item) => item.name === name)) return draft;
  const row = {
    name,
    role: companion.role.trim(),
    summary: companion.summary.trim(),
  };
  const emptyIndex = draft.companions.findIndex((item) => item.name.trim().length === 0);
  if (emptyIndex >= 0) {
    return {
      ...draft,
      companions: draft.companions.map((item, index) => (index === emptyIndex ? row : item)),
    };
  }
  if (draft.companions.length >= MAX_COMPANIONS) return draft;
  return { ...draft, companions: [...draft.companions, row] };
}

/** 只替换一个场景字段，其余字段保持调用时的 draft。 */
export function patchSceneField(
  draft: WorldGenesisDraft,
  field: ScenePatchField,
  value: string,
): WorldGenesisDraft {
  return { ...draft, scene: { ...draft.scene, [field]: value } };
}

/**
 * 提交当前步骤：只更新当前字段，绝不用空输入覆盖已保存内容
 * （留空表示保留旧值；再次前进只影响当前字段）。
 * 同伴与场景例外：编辑器里的当前行就是要保存的完整快照。
 */
export function applyStepConfirm(
  stepId: GuidedStepId,
  draft: WorldGenesisDraft,
  values: StepConfirmInput,
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
    case "companions":
      return commitCompanionRows(draft, values.companions ?? draft.companions);
    case "scene":
      return values.scene ? commitSceneFields(draft, values.scene) : draft;
    default:
      return draft;
  }
}
