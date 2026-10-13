/**
 * Engine backend Slice 5：World Command 的 PostgreSQL 事务仓储
 * （docs/development/CROSS-RECORD-DOMAIN-TRANSACTION.md §5.3/§6.1）。
 *
 * 一个 World Command 在单一事务内原子提交：多个 Record 的 Events/
 * Observations/Action Receipts/character state、Record heads、Worldline
 * cursor、per-Record 子命令台账（command_inbox + turn_runs）、Outbox 与
 * Command Group 结果清单——任何一步失败整体回滚，零残留。
 *
 * 全局锁序（与迁移后的 commitRelease 等既有 head writer 完全一致）：
 *   worlds(KEY SHARE gate) → records(FOR UPDATE，record_id 升序)
 *   → worldlines(FOR UPDATE) → world_command_groups 幂等台账行
 *   → record_heads(FOR UPDATE，record_id 升序)
 *   → 领域聚合/账本行（character_assets/character_effects/
 *     character_instances，随 Record 顺序）
 *   → append-only 写入（events/observations/receipts/outbox）。
 * 锁内重读并校验 expected heads 与 Worldline cursor——不信任事务外的旧
 * 计划；漂移即 fail-closed（WRITE_CONFLICT），绝不静默 last-write-wins。
 *
 * 幂等：同 key 同 fingerprint → 返回台账中同一结果（零新写入）；同 key
 * 不同 fingerprint → IDEMPOTENCY_KEY_REUSE。serialization/deadlock
 * （40001/40P01）由服务端按同一计划有界重试完整事务；领域冲突不重试。
 */
import type { Pool, PoolClient } from "pg";
import { FatalTurnError, type JsonValue } from "../../modules/runtime/public.ts";
import {
  applyEffect,
  consumeResource,
  type ActionLedgerScope,
} from "../../modules/actions/engine.ts";
import {
  subCommandIdFor,
  validateCommandPlan,
  WorldCommandError,
  type CommandPlan,
  type CommandPlanRecord,
  type WorldCommandCursor,
  type WorldCommandEventWrite,
  type WorldCommandRejectedResult,
  type WorldCommandResult,
  type WorldCommandScope,
} from "../../modules/worldline/world-command.ts";
import { gateWorldWrite, isWorldWriteGateError } from "./world-write-gate.ts";
import { withWorkspaceTransaction } from "./workspace-transaction.ts";
import {
  RECORD_COMMITTED_CHANNEL,
  recordCommittedWakeupPayload,
} from "./record-events.ts";

const RUNTIME_PAYLOAD_KEY = "__realmRuntimePayload";
const WORLD_COMMAND_KIND = "world.command";
const DEFAULT_MAX_SERIALIZATION_ATTEMPTS = 3;

export interface WorldCommandRecordScope {
  recordId: string;
  worldId: string;
  worldlineId: string;
  status: string;
  recordVersion: number;
  nextRecordOrdinal: number;
}

export interface PostgresWorldCommandRepositoryHooks {
  /**
   * 测试故障注入 seam：在第 index 个 touched Record 的事件写入前以同一
   * client 调用。抛错即整事务回滚（零残留验收）；抛出携带 code
   * 40001/40P01 的错误可验证有界 serialization 重试。生产装配不得传入。
   */
  beforeRecordEventsWrite?: (
    client: PoolClient,
    recordId: string,
    index: number,
  ) => Promise<void>;
}

export interface PostgresWorldCommandRepositoryOptions {
  pool: Pool;
  workspaceId: string;
  /** serialization/deadlock 完整事务重试上限（含首次尝试），默认 3。 */
  maxSerializationAttempts?: number;
  hooks?: PostgresWorldCommandRepositoryHooks;
}

export interface PostgresWorldCommandRepository {
  /** 无锁只读 scope 解析（计划阶段；权威校验在提交事务锁内复核）。 */
  readRecordScopes(
    recordIds: readonly string[],
  ): Promise<readonly WorldCommandRecordScope[]>;
  readWorldlineCursor(
    worldlineId: string,
  ): Promise<WorldCommandCursor | null>;
  commitWorldCommand(plan: CommandPlan, now: string): Promise<WorldCommandResult>;
  /** scope 校验通过后的稳定领域拒绝落台账（同 key replay 同一拒绝）。 */
  rejectWorldCommand(
    plan: Pick<
      CommandPlan,
      | "scope"
      | "commandGroupId"
      | "idempotencyKey"
      | "requestFingerprint"
      | "primaryRecordId"
      | "policyVersion"
    >,
    rejection: { code: string; message: string },
    now: string,
  ): Promise<WorldCommandResult>;
  /** 审计读回：按 idempotency key 取台账行（fingerprint + 结果清单）。 */
  loadCommandGroup(idempotencyKey: {
    worldlineId: string;
    key: string;
  }): Promise<{
    requestFingerprint: string;
    result: WorldCommandResult;
  } | null>;
}

interface RecordRow {
  id: string;
  world_id: string;
  worldline_id: string;
  status: string;
}

interface HeadRow {
  record_id: string;
  record_version: string | number;
  next_record_ordinal: string | number;
}

export function createPostgresWorldCommandRepository(
  options: PostgresWorldCommandRepositoryOptions,
): PostgresWorldCommandRepository {
  const workspaceId = options.workspaceId.trim();
  if (!workspaceId) {
    throw new WorldCommandError(
      "WORLD_COMMAND_REQUEST_INVALID",
      "PostgreSQL repositories require a Workspace identifier.",
    );
  }
  const maxAttempts = options.maxSerializationAttempts
    ?? DEFAULT_MAX_SERIALIZATION_ATTEMPTS;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 8) {
    throw new WorldCommandError(
      "WORLD_COMMAND_REQUEST_INVALID",
      "Serialization retry attempts must stay bounded.",
    );
  }

  async function commitOnce(
    plan: CommandPlan,
    now: string,
  ): Promise<WorldCommandResult> {
    return withWorkspaceTransaction(options.pool, workspaceId, async (client) => {
      // 1. 内容面写 gate：worlds(KEY SHARE + active)。
      try {
        await gateWorldWrite(client, { workspaceId, worldId: plan.scope.worldId });
      } catch (error) {
        if (isWorldWriteGateError(error)) {
          throw new WorldCommandError(
            error.code === "WORLD_ARCHIVED"
              ? "WORLD_COMMAND_SCOPE_MISMATCH"
              : "WORLD_COMMAND_RECORD_UNKNOWN",
            error.message,
          );
        }
        throw error;
      }

      // 2. records(FOR UPDATE) gate：按 record_id 升序逐行锁定并逐一校验
      //    scope——绝不用「只校验第一个 Record」的快捷路径。
      const sortedRecordIds = plan.records.map((record) => record.recordId);
      for (const recordId of sortedRecordIds) {
        const row = await client.query<RecordRow>(
          `SELECT id, world_id, worldline_id, status
           FROM records
           WHERE workspace_id = $1 AND id = $2
           FOR UPDATE`,
          [workspaceId, recordId],
        );
        const record = row.rows[0];
        if (!record) {
          throw new WorldCommandError(
            "WORLD_COMMAND_RECORD_UNKNOWN",
            "A touched Record no longer exists.",
          );
        }
        if (
          record.world_id !== plan.scope.worldId
          || record.worldline_id !== plan.scope.worldlineId
        ) {
          throw new WorldCommandError(
            "WORLD_COMMAND_SCOPE_MISMATCH",
            "Every touched Record must share the command Worldline scope.",
          );
        }
        if (record.status === "archived") {
          throw new WorldCommandError(
            "WORLD_COMMAND_RECORD_ARCHIVED",
            "An archived Record cannot join a World Command.",
          );
        }
      }

      // 3. Worldline 行锁 + 锁内 cursor 复核。
      const worldlineResult = await client.query<{
        head_tick: string | number;
        head_ordinal: string | number;
        world_id: string;
        calendar_id: string;
        display_time: string;
      }>(
        `SELECT worldline.head_tick, worldline.head_ordinal, worldline.world_id,
                world.calendar_id,
                COALESCE(world.settings->>'displayTime', '') AS display_time
         FROM worldlines AS worldline
         JOIN worlds AS world
           ON world.workspace_id = worldline.workspace_id
          AND world.id = worldline.world_id
         WHERE worldline.workspace_id = $1 AND worldline.id = $2
         FOR UPDATE OF worldline`,
        [workspaceId, plan.scope.worldlineId],
      );
      const worldline = worldlineResult.rows[0];
      if (!worldline || worldline.world_id !== plan.scope.worldId) {
        throw new WorldCommandError(
          "WORLD_COMMAND_SCOPE_MISMATCH",
          "The command Worldline does not belong to the command World.",
        );
      }
      const worldlineHead = {
        tick: safeInteger(worldline.head_tick),
        ordinal: safeInteger(worldline.head_ordinal),
      };
      if (
        worldlineHead.tick !== plan.expectedWorldCursor.tick
        || worldlineHead.ordinal !== plan.expectedWorldCursor.ordinal
      ) {
        throw writeConflict(
          "The Worldline advanced before this World Command could commit.",
        );
      }

      // 4. Command Group 幂等台账行。
      const claimed = await client.query(
        `INSERT INTO world_command_groups (
           workspace_id, world_id, worldline_id, id,
           idempotency_key, request_fingerprint, primary_record_id,
           state, result_manifest, policy_version,
           created_at, updated_at, completed_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7,
           'committed', '{}'::jsonb, $8,
           $9::timestamptz, $9::timestamptz, $9::timestamptz
         )
         ON CONFLICT DO NOTHING`,
        [
          workspaceId,
          plan.scope.worldId,
          plan.scope.worldlineId,
          plan.commandGroupId,
          plan.idempotencyKey,
          plan.requestFingerprint,
          plan.primaryRecordId,
          plan.policyVersion,
          now,
        ],
      );
      if (claimed.rowCount !== 1) {
        const existing = await client.query<{
          id: string;
          request_fingerprint: string;
          state: string;
          result_manifest: unknown;
          rejection_code: string | null;
        }>(
          `SELECT id, request_fingerprint, state, result_manifest, rejection_code
           FROM world_command_groups
           WHERE workspace_id = $1 AND worldline_id = $2 AND idempotency_key = $3
           FOR UPDATE`,
          [workspaceId, plan.scope.worldlineId, plan.idempotencyKey],
        );
        const row = existing.rows[0];
        if (!row) {
          throw new WorldCommandError(
            "WORLD_COMMAND_IDENTITY_CONFLICT",
            "The Command Group identity collides with a different command.",
          );
        }
        if (row.request_fingerprint !== plan.requestFingerprint) {
          throw new WorldCommandError(
            "IDEMPOTENCY_KEY_REUSE",
            "The idempotency key was already used for a different World Command.",
          );
        }
        // 同 key 同 fingerprint：返回台账中同一结果，零新写入。
        return parseManifest(row.result_manifest, plan.scope);
      }

      // 5. Touched Record heads：按 record_id 升序逐行 FOR UPDATE，锁内
      //    复核 expected head。
      const heads = new Map<string, { version: number; nextOrdinal: number }>();
      for (const recordId of sortedRecordIds) {
        const headResult = await client.query<HeadRow>(
          `SELECT record_id, record_version, next_record_ordinal
           FROM record_heads
           WHERE workspace_id = $1 AND record_id = $2
           FOR UPDATE`,
          [workspaceId, recordId],
        );
        const head = headResult.rows[0];
        if (!head) {
          throw new WorldCommandError(
            "WORLD_COMMAND_RECORD_UNKNOWN",
            "A touched Record head no longer exists.",
          );
        }
        heads.set(recordId, {
          version: safeInteger(head.record_version),
          nextOrdinal: safeInteger(head.next_record_ordinal),
        });
      }
      for (const record of plan.records) {
        if (heads.get(record.recordId)!.version !== record.expectedRecordVersion) {
          throw writeConflict(
            "A touched Record changed before this World Command could commit.",
          );
        }
      }

      // 6. 世界游标分配：同一 tick，ordinal 自 Worldline head 起按
      //    (record 升序, record 内事件序) 连续分配——确定性因果顺序。
      let cursorOrdinal = worldlineHead.ordinal;
      const worldTick = worldlineHead.tick;
      const allocated = new Map<string, {
        recordVersion: number;
        firstOrdinal: number;
        cursors: WorldCommandCursor[];
      }>();
      for (const record of plan.records) {
        const head = heads.get(record.recordId)!;
        const cursors = record.events.map(() => ({
          tick: worldTick,
          ordinal: ++cursorOrdinal,
        }));
        allocated.set(record.recordId, {
          recordVersion: head.version + 1,
          firstOrdinal: head.nextOrdinal,
          cursors,
        });
      }

      // 7. per-Record 子命令台账（command_inbox + turn_runs，state 直接
      //    completed——同事务原子，中间态对外不可见）。
      const subCommandIdByRecord = new Map<string, string>();
      for (const record of plan.records) {
        const subCommandId = subCommandIdFor(plan.commandGroupId, record.recordId);
        subCommandIdByRecord.set(record.recordId, subCommandId);
        const allocation = allocated.get(record.recordId)!;
        const eventIds = record.events.map((event) => event.eventId);
        const outboxMessageIds = record.outbox.map((message) => message.messageId);
        const role = record.recordId === plan.primaryRecordId ? "primary" : "touched";
        const receipt = {
          turnId: subCommandId,
          recordId: record.recordId,
          recordVersion: allocation.recordVersion,
          firstOrdinal: allocation.firstOrdinal,
          nextOrdinal: allocation.firstOrdinal + record.events.length,
          eventIds,
          outboxMessageIds,
          releaseFingerprint: plan.requestFingerprint,
          committedAt: now,
        };
        await client.query(
          `INSERT INTO command_inbox (
             workspace_id, world_id, worldline_id, record_id, id,
             principal_id, idempotency_key, request_fingerprint, command_kind,
             payload, expected_record_version, state, result_event_ids,
             accepted_at, started_at, completed_at, updated_at
           ) VALUES (
             $1, $2, $3, $4, $5,
             NULL, $6, $7, $8,
             $9::jsonb, $10, 'completed', $11::text[],
             $12::timestamptz, $12::timestamptz, $12::timestamptz, $12::timestamptz
           )`,
          [
            workspaceId,
            plan.scope.worldId,
            plan.scope.worldlineId,
            record.recordId,
            subCommandId,
            `wcg:${plan.commandGroupId}`,
            plan.requestFingerprint,
            WORLD_COMMAND_KIND,
            json(envelope({
              commandGroupId: plan.commandGroupId,
              role,
            })),
            record.expectedRecordVersion,
            eventIds,
            now,
          ],
        );
        const checkpoint = {
          turnId: subCommandId,
          command: {
            commandType: WORLD_COMMAND_KIND,
            recordId: record.recordId,
            expectedRecordVersion: record.expectedRecordVersion,
            idempotencyKey: `wcg:${plan.commandGroupId}`,
            actorId: null,
            payload: { commandGroupId: plan.commandGroupId, role },
          },
          commandFingerprint: plan.requestFingerprint,
          state: "completed",
          revision: 1,
          attempts: { planning: 0, drafting: 0, validating: 0, releasing: 0 },
          failures: [],
          transitions: [
            { from: null, to: "accepted", at: now },
            { from: "accepted", to: "completed", at: now },
          ],
          acceptedAt: now,
          updatedAt: now,
          completedAt: now,
          release: receipt,
        };
        await client.query(
          `INSERT INTO turn_runs (
             workspace_id, world_id, worldline_id, record_id, command_id, id,
             attempt_number, state, revision, attempts, run_checkpoint,
             failure_history, transition_history,
             release_receipt, release_fingerprint, completed_record_version,
             created_at, updated_at, completed_at
           ) VALUES (
             $1, $2, $3, $4, $5, $5,
             1, 'completed', 1, $6::jsonb, $7::jsonb,
             '[]'::jsonb, $8::jsonb,
             $9::jsonb, $10, $11,
             $12::timestamptz, $12::timestamptz, $12::timestamptz
           )`,
          [
            workspaceId,
            plan.scope.worldId,
            plan.scope.worldlineId,
            record.recordId,
            subCommandId,
            json(checkpoint.attempts),
            json(checkpoint),
            json(checkpoint.transitions),
            json(receipt),
            plan.requestFingerprint,
            allocation.recordVersion,
            now,
          ],
        );
      }

      // 8. Group ↔ Record 关联行（final head 已在锁内确定）。
      for (const record of plan.records) {
        const allocation = allocated.get(record.recordId)!;
        await client.query(
          `INSERT INTO world_command_records (
             workspace_id, world_id, worldline_id, command_group_id, record_id,
             record_role, sub_command_id,
             expected_record_version, final_record_version,
             first_record_ordinal, next_record_ordinal, created_at
           ) VALUES (
             $1, $2, $3, $4, $5,
             $6, $7,
             $8, $9,
             $10, $11, $12::timestamptz
           )`,
          [
            workspaceId,
            plan.scope.worldId,
            plan.scope.worldlineId,
            plan.commandGroupId,
            record.recordId,
            record.recordId === plan.primaryRecordId ? "primary" : "touched",
            subCommandIdByRecord.get(record.recordId)!,
            record.expectedRecordVersion,
            allocation.recordVersion,
            allocation.firstOrdinal,
            allocation.firstOrdinal + record.events.length,
            now,
          ],
        );
      }

      // 9. append-only 写入：events → observations → receipts/ledger →
      //    character state（按 Record 升序、事件计划序）。calendar/display
      //    快照取自 Worldline 行锁内读取的作用域。
      const calendar = {
        calendarId: worldline.calendar_id,
        displayTime: worldline.display_time,
      };
      for (const [index, record] of plan.records.entries()) {
        if (options.hooks?.beforeRecordEventsWrite) {
          await options.hooks.beforeRecordEventsWrite(client, record.recordId, index);
        }
        const allocation = allocated.get(record.recordId)!;
        const subCommandId = subCommandIdByRecord.get(record.recordId)!;
        await writeRecordEvents(
          client,
          plan,
          record,
          allocation,
          subCommandId,
          calendar,
          now,
        );
      }

      // 10. Record heads 推进。
      for (const record of plan.records) {
        const allocation = allocated.get(record.recordId)!;
        const lastEvent = record.events[record.events.length - 1]!;
        const lastCursor = allocation.cursors[allocation.cursors.length - 1]!;
        await client.query(
          `UPDATE record_heads
           SET record_version = $3,
               next_record_ordinal = $4,
               last_event_id = $5,
               last_world_tick = $6,
               last_world_ordinal = $7,
               updated_at = $8::timestamptz
           WHERE workspace_id = $1 AND record_id = $2`,
          [
            workspaceId,
            record.recordId,
            allocation.recordVersion,
            allocation.firstOrdinal + record.events.length,
            lastEvent.eventId,
            lastCursor.tick,
            lastCursor.ordinal,
            now,
          ],
        );
      }

      // 11. Worldline cursor 推进到本命令最后一条事件的游标。
      await client.query(
        `UPDATE worldlines
         SET head_tick = $3, head_ordinal = $4, updated_at = $5::timestamptz
         WHERE workspace_id = $1 AND id = $2`,
        [workspaceId, plan.scope.worldlineId, worldTick, cursorOrdinal, now],
      );

      // 12. Outbox（durable；投递由既有 worker 按 group correlation 追溯）。
      const outboxMessageIds: string[] = [];
      for (const record of plan.records) {
        for (const message of record.outbox) {
          outboxMessageIds.push(message.messageId);
          await client.query(
            `INSERT INTO outbox (
               workspace_id, world_id, worldline_id, record_id,
               event_id, turn_run_id, id, dedupe_key, topic, payload,
               state, revision, attempt_count,
               available_at, created_at, updated_at, command_group_id
             ) VALUES (
               $1, $2, $3, $4,
               NULL, $5, $6, $7, $8, $9::jsonb,
               'pending', 0, 0,
               $10::timestamptz, $10::timestamptz, $10::timestamptz, $11
             )`,
            [
              workspaceId,
              plan.scope.worldId,
              plan.scope.worldlineId,
              record.recordId,
              subCommandIdByRecord.get(record.recordId)!,
              message.messageId,
              message.dedupeKey,
              message.topic,
              json(envelope(message.payload)),
              now,
              plan.commandGroupId,
            ],
          );
        }
      }

      // 13. 结果清单落台账（同事务；commit 才对其他事务可见）。
      const result: WorldCommandResult = {
        state: "committed",
        commandGroupId: plan.commandGroupId,
        scope: { ...plan.scope },
        worldCursor: { tick: worldTick, ordinal: cursorOrdinal },
        committedAt: now,
        records: plan.records.map((record) => {
          const allocation = allocated.get(record.recordId)!;
          return {
            recordId: record.recordId,
            role: record.recordId === plan.primaryRecordId ? "primary" : "touched",
            subCommandId: subCommandIdByRecord.get(record.recordId)!,
            expectedRecordVersion: record.expectedRecordVersion,
            finalRecordVersion: allocation.recordVersion,
            firstRecordOrdinal: allocation.firstOrdinal,
            nextRecordOrdinal: allocation.firstOrdinal + record.events.length,
            eventIds: record.events.map((event) => event.eventId),
          };
        }),
        outboxMessageIds,
      };
      const manifested = await client.query(
        `UPDATE world_command_groups
         SET result_manifest = $3::jsonb, updated_at = $4::timestamptz
         WHERE workspace_id = $1 AND id = $2`,
        [workspaceId, plan.commandGroupId, json(manifestOf(result)), now],
      );
      if (manifested.rowCount !== 1) {
        throw new WorldCommandError(
          "WORLD_COMMAND_IDENTITY_CONFLICT",
          "The Command Group ledger row changed during commit.",
        );
      }

      // 14. committed-event 唤醒：随本事务提交送达，回滚不送达；payload
      //     只含最小唤醒字段，消费方按 ledger 重读。
      await client.query(
        `SELECT pg_notify($1, wake.payload)
         FROM unnest($2::text[]) AS wake(payload)`,
        [
          RECORD_COMMITTED_CHANNEL,
          plan.records.map((record) => {
            const allocation = allocated.get(record.recordId)!;
            return recordCommittedWakeupPayload({
              workspaceId,
              recordId: record.recordId,
              nextOrdinal: allocation.firstOrdinal + record.events.length,
            });
          }),
        ],
      );

      return result;
    });
  }

  return {
    async readRecordScopes(recordIds) {
      return withWorkspaceTransaction(
        options.pool,
        workspaceId,
        async (client) => {
          const rows: WorldCommandRecordScope[] = [];
          for (const recordId of recordIds) {
            const result = await client.query<{
              id: string;
              world_id: string;
              worldline_id: string;
              status: string;
              record_version: string | number | null;
              next_record_ordinal: string | number | null;
            }>(
              `SELECT record.id, record.world_id, record.worldline_id,
                      record.status,
                      head.record_version, head.next_record_ordinal
               FROM records AS record
               LEFT JOIN record_heads AS head
                 ON head.workspace_id = record.workspace_id
                AND head.record_id = record.id
               WHERE record.workspace_id = $1 AND record.id = $2`,
              [workspaceId, recordId],
            );
            const row = result.rows[0];
            // head 缺失视同 Record 不存在（fail-closed，绝不假装版本 0）。
            if (!row || row.record_version === null || row.next_record_ordinal === null) {
              continue;
            }
            rows.push({
              recordId: row.id,
              worldId: row.world_id,
              worldlineId: row.worldline_id,
              status: row.status,
              recordVersion: safeInteger(row.record_version),
              nextRecordOrdinal: safeInteger(row.next_record_ordinal),
            });
          }
          return rows;
        },
        { readOnly: true },
      );
    },

    async readWorldlineCursor(worldlineId) {
      return withWorkspaceTransaction(
        options.pool,
        workspaceId,
        async (client) => {
          const result = await client.query<{
            head_tick: string | number;
            head_ordinal: string | number;
          }>(
            `SELECT head_tick, head_ordinal
             FROM worldlines
             WHERE workspace_id = $1 AND id = $2`,
            [workspaceId, worldlineId],
          );
          const row = result.rows[0];
          return row
            ? { tick: safeInteger(row.head_tick), ordinal: safeInteger(row.head_ordinal) }
            : null;
        },
        { readOnly: true },
      );
    },

    async commitWorldCommand(plan, now) {
      assertIso(now);
      validateCommandPlan(plan);
      let attempt = 0;
      for (;;) {
        attempt += 1;
        try {
          return await commitOnce(plan, now);
        } catch (error) {
          if (isSerializationOrDeadlock(error) && attempt < maxAttempts) {
            continue;
          }
          if (isSerializationOrDeadlock(error)) {
            throw new WorldCommandError(
              "WORLD_COMMAND_COMMIT_UNAVAILABLE",
              "The World Command could not commit after bounded retries; it is safe to retry with the same idempotency key.",
              { retryable: true },
            );
          }
          throw translatePostgresConflict(error);
        }
      }
    },

    async rejectWorldCommand(plan, rejection, now) {
      assertIso(now);
      if (!rejection.code.trim()) {
        throw new WorldCommandError(
          "WORLD_COMMAND_REQUEST_INVALID",
          "A rejected World Command requires a stable rejection code.",
        );
      }
      return withWorkspaceTransaction(options.pool, workspaceId, async (client) => {
        await gateWorldWrite(client, {
          workspaceId,
          worldId: plan.scope.worldId,
        });
        const worldline = await client.query(
          `SELECT 1 FROM worldlines
           WHERE workspace_id = $1 AND world_id = $2 AND id = $3
           FOR UPDATE`,
          [workspaceId, plan.scope.worldId, plan.scope.worldlineId],
        );
        if (worldline.rowCount !== 1) {
          throw new WorldCommandError(
            "WORLD_COMMAND_SCOPE_MISMATCH",
            "The command Worldline does not belong to the command World.",
          );
        }
        const manifest = {
          state: "rejected",
          commandGroupId: plan.commandGroupId,
          scope: plan.scope,
          code: rejection.code,
          message: rejection.message,
          rejectedAt: now,
        };
        const claimed = await client.query(
          `INSERT INTO world_command_groups (
             workspace_id, world_id, worldline_id, id,
             idempotency_key, request_fingerprint, primary_record_id,
             state, result_manifest, rejection_code, policy_version,
             created_at, updated_at, completed_at
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7,
             'rejected', $8::jsonb, $9, $10,
             $11::timestamptz, $11::timestamptz, NULL
           )
           ON CONFLICT DO NOTHING`,
          [
            workspaceId,
            plan.scope.worldId,
            plan.scope.worldlineId,
            plan.commandGroupId,
            plan.idempotencyKey,
            plan.requestFingerprint,
            plan.primaryRecordId,
            json(manifest),
            rejection.code,
            plan.policyVersion,
            now,
          ],
        );
        if (claimed.rowCount === 1) {
          return parseManifest(manifest, plan.scope);
        }
        const existing = await client.query<{
          request_fingerprint: string;
          result_manifest: unknown;
        }>(
          `SELECT request_fingerprint, result_manifest
           FROM world_command_groups
           WHERE workspace_id = $1 AND worldline_id = $2 AND idempotency_key = $3
           FOR UPDATE`,
          [workspaceId, plan.scope.worldlineId, plan.idempotencyKey],
        );
        const row = existing.rows[0];
        if (!row) {
          throw new WorldCommandError(
            "WORLD_COMMAND_IDENTITY_CONFLICT",
            "The Command Group identity collides with a different command.",
          );
        }
        if (row.request_fingerprint !== plan.requestFingerprint) {
          throw new WorldCommandError(
            "IDEMPOTENCY_KEY_REUSE",
            "The idempotency key was already used for a different World Command.",
          );
        }
        return parseManifest(row.result_manifest, plan.scope);
      });
    },

    async loadCommandGroup(key) {
      return withWorkspaceTransaction(
        options.pool,
        workspaceId,
        async (client) => {
          const result = await client.query<{
            request_fingerprint: string;
            result_manifest: unknown;
          }>(
            `SELECT request_fingerprint, result_manifest
             FROM world_command_groups
             WHERE workspace_id = $1 AND worldline_id = $2 AND idempotency_key = $3`,
            [workspaceId, key.worldlineId, key.key],
          );
          const row = result.rows[0];
          if (!row) return null;
          return {
            requestFingerprint: row.request_fingerprint,
            result: parseManifest(row.result_manifest, {
              workspaceId,
              worldId: "",
              worldlineId: key.worldlineId,
            }),
          };
        },
        { readOnly: true },
      );
    },
  };

  async function writeRecordEvents(
    client: PoolClient,
    plan: CommandPlan,
    record: CommandPlanRecord,
    allocation: {
      recordVersion: number;
      firstOrdinal: number;
      cursors: WorldCommandCursor[];
    },
    subCommandId: string,
    calendar: { calendarId: string; displayTime: string },
    now: string,
  ): Promise<void> {
    const scope = plan.scope;
    const insertedPolicies = new Set<string>();
    const pendingObservations: {
      observerId: string;
      sourceEventId: string;
      observationId: string;
      dedupeKey: string;
      kind: string;
      content: string;
      fidelity: number;
      occurredTick: number;
      occurredOrdinal: number;
      availableTick: number;
      availableOrdinal: number;
      metadata: string;
    }[] = [];

    for (const [eventIndex, event] of record.events.entries()) {
      const cursor = allocation.cursors[eventIndex]!;
      if (event.visibilityPolicy && !insertedPolicies.has(event.visibilityPolicy.id)) {
        insertedPolicies.add(event.visibilityPolicy.id);
        await client.query(
          `INSERT INTO visibility_policies (
             workspace_id, world_id, worldline_id, record_id, id,
             policy_key, policy_version, policy_kind, restricted_domain_id,
             audience_character_instance_ids
           ) VALUES (
             $1, $2, $3, $4, $5,
             $6, 1, 'restricted', $7, $8::text[]
           )`,
          [
            workspaceId,
            scope.worldId,
            scope.worldlineId,
            record.recordId,
            event.visibilityPolicy.id,
            event.visibilityPolicy.policyKey,
            event.visibilityPolicy.restrictedDomainId,
            [...event.visibilityPolicy.audienceCharacterInstanceIds],
          ],
        );
      }
      await client.query(
        `INSERT INTO events (
           workspace_id, world_id, worldline_id, record_id, scene_id, id,
           record_version, record_ordinal, batch_index, event_kind,
           actor_participant_id, speaker_name, content, payload,
           visibility_policy_id, world_tick, world_ordinal, calendar_id,
           display_time, causation_command_id, turn_run_id, recorded_at,
           command_group_id
         ) VALUES (
           $1, $2, $3, $4, $5, $6,
           $7, $8, $9, $10,
           $11, $12, $13, $14::jsonb,
           $15, $16, $17, $18,
           $19, $20, $20, $21::timestamptz,
           $22
         )`,
        [
          workspaceId,
          scope.worldId,
          scope.worldlineId,
          record.recordId,
          event.sceneId,
          event.eventId,
          allocation.recordVersion,
          allocation.firstOrdinal + eventIndex,
          eventIndex,
          event.kind,
          event.actorParticipantId ?? null,
          event.speakerName ?? "",
          event.content ?? "",
          json({ ...(event.metadata ?? {}), [RUNTIME_PAYLOAD_KEY]: event.payload }),
          event.visibilityPolicyId,
          cursor.tick,
          cursor.ordinal,
          calendar.calendarId,
          calendar.displayTime,
          subCommandId,
          now,
          plan.commandGroupId,
        ],
      );

      for (const observation of event.observations ?? []) {
        const available = observation.availableFrom ?? cursor;
        if (
          available.tick < cursor.tick
          || (available.tick === cursor.tick && available.ordinal < cursor.ordinal)
        ) {
          throw new WorldCommandError(
            "WORLD_COMMAND_PLAN_INVALID",
            "Observation availability must not precede its source event.",
          );
        }
        pendingObservations.push({
          observerId: observation.observerCharacterInstanceId,
          sourceEventId: event.eventId,
          observationId: observation.observationId,
          dedupeKey: observation.dedupeKey,
          kind: observation.kind,
          content: observation.content,
          fidelity: observation.fidelity ?? 1,
          occurredTick: cursor.tick,
          occurredOrdinal: cursor.ordinal,
          availableTick: available.tick,
          availableOrdinal: available.ordinal,
          metadata: json(observation.metadata ?? {}),
        });
      }

      if (event.actionState) {
        await applyWorldCommandActionState(
          client,
          plan,
          record.recordId,
          event,
          cursor,
          now,
        );
      }

      for (const update of event.characterStateUpdates ?? []) {
        const updated = await client.query(
          `UPDATE character_instances
           SET state = state || $5::jsonb,
               updated_at = $6::timestamptz
           WHERE workspace_id = $1
             AND world_id = $2
             AND worldline_id = $3
             AND record_id = $4
             AND id = $7`,
          [
            workspaceId,
            scope.worldId,
            scope.worldlineId,
            record.recordId,
            json(update.statePatch),
            now,
            update.characterInstanceId,
          ],
        );
        if (updated.rowCount !== 1) {
          throw new FatalTurnError(
            "CHARACTER_STATE_TARGET_NOT_FOUND",
            "The character state target no longer exists in this Record.",
          );
        }
      }
    }

    if (pendingObservations.length > 0) {
      await client.query(
        `INSERT INTO observations (
           workspace_id, world_id, worldline_id, record_id,
           observer_character_instance_id, source_event_id, id,
           dedupe_key, observation_kind, content, fidelity,
           occurred_tick, occurred_ordinal,
           available_from_tick, available_from_ordinal, learned_at,
           metadata, command_group_id
         )
         SELECT
           $1, $2, $3, $4,
           batch.observer_id, batch.source_event_id, batch.observation_id,
           batch.dedupe_key, batch.kind, batch.content, batch.fidelity,
           batch.occurred_tick, batch.occurred_ordinal,
           batch.available_tick, batch.available_ordinal,
           $5::timestamptz, batch.metadata, $18
         FROM unnest(
           $6::text[], $7::text[], $8::text[], $9::text[], $10::text[],
           $11::text[], $12::double precision[], $13::bigint[],
           $14::bigint[], $15::bigint[], $16::bigint[], $17::jsonb[]
         ) AS batch(
           observer_id, source_event_id, observation_id, dedupe_key,
           kind, content, fidelity, occurred_tick, occurred_ordinal,
           available_tick, available_ordinal, metadata
         )`,
        [
          workspaceId,
          scope.worldId,
          scope.worldlineId,
          record.recordId,
          now,
          pendingObservations.map((row) => row.observerId),
          pendingObservations.map((row) => row.sourceEventId),
          pendingObservations.map((row) => row.observationId),
          pendingObservations.map((row) => row.dedupeKey),
          pendingObservations.map((row) => row.kind),
          pendingObservations.map((row) => row.content),
          pendingObservations.map((row) => row.fidelity),
          pendingObservations.map((row) => row.occurredTick),
          pendingObservations.map((row) => row.occurredOrdinal),
          pendingObservations.map((row) => row.availableTick),
          pendingObservations.map((row) => row.availableOrdinal),
          pendingObservations.map((row) => row.metadata),
          plan.commandGroupId,
        ],
      );
    }
  }

  async function applyWorldCommandActionState(
    client: PoolClient,
    plan: CommandPlan,
    recordId: string,
    event: WorldCommandEventWrite,
    cursor: WorldCommandCursor,
    now: string,
  ): Promise<void> {
    const write = event.actionState!;
    await client.query(
      `INSERT INTO action_receipts (
         workspace_id, world_id, worldline_id, record_id,
         actor_character_instance_id, source_event_id, id, transaction_id,
         call_fingerprint, receipt, world_tick, world_ordinal, recorded_at,
         command_group_id
       ) VALUES (
         $1, $2, $3, $4,
         $5, $6, $7, $8,
         $9, $10::jsonb, $11, $12,
         $13::timestamptz, $14
       )`,
      [
        workspaceId,
        plan.scope.worldId,
        plan.scope.worldlineId,
        recordId,
        write.actorCharacterInstanceId,
        event.eventId,
        write.receiptId,
        write.transactionId,
        write.callFingerprint,
        json(write.receipt),
        cursor.tick,
        cursor.ordinal,
        now,
        plan.commandGroupId,
      ],
    );
    const ledgerScope: ActionLedgerScope = {
      workspaceId,
      worldId: plan.scope.worldId,
      worldlineId: plan.scope.worldlineId,
      recordId,
      actorCharacterInstanceId: write.actorCharacterInstanceId,
    };
    for (const cost of write.costs) {
      await consumeResource(client, ledgerScope, cost, now);
    }
    for (const effect of write.effects) {
      await applyEffect(
        client,
        ledgerScope,
        effect,
        {
          receiptId: write.receiptId,
          transactionId: write.transactionId,
          tick: cursor.tick,
          ordinal: cursor.ordinal,
        },
        now,
      );
    }
  }

}

function manifestOf(result: WorldCommandResult): Record<string, JsonValue> {
  return JSON.parse(JSON.stringify(result)) as Record<string, JsonValue>;
}

function parseManifest(
  manifest: unknown,
  fallbackScope: WorldCommandScope,
): WorldCommandResult {
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new WorldCommandError(
      "WORLD_COMMAND_IDENTITY_CONFLICT",
      "The persisted Command Group manifest is invalid.",
    );
  }
  const value = manifest as {
    state?: unknown;
    commandGroupId?: unknown;
    scope?: WorldCommandScope;
    worldCursor?: WorldCommandCursor;
    committedAt?: unknown;
    records?: unknown;
    outboxMessageIds?: unknown;
    code?: unknown;
    message?: unknown;
    rejectedAt?: unknown;
  };
  if (value.state === "rejected") {
    if (typeof value.code !== "string" || typeof value.message !== "string") {
      throw new WorldCommandError(
        "WORLD_COMMAND_IDENTITY_CONFLICT",
        "The persisted Command Group rejection is invalid.",
      );
    }
    return {
      state: "rejected",
      commandGroupId: String(value.commandGroupId ?? ""),
      scope: value.scope ?? fallbackScope,
      code: value.code,
      message: value.message,
      rejectedAt: String(value.rejectedAt ?? ""),
    } satisfies WorldCommandRejectedResult;
  }
  if (
    value.state !== "committed"
    || !Array.isArray(value.records)
    || !Array.isArray(value.outboxMessageIds)
  ) {
    throw new WorldCommandError(
      "WORLD_COMMAND_IDENTITY_CONFLICT",
      "The persisted Command Group manifest is invalid.",
    );
  }
  return value as unknown as WorldCommandResult;
}

function isSerializationOrDeadlock(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return code === "40001" || code === "40P01";
}

function writeConflict(message: string): WorldCommandError {
  return new WorldCommandError("WRITE_CONFLICT", message, { retryable: true });
}

function translatePostgresConflict(error: unknown): unknown {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (code === "23505") {
    return new WorldCommandError(
      "WORLD_COMMAND_IDENTITY_CONFLICT",
      "A World Command write collides with an existing durable identity.",
    );
  }
  if (code === "23503") {
    return new WorldCommandError(
      "WORLD_COMMAND_PLAN_INVALID",
      "A World Command write references state that does not exist.",
    );
  }
  return error;
}

function envelope(payload: JsonValue): Record<string, JsonValue> {
  return { [RUNTIME_PAYLOAD_KEY]: payload };
}

function safeInteger(value: string | number): number {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new WorldCommandError(
      "WORLD_COMMAND_IDENTITY_CONFLICT",
      "A persisted cursor is outside the safe range.",
    );
  }
  return result;
}

function assertIso(now: string): void {
  if (!Number.isFinite(Date.parse(now))) {
    throw new WorldCommandError(
      "WORLD_COMMAND_REQUEST_INVALID",
      "A World Command commit requires a valid timestamp.",
    );
  }
}

function json(value: unknown): string {
  return JSON.stringify(value);
}
