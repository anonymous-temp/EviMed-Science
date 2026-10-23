import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { GeoMeasureStore } from '../src/geoMeasureStore.mjs';
import { GeoStore } from '../src/geoStore.mjs';
import { GeoService } from '../src/geoService.mjs';
import { createGeoDiagnosisReview } from '../src/geoDiagnosisReview.mjs';
import { errorFingerprint } from '../src/geoErrors.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
import { seedGeoProject } from './helpers/geoMeasureFixtures.mjs';
const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? '';
const options = { skip: !url && 'An isolated local PostgreSQL database is required' };
let isolated, database, store, project, review, service;
const conditions = { population: 'Adults', elements: { form: 'tablet' }, inLabel: true, validUntil: null, evidenceLevel: 'label' };
const claim = { id: 'correction_geo_claim_0', key: 'adult', version: 1, ...conditions, quote: 'Adults may use the tablet.', statement: 'Adults only.', sourceRef: 'label:2026' };
const wrong = { text: 'All ages may use the tablet.', verdict: 'wrong', claimId: claim.id, claimKey: claim.key, claimVersion: 1, applicability: conditions, evidence: claim.quote, errorType: 'dropped_condition', severity: 'S3' };
let verdict = 'correct';
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, 'geocorrection');
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 6, databaseConnectionTimeoutMs: 3000 });
  store = new GeoMeasureStore(database); await store.ready();
  await seedGeoProject(database, { id: 'correction_geo', userId: 'correction_owner', projectId: 'correction_project', engines: ['deepseek'], groups: [{ id: 'correction_group', pool: 'P2' }], questions: [{ id: 'correction_question', groupId: 'correction_group', text: 'Who can use it?' }], claims: [claim] });
  project = await store.project('correction_geo');
  await database.query(`INSERT INTO evimed_geo.rounds(id,user_id,geo_project_id,kind,status,set_version,engines,ref) VALUES('correction_round','correction_owner','correction_geo','baseline','done',1,'{deepseek}',$1::jsonb)`, [JSON.stringify({ evaluationBasis: { claims: [claim], product: {}, competitors: [], owned: {}, careFlags: [] } })]);
  await snapshot('correction_first'); await occurrence('correction_first');
  review = createGeoDiagnosisReview({ database, store, judge: { available: true, judge: async () => ({ statements: [{ ...wrong, verdict }], checks: { citations: [], offLabel: [], omittedSafety: [], judgementCoverage: { status: 'complete' } }, dropped: [], entities: [], recommendations: [] }) } });
  service = new GeoService({ store: new GeoStore({ database }), config: { geoEnabled: true, geoAudience: 'all' } });
});
after(async () => { await database?.close(); await isolated?.drop(); });
async function snapshot(id, at = '2026-10-24T01:00:00Z') {
  await database.query(`INSERT INTO evimed_geo.snapshots(id,user_id,geo_project_id,round_id,question_id,engine,asked_at,status,answer_text) VALUES($1,'correction_owner','correction_geo','correction_round','correction_question','deepseek',$2,'valid',$3)`, [id, at, wrong.text]);
  await store.writeFacts({ id, userId: project.userId, geoProjectId: project.id }, { statements: [wrong], checks: { judgementCoverage: { status: 'complete' } }, judgedAt: at, parserVersion: 'geo-parse+geo-judge-test', assessmentBasis: [claim] });
}
async function occurrence(id, at = '2026-10-24T01:00:00Z') {
  return store.upsertError({ id: 'correction_error', userId: project.userId, geoProjectId: project.id, fingerprint: errorFingerprint(wrong), engine: 'deepseek', questionId: 'correction_question', snapshotId: id, statement: wrong.text, errorType: wrong.errorType, severity: wrong.severity, claimId: claim.id, evidenceQuote: claim.quote, confirm: { status: 'done' }, citedSource: null, action: null, responsible: 'platform', now: new Date(at), askedAt: new Date(at) });
}
async function submit(snapshotId, key) {
  await review.submit(project, { snapshotId, statement: wrong.text, claimId: claim.id, assessmentVersion: (await review.read(project, snapshotId)).assessmentVersion, note: 'Review this exact assessment.', requestKey: key });
}
const error = async () => (await database.query("SELECT * FROM evimed_geo.errors WHERE id='correction_error'")).rows[0];
test('a verified same-snapshot judgment correction withdraws the original contribution without claiming remeasurement closure', options, async () => {
  await submit('correction_first', 'withdraw_first');
  assert.equal((await error()).judgment_state, 'active', 'feedback alone changes no error verdict');
  assert.deepEqual(await review.tick(), { processed: 1 });
  const row = await error();
  assert.equal(row.judgment_state, 'withdrawn'); assert.equal(row.status, 'open');
  await occurrence('correction_first');
  assert.equal((await error()).judgment_state, 'withdrawn', 'a delayed old parse cannot reactivate a judgment no longer present in current facts');
  assert.equal(row.judgment_correction.kind, 'assessment_correction');
  assert.ok(row.judgment_correction.previousAssessmentVersion);
  const view = await service.diagnosis({ id: project.userId }, project.id, { round: 'correction_round' });
  assert.equal(view.errorCounts.open, 0); assert.equal(view.errorCounts.severe, 0);
  assert.equal(view.activeErrorSummary.total, 0);
  assert.equal(view.errors[0].judgmentState, 'withdrawn', 'the historical error remains addressable');
  assert.equal((await store.errorsToNotify(['S3'], 20)).length, 0);
});
test('another preserved wrong occurrence keeps the same identity active and later corrections or recurrence remain auditable', options, async () => {
  verdict = 'wrong'; await submit('correction_first', 'reactivate_first'); await review.tick();
  assert.equal((await error()).judgment_state, 'active');
  await snapshot('correction_second', '2026-10-25T01:00:00Z'); await occurrence('correction_second', '2026-10-25T01:00:00Z');
  verdict = 'correct'; await submit('correction_first', 'correct_first_again'); await review.tick();
  assert.equal((await error()).judgment_state, 'active', 'the second genuine wrong judgment is independent');
  await submit('correction_second', 'correct_second'); await review.tick();
  assert.equal((await error()).judgment_state, 'withdrawn');
  await snapshot('correction_third', '2026-10-26T01:00:00Z'); await occurrence('correction_third', '2026-10-26T01:00:00Z');
  const row = await error();
  assert.equal(row.judgment_state, 'active');
  assert.equal(row.judgment_correction.kind, 'new_wrong_occurrence');
  assert.ok(row.judgment_history.some(entry => entry.kind === 'assessment_correction'));
  assert.ok(row.judgment_history.some(entry => entry.kind === 'judgment_reactivated'));
  await store.errorsRecorded('correction_third', [{ ...wrong, severity: 'S1' }]);
  assert.equal((await database.query("SELECT errors_owed FROM evimed_geo.facts WHERE snapshot_id='correction_third'")).rows[0].errors_owed, true, 'a stale recording attempt cannot clear a newer assessment debt');
  await store.errorsRecorded('correction_third', [wrong]);
  assert.equal((await database.query("SELECT errors_owed FROM evimed_geo.facts WHERE snapshot_id='correction_third'")).rows[0].errors_owed, false);
});
