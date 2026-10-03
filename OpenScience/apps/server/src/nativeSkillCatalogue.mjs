import { createHash, randomUUID } from 'node:crypto';
import { createGzip } from 'node:zlib';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import tar from 'tar-stream';
import { canonicalJson, canonicalPersonalSkillResourcePath } from '@evimed/domain';
import { HttpError } from './security.mjs';
import { extensionRequestObject } from './extensionAccess.mjs';
const unavailable = () => new HttpError(503, 'product_state_unavailable', 'The native skill catalogue is unavailable.');
const invalid = () => new HttpError(400, 'extension_contract_invalid', 'Invalid native skill request.');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
/** Reuse the existing supported archive/native import path, with a unique owned wrapper to avoid deleting a preexisting user upload.
 * @param {any[]} entries */
export async function nativeSkillSnapshotArchive(entries) {
  const pack = tar.pack(), gzip = createGzip({ level: 1 }), chunks = [];let bytes = 0;
  const collector = new Writable({ write(chunk, _encoding, callback) {
    bytes += chunk.length;if (bytes > 4 * 1024 * 1024) return callback(new HttpError(413, 'product_batch_too_large', 'This native skill exceeds the supported import archive limit.'));
    chunks.push(chunk);callback();
  } });
  const joined = pipeline(pack, gzip, collector);void joined.catch(() => {});
  const wrapper = 'copy-' + randomUUID();
  try {
    for (const entry of entries) await new Promise((resolve, reject) => pack.entry({ name: `${wrapper}/${entry.path}`, type: 'file', mode: 0o444, mtime: new Date(0) }, Buffer.from(entry.bytesBase64, 'base64'), error => error ? reject(error) : resolve()));
    pack.finalize();await joined;return Buffer.concat(chunks);
  } catch (error) { pack.destroy(error);gzip.destroy(error);collector.destroy(error);await joined.catch(() => {});throw error; }
}
/** Existing runtime only: browsing never starts a kernel, a session or a model.
 * The injected session judge retains the normal project/background-session boundary. */
export class NativeSkillCatalogue {
  /** @param {{runtimeManager:any,authorizeSession:any}} options */
  constructor({ runtimeManager, authorizeSession }) { this.runtime = runtimeManager; this.authorizeSession = authorizeSession; }
  /** @param {any} user @param {any} project @param {string} sessionId @param {string|null} [expected] */
  async scope(user, project, sessionId, expected = null) {
    if (typeof sessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId)) throw invalid();
    if (typeof this.authorizeSession !== 'function') throw unavailable();
    const runtime = this.runtime.runtimes.get(this.runtime.key(project)), generation = this.runtime.runtimeGeneration(project);
    if (!runtime || !generation || runtime.closedByManager || runtime.exitedAt) throw unavailable();
    await this.authorizeSession(user, project, sessionId);
    if (this.runtime.runtimes.get(this.runtime.key(project)) !== runtime || this.runtime.runtimeGeneration(project) !== generation) throw unavailable();
    if (expected !== null && expected !== generation) throw new HttpError(409, 'extension_contract_invalid', 'The native skill generation changed.');
    return { runtime, generation };
  }
  /** @param {any} user @param {any} project @param {string} sessionId @param {string} generation */
  async assertCurrent(user, project, sessionId, generation) { await this.scope(user, project, sessionId, generation); }
  /** @param {any} user @param {any} project @param {string} sessionId @param {string} method @param {any} request @param {string|null} [expected] */
  async call(user, project, sessionId, method, request, expected = null) {
    const captured = await this.scope(user, project, sessionId, expected);
    const value = await this.runtime.callKernel(captured.runtime, project, method, { request }, AbortSignal.timeout(15000), { maxBytes: 24 * 1024 * 1024 });
    await this.assertCurrent(user, project, sessionId, captured.generation);
    return { value, generation: captured.generation };
  }
  /** @param {any} user @param {any} project @param {string|null} sessionId */
  async list(user, project, sessionId) {
    const unavailableResult = code => ({ state: 'unavailable', runtimeGeneration: null, sessionId,
      items: [], findings: [{ code }] });
    if (!sessionId) return unavailableResult('skill_session_required');
    try {
      const { value, generation } = await this.call(user, project, sessionId, 'evimedSkills/list', { sessionId });
      extensionRequestObject(value, ['complete', 'items']);
      if (typeof value.complete !== 'boolean' || !Array.isArray(value.items) || value.items.length > 1024) throw unavailable();
      for (const item of value.items) this.summary(item);
      return { state: value.complete ? 'available' : 'unknown', runtimeGeneration: generation, sessionId,
        items: value.items.map(item => ({ ...item, canDuplicate: value.complete && item.canDuplicate })),
        findings: value.complete ? [] : [{ code: 'skill_discovery_incomplete' }] };
    } catch (error) {
      if ([401, 403, 404, 400, 409].includes(error.status)) throw error;
      return unavailableResult('skill_catalogue_unavailable');
    }
  }
  /** @param {any} value */
  summary(value) {
    extensionRequestObject(value, ['key', 'name', 'description', 'invocation', 'source', 'canDuplicate']);
    extensionRequestObject(value.invocation, ['userInvocable', 'modelInvocable']);
    if (!/^skill:[a-f0-9]{64}$/.test(value.key) || typeof value.name !== 'string' || value.name.length > 200
      || typeof value.description !== 'string' || Buffer.byteLength(value.description) > 8192 || typeof value.canDuplicate !== 'boolean'
      || !['builtin', 'community', 'personal', 'unknown'].includes(value.source)
      || typeof value.invocation.userInvocable !== 'boolean' || typeof value.invocation.modelInvocable !== 'boolean') throw unavailable();
  }
  /** @param {any} user @param {any} project @param {any} input @param {boolean} [snapshot] */
  async read(user, project, input, snapshot = false) {
    extensionRequestObject(input, ['sessionId', 'key', 'expectedRuntimeGeneration']);
    if (!/^skill:[a-f0-9]{64}$/.test(input.key) || typeof input.expectedRuntimeGeneration !== 'string' || !input.expectedRuntimeGeneration) throw invalid();
    const { value, generation } = await this.call(user, project, input.sessionId,
      snapshot ? 'evimedSkills/snapshotBuiltin' : 'evimedSkills/read', { sessionId: input.sessionId, key: input.key }, input.expectedRuntimeGeneration);
    extensionRequestObject(value, ['key', 'name', 'description', 'invocation', 'source', 'canDuplicate', 'instructions', 'metadata', 'whenToUse', 'resources', 'scripts', 'findings', 'digest', ...(snapshot ? ['entries'] : [])]);
    const { instructions, metadata, whenToUse, resources, scripts, findings, digest, entries: _entries, ...summary } = value;
    this.summary(summary);
    if (value.key !== input.key || typeof instructions !== 'string' || Buffer.byteLength(instructions) > 262144
      || Buffer.byteLength(canonicalJson(metadata)) > 32768 || (whenToUse !== null && typeof whenToUse !== 'string')
      || !/^sha256:[a-f0-9]{64}$/.test(digest) || !Array.isArray(resources) || resources.length > 128 || !Array.isArray(scripts)
      || !Array.isArray(findings) || findings.length > 10) throw unavailable();
    const prefixes = new Map(), identities = new Set();
    for (const resource of resources) {
      extensionRequestObject(resource, ['path', 'size', 'digest']);const canonical = canonicalPersonalSkillResourcePath(resource.path, prefixes);
      if (resource.path !== canonical.path || identities.has(canonical.key) || canonical.key.split('/').at(-1) === 'skill.md'
        || !Number.isSafeInteger(resource.size) || resource.size < 0 || resource.size > 4 * 1024 * 1024 || !/^sha256:[a-f0-9]{64}$/.test(resource.digest)) throw unavailable();
      identities.add(canonical.key);
    }
    if (snapshot) this.entries(value);
    return { state: 'available', runtimeGeneration: generation, sessionId: input.sessionId, skill: value, findings };
  }
  /** Independently checks native byte framing before it can enter existing upload/native parsing. @param {any} value */
  entries(value) {
    if (!value.canDuplicate || !['builtin', 'community'].includes(value.source) || !Array.isArray(value.entries) || value.entries.length < 1 || value.entries.length > 129) throw unavailable();
    const identities = new Set(), prefixes = new Map();let total = 0;
    for (const entry of value.entries) {
      extensionRequestObject(entry, ['path', 'size', 'digest', 'bytesBase64']);const canonical = canonicalPersonalSkillResourcePath(entry.path, prefixes);
      if (entry.path !== canonical.path || identities.has(canonical.key) || (entry.path !== 'SKILL.md' && canonical.key.split('/').at(-1) === 'skill.md')
        || typeof entry.bytesBase64 !== 'string' || entry.bytesBase64.length > 6 * 1024 * 1024) throw unavailable();
      identities.add(canonical.key);const bytes = Buffer.from(entry.bytesBase64, 'base64');
      if (bytes.toString('base64') !== entry.bytesBase64 || !Number.isSafeInteger(entry.size) || entry.size !== bytes.length || bytes.length > 4 * 1024 * 1024
        || entry.digest !== `sha256:${hash(bytes)}`) throw unavailable();total += bytes.length;if (total > 16 * 1024 * 1024) throw unavailable();
    }
    if (value.entries.filter(entry => entry.path === 'SKILL.md').length !== 1
      || canonicalJson(value.entries.filter(entry => entry.path !== 'SKILL.md').map(({ bytesBase64: _bytes, ...entry }) => entry)) !== canonicalJson(value.resources)) throw unavailable();
  }
}
