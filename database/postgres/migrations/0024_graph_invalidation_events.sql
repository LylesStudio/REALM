-- REALM Graph Invalidation Events
-- 批次 T11-A2（public documentation）：
-- 图谱/CANON 写事务的持久化失效账本。业务写与失效记录同一事务插入——
-- 事务回滚则失效记录同样回滚，不存在「业务回滚但事件可见」。
-- cursor 全表单调（GENERATED ALWAYS AS IDENTITY），SSE 断线重连按
-- Last-Event-ID 从账本重放；pg_notify 仅作低延迟唤醒，账本才是恢复依据。
-- 事件只携带作用域与 kind/reason，不携带实体/Claim/提案内容。
-- 世界/世界线删除时级联清除。

CREATE TABLE IF NOT EXISTS graph_invalidation_events (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  cursor bigint GENERATED ALWAYS AS IDENTITY,
  id text NOT NULL,
  kind text NOT NULL CHECK (kind IN (
    'entity', 'claim', 'relation', 'article',
    'canon_proposal', 'canon_decision', 'canon_merge'
  )),
  reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, cursor),
  CONSTRAINT graph_invalidation_events_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE
);

ALTER TABLE graph_invalidation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE graph_invalidation_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON graph_invalidation_events;
CREATE POLICY realm_workspace_isolation ON graph_invalidation_events
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

GRANT SELECT, INSERT ON graph_invalidation_events TO realm_runtime;

CREATE OR REPLACE FUNCTION guard_graph_invalidation_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'graph invalidation events are immutable';
END;
$$;

DROP TRIGGER IF EXISTS graph_invalidation_append_only_guard ON graph_invalidation_events;
CREATE TRIGGER graph_invalidation_append_only_guard
BEFORE UPDATE OR DELETE ON graph_invalidation_events
FOR EACH ROW
EXECUTE FUNCTION guard_graph_invalidation_append_only();

COMMENT ON TABLE graph_invalidation_events IS
  'Append-only invalidation ledger for the knowledge graph / canon snapshot (batch T11-A2): written in the same transaction as the business write, replayed by cursor after SSE reconnect; pg_notify is only a wakeup hint.';
COMMENT ON COLUMN graph_invalidation_events.kind IS
  'Invalidation kind: entity/claim/relation/article for graph writes, canon_proposal/canon_decision/canon_merge for canon writes.';
