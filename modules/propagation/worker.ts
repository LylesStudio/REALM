/**
 * M5 batch 2: offline propagation worker with lazy population
 * materialization.
 *
 * Campaigns queue as jobs; a worker claims them one at a time, runs the
 * deterministic engine and persists exposures. Stale `running` jobs
 * （started_at 超 5 分钟）return to `pending` on recovery, so a restarted
 * process resumes cleanly.
 *
 * 批次 T11-B 修正（docs/development/T11-B-PROPAGATION-ENABLEMENT-IMPLEMENTATION.md §五）：
 * - claimNext 只按 workspace 入参，领取时返回 job 自带的真实
 *   world/worldline 作用域——不允许 workspace-only 领取串世界；
 * - 拓扑来自 job 的 immutable input 快照（nodes/routes/topologyVersion），
 *   Worker 不在运行中读取活拓扑；
 * - completeRun 把 Campaign/Packets/Exposures 幂等写入与 job 标记 done
 *   合入同一事务——结果写完未标 done 的崩溃窗口在结构上消失。
 * v37 §D.0 lease 贯穿契约：lease = { jobId, attempts } 双分量。claimNext
 * 每次领取铸新 token（attempts+1）；completeRun/markFailed 对 lease 做
 * FOR UPDATE 双分量断言——stale token 一律失效（success 不写内容、
 * failure stale_ignored）；retry 置 pending 后旧 token 全失效。
 * Determinism is unchanged (realm-propagate-v1).
 */

import { createHash } from "node:crypto";
import type { WorldScope } from "../world-knowledge/public.ts";
import {
  propagate,
  type ChannelRoute,
  type InformationCampaign,
  type InformationPacket,
  type PropagationExposure,
  type SocialNode,
} from "./public.ts";

export type PropagationJobStatus = "pending" | "running" | "done" | "failed";

export type PropagationJobInput = {
  campaign: InformationCampaign;
  roots: readonly { nodeKey: string; packet: InformationPacket }[];
  /** 批次 T11-B：入队时物化的 immutable 拓扑快照。 */
  nodes: readonly SocialNode[];
  routes: readonly ChannelRoute[];
  topologyVersion: string;
  /** 批次 T11-G：冻结来源 Revision、受众集合与 digest，Worker 不查活 audience。 */
  canonRevisionId?: string;
  audienceContinuityIds?: readonly string[];
  audienceDigest?: string | null;
};

export type PropagationJob = {
  id: string;
  campaignId: string;
  input: PropagationJobInput;
  status: PropagationJobStatus;
  attempts: number;
  lastError: string | null;
};

/** v37 §D.0：lease 双分量——claimNext 铸造，completeRun/markFailed 校验。 */
export type PropagationLease = {
  jobId: string;
  attempts: number;
};

/** completeRun 的 lease 与 job 行不符（status/attempts 漂移）——不写内容。 */
export class PropagationStaleLeaseError extends Error {
  readonly code = "STALE_LEASE" as const;
  constructor(jobId: string) {
    super(`propagation job lease is stale: ${jobId}`);
    this.name = "PropagationStaleLeaseError";
  }
}

/** completeRun 的内容面 gate：世界已归档（archived 拒绝；worker 随后
 *  markFailed 收尾，幂等）。 */
export class PropagationWorldArchivedError extends Error {
  readonly code = "WORLD_ARCHIVED" as const;
  constructor(worldId: string) {
    super(`propagation job world is archived: ${worldId}`);
    this.name = "PropagationWorldArchivedError";
  }
}

/** 批次 T11-B：领取结果携带 job 的真实世界作用域。 */
export type ClaimedPropagationJob = {
  scope: WorldScope;
  job: PropagationJob;
  /** v37 §D.0：本次领取铸造的 lease token（attempts 快照）。 */
  lease: PropagationLease;
};

export type PropagationRunResult = {
  campaign: InformationCampaign;
  packets: readonly InformationPacket[];
  exposures: readonly PropagationExposure[];
  algorithmVersion: string;
};

export interface PropagationJobQueue {
  enqueue(
    scope: WorldScope,
    job: { id: string; campaignId: string; input: PropagationJobInput },
  ): Promise<void>;
  /** Atomically claims the oldest pending job (pending → running). */
  claimNext(workspaceId: string): Promise<ClaimedPropagationJob | null>;
  /**
   * 结果写入与 done 标记同一事务（幂等可重放）。v37：lease 双分量
   * FOR UPDATE 断言——stale → PropagationStaleLeaseError（不写内容）；
   * 世界 archived → PropagationWorldArchivedError（不写内容）。
   */
  completeRun(
    scope: WorldScope,
    lease: PropagationLease,
    run: PropagationRunResult,
  ): Promise<void>;
  /**
   * v37：lease 双分量断言；stale lease → { staleIgnored: true }（job 行
   * 不动——新 attempt 不受影响）；archived 允许收尾（幂等）。
   */
  markFailed(
    scope: WorldScope,
    lease: PropagationLease,
    error: string,
  ): Promise<{ staleIgnored: boolean }>;
  /** running → pending（仅 started_at 超 5 分钟的 stale job）；返回恢复数量。 */
  recoverStale(workspaceId: string): Promise<number>;
  /** failed → pending（状态条件 UPDATE；非 failed 0 行 no-op）。 */
  retry(scope: WorldScope, jobId: string): Promise<void>;
  stats(workspaceId: string): Promise<Record<PropagationJobStatus, number>>;
}

export function createPropagationWorker(options: {
  queue: PropagationJobQueue;
  /** 批次 T11-B：markFailed 后的分类回调（如临时错误自动重排）。 */
  onFailed?: (
    scope: WorldScope,
    job: PropagationJob,
    error: unknown,
  ) => Promise<void>;
}): {
  runOnce(workspaceId: string): Promise<"done" | "failed" | "idle">;
  recoverStale(workspaceId: string): Promise<number>;
  retry(scope: WorldScope, jobId: string): Promise<void>;
  stats(workspaceId: string): Promise<Record<PropagationJobStatus, number>>;
} {
  return {
    async runOnce(workspaceId) {
      const claimed = await options.queue.claimNext(workspaceId);
      if (!claimed) return "idle";
      const { scope, job } = claimed;
      try {
        // 批次 T11-G：non-public Campaign 必须带冻结的 audience digest——
        // 缺失即永久资格失败（不重试、不查活 audience、不扩大受众）。
        if (job.input.campaign.securityClass !== "public") {
          const audienceContinuityIds = job.input.audienceContinuityIds;
          if (
            !job.input.canonRevisionId
            || !Array.isArray(audienceContinuityIds)
            || audienceContinuityIds.length === 0
            || !job.input.audienceDigest
          ) {
            throw new Error(
              "non-public campaign job is missing its frozen revision audience contract",
            );
          }
          const normalizedAudience = [...audienceContinuityIds].sort();
          const hasDuplicate = new Set(normalizedAudience).size !== normalizedAudience.length;
          if (
            hasDuplicate
            || !normalizedAudience.every((id) => typeof id === "string" && id.trim() !== "")
            || computeAudienceDigest(normalizedAudience) !== job.input.audienceDigest
          ) {
            throw new Error(
              "non-public campaign job has an invalid frozen audience digest",
            );
          }
        }
        if (
          job.input.campaign.securityClass === "secret"
          && (
            job.input.roots.some((root) => root.packet.channel !== "private_letter")
            || job.input.routes.some((route) => route.channel !== "private_letter")
          )
        ) {
          throw new Error(
            "secret campaign job contains a non-private-letter channel",
          );
        }
        // 可达性遍历（只看路由，不物化节点）。
        const reachable = new Set<string>();
        const frontier = [...job.input.roots.map((root) => root.nodeKey)];
        while (frontier.length > 0) {
          const key = frontier.shift()!;
          if (reachable.has(key)) continue;
          reachable.add(key);
          for (const route of job.input.routes) {
            if (route.from === key && !reachable.has(route.to)) {
              frontier.push(route.to);
            }
          }
        }
        // 懒物化：只为可达键从 immutable 快照取 SocialNode。
        const snapshotNodes = new Map(
          job.input.nodes.map((node) => [node.key, node]),
        );
        const nodes: SocialNode[] = [];
        for (const key of reachable) {
          const node = snapshotNodes.get(key);
          if (node) nodes.push(node);
        }
        // 派生 packet id 以 Campaign 命名空间隔离（多 Campaign 不撞库），
        // 同一 Campaign 重放仍逐字节一致（realm-propagate-v1 不变）。
        let autoId = 0;
        const result = propagate({
          campaign: job.input.campaign,
          roots: job.input.roots,
          nodes,
          routes: job.input.routes,
          idFactory: () => `${job.input.campaign.id}_${++autoId}`,
        });
        await options.queue.completeRun(scope, claimed.lease, {
          campaign: job.input.campaign,
          packets: result.packets,
          exposures: result.exposures,
          algorithmVersion: result.algorithmVersion,
        });
        return "done";
      } catch (error) {
        await options.queue.markFailed(
          scope,
          claimed.lease,
          error instanceof Error ? error.message : String(error),
        );
        await options.onFailed?.(scope, job, error);
        return "failed";
      }
    },
    recoverStale: (workspaceId) => options.queue.recoverStale(workspaceId),
    retry: (scope, jobId) => options.queue.retry(scope, jobId),
    stats: (workspaceId) => options.queue.stats(workspaceId),
  };
}

function computeAudienceDigest(audienceContinuityIds: readonly string[]): string {
  return createHash("sha256")
    .update([...audienceContinuityIds].sort().join(","))
    .digest("hex")
    .slice(0, 24);
}
