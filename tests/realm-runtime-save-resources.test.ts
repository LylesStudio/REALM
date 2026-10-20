import assert from "node:assert/strict";
import test from "node:test";
import { PACK_LIMITS, validateStrictZipArchive } from "../modules/world-transfer/realm-pack.ts";
import { createHash } from "node:crypto";
import { unzipSync, zipSync } from "fflate";
import {
  buildRealmRuntimeSaveArchive,
  finalizeRealmRuntimeSaveZip,
  parseRealmRuntimeSaveArchive,
  computeRealmRuntimeSaveContentHash,
  countRuntimeSectionWireBytes,
  RuntimeSectionWireLedger,
  RealmRuntimeSaveError,
  realmRuntimeSaveManifestFromData,
  serializeRealmRuntimeSaveRecordV1,
  serializeRealmRuntimeSaveGoalsV1,
  serializeRealmRuntimeSaveFirstNightV1,
  serializeRealmRuntimeSaveManifestV2,
  parseRealmRuntimeSaveManifestV2,
  type RealmRuntimeSaveRecordV1,
  type RealmRuntimeSaveGoalsV1,
  type RealmRuntimeSaveFirstNightV1,
} from "../modules/world-transfer/realm-runtime-save.ts";
import {
  serializeRealmRuntimeSaveDomainV1,
  serializeNormalizedRealmRuntimeSaveDomainV1ForArchive,
  normalizeRealmRuntimeSaveDomainV1,
  parseRealmRuntimeSaveDomainV1,
  type RealmRuntimeSaveDomainV1,
} from "../modules/world-transfer/realm-runtime-domain-save.ts";

const LIMIT = 67108864;
const goals: RealmRuntimeSaveGoalsV1 = {
  format: "realm-runtime-goals", schemaVersion: 1, instances: [], assessments: [],
};
function recordWith(content = ""): RealmRuntimeSaveRecordV1 {
  return {
    format: "realm-runtime-record", schemaVersion: 1,
    scope: { worldId: "world", worldlineId: "line", recordId: "record" },
    head: { recordVersion: 1, nextRecordOrdinal: 2 },
    events: [{ eventId: "event", recordVersion: 1, ordinal: 1, kind: "utterance.committed", payload: { content } }],
  };
}
function domainWith(title = "x"): RealmRuntimeSaveDomainV1 {
  return {
    format: "realm-runtime-domain", schemaVersion: 1,
    source: { worldId: "world", worldlineId: "line", storyId: "story", recordId: "record" },
    projects: [{ id: "project", kind: "production", status: "active", stage: "planning", title,
      currency: "JPY", deadline: null, version: 1 }],
    milestones: [], projectStoryLinks: [], budgetAllocations: [], financeAccounts: [], ledgerEntries: [],
    financeCommandGroups: [], obligations: [], obligationSettlements: [], storyNodes: [], storyUnlockLedger: [],
    committedFactCommands: [], performanceAssessments: [], memberRelationshipRevisions: [], characterAssets: [],
  };
}
function manifest(record = recordWith(), domain?: RealmRuntimeSaveDomainV1,
  sections: { goals?: RealmRuntimeSaveGoalsV1; firstNight?: RealmRuntimeSaveFirstNightV1 } = {}) {
  return realmRuntimeSaveManifestFromData({ engineApi: "1.x", mode: "base", world: null,
    scope: { workspaceId: "workspace", worldlineId: "line", recordId: "record" }, record, goals, domain, ...sections });
}

// Passive delegates always return the actual native result. No production
// formatter, allocator, validation or output is replaced by a canned result.
function observeAllocations(run: () => void) {
  const stringify = JSON.stringify, from = Buffer.from;
  const metrics = { largeFormatted: 0, largeBuffers: 0, maxFormattedBytes: 0, maxBufferBytes: 0 };
  JSON.stringify = function (...args: Parameters<typeof JSON.stringify>) {
    const result = Reflect.apply(stringify, JSON, args);
    if (typeof result === "string" && result.length > 1024 * 1024) {
      metrics.largeFormatted++;
      metrics.maxFormattedBytes = Math.max(metrics.maxFormattedBytes, Buffer.byteLength(result));
    }
    return result;
  } as typeof JSON.stringify;
  Buffer.from = function (...args: unknown[]) {
    const result = Reflect.apply(from, Buffer, args) as Buffer;
    if (result.byteLength > 1024 * 1024) {
      metrics.largeBuffers++;
      metrics.maxBufferBytes = Math.max(metrics.maxBufferBytes, result.byteLength);
    }
    return result;
  } as typeof Buffer.from;
  try { run(); } finally { JSON.stringify = stringify; Buffer.from = from; }
  return metrics;
}
const invalid = (error: unknown) => error instanceof RealmRuntimeSaveError && error.code === "INVALID_SAVE";

test("F2 real runtime producer refuses compressed payload total above its consumer budget", () => {
  const record = recordWith(asciiBytes(LIMIT - Buffer.byteLength(serializeRealmRuntimeSaveRecordV1(recordWith()))));
  const emptyGoals = { ...goals, instances: [{ body: "" }] };
  const largeGoals = { ...goals, instances: [{ body: asciiBytes(LIMIT - Buffer.byteLength(serializeRealmRuntimeSaveGoalsV1(emptyGoals))) }] };
  const value = manifest(record, undefined, { goals: largeGoals });
  assert.throws(() => {
    const bytes = buildRealmRuntimeSaveArchive({ manifest: value, record, goals: largeGoals });
    console.log("F2-producer-returned-consumer-rejected", { archiveBytes: bytes.byteLength, compressedBudget: PACK_LIMITS.entryCompressedMax });
    assert.throws(() => validateStrictZipArchive(bytes, {
      entryNamePattern: /^(?:realm-save-manifest\.json|runtime\/(?:record|goals)\.json)$/,
      firstEntryName: "realm-save-manifest.json", entrySizeCap: () => LIMIT,
    }), { code: "PACK_TOO_LARGE", message: "total compressed size exceeds limit" });
  }, error => error instanceof RealmRuntimeSaveError && error.code === "INVALID_SAVE" && error.message.includes("total compressed size exceeds limit"));
});

// Read actual ZIP32 central-directory sizes from native zipSync output. This
// passive measurement does not replace compression, CRC, allocation or parser.
function compressedSizes(bytes: Uint8Array): Map<string, { compressed: number; uncompressed: number }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.byteLength - 22;
  const sizes = new Map<string, { compressed: number; uncompressed: number }>();
  let at = view.getUint32(end + 16, true);
  for (let i = 0; i < view.getUint16(end + 10, true); i++) {
    assert.equal(view.getUint32(at, true), 0x02014b50);
    const nameLength = view.getUint16(at + 28, true);
    sizes.set(new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength)), {
      compressed: view.getUint32(at + 20, true), uncompressed: view.getUint32(at + 24, true),
    });
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return sizes;
}
const compressedSum = (bytes: Uint8Array) => [...compressedSizes(bytes).values()].reduce((sum, entry) => sum + entry.compressed, 0);
const producedZipOptions = { firstEntryName: "runtime/record.json", entryNamePattern: /^runtime\/(?:record|goals|memory)\.json$/, entrySizeCap: () => LIMIT };

test("F2 final ZIP accepts exact compressed budget excluding framing and rejects +1", () => {
  const half = PACK_LIMITS.entryCompressedMax / 2;
  const entries = { "runtime/record.json": [new Uint8Array(half), { level: 0 as const }] as [Uint8Array, { level: 0 }],
    "runtime/goals.json": [new Uint8Array(half), { level: 0 as const }] as [Uint8Array, { level: 0 }] };
  const exact = zipSync(entries);
  assert.equal(compressedSum(exact), PACK_LIMITS.entryCompressedMax);
  assert.ok(exact.byteLength > PACK_LIMITS.entryCompressedMax, "ZIP headers must not be counted as payload");
  assert.strictEqual(finalizeRealmRuntimeSaveZip(exact, false), exact);
  const decoded = validateStrictZipArchive(exact, producedZipOptions);
  assert.equal([...decoded.values()].reduce((sum, bytes) => sum + bytes.byteLength, 0), PACK_LIMITS.entryCompressedMax);
  const over = zipSync({ ...entries, "runtime/goals.json": [new Uint8Array(half + 1), { level: 0 }] });
  assert.equal(compressedSum(over), PACK_LIMITS.entryCompressedMax + 1);
  assert.throws(() => finalizeRealmRuntimeSaveZip(over, false), invalid);
  assert.throws(() => validateStrictZipArchive(over, producedZipOptions), { code: "PACK_TOO_LARGE" });
});

test("F2 MemoryV2 final ZIP includes real ratio padding in exact budget and +1 refusal", () => {
  const memory = new Uint8Array(128 * 1024);
  const memoryEntry = [memory, { level: 6 as const }] as [Uint8Array, { level: 6 }];
  const seed = zipSync({ "runtime/memory.json": memoryEntry });
  const size = compressedSizes(seed).get("runtime/memory.json")!;
  const padding = 5 * Math.ceil((size.uncompressed / PACK_LIMITS.ratioMax - size.compressed) / 5);
  assert.ok(padding > 1);
  const half = PACK_LIMITS.entryCompressedMax / 2;
  const goalLength = PACK_LIMITS.entryCompressedMax - half - size.compressed - padding;
  const make = (extra: number) => zipSync({
    "runtime/record.json": [new Uint8Array(half), { level: 0 }],
    "runtime/goals.json": [new Uint8Array(goalLength + extra), { level: 0 }],
    "runtime/memory.json": memoryEntry,
  });
  const raw = make(0);
  assert.equal(compressedSum(raw), PACK_LIMITS.entryCompressedMax - padding);
  const exact = finalizeRealmRuntimeSaveZip(raw, true);
  assert.equal(compressedSum(exact), PACK_LIMITS.entryCompressedMax);
  assert.equal(exact.byteLength - raw.byteLength, padding);
  const decodedMemory = validateStrictZipArchive(exact, producedZipOptions).get("runtime/memory.json")!;
  assert.equal(Buffer.compare(Buffer.from(decodedMemory), Buffer.from(memory)), 0);
  const over = make(1);
  assert.ok(compressedSum(over) <= PACK_LIMITS.entryCompressedMax, "pre-padding total alone is insufficient");
  assert.strictEqual(finalizeRealmRuntimeSaveZip(over, false), over);
  assert.throws(() => finalizeRealmRuntimeSaveZip(over, true), invalid);
});

test("producer refuses real canonical 64MiB+1 before full rejected formatting or Buffer", () => {
  const overhead = Buffer.byteLength(serializeRealmRuntimeSaveRecordV1(recordWith()));
  const record = recordWith("x".repeat(LIMIT + 1 - overhead));
  const ordinaryManifest = manifest();
  const metrics = observeAllocations(() => {
    assert.throws(() => manifest(record), invalid);
    assert.throws(() => buildRealmRuntimeSaveArchive({ manifest: ordinaryManifest, record, goals }), invalid);
  });
  console.log("canonical-plus-one-allocation", metrics);
  assert.equal(metrics.largeFormatted, 0, "producer formatted the rejected large canonical leaf");
  assert.equal(metrics.largeBuffers, 0, "producer allocated the rejected section Buffer");
});

test("producer refuses real normalized-domain 64MiB+1 before full rejected formatting or Buffer", () => {
  const overhead = Buffer.byteLength(serializeRealmRuntimeSaveDomainV1(domainWith())) - 1;
  const domain = domainWith("x".repeat(LIMIT + 1 - overhead));
  const metrics = observeAllocations(() => assert.throws(() => manifest(recordWith(), domain), invalid));
  console.log("domain-plus-one-allocation", metrics);
  assert.equal(metrics.largeFormatted, 0, "producer formatted the rejected normalized domain");
  assert.equal(metrics.largeBuffers, 0, "producer allocated the rejected domain Buffer");
});

function wholeDomain(title = "x"): RealmRuntimeSaveDomainV1 {
  return { ...domainWith(title), stories: [{ id: "story", title: "Story", status: "active", premise: "" }],
    storyDefinitions: [], records: [] };
}
function asciiBytes(length: number): string {
  let seed = 127;
  const block = Buffer.alloc(65536);
  for (let i = 0; i < block.length; i++) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    block[i] = 97 + ((seed >>> 0) % 26);
  }
  const text = block.toString("ascii");
  return text.repeat(Math.floor(length / text.length)) + text.slice(0, length % text.length);
}

test("counter matches actual canonical runtime and normalized-domain UTF8 vectors", () => {
  const vectors = ["", "ASCII", "汉字é", "😀𝄞", "\ud800", "\udfff", "\ud800x\udfff", "\u0000\b\t\n\f\r\"\\",
    -0, 1e-7, 1e21, Number.MIN_VALUE, Number.MAX_VALUE, null, true, false,
    { z: [null, "😀", -0], "\u0000": "\\", "😀": { é: 0.3, a: [[], {}] } }];
  for (const payload of vectors) {
    const record = recordWith(); record.events[0]!.payload = payload;
    const text = serializeRealmRuntimeSaveRecordV1(record);
    assert.equal(countRuntimeSectionWireBytes(record, "canonical-runtime"), Buffer.byteLength(text));
    const normalized = { z: payload, "é😀\u0000": [payload, payload] };
    assert.equal(countRuntimeSectionWireBytes(normalized, "normalized-domain"), Buffer.byteLength(JSON.stringify(normalized)));
  }
  for (const number of [NaN, Infinity, -Infinity]) {
    assert.equal(countRuntimeSectionWireBytes(number, "canonical-runtime"), 4);
    const record = recordWith(); record.events[0]!.payload = number;
    assert.throws(() => manifest(record), invalid);
  }
});

test("counter preserves framing, duplicate emissions, sparse/undefined and inherited data semantics", () => {
  const repeated = { a: ["x", null, {}] };
  const data = [repeated, repeated, [], {}, [[], [repeated]]];
  assert.equal(countRuntimeSectionWireBytes(data, "normalized-domain"), Buffer.byteLength(JSON.stringify(data)));
  const sparse = new Array(4); sparse[1] = "汉";
  const record = recordWith(); record.events[0]!.payload = sparse;
  assert.equal(countRuntimeSectionWireBytes(record, "canonical-runtime"), Buffer.byteLength(serializeRealmRuntimeSaveRecordV1(record)));
  assert.equal(countRuntimeSectionWireBytes(sparse, "normalized-domain"), Buffer.byteLength(JSON.stringify(sparse)));
  assert.equal(countRuntimeSectionWireBytes({ omitted: undefined, emitted: [undefined] }, "normalized-domain"), 18);
  assert.throws(() => countRuntimeSectionWireBytes({ value: undefined }, "canonical-runtime"), invalid);
  const inherited = Object.assign(Object.create({ ignored: "x".repeat(100) }), { own: null });
  Object.defineProperty(inherited, "hidden", { value: "ignored" });
  assert.equal(countRuntimeSectionWireBytes(inherited, "canonical-runtime"), 12);
  const arrayPrototype = Object.create(Array.prototype);
  Object.defineProperty(arrayPrototype, "0", { value: "inherited" });
  const array = new Array(1); Object.setPrototypeOf(array, arrayPrototype);
  assert.equal(countRuntimeSectionWireBytes(array, "normalized-domain"), Buffer.byteLength(JSON.stringify(array)));
  record.events[0]!.payload = array;
  assert.equal(countRuntimeSectionWireBytes(record, "canonical-runtime"), Buffer.byteLength(serializeRealmRuntimeSaveRecordV1(record)));
});

test("counter is iterative, stops at its budget, rejects cycles and never calls accessors/toJSON", () => {
  let value: unknown = null;
  for (let i = 0; i < 20000; i++) value = [value];
  assert.equal(countRuntimeSectionWireBytes(value, "canonical-runtime"), 40004);
  assert.equal(countRuntimeSectionWireBytes(new Array(1000000), "canonical-runtime", 1000001), 1000001);
  assert.throws(() => countRuntimeSectionWireBytes(new Array(0xffffffff), "canonical-runtime", 4), invalid);
  const cycle: unknown[] = []; cycle.push(cycle);
  assert.throws(() => countRuntimeSectionWireBytes(cycle, "canonical-runtime"), invalid);
  let called = 0;
  const accessor = Object.defineProperty({}, "x", { enumerable: true, get() { called++; return 1; } });
  assert.throws(() => countRuntimeSectionWireBytes(accessor, "normalized-domain"), invalid);
  assert.throws(() => countRuntimeSectionWireBytes({ toJSON() { called++; return {}; } }, "normalized-domain"), invalid);
  const late = Object.defineProperty({}, "late", { enumerable: true, get() { called++; return 1; } });
  assert.throws(() => countRuntimeSectionWireBytes(["x".repeat(1024), late], "canonical-runtime", 10), invalid);
  assert.equal(called, 0);
});

test("section ledger checks integer-safe file/aggregate admission and undercharge/overcharge", () => {
  const ledger = new RuntimeSectionWireLedger("runtime/domain.json", "normalized-domain", 17);
  assert.equal(ledger.filePath, "runtime/domain.json"); assert.equal(ledger.formatter, "normalized-domain");
  ledger.reserve({ rows: [null] });
  assert.equal(ledger.acceptedBytes, 15); assert.equal(ledger.remainingBytes, 2);
  ledger.checkLowerBound(2); ledger.verify(15);
  for (const bytes of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) assert.throws(() => ledger.addExact(bytes), invalid);
  assert.throws(() => ledger.verify(14), invalid); assert.throws(() => ledger.verify(16), invalid);
  ledger.addExact(2); assert.equal(ledger.remainingBytes, 0);
  assert.throws(() => ledger.addExact(1), invalid);
  assert.throws(() => new RuntimeSectionWireLedger("runtime/x.json", "canonical-runtime", -1), invalid);
  assert.throws(() => new RuntimeSectionWireLedger("runtime/x.json", "canonical-runtime", LIMIT, LIMIT + 1), invalid);
});

test("both domain normalizers retain legal legacy 257 IDs, large/deep JSON and optional emission", () => {
  const legacy = domainWith("汉😀\\\u0000"); legacy.projects[0]!.id = "p".repeat(257);
  Object.defineProperty(legacy.projects[0]!, "ignoredNonEnumerable", { value: "ignored" });
  let deep: unknown = "x".repeat(16385);
  for (let i = 0; i < 34; i++) deep = { nested: deep };
  legacy.characterAssets = [{ recordId: "record", characterInstanceId: "character", assetDefinitionId: "asset",
    quantity: 0, revision: 0, metadata: { deep, many: new Array(1025).fill(null), sparse: new Array(2) } } as never];
  const normalized = normalizeRealmRuntimeSaveDomainV1(legacy);
  assert.equal(normalized.projects[0]!.id.length, 257);
  assert.equal(Object.hasOwn(normalized.projects[0]!, "ignoredNonEnumerable"), false);
  assert.equal(Object.hasOwn(normalized.characterAssets[0]!, "assetKey"), false);
  assert.equal(countRuntimeSectionWireBytes(normalized, "normalized-domain"), Buffer.byteLength(serializeRealmRuntimeSaveDomainV1(legacy)));
  assert.throws(() => normalizeRealmRuntimeSaveDomainV1({ ...wholeDomain(), projects: legacy.projects }), { code: "INVALID_DOMAIN_SAVE" });
  const whole = normalizeRealmRuntimeSaveDomainV1(wholeDomain());
  const ledger = new RuntimeSectionWireLedger("runtime/domain.json", "normalized-domain");
  assert.equal(serializeNormalizedRealmRuntimeSaveDomainV1ForArchive(whole, ledger), serializeRealmRuntimeSaveDomainV1(whole));
  assert.throws(() => normalizeRealmRuntimeSaveDomainV1({ ...wholeDomain(), characterAssets: legacy.characterAssets }), { code: "INVALID_DOMAIN_SAVE" });
});

test("standalone parsers keep >64MiB raw whitespace, numeric spelling and ignored optional fields", () => {
  const domain = domainWith(); domain.characterAssets = [{ recordId: "record", characterInstanceId: "character",
    assetDefinitionId: "asset", quantity: 0, revision: 0, metadata: {}, assetKey: undefined }];
  const text = serializeRealmRuntimeSaveDomainV1(domain);
  const raw = " ".repeat(LIMIT) + text.replace('"version":1', '"version":1.000000e0');
  assert.deepEqual(parseRealmRuntimeSaveDomainV1(raw), normalizeRealmRuntimeSaveDomainV1(domain));
  assert.deepEqual(parseRealmRuntimeSaveDomainV1(Buffer.from(raw)), normalizeRealmRuntimeSaveDomainV1(domain));
  const value = manifest();
  assert.deepEqual(parseRealmRuntimeSaveManifestV2(" ".repeat(LIMIT) + JSON.stringify(value)), value);
  assert.deepEqual(normalizeRealmRuntimeSaveDomainV1(domain), JSON.parse(text));
});

for (const shape of ["canonical", "legacy-domain", "whole-domain"] as const) {
  test(`actual manifest/archive accepts exact 64MiB ${shape} and preserves emitted bytes/hash`, () => {
    let record = recordWith();
    let domain: RealmRuntimeSaveDomainV1 | undefined;
    if (shape === "canonical") {
      const overhead = Buffer.byteLength(serializeRealmRuntimeSaveRecordV1(record));
      record = recordWith(asciiBytes(LIMIT - overhead));
    } else {
      domain = shape === "whole-domain" ? wholeDomain() : domainWith();
      const overhead = Buffer.byteLength(serializeRealmRuntimeSaveDomainV1(domain)) - 1;
      domain.projects[0]!.title = asciiBytes(LIMIT - overhead);
    }
    const value = manifest(record, domain);
    const bytes = buildRealmRuntimeSaveArchive({ manifest: value, record, goals, domain });
    const files = unzipSync(bytes);
    const path = shape === "canonical" ? "runtime/record.json" : "runtime/domain.json";
    assert.equal(files[path]!.byteLength, LIMIT);
    const expected = shape === "canonical" ? serializeRealmRuntimeSaveRecordV1(record) : serializeRealmRuntimeSaveDomainV1(domain!);
    assert.equal(Buffer.compare(Buffer.from(files[path]!), Buffer.from(expected)), 0);
    const entries = new Map(Object.entries(files).filter(([name]) => name.startsWith("runtime/")));
    assert.equal(computeRealmRuntimeSaveContentHash(entries), value.snapshot.runtimeHash);
    assert.equal(parseRealmRuntimeSaveArchive(bytes).manifest.snapshot.runtimeHash, value.snapshot.runtimeHash);
    console.log("real-exact-wire", { shape, bytes: LIMIT, runtimeHash: value.snapshot.runtimeHash,
      sectionHash: createHash("sha256").update(files[path]!).digest("hex"), archiveBytes: bytes.byteLength });
    if (domain) {
      domain.projects[0]!.title += "x";
      const metrics = observeAllocations(() => {
        assert.throws(() => manifest(record, domain), error => invalid(error) || (error as { code?: string }).code === "INVALID_DOMAIN_SAVE");
        assert.throws(() => buildRealmRuntimeSaveArchive({ manifest: value, record, goals, domain }),
          error => invalid(error) || (error as { code?: string }).code === "INVALID_DOMAIN_SAVE");
      });
      console.log("real-plus-one-wire", { shape, bytes: LIMIT + 1, ...metrics });
      assert.equal(metrics.largeFormatted, 0); assert.equal(metrics.largeBuffers, 0);
    }
  });
}

test("actual manifest/archive accepts exact 256MiB aggregate including manifest and refuses +1", () => {
  const totalLimit = PACK_LIMITS.totalUncompressedMax;
  assert.equal(totalLimit, 256 * 1024 * 1024);
  // Keep the independent compressed-total and ratio limits satisfied as well.
  // Eight-character runs in a 64KiB block give moderate compression, rather
  // than either incompressible data (>64MiB compressed total) or a ZIP bomb.
  const aggregateBytes = (length: number) => {
    const block = asciiBytes(8192).replace(/./g, character => character.repeat(8));
    return block.repeat(Math.floor(length / block.length)) + block.slice(0, length % block.length);
  };
  const baseGoals = { ...goals, instances: [{ body: "" }] };
  const firstNight: RealmRuntimeSaveFirstNightV1 = { format: "realm-runtime-first-night", schemaVersion: 1,
    entry: { state: "ready", attempts: 1, hookContent: "", suggestions: [], context: { body: "" } } };
  // The real manifest has a fixed-length hash, so its exact framing can be
  // measured before creating large bodies without guessing a JSON envelope.
  const seed = manifest(recordWith(), domainWith(), { goals: baseGoals, firstNight });
  const manifestBytes = Buffer.byteLength(serializeRealmRuntimeSaveManifestV2(seed));
  const recordText = aggregateBytes(LIMIT - Buffer.byteLength(serializeRealmRuntimeSaveRecordV1(recordWith())));
  const record = recordWith(recordText);
  const goalText = aggregateBytes(LIMIT - Buffer.byteLength(serializeRealmRuntimeSaveGoalsV1(baseGoals)));
  const largeGoals = { ...goals, instances: [{ body: goalText }] };
  const firstNightText = aggregateBytes(LIMIT - Buffer.byteLength(serializeRealmRuntimeSaveFirstNightV1(firstNight)));
  firstNight.entry!.context = { body: firstNightText };
  const domainBytes = totalLimit - 3 * LIMIT - manifestBytes;
  assert.ok(domainBytes > 0 && domainBytes < LIMIT);
  const domainOverhead = Buffer.byteLength(serializeRealmRuntimeSaveDomainV1(domainWith())) - 1;
  const domainText = aggregateBytes(domainBytes - domainOverhead);
  const domain = domainWith(domainText);
  const value = manifest(record, domain, { goals: largeGoals, firstNight });
  assert.equal(Buffer.byteLength(serializeRealmRuntimeSaveManifestV2(value)), manifestBytes);
  const bytes = buildRealmRuntimeSaveArchive({ manifest: value, record, goals: largeGoals, firstNight, domain });
  assert.ok(bytes.byteLength < PACK_LIMITS.entryCompressedMax, 'fixture also fits the compressed archive allowance');
  {
    const files = unzipSync(bytes);
    assert.deepEqual(Object.keys(files).sort(), ['realm-save-manifest.json', 'runtime/domain.json',
      'runtime/first-night.json', 'runtime/goals.json', 'runtime/record.json'].sort());
    assert.equal(Object.values(files).reduce((sum, file) => sum + file.byteLength, 0), totalLimit);
    for (const path of ['runtime/record.json', 'runtime/goals.json', 'runtime/first-night.json']) {
      assert.equal(files[path]!.byteLength, LIMIT);
    }
    assert.equal(files['runtime/domain.json']!.byteLength, domainBytes);
    assert.equal(files['realm-save-manifest.json']!.byteLength, manifestBytes);
    const runtime = new Map(Object.entries(files).filter(([name]) => name.startsWith('runtime/')));
    assert.equal(computeRealmRuntimeSaveContentHash(runtime), value.snapshot.runtimeHash);
  }
  console.log('aggregate-wire-before-parse', { archiveBytes: bytes.byteLength, totalLimit, manifestBytes, domainBytes });
  let decoded: ReturnType<typeof parseRealmRuntimeSaveArchive>;
  try { decoded = parseRealmRuntimeSaveArchive(bytes); }
  catch (error) {
    try {
      validateStrictZipArchive(bytes, {
        entryNamePattern: /^(?:realm-save-manifest\.json|runtime\/(?:record|goals|first-night|domain)\.json)$/,
        firstEntryName: 'realm-save-manifest.json', entrySizeCap: () => LIMIT,
      });
    } catch (cause) {
      console.log('aggregate-strict-refusal', { code: (cause as { code?: string }).code,
        message: cause instanceof Error ? cause.message : String(cause) });
    }
    throw error;
  }
  const digest = (body: unknown) => {
    assert.equal(typeof body, 'string');
    return createHash('sha256').update(body as string).digest('hex');
  };
  assert.equal(digest((decoded.record.events[0]!.payload as { content: string }).content), digest(recordText));
  const decodedGoal = decoded.goals.instances[0];
  assert.ok(decodedGoal !== null && typeof decodedGoal === 'object' && !Array.isArray(decodedGoal));
  assert.equal(digest((decodedGoal as { body?: unknown }).body), digest(goalText));
  const decodedContext = decoded.firstNight!.entry!.context;
  assert.ok(decodedContext !== null && typeof decodedContext === 'object' && !Array.isArray(decodedContext));
  assert.equal(digest((decodedContext as { body?: unknown }).body), digest(firstNightText));
  assert.equal(digest(decoded.domain!.projects[0]!.title), digest(domainText));
  assert.equal(decoded.manifest.snapshot.runtimeHash, value.snapshot.runtimeHash);

  // Domain still fits the per-file allowance: only the shared archive total
  // crosses its default limit, by exactly one byte, with manifest included.
  const overDomain = { ...domain, projects: domain.projects.map(project => ({ ...project, title: project.title + 'x' })) };
  assert.equal(countRuntimeSectionWireBytes(overDomain, 'normalized-domain'), domainBytes + 1);
  assert.ok(domainBytes + 1 < LIMIT);
  for (const build of [
    () => manifest(record, overDomain, { goals: largeGoals, firstNight }),
    () => buildRealmRuntimeSaveArchive({ manifest: value, record, goals: largeGoals, firstNight, domain: overDomain }),
  ]) {
    const metrics = observeAllocations(() => assert.throws(build, invalid));
    assert.equal(metrics.largeFormatted, 3, 'the fourth file must refuse before formatting');
    assert.equal(metrics.largeBuffers, 3, 'the fourth file must refuse before Buffer allocation');
    assert.equal(metrics.maxBufferBytes, LIMIT);
  }
  console.log('real-exact-aggregate', { totalBytes: totalLimit, manifestBytes, domainBytes,
    archiveBytes: bytes.byteLength, runtimeHash: value.snapshot.runtimeHash });
});

test("actual producer enforces 256MiB aggregate including manifest before fourth large section allocation", () => {
  const record = recordWith("x".repeat(LIMIT - Buffer.byteLength(serializeRealmRuntimeSaveRecordV1(recordWith()))));
  const baseGoals = { ...goals, instances: [{ body: "" }] };
  const largeGoals = { ...goals, instances: [{ body: "x".repeat(LIMIT - Buffer.byteLength(serializeRealmRuntimeSaveGoalsV1(baseGoals))) }] };
  const firstNight: RealmRuntimeSaveFirstNightV1 = { format: "realm-runtime-first-night", schemaVersion: 1,
    entry: { state: "ready", attempts: 1, hookContent: "", suggestions: [], context: { body: "" } } };
  firstNight.entry!.context = { body: "x".repeat(LIMIT - Buffer.byteLength(serializeRealmRuntimeSaveFirstNightV1(firstNight))) };
  const domain = domainWith("x".repeat(LIMIT - (Buffer.byteLength(serializeRealmRuntimeSaveDomainV1(domainWith())) - 1)));
  const metrics = observeAllocations(() => assert.throws(() => manifest(record, domain, { goals: largeGoals, firstNight }), invalid));
  console.log("real-aggregate-allocation", { limit: 4 * LIMIT, attemptedSectionBytes: 4 * LIMIT, ...metrics });
  assert.equal(metrics.largeBuffers, 3, "the fourth file must refuse before its Buffer");
  assert.equal(metrics.largeFormatted, 3, "the fourth file must refuse before its formatter");
});
