import { createHash } from 'node:crypto';
import { canonicalJson } from './geoStore.mjs';
import { HttpError } from './security.mjs';
const hash = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const invalid = () => new HttpError(409, 'geo_signal_conflict', 'The preserved affected versions are unavailable.');
const large = () => new HttpError(422, 'geo_payload_invalid', 'The affected-version set exceeds the preserved signal limit.');

/** The existing document ledger preserves large impact sets atomically, without truncating targets. */
export function packGeoSignalTargets(project, id, basis) {
  if (bytes(basis) <= 180_000) return { basis, pages: [] };
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
