import test from 'node:test';
import assert from 'node:assert/strict';
import { evolutionMonthlyMetrics } from '../src/evolutionMetrics.mjs';
test('unelapsed months and missing observations never claim perfect progress', () => {
  const report = evolutionMonthlyMetrics({month: '2026-10', now: new Date('2026-10-04')});
  assert.equal(report.observationWindow.status, 'not-observed'); assert.equal(report.byTrack[0].allStagesValid.value, null); assert.equal(report.exposureLeakage.value, null); assert.equal(report.platformCostCny, null);
});
test('time holdout and prospective success exclude development and use reachable evidence denominator', () => {
  const report = evolutionMonthlyMetrics({month: '2026-10', now: new Date('2026-11-01'), evaluations: [{at: '2026-10-20', units: [
    {track: 'E', group: 'time-holdout', eligibleForMainMetric:true, allStagesValid: true,codeVerified:true, recall: {denominator: 2, found: 1, connectorGaps: ['unreachable']}, exposureTier: 'unexposed'},
    {track: 'E', group: 'prospective', eligibleForMainMetric:true, allStagesValid: false, exposureTier: 'cited'},
    {track: 'E', group: 'development', allStagesValid: true,codeVerified:true},
  ]}]});
  assert.equal(report.byTrack[0].allStagesValid.value, 1); assert.equal(report.byTrack[0].includingExposed.value, 0.5); assert.equal(report.reachableEvidenceRecall.value, 0.5); assert.equal(report.connectorGaps, 1); assert.equal(report.exposureLeakage.value, 0.5);
});
test('same coverage smaller library, lead time, actual calls and harm retirements are measured independently', () => {
  const tools = [{id: 't', dossierId: 'd', createdAt: '2026-10-03', status: 'active', validationLevel: 'V2', holdoutCases: [{id: 'case', sha256: 'x'}], artifactBytes: 100, usage: {invoked: 5, retrieved: 10}}, {status: 'retired', retirement: {reason: 'sequential-harm', at: '2026-10-25'}}];
  const report = evolutionMonthlyMetrics({month: '2026-10', now: new Date('2026-11-01'), tools, dossiers: [{id: 'd', createdAt: '2026-10-01', toolId: 't'}], previous: {verifiedCaseCoverage: 1, activeArtifactBytes: 150,inventorySnapshot:{scope:'current-observed-library',observedAt:'2026-10-01'}}});
  assert.equal(report.invocationToRetrieval.value, 0.5); assert.equal(report.medianLeadToPublicationHours, 48); assert.equal(report.harmRetirements, 1); assert.equal(report.sizeAtSameCoverage.deltaBytes, -50);
});
test('missing-input research response cannot count as full reproduction and exposed uncited is audited', () => {
  const report = evolutionMonthlyMetrics({month:'2026-10',evaluations:[{at:'2026-10-04',units:[
    {type:'research',track:'E',group:'prospective',allStagesValid:true,codeVerified:true,exposureTier:'unexposed'},
    {type:'research',track:'E',group:'prospective',benchmarkScope:'research',allStagesValid:true,codeVerified:true,fullResearchReproductionValid:false,exposureTier:'exposed_uncited'},
  ]}]});
  assert.equal(report.byTrack[0].allStagesValid.denominator,0);
  assert.equal(report.byTrack[0].includingExposed.value,0);
  assert.equal(report.byTrack[0].byExposure[1].allStagesValid.denominator,1);
});
test('numeric-only and question-only observations cannot depress full-study rates; request calls deduplicate', () => {
  const report=evolutionMonthlyMetrics({month:'2026-10',now:new Date('2026-11-02'),evaluations:[{at:'2026-10-04',units:[
    {track:'E',group:'prospective',eligibleForMainMetric:false,benchmarkScope:'numeric-prospective-prediction',allStagesValid:false,numericEvaluationPassed:true,exposureTier:'unexposed'},
    {track:'E',group:'time-holdout',benchmarkScope:'question-only',allStagesValid:true,codeVerified:true,exposureTier:'unexposed'},
  ]}],uses:[
    {at:'2026-10-04',projectId:'p',runId:'r',track:'E',supported:false},
    {at:'2026-10-04',projectId:'p',runId:'r',track:'E',supported:true},
    {at:'2026-10-04',projectId:'p',runId:'eval',track:'E',supported:true,evaluation:true},
  ],previous:{verifiedCaseCoverage:0,activeArtifactBytes:100}});
  assert.equal(report.byTrack[0].allStagesValid.value,null);assert.equal(report.byTrack[0].numericOutcome.value,1);
  assert.equal(report.byTrack[0].supportedRealRequests.denominator,1);assert.equal(report.byTrack[0].supportedRealRequests.value,1);
  assert.equal(report.inventorySnapshot.historicalMonthEnd,false);assert.equal(report.inventorySnapshot.observedAt,'2026-11-02T00:00:00.000Z');
  assert.equal(report.sizeAtSameCoverage.observed,false);
});

test('legacy positive research without control computation proof remains unknown in main metric',()=>{
 const report=evolutionMonthlyMetrics({month:'2026-10',now:new Date('2026-11-01'),evaluations:[{at:'2026-10-04',units:[{track:'E',type:'research',group:'time-holdout',benchmarkScope:'research',exposureTier:'unexposed',allStagesValid:true,fullResearchReproductionValid:true}]}]});
 assert.equal(report.byTrack.find(row=>row.track==='E').allStagesValid.denominator,0);
 assert.equal(report.byTrack.find(row=>row.track==='E').allStagesValid.value,null);
});
