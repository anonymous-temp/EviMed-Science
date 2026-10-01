import assert from 'node:assert/strict';
import { before, after, beforeEach, test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { prepareEvidenceImport, applyEvidenceImport } from '../../../scripts/ops/import-evidence-content.mjs';
import { createStore } from '../src/store.mjs';
import { EvidenceZoneService } from '../src/evidenceZoneService.mjs';
import { evidenceHash } from '../src/evidenceCardContent.mjs';
import { migrateFrontier } from '../src/frontierPersistence.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const pgOptions = { skip: !url && 'local PostgreSQL required' };
let isolated, store, service, directory, paths;
const owner = { id: 'content-import-owner' };
const fixtureAuthor = { kind: 'ai', name: 'Fixture author AI', model: 'fixture-author-model' };
const fixtureReviewer = { kind: 'ai', name: 'Fixture independent reviewer AI', model: 'fixture-review-model' };

async function fixtures(directory) {
  const document = 'This synthetic randomized study observed twelve events among one hundred adults.';
  const excerpt = 'twelve events among one hundred adults';
  await writeFile(join(directory, 'source.txt'), document);
  const source = { id: 'fixture-source', title: 'Synthetic study', url: 'https://example.org/primary', excerpt, sha256: evidenceHash(document), checkedAt: '2026-10-01T00:00:00Z', coverage: 'abstract' };
  const seed = { schemaVersion: 1, zones: [{ key: 'af-anticoagulation', title: 'Synthetic zone', description: 'Fixture only', background: 'Synthetic background', state: 'published', requestId: 'fixture-evidence-zone' }], cards: [{ key: 'fixture-card', zoneKey: 'af-anticoagulation', title: 'Synthetic question', summary: 'Synthetic answer', body: 'A supplementary exercise.', subtype: 'academic', limitations: 'Synthetic fixture only.', provenance: 'Test fixture; no clinical claim.', state: 'published', requestId: 'fixture-evidence-card', content: { question: 'Synthetic question', answer: 'Synthetic answer', population: 'Synthetic adults' }, sources: [source], editorial: { author: fixtureAuthor, status: 'review-pending', sourceCheckedAt: '2026-10-01T00:00:00Z', findings: [] } }] };
  const manifest = { schemaVersion: 2, sourceDirectory: 'nonexistent-default-cache', sources: [{ sourceId: source.id, coverage: source.coverage, quote: excerpt, quoteSha256: evidenceHash(excerpt), documentTextPath: 'source.txt', documentTextSha256: source.sha256, rawDocumentPath: 'source.txt', fetchedSha256: source.sha256 }] };
  const paths = { seedFile: join(directory, 'seed.json'), manifestFile: join(directory, 'manifest.json'), sourceDirectory: directory };
  await writeFile(paths.seedFile, JSON.stringify(seed)); await writeFile(paths.manifestFile, JSON.stringify(manifest));
  const prepared = await prepareEvidenceImport(paths);
  paths.reviewFile = join(directory, 'review.json');
  await writeFile(paths.reviewFile, JSON.stringify({ reviewer: fixtureReviewer, reviewedAt: '2026-10-01T01:00:00Z', cards: prepared.cards.map(card => ({ key: card.key, contentHash: card.contentHash, findings: [] })) }));
  return paths;
}

before(async () => {
  if (!url) return;
  isolated = await createGeoTestDatabase(url, 'contentimport');
  store = createStore({ stateStore: 'postgres', databaseUrl: isolated.url, databasePoolMax: 4, databaseConnectionTimeoutMs: 2000, dataDir: await mkdtemp(join(tmpdir(), 'evidence-import-users-')) });
  await migrateFrontier(store.database, { dimension: 1024 });
  await store.database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Import Owner','development')", [owner.id]);
  service = new EvidenceZoneService({ database: store.database }); await service.ready();
});
after(async () => { const dataDir = store?.config.dataDir; await store?.close(); await isolated?.drop(); if (dataDir) await rm(dataDir, { recursive: true, force: true }); });
beforeEach(async () => {
  if (!store) return;
  await store.database.query('TRUNCATE evimed_frontier.evidence_zones CASCADE');
  await store.database.query("DELETE FROM evimed_control.users WHERE id IN ('evidence-editor-ai','evidence-review-ai')");
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = await mkdtemp(join(tmpdir(), 'evidence-import-fixture-')); paths = await fixtures(directory);
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
const prepare = () => prepareEvidenceImport(paths);
const apply = prepared => applyEvidenceImport(prepared, { store, ownerId: owner.id, enableUpdates: true });
const currentCard = async () => (await store.database.query('SELECT * FROM evimed_frontier.evidence_cards')).rows[0];

test('portable source override validates retained bytes and detects changed source text without a database', async () => {
  const local = await mkdtemp(join(tmpdir(), 'evidence-import-portable-'));
  try { const input = await fixtures(local); const prepared = await prepareEvidenceImport(input); assert.equal(prepared.cards.length, 1); assert.equal(prepared.review.reviewer.model, fixtureReviewer.model); await writeFile(join(local, 'source.txt'), 'Changed retained bytes'); await assert.rejects(prepareEvidenceImport(input), /source text hash mismatch/); }
  finally { await rm(local, { recursive: true, force: true }); }
});
test('real PostgreSQL repeat import keeps one card, one revision and honest reusable AI actors', pgOptions, async () => {
  const prepared = await prepare(), first = await apply(prepared), second = await apply(prepared);
  assert.equal(first.cardsCreated, 1); assert.equal(first.zonesCreated, 1); assert.equal(second.unchanged, 2); assert.equal(second.cardsUpdated, 0); assert.equal(second.settingsUpdated, 0);
  const card = await currentCard(); assert.equal(card.revision, 1); assert.equal(card.editorial.contentHash, prepared.cards[0].contentHash); assert.equal(card.editorial.author.userId, 'evidence-editor-ai'); assert.equal(card.editorial.reviewer.userId, 'evidence-review-ai'); assert.equal(card.editorial.reviewRevision, 1);
  assert.equal(Number((await store.database.query('SELECT count(*) AS n FROM evimed_frontier.evidence_card_revisions')).rows[0].n), 1);
  assert.equal(Number((await store.database.query("SELECT count(*) AS n FROM evimed_control.users WHERE id LIKE 'evidence-%-ai' AND auth_type='local'")).rows[0].n), 2);
  const automation = (await store.database.query('SELECT * FROM evimed_frontier.evidence_automation')).rows[0]; assert.equal(automation.max_cards_per_run, 2); assert.equal(automation.interval_hours, 24);
});
test('independent review hash mismatch stops before actor or content writes', pgOptions, async () => {
  await writeFile(paths.reviewFile, JSON.stringify({ reviewer: fixtureReviewer, reviewedAt: '2026-10-01T01:00:00Z', cards: [{ key: 'fixture-card', contentHash: evidenceHash('wrong'), findings: [] }] }));
  await assert.rejects(prepare(), /Independent review hash mismatch/);
  assert.equal(Number((await store.database.query('SELECT count(*) AS n FROM evimed_frontier.evidence_cards')).rows[0].n), 0);
  assert.equal(Number((await store.database.query("SELECT count(*) AS n FROM evimed_control.users WHERE id LIKE 'evidence-%-ai'")).rows[0].n), 0);
});
test('manual edits refuse overwrite until the operator supplies the exact optimistic revision', pgOptions, async () => {
  const prepared = await prepare(); await apply(prepared); let card = await currentCard();
  await service.save(owner, { expectedRevision: card.revision, summary: 'Manual correction' }, card.zone_id, card.id);
  await assert.rejects(apply(prepared), /changed; provide its expected revision/); card = await currentCard(); assert.equal(card.summary, 'Manual correction'); assert.equal(card.revision, 2);
  await assert.rejects(applyEvidenceImport(prepared, { store, ownerId: owner.id, expectedRevisions: { cards: { 'fixture-card': 1 } } }), /changed; provide its expected revision/);
  const authorized = await applyEvidenceImport(prepared, { store, ownerId: owner.id, expectedRevisions: { cards: { 'fixture-card': 2 } } }); assert.equal(authorized.cardsUpdated, 1); card = await currentCard(); assert.equal(card.summary, 'Synthetic answer'); assert.equal(card.revision, 3);
});
test('automated changes also require an explicit current revision for reimport', pgOptions, async () => {
  const prepared = await prepare(); await apply(prepared); const card = await currentCard();
  await service.saveEditorial(owner, { expectedRevision: card.revision, body: 'New automatic source interpretation.', editorial: { author: fixtureAuthor, status: 'review-pending', findings: [] } }, card.zone_id, card.id, false, 'model');
  await assert.rejects(apply(prepared), /changed; provide its expected revision/); assert.equal((await currentCard()).body, 'New automatic source interpretation.');
});
test('an existing human account using an AI actor username is not reused or overwritten', pgOptions, async () => {
  await store.createUser('evidence-editor-ai', randomBytes(48).toString('base64url'), 'A real user');
  await assert.rejects(apply(await prepare()), /AI actor account identity collision/);
  assert.equal(Number((await store.database.query('SELECT count(*) AS n FROM evimed_frontier.evidence_cards')).rows[0].n), 0);
  assert.equal(Number((await store.database.query('SELECT count(*) AS n FROM evimed_frontier.evidence_zones')).rows[0].n), 0);
});
