import assert from 'node:assert/strict'
import test from 'node:test'

import {
  REVIEW_ANSWER_REQUIRED_KINDS,
  REVIEW_DECIDABLE_KINDS,
  REVIEW_EDITOR_FINDINGS_LIMIT,
  REVIEW_EDITOR_OUTPUT_SCHEMA,
  REVIEW_FINDING_KINDS,
  REVIEW_FINDING_KIND_LABELS_ZH,
  REVIEW_JUDGMENT_KINDS,
  REVIEW_NO_FINDING,
  acceptEditorChecks,
  acceptEditorFindings,
  acceptReviewResponses,
  editorSaidNothing,
  reviewEditorSchema,
  reviewSeverity,
  unansweredFindings,
} from '../index.mjs'

const report = [
  '## 结论',
  '二甲双胍使 HbA1c 较安慰剂降低 1.5% [1]。<!-- claim:CLM-001 -->',
  '',
  '## 参考文献',
  '1. Smith J. Metformin versus placebo. doi:10.1000/abc',
].join('\n')
const source = 'Metformin lowered HbA1c by 0.9 percentage points compared with placebo (95% CI 0.7 to 1.1).'

test('every kind has a label, and the two families do not overlap', () => {
  for (const kind of REVIEW_FINDING_KINDS) assert.ok(REVIEW_FINDING_KIND_LABELS_ZH[kind], `${kind} has no label`)
  assert.equal(new Set(REVIEW_FINDING_KINDS).size, REVIEW_FINDING_KINDS.length)
  for (const kind of REVIEW_DECIDABLE_KINDS) assert.equal(REVIEW_JUDGMENT_KINDS.includes(/** @type {any} */ (kind)), false)
  // The model may only answer in its own kinds: the schema's enum is exactly them.
  assert.deepEqual(REVIEW_EDITOR_OUTPUT_SCHEMA.properties.findings.items.properties.kind.enum, [...REVIEW_JUDGMENT_KINDS])
})

test('a judgment is advice whatever it is called, and a decidable kind is required only once promoted', () => {
  for (const kind of REVIEW_JUDGMENT_KINDS) assert.equal(reviewSeverity(kind, [...REVIEW_FINDING_KINDS]), 'advisory', `${kind} must never be required`)
  assert.equal(reviewSeverity('reference_unresolvable'), 'advisory', 'nothing is promoted until the ledger says so')
  assert.equal(reviewSeverity('reference_unresolvable', ['reference_unresolvable']), 'required')
})

test('a finding whose evidence is not in the package or its sources is dropped, and one that is kept carries its words', () => {
  const raw = {
    findings: [
      // Copied from the source: kept.
      { location: 'CLM-001', kind: 'contradiction', evidence: 'lowered HbA1c by 0.9 percentage points', fix: '把 1.5% 改为 0.9 个百分点。' },
      // Copied from the report, spacing and case differing: kept.
      { location: 'CLM-001', kind: 'overclaim', evidence: '二甲双胍使 HbA1c 较安慰剂降低  1.5%', fix: '改用来源的数字。' },
      // The paraphrase the reviewer wrote with thinking off (probe 2026-09-23): dropped.
      { location: 'CLM-001', kind: 'contradiction', evidence: 'Source states 0.9 percentage points; claim states 1.5%.', fix: '改。' },
      // A kind outside its vocabulary: dropped.
      { location: 'CLM-001', kind: 'reference_unresolvable', evidence: 'lowered HbA1c', fix: '' },
      // The same finding twice: one kept.
      { location: 'CLM-001', kind: 'contradiction', evidence: 'lowered HbA1c by 0.9 percentage points', fix: '把 1.5% 改为 0.9 个百分点。' },
    ],
  }
  const { findings, dropped } = acceptEditorFindings(raw, { haystacks: [report, source] })
  assert.deepEqual(findings.map((finding) => [finding.id, finding.kind, finding.severity, finding.origin]), [
    ['F01', 'contradiction', 'advisory', 'editor'],
    ['F02', 'overclaim', 'advisory', 'editor'],
  ])
  assert.deepEqual(dropped.map((entry) => entry.reason), ['evidence', 'kind', 'duplicate'])
  assert.match(findings[0].message, /与来源矛盾（CLM-001）：「lowered HbA1c by 0\.9 percentage points」。建议：把 1\.5% 改为 0\.9 个百分点。/)
})

test('evidence set out as the report\'s words beside its source\'s is located piece by piece, and every piece must be', () => {
  const raw = {
    findings: [
      // The live sample of 2026-09-23: the report's sentence, then the source's, one per line, labelled.
      { location: 'CLM-001', kind: 'contradiction', evidence: '二甲双胍使 HbA1c 较安慰剂降低 1.5% [1]。\n来源摘录：Metformin lowered HbA1c by 0.9 percentage points compared with placebo', fix: '改为 0.9 个百分点。' },
      // One line verbatim, the other invented: the whole finding goes.
      { location: 'CLM-001', kind: 'overclaim', evidence: '二甲双胍使 HbA1c 较安慰剂降低 1.5%\n来源：metformin cured diabetes in every patient', fix: '改。' },
      // The other live shape: labelled, in quotation marks, joined by a semicolon.
      { location: 'CLM-001', kind: 'weak_support', evidence: '报告原文：「二甲双胍使 HbA1c 较安慰剂降低 1.5% [1]。」；来源摘录：「Metformin lowered HbA1c by 0.9 percentage points」', fix: '改。' },
      // Two excerpts run together with nothing between them are not two excerpts.
      { location: 'CLM-001', kind: 'wording', evidence: '二甲双胍使 HbA1c 较安慰剂降低 1.5% 来源摘录：Metformin lowered HbA1c', fix: '改。' },
      // A description of the report is not an excerpt of it.
      { location: '报告整体', kind: 'structure', evidence: '报告全文仅含「结论」与「参考文献」两个章节。', fix: '补方法。' },
    ],
  }
  const { findings, dropped } = acceptEditorFindings(raw, { haystacks: [report, source] })
  assert.deepEqual(findings.map((finding) => finding.kind), ['contradiction', 'weak_support'])
  assert.match(findings[0].evidence, /^二甲双胍使 HbA1c 较安慰剂降低 1\.5% \[1\]。 来源摘录：Metformin lowered/, 'kept as written, on one line')
  assert.deepEqual(dropped.map((entry) => entry.reason), ['evidence', 'evidence', 'evidence'])
})

test('a reviewer with more to say than the limit keeps the first findings and says how many it lost', () => {
  const raw = { findings: Array.from({ length: 5 }, (_, index) => ({ location: `CLM-00${index}`, kind: 'wording', evidence: 'lowered HbA1c', fix: `${index}` })) }
  const { findings, dropped } = acceptEditorFindings(raw, { haystacks: [source], max: 3 })
  assert.equal(findings.length, 3)
  assert.deepEqual(dropped.map((entry) => entry.reason), ['limit', 'limit'])
})

test('a checklist item said to be present must be located, or it is unlocated rather than present', () => {
  const { checklist, acceptance } = acceptEditorChecks({
    checklist: [
      { item: 'P5', status: 'present', evidence: 'lowered HbA1c' },
      { item: 'P6', status: 'present', evidence: '检索了 PubMed 与 Embase' },
      { item: 'P7', status: 'absent', evidence: '' },
      { item: 'P99', status: 'present', evidence: 'lowered HbA1c' },
    ],
    acceptance: [
      { item: 'A1', met: true, evidence: 'lowered HbA1c' },
      { item: 'A2', met: true, evidence: '不在任何文本里' },
      { item: 'A3', met: false, evidence: '' },
      { item: 'A9', met: true, evidence: 'lowered HbA1c' },
    ],
  }, { haystacks: [source], checklistItems: [{ id: 'P5' }, { id: 'P6' }, { id: 'P7' }], acceptanceItems: ['one', 'two', 'three'] })
  assert.deepEqual(checklist, [{ item: 'P5', status: 'present' }, { item: 'P6', status: 'unlocated' }, { item: 'P7', status: 'absent' }])
  assert.deepEqual(acceptance, [{ item: 'A1', met: true }, { item: 'A2', met: null }, { item: 'A3', met: false }])
})

test('a checklist answer that copies the whole label still names its item, never a longer id; what was answered at all is counted', () => {
  const { checklist, acceptance, returned } = acceptEditorChecks({
    checklist: [
      { item: 'E1（临床证据报告要素）写明研究问题', status: 'absent', evidence: '' },
      { item: 'E10（临床证据报告要素）', status: 'not_applicable', evidence: '' },
      { item: 'E1', status: 'present', evidence: 'lowered HbA1c' },
      { item: 'X9', status: 'absent', evidence: '' },
    ],
    acceptance: [{ item: 'A1 写明检索日期', met: false, evidence: '' }],
  }, { haystacks: [source], checklistItems: [{ id: 'E1' }, { id: 'E10' }], acceptanceItems: ['写明检索日期'] })
  assert.deepEqual(checklist, [{ item: 'E1', status: 'absent' }, { item: 'E10', status: 'not_applicable' }], 'the first answer for E1 stands; X9 was never asked')
  assert.deepEqual(acceptance, [{ item: 'A1', met: false }])
  assert.deepEqual(returned, { checklist: 4, acceptance: 1 })
})

test('an answer with no finding and no checklist or acceptance entry says nothing, where something was asked', () => {
  // The live answer of 2026-09-23, after 10,592 tokens of thinking over a 64 KB package.
  assert.equal(editorSaidNothing({ findings: [], checklist: [], acceptance: [] }, 21), true)
  assert.equal(editorSaidNothing(null, 21), true, 'no answer at all')
  // One absent item is an answer: the editor looked and found it missing.
  assert.equal(editorSaidNothing({ findings: [], checklist: [{ item: 'E2', status: 'absent', evidence: '' }], acceptance: [] }, 21), false)
  assert.equal(editorSaidNothing({ findings: [{ location: 'CLM-001' }], checklist: [], acceptance: [] }, 21), false)
  // Asked nothing, found nothing: a clean answer.
  assert.equal(editorSaidNothing({ findings: [], checklist: [], acceptance: [] }, 0), false)
})

test('the schema one package is reviewed under asks exactly its items by id, and one finding entry at least', () => {
  const schema = /** @type {any} */ (reviewEditorSchema({ checklistIds: ['E1', 'E2', 'E1'], acceptanceCount: 2 }))
  assert.deepEqual([schema.properties.checklist.minItems, schema.properties.checklist.maxItems], [2, 2])
  assert.deepEqual(schema.properties.checklist.items.properties.item.enum, ['E1', 'E2'])
  assert.deepEqual(schema.properties.acceptance.items.properties.item.enum, ['A1', 'A2'])
  assert.deepEqual([schema.properties.findings.minItems, schema.properties.findings.maxItems], [1, REVIEW_EDITOR_FINDINGS_LIMIT])
  assert.deepEqual(schema.properties.findings.items.properties.kind.enum, [...REVIEW_JUDGMENT_KINDS, REVIEW_NO_FINDING])
  assert.deepEqual(schema.required, ['findings', 'checklist', 'acceptance'])
  // Nothing asked: the list must stay empty rather than be invented.
  const bare = /** @type {any} */ (reviewEditorSchema({ checklistIds: [], acceptanceCount: 0 }))
  assert.equal(bare.properties.acceptance.maxItems, 0)
  assert.equal(bare.properties.checklist.maxItems, 0)
  // The shared schema is untouched.
  assert.equal(/** @type {any} */ (REVIEW_EDITOR_OUTPUT_SCHEMA).properties.findings.minItems, undefined)
})

test('the entry an editor with nothing to report writes is neither a finding nor a dropped one', () => {
  const { findings, dropped } = acceptEditorFindings({ findings: [{ location: '', kind: REVIEW_NO_FINDING, evidence: '', fix: '' }] }, { haystacks: [source] })
  assert.deepEqual([findings.length, dropped.length], [0, 0])
})

test('a writer answers a finding by id: fixed, or declined with a reason; anything else is refused and still owed', () => {
  const findings = [
    { id: 'F01', kind: /** @type {const} */ ('contradiction') },
    { id: 'F02', kind: /** @type {const} */ ('wording') },
    { id: 'F03', kind: /** @type {const} */ ('overclaim') },
    { id: 'F04', kind: /** @type {const} */ ('safety') },
  ]
  const { answers, refused } = acceptReviewResponses([
    { id: 'F01', response: 'fixed', reason: '' },
    { id: 'F03', response: 'declined', reason: '' },
    { id: 'F04', response: 'ignored', reason: 'x' },
    { id: 'F09', response: 'fixed' },
    { id: 'F01', response: 'declined', reason: '重复回答' },
  ], findings)
  assert.deepEqual(answers, [{ id: 'F01', response: 'fixed', reason: '' }])
  assert.deepEqual(refused.map((entry) => [entry.id, entry.reason]), [['F03', 'reason'], ['F04', 'response'], ['F09', 'unknown'], ['F01', 'unknown']])
  const owed = unansweredFindings(/** @type {any} */ (findings), answers)
  assert.deepEqual(owed.map((finding) => finding.id), ['F03', 'F04'], 'wording may be left in silence; overclaim and safety may not')
  assert.ok(REVIEW_ANSWER_REQUIRED_KINDS.includes('contradiction'))
})
