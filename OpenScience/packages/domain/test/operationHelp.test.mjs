// Help for an operation is written by a function from the operation's own schema: it cannot say a limit the schema
// does not state, it is bounded, and it degrades in a fixed order instead of running long.
import assert from 'node:assert/strict'
import test from 'node:test'

import * as domain from '../index.mjs'

const { describeOperationParam, normalizeSkillOperation, operationExample, renderOperationHelp, renderOperationSummary, renderPackageHelp, OPERATION_HELP_BUDGET } = domain
const operation = /** @type {(value: any) => any} */ (normalizeSkillOperation)

const docRead = operation({
  name: 'doc_read', kind: 'tool', summary: 'Inspect a permitted document resource.', summaryZh: '查看一个已授权的文档资源。',
  accepts: ['xlsx', 'ipynb', 'docx', 'pdf'], produces: ['bounded text window'], limits: ['不执行代码', '每次最多 5 页'],
  params: [
    { name: 'resourceId', type: 'string', required: true, description: '资源编号' },
    { name: 'options.pages', type: 'integer', min: 1, max: 5, default: 1, unit: '页' },
    { name: 'options.rows', type: 'integer', min: 1, max: 100 },
    { name: 'format', type: 'string', values: ['xlsx', 'ipynb'], required: true },
  ],
})

test('the help states each parameter\'s type, whether it is required, its default, closed values and range from the schema', () => {
  const help = renderOperationHelp(docRead, { maxChars: 2000 })
  assert.match(help, /^doc_read：查看一个已授权的文档资源。/)
  assert.match(help, /resourceId（文本，必填；资源编号）/)
  assert.match(help, /options\.pages（整数，可选，默认 1，范围 1–5 页）/)
  assert.match(help, /options\.rows（整数，可选，范围 1–100）/)
  assert.match(help, /format（文本，必填，取值 xlsx \/ ipynb）/)
  assert.match(help, /接受：xlsx、ipynb、docx、pdf/)
  assert.match(help, /限制：不执行代码；每次最多 5 页/)
  const english = renderOperationHelp(docRead, { locale: 'en', maxChars: 2000 })
  assert.match(english, /^doc_read: Inspect a permitted document resource\./)
  assert.match(english, /options\.pages \(integer, optional, default 1, range 1–5 页\)/)
})

test('a limit the schema does not state does not appear: changing the schema changes the help, nothing else does', () => {
  const widened = operation({ ...docRead, params: docRead.params.map((/** @type {any} */ param) => (param.name === 'options.pages' ? { ...param, max: 9 } : param)) })
  const before = renderOperationHelp(docRead, { maxChars: 2000 })
  const after = renderOperationHelp(widened, { maxChars: 2000 })
  assert.ok(after.includes('范围 1–9 页') && !after.includes('范围 1–5 页'))
  assert.equal(after.replace('1–9', '1–5'), before)
  assert.equal(renderOperationHelp(docRead, { maxChars: 2000 }), before, 'deterministic')
})

test('the example is a call the schema accepts: required parameters only, defaults and closed values first, nested names nested', () => {
  assert.deepEqual(operationExample(docRead), { resourceId: '<resourceId>', format: 'xlsx' })
  const nested = operation({ name: 'x', kind: 'tool', params: [
    { name: 'options.pages', type: 'integer', required: true, min: 2, max: 5 }, { name: 'flag', type: 'boolean', required: true }, { name: 'rows', type: 'array', required: true },
  ] })
  assert.deepEqual(operationExample(nested), { options: { pages: 2 }, flag: true, rows: [] })
})

test('help is bounded: it drops the example, then parameter detail, then the tail, and says how much it left out', () => {
  const wide = operation({ name: 'wide', kind: 'tool', summary: 'A wide one.', params: Array.from({ length: 24 }, (_, index) => ({ name: `parameter${index}`, type: 'string', required: index < 3, description: 'x'.repeat(60) })) })
  const full = renderOperationHelp(wide, { locale: 'en', maxChars: 100_000 })
  assert.match(full, /Example:/)
  const budget = 700
  const short = renderOperationHelp(wide, { locale: 'en', maxChars: budget })
  assert.ok([...short].length <= budget, `${[...short].length} characters`)
  assert.ok(!/Example:/.test(short))
  const tiny = renderOperationHelp(wide, { locale: 'en', maxChars: 120 })
  assert.ok([...tiny].length <= 120)
  assert.match(tiny, /and \d+ more/)
  assert.ok(tiny.startsWith('wide: A wide one.'))
  assert.ok([...renderOperationHelp(wide, { maxChars: 5 })].length <= 5)
  assert.equal(OPERATION_HELP_BUDGET, 700)
})

test('a package\'s help is within its budget and counts the operations it did not describe', () => {
  const many = Array.from({ length: 12 }, (_, index) => operation({ name: `op${index}`, kind: 'script', summary: 'Does a thing.', params: [{ name: 'input', type: 'path', required: true }] }))
  const help = renderPackageHelp(many, { locale: 'en', maxChars: 1800, maxOperations: 8 })
  assert.ok([...help].length <= 1800 + 40)
  assert.match(help, /and 4 more/)
  assert.ok(help.includes('op0') && help.includes('op7') && !help.includes('op8'))
  assert.equal(renderPackageHelp([], { locale: 'en' }), '')
})

test('a parameter that applies only under a condition says so and is placed in the example only when the condition holds', () => {
  const write = operation({ name: 'doc_write', kind: 'tool', params: [
    { name: 'format', type: 'string', required: true, values: ['xlsx', 'ipynb'] },
    { name: 'spec.sheets', type: 'array', required: true, when: { param: 'format', equals: 'xlsx' } },
    { name: 'spec.cells', type: 'array', required: true, when: { param: 'format', equals: 'ipynb' } },
  ] })
  assert.equal(describeOperationParam(write.params[1]), '列表，format=xlsx 时必填')
  assert.equal(describeOperationParam(write.params[1], 'en'), 'array, required when format=xlsx')
  assert.deepEqual(operationExample(write), { format: 'xlsx', spec: { sheets: [] } })
})

test('the summary is the operation without its parameters, bounded the same way', () => {
  const text = renderOperationSummary(docRead, { maxChars: 2000 })
  assert.match(text, /^查看一个已授权的文档资源。\n接受：xlsx、ipynb、docx、pdf\n产出：一个有大小上限的文本窗口|^查看一个已授权的文档资源。\n接受：xlsx、ipynb、docx、pdf\n产出：bounded text window/)
  assert.ok(!text.includes('options.pages'))
  assert.ok([...renderOperationSummary(docRead, { maxChars: 20 })].length <= 20)
  assert.equal(renderOperationSummary(docRead, { maxChars: 20 }).split('\n').length, 1)
})
