import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OfflineLoop } from '../learn/offlineLoop.mjs';
import { fakeLearningModel } from '../learn/modelSteps.mjs';
import { validateLedgerRow } from '../run/ledger.mjs';
import { FLOORS, admittedMethod, callEvidence, claimsOf, compactReport, defectRetest, ledgerRows, mergeHarms, methodInput, nativePass, pool, recommend, refreshArtifacts, runGroup, scoreDecisions, screenRows, seed, zeroTokens } from './run_l4.mjs';

const method = (id, body = '# Preserve supplied facts\n- Use the supplied facts only.') => ({ id, whenToUse: 'When writing a report.', body });

test('public filler admission substitutions are disclosed and never modify planted methods', () => {
  const raw = { ...method('filler', 'Do not log 密码 or 令牌.'), source: 'filler' };
  assert.equal(admittedMethod(raw).body, 'Do not log 认证凭据 or 授权凭据.');
  assert.equal(admittedMethod({ ...raw, source: 'planted' }).body, raw.body);
});

test('source labels stay outside product methods and product computes approved records/digests', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'l4-import-'));
  try {
    const loop = await OfflineLoop.open({ dir, env: 'test', model: fakeLearningModel() });
    const original = method('L4:foo:duplicate');
    const input = methodInput(original);
    assert(!JSON.stringify(input).includes('duplicate'));
    assert(input.body.includes(original.body));
    const mapping = await seed(loop, [original]);
    const record = await loop.learning.getMethod('c1-offline', mapping[original.id]);
    assert.equal(record.payload.status, 'approved');
    assert.match(record.payload.contentDigest, /^sha256:[a-f0-9]{64}$/);
    assert.equal((await seed(loop, [original]))[original.id], record.id);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('floor tradeoff distinguishes positive recall from unrelated candidate cost; recommendation preserves each kind', () => {
  const gold = [{ a: 'a', b: 'b', relation: 'duplicate' }, { a: 'a', b: 'c', relation: 'subset' },
    { a: 'a', b: 'd', relation: 'conflict' }, { a: 'a', b: 'e', relation: 'unrelated' }];
  const pairs = [{ a: 'a', b: 'b', score: 0.8 }, { a: 'a', b: 'c', score: 0.61 }, { a: 'a', b: 'd', score: 0.57 }, { a: 'a', b: 'e', score: 0.49 }];
  const screen = screenRows(pairs, gold);
  assert.equal(screen.find(row => row.floor === 0.5).candidates, 3);
  assert.equal(screen.find(row => row.floor === 0.5).recall, 1);
  assert.equal(screen.find(row => row.floor === 0.5).byKind.unrelated.recall, 0);
  assert.equal(recommend([{ size: 50, screen }]).floor, 0.55);
  const missing = screenRows(pairs.filter(pair => pair.b !== 'd'), gold);
  assert.equal(recommend([{ size: 50, screen }, { size: 200, screen: missing }]).floor, 0.55);
  assert.equal(FLOORS.length, 11);
});

test('multimember directional assignments and weak-label false positives are scored explicitly', () => {
  const mapping = { a: 'm1', b: 'm2', c: 'm3' };
  const claims = claimsOf([{ SKILLS: ['m1', 'm2', 'm3'], RELATION_TYPE: 'subset', WIDER: 'm1' }], mapping);
  assert.equal(claims.length, 2);
  assert(!claims.some(claim => [claim.a, claim.b].includes('b') && [claim.a, claim.b].includes('c')));
  const gold = [{ a: 'a', b: 'b', relation: 'subset' }, { a: 'a', b: 'c', relation: 'unrelated' }];
  const scored = scoreDecisions(gold, [...claims, ...claims]);
  assert.equal(scored.byKind.subset.precision, 0.5);
  assert.equal(scored.byKind.subset.recall, 1);
  assert.equal(scored.byKind.unrelated.keptApart, 0);
  assert.equal(scoreDecisions(gold, [{ a: 'a', b: 'b', type: 'subset', wider: 'b' }]).byKind.subset.tp, 0);
  assert.equal(claimsOf([{ SKILLS: ['m1', 'm2', 'unknown'], RELATION_TYPE: 'merge' }], mapping).length, 0);
  assert.deepEqual(claimsOf([{ SKILLS: ['one', 'two'], RELATION_TYPE: 'subset', WIDER: 'one' }],
    { a: 'method:learned:one', b: 'method:learned:two' }), [{ a: 'a', b: 'b', type: 'subset', wider: 'a', reason: undefined }]);
});

test('wrong merge proposal is distinct from destruction, and unknown gold is never proven harm', () => {
  const group = { groupId: 0, predictions: [{ a: 'a', b: 'b', type: 'merge' }, { a: 'c', b: 'd', type: 'merge' }],
    effects: { retired: [], deleted: [], created: [] } };
  const gold = [{ a: 'a', b: 'b', relation: 'conflict' }];
  assert.equal(mergeHarms(gold, [group]).harmfulMerges.length, 0);
  group.effects.retired = ['a', 'c'];
  assert.equal(mergeHarms(gold, [group]).harmfulMerges.length, 1);
  assert.equal(mergeHarms(gold, [group]).suspectedUnlabelled.length, 1);
});

test('exhaustive group driver uses product sleep and resumes without another model call', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'l4-group-'));
  let calls = 0;
  const fake = fakeLearningModel();
  const model = { ...fake, complete: async input => { calls++; return fake.complete(input); } };
  try {
    const runDir = path.join(dir, 'l4-50-1');
    const options = { dir: path.join(runDir, 'decide-0.50', 'group-000'), originals: [method('a'), method('b')], pairs: [{ a: 'a', b: 'b', score: 0.9, overlap: 0.9 }],
      embedder: { embed: async texts => texts.map(() => [1, 0]), model: 'test' }, model, floor: 0.5, groupId: 'test' };
    const result = await runGroup(options);
    assert.equal(result.result.groups, 1);
    assert.equal(result.result.decidedNothing, 1);
    assert.equal(result.result.shortlist.mode, 'embedding');
    const paid = calls;
    assert.deepEqual(await runGroup(options), result);
    assert.equal(calls, paid);
    // Simulate a crash after mutable library state was saved but before the result receipt survived.
    await rm(path.join(options.dir, 'result.json'));
    assert.deepEqual(await runGroup(options), result);
    assert.equal(calls, paid);
    assert(JSON.parse(await readFile(path.join(options.dir, 'library.json'), 'utf8')).documents.rows.length === 2);
    const summary = { runId: 'l4-50-1', commit: 'test', size: 50, model: 'fake', thinking: 'disabled',
      screen: screenRows([], [{ a: 'a', b: 'b', relation: 'duplicate' }]), decide: { '0.50': {
        ...scoreDecisions([{ a: 'a', b: 'b', relation: 'duplicate' }], []), effects: result.effects, tokens: zeroTokens(), costCnyPeakUpper: 0 } } };
    for (const row of ledgerRows(summary, { root: dir })) assert.deepEqual(validateLedgerRow(row), []);
    await writeFile(path.join(dir, 'gold-50.json'), JSON.stringify({ pairs: [{ a: 'a', b: 'b', relation: 'duplicate' }] }));
    await writeFile(path.join(runDir, 'pairs.jsonl'), JSON.stringify({ stage: 'screen', a: 'a', b: 'b', score: 0.9, overlap: 0.9 }) + '\n');
    summary.embedding = { tokens: 0 };
    summary.recommendation = { floor: 0.6 };
    const reportOptions = { root: dir, data: dir, prices: { inputPerMTok: 2, cachedInputPerMTok: 0.04, outputPerMTok: 8 } };
    await refreshArtifacts(reportOptions, summary);
    const firstReport = await readFile(path.join(runDir, 'pairs.jsonl'), 'utf8');
    await refreshArtifacts(reportOptions, summary);
    assert.equal(await readFile(path.join(runDir, 'pairs.jsonl'), 'utf8'), firstReport);
    assert.equal(calls, paid);
    assert.equal(summary.decide['0.50'].goldPairsRead.duplicate, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('native full-store pass retains the real active cap and checkpoints its retirements', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'l4-native-'));
  const model = fakeLearningModel();
  try {
    const runId = 'l4-50-1';
    const seedDir = path.join(dir, runId, 'seed');
    const loop = await OfflineLoop.open({ dir: seedDir, env: 'native-test', model });
    const mapping = await seed(loop, Array.from({ length: 55 }, (_, i) => method(`m-${i}`)));
    await writeFile(loop.statePath, JSON.stringify({ ...loop.state, documents: loop.documents.snapshot() }));
    await writeFile(path.join(dir, runId, 'mapping.json'), JSON.stringify(mapping));
    await writeFile(path.join(dir, 'gold-50.json'), JSON.stringify({ pairs: [{ a: 'm-0', b: 'm-1', relation: 'unrelated' }] }));
    const options = { root: dir, data: dir, prices: { inputPerMTok: 2, cachedInputPerMTok: 0.04, outputPerMTok: 8 } };
    const result = await nativePass(options, { runId, size: 50 }, 0.5,
      { embed: async texts => texts.map(() => [1, 0]), model: 'test' }, model);
    assert.equal(result.effects.approvedBefore, 55);
    assert.equal(result.effects.approvedAfter, 50);
    assert(result.effects.stopped.filter(entry => entry.code === 'library_cap').length >= 5);
    assert(result.effects.retired.length >= 5);
    assert.deepEqual(await nativePass(options, { runId, size: 50 }, 0.5, null, null), result);
    const summary = { runId, size: 50, commit: 'test', model: 'fake', thinking: 'disabled', recommendation: { floor: 0.6 },
      embedding: { tokens: 0, costCnyUpper: 0 }, screen: [], decide: {}, native: { '0.50': result } };
    const rows = ledgerRows(summary, options);
    assert.equal(rows.length, 2);
    for (const row of rows) assert.deepEqual(validateLedgerRow(row), []);
    assert.equal(rows.reduce((sum, row) => sum + row.tokens.prompt, 0), result.tokens.prompt);
    assert.equal(rows.reduce((sum, row) => sum + row.costCny, 0), result.costCnyPeakUpper);
    const report = compactReport([summary]);
    assert.equal(report.totals.modelCostCnyPeakUpper, result.costCnyPeakUpper);
    assert.equal(report.totals.tokens.prompt, result.tokens.prompt);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('worker pool never exceeds the requested model concurrency', async () => {
  let active = 0, peak = 0;
  const out = await pool([0, 1, 2, 3, 4, 5, 6], 3, async value => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 2));
    active--; return value;
  });
  assert.equal(peak, 3);
  assert.deepEqual(out, [0, 1, 2, 3, 4, 5, 6]);
});

test('call accounting excludes cache receipts and reconstructs overlap with end-before-start ties', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'l4-calls-'));
  try {
    const runId = 'l4-50-1';
    const logDir = path.join(dir, runId, 'native-0.50');
    await mkdir(logDir, { recursive: true });
    const row = { promptTokens: 10, completionTokens: 5, cachedTokens: 2, ms: 1000, model: 'fake', ok: true };
    await writeFile(path.join(logDir, 'calls.jsonl'), [
      { ...row, at: '2026-11-10T13:00:01.000Z' },
      { ...row, at: '2026-11-10T13:00:01.500Z', ok: false },
      { ...row, at: '2026-11-10T13:00:02.000Z' },
      { at: '2026-11-10T13:00:02.000Z', cached: true, ok: true },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    const evidence = await callEvidence({ root: dir }, [{ runId, decide: {}, native: { '0.50': {} } }]);
    assert.equal(evidence.paidCalls, 3);
    assert.equal(evidence.cachedCalls, 1);
    assert.equal(evidence.maxConcurrentCalls, 2);
    assert.equal(evidence.rejectedPackages, 1);
    assert.deepEqual(evidence.tokens, { prompt: 30, completion: 15, cached: 6, extractionPrompt: 0, extractionCompletion: 0 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('defect-1 evidence exercises a filtered merge and same-digest sleep without skipped_unchanged', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'l4-defect-'));
  const fake = fakeLearningModel();
  const model = { ...fake, complete: async request => {
    const input = JSON.parse(request.messages.find(message => message.role === 'user').content.match(/```json\n([\s\S]*?)\n```/)[1]);
    if (input.action !== 'decide') return fake.complete(request);
    return { model: 'fake', usage: {}, message: { content: JSON.stringify({ 'method-relations.json': {
      schemaVersion: 1, action: 'decide', jobId: 'test', assignments: [{ ASSIGNMENT: 'A1', RELATION_TYPE: 'merge',
        SKILLS: input.methods.map(method => method.id), REASON: 'The methods preserve exactly the same supplied facts.' }] } }) } };
  } };
  try {
    await mkdir(path.join(dir, 'data'));
    await writeFile(path.join(dir, 'data', 'library-50.json'), JSON.stringify({ methods: [method('a'), method('b')] }));
    const summary = { size: 50, runId: 'l4-50-1', decide: { '0.50': { predictions: [{ a: 'a', b: 'b', type: 'merge' }] } } };
    await defectRetest({ root: dir, data: path.join(dir, 'data') }, summary,
      { embed: async texts => texts.map(() => [1, 0]), model: 'test' }, model);
    assert.equal(summary.defect1.answer, 'yes');
    assert.equal(summary.defect1.sameGroup, true);
    assert.equal(summary.defect1.integrated.deferredBuilds, 1);
    assert.equal(summary.defect1.slept.skippedUnchanged, 0);
    assert.equal(summary.defect1.slept.groups, 1);
    assert(summary.defect1.stampsAfterIntegrate.every(method => method.decided === null));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
