/**
 * Base 内置内容 · engine-owned 内容数据（内容解析层 §2.2 的 base 后端）。
 *
 * 本模块是以下既有硬编码内容语义的唯一事实来源（单一来源迁移）：
 * - database/postgres/demo-seed.ts 的演示世界（world_ember_coast）内容；
 * - modules/i18n/messages-demo.ts 的演示世界三语本地化文本；
 * - modules/actions/demo-definitions.ts 的演示 Action 定义载荷；
 * - modules/application/preset-worlds.ts 的三个 preset 世界三语手稿文案。
 *
 * client-safe 纯数据：不得 import node:* / pg / DB 模块。zh-CN 为规范
 * （canonical）语言——落库原文以 zh-CN 值为准；en/ja 为同语义自然译文。
 * 角色名（洛川/塞娜/弥洛等）为专有名词，三语保持原样不翻译。
 */
import type { JsonValue } from "../runtime/public.ts";
import type { ContentActionKind, ContentLanguage } from "./public.ts";

export type LocalizedText = Readonly<Record<ContentLanguage, string>>;

/** 三语快捷构造（zh 规范在前）。 */
const L = (zh: string, en: string, ja: string): LocalizedText =>
  ({ "zh-CN": zh, en, ja });

/** 专有名词：三语同文。 */
const PROPER = (name: string): LocalizedText => ({ "zh-CN": name, en: name, ja: name });

export interface BaseCharacterContent {
  characterKey: string;
  isPlayer: boolean;
  displayName: LocalizedText;
  role: LocalizedText;
  summary: LocalizedText;
}

export interface BaseActionContent {
  actionKind: ContentActionKind;
  actionKey: string;
  rulePackKey: string;
  consumable: boolean;
  /** stance/effect 类的 effect_kind；非 effect 类为 null。 */
  effectKind: string | null;
  title: LocalizedText;
  description: LocalizedText;
  /** 规则载荷（facts/结果模板以 {actor} 占位，规范文案层永不翻译）。 */
  metadata: Readonly<Record<string, JsonValue>>;
}

export interface BaseOpeningSegmentContent {
  id: string;
  kind: string;
  speechMode: string;
  content: LocalizedText;
}

export interface BaseWorldBundle {
  contentKey: string;
  style: string;
  calendarId: string;
  world: {
    name: LocalizedText;
    era: LocalizedText;
    summary: LocalizedText;
    weather: LocalizedText;
    tension: LocalizedText;
    displayTime: LocalizedText;
  };
  worldlineLabel: LocalizedText;
  story: { storyKey: string; title: LocalizedText; premise: LocalizedText };
  record: { title: LocalizedText };
  scene: {
    sceneKey: string;
    title: LocalizedText;
    location: LocalizedText;
    objective: LocalizedText;
  };
  /** 人类玩家在本世界中的角色定位（genesis playerRole）。 */
  playerRole: LocalizedText;
  playerStance: "player" | "observer";
  characters: readonly BaseCharacterContent[];
  actions: readonly BaseActionContent[];
  opening: {
    speaker: LocalizedText;
    content: LocalizedText;
    segments: readonly BaseOpeningSegmentContent[];
  };
  /** 随 genesis 物化的 engine-owned Goal keys（空 = 不声明）。 */
  goalKeys: readonly string[];
}

// ---------------------------------------------------------------------------
// 演示世界：烬海诸国（world_ember_coast 的内容层表达）
// ---------------------------------------------------------------------------

const EMBER_COAST: BaseWorldBundle = {
  contentKey: "ember-coast",
  style: "classical",
  calendarId: "truce_calendar",
  world: {
    name: L("烬海诸国", "Embercoast Realms", "燼海の諸国"),
    era: L("停战纪元 17 年", "Year 17 of the Truce Era", "停戦紀17年"),
    summary: L(
      "人魔停战十七年后，海上的无声钟再次响起。",
      "Seventeen years after the truce between humans and demons, the silent bell rings again at sea.",
      "人魔の停戦から十七年、海に無声の鐘が再び鳴り響く。",
    ),
    weather: L("冷雾，无风", "Cold mist, no wind", "冷たい霧、風なし"),
    tension: L("钟声已经响过三次", "The bell has tolled three times", "鐘は三度鳴り終えた"),
    displayTime: L(
      "停战纪元17年 · 雾月12日 · 入夜",
      "Truce Era Y17 · Mistmonth 12 · Nightfall",
      "停戦紀17年・霧月12日・入夜",
    ),
  },
  worldlineLabel: L("原初世界线", "Original Worldline", "原初の世界線"),
  story: {
    storyKey: "silent-bell",
    title: L("无声钟的来客", "Guest of the Silent Bell", "無声鐘の来訪者"),
    premise: L(
      "北岸灯塔在无风夜自行点亮，一封不属于任何阵营的密函被送上岸。",
      "On a windless night the north lighthouse lit itself, and a letter belonging to no faction was delivered ashore.",
      "風のない夜、北の灯台は自ら灯り、どの陣営にも属さぬ密函が岸に届けられた。",
    ),
  },
  record: {
    title: L("第一幕 · 雾港来信", "Act I · Letter from Mist Harbor", "第一幕・霧港の手紙"),
  },
  scene: {
    sceneKey: "north-breakwater",
    title: L("北防波堤", "North Breakwater", "北防波堤"),
    location: L("灰鲸港 · 北防波堤", "Graywhale Harbor · North Breakwater", "灰鯨港・北防波堤"),
    objective: L(
      "决定是否当众拆开密函",
      "Decide whether to open the sealed letter in public",
      "密函を衆目の前で開くか決断する",
    ),
  },
  playerRole: L("人类使节", "Human envoy", "人間の使者"),
  playerStance: "player",
  characters: [
    {
      characterKey: "player",
      isPlayer: true,
      displayName: PROPER("洛川"),
      role: L("人类使节", "Human envoy", "人間の使者"),
      summary: L(
        "停战议会派来的年轻调停人。",
        "A young mediator sent by the Truce Council.",
        "停戦議会から遣われた若き調停人。",
      ),
    },
    {
      characterKey: "scout",
      isPlayer: false,
      displayName: PROPER("塞娜"),
      role: L("港卫斥候", "Harbor watch scout", "港衛の斥候"),
      summary: L(
        "熟悉灰鲸港每一条暗巷，对异常极度警觉。",
        "Knows every alley of Graywhale Harbor and is wary of anything unusual.",
        "灰鯨港の裏路地を熟知し、異常に対して極めて警戒心が強い。",
      ),
    },
    {
      characterKey: "scholar",
      isPlayer: false,
      displayName: PROPER("弥洛"),
      role: L("魔族铭文学者", "Demon rune scholar", "魔族の銘文学者"),
      summary: L(
        "温和寡言，能辨认战前的禁忌铭文。",
        "Gentle and quiet; can read the forbidden pre-war inscriptions.",
        "温和で口数が少なく、戦前の禁忌銘文を読み解ける。",
      ),
    },
  ],
  actions: [
    {
      actionKind: "skill",
      actionKey: "careful_observation",
      rulePackKey: "realm.light.v1",
      consumable: false,
      effectKind: null,
      title: L("细致观察", "Careful Observation", "細やかな観察"),
      description: L(
        "在不破坏目标的前提下辨认细微痕迹。",
        "Discern fine traces without disturbing the target.",
        "対象を損なわずに微かな痕跡を見分ける。",
      ),
      metadata: {
        check: { system: "d20", modifier: 2, target: 12 },
        defaultTargetId: "letter_seal",
        outcomes: {
          success: "{actor}从雾气与潮痕之间辨认出了一处可靠的方向变化。",
          partial: "{actor}只辨认出一处尚不能确认的模糊痕迹。",
          failure: "雾气和潮水抹去了足够可靠的痕迹。",
          impossible: "当前环境不允许继续辨认痕迹。",
        },
        targets: {
          letter_seal: {
            success: "{actor}确认密函蜡封边缘存在一处被重新压合的细痕。",
            partial: "{actor}发现蜡封边缘有一处可疑细痕，但暂时无法确认成因。",
            failure: "蜡封表面的磨损不足以支持可靠判断。",
            impossible: "当前光线与环境不允许继续辨认蜡封细节。",
          },
        },
      },
    },
    {
      actionKind: "asset",
      actionKey: "signal_lantern",
      rulePackKey: "realm.light.v1",
      consumable: true,
      effectKind: null,
      title: L("雾港信号灯", "Mist Harbor Signal Lantern", "霧港の信号灯"),
      description: L(
        "点亮一次短促的定向灯光，照出近处轮廓。",
        "Emits a brief directed beam that outlines what is near.",
        "短く指向性の高い光で、近くの輪郭を照らし出す。",
      ),
      metadata: {
        outcomes: {
          success: "{actor}点亮雾港信号灯，短促的定向光束切开了近处雾幕。",
          partial: "信号灯只照出一小片模糊轮廓。",
          failure: "信号灯没有形成可用照明。",
          impossible: "当前无法安全点亮信号灯。",
        },
        privateObservation: "灯光只照亮近处，没有穿透更远的浓雾。",
      },
    },
    {
      actionKind: "stance",
      actionKey: "guarded_watch",
      rulePackKey: "realm.light.v1",
      consumable: false,
      effectKind: "stance",
      title: L("警戒姿态", "Guarded Watch", "警戒の姿勢"),
      description: L(
        "收束动作并持续留意周围变化。",
        "Contain your movements and stay alert to changes around you.",
        "動きを抑え、周囲の変化に常に注意を払う。",
      ),
      metadata: {
        outcomes: {
          success: "{actor}收束动作，进入持续留意周围变化的警戒姿态。",
          partial: "{actor}只能勉强维持警戒。",
          failure: "{actor}没能建立稳定警戒。",
          impossible: "当前无法进入警戒姿态。",
        },
      },
    },
  ],
  opening: {
    speaker: L("旁白", "Narrator", "語り部"),
    content: L(
      "雾沿着石阶爬上防波堤。信使放下蜡封完好的黑色信函。远处灯塔的光随第三声钟鸣熄灭。",
      "Mist climbs the breakwater along the stone steps. The courier sets down the black letter, its wax seal unbroken. Far off, the lighthouse light dies with the third bell toll.",
      "霧が石段を登り、防波堤へと迫る。使者は封蝋の完璧な黒い信函を置いた。遠くの灯台の光は、三度目の鐘の音とともに消えた。",
    ),
    segments: [
      {
        id: "environment-1",
        kind: "environment",
        speechMode: "narrator",
        content: L(
          "雾沿着石阶爬上防波堤。",
          "Mist climbs the breakwater along the stone steps.",
          "霧が石段を登り、防波堤へと迫る。",
        ),
      },
      {
        id: "story-1",
        kind: "story",
        speechMode: "narrator",
        content: L(
          "信使放下蜡封完好的黑色信函。",
          "The courier sets down the black letter, its wax seal unbroken.",
          "使者は封蝋の完璧な黒い信函を置いた。",
        ),
      },
      {
        id: "fact-1",
        kind: "fact",
        speechMode: "narrator",
        content: L(
          "远处灯塔的光随第三声钟鸣熄灭。",
          "Far off, the lighthouse light dies with the third bell toll.",
          "遠くの灯台の光は、三度目の鐘の音とともに消えた。",
        ),
      },
    ],
  },
  goalKeys: [],
};

// ---------------------------------------------------------------------------
// Preset 世界（引导屏/世界库入口的 engine-owned base 内容）
// ---------------------------------------------------------------------------

const DND_TAVERN: BaseWorldBundle = {
  contentKey: "dnd-tavern",
  style: "western_fantasy",
  calendarId: "native_calendar",
  world: {
    name: L("遗忘酒馆", "The Forgotten Tavern", "忘れられた酒場"),
    era: L("众神历 472 年", "Year 472 of the Gods", "神々暦472年"),
    summary: L(
      "边境小镇灰石镇的酒馆里，冒险者们刚接下一张泛黄的藏宝图。众神沉默，怪物重返荒野。",
      "In a border-town tavern in Greystone, adventurers have just accepted a yellowed treasure map. The gods are silent, and monsters are returning to the wilds.",
      "辺境の町グレイストーンの酒場で、冒険者たちは黄ばんだ宝の地図を手にした。神々は沈黙し、怪物たちが荒野へ戻り始めている。",
    ),
    weather: L("阴冷，壁炉烟味", "Cold air, smoke from the hearth", "冷たい空気、暖炉の煙"),
    tension: L("悬赏令刚贴上墙", "The bounty notice has just gone up", "賞金依頼が壁に貼られたばかり"),
    displayTime: L("", "", ""),
  },
  worldlineLabel: L("原初世界线", "Original Worldline", "原初の世界線"),
  story: {
    storyKey: "greystone-commission",
    title: L("灰石镇的委托", "The Greystone Commission", "グレイストーンの依頼"),
    premise: L(
      "镇卫队无力应对近期频发的商队失踪事件。酒馆老板秘密张贴了一张悬赏，而泛黄地图上的标记指向一座早已被遗忘的古墓。",
      "The town guard cannot keep up with the recent caravan disappearances. The tavern keeper has posted a secret bounty, and the mark on the yellowed map points to a long-forgotten tomb.",
      "相次ぐ隊商失踪に町の衛兵は手を焼いていた。酒場の主人が密かに賞金依頼を貼り、黄ばんだ地図の印は忘れられた古墓を指している。",
    ),
  },
  record: {
    title: L("第一幕 · 酒馆的委托", "Act I · The Tavern's Commission", "第一幕 · 酒場の依頼"),
  },
  scene: {
    sceneKey: "rusted-anchor",
    title: L("", "", ""),
    location: L("灰石镇 · 锈锚酒馆", "Greystone · Rusted Anchor Tavern", "グレイストーン · 錆びた錨亭"),
    objective: L(
      "决定是否接下酒馆的委托",
      "Decide whether to take the tavern's commission",
      "酒場の依頼を引き受けるか決める",
    ),
  },
  playerRole: L("退役镇卫剑士", "Retired town-guard swordsman", "元町衛兵の剣士"),
  playerStance: "player",
  characters: [
    {
      characterKey: "companion-1",
      isPlayer: false,
      displayName: PROPER("艾尔德"),
      role: L("精灵游侠", "Elven ranger", "エルフのレンジャー"),
      summary: L(
        "沉默寡言的追踪者，能在落叶下分辨出三天前的足迹。",
        "A quiet tracker who can read a three-day-old trail beneath fallen leaves.",
        "寡黙な追跡者。落ち葉の下から三日前の足跡さえ見つけ出す。",
      ),
    },
    {
      characterKey: "companion-2",
      isPlayer: false,
      displayName: PROPER("布罗克"),
      role: L("矮人牧师", "Dwarven cleric", "ドワーフの聖職者"),
      summary: L(
        "摩拉丁的虔诚信徒，锤子既能祈福也能砸碎骷髅。",
        "A devout follower of Moradin; his hammer can bless the faithful or break a skeleton.",
        "モラディンを信じる敬虔な信徒。祝福にも骸骨砕きにも同じ槌を振るう。",
      ),
    },
  ],
  actions: [],
  opening: {
    speaker: L("旁白", "Narrator", "語り部"),
    content: L(
      "酒馆的木门被撞开，一个浑身是泥的信使跌跌撞撞地倒在吧台前。他手里攥着一张泛黄地图，嘴里只重复着一句话：'它们醒了。'",
      "The tavern door crashes open. A mud-covered messenger staggers to the bar, clutching a yellowed map and repeating only one sentence: 'They have awakened.'",
      "酒場の扉が激しく開いた。泥まみれの伝令が黄ばんだ地図を握ったままカウンターへ倒れ込み、ただ一言を繰り返す。『奴らが目覚めた』。",
    ),
    segments: [],
  },
  goalKeys: [],
};

const ANIME_HERO: BaseWorldBundle = {
  contentKey: "anime-hero",
  style: "anime",
  calendarId: "native_calendar",
  world: {
    name: L("魔王城前的村庄", "The Village Before the Demon King's Castle", "魔王城前の村"),
    era: L("星历 元号元年", "Year One of the Star Calendar", "星暦 元年"),
    summary: L(
      "被选中的勇者刚刚离开新手村，魔王军的影子已经笼罩东边的山脉。预言书缺了最后一页。",
      "The chosen hero has just left the beginner's village, while the Demon King's shadow already covers the eastern mountains. The final page of the prophecy is missing.",
      "選ばれた勇者は始まりの村を出たばかりだというのに、魔王軍の影は東の山々を覆っていた。予言書の最後の一頁だけが欠けている。",
    ),
    weather: L("晴朗，风车转动", "Clear skies, the windmill turning", "晴天、風車が回っている"),
    tension: L("送行人群中混着可疑黑袍人", "A suspicious figure in black stands among the farewell crowd", "見送りの人々に怪しい黒衣の人物が紛れている"),
    displayTime: L("", "", ""),
  },
  worldlineLabel: L("原初世界线", "Original Worldline", "原初の世界線"),
  story: {
    storyKey: "morning-star",
    title: L("启程的晨星", "The Morning Star of Departure", "旅立ちの明星"),
    premise: L(
      "绿野村是勇者踏上征途前的最后一站。村长把一柄传说中的剑交给你，但剑鞘里装的似乎是把仿制品。",
      "Greenfield Village is the hero's last stop before the journey begins. The elder hands you a legendary sword, but something inside its scabbard feels like a replica.",
      "緑野村は、勇者が旅に出る前の最後の立ち寄り先だ。村長から伝説の剣を渡されたが、鞘に収まっているのはどうやら模造品らしい。",
    ),
  },
  record: {
    title: L("第一幕 · 村口的告别", "Act I · Farewell at the Village Gate", "第一幕 · 村門の別れ"),
  },
  scene: {
    sceneKey: "central-square",
    title: L("", "", ""),
    location: L("绿野村 · 中央广场", "Greenfield Village · Central Square", "緑野村 · 中央広場"),
    objective: L(
      "在出发前去见村长还是直接上路",
      "Decide whether to see the elder before leaving or set out at once",
      "出発前に村長へ会うか、そのまま旅立つか決める",
    ),
  },
  playerRole: L("勇者候补", "Candidate hero", "勇者候補"),
  playerStance: "player",
  characters: [
    {
      characterKey: "companion-1",
      isPlayer: false,
      displayName: PROPER("莉莉"),
      role: L("妖精神官", "Fairy shrine maiden", "妖精の神官"),
      summary: L(
        "总是念着“魔力值不够了”，但关键时刻的治疗从不落空。",
        "Always muttering that her mana is running low, yet her healing never misses when it matters.",
        "いつも『魔力が足りない』とこぼすのに、肝心な時の治療は決して外さない。",
      ),
    },
    {
      characterKey: "companion-2",
      isPlayer: false,
      displayName: PROPER("加尔姆"),
      role: L("兽人剑士", "Beastfolk swordsman", "獣人の剣士"),
      summary: L(
        "外表凶恶内心温柔，负责吐槽勇者的一时冲动。",
        "Fierce on the outside and gentle within, he is the voice that questions the hero's impulses.",
        "見た目は怖いが心は優しく、勇者の勢い任せな行動にツッコミを入れる。",
      ),
    },
  ],
  actions: [],
  opening: {
    speaker: L("旁白", "Narrator", "語り部"),
    content: L(
      "村口的钟声响了七下，老村长把传说之剑的仿制品塞到你手里。远处的山脉上方，一片不该存在的乌云正在聚集。",
      "The village bell rings seven times. The old elder presses a replica of the legendary sword into your hands. Above the distant mountains, a cloud that should not exist is gathering.",
      "村の鐘が七度鳴った。老村長は伝説の剣の模造品をあなたの手に押し込む。遠い山脈の上空では、あるはずのない黒雲が集まり始めていた。",
    ),
    segments: [],
  },
  goalKeys: [],
};

const URBAN_CULTIVATION: BaseWorldBundle = {
  contentKey: "urban-cultivation",
  style: "modern",
  calendarId: "native_calendar",
  world: {
    name: L("灵气复苏的咖啡馆", "The Spirit-Risen Café", "霊気復興のカフェ"),
    era: L("新历 2026 年", "New Calendar, 2026", "新暦2026年"),
    summary: L(
      "灵气复苏三年后，你经营的听雨阁咖啡馆成了都市修士们交换情报的据点。外卖订单里偶尔夹着符箓。",
      "Three years after spiritual energy returned, your Tingyu Pavilion café has become a quiet exchange point for urban cultivators. Talismans occasionally turn up inside delivery orders.",
      "霊気が戻って三年。あなたの営む聴雨閣カフェは、都市の修士たちが情報を交換する拠点になっていた。出前の注文に符が紛れ込むこともある。",
    ),
    weather: L("暴雨，霓虹倒影", "Torrential rain, neon reflections", "豪雨、ネオンの反射"),
    tension: L("最后一位客人还没走", "The last customer has not left", "最後の客がまだ帰っていない"),
    displayTime: L("", "", ""),
  },
  worldlineLabel: L("原初世界线", "Original Worldline", "原初の世界線"),
  story: {
    storyKey: "rainy-night-visitor",
    title: L("雨夜来客", "A Visitor on a Rainy Night", "雨夜の来客"),
    premise: L(
      "今晚打烊前，一位浑身湿透的客人点了一杯美式，却在你耳边低声说：“三小时后，东华大桥会塌。”",
      "Before closing, a drenched customer orders an Americano and whispers in your ear: 'In three hours, Donghua Bridge will collapse.'",
      "閉店前、ずぶ濡れの客がアメリカーノを一杯頼み、あなたの耳元で囁いた。『三時間後、東華大橋が崩れる』。",
    ),
  },
  record: {
    title: L("第一幕 · 打烊前的客人", "Act I · The Customer Before Closing", "第一幕 · 閉店前の客"),
  },
  scene: {
    sceneKey: "window-seat",
    title: L("", "", ""),
    location: L("听雨阁 · 二楼靠窗座", "Tingyu Pavilion · Upstairs window seat", "聴雨閣 · 二階の窓際席"),
    objective: L(
      "决定如何处理客人留下的警告",
      "Decide what to do with the warning the customer left behind",
      "客が残した警告をどう扱うか決める",
    ),
  },
  playerRole: L("金丹期散修店主", "Golden-core rogue cultivator and café owner", "金丹期の散修である店主"),
  playerStance: "player",
  characters: [
    {
      characterKey: "companion-1",
      isPlayer: false,
      displayName: PROPER("苏晚晴"),
      role: L("风水师学徒", "Feng shui apprentice", "風水師見習い"),
      summary: L(
        "总在店里蹭 Wi-Fi，却能在关键时刻点出阵眼所在。",
        "She is always borrowing the café Wi-Fi, yet can identify the formation's eye when it matters.",
        "店のWi-Fiをいつも借りているが、肝心な時には陣の要を言い当てる。",
      ),
    },
    {
      characterKey: "companion-2",
      isPlayer: false,
      displayName: PROPER("老周"),
      role: L("退休剑修", "Retired sword cultivator", "引退した剣修"),
      summary: L(
        "每天准时来喝美式，腰间藏着的断剑从不离身。",
        "He arrives for an Americano at the same time every day, carrying a broken sword at his waist.",
        "毎日決まった時間にアメリカーノを飲みに来る。腰の折れた剣を決して手放さない。",
      ),
    },
  ],
  actions: [],
  opening: {
    speaker: L("旁白", "Narrator", "語り部"),
    content: L(
      "雨刷器在玻璃上划出最后一道弧线，门铃响时你正要把营业中翻成休息。浑身湿透的客人坐下，只点了一杯美式。",
      "The wipers draw their final arc across the glass just as you turn the sign from open to closed. A soaked customer sits down and orders only an Americano.",
      "ガラスを払うワイパーが最後の弧を描いた時、あなたは営業中の札を裏返そうとしていた。そこへずぶ濡れの客が座り、アメリカーノを一杯だけ注文する。",
    ),
    segments: [],
  },
  goalKeys: [],
};

/** engine-owned base 内容 bundle 注册表（key 即 contentKey / preset key）。 */
export const BASE_WORLD_BUNDLES: Readonly<Record<string, BaseWorldBundle>> = Object.freeze({
  "ember-coast": EMBER_COAST,
  "dnd-tavern": DND_TAVERN,
  "anime-hero": ANIME_HERO,
  "urban-cultivation": URBAN_CULTIVATION,
});

/** 演示世界（demo seed 兼容 shim）的 bundle key。 */
export const BASE_DEMO_CONTENT_KEY = "ember-coast";

/** preset 入口可用的 base bundle keys（演示世界不经 preset 入口创建）。 */
export const BASE_PRESET_CONTENT_KEYS = ["dnd-tavern", "anime-hero", "urban-cultivation"] as const;
