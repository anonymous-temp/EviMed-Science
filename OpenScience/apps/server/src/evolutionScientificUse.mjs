import {isResearcherOwnedWork} from '@evimed/domain';
import {isInternalProject} from './internalProjects.mjs';
/** Authoritative run metadata describes evaluation; autopilot ownership alone never excludes research.
 * @param {string} projectId @param {any} run */
export function evolutionScientificUse(projectId,run) {
 const evaluation=isInternalProject(projectId) || Boolean(run) && !isResearcherOwnedWork(run);
 return {evaluation,researcherOwned:Boolean(run) && !evaluation};
}
