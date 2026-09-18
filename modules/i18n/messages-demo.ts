/**
 * 演示世界固定模板文本批次表（ui.demo.*）。
 * 演示世界由系统种子生成，属固定模板内容：zh 值必须与
 * database/postgres/demo-seed.ts / modules/actions/demo-definitions.ts
 * 的原文逐字一致（契约测试强制）；en/ja 为同语义自然译文。
 * 角色名（洛川/塞娜/弥洛）是专有名词，三语保持原样不翻译。
 * 本文件自足类型，不从 public.ts 反向导入，避免循环依赖。
 */

type BatchTable = Record<"zh-CN" | "en" | "ja", string>;

const M = (zh: string, en: string, ja: string): BatchTable => ({ "zh-CN": zh, en, ja });

export const DEMO_MESSAGES: Record<string, BatchTable> = {
  // 世界层。
  "ui.demo.worldName": M("烬海诸国", "Embercoast Realms", "燼海の諸国"),
  "ui.demo.worldSummary": M("人魔停战十七年后，海上的无声钟再次响起。", "Seventeen years after the truce between humans and demons, the silent bell rings again at sea.", "人魔の停戦から十七年、海に無声の鐘が再び鳴り響く。"),
  "ui.demo.worldEra": M("停战纪元 17 年", "Year 17 of the Truce Era", "停戦紀17年"),
  "ui.demo.worldWeather": M("冷雾，无风", "Cold mist, no wind", "冷たい霧、風なし"),
  "ui.demo.worldTension": M("钟声已经响过三次", "The bell has tolled three times", "鐘は三度鳴り終えた"),
  "ui.demo.worldDisplayTime": M("停战纪元17年 · 雾月12日 · 入夜", "Truce Era Y17 · Mistmonth 12 · Nightfall", "停戦紀17年・霧月12日・入夜"),
  "ui.demo.worldlineLabel": M("原初世界线", "Original Worldline", "原初の世界線"),
  // 故事与记录。
  "ui.demo.storyTitle": M("无声钟的来客", "Guest of the Silent Bell", "無声鐘の来訪者"),
  "ui.demo.storyPremise": M("北岸灯塔在无风夜自行点亮，一封不属于任何阵营的密函被送上岸。", "On a windless night the north lighthouse lit itself, and a letter belonging to no faction was delivered ashore.", "風のない夜、北の灯台は自ら灯り、どの陣営にも属さぬ密函が岸に届けられた。"),
  "ui.demo.recordTitle": M("第一幕 · 雾港来信", "Act I · Letter from Mist Harbor", "第一幕・霧港の手紙"),
  // 场景（投影的 scene 对象承载 location/weather/tension/objective）。
  "ui.demo.sceneLocation": M("灰鲸港 · 北防波堤", "Graywhale Harbor · North Breakwater", "灰鯨港・北防波堤"),
  "ui.demo.sceneObjective": M("决定是否当众拆开密函", "Decide whether to open the sealed letter in public", "密函を衆目の前で開くか決断する"),
  // 角色（名字为专有名词，仅身份/简介翻译）。
  "ui.demo.charPlayerRole": M("人类使节", "Human envoy", "人間の使者"),
  "ui.demo.charPlayerSummary": M("停战议会派来的年轻调停人。", "A young mediator sent by the Truce Council.", "停戦議会から遣われた若き調停人。"),
  "ui.demo.charScoutRole": M("港卫斥候", "Harbor watch scout", "港衛の斥候"),
  "ui.demo.charScoutSummary": M("熟悉灰鲸港每一条暗巷，对异常极度警觉。", "Knows every alley of Graywhale Harbor and is wary of anything unusual.", "灰鯨港の裏路地を熟知し、異常に対して極めて警戒心が強い。"),
  "ui.demo.charScholarRole": M("魔族铭文学者", "Demon rune scholar", "魔族の銘文学者"),
  "ui.demo.charScholarSummary": M("温和寡言，能辨认战前的禁忌铭文。", "Gentle and quiet; can read the forbidden pre-war inscriptions.", "温和で口数が少なく、戦前の禁忌銘文を読み解ける。"),
  // 开场旁白（event_opening，固定模板； speaker + 三段 + 合文）。
  "ui.demo.narrator": M("旁白", "Narrator", "語り部"),
  "ui.demo.openingEnvironment": M("雾沿着石阶爬上防波堤。", "Mist climbs the breakwater along the stone steps.", "霧が石段を登り、防波堤へと迫る。"),
  "ui.demo.openingStory": M("信使放下蜡封完好的黑色信函。", "The courier sets down the black letter, its wax seal unbroken.", "使者は封蝋の完璧な黒い信函を置いた。"),
  "ui.demo.openingFact": M("远处灯塔的光随第三声钟鸣熄灭。", "Far off, the lighthouse light dies with the third bell toll.", "遠くの灯台の光は、三度目の鐘の音とともに消えた。"),
  // 合文（各语独立成段，自带正确标点间距；segment 拼接仅用于 zh 全角标点场景）。
  "ui.demo.openingContent": M(
    "雾沿着石阶爬上防波堤。信使放下蜡封完好的黑色信函。远处灯塔的光随第三声钟鸣熄灭。",
    "Mist climbs the breakwater along the stone steps. The courier sets down the black letter, its wax seal unbroken. Far off, the lighthouse light dies with the third bell toll.",
    "霧が石段を登り、防波堤へと迫る。使者は封蝋の完璧な黒い信函を置いた。遠くの灯台の光は、三度目の鐘の音とともに消えた。",
  ),
  // 演示技能/资产/姿态（标题+描述；结果模板属运行产出层，不翻译）。
  "ui.demo.skillTitle": M("细致观察", "Careful Observation", "細やかな観察"),
  "ui.demo.skillDescription": M("在不破坏目标的前提下辨认细微痕迹。", "Discern fine traces without disturbing the target.", "対象を損なわずに微かな痕跡を見分ける。"),
  "ui.demo.assetTitle": M("雾港信号灯", "Mist Harbor Signal Lantern", "霧港の信号灯"),
  "ui.demo.assetDescription": M("点亮一次短促的定向灯光，照出近处轮廓。", "Emits a brief directed beam that outlines what is near.", "短く指向性の高い光で、近くの輪郭を照らし出す。"),
  "ui.demo.stanceTitle": M("警戒姿态", "Guarded Watch", "警戒の姿勢"),
  "ui.demo.stanceDescription": M("收束动作并持续留意周围变化。", "Contain your movements and stay alert to changes around you.", "動きを抑え、周囲の変化に常に注意を払う。"),
};
