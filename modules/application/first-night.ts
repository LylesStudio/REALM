import type { ModelGateway } from "../inference/public.ts";
import {
  NATURAL_VOICE_RULES,
  composeContext,
  contextBlock,
  jsonOutputInstruction,
  requestStructuredObject,
  stylePromptBlock,
} from "../inference/public.ts";
import {
  normalizeWorldStyle,
  worldStyleText,
  type WorldStyle,
} from "../style/world-style.ts";

/**
 * 世界初夜（批次 T1，docs/development/T1-FIRST-NIGHT.md）。
 *
 * 落笔入界的事务内只做确定性工作：开场旁白（草稿 opening 或风格化合成句）
 * 与 pending 状态行。事务提交后异步发起一次模型调用生成「初夜包」，
 * 以标准事件形态追加进同一记录；任何失败都 fail-closed 到确定性降级包，
 * 时间线绝不空白。
 */

export const FIRST_NIGHT_STATES = ["pending", "ready", "degraded"] as const;

export type FirstNightState = (typeof FIRST_NIGHT_STATES)[number];

/** 尝试次数上限：懒重试达到上限后强制落降级包收尾。 */
export const FIRST_NIGHT_MAX_ATTEMPTS = 3;

/** 创世草稿快照；落笔事务内镜像进 record_first_nights.context。 */
export interface FirstNightContext {
  world: { name: string; era: string; summary: string };
  style: WorldStyle;
  story: { title: string; premise: string };
  /** 人类玩家在本世界的角色定位。 */
  playerRole: string;
  /** 人类玩家名字（账号 displayName 解析结果，可能为空）。 */
  playerName: string;
  playerStance: "player" | "observer";
  companions: { name: string; role: string; summary: string }[];
  scene: { location: string; weather: string; tension: string; objective: string };
  /** 卷首旁白（对谈路径产出；逐步引导为空）。 */
  opening: string;
}

/** 初夜场景定格：presentation 三段，与演示种子 OPENING_EVENT_SQL 同型。 */
export interface FirstNightScene {
  environment: string;
  story: string;
  fact: string;
}

/** 初夜同行者发声：名字必须与提案同行者精确匹配。 */
export interface FirstNightCharacter {
  name: string;
  /** 第一句台词（dialogue 段，speechMode speaker）。 */
  utterance: string;
  /** 说话时的动作神态（action 段，speechMode narrator）。 */
  action: string;
}

/** 初夜钩子：一句钩住玩家的开场事件 + 2–3 条具体可行动的开场提案。 */
export interface FirstNightHook {
  content: string;
  suggestions: string[];
}

/**
 * 模型生成的初夜包。能力点一：场景定格；能力点二：角色在场；
 * 能力点三：钩子事件开场。
 */
export interface FirstNightPack {
  scene: FirstNightScene;
  characters: FirstNightCharacter[];
  hook: FirstNightHook;
}

const SCENE_FIELD_LIMIT = 120;
const CHARACTER_FIELD_LIMIT = 120;
const HOOK_CONTENT_LIMIT = 200;
const SUGGESTION_LIMIT = 60;
const SUGGESTION_MAX_COUNT = 3;
/** 开场提案下限：少于该数量视为模型输出不合格（fail-closed 降级）。 */
export const FIRST_NIGHT_MIN_SUGGESTIONS = 2;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

/**
 * 从状态行 context jsonb 还原草稿快照；关键字段（世界名）缺失返回 null，
 * 调用方落降级包并保留已有场景字段兜底。
 */
export function normalizeFirstNightContext(value: unknown): FirstNightContext | null {
  if (!isObject(value)) return null;
  const world = isObject(value.world) ? value.world : {};
  const story = isObject(value.story) ? value.story : {};
  const scene = isObject(value.scene) ? value.scene : {};
  const name = clampText(world.name, 40);
  if (!name) return null;
  const companions = (Array.isArray(value.companions) ? value.companions : [])
    .filter(isObject)
    .map((item) => ({
      name: clampText(item.name, 24),
      role: clampText(item.role, 40),
      summary: clampText(item.summary, 120),
    }))
    .filter((item) => item.name.length > 0)
    .slice(0, 2);
  return {
    world: {
      name,
      era: clampText(world.era, 40),
      summary: clampText(world.summary, 160),
    },
    style: normalizeWorldStyle(value.style),
    story: {
      title: clampText(story.title, 40),
      premise: clampText(story.premise, 200),
    },
    playerRole: clampText(value.playerRole, 60),
    playerName: clampText(value.playerName, 24),
    playerStance: value.playerStance === "observer" ? "observer" : "player",
    companions,
    scene: {
      location: clampText(scene.location, 60),
      weather: clampText(scene.weather, 60),
      tension: clampText(scene.tension, 60),
      objective: clampText(scene.objective, 120),
    },
    opening: clampText(value.opening, 300),
  };
}

/**
 * 确定性开场旁白：落笔事务内使用，零模型调用。
 * opening 优先；其次按场景地点合成风格化定格句；全留白落「万象未定」句。
 */
export function composeDeterministicOpening(context: FirstNightContext): string {
  const opening = context.opening.trim();
  if (opening) return opening;
  const location = context.scene.location.trim();
  if (location) {
    return worldStyleText("first-night.opening.located", context.style, { location });
  }
  return worldStyleText("first-night.opening.blank", context.style);
}

/**
 * 确定性降级包：模型不可用/输出不合格时兜底。
 * 场景三段由草稿字段经风格模板合成；environment 永远非空，保证旁白可进场。
 */
export function fallbackFirstNightPack(context: FirstNightContext): FirstNightPack {
  const { style } = context;
  const location = context.scene.location.trim();
  const weather = context.scene.weather.trim();
  const tension = context.scene.tension.trim();
  const objective = context.scene.objective.trim();
  const environment = location
    ? worldStyleText("first-night.part.location", style, { location })
    : worldStyleText("first-night.part.blank", style);
  const story = objective
    ? worldStyleText("first-night.part.objective", style, { objective })
    : "";
  const fact = [
    weather ? worldStyleText("first-night.part.weather", style, { weather }) : "",
    tension ? worldStyleText("first-night.part.tension", style, { tension }) : "",
  ]
    .filter((part) => part.length > 0)
    .join("");
  const hookContent = objective
    ? worldStyleText("first-night.hook.objective", style, { objective })
    : tension
      ? worldStyleText("first-night.hook.tension", style, { tension })
      : "";
  const suggestions = [
    objective
      ? worldStyleText("first-night.suggestion.objective", style, { objective })
      : "",
    location
      ? worldStyleText("first-night.suggestion.location", style, { location })
      : "",
  ].filter((item) => item.length > 0);
  return {
    scene: { environment, story, fact },
    characters: [],
    hook: { content: hookContent, suggestions },
  };
}

/**
 * 规整模型输出：场景三段至少一段非空，逐段修剪截断；整体不合格返回 null。
 * 角色只保留名字与提案同行者精确匹配者（按提案顺序去重），台词必须非空；
 * 不合格角色直接丢弃，不影响场景定格进场。
 */
export function normalizeFirstNightPack(
  value: unknown,
  context: FirstNightContext,
): FirstNightPack | null {
  if (!isObject(value)) return null;
  const scene = isObject(value.scene) ? value.scene : {};
  const environment = clampText(scene.environment, SCENE_FIELD_LIMIT);
  const story = clampText(scene.story, SCENE_FIELD_LIMIT);
  const fact = clampText(scene.fact, SCENE_FIELD_LIMIT);
  if (!environment && !story && !fact) return null;
  const rawCharacters = Array.isArray(value.characters) ? value.characters : [];
  const seen = new Set<string>();
  const characters: FirstNightCharacter[] = [];
  for (const companion of context.companions) {
    const match = rawCharacters
      .filter(isObject)
      .find((item) => clampText(item.name, 24) === companion.name);
    if (!match) continue;
    const utterance = clampText(match.utterance, CHARACTER_FIELD_LIMIT);
    if (!utterance || seen.has(companion.name)) continue;
    seen.add(companion.name);
    characters.push({
      name: companion.name,
      utterance,
      action: clampText(match.action, CHARACTER_FIELD_LIMIT),
    });
  }
  const hook = isObject(value.hook) ? value.hook : {};
  const hookContent = clampText(hook.content, HOOK_CONTENT_LIMIT);
  const rawSuggestions = Array.isArray(hook.suggestions) ? hook.suggestions : [];
  const suggestionSeen = new Set<string>();
  const suggestions: string[] = [];
  for (const raw of rawSuggestions) {
    const suggestion = clampText(raw, SUGGESTION_LIMIT);
    if (!suggestion || suggestionSeen.has(suggestion)) continue;
    suggestionSeen.add(suggestion);
    suggestions.push(suggestion);
    if (suggestions.length >= SUGGESTION_MAX_COUNT) break;
  }
  if (!hookContent || suggestions.length < FIRST_NIGHT_MIN_SUGGESTIONS) return null;
  return {
    scene: { environment, story, fact },
    characters,
    hook: { content: hookContent, suggestions },
  };
}

function describeScene(context: FirstNightContext): string {
  const { location, weather, tension, objective } = context.scene;
  return contextBlock("Initial scene", {
    location: location || "(blank)",
    weather: weather || "(blank)",
    tension: tension || "(blank)",
    objective: objective || "(blank)",
  });
}

/**
 * 初夜生成消息（Prompt System v2）：system 只放静态 English 策略与输出
 * 契约；世界提案/场景/同行者/卷首旁白等动态资料放 user context block。
 */
/** 初夜输出契约（Prompt System v2 同源：system prompt 与 repair 共用）。 */
const FIRST_NIGHT_SCHEMA = jsonOutputInstruction([
  { name: "scene", kind: "object", note: `{"environment": one-sentence environment image, "story": one thing happening right now, "fact": one concrete world fact} — each <= ${SCENE_FIELD_LIMIT} chars` },
  { name: "characters", kind: "object[]", note: `array of {"name","utterance","action"}, each text <= ${CHARACTER_FIELD_LIMIT} chars` },
  { name: "hook", kind: "object", note: `{"content": <= ${HOOK_CONTENT_LIMIT} chars, "suggestions": string[] each <= ${SUGGESTION_LIMIT} chars}` },
]);

export function buildFirstNightMessages(
  context: FirstNightContext,
): { system: string; user: string } {
  const system = [
    "You are REALM's first-night writer. A world has just been written into being; write the first frozen frame of its opening scene.",
    "Continue naturally from the existing opening narration without repeating its wording or contradicting the proposal; where the scene is left blank, fill in concrete details (sounds, light, smells, movement) at a small scale.",
    context.companions.length > 0
      ? "characters may only include the companions listed in the context: name must match a companion's name exactly, at most one entry per companion; utterance is that person's first spoken line (true to their identity and profile); action is a one-sentence gesture or expression as they speak."
      : "characters must be an empty array — there are no companions; never invent characters.",
    "Never introduce characters beyond the listed companions.",
    "hook.content is a one-sentence opening hook — a concrete situation that makes the player want to act immediately, directly tied to the scene, never generic.",
    `hook.suggestions are ${FIRST_NIGHT_MIN_SUGGESTIONS}–${SUGGESTION_MAX_COUNT} follow-up action ideas, each specific to this scene (where to go, whom to ask, what to do), in the player's voice starting with a verb; generic filler like "look around" is forbidden.`,
    NATURAL_VOICE_RULES,
    FIRST_NIGHT_SCHEMA,
    stylePromptBlock(context.style),
    // 语言规则：跟随既有卷首旁白；空时用世界配置语言（fail-closed 不定死）。
    "Write in the language of the existing opening narration. If there is no opening narration, use the world's configured language.",
  ].join("\n");

  const user = composeContext([
    contextBlock("World proposal", {
      world: context.world.name,
      ...(context.world.era ? { era: context.world.era } : {}),
      ...(context.world.summary ? { summary: context.world.summary } : {}),
      ...(context.story.title
        ? {
          story: context.story.title,
          ...(context.story.premise ? { premise: context.story.premise } : {}),
        }
        : {}),
      ...(context.playerRole ? { playerRole: context.playerRole } : {}),
    }),
    describeScene(context),
    context.companions.length > 0
      ? contextBlock("Companions", context.companions.map((companion) => ({
        name: companion.name,
        role: companion.role,
        summary: companion.summary,
      })))
      : contextBlock("Companions", "none — the player travels alone"),
    context.opening
      ? contextBlock("Existing opening narration", context.opening)
      : contextBlock("Existing opening narration", "(none)"),
  ]);
  return { system, user };
}

/**
 * 单次 json_object 调用生成初夜包；调用失败或输出不合格一律返回 null，
 * 由调度方落降级包（fail-closed）。Prompt System v2：容错解析 + 恰好一次
 * repair；provider 错误同样只落 null（初夜可降级）。
 */
export async function generateFirstNightPack(
  gateway: ModelGateway,
  context: FirstNightContext,
): Promise<FirstNightPack | null> {
  try {
    const { system, user } = buildFirstNightMessages(context);
    const result = await requestStructuredObject({
      call: async (messages) => {
        const response = await gateway.chat({
          messages,
          responseFormat: "json_object",
          temperature: 0.8,
        });
        return {
          content: response.content,
          model: response.model,
          usage: response.usage,
          finishReason: response.finishReason,
        };
      },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      normalize: (body) => normalizeFirstNightPack(body, context),
      schemaInstruction: FIRST_NIGHT_SCHEMA,
      code: "FIRST_NIGHT_INVALID",
      // Batch 2B-P1：逻辑调用观测（additive；未配置 observer 时 no-op）。
      observation: {
          stage: "first-night",
          providerId: gateway.providerId ?? "unknown",
        },
    });
    return result?.value ?? null;
  } catch {
    return null;
  }
}

/**
 * 初夜调度器：单飞守卫按 recordId 去重（路由触发与懒重试共用），
 * 任何异常只留日志，绝不影响调用方。
 */
export function createFirstNightScheduler(options: {
  runFirstNight: (recordId: string) => Promise<void>;
}): (recordId: string) => void {
  const inFlight = new Set<string>();
  return (recordId) => {
    const key = recordId.trim();
    if (!key || inFlight.has(key)) return;
    inFlight.add(key);
    void (async () => {
      try {
        await options.runFirstNight(key);
      } catch (error) {
        console.warn(
          `[realm] first night skipped: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      } finally {
        inFlight.delete(key);
      }
    })();
  };
}

/** 上下文快照损坏时的兜底草稿：降级包仍能给出「万象未定」场景旁白。 */
export const BLANK_FIRST_NIGHT_CONTEXT: FirstNightContext = {
  world: { name: "未命名世界", era: "", summary: "" },
  style: "modern",
  story: { title: "", premise: "" },
  playerRole: "",
  playerName: "",
  playerStance: "player",
  companions: [],
  scene: { location: "", weather: "", tension: "", objective: "" },
  opening: "",
};

/**
 * 单条记录的初夜执行：认领一次尝试 → 模型生成（或强制降级）→ 事务落库。
 * claim 失败（非 pending/无行）直接返回；落库失败向上抛给调度器留日志，
 * 状态保持 pending，等待下次打开懒重试。
 */
export function createFirstNightRunner(options: {
  store: {
    claimAttempt(
      recordId: string,
    ): Promise<{ attempts: number; context: FirstNightContext | null } | null>;
    commitPack(
      recordId: string,
      pack: FirstNightPack,
      state: "ready" | "degraded",
    ): Promise<boolean>;
  };
  getGateway: () => Promise<ModelGateway>;
}): (recordId: string) => Promise<void> {
  return async (recordId) => {
    const claim = await options.store.claimAttempt(recordId);
    if (!claim) return;
    const context = claim.context ?? BLANK_FIRST_NIGHT_CONTEXT;
    let pack: FirstNightPack | null = null;
    if (claim.attempts < FIRST_NIGHT_MAX_ATTEMPTS) {
      try {
        const gateway = await options.getGateway();
        pack = await generateFirstNightPack(gateway, context);
      } catch (error) {
        console.warn(
          `[realm] first night gateway unavailable: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    const state: "ready" | "degraded" = pack ? "ready" : "degraded";
    await options.store.commitPack(recordId, pack ?? fallbackFirstNightPack(context), state);
  };
}
