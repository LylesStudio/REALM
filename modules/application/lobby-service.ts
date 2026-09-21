/**
 * LAN 游戏大厅服务（docs/development/LAN-GAME-LOBBY-PLAN.md）。
 *
 * 边界：
 * - 房间 = 约局元数据（房名/房主/成员/容量/密码/状态）；未绑定房间不触碰
 *   World/Story/Record。绑定世界是房主的显式分享，加入时只授予既有 World
 *   的 player membership，不创建或修改 Story/Record。
 * - principal 只来自调用方传入的服务端 session 解析结果；不信任客户端
 *   userId。
 * - 密码：scrypt(N=16384,r=8,p=1) + 16B 随机 salt，timingSafeEqual 校验；
 *   明文/hash 绝不出现在响应、日志或错误消息。
 * - 容量判定与加入在同一事务对房间行 FOR UPDATE（不超卖）；加入幂等
 *   （在册成员重复加入 = ok）；关闭/离开幂等。
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import type { QueryResult, QueryResultRow } from "pg";
import {
  withWorkspaceTransaction,
  type WorkspaceDatabase,
} from "../../database/postgres/workspace-transaction.ts";

/** 最小可查询接口：PoolClient / pg Client（LISTEN 连接）均满足。 */
interface Queryable {
  query: <R extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[],
  ) => Promise<QueryResult<R>>;
}

// promisify 的 scrypt 类型签名不含 options；手写包装保留 N/r/p 参数。
function scrypt(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    scryptCb(password, salt, keyLength, options, (error, key) =>
      error ? reject(error) : resolvePromise(key));
  });
}
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;

export const LOBBY_CHANGED_CHANNEL = "lobby_changed";

export interface LobbyScope {
  workspaceId: string;
  principalId: string;
}

export interface LobbyRoomSummary {
  id: string;
  name: string;
  hostDisplayName: string;
  memberCount: number;
  capacity: number;
  hasPassword: boolean;
  status: "open" | "closed";
  /** 当前 viewer 的成员身份（host/player/null）。 */
  viewerRole: "host" | "player" | null;
  /** 绑定的共享世界（房主显式分享；null = 纯约局房间）。 */
  worldId: string | null;
  worldName: string | null;
}

export interface LobbyRoomMember {
  displayName: string;
  role: "host" | "player";
  isViewer: boolean;
}

export class LobbyError extends Error {
  readonly code:
    | "INVALID_COMMAND"
    | "ROOM_NOT_FOUND"
    | "ROOM_CLOSED"
    | "ROOM_FULL"
    | "BAD_PASSWORD"
    | "NOT_HOST"
    | "NOT_MEMBER"
    | "NOT_WORLD_OWNER";

  constructor(code: LobbyError["code"], message: string) {
    super(message);
    this.name = "LobbyError";
    this.code = code;
  }
}

export function normalizeRoomName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name.length > 40) {
    throw new LobbyError("INVALID_COMMAND", "房名需要 1–40 个字符。");
  }
  return name;
}

export function normalizeCapacity(value: unknown): number {
  if (value === undefined || value === null || value === "") return 4;
  const capacity = Number(value);
  if (!Number.isSafeInteger(capacity) || capacity < 2 || capacity > 8) {
    throw new LobbyError("INVALID_COMMAND", "人数上限需要是 2–8。");
  }
  return capacity;
}

/** scrypt 哈希存储格式：scrypt:N:r:p:<saltB64>:<hashB64>。 */
export async function hashRoomPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString("base64")}:${key.toString("base64")}`;
}

/** 常量时间校验；格式非法/hash 缺失一律 false。 */
export async function verifyRoomPassword(
  password: string,
  storedHash: string | null,
): Promise<boolean> {
  if (!storedHash) return false;
  const parts = storedHash.split(":");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[4] ?? "", "base64");
  const expected = Buffer.from(parts[5] ?? "", "base64");
  let actual: Buffer;
  try {
    actual = await scrypt(password, salt, expected.length, {
      N: Number(parts[1]),
      r: Number(parts[2]),
      p: Number(parts[3]),
    });
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function notifyLobbyChanged(client: Queryable, workspaceId: string) {
  // NOTIFY 仅作低延迟唤醒；客户端收到后权威重读列表，不信任载荷内容。
  await client.query(`SELECT pg_notify($1, $2)`, [LOBBY_CHANGED_CHANNEL, workspaceId]);
}

/** 房主在线租约默认 90s；心跳频率由路由层按 lease/3 告知客户端。 */
export const LOBBY_LEASE_TTL_MS = 90_000;

export interface LobbyServiceOptions {
  /** 测试/隔离环境可注入更短租约；缺省 90s。 */
  leaseTtlMs?: number;
}

export function createLobbyService(
  database: WorkspaceDatabase,
  options: LobbyServiceOptions = {},
) {
  const leaseTtlMs = options.leaseTtlMs ?? LOBBY_LEASE_TTL_MS;
  if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs < 1000) {
    throw new LobbyError("INVALID_COMMAND", "leaseTtlMs must be >= 1000.");
  }

  /**
   * lazy reap：把过期 open 房间置为 closed（同事务 pg_notify 唤醒观察者）。
   * 触发边界 = 权威读（list）/写（join）与大厅 SSE tick；无后台常驻 reaper。
   * 返回回收的房间数。
   */
  async function reapExpiredRooms(
    client: Queryable,
    scope: LobbyScope,
  ): Promise<number> {
    const reaped = await client.query(
      `UPDATE lobby_rooms SET status = 'closed', updated_at = CURRENT_TIMESTAMP
       WHERE workspace_id = $1 AND status = 'open'
         AND lease_expires_at IS NOT NULL
         AND lease_expires_at <= CURRENT_TIMESTAMP
       RETURNING id`,
      [scope.workspaceId],
    );
    if ((reaped.rowCount ?? 0) > 0) {
      await notifyLobbyChanged(client, scope.workspaceId);
    }
    return reaped.rowCount ?? 0;
  }

  /** 服务实例自述（路由把它放进 GET meta，客户端据此安排心跳）。 */
  function describe() {
    return {
      leaseTtlMs,
      heartbeatIntervalMs: Math.max(500, Math.floor(leaseTtlMs / 3)),
    };
  }

  async function listRooms(scope: LobbyScope): Promise<LobbyRoomSummary[]> {
    return withWorkspaceTransaction(
      database,
      scope.workspaceId,
      async (client) => {
        // lazy reap：权威读先回收过期房间（事务内一致快照；有回收才唤醒）。
        await reapExpiredRooms(client, scope);
        const result = await client.query<{
          id: string;
          name: string;
          status: "open" | "closed";
          capacity: number;
          has_password: boolean;
          member_count: string;
          host_display_name: string | null;
          viewer_role: "host" | "player" | null;
          world_id: string | null;
          world_name: string | null;
        }>(
          // member 聚合走显式 MATERIALIZED CTE（一次聚合 + workspace 过滤下推）：
          // 统计信息缺失/批量建房窗口内，非关联派生表会被 planner 退化为
          // nested-loop per-room GroupAggregate（rooms × members 行次扫描，
          // 见 scripts/lobby-query-diagnosis.mjs 与 scripts/lobby-aggregation-experiment.mjs
          // 的 before/after 证据）；MATERIALIZED 围栏保证聚合只算一次。
          // 等价性：派生表经 JOIN ON workspace_id = room.workspace_id 且
          // room.workspace_id = $1，其它 workspace 的聚合行永不被消费。
          // viewer 成员资格同样走 MATERIALIZED CTE（workspace+principal 一次
          // 读取）：fresh 状态下原 LEFT JOIN 逐房 index lookup 是最大残余成本
          // （scripts/lobby-residual-joins-diagnosis.mjs 归因、
          // scripts/lobby-viewer-join-experiment.mjs 双候选 before/after）；
          // LATERAL 主键直达候选无收益（planner 生成同形态计划），未采用。
          `WITH member_counts AS MATERIALIZED (
             SELECT member.workspace_id, member.room_id, count(*)::text AS member_count
             FROM lobby_room_members AS member
             WHERE member.left_at IS NULL
               AND member.workspace_id = $1
             GROUP BY member.workspace_id, member.room_id
           ),
           viewer_membership AS MATERIALIZED (
             SELECT member.workspace_id, member.room_id, member.role
             FROM lobby_room_members AS member
             WHERE member.workspace_id = $1
               AND member.principal_id = $2
               AND member.left_at IS NULL
           )
           SELECT room.id, room.name, room.status, room.capacity,
                  room.password_hash IS NOT NULL AS has_password,
                  COALESCE(member_counts.member_count, '0') AS member_count,
                  host_account.display_name AS host_display_name,
                  viewer_member.role AS viewer_role,
                  room.world_id,
                  world.name AS world_name
           FROM lobby_rooms AS room
           LEFT JOIN member_counts
             ON member_counts.workspace_id = room.workspace_id
            AND member_counts.room_id = room.id
           LEFT JOIN accounts AS host_account
             ON host_account.workspace_id = room.workspace_id
            AND host_account.principal_id = room.host_principal_id
           LEFT JOIN viewer_membership AS viewer_member
             ON viewer_member.workspace_id = room.workspace_id
            AND viewer_member.room_id = room.id
           LEFT JOIN worlds AS world
             ON world.workspace_id = room.workspace_id
            AND world.id = room.world_id
           WHERE room.workspace_id = $1
           ORDER BY room.created_at DESC, room.id DESC`,
          [scope.workspaceId, scope.principalId],
        );
        return result.rows.map((row) => ({
          id: row.id,
          name: row.name,
          // 账号行缺失时 fail-closed 为占位名，绝不回退到 principal id。
          hostDisplayName: row.host_display_name?.trim() || "旅人",
          memberCount: Math.max(0, Number(row.member_count) || 0),
          capacity: row.capacity,
          hasPassword: row.has_password,
          status: row.status,
          viewerRole: row.viewer_role,
          worldId: row.world_id,
          worldName: row.world_name,
        }));
      },
      // 非只读：list 开头的 lazy reap 可能写状态行。
    );
  }

  async function listMembers(
    scope: LobbyScope,
    roomId: string,
  ): Promise<LobbyRoomMember[]> {
    return withWorkspaceTransaction(
      database,
      scope.workspaceId,
      async (client) => {
        const access = await client.query<{
          room_exists: boolean;
          member_active: boolean;
        }>(
          `SELECT EXISTS (
             SELECT 1 FROM lobby_rooms AS room
             WHERE room.workspace_id = $1 AND room.id = $2
           ) AS room_exists,
           EXISTS (
             SELECT 1 FROM lobby_room_members AS member
             WHERE member.workspace_id = $1
               AND member.room_id = $2
               AND member.principal_id = $3
               AND member.left_at IS NULL
           ) AS member_active`,
          [scope.workspaceId, roomId, scope.principalId],
        );
        const accessRow = access.rows[0];
        if (!accessRow?.room_exists) {
          throw new LobbyError("ROOM_NOT_FOUND", "房间不存在或已解散。");
        }
        if (!accessRow.member_active) {
          throw new LobbyError("NOT_MEMBER", "请先加入房间。");
        }
        const result = await client.query<{
          principal_id: string;
          role: "host" | "player";
          display_name: string | null;
        }>(
          `SELECT member.principal_id, member.role,
                  account.display_name
           FROM lobby_room_members AS member
           LEFT JOIN accounts AS account
             ON account.workspace_id = member.workspace_id
            AND account.principal_id = member.principal_id
           WHERE member.workspace_id = $1 AND member.room_id = $2
             AND member.left_at IS NULL
           ORDER BY member.joined_at ASC, member.principal_id ASC`,
          [scope.workspaceId, roomId],
        );
        return result.rows.map((row) => ({
          displayName: row.display_name?.trim() || "旅人",
          role: row.role,
          isViewer: row.principal_id === scope.principalId,
        }));
      },
      { readOnly: true },
    );
  }

  async function createRoom(
    scope: LobbyScope,
    input: { name: unknown; password?: unknown; capacity?: unknown; worldId?: unknown },
  ): Promise<{ roomId: string }> {
    const name = normalizeRoomName(input.name);
    const capacity = normalizeCapacity(input.capacity);
    const password = typeof input.password === "string" ? input.password : "";
    if (password.length > 80) {
      throw new LobbyError("INVALID_COMMAND", "房间密码不能超过 80 个字符。");
    }
    const worldId = typeof input.worldId === "string" && input.worldId.trim()
      ? input.worldId.trim()
      : null;
    const passwordHash = password ? await hashRoomPassword(password) : null;
    const roomId = `lobby_${randomBytes(12).toString("hex")}`;
    return withWorkspaceTransaction(database, scope.workspaceId, async (client) => {
      if (worldId) {
        // 绑定世界 = 房主的显式分享动作：只允许 owner 绑定自己的世界，
        // 他人世界 fail-closed 为不存在（不泄露存在性）。
        const ownership = await client.query(
          `SELECT 1 FROM player_world_memberships
           WHERE workspace_id = $1 AND world_id = $2 AND principal_id = $3
             AND role = 'owner'`,
          [scope.workspaceId, worldId, scope.principalId],
        );
        if (ownership.rowCount === 0) {
          throw new LobbyError("NOT_WORLD_OWNER", "只能绑定你拥有的世界。");
        }
      }
      await client.query(
        `INSERT INTO lobby_rooms (
           workspace_id, id, name, status, capacity, password_hash, host_principal_id, world_id,
           lease_expires_at
         ) VALUES ($1, $2, $3, 'open', $4, $5, $6, $7,
           CURRENT_TIMESTAMP + ($8::text || ' milliseconds')::interval)`,
        [
          scope.workspaceId,
          roomId,
          name,
          capacity,
          passwordHash,
          scope.principalId,
          worldId,
          String(leaseTtlMs),
        ],
      );
      await client.query(
        `INSERT INTO lobby_room_members (workspace_id, room_id, principal_id, role)
         VALUES ($1, $2, $3, 'host')`,
        [scope.workspaceId, roomId, scope.principalId],
      );
      await notifyLobbyChanged(client, scope.workspaceId);
      return { roomId };
    });
  }

  async function joinRoom(
    scope: LobbyScope,
    input: { roomId: unknown; password?: unknown },
  ): Promise<{ roomId: string }> {
    const roomId = typeof input.roomId === "string" ? input.roomId.trim() : "";
    if (!roomId) throw new LobbyError("INVALID_COMMAND", "roomId is required.");
    const password = typeof input.password === "string" ? input.password : "";
    return withWorkspaceTransaction(database, scope.workspaceId, async (client) => {
      // lazy reap：过期房间先置 closed（随后按关闭语义拒绝加入）。
      await reapExpiredRooms(client, scope);
      // 先锁房间行，再用下一条命令读取成员计数：在 READ COMMITTED 下，
      // FOR UPDATE 等待后原语句的快照可能仍看不到刚提交的成员；拆句保证
      // 容量判断使用拿到锁之后的新快照。
      const room = await client.query<{
        status: string;
        capacity: number;
        password_hash: string | null;
        world_id: string | null;
      }>(
        `SELECT room.status, room.capacity, room.password_hash, room.world_id
         FROM lobby_rooms AS room
         WHERE room.workspace_id = $1 AND room.id = $2
         FOR UPDATE OF room`,
        [scope.workspaceId, roomId],
      );
      const roomRow = room.rows[0];
      if (!roomRow) throw new LobbyError("ROOM_NOT_FOUND", "房间不存在或已解散。");
      const membership = await client.query<{
        member_count: string;
        viewer_active: boolean;
      }>(
        `SELECT
           (SELECT count(*)::text FROM lobby_room_members AS member
             WHERE member.workspace_id = $1
               AND member.room_id = $2
               AND member.left_at IS NULL) AS member_count,
           EXISTS (
             SELECT 1 FROM lobby_room_members AS mine
             WHERE mine.workspace_id = $1
               AND mine.room_id = $2
               AND mine.principal_id = $3
               AND mine.left_at IS NULL
           ) AS viewer_active`,
        [scope.workspaceId, roomId, scope.principalId],
      );
      const row = {
        ...roomRow,
        member_count: membership.rows[0]?.member_count ?? "0",
        viewer_active: membership.rows[0]?.viewer_active ?? false,
      };
      // 幂等：已是在册成员直接 ok（网络重试/双击安全）。
      if (row.viewer_active) return { roomId };
      if (row.status !== "open") throw new LobbyError("ROOM_CLOSED", "房间已关闭。");
      if (row.password_hash !== null) {
        const ok = await verifyRoomPassword(password, row.password_hash);
        if (!ok) throw new LobbyError("BAD_PASSWORD", "密码不正确。");
      }
      if (Number(row.member_count) >= row.capacity) {
        throw new LobbyError("ROOM_FULL", "房间已满。");
      }
      // 曾离开的成员回归：清除 left_at；新成员插入。
      await client.query(
        `INSERT INTO lobby_room_members (workspace_id, room_id, principal_id, role)
         VALUES ($1, $2, $3, 'player')
         ON CONFLICT (workspace_id, room_id, principal_id)
         DO UPDATE SET left_at = NULL, joined_at = CURRENT_TIMESTAMP, role = 'player'`,
        [scope.workspaceId, roomId, scope.principalId],
      );
      // 房间绑定了共享世界：加入房间 = 同事务获得该世界的 player 成员
      // 关系（房主建房时已显式分享；幂等）。v1 不在退房时回收——见计划。
      if (row.world_id) {
        await client.query(
          `INSERT INTO player_world_memberships (
             workspace_id, world_id, principal_id, role,
             omniscient_player_character, can_view_dynamic_knowledge
           ) VALUES ($1, $2, $3, 'player', true, true)
           ON CONFLICT (workspace_id, world_id, principal_id) DO NOTHING`,
          [scope.workspaceId, row.world_id, scope.principalId],
        );
      }
      await notifyLobbyChanged(client, scope.workspaceId);
      return { roomId };
    });
  }

  async function leaveRoom(scope: LobbyScope, roomIdInput: unknown): Promise<void> {
    const roomId = typeof roomIdInput === "string" ? roomIdInput.trim() : "";
    if (!roomId) throw new LobbyError("INVALID_COMMAND", "roomId is required.");
    return withWorkspaceTransaction(database, scope.workspaceId, async (client) => {
      const updated = await client.query(
        `UPDATE lobby_room_members SET left_at = CURRENT_TIMESTAMP
         WHERE workspace_id = $1 AND room_id = $2 AND principal_id = $3
           AND left_at IS NULL`,
        [scope.workspaceId, roomId, scope.principalId],
      );
      if (updated.rowCount === 0) {
        // 幂等：不在册（或已离开）不报错——但对不存在的房间仍 fail-closed。
        const room = await client.query(
          `SELECT 1 FROM lobby_rooms WHERE workspace_id = $1 AND id = $2`,
          [scope.workspaceId, roomId],
        );
        if (room.rowCount === 0) {
          throw new LobbyError("ROOM_NOT_FOUND", "房间不存在或已解散。");
        }
        return;
      }
      await notifyLobbyChanged(client, scope.workspaceId);
    });
  }

  async function closeRoom(scope: LobbyScope, roomIdInput: unknown): Promise<void> {
    const roomId = typeof roomIdInput === "string" ? roomIdInput.trim() : "";
    if (!roomId) throw new LobbyError("INVALID_COMMAND", "roomId is required.");
    return withWorkspaceTransaction(database, scope.workspaceId, async (client) => {
      // 先锁后判：房主校验必须在状态写入之前。
      const room = await client.query<{
        status: string;
        host_principal_id: string;
      }>(
        `SELECT status, host_principal_id FROM lobby_rooms
         WHERE workspace_id = $1 AND id = $2
         FOR UPDATE`,
        [scope.workspaceId, roomId],
      );
      const row = room.rows[0];
      if (!row) throw new LobbyError("ROOM_NOT_FOUND", "房间不存在或已解散。");
      if (row.host_principal_id !== scope.principalId) {
        throw new LobbyError("NOT_HOST", "只有房主可以关闭房间。");
      }
      // 幂等：已 closed 视为成功。
      if (row.status === "closed") return;
      await client.query(
        `UPDATE lobby_rooms SET status = 'closed', updated_at = CURRENT_TIMESTAMP
         WHERE workspace_id = $1 AND id = $2`,
        [scope.workspaceId, roomId],
      );
      await notifyLobbyChanged(client, scope.workspaceId);
    });
  }

  /**
   * 房主心跳：续租本人 host 的 open 房间（服务端时钟权威）。已过期（未
   * 续上）的房间不被复活——它们将在下一次权威读/SSE tick 被回收。
   * 幂等；客人/伪造 principal 不影响他人房间（WHERE host_principal_id）。
   */
  async function heartbeat(
    scope: LobbyScope,
  ): Promise<{ renewed: number; expiredHosted: number }> {
    return withWorkspaceTransaction(database, scope.workspaceId, async (client) => {
      const renewed = await client.query(
        `UPDATE lobby_rooms
         SET lease_expires_at = CURRENT_TIMESTAMP + ($3::text || ' milliseconds')::interval,
             updated_at = CURRENT_TIMESTAMP
         WHERE workspace_id = $1 AND status = 'open' AND host_principal_id = $2
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at > CURRENT_TIMESTAMP`,
        [scope.workspaceId, scope.principalId, String(leaseTtlMs)],
      );
      // 本人 host 的过期房间数（用于 UI 提示「已被自动关闭」）；顺手回收。
      const expiredHosted = await client.query(
        `UPDATE lobby_rooms SET status = 'closed', updated_at = CURRENT_TIMESTAMP
         WHERE workspace_id = $1 AND status = 'open' AND host_principal_id = $2
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at <= CURRENT_TIMESTAMP
         RETURNING id`,
        [scope.workspaceId, scope.principalId],
      );
      if ((expiredHosted.rowCount ?? 0) > 0) {
        await notifyLobbyChanged(client, scope.workspaceId);
      }
      return {
        renewed: renewed.rowCount ?? 0,
        expiredHosted: expiredHosted.rowCount ?? 0,
      };
    });
  }

  /** 大厅 SSE tick 的回收入口（仅在有客户端连接时执行，见计划文档）。 */
  async function reapExpired(scope: LobbyScope): Promise<number> {
    return withWorkspaceTransaction(database, scope.workspaceId, async (client) =>
      reapExpiredRooms(client, scope));
  }

  return {
    listRooms,
    listMembers,
    createRoom,
    joinRoom,
    leaveRoom,
    closeRoom,
    heartbeat,
    reapExpired,
    describe,
  };
}
