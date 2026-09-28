import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { SNAPSHOT_RETRIEVED_KEY, auditCitedSources, runGate, withRetrievedSources } from '../index.mjs'

// The 2026-09-27 dapagliflozin evaluation as delivered: it passed every
// submission it made and was then delivered `unverified` over two must-fix
// findings from a check only the control plane ran.
const SPECIMEN = new URL('../../../evals/comprehensive-drug-evaluation/results/2026-09-27-cde-001-dapagliflozin-ckd/deliverable/deliverables/dapagliflozin-ckd-evaluation/', import.meta.url)
const REPORT = 'comprehensive-evaluation-report.md'
const SNAPSHOT = 'evidence-snapshot.json'

async function specimen() {
  const [report, snapshot] = await Promise.all([
    readFile(new URL(REPORT, SPECIMEN), 'utf8'),
    readFile(new URL(SNAPSHOT, SPECIMEN), 'utf8'),
  ])
  assert.ok(report.length > 10_000 && snapshot.length > 10_000, 'the specimen files were not read')
  return { report, snapshot }
}

const outputs = [
  { path: REPORT, required: true },
  { path: 'evidence-table.csv', required: true },
  { path: 'evaluation-summary.json', required: true },
  { path: SNAPSHOT, required: true },
]

test('the delivered package names the portal it linked and nothing it recorded', async () => {
  const { report, snapshot } = await specimen()
  const audit = auditCitedSources({ reports: [{ path: REPORT, text: report }], snapshotText: snapshot })
  assert.equal(audit.status, 'unrecorded')
  // The portal root the report offered as an 「官方核对入口」: no tool returned
  // it and the snapshot does not hold it.
  assert.deepEqual(audit.unrecorded.map((entry) => entry.url), ['https://www.nmpa.gov.cn/'])
  assert.equal(report.split('\n')[audit.unrecorded[0].line - 1].includes('https://www.nmpa.gov.cn/'), true, 'the line named is the line the link is on')
  // The KDIGO guideline's DOI link: the snapshot records that DOI (as one it
  // did not read), so it is recorded — by the run's own list only, which is a
  // notice rather than a verdict.
  assert.ok(audit.unretrieved.some((entry) => entry.url === 'https://doi.org/10.1016/j.kint.2023.10.018'), JSON.stringify(audit.unretrieved.slice(0, 3)))
})

test('the run-side gate now raises the check the control plane used to raise alone', async () => {
  const { report, snapshot } = await specimen()
  const files = new Map([[REPORT, report], ['evidence-table.csv', 'a,b\n1,2\n'], ['evaluation-summary.json', '{}'], [SNAPSHOT, snapshot]])
  const declared = runGate({ contractKind: 'drug-evaluation-report', files, expectedOutputs: outputs, checks: ['requiredOutputsExist', 'citationsResolvable', 'citedSourcesRecorded'] })
  const unrecorded = declared.issues.filter((entry) => entry.code === 'specialist_cited_source_unrecorded')
  assert.equal(unrecorded.length, 1)
  assert.equal(unrecorded[0].severity, 'required')
  assert.equal(unrecorded[0].check, 'cited-sources-recorded')
  assert.equal(unrecorded[0].path, REPORT)
  assert.match(unrecorded[0].message, /line \d+ links https:\/\/www\.nmpa\.gov\.cn\/.*A portal, home or search page is not a source/)
  assert.equal(declared.ok, false)
  // A contract whose manifest does not declare the check is graded as before.
  const undeclared = runGate({ contractKind: 'drug-evaluation-report', files, expectedOutputs: outputs })
  assert.equal(undeclared.issues.some((entry) => entry.check === 'cited-sources-recorded'), false)
})

test('what the run retrieved is recorded whatever the run wrote, in any spelling of its identifier', () => {
  const report = [
    'DAPA-CKD [1] https://doi.org/10.1056/NEJMoa2024816',
    'Baseline [2] https://pubmed.ncbi.nlm.nih.gov/32862232/',
    'Label [3] http://www.example.org/label/123/',
    'Unread [4] https://www.nmpa.gov.cn/',
  ].join('\n')
  const snapshot = JSON.stringify({ sources: [{ id: 'S01', title: 'typed by the run, no address' }] })
  const retrieved = [
    { sourceId: 'pmid:32970396', doi: '10.1056/nejmoa2024816', tool: 'literature_search' },
    { sourceId: '32862232', pmid: '32862232', tool: 'literature_search' },
    { sourceId: 'label:H20170119', url: 'https://example.org/label/123', tool: 'drug_label_search' },
  ]
  const audit = auditCitedSources({ reports: [{ path: 'r.md', text: report }], snapshotText: snapshot, retrieved })
  assert.deepEqual(audit.unrecorded, [{ path: 'r.md', line: 4, url: 'https://www.nmpa.gov.cn/' }])
  assert.deepEqual(audit.unretrieved, [])
})

test('submission writes the platform record into the snapshot and keeps what the run wrote', () => {
  const rows = [{ sourceId: 'pmid:1', pmid: '1', tool: 'literature_search', title: 'A', url: 'https://pubmed.ncbi.nlm.nih.gov/1/' }]
  const own = JSON.stringify({ scope: 'CKD', sources: [{ id: 'S01', observedFields: 'HR 0.61' }], [SNAPSHOT_RETRIEVED_KEY]: [{ sourceId: 'forged' }] })
  const written = withRetrievedSources(own, rows)
  const parsed = JSON.parse(written.text)
  assert.equal(written.written, true)
  assert.equal(parsed.scope, 'CKD')
  assert.deepEqual(parsed.sources, [{ id: 'S01', observedFields: 'HR 0.61' }])
  assert.deepEqual(parsed[SNAPSHOT_RETRIEVED_KEY], rows, 'the key is the platform\'s: what the run put there is replaced')
  // An array of records gains somewhere for the key to live; a file that does
  // not parse is left alone for the check to name; no file becomes one.
  assert.deepEqual(JSON.parse(withRetrievedSources('[{"id":"S01"}]', rows).text).sources, [{ id: 'S01' }])
  assert.deepEqual(withRetrievedSources('{ not json', rows), { text: '{ not json', changed: false, written: false })
  assert.deepEqual(JSON.parse(withRetrievedSources(null, rows).text), { [SNAPSHOT_RETRIEVED_KEY]: rows })
  // Unchanged bytes are not rewritten.
  assert.equal(withRetrievedSources(written.text, rows).changed, false)
})

test('a link a reader cannot follow is named in the run\'s own gate, where it used to reach only the delivered package', () => {
  const report = [
    '# 评价',
    '来源见内部记录 http://10.0.0.5:8080/record/1 与 https://reader:placeholder-token@example.org/x。',
    '公开记录 http://example.org/label 可以打开。',
  ].join('\n')
  const files = new Map([['r.md', report]])
  const declared = runGate({ contractKind: 'drug-evaluation-report', files, expectedOutputs: [{ path: 'r.md', required: true }], checks: ['citationsResolvable'] })
  const found = declared.issues.filter((entry) => entry.check === 'citations-resolvable').map((entry) => [entry.code, entry.severity, entry.line])
  assert.deepEqual(found, [
    ['specialist_citation_invalid', 'required', 2],
    ['specialist_citation_invalid', 'required', 2],
    ['citation_plain_http', 'advisory', 3],
  ])
  assert.equal(declared.ok, false)
  assert.equal(runGate({ contractKind: 'drug-evaluation-report', files, expectedOutputs: [{ path: 'r.md', required: true }] }).issues.some((entry) => entry.check === 'citations-resolvable'), false)
})

test('a snapshot that records nothing and a run that retrieved nothing is empty, not clean', () => {
  const audit = auditCitedSources({ reports: [{ path: 'r.md', text: 'x https://a.example/1' }], snapshotText: '{"sources":[]}' })
  assert.equal(audit.status, 'empty')
  assert.equal(auditCitedSources({ reports: [], snapshotText: '{ bad' }).status, 'invalid')
  assert.equal(auditCitedSources({ reports: [], snapshotText: '42' }).status, 'not-object')
})
