import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { GeoMeasureStore } from '../src/geoMeasureStore.mjs';
import { GeoStore } from '../src/geoStore.mjs';
import { GeoService } from '../src/geoService.mjs';
import { createGeoDiagnosisReview } from '../src/geoDiagnosisReview.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
import { seedGeoProject } from './helpers/geoMeasureFixtures.mjs';

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? '';
const options = { skip: !url && 'A disposable localhost PostgreSQL database is required' };
let isolated, database, store, review, project, service;
const claim = { id: 'review_geo_claim_0', key: 'label', version: 1, quote: 'Adults only.', statement: 'Adults only.', sourceRef: 'label:2026', population: 'Adults', elements: { form: 'tablet' } };
const wrong = { text: 'All ages may use it.', verdict: 'wrong', claimId: claim.id, claimKey: claim.key, evidence: claim.quote, errorType: 'dropped_condition', topic: 'indication', severity: 'S3' };
let nextVerdict = 'correct', calls = 0, omitStatements = false;
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, 'georeview');
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 8, databaseConnectionTimeoutMs: 3000 });
  store = new GeoMeasureStore(database); await store.ready();
  await seedGeoProject(database, { id: 'review_geo', userId: 'review_owner', projectId: 'review_project', engines: ['deepseek'],
    groups: [{ id: 'review_group', pool: 'P2' }], questions: [{ id: 'review_question', groupId: 'review_group', text: 'Who can use it?' }], claims: [claim] });
  project = await store.project('review_geo');
  await database.query(`INSERT INTO evimed_geo.rounds(id,user_id,geo_project_id,kind,status,set_version,engines,ref)
    VALUES('review_round','review_owner','review_geo','baseline','done',1,'{deepseek}',$1::jsonb)`, [JSON.stringify({ evaluationBasis: { claims: [claim], product: {}, competitors: [], owned: {}, careFlags: [] } })]);
  await database.query(`INSERT INTO evimed_geo.snapshots(id,user_id,geo_project_id,round_id,question_id,engine,status,answer_text)
    VALUES('review_snapshot','review_owner','review_geo','review_round','review_question','deepseek','valid',$1)`, [wrong.text]);
  await store.writeFacts({ id: 'review_snapshot', userId: project.userId, geoProjectId: project.id }, { parserVersion: 'geo-parse-test', judgedAt: '2026-10-24T01:00:00Z', statements: [wrong], assessmentBasis: [claim] });
  review = createGeoDiagnosisReview({ database, store, judge: { available: true, judge: async () => {
    calls += 1;
    return { statements: omitStatements ? [] : [{ ...wrong, verdict: nextVerdict }], checks: { offLabel: [], omittedSafety: [], citations: [], judgementCoverage: { status: 'complete' } }, recommendations: [], entities: [], dropped: [] };
  } } });
  service = new GeoService({ store: new GeoStore({ database }), config: { geoEnabled: true, geoAudience: 'all' } });
  service.diagnosisReview = review;
});
after(async () => { await database?.close(); await isolated?.drop(); });
async function input(key = 'request_first') {
  return { snapshotId: 'review_snapshot', statement: wrong.text, claimId: claim.id, assessmentVersion: (await review.read(project, 'review_snapshot')).assessmentVersion, note: 'Please check the actual conditions.', requestKey: key };
}

test('feedback persists once and does not change the original verdict before the leased recheck', options, async () => {
  const feedback = await input();
  const submitted = await review.submit(project, feedback);
  assert.equal((await review.submit(project, feedback)).id, submitted.id);
  const saved = await review.read(project, 'review_snapshot');
  assert.equal(saved.feedback.length, 1); assert.equal(saved.feedback[0].status, 'queued');
  assert.equal(saved.current.statements[0].verdict, 'wrong'); assert.equal(calls, 0);
  await assert.rejects(review.submit(project, { ...feedback, requestKey: 'request_stale', assessmentVersion: 'a'.repeat(64) }), e => e.status === 409);
  await assert.rejects(review.submit(project, { ...feedback, note: 'Changed feedback.' }), e => e.status === 409);
});

test('a recheck has a new assessment head while preserving the original judgment and feedback on reload', options, async () => {
  assert.deepEqual(await review.tick(), { processed: 1 });
  const saved = await review.read(project, 'review_snapshot');
  assert.equal(saved.current.statements[0].verdict, 'correct');
  assert.equal(saved.feedback[0].original.verdict, 'wrong'); assert.equal(saved.feedback[0].status, 'succeeded');
  assert.ok(saved.history.some(row => row.assessment.statements[0].verdict === 'wrong'));
  assert.ok(saved.history.some(row => row.assessment.statements[0].verdict === 'correct'));
  const assessment = (await database.query("SELECT payload FROM evimed_product.documents WHERE payload->>'recordType'='geo-assessment'")).rows[0].payload;
  assert.equal(assessment.contributions.length, 0, 'the old wrong-learning contribution is withdrawn in the same facts transaction');
  nextVerdict = 'wrong';
  await review.submit(project, await input('request_recurrence'));
  assert.deepEqual(await review.tick(), { processed: 1 });
  assert.equal((await review.read(project, 'review_snapshot')).current.statements[0].verdict, 'wrong');
});

test('another tenant cannot read or mutate this feedback and viewer mutation is forbidden', options, async () => {
  await assert.rejects(review.read({ ...project, userId: 'another_owner' }, 'review_snapshot'), e => e.status === 404);
  await assert.rejects(service.readDiagnosisReview({ id: 'another_owner' }, project.id, 'review_snapshot'), e => e.status === 404);
  const prior = service.requireProject.bind(service);
  service.requireProject = async (_user, _id, ability = 'read') => {
    if (ability !== 'read') throw Object.assign(new Error('Forbidden'), { status: 403 });
    return project;
  };
  await assert.rejects(service.submitDiagnosisFeedback({ id: 'viewer' }, project.id, await input('viewer_request')), e => e.status === 403);
  service.requireProject = prior;
});

test('a second queued review cannot overwrite a newer assessment head', options, async () => {
  const first = await input('concurrent_first');
  await review.submit(project, first);
  await review.submit(project, { ...first, requestKey: 'concurrent_second' });
  const before = calls;
  assert.deepEqual(await review.tick(), { processed: 1 });
  assert.deepEqual(await review.tick(), { processed: 0, failed: 1 });
  assert.equal(calls - before, 1, 'the stale queued feedback is rejected before any judge call');
  const saved = await review.read(project, 'review_snapshot');
  assert.equal(saved.feedback.find(row => row.error?.code === 'geo_assessment_changed').status, 'failed');
  assert.equal(saved.original.statements[0].verdict, 'wrong');
});


test('an incomplete recheck retains the defensible prior statement instead of silently treating it as corrected', options, async () => {
  omitStatements = true;
  await review.submit(project, await input('incomplete_review'));
  assert.deepEqual(await review.tick(), { processed: 1 });
  const saved = await review.read(project, 'review_snapshot');
  assert.equal(saved.current.statements[0].verdict, 'wrong');
  assert.equal(saved.current.checks.judgementCoverage.status, 'partial');
  assert.equal(saved.original.statements[0].verdict, 'wrong');
});
