import type { WorldGenesisDraft } from "./world-genesis-contract.ts";

export type PresetWorldKey = "dnd-tavern" | "anime-hero" | "urban-cultivation";

export interface PresetWorld {
  key: PresetWorldKey;
  /** 界面展示用短标题（i18n key）。 */
  titleKey: string;
  /** 界面展示用一句话描述（i18n key）。 */
  descriptionKey: string;
  /** 用于世界库/引导屏标签分类。 */
  tagKey: string;
  draft: WorldGenesisDraft;
}

const DND_TAVERN: PresetWorld = {
  key: "dnd-tavern",
  titleKey: "ui.presetWorld.dndTavern.title",
  descriptionKey: "ui.presetWorld.dndTavern.description",
  tagKey: "ui.presetWorld.tagWesternFantasy",
  draft: {
    world: {
      name: "遗忘酒馆",
      era: "众神历 472 年",
      summary:
        "边境小镇灰石镇的酒馆里，冒险者们刚接下一张泛黄的藏宝图。众神沉默，怪物重返荒野。",
    },
    style: "western_fantasy",
    story: {
      title: "灰石镇的委托",
      premise:
        "镇卫队无力应对近期频发的商队失踪事件。酒馆老板秘密张贴了一张悬赏，而泛黄地图上的标记指向一座早已被遗忘的古墓。",
    },
    record: { title: "第一幕 · 酒馆的委托" },
    playerRole: "退役镇卫剑士",
    companions: [
      {
        name: "艾尔德",
        role: "精灵游侠",
        summary: "沉默寡言的追踪者，能在落叶下分辨出三天前的足迹。",
      },
      {
        name: "布罗克",
        role: "矮人牧师",
        summary: "摩拉丁的虔诚信徒，锤子既能祈福也能砸碎骷髅。",
      },
    ],
    scene: {
      location: "灰石镇 · 锈锚酒馆",
      weather: "阴冷，壁炉烟味",
      tension: "悬赏令刚贴上墙",
      objective: "决定是否接下酒馆的委托",
    },
    playerStance: "player",
    opening:
      "酒馆的木门被撞开，一个浑身是泥的信使跌跌撞撞地倒在吧台前。他手里攥着一张泛黄地图，嘴里只重复着一句话：'它们醒了。'",
  },
};

const ANIME_HERO: PresetWorld = {
  key: "anime-hero",
  titleKey: "ui.presetWorld.animeHero.title",
  descriptionKey: "ui.presetWorld.animeHero.description",
  tagKey: "ui.presetWorld.tagAnime",
  draft: {
    world: {
      name: "魔王城前的村庄",
      era: "星历 元号元年",
      summary:
        "被选中的勇者刚刚离开新手村，魔王军的影子已经笼罩东边的山脉。预言书缺了最后一页。",
    },
    style: "anime",
    story: {
      title: "启程的晨星",
      premise:
        "绿野村是勇者踏上征途前的最后一站。村长把一柄传说中的剑交给你，但剑鞘里装的似乎是把仿制品。",
    },
    record: { title: "第一幕 · 村口的告别" },
    playerRole: "勇者候补",
    companions: [
      {
        name: "莉莉",
        role: "妖精神官",
        summary: "总是念着'魔力值不够了'，但关键时刻的治疗从不落空。",
      },
      {
        name: "加尔姆",
        role: "兽人剑士",
        summary: "外表凶恶内心温柔，负责吐槽勇者的一时冲动。",
      },
    ],
    scene: {
      location: "绿野村 · 中央广场",
      weather: "晴朗，风车转动",
      tension: "送行人群中混着可疑黑袍人",
      objective: "在出发前去见村长还是直接上路",
    },
    playerStance: "player",
    opening:
      "村口的钟声响了七下，老村长把传说之剑的仿制品塞到你手里。远处的山脉上方，一片不该存在的乌云正在聚集。",
  },
};

const URBAN_CULTIVATION: PresetWorld = {
  key: "urban-cultivation",
  titleKey: "ui.presetWorld.urbanCultivation.title",
  descriptionKey: "ui.presetWorld.urbanCultivation.description",
  tagKey: "ui.presetWorld.tagModern",
  draft: {
    world: {
      name: "灵气复苏的咖啡馆",
      era: "新历 2026 年",
      summary:
        "灵气复苏三年后，你经营的听雨阁咖啡馆成了都市修士们交换情报的据点。外卖订单里偶尔夹着符箓。",
    },
    style: "modern",
    story: {
      title: "雨夜来客",
      premise:
        "今晚打烊前，一位浑身湿透的客人点了一杯美式，却在你耳边低声说：'三小时后，东华大桥会塌。'",
    },
    record: { title: "第一幕 · 打烊前的客人" },
    playerRole: "金丹期散修店主",
    companions: [
      {
        name: "苏晚晴",
        role: "风水师学徒",
        summary: "总在店里蹭 Wi-Fi，却能在关键时刻点出阵眼所在。",
      },
      {
        name: "老周",
        role: "退休剑修",
        summary: "每天准时来喝美式，腰间藏着的断剑从不离身。",
      },
    ],
    scene: {
      location: "听雨阁 · 二楼靠窗座",
      weather: "暴雨，霓虹倒影",
      tension: "最后一位客人还没走",
      objective: "决定如何处理客人留下的警告",
    },
    playerStance: "player",
    opening:
      "雨刷器在玻璃上划出最后一道弧线，门铃响时你正要把营业中翻成休息。浑身湿透的客人坐下，只点了一杯美式。",
  },
};

const PRESET_WORLDS: Record<PresetWorldKey, PresetWorld> = {
  "dnd-tavern": DND_TAVERN,
  "anime-hero": ANIME_HERO,
  "urban-cultivation": URBAN_CULTIVATION,
};

export const PRESET_WORLD_KEYS = Object.keys(PRESET_WORLDS) as PresetWorldKey[];

export function getPresetWorld(key: string): PresetWorld | undefined {
  return PRESET_WORLDS[key as PresetWorldKey];
}

export function listPresetWorlds(): readonly PresetWorld[] {
  return PRESET_WORLD_KEYS.map((key) => PRESET_WORLDS[key]);
}
