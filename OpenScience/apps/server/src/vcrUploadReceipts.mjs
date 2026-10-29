/** Successful authenticated uploads retain original bytes without publishing them to the knowledge base.
 * Uses the existing account/project document ledger and project storage deletion lifecycle. */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { HttpError, resolveScopedPath, writeFileAtomicNoFollow } from './security.mjs';
const digest = value => createHash('sha256').update(value).digest('hex');
const recordType = 'vcr-upload-original';

export function createVcrUploadReceipts({ documents, sources, write }) {
  return {
    async record(project, { name, bytes, sessionId = null }) {
      if (!Buffer.isBuffer(bytes) || !bytes.length || typeof name !== 'string') return null;
      const basename = path.basename(name.replaceAll('\\', '/'));
      if (!basename || basename === '.' || basename === '..') return null;
      const sha256 = digest(bytes);
      const id = `upl_${digest(`${project.id}\0${sha256}\0${basename}\0${sessionId ?? ''}`).slice(0, 40)}`;
      const relative = `.evimed-upload-originals/${sha256}/${basename}`;
      const existing = await documents.get(project.userId, 'preferences', id);
      if (existing?.payload?.recordType === recordType && existing.projectId === project.id) return { sourceId: id, generation: 1, sha256 };
      if (write) await write(project, relative, bytes);
      else await writeFileAtomicNoFollow(project.baseDir, resolveScopedPath(project.baseDir, relative), bytes, { mode: 0o600 });
      try {
        await documents.put(project.userId, 'preferences', id, { recordType, generation: 1, connector: { type: 'upload' }, paths: [relative],
          fingerprint: { sha256, size: bytes.length }, sessionId }, { projectId: project.id, expectedRevision: 0 });
      } catch (error) {
        if (error?.code !== 'product_revision_conflict') throw error;
        const concurrent = await documents.get(project.userId, 'preferences', id);
        if (concurrent?.projectId !== project.id || concurrent.payload?.recordType !== recordType || concurrent.payload.fingerprint?.sha256 !== sha256) throw error;
      }
      return { sourceId: id, generation: 1, sha256 };
    },
    async get(userId, sourceId) {
      if (!String(sourceId).startsWith('upl_')) {
        const source = await sources?.get(userId, sourceId);
        return source ? { ...source, userId: source.userId ?? userId } : null;
      }
      const row = await documents.get(userId, 'preferences', sourceId);
      return row?.payload?.recordType === recordType ? { ...row, userId } : null;
    },
    async list(userId, options) {
      if (options.kind === 'sources') {
        const page = await sources?.list(userId, { projectId: options.projectId, limit: options.limit ?? 20, cursor: options.cursor ?? null })
          ?? { items: [], nextCursor: null };
        return { ...page, items: page.items.map(row => ({ ...row, userId: row.userId ?? userId })) };
      }
      let after = null;
      if (options.cursor) {
        try {
          after = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8'));
          if (!Array.isArray(after) || after.length !== 2 || typeof after[0] !== 'string' || !Number.isFinite(Date.parse(after[0]))
            || typeof after[1] !== 'string' || !/^[A-Za-z0-9_.:@-]{1,160}$/.test(after[1])) throw new Error('Invalid cursor');
        } catch { throw new HttpError(400, 'vcr_read_filter_invalid', 'Read data_intake with the exact returned cursor.'); }
      }
      const limit = options.limit ?? 20;
      // Filter native session provenance before LIMIT. Explicit owned ids remain reusable in another
      // conversation; automatic discovery stays with this root plus project-level ordinary uploads.
      const result = await documents.database.query(`SELECT id,project_id,payload,created_at::text AS cursor_created_at
        FROM evimed_product.documents WHERE user_id=$1 AND project_id=$2 AND kind='preferences' AND deleted_at IS NULL
        AND payload->>'recordType'=$3 AND (payload->>'sessionId' IS NULL OR payload->>'sessionId'=$4)
        AND ($5::timestamptz IS NULL OR (created_at,id)<($5::timestamptz,$6::text))
        ORDER BY created_at DESC,id DESC LIMIT $7`,
      [userId, options.projectId, recordType, options.sessionId ?? null, after?.[0] ?? null, after?.[1] ?? null, limit + 1]);
      const rows = result.rows.slice(0, limit);
      const last = rows.at(-1);
      return { items: rows.map(row => ({ id: row.id, projectId: row.project_id, userId, payload: row.payload })),
        nextCursor: result.rows.length > limit && last ? Buffer.from(JSON.stringify([last.cursor_created_at, last.id])).toString('base64url') : null };
    },
  };
}
