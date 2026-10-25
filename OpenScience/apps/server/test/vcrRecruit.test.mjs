import assert from "node:assert/strict";
import test from "node:test";
import { VCR_ACCRUAL_MEASURES, VCR_ACCRUAL_PRIOR_DEFAULT, VCR_RISK_APPETITE_QUANTILES, accrualPosterior,
  parseProbabilityByMonth, readAccrualForecast, requestAccrualForecast } from "../src/vcrRecruit.mjs";
import { VCR_JOB_METHODS, validateEngineJob } from "@evimed/domain";
import { matchingCandidates } from "../src/vcrMatchingCandidates.mjs";
test("AC-37 the Poisson–Gamma prior is updated from the site's own open months, not the study clock", () => {
  const fitted = accrualPosterior({ enrolled: 7, monthsOpen: 9 }, { alpha: 1, beta: 1 });
  assert.equal(fitted.alpha, 8);
  assert.equal(fitted.beta, 10);
  assert.equal(fitted.meanRatePerMonth, 0.8);
  assert.equal(fitted.source, "site_history");

  const unopened = accrualPosterior({ enrolled: 0, monthsOpen: 0 });
  assert.deepEqual(
    { alpha: unopened.alpha, beta: unopened.beta, source: unopened.source },
    { alpha: VCR_ACCRUAL_PRIOR_DEFAULT.alpha, beta: VCR_ACCRUAL_PRIOR_DEFAULT.beta, source: "prior_only" },
  );
  // A late site with two months open and two patients is fast, not slow: using
  // the study's own elapsed months would have made it look like 0.2/month.
  const late = accrualPosterior({ enrolled: 2, monthsOpen: 2 });
  assert.equal(late.meanRatePerMonth, 1);
});

test("optional Poisson-Gamma designs use explicit posteriors and no center CRM input",()=>{
 const scenario={sites:[{id:"assumption_1",alpha:2,beta:4,startTime:0}],target:60,byTimes:[6,12]};
 assert.deepEqual(validateEngineJob({jobId:"job_1",studyId:"std_1",kind:"accrual_forecast",method:"accrual.poisson_gamma",methodVersion:"1.0.0",protocolVersion:1,seed:7,cpuSecondsLimit:60,inputs:[],scenario}),[]);
});

test("AC-37 the forecast is queued on the deterministic engine through the injected job port", async () => {
  /** @type {any[]} */
  const queued = [];
  const jobs = { enqueue: async (job) => { queued.push(job); return { job: { id: "job-1", state: "queued" } }; } };
  const scenario={target:60,sites:[{id:"assumption_1",alpha:1,beta:1,startTime:0}]};
  const handle = await requestAccrualForecast({ jobs, studyId: "std-1", userId: "u-1", scenario, requestedBy: "matching" });
  assert.equal(handle.job.id, "job-1");
  assert.equal(queued.length, 1);
  assert.equal(queued[0].kind, "accrual_forecast");
  assert.equal(queued[0].studyId, "std-1");
  assert.equal(queued[0].userId, "u-1", "the queue needs the account the job is for");
  assert.equal(queued[0].scenario.target, 60);
  assert.deepEqual(queued[0].detail.keepTables, ["probability_by_month"], "the table a page draws the probability curve from is kept");
  assert.equal(VCR_JOB_METHODS.accrual_forecast, "accrual.poisson_gamma", "the engine method this kind maps to");
  await assert.rejects(() => requestAccrualForecast({ jobs, studyId: "std-1", userId: "u-1", scenario: { kind: "design" } }), /accrual scenario/);
  await assert.rejects(() => requestAccrualForecast({ jobs: null, studyId: "std-1", userId: "u-1", scenario }), /jobs port/);
});

test("AC-37 the forecast reads the engine's own measures, and an interval that does not name its kind is dropped rather than relabelled", () => {
  const read = readAccrualForecast({
    status: "succeeded",
    measures: [
      { name: "last_patient_in_months", value: 18.4, interval: { kind: "prediction", low: 15.1, high: 23.9 } },
      { name: "target_events_months", value: 26.0, interval: { low: 22, high: 31 } },
    ],
    diagnostics: { quantiles: { p20: 15.8, p50: 18.4, p80: 21.7 } },
  }, { probabilityByMonth: parseProbabilityByMonth("month,probability,mcse\n6,0.05,0.01\n12,0.4,0.01\n18,0.8,NA\n") });
  assert.equal(read.lastPatientIn.value, 18.4);
  assert.equal(read.targetEventsReached, null, "an unnamed interval is not a prediction interval");
  assert.deepEqual(read.droppedUnnamedIntervals, ["target_events_months"]);
  assert.deepEqual(read.probabilityByMonth, [{ month: 6, probability: 0.05 }, { month: 12, probability: 0.4 }, { month: 18, probability: 0.8 }]);
  assert.deepEqual(Object.keys(read.commitments).sort(), ["aggressive", "balanced", "conservative"]);
  assert.equal(read.commitments.conservative.quantile, VCR_RISK_APPETITE_QUANTILES.conservative);
  assert.match(read.commitments.balanced.note, /不是预测更准/);
  assert.deepEqual(VCR_ACCRUAL_MEASURES, { lastPatientIn: "last_patient_in_months", targetEvents: "target_events_months" });
});

test("matching candidates use only each subject's newest scientific assessment, preserving unknown and deferred evidence", () => {
 const candidates=matchingCandidates({studyId:"std",assessments:[
  {id:"old",subjectKey:"S1",summary:"eligible",asOf:"2026-09-01"}, {id:"new",subjectKey:"S1",summary:"ineligible",asOf:"2026-10-01"},
  {id:"unknown",subjectKey:"S2",summary:"insufficient_evidence",asOf:"2026-10-01"}, {id:"deferred",subjectKey:"S3",summary:"pending",asOf:"2026-10-01"},
  {id:"eligible",subjectKey:"S4",summary:"eligible",asOf:"2026-10-01"}]});
 assert.deepEqual(candidates.map(row=>[row.subjectKey,row.eligibilitySummary]),[["S2","insufficient_evidence"],["S3","pending"],["S4","eligible"]]);
 for(const row of candidates)assert.equal('state' in row,false,"a research candidate carries no contact or referral state");
 assert.deepEqual(matchingCandidates({studyId:"std",assessments:[{subjectKey:"S2",summary:"insufficient_evidence"}],includeInsufficient:false}),[]);
});
