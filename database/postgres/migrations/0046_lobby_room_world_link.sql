-- REALM LAN Game Lobby：房间↔世界最小安全连接
-- （public documentation P0-1）。
-- lobby_rooms.world_id 可空：房主只能绑定自己是 owner 的世界（服务层
-- 校验）；加入绑定世界的房间 = 同事务写入 player_world_memberships
-- （role='player'，幂等）——世界分享是房主的显式动作，不放宽既有
-- owner/member/RLS 语义。不回收退房者的 membership（v1 边界，见计划）。

ALTER TABLE lobby_rooms
  ADD COLUMN IF NOT EXISTS world_id text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'lobby_rooms_world_fk'
  ) THEN
    ALTER TABLE lobby_rooms
      ADD CONSTRAINT lobby_rooms_world_fk
      FOREIGN KEY (workspace_id, world_id)
      REFERENCES worlds (workspace_id, id) ON DELETE CASCADE;
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS lobby_rooms_world_idx
  ON lobby_rooms (workspace_id, world_id) WHERE world_id IS NOT NULL;

COMMENT ON COLUMN lobby_rooms.world_id IS
  'Optional world binding (host must own the world); joining a bound room grants player membership in the same transaction.';
