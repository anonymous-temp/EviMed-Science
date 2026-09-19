/**
 * How a captured document is cut into searchable chunks, and how a chunk and a
 * query become terms. Pure functions: the index calls them, and so does the
 * regression test that holds them still.
 *
 * Hidden knowledge, from the retrieval literature the plan cites (Anthropic's
 * Contextual Retrieval, NVIDIA's chunking comparison): cut along the
 * document's own structure first — a page, a slide, a sheet, a heading — and
 * only then by length; never split a table, because a row without its header is
 * a number without a meaning; and put the document's title and section path in
 * front of every chunk before it is embedded or matched, which is what lets a
 * chunk that says only 「剂量：15 mg」 be found by a question about one drug.
 *
 * Offsets are UTF-16 units into the captured text — the text a quotation is
 * checked against — and a chunk's `content` is exactly that slice. The context
 * prefix is stored beside it, never inside it.
 */

import { searchTokens } from "./memoryRecallPolicy.mjs";

/** Split past this many estimated tokens (plan §3.2: ~1000). */
export const KB_CHUNK_TARGET_TOKENS = 1000;
/** A document cut into more chunks than this is indexed to this many; the
 *  rest stays readable as a file. Far past any document a researcher uploads. */
export const KB_MAX_CHUNKS_PER_DOCUMENT = 20_000;
/** How much of a chunk's prefix and text one embedding request carries. */
const MAX_EMBEDDING_CHARS = 8_000;
/** Characters handed to `searchTokens` at a time: it returns at most 64 terms,
 *  and a window this long yields fewer, so no term of a long run is lost. */
const TOKEN_WINDOW = 48;
/** A lexeme keeps at most this many positions (PostgreSQL's own limit is 256). */
const MAX_POSITIONS = 255;
const MAX_POSITION = 16_383;

/**
 * Tokens as a model counts them, roughly: a CJK character is about one, other
 * text about four characters each. Used for chunk sizes and the small-library
 * threshold, where a stable estimate matters more than an exact count.
 * @param {string} text
 */
export function estimateTokens(text) {
  const value = String(text ?? "");
  const cjk = (value.match(/[㐀-鿿豈-﫿]/g) ?? []).length;
  return cjk + Math.ceil((value.length - cjk) / 4);
}

/** @param {string} line */
function headingOf(line) {
  const match = /^(#{1,6})[ \t]+(\S.*?)[ \t#]*$/.exec(line);
  return match ? { level: match[1].length, title: match[2].slice(0, 200) } : null;
}

/**
 * The blocks one span of text is made of: headings, tables (Markdown pipes or
 * an HTML table, never split), and paragraphs between blank lines.
 * @param {string} text @param {number} from @param {number} to
 * @returns {{ type: "heading"|"table"|"paragraph", start: number, end: number, level?: number, title?: string }[]}
 */
function blocksOf(text, from, to) {
  /** @type {{ start: number, end: number, line: string }[]} */
  const lines = [];
  for (let cursor = from; cursor < to;) {
    const newline = text.indexOf("\n", cursor);
    const end = newline === -1 || newline >= to ? to : newline + 1;
    lines.push({ start: cursor, end, line: text.slice(cursor, end).replace(/\r?\n$/, "") });
    cursor = end;
  }
  const blocks = [];
  let index = 0;
  while (index < lines.length) {
    const { line, start } = lines[index];
    const heading = headingOf(line);
    if (heading) {
      blocks.push({ type: /** @type {const} */ ("heading"), start, end: lines[index].end, ...heading });
      index += 1;
      continue;
    }
    if (/^\s*\|/.test(line)) {
      let last = index;
      while (last + 1 < lines.length && /^\s*\|/.test(lines[last + 1].line)) last += 1;
      blocks.push({ type: /** @type {const} */ ("table"), start, end: lines[last].end });
      index = last + 1;
      continue;
    }
    if (/<table[\s>]/i.test(line)) {
      let last = index;
      while (last < lines.length - 1 && !/<\/table>/i.test(lines[last].line)) last += 1;
      blocks.push({ type: /** @type {const} */ ("table"), start, end: lines[last].end });
      index = last + 1;
      continue;
    }
    if (!line.trim()) { index += 1; continue; }
    let last = index;
    while (last + 1 < lines.length && lines[last + 1].line.trim() && !headingOf(lines[last + 1].line)
      && !/^\s*\|/.test(lines[last + 1].line) && !/<table[\s>]/i.test(lines[last + 1].line)) last += 1;
    blocks.push({ type: /** @type {const} */ ("paragraph"), start, end: lines[last].end });
    index = last + 1;
  }
  return blocks;
}

/** Where a too-long paragraph may be cut: after a sentence end, else a line,
 *  else at the length itself, never inside a surrogate pair.
 * @param {string} text @param {number} start @param {number} end */
function splitLong(text, start, end) {
  const pieces = [];
  let cursor = start;
  while (cursor < end) {
    let stop = cursor;
    let tokens = 0;
    let lastBreak = -1;
    while (stop < end && tokens < KB_CHUNK_TARGET_TOKENS) {
      const character = text[stop];
      tokens += /[㐀-鿿豈-﫿]/.test(character) ? 1 : 0.25;
      stop += 1;
      if ("。！？!?；;\n".includes(character) || (character === "." && /\s/.test(text[stop] ?? " "))) lastBreak = stop;
    }
    if (stop < end && lastBreak > cursor + 1) stop = lastBreak;
    const code = text.charCodeAt(stop - 1);
    if (stop < end && code >= 0xD800 && code <= 0xDBFF) stop -= 1;
    pieces.push({ start: cursor, end: stop });
    cursor = stop;
  }
  return pieces;
}

/**
 * Cut a captured document into chunks.
 *
 * With a page map every page (a slide, a sheet — whatever the parser counted)
 * is cut on its own; without one the whole text is. Inside, a heading starts a
 * new chunk, blocks are packed up to the target, a longer paragraph is cut at
 * sentence ends, and a table always stays whole however long it is.
 *
 * @param {{ text: string, pageMap?: { page: number, start: number, end: number }[] | null, title: string }} input
 * @returns {{ ordinal: number, start: number, end: number, page: number | null, headingPath: string, prefix: string }[]}
 */
export function chunkDocument({ text, pageMap = null, title }) {
  const value = String(text ?? "");
  // Every character lands in exactly one segment, so nothing a page map fails
  // to claim drops out of the index. A page's segment begins where the one
  // before it ended: the whitespace a parser leaves between pages belongs to
  // the page that follows — the same answer `sourcePageForOffset` gives, so a
  // chunk's page is the page of every offset inside it — and text past the
  // last page is a segment of its own, with no page.
  /** @type {{ start: number, end: number, page: number | null }[]} */
  const segments = [];
  if (Array.isArray(pageMap) && pageMap.length) {
    let cursor = 0;
    for (const entry of pageMap) {
      const end = Math.min(entry.end, value.length);
      if (!(entry.end > entry.start) || end <= cursor) continue;
      segments.push({ start: cursor, end, page: entry.page });
      cursor = end;
    }
    if (cursor < value.length) segments.push({ start: cursor, end: value.length, page: null });
  } else segments.push({ start: 0, end: value.length, page: null });
  /** @type {string[]} */
  const headings = [];
  /** @type {{ start: number, end: number, page: number | null, headingPath: string }[]} */
  const spans = [];
  /** @type {{ start: number, end: number, tokens: number, page: number | null, headingPath: string } | null} */
  let current = null;
  const flush = () => { if (current) spans.push({ start: current.start, end: current.end, page: current.page, headingPath: current.headingPath }); current = null; };
  for (const segment of segments) {
    flush();
    for (const block of blocksOf(value, segment.start, segment.end)) {
      if (block.type === "heading") {
        flush();
        headings.length = Math.min(headings.length, (block.level ?? 1) - 1);
        headings.push(block.title ?? "");
      }
      const path = headings.filter(Boolean).join(" › ");
      const tokens = estimateTokens(value.slice(block.start, block.end));
      if (block.type === "paragraph" && tokens > KB_CHUNK_TARGET_TOKENS) {
        const pieces = splitLong(value, block.start, block.end);
        // A heading, or a line or two, just before a long section belongs to
        // its first piece rather than becoming a chunk of its own.
        if (current && current.tokens < KB_CHUNK_TARGET_TOKENS / 4) {
          pieces[0] = { start: current.start, end: pieces[0].end };
          current = null;
        } else flush();
        for (const piece of pieces) spans.push({ ...piece, page: segment.page, headingPath: path });
        continue;
      }
      if (current && current.tokens + tokens > KB_CHUNK_TARGET_TOKENS) flush();
      if (!current) current = { start: block.start, end: block.end, tokens, page: segment.page, headingPath: path };
      else { current.end = block.end; current.tokens += tokens; }
    }
  }
  flush();
  const name = String(title ?? "").trim();
  return spans.slice(0, KB_MAX_CHUNKS_PER_DOCUMENT).map((span, ordinal) => ({
    ordinal, start: span.start, end: span.end, page: span.page, headingPath: span.headingPath,
    prefix: [name, span.headingPath].filter(Boolean).join(" › "),
  }));
}

/**
 * Every search term of a text, reusing the recall policy's own tokenizer (CJK
 * pairs and runs, Latin words) so a question and a chunk are cut the same way.
 * That tokenizer returns at most 64 terms per call, which is right for a
 * question and too few for a page, so a chunk is fed to it a window at a time,
 * cut only between terms — or, inside one long CJK run, overlapping by one
 * character so no pair is lost.
 * @param {string} text
 * @returns {Map<string, number[]>} term → positions (1-based, bounded)
 */
export function documentTerms(text) {
  /** @type {Map<string, number[]>} */
  const terms = new Map();
  let position = 0;
  const lower = String(text ?? "").toLowerCase();
  for (const piece of lower.split(/[^a-z0-9._\-㐀-鿿]+/)) {
    if (!piece) continue;
    for (let at = 0; at < piece.length; at += TOKEN_WINDOW - 1) {
      for (const term of searchTokens(piece.slice(at, at + TOKEN_WINDOW))) {
        position = Math.min(MAX_POSITION, position + 1);
        const positions = terms.get(term) ?? [];
        if (positions.length < MAX_POSITIONS) positions.push(position);
        terms.set(term, positions);
      }
      if (at + TOKEN_WINDOW >= piece.length) break;
    }
  }
  return terms;
}

/** @param {string} term */
function quoteLexeme(term) {
  return `'${term.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
}

/**
 * A `tsvector` literal for a chunk: its terms, written as lexemes with their
 * positions, and never normalised again by a text-search configuration — the
 * terms are already what `searchTokens` makes, which is the point.
 * @param {string} text
 */
export function tsvectorLiteral(text) {
  return [...documentTerms(text)].map(([term, positions]) => `${quoteLexeme(term)}:${positions.join(",")}`).join(" ");
}

/**
 * A `tsquery` literal matching any of a question's terms, or `""` when it has
 * none. Ranking decides how many of them a chunk has; the match itself is an
 * OR, so a question in its own words still reaches a chunk in the document's.
 * @param {string} query
 */
export function tsqueryLiteral(query) {
  const terms = searchTokens(query);
  return terms.length ? terms.map(quoteLexeme).join(" | ") : "";
}

/** The Latin words of a question worth a trigram lookup: drug names and their
 *  misspellings are where the CJK pairs cannot help. @param {string} query */
export function trigramTerms(query) {
  return [...new Set(String(query ?? "").toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? [])].slice(0, 16);
}

/** What one chunk contributes to an embedding request.
 * @param {{ prefix: string }} chunk @param {string} content */
export function embeddingText(chunk, content) {
  return `${chunk.prefix ? `${chunk.prefix}\n` : ""}${content}`.slice(0, MAX_EMBEDDING_CHARS);
}
