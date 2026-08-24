/**
 * The research agenda: what proactive work is planned against, and what it may
 * claim when it is done.
 *
 * Hidden knowledge: why an unattended run needs a different vocabulary from an
 * interactive one, and it is not the mechanism — the mechanism is identical, a
 * system-initiated run on the same composition with the same gate. It is the
 * *claims*.
 *
 * A person reading a finding at 08:00 cannot re-derive it, so the difference
 * between "the data analysis reproduced" and "the model synthesized an
 * explanation" has to be carried in the artifact rather than left to the
 * reader. The published evaluations of comparable systems are the reason: their
 * data-analysis statements reproduced at 85%, their literature statements were
 * grounded at 82%, and their synthesized interpretive statements were accurate
 * at 58% — with a documented tendency to over-claim and to invent metrics. One
 * number per statement type, and only one of them is bad.
 *
 * So a claim carries a tier that only a verification episode may raise, an
 * interpretive claim must state what would overturn it, and the effect
 * measures a data analysis may report are drawn from a fixed list rather than
 * invented.
 *
 * @module @evimed/domain/agenda
 */

/** What an agenda holds. */
export const AGENDA_ITEM_TYPES = Object.freeze([
  'question',
  'hypothesis',
  'claim',
  'watchlist',
  'dataset',
  'analysis_plan',
  'task',
  'decision',
])

// How far a claim has been checked (`unverified` / `gated` / `reproduced`) is a
// state vocabulary, and every state vocabulary lives in `states.mjs`. Naming it
// again here would give one concept two definitions that can drift — and, since
// both are star-exported from the package root, the collision would silently
// resolve to `undefined` rather than to either of them.

/** What an independent refuter concluded. */
export const REFUTATION_VERDICTS = Object.freeze(['refuted', 'weakened', 'stands'])

// The six autonomous task types are declared by the capability manifest schema,
// which is what validates them; see `capabilityManifest.mjs`.

/** Which task types run unless the user turns them off. */
export const DEFAULT_ENABLED_TASK_TYPES = Object.freeze([
  'literature-sentinel',
  'evidence-update',
  'data-prospecting',
  'hypothesis-suggestion',
  'signal-monitoring',
])

/** An episode's lifecycle. */
export const EPISODE_STATES = Object.freeze(['queued', 'running', 'verifying', 'merged', 'failed', 'canceled'])

/** How a dataset is classified; it decides defaults, not permissions. */
export const DATASET_CLASSIFICATIONS = Object.freeze(['public', 'patient-level'])

/** The two partitions a registered dataset is split into. */
export const DATASET_PARTITIONS = Object.freeze(['exploratory', 'confirmatory'])

/**
 * The effect measures a data-analysis claim may report.
 *
 * Fixed on purpose. The documented failure of comparable systems is inventing a
 * plausible-sounding composite metric and reporting it as a finding; a closed
 * list makes that a contract violation rather than a judgement call.
 */
export const ALLOWED_EFFECT_MEASURES = Object.freeze([
  'risk-ratio',
  'odds-ratio',
  'hazard-ratio',
  'rate-ratio',
  'risk-difference',
  'mean-difference',
  'standardized-mean-difference',
  'correlation',
  'beta',
  'auc',
  'sensitivity',
  'specificity',
  'proportion',
  'incidence-rate',
  'number-needed-to-treat',
])

/** How a user's response to a finding scores the direction it came from. */
export const USER_SIGNALS = Object.freeze({ followUp: 1, adopt: 0.6, upvote: 0.3, reject: -1 })

/**
 * Whether a claim may lead the morning digest.
 *
 * Only a reproduced result or a direct claim that survived refutation. An
 * interpretation, however well argued, goes lower down and in the language of
 * interpretation — this is the direct countermeasure to the 58% figure.
 *
 * @param {{ tier: string, type: string, refutation?: string, what_would_change?: string }} claim
 * @returns {{ headline: boolean, reason: string }}
 */
export function digestPlacement(claim) {
  if (claim.tier === 'reproduced') {
    return { headline: true, reason: '重跑复现一致' }
  }
  if (claim.type === 'direct' && claim.tier === 'gated' && claim.refutation === 'stands') {
    return { headline: true, reason: '单一来源逐字支持，且独立反驳未能推翻' }
  }
  if (claim.tier === 'unverified') {
    return { headline: false, reason: '尚未通过任何验证，只能作为线索' }
  }
  return { headline: false, reason: '综合性或推算类结论，用「看起来」而不是「我们发现」的措辞' }
}

/**
 * What a claim must carry before it may be merged into the agenda.
 * @param {Record<string, any>} claim
 * @returns {{ ok: boolean, issues: { code: string, message: string }[] }}
 */
export function validateAgendaClaim(claim) {
  /** @type {{ code: string, message: string }[]} */
  const issues = []
  if (!String(claim?.statement ?? '').trim()) {
    issues.push({ code: 'agenda_claim_invalid', message: 'a claim needs a statement.' })
  }
  if (!['direct', 'synthesized', 'derived'].includes(String(claim?.type))) {
    issues.push({ code: 'agenda_claim_invalid', message: `claim type "${claim?.type}" must be direct / synthesized / derived.` })
  }
  if (claim?.tier !== 'unverified') {
    issues.push({
      code: 'agenda_claim_self_graded',
      message: 'a new claim enters as "unverified"; only a verification episode raises a tier.',
    })
  }
  if (!Array.isArray(claim?.sources) || !claim.sources.length) {
    issues.push({ code: 'agenda_claim_invalid', message: 'a claim needs sources[].' })
  }
  if (!claim?.provenance || typeof claim.provenance !== 'object') {
    issues.push({ code: 'agenda_claim_invalid', message: 'a claim needs provenance pointing at the episode that produced it.' })
  }
  if (claim?.type !== 'direct' && !String(claim?.what_would_change ?? '').trim()) {
    issues.push({
      code: 'agenda_claim_unfalsifiable',
      message: 'a synthesized or derived claim must state what evidence would overturn it.',
    })
  }
  const effect = claim?.effect
  if (effect && !ALLOWED_EFFECT_MEASURES.includes(String(effect.measure))) {
    issues.push({
      code: 'agenda_effect_measure_unknown',
      message: `"${effect.measure}" is not one of the effect measures a data analysis may report.`,
    })
  }
  return { ok: issues.length === 0, issues }
}

/**
 * Whether a raised tier is legitimate.
 *
 * `reproduced` requires a verification episode that actually re-ran the code;
 * `gated` requires the contract gate to have passed. A raise with neither is a
 * model grading its own work, which is the whole thing the tiers prevent.
 *
 * @param {{ from: string, to: string, gatePassed?: boolean, reproductionMatched?: boolean, refutation?: string }} input
 * @returns {{ ok: boolean, reason: string | null }}
 */
export function tierRaiseAllowed(input) {
  if (input.to === 'gated') {
    if (!input.gatePassed) return { ok: false, reason: 'the contract gate has not passed for this deliverable' };
    if (input.refutation === 'refuted') return { ok: false, reason: 'an independent refuter overturned it' };
    return { ok: true, reason: null };
  }
  if (input.to === 'reproduced') {
    if (input.from !== 'gated') return { ok: false, reason: 'a claim reaches "reproduced" through "gated", not directly' };
    if (!input.reproductionMatched) return { ok: false, reason: 'the verification episode did not reproduce the numbers' };
    return { ok: true, reason: null };
  }
  return { ok: false, reason: `"${input.to}" is not a tier a claim can be raised to` };
}

/**
 * The stopping rules.
 *
 * Every one of them exists because unattended work fails quietly: a direction
 * that yields nothing keeps yielding nothing, a task type that fails twice
 * fails a third time, and a digest nobody opens is money spent on nobody. The
 * seven-day rule is the one that matters most for trust — a system that keeps
 * spending while its owner has stopped looking has stopped being useful and
 * started being expensive.
 */
export const STOPPING_RULES = Object.freeze({
  episodesWithoutGatedClaimBeforeHalving: 3,
  episodesWithoutGatedClaimBeforeParking: 6,
  consecutiveFailuresBeforePausingTaskType: 2,
  daysWithoutOpeningDigestBeforePausing: 7,
  episodeWallClockHours: 2,
})

/**
 * Whether a direction should keep running.
 * @param {{ episodesWithoutGatedClaim: number, consecutiveFailures: number, daysSinceDigestOpened: number, userRejected: boolean }} state
 * @returns {{ action: 'run' | 'halve' | 'park' | 'pause-type' | 'pause-thread', reason: string }}
 */
export function directionVerdict(state) {
  if (state.daysSinceDigestOpened >= STOPPING_RULES.daysWithoutOpeningDigestBeforePausing) {
    return { action: 'pause-thread', reason: '简报连续多天未打开，线程自动暂停，不再花钱。' };
  }
  if (state.consecutiveFailures >= STOPPING_RULES.consecutiveFailuresBeforePausingTaskType) {
    return { action: 'pause-type', reason: '同一类型连续失败，已暂停并进入待审阅。' };
  }
  if (state.userRejected) {
    return { action: 'park', reason: '用户驳回了这个方向。' };
  }
  if (state.episodesWithoutGatedClaim >= STOPPING_RULES.episodesWithoutGatedClaimBeforeParking) {
    return { action: 'park', reason: '连续多个回合没有产出可用结论，方向暂停探索。' };
  }
  if (state.episodesWithoutGatedClaim >= STOPPING_RULES.episodesWithoutGatedClaimBeforeHalving) {
    return { action: 'halve', reason: '收益递减，优先级减半。' };
  }
  return { action: 'run', reason: '' };
}

/** Things an autonomous episode may never do, whatever its plan says. */
export const AUTOPILOT_PROHIBITIONS = Object.freeze([
  'regulated-capability',
  'outbound-message',
  'purchase',
  'off-catalogue-source',
  'individual-treatment-advice',
]);

/**
 * Deterministic exploratory/confirmatory assignment by row hash.
 *
 * Deterministic so the same row always lands in the same partition — a random
 * split re-drawn per run is a split that leaks, because a row can be explored
 * one night and confirmed the next.
 *
 * @param {string} rowKey @param {number} exploratoryFraction @param {(input: string) => string} sha256Hex
 * @returns {'exploratory' | 'confirmatory'}
 */
export function datasetPartitionOf(rowKey, exploratoryFraction, sha256Hex) {
  const digest = sha256Hex(rowKey);
  const bucket = Number.parseInt(digest.slice(0, 8), 16) / 0xffffffff;
  return bucket < exploratoryFraction ? 'exploratory' : 'confirmatory';
}
