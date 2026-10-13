/**
 * RealmWorldContentResolver · 已挂载签名 RealmWorld 包的 ContentResolver 实现
 *（引擎升级计划 §2.2 的 world-bound 侧）。
 *
 * 内容来源：已挂载包的内容模块（content/index.json 的 modules 列表存在时
 * 仅读取列表内模块）：
 * - content/world.json    · 世界文档（loader 已校验 identity/title/settings）
 * - content/characters.json · realmworld-characters v1（角色定义 + 玩家席位）
 * - content/actions.json  · realmworld-actions v1（skill/asset/effect/stance）
 * - content/story.json    · realmworld-story v1（story + record + opening）
 * - content/scene.json    · realmworld-scenes v1
 * - content/goals.json    · realmworld-goals v1（复用 realmworld-content.ts）
 * - content/messages.json · realmworld-messages v1（按 locale 的扁平消息束）
 *
 * 挂载/缓存先行：构造时同步解析并冻结全部已安装模块，ContentResolver 方法
 * 本身不执行任何 IO。本地化选择与 realmworld-runtime-content.ts 相同：
 * 精确 locale → 语言前缀 → en → 字典序首个（构造器 locale 作为请求语言
 * 之后的额外回退层）。
 *
 * fail-closed 语义（contract 见 ./public.ts）：
 * - 只接受精确 world-bound 身份：binding 必须 kind "world" 且与包 manifest
 *   精确一致；base binding 或任何身份夹带一律 CONTENT_IDENTITY_REJECTED；
 * - 请求非法（未知请求键、非法语言、不安全 id、非法 actionKind）抛
 *   ContentResolutionError（CONTENT_REQUEST_INVALID）；
 * - 未知内容键（contentKey/characterKey/actionKey/storyKey/sceneKey/
 *   goalKey）或未安装的模块返回 null（list 返回冻结空数组），绝不回退到
 *   其他内容包或默认文案；
 * - 包内容自身非法在构造时即抛 CONTENT_REQUEST_INVALID（绝不带错运行）；
 * - 返回值深冻结，调用方无法 mutate 共享内容。
 */
import {
  ContentResolutionError,
  assertExactBinding,
  normalizeContentRequest,
  normalizeGenesisContentRequest,
  type ActionContentRequest,
  type ActionListRequest,
  type CharacterContentRequest,
  type ContentActionKind,
  type ContentLanguage,
  type ContentRequestBase,
  type ContentResolver,
  type GenesisContentRequest,
  type GoalContentRequest,
  type MessagesContentRequest,
  type ResolvedActionDefinition,
  type ResolvedCharacterDefinition,
  type ResolvedSceneContent,
  type ResolvedStoryContent,
  type ResolvedWorldContent,
  type SceneContentRequest,
  type StoryContentRequest,
  type WorldContentRequest,
} from "./public.ts";
import type { GoalDefinition } from "../goals/public.ts";
import type { JsonValue } from "../runtime/public.ts";
import { createRealmWorldContentStore } from "../world-transfer/realmworld-content.ts";
import {
  mountRealmWorld,
  type RealmWorldSignatureVerifier,
} from "../world-transfer/realmworld-loader.ts";
import type { RealmWorldManifestV1 } from "../world-transfer/realmworld-manifest.ts";
import type { WorldBinding } from "../world-transfer/realm-save.ts";

/** 已挂载 RealmWorld 包内容（mountRealmWorld / loadRealmWorldArchive 结果形状）。 */
export interface MountedRealmWorldContent {
  manifest: RealmWorldManifestV1;
  files: ReadonlyMap<string, Uint8Array>;
}

const INDEX_PATH = "content/index.json";
const WORLD_PATH = "content/world.json";
const CHARACTERS_PATH = "content/characters.json";
const ACTIONS_PATH = "content/actions.json";
const STORY_PATH = "content/story.json";
const SCENE_PATH = "content/scene.json";
const GOALS_PATH = "content/goals.json";
const MESSAGES_PATH = "content/messages.json";

const SAFE_LOCALE = /^[A-Za-z0-9-]+$/;
const SAFE_IDENTITY = /^[A-Za-z0-9._:-]+$/;
const MAX_TEXT_LENGTH = 512;
const MAX_KEY_LENGTH = 256;
const MAX_ENTRIES = 256;
const ACTION_KINDS: readonly ContentActionKind[] = ["skill", "asset", "effect", "stance"];

type TextMap = Readonly<Record<string, string>>;

interface CharacterEntry {
  characterKey: string;
  displayName: TextMap;
  role: TextMap;
  summary: TextMap;
  isPlayer: boolean;
}

interface ActionEntry {
  actionKind: ContentActionKind;
  actionKey: string;
  title: TextMap;
  description: TextMap;
  rulePackKey: string;
  consumable: boolean;
  effectKind: string | null;
  metadata: Readonly<Record<string, JsonValue>>;
}

interface StoryEntry {
  storyKey: string;
  title: TextMap;
  premise: TextMap;
  recordTitle: TextMap;
  opening: {
    speaker: TextMap;
    content: TextMap;
    segments: readonly { id: string; kind: string; content: TextMap; speechMode: string }[];
  };
}

interface SceneEntry {
  sceneKey: string;
  title: TextMap;
  location: TextMap;
  weather: TextMap;
  tension: TextMap;
  displayTime: TextMap;
  objective: TextMap;
}

interface PackageContent {
  contentKey: string;
  world: { title: TextMap; settings: Readonly<Record<string, JsonValue>> } | null;
  characters: readonly CharacterEntry[] | null;
  actions: readonly ActionEntry[] | null;
  stories: readonly StoryEntry[] | null;
  scenes: readonly SceneEntry[] | null;
  goals: readonly GoalDefinition[] | null;
  messages: Readonly<Record<string, Readonly<Record<string, string>>>> | null;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isPlainObject(value) && Object.values(value).every(isJsonValue);
}

function invalid(message: string): never {
  throw new ContentResolutionError("CONTENT_REQUEST_INVALID", message);
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      invalid(`RealmWorld content key ${where}.${key} is unknown`);
    }
  }
}

function required(value: Record<string, unknown>, key: string, where: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(value, key)) {
    invalid(`RealmWorld content key ${where}.${key} is required`);
  }
  return value[key];
}

function text(value: unknown, where: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_TEXT_LENGTH
    || value.trim() !== value
  ) {
    invalid(`RealmWorld content text ${where} is invalid`);
  }
  return value;
}

function identity(value: unknown, where: string): string {
  const result = text(value, where);
  if (result.length > MAX_KEY_LENGTH || !SAFE_IDENTITY.test(result)) {
    invalid(`RealmWorld content identity ${where} is invalid`);
  }
  return result;
}

function parseJson(bytes: Uint8Array, path: string): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    invalid(`RealmWorld content module ${path} is not valid JSON`);
  }
}

function parseTextMap(value: unknown, where: string): TextMap {
  if (!isPlainObject(value)) {
    invalid(`RealmWorld content text map ${where} is invalid`);
  }
  const entries = Object.entries(value);
  if (entries.length === 0) {
    invalid(`RealmWorld content text map ${where} is empty`);
  }
  const result: Record<string, string> = {};
  for (const [locale, raw] of entries) {
    if (!SAFE_LOCALE.test(locale)) {
      invalid(`RealmWorld content locale ${where}.${locale} is invalid`);
    }
    result[locale] = text(raw, `${where}.${locale}`);
  }
  return deepFreeze(result);
}

/** 与 realmworld-runtime-content.ts 相同的本地化选择（精确 → 前缀 → en → 首个）。 */
function selectText(map: TextMap, language: ContentLanguage, locale: string): string {
  const candidates = [
    language,
    language.split("-", 1)[0]!,
    locale,
    locale.split("-", 1)[0]!,
    "en",
  ];
  for (const candidate of candidates) {
    const value = map[candidate];
    if (value !== undefined) return value;
  }
  return map[Object.keys(map).sort()[0]!]!;
}

function assertSchema(
  value: Record<string, unknown>,
  format: string,
  where: string,
): void {
  if (value.format !== format || value.schemaVersion !== 1) {
    invalid(`RealmWorld content schema ${where} is unsupported`);
  }
}

function parseCharacters(value: unknown): readonly CharacterEntry[] {
  if (!isPlainObject(value)) invalid("RealmWorld characters document is invalid");
  assertExactKeys(value, ["format", "schemaVersion", "characters"], "characters");
  assertSchema(value, "realmworld-characters", "characters");
  const list = required(value, "characters", "characters");
  if (!Array.isArray(list) || list.length > MAX_ENTRIES) {
    invalid("RealmWorld characters list is invalid");
  }
  const seen = new Set<string>();
  return deepFreeze((list as unknown[]).map((raw, index) => {
    const where = `characters.characters[${index}]`;
    if (!isPlainObject(raw)) invalid(`RealmWorld ${where} is invalid`);
    assertExactKeys(raw, ["characterKey", "displayName", "role", "summary", "isPlayer"], where);
    const characterKey = identity(required(raw, "characterKey", where), `${where}.characterKey`);
    if (seen.has(characterKey)) invalid("RealmWorld character keys must be unique");
    seen.add(characterKey);
    if (typeof raw.isPlayer !== "boolean") invalid(`RealmWorld ${where}.isPlayer is invalid`);
    return {
      characterKey,
      displayName: parseTextMap(required(raw, "displayName", where), `${where}.displayName`),
      role: parseTextMap(required(raw, "role", where), `${where}.role`),
      summary: parseTextMap(required(raw, "summary", where), `${where}.summary`),
      isPlayer: raw.isPlayer,
    } satisfies CharacterEntry;
  }));
}

function parseActions(value: unknown): readonly ActionEntry[] {
  if (!isPlainObject(value)) invalid("RealmWorld actions document is invalid");
  assertExactKeys(value, ["format", "schemaVersion", "actions"], "actions");
  assertSchema(value, "realmworld-actions", "actions");
  const list = required(value, "actions", "actions");
  if (!Array.isArray(list) || list.length > MAX_ENTRIES) {
    invalid("RealmWorld actions list is invalid");
  }
  const seen = new Set<string>();
  return deepFreeze((list as unknown[]).map((raw, index) => {
    const where = `actions.actions[${index}]`;
    if (!isPlainObject(raw)) invalid(`RealmWorld ${where} is invalid`);
    assertExactKeys(
      raw,
      ["actionKind", "actionKey", "title", "description", "rulePackKey", "consumable", "effectKind", "metadata"],
      where,
    );
    const actionKind = required(raw, "actionKind", where);
    if (!ACTION_KINDS.includes(actionKind as ContentActionKind)) {
      invalid(`RealmWorld ${where}.actionKind is invalid`);
    }
    const actionKey = identity(required(raw, "actionKey", where), `${where}.actionKey`);
    if (seen.has(actionKey)) invalid("RealmWorld action keys must be unique");
    seen.add(actionKey);
    const rulePackKey = identity(required(raw, "rulePackKey", where), `${where}.rulePackKey`);
    if (typeof raw.consumable !== "boolean") invalid(`RealmWorld ${where}.consumable is invalid`);
    if (raw.effectKind !== null && typeof raw.effectKind !== "string") {
      invalid(`RealmWorld ${where}.effectKind is invalid`);
    }
    const metadata = required(raw, "metadata", where);
    if (!isPlainObject(metadata) || !isJsonValue(metadata)) {
      invalid(`RealmWorld ${where}.metadata is invalid`);
    }
    return {
      actionKind: actionKind as ContentActionKind,
      actionKey,
      title: parseTextMap(required(raw, "title", where), `${where}.title`),
      description: parseTextMap(required(raw, "description", where), `${where}.description`),
      rulePackKey,
      consumable: raw.consumable,
      effectKind: raw.effectKind as string | null,
      metadata: deepFreeze(structuredClone(metadata)) as Readonly<Record<string, JsonValue>>,
    } satisfies ActionEntry;
  }));
}

function parseStories(value: unknown): readonly StoryEntry[] {
  if (!isPlainObject(value)) invalid("RealmWorld story document is invalid");
  assertExactKeys(value, ["format", "schemaVersion", "stories"], "story");
  assertSchema(value, "realmworld-story", "story");
  const list = required(value, "stories", "story");
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_ENTRIES) {
    invalid("RealmWorld story list is invalid");
  }
  const seen = new Set<string>();
  return deepFreeze((list as unknown[]).map((raw, index) => {
    const where = `story.stories[${index}]`;
    if (!isPlainObject(raw)) invalid(`RealmWorld ${where} is invalid`);
    assertExactKeys(raw, ["storyKey", "title", "premise", "recordTitle", "opening"], where);
    const storyKey = identity(required(raw, "storyKey", where), `${where}.storyKey`);
    if (seen.has(storyKey)) invalid("RealmWorld story keys must be unique");
    seen.add(storyKey);
    const openingRaw = required(raw, "opening", where);
    if (!isPlainObject(openingRaw)) invalid(`RealmWorld ${where}.opening is invalid`);
    assertExactKeys(openingRaw, ["speaker", "content", "segments"], `${where}.opening`);
    const segmentsRaw = required(openingRaw, "segments", `${where}.opening`);
    if (!Array.isArray(segmentsRaw) || segmentsRaw.length > MAX_ENTRIES) {
      invalid(`RealmWorld ${where}.opening.segments is invalid`);
    }
    const segmentIds = new Set<string>();
    const segments = deepFreeze((segmentsRaw as unknown[]).map((segmentRaw, segmentIndex) => {
      const segmentWhere = `${where}.opening.segments[${segmentIndex}]`;
      if (!isPlainObject(segmentRaw)) invalid(`RealmWorld ${segmentWhere} is invalid`);
      assertExactKeys(segmentRaw, ["id", "kind", "content", "speechMode"], segmentWhere);
      const id = identity(required(segmentRaw, "id", segmentWhere), `${segmentWhere}.id`);
      if (segmentIds.has(id)) invalid("RealmWorld opening segment ids must be unique");
      segmentIds.add(id);
      return {
        id,
        kind: identity(required(segmentRaw, "kind", segmentWhere), `${segmentWhere}.kind`),
        content: parseTextMap(required(segmentRaw, "content", segmentWhere), `${segmentWhere}.content`),
        speechMode: identity(
          required(segmentRaw, "speechMode", segmentWhere),
          `${segmentWhere}.speechMode`,
        ),
      };
    }));
    return {
      storyKey,
      title: parseTextMap(required(raw, "title", where), `${where}.title`),
      premise: parseTextMap(required(raw, "premise", where), `${where}.premise`),
      recordTitle: parseTextMap(required(raw, "recordTitle", where), `${where}.recordTitle`),
      opening: {
        speaker: parseTextMap(required(openingRaw, "speaker", `${where}.opening`), `${where}.opening.speaker`),
        content: parseTextMap(required(openingRaw, "content", `${where}.opening`), `${where}.opening.content`),
        segments,
      },
    } satisfies StoryEntry;
  }));
}

function parseScenes(value: unknown): readonly SceneEntry[] {
  if (!isPlainObject(value)) invalid("RealmWorld scene document is invalid");
  assertExactKeys(value, ["format", "schemaVersion", "scenes"], "scene");
  assertSchema(value, "realmworld-scenes", "scene");
  const list = required(value, "scenes", "scene");
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_ENTRIES) {
    invalid("RealmWorld scene list is invalid");
  }
  const seen = new Set<string>();
  return deepFreeze((list as unknown[]).map((raw, index) => {
    const where = `scene.scenes[${index}]`;
    if (!isPlainObject(raw)) invalid(`RealmWorld ${where} is invalid`);
    assertExactKeys(raw, ["sceneKey", "title", "location", "weather", "tension", "displayTime", "objective"], where);
    const sceneKey = identity(required(raw, "sceneKey", where), `${where}.sceneKey`);
    if (seen.has(sceneKey)) invalid("RealmWorld scene keys must be unique");
    seen.add(sceneKey);
    return {
      sceneKey,
      title: parseTextMap(required(raw, "title", where), `${where}.title`),
      location: parseTextMap(required(raw, "location", where), `${where}.location`),
      weather: parseTextMap(required(raw, "weather", where), `${where}.weather`),
      tension: parseTextMap(required(raw, "tension", where), `${where}.tension`),
      displayTime: parseTextMap(required(raw, "displayTime", where), `${where}.displayTime`),
      objective: parseTextMap(required(raw, "objective", where), `${where}.objective`),
    } satisfies SceneEntry;
  }));
}

function parseMessages(value: unknown): Readonly<Record<string, Readonly<Record<string, string>>>> {
  if (!isPlainObject(value)) invalid("RealmWorld messages document is invalid");
  assertExactKeys(value, ["format", "schemaVersion", "messages"], "messages");
  assertSchema(value, "realmworld-messages", "messages");
  const bundles = required(value, "messages", "messages");
  if (!isPlainObject(bundles)) invalid("RealmWorld messages bundles are invalid");
  const entries = Object.entries(bundles);
  if (entries.length === 0 || entries.length > MAX_ENTRIES) {
    invalid("RealmWorld messages bundles are invalid");
  }
  const result: Record<string, Readonly<Record<string, string>>> = {};
  for (const [locale, bundleRaw] of entries) {
    if (!SAFE_LOCALE.test(locale)) invalid(`RealmWorld messages locale ${locale} is invalid`);
    if (!isPlainObject(bundleRaw)) invalid(`RealmWorld messages bundle ${locale} is invalid`);
    const bundleEntries = Object.entries(bundleRaw);
    if (bundleEntries.length > MAX_ENTRIES) invalid(`RealmWorld messages bundle ${locale} is invalid`);
    const bundle: Record<string, string> = {};
    for (const [key, raw] of bundleEntries) {
      if (key.length === 0 || key.length > MAX_KEY_LENGTH || !SAFE_IDENTITY.test(key)) {
        invalid(`RealmWorld messages key ${locale}.${key} is invalid`);
      }
      bundle[key] = text(raw, `messages.messages.${locale}.${key}`);
    }
    result[locale] = deepFreeze(bundle);
  }
  return deepFreeze(result);
}

function parseWorldModule(
  value: unknown,
  manifest: RealmWorldManifestV1,
): PackageContent["world"] {
  if (!isPlainObject(value)) invalid("RealmWorld world document is invalid");
  assertExactKeys(value, ["worldId", "title", "settings"], "world");
  if (value.worldId !== manifest.worldId) {
    invalid("RealmWorld world identity does not match its manifest");
  }
  const settingsValue = required(value, "settings", "world");
  if (!isPlainObject(settingsValue) || !isJsonValue(settingsValue)) {
    invalid("RealmWorld world settings are invalid");
  }
  return deepFreeze({
    title: parseTextMap(required(value, "title", "world"), "world.title"),
    settings: deepFreeze(structuredClone(settingsValue)) as Readonly<Record<string, JsonValue>>,
  });
}

function parseGoalsModule(mount: MountedRealmWorldContent): readonly GoalDefinition[] {
  try {
    return deepFreeze(
      createRealmWorldContentStore(mount).listGoalDefinitions()
        .map((goal) => structuredClone(goal)),
    );
  } catch (error) {
    if (error instanceof ContentResolutionError) throw error;
    invalid("RealmWorld goals document is invalid");
  }
}

/** content/index.json 存在时仅其 modules 列表内的模块可读；缺失时按已知路径直读。 */
function moduleBytes(
  files: ReadonlyMap<string, Uint8Array>,
  indexedModules: ReadonlySet<string> | null,
  path: string,
): Uint8Array | undefined {
  if (indexedModules && !indexedModules.has(path)) return undefined;
  return files.get(path);
}

function readIndexedModules(files: ReadonlyMap<string, Uint8Array>): ReadonlySet<string> | null {
  const bytes = files.get(INDEX_PATH);
  if (!bytes) return null;
  const value = parseJson(bytes, INDEX_PATH);
  if (
    !isPlainObject(value)
    || !Array.isArray(value.modules)
    || !value.modules.every((module) => typeof module === "string")
  ) {
    invalid("RealmWorld content index is invalid");
  }
  return new Set(value.modules as string[]);
}

function parsePackageContent(mount: MountedRealmWorldContent): PackageContent {
  const indexed = readIndexedModules(mount.files);
  const read = (path: string): Uint8Array | undefined => moduleBytes(mount.files, indexed, path);
  const worldBytes = read(WORLD_PATH);
  const charactersBytes = read(CHARACTERS_PATH);
  const actionsBytes = read(ACTIONS_PATH);
  const storyBytes = read(STORY_PATH);
  const sceneBytes = read(SCENE_PATH);
  const goalsBytes = read(GOALS_PATH);
  const messagesBytes = read(MESSAGES_PATH);
  return {
    contentKey: mount.manifest.worldId,
    world: worldBytes ? parseWorldModule(parseJson(worldBytes, WORLD_PATH), mount.manifest) : null,
    characters: charactersBytes ? parseCharacters(parseJson(charactersBytes, CHARACTERS_PATH)) : null,
    actions: actionsBytes ? parseActions(parseJson(actionsBytes, ACTIONS_PATH)) : null,
    stories: storyBytes ? parseStories(parseJson(storyBytes, STORY_PATH)) : null,
    scenes: sceneBytes ? parseScenes(parseJson(sceneBytes, SCENE_PATH)) : null,
    goals: goalsBytes ? parseGoalsModule(mount) : null,
    messages: messagesBytes ? parseMessages(parseJson(messagesBytes, MESSAGES_PATH)) : null,
  };
}

function settingString(settings: Readonly<Record<string, JsonValue>>, key: string): string {
  const value = settings[key];
  return typeof value === "string" ? value : "";
}

/** 请求侧 id 必须安全（非空、受长度限、仅安全字符），否则 CONTENT_REQUEST_INVALID。 */
function safeRequestId(value: unknown, name: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_KEY_LENGTH
    || !SAFE_IDENTITY.test(value)
  ) {
    throw new ContentResolutionError(
      "CONTENT_REQUEST_INVALID",
      `content request ${name} must be a safe non-empty identifier`,
    );
  }
  return value;
}

function assertLocale(locale: unknown): string {
  if (typeof locale !== "string" || locale.length === 0 || locale.trim() !== locale || !SAFE_LOCALE.test(locale)) {
    throw new ContentResolutionError(
      "CONTENT_REQUEST_INVALID",
      "RealmWorld content resolver locale is invalid",
    );
  }
  return locale;
}

/**
 * 由已挂载包内容同步创建 ContentResolver（测试与已挂载路径用）。binding
 * 必须是与包 manifest 精确一致的 world binding；base 或身份不符抛
 * CONTENT_IDENTITY_REJECTED。
 */
export function createRealmWorldContentResolverFromMount(
  mount: MountedRealmWorldContent,
  binding: WorldBinding,
  locale: string,
): ContentResolver {
  const fallbackLocale = assertLocale(locale);
  const exactBinding = assertExactBinding(binding, "binding");
  if (exactBinding.kind !== "world") {
    throw new ContentResolutionError(
      "CONTENT_IDENTITY_REJECTED",
      "the RealmWorld content resolver only serves exact world bindings",
    );
  }
  if (
    mount.manifest.worldId !== exactBinding.worldId
    || mount.manifest.worldVersion !== exactBinding.worldVersion
  ) {
    throw new ContentResolutionError(
      "CONTENT_IDENTITY_REJECTED",
      "mounted RealmWorld identity does not match the requested WorldBinding",
    );
  }
  const content = parsePackageContent(mount);
  // 身份基元常量：闭包内不依赖 narrowing。
  const mountedWorldId = exactBinding.worldId;
  const mountedWorldVersion = exactBinding.worldVersion;

  /** 公共身份校验 + world-bound 边界；返回规范化 contentKey/language。 */
  function worldScope(request: ContentRequestBase, extraKeys: readonly string[] = []) {
    const scope = normalizeContentRequest(request, extraKeys);
    if (
      scope.binding.kind !== "world"
      || scope.binding.worldId !== mountedWorldId
      || scope.binding.worldVersion !== mountedWorldVersion
    ) {
      throw new ContentResolutionError(
        "CONTENT_IDENTITY_REJECTED",
        "the RealmWorld content resolver only serves the mounted world identity",
      );
    }
    return scope;
  }

  /** contentKey 缺省 = 包主内容（manifest.worldId）；显式不符 = miss。 */
  function contentKeyMatches(contentKey: string | undefined): boolean {
    return contentKey === undefined || contentKey === content.contentKey;
  }

  function pick(map: TextMap, language: ContentLanguage): string {
    return selectText(map, language, fallbackLocale);
  }

  function toWorldContent(language: ContentLanguage): ResolvedWorldContent | null {
    if (!content.world) return null;
    const settings = content.world.settings;
    return deepFreeze({
      contentKey: content.contentKey,
      name: pick(content.world.title, language),
      era: settingString(settings, "era"),
      summary: settingString(settings, "summary"),
      calendarId: settingString(settings, "calendarId"),
      style: settingString(settings, "style"),
      weather: settingString(settings, "weather"),
      tension: settingString(settings, "tension"),
      displayTime: settingString(settings, "displayTime"),
      worldlineLabel: settingString(settings, "worldlineLabel"),
      settings: deepFreeze(structuredClone(settings)),
    });
  }

  function toCharacter(entry: CharacterEntry, language: ContentLanguage): ResolvedCharacterDefinition {
    return deepFreeze({
      characterKey: entry.characterKey,
      displayName: pick(entry.displayName, language),
      role: pick(entry.role, language),
      summary: pick(entry.summary, language),
      isPlayer: entry.isPlayer,
    });
  }

  function toAction(entry: ActionEntry, language: ContentLanguage): ResolvedActionDefinition {
    return deepFreeze({
      actionKind: entry.actionKind,
      actionKey: entry.actionKey,
      title: pick(entry.title, language),
      description: pick(entry.description, language),
      rulePackKey: entry.rulePackKey,
      consumable: entry.consumable,
      effectKind: entry.effectKind,
      metadata: deepFreeze(structuredClone(entry.metadata)),
    });
  }

  function toStory(entry: StoryEntry, language: ContentLanguage): ResolvedStoryContent {
    return deepFreeze({
      storyKey: entry.storyKey,
      title: pick(entry.title, language),
      premise: pick(entry.premise, language),
      recordTitle: pick(entry.recordTitle, language),
      opening: {
        speaker: pick(entry.opening.speaker, language),
        content: pick(entry.opening.content, language),
        segments: entry.opening.segments.map((segment) => ({
          id: segment.id,
          kind: segment.kind,
          content: pick(segment.content, language),
          speechMode: segment.speechMode,
        })),
      },
    });
  }

  function toScene(entry: SceneEntry, language: ContentLanguage): ResolvedSceneContent {
    return deepFreeze({
      sceneKey: entry.sceneKey,
      title: pick(entry.title, language),
      location: pick(entry.location, language),
      weather: pick(entry.weather, language),
      tension: pick(entry.tension, language),
      displayTime: pick(entry.displayTime, language),
      objective: pick(entry.objective, language),
    });
  }

  return {
    resolveWorld(request: WorldContentRequest) {
      const scope = worldScope(request);
      if (!contentKeyMatches(scope.contentKey)) return null;
      return toWorldContent(scope.language);
    },

    resolveCharacter(request: CharacterContentRequest) {
      const scope = worldScope(request, ["characterKey"]);
      if (!contentKeyMatches(scope.contentKey) || !content.characters) return null;
      const characterKey = safeRequestId(request.characterKey, "characterKey");
      const entry = content.characters.find((candidate) => candidate.characterKey === characterKey);
      return entry ? toCharacter(entry, scope.language) : null;
    },

    listCharacters(request: ContentRequestBase) {
      const scope = worldScope(request);
      if (!contentKeyMatches(scope.contentKey) || !content.characters) return Object.freeze([]);
      return deepFreeze(content.characters.map((entry) => toCharacter(entry, scope.language)));
    },

    resolveAction(request: ActionContentRequest) {
      const scope = worldScope(request, ["actionKind", "actionKey"]);
      if (!ACTION_KINDS.includes(request.actionKind)) {
        throw new ContentResolutionError(
          "CONTENT_REQUEST_INVALID",
          "action content request actionKind is invalid",
        );
      }
      if (!contentKeyMatches(scope.contentKey) || !content.actions) return null;
      const actionKey = safeRequestId(request.actionKey, "actionKey");
      const entry = content.actions.find((candidate) => candidate.actionKey === actionKey);
      // actionKind 不符视为 miss（绝不跨类返回同 key 内容）。
      return entry && entry.actionKind === request.actionKind
        ? toAction(entry, scope.language)
        : null;
    },

    listActions(request: ActionListRequest) {
      const scope = worldScope(request, ["actionKind"]);
      if (
        request.actionKind !== undefined
        && !ACTION_KINDS.includes(request.actionKind)
      ) {
        throw new ContentResolutionError(
          "CONTENT_REQUEST_INVALID",
          "action list request actionKind is invalid",
        );
      }
      if (!contentKeyMatches(scope.contentKey) || !content.actions) return Object.freeze([]);
      return deepFreeze(
        content.actions
          .filter((entry) => request.actionKind === undefined || entry.actionKind === request.actionKind)
          .map((entry) => toAction(entry, scope.language)),
      );
    },

    resolveStory(request: StoryContentRequest) {
      const scope = worldScope(request, ["storyKey"]);
      if (!contentKeyMatches(scope.contentKey) || !content.stories) return null;
      // storyKey 缺省 = 包主故事（首条）；显式不符 = miss。
      const entry = request.storyKey === undefined
        ? content.stories[0]!
        : content.stories.find((candidate) => candidate.storyKey === safeRequestId(request.storyKey, "storyKey"));
      return entry ? toStory(entry, scope.language) : null;
    },

    resolveScene(request: SceneContentRequest) {
      const scope = worldScope(request, ["sceneKey"]);
      if (!contentKeyMatches(scope.contentKey) || !content.scenes) return null;
      const entry = request.sceneKey === undefined
        ? content.scenes[0]!
        : content.scenes.find((candidate) => candidate.sceneKey === safeRequestId(request.sceneKey, "sceneKey"));
      return entry ? toScene(entry, scope.language) : null;
    },

    resolveGoal(request: GoalContentRequest) {
      const scope = worldScope(request, ["goalKey"]);
      if (!contentKeyMatches(scope.contentKey) || !content.goals) return null;
      const goalKey = safeRequestId(request.goalKey, "goalKey");
      const entry = content.goals.find((candidate) => candidate.goalKey === goalKey);
      return entry ? deepFreeze(structuredClone(entry)) : null;
    },

    resolveMessages(request: MessagesContentRequest) {
      const scope = worldScope(request);
      if (!contentKeyMatches(scope.contentKey) || !content.messages) return null;
      const candidates = [
        scope.language,
        scope.language.split("-", 1)[0]!,
        fallbackLocale,
        fallbackLocale.split("-", 1)[0]!,
        "en",
      ];
      for (const candidate of candidates) {
        const bundle = content.messages[candidate];
        if (bundle) return deepFreeze(structuredClone(bundle));
      }
      const first = Object.keys(content.messages).sort()[0]!;
      return deepFreeze(structuredClone(content.messages[first]!));
    },

    resolveGenesisContent(request: GenesisContentRequest) {
      const scope = normalizeGenesisContentRequest(request);
      if (
        scope.binding.kind !== "world"
        || scope.binding.worldId !== mountedWorldId
        || scope.binding.worldVersion !== mountedWorldVersion
      ) {
        throw new ContentResolutionError(
          "CONTENT_IDENTITY_REJECTED",
          "the RealmWorld content resolver only serves the mounted world identity",
        );
      }
      if (!contentKeyMatches(scope.contentKey)) return null;
      // 创世需要 world + 主 story + 主 scene；缺任一为显式 miss。
      if (!content.world || !content.stories || !content.scenes) return null;
      const story = content.stories[0]!;
      const scene = content.scenes[0]!;
      const characters = content.characters ?? [];
      const playerSeat = characters.find((entry) => entry.isPlayer);
      const language = scope.language;
      return deepFreeze({
        contentKey: content.contentKey,
        world: {
          name: pick(content.world.title, language),
          era: settingString(content.world.settings, "era"),
          summary: settingString(content.world.settings, "summary"),
          style: settingString(content.world.settings, "style"),
          settings: deepFreeze(structuredClone(content.world.settings)),
        },
        story: {
          title: pick(story.title, language),
          premise: pick(story.premise, language),
        },
        record: { title: pick(story.recordTitle, language) },
        scene: {
          title: pick(scene.title, language),
          location: pick(scene.location, language),
          weather: pick(scene.weather, language),
          tension: pick(scene.tension, language),
          displayTime: pick(scene.displayTime, language),
          objective: pick(scene.objective, language),
        },
        playerRole: playerSeat ? pick(playerSeat.role, language) : "",
        playerStance: playerSeat ? "player" : "observer",
        characters: characters
          .filter((entry) => !entry.isPlayer)
          .map((entry) => ({
            characterKey: entry.characterKey,
            displayName: pick(entry.displayName, language),
            role: pick(entry.role, language),
            summary: pick(entry.summary, language),
          })),
        goals: (content.goals ?? []).map((goal) => structuredClone(goal)),
        opening: pick(story.opening.content, language),
      });
    },
  };
}

/**
 * 创建 install-root -backed 的 RealmWorld ContentResolver 工厂：给定
 * WorldBinding 经 mountRealmWorld 挂载签名包后返回同步 resolver。base
 * binding 返回 null（base 内容是 BaseContentResolver 的职责，绝不代解）。
 */
export function createRealmWorldContentResolver(input: {
  installRoot: string;
  verifySignature: RealmWorldSignatureVerifier;
  locale: string;
  engineBaseVersion?: string;
}): (binding: WorldBinding) => Promise<ContentResolver | null> {
  const locale = assertLocale(input.locale);
  return async (binding) => {
    const exactBinding = assertExactBinding(binding, "binding");
    if (exactBinding.kind === "base") return null;
    const mounted = await mountRealmWorld({
      installRoot: input.installRoot,
      worldId: exactBinding.worldId,
      worldVersion: exactBinding.worldVersion,
      verifySignature: input.verifySignature,
      engineBaseVersion: input.engineBaseVersion,
    });
    return createRealmWorldContentResolverFromMount(mounted, exactBinding, locale);
  };
}
