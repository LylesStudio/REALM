-- REALM T11-I-A owner mapping product surface.
-- The web/runtime role never receives direct INSERT on the governance table.
-- It receives only this single, scope-bound SECURITY DEFINER append operation;
-- every authorization and active-state check remains inside the database.

CREATE OR REPLACE FUNCTION append_propagation_node_audience(
  p_workspace_id text,
  p_world_id text,
  p_worldline_id text,
  p_node_key text,
  p_continuity_id text,
  p_principal_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  node_exists boolean;
  continuity_exists boolean;
  owner_exists boolean;
BEGIN
  IF p_workspace_id IS NULL OR p_world_id IS NULL OR p_worldline_id IS NULL
     OR p_node_key IS NULL OR p_continuity_id IS NULL OR p_principal_id IS NULL
     OR btrim(p_workspace_id) = '' OR btrim(p_world_id) = ''
     OR btrim(p_worldline_id) = '' OR btrim(p_node_key) = ''
     OR btrim(p_continuity_id) = '' OR btrim(p_principal_id) = '' THEN
    RAISE EXCEPTION 'PROPAGATION_AUDIENCE_INVALID_INPUT';
  END IF;

  IF realm_current_workspace_id() IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'PROPAGATION_AUDIENCE_SCOPE_REQUIRED';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM player_world_memberships AS membership
    WHERE membership.workspace_id = p_workspace_id
      AND membership.world_id = p_world_id
      AND membership.principal_id = p_principal_id
      AND membership.role = 'owner'
  ) INTO owner_exists;
  IF NOT owner_exists THEN
    RAISE EXCEPTION 'PROPAGATION_AUDIENCE_OWNER_REQUIRED';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM propagation_nodes AS node
    WHERE node.workspace_id = p_workspace_id
      AND node.world_id = p_world_id
      AND node.worldline_id = p_worldline_id
      AND node.node_key = p_node_key
      AND node.active = TRUE
  ) INTO node_exists;
  IF NOT node_exists THEN
    IF EXISTS (
      SELECT 1
      FROM propagation_nodes AS node
      WHERE node.workspace_id = p_workspace_id
        AND node.world_id = p_world_id
        AND node.worldline_id = p_worldline_id
        AND node.node_key = p_node_key
    ) THEN
      RAISE EXCEPTION 'PROPAGATION_AUDIENCE_NODE_INACTIVE';
    END IF;
    RAISE EXCEPTION 'PROPAGATION_AUDIENCE_NODE_NOT_FOUND';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM character_continuities AS continuity
    WHERE continuity.workspace_id = p_workspace_id
      AND continuity.world_id = p_world_id
      AND continuity.worldline_id = p_worldline_id
      AND continuity.id = p_continuity_id
      AND continuity.status = 'active'
  ) INTO continuity_exists;
  IF NOT continuity_exists THEN
    IF EXISTS (
      SELECT 1
      FROM character_continuities AS continuity
      WHERE continuity.workspace_id = p_workspace_id
        AND continuity.world_id = p_world_id
        AND continuity.worldline_id = p_worldline_id
        AND continuity.id = p_continuity_id
    ) THEN
      RAISE EXCEPTION 'PROPAGATION_AUDIENCE_CONTINUITY_INACTIVE';
    END IF;
    RAISE EXCEPTION 'PROPAGATION_AUDIENCE_CONTINUITY_NOT_FOUND';
  END IF;

  INSERT INTO propagation_node_audiences (
    workspace_id,
    world_id,
    worldline_id,
    node_key,
    continuity_id
  ) VALUES (
    p_workspace_id,
    p_world_id,
    p_worldline_id,
    p_node_key,
    p_continuity_id
  ) ON CONFLICT DO NOTHING;

  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION append_propagation_node_audience(
  text, text, text, text, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION append_propagation_node_audience(
  text, text, text, text, text, text
) TO realm_runtime;

COMMENT ON FUNCTION append_propagation_node_audience(
  text, text, text, text, text, text
) IS
  'T11-I-A owner-checked, append-only node-to-continuity mapping operation; realm_runtime has EXECUTE but no direct table write privilege.';
