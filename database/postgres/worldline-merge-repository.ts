import type { Pool, PoolClient } from "pg";
import {
  mergePayloadKey,
  WorldlineMergeSourceChangedError,
  type MergeAuditRow,
  type MergeSourceSnapshot,
  type MergeTopologyPlan,
  type MergeUnsupportedReason,
  type WorldlineMergeRepository,
  type WorldlineMergeRow,
} from "../../modules/worldline/merge.ts";
import { withWorkspaceTransaction } from "./workspace-transaction.ts";
import { gateWorldWrite } from "./world-write-gate.ts";

/**
 * 合并物化写路径（M5 reconciliation vertical slice）：
 * 目标 Worldline/Story/Record/record_heads 是 active/playable 的真实拓扑；
 * 事件实际复制到目标 scope，全部外键（scene/visibility policy/actor
 * participant/character instance/continuity）已重映射到目标 ID，源行不变。
 * 拓扑与审计行在同一 workspace 事务内提交；任何约束/权限故障整体回滚。
 */
export function createPostgresWorldlineMergeRepository(
  pool: Pool,
): WorldlineMergeRepository {
  return {
    async findMergeByIdempotencyKey(workspaceId, key) {
      return withWorkspaceTransaction(pool, workspaceId, async (client) => {
        const result = await client.query(
          `SELECT *, created_at::text FROM worldline_merges
           WHERE workspace_id = $1 AND idempotency_key = $2`,
          [workspaceId, key],
        );
        return result.rows[0] ? mapMergeRow(result.rows[0]) : null;
      });
    },

    async insertMerge(scope, row) {
      return withWorkspaceTransaction(pool, scope.workspaceId, async (client) => {
        // v37 §D.0：C 面——gateWorldWrite（worlds KEY SHARE + active）。
        await gateWorldWrite(client, {
          workspaceId: scope.workspaceId,
          worldId: scope.worldId,
        });
        await insertMergeAudit(client, scope, row);
      });
    },

    async loadMergeSource(scope) {
      return withWorkspaceTransaction(pool, scope.workspaceId, async (client) => {
        const records = await client.query(
          `SELECT id, title, status, world_version
           FROM records
           WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
           ORDER BY created_at, id`,
          [scope.workspaceId, scope.worldId, scope.worldlineId],
        );
        const recordIds = records.rows.map((row) => row.id as string);

        const empty: MergeSourceSnapshot = {
          worldlineId: scope.worldlineId,
          records: [],
          continuities: [],
          scenes: [],
          instances: [],
          participants: [],
          visibilityPolicies: [],
          skills: [],
          assets: [],
          actionReceipts: [],
          characterEffects: [],
          observations: [],
          events: [],
        };
        if (recordIds.length === 0) return empty;

        const recordScope = [
          scope.workspaceId,
          scope.worldId,
          scope.worldlineId,
          recordIds,
        ];
        const [
          continuities,
          scenes,
          instances,
          participants,
          policies,
          skills,
          assets,
          actionReceipts,
          characterEffects,
          observations,
          events,
          unsupported,
        ] = await Promise.all([
          client.query(
            `SELECT id, definition_id, continuity_key, status,
                    born_tick::text, born_ordinal::text,
                    ended_tick::text, ended_ordinal::text
             FROM character_continuities
             WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
             ORDER BY created_at, id`,
            [scope.workspaceId, scope.worldId, scope.worldlineId],
          ),
          client.query(
            `SELECT record_id, id, title, status, location, objective,
                    tension, weather, display_time,
                    start_tick::text, start_ordinal::text,
                    end_tick::text, end_ordinal::text
             FROM scenes
             WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
               AND record_id = ANY($4)
             ORDER BY record_id, start_tick, start_ordinal, id`,
            recordScope,
          ),
          client.query(
            `SELECT record_id, id, continuity_id, predecessor_instance_id,
                    controller_mode, status,
                    instantiated_tick::text, instantiated_ordinal::text,
                    inheritance_cutoff_tick::text, inheritance_cutoff_ordinal::text,
                    retired_tick::text, retired_ordinal::text, state
             FROM character_instances
             WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
               AND record_id = ANY($4)
             ORDER BY record_id, created_at, id`,
            recordScope,
          ),
          client.query(
            `SELECT record_id, id, participant_kind, character_instance_id,
                    principal_id, controller_mode, is_active, speaking_order,
                    shared_control_enabled
             FROM participants
             WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
               AND record_id = ANY($4)
             ORDER BY record_id, speaking_order, id`,
            recordScope,
          ),
          client.query(
            `SELECT record_id, id, policy_key, policy_version::text, policy_kind,
                    scene_id, restricted_domain_id, private_character_instance_id,
                    audience_character_instance_ids
             FROM visibility_policies
             WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
               AND record_id = ANY($4)
             ORDER BY record_id, policy_key, policy_version, id`,
            recordScope,
          ),
          client.query(
            `SELECT record_id, character_instance_id, skill_definition_id,
                    acquired_tick::text, acquired_ordinal::text, metadata
             FROM character_skills
             WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
               AND record_id = ANY($4)
             ORDER BY record_id, character_instance_id, skill_definition_id`,
            recordScope,
          ),
          client.query(
            `SELECT record_id, character_instance_id, asset_definition_id,
                    quantity::text, revision::text, metadata
             FROM character_assets
             WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
               AND record_id = ANY($4)
             ORDER BY record_id, character_instance_id, asset_definition_id`,
            recordScope,
          ),
          // Record 级运行态（本 slice 起随合并物化）：读取全列，目标
          // 写入时按重映射后的作用域 ID 落库；游标/载荷原样携带。
          client.query(
            `SELECT record_id, id, actor_character_instance_id, source_event_id,
                    transaction_id, call_fingerprint, receipt,
                    world_tick::text, world_ordinal::text, recorded_at::text
             FROM action_receipts
             WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
               AND record_id = ANY($4)
             ORDER BY record_id, world_tick, world_ordinal, id`,
            recordScope,
          ),
          // effect definition 是 World 级规则数据：读取时 JOIN 出
          // effect_key，目标写入前在目标 World 内按 key 重解析。
          client.query(
            `SELECT effect.record_id, effect.id, effect.character_instance_id,
                    definition.effect_key, effect.source_action_receipt_id,
                    effect.status,
                    effect.applied_tick::text, effect.applied_ordinal::text,
                    effect.ended_tick::text, effect.ended_ordinal::text,
                    effect.revision::text, effect.metadata
             FROM character_effects AS effect
             JOIN effect_definitions AS definition
               ON definition.workspace_id = effect.workspace_id
              AND definition.world_id = effect.world_id
              AND definition.id = effect.effect_definition_id
             WHERE effect.workspace_id = $1 AND effect.world_id = $2
               AND effect.worldline_id = $3 AND effect.record_id = ANY($4)
             ORDER BY effect.record_id, effect.applied_tick,
                      effect.applied_ordinal, effect.id`,
            recordScope,
          ),
          client.query(
            `SELECT record_id, id, observer_character_instance_id,
                    source_event_id, dedupe_key, observation_kind, content,
                    fidelity::text, occurred_tick::text, occurred_ordinal::text,
                    available_from_tick::text, available_from_ordinal::text,
                    learned_at::text, metadata
             FROM observations
             WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
               AND record_id = ANY($4)
             ORDER BY record_id, occurred_tick, occurred_ordinal, id`,
            recordScope,
          ),
          client.query(
            `SELECT record_id, id, record_version::text, record_ordinal::text,
                    batch_index, event_kind, actor_participant_id, speaker_name,
                    content, payload, visibility_policy_id, scene_id,
                    world_tick::text, world_ordinal::text, calendar_id, display_time
             FROM events
             WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
             ORDER BY world_tick, world_ordinal, id`,
            [scope.workspaceId, scope.worldId, scope.worldlineId],
          ),
          // 本 slice 不支持物化的 Record 级持久运行态探测（fail-closed）。
          client.query(
            `SELECT record_id, reason FROM (
               SELECT record_id, 'goal_instances' AS reason
               FROM goal_instances
               WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
               UNION ALL
               SELECT record_id, 'goal_assessment_jobs' AS reason
               FROM goal_assessment_jobs
               WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
               UNION ALL
               SELECT record_id, 'goal_assessments' AS reason
               FROM goal_assessments
               WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
               UNION ALL
               SELECT record_id, 'outbox' AS reason
               FROM outbox
               WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
               UNION ALL
               SELECT record_id, 'record_first_nights' AS reason
               FROM record_first_nights
               WHERE workspace_id = $1 AND world_id = $2 AND record_id = ANY($4)
               UNION ALL
               SELECT record_id, 'record_self_play_sessions' AS reason
               FROM record_self_play_sessions
               WHERE workspace_id = $1 AND world_id = $2 AND record_id = ANY($4)
               UNION ALL
               -- 统一 durable job 队列（0058，无 worldline 列，按 record
               -- 归属）：只有在途行（pending/claimed）不可安全重映射——
               -- 合并后它们会对源 Record 作用域触发，必须 fail-closed。
               SELECT record_id, 'durable_jobs' AS reason
               FROM realm_durable_jobs
               WHERE workspace_id = $1 AND record_id = ANY($4)
                 AND state IN ('pending', 'claimed')
               UNION ALL
               -- 记忆运行态以世界线为作用域（observer continuity）：任一
               -- 存在即归属到该世界线全部 Record（整体拒绝，报告全覆盖）。
               SELECT source_record.id, 'memory_conclusions'
               FROM records AS source_record
               WHERE source_record.workspace_id = $1
                 AND source_record.world_id = $2
                 AND source_record.worldline_id = $3
                 AND EXISTS (
                   SELECT 1 FROM memory_conclusions
                   WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
                 )
               UNION ALL
               SELECT source_record.id, 'memory_snapshots'
               FROM records AS source_record
               WHERE source_record.workspace_id = $1
                 AND source_record.world_id = $2
                 AND source_record.worldline_id = $3
                 AND EXISTS (
                   SELECT 1 FROM memory_snapshots
                   WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
                 )
               UNION ALL
               SELECT source_record.id, 'relationship_states'
               FROM records AS source_record
               WHERE source_record.workspace_id = $1
                 AND source_record.world_id = $2
                 AND source_record.worldline_id = $3
                 AND EXISTS (
                   SELECT 1 FROM relationship_states
                   WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
                 )
             ) AS unsupported
             ORDER BY record_id, reason`,
            recordScope,
          ),
        ]);

        const unsupportedByRecord = new Map<string, Set<MergeUnsupportedReason>>();
        for (const row of unsupported.rows) {
          const recordId = row.record_id as string;
          const reasons = unsupportedByRecord.get(recordId) ?? new Set();
          reasons.add(row.reason as MergeUnsupportedReason);
          unsupportedByRecord.set(recordId, reasons);
        }

        return {
          worldlineId: scope.worldlineId,
          records: records.rows.map((row) => ({
            id: row.id as string,
            title: row.title as string,
            status: row.status as string,
            worldVersion: row.world_version as string,
            unsupported: [...(unsupportedByRecord.get(row.id as string) ?? [])],
          })),
          continuities: continuities.rows.map((row) => ({
            id: row.id as string,
            definitionId: row.definition_id as string,
            continuityKey: row.continuity_key as string,
            status: row.status as string,
            bornTick: Number(row.born_tick),
            bornOrdinal: Number(row.born_ordinal),
            endedTick: row.ended_tick === null ? null : Number(row.ended_tick),
            endedOrdinal: row.ended_ordinal === null ? null : Number(row.ended_ordinal),
          })),
          scenes: scenes.rows.map((row) => ({
            id: row.id as string,
            recordId: row.record_id as string,
            title: row.title as string,
            status: row.status as string,
            location: row.location as string,
            objective: row.objective as string,
            tension: (row.tension as string | null) ?? "",
            weather: (row.weather as string | null) ?? "",
            displayTime: (row.display_time as string | null) ?? "",
            startTick: Number(row.start_tick),
            startOrdinal: Number(row.start_ordinal),
            endTick: row.end_tick === null ? null : Number(row.end_tick),
            endOrdinal: row.end_ordinal === null ? null : Number(row.end_ordinal),
          })),
          instances: instances.rows.map((row) => ({
            id: row.id as string,
            recordId: row.record_id as string,
            continuityId: row.continuity_id as string,
            predecessorInstanceId:
              (row.predecessor_instance_id as string | null) ?? null,
            controllerMode: row.controller_mode as string,
            status: row.status as string,
            instantiatedTick: Number(row.instantiated_tick),
            instantiatedOrdinal: Number(row.instantiated_ordinal),
            inheritanceCutoffTick: Number(row.inheritance_cutoff_tick),
            inheritanceCutoffOrdinal: Number(row.inheritance_cutoff_ordinal),
            retiredTick: row.retired_tick === null ? null : Number(row.retired_tick),
            retiredOrdinal:
              row.retired_ordinal === null ? null : Number(row.retired_ordinal),
            state: row.state,
          })),
          participants: participants.rows.map((row) => ({
            id: row.id as string,
            recordId: row.record_id as string,
            participantKind: row.participant_kind as "character" | "narrator",
            characterInstanceId:
              (row.character_instance_id as string | null) ?? null,
            principalId: (row.principal_id as string | null) ?? null,
            controllerMode: row.controller_mode as string,
            isActive: row.is_active as boolean,
            speakingOrder: Number(row.speaking_order),
            sharedControlEnabled: row.shared_control_enabled as boolean,
          })),
          visibilityPolicies: policies.rows.map((row) => ({
            id: row.id as string,
            recordId: row.record_id as string,
            policyKey: row.policy_key as string,
            policyVersion: Number(row.policy_version),
            policyKind: row.policy_kind as
              | "public"
              | "scene"
              | "restricted"
              | "private"
              | "dm_only",
            sceneId: (row.scene_id as string | null) ?? null,
            restrictedDomainId: (row.restricted_domain_id as string | null) ?? null,
            privateCharacterInstanceId:
              (row.private_character_instance_id as string | null) ?? null,
            audienceCharacterInstanceIds: [
              ...((row.audience_character_instance_ids as string[]) ?? []),
            ],
          })),
          skills: skills.rows.map((row) => ({
            recordId: row.record_id as string,
            characterInstanceId: row.character_instance_id as string,
            skillDefinitionId: row.skill_definition_id as string,
            acquiredTick: Number(row.acquired_tick),
            acquiredOrdinal: Number(row.acquired_ordinal),
            metadata: row.metadata,
          })),
          assets: assets.rows.map((row) => ({
            recordId: row.record_id as string,
            characterInstanceId: row.character_instance_id as string,
            assetDefinitionId: row.asset_definition_id as string,
            quantity: Number(row.quantity),
            revision: Number(row.revision),
            metadata: row.metadata,
          })),
          actionReceipts: actionReceipts.rows.map((row) => ({
            recordId: row.record_id as string,
            id: row.id as string,
            actorCharacterInstanceId: row.actor_character_instance_id as string,
            sourceEventId: row.source_event_id as string,
            transactionId: row.transaction_id as string,
            callFingerprint: row.call_fingerprint as string,
            receipt: row.receipt,
            worldTick: Number(row.world_tick),
            worldOrdinal: Number(row.world_ordinal),
            recordedAt: row.recorded_at as string,
          })),
          characterEffects: characterEffects.rows.map((row) => ({
            recordId: row.record_id as string,
            id: row.id as string,
            characterInstanceId: row.character_instance_id as string,
            effectKey: row.effect_key as string,
            sourceActionReceiptId: row.source_action_receipt_id as string,
            status: row.status as string,
            appliedTick: Number(row.applied_tick),
            appliedOrdinal: Number(row.applied_ordinal),
            endedTick: row.ended_tick === null ? null : Number(row.ended_tick),
            endedOrdinal:
              row.ended_ordinal === null ? null : Number(row.ended_ordinal),
            revision: Number(row.revision),
            metadata: row.metadata,
          })),
          observations: observations.rows.map((row) => ({
            recordId: row.record_id as string,
            id: row.id as string,
            observerCharacterInstanceId:
              row.observer_character_instance_id as string,
            sourceEventId: (row.source_event_id as string | null) ?? null,
            dedupeKey: row.dedupe_key as string,
            observationKind: row.observation_kind as string,
            content: row.content as string,
            fidelity: Number(row.fidelity),
            occurredTick: Number(row.occurred_tick),
            occurredOrdinal: Number(row.occurred_ordinal),
            availableFromTick: Number(row.available_from_tick),
            availableFromOrdinal: Number(row.available_from_ordinal),
            learnedAt: row.learned_at as string,
            metadata: row.metadata,
          })),
          events: events.rows.map((row) => ({
            eventId: row.id as string,
            recordId: row.record_id as string,
            worldlineId: scope.worldlineId,
            tick: Number(row.world_tick),
            ordinal: Number(row.world_ordinal),
            speaker: row.speaker_name as string,
            payloadKey: mergePayloadKey(row.payload),
            eventKind: row.event_kind as string,
            recordVersion: Number(row.record_version),
            recordOrdinal: Number(row.record_ordinal),
            batchIndex: Number(row.batch_index),
            actorParticipantId:
              (row.actor_participant_id as string | null) ?? null,
            content: row.content as string,
            payload: row.payload,
            sceneId: row.scene_id as string,
            visibilityPolicyId: row.visibility_policy_id as string,
            calendarId: row.calendar_id as string,
            displayTime: row.display_time as string,
          })),
        } satisfies MergeSourceSnapshot;
      });
    },

    async createMergedTopologyAndAudit(scope, topology, row) {
      return withWorkspaceTransaction(pool, scope.workspaceId, async (client) => {
        // v37 §D.0：C 面——gateWorldWrite（worlds KEY SHARE + active）。
        await gateWorldWrite(client, {
          workspaceId: scope.workspaceId,
          worldId: scope.worldId,
        });
        // 源防漂：FOR UPDATE 锁全部源 Record（与 commitRelease 的
        // records(FOR UPDATE) 互斥），重数事件指纹；漂移即回滚。
        const fingerprints = [...topology.sourceFingerprints].sort(
          (left, right) => left.recordId.localeCompare(right.recordId),
        );
        const sourceRecordIds = fingerprints.map((fingerprint) => fingerprint.recordId);
        if (sourceRecordIds.length > 0) {
          const locked = await client.query(
            `SELECT id FROM records
             WHERE workspace_id = $1 AND id = ANY($2)
             ORDER BY id
             FOR UPDATE`,
            [scope.workspaceId, sourceRecordIds],
          );
          if (locked.rows.length !== sourceRecordIds.length) {
            throw new WorldlineMergeSourceChangedError();
          }
          const counts = await client.query(
            `SELECT record_id,
                    count(*)::int AS event_count,
                    COALESCE(max(record_ordinal), 0)::int AS max_record_ordinal
             FROM events
             WHERE workspace_id = $1 AND record_id = ANY($2)
             GROUP BY record_id`,
            [scope.workspaceId, sourceRecordIds],
          );
          const countByRecord = new Map(
            counts.rows.map((count) => [
              count.record_id as string,
              {
                eventCount: Number(count.event_count),
                maxRecordOrdinal: Number(count.max_record_ordinal),
              },
            ]),
          );
          for (const fingerprint of fingerprints) {
            const current = countByRecord.get(fingerprint.recordId) ?? {
              eventCount: 0,
              maxRecordOrdinal: 0,
            };
            if (
              current.eventCount !== fingerprint.eventCount
              || current.maxRecordOrdinal !== fingerprint.maxRecordOrdinal
            ) {
              throw new WorldlineMergeSourceChangedError();
            }
          }
        }
        await insertMergedTopology(client, scope, topology);
        await insertMergeAudit(client, scope, row);
      });
    },

    async worldlineExists(scope) {
      return withWorkspaceTransaction(pool, scope.workspaceId, async (client) => {
        const result = await client.query(
          `SELECT 1 FROM worldlines
           WHERE workspace_id = $1 AND world_id = $2 AND id = $3`,
          [scope.workspaceId, scope.worldId, scope.worldlineId],
        );
        return result.rows.length > 0;
      });
    },
  };
}

async function insertMergeAudit(
  client: PoolClient,
  scope: { workspaceId: string; worldId: string },
  row: MergeAuditRow,
): Promise<void> {
  await client.query(
    `INSERT INTO worldline_merges (
       workspace_id, world_id, id, idempotency_key,
       source_worldline_a, source_worldline_b, merged_worldline_id,
       operator, status, conflict_report, manifest
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb)`,
    [
      scope.workspaceId,
      scope.worldId,
      row.id,
      row.idempotencyKey,
      row.sourceWorldlineA,
      row.sourceWorldlineB,
      row.mergedWorldlineId,
      row.operator,
      row.status,
      JSON.stringify(row.conflictReport),
      JSON.stringify(row.manifest),
    ],
  );
}

async function insertMergedTopology(
  client: PoolClient,
  scope: { workspaceId: string; worldId: string },
  plan: MergeTopologyPlan,
): Promise<void> {
  // 目标写入前 fail-closed：每条目标 character effect 必须在目标 World
  // 内解析到 effect definition（按 effect_key；定义是 World 级规则数据，
  // 不随合并复制）。缺失即抛错——整个 workspace 事务回滚，零残留。
  const effectDefinitionIds = new Map<string, string>();
  for (const record of plan.records) {
    for (const effect of record.characterEffects) {
      if (effectDefinitionIds.has(effect.effectKey)) continue;
      const definition = await client.query(
        `SELECT id
         FROM effect_definitions
         WHERE workspace_id = $1 AND world_id = $2 AND effect_key = $3`,
        [scope.workspaceId, scope.worldId, effect.effectKey],
      );
      const definitionId = definition.rows[0]?.id as string | undefined;
      if (!definitionId) {
        throw new Error(
          "Merge target World lacks a character effect definition.",
        );
      }
      effectDefinitionIds.set(effect.effectKey, definitionId);
    }
  }
  await client.query(
    `INSERT INTO worldlines (
       workspace_id, world_id, id, label, status,
       head_tick, head_ordinal
     ) VALUES ($1, $2, $3, $4, 'active', $5, $6)`,
    [
      scope.workspaceId,
      scope.worldId,
      plan.worldlineId,
      plan.label,
      plan.headTick,
      plan.headOrdinal,
    ],
  );
  await client.query(
    `INSERT INTO stories (
       workspace_id, world_id, worldline_id, id, title, status,
       premise, start_tick, start_ordinal
     ) VALUES ($1, $2, $3, $4, $5, 'active', $6, 0, 0)`,
    [
      scope.workspaceId,
      scope.worldId,
      plan.worldlineId,
      plan.storyId,
      plan.storyTitle,
      "两条世界线的合并快照。",
    ],
  );
  // 目标世界线级 continuity：定义是 world 级行（两源同世界）直接复用。
  for (const continuity of plan.continuities) {
    await client.query(
      `INSERT INTO character_continuities (
         workspace_id, world_id, worldline_id, definition_id, id,
         continuity_key, status, born_tick, born_ordinal, ended_tick, ended_ordinal
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        scope.workspaceId,
        scope.worldId,
        plan.worldlineId,
        continuity.definitionId,
        continuity.id,
        continuity.continuityKey,
        continuity.status,
        continuity.bornTick,
        continuity.bornOrdinal,
        continuity.endedTick,
        continuity.endedOrdinal,
      ],
    );
  }
  for (const record of plan.records) {
    await client.query(
      `INSERT INTO records (
         workspace_id, world_id, worldline_id, story_id, id, title,
         status, start_tick, start_ordinal, timeline_kind, linked_record_id,
         world_version
       ) VALUES ($1, $2, $3, $4, $5, $6, 'active', 0, 0, 'merged', $7, $8)`,
      [
        scope.workspaceId,
        scope.worldId,
        plan.worldlineId,
        plan.storyId,
        record.id,
        record.title,
        record.sourceRecordId,
        record.worldVersion,
      ],
    );
    await client.query(
      `INSERT INTO record_heads (
         workspace_id, world_id, worldline_id, record_id,
         record_version, next_record_ordinal
       ) VALUES ($1, $2, $3, $4, 0, 0)`,
      [scope.workspaceId, scope.worldId, plan.worldlineId, record.id],
    );
    // instances 已按 predecessor 依赖序排列（自引用 FK）。
    for (const instance of record.instances) {
      await client.query(
        `INSERT INTO character_instances (
           workspace_id, world_id, worldline_id, record_id, continuity_id,
           predecessor_instance_id, id, controller_mode, status,
           instantiated_tick, instantiated_ordinal, inheritance_cutoff_tick,
           inheritance_cutoff_ordinal, retired_tick, retired_ordinal, state
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb)`,
        [
          scope.workspaceId,
          scope.worldId,
          plan.worldlineId,
          record.id,
          instance.continuityId,
          instance.predecessorInstanceId,
          instance.id,
          instance.controllerMode,
          instance.status,
          instance.instantiatedTick,
          instance.instantiatedOrdinal,
          instance.inheritanceCutoffTick,
          instance.inheritanceCutoffOrdinal,
          instance.retiredTick,
          instance.retiredOrdinal,
          JSON.stringify(instance.state ?? {}),
        ],
      );
    }
    for (const participant of record.participants) {
      await client.query(
        `INSERT INTO participants (
           workspace_id, world_id, worldline_id, record_id, id,
           participant_kind, character_instance_id, principal_id,
           controller_mode, is_active, speaking_order, shared_control_enabled
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          scope.workspaceId,
          scope.worldId,
          plan.worldlineId,
          record.id,
          participant.id,
          participant.participantKind,
          participant.characterInstanceId,
          participant.principalId,
          participant.controllerMode,
          participant.isActive,
          participant.speakingOrder,
          participant.sharedControlEnabled,
        ],
      );
    }
    for (const scene of record.scenes) {
      await client.query(
        `INSERT INTO scenes (
           workspace_id, world_id, worldline_id, record_id, id, title,
           status, location, objective, tension, weather, display_time,
           start_tick, start_ordinal, end_tick, end_ordinal
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [
          scope.workspaceId,
          scope.worldId,
          plan.worldlineId,
          record.id,
          scene.id,
          scene.title,
          scene.status,
          scene.location,
          scene.objective,
          scene.tension,
          scene.weather,
          scene.displayTime,
          scene.startTick,
          scene.startOrdinal,
          scene.endTick,
          scene.endOrdinal,
        ],
      );
    }
    // visibility_policies 的 AFTER INSERT 触发器把 audience 数组归一化到
    // visibility_policy_audiences；事件的 audience guard 依赖该归一化，
    // 因此策略必须先于事件写入。
    for (const policy of record.visibilityPolicies) {
      await client.query(
        `INSERT INTO visibility_policies (
           workspace_id, world_id, worldline_id, record_id, id, policy_key,
           policy_version, policy_kind, scene_id, restricted_domain_id,
           private_character_instance_id, audience_character_instance_ids
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::text[])`,
        [
          scope.workspaceId,
          scope.worldId,
          plan.worldlineId,
          record.id,
          policy.id,
          policy.policyKey,
          policy.policyVersion,
          policy.policyKind,
          policy.sceneId,
          policy.restrictedDomainId,
          policy.privateCharacterInstanceId,
          [...policy.audienceCharacterInstanceIds],
        ],
      );
    }
    for (const skill of record.skills) {
      await client.query(
        `INSERT INTO character_skills (
           workspace_id, world_id, worldline_id, record_id,
           character_instance_id, skill_definition_id,
           acquired_tick, acquired_ordinal, metadata
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
        [
          scope.workspaceId,
          scope.worldId,
          plan.worldlineId,
          record.id,
          skill.characterInstanceId,
          skill.skillDefinitionId,
          skill.acquiredTick,
          skill.acquiredOrdinal,
          JSON.stringify(skill.metadata ?? {}),
        ],
      );
    }
    for (const asset of record.assets) {
      await client.query(
        `INSERT INTO character_assets (
           workspace_id, world_id, worldline_id, record_id,
           character_instance_id, asset_definition_id,
           quantity, revision, metadata
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
        [
          scope.workspaceId,
          scope.worldId,
          plan.worldlineId,
          record.id,
          asset.characterInstanceId,
          asset.assetDefinitionId,
          asset.quantity,
          asset.revision,
          JSON.stringify(asset.metadata ?? {}),
        ],
      );
    }
    for (const event of record.events) {
      await client.query(
        `INSERT INTO events (
           workspace_id, world_id, worldline_id, record_id, scene_id, id,
           record_version, record_ordinal, batch_index, event_kind,
           actor_participant_id, speaker_name, content, payload,
           visibility_policy_id, world_tick, world_ordinal, calendar_id,
           display_time, causation_command_id, turn_run_id, recorded_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                   $11, $12, $13, $14::jsonb, $15, $16, $17, $18, $19,
                   NULL, NULL, CURRENT_TIMESTAMP)`,
        [
          scope.workspaceId,
          scope.worldId,
          plan.worldlineId,
          record.id,
          event.sceneId,
          event.id,
          event.recordVersion,
          event.recordOrdinal,
          event.batchIndex,
          event.eventKind,
          event.actorParticipantId,
          event.speakerName,
          event.content,
          JSON.stringify(event.payload ?? {}),
          event.visibilityPolicyId,
          event.worldTick,
          event.worldOrdinal,
          event.calendarId,
          event.displayTime,
        ],
      );
    }
    // Record 级运行态物化（FK 依赖序：receipt → effect/observation）。
    // receipt 载荷逐字节复制（物化事实，绝不重掷）；全部作用域引用已在
    // 规划期重映射为目标 ID。
    for (const receipt of record.actionReceipts) {
      await client.query(
        `INSERT INTO action_receipts (
           workspace_id, world_id, worldline_id, record_id,
           actor_character_instance_id, source_event_id, id, transaction_id,
           call_fingerprint, receipt, world_tick, world_ordinal, recorded_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12,
           $13::timestamptz
         )`,
        [
          scope.workspaceId,
          scope.worldId,
          plan.worldlineId,
          record.id,
          receipt.actorCharacterInstanceId,
          receipt.sourceEventId,
          receipt.id,
          receipt.transactionId,
          receipt.callFingerprint,
          JSON.stringify(receipt.receipt ?? {}),
          receipt.worldTick,
          receipt.worldOrdinal,
          receipt.recordedAt,
        ],
      );
    }
    for (const effect of record.characterEffects) {
      // realm_runtime 的 INSERT 列授权不含 ended 游标：先按授权列插入，
      // 同事务内用 UPDATE 补写 ended 游标（UPDATE 列授权覆盖）。
      await client.query(
        `INSERT INTO character_effects (
           workspace_id, world_id, worldline_id, record_id,
           character_instance_id, effect_definition_id,
           source_action_receipt_id, id, status,
           applied_tick, applied_ordinal, revision, metadata
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb
         )`,
        [
          scope.workspaceId,
          scope.worldId,
          plan.worldlineId,
          record.id,
          effect.characterInstanceId,
          effectDefinitionIds.get(effect.effectKey)!,
          effect.sourceActionReceiptId,
          effect.id,
          effect.status,
          effect.appliedTick,
          effect.appliedOrdinal,
          effect.revision,
          JSON.stringify(effect.metadata ?? {}),
        ],
      );
      if (effect.endedTick !== null && effect.endedOrdinal !== null) {
        await client.query(
          `UPDATE character_effects
           SET ended_tick = $6, ended_ordinal = $7
           WHERE workspace_id = $1 AND id = $2
             AND world_id = $3 AND worldline_id = $4 AND record_id = $5`,
          [
            scope.workspaceId,
            effect.id,
            scope.worldId,
            plan.worldlineId,
            record.id,
            effect.endedTick,
            effect.endedOrdinal,
          ],
        );
      }
    }
    for (const observation of record.observations) {
      await client.query(
        `INSERT INTO observations (
           workspace_id, world_id, worldline_id, record_id,
           observer_character_instance_id, source_event_id, id,
           dedupe_key, observation_kind, content, fidelity,
           occurred_tick, occurred_ordinal,
           available_from_tick, available_from_ordinal, learned_at,
           metadata
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
           $12, $13, $14, $15, $16::timestamptz, $17::jsonb
         )`,
        [
          scope.workspaceId,
          scope.worldId,
          plan.worldlineId,
          record.id,
          observation.observerCharacterInstanceId,
          observation.sourceEventId,
          observation.id,
          observation.dedupeKey,
          observation.observationKind,
          observation.content,
          observation.fidelity,
          observation.occurredTick,
          observation.occurredOrdinal,
          observation.availableFromTick,
          observation.availableFromOrdinal,
          observation.learnedAt,
          JSON.stringify(observation.metadata ?? {}),
        ],
      );
    }
    await client.query(
      `UPDATE record_heads
       SET record_version = $5,
           next_record_ordinal = $6,
           last_event_id = $7,
           last_world_tick = $8,
           last_world_ordinal = $9,
           updated_at = CURRENT_TIMESTAMP
       WHERE workspace_id = $1 AND world_id = $2
         AND worldline_id = $3 AND record_id = $4`,
      [
        scope.workspaceId,
        scope.worldId,
        plan.worldlineId,
        record.id,
        record.head.recordVersion,
        record.head.nextRecordOrdinal,
        record.head.lastEventId,
        record.head.lastWorldTick,
        record.head.lastWorldOrdinal,
      ],
    );
  }
}

function mapMergeRow(row: Record<string, unknown>): WorldlineMergeRow {
  return {
    id: row.id as string,
    idempotencyKey: row.idempotency_key as string,
    sourceWorldlineA: row.source_worldline_a as string,
    sourceWorldlineB: row.source_worldline_b as string,
    mergedWorldlineId: (row.merged_worldline_id as string | null) ?? null,
    operator: row.operator as string,
    status: row.status as WorldlineMergeRow["status"],
    conflictReport: row.conflict_report,
    manifest: row.manifest as WorldlineMergeRow["manifest"],
    createdAt: row.created_at as string,
  };
}
