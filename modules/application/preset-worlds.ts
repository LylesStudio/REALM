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

type LocalizedCopy = Omit<WorldGenesisDraft, "style" | "playerStance" | "language">;

const DND_TAVERN_ZH: LocalizedCopy = {
  world: {
    name: "遗忘酒馆",
    era: "众神历 472 年",
    summary:
      "边境小镇灰石镇的酒馆里，冒险者们刚接下一张泛黄的藏宝图。众神沉默，怪物重返荒野。",
  },
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
  opening:
    "酒馆的木门被撞开，一个浑身是泥的信使跌跌撞撞地倒在吧台前。他手里攥着一张泛黄地图，嘴里只重复着一句话：'它们醒了。'",
};

const DND_TAVERN_EN: LocalizedCopy = {
  world: {
    name: "The Forgotten Tavern",
    era: "Year 472 of the Gods",
    summary:
      "In a border-town tavern in Greystone, adventurers have just accepted a yellowed treasure map. The gods are silent, and monsters are returning to the wilds.",
  },
  story: {
    title: "The Greystone Commission",
    premise:
      "The town guard cannot keep up with the recent caravan disappearances. The tavern keeper has posted a secret bounty, and the mark on the yellowed map points to a long-forgotten tomb.",
  },
  record: { title: "Act I · The Tavern's Commission" },
  playerRole: "Retired town-guard swordsman",
  companions: [
    {
      name: "Aeld",
      role: "Elven ranger",
      summary: "A quiet tracker who can read a three-day-old trail beneath fallen leaves.",
    },
    {
      name: "Brock",
      role: "Dwarven cleric",
      summary: "A devout follower of Moradin; his hammer can bless the faithful or break a skeleton.",
    },
  ],
  scene: {
    location: "Greystone · Rusted Anchor Tavern",
    weather: "Cold air, smoke from the hearth",
    tension: "The bounty notice has just gone up",
    objective: "Decide whether to take the tavern's commission",
  },
  opening:
    "The tavern door crashes open. A mud-covered messenger staggers to the bar, clutching a yellowed map and repeating only one sentence: 'They have awakened.'",
};

const DND_TAVERN_JA: LocalizedCopy = {
  world: {
    name: "忘れられた酒場",
    era: "神々暦472年",
    summary:
      "辺境の町グレイストーンの酒場で、冒険者たちは黄ばんだ宝の地図を手にした。神々は沈黙し、怪物たちが荒野へ戻り始めている。",
  },
  story: {
    title: "グレイストーンの依頼",
    premise:
      "相次ぐ隊商失踪に町の衛兵は手を焼いていた。酒場の主人が密かに賞金依頼を貼り、黄ばんだ地図の印は忘れられた古墓を指している。",
  },
  record: { title: "第一幕 · 酒場の依頼" },
  playerRole: "元町衛兵の剣士",
  companions: [
    {
      name: "エイルド",
      role: "エルフのレンジャー",
      summary: "寡黙な追跡者。落ち葉の下から三日前の足跡さえ見つけ出す。",
    },
    {
      name: "ブロック",
      role: "ドワーフの聖職者",
      summary: "モラディンを信じる敬虔な信徒。祝福にも骸骨砕きにも同じ槌を振るう。",
    },
  ],
  scene: {
    location: "グレイストーン · 錆びた錨亭",
    weather: "冷たい空気、暖炉の煙",
    tension: "賞金依頼が壁に貼られたばかり",
    objective: "酒場の依頼を引き受けるか決める",
  },
  opening:
    "酒場の扉が激しく開いた。泥まみれの伝令が黄ばんだ地図を握ったままカウンターへ倒れ込み、ただ一言を繰り返す。『奴らが目覚めた』。",
};

const ANIME_HERO_ZH: LocalizedCopy = {
  world: {
    name: "魔王城前的村庄",
    era: "星历 元号元年",
    summary:
      "被选中的勇者刚刚离开新手村，魔王军的影子已经笼罩东边的山脉。预言书缺了最后一页。",
  },
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
      summary: "总是念着“魔力值不够了”，但关键时刻的治疗从不落空。",
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
  opening:
    "村口的钟声响了七下，老村长把传说之剑的仿制品塞到你手里。远处的山脉上方，一片不该存在的乌云正在聚集。",
};

const ANIME_HERO_EN: LocalizedCopy = {
  world: {
    name: "The Village Before the Demon King's Castle",
    era: "Year One of the Star Calendar",
    summary:
      "The chosen hero has just left the beginner's village, while the Demon King's shadow already covers the eastern mountains. The final page of the prophecy is missing.",
  },
  story: {
    title: "The Morning Star of Departure",
    premise:
      "Greenfield Village is the hero's last stop before the journey begins. The elder hands you a legendary sword, but something inside its scabbard feels like a replica.",
  },
  record: { title: "Act I · Farewell at the Village Gate" },
  playerRole: "Candidate hero",
  companions: [
    {
      name: "Lily",
      role: "Fairy shrine maiden",
      summary: "Always muttering that her mana is running low, yet her healing never misses when it matters.",
    },
    {
      name: "Garm",
      role: "Beastfolk swordsman",
      summary: "Fierce on the outside and gentle within, he is the voice that questions the hero's impulses.",
    },
  ],
  scene: {
    location: "Greenfield Village · Central Square",
    weather: "Clear skies, the windmill turning",
    tension: "A suspicious figure in black stands among the farewell crowd",
    objective: "Decide whether to see the elder before leaving or set out at once",
  },
  opening:
    "The village bell rings seven times. The old elder presses a replica of the legendary sword into your hands. Above the distant mountains, a cloud that should not exist is gathering.",
};

const ANIME_HERO_JA: LocalizedCopy = {
  world: {
    name: "魔王城前の村",
    era: "星暦 元年",
    summary:
      "選ばれた勇者は始まりの村を出たばかりだというのに、魔王軍の影は東の山々を覆っていた。予言書の最後の一頁だけが欠けている。",
  },
  story: {
    title: "旅立ちの明星",
    premise:
      "緑野村は、勇者が旅に出る前の最後の立ち寄り先だ。村長から伝説の剣を渡されたが、鞘に収まっているのはどうやら模造品らしい。",
  },
  record: { title: "第一幕 · 村門の別れ" },
  playerRole: "勇者候補",
  companions: [
    {
      name: "リリィ",
      role: "妖精の神官",
      summary: "いつも『魔力が足りない』とこぼすのに、肝心な時の治療は決して外さない。",
    },
    {
      name: "ガルム",
      role: "獣人の剣士",
      summary: "見た目は怖いが心は優しく、勇者の勢い任せな行動にツッコミを入れる。",
    },
  ],
  scene: {
    location: "緑野村 · 中央広場",
    weather: "晴天、風車が回っている",
    tension: "見送りの人々に怪しい黒衣の人物が紛れている",
    objective: "出発前に村長へ会うか、そのまま旅立つか決める",
  },
  opening:
    "村の鐘が七度鳴った。老村長は伝説の剣の模造品をあなたの手に押し込む。遠い山脈の上空では、あるはずのない黒雲が集まり始めていた。",
};

const URBAN_CULTIVATION_ZH: LocalizedCopy = {
  world: {
    name: "灵气复苏的咖啡馆",
    era: "新历 2026 年",
    summary:
      "灵气复苏三年后，你经营的听雨阁咖啡馆成了都市修士们交换情报的据点。外卖订单里偶尔夹着符箓。",
  },
  story: {
    title: "雨夜来客",
    premise:
      "今晚打烊前，一位浑身湿透的客人点了一杯美式，却在你耳边低声说：“三小时后，东华大桥会塌。”",
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
  opening:
    "雨刷器在玻璃上划出最后一道弧线，门铃响时你正要把营业中翻成休息。浑身湿透的客人坐下，只点了一杯美式。",
};

const URBAN_CULTIVATION_EN: LocalizedCopy = {
  world: {
    name: "The Spirit-Risen Café",
    era: "New Calendar, 2026",
    summary:
      "Three years after spiritual energy returned, your Tingyu Pavilion café has become a quiet exchange point for urban cultivators. Talismans occasionally turn up inside delivery orders.",
  },
  story: {
    title: "A Visitor on a Rainy Night",
    premise:
      "Before closing, a drenched customer orders an Americano and whispers in your ear: 'In three hours, Donghua Bridge will collapse.'",
  },
  record: { title: "Act I · The Customer Before Closing" },
  playerRole: "Golden-core rogue cultivator and café owner",
  companions: [
    {
      name: "Wanqing Su",
      role: "Feng shui apprentice",
      summary: "She is always borrowing the café Wi-Fi, yet can identify the formation's eye when it matters.",
    },
    {
      name: "Old Zhou",
      role: "Retired sword cultivator",
      summary: "He arrives for an Americano at the same time every day, carrying a broken sword at his waist.",
    },
  ],
  scene: {
    location: "Tingyu Pavilion · Upstairs window seat",
    weather: "Torrential rain, neon reflections",
    tension: "The last customer has not left",
    objective: "Decide what to do with the warning the customer left behind",
  },
  opening:
    "The wipers draw their final arc across the glass just as you turn the sign from open to closed. A soaked customer sits down and orders only an Americano.",
};

const URBAN_CULTIVATION_JA: LocalizedCopy = {
  world: {
    name: "霊気復興のカフェ",
    era: "新暦2026年",
    summary:
      "霊気が戻って三年。あなたの営む聴雨閣カフェは、都市の修士たちが情報を交換する拠点になっていた。出前の注文に符が紛れ込むこともある。",
  },
  story: {
    title: "雨夜の来客",
    premise:
      "閉店前、ずぶ濡れの客がアメリカーノを一杯頼み、あなたの耳元で囁いた。『三時間後、東華大橋が崩れる』。",
  },
  record: { title: "第一幕 · 閉店前の客" },
  playerRole: "金丹期の散修である店主",
  companions: [
    {
      name: "蘇晩晴",
      role: "風水師見習い",
      summary: "店のWi-Fiをいつも借りているが、肝心な時には陣の要を言い当てる。",
    },
    {
      name: "老周",
      role: "引退した剣修",
      summary: "毎日決まった時間にアメリカーノを飲みに来る。腰の折れた剣を決して手放さない。",
    },
  ],
  scene: {
    location: "聴雨閣 · 二階の窓際席",
    weather: "豪雨、ネオンの反射",
    tension: "最後の客がまだ帰っていない",
    objective: "客が残した警告をどう扱うか決める",
  },
  opening:
    "ガラスを払うワイパーが最後の弧を描いた時、あなたは営業中の札を裏返そうとしていた。そこへずぶ濡れの客が座り、アメリカーノを一杯だけ注文する。",
};

const COPY: Record<PresetWorldKey, Record<GenesisLanguage, LocalizedCopy>> = {
  "dnd-tavern": { "zh-CN": DND_TAVERN_ZH, en: DND_TAVERN_EN, ja: DND_TAVERN_JA },
  "anime-hero": { "zh-CN": ANIME_HERO_ZH, en: ANIME_HERO_EN, ja: ANIME_HERO_JA },
  "urban-cultivation": {
    "zh-CN": URBAN_CULTIVATION_ZH,
    en: URBAN_CULTIVATION_EN,
    ja: URBAN_CULTIVATION_JA,
  },
};

function draftFor(key: PresetWorldKey, language: GenesisLanguage): WorldGenesisDraft {
  const copy = COPY[key][language];
  const style = key === "dnd-tavern"
    ? "western_fantasy"
    : key === "anime-hero"
      ? "anime"
      : "modern";
  return {
    ...copy,
    style,
    playerStance: "player",
    language,
  };
}

function withLocalizedDrafts(world: Omit<PresetWorld, "draft" | "drafts">): PresetWorld {
  const drafts = {
    "zh-CN": draftFor(world.key, "zh-CN"),
    en: draftFor(world.key, "en"),
    ja: draftFor(world.key, "ja"),
  } as const;
  return { ...world, draft: drafts["zh-CN"], drafts };
}

const PRESET_WORLDS: Record<PresetWorldKey, PresetWorld> = {
  "dnd-tavern": withLocalizedDrafts({
    key: "dnd-tavern",
    titleKey: "ui.presetWorld.dndTavern.title",
    descriptionKey: "ui.presetWorld.dndTavern.description",
    tagKey: "ui.presetWorld.tagWesternFantasy",
  }),
  "anime-hero": withLocalizedDrafts({
    key: "anime-hero",
    titleKey: "ui.presetWorld.animeHero.title",
    descriptionKey: "ui.presetWorld.animeHero.description",
    tagKey: "ui.presetWorld.tagAnime",
  }),
  "urban-cultivation": withLocalizedDrafts({
    key: "urban-cultivation",
    titleKey: "ui.presetWorld.urbanCultivation.title",
    descriptionKey: "ui.presetWorld.urbanCultivation.description",
    tagKey: "ui.presetWorld.tagModern",
  }),
};

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
