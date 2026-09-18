/**
 * LAN advertised origin 校验的唯一实现（plain JS）。
 *
 * 供 launcher/service-host（plain Node，无 type-stripping）与
 * modules/application/advertised-origin.ts（TS re-export，服务端/前端用）
 * 共用——两侧不得各自维护规则。
 *
 * 信任边界：只接受显式配置值——http/https、host 非空、禁 userinfo/
 * query/fragment/路径。错误消息不 echo 原始值（可能内嵌 userinfo）。
 */

export function normalizeAdvertisedOrigin(raw) {
  if (raw === undefined || raw === null || !String(raw).trim()) {
    return { origin: null, invalid: false };
  }
  const trimmed = String(raw).trim();
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return { origin: null, invalid: true };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { origin: null, invalid: true };
  }
  if (!url.hostname) return { origin: null, invalid: true };
  if (url.username || url.password) return { origin: null, invalid: true };
  if (url.search || url.hash) return { origin: null, invalid: true };
  if (url.pathname && url.pathname !== "/") return { origin: null, invalid: true };
  return { origin: url.origin, invalid: false };
}

export function advertisedOriginFromEnv(environment = process.env) {
  return normalizeAdvertisedOrigin(environment.REALM_ADVERTISED_ORIGIN);
}

export function isLoopbackOrigin(origin) {
  try {
    const host = new URL(origin).hostname.replace(/^\[|\]$/g, "");
    return ["127.0.0.1", "localhost", "::1"].includes(host);
  } catch {
    return true;
  }
}
