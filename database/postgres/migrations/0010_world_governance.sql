-- REALM M5 World Governance Contract
-- PostgreSQL 16+
--
-- World knowledge graph (Entity/Relation/Claim/Article/CausalEdge),
-- Canon governance (Proposal/Revision) and deterministic social propagation
-- (Campaign/Packet/Exposure). Canon Claims, in-transit Packets and character
-- knowledge stay strictly separate.

CREATE TABLE IF NOT EXISTS world_entities (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  id text NOT NULL,
  entity_kind text NOT NULL,
  name text NOT NULL,
  summary text NOT NULL DEFAULT '',
  valid_from_tick bigint NOT NULL DEFAULT 0,
  valid_to_tick bigint,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, world_id, worldline_id, id),
  CONSTRAINT world_entities_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT world_entities_worldline_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id)
    REFERENCES worldlines (workspace_id, world_id, id) ON DELETE CASCADE,
  CONSTRAINT world_entities_kind_check
    CHECK (entity_kind IN (
      'geography', 'history', 'setting', 'faction', 'person', 'other'
    )),
  CHECK (length(btrim(name)) > 0),
  CHECK (valid_from_tick >= 0),
  CHECK (valid_to_tick IS NULL OR valid_to_tick >= valid_from_tick)
);

CREATE TABLE IF NOT EXISTS world_claims (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  id text NOT NULL,
  subject_entity_id text NOT NULL,
  predicate text NOT NULL,
  object_value text NOT NULL,
  scope text NOT NULL,
  truth_status text NOT NULL DEFAULT 'mentioned',
  confidence numeric(5, 4) NOT NULL DEFAULT 1.0,
  valid_from_tick bigint NOT NULL DEFAULT 0,
  valid_to_tick bigint,
  source_record_id text,
  source_event_id text,
  supersedes_claim_id text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, world_id, worldline_id, id),
  CONSTRAINT world_claims_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT world_claims_worldline_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id)
    REFERENCES worldlines (workspace_id, world_id, id) ON DELETE CASCADE,
  CONSTRAINT world_claims_subject_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, subject_entity_id)
    REFERENCES world_entities (workspace_id, world_id, worldline_id, id),
  CONSTRAINT world_claims_supersedes_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, supersedes_claim_id)
    REFERENCES world_claims (workspace_id, world_id, worldline_id, id),
  CONSTRAINT world_claims_scope_check
    CHECK (scope IN ('record', 'story', 'world')),
  CONSTRAINT world_claims_truth_check
    CHECK (truth_status IN (
      'mentioned', 'record_confirmed', 'story_canon', 'world_canon',
      'rumor', 'hypothesis', 'disputed', 'deprecated'
    )),
  CHECK (confidence >= 0.0 AND confidence <= 1.0),
  CHECK (length(btrim(predicate)) > 0),
  CHECK (valid_from_tick >= 0),
  CHECK (valid_to_tick IS NULL OR valid_to_tick >= valid_from_tick)
);

CREATE INDEX IF NOT EXISTS world_claims_scope_status_idx
  ON world_claims (
    workspace_id,
    worldline_id,
    subject_entity_id,
    truth_status,
    valid_from_tick
  );

CREATE OR REPLACE FUNCTION guard_world_claim_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'world claims are append-only; append a superseding claim';
END;
$$;

DROP TRIGGER IF EXISTS world_claims_append_only_guard ON world_claims;
CREATE TRIGGER world_claims_append_only_guard
BEFORE UPDATE OR DELETE ON world_claims
FOR EACH ROW
EXECUTE FUNCTION guard_world_claim_append_only();

CREATE TABLE IF NOT EXISTS world_relations (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  id text NOT NULL,
  subject_entity_id text NOT NULL,
  predicate text NOT NULL,
  object_entity_id text NOT NULL,
  source_claim_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (
    workspace_id,
    worldline_id,
    subject_entity_id,
    predicate,
    object_entity_id,
    source_claim_id
  ),
  CONSTRAINT world_relations_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT world_relations_claim_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, source_claim_id)
    REFERENCES world_claims (workspace_id, world_id, worldline_id, id),
  CHECK (length(btrim(predicate)) > 0)
);

CREATE TABLE IF NOT EXISTS world_articles (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  id text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  claim_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  source_event_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, world_id, worldline_id, id),
  CONSTRAINT world_articles_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT world_articles_worldline_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id)
    REFERENCES worldlines (workspace_id, world_id, id) ON DELETE CASCADE,
  CHECK (length(btrim(title)) > 0),
  CHECK (length(btrim(body)) > 0),
  CHECK (array_position(claim_ids, NULL) IS NULL),
  CHECK (array_position(source_event_ids, NULL) IS NULL)
);

CREATE TABLE IF NOT EXISTS causal_edges (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  id text NOT NULL,
  from_claim_id text NOT NULL,
  to_claim_id text NOT NULL,
  edge_kind text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, worldline_id, from_claim_id, to_claim_id, edge_kind),
  CONSTRAINT causal_edges_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT causal_edges_worldline_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id)
    REFERENCES worldlines (workspace_id, world_id, id) ON DELETE CASCADE,
  CONSTRAINT causal_edges_kind_check
    CHECK (edge_kind IN ('enables', 'contradicts', 'supersedes', 'context'))
);

CREATE TABLE IF NOT EXISTS canon_proposals (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  id text NOT NULL,
  target_level text NOT NULL,
  article_id text,
  claim_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  rationale text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending',
  proposed_by text NOT NULL DEFAULT 'dm',
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, world_id, worldline_id, id),
  CONSTRAINT canon_proposals_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT canon_proposals_worldline_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id)
    REFERENCES worldlines (workspace_id, world_id, id) ON DELETE CASCADE,
  CONSTRAINT canon_proposals_level_check
    CHECK (target_level IN ('story', 'worldline')),
  CONSTRAINT canon_proposals_status_check
    CHECK (status IN ('pending', 'merged', 'rejected', 'deferred')),
  CONSTRAINT canon_proposals_decision_shape_check CHECK (
    (status = 'pending' AND decided_by IS NULL AND decided_at IS NULL)
    OR (status IN ('merged', 'rejected', 'deferred')
      AND decided_by IS NOT NULL AND decided_at IS NOT NULL)
  ),
  CHECK (array_position(claim_ids, NULL) IS NULL)
);

CREATE TABLE IF NOT EXISTS canon_revisions (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  id text NOT NULL,
  parent_revision_id text,
  effective_tick bigint NOT NULL,
  effective_ordinal bigint NOT NULL,
  accepted_proposal_id text NOT NULL,
  content_hash text NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, world_id, worldline_id, id),
  CONSTRAINT canon_revisions_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT canon_revisions_worldline_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id)
    REFERENCES worldlines (workspace_id, world_id, id) ON DELETE CASCADE,
  CONSTRAINT canon_revisions_proposal_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, accepted_proposal_id)
    REFERENCES canon_proposals (workspace_id, world_id, worldline_id, id),
  CHECK (effective_tick >= 0 AND effective_ordinal >= 0),
  CHECK (length(btrim(content_hash)) > 0)
);

CREATE OR REPLACE FUNCTION guard_canon_revision_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'canon revisions are immutable';
END;
$$;

DROP TRIGGER IF EXISTS canon_revisions_append_only_guard ON canon_revisions;
CREATE TRIGGER canon_revisions_append_only_guard
BEFORE UPDATE OR DELETE ON canon_revisions
FOR EACH ROW
EXECUTE FUNCTION guard_canon_revision_append_only();

CREATE TABLE IF NOT EXISTS information_campaigns (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  id text NOT NULL,
  root_claim_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  effective_tick bigint NOT NULL,
  salience numeric(5, 4) NOT NULL DEFAULT 0.5,
  complexity numeric(5, 4) NOT NULL DEFAULT 0.5,
  security_class text NOT NULL DEFAULT 'public',
  algorithm_version text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, world_id, worldline_id, id),
  CONSTRAINT information_campaigns_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT information_campaigns_worldline_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id)
    REFERENCES worldlines (workspace_id, world_id, id) ON DELETE CASCADE,
  CONSTRAINT information_campaigns_security_check
    CHECK (security_class IN ('public', 'restricted', 'secret')),
  CHECK (salience >= 0.0 AND salience <= 1.0),
  CHECK (complexity >= 0.0 AND complexity <= 1.0),
  CHECK (effective_tick >= 0),
  CHECK (length(btrim(algorithm_version)) > 0),
  CHECK (array_position(root_claim_ids, NULL) IS NULL)
);

CREATE TABLE IF NOT EXISTS information_packets (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  id text NOT NULL,
  campaign_id text NOT NULL,
  parent_packet_id text,
  channel text NOT NULL,
  claim_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  framing text NOT NULL DEFAULT 'neutral',
  omitted_claim_ids text[] NOT NULL DEFAULT ARRAY[]::text[],
  semantic_fidelity_to_parent numeric(5, 4) NOT NULL DEFAULT 1.0,
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, world_id, worldline_id, id),
  CONSTRAINT information_packets_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT information_packets_campaign_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, campaign_id)
    REFERENCES information_campaigns (workspace_id, world_id, worldline_id, id),
  CONSTRAINT information_packets_parent_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, parent_packet_id)
    REFERENCES information_packets (workspace_id, world_id, worldline_id, id),
  CONSTRAINT information_packets_channel_check
    CHECK (channel IN ('official_bulletin', 'private_letter', 'market_rumor')),
  CHECK (semantic_fidelity_to_parent >= 0.0 AND semantic_fidelity_to_parent <= 1.0),
  CHECK (length(btrim(content_hash)) > 0),
  CHECK (array_position(claim_ids, NULL) IS NULL)
);

CREATE OR REPLACE FUNCTION guard_information_packet_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'information packets are immutable; distortions create child packets';
END;
$$;

DROP TRIGGER IF EXISTS information_packets_append_only_guard ON information_packets;
CREATE TRIGGER information_packets_append_only_guard
BEFORE UPDATE OR DELETE ON information_packets
FOR EACH ROW
EXECUTE FUNCTION guard_information_packet_append_only();

CREATE TABLE IF NOT EXISTS propagation_exposures (
  workspace_id text NOT NULL,
  world_id text NOT NULL,
  worldline_id text NOT NULL,
  id text NOT NULL,
  campaign_id text NOT NULL,
  packet_id text NOT NULL,
  node_key text NOT NULL,
  channel text NOT NULL,
  arrival_tick bigint NOT NULL,
  fidelity numeric(5, 4) NOT NULL,
  algorithm_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, campaign_id, node_key, packet_id),
  CONSTRAINT propagation_exposures_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT propagation_exposures_packet_fk
    FOREIGN KEY (workspace_id, world_id, worldline_id, packet_id)
    REFERENCES information_packets (workspace_id, world_id, worldline_id, id),
  CHECK (arrival_tick >= 0),
  CHECK (fidelity >= 0.0 AND fidelity <= 1.0),
  CHECK (length(btrim(node_key)) > 0)
);

ALTER TABLE world_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE world_entities FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON world_entities;
CREATE POLICY realm_workspace_isolation ON world_entities
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

ALTER TABLE world_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE world_claims FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON world_claims;
CREATE POLICY realm_workspace_isolation ON world_claims
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

ALTER TABLE world_relations ENABLE ROW LEVEL SECURITY;
ALTER TABLE world_relations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON world_relations;
CREATE POLICY realm_workspace_isolation ON world_relations
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

ALTER TABLE world_articles ENABLE ROW LEVEL SECURITY;
ALTER TABLE world_articles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON world_articles;
CREATE POLICY realm_workspace_isolation ON world_articles
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

ALTER TABLE causal_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE causal_edges FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON causal_edges;
CREATE POLICY realm_workspace_isolation ON causal_edges
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

ALTER TABLE canon_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE canon_proposals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON canon_proposals;
CREATE POLICY realm_workspace_isolation ON canon_proposals
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

ALTER TABLE canon_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE canon_revisions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON canon_revisions;
CREATE POLICY realm_workspace_isolation ON canon_revisions
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

ALTER TABLE information_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE information_campaigns FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON information_campaigns;
CREATE POLICY realm_workspace_isolation ON information_campaigns
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

ALTER TABLE information_packets ENABLE ROW LEVEL SECURITY;
ALTER TABLE information_packets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON information_packets;
CREATE POLICY realm_workspace_isolation ON information_packets
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

ALTER TABLE propagation_exposures ENABLE ROW LEVEL SECURITY;
ALTER TABLE propagation_exposures FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON propagation_exposures;
CREATE POLICY realm_workspace_isolation ON propagation_exposures
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

GRANT SELECT, INSERT, UPDATE ON world_entities TO realm_runtime;
GRANT SELECT, INSERT ON world_claims TO realm_runtime;
GRANT SELECT, INSERT ON world_relations TO realm_runtime;
GRANT SELECT, INSERT ON world_articles TO realm_runtime;
GRANT SELECT, INSERT ON causal_edges TO realm_runtime;
GRANT SELECT, INSERT, UPDATE ON canon_proposals TO realm_runtime;
GRANT SELECT, INSERT ON canon_revisions TO realm_runtime;
GRANT SELECT, INSERT ON information_campaigns TO realm_runtime;
GRANT SELECT, INSERT ON information_packets TO realm_runtime;
GRANT SELECT, INSERT ON propagation_exposures TO realm_runtime;

COMMENT ON TABLE world_claims IS
  'Append-only minimal fact assertions; supersession appends a new claim.';
COMMENT ON TABLE canon_revisions IS
  'Immutable worldline canon versions; old Records keep replaying against their original revision.';
COMMENT ON TABLE information_packets IS
  'Immutable in-transit information packets with lineage; distortions create child packets.';
