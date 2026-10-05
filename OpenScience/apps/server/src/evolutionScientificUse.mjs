import {isInternalProject} from './internalProjects.mjs';
/** Authoritative run metadata describes evaluation; autopilot ownership alone never excludes research.
 * @param {string} projectId @param {any} run */
export function evolutionScientificUse(projectId,run) {
 const evaluation=isInternalProject(projectId) || run?.automated===true;
 return {evaluation,researcherOwned:Boolean(run) && !evaluation};
}
