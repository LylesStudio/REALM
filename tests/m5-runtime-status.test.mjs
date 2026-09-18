/**
 * M5 propagation / semantic-conflict 运行态围栏——批次 T11-B 起为正向接线
 * 契约（本文件在 T10-B9-A/T10-B21-A 时是 contract-only-deferred 负断言，
 * 历史形态见 Git 记录）。
 *
 * T11-B（public documentation）
 * 已真实接线：Canon merge 原子入队、独立 Worker、semantic review 路由。
 * 本测试锚定接线面恰好是规范白名单——多一处未知调用点即漂移；
 * 既有 deterministic preview 纯洁性不动。
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

const WIRED_SYMBOLS = [
  "propagate",
  "createPropagationWorker",
  "createModelSemanticConflictAssessor",
  "needsSemanticReview",
];

function walkSources(directory) {
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|tsx|mjs)$/.test(entry.name)) files.push(path);
    }
  };
  walk(directory);
  return files;
}

test("M5 modules exist and still export their contracts", () => {
  // 正向锚定：模块被删除或导出消失时围栏必须失败。
  const expected = {
    "modules/propagation/public.ts": ["propagate"],
    "modules/propagation/worker.ts": ["createPropagationWorker"],
    "modules/worldline/semantic-conflict.ts": [
      "createModelSemanticConflictAssessor",
      "needsSemanticReview",
    ],
  };
  for (const [modulePath, symbols] of Object.entries(expected)) {
    const absolute = join(projectRoot, modulePath);
    assert.ok(existsSync(absolute), `${modulePath} 必须存在`);
    const source = readFileSync(absolute, "utf8");
    for (const symbol of symbols) {
      assert.match(
        source,
        new RegExp(`export\\s+(?:async\\s+)?(?:function|const|class)\\s+${symbol}\\b`),
        `${modulePath} 必须继续导出 ${symbol}`,
      );
    }
  }
});

test("production wiring of the M5 symbols is exactly the T11-B whitelist", () => {
  // 批次 T11-B：四符号的生产调用点白名单（定义点与 tests/ 合法除外）：
  // - propagate(：仅 modules/propagation/worker.ts（引擎执行点）；
  // - createPropagationWorker(：仅 modules/application/propagation-worker-runtime.ts；
  // - createModelSemanticConflictAssessor( / needsSemanticReview(：
  //   仅 app/api/worldline/conflict/semantic/route.ts。
  const allowedCallSites = new Set([
    "modules/propagation/worker.ts",
    "modules/application/propagation-worker-runtime.ts",
    "app/api/worldline/conflict/semantic/route.ts",
  ]);
  const offenders = [];
  for (const root of ["app", "modules", "database", "scripts"]) {
    for (const path of walkSources(join(projectRoot, root))) {
      const relative = path.slice(projectRoot.length);
      if (allowedCallSites.has(relative)) continue;
      if (relative.startsWith("modules/propagation/") || relative === "modules/worldline/semantic-conflict.ts") {
        continue; // 模块定义点（自引用/类型引用合法）
      }
      const source = readFileSync(path, "utf8");
      for (const symbol of WIRED_SYMBOLS) {
        if (new RegExp(`\\b${symbol}\\s*\\(`).test(source)) {
          offenders.push(`${relative}: call ${symbol}(`);
        }
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "M5 符号的生产调用点不得超出 T11-B 白名单（新增接线须先改规范与本测试）",
  );

  // 白名单三个接线点必须真实存在且包含对应调用（防「删接线冒充通过」）。
  const worker = readFileSync(
    join(projectRoot, "modules/propagation/worker.ts"),
    "utf8",
  );
  assert.match(worker, /\bpropagate\s*\(/);
  const runtime = readFileSync(
    join(projectRoot, "modules/application/propagation-worker-runtime.ts"),
    "utf8",
  );
  assert.match(runtime, /\bcreatePropagationWorker\s*\(/);
  const semanticRoute = readFileSync(
    join(projectRoot, "app/api/worldline/conflict/semantic/route.ts"),
    "utf8",
  );
  assert.match(semanticRoute, /\bcreateModelSemanticConflictAssessor\s*\(/);
  assert.match(semanticRoute, /\bneedsSemanticReview\s*\(/);
});

test("worldline conflict route stays free of semantic-conflict and model gateway", () => {
  // 既有 deterministic preview 纯洁性（T10-B2/T10-B21 契约不变）：
  // /api/worldline/conflict 的 legacy/causal 分支不得引入模型或语义评估。
  const route = readFileSync(
    join(projectRoot, "app/api/worldline/conflict/route.ts"),
    "utf8",
  );
  assert.doesNotMatch(
    route,
    /semantic-conflict/,
    "conflict 路由不得引入 semantic-conflict 模块",
  );
  assert.doesNotMatch(
    route,
    /model-powered|inference/,
    "conflict 路由不得引入模型网关",
  );
});

test("T11-B wiring prerequisites are now structurally present", () => {
  // 前置①（Canon merge 原子入队）：canon 路由装配传播端口，mergeProposal
  // 支持同事务 hook。
  const canonRoute = readFileSync(
    join(projectRoot, "app/api/canon/route.ts"),
    "utf8",
  );
  assert.match(canonRoute, /createPostgresCanonPropagation/);
  assert.match(canonRoute, /propagatePublic/);
  const canonRepository = readFileSync(
    join(projectRoot, "database/postgres/canon-repository.ts"),
    "utf8",
  );
  assert.match(canonRepository, /input\.propagation\.enqueue\(client\)/);

  // 前置②（独立 Worker 启动方）：脚本入口存在且引用 runtime；
  // dev-server 不得启动 Worker（独立进程边界）。
  const script = readFileSync(
    join(projectRoot, "scripts/propagation-worker.mjs"),
    "utf8",
  );
  assert.match(script, /createPropagationWorkerRuntime/);
  const devServer = readFileSync(
    join(projectRoot, "scripts", "dev-server.mjs"),
    "utf8",
  );
  assert.doesNotMatch(
    devServer,
    /createPropagationWorker|propagation-worker/,
    "dev-server 不得启动 propagation worker（独立进程边界）",
  );

  // 前置③（语义评估预算/降级装配）：semantic 路由含单飞闸门、8s 常量、
  // 输入上界与 evidence-unavailable 形态。
  const semanticRoute = readFileSync(
    join(projectRoot, "app/api/worldline/conflict/semantic/route.ts"),
    "utf8",
  );
  assert.match(semanticRoute, /SEMANTIC_REVIEW_TIMEOUT_MS = 8_000/);
  assert.match(semanticRoute, /SEMANTIC_REVIEW_BUSY/);
  assert.match(semanticRoute, /SEMANTIC_REVIEW_INPUT_TOO_LARGE/);
  assert.match(semanticRoute, /SEMANTIC_REVIEW_UNAVAILABLE/);
});
