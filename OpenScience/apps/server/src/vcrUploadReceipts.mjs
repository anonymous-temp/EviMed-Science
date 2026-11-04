/** Successful authenticated uploads retain original bytes without publishing them to the knowledge base.
 * Uses the existing account/project document ledger and project storage deletion lifecycle. */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { HttpError, openScopedFileNoFollow, readStableFileHandle, resolveScopedPath, writeFileAtomicNoFollow } from './security.mjs';
import { VCR_DATA_INTAKE_CONTRACT } from './vcrDataIntake.mjs';
const digest = value => createHash('sha256').update(value).digest('hex');
const recordType = 'vcr-upload-original';
const tableFormats = new Set(VCR_DATA_INTAKE_CONTRACT.import.formats);
const patientTextFormats = new Set(['txt', 'md']);
/** A record as PDF, Word or a picture of a page: read at intake, by the plane's converter or the in-house parser (`vcrRecordExtract.mjs`). */
const patientBinaryFormats = new Set(['pdf', 'docx', 'png', 'jpg', 'jpeg', 'bmp', 'tif', 'tiff', 'webp']);
const patientFormats = new Set([...patientTextFormats, ...patientBinaryFormats]);
/** What is imported whole: a zip of notes, and a hospital's export (`import_standard`: FHIR as NDJSON, ADaM as SAS transport; a Bundle arrives as `json`, which is a table's receipt). */
const archiveFormats = new Set(['zip', 'ndjson', 'xpt']);
/** A table of notes is a table with a note in every row, far past what a table of values weighs; the job streams it, so only the plain table import keeps its own ceiling. */
const noteTableFormats = new Set(['csv', 'tsv', 'xlsx']);
const extension = name => path.posix.extname(name).slice(1).toLowerCase();
export const VCR_UPLOAD_ORIGINALS_DIR = '.evimed-upload-originals';
export const VCR_PATIENT_CONTEXT_MAX_BYTES = 16 * 1024 * 1024;
/** The parser's own ceiling on one file. */
export const VCR_PATIENT_RECORD_MAX_BYTES = 100 * 1024 * 1024;
/** What one original of a batch of notes may weigh: the upload path's own limits come first. */
export const VCR_NOTES_ORIGINAL_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const originalPath = (sha256, basename) => `${VCR_UPLOAD_ORIGINALS_DIR}/${sha256}/${basename}`;
const patientReceipt = row => row?.payload?.intake === 'patient_context';
const archiveReceipt = row => row?.payload?.intake === 'notes_archive';
const receiptHandle = row => ({ sourceId: row.id, generation: row.payload.generation, sha256: row.payload.fingerprint.sha256 });

function isPatientText(bytes) {
  if (bytes.length > VCR_PATIENT_CONTEXT_MAX_BYTES || bytes.includes(0)) return false;
  try {
    return Boolean(new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim());
  } catch {
    return false;
  }
}

async function readOriginal(project, relative, fingerprint, maxBytes) {
  try {
    const { handle, stat } = await openScopedFileNoFollow(project.baseDir, resolveScopedPath(project.baseDir, relative));
    try {
      if (stat.size !== fingerprint.size || stat.size > maxBytes) return null;
      const bytes = await readStableFileHandle(handle, stat);
      return digest(bytes) === fingerprint.sha256 ? bytes : null;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof HttpError || ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error?.code)) return null;
    throw error;
  }
}

export function createVcrUploadReceipts({ documents, sources, write, resolveProject = null }) {
  const findReceipt = async (userId, sourceId) => {
    const row = await documents.get(userId, 'preferences', sourceId);
    return row?.payload?.recordType === recordType ? { ...row, userId } : null;
  };
  return {
    async record(project, { name, bytes, sessionId = null }) {
      if (!Buffer.isBuffer(bytes) || !bytes.length || typeof name !== 'string') return null;
      const basename = path.basename(name.replaceAll('\\', '/'));
      if (!basename || basename === '.' || basename === '..') return null;
      const format = extension(basename);
      const patient = patientFormats.has(format);
      const archive = archiveFormats.has(format);
      if (patient && patientTextFormats.has(format) && !isPatientText(bytes)) return null;
      if (patient && patientBinaryFormats.has(format) && bytes.length > VCR_PATIENT_RECORD_MAX_BYTES) return null;
      if (archive && bytes.length > VCR_NOTES_ORIGINAL_MAX_BYTES) return null;
      if (!patient && !archive && (!tableFormats.has(format) || bytes.length > (noteTableFormats.has(format) ? VCR_NOTES_ORIGINAL_MAX_BYTES : VCR_DATA_INTAKE_CONTRACT.import.maxBytes))) return null;
      const sha256 = digest(bytes);
      const id = `upl_${digest(`${project.id}\0${sha256}\0${basename}\0${sessionId ?? ''}`).slice(0, 40)}`;
      const relative = originalPath(sha256, basename);
      const fingerprint = { sha256, size: bytes.length };
      const existing = await documents.get(project.userId, 'preferences', id);
      const sameReceipt = row => row?.payload?.recordType === recordType && row.projectId === project.id
        && row.payload.generation === 1 && row.payload.paths?.length === 1 && row.payload.paths[0] === relative
        && row.payload.fingerprint?.sha256 === sha256 && row.payload.fingerprint?.size === bytes.length
        && row.payload.sessionId === sessionId && patientReceipt(row) === patient && archiveReceipt(row) === archive;
      if (existing && !sameReceipt(existing)) throw new HttpError(409, 'vcr_upload_original_unavailable', 'The upload receipt could not be verified.');
      if (!existing || !await readOriginal(project, relative, fingerprint, bytes.length)) {
        if (write) await write(project, relative, bytes);
        else await writeFileAtomicNoFollow(project.baseDir, resolveScopedPath(project.baseDir, relative), bytes, { mode: 0o600 });
      }
      if (existing) return receiptHandle(existing);
      try {
        await documents.put(project.userId, 'preferences', id, { recordType, ...(patient ? { intake: 'patient_context' } : archive ? { intake: 'notes_archive' } : {}), generation: 1, connector: { type: 'upload' }, paths: [relative],
          fingerprint, sessionId }, { projectId: project.id, expectedRevision: 0 });
      } catch (error) {
        if (error?.code !== 'product_revision_conflict') throw error;
        const concurrent = await documents.get(project.userId, 'preferences', id);
        if (!sameReceipt(concurrent)) throw error;
      }
      return { sourceId: id, generation: 1, sha256 };
    },
    async get(userId, sourceId) {
      if (!String(sourceId).startsWith('upl_')) {
        const source = await sources?.get(userId, sourceId);
        return source ? { ...source, userId: source.userId ?? userId } : null;
      }
      const row = await findReceipt(userId, sourceId);
      return patientReceipt(row) || archiveReceipt(row) ? null : row;
    },
    /**
     * Where an original of this project stands, for a job that streams it: its own bytes are checked by whoever reads them, against the digest held here. No bytes are read here, and the
     * job's scenario names the handle and never the path, because a chart's file name is a person's more often than not.
     * @param {{ userId: string, projectId: string }} owner @param {{ sourceId: string, generation: number, sha256: string }} handle
     */
    async locate(owner, { sourceId, generation, sha256 }) {
      if (!resolveProject || !/^upl_[a-f0-9]{40}$/.test(String(sourceId))) return null;
      const row = await findReceipt(owner.userId, sourceId);
      if (!row || row.projectId !== owner.projectId || row.payload.generation !== generation || row.payload.fingerprint?.sha256 !== sha256 || row.payload.paths?.length !== 1) return null;
      const relative = row.payload.paths[0];
      const basename = path.posix.basename(relative);
      if (relative !== originalPath(sha256, basename)) return null;
      const project = await resolveProject(owner);
      if (project.id !== owner.projectId || project.userId !== owner.userId) return null;
      return { file: resolveScopedPath(project.baseDir, relative), baseDir: project.baseDir, basename, format: extension(basename), size: row.payload.fingerprint.size, sha256, intake: row.payload.intake ?? 'table' };
    },
    /** An original the notes import may take: a table, a record or an archive, of this conversation or of no conversation. @param {any} origin @param {string} sourceId */
    async notesHandle(origin, sourceId) {
      const row = await findReceipt(origin.userId, sourceId);
      if (!row || row.projectId !== origin.projectId || (row.payload.sessionId != null && row.payload.sessionId !== origin.rootSessionId)) return null;
      return receiptHandle(row);
    },
    async readPatientOriginal(origin, { sourceId, generation, sha256 }) {
      if (!resolveProject || !/^upl_[a-f0-9]{40}$/.test(sourceId) || !Number.isSafeInteger(generation)
        || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) return null;
      const permitted = row => patientReceipt(row) && row.projectId === origin.projectId
        && (row.payload.sessionId == null || row.payload.sessionId === origin.rootSessionId)
        && row.payload.connector?.type === 'upload' && row.payload.generation === generation
        && row.payload.fingerprint?.sha256 === sha256 && row.payload.paths?.length === 1;
      const source = await findReceipt(origin.userId, sourceId);
      if (!permitted(source)) return null;
      const relative = source.payload.paths[0];
      const basename = path.posix.basename(relative);
      const format = extension(basename);
      if (!patientFormats.has(format) || relative !== originalPath(sha256, basename)) return null;
      const project = await resolveProject(origin);
      if (project.id !== origin.projectId || project.userId !== origin.userId) return null;
      const text = patientTextFormats.has(format);
      const bytes = await readOriginal(project, relative, source.payload.fingerprint, text ? VCR_PATIENT_CONTEXT_MAX_BYTES : VCR_PATIENT_RECORD_MAX_BYTES);
      if (!bytes || (text && !isPatientText(bytes))) return null;
      const current = await findReceipt(origin.userId, sourceId);
      if (!permitted(current) || current.revision !== source.revision) return null;
      // The handle is the identity whatever the format: a retry, and evidence read from what this became, name the same original.
      return { bytes, format: text ? 'txt' : format, provenance: { kind: 'owned_upload', ...receiptHandle(source) } };
    },
    async patientCandidates(origin, { limit, cursor }) {
      const page = await this.list(origin.userId, { projectId: origin.projectId, sessionId: origin.rootSessionId, kind: 'patient_uploads', limit, cursor });
      return { uploads: page.items.map(row => ({ ...receiptHandle(row), name: path.posix.basename(row.payload.paths[0]), format: extension(row.payload.paths[0]) })), nextCursor: page.nextCursor };
    },
    /** What a notes import may start from: everything uploaded here but a table of values is read as such by `data_intake`. @param {any} origin @param {{ limit?: number, cursor?: string | null }} page */
    async noteCandidates(origin, { limit = 20, cursor = null } = {}) {
      const page = await this.list(origin.userId, { projectId: origin.projectId, sessionId: origin.rootSessionId, kind: 'note_uploads', limit, cursor });
      return { uploads: page.items.map(row => ({ ...receiptHandle(row), name: path.posix.basename(row.payload.paths[0]), format: extension(row.payload.paths[0]) })), nextCursor: page.nextCursor };
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
      // Filter intake type and session before LIMIT. Legacy table receipts lack an intake marker.
      const result = await documents.database.query(`SELECT id,project_id,payload,created_at::text AS cursor_created_at
        FROM evimed_product.documents WHERE user_id=$1 AND project_id=$2 AND kind='preferences' AND deleted_at IS NULL
        AND payload->>'recordType'=$3 AND (payload->>'sessionId' IS NULL OR payload->>'sessionId'=$4)
        AND COALESCE(payload->>'intake','table')=ANY($8::text[])
        AND ($5::timestamptz IS NULL OR (created_at,id)<($5::timestamptz,$6::text))
        ORDER BY created_at DESC,id DESC LIMIT $7`,
      [userId, options.projectId, recordType, options.sessionId ?? null, after?.[0] ?? null, after?.[1] ?? null, limit + 1,
        options.kind === 'patient_uploads' ? ['patient_context'] : options.kind === 'note_uploads' ? ['patient_context', 'notes_archive'] : ['table']]);
      const rows = result.rows.slice(0, limit);
      const last = rows.at(-1);
      return { items: rows.map(row => ({ id: row.id, projectId: row.project_id, userId, payload: row.payload })),
        nextCursor: result.rows.length > limit && last ? Buffer.from(JSON.stringify([last.cursor_created_at, last.id])).toString('base64url') : null };
    },
  };
}
