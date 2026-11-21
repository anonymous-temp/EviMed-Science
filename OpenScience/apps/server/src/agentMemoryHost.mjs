import { createHash } from 'node:crypto';
import { privateByDefault } from '@evimed/domain';
import { filterCapturedMessage } from './memoryGateway.mjs';
import { readFollowUp, unsafeToKeep } from './learningEvidence.mjs';
import { rememberAdmission } from './agentMemoryRemember.mjs';
import { HttpError } from './security.mjs';

export const hostDigest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const invalid = () => new HttpError(400, 'agent_memory_payload_invalid', 'Use a complete attended conversation with dated user and assistant messages.');
const token = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/.test(value);

export async function ingestConversation({ native, admission }, { user, project, identity, input, billing }) {
  if (!token(input.sessionId) || input.attended !== true || !Array.isArray(input.messages)
    || input.messages.length < 1 || input.messages.length > 200) throw invalid();
  const messages = [];
  let previous = 0;
  for (const row of input.messages) {
    if (!row || Object.keys(row).some(key => !['role', 'text', 'saidAt'].includes(key))
      || !['user', 'assistant'].includes(row.role) || typeof row.text !== 'string' || !row.text.trim() || row.text.length > 12000
      || typeof row.saidAt !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(row.saidAt)) throw invalid();
    const at = Date.parse(row.saidAt);
    if (!Number.isFinite(at) || at < previous || at > Date.now() + 60000) throw invalid();
    previous = at;
    const captured = filterCapturedMessage({ role: row.role, content: row.text, created_at: new Date(at).toISOString() });
    if ('forward' in captured) messages.push(captured.forward);
  }
  if (!messages.some(message => message.role === 'user')) throw invalid();
  const text = JSON.stringify(messages);
  if (Buffer.byteLength(text) > 256 * 1024) throw new HttpError(413, 'payload_too_large', 'The captured transcript exceeds 256 KiB.');
  const context = await rememberAdmission({ native, admission }, { user, project, at: Date.parse(messages[0].created_at) });
  const id = hostDigest([user.id, project.id, context.projectCreatedAt, identity.keyId, input.sessionId]);
  const externalSource = { operation: 'ingest', client: identity.keyName, sessionId: input.sessionId,
    digest: hostDigest(input.messages), projectCreatedAt: context.projectCreatedAt, saidAt: messages[0].created_at,
    messages: messages.map(m => hostDigest([m.role, m.parts[0].text, m.created_at])), billing };
  const row = await native.overlay.queueAdmission(user.id, { candidateId: `host:${id}`, revision: 1,
    engineSession: `dsh-external_${id}`, text, projectId: project.id, externalSource });
  const receipt = await native.processAdmission(user.id, row);
  return { conversationId: id, state: receipt.state, recordIds: receipt.recordIds, ...(receipt.error ? { error: receipt.error } : {}) };
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
    const context = await rememberAdmission({ native, admission }, { user, project, at: Date.parse(source.saidAt) });
    if (context.projectCreatedAt !== source.projectCreatedAt || (!native.history?.ledger || await native.history.ledger.rejected(context, [input.text], row.archiveUri))) {
      throw new HttpError(403, 'memory_scope_denied', 'This evidence was withdrawn.');
    }
  };
  await check();
  if (source.messages[input.messageIndex] !== hostDigest(['user', input.text, input.saidAt])) {
    throw new HttpError(400, 'agent_memory_payload_invalid', 'The signal must quote a complete captured human message and its UTC timestamp.');
  }
  let target, digest;
  if (input.recordId) {
    const record = await native.getRecord(user.id, input.recordId);
    if (record.status !== 'active' || privateByDefault(record) || record.sensitive || (record.scope !== 'user' && record.scopeId !== project.id)
      || (await native.memoryContexts.forUri(user.id, record.uri)).kind !== 'owned') throw new HttpError(404, 'memory_not_found', 'Memory unavailable.');
    target = record.summary ?? record.value;
    digest = hostDigest(record.value);
  } else {
    const method = await learning.getMethod(user.id, input.methodId);
    if (method.payload?.status !== 'approved' || (method.projectId && method.projectId !== project.id)
      || method.payload.contentDigest !== input.digest) throw new HttpError(404, 'method_not_found', 'Method version unavailable.');
    target = method.payload.frontmatter?.name ?? method.id;
    digest = method.payload.contentDigest;
  }
  const id = input.recordId || input.methodId;
  const runId = `external_${input.conversationId}`;
  const prior = (await feedback.learningEvidenceOf(user.id, runId)).find(event => event.detail?.inputDigest === source.messages[input.messageIndex]);
  if (prior) return { recorded: true, eventId: prior.id, verdict: prior.detail.verdict };
  const verdict = await readFollowUp({ judge }, { message: input.text, previousRequest: target, methods: [{ id, digest, title: target }], adoptable: false },
    { userId: user.id, projectId: project.id, runId });
  if ('failure' in verdict) return { recorded: false, reason: verdict.failure };
  await check();
  const { event } = await feedback.recordLearningEvidence(user.id, { runId, projectId: project.id, key: String(input.messageIndex),
    detail: { evidence: 'follow-up', ...verdict, concerns: [{ id, digest }], inputDigest: source.messages[input.messageIndex],
      sessionId: runId, at: input.saidAt, scope: 'open-domain-answer' } });
  return { recorded: true, eventId: event.id, verdict: event.detail.verdict };
}
