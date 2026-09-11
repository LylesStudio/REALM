import type { Pool, PoolClient } from "pg";
import {
  mergePayloadKey,
  type MergeEventRef,
  type MergeAuditRow,
  type MergedTopologyInput,
  type WorldlineMergeRepository,
  type WorldlineMergeRow,
} from "../../modules/worldline/merge.ts";
import { withWorkspaceTransaction } from "./workspace-transaction.ts";
import { gateWorldWrite } from "./world-write-gate.ts";

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
      });
    },

    async listWorldlineEvents(scope) {
      return withWorkspaceTransaction(pool, scope.workspaceId, async (client) => {
        const result = await client.query(
          `SELECT
             id,
             record_id,
             worldline_id,
             world_tick::text,
             world_ordinal::text,
             speaker_name,
             payload
           FROM events
           WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
           ORDER BY world_tick, world_ordinal, id`,
          [scope.workspaceId, scope.worldId, scope.worldlineId],
        );
        return result.rows.map((row): MergeEventRef => ({
          eventId: row.id,
          recordId: row.record_id,
          worldlineId: row.worldline_id,
          tick: Number(row.world_tick),
          ordinal: Number(row.world_ordinal),
          speaker: row.speaker_name,
          payloadKey: mergePayloadKey(row.payload),
        }));
      });
    },

    async listWorldlineRecordTitles(scope) {
      return withWorkspaceTransaction(pool, scope.workspaceId, async (client) => {
        const result = await client.query(
          `SELECT id, title FROM records
           WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
           ORDER BY created_at, id`,
          [scope.workspaceId, scope.worldId, scope.worldlineId],
        );
        return result.rows.map((row) => ({
          id: row.id as string,
          title: row.title as string,
        }));
      });
    },

    async createMergedTopology(scope, input) {
      return withWorkspaceTransaction(pool, scope.workspaceId, async (client) => {
        // v37 §D.0：C 面——gateWorldWrite（worlds KEY SHARE + active）。
        await gateWorldWrite(client, {
          workspaceId: scope.workspaceId,
          worldId: scope.worldId,
        });
        await client.query(
          `INSERT INTO worldlines (
             workspace_id, world_id, id, label, status,
             head_tick, head_ordinal
           ) VALUES ($1, $2, $3, $4, 'active', $5, $6)`,
          [
            scope.workspaceId,
            scope.worldId,
            input.worldlineId,
            input.label,
            input.headTick,
            input.headOrdinal,
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
            input.worldlineId,
            input.storyId,
            input.storyTitle,
            "两条世界线的合并快照。",
          ],
        );
        for (const record of input.records) {
          await client.query(
            `INSERT INTO records (
               workspace_id, world_id, worldline_id, story_id, id, title,
               status, start_tick, start_ordinal, timeline_kind, linked_record_id
             ) VALUES ($1, $2, $3, $4, $5, $6, 'archived', 0, 0, 'merged', $7)`,
            [
              scope.workspaceId,
              scope.worldId,
              input.worldlineId,
              input.storyId,
              record.id,
              record.title,
              record.sourceRecordId,
            ],
          );
        }
      });
    },

    async createMergedTopologyAndAudit(scope, topology, row) {
      return withWorkspaceTransaction(pool, scope.workspaceId, async (client) => {
        // v37 §D.0：C 面——gateWorldWrite（worlds KEY SHARE + active）。
        await gateWorldWrite(client, {
          workspaceId: scope.workspaceId,
          worldId: scope.worldId,
        });
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
  input: MergedTopologyInput,
): Promise<void> {
  await client.query(
    `INSERT INTO worldlines (
       workspace_id, world_id, id, label, status,
       head_tick, head_ordinal
     ) VALUES ($1, $2, $3, $4, 'active', $5, $6)`,
    [
      scope.workspaceId,
      scope.worldId,
      input.worldlineId,
      input.label,
      input.headTick,
      input.headOrdinal,
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
      input.worldlineId,
      input.storyId,
      input.storyTitle,
      "两条世界线的合并快照。",
    ],
  );
  for (const record of input.records) {
    await client.query(
      `INSERT INTO records (
         workspace_id, world_id, worldline_id, story_id, id, title,
         status, start_tick, start_ordinal, timeline_kind, linked_record_id
       ) VALUES ($1, $2, $3, $4, $5, $6, 'archived', 0, 0, 'merged', $7)`,
      [
        scope.workspaceId,
        scope.worldId,
        input.worldlineId,
        input.storyId,
        record.id,
        record.title,
        record.sourceRecordId,
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
