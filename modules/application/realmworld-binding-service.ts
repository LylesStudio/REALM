/**
 * RealmWorld 版本切换服务（Phase 4D）：显式、可审计、事务化的控制面动作。
 *
 * 语义与禁止项见 docs/development/REALMWORLD-VERSION-LIFECYCLE.md：
 * - 目标必须是同一 worldId 的已安装/已签名/trust-store 信任的精确版本；
 * - upgrade 要求 target > current，downgrade 要求 target < current（严格
 *   semver，见 realmworld-version.ts）；同版本 = 幂等 no-op；
 * - 包内容校验（mount+验签+runtime plan 解析）由调用方注入的
 *   validateTargetContent 在写事务前完成；事务失败零残留；
 * - 不重写历史 events/record_heads/拓扑；不改写 worlds.world_version。
 */
import { withWorkspaceTransaction } from "../../database/postgres/workspace-transaction.ts";
import type { WorkspaceDatabase } from "../../database/postgres/workspace-transaction.ts";
import { randomUUID } from "node:crypto";
import { compareRealmWorldVersions } from "../world-transfer/realmworld-version.ts";

export type RealmWorldSwitchOperation = "upgrade" | "downgrade";

export type RealmWorldBindingErrorCode =
  | "RECORD_NOT_FOUND"
  | "RECORD_ARCHIVED"
  | "WORLD_ARCHIVED"
  | "NOT_OWNER"
  | "INVALID_VERSION"
  | "INVALID_VERSION_DIRECTION"
  | "REALMWORLD_SWITCH_CONFLICT";

export class RealmWorldBindingError extends Error {
  readonly code: RealmWorldBindingErrorCode;

  constructor(code: RealmWorldBindingErrorCode, message: string) {
    super(message);
    this.name = "RealmWorldBindingError";
    this.code = code;
  }
}

export interface RealmWorldSwitchResult {
  recordId: string;
  worldId: string;
  worldlineId: string;
  fromVersion: string;
  toVersion: string;
  operation: RealmWorldSwitchOperation;
  switched: boolean;
  replayed: boolean;
}

interface RecordBindingRow {
  world_id: string;
  worldline_id: string;
  record_status: string;
  world_status: string;
  world_version: string;
  membership_role: string | null;
}

const BINDING_SELECT = `SELECT
    record.world_id,
    record.worldline_id,
    record.status AS record_status,
    record.world_version,
    world.status AS world_status,
    membership.role AS membership_role
  FROM records AS record
  JOIN worlds AS world
    ON world.workspace_id = record.workspace_id
   AND world.id = record.world_id
  LEFT JOIN player_world_memberships AS membership
    ON membership.workspace_id = record.workspace_id
   AND membership.world_id = record.world_id
   AND membership.principal_id = $3
  WHERE record.workspace_id = $1 AND record.id = $2`;

export function createRealmWorldBindingService(options: {
  database: WorkspaceDatabase;
  /** 目标内容闸（mount+验签+runtime plan 解析）；失败抛错即 fail-closed。 */
  validateTargetContent: (worldId: string, worldVersion: string) => Promise<void>;
}) {
  return {
    async switchRecordWorldVersion(
      scope: { workspaceId: string; principalId: string },
      input: {
        recordId: string;
        targetWorldVersion: string;
        operation: RealmWorldSwitchOperation;
      },
      idempotencyKey: string,
    ): Promise<RealmWorldSwitchResult> {
      const key = idempotencyKey.trim();
      if (!key || key.length > 128) {
        throw new RealmWorldBindingError("INVALID_VERSION", "idempotency key is invalid.");
      }

      // 读事务：定位 + 校验（锁在写事务内重新持）。
      const probe = await withWorkspaceTransaction(
        options.database,
        scope.workspaceId,
        async (client) => {
          const result = await client.query<RecordBindingRow>(BINDING_SELECT, [
            scope.workspaceId, input.recordId, scope.principalId,
          ]);
          return result.rows[0] ?? null;
        },
        { readOnly: true },
      );
      // 不存在/非成员：404 不泄露存在性。
      if (!probe || probe.membership_role === null) {
        throw new RealmWorldBindingError("RECORD_NOT_FOUND", "Record not found.");
      }
      if (probe.membership_role !== "owner") {
        throw new RealmWorldBindingError("NOT_OWNER", "Only the world owner may switch a Record binding.");
      }
      if (probe.record_status === "archived") {
        throw new RealmWorldBindingError("RECORD_ARCHIVED", "Archived records cannot switch binding.");
      }
      if (probe.world_status === "archived") {
        throw new RealmWorldBindingError("WORLD_ARCHIVED", "Archived worlds cannot switch bindings.");
      }
      const current = probe.world_version;
      const direction = compareRealmWorldVersions(input.targetWorldVersion, current);
      if (direction === null) {
        throw new RealmWorldBindingError(
          "INVALID_VERSION",
          "World versions must be strict semver (X.Y.Z).",
        );
      }
      // 幂等优先于同版本判定：同键不同参数一律冲突（即使当前恰好同版本）；
      // 同键同参数 = replay（返回台账记录的 from/to）。
      const prior = await findSwitchReplay(scope, input.recordId, key);
      if (prior) {
        if (
          prior.to_version !== input.targetWorldVersion
          || prior.operation !== input.operation
        ) {
          throw new RealmWorldBindingError(
            "REALMWORLD_SWITCH_CONFLICT",
            "The idempotency key was used for a conflicting switch.",
          );
        }
        return {
          recordId: input.recordId,
          worldId: probe.world_id,
          worldlineId: probe.worldline_id,
          fromVersion: prior.from_version,
          toVersion: prior.to_version,
          operation: input.operation,
          switched: false,
          replayed: true,
        };
      }
      if (direction === 0) {
        // 同版本 no-op（无台账行）：纯粹幂等，不产生审计噪音。
        return {
          recordId: input.recordId,
          worldId: probe.world_id,
          worldlineId: probe.worldline_id,
          fromVersion: current,
          toVersion: current,
          operation: input.operation,
          switched: false,
          replayed: false,
        };
      }
      if (input.operation === "upgrade" && direction !== 1) {
        throw new RealmWorldBindingError(
          "INVALID_VERSION_DIRECTION",
          "upgrade requires a strictly newer target version.",
        );
      }
      if (input.operation === "downgrade" && direction !== -1) {
        throw new RealmWorldBindingError(
          "INVALID_VERSION_DIRECTION",
          "downgrade requires a strictly older target version.",
        );
      }
      // 目标内容闸（mount + 验签 + runtime plan 解析）在写事务之前；
      // 缺包/签名/identity/schema 任一失败即抛，绝不回退 base 或当前版本。
      await options.validateTargetContent(probe.world_id, input.targetWorldVersion);

      return withWorkspaceTransaction(
        options.database,
        scope.workspaceId,
        async (client) => {
          const locked = await client.query<RecordBindingRow>(
            `${BINDING_SELECT} FOR UPDATE OF record`,
            [scope.workspaceId, input.recordId, scope.principalId],
          );
          const row = locked.rows[0];
          if (!row) throw new RealmWorldBindingError("RECORD_NOT_FOUND", "Record not found.");
          // 锁内重读：归档/版本漂移在写前重判（CAS 语义）。
          if (row.record_status === "archived") {
            throw new RealmWorldBindingError("RECORD_ARCHIVED", "Archived records cannot switch binding.");
          }
          if (row.world_status === "archived") {
            throw new RealmWorldBindingError("WORLD_ARCHIVED", "Archived worlds cannot switch bindings.");
          }
          if (row.world_version !== current) {
            throw new RealmWorldBindingError(
              "REALMWORLD_SWITCH_CONFLICT",
              "The Record binding changed while the switch was prepared.",
            );
          }
          // 幂等台账：同 (record, idempotency_key) 已存在 → 参数一致即
          // replay，否则冲突。审计行与 binding UPDATE 同事务。
          const auditId = `realmworld_switch_${randomUUID().replaceAll("-", "").slice(0, 18)}`;
          const inserted = await client.query<{ id: string }>(
            `INSERT INTO realmworld_version_switches (
               workspace_id, id, world_id, worldline_id, record_id,
               from_version, to_version, operation, idempotency_key
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (workspace_id, record_id, idempotency_key) DO NOTHING
             RETURNING id`,
            [
              scope.workspaceId, auditId, row.world_id, row.worldline_id,
              input.recordId, current, input.targetWorldVersion,
              input.operation, key,
            ],
          );
          if (inserted.rowCount !== 1) {
            const existing = await client.query<{
              from_version: string;
              to_version: string;
              operation: string;
            }>(
              `SELECT from_version, to_version, operation
               FROM realmworld_version_switches
               WHERE workspace_id = $1 AND record_id = $2 AND idempotency_key = $3`,
              [scope.workspaceId, input.recordId, key],
            );
            const prior = existing.rows[0];
            if (
              prior
              && prior.to_version === input.targetWorldVersion
              && prior.operation === input.operation
            ) {
              return {
                recordId: input.recordId,
                worldId: row.world_id,
                worldlineId: row.worldline_id,
                fromVersion: prior.from_version,
                toVersion: prior.to_version,
                operation: input.operation,
                switched: false,
                replayed: true,
              };
            }
            throw new RealmWorldBindingError(
              "REALMWORLD_SWITCH_CONFLICT",
              "The idempotency key was used for a conflicting switch.",
            );
          }
          const updated = await client.query(
            `UPDATE records SET world_version = $3, updated_at = CURRENT_TIMESTAMP
             WHERE workspace_id = $1 AND id = $2 AND world_version = $4`,
            [scope.workspaceId, input.recordId, input.targetWorldVersion, current],
          );
          if (updated.rowCount !== 1) {
            throw new RealmWorldBindingError(
              "REALMWORLD_SWITCH_CONFLICT",
              "The Record binding changed while the switch was prepared.",
            );
          }
          return {
            recordId: input.recordId,
            worldId: row.world_id,
            worldlineId: row.worldline_id,
            fromVersion: current,
            toVersion: input.targetWorldVersion,
            operation: input.operation,
            switched: true,
            replayed: false,
          };
        },
      );
    },
  };

  async function findSwitchReplay(
    scope: { workspaceId: string; principalId: string },
    recordId: string,
    idempotencyKey: string,
  ) {
    return withWorkspaceTransaction(
      options.database,
      scope.workspaceId,
      async (client) => {
        const result = await client.query<{
          id: string;
          from_version: string;
          to_version: string;
          operation: string;
        }>(
          `SELECT id, from_version, to_version, operation
           FROM realmworld_version_switches
           WHERE workspace_id = $1 AND record_id = $2 AND idempotency_key = $3`,
          [scope.workspaceId, recordId, idempotencyKey],
        );
        return result.rows[0] ?? null;
      },
      { readOnly: true },
    );
  }
}

export type RealmWorldBindingService = ReturnType<typeof createRealmWorldBindingService>;
