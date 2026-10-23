import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { ProductDocuments, ProductJobs } from '../src/productStore.mjs';
import { EvolutionService } from '../src/evolutionService.mjs';
import { createEvolutionSignals } from '../src/evolutionSignals.mjs';
import { GeoMeasureStore } from '../src/geoMeasureStore.mjs';
import { GeoStore } from '../src/geoStore.mjs';
import { createGeoLearningSignals } from '../src/geoLearningSignals.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';
import { seedGeoProject } from './helpers/geoMeasureFixtures.mjs';

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL ?? '';
const options = { skip: !url && 'A disposable localhost PostgreSQL database is required' };
let isolated, database, store, evolution, signals, learning;
const userId = 'learning_owner', projectId = 'learning_project', geoId = 'learning_geo';
const claim = { id: 'private_claim', key: 'private_claim_key', version: 1, quote: 'The approved population is adults.', sourceRef: 'doi:10.1234/private', statement: 'Adults only.' };
const wrong = { text: 'All ages may use it.', verdict: 'wrong', claimId: claim.id, claimKey: claim.key, evidence: claim.quote, errorType: 'dropped_condition', topic: 'indication' };
const facts = () => ({ parserVersion: 'geo-parse-2+geo-judge-test', judgedAt: '2026-10-24T01:00:00Z', statements: [wrong], assessmentBasis: [claim] });
before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, 'geolearning');
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 8, databaseConnectionTimeoutMs: 3000 });
  store = new GeoMeasureStore(database); await store.ready();
  await seedGeoProject(database, { id: geoId, userId, projectId, engines: ['deepseek'], groups: [], questions: [] });
  await database.query("INSERT INTO evimed_control.projects(user_id,id,name,quota_bytes) VALUES($1,'evimed-evolution','Learning',1048576)", [userId]);
  evolution = new EvolutionService({ documents: new ProductDocuments(database), jobs: new ProductJobs(database), ownerId: userId });
  signals = createEvolutionSignals({ service: evolution, capabilityIds: async () => ['geo-content'], operatorIds: () => [userId] });
  learning = createGeoLearningSignals({ database, signals: () => signals });
});
after(async () => { await database?.close(); await isolated?.drop(); });
async function snapshot(id) {
  await database.query("INSERT INTO evimed_geo.snapshots(id,user_id,geo_project_id,engine,status,answer_text) VALUES($1,$2,$3,'deepseek','valid','Private answer')", [id, userId, geoId]);
  return { id, userId, geoProjectId: geoId };
}

test('facts and private assessment history commit together; durable pending delivery reaches actual owner-scoped signals', options, async () => {
  const snap = await snapshot('private_snapshot');
  assert.equal(await store.writeFacts(snap, facts()), true);
  const saved = (await database.query("SELECT * FROM evimed_product.documents WHERE user_id=$1 AND payload->>'recordType'='geo-assessment'", [userId])).rows[0];
  assert.equal(saved.payload.publishedGeneration, 0);
  assert.equal(saved.project_id, projectId);
  assert.equal(saved.payload.contributions.length, 1);
  assert.equal(await learning.flush(), 1);
  assert.equal(await learning.flush(), 0);
  const rows = await evolution.list('signal', userId);
  assert.equal(rows.length, 1); assert.equal(rows[0].payload.kind, 'geo-misconception');
  assert.equal(rows[0].payload.codes.capability, 'geo-content');
  assert.equal(rows[0].payload.projectId, projectId);
  const summaries = await signals.aggregate();
  for (const privateValue of [wrong.text, claim.id, claim.sourceRef, snap.id, projectId, userId]) assert.ok(!JSON.stringify(summaries).includes(privateValue));
});

test('a failed facts transaction cannot leave a learning assessment; an unknown or unanchored judgment contributes nothing', options, async () => {
  const snap = await snapshot('rollback_snapshot');
  await assert.rejects(database.transaction(client => database.withTransactionClient(client, async () => {
    await store.writeFacts(snap, facts()); throw new Error('Injected rollback');
  })), /Injected rollback/);
  assert.equal((await database.query("SELECT count(*)::integer AS n FROM evimed_geo.facts WHERE snapshot_id=$1", [snap.id])).rows[0].n, 0);
  assert.equal((await database.query("SELECT count(*)::integer AS n FROM evimed_product.documents WHERE payload->>'snapshotId'=$1", [snap.id])).rows[0].n, 0);
  for (const [id, value] of [['unknown_snapshot', { ...facts(), judgedAt: null }], ['unanchored_snapshot', { ...facts(), assessmentBasis: [] }]]) {
    await store.writeFacts(await snapshot(id), value);
  }
  await learning.flush();
  assert.equal((await evolution.list('signal', userId)).length, 1);
});

test('exact assessment invalidation withdraws its signal without erasing historical evidence or another snapshot', options, async () => {
  await store.writeFacts(await snapshot('other_snapshot'), facts()); await learning.flush();
  assert.equal((await signals.aggregate())[0].payload.occurrences, 2);
  const record = (await database.query("SELECT * FROM evimed_product.documents WHERE payload->>'snapshotId'='private_snapshot'")).rows[0];
  assert.equal(await learning.invalidate({ userId, geoProjectId: geoId, snapshotId: 'private_snapshot', expectedVersion: 'stale', state: 'invalidated' }), false);
  assert.equal(await learning.invalidate({ userId, geoProjectId: geoId, snapshotId: 'private_snapshot', expectedVersion: record.payload.assessmentVersion, state: 'invalidated' }), true);
  await learning.flush();
  const rows = await evolution.list('signal', userId);
  assert.equal(rows.filter(row => row.payload.state === 'active').length, 1);
  assert.equal(rows.filter(row => row.payload.state === 'invalidated').length, 1);
  assert.equal((await evolution.list('signal-summary'))[0].payload.occurrences, 1, 'withdrawal and summary reconciliation commit together without a weekly aggregate');
  assert.equal((await signals.aggregate())[0].payload.occurrences, 1);
  const history = await evolution.documents.history(userId, 'knowledge', record.id);
  assert.ok(history.some(row => row.payload.state === 'active'));
  assert.ok(history.some(row => row.payload.state === 'invalidated'));
});

test('source correction suspends only its exact contribution and an unrelated source stays active', options, async () => {
  const otherClaim = { ...claim, id: 'independent_claim', key: 'independent_key', sourceRef: 'doi:10.1234/independent' };
  const snap = await snapshot('mixed_sources_snapshot');
  await store.writeFacts(snap, { ...facts(), statements: [wrong, { ...wrong, claimId: otherClaim.id, claimKey: otherClaim.key }], assessmentBasis: [claim, otherClaim] });
  await learning.flush();
  const changed = createGeoLearningSignals({ database, signals: () => signals, sourceChanges: {
    getMany: async () => new Map([[claim.sourceRef, { state: 'changed', changes: [{ kind: 'correction' }] }], [otherClaim.sourceRef, { state: 'clean', changes: [] }]]),
  } });
  assert.ok(await changed.reconcileDependencies() > 0); await changed.flush();
  const record = (await database.query("SELECT payload FROM evimed_product.documents WHERE payload->>'snapshotId'=$1", [snap.id])).rows[0].payload;
  assert.equal(record.contributions.find(entry => entry.claimId === claim.id).state, 'suspended');
  assert.equal(record.contributions.find(entry => entry.claimId === otherClaim.id).state, undefined);
  const rows = await evolution.list('signal', userId);
  assert.equal(rows.filter(row => row.payload.sourceEventId.includes(snap.id) && row.payload.state === 'active').length, 1);
  assert.equal(rows.filter(row => row.payload.sourceEventId.includes(snap.id) && row.payload.state === 'suspended').length, 1);
  await store.writeFacts(await snapshot('later_correct_answer'), { ...facts(), statements: [{ ...wrong, verdict: 'correct' }] });
  await changed.flush();
  assert.equal((await evolution.list('signal', userId)).filter(row => row.payload.sourceEventId.includes(snap.id) && row.payload.state === 'active').length, 1);
});

test('an unknown source lookup cannot activate a pending assessment, and legacy provenance is not invented from current claims', options, async () => {
  const snap = await snapshot('source_lookup_pending'); await store.writeFacts(snap, facts());
  const unavailable = createGeoLearningSignals({ database, signals: () => signals, sourceChanges: { getMany: async () => { throw new Error('Source lookup unavailable'); } } });
  await assert.rejects(unavailable.tick(), /Source lookup unavailable/);
  assert.ok(!(await evolution.list('signal', userId)).some(row => row.payload.sourceEventId.includes(snap.id)));
  const legacy = await snapshot('legacy_without_frozen_basis');
  await database.query("INSERT INTO evimed_geo.facts(snapshot_id,user_id,geo_project_id,statements,judged_at,parser_version) VALUES($1,$2,$3,$4::jsonb,now(),'geo-parse-1')", [legacy.id, userId, geoId, JSON.stringify([wrong])]);
  assert.equal(await learning.backfill(), 1);
  const preserved = (await database.query("SELECT payload FROM evimed_product.documents WHERE payload->>'snapshotId'=$1", [legacy.id])).rows[0].payload;
  assert.deepEqual(preserved.assessment.basis, []); assert.deepEqual(preserved.contributions, []);
});

test('an explicit unknown source fact stays pending until a recorded clean check exists', options, async () => {
  const snap = await snapshot('explicit_unknown_source'); await store.writeFacts(snap, facts());
  let state = 'unknown';
  const checked = createGeoLearningSignals({ database, signals: () => signals, sourceChanges: {
    getMany: async references => new Map(references.map(identifier => [identifier, { state, changes: [] }])),
  } });
  await checked.tick();
  assert.ok(!(await evolution.list('signal', userId)).some(row => row.payload.sourceEventId.includes(snap.id)));
  const held = (await database.query("SELECT payload FROM evimed_product.documents WHERE payload->>'snapshotId'=$1", [snap.id])).rows[0];
  assert.equal(held.payload.contributions[0].state, 'pending');
  state = 'clean'; await checked.tick();
  assert.ok((await evolution.list('signal', userId)).some(row => row.payload.sourceEventId.includes(snap.id) && row.payload.state === 'active'));
});

test('losing verification for the exact card claim suspends its contribution even when its text remains unchanged', options, async () => {
  const cardClaim = { ...claim, id: 'card_claim', key: 'card_claim_key', cardId: 'card_example', cardClaimId: 'card_statement', cardRevision: 1 };
  await database.query(`INSERT INTO evimed_geo.claims(id,user_id,geo_project_id,claim_key,version,statement,quote,source_ref,card_id,card_claim_id,card_revision)
    VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,$9,1)`, [cardClaim.id, userId, geoId, cardClaim.key, cardClaim.statement, cardClaim.quote, cardClaim.sourceRef, cardClaim.cardId, cardClaim.cardClaimId]);
  const snap = await snapshot('card_verification_removed');
  await store.writeFacts(snap, { ...facts(), statements: [{ ...wrong, claimId: cardClaim.id, claimKey: cardClaim.key }], assessmentBasis: [cardClaim] });
  const checked = createGeoLearningSignals({ database, signals: () => signals, sourceChanges: { getMany: async references => new Map(references.map(identifier => [identifier, { state: 'clean', changes: [] }])) } });
  await checked.tick();
  await database.query("UPDATE evimed_geo.claims SET card_revision=2 WHERE id=$1", [cardClaim.id]);
  await checked.tick();
  assert.equal((await evolution.list('signal', userId)).find(row => row.payload.sourceEventId.includes(snap.id)).payload.state, 'active');
  await new GeoStore({ database }).clearClaimCards(geoId, [cardClaim.id]);
  await checked.tick();
  assert.equal((await evolution.list('signal', userId)).find(row => row.payload.sourceEventId.includes(snap.id)).payload.state, 'suspended');
});

test('internal question-bank assessments and already-durable internal rows cannot poison customer delivery', options, async () => {
  const customer = await snapshot('customer_after_bank'); await store.writeFacts(customer, facts());
  for (const [id, project, internal] of [['internal_named', 'evimed-evidence', false], ['internal_flagged', 'bank-project', true]]) {
    await seedGeoProject(database, { id, userId, projectId: project, engines: ['deepseek'], groups: [], questions: [] });
    await database.query('UPDATE evimed_geo.projects SET internal=$2 WHERE id=$1', [id, internal]);
    await database.query("INSERT INTO evimed_geo.snapshots(id,user_id,geo_project_id,engine,status,answer_text) VALUES($1,$2,$3,'deepseek','valid','Private answer')", [`${id}_snapshot`, userId, id]);
    await store.writeFacts({ id: `${id}_snapshot`, userId, geoProjectId: id }, facts());
  }
  // A prior interrupted rollout may have persisted an internal assessment as a normal pending contribution.
  await database.query(`UPDATE evimed_product.documents SET payload=jsonb_set(jsonb_set(payload,'{state}','"active"'),'{publishedGeneration}','0')
    WHERE payload->>'snapshotId'='internal_named_snapshot'`);
  await learning.tick(); await learning.tick();
  const rows = await evolution.list('signal', userId);
  assert.ok(rows.some(row => row.payload.sourceEventId.includes(customer.id) && row.payload.state === 'active'));
  assert.ok(!rows.some(row => ['evimed-evidence', 'bank-project'].includes(row.payload.projectId)));
  const internalRows = (await database.query("SELECT payload FROM evimed_product.documents WHERE payload->>'geoProjectId'=ANY($1::text[])", [['internal_named', 'internal_flagged']])).rows;
  assert.ok(internalRows.every(row => row.payload.state === 'excluded' && row.payload.generation === row.payload.publishedGeneration));
});

test('a previously published customer contribution is withdrawn when its project becomes internal', options, async () => {
  const id = 'later_internal';
  await seedGeoProject(database, { id, userId, projectId: 'later-internal-project', engines: ['deepseek'], groups: [], questions: [] });
  await database.query("INSERT INTO evimed_geo.snapshots(id,user_id,geo_project_id,engine,status,answer_text) VALUES('later_internal_snapshot',$1,$2,'deepseek','valid','Private answer')", [userId, id]);
  await store.writeFacts({ id: 'later_internal_snapshot', userId, geoProjectId: id }, facts()); await learning.tick();
  assert.equal((await evolution.list('signal', userId)).find(row => row.payload.sourceEventId.includes('later_internal_snapshot')).payload.state, 'active');
  await database.query('UPDATE evimed_geo.projects SET internal=true WHERE id=$1', [id]);
  await learning.tick();
  assert.equal((await evolution.list('signal', userId)).find(row => row.payload.sourceEventId.includes('later_internal_snapshot')).payload.state, 'invalidated');
  const record = (await database.query("SELECT payload FROM evimed_product.documents WHERE payload->>'snapshotId'='later_internal_snapshot'")).rows[0].payload;
  assert.equal(record.state, 'excluded'); assert.equal(record.generation, record.publishedGeneration);
});

test('same-id claim variants keep separate source contributions and a withdrawal affects only its exact identity', options, async () => {
  const a = { ...claim, id: 'shared_variant', key: 'shared', version: 1, population: 'Adults', elements: { form: 'tablet' }, quote: 'Only adults may use tablets.', sourceRef: 'doi:10.1234/variant-adult' };
  const b = { ...a, version: 2, population: 'Children', elements: { form: 'solution' }, quote: 'Only children may use solution.', sourceRef: 'doi:10.1234/variant-child' };
  const statement = c => ({ ...wrong, claimId: c.id, claimKey: c.key, claimVersion: c.version,
    applicability: { population: c.population, elements: c.elements, inLabel: null, validUntil: null, evidenceLevel: null }, evidence: c.quote });
  await store.writeFacts(await snapshot('identity_sources_snapshot'), { ...facts(), statements: [statement(a), statement(b)], assessmentBasis: [a, b] });
  const corrected = createGeoLearningSignals({ database, signals: () => signals, sourceChanges: { getMany: async () => new Map([
    [a.sourceRef, { state: 'changed', changes: [{ kind: 'retraction' }] }], [b.sourceRef, { state: 'clean', changes: [] }],
  ]) } });
  await corrected.reconcileDependencies();
  const record = (await database.query("SELECT payload FROM evimed_product.documents WHERE payload->>'recordType'='geo-assessment' AND payload->>'snapshotId'='identity_sources_snapshot'")).rows[0].payload;
  assert.equal(record.contributions.length, 2);
  const adult = record.contributions.find(entry => JSON.parse(entry.claimIdentity).version === 1);
  const child = record.contributions.find(entry => JSON.parse(entry.claimIdentity).version === 2);
  assert.equal(adult.state, 'invalidated');
  assert.equal(child.state ?? 'active', 'active');
});
