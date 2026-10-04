import test from "node:test";
import assert from "node:assert/strict";
import * as domain from "../index.mjs";

const { bindingGaps, bindingSources, valueBindingStatus, applyBindingFormat } = domain;
// Bindings are read by the path a test asserts, so the functions that build them answer `any` here.
/** @param {Parameters<typeof domain.bindPrintedNumbers>[0]} input @returns {{ kind: string, items: any[], unbound: any[], examined: number, truncated: boolean }} */
const bindPrintedNumbers = (input) => domain.bindPrintedNumbers(input);
/** @param {Parameters<typeof domain.renderWithBindings>[0]} input @returns {{ text: string, unparsed: string[], unresolved: any[], items: any[], unbound: any[], examined: number, renderedCount: number, truncated: boolean, kind: string }} */
const renderWithBindings = (input) => domain.renderWithBindings(input);
/** @param {Parameters<typeof domain.valueBindingRecord>[0]} input @returns {any} */
const valueBindingRecord = (input) => domain.valueBindingRecord(input);
/** @param {unknown} input @returns {any} */
const projectValueBindings = (input) => domain.projectValueBindings(input);
/** @param {Parameters<typeof domain.changeImpact>[0]} input @returns {{ dependents: any[], summary: any }} */
const changeImpact = (input) => domain.changeImpact(input);
/** @param {unknown} input @returns {{ values: any[], truncated: boolean }} */
const flattenMachineValues = (input) => domain.flattenMachineValues(input);

const CALC = `rv_${"a".repeat(64)}`;
const NEXT = `rv_${"b".repeat(64)}`;
/** @param {string} [versionId] @param {Array<{ key: string, value: number, unit?: string }>} [values] @param {string} [alias] */
const calculation = (versionId = CALC, values = undefined, alias = "pool") => ({ versionId, digest: "d".repeat(64), path: "result.json", alias,
  values: values ?? [
    { key: "values.pooled_effect", value: 0.7134, unit: "odds_ratio" },
    { key: "values.ci_lower", value: 0.5201, unit: "odds_ratio" },
    { key: "values.ci_upper", value: 0.9087, unit: "odds_ratio" },
    { key: "values.pooled_log", value: -0.3376, unit: "log_odds_ratio" },
    { key: "values.i_squared", value: 41.234, unit: "percent" },
    { key: "values.n_participants", value: 1284, unit: "count" },
    { key: "values.weight_fraction", value: 0.31874 },
  ] });

test("a typed number binds to the one machine value it equals at its own precision, and the binding records the rounding", () => {
  const body = "合并 OR 为 0.71（95% CI 0.52–0.91），I² 为 41.2%，共 1,284 人。";
  const { items, unbound } = bindPrintedNumbers({ body, path: "report.md", calculations: [calculation()] });
  const byKey = Object.fromEntries(items.map((item) => [item.calculation.key, item]));
  assert.deepEqual(Object.keys(byKey).sort(), ["values.ci_lower", "values.ci_upper", "values.i_squared", "values.n_participants", "values.pooled_effect"]);
  assert.equal(byKey["values.pooled_effect"].printed, "0.71");
  assert.equal(byKey["values.pooled_effect"].calculation.value, 0.7134, "the binding holds the machine value, the report holds its rounding");
  assert.deepEqual(byKey["values.pooled_effect"].format, { id: "round", places: 2 });
  assert.equal(byKey["values.pooled_effect"].calculation.unit, "odds_ratio");
  assert.equal(byKey["values.i_squared"].printed, "41.2%");
  assert.equal(byKey["values.n_participants"].format.grouped, true);
  assert.deepEqual(byKey["values.pooled_effect"].locator, { kind: "text", line: 1, column: 8 });
  assert.equal(byKey["values.pooled_effect"].basis, "matched");
  // 95 is the confidence level of the interval the words name; it is no value of this calculation.
  assert.deepEqual(unbound.map((item) => item.printed), ["95%"]);
  assert.equal(unbound[0].reason, "no_matching_value");
});

test("a fraction printed as a percentage and a magnitude printed without its sign are bound, and said to be", () => {
  const { items } = bindPrintedNumbers({ body: "权重占 31.9%；对数效应下降 0.34；另有 -0.3376。", path: "r.md", calculations: [calculation()] });
  const weight = items.find((item) => item.calculation.key === "values.weight_fraction");
  assert.deepEqual(weight.format, { id: "round", places: 1, scale: 100 });
  const logs = items.filter((item) => item.calculation.key === "values.pooled_log");
  assert.equal(logs.length, 2);
  assert.equal(logs.find((item) => item.printed === "0.34").format.magnitude, true);
  assert.equal(logs.find((item) => item.printed === "-0.3376").format.magnitude, undefined);
});

test("a whole number must equal a whole machine value, so a printed 46 does not bind a weight of 46.3", () => {
  const near = calculation(CALC, [{ key: "values.weight", value: 46.3, unit: "percent" }]);
  const { items, unbound } = bindPrintedNumbers({ body: "权重 46 与 46.3。", path: "r.md", calculations: [near] });
  assert.deepEqual(items.map((item) => item.printed), ["46.3"]);
  assert.deepEqual(unbound.map((item) => [item.printed, item.reason]), [["46", "differs_from_value"]]);
});

test("a number near a machine value but not equal to it is named as differing, with the value; a number near none is simply unbound", () => {
  const { items, unbound } = bindPrintedNumbers({ body: "合并 OR 为 0.73，另有 3.14。", path: "r.md", calculations: [calculation()] });
  assert.equal(items.length, 0);
  const near = unbound.find((item) => item.printed === "0.73");
  assert.equal(near.reason, "differs_from_value");
  assert.deepEqual(near.candidates, [{ versionId: CALC, key: "values.pooled_effect", value: 0.7134 }], "the stale-looking number points at the value it probably meant");
  assert.equal(unbound.find((item) => item.printed === "3.14").reason, "no_matching_value");
});

test("a number that two values both print is ambiguous, never bound by a guess", () => {
  const twins = calculation(CALC, [{ key: "values.a", value: 0.7134 }, { key: "values.b", value: 0.7149 }, { key: "values.c", value: 0.25 }]);
  const { items, unbound } = bindPrintedNumbers({ body: "效应 0.71 与 0.25。", path: "r.md", calculations: [twins] });
  assert.deepEqual(items.map((item) => item.calculation.key), ["values.c"]);
  assert.equal(unbound[0].reason, "ambiguous");
  assert.deepEqual(unbound[0].candidates.map((/** @type {any} */ candidate) => candidate.key), ["values.a", "values.b"]);
});

test("years, dates, locators, citations, code, addresses and the reference list are not numbers of the analysis", () => {
  const body = ["# 2026 年报告", "", "第 3 页图 2 [12]，见 `n = 345` 与 https://example.org/345.5。", "纳入于 2025-03-04 的研究。", "```", "OR 0.71 in a code block 9999", "```", "## 参考文献", "1. Smith 2020;345:678."].join("\n");
  const { items, unbound, examined } = bindPrintedNumbers({ body, path: "r.md", calculations: [calculation()] });
  assert.deepEqual([items, unbound, examined], [[], [], 0]);
});

test("a table cell and a vector figure's text bind like prose; a raster figure and a document are said not to be checkable", () => {
  const csv = "study,yi,vi\nA,0.7134,0.04\nB,0.5201,0.09\n";
  const table = bindPrintedNumbers({ body: csv, path: "studies.csv", calculations: [calculation()] });
  assert.deepEqual(table.items.map((item) => [item.calculation.key, item.locator]), [["values.pooled_effect", { kind: "cell", row: 2, column: 2 }], ["values.ci_lower", { kind: "cell", row: 3, column: 2 }]]);
  assert.deepEqual(table.unbound.map((item) => item.printed), ["0.04", "0.09"]);
  const svg = '<svg><text x="1">OR 0.71 [0.52, 0.91]</text><text>I² = 41.2%</text><title>Forest plot</title></svg>';
  const figure = bindPrintedNumbers({ body: svg, path: "forest.svg", calculations: [calculation()] });
  assert.deepEqual(figure.items.map((item) => item.calculation.key).sort(), ["values.ci_lower", "values.ci_upper", "values.i_squared", "values.pooled_effect"]);
  assert.equal(figure.items[0].locator.kind, "svg");
  assert.equal(bindPrintedNumbers({ body: "", path: "forest.png", calculations: [calculation()] }).kind, "binary");
  assert.equal(valueBindingStatus({ kind: "binary", calculations: 1, items: 0, unbound: 0, examined: 0 }), "not_checkable");
  assert.equal(valueBindingStatus({ kind: "text", calculations: 0, items: 0, unbound: 0, examined: 3 }), "no_calculation", "no calculation in scope: nothing to be unbound against");
  assert.equal(valueBindingStatus({ kind: "values", calculations: 1, items: 0, unbound: 0, examined: 0 }), "not_checked");
  assert.equal(valueBindingStatus({ kind: "text", calculations: 1, items: 2, unbound: 1, examined: 3 }), "partly_bound");
  assert.equal(valueBindingStatus({ kind: "text", calculations: 1, items: 0, unbound: 2, examined: 2 }), "unbound");
  assert.equal(valueBindingStatus({ kind: "text", calculations: 1, items: 3, unbound: 0, examined: 3 }), "bound");
  assert.equal(valueBindingStatus({ kind: "text", calculations: 1, items: 0, unbound: 0, examined: 0 }), "no_numbers");
});

test("a report that references values has the platform write them; its own typed numbers stay and are matched or listed", () => {
  const template = "合并 OR {{n:pool.values.pooled_effect|f2}}（{{n:pool.values.ci_lower|f2}}–{{n:pool.values.ci_upper|f2}}），I² {{n:pool.values.i_squared|pct1}}。缺 {{n:pool.values.nothing|f2}}。共 1,284 人，另有 77 例。";
  const out = renderWithBindings({ template, path: "report.md", calculations: [calculation()] });
  assert.equal(out.text, "合并 OR 0.71（0.52–0.91），I² 41.2%。缺 未计算。共 1,284 人，另有 77 例。");
  const rendered = out.items.filter((item) => item.basis === "rendered");
  assert.deepEqual(rendered.map((item) => [item.calculation.key, item.printed, item.format.id]),
    [["values.pooled_effect", "0.71", "f2"], ["values.ci_lower", "0.52", "f2"], ["values.ci_upper", "0.91", "f2"], ["values.i_squared", "41.2%", "pct1"]]);
  assert.equal(rendered[0].calculation.value, 0.7134, "the printed number IS the machine value, formatted by the recorded rule");
  assert.deepEqual(out.unresolved, [{ path: "pool.values.nothing", reason: "no_such_value" }]);
  assert.deepEqual(out.items.filter((item) => item.basis === "matched").map((item) => item.printed), ["1,284"], "a typed number that equals a value is matched");
  assert.deepEqual(out.unbound.map((item) => item.printed), ["77"], "one that matches nothing is listed, and still in the text");
  assert.equal(out.renderedCount, 4);
  const record = valueBindingRecord({ ...out, calculations: [calculation()] });
  assert.equal(record.status, "partly_bound");
  assert.deepEqual(record.counts, { bound: 5, rendered: 4, unbound: 1, ambiguous: 0, unresolved: 1 });
  assert.deepEqual(bindingGaps(record), ["values_unbound", "values_unresolved"]);
  assert.deepEqual(bindingSources(record), [CALC]);
});

test("a results document's numbers become machine values with the unit their object states", () => {
  const { values, truncated } = flattenMachineValues({ schemaVersion: 1, analyses: [{ id: "a1", status: "complete", estimate: 1.25, interval: { lower: 0.8, upper: 1.9, level: 0.95 }, pValue: 0.034, n: { treatment: 120, control: 118 },
    effect: { value: 12.5, unit: "mmHg", interval: { low: 3, high: 22 } } }, { id: "a2", estimate: Number.NaN }] });
  assert.equal(truncated, false);
  const byKey = Object.fromEntries(values.map((value) => [value.key, value]));
  assert.equal(byKey["analyses[0].estimate"].value, 1.25);
  assert.equal(byKey["analyses[0].interval.lower"].value, 0.8);
  assert.equal(byKey["analyses[0].n.treatment"].value, 120);
  assert.equal(byKey["analyses[0].effect.value"].unit, "mmHg");
  assert.equal(byKey["analyses[0].effect.interval.high"].unit, "mmHg", "an interval inside a measure keeps the measure's unit");
  assert.equal(byKey["analyses[0].pValue"].unit, undefined, "a p value is on a scale of its own");
  assert.equal(byKey["analyses[1].estimate"], undefined, "a non-finite number is not a value");
  assert.equal(Object.hasOwn(byKey, "schemaVersion"), true, "bookkeeping numbers are values too; binding them is the matcher's call, not the flattener's");
});

test("when a calculation is replaced, only the values bound to it move, and a rounding that still prints the same words is not a change", () => {
  const original = valueBindingRecord({ ...bindPrintedNumbers({ body: "合并 OR 0.71（0.52–0.91），I² 41.2%。", path: "report.md", calculations: [calculation()] }), calculations: [calculation()] });
  const other = valueBindingRecord({ ...bindPrintedNumbers({ body: "无关的 OR 0.25", path: "other.md", calculations: [calculation(`rv_${"c".repeat(64)}`, [{ key: "x", value: 0.25 }])] }),
    calculations: [calculation(`rv_${"c".repeat(64)}`, [{ key: "x", value: 0.25 }])] });
  const dependents = [{ versionId: `rv_${"1".repeat(64)}`, path: "report.md", bindings: original }, { versionId: `rv_${"2".repeat(64)}`, path: "other.md", bindings: other }];
  const moved = [
    { key: "values.pooled_effect", value: 0.7141, unit: "odds_ratio" },   // still prints 0.71
    { key: "values.ci_lower", value: 0.4811, unit: "odds_ratio" },        // prints 0.48 now
    { key: "values.i_squared", value: 41.234, unit: "count" },            // another unit
    // values.ci_upper is gone
  ];
  const impact = changeImpact({ before: { versionId: CALC, machineValues: calculation().values }, after: { versionId: NEXT, machineValues: moved }, dependents });
  assert.equal(impact.dependents.length, 1, "a version bound to another calculation is not listed: it keeps its identity");
  const [row] = impact.dependents;
  assert.equal(row.path, "report.md");
  assert.equal(row.needsSuccessor, true);
  assert.equal(row.unchanged, 1, "the rounding survived: 0.7134 → 0.7141 still prints 0.71");
  assert.deepEqual(row.affected.map((/** @type {any} */ item) => [item.key, item.status, item.printedNow]).sort(),
    [["values.ci_lower", "changed", "0.48"], ["values.ci_upper", "removed", null], ["values.i_squared", "unit_changed", null]]);
  const none = changeImpact({ before: { versionId: CALC, machineValues: calculation().values }, after: { versionId: NEXT, machineValues: calculation().values }, dependents });
  assert.equal(none.dependents[0].needsSuccessor, false);
  assert.equal(none.summary.affectedValues, 0);
});

test("applying a recorded format reproduces what was printed, so a binding can be re-read later", () => {
  assert.equal(applyBindingFormat({ id: "round", places: 2 }, 0.7134, "odds_ratio"), "0.71");
  assert.equal(applyBindingFormat({ id: "round", places: 0, grouped: true }, 1284, "count"), "1,284");
  assert.equal(applyBindingFormat({ id: "round", places: 1, scale: 100 }, 0.41234, null), "41.2");
  assert.equal(applyBindingFormat({ id: "round", places: 2, magnitude: true }, -0.3376, null), "0.34");
  assert.equal(applyBindingFormat({ id: "pct1" }, 41.234, "percent"), "41.2%");
  assert.equal(applyBindingFormat({ id: "pct1" }, 41.234, "log_odds_ratio"), null, "a unit the format cannot be true of prints nothing");
});

test("stored bindings are a closed projection: unknown keys, bad versions and prose of the report do not survive", () => {
  const projected = projectValueBindings({ status: "bound", secret: "x", calculations: [{ versionId: "nope" }, { versionId: CALC, digest: "d".repeat(64) }],
    items: [{ basis: "matched", printed: "0.71", context: "a sentence from the report", calculation: { versionId: CALC, key: "k", value: 0.7134, unit: "u" }, format: { id: "round", places: 2, evil: 1 } },
      { printed: "x", calculation: { versionId: "bad", key: "k", value: 1 } }, { printed: "1", calculation: { versionId: CALC, key: "k", value: Number.NaN } }],
    unbound: [{ printed: "9", reason: "invented" }] });
  assert.equal(projected.calculations.length, 1);
  assert.equal(projected.items.length, 1);
  assert.equal(projected.items[0].context, undefined);
  assert.deepEqual(projected.items[0].format, { id: "round", places: 2 });
  assert.equal(projected.unbound[0].reason, "no_matching_value");
  assert.equal(projected.secret, undefined);
});
