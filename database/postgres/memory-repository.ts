import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  extractMemoryKeywords,
  lexicalEmbedding,
  type CharacterMemoryRepository,
  type MemoryConclusion,
  type MemoryDelta,
  type MemoryRecall,
  type MemorySnapshot,
  type RelationshipState,
} from "../../modules/memory/public.ts";
import { withWorkspaceTransaction } from "./workspace-transaction.ts";
import { gateWorldWrite } from "./world-write-gate.ts";

interface ConsumerScope {
  continuityId: string;
  tick: number;
  ordinal: number;
}

async function resolveConsumerScope(
  client: PoolClient,
  input: {
    workspaceId: string;
    worldId: string;
    worldlineId: string;
    recordId: string;
    characterInstanceId: string;
  },
): Promise<ConsumerScope | null> {
  const scope = await client.query<{
    continuity_id: string;
    tick: string;
    ordinal: string;
  }>(`
    SELECT
      instance.continuity_id,
      worldline.head_tick::text AS tick,
      worldline.head_ordinal::text AS ordinal
    FROM character_instances AS instance
    JOIN worldlines AS worldline
      ON worldline.workspace_id = instance.workspace_id
     AND worldline.world_id = instance.world_id
     AND worldline.id = instance.worldline_id
    WHERE instance.workspace_id = $1
      AND instance.world_id = $2
      AND instance.worldline_id = $3
      AND instance.record_id = $4
      AND instance.id = $5
  `, [
    input.workspaceId,
    input.worldId,
    input.worldlineId,
    input.recordId,
    input.characterInstanceId,
  ]);
  const consumer = scope.rows[0];
  return consumer
    ? {
        continuityId: consumer.continuity_id,
        tick: Number(consumer.tick),
        ordinal: Number(consumer.ordinal),
      }
    : null;
}

export function createPostgresCharacterMemoryRepository(
  pool: Pool,
): CharacterMemoryRepository {
  return {
    async recallAuthorized(input) {
      // 批次 T2：召回退化为纯排序查询——READ ONLY 事务，绝不回写。
      return withWorkspaceTransaction(
        pool,
        input.workspaceId,
        async (client) => {
        const scope = await client.query<{
          continuity_id: string;
          tick: string;
          ordinal: string;
        }>(`
          SELECT
            instance.continuity_id,
            worldline.head_tick::text AS tick,
            worldline.head_ordinal::text AS ordinal
          FROM character_instances AS instance
          JOIN worldlines AS worldline
            ON worldline.workspace_id = instance.workspace_id
           AND worldline.world_id = instance.world_id
           AND worldline.id = instance.worldline_id
          WHERE instance.workspace_id = $1
            AND instance.world_id = $2
            AND instance.worldline_id = $3
            AND instance.record_id = $4
            AND instance.id = $5
        `, [
          input.workspaceId,
          input.worldId,
          input.worldlineId,
          input.recordId,
          input.characterInstanceId,
        ]);
        const consumer = scope.rows[0];
        if (!consumer) return [];
        const effectiveTick = Number(consumer.tick);
        const effectiveOrdinal = Number(consumer.ordinal);

        const result = await client.query<{
          id: string;
          observer_continuity_id: string;
          observed_entity_key: string;
          content: string;
          memory_kind: MemoryRecall["memoryKind"];
          fidelity: string;
          occurred_tick: string;
          occurred_ordinal: string;
          available_from_tick: string;
          available_from_ordinal: string;
          keywords: string[];
          keyword_score: string;
          vector_score: string;
          score: string;
        }>(`
          WITH ranked AS (
            SELECT
              memory.*,
              CASE WHEN cardinality($5::text[]) = 0 THEN 0::double precision ELSE (
                SELECT count(*)::double precision / cardinality($5::text[])
                FROM unnest(memory.keywords) AS keyword
                WHERE keyword = ANY($5::text[])
              ) END AS keyword_score,
              GREATEST(0::double precision, 1 - (memory.semantic_embedding <=> $6::vector))
                AS vector_score
            FROM memory_conclusions AS memory
            WHERE memory.workspace_id = $1
              AND memory.world_id = $2
              AND memory.worldline_id = $3
              AND memory.observer_continuity_id = $4
              AND memory.operation <> 'retract'
              AND (memory.available_from_tick, memory.available_from_ordinal)
                <= ($7::bigint, $8::bigint)
              AND NOT EXISTS (
                SELECT 1
                FROM memory_conclusions AS revision
                WHERE revision.workspace_id = memory.workspace_id
                  AND revision.world_id = memory.world_id
                  AND revision.worldline_id = memory.worldline_id
                  AND revision.observer_continuity_id = memory.observer_continuity_id
                  AND revision.supersedes_memory_id = memory.id
              )
          )
          SELECT
            ranked.*,
            (
              0.50 * keyword_score
              + 0.35 * vector_score
              + 0.10 * fidelity::double precision
              + 0.05 / (1 + GREATEST(0, $7::bigint - available_from_tick))
            ) AS score
          FROM ranked
          WHERE keyword_score > 0 OR vector_score > 0
          ORDER BY score DESC, available_from_tick DESC, available_from_ordinal DESC, id
          LIMIT $9
        `, [
          input.workspaceId,
          input.worldId,
          input.worldlineId,
          consumer.continuity_id,
          input.keywords,
          vectorLiteral(input.embedding),
          effectiveTick,
          effectiveOrdinal,
          input.limit ?? 6,
        ]);
        return dedupeByContent(result.rows.map((row): MemoryRecall => ({
          id: row.id,
          observerContinuityId: row.observer_continuity_id,
          observedEntityKey: row.observed_entity_key,
          content: row.content,
          memoryKind: row.memory_kind,
          fidelity: Number(row.fidelity),
          occurred: { tick: Number(row.occurred_tick), ordinal: Number(row.occurred_ordinal) },
          availableFrom: {
            tick: Number(row.available_from_tick),
            ordinal: Number(row.available_from_ordinal),
          },
          keywords: row.keywords,
          keywordScore: Number(row.keyword_score),
          vectorScore: Number(row.vector_score),
          score: Number(row.score),
        })));
        },
        { readOnly: true },
      );
    },

    async extractAuthorized(input) {
      return withWorkspaceTransaction(pool, input.workspaceId, async (client) => {
        // 批次 T2 sync_turn：集合式物化该 record 内尚未物化的 observations。
        // 幂等由唯一约束 (workspace_id, observer_continuity_id,
        // source_record_id, source_observation_id) + DO NOTHING 保证。
        const pending = await client.query<{
          continuity_id: string;
          record_id: string;
          id: string;
          content: string;
          fidelity: string;
          observation_kind: string;
          occurred_tick: string;
          occurred_ordinal: string;
          available_from_tick: string;
          available_from_ordinal: string;
        }>(`
          SELECT
            source_instance.continuity_id,
            observation.record_id,
            observation.id,
            observation.content,
            observation.fidelity::text,
            observation.observation_kind,
            observation.occurred_tick::text,
            observation.occurred_ordinal::text,
            observation.available_from_tick::text,
            observation.available_from_ordinal::text
          FROM observations AS observation
          JOIN character_instances AS source_instance
            ON source_instance.workspace_id = observation.workspace_id
           AND source_instance.world_id = observation.world_id
           AND source_instance.worldline_id = observation.worldline_id
           AND source_instance.record_id = observation.record_id
           AND source_instance.id = observation.observer_character_instance_id
          WHERE observation.workspace_id = $1
            AND observation.world_id = $2
            AND observation.worldline_id = $3
            AND observation.record_id = $4
            AND NOT EXISTS (
              SELECT 1
              FROM memory_conclusions AS existing
              WHERE existing.workspace_id = observation.workspace_id
                AND existing.observer_continuity_id = source_instance.continuity_id
                AND existing.source_record_id = observation.record_id
                AND existing.source_observation_id = observation.id
            )
          ORDER BY observation.available_from_tick, observation.available_from_ordinal
        `, [
          input.workspaceId,
          input.worldId,
          input.worldlineId,
          input.recordId,
        ]);
        let materialized = 0;
        for (const observation of pending.rows) {
          const keywords = extractMemoryKeywords(observation.content);
          const embedding = lexicalEmbedding(observation.content);
          const memoryId = `mem_${createHash("sha256")
            .update(`${observation.continuity_id}:${observation.record_id}:${observation.id}`)
            .digest("hex").slice(0, 32)}`;
          const inserted = await client.query(`
            INSERT INTO memory_conclusions (
              workspace_id,
              world_id,
              worldline_id,
              observer_continuity_id,
              observed_entity_key,
              source_record_id,
              source_observation_id,
              id,
              operation,
              memory_kind,
              content,
              keywords,
              semantic_embedding,
              embedding_model,
              fidelity,
              occurred_tick,
              occurred_ordinal,
              available_from_tick,
              available_from_ordinal,
              metadata
            ) VALUES (
              $1, $2, $3, $4, $4, $5, $6, $7,
              'add', 'explicit', $8, $9::text[], $10::vector, 'realm-lexical-v1',
              $11::numeric, $12::bigint, $13::bigint, $14::bigint, $15::bigint,
              jsonb_build_object('sourceObservationKind', $16::text)
            )
            ON CONFLICT (
              workspace_id,
              observer_continuity_id,
              source_record_id,
              source_observation_id
            ) DO NOTHING
          `, [
            input.workspaceId,
            input.worldId,
            input.worldlineId,
            observation.continuity_id,
            observation.record_id,
            observation.id,
            memoryId,
            observation.content,
            keywords,
            vectorLiteral(embedding),
            observation.fidelity,
            observation.occurred_tick,
            observation.occurred_ordinal,
            observation.available_from_tick,
            observation.available_from_ordinal,
            observation.observation_kind,
          ]);
          materialized += inserted.rowCount ?? 0;
        }
        return { materialized };
      });
    },

    async appendAuthorized(input) {
      return withWorkspaceTransaction(pool, input.workspaceId, async (client) => {
        // v37 §D.0：C 面——gateWorldWrite（worlds KEY SHARE + active，
        // 锁内重读）；archived 拒绝。
        await gateWorldWrite(client, {
          workspaceId: input.workspaceId,
          worldId: input.worldId,
        });
        const consumer = await resolveConsumerScope(client, input);
        if (!consumer) return;
        const operation = input.operation ?? "add";
        const memoryId = `mem_${createHash("sha256")
          .update([
            consumer.continuityId,
            input.observedEntityKey,
            input.memoryKind,
            input.content,
            operation,
            input.supersedesMemoryId ?? "",
          ].join(":"))
          .digest("hex").slice(0, 32)}`;
        await client.query(`
          INSERT INTO memory_conclusions (
            workspace_id,
            world_id,
            worldline_id,
            observer_continuity_id,
            observed_entity_key,
            supersedes_memory_id,
            id,
            operation,
            memory_kind,
            content,
            keywords,
            semantic_embedding,
            embedding_model,
            fidelity,
            occurred_tick,
            occurred_ordinal,
            available_from_tick,
            available_from_ordinal,
            metadata
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7,
            $8, $9, $10, $11::text[], $12::vector, $13,
            $14::numeric, $15::bigint, $16::bigint, $15::bigint, $16::bigint,
            $17::jsonb
          )
          ON CONFLICT (workspace_id, id) DO NOTHING
        `, [
          input.workspaceId,
          input.worldId,
          input.worldlineId,
          consumer.continuityId,
          input.observedEntityKey,
          input.supersedesMemoryId ?? null,
          memoryId,
          operation,
          input.memoryKind,
          input.content,
          input.keywords,
          vectorLiteral(input.embedding),
          input.embeddingModel,
          input.fidelity,
          consumer.tick,
          consumer.ordinal,
          JSON.stringify({
            ...(input.summaryScope ? { summaryScope: input.summaryScope } : {}),
            ...(input.summaryDomain ? { summaryDomain: input.summaryDomain } : {}),
          }),
        ]);
        if (operation !== "add") {
          // update/retract 改写历史解释：递进缓存代数，使旧快照失效。
          await client.query(`
            INSERT INTO memory_cache_epochs (
              workspace_id, observer_continuity_id, epoch
            ) VALUES ($1, $2, 1)
            ON CONFLICT (workspace_id, observer_continuity_id)
            DO UPDATE SET
              epoch = memory_cache_epochs.epoch + 1,
              updated_at = CURRENT_TIMESTAMP
          `, [input.workspaceId, consumer.continuityId]);
        }
      });
    },

    async upsertRelationshipAuthorized(input) {
      return withWorkspaceTransaction(pool, input.workspaceId, async (client) => {
        // v37 §D.0：C 面——gateWorldWrite；archived 拒绝。
        await gateWorldWrite(client, {
          workspaceId: input.workspaceId,
          worldId: input.worldId,
        });
        const consumer = await resolveConsumerScope(client, input);
        if (!consumer) return;
        await client.query(`
          INSERT INTO relationship_states (
            workspace_id,
            world_id,
            worldline_id,
            observer_continuity_id,
            target_entity_key,
            relation_kind,
            content,
            fidelity,
            source_record_id,
            occurred_tick,
            occurred_ordinal,
            available_from_tick,
            available_from_ordinal
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8::numeric, $9,
            $10::bigint, $11::bigint, $10::bigint, $11::bigint
          )
          ON CONFLICT (
            workspace_id,
            observer_continuity_id,
            target_entity_key,
            relation_kind
          ) DO UPDATE SET
            content = EXCLUDED.content,
            fidelity = EXCLUDED.fidelity,
            source_record_id = EXCLUDED.source_record_id,
            occurred_tick = EXCLUDED.occurred_tick,
            occurred_ordinal = EXCLUDED.occurred_ordinal,
            available_from_tick = EXCLUDED.available_from_tick,
            available_from_ordinal = EXCLUDED.available_from_ordinal,
            updated_at = CURRENT_TIMESTAMP
        `, [
          input.workspaceId,
          input.worldId,
          input.worldlineId,
          consumer.continuityId,
          input.targetEntityKey,
          input.relationKind,
          input.content,
          input.fidelity,
          input.recordId,
          consumer.tick,
          consumer.ordinal,
        ]);
      });
    },

    async relationshipsAuthorized(input) {
      return withWorkspaceTransaction(pool, input.workspaceId, async (client) => {
        const consumer = await resolveConsumerScope(client, input);
        if (!consumer) return [];
        const result = await client.query<{
          observer_continuity_id: string;
          target_entity_key: string;
          relation_kind: RelationshipState["relationKind"];
          content: string;
          fidelity: string;
          occurred_tick: string;
          occurred_ordinal: string;
          available_from_tick: string;
          available_from_ordinal: string;
          created_at: string;
          updated_at: string;
        }>(`
          SELECT
            observer_continuity_id,
            target_entity_key,
            relation_kind,
            content,
            fidelity::text,
            occurred_tick::text,
            occurred_ordinal::text,
            available_from_tick::text,
            available_from_ordinal::text,
            created_at::text,
            updated_at::text
          FROM relationship_states
          WHERE workspace_id = $1
            AND world_id = $2
            AND worldline_id = $3
            AND observer_continuity_id = $4
            AND (available_from_tick, available_from_ordinal)
              <= ($5::bigint, $6::bigint)
          ORDER BY updated_at DESC, target_entity_key, relation_kind
          LIMIT $7
        `, [
          input.workspaceId,
          input.worldId,
          input.worldlineId,
          consumer.continuityId,
          consumer.tick,
          consumer.ordinal,
          Math.min(Math.max(input.limit ?? 8, 1), 20),
        ]);
        return result.rows.map((row): RelationshipState => ({
          observerContinuityId: row.observer_continuity_id,
          targetEntityKey: row.target_entity_key,
          relationKind: row.relation_kind,
          content: row.content,
          fidelity: Number(row.fidelity),
          occurred: { tick: Number(row.occurred_tick), ordinal: Number(row.occurred_ordinal) },
          availableFrom: {
            tick: Number(row.available_from_tick),
            ordinal: Number(row.available_from_ordinal),
          },
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }));
      });
    },

    async createSnapshotAuthorized(input) {
      return withWorkspaceTransaction(pool, input.workspaceId, async (client) => {
        // v37 §D.0：C 面——gateWorldWrite；archived 拒绝。
        await gateWorldWrite(client, {
          workspaceId: input.workspaceId,
          worldId: input.worldId,
        });
        const consumer = await resolveConsumerScope(client, input);
        if (!consumer) return null;
        await client.query(`
          INSERT INTO memory_cache_epochs (
            workspace_id, observer_continuity_id, epoch
          ) VALUES ($1, $2, 0)
          ON CONFLICT (workspace_id, observer_continuity_id) DO NOTHING
        `, [input.workspaceId, consumer.continuityId]);
        const epochResult = await client.query<{ epoch: number }>(`
          SELECT epoch
          FROM memory_cache_epochs
          WHERE workspace_id = $1 AND observer_continuity_id = $2
        `, [input.workspaceId, consumer.continuityId]);
        const cacheEpoch = Number(epochResult.rows[0]?.epoch ?? 0);
        const inserted = await client.query<{ created_at: string }>(`
          INSERT INTO memory_snapshots (
            workspace_id,
            world_id,
            worldline_id,
            observer_continuity_id,
            id,
            snapshot_kind,
            content,
            item_ids,
            cursor_tick,
            cursor_ordinal,
            cache_epoch,
            token_count
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8::text[],
            $9::bigint, $10::bigint, $11, $12
          )
          RETURNING created_at::text
        `, [
          input.workspaceId,
          input.worldId,
          input.worldlineId,
          consumer.continuityId,
          input.snapshotId,
          input.snapshotKind,
          input.content,
          [...input.itemIds],
          consumer.tick,
          consumer.ordinal,
          cacheEpoch,
          input.tokenCount,
        ]);
        return {
          id: input.snapshotId,
          observerContinuityId: consumer.continuityId,
          snapshotKind: input.snapshotKind,
          content: input.content,
          itemIds: input.itemIds,
          cursor: { tick: consumer.tick, ordinal: consumer.ordinal },
          cacheEpoch,
          tokenCount: input.tokenCount,
          createdAt: inserted.rows[0]?.created_at ?? new Date().toISOString(),
        } satisfies MemorySnapshot;
      });
    },

    async deltaAuthorized(input) {
      return withWorkspaceTransaction(pool, input.workspaceId, async (client) => {
        const consumer = await resolveConsumerScope(client, input);
        if (!consumer) return null;
        const snapshotResult = await client.query<{
          cache_epoch: number;
          cursor_tick: string;
          cursor_ordinal: string;
        }>(`
          SELECT
            cache_epoch,
            cursor_tick::text,
            cursor_ordinal::text
          FROM memory_snapshots
          WHERE workspace_id = $1
            AND world_id = $2
            AND worldline_id = $3
            AND observer_continuity_id = $4
            AND id = $5
        `, [
          input.workspaceId,
          input.worldId,
          input.worldlineId,
          consumer.continuityId,
          input.snapshotId,
        ]);
        const snapshot = snapshotResult.rows[0];
        if (!snapshot) return null;
        const epochResult = await client.query<{ epoch: number }>(`
          SELECT epoch
          FROM memory_cache_epochs
          WHERE workspace_id = $1 AND observer_continuity_id = $2
        `, [input.workspaceId, consumer.continuityId]);
        const currentEpoch = Number(epochResult.rows[0]?.epoch ?? 0);
        if (currentEpoch !== Number(snapshot.cache_epoch)) {
          return { stale: true, cacheEpoch: currentEpoch, items: [] } satisfies MemoryDelta;
        }
        const snapshotTick = Number(snapshot.cursor_tick);
        const snapshotOrdinal = Number(snapshot.cursor_ordinal);
        const items = await client.query<{
          id: string;
          observer_continuity_id: string;
          observed_entity_key: string;
          content: string;
          memory_kind: MemoryConclusion["memoryKind"];
          fidelity: string;
          occurred_tick: string;
          occurred_ordinal: string;
          available_from_tick: string;
          available_from_ordinal: string;
          keywords: string[];
        }>(`
          SELECT
            id,
            observer_continuity_id,
            observed_entity_key,
            content,
            memory_kind,
            fidelity::text,
            occurred_tick::text,
            occurred_ordinal::text,
            available_from_tick::text,
            available_from_ordinal::text,
            keywords
          FROM memory_conclusions AS memory
          WHERE memory.workspace_id = $1
            AND memory.world_id = $2
            AND memory.worldline_id = $3
            AND memory.observer_continuity_id = $4
            AND memory.operation <> 'retract'
            AND (memory.available_from_tick, memory.available_from_ordinal)
              > ($5::bigint, $6::bigint)
            AND (memory.available_from_tick, memory.available_from_ordinal)
              <= ($7::bigint, $8::bigint)
            AND NOT EXISTS (
              SELECT 1
              FROM memory_conclusions AS revision
              WHERE revision.workspace_id = memory.workspace_id
                AND revision.world_id = memory.world_id
                AND revision.worldline_id = memory.worldline_id
                AND revision.observer_continuity_id = memory.observer_continuity_id
                AND revision.supersedes_memory_id = memory.id
            )
          ORDER BY available_from_tick, available_from_ordinal, id
          LIMIT 50
        `, [
          input.workspaceId,
          input.worldId,
          input.worldlineId,
          consumer.continuityId,
          snapshotTick,
          snapshotOrdinal,
          consumer.tick,
          consumer.ordinal,
        ]);
        return {
          stale: false,
          cacheEpoch: currentEpoch,
          items: items.rows.map((row): MemoryConclusion => ({
            id: row.id,
            observerContinuityId: row.observer_continuity_id,
            observedEntityKey: row.observed_entity_key,
            content: row.content,
            memoryKind: row.memory_kind,
            fidelity: Number(row.fidelity),
            occurred: { tick: Number(row.occurred_tick), ordinal: Number(row.occurred_ordinal) },
            availableFrom: {
              tick: Number(row.available_from_tick),
              ordinal: Number(row.available_from_ordinal),
            },
            keywords: row.keywords,
          })),
        } satisfies MemoryDelta;
      });
    },

    async latestSummaryAuthorized(input) {
      return withWorkspaceTransaction(pool, input.workspaceId, async (client) => {
        const consumer = await resolveConsumerScope(client, input);
        if (!consumer) return null;
        const scope = input.summaryScope ?? "character";
        const rows = await client.query<{ id: string }>(
          `SELECT summary.id
           FROM memory_conclusions AS summary
           WHERE summary.workspace_id = $1
             AND summary.world_id = $2
             AND summary.worldline_id = $3
             AND summary.observer_continuity_id = $4
             AND summary.memory_kind = 'summary'
             AND summary.operation <> 'retract'
             AND summary.metadata->>'summaryScope' = $5
             AND ($6::text IS NULL
                  OR summary.metadata->>'summaryDomain' = $6)
             AND NOT EXISTS (
               SELECT 1
               FROM memory_conclusions AS revision
               WHERE revision.workspace_id = summary.workspace_id
                 AND revision.world_id = summary.world_id
                 AND revision.worldline_id = summary.worldline_id
                 AND revision.observer_continuity_id = summary.observer_continuity_id
                 AND revision.supersedes_memory_id = summary.id
             )
           ORDER BY summary.available_from_tick DESC,
                    summary.available_from_ordinal DESC,
                    summary.id
           LIMIT 1`,
          [
            input.workspaceId,
            input.worldId,
            input.worldlineId,
            consumer.continuityId,
            scope,
            input.summaryDomain ?? null,
          ],
        );
        return rows.rows[0] ?? null;
      });
    },
  };
}

function vectorLiteral(vector: readonly number[]): string {
  if (vector.length !== 384 || vector.some((value) => !Number.isFinite(value))) {
    throw new Error("Memory embedding must contain 384 finite values.");
  }
  return `[${vector.join(",")}]`;
}

/**
 * Recall results are ordered by relevance (score DESC), so when the same
 * content appears multiple times (repeated observations of identical text,
 * or a superseded summary that was not yet replaced), keep the first —
 * highest-scoring — occurrence. Exact-content dedupe is safe here because
 * the rows are already ACL/time-filtered and ranked.
 */
function dedupeByContent<T extends { content: string }>(rows: readonly T[]): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const row of rows) {
    if (seen.has(row.content)) continue;
    seen.add(row.content);
    unique.push(row);
  }
  return unique;
}
