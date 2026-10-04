/**
 * The robustness methods' contract (2026-10-04): negative-control outcomes, the
 * tipping-point analysis for missing outcomes, and prognostic covariate
 * adjustment for binary and time-to-event endpoints. Their parity jobs live in
 * `fixtures/vcr-engine-jobs-robustness.json`, a file of their own so the streams
 * that add engine methods at the same time do not edit one file; the engine's R
 * twin runs the same file in case N40a and the two verdicts must be equal.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import {
  ALL_ERROR_CODES,
  VCR_ENGINE_METHODS,
  VCR_JOB_KINDS,
  VCR_JOB_METHODS,
  VCR_NEGATIVE_CONTROL_CALIBRATION_MIN,
  VCR_NEGATIVE_CONTROL_VERDICTS,
  VCR_NEGATIVE_CONTROL_VERDICT_LABELS_ZH,
  VCR_NOT_ESTIMABLE_RULES,
  VCR_NOT_ESTIMABLE_RULE_LABELS_ZH,
  VCR_OBSERVED_ONLY_METHODS,
  VCR_PATIENT_LEVEL_JOB_KINDS,
  VCR_SCENARIO_SCHEMAS,
  validateEngineJob,
} from "@evimed/domain";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/vcr-engine-jobs-robustness.json", import.meta.url), "utf8"));
/** @param {readonly { code: string, field: string }[]} issues */
const keys = (issues) => issues.map((issue) => `${issue.code}@${issue.field}`).sort();

/** The methods this file is about, with the job kind that runs each. */
const METHODS = /** @type {const} */ ([
  ["comparator.negative_control", "negative_control_comparator"],
])

test("the robustness parity jobs: every valid one is clean, every invalid one names what it says, and each method has both", () => {
  for (const item of fixture.valid) assert.deepEqual(validateEngineJob(item.job), [], item.name);
  for (const item of fixture.invalid) {
    const got = keys(validateEngineJob(item.job));
    assert.ok(got.length > 0, `${item.name}: a job that should be refused validated`);
    for (const expected of item.expected) assert.ok(got.includes(expected), `${item.name}: expected ${expected}, got ${got.join(" | ")}`);
  }
  for (const [method] of METHODS) {
    assert.ok(fixture.valid.some((/** @type {any} */ item) => item.job.method === method), `${method} has no valid parity job`);
    assert.ok(fixture.invalid.filter((/** @type {any} */ item) => item.job.method === method).length >= 5, `${method} has too few invalid parity jobs`);
  }
});

test("each robustness method is registered once: a method, a kind, a schema, and the sources it reads", () => {
  for (const [method, kind] of METHODS) {
    assert.equal(/** @type {any} */ (VCR_ENGINE_METHODS)[method].version, "1.0.0", method);
    assert.equal(/** @type {any} */ (VCR_ENGINE_METHODS)[method].modelTier, "data", method);
    assert.ok(/** @type {any} */ (VCR_ENGINE_METHODS)[method].crossChecks.length > 0, `${method} names what its numeric cases are held against`);
    assert.equal(/** @type {Record<string, string>} */ (VCR_JOB_METHODS)[kind], method, kind);
    assert.ok(VCR_JOB_KINDS.includes(kind), kind);
    assert.ok(VCR_OBSERVED_ONLY_METHODS.includes(method), `${method} refuses synthetic, aggregate and predicted rows`);
    assert.ok(VCR_SCENARIO_SCHEMAS[/** @type {keyof typeof VCR_SCENARIO_SCHEMAS} */ (method)], method);
  }
});

test("the rules the robustness methods can fire are in the closed vocabulary and have a sentence", () => {
  for (const rule of ["negative_controls_not_estimable", "primary_analysis_not_estimable"]) {
    assert.ok(VCR_NOT_ESTIMABLE_RULES.includes(rule), rule);
    assert.ok(/** @type {Record<string, string>} */ (VCR_NOT_ESTIMABLE_RULE_LABELS_ZH)[rule], `${rule} has a sentence`);
  }
  for (const rule of VCR_NOT_ESTIMABLE_RULES) assert.ok(/** @type {Record<string, string>} */ (VCR_NOT_ESTIMABLE_RULE_LABELS_ZH)[rule], `${rule} has a sentence`);
});

test("negative controls: the calibration floor is a domain preset the engine reads from its snapshot, and each verdict has a label", () => {
  assert.equal(VCR_NEGATIVE_CONTROL_CALIBRATION_MIN, 30, "the low end of the literature's 30-50");
  assert.deepEqual([...VCR_NEGATIVE_CONTROL_VERDICTS], ["signals_bias", "consistent_with_null", "uninformative"]);
  for (const verdict of VCR_NEGATIVE_CONTROL_VERDICTS) assert.ok(/** @type {Record<string, string>} */ (VCR_NEGATIVE_CONTROL_VERDICT_LABELS_ZH)[verdict], verdict);
  // a scenario cannot move the floor: it has no key for it
  const job = fixture.valid.find((/** @type {any} */ item) => item.job.method === "comparator.negative_control").job;
  const lowered = JSON.parse(JSON.stringify(job));
  lowered.scenario.calibrationMin = 5;
  assert.deepEqual(keys(validateEngineJob(lowered)), ["scenario_field_unknown@scenario.calibrationMin"]);
  const url = new URL("../../../../项目代码/vcr-engine/R/domain-snapshot.json", import.meta.url);
  if (!existsSync(url)) return;
  const snapshot = JSON.parse(readFileSync(url, "utf8"));
  assert.equal(snapshot.limits.negativeControlCalibrationMin, VCR_NEGATIVE_CONTROL_CALIBRATION_MIN);
  assert.deepEqual(snapshot.negativeControlVerdicts, [...VCR_NEGATIVE_CONTROL_VERDICTS]);
});

test("a robustness job kind is not a patient-level kind unless it must carry a snapshot", () => {
  // negative_control_comparator takes either columns of a table or estimates analysed elsewhere, so a job without a table is valid
  assert.ok(!VCR_PATIENT_LEVEL_JOB_KINDS.includes("negative_control_comparator"));
  assert.ok(ALL_ERROR_CODES.includes("scenario_field_missing"));
});
