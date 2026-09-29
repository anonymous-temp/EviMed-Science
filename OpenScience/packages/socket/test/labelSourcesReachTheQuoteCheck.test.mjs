// A label read preserves the whole label, one file per section, and names the
// files in `artifacts` and `data.artifactSha256s` — never on its one source.
// Recorded with no path, no section reached the quote check: 33 of the 55
// claims of the 2026-09-28 clopidogrel insight pack (evals/geo-insight/results/
// 2026-09-28-geo-insight-003-clopidogrel-identity) came back as 「could not be
// checked」, every one quoting a section file the run had read, while the
// PubMed, guideline and web sources beside them were checked.
import assert from 'node:assert/strict'
import test from 'node:test'

import { runGate } from '@evimed/domain'

import { evidenceFromOutcome } from '../src/evidenceIngest.mjs'
import { sourceArtifactPaths } from '../src/runPolicy.mjs'

const BASE = '.evimed-sources/drug-labels/455270100abc83b4/eeaa16ca'
const context = { runId: 'run_label', now: '2026-09-29T00:00:00Z', digest: (/** @type {string} */ value) => `d${value.length}` }

/** The label read as the research server answers it (server.py `_drug_label_read`). */
const labelRead = {
  status: 'completed',
  text: '',
  structured: {
    status: 'warning',
    sources: [{ id: 'label:H20000542', title: '硫酸氢氯吡格雷片', url: 'https://example.org/label' }],
    data: {
      label: { sections: [{ section: 'indications', artifactPath: `${BASE}/indications.md` }, { section: 'dosage', artifactPath: `${BASE}/dosage.md` }] },
      artifactSha256s: { [`${BASE}/indications.md`]: 'a', [`${BASE}/dosage.md`]: 'b', [`${BASE}/label.json`]: 'c' },
    },
    artifacts: [`${BASE}/dosage.md`, `${BASE}/indications.md`, `${BASE}/label.json`, `${BASE}/source.json`],
  },
}

test('a label read records every section it preserved, and each reaches the quote check', () => {
  const records = evidenceFromOutcome({ name: 'mcp__evimed__drug_label_search', args: { labelId: 'label:H20000542' } }, labelRead, context)
  assert.equal(records.length, 1, 'one source, one row')
  assert.deepEqual(records[0].artifactPaths, [`${BASE}/dosage.md`, `${BASE}/indications.md`], 'the text files, not the metadata')
  assert.deepEqual(sourceArtifactPaths(records, 'run_label'), [`${BASE}/dosage.md`, `${BASE}/indications.md`])

  // What the gate then does with them: the claim quoting a section is checked.
  const claims = { claims: [{ claimKey: 'PLV-01-LABEL-IND', statement: '适用于近期心肌梗死患者', quote: '近期心肌梗死患者', artifactPath: `${BASE}/indications.md` }] }
  const files = new Map([['claims.json', JSON.stringify(claims)]])
  const sourceArtifacts = { [`${BASE}/indications.md`]: '【适应症】近期心肌梗死患者（从几天到小于35天）。' }
  const codes = runGate(/** @type {any} */ ({ contractKind: 'geo-insight-pack', files, sourceArtifacts })).issues.map((/** @type {any} */ issue) => issue.code)
  assert.equal(codes.includes('geo_claim_unverified'), false, JSON.stringify(codes))
  assert.equal(codes.includes('geo_claim_quote_not_found'), false)
  // The control: the same claim with no preserved text is the notice the pack got.
  const unread = runGate(/** @type {any} */ ({ contractKind: 'geo-insight-pack', files, sourceArtifacts: {} })).issues.map((/** @type {any} */ issue) => issue.code)
  assert.equal(unread.includes('geo_claim_unverified'), true, JSON.stringify(unread))
})

test('a result with several sources attributes no shared file to any of them', () => {
  const search = {
    status: 'completed',
    text: '',
    structured: { sources: [{ id: 'label:A' }, { id: 'label:B' }], artifacts: [`${BASE}/indications.md`] },
  }
  for (const record of evidenceFromOutcome({ name: 'mcp__evimed__drug_label_search', args: { query: '氯吡格雷' } }, search, context)) {
    assert.equal(record.artifactPaths, undefined)
  }
  // A full-text read's one file is its artifactPath, not a second entry.
  const fullText = {
    status: 'completed',
    text: '',
    structured: { sources: [{ id: 'PMC1' }], data: { markdownPath: '.evimed-sources/pmc/PMC1/fulltext.md' }, artifacts: ['.evimed-sources/pmc/PMC1/fulltext.md', '.evimed-sources/pmc/PMC1/fulltext.pdf'] },
  }
  const [row] = evidenceFromOutcome({ name: 'mcp__evimed__open_access_full_text', args: { identifier: 'PMC1' } }, fullText, context)
  assert.equal(row.artifactPath, '.evimed-sources/pmc/PMC1/fulltext.md')
  assert.equal(row.artifactPaths, undefined)
})
