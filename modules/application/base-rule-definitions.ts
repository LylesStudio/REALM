/**
 * 批次 T4：创世/装配/导入时按世界文风生成的基础规则定义。
 *
 * 数量受控防泛滥——固定 2 技能 + 1 资产 + 1 姿态，确定性文案、
 * 无模型调用：
 * - 技能 keen_insight：带 check（d20 +1 / target 10），走判定分支；
 * - 技能 steady_hand：无 check，走自动成功分支；
 * - 资产 travel_kit：consumable（账本数量扣减）；
 * - 姿态 watchful_guard：effect_kind='stance'。
 *
 * 定义即数据：落 skill_definitions/asset_definitions/effect_definitions，
 * 判定参数写入 metadata（契约见 public documentation §2.2）。
 * 所有写入幂等（ON CONFLICT DO NOTHING），重复调用不产生重复行。
 */
import type { PoolClient } from "pg";
import { normalizeWorldStyle, type WorldStyle } from "../style/world-style.ts";

const BASE_RULE_PACK_KEY = "realm.base.v1";

interface BaseSkillSeed {
  skillKey: string;
  /** metadata.check；缺省 → 自动成功技能。 */
  check?: { system: "d20"; modifier: number; target: number; partialMargin?: number };
}

interface BaseCopy {
  title: string;
  description: string;
}

export const BASE_SKILLS: readonly BaseSkillSeed[] = [
  {
    skillKey: "keen_insight",
    check: { system: "d20", modifier: 1, target: 10, partialMargin: 2 },
  },
  { skillKey: "steady_hand" },
];
export const BASE_ASSET = { assetKey: "travel_kit", consumable: true } as const;
export const BASE_STANCE = { effectKey: "watchful_guard" } as const;
export const BASE_PLAYER_ASSET_QUANTITY = 2;

const BASE_DEFINITION_COPY: Record<WorldStyle, Record<string, BaseCopy>> = {
  modern: {
    keen_insight: { title: "锐意洞察", description: "在短暂的观察中抓住关键细节。" },
    steady_hand: { title: "稳定操作", description: "沉着完成手头的每一件事。" },
    travel_kit: { title: "旅行工具包", description: "一套便携而可靠的常用工具。" },
    watchful_guard: { title: "警觉守望", description: "保持警觉，留意周围的变化。" },
  },
  classical: {
    keen_insight: { title: "明察", description: "于细微处见真章。" },
    steady_hand: { title: "稳手", description: "举止沉稳，不急不躁。" },
    travel_kit: { title: "行囊", description: "随身行囊，内有常用之物。" },
    watchful_guard: { title: "守望", description: "凝神守望，不动声色。" },
  },
  western_fantasy: {
    keen_insight: { title: "锐目洞察", description: "以老练的目光看穿表象。" },
    steady_hand: { title: "稳健之手", description: "以稳健的手法处理眼前事务。" },
    travel_kit: { title: "旅者行装", description: "长途跋涉必备的装备包。" },
    watchful_guard: { title: "戒备守望", description: "进入戒备，守望四方。" },
  },
  anime: {
    keen_insight: { title: "锐利直觉", description: "一瞬间捕捉到重要的线索！" },
    steady_hand: { title: "稳稳的一手", description: "稳稳当当地完成每个动作！" },
    travel_kit: { title: "冒险工具包", description: "出门在外必备的百宝包！" },
    watchful_guard: { title: "全神守望", description: "全神贯注地盯着周围的动静！" },
  },
};

function copyFor(style: WorldStyle, key: string): BaseCopy {
  return BASE_DEFINITION_COPY[style][key] ?? BASE_DEFINITION_COPY.modern[key]!;
}

function metadataForSkill(seed: BaseSkillSeed): Record<string, unknown> {
  if (seed.skillKey !== "keen_insight") {
    return seed.check ? { check: { ...seed.check } } : {};
  }
  return {
    ...(seed.check ? { check: { ...seed.check } } : {}),
    defaultTargetId: "scene_surroundings",
  };
}

export interface BaseRuleDefinitionScope {
  workspaceId: string;
  worldId: string;
}

/**
 * 确保本世界存在基础规则定义（幂等）。style 缺省/未知 → modern。
 * 返回三类定义的行 id，供授权（character_skills/character_assets）使用。
 */
export async function ensureWorldBaseRuleDefinitions(
  client: PoolClient,
  scope: BaseRuleDefinitionScope,
  styleRaw: unknown,
): Promise<{
  skillDefinitionIds: ReadonlyMap<string, string>;
  assetDefinitionId: string;
  stanceDefinitionId: string;
}> {
  const style = normalizeWorldStyle(styleRaw);

  for (const seed of BASE_SKILLS) {
    const copy = copyFor(style, seed.skillKey);
    await client.query(
      `INSERT INTO skill_definitions (
         workspace_id, world_id, id, skill_key, title, description,
         rule_pack_key, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       ON CONFLICT (workspace_id, world_id, skill_key) DO NOTHING`,
      [
        scope.workspaceId,
        scope.worldId,
        `base_skill_${seed.skillKey}_${scope.worldId.slice(-24)}`,
        seed.skillKey,
        copy.title,
        copy.description,
        BASE_RULE_PACK_KEY,
        JSON.stringify(metadataForSkill(seed)),
      ],
    );
  }

  const assetCopy = copyFor(style, BASE_ASSET.assetKey);
  await client.query(
    `INSERT INTO asset_definitions (
       workspace_id, world_id, id, asset_key, title, description,
       rule_pack_key, consumable, metadata
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '{}'::jsonb)
     ON CONFLICT (workspace_id, world_id, asset_key) DO NOTHING`,
    [
      scope.workspaceId,
      scope.worldId,
      `base_asset_${BASE_ASSET.assetKey}_${scope.worldId.slice(-24)}`,
      BASE_ASSET.assetKey,
      assetCopy.title,
      assetCopy.description,
      BASE_RULE_PACK_KEY,
      BASE_ASSET.consumable,
    ],
  );

  const stanceCopy = copyFor(style, BASE_STANCE.effectKey);
  await client.query(
    `INSERT INTO effect_definitions (
       workspace_id, world_id, id, effect_key, title, description,
       rule_pack_key, effect_kind, metadata
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'stance', '{}'::jsonb)
     ON CONFLICT (workspace_id, world_id, effect_key) DO NOTHING`,
    [
      scope.workspaceId,
      scope.worldId,
      `base_stance_${BASE_STANCE.effectKey}_${scope.worldId.slice(-24)}`,
      BASE_STANCE.effectKey,
      stanceCopy.title,
      stanceCopy.description,
      BASE_RULE_PACK_KEY,
    ],
  );

  const keys = BASE_SKILLS.map((seed) => seed.skillKey);
  const skillRows = await client.query<{ skill_key: string; id: string }>(
    `SELECT skill_key, id
     FROM skill_definitions
     WHERE workspace_id = $1 AND world_id = $2 AND skill_key = ANY($3)`,
    [scope.workspaceId, scope.worldId, keys],
  );
  const skillDefinitionIds = new Map<string, string>(
    skillRows.rows.map((row) => [row.skill_key, row.id]),
  );
  const assetRow = await client.query<{ id: string }>(
    `SELECT id
     FROM asset_definitions
     WHERE workspace_id = $1 AND world_id = $2 AND asset_key = $3`,
    [scope.workspaceId, scope.worldId, BASE_ASSET.assetKey],
  );
  const stanceRow = await client.query<{ id: string }>(
    `SELECT id
     FROM effect_definitions
     WHERE workspace_id = $1 AND world_id = $2 AND effect_key = $3`,
    [scope.workspaceId, scope.worldId, BASE_STANCE.effectKey],
  );
  const assetDefinitionId = assetRow.rows[0]?.id;
  const stanceDefinitionId = stanceRow.rows[0]?.id;
  if (!assetDefinitionId || !stanceDefinitionId) {
    throw new Error("Base rule definitions could not be ensured for this world.");
  }
  return { skillDefinitionIds, assetDefinitionId, stanceDefinitionId };
}

export interface BaseRuleGrantScope extends BaseRuleDefinitionScope {
  worldlineId: string;
  recordId: string;
}

/** 基础技能授权给指定角色实例（记录级，acquired (0,0)，幂等）。 */
export async function grantBaseSkillsToInstances(
  client: PoolClient,
  scope: BaseRuleGrantScope,
  definitionIds: ReadonlyMap<string, string>,
  characterInstanceIds: readonly string[],
): Promise<void> {
  for (const instanceId of characterInstanceIds) {
    for (const definitionId of definitionIds.values()) {
      await client.query(
        `INSERT INTO character_skills (
           workspace_id, world_id, worldline_id, record_id,
           character_instance_id, skill_definition_id,
           acquired_tick, acquired_ordinal
         ) VALUES ($1, $2, $3, $4, $5, $6, 0, 0)
         ON CONFLICT (
           workspace_id, record_id, character_instance_id, skill_definition_id
         ) DO NOTHING`,
        [
          scope.workspaceId,
          scope.worldId,
          scope.worldlineId,
          scope.recordId,
          instanceId,
          definitionId,
        ],
      );
    }
  }
}

/** 批次 T6：挂入/装配的 AI 角色实例的基础资产余量（玩家主角 2 不变）。 */
export const BASE_AI_ASSET_QUANTITY = 1;

/**
 * 基础资产授权（quantity 受控，幂等）。缺省为玩家余量
 * （BASE_PLAYER_ASSET_QUANTITY）；批次 T6 起 AI 实例按 BASE_AI_ASSET_QUANTITY。
 */
export async function grantBaseAssetToInstance(
  client: PoolClient,
  scope: BaseRuleGrantScope,
  assetDefinitionId: string,
  characterInstanceId: string,
  quantity: number = BASE_PLAYER_ASSET_QUANTITY,
): Promise<void> {
  await client.query(
    `INSERT INTO character_assets (
       workspace_id, world_id, worldline_id, record_id,
       character_instance_id, asset_definition_id, quantity
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (
       workspace_id, record_id, character_instance_id, asset_definition_id
     ) DO NOTHING`,
    [
      scope.workspaceId,
      scope.worldId,
      scope.worldlineId,
      scope.recordId,
      characterInstanceId,
      assetDefinitionId,
      quantity,
    ],
  );
}

/**
 * 批次 T6：卡携带技能授权——按角色定义的 profile.realm_skill_keys 查
 * 定义行并授权 character_skills（acquired (0,0)，ON CONFLICT 幂等）。
 * 角色无 realm_skill_keys（原生角色/无技能卡）→ 零操作。
 */
export async function grantCharacterCardSkills(
  client: PoolClient,
  scope: BaseRuleGrantScope,
  characterDefinitionId: string,
  characterInstanceIds: readonly string[],
): Promise<void> {
  const definition = await client.query<{ keys: unknown }>(
    `SELECT profile->'realm_skill_keys' AS keys
     FROM character_definitions
     WHERE workspace_id = $1 AND world_id = $2 AND id = $3`,
    [scope.workspaceId, scope.worldId, characterDefinitionId],
  );
  const rawKeys = definition.rows[0]?.keys;
  const keys = Array.isArray(rawKeys)
    ? rawKeys.filter((key): key is string => typeof key === "string" && key.trim().length > 0)
    : [];
  if (keys.length === 0) return;
  const definitions = await client.query<{ id: string }>(
    `SELECT id
     FROM skill_definitions
     WHERE workspace_id = $1 AND world_id = $2 AND skill_key = ANY($3)`,
    [scope.workspaceId, scope.worldId, keys],
  );
  for (const instanceId of characterInstanceIds) {
    for (const row of definitions.rows) {
      await client.query(
        `INSERT INTO character_skills (
           workspace_id, world_id, worldline_id, record_id,
           character_instance_id, skill_definition_id,
           acquired_tick, acquired_ordinal
         ) VALUES ($1, $2, $3, $4, $5, $6, 0, 0)
         ON CONFLICT (
           workspace_id, record_id, character_instance_id, skill_definition_id
         ) DO NOTHING`,
        [
          scope.workspaceId,
          scope.worldId,
          scope.worldlineId,
          scope.recordId,
          instanceId,
          row.id,
        ],
      );
    }
  }
}

/** 读取世界 settings.style（缺省 null → modern）。 */
export async function readWorldStyle(
  client: PoolClient,
  scope: BaseRuleDefinitionScope,
): Promise<string | null> {
  const result = await client.query<{ style: string | null }>(
    `SELECT settings->>'style' AS style
     FROM worlds
     WHERE workspace_id = $1 AND id = $2`,
    [scope.workspaceId, scope.worldId],
  );
  return result.rows[0]?.style ?? null;
}
