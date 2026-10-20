// Witness must be the first runtime import: archive-first prewarming hides the TDZ.
import { PERFORMANCE_WITNESSES_ENTRY } from "../modules/world-transfer/runtime-performance-witness-transport.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import * as archive from "../modules/world-transfer/realm-runtime-save.ts";

test("witness-first cold import initializes the real archive and command entrypoints", async () => {
  assert.equal(PERFORMANCE_WITNESSES_ENTRY, "runtime/performance-witnesses.json");
  assert.equal(typeof archive.buildRealmRuntimeSaveArchive, "function");
  for (const entry of [
    "../database/postgres/committed-fact-command-repository.ts",
    "../database/postgres/performance-evidence-transport-repository.ts",
    "../modules/application/performance-command-executor.ts",
    "../app/api/bridge/v1/facts/commands/route.ts",
  ]) assert.ok(Object.keys(await import(entry)).length > 0, entry);
});

test("shared archive leaves keep the same error identity and wire semantics", async () => {
  const primitives = await import("../modules/world-transfer/runtime-save-primitives.ts");
  const events = await import("../modules/world-transfer/runtime-save-event.ts");
  assert.equal(archive.RealmRuntimeSaveError, primitives.RealmRuntimeSaveError);
  assert.equal(archive.countRuntimeSectionWireBytes, primitives.countRuntimeSectionWireBytes);
  assert.equal(archive.normalizeRealmRuntimeSaveEventForRestore, events.normalizeRealmRuntimeSaveEventForRestore);
  assert.equal(archive.RUNTIME_SAVE_FILE_BYTES, 64 * 1024 * 1024);
  const value = { text: "\ufeff日本語🌸\ud800\n", values: [true, null, 0] };
  const bytes = Buffer.byteLength(JSON.stringify(value));
  assert.equal(primitives.countRuntimeSectionWireBytes(value, "normalized-domain", bytes), bytes);
  assert.throws(() => primitives.countRuntimeSectionWireBytes(value, "normalized-domain", bytes - 1),
    (error: unknown) => error instanceof archive.RealmRuntimeSaveError && error.code === "INVALID_SAVE");
  let invoked = false;
  const accessor = Object.defineProperty({}, "text", { enumerable: true, get() { invoked = true; return "unsafe"; } });
  assert.throws(() => primitives.countRuntimeSectionWireBytes(accessor, "normalized-domain"), archive.RealmRuntimeSaveError);
  assert.equal(invoked, false);
  const badEvent = { eventId: "event", recordVersion: 1, ordinal: 0, kind: "not.restorable", payload: {} };
  assert.throws(() => events.normalizeRealmRuntimeSaveEventForRestore(badEvent),
    (error: unknown) => error instanceof archive.RealmRuntimeSaveError && error.code === "INVALID_SAVE"
      && error.message === "runtime event 0 kind is not restorable");
});

test("witness and Goal codecs cannot regain runtime reverse imports into the archive facade", () => {
  const imports = (file: string) => {
    const source = ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
    return source.statements.filter(ts.isImportDeclaration).filter(node => {
      const clause = node.importClause;
      if (!clause) return true;
      if (clause.isTypeOnly) return false;
      if (clause.name || (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings))) return true;
      return clause.namedBindings && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.some(e => !e.isTypeOnly);
    }).map(node => (node.moduleSpecifier as import("typescript").StringLiteral).text);
  };
  for (const file of ["runtime-save-primitives.ts", "runtime-save-validation.ts", "runtime-save-event.ts",
    "runtime-performance-witness-transport.ts", "realm-runtime-goals-v2.ts"]) {
    assert.equal(imports(`../modules/world-transfer/${file}`).some(path =>
      /^(?:\.\/)?(?:realm-runtime-save|realm-runtime-domain-save|public)\.ts$/.test(path)), false, file);
  }
});
