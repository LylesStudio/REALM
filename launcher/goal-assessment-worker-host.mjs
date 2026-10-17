/** Goal process supervision reuses the cross-platform worker lifecycle. */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSceneImageWorkerHost, GOAL_WORKER_ENV_KEYS } from './scene-image-worker-host.mjs';
export { GOAL_WORKER_ENV_KEYS };
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export function createGoalAssessmentWorkerHost(options={}) {
  const dataHome=options.dataHome ?? options.environment?.REALM_DATA_HOME ?? process.env.REALM_DATA_HOME ?? resolve(root,'.local');
  return createSceneImageWorkerHost({...options,dataHome,workerKind:'goal-assessment',
    workerScript:options.workerScript ?? resolve(root,'scripts','goal-assessment-worker.mjs'),
    logFile:options.logFile ?? resolve(dataHome,'logs','goal-assessment-worker.log')});
}
