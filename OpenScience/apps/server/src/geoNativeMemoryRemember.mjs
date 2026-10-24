import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson } from './geoStore.mjs';
import { parseEventStream } from './memoryGateway.mjs';
import { parseArchiveUri } from './openVikingSessions.mjs';
import { HttpError } from './security.mjs';

const KIND = 'geo-plan-context';
const TYPE = 'geo-native-memory-operation';
const invalid = () => new HttpError(502, 'memory_gateway_upstream_invalid', 'The memory operation could not be verified; it was not retried.');

/** Durable bookkeeping for the existing native remember tool. A response names
 * candidates only: the namespace-bound session and task prove their identity.
 * Each exchange gets a server id even if a client batch repeats its RPC ids.
 */
export class GeoNativeMemoryRemember {
  constructor({ contexts, overlay }) {
    this.documents = contexts.documents; this.contexts = contexts; this.overlay = overlay;
  }

  async begin(context, messages, runtimeGeneration) {
    if (context.kind !== 'geo-project' || !Array.isArray(messages) || !messages.length || messages.length > 6
      || messages.some(item => !item || !['user', 'assistant'].includes(item.role) || typeof item.content !== 'string'
        || !item.content || Object.keys(item).some(key => !['role', 'content'].includes(key)))
      || Buffer.byteLength(canonicalJson(messages)) > 1048576
      || typeof runtimeGeneration !== 'string' || !runtimeGeneration || runtimeGeneration.length > 300) throw invalid();
    return this.contexts.withOwner(context.ownerId, async (_created, client) => {
      await this.contexts.assertLive(context);
      return this.documents.put(context.ownerId, KIND, `gnmo_${randomUUID()}`, { recordType: TYPE, policyRef: context.policyRef,
        namespaceId: context.namespaceId, action: 'remember', sanitizedMessagesDigest: createHash('sha256').update(canonicalJson(messages)).digest('hex'),
        runtimeGeneration, state: 'pending', sessionId: null, taskId: null, archiveUri: null, ledgerState: 'not_due' },
      { projectId: context.projectId, expectedRevision: 0, transactionClient: client });
    });
  }

  async saved(context, id) {
    const row = await this.documents.get(context.ownerId, KIND, id, { includeDeleted: true });
    if (!row || row.deletedAt != null || row.projectId !== context.projectId || row.payload.recordType !== TYPE
      || row.payload.namespaceId !== context.namespaceId || row.payload.policyRef !== context.policyRef
      || row.payload.action !== 'remember' || !/^gnmo_[a-f0-9-]{36}$/.test(row.id)) throw invalid();
    return row;
  }

  async update(context, id, changes, after = null) {
    return this.contexts.withOwner(context.ownerId, async (_created, client) => {
      await this.contexts.assertKnown(context);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [id]);
      const before = await this.saved(context, id);
      // A delayed failure notification never overwrites verified acceptance.
      if (before.payload.state === 'accepted' && changes.state && changes.state !== 'accepted') return before;
      const row = await this.documents.put(context.ownerId, KIND, id, { ...before.payload, ...changes },
        { projectId: context.projectId, expectedRevision: before.revision, transactionClient: client });
      if (after) await after(row);
      return row;
    });
  }

  candidates(reply) {
    const content = reply?.result?.content;
    if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== 'text') throw invalid();
    // This is the recorded pinned-engine sentence, not free-form model prose.
    // Unknown future renditions remain recoverable by the namespace archive scan.
    const match = /^Submitted [0-9]+ message\(s\) for memory extraction \(session (mcp-store-[A-Za-z0-9_.@-]{1,180}), task_id=([A-Za-z0-9-]{8,64})\)\. Extraction runs in the background and decides which memories to create or update\.$/.exec(content[0].text ?? '');
    if (!match) throw invalid();
    return { sessionId: match[1], taskId: match[2] };
  }

  async verify(context, sessionId, taskId) {
    const [body, task] = await Promise.all([context.sessions.readSession(context.ownerId, sessionId), context.sessions.task(context.ownerId, taskId)]);
    const session = body?.result;
    if (body?.status !== 'ok' || session?.session_id !== sessionId
      || session.uri !== context.sessions.sessionUri(context.ownerId, sessionId)
      || session.user?.user_id !== context.namespaceId || session.user?.account_id !== context.sessions.client.account
      || task?.task_id !== taskId || task.task_type !== 'session_commit' || task.resource_id !== sessionId
      || !['pending', 'running', 'completed', 'failed'].includes(task.status)) throw invalid();
    let archiveUri = null;
    if (task.result != null) {
      const archive = parseArchiveUri(task.result.archive_uri);
      if (task.result.session_id !== sessionId || !archive || archive.userRoot !== context.userRoot || archive.session !== sessionId
        || archive.rest || archive.archiveUri !== task.result.archive_uri) throw invalid();
      archiveUri = archive.archiveUri;
    } else if (task.status === 'completed') throw invalid();
    return { sessionId, taskId, archiveUri };
  }

  async recordLedger(context, row) {
    if (!row.payload.archiveUri || row.payload.ledgerState === 'recorded') return row;
    if (!this.overlay) return row;
    try {
      await this.overlay.recordCommit({ userId: context.ownerId, archiveUri: row.payload.archiveUri, engineSession: row.payload.sessionId,
        projectId: context.projectId, origin: 'tool', taskId: row.payload.taskId });
    } catch {
      // The accepted operation stays visibly pending for reconciliation. No
      // second remember call is made and the engine's actual answer is retained.
      return row;
    }
    return this.update(context, row.id, { ledgerState: 'recorded' });
  }

  async accept(context, operationId, verified) {
    const row = await this.update(context, operationId, { state: 'accepted', ...verified, ledgerState: verified.archiveUri ? 'pending' : 'not_due' }, async operation => {
      await this.contexts.saveSession(context, verified.sessionId,
        { kind: 'tool', operationRef: operationId, taskId: verified.taskId }, operation.payload.runtimeGeneration);
    });
    return this.recordLedger(context, row);
  }

  /** `messages` already passed the gateway's capture masking/filtering. */
  async execute(context, { messages, clientId, runtimeGeneration }) {
    const operation = await this.begin(context, messages, runtimeGeneration);
    try {
      const answer = await context.sessions.mcp(context.ownerId, { jsonrpc: '2.0', id: operation.id, method: 'tools/call',
        params: { name: 'remember', arguments: { messages } } });
      if (answer.status < 200 || answer.status >= 300) throw invalid();
      const replies = answer.contentType.includes('text/event-stream') ? parseEventStream(answer.text) : [JSON.parse(answer.text)].flat();
      if (replies.length !== 1 || replies[0]?.jsonrpc !== '2.0' || replies[0]?.id !== operation.id) throw invalid();
      const reply = replies[0];
      if (reply.error || reply.result?.isError === true) {
        await this.update(context, operation.id, { state: 'failed' });
        return { reply: { ...reply, id: clientId ?? null }, operationId: operation.id, state: 'failed' };
      }
      const candidates = this.candidates(reply);
      const verified = await this.verify(context, candidates.sessionId, candidates.taskId);
      await this.accept(context, operation.id, verified);
      return { reply: { ...reply, id: clientId ?? null }, operationId: operation.id, state: 'accepted' };
    } catch (error) {
      try { await this.update(context, operation.id, { state: 'unknown' }); }
      catch (ledgerError) { throw new AggregateError([error, ledgerError], 'Memory response and its status could not both be recorded.'); }
      throw error;
    }
  }

  /** Poll an already proved task or retry ledger recording, never resend text. */
  async reconcile(context, operationId) {
    await this.contexts.assertKnown(context);
    const saved = await this.saved(context, operationId);
    if (saved.payload.state !== 'accepted') return saved;
    if (saved.payload.archiveUri) return this.recordLedger(context, saved);
    const verified = await this.verify(context, saved.payload.sessionId, saved.payload.taskId);
    return this.accept(context, operationId, verified);
  }
}
