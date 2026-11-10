import test from 'node:test'
import assert from 'node:assert/strict'
import { rsiCampaignSelection, rsiCampaignFuse, rsiActivationReceipt } from '../src/rsiCampaignActivation.mjs'
const row = { id: 'bundle', operationId: 'op', phase:'stage', candidateDigest: 'a'.repeat(64), revision: 'next', previousRevision: 'base', mode: 'shadow', state: 'exposed', cohortPercent: 100 }
test('shared-feed shadow always serves incumbent and pins ongoing runs', () => {
 assert.deepEqual(rsiCampaignSelection(row, {userId:'u',projectId:'p'}), {revision:'base',arm:'control',shadowRevision:'next',operationId:'op',candidateDigest:'a'.repeat(64)})
 assert.equal(rsiCampaignSelection({...row, mode:'cohort'}, {runPin:'base'}).revision,'base')
 assert.equal(rsiCampaignSelection({...row, mode:'cohort',state:'stopped'}, {}).revision,'base')
})
test('publication requires identity-bound installed bytes, never boolean acknowledgement', () => {
 assert.equal(rsiActivationReceipt(true,row),false)
 assert.equal(rsiActivationReceipt({operationId:'op',phase:'stage',candidateDigest:'a'.repeat(64),revision:'next',installed:true},row),true)
 assert.equal(rsiActivationReceipt({operationId:'op',phase:'stage',candidateDigest:'b'.repeat(64),revision:'next',installed:true},row),false)
})
test('low traffic is inconclusive; a deterministic critical regression stops immediately', () => {
 const policy={minExecutions:100,minDays:3,maxErrors:0}
 assert.equal(rsiCampaignFuse({candidateExecutions:2,days:['2026-10-26'],errors:0},policy).state,'inconclusive')
 assert.equal(rsiCampaignFuse({candidateExecutions:100,days:['a','b','c'],errors:0},policy).state,'sufficient')
 assert.equal(rsiCampaignFuse({candidateExecutions:1,days:[],errors:0,criticalCode:'corrupt-bytes'},policy).state,'stop')
})
test('shadow pins cannot turn a shadow execution into serving publication',()=>{
 assert.equal(rsiCampaignSelection(row,{runPin:'next'}).revision,'base')
 assert.equal(rsiCampaignSelection(row,{runPin:'next'}).arm,'control')
})

test('activation intent never serves candidate before inspected active receipt',()=>{assert.equal(rsiCampaignSelection({...row,mode:'global',state:'staged'},{runPin:'next'}).revision,'base')})

test('every arm of an exposed campaign names the candidate under observation, so control executions are countable',()=>{
 const cohort={...row,mode:'cohort',cohortPercent:0.0001}
 const control=rsiCampaignSelection(cohort,{userId:'u',projectId:'p'})
 assert.equal(control.arm,'control');assert.equal(control.revision,'base');assert.equal(control.candidateDigest,'a'.repeat(64))
 const pinned=rsiCampaignSelection({...row,mode:'global'},{runPin:'base'})
 assert.equal(pinned.arm,'control');assert.equal(pinned.candidateDigest,'a'.repeat(64))
 assert.equal(rsiCampaignSelection({...row,mode:'global'},{}).candidateDigest,'a'.repeat(64))
 assert.equal(rsiCampaignSelection({...row,state:'staged'},{}).candidateDigest,undefined,'nothing is observed before exposure')
})

test('the volume bound stops past its floor, on either side, and only there',()=>{
 const policy={minExecutions:100,minDays:3,maxErrors:0,volumeBound:{max:1.1,min:0.5,minPicks:50}}
 const fuse=volumeByDay=>rsiCampaignFuse({candidateExecutions:1,days:['a'],errors:0,volumeByDay},policy)
 const day=(incumbentPicks,candidatePicks)=>({incumbentPicks,candidatePicks})
 // Under the floor nothing fires, however far apart the two lines are.
 assert.equal(fuse(undefined).state,'inconclusive')
 assert.equal(fuse({a:day(49,1)}).state,'inconclusive')
 assert.equal(fuse({a:day(1,49)}).state,'inconclusive')
 // Past it, on the stage's sum of days: above max, below min, and a candidate selecting where the incumbent selects nothing.
 assert.deepEqual(fuse({a:day(25,30),b:day(25,30)}),{state:'stop',reason:'registered-volume-bound',volume:{incumbent:50,candidate:60}})
 assert.deepEqual(fuse({a:day(60,29)}),{state:'stop',reason:'registered-volume-bound',volume:{incumbent:60,candidate:29}})
 assert.equal(fuse({a:day(0,50)}).reason,'registered-volume-bound')
 // The range's own ends are inside it.
 assert.equal(fuse({a:day(100,110)}).state,'inconclusive')
 assert.equal(fuse({a:day(100,50)}).state,'inconclusive')
 // Inside the bound the exposure decides as ever, and no bound means no such check.
 assert.equal(rsiCampaignFuse({candidateExecutions:100,days:['a','b','c'],errors:0,volumeByDay:{a:day(100,80)}},policy).state,'sufficient')
 assert.equal(rsiCampaignFuse({candidateExecutions:100,days:['a','b','c'],errors:0,volumeByDay:{a:day(100,1)}},{minExecutions:100,minDays:3,maxErrors:0}).state,'sufficient')
})
