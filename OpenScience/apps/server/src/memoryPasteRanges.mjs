// Browser evidence can only label submitted text as material. Keep no clipboard or
// prompt text. A missing session header, edited message or restarted server loses
// the hint and leaves authorship unknown.
import { createHash } from 'node:crypto';

export function createPasteRangeIndex() {
  const held = new Map();
  const key = (owner, project, session, text) => JSON.stringify([owner, project, session, createHash('sha256').update(text).digest('hex')]);
  return {
    record(project, request, ranges) {
      if (!request?.sessionId || !Array.isArray(ranges) || ranges.length > 64) return;
      for (const entry of ranges) {
        const text = request.content?.[entry?.part]?.text;
        if (typeof text !== 'string' || !Array.isArray(entry.spans) || !entry.spans.length || entry.spans.length > 64) continue;
        let previous = 0;
        if (!entry.spans.every(span => {
          if (!Array.isArray(span) || span.length !== 2 || !span.every(Number.isSafeInteger)
            || span[0] < previous || span[1] <= span[0] || span[1] > text.length) return false;
          previous = span[1]; return true;
        })) continue;
        const id = key(project.userId, project.id, request.sessionId, text);
        held.delete(id);
        held.set(id, { until: Date.now() + 86_400_000, spans: entry.spans.map(([start,end]) => ({ start, end, kind: 'paste' })) });
        if (held.size > 4096) held.delete(held.keys().next().value);
      }
    },
    lookup(owner, project, session, text) {
      if (!session || !held.size) return [];
      const value = held.get(key(owner, project, session, text));
      return value?.until > Date.now() ? value.spans : [];
    },
  };
}
