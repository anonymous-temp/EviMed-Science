/**
 * Scoring the thirteen verdicts of each patient against the gold, with the intervals that a patient-level resample gives.
 *
 * The gold has two labels, met and not met; the system has three states, and unknown is the one the gold cannot hold. So the
 * same predictions are read in three fixed ways, written down before any score exists:
 *
 * - (a) strict: `unknown` is wrong and stays in the denominator. This is what the product shows and the headline.
 * - (b) the annotators' absent-evidence convention read as a sensitivity: `unknown` is `not met`. This is the reading the
 *   official scorer needs, and the one under which F1 is comparable with published numbers (it is still not like-for-like: see
 *   the README).
 * - (c) as (b) except that, for the two criteria whose annotation rule says an unmentioned criterion is probably met (ENGLISH,
 *   MAKES-DECISIONS: guide, section 4), `unknown` is `met`.
 *
 * A confidence interval is the 2.5th to 97.5th percentile of the statistic over resamples that draw whole patients with
 * replacement, so the thirteen criteria of one patient move together; a statistic that is undefined in more than 5% of the
 * resamples (a rate over a class the sample hardly holds) has no interval.
 *
 * @module n2c2/metrics
 */
import { ABSENT_MEANS_MET, TAGS } from './criteria.mjs';

export const READINGS = Object.freeze(['a', 'b', 'c']);
export const BOOTSTRAP = Object.freeze({ resamples: 2000, seed: 20261101 });

/** @typedef {'satisfied' | 'not_satisfied' | 'unknown'} State */
/** @typedef {'met' | 'not met'} Gold */

const COUNT_KEYS = Object.freeze(['SM', 'SX', 'NM', 'NX', 'UM', 'UX']);

/** A mulberry32 stream: small, seedable and the same on every machine. @param {number} seed */
export function randomStream(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One patient's contribution: for each tag, which cell of (state x gold) the patient falls in.
 * @param {Record<string, State>} states @param {Record<string, Gold>} gold
 * @returns {Record<string, Record<string, number>>}
 */
export function patientCounts(states, gold) {
  /** @type {Record<string, Record<string, number>>} */
  const out = {};
  for (const tag of TAGS) {
    const state = states[tag] ?? 'unknown';
    const label = gold[tag];
    if (label !== 'met' && label !== 'not met') throw new Error(`No gold label for ${tag}.`);
    const code = `${state === 'satisfied' ? 'S' : state === 'not_satisfied' ? 'N' : 'U'}${label === 'met' ? 'M' : 'X'}`;
    out[tag] = Object.fromEntries(COUNT_KEYS.map((key) => [key, key === code ? 1 : 0]));
  }
  return out;
}

/** @param {ReadonlyArray<Record<string, Record<string, number>>>} patients */
export function sumCounts(patients) {
  /** @type {Record<string, Record<string, number>>} */
  const total = Object.fromEntries(TAGS.map((tag) => [tag, Object.fromEntries(COUNT_KEYS.map((key) => [key, 0]))]));
  for (const patient of patients) for (const tag of TAGS) for (const key of COUNT_KEYS) total[tag][key] += patient[tag][key];
  return total;
}

/**
 * The 2x2 table of "predicted met" against "gold met" under a reading. Reading (a) has no such table: unknown is neither.
 * @param {Record<string, number>} c @param {string} tag @param {'b' | 'c'} reading
 */
function table(c, tag, reading) {
  const unknownIsMet = reading === 'c' && ABSENT_MEANS_MET.includes(tag);
  const tp = c.SM + (unknownIsMet ? c.UM : 0);
  const fp = c.SX + (unknownIsMet ? c.UX : 0);
  const fn = c.NM + (unknownIsMet ? 0 : c.UM);
  const tn = c.NX + (unknownIsMet ? 0 : c.UX);
  return { tp, fp, fn, tn };
}

const ratio = (/** @type {number} */ a, /** @type {number} */ b) => (b > 0 ? a / b : NaN);

/** The official scorer's definitions, zero when a ratio has no denominator. */
function f1(/** @type {number} */ tp, /** @type {number} */ fp, /** @type {number} */ fn) {
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  return precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
}

/** The scorer's overall F1 for one 2x2 table: the mean of the F1 of "met" and the F1 of "not met". */
function overallF1(/** @type {{ tp: number, fp: number, fn: number, tn: number }} */ t) {
  return (f1(t.tp, t.fp, t.fn) + f1(t.tn, t.fn, t.fp)) / 2;
}

/**
 * Every statistic as one flat object of numbers (NaN where undefined), keyed `TAG.name` and `ALL.name`.
 * @param {Record<string, Record<string, number>>} counts
 */
export function statistics(counts) {
  /** @type {Record<string, number>} */
  const s = {};
  /** @type {Record<'b' | 'c', { tp: number, fp: number, fn: number, tn: number }>} */
  const pooled = { b: { tp: 0, fp: 0, fn: 0, tn: 0 }, c: { tp: 0, fp: 0, fn: 0, tn: 0 } };
  const all = Object.fromEntries(COUNT_KEYS.map((key) => [key, 0]));
  let correctC = 0;
  let falseMetC = 0;
  /** @type {Record<string, number[]>} */
  const perTag = {};
  const push = (/** @type {string} */ name, /** @type {number} */ value) => { (perTag[name] ??= []).push(value); };
  for (const tag of TAGS) {
    const c = counts[tag];
    const n = COUNT_KEYS.reduce((sum, key) => sum + c[key], 0);
    const goldMet = c.SM + c.NM + c.UM;
    const goldNot = c.SX + c.NX + c.UX;
    const absent = ABSENT_MEANS_MET.includes(tag);
    s[`${tag}.n`] = n;
    s[`${tag}.goldMet`] = goldMet;
    s[`${tag}.accuracyA`] = ratio(c.SM + c.NX, n);
    s[`${tag}.accuracyB`] = ratio(c.SM + c.NX + c.UX, n);
    s[`${tag}.accuracyC`] = ratio(c.SM + c.NX + (absent ? c.UM : c.UX), n);
    s[`${tag}.unknownShare`] = ratio(c.UM + c.UX, n);
    s[`${tag}.metToNotMetExplicit`] = ratio(c.NM, goldMet);
    s[`${tag}.metToNotMetB`] = ratio(c.NM + c.UM, goldMet);
    s[`${tag}.notMetToMet`] = ratio(c.SX, goldNot);
    s[`${tag}.notMetToMetC`] = ratio(c.SX + (absent ? c.UX : 0), goldNot);
    s[`${tag}.f1B`] = overallF1(table(c, tag, 'b'));
    s[`${tag}.f1C`] = overallF1(table(c, tag, 'c'));
    for (const reading of /** @type {const} */ (['b', 'c'])) {
      const t = table(c, tag, reading);
      for (const key of /** @type {const} */ (['tp', 'fp', 'fn', 'tn'])) pooled[reading][key] += t[key];
    }
    for (const key of COUNT_KEYS) all[key] += c[key];
    correctC += c.SM + c.NX + (absent ? c.UM : c.UX);
    falseMetC += c.SX + (absent ? c.UX : 0);
    for (const name of ['accuracyA', 'accuracyB', 'accuracyC', 'unknownShare', 'metToNotMetExplicit', 'metToNotMetB', 'notMetToMet', 'notMetToMetC', 'f1B', 'f1C']) push(name, s[`${tag}.${name}`]);
  }
  const total = COUNT_KEYS.reduce((sum, key) => sum + all[key], 0);
  const allMet = all.SM + all.NM + all.UM;
  const allNot = all.SX + all.NX + all.UX;
  s['ALL.n'] = total;
  s['ALL.accuracyA'] = ratio(all.SM + all.NX, total);
  s['ALL.accuracyB'] = ratio(all.SM + all.NX + all.UX, total);
  s['ALL.accuracyC'] = ratio(correctC, total);
  s['ALL.unknownShare'] = ratio(all.UM + all.UX, total);
  s['ALL.metToNotMetExplicit'] = ratio(all.NM, allMet);
  s['ALL.metToNotMetB'] = ratio(all.NM + all.UM, allMet);
  s['ALL.notMetToMet'] = ratio(all.SX, allNot);
  s['ALL.notMetToMetC'] = ratio(falseMetC, allNot);
  s['ALL.f1MicroB'] = overallF1(pooled.b);
  s['ALL.f1MicroC'] = overallF1(pooled.c);
  s['ALL.f1MacroB'] = mean(TAGS.map((tag) => s[`${tag}.f1B`]));
  s['ALL.f1MacroC'] = mean(TAGS.map((tag) => s[`${tag}.f1C`]));
  for (const name of ['accuracyA', 'accuracyB', 'accuracyC', 'unknownShare', 'metToNotMetExplicit', 'metToNotMetB', 'notMetToMet', 'notMetToMetC']) s[`MACRO.${name}`] = mean(perTag[name]);
  return s;
}

/** The mean of the defined values; NaN when there are none. @param {readonly number[]} values */
function mean(values) {
  const defined = values.filter((value) => Number.isFinite(value));
  return defined.length ? defined.reduce((sum, value) => sum + value, 0) / defined.length : NaN;
}

/** @param {readonly number[]} sorted @param {number} p */
function quantile(sorted, p) {
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/**
 * The statistics of the whole sample, each with a 95% interval from a patient-level cluster bootstrap.
 * @param {ReadonlyArray<Record<string, Record<string, number>>>} patients each from `patientCounts`
 * @param {{ resamples?: number, seed?: number }} [options]
 * @returns {Record<string, { value: number | null, low: number | null, high: number | null }>}
 */
export function summarize(patients, { resamples = BOOTSTRAP.resamples, seed = BOOTSTRAP.seed } = {}) {
  const point = statistics(sumCounts(patients));
  const next = randomStream(seed);
  /** @type {Record<string, number[]>} */
  const draws = {};
  for (let r = 0; r < resamples; r += 1) {
    /** @type {Array<Record<string, Record<string, number>>>} */
    const sample = [];
    for (let i = 0; i < patients.length; i += 1) sample.push(patients[Math.floor(next() * patients.length)]);
    const stats = statistics(sumCounts(sample));
    for (const [name, value] of Object.entries(stats)) if (!name.endsWith('.n') && !name.endsWith('.goldMet')) (draws[name] ??= []).push(value);
  }
  /** @type {Record<string, { value: number | null, low: number | null, high: number | null }>} */
  const out = {};
  for (const [name, value] of Object.entries(point)) {
    const finite = Number.isFinite(value) ? value : null;
    const sample = (draws[name] ?? []).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    const enough = sample.length >= 0.95 * resamples;
    out[name] = { value: finite === null ? null : round(finite), low: enough && finite !== null ? round(quantile(sample, 0.025)) : null, high: enough && finite !== null ? round(quantile(sample, 0.975)) : null };
  }
  return out;
}

/** @param {number} value */
const round = (value) => (Number.isInteger(value) ? value : Math.round(value * 10000) / 10000);

/**
 * Predictions that ignore the note: every patient gets the class most of the training patients have for the tag.
 * @param {ReadonlyArray<Record<string, Gold>>} trainGold
 * @returns {Record<string, State>}
 */
export function majorityStates(trainGold) {
  /** @type {Record<string, State>} */
  const states = {};
  for (const tag of TAGS) {
    const met = trainGold.filter((gold) => gold[tag] === 'met').length;
    states[tag] = met * 2 > trainGold.length ? 'satisfied' : 'not_satisfied';
  }
  return states;
}

/**
 * How a prediction is written for the official scorer: reading (b) or (c) turned into met / not met.
 * @param {Record<string, State>} states @param {'b' | 'c'} reading @returns {Record<string, Gold>}
 */
export function labelsFor(states, reading) {
  /** @type {Record<string, Gold>} */
  const labels = {};
  for (const tag of TAGS) {
    const state = states[tag] ?? 'unknown';
    labels[tag] = state === 'satisfied' ? 'met' : state === 'not_satisfied' ? 'not met' : reading === 'c' && ABSENT_MEANS_MET.includes(tag) ? 'met' : 'not met';
  }
  return labels;
}
