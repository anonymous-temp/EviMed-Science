/** Parameter-specific human provenance. Language interpretation belongs to the
 * model's explicit source binding; numeric coincidence is never evidence.
 * The control plane checks original-message scope and freezes the binding with
 * the computation. Schema 1 remains readable for historical results only. */
import { createHash } from 'node:crypto';
import { numberIsInQuote } from './vcrEvidence.mjs';

export const VCR_PERSON_STATED_SCHEMA = 2;
const MAX_PATHS = 200;

/** @param {unknown} value @param {string} [path]
 * @returns {Array<{ path: string, value: number }>} */
export function vcrNumericLeaves(value, path = '') {
  if (typeof value === 'number') return Number.isFinite(value) ? [{ path, value }] : [];
  if (Array.isArray(value)) return value.flatMap((entry, index) => vcrNumericLeaves(entry, `${path}[${index}]`));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, entry]) => vcrNumericLeaves(entry, path ? `${path}.${key}` : key));
  return [];
}

/** @typedef {{sessionId:string, messageSeq:number, text:string}} HumanParameterMessage */
/** Explicit semantic assertions from the calculating agent. Quote membership
 * authenticates the original, not the interpretation: retain unit and context
 * (including endpoint, arm, time or table column) for later scientific review.
 * No binding, ambiguity, a changed value or an unavailable original means assumed.
 * Only the latest human message is eligible: old instructions cannot silently
 * overrule a follow-up. Earlier evidence can be restated or explicitly sourced
 * through the evidence workflow without blocking the calculation.
 * @param {Record<string, any>} scenario
 * @param {readonly (HumanParameterMessage|string)[] | null | undefined} messages
 * @param {unknown} [sources]
 */
export function vcrPersonStated(scenario, messages, sources = []) {
  const originals = (Array.isArray(messages) ? messages : []).filter(entry => entry && typeof entry === 'object'
    && typeof entry.sessionId === 'string' && Number.isSafeInteger(entry.messageSeq) && typeof entry.text === 'string' && entry.text.trim());
  const latest = originals.at(-1);
  const leaves = new Map(vcrNumericLeaves(scenario).slice(0, MAX_PATHS).map(row => [row.path, row.value]));
  const entries = (Array.isArray(sources) ? sources : []).slice(0, MAX_PATHS).filter(row => row?.origin === 'user');
  /** @type {Array<Record<string, any>>} */
  const bindings = [];
  const paths = entries.map(row => row.field);
  for (const row of entries) {
    if (!latest || typeof row.field !== 'string' || paths.filter(path => path === row.field).length !== 1
      || !leaves.has(row.field) || leaves.get(row.field) !== row.value
      || typeof row.quote !== 'string' || !row.quote.trim() || row.quote.length > 16000 || !latest.text.includes(row.quote)
      || typeof row.unit !== 'string' || !row.unit.trim() || row.unit.length > 120
      || typeof row.context !== 'string' || !row.context.trim() || row.context.length > 1000
      || !humanQuoteNumber(row.quote, row.value)
      || row.sessionId != null && row.sessionId !== latest.sessionId
      || row.messageSeq != null && row.messageSeq !== latest.messageSeq) continue;
    bindings.push({ path: row.field, value: row.value, origin: 'user', unit: row.unit, context: row.context, quote: row.quote,
      source: { sessionId: latest.sessionId, messageSeq: latest.messageSeq,
        sha256: createHash('sha256').update(latest.text).digest('hex') }, verification: 'source_checked_interpretation_asserted' });
  }
  // A number the model gave no binding for is still the person's when the same number is written in one of their authenticated messages
  // (live D4: the model sent no sources, so the person's own alpha, hazard ratio and median read as assumptions). Numeric notation only:
  // the digest is every distinct number token of the messages, and a fraction also reads as the percentage written for it.
  const bound = new Set(bindings.map(row => row.path));
  const digest = originals.length ? numberDigest(originals.map(entry => entry.text)) : '';
  const matched = digest ? [...leaves].filter(([path, value]) => !bound.has(path) && humanQuoteNumber(digest, value)).map(([path]) => path) : [];
  return { schema: VCR_PERSON_STATED_SCHEMA, readable: Boolean(latest), paths: bindings.map(row => row.path), bindings, ...(matched.length ? { matched } : {}) };
}

/** Every distinct number token of the texts, a percentage with its sign and a 「百分之」 with its words, so a match is
 * made against a few hundred characters however long the person's messages are.
 * @param {readonly string[]} texts */
function numberDigest(texts) {
  const found = new Set();
  for (const text of texts) {
    for (const match of text.replace(/\[\d+\]/g, '').replace(/(?<=\d)[·⋅∙](?=\d)/g, '.').matchAll(DIGEST_TOKEN)) found.add(match[0]);
  }
  return [...found].join(' ');
}
const DIGEST_TOKEN = /百分之\s*-?\d+(?:\.\d+)?|(?<![\w.])[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?(?:\s*(?:%|％|percent\b))?|(?<![\w.,])[+-]?\d+(?:\.\d+)?(?!\d|\.\d)(?:\s*(?:%|％|percent\b))?/giu;

/** Numeric notation only; never infer a parameter's meaning from words. A bare
 * count cannot become a fraction merely because the caller labels it one.
 * @param {string} quote @param {number} value */
function humanQuoteNumber(quote, value) {
  if (numberIsInQuote(quote, value)) return true;
  if (!(value > 0 && value < 1)) return false;
  const tokens = [...quote.matchAll(/(-?\d+(?:\.\d+)?)\s*(?:%|％|percent\b)/giu),
    ...quote.matchAll(/百分之\s*(-?\d+(?:\.\d+)?)/gu)];
  return tokens.some(token => Number(token[1]) / 100 === value);
}

/** Non-blocking, inspectable model mappings: the original is authenticated,
 * the asserted meaning has not been independently verified.
 * @param {Record<string,any> | null | undefined} record
 * @returns {Array<{key:string,label:string,value:string,source:'assumed',decisive:boolean,reason:string}>} */
export function personMappingPremises(record) {
  if (record?.schema !== 2 || !Array.isArray(record.bindings)) return [];
  return record.bindings.filter(row => row.verification === 'source_checked_interpretation_asserted').map(row => ({
    key: `person-mapping:${row.path}`, label: '原文参数对应', value: String(row.context), source: 'assumed', decisive: false,
    reason: `原文来源已核对，参数含义由模型对应。原文：「${row.quote}」；单位：${row.unit}；对应值：${row.value}`,
  }));
}

/** @param {Record<string, any> | null | undefined} record
 * @param {string | readonly string[]} paths
 * @param {'given' | 'assumed'} legacy
 * @returns {'given' | 'assumed'} */
export function personWord(record, paths, legacy) {
  if (!record || typeof record !== 'object' || ![1, VCR_PERSON_STATED_SCHEMA].includes(record.schema)) return legacy;
  if (record.readable !== true || !Array.isArray(record.paths)) return 'assumed';
  const wanted = Array.isArray(paths) ? paths : [paths];
  // Schema 2: a model-bound meaning stays an assumption (the model's reading of the unit and context); a number the person wrote in their own
  // message and the model bound nothing for is theirs (`matched`, exact numeric notation).
  if (record.schema === 2) return wanted.length > 0 && Array.isArray(record.matched) && wanted.every(path => record.matched.includes(path)) ? 'given' : 'assumed';
  return wanted.length > 0 && wanted.every(path => record.paths.includes(path)) ? 'given' : 'assumed';
}
