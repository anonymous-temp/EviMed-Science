import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createEvolutionCandidateEvaluator } from '../src/evolutionCandidateEvaluator.mjs';
import { pythonExecVerify } from './helpers/pythonExecVerify.mjs';

// When the review triggers. What it then tests (reserved cases and fresh derived inputs, never the same
// evaluation again; "could not be done" when nothing is held out) is in evolutionBehaviouralChecks.test.mjs.
const reference = { implementationId: 'fixture-reference', language: 'python', code: "import json,sys\nprint(json.dumps({'numeric':{'value':2*json.load(sys.stdin)['x']}}))\n" };
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sudden-perfect-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'paper-gold/candidate-cases'); await fs.mkdir(dir, { recursive: true });
  const definition = { methodId: 'test-method', frozen: true, referenceImplementation: reference, cases: [3, 5].map(x => ({ id: `case-${x}`, kind: 'published', hidden: true, independentQa: { passed: true }, sourceHash: 'a'.repeat(64), publicationId: `paper-${x}`, input: { x }, numeric: { value: { value: 2 * x, absoluteTolerance: 0 } } })) };
  await fs.writeFile(path.join(dir, 'test-method.json'), JSON.stringify(definition));
  let tier = 'unexposed';
  const evaluator = createEvolutionCandidateEvaluator({ config: { dataDir: root, evaluationDataDir: root }, auditCandidateExposure: async () => ({ tier }), controller: { execVerify: pythonExecVerify() } });
  const candidate = wrong => ({ id: wrong ? 'bad-candidate' : 'good-candidate', entrypoint: 'scripts/estimate.py:estimate', files: { 'scripts/estimate.py': `def estimate(x):\n    return {"value": ${wrong ? 3 : 2} * x}\n` } });
  return { root, definition, evaluate: wrong => evaluator.evaluate(candidate(wrong), { card: { methodId: 'test-method' } }), setTier: value => { tier = value; } };
}

test('a measured failure followed by a perfect score triggers exactly one sealed review', async t => {
  const f = await setup(t);
  assert.equal((await f.evaluate(true)).status, 'repair');
  const result = await f.evaluate(false);
  assert.equal(result.ok, true); assert.equal(result.suddenPerfectReview.triggered, true);
  assert.equal(result.suddenPerfectReview.passed, true);
  assert.ok(result.suddenPerfectReview.heldOut.freshCases >= 6);
  const files = await fs.readdir(path.join(f.root, 'paper-gold/sudden-perfect-reviews'));
  assert.equal(files.filter(file => file.endsWith('.queued.json')).length, 1);
  assert.equal(files.filter(file => file.endsWith('.json') && !file.endsWith('.queued.json')).length, 1);
});

test('a first-time perfect candidate with no measured failure before it is not reviewed', async t => {
  const f = await setup(t);
  const good = await f.evaluate(false);
  assert.equal(good.ok, true); assert.equal(good.suddenPerfectReview.triggered, false);
  assert.equal(good.suddenPerfectReview.reason, 'no_comparable_measured_failure');
});

test('unknown exposure does not trigger sudden perfect review', async t => {
  const f = await setup(t); f.setTier('unknown');
  assert.equal((await f.evaluate(true)).ok, false);
  f.setTier('unexposed');
  const good = await f.evaluate(false);
  assert.equal(good.suddenPerfectReview.triggered, false);
  await assert.rejects(fs.access(path.join(f.root, 'paper-gold/sudden-perfect-reviews')), /ENOENT/);
});

test('changed frozen source or evaluator cannot turn incomparable failure into perfect-review trigger', async t => {
  const f = await setup(t); await f.evaluate(true);
  for (const row of f.definition.cases) row.sourceHash = 'b'.repeat(64);
  await fs.writeFile(path.join(f.root, 'paper-gold/candidate-cases/test-method.json'), JSON.stringify(f.definition));
  const result = await f.evaluate(false);
  assert.equal(result.ok, true); assert.equal(result.suddenPerfectReview.triggered, false);
});
