// A comparator's time unit, from the request to the engine. The scenario schema takes any short text; the engine of method version
// 1.1 reads days, weeks, months and years only. So the queue writes the closed spellings as the unit they name before the scenario
// is hashed, refuses text that names no unit before it is queued, and a reconstructed table carries the unit its curve was
// calibrated in wherever it is read — the restricted-mean comparison of a reconstruction as well as the indirect comparison that
// names it as its comparator.
import assert from "node:assert/strict";
import test from "node:test";

import { vcrCanonicalScenarioTimeUnit, vcrCurveTimeUnit, vcrScenarioHash } from "../src/vcrJobs.mjs";

test("the closed spellings of a unit are written as the unit, and one request is one job in any of them", () => {
  for (const spelling of ["day", "Days", " d ", "天", "日"]) assert.equal(vcrCanonicalScenarioTimeUnit("comparator.rmst", { tau: 365, timeUnit: spelling }).scenario.timeUnit, "days", spelling);
  for (const spelling of ["month", "MONTHS", "个月", "mo"]) assert.equal(vcrCanonicalScenarioTimeUnit("comparator.weighted_cox", { timeUnit: spelling }).scenario.timeUnit, "months", spelling);
  assert.equal(vcrCanonicalScenarioTimeUnit("comparator.entropy_balance", { timeUnit: "yr" }).scenario.timeUnit, "years");
  assert.equal(vcrCanonicalScenarioTimeUnit("comparator.maic_time_to_event", { timeUnit: "周" }).scenario.timeUnit, "weeks");
  const same = (/** @type {string} */ spelling) => vcrScenarioHash(vcrCanonicalScenarioTimeUnit("comparator.rmst", { tau: 365, timeUnit: spelling }).scenario);
  assert.equal(same("day"), same("days"));
  assert.equal(same("天"), same("days"));
});

test("text that names no unit is refused before queueing, naming the four words; a canonical unit and a missing one pass", () => {
  const refused = vcrCanonicalScenarioTimeUnit("comparator.rmst", { timeUnit: "fortnights" });
  assert.equal(refused.issue?.code, "scenario_value_invalid");
  assert.equal(refused.issue?.field, "scenario.timeUnit");
  assert.match(refused.issue?.detail ?? "", /days, weeks, months, years/);
  assert.equal(vcrCanonicalScenarioTimeUnit("comparator.rmst", { timeUnit: "cycles" }).issue?.field, "scenario.timeUnit");
  const kept = { tau: 24, timeUnit: "months" };
  assert.equal(vcrCanonicalScenarioTimeUnit("comparator.rmst", kept).scenario, kept, "an already canonical scenario is the same object");
  assert.equal(vcrCanonicalScenarioTimeUnit("comparator.rmst", { tau: 24 }).issue, null, "a table's own unit may supply it");
  assert.equal(vcrCanonicalScenarioTimeUnit("comparator.rmst", { timeUnit: null }).issue, null);
  // only a comparator's scenario is read this way: another method's timeUnit is its own business
  assert.equal(vcrCanonicalScenarioTimeUnit("design.simulate", { timeUnit: "fortnights" }).issue, null);
});

const receipt = { ok: true, signed: true, hashVerified: true, outputHash: "a".repeat(64) };
const reconstruction = { method: "evidence.reconstruct_km", receipt, output_hash: "a".repeat(64), job_id: "job_r" };
const producer = { scenario: { curve: [] }, inputs: [], checkpoint: { curveReceiptId: "crv_1", curveImageHash: "i".repeat(8), curvePointsHash: "p".repeat(8), curvePrincipal: "u1" } };
const verifying = (/** @type {Record<string, any>} */ detail) => async () => ({ detail: { curveImageHash: "i".repeat(8), curvePointsHash: "p".repeat(8), curveTimeUnit: "Days", ...detail } });

test("a reconstructed table carries its curve's unit when it is read without being bound, and says nothing when it cannot be shown", async () => {
  const base = { studyId: "s1", execution: reconstruction, producer };
  assert.equal(await vcrCurveTimeUnit({ ...base, verifier: verifying({}), strict: false }), "days", "the restricted-mean stage of the same reconstruction");
  assert.equal(await vcrCurveTimeUnit({ ...base, verifier: verifying({}), strict: true }), "days", "the bound comparator, as before");
  // not verifiable: the unbound reading leaves the unit unstated (the scenario's own, or the engine's refusal to guess); the bound one refuses
  assert.equal(await vcrCurveTimeUnit({ ...base, verifier: null, strict: false }), null);
  await assert.rejects(vcrCurveTimeUnit({ ...base, verifier: null, strict: true }), { code: "vcr_curve_provenance_unavailable" });
  assert.equal(await vcrCurveTimeUnit({ ...base, execution: { ...reconstruction, receipt: { ok: false } }, verifier: verifying({}), strict: false }), null);
  // a unit outside the table: unstated when unbound, refused when bound
  assert.equal(await vcrCurveTimeUnit({ ...base, verifier: verifying({ curveTimeUnitUnsupported: true }), strict: false }), null);
  await assert.rejects(vcrCurveTimeUnit({ ...base, verifier: verifying({ curveTimeUnitUnsupported: true }), strict: true }), { code: "vcr_job_scenario_invalid" });
  // a receipt that changed since the reconstruction is refused either way
  for (const strict of [false, true]) {
    await assert.rejects(vcrCurveTimeUnit({ ...base, verifier: verifying({ curvePointsHash: "x".repeat(8) }), strict }), { code: "vcr_curve_provenance_unavailable" });
  }
});
