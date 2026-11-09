/**
 * Tier C of the drug effect of the Alzheimer simulation (plan R31, 2026-11-09): an effect prior from evidence the researcher holds, not from a model of
 * the drug. Either an `evidence.pool` result (published studies pooled by the engine) or the researcher's own phase-2 estimate becomes the
 * `{ family, parameters, source, tier }` distribution of `treatment.symptomatic.pointsAt` (or the disease-modifying share) that R25's assurance averages over.
 *
 * Hidden knowledge:
 *
 * - **A historical effect may answer a different question (ICH E9(R1) A.4).** The pooled studies and the phase-2 trial estimated an effect of some
 *   treatment strategy in some population on some endpoint; the new study asks its own. The prior carries the estimand the source answered, in words the
 *   researcher gave, in its `source.note`, and the premise says that it is the source's and may not be this study's. A source that gave none is used and
 *   says so: the missing statement is part of the premise, never a refusal.
 * - **The spread is the one a future trial draws from.** A pooling's prior is its prediction distribution when the engine computed one (k of 3 or more with
 *   heterogeneity, its `basis` says which); otherwise the confidence distribution, and the premise says that the spread of a future trial is then understated.
 *   A phase-2 estimate's spread is its standard error (or the SD its interval implies), and a phase-2 trial's own effect is the optimistic, selected one: the
 *   premise says that too.
 * - **Only an exact reading is executable.** The pooled value must be on the identity scale (a difference in the unit the model runs in, ADAS-cog points) and
 *   a normal distribution; a log or logit pooling is another scale and is refused by name, with every other result kept.
 * - **The numbers are the engine's.** This module copies what the pooling's distribution says; it computes nothing a person could mistake for a result
 *   except the SD of a stated interval.
 *
 * @module @evimed/domain/vcrEffectPrior
 */

import { vcrNormalQuantile } from './vcrExperimentSearch.mjs'

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
/** @param {unknown} value @returns {value is number} */
const finite = (value) => typeof value === 'number' && Number.isFinite(value)

/** The two quantities of the Alzheimer family a prior may be put on. */
export const VCR_EFFECT_PRIOR_TARGETS = Object.freeze(['symptomatic_points', 'disease_modifying_fraction'])

/**
 * Whether a pooling may be put on this target at all (known before the pooling is read): a pooling is a difference in points, so it can only be the
 * symptomatic change.
 * @param {string} target
 * @returns {{ reason: string, detail: string } | null}
 */
export function vcrEffectPriorPoolTargetRefusal(target) {
  if (target !== 'disease_modifying_fraction') return null
  return { reason: 'effect_prior_target_scale', detail: 'A pooling is a difference in points of the score the model runs in, and the disease-modifying target is a share of the decline taken away: no conversion between them is carried. Use the pooling as the symptomatic change (the points at a week), or state a share of your own.' }
}

/**
 * @param {unknown} estimand what the source's effect answers, in the researcher's words (any of the fields)
 * @returns {{ text: string, stated: boolean }}
 */
function estimandText(estimand) {
  if (typeof estimand === 'string' && estimand.trim()) return { text: estimand.trim().slice(0, 300), stated: true }
  if (isObject(estimand)) {
    const parts = [estimand.treatment, estimand.population, estimand.endpoint, estimand.strategy, estimand.summary].filter((x) => typeof x === 'string' && x.trim()).map((x) => String(x).trim())
    if (parts.length) return { text: parts.join('; ').slice(0, 300), stated: true }
  }
  return { text: 'the source did not state which estimand its effect answers', stated: false }
}

/** @param {string} target @param {boolean} stated @param {string} basisWords */
function premiseSentences(target, stated, basisWords) {
  return [
    'The effect is taken from earlier evidence, not from a model of the drug: it says what follows if that evidence transfers to this study, never that the drug works.',
    stated
      ? 'The estimand of the source (the treatment strategy, population and endpoint its effect answers) is the source\'s own and may not be the one this study asks (ICH E9(R1) A.4).'
      : 'The source did not state the estimand its effect answers, so whether it is the one this study asks is not known (ICH E9(R1) A.4).',
    basisWords,
    target === 'disease_modifying_fraction' ? 'A share of the mean decline taken away is read as stated: below 1, and a negative share is a drug that speeds the decline up.' : 'The effect is a difference in points on the scale the model runs in, treated less untreated, negative better.',
  ]
}

/**
 * The effect prior of an `evidence.pool` result.
 * @param {Record<string, any>} result the result as the store holds it: `id`, `diagnostics` with `scale` and `distribution`, `measures`
 * @param {{ target?: string, estimand?: unknown, unit?: string }} [options] `unit` is the unit the pooled studies were on, which must be the model's (default: the result's own measure unit is the scale, so a unit is only checked when stated)
 * @returns {{ ok: true, target: string, distribution: Record<string, any>, estimand: { text: string, stated: boolean }, premises: string[], basis: string } | { ok: false, reason: string, detail: string }}
 */
export function vcrEffectPriorFromPool(result, options = {}) {
  const target = options.target ?? 'symptomatic_points'
  if (!VCR_EFFECT_PRIOR_TARGETS.includes(target)) return { ok: false, reason: 'effect_prior_target_unknown', detail: `target is one of: ${VCR_EFFECT_PRIOR_TARGETS.join(', ')}.` }
  // A pooling of differences in ADAS-cog POINTS is a difference in points; the disease-modifying target is a SHARE of the decline taken away. No
  // conversion between them is carried here (tier B's inversion needs the model, the time point and the people), so a points pooling is never read as
  // a share: it was, once, and a pooled -0.3 +/- 0.5 points became a share of -0.3 +/- 0.5 (review S1).
  const scaleRefusal = vcrEffectPriorPoolTargetRefusal(target)
  if (scaleRefusal) return { ok: false, ...scaleRefusal }
  const diagnostics = isObject(result?.diagnostics) ? result.diagnostics : {}
  const dist = isObject(diagnostics.distribution) ? diagnostics.distribution : null
  if (!result?.id || !dist) return { ok: false, reason: 'effect_prior_not_a_pooling', detail: 'The result is not a pooling of studies that carries the distribution a simulation samples from.' }
  if (diagnostics.scale !== 'identity' || dist.kind !== 'normal') {
    return { ok: false, reason: 'effect_prior_scale_unsupported', detail: `The pooling is on the ${String(diagnostics.scale ?? 'unknown')} scale (${String(dist.kind ?? 'no distribution')}): only a difference on the identity scale, in the unit the model runs in, can be put on the effect of this model.` }
  }
  if (typeof options.unit === 'string' && isObject(diagnostics.endpoint) && typeof diagnostics.endpoint.unit === 'string' && diagnostics.endpoint.unit !== options.unit) {
    return { ok: false, reason: 'effect_prior_unit_mismatch', detail: `The pooled studies are in ${diagnostics.endpoint.unit}, the model runs in ${options.unit}; no conversion is carried.` }
  }
  if (!finite(dist.mean) || !finite(dist.sd) || !(dist.sd > 0)) return { ok: false, reason: 'effect_prior_distribution_invalid', detail: 'The pooling\'s distribution has no finite mean and positive SD.' }
  const estimand = estimandText(options.estimand)
  const prediction = dist.basis === 'prediction'
  const basis = prediction ? 'prediction' : 'confidence'
  const basisWords = prediction
    ? 'The spread is the pooling\'s prediction distribution: what a new study of this kind may show, with the heterogeneity between the pooled studies.'
    : 'The spread is the pooling\'s confidence distribution (too few studies for a prediction interval): the spread of a new study is understated.'
  return {
    ok: true, target, basis, estimand, premises: premiseSentences(target, estimand.stated, basisWords),
    distribution: { family: 'normal', parameters: { mean: dist.mean, sd: dist.sd }, source: { kind: 'model_result', objectRef: String(result.id), note: `pooled studies; estimand: ${estimand.text}`.slice(0, 300) }, tier: 'C' },
  }
}

/**
 * The effect prior of the researcher's own phase-2 estimate (or of any single published estimate): a normal with the estimate as its mean and the SD its
 * standard error, or the interval it states, implies.
 * @param {{ estimate: number, se?: number, lower?: number, upper?: number, level?: number, citation?: string, note?: string, estimand?: unknown, own?: boolean, scale?: 'points' | 'share' }} input `scale` says what the estimate is in: points of the score (the symptomatic target) or a share of the decline (the disease-modifying one)
 * @param {{ target?: string }} [options]
 * @returns {{ ok: true, target: string, distribution: Record<string, any>, estimand: { text: string, stated: boolean }, premises: string[], basis: string } | { ok: false, reason: string, detail: string }}
 */
export function vcrEffectPriorFromEstimate(input, options = {}) {
  const target = options.target ?? 'symptomatic_points'
  if (!VCR_EFFECT_PRIOR_TARGETS.includes(target)) return { ok: false, reason: 'effect_prior_target_unknown', detail: `target is one of: ${VCR_EFFECT_PRIOR_TARGETS.join(', ')}.` }
  if (!isObject(input) || !finite(input.estimate)) return { ok: false, reason: 'effect_prior_estimate_missing', detail: 'The estimate is a finite number.' }
  // the unit of an estimate decides the target: points for the symptomatic change, a share for the disease-modifying one; never one read as the other
  if (target === 'disease_modifying_fraction' && input.scale !== 'share') return { ok: false, reason: 'effect_prior_target_scale', detail: 'The disease-modifying target is a share of the decline taken away: the estimate must say it is a share (scale "share"); an estimate in points is never read as one.' }
  if (target === 'symptomatic_points' && input.scale === 'share') return { ok: false, reason: 'effect_prior_target_scale', detail: 'An estimate that is a share is the disease-modifying target, not a change in points.' }
  /** @type {number} */
  let sd
  /** @type {string} */
  let basis
  if (finite(input.se)) {
    if (!(input.se > 0)) return { ok: false, reason: 'effect_prior_spread_invalid', detail: 'The standard error is positive.' }
    sd = input.se; basis = 'standard error'
  } else if (finite(input.lower) && finite(input.upper)) {
    const level = finite(input.level) ? input.level : 0.95
    if (!(input.upper > input.lower) || !(level > 0 && level < 1)) return { ok: false, reason: 'effect_prior_spread_invalid', detail: 'The interval has its lower end below its upper end, at a level between 0 and 1.' }
    sd = (input.upper - input.lower) / (2 * vcrNormalQuantile(1 - (1 - level) / 2)); basis = `the ${level * 100}% interval`
  } else return { ok: false, reason: 'effect_prior_spread_missing', detail: 'A standard error, or the lower and upper ends of an interval, is needed: no spread is guessed.' }
  const estimand = estimandText(input.estimand)
  const own = input.own === true
  const note = `${own ? 'the researcher\'s own phase-2 estimate' : 'a published estimate'}; estimand: ${estimand.text}`.slice(0, 300)
  const cited = typeof input.citation === 'string' && input.citation.trim()
  return {
    ok: true, target, basis, estimand,
    premises: premiseSentences(target, estimand.stated, `The spread is from ${basis} of one estimate${own ? ', and a phase-2 trial that was followed up is often the optimistic, selected one' : ''}.`),
    distribution: { family: 'normal', parameters: { mean: input.estimate, sd }, source: cited ? { kind: 'literature', citation: String(input.citation).trim().slice(0, 300), note } : { kind: 'stated', note }, tier: 'C' },
  }
}
