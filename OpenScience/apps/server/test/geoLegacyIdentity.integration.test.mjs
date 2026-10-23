import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { before, after, test } from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { GeoMeasureStore } from '../src/geoMeasureStore.mjs';
import { recordErrorsFromFacts, errorFingerprint, noteErrorAction, tickErrors } from '../src/geoErrors.mjs';
import { createGeoDiagnosisReview } from '../src/geoDiagnosisReview.mjs';
import { buildJudgeInput, verifyJudgement, factsOf } from '../src/geoJudge.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
import { seedGeoProject } from './helpers/geoMeasureFixtures.mjs';
import { brandRegistry } from '../src/geoParse.mjs';
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
  assert.equal(rows[0].status, 'acting'); assert.equal(new Date(rows[0].updated_at).toISOString(), '2026-10-24T01:03:00.000Z', 'identity bookkeeping is not a new consumer occurrence'); assert.equal(rows[0].materials.length, 1); assert.ok(rows[0].notified_at); assert.equal(f.notices.length, 0);
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

test('missing frozen evidence cannot borrow a live claim identity', options, async () => {
  const f = await fixture('legacy_missing');
  await database.query("UPDATE evimed_geo.rounds SET ref='{}'::jsonb WHERE id=$1", [`${f.id}_round`]);
  await record(f); const [row] = await errors(f); assert.equal(row.fingerprint, legacyHash); assert.equal(row.materials.length, 1); assert.ok(row.judgment_history.some(receipt => receipt.kind === 'legacy_identity_unresolved'));
});
test('an exact other genuine wrong occurrence stays active when the original becomes unknown', options, async () => {
  const f = await fixture('legacy_residual');
  await database.query(`INSERT INTO evimed_geo.snapshots(id,user_id,geo_project_id,round_id,question_id,engine,status,asked_at,answer_text)
    SELECT $2,user_id,geo_project_id,round_id,question_id,engine,status,asked_at + interval '1 hour',answer_text FROM evimed_geo.snapshots WHERE id=$1`, [f.snapshot.id, `${f.id}_other`]);
  await store.writeFacts({ id: `${f.id}_other`, userId: f.project.userId, geoProjectId: f.id }, { parserVersion: 'judge-current', judgedAt: '2026-10-24T03:00:00Z', statements: [canonical] });
  await recheck(f, 'unverifiable'); await record(f);
  const [row] = await errors(f); assert.equal(row.fingerprint, errorFingerprint(canonical)); assert.equal(row.judgment_state, 'active'); assert.equal(row.status, 'acting');
});
test('a stale wrong writer after unknown supersession cannot reactivate the migrated judgment', options, async () => {
  const f = await fixture('legacy_stale'); await recheck(f, 'unverifiable'); await record(f);
  const result = await store.upsertError({ id: 'stale_wrong', userId: f.project.userId, geoProjectId: f.id, fingerprint: legacyHash, engine: 'deepseek', questionId: f.snapshot.questionId, snapshotId: f.snapshot.id, statement: legacy.text, verifiedStatement: legacy, claimId: claim.id, severity: 'S3', errorType: legacy.errorType, now: new Date(), askedAt: new Date(f.snapshot.askedAt) });
  assert.equal(result.error, null); const [row] = await errors(f); assert.equal(row.judgment_state, 'withdrawn'); assert.equal(row.status, 'acting'); assert.equal((await errors(f)).length, 1);
});
test('proof beyond its fixed bound remains unresolved instead of partially migrating', options, async () => {
  const f = await fixture('legacy_bound');
  await database.query(`INSERT INTO evimed_geo.snapshots(id,user_id,geo_project_id,round_id,question_id,engine,status,asked_at,answer_text)
    SELECT $1 || '_' || n,user_id,geo_project_id,round_id,question_id,engine,status,asked_at - n * interval '1 second',answer_text FROM evimed_geo.snapshots CROSS JOIN generate_series(1,101) n WHERE id=$2`, [`${f.id}_old`, f.snapshot.id]);
  await database.query(`INSERT INTO evimed_geo.facts(snapshot_id,user_id,geo_project_id,statements,parser_version,judged_at)
    SELECT id,user_id,geo_project_id,$2::jsonb,'legacy',asked_at FROM evimed_geo.snapshots WHERE geo_project_id=$1 AND id<>$3`, [f.id, JSON.stringify([legacy]), f.snapshot.id]);
  await record(f); await record(f); const [row] = await errors(f); assert.equal(row.fingerprint, legacyHash);
  assert.equal(row.judgment_history.filter(receipt => receipt.reason === 'proof_limit').length, 1); assert.equal(row.status, 'acting');
});
test('duplicate aliases cannot redirect a material action across project ownership', options, async () => {
  const a = await fixture('legacy_owner_a'), b = await fixture('legacy_owner_b');
  await database.query(`UPDATE evimed_geo.errors SET judgment_history=$2::jsonb WHERE id=$1`, [`${a.id}_error`, JSON.stringify([{ kind: 'legacy_identity_duplicate', survivorId: `${b.id}_error` }])]);
  assert.equal(await store.error(`${a.id}_error`), null);
  const { noteErrorAction } = await import('../src/geoErrors.mjs');
  await assert.rejects(noteErrorAction(a.deps, { geoProjectId: a.id, errorId: `${a.id}_error`, materials: [{ text: 'Must not cross owners' }] }), error => error.status === 404);
  assert.equal((await errors(b))[0].materials.length, 1);
});
test('article correction through both original and retired duplicate ids appends only once', options, async () => {
  const f = await fixture('legacy_article');
  await database.query(`INSERT INTO evimed_geo.errors(id,user_id,geo_project_id,fingerprint,engine,first_snapshot_id,last_snapshot_id,claim_id,created_at,updated_at)
    SELECT 'article_duplicate',user_id,geo_project_id,$2,engine,first_snapshot_id,last_snapshot_id,claim_id,created_at,created_at FROM evimed_geo.errors WHERE id=$1`, [`${f.id}_error`, errorFingerprint(canonical)]);
  await record(f); const { GeoStore } = await import('../src/geoStore.mjs'), content = new GeoStore({ database });
  const material = { articleId: 'canonical_article', path: 'article.md', layer: 'correction', title: 'Correction', runId: null };
  assert.deepEqual(await content.attachCorrection(f.id, [`${f.id}_error`, 'article_duplicate'], material), [`${f.id}_error`]);
  assert.deepEqual(await content.attachCorrection(f.id, ['article_duplicate'], material), []);
  assert.equal((await errors(f)).find(row => row.id === `${f.id}_error`).materials.length, 2);
});
test('legacy statements missing their key recover the historically frozen key without splitting the handled row', options, async () => {
  const f = await fixture('legacy_nokey'); const { claimKey: _key, ...withoutKey } = legacy;
  await database.query('UPDATE evimed_geo.facts SET statements=$2::jsonb WHERE snapshot_id=$1', [f.snapshot.id, JSON.stringify([withoutKey])]);
  await record(f); const rows = await errors(f); assert.equal(rows.length, 1); assert.equal(rows[0].id, `${f.id}_error`); assert.equal(rows[0].fingerprint, errorFingerprint(canonical));
});
test('a legacy-shaped residual wrong remains active after another occurrence is verified correct', options, async () => {
  const f = await fixture('legacy_residual_correct'); await record(f);
  await database.query(`INSERT INTO evimed_geo.snapshots(id,user_id,geo_project_id,round_id,question_id,engine,status,asked_at,answer_text)
    SELECT $2,user_id,geo_project_id,round_id,question_id,engine,status,asked_at + interval '1 hour',answer_text FROM evimed_geo.snapshots WHERE id=$1`, [f.snapshot.id, `${f.id}_other`]);
  await store.writeFacts({ id: `${f.id}_other`, userId: f.project.userId, geoProjectId: f.id }, { parserVersion: 'legacy', judgedAt: '2026-10-24T03:00:00Z', statements: [legacy] });
  await recheck(f, 'correct'); await record(f);
  const [row] = await errors(f); assert.equal(row.fingerprint, errorFingerprint(canonical)); assert.equal(row.judgment_state, 'active'); assert.equal(row.status, 'acting'); assert.ok(row.notified_at); assert.equal(f.notices.length, 0);
});

async function addClockSnapshot(f, suffix, at, statements, { verified = false } = {}) {
  const id = `${f.id}_${suffix}`, answer = statements.map(statement => statement.text).join(' ');
  await database.query(`INSERT INTO evimed_geo.snapshots(id,user_id,geo_project_id,round_id,question_id,engine,status,asked_at,answer_text)
    SELECT $2,user_id,geo_project_id,round_id,question_id,engine,'valid',$3,$4 FROM evimed_geo.snapshots WHERE id=$1`, [f.snapshot.id, id, at, answer]);
  const snapshot = await store.snapshot(id);
  let facts = { parserVersion: 'legacy', judgedAt: at ?? '2026-10-24T06:02:00Z', statements, checks: { judgementCoverage: { status: 'complete' } } };
  if (verified) {
    const input = { owner: { userId: f.project.userId, projectId: f.project.projectId }, product: f.context.project.product, competitors: [], careFlags: [], question: { text: 'Who may use it?' }, answer, claims: [claim] };
    const verdict = statements[0].verdict;
    const judged = verifyJudgement({ assessmentComplete: true, statements: [{ text: answer, claim: 'C1', verdict, evidence: claim.quote, topic: 'indication', ...(verdict === 'wrong' ? { errorType: 'dropped_condition', severity: 'S3' } : {}) }] }, buildJudgeInput(input), input);
    facts = factsOf({ snapshot, judged, registry: brandRegistry(f.context.project.product, []), countedOwned: f.context.owned, at: new Date(at ?? '2026-10-24T06:02:00Z'), claims: [claim] }).facts;
  }
  await store.writeFacts(snapshot, facts);
  return { ...f, snapshot };
}
async function clockFixture(id, { legacyAggregate = false } = {}) {
  const f = await fixture(id);
  const second = await addClockSnapshot(f, 'second', '2026-10-24T02:00:00Z', [legacy]);
  if (legacyAggregate) {
    // The historical aggregate already represented A and B before this release.
    await database.query('UPDATE evimed_geo.errors SET last_snapshot_id=$2 WHERE id=$1', [`${f.id}_error`, second.snapshot.id]);
  } else await record({ ...second, deps: { ...f.deps, now: () => new Date('2026-10-24T02:02:00Z') } });
  await noteErrorAction({ ...f.deps, now: () => new Date('2026-10-24T02:03:00Z') }, { geoProjectId: f.id, errorId: `${f.id}_error`, status: 'awaiting_remeasure' });
  const correct = await addClockSnapshot(f, 'correct', '2026-10-24T03:00:00Z', [{ ...canonical, text: claim.quote, verdict: 'correct' }], { verified: true });
  return { f, second, correct };
}
for (const legacyAggregate of [true, false]) test(`older represented replay preserves the action clock and an already correct remeasurement (${legacyAggregate ? 'first promotion' : 'already promoted'})`, options, async () => {
  const { f, second, correct } = await clockFixture(`legacy_clock_${legacyAggregate}`, { legacyAggregate });
  assert.ok((await store.laterJudgedAnswers(`${f.id}_error`)).some(answer => answer.id === correct.snapshot.id));
  const before = (await errors(f))[0];
  const replay = await record({ ...f, deps: { ...f.deps, now: () => new Date('2026-10-24T04:00:00Z') } });
  const [after] = await errors(f);
  assert.equal(after.updated_at.toISOString(), before.updated_at.toISOString(), 'an older represented occurrence is bookkeeping, not a fresh consumer observation');
  assert.equal(after.id, before.id); assert.equal(after.last_snapshot_id, second.snapshot.id); assert.equal(after.status, 'awaiting_remeasure'); assert.deepEqual(after.materials, before.materials); assert.equal(after.notified_at.toISOString(), before.notified_at.toISOString());
  assert.deepEqual(replay, { created: 0, seen: 1, notified: 0 });
  assert.ok((await store.laterJudgedAnswers(after.id)).some(answer => answer.id === correct.snapshot.id));
  await tickErrors({ store, config: {}, now: () => new Date('2026-10-24T04:01:00Z') });
  const resolved = await store.error(after.id); assert.equal(resolved.status, 'closed'); assert.equal(resolved.closedSnapshotId, correct.snapshot.id);
});
test('a genuinely newer wrong advances the occurrence clock and cannot borrow an earlier correct answer', options, async () => {
  const { f, correct } = await clockFixture('legacy_clock_new');
  const latest = await addClockSnapshot(f, 'new_wrong', '2026-10-24T04:00:00Z', [legacy]);
  await record({ ...latest, deps: { ...f.deps, now: () => new Date('2026-10-24T04:02:00Z') } });
  const [row] = await errors(f); assert.equal(row.updated_at.toISOString(), '2026-10-24T04:02:00.000Z'); assert.equal(row.last_snapshot_id, latest.snapshot.id); assert.equal(row.status, 'awaiting_remeasure'); assert.equal(row.materials.length, 1);
  assert.equal((await store.laterJudgedAnswers(row.id)).some(answer => answer.id === correct.snapshot.id), false);
  await tickErrors({ store, config: {}, now: () => new Date('2026-10-24T04:03:00Z') });
  assert.equal((await store.error(row.id)).status, 'awaiting_remeasure');
});
test('a new wrong after verified closure reopens once and its own replay preserves the new clock', options, async () => {
  const { f, correct } = await clockFixture('legacy_clock_recurrence');
  await tickErrors({ store, config: {}, now: () => new Date('2026-10-24T03:01:00Z') });
  assert.equal((await store.error(`${f.id}_error`)).closedSnapshotId, correct.snapshot.id);
  const latest = await addClockSnapshot(f, 'recurring_wrong', '2026-10-24T05:00:00Z', [legacy]);
  const first = await record({ ...latest, deps: { ...f.deps, now: () => new Date('2026-10-24T05:01:00Z') } });
  assert.equal(first.notified, 1);
  await record({ ...latest, deps: { ...f.deps, now: () => new Date('2026-10-24T06:00:00Z') } });
  const [row] = await errors(f); assert.equal(row.id, `${f.id}_error`); assert.equal(row.status, 'open'); assert.equal(row.closed_snapshot_id, null); assert.equal(row.last_snapshot_id, latest.snapshot.id); assert.equal(row.updated_at.toISOString(), '2026-10-24T05:01:00.000Z'); assert.equal(row.materials.length, 1); assert.equal(f.notices.length, 1);
});

test('a verified wrong strictly after closure within one millisecond reopens and notifies once at PostgreSQL precision', options, async () => {
  const { f } = await clockFixture('legacy_clock_precision');
  const correct = await addClockSnapshot(f, 'precise_correct', '2026-10-24T06:00:00.000100Z', [{ ...canonical, text: claim.quote, verdict: 'correct' }], { verified: true });
  await tickErrors({ store, config: {}, now: () => new Date('2026-10-24T06:01:00Z') });
  assert.equal((await store.error(`${f.id}_error`)).closedSnapshotId, correct.snapshot.id);
  const wrong = await addClockSnapshot(f, 'precise_wrong', '2026-10-24T06:00:00.000200Z', [canonical], { verified: true });
  assert.equal(wrong.snapshot.askedAt, correct.snapshot.askedAt, 'ordinary snapshot DTOs round both observations to the same millisecond');
  const recorded = await record({ ...wrong, deps: { ...f.deps, now: () => new Date('2026-10-24T06:02:00Z') } });
  const [row] = await errors(f);
  assert.equal(row.status, 'open', 'the database observed the wrong answer strictly after the correct closure');
  assert.equal(row.closed_snapshot_id, null); assert.equal(row.last_snapshot_id, wrong.snapshot.id); assert.equal(row.updated_at.toISOString(), '2026-10-24T06:02:00.000Z'); assert.equal(recorded.notified, 1);
  await record({ ...wrong, deps: { ...f.deps, now: () => new Date('2026-10-24T07:00:00Z') } });
  assert.equal((await errors(f))[0].updated_at.toISOString(), row.updated_at.toISOString()); assert.equal(f.notices.length, 1);
  const older = await addClockSnapshot(f, 'precise_older', '2026-10-24T06:00:00.000150Z', [canonical], { verified: true });
  await record({ ...older, deps: { ...f.deps, now: () => new Date('2026-10-24T08:00:00Z') } });
  const [after] = await errors(f); assert.equal(after.last_snapshot_id, wrong.snapshot.id); assert.equal(after.updated_at.toISOString(), row.updated_at.toISOString()); assert.equal(after.materials.length, 1); assert.equal(f.notices.length, 1);
});
test('an unknown observation time preserves a known closure and records unresolved wrong history without inventing a later occurrence', options, async () => {
  const { f, correct } = await clockFixture('legacy_clock_unknown_time');
  await tickErrors({ store, config: {}, now: () => new Date('2026-10-24T03:01:00Z') });
  const [before] = await errors(f); assert.equal(before.closed_snapshot_id, correct.snapshot.id);
  const unknown = await addClockSnapshot(f, 'unknown_time_wrong', null, [canonical], { verified: true });
  assert.equal(unknown.snapshot.askedAt, null);
  const recorded = await record({ ...unknown, deps: { ...f.deps, now: () => new Date('2026-10-24T06:02:00Z') } });
  await record({ ...unknown, deps: { ...f.deps, now: () => new Date('2026-10-24T07:00:00Z') } });
  const [after] = await errors(f);
  assert.equal(after.status, 'closed'); assert.equal(after.closed_snapshot_id, correct.snapshot.id); assert.equal(after.last_snapshot_id, before.last_snapshot_id); assert.equal(after.updated_at.toISOString(), before.updated_at.toISOString()); assert.equal(f.notices.length, 0);
  assert.deepEqual(recorded, { created: 0, seen: 1, notified: 0 });
  assert.equal(after.judgment_history.filter(receipt => receipt.kind === 'wrong_occurrence_time_unknown' && receipt.snapshotId === unknown.snapshot.id).length, 1);
  const fact = (await database.query('SELECT statements,errors_owed FROM evimed_geo.facts WHERE snapshot_id=$1', [unknown.snapshot.id])).rows[0];
  assert.equal(fact.statements[0].verdict, 'wrong'); assert.equal(fact.errors_owed, false);
});
