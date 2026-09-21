/**
 * 酒馆格式（Tavern/SillyTavern）角色卡与世界书解析器。
 * 零依赖：PNG chunk 手工扫描；全部 fail-closed，返回类型化错误，绝不半写入。
 * 规范见 docs/development/TAVERN-IMPORT.md。
 */

export type TavernImportErrorCode =
  | "TAVERN_IMPORT_TOO_LARGE"
  | "TAVERN_IMPORT_BAD_BYTES"
  | "TAVERN_IMPORT_PNG_NO_CARD"
  | "TAVERN_IMPORT_BAD_BASE64"
  | "TAVERN_IMPORT_BAD_JSON"
  | "TAVERN_IMPORT_UNKNOWN_FORMAT"
  | "TAVERN_IMPORT_MISSING_FIELDS"
  /** 批次 T8：目标世界已归档（只读封存）。 */
  | "TAVERN_IMPORT_WORLD_ARCHIVED";

export class TavernImportError extends Error {
  readonly code: TavernImportErrorCode;
  constructor(code: TavernImportErrorCode, message: string) {
    super(message);
    this.name = "TavernImportError";
    this.code = code;
  }
}

export const TAVERN_IMPORT_MAX_BYTES = 10 * 1024 * 1024;

export interface TavernWorldBookEntry {
  name: string;
  content: string;
  enabled: boolean;
  /**
   * 原始 uid（若有）——仅 bundle 内信息列保留；不作跨上传身份、
   * 不进 article_import_entries 唯一键。
   */
  uid: string | null;
  /** 在解析列表中的位置（file_exact 身份分量：stable_entry_identity）。 */
  ordinal: number;
}

export interface TavernCharacterCard {
  spec: "chara_card_v2" | "chara_card_v3" | "tavern-v1";
  name: string;
  description: string;
  personality: string;
  scenario: string;
  firstMes: string;
  mesExample: string;
  creatorNotes: string;
  systemPrompt: string;
  postHistoryInstructions: string;
  alternateGreetings: string[];
  tags: string[];
  creator: string;
  characterVersion: string;
  /**
   * 批次 T6：V2 扩展点 data.extensions.realm_skills 透传（卡携带技能定义
   * 来源）。原始形状在此保留，合法性由导入服务校验（非法条目跳过 +
   * warnings，绝不静默参局）。
   */
  realmSkills: TavernRealmSkillDraft[];
}

/** 卡携带技能草稿（未校验；check 原样透传，由导入服务按 T5 契约预验）。 */
export interface TavernRealmSkillDraft {
  skillKey: string;
  title: string;
  description: string;
  check?: unknown;
}

export type TavernParseResult =
  | {
      kind: "character";
      card: TavernCharacterCard;
      /** PNG 卡本体（作为头像存储）；JSON 卡为 null。 */
      png: Buffer | null;
      /** 卡内嵌世界书（可空）。 */
      book: TavernWorldBookEntry[] | null;
    }
  | { kind: "worldbook"; book: TavernWorldBookEntry[] };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asTextList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/** 图片 magic bytes 验证（不信扩展名与声明的 content-type）。 */
export function sniffImageContentType(
  bytes: Buffer,
): "image/png" | "image/jpeg" | "image/webp" | null {
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return "image/png";
  }
  if (bytes.length >= 3
    && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 12
    && bytes.toString("ascii", 0, 4) === "RIFF"
    && bytes.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  return null;
}

/** 手工扫描 PNG chunk，取 tEXt 块 keyword=chara（回退 ccv3）的 base64 文本。 */
export function extractPngCardText(bytes: Buffer): {
  keyword: "chara" | "ccv3";
  base64: string;
} | null {
  if (sniffImageContentType(bytes) !== "image/png") return null;
  let chara: string | null = null;
  let ccv3: string | null = null;
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) break;
    if (type === "tEXt") {
      const data = bytes.subarray(dataStart, dataEnd);
      const nul = data.indexOf(0);
      if (nul > 0) {
        const keyword = data.toString("latin1", 0, nul);
        const value = data.toString("latin1", nul + 1);
        if (keyword === "chara") chara = value;
        if (keyword === "ccv3") ccv3 = value;
      }
    }
    if (type === "IEND") break;
    offset = dataEnd + 4;
  }
  if (chara !== null) return { keyword: "chara", base64: chara };
  if (ccv3 !== null) return { keyword: "ccv3", base64: ccv3 };
  return null;
}

function decodeCardJson(base64: string): unknown {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64, "base64");
  } catch {
    throw new TavernImportError(
      "TAVERN_IMPORT_BAD_BASE64",
      "PNG 卡内的角色数据不是合法 base64。",
    );
  }
  let text: string;
  try {
    text = bytes.toString("utf8");
  } catch {
    throw new TavernImportError(
      "TAVERN_IMPORT_BAD_BASE64",
      "PNG 卡内的角色数据不是合法 UTF-8。",
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new TavernImportError(
      "TAVERN_IMPORT_BAD_JSON",
      "角色卡 JSON 解析失败。",
    );
  }
}

function normalizeCard(data: Record<string, unknown>): TavernCharacterCard {
  const name = asText(data.name).trim();
  if (!name || !asText(data.description).trim()) {
    throw new TavernImportError(
      "TAVERN_IMPORT_MISSING_FIELDS",
      "角色卡缺少 name 或 description。",
    );
  }
  return {
    spec: "chara_card_v2",
    name,
    description: asText(data.description),
    personality: asText(data.personality),
    scenario: asText(data.scenario),
    firstMes: asText(data.first_mes),
    mesExample: asText(data.mes_example),
    creatorNotes: asText(data.creator_notes),
    systemPrompt: asText(data.system_prompt),
    postHistoryInstructions: asText(data.post_history_instructions),
    alternateGreetings: asTextList(data.alternate_greetings),
    tags: asTextList(data.tags),
    creator: asText(data.creator),
    characterVersion: asText(data.character_version),
    realmSkills: normalizeRealmSkills(data.extensions),
  };
}

/** extensions.realm_skills 透传：非数组 → 空；非对象条目跳过（形状噪声）。 */
function normalizeRealmSkills(value: unknown): TavernRealmSkillDraft[] {
  if (!isObject(value)) return [];
  const raw = value.realm_skills;
  if (!Array.isArray(raw)) return [];
  const drafts: TavernRealmSkillDraft[] = [];
  for (const item of raw) {
    if (!isObject(item)) continue;
    drafts.push({
      skillKey: asText(item.skillKey).trim(),
      title: asText(item.title).trim(),
      description: asText(item.description).trim(),
      ...(item.check !== undefined ? { check: item.check } : {}),
    });
  }
  return drafts;
}

function normalizeBookEntries(value: unknown): TavernWorldBookEntry[] {
  const raw = isObject(value) ? value.entries : undefined;
  const list = Array.isArray(raw)
    ? raw
    : isObject(raw)
      ? Object.values(raw)
      : null;
  if (!list) {
    throw new TavernImportError(
      "TAVERN_IMPORT_UNKNOWN_FORMAT",
      "世界书缺少 entries。",
    );
  }
  const entries: TavernWorldBookEntry[] = [];
  for (const [index, item] of list.entries()) {
    if (!isObject(item)) continue;
    const content = asText(item.content).trim();
    if (!content) continue;
    const keys = asTextList(item.keys);
    const name = asText(item.name).trim()
      || asText(item.comment).trim()
      || keys[0]
      || `条目 ${index + 1}`;
    // uid 仅作 bundle 内信息（数字或字符串原样保留）；不是稳定身份来源。
    const uid = typeof item.uid === "number" && Number.isSafeInteger(item.uid)
      ? String(item.uid)
      : asText(item.uid).trim() || null;
    entries.push({
      name,
      content,
      enabled: item.enabled !== false && item.disable !== true,
      uid,
      ordinal: index,
    });
  }
  return entries;
}

/** 解析上传文件：PNG 卡 / JSON 卡（V2/V1）/ 独立世界书。 */
export function parseTavernImport(bytes: Buffer): TavernParseResult {
  if (bytes.length === 0 || bytes.length > TAVERN_IMPORT_MAX_BYTES) {
    throw new TavernImportError(
      "TAVERN_IMPORT_TOO_LARGE",
      "文件为空或超过 10MB 上限。",
    );
  }

  const imageType = sniffImageContentType(bytes);
  if (imageType === "image/png") {
    const embedded = extractPngCardText(bytes);
    if (!embedded) {
      throw new TavernImportError(
        "TAVERN_IMPORT_PNG_NO_CARD",
        "PNG 中没有角色卡数据块（chara/ccv3）。",
      );
    }
    const parsed = decodeCardJson(embedded.base64);
    if (!isObject(parsed)) {
      throw new TavernImportError(
        "TAVERN_IMPORT_BAD_JSON",
        "角色卡 JSON 不是对象。",
      );
    }
    const spec = embedded.keyword === "ccv3" ? "chara_card_v3" : "chara_card_v2";
    const data = isObject(parsed.data) ? parsed.data : parsed;
    const card = { ...normalizeCard(data), spec } as TavernCharacterCard;
    const book = isObject(data.character_book)
      ? normalizeBookEntries(data.character_book)
      : null;
    return { kind: "character", card, png: bytes, book };
  }
  if (imageType !== null) {
    throw new TavernImportError(
      "TAVERN_IMPORT_BAD_BYTES",
      "图片中不含可识别的角色卡数据。",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new TavernImportError(
      "TAVERN_IMPORT_BAD_JSON",
      "既不是可识别的图片，也不是合法 JSON。",
    );
  }
  if (!isObject(parsed)) {
    throw new TavernImportError(
      "TAVERN_IMPORT_UNKNOWN_FORMAT",
      "无法识别的导入格式。",
    );
  }

  // V2 卡：spec = chara_card_v2，字段在 data 内。
  if (parsed.spec === "chara_card_v2" && isObject(parsed.data)) {
    const card = normalizeCard(parsed.data);
    const book = isObject(parsed.data.character_book)
      ? normalizeBookEntries(parsed.data.character_book)
      : null;
    return { kind: "character", card, png: null, book };
  }
  // V1 legacy：无 spec，平铺 name + description。
  if (typeof parsed.name === "string" && typeof parsed.description === "string") {
    return {
      kind: "character",
      card: { ...normalizeCard(parsed), spec: "tavern-v1" },
      png: null,
      book: null,
    };
  }
  // 独立世界书导出。
  if (parsed.entries !== undefined) {
    return { kind: "worldbook", book: normalizeBookEntries(parsed) };
  }
  throw new TavernImportError(
    "TAVERN_IMPORT_UNKNOWN_FORMAT",
    "无法识别的导入格式。",
  );
}
