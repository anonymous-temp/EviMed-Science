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
  VCR_PEOPLE_COUNT_FIELDS,
  VCR_PEOPLE_COUNT_MAP_KEYS,
  VCR_PEOPLE_COUNT_MEASURES,
  VCR_PEOPLE_COUNT_SCALAR_FIELDS,
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
    "indeterminate", "cohortSize", "screened", "eligible", "enrolled", "referred", "contacted", "candidates"]);
  assert.deepEqual([...VCR_PEOPLE_COUNT_MAP_KEYS], ["levels"]);
  assert.deepEqual([...VCR_PEOPLE_COUNT_SCALAR_FIELDS], ["rows", "startingRows", "keptRows", "trainingObservations", "effectiveSampleSize"]);
  assert.deepEqual([...VCR_PEOPLE_COUNT_MEASURES], ["rows", "cohort_size", "cohort_size_strict", "cohort_size_lenient", "training_observations", "effective_sample_size"]);
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
