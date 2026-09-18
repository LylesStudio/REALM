-- REALM Library runtime grants
-- 批次 T10-B7（public documentation）：
-- owner-pool 例外命令下沉受限角色的最小授权。逐条对应规范 §一矩阵。
-- 0001–0022 不改动；RLS/触发器/业务门禁语义不变。

-- worlds：创建世界（library-service.ts:335/673）。
GRANT INSERT ON worlds TO realm_runtime;
-- character_definitions：添角色/创世同伴/酒馆导入（:383/713/931/1568；
-- tavern-import-service.ts:192）。
GRANT INSERT ON character_definitions TO realm_runtime;
-- character_continuities：装配/挂入/姿态席位（:953/1368/1592）。
GRANT INSERT ON character_continuities TO realm_runtime;
-- character_instances：装配/挂入/姿态席位（:975/1383/1618）。
GRANT INSERT ON character_instances TO realm_runtime;
-- participants：装配/挂入/narrator 席位（:991/1066/1398/1633）；
-- UPDATE 仅 is_active 列（姿态开关翻转，:1484/1514/1535）。
GRANT INSERT ON participants TO realm_runtime;
GRANT UPDATE (is_active) ON participants TO realm_runtime;
-- record_heads：新建记录头（:639/754）。
GRANT INSERT ON record_heads TO realm_runtime;
-- player_world_memberships：姿态切换仅改 role 列（:1463；INSERT 0013 已授）。
GRANT UPDATE (role) ON player_world_memberships TO realm_runtime;
-- 世界基础规则定义（T4 装配/导入；base-rule-definitions.ts:97/117/136）。
GRANT INSERT ON skill_definitions TO realm_runtime;
GRANT INSERT ON asset_definitions TO realm_runtime;
GRANT INSERT ON effect_definitions TO realm_runtime;
-- 实例授权账本（装配/挂入；base-rule-definitions.ts:197/233/283）。
GRANT INSERT ON character_skills TO realm_runtime;
GRANT INSERT ON character_assets TO realm_runtime;
