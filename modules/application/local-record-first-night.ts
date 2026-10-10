/**
 * 初夜 application coordinator（Phase 2G-C）：从 local-record-read-model.ts
 * 抽出的初夜读取/懒调度边界。本模块独占以下既有行为，read-model 只保留
 * 依赖装配与调用接线：
 *   - 未装配 source → null；source.load 返回 null（旧世界无状态行）→ null；
 *   - ready/degraded 保留 hookContent；pending 保留 marker 内容并触发一次
 *     fire-and-forget 懒调度（不等待、不抛错、同一 load 调用只调度一次）；
 *   - openingSuggestions 逐项 trim 后过滤空字符串，顺序不变；
 *   - load 或 schedule 抛错均 fail-closed warn-only，不影响 envelope 主路径；
 *   - warn 只写静态文本，绝不携带原始错误、连接串、token 或 secret。
 *
 * 结构边界硬约束：只依赖窄的 marker source 接口；不 import
 * local-record-service facade、database/postgres、routes、
 * first-night-runtime，也不复制初夜 runner/scheduler/SQL 装配。
 * coordinator 本身无跨请求状态——不新增 single-flight 或持久状态。
 */

/** 初夜状态行（marker source 的原始读取结果）。 */
export interface FirstNightMarker {
  state: "pending" | "ready" | "degraded";
  hookContent: string;
  suggestions: readonly string[];
}

/**
 * 初夜 marker 窄数据源：load 返回 null 表示旧世界无状态行；schedule 为
 * fire-and-forget 懒重试调度（缺省不调度）。与 read-model/service 的
 * firstNight 依赖 shape 结构兼容（薄 compatibility adapter）。
 */
export interface FirstNightMarkerSource {
  load(recordId: string): Promise<FirstNightMarker | null>;
  schedule?: (recordId: string) => void;
}

/** envelope 透出的初夜状态（suggestions 已归一化为 openingSuggestions）。 */
export interface FirstNightEnvelopeState {
  state: "pending" | "ready" | "degraded";
  hookContent: string;
  openingSuggestions: string[];
}

export interface FirstNightCoordinator {
  load(recordId: string): Promise<FirstNightEnvelopeState | null>;
}

/**
 * 确定性 factory：无模块级状态，同一 source 每次调用语义一致。source 缺省
 * 时 load 恒返回 null（内存 fixture 零变化）。
 */
export function createFirstNightCoordinator(
  source?: FirstNightMarkerSource | null,
): FirstNightCoordinator {
  return {
    async load(recordId) {
      if (!source) return null;
      let marker: FirstNightMarker | null;
      try {
        marker = await source.load(recordId);
      } catch {
        // fail-closed warn-only：静态文本，不携带原始错误（可能含连接串）。
        console.warn("[realm] first night marker read failed: fail-closed to null");
        return null;
      }
      if (!marker) return null;
      if (marker.state === "pending" && source.schedule) {
        // 懒调度 fire-and-forget：不等待、不抛错；失败只告警，pending 内容
        // 仍照常返回（schedule 失败不影响 envelope 主路径）。
        try {
          source.schedule(recordId);
        } catch {
          console.warn("[realm] first night schedule failed: skipped lazy retry");
        }
      }
      return {
        state: marker.state,
        hookContent: marker.hookContent,
        openingSuggestions: marker.suggestions
          .map((item) => item.trim())
          .filter((item) => item.length > 0),
      };
    },
  };
}
