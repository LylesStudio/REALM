-- REALM World Admin grants
-- 批次 T8（public documentation）：世界管理台授权。
-- 归档翻转需要 worlds.status 列级 UPDATE（0014 只授了 settings 列）；
-- 受限物理删除（仅零事件世界，服务层 fail-closed 守卫）需要 worlds DELETE。
-- 级联子表删除以外键 ON DELETE CASCADE 动作者权限执行，不要求
-- realm_runtime 持子表 DELETE；events 等 append-only 表零事件世界无行可触发。

GRANT UPDATE (status, updated_at) ON worlds TO realm_runtime;
GRANT DELETE ON worlds TO realm_runtime;
