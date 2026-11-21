import { createHash } from 'node:crypto';
import { privateByDefault } from '@evimed/domain';
import { filterCapturedMessage } from './memoryGateway.mjs';
import { readFollowUp, unsafeToKeep } from './learningEvidence.mjs';
import { rememberAdmission } from './agentMemoryRemember.mjs';
import { NATIVE_RECORD_ID } from './nativeMemoryStore.mjs';
import { parseArchiveUri } from './openVikingSessions.mjs';
import { withNativeMemoryWrite } from './nativeMemoryWriteFence.mjs';
import { HttpError } from './security.mjs';

export const hostDigest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const invalid = () => new HttpError(400, 'agent_memory_payload_invalid', 'Use a complete attended conversation with dated user and assistant messages.');
const token = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(value);

export async function ingestConversation({ native, admission }, { user, project, identity, input, billing }) {
  if (!token(input.sessionId) || input.attended !== true || !Array.isArray(input.messages)
    || input.messages.length < 1 || input.messages.length > 200) throw invalid();
  const messages = [];
  const fingerprints = [];
  let previous = 0;
  for (const row of input.messages) {
    if (!row || Object.keys(row).some(key => !['role', 'text', 'saidAt'].includes(key))
      || !['user', 'assistant'].includes(row.role) || typeof row.text !== 'string' || !row.text.trim() || row.text.length > 12000
      || typeof row.saidAt !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(row.saidAt)) throw invalid();
    const at = Date.parse(row.saidAt);
    if (!Number.isFinite(at) || at < previous || at > Date.now() + 60000) throw invalid();
    previous = at;
    const captured = filterCapturedMessage({ role: row.role, content: row.text, created_at: new Date(at).toISOString() });
    if ('forward' in captured) {
      const m = captured.forward;
      messages.push(m);
      fingerprints.push(hostDigest([m.role, m.parts[0].text, m.created_at]));
    } else fingerprints.push(null);
  }
  if (!messages.some(message => message.role === 'user')) throw invalid();
  const text = JSON.stringify(messages);
  if (Buffer.byteLength(text) > 256 * 1024) throw new HttpError(413, 'payload_too_large', 'The captured transcript exceeds 256 KiB.');
  const context = await rememberAdmission({ native, admission }, { user, project, at: Date.parse(messages[0].created_at) });
  const id = hostDigest([user.id, project.id, context.projectCreatedAt, identity.keyId, input.sessionId]);
  const externalSource = { operation: 'ingest', client: identity.keyName, sessionId: input.sessionId,
    digest: hostDigest(input.messages), projectCreatedAt: context.projectCreatedAt, saidAt: messages[0].created_at,
    messages: fingerprints, billing: { keyId: billing.keyId } };
  const row = await native.overlay.queueAdmission(user.id, { candidateId: `host:${id}`, revision: 1,
    engineSession: `dsh-external_${id}`, text, projectId: project.id, externalSource });
  const receipt = await native.processAdmission(user.id, row);
  return { conversationId: id, sourceSessionId: `external_${id}`, projectId: project.id, state: receipt.state, recordIds: receipt.recordIds, ...(receipt.error ? { error: receipt.error } : {}) };
}

async function signalTarget({ native, learning }, userId, projectId, recordId, methodId) {
  if (recordId) {
    const record = await native.getRecord(userId, recordId);
    if (record.status !== 'active' || privateByDefault(record) || record.sensitive || (record.scope !== 'user' && record.scopeId !== projectId)
      || (await native.memoryContexts.forUri(userId, record.uri)).kind !== 'owned') throw new HttpError(404, 'memory_not_found', 'Memory unavailable.');
    return { title:record.summary || record.value, digest:hostDigest(record.value), whenToUse:'' };
  }
  const method = await learning.getMethod(userId, methodId);
  const scope = method.payload?.provenance?.sourceProjectId ?? method.projectId;
  if (method.payload?.status !== 'approved' || (scope && scope !== projectId)
    || (learning.contextProvenance && !await learning.contextProvenance.ordinaryDocument(userId, method))) throw new HttpError(404, 'method_not_found', 'Method unavailable.');
  return { title:method.payload.frontmatter?.name ?? method.id, digest:method.payload.contentDigest, whenToUse:String(method.payload.frontmatter?.whenToUse ?? '') };
}

/** An external run has no platform transcript. Resolve its owned admission, exact human
 * message and target version for feedback readers and account export, including older events. */
export async function visibleWorkSignal({ native, learning }, userId, event) {
  const { detail, projectId, runId } = event;
  const id = /^external_([a-f0-9]{64})$/.exec(runId)?.[1];
  if (!id || !projectId || detail.sessionId !== runId) return false;
  const project = { id:projectId, userId };
  const row = await native.overlay.admission(userId, 'host:' + id, 1);
  const source = row?.externalSource;
  if (row?.state !== 'completed' || row.engineSession !== 'dsh-' + runId || row.projectId !== projectId
    || source?.operation !== 'ingest' || !source.messages?.includes(detail.inputDigest)) return false;
  const context = await native.memoryContexts.forProject(project);
  const archive = parseArchiveUri(row.archiveUri);
  if (context.kind !== 'owned' || context.projectCreatedAt !== source.projectCreatedAt || archive?.session !== row.engineSession
    || archive.userRoot !== context.userRoot || archive.rest || await native.sourceDeletion?.ledger.get(project, runId)) return false;
  const raw = await context.sessions.read(userId, row.archiveUri + '/messages.jsonl');
  if (!raw) return false;
  const target = detail.externalTarget;
  const isRecord = NATIVE_RECORD_ID.test(target.id);
  try {
    const current = await signalTarget({native, learning}, userId, projectId, isRecord ? target.id : null, isRecord ? null : target.id);
    if (current.digest !== target.digest) return false;
  } catch (error) {
    if ([403, 404].includes(error?.status)) return false;
    throw error;
  }
  for (const line of raw.split('\n').filter(Boolean)) {
    const message = JSON.parse(line);
    const at = Date.parse(message.created_at);
    if (message.role !== 'user' || !Number.isFinite(at)) continue;
    const text = message.parts?.map(part => part.text).join('') ?? message.content;
    if (typeof text === 'string' && hostDigest(['user', text, new Date(at).toISOString()]) === detail.inputDigest) {
      return !await native.history.ledger.rejected(context, [text, detail.quote, detail.rule].filter(Boolean), row.archiveUri);
    }
  }
  return false;
}

/** Judge a host's signal against a previously admitted human turn and a current, visible account resource. */
export async function recordWorkSignal({ native, admission, learning, feedback, judge }, { user, project, identity, input }) {
  if (!/^[a-f0-9]{64}$/.test(input.conversationId ?? '') || typeof input.text !== 'string' || !input.text.trim()
    || input.text.length > 2000 || unsafeToKeep(input.text) || !Number.isInteger(input.messageIndex)
    || Number(Boolean(input.recordId)) + Number(Boolean(input.methodId)) !== 1) throw invalid();
  const row = await native.overlay.admission(user.id, `host:${input.conversationId}`, 1);
  const source = row?.externalSource;
  if (row?.state !== 'completed' || source?.operation !== 'ingest' || row.projectId !== project.id
    || source.billing?.keyId !== identity.keyId) throw new HttpError(404, 'memory_not_found', 'No completed conversation for this key.');
  const check = async () => {
    const context = await rememberAdmission({ native, admission }, { user, project, at: Date.parse(source.saidAt), engineSessionId: row.engineSession });
    if (context.projectCreatedAt !== source.projectCreatedAt || await native.sourceDeletion?.ledger.get(project, row.engineSession.slice(4)) || (!native.history?.ledger || await native.history.ledger.rejected(context, [input.text], row.archiveUri))) {
      throw new HttpError(403, 'memory_scope_denied', 'This evidence was withdrawn.');
    }
  };
  await check();
  const saidAt = Date.parse(input.saidAt);
  if (!Number.isFinite(saidAt) || source.messages[input.messageIndex] !== hostDigest(['user', input.text, new Date(saidAt).toISOString()])) {
    throw new HttpError(400, 'agent_memory_payload_invalid', 'The signal must quote a complete captured human message and its UTC timestamp.');
  }
  const readTarget = () => signalTarget({native, learning}, user.id, project.id, input.recordId, input.methodId);
  const { title:target, digest, whenToUse } = await readTarget();
  if (input.methodId && digest !== input.digest) throw new HttpError(404, 'method_not_found', 'Method version unavailable.');
  const id = input.recordId || input.methodId;
  const runId = `external_${input.conversationId}`;
  const prior = (await feedback.learningEvidenceOf(user.id, runId)).find(event => event.detail?.inputDigest === source.messages[input.messageIndex]);
  if (prior?.detail?.externalTarget && (prior.detail.externalTarget.id !== id || prior.detail.externalTarget.digest !== digest)) {
    throw new HttpError(409, 'memory_conflict', 'This feedback was already recorded for another target.');
  }
  if (prior) return { recorded: true, eventId: prior.id, verdict: prior.detail.verdict };
  const verdict = await readFollowUp({ judge }, { message: input.text, previousRequest: target, methods: [{ id, digest, title: target, whenToUse }], adoptable: false },
    { userId: user.id, projectId: project.id, runId });
  if ('failure' in verdict) return { recorded: false, reason: verdict.failure };
  return withNativeMemoryWrite(native.overlay.database, user.id, async () => {
    await check();
    if ((await readTarget()).digest !== digest) throw new HttpError(409, 'memory_conflict', 'The memory changed during feedback review.');
    const { event } = await feedback.recordLearningEvidence(user.id, { runId, projectId: project.id, key: String(input.messageIndex),
      detail: { evidence: 'follow-up', ...verdict, externalTarget: { id, digest }, inputDigest: source.messages[input.messageIndex],
        sessionId: runId, at: input.saidAt, scope: 'open-domain-answer' } });
    if (event.detail.externalTarget?.id !== id || event.detail.externalTarget.digest !== digest) {
      throw new HttpError(409, 'memory_conflict', 'This feedback was already recorded for another target.');
    }
    return { recorded: true, eventId: event.id, verdict: event.detail.verdict };
  });
}
