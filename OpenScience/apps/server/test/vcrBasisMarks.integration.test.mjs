// Per-source reprocessing (2026-10-10; OpenMed review E-13): when a document, a reviewed text or a permission changes, the facts and
// assessments derived from it are marked, the matching page says 依据已更新 beside them and offers the evaluation that already
// exists, and nothing is blocked and nothing runs by itself.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { composeVcr, vcrMatchingExecutor } from '../src/vcrComposition.mjs';
import { projectionHash } from '../src/vcrCloudProjection.mjs';
import { vcrRuntimeWrite } from '../src/vcrGateway.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
import { streamOf } from './helpers/vcrIntakeData.mjs';

const options = { skip: !process.env.OPEN_SCIENCE_TEST_POSTGRES_URL && 'An isolated test PostgreSQL is required' };
const origin = 'https://api.example.org';
let database, isolated, directory, vcr;
before(async () => {
  if (options.skip) return;
  isolated = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, 'vcrmarks');
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000 });
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vcr-marks-'));
  vcr = composeVcr({ config: { vcrEnabled: true, vcrAudience: 'all', vcrDataPlaneDir: directory, deepseekBaseUrl: origin, vcrProviderAgreements: true }, productDatabase: database });
  await vcr.store.ready();
});
after(async () => { await database?.close(); await isolated?.drop(); if (directory) await fs.rm(directory, { recursive: true, force: true }); });

const write = (target, what, items) => vcrRuntimeWrite({ study: target, store: vcr.store, service: vcr.service, what, items, documents: vcr.documents,
  matching: vcr.matching, matchStore: vcr.matchStore, orchestrator: null, report: () => {} });
const CHART_A = '患者甲，年龄 62 岁。';
const CHART_B = '患者乙，年龄 44 岁。';
const criteria = [{ kind: 'inclusion', criterionType: 'demographic', sourceText: 'Age >= 18', requirement: { op: 'compare', variable: 'age', comparator: 'gte', value: 18 } }];

/** Two subjects, each with a record, a fact, and an assessment made from them. */
async function fixture() {
  const target = await vcr.store.createStudy({ userId: 'owner', projectId: `prj_${Math.random().toString(16).slice(2)}`, name: 'Synthetic marks test', question: 'q', dataTier: 'T0' });
  const source = await vcr.dataPlane.registerSource({ userId: 'owner', studyId: target.id, name: 'Synthetic notes' });
  const upload = async (text, subject) => (await vcr.dataPlane.storeUpload({ actor: 'owner', studyId: target.id, sourceId: source.id, name: 'note.txt', role: 'document', subject, stream: streamOf(text) })).file;
  const docA = await upload(CHART_A, 'MARKS-A'), docB = await upload(CHART_B, 'MARKS-B');
  const a = docA.detail.subjectKey, b = docB.detail.subjectKey;
  target.cloudContext = { runId: 'run_marks', sessionId: 'session_marks' };
  for (const [subjectKey, doc, quote, value] of [[a, docA, '年龄 62 岁', 62], [b, docB, '年龄 44 岁', 44]]) {
    await vcr.documents.subjectDocuments(target, { subjectKey, documentId: doc.id });
    const saved = await write(target, 'fact', [{ subjectKey, variable: 'age', value, unit: 'year', documentId: doc.id, quote, surface: String(value) }]);
    assert.equal(saved.ids.length, 1, JSON.stringify(saved.issues));
  }
  await write(target, 'criteria', [{ criteria }]);
  const evaluate = async id => {
    const built = await vcr.matching.matchScenario(target);
    const job = { id, studyId: target.id, kind: 'match_criteria', scenario: built.scenario, inputs: built.inputs, scenarioHash: 'c'.repeat(64), seed: 1 };
    const result = await vcrMatchingExecutor({ matchStore: vcr.matchStore, store: vcr.store, documents: vcr.documents })({ job, onProgress: async () => {} });
    await vcr.matching.onJobFinished({ action: 'finished', state: 'succeeded', job: { id, studyId: target.id, kind: 'match_criteria', state: 'succeeded' }, engineResult: result });
  };
  await evaluate('job_marks_1');
  return { target, source, docA, docB, a, b, evaluate };
}
const marksOf = async (target, kind) => Object.fromEntries((await vcr.store.rows('SELECT subject_key, cause FROM evimed_vcr.derived_marks WHERE study_id=$1 AND kind=$2 ORDER BY subject_key', [target.id, kind])).map(row => [row.subject_key, row.cause]));
const jobCount = async target => Number((await vcr.store.one('SELECT count(*)::int AS n FROM evimed_vcr.jobs WHERE study_id=$1', [target.id])).n);

test('a permission that changes marks what was read from its source, the page says 依据已更新 and offers the evaluation, and nothing runs', options, async () => {
  const f = await fixture();
  const { target, source, a, b } = f;
  assert.deepEqual(await marksOf(target, 'assessment'), {}, 'a fresh evaluation rests on the basis it has');
  const jobs = await jobCount(target);
  await vcr.dataPlane.setCloudPermission({ studyId: target.id, sourceId: source.id, actor: 'owner', permission: { status: 'revoked' } });
  assert.deepEqual(await marksOf(target, 'fact'), { [a]: 'permission', [b]: 'permission' });
  assert.deepEqual(await marksOf(target, 'assessment'), { [a]: 'permission', [b]: 'permission' });
  const tab = await vcr.service.tab({ id: 'owner' }, target.id, 'matching', {});
  assert.deepEqual(tab.candidates.map(candidate => candidate.basis), ['updated', 'updated']);
  assert.deepEqual(tab.basisUpdated.count, 2);
  assert.deepEqual([...tab.basisUpdated.subjects].sort(), [a, b].sort(), 'the list the page offers to evaluate again');
  assert.equal(await jobCount(target), jobs, 'nothing was queued or run because a basis changed');
  // Saving the same terms again is no change.
  await database.query('DELETE FROM evimed_vcr.derived_marks WHERE study_id=$1', [target.id]);
  await vcr.dataPlane.setCloudPermission({ studyId: target.id, sourceId: source.id, actor: 'owner', permission: { status: 'revoked' } });
  assert.deepEqual(await marksOf(target, 'assessment'), {});
  // Restoring it is a change again; and the evaluation the page offered writes a new assessment that is not marked.
  await vcr.dataPlane.setCloudPermission({ studyId: target.id, sourceId: source.id, actor: 'owner', permission: { status: 'default' } });
  assert.deepEqual(Object.keys(await marksOf(target, 'assessment')).sort(), [a, b].sort());
  await f.evaluate('job_marks_2');
  const again = await vcr.service.tab({ id: 'owner' }, target.id, 'matching', {});
  assert.deepEqual(again.candidates.map(candidate => candidate.basis), [undefined, undefined]);
  assert.equal(again.basisUpdated, undefined);
  assert.equal(await jobCount(target), jobs, 'the test ran the evaluation itself; the platform queued none');
});

test('a reviewed text that now takes the place of a record marks what was read from the record, for that subject only', options, async () => {
  const f = await fixture();
  const { target, docA, a, b } = f;
  const projection = await vcr.dataPlane.createDocumentProjection({ studyId: target.id, documentId: docA.id, actor: 'owner', sourceHash: projectionHash(CHART_A),
    spans: [{ start: 0, end: 3, kind: 'person' }], attestation: 'Reviewed synthetic canary' });
  assert.deepEqual(await marksOf(target, 'fact'), { [a]: 'projection' });
  assert.deepEqual(await marksOf(target, 'assessment'), { [a]: 'projection' });
  const tab = await vcr.service.tab({ id: 'owner' }, target.id, 'matching', { candidate: a });
  assert.equal(tab.candidates.find(candidate => candidate.id === a).basis, 'updated');
  assert.equal(tab.candidates.find(candidate => candidate.id === b).basis, undefined);
  assert.equal(tab.timeline.find(fact => fact.variable === 'age').basis, 'updated', 'the fact says so beside itself');
  // A run reading the record now reads the reviewed text, and the fact it wrote from the record is not sent back as evidence.
  assert.equal((await vcr.documents.subjectDocuments(target, { subjectKey: a, documentId: docA.id })).document.id, projection.id);
  assert.equal((await vcr.matching.runtimeRead(target, { subjectKey: a })).facts.length, 0);
});

test('a record added for someone already evaluated marks their evaluation, and it stays when a withdrawal is the stronger cause', options, async () => {
  const f = await fixture();
  const { target, source, a, b } = f;
  const added = await vcr.dataPlane.storeUpload({ actor: 'owner', studyId: target.id, sourceId: source.id, name: 'later.txt', role: 'document', subject: 'MARKS-A', stream: streamOf('新增化验：肌酐 1.1 mg/dL。') });
  assert.equal(added.created, true);
  assert.deepEqual(await marksOf(target, 'assessment'), { [a]: 'document' });
  // The same bytes again are the same file: nothing new, nothing marked.
  await database.query('DELETE FROM evimed_vcr.derived_marks WHERE study_id=$1', [target.id]);
  const again = await vcr.dataPlane.storeUpload({ actor: 'owner', studyId: target.id, sourceId: source.id, name: 'later.txt', role: 'document', subject: 'MARKS-A', stream: streamOf('新增化验：肌酐 1.1 mg/dL。') });
  assert.equal(again.created, false);
  assert.deepEqual(await marksOf(target, 'assessment'), {});
  // A subject whose text was withdrawn stays withdrawn when a permission changes after.
  await vcr.dataPlane.withdrawSubject({ studyId: target.id, subjectKey: b, actor: 'owner' });
  assert.deepEqual(await marksOf(target, 'assessment'), { [b]: 'withdrawn' });
  await vcr.dataPlane.setCloudPermission({ studyId: target.id, sourceId: source.id, actor: 'owner', permission: { status: 'revoked' } });
  assert.deepEqual(await marksOf(target, 'assessment'), { [a]: 'permission', [b]: 'withdrawn' }, 'the stronger cause is kept');
  const tab = await vcr.service.tab({ id: 'owner' }, target.id, 'matching', {});
  assert.deepEqual(Object.fromEntries(tab.candidates.map(candidate => [candidate.id, candidate.basis])), { [a]: 'updated', [b]: 'withdrawn' });
  assert.deepEqual(tab.basisUpdated.subjects, [a], 'only the person who can still be evaluated is offered');
  // Marks are the study's own: another study reads none.
  const other = await vcr.store.createStudy({ userId: 'owner', projectId: `prj_${Math.random().toString(16).slice(2)}`, name: 'Another', question: 'q', dataTier: 'T0' });
  assert.equal((await vcr.erasure.assessmentMarks(other.id, (await vcr.matchStore.listAssessments({ studyId: target.id })).map(row => row.id))).size, 0);
});
