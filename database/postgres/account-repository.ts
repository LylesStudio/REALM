import type { Pool } from "pg";
import {
  normalizeUiLanguage,
  type UiLanguage,
} from "../../modules/i18n/public.ts";
import {
  normalizeSceneImageMode,
  type SceneImageMode,
} from "../../modules/imagine/scene-image-mode.ts";
import {
  hashAccountPassword,
  PasswordPolicyError,
  verifyAccountPassword,
} from "../../modules/identity/password.ts";
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

/**
 * 登录失败统一错误（安全语义）：不泄露账户是否存在/是否有密码/hash。
 * INVALID_CREDENTIALS = 唯一对外形态。
 */
export class AccountAuthError extends Error {
  readonly code: "INVALID_CREDENTIALS";

  constructor() {
    super("账户名或密码不正确。");
    this.name = "AccountAuthError";
    this.code = "INVALID_CREDENTIALS";
  }
}

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
  /** 场景图自动模式（0049）：账号级读取；无账号/无值 fail-closed off。 */
  findSceneImageMode(
    workspaceId: string,
    principalId: string,
  ): Promise<SceneImageMode>;
  /** 保存场景图自动模式（列级 UPDATE，0049 授权）。 */
  saveSceneImageMode(
    workspaceId: string,
    principalId: string,
    mode: SceneImageMode,
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
  /**
   * 账户名 + 可选密码登录（0051）：新账户首次创建可写密码；既有无密码
   * 账户仅空密码通过；有密码账户严格校验。所有失败统一
   * AccountAuthError（INVALID_CREDENTIALS），不泄露账户存在性。
   */
  loginWithCredentials(
    workspaceId: string,
    displayName: string,
    password: string,
  ): Promise<AccountRecord>;
  /** 设置/修改密码：有密码账户必须校验旧密码；只作用当前 principal。 */
  setAccountPassword(
    workspaceId: string,
    principalId: string,
    input: { currentPassword: string; newPassword: string },
  ): Promise<void>;
  /** 明确清除密码：必须校验当前密码。 */
  clearAccountPassword(
    workspaceId: string,
    principalId: string,
    input: { currentPassword: string },
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

    async findSceneImageMode(workspaceId, principalId) {
      return withWorkspaceTransaction(
        pool,
        workspaceId,
        async (client) => {
          const result = await client.query(
            `SELECT scene_image_mode
             FROM accounts
             WHERE workspace_id = $1 AND principal_id = $2`,
            [workspaceId, principalId],
          );
          // 无账号行/未知值 fail-closed off（绝不默认消耗 GPU）。
          return normalizeSceneImageMode(result.rows[0]?.scene_image_mode);
        },
        { readOnly: true },
      );
    },

    async saveSceneImageMode(workspaceId, principalId, mode) {
      return withWorkspaceTransaction(pool, workspaceId, async (client) => {
        await client.query(
          `UPDATE accounts
           SET scene_image_mode = $3
           WHERE workspace_id = $1 AND principal_id = $2`,
          [workspaceId, principalId, normalizeSceneImageMode(mode)],
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

    async loginWithCredentials(workspaceId, displayName, password) {
      const name = displayName.trim();
      if (!name || name.length > 40) {
        throw new AccountAuthError();
      }
      return withWorkspaceTransaction(pool, workspaceId, async (client) => {
        const principalId = principalIdForDisplayName(name);
        const existing = await client.query(
          `SELECT principal_id, display_name, created_at::text, ui_language, password_hash
           FROM accounts
           WHERE workspace_id = $1 AND principal_id = $2`,
          [workspaceId, principalId],
        );
        const row = existing.rows[0];
        if (!row) {
          // 新账户：首次创建可写密码（空密码 = 无密码账户）。
          const passwordHash = password ? hashAccountPassword(password) : null;
          await client.query(
            `INSERT INTO accounts (workspace_id, principal_id, display_name, password_hash)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (workspace_id, principal_id) DO NOTHING`,
            [workspaceId, principalId, name, passwordHash],
          );
          return {
            principalId,
            displayName: name,
            createdAt: new Date().toISOString(),
            uiLanguage: normalizeUiLanguage(undefined),
          };
        }
        const storedHash = typeof row.password_hash === "string" ? row.password_hash : null;
        if (storedHash === null) {
          // 既有无密码账户：非空密码一律拒绝（绝不在登录时静默设置/覆盖）。
          if (password) throw new AccountAuthError();
        } else if (!verifyAccountPassword(password, storedHash)) {
          throw new AccountAuthError();
        }
        return {
          principalId: row.principal_id as string,
          displayName: row.display_name as string,
          createdAt: row.created_at as string,
          uiLanguage: normalizeUiLanguage(row.ui_language),
        };
      });
    },

    async setAccountPassword(workspaceId, principalId, input) {
      if (!input.newPassword.trim()) {
        throw new PasswordPolicyError("新密码不能为空。");
      }
      return withWorkspaceTransaction(pool, workspaceId, async (client) => {
        const row = await credentialsRow(client, workspaceId, principalId);
        if (!row) throw new AccountAuthError();
        // 有密码账户修改必须校验旧密码。
        if (row.password_hash !== null
          && !verifyAccountPassword(input.currentPassword, row.password_hash)) {
          throw new AccountAuthError();
        }
        await client.query(
          `UPDATE accounts SET password_hash = $3
           WHERE workspace_id = $1 AND principal_id = $2`,
          [workspaceId, principalId, hashAccountPassword(input.newPassword)],
        );
      });
    },

    async clearAccountPassword(workspaceId, principalId, input) {
      return withWorkspaceTransaction(pool, workspaceId, async (client) => {
        const row = await credentialsRow(client, workspaceId, principalId);
        if (!row || row.password_hash === null) return; // 无密码账户清除是幂等空操作
        if (!verifyAccountPassword(input.currentPassword, row.password_hash)) {
          throw new AccountAuthError();
        }
        await client.query(
          `UPDATE accounts SET password_hash = NULL
           WHERE workspace_id = $1 AND principal_id = $2`,
          [workspaceId, principalId],
        );
      });
    },
  };
}

/** 凭据行读取（仅内部使用；password_hash 绝不离开本模块边界之外的服务端）。 */
async function credentialsRow(
  client: { query: (sql: string, params: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  workspaceId: string,
  principalId: string,
): Promise<{ password_hash: string | null } | null> {
  const result = await client.query(
    `SELECT password_hash FROM accounts
     WHERE workspace_id = $1 AND principal_id = $2`,
    [workspaceId, principalId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    password_hash: typeof row.password_hash === "string" ? row.password_hash : null,
  };
}
