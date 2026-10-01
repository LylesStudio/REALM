import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const requiredRootMarkdown = [
  "AGENT.md",
  "CHANGELOG.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "README.en.md",
  "README.ja.md",
  "README.md",
  "SECURITY.md",
  "STATUS.md",
];

function collectMarkdown(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectMarkdown(path);
    return extname(entry.name) === ".md" ? [path] : [];
  });
}

test("the project root keeps only essential authority and entry documents", () => {
  const rootMarkdown = readdirSync(projectRoot)
    .filter((name) => extname(name) === ".md")
    .sort();

  assert.deepEqual(rootMarkdown, requiredRootMarkdown);
  assert.ok(existsSync(join(projectRoot, "docs", "README.md")));
});

test("documentation has no broken local Markdown links or legacy root paths", () => {
  const files = [
    ...requiredRootMarkdown.map((name) => join(projectRoot, name)),
    ...collectMarkdown(join(projectRoot, "docs")),
  ];
  const broken = [];
  const legacyReferences = [];

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    if (
      /(?:\]\(|`)(?:\.\/)?(?:DESIGN|DEVELOPMENT|ROADMAP)\.md(?:[#)`]|$)|database\/postgres\/README\.md/m.test(
        source,
      )
    ) {
      legacyReferences.push(relative(projectRoot, file));
    }

    for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1].split("#", 1)[0];
      if (!target || /^(?:https?:|mailto:)/.test(target)) continue;
      const resolved = resolve(dirname(file), decodeURIComponent(target));
      if (!existsSync(resolved)) {
        broken.push(`${relative(projectRoot, file)} -> ${target}`);
      }
    }
  }

  assert.deepEqual(legacyReferences, []);
  assert.deepEqual(broken, []);
});
