import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { GeoMeasureStore } from '../src/geoMeasureStore.mjs';
import { createGeoDiagnosisReview } from '../src/geoDiagnosisReview.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
import { seedGeoProject } from './helpers/geoMeasureFixtures.mjs';

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? '';
const options = { skip: !url && 'A disposable localhost PostgreSQL database is required' };
let database, isolated, store, review, project;
const seen = [];
const claim = { id: 'claimless_geo_claim_0', key: 'label', version: 1, statement: 'Adults only.', quote: 'Adults only.', sourceRef: 'label:2026', inLabel: true };
const unknown = { text: 'Unproven broad benefit.', verdict: 'unverifiable', claimId: null, claimKey: null, evidence: null, topic: 'efficacy' };
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, 'claimless');
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 3000 });
  store = new GeoMeasureStore(database); await store.ready();
  await seedGeoProject(database, { id: 'claimless_geo', userId: 'claimless_owner', projectId: 'claimless_project', engines: ['deepseek'], groups: [], questions: [], claims: [claim] });
  project = await store.project('claimless_geo');
  await database.query(`INSERT INTO evimed_geo.rounds(id,user_id,geo_project_id,kind,status,set_version,engines,ref)
    VALUES('claimless_round',$1,$2,'baseline','done',1,'{deepseek}',$3::jsonb)`, [project.userId, project.id, JSON.stringify({ evaluationBasis: { claims: [claim], product: {}, competitors: [], owned: {}, careFlags: [] } })]);
  review = createGeoDiagnosisReview({ database, store, judge: { available: true, judge: async input => {
    seen.push(input);
    return { statements: [unknown], checks: { offLabel: [], omittedSafety: [], citations: [], judgementCoverage: { status: 'complete' } }, recommendations: [], entities: [], dropped: [] };
  } } });
});
after(async () => { await database?.close(); await isolated?.drop(); });
async function submit(snapshotId, statement) {
  await database.query(`INSERT INTO evimed_geo.snapshots(id,user_id,geo_project_id,round_id,engine,status,answer_text)
    VALUES($1,$2,$3,'claimless_round','deepseek','valid',$4)`, [snapshotId, project.userId, project.id, statement.text]);
  await store.writeFacts({ id: snapshotId, userId: project.userId, geoProjectId: project.id }, { parserVersion: 'geo-parse-test', judgedAt: '2026-10-24T01:00:00Z', statements: [statement], assessmentBasis: [claim] });
  const current = await review.read(project, snapshotId);
  return review.submit(project, { snapshotId, statement: statement.text, claimId: statement.claimId, assessmentVersion: current.assessmentVersion, note: 'Please recheck this uncertain statement.', requestKey: `review_${snapshotId}` });
}

test('an unchanged claimless uncertain statement can be reviewed without inventing a claim alias', options, async () => {
  await submit('claimless_snapshot', unknown);
  assert.deepEqual(await review.tick(), { processed: 1 });
  assert.equal(seen.length, 1); assert.equal(seen[0].reviewFeedback.claim, undefined);
  const result = await review.read(project, 'claimless_snapshot');
  assert.equal(result.feedback[0].status, 'succeeded');
  assert.equal(result.current.statements[0].verdict, 'unverifiable');
  assert.equal(result.current.statements[0].claimId, null);
  assert.equal(result.feedback[0].original.verdict, 'unverifiable');
});

test('a statement naming a missing claim still fails before any model call', options, async () => {
  await submit('missing_claim_snapshot', { ...unknown, claimId: 'missing-claim', claimKey: 'missing' });
  const result = await review.tick();
  assert.equal(result.processed, 0); assert.equal(result.failed, 1); assert.equal(seen.length, 1);
  const saved = await review.read(project, 'missing_claim_snapshot');
  assert.equal(saved.feedback[0].status, 'failed');
  assert.equal(saved.current.statements[0].claimId, 'missing-claim');
});
