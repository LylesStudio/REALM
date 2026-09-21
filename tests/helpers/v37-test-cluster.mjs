/**
 * v37 测试基础设施：隔离 PG17 scratch cluster（host-network + 动态
 * loopback 端口；真实 runner 的 inet_server_addr 检查通过——不用
 * published-port（bridge IP 会被 runner 正确拒绝）。
 *
 * 安全说明（诚实边界）：
 * - POSTGRES_HOST_AUTH_METHOD=trust 仅用于一次性测试集群（若干既有套件
 *   依赖空密码连接形态）；绑定 127.0.0.1，非本机不可达；用后即销毁。
 * - realm_transfer 只在本集群 provision（绝不写共享 realm_dev 或任何
 *   长期实例）。
 * - 清理契约：stop() 销毁容器（含全部临时库）；进程崩溃由调用方外层
 *   t.after/finally 兜底 docker rm -f。
 */
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import net from "node:net";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const require0 = createRequire(import.meta.url);
const pg = require0("pg");

export const SCRATCH_PG_IMAGE = "pgvector/pgvector:pg17";

/** 绑定 127.0.0.1:0 找一个空闲 loopback 端口。 */
export async function findFreeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

export async function dockerAvailable() {
  try {
    await execFileAsync("docker", ["version", "--format", "{{.Server.Version}}"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * 启动 scratch cluster。options:
 *   label: 容器名后缀；roles: 需要预置的 LOGIN 角色名列表（负向属性）；
 *   readyTimeoutMs
 * 返回 { name, port, baseUrl, adminUrl, runtimeUrl, transferUrl, stop }。
 * 所有 URL 形如 postgresql://<role>@127.0.0.1:<port>/postgres（trust，无凭据）。
 */
export async function startScratchPgCluster(options = {}) {
  const label = options.label ?? "v37";
  const port = options.port ?? (await findFreeLoopbackPort());
  const name = `realm-v37-scratch-${label}-${Math.random().toString(36).slice(2, 10)}`;
  await execFileAsync("docker", [
    "run", "-d", "--rm", "--name", name,
    "--network", "host",
    "-e", "POSTGRES_HOST_AUTH_METHOD=trust",
    "-e", "POSTGRES_PASSWORD=scratch",
    SCRATCH_PG_IMAGE,
    "-c", "listen_addresses=127.0.0.1",
    "-c", `port=${port}`,
  ]);
  const stop = async () => {
    await execFileAsync("docker", ["rm", "-f", name]).catch(() => undefined);
  };
  const readyDeadline = Date.now() + (options.readyTimeoutMs ?? 60_000);
  for (;;) {
    try {
      const probe = new pg.Client({
        connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres`,
      });
      await probe.connect();
      await probe.end();
      break;
    } catch (error) {
      if (Date.now() > readyDeadline) {
        await stop();
        throw new Error(`scratch cluster did not become ready: ${error}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  const roleUrl = (role, database = "postgres") =>
    `postgresql://${role}@127.0.0.1:${port}/${database}`;
  for (const role of options.roles ?? []) {
    const client = new pg.Client({
      connectionString: roleUrl("postgres"),
    });
    await client.connect();
    await client.query(
      `CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
    );
    await client.end();
  }
  return {
    name,
    port,
    adminUrl: roleUrl("postgres"),
    runtimeUrl: roleUrl("realm_runtime"),
    transferUrl: roleUrl("realm_transfer"),
    stop,
  };
}
