/**
 * Web/Vinext 子进程环境（M5 收口）：剥离 owner/provisioning 专用变量
 * （DATABASE_URL=postgres 所有者角色、REALM_PROVISION_SECRET_DIR），
 * 保留 REALM_RUNTIME_DATABASE_URL / REALM_TRANSFER_DATABASE_URL /
 * REALM_SESSION_SECRET / REALM_DATA_HOME 等应用必需项。
 *
 * launcher（bootstrap 步骤用完整 childEnv）与 dev-server（npm/systemd/
 * 直接启动路径）共用同一实现，避免两处漂移。vinext 会再加载 .env.local
 * （不覆盖既有键）——owner 键由 setup-web 写入独立的 .env.owner.local，
 * 不进入 .env.local。
 */
const OWNER_ONLY_ENV_KEYS = ["DATABASE_URL", "REALM_PROVISION_SECRET_DIR"];

export function webChildEnv(env = process.env) {
  const sanitized = { ...env };
  for (const key of OWNER_ONLY_ENV_KEYS) delete sanitized[key];
  return sanitized;
}

export { OWNER_ONLY_ENV_KEYS };
