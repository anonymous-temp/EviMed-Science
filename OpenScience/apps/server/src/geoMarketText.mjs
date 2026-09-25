import { createHash } from "node:crypto";

/**
 * What an article looks like on its way to an outlet and on its way back.
 *
 * Out: an article is Markdown in the project's workspace; the marketplace takes
 * HTML. `markdownToHtml` renders the small Markdown the content capability
 * writes (headings, paragraphs, lists, tables, quotes, emphasis, links) and
 * escapes everything else, so what an outlet receives is exactly the text that
 * passed review, in tags.
 *
 * Back: outlets edit — 「修改不通知」 is the most common remark in the catalogue
 * — and an edit to a number, a drug name, a dose or a citation undoes the
 * medical review the article passed. So after publication the page text is
 * compared with what was sent, span by span:
 *
 * - The protected spans are extracted from the text of the HTML we sent:
 *   numbers with their unit (doses, frequencies, percentages, ranges), the
 *   Chinese frequency phrases (每日一次, 每周 1 次), the registered drug names of
 *   the project (brand, generic, aliases, competitors), URLs, DOIs, PMIDs and
 *   bracketed reference markers. Bare one-digit numbers are not spans: "3"
 *   occurs on any page, and a match on it would prove nothing.
 * - Comparison is byte-exact after one normalisation, HTML → text with all
 *   Unicode whitespace removed on both sides. Whitespace is layout (an editor's
 *   "2.4 mg" → "2.4mg", or an extractor joining inline tags); no other folding
 *   is done — no NFKC, no full/half width — so "15%" → "15％" is a change.
 * - Each span must occur in the page at least as many times as in the article.
 *   A numeric span must not be glued to more digits ("2.4mg" inside "12.4mg").
 *
 * Build to delete: this is a fixed extractor. The day the content capability
 * writes its own protected-span manifest next to each article (the humanize
 * pass already knows them), the market should compare against that manifest
 * and this extractor goes.
 *
 * @module geoMarketText
 */

/** At most this many spans are carried in an order's evidence. */
export const MAX_PROTECTED_SPANS = 400;
const MAX_SPAN_CHARS = 300;

const ENTITIES = Object.freeze({ amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", "#39": "'" });

/** @param {string} value */
export function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** @param {string} value */
function decodeEntities(value) {
  return value.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, name) => {
    const lower = String(name).toLowerCase();
    if (lower.startsWith("#x")) {
      const code = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    if (lower.startsWith("#")) {
      const code = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return Object.hasOwn(ENTITIES, lower) ? ENTITIES[/** @type {keyof typeof ENTITIES} */ (lower)] : whole;
  });
}

/** Inline Markdown on already-escaped text: links, bold, italic, code. @param {string} escaped */
function inline(escaped) {
  return escaped
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => `<a href="${url}">${label}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
}

/** @param {string} line */
function tableCells(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

/**
 * Markdown → HTML for the send body. Unknown constructs are text, escaped.
 * @param {string} markdown
 */
export function markdownToHtml(markdown) {
  const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  /** @type {string[]} */
  let paragraph = [];
  const flush = () => {
    if (paragraph.length) out.push(`<p>${inline(escapeHtml(paragraph.join(" ")))}</p>`);
    paragraph = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) { flush(); continue; }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flush();
      const level = Math.min(heading[1].length, 6);
      out.push(`<h${level}>${inline(escapeHtml(heading[2].replace(/\s+#+\s*$/, "")))}</h${level}>`);
      continue;
    }
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { flush(); out.push("<hr>"); continue; }
    if (/^\|.*\|$/.test(trimmed) && index + 1 < lines.length && /^\|?\s*:?-{2,}/.test(lines[index + 1].trim())) {
      flush();
      const head = tableCells(trimmed);
      const rows = [];
      index += 2;
      while (index < lines.length && /^\|.*\|$/.test(lines[index].trim())) { rows.push(tableCells(lines[index])); index += 1; }
      index -= 1;
      out.push(`<table><thead><tr>${head.map((cell) => `<th>${inline(escapeHtml(cell))}</th>`).join("")}</tr></thead><tbody>${
        rows.map((row) => `<tr>${row.map((cell) => `<td>${inline(escapeHtml(cell))}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      continue;
    }
    const bullet = /^[-*+]\s+(.*)$/.exec(trimmed);
    const numbered = /^\d{1,3}[.)]\s+(.*)$/.exec(trimmed);
    if (bullet || numbered) {
      flush();
      const tag = bullet ? "ul" : "ol";
      const pattern = bullet ? /^[-*+]\s+(.*)$/ : /^\d{1,3}[.)]\s+(.*)$/;
      const items = [];
      while (index < lines.length) {
        const match = pattern.exec(lines[index].trim());
        if (!match) break;
        items.push(`<li>${inline(escapeHtml(match[1]))}</li>`);
        index += 1;
      }
      index -= 1;
      out.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(trimmed);
    if (quote) { flush(); out.push(`<blockquote><p>${inline(escapeHtml(quote[1]))}</p></blockquote>`); continue; }
    paragraph.push(trimmed);
  }
  flush();
  return out.join("\n");
}

const BLOCK_TAGS = /<\/?(?:p|div|br|h[1-6]|li|ul|ol|tr|td|th|table|thead|tbody|blockquote|hr|section|article|header|footer)\b[^>]*>/gi;

/**
 * HTML → text: scripts and styles dropped, block tags become line breaks,
 * other tags vanish, entities decoded, runs of whitespace collapsed.
 * @param {string} html
 */
export function htmlToText(html) {
  return decodeEntities(String(html ?? "")
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(BLOCK_TAGS, "\n")
    .replace(/<[^>]+>/g, ""))
    .replace(/[^\S\n]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

/** Text with every Unicode whitespace character removed: the comparison form. @param {string} value */
export function comparisonForm(value) {
  return String(value ?? "").replace(/\s+/gu, "");
}

const UNIT = "(?:mg\\/kg|mg\\/d|mg\\/dL|mmol\\/L|μmol\\/L|umol\\/L|g\\/L|mL\\/min|IU\\/mL|kg\\/m²|kg\\/m2|mmHg|mcg|μg|ug|mg|ng|kg|g|mL|ml|L|IU|U|%|‰|倍|例|人|次\\/[日天周月]|次|片|粒|支|袋|瓶|滴|mg|周|天|日|个月|月|年|小时|分钟|h|min|岁)";
const NUMBER = "\\d+(?:[.,]\\d+)*";
const NUMERIC_SPAN = new RegExp(`${NUMBER}(?:\\s?(?:[-~～至到–—]\\s?)${NUMBER})?(?:\\s?${UNIT})?`, "gu");
// 「每周注射一次」「每日 2 次」「每周 0.25 mg」「一日三次」: the interval and the count
// together, so 每周 → 每天 is a change even when the count stays.
const FREQUENCY = /每(?:日|天|周|月|晚|次)[^，。；,;！!？?\n]{0,8}?[一二两三四五六七八九十半\d]+(?:[.．]\d+)?\s?(?:次|片|粒|支|袋|mg|毫克)|[一二两三四五六七八九十\d]+\s?(?:日|天|周)\s?[一二两三四五六七八九十\d]+\s?次/gu;
const URL_SPAN = /https?:\/\/[^\s<>"'（）()【】「」，。；、]+/gu;
const DOI_SPAN = /\b10\.\d{4,9}\/[^\s"'<>，。；、）)]+/gu;
const PMID_SPAN = /PMID[:：]?\s?\d{5,9}/giu;
const REFERENCE_MARKER = /\[\d{1,3}(?:[,，\-–]\d{1,3})*\]/gu;

/**
 * @typedef {object} ProtectedSpan
 * @property {"number" | "frequency" | "drug" | "url" | "doi" | "pmid" | "reference"} kind
 * @property {string} text the span as the reader sees it
 * @property {number} count how often it occurs in the article
 */

/**
 * The protected spans of an article's text, with their multiplicity, in first
 * appearance order.
 * @param {string} text the article's plain text (`htmlToText` of what is sent)
 * @param {{ terms?: string[] }} [options] the project's registered drug names
 * @returns {ProtectedSpan[]}
 */
export function extractProtectedSpans(text, { terms = [] } = {}) {
  const source = String(text ?? "");
  /** @type {Map<string, ProtectedSpan>} */
  const spans = new Map();
  /** @type {Array<[number, number]>} character ranges already inside a span */
  const taken = [];
  const overlaps = (/** @type {number} */ start, /** @type {number} */ end) => taken.some(([a, b]) => start < b && end > a);
  /** @param {ProtectedSpan["kind"]} kind @param {RegExp} pattern @param {(match: string) => boolean} [accept] */
  const collect = (kind, pattern, accept = () => true) => {
    for (const match of source.matchAll(pattern)) {
      const raw = match[0].replace(/[.,，。;；:：]+$/u, "");
      const start = match.index ?? 0;
      const end = start + raw.length;
      if (!raw || raw.length > MAX_SPAN_CHARS || overlaps(start, end) || !accept(raw)) continue;
      taken.push([start, end]);
      const key = `${kind}\u0000${comparisonForm(raw)}`;
      const existing = spans.get(key);
      if (existing) existing.count += 1;
      else spans.set(key, { kind, text: raw, count: 1 });
    }
  };
  collect("url", URL_SPAN);
  collect("doi", DOI_SPAN);
  collect("pmid", PMID_SPAN);
  collect("reference", REFERENCE_MARKER);
  const names = [...new Set(terms.map((term) => String(term ?? "").trim()).filter((term) => term.length >= 2 && term.length <= 60))]
    .sort((a, b) => b.length - a.length);
  if (names.length) {
    const alternation = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    collect("drug", new RegExp(alternation, "gu"));
  }
  collect("frequency", FREQUENCY);
  collect("number", NUMERIC_SPAN, (raw) => {
    const digits = raw.replace(/\D/g, "");
    const hasUnit = /\D$/u.test(raw.trim());
    // A bare single digit is on every page; it proves nothing either way.
    return hasUnit || digits.length >= 2;
  });
  return [...spans.values()].slice(0, MAX_PROTECTED_SPANS);
}

/**
 * A text in comparison form (whitespace removed) with, for every character
 * kept, its index in the original — so a match can be judged by what stands
 * next to it in the page as written, where whitespace still separates tokens.
 * @param {string} text
 */
function comparisonIndex(text) {
  let form = "";
  /** @type {number[]} original index of every UTF-16 unit of `form` */
  const positions = [];
  for (let index = 0; index < text.length;) {
    const width = /** @type {number} */ (text.codePointAt(index)) > 0xffff ? 2 : 1;
    const character = text.slice(index, index + width);
    if (!/\s/u.test(character)) {
      form += character;
      for (let unit = 0; unit < width; unit += 1) positions.push(index + unit);
    }
    index += width;
  }
  return { form, positions, original: text };
}

/**
 * How often `needle` (in comparison form) occurs in the page; a numeric needle
 * does not count where, in the page as written, it is glued to more digits
 * ("2.4mg" inside "12.4mg", "24" inside "245").
 * @param {ReturnType<typeof comparisonIndex>} page @param {string} needle @param {boolean} numeric
 */
function occurrences(page, needle, numeric) {
  if (!needle) return 0;
  const { form, positions, original } = page;
  let count = 0;
  for (let from = form.indexOf(needle); from !== -1; from = form.indexOf(needle, from + 1)) {
    if (numeric) {
      const before = original[positions[from] - 1] ?? "";
      const after = original[positions[from + needle.length - 1] + 1] ?? "";
      if (/[\d.．]/.test(before) || (/^\d$/.test(after) && /\d$/.test(needle))) continue;
    }
    count += 1;
  }
  return count;
}

/**
 * @typedef {object} TextComparison
 * @property {number} protectedTotal distinct spans checked
 * @property {number} protectedMatched spans found at least as often as sent
 * @property {Array<{ kind: string, text: string, expected: number, found: number }>} missing
 */

/**
 * Compare the spans sent with the page as fetched.
 * @param {ProtectedSpan[]} spans @param {string} fetchedText the page's text as the web reader extracted it
 * @returns {TextComparison}
 */
export function compareProtectedSpans(spans, fetchedText) {
  const page = comparisonIndex(decodeEntities(String(fetchedText ?? "")));
  const missing = [];
  let matched = 0;
  for (const span of spans) {
    const numeric = span.kind === "number";
    const found = occurrences(page, comparisonForm(span.text), numeric);
    if (found >= span.count) matched += 1;
    else missing.push({ kind: span.kind, text: span.text, expected: span.count, found });
  }
  return { protectedTotal: spans.length, protectedMatched: matched, missing };
}

/**
 * An article's leading `# heading` is its title: the vendor takes the title in
 * its own field, and an outlet's page header is often outside the main text a
 * reader extracts — left in the body it would read as a change.
 * @param {string} markdown
 * @returns {{ title: string | null, body: string }}
 */
export function splitLeadingTitle(markdown) {
  const text = String(markdown ?? "").replace(/^\uFEFF/, "");
  const match = /^\s*#\s+([^\n]+)\n?/.exec(text);
  if (!match) return { title: null, body: text };
  return { title: match[1].replace(/\s+#+\s*$/, "").trim(), body: text.slice(match[0].length) };
}

/** @param {string | Buffer} value */
export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}
