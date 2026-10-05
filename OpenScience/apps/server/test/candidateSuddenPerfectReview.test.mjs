import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createEvolutionCandidateEvaluator } from '../src/evolutionCandidateEvaluator.mjs';

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sudden-perfect-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'paper-gold/candidate-cases'); await fs.mkdir(dir, { recursive: true });
  const definition = { methodId: 'test-method', frozen: true, cases: [1, 2].map(id => ({ id: `case-${id}`, kind: 'published', hidden: true, independentQa: { passed: true }, sourceHash: 'a'.repeat(64), publicationId: `paper-${id}`, input: { x: id }, numeric: { value: { value: id, absoluteTolerance: 0 } }, independentImplementation: { implementationId: 'independent-fixture', numeric: { value: id } } })) };
  await fs.writeFile(path.join(dir, 'test-method.json'), JSON.stringify(definition));
  let calls = 0, tier = 'unexposed', reviewFails = false, reviewUnknown = false;
  const evaluator = createEvolutionCandidateEvaluator({ config: { dataDir: root, evaluationDataDir: root }, auditCandidateExposure: async () => ({ tier }), controller: { execVerify: async body => {
    calls++;
    if (reviewUnknown && calls > 8) return { ok: false, joined: true, executionStarted: false, output: '' };
    const bad = body.files['scripts/estimate.py'].includes('WRONG') || (reviewFails && calls > 8);
    return { ok: true, joined: true, executionStarted: true, output: JSON.stringify({ value: body.input.x + (bad ? 1 : 0) }) };
  } } });
  const candidate = wrong => ({ id: wrong ? 'bad-candidate' : 'good-candidate', entrypoint: 'scripts/estimate.py:estimate', files: { 'scripts/estimate.py': wrong ? 'def estimate(x): return {"value":x+1} # WRONG' : 'def estimate(x): return {"value":x}' } });
  const evaluate = wrong => evaluator.evaluate(candidate(wrong), { card: { methodId: 'test-method' } });
  return { root, definition, evaluate, calls: () => calls, setTier: value => { tier = value; }, failReview: () => { reviewFails = true; }, unknownReview: value => { reviewUnknown = value; } };
}

test('measured failed to perfect candidate queues and executes distinct additional hidden review once', async t => {
  const f = await setup(t);
  assert.equal((await f.evaluate(true)).status, 'repair'); assert.equal(f.calls(), 4);
  const result = await f.evaluate(false);
  assert.equal(result.ok, true); assert.equal(result.suddenPerfectReview.triggered, true);
  assert.equal(result.suddenPerfectReview.passed, true); assert.equal(result.suddenPerfectReview.additionalExecutions, 4);
  assert.equal(f.calls(), 12); // Four failed, four routine, FOUR ADDITIONAL review calls.
  const files = await fs.readdir(path.join(f.root, 'paper-gold/sudden-perfect-reviews'));
  assert.equal(files.filter(file => file.endsWith('.queued.json')).length, 1);
  assert.equal(files.filter(file => file.endsWith('.json') && !file.endsWith('.queued.json')).length, 1);
  const repeated = await f.evaluate(false);
  assert.equal(repeated.suddenPerfectReview.resumed, true); assert.equal(f.calls(), 16);
  assert.equal(repeated.suddenPerfectReview.reviewId, result.suddenPerfectReview.reviewId);
  assert.doesNotMatch(JSON.stringify(result.suddenPerfectReview), /numeric|tolerance|publicationId|"input"/);
});

test('unknown exposure does not trigger sudden perfect review', async t => {
  const f = await setup(t); f.setTier('unknown');
  assert.equal((await f.evaluate(true)).ok, false);
  f.setTier('unexposed');
  const good = await f.evaluate(false);
  assert.equal(good.suddenPerfectReview.triggered, false); assert.equal(f.calls(), 8);
  await assert.rejects(fs.access(path.join(f.root, 'paper-gold/sudden-perfect-reviews')), /ENOENT/);
});

test('additional review failure cannot retain candidate promotion or masquerade as ordinary replicate pass', async t => {
  const f = await setup(t); await f.evaluate(true); f.failReview();
  const result = await f.evaluate(false);
  assert.equal(result.assessments.every(row => row.passed), true);
  assert.equal(result.suddenPerfectReview.passed, false);
  assert.equal(result.ok, false); assert.equal(result.verificationLevel, 'V0');
  assert.equal(result.resourceCode, 'sudden_perfect_review_not_passed');
});


test('changed frozen source or evaluator cannot turn incomparable failure into perfect-review trigger', async t => {
  const f = await setup(t); await f.evaluate(true);
  for (const row of f.definition.cases) row.sourceHash = 'b'.repeat(64);
  await fs.writeFile(path.join(f.root, 'paper-gold/candidate-cases/test-method.json'), JSON.stringify(f.definition));
  const result = await f.evaluate(false);
  assert.equal(result.ok, true); assert.equal(result.suddenPerfectReview.triggered, false);
  assert.equal(f.calls(), 8);
});


test('unknown additional execution stays queued and may resume without a false completed review', async t => {
  const f = await setup(t); await f.evaluate(true); f.unknownReview(true);
  const pending = await f.evaluate(false);
  assert.equal(pending.ok, false); assert.equal(pending.status, 'waiting_resource');
  assert.equal(pending.suddenPerfectReview.status, 'pending');
  const dir = path.join(f.root, 'paper-gold/sudden-perfect-reviews');
  assert.equal((await fs.readdir(dir)).filter(file => file.endsWith('.json') && !file.endsWith('.queued.json')).length, 0);
  // Simulate an orphan created by the previous implementation before a SIGKILL/redeploy.
  await fs.writeFile(path.join(dir, `${pending.suddenPerfectReview.reviewId}.lock`), '');
  f.unknownReview(false);
  const completed = await f.evaluate(false);
  assert.equal(completed.ok, true); assert.equal(completed.suddenPerfectReview.passed, true);
  assert.equal(completed.suddenPerfectReview.reviewId, pending.suddenPerfectReview.reviewId);
});
