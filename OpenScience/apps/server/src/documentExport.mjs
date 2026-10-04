import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DOCUMENT_EXPORT_VERSION, DOCUMENT_RENDERER_VERSION, DOCUMENT_EXPORT_MIME, documentExportFormats, documentExportDigest } from '@evimed/domain';
import { HttpError, resolveScopedPath, openScopedFileNoFollow, assertNoSymlinkPath, readStableFileHandle } from './security.mjs';
import { migrateProductStore } from './productPersistence.mjs';
import { documentExportDirectory } from './documentRenderController.mjs';

export const exportHash = value => createHash('sha256').update(value).digest('hex');
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_ACCOUNT_EXPORT_BYTES = 1024 * 1024 * 1024;
const unavailable = () => new HttpError(404, 'document_export_unavailable', 'The document is unavailable.');
/** @param {string} root @param {string} file @param {number} limit */
async function boundedRead(root, file, limit) {
  const { handle, stat } = await openScopedFileNoFollow(root, file);
  try {
    if (stat.size > limit) throw new HttpError(413, 'document_export_too_large', 'Document exceeds the conversion limit.');
    const bytes = await readStableFileHandle(handle, stat);
    const after = await handle.stat();
    if (bytes.length > limit || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) throw new HttpError(409, 'document_source_changed', 'Document changed during export.');
    return bytes;
  } finally { await handle.close(); }
}
/** An interrupted transaction may leave the exact immutable bytes on disk. */
async function persistFrozenFile(root, target, bytes) {
  try { await fs.writeFile(target, bytes, { mode: 0o400, flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const expected = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    if (exportHash(await boundedRead(root, target, expected.length)) !== exportHash(expected)) throw new HttpError(409, 'document_input_changed', 'Frozen document changed.');
  }
}
/** Resolve an already-produced document without launching research. @param {any} project @param {any} source */
export async function freezeArtifactDocument(project, source) {
  if (Object.keys(source).some(key => !['artifactId','root','revision'].includes(key)) || !['workspace','base',undefined].includes(source.root)) throw unavailable();
  const root = source.root === 'base' ? project.baseDir : project.workspaceDir;
  const target = resolveScopedPath(root, source.artifactId);
  if (!/\.(md|markdown|txt)$/i.test(target)) throw new HttpError(400, 'document_format_unsupported', 'Convert a Markdown or text report.');
  const bytes = await boundedRead(root, target, 4 * 1024 * 1024);
  const revision = exportHash(bytes);
  if (source.revision && source.revision !== revision) throw new HttpError(409, 'document_source_changed', 'Document revision changed.');
  const canonicalMarkdown = bytes.toString('utf8');
  const assets = await freezeDocumentAssets(root, canonicalMarkdown, path.dirname(target));
  return { canonicalMarkdown, title: path.basename(target), cover: {}, revision, assets };
}


/**
 * A result version converted from its own preserved bytes, never from the workspace path it was captured at: the path may
 * have been overwritten since, and a Word or PDF of the successor of a correction must be the successor's. Only a Markdown
 * or text version converts. `revision` is the version's digest, so the conversion names exactly which bytes it is of.
 *
 * A figure the document embeds is read from the workspace and goes into the conversion only when `preserved` says it is
 * exactly a version captured beside the document; any other is left out, and the renderer says it could not place it. An
 * old document is not given a newer figure.
 * @param {any} project @param {{path:string,digest:string,versionId:string}} version @param {Buffer} bytes
 * @param {{preserved?:(asset:{path:string,sha256:string})=>Promise<boolean>}} [options]
 */
export async function freezeResultVersionDocument(project, version, bytes, { preserved = async () => false } = {}) {
  if (!/\.(md|markdown|txt)$/i.test(version.path)) throw new HttpError(400, 'document_format_unsupported', 'Convert a Markdown or text report.');
  if (bytes.length > 4 * 1024 * 1024) throw new HttpError(413, 'document_export_too_large', 'Document exceeds the conversion limit.');
  let canonicalMarkdown;
  try { canonicalMarkdown = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new HttpError(400, 'document_format_unsupported', 'Convert a Markdown or text report.'); }
  const directory = path.dirname(resolveScopedPath(project.workspaceDir, version.path));
  const found = await freezeDocumentAssets(project.workspaceDir, canonicalMarkdown, directory);
  const assets = [];
  for (const asset of found) {
    const relative = path.posix.join(path.posix.dirname(version.path), asset.path);
    if (await preserved({ path: relative, sha256: asset.sha256 })) assets.push(asset);
  }
  return { canonicalMarkdown, title: path.basename(version.path), cover: {}, revision: version.digest, assets };
}

/** Freeze only the verified local raster assets named by a canonical document. */
export async function freezeDocumentAssets(root, canonicalMarkdown, documentDirectory = root) {
  const assets = [];
  let total = 0;
  for (const match of canonicalMarkdown.matchAll(/!\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+[^)]*)?\)/g)) {
    const relative = match[1];
    if (!/^[^:?#\\]+\.(png|jpe?g)$/i.test(relative) || relative.startsWith('/') || relative.split('/').includes('..') || assets.some(asset => asset.path === relative)) continue;
    try {
      const data = await boundedRead(root, resolveScopedPath(documentDirectory, relative), 10 * 1024 * 1024);
      total += data.length;
      if (total > 20 * 1024 * 1024 || assets.length >= 40) throw new HttpError(413, 'document_export_too_large', 'Document assets exceed the conversion limit.');
      assets.push({ path: relative, sha256: exportHash(data), mime: /\.png$/i.test(relative) ? 'image/png' : 'image/jpeg', data });
    } catch (error) { if (!['ENOENT','file_not_found'].includes(error.code)) throw error; }
  }
  return assets;
}

/** Durable format conversion. All source authorization is re-evaluated on every read. */
export class DocumentExportService {
  /** @param {{config:any,documents:any,jobs:any,controller:any,resolveSource:Function,authorize:Function}} options */
  constructor({ config, documents, jobs, controller, resolveSource, authorize }) {
    this.config = config; this.documents = documents; this.jobs = jobs; this.controller = controller;
    this.resolveSource = resolveSource; this.authorize = authorize;
    this.database = documents.database;
  }
  async request(user, request) {
    if (!request || Object.keys(request).some(key => !['projectId','source','formats'].includes(key))) throw new HttpError(400, 'document_export_request_invalid', 'Invalid document export request.');
    let formats;
    try { formats = documentExportFormats(request.formats ?? ['docx','pdf','html']); } catch { throw new HttpError(400, 'document_export_format_invalid', 'Choose Word, PDF or HTML.'); }
    const source = await this.resolveSource(user, request);
    return this.requestFrozen(user, source, formats);
  }
  async requestFrozen(user, source, formats = ['docx','pdf','html']) {
    formats = documentExportFormats(formats);
    const { project, canonicalMarkdown, title, cover = {}, revision, assets = [], reference } = source;
    if (typeof canonicalMarkdown !== 'string' || Buffer.byteLength(canonicalMarkdown) > 4 * 1024 * 1024) throw new HttpError(413, 'document_export_too_large', 'Document exceeds the conversion limit.');
    const renderer = await this.controller.inspectRuntimeImage();
    const sourceBytes = Buffer.byteLength(canonicalMarkdown) + assets.reduce((total, asset) => total + asset.data.length, 0);
    const descriptors = assets.map(({ path: name, sha256, mime }) => ({ path: name, sha256, mime }));
    const document = { version: DOCUMENT_EXPORT_VERSION, rendererVersion: DOCUMENT_RENDERER_VERSION,
      rendererImage: renderer.imageId, canonicalMarkdown, title, cover, assets: descriptors, formats: documentExportFormats(formats), revision };
    const sourceDigest = exportHash(documentExportDigest(document));
    const ownerId = project.userId;
    const id = `dex_${exportHash(documentExportDigest({ ownerId, projectId: project.id, reference, sourceDigest })).slice(0,48)}`;
    const payload = { ownerId, requestedBy: user.id, projectId: project.id, source: reference, sourceDigest, sourceRevision: revision, title,
      rendererVersion: DOCUMENT_RENDERER_VERSION, reservedBytes: sourceBytes * 2 + MAX_OUTPUT_BYTES, sourceBytes, attempts: 0, state: 'queued', formats: Object.fromEntries(formats.map(format => [format, { state: 'queued' }])), jobId: null };
    await migrateProductStore(this.database);
    await this.database.transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`document-export-account:${ownerId}`]);
      const owner = await client.query('SELECT id FROM evimed_control.users WHERE id=$1 FOR KEY SHARE', [ownerId]);
      if (!owner.rows.length) throw unavailable();
      const parent = await client.query('SELECT id FROM evimed_control.projects WHERE user_id=$1 AND id=$2 FOR KEY SHARE', [ownerId, project.id]);
      if (!parent.rows.length) throw unavailable();
      const found = await client.query("SELECT id FROM evimed_product.documents WHERE user_id=$1 AND kind='document-export' AND id=$2 AND deleted_at IS NULL", [ownerId, id]);
      if (found.rows.length) return;
      const usage = await client.query("SELECT COALESCE(sum((payload->>'reservedBytes')::bigint),0) AS bytes FROM evimed_product.documents WHERE user_id=$1 AND kind='document-export' AND deleted_at IS NULL", [ownerId]);
      if (Number(usage.rows[0].bytes) + payload.reservedBytes > MAX_ACCOUNT_EXPORT_BYTES) throw new HttpError(413, 'document_export_quota', 'Document export storage is full.');
      const disk = await fs.statfs(this.config.dataDir);
      if (disk.bavail * disk.bsize < payload.reservedBytes + 512 * 1024 * 1024) throw new HttpError(503, 'document_export_capacity', 'Document export is waiting for disk space.');
      const root = documentExportDirectory(this.config, { ownerId, projectId: project.id, exportId: id });
      await assertNoSymlinkPath(this.config.dataDir, root, { allowMissingTail: true });
      await fs.mkdir(path.join(root, 'input'), { recursive: true, mode: 0o700 });
      await assertNoSymlinkPath(this.config.dataDir, root);
      for (const asset of assets) {
        const target = resolveScopedPath(path.join(root, 'input'), asset.path);
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await persistFrozenFile(root, target, asset.data);
      }
      const bytes = JSON.stringify({ ...document, sourceDigest });
      await persistFrozenFile(root, path.join(root, 'input', 'document.json'), bytes);
      payload.inputDigest = exportHash(bytes);
      const job = await this.jobs.enqueue(ownerId, 'document-export', { exportId: id, formats }, { projectId: project.id, idempotencyKey: id, transactionClient: client });
      payload.jobId = job.id;
      await this.documents.put(ownerId, 'document-export', id, payload, { expectedRevision: 0, projectId: project.id, transactionClient: client });
    });
    return this.view(await this.documents.get(ownerId, 'document-export', id));
  }
  view(row) {
    return { id: row.id, revision: row.revision, ...row.payload, ownerId: undefined, requestedBy: undefined, inputDigest: undefined, attempt: undefined };
  }
  async authorized(user, id) {
    await migrateProductStore(this.database);
    const row = (await this.database.query("SELECT user_id FROM evimed_product.documents WHERE kind='document-export' AND id=$1 AND deleted_at IS NULL LIMIT 1", [id])).rows[0];
    if (!row) throw unavailable();
    const record = await this.documents.get(row.user_id, 'document-export', id);
    if (!record) throw unavailable();
    try { await this.authorize(user, record.payload); } catch { throw unavailable(); }
    return record;
  }
  async status(user, id) {
    const row = await this.authorized(user, id);
    const job = await this.jobs.get(row.payload.ownerId, row.payload.jobId);
    const formats = job?.status === 'failed' ? Object.fromEntries(Object.entries(row.payload.formats).map(([key, value]) => [key, value.state === 'ready' ? value : { state: 'failed', code: job.error?.code ?? 'document_render_failed' }])) : row.payload.formats;
    return { ...this.view(row), formats, state: job?.status === 'running' ? 'running' : row.payload.state,
      ...(job?.status === 'failed' && row.payload.state === 'queued' ? { state: 'failed', error: job.error } : {}) };
  }
  /** Reuse exact frozen figures in a review-only conversion; never read the
   * possibly changed workspace. This internal reader rechecks source authority.
   * @param {any} user @param {string} id @param {{source:any,sourceRevision:string}} expected */
  async frozenAssets(user, id, expected) {
    const row = await this.authorized(user, id);
    if (row.payload.sourceRevision !== expected.sourceRevision || documentExportDigest(row.payload.source) !== documentExportDigest(expected.source)) {
      throw new HttpError(409, 'document_source_changed', 'The retained conversion belongs to a different source.');
    }
    const root = documentExportDirectory(this.config, { ownerId: row.payload.ownerId, projectId: row.projectId, exportId: id });
    const bytes = await boundedRead(root, path.join(root, 'input', 'document.json'), 5 * 1024 * 1024);
    if (exportHash(bytes) !== row.payload.inputDigest) throw new HttpError(409, 'document_input_changed', 'Frozen document changed.');
    const input = JSON.parse(bytes.toString('utf8'));
    if (input.sourceDigest !== row.payload.sourceDigest || input.revision !== expected.sourceRevision || !Array.isArray(input.assets) || input.assets.length > 40) {
      throw new HttpError(409, 'document_input_changed', 'Frozen document identity changed.');
    }
    const assets = [];
    let total = 0;
    for (const asset of input.assets) {
      const data = await boundedRead(root, resolveScopedPath(path.join(root, 'input'), asset.path), 10 * 1024 * 1024);
      total += data.length;
      if (total > 20 * 1024 * 1024 || exportHash(data) !== asset.sha256) throw new HttpError(409, 'document_input_changed', 'Frozen asset changed.');
      assets.push({ path: asset.path, sha256: asset.sha256, mime: asset.mime, data });
    }
    return assets;
  }
  async cancel(user, id) {
    return this.cancelRecord(await this.authorized(user, id));
  }
  async cancelRecord(authorized, transactionClient = null) {
    const id = authorized.id;
    let attempt = null;
    const operation = async client => {
      // Same lock order as ProductJobs.withLease: job, then document. A
      // preparing worker cannot publish its attempt between this read and cancel.
      const job = (await client.query("SELECT * FROM evimed_product.jobs WHERE user_id=$1 AND id=$2 FOR UPDATE",
        [authorized.payload.ownerId, authorized.payload.jobId])).rows[0];
      const latest = (await client.query("SELECT * FROM evimed_product.documents WHERE user_id=$1 AND kind='document-export' AND id=$2 AND deleted_at IS NULL FOR UPDATE",
        [authorized.payload.ownerId, id])).rows[0];
      if (!latest || latest.payload.jobId !== job?.id) throw new HttpError(409, 'document_export_changed', 'Export changed; refresh and retry.');
      if (!['queued', 'running'].includes(job.status) && !latest.payload.attempt) return this.view({ id, revision: latest.revision, payload: latest.payload });
      attempt = latest.payload.attempt;
      if (attempt) await this.controller.cancelDocumentRender(attempt);
      await client.query("UPDATE evimed_product.jobs SET status='canceled', finished_at=clock_timestamp(), updated_at=clock_timestamp(), lease_token=NULL, lease_expires_at=NULL WHERE user_id=$1 AND id=$2",
        [latest.user_id, job.id]);
      const formats = Object.fromEntries(Object.entries(latest.payload.formats).map(([format, value]) => [format, value.state === 'ready' ? value : { state: 'failed', code: 'document_export_canceled' }]));
      return this.view(await this.documents.put(latest.user_id, 'document-export', id, { ...latest.payload, attempt: null, formats, state: 'canceled' }, { expectedRevision: latest.revision, transactionClient: client }));
    };
    const result = transactionClient ? await operation(transactionClient) : await this.database.transaction(operation);
    if (attempt && !transactionClient) await this.discardAttempt(attempt);
    return result;
  }
  /** Called inside existing project/account deletion before its rows or files disappear. */
  async cancelProject(ownerId, projectId, client) {
    // Hold the parent row before finding jobs: an enqueue's FK prevents a new
    // export from appearing after the deletion sweep has inspected the project.
    await client.query("SELECT id FROM evimed_control.projects WHERE user_id=$1 AND ($2::text IS NULL OR id=$2) FOR UPDATE", [ownerId, projectId]);
    const rows = (await client.query(`SELECT d.id, d.payload, d.revision FROM evimed_product.documents d
      JOIN evimed_product.jobs j ON j.id=d.payload->>'jobId'
      WHERE d.user_id=$1 AND d.kind='document-export' AND ($2::text IS NULL OR d.project_id=$2)
        AND (j.status IN ('queued','running') OR (d.payload->'attempt' IS NOT NULL AND d.payload->'attempt' <> 'null'::jsonb))`, [ownerId, projectId])).rows;
    for (const row of rows) await this.cancelRecord(row, client);
  }
  async retry(user, id, format) {
    if (!Object.hasOwn(DOCUMENT_EXPORT_MIME, format)) throw unavailable();
    const row = await this.authorized(user, id);
    if ((row.payload.attempts ?? 0) >= 12) throw new HttpError(409, 'document_export_attempts_exhausted', 'The conversion attempt limit was reached.');
    const currentJob = await this.jobs.get(row.payload.ownerId, row.payload.jobId);
    if (['queued','running'].includes(currentJob?.status) || (row.payload.formats[format]?.state !== 'failed' && !(currentJob?.status === 'failed' && row.payload.formats[format]?.state !== 'ready'))) throw new HttpError(409, 'document_export_retry_invalid', 'Only a failed format can be retried.');
    await this.database.transaction(async client => {
      const job = await this.jobs.enqueue(row.payload.ownerId, 'document-export', { exportId: id, formats: [format] },
        { projectId: row.projectId, idempotencyKey: `${id}:${format}:${row.revision}`, transactionClient: client });
      await this.documents.put(row.payload.ownerId, 'document-export', id, { ...row.payload, jobId: job.id, state: 'queued',
        formats: { ...row.payload.formats, [format]: { state: 'queued' } } }, { expectedRevision: row.revision, transactionClient: client });
    });
    return this.status(user, id);
  }
  async download(user, id, format) {
    const row = await this.authorized(user, id);
    const outcome = row.payload.formats[format];
    if (outcome?.state !== 'ready' || !Object.hasOwn(DOCUMENT_EXPORT_MIME, format)) throw unavailable();
    const root = documentExportDirectory(this.config, { ownerId: row.payload.ownerId, projectId: row.projectId, exportId: id });
    const bytes = await boundedRead(root, resolveScopedPath(root, outcome.path), 64 * 1024 * 1024);
    if (exportHash(bytes) !== outcome.sha256) throw new HttpError(409, 'document_export_hash_mismatch', 'Export integrity verification failed.');
    return { bytes, mime: DOCUMENT_EXPORT_MIME[format], filename: `report.${format}` };
  }
  async prepare(job) {
    const prepared = await this.jobs.withLease(job.userId, job.id, job.leaseToken, async client => {
      const read = async () => (await client.query("SELECT * FROM evimed_product.documents WHERE user_id=$1 AND kind='document-export' AND id=$2 AND deleted_at IS NULL FOR UPDATE", [job.userId, job.payload.exportId])).rows[0];
      let row = await read();
      if (!row || row.payload.jobId !== job.id) throw unavailable();
      const root = documentExportDirectory(this.config, { ownerId: job.userId, projectId: job.projectId, exportId: row.id });
      const bytes = await boundedRead(root, path.join(root, 'input', 'document.json'), 5 * 1024 * 1024);
      if (exportHash(bytes) !== row.payload.inputDigest) throw new HttpError(409, 'document_input_changed', 'Frozen document changed.');
      const input = JSON.parse(bytes.toString('utf8'));
      // The job row remains locked while a prior physical attempt is reaped.
      // A stale worker never gets to cancel a successor's attempt.
      if (row.payload.attempt) {
        try { await this.controller.cancelDocumentRender(row.payload.attempt); }
        catch { throw new HttpError(503, 'document_render_stop_unconfirmed', 'The previous renderer has not confirmed stopping.'); }
        const previousDirectory = path.join(root, 'attempts', row.payload.attempt.attemptId);
        try {
          const manifest = JSON.parse((await boundedRead(previousDirectory, path.join(previousDirectory, 'output/manifest.json'), 65536)).toString('utf8'));
          if (manifest.sourceDigest === row.payload.sourceDigest && manifest.rendererVersion === DOCUMENT_RENDERER_VERSION
            && job.payload.formats.some(format => manifest.formats?.[format]?.state === 'ready')) {
            return { attempt: row.payload.attempt, dir: previousDirectory, row, recovered: true };
          }
        } catch (error) {
          if (!['ENOENT', 'file_not_found'].includes(error.code)) throw error;
        }
        await this.discardAttempt(row.payload.attempt, client);
        row = await read();
      }
      if ((row.payload.attempts ?? 0) >= 12) throw new HttpError(409, 'document_export_attempts_exhausted', 'The conversion attempt limit was reached.');
      const attemptId = randomUUID();
      const dir = path.join(root, 'attempts', attemptId);
      try {
        await fs.mkdir(path.join(dir, 'input'), { recursive: true, mode: 0o700 });
        await fs.mkdir(path.join(dir, 'output'), { mode: 0o700 });
        for (const asset of input.assets) {
          const data = await boundedRead(root, resolveScopedPath(path.join(root, 'input'), asset.path), 10 * 1024 * 1024);
          if (exportHash(data) !== asset.sha256) throw new HttpError(409, 'document_input_changed', 'Frozen asset changed.');
          const target = resolveScopedPath(path.join(dir, 'input'), asset.path);
          await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
          await fs.writeFile(target, data, { mode: 0o400 });
        }
        const contents = JSON.stringify({ ...input, formats: job.payload.formats });
        await fs.writeFile(path.join(dir, 'input', 'document.json'), contents, { mode: 0o400 });
        const attempt = { ownerId: job.userId, projectId: job.projectId, exportId: row.id, attemptId, inputDigest: exportHash(contents) };
        const valid = await client.query("SELECT id FROM evimed_product.jobs WHERE user_id=$1 AND id=$2 AND lease_token=$3 AND status='running' AND lease_expires_at>clock_timestamp()", [job.userId, job.id, job.leaseToken]);
        if (!valid.rows.length) throw new HttpError(409, 'product_job_lease_lost', 'This worker no longer owns the job.');
        await this.documents.put(job.userId, 'document-export', row.id,
          { ...row.payload, attempt, attempts: (row.payload.attempts ?? 0) + 1 }, { expectedRevision: row.revision, transactionClient: client });
        return { attempt, dir, row };
      } catch (error) {
        await fs.rm(dir, { recursive: true, force: true });
        throw error;
      }
    });
    if (!prepared) throw new HttpError(409, 'product_job_lease_lost', 'This worker no longer owns the job.');
    return prepared;
  }
  async complete(job, attempt, dir, { partialOnly = false } = {}) {
    const currentJob = await this.jobs.get(job.userId, job.id);
    if (currentJob?.status !== 'running' || currentJob.leaseToken !== job.leaseToken) throw new HttpError(409, 'product_job_lease_lost', 'This worker no longer owns the job.');
    const row = await this.documents.get(job.userId, 'document-export', job.payload.exportId);
    const manifest = JSON.parse((await boundedRead(dir, path.join(dir, 'output', 'manifest.json'), 65536)).toString('utf8'));
    if (manifest.sourceDigest !== row.payload.sourceDigest || manifest.rendererVersion !== DOCUMENT_RENDERER_VERSION) throw new HttpError(409, 'document_output_invalid', 'Renderer output identity does not match.');
    if (partialOnly && !job.payload.formats.some(format => manifest.formats?.[format]?.state === 'ready')) return false;
    const formats = { ...row.payload.formats };
    let outputBytes = Object.entries(formats).filter(([format, value]) => !job.payload.formats.includes(format) && value.state === 'ready').reduce((total, [, value]) => total + (value.bytes ?? 0), 0);
    for (const format of job.payload.formats) {
      const outcome = manifest.formats?.[format];
      if (outcome?.state === 'ready') {
        try {
          if (outcome.path !== `document.${format}` || outcome.mime !== DOCUMENT_EXPORT_MIME[format]) throw new HttpError(409, 'document_output_invalid', 'Renderer output is invalid.');
          const bytes = await boundedRead(dir, path.join(dir, 'output', outcome.path), MAX_OUTPUT_BYTES);
          if (outputBytes + bytes.length > MAX_OUTPUT_BYTES) throw new HttpError(413, 'document_export_too_large', 'Rendered document exceeds the size limit.');
          if (exportHash(bytes) !== outcome.sha256 || bytes.length !== outcome.bytes) throw new HttpError(409, 'document_output_invalid', 'Renderer output hash does not match.');
          outputBytes += bytes.length;
          formats[format] = { ...outcome, sourceDigest: manifest.sourceDigest, path: `attempts/${attempt.attemptId}/output/${outcome.path}` };
        } catch (error) {
          formats[format] = { state: 'failed', code: error.code === 'document_export_too_large' ? error.code : 'document_output_invalid' };
          // Only the fixed format filename is removed; a malformed manifest
          // never gets to choose a path for cleanup.
          await fs.rm(path.join(dir, 'output', `document.${format}`), { force: true });
        }
      } else formats[format] = { state: 'failed', code: outcome?.code === 'document_html_render_failed' ? outcome.code : 'document_render_failed' };
    }
    let cleanupPending = false;
    try { await fs.rm(path.join(dir, 'input'), { recursive: true, force: true }); }
    catch { cleanupPending = true; }
    const ready = Object.values(formats).filter(value => value.state === 'ready').length;
    await this.jobs.finishWithLease(job.userId, job.id, job.leaseToken, { exportId: row.id }, client => this.documents.put(job.userId, 'document-export', row.id,
      { ...row.payload, attempt: null, formats, reservedBytes: cleanupPending || ready !== Object.keys(formats).length ? row.payload.reservedBytes : row.payload.sourceBytes + Object.values(formats).reduce((total, value) => total + (value.bytes ?? 0), 0), state: ready === Object.keys(formats).length ? 'ready' : ready ? 'partial' : 'failed', findings: [...(manifest.findings ?? []), ...(cleanupPending ? ['document_input_cleanup_pending'] : [])] },
      { expectedRevision: row.revision, transactionClient: client }));
    return true;
  }
  async reconcileTerminatedAttempts() {
    await migrateProductStore(this.database);
    const rows = (await this.database.query(`SELECT d.payload->'attempt' AS attempt FROM evimed_product.documents d
      JOIN evimed_product.jobs j ON j.id=d.payload->>'jobId'
      WHERE d.kind='document-export' AND d.deleted_at IS NULL AND j.status IN ('failed','canceled')
        AND d.payload->'attempt' IS NOT NULL AND d.payload->'attempt' <> 'null'::jsonb LIMIT 5`)).rows;
    for (const row of rows) {
      await this.controller.cancelDocumentRender(row.attempt);
      await this.discardAttempt(row.attempt);
    }
  }
  async refundPreparation(job, attempt) {
    return this.jobs.withLease(job.userId, job.id, job.leaseToken, async client => {
      await this.discardAttempt(attempt, client, true);
      return true;
    });
  }
  async discardAttempt(attempt, transactionClient = null, refundAttempt = false) {
    const root = documentExportDirectory(this.config, attempt);
    const target = resolveScopedPath(root, `attempts/${attempt.attemptId}`);
    await assertNoSymlinkPath(root, target, { allowMissingTail: true });
    const row = transactionClient ? (await transactionClient.query("SELECT * FROM evimed_product.documents WHERE user_id=$1 AND kind='document-export' AND id=$2 AND deleted_at IS NULL", [attempt.ownerId, attempt.exportId])).rows[0] : await this.documents.get(attempt.ownerId, 'document-export', attempt.exportId);
    if (Object.values(row?.payload.formats ?? {}).some(value => value.path?.startsWith(`attempts/${attempt.attemptId}/`))) return;
    await fs.rm(target, { recursive: true, force: true });
    if (row?.payload.attempt?.attemptId === attempt.attemptId) await this.documents.put(attempt.ownerId, 'document-export', attempt.exportId,
      { ...row.payload, attempt: null, attempts: refundAttempt ? Math.max(0, (row.payload.attempts ?? 0) - 1) : row.payload.attempts }, { expectedRevision: row.revision, transactionClient });
  }
}
