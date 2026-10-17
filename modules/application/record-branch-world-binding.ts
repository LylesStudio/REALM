/** Branches verify the pinned installed package, including live trust-store revocation. */
import {mountRealmWorld,RealmWorldLoaderError} from '../world-transfer/realmworld-loader.ts';
import {createRealmWorldSignatureVerifierFromTrustStoreFile,readRealmWorldTrustStoreFile,resolveEngineBaseActiveVersion} from '../world-transfer/realmworld-trust-store.ts';
import {RealmRuntimeSaveRepositoryError,type RealmRuntimeSaveWorldBindingValidator} from '../../database/postgres/realm-runtime-save-repository.ts';

export const validateRecordBranchWorldBinding:RealmRuntimeSaveWorldBindingValidator=async(binding)=>{
  const installRoot=process.env.REALM_REALMWORLD_INSTALL_ROOT??process.env.REALM_GOAL_WORKER_INSTALL_ROOT;
  const path=process.env.REALM_REALMWORLD_TRUST_STORE;
  if(!installRoot||!path)throw new RealmRuntimeSaveRepositoryError('REALMWORLD_VALIDATION_UNAVAILABLE','The pinned branch package cannot be verified.');
  try {
    const trust=await readRealmWorldTrustStoreFile(path);
    const mounted=await mountRealmWorld({installRoot,worldId:binding.worldId,worldVersion:binding.worldVersion,
      verifySignature:createRealmWorldSignatureVerifierFromTrustStoreFile({path}),engineBaseVersion:resolveEngineBaseActiveVersion(trust)});
    if(mounted.manifest.worldId!==binding.worldId||mounted.manifest.worldVersion!==binding.worldVersion)
      throw new RealmRuntimeSaveRepositoryError('REALMWORLD_IDENTITY_MISMATCH','The pinned branch package identity is invalid.');
  } catch(error) {
    if(error instanceof RealmRuntimeSaveRepositoryError)throw error;
    if(error instanceof RealmWorldLoaderError&&error.code==='BASE_VERSION_INCOMPATIBLE')
      throw new RealmRuntimeSaveRepositoryError('BASE_VERSION_INCOMPATIBLE','The pinned branch package is incompatible with the engine base.');
    if(error instanceof RealmWorldLoaderError&&error.code==='WORLD_NOT_INSTALLED')
      throw new RealmRuntimeSaveRepositoryError('REALMWORLD_PACKAGE_MISSING','The pinned branch package is not installed.');
    throw new RealmRuntimeSaveRepositoryError('REALMWORLD_PACKAGE_UNTRUSTED','The pinned branch package cannot be verified.');
  }
};
