import type { Pool, QueryResultRow } from "pg";
import type {
  ActionAffordance,
  ActionAffordanceCatalog,
  ActionAffordanceScope,
  CharacterSkillProvider,
} from "../../modules/actions/public.ts";
import { normalizeUiLanguage } from "../../modules/i18n/public.ts";
import {
  normalizeWorldStyle,
  worldStyleText,
} from "../../modules/style/world-style.ts";
import { withWorkspaceTransaction } from "./workspace-transaction.ts";

interface CapabilityRow extends QueryResultRow {
  capability_id: string;
  capability_kind: "skill" | "asset" | "stance" | "scene";
  title: string;
  description: string;
  quantity: string | number | null;
  actor_name: string;
  scene_location: string | null;
  scene_weather: string | null;
  world_style?: string | null;
  world_language?: string | null;
  capability_metadata?: string | null;
}

export function createPostgresActionAffordanceCatalog(
  pool: Pool,
): ActionAffordanceCatalog {
  return {
    async listAuthorized(scope) {
      validateScope(scope);
      return withWorkspaceTransaction(pool, scope.workspaceId, async (client) => {
        const result = await client.query<CapabilityRow>(CAPABILITIES_SQL, [
          scope.workspaceId,
          scope.worldId,
          scope.worldlineId,
          scope.recordId,
          scope.principalId,
          scope.characterInstanceId,
        ]);
        return result.rows.map((row) => mapCapability(row, scope));
      });
    },
  };
}

/** 记录级技能持有投影（角色提示词与 use_skill 校验的数据源）。 */
export interface CharacterSkillScope {
  workspaceId: string;
  worldId: string;
  worldlineId: string;
  recordId: string;
}

/**
 * 批次 T4：按世界数据（character_skills + skill_definitions）加载角色
 * 实际持有的技能；世界游标门禁——acquired 不晚于记录头才可见。
 */
export function createPostgresCharacterSkillProvider(
  pool: Pool,
  scope: CharacterSkillScope,
): CharacterSkillProvider {
  return {
    async listSkills(characterInstanceId) {
      if (!characterInstanceId.trim()) return [];
      return withWorkspaceTransaction(
        pool,
        scope.workspaceId,
        async (client) => {
          const result = await client.query<{
            skillKey: string;
            title: string;
            description: string;
          } & QueryResultRow>(
            `SELECT skill.skill_key AS "skillKey",
                    skill.title AS "title",
                    skill.description AS "description"
             FROM character_skills AS owned
             JOIN skill_definitions AS skill
               ON skill.workspace_id = owned.workspace_id
              AND skill.world_id = owned.world_id
              AND skill.id = owned.skill_definition_id
             JOIN record_heads AS head
               ON head.workspace_id = owned.workspace_id
              AND head.record_id = owned.record_id
             WHERE owned.workspace_id = $1
               AND owned.world_id = $2
               AND owned.worldline_id = $3
               AND owned.record_id = $4
               AND owned.character_instance_id = $5
               AND (owned.acquired_tick, owned.acquired_ordinal)
                 <= (head.last_world_tick, head.last_world_ordinal)
             ORDER BY skill.skill_key ASC`,
            [
              scope.workspaceId,
              scope.worldId,
              scope.worldlineId,
              scope.recordId,
              characterInstanceId,
            ],
          );
          return result.rows.map((row) => ({
            skillKey: row.skillKey,
            title: row.title,
            description: row.description,
          }));
        },
        { readOnly: true },
      );
    },
  };
}

function validateScope(scope: ActionAffordanceScope): void {
  if (Object.values(scope).some((value) => !value.trim())) {
    throw new Error("Action affordance scope identifiers must be non-empty.");
  }
}

interface SceneCopySource {
  scene_location: string | null;
  scene_weather: string | null;
}

/** 能力目录行带世界文风（worlds.settings.style，缺省 modern）。 */
interface StyledCopySource extends SceneCopySource {
  world_style?: string | null;
  world_language?: string | null;
}

/**
 * 「观察四周」文案按当前场景快照生成：场景生长后贴合其地点/天气，
 * 留白状态用中性兜底，绝不编造任何世界的具体意象。
 * 规范见 public documentation。
 */
export function composeObserveSurroundingsCopy(
  scene: StyledCopySource,
): { description: string; suggestedText: string } {
  const style = normalizeWorldStyle(scene.world_style);
  const language = normalizeUiLanguage(scene.world_language);
  const location = scene.scene_location?.trim() ?? "";
  if (!location) {
    return {
      description: worldStyleText("action.observe.description.blank", style, undefined, language),
      suggestedText: worldStyleText("action.observe.suggested.blank", style, undefined, language),
    };
  }
  const weather = scene.scene_weather?.trim() ?? "";
  return {
    description: worldStyleText(
      "action.observe.description.scenic",
      style,
      weather ? { location, weather } : { location },
      language,
    ).replace(/（\{weather\}）/, "").replace(/（）/, ""),
    suggestedText: worldStyleText(
      "action.observe.suggested.scenic",
      style,
      { location },
      language,
    ),
  };
}

/** 资产建议语由资产自身名称生成，不写死任何世界的具体物件。 */
export function composeAssetSuggestion(assetTitle: string): string {
  const title = assetTitle.trim();
  return title ? `我使用${title}。` : "我使用这件物品。";
}

function mapCapability(
  row: CapabilityRow,
  scope: ActionAffordanceScope,
): ActionAffordance {
  if (row.capability_kind === "skill") {
    const defaultTargetId = readDefaultTargetId(row.capability_metadata);
    return {
      id: `skill.${row.capability_id}${defaultTargetId ? `.${defaultTargetId}` : ""}`,
      kind: "skill",
      actorCharacterInstanceId: scope.characterInstanceId,
      actorName: row.actor_name,
      title: row.title,
      description: row.description,
      suggestedText: `我施展「${row.title}」。`,
    };
  }
  if (row.capability_kind === "asset") {
    const quantity = Number(row.quantity);
    return {
      id: `asset.${row.capability_id}`,
      kind: "asset",
      actorCharacterInstanceId: scope.characterInstanceId,
      actorName: row.actor_name,
      title: row.title,
      description: `${row.description}（剩余 ${quantity} 次）`,
      suggestedText: composeAssetSuggestion(row.title),
    };
  }
  if (row.capability_kind === "stance") {
    return {
      id: `stance.${row.capability_id}`,
      kind: "stance",
      actorCharacterInstanceId: scope.characterInstanceId,
      actorName: row.actor_name,
      title: row.title,
      description: row.description,
      suggestedText: `我进入${row.title}，保持戒备。`,
    };
  }
  const observeCopy = composeObserveSurroundingsCopy(row);
  return {
    id: "scene.observe_surroundings",
    kind: "scene",
    actorCharacterInstanceId: scope.characterInstanceId,
    actorName: row.actor_name,
    title: "观察四周",
    description: observeCopy.description,
    suggestedText: observeCopy.suggestedText,
  };
}

/** 能力 id 后缀来自技能定义 metadata.defaultTargetId（缺省则无后缀）。 */
function readDefaultTargetId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const metadata = JSON.parse(raw) as Record<string, unknown>;
    const target = metadata.defaultTargetId;
    if (typeof target === "string" && target.trim()) return target.trim();
  } catch {
    // metadata 损坏不应污染能力目录：按无默认目标处理。
  }
  return null;
}

const CAPABILITIES_SQL = `
  WITH authorized_actor AS (
    SELECT
      definition.display_name AS actor_name,
      head.last_world_tick,
      head.last_world_ordinal,
      current_scene.location AS scene_location,
      COALESCE(world.settings->>'weather', '') AS scene_weather,
      COALESCE(world.settings->>'style', '') AS world_style,
      COALESCE((
        SELECT account.ui_language
        FROM player_world_memberships AS owner_membership
        JOIN accounts AS account
          ON account.workspace_id = owner_membership.workspace_id
         AND account.principal_id = owner_membership.principal_id
        WHERE owner_membership.workspace_id = participant.workspace_id
          AND owner_membership.world_id = participant.world_id
          AND owner_membership.role = 'owner'
        GROUP BY account.ui_language
        ORDER BY count(*) DESC, account.ui_language ASC
        LIMIT 1
      ), 'zh-CN') AS world_language
    FROM participants AS participant
    JOIN character_instances AS instance
      ON instance.workspace_id = participant.workspace_id
     AND instance.world_id = participant.world_id
     AND instance.worldline_id = participant.worldline_id
     AND instance.record_id = participant.record_id
     AND instance.id = participant.character_instance_id
    JOIN character_continuities AS continuity
      ON continuity.workspace_id = instance.workspace_id
     AND continuity.world_id = instance.world_id
     AND continuity.worldline_id = instance.worldline_id
     AND continuity.id = instance.continuity_id
    JOIN character_definitions AS definition
      ON definition.workspace_id = continuity.workspace_id
     AND definition.world_id = continuity.world_id
     AND definition.id = continuity.definition_id
    JOIN record_heads AS head
      ON head.workspace_id = participant.workspace_id
     AND head.world_id = participant.world_id
     AND head.worldline_id = participant.worldline_id
     AND head.record_id = participant.record_id
    JOIN worlds AS world
      ON world.workspace_id = participant.workspace_id
     AND world.id = participant.world_id
    LEFT JOIN LATERAL (
      SELECT candidate.location
      FROM scenes AS candidate
      WHERE candidate.workspace_id = participant.workspace_id
        AND candidate.world_id = participant.world_id
        AND candidate.worldline_id = participant.worldline_id
        AND candidate.record_id = participant.record_id
        AND (candidate.start_tick, candidate.start_ordinal)
          <= (head.last_world_tick, head.last_world_ordinal)
      ORDER BY candidate.start_tick DESC, candidate.start_ordinal DESC, candidate.id ASC
      LIMIT 1
    ) AS current_scene ON true
    WHERE participant.workspace_id = $1
      AND participant.world_id = $2
      AND participant.worldline_id = $3
      AND participant.record_id = $4
      AND participant.character_instance_id = $6
      AND participant.is_active = true
      AND instance.status = 'present'
      AND (
        participant.principal_id = $5
        -- 共享世界中，请求方没有自己的席位时沿用记录的人类席位，
        -- 与 RecordRuntimeScope 的玩家解析保持一致（提交路径早已如此）。
        OR (
          participant.controller_mode = 'human'
          AND NOT EXISTS (
            SELECT 1
            FROM participants AS mine
            WHERE mine.workspace_id = participant.workspace_id
              AND mine.record_id = participant.record_id
              AND mine.principal_id = $5
              AND mine.participant_kind = 'character'
          )
        )
      )
      AND EXISTS (
        SELECT 1 FROM scenes AS current_scene
        WHERE current_scene.workspace_id = participant.workspace_id
          AND current_scene.world_id = participant.world_id
          AND current_scene.worldline_id = participant.worldline_id
          AND current_scene.record_id = participant.record_id
          AND current_scene.status = 'active'
          AND (current_scene.start_tick, current_scene.start_ordinal)
            <= (head.last_world_tick, head.last_world_ordinal)
          AND (
            current_scene.end_tick IS NULL
            OR (current_scene.end_tick, current_scene.end_ordinal)
              >= (head.last_world_tick, head.last_world_ordinal)
          )
      )
  ), capabilities AS (
    SELECT
      skill.skill_key AS capability_id,
      'skill'::text AS capability_kind,
      skill.title,
      skill.description,
      NULL::bigint AS quantity,
      actor.actor_name,
      actor.scene_location,
      actor.scene_weather,
      actor.world_style,
      actor.world_language,
      skill.metadata::text AS capability_metadata
    FROM authorized_actor AS actor
    JOIN character_skills AS owned
      ON owned.workspace_id = $1
     AND owned.world_id = $2
     AND owned.worldline_id = $3
     AND owned.record_id = $4
     AND owned.character_instance_id = $6
     AND (owned.acquired_tick, owned.acquired_ordinal)
       <= (actor.last_world_tick, actor.last_world_ordinal)
    JOIN skill_definitions AS skill
      ON skill.workspace_id = owned.workspace_id
     AND skill.world_id = owned.world_id
     AND skill.id = owned.skill_definition_id

    UNION ALL

    SELECT
      asset.asset_key,
      'asset'::text,
      asset.title,
      asset.description,
      owned.quantity,
      actor.actor_name,
      actor.scene_location,
      actor.scene_weather,
      actor.world_style,
      actor.world_language,
      NULL::text
    FROM authorized_actor AS actor
    JOIN character_assets AS owned
      ON owned.workspace_id = $1
     AND owned.world_id = $2
     AND owned.worldline_id = $3
     AND owned.record_id = $4
     AND owned.character_instance_id = $6
     AND owned.quantity > 0
    JOIN asset_definitions AS asset
      ON asset.workspace_id = owned.workspace_id
     AND asset.world_id = owned.world_id
     AND asset.id = owned.asset_definition_id

    UNION ALL

    SELECT
      effect.effect_key,
      'stance'::text,
      effect.title,
      effect.description,
      NULL::bigint,
      actor.actor_name,
      actor.scene_location,
      actor.scene_weather,
      actor.world_style,
      actor.world_language,
      NULL::text
    FROM authorized_actor AS actor
    JOIN effect_definitions AS effect
      ON effect.workspace_id = $1
     AND effect.world_id = $2
     AND effect.effect_kind = 'stance'
    WHERE NOT EXISTS (
      SELECT 1 FROM character_effects AS active
      WHERE active.workspace_id = $1
        AND active.world_id = $2
        AND active.worldline_id = $3
        AND active.record_id = $4
        AND active.character_instance_id = $6
        AND active.effect_definition_id = effect.id
        AND active.status = 'active'
    )

    UNION ALL

    SELECT
      'observe_surroundings',
      'scene'::text,
      '观察四周',
      '',
      NULL::bigint,
      actor.actor_name,
      actor.scene_location,
      actor.scene_weather,
      actor.world_style,
      actor.world_language,
      NULL::text
    FROM authorized_actor AS actor
  )
  SELECT capability_id, capability_kind, title, description, quantity, actor_name,
    scene_location, scene_weather, world_style, world_language,
    capability_metadata
  FROM capabilities
  ORDER BY CASE capability_kind
    WHEN 'skill' THEN 1 WHEN 'asset' THEN 2 WHEN 'stance' THEN 3 ELSE 4 END,
    capability_id
`;
