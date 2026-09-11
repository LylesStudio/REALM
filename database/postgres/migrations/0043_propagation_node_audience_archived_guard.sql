-- ============================================================
-- 0043_propagation_node_audience_archived_guard.sql（完整最终 SQL；C4）
-- 由 scripts/postgres-migrate.mjs per-file transaction 包裹；本文件不含事务控制语句
-- 0028 文件与其台账行零改动；本文件 CREATE OR REPLACE 同签名函数
-- ============================================================

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
SET search_path = pg_catalog, public, pg_temp
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

  -- archived gate（0043 新增；gateWorldWrite 同形：worlds FOR KEY SHARE + active 断言。
  -- 锁形为 KEY SHARE 而非 FOR UPDATE——worlds 行单锁点教条：仅归档命令取 FOR UPDATE；
  -- 归档 FOR UPDATE 与本锁互斥，active→archive / append→commit 双向 barrier 成立）
  PERFORM 1
  FROM worlds
  WHERE workspace_id = p_workspace_id
    AND id = p_world_id
    AND status = 'active'
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PROPAGATION_AUDIENCE_WORLD_ARCHIVED';
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
) FROM PUBLIC, realm_runtime, realm_control, realm_transfer;
GRANT EXECUTE ON FUNCTION append_propagation_node_audience(
  text, text, text, text, text, text
) TO realm_runtime;

-- direct mutation 自包含闭合（C3②：不依赖 0027 历史 ACL 偶然；realm_runtime 保留既有 SELECT——0027:38）
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON propagation_node_audiences
  FROM PUBLIC, realm_runtime, realm_control, realm_transfer;

-- 列级 mutation 自包含闭合（C2③：逐列 INSERT/UPDATE/REFERENCES——保留 runtime SELECT）
DO $realm_audience_column_lockdown$
DECLARE
  audience_column text;
BEGIN
  FOR audience_column IN
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'propagation_node_audiences'
  LOOP
    EXECUTE format(
      'REVOKE INSERT (%I), UPDATE (%I), REFERENCES (%I) ON TABLE public.propagation_node_audiences FROM PUBLIC, realm_runtime, realm_control, realm_transfer',
      audience_column, audience_column, audience_column);
  END LOOP;
END;
$realm_audience_column_lockdown$;

COMMENT ON FUNCTION append_propagation_node_audience(
  text, text, text, text, text, text
) IS
  'T11-I-A owner-checked, append-only node-to-continuity mapping operation; 0043 adds archived-world gate (worlds FOR KEY SHARE + active assertion) inside the database; realm_runtime has EXECUTE but no direct table write privilege.';

-- ============================== 提交前 ACL gate（0043 尾部；与 0042 全文同构 + 终态形态断言） ==============================
DO $realm_audience_acl_gate$
DECLARE
  closure_role text;
  ledger_table text;
  ledger_column text;
  func_sig text;
  func_owner text;
  v_worlds_owner text;
  bad_grant RECORD;
BEGIN
  -- 0. worlds owner（同 0042；NULL fail-closed）
  IF NOT EXISTS (
    SELECT 1 FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'worlds'
  ) THEN
    RAISE EXCEPTION 'expected relation missing: public.worlds';
  END IF;
  SELECT c.relowner::regrole::text INTO v_worlds_owner
  FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'worlds';
  IF v_worlds_owner IS NULL THEN
    RAISE EXCEPTION 'worlds owner could not be determined';
  END IF;

  -- A. 应用组件对 5 ledger + 0043 目标的 schema/database/table/column 权限（同构 0042）
  FOR closure_role IN
    WITH RECURSIVE app_component AS (
      SELECT oid FROM pg_roles
      WHERE rolname IN ('realm_runtime', 'realm_transfer', 'realm_control')
      UNION
      -- 双向 connected component（member→roleid ∪ roleid→member，循环安全）：
      -- PG 递归 CTE 只允许单一自引用，两向展开合入同一递归项（语义不变）。
      SELECT CASE WHEN m.member = a.oid THEN m.roleid ELSE m.member END
      FROM pg_auth_members AS m
      JOIN app_component AS a ON m.member = a.oid OR m.roleid = a.oid
    )
    SELECT r.rolname FROM app_component JOIN pg_roles AS r ON r.oid = app_component.oid
  LOOP
    IF has_schema_privilege(closure_role, 'public', 'CREATE') THEN
      RAISE EXCEPTION 'acl gate: % still has CREATE on public schema', closure_role;
    END IF;
    IF has_database_privilege(closure_role, current_database(), 'TEMPORARY') THEN
      RAISE EXCEPTION 'acl gate: % still has TEMPORARY on database', closure_role;
    END IF;
    FOREACH ledger_table IN ARRAY ARRAY[
      'realm_import_jobs', 'realm_import_job_events', 'realm_import_bootstrap',
      'realm_import_content_log', 'realm_import_pack_tables',
      'propagation_node_audiences']
    LOOP
      IF has_table_privilege(closure_role, 'public.' || ledger_table, 'INSERT')
        OR has_table_privilege(closure_role, 'public.' || ledger_table, 'UPDATE')
        OR has_table_privilege(closure_role, 'public.' || ledger_table, 'DELETE')
        OR has_table_privilege(closure_role, 'public.' || ledger_table, 'TRUNCATE')
        OR has_table_privilege(closure_role, 'public.' || ledger_table, 'REFERENCES')
        OR has_table_privilege(closure_role, 'public.' || ledger_table, 'TRIGGER') THEN
        RAISE EXCEPTION 'acl gate: % still has table mutation on %', closure_role, ledger_table;
      END IF;
      FOR ledger_column IN
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ledger_table
      LOOP
        IF has_column_privilege(closure_role, 'public.' || ledger_table, ledger_column, 'INSERT')
          OR has_column_privilege(closure_role, 'public.' || ledger_table, ledger_column, 'UPDATE')
          OR has_column_privilege(closure_role, 'public.' || ledger_table, ledger_column, 'REFERENCES') THEN
          RAISE EXCEPTION 'acl gate: % still has column mutation on %.%',
            closure_role, ledger_table, ledger_column;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;

  -- B1. 双表 ACL allowlist（ledger 仅 {realm_transfer: SELECT}；目标仅 {realm_runtime: SELECT}）
  FOR bad_grant IN
    SELECT c.relname AS t, acl.grantee::regrole::text AS g, acl.privilege_type AS p
    FROM pg_class AS c
    JOIN pg_namespace AS n ON n.oid = c.relnamespace,
    aclexplode(c.relacl) AS acl
    WHERE n.nspname = 'public'
      AND c.relname IN (
        'realm_import_jobs', 'realm_import_job_events', 'realm_import_bootstrap',
        'realm_import_content_log', 'realm_import_pack_tables')
      AND NOT (acl.grantee::regrole::text = 'realm_transfer' AND acl.privilege_type = 'SELECT')
      -- owner 隐含权限的物化条目（REVOKE 在 NULL acl 上实例化默认 ACL）不是 grant——排除
      AND NOT (acl.grantee = c.relowner AND acl.grantor = c.relowner)
  LOOP
    RAISE EXCEPTION 'acl gate: unexpected grant % on % to %', bad_grant.p, bad_grant.t, bad_grant.g;
  END LOOP;
  FOR bad_grant IN
    SELECT acl.grantee::regrole::text AS g, acl.privilege_type AS p
    FROM pg_class AS c
    JOIN pg_namespace AS n ON n.oid = c.relnamespace,
    aclexplode(c.relacl) AS acl
    WHERE n.nspname = 'public' AND c.relname = 'propagation_node_audiences'
      AND NOT (acl.grantee::regrole::text = 'realm_runtime' AND acl.privilege_type = 'SELECT')
      -- realm_transfer 的 SELECT 来自 0042 内容表导出授权（propagation_node_audiences
      -- 属 42 内容表）——允许；mutation 一律拒绝
      AND NOT (acl.grantee::regrole::text = 'realm_transfer' AND acl.privilege_type = 'SELECT')
      -- owner 物化条目（REVOKE 实例化默认 ACL）不是 grant——排除
      AND NOT (acl.grantee = c.relowner AND acl.grantor = c.relowner)
  LOOP
    RAISE EXCEPTION 'acl gate: unexpected grant % on propagation_node_audiences to %',
      bad_grant.p, bad_grant.g;
  END LOOP;

  -- B2. schema/database 显式 ACL allowlist（同构 0042）
  IF EXISTS (
    SELECT 1 FROM pg_namespace AS n, aclexplode(n.nspacl) AS acl
    WHERE n.nspname = 'public' AND acl.privilege_type = 'CREATE'
      -- schema owner 的固有 CREATE 不是 grant——排除（PG15+ nspacl 默认物化）
      AND acl.grantee <> n.nspowner
  ) THEN
    RAISE EXCEPTION 'acl gate: CREATE grant remains on public schema';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_database AS d, aclexplode(d.datacl) AS acl
    WHERE d.datname = current_database()
      AND acl.privilege_type IN ('TEMPORARY', 'CREATE')
      -- database owner 的固有权限不是 grant——排除（REVOKE 物化默认 ACL）
      AND acl.grantee <> d.datdba
  ) THEN
    RAISE EXCEPTION 'acl gate: TEMPORARY/CREATE grant remains on database';
  END IF;

  -- C1. 函数存在性 / proacl / proowner（23 签名冻结；同构 0042）
  FOREACH func_sig IN ARRAY ARRAY[
    'realm_import_job_create(text,text,text,text,text,text,text,text,text,text,text)',
    'realm_import_job_begin_validation(text,text)',
    'realm_import_register_pack_tables(text,text,jsonb)',
    'realm_import_job_finish_validation(text,text,text,text,text,jsonb)',
    'realm_import_job_begin_execute(text,text)',
    'realm_import_begin_bootstrap(text,text,bigint,text,jsonb)',
    'realm_import_insert_rows(text,text,bigint,text,jsonb)',
    'realm_import_content_digest(text,text,bigint)',
    'realm_import_job_complete_import(text,text,bigint,text,jsonb)',
    'realm_import_job_fail_execute(text,text,bigint,text,text)',
    'realm_import_job_cancel(text,text)',
    'realm_import_job_recover_crash(text,text,text)',
    'realm_import_job_complete_export(text,text,jsonb)',
    'realm_import_canonical_row(jsonb)',
    'realm_import_scope_allows(text,text)',
    'realm_import_scope_required(text)',
    'realm_import_cleanup_orphans(text,text)',
    'guard_realm_import_jobs_insert()',
    'guard_realm_import_job_events_insert()',
    'guard_realm_import_job_events_append_only()',
    'guard_realm_import_jobs_mutation()',
    'append_propagation_node_audience(text,text,text,text,text,text)']
  LOOP
    IF to_regprocedure(func_sig) IS NULL THEN
      RAISE EXCEPTION 'acl gate: missing function: %', func_sig;
    END IF;
    IF (SELECT p.proacl FROM pg_proc AS p WHERE p.oid = func_sig::regprocedure) IS NULL THEN
      RAISE EXCEPTION 'acl gate: % still has default PUBLIC EXECUTE', func_sig;
    END IF;
    SELECT p.proowner::regrole::text INTO func_owner
    FROM pg_proc AS p WHERE p.oid = func_sig::regprocedure;
    IF func_owner IS NULL THEN
      RAISE EXCEPTION 'acl gate: owner of % could not be determined', func_sig;
    END IF;
    IF func_owner IS DISTINCT FROM v_worlds_owner
      AND func_owner IS DISTINCT FROM current_user THEN
      RAISE EXCEPTION 'acl gate: owner of % is not in the trusted owner set: %', func_sig, func_owner;
    END IF;
    IF EXISTS (
      WITH RECURSIVE app_component AS (
        SELECT oid FROM pg_roles
        WHERE rolname IN ('realm_runtime', 'realm_transfer', 'realm_control')
        UNION
        -- 双向 connected component：PG 递归 CTE 只允许单一自引用，
        -- 两向展开合入同一递归项（member→roleid ∪ roleid→member，循环安全）。
        SELECT CASE WHEN m.member = a.oid THEN m.roleid ELSE m.member END
        FROM pg_auth_members AS m
        JOIN app_component AS a ON m.member = a.oid OR m.roleid = a.oid
      )
      SELECT 1 FROM app_component WHERE oid = func_owner::regrole
    ) THEN
      RAISE EXCEPTION 'acl gate: owner of % belongs to the application component', func_sig;
    END IF;
  END LOOP;

  -- C2. 函数 ACL 逐类 allowlist（13 受控仅 realm_transfer；8 内部零 grant；append 终态仅 realm_runtime）
  FOR bad_grant IN
    SELECT p.proname AS f, acl.grantee::regrole::text AS g
    FROM pg_proc AS p, aclexplode(p.proacl) AS acl
    WHERE p.oid = ANY (ARRAY[
      'realm_import_job_create(text,text,text,text,text,text,text,text,text,text,text)',
      'realm_import_job_begin_validation(text,text)',
      'realm_import_register_pack_tables(text,text,jsonb)',
      'realm_import_job_finish_validation(text,text,text,text,text,jsonb)',
      'realm_import_job_begin_execute(text,text)',
      'realm_import_begin_bootstrap(text,text,bigint,text,jsonb)',
      'realm_import_insert_rows(text,text,bigint,text,jsonb)',
      'realm_import_content_digest(text,text,bigint)',
      'realm_import_job_complete_import(text,text,bigint,text,jsonb)',
      'realm_import_job_fail_execute(text,text,bigint,text,text)',
      'realm_import_job_cancel(text,text)',
      'realm_import_job_recover_crash(text,text,text)',
      'realm_import_job_complete_export(text,text,jsonb)']::regprocedure[])
      AND acl.grantee::regrole::text <> 'realm_transfer'
      -- 函数 owner 的物化 EXECUTE（REVOKE 实例化默认 ACL）不是 grant——排除
      AND NOT (acl.grantee = p.proowner AND acl.grantor = p.proowner)
  LOOP
    RAISE EXCEPTION 'acl gate: unexpected EXECUTE on % to %', bad_grant.f, bad_grant.g;
  END LOOP;
  FOR bad_grant IN
    SELECT p.proname AS f, acl.grantee::regrole::text AS g
    FROM pg_proc AS p, aclexplode(p.proacl) AS acl
    WHERE p.oid = ANY (ARRAY[
      'realm_import_canonical_row(jsonb)',
      'realm_import_scope_allows(text,text)',
      'realm_import_scope_required(text)',
      'realm_import_cleanup_orphans(text,text)',
      'guard_realm_import_jobs_insert()',
      'guard_realm_import_job_events_insert()',
      'guard_realm_import_job_events_append_only()',
      'guard_realm_import_jobs_mutation()']::regprocedure[])
      -- 函数 owner 的物化 EXECUTE（REVOKE 在 NULL proacl 上实例化默认 ACL）不是 grant——排除
      AND NOT (acl.grantee = p.proowner AND acl.grantor = p.proowner)
  LOOP
    RAISE EXCEPTION 'acl gate: unexpected grant on internal function % to %',
      bad_grant.f, bad_grant.g;
  END LOOP;
  FOR bad_grant IN
    SELECT acl.grantee::regrole::text AS g
    FROM pg_proc AS p, aclexplode(p.proacl) AS acl
    WHERE p.oid = 'append_propagation_node_audience(text,text,text,text,text,text)'::regprocedure
      AND acl.grantee::regrole::text <> 'realm_runtime'
      -- 函数 owner 的物化 EXECUTE（REVOKE 实例化默认 ACL）不是 grant——排除
      AND NOT (acl.grantee = p.proowner AND acl.grantor = p.proowner)
  LOOP
    RAISE EXCEPTION 'acl gate: capability EXECUTE granted outside realm_runtime: %', bad_grant.g;
  END LOOP;

  -- C3. component × 函数 effective 互证（终态：transfer×13 与 runtime×append 豁免）
  FOR closure_role IN
    WITH RECURSIVE app_component AS (
      SELECT oid FROM pg_roles
      WHERE rolname IN ('realm_runtime', 'realm_transfer', 'realm_control')
      UNION
      -- 双向 connected component（member→roleid ∪ roleid→member，循环安全）：
      -- PG 递归 CTE 只允许单一自引用，两向展开合入同一递归项（语义不变）。
      SELECT CASE WHEN m.member = a.oid THEN m.roleid ELSE m.member END
      FROM pg_auth_members AS m
      JOIN app_component AS a ON m.member = a.oid OR m.roleid = a.oid
    )
    SELECT r.rolname FROM app_component JOIN pg_roles AS r ON r.oid = app_component.oid
  LOOP
    FOREACH func_sig IN ARRAY ARRAY[
      'realm_import_job_create(text,text,text,text,text,text,text,text,text,text,text)',
      'realm_import_job_begin_validation(text,text)',
      'realm_import_register_pack_tables(text,text,jsonb)',
      'realm_import_job_finish_validation(text,text,text,text,text,jsonb)',
      'realm_import_job_begin_execute(text,text)',
      'realm_import_begin_bootstrap(text,text,bigint,text,jsonb)',
      'realm_import_insert_rows(text,text,bigint,text,jsonb)',
      'realm_import_content_digest(text,text,bigint)',
      'realm_import_job_complete_import(text,text,bigint,text,jsonb)',
      'realm_import_job_fail_execute(text,text,bigint,text,text)',
      'realm_import_job_cancel(text,text)',
      'realm_import_job_recover_crash(text,text,text)',
      'realm_import_job_complete_export(text,text,jsonb)',
      'realm_import_canonical_row(jsonb)',
      'realm_import_scope_allows(text,text)',
      'realm_import_scope_required(text)',
      'realm_import_cleanup_orphans(text,text)',
      'guard_realm_import_jobs_insert()',
      'guard_realm_import_job_events_insert()',
      'guard_realm_import_job_events_append_only()',
      'guard_realm_import_jobs_mutation()',
      'append_propagation_node_audience(text,text,text,text,text,text)']
    LOOP
      IF has_function_privilege(closure_role, func_sig, 'EXECUTE')
        AND NOT (closure_role = 'realm_transfer' AND func_sig::text IN (
          'realm_import_job_create(text,text,text,text,text,text,text,text,text,text,text)',
          'realm_import_job_begin_validation(text,text)',
          'realm_import_register_pack_tables(text,text,jsonb)',
          'realm_import_job_finish_validation(text,text,text,text,text,jsonb)',
          'realm_import_job_begin_execute(text,text)',
          'realm_import_begin_bootstrap(text,text,bigint,text,jsonb)',
          'realm_import_insert_rows(text,text,bigint,text,jsonb)',
          'realm_import_content_digest(text,text,bigint)',
          'realm_import_job_complete_import(text,text,bigint,text,jsonb)',
          'realm_import_job_fail_execute(text,text,bigint,text,text)',
          'realm_import_job_cancel(text,text)',
          'realm_import_job_recover_crash(text,text,text)',
          'realm_import_job_complete_export(text,text,jsonb)'))
        AND NOT (closure_role = 'realm_runtime'
                 AND func_sig::text = 'append_propagation_node_audience(text,text,text,text,text,text)') THEN
        RAISE EXCEPTION 'acl gate: % has effective EXECUTE on %', closure_role, func_sig;
      END IF;
    END LOOP;
  END LOOP;

  -- D. default ACL（同构 0042——C3）
  IF EXISTS (
    WITH RECURSIVE app_component AS (
      SELECT oid FROM pg_roles
      WHERE rolname IN ('realm_runtime', 'realm_transfer', 'realm_control')
      UNION
      -- 双向 connected component（member→roleid ∪ roleid→member，循环安全）：
      -- PG 递归 CTE 只允许单一自引用，两向展开合入同一递归项（语义不变）。
      SELECT CASE WHEN m.member = a.oid THEN m.roleid ELSE m.member END
      FROM pg_auth_members AS m
      JOIN app_component AS a ON m.member = a.oid OR m.roleid = a.oid
    )
    SELECT 1
    FROM pg_default_acl AS d, aclexplode(d.defaclacl) AS acl, app_component AS ac
    WHERE (d.defaclrole = ac.oid OR acl.grantee = ac.oid OR acl.grantee = 0)
      AND acl.privilege_type IN (
        'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER',
        'EXECUTE', 'CREATE', 'TEMPORARY')
  ) THEN
    RAISE EXCEPTION 'acl gate: default ACL grants mutation/execute (component or PUBLIC)';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_default_acl AS d, aclexplode(d.defaclacl) AS acl
    WHERE d.defaclrole = current_user::regrole
      AND acl.privilege_type IN (
        'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER',
        'EXECUTE', 'CREATE', 'TEMPORARY')
  ) THEN
    RAISE EXCEPTION 'acl gate: default ACL grants mutation/execute on future objects (executor)';
  END IF;
END;
$realm_audience_acl_gate$;
