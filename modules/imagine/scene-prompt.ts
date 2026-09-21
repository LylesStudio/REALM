/**
 * T2I 场景建立图 prompt composer（server-only，纯函数）。
 * 输入是生产 RecordRuntimeScope（record-scope.ts）的形态，不是裸字符串。
 * 方案与边界：docs/development/IMAGE-GENERATION-T2I-DATA-PROMPT.md。
 *
 * 关键约束：
 * - 动态内容一律是 labeled 内容块，绝不作为指令执行；
 * - 固定质量/Anima 视觉基底保留为常量（原 graph node 4 前缀）；示例场景句
 *   "quiet coastal village…" 已从生产路径移除（只保留在 graph 的 smoke
 *   占位中，patch 后会被真实 prompt 整体覆盖）；
 * - 长度预算 + 控制字符剥离 + 空字段 fail-closed 省略；
 * - 玩家原始输入、restricted/private 事件、principal/participant id、
 *   内部游标、角色 profile 一律不进入 prompt。
 */
import type { RecordRuntimeScope } from "../../database/postgres/public.ts";
import { imageVisualProfile, resolveImageVisualStyle } from "./visual-profiles.ts";

/** 固定质量/Anima 平涂视觉基底（与原 graph node 4 前缀逐字一致）。 */
export const SCENE_IMAGE_BASE_PREFIX =
  "masterpiece, best quality, score_7, safe, highres, official art, environment, no characters, clean lineart, flat colors, soft anime shading,";

/** 当前阶段只做无人物的场景建立图；人物/角色一致性另立管线。 */
export const SCENE_IMAGE_ENVIRONMENT_ONLY_RULES =
  "environment-only establishing shot, empty scene, no people, no humanoid figures, no faces, no bodies, no character silhouettes, no dialogue, no speech bubbles";

/** 固定负面约束（与 graph node 5 的基础串一致，并补场景-only边界）。 */
export const SCENE_IMAGE_NEGATIVE_PROMPT =
  "worst quality, low quality, score_1, score_2, score_3, bad anatomy, bad hands, extra fingers, duplicate, text, watermark, signature, logo, UI, frame, people, person, human, humanoid, character, portrait, face, body, dialogue, speech bubble";

/** positive prompt 总预算（超出从末位块向前丢弃，保基底）。 */
export const SCENE_PROMPT_MAX_CHARS = 1600;

/** 单字段上限（与方案文档 §3 一致）。 */
const FIELD_LIMITS = {
  worldName: 80,
  era: 80,
  location: 120,
  weather: 80,
  displayTime: 60,
  tension: 100,
  objective: 120,
} as const;

/** 剥离控制字符（保留 \n 作为块分隔），压缩空白，截断到有界长度。 */
function sanitizeField(value: string, maxLength: number): string {
  const cleaned = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
  return cleaned.slice(0, maxLength).trim();
}

export type ScenePromptScope = Pick<
  RecordRuntimeScope,
  "brief" | "displayTime" | "recentPublicEvents" | "style"
>;

export interface ScenePromptResult {
  positivePrompt: string;
  negativePrompt: string;
  /** 实际纳入的块标签（顺序即渲染顺序；测试与诊断用）。 */
  includedBlocks: readonly string[];
  /** 实际使用的视觉 profile key（未知风格 fail-closed 到 modern）。 */
  visualStyle: string;
}

/**
 * 组装 positive prompt：固定基底 + 视觉 profile + World/Story/Scene/Canon/
 * Lore/Focus。空字段省略（fail-closed，不输出空标签）；超预算从末位块
 * 向前丢弃——基底与 profile 是固定头部，永不被动态数据挤掉。
 */
export function composeScenePrompt(scope: ScenePromptScope): ScenePromptResult {
  const { brief } = scope;
  const profile = imageVisualProfile(scope.style);
  const blocks: { label: string; text: string }[] = [];

  // Scene-only boundary：summary/story/canon/lore/公开事件都可能携带人物叙事，
  // 当前阶段不把它们原文送入 T2I；人物出镜以后另建 presence/character 管线。
  const worldParts = [
    sanitizeField(brief.worldName, FIELD_LIMITS.worldName),
    sanitizeField(brief.era, FIELD_LIMITS.era),
  ].filter((part) => part.length > 0);
  if (worldParts.length > 0) blocks.push({ label: "world", text: `World context: ${worldParts.join(" · ")}` });

  const sceneParts = [
    sanitizeField(brief.location, FIELD_LIMITS.location),
    sanitizeField(brief.weather, FIELD_LIMITS.weather),
    sanitizeField(scope.displayTime, FIELD_LIMITS.displayTime),
    sanitizeField(brief.tension, FIELD_LIMITS.tension),
    sanitizeField(brief.objective, FIELD_LIMITS.objective),
  ].filter((part) => part.length > 0);
  if (sceneParts.length > 0) blocks.push({ label: "scene", text: `Scene conditions: ${sceneParts.join(" · ")}` });

  // 预算：动态块只有 world context + scene conditions；profile 与 environment-only
  // 规则固定在头部，永不被动态数据挤掉。
  const kept = [...blocks];
  const head = `${SCENE_IMAGE_BASE_PREFIX}\n${profile.visualPrompt}\n${SCENE_IMAGE_ENVIRONMENT_ONLY_RULES}`;
  const render = (list: { text: string }[]) =>
    `${head}\n\n${list.map((block) => block.text).join("\n")}`;
  while (kept.length > 0 && render(kept).length > SCENE_PROMPT_MAX_CHARS) {
    kept.pop();
  }

  return {
    positivePrompt: render(kept),
    negativePrompt: `${SCENE_IMAGE_NEGATIVE_PROMPT}, ${profile.negativeAdditions}`,
    includedBlocks: ["profile", ...kept.map((block) => block.label)],
    visualStyle: resolveImageVisualStyle(scope.style),
  };
}
