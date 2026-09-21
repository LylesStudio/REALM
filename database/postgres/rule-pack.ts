/**
 * 批次 T4：PostgreSQL 数据驱动规则包（真实模型回合的裁决来源）。
 *
 * 规则引擎不持有任何世界内容：三类定义全部从本世界的定义表读出
 * （skill_definitions / asset_definitions / effect_definitions，含
 * metadata 判定参数），裁决逻辑复用 createDataDrivenRulePack 唯一实现。
 * 实例内缓存——同一规则包实例（回合级生命周期）内定义只读一次。
 *
 * 规范见 docs/development/T4-RULE-REALIZATION.md §2.3。
 */
import type { ActionRulePack } from "../../modules/actions/public.ts";
import {
  createDataDrivenRulePack,
  type AssetDefinitionRecord,
  type EffectDefinitionRecord,
  type RuleDefinitionProvider,
  type SkillDefinitionRecord,
} from "../../modules/actions/rule-pack.ts";
import {
  withWorkspaceTransaction,
  type WorkspaceDatabase,
} from "./workspace-transaction.ts";

export interface PostgresRulePackScope {
  workspaceId: string;
  worldId: string;
  /**
   * 批次 T5 抽牌不放回：record 级作用域（可选）。缺省时
   * listDrawnCards 返回空集 = 完整牌堆（无记录账本可查）。
   */
  worldlineId?: string;
  recordId?: string;
  /** 当前 Record 场景地点，用于渲染 `{location}` 发现模板。 */
  location?: string;
}

export function createPostgresRulePack(
  database: WorkspaceDatabase,
  scope: PostgresRulePackScope,
): ActionRulePack {
  if (!scope.workspaceId.trim() || !scope.worldId.trim()) {
    throw new Error("Rule Pack scope requires workspace and world identifiers.");
  }
  const skillCache = new Map<string, SkillDefinitionRecord | null>();
  const assetCache = new Map<string, AssetDefinitionRecord | null>();
  const stanceCache = new Map<string, EffectDefinitionRecord | null>();

  async function loadDefinition<T>(
    cache: Map<string, T | null>,
    key: string,
    loader: () => Promise<T | null>,
  ): Promise<T | null> {
    if (cache.has(key)) return cache.get(key) ?? null;
    const record = await loader();
    cache.set(key, record);
    return record;
  }

  const provider: RuleDefinitionProvider = {
    async loadDiscoveryContext() {
      return { location: scope.location?.trim() ?? "" };
    },
    async loadSkill(skillKey) {
      return loadDefinition(skillCache, skillKey, () =>
        withWorkspaceTransaction(
          database,
          scope.workspaceId,
          async (client) => {
            const result = await client.query<{
              id: string;
              skill_key: string;
              title: string;
              description: string;
              metadata: Record<string, unknown>;
            }>(
              `SELECT id, skill_key, title, description, metadata
               FROM skill_definitions
               WHERE workspace_id = $1 AND world_id = $2 AND skill_key = $3`,
              [scope.workspaceId, scope.worldId, skillKey],
            );
            const row = result.rows[0];
            if (!row) return null;
            return {
              definitionId: row.id,
              skillKey: row.skill_key,
              title: row.title,
              description: row.description,
              metadata: row.metadata ?? {},
            };
          },
          { readOnly: true },
        ));
    },
    async loadAsset(assetKey) {
      return loadDefinition(assetCache, assetKey, () =>
        withWorkspaceTransaction(
          database,
          scope.workspaceId,
          async (client) => {
            const result = await client.query<{
              id: string;
              asset_key: string;
              title: string;
              description: string;
              consumable: boolean;
              metadata: Record<string, unknown>;
            }>(
              `SELECT id, asset_key, title, description, consumable, metadata
               FROM asset_definitions
               WHERE workspace_id = $1 AND world_id = $2 AND asset_key = $3`,
              [scope.workspaceId, scope.worldId, assetKey],
            );
            const row = result.rows[0];
            if (!row) return null;
            return {
              definitionId: row.id,
              assetKey: row.asset_key,
              title: row.title,
              description: row.description,
              consumable: row.consumable,
              metadata: row.metadata ?? {},
            };
          },
          { readOnly: true },
        ));
    },
    async loadStance(stanceKey) {
      return loadDefinition(stanceCache, stanceKey, () =>
        withWorkspaceTransaction(
          database,
          scope.workspaceId,
          async (client) => {
            const result = await client.query<{
              id: string;
              effect_key: string;
              title: string;
              description: string;
              effect_kind: string;
              metadata: Record<string, unknown>;
            }>(
              `SELECT id, effect_key, title, description, effect_kind, metadata
               FROM effect_definitions
               WHERE workspace_id = $1
                 AND world_id = $2
                 AND effect_key = $3
                 AND effect_kind = 'stance'`,
              [scope.workspaceId, scope.worldId, stanceKey],
            );
            const row = result.rows[0];
            if (!row) return null;
            return {
              definitionId: row.id,
              effectKey: row.effect_key,
              title: row.title,
              description: row.description,
              effectKind: row.effect_kind,
              metadata: row.metadata ?? {},
            };
          },
          { readOnly: true },
        ));
    },
    // 批次 T5 抽牌不放回：本记录内该行动者该技能已物化的抽牌
    // （action_receipts.receipt->'mechanic'，与源事件同事务落库）。
    async listDrawnCards({ skillKey, actorCharacterInstanceId }) {
      if (!scope.recordId) return [];
      const result = await withWorkspaceTransaction(
        database,
        scope.workspaceId,
        async (client) =>
          client.query<{ card: string }>(
            `SELECT receipt->'mechanic'->>'drawnCard' AS card
             FROM action_receipts
             WHERE workspace_id = $1
               AND world_id = $2
               AND record_id = $3
               AND actor_character_instance_id = $4
               AND receipt->'mechanic'->>'system' = 'draw'
               AND receipt->'mechanic'->>'skillKey' = $5`,
            [
              scope.workspaceId,
              scope.worldId,
              scope.recordId,
              actorCharacterInstanceId,
              skillKey,
            ],
          ),
        { readOnly: true },
      );
      return result.rows.map((row) => row.card);
    },
  };

  return createDataDrivenRulePack(provider);
}
