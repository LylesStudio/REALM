import type { PoolClient, QueryResultRow } from "pg";
import { normalizeUiLanguage } from "../../modules/i18n/public.ts";
import { normalizeWorldStyle } from "../../modules/style/world-style.ts";
import {
  formatDiscoveryObservationContent,
  type MechanicDetail,
} from "../../modules/actions/public.ts";
import type { RecordProjection } from "../../modules/application/legacy-record-projection-types.ts";
import {
  fallbackCompositeSemanticSegments,
  filterUnsafeDeliverySegments,
  parseSemanticPresentation,
  type SemanticSegmentKind,
} from "../../modules/presentation/semantic-segments.ts";
import {
  withWorkspaceTransaction,
  type WorkspaceDatabase,
} from "./workspace-transaction.ts";

export interface PlayerDeliveryScope {
  /** Trusted server-side scope. Never accept this value from a request body. */
  workspaceId: string;
  recordId: string;
  principalId: string;
  /** Required only when a non-omniscient principal controls multiple characters. */
  characterInstanceId?: string;
}

export interface PlayerDeliveryViewer {
  cursor: "viewer-local";
  perspective: "omniscient" | "character";
  dynamicKnowledgeVisible: boolean;
  characterInstanceId: string | null;
  /** 批次 S：membership.role 透出——UI 用它渲染执笔者徽标与姿态开关。 */
  membershipRole: "owner" | "player" | "observer";
}

export interface PlayerDeliverySnapshot {
  record: RecordProjection;
  viewer: PlayerDeliveryViewer;
  /** 最新一条可见 Narration 的下一步提案；没有提案时为空数组。 */
  suggestions?: readonly string[];
}

export interface PostgresDeliveryProjectionRepository {
  loadForPlayer(scope: PlayerDeliveryScope): Promise<RecordProjection | null>;
  loadDeliveryForPlayer(
    scope: PlayerDeliveryScope,
  ): Promise<PlayerDeliverySnapshot | null>;
  /**
   * 授权窄检查（preview 等连接前授权专用）：只跑 META_SQL——非成员/
   * 未知 Record/归档返回 false，与 loadDeliveryForPlayer 返回 null 的
   * 条件逐行同源，但不扫描 EVENTS/CAST/导航。授权语义不变，仅收窄读。
   */
  hasViewerProjection(scope: PlayerDeliveryScope): Promise<boolean>;
  /**
   * Clean-up Phase 2：授权近事件瘦读（晶化等回合后消费者专用）——
   * 与 EVENTS_SQL 同一套授权 WHERE，DESC LIMIT 有界扫描，只取展示三列；
   * 不为拿最近几条摘要而重读完整投影（META+CAST+EVENTS+navigation）。
   * growth 消费需要 policyKind 做 public-only 门禁（owner omniscient 也不得
    * 把 restricted/private 素材送进 growth extractor）。
   */
  loadRecentAuthorizedEvents(
    scope: PlayerDeliveryScope,
    limit: number,
  ): Promise<readonly {
    speaker: string;
    content: string;
    displayTime: string;
    speakerParticipantId?: string | null;
    recipientId?: string | null;
    policyKind?: string;
  }[]>;
}

export class PlayerDeliveryScopeError extends Error {
  readonly code:
    | "INVALID_SCOPE"
    | "CHARACTER_SELECTION_REQUIRED"
    | "CHARACTER_NOT_CONTROLLED";

  constructor(
    code:
      | "INVALID_SCOPE"
      | "CHARACTER_SELECTION_REQUIRED"
      | "CHARACTER_NOT_CONTROLLED",
    message: string,
  ) {
    super(message);
    this.name = "PlayerDeliveryScopeError";
    this.code = code;
  }
}

interface MetaRow extends QueryResultRow {
  id: string;
  record_title: string;
  record_status: string;
  location: string;
  objective: string;
  world_tick: string | number;
  world_ordinal: string | number;
  initial_display_time: string;
  weather: string;
  tension: string;
  world_id: string;
  world_name: string;
  era: string;
  style: string;
  world_language: string;
  world_summary: string;
  worldline_id: string;
  story_id: string;
  story_title: string;
  story_status: string;
  premise: string;
  omniscient_player_character: boolean;
  can_view_dynamic_knowledge: boolean;
  membership_role: string;
  controlled_character_instance_ids: string[];
}

interface NavigationRow extends QueryResultRow {
  id: string;
  title: string;
  status: string;
  world_time?: string;
}

interface CastRow extends QueryResultRow {
  participant_id: string;
  character_instance_id: string;
  definition_id: string;
  display_name: string;
  role: string;
  summary: string;
  status: string;
  controller_mode: "human" | "ai" | "hybrid";
  is_active: boolean;
}

interface EventRow extends QueryResultRow {
  event_kind: string;
  id: string;
  actor_participant_id: string | null;
  speaker_name: string;
  content: string;
  payload: unknown;
  participant_kind: "character" | "narrator" | null;
  controller_mode: "human" | "ai" | "hybrid" | null;
  policy_kind: "public" | "scene" | "restricted" | "private";
  display_time: string;
  recorded_at: Date | string;
}

interface ResolvedPerspective {
  omniscient: boolean;
  characterInstanceId: string | null;
}

export function createPostgresDeliveryProjectionRepository(
  database: WorkspaceDatabase,
): PostgresDeliveryProjectionRepository {
  async function loadDeliveryForPlayer(
    scope: PlayerDeliveryScope,
  ): Promise<PlayerDeliverySnapshot | null> {
    validateScope(scope);
    return withWorkspaceTransaction(
      database,
      scope.workspaceId,
      async (client) => {
        const meta = await loadMeta(client, scope);
        if (!meta) return null;

        const perspective = resolvePerspective(scope, meta);
        // A shared PoolClient cannot safely execute overlapping queries.
        // Keep every scoped read ordered inside this transaction.
        const cast = meta.can_view_dynamic_knowledge
          ? await loadCast(client, scope)
          : [];
        const events = await loadAuthorizedEvents(
          client,
          scope,
          meta,
          perspective,
        );
        const [stories, records] = await loadNavigation(client, scope, meta);
        return {
          record: toDeliveryProjection(meta, cast, events, stories, records, perspective),
          suggestions: latestNarrationSuggestions(events),
          viewer: {
            cursor: "viewer-local",
            perspective: perspective.omniscient ? "omniscient" : "character",
            dynamicKnowledgeVisible: meta.can_view_dynamic_knowledge,
            characterInstanceId: perspective.characterInstanceId,
            membershipRole: normalizeMembershipRole(meta.membership_role),
          },
        };
      },
      { readOnly: true },
    );
  }

  return {
    loadDeliveryForPlayer,
    async hasViewerProjection(scope) {
      validateScope(scope);
      return withWorkspaceTransaction(
        database,
        scope.workspaceId,
        async (client) => (await loadMeta(client, scope)) !== null,
        { readOnly: true },
      );
    },
    async loadForPlayer(scope) {
      return (await loadDeliveryForPlayer(scope))?.record ?? null;
    },
    async loadRecentAuthorizedEvents(scope, limit) {
      validateScope(scope);
      return withWorkspaceTransaction(
        database,
        scope.workspaceId,
        async (client) => {
          const meta = await loadMeta(client, scope);
          if (!meta) return [];
          const perspective = resolvePerspective(scope, meta);
          const result = await client.query<{
            speaker_name: string;
            content: string;
            display_time: string;
            actor_participant_id: string | null;
            recipient_id: string | null;
            policy_kind: string;
          }>(RECENT_EVENTS_SQL, [
            scope.workspaceId,
            scope.recordId,
            meta.world_tick,
            meta.world_ordinal,
            perspective.omniscient,
            perspective.characterInstanceId,
            Math.max(1, Math.min(50, Math.floor(limit))),
          ]);
          return result.rows.reverse().map((row) => ({
            speaker: row.speaker_name,
            content: row.content,
            displayTime: row.display_time,
            speakerParticipantId: row.actor_participant_id,
            recipientId: row.recipient_id,
            policyKind: row.policy_kind,
          }));
        },
        { readOnly: true },
      );
    },
  };
}

function validateScope(scope: PlayerDeliveryScope): void {
  if (
    !scope.workspaceId.trim()
    || !scope.recordId.trim()
    || !scope.principalId.trim()
    || (scope.characterInstanceId !== undefined && !scope.characterInstanceId.trim())
  ) {
    throw new PlayerDeliveryScopeError(
      "INVALID_SCOPE",
      "Workspace, Record, Principal and any selected CharacterInstance must be non-empty.",
    );
  }
}

function resolvePerspective(
  scope: PlayerDeliveryScope,
  meta: MetaRow,
): ResolvedPerspective {
  const controlledIds = [...new Set(meta.controlled_character_instance_ids)];
  const requestedId = scope.characterInstanceId;
  if (requestedId && !controlledIds.includes(requestedId)) {
    throw new PlayerDeliveryScopeError(
      "CHARACTER_NOT_CONTROLLED",
      "The selected CharacterInstance is not controlled by this principal.",
    );
  }

  // Omniscience is an immutable world-creation choice stored on Membership;
  // no delivery request field can enable it.
  if (meta.omniscient_player_character) {
    return { omniscient: true, characterInstanceId: null };
  }
  if (requestedId) {
    return { omniscient: false, characterInstanceId: requestedId };
  }
  if (controlledIds.length > 1) {
    throw new PlayerDeliveryScopeError(
      "CHARACTER_SELECTION_REQUIRED",
      "A principal controlling multiple characters must select one CharacterInstance.",
    );
  }
  return {
    omniscient: false,
    characterInstanceId: controlledIds[0] ?? null,
  };
}

function normalizeMembershipRole(
  value: string,
): "owner" | "player" | "observer" {
  if (value === "owner" || value === "player" || value === "observer") {
    return value;
  }
  return "player";
}

function latestNarrationSuggestions(eventRows: readonly EventRow[]): readonly string[] {
  for (let index = eventRows.length - 1; index >= 0; index -= 1) {
    const event = eventRows[index];
    if (event?.event_kind !== "narration.committed") continue;
    const payload = event.payload;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return [];
    const payloadObject = payload as Record<string, unknown>;
    const runtimePayload = payloadObject.__realmRuntimePayload;
    const source = typeof runtimePayload === "object"
      && runtimePayload !== null
      && !Array.isArray(runtimePayload)
      ? runtimePayload as Record<string, unknown>
      : payloadObject;
    const suggestions = source.suggestions ?? payloadObject.suggestions;
    if (!Array.isArray(suggestions)) return [];
    return suggestions
      .map((item) => typeof item === "string" ? item.trim().slice(0, 40) : "")
      .filter((item) => item.length > 0)
      .slice(0, 3);
  }
  return [];
}

async function loadMeta(
  client: PoolClient,
  scope: PlayerDeliveryScope,
): Promise<MetaRow | null> {
  const result = await client.query<MetaRow>(META_SQL, [
    scope.workspaceId,
    scope.recordId,
    scope.principalId,
  ]);
  return result.rows[0] ?? null;
}

async function loadCast(
  client: PoolClient,
  scope: PlayerDeliveryScope,
): Promise<CastRow[]> {
  const result = await client.query<CastRow>(CAST_SQL, [
    scope.workspaceId,
    scope.recordId,
  ]);
  return result.rows;
}

async function loadAuthorizedEvents(
  client: PoolClient,
  scope: PlayerDeliveryScope,
  meta: MetaRow,
  perspective: ResolvedPerspective,
): Promise<EventRow[]> {
  const result = await client.query<EventRow>(EVENTS_SQL, [
    scope.workspaceId,
    scope.recordId,
    meta.world_tick,
    meta.world_ordinal,
    perspective.omniscient,
    perspective.characterInstanceId,
  ]);
  return result.rows;
}

function toDeliveryProjection(
  meta: MetaRow,
  castRows: readonly CastRow[],
  eventRows: readonly EventRow[],
  storyRows: readonly NavigationRow[],
  recordRows: readonly NavigationRow[],
  perspective: ResolvedPerspective,
): RecordProjection {
  const cast = castRows.map((row) => ({
    id: row.definition_id,
    participantId: row.participant_id,
    characterInstanceId: row.character_instance_id,
    name: row.display_name,
    role: row.role,
    summary: row.summary,
    status: row.status,
    controlledBy: row.controller_mode,
    isActive: row.is_active,
  }));

  // Canonical ordinals and Record versions encode the number of hidden Events.
  // Delivery uses a dense, viewer-local cursor; write-side CAS is a separate
  // authenticated control-plane contract and must never reuse this value.
  const events = eventRows.map((row, index) => {
    const type = deliveryEventType(row.event_kind);
    const parsedSegments = parseSemanticPresentation(row.payload);
    const viewerDiscovery = parseViewerLocalDiscovery(
      row.payload,
      perspective.characterInstanceId,
    );
    const segments = filterUnsafeDeliverySegments([
      ...(parsedSegments ?? fallbackCompositeSemanticSegments(row.content, fallbackSegmentKind(type))),
      ...(viewerDiscovery
        ? [{
            id: "discovery-1",
            kind: "fact" as const,
            content: viewerDiscovery,
            speechMode: "none" as const,
          }]
        : []),
    ]);
    // 批次 T3：在场标记从 payload 元数据解析（既有事件形态，无新事件类型）。
    const presence = parsePresenceMarker(row.payload);
    // 对话主体标记（内部字段，UI 不展示）：从 payload 元数据解析，旧事件
    // 无该字段读作 null。
    const recipientId = parseEventRecipientId(row.payload);
    // 批次 T5：判定骰点从物化的 actionTransaction.receipt.mechanic 解析
    // （读已落库结果，绝不重掷）。
    const dice = parseDiceMechanic(row.payload);
    // 批次 T7：自演拍标记同型解析（形状非法不透出）。
    const selfPlay = parseSelfPlayMarker(row.payload);
    return {
      id: row.id,
      ordinal: index + 1,
      type,
      speaker: row.speaker_name,
      speakerParticipantId: row.actor_participant_id,
      role:
        row.event_kind === "action.transaction.committed"
          || row.event_kind === "system.correction.committed"
          ? ("system" as const)
          : row.event_kind === "narration.committed" || row.participant_kind === "narrator"
          ? ("narrator" as const)
          : row.controller_mode === "human"
            ? ("player" as const)
            : ("character" as const),
      content: segments.map((segment) => segment.content).join("\n"),
      segments,
      worldTime: row.display_time,
      visibility: deliveryVisibility(row.policy_kind, perspective.omniscient),
      status: "committed",
      createdAt:
        row.recorded_at instanceof Date
          ? row.recorded_at.toISOString()
          : new Date(row.recorded_at).toISOString(),
      ...(recipientId ? { recipientId } : {}),
      ...(presence ? { presence } : {}),
      ...(dice ? { dice } : {}),
      ...(selfPlay ? { selfPlay } : {}),
    };
  });
  const viewerVersion = events.length;
  const latestAuthorizedDisplayTime =
    eventRows.at(-1)?.display_time.trim() || meta.initial_display_time;
  const panelDisplayTime = meta.can_view_dynamic_knowledge
    ? latestAuthorizedDisplayTime
    : "";

  return {
    id: meta.id,
    version: viewerVersion,
    world: {
      id: meta.world_id,
      name: meta.world_name,
      era: meta.era,
      summary: meta.world_summary,
      timeCursor: panelDisplayTime,
      style: normalizeWorldStyle(meta.style),
      language: normalizeUiLanguage(meta.world_language),
    },
    story: {
      id: meta.story_id,
      title: meta.story_title,
      status: meta.story_status,
      premise: meta.premise,
    },
    record: {
      id: meta.id,
      title: meta.record_title,
      status: meta.record_status,
      version: viewerVersion,
      location: meta.location,
      worldTime: panelDisplayTime,
    },
    scene: {
      location: meta.location,
      worldTime: panelDisplayTime,
      weather: meta.weather,
      tension: meta.tension,
      objective: meta.objective,
    },
    cast,
    participants: cast,
    events,
    stories: storyRows.map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
    })),
    records: recordRows.map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      worldTime: row.world_time ?? "",
    })),
  };
}

/**
 * 导航树：当前 worldline 的全部故事与当前故事的全部记录。
 * status / worldTime 属动态知识，与场景字段同一道 can_view_dynamic_knowledge
 * 门禁；标题是导航元数据，始终可见。
 */
async function loadNavigation(
  client: PoolClient,
  scope: PlayerDeliveryScope,
  meta: MetaRow,
): Promise<[NavigationRow[], NavigationRow[]]> {
  const stories = await client.query<NavigationRow>(
    `SELECT
       story.id,
       story.title,
       CASE WHEN $4::boolean THEN story.status ELSE '' END AS status
     FROM stories AS story
     WHERE story.workspace_id = $1
       AND story.world_id = $2
       AND story.worldline_id = $3
     ORDER BY story.created_at ASC, story.id ASC`,
    [
      scope.workspaceId,
      meta.world_id,
      meta.worldline_id,
      meta.can_view_dynamic_knowledge,
    ],
  );
  const records = await client.query<NavigationRow>(
    `SELECT
       record.id,
       record.title,
       CASE WHEN $5::boolean THEN record.status ELSE '' END AS status,
       CASE WHEN $5::boolean THEN COALESCE((
         SELECT event.display_time
         FROM events AS event
         WHERE event.workspace_id = record.workspace_id
           AND event.record_id = record.id
         ORDER BY event.world_tick DESC, event.world_ordinal DESC, event.id DESC
         LIMIT 1
       ), '') ELSE '' END AS world_time
     FROM records AS record
     WHERE record.workspace_id = $1
       AND record.world_id = $2
       AND record.worldline_id = $3
       AND record.story_id = $4
       -- 批次 T12-B：导航列表不外显已归档 Record
       AND record.status <> 'archived'
     ORDER BY record.created_at ASC, record.id ASC`,
    [
      scope.workspaceId,
      meta.world_id,
      meta.worldline_id,
      meta.story_id,
      meta.can_view_dynamic_knowledge,
    ],
  );
  return [stories.rows, records.rows];
}

function deliveryEventType(
  kind: string,
): "narration" | "utterance" | "action" | "system" {
  switch (kind) {
    case "narration.committed":
      return "narration";
    case "utterance.committed":
      return "utterance";
    case "action.transaction.committed":
      return "action";
    default:
      return "system";
  }
}

function fallbackSegmentKind(
  type: ReturnType<typeof deliveryEventType>,
): SemanticSegmentKind {
  switch (type) {
    case "narration":
      return "story";
    case "action":
      return "action";
    case "system":
      return "fact";
    default:
      return "dialogue";
  }
}

function deliveryVisibility(
  kind: EventRow["policy_kind"],
  omniscient: boolean,
): string {
  // Secret material shown through immutable omniscience is explicitly OOC so
  // clients never present it as knowledge held by the controlled character.
  return omniscient && kind !== "public" ? `ooc:${kind}` : kind;
}

/**
 * 对话主体标记读回（内部字段）：从事件 payload 元数据解析 recipientId。
 * 旧事件无该字段、形状非法（非字符串/空白）一律读作 null（不透出）。
 */
export function parseEventRecipientId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = (payload as Record<string, unknown>).recipientId;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 批次 T3：解析事件 payload 元数据里的在场标记。
 * 形状非法（缺 characterInstanceId / triggerKind 越界）→ undefined（不透出）。
 */
function parsePresenceMarker(payload: unknown):
  | { characterInstanceId: string; triggerKind: "environment" | "peer" | "hook" }
  | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const presence = (payload as Record<string, unknown>).presence;
  if (typeof presence !== "object" || presence === null) return undefined;
  const marker = presence as Record<string, unknown>;
  if (typeof marker.characterInstanceId !== "string") return undefined;
  if (
    marker.triggerKind !== "environment"
    && marker.triggerKind !== "peer"
    && marker.triggerKind !== "hook"
  ) {
    return undefined;
  }
  return {
    characterInstanceId: marker.characterInstanceId,
    triggerKind: marker.triggerKind,
  };
}

/**
 * 批次 T7：解析事件 payload 元数据里的自演拍标记。
 * 形状非法（beat 非正整数）→ undefined（不透出）。
 */
function parseSelfPlayMarker(payload: unknown): { beat: number } | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const selfPlay = (payload as Record<string, unknown>).selfPlay;
  if (typeof selfPlay !== "object" || selfPlay === null) return undefined;
  const beat = (selfPlay as Record<string, unknown>).beat;
  if (typeof beat !== "number" || !Number.isSafeInteger(beat) || beat < 1) {
    return undefined;
  }
  return { beat };
}

export function parseViewerLocalDiscovery(
  payload: unknown,
  controlledCharacterInstanceId: string | null,
): string | undefined {
  if (!controlledCharacterInstanceId) return undefined;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const transaction = (payload as Record<string, unknown>).actionTransaction;
  if (typeof transaction !== "object" || transaction === null || Array.isArray(transaction)) {
    return undefined;
  }
  const transactionObject = transaction as Record<string, unknown>;
  const actor = transactionObject.actor;
  if (typeof actor !== "object" || actor === null || Array.isArray(actor)) return undefined;
  if ((actor as Record<string, unknown>).characterInstanceId !== controlledCharacterInstanceId) {
    return undefined;
  }
  const receipt = transactionObject.receipt;
  if (typeof receipt !== "object" || receipt === null || Array.isArray(receipt)) return undefined;
  const observations = (receipt as Record<string, unknown>).privateObservations;
  if (!Array.isArray(observations)) return undefined;
  const own = observations.find((candidate) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return false;
    return (candidate as Record<string, unknown>).characterInstanceId
      === controlledCharacterInstanceId;
  });
  if (typeof own !== "object" || own === null || Array.isArray(own)) return undefined;
  const discovery = (own as Record<string, unknown>).discovery;
  if (typeof discovery !== "object" || discovery === null || Array.isArray(discovery)) {
    return undefined;
  }
  const value = discovery as Record<string, unknown>;
  const subject = typeof value.subject === "string" ? value.subject.trim() : "";
  const feature = typeof value.feature === "string" ? value.feature.trim() : "";
  const nextCheck = typeof value.nextCheck === "string" ? value.nextCheck.trim() : "";
  const certainty = value.certainty;
  if (
    !subject || !feature || !nextCheck
    || (certainty !== "confirmed" && certainty !== "partial")
  ) return undefined;
  return `${certainty === "partial" ? "暂时线索" : "发现线索"}：${formatDiscoveryObservationContent({
    subject,
    feature,
    nextCheck,
  })}`;
}

const DELIVERY_DICE_SYSTEMS = ["d20", "2d6", "percentile", "pool", "draw"] as const;

/**
 * 批次 T5：解析事件 payload 元数据里物化的判定骰点
 * （actionTransaction.receipt.mechanic，裁决时刻一次物化——投影只读库，
 * 绝不重掷）。形状非法 → undefined（不透出畸形数据）。
 */
function parseDiceMechanic(payload: unknown): MechanicDetail | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const transaction = (payload as Record<string, unknown>).actionTransaction;
  if (typeof transaction !== "object" || transaction === null) return undefined;
  const receipt = (transaction as Record<string, unknown>).receipt;
  if (typeof receipt !== "object" || receipt === null) return undefined;
  const mechanic = (receipt as Record<string, unknown>).mechanic;
  if (typeof mechanic !== "object" || mechanic === null) return undefined;
  const m = mechanic as Record<string, unknown>;
  if (
    typeof m.system !== "string"
    || !(DELIVERY_DICE_SYSTEMS as readonly string[]).includes(m.system)
    || !Array.isArray(m.rolls)
    || !m.rolls.every((roll) => typeof roll === "number")
    || typeof m.modifier !== "number"
    || typeof m.target !== "number"
    || typeof m.total !== "number"
    || typeof m.success !== "boolean"
  ) {
    return undefined;
  }
  return {
    system: m.system as MechanicDetail["system"],
    rolls: m.rolls as readonly number[],
    modifier: m.modifier,
    target: m.target,
    total: m.total,
    success: m.success,
    ...(m.critical === true ? { critical: true as const } : {}),
    ...(m.fumble === true ? { fumble: true as const } : {}),
    ...(typeof m.skillKey === "string" ? { skillKey: m.skillKey } : {}),
    ...(typeof m.drawnCard === "string" ? { drawnCard: m.drawnCard } : {}),
    ...(typeof m.deckRemaining === "number"
      ? { deckRemaining: m.deckRemaining }
      : {}),
  };
}

const META_SQL = `
  SELECT
    record.id,
    record.title AS record_title,
    record.worldline_id,
    CASE WHEN membership.can_view_dynamic_knowledge THEN record.status ELSE '' END
      AS record_status,
    CASE WHEN membership.can_view_dynamic_knowledge THEN scene.location ELSE '' END
      AS location,
    CASE
      WHEN membership.can_view_dynamic_knowledge
        AND NOT (
          to_jsonb(record)->>'timeline_kind' = 'retrospection'
          AND NOT EXISTS (
            SELECT 1 FROM events AS empty_retro_event
            WHERE empty_retro_event.workspace_id = record.workspace_id
              AND empty_retro_event.record_id = record.id
          )
        )
      THEN scene.objective
      ELSE ''
    END AS objective,
    cursor.world_tick,
    cursor.world_ordinal,
    CASE WHEN membership.can_view_dynamic_knowledge
      THEN COALESCE(
        NULLIF(to_jsonb(scene)->>'display_time', ''),
        -- T12 验收修正：无快照的 retrospection fail-closed 为空，不得回退
        -- worlds.settings 把旧重演拉到当前世界时间；primary 兼容回退。
        CASE WHEN to_jsonb(record)->>'timeline_kind' = 'retrospection'
          THEN '' ELSE world.settings->>'displayTime' END,
        ''
      )
      ELSE ''
    END AS initial_display_time,
    CASE WHEN membership.can_view_dynamic_knowledge
      THEN COALESCE(
        NULLIF(to_jsonb(scene)->>'weather', ''),
        CASE WHEN to_jsonb(record)->>'timeline_kind' = 'retrospection'
          THEN '' ELSE world.settings->>'weather' END,
        ''
      )
      ELSE ''
    END AS weather,
    CASE
      WHEN membership.can_view_dynamic_knowledge
        AND NOT (
          to_jsonb(record)->>'timeline_kind' = 'retrospection'
          AND NOT EXISTS (
            SELECT 1 FROM events AS empty_retro_event
            WHERE empty_retro_event.workspace_id = record.workspace_id
              AND empty_retro_event.record_id = record.id
          )
        )
      THEN COALESCE(to_jsonb(scene)->>'tension', world.settings->>'tension', '')
      ELSE ''
    END AS tension,
    world.id AS world_id,
    world.name AS world_name,
    CASE WHEN membership.can_view_dynamic_knowledge
      THEN COALESCE(world.settings->>'era', '') ELSE ''
    END AS era,
    COALESCE(world.settings->>'style', '') AS style,
    COALESCE((
      SELECT account.ui_language
      FROM player_world_memberships AS owner_membership
      JOIN accounts AS account
        ON account.workspace_id = owner_membership.workspace_id
       AND account.principal_id = owner_membership.principal_id
      WHERE owner_membership.workspace_id = record.workspace_id
        AND owner_membership.world_id = record.world_id
        AND owner_membership.role = 'owner'
      GROUP BY account.ui_language
      ORDER BY count(*) DESC, account.ui_language ASC
      LIMIT 1
    ), 'zh-CN') AS world_language,
    CASE WHEN membership.can_view_dynamic_knowledge THEN world.summary ELSE '' END
      AS world_summary,
    story.id AS story_id,
    story.title AS story_title,
    CASE WHEN membership.can_view_dynamic_knowledge THEN story.status ELSE '' END
      AS story_status,
    CASE WHEN membership.can_view_dynamic_knowledge THEN story.premise ELSE '' END
      AS premise,
    membership.omniscient_player_character,
    membership.can_view_dynamic_knowledge,
    membership.role AS membership_role,
    ARRAY(
      SELECT DISTINCT participant.character_instance_id
      FROM participants AS participant
      WHERE participant.workspace_id = record.workspace_id
        AND participant.record_id = record.id
        AND participant.principal_id = membership.principal_id
        AND participant.participant_kind = 'character'
        AND participant.is_active = true
        AND participant.character_instance_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM character_instances AS active_instance
          WHERE active_instance.workspace_id = participant.workspace_id
            AND active_instance.record_id = participant.record_id
            AND active_instance.id = participant.character_instance_id
            AND active_instance.status = 'present'
        )
      ORDER BY participant.character_instance_id
    ) AS controlled_character_instance_ids
  FROM records AS record
  JOIN worlds AS world
    ON world.workspace_id = record.workspace_id AND world.id = record.world_id
  JOIN stories AS story
    ON story.workspace_id = record.workspace_id AND story.id = record.story_id
  JOIN record_heads AS head
    ON head.workspace_id = record.workspace_id AND head.record_id = record.id
  JOIN player_world_memberships AS membership
    ON membership.workspace_id = record.workspace_id
   AND membership.world_id = record.world_id
   AND membership.principal_id = $3
  CROSS JOIN LATERAL (
    SELECT
      COALESCE(head.last_world_tick, record.start_tick) AS world_tick,
      COALESCE(head.last_world_ordinal, record.start_ordinal) AS world_ordinal
  ) AS cursor
  JOIN LATERAL (
    SELECT candidate.*
    FROM scenes AS candidate
    WHERE candidate.workspace_id = record.workspace_id
      AND candidate.record_id = record.id
      AND (candidate.start_tick, candidate.start_ordinal)
        <= (cursor.world_tick, cursor.world_ordinal)
    ORDER BY candidate.start_tick DESC, candidate.start_ordinal DESC, candidate.id ASC
    LIMIT 1
  ) AS scene ON true
  WHERE record.workspace_id = $1 AND record.id = $2
    -- 批次 T12-B：归档 Record fail-closed——投影主查询不解析 archived，
    -- 直接打开已归档 Record 返回未找到，而非继续展示/写入。
    AND record.status <> 'archived'
`;

const CAST_SQL = `
  SELECT
    participant.id AS participant_id,
    instance.id AS character_instance_id,
    definition.id AS definition_id,
    definition.display_name,
    COALESCE(definition.profile->>'role', '') AS role,
    COALESCE(NULLIF(instance.state->>'profileSummary', ''), definition.profile->>'summary', '') AS summary,
    instance.status,
    participant.controller_mode,
    participant.is_active
  FROM participants AS participant
  JOIN character_instances AS instance
    ON instance.workspace_id = participant.workspace_id
   AND instance.id = participant.character_instance_id
  JOIN character_continuities AS continuity
    ON continuity.workspace_id = instance.workspace_id
   AND continuity.id = instance.continuity_id
  JOIN character_definitions AS definition
    ON definition.workspace_id = continuity.workspace_id
   AND definition.id = continuity.definition_id
  WHERE participant.workspace_id = $1
    AND participant.record_id = $2
    AND participant.participant_kind = 'character'
  ORDER BY participant.speaking_order ASC, participant.id ASC
`;

// 授权过滤体（EVENTS_SQL 与 RECENT_EVENTS_SQL 共享，防止权限语义漂移）。
const EVENTS_AUTH_FROM_WHERE = `
  FROM events AS event
  JOIN visibility_policies AS policy
    ON policy.workspace_id = event.workspace_id
   AND policy.world_id = event.world_id
   AND policy.worldline_id = event.worldline_id
   AND policy.record_id = event.record_id
   AND policy.id = event.visibility_policy_id
  LEFT JOIN participants AS actor
    ON actor.workspace_id = event.workspace_id
   AND actor.record_id = event.record_id
   AND actor.id = event.actor_participant_id
  WHERE event.workspace_id = $1
    AND event.record_id = $2
    -- Action Transactions are authoritative control-plane receipts. 批次 T5
    -- 起带物化骰点（mechanic）的判定事件进入玩家时间线（规范 §3）；无骰点的
    -- 自动行动仍只在控制面，不进玩家投影。
    AND (
      event.event_kind <> 'action.transaction.committed'
      OR event.payload -> 'actionTransaction' -> 'receipt' ? 'mechanic'
      OR (
        $6::text IS NOT NULL
        AND event.payload -> 'actionTransaction' -> 'actor' ->> 'characterInstanceId' = $6::text
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements(
            CASE
              WHEN jsonb_typeof(event.payload -> 'actionTransaction' -> 'receipt' -> 'privateObservations') = 'array'
                THEN event.payload -> 'actionTransaction' -> 'receipt' -> 'privateObservations'
              ELSE '[]'::jsonb
            END
          ) AS observation
          WHERE observation ? 'discovery'
        )
      )
    )
    AND (event.world_tick, event.world_ordinal) <= ($3::bigint, $4::bigint)
    AND policy.policy_kind <> 'dm_only'
    AND (
      $5::boolean
      OR policy.policy_kind = 'public'
      OR (
        $6::text IS NOT NULL
        AND policy.policy_kind IN ('scene', 'restricted')
        AND EXISTS (
          SELECT 1
          FROM visibility_policy_audiences AS audience
          WHERE audience.workspace_id = event.workspace_id
            AND audience.world_id = event.world_id
            AND audience.worldline_id = event.worldline_id
            AND audience.record_id = event.record_id
            AND audience.visibility_policy_id = policy.id
            AND audience.character_instance_id = $6::text
        )
      )
      OR (
        $6::text IS NOT NULL
        AND policy.policy_kind = 'private'
        AND policy.private_character_instance_id = $6::text
      )
    )
`;

const EVENTS_SQL = `
  SELECT
    event.id,
    event.event_kind,
    event.actor_participant_id,
    event.speaker_name,
    event.content,
    event.payload,
    actor.participant_kind,
    actor.controller_mode,
    policy.policy_kind,
    event.display_time,
    event.recorded_at
  ${EVENTS_AUTH_FROM_WHERE}
  ORDER BY event.record_ordinal ASC
`;

/**
 * 授权近事件瘦读（DESC LIMIT 有界）：与 EVENTS_SQL 同一授权体；
 * 调用方负责把结果反转回时间正序。
 */
const RECENT_EVENTS_SQL = `
  SELECT
    event.speaker_name,
    event.content,
    event.display_time,
    event.actor_participant_id,
    event.payload ->> 'recipientId' AS recipient_id,
    policy.policy_kind
  ${EVENTS_AUTH_FROM_WHERE}
  ORDER BY event.world_tick DESC, event.world_ordinal DESC, event.record_ordinal DESC
  LIMIT $7
`;
