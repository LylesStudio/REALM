import type { QueryResultRow } from "pg";
import type { JsonValue } from "../../modules/runtime/public.ts";
import type { GoalProjectionInstance } from "../../modules/goals/projection.ts";
import {
  withWorkspaceTransaction,
  type WorkspaceDatabase,
} from "./workspace-transaction.ts";

export type GoalProjectionRepositoryErrorCode =
  | "GOAL_PROJECTION_READ_FAILED"
  | "GOAL_PROJECTION_ROW_INVALID";

export class GoalProjectionRepositoryError extends Error {
  readonly code: GoalProjectionRepositoryErrorCode;

  constructor(code: GoalProjectionRepositoryErrorCode, message: string) {
    super(message);
    this.name = "GoalProjectionRepositoryError";
    this.code = code;
  }
}

export interface GoalProjectionReadResult {
  worldId: string;
  worldVersion: string;
  headOrdinal: number;
  instances: readonly GoalProjectionInstance[];
}

interface GoalRow extends QueryResultRow {
  world_id: string;
  worldline_id: string;
  world_version: string;
  goal_instance_id: string;
  goal_key: string;
  state: string;
  revision: string | number;
  progress: unknown;
  outcome: unknown;
  record_id: string;
  scope_kind: string;
  attempt: string | number;
  supersedes_instance_id: string | null;
  definition_source: string;
  definition_id: string | null;
  policy_version: string;
  resolution_kind: string;
  latest_goal_transition_ordinal: string | number | null;
}

const GOAL_STATES = new Set(["active", "completed", "failed", "settled"]);
const GOAL_SCOPE_KINDS = new Set(["record", "story", "worldline"]);

export interface GoalProjectionRepository {
  load(input: { workspaceId: string; recordId: string }): Promise<GoalProjectionReadResult>;
  listGoalTransitionOrdinalsAfter(input: {
    workspaceId: string;
    recordId: string;
    cursor: number;
  }): Promise<readonly number[]>;
}

export function createPostgresGoalProjectionRepository(
  database: WorkspaceDatabase,
): GoalProjectionRepository {
  return {
    async load({ workspaceId, recordId }) {
      try {
        return await withWorkspaceTransaction(database, workspaceId, async (client) => {
          const result = await client.query<GoalRow>(
            `SELECT
               goal.world_id,
               goal.worldline_id,
               record.world_version,
               goal.id AS goal_instance_id,
               goal.goal_key,
               goal.state,
               goal.revision,
               goal.progress,
               goal.outcome,
               goal.record_id,
               goal.scope_kind,
               goal.attempt,
               goal.supersedes_instance_id,
               goal.definition_source,
               goal.definition_id,
               goal.policy_version,
               goal.resolution_kind,
               (
                 SELECT MAX(goal_event.record_ordinal)
                 FROM events AS goal_event
                 WHERE goal_event.workspace_id = goal.workspace_id
                   AND goal_event.record_id = goal.record_id
                   AND goal_event.event_kind = 'goal.transition.committed'
               ) AS latest_goal_transition_ordinal
             FROM goal_instances AS goal
             JOIN records AS record
               ON record.workspace_id = goal.workspace_id
              AND record.world_id = goal.world_id
              AND record.worldline_id = goal.worldline_id
              AND record.id = goal.record_id
             JOIN worlds AS world
               ON world.workspace_id = goal.workspace_id
              AND world.id = goal.world_id
             WHERE goal.workspace_id = $1
               AND goal.record_id = $2
               AND goal.scope_kind = 'record'
               AND record.status <> 'archived'
             ORDER BY goal.created_at ASC, goal.id ASC`,
            [workspaceId, recordId],
          );
          const first = result.rows[0];
          const instances = result.rows.map((row) => normalizeGoalRow(row, recordId));
          return {
            worldId: first?.world_id ?? "",
            worldVersion: first?.world_version ?? "",
            headOrdinal: first ? normalizeGoalTransitionOrdinal(first.latest_goal_transition_ordinal) : 0,
            instances,
          };
        }, { readOnly: true });
      } catch (error) {
        if (error instanceof GoalProjectionRepositoryError) throw error;
        throw new GoalProjectionRepositoryError(
          "GOAL_PROJECTION_READ_FAILED",
          "Goal projection could not be read.",
        );
      }
    },
    async listGoalTransitionOrdinalsAfter({ workspaceId, recordId, cursor }) {
      if (!Number.isSafeInteger(cursor) || cursor < 0) {
        throw new GoalProjectionRepositoryError(
          "GOAL_PROJECTION_ROW_INVALID",
          "Goal projection cursor is invalid.",
        );
      }
      try {
        return await withWorkspaceTransaction(database, workspaceId, async (client) => {
          const result = await client.query<{ record_ordinal: string | number }>(
            `SELECT DISTINCT event.record_ordinal
             FROM events AS event
             JOIN records AS record
               ON record.workspace_id = event.workspace_id
              AND record.world_id = event.world_id
              AND record.worldline_id = event.worldline_id
              AND record.id = event.record_id
             WHERE event.workspace_id = $1
               AND event.record_id = $2
               AND event.record_ordinal > $3
               AND event.event_kind = 'goal.transition.committed'
               AND record.status <> 'archived'
             ORDER BY event.record_ordinal ASC`,
            [workspaceId, recordId, cursor],
          );
          return result.rows.map((row) => normalizeEventOrdinal(row.record_ordinal));
        }, { readOnly: true });
      } catch (error) {
        if (error instanceof GoalProjectionRepositoryError) throw error;
        throw new GoalProjectionRepositoryError(
          "GOAL_PROJECTION_READ_FAILED",
          "Goal projection transitions could not be read.",
        );
      }
    },
  };
}

function normalizeEventOrdinal(value: string | number): number {
  const ordinal = Number(value);
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
    throw new GoalProjectionRepositoryError(
      "GOAL_PROJECTION_ROW_INVALID",
      "Goal transition ordinal is invalid.",
    );
  }
  return ordinal;
}

function normalizeGoalTransitionOrdinal(value: string | number | null): number {
  if (value === null) return 0;
  const ordinal = Number(value);
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
    throw new GoalProjectionRepositoryError(
      "GOAL_PROJECTION_ROW_INVALID",
      "Goal projection transition cursor is invalid.",
    );
  }
  return ordinal;
}

function normalizeGoalRow(row: GoalRow, recordId: string): GoalProjectionInstance {
  if (
    typeof row.world_id !== "string"
    || typeof row.worldline_id !== "string"
    || (row.definition_source !== "content" && row.definition_source !== "record")
    || (row.definition_source === "content" && row.definition_id !== null)
    || (row.definition_source === "record" && (typeof row.definition_id !== "string" || !row.definition_id))
    || typeof row.policy_version !== "string" || !row.policy_version.trim()
    || !["natural", "withdrawn", "superseded"].includes(row.resolution_kind)
    || typeof row.world_version !== "string"
    || typeof row.goal_instance_id !== "string"
    || typeof row.goal_key !== "string"
    || row.goal_key.trim() !== row.goal_key
    || row.goal_key.length === 0
    || row.record_id !== recordId
    || !GOAL_STATES.has(row.state)
    || !GOAL_SCOPE_KINDS.has(row.scope_kind)
  ) {
    throw new GoalProjectionRepositoryError(
      "GOAL_PROJECTION_ROW_INVALID",
      "Goal projection row is invalid.",
    );
  }
  const revision = Number(row.revision);
  const attempt = Number(row.attempt);
  if (
    !Number.isSafeInteger(revision) || revision < 0
    || !Number.isSafeInteger(attempt) || attempt < 1
    || !isJsonObject(row.progress)
  ) {
    throw new GoalProjectionRepositoryError(
      "GOAL_PROJECTION_ROW_INVALID",
      "Goal projection row is invalid.",
    );
  }
  if (
    row.supersedes_instance_id !== null
    && typeof row.supersedes_instance_id !== "string"
  ) {
    throw new GoalProjectionRepositoryError(
      "GOAL_PROJECTION_ROW_INVALID",
      "Goal projection row is invalid.",
    );
  }
  if (row.outcome !== null && !isJsonObject(row.outcome)) {
    throw new GoalProjectionRepositoryError(
      "GOAL_PROJECTION_ROW_INVALID",
      "Goal projection row is invalid.",
    );
  }
  return {
    goalKey: row.goal_key,
    worldlineId: row.worldline_id,
    definitionSource: row.definition_source as "content" | "record",
    definitionId: row.definition_id,
    policyVersion: row.policy_version,
    ...(row.resolution_kind === "natural" ? {} : {
      resolutionKind: row.resolution_kind as "withdrawn" | "superseded",
    }),
    goalInstanceId: row.goal_instance_id,
    recordId,
    state: row.state as GoalProjectionInstance["state"],
    revision,
    progress: row.progress,
    outcome: row.outcome,
    scopeKind: row.scope_kind as GoalProjectionInstance["scopeKind"],
    attempt,
    supersedesInstanceId: row.supersedes_instance_id,
  };
}

function isJsonObject(value: unknown): value is Readonly<Record<string, JsonValue>> {
  return isJsonValue(value) && typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.values(value).every(isJsonValue);
}
