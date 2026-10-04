import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { canonicalJson, canonicalPersonalSkillResourcePath, validateSkillWriteRequest } from '@evimed/domain';
import { extensionRequestObject, extensionArray, extensionIdentifier } from './extensionAccess.mjs';
import { HttpError } from './security.mjs';
import { accountSkillStateBytes } from './personalSkillTransferArchive.mjs';

export const PERSONAL_SKILL_TRANSFER_MAX_BYTES = 32 * 1024 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
const invalid = () => new HttpError(400, 'extension_contract_invalid', 'The authored skill transfer is invalid.');

/** Decode authored data only. IDs and historical numbers are source labels,
 * never target ownership, namespace, prepared state or permission grants.
 * @param {Buffer} bytes */
export function decodePersonalSkillTransfer(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > PERSONAL_SKILL_TRANSFER_MAX_BYTES) throw invalid();
  let envelope;
  try { envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw invalid(); }
  extensionRequestObject(envelope, ['format', 'version', 'skills', 'resources']);
  if (envelope.format !== 'evimed-personal-skills' || envelope.version !== 1) throw invalid();
  extensionArray(envelope.skills, 32); extensionArray(envelope.resources, 512);
  /** @type {Map<string,Buffer>} */ const resources = new Map();
  let total = 0;
  for (const resource of envelope.resources) {
    extensionRequestObject(resource, ['digest', 'size', 'base64']);
    if (!/^sha256:[a-f0-9]{64}$/.test(resource.digest ?? '') || resources.has(resource.digest)
      || !Number.isSafeInteger(resource.size) || resource.size < 0 || resource.size > 4 * 1024 * 1024
      || typeof resource.base64 !== 'string' || resource.base64.length > Math.ceil(resource.size / 3) * 4) throw invalid();
    const data = Buffer.from(resource.base64, 'base64');
    if (data.length !== resource.size || data.toString('base64') !== resource.base64 || 'sha256:' + hash(data) !== resource.digest) throw invalid();
    total += data.length; if (total > 16 * 1024 * 1024) throw invalid();
    resources.set(resource.digest, data);
  }
  const ids = new Set(), referenced = new Set();
  const skills = envelope.skills.map(skill => {
    extensionRequestObject(skill, ['sourceId', 'revisions']); extensionIdentifier(skill.sourceId);
    if (ids.has(skill.sourceId)) throw invalid(); ids.add(skill.sourceId);
    extensionArray(skill.revisions, 64); if (!skill.revisions.length) throw invalid();
    let previous = 0;
    const revisions = skill.revisions.map(revision => {
      extensionRequestObject(revision, ['revision', 'title', 'description', 'instructions', 'invocation', 'metadata', 'whenToUse', 'resources']);
      if (!Number.isSafeInteger(revision.revision) || revision.revision <= previous || revision.revision > 2147483646) throw invalid();
      previous = revision.revision;
      try { validateSkillWriteRequest({ expectedRevision: 0, title: revision.title, description: revision.description, instructions: revision.instructions }); }
      catch { throw invalid(); }
      extensionRequestObject(revision.invocation, ['userInvocable', 'modelInvocable']);
      if (typeof revision.invocation.userInvocable !== 'boolean' || typeof revision.invocation.modelInvocable !== 'boolean'
        || !revision.metadata || typeof revision.metadata !== 'object' || Array.isArray(revision.metadata)
        || Buffer.byteLength(canonicalJson(revision.metadata)) > 16384
        || !(revision.whenToUse === null || typeof revision.whenToUse === 'string' && Buffer.byteLength(revision.whenToUse) <= 4096)) throw invalid();
      extensionArray(revision.resources, 128); const prefixes = new Map(), paths = new Set();
      for (const resource of revision.resources) {
        extensionRequestObject(resource, ['path', 'digest', 'size']);
        let checked; try { checked = canonicalPersonalSkillResourcePath(resource.path, prefixes); } catch { throw invalid(); }
        if (checked.path !== resource.path || paths.has(checked.key) || !resources.has(resource.digest)
          || !Number.isSafeInteger(resource.size) || resources.get(resource.digest).length !== resource.size) throw invalid();
        paths.add(checked.key); referenced.add(resource.digest);
      }
      return structuredClone(revision);
    });
    return { sourceId: skill.sourceId, revisions };
  });
  if (resources.size !== referenced.size || !skills.length) throw invalid();
  return { sourceDigest: 'sha256:' + hash(bytes), skills, resources };
}

/** Read selected authored skills from the platform's existing account-state
 * JSON. Every other account, connection, project, proof and operational field
 * is excluded from adoption rather than restored under the target account.
 * @param {Buffer} bytes @param {string[]} sourceSkillIds */
export function decodeAccountSkillData(bytes, sourceSkillIds) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > PERSONAL_SKILL_TRANSFER_MAX_BYTES
    || !Array.isArray(sourceSkillIds) || !sourceSkillIds.length || sourceSkillIds.length > 32 || new Set(sourceSkillIds).size !== sourceSkillIds.length) throw invalid();
  let state;
  try { state = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw invalid(); }
  if (state?.version !== 1 || !Array.isArray(state.documents) || !Array.isArray(state.revisions)
    || state.documents.length > 10000 || state.revisions.length > 20000 || !Array.isArray(state.personalSkillResources ?? [])) throw invalid();
  const content = new Map();
  for (const resource of extensionArray(state.personalSkillResources ?? [], 512)) {
    extensionRequestObject(resource, ['id', 'digest', 'size', 'base64']);
    if (resource.id !== 'resource:' + String(resource.digest).slice(7) || content.has(resource.digest)) throw invalid();
    content.set(resource.digest, resource);
  }
  const referenced = new Set(), skills = [];
  for (const sourceId of sourceSkillIds) {
    extensionIdentifier(sourceId);
    const current = state.documents.filter(row => row.kind === 'skill' && row.id === sourceId && !row.deletedAt);
    if (current.length !== 1) throw invalid();
    const rows = [...state.revisions.filter(row => row.kind === 'skill' && row.id === sourceId && !row.deletedAt), current[0]], revisions = new Map();
    for (const row of rows) {
      const payload = row.payload;
      extensionRequestObject(payload, ['schemaVersion', 'title', 'description', 'instructions', 'invocation', 'metadata', 'whenToUse', 'resources', 'prepared']);
      if (payload.schemaVersion !== 1 || payload.prepared !== false) throw invalid();
      const resources = extensionArray(payload.resources, 128).map(resource => {
        extensionRequestObject(resource, ['id', 'path', 'digest', 'size']);
        if (resource.id !== 'resource:' + String(resource.digest).slice(7) || !content.has(resource.digest)) throw invalid();
        referenced.add(resource.digest);
        return { path: resource.path, digest: resource.digest, size: resource.size };
      });
      const revision = { revision: row.revision, title: payload.title, description: payload.description, instructions: payload.instructions,
        invocation: payload.invocation, metadata: payload.metadata, whenToUse: payload.whenToUse, resources };
      if (revisions.has(row.revision) && canonicalJson(revisions.get(row.revision)) !== canonicalJson(revision)) throw invalid();
      revisions.set(row.revision, revision);
    }
    skills.push({ sourceId, revisions: [...revisions.values()].sort((a, b) => a.revision - b.revision) });
  }
  return decodePersonalSkillTransfer(Buffer.from(JSON.stringify({ format: 'evimed-personal-skills', version: 1, skills,
    resources: [...referenced].map(digest => { const resource = content.get(digest); return { digest, size: resource.size, base64: resource.base64 }; }) })));
}

/** Export one or more owned authored histories from the existing skill store.
 * @param {{skills:any,artifacts:any}} dependencies @param {any} user @param {string[]} skillIds */
export async function exportPersonalSkills({ skills, artifacts }, user, skillIds) {
  if (!Array.isArray(skillIds) || !skillIds.length || skillIds.length > 32 || new Set(skillIds).size !== skillIds.length) throw invalid();
  return skills.withLibraryAccount ? skills.withLibraryAccount(user, () => exportOwnedPersonalSkills({ skills, artifacts }, user, skillIds))
    : exportOwnedPersonalSkills({ skills, artifacts }, user, skillIds);
}

/** @param {{skills:any,artifacts:any}} dependencies @param {any} user @param {string[]} skillIds */
async function exportOwnedPersonalSkills({ skills, artifacts }, user, skillIds) {
  const envelope = { format: 'evimed-personal-skills', version: 1, skills: [], resources: [] };
  const resources = new Map();
  let resourceBytes = 0, authoredBytes = 0;
  for (const id of skillIds) {
    if (skills.database) await skills.database.query("SELECT id FROM evimed_product.documents WHERE user_id=$1 AND kind='skill' AND id=$2 AND deleted_at IS NULL FOR SHARE", [user.id, id]);
    const current = await skills.get(user, id), rows = [];
    let beforeRevision = null;
    while (rows.length <= 64) {
      const page = await skills.documents.history(user.id, 'skill', id, { beforeRevision, limit: 64 });
      rows.push(...page.filter(row => !row.deletedAt));
      if (page.length < 64) break;
      beforeRevision = page.at(-1).revision;
    }
    if (rows.length > 64 || !rows.some(row => row.revision === current.revision)) throw invalid();
    const revisions = [];
    for (const row of rows.sort((a, b) => a.revision - b.revision)) {
      const payload = row.payload;
      for (const resource of payload.resources ?? []) {
        if (resources.has(resource.digest)) continue;
        if (resources.size >= 512 || !Number.isSafeInteger(resource.size) || resource.size < 0 || resourceBytes + resource.size > 16 * 1024 * 1024) throw invalid();
        const bytes = await artifacts.resourceBytes(user, resource);
        if (bytes.length !== resource.size) throw invalid();
        resourceBytes += bytes.length;
        resources.set(resource.digest, { digest: resource.digest, size: bytes.length, base64: bytes.toString('base64') });
      }
      const authored = { revision: row.revision, title: payload.title, description: payload.description, instructions: payload.instructions,
        invocation: payload.invocation, metadata: payload.metadata ?? {}, whenToUse: payload.whenToUse ?? null,
        resources: (payload.resources ?? []).map(resource => ({ path: resource.path, digest: resource.digest, size: resource.size })) };
      authoredBytes += Buffer.byteLength(canonicalJson(authored));
      if (authoredBytes > 8 * 1024 * 1024) throw invalid();
      revisions.push(authored);
    }
    envelope.skills.push({ sourceId: id, revisions });
  }
  envelope.resources = [...resources.values()];
  const bytes = Buffer.from(JSON.stringify(envelope));
  decodePersonalSkillTransfer(bytes);
  return bytes;
}

/** Owned data staging and resumable native adoption share the existing
 * library quota, account fence, documents and authored revision history.
 * One revision per call bounds validation; the UI continues the same confirmed
 * request until done and can resume it after a connection interruption.
 */
export class PersonalSkillTransfer {
  /** @param {{skills:any,artifacts:any}} dependencies */
  constructor({ skills, artifacts }) { this.skills = skills; this.artifacts = artifacts; }
  /** @param {string} reference */
  reference(reference) {
    if (!/^transfer:[a-f0-9]{64}$/.test(reference)) throw invalid();
    return path.join('transfers', reference.slice(9));
  }
  /** @param {any} user @param {Buffer} bytes @param {'portable'|'account'} format */
  async upload(user, bytes, format) {
    if (!['portable', 'account'].includes(format) || !Buffer.isBuffer(bytes) || !bytes.length || bytes.length > PERSONAL_SKILL_TRANSFER_MAX_BYTES) throw invalid();
    if (format === 'account') bytes = await accountSkillStateBytes(bytes);
    let sourceSkills;
    if (format === 'portable') sourceSkills = decodePersonalSkillTransfer(bytes).skills.map(skill => ({ sourceId: skill.sourceId, title: skill.revisions.at(-1).title, revision: skill.revisions.at(-1).revision }));
    else {
      let state; try { state = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw invalid(); }
      if (state?.version !== 1 || !Array.isArray(state.documents) || !Array.isArray(state.revisions)) throw invalid();
      if (state.documents.length > 10000 || state.revisions.length > 20000) throw invalid();
      sourceSkills = state.documents.filter(row => row.kind === 'skill' && !row.deletedAt).map(row => {
        extensionIdentifier(row.id);
        if (row.payload?.prepared !== false || typeof row.payload.title !== 'string' || Buffer.byteLength(row.payload.title) > 240) throw invalid();
        return { sourceId: row.id, title: row.payload.title, revision: row.revision };
      });
    }
    if (typeof user?.accountCreatedAt !== 'string') throw invalid();
    const sourceDigest = 'sha256:' + hash(bytes), reference = 'transfer:' + hash(format + '\0' + sourceDigest), prefix = this.reference(reference);
    return this.skills.withLibraryAccount(user, async () => {
      const chunks = [];
      for (let offset = 0; offset < bytes.length; offset += 4 * 1024 * 1024) {
        const chunk = bytes.subarray(offset, offset + 4 * 1024 * 1024), name = `chunk-${chunks.length}`;
        await this.artifacts.publish(user, path.join(prefix, name), chunk);
        chunks.push({ name, size: chunk.length, sha256: hash(chunk) });
      }
      await this.artifacts.publish(user, path.join(prefix, 'metadata.json'), canonicalJson({ version: 1, format, sourceDigest,
        accountCreatedAt: user.accountCreatedAt, size: bytes.length, chunks }) + '\n');
      return { reference, sourceDigest, format, sourceSkills };
    });
  }
  /** @param {any} user @param {string} reference @param {string[]} [sourceSkillIds] */
  async read(user, reference, sourceSkillIds = []) {
    const root = path.join(this.artifacts.ownerRoot(user), this.reference(reference));
    let metadata;
    try { metadata = JSON.parse((await this.artifacts.boundedRead(path.join(root, 'metadata.json'))).toString('utf8')); } catch { throw invalid(); }
    extensionRequestObject(metadata, ['version', 'format', 'sourceDigest', 'accountCreatedAt', 'size', 'chunks']);
    if (metadata.version !== 1 || !['portable', 'account'].includes(metadata.format) || metadata.accountCreatedAt !== user.accountCreatedAt
      || !Number.isSafeInteger(metadata.size) || metadata.size < 1 || metadata.size > PERSONAL_SKILL_TRANSFER_MAX_BYTES
      || !/^sha256:[a-f0-9]{64}$/.test(metadata.sourceDigest) || reference !== 'transfer:' + hash(metadata.format + '\0' + metadata.sourceDigest)) throw invalid();
    extensionArray(metadata.chunks, 8); const chunks = [];
    for (const [index, chunk] of metadata.chunks.entries()) {
      extensionRequestObject(chunk, ['name', 'size', 'sha256']);
      if (chunk.name !== `chunk-${index}` || !Number.isSafeInteger(chunk.size) || chunk.size < 1 || chunk.size > 4 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(chunk.sha256)) throw invalid();
      const bytes = await this.artifacts.boundedRead(path.join(root, chunk.name));
      if (bytes.length !== chunk.size || hash(bytes) !== chunk.sha256) throw invalid(); chunks.push(bytes);
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== metadata.size || 'sha256:' + hash(bytes) !== metadata.sourceDigest) throw invalid();
    return { metadata, decoded: metadata.format === 'account' ? decodeAccountSkillData(bytes, sourceSkillIds) : decodePersonalSkillTransfer(bytes) };
  }
  /** Pure authored preview creates no adopted records, runtime state or permission.
   * @param {any} user @param {any} input */
  async preview(user, input) {
    extensionRequestObject(input, ['reference', 'sourceSkillIds'], ['reference']);
    return this.skills.withLibraryAccount(user, async () => {
      const { metadata, decoded } = await this.read(user, input.reference, input.sourceSkillIds ?? []);
      return { reference: input.reference, sourceDigest: metadata.sourceDigest, format: metadata.format, nativeValidation: 'pending',
        skills: decoded.skills.map(skill => ({ sourceId: skill.sourceId, title: skill.revisions.at(-1).title, revisions: skill.revisions.length,
          resources: skill.revisions.at(-1).resources, invocation: skill.revisions.at(-1).invocation })), activation: false };
    });
  }
  /** Recover confirmed unfinished imports from owned durable journals, not browser storage.
   * @param {any} user @param {{cursor?:string|null}} [options] */
  async pending(user, { cursor = null } = {}) {
    return this.skills.withLibraryAccount(user, async () => {
      const page = await this.skills.documents.list(user.id, 'extension-resource', { limit: 50, cursor,
        filter: { recordType: 'skill-transfer-adoption', status: 'in-progress', accountCreatedAt: user.accountCreatedAt } });
      return { nextCursor: page.nextCursor, items: page.items.map(row => ({
        reference: row.payload.reference, format: row.payload.format, sourceSkillIds: row.payload.sourceSkillIds,
        idempotencyKey: row.payload.idempotencyKey, status: row.payload.status, mappings: row.payload.mappings,
      })) };
    });
  }
  /** Current native validation is mandatory for every fresh target revision.
   * Incoming owner/namespace/history numbers never choose target state.
   * @param {any} user @param {any} input */
  async confirm(user, input) {
    extensionRequestObject(input, ['reference', 'sourceSkillIds', 'idempotencyKey'], ['reference', 'idempotencyKey']);
    extensionIdentifier(input.idempotencyKey);
    // Persist target identities before native work. A failed first validation
    // must reuse its immutable package rather than allocate another namespace.
    await this.skills.withLibraryAccount(user, client => this.adoption(user, input, client, true));
    return this.skills.withLibraryAccount(user, async client => {
      const { decoded, journal: initialJournal, id } = await this.adoption(user, input, client, false);
      let journal = initialJournal;
      const documents = this.skills.documents;
      for (const mapping of journal.payload.mappings) {
        const source = decoded.skills.find(skill => skill.sourceId === mapping.sourceId);
        if (!source || mapping.imported > source.revisions.length) throw invalid();
        if (mapping.imported === source.revisions.length) continue;
        const revision = source.revisions[mapping.imported], resources = [];
        for (const resource of revision.resources) {
          const bytes = decoded.resources.get(resource.digest);
          await this.artifacts.publish(user, path.join('blobs', resource.digest.slice(7)), bytes);
          resources.push({ ...resource, id: 'resource:' + resource.digest.slice(7) });
        }
        const saved = await this.skills.saveContent(user, mapping.targetId,
          { expectedRevision: mapping.imported, title: revision.title, description: revision.description, instructions: revision.instructions }, resources,
          // The transferred file is the source: the package came from authored data somebody exported, and its baseline is unknown.
          { invocation: revision.invocation, metadata: revision.metadata, whenToUse: revision.whenToUse,
            provenance: { source: { kind: 'upload', digest: decoded.sourceDigest }, baseline: null } });
        const mappings = structuredClone(journal.payload.mappings), changed = mappings.find(row => row.sourceId === mapping.sourceId);
        changed.imported++; changed.revisions.push({ sourceRevision: revision.revision, targetRevision: saved.revision });
        const status = mappings.every(row => row.imported === row.total) ? 'complete' : 'in-progress';
        journal = await documents.put(user.id, 'extension-resource', id, { ...journal.payload, mappings, status }, { expectedRevision: journal.revision, transactionClient: client });
        break;
      }
      const done = journal.payload.mappings.every(mapping => mapping.imported === decoded.skills.find(skill => skill.sourceId === mapping.sourceId).revisions.length);
      return { status: done ? 'complete' : 'in-progress', reference: input.reference, mappings: journal.payload.mappings, activation: false };
    });
  }
  /** @param {any} user @param {any} input @param {any} client @param {boolean} initialize */
  async adoption(user, input, client, initialize) {
    if (!client) throw invalid();
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`skill-library-account:${user.id}`]);
    const { metadata, decoded } = await this.read(user, input.reference, input.sourceSkillIds ?? []);
    const fingerprint = hash(canonicalJson({ sourceDigest: metadata.sourceDigest, sourceSkillIds: decoded.skills.map(skill => skill.sourceId) }));
    const id = 'skill-transfer:' + hash(input.idempotencyKey), documents = this.skills.documents;
    let journal = await documents.get(user.id, 'extension-resource', id);
    if (journal && (journal.payload.fingerprint !== fingerprint || journal.payload.accountCreatedAt !== user.accountCreatedAt)) throw new HttpError(409, 'product_job_idempotency_conflict', 'The transfer key already names other authored data.');
    if (!journal) {
      if (!initialize) throw invalid();
      journal = await documents.put(user.id, 'extension-resource', id, { recordType: 'skill-transfer-adoption', fingerprint,
        accountCreatedAt: user.accountCreatedAt, sourceDigest: metadata.sourceDigest,
        reference: input.reference, format: metadata.format, sourceSkillIds: decoded.skills.map(skill => skill.sourceId), idempotencyKey: input.idempotencyKey, status: 'in-progress',
        mappings: decoded.skills.map(skill => ({ sourceId: skill.sourceId, targetId: `skill:${randomUUID()}`, imported: 0, total: skill.revisions.length, revisions: [] })) },
      { expectedRevision: 0, transactionClient: client });
    }
    return { decoded, journal, id };
  }
}
