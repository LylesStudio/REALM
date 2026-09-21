/**
 * 世界文风系统（docs/development/WORLD-STYLE-SYSTEM.md）。
 *
 * 结构按 key 组织、语言可扩展：TEMPLATES[key][language][style]。
 * 当前仅中文（zh-CN）；批次 Q 的 i18n 只加语言维度，不改 key。
 */

export const WORLD_STYLE_KEYS = [
  "modern",
  "classical",
  "western_fantasy",
  "anime",
] as const;

export type WorldStyle = (typeof WORLD_STYLE_KEYS)[number];

export const DEFAULT_WORLD_STYLE: WorldStyle = "modern";

/** 未知/缺失值一律 fail-closed 到 modern。 */
export function normalizeWorldStyle(value: unknown): WorldStyle {
  return typeof value === "string"
    && (WORLD_STYLE_KEYS as readonly string[]).includes(value)
    ? (value as WorldStyle)
    : DEFAULT_WORLD_STYLE;
}

/** 风格描述数据：prompt 注入用的结构化约束（非单个名词）。 */
export interface WorldStyleProfile {
  label: string;
  tone: string;
  diction: string;
  imagery: string;
  sample: string;
}

export const WORLD_STYLE_PROFILES: Record<WorldStyle, WorldStyleProfile> = {
  modern: {
    label: "现代",
    tone: "平实自然的现代白话，节奏明快，不端着。",
    diction: "避免之乎者也等文言腔与古语词汇，使用当代口语与常见书面语。",
    imagery: "意象取自当代生活与自然环境（街道、灯火、手机、车辆、天气）。",
    sample: "我把背包放在一边，先检查手机有没有信号。",
  },
  classical: {
    label: "古风",
    tone: "克制蕴藉的古风笔调，讲究留白与分寸。",
    diction: "可用浅近文言与旧式称谓，避免现代词汇与外来语。",
    imagery: "意象取自山水器物、节令气象（雾、潮、钟声、灯火、信笺）。",
    sample: "雾沿着石阶漫上来，钟声在远处停住。",
  },
  western_fantasy: {
    label: "西幻",
    tone: "史诗而庄重的奇幻笔调，带一点译制腔的秩序感。",
    diction: "使用公会、誓约、纹章、旅队等西式奇幻词汇，避免东方古典意象。",
    imagery: "意象取自城堡、森林、篝火、纹章与荒野。",
    sample: "篝火在营地中央噼啪作响，远方的塔楼只剩一道剪影。",
  },
  anime: {
    label: "二次元",
    tone: "轻快明亮的日式动画腔，情绪外露、节奏跳跃。",
    diction: "可用语气词与轻吐槽（呢、啦、嘛、的说），避免沉重书面语。",
    imagery: "意象色彩鲜亮（蓝天、波光、招牌、放学路、便利店灯光）。",
    sample: "好耶！接下来的路，一起加油吧！",
  },
};

/** prompt 注入文本块：文风要求 + 结构化约束。 */
export function describeWorldStyle(style: WorldStyle): string {
  const profile = WORLD_STYLE_PROFILES[style];
  return [
    `文风要求：本世界为「${profile.label}」风格。`,
    `语调：${profile.tone}`,
    `用词：${profile.diction}`,
    `意象：${profile.imagery}`,
    `示范：${profile.sample}`,
  ].join("\n");
}

/**
 * Prompt System v2：system prompt 静态指令必须 English-only。
 * 以下是与 WORLD_STYLE_PROFILES 平行的英文 prompt 专用描述（不含 sample
 * 示范句——那是静态中文文案，不进 system prompt）；UI 本地化仍走
 * TEMPLATES / describeWorldStyle，不受影响。
 */
export const WORLD_STYLE_PROMPT_PROFILES: Record<WorldStyle, {
  label: string;
  tone: string;
  diction: string;
  imagery: string;
}> = {
  modern: {
    label: "modern",
    tone: "plain, natural contemporary prose with a brisk, unpretentious pace",
    diction: "contemporary spoken and common written language; no archaic or classical phrasing",
    imagery: "contemporary life and nature — streets, lamplight, phones, vehicles, weather",
  },
  classical: {
    label: "classical",
    tone: "restrained, evocative classical prose with deliberate economy and breathing room",
    diction: "light archaic touches and old-fashioned forms of address; no modern or loan words",
    imagery: "mountains, water, vessels, seasonal weather — mist, tides, bell chimes, lamplight, letters",
  },
  western_fantasy: {
    label: "western fantasy",
    tone: "epic, measured fantasy prose with an orderly, slightly translated feel",
    diction: "guilds, oaths, crests, caravans and other western-fantasy vocabulary; no eastern classical imagery",
    imagery: "castles, forests, campfires, crests and wilderness",
  },
  anime: {
    label: "anime",
    tone: "bright, lively anime delivery with open emotion and a bouncy rhythm",
    diction: "light sentence-final particles and gentle banter; no heavy bookish phrasing",
    imagery: "vivid color — blue skies, sparkling water, shop signs, school roads, convenience-store lights",
  },
};

export type WorldStyleLanguage = "zh-CN" | "en" | "ja";

export const WORLD_STYLE_LANGUAGES: readonly WorldStyleLanguage[] = [
  "zh-CN",
  "en",
  "ja",
];

/** 模板参数插值：{name} 形式。 */
function interpolate(template: string, params?: Record<string, string>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    params[key] !== undefined && params[key] !== "" ? params[key] : match);
}

type StyleTemplates = Record<WorldStyle, string>;
type TemplateTable = Record<string, Record<WorldStyleLanguage, StyleTemplates>>;

const T = (modern: string, classical: string, western: string, anime: string): StyleTemplates => ({
  modern,
  classical,
  western_fantasy: western,
  anime,
});

const TEMPLATES: TemplateTable = {
  "guided.step.world-name.question": {
    "zh-CN": T(
      "先给这个世界起个名字吧——你希望它叫什么？",
      "这片天地，当以何名传世？",
      "旅人，你脚下的这片土地该如何称呼？",
      "第一步～这个世界叫什么名字呀？",
    ),
    en: T("Name this world — what shall it be called?", "By what name shall this realm be remembered?", "Traveler, what do they call this land you tread?", "First step! What is this world called?"),
    ja: T("この世界の名前は？","この天地、何と名付けようか","旅人よ、この地は何と呼ばれている？","まずは世界の名前から！"),
  },
  "guided.step.era.question": {
    "zh-CN": T(
      "它处在什么样的年代？",
      "此世行于何历？",
      "这个故事发生在纪元中的哪一页？",
      "这个世界的时代氛围是怎样的呢？",
    ),
    en: T("What age does it live in?", "What calendar does this world keep?", "On which page of the ages does this tale fall?", "What is the era vibe of this world?"),
    ja: T("この世界はどんな時代？","この世は如何なる暦を刻む？","この物語は年代記のどの頁にある？","この世界の時代感は？"),
  },
  "guided.step.style.question": {
    "zh-CN": T(
      "希望用什么样的笔调来讲这个世界的故事？",
      "此卷当以何等笔墨写就？",
      "这部传说该用怎样的语调传唱？",
      "想用哪种风格展开这个世界的故事呢？",
    ),
    en: T("What voice should tell this world's story?", "In what hand shall this scroll be written?", "In what tongue shall the bards sing it?", "What style should this story use?"),
    ja: T("この世界の物語はどんな筆致で？","この巻は如何なる筆で綴るべきか","吟遊詩人はどの調べで歌うべきか","この物語のスタイルはどれにする？"),
  },
  "guided.step.summary.question": {
    "zh-CN": T(
      "如果用一两句话介绍这个世界，你会怎么说？",
      "若为此卷作一句题跋，当如何落笔？",
      "若要为此地立传，开篇第一句当如何写？",
      "来一句话说说这个世界的感觉吧～",
    ),
    en: T("How would you introduce this world in a sentence or two?", "If this scroll asks for one line of preface, how should the brush fall?", "If you were to chronicle this land, how opens the first line?", "Sum up this world in one line!"),
    ja: T("この世界を一二句で言うなら？","この巻に題跋を認めるなら、如何に落筆する？","この地の伝を記すなら、冒頭の一句は？","この世界の感じを一言で！"),
  },
  "guided.step.story.question": {
    "zh-CN": T(
      "第一段故事从哪里开始？（标题与一句梗概）",
      "第一折故事，从何而起？",
      "第一段冒险，从何处落笔？",
      "开场剧情要从哪里开始呀？",
    ),
    en: T("Where does the first story begin? (title and one-line premise)", "From what does the first act arise?", "Where does the first adventure take its start?", "Where does the opening story begin?"),
    ja: T("最初の物語はどこから？","第一の折は何より起こる？","最初の冒険は何地より始まる？","オープニングはどこから始める？"),
  },
  "guided.step.player-role.question": {
    "zh-CN": T(
      "在这个世界里，你是一个什么样的人？",
      "此行之中，你是怎样的一个人？",
      "在这段旅程中，你扮演怎样的角色？",
      "你在这个世界里是什么担当呢？",
    ),
    en: T("Who are you in this world?", "What manner of person are you on this journey?", "What part do you play in this journey?", "What is your role in this world?"),
    ja: T("この世界であなたはどんな人？","この道行きで、あなたは如何なる人か","この旅であなたは何を演じる？","この世界でのあなたの役割は？"),
  },
  "guided.step.stance.question": {
    "zh-CN": T(
      "你想以什么姿态走进这个世界？",
      "君欲以何姿入此卷中？",
      "你将以何种姿态踏入这个世界？",
      "你想用怎样的姿态进入这个世界呢？",
    ),
    en: T("How will you step into this world?", "In what guise shalt thou enter this scroll?", "In what manner will you walk into this world?", "How will you enter this world?"),
    ja: T("どんな立ち位置でこの世界に入る？","いかなる姿にてこの巻に入らんか","どのような姿でこの世界に踏み入れる？","どんな立ち位置でこの世界に入る？"),
  },
  "guided.step.companions.question": {
    "zh-CN": T(
      "要不要叫上同伴一起？",
      "此行长路，可有同行之人？",
      "可有伙伴愿与你同行？",
      "要不要带上伙伴一起走呀？",
    ),
    en: T("Care to bring companions along?", "Any fellow travelers on this long road?", "Will any companions swear to your side?", "Want to bring some friends along?"),
    ja: T("仲間を連れて行く？","この長路に同行の者はあるか","同道を誓う仲間はいるか？","仲間を連れていく？"),
  },
  "guided.step.scene.question": {
    "zh-CN": T(
      "开场在哪里？天气、形势、眼下要做的事——都可以先留白。",
      "大幕初启，何处、何天、何势、何事？",
      "故事的序幕在何地拉开？天候、时局、当务之急各是如何？",
      "开场场景是什么样子的？地点、天气都可以先空着哦。",
    ),
    en: T("Where does it open? Weather, stakes, the task at hand — all may stay blank.", "The curtain rises: where, what sky, what stakes, what deed?", "Where does the prologue unfold? Climate, circumstance, the task — as you will.", "What is the opening scene like? Place and weather can stay blank!"),
    ja: T("開幕はどこ？天気・情勢・当面のこと——余白でも。","幕が開く。何処、何の天、何の勢い、何のことか","序章は何地で開く？天候、時局、急務は如何に","オープニングはどんな感じ？場所も天気も空でOK！"),
  },
  "guided.step.review.question": {
    "zh-CN": T(
      "都定好了，最后检查一遍吧。",
      "卷帙已成，君当亲览。",
      "书页已经写就，请过目。",
      "写好啦！最后确认一下吧～",
    ),
    en: T("All set — one last look.", "The scroll is complete; pray review it.", "The pages are written; behold them.", "All done! One final check!"),
    ja: T("全部決まった。最後に一目。","巻は成った。ご高覧あれ","頁は書き上がった。ご覧あれ","できた！最後に確認してね"),
  },
  "guided.style.modern": {
    "zh-CN": T("现代", "现代", "现代", "现代"),
    en: T("Modern", "Modern", "Modern", "Modern"),
    ja: T("現代", "現代", "現代", "現代"),
  },
  "guided.style.classical": {
    "zh-CN": T("古风", "古风", "古风", "古风"),
    en: T("Classical", "Classical", "Classical", "Classical"),
    ja: T("古風", "古風", "古風", "古風"),
  },
  "guided.style.western_fantasy": {
    "zh-CN": T("西幻", "西幻", "西幻", "西幻"),
    en: T("Western Fantasy", "Western Fantasy", "Western Fantasy", "Western Fantasy"),
    ja: T("西洋幻想", "西洋幻想", "西洋幻想", "西洋幻想"),
  },
  "guided.style.anime": {
    "zh-CN": T("二次元", "二次元", "二次元", "二次元"),
    en: T("Anime", "Anime", "Anime", "Anime"),
    ja: T("アニメ", "アニメ", "アニメ", "アニメ"),
  },
  "action.observe.description.scenic": {
    "zh-CN": T(
      "留意{location}一带的变化（{weather}）。",
      "留意{location}一带的动静（{weather}）。",
      "细察{location}周遭的风吹草动（{weather}）。",
      "注意{location}附近的变化哦（{weather}）！",
    ),
    en: T("Watch how things shift around {location} ({weather}).", "Mark the stirrings about {location} ({weather}).", "Study the winds and whispers around {location} ({weather}).", "Check out what's happening near {location} ({weather})!"),
    ja: T("{location}辺りの変化に気を配る（{weather}）。", "{location}辺りの動静に心を留める（{weather}）。", "{location}の周りの気配を窺う（{weather}）。", "{location}の近くの様子をチェック（{weather}）！"),
  },
  "action.observe.description.blank": {
    "zh-CN": T(
      "留意周遭环境的变化。",
      "留心四方动静。",
      "观察周围的风吹草动。",
      "注意周围的变化哦！",
    ),
    en: T("Watch how things shift around you.", "Mark the stirrings on every side.", "Study the winds and whispers about you.", "Check out what's happening around you!"),
    ja: T("周囲の変化に気を配る。","四方の動静に心を留める。","周りの気配を窺う。","まわりの様子をチェック！"),
  },
  "action.observe.suggested.scenic": {
    "zh-CN": T(
      "我观察{location}一带的变化。",
      "我留心{location}一带的动静。",
      "我细察{location}周遭的情形。",
      "我看看{location}附近的情况！",
    ),
    en: T("I watch how things shift around {location}.", "I mark the stirrings about {location}.", "I study the winds around {location}.", "I'll check out what's near {location}!"),
    ja: T("{location}辺りの変化を見る。","{location}辺りの動静を窺う。","{location}の周りを見回す。","{location}の近くを見てくる！"),
  },
  "action.observe.suggested.blank": {
    "zh-CN": T(
      "我观察周遭的变化。",
      "我留心四下里的动静。",
      "我细察周围的情形。",
      "我看看周围的情况！",
    ),
    en: T("I watch how things shift around me.", "I mark the stirrings on every side.", "I study the winds about me.", "I'll check out what's around!"),
    ja: T("周囲の変化を見る。","四下の動静を窺う。","周りを見回す。","まわりを見てくる！"),
  },
  "scene.crystallize.location": {
    "zh-CN": T(
      "场景转至{value}",
      "场景移至{value}",
      "舞台转至{value}",
      "场景换到{value}啦",
    ),
    en: T("the scene shifts to {value}", "the scene removes to {value}", "the stage turns to {value}", "the scene moves to {value}"),
    ja: T("場面は{value}へ","場は{value}に移る","舞台は{value}へ","シーンは{value}に"),
  },
  "scene.crystallize.weather": {
    "zh-CN": T(
      "天气变为{value}",
      "天气转作{value}",
      "天候转为{value}",
      "天气变成{value}了呢",
    ),
    en: T("the weather turns to {value}", "the weather shifts to {value}", "the skies turn to {value}", "the weather is now {value}"),
    ja: T("天気は{value}に","天は{value}に転ず","空は{value}へ","天気は{value}になった"),
  },
  "scene.crystallize.tension": {
    "zh-CN": T("局势：{value}", "局势：{value}", "时局：{value}", "形势：{value}！"),
    en: T("tension: {value}", "the state of things: {value}", "the times: {value}", "situation: {value}!"),
    ja: T("情勢：{value}","情勢：{value}","時局：{value}","形勢：{value}！"),
  },
  "scene.crystallize.time": {
    "zh-CN": T(
      "时间推进至{value}",
      "更次推移至{value}",
      "时刻推移至{value}",
      "时间走到{value}啦",
    ),
    en: T("time advances to {value}", "the hour moves to {value}", "the hour turns to {value}", "time moves to {value}"),
    ja: T("時刻は{value}へ","更は{value}に移る","刻は{value}に移る","時間は{value}に"),
  },
  "scene.crystallize.objective": {
    "zh-CN": T(
      "目标更新为「{value}」",
      "目标易为「{value}」",
      "当前要务更新为「{value}」",
      "目标变成「{value}」咯",
    ),
    en: T("the objective becomes 「{value}」", "the aim is now 「{value}」", "the charge is now 「{value}」", "the goal is 「{value}」 now"),
    ja: T("目標は「{value}」に","目的は「{value}」と易わる","急務は「{value}」と定まる","目標は「{value}」になったよ"),
  },
  "scene.crystallize.prefix": {
    "zh-CN": T("场景定格 — ", "场景定格 — ", "场景铭刻 — ", "场景锁定 — "),
    en: T("Scene fixed — ", "Scene fixed — ", "Scene sealed — ", "Scene locked — "),
    ja: T("場面定格 — ","場面定格 — ","場面銘記 — ","シーン確定 — "),
  },
  "scene.crystallize.speaker": {
    "zh-CN": T("界核", "界核", "界核", "界核"),
    en: T("REALM", "REALM", "REALM", "REALM"),
    ja: T("界核","界核","界核","界核"),
  },
  "first-night.opening.located": {
    "zh-CN": T(
      "你来到{location}。故事从这里开始。",
      "身在{location}，故事自此落笔。",
      "你抵达了{location}。故事就此开篇。",
      "到啦，这里就是{location}！故事开始咯～",
    ),
    en: T(
      "You arrive at {location}. The story starts here.",
      "You stand at {location}; the tale begins with this stroke.",
      "You reach {location}. So the story opens.",
      "Here we are — {location}! The story begins!",
    ),
    ja: T(
      "{location}に辿り着いた。物語はここから始まる。",
      "{location}に身を置く。物語はここから筆を落とす。",
      "{location}に到着した。物語はここから開かれる。",
      "{location}に着いたよ！物語の始まりだ～",
    ),
  },
  "first-night.opening.blank": {
    "zh-CN": T(
      "世界刚刚生成，很多细节还没有确定。第一处细节等你来决定。",
      "天地初落笔，万象尚未成形。",
      "世界方自落笔，一切仍待书写。",
      "世界才刚刚写下第一笔，什么都还没定型哦！",
    ),
    en: T(
      "The world has just been written; nothing is fixed yet. The first detail waits for you.",
      "The realm is newly inked; ten thousand things await their shape.",
      "The world is fresh from the quill; all remains unwritten.",
      "The world was just written down — nothing's set yet!",
    ),
    ja: T(
      "世界はまだ書かれたばかり。何も定まっていない。",
      "天地はまだ筆を落とされたばかり、万象いまだ形を成さず。",
      "世界はまさに落筆されたところで、すべてがこれからの話だ。",
      "世界はまだ書かれたばかり、何も決まってないよ！",
    ),
  },
  "first-night.part.location": {
    "zh-CN": T(
      "这里是{location}。",
      "此地乃{location}。",
      "此处正是{location}。",
      "这里就是{location}！",
    ),
    en: T("This is {location}.", "This place is {location}.", "Here stands {location}.", "This is {location}!"),
    ja: T("ここは{location}。", "此地は{location}。", "ここは{location}。", "ここが{location}だよ！"),
  },
  "first-night.part.weather": {
    "zh-CN": T("{weather}。", "{weather}。", "{weather}。", "{weather}！"),
    en: T("{weather}.", "{weather}.", "{weather}.", "{weather}!"),
    ja: T("{weather}。", "{weather}。", "{weather}。", "{weather}！"),
  },
  "first-night.part.tension": {
    "zh-CN": T("{tension}。", "{tension}。", "{tension}。", "{tension}！"),
    en: T("{tension}.", "{tension}.", "{tension}.", "{tension}!"),
    ja: T("{tension}。", "{tension}。", "{tension}。", "{tension}！"),
  },
  "first-night.part.objective": {
    "zh-CN": T(
      "眼下的事情是：{objective}。",
      "眼前之务：{objective}。",
      "当务之急：{objective}。",
      "现在要做的事是——{objective}！",
    ),
    en: T(
      "What matters now: {objective}.",
      "The task at hand: {objective}.",
      "The pressing charge: {objective}.",
      "What's next is — {objective}!",
    ),
    ja: T(
      "今のところは——{objective}。",
      "当面の務め：{objective}。",
      "急務：{objective}。",
      "いまやることは——{objective}！",
    ),
  },
  "first-night.part.blank": {
    "zh-CN": T(
      "万象未定，轮廓待生。",
      "万象未形。",
      "一切仍待书写。",
      "什么都还没定型哦。",
    ),
    en: T(
      "Nothing is fixed yet; outlines wait to grow.",
      "Ten thousand things await their shape.",
      "All remains unwritten.",
      "Nothing's set in stone yet!",
    ),
    ja: T(
      "何もまだ定まっていなく、輪郭はこれから。",
      "万象いまだ形を成さず。",
      "すべてはこれからの話だ。",
      "まだ何も決まってないよ。",
    ),
  },
  "first-night.hook.objective": {
    "zh-CN": T(
      "眼下的事正等着你：{objective}。",
      "眼前之务未了：{objective}。",
      "有一件事悬而未决——{objective}。",
      "接下来要忙的事是——{objective}！",
    ),
    en: T(
      "Something waits on you: {objective}.",
      "A task lies unfinished: {objective}.",
      "One matter hangs unresolved — {objective}.",
      "What's next is — {objective}!",
    ),
    ja: T(
      "目の前の用件があなたを待っている：{objective}。",
      "目の前の務めはいまだ終わらず：{objective}。",
      "一つのこと決着つかず——{objective}。",
      "次にやることは——{objective}！",
    ),
  },
  "first-night.hook.tension": {
    "zh-CN": T(
      "空气里压着一点不对劲：{tension}。",
      "风色微变：{tension}。",
      "暗流已生——{tension}。",
      "气氛有点微妙：{tension}！",
    ),
    en: T(
      "Something hangs in the air: {tension}.",
      "The wind shifts: {tension}.",
      "An undercurrent stirs — {tension}.",
      "The mood turns tricky: {tension}!",
    ),
    ja: T(
      "空気に違和感が漂う：{tension}。",
      "風向きが変わる：{tension}。",
      "暗流が生まれる——{tension}。",
      "雰囲気がちょっと変：{tension}！",
    ),
  },
  "first-night.suggestion.objective": {
    "zh-CN": T(
      "先着手：{objective}",
      "即刻去办：{objective}",
      "动身处理——{objective}",
      "先去搞定{objective}吧！",
    ),
    en: T(
      "Start with: {objective}",
      "Set about: {objective}",
      "Move on — {objective}",
      "Let's handle {objective} first!",
    ),
    ja: T(
      "まずは着手：{objective}",
      "すぐに取り掛かる：{objective}",
      "動き出そう——{objective}",
      "まずは{objective}を片付けよう！",
    ),
  },
  "first-night.suggestion.location": {
    "zh-CN": T(
      "四处看看{location}",
      "细察{location}的动静",
      "在{location}走上一圈",
      "去{location}逛逛看！",
    ),
    en: T(
      "Look around {location}",
      "Take in {location}",
      "Walk a lap of {location}",
      "Let's explore {location}!",
    ),
    ja: T(
      "{location}を見回す",
      "{location}の様子を窺う",
      "{location}を一回りしてみる",
      "{location}を探検してみよう！",
    ),
  },
  "timeline.empty.title": {
    "zh-CN": T(
      "新的一页，还没有内容",
      "长卷初展，诸事未定",
      "扉页方启，传说未书",
      "新章开始，先写点什么吧",
    ),
    en: T("A fresh page, nothing written yet", "The long scroll unfurls; nothing is yet decided", "The title page opens; the legend unwritten", "A new chapter — say something to begin!"),
    ja: T("新しい頁、まだ何もない","長巻初めて開く、諸事いまだ定まらず","扉頁開く、伝説いまだ書かれず","新しい章、何か書こう！"),
  },
  "timeline.empty.hint": {
    "zh-CN": T(
      "写下第一句话，世界从这里开始。",
      "落下第一笔，世界便从这里生长。",
      "写下第一句，传说自此开篇。",
      "来说点什么，故事就开始啦！",
    ),
    en: T("Write the first line; the world starts here.", "Set down the first stroke, and the world grows from it.", "Write the first line, and the legend begins.", "Say something and the story begins!"),
    ja: T("最初の一行を書けば、世界はここから始まる。","第一の筆を落とせば、世界はここより育つ。","一句書けば、伝説はここに開く。","何か話せば物語が始まるよ！"),
  },
};

/** 世界内固定文案查找：语言缺失回退 zh-CN，风格未知回退 modern。 */
export function worldStyleText(
  key: string,
  style: WorldStyle,
  params?: Record<string, string>,
  language: WorldStyleLanguage = "zh-CN",
): string {
  const byLanguage = TEMPLATES[key];
  if (!byLanguage) {
    throw new Error(`Unknown world style template key: ${key}`);
  }
  const table = byLanguage[language] ?? byLanguage["zh-CN"];
  const template = table[style] ?? table[DEFAULT_WORLD_STYLE];
  return interpolate(template, params);
}

/** 契约测试用：全部模板 key 与其四风格齐备性检查。 */
export function worldStyleTemplateKeys(): readonly string[] {
  return Object.keys(TEMPLATES);
}

export function worldStyleTemplateTable(
  key: string,
  language: WorldStyleLanguage = "zh-CN",
): Record<WorldStyle, string> | null {
  const byLanguage = TEMPLATES[key];
  return byLanguage ? { ...byLanguage[language] } : null;
}
