/**
 * RealmWorld WebUI Bridge compatibility boundary.
 *
 * This module is a pure resolver: it consumes an already installed,
 * hash-verified, and signature-verified LoadedRealmWorld snapshot and maps a
 * request path to WebUI asset bytes. It never touches the filesystem, never
 * installs or writes packages, and never executes bundle code.
 *
 * Fail-closed rules:
 * - exactly one bridge major (1) is supported; any other manifest major is
 *   rejected before any asset is served;
 * - an empty request path always resolves to manifest.webui.entry;
 * - requested assets must be ui/-relative safe paths (no traversal, no
 *   backslashes, no empty/dot segments) and must exist in the verified
 *   byte snapshot;
 * - errors carry only stable machine codes and safe static messages, never
 *   install roots, filesystem paths, signature material, or manifest details.
 */
import type { LoadedRealmWorldDirectory } from "./realmworld-loader.ts";

/** The single WebUI Bridge major version this engine implements. */
export const REALMWORLD_WEBUI_BRIDGE_MAJOR = 1 as const;

export type RealmWorldWebUiBridgeErrorCode =
  | "NO_WEBUI"
  | "UNSUPPORTED_BRIDGE_MAJOR"
  | "INVALID_PATH"
  | "NOT_FOUND";

export class RealmWorldWebUiBridgeError extends Error {
  readonly code: RealmWorldWebUiBridgeErrorCode;

  constructor(code: RealmWorldWebUiBridgeErrorCode, message: string) {
    super(message);
    this.name = "RealmWorldWebUiBridgeError";
    this.code = code;
  }
}

export interface RealmWorldWebUiAssetResolution {
  /** Package-relative path inside the verified snapshot, always ui/-rooted. */
  path: string;
  bytes: Uint8Array;
  bridgeMajor: typeof REALMWORLD_WEBUI_BRIDGE_MAJOR;
}

const MAX_WEBUI_PATH_LENGTH = 512;
const MAX_WEBUI_SEGMENTS = 16;
const MAX_SEGMENT_LENGTH = 256;
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

function normalizeSegment(segment: unknown): string {
  if (typeof segment !== "string") {
    throw new RealmWorldWebUiBridgeError("INVALID_PATH", "WebUI asset path is invalid");
  }
  // Defense in depth: route params are normally decoded already, but encoded
  // separators or dots must never survive normalization.
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    throw new RealmWorldWebUiBridgeError("INVALID_PATH", "WebUI asset path is invalid");
  }
  if (
    decoded.length === 0
    || decoded.length > MAX_SEGMENT_LENGTH
    || decoded === "."
    || decoded === ".."
    || decoded.includes("/")
    || decoded.includes("\\")
    || !SAFE_SEGMENT.test(decoded)
  ) {
    throw new RealmWorldWebUiBridgeError("INVALID_PATH", "WebUI asset path is invalid");
  }
  return decoded;
}

/**
 * Resolve a request path against a verified RealmWorld snapshot. An empty
 * segment list selects manifest.webui.entry; otherwise the segments must form
 * a ui/-relative safe path present in the snapshot.
 */
export function resolveRealmWorldWebUiAsset(
  loaded: Pick<LoadedRealmWorldDirectory, "manifest" | "files">,
  requestSegments: readonly string[] = [],
): RealmWorldWebUiAssetResolution {
  const webui = loaded.manifest.webui;
  if (!webui) {
    throw new RealmWorldWebUiBridgeError(
      "NO_WEBUI",
      "RealmWorld does not declare a WebUI bundle",
    );
  }
  if (webui.bridgeMajor !== REALMWORLD_WEBUI_BRIDGE_MAJOR) {
    throw new RealmWorldWebUiBridgeError(
      "UNSUPPORTED_BRIDGE_MAJOR",
      "RealmWorld WebUI bridge major is not supported",
    );
  }

  let relativePath: string;
  if (requestSegments.length === 0) {
    // The manifest entry is already validated as a ui/-rooted safe path by
    // the manifest parser and loader before any package can be mounted.
    relativePath = webui.entry;
  } else {
    if (requestSegments.length > MAX_WEBUI_SEGMENTS) {
      throw new RealmWorldWebUiBridgeError("INVALID_PATH", "WebUI asset path is invalid");
    }
    const segments = requestSegments.map(normalizeSegment);
    relativePath = `ui/${segments.join("/")}`;
    if (relativePath.length > MAX_WEBUI_PATH_LENGTH) {
      throw new RealmWorldWebUiBridgeError("INVALID_PATH", "WebUI asset path is invalid");
    }
  }

  const bytes = loaded.files.get(relativePath);
  if (bytes === undefined) {
    throw new RealmWorldWebUiBridgeError(
      "NOT_FOUND",
      "WebUI asset is not present in the verified RealmWorld snapshot",
    );
  }
  return {
    path: relativePath,
    bytes,
    bridgeMajor: REALMWORLD_WEBUI_BRIDGE_MAJOR,
  };
}
