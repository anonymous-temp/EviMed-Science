import { createHash } from 'node:crypto';
import { HttpError } from './security.mjs';
import { migrateProductStore } from './productPersistence.mjs';
import { GEO_SOURCE_RELATIONSHIPS } from '@evimed/domain';

const invalid = () => new HttpError(400, 'geo_payload_invalid', 'Invalid source relationship annotation.');
const controls = value => [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);

/** Page keys preserve query identity; a single platform page never labels the whole host as owned. */
export function normalizeGeoOwnershipTarget(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['kind', 'value'].includes(key))
    || !['domain', 'page'].includes(input.kind) || typeof input.value !== 'string' || !input.value.trim() || input.value.length > 4000 || controls(input.value)) throw invalid();
  const value = input.value.trim();
  if (input.kind === 'domain' && /[/?#:@]/u.test(value)) throw invalid();
  let url;
  try { url = new URL(input.kind === 'domain' ? `https://${value}` : value); } catch { throw invalid(); }
  if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw invalid();
  url.hash = '';
  const display = url.href;
  url.searchParams.sort();
  return { kind: input.kind, value: input.kind === 'domain' ? url.hostname : display,
    key: input.kind === 'domain' ? url.hostname : url.href, hostname: url.hostname };
}
const recordId = (project, target) => `geo-source-ownership-${createHash('sha256').update(JSON.stringify([project.id, target.kind, target.key])).digest('hex')}`;
const view = row => ({ id: row.id, revision: row.revision, target: row.payload.target, relation: row.payload.relation,
  active: row.payload.active !== false, reason: row.payload.reason ?? null, reviewedAt: row.payload.reviewedAt, basis: 'user_annotation' });

/** User annotations share the existing revision ledger. They never rewrite historical sampling or medical evidence. */
export class GeoSourceOwnership {
  /** @param {{documents:import('./productStore.mjs').ProductDocuments,now?:()=>Date}} options */
  constructor({ documents, now = () => new Date() }) { this.documents = documents; this.now = now; }

  async record(project, target) {
    const row = await this.documents.get(project.userId, 'knowledge', recordId(project, target));
    if (row && (row.projectId !== project.projectId || row.payload.recordType !== 'geo-source-ownership' || row.payload.geoProjectId !== project.id)) {
      throw new HttpError(404, 'geo_source_not_found', 'Source annotation not found.');
    }
    return row;
  }

  async read(project, input) {
    const row = await this.record(project, normalizeGeoOwnershipTarget(input));
    return row ? view(row) : null;
  }

  async set(project, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['target', 'relation', 'active', 'reason', 'expectedRevision'].includes(key))
      || !GEO_SOURCE_RELATIONSHIPS.includes(input.relation) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
      || input.active !== undefined && typeof input.active !== 'boolean'
      || input.reason != null && (typeof input.reason !== 'string' || input.reason.length > 1000)) throw invalid();
    const target = normalizeGeoOwnershipTarget(input.target), existing = await this.record(project, target);
    if ((existing?.revision ?? 0) !== input.expectedRevision) throw new HttpError(409, 'product_revision_conflict', 'The source annotation changed; reload before saving.');
    const row = await this.documents.put(project.userId, 'knowledge', recordId(project, target), {
      recordType: 'geo-source-ownership', geoProjectId: project.id, target, relation: input.relation, active: input.active !== false,
      reason: input.reason?.trim() || null, reviewedAt: this.now().toISOString(), actorId: project.actorId ?? project.userId,
    }, { expectedRevision: input.expectedRevision, projectId: project.projectId });
    return view(row);
  }

  async history(project, input, { beforeRevision = null, limit = 50 } = {}) {
    const target = normalizeGeoOwnershipTarget(input), current = await this.record(project, target);
    if (!current) return { items: [], nextBeforeRevision: null };
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || beforeRevision !== null && (!Number.isSafeInteger(beforeRevision) || beforeRevision < 1)) throw invalid();
    const rows = await this.documents.history(project.userId, 'knowledge', current.id, { beforeRevision, limit });
    return { items: rows.map(row => view({ ...row, id: current.id })), nextBeforeRevision: rows.length === limit ? rows.at(-1).revision : null };
  }

  /** Resolve only actual requested pages; exact page overrides precede exact-host annotations. */
  async resolve(project, urls) {
    if (!Array.isArray(urls) || urls.length > 1000) throw invalid();
    if (!urls.length) return [];
    const targets = urls.map(url => {
      const target = normalizeGeoOwnershipTarget({ kind: 'page', value: url });
      return { url, page: recordId(project, target), domain: recordId(project, normalizeGeoOwnershipTarget({ kind: 'domain', value: target.hostname })) };
    });
    const ids = [...new Set(targets.flatMap(target => [target.page, target.domain]))];
    await migrateProductStore(this.documents.database);
    const saved = await this.documents.database.query(`SELECT id,revision,payload FROM evimed_product.documents
      WHERE user_id=$1 AND kind='knowledge' AND project_id=$2 AND deleted_at IS NULL
      AND payload->>'recordType'='geo-source-ownership' AND payload->>'geoProjectId'=$3 AND id=ANY($4::text[])`,
    [project.userId, project.projectId, project.id, ids]);
    const records = new Map(saved.rows.map(row => [row.id, row]));
    return targets.map(target => {
      const page = records.get(target.page), domain = records.get(target.domain);
      const selected = page && page.payload.active !== false ? page : domain && domain.payload.active !== false ? domain : null;
      return { url: target.url, relation: selected?.payload.relation ?? 'unknown', origin: selected ? selected.payload.target.kind : 'unknown',
        reference: selected ? { id: selected.id, revision: selected.revision } : null, reviewedAt: selected?.payload.reviewedAt ?? null, basis: selected ? 'user_annotation' : 'unclassified' };
    });
  }
}
