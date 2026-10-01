-- REALM M5 membership capability 窄通道（0053）：把 player_world_memberships 的
-- 写入收成一条可验证的窄 capability 通道，并以**会话证明**作为 actor 的
-- 数据库可验证信任锚。
--
-- 信任拓扑（M5-WORLD-GOVERNANCE §5.1）：
-- - actor 绑定：mint/grant 必须携带会话证明（= 当前会话 cookie 值
--   `principal.expiresAt.hmac`）。DB 用库内保存的会话密钥副本
--   （realm_capability_keys purpose='session'）独立重算 HMAC 校验并**从证明
--   推导 actor**；调用方传入的 principal 只作一致性比对，不具授权效力。
--   会话密钥对 realm_runtime 零可读（仅 definer owner 读），不出现在
--   代码/日志/文档；proof 不落库（nonces 只记 principal/op）。
-- - 会话密钥来源 = 应用会话签名密钥（REALM_SESSION_SECRET 或安装级 0600
--   文件）经 provision/首次写入同步进库；runtime SQL 持有者无法读取或替换
--   （轮换需持现行密钥证明）。该锚的强度=登录策略强度：无密码账户的会话
--   证明只证明"应用按其策略签发过会话"（产品语义，见 §5.1 文档）。
-- - workspace 绑定：RLS GUC（realm.workspace_id）显式比对 + FORCE RLS；
--   GUC 只作 scope 约束，不作 actor 依据。
--
-- 结构：
-- - realm_capability：NOLOGIN/NOSUPERUSER/NOBYPASSRLS/NOINHERIT 角色，仅作为
--   SECURITY DEFINER 函数 owner；不拥有任何受保护表。
-- - realm_capability_keys（purpose='capability'|'session'）：capability 签名
--   key 首次 mint 库内随机自举；session key 只能由可信 provisioning 权威
--   （scripts/local-provision-capability-session.mjs，owner/provisioning 连接）
--   写入——runtime 没有任何 key provisioning/bootstrap 入口（首写即信任
--   锚建立，绝不给 runtime 首写权）。realm_runtime 零表授权。
-- - realm_capability_nonces：nonce 与受保护写同事务原子消费；重放 =
--   CAPABILITY_REPLAY；写回滚则消费同样回滚（可安全重试）。
-- - 可调用面收窄：runtime 只有组合入口 membership_capability_grant 的
--   EXECUTE；mint/apply 是 DB 内部子操作（runtime 无 EXECUTE，EXECUTE 不授
--   PUBLIC；内部调用按 definer owner 权限）。
-- - realm_runtime 被撤销 memberships 的 INSERT 与 UPDATE(role)。合法剩余
--   入口：本通道（runtime）、0042 导入执行器（realm_transfer，operator 绑定
--   的受控 bootstrap）、seed/迁移（owner 池）。
--
-- 合法 op 语义（产品语义锁定）：
-- - join_player：登录/大厅加入；role 恒 player；insert-if-absent，ON CONFLICT
--   不改写既有 owner。
-- - genesis_creator：只有新世界（零既有 membership）的创建者拿 owner/
--   observer；worldline 若给出必须属于该 world（否则拒绝）。
-- - stance_self：actor 只能改自己的 membership，role 仅 player↔observer，
--   目标行内容经 DB 侧规范化 hash 绑定（mint/apply 间并发变更被拒）。

-- 依赖 pgcrypto（hmac/digest/gen_random_bytes）；0041 已建则幂等。
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 角色：NOLOGIN 能力主体（不拥有受保护表、不继承任何应用角色）。
DO $realm_capability_role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'realm_capability') THEN
    EXECUTE 'CREATE ROLE realm_capability NOLOGIN NOSUPERUSER NOCREATEDB '
      || 'NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  ELSE
    EXECUTE 'ALTER ROLE realm_capability WITH NOLOGIN NOSUPERUSER NOCREATEDB '
      || 'NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  END IF;
END;
$realm_capability_role$;

CREATE TABLE IF NOT EXISTS realm_capability_keys (
  workspace_id text NOT NULL,
  kid text NOT NULL,
  key bytea NOT NULL,
  purpose text NOT NULL DEFAULT 'capability',
  status text NOT NULL DEFAULT 'active',
  not_before timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, kid),
  CONSTRAINT realm_capability_keys_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
  CHECK (purpose IN ('capability', 'session')),
  CHECK (status IN ('active', 'retired', 'revoked')),
  CHECK (length(key) >= 32)
);

CREATE TABLE IF NOT EXISTS realm_capability_nonces (
  workspace_id text NOT NULL,
  nonce text NOT NULL,
  kid text NOT NULL,
  op text NOT NULL,
  principal_id text NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, nonce),
  CONSTRAINT realm_capability_nonces_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE
);

-- 同一 workspace 至多一条 active 会话密钥（provisioning 唯一首写）；
-- retired/revoked 不在约束内（轮换历史保留）。
CREATE UNIQUE INDEX IF NOT EXISTS realm_capability_single_active_session_key
  ON realm_capability_keys (workspace_id)
  WHERE purpose = 'session' AND status = 'active';

ALTER TABLE realm_capability_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE realm_capability_keys FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON realm_capability_keys;
CREATE POLICY realm_workspace_isolation ON realm_capability_keys
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

ALTER TABLE realm_capability_nonces ENABLE ROW LEVEL SECURITY;
ALTER TABLE realm_capability_nonces FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS realm_workspace_isolation ON realm_capability_nonces;
CREATE POLICY realm_workspace_isolation ON realm_capability_nonces
  USING (workspace_id = realm_current_workspace_id())
  WITH CHECK (workspace_id = realm_current_workspace_id());

-- realm_capability 只拿执行窄路径所需的最小表权限。
GRANT USAGE ON SCHEMA public TO realm_capability;
GRANT SELECT, INSERT ON realm_capability_keys TO realm_capability;
GRANT SELECT, INSERT ON realm_capability_nonces TO realm_capability;
GRANT SELECT, INSERT, UPDATE (role) ON player_world_memberships TO realm_capability;
-- genesis_creator 的世界存在性校验与 worldline 归属校验。
GRANT SELECT ON worlds TO realm_capability;
GRANT SELECT ON worldlines TO realm_capability;

-- 关闭 realm_runtime 的直接写入（0013 的 INSERT、0023 的 UPDATE(role)）。
REVOKE INSERT ON player_world_memberships FROM realm_runtime;
REVOKE UPDATE (role) ON player_world_memberships FROM realm_runtime;

-- ---- 内部助手：规范化 row hash（DB 侧唯一来源，绝不信任调用方计算） ----
CREATE OR REPLACE FUNCTION realm_membership_row_hash(
  p_workspace_id text,
  p_world_id text,
  p_principal_id text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  row_role text;
  row_omniscient boolean;
  row_can_view boolean;
BEGIN
  SELECT membership.role,
         membership.omniscient_player_character,
         membership.can_view_dynamic_knowledge
  INTO row_role, row_omniscient, row_can_view
  FROM player_world_memberships AS membership
  WHERE membership.workspace_id = p_workspace_id
    AND membership.world_id = p_world_id
    AND membership.principal_id = p_principal_id;
  IF NOT FOUND THEN
    RETURN 'absent';
  END IF;
  RETURN encode(digest(
    concat_ws('|', p_workspace_id, p_world_id, p_principal_id,
              row_role, row_omniscient::text, row_can_view::text),
    'sha256'), 'hex');
END;
$$;

-- ---- 会话证明验证（内部）：从 DB 持有的会话密钥副本独立重算 HMAC，
-- 从证明推导 actor；无密钥/签名不符/过期一律拒绝 ----
CREATE OR REPLACE FUNCTION realm_capability_session_actor(
  p_proof text,
  p_workspace_id text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_parts text[];
  v_principal text;
  v_expires_at bigint;
  v_signature text;
  v_key bytea;
  v_payload text;
BEGIN
  IF p_proof IS NULL OR btrim(p_proof) = '' THEN
    RAISE EXCEPTION 'CAPABILITY_SESSION_PROOF_REQUIRED';
  END IF;
  v_parts := string_to_array(p_proof, '.');
  IF array_length(v_parts, 1) IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'CAPABILITY_SESSION_PROOF_INVALID';
  END IF;
  v_principal := v_parts[1];
  v_expires_at := v_parts[2]::bigint;
  v_signature := v_parts[3];
  IF v_principal IS NULL OR v_principal = '' OR NOT v_principal LIKE 'principal\_%' THEN
    RAISE EXCEPTION 'CAPABILITY_SESSION_PROOF_INVALID';
  END IF;
  IF floor(extract(epoch from now()) * 1000)::bigint >= v_expires_at THEN
    RAISE EXCEPTION 'CAPABILITY_SESSION_EXPIRED';
  END IF;
  SELECT key.key INTO v_key
  FROM realm_capability_keys AS key
  WHERE key.workspace_id = p_workspace_id
    AND key.purpose = 'session'
    AND key.status IN ('active', 'retired')
    AND key.not_before <= now()
  ORDER BY key.created_at DESC, key.kid DESC
  LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CAPABILITY_SESSION_KEY_MISSING';
  END IF;
  v_payload := v_principal || '.' || v_expires_at::text;
  IF NOT hmac(convert_to(v_payload, 'utf8'), v_key, 'sha256') = decode(v_signature, 'hex') THEN
    RAISE EXCEPTION 'CAPABILITY_SESSION_PROOF_INVALID';
  END IF;
  RETURN v_principal;
END;
$$;

-- ---- mint：会话证明 → actor；语义校验；签发票据（DB 内部子操作） ----
CREATE OR REPLACE FUNCTION membership_capability_mint(
  p_session_proof text,
  p_op text,
  p_workspace_id text,
  p_world_id text,
  p_worldline_id text,
  p_principal_id text,
  p_role text,
  p_ttl_ms integer DEFAULT 30000
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor text;
  v_kid text;
  v_key bytea;
  v_nonce text;
  v_nbf_ms bigint;
  v_exp_ms bigint;
  v_row_hash text;
  v_payload text;
  v_signed text;
  v_signature text;
BEGIN
  IF p_op IS NULL OR p_workspace_id IS NULL OR p_world_id IS NULL
     OR p_principal_id IS NULL OR p_role IS NULL THEN
    RAISE EXCEPTION 'CAPABILITY_INVALID_INPUT';
  END IF;
  IF realm_current_workspace_id() IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'CAPABILITY_SCOPE_REQUIRED';
  END IF;
  IF p_ttl_ms IS NULL OR p_ttl_ms < 1000 OR p_ttl_ms > 120000 THEN
    RAISE EXCEPTION 'CAPABILITY_TTL_OUT_OF_RANGE';
  END IF;
  -- actor 唯一来源 = 经验证的会话证明；调用方 principal 只作一致性比对。
  v_actor := realm_capability_session_actor(p_session_proof, p_workspace_id);
  IF p_principal_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'CAPABILITY_ACTOR_MISMATCH';
  END IF;
  -- worldline 绑定必须真实：给出即须属于该 world（不接受装饰字段）。
  IF p_worldline_id IS NOT NULL AND p_worldline_id <> '' AND NOT EXISTS (
    SELECT 1 FROM worldlines AS line
    WHERE line.workspace_id = p_workspace_id
      AND line.world_id = p_world_id
      AND line.id = p_worldline_id
  ) THEN
    RAISE EXCEPTION 'CAPABILITY_WORLDLINE_MISMATCH';
  END IF;

  -- op 语义门禁（发行侧；apply 侧复检同规则）。
  IF p_op = 'join_player' THEN
    IF p_role <> 'player' THEN
      RAISE EXCEPTION 'CAPABILITY_ROLE_NOT_ALLOWED';
    END IF;
    v_row_hash := 'insert-if-absent';
  ELSIF p_op = 'genesis_creator' THEN
    -- 首成员角色：入局 owner / 观察者姿态 observer（批次 S 语义）。
    IF p_role NOT IN ('owner', 'observer') THEN
      RAISE EXCEPTION 'CAPABILITY_ROLE_NOT_ALLOWED';
    END IF;
    IF EXISTS (
      SELECT 1 FROM player_world_memberships AS membership
      WHERE membership.workspace_id = p_workspace_id
        AND membership.world_id = p_world_id
    ) THEN
      RAISE EXCEPTION 'CAPABILITY_WORLD_ALREADY_HAS_MEMBERS';
    END IF;
    v_row_hash := 'absent';
  ELSIF p_op = 'stance_self' THEN
    IF p_role NOT IN ('player', 'observer') THEN
      RAISE EXCEPTION 'CAPABILITY_ROLE_NOT_ALLOWED';
    END IF;
    -- stance 通道永不产生 owner（防升级）；既有 owner 自降/往返是
    -- 既有产品语义（library-permissions 矩阵覆盖），不在此阻断。
    v_row_hash := realm_membership_row_hash(p_workspace_id, p_world_id, p_principal_id);
    IF v_row_hash = 'absent' THEN
      RAISE EXCEPTION 'CAPABILITY_TARGET_ROW_MISSING';
    END IF;
  ELSE
    RAISE EXCEPTION 'CAPABILITY_UNKNOWN_OP';
  END IF;

  -- capability 签名 key：缺则库内随机自举（串行化并发首次自举）。
  PERFORM pg_advisory_xact_lock(hashtext('capkey:' || p_workspace_id)::bigint);
  SELECT key.kid, key.key INTO v_kid, v_key
  FROM realm_capability_keys AS key
  WHERE key.workspace_id = p_workspace_id AND key.purpose = 'capability'
    AND key.status = 'active'
  ORDER BY key.created_at DESC, key.kid DESC
  LIMIT 1;
  IF NOT FOUND THEN
    v_kid := 'k' || replace(gen_random_uuid()::text, '-', '');
    v_key := gen_random_bytes(32);
    INSERT INTO realm_capability_keys (workspace_id, kid, key, purpose, status)
    VALUES (p_workspace_id, v_kid, v_key, 'capability', 'active');
  END IF;

  v_nonce := gen_random_uuid()::text;
  v_nbf_ms := floor(extract(epoch from now()) * 1000)::bigint;
  v_exp_ms := v_nbf_ms + p_ttl_ms;
  v_payload := json_build_object(
    'op', p_op,
    'workspace', p_workspace_id,
    'world', p_world_id,
    'worldline', coalesce(p_worldline_id, ''),
    'principal', v_actor,
    'role', p_role,
    'rowHash', v_row_hash
  )::text;
  v_signed := concat_ws(E'\n', 'mcb1', v_payload, v_nbf_ms::text, v_exp_ms::text, v_nonce, v_kid);
  v_signature := encode(hmac(convert_to(v_signed, 'utf8'), v_key, 'sha256'), 'hex');
  RETURN concat_ws('.', 'mcb1', v_kid, v_nonce, v_nbf_ms::text, v_exp_ms::text,
                   replace(encode(v_payload::bytea, 'base64'), E'\n', ''), v_signature);
END;
$$;

-- ---- apply：只接受票据；actor/scope/op/role/rowHash 全部由票据推导（DB 内部子操作） ----
CREATE OR REPLACE FUNCTION membership_capability_apply(
  p_capability text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_parts text[];
  v_kid text;
  v_nonce text;
  v_nbf_ms bigint;
  v_exp_ms bigint;
  v_payload text;
  v_signature text;
  v_key bytea;
  v_key_status text;
  v_key_nbf timestamptz;
  v_signed text;
  v_op text;
  v_workspace text;
  v_world text;
  v_worldline text;
  v_principal text;
  v_role text;
  v_row_hash text;
  v_live_hash text;
BEGIN
  IF p_capability IS NULL OR btrim(p_capability) = '' THEN
    RAISE EXCEPTION 'CAPABILITY_REQUIRED';
  END IF;
  v_parts := string_to_array(p_capability, '.');
  IF array_length(v_parts, 1) IS DISTINCT FROM 7 OR v_parts[1] <> 'mcb1' THEN
    RAISE EXCEPTION 'CAPABILITY_MALFORMED';
  END IF;
  v_kid := v_parts[2];
  v_nonce := v_parts[3];
  v_nbf_ms := v_parts[4]::bigint;
  v_exp_ms := v_parts[5]::bigint;
  v_payload := convert_from(decode(v_parts[6], 'base64'), 'utf8');
  v_signature := v_parts[7];

  SELECT key.key, key.status, key.not_before INTO v_key, v_key_status, v_key_nbf
  FROM realm_capability_keys AS key
  WHERE key.kid = v_kid AND key.purpose = 'capability';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CAPABILITY_UNKNOWN_KID';
  END IF;
  IF v_key_status = 'revoked' THEN
    RAISE EXCEPTION 'CAPABILITY_KID_REVOKED';
  END IF;
  IF v_key_status <> 'active' AND v_key_status <> 'retired' THEN
    RAISE EXCEPTION 'CAPABILITY_UNKNOWN_KID';
  END IF;
  IF now() < v_key_nbf THEN
    RAISE EXCEPTION 'CAPABILITY_KID_NOT_YET_VALID';
  END IF;

  -- 时间窗口（nbf/exp 都在票据签名内）。
  IF floor(extract(epoch from now()) * 1000)::bigint < v_nbf_ms THEN
    RAISE EXCEPTION 'CAPABILITY_NOT_YET_VALID';
  END IF;
  IF floor(extract(epoch from now()) * 1000)::bigint > v_exp_ms THEN
    RAISE EXCEPTION 'CAPABILITY_EXPIRED';
  END IF;

  v_signed := concat_ws(E'\n', 'mcb1', v_payload, v_nbf_ms::text, v_exp_ms::text, v_nonce, v_kid);
  IF NOT hmac(convert_to(v_signed, 'utf8'), v_key, 'sha256') = decode(v_signature, 'hex') THEN
    RAISE EXCEPTION 'CAPABILITY_SIGNATURE_MISMATCH';
  END IF;

  -- 从已验证 payload 推导全部字段（无任何独立身份入参）。
  v_op := v_payload::json ->> 'op';
  v_workspace := v_payload::json ->> 'workspace';
  v_world := v_payload::json ->> 'world';
  v_worldline := v_payload::json ->> 'worldline';
  v_principal := v_payload::json ->> 'principal';
  v_role := v_payload::json ->> 'role';
  v_row_hash := v_payload::json ->> 'rowHash';
  IF v_op IS NULL OR v_workspace IS NULL OR v_world IS NULL
     OR v_principal IS NULL OR v_role IS NULL OR v_row_hash IS NULL THEN
    RAISE EXCEPTION 'CAPABILITY_MALFORMED';
  END IF;
  IF realm_current_workspace_id() IS DISTINCT FROM v_workspace THEN
    RAISE EXCEPTION 'CAPABILITY_SCOPE_REQUIRED';
  END IF;

  -- worldline 绑定复检（给出即须属于该 world；对所有 op 一致）。
  IF v_worldline IS NOT NULL AND v_worldline <> '' AND NOT EXISTS (
    SELECT 1 FROM worldlines AS line
    WHERE line.workspace_id = v_workspace
      AND line.world_id = v_world
      AND line.id = v_worldline
  ) THEN
    RAISE EXCEPTION 'CAPABILITY_WORLDLINE_MISMATCH';
  END IF;

  -- 语义复检（与 mint 同规则；mint 也是 runtime 可调，不能信任发行侧）。
  IF v_op = 'join_player' THEN
    IF v_role <> 'player' OR v_row_hash <> 'insert-if-absent' THEN
      RAISE EXCEPTION 'CAPABILITY_ROLE_NOT_ALLOWED';
    END IF;
  ELSIF v_op = 'genesis_creator' THEN
    IF v_role NOT IN ('owner', 'observer') OR v_row_hash <> 'absent' THEN
      RAISE EXCEPTION 'CAPABILITY_ROLE_NOT_ALLOWED';
    END IF;
  ELSIF v_op = 'stance_self' THEN
    IF v_role NOT IN ('player', 'observer') THEN
      RAISE EXCEPTION 'CAPABILITY_ROLE_NOT_ALLOWED';
    END IF;
  ELSE
    RAISE EXCEPTION 'CAPABILITY_UNKNOWN_OP';
  END IF;

  -- nonce 同事务原子消费：重放 = 稳定 CAPABILITY_REPLAY = 整个写事务回滚。
  BEGIN
    INSERT INTO realm_capability_nonces (workspace_id, nonce, kid, op, principal_id)
    VALUES (v_workspace, v_nonce, v_kid, v_op, v_principal);
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'CAPABILITY_REPLAY';
  END;

  IF v_op = 'join_player' THEN
    -- insert-if-absent；ON CONFLICT 不改写既有任何角色（含 owner）。
    INSERT INTO player_world_memberships (
      workspace_id, world_id, principal_id, role,
      omniscient_player_character, can_view_dynamic_knowledge
    ) VALUES (v_workspace, v_world, v_principal, 'player', true, true)
    ON CONFLICT (workspace_id, world_id, principal_id) DO NOTHING;
    RETURN true;
  ELSIF v_op = 'genesis_creator' THEN
    -- 串行化同一世界的并发创世（advisory xact lock，不依赖表锁权限）；
    -- 锁后重读保证只有首个创建者拿 owner。
    PERFORM pg_advisory_xact_lock(hashtext(v_workspace || ':' || v_world)::bigint);
    IF NOT EXISTS (
      SELECT 1 FROM worlds AS world
      WHERE world.workspace_id = v_workspace AND world.id = v_world
    ) THEN
      RAISE EXCEPTION 'CAPABILITY_WORLD_NOT_FOUND';
    END IF;
    IF EXISTS (
      SELECT 1 FROM player_world_memberships AS membership
      WHERE membership.workspace_id = v_workspace AND membership.world_id = v_world
    ) THEN
      RAISE EXCEPTION 'CAPABILITY_WORLD_ALREADY_HAS_MEMBERS';
    END IF;
    INSERT INTO player_world_memberships (
      workspace_id, world_id, principal_id, role,
      omniscient_player_character, can_view_dynamic_knowledge
    ) VALUES (v_workspace, v_world, v_principal, v_role, true, true)
    ON CONFLICT (workspace_id, world_id, principal_id) DO NOTHING;
    RETURN true;
  ELSE
    -- stance_self：锁目标行并重算 hash；mint 后任何并发变更都被拒。
    SELECT realm_membership_row_hash(v_workspace, v_world, v_principal)
    INTO v_live_hash
    FROM player_world_memberships AS membership
    WHERE membership.workspace_id = v_workspace
      AND membership.world_id = v_world
      AND membership.principal_id = v_principal
    FOR UPDATE;
    IF v_live_hash IS NULL THEN
      RAISE EXCEPTION 'CAPABILITY_TARGET_ROW_MISSING';
    END IF;
    IF v_live_hash IS DISTINCT FROM v_row_hash THEN
      RAISE EXCEPTION 'CAPABILITY_ROW_CHANGED';
    END IF;
    UPDATE player_world_memberships
    SET role = v_role
    WHERE workspace_id = v_workspace
      AND world_id = v_world
      AND principal_id = v_principal;
    RETURN true;
  END IF;
END;
$$;

-- ---- canon 治理用 owner 断言：runtime 无 UPDATE 权限不能自行加行锁；
-- 锁由 definer 取得（与并发 stance 角色变更互斥到提交），锁内复检角色 ----
CREATE OR REPLACE FUNCTION membership_assert_world_owner(
  p_workspace_id text,
  p_world_id text,
  p_principal_id text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_role text;
BEGIN
  IF p_workspace_id IS NULL OR p_world_id IS NULL OR p_principal_id IS NULL THEN
    RAISE EXCEPTION 'CAPABILITY_INVALID_INPUT';
  END IF;
  IF realm_current_workspace_id() IS DISTINCT FROM p_workspace_id THEN
    RAISE EXCEPTION 'CAPABILITY_SCOPE_REQUIRED';
  END IF;
  SELECT membership.role INTO v_role
  FROM player_world_memberships AS membership
  WHERE membership.workspace_id = p_workspace_id
    AND membership.world_id = p_world_id
    AND membership.principal_id = p_principal_id
  FOR UPDATE;
  IF v_role IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'PROPAGATION_SECURITY_UNAVAILABLE';
  END IF;
  RETURN true;
END;
$$;

-- ---- 组合入口：runtime 唯一可调的窄通道（mint+apply 同事务，票据不出库） ----
CREATE OR REPLACE FUNCTION membership_capability_grant(
  p_session_proof text,
  p_op text,
  p_workspace_id text,
  p_world_id text,
  p_worldline_id text,
  p_principal_id text,
  p_role text,
  p_ttl_ms integer DEFAULT 30000
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN membership_capability_apply(
    membership_capability_mint(
      p_session_proof, p_op, p_workspace_id, p_world_id, p_worldline_id,
      p_principal_id, p_role, p_ttl_ms
    )
  );
END;
$$;

ALTER FUNCTION realm_membership_row_hash(text, text, text) OWNER TO realm_capability;
ALTER FUNCTION realm_capability_session_actor(text, text) OWNER TO realm_capability;
ALTER FUNCTION membership_capability_mint(text, text, text, text, text, text, text, integer) OWNER TO realm_capability;
ALTER FUNCTION membership_capability_apply(text) OWNER TO realm_capability;
ALTER FUNCTION membership_capability_grant(text, text, text, text, text, text, text, integer) OWNER TO realm_capability;
ALTER FUNCTION membership_assert_world_owner(text, text, text) OWNER TO realm_capability;

REVOKE ALL ON FUNCTION realm_membership_row_hash(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION realm_capability_session_actor(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION membership_capability_mint(text, text, text, text, text, text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION membership_capability_apply(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION membership_capability_grant(text, text, text, text, text, text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION membership_assert_world_owner(text, text, text) FROM PUBLIC;

-- 可调用面收窄：runtime 只有组合入口 grant 与 session key 同步的 EXECUTE；
-- mint/apply 子操作不授予任何应用角色（含 runtime）。
GRANT EXECUTE ON FUNCTION membership_capability_grant(text, text, text, text, text, text, text, integer) TO realm_runtime;
GRANT EXECUTE ON FUNCTION membership_assert_world_owner(text, text, text) TO realm_runtime;

COMMENT ON TABLE realm_capability_keys IS
  'M5 capability/session signing keys (0053): capability keys bootstrap randomly in-DB; session keys mirror the app session secret via provision/first-write; realm_runtime zero table grants; rotation via status; never export to repo/logs/env.';
COMMENT ON TABLE realm_capability_nonces IS
  'M5 membership capability nonce ledger (0053): consumed atomically in the writing transaction; replay = stable CAPABILITY_REPLAY = whole transaction rolls back.';
COMMENT ON FUNCTION membership_capability_apply(text) IS
  'Only writes player_world_memberships from a verified capability ticket; actor/scope/op/role/row hash are all derived from the ticket payload.';
COMMENT ON FUNCTION membership_capability_grant(text, text, text, text, text, text, text, integer) IS
  'Single narrow entrypoint for realm_runtime: requires a DB-verifiable session proof (HMAC against the DB-held session key copy); actor is derived from the proof, never from caller-supplied principal.';
