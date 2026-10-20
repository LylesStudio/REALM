import type { GoalDefinition } from "../goals/public.ts";
import type { LoadedRealmWorldDirectory, RealmWorldSignatureVerifier } from "./realmworld-loader.ts";
import { mountRealmWorld } from "./realmworld-loader.ts";
import { createRealmWorldContentStore } from "./realmworld-content.ts";
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

/**
 * Resolve Goal definitions from the exact WorldBinding carried by an
 * assessment job. Each request remounts so revoked trust or replaced bytes
 * cannot be authorized by an identity-only cache.
 */
export function createRealmWorldDefinitionResolver(input: {
  mount: RealmWorldMount;
  baseResolver?: (job: RealmWorldDefinitionResolutionJob) => GoalDefinition | null | Promise<GoalDefinition | null>;
}): (job: RealmWorldDefinitionResolutionJob) => Promise<GoalDefinition | null> {
  return async (job) => {
    if (job.worldVersion === LOCAL_WORLD_VERSION) {
      return input.baseResolver ? await input.baseResolver(job) : null;
    }
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
    const store = createRealmWorldContentStore(mounted);
    return store.resolveGoalDefinition(job.goalKey);
  };
}

/** Filesystem-backed production resolver used by the durable assessment host. */
export function createInstalledRealmWorldDefinitionResolver(input: {
  installRoot: string;
  verifySignature: RealmWorldSignatureVerifier;
  engineBaseVersion?: string;
  baseResolver?: (job: RealmWorldDefinitionResolutionJob) => GoalDefinition | null | Promise<GoalDefinition | null>;
}): (job: RealmWorldDefinitionResolutionJob) => Promise<GoalDefinition | null> {
  return createRealmWorldDefinitionResolver({
    baseResolver: input.baseResolver,
    mount: (identity) => mountRealmWorld({
      installRoot: input.installRoot,
      worldId: identity.worldId,
      worldVersion: identity.worldVersion,
      verifySignature: input.verifySignature,
      engineBaseVersion: input.engineBaseVersion,
    }),
  });
}
