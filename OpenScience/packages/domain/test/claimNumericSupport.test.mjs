import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { conclusoryQuantities, validateClinicalEvidencePackage, validateEvidenceClaim } from '../src/clinicalEvidence.mjs'

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

test('a Chinese interval and a raised decimal point read the same on the report line, the claim and the quote', () => {
  // 「至」 is the interval a Chinese report writes; the Lancet's raised dot is a
  // decimal point. Read on the support side alone, 「50%（42% 至 58%）」 came
  // back as the endpoints 42 and 58 no quote offers, and 「1·37」 in a report
  // line was not read as a number at all.
  assert.deepEqual([...conclusoryQuantities('相对降低 50%（42% 至 58%）')], ['50', '42-58'])
  assert.ok(conclusoryQuantities('下降速度慢 1·37（95% CI 1·16–1·59）mL/min').has('1.16-1.59'))
  assert.deepEqual([...conclusoryQuantities('2020年至2025年发表的研究 12 项')], ['12'], 'years joined by 至 are not an interval of two numerals')
  const base = { claimId: 'CLM-001', claimType: 'direct', artifactPath: '.evimed-sources/x/fulltext.md', sourceUrl: 'https://example.org/a', sourceTitle: 'A trial', identifier: 'doi:10.1/x', accessLevel: 'full_text', referenceNumber: 1 }
  const supported = (/** @type {string} */ claim, /** @type {string} */ supportQuote) => numericFindings({ ...base, claim, supportQuote }).length === 0
  assert.equal(supported('风险比 0.79（95% CI 0.72 至 0.87）。', 'hazard ratio, 0.79; 95% CI, 0.72 to 0.87'), true)
  assert.equal(supported('风险比 0·78（95% CI 0·60 至 1·00）。', 'HR 0.78 (95% CI 0.60–1.00)'), true)
  assert.equal(supported('相对降低 50%（95% CI 42% 至 58%）。', 'a 50% (95% CI 42–58) relative reduction'), true)
  // Different numbers stay unsupported.
  assert.equal(supported('风险比 0.79（95% CI 0.72 至 0.88）。', 'hazard ratio, 0.79; 95% CI, 0.72 to 0.87'), false)
  assert.equal(supported('风险比 0·77（95% CI 0·60 至 1·00）。', 'HR 0.78 (95% CI 0.60–1.00)'), false)
})

test('the 2026-09-28 EMPA-KIDNEY report lines are read as written, and the one misplaced figure is still named', async () => {
  const dir = new URL('../../../evals/clinical-review-quality/results/2026-09-28-review-001-empa-kidney-report-family/deliverable/deliverables/empa-kidney-durability/', import.meta.url)
  const reportText = await readFile(new URL('clinical-evidence-report.md', dir), 'utf8')
  const matrix = JSON.parse(await readFile(new URL('clinical-evidence-matrix.json', dir), 'utf8'))
  const lines = validateClinicalEvidencePackage({ reportText, matrix }).issues
    .map((/** @type {any} */ issue) => /^Report line (\d+) numeric facts .* not present in the cited claim evidence/.exec(String(issue?.message ?? issue))?.[1])
    .filter(Boolean)
    .map(Number)
  assert.ok(lines.length > 0, 'the specimen was not read')
  // Lines 14, 70, 72, 76 and 94 write intervals with 「至」 and decimals with
  // raised dots; each figure is in the claim it cites.
  for (const line of [14, 70, 72, 76, 94]) assert.equal(lines.includes(line), false, `line ${line} is still reported`)
  // Line 165 puts 74% — the share that entered follow-up, CLM-068 — behind
  // claims that do not state it: a real finding, and it stays one.
  assert.equal(lines.includes(165), true)
})
