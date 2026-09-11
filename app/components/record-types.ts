import { uiText, type UiLanguage } from "../../modules/i18n/public.ts";
import type { MechanicDetail } from "../../modules/actions/public.ts";
import {
  fallbackCompositeSemanticSegments,
  fallbackSemanticSegments,
  isInternalInstructionText,
  parseSemanticPresentation,
  type SemanticSegment,
  type SemanticSegmentKind,
} from "../../modules/presentation/semantic-segments.ts";

export type EventRole = "narrator" | "character" | "player" | "system";
export type EventStatus = "pending" | "committed" | "failed";

export interface TimelineEvent {
  id: string;
  /** Dense viewer-local cursor. It is never a write-side Record version. */
  ordinal: number;
  type: string;
  speaker: string;
  role: EventRole;
  content: string;
  segments: readonly SemanticSegment[];
  worldTime: string;
  visibility: string;
  status: EventStatus;
  /** 批次 T3：在场发声标记（回合外角色自主发声；非在场事件缺省）。 */
  presence?: {
    characterInstanceId: string;
    triggerKind: "environment" | "peer" | "hook";
  };
  /** 批次 T5：判定骰点物化结果（仅带 check 的规则事件；前端不自行模拟骰点）。 */
  dice?: MechanicDetail;
  /** 批次 T7：世界自演拍标记（自治回合产出；非自演事件缺省）。 */
  selfPlay?: {
    beat: number;
  };
}

export interface ViewerContext {
  cursor: "viewer-local";
  perspective: "omniscient" | "character";
  characterInstanceId: string | null;
  dynamicKnowledgeVisible: boolean;
  /** 批次 S：本人 membership.role；observer → 记录页显示执笔者徽标。 */
  membershipRole: "owner" | "player" | "observer";
}

export interface RecordEnvelope {
  record: RecordProjection;
  writeToken: string;
  viewer: ViewerContext;
  affordances: ActionAffordance[];
  /** 回合后的下一步对话提案；从最新可见 Narration 事件恢复，缺失时为空。 */
  suggestions: string[];
  /**
   * 批次 T1：世界初夜状态。旧世界无状态行 → null；pending 期间前端
   * 轻量轮询等待初夜事件渐显。openingSuggestions 为开场提案，
   * composer 在回合提案为空时补位。
   */
  firstNight: {
    state: "pending" | "ready" | "degraded";
    hookContent: string;
    openingSuggestions: string[];
  } | null;
  /**
   * 批次 T7：世界自演会话状态。无会话行 → null；running/stopping 期间
   * 前端轻量轮询信封刷新状态。
   */
  selfPlay: {
    state: "running" | "stopping" | "completed" | "failed" | "cancelled";
    beatBudget: number;
    beatsCompleted: number;
    lastError: string | null;
  } | null;
}

export interface VisibilityProposal {
  proposalId: string;
  kind: "restricted";
  audienceCharacterInstanceIds: string[];
  audienceNames: string[];
  reason: string;
}

export interface ActionAffordance {
  id: string;
  kind: "skill" | "asset" | "stance" | "scene";
  actorCharacterInstanceId: string;
  actorName: string;
  title: string;
  description: string;
  suggestedText: string;
}

export interface CastMember {
  id: string;
  name: string;
  role: string;
  summary: string;
  status: string;
  controlledBy: string;
  isActive: boolean;
}

export interface NavigationItem {
  id: string;
  title: string;
  status: string;
  worldTime?: string;
}

export interface RecordProjection {
  id: string;
  version: number;
  world: {
    id: string;
    name: string;
    era: string;
    /** 世界摘要（T12 世界视图；缺失时空串）。 */
    summary?: string;
    /** 世界文风 key（缺失/未知时 normalize 到 modern）。 */
    style?: string;
    /** 世界内系统文本语言（缺失时 zh-CN）。 */
    language?: string;
  };
  story: {
    id: string;
    title: string;
    status: string;
    /** 故事前提（T12 故事视图；缺失时空串）。 */
    premise?: string;
  };
  record: {
    id: string;
    title: string;
    location: string;
    worldTime: string;
    version: number;
  };
  events: TimelineEvent[];
  cast: CastMember[];
  scene: {
    location: string;
    worldTime: string;
    weather: string;
    tension: string;
    objective: string;
  };
  stories: NavigationItem[];
  records: NavigationItem[];
}

type UnknownRecord = Record<string, unknown>;

function isObject(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number") return String(value);
  return fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function asViewerOrdinal(value: unknown, fallback: number): number {
  const ordinal = asNumber(value, fallback);
  return Number.isSafeInteger(ordinal) && ordinal >= 0 ? ordinal : fallback;
}

function pickString(
  source: UnknownRecord,
  keys: string[],
  fallback = "",
): string {
  for (const key of keys) {
    const value = asString(source[key]);
    if (value) return value;
  }
  return fallback;
}

function pickObject(source: UnknownRecord, key: string): UnknownRecord {
  return isObject(source[key]) ? source[key] : {};
}

function pickArray(source: UnknownRecord, keys: string[]): unknown[] | null {
  for (const key of keys) {
    if (Array.isArray(source[key])) return source[key];
  }
  return null;
}

function entityName(value: unknown, keys: string[], fallback: string): string {
  if (typeof value === "string") return value;
  if (!isObject(value)) return fallback;
  return pickString(value, keys, fallback);
}

function normalizeRole(value: unknown, speaker: string): EventRole {
  const role = asString(value).toLowerCase();
  const identity = `${role} ${speaker}`.toLowerCase();

  if (identity.includes("narrator") || identity.includes("旁白")) {
    return "narrator";
  }
  if (
    identity.includes("system") ||
    identity.includes("controller") ||
    identity.includes("规则")
  ) {
    return "system";
  }
  if (
    identity.includes("player") ||
    identity.includes("human") ||
    identity.includes("user") ||
    identity.includes("玩家")
  ) {
    return "player";
  }
  return "character";
}

function normalizeStatus(value: unknown): EventStatus {
  const status = asString(value).toLowerCase();
  if (status === "pending" || status === "sending") return "pending";
  if (status === "failed" || status === "error") return "failed";
  return "committed";
}

export function normalizeVisibilityProposal(value: unknown): VisibilityProposal | null {
  if (!isObject(value) || value.kind !== "restricted") return null;
  const proposalId = asString(value.proposalId);
  const audienceIds = Array.isArray(value.audienceCharacterInstanceIds)
    ? value.audienceCharacterInstanceIds.map((item) => asString(item)).filter(Boolean)
    : [];
  const audienceNames = Array.isArray(value.audienceNames)
    ? value.audienceNames.map((item) => asString(item)).filter(Boolean)
    : [];
  const reason = asString(value.reason);
  if (
    !proposalId
    || audienceIds.length === 0
    || audienceIds.length !== audienceNames.length
    || !reason
  ) return null;
  return {
    proposalId,
    kind: "restricted",
    audienceCharacterInstanceIds: audienceIds,
    audienceNames,
    reason,
  };
}

function normalizeEvent(value: unknown, index: number): TimelineEvent | null {
  if (typeof value === "string") {
    return {
      id: `event-${index}`,
      ordinal: index + 1,
      type: "叙事",
      speaker: "旁白",
      role: "narrator",
      content: value,
      segments: fallbackSemanticSegments(value, "story"),
      worldTime: "",
      visibility: "公开",
      status: "committed",
    };
  }
  if (!isObject(value)) return null;

  const speakerValue = value.speaker;
  const speaker = entityName(
    speakerValue,
    ["name", "displayName", "title"],
    pickString(value, ["author", "characterName", "actor"], "旁白"),
  );
  const content = pickString(value, ["content", "text", "message", "body"]);
  if (!content) return null;

  const type = pickString(value, ["type", "kind", "eventType"], "叙事");
  const role = normalizeRole(value.role ?? value.actorType ?? value.type, speaker);
  // 批次 T3：在场标记随投影/SSE 同一 normalize 路径透出（形状非法 → 缺省）。
  const presence = parsePresenceMarker(value.presence);
  // 批次 T5：骰点物化结果同路透出（只读投影值，前端不模拟骰点）。
  const dice = parseDiceMechanic(value.dice);
  // 批次 T7：自演拍标记同路透出（形状非法 → 缺省）。
  const selfPlay = parseSelfPlayMarker(value.selfPlay);
  const parsedSegments = parseSemanticPresentation({ schemaVersion: 1, segments: value.segments })
    ?? fallbackCompositeSemanticSegments(content, fallbackSegmentKind(type, role));
  const segments = parsedSegments.filter(
    (segment) => segment.kind !== "dialogue" || !isInternalInstructionText(segment.content),
  );
  const normalizedContent = segments.map((segment) => segment.content.trim()).join("\n");
  return {
    id: pickString(value, ["id", "eventId", "clientMessageId"], `event-${index}`),
    ordinal: asViewerOrdinal(value.ordinal, index + 1),
    type,
    speaker,
    role,
    content: normalizedContent,
    segments,
    worldTime: pickString(value, ["worldTime", "time", "occurredAt", "timestamp"]),
    visibility: pickString(value, ["visibility", "audience", "scope"], "公开"),
    status: normalizeStatus(value.status),
    ...(presence ? { presence } : {}),
    ...(dice ? { dice } : {}),
    ...(selfPlay ? { selfPlay } : {}),
  };
}

const NORMALIZE_DICE_SYSTEMS = ["d20", "2d6", "percentile", "pool", "draw"] as const;

/** 批次 T5：骰点规整——系统五值之一、rolls 全数字、modifier/target/total/success 齐。 */
function parseDiceMechanic(value: unknown): TimelineEvent["dice"] {
  if (!isObject(value)) return undefined;
  if (
    typeof value.system !== "string"
    || !(NORMALIZE_DICE_SYSTEMS as readonly string[]).includes(value.system)
    || !Array.isArray(value.rolls)
    || !value.rolls.every((roll) => typeof roll === "number")
    || typeof value.modifier !== "number"
    || typeof value.target !== "number"
    || typeof value.total !== "number"
    || typeof value.success !== "boolean"
  ) {
    return undefined;
  }
  return {
    system: value.system as MechanicDetail["system"],
    rolls: value.rolls as readonly number[],
    modifier: value.modifier,
    target: value.target,
    total: value.total,
    success: value.success,
    ...(value.critical === true ? { critical: true as const } : {}),
    ...(value.fumble === true ? { fumble: true as const } : {}),
    ...(typeof value.skillKey === "string" ? { skillKey: value.skillKey } : {}),
    ...(typeof value.drawnCard === "string" ? { drawnCard: value.drawnCard } : {}),
    ...(typeof value.deckRemaining === "number"
      ? { deckRemaining: value.deckRemaining }
      : {}),
  };
}

/** 批次 T7：自演拍标记规整——beat 为正整数才透出。 */
function parseSelfPlayMarker(value: unknown): TimelineEvent["selfPlay"] {
  if (!isObject(value)) return undefined;
  const beat = value.beat;
  if (typeof beat !== "number" || !Number.isSafeInteger(beat) || beat < 1) {
    return undefined;
  }
  return { beat };
}

/** 批次 T3：在场标记规整——characterInstanceId 为字符串且 triggerKind 三值之一。 */
function parsePresenceMarker(value: unknown): TimelineEvent["presence"] {
  if (!isObject(value)) return undefined;
  const characterInstanceId = value.characterInstanceId;
  const triggerKind = value.triggerKind;
  if (typeof characterInstanceId !== "string" || !characterInstanceId.trim()) {
    return undefined;
  }
  if (triggerKind !== "environment" && triggerKind !== "peer" && triggerKind !== "hook") {
    return undefined;
  }
  return { characterInstanceId, triggerKind };
}

function fallbackSegmentKind(type: string, role: EventRole): SemanticSegmentKind {
  const normalized = type.toLowerCase();
  if (normalized.includes("action") || normalized.includes("行动")) return "action";
  if (normalized.includes("system") || normalized.includes("规则")) return "fact";
  if (normalized.includes("narration") || normalized.includes("叙事")) return "story";
  return role === "narrator" ? "story" : "dialogue";
}

function removePublicFactDialogues(events: TimelineEvent[]): TimelineEvent[] {
  const publicFacts = new Set(
    events
      .filter((event) => event.role === "narrator")
      .flatMap((event) => event.segments)
      .filter((segment) => segment.kind === "fact")
      .map((segment) => segment.content.trim())
      .filter(Boolean),
  );
  if (publicFacts.size === 0) return events;
  return events.map((event) => {
    if (event.role !== "character") return event;
    const segments = event.segments.filter((segment) =>
      segment.kind !== "dialogue" || !publicFacts.has(stripDialogueQuotes(segment.content)),
    );
    if (segments.length === event.segments.length) return event;
    return {
      ...event,
      content: segments.map((segment) => segment.content.trim()).join("\n"),
      segments,
    };
  });
}

function stripDialogueQuotes(content: string): string {
  return content.trim().replace(/^[“「『"']|[”」』"']$/g, "").trim();
}

function envelopeSource(payload: unknown): UnknownRecord {
  if (!isObject(payload)) return {};
  return isObject(payload.data) ? envelopeSource(payload.data) : payload;
}

function normalizeViewer(value: unknown): ViewerContext {
  const source = isObject(value) ? value : {};
  const perspective = source.perspective === "omniscient"
    ? "omniscient"
    : "character";
  const membershipRole = source.membershipRole === "observer"
    || source.membershipRole === "player"
    || source.membershipRole === "owner"
    ? source.membershipRole
    : "player";
  return {
    cursor: "viewer-local",
    perspective,
    characterInstanceId:
      typeof source.characterInstanceId === "string" && source.characterInstanceId.trim()
        ? source.characterInstanceId.trim()
        : null,
    // Missing or malformed metadata fails closed. The UI must never infer
    // access to dynamic knowledge from populated projection fields.
    dynamicKnowledgeVisible: source.dynamicKnowledgeVisible === true,
    membershipRole,
  };
}

function normalizeAffordance(value: unknown): ActionAffordance | null {
  if (!isObject(value)) return null;
  const kind = value.kind;
  if (kind !== "skill" && kind !== "asset" && kind !== "stance" && kind !== "scene") {
    return null;
  }
  const id = asString(value.id);
  const actorCharacterInstanceId = asString(value.actorCharacterInstanceId);
  const actorName = asString(value.actorName);
  const title = asString(value.title);
  const description = asString(value.description);
  const suggestedText = asString(value.suggestedText);
  if (
    !id
    || !actorCharacterInstanceId
    || !actorName
    || !title
    || !description
    || !suggestedText
  ) return null;
  return {
    id,
    kind,
    actorCharacterInstanceId,
    actorName,
    title,
    description,
    suggestedText,
  };
}

function normalizeCast(value: unknown, index: number): CastMember | null {
  if (typeof value === "string") {
    return {
      id: `cast-${index}`,
      name: value,
      role: "角色",
      summary: "",
      status: "在场",
      controlledBy: "AI",
      isActive: true,
    };
  }
  if (!isObject(value)) return null;

  const name = pickString(value, ["name", "displayName", "title"]);
  if (!name) return null;
  const status = pickString(value, ["status", "presence"], "在场");

  return {
    id: pickString(value, ["id", "characterId", "instanceId"], `cast-${index}`),
    name,
    role: pickString(value, ["role", "title", "archetype"], "角色"),
    summary: pickString(value, ["summary", "profileSummary", "profile"], ""),
    status,
    controlledBy: pickString(value, ["controlledBy", "controller", "control"], "AI"),
    isActive:
      typeof value.isActive === "boolean"
        ? value.isActive
        : !["离场", "失联", "inactive", "absent"].includes(status.toLowerCase()),
  };
}

function normalizeNavigation(
  value: unknown,
  index: number,
  prefix: string,
): NavigationItem | null {
  if (typeof value === "string") {
    return { id: `${prefix}-${index}`, title: value, status: "" };
  }
  if (!isObject(value)) return null;

  const title = pickString(value, ["title", "name", "label"]);
  if (!title) return null;
  return {
    id: pickString(value, ["id"], `${prefix}-${index}`),
    title,
    status: pickString(value, ["status", "state"]),
    worldTime: pickString(value, ["worldTime", "time"]),
  };
}

function unwrapProjection(payload: unknown): UnknownRecord {
  if (!isObject(payload)) return {};

  if (isObject(payload.data)) return unwrapProjection(payload.data);

  const wrapped = payload.record;
  const rootLooksLikeProjection =
    "events" in payload ||
    "messages" in payload ||
    "timeline" in payload ||
    "world" in payload ||
    "story" in payload ||
    "cast" in payload ||
    "scene" in payload;
  const wrappedLooksLikeProjection =
    isObject(wrapped) &&
    ("events" in wrapped ||
      "messages" in wrapped ||
      "timeline" in wrapped ||
      "world" in wrapped ||
      "story" in wrapped ||
      "cast" in wrapped ||
      "scene" in wrapped);

  return !rootLooksLikeProjection && wrappedLooksLikeProjection ? wrapped : payload;
}

export function normalizeRecordProjection(
  payload: unknown,
  fallback?: RecordProjection,
): RecordProjection {
  const source = unwrapProjection(payload);
  const worldObject = pickObject(source, "world");
  const storyObject = pickObject(source, "story");
  const recordObject = pickObject(source, "record");
  const sceneObject = pickObject(source, "scene");

  // 跨记录隔离：只有载荷与 fallback 属于同一条记录时才允许继承，
  // 否则旧记录的任何字符串或列表都不得渗入新记录。
  const payloadRecordId = pickString(
    recordObject,
    ["id"],
    pickString(source, ["recordId", "id"]),
  );
  const inherited = payloadRecordId && fallback?.id === payloadRecordId
    ? fallback
    : undefined;

  const worldName = entityName(
    source.world,
    ["name", "title"],
    pickString(source, ["worldName"], inherited?.world.name ?? ""),
  );
  const storyTitle = entityName(
    source.story,
    ["title", "name"],
    pickString(source, ["storyTitle"], inherited?.story.title ?? ""),
  );
  const recordTitle = entityName(
    source.record,
    ["title", "name"],
    pickString(source, ["recordTitle"], inherited?.record.title ?? ""),
  );

  const rawEvents = pickArray(source, ["events", "messages", "timeline"]);
  const normalizedEvents = rawEvents
    ? rawEvents
        .map(normalizeEvent)
        .filter((event): event is TimelineEvent => event !== null)
    : inherited?.events ?? [];
  const events = removePublicFactDialogues(normalizedEvents);

  const rawCast = pickArray(source, ["cast", "characters", "participants"]);
  const cast = rawCast
    ? rawCast
        .map(normalizeCast)
        .filter((member): member is CastMember => member !== null)
    : inherited?.cast ?? [];

  const rawStories = pickArray(source, ["stories"]);
  const stories = rawStories
    ? rawStories
        .map((item, index) => normalizeNavigation(item, index, "story"))
        .filter((item): item is NavigationItem => item !== null)
    : inherited?.stories ?? [];

  const rawRecords = pickArray(source, ["records"]);
  const records = rawRecords
    ? rawRecords
        .map((item, index) => normalizeNavigation(item, index, "record"))
        .filter((item): item is NavigationItem => item !== null)
    : inherited?.records ?? [];

  const recordId = payloadRecordId || inherited?.record.id || "";
  const location = pickString(
    sceneObject,
    ["location"],
    pickString(recordObject, ["location"], inherited?.scene.location ?? ""),
  );
  const worldTime = pickString(
    sceneObject,
    ["worldTime", "time"],
    pickString(
      recordObject,
      ["worldTime", "time"],
      inherited?.scene.worldTime ?? "",
    ),
  );

  return {
    id: recordId,
    version: asNumber(source.version, asNumber(recordObject.version, inherited?.version ?? 0)),
    world: {
      id: pickString(worldObject, ["id"], inherited?.world.id ?? ""),
      name: worldName,
      summary: pickString(worldObject, ["summary"], inherited?.world.summary ?? ""),
      style: pickString(worldObject, ["style"], inherited?.world.style ?? ""),
      language: pickString(worldObject, ["language"], inherited?.world.language ?? ""),
      era: pickString(
        worldObject,
        ["era", "period"],
        pickString(source, ["era"], inherited?.world.era ?? ""),
      ),
    },
    story: {
      id: pickString(storyObject, ["id"], inherited?.story.id ?? ""),
      title: storyTitle,
      status: pickString(storyObject, ["status", "state"], inherited?.story.status ?? ""),
      premise: pickString(storyObject, ["premise"], inherited?.story.premise ?? ""),
    },
    record: {
      id: recordId,
      title: recordTitle,
      location,
      worldTime,
      version: asNumber(recordObject.version, asNumber(source.version, inherited?.record.version ?? 0)),
    },
    events,
    cast,
    scene: {
      location,
      worldTime,
      weather: pickString(sceneObject, ["weather"], inherited?.scene.weather ?? ""),
      tension: pickString(sceneObject, ["tension", "mood"], inherited?.scene.tension ?? ""),
      objective: pickString(
        sceneObject,
        ["objective", "goal"],
        inherited?.scene.objective ?? "",
      ),
    },
    stories,
    records,
  };
}

export function normalizeRecordEnvelope(
  payload: unknown,
  fallback?: RecordProjection,
): RecordEnvelope {
  const source = envelopeSource(payload);
  const viewer = normalizeViewer(source.viewer);
  let record = normalizeRecordProjection(source, fallback);

  if (!viewer.dynamicKnowledgeVisible) {
    record = {
      ...record,
      world: { ...record.world, era: "" },
      story: { ...record.story, status: "" },
      record: {
        ...record.record,
        location: "",
        worldTime: "",
      },
      cast: [],
      scene: {
        location: "",
        worldTime: "",
        weather: "",
        tension: "",
        objective: "",
      },
      stories: record.stories.map((item) => ({ ...item, status: "" })),
      records: record.records.map((item) => ({ ...item, status: "", worldTime: "" })),
    };
  }

  return {
    record,
    writeToken: asString(source.writeToken),
    viewer,
    affordances: Array.isArray(source.affordances)
      ? source.affordances
          .map(normalizeAffordance)
          .filter((item): item is ActionAffordance => item !== null)
      : [],
    suggestions: Array.isArray(source.suggestions)
      ? source.suggestions
          .map((item) => asString(item))
          .filter((item) => item.length > 0)
          .slice(0, 3)
      : [],
    firstNight: normalizeFirstNight(source.firstNight),
    selfPlay: normalizeSelfPlay(source.selfPlay),
  };
}

function normalizeSelfPlay(value: unknown): RecordEnvelope["selfPlay"] {
  if (!isObject(value)) return null;
  const state = value.state;
  if (
    state !== "running" && state !== "stopping" && state !== "completed"
    && state !== "failed" && state !== "cancelled"
  ) return null;
  return {
    state,
    beatBudget: asNumber(value.beatBudget, 0),
    beatsCompleted: asNumber(value.beatsCompleted, 0),
    lastError: typeof value.lastError === "string" && value.lastError
      ? value.lastError
      : null,
  };
}

function normalizeFirstNight(
  value: unknown,
): {
  state: "pending" | "ready" | "degraded";
  hookContent: string;
  openingSuggestions: string[];
} | null {
  if (!isObject(value)) return null;
  const state = value.state;
  if (state !== "pending" && state !== "ready" && state !== "degraded") return null;
  return {
    state,
    hookContent: asString(value.hookContent),
    openingSuggestions: Array.isArray(value.openingSuggestions)
      ? value.openingSuggestions
          .map((item) => asString(item))
          .filter((item) => item.length > 0)
          .slice(0, 3)
      : [],
  };
}

/** Accepts only the exact committed SSE envelope; unknown states fail closed. */
export function normalizeCommittedEventPayload(payload: unknown): TimelineEvent | null {
  if (!isObject(payload) || !isObject(payload.event)) return null;
  if (payload.event.status !== "committed") return null;
  if (!asString(payload.event.id)) return null;
  // index -1 makes the normalizer's ordinal fallback zero so a missing cursor
  // cannot be mistaken for the first visible Event.
  const event = normalizeEvent(payload.event, -1);
  if (!event || event.status !== "committed" || event.ordinal < 1) return null;
  return event;
}

export function lastCommittedOrdinal(events: readonly TimelineEvent[]): number {
  return events.reduce(
    (latest, event) =>
      event.status === "committed" && event.ordinal > latest
        ? event.ordinal
        : latest,
    0,
  );
}

/**
 * Upserts one projection-safe SSE Event without allowing it to replace a local
 * optimistic Event that is still awaiting its POST response.
 */
export function upsertCommittedEvent(
  projection: RecordProjection,
  event: TimelineEvent,
): RecordProjection {
  if (event.status !== "committed") return projection;
  const existing = projection.events.find((candidate) => candidate.id === event.id);
  if (existing?.status === "pending") return projection;

  const withoutExisting = projection.events.filter(
    (candidate) => candidate.id !== event.id,
  );
  const committed = withoutExisting
    .filter((candidate) => candidate.status === "committed")
    .concat(event)
    .sort((left, right) => left.ordinal - right.ordinal);
  const transient = withoutExisting.filter(
    (candidate) => candidate.status !== "committed",
  );
  const events = [...committed, ...transient];
  const version = lastCommittedOrdinal(events);
  return {
    ...projection,
    version,
    record: { ...projection.record, version },
    events,
  };
}

export interface VisibilityPresentation {
  label: string | null;
  isOutOfCharacter: boolean;
}

export function describeVisibility(
  value: string,
  uiLanguage: UiLanguage = "zh-CN",
): VisibilityPresentation {
  const text = (key: string) => uiText(key, uiLanguage);
  const visibility = value.trim().toLowerCase();
  if (visibility.startsWith("ooc:")) {
    return {
      label: text("ui.visibility.ooc"),
      isOutOfCharacter: true,
    };
  }
  switch (visibility) {
    case "":
    case "public":
    case "公开":
      return { label: null, isOutOfCharacter: false };
    case "scene":
      return { label: text("ui.visibility.scene"), isOutOfCharacter: false };
    case "restricted":
      return { label: text("ui.visibility.restricted"), isOutOfCharacter: false };
    case "private":
      return { label: text("ui.visibility.private"), isOutOfCharacter: false };
    case "local-draft":
      return { label: text("ui.visibility.localDraft"), isOutOfCharacter: false };
    default:
      return { label: text("ui.visibility.limited"), isOutOfCharacter: false };
  }
}

export function createOptimisticEvent(
  content: string,
  clientMessageId: string,
  worldTime: string,
): TimelineEvent {
  return {
    id: clientMessageId,
    ordinal: 0,
    type: "玩家行动",
    speaker: "你",
    role: "player",
    content,
    segments: fallbackCompositeSemanticSegments(content, "action"),
    worldTime,
    visibility: "local-draft",
    status: "pending",
  };
}
