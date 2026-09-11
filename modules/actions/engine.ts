/**
 * 批次 T4：三个引擎工具的真实实现（M2 §4 落地）。
 * 批次 T5：resolve_uncertainty 换密码学安全随机源（node:crypto randomInt），
 * 伪随机查表（deterministicInteger）删除；多骰系解算（规范
 * docs/development/T5-DICE-RANDOMNESS.md）。
 *
 * 全部引擎权威——DM 与角色均不代填规则值；引擎工具只在发布事务内
 * 由已授权的 Action Receipt 驱动：
 *
 * - resolve_uncertainty：纯判定（无数据库）。掷骰只发生在裁决时刻，
 *   结果随 Receipt 一次物化落库，重放读库不重掷（规范 §2.1 三层共存）。
 * - consume_resource：账本事务内扣减 character_assets.quantity
 *   （余额守卫 + revision++）；定义权威校验。
 * - apply_effect：账本事务内 apply/remove character_effects；
 *   目标必须是行动者自身，定义必须存在于本世界。
 *
 * 失败矩阵见 docs/development/T4-RULE-REALIZATION.md §5 与
 * docs/development/T5-DICE-RANDOMNESS.md §4。
 */
import { randomInt as cryptoRandomInt } from "node:crypto";
import type { PoolClient } from "pg";
import { FatalTurnError } from "../runtime/public.ts";
import type { CostDraft, EffectDraft, MechanicDetail } from "./public.ts";
import type { CheckSpecification } from "./rule-pack.ts";

/** 随机源契约（含上下限）；生产缺省 CSPRNG，测试注入确定性序列。 */
export type RandomIntSource = (minInclusive: number, maxInclusive: number) => number;

/** 账本写入共享的记录级作用域。 */
export interface ActionLedgerScope {
  workspaceId: string;
  worldId: string;
  worldlineId: string;
  recordId: string;
  actorCharacterInstanceId: string;
}

export type UncertaintyResolution = {
  outcome: "success" | "partial" | "failure";
  mechanic: MechanicDetail;
};

/**
 * 引擎工具 resolve_uncertainty：输入 check 参数，输出 MechanicDetail 与成败。
 * 掷骰一次物化——结果随 Receipt 落库，重放读库（规范 §2.1）；
 * 引擎之外不产生副作用。非本批已实现的骰系 fail-closed RULE_DECISION_INVALID。
 */
export function resolveUncertainty(input: {
  check: CheckSpecification;
  randomInt?: RandomIntSource;
}): UncertaintyResolution {
  const randomInt = input.randomInt ?? cryptoRandomInt;
  const check = input.check;
  switch (check.system) {
    case "d20":
    case "2d6": {
      const rolls = check.system === "d20"
        ? [randomInt(1, 20)]
        : [randomInt(1, 6), randomInt(1, 6)];
      const total = rolls.reduce((sum, roll) => sum + roll, 0) + check.modifier;
      const critical = check.system === "d20"
        ? rolls[0] === 20
        : rolls[0] === 6 && rolls[1] === 6;
      const fumble = check.system === "d20"
        ? rolls[0] === 1
        : rolls[0] === 1 && rolls[1] === 1;
      const success = critical || (!fumble && total >= check.target);
      return {
        outcome: resolveCheckOutcome({
          success,
          fumble,
          total,
          target: check.target,
          partialMargin: check.partialMargin,
        }),
        mechanic: {
          system: check.system,
          rolls,
          modifier: check.modifier,
          target: check.target,
          total,
          success,
          ...(critical ? { critical: true as const } : {}),
          ...(fumble ? { fumble: true as const } : {}),
        },
      };
    }
    case "percentile": {
      const roll = randomInt(1, 100);
      const effectiveTarget = Math.min(100, Math.max(1, check.target + check.modifier));
      const critical = roll <= 5;
      const fumble = roll >= 96;
      const success = critical || (!fumble && roll <= effectiveTarget);
      return {
        outcome: resolveCheckOutcome({
          success,
          fumble,
          total: roll,
          target: effectiveTarget,
          partialMargin: check.partialMargin,
          lowerIsBetter: true,
        }),
        mechanic: {
          system: "percentile",
          rolls: [roll],
          modifier: check.modifier,
          target: check.target,
          total: roll,
          success,
          ...(critical ? { critical: true as const } : {}),
          ...(fumble ? { fumble: true as const } : {}),
        },
      };
    }
    case "pool": {
      const rolls = Array.from({ length: check.dice }, () => randomInt(1, check.sides));
      const successes = rolls.filter((roll) => roll >= check.successOn).length;
      const total = successes + check.modifier;
      const critical = successes === check.dice;
      const fumble = successes === 0;
      const success = critical || (!fumble && total >= check.target);
      return {
        outcome: resolveCheckOutcome({
          success,
          fumble,
          total,
          target: check.target,
          partialMargin: check.partialMargin,
        }),
        mechanic: {
          system: "pool",
          rolls,
          modifier: check.modifier,
          target: check.target,
          total,
          success,
          ...(critical ? { critical: true as const } : {}),
          ...(fumble ? { fumble: true as const } : {}),
        },
      };
    }
    case "draw": {
      // check.deck 为裁决时刻剩余牌堆（规则包已扣不放回历史）。
      const drawnCard = check.deck[randomInt(0, check.deck.length - 1)]!;
      const success = check.successCards.includes(drawnCard);
      return {
        outcome: success ? "success" : "failure",
        mechanic: {
          system: "draw",
          rolls: [],
          modifier: 0,
          target: 0,
          total: 0,
          success,
          skillKey: check.skillKey,
          drawnCard,
          deckRemaining: check.deck.length - 1,
        },
      };
    }
    default:
      throw new FatalTurnError(
        "RULE_DECISION_INVALID",
        "A check decision requires a supported internal mechanic.",
      );
  }
}

function resolveCheckOutcome(input: {
  success: boolean;
  fumble: boolean;
  total: number;
  target: number;
  partialMargin?: number;
  lowerIsBetter?: boolean;
}): "success" | "partial" | "failure" {
  if (input.success) return "success";
  if (input.fumble || input.partialMargin === undefined) return "failure";
  const partial = input.lowerIsBetter
    ? input.total <= input.target + input.partialMargin
    : input.total >= input.target - input.partialMargin;
  return partial ? "partial" : "failure";
}

/**
 * 引擎工具 consume_resource：character_assets.quantity 原子扣减。
 * 仅支持 asset: 资源种；扣减目标定义必须存在且 consumable；
 * 余额不足拒绝（RESOURCE_UNAVAILABLE）。
 */
export async function consumeResource(
  client: PoolClient,
  scope: ActionLedgerScope,
  cost: CostDraft,
  now: string,
): Promise<void> {
  if (!cost.resourceId.startsWith("asset:")) {
    throw new FatalTurnError(
      "RESOURCE_KIND_NOT_AVAILABLE",
      "The active Action State Ledger does not support this resource kind.",
    );
  }
  const assetDefinitionId = cost.resourceId.slice("asset:".length);
  const definition = await client.query<{ consumable: boolean }>(
    `SELECT consumable
     FROM asset_definitions
     WHERE workspace_id = $1 AND world_id = $2 AND id = $3`,
    [scope.workspaceId, scope.worldId, assetDefinitionId],
  );
  if (definition.rowCount !== 1 || definition.rows[0]!.consumable !== true) {
    throw new FatalTurnError(
      "RESOURCE_DEFINITION_UNKNOWN",
      "The consumed resource has no consumable definition in this world.",
    );
  }
  const result = await client.query(
    `UPDATE character_assets
     SET quantity = quantity - $7,
         revision = revision + 1,
         updated_at = $8::timestamptz
     WHERE workspace_id = $1
       AND world_id = $2
       AND worldline_id = $3
       AND record_id = $4
       AND character_instance_id = $5
       AND asset_definition_id = $6
       AND quantity >= $7`,
    [
      scope.workspaceId,
      scope.worldId,
      scope.worldlineId,
      scope.recordId,
      scope.actorCharacterInstanceId,
      assetDefinitionId,
      cost.amount,
      now,
    ],
  );
  if (result.rowCount !== 1) {
    throw new FatalTurnError(
      "RESOURCE_UNAVAILABLE",
      "The selected asset no longer has enough available quantity.",
    );
  }
}

/**
 * 引擎工具 apply_effect：character_effects apply/remove。
 * apply 受「同一效果至多一行 active」唯一约束保护（重复 → EFFECT_ALREADY_ACTIVE）；
 * remove 无 active 行 → EFFECT_NOT_ACTIVE；定义不在本世界 → EFFECT_DEFINITION_UNKNOWN。
 */
export async function applyEffect(
  client: PoolClient,
  scope: ActionLedgerScope,
  effect: EffectDraft,
  references: {
    receiptId: string;
    transactionId: string;
    tick: number;
    ordinal: number;
  },
  now: string,
): Promise<void> {
  if (effect.targetId !== scope.actorCharacterInstanceId) {
    throw new FatalTurnError(
      "EFFECT_TARGET_NOT_AUTHORIZED",
      "This Actor Tool may only change the acting CharacterInstance stance.",
    );
  }
  const definition = await client.query(
    `SELECT 1
     FROM effect_definitions
     WHERE workspace_id = $1 AND world_id = $2 AND id = $3`,
    [scope.workspaceId, scope.worldId, effect.effectId],
  );
  if (definition.rowCount !== 1) {
    throw new FatalTurnError(
      "EFFECT_DEFINITION_UNKNOWN",
      "The applied effect has no definition in this world.",
    );
  }
  if (effect.operation === "apply") {
    const result = await client.query(
      `INSERT INTO character_effects (
         workspace_id, world_id, worldline_id, record_id,
         character_instance_id, effect_definition_id,
         source_action_receipt_id, id, status,
         applied_tick, applied_ordinal, revision, metadata,
         created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, 'active',
         $9, $10, 0, '{}'::jsonb, $11::timestamptz, $11::timestamptz
       )
       ON CONFLICT DO NOTHING`,
      [
        scope.workspaceId,
        scope.worldId,
        scope.worldlineId,
        scope.recordId,
        effect.targetId,
        effect.effectId,
        references.receiptId,
        `${references.transactionId}:${effect.effectId}`,
        references.tick,
        references.ordinal,
        now,
      ],
    );
    if (result.rowCount !== 1) {
      throw new FatalTurnError(
        "EFFECT_ALREADY_ACTIVE",
        "The selected stance or effect is already active.",
      );
    }
    return;
  }
  const result = await client.query(
    `UPDATE character_effects
     SET status = 'removed', ended_tick = $7, ended_ordinal = $8,
         revision = revision + 1, updated_at = $9::timestamptz
     WHERE workspace_id = $1
       AND world_id = $2
       AND worldline_id = $3
       AND record_id = $4
       AND character_instance_id = $5
       AND effect_definition_id = $6
       AND status = 'active'`,
    [
      scope.workspaceId,
      scope.worldId,
      scope.worldlineId,
      scope.recordId,
      effect.targetId,
      effect.effectId,
      references.tick,
      references.ordinal,
      now,
    ],
  );
  if (result.rowCount !== 1) {
    throw new FatalTurnError(
      "EFFECT_NOT_ACTIVE",
      "The selected effect is not active.",
    );
  }
}
