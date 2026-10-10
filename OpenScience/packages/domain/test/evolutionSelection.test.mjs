import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evolutionMechanismLimit, evolutionNoiseBand, selectEvolutionCandidate, selectEvolutionParent } from '../src/evolutionSelection.mjs'
test('mechanisms tighten to one and deterministic noise has a two-percent floor', () => {
  assert.deepEqual(Array.from({length:10}, (_,i) => evolutionMechanismLimit(i+1)), [3,3,3,3,2,2,2,1,1,1])
  assert.equal(evolutionNoiseBand([[0.8,0.9],[0.8,0.9],[0.8,0.9]]),0.02)
  assert.throws(()=>evolutionNoiseBand([[1],[1]]))
})
const evidence={evidenceTier:'exact',receiptValid:true,confirmatory:true,firstAttempt:true,baseline:0.8,score:0.83,historicalBest:0.8,delta:0.02,fullScale:1,baselineCost:1,cost:1.4}
test('gain, cost allowance, saving and historical floor determine promotion independently',()=>{
  assert.equal(selectEvolutionCandidate(evidence).outcome,'improved')
  assert.equal(selectEvolutionCandidate({...evidence,cost:1.41}).promote,false)
  assert.equal(selectEvolutionCandidate({...evidence,score:0.79,cost:0.9}).outcome,'cheaper')
  assert.equal(selectEvolutionCandidate({...evidence,score:0.79,cost:0.9,historicalBest:0.82}).outcome,'regressed')
  assert.equal(selectEvolutionCandidate({...evidence,score:0.8,cost:1,removedMechanisms:1}).outcome,'simplified')
  assert.equal(selectEvolutionCandidate({...evidence,firstAttempt:false}).promote,false)
})
test('absolute reference cases need all successes; parent potential cannot authorize publication',()=>{
  assert.equal(selectEvolutionCandidate({...evidence,tool:true,hiddenCases:2,hiddenPassed:1}).promote,false)
  assert.equal(selectEvolutionCandidate({...evidence,tool:true,hiddenCases:2,hiddenPassed:2,crossImplementationPassed:false}).promote,false)
  assert.equal(selectEvolutionParent([{id:'a',score:1,promotedDescendants:1,evaluatedDescendants:10},{id:'b',score:0,promotedDescendants:2,evaluatedDescendants:3}]).id,'b')
})
test('V4 requires positive scientific evidence and exhausted monitoring states explain their limit',async()=>{
 const {evolutionValidationLevel}=await import('../src/evolution.mjs')
 const {methodHarmTest,emptyLearning}=await import('../src/methodGraph.mjs')
 const assessment=[{independent:true,passed:true,kind:'research',papers:5,exposed:false,retracted:false}]
 assert.equal(evolutionValidationLevel(assessment,{harmState:'clear',runs:40}),'V3')
 assert.equal(evolutionValidationLevel(assessment,{harmState:'clear',runs:40,attributablePositiveResults:1}),'V4')
 const learning={...emptyLearning('fixture'),observations:Array.from({length:40},(_,i)=>({runId:`run-${i}`,family:`family-${i}`,outcome:i%2?'accepted':'rejected',invoked:true,at:String(i).padStart(2,'0')}))}
 const result=methodHarmTest(learning,{baseRate:0.25,harmRate:0.26,minRuns:6,maxRuns:40,alpha:0.05,beta:0.2})
 assert.equal(result.state,'clear');assert.equal(result.reason,'window-exhausted')
})

test('unknown evidence tiers cannot bypass scorer calibration',()=>{assert.equal(selectEvolutionCandidate({...evidence,evidenceTier:'unknown'}).outcome,'invalid-evidence')})

// A model-scored promotion needs a calibrated scorer, deterministic checks that ran, and no regression on them against the incumbent. A written checklist
// is neither a model nor a judge and needs none of it (review D-E19).
test('a model-scored promotion needs a calibrated scorer and deterministic checks that ran without regressing; a checklist needs neither',()=>{
  const model={...evidence,evidenceTier:'model',score:0.9,baseline:0.7,historicalBest:0.7,anchorCalibrated:true,modelScoredLabel:true,deterministicChecksPassed:true}
  assert.deepEqual([selectEvolutionCandidate(model).outcome,selectEvolutionCandidate(model).promote],['improved',true])
  assert.deepEqual(selectEvolutionCandidate({...model,anchorCalibrated:false}),{outcome:'invalid-evidence',reason:'model-score-not-calibrated',promote:false,scope:null})
  assert.equal(selectEvolutionCandidate({...model,modelScoredLabel:false}).reason,'model-score-not-calibrated')
  assert.deepEqual(selectEvolutionCandidate({...model,deterministicChecksPassed:false,deterministicChecksRegressed:true}),{outcome:'regressed',reason:'deterministic-check-regressed',promote:false,scope:null})
  assert.deepEqual(selectEvolutionCandidate({...model,deterministicChecksPassed:false}),{outcome:'invalid-evidence',reason:'deterministic-checks-missing',promote:false,scope:null})
  assert.equal(selectEvolutionCandidate({...model,deterministicChecksPassed:undefined}).reason,'deterministic-checks-missing')
  const checklist={...model,evidenceTier:'checklist',anchorCalibrated:false,modelScoredLabel:false,deterministicChecksPassed:undefined}
  assert.deepEqual([selectEvolutionCandidate(checklist).outcome,selectEvolutionCandidate(checklist).promote],['improved',true])
  assert.equal(selectEvolutionCandidate({...checklist,score:0.6}).outcome,'regressed','a checklist candidate worse than the incumbent beyond the noise band is a regression')
})
