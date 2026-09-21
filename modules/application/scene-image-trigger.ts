/**
 * 场景图自动触发器（server-only）：账号级模式（0049）+ 幂等队列（0050）。
 * - afterPlayerTurn：仅成功 committed 非 replay 玩家回合；模式 every_turn
 *   才入队；source_event_id = 回合提交幂等键（重复提交/回放不重复）。
 * - afterSceneChange：晶化 applyDelta 真正写出且 delta 含场景字段才入队；
 *   source_event_id = 晶化事件 id（稳定证据）。
 * - 读取的是触发回合所属 principal 的账号偏好，绝不影响他人；
 *   入队失败只留日志（安全分类），绝不阻塞回合/晶化路径。
 */
import type { RecordRuntimeScope } from "../../database/postgres/public.ts";
import type { SceneImageQueue } from "../../database/postgres/scene-image-queue.ts";
import type { AccountRepository } from "../../database/postgres/account-repository.ts";
import type { SceneImageMode } from "../imagine/public.ts";

/** delta 是否携带场景字段（location/weather/tension/objective/displayTime）。 */
export function deltaChangesScene(delta: {
  location?: string | null;
  weather?: string | null;
  tension?: string | null;
  objective?: string | null;
  displayTime?: string | null;
}): boolean {
  return Boolean(
    delta.location?.trim()
      || delta.weather?.trim()
      || delta.tension?.trim()
      || delta.objective?.trim()
      || delta.displayTime?.trim(),
  );
}

export function createSceneImageAutoTrigger(options: {
  queue: SceneImageQueue;
  accounts: Pick<AccountRepository, "findSceneImageMode">;
  logger?: (line: string) => void;
}) {
  const log = options.logger
    ?? ((line: string) => console.warn(`[realm] scene-image auto: ${line}`));

  async function enqueueIfMode(input: {
    runtimeScope: RecordRuntimeScope;
    sceneId?: string;
    principalId: string;
    expectedMode: SceneImageMode;
    triggerKind: "scene_change" | "every_turn";
    sourceEventId: string;
  }): Promise<void> {
    try {
      const mode = await options.accounts.findSceneImageMode(
        input.runtimeScope.workspaceId,
        input.principalId,
      );
      if (mode !== input.expectedMode) return;
      await options.queue.enqueue({
        workspaceId: input.runtimeScope.workspaceId,
        worldId: input.runtimeScope.worldId,
        recordId: input.runtimeScope.recordId,
        sceneId: input.sceneId ?? input.runtimeScope.sceneId,
        principalId: input.principalId,
        triggerKind: input.triggerKind,
        sourceEventId: input.sourceEventId,
      });
    } catch (error) {
      const code = (error as { code?: string } | null)?.code ?? "enqueue_failed";
      log(`enqueue skipped: ${code}`);
    }
  }

  return {
    /** 玩家回合成功 committed（非 replay）后调用。 */
    afterPlayerTurn(input: {
      runtimeScope: RecordRuntimeScope;
      principalId: string;
      sourceEventId: string;
    }): Promise<void> {
      return enqueueIfMode({
        ...input,
        expectedMode: "every_turn",
        triggerKind: "every_turn",
      });
    },
    /** 晶化真正写出新场景后调用（调用方必须先过 deltaChangesScene）。 */
    afterSceneChange(input: {
      runtimeScope: RecordRuntimeScope;
      sceneId?: string;
      principalId: string;
      sourceEventId: string;
    }): Promise<void> {
      return enqueueIfMode({
        ...input,
        expectedMode: "scene_change",
        triggerKind: "scene_change",
      });
    },
  };
}

export type SceneImageAutoTrigger = ReturnType<typeof createSceneImageAutoTrigger>;
