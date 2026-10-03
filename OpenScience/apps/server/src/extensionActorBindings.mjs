import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalJson } from '@evimed/domain';
import { ProductDocuments } from './productStore.mjs';
import { migrateProductStore } from './productPersistence.mjs';
import { extensionIdentifier } from './extensionAccess.mjs';
import { HttpError } from './security.mjs';

const purpose = 'evimed-extension-accepted-actor-v1\0';
const hash = value => createHash('sha256').update(value).digest('hex');
const denied = () => new HttpError(403, 'extension_access_denied', 'The accepted caller is unavailable.');
// These exact platform producers are normalized from trusted native session events.
// Unknown sources and every RPC-correlated input remain caller boundaries.
const platformContextSources = new Set(['runtime-context', 'plugin:evimed-run-policy', 'skill-catalog']);

/** Actual authenticated prompt admission owns these derived records. An
 * owner-scoped runtime token, imported data or native lineage cannot mint one.
 */
export class ExtensionActorBindings {
  /** @param {{database:any,access:any,runtimeManager:any,secret:string}} options */
  constructor({ database, access, runtimeManager, secret }) {
    if (typeof secret !== 'string' || secret.length < 32) throw denied();
    this.database = database; this.access = access; this.runtime = runtimeManager; this.secret = secret;
    this.documents = new ProductDocuments(database);
  }
  /** @param {any} body */
  sign(body) { return createHmac('sha256', this.secret).update(purpose).update(canonicalJson(body)).digest('hex'); }
  /** @param {string} generation @param {string} sessionId @param {string} requestId */
  id(generation, sessionId, requestId) { return `actor:${hash(canonicalJson({ generation, sessionId, requestId }))}`; }
  /** Called with the platform's authenticated user, never a body-selected actor.
   * @param {any} user @param {any} project @param {any} request */
  async accept(user, project, request) {
    if (user.id !== project.userId || typeof user.accountCreatedAt !== 'string') throw denied();
    const sessionId = extensionIdentifier(request.sessionId), requestId = extensionIdentifier(request.requestId);
    const runtimeGeneration = this.runtime.runtimeGeneration(project);
    if (!runtimeGeneration) throw denied();
    await migrateProductStore(this.database);
    return this.database.transaction(client => this.database.withTransactionClient(client, async () => {
      const accountCreatedAt = await this.access.account(user, client), current = await this.access.project(user, project.id, { client });
      if (current.userId !== user.id || this.runtime.runtimeGeneration(project) !== runtimeGeneration) throw denied();
      const body = { schemaVersion: 1, recordType: 'accepted-extension-actor', userId: user.id, projectId: current.id,
        accountCreatedAt, projectCreatedAt: current.projectCreatedAt, runtimeGeneration, sessionId, requestId };
      const id = this.id(runtimeGeneration, sessionId, requestId);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`extension-actor:${user.id}:${id}`]);
      const prior = await this.documents.get(user.id, 'extension-resource', id);
      if (prior) {
        if (canonicalJson(prior.payload.body) !== canonicalJson(body) || prior.payload.signature !== this.sign(body)) throw denied();
        return body;
      }
      const count = (await client.query("SELECT count(*)::int AS count FROM evimed_product.documents WHERE user_id=$1 AND kind='extension-resource' AND payload->'body'->>'recordType'='accepted-extension-actor' AND deleted_at IS NULL", [user.id])).rows[0].count;
      if (count >= 10000) throw denied();
      await this.documents.put(user.id, 'extension-resource', id, { body, signature: this.sign(body) }, { expectedRevision: 0, projectId: current.id, transactionClient: client });
      return body;
    }));
  }
  /** The native pending call must belong to an input the platform accepted.
   * @param {any} auth @param {any} invocation @param {any} message @param {any} transcript */
  async resolve(auth, invocation, message, transcript) {
    const inputs = (transcript.messages ?? []).filter(item => item.role === 'user'
      && !(platformContextSources.has(item.source) && item.sourceRequestId === null)
      && item.seq <= message.seq && item.turnStartSeq === message.turnStartSeq).sort((a, b) => b.seq - a.seq);
    // Platform context is not a new caller. A later genuine or unknown input
    // without a binding still cannot borrow an earlier caller's record.
    for (const input of inputs.slice(0, 1)) {
      if (typeof input.sourceRequestId !== 'string') return null;
      const row = await this.documents.get(auth.userId, 'extension-resource', this.id(auth.runtimeGeneration, invocation.sessionId, input.sourceRequestId));
      if (!row || row.projectId !== auth.projectId) continue;
      const body = row.payload.body, signature = row.payload.signature;
      if (!body || body.recordType !== 'accepted-extension-actor' || body.schemaVersion !== 1 || body.userId !== auth.userId
        || body.projectId !== auth.projectId || body.runtimeGeneration !== auth.runtimeGeneration || body.sessionId !== invocation.sessionId
        || body.requestId !== input.sourceRequestId || !/^[a-f0-9]{64}$/.test(signature ?? '')
        || !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(this.sign(body), 'hex'))) continue;
      const current = await this.database.query(`SELECT u.created_at::text AS "accountCreatedAt",p.created_at::text AS "projectCreatedAt"
        FROM evimed_control.users u JOIN evimed_control.projects p ON p.user_id=u.id WHERE u.id=$1 AND p.id=$2`, [auth.userId, auth.projectId]);
      if (current.rows[0]?.accountCreatedAt === body.accountCreatedAt && current.rows[0]?.projectCreatedAt === body.projectCreatedAt) return body;
    }
    return null;
  }
}
