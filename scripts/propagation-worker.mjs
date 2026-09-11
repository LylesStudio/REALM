import { LOCAL_RECORD_SCOPE } from "../modules/application/local-record-service.ts";
import { createPropagationWorkerRuntime } from "../modules/application/propagation-worker-runtime.ts";

/**
 * 批次 T11-B：独立传播 Worker 入口（scripts/systemd/
 * realm-propagation-worker.service 模板配套；不随 realm-dev.service 启动）。
 *
 * 运行：node --env-file-if-exists=.env.local --experimental-strip-types \
 *   scripts/propagation-worker.mjs
 * 环境：REALM_RUNTIME_DATABASE_URL（loopback，realm_runtime 最小权限）；
 * REALM_PROPAGATION_WORKSPACES 逗号分隔 workspace 清单（缺省 demo）。
 */

const connectionString = process.env.REALM_RUNTIME_DATABASE_URL;
if (!connectionString) {
  throw new Error(
    "REALM_RUNTIME_DATABASE_URL is required for the propagation worker.",
  );
}

const workspaces = (process.env.REALM_PROPAGATION_WORKSPACES ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);

const runtime = createPropagationWorkerRuntime({
  connectionString,
  workspaces: workspaces.length > 0 ? workspaces : [LOCAL_RECORD_SCOPE.workspaceId],
});

process.on("SIGTERM", () => void runtime.stop());
process.on("SIGINT", () => void runtime.stop());

try {
  await runtime.start();
} finally {
  await runtime.stop();
}
