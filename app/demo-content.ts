/**
 * 演示世界（world_ember_coast）固定模板内容的界面语言本地化。
 *
 * 三层文本边界：演示世界由系统种子生成，属固定模板内容，随界面语言渲染；
 * 玩家输入与运行产出（事件流、裁决结果、LLM 生成）永不翻译。
 * DB 始终存 zh 原文（种子与断言不变），本模块在渲染层按演示实体 id
 * 精确匹配替换；非演示实体一律原样透传（返回同一引用，不触发重渲染）。
 * 角色名（洛川/塞娜/弥洛）为专有名词，三语保持原样。
 */
import { uiText, type UiLanguage } from "../modules/i18n/public.ts";

/** 与 database/postgres/demo-seed.ts 的 POSTGRES_DEMO_IDS 保持一致（契约测试强制）。 */
export const DEMO_IDS = {
  world: "world_ember_coast",
  worldline: "worldline_origin",
  story: "story_silent_bell",
  record: "record_first_watch",
  openingEvent: "event_opening",
  playerDefinition: "char_def_player",
  scoutDefinition: "char_def_scout",
  scholarDefinition: "char_def_scholar",
} as const;

const t = (key: string, lang: UiLanguage) => uiText(key, lang);

// ---------- 世界/故事/记录 ----------

export function demoWorldText<T extends { id: string; name: string; era: string; summary?: string }>(
  world: T,
  lang: UiLanguage,
): T {
  if (world.id !== DEMO_IDS.world) return world;
  return {
    ...world,
    name: t("ui.demo.worldName", lang),
    era: t("ui.demo.worldEra", lang),
    ...(world.summary !== undefined
      ? { summary: t("ui.demo.worldSummary", lang) }
      : {}),
  };
}

export function demoStoryText<T extends { id: string; title: string; premise?: string }>(
  story: T,
  lang: UiLanguage,
): T {
  if (story.id !== DEMO_IDS.story) return story;
  return {
    ...story,
    title: t("ui.demo.storyTitle", lang),
    ...(story.premise !== undefined
      ? { premise: t("ui.demo.storyPremise", lang) }
      : {}),
  };
}

export function demoRecordTitle(recordId: string, title: string, lang: UiLanguage): string {
  return recordId === DEMO_IDS.record ? t("ui.demo.recordTitle", lang) : title;
}

export function demoWorldlineLabel(id: string, label: string, lang: UiLanguage): string {
  return id === DEMO_IDS.worldline ? t("ui.demo.worldlineLabel", lang) : label;
}

// ---------- 场景字段 ----------

export function demoSceneText<T extends { location: string; worldTime: string; weather: string; tension: string; objective: string }>(
  scene: T,
  worldId: string,
  lang: UiLanguage,
): T {
  if (worldId !== DEMO_IDS.world) return scene;
  return {
    ...scene,
    location: t("ui.demo.sceneLocation", lang),
    worldTime: t("ui.demo.worldDisplayTime", lang),
    weather: t("ui.demo.worldWeather", lang),
    tension: t("ui.demo.worldTension", lang),
    objective: t("ui.demo.sceneObjective", lang),
  };
}

/** 导航条目的标题/世界时间（演示记录镜像值）。 */
export function demoNavRecordText<T extends { id: string; title: string; worldTime?: string }>(
  record: T,
  worldId: string,
  lang: UiLanguage,
): T {
  if (worldId !== DEMO_IDS.world || record.id !== DEMO_IDS.record) return record;
  return { ...record, title: t("ui.demo.recordTitle", lang), worldTime: t("ui.demo.worldDisplayTime", lang) };
}

// ---------- 角色（名字不翻译） ----------

const DEMO_CHARACTER_KEYS: Record<string, { role: string; summary: string }> = {
  [DEMO_IDS.playerDefinition]: { role: "ui.demo.charPlayerRole", summary: "ui.demo.charPlayerSummary" },
  [DEMO_IDS.scoutDefinition]: { role: "ui.demo.charScoutRole", summary: "ui.demo.charScoutSummary" },
  [DEMO_IDS.scholarDefinition]: { role: "ui.demo.charScholarRole", summary: "ui.demo.charScholarSummary" },
};

export function demoCharacterText<T extends { id: string; role: string; summary: string }>(
  character: T,
  lang: UiLanguage,
): T {
  const keys = DEMO_CHARACTER_KEYS[character.id];
  if (!keys) return character;
  return { ...character, role: t(keys.role, lang), summary: t(keys.summary, lang) };
}

// ---------- 开场旁白事件 ----------

interface DemoSegment { id: string; kind: string; content: string; speechMode: string }

const OPENING_SEGMENTS: Record<string, string> = {
  "environment-1": "ui.demo.openingEnvironment",
  "story-1": "ui.demo.openingStory",
  "fact-1": "ui.demo.openingFact",
};

export function demoEventText<T extends { id: string; speaker: string; content: string; worldTime: string; segments: readonly DemoSegment[] }>(
  event: T,
  lang: UiLanguage,
): T {
  if (event.id !== DEMO_IDS.openingEvent) return event;
  return {
    ...event,
    speaker: t("ui.demo.narrator", lang),
    content: t("ui.demo.openingContent", lang),
    worldTime: t("ui.demo.worldDisplayTime", lang),
    segments: event.segments.map((segment) => {
      const key = OPENING_SEGMENTS[segment.id];
      return key ? { ...segment, content: t(key, lang) } : segment;
    }),
  };
}

// ---------- 世界库快照（首页入口 / 世界库面板 / 大厅/视图数据源） ----------

export interface DemoLibraryShape {
  worlds: Array<{
    id: string;
    name: string;
    era: string;
    summary: string;
    characters: Array<{ id: string; role: string; summary: string }>;
    worldlines: Array<{ id: string; label: string }>;
    stories: Array<{
      id: string;
      title: string;
      premise: string;
      records: Array<{ id: string; title: string }>;
    }>;
  }>;
}

export function localizeDemoLibrary<T extends DemoLibraryShape>(snapshot: T, lang: UiLanguage): T {
  return {
    ...snapshot,
    worlds: snapshot.worlds.map((world) => {
      if (world.id !== DEMO_IDS.world) return world;
      return {
        ...demoWorldText(world, lang),
        characters: world.characters.map((character) => demoCharacterText(character, lang)),
        worldlines: world.worldlines.map((worldline) => ({
          ...worldline,
          label: demoWorldlineLabel(worldline.id, worldline.label, lang),
        })),
        stories: world.stories.map((story) => ({
          ...demoStoryText(story, lang),
          records: story.records.map((record) => ({
            ...record,
            title: demoRecordTitle(record.id, record.title, lang),
          })),
        })),
      };
    }),
  };
}

// ---------- 演示技能/资产/姿态（按种子标题精确匹配） ----------

const DEMO_AFFORDANCE_KEYS: Record<string, { title: string; description: string }> = {
  细致观察: { title: "ui.demo.skillTitle", description: "ui.demo.skillDescription" },
  雾港信号灯: { title: "ui.demo.assetTitle", description: "ui.demo.assetDescription" },
  警戒姿态: { title: "ui.demo.stanceTitle", description: "ui.demo.stanceDescription" },
};

export function demoAffordanceText<T extends { title: string; description: string }>(
  affordance: T,
  lang: UiLanguage,
): T {
  const keys = DEMO_AFFORDANCE_KEYS[affordance.title];
  if (!keys) return affordance;
  return { ...affordance, title: t(keys.title, lang), description: t(keys.description, lang) };
}
