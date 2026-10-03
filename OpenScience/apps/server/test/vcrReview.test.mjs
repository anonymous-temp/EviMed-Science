import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { vcrResultOutputPayload } from '@evimed/domain';
import { vcrRecordedResultHash } from '../src/vcrJobs.mjs';
import { buildVcrReviewInput, vcrIsNumberlessVerdict } from '../src/vcrReview.mjs';
import { vcrReportReviewRevision } from '../src/vcrRender.mjs';
import { vcrReviewIsCurrent, useCeilingOf } from '../src/vcrViews.mjs';
const result = { id: 'trial', version: 1, executionId: 'execution', measures: [{ key: 'power', value: 0.8 }], counts: { observedPatients: 3 }, conclusion: 'limited', tables: [] };
const outputHash = createHash('sha256').update(vcrResultOutputPayload(result)).digest('hex');
const model = { study: { id: 'study', name: 'Test', dataTier: 'T1' }, definition: { version: 1 }, assumptions: [{ key: 'rate', version: 1, value: 0.3 }],
  results: { trial: result }, measures: result.measures, counts: result.counts, scenarios: [], models: [], review: { records: [] } };
test('VCR review traces stored hashes and numeric bindings and sends only model-safe aggregates', () => {
  const input = buildVcrReviewInput({ model, results: [result], executions: [{ id: 'execution', output_hash: outputHash, method: 'test', method_version: '1' }],
    evidence: [], reports: [{ template: 'Count {{n:counts.observedPatients}}; power {{n:measures[0].value}}.' }],
    forModel: value => JSON.parse(JSON.stringify(value).replace('"observedPatients":3', '"observedPatients":null')) });
  assert.equal(input.deterministic.numbers.checked, 1); assert.ok(input.nodes.includes('result:trial@1'));
  assert.ok(!input.frozenInput.report.includes('Count 3'));
  assert.ok(!JSON.stringify(input.frozenInput).includes('output_hash'));
  const bad = buildVcrReviewInput({ model, results: [result], executions: [], evidence: [], reports: [], forModel: value => value });
  assert.equal(bad.deterministic.findings[0].kind, 'number_untraced');
});
test('AI review requires nonempty current nodes and trusted completed provenance', () => {
  const context = { results: [result] };
  assert.equal(vcrReviewIsCurrent({ nodes: [] }, context), false);
  assert.equal(vcrReviewIsCurrent({ reviewerKind: 'ai', status: 'running', nodes: ['result:trial@1'] }, context), false);
  assert.equal(vcrReviewIsCurrent({ reviewerKind: 'ai', status: 'done', nodes: ['result:trial@1'] }, context), false);
  assert.equal(vcrReviewIsCurrent({ reviewerKind: 'ai', status: 'done', platformReviewId: 'rv', provenance: { model: 'actual', inputDigest: 'digest' }, nodes: ['result:trial@1'] }, context), true);
});
test('review absence is advisory and cannot lower the method/evidence use ceiling', () => {
  const args = { study: { intendedUse: 'specified_analysis' }, results: [], reviews: [] };
  assert.equal(useCeilingOf(args).ceiling, useCeilingOf({ ...args, reviews: [{ nodes: ['assumption:a@1'], reviewer: 'human' }] }).ceiling);
  assert.ok(!useCeilingOf(args).reasons.some(reason => /签注|不能标/.test(reason.detail)));
});

test('evidence checks verify actual preserved bytes and model input omits plane addresses and small cells', async () => {
  const { VcrService } = await import('../src/vcrService.mjs');
  const service = new VcrService({ store: {}, config: { vcrMinCell: 5 } });
  const quote = 'Observed response was 25%.';
  const evidence = [{ id: 'ev1', quote, source_ref: '/private/data-plane/source', locator: { verification: 'verified' }, record_text: quote,
    record_hash: createHash('sha256').update(quote).digest('hex') }];
  const payload = { ...model, counts: { realPatients: 3 }, assumptions: [{ key: 'rate', version: 1, value: 0.25, evidenceIds: ['ev1'] }],
    results: { trial: { ...result, counts: { realPatients: 3 }, diagnostics: { location: '/private/data-plane/patients.parquet', inputHashes: ['secret'] } } } };
  const input = buildVcrReviewInput({ model: payload, results: [result], executions: [{ id: 'execution', output_hash: outputHash }], evidence,
    reports: [{ template: 'Patients {{n:counts.realPatients}}.' }], forModel: value => service.forModel(value) });
  assert.equal(input.deterministic.references.checked, 1);
  assert.ok(!input.deterministic.findings.some(row => row.kind === 'reference_unresolvable'));
  assert.doesNotMatch(JSON.stringify(input.frozenInput), /private\/data-plane|secret|Patients 3/);
  evidence[0].record_text = 'Changed source';
  const changed = buildVcrReviewInput({ model: payload, results: [], executions: [], evidence, reports: [], forModel: value => service.forModel(value) });
  assert.ok(changed.deterministic.findings.some(row => row.kind === 'reference_unresolvable'));
});

test('multistage tracing binds a verified engine stage and the exact recorded aggregate separately', () => {
  const stage = { ...result, measures: [{ name: 'power', value: 0.8 }] };
  const aggregate = { ...result, measures: [{ name: 'required_events', value: 138 }, ...stage.measures], version: 2 };
  const stageHash = createHash('sha256').update(vcrResultOutputPayload(stage)).digest('hex');
  const receipt = { stageVerified: true, stageOutput: JSON.parse(vcrResultOutputPayload(stage)),
    recordedResultHash: vcrRecordedResultHash(aggregate), recordedResultId: aggregate.id, recordedResultVersion: aggregate.version };
  const executions = [{ id: 'execution', output_hash: stageHash, receipt }];
  const trace = (value, rows = executions) => buildVcrReviewInput({ model, results: [value], executions: rows, evidence: [], reports: [], forModel: value => value });
  assert.notEqual(receipt.recordedResultHash, stageHash);
  assert.ok(!trace(aggregate).deterministic.findings.some(row => row.kind === 'number_untraced'));
  for (const changed of [{ ...aggregate, measures: [{ name: 'required_events', value: 999 }, ...stage.measures] }, { ...aggregate, id: 'other' }, { ...aggregate, version: 3 }, { ...aggregate, diagnostics: { stageResults: { h0: { measures: [{ name: 'expected_n', value: 999 }] } } } }]) {
    assert.ok(trace(changed).deterministic.findings.some(row => row.kind === 'number_untraced'));
  }
  for (const proof of [{}, { ...receipt, stageVerified: false }, { ...receipt, stageOutput: { ...receipt.stageOutput, counts: { realPatients: 99 } } }]) {
    assert.ok(trace(aggregate, [{ ...executions[0], receipt: proof }]).deterministic.findings.some(row => row.kind === 'number_untraced'));
  }
});

test('a verdict the control plane derived has no number to trace; any result that carries one without a receipt is still untraced', () => {
  // The row `VcrOrchestrator.#unavailable` records for a route the data tier cannot reach: no job, so no execution.
  const verdict = { id: 'cmp', version: 1, executionId: null, kind: 'comparator', conclusion: 'not_estimable', notEstimableRule: 'data_tier_insufficient',
    counts: { realPatients: null, events: null, effectiveSampleSize: null, generatedRecords: null }, measures: [], tables: [],
    diagnostics: { gaps: [{ title: '外部患者的治疗与结局个体数据', detail: '这个研究的数据档位是 T0，这条路线最低要 T2。', answers: '补上之后可以做加权的外部对照。' }],
      derivedBy: 'control_plane', reason: 'data_tier_insufficient' } };
  const receipt = { stageVerified: true, stageOutput: JSON.parse(vcrResultOutputPayload(result)),
    recordedResultHash: vcrRecordedResultHash(result), recordedResultId: result.id, recordedResultVersion: result.version };
  const executions = [{ id: 'execution', output_hash: outputHash, receipt }];
  const trace = rows => buildVcrReviewInput({ model, results: rows, executions, evidence: [], reports: [], forModel: value => value });
  assert.equal(vcrIsNumberlessVerdict(verdict), true);
  const reviewed = trace([result, verdict]);
  assert.deepEqual(reviewed.deterministic.findings, [], 'nothing with a fix: the package is not sent to a paid revision for a verdict');
  assert.deepEqual(reviewed.deterministic.numbers, { checked: 1, verdicts: 1, bindings: 0 }, 'the verdict is said, not counted as checked');
  assert.ok(reviewed.nodes.includes('result:cmp@1'), 'the review still names the verdict as one of the versions it read');
  // The same row with any number in it, or with an execution it cannot show, has something to trace.
  const carrying = [
    { ...verdict, measures: [{ name: 'weighted_difference', value: 0.12 }] },
    { ...verdict, counts: { ...verdict.counts, realPatients: 240 } },
    { ...verdict, counts: { ...verdict.counts, events: 0 } },
    { ...verdict, tables: [{ name: 'weights', sha256: 'a'.repeat(64) }] },
    { ...verdict, diagnostics: { ...verdict.diagnostics, support: { outsideShare: 0.41 } } },
    { ...verdict, executionId: 'execution-nobody-recorded' },
    { ...verdict, conclusion: 'estimable' },
    { ...verdict, conclusion: 'limited' },
  ];
  for (const row of carrying) {
    assert.equal(vcrIsNumberlessVerdict(row), false, JSON.stringify(row));
    const flagged = trace([result, row]).deterministic;
    assert.deepEqual(flagged.findings.map(finding => [finding.kind, finding.location]), [['number_untraced', 'result:cmp@1']]);
    assert.equal(flagged.numbers.checked, 2);
  }
  // And an engine result whose receipt does not bind it is flagged beside an exempt verdict, as before.
  assert.deepEqual(buildVcrReviewInput({ model, results: [result, verdict], executions: [], evidence: [], reports: [], forModel: value => value })
    .deterministic.findings.map(finding => finding.location), ['result:trial@1']);
});

test('a reference is judged on the report a reader gets: a cell hidden from the reviewer is not an untraced number', () => {
  const hidden = buildVcrReviewInput({ model, results: [], executions: [], evidence: [],
    reports: [{ template: 'Count {{n:counts.observedPatients}}; diagnostics {{n:diagnostics.sensitivity.base.value|f2}}; absent {{n:counts.nobodyCounted}}.' }],
    forModel: value => JSON.parse(JSON.stringify(value).replace('"observedPatients":3', '"observedPatients":null')) });
  // The reviewer's copy still hides the small cell.
  assert.match(hidden.frozenInput.report, /Count 未计算/);
  assert.ok(!hidden.frozenInput.report.includes('Count 3'));
  // The finding is only about what the exact report cannot bind either.
  assert.deepEqual(hidden.deterministic.findings.map(finding => [finding.kind, finding.location]),
    [['number_untraced', 'diagnostics.sensitivity.base.value'], ['number_untraced', 'counts.nobodyCounted']]);
  assert.equal(hidden.deterministic.numbers.bindings, 3);
  assert.doesNotMatch(JSON.stringify(hidden.deterministic.findings), /\b3\b/, 'a finding names a path, never the hidden value');
  // A part of the model the reviewer is not sent binds in the report all the same.
  const whole = buildVcrReviewInput({ model: { ...model, diagnostics: { sensitivity: { base: { value: 0.15 } } } }, results: [], executions: [], evidence: [],
    reports: [{ template: 'Difference {{n:diagnostics.sensitivity.base.value|f2}}.' }], forModel: value => value });
  assert.deepEqual(whole.deterministic.findings, []);
});

test('export-bound historical reviews without report proof are not attested current', () => {
  const cover = { reports: [{ section: 'main', template: 'Original claim.' }], results: model };
  const context = { results: [result], exports: [{ id: 'export', cover }] };
  const review = { reviewerKind: 'ai', status: 'done', platformReviewId: 'rv', nodes: ['result:trial@1'],
    provenance: { model: 'actual', inputDigest: 'snapshot', subjectRef: { exportId: 'export' } } };
  assert.equal(vcrReviewIsCurrent(review, context), false);
  review.provenance.subjectRef.reportRevision = vcrReportReviewRevision(cover);
  assert.equal(vcrReviewIsCurrent(review, context), true);
  cover.reports[0].template = 'Updated claim.';
  assert.equal(vcrReviewIsCurrent(review, context), false);
});
