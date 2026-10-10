import type { GoalDefinition } from "../goals/public.ts";
import type { JsonValue } from "../runtime/public.ts";
import type { RealmWorldManifestV1 } from "./realmworld-manifest.ts";
import { createRealmWorldContentStore } from "./realmworld-content.ts";
import { mountRealmWorld, type RealmWorldSignatureVerifier } from "./realmworld-loader.ts";
import type { WorldBinding } from "./realm-save.ts";

export type RealmWorldRuntimeContentErrorCode =
  | "RUNTIME_UNAVAILABLE"
  | "RUNTIME_INVALID"
  | "RUNTIME_IDENTITY_MISMATCH";

export class RealmWorldRuntimeContentError extends Error {
  readonly code: RealmWorldRuntimeContentErrorCode;

  constructor(code: RealmWorldRuntimeContentErrorCode, message: string) {
    super(message);
    this.name = "RealmWorldRuntimeContentError";
    this.code = code;
  }
}

export interface RealmWorldRuntimeTextMap {
  readonly [locale: string]: string;
}

export interface RealmWorldRuntimeCharacterPlan {
  characterKey: string;
  displayName: string;
  role: string;
  summary: string;
  profile: Readonly<Record<string, JsonValue>>;
}

export interface RealmWorldRuntimeInstantiationPlan {
  binding: { kind: "world"; worldId: string; worldVersion: string };
  world: {
    name: string;
    era: string;
    summary: string;
    settings: Readonly<Record<string, JsonValue>>;
  };
  story: { title: string; premise: string };
  record: { title: string };
  scene: {
    title: string;
    location: string;
    objective: string;
    tension: string;
    weather: string;
    displayTime: string;
  };
  playerRole: string;
  playerStance: "player" | "observer";
  characters: readonly RealmWorldRuntimeCharacterPlan[];
  goals: readonly GoalDefinition[];
}

export interface RealmWorldRuntimeMount {
  mount(input: {
    worldId: string;
    worldVersion: string;
  }): Promise<{
    manifest: RealmWorldManifestV1;
    files: ReadonlyMap<string, Uint8Array>;
  }>;
}

const WORLD_PATH = "content/world.json";
const RUNTIME_PATH = "content/runtime.json";
const SAFE_LOCALE = /^[A-Za-z0-9-]+$/;
const MAX_TEXT_LENGTH = 512;
const MAX_KEY_LENGTH = 256;
const MAX_CHARACTERS = 64;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isPlainObject(value) && Object.values(value).every(isJsonValue);
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new RealmWorldRuntimeContentError("RUNTIME_INVALID", `unknown runtime key ${where}.${key}`);
    }
  }
}

function required(value: Record<string, unknown>, key: string, where: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(value, key)) {
    throw new RealmWorldRuntimeContentError("RUNTIME_INVALID", `runtime key ${where}.${key} is required`);
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
    throw new RealmWorldRuntimeContentError("RUNTIME_INVALID", `runtime text ${where} is invalid`);
  }
  return value;
}

function identity(value: unknown, where: string): string {
  const result = text(value, where);
  if (result.length > MAX_KEY_LENGTH || !/^[A-Za-z0-9._:-]+$/.test(result)) {
    throw new RealmWorldRuntimeContentError("RUNTIME_INVALID", `runtime identity ${where} is invalid`);
  }
  return result;
}

function parseJson(bytes: Uint8Array, path: string): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new RealmWorldRuntimeContentError("RUNTIME_INVALID", `${path} is not valid JSON`);
  }
}

function parseTextMap(value: unknown, where: string): RealmWorldRuntimeTextMap {
  if (!isPlainObject(value)) {
    throw new RealmWorldRuntimeContentError("RUNTIME_INVALID", `runtime text map ${where} is invalid`);
  }
  const entries = Object.entries(value);
  if (entries.length === 0) {
    throw new RealmWorldRuntimeContentError("RUNTIME_INVALID", `runtime text map ${where} is empty`);
  }
  const result: Record<string, string> = {};
  for (const [locale, raw] of entries) {
    if (!SAFE_LOCALE.test(locale)) {
      throw new RealmWorldRuntimeContentError("RUNTIME_INVALID", `runtime locale ${where}.${locale} is invalid`);
    }
    result[locale] = text(raw, `${where}.${locale}`);
  }
  return result;
}

function selectText(value: RealmWorldRuntimeTextMap, locale: string): string {
  const language = locale.split("-", 1)[0]!;
  return value[locale] ?? value[language] ?? value.en ?? value[Object.keys(value).sort()[0]!]!;
}

function parseWorld(
  files: ReadonlyMap<string, Uint8Array>,
  manifest: RealmWorldManifestV1,
  locale: string,
): RealmWorldRuntimeInstantiationPlan["world"] {
  const bytes = files.get(WORLD_PATH);
  if (!bytes) {
    throw new RealmWorldRuntimeContentError("RUNTIME_UNAVAILABLE", "RealmWorld world document is not installed");
  }
  const value = parseJson(bytes, WORLD_PATH);
  if (!isPlainObject(value)) {
    throw new RealmWorldRuntimeContentError("RUNTIME_INVALID", "RealmWorld world document is invalid");
  }
  assertExactKeys(value, ["worldId", "title", "settings"], "world");
  if (value.worldId !== manifest.worldId) {
    throw new RealmWorldRuntimeContentError("RUNTIME_INVALID", "RealmWorld world identity does not match its manifest");
  }
  const title = parseTextMap(required(value, "title", "world"), "world.title");
  const settingsValue = required(value, "settings", "world");
  if (!isPlainObject(settingsValue) || !isJsonValue(settingsValue)) {
    throw new RealmWorldRuntimeContentError("RUNTIME_INVALID", "RealmWorld world settings are invalid");
  }
  const settings = settingsValue as Readonly<Record<string, JsonValue>>;
  return {
    name: selectText(title, locale),
    era: typeof settings.era === "string" ? settings.era : "",
    summary: typeof settings.summary === "string" ? settings.summary : "",
    settings,
  };
}

function parseRuntimeDocument(value: unknown, locale: string): Omit<RealmWorldRuntimeInstantiationPlan, "binding" | "world" | "goals"> {
  if (!isPlainObject(value)) {
    throw new RealmWorldRuntimeContentError("RUNTIME_INVALID", "RealmWorld runtime document is invalid");
  }
  assertExactKeys(
    value,
    ["format", "schemaVersion", "story", "record", "scene", "playerRole", "playerStance", "characters"],
    "runtime",
  );
  if (value.format !== "realmworld-runtime" || value.schemaVersion !== 1) {
    throw new RealmWorldRuntimeContentError("RUNTIME_INVALID", "RealmWorld runtime schema is unsupported");
  }
  const storyValue = required(value, "story", "runtime");
  const recordValue = required(value, "record", "runtime");
  const sceneValue = required(value, "scene", "runtime");
  if (!isPlainObject(storyValue) || !isPlainObject(recordValue) || !isPlainObject(sceneValue)) {
    throw new RealmWorldRuntimeContentError("RUNTIME_INVALID", "RealmWorld runtime story/record/scene is invalid");
  }
  assertExactKeys(storyValue, ["title", "premise"], "runtime.story");
  assertExactKeys(recordValue, ["title"], "runtime.record");
  assertExactKeys(sceneValue, ["title", "location", "objective", "tension", "weather", "displayTime"], "runtime.scene");
  const charactersValue = required(value, "characters", "runtime");
  if (!Array.isArray(charactersValue) || charactersValue.length > MAX_CHARACTERS) {
    throw new RealmWorldRuntimeContentError("RUNTIME_INVALID", "RealmWorld runtime characters are invalid");
  }
  const characterKeys = new Set<string>();
  const characters = charactersValue.map((raw, index) => {
    if (!isPlainObject(raw)) {
      throw new RealmWorldRuntimeContentError("RUNTIME_INVALID", `runtime.characters[${index}] is invalid`);
    }
    assertExactKeys(raw, ["characterKey", "displayName", "role", "summary", "profile"], `runtime.characters[${index}]`);
    const characterKey = identity(required(raw, "characterKey", `runtime.characters[${index}]`), `runtime.characters[${index}].characterKey`);
    if (characterKeys.has(characterKey)) {
      throw new RealmWorldRuntimeContentError("RUNTIME_INVALID", "RealmWorld runtime character keys must be unique");
    }
    characterKeys.add(characterKey);
    const profile = required(raw, "profile", `runtime.characters[${index}]`);
    if (!isPlainObject(profile) || !isJsonValue(profile)) {
      throw new RealmWorldRuntimeContentError("RUNTIME_INVALID", `runtime.characters[${index}].profile is invalid`);
    }
    return {
      characterKey,
      displayName: selectText(parseTextMap(required(raw, "displayName", `runtime.characters[${index}]`), `runtime.characters[${index}].displayName`), locale),
      role: selectText(parseTextMap(required(raw, "role", `runtime.characters[${index}]`), `runtime.characters[${index}].role`), locale),
      summary: selectText(parseTextMap(required(raw, "summary", `runtime.characters[${index}]`), `runtime.characters[${index}].summary`), locale),
      profile: profile as Readonly<Record<string, JsonValue>>,
    };
  });
  const playerStance = required(value, "playerStance", "runtime");
  if (playerStance !== "player" && playerStance !== "observer") {
    throw new RealmWorldRuntimeContentError("RUNTIME_INVALID", "RealmWorld runtime playerStance is invalid");
  }
  return {
    story: {
      title: selectText(parseTextMap(required(storyValue, "title", "runtime.story"), "runtime.story.title"), locale),
      premise: selectText(parseTextMap(required(storyValue, "premise", "runtime.story"), "runtime.story.premise"), locale),
    },
    record: {
      title: selectText(parseTextMap(required(recordValue, "title", "runtime.record"), "runtime.record.title"), locale),
    },
    scene: {
      title: selectText(parseTextMap(required(sceneValue, "title", "runtime.scene"), "runtime.scene.title"), locale),
      location: selectText(parseTextMap(required(sceneValue, "location", "runtime.scene"), "runtime.scene.location"), locale),
      objective: selectText(parseTextMap(required(sceneValue, "objective", "runtime.scene"), "runtime.scene.objective"), locale),
      tension: selectText(parseTextMap(required(sceneValue, "tension", "runtime.scene"), "runtime.scene.tension"), locale),
      weather: selectText(parseTextMap(required(sceneValue, "weather", "runtime.scene"), "runtime.scene.weather"), locale),
      displayTime: selectText(parseTextMap(required(sceneValue, "displayTime", "runtime.scene"), "runtime.scene.displayTime"), locale),
    },
    playerRole: selectText(parseTextMap(required(value, "playerRole", "runtime"), "runtime.playerRole"), locale),
    playerStance,
    characters,
  };
}

export function createRealmWorldInstantiationPlan(input: {
  manifest: RealmWorldManifestV1;
  files: ReadonlyMap<string, Uint8Array>;
  locale: string;
}): RealmWorldRuntimeInstantiationPlan {
  if (!input.locale || input.locale.trim() !== input.locale || !SAFE_LOCALE.test(input.locale)) {
    throw new RealmWorldRuntimeContentError("RUNTIME_INVALID", "RealmWorld runtime locale is invalid");
  }
  const runtimeBytes = input.files.get(RUNTIME_PATH);
  if (!runtimeBytes) {
    throw new RealmWorldRuntimeContentError("RUNTIME_UNAVAILABLE", "RealmWorld runtime document is not installed");
  }
  const world = parseWorld(input.files, input.manifest, input.locale);
  const runtime = parseRuntimeDocument(parseJson(runtimeBytes, RUNTIME_PATH), input.locale);
  const goals = createRealmWorldContentStore(input).listGoalDefinitions();
  return {
    binding: {
      kind: "world",
      worldId: input.manifest.worldId,
      worldVersion: input.manifest.worldVersion,
    },
    world,
    ...runtime,
    goals,
  };
}

export function createRealmWorldInstantiationResolver(input: {
  mount: RealmWorldRuntimeMount;
  locale: string;
}): (binding: WorldBinding) => Promise<RealmWorldRuntimeInstantiationPlan | null> {
  return async (binding) => {
    if (binding.kind === "base") return null;
    const mounted = await input.mount.mount({
      worldId: binding.worldId,
      worldVersion: binding.worldVersion,
    });
    if (
      mounted.manifest.worldId !== binding.worldId
      || mounted.manifest.worldVersion !== binding.worldVersion
    ) {
      throw new RealmWorldRuntimeContentError(
        "RUNTIME_IDENTITY_MISMATCH",
        "Mounted RealmWorld identity does not match the requested WorldBinding.",
      );
    }
    return createRealmWorldInstantiationPlan({
      manifest: mounted.manifest,
      files: mounted.files,
      locale: input.locale,
    });
  };
}

export function createInstalledRealmWorldInstantiationResolver(input: {
  installRoot: string;
  verifySignature: RealmWorldSignatureVerifier;
  locale: string;
}): (binding: WorldBinding) => Promise<RealmWorldRuntimeInstantiationPlan | null> {
  return createRealmWorldInstantiationResolver({
    locale: input.locale,
    mount: {
      mount: (binding) => mountRealmWorld({
        installRoot: input.installRoot,
        worldId: binding.worldId,
        worldVersion: binding.worldVersion,
        verifySignature: input.verifySignature,
      }),
    },
  });
}
