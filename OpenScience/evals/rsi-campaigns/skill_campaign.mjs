/**
 * The capability-skill campaign over recorded production runs (2026-10-28). A candidate is a personal skill (title,
 * description, instructions) mounted on the account its arm runs under; the baseline arm runs with no personal skill and
 * everything else equal. The runs themselves happen on production (one lane, automated, a throwaway account per arm);
 * what reaches the lab is each run's final answer and its settled cost, and the scoring here is deterministic code over
 * those records — so a stage re-run gives the same bytes, while the measurement it scores was paid for and is stochastic,
 * which is why the statistics treat it as a paid paired-t family with repeats (deterministicConsumer: false).
 *
 * What scores a run is the registration's `scorer`, an id of the closed registry in skill_scorers.mjs (2026-10-31; absent
 * means `medcalc`, the task family this consumer began with: MedCalc-Bench rows scored by the benchmark's own evaluate.py).
 * The sampling unit is the row: rows are separate tasks, and the repeats of a row are averaged inside its group. The scorer
 * id is part of the consumer identity, so what a registration pinned is the scorer it named.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { SKILL_SCORERS, skillScorer } from './skill_scorers.mjs';

export { medcalcCorrect, statedAnswer } from './skill_scorers.mjs';
export { SKILL_SCORERS, skillScorer };

const sha = (value) => createHash('sha256').update(value).digest('hex');
export const SKILL_ARMS_SCHEMA = 1;
export const SKILL_BASELINE_ARM = 'baseline';

/**
 * The consumer as the evaluator pins it: this file, the scorers file and the scorer the registration names. A registration
 * that names no scorer is `medcalc`; one that names an id outside the registry has no identity (`campaign_scorer_not_qualified`).
 * @param {any} [registration]
 */
export async function skillCampaignConsumerIdentity(registration) {
  const scorer = skillScorer(registration);
  if (!scorer) throw new Error('campaign_scorer_not_qualified');
  const components = ['skill_campaign.mjs', 'skill_scorers.mjs'].map((name) => ({ path: `evals/rsi-campaigns/${name}`, sha256: sha(readFileSync(new URL(`./${name}`, import.meta.url))) }));
  return { revision: 'skill-arms-v2', scorer: scorer.id, components, implementationSha256: sha(JSON.stringify({ scorer: scorer.id, components })) };
}

/**
 * What a recorded-arms source must be for the scorer its registration names (`medcalc` when it names none).
 * @param {any} source @param {any} [registration] @returns {string[]}
 */
export function skillArmsIssues(source, registration) {
  const scorer = skillScorer(registration);
  if (!scorer || !source || source.kind !== 'skill-arms' || source.schema !== SKILL_ARMS_SCHEMA || source.benchmark !== scorer.benchmark) return ['skill_arms_invalid'];
  const issues = [];
  const rows = Array.isArray(source.rows) ? source.rows : [];
  const rowIds = new Set(rows.map((row) => String(row?.id)));
  if (!rows.length || rowIds.size !== rows.length) issues.push('skill_arms_rows_invalid');
  for (const row of rows) {
    if (!scorer.validRow(row)) { issues.push('skill_arms_rows_invalid'); break; }
  }
  const arms = source.arms && typeof source.arms === 'object' ? source.arms : {};
  if (!Object.hasOwn(arms, SKILL_BASELINE_ARM) || arms[SKILL_BASELINE_ARM]?.skill !== null) issues.push('skill_arms_baseline_missing');
  for (const [id, arm] of Object.entries(arms)) {
    if (id === SKILL_BASELINE_ARM) continue;
    if (!/^cand-[a-f0-9]{12}$/.test(id) || !/^[a-f0-9]{64}$/.test(arm?.skill?.digest ?? '') || id !== `cand-${arm.skill.digest.slice(0, 12)}` || !Number.isInteger(arm.skill.chars)) { issues.push('skill_arms_candidate_invalid'); break; }
  }
  const repeats = source.repeats;
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) issues.push('skill_arms_repeats_invalid');
  const seen = new Set();
  for (const run of Array.isArray(source.runs) ? source.runs : []) {
    const key = `${run?.row}\0${run?.arm}\0${run?.repeat}`;
    if (!rowIds.has(String(run?.row)) || !Object.hasOwn(arms, run?.arm) || !Number.isInteger(run?.repeat) || run.repeat < 0 || run.repeat >= repeats || seen.has(key)) { issues.push('skill_arms_runs_invalid'); break; }
    if (typeof run.runId !== 'string' || typeof run.status !== 'string' || !(run.answer === null || typeof run.answer === 'string')) { issues.push('skill_arms_runs_invalid'); break; }
    if (!(run.cost === null || (Number.isFinite(run.cost) && run.cost >= 0))) { issues.push('skill_arms_runs_invalid'); break; }
    seen.add(key);
  }
  if (!issues.length && seen.size !== rows.length * Object.keys(arms).length * repeats) issues.push('skill_arms_runs_incomplete');
  return issues;
}

/** The failure slice a registration names for its scorer, as the keys rows are matched by (calculator ids for medcalc, strata otherwise). */
export const skillSlice = (registration, scorer) => new Set((registration[scorer.slice.registration] ?? []).map(scorer.slice.key));
/** Whether a row is in that slice. */
export const inSkillSlice = (slice, scorer, row) => slice.has(scorer.slice.key(row[scorer.slice.row]));

/** Per arm: every row's mean score over its repeats, overall and over the registered failure slice. */
function armScores(source, registration) {
  const scorer = /** @type {NonNullable<ReturnType<typeof skillScorer>>} */ (skillScorer(registration));
  const slice = skillSlice(registration, scorer);
  const byRow = new Map(source.rows.map((row) => [String(row.id), row]));
  const scores = {};
  for (const arm of Object.keys(source.arms)) {
    const perRow = new Map();
    for (const run of source.runs.filter((entry) => entry.arm === arm)) {
      const row = byRow.get(String(run.row));
      perRow.set(String(run.row), (perRow.get(String(run.row)) ?? 0) + scorer.score(run.status === 'succeeded' ? run.answer : null, row) / source.repeats);
    }
    const mean = (ids) => ids.length ? ids.reduce((sum, id) => sum + perRow.get(id), 0) / ids.length : null;
    const all = [...perRow.keys()].sort(), sliced = all.filter((id) => inSkillSlice(slice, scorer, byRow.get(id)));
    scores[arm] = { overall: mean(all), slice: mean(sliced), rows: all.length, sliceRows: sliced.length, perRow: Object.fromEntries([...perRow].sort()) };
  }
  return scores;
}

/**
 * Development: the candidate with the largest failure-slice gain over the baseline among those whose overall score is
 * not below the baseline by more than the registered margin; ties go to the shorter skill, then the id. No candidate with
 * a positive slice gain ends the campaign.
 */
export function chooseSkillCandidate(source, registration) {
  const scores = armScores(source, registration);
  const base = scores[SKILL_BASELINE_ARM];
  const candidates = Object.keys(source.arms).filter((arm) => arm !== SKILL_BASELINE_ARM).sort().map((arm) => ({
    arm, skillDigest: source.arms[arm].skill.digest, chars: source.arms[arm].skill.chars,
    overallDifference: scores[arm].overall - base.overall,
    sliceDifference: base.slice === null || scores[arm].slice === null ? null : scores[arm].slice - base.slice,
  }));
  const eligible = candidates.filter((c) => c.sliceDifference !== null && c.sliceDifference > 0 && c.overallDifference >= -registration.margin);
  eligible.sort((a, b) => b.sliceDifference - a.sliceDifference || a.chars - b.chars || a.arm.localeCompare(b.arm));
  const winner = eligible[0];
  return { scores, candidates, frozen: winner ? { arm: winner.arm, skillDigest: winner.skillDigest } : null, reason: winner ? null : 'campaign_no_improving_candidate' };
}

/**
 * Confirmation: the frozen candidate and the baseline only, every row × arm × repeat. Each run is one observation of its
 * row's group; quality is its score. Costs are not read here: the evaluator attests them from the same records.
 */
export function skillObservations(source, registration, frozen) {
  const arms = Object.keys(source.arms).sort();
  if (arms.length !== 2 || !arms.includes(SKILL_BASELINE_ARM) || !arms.includes(frozen.arm) || source.arms[frozen.arm].skill.digest !== frozen.skillDigest) {
    return { observations: [], reason: 'campaign_confirmation_candidate_mismatch' };
  }
  const scorer = /** @type {NonNullable<ReturnType<typeof skillScorer>>} */ (skillScorer(registration));
  const byRow = new Map(source.rows.map((row) => [String(row.id), row]));
  const observations = source.runs.map((run) => ({
    group: `row-${run.row}`, arm: run.arm === SKILL_BASELINE_ARM ? 'baseline' : 'candidate', form: 'answer', repeat: run.repeat,
    status: 'measured', quality: scorer.score(run.status === 'succeeded' ? run.answer : null, byRow.get(String(run.row))), critical_violations: 0,
  })).sort((a, b) => a.group.localeCompare(b.group) || a.arm.localeCompare(b.arm) || a.repeat - b.repeat);
  const scores = armScores(source, registration);
  return { observations, scores, reason: null };
}

/** The settled cost of every confirmation observation, keyed as the runner keys it; null where any run lacks one. */
export function skillObservationCosts(source, frozen) {
  const rows = [];
  for (const run of source.runs) {
    if (!Number.isFinite(run.cost)) return null;
    rows.push({ group: `row-${run.row}`, arm: run.arm === SKILL_BASELINE_ARM ? 'baseline' : 'candidate', form: 'answer', repeat: run.repeat, cost: run.cost, runId: run.runId });
  }
  if (!Object.hasOwn(source.arms, frozen.arm)) return null;
  return rows.sort((a, b) => a.group.localeCompare(b.group) || a.arm.localeCompare(b.arm) || a.repeat - b.repeat);
}
