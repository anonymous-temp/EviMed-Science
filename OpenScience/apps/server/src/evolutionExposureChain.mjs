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
/**
 * A run whose model named the reference paper from its own memory, with nothing served to it and no source event that
 * matched it (`evaluationIsolation.auditTranscript`). Ruling of 2026-10-05: that is not an exposure the platform served,
 * and no isolation can remove it. It is recorded, reported with the result and counted; it does not raise a branch's
 * tier, does not make a candidate wait, and does not by itself invalidate the hidden cases. Served or matched material
 * (`exposed_uncited`) and a citing deliverable (`cited`) disqualify exactly as before. The control for what a model
 * remembers is the temporal holdout — papers published after its cutoff (evolutionTimeHoldout.mjs) — not this audit.
 */
export const RECALLED_TIER = 'recalled';

/** @param {string[]} tiers */
export function worstExposureTier(tiers) {
  // No audited run is no evidence of absence.
  if (!tiers.length) return 'unknown';
  const known = tier => tier === RECALLED_TIER ? 'unexposed' : EXPOSURE_TIERS.includes(tier) ? tier : 'unknown';
  return tiers.reduce((worst, tier) => EXPOSURE_TIERS.indexOf(known(tier)) > EXPOSURE_TIERS.indexOf(worst) ? known(tier) : worst, 'unexposed');
}

/**
 * A development run's transcript in two voices. `own` is what is positively the model's own: the reasoning and reply
 * text of its assistant messages, each with the step it was said at. `served` is the transcript without those texts —
 * the brief, injected context, tool calls and their results, and any part of a shape this function does not know, so
 * that an unrecognised part is audited as served, never as the model's own.
 * @param {any} transcript @returns {{ served: any, own: { step: { message: number, part: number, voice: 'reasoning' | 'reply' }, text: string }[] }}
 */
export function transcriptVoices(transcript) {
  /** @type {{ step: { message: number, part: number, voice: 'reasoning' | 'reply' }, text: string }[]} */
  const own = [];
  if (!transcript || typeof transcript !== 'object' || !Array.isArray(transcript.messages)) return { served: transcript ?? null, own };
  const messages = transcript.messages.map((/** @type {any} */ message, /** @type {number} */ index) => {
    if (message?.role !== 'assistant' || !Array.isArray(message.parts)) return message;
    return { ...message, parts: message.parts.map((/** @type {any} */ part, /** @type {number} */ position) => {
      if (!['reasoning', 'text'].includes(part?.type) || typeof part.text !== 'string') return part;
      own.push({ step: { message: index, part: position, voice: part.type === 'reasoning' ? 'reasoning' : 'reply' }, text: part.text });
      const { text: _own, ...rest } = part;
      return rest;
    }) };
  });
  return { served: { ...transcript, messages }, own };
}

/**
 * One development run's transcript against the candidate's policy: the tier of the run, and where the reference was
 * named when the run is `recalled`.
 * @param {{ isolation: any, identity: { userId: string, projectId: string, runId: string }, policy: any, transcript: any }} request
 * @returns {Promise<{ tier: string, recalledAt?: any }>}
 */
export async function auditDevelopmentTranscript({ isolation, identity, policy, transcript }) {
  await isolation.register(identity.runId, policy);
  await isolation.auditTranscript(identity, 'builder-transcript', transcriptVoices(transcript));
  const audit = await isolation.audit(identity.runId);
  return audit.tier === RECALLED_TIER ? { tier: audit.tier, recalledAt: audit.events.find((/** @type {any} */ event) => event.tier === RECALLED_TIER)?.step ?? null } : { tier: audit.tier };
}

/**
 * What a result says about a recalled reference: one notice per run, with the step. Travels with the evaluation
 * (its receipt's notices) and with the published tool's record; it is a label, never a verdict.
 * @param {{ runId: string, step: any }[] | undefined} recalled
 */
export function referenceRecallNotices(recalled) {
  return (recalled ?? []).map(({ runId, step }) => ({ code: 'reference_named_from_memory', runId, step: step ?? null,
    message: `The builder named the reference paper from memory, at ${Number.isInteger(step?.message) ? `message ${step.message} (${step.voice})` : 'an unrecorded step'}.` }));
}

/** The label a published tool's record carries when a run of its chain was `recalled`; nothing otherwise. @param {any} verdict */
export function referenceRecallLabel(verdict) {
  const notices = referenceRecallNotices(verdict?.referenceRecall);
  return notices.length ? { referenceRecall: notices } : {};
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
 * @param {{auditRun:(run:{runId:string,projectId:string|null}, options:{policy:any,signal?:AbortSignal})=>Promise<{tier:string,transcriptHash?:string,recalledAt?:any}>}} dependencies
 * @returns {(candidate:any, options:{policy:any,signal?:AbortSignal})=>Promise<{tier:string,runs:{runId:string,tier:string}[],recalled:{runId:string,step:any}[]}>}
 */
export function createCandidateExposureAudit({ auditRun }) {
  return async (candidate, { policy, signal }) => {
    const lineage = candidate.lineage ?? {};
    const runIds = [...new Set((lineage.developmentRuns ?? []).filter(id => typeof id === 'string' && id))];
    const runs = [];
    for (const runId of runIds) {
      const audited = await auditRun({ runId, projectId: lineage.developmentRunProjects?.[runId] ?? lineage.developmentProjectId ?? null }, { policy, signal });
      runs.push({ runId, tier: audited.tier, ...(audited.transcriptHash ? { transcriptHash: audited.transcriptHash } : {}), ...(audited.tier === RECALLED_TIER ? { recalledAt: audited.recalledAt ?? null } : {}) });
    }
    return { tier: worstExposureTier(runs.map(run => run.tier)), runs, recalled: runs.filter(run => run.tier === RECALLED_TIER).map(run => ({ runId: run.runId, step: run.recalledAt ?? null })) };
  };
}
