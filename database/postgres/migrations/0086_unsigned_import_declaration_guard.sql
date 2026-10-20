-- A1: unsigned .realm snapshots carry data, not declaration capabilities.
-- Replaces only the existing bootstrap body; no new roles, grants, tables or data rewrites.
-- CREATE OR REPLACE retains function ownership and permissions:
-- https://www.postgresql.org/docs/17/sql-createfunction.html
-- JSON text decoding and top-level key checks:
-- https://www.postgresql.org/docs/17/functions-json.html
DO $unsigned_import_guard_precondition$
BEGIN
  IF to_regprocedure('public.realm_import_begin_bootstrap(text,text,bigint,text,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'unsigned import guard requires the existing 0042 bootstrap function';
  END IF;
END;
$unsigned_import_guard_precondition$;

CREATE OR REPLACE FUNCTION realm_import_begin_bootstrap(
  p_workspace_id text,
  p_job_id text,
  p_attempt_no bigint,
  p_world_id text,
  p_world_row jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $realm_import_begin_bootstrap$
DECLARE
  job_operator text;
  worlds_digest text;
  writable_cols text;
  writable_select_cols text;
  settings_doc jsonb;
BEGIN
  IF realm_current_workspace_id() IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'workspace context mismatch';
  END IF;
  SELECT operator_principal INTO job_operator
  FROM realm_import_jobs
  WHERE workspace_id = p_workspace_id AND id = p_job_id
    AND status = 'executing' AND direction = 'import'
    AND current_attempt_no = p_attempt_no
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'realm import job not executing with attempt %: %', p_attempt_no, p_job_id;
  END IF;
  -- Unsigned snapshot metadata cannot mint declaration authority. Check after job
  -- authentication, before cleanup or any target/content/membership/ledger writes.
  -- Codec uses encoded JSON text; also reject a directly supplied JSON object.
  IF jsonb_typeof(p_world_row) = 'object' AND p_world_row ? 'settings' THEN
    settings_doc := CASE WHEN jsonb_typeof(p_world_row -> 'settings') = 'string'
      THEN (p_world_row ->> 'settings')::jsonb ELSE p_world_row -> 'settings' END;
    IF jsonb_typeof(settings_doc) = 'object' AND settings_doc ? 'declaredEvents' THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'IMPORT_DECLARATION_METADATA_UNTRUSTED';
    END IF;
  END IF;
  -- 孤儿清理（C3：新 attempt 首句清除误拆分提交的旧 tx 残留；正常路径无操作）
  PERFORM realm_import_cleanup_orphans(p_workspace_id, p_job_id);
  PERFORM 1 FROM worlds WHERE workspace_id = p_workspace_id AND id = p_world_id;
  IF FOUND THEN
    RAISE EXCEPTION 'bootstrap world already exists: %', p_world_id;
  END IF;
  -- worlds 行：完整键集 + 键集双向等值 + tenant/id/status 断言（status 由 service 重写为
  -- active 并记 redaction；函数断言最终值——archive 世界只读封存不经导入恢复）
  IF jsonb_typeof(p_world_row) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'bootstrap world row must be a jsonb object';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_object_keys(p_world_row) AS k
    WHERE k NOT IN (
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'worlds'
        AND is_generated = 'NEVER' AND is_identity = 'NO'
    )
  ) OR EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'worlds'
      AND is_generated = 'NEVER' AND is_identity = 'NO'
      AND column_name NOT IN (SELECT k FROM jsonb_object_keys(p_world_row) AS k)
  ) THEN
    RAISE EXCEPTION 'bootstrap world row key set mismatch';
  END IF;
  IF (p_world_row ->> 'workspace_id') IS DISTINCT FROM p_workspace_id
    OR (p_world_row ->> 'id') IS DISTINCT FROM p_world_id
    OR (p_world_row ->> 'status') IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'bootstrap world row tenant/id/status mismatch';
  END IF;
  -- 显式可写列列表（C4：与 insert_rows 同一可写列查询，消除 SELECT * 旁路）
  SELECT string_agg(format('%I', column_name), ', ' ORDER BY ordinal_position)
  INTO writable_cols
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'worlds'
    AND is_generated = 'NEVER' AND is_identity = 'NO';
  -- jsonb 列：populate_recordset 把 JSON 字符串按标量落 jsonb（PG17 实测）
  -- ——经 (#>> '{}')::jsonb 重解析为真实 jsonb 值（codec 契约不变）。
  SELECT string_agg(
      CASE WHEN data_type IN ('jsonb', 'json')
        THEN format('(%I #>> ''{}'')::jsonb AS %I', column_name, column_name)
        ELSE format('%I', column_name)
      END, ', ' ORDER BY ordinal_position)
  INTO writable_select_cols
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'worlds'
    AND is_generated = 'NEVER' AND is_identity = 'NO';
  EXECUTE format(
    'INSERT INTO worlds (%s) SELECT %s FROM jsonb_populate_record(NULL::worlds, $1)',
    writable_cols, writable_select_cols)
  USING p_world_row;
  -- worlds 条目 wire digest = tableWireDigest([world_row])（与 ledger worlds 条目同一规则）
  worlds_digest := encode(digest(
    encode(digest(realm_import_canonical_row(p_world_row), 'sha256'), 'hex') || E'\n',
    'sha256'), 'hex');
  INSERT INTO realm_import_bootstrap (
    workspace_id, job_id, attempt_no, world_id, operator_principal, tx_id, worlds_wire_digest
  ) VALUES (
    p_workspace_id, p_job_id, p_attempt_no, p_world_id, job_operator,
    txid_current(), worlds_digest
  );
  -- worlds 是 bootstrap-owned 内容行（C1 方案一）：同 tx2 写入唯一 actual ledger，
  -- complete 的 expected↔actual 与 contentDigest 因此覆盖 worlds，无例外列
  INSERT INTO realm_import_content_log (
    workspace_id, job_id, attempt_no, table_name, row_count, wire_digest
  ) VALUES (
    p_workspace_id, p_job_id, p_attempt_no, 'worlds', 1, worlds_digest
  );
  INSERT INTO player_world_memberships (
    workspace_id, world_id, principal_id, role,
    omniscient_player_character, can_view_dynamic_knowledge
  ) VALUES (p_workspace_id, p_world_id, job_operator, 'owner', true, true)
  ON CONFLICT (workspace_id, world_id, principal_id) DO NOTHING;
END;
$realm_import_begin_bootstrap$;
