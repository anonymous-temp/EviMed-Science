// `distillationCompleteness` was written, given thresholds, and then had no
// caller anywhere in apps/ or packages/ — a measurement nobody took. These
// cases pin what it computes and, more importantly, that it is reached from
// production code and that reaching it did not turn it into a gate.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { distillationCompleteness } from '../src/analysis.mjs'
import { normalizeSourceText, projectSourceUnderstandingOutput, sourceUnderstandingAuditSample, sourceUnderstandingOmissionNotice,
  sourceUnderstandingSchema, validateSourceUnderstanding } from '../src/sourceUnderstanding.mjs'

test('the omission rate is the miss fraction, rounded once, against a depth target', () => {
  assert.deepEqual(distillationCompleteness([{ unitId: 'u1', answered: true }, { unitId: 'u2', answered: false }], 'deep'),
    { omissionRate: 0.5, target: 0.05, withinTarget: false, audited: 2 })
  assert.deepEqual(distillationCompleteness([{ unitId: 'u1', answered: true }], 'structured'),
    { omissionRate: 0, target: 0.15, withinTarget: true, audited: 1 })
  // Deep is stricter than structured, and an unknown depth cannot be over target.
  assert.equal(distillationCompleteness([], 'deep').target, 0.05)
  assert.equal(distillationCompleteness([], 'structured').target, 0.15)
  assert.equal(distillationCompleteness([{ unitId: 'u1', answered: false }], 'index_only').target, 1)
  assert.equal(distillationCompleteness([{ unitId: 'u1', answered: false }], 'index_only').withinTarget, true)
  // Four decimal places, so the contract's equality check is on a stable number.
  assert.equal(distillationCompleteness(Array.from({ length: 3 }, (_, index) => ({ unitId: `u${index}`, answered: index > 0 })), 'deep').omissionRate, 0.3333)
  // Nothing measured is not the same as nothing missing; the caller keeps them
  // apart by reporting `not_run` with a null rate rather than an audited zero.
  assert.deepEqual(distillationCompleteness([], 'deep'), { omissionRate: 0, target: 0.05, withinTarget: true, audited: 0 })
})

/** The source-understanding fixture the contract-side reachability cases use. */
function auditedFixture() {
  const text = Array.from({ length: 10 }, (_, index) => `unit${index + 1} body `.padEnd(8000, '.')).join('')
  const input = normalizeSourceText({ sourceId: 'src_reach', generation: 1, docType: 'note-memo', depth: 'deep', text })
  const plan = sourceUnderstandingAuditSample(input)
  assert.equal(plan.length, 2, 'the fixture must produce a two-unit plan or these cases prove nothing')
  const anchorFor = (/** @type {string} */ unitId) => {
    const index = input.units.findIndex(unit => unit.id === unitId)
    const unit = input.units[index]
    const quote = `unit${index + 1} body`
    return { sourceId: input.sourceId, generation: input.generation, unitId, start: unit.start, end: unit.start + quote.length, quote }
  }
  const output = {
    schemaVersion: 1, sourceId: input.sourceId, generation: input.generation, docType: input.docType, depth: input.depth,
    summary: 'A fixture source.',
    slots: Object.fromEntries(sourceUnderstandingSchema(input.docType).slots.map(key => [key, { state: 'unknown', reason: 'Not stated in the source.' }])),
    claims: [{ id: 'c1', statement: `Anchored in ${plan[0]}.`, evidence: [anchorFor(plan[0])] }],
    methods: [],
    omissionAudit: {
      status: 'audited', reason: 'Sampled units checked against carried anchors.', omissionRate: 0.5,
      samples: [{ unitId: plan[0], represented: true }, { unitId: plan[1], represented: false }],
    },
  }
  return { input, output, plan }
}

test('the source-understanding projection actually routes through distillationCompleteness', async () => {
  const { input, output } = auditedFixture()
  // Runtime proof, not a grep: the rate this function returns for one hit and
  // one miss is the rate the projection stores, whatever the run reported. So
  // unwiring it changes the stored record.
  const expected = distillationCompleteness([{ unitId: 'a', answered: true }, { unitId: 'b', answered: false }], 'deep')
  output.omissionAudit.omissionRate = 0.25
  const projected = /** @type {any} */ (projectSourceUnderstandingOutput(output, input))
  assert.equal(projected.omissionAudit.omissionRate, expected.omissionRate)
  assert.notEqual(projected.omissionAudit.omissionRate, output.omissionAudit.omissionRate)
  assert.equal(sourceUnderstandingOmissionNotice(output, input).omissionRate, expected.omissionRate)
  assert.equal(sourceUnderstandingOmissionNotice(output, input).target, expected.target)

  // A second, independent proof that survives a refactor of the arithmetic: the
  // module imports it by name. The read is asserted non-empty so a moved file
  // cannot report a clean result forever.
  const source = await readFile(fileURLToPath(new URL('../src/sourceUnderstanding.mjs', import.meta.url)), 'utf8')
  assert.ok(source.length > 1000, 'the contract module was not read; this case proves nothing')
  assert.match(source, /import \{ distillationCompleteness \} from '\.\/analysis\.mjs'/)
})

test('an over-target distillation verdict is a notice: it never appears as a delivery issue', () => {
  const { input, output } = auditedFixture()
  const notice = sourceUnderstandingOmissionNotice(output, input)
  assert.equal(notice.withinTarget, false, 'the fixture must be over target or this case proves nothing')
  assert.equal(notice.omissionRate, 0.5)
  assert.equal(notice.target, 0.05)
  assert.equal(notice.blocking, false)
  // The delivery verdict is empty all the same. Half of the audited units are
  // unrepresented at deep depth, ten times the target, and the package still
  // delivers with the shortfall recorded against it.
  assert.deepEqual(validateSourceUnderstanding(output, input), [])
  // And so does an audit whose own numbers are wrong: the disagreement is
  // recorded, not charged to the delivery.
  output.omissionAudit.omissionRate = 0
  assert.deepEqual(validateSourceUnderstanding(output, input), [])
  assert.equal(sourceUnderstandingOmissionNotice(output, input).disagreements.length, 1)
})
