/**
 * baseline 脚本共享工具（一次性测量脚本专用，不入测试门、不入生产路径）。
 * - loopback guard：DATABASE_URL 只允许显式回环（127.0.0.1/localhost/::1），
 *   拒绝共享/非回环目标；错误不 echo URL/凭据。
 * - 计数/分位/错误类别：stdout 绝不输出连接串、端口、用户名、token、密码
 *   或内部错误原文。
 */

/** 显式 loopback guard：非回环/非 postgres 协议直接拒绝（不回显 URL）。 */
export function assertLoopbackDatabaseUrl(connectionString) {
  if (!connectionString || typeof connectionString !== "string") {
    throw new Error("DATABASE_URL required (scratch loopback only)");
  }
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("DATABASE_URL is not a valid URL");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error("DATABASE_URL must use the PostgreSQL protocol");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error("DATABASE_URL is restricted to a loopback host");
  }
  return url;
}

/** 简易查询计数代理（pool 级 + client 级都计）。 */
export function createCountingPool(pool) {
  const state = { queries: 0 };
  const proxy = new Proxy(pool, {
    get(target, prop) {
      if (prop === "query") {
        return (...args) => {
          state.queries += 1;
          return target.query(...args);
        };
      }
      if (prop === "connect") {
        return async () => {
          const client = await target.connect();
          return new Proxy(client, {
            get(clientTarget, clientProp) {
              if (clientProp === "query") {
                return (...args) => {
                  state.queries += 1;
                  return clientTarget.query(...args);
                };
              }
              const value = clientTarget[clientProp];
              return typeof value === "function" ? value.bind(clientTarget) : value;
            },
          });
        };
      }
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { pool: proxy, state };
}

/** 按 SQL 文本分类（reap/写/notify/事务/读/other），用于 SSE reap 场景。 */
export function categorizeSql(text) {
  const normalized = String(text).replace(/\s+/g, " ").trim().toLowerCase();
  if (normalized.startsWith("begin") || normalized.startsWith("commit") || normalized.startsWith("rollback")) {
    return "txn";
  }
  if (normalized.includes("set_config")) return "config";
  if (normalized.includes("pg_notify")) return "notify";
  if (normalized.startsWith("update lobby_rooms")) return "reap_write";
  if (normalized.startsWith("select")) return "read";
  return "other";
}

/** 分位数（已排序数组，nearest-rank）。 */
export function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1];
}

export function summarizeDurations(durations) {
  const sorted = [...durations].sort((left, right) => left - right);
  const total = durations.reduce((sum, value) => sum + value, 0);
  const round = (value) => Number(value.toFixed(2));
  return {
    avgMs: round(durations.length ? total / durations.length : 0),
    p50Ms: round(percentile(sorted, 50)),
    p95Ms: round(percentile(sorted, 95)),
  };
}

/** 安全错误类别：只返回类型名，绝不复制 message（可能含连接细节）。 */
export function safeErrorCategory(error) {
  if (error && typeof error === "object" && typeof error.name === "string" && error.name) {
    return error.name;
  }
  return "UnknownError";
}
