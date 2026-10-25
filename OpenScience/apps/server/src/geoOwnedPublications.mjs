import { createHash } from 'node:crypto';
import { HttpError } from './security.mjs';
import { migrateProductStore } from './productPersistence.mjs';
import { canonicalJson, geoOwnedLinkFromRow } from './geoStore.mjs';
import { geoReadTransactionActive, withGeoReadTransaction } from './geoReadScope.mjs';
import { geoMarketReadPageOptions, geoMarketReadPage, geoMarketReadTimestamp } from './geoMarketOperations.mjs';

const fail = (code = 'geo_owned_link_invalid', message = 'Invalid publication update.', status = 400) => new HttpError(status, code, message);
const hash = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
const idOf = (project, linkId) => `geo-owned-publication-${hash([project.id, linkId])}`;
const select = `SELECT l.*,${geoMarketReadTimestamp('l.created_at')} AS _cursor_at,a.title AS article_title,a.current_result_version_id,a.content_sha256 AS current_digest
  FROM evimed_geo.owned_links l LEFT JOIN evimed_geo.articles a ON a.id=l.article_id AND a.geo_project_id=l.geo_project_id AND a.user_id=l.user_id`;
const view = row => {
  const link = geoOwnedLinkFromRow(row);
  const known = Boolean(link.articleResultVersionId && link.articleDigest && row.current_result_version_id && row.current_digest);
  return { ...link, articleTitle: row.article_title ?? null, currentResultVersionId: row.current_result_version_id ?? null, currentDigest: row.current_digest ?? null,
    versionState: !known ? 'unknown' : link.articleResultVersionId === row.current_result_version_id && link.articleDigest === row.current_digest ? 'current' : 'update_needed' };
};
const receiptView = row => ({ revision: row.revision, recordedAt: new Date(row.recordedAt ?? row.updatedAt).toISOString(), ...row.payload.publication });
const publication = (row, basis) => ({ basis, linkId: row.id, url: row.url, articleId: row.article_id ?? null, resultVersionId: row.article_result_version_id ?? null,
  digest: row.article_digest ?? null, publishedAt: row.published_at instanceof Date ? row.published_at.toISOString() : row.published_at ?? null });

/** User-reported online updates pin a version; they never publish content or verify an external page. */
export class GeoOwnedPublications {
  constructor({ store, documents, now = () => new Date() }) { this.store = store; this.documents = documents; this.now = now; }
  async firstPublishedAt(project) {
    await migrateProductStore(this.documents.database);
    const row = (await this.store.query(`SELECT min(r.payload#>>'{publication,publishedAt}') AS at
      FROM evimed_product.documents d JOIN evimed_product.revisions r ON r.user_id=d.user_id AND r.kind=d.kind AND r.id=d.id
      WHERE d.user_id=$1 AND d.project_id=$2 AND d.kind='knowledge' AND d.deleted_at IS NULL
        AND d.payload->>'recordType'='geo-owned-publication' AND d.payload->>'geoProjectId'=$3`, [project.userId, project.projectId, project.id])).rows[0];
    return row?.at && Number.isFinite(Date.parse(row.at)) ? new Date(row.at).toISOString() : null;
  }
  async list(project, input = {}) {
    if (Object.keys(input).some(key => !['cursor', 'limit'].includes(key))) throw fail();
    const page = geoMarketReadPageOptions(input, `owned-publications:${project.id}`);
    if (!geoReadTransactionActive(this.store)) return withGeoReadTransaction(this.store, () => this.list(project, input));
    const [rows, counts] = await Promise.all([
      this.store.query(`${select} WHERE l.geo_project_id=$1 AND l.user_id=$2 AND ($3::timestamptz IS NULL OR (l.created_at,l.id)<($3::timestamptz,$4::text)) ORDER BY l.created_at DESC,l.id DESC LIMIT $5`, [project.id, project.userId, page.at, page.id, page.limit + 1]),
      this.store.query('SELECT count(*)::integer AS n FROM evimed_geo.owned_links WHERE geo_project_id=$1 AND user_id=$2', [project.id, project.userId]),
    ]);
    return { ...geoMarketReadPage(rows.rows, page, view), total: counts.rows[0].n };
  }
  async detail(project, linkId, input = {}) {
    if (Object.keys(input).some(key => !['beforeRevision'].includes(key)) || input.beforeRevision != null && (!Number.isSafeInteger(Number(input.beforeRevision)) || Number(input.beforeRevision) < 1)) throw fail();
    const row = (await this.store.query(`${select} WHERE l.geo_project_id=$1 AND l.user_id=$2 AND l.id=$3`, [project.id, project.userId, linkId])).rows[0];
    if (!row) throw fail('geo_owned_link_invalid', 'This publication is unavailable.', 404);
    const record = await this.documents.get(project.userId, 'knowledge', idOf(project, linkId));
    const history = record ? await this.documents.history(project.userId, 'knowledge', record.id, { beforeRevision: input.beforeRevision == null ? null : Number(input.beforeRevision), limit: 30 }) : [];
    return { link: view(row), revision: record?.revision ?? 0, history: { items: history.map(receiptView), nextBeforeRevision: history.length === 30 ? history.at(-1).revision : null } };
  }
  async confirm(project, linkId, input) {
    const allowed = ['requestKey', 'expectedRevision', 'expectedResultVersionId', 'expectedDigest', 'resultVersionId', 'digest', 'publishedAt'];
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))
      || !/^[A-Za-z0-9_-]{1,160}$/.test(input.requestKey ?? '') || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
      || typeof input.resultVersionId !== 'string' || !input.resultVersionId || !/^[a-f0-9]{64}$/.test(input.digest ?? '')
      || !Object.hasOwn(input, 'expectedResultVersionId') || !Object.hasOwn(input, 'expectedDigest')
      || typeof input.publishedAt !== 'string' || !Number.isFinite(Date.parse(input.publishedAt)) || Date.parse(input.publishedAt) > this.now().getTime()) throw fail();
    await migrateProductStore(this.documents.database);
    const fingerprint = hash(input), id = idOf(project, linkId);
    return this.store.transaction(async client => {
      const row = (await client.query('SELECT * FROM evimed_geo.owned_links WHERE geo_project_id=$1 AND user_id=$2 AND id=$3 FOR UPDATE', [project.id, project.userId, linkId])).rows[0];
      if (!row) throw fail('geo_owned_link_invalid', 'This publication is unavailable.', 404);
      let record = (await client.query("SELECT * FROM evimed_product.documents WHERE user_id=$1 AND kind='knowledge' AND id=$2 AND deleted_at IS NULL FOR UPDATE", [project.userId, id])).rows[0];
      if (record?.payload.requestKey === input.requestKey) {
        if (record.payload.fingerprint !== fingerprint) throw fail('product_revision_conflict', 'This request already records another update.', 409);
        return receiptView({ ...record, updatedAt: record.updated_at });
      }
      if ((record?.revision ?? 0) !== input.expectedRevision || row.article_result_version_id !== input.expectedResultVersionId || row.article_digest !== input.expectedDigest) throw fail('product_revision_conflict', 'The publication changed; reload before recording its update.', 409);
      const article = (await client.query('SELECT current_result_version_id,content_sha256 FROM evimed_geo.articles WHERE geo_project_id=$1 AND id=$2 FOR SHARE', [project.id, row.article_id])).rows[0];
      if (!article || article.current_result_version_id !== input.resultVersionId || article.content_sha256 !== input.digest) throw fail('geo_article_head_changed', 'The article changed; reopen its current version.', 409);
      if (!record) {
        record = await this.documents.put(project.userId, 'knowledge', id, { recordType: 'geo-owned-publication', geoProjectId: project.id,
          publication: publication(row, 'legacy_record') }, { projectId: project.projectId, expectedRevision: 0, transactionClient: client });
      }
      const updated = (await client.query(`UPDATE evimed_geo.owned_links SET article_result_version_id=$4,article_digest=$5,published_at=$6,status='active',retired_at=NULL,updated_at=clock_timestamp()
        WHERE geo_project_id=$1 AND user_id=$2 AND id=$3 RETURNING *`, [project.id, project.userId, linkId, input.resultVersionId, input.digest, input.publishedAt])).rows[0];
      const saved = await this.documents.put(project.userId, 'knowledge', id, { recordType: 'geo-owned-publication', geoProjectId: project.id,
        requestKey: input.requestKey, fingerprint, actorId: project.actorId ?? project.userId, publication: publication(updated, 'user_reported_update') },
      { projectId: project.projectId, expectedRevision: record.revision, transactionClient: client });
      return receiptView(saved);
    });
  }
}
