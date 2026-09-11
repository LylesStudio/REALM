import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { startProdServer } from "vinext/server/prod-server";

async function render(path = "/") {
  const running = await startProdServer({
    host: "127.0.0.1",
    port: 0,
    outDir: new URL("../dist", import.meta.url).pathname,
    silent: true,
  });

  try {
    const response = await fetch(`http://127.0.0.1:${running.port}${path}`, {
      headers: { accept: "text/html" },
    });
    const body = await response.arrayBuffer();
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } finally {
    await new Promise((resolve, reject) => {
      running.server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test("server-renders the Realm product shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<html[^>]+lang=["']zh-CN["']/i);
  assert.match(html, /<title>界核 \/ REALM<\/title>/i);
  assert.match(html, /正在抵达故事发生之处/);
  assert.match(html, /多人叙事角色运行时/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
});

test("starter preview is removed and product metadata is wired", async () => {
  const [layout, page, packageJson] = await Promise.all([
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(layout, /界核 \/ REALM/);
  assert.match(layout, /\/og\.png/);
  assert.match(page, /<RealmClient/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
  await access(new URL("../public/og.png", import.meta.url));
});

test("the primary UI language stays sharp and rectangular", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /--paper:/);
  assert.match(css, /--ink:/);
  assert.match(css, /--accent:/);
  assert.match(css, /\.realm-grid/);
  assert.match(css, /\.event-card/);
  assert.doesNotMatch(css, /border-radius\s*:\s*(?:[5-9]|[1-9]\d+)px/i);
});
