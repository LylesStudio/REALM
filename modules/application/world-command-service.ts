/**
 * Engine backend Slice 5：World Command 编排服务
 * （docs/development/CROSS-RECORD-DOMAIN-TRANSACTION.md §5/§9）。
 *
 * 职责：可信 scope 解析 → 请求结构校验 → 事务外计划生成（可选模型/领域
 * 工作）→ CommandPlan 校验 → 统一事务仓储提交。任何跨 scope/worldline
 * 请求在任何 DB 写入前以稳定码拒绝（零拓扑残留）。
 *
 * 持久化中立：store 端口由 database/postgres/world-command-repository
 * 实现；本模块不 import 任何数据库适配器。模型与 World UI 永远接触不到
 * store——planEffects 是纯的领域效果构造回调（事务外执行）。
 */
import {
  buildCommandPlan,
  commandGroupIdFor,
  createWorldCommandFingerprint,
  isWorldCommandError,
  normalizeTouchedRecords,
  toPlayerSafeWorldCommandResult,
  WorldCommandError,
  WORLD_COMMAND_LIMITS,
  WORLD_COMMAND_POLICY_VERSION,
  type CommandPlan,
  type PlayerSafeWorldCommandResult,
  type WorldCommandCursor,
  type WorldCommandEventWrite,
  type WorldCommandOutboxWrite,
  type WorldCommandRequest,
  type WorldCommandResult,
} from "../worldline/world-command.ts";

/** store 端口的 scope 解析形态（repository 读模型）。 */
export interface WorldCommandRecordScope {
  recordId: string;
  worldId: string;
  worldlineId: string;
  status: string;
  recordVersion: number;
  nextRecordOrdinal: number;
}

/** 统一事务仓储端口（生产 = PostgreSQL adapter；测试可注入内存 fake）。 */
export interface WorldCommandStore {
  readRecordScopes(
    recordIds: readonly string[],
  ): Promise<readonly WorldCommandRecordScope[]>;
  readWorldlineCursor(
    worldlineId: string,
  ): Promise<WorldCommandCursor | null>;
  commitWorldCommand(plan: CommandPlan, now: string): Promise<WorldCommandResult>;
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
  /** 幂等台账读回（replay 短路；不含任何写入）。 */
  loadCommandGroup(idempotencyKey: {
    worldlineId: string;
    key: string;
  }): Promise<{
    requestFingerprint: string;
    result: WorldCommandResult;
  } | null>;
}

export interface PlannedRecordEffects {
  recordId: string;
  events: readonly WorldCommandEventWrite[];
  outbox?: readonly WorldCommandOutboxWrite[];
}

/** 事务外计划上下文：已解析且已校验同 scope 的 Record 视图。 */
export interface WorldCommandPlanContext {
  request: WorldCommandRequest;
  records: readonly WorldCommandRecordScope[];
  worldCursor: WorldCommandCursor;
}

export interface WorldCommandServiceOptions {
  store: WorldCommandStore;
  /**
   * 领域效果构造（事务外）：把已校验 scope 的请求映射为 per-Record 正式
   * 事件/Outbox 写。抛 WorldCommandError = 稳定领域拒绝（落 rejected 台账，
   * 同 key replay 同一拒绝）；其他错误原样上抛。
   */
  planEffects(
    context: WorldCommandPlanContext,
  ):
    | readonly PlannedRecordEffects[]
    | Promise<readonly PlannedRecordEffects[]>;
  clock?: () => string;
}

export interface WorldCommandService {
  executeWorldCommand(
    request: WorldCommandRequest,
  ): Promise<PlayerSafeWorldCommandResult>;
}

export function createWorldCommandService(
  options: WorldCommandServiceOptions,
): WorldCommandService {
  const clock = options.clock ?? (() => new Date().toISOString());

  return {
    async executeWorldCommand(request) {
      validateRequestShape(request);
      // 去重 + 稳定排序 + primary 成员校验（纯函数，输入顺序无关）。
      const touched = normalizeTouchedRecords(request);
      const requestFingerprint = createWorldCommandFingerprint(request);

      // 幂等台账短路先于 head 预检：已提交命令的 replay 不能依赖
      // expected head（成功提交已推进 head）；同 key 不同指纹 fail-closed。
      // 无台账行时才继续 scope/plan/commit；事务内 ON CONFLICT 复核仍是
      // 权威兜底（读与提交之间的竞态由唯一约束 + 锁内指纹复核收敛）。
      const ledger = await options.store.loadCommandGroup({
        worldlineId: request.scope.worldlineId,
        key: request.idempotencyKey,
      });
      if (ledger) {
        if (ledger.requestFingerprint !== requestFingerprint) {
          throw new WorldCommandError(
            "IDEMPOTENCY_KEY_REUSE",
            "The idempotency key was already used for a different World Command.",
          );
        }
        return toPlayerSafeWorldCommandResult(ledger.result);
      }

      // 可信 scope 解析（无锁只读；权威复核在提交事务锁内）。任何
      // 缺失/归档/跨 scope 在任何 DB 写入前拒绝。
      const scopes = await options.store.readRecordScopes(
        touched.map((record) => record.recordId),
      );
      const scopeByRecord = new Map(scopes.map((row) => [row.recordId, row]));
      for (const record of touched) {
        const scope = scopeByRecord.get(record.recordId);
        if (!scope) {
          throw new WorldCommandError(
            "WORLD_COMMAND_RECORD_UNKNOWN",
            "A touched Record no longer exists.",
          );
        }
        if (scope.status === "archived") {
          throw new WorldCommandError(
            "WORLD_COMMAND_RECORD_ARCHIVED",
            "An archived Record cannot join a World Command.",
          );
        }
        if (
          scope.worldId !== request.scope.worldId
          || scope.worldlineId !== request.scope.worldlineId
        ) {
          throw new WorldCommandError(
            "WORLD_COMMAND_SCOPE_MISMATCH",
            "Every touched Record must share the command Worldline scope.",
          );
        }
        if (scope.recordVersion !== record.expectedRecordVersion) {
          throw new WorldCommandError(
            "WRITE_CONFLICT",
            "A touched Record changed before this World Command could commit.",
            { retryable: true },
          );
        }
      }
      const worldCursor = await options.store.readWorldlineCursor(
        request.scope.worldlineId,
      );
      if (!worldCursor) {
        throw new WorldCommandError(
          "WORLD_COMMAND_SCOPE_MISMATCH",
          "The command Worldline does not exist in this Workspace.",
        );
      }

      // 事务外领域效果构造（模型/规则工作在此并行发生）；稳定领域拒绝
      // 落 rejected 台账，同 key replay 返回同一拒绝。
      let effects: readonly PlannedRecordEffects[];
      try {
        effects = await options.planEffects({
          request,
          records: touched.map(
            (record) => scopeByRecord.get(record.recordId)!,
          ),
          worldCursor,
        });
      } catch (error) {
        if (isWorldCommandError(error)) {
          return toPlayerSafeWorldCommandResult(
            await options.store.rejectWorldCommand(
              planIdentity(request),
              { code: error.code, message: error.safeMessage },
              clock(),
            ),
          );
        }
        throw error;
      }

      let plan: CommandPlan;
      try {
        plan = buildCommandPlan({
          request,
          effects,
          expectedWorldCursor: worldCursor,
        });
      } catch (error) {
        if (isWorldCommandError(error)) {
          return toPlayerSafeWorldCommandResult(
            await options.store.rejectWorldCommand(
              planIdentity(request),
              { code: error.code, message: error.safeMessage },
              clock(),
            ),
          );
        }
        throw error;
      }

      const result = await options.store.commitWorldCommand(plan, clock());
      return toPlayerSafeWorldCommandResult(result);
    },
  };
}

function planIdentity(request: WorldCommandRequest): Pick<
  CommandPlan,
  | "scope"
  | "commandGroupId"
  | "idempotencyKey"
  | "requestFingerprint"
  | "primaryRecordId"
  | "policyVersion"
> {
  return {
    scope: { ...request.scope },
    commandGroupId: commandGroupIdFor(request.scope, request.idempotencyKey),
    idempotencyKey: request.idempotencyKey,
    requestFingerprint: createWorldCommandFingerprint(request),
    primaryRecordId: request.primaryRecordId.trim(),
    policyVersion: WORLD_COMMAND_POLICY_VERSION,
  };
}

/** 请求结构校验（写入前；超限/畸形一律稳定码拒绝）。 */
function validateRequestShape(request: WorldCommandRequest): void {
  const invalid = (message: string): never => {
    throw new WorldCommandError("WORLD_COMMAND_REQUEST_INVALID", message);
  };
  if (!request || typeof request !== "object") {
    invalid("A World Command request is required.");
  }
  if (
    !request.scope
    || !request.scope.workspaceId.trim()
    || !request.scope.worldId.trim()
    || !request.scope.worldlineId.trim()
  ) {
    invalid("A World Command requires a trusted Worldline scope.");
  }
  if (
    typeof request.idempotencyKey !== "string"
    || !request.idempotencyKey.trim()
    || request.idempotencyKey.length > WORLD_COMMAND_LIMITS.maxIdempotencyKeyLength
  ) {
    invalid("A World Command requires a bounded idempotency key.");
  }
  if (!Array.isArray(request.touchedRecords)) {
    invalid("A World Command requires a touched Record list.");
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(request.payload ?? null);
  } catch {
    invalid("A World Command payload must be JSON-serializable.");
  }
  if (Buffer.byteLength(serialized!, "utf8") > WORLD_COMMAND_LIMITS.maxPayloadBytes) {
    invalid("A World Command payload exceeds the bounded size.");
  }
}
