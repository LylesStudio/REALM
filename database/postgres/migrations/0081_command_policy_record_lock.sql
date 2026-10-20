-- PostgreSQL row locks require UPDATE on a column of every locked relation.
-- Keep realm_runtime writes unchanged; expose only exact scoped read/lock SQL.
-- https://www.postgresql.org/docs/17/sql-select.html
-- https://www.postgresql.org/docs/17/sql-createfunction.html#SQL-CREATEFUNCTION-SECURITY
DO $policy_lock_role$
DECLARE
  existing_role pg_catalog.pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO existing_role FROM pg_catalog.pg_roles
    WHERE rolname = 'realm_command_policy_locker';
  IF FOUND THEN
    -- Roles are cluster-wide: a second database may already have this owner.
    -- Refuse an unrelated or escalated role rather than silently adopting it.
    IF existing_role.rolcanlogin OR existing_role.rolsuper OR existing_role.rolcreatedb
      OR existing_role.rolcreaterole OR existing_role.rolinherit
      OR existing_role.rolreplication OR existing_role.rolbypassrls
      OR existing_role.rolconfig IS NOT NULL
      OR pg_catalog.shobj_description(existing_role.oid, 'pg_authid') IS DISTINCT FROM
        'REALM internal command policy lock owner v1'
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members
        WHERE roleid = existing_role.oid OR member = existing_role.oid) THEN
      RAISE EXCEPTION 'COMMAND_POLICY_LOCK_ROLE_UNSAFE';
    END IF;
  ELSE
    CREATE ROLE realm_command_policy_locker NOLOGIN NOSUPERUSER NOCREATEDB
      NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
    COMMENT ON ROLE realm_command_policy_locker IS 'REALM internal command policy lock owner v1';
  END IF;
END;
$policy_lock_role$;

GRANT USAGE ON SCHEMA public TO realm_command_policy_locker;
GRANT SELECT (workspace_id, world_id, worldline_id, id, story_id, status, world_version)
  ON public.records TO realm_command_policy_locker;
GRANT SELECT (workspace_id, world_id, worldline_id, id, status)
  ON public.stories TO realm_command_policy_locker;
GRANT SELECT (workspace_id, world_id, worldline_id, story_id, project_id, link_kind)
  ON public.project_story_links TO realm_command_policy_locker;
GRANT UPDATE (updated_at) ON public.records, public.stories TO realm_command_policy_locker;

CREATE FUNCTION public.command_policy_record_version_locked(
  p_workspace_id text, p_world_id text, p_worldline_id text,
  p_record_id text, p_story_id text, p_project_id text
) RETURNS TABLE (world_version text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = on
AS $$
BEGIN
  IF p_workspace_id IS NULL OR p_workspace_id = '' OR p_workspace_id IS DISTINCT FROM
    pg_catalog.current_setting('realm.workspace_id', true) THEN
    RAISE EXCEPTION 'WORKSPACE_SCOPE_MISMATCH';
  END IF;
  RETURN QUERY SELECT r.world_version FROM public.records AS r
    JOIN public.stories AS s ON s.workspace_id = r.workspace_id AND s.world_id = r.world_id AND s.worldline_id = r.worldline_id AND s.id = r.story_id
    JOIN public.project_story_links AS l ON l.workspace_id = r.workspace_id AND l.world_id = r.world_id AND l.worldline_id = r.worldline_id AND l.story_id = r.story_id AND l.project_id = p_project_id AND l.link_kind = 'primary'
    WHERE r.workspace_id = p_workspace_id AND r.world_id = p_world_id AND r.worldline_id = p_worldline_id AND r.id = p_record_id AND r.story_id = p_story_id
      AND r.status <> 'archived' AND s.status <> 'archived' FOR SHARE OF r, s;
END;
$$;
ALTER FUNCTION public.command_policy_record_version_locked(text,text,text,text,text,text)
  OWNER TO realm_command_policy_locker;
REVOKE ALL ON FUNCTION public.command_policy_record_version_locked(text,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.command_policy_record_version_locked(text,text,text,text,text,text) TO realm_runtime;
COMMENT ON FUNCTION public.command_policy_record_version_locked(text,text,text,text,text,text) IS
  'Internal workspace-RLS-preserving exact Record/Story/primary Project relation read/lock; no state write, membership grant, signed policy authority or public route authorization.';
