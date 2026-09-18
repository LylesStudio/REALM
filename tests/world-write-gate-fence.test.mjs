/**
 * v37 §D.0 静态围栏（纯文本扫描，零数据库）：
 * ① 方法级清单——每个 C 面写方法体内必须出现 gate 标记
 *    （gateWorldWrite/gateRecordActive/本地两拍 helper/持锁 assert）；
 * ② 锁序——worlds gate（KEY SHARE）必须先于 record_heads/worldlines 锁；
 * ③ helper 调用图——内部写 helper 的 caller 必须 ⊆ 已 gate 方法；
 * ④ K/B/N/A 面方法必须不出现 C 面 gate（防误分类）。
 * 输入 = 生产文件（排除 tests/seed/migrations/runner）；清单漂移即失败。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ROOT = new URL("..", import.meta.url);

const GATE_MARKERS = [
  "gateWorldWrite",
  "gateRecordActive",
  "gateRecordWritePath",
  "gateRecordPath",
  "gateRecordSessionPath",
  "assertWorldWritable", // library-service 持锁形态（FOR KEY SHARE）
  "FOR KEY SHARE OF world", // tavern-import 持锁形态
];

// （文件, 方法, plane, gate 标记子串/null）。plane ∈ C/K/B/N/A。
const METHOD_PLANES = [
  ["database/postgres/runtime-repository.ts", "acceptCommand", "C", "gateRecordWritePath"],
  ["database/postgres/runtime-repository.ts", "advanceTurn", "C", "gateRecordWritePath"],
  ["database/postgres/runtime-repository.ts", "beginStageAttempt", "C", "gateRecordWritePath"],
  ["database/postgres/runtime-repository.ts", "restartTurn", "C", "gateRecordWritePath"],
  ["database/postgres/runtime-repository.ts", "commitRelease", "C", "gateRecordWritePath"],
  ["database/postgres/runtime-repository.ts", "markTurnFailure", "K", null],
  ["database/postgres/runtime-repository.ts", "claimOutbox", "K", null],
  ["database/postgres/runtime-repository.ts", "settleOutbox", "K", null],
  ["database/postgres/first-night-store.ts", "claimAttempt", "C", "gateRecordPath"],
  ["database/postgres/first-night-store.ts", "commitPack", "C", "gateRecordPath"],
  ["database/postgres/scene-crystallization-repository.ts", "applyDelta", "C", "gateWorldWrite"],
  ["database/postgres/memory-repository.ts", "appendAuthorized", "C", "gateWorldWrite"],
  ["database/postgres/memory-repository.ts", "upsertRelationshipAuthorized", "C", "gateWorldWrite"],
  ["database/postgres/memory-repository.ts", "createSnapshotAuthorized", "C", "gateWorldWrite"],
  ["database/postgres/propagation-job-queue.ts", "completeRun", "C", "gateWorldWrite"],
  ["database/postgres/propagation-job-queue.ts", "claimNext", "K", null],
  ["database/postgres/propagation-job-queue.ts", "markFailed", "K", null],
  ["database/postgres/propagation-job-queue.ts", "recoverStale", "K", null],
  ["database/postgres/propagation-job-queue.ts", "retry", "K", null],
  ["database/postgres/propagation-repository.ts", "saveRun", "C", "gateWorldWrite"],
  ["database/postgres/canon-propagation.ts", "planAndEnqueue", "C", "gateWorldWrite"],
  ["database/postgres/worldline-merge-repository.ts", "insertMerge", "C", "gateWorldWrite"],
  ["database/postgres/worldline-merge-repository.ts", "createMergedTopology", "C", "gateWorldWrite"],
  ["database/postgres/worldline-merge-repository.ts", "createMergedTopologyAndAudit", "C", "gateWorldWrite"],
  ["database/postgres/world-knowledge-repository.ts", "upsertEntity", "C", "gateWorldWrite"],
  ["database/postgres/world-knowledge-repository.ts", "appendClaim", "C", "gateWorldWrite"],
  ["database/postgres/world-knowledge-repository.ts", "appendClaims", "C", "gateWorldWrite"],
  ["database/postgres/world-knowledge-repository.ts", "appendRelation", "C", "gateWorldWrite"],
  ["database/postgres/world-knowledge-repository.ts", "createArticle", "C", "gateWorldWrite"],
  ["database/postgres/world-knowledge-repository.ts", "appendCausalEdge", "C", "gateWorldWrite"],
  ["database/postgres/canon-repository.ts", "createProposal", "C", "gateWorldWrite"],
  ["database/postgres/canon-repository.ts", "mergeProposal", "C", "gateWorldWrite"],
  ["database/postgres/article-qualification-repository.ts", "qualifyOnce", "C", "gateWorldWrite"],
  ["database/postgres/self-play-store.ts", "start", "C", "gateRecordSessionPath"],
  ["database/postgres/self-play-store.ts", "completeBeat", "C", "gateRecordSessionPath"],
  ["database/postgres/self-play-store.ts", "requestStop", "K", null],
  ["database/postgres/semantic-conflict-repository.ts", "append", "C", "gateWorldWrite"],
  ["modules/application/tavern-import-service.ts", "importTavernBundle", "C", "FOR KEY SHARE OF world"],
];

// library-service 分支级（create 单方法多分支）：逐命令分支断言。
const LIBRARY_BRANCHES = [
  ['command.kind === "world-style"', "assertWorldWritable"],
  ['command.kind === "character"', "assertWorldWritable"],
  ['command.kind === "player-stance"', "assertWorldWritable"],
  ['command.kind === "attach-character"', "assertWorldWritable"],
  ['command.kind === "character-activity"', "assertWorldWritable"],
  // branch 命令委托 createRecordBranchInTransaction（门禁/锁序在 helper 内，
  // 由下方专门断言覆盖）；分支体必须显式走该 helper。
  ['command.kind === "branch"', "createRecordBranchInTransaction"],
  ['command.kind === "story"', "assertWorldWritable"],
  ['command.kind === "world-archive"', "FOR UPDATE"],
  ['command.kind === "delete-world"', "FOR UPDATE"],
  ['command.kind === "delete-record"', "FOR UPDATE"],
];

// 内部写 helper → 允许的 caller 文件集合（调用图规则）。
const HELPER_CALLERS = [
  ["database/postgres/worldline-merge-repository.ts", "insertMergedTopology", null], // 同文件内
  ["database/postgres/worldline-merge-repository.ts", "insertMergeAudit", null],
  ["modules/application/base-rule-definitions.ts", "ensureWorldBaseRuleDefinitions", [
    "modules/application/tavern-import-service.ts",
    "modules/application/library-service.ts",
    "modules/application/base-rule-definitions.ts",
  ]],
  ["modules/application/library-service.ts", "insertOpeningEvent", null],
  ["modules/application/library-service.ts", "attachCharacterToRecord", null],
  ["database/postgres/graph-invalidation.ts", "appendGraphInvalidation", [
    "database/postgres/canon-repository.ts",
    "database/postgres/world-knowledge-repository.ts",
    "database/postgres/runtime-repository.ts",
    "database/postgres/local-record-service.ts",
    "database/postgres/delivery-projection.ts",
    "database/postgres/record-scope.ts",
    "database/postgres/first-night-store.ts",
    "database/postgres/scene-crystallization-repository.ts",
    "database/postgres/self-play-store.ts",
    "database/postgres/propagation-repository.ts",
    "database/postgres/canon-propagation.ts",
    "database/postgres/worldline-merge-repository.ts",
    "database/postgres/semantic-conflict-repository.ts",
    "database/postgres/memory-repository.ts",
    "database/postgres/article-qualification-repository.ts",
    "modules/application/local-record-service.ts",
    "modules/application/library-service.ts",
    "modules/application/tavern-import-service.ts",
    "modules/application/self-play.ts",
    "modules/worldline/canon.ts",
  ]],
];

async function readSource(rel) {
  return readFile(new URL(rel, ROOT), "utf8");
}

/** 提取方法体：从 `name(` 出现处到同级下一个方法/函数定义或文件尾。 */
function extractMethodBody(source, name) {
  const start = source.search(new RegExp(`async (?:function )?${name}\\s*\\(`));
  if (start === -1) return null;
  const rest = source.slice(start);
  const next = rest.slice(1).search(/\n\s{0,6}async [a-zA-Z]+\s*\(|\n\s{0,6}async function [a-zA-Z]+\s*\(/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

test("D.0 方法级清单：C 面写方法全部持 gate，K 面无 C gate", async () => {
  for (const [file, method, plane, marker] of METHOD_PLANES) {
    const source = await readSource(file);
    const body = extractMethodBody(source, method);
    assert.ok(body, `${file}#${method} 方法必须存在`);
    if (plane === "C") {
      assert.ok(
        marker && body.includes(marker),
        `${file}#${method}（C 面）必须调用 ${marker}`,
      );
    } else if (plane === "K") {
      assert.ok(
        !GATE_MARKERS.some((m) => body.includes(m)),
        `${file}#${method}（K 面）不得出现 C 面 gate`,
      );
    }
  }
});

test("D.0 library-service 分支级门禁矩阵", async () => {
  const source = await readSource("modules/application/library-service.ts");
  for (const [branchMarker, gateMarker] of LIBRARY_BRANCHES) {
    const index = source.indexOf(branchMarker);
    assert.ok(index !== -1, `library 分支 ${branchMarker} 必须存在`);
    // 分支体 = 分支标记到下一个分支标记/方法尾。
    const rest = source.slice(index);
    const nextBranch = rest.slice(1).search(/command\.kind ===|^\s{6}\},$/m);
    const body = nextBranch === -1 ? rest.slice(0, 4000) : rest.slice(0, nextBranch + 1);
    assert.ok(
      body.includes(gateMarker),
      `library 分支 ${branchMarker} 必须含 ${gateMarker}`,
    );
  }
});

test("D.0 分支创建 helper：world gate 先于 records/record_heads 锁与拓扑插入", async () => {
  const source = await readSource("modules/application/library-service.ts");
  const body = extractMethodBody(source, "createRecordBranchInTransaction");
  assert.ok(body, "createRecordBranchInTransaction 必须存在");
  // 锁序（world-write-gate.ts:9-13）：worlds(KEY SHARE gate) → records
  // FOR UPDATE → record_heads FOR UPDATE → worldlines/stories/records 插入。
  const gateIndex = body.indexOf("assertWorldWritable");
  const recordLockIndex = body.indexOf("FOR UPDATE OF record");
  const headLockIndex = body.indexOf("FROM record_heads");
  const insertIndex = body.indexOf("INSERT INTO worldlines");
  assert.ok(
    gateIndex !== -1
      && recordLockIndex !== -1
      && headLockIndex !== -1
      && insertIndex !== -1
      && gateIndex < recordLockIndex
      && recordLockIndex < headLockIndex
      && headLockIndex < insertIndex,
    "createRecordBranchInTransaction 锁序：gate → records → record_heads → worldlines",
  );
  // 内容写门禁（owner/player；observer 403、非成员 404）。
  assert.ok(
    body.includes("assertWorldContentMember"),
    "createRecordBranchInTransaction 必须含 assertWorldContentMember",
  );
  // 归档源显式拒绝（fail-closed）。
  assert.ok(
    body.includes("RECORD_ARCHIVED"),
    "createRecordBranchInTransaction 必须拒绝归档源",
  );
});

test("D.0 锁序：worlds gate 先于 record_heads/worldlines 锁", async () => {
  const checks = [
    ["database/postgres/runtime-repository.ts", "commitRelease", "gateRecordWritePath", "FROM record_heads"],
    ["database/postgres/first-night-store.ts", "commitPack", "gateRecordPath", "FROM record_heads"],
    ["database/postgres/scene-crystallization-repository.ts", "applyDelta", "gateWorldWrite", "FROM record_heads"],
    ["database/postgres/article-qualification-repository.ts", "qualifyOnce", "gateWorldWrite(", "pg_advisory_xact_lock("],
  ];
  for (const [file, method, gate, later] of checks) {
    const body = extractMethodBody(await readSource(file), method);
    assert.ok(body, `${file}#${method} 必须存在`);
    const gateIndex = body.indexOf(gate);
    const laterIndex = body.indexOf(later);
    assert.ok(gateIndex !== -1 && laterIndex !== -1 && gateIndex < laterIndex,
      `${file}#${method}：${gate} 必须先于 ${later}`);
  }
  // 四 head writer 显式 FOR UPDATE worldlines。
  const headWriters = [
    "database/postgres/runtime-repository.ts",
    "database/postgres/first-night-store.ts",
    "database/postgres/scene-crystallization-repository.ts",
    "modules/application/library-service.ts",
  ];
  for (const file of headWriters) {
    const source = await readSource(file);
    assert.ok(
      /FROM worldlines[^`]*FOR UPDATE/.test(source.replace(/\n/g, " ")),
      `${file} 必须有显式 worldlines FOR UPDATE（head writer）`,
    );
  }
});

test("D.0 helper 调用图：内部写 helper 的 caller ⊆ 允许集合", async () => {
  const { readdir, stat } = await import("node:fs/promises");
  const files = [];
  const walk = async (dir) => {
    for (const entry of await readdir(new URL(dir, ROOT))) {
      const rel = `${dir}/${entry}`;
      const info = await stat(new URL(rel, ROOT));
      if (info.isDirectory()) {
        if (!["node_modules", "dist", ".next", ".git", "tests"].includes(entry)) {
          await walk(rel);
        }
      } else if (entry.endsWith(".ts") || entry.endsWith(".mjs")) {
        files.push(rel);
      }
    }
  };
  await walk("database");
  await walk("modules");
  await walk("app");

  for (const [definerFile, helper, allowedCallers] of HELPER_CALLERS) {
    const callers = [];
    for (const file of files) {
      if (file === definerFile) continue;
      const source = await readSource(file);
      // 只匹配调用点（排除 `async helper(` 定义自身）。
      if (new RegExp(`(?<!async )(?<!async function )\\b${helper}\\s*\\(`).test(source)) {
        callers.push(file);
      }
    }
    if (allowedCallers === null) {
      assert.deepEqual(callers, [],
        `${helper} 只允许同文件调用，实际 caller：${callers.join(", ")}`);
    } else {
      for (const caller of callers) {
        assert.ok(allowedCallers.includes(caller),
          `${helper} 的 caller ${caller} 不在允许集合内`);
      }
    }
  }
});

test("D.0 worlds 行锁形围栏：内容面 KEY SHARE，仅归档/删除命令 FOR UPDATE", async () => {
  // worlds FOR UPDATE 只允许出现在 K 面状态转换（world-archive/delete-world）。
  const files = [
    "database/postgres/runtime-repository.ts",
    "database/postgres/first-night-store.ts",
    "database/postgres/scene-crystallization-repository.ts",
    "database/postgres/memory-repository.ts",
    "database/postgres/propagation-job-queue.ts",
    "database/postgres/propagation-repository.ts",
    "database/postgres/canon-propagation.ts",
    "database/postgres/worldline-merge-repository.ts",
    "database/postgres/world-knowledge-repository.ts",
    "database/postgres/canon-repository.ts",
    "database/postgres/article-qualification-repository.ts",
    "database/postgres/self-play-store.ts",
    "database/postgres/semantic-conflict-repository.ts",
    "database/postgres/world-write-gate.ts",
    "modules/application/tavern-import-service.ts",
  ];
  for (const file of files) {
    const source = (await readSource(file)).replace(/\n/g, " ");
    assert.ok(
      !/FROM worlds[^`;]*?FOR UPDATE/.test(source),
      `${file} 不得对 worlds 取 FOR UPDATE（仅 KEY SHARE）`,
    );
  }
  // library-service：worlds FOR UPDATE 仅 world-archive/delete-world 分支。
  const library = await readSource("modules/application/library-service.ts");
  const worldsForUpdate = library.match(/FROM worlds[^`;]*?FOR UPDATE/g) ?? [];
  assert.equal(worldsForUpdate.length, 2,
    "library-service worlds FOR UPDATE 必须恰好 2 处（world-archive/delete-world）");
});
