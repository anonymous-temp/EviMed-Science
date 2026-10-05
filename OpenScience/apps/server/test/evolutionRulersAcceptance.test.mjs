import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { digest } from '../../../evals/paper-gold/evaluator.mjs';
import { planRulers, runRulersAcceptance } from '../../../scripts/ops/evolution-rulers-acceptance.mjs';

test('ruler plan counts three variants and two replicates without model calls', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ruler-plan-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'paper-gold/cycles/acceptance-calibration-meta-v3');
  await fs.mkdir(dir, { recursive: true });
  const definition = { track: 'meta', cases: [{ id: 'a' }, { id: 'b' }], unavailable: [{ id: 'c' }] };
  const frozen = { definition, evaluatorCodeHash: 'fixture', hash: digest({ definition, evaluatorCodeHash: 'fixture' }) };
  await fs.writeFile(path.join(dir, 'definition.json'), JSON.stringify(frozen));
  const phases = await planRulers({ evaluationDataDir: root, tracks: ['meta'] });
  assert.equal(phases.length, 2);
  assert.equal(phases[0].plannedDshRuns, 12);
  assert.equal(phases[0].missing, 1);
  const pilot = await planRulers({ evaluationDataDir: root, tracks: ["meta"], caseIds: ["a"] });
  assert.equal(pilot[0].plannedDshRuns, 6);
  assert.notEqual(pilot[0].cycleId, phases[0].cycleId);
  await assert.rejects(planRulers({ evaluationDataDir: root, tracks: ["meta"], caseIds: ["unknown"] }), /Unknown selected/);
  await fs.writeFile(path.join(dir, 'definition.json'), JSON.stringify({ ...frozen, hash: 'tampered' }));
  await assert.rejects(planRulers({ evaluationDataDir: root, tracks: ['meta'] }), /identity changed/);
});

test('execution uses phase advisory lock, forwards actual observations and ignores an orphan file lock', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ruler-run-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'paper-gold/cycles/acceptance-calibration-meta-v3');
  await fs.mkdir(dir, { recursive: true });
  const definition = { track: 'meta', cases: [{}], unavailable: [] };
  await fs.writeFile(path.join(dir, 'definition.json'), JSON.stringify({ definition, evaluatorCodeHash: 'fixture', hash: digest({ definition, evaluatorCodeHash: 'fixture' }) }));
  const signal = new AbortController().signal;
  const locks = []; let insideLock = false;
  await fs.writeFile(path.join(root, "rulers-acceptance.lock"), "orphan-from-old-process");
  const app = { evolution: { service: { withLock: async (key, operation) => { locks.push(key); insideLock = true; try { return await operation(); } finally { insideLock = false; } } }, paperGold: { prepareBenchmarks: async ({ cycleId }) => {
    const d = path.join(root, 'paper-gold/cycles', cycleId); await fs.mkdir(d, { recursive: true });
    await fs.writeFile(path.join(d, 'definition.json'), JSON.stringify({ hash: 'frozen', definition: { replicates: 2, cases: [{ type: 'research', rewrite: { variants: ['a', 'b', 'c'] }, gold: { inputAvailable: false } }] } }));
  } }, worker: { callbacks: { evaluate: async (payload, context) => {
    assert.equal(context.signal, signal);
    assert.equal(insideLock, true);
    return { id: 'real-ledger', payload: { units: [{ exposureTier: 'unknown', fullResearchReproductionValid: false, applicableStagesValid: false }] } };
  } } } } };
  const rows = await runRulersAcceptance({ app, evaluationDataDir: root, tracks: ['meta'], rulers: ['research'], signal, output: () => {} });
  assert.equal(rows[0].completedUnits, 1);
  assert.equal(rows[0].fullResearchValid, 0);
  assert.equal(rows[0].unknownExposure, 1);
  assert.deepEqual(locks, ['rulers-acceptance:acceptance-research-meta-v1']);
  assert.equal(await fs.readFile(path.join(root, 'rulers-acceptance.lock'), 'utf8'), 'orphan-from-old-process');
  assert.equal(insideLock, false);
});
