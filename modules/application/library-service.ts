import { createHash, randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import {
  withWorkspaceTransaction,
  type WorkspaceDatabase,
} from "../../database/postgres/workspace-transaction.ts";
import { normalizeWorldStyle } from "../style/world-style.ts";
import {
  BASE_AI_ASSET_QUANTITY,
  ensureWorldBaseRuleDefinitions,
  grantBaseAssetToInstance,
  grantBaseSkillsToInstances,
  grantCharacterCardSkills,
  readWorldStyle,
} from "./base-rule-definitions.ts";
import {
  composeDeterministicOpening,
  type FirstNightContext,
} from "./first-night.ts";
import { getPresetWorld } from "./preset-worlds.ts";
import type { WorldGenesisDraft } from "./world-genesis.ts";

export interface LibraryScope {
  workspaceId: string;
  principalId: string;
}

export interface LibraryRecord {
  id: string;
  title: string;
  status: string;
  timelineKind: "primary" | "retrospection" | "merged" | "branch";
  linkedRecordId: string | null;
}

export interface LibraryCharacter {
  id: string;
  name: string;
  role: string;
  summary: string;
  status: string;
  avatarFileId: string;
  /** 批次 S：角色来源（native / tavern），回答「谁在世界里」。 */
  sourceFormat: string;
}

export interface LibraryWorldline {
  id: string;
  label: string;
  status: string;
  parentWorldlineId: string | null;
}

export interface LibraryStory {
  id: string;
  title: string;
  status: string;
  /** 故事前提（T12 验收修正：故事视图按选中故事展示）。 */
  premise: string;
  records: LibraryRecord[];
}

export interface LibraryWorld {
  id: string;
  name: string;
  era: string;
  style: string;
  summary: string;
  status: string;
  /** 批次 S：当前 principal 在本世界的 membership.role（姿态开关状态）。 */
  membershipRole: string;
  /** 批次 T8：世界卡信息密度（聚合计数与最近活动时间，无 N+1）。 */
  storyCount: number;
  /** v37 H.2：分支世界线数（template 导出可用性提示）。 */
  branchCount: number;
  recordCount: number;
  characterCount: number;
  lastActiveAt: string | null;
  characters: LibraryCharacter[];
  worldlines: LibraryWorldline[];
  stories: LibraryStory[];
}

export interface LibrarySnapshot {
  worlds: LibraryWorld[];
}

/** branchRecord 输入：fork 缺省 = 源 record 当前 effective head。 */
export interface RecordBranchInput {
  sourceRecordId: string;
  /**
   * 分叉点（可选）。eventId 形式：必须是源 record 自己的已提交事件，
   * 服务端读出其 canonical (world_tick, world_ordinal)——viewer-local
   * delivery ordinal 不得冒充游标。worldTick/worldOrdinal 形式：必须
   * 命中源 record 一条已提交事件，或等于 record start。
   */
  fork?:
    | { eventId: string }
    | { worldTick: number; worldOrdinal: number };
  /** 新 worldline 标签（缺省「分支：{源 record 标题}」）。 */
  label?: string;
  storyTitle?: string;
  recordTitle?: string;
  /** 幂等键：重复调用返回首次拓扑，不重复创建。 */
  idempotencyKey?: string;
}

export interface RecordBranchResult {
  worldId: string;
  worldlineId: string;
  storyId: string;
  recordId: string;
  fork: { tick: number; ordinal: number };
  /** true = 幂等重放，命中既有拓扑，未写入新行。 */
  replayed: boolean;
}

export type LibraryCreateCommand =
  | { kind: "world"; name: string; era: string; summary: string }
  | { kind: "preset-world"; presetKey: string }
  | { kind: "story"; worldId: string; title: string; premise: string }
  | {
      kind: "record";
      storyId: string;
      title: string;
      retrospection?: boolean;
      mergeTargetRecordId?: string;
    }
  | {
      kind: "character";
      worldId: string;
      name: string;
      role: string;
      summary: string;
      /** 批次 S：非空时同事务把新角色装配进该记录的阵容（幂等）。 */
      attachRecordId?: string;
    }
  | {
      kind: "branch";
      worldId: string;
      label: string;
      /**
       * 分叉来源 record（必填）：空 worldline 幽灵路径已废弃——分支必须
       * 是「新 worldline + 新 story + 新 record」的可玩拓扑，fork 游标
       * 固定取源 record 当前 head（任意游标分叉走 /api/record/branch）。
       */
      sourceRecordId: string;
    }
  | { kind: "world-style"; worldId: string; style: string }
  /** 批次 S：既有世界切换本人姿态（入局 / 观察者）。 */
  | { kind: "player-stance"; worldId: string; stance: "player" | "observer" }
  /** 批次 T6：把既有角色（含导入卡）挂入既有记录阵容（幂等，含规则授权）。 */
  | { kind: "attach-character"; worldId: string; recordId: string; definitionId: string }
  /** Record 级角色席位可逆进退场；不删除 participant/instance。 */
  | {
      kind: "character-activity";
      worldId: string;
      recordId: string;
      definitionId: string;
      active: boolean;
    }
  /** 批次 T8：世界归档/恢复（owner-only，幂等；归档=封存只读）。 */
  | { kind: "world-archive"; worldId: string; archived: boolean }
  /** Record 级删除：owner-only；归档隐藏，不物理删除 append-only Events。 */
  | { kind: "delete-record"; worldId: string; recordId: string }
  /** 批次 T8：删除世界（owner-only，仅零事件世界可物理删除，fail-closed）。 */
  | { kind: "delete-world"; worldId: string };

export interface LibraryService {
  list(scope: LibraryScope): Promise<LibrarySnapshot>;
  create(
    scope: LibraryScope,
    command: LibraryCreateCommand,
  ): Promise<{ recordId?: string } | void>;
  duplicateRecord(
    scope: LibraryScope,
    sourceRecordId: string,
  ): Promise<{ worldId: string; storyId: string; recordId: string }>;
  /**
   * 从源 Record 创建可玩分支（BRANCH-TREE-RESEARCH §二）：单事务原子写入
   * 新 worldline（parent=源 worldline，fork=给定已提交游标）+ 新 story +
   * 新 record（timeline_kind='branch'，linked_record_id=源 record）+
   * record_heads + 场景/角色装配。events 不复制；源 record 不被改写。
   * idempotencyKey 非空时重复调用返回首次创建的拓扑（replayed=true）。
   */
  branchRecord(
    scope: LibraryScope,
    input: RecordBranchInput,
  ): Promise<RecordBranchResult>;
  /**
   * 启笔铸界：单事务原子创建世界 + 原初世界线 + owner 成员关系    * 同伴阵容 + 开幕故事 + 初始记录（含默认装配与初始场景）。
   */
  createGenesis(
    scope: LibraryScope,
    draft: WorldGenesisDraft,
  ): Promise<{ worldId: string; storyId: string; recordId: string }>;
}

export class LibraryServiceError extends Error {
  readonly code:
    | "INVALID_COMMAND"
    | "WORLD_NOT_FOUND"
    | "STORY_NOT_FOUND"
    | "WORLD_NOT_OWNED"
    | "WORLD_ARCHIVED"
    | "WORLD_NOT_EMPTY"
    | "WORLD_SELF_PLAY_ACTIVE"
    | "RECORD_NOT_FOUND"
    | "RECORD_ARCHIVED"
    | "RECORD_SELF_PLAY_ACTIVE"
    | "RECORD_TURN_ACTIVE"
    | "WORLD_READ_ONLY"
    | "INVALID_FORK";

  constructor(
    code:
      | "INVALID_COMMAND"
      | "WORLD_NOT_FOUND"
      | "STORY_NOT_FOUND"
      | "WORLD_NOT_OWNED"
      | "WORLD_ARCHIVED"
      | "WORLD_NOT_EMPTY"
      | "WORLD_SELF_PLAY_ACTIVE"
      | "RECORD_NOT_FOUND"
      | "RECORD_ARCHIVED"
      | "RECORD_SELF_PLAY_ACTIVE"
      | "RECORD_TURN_ACTIVE"
      | "WORLD_READ_ONLY"
      | "INVALID_FORK",
    message: string,
  ) {
    super(message);
    this.name = "LibraryServiceError";
    this.code = code;
  }
}

interface WorldRow extends QueryResultRow {
  world_id: string;
  world_name: string;
  era: string;
  style: string;
  summary: string;
  status: string;
  membership_role: string | null;
  story_count: number;
  branch_count: number;
  record_count: number;
  character_count: number;
  last_active_at: Date | string | null;
  characters: unknown;
  worldlines: unknown;
  stories: unknown;
}

/**
 * 批次 T10-B6 分池契约：readDb 承载 list 与受限角色可承载命令
 * （world-style/story/branch/world-archive/delete-world/delete-record）；writeDb 承载
 * owner 例外命令（world/character/record/attach-character/player-stance/
 * createGenesis——授权缺口见 T10-B6-LIBRARY-PERMISSIONS.md §三）。
 * 缺省 writeDb=readDb（单池等价既有行为）。每个命令事务单池原子完成。
 */
/**
 * 可见容器规则（ghost container 修复）：archived 容器不展示；有 Record 的
 * 容器，当全部 Record 均为 archived 且全部为非 primary（retrospection/
 * merged）时隐藏——空容器、含未归档 Record 的容器、含 primary Record
 * （即使已归档）的容器保留。不按标题前缀/ID 猜测；scope 条件完整。
 */
const VISIBLE_STORY_RULE = `(
    NOT EXISTS (
      SELECT 1 FROM records AS record_check
      WHERE record_check.workspace_id = world.workspace_id
        AND record_check.story_id = story.id
    )
    OR EXISTS (
      SELECT 1 FROM records AS record_check
      WHERE record_check.workspace_id = world.workspace_id
        AND record_check.story_id = story.id
        AND record_check.status <> 'archived'
    )
    OR EXISTS (
      SELECT 1 FROM records AS record_check
      WHERE record_check.workspace_id = world.workspace_id
        AND record_check.story_id = story.id
        AND record_check.timeline_kind = 'primary'
    )
  )`;

const VISIBLE_WORLDLINE_RULE = `(
    NOT EXISTS (
      SELECT 1 FROM records AS record_check
      WHERE record_check.workspace_id = world.workspace_id
        AND record_check.worldline_id = worldline.id
    )
    OR EXISTS (
      SELECT 1 FROM records AS record_check
      WHERE record_check.workspace_id = world.workspace_id
        AND record_check.worldline_id = worldline.id
        AND record_check.status <> 'archived'
    )
    OR EXISTS (
      SELECT 1 FROM records AS record_check
      WHERE record_check.workspace_id = world.workspace_id
        AND record_check.worldline_id = worldline.id
        AND record_check.timeline_kind = 'primary'
    )
  )`;

export function createPostgresLibraryService(
  database: WorkspaceDatabase,
  writeDatabase: WorkspaceDatabase = database,
): LibraryService {
  return {
    async list(scope) {
      return withWorkspaceTransaction(
        database,
        scope.workspaceId,
        async (client) => {
          const result = await client.query<WorldRow>(
            `
            SELECT
              world.id AS world_id,
              world.name AS world_name,
              COALESCE(world.settings->>'era', '') AS era,
              COALESCE(world.settings->>'style', '') AS style,
              world.summary,
              world.status,
              (
                SELECT count(*)::int
                FROM stories AS story
                WHERE story.workspace_id = world.workspace_id
                  AND story.world_id = world.id
                  AND story.status <> 'archived'
                  AND ${VISIBLE_STORY_RULE}
              ) AS story_count,
              (
                SELECT count(*)::int
                FROM records AS record
                WHERE record.workspace_id = world.workspace_id
                  AND record.world_id = world.id
                  AND record.status <> 'archived'
              ) AS record_count,
              (
                SELECT count(*)::int
                FROM worldlines AS branch
                WHERE branch.workspace_id = world.workspace_id
                  AND branch.world_id = world.id
                  AND branch.parent_worldline_id IS NOT NULL
              ) AS branch_count,
              (
                SELECT count(*)::int
                FROM character_definitions AS definition
                WHERE definition.workspace_id = world.workspace_id
                  AND definition.world_id = world.id
              ) AS character_count,
              (
                SELECT max(record.updated_at)
                FROM records AS record
                WHERE record.workspace_id = world.workspace_id
                  AND record.world_id = world.id
                  AND record.status <> 'archived'
              ) AS last_active_at,
              COALESCE(
                (
                  SELECT jsonb_agg(
                    jsonb_build_object(
                      'id', definition.id,
                      'name', definition.display_name,
                      'role', COALESCE(definition.profile->>'role', ''),
                      'summary', COALESCE(definition.profile->>'summary', ''),
                      'status', 'active',
                      'avatarFileId', COALESCE(definition.profile->>'avatar_file_id', ''),
                      'sourceFormat', COALESCE(definition.source_format, '')
                    )
                    ORDER BY definition.created_at ASC
                  )
                  FROM character_definitions AS definition
                  WHERE definition.workspace_id = world.workspace_id
                    AND definition.world_id = world.id
                ),
                '[]'::jsonb
              ) AS characters,
              COALESCE(
                (
                  SELECT jsonb_agg(
                    jsonb_build_object(
                      'id', worldline.id,
                      'label', worldline.label,
                      'status', worldline.status,
                      'parentWorldlineId', worldline.parent_worldline_id
                    )
                    ORDER BY worldline.created_at ASC
                  )
                  FROM worldlines AS worldline
                  WHERE worldline.workspace_id = world.workspace_id
                    AND worldline.world_id = world.id
                    AND worldline.status <> 'archived'
                    AND ${VISIBLE_WORLDLINE_RULE}
                ),
                '[]'::jsonb
              ) AS worldlines,
              COALESCE(
                (
                  SELECT jsonb_agg(
                    jsonb_build_object(
                      'id', story.id,
                      'title', story.title,
                      'status', story.status,
                      'premise', COALESCE(story.premise, ''),
                      'records', (
                        SELECT COALESCE(jsonb_agg(
                          jsonb_build_object(
                            'id', record.id,
                            'title', record.title,
                            'status', record.status,
                            'timelineKind', record.timeline_kind,
                            'linkedRecordId', record.linked_record_id
                          ) ORDER BY record.created_at ASC
                        ), '[]'::jsonb)
                        FROM records AS record
                        WHERE record.workspace_id = world.workspace_id
                          AND record.world_id = world.id
                          AND record.worldline_id = story.worldline_id
                          AND record.story_id = story.id
                          AND record.status <> 'archived'
                      )
                    )
                    ORDER BY story.created_at ASC
                  )
                  FROM stories AS story
                  WHERE story.workspace_id = world.workspace_id
                    AND story.world_id = world.id
                    AND story.status <> 'archived'
                    AND ${VISIBLE_STORY_RULE}
                ),
                '[]'::jsonb
              ) AS stories,
              (
                SELECT membership.role
                FROM player_world_memberships AS membership
                WHERE membership.workspace_id = world.workspace_id
                  AND membership.world_id = world.id
                  AND membership.principal_id = $2
                LIMIT 1
              ) AS membership_role
            FROM worlds AS world
            WHERE world.workspace_id = $1
              AND EXISTS (
                SELECT 1
                FROM player_world_memberships AS visible
                WHERE visible.workspace_id = world.workspace_id
                  AND visible.world_id = world.id
                  AND visible.principal_id = $2
              )
            ORDER BY
              CASE WHEN world.status = 'archived' THEN 1 ELSE 0 END ASC,
              last_active_at DESC NULLS LAST,
              world.created_at ASC
            `,
            [scope.workspaceId, scope.principalId],
          );
          const worlds = result.rows.map((row) => normalizeWorld(row));
          return { worlds };
        },
        { readOnly: true },
      );
    },

    async create(scope, command) {
      // T10-B6：按命令授权面分池（例外枚举见模块头规范引用）。
      const pool = OWNER_POOL_COMMAND_KINDS.has(command.kind)
        ? writeDatabase
        : database;
      return withWorkspaceTransaction(
        pool,
        scope.workspaceId,
        async (client) => {
          if (command.kind === "world") {
            const worldId = `world_${randomUUID().replaceAll("-", "").slice(0, 18)}`;
            const worldlineId = `worldline_${randomUUID().replaceAll("-", "").slice(0, 18)}`;
            const settings = JSON.stringify({ era: command.era.trim() });
            await client.query(
              `INSERT INTO worlds (
                 workspace_id, id, name, status, calendar_id, summary, settings
               ) VALUES ($1, $2, $3, 'active', 'native_calendar', $4, $5::jsonb)`,
              [scope.workspaceId, worldId, command.name.trim(), command.summary.trim(), settings],
            );
            await client.query(
              `INSERT INTO worldlines (
                 workspace_id, world_id, id, label, status, head_tick, head_ordinal
               ) VALUES ($1, $2, $3, '原初世界线', 'active', 0, 0)`,
              [scope.workspaceId, worldId, worldlineId],
            );
            await client.query(
              `INSERT INTO player_world_memberships (
                 workspace_id, world_id, principal_id, role,
                 omniscient_player_character, can_view_dynamic_knowledge
               ) VALUES ($1, $2, $3, 'owner', true, true)
               ON CONFLICT (workspace_id, world_id, principal_id) DO NOTHING`,
              [scope.workspaceId, worldId, scope.principalId],
            );
            const starter = await createStarterStoryAndRecord(
              client,
              scope,
              { world_id: worldId, worldline_id: worldlineId },
              command.name.trim(),
              command.summary.trim(),
            );
            return { recordId: starter.recordId };
          }

          if (command.kind === "preset-world") {
            const preset = getPresetWorld(command.presetKey);
            if (!preset) {
              throw new LibraryServiceError("INVALID_COMMAND", "Unknown preset world key.");
            }
            const ids = await this.createGenesis(scope, preset.draft);
            return { recordId: ids.recordId };
          }

          if (command.kind === "world-style") {
            // 批次 T10-B6：世界全局设置为 owner-only（矩阵 §二）。
            await assertWorldOwner(client, scope, command.worldId);
            // v37 §D.0：C 面 world-mutating 写——gateWorldWrite（KEY
            // SHARE）持锁后同事务同行 UPDATE（锁内重读，archived 拒绝）。
            await assertWorldWritable(client, scope.workspaceId, command.worldId);
            const style = normalizeWorldStyle(command.style);
            const updated = await client.query(
              `UPDATE worlds
               SET settings = settings || $3::jsonb
               WHERE workspace_id = $1 AND id = $2`,
              [
                scope.workspaceId,
                command.worldId,
                JSON.stringify({ style }),
              ],
            );
            if (updated.rowCount !== 1) {
              throw new LibraryServiceError("WORLD_NOT_FOUND", "World not found.");
            }
            return;
          }
          if (command.kind === "character") {
            // 批次 T10-B6：内容写要求 owner/player 成员（observer 只读）。
            await assertWorldContentMember(client, scope, command.worldId);
            // 批次 T8：归档世界不可开新局（含添角色）。
            await assertWorldWritable(client, scope.workspaceId, command.worldId);
            const definitionId = `char_def_${randomUUID().replaceAll("-", "").slice(0, 18)}`;
            await client.query(
              `INSERT INTO character_definitions (
                 workspace_id, world_id, id, display_name, source_format, profile
               ) VALUES ($1, $2, $3, $4, 'native', $5::jsonb)`,
              [
                scope.workspaceId,
                command.worldId,
                definitionId,
                command.name.trim(),
                JSON.stringify({
                  role: command.role.trim(),
                  summary: command.summary.trim(),
                }),
              ],
            );
            if (command.attachRecordId?.trim()) {
              await attachCharacterToRecord(
                client,
                scope,
                command.worldId,
                command.attachRecordId.trim(),
                definitionId,
              );
            }
            return;
          }

          if (command.kind === "player-stance") {
            // 批次 T10-B6：只能切换本人在该世界的姿态；无 membership 安全 404
            //（不创建席位、不接受 body 指定他人）。
            await assertWorldMember(client, scope, command.worldId);
            // v37 §D.0：C 面内容写 gate（archived 拒绝，锁内重读）。
            await assertWorldWritable(client, scope.workspaceId, command.worldId);
            await applyPlayerStance(
              client,
              scope,
              command.worldId,
              command.stance,
            );
            return;
          }
          if (command.kind === "attach-character") {
            // 批次 T10-B6：内容写要求 owner/player 成员。
            await assertWorldContentMember(client, scope, command.worldId);
            // 批次 T6：既有角色挂入既有记录——定义必须属于该世界（fail-closed）；
            // 挂入（含授权）复用 attachCharacterToRecord（幂等查重）。
            await assertWorldWritable(client, scope.workspaceId, command.worldId);
            const definition = await client.query<{ id: string }>(
              `SELECT id
               FROM character_definitions
               WHERE workspace_id = $1 AND world_id = $2 AND id = $3`,
              [scope.workspaceId, command.worldId, command.definitionId],
            );
            if (!definition.rows[0]) {
              throw new LibraryServiceError(
                "WORLD_NOT_FOUND",
                "Character not found in this world.",
              );
            }
            await attachCharacterToRecord(
              client,
              scope,
              command.worldId,
              command.recordId,
              command.definitionId,
            );
            return;
          }
          if (command.kind === "character-activity") {
            await assertWorldContentMember(client, scope, command.worldId);
            await assertWorldWritable(client, scope.workspaceId, command.worldId);
            await setCharacterActivity(
              client,
              scope,
              command.worldId,
              command.recordId,
              command.definitionId,
              command.active,
            );
            return;
          }

          if (command.kind === "delete-record") {
            // Record 删除是 owner-only 的隐藏归档：保留 append-only Events，
            // 避免破坏 worldline 全局游标与历史引用。
            await assertWorldOwner(client, scope, command.worldId);
            const record = await client.query<{ status: string }>(
              `SELECT status
               FROM records
               WHERE workspace_id = $1 AND world_id = $2 AND id = $3
               FOR UPDATE`,
              [scope.workspaceId, command.worldId, command.recordId],
            );
            const recordRow = record.rows[0];
            if (!recordRow) {
              throw new LibraryServiceError("RECORD_NOT_FOUND", "Record not found.");
            }
            if (recordRow.status === "archived") return;
            await assertNoActiveRecordSelfPlay(
              client,
              scope.workspaceId,
              command.recordId,
            );
            await assertNoActiveRecordTurn(
              client,
              scope.workspaceId,
              command.recordId,
            );
            const archived = await client.query(
              `UPDATE records
               SET status = 'archived', updated_at = CURRENT_TIMESTAMP
               WHERE workspace_id = $1 AND world_id = $2 AND id = $3
                 AND status <> 'archived'`,
              [scope.workspaceId, command.worldId, command.recordId],
            );
            if (archived.rowCount !== 1) {
              throw new LibraryServiceError("RECORD_NOT_FOUND", "Record not found.");
            }
            await client.query(
              `UPDATE accounts
               SET last_record_id = NULL
               WHERE workspace_id = $1 AND last_record_id = $2`,
              [scope.workspaceId, command.recordId],
            );
            return;
          }

          if (command.kind === "world-archive") {
            // 批次 T8：归档/恢复（owner-only，幂等）。归档前防护活动自演会话
            // （账本行随记录 CASCADE 消失会让在途拍无处收尾）。
            // v37 §D.0：K 面状态转换——worlds 行 FOR UPDATE 单锁点
            // （与内容面写者的 KEY SHARE 互斥），活动自演防护移入锁内复查。
            await assertWorldOwner(client, scope, command.worldId);
            const worldLock = await client.query<{ status: string }>(
              `SELECT status FROM worlds
               WHERE workspace_id = $1 AND id = $2
               FOR UPDATE`,
              [scope.workspaceId, command.worldId],
            );
            if (!worldLock.rows[0]) {
              throw new LibraryServiceError("WORLD_NOT_FOUND", "World not found.");
            }
            if (command.archived) {
              await assertNoActiveSelfPlay(client, scope.workspaceId, command.worldId);
            }
            await client.query(
              `UPDATE worlds
               SET status = $3, updated_at = CURRENT_TIMESTAMP
               WHERE workspace_id = $1 AND id = $2`,
              [
                scope.workspaceId,
                command.worldId,
                command.archived ? "archived" : "active",
              ],
            );
            return;
          }

          if (command.kind === "delete-world") {
            // 批次 T8：受限物理删除——owner-only、活动自演防护、仅零事件世界
            // （有事件世界撞 append-only 触发器与 NO ACTION 引用网，fail-closed
            // 引导归档）。CASCADE 带走全部级联子表；accounts 打开记忆复位。
            // v37 §D.0：K 面状态转换——worlds 行 FOR UPDATE 在前。
            await assertWorldOwner(client, scope, command.worldId);
            const worldLock = await client.query<{ id: string }>(
              `SELECT id FROM worlds
               WHERE workspace_id = $1 AND id = $2
               FOR UPDATE`,
              [scope.workspaceId, command.worldId],
            );
            if (!worldLock.rows[0]) {
              throw new LibraryServiceError("WORLD_NOT_FOUND", "World not found.");
            }
            await assertNoActiveSelfPlay(client, scope.workspaceId, command.worldId);
            // 仅零记录世界可物理删除：记录装配即写 character_skills/assets 等
            // 账本行，经 NO ACTION 引用网（character_skills→skill_definitions、
            // participants/command_inbox→memberships）与世界分支交错，append-only
            // 触发器与授权边界使运行时无法物理清除——fail-closed 引导归档。
            const records = await client.query<{ count: number }>(
              `SELECT count(*)::int AS count
               FROM records
               WHERE workspace_id = $1 AND world_id = $2`,
              [scope.workspaceId, command.worldId],
            );
            if ((records.rows[0]?.count ?? 0) > 0) {
              throw new LibraryServiceError(
                "WORLD_NOT_EMPTY",
                "Worlds with records cannot be deleted; archive it instead.",
              );
            }
            // worlds DELETE 的 CASCADE 单分支带走 worldlines/stories/
            // memberships/definitions/files 等全部直接子表。
            const deleted = await client.query(
              `DELETE FROM worlds WHERE workspace_id = $1 AND id = $2`,
              [scope.workspaceId, command.worldId],
            );
            if (deleted.rowCount !== 1) {
              throw new LibraryServiceError("WORLD_NOT_FOUND", "World not found.");
            }
            await client.query(
              `UPDATE accounts
               SET last_world_id = NULL
               WHERE workspace_id = $1 AND last_world_id = $2`,
              [scope.workspaceId, command.worldId],
            );
            return;
          }

          if (command.kind === "branch") {
            // 分支 = 可玩拓扑（新 worldline + story + record），fork 固定
            // 取源 record 当前 head；空 worldline 幽灵路径已废弃。任意
            // 游标分叉走 branchRecord（/api/record/branch）。
            const sourceRecordId = command.sourceRecordId?.trim() ?? "";
            if (!sourceRecordId) {
              throw new LibraryServiceError(
                "INVALID_COMMAND",
                "branch requires sourceRecordId.",
              );
            }
            await createRecordBranchInTransaction(client, scope, {
              sourceRecordId,
              label: command.label,
              idempotencyKey: `library-branch:${scope.principalId}:${sourceRecordId}:${command.label.trim()}`,
            });
            return;
          }

          if (command.kind === "story") {
            // 批次 T10-B6：内容写要求 owner/player 成员。
            await assertWorldContentMember(client, scope, command.worldId);
            // 批次 T8：归档世界不可开新局。
            await assertWorldWritable(client, scope.workspaceId, command.worldId);
            const world = await client.query<{ worldline_id: string }>(
              `SELECT worldline.id AS worldline_id
               FROM worlds AS world
               JOIN worldlines AS worldline
                 ON worldline.workspace_id = world.workspace_id
                AND worldline.world_id = world.id
               WHERE world.workspace_id = $1 AND world.id = $2
               ORDER BY worldline.created_at ASC
               LIMIT 1`,
              [scope.workspaceId, command.worldId],
            );
            const worldlineId = world.rows[0]?.worldline_id;
            if (!worldlineId) throw new LibraryServiceError("WORLD_NOT_FOUND", "World not found.");
            await client.query(
              `INSERT INTO stories (
                 workspace_id, world_id, worldline_id, id, title, status,
                 premise, start_tick, start_ordinal
               ) VALUES ($1, $2, $3, $4, $5, 'draft', $6, 0, 0)`,
              [
                scope.workspaceId,
                command.worldId,
                worldlineId,
                `story_${randomUUID().replaceAll("-", "").slice(0, 18)}`,
                command.title.trim(),
                command.premise.trim(),
              ],
            );
            return;
          }

          const story = await client.query<{
            world_id: string;
            worldline_id: string;
          }>(
            `SELECT world_id, worldline_id
             FROM stories
             WHERE workspace_id = $1 AND id = $2`,
            [scope.workspaceId, command.storyId],
          );
          const storyRow = story.rows[0];
          if (!storyRow) throw new LibraryServiceError("STORY_NOT_FOUND", "Story not found.");
          // 批次 T10-B6：内容写要求 owner/player 成员。
          await assertWorldContentMember(client, scope, storyRow.world_id);
          // 批次 T8：归档世界不可开新局（含新记录）。
          await assertWorldWritable(client, scope.workspaceId, storyRow.world_id);
          const recordId = `record_${randomUUID().replaceAll("-", "").slice(0, 18)}`;
          const timelineKind = command.mergeTargetRecordId
            ? "merged"
            : command.retrospection
              ? "retrospection"
              : "primary";
          // 玩家角色定义（演示种子 char_def_player 与装配自动创建的
          // char_def_player_<world>）代表人类玩家本人，不得作为自定义
          // AI 角色重复装配，否则新记录阵容会出现重复的玩家角色。
          const customCharacters = await client.query<{
            id: string;
            name: string;
            role: string;
          }>(
            `SELECT
               id,
               display_name AS name,
               COALESCE(profile->>'role', '') AS role
             FROM character_definitions
             WHERE workspace_id = $1 AND world_id = $2
               AND id <> 'char_def_player'
               AND NOT starts_with(id, 'char_def_player_')
             ORDER BY created_at ASC`,
            [scope.workspaceId, storyRow.world_id],
          );
          await client.query(
            `INSERT INTO records (
               workspace_id, world_id, worldline_id, story_id, id, title,
               status, start_tick, start_ordinal, timeline_kind, linked_record_id
             ) VALUES ($1, $2, $3, $4, $5, $6, 'draft', 0, 0, $7, $8)`,
            [
              scope.workspaceId,
              storyRow.world_id,
              storyRow.worldline_id,
              command.storyId,
              recordId,
              command.title.trim(),
              timelineKind,
              command.mergeTargetRecordId ?? null,
            ],
          );
          await client.query(
            `INSERT INTO record_heads (
               workspace_id, world_id, worldline_id, record_id,
               record_version, next_record_ordinal, last_world_tick,
               last_world_ordinal
             ) VALUES ($1, $2, $3, $4, 0, 0, 0, 0)`,
            [
              scope.workspaceId,
              storyRow.world_id,
              storyRow.worldline_id,
              recordId,
              ],
            );
          await assembleDefaultRecord(
            client,
            scope,
            storyRow,
            recordId,
            customCharacters.rows,
          );
        },
      );
    },

    async createGenesis(scope, draft) {
      return withWorkspaceTransaction(
        database,
        scope.workspaceId,
        async (client) => {
          const worldId = `world_${randomUUID().replaceAll("-", "").slice(0, 18)}`;
          const worldlineId = `worldline_${randomUUID().replaceAll("-", "").slice(0, 18)}`;
          const storyId = `story_${randomUUID().replaceAll("-", "").slice(0, 18)}`;
          const recordId = `record_${randomUUID().replaceAll("-", "").slice(0, 18)}`;

          await client.query(
            `INSERT INTO worlds (
               workspace_id, id, name, status, calendar_id, summary, settings
             ) VALUES ($1, $2, $3, 'active', 'native_calendar', $4, $5::jsonb)`,
            [
              scope.workspaceId,
              worldId,
              draft.world.name,
              draft.world.summary,
              JSON.stringify({
                era: draft.world.era,
                style: draft.style,
                weather: draft.scene.weather,
                tension: draft.scene.tension,
              }),
            ],
          );
          await client.query(
            `INSERT INTO worldlines (
               workspace_id, world_id, id, label, status, head_tick, head_ordinal
             ) VALUES ($1, $2, $3, '原初世界线', 'active', 0, 0)`,
            [scope.workspaceId, worldId, worldlineId],
          );
          // 批次 S：观察者姿态 → membership role='observer'（omniscient 仍 true，
          // 其不可变约束不受影响）；入局仍为 owner。
          const observer = draft.playerStance === "observer";
          await client.query(
            `INSERT INTO player_world_memberships (
               workspace_id, world_id, principal_id, role,
               omniscient_player_character, can_view_dynamic_knowledge
             ) VALUES ($1, $2, $3, $4, true, true)
             ON CONFLICT (workspace_id, world_id, principal_id) DO NOTHING`,
            [scope.workspaceId, worldId, scope.principalId, observer ? "observer" : "owner"],
          );
          const companions = draft.companions.slice(0, 2).map((companion) => ({
            id: `char_def_${randomUUID().replaceAll("-", "").slice(0, 18)}`,
            name: companion.name,
            role: companion.role,
          }));
          for (const [index, companion] of draft.companions.slice(0, 2).entries()) {
            await client.query(
              `INSERT INTO character_definitions (
                 workspace_id, world_id, id, display_name, source_format, profile
               ) VALUES ($1, $2, $3, $4, 'native', $5::jsonb)`,
              [
                scope.workspaceId,
                worldId,
                companions[index]!.id,
                companion.name,
                JSON.stringify({ role: companion.role, summary: companion.summary }),
              ],
            );
          }
          await client.query(
            `INSERT INTO stories (
               workspace_id, world_id, worldline_id, id, title, status,
               premise, start_tick, start_ordinal
             ) VALUES ($1, $2, $3, $4, $5, 'active', $6, 0, 0)`,
            [
              scope.workspaceId,
              worldId,
              worldlineId,
              storyId,
              draft.story.title,
              draft.story.premise,
            ],
          );
          await client.query(
            `INSERT INTO records (
               workspace_id, world_id, worldline_id, story_id, id, title,
               status, start_tick, start_ordinal, timeline_kind, linked_record_id
             ) VALUES ($1, $2, $3, $4, $5, $6, 'active', 0, 0, 'primary', NULL)`,
            [
              scope.workspaceId,
              worldId,
              worldlineId,
              storyId,
              recordId,
              draft.record.title,
            ],
          );
          await client.query(
            `INSERT INTO record_heads (
               workspace_id, world_id, worldline_id, record_id,
               record_version, next_record_ordinal, last_world_tick,
               last_world_ordinal
             ) VALUES ($1, $2, $3, $4, 0, 0, 0, 0)`,
            [scope.workspaceId, worldId, worldlineId, recordId],
          );
          const assembled = await assembleDefaultRecord(
            client,
            scope,
            { world_id: worldId, worldline_id: worldlineId },
            recordId,
            companions,
            {
              playerRole: draft.playerRole,
              observer,
              scene: {
                title: "开幕",
                location: draft.scene.location,
                tension: draft.scene.tension,
                objective: draft.scene.objective,
              },
            },
          );
          // 批次 T1：开场旁白永远落库——opening 优先，否则由草稿场景字段
          // 确定性合成风格化定格句；同事务写入初夜 pending 状态行与上下文快照。
          const firstNightContext: FirstNightContext = {
            world: {
              name: draft.world.name,
              era: draft.world.era,
              summary: draft.world.summary,
            },
            style: draft.style,
            story: { title: draft.story.title, premise: draft.story.premise },
            playerRole: draft.playerRole,
            playerName: (await resolvePlayerPersona(client, scope, worldId)).name,
            playerStance: draft.playerStance,
            companions: draft.companions.slice(0, 2).map((companion) => ({
              name: companion.name,
              role: companion.role,
              summary: companion.summary,
            })),
            scene: {
              location: draft.scene.location,
              weather: draft.scene.weather,
              tension: draft.scene.tension,
              objective: draft.scene.objective,
            },
            opening: draft.opening,
          };
          await insertOpeningEvent(
            client,
            scope,
            { world_id: worldId, worldline_id: worldlineId },
            recordId,
            assembled,
            composeDeterministicOpening(firstNightContext),
          );
          await client.query(
            `INSERT INTO record_first_nights (
               workspace_id, record_id, world_id, state, attempts, context
             ) VALUES ($1, $2, $3, 'pending', 0, $4::jsonb)`,
            [
              scope.workspaceId,
              recordId,
              worldId,
              JSON.stringify(firstNightContext),
            ],
          );
          return { worldId, storyId, recordId };
        },
      );
    },

    async duplicateRecord(scope, sourceRecordId) {
      return withWorkspaceTransaction(
        writeDatabase,
        scope.workspaceId,
        async (client) => duplicateRecordInTransaction(client, scope, sourceRecordId),
      );
    },
    async branchRecord(scope, input) {
      return withWorkspaceTransaction(
        writeDatabase,
        scope.workspaceId,
        async (client) => createRecordBranchInTransaction(client, scope, input),
      );
    },
  };
}

async function createStarterStoryAndRecord(
  client: PoolClient,
  scope: LibraryScope,
  world: { world_id: string; worldline_id: string },
  worldName: string,
  premise: string,
): Promise<{ storyId: string; recordId: string }> {
  const storyId = `story_${randomUUID().replaceAll("-", "").slice(0, 18)}`;
  const recordId = `record_${randomUUID().replaceAll("-", "").slice(0, 18)}`;
  await client.query(
    `INSERT INTO stories (
       workspace_id, world_id, worldline_id, id, title, status,
       premise, start_tick, start_ordinal
     ) VALUES ($1, $2, $3, $4, $5, 'active', $6, 0, 0)`,
    [
      scope.workspaceId,
      world.world_id,
      world.worldline_id,
      storyId,
      `${worldName || "新世界"} · 序章`,
      premise,
    ],
  );
  await client.query(
    `INSERT INTO records (
       workspace_id, world_id, worldline_id, story_id, id, title,
       status, start_tick, start_ordinal, timeline_kind, linked_record_id
     ) VALUES ($1, $2, $3, $4, $5, '开幕', 'active', 0, 0, 'primary', NULL)`,
    [scope.workspaceId, world.world_id, world.worldline_id, storyId, recordId],
  );
  await client.query(
    `INSERT INTO record_heads (
       workspace_id, world_id, worldline_id, record_id,
       record_version, next_record_ordinal, last_world_tick, last_world_ordinal
     ) VALUES ($1, $2, $3, $4, 0, 0, 0, 0)`,
    [scope.workspaceId, world.world_id, world.worldline_id, recordId],
  );
  await assembleDefaultRecord(
    client,
    scope,
    world,
    recordId,
    [],
    { scene: { title: "开幕" } },
  );
  return { storyId, recordId };
}

type DuplicateSourceRow = QueryResultRow & {
  world_id: string;
  worldline_id: string;
  story_id: string;
  record_title: string;
  story_title: string;
  story_premise: string;
  fork_tick: string;
  fork_ordinal: string;
  scene_title: string;
  scene_location: string;
  scene_objective: string;
  scene_tension: string;
  scene_weather: string;
  scene_display_time: string;
  observer: boolean;
  player_role: string;
};

async function duplicateRecordInTransaction(
  client: PoolClient,
  scope: LibraryScope,
  sourceRecordId: string,
): Promise<{ worldId: string; storyId: string; recordId: string }> {
  const source = await client.query<DuplicateSourceRow>(
    `SELECT
       record.world_id,
       record.worldline_id,
       record.story_id,
       record.title AS record_title,
       story.title AS story_title,
       story.premise AS story_premise,
       record.start_tick::text AS fork_tick,
       record.start_ordinal::text AS fork_ordinal,
       COALESCE(first_scene.title, '') AS scene_title,
       COALESCE(first_scene.location, '') AS scene_location,
       COALESCE(first_scene.objective, '') AS scene_objective,
       COALESCE(first_scene.tension, '') AS scene_tension,
       COALESCE(first_scene.weather, '') AS scene_weather,
       COALESCE(first_scene.display_time, '') AS scene_display_time,
       EXISTS (
         SELECT 1 FROM participants AS narrator
         WHERE narrator.workspace_id = record.workspace_id
           AND narrator.record_id = record.id
           AND narrator.participant_kind = 'narrator'
       ) AS observer,
       COALESCE(player_definition.profile->>'role', '') AS player_role
     FROM records AS record
     JOIN stories AS story
       ON story.workspace_id = record.workspace_id
      AND story.world_id = record.world_id
      AND story.worldline_id = record.worldline_id
      AND story.id = record.story_id
     LEFT JOIN LATERAL (
       SELECT title, location, objective, tension, weather, display_time
       FROM scenes
       WHERE workspace_id = record.workspace_id
         AND world_id = record.world_id
         AND worldline_id = record.worldline_id
         AND record_id = record.id
       ORDER BY start_tick ASC, start_ordinal ASC, created_at ASC
       LIMIT 1
     ) AS first_scene ON true
     LEFT JOIN LATERAL (
       SELECT definition.profile
       FROM participants AS participant
       JOIN character_instances AS instance
         ON instance.workspace_id = participant.workspace_id
        AND instance.id = participant.character_instance_id
       JOIN character_continuities AS continuity
         ON continuity.workspace_id = instance.workspace_id
        AND continuity.id = instance.continuity_id
       JOIN character_definitions AS definition
         ON definition.workspace_id = instance.workspace_id
        AND definition.id = continuity.definition_id
       WHERE participant.workspace_id = record.workspace_id
         AND participant.record_id = record.id
         AND participant.participant_kind = 'character'
         AND participant.controller_mode = 'human'
       LIMIT 1
     ) AS player_definition ON true
     WHERE record.workspace_id = $1 AND record.id = $2
       AND record.status <> 'archived'`,
    [scope.workspaceId, sourceRecordId],
  );
  const sourceRow = source.rows[0];
  if (!sourceRow) throw new LibraryServiceError("WORLD_NOT_FOUND", "Record not found.");
  await assertWorldContentMember(client, scope, sourceRow.world_id);
  await assertWorldWritable(client, scope.workspaceId, sourceRow.world_id);

  const sourceCharacters = await client.query<{
    id: string;
    name: string;
    role: string;
  }>(
    `SELECT DISTINCT
       definition.id,
       definition.display_name AS name,
       COALESCE(definition.profile->>'role', '') AS role
     FROM participants AS participant
     JOIN character_instances AS instance
       ON instance.workspace_id = participant.workspace_id
      AND instance.id = participant.character_instance_id
     JOIN character_continuities AS continuity
       ON continuity.workspace_id = instance.workspace_id
      AND continuity.id = instance.continuity_id
     JOIN character_definitions AS definition
       ON definition.workspace_id = instance.workspace_id
      AND definition.id = continuity.definition_id
     WHERE participant.workspace_id = $1
       AND participant.record_id = $2
       AND participant.participant_kind = 'character'
       AND participant.controller_mode = 'ai'
     ORDER BY definition.id ASC`,
    [scope.workspaceId, sourceRecordId],
  );

  const forkTick = Math.max(0, Number(sourceRow.fork_tick) || 0);
  const forkOrdinal = Math.max(0, Number(sourceRow.fork_ordinal) || 0);
  const worldlineId = `worldline_retro_${randomUUID().replaceAll("-", "").slice(0, 18)}`;
  const storyId = `story_retro_${randomUUID().replaceAll("-", "").slice(0, 18)}`;
  const recordId = `record_retro_${randomUUID().replaceAll("-", "").slice(0, 18)}`;
  await client.query(
    `INSERT INTO worldlines (
       workspace_id, world_id, id, label, status,
       parent_worldline_id, fork_tick, fork_ordinal, head_tick, head_ordinal
     ) VALUES ($1, $2, $3, $4, 'active', $5, $6, $7, $6, $7)`,
    [
      scope.workspaceId,
      sourceRow.world_id,
      worldlineId,
      `回溯：${sourceRow.record_title}`,
      sourceRow.worldline_id,
      forkTick,
      forkOrdinal,
    ],
  );
  await client.query(
    `INSERT INTO stories (
       workspace_id, world_id, worldline_id, id, title, status,
       premise, start_tick, start_ordinal
     ) VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8)`,
    [
      scope.workspaceId,
      sourceRow.world_id,
      worldlineId,
      storyId,
      `重演：${sourceRow.story_title}`,
      sourceRow.story_premise,
      forkTick,
      forkOrdinal,
    ],
  );
  await client.query(
    `INSERT INTO records (
       workspace_id, world_id, worldline_id, story_id, id, title,
       status, start_tick, start_ordinal, timeline_kind, linked_record_id
     ) VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8, 'retrospection', $9)`,
    [
      scope.workspaceId,
      sourceRow.world_id,
      worldlineId,
      storyId,
      recordId,
      `重演：${sourceRow.record_title}`,
      forkTick,
      forkOrdinal,
      sourceRecordId,
    ],
  );
  await client.query(
    `INSERT INTO record_heads (
       workspace_id, world_id, worldline_id, record_id,
       record_version, next_record_ordinal, last_world_tick, last_world_ordinal
     ) VALUES ($1, $2, $3, $4, 0, 0, $5, $6)`,
    [scope.workspaceId, sourceRow.world_id, worldlineId, recordId, forkTick, forkOrdinal],
  );
  await assembleDefaultRecord(
    client,
    scope,
    { world_id: sourceRow.world_id, worldline_id: worldlineId },
    recordId,
    sourceCharacters.rows,
    {
      observer: sourceRow.observer,
      playerRole: sourceRow.player_role,
      startTick: forkTick,
      startOrdinal: forkOrdinal,
      inheritanceCutoffTick: forkTick,
      inheritanceCutoffOrdinal: forkOrdinal,
      scene: {
        title: sourceRow.scene_title || "重演",
        location: sourceRow.scene_location,
        tension: sourceRow.scene_tension,
        objective: sourceRow.scene_objective,
        weather: sourceRow.scene_weather,
        displayTime: sourceRow.scene_display_time,
      },
    },
  );
  return { worldId: sourceRow.world_id, storyId, recordId };
}

/** 分支文本入参上限（label/story/record 标题）；超长 fail-closed。 */
const MAX_BRANCH_TEXT_LENGTH = 80;
const MAX_BRANCH_IDEMPOTENCY_KEY_LENGTH = 128;

function normalizeBranchText(
  value: string | undefined,
  fallback: string,
): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return fallback;
  if (trimmed.length > MAX_BRANCH_TEXT_LENGTH) {
    throw new LibraryServiceError(
      "INVALID_COMMAND",
      "Branch text exceeds the length limit.",
    );
  }
  return trimmed;
}

function compareBranchCursor(
  a: { tick: number; ordinal: number },
  b: { tick: number; ordinal: number },
): number {
  return a.tick - b.tick || a.ordinal - b.ordinal;
}

/**
 * 创建可玩分支（BRANCH-TREE-RESEARCH §二 canonical 语义）。
 *
 * 与 duplicate（重演）的差异：fork 游标可指定到源 record 的任意已提交
 * 事件边界（duplicate 恒为源 record 起点）；新 record 的
 * timeline_kind='branch'——不进入 retrospection 的「写入正史」流程；
 * 场景继承取「覆盖 fork 点的场景」（最近一个 start<=fork），而非恒为
 * 首个 scene。events 不复制、源 record 不改写。
 *
 * 锁序（world-write-gate.ts:9-13）：worlds(KEY SHARE) → records(FOR
 * UPDATE) → record_heads → worldlines/stories/records 插入。源 record
 * FOR UPDATE 同时是幂等/并发的串行点：同一源 record 的并发分叉在此
 * 排队，check-then-insert 无竞态。
 */
async function createRecordBranchInTransaction(
  client: PoolClient,
  scope: LibraryScope,
  input: RecordBranchInput,
): Promise<RecordBranchResult> {
  const sourceRecordId = input.sourceRecordId?.trim() ?? "";
  if (!sourceRecordId) {
    throw new LibraryServiceError("INVALID_COMMAND", "sourceRecordId is required.");
  }
  const idempotencyKey = input.idempotencyKey?.trim() ?? "";
  if (idempotencyKey.length > MAX_BRANCH_IDEMPOTENCY_KEY_LENGTH) {
    throw new LibraryServiceError("INVALID_COMMAND", "idempotencyKey is too long.");
  }

  // ① 未锁探测：定位源 record 所属世界（进入锁序前的作用域解析）。
  const probe = await client.query<{ world_id: string }>(
    `SELECT world_id FROM records WHERE workspace_id = $1 AND id = $2`,
    [scope.workspaceId, sourceRecordId],
  );
  const worldId = probe.rows[0]?.world_id;
  if (!worldId) {
    throw new LibraryServiceError("RECORD_NOT_FOUND", "Record not found.");
  }

  // ② 内容写门禁 + world 写 gate（KEY SHARE，与归档互斥）。
  await assertWorldContentMember(client, scope, worldId);
  await assertWorldWritable(client, scope.workspaceId, worldId);

  // ③ 锁内重读源 record（FOR UPDATE）：归档源拒绝；故事标题/前提随锁读取。
  const source = await client.query<{
    worldline_id: string;
    story_id: string;
    record_title: string;
    record_status: string;
    story_title: string;
    story_premise: string;
    start_tick: string;
    start_ordinal: string;
    observer: boolean;
    player_role: string;
  }>(
    `SELECT
       record.worldline_id,
       record.story_id,
       record.title AS record_title,
       record.status AS record_status,
       story.title AS story_title,
       story.premise AS story_premise,
       record.start_tick::text,
       record.start_ordinal::text,
       EXISTS (
         SELECT 1 FROM participants AS narrator
         WHERE narrator.workspace_id = record.workspace_id
           AND narrator.record_id = record.id
           AND narrator.participant_kind = 'narrator'
       ) AS observer,
       COALESCE(player_definition.profile->>'role', '') AS player_role
     FROM records AS record
     JOIN stories AS story
       ON story.workspace_id = record.workspace_id
      AND story.world_id = record.world_id
      AND story.worldline_id = record.worldline_id
      AND story.id = record.story_id
     LEFT JOIN LATERAL (
       SELECT definition.profile
       FROM participants AS participant
       JOIN character_instances AS instance
         ON instance.workspace_id = participant.workspace_id
        AND instance.id = participant.character_instance_id
       JOIN character_continuities AS continuity
         ON continuity.workspace_id = instance.workspace_id
        AND continuity.id = instance.continuity_id
       JOIN character_definitions AS definition
         ON definition.workspace_id = instance.workspace_id
        AND definition.id = continuity.definition_id
       WHERE participant.workspace_id = record.workspace_id
         AND participant.record_id = record.id
         AND participant.participant_kind = 'character'
         AND participant.controller_mode = 'human'
       LIMIT 1
     ) AS player_definition ON true
     WHERE record.workspace_id = $1 AND record.id = $2
     FOR UPDATE OF record`,
    [scope.workspaceId, sourceRecordId],
  );
  const sourceRow = source.rows[0];
  if (!sourceRow) {
    throw new LibraryServiceError("RECORD_NOT_FOUND", "Record not found.");
  }
  if (sourceRow.record_status === "archived") {
    throw new LibraryServiceError(
      "RECORD_ARCHIVED",
      "Archived records cannot be branched.",
    );
  }

  // ④ record_heads（FOR UPDATE）→ effective head = COALESCE(last, start)。
  const headRow = await client.query<{
    last_world_tick: string | null;
    last_world_ordinal: string | null;
  }>(
    `SELECT last_world_tick::text, last_world_ordinal::text
     FROM record_heads
     WHERE workspace_id = $1 AND record_id = $2
     FOR UPDATE`,
    [scope.workspaceId, sourceRecordId],
  );
  const start = {
    tick: Math.max(0, Number(sourceRow.start_tick) || 0),
    ordinal: Math.max(0, Number(sourceRow.start_ordinal) || 0),
  };
  const head = {
    tick: Math.max(0, Number(headRow.rows[0]?.last_world_tick ?? sourceRow.start_tick) || 0),
    ordinal: Math.max(0, Number(headRow.rows[0]?.last_world_ordinal ?? sourceRow.start_ordinal) || 0),
  };

  // ⑤ fork 解析与校验：缺省 = head；eventId/显式游标必须落在源 record
  // 可见且已提交的因果游标上（record start，或源 record 一条已提交事件）。
  let fork: { tick: number; ordinal: number };
  const forkInput = input.fork;
  if (!forkInput) {
    fork = head;
  } else if ("eventId" in forkInput) {
    const eventId = forkInput.eventId?.trim() ?? "";
    if (!eventId) {
      throw new LibraryServiceError("INVALID_FORK", "fork eventId is empty.");
    }
    const event = await client.query<{
      world_tick: string;
      world_ordinal: string;
    }>(
      `SELECT world_tick::text, world_ordinal::text
       FROM events
       WHERE workspace_id = $1 AND record_id = $2 AND id = $3`,
      [scope.workspaceId, sourceRecordId, eventId],
    );
    const row = event.rows[0];
    if (!row) {
      throw new LibraryServiceError(
        "INVALID_FORK",
        "fork event is not a committed event of the source record.",
      );
    }
    fork = {
      tick: Math.max(0, Number(row.world_tick) || 0),
      ordinal: Math.max(0, Number(row.world_ordinal) || 0),
    };
  } else {
    const tick = Number(forkInput.worldTick);
    const ordinal = Number(forkInput.worldOrdinal);
    if (
      !Number.isSafeInteger(tick) || tick < 0
      || !Number.isSafeInteger(ordinal) || ordinal < 0
    ) {
      throw new LibraryServiceError("INVALID_FORK", "fork cursor must be non-negative integers.");
    }
    fork = { tick, ordinal };
  }
  if (compareBranchCursor(fork, head) > 0) {
    throw new LibraryServiceError("INVALID_FORK", "fork cursor is ahead of the record head.");
  }
  if (compareBranchCursor(fork, start) < 0) {
    throw new LibraryServiceError("INVALID_FORK", "fork cursor predates the source record.");
  }
  if (compareBranchCursor(fork, start) !== 0) {
    const committed = await client.query(
      `SELECT 1 FROM events
       WHERE workspace_id = $1 AND record_id = $2
         AND world_tick = $3 AND world_ordinal = $4
       LIMIT 1`,
      [scope.workspaceId, sourceRecordId, fork.tick, fork.ordinal],
    );
    if (!committed.rows[0]) {
      throw new LibraryServiceError(
        "INVALID_FORK",
        "fork cursor does not match a committed event of the source record.",
      );
    }
  }

  // ⑥ 幂等：确定性 record id（workspace+source+key 的 sha256）。
  // 源 record FOR UPDATE 已把同源并发分叉串行化，查重无竞态。
  let recordId: string;
  if (idempotencyKey) {
    const digest = createHash("sha256")
      .update(`${scope.workspaceId}:${sourceRecordId}:${idempotencyKey}`)
      .digest("hex")
      .slice(0, 18);
    recordId = `record_branch_${digest}`;
    const existing = await client.query<{
      id: string;
      worldline_id: string;
      story_id: string;
      start_tick: string;
      start_ordinal: string;
    }>(
      `SELECT id, worldline_id, story_id,
              start_tick::text, start_ordinal::text
       FROM records
       WHERE workspace_id = $1 AND id = $2`,
      [scope.workspaceId, recordId],
    );
    const existingRow = existing.rows[0];
    if (existingRow) {
      const existingFork = {
        tick: Number(existingRow.start_tick),
        ordinal: Number(existingRow.start_ordinal),
      };
      if (
        !Number.isSafeInteger(existingFork.tick) || existingFork.tick < 0
        || !Number.isSafeInteger(existingFork.ordinal) || existingFork.ordinal < 0
      ) {
        throw new LibraryServiceError("INVALID_FORK", "Stored branch cursor is invalid.");
      }
      return {
        worldId,
        worldlineId: existingRow.worldline_id,
        storyId: existingRow.story_id,
        recordId: existingRow.id,
        fork: existingFork,
        replayed: true,
      };
    }
  } else {
    recordId = `record_branch_${randomUUID().replaceAll("-", "").slice(0, 18)}`;
  }

  // ⑦ 覆盖 fork 点的场景快照（最近一个 start<=fork 的 scene）。
  const scene = await client.query<{
    title: string;
    location: string;
    objective: string;
    tension: string;
    weather: string;
    display_time: string;
  }>(
    `SELECT title, location, objective, tension, weather, display_time
     FROM scenes
     WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
       AND record_id = $4
       AND (start_tick < $5 OR (start_tick = $5 AND start_ordinal <= $6))
     ORDER BY start_tick DESC, start_ordinal DESC, created_at DESC
     LIMIT 1`,
    [
      scope.workspaceId,
      worldId,
      sourceRow.worldline_id,
      sourceRecordId,
      fork.tick,
      fork.ordinal,
    ],
  );
  const sceneRow = scene.rows[0];

  // ⑧ AI 阵容继承（与 duplicate 同一查询语义）。
  const sourceCharacters = await client.query<{
    id: string;
    name: string;
    role: string;
  }>(
    `SELECT DISTINCT
       definition.id,
       definition.display_name AS name,
       COALESCE(definition.profile->>'role', '') AS role
     FROM participants AS participant
     JOIN character_instances AS instance
       ON instance.workspace_id = participant.workspace_id
      AND instance.id = participant.character_instance_id
     JOIN character_continuities AS continuity
       ON continuity.workspace_id = instance.workspace_id
      AND continuity.id = instance.continuity_id
     JOIN character_definitions AS definition
       ON definition.workspace_id = instance.workspace_id
      AND definition.id = continuity.definition_id
     WHERE participant.workspace_id = $1
       AND participant.record_id = $2
       AND participant.participant_kind = 'character'
       AND participant.controller_mode = 'ai'
     ORDER BY definition.id ASC`,
    [scope.workspaceId, sourceRecordId],
  );

  // ⑨ 原子拓扑写入：worldline → story → record → record_heads → 装配。
  const label = normalizeBranchText(input.label, `分支：${sourceRow.record_title}`);
  const storyTitle = normalizeBranchText(input.storyTitle, `分支：${sourceRow.story_title}`);
  const recordTitle = normalizeBranchText(input.recordTitle, `分支：${sourceRow.record_title}`);
  const worldlineId = `worldline_branch_${randomUUID().replaceAll("-", "").slice(0, 18)}`;
  const storyId = `story_branch_${randomUUID().replaceAll("-", "").slice(0, 18)}`;
  await client.query(
    `INSERT INTO worldlines (
       workspace_id, world_id, id, label, status,
       parent_worldline_id, fork_tick, fork_ordinal, head_tick, head_ordinal
     ) VALUES ($1, $2, $3, $4, 'active', $5, $6, $7, $6, $7)`,
    [scope.workspaceId, worldId, worldlineId, label, sourceRow.worldline_id, fork.tick, fork.ordinal],
  );
  await client.query(
    `INSERT INTO stories (
       workspace_id, world_id, worldline_id, id, title, status,
       premise, start_tick, start_ordinal
     ) VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8)`,
    [
      scope.workspaceId,
      worldId,
      worldlineId,
      storyId,
      storyTitle,
      sourceRow.story_premise,
      fork.tick,
      fork.ordinal,
    ],
  );
  await client.query(
    `INSERT INTO records (
       workspace_id, world_id, worldline_id, story_id, id, title,
       status, start_tick, start_ordinal, timeline_kind, linked_record_id
     ) VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8, 'branch', $9)`,
    [
      scope.workspaceId,
      worldId,
      worldlineId,
      storyId,
      recordId,
      recordTitle,
      fork.tick,
      fork.ordinal,
      sourceRecordId,
    ],
  );
  await client.query(
    `INSERT INTO record_heads (
       workspace_id, world_id, worldline_id, record_id,
       record_version, next_record_ordinal, last_world_tick, last_world_ordinal
     ) VALUES ($1, $2, $3, $4, 0, 0, $5, $6)`,
    [scope.workspaceId, worldId, worldlineId, recordId, fork.tick, fork.ordinal],
  );
  await assembleDefaultRecord(
    client,
    scope,
    { world_id: worldId, worldline_id: worldlineId },
    recordId,
    sourceCharacters.rows,
    {
      observer: sourceRow.observer,
      playerRole: sourceRow.player_role,
      startTick: fork.tick,
      startOrdinal: fork.ordinal,
      inheritanceCutoffTick: fork.tick,
      inheritanceCutoffOrdinal: fork.ordinal,
      scene: {
        title: sceneRow?.title || "分支",
        location: sceneRow?.location ?? "",
        tension: sceneRow?.tension ?? "",
        objective: sceneRow?.objective ?? "",
        weather: sceneRow?.weather ?? "",
        displayTime: sceneRow?.display_time ?? "",
      },
    },
  );
  return { worldId, worldlineId, storyId, recordId, fork, replayed: false };
}

export interface AssembleSceneSeed {
  title?: string;
  location?: string;
  tension?: string;
  objective?: string;
  /** 批次 T12：scene weather 快照；缺省取装配时 worlds.settings.weather。 */
  weather?: string;
  /** 批次 T12 验收修正：scene display_time 快照；缺省取 worlds.settings.displayTime。 */
  displayTime?: string;
}

export interface AssembleOptions {
  /** 草稿为人类玩家赋予的本世界角色定位；缺省沿用种子定义或留空。 */
  playerRole?: string;
  scene?: AssembleSceneSeed;
  /**
   * 批次 S：观察者装配——不创建玩家角色定义/实例/参与者，
   * 改为创建人类 narrator 席位（speaking_order=0）。
   */
  observer?: boolean;
  /** 重复 Record 的分叉游标；普通创世/新记录保持 0。 */
  startTick?: number;
  startOrdinal?: number;
  inheritanceCutoffTick?: number;
  inheritanceCutoffOrdinal?: number;
}

interface PlayerPersona {
  name: string;
  role: string;
}

/**
 * 人类玩家名称解析：当前账号 displayName → 本世界种子人类定义 → 中性名。
 * 任何分支都不硬编码演示世界的角色名。
 */
async function resolvePlayerPersona(
  client: PoolClient,
  scope: LibraryScope,
  worldId: string,
): Promise<PlayerPersona> {
  const account = await client.query<{ display_name: string }>(
    `SELECT display_name
     FROM accounts
     WHERE workspace_id = $1 AND principal_id = $2`,
    [scope.workspaceId, scope.principalId],
  );
  const accountName = account.rows[0]?.display_name?.trim();
  if (accountName) return { name: accountName, role: "" };

  const seeded = await client.query<{ display_name: string; role: string }>(
    `SELECT display_name, COALESCE(profile->>'role', '') AS role
     FROM character_definitions
     WHERE workspace_id = $1 AND world_id = $2 AND id = 'char_def_player'`,
    [scope.workspaceId, worldId],
  );
  const seededName = seeded.rows[0]?.display_name?.trim();
  if (seededName) {
    return { name: seededName, role: seeded.rows[0]?.role?.trim() ?? "" };
  }

  return { name: "旅人", role: "" };
}

async function sceneTensionColumnExists(client: PoolClient): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'scenes'
         AND column_name = 'tension'
     ) AS exists`,
  );
  return result.rows[0]?.exists === true;
}

async function readSceneTensionFallback(
  client: PoolClient,
  workspaceId: string,
  worldId: string,
): Promise<string> {
  const result = await client.query<{ tension: string }>(
    `SELECT COALESCE(settings->>'tension', '') AS tension
     FROM worlds
     WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, worldId],
  );
  return result.rows[0]?.tension ?? "";
}

/** 批次 T12：读取 worlds.settings 单字段（weather 快照缺省值等）。 */
async function readWorldSettingsValue(
  client: PoolClient,
  workspaceId: string,
  worldId: string,
  key: string,
): Promise<string> {
  const result = await client.query<{ value: string | null }>(
    `SELECT settings->>$3 AS value
     FROM worlds
     WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, worldId, key],
  );
  const value = result.rows[0]?.value;
  return typeof value === "string" ? value : "";
}

async function assembleDefaultRecord(
  client: PoolClient,
  scope: LibraryScope,
  story: { world_id: string; worldline_id: string },
  recordId: string,
  customCharacters: readonly { id: string; name: string; role: string }[],
  options: AssembleOptions = {},
): Promise<{ sceneId: string; policyId: string }> {
  const startTick = options.startTick ?? 0;
  const startOrdinal = options.startOrdinal ?? 0;
  const inheritanceCutoffTick = options.inheritanceCutoffTick ?? startTick;
  const inheritanceCutoffOrdinal = options.inheritanceCutoffOrdinal ?? startOrdinal;
  const sceneTension = options.scene?.tension !== undefined
    ? options.scene.tension.trim()
    : await readSceneTensionFallback(client, scope.workspaceId, story.world_id);
  // 批次 T12：weather 快照——scene 行创建即落当时天气（Record/世界线级
  // 可隔离）；显式传参优先，缺省取装配时 worlds.settings.weather。
  const sceneWeather = options.scene?.weather !== undefined
    ? options.scene.weather.trim()
    : await readWorldSettingsValue(client, scope.workspaceId, story.world_id, "weather");
  // 批次 T12 验收修正：display_time 快照同理（缺省取 settings.displayTime）。
  const sceneDisplayTime = options.scene?.displayTime !== undefined
    ? options.scene.displayTime.trim()
    : await readWorldSettingsValue(client, scope.workspaceId, story.world_id, "displayTime");
  // 阵容 = 当前账号的人类玩家 + 本世界自定义角色。世界没有自定义角色时
  // 保持纯净，不注入任何来自其他世界的默认角色。
  // 批次 S：观察者姿态不建玩家角色席位，改以人类 narrator 席位入阵。
  const persona = options.observer
    ? null
    : await resolvePlayerPersona(client, scope, story.world_id);
  const cast = [
    ...(persona
      ? [{
          key: "player",
          name: persona.name,
          role: options.playerRole?.trim() || persona.role,
          controller: "human",
        }]
      : []),
    ...customCharacters.map((character) => ({
      key: `custom_${character.id}`,
      name: character.name,
      role: character.role,
      controller: "ai",
    })),
  ];
  const sceneId = `scene_${randomUUID().replaceAll("-", "").slice(0, 18)}`;
  const policyId = `visibility_public_${randomUUID().replaceAll("-", "").slice(0, 18)}`;
  const actorIds = new Map<string, { definitionId: string; continuityId: string; instanceId: string; participantId: string }>();

  for (let index = 0; index < cast.length; index += 1) {
    const item = cast[index]!;
    const customCharacter = customCharacters.find(
      (character) => `custom_${character.id}` === item.key,
    );
    const definitionId = customCharacter
      ? customCharacter.id
      : `char_def_${item.key}_${story.world_id.slice(-24)}`;
    const continuityId = `continuity_${item.key}_${story.worldline_id.slice(-24)}`;
    const instanceId = `char_inst_${item.key}_${recordId.slice(-12)}`;
    const participantId = `participant_${item.key}_${recordId.slice(-12)}`;
    actorIds.set(item.key, { definitionId, continuityId, instanceId, participantId });
    if (!customCharacter) {
      await client.query(
        `INSERT INTO character_definitions (
           workspace_id, world_id, id, display_name, source_format, profile
         ) VALUES ($1, $2, $3, $4, 'native', $5::jsonb)
         ON CONFLICT (workspace_id, world_id, id) DO NOTHING`,
        [
          scope.workspaceId,
          story.world_id,
          definitionId,
          item.name,
          JSON.stringify({ role: item.role }),
        ],
      );
    }
    const existingContinuity = await client.query<{ id: string }>(
      `SELECT id
       FROM character_continuities
       WHERE workspace_id = $1 AND worldline_id = $2 AND continuity_key = $3`,
      [scope.workspaceId, story.worldline_id, item.key],
    );
    const activeContinuityId = existingContinuity.rows[0]?.id ?? continuityId;
    if (!existingContinuity.rows[0]) {
      await client.query(
        `INSERT INTO character_continuities (
           workspace_id, world_id, worldline_id, definition_id, id,
           continuity_key, status, born_tick, born_ordinal
         ) VALUES ($1, $2, $3, $4, $5, $6, 'active', 0, 0)
         ON CONFLICT (workspace_id, worldline_id, continuity_key) DO NOTHING`,
        [
          scope.workspaceId,
          story.world_id,
          story.worldline_id,
          definitionId,
          activeContinuityId,
          item.key,
        ],
      );
    }
    actorIds.set(item.key, {
      definitionId,
      continuityId: activeContinuityId,
      instanceId,
      participantId,
    });
    await client.query(
      `INSERT INTO character_instances (
         workspace_id, world_id, worldline_id, record_id, continuity_id, id,
         controller_mode, status, instantiated_tick, instantiated_ordinal,
         inheritance_cutoff_tick, inheritance_cutoff_ordinal
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'present', $8, $9, $10, $11)`,
      [
        scope.workspaceId,
        story.world_id,
        story.worldline_id,
        recordId,
        activeContinuityId,
        instanceId,
        item.controller,
        startTick,
        startOrdinal,
        inheritanceCutoffTick,
        inheritanceCutoffOrdinal,
      ],
    );
    await client.query(
      `INSERT INTO participants (
         workspace_id, world_id, worldline_id, record_id, id,
         participant_kind, character_instance_id, principal_id,
         controller_mode, is_active, speaking_order
       ) VALUES ($1, $2, $3, $4, $5, 'character', $6, $7, $8, true, $9)`,
      [
        scope.workspaceId,
        story.world_id,
        story.worldline_id,
        recordId,
        participantId,
        instanceId,
        item.controller === "human" ? scope.principalId : null,
        item.controller,
        index + (options.observer ? 1 : 0),
      ],
    );
  }

  // 批次 T4：数据驱动规则——按世界文风确保基础技能/资产/姿态定义存在，
  // 并在记录级授权（技能给玩家与 AI 实例，资产仅玩家实例）。幂等。
  const worldStyle = await readWorldStyle(client, {
    workspaceId: scope.workspaceId,
    worldId: story.world_id,
  });
  const baseDefinitions = await ensureWorldBaseRuleDefinitions(
    client,
    { workspaceId: scope.workspaceId, worldId: story.world_id },
    worldStyle,
  );
  const baseGrantScope = {
    workspaceId: scope.workspaceId,
    worldId: story.world_id,
    worldlineId: story.worldline_id,
    recordId,
  };
  const playerEntry = actorIds.get("player");
  const aiInstanceIds = cast
    .filter((item) => item.controller === "ai")
    .map((item) => actorIds.get(item.key)!.instanceId);
  await grantBaseSkillsToInstances(
    client,
    baseGrantScope,
    baseDefinitions.skillDefinitionIds,
    [...(playerEntry ? [playerEntry.instanceId] : []), ...aiInstanceIds],
  );
  if (playerEntry) {
    await grantBaseAssetToInstance(
      client,
      baseGrantScope,
      baseDefinitions.assetDefinitionId,
      playerEntry.instanceId,
    );
  }
  // 批次 T6：自定义角色（含导入卡）实例补授权——卡自带技能（profile
  // realm_skill_keys 关联）+ 基础资产（AI 余量 1）。幂等。
  for (const character of customCharacters) {
    const entry = actorIds.get(`custom_${character.id}`);
    if (!entry) continue;
    await grantCharacterCardSkills(client, baseGrantScope, character.id, [
      entry.instanceId,
    ]);
    await grantBaseAssetToInstance(
      client,
      baseGrantScope,
      baseDefinitions.assetDefinitionId,
      entry.instanceId,
      BASE_AI_ASSET_QUANTITY,
    );
  }

  if (options.observer) {
    // 人类 narrator 席位：无角色实例，本人执笔。每条记录至多一个
    // （participants_record_narrator_uidx）。
    await client.query(
      `INSERT INTO participants (
         workspace_id, world_id, worldline_id, record_id, id,
         participant_kind, character_instance_id, principal_id,
         controller_mode, is_active, speaking_order
       ) VALUES ($1, $2, $3, $4, $5, 'narrator', NULL, $6, 'human', true, 0)`,
      [
        scope.workspaceId,
        story.world_id,
        story.worldline_id,
        recordId,
        `participant_narrator_${randomUUID().replaceAll("-", "").slice(0, 18)}`,
        scope.principalId,
      ],
    );
  }

  const sceneValues = [
    scope.workspaceId,
    story.world_id,
    story.worldline_id,
    recordId,
    sceneId,
    options.scene?.title?.trim() || "开幕",
    options.scene?.location?.trim() ?? "",
    options.scene?.objective?.trim() ?? "",
    sceneTension,
    startTick,
    startOrdinal,
    sceneWeather,
    sceneDisplayTime,
  ];
  if (await sceneTensionColumnExists(client)) {
    await client.query(
      `INSERT INTO scenes (
         workspace_id, world_id, worldline_id, record_id, id, title, status,
         location, objective, tension, start_tick, start_ordinal, weather,
         display_time
       ) VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8, $9, $10, $11, $12, $13)`,
      sceneValues,
    );
  } else {
    await client.query(
      `INSERT INTO scenes (
         workspace_id, world_id, worldline_id, record_id, id, title, status,
         location, objective, start_tick, start_ordinal
       ) VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8, $9, $10)`,
      [
        sceneValues[0],
        sceneValues[1],
        sceneValues[2],
        sceneValues[3],
        sceneValues[4],
        sceneValues[5],
        sceneValues[6],
        sceneValues[7],
        sceneValues[9],
        sceneValues[10],
      ],
    );
  }

  await client.query(
    `INSERT INTO visibility_policies (
       workspace_id, world_id, worldline_id, record_id, id,
       policy_key, policy_version, policy_kind
     ) VALUES ($1, $2, $3, $4, $5, 'public', 1, 'public')`,
    [scope.workspaceId, story.world_id, story.worldline_id, recordId, policyId],
  );
  return { sceneId, policyId };
}

/**
 * 批次 S：卷首旁白——开场事件、记录头与世界线头推进在同一事务内完成。
 * 形态对齐演示种子 OPENING_EVENT_SQL：narration.committed、actor NULL、
 * speaker 旁白、presentation 单 story 段、public 策略、世界坐标 (0,1)。
 * 世界线 head_tick/head_ordinal 必须同步推进到 (0,1)，否则观察者首回合
 * release 分配世界游标时会撞上开场事件坐标（events 世界坐标唯一约束）。
 */
async function insertOpeningEvent(
  client: PoolClient,
  scope: LibraryScope,
  story: { world_id: string; worldline_id: string },
  recordId: string,
  assembled: { sceneId: string; policyId: string },
  opening: string,
): Promise<void> {
  const eventId = `event_${randomUUID().replaceAll("-", "").slice(0, 18)}`;
  await client.query(
    `INSERT INTO events (
       workspace_id, world_id, worldline_id, record_id, scene_id, id,
       record_version, record_ordinal, batch_index, event_kind,
       actor_participant_id, speaker_name, content, payload,
       visibility_policy_id, world_tick, world_ordinal, calendar_id,
       display_time, recorded_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, 1, 1, 0, 'narration.committed',
       NULL, '旁白', $7, $8::jsonb, $9, 0, 1, 'native_calendar', '',
       CURRENT_TIMESTAMP
     )`,
    [
      scope.workspaceId,
      story.world_id,
      story.worldline_id,
      recordId,
      assembled.sceneId,
      eventId,
      opening,
      JSON.stringify({
        presentation: {
          schemaVersion: 1,
          segments: [
            {
              id: "story-1",
              kind: "story",
              content: opening,
              speechMode: "narrator",
            },
          ],
        },
      }),
      assembled.policyId,
    ],
  );
  await client.query(
    `UPDATE record_heads
     SET record_version = 1,
         next_record_ordinal = 2,
         last_event_id = $3,
         last_world_tick = 0,
         last_world_ordinal = 1
     WHERE workspace_id = $1 AND record_id = $2`,
    [scope.workspaceId, recordId, eventId],
  );
  // v37 §E.1：第四 head writer 统一显式 FOR UPDATE worldlines（锁内重读）。
  const worldlineHead = await client.query(
    `SELECT head_tick, head_ordinal
     FROM worldlines
     WHERE workspace_id = $1 AND id = $2
     FOR UPDATE`,
    [scope.workspaceId, story.worldline_id],
  );
  if (!worldlineHead.rows[0]) {
    throw new LibraryServiceError("WORLD_NOT_FOUND", "Worldline not found.");
  }
  await client.query(
    `UPDATE worldlines
     SET head_tick = 0,
         head_ordinal = 1,
         updated_at = CURRENT_TIMESTAMP
     WHERE workspace_id = $1 AND id = $2`,
    [scope.workspaceId, story.worldline_id],
  );
}

/**
 * 批次 S：把新建角色装配进目标记录的阵容（同一事务）。
 * continuity key `custom_<definitionId>` 查重——已在阵容中则幂等跳过。
 */
/**
 * 批次 T10-B6：owner 例外命令枚举——这些命令的事务需要 realm_runtime
 * 未授权的表写（worlds/character_definitions/participants/record_heads
 * INSERT 或 memberships/participants UPDATE），在「不新增迁移」约束下只能
 * 走 owner pool；评审迁移补齐前不得扩大（规范 §三）。
 */
const OWNER_POOL_COMMAND_KINDS: ReadonlySet<LibraryCreateCommand["kind"]> =
  new Set([
    "world",
    "preset-world",
    "character",
    "record",
    "attach-character",
    "player-stance",
  ]);

/**
 * 批次 T10-B6：membership 角色解析。无行 → null（调用方 404 不泄露存在性）。
 */
async function resolveWorldRole(
  client: PoolClient,
  scope: LibraryScope,
  worldId: string,
): Promise<"owner" | "player" | "observer" | null> {
  const membership = await client.query<{ role: string }>(
    `SELECT role
     FROM player_world_memberships
     WHERE workspace_id = $1 AND world_id = $2 AND principal_id = $3`,
    [scope.workspaceId, worldId, scope.principalId],
  );
  const role = membership.rows[0]?.role;
  return role === "owner" || role === "player" || role === "observer"
    ? role
    : null;
}

/** 批次 T10-B6：成员存在性（player-stance 等本人操作的前置）。 */
async function assertWorldMember(
  client: PoolClient,
  scope: LibraryScope,
  worldId: string,
): Promise<void> {
  if ((await resolveWorldRole(client, scope, worldId)) === null) {
    throw new LibraryServiceError("WORLD_NOT_FOUND", "World not found.");
  }
}

/** 批次 T10-B6：内容写门禁——owner/player 放行；observer 只读 403；非成员 404。 */
async function assertWorldContentMember(
  client: PoolClient,
  scope: LibraryScope,
  worldId: string,
): Promise<void> {
  const role = await resolveWorldRole(client, scope, worldId);
  if (role === null) {
    throw new LibraryServiceError("WORLD_NOT_FOUND", "World not found.");
  }
  if (role === "observer") {
    throw new LibraryServiceError(
      "WORLD_READ_ONLY",
      "Observers are read-only in this world.",
    );
  }
}

/**
 * 批次 T8：归档世界不可开新局（fail-closed）。世界不存在 → WORLD_NOT_FOUND；
 * status='archived' → WORLD_ARCHIVED。
 * v37 §D.0/§E.1：升级为持锁形态——worlds FOR KEY SHARE + 锁内 active 重读
 * （gateWorldWrite 同形）；写者互相并行，与归档命令 FOR UPDATE 互斥。
 */
async function assertWorldWritable(
  client: PoolClient,
  workspaceId: string,
  worldId: string,
): Promise<void> {
  const world = await client.query<{ status: string }>(
    `SELECT status FROM worlds WHERE workspace_id = $1 AND id = $2 FOR KEY SHARE`,
    [workspaceId, worldId],
  );
  const row = world.rows[0];
  if (!row) throw new LibraryServiceError("WORLD_NOT_FOUND", "World not found.");
  if (row.status === "archived") {
    throw new LibraryServiceError(
      "WORLD_ARCHIVED",
      "The world is archived and read-only.",
    );
  }
}

/**
 * 批次 T8：管理命令（归档/删除）的 owner 门禁——library 服务首个权限闸门，
 * 只作用于管理命令。世界不存在 → WORLD_NOT_FOUND；非 owner → WORLD_NOT_OWNED。
 */
async function assertWorldOwner(
  client: PoolClient,
  scope: LibraryScope,
  worldId: string,
): Promise<void> {
  const world = await client.query<{ id: string }>(
    `SELECT id FROM worlds WHERE workspace_id = $1 AND id = $2`,
    [scope.workspaceId, worldId],
  );
  if (!world.rows[0]) {
    throw new LibraryServiceError("WORLD_NOT_FOUND", "World not found.");
  }
  const membership = await client.query<{ role: string }>(
    `SELECT role
     FROM player_world_memberships
     WHERE workspace_id = $1 AND world_id = $2 AND principal_id = $3`,
    [scope.workspaceId, worldId, scope.principalId],
  );
  if (membership.rows[0]?.role !== "owner") {
    throw new LibraryServiceError(
      "WORLD_NOT_OWNED",
      "Only the world owner may administer it.",
    );
  }
}

/**
 * 批次 T8：活动自演会话防护——世界任一记录存在 running/stopping 会话时
 * 拒绝归档/删除（账本行随记录 CASCADE 消失会让在途拍无处收尾）。
 */
async function assertNoActiveSelfPlay(
  client: PoolClient,
  workspaceId: string,
  worldId: string,
): Promise<void> {
  const active = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count
     FROM record_self_play_sessions AS session
     JOIN records AS record
       ON record.workspace_id = session.workspace_id
      AND record.id = session.record_id
     WHERE session.workspace_id = $1 AND record.world_id = $2
       AND session.state IN ('running', 'stopping')`,
    [workspaceId, worldId],
  );
  if ((active.rows[0]?.count ?? 0) > 0) {
    throw new LibraryServiceError(
      "WORLD_SELF_PLAY_ACTIVE",
      "Stop the running self-play session before administering this world.",
    );
  }
}

async function assertNoActiveRecordSelfPlay(
  client: PoolClient,
  workspaceId: string,
  recordId: string,
): Promise<void> {
  const active = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count
     FROM record_self_play_sessions
     WHERE workspace_id = $1 AND record_id = $2
       AND state IN ('running', 'stopping')`,
    [workspaceId, recordId],
  );
  if ((active.rows[0]?.count ?? 0) > 0) {
    throw new LibraryServiceError(
      "RECORD_SELF_PLAY_ACTIVE",
      "Stop the running self-play session before deleting this Record.",
    );
  }
}

async function assertNoActiveRecordTurn(
  client: PoolClient,
  workspaceId: string,
  recordId: string,
): Promise<void> {
  const active = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count
     FROM turn_runs
     WHERE workspace_id = $1 AND record_id = $2
       AND state IN ('accepted', 'planning', 'drafting', 'validating', 'releasing', 'retryable')`,
    [workspaceId, recordId],
  );
  if ((active.rows[0]?.count ?? 0) > 0) {
    throw new LibraryServiceError(
      "RECORD_TURN_ACTIVE",
      "Wait for the active Turn to finish before deleting this Record.",
    );
  }
}

async function attachCharacterToRecord(
  client: PoolClient,
  scope: LibraryScope,
  worldId: string,
  recordId: string,
  definitionId: string,
): Promise<void> {
  const record = await client.query<{ worldline_id: string }>(
    `SELECT worldline_id
     FROM records
     WHERE workspace_id = $1 AND world_id = $2 AND id = $3`,
    [scope.workspaceId, worldId, recordId],
  );
  const worldlineId = record.rows[0]?.worldline_id;
  if (!worldlineId) {
    throw new LibraryServiceError("WORLD_NOT_FOUND", "Record not found in this world.");
  }

  const continuityKey = `custom_${definitionId}`;
  const existing = await client.query<{ id: string }>(
    `SELECT id
     FROM character_continuities
     WHERE workspace_id = $1 AND worldline_id = $2 AND continuity_key = $3`,
    [scope.workspaceId, worldlineId, continuityKey],
  );
  let continuityId = existing.rows[0]?.id ?? "";
  if (!continuityId) {
    continuityId = `continuity_${randomUUID().replaceAll("-", "").slice(0, 18)}`;
    await client.query(
      `INSERT INTO character_continuities (
         workspace_id, world_id, worldline_id, definition_id, id,
         continuity_key, status, born_tick, born_ordinal
       ) VALUES ($1, $2, $3, $4, $5, $6, 'active', 0, 0)
       ON CONFLICT (workspace_id, worldline_id, continuity_key) DO NOTHING`,
      [
        scope.workspaceId,
        worldId,
        worldlineId,
        definitionId,
        continuityId,
        continuityKey,
      ],
    );
    const inserted = await client.query<{ id: string }>(
      `SELECT id
       FROM character_continuities
       WHERE workspace_id = $1 AND worldline_id = $2 AND continuity_key = $3`,
      [scope.workspaceId, worldlineId, continuityKey],
    );
    continuityId = inserted.rows[0]?.id ?? continuityId;
  }

  const existingInstance = await client.query<{ id: string }>(
    `SELECT instance.id
     FROM character_instances AS instance
     JOIN participants AS participant
       ON participant.workspace_id = instance.workspace_id
      AND participant.record_id = instance.record_id
      AND participant.character_instance_id = instance.id
      AND participant.participant_kind = 'character'
     WHERE instance.workspace_id = $1
       AND instance.record_id = $2
       AND instance.continuity_id = $3
     LIMIT 1`,
    [scope.workspaceId, recordId, continuityId],
  );
  if (existingInstance.rows[0]) {
    await client.query(
      `UPDATE participants
       SET is_active = true, updated_at = CURRENT_TIMESTAMP
       WHERE workspace_id = $1 AND record_id = $2
         AND character_instance_id = $3 AND participant_kind = 'character'`,
      [scope.workspaceId, recordId, existingInstance.rows[0].id],
    );
    await client.query(
      `UPDATE character_instances
       SET status = 'present', retired_tick = NULL, retired_ordinal = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE workspace_id = $1 AND record_id = $2 AND id = $3`,
      [scope.workspaceId, recordId, existingInstance.rows[0].id],
    );
    return;
  }

  const maxOrder = await client.query<{ max_order: string | null }>(
    `SELECT max(speaking_order)::text AS max_order
     FROM participants
     WHERE workspace_id = $1 AND record_id = $2`,
    [scope.workspaceId, recordId],
  );
  const speakingOrder = Number(maxOrder.rows[0]?.max_order ?? "-1") + 1;

  const instanceId = `char_inst_${randomUUID().replaceAll("-", "").slice(0, 18)}`;
  const participantId = `participant_${randomUUID().replaceAll("-", "").slice(0, 18)}`;
  await client.query(
    `INSERT INTO character_instances (
       workspace_id, world_id, worldline_id, record_id, continuity_id, id,
       controller_mode, status, instantiated_tick, instantiated_ordinal,
       inheritance_cutoff_tick, inheritance_cutoff_ordinal
     ) VALUES ($1, $2, $3, $4, $5, $6, 'ai', 'present', 0, 0, 0, 0)`,
    [
      scope.workspaceId,
      worldId,
      worldlineId,
      recordId,
      continuityId,
      instanceId,
    ],
  );
  await client.query(
    `INSERT INTO participants (
       workspace_id, world_id, worldline_id, record_id, id,
       participant_kind, character_instance_id, principal_id,
       controller_mode, is_active, speaking_order
     ) VALUES ($1, $2, $3, $4, $5, 'character', $6, NULL, 'ai', true, $7)`,
    [
      scope.workspaceId,
      worldId,
      worldlineId,
      recordId,
      participantId,
      instanceId,
      speakingOrder,
    ],
  );

  // 批次 T4：挂入角色补授权本世界基础技能（定义不存在时先按文风确保）。
  const worldStyle = await readWorldStyle(client, {
    workspaceId: scope.workspaceId,
    worldId,
  });
  const baseDefinitions = await ensureWorldBaseRuleDefinitions(
    client,
    { workspaceId: scope.workspaceId, worldId },
    worldStyle,
  );
  const grantScope = {
    workspaceId: scope.workspaceId,
    worldId,
    worldlineId,
    recordId,
  };
  await grantBaseSkillsToInstances(
    client,
    grantScope,
    baseDefinitions.skillDefinitionIds,
    [instanceId],
  );
  // 批次 T6：挂入角色补授权卡自带技能（无则零操作）与基础资产（AI 余量 1）。
  await grantCharacterCardSkills(client, grantScope, definitionId, [instanceId]);
  await grantBaseAssetToInstance(
    client,
    grantScope,
    baseDefinitions.assetDefinitionId,
    instanceId,
    BASE_AI_ASSET_QUANTITY,
  );
}

async function setCharacterActivity(
  client: PoolClient,
  scope: LibraryScope,
  worldId: string,
  recordId: string,
  definitionId: string,
  active: boolean,
): Promise<void> {
  const updated = await client.query<{ instance_id: string }>(
    `UPDATE participants AS participant
     SET is_active = $5, updated_at = CURRENT_TIMESTAMP
     FROM character_instances AS instance
     JOIN character_continuities AS continuity
       ON continuity.workspace_id = instance.workspace_id
      AND continuity.id = instance.continuity_id
     WHERE participant.workspace_id = $1
       AND participant.record_id = $2
       AND participant.participant_kind = 'character'
       AND participant.character_instance_id = instance.id
       AND continuity.definition_id = $3
       AND instance.world_id = $4
     RETURNING instance.id AS instance_id`,
    [scope.workspaceId, recordId, definitionId, worldId, active],
  );
  const instanceId = updated.rows[0]?.instance_id;
  if (!instanceId) {
    if (active) {
      await attachCharacterToRecord(client, scope, worldId, recordId, definitionId);
      return;
    }
    throw new LibraryServiceError(
      "WORLD_NOT_FOUND",
      "Character is not attached to this Record.",
    );
  }
  await client.query(
    `UPDATE character_instances
     SET status = $4, updated_at = CURRENT_TIMESTAMP
     WHERE workspace_id = $1 AND record_id = $2 AND id = $3`,
    [scope.workspaceId, recordId, instanceId, active ? "present" : "absent"],
  );
}

/**
 * - 转观察者：membership role='observer'（触发器只禁 omniscient 变更）；
 *   活跃主记录中本人的人类角色席位置 is_active=false（绝不删除——
 *   events 有 FK 引用），补建/激活人类 narrator 席位。
 * - 转入局：role='player'；narrator 席位置 is_active=false；无活跃
 *   人类角色席位时按 resolvePlayerPersona 约定补建。
 * 烬海诸国/界核既有数据不受影响（只动调用者显式指定的世界）。
 */
async function applyPlayerStance(
  client: PoolClient,
  scope: LibraryScope,
  worldId: string,
  stance: "player" | "observer",
): Promise<void> {
  const membership = await client.query(
    `UPDATE player_world_memberships
     SET role = $4
     WHERE workspace_id = $1 AND world_id = $2 AND principal_id = $3`,
    [scope.workspaceId, worldId, scope.principalId, stance],
  );
  if (membership.rowCount !== 1) {
    throw new LibraryServiceError("WORLD_NOT_FOUND", "World not found.");
  }

  const records = await client.query<{ id: string; worldline_id: string }>(
    `SELECT id, worldline_id
     FROM records
     WHERE workspace_id = $1 AND world_id = $2
       AND status = 'active' AND timeline_kind = 'primary'
     ORDER BY created_at ASC`,
    [scope.workspaceId, worldId],
  );

  for (const record of records.rows) {
    if (stance === "observer") {
      await client.query(
        `UPDATE participants
         SET is_active = false
         WHERE workspace_id = $1 AND record_id = $2
           AND participant_kind = 'character'
           AND controller_mode = 'human'
           AND principal_id = $3`,
        [scope.workspaceId, record.id, scope.principalId],
      );
      await client.query(
        `INSERT INTO participants (
           workspace_id, world_id, worldline_id, record_id, id,
           participant_kind, character_instance_id, principal_id,
           controller_mode, is_active, speaking_order
         ) VALUES ($1, $2, $3, $4, $5, 'narrator', NULL, $6, 'human', true, 0)
         ON CONFLICT (workspace_id, record_id)
           WHERE participant_kind = 'narrator'
        DO UPDATE SET is_active = true`,
        [
          scope.workspaceId,
          worldId,
          record.worldline_id,
          record.id,
          `participant_narrator_${randomUUID().replaceAll("-", "").slice(0, 18)}`,
          scope.principalId,
        ],
      );
      continue;
    }

    await client.query(
      `UPDATE participants
       SET is_active = false
       WHERE workspace_id = $1 AND record_id = $2
         AND participant_kind = 'narrator'`,
      [scope.workspaceId, record.id],
    );
    const ownSeat = await client.query<{ id: string; is_active: boolean }>(
      `SELECT id, is_active
       FROM participants
       WHERE workspace_id = $1 AND record_id = $2
         AND participant_kind = 'character'
         AND controller_mode = 'human'
         AND principal_id = $3
       ORDER BY speaking_order ASC, created_at ASC
       LIMIT 1`,
      [scope.workspaceId, record.id, scope.principalId],
    );
    const seat = ownSeat.rows[0];
    if (seat) {
      if (!seat.is_active) {
        await client.query(
          `UPDATE participants
           SET is_active = true
           WHERE workspace_id = $1 AND id = $2`,
          [scope.workspaceId, seat.id],
        );
      }
      continue;
    }
    await createPlayerSeat(
      client,
      scope,
      worldId,
      record.worldline_id,
      record.id,
    );
  }
}

/**
 * 批次 S：按装配约定补建人类玩家席位——
 * 定义 char_def_player_<world>、continuity key 'player'、
 * 实例/参与者以 recordId 收尾，speaking_order=0。
 */
async function createPlayerSeat(
  client: PoolClient,
  scope: LibraryScope,
  worldId: string,
  worldlineId: string,
  recordId: string,
): Promise<void> {
  const persona = await resolvePlayerPersona(client, scope, worldId);
  const definitionId = `char_def_player_${worldId.slice(-24)}`;
  await client.query(
    `INSERT INTO character_definitions (
       workspace_id, world_id, id, display_name, source_format, profile
     ) VALUES ($1, $2, $3, $4, 'native', $5::jsonb)
     ON CONFLICT (workspace_id, world_id, id) DO NOTHING`,
    [
      scope.workspaceId,
      worldId,
      definitionId,
      persona.name,
      JSON.stringify({ role: persona.role }),
    ],
  );

  const continuityKey = "player";
  const existingContinuity = await client.query<{ id: string }>(
    `SELECT id
     FROM character_continuities
     WHERE workspace_id = $1 AND worldline_id = $2 AND continuity_key = $3`,
    [scope.workspaceId, worldlineId, continuityKey],
  );
  let continuityId = existingContinuity.rows[0]?.id;
  if (!continuityId) {
    continuityId = `continuity_player_${worldlineId.slice(-24)}`;
    await client.query(
      `INSERT INTO character_continuities (
         workspace_id, world_id, worldline_id, definition_id, id,
         continuity_key, status, born_tick, born_ordinal
       ) VALUES ($1, $2, $3, $4, $5, $6, 'active', 0, 0)
       ON CONFLICT (workspace_id, worldline_id, continuity_key) DO NOTHING`,
      [
        scope.workspaceId,
        worldId,
        worldlineId,
        definitionId,
        continuityId,
        continuityKey,
      ],
    );
    const resolved = await client.query<{ id: string }>(
      `SELECT id
       FROM character_continuities
       WHERE workspace_id = $1 AND worldline_id = $2 AND continuity_key = $3`,
      [scope.workspaceId, worldlineId, continuityKey],
    );
    continuityId = resolved.rows[0]?.id ?? continuityId;
  }

  const instanceId = `char_inst_player_${recordId.slice(-12)}`;
  const participantId = `participant_player_${recordId.slice(-12)}`;
  await client.query(
    `INSERT INTO character_instances (
       workspace_id, world_id, worldline_id, record_id, continuity_id, id,
       controller_mode, status, instantiated_tick, instantiated_ordinal,
       inheritance_cutoff_tick, inheritance_cutoff_ordinal
     ) VALUES ($1, $2, $3, $4, $5, $6, 'human', 'present', 0, 0, 0, 0)`,
    [
      scope.workspaceId,
      worldId,
      worldlineId,
      recordId,
      continuityId,
      instanceId,
    ],
  );
  await client.query(
    `INSERT INTO participants (
       workspace_id, world_id, worldline_id, record_id, id,
       participant_kind, character_instance_id, principal_id,
       controller_mode, is_active, speaking_order
     ) VALUES ($1, $2, $3, $4, $5, 'character', $6, $7, 'human', true, 0)`,
    [
      scope.workspaceId,
      worldId,
      worldlineId,
      recordId,
      participantId,
      instanceId,
      scope.principalId,
    ],
  );
}

function normalizeWorld(row: WorldRow): LibraryWorld {
  const stories = Array.isArray(row.stories) ? row.stories : [];
  return {
    id: row.world_id,
    name: row.world_name,
    era: row.era,
    style: row.style,
    summary: row.summary,
    status: row.status,
    // T10-B6：list 的 EXISTS 过滤使 null 实际不可达；保底按 player 呈现。
    membershipRole: row.membership_role ?? "player",
    storyCount: Number(row.story_count ?? 0),
    branchCount: Number(row.branch_count ?? 0),
    recordCount: Number(row.record_count ?? 0),
    characterCount: Number(row.character_count ?? 0),
    lastActiveAt: row.last_active_at
      ? new Date(row.last_active_at).toISOString()
      : null,
    characters: Array.isArray(row.characters)
      ? row.characters.map((character: unknown) => {
          if (typeof character !== "object" || character === null) {
            return { id: "", name: "", role: "", summary: "", status: "", avatarFileId: "", sourceFormat: "" };
          }
          const item = character as Record<string, unknown>;
          return {
            id: String(item.id ?? ""),
            name: String(item.name ?? ""),
            role: String(item.role ?? ""),
            summary: String(item.summary ?? ""),
            status: String(item.status ?? ""),
            avatarFileId: String(item.avatarFileId ?? ""),
            sourceFormat: String(item.sourceFormat ?? ""),
          };
        })
      : [],
    worldlines: Array.isArray(row.worldlines)
      ? row.worldlines.map((worldline: unknown) => {
          if (typeof worldline !== "object" || worldline === null) {
            return { id: "", label: "", status: "", parentWorldlineId: null };
          }
          const item = worldline as Record<string, unknown>;
          return {
            id: String(item.id ?? ""),
            label: String(item.label ?? ""),
            status: String(item.status ?? ""),
            parentWorldlineId: typeof item.parentWorldlineId === "string"
              ? item.parentWorldlineId
              : null,
          };
        })
      : [],
    stories: stories.map((story: unknown) => {
      if (typeof story !== "object" || story === null) {
        return { id: "", title: "", status: "", premise: "", records: [] };
      }
      const value = story as Record<string, unknown>;
      return {
        id: String(value.id ?? ""),
        title: String(value.title ?? ""),
        status: String(value.status ?? ""),
        premise: String(value.premise ?? ""),
        records: Array.isArray(value.records)
          ? value.records.map((record) => {
              const item = record as Record<string, unknown>;
              return {
                id: String(item.id ?? ""),
                title: String(item.title ?? ""),
                status: String(item.status ?? ""),
                timelineKind: item.timelineKind === "retrospection"
                  || item.timelineKind === "merged"
                  || item.timelineKind === "branch"
                  ? item.timelineKind
                  : "primary",
                linkedRecordId: typeof item.linkedRecordId === "string"
                  ? item.linkedRecordId
                  : null,
              };
            })
          : [],
      };
    }),
  };
}
