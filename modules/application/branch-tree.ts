import type { PoolClient } from "pg";
import {
  withWorkspaceTransaction,
  type WorkspaceDatabase,
} from "../../database/postgres/workspace-transaction.ts";

/**
 * 分支树只读投影（BRANCH-TREE-RESEARCH §三 P0）。
 *
 * canonical 骨架 = worldlines 的 parent_worldline_id + fork 游标谱系树；
 * stories/records 只作为挂在 worldline 上的组织/游玩单元摘要。
 * records.linked_record_id 与 worldline_merges 审计行是 overlay 来源关系，
 * 绝不污染树骨架；merged 占位 record 仅作只读 tombstone 透出。
 *
 * 权限：任一 membership 角色（owner/player/observer）可读；世界不存在或
 * 非成员 → null（调用方 404，不泄露存在性）。归档 record/worldline 以
 * tombstone 形式保留（status 字段显式表达），保证谱系完整；这与 Library
 * 列表排除归档记录的语义相互独立，不改变既有列表行为。
 */

export interface BranchTreeCursor {
  tick: number;
  ordinal: number;
}

export interface BranchTreeRecord {
  id: string;
  storyId: string;
  title: string;
  status: string;
  timelineKind: string;
  /** 分叉/重演/合并来源 record（overlay 边，非树骨架）。 */
  linkedRecordId: string | null;
  start: BranchTreeCursor;
  end: BranchTreeCursor | null;
  /** effective cursor = COALESCE(record_heads.last_world_*, record.start_*)。 */
  head: BranchTreeCursor;
}

export interface BranchTreeStory {
  id: string;
  title: string;
  status: string;
  start: BranchTreeCursor;
  end: BranchTreeCursor | null;
}

export interface BranchTreeWorldline {
  id: string;
  label: string;
  status: string;
  parentWorldlineId: string | null;
  /** 父线因果序上的分叉点；原初世界线为 null。 */
  fork: BranchTreeCursor | null;
  head: BranchTreeCursor;
  createdAt: string;
  stories: BranchTreeStory[];
  records: BranchTreeRecord[];
}

/** worldline merge 审计（overlay 边；merged 拓扑不可游玩）。 */
export interface BranchTreeMerge {
  id: string;
  sourceWorldlineA: string;
  sourceWorldlineB: string;
  mergedWorldlineId: string | null;
  status: string;
}

export interface BranchTree {
  world: { id: string; name: string; status: string };
  /** 调用方声明的当前 record（服务端校验其确属本世界，否则为 null）。 */
  currentRecordId: string | null;
  currentWorldlineId: string | null;
  worldlines: BranchTreeWorldline[];
  merges: BranchTreeMerge[];
}

/** bigint 由 pg 驱动按字符串返回；超 safe integer 必须 fail-closed。 */
function toCursor(tick: unknown, ordinal: unknown): BranchTreeCursor {
  const tickNumber = Number(tick);
  const ordinalNumber = Number(ordinal);
  if (
    !Number.isSafeInteger(tickNumber) || tickNumber < 0
    || !Number.isSafeInteger(ordinalNumber) || ordinalNumber < 0
  ) {
    throw new Error("branch tree cursor exceeds JavaScript safe integer range");
  }
  return { tick: tickNumber, ordinal: ordinalNumber };
}

function toNullableCursor(tick: unknown, ordinal: unknown): BranchTreeCursor | null {
  if (tick === null || tick === undefined || ordinal === null || ordinal === undefined) {
    return null;
  }
  return toCursor(tick, ordinal);
}

function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

async function loadWorldForMember(
  client: PoolClient,
  input: { workspaceId: string; principalId: string; worldId: string },
): Promise<{ name: string; status: string } | null> {
  const result = await client.query<{ name: string; status: string }>(
    `SELECT world.name, world.status
     FROM worlds AS world
     JOIN player_world_memberships AS membership
       ON membership.workspace_id = world.workspace_id
      AND membership.world_id = world.id
      AND membership.principal_id = $3
     WHERE world.workspace_id = $1 AND world.id = $2`,
    [input.workspaceId, input.worldId, input.principalId],
  );
  return result.rows[0] ?? null;
}

export async function loadBranchTree(
  database: WorkspaceDatabase,
  input: {
    workspaceId: string;
    principalId: string;
    worldId: string;
    /** 可选：调用方当前 record；仅当其确属本世界时回显为 current。 */
    currentRecordId?: string;
  },
): Promise<BranchTree | null> {
  return withWorkspaceTransaction(
    database,
    input.workspaceId,
    async (client) => {
      const world = await loadWorldForMember(client, input);
      if (!world) return null;

      const worldlineRows = await client.query<{
        id: string;
        label: string;
        status: string;
        parent_worldline_id: string | null;
        fork_tick: string | null;
        fork_ordinal: string | null;
        head_tick: string;
        head_ordinal: string;
        created_at: Date | string;
      }>(
        `SELECT id, label, status, parent_worldline_id,
                fork_tick::text, fork_ordinal::text,
                head_tick::text, head_ordinal::text, created_at
         FROM worldlines
         WHERE workspace_id = $1 AND world_id = $2
         ORDER BY created_at ASC, id ASC`,
        [input.workspaceId, input.worldId],
      );

      const storyRows = await client.query<{
        id: string;
        worldline_id: string;
        title: string;
        status: string;
        start_tick: string;
        start_ordinal: string;
        end_tick: string | null;
        end_ordinal: string | null;
      }>(
        `SELECT id, worldline_id, title, status,
                start_tick::text, start_ordinal::text,
                end_tick::text, end_ordinal::text
         FROM stories
         WHERE workspace_id = $1 AND world_id = $2
         ORDER BY start_tick ASC, start_ordinal ASC, created_at ASC, id ASC`,
        [input.workspaceId, input.worldId],
      );

      // 归档 record 以 tombstone 保留（谱系完整性）；effective cursor 与
      // record-scope.ts:152-153 同形（COALESCE(head, start)）。
      const recordRows = await client.query<{
        id: string;
        worldline_id: string;
        story_id: string;
        title: string;
        status: string;
        timeline_kind: string;
        linked_record_id: string | null;
        start_tick: string;
        start_ordinal: string;
        end_tick: string | null;
        end_ordinal: string | null;
        head_tick: string;
        head_ordinal: string;
      }>(
        `SELECT record.id, record.worldline_id, record.story_id, record.title,
                record.status, record.timeline_kind, record.linked_record_id,
                record.start_tick::text, record.start_ordinal::text,
                record.end_tick::text, record.end_ordinal::text,
                COALESCE(head.last_world_tick, record.start_tick)::text AS head_tick,
                COALESCE(head.last_world_ordinal, record.start_ordinal)::text AS head_ordinal
         FROM records AS record
         LEFT JOIN record_heads AS head
           ON head.workspace_id = record.workspace_id
          AND head.record_id = record.id
         WHERE record.workspace_id = $1 AND record.world_id = $2
         ORDER BY record.start_tick ASC, record.start_ordinal ASC,
                  record.created_at ASC, record.id ASC`,
        [input.workspaceId, input.worldId],
      );

      const mergeRows = await client.query<{
        id: string;
        source_worldline_a: string;
        source_worldline_b: string;
        merged_worldline_id: string | null;
        status: string;
      }>(
        `SELECT id, source_worldline_a, source_worldline_b,
                merged_worldline_id, status
         FROM worldline_merges
         WHERE workspace_id = $1 AND world_id = $2
         ORDER BY created_at ASC, id ASC`,
        [input.workspaceId, input.worldId],
      );

      let currentRecordId: string | null = null;
      let currentWorldlineId: string | null = null;
      const requestedRecordId = input.currentRecordId?.trim() ?? "";
      if (requestedRecordId) {
        const current = await client.query<{
          id: string;
          worldline_id: string;
        }>(
          `SELECT id, worldline_id FROM records
           WHERE workspace_id = $1 AND world_id = $2 AND id = $3`,
          [input.workspaceId, input.worldId, requestedRecordId],
        );
        const row = current.rows[0];
        if (row) {
          currentRecordId = row.id;
          currentWorldlineId = row.worldline_id;
        }
      }

      const worldlines: BranchTreeWorldline[] = worldlineRows.rows.map((row) => ({
        id: row.id,
        label: row.label,
        status: row.status,
        parentWorldlineId: row.parent_worldline_id,
        fork: toNullableCursor(row.fork_tick, row.fork_ordinal),
        head: toCursor(row.head_tick, row.head_ordinal),
        createdAt: toIso(row.created_at),
        stories: storyRows.rows
          .filter((story) => story.worldline_id === row.id)
          .map((story) => ({
            id: story.id,
            title: story.title,
            status: story.status,
            start: toCursor(story.start_tick, story.start_ordinal),
            end: toNullableCursor(story.end_tick, story.end_ordinal),
          })),
        records: recordRows.rows
          .filter((record) => record.worldline_id === row.id)
          .map((record) => ({
            id: record.id,
            storyId: record.story_id,
            title: record.title,
            status: record.status,
            timelineKind: record.timeline_kind,
            linkedRecordId: record.linked_record_id,
            start: toCursor(record.start_tick, record.start_ordinal),
            end: toNullableCursor(record.end_tick, record.end_ordinal),
            head: toCursor(record.head_tick, record.head_ordinal),
          })),
      }));

      return {
        world: { id: input.worldId, name: world.name, status: world.status },
        currentRecordId,
        currentWorldlineId,
        worldlines,
        merges: mergeRows.rows.map((merge) => ({
          id: merge.id,
          sourceWorldlineA: merge.source_worldline_a,
          sourceWorldlineB: merge.source_worldline_b,
          mergedWorldlineId: merge.merged_worldline_id,
          status: merge.status,
        })),
      };
    },
    { readOnly: true },
  );
}
