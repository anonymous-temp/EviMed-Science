/**
 * The yardsticks of the platform's own modules (2026-11-04): what the online experiment engine measured them by (`frontier-source-v1`), as an offline campaign's closed scorer table. `registration.scorer` holds an id of the frozen table below, the
 * registration's `surface` must be one the scorer measures, and anything else is `campaign_scorer_not_qualified`: no executable path, no
 * dynamic import, no function handed in. Bound into the consumer identity (module_campaign.mjs), like harness_scorers.mjs.
 *
 *  - `frontier-numbers`     every number and unit of the rewrite is in its source (`frontierNumbers.mjs`, the editor's own check, as `unit.numbers`),
 *                           the closed answer right where the case expects one (the lane, and for the other kinds of frontier-editing/cases.json the
 *                           evidence type, the flags, the industry kind), verification `passed` or `repaired`. A FLOOR of quality, not a measure of it:
 *                           a rewrite can pass every number and say something the source does not, which is what the judged scorer adds. A case with
 *                           `abstentionExpected` counts as it says: it is met by a rewrite that wrote no summary and stated no unsupported number. On a row with no gold (a public item
 *                           of the export) the floor and the bar are then one test with nothing pulling against it, so such a campaign is directional only (module_campaign.mjs `moduleDirectional`).
 *                           On `frontier-screen` the screen's own lane must be right too (evals/frontier-editing/run_eval.mjs reads both).
 *  - `frontier-source`      the floor times the fidelity verdict of a registered judge, read from digested verdict records (the path judged-verdicts
 *                           uses: harness_campaign.mjs `judgedIssues`, `judgedVerdicts`). The judge is Claude by the domain's role policy and qualified by
 *                           the code's thresholds; the Qwen reviewer of the online engine has no way back in (`campaign_judge_refused`).
 *
 * GEO has no scorer here: `geo-card-source-v1` needs a real lane arm that writes answers from evidence-zone cards and a supply of cases nobody has
 * yet, so `geo-supplements` stays `campaign_consumer_not_qualified` instead of a table row with no source that can reach it.
 *
 * `moduleDeterministicChecks` is the online engine's `evolutionDeterministicChecks`, the non-inferiority bar of a model-scored promotion, with its noise band corrected (`incumbentNoiseBand`).
 */
import { judgedScore } from './harness_scorers.mjs';

const isText = (value) => typeof value === 'string';
const present = (value) => isText(value) && value.length > 0;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value) => Number.isInteger(value) && value >= 0;

/** A case's or an answer's `units`: one per variant of the case, in order. @param {any} answer */
const unitsOf = (answer) => (record(answer) && Array.isArray(answer.units) ? answer.units : []);
/** The share of a run's units a check holds for, 0 for a run that delivered no answer. @param {any} answer @param {(unit: any) => boolean} check */
function share(answer, check) {
  const units = unitsOf(answer);
  return units.length ? units.filter(check).length / units.length : 0;
}

// ------------------------------------------------------------------------------------------------------------------- frontier

/** What each kind of case in frontier-editing/cases.json expects of the answer, as run_eval.mjs reads it; a row with no kind (a public item) expects nothing closed. */
const CLOSED_ANSWER = Object.freeze({
  lane: (output, gold) => (gold.expect ? gold.expect.includes(output?.lane) : !(gold.expectNot ?? []).includes(output?.lane)),
  evidence_type: (output, gold) => gold.expect.includes(output?.evidenceType),
  flags: (output, gold) => Array.isArray(output?.flags) && gold.expect.every((flag) => output.flags.includes(flag)) && (gold.expectNot ?? []).every((flag) => !output.flags.includes(flag)),
  // A kind belongs to an item the model also calls industry, so any other genre reads as none.
  industry_kind: (output, gold) => gold.expect.includes(output?.genre === 'industry' ? output?.industryKind ?? null : null),
});
const frontierGold = (gold) => record(gold) && Object.keys(gold).every((key) => ['kind', 'expect', 'expectNot', 'abstentionExpected'].includes(key))
  && (gold.kind === undefined ? gold.expect === undefined && gold.expectNot === undefined : Object.hasOwn(CLOSED_ANSWER, gold.kind) && (Array.isArray(gold.expect) || (gold.kind === 'lane' && Array.isArray(gold.expectNot))))
  && (gold.abstentionExpected === undefined || gold.abstentionExpected === true);
const frontierRow = (row) => present(row?.id) && present(row?.category) && frontierGold(row?.gold);
const VERIFICATIONS = Object.freeze(['passed', 'repaired', 'title-only', 'pending']);
const frontierAnswer = (answer) => answer === null || (unitsOf(answer).length > 0 && unitsOf(answer).every((unit) => present(unit?.variant) && present(unit?.inputSha256) && VERIFICATIONS.includes(unit?.verification)
  && (unit.numbers === null || (record(unit.numbers) && count(unit.numbers.checked) && count(unit.numbers.source) && Array.isArray(unit.numbers.missing) && Array.isArray(unit.numbers.unitMismatches))) && (unit.output === null || record(unit.output))));

const noNumberInvented = (unit) => Boolean(unit?.numbers) && unit.numbers.missing.length === 0 && unit.numbers.unitMismatches.length === 0;
/**
 * The unit's deterministic check: every number and unit of its rewrite is in its source, and a rewrite of a source that states numbers states at least one (`numbers.source`, the arms' count by the
 * editor's own check of the lines that state the source). A rewrite with no number has nothing for the check to catch, so without the second half dropping everything is the sure way to pass. It
 * says nothing of WHICH numbers were kept: that is the judge's (`frontier-source`). A unit that never reached the check did not pass it. @param {any} unit
 */
export const frontierNumbersPassed = (unit) => noNumberInvented(unit) && (unit.numbers.source === 0 || unit.numbers.checked > 0);

/** The floor of one unit. `screenLane` is there only when the arm screened the item first. @param {any} unit @param {any} gold */
export function frontierUnitMet(unit, gold) {
  if (gold.abstentionExpected === true) return noNumberInvented(unit) && !unit.output?.summaryZh;
  if (!frontierNumbersPassed(unit)) return false;
  if (!['passed', 'repaired'].includes(unit.verification)) return false;
  if (gold.kind === undefined) return true;
  if (!CLOSED_ANSWER[gold.kind](unit.output, gold)) return false;
  return unit.screenLane === undefined || gold.kind !== 'lane' || CLOSED_ANSWER.lane({ lane: unit.screenLane }, gold);
}
const frontierFloor = (answer, row) => share(answer, (unit) => frontierUnitMet(unit, row.gold));

// ------------------------------------------------------------------------------------------------------------------- the table

const stratum = Object.freeze({ registration: 'failureSlice', key: String, valid: present, row: 'category' });

/**
 * id -> { id, benchmark, benchmarks, family, surfaces (what it measures), slice, validRow, validAnswer, score[, deterministicPassed][, judged, joinsGold] }.
 * `deterministicPassed` is the unit's code check, present where the score rests on a model's writing: the bar (`moduleDeterministicChecks`) reads it.
 */
export const MODULE_SCORERS = Object.freeze({
  'frontier-numbers': Object.freeze({ id: 'frontier-numbers', benchmark: 'frontier-editing', benchmarks: Object.freeze(['frontier-editing']), family: 'frontier', surfaces: Object.freeze(['frontier-edit', 'frontier-screen']),
    slice: stratum, validRow: frontierRow, validAnswer: frontierAnswer, score: frontierFloor, deterministicPassed: frontierNumbersPassed }),
  'frontier-source': Object.freeze({ id: 'frontier-source', benchmark: 'frontier-editing', benchmarks: Object.freeze(['frontier-editing']), family: 'frontier', surfaces: Object.freeze(['frontier-edit']),
    slice: stratum, validRow: frontierRow, validAnswer: frontierAnswer, deterministicPassed: frontierNumbersPassed, judged: true, joinsGold: true,
    score: (answer, row, run, verdicts) => { const floor = frontierFloor(answer, row); return floor === 0 ? 0 : floor * judgedScore(answer, row, run, verdicts); } }),
});

/**
 * The scorer a module registration names, for the surface it says; an id outside the table, or one that does not measure that surface, is null.
 * @param {any} [registration]
 */
export function moduleScorer(registration) {
  const id = registration?.scorer;
  if (!isText(id) || !Object.hasOwn(MODULE_SCORERS, id)) return null;
  const scorer = MODULE_SCORERS[/** @type {keyof typeof MODULE_SCORERS} */ (id)];
  return scorer.surfaces.includes(registration.surface) ? scorer : null;
}

// ------------------------------------------------------------------------------------------------------------------- the bar

const average = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

/**
 * The noise of what the bar compares, a difference of means over groups: twice the standard error of the runs' pairwise differences, over the groups, and at least 0.02. The online engine's
 * `evolutionNoiseBand` used the standard deviation of one group's difference for this and so had the defect a review found here on 2026-11-05: about 2·√(2p(1−p)), 0.85 at a pass share of 0.9, so the
 * bar never fired under noise (a candidate at 0.417 against 0.817 passed a band of 1.117).
 * @param {number[][]} runs
 */
export function incumbentNoiseBand(runs) {
  const differences = [];
  for (let left = 0; left < runs.length; left += 1) for (let right = left + 1; right < runs.length; right += 1) runs[left].forEach((value, index) => differences.push(value - runs[right][index]));
  const mean = average(differences);
  const variance = differences.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (differences.length - 1);
  return Math.max(0.02, 2 * Math.sqrt(variance / runs[0].length));
}

/**
 * Whether a candidate is no worse than the version it replaces on the deterministic checks, within the noise of that version's own repeats: the share of
 * units whose check passed, per group, against the incumbent's runs (at least three) and their noise band. A failure the incumbent has too is not held
 * against the candidate, and a measurement seldom comes out perfect whoever wrote the candidate (review D-E19 of the online engine, whose rule this is).
 * `ran` is false when a run carries no check on some unit, when the groups differ, or with fewer than three runs of the incumbent: nothing was measured.
 * @param {{ units: { id?: string, groupId?: string, deterministicPassed?: boolean }[] }} candidate
 * @param {{ units: { id?: string, groupId?: string, deterministicPassed?: boolean }[] }[]} incumbents
 */
export function moduleDeterministicChecks(candidate, incumbents) {
  const shares = (measurement) => {
    const groups = new Map();
    for (const unit of measurement?.units ?? []) {
      if (typeof unit.deterministicPassed !== 'boolean') return null;
      const key = unit.groupId ?? unit.id;
      groups.set(key, [...(groups.get(key) ?? []), Number(unit.deterministicPassed)]);
    }
    return groups.size ? new Map([...groups].map(([key, values]) => [key, average(values)])) : null;
  };
  const mine = shares(candidate), theirs = incumbents.map(shares), ids = mine ? [...mine.keys()].sort() : [];
  if (!mine || theirs.length < 3 || theirs.some((groups) => !groups || groups.size !== ids.length || ids.some((id) => !groups.has(id)))) return { ran: false, nonInferior: false, regressed: false };
  const runs = theirs.map((groups) => ids.map((id) => groups.get(id)));
  const delta = incumbentNoiseBand(runs), candidateShare = average(ids.map((id) => mine.get(id))), baselineShare = average(runs.flat());
  const regressed = candidateShare < baselineShare - delta;
  return { ran: true, candidate: candidateShare, baseline: baselineShare, delta, nonInferior: !regressed, regressed };
}
