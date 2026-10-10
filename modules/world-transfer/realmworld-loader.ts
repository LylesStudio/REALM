/**
 * RealmWorld directory loader and install/mount lifecycle.
 *
 * The package is declarative data only. This boundary reads bytes, validates
 * the fixed content schema, verifies the manifest/content hash, and never
 * imports or executes anything from the package (including WebUI JavaScript).
 * ZIP transport can call the same loader after extracting into an isolated
 * directory; installation itself is an atomic directory rename.
 */
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { zipSync, type ZipOptions } from "fflate";
import {
  RealmPackError,
  validateStrictZipArchive,
} from "./realm-pack.ts";
import {
  parseRealmWorldManifest,
  serializeRealmWorldManifest,
  type RealmWorldManifestV1,
} from "./realmworld-manifest.ts";

export type RealmWorldLoaderErrorCode =
  | "INVALID_PACKAGE"
  | "UNSUPPORTED_PACKAGE_ENTRY"
  | "SYMLINK_NOT_ALLOWED"
  | "CONTENT_SCHEMA_INVALID"
  | "CONTENT_HASH_MISMATCH"
  | "SIGNATURE_VERIFIER_REQUIRED"
  | "SIGNATURE_INVALID"
  | "WORLD_NOT_INSTALLED"
  | "INSTALL_CONFLICT";

export class RealmWorldLoaderError extends Error {
  readonly code: RealmWorldLoaderErrorCode;

  constructor(code: RealmWorldLoaderErrorCode, message: string) {
    super(message);
    this.name = "RealmWorldLoaderError";
    this.code = code;
  }
}

export interface RealmWorldSignatureVerifierInput {
  manifest: RealmWorldManifestV1;
  manifestBytes: Uint8Array;
  contentHash: string;
}

export type RealmWorldSignatureVerifier = (
  input: RealmWorldSignatureVerifierInput,
) => boolean | Promise<boolean>;

export interface LoadedRealmWorldDirectory {
  manifest: RealmWorldManifestV1;
  manifestBytes: Uint8Array;
  rootDir: string | null;
  /** Relative package path → immutable byte snapshot. */
  files: ReadonlyMap<string, Uint8Array>;
}

export interface InstalledRealmWorld extends Omit<LoadedRealmWorldDirectory, "rootDir"> {
  rootDir: string;
  installDir: string;
  reused: boolean;
}

export const REALMWORLD_CONTENT_INDEX = "content/index.json" as const;
export const REALMWORLD_WORLD_DOCUMENT = "content/world.json" as const;
export const REALMWORLD_CONTENT_SCHEMA_VERSION = 1 as const;

const REALMWORLD_ARCHIVE_ENTRY_RE = /^(realmworld-manifest\.json|content\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.json|media\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*(?:\.[A-Za-z0-9_-]+)?|ui\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*(?:\.[A-Za-z0-9_-]+)?)$/;
const DOS_EPOCH_ZERO = new Date(1980, 0, 1, 0, 0, 0);

const MAX_CONTENT_FILE_BYTES = 16 * 1024 * 1024;
const MAX_CONTENT_FILES = 2_000;
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9._-]+$/;
const JSON_PATH = /^content\/[A-Za-z0-9._/-]+\.json$/;
const MEDIA_PATH = /^media\/[A-Za-z0-9._/-]+$/;
const UI_PATH = /^ui\/[A-Za-z0-9._/-]+$/;

interface RealmWorldContentIndex {
  format: "realmworld-content";
  schemaVersion: typeof REALMWORLD_CONTENT_SCHEMA_VERSION;
  modules: readonly string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function errorCode(error: unknown): string | undefined {
  return isPlainObject(error) && typeof error.code === "string" ? error.code : undefined;
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new RealmWorldLoaderError(
        "CONTENT_SCHEMA_INVALID",
        `unknown content key ${where}.${key}`,
      );
    }
  }
}

function requireField(value: Record<string, unknown>, key: string, where: string): unknown {
  if (!hasOwn(value, key)) {
    throw new RealmWorldLoaderError(
      "CONTENT_SCHEMA_INVALID",
      `content ${where}.${key} is required`,
    );
  }
  return value[key];
}

function assertSafeRelativePath(path: string): void {
  if (
    path.length === 0
    || path.startsWith("/")
    || path.includes("\\")
    || path.split("/").some((segment) => (
      segment.length === 0
      || segment === "."
      || segment === ".."
      || !SAFE_PATH_SEGMENT.test(segment)
    ))
  ) {
    throw new RealmWorldLoaderError("UNSUPPORTED_PACKAGE_ENTRY", "unsafe package path");
  }
}

function assertAllowedPackagePath(path: string): void {
  assertSafeRelativePath(path);
  if (path === "realmworld-manifest.json") return;
  if (JSON_PATH.test(path) || MEDIA_PATH.test(path) || UI_PATH.test(path)) return;
  throw new RealmWorldLoaderError(
    "UNSUPPORTED_PACKAGE_ENTRY",
    `unsupported RealmWorld package entry: ${path}`,
  );
}

function assertSafeInstallComponent(value: string, where: string): void {
  if (
    value.length === 0
    || value === "."
    || value === ".."
    || !SAFE_PATH_SEGMENT.test(value)
  ) {
    throw new RealmWorldLoaderError("INVALID_PACKAGE", `${where} is not a safe install component`);
  }
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function contentEntries(
  files: ReadonlyMap<string, Uint8Array> | readonly { path: string; bytes: Uint8Array }[],
): { path: string; bytes: Uint8Array }[] {
  const entries: { path: string; bytes: Uint8Array }[] = Array.isArray(files)
    ? files.map(({ path, bytes }) => ({ path, bytes }))
    : [...files.entries()].map(([path, bytes]) => ({ path, bytes }));
  if (entries.length > MAX_CONTENT_FILES) {
    throw new RealmWorldLoaderError("INVALID_PACKAGE", "too many RealmWorld content files");
  }
  for (const entry of entries) {
    assertAllowedPackagePath(entry.path);
    if (entry.path === "realmworld-manifest.json") {
      throw new RealmWorldLoaderError("INVALID_PACKAGE", "manifest is not content data");
    }
    if (entry.bytes.byteLength > MAX_CONTENT_FILE_BYTES) {
      throw new RealmWorldLoaderError("INVALID_PACKAGE", "content file exceeds size limit");
    }
  }
  return entries.sort((left, right) => compareUtf8(left.path, right.path));
}

/** Stable content hash over relative path, byte length, and file sha256. */
export function computeRealmWorldContentHash(
  files: ReadonlyMap<string, Uint8Array> | readonly { path: string; bytes: Uint8Array }[],
): string {
  const preimage = contentEntries(files)
    .map(({ path, bytes }) => `${path}\n${bytes.byteLength}\n${sha256Hex(bytes)}\n`)
    .join("");
  return createHash("sha256").update(preimage, "utf8").digest("hex");
}

function parseJson(bytes: Uint8Array, where: string): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new RealmWorldLoaderError("CONTENT_SCHEMA_INVALID", `${where} is not valid JSON`);
  }
}

function parseContentIndex(value: unknown): RealmWorldContentIndex {
  if (!isPlainObject(value)) {
    throw new RealmWorldLoaderError("CONTENT_SCHEMA_INVALID", "content index must be an object");
  }
  assertExactKeys(value, ["format", "schemaVersion", "modules"], "index");
  if (value.format !== "realmworld-content") {
    throw new RealmWorldLoaderError("CONTENT_SCHEMA_INVALID", "content index format is invalid");
  }
  if (value.schemaVersion !== REALMWORLD_CONTENT_SCHEMA_VERSION) {
    throw new RealmWorldLoaderError("CONTENT_SCHEMA_INVALID", "content schema version is unsupported");
  }
  if (
    !Array.isArray(value.modules)
    || value.modules.length === 0
    || !value.modules.every((module) => typeof module === "string")
  ) {
    throw new RealmWorldLoaderError("CONTENT_SCHEMA_INVALID", "content index modules must be non-empty string[]");
  }
  const modules = value.modules as string[];
  if (new Set(modules).size !== modules.length) {
    throw new RealmWorldLoaderError("CONTENT_SCHEMA_INVALID", "content index modules must be unique");
  }
  for (const modulePath of modules) {
    if (!JSON_PATH.test(modulePath) || modulePath === REALMWORLD_CONTENT_INDEX) {
      throw new RealmWorldLoaderError("CONTENT_SCHEMA_INVALID", "content index contains an invalid module path");
    }
  }
  if (!modules.includes(REALMWORLD_WORLD_DOCUMENT)) {
    throw new RealmWorldLoaderError("CONTENT_SCHEMA_INVALID", "content index must include content/world.json");
  }
  return {
    format: "realmworld-content",
    schemaVersion: REALMWORLD_CONTENT_SCHEMA_VERSION,
    modules: [...modules].sort(compareUtf8),
  };
}

function validateWorldDocument(value: unknown, manifest: RealmWorldManifestV1): void {
  if (!isPlainObject(value)) {
    throw new RealmWorldLoaderError("CONTENT_SCHEMA_INVALID", "content/world.json must be an object");
  }
  assertExactKeys(value, ["worldId", "title", "settings"], "world");
  if (value.worldId !== manifest.worldId) {
    throw new RealmWorldLoaderError("CONTENT_SCHEMA_INVALID", "content/world.json worldId mismatch");
  }
  if (!isPlainObject(requireField(value, "title", "world"))) {
    throw new RealmWorldLoaderError("CONTENT_SCHEMA_INVALID", "content/world.json title must be an object");
  }
  const title = value.title as Record<string, unknown>;
  if (
    Object.keys(title).length === 0
    || Object.values(title).some((text) => typeof text !== "string" || text.trim().length === 0)
  ) {
    throw new RealmWorldLoaderError("CONTENT_SCHEMA_INVALID", "content/world.json title is invalid");
  }
  if (hasOwn(value, "settings") && !isPlainObject(value.settings)) {
    throw new RealmWorldLoaderError("CONTENT_SCHEMA_INVALID", "content/world.json settings must be an object");
  }
}

function validateContent(files: ReadonlyMap<string, Uint8Array>, manifest: RealmWorldManifestV1): void {
  const indexBytes = files.get(REALMWORLD_CONTENT_INDEX);
  if (!indexBytes) {
    throw new RealmWorldLoaderError("CONTENT_SCHEMA_INVALID", "content/index.json is required");
  }
  const index = parseContentIndex(parseJson(indexBytes, REALMWORLD_CONTENT_INDEX));
  const contentJsonPaths = [...files.keys()]
    .filter((path) => path.startsWith("content/") && path.endsWith(".json"))
    .sort(compareUtf8);
  const expected = [REALMWORLD_CONTENT_INDEX, ...index.modules].sort(compareUtf8);
  if (contentJsonPaths.length !== expected.length
    || contentJsonPaths.some((path, indexPosition) => path !== expected[indexPosition])) {
    throw new RealmWorldLoaderError("CONTENT_SCHEMA_INVALID", "content index does not cover content JSON files exactly");
  }
  for (const modulePath of index.modules) {
    const bytes = files.get(modulePath);
    if (!bytes) {
      throw new RealmWorldLoaderError("CONTENT_SCHEMA_INVALID", `missing content module ${modulePath}`);
    }
    const value = parseJson(bytes, modulePath);
    if (modulePath === REALMWORLD_WORLD_DOCUMENT) validateWorldDocument(value, manifest);
  }
}

async function assertDirectory(path: string, missingCode: RealmWorldLoaderErrorCode = "INVALID_PACKAGE"): Promise<void> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) {
      throw new RealmWorldLoaderError("SYMLINK_NOT_ALLOWED", "package root may not be a symlink");
    }
    if (!stats.isDirectory()) {
      throw new RealmWorldLoaderError(missingCode, "package root must be a directory");
    }
  } catch (error) {
    if (error instanceof RealmWorldLoaderError) throw error;
    if (errorCode(error) === "ENOENT") {
      throw new RealmWorldLoaderError(missingCode, "package directory does not exist");
    }
    throw new RealmWorldLoaderError("INVALID_PACKAGE", "package directory cannot be read");
  }
}

async function readPackageFiles(rootDir: string): Promise<ReadonlyMap<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();

  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      assertSafeRelativePath(relativePath);
      const absolutePath = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new RealmWorldLoaderError("SYMLINK_NOT_ALLOWED", "symlinks are not allowed in RealmWorld packages");
      }
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) {
        throw new RealmWorldLoaderError("UNSUPPORTED_PACKAGE_ENTRY", "special filesystem entries are not allowed");
      }
      if (relativePath === "realmworld-manifest.json") continue;
      assertAllowedPackagePath(relativePath);
      const bytes = new Uint8Array(await readFile(absolutePath));
      if (bytes.byteLength > MAX_CONTENT_FILE_BYTES) {
        throw new RealmWorldLoaderError("INVALID_PACKAGE", "content file exceeds size limit");
      }
      files.set(relativePath, bytes);
      if (files.size > MAX_CONTENT_FILES) {
        throw new RealmWorldLoaderError("INVALID_PACKAGE", "too many RealmWorld content files");
      }
    }
  }

  await visit(rootDir, "");
  return files;
}

async function loadManifest(rootDir: string): Promise<{ manifest: RealmWorldManifestV1; bytes: Uint8Array }> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(join(rootDir, "realmworld-manifest.json")));
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new RealmWorldLoaderError("INVALID_PACKAGE", "realmworld-manifest.json is required");
    }
    throw new RealmWorldLoaderError("INVALID_PACKAGE", "RealmWorld manifest cannot be read");
  }
  try {
    return { manifest: parseRealmWorldManifest(bytes), bytes };
  } catch {
    throw new RealmWorldLoaderError("INVALID_PACKAGE", "RealmWorld manifest is invalid");
  }
}

async function verifyLoadedPackage(
  manifest: RealmWorldManifestV1,
  manifestBytes: Uint8Array,
  files: ReadonlyMap<string, Uint8Array>,
  verifySignature?: RealmWorldSignatureVerifier,
): Promise<void> {
  const contentHash = computeRealmWorldContentHash(files);
  if (contentHash !== manifest.contentHash) {
    throw new RealmWorldLoaderError("CONTENT_HASH_MISMATCH", "RealmWorld content hash mismatch");
  }
  validateContent(files, manifest);
  assertWebUiLayout(files, manifest);
  if (!verifySignature) {
    throw new RealmWorldLoaderError("SIGNATURE_VERIFIER_REQUIRED", "RealmWorld signature verifier is required");
  }
  let verified = false;
  try {
    verified = await verifySignature({ manifest, manifestBytes, contentHash });
  } catch {
    verified = false;
  }
  if (!verified) {
    throw new RealmWorldLoaderError("SIGNATURE_INVALID", "RealmWorld signature is invalid");
  }
}

function assertWebUiLayout(
  files: ReadonlyMap<string, Uint8Array>,
  manifest: RealmWorldManifestV1,
): void {
  if (manifest.webui && !manifest.webui.entry.startsWith("ui/")) {
    throw new RealmWorldLoaderError("CONTENT_SCHEMA_INVALID", "manifest WebUI entry must be under ui/");
  }
  if (manifest.webui && !files.has(manifest.webui.entry)) {
    throw new RealmWorldLoaderError("CONTENT_SCHEMA_INVALID", "manifest WebUI entry is missing");
  }
  if ([...files.keys()].some((path) => path.startsWith("ui/") && !manifest.webui)) {
    throw new RealmWorldLoaderError("CONTENT_SCHEMA_INVALID", "UI files require manifest.webui");
  }
}

/** Build a deterministic `.realmworld` ZIP using the shared strict ZIP ABI. */
export function buildRealmWorldArchive(input: {
  manifest: RealmWorldManifestV1;
  files: ReadonlyMap<string, Uint8Array>;
}): Uint8Array {
  const contentHash = computeRealmWorldContentHash(input.files);
  if (contentHash !== input.manifest.contentHash) {
    throw new RealmWorldLoaderError("CONTENT_HASH_MISMATCH", "RealmWorld content hash mismatch");
  }
  validateContent(input.files, input.manifest);
  assertWebUiLayout(input.files, input.manifest);
  const entries: Record<string, [Uint8Array, ZipOptions]> = {
    "realmworld-manifest.json": [
      Buffer.from(serializeRealmWorldManifest(input.manifest), "utf8"),
      { level: 6, mtime: DOS_EPOCH_ZERO },
    ],
  };
  for (const { path, bytes } of contentEntries(input.files)) {
    entries[path] = [
      bytes,
      { level: path.startsWith("media/") ? 0 : 6, mtime: DOS_EPOCH_ZERO },
    ];
  }
  return zipSync(entries);
}

export async function loadRealmWorldArchive(
  bytes: Uint8Array,
  options: { verifySignature?: RealmWorldSignatureVerifier } = {},
): Promise<LoadedRealmWorldDirectory> {
  let decoded: ReadonlyMap<string, Uint8Array>;
  try {
    decoded = validateStrictZipArchive(bytes, {
      entryNamePattern: REALMWORLD_ARCHIVE_ENTRY_RE,
      firstEntryName: "realmworld-manifest.json",
      entrySizeCap: (name) => name.startsWith("media/") || name.startsWith("ui/")
        ? 32 * 1024 * 1024
        : MAX_CONTENT_FILE_BYTES,
    });
  } catch (error) {
    if (error instanceof RealmPackError) {
      throw new RealmWorldLoaderError("INVALID_PACKAGE", "RealmWorld archive failed ZIP validation");
    }
    throw error;
  }
  const manifestBytes = decoded.get("realmworld-manifest.json");
  if (!manifestBytes) {
    throw new RealmWorldLoaderError("INVALID_PACKAGE", "RealmWorld archive manifest is missing");
  }
  let manifest: RealmWorldManifestV1;
  try {
    manifest = parseRealmWorldManifest(manifestBytes);
  } catch {
    throw new RealmWorldLoaderError("INVALID_PACKAGE", "RealmWorld archive manifest is invalid");
  }
  const files = new Map<string, Uint8Array>();
  for (const [path, fileBytes] of decoded) {
    if (path === "realmworld-manifest.json") continue;
    assertAllowedPackagePath(path);
    files.set(path, fileBytes);
  }
  await verifyLoadedPackage(manifest, manifestBytes, files, options.verifySignature);
  return { manifest, manifestBytes, rootDir: null, files };
}

export async function loadRealmWorldDirectory(
  sourceDir: string,
  options: { verifySignature?: RealmWorldSignatureVerifier } = {},
): Promise<LoadedRealmWorldDirectory> {
  const rootDir = resolve(sourceDir);
  await assertDirectory(rootDir);
  const { manifest, bytes: manifestBytes } = await loadManifest(rootDir);
  const files = await readPackageFiles(rootDir);
  await verifyLoadedPackage(manifest, manifestBytes, files, options.verifySignature);
  return { manifest, manifestBytes, rootDir, files };
}

async function existingInstalledPackage(
  installDir: string,
  verifySignature: RealmWorldSignatureVerifier,
): Promise<(LoadedRealmWorldDirectory & { rootDir: string }) | null> {
  try {
    const stats = await lstat(installDir);
    if (stats.isSymbolicLink()) {
      throw new RealmWorldLoaderError("SYMLINK_NOT_ALLOWED", "installed RealmWorld may not be a symlink");
    }
    if (!stats.isDirectory()) {
      throw new RealmWorldLoaderError("INSTALL_CONFLICT", "installed RealmWorld path is not a directory");
    }
  } catch (error) {
    if (error instanceof RealmWorldLoaderError) throw error;
    if (errorCode(error) === "ENOENT") return null;
    throw new RealmWorldLoaderError("INSTALL_CONFLICT", "installed RealmWorld cannot be inspected");
  }
  return loadRealmWorldDirectory(installDir, { verifySignature }) as Promise<
    LoadedRealmWorldDirectory & { rootDir: string }
  >;
}

async function installLoadedRealmWorld(input: {
  loaded: LoadedRealmWorldDirectory;
  installRoot: string;
  verifySignature: RealmWorldSignatureVerifier;
}): Promise<InstalledRealmWorld> {
  const installRoot = resolve(input.installRoot);
  await mkdir(installRoot, { recursive: true });
  await assertDirectory(installRoot);
  const worldRoot = join(installRoot, input.loaded.manifest.worldId);
  await mkdir(worldRoot, { recursive: true });
  await assertDirectory(worldRoot);
  const installDir = join(worldRoot, input.loaded.manifest.worldVersion);
  const existing = await existingInstalledPackage(installDir, input.verifySignature);
  if (existing) {
    if (existing.manifest.contentHash !== input.loaded.manifest.contentHash) {
      throw new RealmWorldLoaderError("INSTALL_CONFLICT", "different content already installed at World identity");
    }
    return { ...existing, installDir, reused: true };
  }

  const temporaryDir = await mkdtemp(join(worldRoot, ".realmworld-install-"));
  try {
    await writeFile(
      join(temporaryDir, "realmworld-manifest.json"),
      serializeRealmWorldManifest(input.loaded.manifest),
    );
    for (const [relativePath, bytes] of input.loaded.files) {
      const destination = join(temporaryDir, ...relativePath.split("/"));
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes);
    }
    const verified = await loadRealmWorldDirectory(temporaryDir, {
      verifySignature: input.verifySignature,
    });
    try {
      await rename(temporaryDir, installDir);
    } catch (error) {
      if (errorCode(error) !== "EEXIST" && errorCode(error) !== "ENOTEMPTY") throw error;
      const raced = await existingInstalledPackage(installDir, input.verifySignature);
      if (!raced || raced.manifest.contentHash !== verified.manifest.contentHash) {
        throw new RealmWorldLoaderError("INSTALL_CONFLICT", "World identity was installed concurrently");
      }
      return { ...raced, installDir, reused: true };
    }
    return { ...verified, rootDir: installDir, installDir, reused: false };
  } finally {
    await rm(temporaryDir, { recursive: true, force: true });
  }
}

export async function installRealmWorldDirectory(input: {
  sourceDir: string;
  installRoot: string;
  verifySignature?: RealmWorldSignatureVerifier;
}): Promise<InstalledRealmWorld> {
  if (!input.verifySignature) {
    throw new RealmWorldLoaderError("SIGNATURE_VERIFIER_REQUIRED", "RealmWorld signature verifier is required");
  }
  const loaded = await loadRealmWorldDirectory(input.sourceDir, {
    verifySignature: input.verifySignature,
  });
  return installLoadedRealmWorld({
    loaded,
    installRoot: input.installRoot,
    verifySignature: input.verifySignature,
  });
}

export async function installRealmWorldArchive(input: {
  archiveBytes: Uint8Array;
  installRoot: string;
  verifySignature?: RealmWorldSignatureVerifier;
}): Promise<InstalledRealmWorld> {
  if (!input.verifySignature) {
    throw new RealmWorldLoaderError("SIGNATURE_VERIFIER_REQUIRED", "RealmWorld signature verifier is required");
  }
  const loaded = await loadRealmWorldArchive(input.archiveBytes, {
    verifySignature: input.verifySignature,
  });
  return installLoadedRealmWorld({
    loaded,
    installRoot: input.installRoot,
    verifySignature: input.verifySignature,
  });
}

export async function mountRealmWorld(input: {
  installRoot: string;
  worldId: string;
  worldVersion: string;
  verifySignature?: RealmWorldSignatureVerifier;
}): Promise<LoadedRealmWorldDirectory> {
  if (!input.verifySignature) {
    throw new RealmWorldLoaderError("SIGNATURE_VERIFIER_REQUIRED", "RealmWorld signature verifier is required");
  }
  assertSafeInstallComponent(input.worldId, "worldId");
  assertSafeInstallComponent(input.worldVersion, "worldVersion");
  const installDir = join(resolve(input.installRoot), input.worldId, input.worldVersion);
  try {
    const stats = await lstat(installDir);
    if (stats.isSymbolicLink()) {
      throw new RealmWorldLoaderError("SYMLINK_NOT_ALLOWED", "mounted RealmWorld may not be a symlink");
    }
  } catch (error) {
    if (error instanceof RealmWorldLoaderError) throw error;
    if (errorCode(error) === "ENOENT") {
      throw new RealmWorldLoaderError("WORLD_NOT_INSTALLED", "requested RealmWorld is not installed");
    }
    throw new RealmWorldLoaderError("INVALID_PACKAGE", "installed RealmWorld cannot be inspected");
  }
  return loadRealmWorldDirectory(installDir, { verifySignature: input.verifySignature });
}
