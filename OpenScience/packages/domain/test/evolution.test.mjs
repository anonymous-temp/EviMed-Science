import { usagePurposeOfRun, isResearcherOwnedWork } from '../src/usagePurpose.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { evolutionMethodFields } from '../src/evolution.mjs'

test('hidden fields are stripped', () => {
  assert.deepEqual(evolutionMethodFields({ holdoutCases: [{ id: 'c', sha256: 'x', expected: 42 }] }).holdoutCases, [{ id: 'c', sha256: 'x' }])
})

test('paper-gold ordinary capabilities are platform spend and never researcher work', () => {
  const run = {effectiveAgentId: 'meta-analysis', dispatchId: 'paper_weekly_case_0', effectiveRouteReason: 'platform-evolution', automated: true}
  assert.equal(usagePurposeOfRun(run), 'evolution')
  assert.equal(isResearcherOwnedWork(run), false)
})
