/**
 * v37 §D.0/§E.1：统一世界写入 gate 与锁序。
 *
 * gateWorldWrite  = worlds FOR KEY SHARE + status='active' 断言——内容面写
 * 事务的第一个锁；写者互相并行（KEY SHARE 互相兼容），与归档命令的
 * FOR UPDATE 互斥（官方行锁矩阵：KEY SHARE 仅与 FOR UPDATE 冲突）。
 * gateRecordActive = records FOR UPDATE + status<>'archived' 断言——接在
 * worlds gate 之后，仅 record 级路径。
 *
 * 统一锁序（Slice 5 跨 Record 领域事务起，Worldline 先于 Record head）：
 * set_config → worlds(KEY SHARE) → records(FOR UPDATE) → worldlines →
 * world_command_groups 幂等台账行 → record_heads → 领域聚合/账本行
 * （goal_instances、character_assets/character_effects 等，稳定序）→
 * append-only 写入 →（completeRun：propagation_jobs FOR UPDATE）→
 * advisory/其余。任何代码路径不得在持有领域聚合行后再回头锁 worldlines
 * 或 record_heads；多 Record 锁定一律按 record_id 升序逐行取得。
 */
import type { PoolClient } from "pg";

export type WorldWriteGateCode =
  | "WORLD_NOT_FOUND"
  | "WORLD_ARCHIVED"
  | "RECORD_NOT_FOUND"
  | "RECORD_ARCHIVED";

export class WorldWriteGateError extends Error {
  readonly code: WorldWriteGateCode;
  constructor(code: WorldWriteGateCode, message: string) {
    super(message);
    this.name = "WorldWriteGateError";
    this.code = code;
  }
}

/** 内容面写事务的第一个锁：worlds FOR KEY SHARE + active 断言（锁内重读）。 */
export async function gateWorldWrite(
  client: PoolClient,
  scope: { workspaceId: string; worldId: string },
): Promise<void> {
  const result = await client.query<{ status: string }>(
    `SELECT status FROM worlds
     WHERE workspace_id = $1 AND id = $2
     FOR KEY SHARE`,
    [scope.workspaceId, scope.worldId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new WorldWriteGateError("WORLD_NOT_FOUND", "World not found.");
  }
  if (row.status !== "active") {
    throw new WorldWriteGateError(
      "WORLD_ARCHIVED",
      "The world is archived and read-only.",
    );
  }
}

/** record 级路径的第二道锁：records FOR UPDATE + 非 archived 断言。 */
export async function gateRecordActive(
  client: PoolClient,
  scope: { workspaceId: string; recordId: string },
): Promise<void> {
  const result = await client.query<{ status: string }>(
    `SELECT status FROM records
     WHERE workspace_id = $1 AND id = $2
     FOR UPDATE`,
    [scope.workspaceId, scope.recordId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new WorldWriteGateError("RECORD_NOT_FOUND", "Record not found.");
  }
  if (row.status === "archived") {
    throw new WorldWriteGateError(
      "RECORD_ARCHIVED",
      "The record is archived and read-only.",
    );
  }
}

export function isWorldWriteGateError(
  error: unknown,
): error is WorldWriteGateError {
  return error instanceof WorldWriteGateError;
}
