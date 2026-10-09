import { readRunTranscript } from './runTranscripts.mjs';
import { safeId } from './security.mjs';

/** Read only preserved root-session prose. This path has no runtime dependency and cannot wake a container. */
export async function preservedConversationHistory(project, rawSessionId, runs, read = readRunTranscript) {
  const sessionId = safeId(rawSessionId, 'session id');
  const owned = runs.filter(run => run.sessionId === sessionId).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const messages = new Map();
  let partial = owned.length > 20;
  let capturedAt = null;
  for (const run of owned.slice(0, 20)) {
    const snapshot = await read(project, run.id).catch(() => null);
    if (!snapshot) { partial = true; continue; }
    capturedAt ??= snapshot.header.capturedAt;
    partial ||= snapshot.header.completeness !== 'complete';
    for (const message of snapshot.messages) {
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
