/**
 * A parsed document's bibliographic block, checked where it can be checked.
 *
 * The parser's title, authors and DOI are written by a language model reading
 * the first and last 8,000 characters (`services/metadata.py`). They are useful
 * labels and nothing more — model-extracted, code-verified. The one field code
 * can verify is the DOI: Crossref says which work a DOI names, and a DOI whose
 * registered title is not this document's title is dropped with a note, so a
 * source card never presents someone else's paper as this one.
 *
 * What is not decidable stays, labelled as unconfirmed rather than dropped:
 * a DOI Crossref does not hold (Chinese journals often register theirs with
 * another agency), a document with no title to compare, and a title in another
 * script than the registered one (a Chinese PDF of a journal that registers
 * its English title). Dropping those would throw away DOIs printed on the
 * document's own first page on a technicality.
 */

const CROSSREF_WORKS = "https://api.crossref.org/works/";
const MAX_RESPONSE_BYTES = 1024 * 1024;
/** Character-bigram Dice similarity at or above which two titles are the same
 *  title. Subtitles, punctuation and markup move a true match to ~0.8; two
 *  different papers on one topic stay well under 0.5. */
const SAME_TITLE = 0.75;

/** @param {unknown} value */
function titleKey(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/<[^>]+>/g, " ")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/** @param {string} value */
const hasCjk = (value) => /[㐀-鿿]/.test(value);

/**
 * How alike two titles are, 0 to 1: the Dice coefficient over character pairs
 * after folding case, width, markup and punctuation away. A string metric for
 * "is this the same title", not a judgement of meaning.
 * @param {unknown} left @param {unknown} right
 */
export function titleSimilarity(left, right) {
  const a = titleKey(left);
  const b = titleKey(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  /** @param {string} text */
  const pairs = (text) => {
    const counts = new Map();
    for (let index = 0; index < text.length - 1; index += 1) {
      const pair = text.slice(index, index + 2);
      counts.set(pair, (counts.get(pair) ?? 0) + 1);
    }
    return counts;
  };
  const left2 = pairs(a);
  const right2 = pairs(b);
  let shared = 0;
  for (const [pair, count] of left2) shared += Math.min(count, right2.get(pair) ?? 0);
  const total = Math.max(1, a.length - 1 + b.length - 1);
  return Math.round(((2 * shared) / total) * 1000) / 1000;
}

/**
 * The metadata a source record keeps, with the DOI checked against Crossref.
 *
 * Never throws for a network or upstream failure: an unreachable Crossref
 * leaves the DOI unconfirmed, and the document is ingested either way.
 *
 * @param {Record<string, any> | undefined | null} metadata the parser's mapped block
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [options]
 * @returns {Promise<Record<string, any> | null>}
 */
export async function verifySourceMetadata(metadata, { fetchImpl = globalThis.fetch, timeoutMs = 8_000 } = {}) {
  if (!metadata || typeof metadata !== "object") return null;
  // The abstract already lives in the parse's summary; the record keeps the
  // fields a card and a citation header show, not a second copy of prose.
  const { abstract: _abstract, doi, ...rest } = metadata;
  if (!doi) return Object.keys(rest).length ? rest : null;
  const check = await checkDoi(doi, rest.title, { fetchImpl, timeoutMs });
  return check.status === "mismatch"
    ? { ...rest, doiCheck: check }
    : { ...rest, doi, doiCheck: check };
}

/**
 * @param {string} doi @param {unknown} title
 * @param {{ fetchImpl: typeof fetch, timeoutMs: number }} options
 */
async function checkDoi(doi, title, { fetchImpl, timeoutMs }) {
  const at = new Date().toISOString();
  let response;
  try {
    response = await fetchImpl(`${CROSSREF_WORKS}${encodeURIComponent(doi)}`, {
      headers: { accept: "application/json", "user-agent": "EviMed-Research/1.2 (source metadata check)" },
      redirect: "error",
      signal: AbortSignal.timeout(Math.max(1_000, timeoutMs)),
    });
  } catch {
    return { status: "unconfirmed", reason: "crossref_unreachable", at };
  }
  if (response.status === 404) {
    await response.body?.cancel().catch(() => {});
    return { status: "unconfirmed", reason: "not_registered_with_crossref", at };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return { status: "unconfirmed", reason: "crossref_unavailable", at };
  }
  let registered = [];
  try {
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new Error("oversized");
    const message = JSON.parse(text)?.message ?? {};
    registered = [...(Array.isArray(message.title) ? message.title : []), ...(Array.isArray(message["original-title"]) ? message["original-title"] : [])]
      .filter((value) => typeof value === "string" && value.trim()).slice(0, 8);
  } catch {
    return { status: "unconfirmed", reason: "crossref_response_invalid", at };
  }
  if (!registered.length) return { status: "unconfirmed", reason: "crossref_has_no_title", at };
  const own = typeof title === "string" ? title.trim() : "";
  if (!own) return { status: "unconfirmed", reason: "document_has_no_title", crossrefTitle: registered[0].slice(0, 500), at };
  // Only titles written in the same script are compared; the rest cannot
  // decide anything about each other.
  const comparable = registered.filter((candidate) => hasCjk(candidate) === hasCjk(own));
  if (!comparable.length) return { status: "unconfirmed", reason: "title_in_another_script", crossrefTitle: registered[0].slice(0, 500), at };
  const similarity = Math.max(...comparable.map((candidate) => titleSimilarity(own, candidate)));
  const best = comparable.find((candidate) => titleSimilarity(own, candidate) === similarity) ?? comparable[0];
  if (similarity >= SAME_TITLE) return { status: "verified", similarity, at };
  return { status: "mismatch", droppedDoi: doi, crossrefTitle: best.slice(0, 500), similarity, at };
}
