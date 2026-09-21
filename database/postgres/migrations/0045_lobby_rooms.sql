-- REALM LAN Game Lobby（docs/development/LAN-GAME-LOBBY-PLAN.md）
-- 大厅「约局」元数据：房间 + 成员。与 World/Story/Record 无 FK、无共享
-- 语义——房间不创建也不修改任何世界内容；进入房间 ≠ 进入共享剧情。
-- 密码只存 scrypt 哈希（随机 salt），绝不存明文；成员离开是 left_at 置位
-- （realm_runtime 无 DELETE 授权）。两表沿用 realm_workspace_isolation。

CREATE TABLE IF NOT EXISTS lobby_rooms (
  workspace_id text NOT NULL,
  id text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  capacity integer NOT NULL DEFAULT 4,
  password_hash text,
  host_principal_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT lobby_rooms_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT lobby_rooms_status_check CHECK (status IN ('open', 'closed')),
  CONSTRAINT lobby_rooms_name_check CHECK (length(btrim(name)) BETWEEN 1 AND 40),
  CONSTRAINT lobby_rooms_capacity_check CHECK (capacity BETWEEN 2 AND 8),
  CONSTRAINT lobby_rooms_host_check CHECK (length(btrim(host_principal_id)) > 0)
);

CREATE TABLE IF NOT EXISTS lobby_room_members (
  workspace_id text NOT NULL,
  room_id text NOT NULL,
  principal_id text NOT NULL,
  role text NOT NULL DEFAULT 'player',
  joined_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  left_at timestamptz,
  PRIMARY KEY (workspace_id, room_id, principal_id),
  CONSTRAINT lobby_room_members_room_fk
    FOREIGN KEY (workspace_id, room_id)
    REFERENCES lobby_rooms (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT lobby_room_members_role_check CHECK (role IN ('host', 'player'))
);

CREATE INDEX IF NOT EXISTS lobby_room_members_room_idx
  ON lobby_room_members (workspace_id, room_id) WHERE left_at IS NULL;

ALTER TABLE lobby_rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE lobby_rooms FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON lobby_rooms;
CREATE POLICY realm_workspace_isolation ON lobby_rooms
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

ALTER TABLE lobby_room_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE lobby_room_members FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON lobby_room_members;
CREATE POLICY realm_workspace_isolation ON lobby_room_members
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

-- 最小授权：读列表 + 建房/加入 + 状态更新；无 DELETE（离开=left_at 置位）。
GRANT SELECT, INSERT, UPDATE ON lobby_rooms TO realm_runtime;
GRANT SELECT, INSERT, UPDATE ON lobby_room_members TO realm_runtime;

COMMENT ON TABLE lobby_rooms IS
  'LAN game lobby rooms (v1): matchmaking metadata only — no World/Story/Record linkage; passwords stored as scrypt hashes, never plaintext.';
COMMENT ON TABLE lobby_room_members IS
  'LAN lobby membership: soft-leave via left_at (realm_runtime holds no DELETE grant).';
