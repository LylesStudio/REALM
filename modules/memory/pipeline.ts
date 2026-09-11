/**
 * 批次 T2 记忆管线调度（参照 Hermes memory_manager 的后台单写者形态）。
 *
 * sync_turn：回合提交完成后 fire-and-forget 触发 observations→conclusions
 * 萃取；单飞守卫按 (workspaceId, recordId) 去重，萃取失败只留日志，
 * 绝不阻塞或回灌回合响应。
 */

export type MemorySyncScope = {
  workspaceId: string;
  worldId: string;
  worldlineId: string;
  recordId: string;
};

export interface MemorySyncScheduler {
  /** fire-and-forget：同一 record 的在途萃取未结束时只挂 pending（re-arm）。 */
  schedule(scope: MemorySyncScope): void;
  /** 等待所有在途与 pending 的萃取结束；仅测试断言使用。 */
  idle(): Promise<void>;
}

export function createMemorySyncScheduler(options: {
  extract(scope: MemorySyncScope): Promise<{ materialized: number }>;
}): MemorySyncScheduler {
  const inFlight = new Set<string>();
  const pending = new Map<string, MemorySyncScope>();
  let idleWaiters: Array<() => void> = [];

  function scopeKey(scope: MemorySyncScope): string {
    return `${scope.workspaceId}:${scope.recordId}`;
  }

  function settleIfIdle(): void {
    if (inFlight.size > 0 || pending.size > 0) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const waiter of waiters) waiter();
  }

  function run(scope: MemorySyncScope): void {
    const key = scopeKey(scope);
    if (inFlight.has(key)) {
      // 单飞重入：不并发重复跑，只挂脏标记，等当前萃取结束后补跑一次。
      pending.set(key, scope);
      return;
    }
    inFlight.add(key);
    options
      .extract(scope)
      .then((result) => {
        if (result.materialized > 0) {
          console.log(
            `[realm] memory sync_turn materialized ${result.materialized} conclusions for record ${scope.recordId}`,
          );
        }
      })
      .catch((error) => {
        // 萃取失败只留日志：回合已经提交，缺失的结论由后续回合萃取补齐。
        console.warn(
          `[realm] memory sync_turn failed for record ${scope.recordId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      })
      .finally(() => {
        inFlight.delete(key);
        const next = pending.get(key);
        pending.delete(key);
        if (next) {
          run(next);
        }
        settleIfIdle();
      });
  }

  return {
    schedule(scope) {
      run(scope);
    },
    idle() {
      if (inFlight.size === 0 && pending.size === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
      });
    },
  };
}

/**
 * 批次 T2 第二步·并行预取（参照 Hermes memory_provider.prefetch：真召回在后台
 * 并行跑，请求体组装只消费已就绪结果）。
 *
 * 回合开始时 begin 为每个在场 AI 角色并行发起召回；模型调用组装时 consume
 * 同步取已就绪结果——pending/failed/无会话一律 fail-closed 返回 ""，绝不
 * 等待、绝不抛错、绝不阻塞模型调用。
 */

export type MemoryPrefetchHandle = {
  recordId: string;
  sessionId: number;
};

export interface MemoryPrefetchHub {
  /**
   * 回合开始：并行发起各角色召回。同一 record 再次 begin 整体替换旧会话——
   * 旧会话的迟到结果被会话标识隔离，绝不串入新会话。
   */
  begin(input: {
    recordId: string;
    workspaceId: string;
    worldId: string;
    worldlineId: string;
    playerText: string;
    characters: readonly { characterInstanceId: string }[];
  }): MemoryPrefetchHandle;
  /** 同步消费：仅返回已就绪结果；pending/failed/无会话返回 ""。 */
  consume(recordId: string, characterInstanceId: string): string;
  /** 回合退出清理：仅当会话仍是该 record 的当前会话时移除（标识隔离）。 */
  end(handle: MemoryPrefetchHandle): void;
}

export function createMemoryPrefetchHub(options: {
  recall(input: {
    workspaceId: string;
    worldId: string;
    worldlineId: string;
    recordId: string;
    characterInstanceId: string;
    query: string;
  }): Promise<string>;
}): MemoryPrefetchHub {
  type Session = {
    id: number;
    ready: Map<string, string>;
  };
  const sessions = new Map<string, Session>();
  let nextSessionId = 1;

  return {
    begin(input) {
      const session: Session = { id: nextSessionId++, ready: new Map() };
      sessions.set(input.recordId, session);
      for (const character of input.characters) {
        options
          .recall({
            workspaceId: input.workspaceId,
            worldId: input.worldId,
            worldlineId: input.worldlineId,
            recordId: input.recordId,
            characterInstanceId: character.characterInstanceId,
            query: input.playerText,
          })
          .then((memories) => {
            // 会话标识隔离：被替换的旧会话迟到结果直接丢弃。
            if (sessions.get(input.recordId) !== session) return;
            session.ready.set(character.characterInstanceId, memories);
          })
          .catch((error) => {
            if (sessions.get(input.recordId) !== session) return;
            // fail-closed：该角色本轮无额外记忆；失败只留日志。
            console.warn(
              `[realm] memory prefetch failed for character ${character.characterInstanceId}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          });
      }
      return { recordId: input.recordId, sessionId: session.id };
    },

    consume(recordId, characterInstanceId) {
      return sessions.get(recordId)?.ready.get(characterInstanceId) ?? "";
    },

    end(handle) {
      const session = sessions.get(handle.recordId);
      if (session && session.id === handle.sessionId) {
        sessions.delete(handle.recordId);
      }
    },
  };
}
