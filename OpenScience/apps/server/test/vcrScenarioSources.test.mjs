// A paper's number named by the call that computes with it (2026-11-02): which fields a paper can be tied to, and what is said of the rest.
import assert from "node:assert/strict";
import test from "node:test";
import { VCR_SOURCES_MAX, assumptionSourceEntry, carrySourceEntries, checkSourceEntries, normalizeSourceField, planSourceEntry, readSourceEntries } from "../src/vcrScenarioSources.mjs";

const SENTENCE = "13.8 months (95% CI, 12.3–16.1) with sorafenib";
const scenario = { endpoint: { type: "time_to_event" }, truth: { hazardRatio: 0.75, controlMedian: 13.8 }, timeUnit: "weeks" };
const entry = (/** @type {Record<string, any>} */ more = {}) => ({ index: 0, field: "truth.controlMedian", publication: { kind: "pmid", id: "37676259" }, quote: SENTENCE, ...more });

test("the list is read as it was written: the forms of a paper's id, at most the cap, and what cannot be read is said", () => {
  const read = readSourceEntries([{ field: "truth.controlMedian", publication: "PMID: 37676259", quote: ` ${SENTENCE} ` }, { field: "truth.hazardRatio", doi: "10.1056/NEJMoa1915745", quote: "HR 0.75" },
    { field: "x", publication: "HIMALAYA", quote: "" }, "not an object"]);
  assert.deepEqual(read.entries.map((row) => row.publication), [{ kind: "pmid", id: "37676259" }, { kind: "doi", id: "10.1056/nejmoa1915745" }, null, null]);
  assert.equal(read.entries[0].quote, SENTENCE);
  assert.equal(readSourceEntries(Array.from({ length: VCR_SOURCES_MAX + 3 }, () => ({}))).said[0].because, "too_many_sources");
  assert.equal(readSourceEntries("PMID 1").said[0].because, "sources_not_a_list");
  assert.deepEqual(readSourceEntries(undefined), { entries: [], said: [] });
});

test("a field is the scenario's own path, however the run counts a list, and only the fields a paper's number can fill are tied", () => {
  for (const spelling of ["truth.controlMedian", "scenario.truth.controlMedian", "configuration.truth.controlMedian"]) assert.equal(normalizeSourceField(spelling), "truth.controlMedian");
  for (const spelling of ["truths[0].hazardRatio", "truths.2.hazardRatio", "truths[ 1 ].hazardRatio"]) assert.equal(normalizeSourceField(spelling), "truths[].hazardRatio");
  const planned = planSourceEntry(entry(), scenario);
  assert.ok(planned.ok);
  assert.deepEqual([planned.value, planned.unit, planned.key, planned.premisePath, planned.spec.armRole], [13.8, "weeks", "control_median_tte", "truth.controlMedian", "control"]);
  const grid = planSourceEntry(entry({ field: "truths[1].hazardRatio" }), { endpoint: { type: "time_to_event" }, truths: [{ hazardRatio: 1 }, { hazardRatio: 0.7 }] });
  assert.ok(grid.ok);
  assert.deepEqual([grid.value, grid.key, grid.premisePath, grid.spec.armRole], [0.7, "hazard_ratio_tte", "truths[].hazardRatio", "contrast"]);
  const binary = planSourceEntry(entry({ field: "truth.controlRate" }), { endpoint: { type: "binary" }, truth: { controlRate: 0.25 } });
  assert.ok(binary.ok);
  assert.deepEqual([binary.key, binary.unit], ["control_event_rate", ""], "a rate's card key is exact, as the binding rule reads it");
});

test("an entry that cannot be tied says why by its field, and the reason is the one a run can fix", () => {
  const because = (/** @type {any} */ planned) => (planned.ok ? "ok" : planned.because);
  assert.equal(because(planSourceEntry(entry({ field: "accrual.duration" }), scenario)), "field_not_supported");
  assert.equal(because(planSourceEntry(entry({ field: "" }), scenario)), "field_not_supported");
  assert.equal(because(planSourceEntry(entry({ field: "truth.controlRate" }), scenario)), "field_not_for_endpoint");
  assert.equal(because(planSourceEntry(entry({ publication: null }), scenario)), "publication_unreadable");
  assert.equal(because(planSourceEntry(entry({ quote: "" }), scenario)), "quote_missing");
  assert.equal(because(planSourceEntry(entry(), { endpoint: { type: "time_to_event" }, truth: {} })), "no_number_at_field");
  assert.equal(because(planSourceEntry(entry(), { endpoint: { type: "time_to_event" }, truth: { controlMedian: "13.8" } })), "no_number_at_field", "a number the run wrote as text is not a number here");
  // a design object states its endpoint beside the configuration
  assert.equal(because(planSourceEntry(entry(), { truth: { controlMedian: 13.8 } }, "time_to_event")), "ok");
  assert.deepEqual(checkSourceEntries([{ field: "truth.controlMedian", publication: "PMID 1", quote: "13.8" }, { field: "design.n", publication: "PMID 1", quote: "x" }], scenario)
    .map((row) => [row.field, row.state]), [["truth.controlMedian", "ready"], ["design.n", "assumption"]]);
});

test("nothing a store does can fail the call: a throwing writer leaves the premise an assumption and says so, and the same entry is the same card", async () => {
  const throwing = await carrySourceEntries({ raw: [{ field: "truth.controlMedian", publication: "PMID 1", quote: SENTENCE }], scenario,
    write: async () => { throw new Error("database down"); }, cards: async () => [], evidence: async () => [] });
  assert.deepEqual(throwing.bound, []);
  assert.deepEqual([throwing.report[0].state, throwing.report[0].because], ["assumption", "unavailable"]);

  /** @type {string[]} */ const written = [];
  const card = { id: "asm_1", key: "control_median_tte", version: 3, pointValue: 13.8, sourceKind: "external_evidence", evidenceIds: ["evd_1"] };
  const row = { id: "evd_1", parameter: "control_median", quote: SENTENCE, locator: { verification: "reported_unverified", publication: { kind: "pmid", id: "1" } } };
  const reused = await carrySourceEntries({ raw: [{ field: "truth.controlMedian", publication: "PMID 1", quote: SENTENCE }], scenario,
    write: async (what) => { written.push(what); return { ids: [], issues: [] }; }, cards: async () => [card], evidence: async () => [row] });
  assert.deepEqual(written, [], "nothing is written for an entry the study already holds");
  assert.deepEqual(reused.bound, [{ key: "control_median_tte", version: 3, path: "truth.controlMedian", value: 13.8 }]);
  assert.deepEqual([reused.report[0].state, reused.report[0].checked], ["carried", false], "and it keeps saying it was not checked");
});

test("an assumption written with its paper is the single entry its key names; a key no paper can state is written as the run's own", () => {
  const entryOf = assumptionSourceEntry({ key: "control_median_os", name: "对照组中位 OS", unit: "months", pointValue: 13.8, sources: [{ publication: "PMID 37676259", quote: SENTENCE }] });
  assert.ok("raw" in entryOf);
  assert.deepEqual(entryOf.raw, [{ publication: "PMID 37676259", quote: SENTENCE, field: "truth.controlMedian" }]);
  assert.deepEqual([entryOf.scenario.truth, entryOf.scenario.timeUnit, entryOf.card.key], [{ controlMedian: 13.8 }, "months", "control_median_os"]);
  assert.equal(/** @type {any} */ (assumptionSourceEntry({ key: "accrual_rate", pointValue: 3, sources: [{}] })).because, "field_not_supported");
  assert.equal(/** @type {any} */ (assumptionSourceEntry({ key: "hazard_ratio", pointValue: 0.75, sources: [{}, {}] })).because, "one_source");
});
