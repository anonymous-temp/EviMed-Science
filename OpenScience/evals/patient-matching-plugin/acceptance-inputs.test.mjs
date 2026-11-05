import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runAcceptance } from './acceptance-host.mjs';
import { acceptanceSourceIdentity, acceptanceReasoningProfileDigest, acceptanceScope, assertAcceptanceSavedIdentity, assertAcceptancePreparedProfile, verifyAcceptanceSources } from './acceptance-source.mjs';
import { exportAcceptance } from './acceptance-export.mjs';
import { contentDigest } from '../../packages/patient-matching-core/index.mjs';
import { acceptanceStep, annotationMapping, assertAcceptanceCase, incidentInputs, incidentFindings, projectAcceptance, sixLabel } from './acceptance-inputs.mjs';

test('frozen incidents expose only original note and trial selection, never expectations or feedback', async () => {
  const fixtures = JSON.parse(await fs.readFile(new URL('../vcr-matching-boards/incidents.json', import.meta.url), 'utf8'));
  const rows = incidentInputs(fixtures);
  assert.equal(rows.length, 17);
  assert.deepEqual(rows.map(row => row.note), fixtures.map(row => row.note));
  for (const key of ['expect', 'expected', 'gold', 'expert', 'gpt4', 'source', 'trial']) {
    assert.ok(rows.every(row => !(key in row)));
    assert.throws(() => assertAcceptanceCase({ ...rows[0], [key]: 'do not expose' }));
  }
});
test('user-skipped execution refuses before credentials, database, runtime or provider access', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-stop-test-'));
  try {
    const configPath = path.join(temporary, 'config.json');
    await fs.writeFile(configPath, JSON.stringify({ executionStatus: 'user-skipped' }));
    await assert.rejects(runAcceptance({ configPath }), /owner stopped evaluation/);
    assert.deepEqual(await fs.readdir(temporary), ['config.json']);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});
test('changing harness, corpus or medical source changes the saved-state identity', () => {
  const base = { artifactSha256: 'artifact', definition: { collectionDigest: 'corpus' }, sourceIdentity: 'medical-source', harnessSourcesDigest: 'harness' };
  const identity = acceptanceSourceIdentity(base);
  for (const change of [{ harnessSourcesDigest: 'changed' }, { sourceIdentity: 'changed' }, { definition: { collectionDigest: 'changed' } }]) {
    assert.notEqual(acceptanceSourceIdentity({ ...base, ...change }), identity);
  }
});
test('the shared execution/export verifier refuses changed harness, database bytes and original protocol', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-frozen-source-'));
  const save = async (name, bytes) => { const filename = path.join(temporary, name); await fs.writeFile(filename, bytes); return filename; };
  try {
    const artifact = await save('plugin.tgz', 'synthetic artifact fixture'), harness = await save('handler.mjs', 'original harness'), database = await save('source.sqlite', 'original source bytes');
    const protocolPath = await save('protocol.txt', 'original guide protocol'), cases = await save('cases.jsonl', 'source-only fixture\n');
    const collection = await save('collection.json', JSON.stringify({ databasePath: 'source.sqlite', databaseSha256: contentDigest('original source bytes').slice(7) }));
    const harnessSources = await save('harness.json', JSON.stringify({ [harness]: contentDigest('original harness') }));
    const config = { artifact, artifactSha256: contentDigest(await fs.readFile(artifact)).slice(7), harnessSources,
      harnessSourcesDigest: contentDigest(await fs.readFile(harnessSources)), boards: { n2c2: { cases, casesDigest: contentDigest(await fs.readFile(cases)), collection,
        collectionDigest: contentDigest(await fs.readFile(collection)), protocolPath, protocolDigest: contentDigest(await fs.readFile(protocolPath)) } } };
    assert.equal(await verifyAcceptanceSources(config), null);
    for (const filename of [harness, database, protocolPath]) {
      const bytes = await fs.readFile(filename); await fs.appendFile(filename, ' changed');
      await assert.rejects(verifyAcceptanceSources(config)); await fs.writeFile(filename, bytes);
    }
    assert.equal(await verifyAcceptanceSources(config), null);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});
test('user-skipped export cannot manufacture a 0/17 incident result or missing-label benchmark', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'acceptance-export-stop-'));
  try {
    const configPath = path.join(temporary, 'config.json'), out = path.join(temporary, 'export');
    await fs.writeFile(configPath, JSON.stringify({ executionStatus: 'user-skipped' }));
    await assert.rejects(exportAcceptance({ configPath, out }), /no judgments or pass metrics/);
    assert.deepEqual(await fs.readdir(temporary), ['config.json']);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});
test('annotations keep zero-based per-kind numbering and map only unique literal source clauses', () => {
  const clauses = [{ annotationId: 1, kind: 'inclusion', number: 0, text: 'Age at least 18' },
    { annotationId: 2, kind: 'exclusion', number: 0, text: 'Pregnancy' }, { annotationId: 3, kind: 'inclusion', number: 1, text: null }];
  const profile = { criteria: [{ criterionId: 'a', kind: 'inclusion', text: 'Age  at least 18' }, { criterionId: 'b', kind: 'exclusion', text: 'Pregnancy' }] };
  const mapped = annotationMapping(clauses, profile);
  assert.deepEqual(mapped.map(row => [row.number, row.backendNumber, row.nativePositionOneBased, row.criterionId]), [[0, 1, 1, 'a'], [0, 1, 2, 'b'], [1, null, null, null]]);
  assert.equal(annotationMapping([clauses[0]], { criteria: [profile.criteria[0], profile.criteria[0]] })[0].state, 'ambiguous');
  assert.equal(annotationMapping([{ ...clauses[0], text: 'adult' }], profile)[0].state, 'unmapped');
});
test('six labels preserve exclusion polarity and uncertainty', () => {
  for (const [kind, verdict, expected] of [['inclusion', 'satisfied', 'included'], ['inclusion', 'not-satisfied', 'not included'],
    ['exclusion', 'satisfied', 'excluded'], ['exclusion', 'not-satisfied', 'not excluded'], ['inclusion', 'unknown', 'not enough information'], ['exclusion', 'not-applicable', 'not applicable']]) {
    assert.equal(sixLabel({ kind, verdict }), expected);
  }
});
test('one failed native segment ends the case; remaining successful frozen pairs may continue', () => {
  const state = { context: { taskId: 't', subjectKey: 'p' }, discovery: { searchId: 's' }, nativeSegments: 1, lastSavedSegment: 0 };
  assert.deepEqual(acceptanceStep(state), {}); assert.equal(state.stopReason, 'native_assessment_no_saved_progress');
  const remaining = { ...state, stopReason: null, lastSavedSegment: 1, result: { rows: [{ current: false }] } };
  assert.equal(acceptanceStep(remaining).tool, 'match_assess');
});
test('licensed n2c2 follows the native original-protocol intake without a registry surrogate', () => {
  const source = assertAcceptanceCase({ caseId: 'test-1', patientId: 'n2c2-1', cohort: 'n2c2', collection: 'unused', split: 'test-replay',
    note: 'Record date: 2090-01-01\nOriginal deidentified note.', candidateIds: [], candidateCount: 1, dataClass: 'deidentified-clinical' });
  assert.equal(source.dataClass, 'deidentified-clinical');
  const state = { board: 'n2c2', protocolText: 'Inclusion Criteria:\n* Patient must speak English', context: { subjectKey: 'p', taskId: 'patient-task' }, nativeSegments: 0 };
  assert.deepEqual(acceptanceStep(state).args, { messageSeq: 2, protocolText: state.protocolText, title: 'n2c2 2018 Track 1 cohort-selection annotation guide' });
  assert.deepEqual(acceptanceStep({ ...state, protocol: { taskId: 'protocol-task' } }).args, { taskId: 'protocol-task', subjectKey: 'p' });
});
test('projection uses actual native criterion IDs and preserves missing annotated rows', async () => {
  const result = JSON.parse(await fs.readFile(new URL('../../../docs/superpowers/plans/2026-11-05-vcr-matching-plugin-v3-assets/native-clinical-result.json', import.meta.url), 'utf8'));
  const row = result.rows[0], profile = { trialId: row.trialId, criteria: row.criteria.map((item, index) => ({ criterionId: item.criterionId, kind: item.kind, text: index ? 'BMI < 25' : 'Age >= 18' })) };
  const projected = projectAcceptance({ patientId: 'p', result, profiles: [profile], requestedTrials: [{ registryId: 'NCT00000001', trialId: row.trialId,
    clauses: [{ annotationId: 1, kind: 'inclusion', number: 0, text: 'Age >= 18' }, { annotationId: 2, kind: 'inclusion', number: 1, text: 'Unmapped source clause' }] }] });
  assert.equal(projected.judgment.ranking[0].criteria.length, 1);
  assert.equal(projected.judgment.ranking[0].criteria[0].label, 'included');
  assert.equal(projected.mappings[1].state, 'unmapped');
  assert.equal(projected.judgment.ranking[0].fit, null);
  assert.deepEqual(incidentFindings({ fit: { max: 49 } }, projected.judgment.ranking[0]), ['recommendation_above_maximum_or_unset']);
});
test('the published native saved result passes the real export identity contract; unrelated scope or profile refuses', async () => {
  const result = JSON.parse(await fs.readFile(new URL('../../../docs/superpowers/plans/2026-11-05-vcr-matching-plugin-v3-assets/native-clinical-result.json', import.meta.url), 'utf8'));
  const one = { patientId: 'public-case', candidateCount: 1, candidateIds: [result.rows[0].trialId] }, config = { artifactSha256: 'qualified-test-artifact', harnessSourcesDigest: 'frozen-harness', sessionNamespace: 'test' }, definition = { casesDigest: 'source-inputs' };
  const sessionId = 'campaign-test-public-case';
  result.pluginGeneration = `campaign-${config.artifactSha256}`; result.scope = acceptanceScope(sessionId);
  // The public producer's actual digest is the HostAdapter's nested modelProfile + reasoning contract.
  assert.equal(result.profileDigest, acceptanceReasoningProfileDigest());
  const state = { result, artifactSha256: config.artifactSha256, sessionId, inputDigest: contentDigest(JSON.stringify(one)),
    context: { taskId: result.taskId, subjectKey: result.rows[0].subjectKey },
    sourceModelIdentity: acceptanceSourceIdentity({ ...config, definition, sourceIdentity: null }) };
  assertAcceptanceSavedIdentity({ state, one, config, definition, sourceIdentity: null });
  const otherProfile = structuredClone(state); otherProfile.result.profileDigest = contentDigest('another profile');
  assert.throws(() => assertAcceptanceSavedIdentity({ state: otherProfile, one, config, definition, sourceIdentity: null }));
  const otherScope = structuredClone(state); otherScope.result.scope.conversationId = 'another-session';
  assert.throws(() => assertAcceptanceSavedIdentity({ state: otherScope, one, config, definition, sourceIdentity: null }));
});
test('prepared source verification retains valid siblings when a pending placeholder has no source refs', async () => {
  const result = JSON.parse(await fs.readFile(new URL('../../../docs/superpowers/plans/2026-11-05-vcr-matching-plugin-v3-assets/native-clinical-result.json', import.meta.url), 'utf8'));
  const saved = result.rows[0], text = 'Age at least 18 years.';
  const source = { ...saved.sourceRefs.find(row => row.kind === 'protocol'), digest: contentDigest(text) };
  saved.sourceRefs = saved.sourceRefs.map(row => row.kind === 'protocol' ? source : row);
  const profile = { schemaVersion: '1', scope: result.scope, trialId: saved.trialId, source, profileDigest: contentDigest('profile'), preservedText: text,
    criteria: [{ criterionId: saved.criteria[0].criterionId, kind: 'inclusion', text, span: { start: 0, end: text.length } }], arms: [] };
  result.rows.push({ trialId: saved.trialId, state: 'pending', current: false, sourceRefs: [] });
  assertAcceptancePreparedProfile(profile, result);
  saved.sourceRefs = [];
  assert.throws(() => assertAcceptancePreparedProfile(profile, result), /another trial source/);
});
