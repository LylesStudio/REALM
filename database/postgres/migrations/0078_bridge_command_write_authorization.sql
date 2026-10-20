-- SOURCE ONLY candidate. Requires 0053's existing capability role/column grant.
-- Identity uses the existing server-resolved-principal boundary of
-- membership_assert_world_owner; this read/lock function grants no membership.
CREATE FUNCTION public.bridge_command_membership_role(
  p_workspace_id text, p_world_id text, p_principal_id text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_role text;
BEGIN
  IF p_workspace_id IS NULL OR p_workspace_id IS DISTINCT FROM
    current_setting('realm.workspace_id', true) THEN
    RAISE EXCEPTION 'WORKSPACE_SCOPE_MISMATCH';
  END IF;
  IF p_world_id IS NULL OR p_principal_id IS NULL OR btrim(p_principal_id) = '' THEN
    RAISE EXCEPTION 'COMMAND_PRINCIPAL_REQUIRED';
  END IF;
  SELECT membership.role INTO v_role
  FROM public.player_world_memberships AS membership
  WHERE membership.workspace_id = p_workspace_id
    AND membership.world_id = p_world_id
    AND membership.principal_id = p_principal_id
  FOR SHARE;
  RETURN v_role;
END;
$$;
ALTER FUNCTION public.bridge_command_membership_role(text, text, text) OWNER TO realm_capability;
REVOKE ALL ON FUNCTION public.bridge_command_membership_role(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bridge_command_membership_role(text, text, text) TO realm_runtime;
COMMENT ON FUNCTION public.bridge_command_membership_role(text, text, text) IS
  'Internal server-principal boundary; workspace-guarded read/lock only. Caller locks World before this function and worldline after it, in the command outer transaction.';
