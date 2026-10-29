import assert from 'node:assert/strict';
import test from 'node:test';
import { vcrAnalyticComputationBasis } from '../src/vcrScientificBasis.mjs';
import { presentDesigns } from '../src/vcrViews.mjs';
const result={id:'r',version:1,kind:'trial_scenario',subjectId:'s',executionId:'e',method:'design.analytic',methodVersion:'1.2.0',createdAt:'2026-10-26T00:00:00Z',diagnostics:{sampleSize:{basis:'normal_approximation',formula:'two_sample_means_normal_approximation',rounding:'ceiling_each_arm_then_sum',unrounded:{total:180.838,treat:90.419,control:90.419},targetPower:.8,nTreatment:91,nControl:91,total:182,allocationRequested:.5,allocationAchieved:.5,powerCheckBasis:'pooled_two_sample_t',powerAtAllocatedN:.798305621}},measures:[{name:'required_total',value:182},{name:'required_treatment',value:91},{name:'required_control',value:91}]};
test('one validated scientific basis serves replay and saved design rows; legacy and inconsistent values stay absent',()=>{
 const basis=vcrAnalyticComputationBasis(result);assert.equal(basis.total,182);assert.equal(basis.powerAtAllocatedN,.798305621);assert.match(basis.note,/not an exact/);
 const bundle={study:{},scenarios:[{id:'s',version:1,label:'A',configuration:{}}],results:[result],allResults:[result],executions:new Map([['e',{method:'design.analytic',methodVersion:'1.2.0'}]]),stale:[],decisions:[]};
 assert.deepEqual(presentDesigns(bundle).designs[0].computationBasis,basis);
 for(const change of [r=>r.methodVersion='1.1.0',r=>r.diagnostics.sampleSize.total=181,r=>r.diagnostics.sampleSize.nControl=90,r=>r.diagnostics.sampleSize.powerCheckBasis='exact',r=>r.diagnostics.sampleSize.powerAtAllocatedN=9]){const bad=structuredClone(result);change(bad);assert.equal(vcrAnalyticComputationBasis(bad),null);}
});
test('TTE basis preserves event-probability sizing and actual-arm logrank check',()=>{
 const survival=structuredClone(result);const s=survival.diagnostics.sampleSize;s.basis='schoenfeld_event_probability';s.formula='schoenfeld_lachin_foulkes';s.powerCheckBasis='logrank_martingale_integral';s.expectedEventsAtAllocatedN=150;survival.measures[0].name='required_patients';
 const basis=vcrAnalyticComputationBasis(survival);assert.equal(basis.expectedEventsAtAllocatedN,150);assert.match(basis.note,/Schoenfeld/);
 delete s.expectedEventsAtAllocatedN;assert.equal(vcrAnalyticComputationBasis(survival),null);
});
