// What the domain holds for the local calibration of an applied published model and the optional TRIPOD-style words of a model card
// (remediation plan D3): the floors the engine reads, the limit sentence the page maps, and the card words. The numbers are the engine's
// case N60.
import assert from "node:assert/strict";
import test from "node:test";
import { VCR_ENGINE_METHODS, VCR_LOCAL_CALIBRATION_MIN, VCR_MODEL_TRIPOD_FIELDS, VCR_PREDICTION_LIMIT_LABELS_ZH, validateEngineJob, validateScenario, vcrModelTripod, vcrPredictionLimit } from "../index.mjs";

const TERM = { column: "age", unit: "years", coefficient: 0.04, transform: "identity", center: 60, scale: 1 };
const scenario = (/** @type {Record<string, any>} */ over = {}) => ({
  inputId: "snp_1:subject", idColumn: "USUBJID", sourceCondition: "control", endpoint: { type: "binary", horizon: 12, timeUnit: "months" }, inputUnits: { age: "years" },
  model: { family: "logistic", intercept: -1, terms: [TERM] }, ...over,
});

test("D3: the calibration block names the outcome the table holds, by the family of the equation", () => {
  assert.deepEqual(validateScenario("model.prognostic_apply", scenario()), []);
  assert.deepEqual(validateScenario("model.prognostic_apply", scenario({ calibration: { outcomeColumn: "response" } })), []);
  assert.deepEqual(validateScenario("model.prognostic_apply", scenario({ calibration: {} })).map((issue) => issue.field), ["scenario.calibration.outcomeColumn"]);
  const cox = { endpoint: { type: "time_to_event", horizon: 12, timeUnit: "months" }, model: { family: "cox", terms: [TERM], baseline: { reference: "centered", survival: 0.8, horizon: 12, timeUnit: "months" } } };
  assert.deepEqual(validateScenario("model.prognostic_apply", scenario({ ...cox, calibration: { timeColumn: "time", statusColumn: "status" } })), []);
  assert.deepEqual(validateScenario("model.prognostic_apply", scenario({ ...cox, calibration: { outcomeColumn: "response" } })).map((issue) => `${issue.code}@${issue.field}`).sort(),
    ["scenario_field_missing@scenario.calibration.statusColumn", "scenario_field_missing@scenario.calibration.timeColumn", "scenario_field_unknown@scenario.calibration.outcomeColumn"]);
});

test("D3: the slope's floors are the domain's, the method is 1.1.0, and a 1.0.0 job cannot ask for what 1.1.0 added", () => {
  assert.deepEqual({ ...VCR_LOCAL_CALIBRATION_MIN }, { slopeEvents: 10, slopeNonEvents: 10, slopePairs: 10 });
  assert.equal(/** @type {any} */ (VCR_ENGINE_METHODS)["model.prognostic_apply"].version, "1.1.0");
  const job = (/** @type {string} */ version, /** @type {Record<string, any>} */ sc) => ({ jobId: "job_1", studyId: "std_1", kind: "apply_prognostic_model", method: "model.prognostic_apply", methodVersion: version,
    protocolVersion: 1, seed: 1, cpuSecondsLimit: 60, scenario: sc, inputs: [{ kind: "snapshot", id: "snp_1" }] });
  const codes = (/** @type {any} */ j) => validateEngineJob(j).map((issue) => `${issue.code}@${issue.field}`);
  assert.ok(!codes(job("1.0.0", scenario())).includes("method_version_mismatch@methodVersion"), "a 1.0.0 equation replays");
  assert.ok(codes(job("1.0.0", scenario({ calibration: { outcomeColumn: "response" } }))).includes("method_version_mismatch@methodVersion"));
  assert.ok(!codes(job("1.1.0", scenario({ calibration: { outcomeColumn: "response" } }))).includes("method_version_mismatch@methodVersion"));
});

test("D3: the limit a calibrated run states is a closed word of its own, and the old sentence still maps to the old word", () => {
  assert.deepEqual(vcrPredictionLimit("Transportability and calibration in this target population have not been established."), { code: "transportability_not_established" });
  assert.deepEqual(vcrPredictionLimit("Calibration was measured on the observed outcomes of this table; transportability to any other population has not been established."), { code: "calibration_measured_locally" });
  assert.match(VCR_PREDICTION_LIMIT_LABELS_ZH.calibration_measured_locally, /换一个人群/);
});

test("D3: the TRIPOD-style words of a card are optional, ordered, trimmed and bounded", () => {
  assert.deepEqual(VCR_MODEL_TRIPOD_FIELDS.map((field) => field.key), ["developmentPopulation", "validationStudy", "outcomeHorizon", "intendedUse"]);
  assert.deepEqual(vcrModelTripod({}), []);
  assert.deepEqual(vcrModelTripod(null), []);
  assert.deepEqual(vcrModelTripod({ intendedUse: " a ", developmentPopulation: "b", other: "c", outcomeHorizon: 3 }), [
    { key: "developmentPopulation", label: "开发人群", text: "b" }, { key: "intendedUse", label: "预期用途", text: "a" }]);
  assert.equal(vcrModelTripod({ validationStudy: "x".repeat(2000) })[0].text.length, 600);
});
