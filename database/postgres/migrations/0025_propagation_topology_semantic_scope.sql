-- REALM Propagation Topology & Semantic Evidence Scope
-- 批次 T11-B（docs/development/T11-B-PROPAGATION-ENABLEMENT-IMPLEMENTATION.md）：
--   1. propagation_nodes / propagation_routes — 显式社会传播拓扑（真实
--      持久化来源，禁止用 world_relations 冒充通信渠道）；双端点复合 FK
--      保证路线两端同 workspace/world/worldline；realm_runtime 只读，
--      治理写入走 owner 通道的稳定种子（demo-seed）。
--   2. Campaign↔CanonRevision 与 job↔campaign 唯一索引——Canon merge
--      原子入队的数据库幂等闸门，不依赖应用层先查再插。
--   3. semantic_conflict_evaluations 补 world/worldline/request 关联列
--      （可空兼容既有行）；append-only 守卫与 FORCE RLS 不变。

CREATE TABLE IF NOT EXISTS propagation_nodes (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  node_key text NOT NULL,
  clearance text NOT NULL DEFAULT 'public',
  active boolean NOT NULL DEFAULT TRUE,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, world_id, worldline_id, node_key),
  CONSTRAINT propagation_nodes_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT propagation_nodes_worldline_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id)
    REFERENCES worldlines (workspace_id, world_id, id) ON DELETE CASCADE,
  CONSTRAINT propagation_nodes_clearance_check
    CHECK (clearance IN ('public', 'restricted', 'secret')),
  CHECK (length(btrim(node_key)) > 0)
);

CREATE TABLE IF NOT EXISTS propagation_routes (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  id text NOT NULL,
  from_node text NOT NULL,
  to_node text NOT NULL,
  channel text NOT NULL,
  distance numeric(10, 2) NOT NULL DEFAULT 1,
  recipient text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, world_id, worldline_id, id),
  CONSTRAINT propagation_routes_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT propagation_routes_from_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, from_node)
    REFERENCES propagation_nodes (workspace_id, world_id, worldline_id, node_key)
    ON DELETE CASCADE,
  CONSTRAINT propagation_routes_to_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, to_node)
    REFERENCES propagation_nodes (workspace_id, world_id, worldline_id, node_key)
    ON DELETE CASCADE,
  CONSTRAINT propagation_routes_channel_check
    CHECK (channel IN ('official_bulletin', 'private_letter', 'market_rumor')),
  CONSTRAINT propagation_routes_recipient_check
    CHECK (channel <> 'private_letter' OR recipient IS NOT NULL),
  CONSTRAINT propagation_routes_no_self_loop CHECK (from_node <> to_node),
  CHECK (distance >= 0)
);

ALTER TABLE propagation_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE propagation_nodes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON propagation_nodes;
CREATE POLICY realm_workspace_isolation ON propagation_nodes
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

ALTER TABLE propagation_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE propagation_routes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON propagation_routes;
CREATE POLICY realm_workspace_isolation ON propagation_routes
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

GRANT SELECT ON propagation_nodes TO realm_runtime;
GRANT SELECT ON propagation_routes TO realm_runtime;

ALTER TABLE information_campaigns
  ADD COLUMN IF NOT EXISTS canon_revision_id text;
CREATE UNIQUE INDEX IF NOT EXISTS information_campaigns_canon_revision_uidx
  ON information_campaigns (workspace_id, world_id, worldline_id, canon_revision_id)
  WHERE canon_revision_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS propagation_jobs_campaign_uidx
  ON propagation_jobs (workspace_id, world_id, worldline_id, campaign_id);

ALTER TABLE semantic_conflict_evaluations
  ADD COLUMN IF NOT EXISTS world_id text,
  ADD COLUMN IF NOT EXISTS worldline_id text,
  ADD COLUMN IF NOT EXISTS request_id text;

COMMENT ON TABLE propagation_nodes IS
  'Explicit social propagation topology nodes (batch T11-B): canon_origin virtual node plus social nodes with clearance; governed via owner-channel seed, realm_runtime read-only.';
COMMENT ON TABLE propagation_routes IS
  'Explicit propagation channel routes (batch T11-B): both endpoints are same-scope propagation_nodes (composite FK); private_letter requires recipient.';
COMMENT ON COLUMN information_campaigns.canon_revision_id IS
  'Derived-from CanonRevision id (batch T11-B); partial unique index makes Canon merge → Campaign creation idempotent at the database level.';
