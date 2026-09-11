import type { Pool } from "pg";
import type { WorldScope } from "../../modules/world-knowledge/public.ts";
import { withWorkspaceTransaction } from "./workspace-transaction.ts";

/**
 * 批次 T11-G：Propagation Exposure 的服务端授权读取（T11-F §四/§5.3）。
 * join 链：Exposure → Campaign(canon_revision_id) → canon_revision_audiences
 * → 当前 Record 中 principal 控制的 active continuity。任一环节缺失即过滤；
 * owner 控制面视图只在显式 view=control 下由路由层选择，且绝不把
 * non-public 塞进普通角色视角；无 public fallback。
 */

export interface AuthorizedExposure {
  campaignId: string;
  packetId: string;
  nodeKey: string;
  channel: string;
  arrivalTick: number;
  fidelity: number;
  algorithmVersion: string;
  securityClass: string;
}

export interface RecordViewerContext {
  worldId: string;
  worldlineId: string;
  membershipRole: string;
  /** 当前 Record 中 principal 控制的 active character continuities。 */
  controlledContinuityIds: readonly string[];
}

/** 解析 record → world/worldline + 请求者 membership 角色（非成员/未知 null）。 */
export async function resolveRecordViewerContext(
  pool: Pool,
  input: {
    workspaceId: string;
    recordId: string;
    principalId: string;
  },
): Promise<RecordViewerContext | null> {
  return withWorkspaceTransaction(
    pool,
    input.workspaceId,
    async (client) => {
      const record = await client.query<{
        world_id: string;
        worldline_id: string;
        role: string;
      }>(
        `SELECT record.world_id, worldline.id AS worldline_id, membership.role
         FROM records AS record
         JOIN player_world_memberships AS membership
           ON membership.workspace_id = record.workspace_id
          AND membership.world_id = record.world_id
          AND membership.principal_id = $3
         JOIN worldlines AS worldline
           ON worldline.workspace_id = record.workspace_id
          AND worldline.world_id = record.world_id
          AND worldline.id = record.worldline_id
         WHERE record.workspace_id = $1 AND record.id = $2
         LIMIT 1`,
        [input.workspaceId, input.recordId, input.principalId],
      );
      const row = record.rows[0];
      if (!row) return null;
      const controlled = await client.query<{ continuity_id: string }>(
        `SELECT DISTINCT instance.continuity_id
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
          AND continuity.status = 'active'
         WHERE participant.workspace_id = $1
           AND participant.world_id = $4
           AND participant.worldline_id = $5
           AND participant.record_id = $2
           AND participant.principal_id = $3
           AND participant.participant_kind = 'character'
           AND participant.is_active
           AND instance.status = 'present'
           AND participant.character_instance_id IS NOT NULL`,
        [input.workspaceId, input.recordId, input.principalId, row.world_id, row.worldline_id],
      );
      return {
        worldId: row.world_id,
        worldlineId: row.worldline_id,
        membershipRole: row.role,
        controlledContinuityIds: controlled.rows.map((entry) => entry.continuity_id),
      };
    },
    { readOnly: true },
  );
}

/** 按授权读取 Exposure（controlPlane=owner 控制面；否则角色视角过滤）。 */
export async function listAuthorizedExposures(
  pool: Pool,
  scope: WorldScope,
  viewer: RecordViewerContext,
  options: { controlPlane: boolean; campaignId?: string },
): Promise<readonly AuthorizedExposure[]> {
  return withWorkspaceTransaction(
    pool,
    scope.workspaceId,
    async (client) => {
      const params: unknown[] = [
        scope.workspaceId,
        scope.worldId,
        scope.worldlineId,
        options.campaignId ?? null,
      ];
      // 控制面：owner 显式审阅，不按 audience 过滤（路由层已校验 owner）。
      // 角色视角：public 或 audience 命中（当前 Record 控制的 continuity）。
      const classFilter = options.controlPlane
        ? ""
        : `AND (
             campaign.security_class = 'public'
             OR EXISTS (
               SELECT 1
               FROM canon_revision_audiences AS audience
               JOIN propagation_node_audiences AS node_audience
                 ON node_audience.workspace_id = exposure.workspace_id
                AND node_audience.world_id = exposure.world_id
                AND node_audience.worldline_id = exposure.worldline_id
                AND node_audience.node_key = exposure.node_key
                AND node_audience.continuity_id = audience.continuity_id
               WHERE audience.workspace_id = exposure.workspace_id
                 AND audience.world_id = exposure.world_id
                 AND audience.worldline_id = exposure.worldline_id
                 AND audience.revision_id = campaign.canon_revision_id
                 AND audience.continuity_id = ANY($5::text[])
             )
           )`;
      if (!options.controlPlane) {
        params.push(viewer.controlledContinuityIds.length > 0
          ? [...viewer.controlledContinuityIds]
          : ["__none__"]);
      }
      const result = await client.query(
        `SELECT
           exposure.campaign_id,
           exposure.packet_id,
           exposure.node_key,
           exposure.channel,
           exposure.arrival_tick,
           exposure.fidelity,
           exposure.algorithm_version,
           campaign.security_class
         FROM propagation_exposures AS exposure
         JOIN information_campaigns AS campaign
           ON campaign.workspace_id = exposure.workspace_id
          AND campaign.world_id = exposure.world_id
          AND campaign.worldline_id = exposure.worldline_id
          AND campaign.id = exposure.campaign_id
         WHERE exposure.workspace_id = $1
           AND exposure.world_id = $2
           AND exposure.worldline_id = $3
           AND ($4::text IS NULL OR exposure.campaign_id = $4)
           ${classFilter}
         ORDER BY exposure.arrival_tick, exposure.node_key, exposure.id`,
        params,
      );
      return result.rows.map((row): AuthorizedExposure => ({
        campaignId: row.campaign_id as string,
        packetId: row.packet_id as string,
        nodeKey: row.node_key as string,
        channel: row.channel as string,
        arrivalTick: Number(row.arrival_tick),
        fidelity: Number(row.fidelity),
        algorithmVersion: row.algorithm_version as string,
        securityClass: row.security_class as string,
      }));
    },
    { readOnly: true },
  );
}
