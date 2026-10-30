/**
 * The capability-skill campaign over recorded production runs (2026-10-28). A candidate is a personal skill (title,
 * description, instructions) mounted on the account its arm runs under; the baseline arm runs with no personal skill and
 * everything else equal. The runs themselves happen on production (one lane, automated, a throwaway account per arm);
 * what reaches the lab is each run's final answer and its settled cost, and the scoring here is deterministic code over
 * those records — so a stage re-run gives the same bytes, while the measurement it scores was paid for and is stochastic,
 * which is why the statistics treat it as a paid paired-t family with repeats (deterministicConsumer: false).
 *
 * The task family is MedCalc-Bench (ncbi-nlp/MedCalc-Bench test set): a patient note and a calculator question with a
 * gold value; correctness follows the benchmark's own evaluate.py (dates exact, integers after rounding, decimals inside
 * the row's lower/upper limits, gestational age as (weeks, days)). The sampling unit is the test row: rows are separate
 * patient notes, and the three repeats of a row are averaged inside its group.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
export const SKILL_ARMS_SCHEMA = 1;
export const SKILL_BASELINE_ARM = 'baseline';

/** Calculator ids by output type, as evaluate.py lists them. */
const DATE_IDS = new Set([13, 68]);
const WEEKS_DAYS_IDS = new Set([69]);
const INTEGER_IDS = new Set([4, 15, 16, 17, 18, 20, 21, 25, 27, 28, 29, 32, 33, 36, 43, 45, 48, 51]);
const DECIMAL_IDS = new Set([2, 3, 5, 6, 7, 8, 9, 10, 11, 19, 22, 23, 24, 26, 30, 31, 38, 39, 40, 44, 46, 49, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67]);

/** The consumer as the evaluator pins it: this file. */
export async function skillCampaignConsumerIdentity() {
  const components = [{ path: 'evals/rsi-campaigns/skill_campaign.mjs', sha256: sha(readFileSync(new URL('./skill_campaign.mjs', import.meta.url))) }];
  return { revision: 'skill-arms-v1', components, implementationSha256: sha(JSON.stringify(components)) };
}

/**
 * The value a free-text answer states: the last line carrying 「最终答案」 or "Final answer", else the last line of the
 * answer. Markdown emphasis and a trailing unit are dropped; what is left is parsed by the row's output type.
 * @param {string | null} text @returns {string | null}
 */
export function statedAnswer(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const lines = text.split(/\r?\n/).map((line) => line.replace(/[*_`#>]/g, '').trim()).filter(Boolean);
  const marked = lines.filter((line) => /最终答案|final\s*answer/i.test(line));
  const line = (marked.at(-1) ?? lines.at(-1) ?? '').replace(/^.*?(最终答案|final\s*answer)\s*[:：]?\s*/i, '');
  return line.trim() || null;
}

const firstNumber = (text) => {
  const match = String(text).replace(/,(?=\d{3}\b)/g, '').match(/-?\d+(?:\.\d+)?(?:e-?\d+)?/i);
  return match ? Number(match[0]) : null;
};

/**
 * evaluate.py's check_correctness over a stated answer. An answer that cannot be read as the row's type is wrong, as a
 * failed eval() is in the original harness.
 * @param {string | null} answerText the run's final answer (free text)
 * @param {{ calculatorId: number, gold: { answer: string, lower: string | null, upper: string | null } }} row
 * @returns {0 | 1}
 */
export function medcalcCorrect(answerText, row) {
  const stated = statedAnswer(answerText);
  if (stated === null) return 0;
  const id = Number(row.calculatorId);
  if (DATE_IDS.has(id)) {
    const date = (value) => { const m = String(value).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/); return m ? `${Number(m[1])}/${Number(m[2])}/${m[3]}` : null; };
    const got = date(stated);
    return got !== null && got === date(row.gold.answer) ? 1 : 0;
  }
  if (WEEKS_DAYS_IDS.has(id)) {
    const pair = (value) => { const m = String(value).match(/\(?["']?(\d+)\s*(?:weeks?|周)?["']?,?\s*["']?(\d+)\s*(?:days?|天)?["']?\s*\)?/i); return m ? `${Number(m[1])},${Number(m[2])}` : null; };
    const got = pair(stated);
    return got !== null && got === pair(row.gold.answer) ? 1 : 0;
  }
  const value = firstNumber(stated);
  if (value === null || !Number.isFinite(value)) return 0;
  if (INTEGER_IDS.has(id)) return Math.round(value) === Math.round(Number(row.gold.answer)) ? 1 : 0;
  if (DECIMAL_IDS.has(id)) {
    const lower = Number(row.gold.lower), upper = Number(row.gold.upper);
    if (!Number.isFinite(lower) || !Number.isFinite(upper)) return 0;
    return value >= lower && value <= upper ? 1 : 0;
  }
  throw new Error(`unknown calculator id ${id}`);
}

/** @param {any} source @returns {string[]} */
export function skillArmsIssues(source) {
  if (!source || source.kind !== 'skill-arms' || source.schema !== SKILL_ARMS_SCHEMA || source.benchmark !== 'medcalc-bench') return ['skill_arms_invalid'];
  const issues = [];
  const rows = Array.isArray(source.rows) ? source.rows : [];
  const rowIds = new Set(rows.map((row) => String(row?.id)));
  if (!rows.length || rowIds.size !== rows.length) issues.push('skill_arms_rows_invalid');
  for (const row of rows) {
    const id = Number(row?.calculatorId);
    if (!(DATE_IDS.has(id) || WEEKS_DAYS_IDS.has(id) || INTEGER_IDS.has(id) || DECIMAL_IDS.has(id)) || typeof row?.gold?.answer !== 'string') { issues.push('skill_arms_rows_invalid'); break; }
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

/** Per arm: every row's mean correctness over its repeats, overall and over the registered failure slice. */
function armScores(source, failureCalculators) {
  const slice = new Set(failureCalculators.map(Number));
  const byRow = new Map(source.rows.map((row) => [String(row.id), row]));
  const scores = {};
  for (const arm of Object.keys(source.arms)) {
    const perRow = new Map();
    for (const run of source.runs.filter((entry) => entry.arm === arm)) {
      const row = byRow.get(String(run.row));
      perRow.set(String(run.row), (perRow.get(String(run.row)) ?? 0) + medcalcCorrect(run.status === 'succeeded' ? run.answer : null, row) / source.repeats);
    }
    const mean = (ids) => ids.length ? ids.reduce((sum, id) => sum + perRow.get(id), 0) / ids.length : null;
    const all = [...perRow.keys()].sort(), sliced = all.filter((id) => slice.has(Number(byRow.get(id).calculatorId)));
    scores[arm] = { overall: mean(all), slice: mean(sliced), rows: all.length, sliceRows: sliced.length, perRow: Object.fromEntries([...perRow].sort()) };
  }
  return scores;
}

/**
 * Development: the candidate with the largest failure-slice gain over the baseline among those whose overall accuracy is
 * not below the baseline by more than the registered margin; ties go to the shorter skill, then the id. No candidate with
 * a positive slice gain ends the campaign.
 */
export function chooseSkillCandidate(source, registration) {
  const scores = armScores(source, registration.failureCalculators);
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
 * row's group; quality is its correctness. Costs are not read here: the evaluator attests them from the same records.
 */
export function skillObservations(source, registration, frozen) {
  const arms = Object.keys(source.arms).sort();
  if (arms.length !== 2 || !arms.includes(SKILL_BASELINE_ARM) || !arms.includes(frozen.arm) || source.arms[frozen.arm].skill.digest !== frozen.skillDigest) {
    return { observations: [], reason: 'campaign_confirmation_candidate_mismatch' };
  }
  const byRow = new Map(source.rows.map((row) => [String(row.id), row]));
  const observations = source.runs.map((run) => ({
    group: `row-${run.row}`, arm: run.arm === SKILL_BASELINE_ARM ? 'baseline' : 'candidate', form: 'answer', repeat: run.repeat,
    status: 'measured', quality: medcalcCorrect(run.status === 'succeeded' ? run.answer : null, byRow.get(String(run.row))), critical_violations: 0,
  })).sort((a, b) => a.group.localeCompare(b.group) || a.arm.localeCompare(b.arm) || a.repeat - b.repeat);
  const scores = armScores(source, registration.failureCalculators);
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
