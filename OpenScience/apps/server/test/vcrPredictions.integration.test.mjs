// Flywheel F25, the 虚拟临床研究 side (2026-10-06): a trial scenario's prediction of a registered trial's primary endpoint is read out of the
// engine's own result by path and handed to the registry. The number is never in the request, the result must come from an engine job,
// and the same prediction is filed once.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { createVcrPredictions } from "../src/vcrPredictions.mjs";
import { seedEngineResult, skipWithoutDatabase, startVcr } from "./helpers/vcrFlywheelFixture.mjs";

/** @type {Awaited<ReturnType<typeof startVcr>>} */
let fixture;
/** @type {any} */ let study;
/** @type {any} */ let predictions;
/** @type {any[]} */ const filed = [];
const registry = { fail: false, async register(prediction) { if (registry.fail) throw new Error("registry unavailable"); filed.push(prediction); return { id: `prd_${filed.length}` }; } };
const LEAD = { id: "u-pred" };
const ASK = { registryId: "NCT02296125", endpoint: "PFS", resultPath: "measure(power)" };
let scenarioId = "";
let counter = 0;

before(async () => {
  if (!process.env.OPEN_SCIENCE_TEST_POSTGRES_URL) return;
  fixture = await startVcr({ label: "vcrpred" });
  study = await fixture.vcr.store.createStudy({ userId: LEAD.id, projectId: "prj-pred", name: "EV-501", question: "q", dataTier: "T0" });
  predictions = createVcrPredictions({ store: fixture.vcr.store, registry, now: () => new Date("2026-10-06T08:00:00.000Z") });
});
after(async () => { await fixture?.close(); });

/** A trial scenario of the study with an engine result behind it. */
async function scenarioWithResult({ measures, conclusion = "estimable", ofStudy = study }) {
  counter += 1;
  const written = await fixture.write(ofStudy, "trial_scenario", [{ label: `方案 ${counter}`, design: "two_arm_fixed", endpointType: "time_to_event" }]);
  assert.equal(written.ok, true, JSON.stringify(written.issues));
  const id = written.ids[0];
  if (measures) {
    const seeded = await seedEngineResult(fixture.vcr, ofStudy, { kind: "trial_scenario", subjectId: `trial_scenario:${id}@1`, measures, engineJobId: "engine-job-9" });
    if (conclusion !== "estimable") await fixture.vcr.store.query("UPDATE evimed_vcr.results SET conclusion = $2 WHERE id = $1", [seeded.result.id, conclusion]);
    return { id, execution: seeded.execution };
  }
  return { id, execution: null };
}

const MEASURES = [
  { name: "power", value: 0.8123, mcse: 0.0124, source: "predicted", simulated: true },
  { name: "hazard_ratio", value: 0.74, interval: { kind: "confidence", low: 0.61, high: 0.9 }, source: "calculated" },
  { name: "bias", value: 0.02 },
];

test("the prediction is read out of the engine result by path and handed over with the job and the receipt, in exactly the registry's shape", skipWithoutDatabase, async () => {
  const { id, execution } = await scenarioWithResult({ measures: MEASURES });
  scenarioId = id;
  const result = await predictions.file(study, LEAD, { scenarioId: id, ...ASK });
  assert.deepEqual([result.filed, result.existing, result.id], [true, false, "prd_1"]);
  assert.deepEqual(filed.at(-1), {
    source: "vcr", registryId: "NCT02296125", endpoint: "PFS", probability: 0.8123, engineJobId: "engine-job-9", receiptId: execution.id,
    filedAt: "2026-10-06T08:00:00.000Z", accountId: LEAD.id, studyId: study.id,
  });
  // An effect estimate with its interval: the numbers are the engine's own, the interval's kind rides with it.
  await predictions.file(study, LEAD, { scenarioId: id, ...ASK, endpoint: "PFS hazard ratio", resultPath: "measure(hazard_ratio).value" });
  assert.deepEqual([filed.at(-1).estimate, filed.at(-1).interval], [0.74, { low: 0.61, high: 0.9, kind: "confidence" }]);
  assert.equal(Object.hasOwn(filed.at(-1), "probability"), false);
});

test("a body that carries a number is refused whole by name, and the registry is not asked", skipWithoutDatabase, async () => {
  const before = filed.length;
  for (const key of ["estimate", "interval", "probability", "value"]) {
    await assert.rejects(predictions.file(study, LEAD, { scenarioId, ...ASK, [key]: key === "interval" ? { low: 1, high: 2 } : 0.9 }),
      { status: 422, code: "vcr_prediction_number_refused" }, key);
  }
  await assert.rejects(predictions.file(study, LEAD, { scenarioId, ...ASK, note: "x" }), { status: 400, code: "vcr_payload_invalid" });
  for (const bad of [{ registryId: "not a trial" }, { endpoint: "" }, { resultPath: "measure(power); drop" }, { scenarioId: "../x" }]) {
    await assert.rejects(predictions.file(study, LEAD, { scenarioId, ...ASK, ...bad }), { status: 400, code: "vcr_payload_invalid" }, JSON.stringify(bad));
  }
  assert.equal(filed.length, before);
});

test("a scenario with no engine result, a result the engine called not estimable, a path with no estimate, or a scenario that is not the study's is refused by name", skipWithoutDatabase, async () => {
  const bare = await scenarioWithResult({ measures: null });
  await assert.rejects(predictions.file(study, LEAD, { scenarioId: bare.id, ...ASK }), { status: 409, code: "vcr_prediction_not_from_engine" });
  const unestimable = await scenarioWithResult({ measures: MEASURES, conclusion: "not_estimable" });
  await assert.rejects(predictions.file(study, LEAD, { scenarioId: unestimable.id, ...ASK }), { status: 409, code: "vcr_prediction_not_from_engine" });
  const fine = await scenarioWithResult({ measures: MEASURES });
  await assert.rejects(predictions.file(study, LEAD, { scenarioId: fine.id, ...ASK, resultPath: "measure(bias)" }), { status: 422, code: "vcr_prediction_unreadable" },
    "a bias is neither an estimate with an interval nor a probability of success");
  await assert.rejects(predictions.file(study, LEAD, { scenarioId: fine.id, ...ASK, resultPath: "measure(nothing)" }), { status: 422, code: "vcr_prediction_unreadable" });
  await assert.rejects(predictions.file(study, LEAD, { scenarioId: "scn_nope", ...ASK }), { status: 404, code: "vcr_prediction_scenario_not_found" });
  const other = await fixture.vcr.store.createStudy({ userId: LEAD.id, projectId: "prj-pred-2", name: "另一个", question: "q", dataTier: "T0" });
  await assert.rejects(predictions.file(other, LEAD, { scenarioId: fine.id, ...ASK }), { status: 404, code: "vcr_prediction_scenario_not_found" }, "another study's scenario does not exist here");
});

test("the same prediction is filed once; a registry that refused leaves it fileable", skipWithoutDatabase, async () => {
  const { id } = await scenarioWithResult({ measures: MEASURES });
  const before = filed.length;
  assert.equal((await predictions.file(study, LEAD, { scenarioId: id, ...ASK })).filed, true);
  const again = await predictions.file(study, LEAD, { scenarioId: id, ...ASK });
  assert.deepEqual([again.filed, again.existing], [false, true]);
  assert.equal(filed.length, before + 1, "the registry saw it once");
  const other = await scenarioWithResult({ measures: MEASURES });
  registry.fail = true;
  await assert.rejects(predictions.file(study, LEAD, { scenarioId: other.id, ...ASK }), /registry unavailable/);
  registry.fail = false;
  assert.equal((await predictions.file(study, LEAD, { scenarioId: other.id, ...ASK })).filed, true, "the claim went with the failure");
});

test("with no registry composed the module does not exist", () => {
  assert.equal(createVcrPredictions({ store: {}, registry: null }), null);
  assert.equal(createVcrPredictions({ store: {}, registry: /** @type {any} */ ({}) }), null);
});
