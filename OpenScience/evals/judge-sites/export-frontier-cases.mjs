#!/usr/bin/env node
import fs from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { FRONTIER_LANES, FRONTIER_SPECIALTIES } from '../../packages/domain/src/frontierVocabulary.mjs';

const snapshotPath = process.argv[2];
if (!snapshotPath) throw new Error('Pass the authorized, read-only frontier A0 snapshot path.');
const bytes = await fs.readFile(snapshotPath);
const records = gunzipSync(bytes).toString('utf8').trim().split('\n').map(line => JSON.parse(line));
const metadata = records.find(row => row.kind === 'snapshot');
if (metadata?.containsUserData !== false) throw new Error('Only a snapshot explicitly excluding user data may be exported.');
const snapshotHash = createHash('sha256').update(bytes).digest('hex');
const incidents = JSON.parse(await fs.readFile(new URL('../frontier-editing/cases.json', import.meta.url), 'utf8'));
const provenance = (kind, id) => ({ corpus: 'frontier-a0-20261006', snapshotSha256: snapshotHash, kind, id, capturedAt: metadata.capturedAt });
const screenings = records.filter(row => row.kind === 'screening').map(row => row.row);
const choose = (predicate, count) => screenings.filter(predicate).slice(0, count);
// Recorded decisions are regression evidence, not independently adjudicated gold.
const selected = [...choose(row => row.state_reason === 'not-medical', 25), ...choose(row => row.state_reason === 'not-news', 25), ...choose(row => row.state === 'promoted' && row.lane, 50)];
const partial = row => row.state_reason === 'not-medical' ? { isMedical: false } : row.state_reason === 'not-news' ? { isNews: false } : { category: row.lane, ...(Array.isArray(row.specialties) ? { specialties: row.specialties } : {}) };
const j5 = [];
for (let start = 0; start < selected.length; start += 20) {
  const batch = selected.slice(start, start + 20);
  j5.push({ id: `snapshot-screen-batch-${start / 20 + 1}`, source: batch.map(row => provenance('screening', row.id)), labelBasis: 'incumbent-model', releaseEligible: false,
    sourceAllowedCategoriesUnknown: true, unknownExpectedFields: ['roundup', 'isNews except not-news', 'isMedical except not-medical'],
    input: { items: batch.map(row => ({ id: String(row.id), title: row.title_raw, summary: row.summary_raw ?? '', allowedCategories: [...FRONTIER_LANES], allowedSpecialties: [...FRONTIER_SPECIALTIES] })) },
    expectedPartial: { items: batch.map(row => ({ id: String(row.id), ...partial(row) })) } });
}
for (const incident of incidents.lane) j5.push({ id: `incident-${incident.id}`, source: { corpus: 'frontier-editing/cases.json', id: incident.id, publicId: incident.public_id }, labelBasis: 'incident-review', releaseEligible: true,
  input: { items: [{ id: '1', title: incident.screen.title, summary: incident.screen.excerpt ?? '', allowedCategories: [...FRONTIER_LANES], allowedSpecialties: [...FRONTIER_SPECIALTIES] }] },
  expectedNot: { items: [{ id: '1', category: incident.expect_not }] }, rationale: incident.why });

const j6 = [];
const pair = row => ({ title: row.titleZh ?? row.titleRaw ?? row.title_raw ?? '', summary: row.summaryZh ?? row.summary_zh ?? '',
  publishedAt: row.publishedAt ?? row.published_at ?? null, doi: row.doi ?? null, pmid: row.pmid ?? null, registryIds: row.registryIds ?? row.registry_ids ?? [] });
for (const incident of incidents.same_event) for (let index = 0; index < incident.candidates.length; index++) j6.push({
  id: `incident-${incident.id}-${index + 1}`, source: { corpus: 'frontier-editing/cases.json', id: incident.id }, labelBasis: incident.id.startsWith('synthetic-') ? 'authored-regression-control' : 'incident-review', releaseEligible: true,
  input: { left: pair(incident.report), right: pair(incident.candidates[index]) }, ...(incident.expect.length === 1 ? { expected: { relation: { yes: 'same', related: 'related', no: 'different' }[incident.expect[0]] } } : { expectedAny: { relation: incident.expect.map(verdict => ({ yes: 'same', related: 'related', no: 'different' }[verdict])) } }), rationale: incident.why });
const events = new Map();
for (const entry of records.filter(row => row.kind === 'event-item').map(row => row.row)) {
  const list = events.get(entry.event_id) ?? []; list.push(entry); events.set(entry.event_id, list);
}
const seen = new Set();
const add = (left, right, relation, labelBasis, releaseEligible, id, source) => {
  const key = [left.item_id, right.item_id].sort((a, b) => a - b).join(':');
  if (seen.has(key) || left.item_id === right.item_id) return;
  seen.add(key); j6.push({ id, source, labelBasis, releaseEligible, input: { left: pair(left), right: pair(right) }, expected: { relation } });
};
// Explicit identical DOI/PMID bonds establish identical publications, not difficult semantic calibration.
for (const [eventId, entries] of events) {
  const identifiers = new Map();
  for (const entry of entries) for (const identifier of [entry.doi ? `doi:${entry.doi.toLowerCase()}` : null, entry.pmid ? `pmid:${entry.pmid}` : null].filter(Boolean)) {
    const earlier = identifiers.get(identifier);
    if (earlier && j6.length < 30) add(earlier, entry, 'same', 'exact-publication-identifier', true, `identifier-${earlier.item_id}-${entry.item_id}`, { ...provenance('event-item', entry.item_id), eventId, identifier, difficulty: 'deterministic-control' });
    identifiers.set(identifier, entry);
  }
}
for (const link of records.filter(row => row.kind === 'event-link').map(row => row.row)) {
  const left = events.get(link.from_event_id)?.[0], right = events.get(link.to_event_id)?.[0];
  if (left && right && ['same', 'related'].includes(link.relation) && j6.length < 70) add(left, right, link.relation, 'incumbent-model', false, `link-${link.from_event_id}-${link.to_event_id}`, provenance('event-link', `${link.from_event_id}:${link.to_event_id}`));
}
for (const [eventId, entries] of events) {
  const left = entries[0];
  const right = entries.find(entry => entry.joined_by === 'model' && entry.item_id !== left.item_id);
  if (right && j6.length < 100) add(left, right, 'same', 'incumbent-model', false, `membership-${left.item_id}-${right.item_id}`, { ...provenance('event-item', right.item_id), eventId, joinedBy: right.joined_by });
}
for (const [site, cases] of [['J5', j5], ['J6', j6]]) {
  const directory = new URL(`${site}/`, import.meta.url);
  await fs.mkdir(directory, { recursive: true });
  const output = { schemaVersion: 1, site, provenance: { snapshotSha256: snapshotHash, capturedAt: metadata.capturedAt, containsUserData: false },
    coverage: { cases: cases.length, items: site === 'J5' ? cases.reduce((count, row) => count + row.input.items.length, 0) : cases.length,
      releaseEligible: cases.filter(row => row.releaseEligible).length, incumbentOnly: cases.filter(row => !row.releaseEligible).length,
      gaps: site === 'J5' ? ['Snapshot has no full original screening verdict or source lane configuration.', 'Negative-category incidents do not identify a unique positive category.', 'Incumbent partial labels cannot calibrate release thresholds.'] : ['Snapshot memberships provide positive incumbent labels, not independently reviewed semantic negatives.', 'Identifier controls are deterministic and do not establish difficult semantic accuracy.', 'No live Jev results have been collected.'] }, cases };
  await fs.writeFile(new URL('cases.json', directory), JSON.stringify(output, null, 2) + '\n');
  process.stdout.write(`${site}: ${output.coverage.items} items, ${output.coverage.releaseEligible} eligible cases, ${output.coverage.incumbentOnly} incumbent-only cases\n`);
}
