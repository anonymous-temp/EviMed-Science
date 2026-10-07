import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { VCR_PROFILE_HISTOGRAM_BINS, VCR_PROFILE_KINDS, validatePopulationProfile } from "../index.mjs";

// Recorded from the engine's own runs (see the fixture's note), never typed: the contract is held against what R writes.
const fixture = JSON.parse(readFileSync(new URL("./fixtures/vcr-population-profiles.json", import.meta.url), "utf8"));
/** JSON-safe deep copy. @template T @param {T} value @returns {T} */
const clone = (value) => JSON.parse(JSON.stringify(value));
/** @param {readonly { code: string, field: string }[]} issues */
const codes = (issues) => issues.map((issue) => issue.code).sort();
const byName = (/** @type {any[]} */ profile, /** @type {string} */ name) => profile.find((entry) => entry.variable === name);

test("the three profiles the engine wrote are valid, and the walk proves it walked", () => {
  const kinds = new Set();
  let entries = 0;
  for (const key of ["scenario", "literature", "empirical"]) {
    assert.deepEqual(validatePopulationProfile(fixture[key]), [], key);
    for (const entry of fixture[key]) { kinds.add(entry.kind); entries += 1; }
  }
  assert.ok(entries >= 10, `only ${entries} entries were read`);
  assert.deepEqual([...kinds].sort(), [...VCR_PROFILE_KINDS].sort(), "every kind of variable is in the recorded profiles");
});

test("the shape the page reads: stated beside generated, seven equal bins, levels with their shares", () => {
  const age = byName(fixture.scenario, "age");
  assert.equal(age.label, "年龄");
  assert.equal(age.declared.family, "normal");
  assert.deepEqual(age.declared.params, { mean: 63, sd: 9 });
  assert.deepEqual(age.declared.constraints.map((/** @type {any} */ c) => c.kind), ["bounds", "rule"]);
  assert.equal(age.histogram.counts.length, VCR_PROFILE_HISTOGRAM_BINS);
  assert.equal(age.histogram.breaks.length, VCR_PROFILE_HISTOGRAM_BINS + 1);
  assert.equal(age.histogram.counts.reduce((/** @type {number} */ a, /** @type {number} */ b) => a + b, 0), age.n - age.missing);
  const bmi = byName(fixture.scenario, "bmi");
  assert.ok(bmi.missing > 0, "the missing values are counted apart from n");
  const ecog = byName(fixture.literature, "ecog");
  assert.deepEqual(ecog.levels.map((/** @type {any} */ l) => l.level), ["low", "mid", "high"], "the stated order of the levels");
  assert.equal(byName(fixture.empirical, "age").declared, null, "empirical synthesis states nothing");
  assert.equal(typeof byName(fixture.scenario, "age").mean, "number", "numbers stay numbers");
});

test("an empirical synthetic table shows its withheld levels as withheld, not as missing", () => {
  const grp = byName(fixture.empirical, "grp");
  const hidden = grp.levels.filter((/** @type {any} */ l) => l.suppressed === true);
  assert.ok(hidden.length >= 2, "the small cells are hidden together");
  for (const level of hidden) assert.deepEqual([level.n, level.p], [null, null]);
  assert.ok(grp.suppressed.includes("levels"));
  const shown = grp.levels.filter((/** @type {any} */ l) => l.suppressed !== true);
  assert.ok(shown.length >= 1 && shown.every((/** @type {any} */ l) => l.n >= 10), "no shown level is below the small-cell floor");
});

test("a profile that is not one is named, by what is wrong", () => {
  assert.deepEqual(codes(validatePopulationProfile(null)), ["profile_not_list"]);
  assert.deepEqual(codes(validatePopulationProfile({})), ["profile_not_list"]);

  const scenario = () => clone(fixture.scenario);
  const entry = (/** @type {string} */ name, /** @type {(e: any) => void} */ edit) => { const p = scenario(); edit(byName(p, name)); return validatePopulationProfile(p); };
  assert.deepEqual(codes(entry("age", (e) => { e.kind = "ordinal"; })), ["kind_invalid"]);
  assert.deepEqual(codes(entry("age", (e) => { e.n = 1000.5; })), ["n_invalid"]);
  assert.ok(codes(entry("age", (e) => { e.missing = null; })).includes("missing_unexplained"), "a null the entry does not explain is a defect");
  assert.deepEqual(codes(entry("age", (e) => { e.mean = null; })), ["summary_unexplained"]);
  assert.deepEqual(codes(entry("age", (e) => { e.q1 = 80; })), ["summary_order"]);
  assert.deepEqual(codes(entry("age", (e) => { e.histogram.counts.pop(); })), ["histogram_bins", "histogram_total"].sort());
  assert.deepEqual(codes(entry("age", (e) => { e.histogram.breaks[3] = e.histogram.breaks[2]; })), ["histogram_breaks"]);
  assert.deepEqual(codes(entry("age", (e) => { e.histogram.counts[2] += 1; })), ["histogram_total"]);
  assert.deepEqual(codes(entry("age", (e) => { e.histogram.counts[2] = null; })), ["histogram_complement", "histogram_unexplained"]);
  assert.deepEqual(codes(entry("age", (e) => { e.levels = []; })), ["levels_on_continuous"]);
  assert.deepEqual(codes(entry("age", (e) => { e.declared = { family: "normal" }; })), ["declared_invalid"]);
  assert.deepEqual(codes(entry("stage", (e) => { e.levels[0].n += 3; })), ["level_share", "levels_total"]);
  assert.deepEqual(codes(entry("stage", (e) => { e.levels[0].p = 0.9; })), ["level_share"]);
  assert.deepEqual(codes(entry("female", (e) => { e.levels.push({ level: "x", n: 0, p: 0 }); })), ["binary_levels"]);
  assert.deepEqual(codes(entry("female", (e) => { e.histogram = { breaks: [], counts: [] }; })), ["histogram_on_levels"]);
  const duplicate = scenario(); duplicate[1].variable = "age";
  assert.deepEqual(codes(validatePopulationProfile(duplicate)), ["variable_duplicate"]);
});

test("suppression is all or nothing: one hidden cell, or a hidden level with a number, is refused", () => {
  const empirical = () => clone(fixture.empirical);
  const lone = empirical();
  const grp = byName(lone, "grp");
  // un-hide all but one of the hidden levels: the one that is left can be recovered from the total
  const hidden = grp.levels.filter((/** @type {any} */ l) => l.suppressed === true);
  for (const level of hidden.slice(1)) { delete level.suppressed; level.n = 20; level.p = 0.05; }
  assert.ok(codes(validatePopulationProfile(lone)).includes("level_complement"));

  const leaky = empirical();
  byName(leaky, "grp").levels.find((/** @type {any} */ l) => l.suppressed === true).n = 4;
  assert.ok(codes(validatePopulationProfile(leaky)).includes("level_suppression"), "a hidden level keeps what it is and loses every number");

  const silent = empirical();
  delete byName(silent, "grp").suppressed;
  assert.ok(codes(validatePopulationProfile(silent)).includes("level_unexplained"), "a hidden level the entry does not own up to");

  const oneBin = empirical();
  const age = byName(oneBin, "age");
  // the recorded histogram hides both tail bins together; show one of them and the other can be recovered from the total
  assert.equal(age.histogram.counts.filter((/** @type {unknown} */ c) => c === null).length, 2);
  age.histogram.counts[6] = 7;
  assert.ok(codes(validatePopulationProfile(oneBin)).includes("histogram_complement"));
});
