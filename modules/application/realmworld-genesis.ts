import {
  normalizeGenesisLanguage,
  type WorldGenesisDraft,
} from "./world-genesis-contract.ts";
import { normalizeWorldStyle } from "../style/world-style.ts";
import type { RealmWorldRuntimeInstantiationPlan } from "../world-transfer/realmworld-runtime-content.ts";

/** Converts declarative RealmWorld content into the existing transactional genesis contract. */
export function realmWorldPlanToGenesisDraft(
  plan: RealmWorldRuntimeInstantiationPlan,
  runtimeIdentity: { worldlineId: string; storyId: string; recordId: string },
): WorldGenesisDraft {
  const language = normalizeGenesisLanguage(plan.world.settings.language);
  const style = normalizeWorldStyle(plan.world.settings.style);
  return {
    worldIdentity: plan.binding,
    runtimeIdentity,
    ...(language ? { language } : {}),
    // 声明式 Goal 沿 genesis 事务物化（仅 goalKey/policyVersion 进入
    // 草稿；定义/rubric 留在 RealmWorld 内容层）。无 Goals 时不携带该
    // 键，旧路径形态不变。
    ...(plan.goals.length > 0
      ? {
        goals: plan.goals.map((goal) => ({
          goalKey: goal.goalKey,
          policyVersion: goal.policyVersion,
        })),
      }
      : {}),
    world: {
      name: plan.world.name,
      era: plan.world.era,
      summary: plan.world.summary,
    },
    style,
    story: plan.story,
    record: plan.record,
    playerRole: plan.playerRole,
    playerStance: plan.playerStance,
    opening: "",
    companions: plan.characters.map((character) => ({
      name: character.displayName,
      role: character.role,
      summary: character.summary,
    })),
    scene: {
      title: plan.scene.title,
      location: plan.scene.location,
      weather: plan.scene.weather,
      tension: plan.scene.tension,
      displayTime: plan.scene.displayTime,
      objective: plan.scene.objective,
    },
  };
}
