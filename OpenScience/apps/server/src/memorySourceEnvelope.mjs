import { carriesPlatformContext } from '@evimed/domain';

// Source roles describe transport. A user-role message can contain a copied document,
// a question about another person, or a platform context block.
const origins = { explicit: 'user_statement', manual: 'user_edit', assistant: 'assistant_statement',
  opinion: 'user_opinion', document: 'document_claim', imported: 'imported_material', inferred: 'inference' };
const speakers = { user_statement: 'user', user_edit: 'user', user_opinion: 'user', assistant_statement: 'assistant',
  tool_result: 'tool', pasted_material: 'unknown', attachment: 'unknown' };

export function sourceEnvelope(kind, { subject = 'unknown', adoption = 'unknown', date = null, speaker = null } = {}) {
  const timestamp = typeof date === 'string' && Number.isFinite(Date.parse(date)) ? date : null;
  return { kind, speaker: speaker ?? speakers[kind] ?? 'unknown', subject, adoption, date: timestamp, personalFact: false };
}

// A receiver of a capsule never inherits its author's identity. Only the write-side
// binder may establish an assertion's subject and who accepted a suggestion.
/** @param {any} [item] */
export function memoryEnvelope(item = {}) {
  if (!item) return sourceEnvelope('memory_record');
  if (item.mode && item.mode !== 'own' || item.origin === 'imported') return sourceEnvelope('imported_material');
  const source = item.sourceEnvelope;
  if (source) return { ...source, personalFact: source.personalFact === true && source.kind === 'user_statement'
    && source.speaker === 'user' && source.subject === 'self' && source.conditions === 'preserved' };
  const kind = item.source === 'evidence_zone' ? 'document_claim' : origins[item.origin] ?? 'memory_record';
  const speaker = ['user', 'assistant', 'tool'].includes(item.speaker) ? item.speaker : null;
  return { ...sourceEnvelope(kind, { speaker }), ...(item.asOf ? { asOf: item.asOf } : {}), ...(item.updatedAt ? { recordedAt: item.updatedAt } : {}) };
}

export function conversationEnvelope(role, date = null) {
  return sourceEnvelope(role === 'assistant' ? 'assistant_statement' : 'conversation_message',
    { speaker: role === 'assistant' || role === 'user' ? role : 'unknown', date });
}

// The checklist is advisory. It also applies with an empty capsule and to answers after tool calls.
export const ANSWER_SOURCE_CHECK = {
  sourceReading: 'The outer role identifies who sent a message, not who made each claim or whom it describes. Separate the request from supplied material, including unmarked pasted passages. Unknown attribution never establishes a personal fact.',
  personalRecall: { perClaim: ['source or explicit unknown', 'speaker', 'subject', 'when', 'conditions', 'adoption'],
    separate: ['recorded facts', 'new advice'] },
  medicalAdvice: { verifyBeforeAnswer: ['subject', 'time', 'conditions and who assisted', 'single best or every applicable option', 'each required field including name and age if requested'] },
  rememberedFormat: { use: 'structure only', forEachContentField: { field: 'each named place, including those named in prose', value: null, source: null, supportingQuote: null },
    fillOnlyFrom: 'Bind each value to a numbered input or tool source and its supporting words about the same subject for this task. Earlier answers and example report contents cannot fill a new report.',
    missing: '未提供/未知 (not provided/unknown); keep the field explicitly empty or marked unknown' },
};

/** A remembered heading supplies only its name. Prior reports never provide a default value.
 * @param {string[]} fields */
export function emptyFormatFields(fields) {
  return Array.from(new Set(fields), field => ({ field, value: null, source: null, missing: '未提供/未知' }));
}

// Never quote an extraction known to omit a condition. Its original conversation
// can still be retrieved through the normal, independently authorized history reader.
export function memoryQuoteUnit(text, source, statements = []) {
  if (source?.conditions === 'missing' || statements.some(row => row.source?.conditions === 'missing')) {
    return { text: '[Incomplete conditions. Retrieve the original conversation before using this entry.]', statements: [] };
  }
  return { text, statements: statements.filter(row => text.includes(row.text)) };
}

export function sourceText(source, text) {
  return JSON.stringify({ source, text });
}

/** Syntactic spans only: punctuation and Markdown delimiters never decide personal intent.
 * @param {string} text */
export function suppliedSyntax(text) {
  const spans = [];
  for (const [open, close] of [['“', '”'], ['「', '」'], ['『', '』'], ['```', '```'], ['~~~', '~~~']]) {
    let start = 0;
    for (;;) {
      const begin = text.indexOf(open, start); if (begin < 0) break;
      const end = text.indexOf(close, begin + open.length); if (end < 0) break;
      spans.push({ kind: open.length === 3 ? 'fenced' : 'quoted', start: begin, end: end + close.length });
      start = end + close.length;
    }
  }
  let offset = 0;
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('>')) spans.push({ kind: 'blockquote', start: offset, end: offset + line.length });
    offset += line.length + 1;
  }
  return spans;
}

function envelopeText(text, source, pasteSpans) {
  if (!text) return text;
  if (source.kind !== 'user_input') return sourceText(source, text);
  // These are the pinned kernel's rendered attachment handles. A forged handle
  // can only downgrade user-supplied text to context of unknown authorship.
  if (/^\[(?:File "[^\n]*" \(\d+ bytes, sha256:[a-f\d]{8}\)|image omitted because this model accepts text only; attachment sha256:)/.test(text)) {
    return sourceText({ ...sourceEnvelope('attachment'), id: source.id }, text);
  }
  if (carriesPlatformContext(text)) return sourceText({ ...sourceEnvelope('platform_context'), id: source.id }, text);
  const spans = [...pasteSpans(text), ...suppliedSyntax(text)].sort((a,b) => a.start - b.start || b.end - a.end);
  // A document full of quotations must not multiply the conversation's size.
  if (spans.length > 64) return sourceText(sourceEnvelope('mixed_input'), text);
  if (!spans.length) return sourceText(source, text);
  const parts = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start < cursor) continue;
    if (span.start > cursor) parts.push({ source, text: text.slice(cursor, span.start) });
    parts.push({ source: { ...sourceEnvelope(span.kind === 'paste' ? 'pasted_material' : 'quoted_material'), id: source.id }, syntax: span.kind, text: text.slice(span.start, span.end) });
    cursor = span.end;
  }
  if (cursor < text.length) parts.push({ source, text: text.slice(cursor) });
  return JSON.stringify({ source, parts });
}

function wrapContent(content, source, pasteSpans, toolSource) {
  if (typeof content === 'string') return envelopeText(content, source, pasteSpans);
  if (!Array.isArray(content)) return content;
  return content.flatMap(block => {
    if (!block || typeof block !== 'object') return [block];
    if (block.type === 'tool_result') return [{ ...block, content: wrapContent(block.content, toolSource(block.tool_use_id, source.id), pasteSpans, toolSource) }];
    if (block.type === 'text') return [{ ...block, text: envelopeText(block.text, source, pasteSpans) }];
    if (block.type === 'image' || block.type === 'image_url' || block.type === 'file') {
      return [{ type: 'text', text: JSON.stringify({ followingPart: { ...sourceEnvelope('attachment'), id: source.id } }) }, block];
    }
    return [block]; // Preserve reasoning signatures, tool-use ids, calls and arguments.
  });
}

/** Last-mile projection only. The kernel and extraction archives retain the original messages. */
export function sourceBoundRequest(body, protocol = 'chat', pasteSpans = (_text) => []) {
  const checklist = '<answer-source-check>\n' + JSON.stringify(ANSWER_SOURCE_CHECK) + '\n</answer-source-check>';
  const calls = new Map(), attachments = new Set();
  const toolSource = (callId, id) => {
    const call = calls.get(callId);
    const parsed = typeof call?.path === 'string' && /(?:^|\/)(?:\.evimed-derived|library)\/[^/]+\/index\.md$/.test(call.path);
    const kind = call?.name === 'read' && (attachments.has(call.path) || parsed) ? 'attachment' : 'tool_result';
    return { ...sourceEnvelope(kind), id, ...(call ? { tool: call.name } : {}) };
  };
  const messages = body.messages.map((message, index) => {
    if (!['assistant', 'user', 'tool'].includes(message.role)) return message;
    const id = `message-${index + 1}`;
    const blocks = Array.isArray(message.content) ? message.content : [{ type: 'text', text: message.content }];
    if (message.role === 'user') {
      for (const block of blocks) {
        // DSH's normalized FileBlock carries the quoted read-only path beside its digest.
        const match = block?.type === 'text' && typeof block.text === 'string' && /^\[File "[^\n]*" \(\d+ bytes, sha256:[a-f\d]{8}\): verbatim read-only copy saved at ("(?:[^"\\]|\\.)*")\./.exec(block.text);
        if (match) try { attachments.add(JSON.parse(match[1])); } catch { /* malformed handle */ }
      }
    } else if (message.role === 'assistant') {
      for (const block of blocks) if (block?.type === 'tool_use') calls.set(block.id, { name: block.name, path: block.input?.path });
      for (const call of message.tool_calls ?? []) {
        if (!call?.id) continue;
        let path;
        if (call.function?.name === 'read') try { path = JSON.parse(call.function.arguments).path; } catch { /* incomplete tool call */ }
        calls.set(call.id, { name: call.function?.name, path });
      }
    }
    const source = message.role === 'assistant' ? conversationEnvelope('assistant')
      : message.role === 'tool' ? toolSource(message.tool_call_id, id) : { ...sourceEnvelope('user_input'), submittedBy: 'user' };
    return { ...message, content: wrapContent(message.content, { ...source, id }, pasteSpans, toolSource) };
  });
  if (protocol === 'messages') {
    const system = Array.isArray(body.system) ? [...body.system, { type: 'text', text: checklist }]
      : [body.system, checklist].filter(Boolean).join('\n');
    return { ...body, system, messages };
  }
  const at = messages.findIndex(message => message.role === 'system');
  if (at < 0) messages.unshift({ role: 'system', content: checklist });
  else {
    const existing = messages[at].content;
    messages[at] = { ...messages[at], content: Array.isArray(existing) ? [...existing, { type: 'text', text: checklist }] : [existing, checklist].filter(Boolean).join('\n') };
  }
  return { ...body, messages };
}
