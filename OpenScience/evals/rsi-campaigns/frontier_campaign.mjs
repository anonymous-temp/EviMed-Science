/**
 * The frontier-selection campaign over whole days (2026-10-26 review). One source is a run of days exported by
 * `scripts/ops/rsi-frontier-export.mjs`, each replayed by production's own selector from the state before its mix, plus
 * labels frozen before confirmation. The sampling unit is the day: `frontierMixSelect` shares one day's size, group
 * shares, language target and event picks across sources, so rows and sources inside a day are not independent, while
 * days are (each day is selected on its own, from its own pool). The endpoint is the same in development and confirmation:
 * a day's weighted accuracy over its labelled set, a pick-labelled row weighing `pickWeight` (a missed pick costs the reader
 * more than an extra adequate item), on a set fixed before any label is read — the rows above the band floor plus every
 * row the baseline or any registered threshold selects — so the measured set never depends on which candidate wins.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { replayFrontierPool, frontierConsumerIdentity } from './frontier_selection.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
export const FRONTIER_DAYS_SCHEMA = 1;
export const FRONTIER_WORTH = Object.freeze(['pick', 'ok', 'no']);

/** The consumer as the evaluator pins it: production's selector files and this adapter. */
export async function frontierCampaignConsumerIdentity() {
  const base = await frontierConsumerIdentity();
  const own = ['./frontier_campaign.mjs', './frontier_selection.mjs'].map((path) => ({ path: `evals/rsi-campaigns/${path.slice(2)}`, sha256: sha(readFileSync(new URL(path, import.meta.url))) }));
  const components = [...base.components, ...own];
  return { revision: base.revision, selectorSha256: base.implementationSha256, components, implementationSha256: sha(JSON.stringify(components)) };
}

/** @param {any} source @returns {string[]} */
export function frontierDaysIssues(source) {
  const issues = [];
  if (!source || source.kind !== 'frontier-days' || source.schema !== FRONTIER_DAYS_SCHEMA) return ['frontier_days_invalid'];
  if (!Array.isArray(source.days) || !source.days.length) issues.push('frontier_days_empty');
  const days = (source.days ?? []).map((day) => day?.day);
  if (new Set(days).size !== days.length || days.some((day) => typeof day !== 'string')) issues.push('frontier_days_duplicate');
  if (!Array.isArray(source.labels)) issues.push('frontier_labels_missing');
  const ids = new Set();
  for (const label of source.labels ?? []) {
    if (!label || typeof label.id !== 'string' || ids.has(label.id) || !(label.worth === null || FRONTIER_WORTH.includes(label.worth))) { issues.push('frontier_labels_invalid'); break; }
    ids.add(label.id);
  }
  const band = source.band;
  if (!band || !Number.isFinite(band.floor) || !Number.isFinite(band.pickWeight) || band.pickWeight < 1 || band.pickWeight > 10) issues.push('frontier_band_invalid');
  return [...new Set(issues)];
}

/** Every threshold's selection of one day; a day whose pool truth is incomplete makes the whole source ineligible. */
function replayDay(day, thresholds) {
  const runs = new Map();
  for (const threshold of thresholds) {
    const run = replayFrontierPool(day, threshold);
    if (!run.eligible) return { eligible: false, missing: run.missing.slice(0, 20) };
    runs.set(threshold, new Set(run.selectedIds.map(String)));
  }
  return { eligible: true, runs };
}

/** The day's labelled set, fixed by the registration and the replays alone (never by labels or by the winner). */
export function frontierLabelSet(day, replays, floor) {
  const set = new Set();
  for (const row of day.rows) {
    const score = row.score_total == null || !row.score_version ? null : Number(row.score_total);
    if (row.safety_alert === true || (score !== null && score >= floor)) set.add(String(row.id));
  }
  for (const selected of replays.values()) for (const id of selected) set.add(id);
  return set;
}

/**
 * The rows a labeller must label before any campaign stage runs: each day's labelled set, from replays alone.
 * @param {any[]} days @param {{baselineThreshold:number, thresholds:number[]}} registration @param {number} floor
 */
export function frontierLabelPlan(days, registration, floor) {
  const thresholds = [...new Set([registration.baselineThreshold, ...registration.thresholds])];
  const plan = [];
  for (const day of days) {
    const replay = replayDay(day, thresholds);
    if (!replay.eligible) return { eligible: false, day: day.day, missing: replay.missing };
    plan.push({ day: day.day, ids: [...frontierLabelSet(day, replay.runs, floor)].sort() });
  }
  return { eligible: true, days: plan, ids: [...new Set(plan.flatMap((day) => day.ids))].sort() };
}

function dayQuality(labelled, selected, pickWeight) {
  let weight = 0, correct = 0, picks = 0, missed = 0, extra = 0;
  for (const [id, worth] of labelled) {
    const w = worth === 'pick' ? pickWeight : 1;
    const chosen = selected.has(id);
    weight += w;
    if (chosen === (worth === 'pick')) correct += w;
    if (worth === 'pick') { picks += 1; if (!chosen) missed += 1; } else if (chosen) extra += 1;
  }
  return { quality: weight ? correct / weight : null, labelled: labelled.size, picks, missed, extra };
}

/**
 * Replays every registered threshold on every day, the labelled sets and each day's endpoint per measured threshold.
 * @param {any} source @param {{baselineThreshold:number, thresholds:number[], labelThresholds?:number[], minLabelled?:number}} registration
 */
export function evaluateFrontierDays(source, registration) {
  const issues = frontierDaysIssues(source);
  if (issues.length) return { eligible: false, issues };
  const thresholds = [...new Set([registration.baselineThreshold, ...registration.thresholds])].sort((a, b) => a - b);
  // The labelled set is always the whole registered grid's, whichever arms are measured (confirmation measures two).
  const replayed = [...new Set([...thresholds, ...(registration.labelThresholds ?? [])])].sort((a, b) => a - b);
  if (replayed.some((t) => !Number.isFinite(t))) return { eligible: false, issues: ['frontier_thresholds_invalid'] };
  const labels = new Map(source.labels.map((label) => [label.id, label.worth]));
  const minLabelled = Number.isInteger(registration.minLabelled) ? registration.minLabelled : 20;
  const days = [];
  for (const day of [...source.days].sort((a, b) => a.day.localeCompare(b.day))) {
    const replay = replayDay(day, replayed);
    if (!replay.eligible) return { eligible: false, issues: ['frontier_day_pool_incomplete'], day: day.day, missing: replay.missing };
    const set = frontierLabelSet(day, replay.runs, source.band.floor);
    const labelled = new Map([...set].filter((id) => FRONTIER_WORTH.includes(labels.get(id))).map((id) => [id, labels.get(id)]));
    const safety = new Set(day.rows.filter((row) => row.safety_alert === true).map((row) => String(row.id)));
    const production = new Set(day.rows.filter((row) => row.production_selected === true).map((row) => String(row.id)));
    const baseline = replay.runs.get(registration.baselineThreshold);
    const fidelity = baseline.size + production.size ? [...baseline].filter((id) => production.has(id)).length / new Set([...baseline, ...production]).size : 1;
    const arms = Object.fromEntries(thresholds.map((t) => {
      const selected = replay.runs.get(t);
      const q = dayQuality(labelled, selected, source.band.pickWeight);
      const lostSafety = [...safety].filter((id) => baseline.has(id) && !selected.has(id));
      return [String(t), { ...q, selected: selected.size, lostSafety, selectedDigest: sha(JSON.stringify([...selected].sort())) }];
    }));
    days.push({ day: day.day, labelSet: set.size, labelled: labelled.size, abstained: set.size - labelled.size, measured: labelled.size >= minLabelled,
      replayFidelity: fidelity, productionSelected: production.size, arms });
  }
  return { eligible: true, issues: [], thresholds, days, labelsDigest: sha(JSON.stringify(source.labels)) };
}

/**
 * Development: the registered threshold with the highest mean day difference over the baseline, among those that lose no
 * safety pick and select at most `maxVolumeRatio` of the baseline's volume; ties go to the threshold nearest the baseline.
 * No positive mean difference freezes nothing.
 */
export function chooseFrontierCandidate(evaluation, registration) {
  if (!evaluation.eligible) return { frozen: null, reason: 'campaign_consumer_failed', candidates: [] };
  const base = String(registration.baselineThreshold), maxVolume = registration.maxVolumeRatio ?? 1.1;
  const measured = evaluation.days.filter((day) => day.measured);
  const candidates = registration.thresholds.filter((t) => t !== registration.baselineThreshold).map((t) => {
    const key = String(t);
    const differences = measured.map((day) => day.arms[key].quality - day.arms[base].quality);
    const volume = evaluation.days.reduce((sum, day) => sum + day.arms[key].selected, 0) / Math.max(1, evaluation.days.reduce((sum, day) => sum + day.arms[base].selected, 0));
    const lostSafety = evaluation.days.reduce((sum, day) => sum + day.arms[key].lostSafety.length, 0);
    const mean = differences.length ? differences.reduce((a, b) => a + b, 0) / differences.length : null;
    return { threshold: t, days: differences.length, meanDifference: mean, volumeRatio: volume, lostSafety,
      eligible: mean !== null && lostSafety === 0 && volume <= maxVolume };
  });
  const eligible = candidates.filter((c) => c.eligible && c.meanDifference > 0)
    .sort((a, b) => b.meanDifference - a.meanDifference || Math.abs(a.threshold - registration.baselineThreshold) - Math.abs(b.threshold - registration.baselineThreshold) || a.threshold - b.threshold);
  return eligible.length ? { frozen: { threshold: eligible[0].threshold }, reason: null, candidates } : { frozen: null, reason: 'campaign_no_improving_candidate', candidates };
}

/**
 * Confirmation observations for the registered statistics: one group per registered day, quality from the frozen labels,
 * zero model cost for both arms (selection is code), the candidate's lost safety picks as its critical violations.
 */
export function frontierObservations(evaluation, registration, frozenThreshold) {
  if (!evaluation.eligible) return { observations: null, reason: 'campaign_consumer_failed' };
  const base = String(registration.baselineThreshold), candidate = String(frozenThreshold);
  const byDay = new Map(evaluation.days.map((day) => [day.day, day]));
  const observations = [];
  for (const group of registration.statistics.groups) {
    const day = byDay.get(group.day);
    if (!day || !day.measured || !day.arms[candidate]) return { observations: null, reason: 'campaign_source_group_registration_invalid' };
    for (const [arm, key] of [['baseline', base], ['candidate', candidate]]) {
      observations.push({ group: group.id, arm, form: 'original', repeat: 0, quality: day.arms[key].quality, cost: 0,
        critical_violations: arm === 'candidate' ? day.arms[key].lostSafety.length : 0, status: 'measured' });
    }
  }
  const volume = evaluation.days.reduce((sum, day) => sum + day.arms[candidate].selected, 0) / Math.max(1, evaluation.days.reduce((sum, day) => sum + day.arms[base].selected, 0));
  return { observations, volumeRatio: volume, reason: null };
}
