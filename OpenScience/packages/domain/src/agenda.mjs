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

/**
 * Why a claim was not given an independent re-check (`verification.status` is
 * `unscheduled`, and this is its `reason`). Every one of them ends the claim's
 * verification: nothing reads "queued" for a run that will never be made.
 *
 *  - `verification_cap`: more claims than an episode re-checks (`STOPPING_RULES`).
 *  - `verification_budget_unavailable`: the share held back for re-checks cannot
 *    pay for this one at `MIN_RUN_BUDGET_CNY` (`splitEpisodeBudget`).
 *  - `agenda_stopped` / `agenda_paused`: the agenda stopped before the re-check
 *    started. A restart does not revive it: the next episode brings its own.
 */
export const VERIFICATION_UNSCHEDULED_REASONS = Object.freeze([
  'verification_cap', 'verification_budget_unavailable', 'agenda_stopped', 'agenda_paused',
])

/**
 * The `code` of a claim whose re-check was running when its agenda was stopped
 * and was cancelled with it: not a missing result and not a failed run, which
 * are what the cancelled run's own ending would otherwise be recorded as.
 */
export const VERIFICATION_CANCELED_BY_STOP = 'verification_canceled_by_stop'

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
 * The net signal a researcher's digest decisions send about a direction.
 *
 * Each decision is scored on the USER_SIGNALS scale; a `question` is a
 * follow-up, the strongest positive signal, because it asks for more of this
 * direction. `rejected` is the one bit directionVerdict consumes: the user
 * has decided on at least one finding and the net weight is negative. One
 * rejection outweighs one adoption on purpose — the spec's "驳回 → 置底" rule —
 * but three adoptions outweigh one rejection, so rejecting a single lead as
 * out of scope does not park a direction the user is otherwise following.
 *
 * @param {Array<{ action?: string, claimId?: string }> | undefined} decisions
 * @returns {{ score: number, decided: number, rejected: boolean }}
 */
export function userSignalScore(decisions) {
  const weights = /** @type {Readonly<Record<string, number>>} */ (USER_SIGNALS)
  let score = 0
  let decided = 0
  /** @type {Map<string, number[]>} each claim's standing verdict weights, latest last */
  const verdicts = new Map()
  for (const decision of Array.isArray(decisions) ? decisions : []) {
    // A withdrawal undoes the claim's latest standing adopt or reject, as if it
    // had not been clicked (2026-09-16 review, U17). One with nothing to undo
    // is not a signal.
    if (decision?.action === 'withdraw') {
      const weight = verdicts.get(String(decision?.claimId ?? ''))?.pop()
      if (weight == null) continue
      score -= weight
      decided -= 1
      continue
    }
    const action = decision?.action === 'question' ? 'followUp' : decision?.action
    const weight = typeof action === 'string' && Object.hasOwn(weights, action) ? weights[action] : null
    if (weight == null) continue
    score += weight
    decided += 1
    if (action === 'adopt' || action === 'reject') {
      const key = String(decision?.claimId ?? '')
      verdicts.set(key, [...(verdicts.get(key) ?? []), weight])
    }
  }
  return { score: Math.round(score * 100) / 100, decided, rejected: decided > 0 && score < 0 }
}

/**
 * The adopt or reject a withdrawal of `claimId` would undo, or null.
 * @param {readonly any[] | undefined} decisions @param {string} claimId
 */
export function standingVerdict(decisions, claimId) {
  /** @type {any[]} */ const stack = []
  for (const decision of Array.isArray(decisions) ? decisions : []) {
    if (String(decision?.claimId ?? '') !== claimId) continue
    if (decision?.action === 'adopt' || decision?.action === 'reject') stack.push(decision)
    else if (decision?.action === 'withdraw') stack.pop()
  }
  return stack.at(-1) ?? null
}

/**
 * Whether a claim may lead the morning digest.
 *
 * Only a reproduced result or a direct claim that survived refutation. An
 * interpretation, however well argued, goes lower down and in the language of
 * interpretation — this is the direct countermeasure to the 58% figure.
 *
 * The refutation verdict is read before the tier, not after it: a tier is a
 * record of what has been checked so far, and an independent refuter is the
 * later check. A claim that reads "reproduced" and "refuted" at once is a
 * ledger that lost a write, and the safe reading of that pair is the one that
 * keeps it out of the headlines.
 *
 * `weakened` used to fall through to the `reproduced` branch and headline; it
 * no longer does, and that is a deliberate tightening rather than an oversight.
 * The verdict had no producer until independent verification existed, so no
 * stored claim can have carried it, and the first claim that ever does carry it
 * is one a refuter supported less than it claimed — which is the definition of
 * a lead rather than a headline.
 *
 * @param {{ tier: string, type: string, refutation?: string, what_would_change?: string }} claim
 * @returns {{ headline: boolean, reason: string }}
 */
export function digestPlacement(claim) {
  if (claim.refutation === 'refuted') {
    return { headline: false, reason: '独立复核推翻了这条结论，不能作为发现' }
  }
  if (claim.refutation === 'weakened') {
    return { headline: false, reason: '独立复核只能部分支持，措辞需保守' }
  }
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
  if (!String(claim?.id ?? '').trim() || String(claim?.id ?? '').length > 160) {
    issues.push({ code: 'agenda_claim_invalid', message: 'a claim needs a bounded id.' })
  }
  if (!String(claim?.statement ?? '').trim() || String(claim?.statement ?? '').length > 8000) {
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
  if (!Array.isArray(claim?.sources) || !claim.sources.length || claim.sources.length > 100
    || claim.sources.some((source) => typeof source !== 'string' || !source.trim() || source.length > 1000)) {
    issues.push({ code: 'agenda_claim_invalid', message: 'a claim needs sources[].' })
  }
  if (!claim?.provenance || typeof claim.provenance !== 'object' || Array.isArray(claim.provenance)
    || !String(claim.provenance.episodeId ?? '').trim() || !String(claim.provenance.artifact ?? '').trim()) {
    issues.push({ code: 'agenda_claim_invalid', message: 'a claim needs provenance pointing at the episode that produced it.' })
  }
  if (claim?.type !== 'direct' && !String(claim?.what_would_change ?? '').trim()) {
    issues.push({
      code: 'agenda_claim_unfalsifiable',
      message: 'a synthesized or derived claim must state what evidence would overturn it.',
    })
  }
  if (['synthesized', 'derived'].includes(String(claim?.type))
    && !['high', 'moderate', 'low'].includes(String(claim?.confidence))) {
    issues.push({ code: 'agenda_claim_invalid', message: 'a synthesized or derived claim needs high, moderate, or low confidence.' })
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
 *
 * `verificationsPerEpisode` is the same kind of rule pointed at the second
 * process rather than the first. Independent verification is what lets a claim
 * reach `reproduced`, and it is a second run with a second bill; uncapped, one
 * productive night would spend a second night's budget re-checking itself. At
 * most three claims per episode are re-checked, and the share they spend is
 * held back out of the night's own budget before the episode is dispatched
 * (`splitEpisodeBudget` below), so a night costs what it said it would cost
 * whether or not its claims earn a second opinion.
 */
export const STOPPING_RULES = Object.freeze({
  episodesWithoutGatedClaimBeforeHalving: 3,
  episodesWithoutGatedClaimBeforeParking: 6,
  consecutiveFailuresBeforePausingTaskType: 2,
  daysWithoutOpeningDigestBeforePausing: 7,
  episodeWallClockHours: 2,
  verificationsPerEpisode: 3,
})

/**
 * The caps a new agenda is offered before its researcher edits them, in CNY:
 * what the task form shows, and what an agenda created on a researcher's behalf
 * (an adopted research opportunity) starts with. Ceilings, not spend — an
 * episode costs what its model calls cost — and an agenda created with them is
 * not running until its researcher starts it.
 */
export const AGENDA_DEFAULT_BUDGETS = Object.freeze({ maxEpisodeCny: 100, dailyBudgetCny: 500, weeklyBudgetCny: 3000 })

/**
 * The smallest budget one run can be given, in CNY.
 *
 * A limit on a run compares reservations, not spend. Before a call is sent the
 * model gateway holds the price of the most it could cost: its output ceiling
 * (65,536 tokens — ¥0.52 by day at ¥8 per million, half that at the night
 * rate) plus the prompt at the cache-miss rate (¥2 per million: ¥0.15 for the
 * median prompt of 73 thousand tokens, ¥0.61 for the 99th percentile of 305
 * thousand, production 2026-10-05), and settles at the real count afterwards,
 * usually ¥0.003 to ¥0.04. A call is admitted while the run's settled spend
 * plus that hold fits under the limit, so ¥1.2 admits a first call with any
 * prompt the platform has sent and leaves room for the calls after it. It is a
 * fact about the gateway's reservation (`estimateModelReservation`, and the
 * ceiling the gateway forwards a call with), written here once; every budget
 * that becomes a run's limit is held to it: the episode cap an agenda accepts,
 * each verification's share of it, and what is left of an agenda's own window.
 * Until 2026-10-05 the hold followed the 256,000 tokens the kernel names on
 * every request — ¥2.05 by day — and a run limited to ¥2.25 ended on its
 * second call.
 */
export const MIN_RUN_BUDGET_CNY = 1.2

/** The share of an episode's cap held back for the second opinions its claims may earn. */
export const VERIFICATION_BUDGET_SHARE = 0.25

/**
 * How one episode's cap is split between the episode and its verifications.
 *
 * Both halves spend against the same rolling daily cap, so an episode given the
 * whole cap can exhaust it and leave every verification of its own claims
 * refused: the second opinion starved by the first. A share is therefore taken
 * out before the episode is dispatched — but only a share that can pay for
 * something. Each verification is a run of its own and needs `MIN_RUN_BUDGET_CNY`,
 * so the share is divided among as many verifications as it can fund at that
 * minimum (none to `verificationsPerEpisode`) and each gets an equal part of it;
 * a share that funds none is not held back, because money held for a run that
 * cannot start is money the episode could have used. The claims past that count
 * are recorded as not re-checked, with the reason, instead of queued as runs
 * that would each end on their first call.
 *
 * Whole cents throughout: ¥1.20 is 120, never 1.2000000000000002.
 *
 * @param {number} capCny what one episode may spend, its verifications included
 * @returns {{ episodeCny: number, verificationCny: number, verifications: number }}
 */
export function splitEpisodeBudget(capCny) {
  const capCents = Math.round(Number(capCny) * 100)
  if (!Number.isFinite(capCents) || capCents <= 0) return { episodeCny: 0, verificationCny: 0, verifications: 0 }
  const heldCents = Math.floor(Math.round(capCents * VERIFICATION_BUDGET_SHARE * 1e6) / 1e6)
  const verifications = Math.min(STOPPING_RULES.verificationsPerEpisode, Math.floor(heldCents / Math.round(MIN_RUN_BUDGET_CNY * 100)))
  if (verifications < 1) return { episodeCny: capCents / 100, verificationCny: 0, verifications: 0 }
  const eachCents = Math.floor(heldCents / verifications)
  return { episodeCny: (capCents - eachCents * verifications) / 100, verificationCny: eachCents / 100, verifications }
}

/**
 * The smallest per-episode cap an agenda accepts: the smallest whose episode
 * share, after the split above, is still a budget a run can be given. Found by
 * asking the split rather than by restating its arithmetic, so a change to the
 * share or to the minimum moves it too. At today's numbers a share is held back
 * only once it funds a verification, so the minimum is one run's minimum.
 */
export const AGENDA_MIN_EPISODE_BUDGET_CNY = (() => {
  for (let cents = 1; cents <= 100_000; cents += 1) {
    if (splitEpisodeBudget(cents / 100).episodeCny >= MIN_RUN_BUDGET_CNY) return cents / 100
  }
  throw new Error('No per-episode cap leaves the episode a runnable budget.')
})()

/**
 * Whether a direction should keep running.
 *
 * The five actions are not about one thing. `pause-type` is about a task type
 * whose episodes keep failing to run, so `consecutiveFailures` is that type's
 * own count and the type alone is paused. `halve` is about a direction whose
 * episodes ran and found nothing, so `episodesWithoutGatedClaim` counts only
 * episodes that ran to a result — a failed or canceled episode never looked at
 * the question and is no evidence about it — and the direction's next scheduled
 * episode gets half the budget. `park` and `pause-thread` are about the whole
 * agenda. The server applies each at its scope (`autopilotOutcome.mjs`).
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
