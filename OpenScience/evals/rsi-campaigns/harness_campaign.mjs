/**
 * The harness-patch campaign over recorded lane runs (2026-11-01). A candidate is a patch of the runtime image: a guidance
 * supplement and a few skills (`{guidanceSupplement, skills: [{name, description, body}]}`) applied to the image the baseline
 * ran on. The arms ran on a lane stack (the baseline on the unmodified image, each candidate on a delta image, the control on
 * the unmodified image again); what reaches the lab is each run's final answer and settled cost, and the scoring here is
 * deterministic code over those records — or, for a judged family, over digested verdict records a judge outside the solver's
 * family wrote. A stage re-runs to the same bytes; the measurement it scores was paid for and is stochastic, which is why the
 * statistics treat it as a paid paired-t family with repeats (deterministicConsumer: false), exactly as capability-skill does.
 *
 * What differs from skill_campaign.mjs:
 *  - the candidate: `arms[id].harness = {digest, chars, alwaysOnChars, title, bundle}`, `digest` over the canonical JSON of the
 *    bundle AND the image identity it was measured on (`harnessPatchDigest`), recomputed here from the bundle; the always-on
 *    growth (guidance + skill names and descriptions) is capped;
 *  - the scorer table is harness_scorers.mjs (the skill table plus `mbc-normalized` and `judged-verdicts`);
 *  - an A/A control arm (`aa`, the unmodified image run a second time) is part of every development source: it can never be
 *    chosen, and a candidate has to beat its apparent difference from the baseline (the noise floor) to be eligible;
 *  - sources carry their role; the choice reads a development source only and the confirmation scoring a confirmation source
 *    only, and a confirmation source is exported without gold or verdict scores (the lab's sealed assembly adds them);
 *  - a run's status must be a delivery outcome (succeeded, failed, timeout): an infrastructure failure is never scored, the
 *    source is refused as not a measurement.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { canonicalRsiJson } from '../../apps/server/src/rsiCampaignBundle.mjs';
import { inSkillSlice, skillSlice } from './skill_campaign.mjs';
import { harnessScorer, scorerBenchmarks } from './harness_scorers.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
export const HARNESS_ARMS_SCHEMA = 1;
export const HARNESS_BASELINE_ARM = 'baseline';
export const HARNESS_CONTROL_ARM = 'aa';
/** The cost identity of runs that happened on a lane stack: settled CNY per run from that stack's own usage ledger, exported with the runs. */
export const HARNESS_COST_IDENTITY = 'lane-usage-ledger-settled-cny';
/** Always-on text a candidate may add to every session: the guidance supplement plus each skill's name and description (bodies load on demand). */
export const HARNESS_ALWAYS_ON_MAX_CHARS = 4000;
/** What a run may end in for the solver: delivery outcomes. Anything else is infrastructure and never a measurement. */
export const HARNESS_RUN_STATUSES = Object.freeze(['succeeded', 'failed', 'timeout']);
/** The registered choice rule, as the registration must state it. */
export const HARNESS_SELECTION = Object.freeze({ objective: 'failure-slice-gain', tieBreak: 'smaller-always-on-growth', noiseControl: 'aa-floor' });
/** statistics.py bounds a targeted repair's cost at 1.1x the baseline's; a registration cannot ask for another ratio. */
export const HARNESS_COST_RATIO = 1.1;

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string';
const keysWithin = (value, allowed) => record(value) && Object.keys(value).every((key) => allowed.includes(key));
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

// ---------------------------------------------------------------------------------------------------------------- candidate

/**
 * The bundle in its canonical form (skills sorted by name), or null when it is not one: exactly the keys guidanceSupplement and
 * skills, skill names `^[a-z0-9][a-z0-9-]{0,63}$` and unique, no other keys, not both empty.
 * @param {any} bundle
 */
export function normalizeHarnessBundle(bundle) {
  if (!keysWithin(bundle, ['guidanceSupplement', 'skills']) || !isText(bundle.guidanceSupplement) || !Array.isArray(bundle.skills) || bundle.skills.length > 32) return null;
  const skills = [];
  for (const skill of bundle.skills) {
    if (!keysWithin(skill, ['name', 'description', 'body']) || !SKILL_NAME.test(skill.name ?? '') || !isText(skill.description) || !isText(skill.body)) return null;
    skills.push({ name: skill.name, description: skill.description, body: skill.body });
  }
  if (new Set(skills.map((skill) => skill.name)).size !== skills.length || (bundle.guidanceSupplement === '' && !skills.length)) return null;
  skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { guidanceSupplement: bundle.guidanceSupplement, skills };
}

/** An image identity: `{id: identifier, digest: 64 hex}`. @param {any} image */
export const harnessImageValid = (image) => keysWithin(image, ['id', 'digest']) && IDENTIFIER.test(image.id ?? '') && HEX64.test(image.digest ?? '');

/**
 * sha256 of the RFC 8785 canonical JSON of the bundle and the image identity it was measured on. The same patch on another
 * image is another candidate.
 * @param {any} bundle @param {any} image @returns {string}
 */
export function harnessPatchDigest(bundle, image) {
  const normal = normalizeHarnessBundle(bundle);
  if (!normal || !harnessImageValid(image)) throw new Error('harness_bundle_invalid');
  return sha(canonicalRsiJson({ guidanceSupplement: normal.guidanceSupplement, image: { digest: image.digest, id: image.id }, skills: normal.skills }));
}

/** Sizes in UTF-16 code units (`.length`): `chars` of everything, `alwaysOnChars` of what every session carries. @param {any} bundle */
export function harnessPatchSizes(bundle) {
  const normal = normalizeHarnessBundle(bundle);
  if (!normal) throw new Error('harness_bundle_invalid');
  const alwaysOnChars = normal.guidanceSupplement.length + normal.skills.reduce((total, skill) => total + skill.name.length + skill.description.length, 0);
  return { chars: alwaysOnChars + normal.skills.reduce((total, skill) => total + skill.body.length, 0), alwaysOnChars };
}

const isControlArm = (arm) => arm?.control === 'A/A';
const candidateArmIds = (source) => Object.keys(source.arms).filter((id) => id !== HARNESS_BASELINE_ARM && !isControlArm(source.arms[id])).sort();

// ------------------------------------------------------------------------------------------------------------------ judge

/** Whether a judge identity sits on the solver's model family (DeepSeek in this platform, or whatever the manifest's solver says). */
function judgeOnSolverFamily(judge, solver) {
  return [judge?.id, judge?.provider].some((value) => /deepseek/i.test(String(value ?? '')))
    || (isText(solver?.provider) && isText(judge?.provider) && judge.provider.toLowerCase() === solver.provider.toLowerCase());
}

/**
 * What the registered judge has to be before any verdict of it is read: a fixed identity outside the solver's family, a form
 * and a number of passes, a call budget, and a qualification — the agreement and noise band measured on labelled cases (and the
 * thresholds the registration set for them), met.
 * @param {any} judge @param {any} [solver] @returns {string | null} a closed `campaign_*` code
 */
export function harnessJudgeRegistrationIssue(judge, solver) {
  if (!record(judge) || !IDENTIFIER.test(judge.id ?? '') || !isText(judge.provider) || !judge.provider) return 'campaign_judge_unregistered';
  if (judgeOnSolverFamily(judge, solver)) return 'campaign_judge_family_refused';
  if (!['absolute', 'pairwise'].includes(judge.form) || !Number.isInteger(judge.passes) || judge.passes < 2 || judge.passes > 9 || (judge.form === 'pairwise' && judge.passes % 2)
    || !Number.isInteger(judge.maxCalls) || judge.maxCalls < 1) return 'campaign_judge_unregistered';
  const q = judge.qualification;
  if (!record(q) || !isText(q.measuredOn) || !q.measuredOn.trim() || ![q.agreement, q.minimumAgreement].every((x) => finite(x) && x >= 0 && x <= 1)
    || ![q.noiseSd, q.noiseBand95].every((x) => finite(x) && x >= 0) || !(finite(q.maximumNoiseBand) && q.maximumNoiseBand > 0)) return 'campaign_judge_unqualified';
  return q.agreement >= q.minimumAgreement && q.noiseBand95 <= q.maximumNoiseBand ? null : 'campaign_judge_unqualified';
}

const runKey = (row, arm, repeat) => `${row}\0${arm}\0${repeat}`;
/** Code-unit order, so a sort gives the same bytes on every host. */
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The runs that must carry a verdict in every pass: delivered runs of every arm (absolute), of every arm but the baseline (pairwise). */
const judgedRuns = (source, form) => source.runs.filter((run) => run.status === 'succeeded' && (form === 'absolute' || run.arm !== HARNESS_BASELINE_ARM));

/** Issues of a judged source's `judged` section against the registered judge. @param {any} source @param {any} registration @returns {string[]} */
function judgedIssues(source, registration) {
  const registered = registration?.judge, judged = source.judged;
  if (!record(judged) || judged.schema !== 1 || !record(judged.judge) || !record(registered)) return ['harness_judge_verdicts_invalid'];
  const issues = new Set();
  for (const field of ['id', 'provider', 'form', 'passes']) if (judged.judge[field] !== registered[field]) issues.add('harness_judge_identity_mismatch');
  if (judgeOnSolverFamily(judged.judge, null)) issues.add('harness_judge_identity_mismatch');
  const records = Array.isArray(judged.records) ? judged.records : null;
  if (!records) return [...issues, 'harness_judge_verdicts_invalid'];
  const rowIds = new Set(source.rows.map((row) => String(row.id)));
  const runs = new Map(source.runs.map((run) => [runKey(run.row, run.arm, run.repeat), run]));
  const seen = new Set();
  for (const entry of records) {
    const key = record(entry) ? `${runKey(entry.row, entry.arm, entry.repeat)}\0${entry.pass}` : null;
    const run = record(entry) ? runs.get(runKey(entry.row, entry.arm, entry.repeat)) : undefined;
    if (!key || !rowIds.has(String(entry.row)) || !run || !Number.isInteger(entry.pass) || entry.pass < 1 || entry.pass > registered.passes || !finite(entry.score) || entry.score < 0 || entry.score > 1
      || !isText(entry.judge) || seen.has(key) || run.status !== 'succeeded' || (registered.form === 'pairwise' && entry.arm === HARNESS_BASELINE_ARM)) { issues.add('harness_judge_verdicts_invalid'); break; }
    if (entry.judge !== registered.id) issues.add('harness_judge_identity_mismatch');
    seen.add(key);
  }
  if (!issues.has('harness_judge_verdicts_invalid')) {
    const expected = judgedRuns(source, registered.form).length * registered.passes;
    if (seen.size !== expected) issues.add('harness_judge_verdicts_incomplete');
  }
  if (!Number.isInteger(judged.calls) || judged.calls < records.length || judged.calls > registered.maxCalls) issues.add('harness_judge_budget_exceeded');
  if (!keysWithin(judged.cost, ['settledCny', 'note']) || judged.cost.settledCny !== 0 || !isText(judged.cost.note) || !judged.cost.note.trim()) issues.add('harness_judge_cost_invalid');
  const fileOk = (file) => keysWithin(file, ['name', 'sha256', 'lines']) && isText(file.name) && file.name.length > 0 && HEX64.test(file.sha256 ?? '') && Number.isInteger(file.lines) && file.lines >= 0;
  if (!Array.isArray(judged.files) || !judged.files.length || !judged.files.every(fileOk) || !fileOk(judged.recordsFile) || judged.recordsFile.lines !== records.length) issues.add('harness_judge_files_invalid');
  return [...issues];
}

/**
 * The verdict records reduced to a run's score: the mean over the judge's passes, in a fixed order. `get(run)` is undefined for a
 * run with no record.
 * @param {any} source @returns {{ form: string, get: (run: any) => number | undefined }}
 */
export function judgedVerdicts(source) {
  const byRun = new Map();
  const records = [...source.judged.records].sort((a, b) => cmp(String(a.row), String(b.row)) || cmp(a.arm, b.arm) || a.repeat - b.repeat || a.pass - b.pass);
  for (const entry of records) {
    const key = runKey(entry.row, entry.arm, entry.repeat), seen = byRun.get(key) ?? { sum: 0, n: 0 };
    byRun.set(key, { sum: seen.sum + entry.score, n: seen.n + 1 });
  }
  return { form: source.judged.judge.form, get: (run) => { const seen = byRun.get(runKey(run.row, run.arm, run.repeat)); return seen ? seen.sum / seen.n : undefined; } };
}

// ----------------------------------------------------------------------------------------------------------------- identity

/**
 * The consumer as the evaluator pins it: the skill consumer's files this one builds on, the harness scorer table, this file and
 * the scorer the registration names. An id outside the table has no identity.
 * @param {any} [registration]
 */
export async function harnessCampaignConsumerIdentity(registration) {
  const scorer = harnessScorer(registration);
  if (!scorer) throw new Error('campaign_scorer_not_qualified');
  const components = ['skill_campaign.mjs', 'skill_scorers.mjs', 'harness_scorers.mjs', 'harness_campaign.mjs'].map((name) => ({ path: `evals/rsi-campaigns/${name}`, sha256: sha(readFileSync(new URL(`./${name}`, import.meta.url))) }));
  return { revision: 'harness-arms-v1', scorer: scorer.id, components, implementationSha256: sha(JSON.stringify({ scorer: scorer.id, components })) };
}

// ------------------------------------------------------------------------------------------------------------------ sources

/**
 * What a recorded-arms source must be for the scorer its registration names.
 * @param {any} source @param {any} registration @returns {string[]}
 */
export function harnessArmsIssues(source, registration) {
  const scorer = harnessScorer(registration);
  if (!scorer || !record(source) || source.kind !== 'harness-arms' || source.schema !== HARNESS_ARMS_SCHEMA || !scorerBenchmarks(scorer).includes(source.benchmark)) return ['harness_arms_invalid'];
  const issues = new Set();
  if (!['development', 'confirmation'].includes(source.role)) issues.add('harness_arms_role_invalid');
  if (!harnessImageValid(source.image)) issues.add('harness_arms_image_invalid');
  const rows = Array.isArray(source.rows) ? source.rows : [];
  const rowIds = new Set(rows.map((row) => String(row?.id)));
  if (!rows.length || rowIds.size !== rows.length || !rows.every((row) => scorer.validRow(row))) issues.add('harness_arms_rows_invalid');
  const arms = record(source.arms) ? source.arms : {};
  if (!Object.hasOwn(arms, HARNESS_BASELINE_ARM) || !keysWithin(arms[HARNESS_BASELINE_ARM], ['harness']) || arms[HARNESS_BASELINE_ARM].harness !== null) issues.add('harness_arms_baseline_missing');
  for (const [id, arm] of Object.entries(arms)) {
    if (id === HARNESS_BASELINE_ARM) continue;
    if (id === HARNESS_CONTROL_ARM) {
      if (!keysWithin(arm, ['harness', 'control']) || arm.harness !== null || arm.control !== 'A/A' || source.role !== 'development') issues.add('harness_arms_control_invalid');
      continue;
    }
    const h = arm?.harness, bundle = normalizeHarnessBundle(h?.bundle);
    let ok = keysWithin(arm, ['harness']) && keysWithin(h, ['digest', 'chars', 'alwaysOnChars', 'title', 'bundle']) && bundle && /^cand-[a-f0-9]{12}$/.test(id) && HEX64.test(h.digest ?? '') && id === `cand-${h.digest.slice(0, 12)}`
      && harnessImageValid(source.image) && (h.title === undefined || isText(h.title));
    if (ok) {
      const sizes = harnessPatchSizes(bundle);
      ok = h.digest === harnessPatchDigest(bundle, source.image) && h.chars === sizes.chars && h.alwaysOnChars === sizes.alwaysOnChars && sizes.alwaysOnChars <= HARNESS_ALWAYS_ON_MAX_CHARS;
    }
    if (!ok) issues.add('harness_arms_candidate_invalid');
  }
  const repeats = source.repeats;
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) issues.add('harness_arms_repeats_invalid');
  const seen = new Set();
  let wellFormed = true;
  for (const run of Array.isArray(source.runs) ? source.runs : []) {
    const key = runKey(run?.row, run?.arm, run?.repeat);
    if (!rowIds.has(String(run?.row)) || !Object.hasOwn(arms, run?.arm) || !Number.isInteger(run?.repeat) || run.repeat < 0 || run.repeat >= repeats || seen.has(key)) { issues.add('harness_arms_runs_invalid'); wellFormed = false; break; }
    if (!isText(run.runId) || !isText(run.status) || !(run.answer === null || isText(run.answer))) { issues.add('harness_arms_runs_invalid'); wellFormed = false; break; }
    if (!HARNESS_RUN_STATUSES.includes(run.status)) { issues.add('harness_arms_runs_infrastructure'); wellFormed = false; break; }
    if (!(run.cost === null || (finite(run.cost) && run.cost >= 0))) { issues.add('harness_arms_runs_invalid'); wellFormed = false; break; }
    seen.add(key);
  }
  if (!issues.size && seen.size !== rows.length * Object.keys(arms).length * repeats) issues.add('harness_arms_runs_incomplete');
  if (scorer.judged) {
    if (wellFormed && !issues.size) for (const issue of judgedIssues(source, registration)) issues.add(issue);
  } else if (source.judged !== undefined) issues.add('harness_arms_judged_unexpected');
  return [...issues];
}

// ------------------------------------------------------------------------------------------------------------------ scoring

/** A run's score in [0, 1]; a run that did not deliver has no answer to read. @param {any} scorer @param {any} run @param {any} row @param {any} verdicts */
const runScore = (scorer, run, row, verdicts) => scorer.score(run.status === 'succeeded' ? run.answer : null, row, run, verdicts);

/** Per arm: every row's mean score over its repeats, overall and over the registered failure slice. */
function armScores(source, registration) {
  const scorer = /** @type {NonNullable<ReturnType<typeof harnessScorer>>} */ (harnessScorer(registration));
  const slice = skillSlice(registration, scorer);
  const byRow = new Map(source.rows.map((row) => [String(row.id), row]));
  const verdicts = scorer.judged ? judgedVerdicts(source) : null;
  const scores = {};
  for (const arm of Object.keys(source.arms)) {
    const perRow = new Map();
    for (const run of source.runs.filter((entry) => entry.arm === arm)) {
      perRow.set(String(run.row), (perRow.get(String(run.row)) ?? 0) + runScore(scorer, run, byRow.get(String(run.row)), verdicts) / source.repeats);
    }
    const mean = (ids) => ids.length ? ids.reduce((sum, id) => sum + perRow.get(id), 0) / ids.length : null;
    const all = [...perRow.keys()].sort(), sliced = all.filter((id) => inSkillSlice(slice, scorer, byRow.get(id)));
    scores[arm] = { overall: mean(all), slice: mean(sliced), rows: all.length, sliceRows: sliced.length, perRow: Object.fromEntries([...perRow].sort()) };
  }
  return scores;
}

/** What the development stage records and the evaluator recomputes. @param {ReturnType<typeof chooseHarnessCandidate>} choice */
export const harnessDevelopmentResult = (choice) => ({ scores: choice.scores, candidates: choice.candidates, controls: choice.controls, noiseFloor: choice.noiseFloor });

/**
 * Development: the candidate with the largest failure-slice gain over the baseline among those whose overall score is not below
 * the baseline by more than the registered margin AND whose slice gain exceeds the A/A control's own apparent slice difference
 * (in absolute value: the noise a second run of the unmodified image shows); ties go to the smaller always-on growth, then the
 * smaller patch, then the id. The control is never a candidate. No candidate left ends the campaign.
 * It reads a development source only: a confirmation source is not scored before the runner opens it.
 * @param {any} source @param {any} registration
 */
export function chooseHarnessCandidate(source, registration) {
  if (source?.role !== 'development') throw new Error('harness_confirmation_scored_before_opening');
  const scores = armScores(source, registration), base = scores[HARNESS_BASELINE_ARM];
  const difference = (arm) => ({ overallDifference: scores[arm].overall - base.overall, sliceDifference: base.slice === null || scores[arm].slice === null ? null : scores[arm].slice - base.slice });
  const controls = Object.keys(source.arms).filter((id) => isControlArm(source.arms[id])).sort().map((arm) => ({ arm, ...difference(arm) }));
  const noiseFloor = controls.reduce((floor, control) => Math.max(floor, Math.abs(control.sliceDifference ?? 0)), 0);
  const candidates = candidateArmIds(source).map((arm) => ({ arm, harnessDigest: source.arms[arm].harness.digest, chars: source.arms[arm].harness.chars, alwaysOnChars: source.arms[arm].harness.alwaysOnChars, ...difference(arm) }));
  const eligible = candidates.filter((c) => c.sliceDifference !== null && c.sliceDifference > 0 && c.sliceDifference > noiseFloor && c.overallDifference >= -registration.margin);
  eligible.sort((a, b) => b.sliceDifference - a.sliceDifference || a.alwaysOnChars - b.alwaysOnChars || a.chars - b.chars || cmp(a.arm, b.arm));
  const winner = eligible[0];
  return { scores, candidates, controls, noiseFloor, frozen: winner ? { arm: winner.arm, harnessDigest: winner.harnessDigest, imageDigest: source.image.digest } : null, reason: winner ? null : 'campaign_no_improving_candidate' };
}

/**
 * Confirmation: the frozen candidate and the baseline only, every row x arm x repeat; each run is one observation of its row's
 * group and quality is its score. It reads a confirmation source only, and only for the arm development froze on the image it
 * froze on. Costs are not read here: the evaluator attests them from the same records.
 * @param {any} source @param {any} registration @param {{ arm: string, harnessDigest: string, imageDigest: string }} frozen
 */
export function harnessObservations(source, registration, frozen) {
  if (source?.role !== 'confirmation') return { observations: [], reason: 'campaign_source_role_mismatch' };
  const arms = Object.keys(source.arms).sort();
  if (arms.length !== 2 || !arms.includes(HARNESS_BASELINE_ARM) || !arms.includes(frozen.arm) || isControlArm(source.arms[frozen.arm])
    || source.arms[frozen.arm].harness?.digest !== frozen.harnessDigest || source.image?.digest !== frozen.imageDigest) return { observations: [], reason: 'campaign_confirmation_candidate_mismatch' };
  const scorer = /** @type {NonNullable<ReturnType<typeof harnessScorer>>} */ (harnessScorer(registration));
  const byRow = new Map(source.rows.map((row) => [String(row.id), row]));
  const verdicts = scorer.judged ? judgedVerdicts(source) : null;
  const observations = source.runs.map((run) => ({
    group: `row-${run.row}`, arm: run.arm === HARNESS_BASELINE_ARM ? 'baseline' : 'candidate', form: 'answer', repeat: run.repeat,
    status: 'measured', quality: runScore(scorer, run, byRow.get(String(run.row)), verdicts), critical_violations: 0,
  })).sort((a, b) => cmp(a.group, b.group) || cmp(a.arm, b.arm) || a.repeat - b.repeat);
  return { observations, scores: armScores(source, registration), reason: null };
}

/** The settled cost of every confirmation observation, keyed as the runner keys it; null where any run lacks one. @param {any} source @param {{ arm: string }} frozen */
export function harnessObservationCosts(source, frozen) {
  const rows = [];
  for (const run of source.runs) {
    if (!Number.isFinite(run.cost)) return null;
    rows.push({ group: `row-${run.row}`, arm: run.arm === HARNESS_BASELINE_ARM ? 'baseline' : 'candidate', form: 'answer', repeat: run.repeat, cost: run.cost, runId: run.runId });
  }
  if (!Object.hasOwn(source.arms, frozen.arm)) return null;
  return rows.sort((a, b) => cmp(a.group, b.group) || cmp(a.arm, b.arm) || a.repeat - b.repeat);
}

// --------------------------------------------------------------------------------------------------------------- the runner

const sameIds = (rows, ids) => Array.isArray(ids) && ids.length === rows.length && new Set(ids.map(String)).size === ids.length && rows.every((row) => ids.map(String).includes(String(row.id)));

/**
 * The runner's validation of a harness-patch campaign's inputs (`campaign_runner.mjs`): a closed `campaign_*` code, or null.
 * @param {any} manifest @param {any} inputs @param {{ id: string }} dev @param {{ id: string }} confirm
 */
export function harnessCampaignIssue(manifest, inputs, dev, confirm) {
  const registration = inputs.registration, scorer = harnessScorer(registration);
  if (!scorer) return 'campaign_scorer_not_qualified';
  // The judge first: a judge on the solver's family, or one nobody qualified, is named as such before anything is read through it.
  const judgeIssue = scorer.judged ? harnessJudgeRegistrationIssue(registration.judge, manifest.models?.solver) : (registration.judge === undefined ? null : 'campaign_judge_unexpected');
  if (judgeIssue) return judgeIssue;
  const development = inputs.sources[dev.id], confirmation = inputs.sources[confirm.id];
  for (const source of [development, confirmation]) if (harnessArmsIssues(source, registration).length) return 'campaign_source_invalid';
  if (development.role !== 'development' || confirmation.role !== 'confirmation') return 'campaign_source_role_mismatch';
  const slice = registration[scorer.slice.registration];
  if (!Array.isArray(slice) || !slice.length || slice.some((id) => !scorer.slice.valid(id)) || !(registration.margin > 0 && registration.margin < 1)) return 'campaign_registration_invalid';
  if (!record(registration.selection) || Object.entries(HARNESS_SELECTION).some(([key, value]) => registration.selection[key] !== value)) return 'campaign_selection_registration_missing';
  if (registration.costRatio !== HARNESS_COST_RATIO) return 'campaign_cost_ratio_unsupported';
  if (!Number.isInteger(registration.candidatesMax) || registration.candidatesMax < 1 || registration.candidatesMax > 10) return 'campaign_registration_invalid';
  if (!keysWithin(registration.control, ['arm', 'kind']) || registration.control.arm !== HARNESS_CONTROL_ARM || registration.control.kind !== 'A/A') return 'campaign_control_unregistered';
  if (!Object.hasOwn(development.arms, HARNESS_CONTROL_ARM)) return 'campaign_control_arm_missing';
  if (Object.keys(confirmation.arms).some((id) => id === HARNESS_CONTROL_ARM || isControlArm(confirmation.arms[id]))) return 'campaign_control_arm_in_confirmation';
  if (candidateArmIds(development).length > registration.candidatesMax) return 'campaign_candidates_exceed_registration';
  if (development.image.digest !== confirmation.image.digest || development.image.id !== confirmation.image.id || !record(registration.image)
    || registration.image.digest !== development.image.digest || registration.image.id !== development.image.id) return 'campaign_image_changed';
  if (!record(registration.rows) || !sameIds(development.rows, registration.rows.development) || !sameIds(confirmation.rows, registration.rows.confirmation)) return 'campaign_rows_unregistered';
  if (!record(registration.repeats) || registration.repeats.development !== development.repeats || registration.repeats.confirmation !== confirmation.repeats) return 'campaign_repeats_unregistered';
  if (manifest.data.classification !== 'synthetic') {
    const devRows = new Set(development.rows.map((row) => String(row.id)));
    if (confirmation.rows.some((row) => devRows.has(String(row.id)))) return 'campaign_confirmation_not_independent';
  }
  const candidates = Object.keys(confirmation.arms).filter((arm) => arm !== HARNESS_BASELINE_ARM);
  if (candidates.length !== 1 || !Object.hasOwn(development.arms, candidates[0]) || development.arms[candidates[0]].harness?.digest !== confirmation.arms[candidates[0]].harness?.digest) return 'campaign_confirmation_candidate_mismatch';
  const statistics = registration.statistics, family = statistics?.families?.[statistics?.groups?.[0]?.family];
  if (!family || family.repeats !== confirmation.repeats || statistics.deterministicConsumer !== false || statistics.mode !== 'paired-t') return 'campaign_statistics_registration_invalid';
  if (!record(registration.alpha) || !Number.isInteger(registration.alpha.campaignsPerQuarter) || registration.alpha.campaignsPerQuarter < 1
    || registration.alpha.perCampaign !== statistics.claims?.['targeted-repair']) return 'campaign_alpha_registration_invalid';
  const sliceSet = skillSlice(registration, scorer);
  const expected = confirmation.rows.map((row) => `row-${row.id}:${inSkillSlice(sliceSet, scorer, row)}`).sort();
  const registered = statistics.groups.map((group) => `${group.id}:${group.failure_slice}`).sort();
  return JSON.stringify(expected) === JSON.stringify(registered) ? null : 'campaign_source_group_registration_invalid';
}
