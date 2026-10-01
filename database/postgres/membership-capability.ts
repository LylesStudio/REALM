/**
 * M5 membership capability 窄通道（0053）的应用侧入口。
 *
 * 所有 player_world_memberships 写入都经 DB 内 SECURITY DEFINER 的
 * mint→apply（票据不出库；actor/scope/op/role/rowHash 由票据绑定，actor
 * 由 DB 可验证的会话证明推导）。realm_runtime 的直接 INSERT/UPDATE(role)
 * 已被 0053 撤销；mint/apply 子操作无 runtime EXECUTE，生产路径只走
 * 组合入口 grant。
 *
 * 会话证明 = 当前会话 cookie 原值（principal.expiry.hmac），DB 用库内
 * 会话密钥副本（runtime 不可读）独立重算校验；密钥只能由可信
 * provisioning 权威写入（scripts/local-provision-capability-session.mjs），
 * 缺失/分歧时验证 fail-closed（CAPABILITY_SESSION_KEY_MISSING）。
 *
 * 调用方必须已在 withWorkspaceTransaction 事务内（realm.workspace_id GUC
 * 是函数语义的一部分；缺失即 fail-closed）。
 */
import type { PoolClient } from "pg";

export type MembershipCapabilityOp =
  | "join_player"
  | "genesis_creator"
  | "stance_self";

export async function grantMembershipWithCapability(
  client: PoolClient,
  input: {
    /** 经验证的会话证明（当前会话 cookie 原值）；缺失即 fail-closed。 */
    sessionProof: string;
    op: MembershipCapabilityOp;
    workspaceId: string;
    worldId: string;
    /** worldline 绑定（无维度处传 null；给出即须属于该 world）。 */
    worldlineId?: string | null;
    principalId: string;
    role: "owner" | "player" | "observer";
  },
): Promise<void> {
  await client.query(
    `SELECT membership_capability_grant($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.sessionProof,
      input.op,
      input.workspaceId,
      input.worldId,
      input.worldlineId ?? null,
      input.principalId,
      input.role,
    ],
  );
}
