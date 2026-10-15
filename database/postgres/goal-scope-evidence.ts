import type { PoolClient, QueryResultRow } from "pg";
import {
  goalScopeKind,
  type GoalEvent,
  type GoalScope,
  type GoalStoryScope,
  type GoalRuntimeScope,
} from "../../modules/goals/public.ts";
import type { JsonValue } from "../../modules/runtime/public.ts";
import { GoalRuntimeRepositoryError } from "./goal-assessment-job-queue.ts";

/**
 * Goal scope evidence 读取边界（B1）：按 scope 判别联合读取 committed
 * events，为 story/worldline evidence 聚合提供通用、可测试的基础。
 *
 * - record scope：单个 Record 的 committed events（record_ordinal 序）；
 * - worldline scope：整条 worldline 全部 Record 的 committed events，按
 *   (world_tick, world_ordinal, record_id, record_ordinal, id) 确定性
 *   排序——跨 Record 聚合只用已提交事件；
 * - story scope：成员 Record 默认经由既有 records.story_id 绑定在同一
 *   worldline 内解析（这不是 Story Graph；B2 的 Story Graph 成员解析
 *   落地后可经 memberRecordIds 显式覆盖）；显式提供 memberRecordIds
 *   时严格按给定清单读取，绝不静默退化为整条 worldline。
 *
 * 本模块只在调用方既有 workspace 事务的 client 上执行读取；RLS 提供
 * workspace 隔离，绝不绕过。
 */

/** 跨 Record 聚合的事件视图：附加 worldline 级确定性排序游标。 */
export interface GoalScopedCommittedEvent extends GoalEvent {
  worldTick: number;
  worldOrdinal: number;
}

interface ScopedEventRow extends QueryResultRow {
  id: string;
  record_id: string;
  record_version: string | number;
  record_ordinal: string | number;
  world_tick: string | number;
  world_ordinal: string | number;
  event_kind: string;
  payload: unknown;
}

export async function loadGoalScopeCommittedEvents(
  client: PoolClient,
  scope: GoalScope,
  options?: { memberRecordIds?: readonly string[] },
): Promise<readonly GoalScopedCommittedEvent[]> {
  const scopeKind = goalScopeKind(scope);
  if (
    !scope.workspaceId.trim()
    || !scope.worldId.trim()
    || !scope.worldlineId.trim()
  ) {
    throw new GoalRuntimeRepositoryError(
      "GOAL_SCOPE_INVALID",
      "Goal evidence scope is invalid.",
    );
  }
  const baseParams: unknown[] = [scope.workspaceId, scope.worldId, scope.worldlineId];
  let where: string;
  let params: unknown[];
  let orderBy: string;
  if (scopeKind === "record") {
    const recordId = (scope as GoalRuntimeScope).recordId;
    if (!recordId?.trim()) {
      throw new GoalRuntimeRepositoryError(
        "GOAL_SCOPE_INVALID",
        "Record Goal evidence scope requires a Record identifier.",
      );
    }
    where = "AND record_id = $4";
    params = [...baseParams, recordId];
    orderBy = "record_ordinal, id";
  } else if (scopeKind === "story") {
    const storyId = (scope as GoalStoryScope).storyId;
    if (!storyId?.trim()) {
      throw new GoalRuntimeRepositoryError(
        "GOAL_SCOPE_INVALID",
        "Story Goal evidence scope requires a story identifier.",
      );
    }
    let members: string[];
    if (options?.memberRecordIds !== undefined) {
      members = [...new Set(options.memberRecordIds)]
        .filter((recordId) => typeof recordId === "string" && recordId.trim().length > 0);
    } else {
      const memberResult = await client.query<{ id: string }>(
        `SELECT id FROM records
         WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
           AND story_id = $4 AND status <> 'archived'
         ORDER BY id`,
        [...baseParams, storyId],
      );
      members = memberResult.rows.map((row) => row.id);
    }
    if (members.length === 0) {
      // story 当前无成员 Record：零证据是确定答案，绝不跨 scope 猜测。
      return [];
    }
    where = "AND record_id = ANY($4::text[])";
    params = [...baseParams, members];
    orderBy = "world_tick, world_ordinal, record_id, record_ordinal, id";
  } else {
    where = "";
    params = baseParams;
    orderBy = "world_tick, world_ordinal, record_id, record_ordinal, id";
  }
  const result = await client.query<ScopedEventRow>(
    `SELECT id, record_id, record_version, record_ordinal,
            world_tick, world_ordinal, event_kind, payload
     FROM events
     WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
     ${where}
     ORDER BY ${orderBy}`,
    params,
  );
  return result.rows.map(toScopedEvent);
}

function toScopedEvent(row: ScopedEventRow): GoalScopedCommittedEvent {
  return {
    eventId: row.id,
    recordId: row.record_id,
    recordVersion: safeInteger(row.record_version, "GOAL_RECORD_VERSION_INVALID"),
    ordinal: safeInteger(row.record_ordinal, "GOAL_RECORD_ORDINAL_INVALID"),
    worldTick: safeInteger(row.world_tick, "GOAL_WORLD_CURSOR_INVALID"),
    worldOrdinal: safeInteger(row.world_ordinal, "GOAL_WORLD_CURSOR_INVALID"),
    kind: row.event_kind,
    payload: runtimePayload(row.payload),
  };
}

function runtimePayload(value: unknown): JsonValue {
  if (!isRecord(value) || !("__realmRuntimePayload" in value)) {
    return value as JsonValue;
  }
  return value.__realmRuntimePayload as JsonValue;
}

function safeInteger(value: string | number, code: string): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new GoalRuntimeRepositoryError(code, "Persisted Goal integer is invalid.");
  }
  return number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
