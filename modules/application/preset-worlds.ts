/**
 * Preset 世界入口 · base 内容层的薄适配器。
 *
 * 内容语义已迁入内容解析层（modules/content-resolution，引擎升级计划
 * §2.2）：三个 preset 世界的全部文案由 BaseContentResolver 按
 * contentKey + language 解析；本模块只保留 UI 列表元数据（i18n 标签键）
 * 与 resolved content → WorldGenesisDraft 的纯映射。client-safe。
 */
import { createBaseContentResolver } from "../content-resolution/base-resolver.ts";
import {
  BASE_PRESET_CONTENT_KEYS,
} from "../content-resolution/base-content-data.ts";
import type { ResolvedGenesisContent } from "../content-resolution/public.ts";
import { normalizeWorldStyle } from "../style/world-style.ts";
import type {
  GenesisLanguage,
  WorldGenesisDraft,
} from "./world-genesis-contract.ts";

export type PresetWorldKey = "dnd-tavern" | "anime-hero" | "urban-cultivation";

export interface PresetWorld {
  key: PresetWorldKey;
  /** 界面展示用短标题（i18n key）。 */
  titleKey: string;
  /** 界面展示用一句话描述（i18n key）。 */
  descriptionKey: string;
  /** 用于世界库/引导屏标签分类。 */
  tagKey: string;
  /** 中文作为资源默认值；运行时按账号系统语言取 drafts。 */
  draft: WorldGenesisDraft;
  drafts: Readonly<Record<GenesisLanguage, WorldGenesisDraft>>;
}

const PRESET_UI_META: Record<PresetWorldKey, Omit<PresetWorld, "draft" | "drafts">> = {
  "dnd-tavern": {
    key: "dnd-tavern",
    titleKey: "ui.presetWorld.dndTavern.title",
    descriptionKey: "ui.presetWorld.dndTavern.description",
    tagKey: "ui.presetWorld.tagWesternFantasy",
  },
  "anime-hero": {
    key: "anime-hero",
    titleKey: "ui.presetWorld.animeHero.title",
    descriptionKey: "ui.presetWorld.animeHero.description",
    tagKey: "ui.presetWorld.tagAnime",
  },
  "urban-cultivation": {
    key: "urban-cultivation",
    titleKey: "ui.presetWorld.urbanCultivation.title",
    descriptionKey: "ui.presetWorld.urbanCultivation.description",
    tagKey: "ui.presetWorld.tagModern",
  },
};

/**
 * Resolved genesis content → 创世手稿（纯映射；空可选字段一律省略键，
 * 保持既有草稿形态逐字段不变）。
 */
export function genesisDraftFromResolvedContent(
  content: ResolvedGenesisContent,
  language: GenesisLanguage,
): WorldGenesisDraft {
  return {
    language,
    world: {
      name: content.world.name,
      era: content.world.era,
      summary: content.world.summary,
    },
    style: normalizeWorldStyle(content.world.style),
    playerStance: content.playerStance,
    opening: content.opening,
    story: { title: content.story.title, premise: content.story.premise },
    record: { title: content.record.title },
    playerRole: content.playerRole,
    companions: content.characters.map((character) => ({
      name: character.displayName,
      role: character.role,
      summary: character.summary,
    })),
    scene: {
      ...(content.scene.title !== undefined ? { title: content.scene.title } : {}),
      location: content.scene.location,
      weather: content.scene.weather,
      tension: content.scene.tension,
      ...(content.scene.displayTime !== undefined
        ? { displayTime: content.scene.displayTime }
        : {}),
      objective: content.scene.objective,
    },
    ...(content.goals.length > 0
      ? {
        goals: content.goals.map((goal) => ({
          goalKey: goal.goalKey,
          policyVersion: goal.policyVersion,
        })),
      }
      : {}),
  };
}

const resolver = createBaseContentResolver();

function draftFor(key: PresetWorldKey, language: GenesisLanguage): WorldGenesisDraft {
  const content = resolver.resolveGenesisContent({
    binding: { kind: "base" },
    contentKey: key,
    language,
  });
  if (!content) {
    throw new Error(`Unknown preset world content key: ${key}`);
  }
  return genesisDraftFromResolvedContent(content, language);
}

function withLocalizedDrafts(world: Omit<PresetWorld, "draft" | "drafts">): PresetWorld {
  const drafts = {
    "zh-CN": draftFor(world.key, "zh-CN"),
    en: draftFor(world.key, "en"),
    ja: draftFor(world.key, "ja"),
  } as const;
  return { ...world, draft: drafts["zh-CN"], drafts };
}

const PRESET_WORLDS: Record<PresetWorldKey, PresetWorld> = Object.fromEntries(
  BASE_PRESET_CONTENT_KEYS.map((key) => [key, withLocalizedDrafts(PRESET_UI_META[key])]),
) as Record<PresetWorldKey, PresetWorld>;

export const PRESET_WORLD_KEYS = Object.keys(PRESET_WORLDS) as PresetWorldKey[];

export function getPresetWorld(key: string): PresetWorld | undefined {
  return PRESET_WORLDS[key as PresetWorldKey];
}

export function getPresetWorldDraft(
  key: string,
  language: GenesisLanguage,
): WorldGenesisDraft | undefined {
  return getPresetWorld(key)?.drafts[language];
}

export function listPresetWorlds(): readonly PresetWorld[] {
  return PRESET_WORLD_KEYS.map((key) => PRESET_WORLDS[key]);
}
