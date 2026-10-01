#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from '../../apps/server/src/config.mjs';
import { createStore } from '../../apps/server/src/store.mjs';
import { EvidenceZoneService, evidenceSourceUrl } from '../../apps/server/src/evidenceZoneService.mjs';
import { EvidenceEditorial } from '../../apps/server/src/evidenceEditorial.mjs';
import { evidenceHash, evidenceContentHash, evidenceStructuredContent, evidenceEditorialReceipt } from '../../apps/server/src/evidenceCardContent.mjs';

const workspace = fileURLToPath(new URL('../../../', import.meta.url));
const contentDirectory = fileURLToPath(new URL('../../content/evidence/', import.meta.url));
const check = (condition, message) => assert(condition, message);
const byteHash = bytes => createHash('sha256').update(bytes).digest('hex');
const field = (value, maximum, required = false) => {
  check(typeof value === 'string' && value.length <= maximum && (!required || value.trim()), 'Invalid content field.');
  return value.trim();
};
const stableId = (prefix, owner, requestId) => `${prefix}_${evidenceHash(`${owner}:${requestId}`).slice(0, 32)}`;
const request = value => { check(typeof value === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(value), 'Invalid stable request identity.'); return value; };
const json = async path => JSON.parse(await readFile(path, 'utf8'));

/** Validate all source files and scientific payloads before any database write. */
export async function prepareEvidenceImport({ seedFile = resolve(contentDirectory, 'seed-cards.json'), manifestFile = resolve(contentDirectory, 'source-manifest.json'), sourceDirectory, reviewFile } = {}) {
  const seed = await json(seedFile), manifest = await json(manifestFile);
  check(seed.schemaVersion === 1 && manifest.schemaVersion === 2, 'Unsupported seed or source manifest version.');
  check(Array.isArray(seed.zones) && seed.zones.length && Array.isArray(seed.cards) && seed.cards.length, 'Empty content package.');
  const sourceRoot = await realpath(resolve(sourceDirectory ?? resolve(workspace, manifest.sourceDirectory)));
  const readRetained = async name => {
    check(typeof name === 'string' && !isAbsolute(name), 'Retained paths must be relative to --source-dir.');
    const path = await realpath(resolve(sourceRoot, name)), rel = relative(sourceRoot, path);
    check(rel && !rel.startsWith('..') && !isAbsolute(rel), 'Source file leaves its private cache.');
    return readFile(path);
  };
  const retained = new Map();
  for (const source of manifest.sources) {
    check(!retained.has(source.sourceId), 'Duplicate source identity.');
    const documentText = (await readRetained(source.documentTextPath)).toString('utf8');
    check(evidenceHash(documentText) === source.documentTextSha256, 'Retained source text hash mismatch.');
    check(typeof source.quote === 'string' && source.quote.split(/\s+/).length <= 25 && documentText.includes(source.quote), 'Source quote does not match retained text.');
    check(evidenceHash(source.quote) === source.quoteSha256, 'Source quote hash mismatch.');
    if (source.rawDocumentPath) check(byteHash(await readRetained(source.rawDocumentPath)) === source.fetchedSha256, 'Fetched source bytes hash mismatch.');
    check(documentText.length <= 2000000, 'Retained source exceeds native storage limit.');
    retained.set(source.sourceId, { ...source, documentText });
  }
  const keys = new Set(), identities = new Set();
  const zones = seed.zones.map(zone => {
    check(typeof zone.key === 'string' && !keys.has(zone.key), 'Duplicate zone key.'); keys.add(zone.key);
    const payload = { title: field(zone.title, 300, true), description: field(zone.description, 12000), background: field(zone.background, 50000), state: zone.state, requestId: request(zone.requestId) };
    check(payload.state === 'published', 'Seed zones must be published.');
    check(!identities.has(payload.requestId), 'Duplicate request identity.'); identities.add(payload.requestId);
    return { key: zone.key, payload };
  });
  const cardKeys = new Set();
  const cards = seed.cards.map(card => {
    check(typeof card.key === 'string' && !cardKeys.has(card.key) && keys.has(card.zoneKey), 'Invalid or duplicate card identity.'); cardKeys.add(card.key);
    const sources = card.sources.map(source => {
      const entry = retained.get(source.id);
      check(entry && source.sha256 === entry.documentTextSha256 && source.excerpt === entry.quote && source.coverage === entry.coverage, 'Card source differs from its manifest.');
      const result = { title: field(source.title, 500, true), url: evidenceSourceUrl(source.url), excerpt: field(source.excerpt, 12000), sha256: entry.documentTextSha256, coverage: entry.coverage, checkedAt: source.checkedAt, documentText: entry.documentText, ...(entry.fetchedSha256 ? { fetchedSha256: entry.fetchedSha256 } : {}) };
      check(['full-text', 'abstract', 'excerpt'].includes(result.coverage) && result.url && Number.isFinite(Date.parse(result.checkedAt)), 'Invalid source coverage or date.');
      return result;
    });
    const payload = { title: field(card.title, 300, true), subtype: card.subtype, summary: field(card.summary, 12000), body: field(card.body, 50000, true), limitations: field(card.limitations, 12000), provenance: field(card.provenance, 12000), sources, content: evidenceStructuredContent(card.content, sources.length), state: card.state, requestId: request(card.requestId) };
    check(['academic', 'knowledge'].includes(payload.subtype) && payload.state === 'published' && sources.length > 0 && sources.length <= 50, 'Invalid card publication.');
    check(!identities.has(payload.requestId), 'Duplicate request identity.'); identities.add(payload.requestId);
    check(card.editorial?.author?.kind === 'ai' && /\bAI\b/i.test(card.editorial.author.name) && typeof card.editorial.author.model === 'string' && card.editorial.author.model.trim(), 'Seed authors must identify their actual AI model.');
    check(card.editorial.status === 'review-pending' && !card.editorial.reviewer, 'Authors cannot sign an independent seed review.');
    evidenceEditorialReceipt(card.editorial, payload, 1);
    return { key: card.key, zoneKey: card.zoneKey, payload, author: card.editorial.author, sourceCheckedAt: card.editorial.sourceCheckedAt, contentHash: evidenceContentHash(payload) };
  });
  let review = null;
  if (reviewFile) {
    review = await json(reviewFile);
    check(review.reviewer?.kind === 'ai' && /\bAI\b/i.test(review.reviewer.name) && typeof review.reviewer.model === 'string' && review.reviewer.model.trim() && Number.isFinite(Date.parse(review.reviewedAt)), 'Independent reviewer identity or timestamp is invalid.');
    check(Array.isArray(review.cards) && review.cards.length === cards.length && new Set(review.cards.map(card => card.key)).size === cards.length, 'Independent review must cover each input card exactly once.');
    for (const card of cards) {
      const receipt = review.cards.find(receipt => receipt.key === card.key);
      check(receipt?.contentHash === card.contentHash, `Independent review hash mismatch for ${card.key}.`);
      check(Array.isArray(receipt.findings), 'Independent review findings must be an explicit array.');
      check(review.reviewer.name !== card.author.name, 'Author cannot be the independent reviewer.');
      evidenceEditorialReceipt({ author: card.author, reviewer: review.reviewer, status: 'ai-reviewed', contentHash: card.contentHash, reviewedAt: review.reviewedAt, sourceCheckedAt: card.sourceCheckedAt, findings: receipt.findings }, card.payload, 1);
    }
  }
  return { zones, cards, review, sourceCount: retained.size };
}

/** Preflight every existing row before actor creation or content mutation. */
export async function applyEvidenceImport(prepared, { store, ownerId, expectedRevisions = {}, enableUpdates = false }) {
  check(prepared.review, '--apply requires an independent --review-file.');
  check(store.stateStoreKind === 'postgres' && ownerId, 'Apply requires PostgreSQL and an existing owner.');
  const db = store.database;
  await db.migrate();
  const owner = (await db.query('SELECT id,name FROM evimed_control.users WHERE id=$1', [ownerId])).rows[0];
  check(owner, 'Existing owner was not found.');
  const service = new EvidenceZoneService({ database: db }); await service.ready();
  const operations = [];
  for (const zone of prepared.zones) {
    const id = stableId('ez', owner.id, zone.payload.requestId);
    const current = (await db.query('SELECT * FROM evimed_frontier.evidence_zones WHERE id=$1', [id])).rows[0];
    const same = current && ['title', 'description', 'background', 'state'].every(key => current[key] === zone.payload[key]);
    if (current && !same) check(expectedRevisions.zones?.[zone.key] === current.revision, `Zone ${zone.key} changed; provide its expected revision.`);
    operations.push({ type: 'zone', item: zone, id, current, same });
  }
  for (const card of prepared.cards) {
    const zone = operations.find(op => op.type === 'zone' && op.item.key === card.zoneKey);
    const id = stableId('ec', owner.id, card.payload.requestId);
    const current = (await db.query('SELECT * FROM evimed_frontier.evidence_cards WHERE id=$1', [id])).rows[0];
    check(!current || current.zone_id === zone.id, 'Card identity belongs to a different zone.');
    const same = current && evidenceContentHash(current) === card.contentHash && current.editorial?.status === 'ai-reviewed' && current.editorial.contentHash === card.contentHash;
    if (current && !same) check(expectedRevisions.cards?.[card.key] === current.revision, `Card ${card.key} changed; provide its expected revision.`);
    operations.push({ type: 'card', item: card, id, zoneId: zone.id, current, same });
  }
  const authorNames = new Set(prepared.cards.map(card => card.author.name));
  check(authorNames.size === 1, 'One import requires one explicit author actor.');
  const actors = [{ id: 'evidence-editor-ai', name: prepared.cards[0].author.name }, { id: 'evidence-review-ai', name: prepared.review.reviewer.name }];
  for (const actor of actors) {
    actor.existing = (await db.query('SELECT id,name,auth_type FROM evimed_control.users WHERE id=$1', [actor.id])).rows[0];
    check(!actor.existing || (actor.existing.name === actor.name && actor.existing.auth_type === 'local' && /\bAI\b/i.test(actor.existing.name)), 'AI actor account identity collision.');
  }
  for (const actor of actors) if (!actor.existing) await store.createUser(actor.id, randomBytes(48).toString('base64url'), actor.name);
  const result = { zonesCreated: 0, zonesUpdated: 0, cardsCreated: 0, cardsUpdated: 0, unchanged: 0, settingsUpdated: 0, cards: prepared.cards.map(card => ({ key: card.key, contentHash: card.contentHash })) };
  for (const operation of operations) {
    if (operation.same) { result.unchanged++; continue; }
    if (operation.type === 'zone') {
      await service.save(owner, { ...operation.item.payload, ...(operation.current ? { expectedRevision: operation.current.revision } : {}) }, operation.current ? operation.id : null);
      result[operation.current ? 'zonesUpdated' : 'zonesCreated']++;
    } else {
      const card = operation.item, reviewed = prepared.review.cards.find(receipt => receipt.key === card.key);
      const editorial = { author: { ...card.author, userId: actors[0].id }, reviewer: { ...prepared.review.reviewer, userId: actors[1].id }, status: 'ai-reviewed', contentHash: card.contentHash, reviewedAt: prepared.review.reviewedAt, sourceCheckedAt: card.sourceCheckedAt, findings: reviewed.findings };
      const saved = await service.saveEditorial(owner, { ...card.payload, editorial, ...(operation.current ? { expectedRevision: operation.current.revision } : {}) }, operation.zoneId, operation.current ? operation.id : null, !operation.current);
      check(saved.evidence.editorial.contentHash === card.contentHash, 'Native final content differs from the reviewed payload.');
      result[operation.current ? 'cardsUpdated' : 'cardsCreated']++;
    }
  }
  if (enableUpdates) {
    const editorial = new EvidenceEditorial({ database: db, service, editor: { available: false }, readSource: null });
    for (const operation of operations.filter(op => op.type === 'zone')) {
      const zone = (await service.detail(owner, operation.id)).zone;
      const desired = { enabled: true, query: { 'af-anticoagulation': 'atrial', 'cardiorenal-ckd': 'kidney', 'research-interpretation': 'randomized' }[operation.item.key] ?? operation.item.key, sourceTypes: ['journal', 'evidence-body', 'regulator'], intervalHours: 24, maxCardsPerRun: 2 };
      const current = (await editorial.automation(owner, zone.id)).automation;
      if (Object.keys(desired).some(key => JSON.stringify(current[key]) !== JSON.stringify(desired[key]))) {
        await editorial.automation(owner, zone.id, { ...desired, expectedRevision: zone.revision }, 'PUT'); result.settingsUpdated++;
      }
    }
  }
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const flags = new Set(['--apply', '--enable-updates']), values = new Set(['--owner', '--source-dir', '--review-file', '--seed-file', '--manifest-file', '--expected-revisions']);
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    check(flags.has(key) || values.has(key), 'Unknown import option.');
    check(args[key] === undefined, 'Duplicate import option.');
    args[key] = flags.has(key) ? true : argv[++index];
    check(args[key] && (flags.has(key) || !String(args[key]).startsWith('--')), 'Missing import option value.');
  }
  const prepared = await prepareEvidenceImport({ seedFile: args['--seed-file'], manifestFile: args['--manifest-file'], sourceDirectory: args['--source-dir'], reviewFile: args['--review-file'] });
  const plan = { dryRun: !args['--apply'], zoneCount: prepared.zones.length, cardCount: prepared.cards.length, sourceCount: prepared.sourceCount, independentReviewValidated: Boolean(prepared.review), cards: prepared.cards.map(card => ({ key: card.key, contentHash: card.contentHash })) };
  if (!args['--apply']) { console.log(JSON.stringify(plan, null, 2)); return plan; }
  check(args['--owner'] && args['--review-file'], '--apply requires --owner and --review-file.');
  const expectedRevisions = args['--expected-revisions'] ? await json(args['--expected-revisions']) : {};
  const config = loadConfig(); check(config.stateStore === 'postgres', 'Apply requires the deployed PostgreSQL store.');
  const store = createStore(config);
  try { const result = await applyEvidenceImport(prepared, { store, ownerId: args['--owner'], expectedRevisions, enableUpdates: Boolean(args['--enable-updates']) }); console.log(JSON.stringify(result, null, 2)); return result; }
  finally { await store.close(); }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.code === 'ERR_ASSERTION' ? error.message : error.code ?? 'Evidence import failed.'); process.exitCode = 1; });
}
