import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGraphs } from '../synthetic/toolverse/graph.mjs';
import { materialize, simulate, sameToolArgs } from '../synthetic/toolverse/env.mjs';
import { makeRng } from '../synthetic/toolverse/rng.mjs';
import { scoreTrajectory } from '../synthetic/toolverse/score.mjs';
const graphs = loadGraphs();
function task(graph, names) { for (let i = 0; i < 300; i++) { const t = materialize(graph, names, makeRng('consistency-' + i)); if (t) return t; } throw Error('fixture_failed'); }
test('normalisation preserves the drug; list/read/stat use one directory and file object', () => {
  for (const name of ['term_normalize', 'drug_term_normalize']) {
    const t = task(graphs.evimed, [name]); assert.equal(t.steps[0].output.canonicalName, t.steps[0].args.term);
  }
  const t = task(graphs.general, ['list_directory', 'read_file', 'file_stat']);
  assert.ok(t.steps[0].output.firstFile.startsWith(t.steps[0].args.dir + '/'));
  assert.equal(t.steps[2].output.size, Buffer.byteLength(t.steps[1].output.content));
  assert.equal(simulate(t, { tool: 'read_file', args: { path: './' + t.steps[1].args.path } }).ok, true);
  assert.equal(simulate(t, { tool: 'read_file', args: { path: '../other.txt' } }).ok, false);
});
test('semantic argument equality preserves quantities and identity, with computed verification calls', () => {
  assert.ok(sameToolArgs('convert_length', { value: 1, from: 'metres', to: 'centimeters' }, { value: '1.0', from: 'm', to: 'cm' }));
  assert.equal(sameToolArgs('convert_length', { value: 2, from: 'm', to: 'cm' }, { value: 1, from: 'm', to: 'cm' }), false);
  const t = task(graphs.general, ['convert_length']);
  const verification = simulate(t, { tool: 'convert_length', args: { value: 2, from: 'm', to: 'cm' } });
  assert.equal(verification.output.converted, 200);
});
test('verification after completion does not erase final success; wrong final task remains wrong', () => {
  const gold = [{ tool: 'convert_length', args: { value: 1, from: 'm', to: 'cm' } }, { tool: 'write_file', args: { path: 'a.txt', content: '100' } }];
  const got = [...gold, gold[0]];
  const s = scoreTrajectory(gold, got);
  assert.equal(s.finalTaskCorrect, true); assert.equal(s.prescribedPathFollowed, true); assert.equal(s.extraCalls, 1); assert.equal(s.legacyStrictPass, false);
  assert.equal(scoreTrajectory(gold, [gold[0], { tool: 'write_file', args: { path: 'a.txt', content: 'wrong' } }]).finalTaskCorrect, false);
});
test('an inverse conversion used for verification does not erase the requested computation', () => {
  const gold = [{ tool: 'convert_length', args: { value: 1, from: 'm', to: 'cm' } }];
  const calls = [...gold, { tool: 'convert_length', args: { value: 100, from: 'cm', to: 'm' } }];
  assert.equal(scoreTrajectory(gold, calls).finalTaskCorrect, true);
  assert.equal(scoreTrajectory(gold, calls).extraCalls, 1);
  assert.equal(sameToolArgs('convert_length', gold[0].args, { value: 100, from: 'cm', to: 'cm' }), true);
});
