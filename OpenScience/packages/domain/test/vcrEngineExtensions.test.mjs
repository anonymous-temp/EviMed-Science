/**
 * The 2026-10-07 engine extensions' contract: longitudinal virtual patients (`patients.longitudinal`), the assurance of a
 * group-sequential design (`design.assurance` 1.1.0), and single-arm simulation of a mean and of a survival time against a
 * fixed benchmark (`design.simulate` / `design.grid` 1.2.0). Their parity jobs live in
 * `fixtures/vcr-engine-jobs-extensions.json`, a file of their own; the engine's R twin runs the same file in case N49a and the two
 * verdicts must be equal.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  VCR_DESIGN_SUPPORT,
  VCR_ENGINE_METHODS,
  VCR_JOB_KINDS,
  VCR_JOB_METHODS,
  VCR_SCENARIO_SCHEMAS,
  VCR_SINGLE_ARM_ANALYSIS_METHODS,
  validateEngineJob,
  validateScenario,
  vcrIsNullScenario,
} from "@evimed/domain";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/vcr-engine-jobs-extensions.json", import.meta.url), "utf8"));
/** @param {readonly { code: string, field: string }[]} issues */
const keys = (issues) => issues.map((issue) => `${issue.code}@${issue.field}`).sort();
/** JSON-safe deep copy. @template T @param {T} value @returns {T} */
const clone = (value) => JSON.parse(JSON.stringify(value));
const valid = (/** @type {string} */ name) => clone(fixture.valid.find((/** @type {any} */ item) => item.name.startsWith(name)).job);

test("the extension parity jobs: every valid one is clean, every invalid one names what it says, and each method has both", () => {
  assert.ok(fixture.valid.length >= 12 && fixture.invalid.length >= 25, "the walk proves it walked");
  for (const item of fixture.valid) assert.deepEqual(validateEngineJob(item.job), [], item.name);
  for (const item of fixture.invalid) {
    const got = keys(validateEngineJob(item.job));
    assert.ok(got.length > 0, `${item.name}: a job that should be refused validated`);
    for (const expected of item.expected) assert.ok(got.includes(expected), `${item.name}: expected ${expected}, got ${got.join(" | ")}`);
  }
  for (const method of ["patients.longitudinal", "design.assurance", "design.simulate", "design.grid"]) {
    assert.ok(fixture.valid.some((/** @type {any} */ item) => item.job.method === method), `${method} has no valid parity job`);
    assert.ok(fixture.invalid.some((/** @type {any} */ item) => item.job.method === method), `${method} has no invalid parity job`);
  }
});

test("the trajectory method is registered once: a method, a kind, a schema, a tier, and the references its cases are held to", () => {
  const spec = /** @type {any} */ (VCR_ENGINE_METHODS)["patients.longitudinal"];
  assert.equal(spec.version, "1.0.0");
  assert.equal(spec.modelTier, "scenario");
  assert.deepEqual([...spec.endpoints], ["continuous"]);
  assert.ok(spec.crossChecks.length > 0);
  assert.equal(/** @type {Record<string, string>} */ (VCR_JOB_METHODS).generate_patients_longitudinal, "patients.longitudinal");
  assert.ok(VCR_JOB_KINDS.includes("generate_patients_longitudinal"));
  assert.ok(VCR_JOB_KINDS.indexOf("generate_patients_longitudinal") === VCR_JOB_KINDS.length - 1, "appended: the runtime's list mirrors the domain's order");
  assert.ok(/** @type {any} */ (VCR_SCENARIO_SCHEMAS)["patients.longitudinal"]);
});

test("the trajectory scenario is the model's and nothing else: every key it reads, none it does not", () => {
  const base = valid("longitudinal: a trajectory");
  assert.deepEqual(validateScenario("patients.longitudinal", base.scenario), []);
  // the covariance is two SDs and a correlation: a correlation outside (-1, 1) is refused, never a matrix that is not positive definite
  for (const correlation of [1, -1, 1.5]) {
    const s = clone(base.scenario); s.truth.randomEffects.correlation = correlation;
    assert.deepEqual(keys(validateScenario("patients.longitudinal", s)), ["scenario_value_invalid@scenario.truth.randomEffects.correlation"]);
  }
  // the keys another generator reads are refused here by path: a scenario reads what this model reads
  for (const [path, key] of [["truth", "controlRate"], ["truth", "hazardRatio"], ["truth", "baselineCorrelation"], ["", "accrual"], ["design", "allocation"]]) {
    const s = clone(base.scenario); (path ? s[path] : s)[key] = 1;
    assert.ok(keys(validateScenario("patients.longitudinal", s)).includes(`scenario_field_unknown@scenario.${path ? `${path}.` : ""}${key}`), `${path}.${key}`);
  }
  // the first visit is at or after zero, the schedule has at most fifty visits
  const long = clone(base.scenario); long.visits = Array.from({ length: 51 }, (_, i) => i);
  assert.ok(keys(validateScenario("patients.longitudinal", long)).includes("scenario_value_invalid@scenario.visits"));
  const early = clone(base.scenario); early.visits = [-1, 2];
  assert.ok(keys(validateScenario("patients.longitudinal", early)).length > 0);
});

test("assurance reaches the group-sequential design the analytic calculation already has, and its version says so", () => {
  const spec = /** @type {any} */ (VCR_ENGINE_METHODS)["design.assurance"];
  assert.equal(spec.version, "1.1.0");
  assert.deepEqual([...spec.legacyDesigns], ["two_arm_fixed"]);
  assert.deepEqual([...VCR_DESIGN_SUPPORT["design.assurance"].group_sequential], ["time_to_event"]);
  const gs = valid("assurance: a group-sequential design");
  assert.deepEqual(validateEngineJob(gs), []);
  // a group-sequential job at the version before the design existed is refused; a fixed job at that version is a valid replay
  assert.deepEqual(keys(validateEngineJob({ ...gs, methodVersion: "1.0.0" })), ["method_version_mismatch@methodVersion"]);
  assert.deepEqual(validateEngineJob(valid("assurance: a fixed design recorded at 1.0.0")), []);
  // the looks and the spending function are the design's own keys, read only when it is group sequential
  const fixed = valid("assurance: the fixed design, kind spelt out");
  fixed.scenario.design.informationRates = [0.5, 1];
  assert.deepEqual(keys(validateEngineJob(fixed)), ["scenario_field_unknown@scenario.design.informationRates"]);
});

test("single-arm designs state their analysis by endpoint, and the version records what each release could run", () => {
  assert.deepEqual(VCR_SINGLE_ARM_ANALYSIS_METHODS.single_arm, { binary: ["exact_binomial"], continuous: ["one_sample_t", "one_sample_z"], time_to_event: ["one_sample_logrank"] });
  assert.deepEqual(Object.keys(VCR_SINGLE_ARM_ANALYSIS_METHODS.single_arm_external), ["binary"]);
  for (const method of ["design.simulate", "design.grid"]) {
    const spec = /** @type {any} */ (VCR_ENGINE_METHODS)[method];
    assert.equal(spec.version, "1.2.0", method);
    assert.deepEqual(spec.legacyReleases.map((/** @type {any} */ release) => release.version), ["1.1.0"], method);
    assert.deepEqual([...spec.legacyReleases[0].support.single_arm], ["binary"], "what 1.1.0 ran: the binary single arm only");
    assert.deepEqual([...VCR_DESIGN_SUPPORT[/** @type {"design.simulate"} */ (method)].single_arm], ["binary", "continuous", "time_to_event"]);
  }
  const mean = valid("simulate: single arm, a mean, one-sample t");
  assert.deepEqual(keys(validateEngineJob({ ...mean, methodVersion: "1.1.0" })), ["method_version_mismatch@methodVersion"], "a design is never labelled with a version that did not have it");
  assert.deepEqual(validateEngineJob(valid("simulate: the binary single arm recorded at 1.1.0")), [], "a replay of a result recorded at 1.1.0");
  assert.deepEqual(validateEngineJob(valid("simulate: a two-arm design recorded at 1.1.0")), []);
  assert.deepEqual(validateEngineJob(valid("simulate: a group-sequential design recorded at 1.1.0")), []);
  // the grid's cells are read per cell: a binary single-arm cell at 1.1.0 is a replay, a cell of a mean is not
  const grid = valid("grid: single arm, a mean");
  assert.deepEqual(keys(validateEngineJob({ ...grid, methodVersion: "1.1.0" })), ["method_version_mismatch@methodVersion"]);
});

test("the null of a single-arm trial of a mean or a survival time is its effect over the benchmark, not a response rate", () => {
  const mean = valid("simulate: single arm, a mean, one-sample t").scenario;
  assert.equal(vcrIsNullScenario(mean), false);
  assert.equal(vcrIsNullScenario({ ...mean, truth: { ...mean.truth, effect: 0 } }), true);
  const surv = valid("simulate: single arm, a survival time, one-sample log-rank").scenario;
  assert.equal(vcrIsNullScenario(surv), false);
  assert.equal(vcrIsNullScenario({ ...surv, truth: { ...surv.truth, hazardRatio: 1 } }), true);
  // the binary single arm still compares its rates
  const binary = valid("simulate: the binary single arm recorded at 1.1.0").scenario;
  assert.equal(vcrIsNullScenario(binary), false);
  assert.equal(vcrIsNullScenario({ ...binary, truth: { nullRate: 0.3, responseRate: 0.3 } }), true);
  // and the null label must agree with the effect
  const wrong = clone(mean); wrong.truth.null = true;
  assert.ok(keys(validateScenario("design.simulate", wrong)).includes("scenario_value_invalid@scenario.truth.null"));
});

test("a one-sample analysis is tied to its endpoint and its direction", () => {
  const mean = valid("simulate: single arm, a mean, one-sample t").scenario;
  const z = clone(mean); z.analysis.method = "one_sample_z";
  assert.deepEqual(keys(validateScenario("design.simulate", z)), ["scenario_field_missing@scenario.analysis.sd"], "a z analysis states the SD it takes as known");
  const t = clone(mean); t.analysis.sd = 12;
  assert.deepEqual(keys(validateScenario("design.simulate", t)), ["scenario_field_unknown@scenario.analysis.sd"], "a t analysis estimates it");
  const logrank = clone(mean); logrank.analysis.method = "one_sample_logrank";
  assert.ok(keys(validateScenario("design.simulate", logrank)).includes("scenario_value_invalid@scenario.analysis.method"));
  const twoSided = clone(mean); twoSided.analysis.alternative = "two.sided";
  assert.deepEqual(keys(validateScenario("design.simulate", twoSided)), ["scenario_value_invalid@scenario.analysis.sided"]);
});
