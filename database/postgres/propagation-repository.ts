import type { Pool } from "pg";
import type { WorldScope } from "../../modules/world-knowledge/public.ts";
import type {
  InformationCampaign,
  InformationPacket,
  PropagationExposure,
} from "../../modules/propagation/public.ts";
import { withWorkspaceTransaction } from "./workspace-transaction.ts";
import { gateWorldWrite } from "./world-write-gate.ts";

export interface PropagationRepository {
  saveRun(
    scope: WorldScope,
    input: {
      campaign: InformationCampaign;
      packets: readonly InformationPacket[];
      exposures: readonly PropagationExposure[];
      algorithmVersion: string;
    },
  ): Promise<void>;
  listExposures(
    scope: WorldScope,
    campaignId: string,
  ): Promise<readonly (PropagationExposure & { algorithmVersion: string })[]>;
  listPackets(
    scope: WorldScope,
    campaignId: string,
  ): Promise<readonly InformationPacket[]>;
}

export function createPostgresPropagationRepository(pool: Pool): PropagationRepository {
  return {
    async saveRun(scope, input) {
      return withWorkspaceTransaction(pool, scope.workspaceId, async (client) => {
        // v37 §D.0：C 面——gateWorldWrite（worlds KEY SHARE + active）；
        // archived 拒绝。
        await gateWorldWrite(client, {
          workspaceId: scope.workspaceId,
          worldId: scope.worldId,
        });
        await client.query(
          `INSERT INTO information_campaigns (
             workspace_id, world_id, worldline_id, id, root_claim_ids,
             effective_tick, salience, complexity, security_class,
             algorithm_version
           ) VALUES ($1, $2, $3, $4, ARRAY[]::text[], $5, $6, $7, $8, $9)
           ON CONFLICT (workspace_id, id) DO NOTHING`,
          [
            scope.workspaceId,
            scope.worldId,
            scope.worldlineId,
            input.campaign.id,
            input.campaign.effectiveTick,
            input.campaign.salience,
            input.campaign.complexity,
            input.campaign.securityClass,
            input.algorithmVersion,
          ],
        );
        for (const packet of input.packets) {
          await client.query(
            `INSERT INTO information_packets (
               workspace_id, world_id, worldline_id, id, campaign_id,
               parent_packet_id, channel, claim_ids, framing,
               omitted_claim_ids, semantic_fidelity_to_parent, content_hash
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9, $10::text[], $11, $12)
             ON CONFLICT (workspace_id, id) DO NOTHING`,
            [
              scope.workspaceId,
              scope.worldId,
              scope.worldlineId,
              packet.id,
              packet.campaignId,
              packet.parentPacketId,
              packet.channel,
              [...packet.claimIds],
              packet.framing,
              [...packet.omittedClaimIds],
              packet.semanticFidelityToParent,
              packet.contentHash,
            ],
          );
        }
        for (const exposure of input.exposures) {
          await client.query(
            `INSERT INTO propagation_exposures (
               workspace_id, world_id, worldline_id, id, campaign_id,
               packet_id, node_key, channel, arrival_tick, fidelity,
               algorithm_version
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             ON CONFLICT (workspace_id, campaign_id, node_key, packet_id) DO NOTHING`,
            [
              scope.workspaceId,
              scope.worldId,
              scope.worldlineId,
              // 批次 T11-B：Exposure id 含 Campaign 命名空间（与 completeRun 一致）。
              `exposure_${input.campaign.id}_${exposure.nodeKey}_${exposure.packetId}`,
              input.campaign.id,
              exposure.packetId,
              exposure.nodeKey,
              exposure.channel,
              exposure.arrivalTick,
              exposure.fidelity,
              input.algorithmVersion,
            ],
          );
        }
      });
    },

    async listExposures(scope, campaignId) {
      return withWorkspaceTransaction(pool, scope.workspaceId, async (client) => {
        const result = await client.query(
          `SELECT * FROM propagation_exposures
           WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
             AND campaign_id = $4
           ORDER BY arrival_tick, node_key`,
          [scope.workspaceId, scope.worldId, scope.worldlineId, campaignId],
        );
        return result.rows.map((row) => ({
          nodeKey: row.node_key as string,
          packetId: row.packet_id as string,
          channel: row.channel as PropagationExposure["channel"],
          arrivalTick: Number(row.arrival_tick),
          fidelity: Number(row.fidelity),
          algorithmVersion: row.algorithm_version as string,
        }));
      });
    },

    async listPackets(scope, campaignId) {
      return withWorkspaceTransaction(pool, scope.workspaceId, async (client) => {
        const result = await client.query(
          `SELECT * FROM information_packets
           WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
             AND campaign_id = $4
           ORDER BY created_at, id`,
          [scope.workspaceId, scope.worldId, scope.worldlineId, campaignId],
        );
        return result.rows.map((row): InformationPacket => ({
          id: row.id,
          campaignId: row.campaign_id,
          parentPacketId: row.parent_packet_id ?? null,
          channel: row.channel,
          claimIds: row.claim_ids,
          framing: row.framing,
          omittedClaimIds: row.omitted_claim_ids,
          semanticFidelityToParent: Number(row.semantic_fidelity_to_parent),
          contentHash: row.content_hash,
        }));
      });
    },
  };
}
