/** Answer-time controls, kept separate from the product gateway configuration. */
export const ANSWER_KEYS = new Set(['forceSearch', 'fullContext', 'thinking', 'answerModel', 'answerBase', 'answerKeyFile', 'contextTokens', 'answerStyle']);
export function answerOptions(config = {}) {
  const options = Object.fromEntries(Object.entries(config).filter(([key]) => ANSWER_KEYS.has(key)));
  if (options.answerStyle !== undefined && options.answerStyle !== 'concise') throw new Error('answerStyle is concise');
  if (options.forceSearch !== undefined && !['all', 'history', 'memory'].includes(options.forceSearch)) throw new Error('forceSearch is all, history or memory');
  if (options.fullContext !== undefined && typeof options.fullContext !== 'boolean') throw new Error('fullContext must be boolean');
  if (options.thinking !== undefined && !['enabled', 'disabled'].includes(options.thinking)) throw new Error('thinking is enabled or disabled');
  if (options.fullContext && options.forceSearch) throw new Error('fullContext cannot force memory search');
  if (options.contextTokens !== undefined && (!Number.isSafeInteger(options.contextTokens) || options.contextTokens < 128)) throw new Error('contextTokens must be an integer >=128');
  for (const key of ['answerModel', 'answerBase', 'answerKeyFile']) if (options[key] !== undefined && (typeof options[key] !== 'string' || !options[key])) throw new Error(`${key} must be nonempty text`);
  if (options.answerBase) {
    const url = new URL(options.answerBase);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('answerBase must be an HTTP(S) URL without credentials');
  }
  return options;
}
export const gatewayOptions = config => Object.fromEntries(Object.entries(config).filter(([key]) => !ANSWER_KEYS.has(key)));

/** The gateway labels raw history explicitly; preserve every block byte-for-byte. */
export function selectSearchBlocks(blocks, layer = 'all') {
  if (!['all', 'history', 'memory'].includes(layer)) throw new Error('invalid_search_layer');
  return blocks.filter(block => layer === 'all' || block.startsWith('Original conversation excerpts (') === (layer === 'history'));
}

/** UTF-8 bytes upper-bound token count. Reserve other prompt/output tokens separately.
 * Drop oldest whole sessions first; if the last session alone is too big, keep its tail.
 * This conservative budget needs no model-specific tokenizer and is recorded in each answer.
 */
export function fullTranscript(sessions, { contextTokens = 1_000_000, reserveTokens = 32_000 } = {}) {
  const budget = Math.max(1, contextTokens - Math.min(reserveTokens, Math.floor(contextTokens / 4)));
  const chunks = sessions.map(s => `Session ${s.sessionId} | ${s.at}\n${s.messages.map(m => `${m.role} | ${m.at ?? s.at}: ${m.text}`).join('\n\n')}`);
  const originalBytes = Buffer.byteLength(chunks.join('\n\n'));
  let droppedSessions = 0;
  while (chunks.length > 1 && Buffer.byteLength(chunks.join('\n\n')) > budget) { chunks.shift(); droppedSessions++; }
  let text = chunks.join('\n\n'), droppedBytes = 0;
  if (Buffer.byteLength(text) > budget) {
    const bytes = Buffer.from(text); droppedBytes = bytes.length - budget;
    // Decode only at a character boundary.
    while (droppedBytes < bytes.length && (bytes[droppedBytes] & 0xc0) === 0x80) droppedBytes++;
    text = bytes.subarray(droppedBytes).toString('utf8');
  }
  return { text, truncated: droppedSessions > 0 || droppedBytes > 0, droppedSessions, droppedBytes, originalBytes,
    includedBytes: Buffer.byteLength(text), contextTokens, reserveTokens, budgetMethod: 'UTF-8 bytes upper-bound tokens' };
}
