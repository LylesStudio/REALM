/**
 * scene image worker 跨平台宿主接线静态围栏（worker-host-wiring-contract）。
 *
 * 钉住：
 * A. Tauri service host：ready 后经同一 supervisor 非阻塞启动 worker；
 *    worker 帧只含安全状态码；stop 先停 worker 再停 app/PG；worker 失败
 *    不改变 Web ready/error 语义。
 * B. setup-web（三平台 START 入口共用）：ready 后启动 worker，dev server
 *    退出前 finally 停 worker；同一 supervisor，不复制逻辑。
 * C. systemd 模板 ExecStart 指向 supervisor；Windows Task Scheduler 与
 *    macOS LaunchAgent 模板存在、用户级可选、不含凭据、不经管理员。
 * D. supervisor 协议面零敏感：不写 env/连接串/provider key 到日志或
 *    stdout JSON；worker 入口保持 strip-types 子进程语义。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const read = (path) =>
  readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");
const exists = (path) =>
  existsSync(fileURLToPath(new URL(`../${path}`, import.meta.url)));

const serviceHost = read("launcher/realm-service-host.mjs");
const setupWeb = read("scripts/setup-web.mjs");
const host = read("launcher/scene-image-worker-host.mjs");

test("A. service host：同一 supervisor + worker 帧 + 先停 worker", () => {
  assert.match(serviceHost, /import \{ createSceneImageWorkerHost \} from "\.\/scene-image-worker-host\.mjs"/);
  // worker 在 ready 之后启动（不阻塞 Web ready）。
  const readyIndex = serviceHost.indexOf('type: "ready"');
  const workerStartIndex = serviceHost.indexOf("workerHost.start()");
  assert.ok(readyIndex > 0 && workerStartIndex > readyIndex, "worker 必须在 ready 之后启动");
  // worker 帧只有安全状态码。
  assert.match(serviceHost, /type: "worker", state/);
  assert.doesNotMatch(serviceHost, /type: "worker"[\s\S]{0,200}postgresql:\/\//);
  // 优雅停止顺序：worker → app/PG。
  const stopBody = serviceHost.slice(
    serviceHost.indexOf('emit({ type: "stopping", reason })'),
  );
  assert.ok(
    stopBody.indexOf("workerHost.stop()") < stopBody.indexOf("handle.stop()"),
    "必须先停 worker 再停 app/PG",
  );
  // worker 连接串经 launcher helper 构造（loopback realm_runtime，与
  // buildChildEnv 同形态），只注入子进程环境，host 文件不含连接串字面量。
  assert.match(serviceHost, /launcherPgUrl\("realm_runtime", handle\.pgPort\)/);
});

test("B. setup-web：ready 后启动 worker；finally 停 worker", () => {
  assert.match(setupWeb, /import \{ createSceneImageWorkerHost \} from "\.\.\/launcher\/scene-image-worker-host\.mjs"/);
  assert.match(setupWeb, /workerHost\.start\(\)/);
  assert.match(setupWeb, /finally \{\s*await workerHost\.stop\(\);/);
  // worker 失败只提示，不阻断 Web（unavailable 分支仅 console.log）。
  assert.match(setupWeb, /state === "unavailable"[\s\S]{0,200}console\.log/);
});

test("C. 三平台后台模板：同一入口、用户级可选、无凭据", () => {
  const systemd = read("scripts/systemd/realm-scene-image-worker.service");
  assert.match(systemd, /ExecStart=.*launcher\/scene-image-worker-host\.mjs/);
  assert.doesNotMatch(systemd, /postgresql:\/\/|password|api[-_]?key/i);

  const taskXml = "installer/windows/realm-scene-image-worker-task.xml";
  const plist = "installer/macos/com.realm.scene-image-worker.plist";
  assert.ok(exists(taskXml), "Windows Task Scheduler 模板必须存在");
  assert.ok(exists(plist), "macOS LaunchAgent 模板必须存在");
  const task = read(taskXml);
  assert.match(task, /scene-image-worker-host\.mjs/);
  assert.match(task, /InteractiveToken/);
  assert.match(task, /LeastPrivilege/);
  const agent = read(plist);
  assert.match(agent, /scene-image-worker-host\.mjs/);
  for (const template of [task, agent]) {
    assert.doesNotMatch(template, /postgresql:\/\/|password|secret|api[-_]?key|token=/i);
    // 占位路径，不写本机绝对路径。
    assert.doesNotMatch(template, /\/home\/|C:\\Users\\/);
  }
});

test("D. supervisor 协议面零敏感 + 子进程 strip-types", () => {
  // 子进程带 strip-types 启动 worker 入口。
  assert.match(host, /"--experimental-strip-types", workerScript/);
  // 环境白名单存在且不含敏感键。
  const whitelistStart = host.indexOf("INHERITED_ENV_KEYS = [") + "INHERITED_ENV_KEYS = [".length;
  const whitelist = host.slice(whitelistStart, host.indexOf("];", whitelistStart));
  assert.doesNotMatch(whitelist, /TOKEN|KEY|SECRET|PASSWORD|DATABASE_URL/);
  // supervisor 自身日志只插值 pid/exit code/signal；绝不插值 env/连接串。
  const interpolated = host.match(/writeLog\(`[^`]*\$\{[^`]*`\)/g) ?? [];
  assert.ok(interpolated.length > 0, "supervisor 应有启动/退出日志行");
  for (const line of interpolated) {
    const expressions = [...line.matchAll(/\$\{([^}]*)\}/g)].map((match) => match[1]);
    for (const expression of expressions) {
      assert.match(
        expression,
        /^(spawned\.pid|code|signal|line|pending|now\(\))\b/,
        `supervisor 日志只允许 pid/exit code/signal/worker 透通行，发现: ${expression}`,
      );
    }
  }
  assert.doesNotMatch(host, /writeLog\([^)]*process\.env/);
});
