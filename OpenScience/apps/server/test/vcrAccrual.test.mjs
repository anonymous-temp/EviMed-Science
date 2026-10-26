import assert from "node:assert/strict";
import test from "node:test";
import { VCR_ACCRUAL_MEASURES, VCR_RISK_APPETITE_QUANTILES, parseProbabilityByMonth, readAccrualForecast } from "../src/vcrAccrual.mjs";
import { validateEngineJob } from "@evimed/domain";
import { matchingCandidates } from "../src/vcrMatchingCandidates.mjs";
test("optional Poisson-Gamma designs use explicit posteriors and no center CRM input",()=>{
 const scenario={sites:[{id:"assumption_1",alpha:2,beta:4,startTime:0}],target:60,byTimes:[6,12]};
 assert.deepEqual(validateEngineJob({jobId:"job_1",studyId:"std_1",kind:"accrual_forecast",method:"accrual.poisson_gamma",methodVersion:"1.0.0",protocolVersion:1,seed:7,cpuSecondsLimit:60,inputs:[],scenario}),[]);
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
