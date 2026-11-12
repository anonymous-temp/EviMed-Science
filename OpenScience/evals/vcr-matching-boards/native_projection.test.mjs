import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { contentDigest, profileIdentity, projectMatchingResult, validateMatchingResult } from '../../packages/patient-matching-core/index.mjs';
import { exportNativeResults, nativeMappingDigest, main } from './native_projection.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicFixture = new URL('../../../docs/superpowers/plans/2026-11-05-vcr-matching-plugin-v3-assets/native-clinical-result.json', import.meta.url);
const nct = (n) => `NCT${String(n).padStart(8, '0')}`;
const clone = (value) => structuredClone(value);
const readFixture = () => JSON.parse(fs.readFileSync(publicFixture, 'utf8'));
const sha = contentDigest('synthetic frozen benchmark identity');

function fixture({ partial = false, missing = false, board = 'sigir' } = {}) {
  const original = readFixture();
  validateMatchingResult(original);
  const base = original.rows[0];
  const pairs = [1, 2, 3].map((n) => ({ subjectKey: base.subjectKey, trialId: nct(n) }));
  const decisions = pairs.flatMap((pair, index) => {
    if (partial && index === 1) return [];
    const { state:_state, clinicalEligibility, recommendation, decisionRevision, ...row } = base;
    return [{ ...row, ...pair, schemaVersion: '1', scope: original.scope, revision: decisionRevision,
      decisionId: `synthetic-decision-${index}`, state: 'complete', clinicalEligibility: index === 2 ? 'ineligible' : clinicalEligibility,
      recommendation: { ...recommendation, priority: index === 2 ? 1 : 0.1 } }];
  });
  const result = projectMatchingResult({ task: { schemaVersion: '1', taskId: original.taskId, direction: 'patient-to-trials', objective: 'Synthetic export contract check',
    scope: original.scope, pluginGeneration: original.pluginGeneration, sources: original.frozenSources, selectedPairs: pairs,
    budgets: { maxPairs: 3, maxEvidenceReads: 0, maxModelCalls: 0 } }, resultId: original.resultId, revision: original.revision,
    decisions, profileDigest: original.profileDigest });
  validateMatchingResult(result);
  const patientId = board === 'sigir' ? 'sigir-synthetic' : 'trec-20211';
  const cases = [{ patientId, cohort: board === 'sigir' ? 'sigir' : 'trec_2021', candidateIds: [nct(3), nct(1), nct(2)], candidateCount: 3 }];
  const binding = { patientId, scope: clone(result.scope), subjectKey: base.subjectKey, resultId: result.resultId, revision: result.revision,
    pairs: pairs.map((pair) => ({ trialId: pair.trialId, registryId: pair.trialId })) };
  const configuration = { schemaVersion: '1', board, language: 'en', casesDigest: profileIdentity(cases),
    plugin: { generation: result.pluginGeneration, profileDigest: result.profileDigest, artifactDigest: sha }, bindings: [binding],
    metricProfile: { id: board === 'sigir' ? 'trialgpt-judged-pair-ranking' : 'trec-full-corpus', revision: 'frozen-v1',
      scorer: { id: board === 'sigir' ? 'trialgpt-official' : 'trec-official', version: 'frozen', digest: sha },
      inputManifestDigest: sha, corpusDigest: sha, aggregation: board === 'sigir' ? 'official-profile' : 'per-year-official-profile', mappingPolicyDigest: sha } };
  if (missing) {
    cases.push({ ...clone(cases[0]), patientId: board === 'sigir' ? 'sigir-missing' : 'trec-20212' });
    configuration.bindings.push({ ...clone(binding), patientId: cases[1].patientId, subjectKey: 'missing-subject', resultId: null, revision: null });
    configuration.casesDigest = profileIdentity(cases);
  }
  configuration.metricProfile.mappingPolicyDigest = nativeMappingDigest(configuration);
  return { cases, results: [result], configuration };
}

test('a published native clinical saved result is validated and exported without reassessment', () => {
  const input = fixture();
  const original = readFixture();
  input.results = [original];
  input.cases[0].candidateIds = [nct(1)]; input.cases[0].candidateCount = 1;
  input.configuration.bindings[0].pairs = [{ trialId: original.rows[0].trialId, registryId: nct(1) }];
  input.configuration.casesDigest = profileIdentity(input.cases);
  input.configuration.metricProfile.mappingPolicyDigest = nativeMappingDigest(input.configuration);
  const before = clone(input);
  const output = exportNativeResults(input);
  assert.deepEqual(input, before);
  assert.equal(output.records[0].ranking[0].fit, null);
  assert.equal(output.records[0].ranking[0].confidence, null);
  assert.equal(output.records[0].ranking[0].verdict, 'eligible');
  assert.equal(output.records[0].ranking[0].native.pairIdentity, original.finalOrder[0]);
  assert.deepEqual(output.receipt.results[0].finalOrder, original.finalOrder);
  assert.deepEqual(output.receipt.results[0].frozenSources, original.frozenSources);
  assert.equal(output.receipt.results[0].artifactDigest, profileIdentity(original));
  assert.deepEqual(output.receipt.metricProfile, input.configuration.metricProfile);
  assert.deepEqual(output.receipt.plugin, input.configuration.plugin);
});

test('saved finalOrder wins over priority, input order and judged-only condensation', () => {
  const input = fixture({ partial: true, missing: true });
  const output = exportNativeResults(input);
  assert.deepEqual(output.records[0].ranking.map((row) => row.registryId), input.results[0].rows.map((row) => row.trialId));
  assert.deepEqual(output.records[0].ranking.map((row) => row.rank), [1, 2, 3]);
  assert.deepEqual(output.records[0].ranking.map((row) => row.native.state), ['complete', 'pending', 'complete']);
  assert.deepEqual(output.records[0].failed, [{ registryId: nct(2), code: 'native_pending' }]);
  assert.equal(output.records[0].ranking[1].fit, null);
  assert.equal(output.records[0].ranking[2].verdict, 'ineligible');
  assert.equal(output.records[0].status, 'partial');
  assert.equal(output.records[1].status, 'missing');
  assert.deepEqual(output.records[1].ranking, []);
  assert.equal(output.records[1].failed.length, 3);
  assert.deepEqual(output.receipt.counts, { patientsRequested: 2, patientsWithResult: 1, patientsComplete: 0, pairsRequested: 6, pairsSaved: 3, pairsCurrent: 2,
    stateCounts: { complete: 2, pending: 1, failed: 0, unsupported: 0, stale: 0, missing: 3 } });
});

test('failed, unsupported and stale native rows keep their original identity and work state', () => {
  const input = fixture();
  const template = input.results[0];
  const decisions = template.rows.map((row, index) => ({ ...row, schemaVersion: '1', scope: template.scope, revision: row.decisionRevision,
    state: index === 0 ? 'failed' : index === 1 ? 'unsupported' : 'complete', clinicalEligibility: index < 2 ? 'not-assessed' : 'ineligible' }));
  input.results[0] = projectMatchingResult({ task: { schemaVersion: '1', taskId: template.taskId, direction: template.direction, objective: 'State accounting fixture',
    scope: template.scope, pluginGeneration: template.pluginGeneration, sources: template.frozenSources, selectedPairs: template.selectedPairs,
    budgets: { maxPairs: 3, maxEvidenceReads: 0, maxModelCalls: 0 } }, resultId: template.resultId, revision: template.revision, profileDigest: template.profileDigest,
    currentSources: template.currentSources.map((source) => ({ ...source, revision: 'changed' })), decisions });
  validateMatchingResult(input.results[0]);
  const output = exportNativeResults(input);
  assert.deepEqual(output.records[0].ranking.map((row) => row.native.state), ['failed', 'unsupported', 'stale']);
  assert.ok(output.records[0].ranking.every((row) => row.fit === null && row.verdict === null));
  assert.deepEqual(output.records[0].failed.map((row) => row.code), ['native_failed', 'native_unsupported', 'native_stale']);
  assert.deepEqual(output.records[0].ranking[2].native.staleReasons, input.results[0].rows[2].staleReasons);
});

test('frozen mappings reject wrong scope, pairs, result revision, plugin or metric profile', () => {
  const mutations = [
    (v) => { v.configuration.board = 'sigir-zh'; },
    (v) => { v.configuration.language = 'zh'; },
    (v) => { v.configuration.metricProfile.id = 'trec-full-corpus'; },
    (v) => { v.configuration.metricProfile.scorer.digest = 'not-a-digest'; },
    (v) => { v.cases[0].language = 'zh-Hans'; v.configuration.casesDigest = profileIdentity(v.cases); },
    (v) => { v.cases[0].translatedFrom = sha; v.configuration.casesDigest = profileIdentity(v.cases); },
    (v) => { v.configuration.bindings[0].scope.actorId = 'another-actor'; },
    (v) => { v.configuration.bindings[0].subjectKey = 'another-subject'; },
    (v) => { v.configuration.bindings[0].revision = 'other-revision'; },
    (v) => { v.configuration.bindings[0].pairs[0].registryId = nct(9); },
    (v) => { v.configuration.bindings[0].pairs[1].registryId = nct(1); },
    (v) => { v.configuration.bindings[0].pairs.pop(); },
    (v) => { v.configuration.bindings[0].pairs[0].armId = 'unknown-arm'; },
    (v) => { v.configuration.plugin.generation = 'other-generation'; },
    (v) => { v.configuration.plugin.profileDigest = contentDigest('other-profile'); },
    (v) => { v.cases[0].candidateIds.push(nct(9)); },
    (v) => { v.cases.push(clone(v.cases[0])); },
    (v) => { v.results.push(clone(v.results[0])); },
    (v) => { v.results[0].finalOrder.reverse(); },
    (v) => { v.results[0].counts.complete = 99; },
  ];
  for (const mutate of mutations) {
    const input = fixture(); mutate(input);
    input.configuration.metricProfile.mappingPolicyDigest = nativeMappingDigest(input.configuration);
    assert.throws(() => exportNativeResults(input), undefined, mutate.toString());
  }
  const wrongMapping = fixture(); wrongMapping.configuration.metricProfile.mappingPolicyDigest = sha;
  assert.throws(() => exportNativeResults(wrongMapping));
  const unbound = fixture(); unbound.configuration.bindings = [];
  unbound.configuration.metricProfile.mappingPolicyDigest = nativeMappingDigest(unbound.configuration);
  assert.throws(() => exportNativeResults(unbound));
});

test('full TREC accepts only its own profile and retains missing topics as empty output rows', () => {
  const input = fixture({ board: 'trec2021', missing: true });
  const output = exportNativeResults(input);
  assert.equal(output.receipt.metricProfile.id, 'trec-full-corpus');
  assert.deepEqual(output.records.map((row) => row.patientId), ['trec-20211', 'trec-20212']);
  assert.deepEqual(output.records[1].ranking, []);
  input.configuration.metricProfile.id = 'trialgpt-judged-pair-ranking';
  assert.throws(() => exportNativeResults(input));
});

test('an entirely missing campaign still emits every requested topic and pair failure', () => {
  const input = fixture({ missing: true });
  input.results = [];
  for (const binding of input.configuration.bindings) { binding.resultId = null; binding.revision = null; }
  input.configuration.metricProfile.mappingPolicyDigest = nativeMappingDigest(input.configuration);
  const output = exportNativeResults(input);
  assert.equal(output.records.length, 2);
  assert.ok(output.records.every((row) => row.status === 'missing' && row.ranking.length === 0 && row.failed.length === 3));
  assert.equal(output.receipt.counts.pairsRequested, 6);
  assert.equal(output.receipt.counts.stateCounts.missing, 6);
  assert.equal(output.receipt.counts.patientsWithResult, 0);
});

test('the unchanged full-TREC scorer retains an exported missing scorable topic in its denominator', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-trec-score-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = fixture({ board: 'trec2021', missing: true });
  const judgments = path.join(dir, 'judgments.jsonl');
  fs.writeFileSync(judgments, exportNativeResults(input).records.map(JSON.stringify).join('\n') + '\n');
  // Synthetic qrels are supplied only inside this scorer integration test, never to the adapter.
  const script = `import argparse, sys
sys.path.insert(0, sys.argv[1])
import score_e
score_e.load_qrels_dir = lambda directory, years: {2021: {1: {"NCT00000001": 2}, 2: {"NCT00000001": 2}}}
report = score_e.score_end2end(argparse.Namespace(judgments=["2021=" + sys.argv[2]], qrels_dir="unused", retrieved=None, resamples=10, seed=1, trec_eval=None))
assert report["summary"]["topics"] == 2
missing = next(row for row in report["rows"] if row["topic"] == "trec-20212")
assert missing["listed"] == 0 and missing["p10"] == 0 and missing["ndcg10"] == 0
`;
  const scored = spawnSync('python3', ['-I', '-B', '-c', script, here, judgments], { encoding: 'utf8' });
  assert.equal(scored.status, 0, scored.stderr);
});

test('CLI freezes input byte digests and existing official converter preserves the exported native order', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-projection-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = fixture({ partial: true, missing: true });
  const cases = path.join(dir, 'cases.jsonl'), results = path.join(dir, 'saved.jsonl'), profile = path.join(dir, 'profile.json'), out = path.join(dir, 'export');
  fs.writeFileSync(cases, input.cases.map(JSON.stringify).join('\n') + '\n');
  fs.writeFileSync(results, input.results.map(JSON.stringify).join('\n') + '\n');
  fs.writeFileSync(profile, JSON.stringify(input.configuration));
  const messages = [];
  assert.equal(await main(['--cases', cases, '--results', results, '--profile', profile, '--out', out], { log: (line) => messages.push(line) }), 0);
  const receipt = JSON.parse(fs.readFileSync(path.join(out, 'receipt.json'), 'utf8'));
  assert.equal(receipt.inputs.results.digest, contentDigest(fs.readFileSync(results)));
  assert.equal(receipt.inputs.profile.digest, contentDigest(fs.readFileSync(profile)));
  const judgments = path.join(out, 'judgments.jsonl');
  assert.equal(receipt.output.digest, contentDigest(fs.readFileSync(judgments)));
  const conversion = spawnSync('python3', ['-I', '-B', path.join(here, 'to_official.py'), '--cases', cases, '--judgments', judgments, '--out', path.join(dir, 'official')], { encoding: 'utf8' });
  assert.equal(conversion.status, 0, conversion.stderr);
  const converted = JSON.parse(fs.readFileSync(path.join(dir, 'official', 'full_email_sigir-synthetic.json'), 'utf8'));
  assert.deepEqual(converted.cover_page_list.map((row) => row.trial_id), input.results[0].rows.map((row) => row.trialId));
  const missing = JSON.parse(fs.readFileSync(path.join(dir, 'official', 'full_email_sigir-missing.json'), 'utf8'));
  assert.equal(missing.cover_page_list.length, 3);
  assert.ok(missing.cover_page_list.every((row) => !row.judged && row.failure_code === 'native_missing_result'));
  assert.equal(await main(['--cases', cases, '--results', results, '--profile', profile, '--out', out], { log: () => {} }), 1);
  assert.equal(await main(['--help'], { log: () => {} }), 0);
  assert.equal(await main([], { log: () => {} }), 1);
  assert.equal(await main(['--labels', '/unused'], { log: () => {} }), 1);
  const cli = spawnSync(process.execPath, [path.join(here, 'native_projection.mjs'), '--help'], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.ok(messages.length > 0);
});
