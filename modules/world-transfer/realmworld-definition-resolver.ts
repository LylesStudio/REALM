import type { GoalDefinition } from "../goals/public.ts";
import type { LoadedRealmWorldDirectory, RealmWorldSignatureVerifier } from "./realmworld-loader.ts";
import { mountRealmWorld } from "./realmworld-loader.ts";
import { createRealmWorldContentStore, type RealmWorldContentStore } from "./realmworld-content.ts";
import { LOCAL_WORLD_VERSION } from "./realm-save.ts";

export interface RealmWorldDefinitionResolutionJob {
  worldId: string;
  worldVersion: string;
  goalKey: string;
}

export class RealmWorldDefinitionResolutionError extends Error {
  readonly code: "REALMWORLD_IDENTITY_MISMATCH";

  constructor(message: string) {
    super(message);
    this.name = "RealmWorldDefinitionResolutionError";
    this.code = "REALMWORLD_IDENTITY_MISMATCH";
  }
}

export type RealmWorldMountedContent = Pick<LoadedRealmWorldDirectory, "manifest" | "files">;
export type RealmWorldMount = (input: {
  worldId: string;
  worldVersion: string;
}) => Promise<RealmWorldMountedContent>;

function identityKey(worldId: string, worldVersion: string): string {
  return `${worldId}\u0000${worldVersion}`;
}

/**
 * Resolve Goal definitions from the exact WorldBinding carried by an
 * assessment job. The mounted package is cached by identity only; a package
 * with a different manifest identity can never satisfy the job.
 */
export function createRealmWorldDefinitionResolver(input: {
  mount: RealmWorldMount;
  baseResolver?: (job: RealmWorldDefinitionResolutionJob) => GoalDefinition | null | Promise<GoalDefinition | null>;
}): (job: RealmWorldDefinitionResolutionJob) => Promise<GoalDefinition | null> {
  const stores = new Map<string, RealmWorldContentStore>();
  return async (job) => {
    if (job.worldVersion === LOCAL_WORLD_VERSION) {
      return input.baseResolver ? await input.baseResolver(job) : null;
    }
    const key = identityKey(job.worldId, job.worldVersion);
    let store = stores.get(key);
    if (!store) {
      const mounted = await input.mount({
        worldId: job.worldId,
        worldVersion: job.worldVersion,
      });
      if (
        mounted.manifest.worldId !== job.worldId
        || mounted.manifest.worldVersion !== job.worldVersion
      ) {
        throw new RealmWorldDefinitionResolutionError(
          "Mounted RealmWorld identity does not match the assessment job.",
        );
      }
      store = createRealmWorldContentStore(mounted);
      stores.set(key, store);
    }
    return store.resolveGoalDefinition(job.goalKey);
  };
}

/** Filesystem-backed production resolver used by the durable assessment host. */
export function createInstalledRealmWorldDefinitionResolver(input: {
  installRoot: string;
  verifySignature: RealmWorldSignatureVerifier;
  baseResolver?: (job: RealmWorldDefinitionResolutionJob) => GoalDefinition | null | Promise<GoalDefinition | null>;
}): (job: RealmWorldDefinitionResolutionJob) => Promise<GoalDefinition | null> {
  return createRealmWorldDefinitionResolver({
    baseResolver: input.baseResolver,
    mount: (identity) => mountRealmWorld({
      installRoot: input.installRoot,
      worldId: identity.worldId,
      worldVersion: identity.worldVersion,
      verifySignature: input.verifySignature,
    }),
  });
}
