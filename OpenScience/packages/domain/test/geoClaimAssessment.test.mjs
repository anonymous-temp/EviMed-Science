import assert from 'node:assert/strict'
import { test } from 'node:test'
import { geoEnrichStatementIdentity, geoClaimAssessmentIdentity } from '../src/geoClaimAssessment.mjs'
const claim = { id: 'frozen', key: 'label', version: 1, population: 'Adults', elements: { form: 'tablet' }, inLabel: true, quote: 'Adults only.' }
const legacy = { text: 'All ages.', claimId: claim.id, claimKey: claim.key, verdict: 'wrong' }
test('legacy identity fills only from its unique frozen claim and leaves the original unchanged', () => {
  const enriched = geoEnrichStatementIdentity(legacy, [claim])
  assert.equal(geoClaimAssessmentIdentity(enriched), geoClaimAssessmentIdentity(claim))
  assert.equal(legacy.claimVersion, undefined)
  assert.equal(enriched.verdict, 'wrong')
})
test('missing, mixed versions, populations, forms and label conditions remain unknown', () => {
  for (const other of [{ version: 2 }, { population: 'Children' }, { elements: { form: 'solution' } }, { inLabel: false }, { validUntil: '2025-01-01' }, { evidenceLevel: 'trial' }]) {
    assert.equal(geoEnrichStatementIdentity(legacy, [claim, { ...claim, ...other }]), null)
  }
  assert.equal(geoEnrichStatementIdentity(legacy, []), null)
})
test('existing partial metadata constrains enrichment and a mismatched key never borrows identity', () => {
  assert.equal(geoEnrichStatementIdentity({ ...legacy, claimVersion: 2 }, [claim]), null)
  assert.equal(geoEnrichStatementIdentity({ ...legacy, claimKey: 'other_label' }, [claim]), null)
  assert.equal(geoEnrichStatementIdentity({ ...legacy, claimId: null }, [claim]), null)
  assert.equal(geoEnrichStatementIdentity(legacy, [{ ...claim, version: null }]), null)
})
test('a complete preserved identity is retained without being replaced by newer live conditions', () => {
  const complete = geoEnrichStatementIdentity(legacy, [claim])
  assert.equal(geoEnrichStatementIdentity(complete, [{ ...claim, version: 2 }]), complete)
})
