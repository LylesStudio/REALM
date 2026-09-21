import { LOCAL_RECORD_SCOPE } from "../modules/application/local-record-service.ts";
import { createSceneImageWorkerRuntime } from "../modules/application/scene-image-worker-runtime.ts";

/**
 * 场景图自动 worker 入口（scripts/systemd/realm-scene-image-worker.service
 * 模板配套；不随 realm-dev.service 启动）。
 *
 * 运行：node --env-file-if-exists=.env.local --experimental-strip-types \
 *   scripts/scene-image-worker.mjs
 * 环境：REALM_RUNTIME_DATABASE_URL（loopback，realm_runtime 最小权限）；
 * REALM_SCENE_IMAGE_WORKSPACES 逗号分隔清单（缺省 demo workspace）；
 * ComfyUI 配置读本机设置库（REALM_DATA_HOME 时跟随数据目录）。
 */

const connectionString = process.env.REALM_RUNTIME_DATABASE_URL;
if (!connectionString) {
  throw new Error(
    "REALM_RUNTIME_DATABASE_URL is required for the scene image worker.",
  );
}

const workspaces = (process.env.REALM_SCENE_IMAGE_WORKSPACES ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);

const runtime = createSceneImageWorkerRuntime({
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
