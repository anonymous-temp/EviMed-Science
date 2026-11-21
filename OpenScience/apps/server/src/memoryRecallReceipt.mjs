// Only references leave the response boundary. The user's words and the returned
// text remain in the scoped transcript and can be compared by digest and sequence.
import { createHash } from 'node:crypto';
import { collectedRunScope } from './runLearningScope.mjs';

export const recallDigest = text => createHash('sha256').update(text).digest('hex');

export function recallOperation({ entry, query = null, items = [], coverage = {}, at = new Date().toISOString(), id }) {
  const references = items.filter(item => typeof item.uri === 'string' && item.uri && typeof item.text === 'string' && item.text)
    .map(({ uri, text, source }) => ({ uri, contentHash: recallDigest(text), source,
      action: entry.endsWith('.read') ? 'read' : 'delivered', entry, at }));
  return { id, entry, at, queryHash: typeof query === 'string' ? recallDigest(query) : null, references,
    coverage: Object.fromEntries(Object.entries(coverage).map(([key, value]) => [key, value.state])) };
}

export function mergeRecallReceipt(current, operations = [], turn = null) {
  const receipt = { version: 1, operations: [...(current?.operations ?? [])], references: [...(current?.references ?? [])],
    partial: current?.partial ?? false, turn: turn ?? current?.turn ?? null };
  const refKey = row => JSON.stringify([row.uri, row.contentHash, row.action, row.source, row.entry]);
  const index = new Map(receipt.references.map((row, i) => [refKey(row), i]));
  for (const operation of operations) {
    if (receipt.operations.some(row => row.id === operation.id)) continue;
    if (receipt.operations.length >= 64) { receipt.partial = true; break; }
    const refs = new Set();
    for (const reference of operation.references) {
      const key = refKey(reference);
      if (!index.has(key)) {
        if (receipt.references.length >= 128 || reference.uri.length > 768) { receipt.partial = true; continue; }
        index.set(key, receipt.references.length);
        receipt.references.push(reference);
      }
      refs.add(index.get(key));
    }
    const { references: _references, ...fields } = operation;
    receipt.operations.push({ ...fields, refs: [...refs] });
  }
  const searches = receipt.operations.filter(op => op.entry.endsWith('.search'));
  const missing = (receipt.turn?.searchCalls ?? 0) > searches.filter(op => ['mcp.search', 'capsule.search'].includes(op.entry)).length;
  const state = receipt.partial || missing ? 'incomplete' : !searches.length ? receipt.turn?.complete ? 'not_searched' : 'unknown'
    : searches.some(op => op.refs.length) ? 'hit'
    : searches.some(op => Object.values(op.coverage).includes('unavailable') || !Object.values(op.coverage).includes('empty')) ? 'incomplete' : 'empty';
  return { ...receipt, state };
}

export function recallTurn(run, sessions, complete) {
  const selected = collectedRunScope(run, sessions);
  const root = selected.sessions.find(s => s.sessionId === run.sessionId)?.transcript.messages ?? [];
  const last = root.at(-1);
  const text = last?.parts?.filter(part => part.type === 'text').map(part => part.text).join('\n');
  const calls = root.flatMap(m => m.parts ?? []).filter(part => part.type === 'tool' && ['mcp__openviking__search', 'evimed_capsule_recall'].includes(part.tool));
  return { complete: complete && selected.scope.available && !selected.scope.partial,
    questionHash: run.question ? recallDigest(run.question) : null,
    searchCalls: calls.length, answer: last?.role === 'assistant' && !last.interrupted && text ? { seq: last.seq, contentHash: recallDigest(text) } : null };
}

export function recallRunAt(runs, sessionId, startedAt) {
  if (!sessionId) return null;
  const matches = runs.filter(run => run.sessionId === sessionId && !run.deleted
    && Date.parse(run.startedAt) <= startedAt && (run.finishedAt ? startedAt <= Date.parse(run.finishedAt) : run.status === 'running'));
  return matches.length === 1 ? matches[0] : null;
}

export function residentOperation(sessionId, contentHash, at) {
  const entry = 'opening.resident';
  return { id: entry + ':' + contentHash, entry, queryHash: null, at, coverage: {},
    references: [{ entry, action: 'delivered', source: 'profile', uri: 'resident:' + sessionId, contentHash, at }] };
}
