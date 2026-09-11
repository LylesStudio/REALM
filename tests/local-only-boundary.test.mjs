import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

/**
 * 本测试只守 generic 活动 runtime 边界：无 Sites/Worker/Cloudflare
 * adapter、默认回环绑定、本机 Node/Vinext 启动路径。
 *
 * 批次 T10-B16-A：D1 历史链契约（`db:d1:legacy:generate` script、
 * 无 `db:generate`、`db/index.ts` inactive 文案）已迁移至
 * tests/d1-drizzle-archive-review.test.mjs（指定锚点）——通用运行时
 * 边界不再依赖 D1 历史 tooling，tooling 退役批无需改本文件。
 */
test("the active runtime is local Vinext Node without Sites or Worker adapters", async () => {
  await assert.rejects(access(new URL("../.openai/hosting.json", import.meta.url)));
  await assert.rejects(access(new URL("../build/sites-vite-plugin.ts", import.meta.url)));
  await assert.rejects(access(new URL("../worker/index.ts", import.meta.url)));
  await assert.rejects(access(new URL("../cloudflare-env.d.ts", import.meta.url)));

  const [viteConfig, packageJson] = await Promise.all([
    readFile(new URL("../vite.config.ts", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(
    viteConfig,
    /hosting\.json|sites\(\)|site-creator|cloudflare|wrangler|d1_databases/i,
  );
  assert.doesNotMatch(
    packageJson,
    /@cloudflare\/vite-plugin|"wrangler"|WRANGLER_|MINIFLARE_/i,
  );
  // 绑定与端口由 env 驱动，但默认值必须保持回环。
  assert.match(viteConfig, /process\.env\.HOST_BIND \?\? "127\.0\.0\.1"/);
  assert.match(packageJson, /node scripts\/dev-server\.mjs dev/);
  assert.match(packageJson, /node scripts\/dev-server\.mjs start/);

  const devServer = await readFile(
    new URL("../scripts/dev-server.mjs", import.meta.url),
    "utf8",
  );
  assert.match(devServer, /HOST_BIND \?\? "127\.0\.0\.1"/);
  assert.match(devServer, /PORT \?\? "9999"/);
  assert.doesNotMatch(devServer, /HOST_BIND \?\? "0\.0\.0\.0"/);
});
