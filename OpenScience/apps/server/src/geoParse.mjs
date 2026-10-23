/**
 * What a measured answer contains that code can count (build spec §5 "Parse +
 * judge", plan §4.3): which registered brands it names, how often, in what
 * order, whether in a list or a recommendation, and which sources it cites.
 *
 * Hidden knowledge:
 *
 * - **Only registered names are counted here, by one rule for every
 *   product** (`countedNames`): the brand, its other names and known
 *   misspellings, and literal brand aliases; generic forms and optional single-source attribution
 *   are kept separately in `genericMentions`, matched after case and width folding
 *   (NFKC + lower case, so 「ＡＢＣ」 and 「abc」 are one name).
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
 * - **"In a recommendation"** requires the judge to name both a span and the
 *   entities it recommends. Code checks the span against the answer and each
 *   entity against that span. Formatting never supplies a semantic verdict.
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

import { createHash } from "node:crypto";
import { GEO_METRICS, geoAnswerAccuracy, geoCitationHost, isOurCitation } from "@evimed/domain";
import { stripPageChrome } from "./geoSanity.mjs";

/** Written into `facts.parser_version`; bump when what is counted changes. */
export const GEO_PARSER_VERSION = "geo-parse-2";

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
 * @typedef {{ name: string, ours: boolean, competitor: boolean, aliases: string[], genericAliases?: string[], singleSource?: boolean }} GeoRegisteredBrand
 * @typedef {{ text: string, entities: string[] }} GeoRecommendation
 * @typedef {{ name: string, ours: boolean, competitor: boolean, count: number, matchedNames: string[], productAttributed: boolean }} GeoGenericMention
 */

/**
 * The names of one product's generic — its registered `genericName` and the
 * other forms written for it (`genericAliases`: the molecule's short name, the
 * INN in English, a code name) — folded. Any registered alias that is a part
 * of the generic name (「替尔泊肽」 of 「替尔泊肽注射液」) is a form of it too:
 * a check against the product's own registered field, not a guess at what
 * a drug name looks like.
 * @param {Record<string, any> | null | undefined} entry
 */
function genericForms(entry) {
  const generic = uniqueFolded([...strings(entry?.genericName), ...strings(entry?.genericAliases)]);
  const full = generic[0] ?? "";
  const aliasForms = uniqueFolded(strings(entry?.aliases)).filter((alias) => full && (full.includes(alias) || alias.includes(full)));
  return uniqueFolded([...generic, ...aliasForms]);
}

/**
 * Literal brand names only. A generic stays a separate observation even when
 * one holder markets it; attribution is not a literal brand mention.
 * @param {Record<string, any> | null | undefined} entry
 */
export function countedNames(entry) {
  const brand = uniqueFolded(strings(entry?.brandName));
  const generic = genericForms(entry);
  return uniqueFolded([...brand, ...strings(entry?.aliases), ...strings(entry?.misspellings)])
    .filter((name) => brand.includes(name) || !generic.includes(name));
}

/**
 * The registered identities, with literal brand and generic aliases separate.
 * @param {Record<string, any> | null | undefined} product
 * @param {Array<Record<string, any>> | null | undefined} competitors
 * @returns {GeoRegisteredBrand[]}
 */
export function brandRegistry(product, competitors) {
  /** @type {GeoRegisteredBrand[]} */
  const registry = [];
  const entries = [product, ...(Array.isArray(competitors) ? competitors : [])];
  for (const [index, entry] of entries.entries()) {
    if (!entry) continue;
    const aliases = countedNames(entry).filter((alias) => !registry.some((item) => item.aliases.includes(alias)));
    const genericAliases = genericForms(entry);
    const name = String(entry.brandName || entry.genericName || aliases[0] || "").trim();
    if (!name || (!aliases.length && !genericAliases.length) || registry.some((item) => item.name === name)) continue;
    registry.push({ name, ours: index === 0, competitor: index !== 0, aliases, genericAliases, singleSource: entry.singleSource === true });
  }
  return registry;
}

/**
 * What the registry, the owned sources and the parser make of an answer, as
 * one short key: a facts row counted under another key was counted by other
 * names or other owned domains, and is counted again (`reparseRegistryFacts`).
 * @param {GeoRegisteredBrand[]} registry @param {{ domains?: string[], urls?: string[] }} owned
 */
export function registryKey(registry, owned) {
  const canonical = {
    parser: GEO_PARSER_VERSION,
    brands: registry.map((entry) => [entry.ours ? 1 : 0, entry.name, [...entry.aliases].sort(), [...(entry.genericAliases ?? [])].sort(), entry.singleSource === true]),
    domains: [...new Set((owned?.domains ?? []).map((domain) => String(domain).toLowerCase()))].sort(),
    urls: [...new Set((owned?.urls ?? []).map(String))].sort(),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 24);
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
const LIST_ITEM = /^\s*(?:\d{1,2}\s*(?:[.](?!\d)|[、)）])|[（(]\s*\d{1,2}\s*[)）]|[-*•·+]\s|[一二三四五六七八九十]{1,3}\s*、)/u;

/** The lines of a text that are list items, folded. @param {string} body */
export function listItemLines(body) {
  return body.split(/\r?\n/u).filter((line) => LIST_ITEM.test(line)).map(foldText);
}

/** Remove closed list markers before reading quantities, preserving decimal doses. @param {string} body */
export function stripListItemMarkers(body) {
  return body.split(/\r?\n/u).map((line) => line.replace(LIST_ITEM, "")).join("\n");
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
    return { url, domain: geoCitationHost(url), title: String(item.title ?? "").slice(0, 300), inBody };
  });
}

/**
 * @typedef {{ name: string, ours: boolean, competitor: boolean, position: number | null, inRecommendation: boolean, count: number }} GeoBrandFact
 * @typedef {object} GeoCodeFacts
 * @property {GeoBrandFact[]} brands
 * @property {GeoGenericMention[]} genericMentions
 * @property {number} entityMentions
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
 *   owned?: { domains?: string[], urls?: string[] }, recommendations?: Array<GeoRecommendation | string>, entities?: string[] }} input
 * @returns {GeoCodeFacts}
 */
export function parseAnswer({ answer, citations = [], registry, owned = {}, recommendations = [], entities = [] }) {
  const { body, stripped } = stripPageChrome(answer);
  const folded = foldText(body);
  // Old string-only extractions cannot distinguish recommended and negated
  // products co-mentioned in a sentence. Preserve them in history, not counts.
  const compact = compactText(body);
  const recommending = recommendations.filter((entry) => entry && typeof entry === "object"
    && compactText(entry.text).length > 0 && compact.includes(compactText(entry.text)));
  const inRecommendation = (/** @type {string[]} */ aliases) => recommending.some((entry) => {
    if (typeof entry === "string" || !Array.isArray(entry.entities)) return false;
    const span = compactText(entry.text);
    return entry.entities.some((entity) => span.includes(compactText(entity)) && aliases.includes(foldText(entity)));
  });

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
  const genericMentions = registry.map((brand) => ({ brand, ...countMentions(folded, brand.genericAliases ?? []) }))
    .filter((entry) => entry.count > 0).map(({ brand, count }) => ({
      name: brand.name, ours: brand.ours, competitor: brand.competitor, count,
      matchedNames: (brand.genericAliases ?? []).filter((name) => folded.includes(name)),
      productAttributed: brand.singleSource === true,
    }));
  const registered = registry.flatMap((brand) => [...brand.aliases, ...(brand.genericAliases ?? [])]);
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
    genericMentions,
    entityMentions: countMentions(folded, [...registered, ...brands.filter((brand) => !brand.ours && !brand.competitor).map((brand) => foldText(brand.name))]).count,
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
 * Wrong statements remain wrong even when other portions were not assessed.
 * A mention with incomplete or unavailable judgement is never called correct.
 * @param {{ status: string, mentionsOurs: boolean, statements: Array<{ verdict?: string | null }>,
 *   checks?: Record<string, any>, judgedAt?: string | null }} input
 * @returns {"omitted" | "correct" | "wrong_ours" | "none" | "partial" | "unknown"}
 */
export function failureMode({ status, mentionsOurs, statements, checks, judgedAt }) {
  const accuracy = geoAnswerAccuracy({ statements, checks, ...(judgedAt !== undefined ? { judgedAt } : {}) });
  if (accuracy === "wrong") return "wrong_ours";
  if (status === "refusal") return "none";
  return mentionsOurs ? accuracy : "omitted";
}
