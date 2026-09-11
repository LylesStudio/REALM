import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  normalizeFirstNightContext,
  FIRST_NIGHT_STATES,
  type FirstNightContext,
  type FirstNightPack,
  type FirstNightState,
} from "../../modules/application/first-night.ts";
import { withWorkspaceTransaction } from "./workspace-transaction.ts";
import { gateRecordActive, gateWorldWrite } from "./world-write-gate.ts";

/**
 * v37 §D.0 两拍模式（recordId 键路径）：① 无锁只读 record 行取 worldId
 * → ② gateWorldWrite（worlds KEY SHARE + active）→ ③ gateRecordActive
 * （records FOR UPDATE + 非 archived）。C 面：archived 拒绝。
 */
async function gateRecordPath(
  client: PoolClient,
  workspaceId: string,
  recordId: string,
): Promise<void> {
  const record = await client.query<{ world_id: string }>(
    `SELECT world_id FROM records WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, recordId],
  );
  if (!record.rows[0]) return;
  await gateWorldWrite(client, {
    workspaceId,
    worldId: record.rows[0].world_id,
  });
  await gateRecordActive(client, { workspaceId, recordId });
}

/**
 * 世界初夜状态行与初夜事件落库（批次 T1）。
 *
 * 状态行（record_first_nights）在落笔事务内由 library-service 写入 pending；
 * 本仓储负责异步阶段：尝试计数、追加初夜事件并推进记录头/世界线头、
 * 状态行收尾。全部写入走受限 realm_runtime 角色（0019 授权）。
 */

export interface FirstNightMarker {
  recordId: string;
  worldId: string;
  state: FirstNightState;
  attempts: number;
  hookContent: string;
  suggestions: readonly string[];
  context: FirstNightContext | null;
}

export interface FirstNightClaim {
  attempts: number;
  context: FirstNightContext | null;
}

export interface FirstNightStore {
  /** 读取状态行；旧世界无行返回 null（前端行为零变化）。 */
  find(recordId: string): Promise<FirstNightMarker | null>;
  /** pending 时自增尝试次数并返回上下文；非 pending/无行返回 null。 */
  claimAttempt(recordId: string): Promise<FirstNightClaim | null>;
  /**
   * 单事务追加初夜场景定格旁白并推进头指针；状态行收尾 ready/degraded。
   * 幂等：状态非 pending 直接跳过返回 false。
   */
  commitPack(
    recordId: string,
    pack: FirstNightPack,
    state: "ready" | "degraded",
  ): Promise<boolean>;
}

function isState(value: unknown): value is FirstNightState {
  return typeof value === "string"
    && (FIRST_NIGHT_STATES as readonly string[]).includes(value);
}

function mapMarker(row: {
  record_id: string;
  world_id: string;
  state: string;
  attempts: number;
  hook_content: string;
  suggestions: string[];
  context: unknown;
}): FirstNightMarker | null {
  if (!isState(row.state)) return null;
  return {
    recordId: row.record_id,
    worldId: row.world_id,
    state: row.state,
    attempts: row.attempts,
    hookContent: row.hook_content,
    suggestions: Array.isArray(row.suggestions) ? row.suggestions : [],
    context: normalizeFirstNightContext(row.context),
  };
}

export function createPostgresFirstNightStore(
  database: Pool,
  workspaceId: string,
): FirstNightStore {
  async function find(recordId: string): Promise<FirstNightMarker | null> {
    return withWorkspaceTransaction(
      database,
      workspaceId,
      async (client) => {
        const result = await client.query<{
          record_id: string;
          world_id: string;
          state: string;
          attempts: number;
          hook_content: string;
          suggestions: string[];
          context: unknown;
        }>(
          `SELECT record_id, world_id, state, attempts, hook_content, suggestions, context
           FROM record_first_nights
           WHERE workspace_id = $1 AND record_id = $2`,
          [workspaceId, recordId],
        );
        const row = result.rows[0];
        return row ? mapMarker(row) : null;
      },
      { readOnly: true },
    );
  }

  async function claimAttempt(recordId: string): Promise<FirstNightClaim | null> {
    return withWorkspaceTransaction(database, workspaceId, async (client) => {
      // v37 §D.0：C 面 admission——worlds(KEY SHARE)→records(FOR UPDATE)
      // gate 在前；archived 拒绝。
      await gateRecordPath(client, workspaceId, recordId);
      const result = await client.query<{ attempts: number; context: unknown }>(
        `UPDATE record_first_nights
         SET attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP
         WHERE workspace_id = $1 AND record_id = $2 AND state = 'pending'
         RETURNING attempts, context`,
        [workspaceId, recordId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return { attempts: row.attempts, context: normalizeFirstNightContext(row.context) };
    });
  }

  async function commitPack(
    recordId: string,
    pack: FirstNightPack,
    state: "ready" | "degraded",
  ): Promise<boolean> {
    return withWorkspaceTransaction(database, workspaceId, async (client) => {
      // v37 §D.0：C 面两拍——gate 先于 marker/record_heads/worldlines 锁。
      await gateRecordPath(client, workspaceId, recordId);
      const marker = await client.query<{ state: string }>(
        `SELECT state
         FROM record_first_nights
         WHERE workspace_id = $1 AND record_id = $2
         FOR UPDATE`,
        [workspaceId, recordId],
      );
      if (marker.rows[0]?.state !== "pending") return false;

      const scope = await client.query<{
        world_id: string;
        worldline_id: string;
        calendar_id: string;
        display_time: string;
      }>(
        `SELECT record.world_id, record.worldline_id, world.calendar_id,
           COALESCE(world.settings->>'displayTime', '') AS display_time
         FROM records AS record
         JOIN worlds AS world
           ON world.workspace_id = record.workspace_id
          AND world.id = record.world_id
         WHERE record.workspace_id = $1 AND record.id = $2`,
        [workspaceId, recordId],
      );
      const recordScope = scope.rows[0];
      if (!recordScope) return false;

      const sceneRow = await client.query<{ id: string }>(
        `SELECT id
         FROM scenes
         WHERE workspace_id = $1 AND record_id = $2 AND status = 'active'
         ORDER BY start_tick ASC, start_ordinal ASC
         LIMIT 1`,
        [workspaceId, recordId],
      );
      const sceneId = sceneRow.rows[0]?.id;
      if (!sceneId) return false;

      const policyRow = await client.query<{ id: string }>(
        `SELECT id
         FROM visibility_policies
         WHERE workspace_id = $1 AND record_id = $2 AND policy_kind = 'public'
         LIMIT 1`,
        [workspaceId, recordId],
      );
      const policyId = policyRow.rows[0]?.id;
      if (!policyId) return false;

      const head = await client.query<{
        record_version: string | number;
        next_record_ordinal: string | number;
      }>(
        `SELECT record_version, next_record_ordinal
         FROM record_heads
         WHERE workspace_id = $1 AND record_id = $2
         FOR UPDATE`,
        [workspaceId, recordId],
      );
      const headRow = head.rows[0];
      if (!headRow) return false;
      const worldlineHead = await client.query<{
        head_tick: string | number;
        head_ordinal: string | number;
      }>(
        `SELECT head_tick, head_ordinal
         FROM worldlines
         WHERE workspace_id = $1 AND id = $2
         FOR UPDATE`,
        [workspaceId, recordScope.worldline_id],
      );
      const worldlineRow = worldlineHead.rows[0];
      if (!worldlineRow) return false;

      const recordVersion = Number(headRow.record_version) + 1;
      const firstOrdinal = Number(headRow.next_record_ordinal);
      const worldTick = Number(worldlineRow.head_tick);
      const firstWorldOrdinal = Number(worldlineRow.head_ordinal) + 1;

      // 能力点二：按名字解析同行者 participant（participants→instances→
      // continuities→definitions display_name 链）；解析失败的角色静默丢弃。
      const participantByName = await resolveCharacterParticipants(client, workspaceId, recordId);

      // 初夜批次：场景定格旁白 + 同行者发声，同一 record_version，
      // record/world ordinal 连续（与回合内批次同语义）。
      const writes: FirstNightEventDraft[] = [
        {
          eventKind: "narration.committed",
          speakerName: "旁白",
          actorParticipantId: null,
          segments: sceneSegments(pack.scene),
        },
        ...pack.characters
          .filter((character) => participantByName.has(character.name))
          .map((character): FirstNightEventDraft => ({
            eventKind: "utterance.committed",
            speakerName: character.name,
            actorParticipantId: participantByName.get(character.name)!,
            segments: characterSegments(character),
          })),
      ];
      // 能力点三：钩子事件——旁白形态追加，payload.metadata.hook=true。
      if (pack.hook.content.trim()) {
        writes.push({
          eventKind: "narration.committed",
          speakerName: "旁白",
          actorParticipantId: null,
          segments: [
            {
              id: "story-1",
              kind: "story",
              content: pack.hook.content.trim(),
              speechMode: "narrator",
            },
          ],
          metadata: { hook: true },
        });
      }
      const eventIds: string[] = [];
      for (const draft of writes) {
        if (draft.segments.length === 0) continue;
        const eventId = await insertFirstNightEvent(client, {
          workspaceId,
          worldId: recordScope.world_id,
          worldlineId: recordScope.worldline_id,
          recordId,
          sceneId,
          policyId,
          recordVersion,
          recordOrdinal: firstOrdinal + eventIds.length,
          batchIndex: eventIds.length,
          worldTick,
          worldOrdinal: firstWorldOrdinal + eventIds.length,
          calendarId: recordScope.calendar_id,
          displayTime: recordScope.display_time,
          write: draft,
        });
        eventIds.push(eventId);
      }
      if (eventIds.length === 0) return false;

      await client.query(
        `UPDATE record_heads
         SET record_version = $3,
             next_record_ordinal = $4,
             last_event_id = $5,
             last_world_tick = $6,
             last_world_ordinal = $7,
             updated_at = CURRENT_TIMESTAMP
         WHERE workspace_id = $1 AND record_id = $2`,
        [
          workspaceId,
          recordId,
          recordVersion,
          firstOrdinal + eventIds.length,
          eventIds[eventIds.length - 1],
          worldTick,
          firstWorldOrdinal + eventIds.length - 1,
        ],
      );
      await client.query(
        `UPDATE worldlines
         SET head_tick = $3, head_ordinal = $4, updated_at = CURRENT_TIMESTAMP
         WHERE workspace_id = $1 AND id = $2`,
        [workspaceId, recordScope.worldline_id, worldTick, firstWorldOrdinal + eventIds.length - 1],
      );
      // 钩子与提案镜像进状态行（投影读取快路径；事件 payload 亦带 hook 标识）。
      await client.query(
        `UPDATE record_first_nights
         SET state = $3, hook_content = $4, suggestions = $5, updated_at = CURRENT_TIMESTAMP
         WHERE workspace_id = $1 AND record_id = $2`,
        [
          workspaceId,
          recordId,
          state,
          pack.hook.content.trim(),
          pack.hook.suggestions.filter((item) => item.trim().length > 0),
        ],
      );
      return true;
    });
  }

  return { find, claimAttempt, commitPack };
}

interface FirstNightSegment {
  id: string;
  kind: "environment" | "story" | "fact" | "action" | "dialogue";
  content: string;
  speechMode: "narrator" | "speaker";
}

interface FirstNightEventDraft {
  eventKind: "narration.committed" | "utterance.committed";
  speakerName: string;
  actorParticipantId: string | null;
  segments: FirstNightSegment[];
  /** payload 内附元数据（如钩子事件 metadata.hook=true）。 */
  metadata?: Record<string, unknown>;
}

interface FirstNightEventWrite {
  workspaceId: string;
  worldId: string;
  worldlineId: string;
  recordId: string;
  sceneId: string;
  policyId: string;
  recordVersion: number;
  recordOrdinal: number;
  batchIndex: number;
  worldTick: number;
  worldOrdinal: number;
  calendarId: string;
  displayTime: string;
  write: FirstNightEventDraft;
}

/** 按 display_name 解析本记录在席角色参与者：名字 → participant id。 */
async function resolveCharacterParticipants(
  client: PoolClient,
  workspaceId: string,
  recordId: string,
): Promise<Map<string, string>> {
  const result = await client.query<{ participant_id: string; display_name: string }>(
    `SELECT participant.id AS participant_id, definition.display_name
     FROM participants AS participant
     JOIN character_instances AS instance
       ON instance.workspace_id = participant.workspace_id
      AND instance.world_id = participant.world_id
      AND instance.worldline_id = participant.worldline_id
      AND instance.record_id = participant.record_id
      AND instance.id = participant.character_instance_id
     JOIN character_continuities AS continuity
       ON continuity.workspace_id = instance.workspace_id
      AND continuity.world_id = instance.world_id
      AND continuity.worldline_id = instance.worldline_id
      AND continuity.id = instance.continuity_id
     JOIN character_definitions AS definition
       ON definition.workspace_id = continuity.workspace_id
      AND definition.id = continuity.definition_id
     WHERE participant.workspace_id = $1
       AND participant.record_id = $2
       AND participant.participant_kind = 'character'
     ORDER BY participant.speaking_order ASC`,
    [workspaceId, recordId],
  );
  const byName = new Map<string, string>();
  for (const row of result.rows) {
    if (!byName.has(row.display_name)) byName.set(row.display_name, row.participant_id);
  }
  return byName;
}

function sceneSegments(scene: FirstNightPack["scene"]): FirstNightSegment[] {
  const segments: FirstNightSegment[] = [];
  if (scene.environment.trim()) {
    segments.push({
      id: "environment-1",
      kind: "environment",
      content: scene.environment.trim(),
      speechMode: "narrator",
    });
  }
  if (scene.story.trim()) {
    segments.push({ id: "story-1", kind: "story", content: scene.story.trim(), speechMode: "narrator" });
  }
  if (scene.fact.trim()) {
    segments.push({ id: "fact-1", kind: "fact", content: scene.fact.trim(), speechMode: "narrator" });
  }
  return segments;
}

/** 角色发声段：action（旁白声）+ dialogue（角色声），与回合内语义输出同型。 */
function characterSegments(character: FirstNightPack["characters"][number]): FirstNightSegment[] {
  const segments: FirstNightSegment[] = [];
  if (character.action.trim()) {
    segments.push({
      id: "action-1",
      kind: "action",
      content: character.action.trim(),
      speechMode: "narrator",
    });
  }
  segments.push({
    id: "dialogue-1",
    kind: "dialogue",
    content: character.utterance.trim(),
    speechMode: "speaker",
  });
  return segments;
}

async function insertFirstNightEvent(
  client: PoolClient,
  write: FirstNightEventWrite,
): Promise<string> {
  const { segments } = write.write;
  const eventId = `event_${randomUUID().replaceAll("-", "").slice(0, 18)}`;
  const content = segments.map((segment) => segment.content).join("\n");
  await client.query(
    `INSERT INTO events (
       workspace_id, world_id, worldline_id, record_id, scene_id, id,
       record_version, record_ordinal, batch_index, event_kind,
       actor_participant_id, speaker_name, content, payload,
       visibility_policy_id, world_tick, world_ordinal, calendar_id,
       display_time, recorded_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
       $11, $12, $13, $14::jsonb, $15, $16, $17, $18, $19,
       CURRENT_TIMESTAMP
     )`,
    [
      write.workspaceId,
      write.worldId,
      write.worldlineId,
      write.recordId,
      write.sceneId,
      eventId,
      write.recordVersion,
      write.recordOrdinal,
      write.batchIndex,
      write.write.eventKind,
      write.write.actorParticipantId,
      write.write.speakerName,
      content,
      JSON.stringify({
        presentation: {
          schemaVersion: 1,
          segments: segments.map((segment) => ({
            id: segment.id,
            kind: segment.kind,
            content: segment.content,
            speechMode: segment.speechMode,
          })),
        },
        ...(write.write.metadata ? { metadata: write.write.metadata } : {}),
      }),
      write.policyId,
      write.worldTick,
      write.worldOrdinal,
      write.calendarId,
      write.displayTime,
    ],
  );
  return eventId;
}
