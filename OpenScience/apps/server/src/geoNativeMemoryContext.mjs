import { createHash } from 'node:crypto';
import { canonicalJson } from './geoStore.mjs';
import { parseArchiveUri, platformSessionOf } from './openVikingSessions.mjs';
import { subagentAddress } from './dshRuntimeAdapter.mjs';
import { HttpError } from './security.mjs';

const KIND = 'geo-plan-context';
const TYPE = 'geo-native-memory-session';
const refused = () => new HttpError(403, 'memory_scope_denied', 'The project memory context is unavailable or changed.');
const sessionValid = value => typeof value === 'string' && /^[A-Za-z0-9_.@-]{1,200}$/.test(value);
const hasControl = value => [...value].some(character => character.codePointAt(0) < 32 || character.codePointAt(0) === 127);
const textValid = value => typeof value === 'string' && value.length > 0 && value.length <= 300 && !hasControl(value);
const keyOf = (context, session) => `gnms_${createHash('sha256').update(canonicalJson([context.namespaceId, session])).digest('hex')}`;

/** Resolve only canonical, registered engine roots. The public gateway expands
 * its own-space alias before calling this helper; a URI never chooses an owner.
 */
function canonicalUri(uri) {
  if (typeof uri !== 'string' || uri.length > 4000 || hasControl(uri) || !/^viking:\/\/user\/[A-Za-z0-9_-]+(?:\/[^?#\s\\]+)*$/.test(uri)) throw refused();
  for (const part of uri.slice('viking://user/'.length).split('/')) {
    let decoded;
    try { decoded = decodeURIComponent(part); } catch { throw refused(); }
    if (!part || decoded === '.' || decoded === '..' || /[/\\]/.test(decoded) || hasControl(decoded) || /%[0-9a-f]{2}/i.test(decoded)) throw refused();
  }
  return uri;
}

/** Namespace-aware views over the existing native engine and product ledger.
 * No project sessions enter the legacy (owner, session) table. Live capture is
 * independently proved every time; a saved binding is history, not permission.
 */
export class GeoNativeMemoryContext {
  constructor({ database, documents, policies, sessions, proveCapture = null, settingsForOwner = null }) {
    this.database = database; this.documents = documents; this.policies = policies;
    this.sessions = sessions; this.proveCapture = proveCapture; this.settingsForOwner = settingsForOwner;
  }

  view(ownerId, ownerCreatedAt, policy = null, projectId = null) {
    const sessions = policy ? this.sessions.forNamespace(policy.namespace) : this.sessions;
    return Object.freeze({ kind: policy ? 'geo-project' : 'owned', ownerId, ownerCreatedAt,
      namespaceId: sessions.engineUser(ownerId), policyRef: policy?.referenceId ?? null,
      projectId: policy?.controlProjectId ?? projectId, userRoot: sessions.userRoot(ownerId), sessions, policy });
  }

  async withOwner(ownerId, operation) {
    return this.database.transaction(client => this.database.withTransactionClient(client, async () => {
      const owner = (await client.query('SELECT created_at::text AS created FROM evimed_control.users WHERE id=$1 FOR SHARE', [ownerId])).rows[0];
      if (!owner) throw refused();
      return operation(owner.created, client);
    }));
  }

  async forProject(project) {
    return this.withOwner(project?.userId, async created => {
      const policy = await this.policies.forProject(project);
      return this.view(project.userId, created, policy.kind === 'geo-project' ? policy : null, project.id);
    });
  }

  async all(ownerId) {
    return this.withOwner(ownerId, async created => [this.view(ownerId, created),
      ...(await this.policies.policiesForOwner(ownerId)).map(policy => this.view(ownerId, created, policy))]);
  }

  async forUri(ownerId, value) {
    const uri = canonicalUri(value), contexts = await this.all(ownerId);
    const context = contexts.find(item => uri === item.userRoot || uri.startsWith(`${item.userRoot}/`));
    if (!context) throw refused();
    return context;
  }

  assertUri(context, value) {
    const uri = canonicalUri(value);
    if (uri !== context.userRoot && !uri.startsWith(`${context.userRoot}/`)) throw refused();
    return uri;
  }

  /** Policy initialization and explicit pause/resume share one namespace lock.
   * Restating types must not race a pause and accidentally enable extraction.
   * Lifecycle callers may use a retained historical namespace here as well.
   * When composed, persisted account/project switches are authoritative even
   * if a delayed caller carries an older pause/resume argument.
   */
  async configure(context, { learning = null } = {}) {
    if (context.kind !== 'geo-project' || learning !== null && typeof learning !== 'boolean') throw refused();
    return this.withOwner(context.ownerId, async (_created, client) => {
      await this.assertKnown(context);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`native-memory-policy:${context.namespaceId}`]);
      const settings = this.settingsForOwner ? await this.settingsForOwner(context.ownerId) : null;
      if (this.settingsForOwner && (typeof settings?.learningPaused !== 'boolean' || !Array.isArray(settings?.pausedProjects)
        || !settings.pausedProjects.every(value => typeof value === 'string'))) throw refused();
      await context.sessions.register(context.ownerId);
      const current = await context.sessions.settings(context.ownerId);
      const enabled = settings ? !settings.learningPaused && !settings.pausedProjects.includes(context.projectId)
        : learning ?? (current?.learning !== false);
      const expected = [...context.sessions.memoryTypes].sort();
      const matches = value => value?.learning === enabled && canonicalJson(value?.memoryTypes?.slice().sort()) === canonicalJson(expected);
      if (matches(current)) return current;
      const applied = await context.sessions.setLearning(context.ownerId, enabled);
      if (!matches(applied)) throw refused();
      return applied;
    });
  }

  /** Historical exports may use an old project incarnation, but never an old
   * account. Only live forwarding additionally requires the current project.
   */
  async assertKnown(context, { live = false } = {}) {
    return this.withOwner(context.ownerId, async created => {
      if (created !== context.ownerCreatedAt) throw refused();
      if (context.kind === 'geo-project') {
        const row = await this.documents.get(context.ownerId, KIND, context.policyRef, { includeDeleted: true });
        const policy = this.policies.read(row, context.ownerId, context.policy.namespace);
        if (canonicalJson(policy) !== canonicalJson(context.policy)) throw refused();
      }
      if (live) {
        if (!context.projectId) throw refused();
        const current = await this.forProject({ userId: context.ownerId, id: context.projectId });
        if (current.namespaceId !== context.namespaceId || current.policyRef !== context.policyRef) throw refused();
      }
      return context;
    });
  }

  assertLive(context) { return this.assertKnown(context, { live: true }); }

  readSession(row, context, sessionId) {
    if (!row) return null;
    const payload = row.payload;
    if (row.deletedAt != null || row.id !== keyOf(context, sessionId) || row.kind !== KIND || row.projectId !== context.projectId
      || !Number.isSafeInteger(row.revision) || row.revision < 1 || payload?.recordType !== TYPE
      || payload.policyRef !== context.policyRef || payload.namespaceId !== context.namespaceId || payload.engineSessionId !== sessionId
      || Object.keys(payload).some(key => !['recordType', 'policyRef', 'namespaceId', 'engineSessionId', 'source', 'runtimeGeneration'].includes(key))) throw refused();
    this.validateSource(context, sessionId, payload.source);
    if (payload.runtimeGeneration != null && !textValid(payload.runtimeGeneration)) throw refused();
    return row;
  }

  async session(context, sessionId) {
    if (!sessionValid(sessionId) || context.kind !== 'geo-project') throw refused();
    return this.withOwner(context.ownerId, async () => {
      await this.assertKnown(context);
      return this.readSession(await this.documents.get(context.ownerId, KIND, keyOf(context, sessionId), { includeDeleted: true }), context, sessionId);
    });
  }

  validateSource(context, sessionId, source) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw refused();
    if (source.kind === 'dsh') {
      if (Object.keys(source).some(key => !['kind', 'rootSessionId', 'rootProofRefs', 'childAddress'].includes(key))
        || !/^[A-Za-z0-9_-]{1,128}$/.test(source.rootSessionId ?? '') || !Array.isArray(source.rootProofRefs)
        || !source.rootProofRefs.length || source.rootProofRefs.length > 20 || !source.rootProofRefs.every(textValid)) throw refused();
      const nativeId = platformSessionOf(sessionId);
      if (!nativeId || (source.childAddress == null && nativeId !== source.rootSessionId)) throw refused();
      // Reuse the native catalogue's address vocabulary for the saved proof.
      if (source.childAddress != null) {
        const address = subagentAddress(source.rootSessionId, source.childAddress);
        if (!address || address.childSessionId !== nativeId || canonicalJson(address) !== canonicalJson(source.childAddress)) throw refused();
      }
    } else if (source.kind === 'page') {
      if (Object.keys(source).some(key => !['kind', 'operationRef'].includes(key)) || !textValid(source.operationRef)) throw refused();
    } else if (source.kind === 'replay') {
      if (Object.keys(source).some(key => !['kind', 'sourceArchiveUri'].includes(key))) throw refused();
      const uri = canonicalUri(source.sourceArchiveUri), archive = parseArchiveUri(uri);
      if (!archive || archive.userRoot !== context.userRoot || archive.rest || archive.archiveUri !== uri) throw refused();
    } else if (source.kind === 'tool') {
      if (Object.keys(source).some(key => !['kind', 'operationRef', 'taskId'].includes(key))
        || !/^gnmo_[a-f0-9-]{36}$/.test(source.operationRef ?? '') || !/^[A-Za-z0-9-]{8,64}$/.test(source.taskId ?? '')) throw refused();
    } else throw refused();
  }

  async saveSession(context, sessionId, source, runtimeGeneration = null) {
    if (context.kind !== 'geo-project' || !sessionValid(sessionId)) throw refused();
    this.validateSource(context, sessionId, source);
    if (runtimeGeneration != null && !textValid(runtimeGeneration)) throw refused();
    return this.withOwner(context.ownerId, async (_created, client) => {
      // Accepted operations and replay retain their original namespace. New
      // pages and captured inputs still require the current project incarnation.
      await this.assertKnown(context, { live: !['replay', 'tool'].includes(source.kind) });
      if (source.kind === 'tool') {
        // Only the journal's verified exchange, committed in this transaction,
        // can supply a tool binding. A guessed session prefix grants nothing.
        await client.query('SELECT id FROM evimed_product.documents WHERE user_id=$1 AND kind=$2 AND id=$3 FOR SHARE', [context.ownerId, KIND, source.operationRef]);
        const operation = await this.documents.get(context.ownerId, KIND, source.operationRef, { includeDeleted: true });
        const payload = operation?.payload;
        if (!operation || operation.deletedAt != null || operation.projectId !== context.projectId
          || payload.recordType !== 'geo-native-memory-operation' || payload.action !== 'remember' || payload.state !== 'accepted'
          || payload.policyRef !== context.policyRef || payload.namespaceId !== context.namespaceId
          || payload.sessionId !== sessionId || payload.taskId !== source.taskId || payload.runtimeGeneration !== runtimeGeneration) throw refused();
      }
      const id = keyOf(context, sessionId);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [id]);
      const existing = this.readSession(await this.documents.get(context.ownerId, KIND, id, { includeDeleted: true }), context, sessionId);
      if (existing) {
        if (canonicalJson(existing.payload.source) !== canonicalJson(source)) throw refused();
        // Keep the first association's generation as historical evidence. This
        // row never substitutes for noteCapture's fresh runtime proof.
        return existing;
      }
      return this.documents.put(context.ownerId, KIND, id, { recordType: TYPE, policyRef: context.policyRef,
        namespaceId: context.namespaceId, engineSessionId: sessionId, source,
        ...(runtimeGeneration ? { runtimeGeneration } : {}) }, { expectedRevision: 0, projectId: context.projectId, transactionClient: client });
    });
  }

  async noteCapture(context, sessionId) {
    await this.assertLive(context);
    if (!sessionValid(sessionId) || !this.proveCapture) return null;
    const proof = await this.proveCapture(context, sessionId);
    if (!proof) return null;
    if (!textValid(proof.runtimeGeneration)) throw refused();
    return this.saveSession(context, sessionId, { kind: 'dsh', rootSessionId: proof.rootSessionId,
      rootProofRefs: proof.rootProofRefs, ...(proof.childAddress ? { childAddress: proof.childAddress } : {}) }, proof.runtimeGeneration);
  }

  /** Only control-plane page/replay callers use this method. Engine-created
   * remember sessions need verified task evidence, not a caller-chosen prefix.
   */
  async noteInternal(context, sessionId, source) {
    if (!['page', 'replay'].includes(source?.kind)) throw refused();
    return this.saveSession(context, sessionId, source);
  }
}
