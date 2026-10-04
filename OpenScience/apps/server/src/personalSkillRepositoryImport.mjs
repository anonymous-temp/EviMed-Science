import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import { canonicalPersonalSkillResourcePath } from '@evimed/domain';
import { extensionRequestObject } from './extensionAccess.mjs';
import { HttpError } from './security.mjs';

const invalid = () => new HttpError(400, 'extension_contract_invalid', 'The immutable skill repository is unavailable.');
const limited = () => new HttpError(413, 'extension_contract_invalid', 'The selected repository skill exceeds the import limits.');
const blobHash = bytes => createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');

/** Public immutable skill data only. No Git process, package manager,
 * repository credential, caller URL or vendor module executes on the host.
 */
export class PersonalSkillRepositoryImport {
  /** @param {{transport:import('./webReadNetwork.mjs').WebTransport,skills:any,timeoutMs?:number}} options */
  constructor({ transport, skills, timeoutMs = 30000 }) {
    if (typeof transport !== 'function' || !skills || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) throw invalid();
    this.transport = transport; this.skills = skills; this.timeoutMs = timeoutMs;
  }
  /** @param {URL} url @param {AbortSignal} signal @param {number} limit */
  async read(url, signal, limit) {
    const response = await this.transport({ url, signal, maxBytes: limit, headers: { accept: url.hostname === 'api.github.com' ? 'application/vnd.github+json' : 'application/octet-stream',
      'user-agent': 'EviMed-Science immutable skill import', 'x-github-api-version': '2022-11-28' } });
    if (response.status !== 200 || !Buffer.isBuffer(response.body) || response.body.length > limit) throw invalid();
    return response.body;
  }
  /** @param {URL} url @param {AbortSignal} signal */
  async metadata(url, signal) {
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await this.read(url, signal, 2 * 1024 * 1024))); }
    catch (error) { if (error instanceof HttpError) throw error; throw invalid(); }
  }
  /** Preview creates only an owned bounded upload, never a library revision or project selection.
   * The existing import route confirms those exact bytes through native parsing.
   * @param {any} user @param {any} input @param {{signal?:AbortSignal}} [options] */
  async preview(user, input, { signal } = {}) {
    extensionRequestObject(input, ['repository', 'commit', 'subdirectory'], ['repository', 'commit']);
    if (typeof user?.accountCreatedAt !== 'string' || typeof input.repository !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(input.repository)
      || typeof input.commit !== 'string' || !/^[a-f0-9]{40}$/.test(input.commit)) throw invalid();
    let subdirectory = '';
    if (input.subdirectory !== undefined) {
      try { subdirectory = canonicalPersonalSkillResourcePath(input.subdirectory).path; }
      catch { throw invalid(); }
      if (subdirectory !== input.subdirectory) throw invalid();
    }
    const bounded = AbortSignal.timeout(this.timeoutMs), currentSignal = signal ? AbortSignal.any([bounded, signal]) : bounded;
    const base = `https://api.github.com/repos/${input.repository}/git`;
    const commit = await this.metadata(new URL(`${base}/commits/${input.commit}`), currentSignal);
    if (commit?.sha !== input.commit || !/^[a-f0-9]{40}$/.test(commit.tree?.sha ?? '')) throw invalid();
    let selectedTreeSha = commit.tree.sha;
    for (const segment of subdirectory ? subdirectory.split('/') : []) {
      const parent = await this.metadata(new URL(`${base}/trees/${selectedTreeSha}`), currentSignal);
      if (parent?.sha !== selectedTreeSha || parent.truncated === true || !Array.isArray(parent.tree) || parent.tree.length > 20000) throw limited();
      const entries = parent.tree.filter(entry => entry.path === segment);
      if (entries.length !== 1 || entries[0].type !== 'tree' || entries[0].mode !== '040000' || !/^[a-f0-9]{40}$/.test(entries[0].sha ?? '')) throw invalid();
      selectedTreeSha = entries[0].sha;
    }
    const tree = await this.metadata(new URL(`${base}/trees/${selectedTreeSha}?recursive=1`), currentSignal);
    if (tree?.sha !== selectedTreeSha || tree.truncated !== false || !Array.isArray(tree.tree) || tree.tree.length > 20000) throw limited();
    const paths = new Set(), prefixes = new Map(), selected = [];
    for (const entry of tree.tree) {
      if (!entry || typeof entry.path !== 'string') throw invalid();
      const relative = entry.path;
      if (!relative) continue;
      if (entry.type === 'tree') {
        try { if (canonicalPersonalSkillResourcePath(relative, prefixes).path !== relative) throw invalid(); }
        catch { throw invalid(); }
        continue;
      }
      if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode) || !/^[a-f0-9]{40}$/.test(entry.sha ?? '')
        || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 4 * 1024 * 1024) throw invalid();
      let checked;
      try { checked = canonicalPersonalSkillResourcePath(relative, prefixes); } catch { throw invalid(); }
      if (checked.path !== relative || paths.has(checked.key)) throw invalid();
      paths.add(checked.key); selected.push({ path: relative, sha: entry.sha, size: entry.size });
      if (selected.length > 128) throw limited();
    }
    if (!selected.some(entry => entry.path === 'SKILL.md') || selected.filter(entry => entry.path.split('/').at(-1) === 'SKILL.md').length !== 1) throw invalid();
    const total = selected.reduce((sum, entry) => sum + entry.size, 0);
    if (total > 3 * 1024 * 1024) throw limited();
    /** @type {Record<string,Uint8Array>} */ const files = {};
    for (const entry of selected.sort((a, b) => a.path.localeCompare(b.path))) {
      currentSignal.throwIfAborted();
      const limit = Math.ceil(entry.size / 3) * 4 + Math.ceil(entry.size / 45) * 2 + 16384;
      let blob;
      try { blob = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await this.read(new URL(`${base}/blobs/${entry.sha}`), currentSignal, limit))); }
      catch (error) { if (error instanceof HttpError) throw error; throw invalid(); }
      if (blob.sha !== entry.sha || blob.encoding !== 'base64' || blob.size !== entry.size || typeof blob.content !== 'string'
        || !/^[A-Za-z0-9+/=\r\n]*$/.test(blob.content)) throw invalid();
      const encoded = blob.content.replace(/[\r\n]/g, ''), bytes = Buffer.from(encoded, 'base64');
      if (bytes.toString('base64') !== encoded) throw invalid();
      if (bytes.length !== entry.size || blobHash(bytes) !== entry.sha) throw invalid();
      files[entry.path] = bytes;
    }
    const archive = Buffer.from(zipSync(files, { level: 6, mtime: new Date('1980-01-01T00:00:00Z') }));
    if (archive.length > 4 * 1024 * 1024) throw limited();
    currentSignal.throwIfAborted();
    const upload = await this.skills.upload(user, 'zip', archive);
    try {
      // The repository and commit are what this adapter itself fetched, so they are the one source an import of these
      // exact bytes may name (the library records it beside the upload, not on the caller's word).
      const preview = await this.skills.previewImport(user, { resourceId: upload.resourceId },
        { source: { kind: 'repository', repository: input.repository, commit: input.commit, path: subdirectory || null } });
      return { resourceId: upload.resourceId, immutableSource: { repository: input.repository, commit: input.commit, subdirectory }, preview, findings: [] };
    } catch (error) {
      await this.skills.removeUpload(user, upload.resourceId).catch(() => {});
      throw error;
    }
  }
}
