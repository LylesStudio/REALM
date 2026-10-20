import { createDefaultGoalContentBindingSource } from "./goal-content-binding-source.ts";
import type { RealmWorldDefinitionResolutionJob } from "../world-transfer/realmworld-definition-resolver.ts";

/** Same exact signed content source for GET/SSE and native turn context. */
export async function createProjectionDefinitionResolver() {
  const resolve = createDefaultGoalContentBindingSource();
  return async (request: RealmWorldDefinitionResolutionJob) => (await resolve(request)).definition;
}
