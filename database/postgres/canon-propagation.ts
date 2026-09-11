import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import {
  CanonError,
  type CanonPropagationPort,
} from "../../modules/worldline/canon.ts";
import {
  PROPAGATION_ALGORITHM_VERSION,
  type InformationPacket,
} from "../../modules/propagation/public.ts";
import { createPostgresPropagationTopologyProvider } from "./propagation-topology.ts";
import { gateWorldWrite } from "./world-write-gate.ts";

/**
 * 批次 T11-B/T11-G：Canon merge → propagation 的原子入队。
 * 在 mergeProposal 的同一事务 client 内执行：拓扑快照加载校验（fail-closed
 * 即回滚整个 merge）→ T11-G 资格闸门（non-public 受众校验 + secret 渠道
 * 约束 + private_letter recipient 唯一映射）→ 确定性身份 → Campaign +
 * root Packet + pending job（Job input 冻结 securityClass/canonRevisionId/
 * audienceDigest，Worker 不查活 audience）。
 */
export function createPostgresCanonPropagation(): CanonPropagationPort {
  const topologyProvider = createPostgresPropagationTopologyProvider();
  return {
    async planAndEnqueue(client, scope, input) {
      const pgClient = client as PoolClient;
      // v37 §D.0：C 面——gateWorldWrite（worlds KEY SHARE + active，宿主
      // 事务内锁内重读）；archived 拒绝即整个 merge 回滚。
      await gateWorldWrite(pgClient, {
        workspaceId: scope.workspaceId,
        worldId: scope.worldId,
      });
      const topology = await topologyProvider.loadSnapshot(pgClient, scope);
      const securityClass = input.securityClass;
      if (
        securityClass !== "public"
        && !input.audienceContinuityIds.every(
          (id) => typeof id === "string" && id.trim() !== "",
        )
      ) {
        throw securityUnavailable("Non-public propagation audience must be a non-empty string array.");
      }
      const audienceContinuityIds = [...new Set(input.audienceContinuityIds
        .filter((id): id is string => typeof id === "string")
        .map((id) => id.trim()))]
        .sort();

      // T11-G 资格闸门（同事务；任何失败 → 整个 merge 回滚）。
      let audienceDigest: string | null = null;
      if (securityClass !== "public") {
        if (audienceContinuityIds.length === 0) {
          throw securityUnavailable("Non-public propagation requires a non-empty audience.");
        }
        // 受众必须全部属于当前 worldline 且 active。
        const continuities = await pgClient.query(
          `SELECT id FROM character_continuities
           WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
             AND id = ANY($4::text[]) AND status = 'active'`,
          [scope.workspaceId, scope.worldId, scope.worldlineId, audienceContinuityIds],
        );
        if (continuities.rows.length !== audienceContinuityIds.length) {
          throw securityUnavailable(
            "Audience continuity is unknown, inactive or outside the current worldline.",
          );
        }
        // secret 第一阶段只允许 private_letter；其他渠道是永久资格错误。
        if (securityClass === "secret") {
          for (const route of topology.routes) {
            if (route.channel !== "private_letter") {
              throw securityUnavailable(
                "Secret propagation only allows private_letter routes in the first phase.",
              );
            }
            // recipient 节点必须恰好映射一个 continuity（零/多都拒绝）。
            const mappings = await pgClient.query(
              `SELECT continuity_id FROM propagation_node_audiences
               WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
                 AND node_key = $4`,
              [scope.workspaceId, scope.worldId, scope.worldlineId, route.recipient ?? ""],
            );
            if (mappings.rows.length !== 1) {
              throw securityUnavailable(
                "private_letter recipient node must map to exactly one continuity.",
              );
            }
            if (!audienceContinuityIds.includes(mappings.rows[0].continuity_id as string)) {
              throw securityUnavailable(
                "private_letter recipient continuity must belong to the revision audience.",
              );
            }
          }
        }
        // immutable audience snapshot（与 Revision 同事务）。
        for (const continuityId of audienceContinuityIds) {
          await pgClient.query(
            `INSERT INTO canon_revision_audiences (
               workspace_id, world_id, worldline_id, revision_id, continuity_id
             ) VALUES ($1, $2, $3, $4, $5)`,
            [
              scope.workspaceId,
              scope.worldId,
              scope.worldlineId,
              input.revision.id,
              continuityId,
            ],
          );
        }
        audienceDigest = createHash("sha256")
          .update([...audienceContinuityIds].sort().join(","))
          .digest("hex")
          .slice(0, 24);
      }

      const campaignId = `campaign_canon_${input.revision.id}`;
      const jobId = `job_${campaignId}`;
      const rootPacketId = `packet_${campaignId}_root`;
      const claimIds = input.promotedClaims.map((claim) => claim.id);
      const rootPacket: InformationPacket = {
        id: rootPacketId,
        campaignId,
        parentPacketId: null,
        // secret 第一阶段全链只允许 private_letter；root 也不能带
        // official_bulletin 语义，避免“route 全私密但根包仍公开”的裂缝。
        channel: securityClass === "secret" ? "private_letter" : "official_bulletin",
        claimIds,
        framing: "neutral",
        omittedClaimIds: [],
        semanticFidelityToParent: 1,
        // 与引擎 packetHash 同构：sha256(id:claimIds:omitted:framing)。
        contentHash: createHash("sha256")
          .update([rootPacketId, claimIds.join(","), "", "neutral"].join(":"))
          .digest("hex"),
      };

      await pgClient.query(
        `INSERT INTO information_campaigns (
           workspace_id, world_id, worldline_id, id, root_claim_ids,
           effective_tick, salience, complexity, security_class,
           algorithm_version, canon_revision_id
         ) VALUES ($1, $2, $3, $4, $5::text[], $6, $7, $8, $9, $10, $11)`,
        [
          scope.workspaceId,
          scope.worldId,
          scope.worldlineId,
          campaignId,
          claimIds,
          input.revision.effectiveTick,
          0.5,
          0.5,
          securityClass,
          PROPAGATION_ALGORITHM_VERSION,
          input.revision.id,
        ],
      );
      await pgClient.query(
        `INSERT INTO information_packets (
           workspace_id, world_id, worldline_id, id, campaign_id,
           parent_packet_id, channel, claim_ids, framing,
           omitted_claim_ids, semantic_fidelity_to_parent, content_hash
         ) VALUES ($1, $2, $3, $4, $5, NULL, $6, $7::text[], $8, '{}'::text[], $9, $10)`,
        [
          scope.workspaceId,
          scope.worldId,
          scope.worldlineId,
          rootPacket.id,
          campaignId,
          rootPacket.channel,
          [...rootPacket.claimIds],
          rootPacket.framing,
          rootPacket.semanticFidelityToParent,
          rootPacket.contentHash,
        ],
      );
      // immutable job input：拓扑快照 + 安全等级 + revision/audience digest
      // 一并冻结（Worker 运行时不查活 audience）。
      const jobInput = {
        campaign: {
          id: campaignId,
          securityClass,
          effectiveTick: input.revision.effectiveTick,
          salience: 0.5,
          complexity: 0.5,
        },
        roots: [
          { nodeKey: topology.canonOriginNodeKey, packet: rootPacket },
        ],
        nodes: topology.nodes,
        routes: topology.routes,
        topologyVersion: topology.version,
        canonRevisionId: input.revision.id,
        audienceContinuityIds: securityClass === "public" ? [] : audienceContinuityIds,
        audienceDigest,
      };
      await pgClient.query(
        `INSERT INTO propagation_jobs (
           workspace_id, world_id, worldline_id, id, campaign_id, input
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [
          scope.workspaceId,
          scope.worldId,
          scope.worldlineId,
          jobId,
          campaignId,
          JSON.stringify(jobInput),
        ],
      );
    },
  };
}

function securityUnavailable(message: string): CanonError {
  return new CanonError("PROPAGATION_SECURITY_UNAVAILABLE", message);
}
