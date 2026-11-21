/** Read coverage is evidence about an operation, never about the person's facts.
 * Counts contain no URI, query, title or withdrawn wording. Null means unknown.
 * @returns {any} */
export function readStatus(state, reason = null, counts = {}) {
  return { state, ...(reason ? { reason } : {}), candidates: null, droppedByScore: null,
    droppedByFence: null, ...counts };
}

export function searchStatusText(sources) {
  return `Memory lookup status: ${JSON.stringify(sources)}\nCounts cover returned candidates only, not the whole store. Only searched/empty sources completed their lookup; unavailable or skipped is not evidence of absence. Withdrawn material must not be reconstructed.`;
}

/** Preserve an array API used by cleanup callers while exposing request-local coverage.
 * @returns {any} */
export function withReadStatus(items, status) {
  Object.defineProperty(items, 'readStatus', { value: status, enumerable: false, configurable: true });
  return items;
}

/** A failed or timed-out source never silently becomes an empty successful lookup.
 * @param {() => Promise<any[]>} read @param {number} timeoutMs
 * @returns {Promise<{items: any[], status: any}>} */
export async function measuredRead(read, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(read).then(items => ({ items, status: /** @type {any} */ (items).readStatus ?? readStatus(items.length ? 'searched' : 'empty') }))
        .catch(() => ({ items: [], status: readStatus('unavailable', 'source_failed') })),
      /** @type {Promise<{items: any[], status: any}>} */ (new Promise(resolve => { timer = setTimeout(() => resolve({ items: [], status: readStatus('unavailable', 'timeout') }), timeoutMs); })),
    ]);
  } finally { clearTimeout(timer); }
}

/** Labels describe only what the store actually supplied. A timestamp is a record date, not an event date. */
export function memorySourceLabel(item) {
  const label = { origin: item.origin ?? 'unknown' };
  for (const key of ['speaker', 'sourceRole', 'statementKind', 'asOf', 'updatedAt', 'validFrom', 'validTo', 'earlierValue', 'attribution']) {
    if (item[key] !== undefined && item[key] !== null) label[key] = item[key];
  }
  return JSON.stringify(label).replace(/[<>]/g, value => value === '<' ? '\\u003c' : '\\u003e');
}

/** Index labels only: no semantic interpretation, stop-word list or inferred identity. */
export function literalIndexMatch(query, labels) {
  const normalize = value => String(value).normalize('NFKC').toLowerCase();
  const text = normalize(query);
  return labels.some(label => {
    const name = normalize(label).replace(/\.md$/, '').trim();
    if (name.length < 2) return false;
    let offset = text.indexOf(name);
    while (offset >= 0) {
      const before = text[offset - 1] ?? '', after = text[offset + name.length] ?? '';
      if (!(/[a-z0-9]/.test(name[0]) && /[a-z0-9]/.test(before))
        && !(/[a-z0-9]/.test(name.at(-1)) && /[a-z0-9]/.test(after))) return true;
      offset = text.indexOf(name, offset + 1);
    }
    return false;
  });
}

// Use marked literals only. Sentence-initial capitalization alone is ambiguous.
export function literalAnchors(query) {
  const text = String(query ?? '').normalize('NFKC').slice(0, 2000);
  const anchors = new Set();
  for (const match of text.matchAll(/"([^"\n]{1,120})"|“([^”\n]{1,120})”|「([^」\n]{1,120})」|《([^》\n]{1,120})》|‘([^’\n]{1,120})’|(?<![\p{L}\p{N}])'([^'\n]{1,120})'(?![\p{L}\p{N}])/gu)) {
    anchors.add(match.slice(1).find(Boolean).trim());
  }
  for (const match of text.matchAll(/\d{4}年\d{1,2}月(?:\d{1,2}日)?|[A-Za-z0-9]+(?:[-_.:/][A-Za-z0-9]+)*/gu)) {
    const word = match[0];
    if (/\d|[a-z][A-Z]|[A-Z]{2}/u.test(word) || /^[A-Z][a-z]{1,}$/u.test(word) && (match.index > 0 || text.trim() === word)) anchors.add(word);
  }
  return [...anchors].filter(Boolean).slice(0, 16);
}

export function containsAnchor(text, anchors) {
  const normalized = String(text ?? '').normalize('NFKC').toLowerCase();
  return anchors.some(anchor => {
    const escaped = anchor.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp((/^[a-z0-9]/i.test(anchor) ? '(?<![a-z0-9])' : '') + escaped
      + (/[a-z0-9]$/i.test(anchor) ? '(?![a-z0-9])' : ''), 'u').test(normalized);
  });
}
