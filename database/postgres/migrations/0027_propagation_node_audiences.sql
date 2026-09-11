-- REALM Propagation Node Audiences
-- 批次 T11-G（T11-F §3.2）：社会节点与 continuity 的显式映射。
-- 职责三分不可互替：canon_revision_audiences 决定「这条 Canon 允许谁收」；
-- 本表决定「这个节点代表谁」；propagation_nodes.clearance 决定「节点最高
-- 可承接的安全级」。private_letter recipient 的 non-public 资格校验要求
-- 目标节点恰好映射一个 continuity（零/多都拒绝，不猜 recipient）。
-- 治理写入走 owner 通道；realm_runtime 只读（资格校验与读取授权用）。

CREATE TABLE IF NOT EXISTS propagation_node_audiences (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  node_key text NOT NULL,
  continuity_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, world_id, worldline_id, node_key, continuity_id),
  CONSTRAINT propagation_node_audiences_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT propagation_node_audiences_node_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, node_key)
    REFERENCES propagation_nodes (workspace_id, world_id, worldline_id, node_key)
    ON DELETE CASCADE,
  CONSTRAINT propagation_node_audiences_continuity_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, continuity_id)
    REFERENCES character_continuities (workspace_id, world_id, worldline_id, id)
);

ALTER TABLE propagation_node_audiences ENABLE ROW LEVEL SECURITY;
ALTER TABLE propagation_node_audiences FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON propagation_node_audiences;
CREATE POLICY realm_workspace_isolation ON propagation_node_audiences
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

GRANT SELECT ON propagation_node_audiences TO realm_runtime;

CREATE OR REPLACE FUNCTION guard_propagation_node_audience_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'propagation node audiences are immutable governance mappings';
END;
$$;

DROP TRIGGER IF EXISTS propagation_node_audiences_append_only_guard ON propagation_node_audiences;
CREATE TRIGGER propagation_node_audiences_append_only_guard
BEFORE UPDATE OR DELETE ON propagation_node_audiences
FOR EACH ROW
EXECUTE FUNCTION guard_propagation_node_audience_append_only();

COMMENT ON TABLE propagation_node_audiences IS
  'Node-to-continuity governance mapping (batch T11-G): which continuity a social node represents; required for non-public private_letter qualification (exactly one mapping per recipient node).';
