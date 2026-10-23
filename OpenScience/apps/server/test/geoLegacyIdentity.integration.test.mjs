import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { before, after, test } from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { GeoMeasureStore } from '../src/geoMeasureStore.mjs';
import { recordErrorsFromFacts, errorFingerprint } from '../src/geoErrors.mjs';
import { createGeoDiagnosisReview } from '../src/geoDiagnosisReview.mjs';
import { buildJudgeInput, verifyJudgement } from '../src/geoJudge.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
import { seedGeoProject } from './helpers/geoMeasureFixtures.mjs';
const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? '';
const options = { skip: !url && 'An isolated local PostgreSQL database is required' };
let isolated, database, store;
const claim = { id: 'legacy_claim', key: 'adult_label', version: 1, population: 'Adults', elements: { form: 'tablet' }, inLabel: true, validUntil: null, evidenceLevel: 'label', statement: 'Only adults may use the tablet.', quote: 'Only adults may use the tablet.', sourceRef: 'label:2026' };
const legacy = { text: 'All ages may use the tablet.', verdict: 'wrong', claimId: claim.id, claimKey: claim.key, evidence: claim.quote, errorType: 'dropped_condition', severity: 'S3', topic: 'indication' };
const legacyHash = createHash('sha256').update(`claim:${claim.key}`).digest('hex').slice(0, 32);
const canonical = { ...legacy, claimVersion: claim.version, applicability: { population: claim.population, elements: claim.elements, inLabel: true, validUntil: null, evidenceLevel: 'label' } };
before(async () => { if (!url) return; isolated = await createGeoTestDatabase(url, 'geolegacy'); database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 8, databaseConnectionTimeoutMs: 3000 }); store = new GeoMeasureStore(database); await store.ready(); });
after(async () => { await database?.close(); await isolated?.drop(); });
async function fixture(id, claims = [claim], { baseline = true } = {}) {
  await seedGeoProject(database, { id, userId: `${id}_owner`, projectId: `${id}_project`, engines: ['deepseek'], groups: [{ id: `${id}_group`, pool: 'P2' }], questions: [{ id: `${id}_question`, groupId: `${id}_group`, text: 'Who may use it?' }], claims: [claim] });
  await database.query(`INSERT INTO evimed_geo.rounds(id,user_id,geo_project_id,kind,status,set_version,engines,ref) VALUES($1,$2,$3,'confirm','done',1,'{deepseek}',$4::jsonb)`, [`${id}_round`, `${id}_owner`, id, JSON.stringify({ questionId: `${id}_question`, engine: 'deepseek', evaluationBasis: { claims, product: {}, competitors: [], owned: {}, careFlags: [] } })]);
  await database.query(`INSERT INTO evimed_geo.snapshots(id,user_id,geo_project_id,round_id,question_id,engine,status,asked_at,answer_text) VALUES($1,$2,$3,$4,$5,'deepseek','valid','2026-10-24T01:00:00Z',$6)`, [`${id}_snapshot`, `${id}_owner`, id, `${id}_round`, `${id}_question`, legacy.text]);
  const snapshot = await store.snapshot(`${id}_snapshot`), context = await store.projectContext(id, `${id}_round`), project = await store.project(id);
  await store.writeFacts(snapshot, { parserVersion: 'geo-parse-legacy', judgedAt: '2026-10-24T01:01:00Z', statements: [legacy], checks: { judgementCoverage: { status: 'complete' } } });
  if (baseline) await database.query(`INSERT INTO evimed_geo.errors(id,user_id,geo_project_id,fingerprint,engine,question_id,first_snapshot_id,last_snapshot_id,statement,error_type,severity,claim_id,evidence_quote,action,status,materials,notified_at,created_at,updated_at)
    VALUES($1,$2,$3,$4,'deepseek',$5,$6,$6,$7,'dropped_condition','S3',$8,$9,'correction_letter','acting','[{"kind":"note","text":"Original handling"}]','2026-10-24T01:02:00Z','2026-10-24T01:02:00Z','2026-10-24T01:03:00Z')`, [`${id}_error`, `${id}_owner`, id, legacyHash, `${id}_question`, snapshot.id, legacy.text, claim.id, claim.quote]);
  const notices = [], deps = { store, now: () => new Date('2026-10-24T02:00:00Z'), notify: async notice => notices.push(notice.idempotencyKey) };
  return { id, snapshot, context, project, deps, notices };
}
async function recheck(f, verdict) {
  const review = createGeoDiagnosisReview({ database, store, judge: { available: true, judge: async input => verifyJudgement({ assessmentComplete: true, statements: [{ text: legacy.text, claim: 'C1', verdict, evidence: verdict === 'unverifiable' ? null : claim.quote, errorType: verdict === 'wrong' ? legacy.errorType : null, severity: verdict === 'wrong' ? 'S3' : null }] }, buildJudgeInput(input), input) } });
  const before = await review.read(f.project, f.snapshot.id);
  await review.submit(f.project, { snapshotId: f.snapshot.id, statement: legacy.text, claimId: claim.id, assessmentVersion: before.assessmentVersion, note: 'Check the original conditions.', requestKey: `request_${f.id}` });
  assert.deepEqual(await review.tick(), { processed: 1 });
  return review.read(f.project, f.snapshot.id);
}
async function record(f) { const statements = (await database.query('SELECT statements FROM evimed_geo.facts WHERE snapshot_id=$1', [f.snapshot.id])).rows[0].statements; return recordErrorsFromFacts(f.deps, { ...f, statements }); }
async function errors(f) { return (await database.query('SELECT * FROM evimed_geo.errors WHERE geo_project_id=$1 ORDER BY created_at,id', [f.id])).rows; }

test('legacy same-snapshot wrong enrichment preserves one stable handled issue and notice across replay', options, async () => {
  const f = await fixture('legacy_wrong');
  assert.equal(errorFingerprint(legacy), legacyHash);
  const after = await recheck(f, 'wrong');
  assert.equal(after.current.statements.length, 1, 'the enriched reading replaces the legacy comparison identity');
  await record(f); await record(f);
  const rows = await errors(f);
  assert.equal(rows.length, 1); assert.equal(rows[0].id, `${f.id}_error`); assert.equal(rows[0].fingerprint, errorFingerprint(canonical));
  assert.equal(rows[0].status, 'acting'); assert.equal(rows[0].materials.length, 1); assert.ok(rows[0].notified_at); assert.equal(f.notices.length, 0);
  assert.equal(rows[0].judgment_history.filter(row => row.kind === 'legacy_identity_promoted').length, 1);
  assert.ok(after.history.some(row => row.assessment.statements.some(statement => statement.claimVersion == null && statement.verdict === 'wrong')));
});
for (const verdict of ['correct', 'unverifiable']) test(`legacy ${verdict} review leaves durable reconciliation debt without retaining a current wrong`, options, async () => {
  const f = await fixture(`legacy_${verdict}`), after = await recheck(f, verdict);
  assert.equal(after.current.statements.length, 1); assert.equal(after.current.statements[0].verdict, verdict);
  assert.equal((await database.query('SELECT errors_owed FROM evimed_geo.facts WHERE snapshot_id=$1', [f.snapshot.id])).rows[0].errors_owed, true);
  await record(f);
  const [row] = await errors(f); assert.equal(row.id, `${f.id}_error`); assert.equal(row.fingerprint, errorFingerprint(canonical)); assert.equal(row.judgment_state, 'withdrawn'); assert.equal(row.status, 'acting');
  assert.equal((await database.query('SELECT errors_owed FROM evimed_geo.facts WHERE snapshot_id=$1', [f.snapshot.id])).rows[0].errors_owed, false); assert.equal(f.notices.length, 0);
});
test('the store recomputes a still-current delayed legacy recorder key instead of recreating it', options, async () => {
  const f = await fixture('legacy_replay'); await record(f);
  const result = await store.upsertError({ id: 'obsolete_insert', userId: f.project.userId, geoProjectId: f.id, fingerprint: legacyHash, engine: 'deepseek', questionId: f.snapshot.questionId, snapshotId: f.snapshot.id, statement: legacy.text, verifiedStatement: legacy, claimId: claim.id, severity: 'S3', errorType: legacy.errorType, now: new Date(), askedAt: new Date(f.snapshot.askedAt) });
  assert.equal(result.created, false); assert.equal(result.error.id, `${f.id}_error`); assert.equal((await errors(f)).length, 1);
});
test('ambiguous frozen versions retain legacy identity and record an explicit unresolved receipt', options, async () => {
  const f = await fixture('legacy_ambiguous', [claim, { ...claim, version: 2, population: 'Children', elements: { form: 'solution' } }]);
  await record(f); const [row] = await errors(f); assert.equal(row.fingerprint, legacyHash); assert.equal(row.status, 'acting');
  assert.ok(row.judgment_history.some(receipt => receipt.kind === 'legacy_identity_unresolved')); assert.equal(f.notices.length, 0);
});
test('normal new recording of provable legacy-shaped facts uses the exact frozen identity immediately', options, async () => {
  const f = await fixture('legacy_new', [claim], { baseline: false }); await record(f); const [row] = await errors(f); assert.equal(row.fingerprint, errorFingerprint(canonical));
});

test('a pre-existing mechanical canonical duplicate retires as an alias and keeps original handling', options, async () => {
  const f = await fixture('legacy_duplicate');
  await database.query(`INSERT INTO evimed_geo.errors(id,user_id,geo_project_id,fingerprint,engine,question_id,first_snapshot_id,last_snapshot_id,statement,claim_id,severity,notified_at,created_at,updated_at)
    SELECT 'mechanical_duplicate',user_id,geo_project_id,$2,engine,question_id,first_snapshot_id,last_snapshot_id,statement,claim_id,severity,notified_at,created_at,created_at FROM evimed_geo.errors WHERE id=$1`, [`${f.id}_error`, errorFingerprint(canonical)]);
  await record(f);
  const rows = await errors(f), survivor = rows.find(row => row.id === `${f.id}_error`), retired = rows.find(row => row.id === 'mechanical_duplicate');
  assert.equal(survivor.fingerprint, errorFingerprint(canonical)); assert.equal(survivor.status, 'acting'); assert.equal(survivor.materials.length, 1);
  assert.equal(retired.judgment_state, 'withdrawn'); assert.equal(retired.judgment_correction.kind, 'legacy_identity_duplicate');
  assert.equal((await store.error('mechanical_duplicate')).id, survivor.id); assert.equal(f.notices.length, 0);
  const { noteErrorAction } = await import('../src/geoErrors.mjs');
  await noteErrorAction(f.deps, { geoProjectId: f.id, errorId: 'mechanical_duplicate', materials: [{ kind: 'note', text: 'Arrived via old link' }] });
  assert.equal((await store.error(survivor.id)).materials.length, 2);
});
test('independently handled canonical duplicates remain explicit and retain both materials', options, async () => {
  const f = await fixture('legacy_conflict');
  await database.query(`INSERT INTO evimed_geo.errors(id,user_id,geo_project_id,fingerprint,engine,question_id,first_snapshot_id,last_snapshot_id,statement,claim_id,status,materials)
    SELECT 'handled_duplicate',user_id,geo_project_id,$2,engine,question_id,first_snapshot_id,last_snapshot_id,statement,claim_id,'awaiting_remeasure','[{"kind":"note","text":"Independent handling"}]'::jsonb FROM evimed_geo.errors WHERE id=$1`, [`${f.id}_error`, errorFingerprint(canonical)]);
  await record(f); const rows = await errors(f); assert.equal(rows.length, 2); assert.equal(rows.every(row => row.judgment_state === 'active'), true);
  assert.equal(rows.every(row => row.materials.length === 1), true); assert.ok(rows.find(row => row.id === `${f.id}_error`).judgment_history.some(row => row.reason === 'independently_handled_duplicate'));
});
test('an older mixed-condition contribution prevents promotion even when first and last pointers coincide', options, async () => {
  const f = await fixture('legacy_mixed'), child = { ...claim, version: 2, population: 'Children', elements: { form: 'solution' } };
  await database.query(`INSERT INTO evimed_geo.rounds(id,user_id,geo_project_id,kind,status,set_version,engines,ref) VALUES($1,$2,$3,'confirm','done',1,'{deepseek}',$4::jsonb)`, [`${f.id}_childround`, f.project.userId, f.id, JSON.stringify({ evaluationBasis: { claims: [child] } })]);
  await database.query(`INSERT INTO evimed_geo.snapshots(id,user_id,geo_project_id,round_id,question_id,engine,status,asked_at,answer_text) VALUES($1,$2,$3,$4,$5,'deepseek','valid','2026-10-23T00:00:00Z',$6)`, [`${f.id}_older`, f.project.userId, f.id, `${f.id}_childround`, f.snapshot.questionId, legacy.text]);
  await store.writeFacts({ id: `${f.id}_older`, userId: f.project.userId, geoProjectId: f.id }, { parserVersion: 'legacy', judgedAt: '2026-10-23T01:00:00Z', statements: [legacy] });
  await record(f); const original = (await errors(f)).find(row => row.id === `${f.id}_error`);
  assert.equal(original.fingerprint, legacyHash); assert.ok(original.judgment_history.some(receipt => receipt.kind === 'legacy_identity_unresolved'));
  assert.equal(original.materials.length, 1);
});
test('concurrent replays produce one promotion receipt and never lose an already appended action', options, async () => {
  const f = await fixture('legacy_concurrent'); await Promise.all([record(f), record(f)]);
  const [row] = await errors(f); assert.equal((await errors(f)).length, 1); assert.equal(row.judgment_history.filter(entry => entry.kind === 'legacy_identity_promoted').length, 1); assert.equal(row.materials.length, 1);
});
