// The quality report of a synthetic population, 1.1.0 (algorithm round P1, P2): the copies combined by the rules for synthetic data, the false-positive rate of an
// analysis on the generator's own copies, and the records easiest to recognise. The engine's real results (tests/numeric N96, N97 hold their numbers to references)
// read into the rows the population page shows.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { qualityReportView } from "../src/vcrViewsTabs.mjs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/vcr-synthetic-inference/${name}.json`, import.meta.url), "utf8"));
const rows = (view, group) => view.groups.find((entry) => entry.key === group)?.rows ?? [];
/** Every string of a payload: a back-office word would show as ascii with underscores or a dot. */
const strings = (node) => (typeof node === "string" ? [node] : Array.isArray(node) ? node.flatMap(strings) : node && typeof node === "object" ? Object.values(node).flatMap(strings) : []);

test("a synthesis with a calibration reports the three false-positive rates, each with its Monte Carlo error", () => {
  const view = qualityReportView(fixture("synthesis").diagnostics.quality);
  const rates = rows(view, "inference");
  assert.deepEqual(rates.map((row) => row.key), ["fp_real", "fp_naive", "fp_combined"]);
  for (const row of rates) {
    assert.equal(row.value.unit, "%");
    assert.ok(row.value.value >= 0 && row.value.value <= 100);
  }
  assert.ok(rates.some((row) => row.value.mcse > 0), "a rate that is not 0 or 1 carries its error");
  assert.match(view.rule, /Raab/);
  assert.match(view.rule, /低估/, "the sentence says what reading one copy as data does");
});

test("every declared analysis is shown combined over the copies, with its interval, beside the overlap with the real table", () => {
  const view = qualityReportView(fixture("synthesis").diagnostics.quality);
  const utility = rows(view, "utility");
  const combined = utility.filter((row) => row.key.startsWith("combined_"));
  assert.equal(combined.length, 3, "the Cox, log-rank and restricted-mean analyses");
  assert.ok(combined.every((row) => row.label.includes("5 份合并后的估计") && row.value.interval && row.value.interval.low < row.value.interval.high));
  assert.equal(utility.filter((row) => row.key.startsWith("overlap_")).length, 3);
});

test("the records easiest to recognise are counted, withheld below ten people, and never listed", () => {
  const view = qualityReportView(fixture("quality").diagnostics.quality);
  const leak = rows(view, "leakage");
  const share = leak.find((row) => row.key === "risk_share");
  assert.ok(share, "the share of training records above the stated bound");
  assert.ok(leak.some((row) => row.key === "attribute_inference"));
  assert.ok(view.atRisk && view.atRisk.bound === 0.75);
  assert.ok(view.atRisk.size >= 10 && view.atRisk.rows.length > 0, "forty copied people are a group large enough to describe");
  assert.ok(view.atRisk.rows.every((row) => row.atRisk >= 10), "no cell of 1 to 9 people is shown");
  // the thirds the engine cuts a number into are said in Chinese; a category is the person's own word
  assert.deepEqual(view.atRisk.rows.filter((row) => row.variable === "x1").map((row) => row.level), ["中间的三分之一", "最高的三分之一", "最低的三分之一"]);
  assert.deepEqual(view.atRisk.rows.filter((row) => row.variable === "g").map((row) => row.level), ["a", "b", "c"]);
  assert.ok(view.atRisk.rows.every((row) => !/third|missing/.test(row.level)));
  // a small group is not described
  const small = structuredClone(fixture("quality").diagnostics.quality);
  small.disclosure.perRecord.riskShares.forEach((entry) => { if (entry.stated) { entry.trainingShare = null; entry.trainingRecords = { count: null, suppressed: true }; } });
  delete small.disclosure.perRecord.atRiskGroup;
  const hidden = qualityReportView(small);
  assert.equal(hidden.atRisk.described, false);
  assert.match(rows(hidden, "leakage").find((row) => row.key === "risk_share").value.text, /少于 10/);
});

test("a report of the previous release reads as it did: no new group, no rule, no at-risk table", () => {
  const old = structuredClone(fixture("synthesis").diagnostics.quality);
  delete old.inference; delete old.disclosure.perRecord; delete old.disclosure.attributeInference;
  for (const entry of Object.values(old.utility.specific)) delete entry.combined;
  const view = qualityReportView(old);
  assert.equal(rows(view, "inference").length, 0);
  assert.equal(view.rule, null);
  assert.equal(view.atRisk, null);
  assert.ok(rows(view, "utility").every((row) => !row.key.startsWith("combined_")));
});

test("no back-office word reaches a sentence of the report", () => {
  for (const name of ["synthesis", "quality"]) {
    const view = qualityReportView(fixture(name).diagnostics.quality);
    const words = strings({ groups: view.groups.map((group) => ({ label: group.label, rows: group.rows.map((row) => row.label) })), rule: view.rule, tag: view.tag });
    for (const word of words) assert.ok(!/[a-z]+_[a-z_]+/.test(word) && !/^\s*[a-z]+\.[a-z]+/.test(word), word);
  }
});
