import assert from 'node:assert/strict';
import { before, after, beforeEach, test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { PLATFORM_PUBLISHER_USER_ID } from '@evimed/domain';
import { prepareEvidenceImport, applyEvidenceImport, reownImportedZones } from '../../../scripts/ops/import-evidence-content.mjs';
import { reownOperatorImportedZones } from '../src/evidenceReown.mjs';
import { isOfficialZone } from '../src/evidenceEditorial.mjs';
import { createStore } from '../src/store.mjs';
import { EvidenceZoneService } from '../src/evidenceZoneService.mjs';
import { evidenceHash } from '../src/evidenceCardContent.mjs';
import { migrateFrontier } from '../src/frontierPersistence.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';

const url = process.env.OPEN_SCIENCE_TEST_POSTGRES_URL;
const pgOptions = { skip: !url && 'local PostgreSQL required' };
let isolated, store, service, directory, paths;
// The importer runs as the platform's publishing account (2026-10-05); `owner` is an operator account that an EARLIER import
// ran as, whose zones the re-owning step moves. `publisher` is the account a manual edit of an imported row acts as.
const owner = { id: 'content-import-owner' };
const publisher = { id: PLATFORM_PUBLISHER_USER_ID };
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
  // A test below deletes the operator to prove what the deletion takes; the next one starts with them back.
  await store.database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Import Owner','development') ON CONFLICT DO NOTHING", [owner.id]);
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = await mkdtemp(join(tmpdir(), 'evidence-import-fixture-')); paths = await fixtures(directory);
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });
const prepare = () => prepareEvidenceImport(paths);
const apply = prepared => applyEvidenceImport(prepared, { store, enableUpdates: true });
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
  // An official zone takes no write from a signed-in session (the publisher cannot sign in, and `owner` is not one of an official
  // zone's origins): a correction made by hand reaches it the way the operator's import does.
  await assert.rejects(service.save(publisher, { expectedRevision: card.revision, summary: 'Manual correction' }, card.zone_id, card.id), { code: 'evidence_write_origin_refused' });
  await service.saveEditorial(publisher, { expectedRevision: card.revision, summary: 'Manual correction' }, card.zone_id, card.id, false, 'import');
  await assert.rejects(apply(prepared), /changed; provide its expected revision/); card = await currentCard(); assert.equal(card.summary, 'Manual correction'); assert.equal(card.revision, 2);
  await assert.rejects(applyEvidenceImport(prepared, { store, expectedRevisions: { cards: { 'fixture-card': 1 } } }), /changed; provide its expected revision/);
  const authorized = await applyEvidenceImport(prepared, { store, expectedRevisions: { cards: { 'fixture-card': 2 } } }); assert.equal(authorized.cardsUpdated, 1); card = await currentCard(); assert.equal(card.summary, 'Synthetic answer'); assert.equal(card.revision, 3);
});
test('automated changes also require an explicit current revision for reimport', pgOptions, async () => {
  const prepared = await prepare(); await apply(prepared); const card = await currentCard();
  await service.saveEditorial(publisher, { expectedRevision: card.revision, body: 'New automatic source interpretation.', editorial: { author: fixtureAuthor, status: 'review-pending', findings: [] } }, card.zone_id, card.id, false, 'model');
  await assert.rejects(apply(prepared), /changed; provide its expected revision/); assert.equal((await currentCard()).body, 'New automatic source interpretation.');
});
test('an existing human account using an AI actor username is not reused or overwritten', pgOptions, async () => {
  await store.createUser('evidence-editor-ai', randomBytes(48).toString('base64url'), 'A real user');
  await assert.rejects(apply(await prepare()), /AI actor account identity collision/);
  assert.equal(Number((await store.database.query('SELECT count(*) AS n FROM evimed_frontier.evidence_cards')).rows[0].n), 0);
  assert.equal(Number((await store.database.query('SELECT count(*) AS n FROM evimed_frontier.evidence_zones')).rows[0].n), 0);
});

// 2026-10-05 (evidence-flywheel §3.3, B2): the earlier imports made the official zones under whichever operator account the importer
// named, and zones and cards reference their owner with ON DELETE CASCADE. These tests hold the fix: the import runs as the platform
// publisher, and the zones an earlier import made are moved to it, whole.
const earlierReader = { id: 'content-import-reader' };
const MARKING = 'ALTER TABLE evimed_frontier.evidence_zones ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT \'user\'';

/** What an import under `--owner` left behind before 2026-10-05: the seed's zone and card, owned and derived by an operator account,
 *  with the reader-side rows and the update settings the zone had gathered since. */
async function earlierImport(prepared, suffix = '') {
  const zone = prepared.zones[0], card = prepared.cards[0], db = store.database;
  const saved = (await service.save(owner, { ...zone.payload, requestId: `${zone.payload.requestId}${suffix}` }, null)).zone;
  const authored = (await service.saveEditorial(owner, { ...card.payload, requestId: `${card.payload.requestId}${suffix}`, editorial: { author: { ...card.author, userId: owner.id }, status: 'review-pending', sourceCheckedAt: card.sourceCheckedAt, findings: [] } }, saved.id, null, true)).evidence;
  await db.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Reader','development') ON CONFLICT DO NOTHING", [earlierReader.id]);
  await db.query('INSERT INTO evimed_frontier.evidence_zone_follows(user_id,zone_id) VALUES($1,$2)', [earlierReader.id, saved.id]);
  await db.query("INSERT INTO evimed_frontier.evidence_comments(id,card_id,user_id,text) VALUES($3,$1,$2,'A reader question')", [authored.id, earlierReader.id, `cm_${saved.id.slice(3, 12)}`]);
  await db.query("INSERT INTO evimed_frontier.evidence_reviews(card_id,user_id,card_revision,score,text) VALUES($1,$2,$3,4,'Useful')", [authored.id, earlierReader.id, authored.revision]);
  await db.query("INSERT INTO evimed_frontier.evidence_automation(zone_id,enabled,query) VALUES($1,true,'atrial')", [saved.id]);
  return { zoneId: saved.id, cardId: authored.id, revision: authored.revision };
}
const rows = async (sql, values = []) => (await store.database.query(sql, values)).rows;
const count = async (table, where = 'true', values = []) => Number((await rows(`SELECT count(*) AS n FROM evimed_frontier.${table} WHERE ${where}`, values))[0].n);

test('the import runs as the platform publisher and marks the zones it imports official, and a second run changes nothing', pgOptions, async () => {
  await store.database.query(MARKING);
  const prepared = await prepare(), first = await apply(prepared), second = await apply(prepared);
  const zone = (await rows('SELECT * FROM evimed_frontier.evidence_zones'))[0], card = await currentCard();
  assert.equal(zone.user_id, PLATFORM_PUBLISHER_USER_ID, 'the zone is the publisher\'s, not a person\'s');
  assert.equal(card.user_id, PLATFORM_PUBLISHER_USER_ID);
  assert.equal(zone.kind, 'official');
  assert.equal(first.zonesMarked, 1); assert.equal(second.zonesMarked, 0, 'marking is idempotent'); assert.equal(second.unchanged, 2);
});

test('--owner is no longer needed: the script says so and imports as the publisher', pgOptions, async () => {
  const { main } = await import('../../../scripts/ops/import-evidence-content.mjs');
  const written = []; const original = console.error; console.error = line => written.push(String(line));
  try { await main(['--seed-file', paths.seedFile, '--manifest-file', paths.manifestFile, '--source-dir', paths.sourceDirectory, '--owner', 'someone-else']); }
  finally { console.error = original; }
  assert.ok(written.some(line => /--owner is ignored/.test(line) && line.includes(PLATFORM_PUBLISHER_USER_ID)), 'the ignored flag is announced');
  assert.equal(await count('evidence_zones'), 0, 'a dry run wrote nothing');
});

test('re-owning moves the earlier zone and its cards to the publisher with every dependent row intact, once', pgOptions, async () => {
  await store.database.query(MARKING);
  const prepared = await prepare(), earlier = await earlierImport(prepared);
  const before = { revisions: await count('evidence_card_revisions'), follows: await count('evidence_zone_follows'), comments: await count('evidence_comments'), reviews: await count('evidence_reviews'), automation: await count('evidence_automation') };
  assert.deepEqual(Object.values(before), [1, 1, 1, 1, 1]);
  const requestIds = prepared.zones.map(zone => zone.payload.requestId);
  const moved = await reownImportedZones(store.database, { zoneRequestIds: requestIds, fromOwners: [owner.id] });
  assert.deepEqual(moved, { zonesFound: 1, zonesMoved: 1, cardsMoved: 1, zonesMarked: 1 });
  const zone = (await rows('SELECT * FROM evimed_frontier.evidence_zones WHERE id=$1', [earlier.zoneId]))[0], card = (await rows('SELECT * FROM evimed_frontier.evidence_cards WHERE id=$1', [earlier.cardId]))[0];
  assert.equal(zone.user_id, PLATFORM_PUBLISHER_USER_ID); assert.equal(card.user_id, PLATFORM_PUBLISHER_USER_ID);
  assert.equal(zone.kind, 'official'); assert.equal(card.revision, earlier.revision, 'a move is not an edit');
  assert.deepEqual({ revisions: await count('evidence_card_revisions'), follows: await count('evidence_zone_follows'), comments: await count('evidence_comments'), reviews: await count('evidence_reviews'), automation: await count('evidence_automation') }, before);
  assert.equal(await count('evidence_zone_follows', 'user_id=$1', [earlierReader.id]), 1, 'the reader still follows the same zone id');
  const again = await reownImportedZones(store.database, { zoneRequestIds: requestIds, fromOwners: [owner.id] });
  assert.deepEqual(again, { zonesFound: 1, zonesMoved: 0, cardsMoved: 0, zonesMarked: 0 }, 'idempotent');
});

test('deleting the operator that imported the zones removes them — until they are re-owned, and never after', pgOptions, async () => {
  await store.database.query(MARKING);
  const prepared = await prepare(), earlier = await earlierImport(prepared);
  const requestIds = prepared.zones.map(zone => zone.payload.requestId);
  await reownImportedZones(store.database, { zoneRequestIds: requestIds, fromOwners: [owner.id] });
  await store.deleteUser({ id: owner.id, authType: 'development' });
  assert.equal(await count('evidence_zones', 'id=$1', [earlier.zoneId]), 1, 'the platform\'s zone survives the person who imported it');
  assert.equal(await count('evidence_cards', 'id=$1', [earlier.cardId]), 1);
  assert.equal(await count('evidence_card_revisions'), 1); assert.equal(await count('evidence_automation'), 1);
  // The control: the cascade is real. Without re-owning, the same deletion takes the zone with it.
  await store.database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES($1,'Import Owner','development')", [owner.id]);
  const unmoved = await earlierImport(prepared, '-control');
  assert.equal(await count('evidence_zones', 'id=$1', [unmoved.zoneId]), 1);
  await store.deleteUser({ id: owner.id, authType: 'development' });
  assert.equal(await count('evidence_zones', 'id=$1', [unmoved.zoneId]), 0, 'without the move, deleting the operator deleted the published evidence');
});

test('an import after re-owning finds the zone under its old id and does not make a second one', pgOptions, async () => {
  await store.database.query(MARKING);
  const prepared = await prepare(), earlier = await earlierImport(prepared);
  // Not moved yet: the importer refuses to make a second copy beside the operator's.
  await assert.rejects(applyEvidenceImport(prepared, { store, legacyHints: [owner.id] }), /still owned by content-import-owner; run with --reown-from content-import-owner/);
  assert.equal(await count('evidence_zones'), 1);
  await reownImportedZones(store.database, { zoneRequestIds: prepared.zones.map(zone => zone.payload.requestId), fromOwners: [owner.id] });
  // The operator's card was written without the independent review's receipt, so the import updates it in place at its revision.
  const result = await applyEvidenceImport(prepared, { store, fromOwners: [owner.id], expectedRevisions: { cards: { 'fixture-card': earlier.revision } } });
  assert.equal(result.zonesCreated, 0); assert.equal(result.cardsCreated, 0); assert.equal(result.cardsUpdated, 1);
  assert.equal(await count('evidence_zones'), 1); assert.equal(await count('evidence_cards'), 1);
  assert.equal((await currentCard()).id, earlier.cardId, 'the card keeps its id and its links');
  // And with nothing naming the earlier owner, a re-run still finds nothing to make anew only because the zone is the publisher's by title.
  await assert.rejects(applyEvidenceImport(prepared, { store }), /exists under another identity; pass --reown-from/);
});

// 2026-10-06 review fix 10: the script writes official zones as the publisher with origin `import` (an official zone takes no write of
// origin `owner`), and a database that comes from release 6 has its operator-owned official zones re-owned at start, with no manual step.
test('an imported zone that changed is updated as the publisher with origin import, and a zone the import makes is official at once', pgOptions, async () => {
  const prepared = await prepare();
  const first = await applyEvidenceImport(prepared, { store });
  const created = (await rows('SELECT * FROM evimed_frontier.evidence_zones'))[0];
  assert.deepEqual([created.kind, created.user_id, first.zonesCreated, first.zonesMarked], ['official', PLATFORM_PUBLISHER_USER_ID, 1, 1], 'made official when it is made, with no marking step after');
  // The seed's zone text changes: the re-import takes the new text through the same door, at the revision it names.
  const seed = JSON.parse(await (await import('node:fs/promises')).readFile(paths.seedFile, 'utf8'));
  seed.zones[0].description = 'Fixture only, edited';
  await writeFile(paths.seedFile, JSON.stringify(seed));
  const edited = await prepareEvidenceImport(paths);
  await assert.rejects(applyEvidenceImport(edited, { store }), /Zone af-anticoagulation changed; provide its expected revision/);
  const second = await applyEvidenceImport(edited, { store, expectedRevisions: { zones: { 'af-anticoagulation': created.revision } } });
  assert.equal(second.zonesUpdated, 1);
  const after = (await rows('SELECT * FROM evimed_frontier.evidence_zones'))[0];
  assert.deepEqual([after.description, after.kind, after.user_id, after.revision], ['Fixture only, edited', 'official', PLATFORM_PUBLISHER_USER_ID, created.revision + 1]);
  // A zone the publisher owns that no build marked yet is made official before it is written, so the import still reaches it.
  await store.database.query("UPDATE evimed_frontier.evidence_zones SET kind='user'");
  seed.zones[0].description = 'Fixture only, edited again';
  await writeFile(paths.seedFile, JSON.stringify(seed));
  const third = await applyEvidenceImport(await prepareEvidenceImport(paths), { store, expectedRevisions: { zones: { 'af-anticoagulation': after.revision } } });
  assert.deepEqual([third.zonesUpdated, (await rows('SELECT kind FROM evimed_frontier.evidence_zones'))[0].kind], [1, 'official']);
});

/** What release 6 left: an operator-owned user zone holding a card the import reviewed, with the receipt it wrote. */
async function releaseSixZone(prepared, suffix, { reviewed = true, zoneOwner = owner.id } = {}) {
  const earlier = await earlierImport(prepared, suffix);
  if (reviewed) await store.database.query(`UPDATE evimed_frontier.evidence_cards SET editorial = editorial || '{"reviewOrigin":"import","status":"ai-reviewed"}'::jsonb WHERE id=$1`, [earlier.cardId]);
  if (zoneOwner !== owner.id) {
    await store.database.query('UPDATE evimed_frontier.evidence_zones SET user_id=$2 WHERE id=$1', [earlier.zoneId, zoneOwner]);
    await store.database.query('UPDATE evimed_frontier.evidence_cards SET user_id=$2 WHERE id=$1', [earlier.cardId, zoneOwner]);
  }
  return earlier;
}

test('at start the operator-owned zones that hold an imported card become the publisher\'s, once, said on stderr, and nothing else is touched', pgOptions, async () => {
  await store.database.query(MARKING);
  const prepared = await prepare();
  const imported = await releaseSixZone(prepared, '-a');
  // The controls: an operator's own zone with no imported card, and a researcher's zone that holds one (nobody the deployment names).
  const own = await releaseSixZone(prepared, '-b', { reviewed: false });
  await store.database.query("INSERT INTO evimed_control.users(id,name,auth_type) VALUES('content-import-researcher','Researcher','development') ON CONFLICT DO NOTHING");
  const researchers = await releaseSixZone(prepared, '-c', { zoneOwner: 'content-import-researcher' });
  const before = (await rows('SELECT id,kind,user_id FROM evimed_frontier.evidence_zones WHERE id=$1', [imported.zoneId]))[0];
  assert.deepEqual([before.kind, before.user_id], ['user', owner.id], 'the premise: an ordinary user zone in an operator\'s name');
  assert.equal(isOfficialZone(before), false, 'so its upkeep is the operator\'s to pay');
  const said = [];
  const result = await reownOperatorImportedZones(store.database, { operatorUsers: [owner.id], report: line => said.push(line) });
  assert.deepEqual(result, { zonesFound: 1, zonesMoved: 1, cardsMoved: 1, zonesMarked: 1 });
  assert.equal(said.length, 1); assert.match(said[0], /1 official zone\(s\) and 1 card\(s\) moved/);
  const moved = (await rows('SELECT * FROM evimed_frontier.evidence_zones WHERE id=$1', [imported.zoneId]))[0];
  assert.deepEqual([moved.kind, moved.user_id, isOfficialZone(moved)], ['official', PLATFORM_PUBLISHER_USER_ID, true]);
  // An official zone has no owner who could open it: once it is the platform's and published, it is read on the open internet (release 7
  // re-owned three such zones at start and left them platform-visible, so their cards were in the feed and their pages answered 404).
  assert.equal(moved.state === 'published' ? moved.visibility : 'internet', 'internet');
  const card = (await rows('SELECT * FROM evimed_frontier.evidence_cards WHERE id=$1', [imported.cardId]))[0];
  assert.deepEqual([card.user_id, card.revision], [PLATFORM_PUBLISHER_USER_ID, imported.revision], 'a move is not an edit; its follows and ids are as they were');
  assert.equal(await count('evidence_zone_follows', 'zone_id=$1', [imported.zoneId]), 1);
  assert.deepEqual((await rows('SELECT user_id,kind FROM evimed_frontier.evidence_zones WHERE id=$1', [own.zoneId]))[0], { user_id: owner.id, kind: 'user' }, 'an operator\'s own zone is not the platform\'s');
  assert.equal((await rows('SELECT user_id FROM evimed_frontier.evidence_zones WHERE id=$1', [researchers.zoneId]))[0].user_id, 'content-import-researcher', 'nor is an account the deployment does not name an operator');
  // Idempotent: the next start finds none and says nothing.
  const again = await reownOperatorImportedZones(store.database, { operatorUsers: [owner.id], report: line => said.push(line) });
  assert.deepEqual(again, { zonesFound: 0, zonesMoved: 0, cardsMoved: 0, zonesMarked: 0 });
  assert.equal(said.length, 1);
  // No operator named, nothing to look for and no table read; no publisher account yet, nothing moved and the next start tries again.
  const dead = { migrate: async () => { throw new Error('a table was read'); } };
  assert.equal(await reownOperatorImportedZones(dead, { operatorUsers: [] }), null);
  const lines = [];
  assert.equal(await reownOperatorImportedZones(store.database, { operatorUsers: [owner.id], publisherId: 'no-such-publisher', report: line => lines.push(line) }), null);
  assert.match(lines[0], /publisher account does not exist yet/);
});
