-- ============================================================
-- 0042_realm_transfer_and_import_jobs.sql
-- 由 scripts/postgres-migrate.mjs per-file transaction 包裹；本文件不含事务控制语句
-- ============================================================

-- 编码前置断言（C2：hash/digest ABI 以 UTF-8 为前提；server_encoding 为 cluster 级，
-- 不可由 migration 修改——不符即 fail-closed no-go）
DO $realm_transfer_encoding_precheck$
BEGIN
  IF current_setting('server_encoding') <> 'UTF8' THEN
    RAISE EXCEPTION 'realm transfer requires UTF8 server_encoding, got: %',
      current_setting('server_encoding');
  END IF;
END;
$realm_transfer_encoding_precheck$;

DO $realm_transfer_role$
DECLARE
  role_can_login boolean;
BEGIN
  -- 角色生命周期边界（C4）：realm_transfer 只能由 provisioning 创建/管理 LOGIN 与凭据；
  -- migration 缺 role 即 fail-closed（与 H.1 503 TRANSFER_NOT_PROVISIONED 同名对齐）；
  -- 本文件自此零 LOGIN/NOLOGIN/PASSWORD 关键字（静态锚点）。
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'realm_transfer') THEN
    RAISE EXCEPTION 'TRANSFER_NOT_PROVISIONED: realm_transfer role must be created by provisioning before migration';
  END IF;
  -- provisioned-state 读回（C2）：已存在但 NOLOGIN/未完成 provisioning 同样 fail-closed
  SELECT rolcanlogin INTO role_can_login FROM pg_roles WHERE rolname = 'realm_transfer';
  IF role_can_login IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'TRANSFER_NOT_PROVISIONED: realm_transfer role exists but is not provisioned (LOGIN required)';
  END IF;
  -- 只校正负向属性；绝不触碰 LOGIN/NOLOGIN/PASSWORD（provisioning 唯一管理）
  EXECUTE 'ALTER ROLE realm_transfer WITH NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  IF EXISTS (
    SELECT 1 FROM pg_auth_members
    WHERE roleid = (SELECT oid FROM pg_roles WHERE rolname = 'realm_transfer')
       OR member = (SELECT oid FROM pg_roles WHERE rolname = 'realm_transfer')
  ) THEN
    RAISE EXCEPTION 'realm_transfer has unexpected role memberships (either direction)';
  END IF;
END;
$realm_transfer_role$;

-- ============================== 0028 capability 中间态硬化（C1：drain barrier 内的 DB 级 fail-closed 兜底） ==============================
-- 中间态语义：0042 已提交/0043 未提交时 capability 完全不可调用——
-- ① 函数体置换为临时拒绝体（即使缓存 plan/竞态调用也 fail-closed）；
-- ② 路径硬化（pg_temp 末项）；③ EXECUTE 四主体撤销（permission denied）。
-- 0028 文件与台账行零改动（本迁移内置换/撤权是允许的过渡手段）；0043 置换最终 body 后恢复 runtime EXECUTE。
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
BEGIN
  RAISE EXCEPTION 'AUDIENCE_CAPABILITY_DISABLED_PENDING_0043';
END;
$$;

REVOKE EXECUTE ON FUNCTION append_propagation_node_audience(text, text, text, text, text, text)
  FROM realm_runtime, realm_control, realm_transfer, PUBLIC;

CREATE TABLE IF NOT EXISTS realm_import_jobs (
  workspace_id text NOT NULL,
  id text NOT NULL,
  direction text NOT NULL,
  logical_pack_hash text NOT NULL,
  archive_bytes_hash text,
  scope_digest text NOT NULL,
  copy_key text NOT NULL DEFAULT '',
  mode text NOT NULL,
  source_world_id text,
  target_world_id text,
  operator_principal text NOT NULL,
  transfer_entries_sha256 text,
  status text NOT NULL DEFAULT 'pending',
  current_attempt_no bigint NOT NULL DEFAULT 0,
  result jsonb NOT NULL DEFAULT '{}',
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT rij_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CONSTRAINT rij_direction_check CHECK (direction IN ('export', 'import')),
  CONSTRAINT rij_logical_pack_hash_check CHECK (logical_pack_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT rij_archive_bytes_hash_check CHECK (
    archive_bytes_hash IS NULL OR archive_bytes_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT rij_scope_digest_check CHECK (scope_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT rij_transfer_entries_sha256_check CHECK (
    transfer_entries_sha256 IS NULL OR transfer_entries_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT rij_manifest_tables_presence_check CHECK (
    (direction = 'import' AND transfer_entries_sha256 IS NOT NULL)
    OR (direction = 'export' AND transfer_entries_sha256 IS NULL)),
  CONSTRAINT rij_mode_check CHECK (mode IN ('template', 'full', 'archive')),
  CONSTRAINT rij_status_check CHECK (status IN (
    'pending', 'validating', 'staged', 'executing', 'completed', 'failed', 'cancelled')),
  CONSTRAINT rij_current_attempt_no_check CHECK (current_attempt_no >= 0),
  CONSTRAINT rij_direction_scope_check CHECK (
    (direction = 'export' AND source_world_id IS NOT NULL) OR (direction = 'import')),
  CONSTRAINT rij_terminal_result_check CHECK (
    (status = 'completed' AND result <> '{}') OR status <> 'completed'),
  CONSTRAINT rij_target_check CHECK (
    NOT (status = 'completed' AND direction = 'import') OR target_world_id IS NOT NULL),
  CONSTRAINT rij_export_hash_check CHECK (
    NOT (direction = 'export' AND status = 'completed') OR archive_bytes_hash IS NOT NULL),
  CONSTRAINT rij_import_staged_check CHECK (
    NOT (direction = 'import' AND status IN ('staged', 'executing'))
    OR (archive_bytes_hash IS NOT NULL AND source_world_id IS NOT NULL)),
  CONSTRAINT rij_error_terminal_check CHECK (
    (status = 'failed' AND error_code IS NOT NULL)
    OR (status <> 'failed' AND error_code IS NULL AND error_message IS NULL)),
  CONSTRAINT rij_copy_key_shape_check CHECK (
    copy_key = '' OR copy_key ~ '^[a-z0-9][a-z0-9-]{0,31}$'),
  CONSTRAINT rij_copy_key_direction_check CHECK (
    direction = 'import' OR copy_key = ''),
  CONSTRAINT rij_archive_not_executable_check CHECK (
    NOT (direction = 'import' AND mode = 'archive' AND status IN ('executing', 'completed')))
);

CREATE TABLE IF NOT EXISTS realm_import_job_events (
  workspace_id text NOT NULL,
  id text NOT NULL,
  job_id text NOT NULL,
  event_seq bigint NOT NULL,
  event_kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, job_id, event_seq),
  CONSTRAINT rije_job_fk
    FOREIGN KEY (workspace_id, job_id)
    REFERENCES realm_import_jobs (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT rije_event_seq_check CHECK (event_seq >= 0),
  CONSTRAINT rije_event_kind_check CHECK (event_kind IN (
    'created', 'validation_done', 'attempt_started', 'import_attempt_failed',
    'import_committed', 'cancelled', 'crash_recovered', 'export_committed')),
  CONSTRAINT rije_payload_object_check CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT rije_event_payload_shape_check CHECK ((
    (event_kind = 'created' AND payload = '{}')
    OR (event_kind = 'validation_done' AND (
      (payload ->> 'outcome') = 'staged'
      OR ((payload ->> 'outcome') = 'failed'
          AND jsonb_typeof(payload -> 'errorCode') = 'string'
          AND length(btrim(payload ->> 'errorCode')) > 0)))
    OR (event_kind = 'attempt_started'
        AND jsonb_typeof(payload -> 'attemptNo') = 'number'
        AND (payload ->> 'attemptNo') ~ '^[1-9][0-9]*$')
    OR (event_kind = 'import_committed'
        AND jsonb_typeof(payload -> 'attemptNo') = 'number'
        AND (payload ->> 'attemptNo') ~ '^[1-9][0-9]*$')
    OR (event_kind = 'import_attempt_failed'
        AND jsonb_typeof(payload -> 'attemptNo') = 'number'
        AND (payload ->> 'attemptNo') ~ '^[1-9][0-9]*$'
        AND jsonb_typeof(payload -> 'errorCode') = 'string'
        AND length(btrim(payload ->> 'errorCode')) > 0)
    OR (event_kind = 'cancelled' AND payload = '{}')
    OR (event_kind = 'crash_recovered'
        AND (payload ->> 'reason') IN ('PROCESS_CRASH', 'CLIENT_DISCONNECTED')
        AND (payload -> 'attemptNo' IS NULL
             OR (jsonb_typeof(payload -> 'attemptNo') = 'number'
                 AND (payload ->> 'attemptNo') ~ '^[1-9][0-9]*$')))
    OR (event_kind = 'export_committed' AND payload = '{}')
  ) IS TRUE)
);

CREATE TABLE IF NOT EXISTS realm_import_bootstrap (
  workspace_id text NOT NULL,
  job_id text NOT NULL,
  attempt_no bigint NOT NULL,
  world_id text NOT NULL,
  operator_principal text NOT NULL,
  tx_id bigint NOT NULL,
  worlds_wire_digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, job_id, attempt_no),
  CONSTRAINT rib_attempt_check CHECK (attempt_no >= 1),
  CONSTRAINT rib_worlds_wire_digest_check CHECK (worlds_wire_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT rib_job_fk
    FOREIGN KEY (workspace_id, job_id)
    REFERENCES realm_import_jobs (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT rib_world_uq UNIQUE (workspace_id, world_id)
);

CREATE TABLE IF NOT EXISTS realm_import_content_log (
  workspace_id text NOT NULL,
  job_id text NOT NULL,
  attempt_no bigint NOT NULL,
  table_name text NOT NULL,
  row_count bigint NOT NULL,
  wire_digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, job_id, attempt_no, table_name),
  CONSTRAINT ric_attempt_check CHECK (attempt_no >= 1),
  CONSTRAINT ric_job_fk
    FOREIGN KEY (workspace_id, job_id)
    REFERENCES realm_import_jobs (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT ric_row_count_check CHECK (row_count >= 0),
  CONSTRAINT ric_wire_digest_check CHECK (wire_digest ~ '^[0-9a-f]{64}$')
);

CREATE TABLE IF NOT EXISTS realm_import_pack_tables (
  workspace_id text NOT NULL,
  job_id text NOT NULL,
  table_name text NOT NULL,
  pack_table_sha256 text NOT NULL,
  wire_digest text NOT NULL,
  expected_rows bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, job_id, table_name),
  CONSTRAINT ript_job_fk
    FOREIGN KEY (workspace_id, job_id)
    REFERENCES realm_import_jobs (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT ript_pack_table_sha256_check CHECK (pack_table_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ript_wire_digest_check CHECK (wire_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ript_expected_rows_check CHECK (expected_rows >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS realm_import_jobs_idempotency_uidx
  ON realm_import_jobs (workspace_id, direction, logical_pack_hash, scope_digest, copy_key)
  WHERE direction = 'import' AND status <> 'cancelled';

CREATE UNIQUE INDEX IF NOT EXISTS rije_attempt_event_uidx
  ON realm_import_job_events (workspace_id, job_id, event_kind, (payload->>'attemptNo'))
  WHERE event_kind IN ('attempt_started', 'import_attempt_failed', 'import_committed');

CREATE UNIQUE INDEX IF NOT EXISTS rije_once_per_job_uidx
  ON realm_import_job_events (workspace_id, job_id, event_kind)
  WHERE event_kind IN ('created', 'validation_done', 'import_committed', 'export_committed', 'cancelled');

-- ============================== 守卫函数（纵深） ==============================

CREATE OR REPLACE FUNCTION guard_realm_import_jobs_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $guard_import_jobs_insert$
BEGIN
  IF NEW.status <> 'pending'
    OR NEW.current_attempt_no <> 0
    OR NEW.result <> '{}'
    OR NEW.target_world_id IS NOT NULL
    OR NEW.error_code IS NOT NULL
    OR NEW.error_message IS NOT NULL THEN
    RAISE EXCEPTION 'realm import job illegal initial state';
  END IF;
  RETURN NEW;
END;
$guard_import_jobs_insert$;

DROP TRIGGER IF EXISTS realm_import_jobs_insert_guard ON realm_import_jobs;
CREATE TRIGGER realm_import_jobs_insert_guard
BEFORE INSERT ON realm_import_jobs
FOR EACH ROW
EXECUTE FUNCTION guard_realm_import_jobs_insert();

CREATE OR REPLACE FUNCTION guard_realm_import_job_events_insert()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $guard_import_job_events_insert$
DECLARE
  job_status text;
  job_attempt bigint;
  job_direction text;
  next_seq bigint;
BEGIN
  SELECT status, current_attempt_no, direction
    INTO job_status, job_attempt, job_direction
  FROM realm_import_jobs
  WHERE workspace_id = NEW.workspace_id AND id = NEW.job_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'realm import job event references unknown job';
  END IF;

  SELECT COALESCE(MAX(event_seq), -1) + 1 INTO next_seq
  FROM realm_import_job_events
  WHERE workspace_id = NEW.workspace_id AND job_id = NEW.job_id;
  IF NEW.event_seq IS DISTINCT FROM next_seq THEN
    RAISE EXCEPTION 'realm import job event_seq discontinuity';
  END IF;

  -- exact key/schema 同构冻结（C1②：CHECK 不能含子查询——键集在 guard 冻结，与 CHECK 同形）
  IF NEW.event_kind IN ('created', 'cancelled', 'export_committed') THEN
    IF NEW.payload <> '{}'::jsonb THEN
      RAISE EXCEPTION 'realm import job event payload must be empty object: %', NEW.event_kind;
    END IF;
  ELSIF NEW.event_kind IN ('attempt_started', 'import_committed') THEN
    IF NOT (NEW.payload ? 'attemptNo')
      OR (SELECT count(*) FROM jsonb_object_keys(NEW.payload)) <> 1 THEN
      RAISE EXCEPTION 'realm import job event payload keys must be exactly {attemptNo}';
    END IF;
  ELSIF NEW.event_kind = 'import_attempt_failed' THEN
    IF NOT (NEW.payload ? 'attemptNo' AND NEW.payload ? 'errorCode')
      OR (SELECT count(*) FROM jsonb_object_keys(NEW.payload)) <> 2 THEN
      RAISE EXCEPTION 'realm import job event payload keys must be exactly {attemptNo, errorCode}';
    END IF;
  ELSIF NEW.event_kind = 'validation_done' THEN
    IF EXISTS (
      SELECT 1 FROM jsonb_object_keys(NEW.payload) AS k
      WHERE k NOT IN ('outcome', 'errorCode', 'report')
    ) OR NOT (NEW.payload ? 'outcome' AND NEW.payload ? 'report') THEN
      RAISE EXCEPTION 'realm import job validation_done payload key set mismatch';
    END IF;
    IF ((NEW.payload ->> 'outcome') = 'failed' AND NOT (NEW.payload ? 'errorCode'))
      OR ((NEW.payload ->> 'outcome') = 'staged' AND (NEW.payload ? 'errorCode')) THEN
      RAISE EXCEPTION 'realm import job validation_done errorCode/outcome mismatch';
    END IF;
    -- report 必填且必须 object（C4：与受控函数/CHECK 三层同构；JSON null/string/array 拒绝）
    IF jsonb_typeof(NEW.payload -> 'report') IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'realm import job validation_done report must be an object';
    END IF;
  ELSIF NEW.event_kind = 'crash_recovered' THEN
    IF EXISTS (
      SELECT 1 FROM jsonb_object_keys(NEW.payload) AS k
      WHERE k NOT IN ('reason', 'attemptNo')
    ) OR NOT (NEW.payload ? 'reason') THEN
      RAISE EXCEPTION 'realm import job crash_recovered payload key set mismatch';
    END IF;
  END IF;

  IF (NEW.event_kind = 'created' AND job_status = 'pending')
    OR (NEW.event_kind = 'validation_done' AND job_status = 'validating')
    OR (NEW.event_kind = 'attempt_started' AND job_status = 'executing'
        AND (NEW.payload ->> 'attemptNo')::bigint = job_attempt)
    OR (NEW.event_kind = 'import_committed' AND job_status = 'completed'
        AND job_direction = 'import'
        AND (NEW.payload ->> 'attemptNo')::bigint = job_attempt)
    OR (NEW.event_kind = 'import_attempt_failed' AND job_status = 'failed'
        AND (NEW.payload ->> 'attemptNo')::bigint = job_attempt)
    OR (NEW.event_kind = 'cancelled' AND job_status = 'cancelled')
    OR (NEW.event_kind = 'crash_recovered' AND (
        -- pending/validating-stale 收尾：cancelled、reason 合法、无 attemptNo
        (job_status = 'cancelled'
          AND (NEW.payload ->> 'reason') IN ('PROCESS_CRASH', 'CLIENT_DISCONNECTED')
          AND NEW.payload -> 'attemptNo' IS NULL)
        -- executing-stale 收尾：failed、import、reason 合法、attemptNo 绑定当前轮次
        OR (job_status = 'failed' AND job_direction = 'import'
            AND (NEW.payload ->> 'reason') IN ('PROCESS_CRASH', 'CLIENT_DISCONNECTED')
            AND (NEW.payload ->> 'attemptNo') ~ '^[1-9][0-9]*$'
            AND (NEW.payload ->> 'attemptNo')::bigint = job_attempt)
      ))
    OR (NEW.event_kind = 'export_committed' AND job_status = 'completed'
        AND job_direction = 'export') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'realm import job event kind/state mismatch';
END;
$guard_import_job_events_insert$;

DROP TRIGGER IF EXISTS realm_import_job_events_insert_guard ON realm_import_job_events;
CREATE TRIGGER realm_import_job_events_insert_guard
BEFORE INSERT ON realm_import_job_events
FOR EACH ROW
EXECUTE FUNCTION guard_realm_import_job_events_insert();

CREATE OR REPLACE FUNCTION guard_realm_import_job_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $guard_import_job_events$
BEGIN
  RAISE EXCEPTION
    'realm import job events are append-only; append a new event';
END;
$guard_import_job_events$;

DROP TRIGGER IF EXISTS realm_import_job_events_append_only_guard ON realm_import_job_events;
CREATE TRIGGER realm_import_job_events_append_only_guard
BEFORE UPDATE OR DELETE ON realm_import_job_events
FOR EACH ROW
EXECUTE FUNCTION guard_realm_import_job_events_append_only();

CREATE OR REPLACE FUNCTION guard_realm_import_jobs_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $guard_import_jobs_mutation$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.direction IS DISTINCT FROM OLD.direction
    OR NEW.logical_pack_hash IS DISTINCT FROM OLD.logical_pack_hash
    OR NEW.archive_bytes_hash IS DISTINCT FROM OLD.archive_bytes_hash
    OR NEW.scope_digest IS DISTINCT FROM OLD.scope_digest
    OR NEW.copy_key IS DISTINCT FROM OLD.copy_key
    OR NEW.mode IS DISTINCT FROM OLD.mode
    OR NEW.source_world_id IS DISTINCT FROM OLD.source_world_id
    OR NEW.operator_principal IS DISTINCT FROM OLD.operator_principal
    OR NEW.transfer_entries_sha256 IS DISTINCT FROM OLD.transfer_entries_sha256
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'realm import job immutable column changed';
  END IF;

  IF NEW.current_attempt_no IS DISTINCT FROM OLD.current_attempt_no THEN
    IF NOT (
      NEW.current_attempt_no = OLD.current_attempt_no + 1
      AND OLD.direction = 'import'
      AND OLD.status IN ('staged', 'failed')
      AND NEW.status = 'executing'
    ) THEN
      RAISE EXCEPTION 'realm import job illegal attempt counter mutation';
    END IF;
  END IF;

  IF (NEW.result IS DISTINCT FROM OLD.result
      OR NEW.target_world_id IS DISTINCT FROM OLD.target_world_id)
    AND NOT (OLD.status IS DISTINCT FROM 'completed' AND NEW.status = 'completed') THEN
    RAISE EXCEPTION 'realm import job result mutation outside completion transition';
  END IF;

  IF (NEW.error_code IS DISTINCT FROM OLD.error_code
      OR NEW.error_message IS DISTINCT FROM OLD.error_message)
    AND NOT (
      (OLD.status IS DISTINCT FROM 'failed' AND NEW.status = 'failed')
      OR (OLD.status = 'failed' AND NEW.status = 'executing'
          AND NEW.error_code IS NULL AND NEW.error_message IS NULL)
    ) THEN
    RAISE EXCEPTION 'realm import job error mutation outside failure/retry-clear transition';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF (OLD.status = 'pending' AND NEW.status = 'validating' AND OLD.direction = 'import')
      OR (OLD.status = 'pending' AND NEW.status = 'cancelled')
      OR (OLD.status = 'pending' AND NEW.status = 'completed' AND OLD.direction = 'export')
      OR (OLD.status = 'validating' AND NEW.status IN ('staged', 'failed') AND OLD.direction = 'import')
      OR (OLD.status = 'validating' AND NEW.status = 'cancelled' AND OLD.direction = 'import')
      OR (OLD.status = 'staged' AND NEW.status = 'executing' AND OLD.direction = 'import'
          AND NEW.current_attempt_no = OLD.current_attempt_no + 1)
      OR (OLD.status = 'staged' AND NEW.status = 'cancelled' AND OLD.direction = 'import')
      OR (OLD.status = 'failed' AND NEW.status = 'executing' AND OLD.direction = 'import'
          AND NEW.current_attempt_no = OLD.current_attempt_no + 1)
      OR (OLD.status = 'executing' AND NEW.status IN ('completed', 'failed') AND OLD.direction = 'import') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'realm import job illegal transition: % -> %', OLD.status, NEW.status;
  END IF;

  RETURN NEW;
END;
$guard_import_jobs_mutation$;

DROP TRIGGER IF EXISTS realm_import_jobs_mutation_guard ON realm_import_jobs;
CREATE TRIGGER realm_import_jobs_mutation_guard
BEFORE UPDATE ON realm_import_jobs
FOR EACH ROW
EXECUTE FUNCTION guard_realm_import_jobs_mutation();

-- ============================== 内部 helper（PUBLIC REVOKE；仅 definer 内部调用） ==============================

-- canonicalRow 规范（G.4；向量 7 锚定；与 realm-pack.ts 双侧逐字节一致）
CREATE OR REPLACE FUNCTION realm_import_canonical_row(p_row jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $realm_import_canonical_row$
DECLARE
  k text;
  v jsonb;
  seg text;
  elems text;
  result text := '';
BEGIN
  IF jsonb_typeof(p_row) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'canonical row must be a jsonb object';
  END IF;
  FOR k IN
    SELECT key FROM jsonb_object_keys(p_row) AS t(key)
    ORDER BY char_length(key), key COLLATE "C"
  LOOP
    v := p_row -> k;
    -- jsonb_typeof 对 JSONB null 返回文本 'null'（Z48 官方语义；IS NULL 永不命中——v20 C1 修正）
    IF jsonb_typeof(v) = 'null' THEN
      seg := '0';
    ELSIF jsonb_typeof(v) = 'string' THEN
      seg := '1' || (v #>> '{}');
    ELSIF jsonb_typeof(v) = 'boolean' THEN
      seg := '2' || (v #>> '{}');
    ELSIF jsonb_typeof(v) = 'array' THEN
      IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(v) AS e
        WHERE jsonb_typeof(e) IS DISTINCT FROM 'string'
      ) THEN
        RAISE EXCEPTION 'canonical array elements must be strings';
      END IF;
      -- 数组保序由 WITH ORDINALITY 显式锚定（C6：聚合输入顺序默认未定义——Z59）
      SELECT COALESCE(string_agg(char_length(e) || ':' || e, '' ORDER BY ord), '')
        INTO elems
      FROM jsonb_array_elements_text(v) WITH ORDINALITY AS t(e, ord);
      seg := '3' || elems;
    ELSE
      RAISE EXCEPTION 'non-canonical insert codec value kind: %', jsonb_typeof(v);
    END IF;
    result := result || char_length(k) || ':' || k || char_length(seg) || ':' || seg;
  END LOOP;
  RETURN result;
END;
$realm_import_canonical_row$;

-- scope 矩阵（C1；template=23 / archive=36 / full=41 可导入表；worlds/memberships/派生表不在此列）
CREATE OR REPLACE FUNCTION realm_import_scope_allows(p_mode text, p_table text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $realm_import_scope_allows$
  SELECT CASE
    WHEN p_table IN (
      'worldlines',
      'character_definitions', 'character_continuities',
      'skill_definitions', 'asset_definitions', 'effect_definitions',
      'world_entities', 'world_claims', 'world_relations', 'world_articles', 'causal_edges',
      'canon_proposals', 'canon_revisions', 'canon_revision_audiences',
      'information_campaigns', 'information_packets', 'propagation_exposures',
      'propagation_nodes', 'propagation_routes', 'propagation_node_audiences',
      'article_qualifications', 'article_import_entries', 'world_files'
    ) THEN p_mode IN ('template', 'full', 'archive')
    WHEN p_table IN (
      'stories', 'records', 'scenes',
      'character_instances', 'participants', 'visibility_policies',
      'events', 'record_heads', 'observations',
      'character_skills', 'character_assets',
      'action_receipts', 'character_effects'
    ) THEN p_mode IN ('full', 'archive')
    WHEN p_table IN (
      'memory_conclusions', 'memory_snapshots', 'memory_cache_epochs',
      'relationship_states', 'worldline_merges'
    ) THEN p_mode = 'full'
    ELSE false
  END;
$realm_import_scope_allows$;

-- scope floor（C2①/C4：三个 mode 的 DB 可证最小必备集；合法世界必有 root worldline——Z34。
-- RETURNS SETOF text = floor 集的唯一来源枚举；register 以本函数驱动 floor 检查——M1）
CREATE OR REPLACE FUNCTION realm_import_scope_required(p_mode text)
RETURNS SETOF text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public, pg_temp
AS $realm_import_scope_required$
  SELECT required_table
  FROM (VALUES ('worlds'), ('worldlines')) AS required(required_table)
  WHERE p_mode IN ('template', 'full', 'archive');
$realm_import_scope_required$;

-- 孤儿清理（C3/M5：唯一来源 = 误拆分提交的旧 tx 绑定；仅在 executing/failed/stale 路径被调用，
-- completed job 无可达调用点——begin_execute 拒 completed、fail/recover 拒 completed。
-- 锁序：调用点已持 job FOR UPDATE → 本函数锁绑定行 → 删 worlds（与 tx2 全局顺序一致））
CREATE OR REPLACE FUNCTION realm_import_cleanup_orphans(
  p_workspace_id text, p_job_id text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $realm_import_cleanup_orphans$
DECLARE
  orphan_world text;
BEGIN
  -- 函数内前置断言（M4：tenant 等式 + job 存在、direction='import'、状态限于可达调用点。
  -- validating 可达性证明（C1）：状态机无回边（validating 出边仅 staged/failed/cancelled，
  -- 无任何 →validating 回边）⇒ status='validating' 的 job 从未进入 executing ⇒
  -- bootstrap/content_log（仅 executing 的 tx2 可写）恒为空 ⇒ 本函数对该状态恒 no-op；
  -- 统一调用保留作纵深，不做分支特判）
  IF realm_current_workspace_id() IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'workspace context mismatch';
  END IF;
  PERFORM 1 FROM realm_import_jobs
  WHERE workspace_id = p_workspace_id AND id = p_job_id
    AND direction = 'import' AND status IN ('pending', 'validating', 'executing', 'failed');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'orphan cleanup precondition failed for job: %', p_job_id;
  END IF;
  FOR orphan_world IN
    SELECT world_id FROM realm_import_bootstrap
    WHERE workspace_id = p_workspace_id AND job_id = p_job_id
      AND tx_id <> txid_current()
    FOR UPDATE
  LOOP
    -- 完成态保护（M5③：纵深防御——被任何 completed job target 引用的 world 永不删除）
    IF EXISTS (
      SELECT 1 FROM realm_import_jobs AS completed_job
      WHERE completed_job.workspace_id = p_workspace_id
        AND completed_job.target_world_id = orphan_world
        AND completed_job.status = 'completed'
    ) THEN
      CONTINUE;
    END IF;
    DELETE FROM worlds
    WHERE workspace_id = p_workspace_id AND id = orphan_world;
    -- 读回断言（M5④）
    IF EXISTS (
      SELECT 1 FROM worlds
      WHERE workspace_id = p_workspace_id AND id = orphan_world
    ) THEN
      RAISE EXCEPTION 'orphan cleanup failed to remove world: %', orphan_world;
    END IF;
    DELETE FROM realm_import_content_log
    WHERE workspace_id = p_workspace_id AND job_id = p_job_id
      AND attempt_no IN (
        SELECT attempt_no FROM realm_import_bootstrap
        WHERE workspace_id = p_workspace_id AND job_id = p_job_id
          AND world_id = orphan_world
      );
    DELETE FROM realm_import_bootstrap
    WHERE workspace_id = p_workspace_id AND job_id = p_job_id
      AND world_id = orphan_world;
  END LOOP;
END;
$realm_import_cleanup_orphans$;

-- ============================== 受控函数（SECURITY DEFINER；唯一写入口） ==============================

CREATE OR REPLACE FUNCTION realm_import_job_create(
  p_workspace_id text,
  p_id text,
  p_direction text,
  p_logical_pack_hash text,
  p_archive_bytes_hash text,
  p_scope_digest text,
  p_copy_key text,
  p_mode text,
  p_source_world_id text,
  p_operator_principal text,
  p_transfer_entries_sha256 text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $realm_import_job_create$
BEGIN
  IF realm_current_workspace_id() IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'workspace context mismatch';
  END IF;
  PERFORM 1 FROM accounts
  WHERE workspace_id = p_workspace_id AND principal_id = p_operator_principal;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown operator principal';
  END IF;
  IF p_direction = 'export' THEN
    PERFORM 1 FROM player_world_memberships
    WHERE workspace_id = p_workspace_id AND world_id = p_source_world_id
      AND principal_id = p_operator_principal AND role = 'owner'
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'operator is not the source world owner';
    END IF;
  END IF;
  -- transfer_entries_sha256 由 service 在 dry-run 时刻从已通过字节级校验的 manifest.tables
  -- 按 G.4 ASCII canonical（含每 entry wireDigest——v21 单链）计算；
  -- 此后不可变（守卫）+ register 函数内重算等式 + execute 重传重算比对（C1/M2）
  INSERT INTO realm_import_jobs (
    workspace_id, id, direction, logical_pack_hash, archive_bytes_hash,
    scope_digest, copy_key, mode, source_world_id, operator_principal,
    transfer_entries_sha256
  ) VALUES (
    p_workspace_id, p_id, p_direction, p_logical_pack_hash, p_archive_bytes_hash,
    p_scope_digest, COALESCE(p_copy_key, ''), p_mode, p_source_world_id, p_operator_principal,
    p_transfer_entries_sha256
  );
  INSERT INTO realm_import_job_events (workspace_id, id, job_id, event_seq, event_kind, payload)
  VALUES (p_workspace_id, 'rje_' || p_id || '_0', p_id, 0, 'created', '{}');
END;
$realm_import_job_create$;

CREATE OR REPLACE FUNCTION realm_import_job_begin_validation(
  p_workspace_id text, p_job_id text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $realm_import_job_begin_validation$
BEGIN
  IF realm_current_workspace_id() IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'workspace context mismatch';
  END IF;
  PERFORM 1 FROM realm_import_jobs
  WHERE workspace_id = p_workspace_id AND id = p_job_id
    AND status = 'pending' AND direction = 'import'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'realm import job not pending-import: %', p_job_id;
  END IF;
  UPDATE realm_import_jobs
  SET status = 'validating', updated_at = CURRENT_TIMESTAMP
  WHERE workspace_id = p_workspace_id AND id = p_job_id;
END;
$realm_import_job_begin_validation$;

CREATE OR REPLACE FUNCTION realm_import_register_pack_tables(
  p_workspace_id text, p_job_id text, p_tables jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $realm_import_register_pack_tables$
DECLARE
  pack_entry jsonb;
  req text;
  job_mode text;
  job_transfer_hash text;
  recomputed_hash text;
BEGIN
  IF realm_current_workspace_id() IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'workspace context mismatch';
  END IF;
  SELECT mode, transfer_entries_sha256 INTO job_mode, job_transfer_hash
  FROM realm_import_jobs
  WHERE workspace_id = p_workspace_id AND id = p_job_id
    AND status = 'validating' AND direction = 'import'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'realm import job not validating-import: %', p_job_id;
  END IF;
  IF jsonb_typeof(p_tables) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'pack tables must be a jsonb array';
  END IF;

  -- entry 结构 fail-closed（C1）：键集恰好 {name, rows, sha256, wireDigest}；无重复 name
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_tables) AS pack_entry,
         jsonb_object_keys(pack_entry.value) AS k
    WHERE k NOT IN ('name', 'rows', 'sha256', 'wireDigest')
  ) THEN
    RAISE EXCEPTION 'unknown key in pack table entry';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_tables) AS entry
    WHERE NOT (entry ? 'name' AND entry ? 'rows' AND entry ? 'sha256' AND entry ? 'wireDigest')
  ) THEN
    RAISE EXCEPTION 'pack table entry missing required key';
  END IF;
  IF (SELECT count(*) FROM (
        SELECT entry ->> 'name' AS n FROM jsonb_array_elements(p_tables) AS entry
        GROUP BY 1 HAVING count(*) > 1
      ) AS dups) > 0 THEN
    RAISE EXCEPTION 'duplicate table in pack tables';
  END IF;

  -- scope floor（C2①/M1：由 realm_import_scope_required 唯一驱动，无第二份清单；
  -- worlds 恰一条且 rows=1；其余必备表 rows>=1）
  FOR req IN SELECT * FROM realm_import_scope_required(job_mode)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_tables) AS entry
      WHERE (entry ->> 'name') = req
    ) THEN
      RAISE EXCEPTION 'pack tables missing required table: %', req;
    END IF;
    IF req = 'worlds' THEN
      IF (SELECT count(*) FROM jsonb_array_elements(p_tables) AS entry
          WHERE (entry ->> 'name') = req) <> 1
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(p_tables) AS entry
          WHERE (entry ->> 'name') = req AND (entry ->> 'rows') <> '1'
        ) THEN
        RAISE EXCEPTION 'worlds entry must appear exactly once with exactly one row';
      END IF;
    ELSIF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_tables) AS entry
      WHERE (entry ->> 'name') = req
        AND ((entry ->> 'rows') !~ '^[0-9]+$' OR (entry ->> 'rows')::bigint < 1)
    ) THEN
      RAISE EXCEPTION 'required table % must have at least one row', req;
    END IF;
  END LOOP;
  -- memberships/派生表禁止；其余表必须过 scope 矩阵（realm_import_scope_allows 同一 helper）
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_tables) AS entry
    WHERE (entry ->> 'name') IN ('player_world_memberships', 'visibility_policy_audiences')
  ) THEN
    RAISE EXCEPTION 'table not importable via pack tables (bootstrap-owned or derived)';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_tables) AS entry
    WHERE (entry ->> 'name') <> 'worlds'
      AND NOT realm_import_scope_allows(job_mode, entry ->> 'name')
  ) THEN
    RAISE EXCEPTION 'table not allowed for scope %', job_mode;
  END IF;

  -- manifest 绑定（C1/M2：单链不可替换——canonical 含 wireDigest；函数内重算，与 job 不可变列等式）
  SELECT encode(digest(COALESCE(string_agg(
      (entry ->> 'name') || E'\n' || (entry ->> 'rows') || E'\n'
        || (entry ->> 'sha256') || E'\n' || (entry ->> 'wireDigest') || E'\n',
      '' ORDER BY (entry ->> 'name') COLLATE "C"), ''), 'sha256'), 'hex')
  INTO recomputed_hash
  FROM jsonb_array_elements(p_tables) AS entry;
  IF recomputed_hash IS DISTINCT FROM job_transfer_hash THEN
    RAISE EXCEPTION 'pack tables do not match job transfer_entries_sha256';
  END IF;

  -- 资源上限（M4：DB 级硬上限；service/pack validator 同值前置，分类 422 PACK_LIMIT_EXCEEDED）
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_tables) AS entry
    WHERE (entry ->> 'rows') ~ '^[0-9]+$' AND (entry ->> 'rows')::bigint > 100000
  ) THEN
    RAISE EXCEPTION 'pack table rows exceed per-table limit (100000)';
  END IF;
  IF (
    SELECT COALESCE(sum((entry ->> 'rows')::bigint), 0)
    FROM jsonb_array_elements(p_tables) AS entry
    WHERE (entry ->> 'rows') ~ '^[0-9]+$'
  ) > 500000 THEN
    RAISE EXCEPTION 'pack rows exceed total limit (500000)';
  END IF;

  -- 逐 entry 格式校验 + 注册（NULL-safe——C2③：先 jsonb_typeof 精确类型拒绝
  -- （缺键/JSON null/错类型一律命中，IS DISTINCT FROM 对 SQL NULL 安全），再 regex/范围；
  -- wireDigest 正确性由 insert 时 DB 实算自证——C2②）
  FOR pack_entry IN SELECT * FROM jsonb_array_elements(p_tables)
  LOOP
    IF jsonb_typeof(pack_entry-> 'name') IS DISTINCT FROM 'string'
      OR btrim(pack_entry->> 'name') = '' THEN
      RAISE EXCEPTION 'invalid pack table name entry';
    END IF;
    IF jsonb_typeof(pack_entry-> 'sha256') IS DISTINCT FROM 'string'
      OR (pack_entry->> 'sha256') !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'invalid pack table sha256 for table: %', pack_entry->> 'name';
    END IF;
    IF jsonb_typeof(pack_entry-> 'wireDigest') IS DISTINCT FROM 'string'
      OR (pack_entry->> 'wireDigest') !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'invalid wire digest for table: %', pack_entry->> 'name';
    END IF;
    IF jsonb_typeof(pack_entry-> 'rows') IS DISTINCT FROM 'number'
      OR (pack_entry->> 'rows') !~ '^[0-9]+$'
      OR (pack_entry->> 'rows')::bigint < 1 THEN
      RAISE EXCEPTION 'invalid expected rows for table: %', pack_entry->> 'name';
    END IF;
    INSERT INTO realm_import_pack_tables (
      workspace_id, job_id, table_name, pack_table_sha256, wire_digest, expected_rows
    ) VALUES (
      p_workspace_id, p_job_id, pack_entry->> 'name',
      pack_entry->> 'sha256', pack_entry->> 'wireDigest', (pack_entry->> 'rows')::bigint
    );
  END LOOP;
END;
$realm_import_register_pack_tables$;

CREATE OR REPLACE FUNCTION realm_import_job_finish_validation(
  p_workspace_id text, p_job_id text, p_outcome text,
  p_error_code text, p_error_message text, p_report jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $realm_import_job_finish_validation$
DECLARE
  next_seq bigint;
BEGIN
  IF realm_current_workspace_id() IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'workspace context mismatch';
  END IF;
  PERFORM 1 FROM realm_import_jobs
  WHERE workspace_id = p_workspace_id AND id = p_job_id
    AND status = 'validating' AND direction = 'import'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'realm import job not validating-import: %', p_job_id;
  END IF;
  IF p_outcome IS NULL OR p_outcome NOT IN ('staged', 'failed') THEN
    RAISE EXCEPTION 'realm import job invalid validation outcome: %', p_outcome;
  END IF;
  IF p_outcome = 'failed' AND (p_error_code IS NULL OR btrim(p_error_code) = '') THEN
    RAISE EXCEPTION 'realm import job failed validation requires error_code';
  END IF;
  IF p_report IS NULL OR jsonb_typeof(p_report) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'realm import job validation requires object report';
  END IF;
  SELECT COALESCE(MAX(event_seq), -1) + 1 INTO next_seq
  FROM realm_import_job_events
  WHERE workspace_id = p_workspace_id AND job_id = p_job_id;
  INSERT INTO realm_import_job_events (workspace_id, id, job_id, event_seq, event_kind, payload)
  VALUES (
    p_workspace_id, 'rje_' || p_job_id || '_' || next_seq, p_job_id, next_seq,
    'validation_done',
    jsonb_strip_nulls(jsonb_build_object(
      'outcome', p_outcome,
      'errorCode', CASE WHEN p_outcome = 'failed' THEN p_error_code ELSE NULL END,
      'report', p_report
    ))
  );
  UPDATE realm_import_jobs
  SET status = p_outcome,
      error_code = CASE WHEN p_outcome = 'failed' THEN p_error_code ELSE NULL END,
      error_message = CASE WHEN p_outcome = 'failed' THEN p_error_message ELSE NULL END,
      updated_at = CURRENT_TIMESTAMP
  WHERE workspace_id = p_workspace_id AND id = p_job_id;
END;
$realm_import_job_finish_validation$;

CREATE OR REPLACE FUNCTION realm_import_job_begin_execute(
  p_workspace_id text, p_job_id text
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $realm_import_job_begin_execute$
DECLARE
  old_status text;
  last_event_kind text;
  last_event_payload jsonb;
  cur_attempt bigint;
  new_attempt bigint;
  next_seq bigint;
BEGIN
  IF realm_current_workspace_id() IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'workspace context mismatch';
  END IF;
  SELECT status, current_attempt_no, current_attempt_no + 1
    INTO old_status, cur_attempt, new_attempt
  FROM realm_import_jobs
  WHERE workspace_id = p_workspace_id AND id = p_job_id
    AND status IN ('staged', 'failed') AND direction = 'import'
    AND mode <> 'archive'
  FOR UPDATE;
  IF NOT FOUND THEN
    -- archive 包 = 只读封存产物（C5）：dry-run 可读，execute 永拒（route → 422 ARCHIVE_PACK_NOT_IMPORTABLE）
    PERFORM 1 FROM realm_import_jobs
    WHERE workspace_id = p_workspace_id AND id = p_job_id
      AND direction = 'import' AND mode = 'archive';
    IF FOUND THEN
      RAISE EXCEPTION 'archive packs are not importable (dry-run read-only)';
    END IF;
    RAISE EXCEPTION 'realm import job not executable: %', p_job_id;
  END IF;
  -- validation failure 隔离（C2）+ payload/attempt 绑定（C4）：failed 来源分流——
  -- 仅执行期失败可 retry，且最后事件的 attemptNo/reason 必须与当前失败轮次绑定
  IF old_status = 'failed' THEN
    SELECT event_kind, payload INTO last_event_kind, last_event_payload
    FROM realm_import_job_events
    WHERE workspace_id = p_workspace_id AND job_id = p_job_id
    ORDER BY event_seq DESC
    LIMIT 1;
    -- NULL-safe 绑定（C2：先显式 IS NULL 拒绝——缺失与 JSON null 同拒；
    -- PL/pgSQL IF 条件为 NULL 会跳过，!~/<> 不可置于 IS NULL 之前）
    IF last_event_kind = 'import_attempt_failed' THEN
      IF last_event_payload ->> 'attemptNo' IS NULL THEN
        RAISE EXCEPTION 'last failure event missing attemptNo';
      END IF;
      IF (last_event_payload ->> 'attemptNo') !~ '^[1-9][0-9]*$'
        OR (last_event_payload ->> 'attemptNo')::bigint <> cur_attempt THEN
        RAISE EXCEPTION 'last failure event attempt does not match current attempt';
      END IF;
    ELSIF last_event_kind = 'crash_recovered' THEN
      IF last_event_payload ->> 'reason' IS NULL
        OR last_event_payload ->> 'attemptNo' IS NULL THEN
        RAISE EXCEPTION 'last crash event missing reason or attemptNo';
      END IF;
      IF (last_event_payload ->> 'reason') NOT IN ('PROCESS_CRASH', 'CLIENT_DISCONNECTED')
        OR (last_event_payload ->> 'attemptNo') !~ '^[1-9][0-9]*$'
        OR (last_event_payload ->> 'attemptNo')::bigint <> cur_attempt THEN
        RAISE EXCEPTION 'last crash event payload does not match current attempt';
      END IF;
    ELSE
      RAISE EXCEPTION 'realm import job failed at validation and is terminal: %', p_job_id;
    END IF;
  END IF;
  -- retry 清除 error（C3：只有 failed 携带 error；进入 executing 即清空）
  UPDATE realm_import_jobs
  SET status = 'executing', current_attempt_no = new_attempt,
      error_code = NULL, error_message = NULL, updated_at = CURRENT_TIMESTAMP
  WHERE workspace_id = p_workspace_id AND id = p_job_id;
  SELECT COALESCE(MAX(event_seq), -1) + 1 INTO next_seq
  FROM realm_import_job_events
  WHERE workspace_id = p_workspace_id AND job_id = p_job_id;
  INSERT INTO realm_import_job_events (workspace_id, id, job_id, event_seq, event_kind, payload)
  VALUES (
    p_workspace_id, 'rje_' || p_job_id || '_' || next_seq, p_job_id, next_seq,
    'attempt_started', jsonb_build_object('attemptNo', new_attempt)
  );
  RETURN new_attempt;
END;
$realm_import_job_begin_execute$;

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

CREATE OR REPLACE FUNCTION realm_import_insert_rows(
  p_workspace_id text,
  p_job_id text,
  p_attempt_no bigint,
  p_table text,
  p_rows jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $realm_import_insert_rows$
DECLARE
  target_world text;
  binding_tx bigint;
  job_mode text;
  expected_row_count bigint;
  expected_wire_digest text;
  inserted_count bigint;
  actual_wire_digest text;
  writable_cols text;
  writable_select_cols text;
BEGIN
  IF realm_current_workspace_id() IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'workspace context mismatch';
  END IF;
  SELECT mode INTO job_mode
  FROM realm_import_jobs
  WHERE workspace_id = p_workspace_id AND id = p_job_id
    AND status = 'executing' AND direction = 'import'
    AND current_attempt_no = p_attempt_no
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'realm import job not executing with attempt %: %', p_attempt_no, p_job_id;
  END IF;
  -- scope 校验（M3：以本 job.mode 独立判定；worlds/memberships/派生表天然排除）
  IF NOT realm_import_scope_allows(job_mode, p_table) THEN
    RAISE EXCEPTION 'table not importable for mode %: %', job_mode, p_table;
  END IF;
  -- expected ledger 绑定（C1：表已注册；单行批约定——每表每 attempt 恰好一批）
  SELECT expected_rows, wire_digest INTO expected_row_count, expected_wire_digest
  FROM realm_import_pack_tables
  WHERE workspace_id = p_workspace_id AND job_id = p_job_id
    AND table_name = p_table;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pack table not registered for job: %', p_table;
  END IF;
  -- 目标绑定 + 事务绑定（C3：tx_id 由 bootstrap 自取 txid_current()；跨事务调用永久拒绝）
  SELECT world_id, tx_id INTO target_world, binding_tx
  FROM realm_import_bootstrap
  WHERE workspace_id = p_workspace_id AND job_id = p_job_id
    AND attempt_no = p_attempt_no;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'realm import bootstrap missing for job attempt: %', p_job_id;
  END IF;
  IF binding_tx <> txid_current() THEN
    RAISE EXCEPTION 'import content transaction mismatch (split tx2 is forbidden)';
  END IF;
  -- bootstrap 后 active 重验（每批在自身 client 锁 FOR KEY SHARE——C4/M4）
  PERFORM 1 FROM worlds
  WHERE workspace_id = p_workspace_id AND id = target_world AND status = 'active'
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bootstrap target world is not active';
  END IF;
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'import rows must be a jsonb array';
  END IF;
  -- 键集双向等值（C5：未知键/缺键均 RAISE；default 永不触发。
  -- 可写列集合 = is_generated='NEVER' AND is_identity='NO'（取值域 Z55）——C1：generated 列派生排除，
  -- observations.search_document 不进键集、不进 digest、不进 INSERT）
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_rows) AS row_value,
         jsonb_object_keys(row_value) AS k
    WHERE k NOT IN (
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = p_table
        AND is_generated = 'NEVER' AND is_identity = 'NO'
    )
  ) OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_rows) AS row_value
    WHERE EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = p_table
        AND is_generated = 'NEVER' AND is_identity = 'NO'
        AND column_name NOT IN (SELECT k FROM jsonb_object_keys(row_value) AS k)
    )
  ) THEN
    RAISE EXCEPTION 'import row key set mismatch for table: %', p_table;
  END IF;
  -- 通用 tenant 断言（C4/Z43：42/42 内容表含 workspace_id；逐行等值）
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_rows) AS row_value
    WHERE (row_value ->> 'workspace_id') IS DISTINCT FROM p_workspace_id
  ) THEN
    RAISE EXCEPTION 'row workspace_id does not match current tenant';
  END IF;
  -- 归属断言（A 类直接 world_id；B 类 memory_cache_epochs 经 continuity→world）
  IF p_table = 'memory_cache_epochs' THEN
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_rows) AS row_value
      WHERE NOT EXISTS (
        SELECT 1 FROM character_continuities AS continuity
        WHERE continuity.workspace_id = p_workspace_id
          AND continuity.id = row_value ->> 'observer_continuity_id'
          AND continuity.world_id = target_world
      )
    ) THEN
      RAISE EXCEPTION 'memory_cache_epochs observer continuity does not resolve to bootstrap world';
    END IF;
  ELSE
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_rows) AS row_value
      WHERE row_value ->> 'world_id' IS DISTINCT FROM target_world
    ) THEN
      RAISE EXCEPTION 'row world_id does not match bootstrap target';
    END IF;
  END IF;
  -- 显式可写列列表（C1③：不再 SELECT *；generated 列由 engine 派生，禁写）
  SELECT string_agg(format('%I', column_name), ', ' ORDER BY ordinal_position)
  INTO writable_cols
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = p_table
    AND is_generated = 'NEVER' AND is_identity = 'NO';
  -- jsonb 列同上（populate_recordset 标量 → (#>> '{}')::jsonb 重解析）。
  SELECT string_agg(
      CASE WHEN data_type IN ('jsonb', 'json')
        THEN format('(%I #>> ''{}'')::jsonb AS %I', column_name, column_name)
        ELSE format('%I', column_name)
      END, ', ' ORDER BY ordinal_position)
  INTO writable_select_cols
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = p_table
    AND is_generated = 'NEVER' AND is_identity = 'NO';
  EXECUTE format(
    'INSERT INTO %I (%s) SELECT %s FROM jsonb_populate_recordset(NULL::%I, $1)',
    p_table, writable_cols, writable_select_cols, p_table)
  USING p_rows;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  IF inserted_count IS DISTINCT FROM expected_row_count THEN
    RAISE EXCEPTION 'row count mismatch for table %: expected %, got %',
      p_table, expected_row_count, inserted_count;
  END IF;
  -- actual wire digest：DB 对真实入参实算（C2③；caller 无法伪造——digest 非参数。
  -- 每行 digest 带尾换行拼接（G.4 tableWireDigest 冻结形态；与 bootstrap
  -- worlds digest/JS realm-pack.ts 逐字节一致）；
  -- ORDER BY 显式 COLLATE "C"——C4：与 G.4 同一 C 字节序，跨数据库 locale 确定）
  SELECT encode(digest(COALESCE(string_agg(rd || E'\n', '' ORDER BY rd COLLATE "C"), ''), 'sha256'), 'hex')
  INTO actual_wire_digest
  FROM (
    SELECT encode(digest(realm_import_canonical_row(row_value), 'sha256'), 'hex') AS rd
    FROM jsonb_array_elements(p_rows) AS row_value
  ) AS row_digests;
  IF actual_wire_digest IS DISTINCT FROM expected_wire_digest THEN
    RAISE EXCEPTION 'wire digest mismatch for table %: content does not match registered pack', p_table;
  END IF;
  INSERT INTO realm_import_content_log (
    workspace_id, job_id, attempt_no, table_name, row_count, wire_digest
  ) VALUES (
    p_workspace_id, p_job_id, p_attempt_no, p_table, inserted_count, actual_wire_digest
  );
END;
$realm_import_insert_rows$;

CREATE OR REPLACE FUNCTION realm_import_content_digest(
  p_workspace_id text, p_job_id text, p_attempt_no bigint
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $realm_import_content_digest$
DECLARE
  canonical text;
BEGIN
  IF realm_current_workspace_id() IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'workspace context mismatch';
  END IF;
  -- contentDigest 规范（G.4；向量 8 锚定）：按 name 字节序拼接 name\n rows\n wire_digest\n
  SELECT COALESCE(
    string_agg(table_name || E'\n' || row_count::text || E'\n' || wire_digest || E'\n', ''
               ORDER BY table_name COLLATE "C"),
    ''
  ) INTO canonical
  FROM realm_import_content_log
  WHERE workspace_id = p_workspace_id AND job_id = p_job_id AND attempt_no = p_attempt_no;
  RETURN encode(digest(canonical, 'sha256'), 'hex');
END;
$realm_import_content_digest$;

CREATE OR REPLACE FUNCTION realm_import_job_complete_import(
  p_workspace_id text, p_job_id text, p_attempt_no bigint,
  p_target_world_id text, p_result jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $realm_import_job_complete_import$
DECLARE
  job_pack_hash text;
  job_mode text;
  bound_world text;
  binding_tx bigint;
  binding_worlds_digest text;
  set_mismatch bigint;
  scope_violations bigint;
  next_seq bigint;
BEGIN
  IF realm_current_workspace_id() IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'workspace context mismatch';
  END IF;
  SELECT logical_pack_hash, mode INTO job_pack_hash, job_mode
  FROM realm_import_jobs
  WHERE workspace_id = p_workspace_id AND id = p_job_id
    AND status = 'executing' AND direction = 'import'
    AND current_attempt_no = p_attempt_no
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'realm import job not executing with attempt %: %', p_attempt_no, p_job_id;
  END IF;
  SELECT world_id, tx_id, worlds_wire_digest
    INTO bound_world, binding_tx, binding_worlds_digest
  FROM realm_import_bootstrap
  WHERE workspace_id = p_workspace_id AND job_id = p_job_id
    AND attempt_no = p_attempt_no;
  IF NOT FOUND OR bound_world IS DISTINCT FROM p_target_world_id THEN
    RAISE EXCEPTION 'target world does not match bootstrap binding';
  END IF;
  IF binding_tx <> txid_current() THEN
    RAISE EXCEPTION 'import content transaction mismatch (split tx2 is forbidden)';
  END IF;
  -- target active 最终断言（M4：锁 FOR KEY SHARE；txid 绑定使拆分路径不可达，此为残余防线）
  PERFORM 1 FROM worlds
  WHERE workspace_id = p_workspace_id AND id = bound_world AND status = 'active'
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bootstrap target world is not active';
  END IF;
  -- 三方集合 diff（C1③）：expected ↔ actual 双向集合相等（行数/digest 逐表等值）
  SELECT (
    SELECT count(*) FROM (
      SELECT table_name FROM realm_import_pack_tables
      WHERE workspace_id = p_workspace_id AND job_id = p_job_id
      EXCEPT
      SELECT table_name FROM realm_import_content_log
      WHERE workspace_id = p_workspace_id AND job_id = p_job_id AND attempt_no = p_attempt_no
    ) AS missing
  ) + (
    SELECT count(*) FROM (
      SELECT table_name FROM realm_import_content_log
      WHERE workspace_id = p_workspace_id AND job_id = p_job_id AND attempt_no = p_attempt_no
      EXCEPT
      SELECT table_name FROM realm_import_pack_tables
      WHERE workspace_id = p_workspace_id AND job_id = p_job_id
    ) AS extra
  ) INTO set_mismatch;
  IF set_mismatch <> 0 THEN
    RAISE EXCEPTION 'content set mismatch between expected ledger and actual log';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM realm_import_pack_tables AS expected
    JOIN realm_import_content_log AS actual
      ON actual.workspace_id = expected.workspace_id
     AND actual.job_id = expected.job_id
     AND actual.attempt_no = p_attempt_no
     AND actual.table_name = expected.table_name
    WHERE expected.workspace_id = p_workspace_id AND expected.job_id = p_job_id
      AND (actual.row_count IS DISTINCT FROM expected.expected_rows
           OR actual.wire_digest IS DISTINCT FROM expected.wire_digest)
  ) THEN
    RAISE EXCEPTION 'content rows/digest mismatch between expected ledger and actual log';
  END IF;
  -- scope 矩阵复查（C1③：可导入表每表必须对 job.mode 允许；worlds 为 bootstrap-owned 不在 scope 矩阵）
  SELECT count(*) INTO scope_violations
  FROM realm_import_pack_tables
  WHERE workspace_id = p_workspace_id AND job_id = p_job_id
    AND table_name <> 'worlds'
    AND NOT realm_import_scope_allows(job_mode, table_name);
  IF scope_violations <> 0 THEN
    RAISE EXCEPTION 'registered table violates scope matrix for mode %', job_mode;
  END IF;
  -- bootstrap worlds 行 == ledger worlds 条目（独立等式保留：tx 绑定副本 ↔ expected）
  IF NOT EXISTS (
    SELECT 1 FROM realm_import_pack_tables
    WHERE workspace_id = p_workspace_id AND job_id = p_job_id
      AND table_name = 'worlds' AND expected_rows = 1
      AND wire_digest = binding_worlds_digest
  ) THEN
    RAISE EXCEPTION 'bootstrap world does not match registered worlds entry';
  END IF;
  -- 派生表行数校验（Z44/Z46：trigger 重建行数 == Σcardinality(policy 数组)）
  IF (SELECT count(*) FROM visibility_policy_audiences
      WHERE workspace_id = p_workspace_id AND world_id = bound_world)
     IS DISTINCT FROM
     (SELECT COALESCE(sum(cardinality(audience_character_instance_ids)), 0)
      FROM visibility_policies
      WHERE workspace_id = p_workspace_id AND world_id = bound_world) THEN
    RAISE EXCEPTION 'derived visibility policy audiences row count mismatch';
  END IF;
  IF p_result IS NULL OR p_result = '{}'::jsonb THEN
    RAISE EXCEPTION 'realm import completion requires non-empty result';
  END IF;
  -- result 键集（审计附注并案）：⊆ {targetWorldId, contentHash, contentDigest, report}，前三必填
  IF EXISTS (
    SELECT 1 FROM jsonb_object_keys(p_result) AS k
    WHERE k NOT IN ('targetWorldId', 'contentHash', 'contentDigest', 'report')
  ) OR NOT (p_result ? 'targetWorldId' AND p_result ? 'contentHash' AND p_result ? 'contentDigest')
    OR jsonb_typeof(p_result -> 'targetWorldId') IS DISTINCT FROM 'string'
    OR ((p_result ? 'report') AND jsonb_typeof(p_result -> 'report') IS DISTINCT FROM 'object') THEN
    RAISE EXCEPTION 'realm import completion result key set mismatch';
  END IF;
  IF jsonb_typeof(p_result -> 'contentHash') IS DISTINCT FROM 'string'
    OR jsonb_typeof(p_result -> 'contentDigest') IS DISTINCT FROM 'string'
    OR (p_result ->> 'contentHash') !~ '^[0-9a-f]{64}$'
    OR (p_result ->> 'contentDigest') !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'realm import completion result hash shape mismatch';
  END IF;
  IF (p_result ->> 'targetWorldId') IS DISTINCT FROM p_target_world_id THEN
    RAISE EXCEPTION 'result targetWorldId mismatch';
  END IF;
  IF (p_result ->> 'contentHash') IS DISTINCT FROM job_pack_hash THEN
    RAISE EXCEPTION 'result contentHash does not match job logical_pack_hash';
  END IF;
  IF (p_result ->> 'contentDigest') IS DISTINCT FROM
     realm_import_content_digest(p_workspace_id, p_job_id, p_attempt_no) THEN
    RAISE EXCEPTION 'result contentDigest does not match content log';
  END IF;
  UPDATE realm_import_jobs
  SET status = 'completed', target_world_id = p_target_world_id,
      result = p_result, updated_at = CURRENT_TIMESTAMP
  WHERE workspace_id = p_workspace_id AND id = p_job_id;
  SELECT COALESCE(MAX(event_seq), -1) + 1 INTO next_seq
  FROM realm_import_job_events
  WHERE workspace_id = p_workspace_id AND job_id = p_job_id;
  INSERT INTO realm_import_job_events (workspace_id, id, job_id, event_seq, event_kind, payload)
  VALUES (
    p_workspace_id, 'rje_' || p_job_id || '_' || next_seq, p_job_id, next_seq,
    'import_committed', jsonb_build_object('attemptNo', p_attempt_no)
  );
END;
$realm_import_job_complete_import$;

CREATE OR REPLACE FUNCTION realm_import_job_fail_execute(
  p_workspace_id text, p_job_id text, p_attempt_no bigint,
  p_error_code text, p_error_message text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $realm_import_job_fail_execute$
DECLARE
  next_seq bigint;
BEGIN
  IF realm_current_workspace_id() IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'workspace context mismatch';
  END IF;
  PERFORM 1 FROM realm_import_jobs
  WHERE workspace_id = p_workspace_id AND id = p_job_id
    AND status = 'executing' AND direction = 'import'
    AND current_attempt_no = p_attempt_no
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'realm import job not executing with attempt %: %', p_attempt_no, p_job_id;
  END IF;
  IF p_error_code IS NULL OR btrim(p_error_code) = '' THEN
    RAISE EXCEPTION 'realm import job failure requires error_code';
  END IF;
  -- 孤儿清理（C3：误拆分提交的旧 tx 绑定随失败路径清除；正常 tx2 回滚后无操作）
  PERFORM realm_import_cleanup_orphans(p_workspace_id, p_job_id);
  UPDATE realm_import_jobs
  SET status = 'failed', error_code = p_error_code,
      error_message = p_error_message, updated_at = CURRENT_TIMESTAMP
  WHERE workspace_id = p_workspace_id AND id = p_job_id;
  SELECT COALESCE(MAX(event_seq), -1) + 1 INTO next_seq
  FROM realm_import_job_events
  WHERE workspace_id = p_workspace_id AND job_id = p_job_id;
  INSERT INTO realm_import_job_events (workspace_id, id, job_id, event_seq, event_kind, payload)
  VALUES (
    p_workspace_id, 'rje_' || p_job_id || '_' || next_seq, p_job_id, next_seq,
    'import_attempt_failed',
    jsonb_build_object('attemptNo', p_attempt_no, 'errorCode', p_error_code)
  );
END;
$realm_import_job_fail_execute$;

CREATE OR REPLACE FUNCTION realm_import_job_cancel(
  p_workspace_id text, p_job_id text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $realm_import_job_cancel$
DECLARE
  next_seq bigint;
BEGIN
  IF realm_current_workspace_id() IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'workspace context mismatch';
  END IF;
  PERFORM 1 FROM realm_import_jobs
  WHERE workspace_id = p_workspace_id AND id = p_job_id
    AND status IN ('pending', 'validating', 'staged')
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'realm import job not cancellable: %', p_job_id;
  END IF;
  UPDATE realm_import_jobs
  SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
  WHERE workspace_id = p_workspace_id AND id = p_job_id;
  SELECT COALESCE(MAX(event_seq), -1) + 1 INTO next_seq
  FROM realm_import_job_events
  WHERE workspace_id = p_workspace_id AND job_id = p_job_id;
  INSERT INTO realm_import_job_events (workspace_id, id, job_id, event_seq, event_kind, payload)
  VALUES (
    p_workspace_id, 'rje_' || p_job_id || '_' || next_seq, p_job_id, next_seq,
    'cancelled', '{}'
  );
END;
$realm_import_job_cancel$;

CREATE OR REPLACE FUNCTION realm_import_job_recover_crash(
  p_workspace_id text, p_job_id text, p_reason text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $realm_import_job_recover_crash$
DECLARE
  stale_status text;
  stale_direction text;
  stale_attempt bigint;
  next_seq bigint;
BEGIN
  IF realm_current_workspace_id() IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'workspace context mismatch';
  END IF;
  IF p_reason IS NULL OR p_reason NOT IN ('PROCESS_CRASH', 'CLIENT_DISCONNECTED') THEN
    RAISE EXCEPTION 'realm import job invalid crash reason: %', p_reason;
  END IF;
  SELECT status, direction, current_attempt_no INTO stale_status, stale_direction, stale_attempt
  FROM realm_import_jobs
  WHERE workspace_id = p_workspace_id AND id = p_job_id
    AND (
      (status = 'pending' AND updated_at < CURRENT_TIMESTAMP - interval '30 minutes')
      OR (status = 'validating' AND updated_at < CURRENT_TIMESTAMP - interval '30 minutes')
      OR (status = 'executing' AND updated_at < CURRENT_TIMESTAMP - interval '30 minutes')
    )
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'realm import job not stale: %', p_job_id;
  END IF;
  -- 孤儿清理（C2：仅 import 路径——export 无 bootstrap 概念，helper 前置 direction='import'；
  -- export stale（仅 pending-stale）直接 cancelled，不调 cleanup）
  IF stale_direction = 'import' THEN
    PERFORM realm_import_cleanup_orphans(p_workspace_id, p_job_id);
  END IF;
  IF stale_status IN ('pending', 'validating') THEN
    -- pending/validating-stale → cancelled：不写 error 列、不带 attemptNo
    -- （validating 崩溃不伪装 execute crash——C3）
    UPDATE realm_import_jobs
    SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
    WHERE workspace_id = p_workspace_id AND id = p_job_id;
  ELSE
    UPDATE realm_import_jobs
    SET status = 'failed', error_code = p_reason, updated_at = CURRENT_TIMESTAMP
    WHERE workspace_id = p_workspace_id AND id = p_job_id;
  END IF;
  SELECT COALESCE(MAX(event_seq), -1) + 1 INTO next_seq
  FROM realm_import_job_events
  WHERE workspace_id = p_workspace_id AND job_id = p_job_id;
  INSERT INTO realm_import_job_events (workspace_id, id, job_id, event_seq, event_kind, payload)
  VALUES (
    p_workspace_id, 'rje_' || p_job_id || '_' || next_seq, p_job_id, next_seq,
    'crash_recovered',
    CASE WHEN stale_status = 'executing'
      THEN jsonb_build_object('reason', p_reason, 'attemptNo', stale_attempt)
      ELSE jsonb_build_object('reason', p_reason)
    END
  );
END;
$realm_import_job_recover_crash$;

CREATE OR REPLACE FUNCTION realm_import_job_complete_export(
  p_workspace_id text, p_job_id text, p_result jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $realm_import_job_complete_export$
DECLARE
  job_scope_digest text;
  job_pack_hash text;
  job_mode text;
  next_seq bigint;
BEGIN
  IF realm_current_workspace_id() IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'workspace context mismatch';
  END IF;
  SELECT scope_digest, logical_pack_hash, mode INTO job_scope_digest, job_pack_hash, job_mode
  FROM realm_import_jobs
  WHERE workspace_id = p_workspace_id AND id = p_job_id
    AND status = 'pending' AND direction = 'export'
    AND archive_bytes_hash IS NOT NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'realm export job not pending-export with hash: %', p_job_id;
  END IF;
  IF p_result IS NULL OR p_result = '{}'::jsonb THEN
    RAISE EXCEPTION 'realm export completion requires non-empty result';
  END IF;
  -- result 全 schema（C3：与 H.1/F.4 同一契约 {tables, files, scopeDigest, contentHash}）
  IF EXISTS (
    SELECT 1 FROM jsonb_object_keys(p_result) AS k
    WHERE k NOT IN ('tables', 'files', 'scopeDigest', 'contentHash')
  ) OR NOT (p_result ? 'tables' AND p_result ? 'files'
            AND p_result ? 'scopeDigest' AND p_result ? 'contentHash') THEN
    RAISE EXCEPTION 'realm export result key set mismatch';
  END IF;
  IF jsonb_typeof(p_result -> 'tables') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'realm export result requires tables array';
  END IF;
  -- 表集合绑定（M1：非空/唯一/known-table/rows>=1/含 worlds+worldlines floor；
  -- known-table 复用同一 scope helper，无第二份清单）
  IF jsonb_array_length(p_result -> 'tables') < 1 THEN
    RAISE EXCEPTION 'realm export result tables must be non-empty';
  END IF;
  IF (SELECT count(*) FROM (
        SELECT entry ->> 'name' AS n FROM jsonb_array_elements(p_result -> 'tables') AS entry
        GROUP BY 1 HAVING count(*) > 1
      ) AS dups) > 0 THEN
    RAISE EXCEPTION 'realm export result tables contain duplicate table';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_result -> 'tables') AS entry
    WHERE (entry ->> 'name') <> 'worlds'
      AND NOT realm_import_scope_allows(job_mode, entry ->> 'name')
  ) THEN
    RAISE EXCEPTION 'realm export result contains unknown or out-of-scope table';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_result -> 'tables') AS entry
    WHERE (entry ->> 'rows')::bigint < 1
       OR (entry ->> 'rows')::bigint > 100000
  ) THEN
    RAISE EXCEPTION 'realm export result tables entry rows out of range (1..100000)';
  END IF;
  IF (
    SELECT COALESCE(sum((entry ->> 'rows')::bigint), 0)
    FROM jsonb_array_elements(p_result -> 'tables') AS entry
  ) > 500000 THEN
    RAISE EXCEPTION 'realm export result rows exceed total limit (500000)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_result -> 'tables') AS entry
    WHERE (entry ->> 'name') = 'worlds' AND (entry ->> 'rows') = '1'
  ) OR NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_result -> 'tables') AS entry
    WHERE (entry ->> 'name') = 'worldlines'
  ) THEN
    RAISE EXCEPTION 'realm export result missing required tables (worlds rows=1/worldlines)';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_result -> 'tables') AS result_entry,
         jsonb_object_keys(result_entry.value) AS k
    WHERE k NOT IN ('name', 'rows', 'sha256')
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_result -> 'tables') AS entry
    WHERE NOT (entry ? 'name' AND entry ? 'rows' AND entry ? 'sha256')
       OR jsonb_typeof(entry -> 'name') IS DISTINCT FROM 'string'
       OR btrim(entry ->> 'name') = ''
       OR jsonb_typeof(entry -> 'rows') IS DISTINCT FROM 'number'
       OR (entry ->> 'rows') !~ '^[0-9]+$'
       OR jsonb_typeof(entry -> 'sha256') IS DISTINCT FROM 'string'
       OR (entry ->> 'sha256') !~ '^[0-9a-f]{64}$'
  ) THEN
    RAISE EXCEPTION 'realm export result tables entry shape mismatch';
  END IF;
  IF jsonb_typeof(p_result -> 'files') IS DISTINCT FROM 'number'
    OR (p_result ->> 'files') !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'realm export result files must be a non-negative integer';
  END IF;
  IF jsonb_typeof(p_result -> 'scopeDigest') IS DISTINCT FROM 'string'
    OR (p_result ->> 'scopeDigest') !~ '^[0-9a-f]{64}$'
    OR (p_result ->> 'scopeDigest') IS DISTINCT FROM job_scope_digest THEN
    RAISE EXCEPTION 'result scopeDigest does not match job scope_digest';
  END IF;
  IF jsonb_typeof(p_result -> 'contentHash') IS DISTINCT FROM 'string'
    OR (p_result ->> 'contentHash') !~ '^[0-9a-f]{64}$'
    OR (p_result ->> 'contentHash') IS DISTINCT FROM job_pack_hash THEN
    RAISE EXCEPTION 'result contentHash does not match job logical_pack_hash';
  END IF;
  UPDATE realm_import_jobs
  SET status = 'completed', result = p_result, updated_at = CURRENT_TIMESTAMP
  WHERE workspace_id = p_workspace_id AND id = p_job_id;
  SELECT COALESCE(MAX(event_seq), -1) + 1 INTO next_seq
  FROM realm_import_job_events
  WHERE workspace_id = p_workspace_id AND job_id = p_job_id;
  INSERT INTO realm_import_job_events (workspace_id, id, job_id, event_seq, event_kind, payload)
  VALUES (
    p_workspace_id, 'rje_' || p_job_id || '_' || next_seq, p_job_id, next_seq,
    'export_committed', '{}'
  );
END;
$realm_import_job_complete_export$;

-- ============================== owner gate（C2②：migration 内 fail-closed catalog 断言） ==============================
-- owner 隐含权限不是 ACL grant，REVOKE 不能清除——必须在迁移内断言 owner 结构。
-- SET ROLE 拒绝（对象 owner 取 current_user 语义）；迁移执行者不得为应用角色；
-- 本迁移创建的 ledger 表 owner == current_user；0043 目标表/public schema/database owner ∈ trusted_owner_set。
DO $realm_transfer_owner_gate$
DECLARE
  v_worlds_owner text;
  v_target_owner text;
  v_schema_owner text;
  v_database_owner text;
BEGIN
  IF current_user <> session_user THEN
    RAISE EXCEPTION 'this migration must run without SET ROLE (current_user must equal session_user)';
  END IF;
  -- 应用角色闭包（M2：递归继承；不只排除三个名字）——执行者与各 owner 均不得在闭包内
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
    SELECT 1 FROM app_component WHERE oid = current_user::regrole
  ) THEN
    RAISE EXCEPTION 'migration executor belongs to the application role component: %', current_user;
  END IF;

  -- 期望对象存在性 + owner 取值（C1：NULL fail-closed——先存在性、再 IS NULL、再比较）
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
    SELECT 1 FROM app_component WHERE oid = v_worlds_owner::regrole
  ) THEN
    RAISE EXCEPTION 'worlds owner belongs to the application role component';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname IN (
        'realm_import_jobs', 'realm_import_job_events', 'realm_import_bootstrap',
        'realm_import_content_log', 'realm_import_pack_tables')
      AND c.relowner <> current_user::regrole
  ) THEN
    RAISE EXCEPTION 'ledger table owner is not the migration executor';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'propagation_node_audiences'
  ) THEN
    RAISE EXCEPTION 'expected relation missing: public.propagation_node_audiences';
  END IF;
  SELECT c.relowner::regrole::text INTO v_target_owner
  FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'propagation_node_audiences';
  IF v_target_owner IS NULL THEN
    RAISE EXCEPTION 'propagation_node_audiences owner could not be determined';
  END IF;
  IF v_target_owner IS DISTINCT FROM v_worlds_owner THEN
    RAISE EXCEPTION 'propagation_node_audiences owner differs from worlds owner';
  END IF;

  SELECT n.nspowner::regrole::text INTO v_schema_owner
  FROM pg_namespace AS n WHERE n.nspname = 'public';
  IF v_schema_owner IS NULL THEN
    RAISE EXCEPTION 'public schema owner could not be determined';
  END IF;
  IF v_schema_owner IS DISTINCT FROM v_worlds_owner
    AND v_schema_owner IS DISTINCT FROM current_user
    AND NOT (
      v_schema_owner = 'pg_database_owner'
      AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pg_database_owner')
    ) THEN
    RAISE EXCEPTION 'public schema owner is not in the trusted owner set: %', v_schema_owner;
  END IF;

  SELECT d.datdba::regrole::text INTO v_database_owner
  FROM pg_database AS d WHERE d.datname = current_database();
  IF v_database_owner IS NULL THEN
    RAISE EXCEPTION 'database owner could not be determined';
  END IF;
  IF v_database_owner IS DISTINCT FROM v_worlds_owner
    AND v_database_owner IS DISTINCT FROM current_user
    AND NOT (
      v_database_owner = 'pg_database_owner'
      AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pg_database_owner')
    ) THEN
    RAISE EXCEPTION 'database owner is not in the trusted owner set: %', v_database_owner;
  END IF;

  -- 全部 owner 负向闭包断言（C4：current_user 与 worlds 已分别断言；
  -- target/schema/database owner 同样不得属 app_component）
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
    SELECT 1 FROM app_component
    WHERE oid IN (v_target_owner::regrole, v_schema_owner::regrole, v_database_owner::regrole)
  ) THEN
    RAISE EXCEPTION 'an owner belongs to the application role component';
  END IF;

  -- 闭包内 superuser/bypassrls 拒绝（C4：成员闭包使普通 REVOKE 失效的路径）
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
    SELECT 1 FROM app_component AS ac
    JOIN pg_roles AS r ON r.oid = ac.oid
    WHERE r.rolsuper OR r.rolbypassrls
  ) THEN
    RAISE EXCEPTION 'application role component contains superuser or bypassrls role';
  END IF;
END;
$realm_transfer_owner_gate$;

-- ============================== RLS ==============================

ALTER TABLE realm_import_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE realm_import_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON realm_import_jobs;
CREATE POLICY realm_workspace_isolation ON realm_import_jobs
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

ALTER TABLE realm_import_job_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE realm_import_job_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON realm_import_job_events;
CREATE POLICY realm_workspace_isolation ON realm_import_job_events
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

ALTER TABLE realm_import_bootstrap ENABLE ROW LEVEL SECURITY;
ALTER TABLE realm_import_bootstrap FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON realm_import_bootstrap;
CREATE POLICY realm_workspace_isolation ON realm_import_bootstrap
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

ALTER TABLE realm_import_content_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE realm_import_content_log FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON realm_import_content_log;
CREATE POLICY realm_workspace_isolation ON realm_import_content_log
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

ALTER TABLE realm_import_pack_tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE realm_import_pack_tables FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON realm_import_pack_tables;
CREATE POLICY realm_workspace_isolation ON realm_import_pack_tables
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

-- ============================== REVOKE / GRANT（最终签名列表） ==============================

-- temp/public shadowing 闭合（C1②③ + C2①：PUBLIC 与显式角色同列，不依赖「从未授予」）：
-- 兼容性审计 Z62——应用角色零 CREATE TABLE / 零 TEMPORARY 使用；runner 以 owner 执行不受影响。
REVOKE CREATE ON SCHEMA public FROM PUBLIC, realm_runtime, realm_control, realm_transfer;

DO $realm_transfer_temp_lockdown$
BEGIN
  -- PG 不支持从单角色 REVOKE 经 PUBLIC 授予的 TEMPORARY；PUBLIC 与显式角色一并撤（数据库级，动态库名）
  EXECUTE format(
    'REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC, realm_runtime, realm_control, realm_transfer',
    current_database());
END;
$realm_transfer_temp_lockdown$;

REVOKE ALL ON realm_import_jobs, realm_import_job_events, realm_import_bootstrap, realm_import_content_log, realm_import_pack_tables
  FROM PUBLIC, realm_runtime, realm_control, realm_transfer;

-- 列级 mutation 自包含闭合（C2②：IF NOT EXISTS/ACL 漂移场景的 direct column grant 清除；
-- 逐列 INSERT/UPDATE/REFERENCES——保留 SELECT；列集由 information_schema 动态生成，漂移自适应）
DO $realm_transfer_column_lockdown$
DECLARE
  ledger_table text;
  ledger_column text;
BEGIN
  FOR ledger_table IN
    SELECT unnest(ARRAY[
      'realm_import_jobs', 'realm_import_job_events', 'realm_import_bootstrap',
      'realm_import_content_log', 'realm_import_pack_tables'])
  LOOP
    FOR ledger_column IN
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ledger_table
    LOOP
      EXECUTE format(
        'REVOKE INSERT (%I), UPDATE (%I), REFERENCES (%I) ON TABLE public.%I FROM PUBLIC, realm_runtime, realm_control, realm_transfer',
        ledger_column, ledger_column, ledger_column, ledger_table);
    END LOOP;
  END LOOP;
END;
$realm_transfer_column_lockdown$;
REVOKE ALL ON FUNCTION
  guard_realm_import_jobs_insert(),
  guard_realm_import_job_events_insert(),
  guard_realm_import_job_events_append_only(),
  guard_realm_import_jobs_mutation(),
  realm_import_canonical_row(jsonb),
  realm_import_scope_allows(text,text),
  realm_import_scope_required(text),
  realm_import_cleanup_orphans(text,text),
  realm_import_job_create(text,text,text,text,text,text,text,text,text,text,text),
  realm_import_job_begin_validation(text,text),
  realm_import_register_pack_tables(text,text,jsonb),
  realm_import_job_finish_validation(text,text,text,text,text,jsonb),
  realm_import_job_begin_execute(text,text),
  realm_import_begin_bootstrap(text,text,bigint,text,jsonb),
  realm_import_insert_rows(text,text,bigint,text,jsonb),
  realm_import_content_digest(text,text,bigint),
  realm_import_job_complete_import(text,text,bigint,text,jsonb),
  realm_import_job_fail_execute(text,text,bigint,text,text),
  realm_import_job_cancel(text,text),
  realm_import_job_recover_crash(text,text,text),
  realm_import_job_complete_export(text,text,jsonb)
FROM PUBLIC, realm_runtime, realm_control, realm_transfer;

GRANT USAGE ON SCHEMA public TO realm_transfer;

GRANT SELECT ON
  worlds, worldlines, stories, records, scenes,
  character_definitions, character_continuities, character_instances,
  player_world_memberships, participants,
  visibility_policies, visibility_policy_audiences,
  events, record_heads, observations,
  memory_conclusions, memory_snapshots, memory_cache_epochs,
  skill_definitions, character_skills,
  asset_definitions, character_assets
TO realm_transfer;

GRANT SELECT ON
  effect_definitions, action_receipts, character_effects, relationship_states,
  world_entities, world_claims, world_relations, world_articles, causal_edges,
  canon_proposals, canon_revisions, canon_revision_audiences,
  information_campaigns, information_packets, propagation_exposures,
  propagation_nodes, propagation_routes, propagation_node_audiences,
  worldline_merges, article_qualifications, article_import_entries, world_files
TO realm_transfer;

GRANT SELECT ON
  realm_import_jobs, realm_import_job_events,
  realm_import_bootstrap, realm_import_content_log, realm_import_pack_tables
TO realm_transfer;

GRANT EXECUTE ON FUNCTION
  realm_import_job_create(text,text,text,text,text,text,text,text,text,text,text),
  realm_import_job_begin_validation(text,text),
  realm_import_register_pack_tables(text,text,jsonb),
  realm_import_job_finish_validation(text,text,text,text,text,jsonb),
  realm_import_job_begin_execute(text,text),
  realm_import_begin_bootstrap(text,text,bigint,text,jsonb),
  realm_import_insert_rows(text,text,bigint,text,jsonb),
  realm_import_content_digest(text,text,bigint),
  realm_import_job_complete_import(text,text,bigint,text,jsonb),
  realm_import_job_fail_execute(text,text,bigint,text,text),
  realm_import_job_cancel(text,text),
  realm_import_job_recover_crash(text,text,text),
  realm_import_job_complete_export(text,text,jsonb)
TO realm_transfer;

-- ============================== 提交前 ACL gate（M1：本事务提交前闭合；失败即整体回滚） ==============================
DO $realm_transfer_acl_gate$
DECLARE
  closure_role text;
  ledger_table text;
  ledger_column text;
  func_sig text;
  func_owner text;
  v_worlds_owner text;
  bad_grant RECORD;
BEGIN
  -- 0. worlds owner（proowner 受信集合锚点；NULL fail-closed）
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

  -- A. 应用组件（C1：双向 connected component，循环安全；
  --    has_*_privilege 含 rolinherit 有效语义——Z67）
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
      'realm_import_content_log', 'realm_import_pack_tables']
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

  -- B1. ledger 表 ACL allowlist（aclexplode：仅允许 realm_transfer 的 SELECT）
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

  -- B2. schema/database 显式 ACL allowlist（C2 同构：CREATE/TEMPORARY 零 grantee）
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

  -- C1. 函数存在性 / proacl / proowner（23 签名冻结；owner 受信且 ∉ 组件）
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

  -- C2. 函数 ACL 逐类 allowlist（C1②：13 受控仅 realm_transfer；8 内部 + 中间态 append 零 grant）
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
      'guard_realm_import_jobs_mutation()',
      'append_propagation_node_audience(text,text,text,text,text,text)']::regprocedure[])
      -- 函数 owner 的物化 EXECUTE（REVOKE 在 NULL proacl 上实例化默认 ACL）不是 grant——排除
      AND NOT (acl.grantee = p.proowner AND acl.grantor = p.proowner)
  LOOP
    RAISE EXCEPTION 'acl gate: unexpected grant on internal/intermediate function % to %',
      bad_grant.f, bad_grant.g;
  END LOOP;

  -- C3. component × 函数 effective 互证（C1④：显式 ACL 与有效权限一致性）
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
          'realm_import_job_complete_export(text,text,jsonb)')) THEN
        RAISE EXCEPTION 'acl gate: % has effective EXECUTE on %', closure_role, func_sig;
      END IF;
    END LOOP;
  END LOOP;

  -- D. default ACL（C3：creator=闭包 ∪ current_user；grantee=闭包/PUBLIC；global/per-schema 全类型）
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
$realm_transfer_acl_gate$;
