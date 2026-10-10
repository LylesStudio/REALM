/**
 * RealmWorld 路由共享环境（instantiate / switch-version 同一信任链）：
 * 安装根 + trust-store 签名 verifier。缺配置或 trust-store 不可读 → null
 *（调用方 fail-closed 503，绝不退化为未验签）。
 *
 * verifier 基于文件生命周期（modules/world-transfer/realmworld-trust-store.ts），
 * 每次验签重新读取并校验 trust store，运营商轮换/吊销无需重启 Web 进程即生效；
 * 启动时仍做一次完整校验，初始配置无效同样 fail-closed。
 */
import {
  createRealmWorldSignatureVerifierFromTrustStoreFile,
  readRealmWorldTrustStoreFile,
} from "../../../modules/world-transfer/realmworld-trust-store.ts";

export async function readRealmWorldVerifier(): Promise<{
  installRoot: string;
  verifySignature: ReturnType<typeof createRealmWorldSignatureVerifierFromTrustStoreFile>;
} | null> {
  const installRoot = process.env.REALM_REALMWORLD_INSTALL_ROOT
    ?? process.env.REALM_GOAL_WORKER_INSTALL_ROOT;
  const trustStorePath = process.env.REALM_REALMWORLD_TRUST_STORE;
  if (!installRoot || !trustStorePath) return null;
  try {
    // 初始配置校验：trust store 不可读/无效 → null（fail-closed），绝不降级。
    await readRealmWorldTrustStoreFile(trustStorePath);
    return {
      installRoot,
      verifySignature: createRealmWorldSignatureVerifierFromTrustStoreFile({
        path: trustStorePath,
      }),
    };
  } catch {
    return null;
  }
}
