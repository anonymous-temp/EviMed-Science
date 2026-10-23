import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { GeoMeasureStore } from '../src/geoMeasureStore.mjs';
import { errorFingerprint, tickErrors } from '../src/geoErrors.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
import { seedGeoProject } from './helpers/geoMeasureFixtures.mjs';

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? '';
const options = { skip: !url && 'An isolated local PostgreSQL database is required' };
let isolated, database, store;
const applicability = { population: 'Adults', elements: { form: 'tablet' }, inLabel: true, validUntil: null, evidenceLevel: 'label' };
const claim = { id: 'resolution_claim', key: 'resolution', version: 1, ...applicability, quote: 'Only adults may use the tablet.', statement: 'Adults only.' };
const wrong = { text: 'All ages can use the tablet.', verdict: 'wrong', claimId: claim.id, claimKey: claim.key, claimVersion: 1, applicability, evidence: claim.quote, errorType: 'dropped_condition', severity: 'S3' };
const correct = { ...wrong, text: 'Only adults may use the tablet.', verdict: 'correct', errorType: null, severity: null };
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, 'georesolution');
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 6, databaseConnectionTimeoutMs: 3000 });
  store = new GeoMeasureStore(database); await store.ready();
  await seedGeoProject(database, { id: 'resolution_geo', userId: 'resolution_owner', projectId: 'resolution_project', engines: ['deepseek'], groups: [{ id: 'resolution_group', pool: 'P2' }], questions: [{ id: 'resolution_question', groupId: 'resolution_group', text: 'Who can use it?' }] });
  const other = { ...claim, id: 'child_claim', key: 'child', population: 'Children', elements: { form: 'solution' }, quote: 'Children may use the solution.' };
  await database.query(`INSERT INTO evimed_geo.rounds(id,user_id,geo_project_id,kind,status,set_version,engines,ref) VALUES('resolution_round','resolution_owner','resolution_geo','sentinel','done',1,'{deepseek}',$1::jsonb)`, [JSON.stringify({ evaluationBasis: { claims: [claim, other], product: {}, competitors: [], owned: {}, careFlags: [] } })]);
  await insertAnswer('resolution_origin', 0, [wrong]);
  await database.query(`INSERT INTO evimed_geo.errors(id,user_id,geo_project_id,fingerprint,engine,question_id,first_snapshot_id,last_snapshot_id,claim_id,statement,evidence_quote,status,confirm,updated_at)
    VALUES('resolution_error','resolution_owner','resolution_geo',$1,'deepseek','resolution_question','resolution_origin','resolution_origin',$2,$3,$4,'awaiting_remeasure','{"status":"done"}','2026-10-24T00:00:01Z')`, [errorFingerprint(wrong), claim.id, wrong.text, claim.quote]);
});
after(async () => { await database?.close(); await isolated?.drop(); });
async function insertAnswer(id, index, statements, { status = 'valid', coverage = 'complete', judged = true, answerText = statements.map(row => row.text).join(' ') } = {}) {
  await database.query(`INSERT INTO evimed_geo.snapshots(id,user_id,geo_project_id,round_id,question_id,engine,asked_at,status,answer_text)
    VALUES($1,'resolution_owner','resolution_geo','resolution_round','resolution_question','deepseek',$2,$3,$4)`, [id, new Date(Date.parse('2026-10-24T00:00:00Z') + index * 60000), status, answerText]);
  await store.writeFacts({ id, userId: 'resolution_owner', geoProjectId: 'resolution_geo' }, { statements, checks: { judgementCoverage: { status: coverage } }, judgedAt: judged ? '2026-10-24T01:00:00Z' : null, parserVersion: 'geo-parse+geo-judge-test', assessmentBasis: [claim] });
  await database.query('UPDATE evimed_geo.facts SET errors_owed=false WHERE snapshot_id=$1', [id]);
}
test('only an explicitly verified correct judgment for the same claim/version/applicability with complete coverage resolves an error', options, async () => {
  const cases = [
    ['unknown', [{ ...correct, verdict: 'unverifiable', evidence: null }], {}],
    ['partial', [correct], { coverage: 'partial' }],
    ['coverage_unknown', [correct], { coverage: 'unknown' }],
    ['refusal', [correct], { status: 'refusal' }],
    ['unjudged', [correct], { judged: false }],
    ['different_claim', [{ ...correct, claimId: 'child_claim', claimKey: 'child', applicability: { ...applicability, population: 'Children', elements: { form: 'solution' } } }], {}],
    ['different_version', [{ ...correct, claimVersion: 2 }], {}],
    ['different_label', [{ ...correct, applicability: { ...applicability, inLabel: false } }], {}],
    ['different_expiry', [{ ...correct, applicability: { ...applicability, validUntil: '2025-12-31' } }], {}],
    ['absent', [], {}],
    ['still_wrong', [wrong], {}],
    ['wrong_and_correct', [wrong, correct], {}],
    ['unanchored', [{ ...correct, evidence: 'Not preserved by this claim.' }], {}],
    ['positive', [correct], {}],
  ];
  for (const [index, [id, statements, flags]] of cases.entries()) {
    await insertAnswer(`resolution_${id}`, index + 1, statements, flags);
    await tickErrors({ store, config: {}, now: () => new Date('2026-10-26T00:00:00Z') });
    const row = (await database.query("SELECT status,closed_snapshot_id FROM evimed_geo.errors WHERE id='resolution_error'")).rows[0];
    assert.equal(row.status, id === 'positive' ? 'closed' : 'awaiting_remeasure', id);
    assert.equal(row.closed_snapshot_id, id === 'positive' ? 'resolution_positive' : null, id);
  }
});

test('origin matching selects the error fingerprint across same-id versions in either order', options, async () => {
  const secondClaim = { ...claim, version: 2, population: 'Children', elements: { form: 'solution' }, quote: 'Only children may use the solution.' };
  const wrong2 = { ...wrong, claimVersion: 2, text: 'All ages may use solutions.', applicability: { ...applicability, population: 'Children', elements: { form: 'solution' } }, evidence: secondClaim.quote };
  await database.query("UPDATE evimed_geo.rounds SET ref=$1::jsonb WHERE id='resolution_round'", [JSON.stringify({ evaluationBasis: { claims: [claim, secondClaim], product: {}, competitors: [], owned: {}, careFlags: [] } })]);
  for (const [index, originStatements] of [[wrong, wrong2], [wrong2, wrong]].entries()) {
    const originId = `identity_origin_${index}`, laterId = `identity_later_${index}`, errorId = `identity_error_${index}`;
    await insertAnswer(originId, 100 + index * 10, originStatements);
    await database.query(`INSERT INTO evimed_geo.errors(id,user_id,geo_project_id,fingerprint,engine,question_id,first_snapshot_id,last_snapshot_id,claim_id,statement,evidence_quote,status,confirm,updated_at)
      VALUES($1,'resolution_owner','resolution_geo',$2,'deepseek','resolution_question',$3,$3,$4,$5,$6,'awaiting_remeasure','{"status":"done"}',$7) ON CONFLICT(geo_project_id,fingerprint,engine) DO UPDATE SET first_snapshot_id=EXCLUDED.first_snapshot_id,last_snapshot_id=EXCLUDED.last_snapshot_id,status='awaiting_remeasure',closed_snapshot_id=null,updated_at=EXCLUDED.updated_at`,
      [errorId, errorFingerprint(wrong2), originId, claim.id, wrong2.text, wrong2.evidence, new Date(Date.parse('2026-10-24T00:00:00Z') + (101 + index * 10) * 60000)]);
    await insertAnswer(laterId, 102 + index * 10, [correct, wrong2]);
    await tickErrors({ store, config: {}, now: () => new Date('2026-10-26T00:00:00Z') });
    const row = (await database.query('SELECT status FROM evimed_geo.errors WHERE fingerprint=$1', [errorFingerprint(wrong2)])).rows[0];
    assert.equal(row.status, 'awaiting_remeasure', `origin order ${index}`);
  }
});

test('a concurrent newer wrong occurrence cannot be overwritten by an observed older correct resolution', options, async () => {
  const errorId = 'resolution_error';
  await database.query("UPDATE evimed_geo.errors SET status='awaiting_remeasure',updated_at='2026-10-24T03:00:00Z',first_snapshot_id='resolution_origin',last_snapshot_id='resolution_origin',closed_snapshot_id=null WHERE id=$1", [errorId]);
  await insertAnswer('race_correct', 200, [correct]);
  const original = store.projectContext.bind(store);
  let interleaved = false;
  store.projectContext = async (...args) => {
    const context = await original(...args);
    if (!interleaved) {
      interleaved = true;
      await insertAnswer('race_wrong', 201, [wrong]);
      await store.upsertError({ id: errorId, userId: 'resolution_owner', geoProjectId: 'resolution_geo', fingerprint: errorFingerprint(wrong), engine: 'deepseek', questionId: 'resolution_question', snapshotId: 'race_wrong', statement: wrong.text, errorType: wrong.errorType, severity: wrong.severity, claimId: claim.id, evidenceQuote: claim.quote, confirm: { status: 'done' }, now: new Date('2026-10-24T03:21:00Z'), askedAt: new Date('2026-10-24T03:21:00Z'), verifiedStatement: wrong });
    }
    return context;
  };
  try {
    await tickErrors({ store, config: {}, now: () => new Date('2026-10-26T00:00:00Z') });
    const row = (await database.query('SELECT status,last_snapshot_id,closed_snapshot_id FROM evimed_geo.errors WHERE id=$1', [errorId])).rows[0];
    assert.equal(interleaved, true); assert.equal(row.status, 'awaiting_remeasure'); assert.equal(row.last_snapshot_id, 'race_wrong'); assert.equal(row.closed_snapshot_id, null);
  } finally { store.projectContext = original; }
});
