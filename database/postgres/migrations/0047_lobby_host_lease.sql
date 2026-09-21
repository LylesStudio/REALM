-- REALM LAN Game Lobby：房主在线租约（host lease / heartbeat）
-- （docs/development/LAN-GAME-LOBBY-PLAN.md §八 / 本批 P2 落地）。
-- lease_expires_at 为服务端时钟权威（CURRENT_TIMESTAMP 计算），客户端
-- 本地时间绝不决定权威状态；null = 0046 之前的遗留房间，永不自动过期
-- （既有语义不动）。过期回收是 lazy reap：权威读/写路径（list/join）
-- 与大厅 SSE 心跳 tick 触发，无后台常驻 reaper——没有请求时不存在
-- 「瞬时后台执行」，文档与 UI 均以此为准。

ALTER TABLE lobby_rooms
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

-- 过期回收扫描只碰 open 且带租约的行。
CREATE INDEX IF NOT EXISTS lobby_rooms_lease_idx
  ON lobby_rooms (workspace_id, lease_expires_at)
  WHERE status = 'open' AND lease_expires_at IS NOT NULL;

COMMENT ON COLUMN lobby_rooms.lease_expires_at IS
  'Host online lease (server-clock authoritative): renewed by host heartbeats; expired open rooms are closed by lazy reap on authoritative reads/writes or lobby SSE ticks. NULL = legacy room (never auto-expires).';
