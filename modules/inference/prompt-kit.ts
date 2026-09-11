/**
 * REALM Prompt Kit（Prompt System v2 §A）。
 *
 * 分层契约：
 * - system message = 静态 English 策略（身份/权限/输出契约/voice），
 *   绝不包含动态世界资料、角色名或中文说明；
 * - user message = 结构化 context block（动态世界资料/玩家原话原样保留
 *   原始语言，标签为英文）；
 * - 长度/枚举约束来自调用方传入的真实常量（normalizer/schema 同源），
 *   prompt 文本不再维护第二份数字；
 * - output-language 规则变量化：跟随玩家输入，缺席时用配置语言，
 *   不枚举固定语种、不臆造。
 */
import {
  WORLD_STYLE_PROMPT_PROFILES,
  type WorldStyle,
} from "../style/world-style.ts";

export const PROMPT_KIT_VERSION = "prompt-kit/v1";

/**
 * Anti-AI / natural voice 片段：只注入自然语言生成链（Narrator、角色
 * dialogue/reaction、First Night、Genesis 等）；分类器/门禁器不使用。
 */
export const NATURAL_VOICE_RULES = [
  "Voice:",
  "- Never mention AI, models, prompts, schemas, policies, tools, hidden context, or the generation process.",
  "- No assistant mannerisms: no \"Certainly\", no \"As requested\", no \"As an ...\", no \"It is worth noting\", no hollow encouragement, no empty summaries, no tutorial tone, no meta-explanations.",
  "- Do not echo the player's wording back; do not fill fields with stock phrases or formulaic patterns.",
  "- Ground every sentence in concrete details from the supplied world and scene; vary sentence structure; keep each field doing its own job — short and vivid.",
  "- When evidence is missing, omit the field or use the neutral form the contract allows; never fill gaps with pretty filler.",
  "- Characters speak as people with an identity; the Narrator writes only authorized public environment and story beats.",
].join("\n");

/** 分类器/门禁器的短理由约束（不强行文学化）。 */
export const CONCISE_RATIONALE_RULE =
  "Keep reason fields short, clear and natural — one plain sentence, no literary flourish.";

/**
 * 变量化 output-language 规则：跟随最近玩家输入；缺席时用世界配置语言
 * （可用时传入实际值），不可用时不臆造。
 */
export function outputLanguageRule(configuredLanguage?: string): string {
  const base =
    "Write in the language of the latest player input.";
  return configuredLanguage && configuredLanguage.trim()
    ? `${base} If there is no player input, use the world's configured language (${configuredLanguage.trim()}).`
    : `${base} If there is no player input, use the world's configured language.`;
}

/** 文风块（English，system 可注入）。 */
export function stylePromptBlock(style: WorldStyle): string {
  const profile = WORLD_STYLE_PROMPT_PROFILES[style];
  return [
    `Style: this world uses a ${profile.label} register.`,
    `Tone: ${profile.tone}.`,
    `Diction: ${profile.diction}.`,
    `Imagery: ${profile.imagery}.`,
  ].join("\n");
}

/**
 * 动态上下文块：`[Label]` + 原样值（字符串）或 JSON.stringify（结构）。
 * 标签为英文；动态内容保持原始语言，不做机器翻译。
 */
export function contextBlock(label: string, value: unknown): string {
  const body = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return `[${label}]\n${body}`;
}

/** 组装 user message：空块结构性省略，块间空行分隔。 */
export function composeContext(
  blocks: readonly (string | null | undefined | false | "")[],
): string {
  return blocks
    .filter((block): block is string => typeof block === "string" && block.length > 0)
    .join("\n\n");
}

/** 结构化输出字段说明：约束值必须来自调用方的真实常量。 */
export type JsonFieldSpec = {
  name: string;
  kind: "string" | "boolean" | "string[]" | "enum" | "object" | "object[]";
  /** 缺省 true（必给）；false 时字段可选（无变化/无内容就省略）。 */
  required?: boolean;
  /** 值可为 null（与 normalizer 同源语义；仅允许当前确实容忍 null 的字段）。 */
  nullable?: boolean;
  /** 真实长度上限（normalizer 同源常量）。 */
  maxLength?: number;
  /** enum 的真实值集合（normalizer 同源常量）。 */
  values?: readonly string[];
  /** 一句英文说明。 */
  note?: string;
};

/**
 * 结构化输出说明生成器：schema 形状、长度上限、枚举值全部来自传入 spec，
 * prompt 文本不重复写死任何数字或枚举。
 */
export function jsonOutputInstruction(fields: readonly JsonFieldSpec[]): string {
  const schema = fields.map((field) => {
    const optional = field.required === false ? "?" : "";
    let type: string;
    switch (field.kind) {
      case "boolean":
        type = "boolean";
        break;
      case "string[]":
        type = "string[]";
        break;
      case "enum":
        type = (field.values ?? []).map((value) => `"${value}"`).join(' | ');
        break;
      case "object":
        type = "object";
        break;
      case "object[]":
        type = "array of objects";
        break;
      default:
        type = field.maxLength !== undefined
          ? `string (<= ${field.maxLength} chars)`
          : "string";
    }
    const nullable = field.nullable === true ? " or null" : "";
    const note = field.note ? ` — ${field.note}` : "";
    return `"${field.name}"${optional}: ${type}${nullable}${note}`;
  });
  return [
    "Respond with exactly one JSON object and nothing else — no prose, no markdown fences.",
    `Schema: {${schema.join(", ")}}`,
    "Optional fields: omit them entirely when there is no change or no content.",
  ].join("\n");
}
