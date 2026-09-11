import type { Pool } from "pg";
import {
  normalizeUiLanguage,
  type UiLanguage,
} from "../../modules/i18n/public.ts";
import { principalIdForDisplayName } from "../../modules/identity/auth.ts";
import { POSTGRES_DEMO_IDS } from "./demo-seed.ts";
import { withWorkspaceTransaction } from "./workspace-transaction.ts";

export type AccountRecord = {
  principalId: string;
  displayName: string;
  createdAt: string;
  /** 用户级界面语言（缺省 zh-CN）。 */
  uiLanguage: UiLanguage;
};

export interface AccountRepository {
  /** 昵称即身份：已有昵称复用同一 principal，新昵称自动创建。 */
  findOrCreate(workspaceId: string, displayName: string): Promise<AccountRecord>;
  /** 按 principal 反查账号（会话 cookie 只携带 principalId）。 */
  findByPrincipal(
    workspaceId: string,
    principalId: string,
  ): Promise<AccountRecord | null>;
  /** 保存用户级界面语言。 */
  saveUiLanguage(
    workspaceId: string,
    principalId: string,
    language: UiLanguage,
  ): Promise<void>;
  /**
   * 登录即加入默认世界（demo seed 常量引用，不硬编码字符串）：
   * 查无则创建 owner membership，已有则不动（幂等）。
   */
  ensureDefaultWorldMembership(
    workspaceId: string,
    principalId: string,
  ): Promise<void>;
  /**
   * 批次 S：读取账号级「最近打开」记忆；无记忆（NULL）返回 null。
   * last_record_id 有 FK 守护（记录删除自动置空），读出的值必可打开。
   */
  findLastOpened(
    workspaceId: string,
    principalId: string,
  ): Promise<{ worldId: string; recordId: string } | null>;
  /** 批次 S：保存账号级「最近打开」记忆（每次成功加载记录后调用）。 */
  saveLastOpened(
    workspaceId: string,
    principalId: string,
    worldId: string,
    recordId: string,
  ): Promise<void>;
}

export function createPostgresAccountRepository(pool: Pool): AccountRepository {
  return {
    async findOrCreate(workspaceId, displayName) {
      const name = displayName.trim();
      if (!name || name.length > 40) {
        throw new Error("Display name must be 1-40 characters.");
      }
      return withWorkspaceTransaction(pool, workspaceId, async (client) => {
        const principalId = principalIdForDisplayName(name);
        await client.query(
          `INSERT INTO accounts (workspace_id, principal_id, display_name)
           VALUES ($1, $2, $3)
           ON CONFLICT (workspace_id, display_name) DO NOTHING`,
          [workspaceId, principalId, name],
        );
        const result = await client.query(
          `SELECT principal_id, display_name, created_at::text
           FROM accounts
           WHERE workspace_id = $1 AND display_name = $2`,
          [workspaceId, name],
        );
        const row = result.rows[0];
        return {
          principalId: row.principal_id as string,
          displayName: row.display_name as string,
          createdAt: row.created_at as string,
          uiLanguage: normalizeUiLanguage(row.ui_language),
        };
      });
    },

    async findByPrincipal(workspaceId, principalId) {
      return withWorkspaceTransaction(
        pool,
        workspaceId,
        async (client) => {
          const result = await client.query(
            `SELECT principal_id, display_name, created_at::text, ui_language
             FROM accounts
             WHERE workspace_id = $1 AND principal_id = $2`,
            [workspaceId, principalId],
          );
          const row = result.rows[0];
          if (!row) return null;
          return {
            principalId: row.principal_id as string,
            displayName: row.display_name as string,
            createdAt: row.created_at as string,
            uiLanguage: normalizeUiLanguage(row.ui_language),
          };
        },
        { readOnly: true },
      );
    },

    async saveUiLanguage(workspaceId, principalId, language) {
      return withWorkspaceTransaction(pool, workspaceId, async (client) => {
        await client.query(
          `UPDATE accounts
           SET ui_language = $3
           WHERE workspace_id = $1 AND principal_id = $2`,
          [workspaceId, principalId, normalizeUiLanguage(language)],
        );
      });
    },

    async ensureDefaultWorldMembership(workspaceId, principalId) {
      return withWorkspaceTransaction(pool, workspaceId, async (client) => {
        await client.query(
          `INSERT INTO player_world_memberships (
             workspace_id, world_id, principal_id, role,
             omniscient_player_character, can_view_dynamic_knowledge
           ) VALUES ($1, $2, $3, 'owner', true, true)
           ON CONFLICT (workspace_id, world_id, principal_id) DO NOTHING`,
          [workspaceId, POSTGRES_DEMO_IDS.world, principalId],
        );
      });
    },

    async findLastOpened(workspaceId, principalId) {
      return withWorkspaceTransaction(
        pool,
        workspaceId,
        async (client) => {
          const result = await client.query(
            `SELECT last_world_id, last_record_id
             FROM accounts
             WHERE workspace_id = $1 AND principal_id = $2`,
            [workspaceId, principalId],
          );
          const row = result.rows[0];
          if (!row || !row.last_record_id) return null;
          return {
            worldId: typeof row.last_world_id === "string" ? row.last_world_id : "",
            recordId: row.last_record_id as string,
          };
        },
        { readOnly: true },
      );
    },

    async saveLastOpened(workspaceId, principalId, worldId, recordId) {
      return withWorkspaceTransaction(pool, workspaceId, async (client) => {
        await client.query(
          `UPDATE accounts
           SET last_world_id = $3, last_record_id = $4
           WHERE workspace_id = $1 AND principal_id = $2`,
          [workspaceId, principalId, worldId, recordId],
        );
      });
    },
  };
}
