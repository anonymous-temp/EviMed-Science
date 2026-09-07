import test from 'node:test'
import assert from 'node:assert/strict'
import { SOURCE_UNDERSTANDING_AUDIT_MAX_SAMPLES, SOURCE_UNDERSTANDING_AUDIT_NOTE_MAX_CHARS, SOURCE_UNDERSTANDING_AUDIT_SAMPLE_FRACTION,
  normalizeSourceText, projectSourceUnderstandingOutput,
  sourceUnderstandingAuditSample, sourceUnderstandingOmissionNotice, sourceUnderstandingSchema, validateSourceUnderstanding } from '../src/sourceUnderstanding.mjs'
import { distillationCompleteness } from '../src/analysis.mjs'

test('normalized complete text has contiguous exact UTF-16 units including content beyond snippets', () => {
  const text = '\uFEFFfirst\r\n' + 'long text '.repeat(1300) + '\rfinal 😀'
  const input = normalizeSourceText({ sourceId: 's', generation: 2, docType: 'note-memo', depth: 'structured', text })
  assert.equal(input.units.map(unit => unit.text).join(''), input.text)
  assert.ok(input.text.endsWith('final 😀'))
  assert.equal(input.units.at(-1)?.end, input.text.length)
  assert.ok(input.units.every(unit => input.text.slice(unit.start, unit.end) === unit.text))
})

test('chunk boundaries preserve whole supplementary characters while offsets remain UTF-16', () => {
  for (const supplementary of ['😀', '𠀀']) {
    const text = 'a'.repeat(7999) + supplementary + 'b'
    const input = normalizeSourceText({ sourceId: 's', generation: 1, docType: 'note-memo', depth: 'structured', text })
    assert.equal(input.units[0].end, 7999)
    assert.equal(input.units[1].start, 7999)
    assert.equal(input.units[1].text, supplementary + 'b')
    assert.ok(input.units.every(unit => new TextDecoder().decode(new TextEncoder().encode(unit.text)) === unit.text))
    assert.equal(input.units.map(unit => unit.text).join(''), text)
  }
})

test('typed schemas share one validator; known slots need exact source evidence and unknown slots need reasons', () => {
  for (const docType of ['research-protocol', 'published-paper', 'note-memo']) {
    const input = normalizeSourceText({ sourceId: 's', generation: 2, docType, depth: 'structured', text: 'An anchored statement.' })
    /** @type {Record<string, any>} */
    const slots = Object.fromEntries(sourceUnderstandingSchema(docType).slots.map(key => [key, { state: 'unknown', reason: 'Not stated in the source.' }]))
    const output = { schemaVersion: 1, sourceId: 's', generation: 2, docType, depth: 'structured', summary: 'Source summary', slots, claims: [], methods: [], omissionAudit: { status: 'not_run', reason: 'Question audit has not run.', omissionRate: null } }
    assert.deepEqual(validateSourceUnderstanding(output, input), [])
    const key = sourceUnderstandingSchema(docType).slots[0]
    slots[key] = { state: 'known', value: 'Statement', evidence: [{ sourceId: 's', generation: 2, unitId: input.units[0].id, start: 0, end: 2, quote: 'An' }] }
    assert.deepEqual(validateSourceUnderstanding(output, input), [])
    slots[key].evidence[0].quote = 'No'
    assert.ok(validateSourceUnderstanding(output, input).some(issue => issue.includes('exact quote')))
    slots[key] = { state: 'unknown', reason: '' }
    assert.ok(validateSourceUnderstanding(output, input).some(issue => issue.includes('reason')))
  }
})

test('depth and source generation cannot be fabricated and absent audit never means zero omissions', () => {
  const input = normalizeSourceText({ sourceId: 's', generation: 2, docType: 'note-memo', depth: 'structured', text: 'A note.' })
  const output = { schemaVersion: 1, sourceId: 's', generation: 3, docType: 'note-memo', depth: 'deep', summary: 'Note', slots: {}, claims: [], methods: [], omissionAudit: { status: 'not_run', omissionRate: 0 } }
  const issues = validateSourceUnderstanding(output, input)
  assert.ok(issues.some(issue => issue.includes('generation')))
  assert.ok(issues.some(issue => issue.includes('depth')))
  assert.ok(issues.some(issue => issue.includes('omission')))
})

test('Chinese output is bounded by UTF-8 bytes before canonical persistence', () => {
  const input = normalizeSourceText({ sourceId: 's', generation: 2, docType: 'note-memo', depth: 'structured', text: '原文' })
  const evidence = [{ sourceId: 's', generation: 2, unitId: input.units[0].id, start: 0, end: 2, quote: '原文' }]
  const output = { schemaVersion: 1, sourceId: 's', generation: 2, docType: 'note-memo', depth: 'structured', summary: '中'.repeat(8000),
    slots: Object.fromEntries(sourceUnderstandingSchema(input.docType).slots.map(key => [key, { state: 'unknown', reason: '中'.repeat(2000) }])),
    claims: Array.from({ length: 18 }, (_, i) => ({ id: `c${i}`, statement: '中'.repeat(4000), evidence })), methods: [],
    omissionAudit: { status: 'not_run', reason: 'Not audited.', omissionRate: null } }
  assert.ok(JSON.stringify(output).length < 100000)
  assert.ok(new TextEncoder().encode(JSON.stringify(output)).byteLength > 262144)
  assert.ok(validateSourceUnderstanding(output, input).some(issue => issue.includes('UTF-8')))
})

// --- the omission audit ------------------------------------------------------
//
// The audit answers the one question a coverage percentage cannot: coverage
// says which units were parsed, not whether anything in them went
// unrepresented. The contract used to forbid it from ever carrying an answer.
// It may now carry one — but carrying one is a self-report, not a claim the
// contract adjudicates: `source_understanding_invalid` is terminal on the
// ingestion path, so every issue the contract could add here is a finished
// package destroyed with no repair loop. These cases pin the shape a stored
// record is unusable without, that the control plane derives the numbers
// itself, and — most of all — that neither the audit's verdict nor a run's
// disagreement with it can refuse a delivery.

/** Ten 8,000-character units whose first words are quotable. */
function auditFixture(sourceId = 'src_fix', generation = 4, depth = 'structured') {
  const text = Array.from({ length: 10 }, (_, index) => `unit${index + 1} body `.padEnd(8000, '.')).join('')
  return normalizeSourceText({ sourceId, generation, docType: 'note-memo', depth, text })
}

/** @param {any} input */
function anchorFactory(input) {
  return (/** @type {string} */ unitId) => {
    const index = input.units.findIndex((/** @type {any} */ candidate) => candidate.id === unitId)
    const unit = input.units[index]
    const label = `unit${index + 1} body`
    return { sourceId: input.sourceId, generation: input.generation, unitId, start: unit.start, end: unit.start + label.length, quote: label }
  }
}

/** @param {any} input @param {string[]} anchoredUnitIds */
function auditedOutput(input, anchoredUnitIds) {
  const anchorFor = anchorFactory(input)
  const plan = sourceUnderstandingAuditSample(input)
  const anchored = new Set(anchoredUnitIds)
  return {
    schemaVersion: 1, sourceId: input.sourceId, generation: input.generation, docType: input.docType, depth: input.depth,
    summary: 'A fixture source.',
    slots: Object.fromEntries(sourceUnderstandingSchema(input.docType).slots.map(key => [key, { state: 'unknown', reason: 'Not stated in the source.' }])),
    claims: anchoredUnitIds.map((unitId, index) => ({ id: `c${index}`, statement: `Anchored in ${unitId}.`, evidence: [anchorFor(unitId)] })),
    methods: [],
    /** @type {any} */
    omissionAudit: {
      status: 'audited',
      reason: 'Sampled units were checked against the anchors this output carries.',
      omissionRate: Number((plan.filter(unitId => !anchored.has(unitId)).length / plan.length).toFixed(4)),
      samples: plan.map(unitId => (anchored.has(unitId)
        ? { unitId, represented: true }
        : { unitId, represented: false, note: 'No claim or slot reaches this unit.' })),
    },
  }
}

test('the sampler is a pure function of the source identity, not of the run', () => {
  const input = auditFixture()
  // Pinned, not recomputed: a silent change to the fraction, the hash or the
  // seed would make a rerun audit different units and go unnoticed.
  assert.deepEqual(sourceUnderstandingAuditSample(input), ['src_fix:g4:u8', 'src_fix:g4:u9'])
  assert.deepEqual(sourceUnderstandingAuditSample(input), sourceUnderstandingAuditSample(input))
  assert.deepEqual(sourceUnderstandingAuditSample({ ...input, units: [...input.units].reverse() }), ['src_fix:g4:u8', 'src_fix:g4:u9'])
  assert.notDeepEqual(sourceUnderstandingAuditSample({ ...input, generation: 5 }), ['src_fix:g4:u8', 'src_fix:g4:u9'])
  assert.notDeepEqual(sourceUnderstandingAuditSample({ ...input, sourceId: 'src_other' }), ['src_fix:g4:u8', 'src_fix:g4:u9'])
  assert.equal(sourceUnderstandingAuditSample(auditFixture('src_fix', 4, 'deep')).length, 2)
  // One unit is enough to be auditable; an empty source has nothing to audit.
  assert.equal(sourceUnderstandingAuditSample(normalizeSourceText({ sourceId: 's', generation: 1, docType: 'note-memo', depth: 'deep', text: 'short' })).length, 1)
  assert.deepEqual(sourceUnderstandingAuditSample(normalizeSourceText({ sourceId: 's', generation: 1, docType: 'note-memo', depth: 'deep', text: '' })), [])
})

test('the sample cap binds on a long source, so an audit cannot grow without limit', () => {
  /** @param {number} count */
  const units = count => Array.from({ length: count }, (_, index) => ({ id: `u${index + 1}`, start: index * 10, end: index * 10 + 10 }))
  /** @param {number} count */
  const plan = count => sourceUnderstandingAuditSample({ sourceId: 'src_cap', generation: 1, units: units(count) })
  // Below the cap the fraction decides: one unit in five, rounded up.
  assert.equal(plan(10).length, 2)
  assert.equal(plan(55).length, 11)
  // At 61 units the fraction asks for 13 and the cap allows 12. This is the
  // assertion that fails the moment SOURCE_UNDERSTANDING_AUDIT_MAX_SAMPLES moves.
  assert.equal(SOURCE_UNDERSTANDING_AUDIT_MAX_SAMPLES, 12)
  assert.equal(Math.ceil(61 * SOURCE_UNDERSTANDING_AUDIT_SAMPLE_FRACTION), 13)
  assert.equal(plan(61).length, 12)
  // And it stays 12 however long the source gets, which is what keeps an
  // audited record inside the output's byte budget.
  assert.equal(plan(500).length, 12)
  assert.equal(new Set(plan(500)).size, 12)
})

test('two units with the same rank are ordered by id, not by the order they arrived in', () => {
  // `u570759` and `u2168404` collide under FNV-1a with this seed (found by
  // search, pinned here). One unit in five of two units is one, so the tie
  // decides which unit is audited; without the id tie-breaker a stable sort
  // would let the input array's order decide, and the same source would audit
  // different units depending on how its capture was assembled.
  const pair = [{ id: 'u570759', start: 0, end: 10 }, { id: 'u2168404', start: 10, end: 20 }]
  const sample = (/** @type {any[]} */ units) => sourceUnderstandingAuditSample({ sourceId: 'src_tie', generation: 1, units })
  assert.deepEqual(sample(pair), ['u2168404'])
  assert.deepEqual(sample([...pair].reverse()), ['u2168404'])
})

test('the omission audit is not a blocking point: an audit its own output contradicts still delivers', () => {
  const input = auditFixture()
  /** @param {(audit:any)=>void} mutate */
  const issuesAfter = mutate => { const output = auditedOutput(input, ['src_fix:g4:u8']); mutate(output.omissionAudit); return validateSourceUnderstanding(output, input) }
  // Every one of these was a hard refusal before, and every refusal on this
  // path is terminal — the ingestion is lost, with no repair loop and no retry.
  // They are all measurements the control plane makes for itself, so none of
  // them may cost a finished package.
  assert.deepEqual(issuesAfter(audit => { audit.omissionRate = 0 }), [], 'a wrong rate must not refuse a delivery')
  assert.deepEqual(issuesAfter(audit => { audit.omissionRate = 0.1666 }), [], 'a rounding disagreement must not refuse a delivery')
  assert.deepEqual(issuesAfter(audit => { audit.omissionRate = null }), [], 'an audit that reports no rate must not refuse a delivery')
  assert.deepEqual(issuesAfter(audit => { audit.samples[1].represented = true }), [], 'a wrong representation flag must not refuse a delivery')
  assert.deepEqual(issuesAfter(audit => { audit.samples[1].unitId = 'src_fix:g4:u1' }), [], 'auditing the wrong unit must not refuse a delivery')
  assert.deepEqual(issuesAfter(audit => { audit.samples.pop() }), [], 'a short sample list must not refuse a delivery')
  assert.deepEqual(issuesAfter(audit => { audit.samples.push({ unitId: 'src_fix:g4:u1', represented: true }) }), [], 'an extra sample must not refuse a delivery')
  assert.deepEqual(issuesAfter(audit => { delete audit.samples }), [], 'a missing sample list must not refuse a delivery')
  assert.deepEqual(issuesAfter(audit => { audit.samples = 'all of them' }), [], 'an unreadable sample list must not refuse a delivery')
  assert.deepEqual(issuesAfter(audit => { audit.samples[0].anchor = { unitId: 'nonsense' } }), [], 'a stray anchor on a sample must not refuse a delivery')
  assert.deepEqual(issuesAfter(audit => { audit.samples[1].note = '' }), [], 'an unusable note must not refuse a delivery')
  assert.deepEqual(issuesAfter(audit => { audit.samples[1].note = 'x'.repeat(5000) }), [], 'an over-long note must not refuse a delivery')
})

test('the contract keeps only the shape a stored record is unusable without', () => {
  const input = auditFixture()
  /** @param {any} audit */
  const issuesFor = audit => { const output = auditedOutput(input, ['src_fix:g4:u8']); output.omissionAudit = audit; return validateSourceUnderstanding(output, input) }
  const audited = { status: 'audited', reason: 'Sampled.', omissionRate: 0.5, samples: [] }

  assert.deepEqual(issuesFor(audited), [])
  // A status outside the vocabulary cannot be stored or rendered.
  assert.ok(issuesFor({ ...audited, status: 'partially_audited' }).some(issue => issue.includes('status must be one of')))
  assert.ok(issuesFor(undefined).some(issue => issue.includes('status must be one of')))
  // A reason is the one thing only the run can supply.
  assert.ok(issuesFor({ ...audited, reason: '' }).some(issue => issue.includes('reason')))
  // A rate that is not a fraction is not a rate.
  assert.ok(issuesFor({ ...audited, omissionRate: '50%' }).some(issue => issue.includes('fraction between 0 and 1')))
  assert.ok(issuesFor({ ...audited, omissionRate: 1.5 }).some(issue => issue.includes('fraction between 0 and 1')))
  assert.ok(issuesFor({ ...audited, omissionRate: Number.NaN }).some(issue => issue.includes('fraction between 0 and 1')))
  assert.deepEqual(issuesFor({ ...audited, omissionRate: null }), [])
  // And that is the whole list: three checks, all of them about shape.
  assert.deepEqual(issuesFor({ status: 'audited', reason: '', omissionRate: 2 }).length, 2)
})

test('a deployment that does not sample can still deliver, and absent is never zero', () => {
  const input = auditFixture()
  const output = auditedOutput(input, ['src_fix:g4:u8'])
  output.omissionAudit = { status: 'not_run', reason: 'This deployment does not sample.', omissionRate: null }
  assert.deepEqual(validateSourceUnderstanding(output, input), [])
  output.omissionAudit = { status: 'not_run', reason: 'This deployment does not sample.', omissionRate: 0 }
  assert.ok(validateSourceUnderstanding(output, input).some(issue => issue.includes('absent audit is not a zero omission rate')))
  // Samples attached to an audit that did not run are a contradiction, but a
  // recorded one: the notice says so and the delivery still goes through.
  output.omissionAudit = { status: 'not_run', reason: 'r', omissionRate: null, samples: [{ unitId: 'src_fix:g4:u8', represented: true }] }
  assert.deepEqual(validateSourceUnderstanding(output, input), [])
  assert.deepEqual(sourceUnderstandingOmissionNotice(output, input).disagreements, ['The audit reports not_run yet attaches 1 sample(s).'])
})

test('the control plane reads the audit off the output, and reports every disagreement as a notice', () => {
  const input = auditFixture()
  const output = auditedOutput(input, ['src_fix:g4:u8'])
  const clean = sourceUnderstandingOmissionNotice(output, input)
  assert.deepEqual(clean, {
    status: 'audited', omissionRate: 0.5, target: 0.15, withinTarget: false, audited: 2,
    plan: ['src_fix:g4:u8', 'src_fix:g4:u9'],
    samples: [{ unitId: 'src_fix:g4:u8', represented: true }, { unitId: 'src_fix:g4:u9', represented: false, note: 'No claim or slot reaches this unit.' }],
    reportedRate: 0.5, disagreements: [], blocking: false,
  })
  // 50% omission at structured depth is more than three times the target, and
  // it is still only a notice: this is the assertion that keeps the audit from
  // becoming a seventh blocking point.
  assert.deepEqual(validateSourceUnderstanding(output, input), [])
  assert.deepEqual(distillationCompleteness(clean.samples.map(sample => ({ unitId: sample.unitId, answered: sample.represented })), 'structured'),
    { omissionRate: 0.5, target: 0.15, withinTarget: false, audited: 2 })

  // Now a run that reports something its own output does not support. Nothing
  // is refused; everything is named.
  const wrong = auditedOutput(input, ['src_fix:g4:u8'])
  wrong.omissionAudit.samples = [{ unitId: 'src_fix:g4:u9', represented: true }, { unitId: 'src_fix:g4:u1', represented: true }]
  wrong.omissionAudit.omissionRate = 0
  const notice = sourceUnderstandingOmissionNotice(wrong, input)
  assert.deepEqual(validateSourceUnderstanding(wrong, input), [])
  assert.equal(notice.blocking, false)
  assert.equal(notice.omissionRate, 0.5, 'the derived rate comes from the anchors, not from the report')
  assert.equal(notice.reportedRate, 0)
  assert.deepEqual(notice.samples, [{ unitId: 'src_fix:g4:u8', represented: true }, { unitId: 'src_fix:g4:u9', represented: false }])
  assert.deepEqual(notice.disagreements, [
    "The audit did not report on 1 of this source's 2 sampled unit(s): src_fix:g4:u8.",
    "The audit reported on 1 unit(s) outside this source's sample: src_fix:g4:u1.",
    'The audit calls src_fix:g4:u9 represented; the anchors this output carries say unrepresented.',
    'The audit reports an omission rate of 0; the anchors this output carries imply 0.5.',
  ])

  // A known slot's anchor represents its unit exactly as a claim's does.
  const viaSlot = /** @type {any} */ (auditedOutput(input, []))
  viaSlot.slots.topic = { state: 'known', value: 'The fixture topic.', evidence: [anchorFactory(input)('src_fix:g4:u9')] }
  assert.deepEqual(sourceUnderstandingOmissionNotice(viaSlot, input).samples,
    [{ unitId: 'src_fix:g4:u8', represented: false, note: 'No claim or slot reaches this unit.' },
      { unitId: 'src_fix:g4:u9', represented: true, note: 'No claim or slot reaches this unit.' }])

  // The deep target is stricter and still only a notice.
  const deep = auditFixture('src_fix', 4, 'deep')
  const deepOutput = auditedOutput(deep, ['src_fix:g4:u8'])
  assert.deepEqual(validateSourceUnderstanding(deepOutput, deep), [])
  assert.equal(sourceUnderstandingOmissionNotice(deepOutput, deep).target, 0.05)
  // An audit that did not run reports no rate rather than a passing one.
  const unaudited = sourceUnderstandingOmissionNotice({ omissionAudit: { status: 'not_run', reason: 'r', omissionRate: null } }, input)
  assert.equal(unaudited.omissionRate, null)
  assert.equal(unaudited.audited, 0)
  assert.equal(unaudited.blocking, false)
  assert.deepEqual(unaudited.samples, [])
})

test('an anchor from another source or an older generation is neither usable evidence nor representation', () => {
  // One predicate decides both, so this case pins both at once. The unit id
  // still resolves — what fails is the anchor's own claim about which capture it
  // came from — and both consequences matter: as evidence it is unusable, and as
  // representation it would let a run buy a clean omission rate with an anchor
  // into a superseded generation of the source.
  const input = auditFixture()
  const plan = sourceUnderstandingAuditSample(input)
  for (const foreign of [{ sourceId: 'src_other' }, { generation: 5 }]) {
    const output = auditedOutput(input, [plan[0]])
    Object.assign(output.claims[0].evidence[0], foreign)
    assert.deepEqual(validateSourceUnderstanding(output, input),
      [`claims.c0 needs an exact quote within its source generation and unit range.`],
      `an anchor carrying ${JSON.stringify(foreign)} must not pass as evidence`)
    const notice = sourceUnderstandingOmissionNotice(output, input)
    assert.deepEqual(notice.samples.map(sample => sample.represented), [false, false],
      `an anchor carrying ${JSON.stringify(foreign)} must not make its unit represented`)
    assert.equal(notice.omissionRate, 1)
    // And the run's own claim to the contrary is still only a disagreement.
    assert.equal(notice.reportedRate, 0.5)
    assert.ok(notice.disagreements.some(line => line.includes(`calls ${plan[0]} represented`)))
  }
})

test('the projection stores the audit the control plane read, not the one the run reported', () => {
  const input = auditFixture()
  const output = auditedOutput(input, ['src_fix:g4:u8'])
  output.omissionAudit.omissionRate = 0
  output.omissionAudit.samples = [{ unitId: 'src_fix:g4:u8', represented: true }, { unitId: 'src_fix:g4:u9', represented: true }]

  const projected = /** @type {any} */ (projectSourceUnderstandingOutput(output, input))
  assert.equal(projected.omissionAudit.status, 'audited')
  assert.equal(projected.omissionAudit.omissionRate, 0.5, 'the stored rate is derived, so a run cannot record a clean audit it did not perform')
  assert.deepEqual(projected.omissionAudit.samples, [{ unitId: 'src_fix:g4:u8', represented: true }, { unitId: 'src_fix:g4:u9', represented: false }])
  // No anchor is copied into a sample: the anchors are already in this record,
  // and duplicating up to twelve 2,000-character quotes would spend the
  // output's byte budget to say nothing new.
  assert.deepEqual(Object.keys(projected.omissionAudit.samples[0]), ['unitId', 'represented'])
  assert.ok(new TextEncoder().encode(JSON.stringify(projected.omissionAudit)).byteLength < 1000)

  // Without an input there is nothing to derive from, so the recorded audit is
  // carried through, normalized — the read path over a stored row.
  const stored = /** @type {any} */ (projectSourceUnderstandingOutput(output))
  assert.equal(stored.omissionAudit.omissionRate, 0)
  assert.deepEqual(stored.omissionAudit.samples, [{ unitId: 'src_fix:g4:u8', represented: true }, { unitId: 'src_fix:g4:u9', represented: true }])
  // A record written before the audit existed still projects, as not_run.
  const legacy = /** @type {any} */ (projectSourceUnderstandingOutput({ ...output, omissionAudit: { reason: 'Not audited.' } }))
  assert.deepEqual(legacy.omissionAudit, { status: 'not_run', reason: 'Not audited.', omissionRate: null })
  // An unusable note is dropped rather than stored or refused.
  const noisy = auditedOutput(input, [])
  noisy.omissionAudit.samples[0].note = 'x'.repeat(SOURCE_UNDERSTANDING_AUDIT_NOTE_MAX_CHARS + 1)
  assert.deepEqual(Object.keys(/** @type {any} */ (projectSourceUnderstandingOutput(noisy, input)).omissionAudit.samples[0]), ['unitId', 'represented'])
  assert.deepEqual(validateSourceUnderstanding(noisy, input), [], 'an over-long note is dropped from the record, never charged to the delivery')
})

test('the largest audit that can be stored is a small, source-independent share of the output budget', () => {
  // The 100,000-byte output limit is terminal, so the audit must not be able to
  // be what exhausts it. Two bounds do that and neither depends on the source's
  // length: at most twelve samples, and a note kept only to its character
  // bound. Copying an anchor into each sample — up to twelve 2,000-character
  // quotes — was the version of this that could not hold.
  const units = Array.from({ length: 5000 }, (_, index) => ({ id: `u${index + 1}`, start: index * 10, end: index * 10 + 10 }))
  const input = { sourceId: 'src_wide', generation: 1, depth: 'deep', text: '', units }
  const plan = sourceUnderstandingAuditSample(input)
  assert.equal(plan.length, SOURCE_UNDERSTANDING_AUDIT_MAX_SAMPLES)
  const output = { omissionAudit: { status: 'audited', reason: 'r', omissionRate: 1,
    // Chinese notes at the bound: the most expensive note this contract accepts.
    samples: plan.map(unitId => ({ unitId, represented: false, note: '注'.repeat(SOURCE_UNDERSTANDING_AUDIT_NOTE_MAX_CHARS) })) } }
  const stored = sourceUnderstandingOmissionNotice(output, input).samples
  assert.equal(stored.length, SOURCE_UNDERSTANDING_AUDIT_MAX_SAMPLES)
  assert.ok(stored.every(sample => sample.note?.length === SOURCE_UNDERSTANDING_AUDIT_NOTE_MAX_CHARS))
  const bytes = new TextEncoder().encode(JSON.stringify(stored)).byteLength
  assert.ok(bytes < 20_000, `the widest storable audit is ${bytes} bytes, which is no longer a small share of the 100000-byte limit`)
})

test('the frozen input tells the run which units to audit, and the contract does not take its word for it', () => {
  const input = auditFixture()
  assert.deepEqual(input.auditSample, ['src_fix:g4:u8', 'src_fix:g4:u9'])
  assert.deepEqual(input.auditSample, sourceUnderstandingAuditSample(input))
  // A tampered plan in the input file moves nothing: the sample is recomputed
  // from the source identity, so the measurement follows the capture.
  const output = auditedOutput(input, ['src_fix:g4:u8'])
  assert.deepEqual(validateSourceUnderstanding(output, { ...input, auditSample: ['src_fix:g4:u1'] }), [])
  assert.deepEqual(sourceUnderstandingOmissionNotice(output, { ...input, auditSample: ['src_fix:g4:u1'] }).plan, ['src_fix:g4:u8', 'src_fix:g4:u9'])
})
