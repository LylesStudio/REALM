import type { Pool } from "pg";
import {
  clampSelfPlayBeatBudget,
  normalizeSelfPlayState,
  SELF_PLAY_STALE_ERROR,
  type SelfPlaySession,
  type SelfPlayStore,
} from "../../modules/application/self-play.ts";
import { withWorkspaceTransaction } from "./workspace-transaction.ts";
import { gateRecordActive, gateWorldWrite } from "./world-write-gate.ts";

/**
 * v37 §D.0 两拍模式（self-play record 键路径）：① 无锁只读 record 行取
 * worldId → ② gateWorldWrite（worlds KEY SHARE + active）→
 * ③ gateRecordActive（records FOR UPDATE + 非 archived）。
 */
async function gateRecordSessionPath(
  client: import("pg").PoolClient,
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
 * 批次 T7：世界自演会话账本仓储（record_self_play_sessions，迁移 0020）。
 * 全部写入走受限 realm_runtime 角色；状态迁移由 SQL WHERE 守卫——
 * 非法迁移（如重复 finish、stop 已终态行）零影响返回，不抛错。
 */

interface SessionRow {
  id: string;
  record_id: string;
  world_id: string;
  state: string;
  beat_budget: number;
  beats_completed: number;
  requested_by: string;
  last_error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function mapSession(row: SessionRow): SelfPlaySession | null {
  const state = normalizeSelfPlayState(row.state);
  if (!state) return null;
  return {
    id: row.id,
    recordId: row.record_id,
    worldId: row.world_id,
    state,
    beatBudget: row.beat_budget,
    beatsCompleted: row.beats_completed,
    requestedBy: row.requested_by,
    lastError: row.last_error ?? null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

const SESSION_COLUMNS = `id, record_id, world_id, state, beat_budget,
  beats_completed, requested_by, last_error, created_at, updated_at`;

export function createPostgresSelfPlayStore(
  database: Pool,
  workspaceId: string,
): SelfPlayStore {
  async function findLatest(recordId: string): Promise<SelfPlaySession | null> {
    return withWorkspaceTransaction(
      database,
      workspaceId,
      async (client) => {
        const result = await client.query<SessionRow>(
          `SELECT ${SESSION_COLUMNS}
           FROM record_self_play_sessions
           WHERE workspace_id = $1 AND record_id = $2
           ORDER BY created_at DESC, id DESC
           LIMIT 1`,
          [workspaceId, recordId],
        );
        const row = result.rows[0];
        return row ? mapSession(row) : null;
      },
      { readOnly: true },
    );
  }

  async function start(input: {
    sessionId: string;
    recordId: string;
    worldId: string;
    beatBudget: number;
    requestedBy: string;
  }): Promise<{ session: SelfPlaySession; created: boolean }> {
    return withWorkspaceTransaction(database, workspaceId, async (client) => {
      // v37 §D.0：C 面新会话 admission——recordId→record 行两拍；
      // worlds(KEY SHARE)→records(FOR UPDATE) gate；archived 拒绝。
      await gateRecordSessionPath(client, workspaceId, input.recordId);

      // 幂等重入：活动会话在 → 返回现状（部分唯一索引兜底并发双写）。
      const active = await client.query<SessionRow>(
        `SELECT ${SESSION_COLUMNS}
         FROM record_self_play_sessions
         WHERE workspace_id = $1 AND record_id = $2
           AND state IN ('running', 'stopping')
         ORDER BY created_at DESC
         LIMIT 1`,
        [workspaceId, input.recordId],
      );
      const existing = active.rows[0] ? mapSession(active.rows[0]) : null;
      if (existing) return { session: existing, created: false };

      const inserted = await client.query<SessionRow>(
        `INSERT INTO record_self_play_sessions (
           workspace_id, id, record_id, world_id, state,
           beat_budget, beats_completed, requested_by
         ) VALUES ($1, $2, $3, $4, 'running', $5, 0, $6)
         ON CONFLICT (workspace_id, id) DO NOTHING
         RETURNING ${SESSION_COLUMNS}`,
        [
          workspaceId,
          input.sessionId,
          input.recordId,
          input.worldId,
          clampSelfPlayBeatBudget(input.beatBudget),
          input.requestedBy,
        ],
      );
      const row = inserted.rows[0];
      if (!row) {
        // 同 id 重放：读回既有行。
        const replay = await client.query<SessionRow>(
          `SELECT ${SESSION_COLUMNS}
           FROM record_self_play_sessions
           WHERE workspace_id = $1 AND id = $2`,
          [workspaceId, input.sessionId],
        );
        const replayed = replay.rows[0] ? mapSession(replay.rows[0]) : null;
        if (!replayed) {
          throw new Error("self-play session insert replay lost its row.");
        }
        return { session: replayed, created: false };
      }
      return { session: mapSession(row)!, created: true };
    });
  }

  async function load(sessionId: string): Promise<SelfPlaySession | null> {
    return withWorkspaceTransaction(
      database,
      workspaceId,
      async (client) => {
        const result = await client.query<SessionRow>(
          `SELECT ${SESSION_COLUMNS}
           FROM record_self_play_sessions
           WHERE workspace_id = $1 AND id = $2`,
          [workspaceId, sessionId],
        );
        const row = result.rows[0];
        return row ? mapSession(row) : null;
      },
      { readOnly: true },
    );
  }

  async function completeBeat(sessionId: string): Promise<SelfPlaySession | null> {
    return withWorkspaceTransaction(database, workspaceId, async (client) => {
      // v37 §D.0：C 面推进在途工作——sessionId→record 行两拍；archived 拒绝。
      const sessionScope = await client.query<{ record_id: string }>(
        `SELECT record_id FROM record_self_play_sessions
         WHERE workspace_id = $1 AND id = $2`,
        [workspaceId, sessionId],
      );
      if (sessionScope.rows[0]) {
        await gateRecordSessionPath(client, workspaceId, sessionScope.rows[0].record_id);
      }

      // running 与 stopping 都可计拍——stopping 下跑完的在途拍是真实提交，
      // 账目须反映实际落库拍数（取消在拍边界收束，不抹掉已完成的拍）。
      const result = await client.query<SessionRow>(
        `UPDATE record_self_play_sessions
         SET beats_completed = beats_completed + 1, updated_at = CURRENT_TIMESTAMP
         WHERE workspace_id = $1 AND id = $2 AND state IN ('running', 'stopping')
         RETURNING ${SESSION_COLUMNS}`,
        [workspaceId, sessionId],
      );
      const row = result.rows[0];
      return row ? mapSession(row) : null;
    });
  }

  async function requestStop(recordId: string): Promise<SelfPlaySession | null> {
    return withWorkspaceTransaction(database, workspaceId, async (client) => {
      const result = await client.query<SessionRow>(
        `UPDATE record_self_play_sessions
         SET state = 'stopping', updated_at = CURRENT_TIMESTAMP
         WHERE workspace_id = $1 AND record_id = $2 AND state = 'running'
         RETURNING ${SESSION_COLUMNS}`,
        [workspaceId, recordId],
      );
      const row = result.rows[0];
      return row ? mapSession(row) : null;
    });
  }

  async function finish(
    sessionId: string,
    state: "completed" | "failed" | "cancelled",
    lastError?: string | null,
  ): Promise<void> {
    await withWorkspaceTransaction(database, workspaceId, async (client) => {
      await client.query(
        `UPDATE record_self_play_sessions
         SET state = $3, last_error = $4, updated_at = CURRENT_TIMESTAMP
         WHERE workspace_id = $1 AND id = $2 AND state IN ('running', 'stopping')`,
        [workspaceId, sessionId, state, lastError ?? null],
      );
    });
  }

  async function failStale(recordId: string, cutoff: Date): Promise<void> {
    await withWorkspaceTransaction(database, workspaceId, async (client) => {
      await client.query(
        `UPDATE record_self_play_sessions
         SET state = 'failed', last_error = $3, updated_at = CURRENT_TIMESTAMP
         WHERE workspace_id = $1 AND record_id = $2
           AND state IN ('running', 'stopping')
           AND updated_at < $4`,
        [workspaceId, recordId, SELF_PLAY_STALE_ERROR, cutoff.toISOString()],
      );
    });
  }

  return { findLatest, start, load, completeBeat, requestStop, finish, failStale };
}
