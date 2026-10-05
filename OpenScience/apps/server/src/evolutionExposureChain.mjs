/**
 * Which development runs a candidate's code has passed through, and what they were exposed to.
 *
 * Code is carried forward across repair attempts: attempt n+1 is handed attempt n's files. Exposure used
 * to be audited on the last development run only, so a transcript that named the target publication in
 * attempt 3 did not touch the tier of attempt 4, and V2 requires `unexposed`. A candidate's tier is now
 * the worst tier of every run in its chain.
 */

/** Worst last. Observed exposure outranks an unknown trace; only a chain that is `unexposed` throughout is unexposed. */
export const EXPOSURE_TIERS = Object.freeze(['unexposed', 'unknown', 'exposed_uncited', 'cited']);

/** @param {string[]} tiers */
export function worstExposureTier(tiers) {
  // No audited run is no evidence of absence.
  if (!tiers.length) return 'unknown';
  return tiers.reduce((worst, tier) => EXPOSURE_TIERS.indexOf(EXPOSURE_TIERS.includes(tier) ? tier : 'unknown') > EXPOSURE_TIERS.indexOf(worst) ? (EXPOSURE_TIERS.includes(tier) ? tier : 'unknown') : worst, 'unexposed');
}

/**
 * The runs of every earlier attempt on the same branch, whatever their status: a run that ended badly may
 * still have been read by the next one.
 * @param {{attempt:number, identity:(attempt:number)=>{projectId:string,dispatchId:string}, find:(identity:{projectId:string,dispatchId:string})=>Promise<{id:string}|null|undefined>}} request
 * @returns {Promise<{runId:string,projectId:string,attempt:number}[]>}
 */
export async function priorDevelopmentRuns({ attempt, identity, find }) {
  const runs = [];
  for (let earlier = 0; earlier < attempt; earlier++) {
    const expected = identity(earlier), run = await find(expected);
    if (run?.id) runs.push({ runId: run.id, projectId: expected.projectId, attempt: earlier });
  }
  return runs;
}

/**
 * @param {{auditRun:(run:{runId:string,projectId:string|null}, options:{policy:any,signal?:AbortSignal})=>Promise<{tier:string,transcriptHash?:string}>}} dependencies
 * @returns {(candidate:any, options:{policy:any,signal?:AbortSignal})=>Promise<{tier:string,runs:{runId:string,tier:string}[]}>}
 */
export function createCandidateExposureAudit({ auditRun }) {
  return async (candidate, { policy, signal }) => {
    const lineage = candidate.lineage ?? {};
    const runIds = [...new Set((lineage.developmentRuns ?? []).filter(id => typeof id === 'string' && id))];
    const runs = [];
    for (const runId of runIds) {
      const audited = await auditRun({ runId, projectId: lineage.developmentRunProjects?.[runId] ?? lineage.developmentProjectId ?? null }, { policy, signal });
      runs.push({ runId, tier: audited.tier, ...(audited.transcriptHash ? { transcriptHash: audited.transcriptHash } : {}) });
    }
    return { tier: worstExposureTier(runs.map(run => run.tier)), runs };
  };
}
