/** Shared, nonmutating learning view of a captured session graph. Raw history
 * stays complete for its owner. A participating child is not automatically an
 * owned child turn: only producer-authenticated turn receipts establish that. */
import { scopeRunTranscript, sourceAllowsEgress } from '@evimed/domain';

/** Raw ordinary work retains its existing admission policy. Once trusted typed
 * memory sources exist, their original privacy survives genericization.
 * @param {any} run */
export function methodSourceAllowsLearning(run) {
  return !run || !Object.hasOwn(run, 'sourcePrivacy') && !Object.hasOwn(run, 'originalSources')
    || sourceAllowsEgress(run, { purpose: 'method' });
}

/** @param {any} run @param {readonly any[]} sessions
 * @param {{ownedChildSessionIds?:string[],childTurnOwnership?:readonly any[]}} [options] */
export function collectedRunScope(run, sessions, { ownedChildSessionIds = [], childTurnOwnership = [] } = {}) {
  const metadata = new Map(), records = [], claimed = new Set([...ownedChildSessionIds,
    ...sessions.filter(session => session.parentSessionId != null).map(session => session.sessionId)]), malformed = new Set();
  const accepted = childTurnOwnership.filter(row => row?.schema === 'child-run-turns/1' && row.runId === run.id
    && row.rootSessionId === run.sessionId && typeof row.sessionId === 'string' && Array.isArray(row.turnStartSeqs)
    && row.turnStartSeqs.length <= 4096 && row.turnStartSeqs.every(seq => Number.isSafeInteger(seq) && seq >= 0));
  for (const session of sessions) {
    const transcript = session.transcript;
    const sourceMessages = Array.isArray(transcript?.messages) ? transcript.messages : [];
    const wrongScope = typeof transcript?.sessionId === 'string' && transcript.sessionId !== session.sessionId
      || sourceMessages.some(message => typeof message?.sessionId === 'string' && message.sessionId !== session.sessionId);
    if (wrongScope) malformed.add(session.sessionId);
    const knownSeed = !wrongScope && Number.isSafeInteger(transcript?.seedEndSeq) && transcript.seedEndSeq >= -1
      ? transcript.seedEndSeq : !wrongScope && transcript && !Object.hasOwn(transcript, 'seedEndSeq') && transcript.exhausted !== false && !transcript.truncated && !session.error ? -1 : undefined;
    /** @type {{seedEndSeq?:number,runTurnOwnership?:{schema:string,runId:string,turnStartSeqs:number[]}}} */
    const extra = { ...(knownSeed === undefined ? {} : { seedEndSeq: knownSeed }) };
    const receipts = session.sessionId === run.sessionId ? [] : accepted.filter(row => row.sessionId === session.sessionId);
    if (receipts.length && knownSeed !== undefined) {
      const turns = [...new Set(receipts.flatMap(row => /** @type {number[]} */ (row.turnStartSeqs)))].sort((a, b) => a - b);
      if (turns.length <= 4096) {
        extra.runTurnOwnership = { schema: 'child-run-turns/1', runId: run.id, turnStartSeqs: turns };
        claimed.add(session.sessionId);
      }
    }
    metadata.set(session.sessionId, extra);
    records.push({ sessionId: session.sessionId, parentSessionId: session.parentSessionId ?? null, ...extra });
  }
  const messages = sessions.filter(session => !malformed.has(session.sessionId)).flatMap(session =>
    (Array.isArray(session.transcript?.messages) ? session.transcript.messages : []).map(message => ({ ...message, sessionId: session.sessionId })));
  const root = sessions.find(session => session.sessionId === run.sessionId);
  const selected = scopeRunTranscript({ sessionId: root?.transcript?.sessionId ?? run.sessionId,
    header: { runId: run.id, sessions: records, runChildSessionIds: [...claimed],
      completeness: sessions.some(session => session.error || session.transcript?.truncated || session.transcript?.exhausted === false) ? 'partial' : 'complete' }, messages }, run);
  const bySession = new Map();
  for (const message of selected.messages) { const rows = bySession.get(message.sessionId) ?? []; rows.push(message); bySession.set(message.sessionId, rows); }
  return { scope: selected.runScope, metadata, ownedChildSessionIds: [...claimed],
    sessions: sessions.filter(session => session.sessionId === run.sessionId || bySession.has(session.sessionId))
      .map(session => ({ ...session, transcript: { ...session.transcript, messages: bySession.get(session.sessionId) ?? [] } })) };
}
