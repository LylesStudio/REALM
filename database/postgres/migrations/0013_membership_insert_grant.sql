-- REALM Membership Join Grant
-- 登录/加入世界属于运行时身份操作：realm_runtime 需要能为新 principal
-- 写入 player_world_memberships。只授 INSERT；既有 UPDATE 保护
-- （omniscience 不可变触发器）与不授予 DELETE 的姿态保持不变。

GRANT INSERT ON player_world_memberships TO realm_runtime;

COMMENT ON TABLE player_world_memberships IS
  'Player-to-world membership; realm_runtime may INSERT join rows (login auto-join) but never UPDATE/DELETE.';
