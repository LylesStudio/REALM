import { readFile } from "node:fs/promises";
import { createInstalledRealmWorldDefinitionResolver } from "../world-transfer/realmworld-definition-resolver.ts";
import { resolveBaseGoalDefinition } from "../world-transfer/base-content.ts";
import {
  createRealmWorldSignatureVerifierFromTrustStoreDocument, validateRealmWorldTrustStoreDocument,
  type RealmWorldTrustStoreDocumentV1,
} from "../world-transfer/realmworld-signature.ts";
import { resolveEngineBaseActiveVersion } from "../world-transfer/realmworld-trust-store.ts";

/** Same exact signed content source for GET/SSE and native turn context. */
export async function createProjectionDefinitionResolver() {
  const installRoot = process.env.REALM_GOAL_WORKER_INSTALL_ROOT;
  const trustStorePath = process.env.REALM_REALMWORLD_TRUST_STORE;
  if (!installRoot || !trustStorePath) return null;
  let document: unknown;
  try { document = JSON.parse(await readFile(trustStorePath, "utf8")); } catch { return null; }
  let verifySignature;
  let engineBaseVersion;
  try {
    const validDocument = validateRealmWorldTrustStoreDocument(document as RealmWorldTrustStoreDocumentV1);
    verifySignature = createRealmWorldSignatureVerifierFromTrustStoreDocument({ document: validDocument, now: new Date() });
    engineBaseVersion = resolveEngineBaseActiveVersion(validDocument);
  } catch { return null; }
  return createInstalledRealmWorldDefinitionResolver({ installRoot, verifySignature,
    baseResolver: resolveBaseGoalDefinition, engineBaseVersion });
}
