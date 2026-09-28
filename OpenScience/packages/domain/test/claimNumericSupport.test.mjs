import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { validateEvidenceClaim } from '../src/clinicalEvidence.mjs'

// The last production attempt of clinical-evidence-synthesis (2026-09-08,
// EMPA-KIDNEY) came back with a "hazard ratio or CI absent from its quoted
// direct support" on eleven of its fifty-three direct claims. Every one was a
// faithful transcription: the journal wrote 「0.64 to 0.82」 or the Lancet's
// 「0·78」, the claim 「0.64–0.82」 and 「0.78」.
const MATRIX = new URL('../../../evals/clinical-review-quality/results/2026-09-08-review-001-empa-kidney-report-family/deliverable/deliverables/empa-kidney-durability/clinical-evidence-matrix.json', import.meta.url)

/** A claim judged against a source that holds exactly its quote. @param {any} claim @param {any[]} claims */
function numericFindings(claim, claims = [claim]) {
  const path = claim.artifactPath ?? '.evimed-sources/x/fulltext.md'
  const verdict = validateEvidenceClaim({ claim: { ...claim, artifactPath: path }, claims, sourceArtifacts: { [path]: `Before. ${claim.supportQuote}. After.` }, sourceTypes: {} })
  return verdict.issues.filter((/** @type {any} */ issue) => issue.code === 'claim-numeric-support')
}

test('a quoted interval restated faithfully is supported, however the journal spells it', async () => {
  const matrix = JSON.parse(await readFile(MATRIX, 'utf8'))
  const direct = matrix.claims.filter((/** @type {any} */ claim) => claim.claimType === 'direct')
  assert.ok(direct.length >= 50, 'the specimen matrix was not read')
  const flagged = direct.filter((/** @type {any} */ claim) => numericFindings(claim, matrix.claims).length)
  assert.deepEqual(flagged.map((/** @type {any} */ claim) => claim.claimId), [])
})

test('the equivalence reads spellings, never different numbers', () => {
  const base = { claimId: 'CLM-001', claimType: 'direct', artifactPath: '.evimed-sources/x/fulltext.md', sourceUrl: 'https://example.org/a', sourceTitle: 'A trial', identifier: 'doi:10.1/x', accessLevel: 'full_text', referenceNumber: 1 }
  const supported = (/** @type {string} */ claim, /** @type {string} */ supportQuote) => numericFindings({ ...base, claim, supportQuote }).length === 0
  assert.equal(supported('HR 0.72 (95% CI 0.64–0.82).', 'hazard ratio, 0.72; 95% CI 0.64 to 0.82'), true)
  assert.equal(supported('ACR fell by 19% (95% CI 15–23%).', 'reduced by 19% (95% CI 15% to 23%)'), true)
  assert.equal(supported('HR 0.78 (95% CI 0.60–1.00).', 'HR 0·78; 95% CI 0·60 to 1·00'), true)
  assert.equal(supported('风险比 0.78（95% CI 0.60–1.00）。', '风险比 0.78（95% CI 0.60～1.00）'), true)
  // Different numbers stay unsupported.
  assert.equal(supported('HR 0.72 (95% CI 0.64–0.83).', 'hazard ratio, 0.72; 95% CI 0.64 to 0.82'), false)
  assert.equal(supported('HR 0.79 (95% CI 0.60–1.00).', 'HR 0·78; 95% CI 0·60 to 1·00'), false)
})
