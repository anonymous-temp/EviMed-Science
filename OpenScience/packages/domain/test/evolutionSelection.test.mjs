import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evolutionMechanismLimit, evolutionNoiseBand, selectEvolutionCandidate, selectEvolutionParent, evolutionProposalIssues, evolutionNormalizeProposal, evolutionProposalDescriptionLength, EVOLUTION_PROPOSAL_DESCRIPTION_LIMIT } from '../src/evolutionSelection.mjs'
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

// Live, 2026-10-07 to 12: six of fifteen rejected proposals were refused for `description-too-long` alone, five attempts in a row for one mission.
// The proposals below have the shapes of the ledger's rejection records (`proposal-metadata`, the issue codes only).
const proposed = (extra = {}) => ({ components: ['selectionThreshold'], mechanisms: ['raise-threshold-gate'], change: 'Raise the selection threshold.', reason: 'Fewer borderline items pass.',
  rollbackVersion: 'default:1', predictedBenefits: ['precision'], possibleHarms: ['recall'], costChange: 0, ...extra })
test('the description limit counts characters of change and reason together, Chinese and English alike', () => {
  assert.equal(evolutionProposalDescriptionLength({ change: 'a'.repeat(100), reason: 'b'.repeat(99) }), 200)
  assert.deepEqual(evolutionProposalIssues(proposed({ change: 'a'.repeat(100), reason: 'b'.repeat(99) })), [])
  assert.deepEqual(evolutionProposalIssues(proposed({ change: 'a'.repeat(100), reason: 'b'.repeat(100) })), ['description-too-long'])
  assert.deepEqual(evolutionProposalIssues(proposed({ change: '把前沿编辑指令里的数字核对规则写得更明确。'.repeat(6), reason: '数字核对失败是最常见的退回原因。'.repeat(8) })), ['description-too-long'])
})
test('an account over the limit is shortened by code to fit it, says so, and the proposal is otherwise untouched', () => {
  for (const [change, reason] of [['c'.repeat(300), 'r'.repeat(60)], ['c'.repeat(40), 'r'.repeat(400)], ['c'.repeat(500), 'r'.repeat(500)], ['把阈值提高。'.repeat(40), '因为边界条目太多。'.repeat(40)]]) {
    const before = proposed({ change, reason }), after = evolutionNormalizeProposal(before)
    assert.deepEqual(evolutionProposalIssues(before), ['description-too-long'])
    assert.deepEqual(evolutionProposalIssues(after), [], 'the contract reads the shortened account')
    assert.ok(evolutionProposalDescriptionLength(after) <= EVOLUTION_PROPOSAL_DESCRIPTION_LIMIT)
    assert.equal(after.descriptionShortened.fromCharacters, evolutionProposalDescriptionLength(before))
    assert.deepEqual({ ...after, change: 0, reason: 0, descriptionShortened: 0 }, { ...before, change: 0, reason: 0, descriptionShortened: 0 })
    assert.ok(after.change.length > 0 && after.reason.length > 0, 'neither field is cut to nothing')
  }
  const short = proposed()
  assert.deepEqual(evolutionNormalizeProposal(short), short, 'a proposal inside the limit is returned as it was')
  assert.equal(evolutionNormalizeProposal(short).descriptionShortened, undefined)
})
test('a cut ends at a sentence where one fits in the second half, and otherwise at an ellipsis', () => {
  const sentences = evolutionNormalizeProposal(proposed({ change: '第一句很短。第二句也不长。第三句就太长了，一直写下去超过了限额。'.repeat(8), reason: '理由。' }))
  assert.match(sentences.change, /。$/)
  const run = evolutionNormalizeProposal(proposed({ change: 'x'.repeat(300), reason: 'y' }))
  assert.match(run.change, /…$/)
})
test('the plain forms of a list of one and of the cost figure are read as the contract expects, and a missing prediction is still the proposer\'s to supply', () => {
  const plain = evolutionNormalizeProposal(proposed({ predictedBenefits: 'precision', possibleHarms: 'recall', costChange: '0.2', change: '  Raise it.  ' }))
  assert.deepEqual([plain.predictedBenefits, plain.possibleHarms, plain.costChange, plain.change], [['precision'], ['recall'], 0.2, 'Raise it.'])
  assert.deepEqual(evolutionProposalIssues(plain), [])
  const missing = evolutionNormalizeProposal(proposed({ predictedBenefits: undefined, costChange: 'cheap' }))
  assert.deepEqual(evolutionProposalIssues(missing), ['prediction-required'])
  assert.equal(evolutionNormalizeProposal(null), null)
  assert.deepEqual(evolutionNormalizeProposal([1]), [1])
})
