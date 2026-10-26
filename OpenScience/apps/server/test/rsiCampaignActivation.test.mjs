import test from 'node:test'
import assert from 'node:assert/strict'
import { rsiCampaignSelection, rsiCampaignFuse, rsiActivationReceipt } from '../src/rsiCampaignActivation.mjs'
const row = { id: 'bundle', operationId: 'op', phase:'stage', candidateDigest: 'a'.repeat(64), revision: 'next', previousRevision: 'base', mode: 'shadow', state: 'exposed', cohortPercent: 100 }
test('shared-feed shadow always serves incumbent and pins ongoing runs', () => {
 assert.deepEqual(rsiCampaignSelection(row, {userId:'u',projectId:'p'}), {revision:'base',arm:'control',shadowRevision:'next',operationId:'op'})
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
