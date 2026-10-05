import { usagePurposeOfRun, isResearcherOwnedWork } from '../src/usagePurpose.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { evolutionDecisionClass, evolutionAdaptiveClass, evolutionValidationLevel, evolutionToolVisible, evolutionDataMatch, evolutionMethodFields } from '../src/evolution.mjs'

test('irreversible actions remain C regardless of adaptive autonomy', () => {
  assert.equal(evolutionDecisionClass({ externalSend: true, resourceOnly: true }), 'C')
  assert.equal(evolutionAdaptiveClass(Array.from({ length: 10 }, () => ({ overridden: false }))), 'A')
  assert.equal(evolutionAdaptiveClass([{ overridden: true }, {}, { overridden: true }]), 'B')
})
test('assessment leakage and self-report cannot raise validation labels', () => {
  assert.equal(evolutionValidationLevel([{ independent: false, passed: true, kind: 'research', papers: 50 }]), 'V0')
  assert.equal(evolutionValidationLevel([{ independent: true, passed: true, kind: 'research', papers: 5, exposed: true }]), 'V0')
  assert.equal(evolutionToolVisible({ status: 'active', validationLevel: 'V0', toolKind: 'calculation' }), false)
  assert.equal(evolutionToolVisible({ status: 'active', validationLevel: 'V0', toolKind: 'workflow', smokePassed: true }), true)
})
test('unknown research sufficiency remains unknown; hidden fields are stripped', () => {
  assert.deepEqual(evolutionDataMatch({ schema: { fields: [] }, researchRules: { minEvents: 10 } }, { semanticsChecksPassed: true }).issues, ['events-unknown'])
  assert.deepEqual(evolutionMethodFields({ holdoutCases: [{ id: 'c', sha256: 'x', expected: 42 }] }).holdoutCases, [{ id: 'c', sha256: 'x' }])
})

test('units, categories and population require known compatible facts', () => {
  const req = {schema: {fields: [{name: 'weight', type: 'number', unit: 'kg'}, {name: 'group', type: 'string', constraints: {enum: ['a','b']}}]}, researchRules: {population: 'adults'}}
  const result = evolutionDataMatch(req, {fields: [{name: 'weight', type: 'number'}, {name: 'group', type: 'string', categories: ['c']}], semanticsChecksPassed: true})
  assert.equal(result.matched, false)
  assert.deepEqual(result.issues, ['unit:weight:unknown', 'categories:group:mismatch', 'population-unknown'])
})

test('paper-gold ordinary capabilities are platform spend and never researcher work', () => {
  const run = {effectiveAgentId: 'meta-analysis', dispatchId: 'paper_weekly_case_0', effectiveRouteReason: 'platform-evolution', automated: true}
  assert.equal(usagePurposeOfRun(run), 'evolution')
  assert.equal(isResearcherOwnedWork(run), false)
})

test('promotion requires observed publication exposure and measured Monte Carlo error', () => {
  const cases=['a','b'].map(caseId=>({caseId,kind:'published-case',independent:true,passed:true}))
  assert.equal(evolutionValidationLevel(cases),'V0')
  assert.equal(evolutionValidationLevel(cases.map(row=>({...row,exposed:false,retracted:false}))),'V2')
  const simulation={kind:'simulation',independent:true,passed:true,preRegistered:true}
  assert.equal(evolutionValidationLevel([{...simulation,monteCarloError:'unknown'}]),'V0')
  assert.equal(evolutionValidationLevel([{...simulation,monteCarloError:{bias:0.1,coverage:0.02,falsePositive:0.01}}]),'V1')
})

test('numeric integer profiles and explicitly scoped actual semantics checks match without inventing unrelated checks', () => {
  const requirement = {schema:{fields:[{name:'age',type:'number',unit:'a'}]},researchRules:{requiredSemanticsChecks:['drift']}}
  const dataset = {fields:[{name:'age',type:'integer',unit:'a'}],semanticsChecksPassed:false,semanticsChecks:{checkedAt:'2026-10-04',passedFamilies:['drift'],attentionFamilies:[],unavailableFamilies:['joins','leakage']}}
  assert.equal(evolutionDataMatch(requirement,dataset).matched,true)
  assert.equal(evolutionDataMatch({...requirement,researchRules:{}},dataset).matched,false)
  assert.equal(evolutionDataMatch({...requirement,researchRules:{requiredSemanticsChecks:['leakage']}},dataset).matched,false)
  assert.equal(evolutionDataMatch({...requirement,researchRules:{requiredSemanticsChecks:[]}},dataset).matched,false)
})
