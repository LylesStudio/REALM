/**
 * 批次 T10-B5：M4 tool-pause / parallel-candidates 运行态静态围栏
 * （docs/development/T10-B5-M4-RUNTIME-STATUS.md §三）。
 * 证明：两模块存在且头部带 contract-only-deferred 标记；活动生产代码
 * （app/、modules/application/）零导入；标记内容不被悄悄改写为已接线。
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

const DEFERRED_MODULES = [
  "modules/streaming/tool-pause.ts",
  "modules/orchestration/parallel-candidates.ts",
] as const;

const DEFERRED_MARK = "@runtime-status contract-only-deferred";

test("M4 deferred modules exist and carry the contract-only-deferred runtime status", () => {
  for (const modulePath of DEFERRED_MODULES) {
    const source = readFileSync(join(projectRoot, modulePath), "utf8");
    assert.ok(
      source.includes(DEFERRED_MARK),
      `${modulePath} 必须带 ${DEFERRED_MARK} 头部标记`,
    );
    // 标记不得被悄悄改写为已接线语义。
    assert.doesNotMatch(source, /@runtime-status\s+(wired|production|active)/);
  }
});

test("active production code never imports the deferred M4 modules", () => {
  const scanRoots = ["app", join("modules", "application")];
  const offenders: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        const source = readFileSync(path, "utf8");
        if (
          /from\s+["'][^"']*(tool-pause|parallel-candidates)/.test(source)
          || /import\s*\([^)]*(tool-pause|parallel-candidates)/.test(source)
        ) {
          offenders.push(path);
        }
      }
    }
  };
  for (const root of scanRoots) walk(join(projectRoot, root));
  assert.deepEqual(offenders, []);
});
