/**
 * The full text of the few papers a week's self-research reads closely.
 *
 * The weekly funnel screens titles and abstracts and reads only a dozen papers whole: the
 * paper's arXiv HTML page, and its PDF when the HTML does not exist. Both go through the platform's own web reader, so what protects the
 * rest of the platform protects this: robots.txt is read (arXiv's asks for fifteen seconds between requests, and the reader waits them),
 * every hop is checked against private addresses, the page is parsed off the event loop and its size is bounded. Nothing is crawled:
 * one page per paper, found by the paper's identifier and never by following a link.
 *
 * A paper that cannot be read whole is read from its abstract, and the fallback is counted with its reason; it is never an error. The text
 * is untrusted data and is only ever handed on as such.
 *
 * @module evolutionFullText
 */

/** The ledger keeps a record to 256 KiB and the preserved text is one record: a text of mathematics is three bytes a character, so the bytes are bounded as well. */
const MAX_BYTES = 120_000;

/** A text cut to a number of characters and of bytes, never inside a character. @param {string} text @param {number} maxChars */
export function boundedText(text, maxChars) {
  let bounded = text.slice(0, maxChars);
  if (Buffer.byteLength(bounded) > MAX_BYTES) bounded = Buffer.from(bounded).subarray(0, MAX_BYTES).toString('utf8').replace(/\uFFFD+$/, '');
  return bounded;
}

/**
 * @param {{ webReader: { read: (url: string, options?: any) => Promise<{ text: string, receipt?: any }> }|null, maxChars?: number, timeoutMs?: number }} dependencies
 */
export function createEvolutionFullTextReader({ webReader, maxChars = 60_000, timeoutMs = 180_000 }) {
  /** @param {string} url */
  async function page(url) {
    const result = await /** @type {NonNullable<typeof webReader>} */ (webReader).read(url, { signal: AbortSignal.timeout(timeoutMs) });
    const text = String(result.text ?? '').trim();
    return text ? { text, finalUrl: String(result.receipt?.finalUrl ?? url) } : null;
  }
  return {
    /**
     * @param {{ arxivId: string|null }} paper
     * @returns {Promise<{ kind: 'full', text: string, url: string, truncated: boolean } | { kind: 'abstract', reason: string }>}
     */
    async read(paper) {
      if (!webReader) return { kind: 'abstract', reason: 'no_reader' };
      if (!paper.arxivId) return { kind: 'abstract', reason: 'not_arxiv' };
      let reason = 'unreadable';
      for (const url of [`https://arxiv.org/html/${paper.arxivId}`, `https://arxiv.org/pdf/${paper.arxivId}`]) {
        try {
          const found = await page(url);
          if (found) { const text = boundedText(found.text, maxChars); return { kind: 'full', text, url: found.finalUrl, truncated: text.length < found.text.length }; }
          reason = 'empty';
        } catch (error) {
          const code = /** @type {any} */ (error)?.code;
          reason = typeof code === 'string' && /^[a-z0-9_]{1,60}$/.test(code) ? code : 'unreachable';
          // A page that is not there is the usual reason to try the PDF; a refusal by robots.txt, a private address or a spent
          // allowance is the same for the PDF, which sits on the same host.
          if (reason !== 'web_read_not_found' && reason !== 'web_read_content_type_unsupported') break;
        }
      }
      return { kind: 'abstract', reason };
    },
  };
}
