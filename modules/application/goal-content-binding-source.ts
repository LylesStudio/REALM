import { readFile } from "node:fs/promises";
import type { GoalDefinition } from "../goals/public.ts";
import { baseGoalDefinitionsHash, canonicalGoalJson, decodeGoalContentBinding, goalDefinitionHash,
  normalizeGoalDefinition, type GoalContentBindingV1, type GoalOwner, type GoalSource } from "../goals/content-binding.ts";
import { resolveBaseGoalRevision } from "../world-transfer/base-content.ts";
import { createRealmWorldContentStore } from "../world-transfer/realmworld-content.ts";
import { mountRealmWorld, RealmWorldLoaderError } from "../world-transfer/realmworld-loader.ts";
import type { RealmWorldMount } from "../world-transfer/realmworld-definition-resolver.ts";
import { createRealmWorldSignatureVerifierFromTrustStoreDocument, validateRealmWorldTrustStoreDocument } from "../world-transfer/realmworld-signature.ts";
import { resolveEngineBaseActiveVersion } from "../world-transfer/realmworld-trust-store.ts";
import { RuntimeInvariantError } from "../runtime/public.ts";

/** Server-owned witnesses are not serializable authority. The DB still verifies
 * actor/owner/transaction; package authenticity belongs to the existing mount. */
export interface GoalContentWitness {
  readonly definition: GoalDefinition;
  readonly definitionHash: string;
  readonly source: GoalSource;
}
export interface GoalSourceRequest {
  worldId: string; worldVersion: string; goalKey: string;
  expectedSource?: GoalSource;
  expectedDefinitionHash?: string;
  policyVersion?: string;
}
export type GoalContentSourceResolver = (request: GoalSourceRequest) => Promise<GoalContentWitness>;
const witnesses = new WeakSet<object>();
function fail(): never { throw new RuntimeInvariantError("GOAL_CONTENT_UNAVAILABLE", "The exact trusted Goal source is unavailable."); }
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

/** The injected mount is a trusted server dependency, never a browser plan.
 * No cache can authorize a read: every installed request mounts again. */
export function createGoalContentBindingSource(input: { mount?: RealmWorldMount } = {}): GoalContentSourceResolver {
  return async request => {
    let source: GoalSource;
    let definition: GoalDefinition | null;
    if (request.worldVersion === "0.0.0-local") {
      if (request.expectedSource && request.expectedSource.sourceKind !== "base") fail();
      const revision = resolveBaseGoalRevision(request.expectedSource?.baseRevision ?? undefined);
      if (!revision || baseGoalDefinitionsHash(revision.definitions) !== revision.contentHash) fail();
      source = { sourceKind: "base", sourceWorldId: "", sourceWorldVersion: "0.0.0-local", packageContentHash: null,
        baseRevision: revision.revision, baseContentHash: revision.contentHash };
      definition = revision.definitions.find(d => d.goalKey === request.goalKey) ?? null;
    } else {
      if (!input.mount) fail();
      const mounted = await input.mount({ worldId: request.worldId, worldVersion: request.worldVersion });
      if (mounted.manifest.worldId !== request.worldId || mounted.manifest.worldVersion !== request.worldVersion
        || !/^[0-9a-f]{64}$/.test(mounted.manifest.contentHash)) fail();
      source = { sourceKind: "installed", sourceWorldId: mounted.manifest.worldId,
        sourceWorldVersion: mounted.manifest.worldVersion, packageContentHash: mounted.manifest.contentHash,
        baseRevision: null, baseContentHash: null };
      definition = createRealmWorldContentStore(mounted).resolveGoalDefinition(request.goalKey);
    }
    if (!definition || (request.expectedSource && canonicalGoalJson(request.expectedSource) !== canonicalGoalJson(source))) fail();
    const detached = normalizeGoalDefinition(definition);
    const definitionHash = goalDefinitionHash(detached);
    if ((request.expectedDefinitionHash !== undefined && request.expectedDefinitionHash !== definitionHash)
      || (request.policyVersion !== undefined && request.policyVersion !== detached.policyVersion)) fail();
    const witness = freeze({ definition: detached, definitionHash, source });
    witnesses.add(witness);
    return witness;
  };
}

/** Default server factory: read current trust (including time/revocation/base
 * activation) for EVERY mount, including replay. Construction performs no IO. */
export function createDefaultGoalContentBindingSource(): GoalContentSourceResolver {
  return createGoalContentBindingSource({ mount: async identity => {
    const installRoot = process.env.REALM_REALMWORLD_INSTALL_ROOT ?? process.env.REALM_GOAL_WORKER_INSTALL_ROOT;
    const trustStorePath = process.env.REALM_REALMWORLD_TRUST_STORE;
    if (!installRoot || !trustStorePath) fail();
    const document = validateRealmWorldTrustStoreDocument(JSON.parse(await readFile(trustStorePath, "utf8")));
    try {
      return await mountRealmWorld({ installRoot, ...identity,
        verifySignature: createRealmWorldSignatureVerifierFromTrustStoreDocument({ document, now: new Date() }),
        engineBaseVersion: resolveEngineBaseActiveVersion(document) });
    } catch (error) {
      // A missing/rejected exact package is unavailable Goal content, not an
      // unexpected projection crash. Keep refusal and the public 503 contract.
      if (error instanceof RealmWorldLoaderError) fail();
      throw error;
    }
  } });
}

export function bindGoalContentWitness(witness: GoalContentWitness, workspaceId: string, owner: GoalOwner, instanceId: string): GoalContentBindingV1 {
  if (!witnesses.has(witness)) fail();
  return decodeGoalContentBinding({ bindingVersion: 1, workspaceId, owner, instanceId,
    goalKey: witness.definition.goalKey, policyVersion: witness.definition.policyVersion,
    definitionHash: witness.definitionHash, normalization: "goal-definition-c14n-v1", source: witness.source }, witness.definition);
}

export async function verifyGoalContentBinding(binding: GoalContentBindingV1,
  resolve: GoalContentSourceResolver = createDefaultGoalContentBindingSource()): Promise<GoalContentWitness> {
  const exact = decodeGoalContentBinding(binding);
  return resolve({ worldId: exact.owner.worldId, worldVersion: exact.source.sourceWorldVersion, goalKey: exact.goalKey,
    expectedSource: exact.source, expectedDefinitionHash: exact.definitionHash, policyVersion: exact.policyVersion });
}
