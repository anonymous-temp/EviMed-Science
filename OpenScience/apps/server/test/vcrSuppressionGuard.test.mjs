// What a model may read of a result that was made from real people's rows (algorithm round review RF2, P0-1 and P0-2).
//
// The domain's people-count lists (`VCR_PEOPLE_COUNT_*`) are the one place that names a head count, and they were extended three times
// by hand after a result shape had already shipped: a trimming's `removed`, an emulation's `persons`, a refusal's `available`. This
// test makes the next one fail here instead of in a review. For every kind of the vocabulary that reads patient-level rows it takes
// the committed real engine results of the kind (`test/fixtures/vcr-*`), sets every integer to 3 except the keys that are named below
// as not counting people, passes the result through `suppressForModel`, and requires that no 3 is left: an integer under a key the
// walk does not know is either a head count (list it in `vcrVocabulary.mjs`) or not (name it in NOT_PEOPLE with the reason).
//
// A kind with neither a fixture nor a named exemption fails, so a kind added to `VCR_JOB_KINDS` has to be classified here.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { VCR_JOB_KINDS, VCR_MIN_CELL_SIZE, VCR_PATIENT_LEVEL_JOB_KINDS, suppressForModel } from "@evimed/domain";

const read = (/** @type {string} */ path) => JSON.parse(readFileSync(new URL(`./fixtures/${path}.json`, import.meta.url), "utf8"));

/** Kinds that read rows, and the committed real engine results of each. */
const FIXTURES = /** @type {Record<string, string[]>} */ ({
  propensity_weight_comparator: ["vcr-bias-analysis/trim-weighting", "vcr-bias-analysis/trim-small-removed", "vcr-imputation/propensity-binary", "vcr-imputation/propensity-stopped"],
  weighted_cox_comparator: ["vcr-imputation/cox-time-to-event"],
  aipw_comparator: ["vcr-bias-analysis/aipw-tte"],
  stc_comparator: ["vcr-bias-analysis/stc-anchored", "vcr-bias-analysis/stc-unanchored"],
  target_trial_emulation: ["vcr-target-trial/sequential", "vcr-target-trial/sequential-stopped", "vcr-target-trial/clone-censor-weight"],
  train_prognostic_model: ["vcr-prognostic-training/cox", "vcr-prognostic-training/linear", "vcr-prognostic-training/too-few-events"],
  synthesize_population: ["vcr-synthetic-inference/synthesis"],
  population_quality: ["vcr-synthetic-inference/quality"],
});

/** Kinds that read rows and were built before this guard existed: their results are held by the tests named here. */
const OLDER_ROW_KINDS = /** @type {Record<string, string>} */ ({
  fit_survival_model: "vcrSuppression.test.mjs and vcrDataPlane.test.mjs: a fitted model states curves and parameters, never a row",
  apply_prognostic_model: "its table of predictions stays in the data plane; the result states counts of valid and invalid predictions (listed)",
  profile_snapshot: "the profile's cells are merged and suppressed by the engine (`vcr_suppress_cells`, N45)",
  build_cohort: "a cohort's size is a listed measure (`cohort_size`) and the waterfall is a list of cells",
  weight_comparator: "the entropy-balance form of the weighting comparators; its counts are the ones the other weighting kinds share",
  rmst: "restricted mean survival times and the counts of an arm: the shared keys",
  match_criteria: "matching is a separate branch's (`vcrMatching*`)",
  maic_time_to_event_comparator: "an anchored weighting of the published arm's pseudo-patients: the shared keys",
  covariate_set_comparator: "the comparison of covariate sets restates the weighting kinds' results",
  prognostic_adjustment_comparator: "a covariate-adjusted effect with the shared keys",
});

/** Kinds that need no patient-level snapshot (`VCR_PATIENT_LEVEL_JOB_KINDS` is the contract): published figures, a design, a scenario, a generated table. */
const READS_NO_ROWS = [
  "generate_population", "literature_population", "generate_patients", "generate_patients_continuous", "generate_patients_binary", "reconstruct_km", "pool_evidence",
  "maic_comparator", "evalue", "design_analytic", "design_simulation", "design_grid", "assurance", "procova", "accrual_forecast", "map_prior",
  "negative_control_comparator", "tipping_point", "generate_patients_longitudinal", "population_check", "design_confirmatory", "bias_analysis", "network_meta",
  "dose_response_meta", "effect_shrinkage", "design_dose", "design_bayesian", "design_win_ratio", "decision_voi", "borrowing_prior", "generate_progression", "match_extract",
  "forecast_trajectories", "evaluate_forecast", "compare_forecasts", "benchmark_trial_effect",
];

/** Integer keys of those results that are not a head count of real people, and why. A key not here and not listed in the domain fails. */
const NOT_PEOPLE = /** @type {Record<string, string>} */ ({
  seed: "run bookkeeping", cores: "run bookkeeping", protocolVersion: "run bookkeeping", replicates: "run bookkeeping", replicatesCompleted: "run bookkeeping", replicatesPlanned: "run bookkeeping",
  bootstrapMin: "a computation setting", bootstrapReplicates: "a computation size", requested: "a computation size (imputations, bootstrap draws)", completed: "a computation size",
  perRun: "a computation size", runs: "a computation size", drawsInTotal: "a computation size", floor: "a computation setting", draws: "a computation size", batches: "a computation size",
  maxIterations: "a computation setting", m: "the number of imputed or synthetic copies", imputations: "the number of imputed copies", copies: "the number of synthetic copies", copy: "an index of a copy",
  failedCopies: "a count of failed computations", failedReplicates: "a count of failed computations", copiesPerReplicate: "a computation setting", worstCopy: "an index of a copy", profileCopy: "an index of a copy",
  horizon: "a time stated by the person", tau: "a time stated by the person", gracePeriod: "a time stated by the person", followupDegree: "a model setting", trialPeriodDegree: "a model setting",
  folds: "a model setting", parameters: "the number of model parameters", needed: "the number of people a model needs (a threshold, not a count of the table)", scale: "a unit of scale", center: "a centring constant",
  gamma: "a discount stated by the person", gammas: "discounts stated by the person", lambda: "a discount stated by the person", lambdas: "discounts stated by the person", trees: "a model setting",
  df: "degrees of freedom", minCount: "a threshold", rareLevelFloor: "a threshold", essFloor: "a threshold", coxFewEvents: "a threshold", association: "a value stated by the person",
  baselinePrevalence: "a value stated by the person", limit: "a bound", none: "a bound", min: "a bound", activeArm: "an arm code", x: "a coordinate of a curve", y: "a coordinate of a curve",
  high: "an interval end", low: "an interval end", mcse: "a Monte Carlo error", value: "a measure's value (judged by the measure's name below)", between: "a variance component",
  relativeIncrease: "a statistic", fractionMissingInformation: "a statistic", sum: "a sum of weights", persistsSystematic: "a share", persistsSystematicMcse: "a Monte Carlo error",
  // generated people are not people
  generatedRecords: "generated records, not persons", syntheticRows: "generated rows, not persons", syntheticCombinations: "category combinations in a generated table",
  // counts of category combinations, of attack attempts and of rule violations in a generated table, not of persons
  realCombinations: "category combinations", missingInSynthetic: "category combinations", absentFromReal: "category combinations", worstMissingInSynthetic: "category combinations",
  worstAbsentFromReal: "category combinations", attacks: "attack attempts", attacksMain: "attack attempts", attacksControl: "attack attempts", constraintViolations: "rule violations in a generated table",
  replicationRatio: "a ratio", missingRateDifference: "a difference of rates", exactReplicationRateHoldout: "a rate", holdoutShare: "a share", trainingShare: "a share", worstRiskLowerLimit: "a bound",
  referenceSubsamples: "a computation size", bootstrapFailureShare: "a share", failureShare: "a share",
  // stated by the engine under its own small-cell rule (`vcr_suppress_cells`, `.vcr_count_cell`; N45, N97)
  all: "engine-guarded: a cell of a table of the people at risk, stated only at or above the floor (N97)", atRisk: "engine-guarded (N97)", size: "engine-guarded: the at-risk group, stated only at or above the floor (N97)",
  breaks: "engine-guarded: a histogram's edges (N45)", counts: "engine-guarded: a histogram's cells, merged by `vcr_suppress_cells` (N45)",
  q1: "engine-guarded: a quantile of a column, stated for a table of at least twenty times the floor (N45)", q3: "engine-guarded (N45)", p01: "engine-guarded (N45, N97)", p05: "engine-guarded (N45, N97)",
  "measure:bias_tipping_limit": "a bound", "measure:e_value_confidence_limit": "an E-value", "measure:e_value": "an E-value", "measure:generated_records": "generated records",
  "measure:synthetic_copies": "a number of copies", "measure:false_positive_rate_real_permuted": "a rate", "measure:false_positive_rate_synthetic_combined": "a rate",
  "measure:false_positive_rate_synthetic_naive": "a rate", "measure:records_above_risk_bound": "engine-guarded share (N97)",
});

/** Objects whose entries are named by a covariate or an arm and hold something that is not a head count. */
const NOT_PEOPLE_UNDER = /** @type {Record<string, string>} */ ({
  shareOutsideIpdRange: "the share of a published population outside the range of the person's table, by covariate",
});

/** Keys that name one person (or a person's row) and so are never in a result a model reads. */
const PERSON_IDENTIFIERS = ["USUBJID", "subjectId", "personId", "patientId", "subject_id"];

/** Is this integer one the walk is not asked about? @param {string[]} trail the keys down to it @param {any} parent */
function named(trail, parent) {
  const key = trail.at(-1) ?? null;
  const known = key === "value" && typeof parent?.name === "string" ? `measure:${parent.name}` : key;
  return (known !== null && Object.hasOwn(NOT_PEOPLE, known)) || trail.slice(0, -1).some((own) => Object.hasOwn(NOT_PEOPLE_UNDER, own));
}

/** @param {any} value @param {string[]} trail @param {any} parent @param {(leaf: number, trail: string[], parent: any) => number} change */
function mapIntegers(value, trail, parent, change) {
  if (typeof value === "number") return Number.isInteger(value) ? change(value, trail, parent) : value;
  if (Array.isArray(value)) return value.map((entry) => mapIntegers(entry, trail, parent, change));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([own, entry]) => [own, mapIntegers(entry, [...trail, own], value, change)]));
  }
  return value;
}

/** Every 3 left in a result, with its path, apart from those under keys named as not people. @param {any} value @param {string[]} trail @param {any} parent @param {string[]} found */
function survivors(value, trail, parent, found) {
  if (typeof value === "number") {
    if (value === 3 && !named(trail, parent)) found.push(`result.${trail.join(".")}`);
  } else if (Array.isArray(value)) value.forEach((entry) => survivors(entry, trail, parent, found));
  else if (value && typeof value === "object") for (const [own, entry] of Object.entries(value)) survivors(entry, [...trail, own], value, found);
  return found;
}

/** The same result with every integer that might count people set to three. @param {any} result */
function withThrees(result) {
  return mapIntegers(result, [], null, (leaf, trail, parent) => (named(trail, parent) ? leaf : 3));
}

const everyKey = (/** @type {any} */ value, /** @type {string[]} */ out = []) => {
  if (Array.isArray(value)) value.forEach((entry) => everyKey(entry, out));
  else if (value && typeof value === "object") for (const [own, entry] of Object.entries(value)) { out.push(own); everyKey(entry, out); }
  return out;
};

test("every kind of the vocabulary is either held by a committed result, named as older, or reads no rows", () => {
  const classified = [...Object.keys(FIXTURES), ...Object.keys(OLDER_ROW_KINDS), ...READS_NO_ROWS];
  assert.deepEqual(VCR_JOB_KINDS.filter((kind) => !classified.includes(kind)), [], "a kind added to the vocabulary is classified here: a fixture, or a named reason");
  assert.deepEqual(classified.filter((kind) => !VCR_JOB_KINDS.includes(kind)), [], "and nothing here is a kind that is gone");
  assert.equal(new Set(classified).size, classified.length, "a kind is classified once");
  const reading = [...Object.keys(FIXTURES), ...Object.keys(OLDER_ROW_KINDS)];
  assert.deepEqual([...reading].sort(), [...VCR_PATIENT_LEVEL_JOB_KINDS].sort(), "the kinds that read rows are the kinds the access contract says read rows");
  assert.deepEqual(READS_NO_ROWS.filter((kind) => VCR_PATIENT_LEVEL_JOB_KINDS.includes(kind)), [], "a kind that starts reading rows leaves the exemption");
});

for (const [kind, names] of Object.entries(FIXTURES)) {
  for (const name of names) {
    test(`${kind}: ${name} with every count set to three leaves no head count and no person for a model`, () => {
      const result = read(name);
      const shown = suppressForModel(withThrees(result), { minCell: VCR_MIN_CELL_SIZE });
      const left = survivors(shown, [], null, []);
      assert.deepEqual(left, [], "an integer that counts people survives under a key the domain's lists do not know: list it in vcrVocabulary.mjs, or name it in NOT_PEOPLE with the reason");
      assert.deepEqual(everyKey(shown).filter((key) => PERSON_IDENTIFIERS.includes(key)), [], "no key names a person");
    });
  }
}

test("a target-trial emulation's waiting times are withheld as a block when the people who waited are few", () => {
  for (const name of ["vcr-target-trial/clone-censor-weight"]) {
    const shown = suppressForModel(withThrees(read(name)));
    const waiting = shown.diagnostics.targetTrial.design.waitingTime;
    assert.deepEqual(Object.keys(waiting).sort(), ["suppressed"], "no median and no longest wait of three people");
    for (const key of ["people", "startedWithinGrace", "startedAfterGrace", "neverStarted", "startedAtTimeZero"]) assert.equal(shown.diagnostics.targetTrial.design[key], null, key);
  }
  // with enough people the same block is stated
  const large = suppressForModel(read("vcr-target-trial/clone-censor-weight")).diagnostics.targetTrial.design;
  assert.equal(typeof large.waitingTime.median, "number");
});

test("the engine states no baseline of a removed group under the floor, and the model path leaves nothing of it", () => {
  const result = read("vcr-bias-analysis/trim-small-removed");
  const trim = result.diagnostics.trim;
  const small = trim.arms.filter((/** @type {any} */ arm) => arm.removed === null).map((/** @type {any} */ arm) => arm.arm);
  assert.ok(small.length > 0, "the committed result is one whose removed group is under the floor");
  for (const row of trim.baseline) if (small.includes(row.arm)) assert.equal(row.removedMean, null, `${row.arm}: a mean of fewer than ten people is not stated`);
  assert.equal(trim.removedTotal, null);
  assert.ok(!result.measures.some((/** @type {any} */ measure) => measure.name === `trimmed_${small[0]}`), "and no measure counts them");
  const shown = suppressForModel(result);
  assert.equal(shown.diagnostics.trim.trimmedAnyone, true, "that someone was removed is stated");
  assert.ok(shown.diagnostics.trim.arms.every((/** @type {any} */ arm) => arm.n === null && arm.kept === null && arm.removed === null), "a cell under the floor takes the other arm's cell with it: the arms are siblings");
});
