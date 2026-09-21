import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);
const client = readFileSync(resolve(root, "app/realm-client.tsx"), "utf8");
const preview = resolve(root, "app/components/preview-cards.tsx");
const css = readFileSync(resolve(root, "app/globals.css"), "utf8");
const navigation = readFileSync(resolve(root, "app/components/world-navigation.tsx"), "utf8");

test("preview stream is isolated from the RealmClient render root", () => {
  assert.match(client, /import \{ PreviewCards \} from "\.\/components\/preview-cards"/);
  assert.match(client, /<PreviewCards[\s\S]*recordId=\{streamRecordId\}/);
  assert.doesNotMatch(client, /const \[previews, setPreviews\]/);
  assert.doesNotMatch(client, /source\.addEventListener\("preview"/);
  const previewSource = readFileSync(preview, "utf8");
  assert.match(previewSource, /new EventSource/);
  assert.match(previewSource, /requestAnimationFrame/);
  assert.match(previewSource, /cancelAnimationFrame/);
  assert.match(previewSource, /source\.close\(\)/);
});

test("record stream and scroll effects depend on stable identities", () => {
  assert.doesNotMatch(client, /const streamPerspective/);
  assert.doesNotMatch(client, /const streamCharacterInstanceId/);
  assert.match(client, /const latestEventId = latestEvent\?\.id \?\? ""/);
  assert.match(client, /const latestEventStatus = latestEvent\?\.status \?\? ""/);
  assert.doesNotMatch(client, /\}, \[projection\]\);/);
  assert.match(client, /\}, \[latestEventId, latestEventStatus\]\);/);
});

test("initial independent loads are not delayed by zero-delay timers", () => {
  assert.doesNotMatch(client, /const initialLoad = window\.setTimeout/);
  assert.doesNotMatch(client, /const libraryLoad = window\.setTimeout/);
  assert.doesNotMatch(client, /const identityLoad = window\.setTimeout/);
  // setUiLanguage 两处：挂载时语言同步（初始路径）+ 语言切换事件回调（事件驱动，非渲染路径）。
  assert.equal((client.match(/setUiLanguage\(/g) ?? []).length, 2);
});

test("frontend cleanup removes obsolete breadcrumb selectors and linear record indexing", () => {
  assert.doesNotMatch(css, /\.breadcrumb span/);
  assert.doesNotMatch(css, /\.breadcrumb strong/);
  assert.doesNotMatch(navigation, /projection\.records\.indexOf\(record\)/);
});

test("record heading no longer leaks internal record identifiers", () => {
  assert.doesNotMatch(client, /record-code/);
  assert.doesNotMatch(client, /record\.id\.slice\(-6\)/);
  assert.doesNotMatch(css, /\.record-code/);
});

test("header library trigger and overlays carry dialog semantics", () => {
  const headerLibrary = /aria-haspopup="dialog"[\s\S]{0,120}className="header-settings-link"/;
  assert.match(client, headerLibrary);
  for (const overlay of ["guided-overlay", "library-overlay"]) {
    const pattern = new RegExp(
      `aria-modal="true"[\\s\\S]{0,80}className="${overlay}"|className="${overlay}"[\\s\\S]{0,80}aria-modal="true"`,
    );
    assert.match(client, pattern, `${overlay} 必须带 aria-modal`);
    assert.match(client, /role="dialog"/);
  }
});
