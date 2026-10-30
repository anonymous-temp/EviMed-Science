/** Owned, receipt-verified run evidence independent of the live kernel lifetime. */
import { PLATFORM_CONTEXT_TAGS, stripPlatformTags } from '@evimed/domain';
import { runHistory } from './agentRuns.mjs';
import { delegatedChildrenOf } from './dshRuntimeAdapter.mjs';
import { readVerifiedRunTranscript } from './runTranscripts.mjs';
import { HttpError, safeId } from './security.mjs';

/** Remove runtime envelopes and credential-shaped fields from the reader projection, not stored bytes.
 * @param {any} value @returns {any} */
export function redactRunEvidence(value) {
  if (typeof value === 'string') {
    let text = value;
    for (const {tag, role} of PLATFORM_CONTEXT_TAGS) if (role === 'injected') {
      text = text.replace(new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag}>`, 'gi'), '[runtime context removed]');
    }
    const prefix = /^(ok|success|error)\s*\n/i.exec(text)?.[0] ?? '';
    try { const decoded = JSON.parse(prefix ? text.slice(prefix.length) : text); if (decoded && typeof decoded === 'object') return prefix + JSON.stringify(redactRunEvidence(decoded)); } catch { /* Ordinary prose stays prose. */ }
    return stripPlatformTags(text).replace(/(authorization\s*:\s*)(?:Basic|Bearer)\s+[^\s"']+/gi, '$1[redacted]')
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
      .replace(/((?:api[_ -]?key|password|access[_ -]?token|refresh[_ -]?token|workload[_ -]?token|authorization|cookie|secret|token)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi, '$1"[redacted]"');
  }
  if (Array.isArray(value)) return value.map(redactRunEvidence);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    /^(?:authorization|cookie|password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|workload[_-]?token|token)$/i.test(key)
      ? '[redacted]' : redactRunEvidence(item)]));
}

/** The caller supplies only runs and child ownership from its authenticated project.
 * @param {any} project @param {string} rawSessionId @param {string} rawRunId @param {any[]} runs
 * @param {{read?:typeof readVerifiedRunTranscript}} [options] */
export async function preservedRunEvidence(project, rawSessionId, rawRunId, runs, { read = readVerifiedRunTranscript } = {}) {
  const sessionId = safeId(rawSessionId, 'session id'); const runId = safeId(rawRunId, 'run id');
  const run = runs.find(item => item.id === runId && item.sessionId === sessionId);
  if (!run) throw new HttpError(404, 'run_not_found', 'Run not found in this conversation.');
  const empty = reason => ({ sessionId, runId, source: 'preserved', available: false, partial: true, reason, messages: [] });
  if (!run.transcript?.sha256) return empty('not_captured');
  let saved;
  try { saved = await read(project, run, run.transcript.sha256); }
  catch (error) { if (error?.code === 'ENOENT' || error?.code === 'file_not_found') return empty('expired'); throw error; }
  if (!saved) return empty('not_captured');
  const root = saved.messages.filter(message => message.sessionId === sessionId);
  const requestIds = new Set(run.kernelRequestIds ?? []);
  const identity = root.some(message => requestIds.has(message.sourceRequestId) && Number.isSafeInteger(message.turnStartSeq))
    || !requestIds.size && Number.isSafeInteger(run.nativeTurn?.startSeq) && root.some(message => message.turnStartSeq === run.nativeTurn.startSeq);
  if (!identity) return empty('turn_identity_unavailable');
  const selected = runHistory(run, root.map(message => ({ message, info: message }))).map(entry => entry.message);
  if (!selected.length) return empty('turn_identity_unavailable');
  // The digest-verified capture is immutable; later turns may replace live session state.
  const capturedChildren = (saved.header.sessions ?? []).filter(item => item.parentSessionId != null);
  const ancestry = new Set([sessionId]);
  for (let pass = 0; pass < capturedChildren.length; pass += 1) {
    let changed = false;
    for (const child of capturedChildren) if (ancestry.has(child.parentSessionId) && !ancestry.has(child.sessionId)) {
      ancestry.add(child.sessionId); changed = true;
    }
    if (!changed) break;
  }
  const recorded = Array.isArray(saved.header.runChildSessionIds) ? saved.header.runChildSessionIds : null;
  const fromReceipts = selected.flatMap(message => (message.parts ?? []).filter(part => part.type === 'tool' && part.status === 'completed')
    .flatMap(part => delegatedChildrenOf(part.tool, part.output).map(child => child.childSessionId)));
  const expectedChildren = new Set(recorded ?? fromReceipts);
  const ownedChildren = new Set([...expectedChildren].filter(id => id !== sessionId && ancestry.has(id)));
  const childMessages = saved.messages.filter(message => ownedChildren.has(message.sessionId));
  const messages = [...selected, ...childMessages].filter(message => ['user','assistant','tool'].includes(message.role) && (message.role !== 'user' || message.source === 'user'))
    .map(message => ({ sessionId: message.sessionId, seq: message.seq, role: message.role, source: message.source ?? null, turnStartSeq: message.turnStartSeq ?? null, sourceRequestId: message.sourceRequestId ?? null,
      parts: (message.parts ?? []).filter(part => ['text','tool'].includes(part.type)).map(redactRunEvidence) }))
    .filter(message => message.parts.length);
  return { sessionId, runId, source: 'preserved', available: true,
    automated: run.automated === true, capturedAt: saved.header.capturedAt, sourceSha256: run.transcript.sha256, redacted: true,
    partial: saved.header.completeness !== 'complete' || [...expectedChildren].some(id => !ancestry.has(id)) || capturedChildren.some(child => !ownedChildren.has(child.sessionId)),
    missing: saved.header.missing ?? [], messages };
}
