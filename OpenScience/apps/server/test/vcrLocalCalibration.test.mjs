// The local calibration of an applied published model in the page's words (remediation plan D3): numbers with their intervals, and what
// anything that was not computed needed. No database.
import assert from "node:assert/strict";
import test from "node:test";
import { VCR_LOCAL_CALIBRATION_MIN } from "@evimed/domain";
import { localCalibrationView } from "../src/vcrLocalCalibration.mjs";

test("D3: a logistic calibration carries its intercept and slope with intervals, and the observed and predicted risk", () => {
  const view = localCalibrationView({ family: "logistic", n: 2000, events: 590, nonEvents: 1410, observedRisk: 0.2965, predictedRisk: 0.3691, calibrationInLarge: 0.0726,
    intercept: { value: -0.33474, se: 0.049, low: -0.43, high: -0.24, level: 0.95 }, slope: { value: 1.24177, se: 0.16, low: 0.93, high: 1.56, level: 0.95 } });
  assert.deepEqual(view.intercept, { value: -0.33474, low: -0.43, high: -0.24 });
  assert.deepEqual(view.slope, { value: 1.24177, low: 0.93, high: 1.56 });
  assert.deepEqual([view.n, view.events, view.nonEvents, view.observedRisk, view.predictedRisk, view.calibrationInLarge], [2000, 590, 1410, 0.2965, 0.3691, 0.0726]);
  assert.deepEqual(view.notes, []);
});

test("D3: with too few events the intercept stands alone and the page says what the slope needed", () => {
  const view = localCalibrationView({ family: "logistic", n: 600, events: 6, nonEvents: 594, observedRisk: 0.01, predictedRisk: 0.37, calibrationInLarge: 0.36,
    intercept: { value: -4.1, low: -4.9, high: -3.3 }, slopeUnavailable: "too_few_events", slopeNeeds: { events: 10, nonEvents: 10 } });
  assert.equal(view.slope, null);
  assert.notEqual(view.intercept, null);
  assert.deepEqual(view.notes, [`斜率没有算：事件或非事件太少（各至少要 ${VCR_LOCAL_CALIBRATION_MIN.slopeEvents} 个，这里 6 个事件、594 个非事件）`]);
  // no event at all: no intercept (it is infinite), said once, and the slope's reason is the same so it is not said twice
  const none = localCalibrationView({ family: "logistic", n: 600, events: 0, nonEvents: 600, observedRisk: 0, predictedRisk: 0.37, calibrationInLarge: 0.37, interceptUnavailable: "no_events", slopeUnavailable: "no_events" });
  assert.deepEqual([none.intercept, none.slope], [null, null]);
  assert.deepEqual(none.notes, ["截距没有算：这张表里没有人发生事件，只能比较观察到的和预测的风险"]);
});

test("D3: a continuous outcome's observed and predicted values are means, and a time-to-event one has no intercept but its own reasons", () => {
  const linear = localCalibrationView({ family: "linear", n: 400, observedMean: 3.9, predictedMean: 3.3, calibrationInLarge: -0.6, intercept: { value: 0.57, low: 0.35, high: 0.79 }, slope: { value: 1.19, low: 0.77, high: 1.61 } });
  assert.deepEqual([linear.observedRisk, linear.predictedRisk], [3.9, 3.3]);
  const few = localCalibrationView({ family: "linear", n: 6, observedMean: 3.9, predictedMean: 3.3, intercept: { value: 0.57 }, slopeUnavailable: "too_few_pairs", slopeNeeds: { pairs: 10 } });
  assert.deepEqual(few.notes, [`斜率没有算：成对的预测值和观察值太少（至少要 ${VCR_LOCAL_CALIBRATION_MIN.slopePairs} 对，这里 6 对）`]);
  const cox = localCalibrationView({ family: "cox", n: 600, events: 4, interceptUnavailable: "not_defined_for_time_to_event", observedRiskUnavailable: "no_baseline_risk", slopeUnavailable: "too_few_events" });
  assert.deepEqual(cox.notes, ["斜率没有算：事件太少（至少要 10 个，这里 4 个）", "观察到的风险没有算：方程没有基线风险，只有相对评分，不能比较绝对风险"]);
  assert.equal(localCalibrationView(null), null);
  assert.equal(localCalibrationView({}), null);
});
