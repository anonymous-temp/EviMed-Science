// In-process lexical retrieval for the evaluation: tokenizer, chunker and BM25. It stands in for the platform's
// `kb_search` so that every arm searches the same way; the only thing that differs between the arms is what
// documents the index holds.

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const TOKEN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|\d+(?:[.,·]\d+)*|[\p{L}\p{M}]+/gu

/** Words that carry no weight in a question; deliberately short. CJK text has no stop list: its unigrams are weighted by BM25's idf. */
const STOPWORDS = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'did', 'do', 'does', 'for', 'from', 'how', 'in', 'is', 'it', 'of', 'on', 'or',
  'that', 'the', 'their', 'there', 'these', 'this', 'to', 'was', 'were', 'what', 'when', 'where', 'which', 'who', 'why', 'with', 'vs', 'versus', 'than', 'and'])

/**
 * A light, deterministic stemmer: plural, the commonest verb endings and a final "e", so that "rate", "rates", "bleeding" and
 * "bleed" meet. It is not linguistically right and does not need to be: query and passage are stemmed the same way.
 */
export function stem(word) {
  let value = word
  if (value.length > 5 && value.endsWith('ies')) value = `${value.slice(0, -3)}y`
  else if (value.length > 5 && value.endsWith('sses')) value = value.slice(0, -2)
  else if (value.length > 4 && /(?:s|x|z|ch|sh)es$/.test(value)) value = value.slice(0, -2)
  else if (value.length > 3 && value.endsWith('s') && !value.endsWith('ss')) value = value.slice(0, -1)
  if (value.length > 5 && value.endsWith('ing')) value = value.slice(0, -3)
  else if (value.length > 4 && /[^e]ed$/.test(value)) value = value.slice(0, -2)
  if (value.length > 3 && value.endsWith('e')) value = value.slice(0, -1)
  return value
}

/**
 * Tokens of a text. Words are lower-cased and stemmed, numbers keep their decimals ("0.79", also written "0·79"), and a run of
 * CJK characters contributes each character and each pair of neighbours, so a Chinese query meets a Chinese passage without
 * a word segmenter.
 * @param {string} text @returns {string[]}
 */
export function tokenize(text) {
  const tokens = []
  const normalized = String(text ?? '').normalize('NFKC').toLowerCase()
  for (const match of normalized.matchAll(TOKEN)) {
    const piece = match[0]
    if (CJK.test(piece)) {
      const characters = [...piece]
      for (const character of characters) tokens.push(character)
      for (let index = 0; index + 1 < characters.length; index += 1) tokens.push(characters[index] + characters[index + 1])
    } else if (/^\d/.test(piece)) {
      tokens.push(piece.replace(/[,·]/g, '.'))
    } else if (!STOPWORDS.has(piece)) {
      tokens.push(stem(piece))
    }
  }
  return tokens
}

/**
 * A text cut into passages with their offsets. The unit is a line (a page's list item is one line and is never cut); a document line longer
 * than `maxChars` is cut at sentence ends. With `blocks`, the unit is a block instead — the lines between two blank lines: a paragraph with
 * the source link under it, a table, a list — and a block is never cut. Passages are packed up to `maxChars`, and each repeats the last
 * short unit of the one before it. `text.slice(start, end)` is always the passage.
 * @param {string} text
 * @param {{ maxChars?: number, splitLongLines?: boolean, blocks?: boolean }} [options]
 * @returns {Array<{ start: number, end: number, text: string }>}
 */
export function chunkText(text, { maxChars = 700, splitLongLines = true, blocks = false } = {}) {
  const units = []
  let offset = 0
  let open = false
  for (const line of String(text).split('\n')) {
    const lineStart = offset
    offset += line.length + 1
    if (!line.trim()) { open = false; continue }
    if (blocks) {
      if (open) units[units.length - 1].end = lineStart + line.length
      else units.push({ start: lineStart, end: lineStart + line.length })
      open = true
      continue
    }
    if (!splitLongLines || line.length <= maxChars) { units.push({ start: lineStart, end: lineStart + line.length }); continue }
    let from = 0
    const sentence = /(?:[.!?]\s+|[。！？])/g
    let match
    while ((match = sentence.exec(line)) !== null) {
      const end = match.index + match[0].trimEnd().length
      if (end - from >= maxChars / 2) { units.push({ start: lineStart + from, end: lineStart + end }); from = match.index + match[0].length }
    }
    if (from < line.length) units.push({ start: lineStart + from, end: lineStart + line.length })
  }
  // A unit still longer than the ceiling is cut hard: no passage may be unbounded.
  const bounded = []
  for (const unit of units) {
    if (blocks || !splitLongLines || unit.end - unit.start <= maxChars * 1.5) { bounded.push(unit); continue }
    for (let from = unit.start; from < unit.end; from += maxChars) bounded.push({ start: from, end: Math.min(unit.end, from + maxChars) })
  }
  const chunks = []
  let current = []
  const flush = () => {
    if (!current.length) return
    const start = current[0].start
    const end = current[current.length - 1].end
    chunks.push({ start, end, text: String(text).slice(start, end) })
  }
  for (const unit of bounded) {
    const size = current.length ? unit.end - current[0].start : unit.end - unit.start
    if (current.length && size > maxChars) {
      flush()
      const tail = current[current.length - 1]
      current = tail.end - tail.start <= maxChars / 3 && current.length > 1 ? [tail] : []
    }
    current.push(unit)
  }
  flush()
  return chunks
}

/**
 * @typedef {object} IndexDocument
 * @property {string} id         what a hit names: `src_…` for a document, `page:<path>` for a knowledge page
 * @property {'document' | 'page'} kind
 * @property {string} title
 * @property {string} text
 * @property {boolean} [blocks]  a page whose passages are its blocks, not its lines (upstream's pages; see `chunkText`)
 */

export class Bm25Index {
  /** @param {{ k1?: number, b?: number, maxChars?: number }} [options] */
  constructor({ k1 = 1.2, b = 0.75, maxChars = 700 } = {}) {
    this.k1 = k1
    this.b = b
    this.maxChars = maxChars
    /** @type {Array<{ docId: string, kind: string, title: string, start: number, end: number, text: string, tf: Map<string, number>, length: number }>} */
    this.chunks = []
    this.documentFrequency = new Map()
    this.totalLength = 0
  }

  /** @param {IndexDocument} document */
  add(document) {
    const pieces = document.kind === 'page'
      ? chunkText(document.text, { maxChars: this.maxChars * 1.6, splitLongLines: false, blocks: document.blocks === true })
      : chunkText(document.text, { maxChars: this.maxChars })
    for (const piece of pieces) {
      // The title is searchable with every passage, as a library's metadata would be.
      const tokens = tokenize(`${document.title}\n${piece.text}`)
      const tf = new Map()
      for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1)
      for (const token of tf.keys()) this.documentFrequency.set(token, (this.documentFrequency.get(token) ?? 0) + 1)
      this.chunks.push({ docId: document.id, kind: document.kind, title: document.title, start: piece.start, end: piece.end, text: piece.text, tf, length: tokens.length })
      this.totalLength += tokens.length
    }
  }

  /** @param {string} query @param {number} [limit] @returns {Array<{ docId: string, kind: string, title: string, start: number, end: number, text: string, score: number }>} */
  search(query, limit = 5) {
    const terms = [...new Set(tokenize(query))]
    if (!terms.length || !this.chunks.length) return []
    const count = this.chunks.length
    const average = this.totalLength / count
    const scored = []
    for (const chunk of this.chunks) {
      let score = 0
      for (const term of terms) {
        const frequency = chunk.tf.get(term)
        if (!frequency) continue
        const containing = this.documentFrequency.get(term) ?? 0
        const idf = Math.log(1 + (count - containing + 0.5) / (containing + 0.5))
        score += idf * (frequency * (this.k1 + 1)) / (frequency + this.k1 * (1 - this.b + this.b * chunk.length / average))
      }
      if (score > 0) scored.push({ chunk, score })
    }
    // Ties break by position so a result never depends on the order the engine happened to visit chunks in.
    scored.sort((left, right) => right.score - left.score || (left.chunk.docId < right.chunk.docId ? -1 : left.chunk.docId > right.chunk.docId ? 1 : left.chunk.start - right.chunk.start))
    return scored.slice(0, limit).map(({ chunk, score }) => ({ docId: chunk.docId, kind: chunk.kind, title: chunk.title, start: chunk.start, end: chunk.end, text: chunk.text, score }))
  }
}

/** @param {IndexDocument[]} documents @param {{ maxChars?: number }} [options] */
export function buildIndex(documents, options = {}) {
  const index = new Bm25Index(options)
  for (const document of documents) index.add(document)
  return index
}
