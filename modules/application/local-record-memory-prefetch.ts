/**
 * Local Record 回合 memory prefetch 生命周期协调器（Phase 2F-B）：从
 * local-record-service.ts 拆出的“回合预取编排边界”——玩家回合仅非
 * replay 时 begin、提交/失败/异常 finally 一律 end、成功后按既有角色顺序
 * 同步 consume 进 presence 载荷；插话回合开始即 begin（与租约获取/快照
 * 加载/模型调用重叠）、按现有角色/record 语义消费、退出清理不泄漏。
 * 行为保持——所有语义与拆分前逐行一致；底层 MemoryPrefetchHub
 * （modules/memory/pipeline.ts）是既有公开契约，本模块不复制其实现，
 * 只做 begin/consume/end 的编排调用。
 *
 * 依赖方向硬边界：本模块只依赖 memory/pipeline 的公开类型契约与
 * runtime scope 窄类型，绝不 import local-record-service.ts（反向依赖由
 * facade 以 import/调用维持公开 API 与依赖类型路径不变）。
 */
import { type RecordRuntimeScope } from "../../database/postgres/public.ts";
import {
  type MemoryPrefetchHandle,
  type MemoryPrefetchHub,
} from "../memory/pipeline.ts";

export interface LocalMemoryPrefetchCoordinatorDependencies {
  /**
   * 批次 T2 prefetch hub；缺省不启用（所有编排结构性 no-op，与拆分前
   * `dependencies.memoryPrefetch` 未装配时的行为逐行一致）。
   */
  memoryPrefetch?: MemoryPrefetchHub;
}

export interface LocalMemoryPrefetchTurnInput {
  recordId: string;
  /** 真实 runtime scope：workspace/world/worldline 与在场角色名单同源。 */
  runtimeScope: RecordRuntimeScope;
  playerText: string;
  /** replay 回合没有模型调用，不预取（结构性 no-op）。 */
  replay?: boolean;
}

export interface LocalMemoryPrefetchCoordinator {
  /**
   * 回合开始：非 replay 且已装配 hub 时，以真实 runtime scope、playerText、
   * 在场角色并行发起召回；replay/未装配返回 null（不预取）。
   */
  beginTurn(input: LocalMemoryPrefetchTurnInput): MemoryPrefetchHandle | null;
  /**
   * 请求体组装时按既有角色顺序同步消费已就绪结果；pending/failed/无会话
   * fail-closed 返回 ""（不等待、不抛错）；无会话返回空 Map。
   */
  consumeTurn(input: {
    recordId: string;
    handle: MemoryPrefetchHandle | null;
    characters: readonly { characterInstanceId: string }[];
  }): Map<string, string>;
  /** 回合退出清理：提交/失败/异常一律调用；无会话为 no-op。 */
  endTurn(handle: MemoryPrefetchHandle | null): void;
}

export function createLocalMemoryPrefetchCoordinator(
  dependencies: LocalMemoryPrefetchCoordinatorDependencies,
): LocalMemoryPrefetchCoordinator {
  const hub = dependencies.memoryPrefetch ?? null;
  return {
    beginTurn(input) {
      if (!hub || input.replay) return null;
      return hub.begin({
        recordId: input.recordId,
        workspaceId: input.runtimeScope.workspaceId,
        worldId: input.runtimeScope.worldId,
        worldlineId: input.runtimeScope.worldlineId,
        playerText: input.playerText,
        characters: input.runtimeScope.aiCharacters,
      });
    },
    consumeTurn(input) {
      const prefetched = new Map<string, string>();
      if (!hub || !input.handle) return prefetched;
      for (const character of input.characters) {
        prefetched.set(
          character.characterInstanceId,
          hub.consume(input.recordId, character.characterInstanceId),
        );
      }
      return prefetched;
    },
    endTurn(handle) {
      if (handle) hub?.end(handle);
    },
  };
}
