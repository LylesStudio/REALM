import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  SCENE_CRYSTALLIZATION_PROMPT_VERSION,
  type SceneDelta,
} from "../../modules/application/scene-crystallization.ts";
import {
  fallbackSemanticSegments,
  semanticPresentation,
} from "../../modules/presentation/semantic-segments.ts";
import {
  normalizeWorldStyle,
  worldStyleText,
  type WorldStyle,
} from "../../modules/style/world-style.ts";
import {
  withWorkspaceTransaction,
  type WorkspaceDatabase,
} from "./workspace-transaction.ts";
import { gateRecordActive, gateWorldWrite } from "./world-write-gate.ts";

/**
 * 设定结晶写回仓储：仅裁决通过的增量落库（append-oriented），
 * 裁决拒绝写入 semantic_conflict_evaluations 审计。规范见
 * docs/development/SCENE-CRYSTALLIZATION.md。
 */

export interface SceneCrystallizationScope {
  workspaceId: string;
  worldId: string;
  worldlineId: string;
  recordId: string;
  calendarId: string;
  publicPolicyId: string;
  /** 世界文风（缺省 modern）：结晶事件措辞按风格模板产出。 */
  style?: WorldStyle;
}

export interface SceneRejectionAudit {
  workspaceId: string;
  model: string;
  playerText: string;
  turnSummary: string;
  delta: SceneDelta;
  reason: string;
}

export interface SceneCrystallizationStore {
  /**
   * 落库裁决通过的增量；返回结晶事件 id 与世界游标（批次 T9：
   * 晶化入图谱的来源证据）。
   */
  applyDelta(
    scope: SceneCrystallizationScope,
    delta: SceneDelta,
  ): Promise<{ eventId: string; tick: number; ordinal: number }>;
  recordRejection(audit: SceneRejectionAudit): Promise<void>;
}

export function sceneCrystallizationDigest(input: {
  playerText: string;
  turnSummary: string;
  delta: SceneDelta;
}): string {
  return createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex");
}

function sceneId(): string {
  return `scene_${randomUUID().replaceAll("-", "").slice(0, 18)}`;
}

function eventId(): string {
  return `event_scene_${randomUUID().replaceAll("-", "").slice(0, 18)}`;
}

function auditId(): string {
  return `sceval_${randomUUID().replaceAll("-", "").slice(0, 18)}`;
}

/** 把结晶增量写成一条时间线可读的事实摘要（措辞按世界文风模板）。 */
export function composeCrystallizationContent(
  delta: SceneDelta,
  style: WorldStyle = normalizeWorldStyle(undefined),
): string {
  const parts = [
    delta.location
      ? worldStyleText("scene.crystallize.location", style, { value: delta.location })
      : "",
    delta.weather
      ? worldStyleText("scene.crystallize.weather", style, { value: delta.weather })
      : "",
    delta.tension
      ? worldStyleText("scene.crystallize.tension", style, { value: delta.tension })
      : "",
    delta.displayTime
      ? worldStyleText("scene.crystallize.time", style, { value: delta.displayTime })
      : "",
    delta.objective
      ? worldStyleText("scene.crystallize.objective", style, { value: delta.objective })
      : "",
  ].filter((part) => part.length > 0);
  return `${worldStyleText("scene.crystallize.prefix", style)}${parts.join("；")}`;
}

export function createPostgresSceneCrystallizationStore(
  database: WorkspaceDatabase,
): SceneCrystallizationStore {
  return {
    async applyDelta(scope, delta) {
      return withWorkspaceTransaction(
        database,
        scope.workspaceId,
        async (client) => {
          // v37 §D.0/§E.1：统一锁序 worlds(KEY SHARE)→records(FOR UPDATE)
          // →record_heads→worldlines；archived 世界/记录在此拒绝（C 面）。
          await gateWorldWrite(client, {
            workspaceId: scope.workspaceId,
            worldId: scope.worldId,
          });
          await gateRecordActive(client, {
            workspaceId: scope.workspaceId,
            recordId: scope.recordId,
          });
          const head = await client.query<{
            record_version: string;
            next_record_ordinal: string;
            last_world_tick: string;
            last_world_ordinal: string;
          }>(
            `SELECT record_version::text, next_record_ordinal::text,
                    last_world_tick::text, last_world_ordinal::text
             FROM record_heads
             WHERE workspace_id = $1 AND record_id = $2
             FOR UPDATE`,
            [scope.workspaceId, scope.recordId],
          );
          const headRow = head.rows[0];
          if (!headRow) throw new Error("Record head is missing.");
          const tick = BigInt(headRow.last_world_tick);
          const ordinal = BigInt(headRow.last_world_ordinal) + BigInt(1);

          const currentScene = await client.query<{
            id: string;
            location: string;
            tension: string;
            objective: string;
            weather: string;
            display_time: string;
          }>(
            `SELECT scene.id, scene.location, scene.objective,
                    COALESCE(to_jsonb(scene)->>'tension', world.settings->>'tension', '') AS tension,
                    COALESCE(to_jsonb(scene)->>'weather', '') AS weather,
                    COALESCE(to_jsonb(scene)->>'display_time', '') AS display_time
             FROM scenes AS scene
             JOIN worlds AS world
               ON world.workspace_id = scene.workspace_id
              AND world.id = scene.world_id
             WHERE scene.workspace_id = $1 AND scene.record_id = $2
               AND (scene.start_tick, scene.start_ordinal) <= ($3::bigint, $4::bigint)
             ORDER BY scene.start_tick DESC, scene.start_ordinal DESC, scene.id ASC
             LIMIT 1`,
            [scope.workspaceId, scope.recordId, tick.toString(), (ordinal - BigInt(1)).toString()],
          );
          const current = currentScene.rows[0];

          // 场景流转：地点/目标/局势/天气/世界时间任一变化时追加新 scene
          // 行（T12 验收修正：weather/displayTime 单独变化也必须产生快照），
          // 未变字段继承当前 scene 快照。
          let activeSceneId = current?.id ?? null;
          const locationChanged = delta.location !== undefined
            && delta.location !== (current?.location ?? "");
          const objectiveChanged = delta.objective !== undefined
            && delta.objective !== (current?.objective ?? "");
          const tensionChanged = delta.tension !== undefined
            && delta.tension !== (current?.tension ?? "");
          const weatherChanged = delta.weather !== undefined
            && delta.weather !== (current?.weather ?? "");
          const displayTimeChanged = delta.displayTime !== undefined
            && delta.displayTime !== (current?.display_time ?? "");
          if (locationChanged || objectiveChanged || tensionChanged
            || weatherChanged || displayTimeChanged || !current) {
            activeSceneId = sceneId();
            // 批次 T12：scene weather/display_time 快照——落本流转生效后的
            // 值（delta 优先，其次当前 scene 快照，最后既有 settings）。
            const sceneWeather = delta.weather
              ?? (current?.weather || null)
              ?? (await client.query<{ weather: string }>(
                `SELECT COALESCE(settings->>'weather', '') AS weather
                 FROM worlds WHERE workspace_id = $1 AND id = $2`,
                [scope.workspaceId, scope.worldId],
              )).rows[0]?.weather
              ?? "";
            const sceneDisplayTime = delta.displayTime
              ?? (current?.display_time || null)
              ?? (await client.query<{ display_time: string }>(
                `SELECT COALESCE(settings->>'displayTime', '') AS display_time
                 FROM worlds WHERE workspace_id = $1 AND id = $2`,
                [scope.workspaceId, scope.worldId],
              )).rows[0]?.display_time
              ?? "";
            await client.query(
              `INSERT INTO scenes (
                 workspace_id, world_id, worldline_id, record_id, id, title,
                 status, location, objective, tension, weather, display_time,
                 start_tick, start_ordinal
               ) VALUES ($1, $2, $3, $4, $5, '场景流转', 'active', $6, $7, $8, $9, $10, $11, $12)`,
              [
                scope.workspaceId,
                scope.worldId,
                scope.worldlineId,
                scope.recordId,
                activeSceneId,
                delta.location ?? current?.location ?? "",
                delta.objective ?? current?.objective ?? "",
                delta.tension ?? current?.tension ?? "",
                sceneWeather,
                sceneDisplayTime,
                tick.toString(),
                ordinal.toString(),
              ],
            );
          }

          // 世界状态：只合入世界级字段（worlds.settings 仅作 legacy 回退与
          // 世界级「最新已知」；有快照的 Record 永远不读它，故源 Record 推进
          // 不会污染重演或其他有快照的 Record）。
          const worldPatch: Record<string, string> = {};
          if (delta.displayTime) worldPatch.displayTime = delta.displayTime;
          if (delta.weather) worldPatch.weather = delta.weather;
          // 事件世界时间：delta 优先，其次当前 scene 快照（Record 级隔离），
          // 最后才是共享 settings（legacy 兼容）。
          let displayTime = delta.displayTime
            ?? (current?.display_time || "");
          if (Object.keys(worldPatch).length > 0) {
            const updated = await client.query<{ settings: Record<string, unknown> }>(
              `UPDATE worlds
               SET settings = settings || $3::jsonb
               WHERE workspace_id = $1 AND id = $2
               RETURNING settings`,
              [scope.workspaceId, scope.worldId, JSON.stringify(worldPatch)],
            );
            const merged = updated.rows[0]?.settings ?? {};
            if (!displayTime && typeof merged.displayTime === "string") {
              displayTime = merged.displayTime;
            }
          } else if (!displayTime) {
            const world = await client.query<{ display_time: string }>(
              `SELECT COALESCE(settings->>'displayTime', '') AS display_time
               FROM worlds WHERE workspace_id = $1 AND id = $2`,
              [scope.workspaceId, scope.worldId],
            );
            displayTime = world.rows[0]?.display_time ?? "";
          }

          // 时间线留痕：system 事件 + 游标推进（与回合提交同一组不变量）。
          const style = scope.style ?? normalizeWorldStyle(undefined);
          const content = composeCrystallizationContent(delta, style);
          const newEventId = eventId();
          const recordVersion = BigInt(headRow.record_version) + BigInt(1);
          const recordOrdinal = BigInt(headRow.next_record_ordinal);
          await client.query(
            `INSERT INTO events (
               workspace_id, world_id, worldline_id, record_id, scene_id, id,
               record_version, record_ordinal, batch_index, event_kind,
               actor_participant_id, speaker_name, content, payload,
               visibility_policy_id, world_tick, world_ordinal, calendar_id,
               display_time, causation_command_id, turn_run_id, recorded_at
             ) VALUES (
               $1, $2, $3, $4, $5, $6,
               $7, $8, 0, 'system.correction.committed',
               NULL, $16, $9, $10::jsonb,
               $11, $12, $13, $14,
               $15, NULL, NULL, CURRENT_TIMESTAMP
             )`,
            [
              scope.workspaceId,
              scope.worldId,
              scope.worldlineId,
              scope.recordId,
              activeSceneId,
              newEventId,
              recordVersion.toString(),
              recordOrdinal.toString(),
              content,
              JSON.stringify({
                schemaVersion: 1,
                presentation: semanticPresentation(
                  fallbackSemanticSegments(content, "fact"),
                ),
              }),
              scope.publicPolicyId,
              tick.toString(),
              ordinal.toString(),
              scope.calendarId,
              displayTime,
              worldStyleText("scene.crystallize.speaker", style),
            ],
          );
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
              scope.workspaceId,
              scope.recordId,
              recordVersion.toString(),
              (recordOrdinal + BigInt(1)).toString(),
              newEventId,
              tick.toString(),
              ordinal.toString(),
            ],
          );
          // v37 §E.1：head writer 统一显式 FOR UPDATE worldlines
          //（锁内重读，执行期补显式锁）。
          const worldlineHead = await client.query(
            `SELECT head_tick, head_ordinal
             FROM worldlines
             WHERE workspace_id = $1 AND id = $2
             FOR UPDATE`,
            [scope.workspaceId, scope.worldlineId],
          );
          if (!worldlineHead.rows[0]) throw new Error("Worldline is missing.");
          await client.query(
            `UPDATE worldlines
             SET head_tick = $3, head_ordinal = $4, updated_at = CURRENT_TIMESTAMP
             WHERE workspace_id = $1 AND id = $2`,
            [scope.workspaceId, scope.worldlineId, tick.toString(), ordinal.toString()],
          );
          return {
            eventId: newEventId,
            tick: Number(tick),
            ordinal: Number(ordinal),
          };
        },
      );
    },

    async recordRejection(audit) {
      return withWorkspaceTransaction(
        database,
        audit.workspaceId,
        async (client: PoolClient) => {
          await client.query(
            `INSERT INTO semantic_conflict_evaluations (
               workspace_id, id, source, model, prompt_version, input_digest, result
             ) VALUES ($1, $2, 'model', $3, $4, $5, $6::jsonb)`,
            [
              audit.workspaceId,
              auditId(),
              audit.model || "unknown",
              SCENE_CRYSTALLIZATION_PROMPT_VERSION,
              sceneCrystallizationDigest({
                playerText: audit.playerText,
                turnSummary: audit.turnSummary,
                delta: audit.delta,
              }),
              JSON.stringify({
                approved: false,
                reason: audit.reason,
                delta: audit.delta,
              }),
            ],
          );
        },
      );
    },
  };
}
