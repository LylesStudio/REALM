-- REALM Worldline Merge grants
-- 批次 T10-B1（public documentation）：
-- /api/worldline/merge 的真实合并写路径（M5 createMergedTopology）需要插入
-- 合并拓扑（worldlines/stories/records 三表）。0004 硬化收回了 realm_runtime
-- 对这些表的 INSERT，导致生产路径 permission denied（此前仅 owner 池测试
-- 覆盖，缺陷从未暴露）。合并是 M5 设计的成员可达治理功能，按最小缺口补授
-- INSERT；SELECT/UPDATE/DELETE 等其他权限面不变，0001–0021 不改动。

GRANT INSERT ON worldlines, stories, records TO realm_runtime;
