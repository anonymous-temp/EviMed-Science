/**
 * The lifecycle of a learned method: what counts as a use, when a method may
 * become effective, when it should be retired, and what the dependency graph is
 * allowed to look like.
 *
 * Hidden knowledge: this module exists because every one of those questions was
 * about to be answered by an `if` somewhere in a worker, and each answer has to
 * be identical in three places — the nightly consolidation job that proposes,
 * the API that shows a researcher why a candidate is still a candidate, and the
 * test that says the promotion rule cannot be widened by accident.
 *
 * Three decisions are worth stating out loud, because all three differ from the
 * papers this loop is built from:
 *
 * 1. **A digest change resets the counters.** EvoDS counts uses by function
 *    *name*, so a rewritten tool inherits the confidence its predecessor
 *    earned — the authors' own comment says "tool may not the same, update in
 *    the future". Counting against `(method, contentDigest)` is the fix, and it
 *    is why `learning.digest` is stored beside the counts rather than derived.
 * 2. **A failed use is not a use.** EvoDS's `execute_tool` swallows exceptions
 *    into a string and the caller still counts the call, so a tool that throws
 *    every time can cross its threshold. Here only an outcome the run actually
 *    accepted counts toward the threshold.
 * 3. **The threshold is a budget gate, not a proof.** Crossing tau means the
 *    method has earned a paired evaluation, not that it works. Promotion of an
 *    *inferred* method additionally requires that evaluation to have come back
 *    better or non-inferior against the current baseline (spec line 1812).
 *
 * A method whose origin is explicit — the researcher said "always do it this
 * way" — skips all of that and is effective immediately, with a rollback. That
 * is not a loophole; it is the rule that keeps the loop from becoming an
 * approval queue (§16 #22, §29.2 #1).
 */
import {
  MAX_ACTIVE_LEARNED_METHODS,
  MEMORY_PROMOTION_MIN_RUNS,
  MEMORY_REFLECTION_IMPORTANCE_THRESHOLD,
  MEMORY_STRENGTH_TAU_DAYS,
  METHOD_CONTRIBUTION_MIN_TRIALS,
  METHOD_CONTRIBUTION_RETIRE_AT,
  METHOD_INDUCTION_MIN_TRAJECTORIES,
} from './constants.mjs'
import { isMethodDigest } from './methodSkill.mjs'

/**
 * How two methods can be related.
 *
 * The first four are SkillPyramid's; the last two are ours. `conflicts_with`
 * exists because the paper's builder has no way to say "these two disagree" and
 * so would merge them; `supersedes` exists because a merge has to leave a
 * forwarding address or the sources' history is orphaned.
 */
export const METHOD_RELATION_TYPES = Object.freeze([
  'shared_part', 'subset', 'merge', 'abstract_pattern', 'conflicts_with', 'supersedes',
])

/** What the paired evaluation can conclude. */
export const METHOD_EVALUATION_VERDICTS = Object.freeze(['better', 'non_inferior', 'inconclusive', 'worse'])

/** Verdicts that let an inferred method through. */
export const METHOD_PASSING_VERDICTS = Object.freeze(['better', 'non_inferior'])

/** How a run ended, from the point of view of a method that was loaded for it. */
export const METHOD_OBSERVATION_OUTCOMES = Object.freeze(['accepted', 'repaired', 'rejected'])

/** Outcomes that count toward the induction threshold. A run the gate refused
 *  is evidence against the method, not for it. */
export const METHOD_SUCCESS_OUTCOMES = Object.freeze(['accepted', 'repaired'])

/** Where a method came from, which is what decides whether it needs a gate. */
export const METHOD_ORIGINS = Object.freeze(['explicit', 'inferred'])

/** The six counters, kept apart on purpose: "was available", "was mounted",
 *  "was actually invoked", "was in a run that succeeded", "beat a baseline" and
 *  "was read with nothing to attribute it to" are six different claims and
 *  collapsing them is how a library of unused methods looks busy.
 *
 *  `read` is the one that carries no outcome. A run that delegates nothing —
 *  the whole open-domain answer line — can still call the `skill` tool and read
 *  a method, but it produces no mounted digest and no deliverable verdict, so
 *  there is nothing to judge the reading by. It is deliberately kept out of
 *  `methodContribution`, whose denominator is `loaded`: a reading with no
 *  verdict entering a success rate would move the rate without evidence, in
 *  whichever direction the arithmetic happened to fall. What it does support is
 *  the one claim it is: the method was not passed over. */
export const METHOD_COUNT_KINDS = Object.freeze(['eligible', 'loaded', 'invoked', 'succeeded', 'validated', 'read'])

/**
 * @typedef {object} MethodObservation
 * @property {string} runId
 * @property {string} family   the run family, so a retry is not a second trajectory
 * @property {string} outcome  one of METHOD_OBSERVATION_OUTCOMES
 * @property {string} at       ISO timestamp
 * @property {boolean} [invoked]  the run called the method, not merely loaded it
 */

/**
 * @typedef {object} MethodRelation
 * @property {string} type
 * @property {string} target   the other method's id
 * @property {string} evidence
 * @property {string} proposedBy
 * @property {boolean} [resolved]
 */

/**
 * @typedef {object} MethodEvaluation
 * @property {string} report        path of the paired-evaluation report
 * @property {string} baselineDigest
 * @property {string} verdict
 * @property {string} [at]
 * @property {string} [candidateDigest]  the content this verdict was measured on
 */

/**
 * @typedef {object} MethodLearning
 * @property {string} digest
 * @property {{eligible: number, loaded: number, invoked: number, succeeded: number, validated: number, read: number}} counts
 * @property {MethodObservation[]} observations
 * @property {MethodRelation[]} relations
 * @property {MethodEvaluation[]} evaluations
 * @property {number} level
 * @property {string|null} [lastReadAt]  when a run last read the body with nothing to attribute it to
 */

/**
 * @typedef {object} MethodProvenance
 * @property {string} origin   one of METHOD_ORIGINS
 * @property {string} [runId]
 * @property {string[]} [feedbackEventIds]
 * @property {boolean} [safetyRelated]
 * @property {boolean} [incident]   a confirmed incident this method contributed to
 */

/**
 * @typedef {object} MethodRecord
 * @property {string} id
 * @property {string} name
 * @property {string} digest
 * @property {string} status
 * @property {readonly {name: string, digest: string}[]} dependencies
 * @property {MethodLearning} learning
 * @property {MethodProvenance} provenance
 */

/* ------------------------------------------------------------ the learning payload */

/** @param {string} digest @returns {MethodLearning} */
export function emptyLearning(digest) {
  return {
    digest,
    counts: { eligible: 0, loaded: 0, invoked: 0, succeeded: 0, validated: 0, read: 0 },
    observations: [],
    relations: [],
    evaluations: [],
    level: 0,
    lastReadAt: null,
  }
}

/**
 * Bring a learning payload onto a digest.
 *
 * Everything measured against the previous body is discarded, deliberately and
 * loudly: counters, observations and evaluations all describe text that no
 * longer exists. Relations survive because they are about the method's place in
 * the library, not about a particular wording.
 * @param {MethodLearning} learning
 * @param {string} digest
 * @returns {MethodLearning}
 */
export function resetLearningForDigest(learning, digest) {
  const current = learning ?? emptyLearning(digest)
  if (current.digest === digest) return current
  return { ...emptyLearning(digest), relations: current.relations ?? [], level: current.level ?? 0 }
}

/**
 * Record one run's use of the method.
 *
 * Keyed by run *family* rather than run id: a retry, a fork, and a repair round
 * are the same trajectory seen more than once, and counting them separately is
 * how three attempts at one task turn into a promotion.
 * @param {MethodLearning} learning
 * @param {MethodObservation} observation
 * @returns {MethodLearning}
 */
export function foldObservation(learning, observation) {
  const current = learning ?? emptyLearning('')
  if (!observation?.family || !METHOD_OBSERVATION_OUTCOMES.includes(observation.outcome)) return current
  const observations = [...(current.observations ?? [])]
  const existing = observations.findIndex((entry) => entry.family === observation.family)
  const isFirst = existing < 0
  if (isFirst) observations.push(observation)
  else observations[existing] = { ...observations[existing], ...observation }

  const counts = { ...current.counts }
  if (isFirst) {
    counts.loaded += 1
    if (observation.invoked) counts.invoked += 1
    if (METHOD_SUCCESS_OUTCOMES.includes(observation.outcome)) counts.succeeded += 1
  } else {
    const before = observations[existing]
    if (observation.invoked && !before.invoked) counts.invoked += 1
  }
  return { ...current, counts, observations }
}

/**
 * Count a run where the method was available and not chosen. Eligibility is the
 * denominator the selection quality is read against; without it a method that
 * is never picked looks the same as one that never applies.
 * @param {MethodLearning} learning
 * @returns {MethodLearning}
 */
export function foldEligible(learning) {
  const current = learning ?? emptyLearning('')
  return { ...current, counts: { ...current.counts, eligible: current.counts.eligible + 1 } }
}

/**
 * Count a run that read the body with nothing to attribute the reading to.
 *
 * Not an observation, and it must never become one. An observation carries a
 * deliverable's verdict, and the runs this counter exists for produce no
 * deliverable — they answer the researcher directly. Recording a verdict-less
 * reading as an observation would put it in `methodContribution`'s denominator
 * and move a success rate on no evidence.
 *
 * What it changes is the retirement question, and only the "unused" half of it.
 * `methodStrength` decays successful observations, so a method that only ever
 * reaches the non-delegating answer line has a strength of exactly 0 no matter
 * how often it is read, and reads to `retirementProposal` as idle. It is not
 * idle. A single timestamp rather than a list of them: the question this has to
 * answer is "was this read lately", which the most recent reading settles, and
 * a growing array of readings nobody can judge is a ledger that only gets
 * heavier. The timestamp moves forward only, so an out-of-order write from a
 * slow run cannot make a method look staler than it is.
 *
 * Both parameters admit `undefined` because both callers can supply it and the
 * body already answers for it: the mount path folds a reading into whatever
 * record the method has, which is nothing at all for a method mounted for the
 * first time, and the timestamp arrives from an event whose field is optional.
 * Declaring them required did not make them present — it only moved the
 * absence past the type checker and into a `TypeError` at the one call site
 * that matters.
 *
 * @param {MethodLearning | undefined} learning
 * @param {string | undefined} at  ISO timestamp of the reading
 * @returns {MethodLearning}
 */
export function foldRead(learning, at) {
  const current = learning ?? emptyLearning('')
  const readAt = Date.parse(at ?? '')
  if (Number.isNaN(readAt)) return current
  const previous = Date.parse(current.lastReadAt ?? '')
  return {
    ...current,
    counts: { ...current.counts, read: Number(current.counts?.read ?? 0) + 1 },
    lastReadAt: Number.isNaN(previous) || readAt > previous ? new Date(readAt).toISOString() : current.lastReadAt,
  }
}

/**
 * @param {MethodLearning} learning
 * @param {MethodEvaluation} evaluation
 * @returns {MethodLearning}
 */
export function foldEvaluation(learning, evaluation) {
  const current = learning ?? emptyLearning('')
  if (!METHOD_EVALUATION_VERDICTS.includes(evaluation?.verdict)) return current
  const evaluations = [...(current.evaluations ?? []), evaluation]
  const counts = { ...current.counts }
  // A verdict counts for the text it measured and for nothing else.
  //
  // An evaluation takes hours of real runs; a method can be amended while one
  // is in flight, and an amendment resets this record to a fresh one for the
  // new digest. Folding the arriving verdict in unconditionally therefore made
  // the old text's score the new text's first vote — the score was real, the
  // text it described no longer existed, and nothing said so. Recorded either
  // way, because "we measured something else" is a fact about this method
  // worth keeping; counted only when the digests agree.
  const measured = typeof evaluation.candidateDigest === 'string' ? evaluation.candidateDigest : null
  const onCurrentText = measured !== null && measured === current.digest
  if (onCurrentText && METHOD_PASSING_VERDICTS.includes(evaluation.verdict)) counts.validated += 1
  return { ...current, counts, evaluations }
}

/**
 * @param {MethodLearning} learning
 * @param {MethodRelation} relation
 * @returns {MethodLearning}
 */
export function foldRelation(learning, relation) {
  const current = learning ?? emptyLearning('')
  if (!METHOD_RELATION_TYPES.includes(relation?.type) || !relation?.target) return current
  const relations = [...(current.relations ?? [])]
  const existing = relations.findIndex((entry) => entry.type === relation.type && entry.target === relation.target)
  if (existing < 0) relations.push(relation)
  else relations[existing] = { ...relations[existing], ...relation }
  return { ...current, relations }
}

/** Distinct run families whose outcome counts as a success. @param {MethodLearning} learning @returns {string[]} */
export function successfulFamilies(learning) {
  const families = new Set()
  for (const observation of learning?.observations ?? []) {
    if (METHOD_SUCCESS_OUTCOMES.includes(observation.outcome)) families.add(observation.family)
  }
  return [...families]
}

/**
 * Distinct *runs* a successful trajectory came from.
 *
 * A family is one deliverable's trajectory, and one run can produce several —
 * so three successes inside a single run are three correlated readings of one
 * brief, one researcher and one set of sources, not three independent ones.
 * Counting runs separately is what stops a method being promoted on the
 * strength of a single afternoon.
 * @param {MethodLearning} learning @returns {string[]}
 */
export function successfulRuns(learning) {
  const runs = new Set()
  for (const observation of learning?.observations ?? []) {
    if (METHOD_SUCCESS_OUTCOMES.includes(observation.outcome) && observation.runId) runs.add(observation.runId)
  }
  return [...runs]
}

/** @param {MethodRelation[]} relations @returns {MethodRelation[]} */
export function unresolvedConflicts(relations) {
  return (relations ?? []).filter((relation) => relation.type === 'conflicts_with' && !relation.resolved)
}

/* ------------------------------------------------------------ strength and decay */

/**
 * Recency-weighted evidence that the method is still earning its place.
 *
 * The same exponential the memory subsystem uses for a fact's strength, over
 * the same tau, because "how much do we still believe this" is one question
 * whether the thing believed is a fact or a procedure.
 * @param {readonly MethodObservation[]} observations
 * @param {number} nowMs
 * @param {number} [tauDays]
 * @returns {number}
 */
export function methodStrength(observations, nowMs, tauDays = MEMORY_STRENGTH_TAU_DAYS) {
  let total = 0
  for (const observation of observations ?? []) {
    if (!METHOD_SUCCESS_OUTCOMES.includes(observation.outcome)) continue
    const at = Date.parse(observation.at ?? '')
    if (Number.isNaN(at)) continue
    const days = Math.max(0, (nowMs - at) / 86_400_000)
    total += Math.exp(-days / Math.max(1, tauDays))
  }
  return total
}

/**
 * How much a method is worth having, from outcomes alone.
 *
 * `(successes - failures) / trials`, where a trial is a trajectory the method
 * was mounted for and a failure is a trajectory whose deliverable the gate
 * refused. Ranges from -1 (never helped) through 0 (as often as not) to 1.
 *
 * Deliberately not `methodStrength`. Strength answers "is this still being
 * used", which is a recency question, and the two disagree exactly where it
 * matters: a method mounted into every run of the last fortnight whose packages
 * keep getting refused has high strength and negative contribution, and it is
 * the single worst thing a library can contain — it is not idle, it is active
 * and wrong. A retirement rule reading strength alone can never propose it.
 *
 * Null rather than 0 when the method has never been mounted: "no evidence" and
 * "evidence that it is neutral" are different, and a rule that cannot tell them
 * apart retires everything new.
 *
 * `undefined` is admitted for the same reason the null is returned: a method
 * with no learning record at all is the commonest input here, not an error.
 *
 * @param {MethodLearning | undefined} learning
 * @returns {number | null}
 */
export function methodContribution(learning) {
  const trials = Number(learning?.counts?.loaded ?? 0)
  if (!Number.isFinite(trials) || trials <= 0) return null
  const successes = Number(learning?.counts?.succeeded ?? 0)
  const failures = trials - successes
  return (successes - failures) / trials
}

/**
 * Which effective methods a library over its cap should give up first.
 *
 * Not a deletion and not an eviction: a proposal, lowest contribution first,
 * exactly as many as it takes to get back under the cap. A method that has
 * never been mounted is not a candidate — it has no record to be judged on, and
 * a cap that evicts the untried would guarantee the library only ever holds
 * what it already had.
 *
 * Safety-related methods are never proposed, for the same reason they are never
 * proposed by decay: rarely invoked is what a working safety check looks like.
 *
 * @param {readonly MethodRecord[]} methods  the effective ones
 * @param {{cap?: number}} [options]
 * @returns {{id: string, contribution: number, reason: string}[]}
 */
export function libraryEvictions(methods, options = {}) {
  const cap = options.cap ?? MAX_ACTIVE_LEARNED_METHODS
  const active = (methods ?? []).filter((method) => method?.status === 'approved')
  const excess = active.length - cap
  if (excess <= 0) return []
  const judged = active
    .filter((method) => !method?.provenance?.safetyRelated)
    .map((method) => ({ id: method.id, contribution: methodContribution(method.learning) }))
    .filter((entry) => entry.contribution !== null)
    .sort((left, right) => Number(left.contribution) - Number(right.contribution)
      || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  return judged.slice(0, excess).map((entry) => ({
    id: entry.id,
    contribution: Number(entry.contribution),
    reason: `the library holds ${active.length} effective methods against a cap of ${cap}, and this one contributes ${Number(entry.contribution).toFixed(2)}`,
  }))
}

/**
 * Whether the recent record is eventful enough to be worth one higher-level
 * reflection. Importance is the caller's, summed by the consolidation job; the
 * threshold is the memory subsystem's, reused so both kinds of reflection fire
 * on the same amount of evidence.
 * @param {number} accumulatedImportance
 * @param {number} [threshold]
 * @returns {boolean}
 */
export function reflectionDue(accumulatedImportance, threshold = MEMORY_REFLECTION_IMPORTANCE_THRESHOLD) {
  return Number(accumulatedImportance ?? 0) >= threshold
}

/* --------------------------------------------------------------- promotion */

/**
 * @typedef {object} PromotionOptions
 * @property {number} [minTrajectories]
 * @property {number} [minRuns]
 * @property {string} [currentBaselineDigest]  the digest the evaluation had to beat
 */

/**
 * Whether the method has earned the cost of a paired evaluation.
 *
 * This is EvoDS's tau, moved to the only place it is defensible: deciding how
 * to spend a budget. It is not evidence of anything.
 * @param {MethodRecord} method
 * @param {PromotionOptions} [options]
 * @returns {{eligible: boolean, reason: string}}
 */
export function evaluationEligible(method, options = {}) {
  const minTrajectories = options.minTrajectories ?? METHOD_INDUCTION_MIN_TRAJECTORIES
  const minRuns = options.minRuns ?? MEMORY_PROMOTION_MIN_RUNS
  if (method?.provenance?.origin === 'explicit') return { eligible: true, reason: 'explicit origin' }
  const learning = method?.learning
  if (learning?.digest !== method?.digest) {
    return { eligible: false, reason: 'the body changed since these observations, so the counters were reset' }
  }
  // Two thresholds that had collapsed into one. Observations are deduplicated by
  // family, so `successfulFamilies().length` *is* the successful-trajectory
  // count, and comparing it against both constants asked the same question
  // twice — leaving `MEMORY_PROMOTION_MIN_RUNS` looking enforced while nothing
  // enforced it. The independence that constant is about is between runs.
  const trajectories = successfulFamilies(learning)
  if (trajectories.length < minTrajectories) {
    return { eligible: false, reason: `${trajectories.length} successful trajectories; ${minTrajectories} are needed` }
  }
  const runs = successfulRuns(learning)
  if (runs.length < minRuns) {
    return { eligible: false, reason: `those trajectories all came from ${runs.length} run(s); ${minRuns} are needed` }
  }
  return { eligible: true, reason: `${trajectories.length} successful trajectories across ${runs.length} runs` }
}

/**
 * Whether a candidate may become effective, and if not, exactly what is missing.
 *
 * Returns a verdict rather than performing anything: the caller writes the
 * revision, sends the notice, and keeps the rollback target. The `missing` list
 * is shown to the researcher verbatim, which is the difference between "the
 * system is not learning" and "it has two of the three run families it needs".
 * @param {MethodRecord} method
 * @param {PromotionOptions} [options]
 * @returns {{status: string, reasons: string[], missing: string[]}}
 */
export function promotionVerdict(method, options = {}) {
  /** @type {string[]} */
  const reasons = []
  /** @type {string[]} */
  const missing = []
  const learning = method?.learning ?? emptyLearning(method?.digest ?? '')

  const conflicts = unresolvedConflicts(learning.relations)
  if (conflicts.length) {
    missing.push(`${conflicts.length} unresolved conflict(s) with ${conflicts.map((entry) => entry.target).join(', ')}`)
  }

  if (method?.provenance?.origin === 'explicit') {
    reasons.push('explicit origin: the researcher stated this, so it takes effect immediately and is rolled back by restoring the previous revision')
    return { status: missing.length ? 'candidate' : 'approved', reasons, missing }
  }

  const eligibility = evaluationEligible(method, options)
  if (!eligibility.eligible) missing.push(eligibility.reason)
  else reasons.push(eligibility.reason)

  const evaluations = learning.evaluations ?? []
  const latest = evaluations.length ? evaluations[evaluations.length - 1] : null
  if (!latest) {
    missing.push('no paired evaluation has been run against a frozen baseline')
  } else if (!METHOD_PASSING_VERDICTS.includes(latest.verdict)) {
    missing.push(`the last evaluation returned ${latest.verdict}`)
  } else if (latest.candidateDigest !== learning.digest) {
    // Either it names no candidate text at all, or it names text this method
    // no longer holds. Both are the same fact for a promotion: this verdict is
    // not about what would be mounted.
    missing.push(latest.candidateDigest
      ? 'the last evaluation measured a revision this method no longer holds'
      : 'the last evaluation does not name the text it measured')
  } else if (options.currentBaselineDigest && latest.baselineDigest !== options.currentBaselineDigest) {
    missing.push('the last evaluation was measured against a baseline that has since moved')
  } else {
    reasons.push(`evaluation ${latest.verdict} against ${latest.baselineDigest}`)
  }

  return { status: missing.length ? 'candidate' : 'approved', reasons, missing }
}

/* -------------------------------------------------------------- retirement */

/**
 * @typedef {object} RetirementOptions
 * @property {number} nowMs
 * @property {number} [tauDays]
 * @property {number} [minStrength]
 * @property {(id: string) => boolean} [isApproved]  whether a superseding method is effective
 * @property {number} [minTrials]   trajectories before contribution may retire it
 * @property {number} [retireAt]    the contribution at or below which it is proposed
 */

/**
 * Whether to propose retiring a method.
 *
 * Two carve-outs, both learned the hard way elsewhere in this system:
 *
 *  - A safety-related method is never proposed for retirement on grounds of
 *    disuse. Rarely needed is what a safety check looks like when it is working.
 *  - A method implicated in a confirmed incident is retired immediately and
 *    does not wait for the nightly job or for a replacement.
 *
 * Everything else is a *proposal*: a notice with a one-click rollback, never a
 * silent deletion, and never a deletion at all — retirement is a status.
 * @param {MethodRecord} method
 * @param {RetirementOptions} options
 * @returns {{propose: boolean, immediate: boolean, reason: string, strength: number, contribution?: number}}
 */
export function retirementProposal(method, options) {
  const learning = method?.learning ?? emptyLearning(method?.digest ?? '')
  const strength = methodStrength(learning.observations, options.nowMs, options.tauDays)
  if (method?.provenance?.incident) {
    return { propose: true, immediate: true, reason: 'implicated in a confirmed incident', strength }
  }
  if (method?.status === 'retired') return { propose: false, immediate: false, reason: 'already retired', strength }
  if (method?.provenance?.safetyRelated) {
    return { propose: false, immediate: false, reason: 'safety-related: rarely invoked is what a working safety check looks like', strength }
  }
  // Outcome before recency. A method that is mounted constantly and whose
  // packages keep being refused has *high* strength, so every clause below this
  // one reads it as healthy and lets it stay — which is how a library ends up
  // actively injecting the thing that is hurting it while every metric on the
  // dashboard looks busy and fine. This is the only clause that can propose a
  // method that is still in daily use, and it needs no replacement to do it:
  // removing something that makes packages worse removes nothing.
  const contribution = methodContribution(learning)
  const minTrials = options.minTrials ?? METHOD_CONTRIBUTION_MIN_TRIALS
  const retireAt = options.retireAt ?? METHOD_CONTRIBUTION_RETIRE_AT
  if (contribution !== null && Number(learning.counts?.loaded ?? 0) >= minTrials && contribution <= retireAt) {
    return {
      propose: true,
      immediate: false,
      reason: `${learning.counts.loaded} trajectories at a contribution of ${contribution.toFixed(2)}, at or below ${retireAt}`,
      strength,
      contribution,
    }
  }
  const superseded = (learning.relations ?? []).filter((relation) => relation.type === 'supersedes')
  const replacement = superseded.find((relation) => !options.isApproved || options.isApproved(relation.target))
  const minStrength = options.minStrength ?? 0.5
  if (strength >= minStrength) {
    return { propose: false, immediate: false, reason: `still in use (strength ${strength.toFixed(2)})`, strength }
  }
  // Read lately, with nothing to show for it.
  //
  // Every clause above this one reads outcomes, and a run that delegates
  // nothing produces none — so a method used exclusively by the non-delegating
  // answer line arrives here with a strength of exactly 0 and is
  // indistinguishable from one nobody has opened in a year. That is the whole
  // reason `read` is counted separately, and this is the only place it is
  // allowed to change an answer.
  //
  // Deliberately below the contribution clause, not above it: a method whose
  // packages keep being refused must still be proposable no matter how often it
  // is read. Being read is evidence of not being idle, never evidence of being
  // good.
  //
  // The window is the strength decay's own, so "recently" means one thing in
  // this module. A reading older than that stops protecting anything, which is
  // what keeps a single ancient timestamp from pinning a method forever.
  const tauDays = options.tauDays ?? MEMORY_STRENGTH_TAU_DAYS
  const lastReadMs = Date.parse(learning.lastReadAt ?? '')
  const readDays = Number.isNaN(lastReadMs) ? null : Math.max(0, (options.nowMs - lastReadMs) / 86_400_000)
  if (readDays !== null && readDays <= tauDays) {
    return {
      propose: false,
      immediate: false,
      reason: `read ${readDays.toFixed(1)} days ago by a run that delegated nothing, so it has no outcomes and a strength of 0 without being idle`,
      strength,
    }
  }
  if (!replacement) {
    return { propose: false, immediate: false, reason: 'unused, but nothing validated replaces it; retiring it would remove a capability rather than a duplicate', strength }
  }
  return { propose: true, immediate: false, reason: `unused (strength ${strength.toFixed(2)}) and superseded by ${replacement.target}`, strength }
}

/* -------------------------------------------------------------- the graph */

/**
 * @typedef {object} MethodGraphIssue
 * @property {string} code
 * @property {string} message
 * @property {string} [method]
 */

/**
 * Level, as SkillPyramid derives it: a method with no dependencies sits at 0,
 * and anything else sits one above the highest thing it reuses.
 *
 * Not read from `metadata.role`. The role is a label a model writes; the level
 * is a fact about the graph, and when the two disagree the graph is right.
 * @param {readonly MethodRecord[]} methods
 * @returns {{levels: Map<string, number>, cycles: string[][]}}
 */
export function computeMethodLevels(methods) {
  /** @type {Map<string, MethodRecord>} */
  const byName = new Map()
  for (const method of methods ?? []) byName.set(method.name, method)
  /** @type {Map<string, number>} */
  const levels = new Map()
  /** @type {string[][]} */
  const cycles = []
  /** @type {Map<string, number>} */
  const state = new Map()

  /** @param {string} name @param {string[]} path @returns {number} */
  const visit = (name, path) => {
    if (levels.has(name)) return /** @type {number} */ (levels.get(name))
    if (state.get(name) === 1) {
      cycles.push([...path.slice(path.indexOf(name)), name])
      return 0
    }
    state.set(name, 1)
    const method = byName.get(name)
    let level = 0
    for (const dependency of method?.dependencies ?? []) {
      if (!byName.has(dependency.name)) continue
      level = Math.max(level, visit(dependency.name, [...path, name]) + 1)
    }
    state.set(name, 2)
    levels.set(name, level)
    return level
  }

  for (const method of methods ?? []) visit(method.name, [])
  return { levels, cycles }
}

/** @param {MethodRecord} method @param {readonly MethodRecord[]} methods @returns {number} */
export function methodLevel(method, methods) {
  return computeMethodLevels(methods).levels.get(method?.name) ?? 0
}

/**
 * Everything about the shape of the library that code can decide.
 *
 * Multiple parents are legal — a shared atomic method reused by four functional
 * ones is the whole point of extracting it — so this checks for cycles and
 * dangling pins, not for a tree.
 * @param {readonly MethodRecord[]} methods
 * @returns {{ok: boolean, issues: MethodGraphIssue[], levels: Map<string, number>}}
 */
export function validateMethodGraph(methods) {
  /** @type {MethodGraphIssue[]} */
  const issues = []
  const list = methods ?? []
  /** @type {Map<string, MethodRecord>} */
  const byName = new Map()
  for (const method of list) {
    if (byName.has(method.name)) {
      issues.push({ code: 'method_graph_duplicate_name', message: `Two methods are named ${method.name}; the loader addresses a method by name and only the first would ever load.`, method: method.name })
    }
    byName.set(method.name, method)
  }
  /** @type {Map<string, Set<string>>} */
  const digestsByName = new Map()
  for (const method of list) {
    const digests = digestsByName.get(method.name) ?? new Set()
    digests.add(method.digest)
    digestsByName.set(method.name, digests)
  }
  for (const method of list) {
    for (const dependency of method.dependencies ?? []) {
      if (!isMethodDigest(dependency.digest)) {
        issues.push({ code: 'method_graph_digest_unparsable', message: `${method.name} pins ${dependency.name} to ${JSON.stringify(dependency.digest)}, which is not a sha256 digest.`, method: method.name })
        continue
      }
      const known = digestsByName.get(dependency.name)
      if (!known) {
        issues.push({ code: 'method_graph_dangling_dependency', message: `${method.name} reuses ${dependency.name}, which is not in the library.`, method: method.name })
        continue
      }
      if (!known.has(dependency.digest)) {
        issues.push({ code: 'method_graph_digest_moved', message: `${method.name} pins ${dependency.name} at a revision that no longer exists; re-pin it or the reuse reference points at text nobody has.`, method: method.name })
      }
    }
    if (method.status === 'approved') {
      for (const dependency of method.dependencies ?? []) {
        const target = byName.get(dependency.name)
        if (target && target.status !== 'approved') {
          issues.push({ code: 'method_graph_dependency_not_effective', message: `${method.name} is effective but reuses ${dependency.name}, which is ${target.status}; the reference would resolve to nothing at mount time.`, method: method.name })
        }
      }
    }
  }
  const { levels, cycles } = computeMethodLevels(list)
  for (const cycle of cycles) {
    issues.push({ code: 'method_graph_cycle', message: `Reuse cycle: ${cycle.join(' -> ')}.`, method: cycle[0] })
  }
  return { ok: issues.length === 0, issues, levels }
}

/**
 * Shape checks on one relation the analyser proposed.
 *
 * The analyser's assignment is authoritative for the builder — SkillPyramid is
 * explicit that the builder may not change `ASSIGNMENT` or `RELATION_TYPE` —
 * so this is the only place a proposed relation is refused, and it refuses on
 * shape alone.
 * @param {MethodRelation} relation
 * @param {(id: string) => boolean} [exists]
 * @returns {MethodGraphIssue[]}
 */
export function relationIssues(relation, exists) {
  /** @type {MethodGraphIssue[]} */
  const issues = []
  if (!METHOD_RELATION_TYPES.includes(relation?.type)) {
    issues.push({ code: 'method_relation_type_unknown', message: `${JSON.stringify(relation?.type ?? null)} is not one of ${METHOD_RELATION_TYPES.join(', ')}.` })
  }
  if (!relation?.target) {
    issues.push({ code: 'method_relation_target_missing', message: 'A relation names no target.' })
  } else if (exists && !exists(relation.target)) {
    issues.push({ code: 'method_relation_target_unknown', message: `Relation target ${relation.target} is not a known method.` })
  }
  if (typeof relation?.evidence !== 'string' || !relation.evidence.trim()) {
    issues.push({ code: 'method_relation_evidence_missing', message: 'A relation must carry the evidence the analyser used, or the builder is acting on an assertion.' })
  }
  if (typeof relation?.proposedBy !== 'string' || !relation.proposedBy.trim()) {
    issues.push({ code: 'method_relation_unattributed', message: 'A relation must record which job proposed it.' })
  }
  return issues
}

/** Every issue code this module can raise, for the same reason methodSkill has one. */
export const METHOD_GRAPH_ISSUE_CODES = Object.freeze([
  'method_graph_duplicate_name',
  'method_graph_digest_unparsable',
  'method_graph_dangling_dependency',
  'method_graph_digest_moved',
  'method_graph_dependency_not_effective',
  'method_graph_cycle',
  'method_relation_type_unknown',
  'method_relation_target_missing',
  'method_relation_target_unknown',
  'method_relation_evidence_missing',
  'method_relation_unattributed',
])
