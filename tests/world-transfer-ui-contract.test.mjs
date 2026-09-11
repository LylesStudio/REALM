/**
 * v37 Y5：Library UI .realm 传输区静态契约（零身份字段 + 向导协议 +
 * i18n 键存在性 + 路由接线锚点）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

function readProjectFile(relativePath) {
  return readFileSync(
    fileURLToPath(new URL(`../${relativePath}`, import.meta.url)),
    "utf8",
  );
}

test("Y5 UI contract: transfer panel protocol + zero identity fields + i18n keys", () => {
  const component = readProjectFile("app/components/world-transfer.tsx");

  // 端点接线（H.1 六路由中的 UI 面四个）。
  for (const endpoint of [
    "/api/world/export",
    "/api/world/import/dry-run",
    "/api/world/import/execute",
    "/api/world/import/cancel",
    "/api/world/import/status",
    "/api/world/import/jobs",
  ]) {
    assert.ok(component.includes(endpoint), `missing endpoint ${endpoint}`);
  }
  // 前端零身份字段：任何请求体不得携带 principal/attestedBy/operator。
  assert.doesNotMatch(component, /principalId|attestedBy|attested_by|operatorPrincipal|operator_principal/);
  // 向导协议：dry-run（importMode + copyKey 条件）→ execute 重传同包
  //（file + jobId + confirm='true'）→ cancel（jobId）。
  assert.match(component, /\{ importMode: mode \}/);
  assert.match(component, /fields\.copyKey = copyKey\.trim\(\)/);
  assert.match(component, /form\.set\("file", file/);
  assert.match(component, /buildForm\(\{ jobId: step\.jobId, confirm: "true" \}\)/);
  assert.match(component, /JSON\.stringify\(\{ jobId: step\.jobId \}\)/);
  // archive 只读徽标 + 冲突/ copyEligible 展示。
  assert.match(component, /archiveReadonly/);
  assert.match(component, /idCollisions/);
  assert.match(component, /blockingFields/);

  // Library 面板挂载（owner 世界卡导出区 + 右侧导入向导/历史）。
  const panel = readProjectFile("app/components/library-panel.tsx");
  assert.match(panel, /<WorldExportSection/);
  assert.match(panel, /<WorldImportWizard/);
  assert.match(panel, /<WorldImportHistory/);
  assert.match(panel, /world\.membershipRole === "owner"[\s\S]{0,400}<WorldExportSection/);

  // i18n 键全部存在（ui.transfer.*）。
  const i18n = readProjectFile("modules/i18n/public.ts");
  for (const key of component.matchAll(/"(ui\.transfer\.[a-zA-Z]+)"/g)) {
    assert.ok(i18n.includes(`"${key[1]}":`), `missing i18n key ${key[1]}`);
  }
});
