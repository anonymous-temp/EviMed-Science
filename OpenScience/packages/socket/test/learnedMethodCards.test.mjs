import assert from 'node:assert/strict'
import test from 'node:test'

import { buildDelegation, buildInlineMethod } from '../src/runPolicy.mjs'
import { isLearnedMethod, learnedMethodCardLines, splitMountedMethods } from '../src/learnedMethods.mjs'

// Incident 2026-09-28 (evals/method-quality/incidents/2026-09-28-learned-method-invoked-zero.json):
// learned methods were inlined whole under 「用户自己的方法（优先于平台默认流程）」,
// the model followed them without ever opening their files, and `invoked`
// stayed 0 on every run. A learned method now travels as a card naming the
// file to read; what the researcher wrote or enabled still travels whole.

const LEARNED_DIR = `_lm${'a'.repeat(32)}`
const learned = {
  name: 'pre-submission-freeze-check',
  description: 'Runs the last guards on a finished deliverable before its bytes are frozen.',
  whenToUse: 'When a finished deliverable is one step away from submission.',
  body: '---\nname: pre-submission-freeze-check\n---\n\n## Workflow\n\nTREAT-EVERY-NOTICE-AS-A-DEFECT\n',
  directory: LEARNED_DIR,
  path: `/runtime/capsule-methods/${LEARNED_DIR}/SKILL.md`,
  digest: 'sha256:x',
}
const ownEntry = {
  name: 'quote-first',
  body: '# Quote first\n\nQUOTE-THE-SOURCE-BEFORE-SUMMARISING\n',
  directory: 'quote-first',
  path: '/runtime/capsule-methods/quote-first/SKILL.md',
}

const manifest = {
  id: 'clinical-evidence-synthesis',
  persona: '你是临床证据分析师。',
  produces: [{ contractKind: 'clinical-evidence-report', outputs: [{ path: 'clinical-evidence-report.md', required: true }] }],
}
const item = { id: 'd1', title: '证据综述', contractKind: 'clinical-evidence-report' }

test('a learned method is recognised by its mounted directory, and nothing else is', () => {
  assert.equal(isLearnedMethod(learned), true)
  assert.equal(isLearnedMethod(ownEntry), false)
  assert.equal(isLearnedMethod({ directory: '_lmnothex' }), false)
  assert.equal(isLearnedMethod(null), false)
})

test('a learned method with no known file travels whole rather than as a card nobody can open', () => {
  const split = splitMountedMethods([{ ...learned, path: '' }, ownEntry])
  assert.deepEqual(split.cards, [])
  assert.deepEqual(split.inline.map((method) => method.name), ['pre-submission-freeze-check', 'quote-first'])
})

test('a card says when the method applies, where its text is, and that it is an inference that yields to the capability', () => {
  const text = learnedMethodCardLines([learned]).join('\n')
  assert.match(text, /EviMed 从这位用户以往的研究里推断出的做法，不是用户写下的规则/)
  assert.match(text, /先用 `read` 读它的全文再照做；不适用就不读、不用/)
  assert.match(text, /与上面的方法冲突时以上面的方法为准/)
  assert.match(text, /- pre-submission-freeze-check：When a finished deliverable is one step away from submission\./)
  assert.match(text, new RegExp(`全文：/runtime/capsule-methods/${LEARNED_DIR}/SKILL\\.md`))
  assert.doesNotMatch(text, /TREAT-EVERY-NOTICE-AS-A-DEFECT/, 'the body stays in its file')
  assert.deepEqual(learnedMethodCardLines([]), [], 'no learned method, no block')
})

test('a card falls back to the description, shortened, when the method names no whenToUse', () => {
  const text = learnedMethodCardLines([{ ...learned, whenToUse: '', description: 'd'.repeat(900) }]).join('\n')
  const line = text.split('\n').find((entry) => entry.startsWith('- pre-submission-freeze-check'))
  assert.ok(line && line.length < 340, `${line?.length} characters`)
  assert.match(line ?? '', /…$/)
})

test('a delegated child reads the capsule entry whole and the learned method as a card', () => {
  const request = buildDelegation({
    manifest,
    item,
    briefExcerpt: '题面摘录',
    skillBodies: [{ name: 'clinical-evidence-synthesis', body: '## 步骤\n1. 检索' }],
    capsuleMethods: [ownEntry, learned],
    inputs: {},
    toolFilter: ['read', 'write'],
  })
  assert.match(request.prompt, /## 用户自己的方法（优先于平台默认流程，但不能突破契约）\n\n### quote-first\n\n# Quote first/)
  assert.match(request.prompt, /QUOTE-THE-SOURCE-BEFORE-SUMMARISING/)
  assert.doesNotMatch(request.prompt, /TREAT-EVERY-NOTICE-AS-A-DEFECT/, 'the learned body is read on demand, so opening it is the trace of its use')
  assert.doesNotMatch(request.prompt, /### pre-submission-freeze-check/, 'a learned method is never presented as the user\'s own rule')
  assert.match(request.prompt, /## EviMed 学到的做法（适用时再读）/)
  assert.match(request.prompt, new RegExp(`全文：/runtime/capsule-methods/${LEARNED_DIR}/SKILL\\.md`))
})

test('the root doing the work itself gets the same split as a delegated child', () => {
  const text = buildInlineMethod({
    manifest,
    item,
    skillBodies: [{ name: 'clinical-evidence-synthesis', body: '## 步骤\n1. 检索' }],
    capsuleMethods: [learned],
  })
  assert.doesNotMatch(text, /用户自己的方法/, 'no capsule entry, no heading claiming one')
  assert.doesNotMatch(text, /TREAT-EVERY-NOTICE-AS-A-DEFECT/)
  assert.match(text, /## EviMed 学到的做法（适用时再读）/)
  // The capability's method comes first; the card says it yields to it.
  assert.ok(text.indexOf('## 步骤') < text.indexOf('## EviMed 学到的做法'))
})

test('a card block is a small fraction of the bodies it replaces', () => {
  const heavy = { ...learned, body: 'x'.repeat(10_000) }
  const request = buildDelegation({ manifest, item, briefExcerpt: '', skillBodies: [], capsuleMethods: [heavy], inputs: {}, toolFilter: [] })
  const inlined = buildDelegation({ manifest, item, briefExcerpt: '', skillBodies: [], capsuleMethods: [{ ...heavy, path: '' }], inputs: {}, toolFilter: [] })
  assert.ok(request.prompt.length + 9_000 < inlined.prompt.length, `${request.prompt.length} vs ${inlined.prompt.length}`)
})
