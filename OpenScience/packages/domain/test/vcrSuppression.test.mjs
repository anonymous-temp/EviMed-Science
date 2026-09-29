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
});

test("a count of 1 to 9 that stands alone becomes null, and its object says which keys it hid", () => {
  assert.deepEqual(suppressForModel({ counts: { realPatients: 7, events: 3, effectiveSampleSize: 6.2, generatedRecords: 0 } }),
    { counts: { realPatients: null, events: null, effectiveSampleSize: 6.2, generatedRecords: 0, suppressed: ["realPatients", "events"] } });
  assert.deepEqual(suppressForModel({ n: 9 }), { n: null, suppressed: ["n"] });
  assert.deepEqual(suppressForModel({ n: 10 }), { n: 10 }, "ten is the floor, and is shown");
  assert.deepEqual(suppressForModel({ n: 0 }), { n: 0 }, "a lone zero says nothing about a person");
  assert.deepEqual(suppressForModel({ n: 1 }), { n: null, suppressed: ["n"] });
  // A key that is not a head count is not touched, however small.
  assert.deepEqual(suppressForModel({ effectiveSampleSize: 3, mean: 4, smd: 0.05, alpha: 0.025 }), { effectiveSampleSize: 3, mean: 4, smd: 0.05, alpha: 0.025 });
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
