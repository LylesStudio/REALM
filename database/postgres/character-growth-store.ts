import type { Pool } from "pg";
import { withWorkspaceTransaction } from "./workspace-transaction.ts";
import { gateWorldWrite } from "./world-write-gate.ts";

/**
 * 人物设定自然生长仓储：把对话 growth 的 profile note 追加/合并进当前
 * Record 的 character_instances.state.profileNotes（JSONB 数组 key，
 * 与既有 state.profileSummary 显式身份更新互不覆盖）。
 *
 * Batch 4B（无 migration 双读）：新写入的 note 从裸字符串升级为带
 * provenance/lifecycle 的 object entry（note/sourceRecordId/
 * sourceEventId/validFromTick/validToTick/createdAt/revokedAt）；
 * 旧字符串 entry 原样保留、继续可读，同一数组新旧共存，不回写旧数据。
 * provenance 不由调用方填写——store 在同一写事务内按完整 scope
 * （workspace/world/worldline/record + sourceEventId）校验已提交事件并
 * 用 DB 侧 world_tick/recorded_at 盖章；来源缺失或跨 scope fail-closed
 * （返回 false，零写入，绝不写无来源 note 或假时序）。
 *
 * 边界：
 * - 只追加/合并 note（按 note 文本精确去重，新旧形状混合同规），绝不覆盖
 *   character_definitions.profile 或玩家显式自述写入的 state.profileSummary；
 * - 目标必须属于当前 Record 的 roster（WHERE record_id 限定，非名册成员
 *   结构性跳过）；
 * - 沿用 realm_runtime 现有 UPDATE 权限与 gateWorldWrite（archived 世界
 *   只读拒绝），不放宽任何表权限；无新 migration（复用 0030 的 state
 *   JSONB）。
 */

/** profile note 上限：prompt/规整与合并同源。 */
export const PROFILE_NOTE_LIMITS = {
  maxNotes: 8,
  noteLength: 160,
} as const;

export interface CharacterProfileNote {
  characterInstanceId: string;
  note: string;
}

/** Batch 4B：带 provenance/lifecycle 的 profile note entry。 */
export interface ProfileNoteEntry {
  note: string;
  sourceRecordId: string;
  sourceEventId: string;
  validFromTick: number | null;
  validToTick: number | null;
  createdAt: string;
  revokedAt: string | null;
}

/** state.profileNotes 数组元素：旧字符串与新 object 共存。 */
export type ProfileNoteRecord = string | ProfileNoteEntry;

export interface CharacterGrowthScope {
  workspaceId: string;
  worldId: string;
  worldlineId: string;
  recordId: string;
}

export interface CharacterGrowthStore {
  /**
   * 追加 profile note；source.sourceEventId 必须是本次已提交 release 的
   * 真实事件 id（服务端校验 + DB 派生 cursor/时间戳）。来源不可解析或
   * 跨 scope → 返回 false 且零写入（fail-closed）。
   */
  appendProfileNotes(
    scope: CharacterGrowthScope,
    notes: readonly CharacterProfileNote[],
    source: { sourceEventId: string },
  ): Promise<boolean>;
}

function normalizeLegacyNote(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, PROFILE_NOTE_LIMITS.noteLength);
  return trimmed.length > 0 ? trimmed : null;
}

function isTick(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/**
 * object entry 校验（fail-closed）：字段缺失/类型不符一律丢弃——绝不把
 * 任意 object 的 metadata 当作合法 note 渲染或保留。
 */
export function normalizeProfileNoteEntry(
  value: unknown,
): ProfileNoteEntry | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const note = normalizeLegacyNote(candidate.note);
  if (!note) return null;
  if (
    typeof candidate.sourceRecordId !== "string"
    || candidate.sourceRecordId.length === 0
    || typeof candidate.sourceEventId !== "string"
    || candidate.sourceEventId.length === 0
  ) {
    return null;
  }
  if (candidate.validFromTick !== null && !isTick(candidate.validFromTick)) {
    return null;
  }
  if (candidate.validToTick !== null && !isTick(candidate.validToTick)) {
    return null;
  }
  if (typeof candidate.createdAt !== "string") return null;
  if (candidate.revokedAt !== null && typeof candidate.revokedAt !== "string") {
    return null;
  }
  return {
    note,
    sourceRecordId: candidate.sourceRecordId,
    sourceEventId: candidate.sourceEventId,
    validFromTick: candidate.validFromTick as number | null,
    validToTick: candidate.validToTick as number | null,
    createdAt: candidate.createdAt,
    revokedAt: candidate.revokedAt as string | null,
  };
}

/**
 * 读取侧（record-scope 的 profileSummary 合成）：返回当前有效的 note
 * 文本，否则 null。legacy string 始终有效；object entry 应用生命周期
 * 过滤——revokedAt 非空、已过期（validToTick <= cursor）、未来
 * （validFromTick > cursor）均不渲染；effectiveTick 为 null 时保守地
 * 只过滤 revokedAt（不猜 temporal）。prompt 只能拿到文本，metadata
 * （source IDs/cursor/timestamps/revocation）绝不进入渲染结果。
 */
export function profileNoteTextAt(
  value: unknown,
  effectiveTick: number | null,
): string | null {
  if (typeof value === "string") return normalizeLegacyNote(value);
  const entry = normalizeProfileNoteEntry(value);
  if (!entry) return null;
  if (entry.revokedAt) return null;
  if (effectiveTick !== null) {
    if (entry.validToTick !== null && entry.validToTick <= effectiveTick) {
      return null;
    }
    if (entry.validFromTick !== null && entry.validFromTick > effectiveTick) {
      return null;
    }
  }
  return entry.note;
}

/**
 * 纯合并（可测）：existing 为 state.profileNotes 原值（字符串/object/
 * 任意脏数据混合数组），incoming 为新 note 文本。
 * - 旧字符串原样保留（不迁移形状）；malformed 元素 fail-closed 丢弃；
 * - 新 note 有 provenance 时写 object entry，否则保持 legacy 字符串；
 * - 按 note 文本精确去重（新旧形状混合同规）、逐条修剪限长、
 *   超出上限丢最旧。
 */
export function mergeProfileNotes(
  existing: unknown,
  incoming: readonly string[],
  provenance?: {
    sourceRecordId: string;
    sourceEventId: string;
    validFromTick: number;
    createdAt: string;
  },
): ProfileNoteRecord[] {
  const current: ProfileNoteRecord[] = Array.isArray(existing)
    ? existing
      .map((item): ProfileNoteRecord | null => {
        if (typeof item === "string") return normalizeLegacyNote(item);
        return normalizeProfileNoteEntry(item);
      })
      .filter((item): item is ProfileNoteRecord => item !== null)
    : [];
  const texts = new Set(
    current.map((item) => (typeof item === "string" ? item : item.note)),
  );
  const merged = [...current];
  for (const note of incoming) {
    const trimmed = note.trim().slice(0, PROFILE_NOTE_LIMITS.noteLength);
    if (!trimmed || texts.has(trimmed)) continue;
    texts.add(trimmed);
    merged.push(
      provenance
        ? {
          note: trimmed,
          sourceRecordId: provenance.sourceRecordId,
          sourceEventId: provenance.sourceEventId,
          validFromTick: provenance.validFromTick,
          validToTick: null,
          createdAt: provenance.createdAt,
          revokedAt: null,
        }
        : trimmed,
    );
  }
  while (merged.length > PROFILE_NOTE_LIMITS.maxNotes) merged.shift();
  return merged;
}

export function createPostgresCharacterGrowthStore(
  pool: Pool,
): CharacterGrowthStore {
  return {
    async appendProfileNotes(scope, notes, source) {
      if (notes.length === 0) return true;
      return withWorkspaceTransaction(pool, scope.workspaceId, async (client) => {
        // v37 §D.0：C 面——gateWorldWrite（worlds KEY SHARE + active，锁内重读）。
        await gateWorldWrite(client, {
          workspaceId: scope.workspaceId,
          worldId: scope.worldId,
        });
        // Batch 4B：来源 Event 同事务校验（完整 scope 五元组）+ DB 侧
        // cursor/时间戳派生；不可解析或跨 scope → false 零写入。
        const sourceRow = (await client.query<{
          world_tick: string | number;
          recorded_at: Date | string;
        }>(
          `SELECT world_tick, recorded_at
           FROM events
           WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
             AND record_id = $4 AND id = $5`,
          [
            scope.workspaceId,
            scope.worldId,
            scope.worldlineId,
            scope.recordId,
            source.sourceEventId,
          ],
        )).rows[0];
        if (!sourceRow) return false;
        const provenance = {
          sourceRecordId: scope.recordId,
          sourceEventId: source.sourceEventId,
          validFromTick: Number(sourceRow.world_tick),
          createdAt: new Date(sourceRow.recorded_at).toISOString(),
        };
        // 按目标分组合并（同一角色同一批可能有多条 note）。
        const byCharacter = new Map<string, string[]>();
        for (const { characterInstanceId, note } of notes) {
          const list = byCharacter.get(characterInstanceId) ?? [];
          list.push(note);
          byCharacter.set(characterInstanceId, list);
        }
        for (const [characterInstanceId, incoming] of byCharacter) {
          // FOR UPDATE 读改写：与回合内 characterStateUpdates 写路径串行化，
          // 避免后台增长与回合写相互覆盖 profileNotes 数组。
          // active roster 约束：当前 active participant + instance.status
          // 'present'——异步 growth 不得写入已退场/退役角色（stale note）。
          // participant 显式限定 character 种类并匹配 world/worldline（
          // 当前 Record active character 的最小边界）。
          const current = await client.query<{ state: unknown }>(
            `SELECT instance.state
             FROM character_instances AS instance
             JOIN participants AS participant
               ON participant.workspace_id = instance.workspace_id
              AND participant.world_id = instance.world_id
              AND participant.worldline_id = instance.worldline_id
              AND participant.record_id = instance.record_id
              AND participant.character_instance_id = instance.id
              AND participant.participant_kind = 'character'
              AND participant.is_active = true
             WHERE instance.workspace_id = $1
               AND instance.world_id = $2
               AND instance.worldline_id = $3
               AND instance.record_id = $4
               AND instance.id = $5
               AND instance.status = 'present'
             FOR UPDATE OF instance`,
            [
              scope.workspaceId,
              scope.worldId,
              scope.worldlineId,
              scope.recordId,
              characterInstanceId,
            ],
          );
          const row = current.rows[0];
          // 非当前 Record 名册成员：结构性跳过（fail-closed）。
          if (!row) continue;
          const state = typeof row.state === "object" && row.state !== null
            ? row.state as Record<string, unknown>
            : {};
          const merged = mergeProfileNotes(
            state.profileNotes,
            incoming,
            provenance,
          );
          if (merged.length === 0) continue;
          // jsonb 浅合并只触 profileNotes 一个 key：profileSummary/
          // profileIdentity/profileEvidence 等既有键保持原样。
          // status 约束随 UPDATE 复述（SELECT 已持行锁，双保险）。
          await client.query(
            `UPDATE character_instances
             SET state = state || $6::jsonb,
                 updated_at = CURRENT_TIMESTAMP
             WHERE workspace_id = $1
               AND world_id = $2
               AND worldline_id = $3
               AND record_id = $4
               AND id = $5
               AND status = 'present'`,
            [
              scope.workspaceId,
              scope.worldId,
              scope.worldlineId,
              scope.recordId,
              characterInstanceId,
              JSON.stringify({ profileNotes: merged }),
            ],
          );
        }
        return true;
      });
    },
  };
}
