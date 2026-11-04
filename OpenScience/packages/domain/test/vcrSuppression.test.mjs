/**
 * Small-cell suppression for what a model may read (integration contract §4).
 *
 * The first build suppressed one shape — a `cells` array — that nothing in the
 * system produces. These tests walk the shapes the stores and the engine really
 * write: `counts`, `waterfall[]`, `diagnostics.arms[]`, `levels`, a profile's
 * columns, a referral funnel — nested inside one another, several levels down.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  VCR_MIN_CELL_SIZE,
  VCR_PEOPLE_COUNT_BLOCK_FIELDS,
  VCR_PEOPLE_COUNT_FIELDS,
  VCR_PEOPLE_COUNT_LINKS,
  VCR_PEOPLE_COUNT_MAP_KEYS,
  VCR_PEOPLE_COUNT_MEASURES,
  VCR_PEOPLE_COUNT_SCALAR_FIELDS,
  VCR_PEOPLE_COUNT_WITHHELD_BLOCKS,
  VCR_PEOPLE_DERIVED_MEASURES,
  suppressForModel,
} from "@evimed/domain";

/** JSON-safe deep copy. @template T @param {T} value @returns {T} */
const clone = (value) => JSON.parse(JSON.stringify(value));
/** Every number in a document, as a flat list. @param {any} value @returns {number[]} */
const numbers = (value) => (typeof value === "number" ? [value]
  : Array.isArray(value) ? value.flatMap(numbers)
    : value && typeof value === "object" ? Object.values(value).flatMap(numbers) : []);

test("the people-count keys are the contract's, and the floor is ten", () => {
  assert.equal(VCR_MIN_CELL_SIZE, 10);
  assert.deepEqual([...VCR_PEOPLE_COUNT_FIELDS], ["n", "count", "patients", "realPatients", "subjects", "events", "kept", "excluded",
    "indeterminate", "cohortSize", "screened", "eligible", "enrolled", "referred", "contacted", "candidates", "nonEvents", "validPredictions", "invalidPredictions",
    "removed", "startedWithinGrace", "startedAfterGrace", "neverStarted", "startedAtTimeZero"]);
  assert.deepEqual([...VCR_PEOPLE_COUNT_MAP_KEYS], ["levels", "people", "readable", "startsByArm", "eventsByArm"]);
  assert.deepEqual([...VCR_PEOPLE_COUNT_SCALAR_FIELDS], ["rows", "startingRows", "keptRows", "trainingObservations", "effectiveSampleSize",
    "requestedSubjects", "batchSubjects", "batchEvaluated", "batchUnavailable", "outsideBatch", "subjectsNotEvaluated",
    "peopleSelected", "recordsToRead", "recordsRead", "recordsAlreadyRead", "prefiltered",
    "removedTotal", "keptTotal", "rowsAnalysed", "rowsIncomplete", "droppedRows", "inputRows", "usedRows", "excludedRows", "persons", "personsInTable", "personPeriods",
    "personTrials", "expandedRows", "eligiblePeriods", "recordsCutShort", "rowsDroppedWhereCut", "rowsAfterEventDropped", "observedRows", "nTraining", "nHoldout",
    "holdoutRows", "referenceSize", "leftOut", "smallerGroup", "rowsUsed", "rowsOtherArm", "controlPeopleUsed"]);
  assert.deepEqual([...VCR_PEOPLE_COUNT_MEASURES], ["rows", "cohort_size", "cohort_size_strict", "cohort_size_lenient", "training_observations", "effective_sample_size",
    "eligible", "ineligible", "insufficient_evidence", "pending", "records_read", "records_already_read", "trimmed_treated", "trimmed_control"]);
  assert.deepEqual(Object.fromEntries(Object.entries(VCR_PEOPLE_COUNT_BLOCK_FIELDS).map(([block, keys]) => [block, [...keys]])),
    { byYear: ["treated", "control"], estimate: ["people", "records"], plan: ["toRead", "alreadyRead", "prefiltered", "noDocuments", "deferred"],
      covariates: ["missing"], design: ["people"], waitingTime: ["people"] });
  assert.deepEqual(VCR_PEOPLE_COUNT_LINKS.map((link) => [[...link.triggers], [...link.whole], [...link.derived]]),
    [[["events", "nonEvents"], ["n", "events", "nonEvents"], ["observedRisk", "calibrationInLarge"]],
      [["startedWithinGrace", "startedAfterGrace", "neverStarted"], ["people", "startedWithinGrace", "startedAfterGrace", "neverStarted"], []],
      [["usedRows", "excludedRows"], ["inputRows", "usedRows", "excludedRows"], []], [["rowsIncomplete"], ["rowsAnalysed", "rowsIncomplete"], []], [["droppedRows"], ["rows", "droppedRows"], []]]);
  assert.deepEqual({ ...VCR_PEOPLE_DERIVED_MEASURES }, { observedRisk: "observed_risk", calibrationInLarge: "calibration_in_the_large" });
  assert.deepEqual(Object.keys(VCR_PEOPLE_COUNT_WITHHELD_BLOCKS), ["enrolmentYear", "waitingTime"]);
});

test("a count of 1 to 9 that stands alone becomes null, and its object says which keys it hid", () => {
  assert.deepEqual(suppressForModel({ counts: { realPatients: 7, events: 3, effectiveSampleSize: 12.2, generatedRecords: 0 } }),
    { counts: { realPatients: null, events: null, effectiveSampleSize: 12.2, generatedRecords: 0, suppressed: ["realPatients", "events"] } });
  assert.deepEqual(suppressForModel({ n: 9 }), { n: null, suppressed: ["n"] });
  assert.deepEqual(suppressForModel({ n: 10 }), { n: 10 }, "ten is the floor, and is shown");
  assert.deepEqual(suppressForModel({ n: 0 }), { n: 0 }, "a lone zero says nothing about a person");
  assert.deepEqual(suppressForModel({ n: 1 }), { n: null, suppressed: ["n"] });
  // A key that is not a head count is not touched, however small.
  assert.deepEqual(suppressForModel({ expectedSampleSize: 3, mean: 4, smd: 0.05, alpha: 0.025 }), { expectedSampleSize: 3, mean: 4, smd: 0.05, alpha: 0.025 });
  // A count already hidden stays hidden and is not listed twice.
  assert.deepEqual(suppressForModel({ n: 3, suppressed: ["n"] }), { n: null, suppressed: ["n"] });
});

test("in a list of sibling cells, the small cells and zero are hidden together and topped up to ten in two cells", () => {
  const arms = { arms: [{ arm: "A", n: 60 }, { arm: "B", n: 4 }, { arm: "C", n: 0 }, { arm: "D", n: 55 }] };
  const shown = suppressForModel(clone(arms));
  // B (4) and C (0) are small; together they hold 4 people, so the smallest remaining cell (D? no — A 60 vs D 55: D) joins them.
  assert.deepEqual(shown.arms.map((/** @type {any} */ cell) => [cell.arm, cell.n]), [["A", 60], ["B", null], ["C", null], ["D", null]]);
  for (const cell of shown.arms.slice(1)) assert.deepEqual(cell.suppressed, ["n"]);
  // The hidden cells keep what they are and lose every number.
  assert.deepEqual(numbers(shown.arms.slice(1)), []);
});

test("one small cell alone is not enough: hiding it reproduces it from the total", () => {
  const shown = suppressForModel({ levels: [{ level: "A", n: 40 }, { level: "B", n: 3 }, { level: "C", n: 25 }, { level: "D", n: 30 }] });
  const hidden = shown.levels.filter((/** @type {any} */ cell) => cell.n === null).map((/** @type {any} */ cell) => cell.level);
  assert.ok(hidden.includes("B"), "the small cell is hidden");
  assert.ok(hidden.length >= 2, "and at least one more with it");
  assert.equal(hidden.includes("A"), false, "the largest cell is not needed to reach ten");
  // 3 + 25 = 28 ≥ 10 in two cells: the smallest of the rest is what tops it up.
  assert.deepEqual(hidden.sort(), ["B", "C"]);
});

test("a table too small to show is withheld whole", () => {
  const shown = suppressForModel({ cells: [{ arm: "A", n: 3 }, { arm: "B", n: 4 }] });
  assert.deepEqual(numbers(shown), []);
  assert.deepEqual(shown.cells.map((/** @type {any} */ cell) => cell.arm), ["A", "B"], "what the cells are is still said");
  // A single cell that is small is hidden too.
  assert.deepEqual(numbers(suppressForModel({ counts: [{ n: 3 }] })), []);
});

test("a cell with several count keys is judged by its smallest", () => {
  const shown = suppressForModel({ waterfall: [
    { step: "adult", kept: 400, excluded: 2, indeterminate: 30 },
    { step: "no prior therapy", kept: 380, excluded: 12, indeterminate: 8 },
    { step: "ECOG 0-1", kept: 300, excluded: 80, indeterminate: 20 },
    { step: "washout", kept: 250, excluded: 50, indeterminate: 15 },
  ] });
  const [first, second, third, fourth] = shown.waterfall;
  // Sizes are 2, 8, 20, 15: the first two are small and together hold ten, so they alone are hidden.
  for (const row of [third, fourth]) assert.ok(numbers(row).every((value) => value >= 15), "a row whose smallest count is 15 or more is shown whole");
  assert.equal(third.kept, 300);
  assert.equal(fourth.excluded, 50);
  for (const row of [first, second]) {
    assert.equal(row.kept, null, "a big count in a small row goes with it: 400 next to 2 is still 2 people");
    assert.equal(row.excluded, null);
    assert.equal(row.indeterminate, null);
    assert.deepEqual(row.suppressed, ["kept", "excluded", "indeterminate"]);
  }
  assert.deepEqual([first.step, second.step], ["adult", "no prior therapy"], "what a hidden row is stays");
});

test("a row of zeros is hidden with its neighbour: zero plus a public total is an exact count", () => {
  const shown = suppressForModel({ waterfall: [{ step: "a", kept: 400, excluded: 0 }, { step: "b", kept: 400, excluded: 40 }] });
  assert.deepEqual(numbers(shown), [], "one zero cell is not enough, and the pair holds 0 + 40 = 40 ≥ 10");
  assert.deepEqual(suppressForModel({ waterfall: [{ step: "a", kept: 400, excluded: 0 }, { step: "b", kept: 400, excluded: 40 }, { step: "c", kept: 380, excluded: 20 }] }).waterfall.map((/** @type {any} */ r) => r.kept),
    [null, 400, null], "the row with the smaller smallest count (20) joins the zero row; the row of 40 stays");
});

test("a levels map hides its small entries and keeps their keys", () => {
  assert.deepEqual(suppressForModel({ diagnostics: { columns: [{ column: "stage", levels: { I: 40, II: 3, III: 25, IV: 32 } }] } }),
    { diagnostics: { columns: [{ column: "stage", levels: { I: 40, II: null, III: null, IV: 32 } }] } });
  assert.deepEqual(suppressForModel({ levels: { A: 2, B: 3 } }), { levels: { A: null, B: null } });
  // A map under any other key is an ordinary object: its keys are not people-count names.
  assert.deepEqual(suppressForModel({ weights: { A: 2, B: 3 } }), { weights: { A: 2, B: 3 } });
  // And a levels map whose values are not all counts is not one.
  assert.deepEqual(suppressForModel({ levels: { A: 2, note: "x" } }), { levels: { A: 2, note: "x" } });
});

test("a count is found wherever it nests, however deep, and there is no cut-off that lets one through", () => {
  let payload = /** @type {any} */ ({ n: 3 });
  for (let i = 0; i < 60; i += 1) payload = { level: i, inner: [payload] };
  const found = JSON.stringify(suppressForModel(payload));
  assert.ok(!found.includes('"n":3'), "a count sixty levels down was suppressed");
  assert.ok(found.includes('"n":null'));
  let tooDeep = /** @type {any} */ ({ n: 3 });
  for (let i = 0; i < 500; i += 1) tooDeep = { inner: tooDeep };
  assert.throws(() => suppressForModel(tooDeep), TypeError, "a payload nested past any real shape is refused, not passed through");
});

test("a payload that refers to itself is refused", () => {
  /** @type {any} */
  const cyclic = { counts: { n: 3 } };
  cyclic.self = cyclic;
  assert.throws(() => suppressForModel(cyclic), TypeError);
  /** @type {any} */
  const inArray = { list: [] };
  inArray.list.push(inArray);
  assert.throws(() => suppressForModel(inArray), TypeError);
  // A value shared by two branches is not a cycle.
  const shared = { n: 3 };
  assert.deepEqual(suppressForModel({ a: shared, b: shared }), { a: { n: null, suppressed: ["n"] }, b: { n: null, suppressed: ["n"] } });
});

test("the input is not modified, and what is not a count passes through as it is", () => {
  const payload = { study: "肺癌 II 期", counts: { realPatients: 5 }, when: "2026-09-29", note: "3 patients", ratio: 0.31, list: [1, 2, 3], nothing: null, flag: true };
  const before = JSON.stringify(payload);
  const shown = suppressForModel(payload);
  assert.equal(JSON.stringify(payload), before, "the caller's object is untouched");
  assert.notEqual(shown, payload);
  assert.equal(shown.study, "肺癌 II 期");
  assert.equal(shown.note, "3 patients", "text is never read for numbers");
  assert.deepEqual(shown.list, [1, 2, 3], "a list of bare numbers is not a list of cells");
  assert.equal(shown.nothing, null);
  assert.equal(suppressForModel(5), 5);
  assert.equal(suppressForModel(null), null);
  assert.equal(suppressForModel("n"), "n");
  assert.deepEqual(suppressForModel([]), []);
});

test("a complement is never emitted: the engine's own remainder is dropped", () => {
  const shown = suppressForModel({ columns: [{ column: "stage", levels: { I: 40, II: 3 }, suppressedLevels: 1, suppressedCount: 3 }] });
  assert.equal("suppressedCount" in shown.columns[0], false);
  assert.equal("suppressedLevels" in shown.columns[0], false);
  // What is emitted of a hidden cell never lets the total be subtracted from.
  const arms = suppressForModel({ n: 100, arms: [{ arm: "A", n: 97 }, { arm: "B", n: 3 }] });
  assert.deepEqual(arms.arms.map((/** @type {any} */ cell) => cell.n), [null, null], "the total is public, so the large cell goes with the small one");
});

test("the shapes the stores produce, end to end: a study read for the runtime", () => {
  const read = {
    what: "population",
    population: { kind: "real", counts: { realPatients: 412, events: 7, effectiveSampleSize: null, generatedRecords: 0 },
      waterfall: [{ step: "入组事件", kept: 412, excluded: 0, indeterminate: 0 }, { step: "无既往治疗", kept: 400, excluded: 9, indeterminate: 3 }] },
    diagnostics: { arms: [{ arm: "试验组", n: 120, events: 80 }, { arm: "外部对照", n: 292, events: 4 }], balance: [{ covariate: "age", smdAdjusted: 0.04 }] },
    snapshot: { columns: [{ column: "stage", levels: { I: 200, II: 150, III: 55, IV: 7 } }] },
  };
  const shown = suppressForModel(read);
  const text = JSON.stringify(shown);
  // Every count that survives is at or above ten, or is a zero standing alone.
  for (const value of numbers(shown.population.counts)) assert.ok(value === 0 || value >= 10 || value < 1 || Number.isInteger(value) === false, String(value));
  assert.equal(shown.population.counts.events, null, "seven events is seven people at most");
  assert.equal(shown.population.counts.realPatients, 412);
  assert.equal(shown.diagnostics.balance[0].smdAdjusted, 0.04, "a standardized difference is not a head count");
  // IV (7) is small; alone it could be subtracted from the rest, so the next smallest, III, goes with it.
  assert.deepEqual(shown.snapshot.columns[0].levels, { I: 200, II: 150, III: null, IV: null });
  assert.ok(!/"n":4\b|"events":4\b|"events":7\b|"IV":7\b/.test(text), text);
  assert.deepEqual(shown.diagnostics.arms.map((/** @type {any} */ cell) => cell.arm), ["试验组", "外部对照"]);
});

test("the floor is a parameter, and a nonsense floor is refused", () => {
  assert.deepEqual(suppressForModel({ n: 4 }, { minCell: 5 }), { n: null, suppressed: ["n"] });
  assert.deepEqual(suppressForModel({ n: 5 }, { minCell: 5 }), { n: 5 });
  assert.throws(() => suppressForModel({ n: 4 }, { minCell: 1 }), RangeError);
  assert.throws(() => suppressForModel({ n: 4 }, { minCell: 2.5 }), RangeError);
  assert.throws(() => suppressForModel({ n: 4 }, { minCell: 0 }), RangeError);
});

test("a property called __proto__ is data, and does not reach the prototype", () => {
  const payload = JSON.parse('{"__proto__":{"n":3},"counts":{"n":4}}');
  const shown = suppressForModel(payload);
  assert.equal(Object.getPrototypeOf(shown), Object.prototype);
  assert.deepEqual(Object.keys(shown).sort(), ["__proto__", "counts"]);
  assert.equal(shown.counts.n, null);
});

test("a null count is an unknown, not a person: a list of rows with a missing count is not a list of cells", () => {
  // The evidence and registry shapes: `events` and `n` are unknown for most rows.
  const values = { values: [
    { parameter: "median_time", arm: "对照", value: 4.2, sampleSize: 250, events: null },
    { parameter: "median_time", arm: "试验", value: 5.1, sampleSize: 6, events: null, n: null },
  ] };
  assert.deepEqual(suppressForModel(clone(values)), values, "nothing here counts a person, so nothing is hidden or hollowed");
  const unknown = { items: [{ id: "a", n: null, value: 1 }, { id: "b", n: null, value: 2 }] };
  assert.deepEqual(suppressForModel(clone(unknown)), unknown);
  // A row that does carry a head count is judged by it, as any cell is.
  const mixed = suppressForModel({ values: [{ arm: "A", value: 0.4, n: null, events: 400 }, { arm: "B", value: 0.5, n: null, events: 300 }] });
  assert.equal(mixed.values[0].value, 0.4, "the unknown `n` next to a large count does not hide the row");
  assert.equal(mixed.values[1].events, 300);
});

test("a null the boundary itself hid still counts as a cell: it reads as zero, and zero is disclosive", () => {
  const hidden = { arm: "A", n: null, suppressed: ["n"] };
  const shown = suppressForModel({ arms: [hidden, { arm: "B", n: 400 }, { arm: "C", n: 350 }] });
  assert.deepEqual(shown.arms.map((/** @type {any} */ cell) => cell.n), [null, 400, null], "the hidden cell is topped up with the smallest of the rest");
  assert.deepEqual(shown.arms[0], { arm: "A", n: null, suppressed: ["n"] });
});

test("a measure whose name counts people is hidden when small, at any depth, and keeps only what it is", () => {
  const payload = { result: { measures: [
    { name: "cohort_size", value: 3, source: "observed", note: "3 of 412" },
    { name: "cohort_size_strict", value: 2, simulated: false, interval: { kind: "confidence", low: 1, high: 4 } },
    { name: "cohort_size_lenient", value: 40, source: "observed" },
    { name: "training_observations", value: 9, source: "observed", unit: "行" },
    { name: "effective_sample_size", value: 6.4, source: "calculated" },
    { name: "rows", value: 5, source: "observed" },
    { name: "hazard_ratio", value: 0.7, interval: { kind: "confidence", low: 0.5, high: 0.9 } },
    { name: "events_treatment", value: 4, source: "reconstructed" },
    { name: "expected_sample_size", value: 6, simulated: true, mcse: 0.1 },
  ], diagnostics: { deep: { deeper: [{ measures: [{ name: "cohort_size", value: 7 }] }] } } } };
  const shown = suppressForModel(clone(payload));
  const [size, strict, lenient, training, ess, rows, hr, reconstructed, expected] = shown.result.measures;
  assert.deepEqual(size, { name: "cohort_size", source: "observed", value: null, suppressed: ["value"] }, "its note is gone with its value");
  assert.deepEqual(strict, { name: "cohort_size_strict", simulated: false, value: null, suppressed: ["value"] }, "and so is its interval");
  assert.equal(lenient.value, 40, "a measure over the floor is shown");
  assert.deepEqual(training, { name: "training_observations", unit: "行", source: "observed", value: null, suppressed: ["value"] });
  assert.equal(ess.value, null);
  assert.equal(rows.value, null);
  assert.equal(hr.value, 0.7, "a measure that is not a head count is not touched");
  assert.equal(reconstructed.value, 4, "a published curve's events are another trial's figure, not this study's people");
  assert.equal(expected.value, 6, "a design's expected sample size is a plan, not people");
  assert.equal(shown.result.diagnostics.deep.deeper[0].measures[0].value, null, "at any depth");
  assert.ok(!JSON.stringify(shown).includes("3 of 412"));
  // Zero and the floor are not small; a hidden measure is not hidden twice.
  assert.equal(suppressForModel({ name: "cohort_size", value: 0 }).value, 0);
  assert.equal(suppressForModel({ name: "cohort_size", value: 10 }).value, 10);
  assert.deepEqual(suppressForModel(suppressForModel({ name: "cohort_size", value: 3 })), { name: "cohort_size", value: null, suppressed: ["value"] });
});

test("the row counts a diagnostics block carries are head counts, judged alone and never as a list's cells", () => {
  const shown = suppressForModel({ diagnostics: { startingRows: 4, keptRows: 3, waterfall: [{ rule: "a", kept: 3, excluded: 1 }] },
    tables: [{ input: "s:subject", rows: 5, columns: [] }, { input: "s:events", rows: 900, columns: [{ column: "x", missing: 4 }] }],
    counts: { realPatients: 412, effectiveSampleSize: 4.5 } });
  assert.equal(shown.diagnostics.startingRows, null);
  assert.equal(shown.diagnostics.keptRows, null);
  assert.deepEqual(shown.diagnostics.suppressed.sort(), ["keptRows", "startingRows"]);
  assert.equal(shown.tables[0].rows, null, "a small table's total is hidden");
  assert.equal(shown.tables[1].rows, 900, "another table's total is not a sibling cell to be topped up around it");
  assert.deepEqual(shown.tables[1].columns, [{ column: "x", missing: 4 }], "and its profile is not hollowed");
  assert.equal(shown.counts.effectiveSampleSize, null, "an effective sample size of an unweighted analysis is the head count");
  assert.equal(shown.counts.realPatients, 412);
});

test("a matching result's tallies and batch counts are head counts under the names the local executor writes (E-19, D16)", () => {
  // The shape `vcr_simulate status` hands back for an evaluation of 60 people, the first batch of 8 (vcrMatchingExecutor).
  const status = { state: "succeeded", result: {
    counts: { realPatients: 8, events: null, effectiveSampleSize: null, generatedRecords: 0 },
    measures: [
      { name: "eligible", value: 3, simulated: false, source: "calculated" }, { name: "ineligible", value: 50, simulated: false, source: "calculated" },
      { name: "insufficient_evidence", value: 5, simulated: false, source: "calculated" }, { name: "pending", value: 0, simulated: false, source: "calculated" },
    ],
    diagnostics: { criteria: 6, subjects: 8, voidedFacts: 2, errors: 0, requestedSubjects: 60, batchOffset: 0, batchSubjects: 8, batchEvaluated: 8,
      batchUnavailable: 0, outsideBatch: 52, subjectsNotEvaluated: 52, inputSnapshotId: "a".repeat(64), nextOffset: 8 },
  } };
  const shown = suppressForModel(clone(status));
  const [eligible, ineligible, insufficient, pending] = shown.result.measures;
  assert.deepEqual(eligible, { name: "eligible", simulated: false, source: "calculated", value: null, suppressed: ["value"] }, "three eligible people are three people");
  assert.equal(ineligible.value, 50);
  assert.equal(insufficient.value, null);
  assert.equal(pending.value, 0, "nobody pending says nothing about a person");
  const diagnostics = shown.result.diagnostics;
  assert.equal(diagnostics.subjects, null);
  assert.equal(diagnostics.batchSubjects, null, "the batch holds 8 people under any key");
  assert.equal(diagnostics.batchEvaluated, null);
  assert.deepEqual(diagnostics.suppressed.sort(), ["batchEvaluated", "batchSubjects", "subjects"]);
  // What is not a head count of this study's people stays: the roster size and the remainder are over the floor; the offset, the criteria and the hash are not people.
  assert.deepEqual([diagnostics.requestedSubjects, diagnostics.outsideBatch, diagnostics.subjectsNotEvaluated, diagnostics.batchUnavailable], [60, 52, 52, 0]);
  assert.deepEqual([diagnostics.criteria, diagnostics.nextOffset, diagnostics.batchOffset, diagnostics.inputSnapshotId], [6, 8, 0, "a".repeat(64)]);
  // A roster of three: every count of it is hidden, whatever it is called.
  const tiny = suppressForModel({ diagnostics: { requestedSubjects: 3, batchSubjects: 3, batchEvaluated: 2, batchUnavailable: 1, outsideBatch: 0, subjectsNotEvaluated: 1 },
    measures: [{ name: "insufficient_evidence", value: 3 }] });
  assert.deepEqual(numbers(tiny).filter((value) => value > 0), []);
});

// --- the diagnostics of the 2026-11-01 remediation (review P0-2): one test per shape ---------------------------------------------------

/** The enrolment-year row the weighting, weighted-Cox and AIPW jobs write, with the shapes of `vcr_enrolment_year`. @param {Record<string, any>} [over] */
const enrolmentYear = (over = {}) => ({
  column: "STARTDT", unit: "calendar year", people: { treated: 30, control: 200 }, readable: { treated: 28, control: 190 }, status: "computed",
  treated: { min: 2014, median: 2016, max: 2018, mean: 2016.1, weightedMean: 2016.1 }, control: { min: 2010, median: 2015, max: 2019, mean: 2014.7, weightedMean: 2016 },
  smdUnadjusted: -0.45, smdAdjusted: 0.04, controlOutsideTrialYears: { share: 0.2, weightedShare: 0.05 },
  byYear: [
    { year: 2014, treated: 12, control: 70, controlWeightShare: 0.3 }, { year: 2015, treated: 2, control: 7, controlWeightShare: 0.04 },
    { year: 2016, treated: 16, control: 123, controlWeightShare: 0.66 },
  ],
  note: "calendar year of the time-zero date", ...over,
});

test("enrolment years: a year with fewer than ten of an arm is hidden with its neighbour, whole, and its identity stays", () => {
  const shown = suppressForModel({ diagnostics: { enrolmentYear: enrolmentYear() } }).diagnostics.enrolmentYear;
  // The year-by-arm cell {2015: 2 treated, 7 control} is small. It is hidden with the next-smallest year (2014), so that the hidden
  // people number ten and sit in two cells; 2016 stays.
  assert.deepEqual(shown.byYear.map((/** @type {any} */ cell) => [cell.year, cell.treated, cell.control, cell.controlWeightShare]),
    [[2014, null, null, undefined], [2015, null, null, undefined], [2016, 16, 123, 0.66]]);
  for (const cell of shown.byYear.slice(0, 2)) assert.deepEqual(cell.suppressed, ["treated", "control"]);
  // The arm totals are large and shown, and so are the year summaries of arms that are large.
  assert.deepEqual(shown.people, { treated: 30, control: 200 });
  assert.equal(shown.treated.median, 2016);
});

test("enrolment years: an arm with fewer than ten people whose date could be read withholds the whole row but what it is", () => {
  const shown = suppressForModel({ diagnostics: { enrolmentYear: enrolmentYear({ readable: { treated: 3, control: 190 } }) } }).diagnostics.enrolmentYear;
  assert.deepEqual(Object.keys(shown).sort(), ["column", "status", "suppressed", "unit", "note"].sort());
  assert.equal(shown.status, "computed");
  // Nothing of the arms is left: not the arm sizes, not the years of three people (their extremes are their dates), not the cells.
  assert.deepEqual(numbers(shown), []);
  assert.ok(shown.suppressed.includes("readable") && shown.suppressed.includes("byYear") && shown.suppressed.includes("treated"));
  // The same for the arm sizes themselves: `people: { treated: 5 }` beside a table total is the subtraction the map rule exists for.
  const small = suppressForModel({ counts: { realPatients: 205 }, diagnostics: { enrolmentYear: enrolmentYear({ people: { treated: 5, control: 200 } }) } });
  assert.deepEqual(numbers(small), [205], "both arm sizes are hidden together, so 205 minus 200 is not 5");
  // A status that read nobody has only the sizes to say: they are hidden the same way, and the status stays.
  const none = suppressForModel({ enrolmentYear: { status: "unreadable", column: "STARTDT", people: { treated: 4, control: 90 }, readable: { treated: 0, control: 0 } } });
  assert.equal(none.enrolmentYear.status, "unreadable");
  assert.deepEqual(numbers(none), []);
});

test("enrolment years: a row of large arms and large years passes untouched, and the same keys are nothing special elsewhere", () => {
  const row = enrolmentYear({ byYear: [{ year: 2014, treated: 14, control: 70 }, { year: 2015, treated: 16, control: 80 }] });
  assert.deepEqual(suppressForModel({ diagnostics: { enrolmentYear: row } }), { diagnostics: { enrolmentYear: row } });
  // `treated` and `control` are a design's planned sample or a mean outside the block, and are not head counts there.
  const design = { design: { treated: 6, control: 4 }, covariate: { treated: 2.5, control: 3 } };
  assert.deepEqual(suppressForModel(clone(design)), design);
});

/** The local calibration of a logistic prognostic model on observed outcomes. @param {Record<string, any>} [over] */
const calibration = (over = {}) => ({
  family: "logistic", source: "observed", n: 120, excluded: 0, events: 3, nonEvents: 117, observedRisk: 0.025, predictedRisk: 0.031, calibrationInLarge: 0.006,
  intercept: { value: -0.2, se: 0.5, low: -1.2, high: 0.8, level: 0.95 }, slopeUnavailable: "too_few_events", slopeNeeds: { events: 10, nonEvents: 10 }, ...over,
});

test("local calibration: with a small event count the people, the events, the non-events and the rate are all hidden, not one subtraction away", () => {
  const shown = suppressForModel({ diagnostics: { localCalibration: calibration() } }).diagnostics.localCalibration;
  for (const key of ["n", "events", "nonEvents", "observedRisk", "calibrationInLarge"]) assert.equal(shown[key], null, key);
  assert.deepEqual([...shown.suppressed].sort(), ["calibrationInLarge", "events", "n", "nonEvents", "observedRisk"]);
  // What is not a head count of the table stays: the predicted risk is the model's, the intercept an estimate, the floors a rule.
  assert.equal(shown.predictedRisk, 0.031);
  assert.equal(shown.intercept.value, -0.2);
  assert.deepEqual(shown.slopeNeeds, { events: 10, nonEvents: 10 });
  assert.equal(shown.slopeUnavailable, "too_few_events");
  // A small number of non-events is the same table: the other way round.
  const mirrored = suppressForModel({ localCalibration: calibration({ events: 117, nonEvents: 3, observedRisk: 0.975, calibrationInLarge: -0.944 }) }).localCalibration;
  assert.deepEqual([mirrored.n, mirrored.events, mirrored.nonEvents, mirrored.observedRisk, mirrored.calibrationInLarge], [null, null, null, null, null]);
});

test("local calibration: a table with enough of both is shown whole, and zero events says nobody is there without a person", () => {
  const big = calibration({ n: 400, events: 130, nonEvents: 270, observedRisk: 0.325, calibrationInLarge: 0.011 });
  assert.deepEqual(suppressForModel({ localCalibration: big }), { localCalibration: big });
  const none = calibration({ n: 120, events: 0, nonEvents: 120, observedRisk: 0, calibrationInLarge: 0.031 });
  assert.deepEqual(suppressForModel({ localCalibration: none }), { localCalibration: none }, "no event at all is not a small cell of events");
});

test("local calibration: a time-to-event table hides its events and the risk read from them, and keeps its people", () => {
  const cox = { family: "cox", n: 120, excluded: 2, events: 4, horizon: 5, observedRisk: 0.04, predictedRisk: 0.05, calibrationInLarge: 0.01, slopeUnavailable: "too_few_events" };
  const shown = suppressForModel({ localCalibration: cox }).localCalibration;
  assert.deepEqual([shown.events, shown.observedRisk, shown.calibrationInLarge], [null, null, null]);
  assert.equal(shown.n, 120, "without a count of non-events the people are no complement of the events");
  assert.equal(shown.predictedRisk, 0.05);
});

test("local calibration: the measures that restate the observed risk go with it, and the rest of the result stays", () => {
  const result = { measures: [
    { name: "calibration_intercept", value: -0.2, source: "calculated", interval: { kind: "confidence", low: -1.2, high: 0.8 } },
    { name: "calibration_in_the_large", value: 0.006, source: "calculated" }, { name: "observed_risk", value: 0.025, source: "observed" },
    { name: "predicted_population_mean", value: 0.031, source: "predicted" },
  ], counts: { realPatients: 120 }, diagnostics: { validPredictions: 120, invalidPredictions: 0, localCalibration: calibration() } };
  const shown = suppressForModel(clone(result));
  assert.deepEqual(shown.measures.map((/** @type {any} */ measure) => [measure.name, measure.value]),
    [["calibration_intercept", -0.2], ["calibration_in_the_large", null], ["observed_risk", null], ["predicted_population_mean", 0.031]]);
  assert.deepEqual(shown.measures[2], { name: "observed_risk", source: "observed", value: null, suppressed: ["value"] });
  // A table shown whole keeps them.
  const whole = suppressForModel(clone({ ...result, diagnostics: { localCalibration: calibration({ n: 400, events: 130, nonEvents: 270 }) } }));
  assert.deepEqual(whole.measures.map((/** @type {any} */ measure) => measure.value), [-0.2, 0.006, 0.025, 0.031]);
  // The predictions an applied equation made for a handful of people are a head count of them.
  const few = suppressForModel({ diagnostics: { validPredictions: 6, invalidPredictions: 2 } });
  assert.deepEqual([few.diagnostics.validPredictions, few.diagnostics.invalidPredictions], [null, null]);
});

test("a batch reading's result: the people and records it was asked to read, the ones read before and the ones the table decided against", () => {
  const result = { counts: { realPatients: 7, events: null, effectiveSampleSize: null, generatedRecords: 0 },
    measures: [{ name: "records_read", value: 6 }, { name: "facts_kept", value: 14 }, { name: "records_already_read", value: 1 }, { name: "records_failed", value: 0 }],
    diagnostics: { protocolVersionId: "pv_1", variables: 12, peopleSelected: 7, recordsToRead: 7, recordsRead: 6, recordsAlreadyRead: 1, recordsFailed: 0, remaining: 1,
      factsKept: 14, factsRefused: 2, prefiltered: 3, estimate: { people: 7, records: 7, characters: 9000, inputTokens: 19500, outputTokens: 14000, cost: 0.2, basis: "ceiling" },
      used: { inputTokens: 8000, outputTokens: 3000 } } };
  const shown = suppressForModel(clone(result));
  const d = shown.diagnostics;
  assert.deepEqual([d.peopleSelected, d.recordsToRead, d.recordsRead, d.recordsAlreadyRead, d.prefiltered], [null, null, null, null, null]);
  assert.deepEqual([d.estimate.people, d.estimate.records], [null, null], "the estimate states the same people and records");
  assert.deepEqual(shown.measures.map((/** @type {any} */ measure) => measure.value), [null, 14, null, 0], "records read and read before are head counts; facts are not");
  // What is not a head count stays: the cost, the tokens, the facts, the failures, the variables.
  assert.deepEqual([d.estimate.inputTokens, d.estimate.cost, d.factsKept, d.recordsFailed, d.variables, d.used.inputTokens], [19500, 0.2, 14, 0, 12, 8000]);
  // A batch of a hundred is shown whole.
  const big = suppressForModel({ diagnostics: { peopleSelected: 100, recordsToRead: 120, recordsRead: 118, prefiltered: 31, estimate: { people: 100, records: 120 } } });
  assert.deepEqual(big, { diagnostics: { peopleSelected: 100, recordsToRead: 120, recordsRead: 118, prefiltered: 31, estimate: { people: 100, records: 120 } } });
});

test("a batch reading's start answer: the plan's counts are judged one by one, and `plan` or `estimate` are nothing special elsewhere", () => {
  const answer = { action: "start", kind: "match_extract", state: "queued", jobId: "job_1",
    plan: { toRead: 52, alreadyRead: 0, prefiltered: 3, noDocuments: 2, deferred: 0 }, estimate: { people: 52, records: 60, inputTokens: 90000, cost: 0.9 }, bounded: { limit: 100, deferred: 5 } };
  const shown = suppressForModel(clone(answer));
  assert.deepEqual(shown.plan, { toRead: 52, alreadyRead: 0, prefiltered: null, noDocuments: null, deferred: 0, suppressed: ["prefiltered", "noDocuments"] });
  assert.deepEqual(shown.estimate, { people: 52, records: 60, inputTokens: 90000, cost: 0.9 });
  assert.deepEqual(shown.bounded, { limit: 100, deferred: 5 }, "a limit and the people left over are not the block's keys");
  assert.deepEqual(suppressForModel({ estimate: { people: 4 }, plan: { toRead: 3, name: "x", estimate: 4 } }),
    { estimate: { people: null, suppressed: ["people"] }, plan: { toRead: null, name: "x", estimate: 4, suppressed: ["toRead"] } });
  // `estimate` in another place is a point estimate and `plan` a plan: no key there is a count.
  assert.deepEqual(suppressForModel({ result: { estimate: 4, plan: { rule: "x", records: 3 } } }), { result: { estimate: 4, plan: { rule: "x", records: 3 } } });
});

test("a propensity trimming's arms: a small removed group takes the cell, the totals and the measure with it (review P0-1)", () => {
  const trim = {
    arms: [{ arm: "treated", n: 295, kept: 294, removed: 1, removedShare: 0.0034 }, { arm: "control", n: 305, kept: 305, removed: 0, removedShare: 0 }],
    removedTotal: 1, keptTotal: 599,
    baseline: [{ covariate: "age", arm: "treated", binary: false, keptMean: 63.6, removedMean: 97.5 }],
  };
  const shown = suppressForModel({ diagnostics: { trim }, measures: [{ name: "trimmed_treated", value: 1, unit: "例" }, { name: "trimmed_control", value: 0, unit: "例" }] });
  assert.deepEqual(shown.diagnostics.trim.arms[0], { arm: "treated", n: null, kept: null, removed: null, suppressed: ["n", "kept", "removed"] });
  assert.equal(shown.diagnostics.trim.removedTotal, null, "the total is the removed person's count");
  assert.deepEqual(shown.measures[0], { name: "trimmed_treated", unit: "例", value: null, suppressed: ["value"] });
  assert.equal(shown.measures[1].value, 0, "nobody removed is not a person");
  assert.equal(JSON.stringify(shown).includes("0.0034"), false, "the share is not left beside the hidden count");
});

test("a mean under a name that is not a count is left alone, and a count under a new name is hidden (review P0-1, P0-2)", () => {
  // the baseline of a trimming is named for what it is, so `kept` can be a head count only where a head count is
  assert.deepEqual(suppressForModel({ baseline: [{ covariate: "female", arm: "treated", keptMean: 0.4, removedMean: 8.2 }] }), { baseline: [{ covariate: "female", arm: "treated", keptMean: 0.4, removedMean: 8.2 }] });
  const imputation = suppressForModel({ imputation: { rowsAnalysed: 300, rowsIncomplete: 3, covariates: [{ name: "age", missing: 3 }, { name: "bmi", missing: 57 }], completeCase: { rows: 297, droppedRows: 3 } } }).imputation;
  assert.equal(imputation.rowsIncomplete, null);
  assert.equal(imputation.rowsAnalysed, null, "the part alone is a subtraction from the whole");
  assert.deepEqual([imputation.completeCase.rows, imputation.completeCase.droppedRows], [null, null]);
  assert.deepEqual(imputation.covariates.map((cell) => cell.missing), [null, null], "a small cell takes the next smallest with it");
  assert.deepEqual(imputation.covariates.map((cell) => cell.name), ["age", "bmi"], "and keeps its name");
  // a refusal's counts: the smaller of the two groups goes like events
  assert.deepEqual(suppressForModel({ diagnostics: { inputRows: 600, usedRows: 8, excludedRows: 592, needed: 15, smallerGroup: 4 } }).diagnostics,
    { inputRows: null, usedRows: null, excludedRows: null, needed: 15, smallerGroup: null, suppressed: ["inputRows", "usedRows", "excludedRows", "smallerGroup"] });
});

test("a target-trial emulation's people by when they began: the parts make the whole, the waits of a handful of people are withheld (review P0-2)", () => {
  const design = { people: 14, startedWithinGrace: 2, startedAfterGrace: 2, neverStarted: 10, startedAtTimeZero: 2, waitingTime: { max: 4, median: 2, people: 4 }, startsByArm: { "0": 155, "1": 3 }, personTrials: 248 };
  const shown = suppressForModel({ design }).design;
  assert.deepEqual([shown.people, shown.startedWithinGrace, shown.startedAfterGrace, shown.neverStarted, shown.startedAtTimeZero], [null, null, null, null, null]);
  assert.deepEqual(shown.waitingTime, { suppressed: ["max", "median", "people"] }, "the median and the longest wait of four people are those people's values");
  assert.deepEqual(shown.startsByArm, { "0": null, "1": null }, "an arm map hides the small cell and the next with it");
  assert.equal(shown.personTrials, 248);
  // enough people: nothing is hidden
  const large = { people: 250, startedWithinGrace: 97, startedAfterGrace: 56, neverStarted: 97, startedAtTimeZero: 40, waitingTime: { max: 17, median: 2, people: 153 } };
  assert.deepEqual(suppressForModel({ design: large }), { design: large });
  // the people a design was run on when it is the only count that is small
  assert.deepEqual(suppressForModel({ design: { people: 6, gracePeriod: 3 } }).design, { people: null, gracePeriod: 3, suppressed: ["people"] });
  assert.deepEqual(suppressForModel({ checks: { persons: 5, personPeriods: 40, eligiblePeriods: 38, recordsCutShort: 0 } }).checks,
    { persons: null, personPeriods: 40, eligiblePeriods: 38, recordsCutShort: 0, suppressed: ["persons"] });
});
