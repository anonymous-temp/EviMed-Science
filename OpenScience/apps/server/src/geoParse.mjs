/**
 * What a measured answer contains that code can count (build spec §5 "Parse +
 * judge", plan §4.3): which registered brands it names, how often, in what
 * order, whether in a list or a recommendation, and which sources it cites.
 *
 * Hidden knowledge:
 *
 * - **Only registered names are counted here.** The product's brand name,
 *   aliases and known misspellings, and each registered competitor's brand
 *   (or generic name when it has no brand), matched after case and width
 *   folding (NFKC + lower case, so 「ＡＢＣ」 and 「abc」 are one name).
 *   Unregistered drug products in the answer (M-04C's denominator) are named
 *   by the model judge; code re-checks each one is really in the text and
 *   counts it. Nothing here guesses a drug name from its shape — the owner's
 *   dosage-form regex is exactly the open-vocabulary pattern principle 5 rules
 *   out, and its own stop-word list is the evidence it never converged.
 * - **Counts do not double.** Aliases overlap (「某某口服液」 contains 「某某」);
 *   occurrences are counted without overlap, the longer alias winning at the
 *   same start — the owner's `_count_and_first`, so a share of voice is not
 *   inflated by the alias list.
 * - **Position is rank, not offset**: 1 for the first registered brand the
 *   answer names, 2 for the second. `firstOurs` is rank 1.
 * - **"In a recommendation"** is a list item (a format — numbered or bulleted
 *   line) or a sentence the judge marked as recommending a product. Which
 *   sentences recommend is language, so it is the judge's; code only checks
 *   the sentence is in the answer and the brand is in the sentence.
 * - **A citation is in the body** only where the engine renders inline markers
 *   (`GEO_METRICS.engines[e].citation_display === 'inline_marker'`): the
 *   probe's own `in_body` when it sends one, else whether the n-th source's
 *   marker (`[n]`, `【n】`, …) appears in the answer. An engine that lists its
 *   sources outside the answer gets `null` — not measurable, never guessed.
 * - **Ours** is `isOurCitation` from the domain, over the project's owned-layer
 *   domains and its published article URLs — the same function the metrics
 *   use, so a page and a number never disagree about what is ours.
 * - Page chrome at the tail (「相关视频」…) is cut before counting
 *   (`geoSanity.stripPageChrome`): a brand in a video title is not a mention.
 *
 * @module geoParse
 */

import { GEO_METRICS, isOurCitation } from "@evimed/domain";
import { stripPageChrome } from "./geoSanity.mjs";

/** Written into `facts.parser_version`; bump when what is counted changes. */
export const GEO_PARSER_VERSION = "geo-parse-1";

/** The most citations kept per snapshot. */
export const GEO_CITATIONS_MAX = 50;

/** Case and width folding for matching: NFKC, then lower case. @param {unknown} value */
export function foldText(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase();
}

/**
 * A text reduced for "is this sentence in that text": folded, with whitespace
 * and Markdown emphasis removed, so a sentence copied out of a rendered answer
 * still matches its source.
 * @param {unknown} value
 */
export function compactText(value) {
  return foldText(value).replace(/[\s*_`#>]+/gu, "");
}

/** @param {unknown} value @returns {string[]} */
function strings(value) {
  if (Array.isArray(value)) return value.map((item) => String(item ?? "").trim()).filter(Boolean);
  const text = String(value ?? "").trim();
  return text ? [text] : [];
}

/** @param {string[]} values */
function uniqueFolded(values) {
  const seen = new Set();
  /** @type {string[]} */
  const out = [];
  for (const value of values) {
    const folded = foldText(value).trim();
    // One character matches inside too many words to be a name.
    if (folded.length < 2 || seen.has(folded)) continue;
    seen.add(folded);
    out.push(folded);
  }
  return out;
}

/**
 * @typedef {{ name: string, ours: boolean, competitor: boolean, aliases: string[] }} GeoRegisteredBrand
 */

/**
 * The registered names: ours first, then each competitor.
 * @param {Record<string, any> | null | undefined} product  `projects.product`
 * @param {Array<Record<string, any>> | null | undefined} competitors  `projects.competitors`
 * @returns {GeoRegisteredBrand[]}
 */
export function brandRegistry(product, competitors) {
  /** @type {GeoRegisteredBrand[]} */
  const registry = [];
  const ourName = String(product?.brandName ?? "").trim();
  const ourAliases = uniqueFolded([...strings(product?.brandName), ...strings(product?.aliases), ...strings(product?.misspellings)]);
  if (ourAliases.length) registry.push({ name: ourName || ourAliases[0], ours: true, competitor: false, aliases: ourAliases });
  const ours = new Set(ourAliases);
  for (const competitor of Array.isArray(competitors) ? competitors : []) {
    const brand = String(competitor?.brandName ?? "").trim();
    const name = brand || String(competitor?.genericName ?? "").trim();
    if (!name) continue;
    const aliases = uniqueFolded([name, ...strings(competitor?.aliases)]).filter((alias) => !ours.has(alias));
    if (!aliases.length || registry.some((entry) => entry.name === name)) continue;
    registry.push({ name, ours: false, competitor: true, aliases });
  }
  return registry;
}

/**
 * Non-overlapping occurrences of any alias in a folded text, the longer alias
 * winning at the same start, and where the first one starts.
 * @param {string} folded @param {string[]} aliases  folded aliases
 * @returns {{ count: number, first: number | null }}
 */
export function countMentions(folded, aliases) {
  /** @type {Array<[number, number]>} */
  const spans = [];
  for (const alias of aliases) {
    if (!alias) continue;
    let start = 0;
    for (;;) {
      const index = folded.indexOf(alias, start);
      if (index < 0) break;
      spans.push([index, index + alias.length]);
      start = index + alias.length;
    }
  }
  if (!spans.length) return { count: 0, first: null };
  spans.sort((left, right) => left[0] - right[0] || (right[1] - right[0]) - (left[1] - left[0]));
  let count = 0;
  let lastEnd = -1;
  for (const [begin, end] of spans) {
    if (begin < lastEnd) continue;
    count += 1;
    lastEnd = end;
  }
  return { count, first: spans[0][0] };
}

// A list item is a format: a numbered or bulleted line. Closed set of markers.
const LIST_ITEM = /^\s*(?:\d{1,2}\s*[.、)）]|[（(]\s*\d{1,2}\s*[)）]|[-*•·+]\s|[一二三四五六七八九十]{1,3}\s*、)/u;

/** The lines of a text that are list items, folded. @param {string} body */
export function listItemLines(body) {
  return body.split(/\r?\n/u).filter((line) => LIST_ITEM.test(line)).map(foldText);
}

/** @param {unknown} url */
function hostOf(url) {
  const match = /https?:\/\/([^/\s]+)/u.exec(String(url ?? ""));
  return match ? match[1].toLowerCase() : "";
}

const INLINE_MARKERS = Object.freeze([
  (/** @type {number} */ n) => `[${n}]`, (/** @type {number} */ n) => `[^${n}]`, (/** @type {number} */ n) => `【${n}】`,
  (/** @type {number} */ n) => `[citation:${n}]`, (/** @type {number} */ n) => `^${n}^`, (/** @type {number} */ n) => `［${n}］`,
]);

/** How an engine shows its sources: `inline_marker`, `outside_list` or `unknown`. @param {string} engine */
export function citationDisplay(engine) {
  return /** @type {Record<string, { citation_display: string }>} */ (GEO_METRICS.engines)[engine]?.citation_display ?? "unknown";
}

/**
 * @typedef {{ url: string, domain: string, title: string, inBody: boolean | null }} GeoCitationRow
 */

/**
 * The snapshot's citations from the probe's own `search_results`.
 * @param {unknown} searchResults  the upstream row's `search_results`
 * @param {string} answer @param {string} engine
 * @returns {GeoCitationRow[]}
 */
export function citationRows(searchResults, answer, engine) {
  const inline = citationDisplay(engine) === "inline_marker";
  const text = String(answer ?? "");
  const rows = Array.isArray(searchResults) ? searchResults.slice(0, GEO_CITATIONS_MAX) : [];
  return rows.map((entry, index) => {
    const item = entry && typeof entry === "object" ? /** @type {Record<string, any>} */ (entry) : { url: String(entry ?? "") };
    const url = String(item.url ?? item.link ?? "").slice(0, 2_000);
    /** @type {boolean | null} */
    let inBody = null;
    if (inline) {
      const reported = item.in_body ?? item.inBody;
      inBody = typeof reported === "boolean" ? reported : INLINE_MARKERS.some((marker) => text.includes(marker(index + 1)));
    }
    return { url, domain: hostOf(url), title: String(item.title ?? "").slice(0, 300), inBody };
  });
}

/**
 * @typedef {{ name: string, ours: boolean, competitor: boolean, position: number | null, inRecommendation: boolean, count: number }} GeoBrandFact
 * @typedef {object} GeoCodeFacts
 * @property {GeoBrandFact[]} brands
 * @property {boolean} mentionsOurs
 * @property {boolean} firstOurs
 * @property {boolean} recommendedOurs
 * @property {number | null} positionOurs
 * @property {number} brandsMentioned
 * @property {boolean} retrievalTriggered
 * @property {boolean} citesOurs
 * @property {boolean} citesOursInBody
 * @property {number} chromeStripped
 */

/**
 * Count what an answer says about the registered brands and what it cites.
 * `recommendations` and `entities` come from the judge, already checked to be
 * in the answer; they may be empty.
 * @param {{ answer: unknown, citations?: GeoCitationRow[] | null, registry: GeoRegisteredBrand[],
 *   owned?: { domains?: string[], urls?: string[] }, recommendations?: string[], entities?: string[] }} input
 * @returns {GeoCodeFacts}
 */
export function parseAnswer({ answer, citations = [], registry, owned = {}, recommendations = [], entities = [] }) {
  const { body, stripped } = stripPageChrome(answer);
  const folded = foldText(body);
  const listLines = listItemLines(body);
  const recommending = recommendations.map(foldText);
  const inRecommendation = (/** @type {string[]} */ aliases) => [...listLines, ...recommending]
    .some((line) => aliases.some((alias) => line.includes(alias)));

  const found = registry
    .map((brand) => ({ brand, ...countMentions(folded, brand.aliases) }))
    .filter((entry) => entry.count > 0)
    .sort((left, right) => /** @type {number} */ (left.first) - /** @type {number} */ (right.first));
  /** @type {GeoBrandFact[]} */
  const brands = found.map((entry, index) => ({
    name: entry.brand.name,
    ours: entry.brand.ours,
    competitor: entry.brand.competitor,
    position: index + 1,
    inRecommendation: inRecommendation(entry.brand.aliases),
    count: entry.count,
  }));

  // Unregistered drug products the judge named: kept only when the name is in
  // the answer and is not a registered one (or contains one), and counted here.
  const registered = registry.flatMap((brand) => brand.aliases);
  const seen = new Set(brands.map((brand) => foldText(brand.name)));
  for (const entity of entities) {
    const name = String(entity ?? "").trim();
    const key = foldText(name);
    if (key.length < 2 || seen.has(key)) continue;
    if (registered.some((alias) => key === alias || key.includes(alias) || alias.includes(key))) continue;
    const { count } = countMentions(folded, [key]);
    if (!count) continue;
    seen.add(key);
    brands.push({ name, ours: false, competitor: false, position: null, inRecommendation: false, count });
  }

  const ours = brands.find((brand) => brand.ours) ?? null;
  const rows = Array.isArray(citations) ? citations : [];
  const ourCitations = rows.filter((citation) => isOurCitation(citation, owned));
  return {
    brands,
    mentionsOurs: Boolean(ours),
    firstOurs: ours?.position === 1,
    recommendedOurs: Boolean(ours?.inRecommendation),
    positionOurs: ours?.position ?? null,
    brandsMentioned: brands.filter((brand) => brand.ours || brand.competitor).length,
    retrievalTriggered: rows.length > 0,
    citesOurs: ourCitations.length > 0,
    citesOursInBody: ourCitations.some((citation) => citation.inBody === true),
    chromeStripped: stripped,
  };
}

/**
 * The failure mode of one answer (plan §4.3): 讲错我方 when a statement about
 * us was judged wrong, 漏提我方 when we are not named, 讲对我方 otherwise; a
 * refusal is `none`. 讲错竞品 is never assigned here: there is no claim base
 * for competitors to judge against, and the owner's method logs it only.
 * @param {{ status: string, mentionsOurs: boolean, statements: Array<{ verdict?: string | null }> }} input
 * @returns {"omitted" | "correct" | "wrong_ours" | "none"}
 */
export function failureMode({ status, mentionsOurs, statements }) {
  if (statements.some((statement) => statement.verdict === "wrong")) return "wrong_ours";
  if (status === "refusal") return "none";
  return mentionsOurs ? "correct" : "omitted";
}
