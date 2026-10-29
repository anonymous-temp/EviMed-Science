import { readRunTranscript } from './runTranscripts.mjs';
import { HttpError, safeId } from './security.mjs';
import { runHistory } from './agentRuns.mjs';

/** Read only preserved root-session prose. This path has no runtime dependency and cannot wake a container. */
export async function preservedConversationHistory(project, rawSessionId, runs, read = readRunTranscript, { runId = null } = {}) {
  const sessionId = safeId(rawSessionId, 'session id');
  const sessionRuns = runs.filter(run => run.sessionId === sessionId);
  const selectedId = runId == null ? null : safeId(runId, 'run id');
  const owned = sessionRuns.filter(run => !selectedId || run.id === selectedId).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  if (selectedId && !owned.length) throw new HttpError(404, 'run_not_found', 'Run not found in this conversation.');
  const messages = new Map();
  let partial = owned.length > 20;
  let capturedAt = null;
  for (const run of owned.slice(0, 20)) {
    const snapshot = await read(project, run.id).catch(() => null);
    if (!snapshot) { partial = true; continue; }
    capturedAt ??= snapshot.header.capturedAt;
    partial ||= snapshot.header.completeness !== 'complete';
    let scoped = snapshot.messages.filter(message => message.sessionId === sessionId);
    if (selectedId) {
      const originalCount = scoped.length;
      const requestIds = new Set(run.kernelRequestIds ?? []);
      const proof = scoped.some(message => requestIds.has(message.sourceRequestId) && Number.isSafeInteger(message.turnStartSeq));
      if (proof || !requestIds.size && Number.isSafeInteger(run.nativeTurn?.startSeq)) {
        scoped = runHistory(run, scoped.map(message => ({ message, info: message }))).map(entry => entry.message);
      } else if (requestIds.size || run.nativeTurn || sessionRuns.length !== 1) { scoped = []; partial = true; }
      if (originalCount && !scoped.length) partial = true;
    }
    for (const message of scoped) {
      if (message.sessionId !== sessionId || !Number.isSafeInteger(message.seq) || messages.has(message.seq)
        || !['user', 'assistant'].includes(message.role) || (message.role === 'user' && message.source !== 'user')) continue;
      const text = (message.parts ?? []).filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n');
      if (text.trim()) messages.set(message.seq, { seq: message.seq, role: message.role, text: text.slice(0, 100_000) });
      if (text.length > 100_000) partial = true;
    }
  }
  const ordered = [...messages.values()].sort((a, b) => a.seq - b.seq);
  return { sessionId, capturedAt, partial: partial || ordered.length > 200, messages: ordered.slice(-200) };
}
