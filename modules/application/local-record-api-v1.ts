/**
 * Local Record API — Bridge v1 public contract.
 *
 * This module is the versioned production boundary consumed by mounted
 * RealmWorld WebUI static bundles (and other trusted local clients). It is
 * pure: no Node built-ins, no database, no provider/settings access, no
 * imports from repositories or services. Everything crossing this boundary
 * is player-safe data only:
 *
 * - the player-safe Record envelope (projection + opaque writeToken +
 *   viewer context), never workspace/principal internals or SQL rows;
 * - the committed-event SSE stream (viewer-local ordinals, `event: committed`);
 * - the player-safe Goal projection (content-owned visibility), never runtime
 *   evidence, assessment jobs, or Judge output.
 *
 * Fail-closed rules:
 * - only the five fixed v1 routes below exist; builders reject invalid
 *   recordId/cursor input instead of producing a malformed path;
 * - the typed client validates its inputs before any fetch/EventSource call,
 *   rejects client-supplied base URLs carrying credentials, and maps any
 *   `ok:false` or malformed response to a typed error with a stable code —
 *   raw provider/SQL/internal details never enter this module.
 */

/** The single Bridge major version this contract implements. */
export const LOCAL_RECORD_API_V1_MAJOR = 1 as const;

/** Versioned base path of the Local Record Bridge v1 production alias. */
export const LOCAL_RECORD_API_V1_BASE = "/api/bridge/v1/record" as const;

/** SSE event names committed by the v1 contract. */
export const RECORD_COMMITTED_SSE_EVENT_V1 = "committed" as const;
export const GOAL_PROJECTION_SSE_EVENT_V1 = "goal.projection" as const;

export class LocalRecordApiV1Error extends Error {
  readonly code: string;
  /** HTTP status when the error originates from a server response. */
  readonly status?: number;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = "LocalRecordApiV1Error";
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Public data types (player-safe only).
// ---------------------------------------------------------------------------

/** Self-contained JSON value type; the contract never imports runtime types. */
export type JsonValueV1 =
  | string
  | number
  | boolean
  | null
  | JsonValueV1[]
  | { [key: string]: JsonValueV1 };

/** Structured semantic segment carried by every visible Event (contract §2). */
export interface SemanticSegmentV1 {
  id: string;
  kind: "environment" | "story" | "fact" | "action" | "dialogue";
  content: string;
  speechMode: "narrator" | "speaker" | "none";
}

/** Materialized dice result on rule events (read-only projection value). */
export interface DiceMechanicV1 {
  system: "d20" | "2d6" | "percentile" | "pool" | "draw";
  rolls: readonly number[];
  modifier: number;
  target: number;
  total: number;
  success: boolean;
  critical?: true;
  fumble?: true;
  skillKey?: string;
  drawnCard?: string;
  deckRemaining?: number;
}

/**
 * One player-visible Event. `ordinal` is a dense viewer-local cursor — never
 * a canonical Record version and never a database id.
 */
export interface ProjectionEventV1 {
  id: string;
  ordinal: number;
  type: string;
  speaker: string;
  role: "narrator" | "character" | "player" | "system";
  content: string;
  segments: readonly SemanticSegmentV1[];
  worldTime: string;
  visibility: string;
  status: "pending" | "committed" | "failed";
  presence?: {
    characterInstanceId: string;
    triggerKind: "environment" | "peer" | "hook";
  };
  dice?: DiceMechanicV1;
  selfPlay?: { beat: number };
}

export interface LocalRecordViewerV1 {
  cursor: "viewer-local";
  perspective: "omniscient" | "character";
  dynamicKnowledgeVisible: boolean;
  characterInstanceId: string | null;
  membershipRole: "owner" | "player" | "observer";
}

export interface ActionAffordanceV1 {
  id: string;
  kind: "skill" | "asset" | "stance" | "scene";
  actorCharacterInstanceId: string;
  actorName: string;
  title: string;
  description: string;
  suggestedText: string;
}

export interface VisibilityProposalV1 {
  proposalId: string;
  kind: "restricted";
  audienceCharacterInstanceIds: string[];
  audienceNames: string[];
  reason: string;
}

export interface CastMemberV1 {
  id: string;
  name: string;
  role: string;
  summary: string;
  status: string;
  controlledBy: string;
  isActive: boolean;
}

export interface NavigationItemV1 {
  id: string;
  title: string;
  status: string;
  worldTime?: string;
}

/** Player-safe Record projection; `version` is a viewer-local cursor. */
export interface RecordProjectionV1 {
  id: string;
  version: number;
  world: {
    id: string;
    name: string;
    era: string;
    summary?: string;
    style?: string;
    language?: string;
  };
  story: {
    id: string;
    title: string;
    status: string;
    premise?: string;
  };
  record: {
    id: string;
    title: string;
    location: string;
    worldTime: string;
    version: number;
  };
  events: ProjectionEventV1[];
  cast: CastMemberV1[];
  scene: {
    location: string;
    worldTime: string;
    weather: string;
    tension: string;
    objective: string;
  };
  stories: NavigationItemV1[];
  records: NavigationItemV1[];
}

/**
 * The player-safe envelope returned by record loads and committed turns.
 * `writeToken` is opaque: short-lived, bound to the writable snapshot; the
 * client must treat it as an uninterpreted string and never persist it.
 */
export interface LocalRecordEnvelopeV1 {
  record: RecordProjectionV1;
  writeToken: string;
  viewer: LocalRecordViewerV1;
  affordances: ActionAffordanceV1[];
  suggestions: string[];
  firstNight: {
    state: "pending" | "ready" | "degraded";
    hookContent: string;
    openingSuggestions: string[];
  } | null;
  selfPlay: {
    state: "running" | "stopping" | "completed" | "failed" | "cancelled";
    beatBudget: number;
    beatsCompleted: number;
    lastError: string | null;
  } | null;
  sceneImage: {
    fileId: string;
    /** Always a server-generated relative `/api/files/<id>` path. */
    fileUrl: string;
    status: "ready";
  } | null;
  sceneImageJob: {
    status: "queued" | "running" | "ready" | "failed";
    triggerKind: "scene_change" | "every_turn";
  } | null;
}

/** Player-safe Goal projection (content-owned visibility, no runtime evidence). */
export type GoalStateV1 = "active" | "completed" | "failed" | "settled";

/** Goal runtime scope 判别位（B1；story Goal 的投影路由在 B2）。 */
export type GoalScopeKindV1 = "record" | "story" | "worldline";

export interface GoalProjectionV1 {
  goalKey: string;
  scopeKind: GoalScopeKindV1;
  state: GoalStateV1;
  /** 当前 attempt（终态重试开新 attempt，终态绝不原地复活）。 */
  attempt: number;
  /** 本 attempt 取代的前序终态实例 id（首个 attempt 为 null）。 */
  supersedesInstanceId: string | null;
  progress: Readonly<Record<string, JsonValueV1>>;
  /** Content-declared outcome; present only on terminal states. */
  outcome: Readonly<Record<string, JsonValueV1>> | null;
}

// ---------------------------------------------------------------------------
// Request/response wire shapes.
// ---------------------------------------------------------------------------

/** Stable error body; carries only safe codes/messages, never internals. */
export interface LocalRecordApiErrorBodyV1 {
  ok: false;
  error: {
    code: string;
    message: string;
    currentVersion?: number;
    diagnostic?: {
      stage: "visibility" | "planning" | "drafting" | "validating" | "releasing";
      code: string;
      message: string;
      disposition: "retryable" | "failed";
    };
  };
  visibilityProposal?: VisibilityProposalV1;
}

export type LoadRecordOkV1 =
  | ({ ok: true } & LocalRecordEnvelopeV1)
  | { ok: true; onboarding: true };

export type LoadRecordResponseV1 = LoadRecordOkV1 | LocalRecordApiErrorBodyV1;

/**
 * Player message submission. `writeToken` comes from the latest envelope;
 * clients must not send workspaceId/principalId/expectedVersion — scope and
 * canonical version are recovered server-side from the opaque token.
 */
export interface SubmitRecordMessageRequestV1 {
  recordId?: string;
  content: string;
  clientMessageId: string;
  writeToken: string;
  actionSelection?: { affordanceId: string };
  visibilityConfirmation?: {
    proposalId: string;
    decision: "public" | "restricted";
  };
}

export type SubmitRecordMessageOkV1 =
  & { ok: true; disposition: "committed" | "duplicate" }
  & LocalRecordEnvelopeV1;

export type SubmitRecordMessageResponseV1 =
  | SubmitRecordMessageOkV1
  | LocalRecordApiErrorBodyV1;

export interface RecordGoalsOkV1 {
  ok: true;
  recordId: string;
  goals: GoalProjectionV1[];
}

export type RecordGoalsResponseV1 = RecordGoalsOkV1 | LocalRecordApiErrorBodyV1;

/** SSE `event: committed` data payload; the SSE `id:` is the viewer ordinal. */
export interface RecordCommittedSseDataV1 {
  event: ProjectionEventV1;
}

/** SSE `event: goal.projection` data payload; `id:` is the projection head. */
export interface GoalProjectionSseDataV1 {
  recordId: string;
  headOrdinal: number;
  goals: GoalProjectionV1[];
}

// ---------------------------------------------------------------------------
// Route builders (fail-closed input validation).
// ---------------------------------------------------------------------------

const MAX_RECORD_ID_LENGTH = 256;

function normalizeRecordId(recordId: unknown): string {
  if (
    typeof recordId !== "string"
    || recordId.length === 0
    || recordId.length > MAX_RECORD_ID_LENGTH
    || recordId.trim() !== recordId
  ) {
    throw new LocalRecordApiV1Error(
      "INVALID_ROUTE_INPUT",
      "recordId must be a non-empty trimmed string within the length limit.",
    );
  }
  return recordId;
}

function normalizeAfterOrdinal(afterOrdinal: unknown): number | undefined {
  if (afterOrdinal === undefined) return undefined;
  if (
    typeof afterOrdinal !== "number"
    || !Number.isSafeInteger(afterOrdinal)
    || afterOrdinal < 0
  ) {
    throw new LocalRecordApiV1Error(
      "INVALID_ROUTE_INPUT",
      "afterOrdinal must be a non-negative safe integer.",
    );
  }
  return afterOrdinal;
}

function withQuery(
  path: string,
  params: Record<string, string | number | undefined>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

/** GET record (optionally a deep link to a specific recordId). */
export function recordRouteV1(input?: { recordId?: string }): string {
  const recordId = input?.recordId === undefined
    ? undefined
    : normalizeRecordId(input.recordId);
  return withQuery(LOCAL_RECORD_API_V1_BASE, { recordId });
}

/** GET committed-event SSE stream for a record (viewer-local cursor). */
export function recordEventsRouteV1(input: {
  recordId: string;
  afterOrdinal?: number;
}): string {
  return withQuery(`${LOCAL_RECORD_API_V1_BASE}/events`, {
    recordId: normalizeRecordId(input?.recordId),
    afterOrdinal: normalizeAfterOrdinal(input?.afterOrdinal),
  });
}

/** POST player message (JSON body; Idempotency-Key mirrors clientMessageId). */
export function recordMessagesRouteV1(): string {
  return `${LOCAL_RECORD_API_V1_BASE}/messages`;
}

/** GET player-safe Goal projection for a record. */
export function recordGoalsRouteV1(input: { recordId: string }): string {
  return withQuery(`${LOCAL_RECORD_API_V1_BASE}/goals`, {
    recordId: normalizeRecordId(input?.recordId),
  });
}

/** GET Goal projection SSE stream for a record (viewer-local cursor). */
export function recordGoalEventsRouteV1(input: {
  recordId: string;
  afterOrdinal?: number;
}): string {
  return withQuery(`${LOCAL_RECORD_API_V1_BASE}/goals/events`, {
    recordId: normalizeRecordId(input?.recordId),
    afterOrdinal: normalizeAfterOrdinal(input?.afterOrdinal),
  });
}

// ---------------------------------------------------------------------------
// Typed client seam (injectable fetch / EventSource).
// ---------------------------------------------------------------------------

/** Minimal structural fetch response the client relies on. */
export interface LocalRecordApiV1FetchResponseLike {
  status: number;
  json(): Promise<unknown>;
}

export type LocalRecordApiV1FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<LocalRecordApiV1FetchResponseLike>;

/** Minimal structural SSE handle returned by the client stream openers. */
export interface LocalRecordApiV1EventSourceLike {
  close(): void;
  addEventListener(
    type: string,
    listener: (event: { data: string; lastEventId?: string }) => void,
  ): void;
}

export type LocalRecordApiV1EventSourceFactoryLike = (
  url: string,
) => LocalRecordApiV1EventSourceLike;

export interface LocalRecordApiV1ClientOptions {
  /** Defaults to globalThis.fetch. */
  fetch?: LocalRecordApiV1FetchLike;
  /** Defaults to globalThis.EventSource; must exist when streams are opened. */
  eventSource?: LocalRecordApiV1EventSourceFactoryLike;
  /**
   * Same-origin path prefix or http(s) origin. Fail-closed: credentials,
   * whitespace, backslashes and non-http(s) absolute URLs are rejected.
   */
  baseUrl?: string;
}

export interface LocalRecordApiV1Client {
  loadRecord(input?: { recordId?: string; signal?: AbortSignal }): Promise<LoadRecordOkV1>;
  submitMessage(
    input: SubmitRecordMessageRequestV1 & { signal?: AbortSignal },
  ): Promise<SubmitRecordMessageOkV1>;
  loadGoals(input: { recordId: string; signal?: AbortSignal }): Promise<RecordGoalsOkV1>;
  openCommittedEvents(input: {
    recordId: string;
    afterOrdinal?: number;
  }): LocalRecordApiV1EventSourceLike;
  openGoalEvents(input: {
    recordId: string;
    afterOrdinal?: number;
  }): LocalRecordApiV1EventSourceLike;
}

const MAX_BASE_URL_LENGTH = 512;
const MAX_CONTENT_LENGTH = 2_000;
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
const MAX_WRITE_TOKEN_LENGTH = 256;
const MAX_SELECTION_ID_LENGTH = 160;

function normalizeBaseUrl(baseUrl: string | undefined): string {
  if (baseUrl === undefined || baseUrl === "") return "";
  if (typeof baseUrl !== "string") {
    throw new LocalRecordApiV1Error(
      "INVALID_ROUTE_INPUT",
      "baseUrl must be a same-origin path or http(s) URL without credentials.",
    );
  }
  const isPath = baseUrl.startsWith("/") && !baseUrl.startsWith("//");
  const isAbsolute = /^https?:\/\//i.test(baseUrl);
  let parsed: URL | undefined;
  if (isAbsolute) {
    try {
      parsed = new URL(baseUrl);
    } catch {
      parsed = undefined;
    }
  }
  if (
    baseUrl.length > MAX_BASE_URL_LENGTH
    || baseUrl.includes("@")
    || baseUrl.includes("\\")
    || /\s/.test(baseUrl)
    || baseUrl.includes("?")
    || baseUrl.includes("#")
    || (!isPath && (!parsed || parsed.username || parsed.password))
  ) {
    throw new LocalRecordApiV1Error(
      "INVALID_ROUTE_INPUT",
      "baseUrl must be a same-origin path or http(s) URL without credentials.",
    );
  }
  return baseUrl.replace(/\/+$/, "");
}

function requireString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (
    typeof value !== "string"
    || value.trim().length === 0
    || value.length > maxLength
  ) {
    throw new LocalRecordApiV1Error(
      "INVALID_REQUEST",
      `${field} must be a non-empty string of at most ${maxLength} characters.`,
    );
  }
  return value;
}

function isErrorBody(payload: unknown): payload is LocalRecordApiErrorBodyV1 {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return false;
  }
  const body = payload as { ok?: unknown; error?: unknown };
  if (body.ok !== false) return false;
  const error = body.error as { code?: unknown; message?: unknown } | undefined;
  return (
    typeof error === "object"
    && error !== null
    && typeof error.code === "string"
    && typeof error.message === "string"
  );
}

function safeRemoteErrorCode(code: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(code)
    ? code
    : "REMOTE_ERROR";
}

function validateSubmitMessageInput(
  input: SubmitRecordMessageRequestV1,
): SubmitRecordMessageRequestV1 {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new LocalRecordApiV1Error(
      "INVALID_REQUEST",
      "message input must be an object.",
    );
  }
  const recordId = input.recordId === undefined
    ? undefined
    : normalizeRecordId(input.recordId);
  const content = requireString(input.content, "content", MAX_CONTENT_LENGTH);
  const clientMessageId = requireString(
    input.clientMessageId,
    "clientMessageId",
    MAX_IDEMPOTENCY_KEY_LENGTH,
  );
  const writeToken = requireString(
    input.writeToken,
    "writeToken",
    MAX_WRITE_TOKEN_LENGTH,
  );
  let actionSelection: SubmitRecordMessageRequestV1["actionSelection"];
  if (input.actionSelection !== undefined) {
    actionSelection = {
      affordanceId: requireString(
        (input.actionSelection as { affordanceId?: unknown })?.affordanceId,
        "actionSelection.affordanceId",
        MAX_SELECTION_ID_LENGTH,
      ),
    };
  }
  let visibilityConfirmation: SubmitRecordMessageRequestV1["visibilityConfirmation"];
  if (input.visibilityConfirmation !== undefined) {
    const confirmation = input.visibilityConfirmation as {
      proposalId?: unknown;
      decision?: unknown;
    } | null;
    if (
      confirmation === null
      || typeof confirmation !== "object"
      || Array.isArray(confirmation)
      || (confirmation.decision !== "public" && confirmation.decision !== "restricted")
    ) {
      throw new LocalRecordApiV1Error(
        "INVALID_REQUEST",
        "visibilityConfirmation must be a valid public or restricted decision.",
      );
    }
    visibilityConfirmation = {
      proposalId: requireString(
        confirmation.proposalId,
        "visibilityConfirmation.proposalId",
        MAX_SELECTION_ID_LENGTH,
      ),
      decision: confirmation.decision,
    };
  }
  return {
    content,
    clientMessageId,
    writeToken,
    ...(recordId === undefined ? {} : { recordId }),
    ...(actionSelection ? { actionSelection } : {}),
    ...(visibilityConfirmation ? { visibilityConfirmation } : {}),
  };
}

/**
 * Create the typed v1 client. The client only speaks the five public routes
 * above; unknown paths/versions are not constructible through this seam.
 */
export function createLocalRecordApiV1Client(
  options: LocalRecordApiV1ClientOptions = {},
): LocalRecordApiV1Client {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const fetchImpl: LocalRecordApiV1FetchLike = options.fetch
    ?? ((url, init) =>
      globalThis.fetch(url, init) as Promise<LocalRecordApiV1FetchResponseLike>);
  const eventSourceFactory: LocalRecordApiV1EventSourceFactoryLike =
    options.eventSource
    ?? ((url) => {
      const EventSourceImpl = globalThis.EventSource;
      if (typeof EventSourceImpl !== "function") {
        throw new LocalRecordApiV1Error(
          "EVENT_SOURCE_UNAVAILABLE",
          "EventSource is not available in this environment; inject one.",
        );
      }
      return new EventSourceImpl(url);
    });

  async function requestJson<Ok>(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
  ): Promise<Ok> {
    let response: LocalRecordApiV1FetchResponseLike;
    try {
      response = await fetchImpl(url, init);
    } catch (error) {
      if (error instanceof LocalRecordApiV1Error) throw error;
      throw new LocalRecordApiV1Error(
        "REQUEST_FAILED",
        "The bridge request could not be completed.",
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new LocalRecordApiV1Error(
        "INVALID_RESPONSE",
        "The bridge response was not valid JSON.",
        response.status,
      );
    }
    if (isErrorBody(payload)) {
      throw new LocalRecordApiV1Error(
        safeRemoteErrorCode(payload.error.code),
        "The bridge request was rejected.",
        response.status,
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new LocalRecordApiV1Error(
        "HTTP_ERROR",
        "The bridge request failed.",
        response.status,
      );
    }
    if (
      typeof payload !== "object"
      || payload === null
      || Array.isArray(payload)
      || (payload as { ok?: unknown }).ok !== true
    ) {
      throw new LocalRecordApiV1Error(
        "INVALID_RESPONSE",
        "The bridge response did not match the v1 envelope.",
        response.status,
      );
    }
    return payload as Ok;
  }

  return {
    loadRecord(input) {
      return requestJson<LoadRecordOkV1>(`${baseUrl}${recordRouteV1(input)}`, {
        method: "GET",
        headers: { Accept: "application/json" },
        ...(input?.signal ? { signal: input.signal } : {}),
      });
    },
    submitMessage(input) {
      const { signal, ...body } = input ?? {};
      void signal;
      const validated = validateSubmitMessageInput(
        body as SubmitRecordMessageRequestV1,
      );
      return requestJson<SubmitRecordMessageOkV1>(
        `${baseUrl}${recordMessagesRouteV1()}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "Idempotency-Key": validated.clientMessageId,
          },
          body: JSON.stringify(validated),
          ...(input?.signal ? { signal: input.signal } : {}),
        },
      );
    },
    loadGoals(input) {
      return requestJson<RecordGoalsOkV1>(
        `${baseUrl}${recordGoalsRouteV1(input)}`,
        {
          method: "GET",
          headers: { Accept: "application/json" },
          ...(input?.signal ? { signal: input.signal } : {}),
        },
      );
    },
    openCommittedEvents(input) {
      try {
        return eventSourceFactory(`${baseUrl}${recordEventsRouteV1(input)}`);
      } catch (error) {
        if (error instanceof LocalRecordApiV1Error) throw error;
        throw new LocalRecordApiV1Error(
          "EVENT_SOURCE_FAILED",
          "The committed-event stream could not be opened.",
        );
      }
    },
    openGoalEvents(input) {
      try {
        return eventSourceFactory(`${baseUrl}${recordGoalEventsRouteV1(input)}`);
      } catch (error) {
        if (error instanceof LocalRecordApiV1Error) throw error;
        throw new LocalRecordApiV1Error(
          "EVENT_SOURCE_FAILED",
          "The Goal projection stream could not be opened.",
        );
      }
    },
  };
}
