import { createHash } from 'node:crypto';
import { canonicalJson } from './geoStore.mjs';
import { HttpError } from './security.mjs';
const hash = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const invalid = () => new HttpError(409, 'geo_signal_conflict', 'The preserved affected versions are unavailable.');
const large = () => new HttpError(422, 'geo_payload_invalid', 'The affected-version set exceeds the preserved signal limit.');

/** The existing document ledger preserves large impact sets atomically, without truncating targets. */
export function packGeoSignalTargets(project, id, basis, { maxInlineBytes = 180_000 } = {}) {
  if (bytes(basis) <= maxInlineBytes) return { basis, pages: [] };
  if (!Array.isArray(basis.targets) || !basis.targets.length || basis.targets.length > 20_000) throw large();
  const chunks = [];
  let chunk = [], size = 0;
  for (const target of basis.targets) {
    const length = bytes(target);
    if (length > 140_000) throw large();
    if (chunk.length && size + length > 140_000) { chunks.push(chunk); chunk = []; size = 0; }
    chunk.push(target); size += length + 1;
  }
  if (chunk.length) chunks.push(chunk);
  if (chunks.length > 128) throw large();
  const pages = chunks.map((targets, index) => {
    const content = { recordType: 'geo-signal-target-page', schemaVersion: 1, geoId: project.id, signalId: id, index, targets };
    const digest = hash(content);
    return { kind: 'geo-signal', id: `gst_${hash([id, index, digest])}`, projectId: project.projectId, payload: { ...content, digest } };
  });
  const compact = { ...basis, targets: [], targetKinds: [...new Set(basis.targets.map(target => target.type))],
    targetPages: { count: basis.targets.length, digest: hash(basis.targets), pages: pages.map(page => ({ id: page.id, index: page.payload.index, count: page.payload.targets.length, digest: page.payload.digest })) } };
  if (bytes(compact) > 200_000 || bytes(pages) > 16 * 1024 * 1024) throw large();
  return { basis: compact, pages };
}

export async function readGeoSignalTargets(documents, project, row) {
  const manifest = row.payload.basis.targetPages;
  if (!manifest) return row.payload.basis.targets ?? [];
  if (!Array.isArray(manifest.pages) || !manifest.pages.length || manifest.pages.length > 128
    || !Number.isSafeInteger(manifest.count) || manifest.count < 1 || manifest.count > 20_000) throw invalid();
  const targets = [];
  for (const [index, descriptor] of manifest.pages.entries()) {
    if (descriptor.index !== index || descriptor.id !== `gst_${hash([row.id, index, descriptor.digest])}`) throw invalid();
    const page = await documents.get(project.userId, 'geo-signal', descriptor.id), payload = page?.payload;
    if (page?.projectId !== project.projectId || payload?.recordType !== 'geo-signal-target-page' || payload.schemaVersion !== 1
      || payload.geoId !== project.id || payload.signalId !== row.id || payload.index !== index || payload.digest !== descriptor.digest
      || !Array.isArray(payload.targets) || payload.targets.length !== descriptor.count) throw invalid();
    const { digest, ...content } = payload;
    if (hash(content) !== digest) throw invalid();
    targets.push(...payload.targets);
  }
  if (targets.length !== manifest.count || hash(targets) !== manifest.digest) throw invalid();
  return targets;
}

export const geoGroupSideRoot = (id, side) => `ggs_${hash([id, side])}`;
/** Independent sides retain their exact members; the event has one combined byte/page budget. */
export function packGeoGroupChange(project, id, basis) {
  const sides = {}, pages = [];
  for (const side of ['before', 'after']) {
    const input = basis.sides?.[side];
    if (!Array.isArray(input?.targets) || input.targets.length > 20_000) throw large();
    const packed = packGeoSignalTargets(project, geoGroupSideRoot(id, side), { targets: input.targets }, { maxInlineBytes: 60_000 });
    sides[side] = { ...input, ...packed.basis, count: input.targets.length, digest: hash(input.targets) };
    pages.push(...packed.pages);
  }
  const compact = { ...basis, sides };
  if (pages.length > 128 || bytes(pages) + bytes(compact) > 16 * 1024 * 1024 || bytes(compact) > 200_000) throw large();
  return { basis: compact, pages };
}
/** Shared by event detail, historical analytics and native context; never resolves live selections. */
export async function readGeoGroupChangeMembers(documents, project, row, { side = null, metricKey = null, offset = 0, limit = 50 } = {}) {
  if (!['before', 'after'].includes(side) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500
    || row.projectId !== project.projectId || row.payload.geoId !== project.id) throw invalid();
  const basis = row.payload.basis, input = basis.sides?.[side];
  if (!['geo-signal', 'geo-group-input'].includes(row.payload.recordType) || row.payload.recordType === 'geo-signal' && row.payload.kind !== 'group_changed'
    || row.payload.basisDigest !== hash(basis)) throw invalid();
  if (!input || !Number.isSafeInteger(input.count) || input.count < 0 || input.count > 20_000 || !/^[a-f0-9]{64}$/.test(input.digest ?? '')) throw invalid();
  const targets = await readGeoSignalTargets(documents, project, { id: geoGroupSideRoot(row.id, side), payload: { basis: input } });
  if (targets.length !== input.count || hash(targets) !== input.digest || targets.some(target => target.side !== side)
    || metricKey != null && !basis.cells?.some(cell => cell.key === metricKey)) throw invalid();
  const members = metricKey == null ? targets : targets.filter(target => target.metricKeys.includes(metricKey));
  const cell = basis.cells?.find(candidate => candidate.key === metricKey);
  if (cell && (cell[side].memberCount !== members.length || cell[side].memberDigest !== hash(members.map(target => target.snapshotId).sort()))) throw invalid();
  const next = offset + limit;
  return { side, items: members.slice(offset, next), total: members.length, digest: hash(members), fullDigest: input.digest,
    more: next < members.length, nextOffset: next < members.length ? next : null };
}
