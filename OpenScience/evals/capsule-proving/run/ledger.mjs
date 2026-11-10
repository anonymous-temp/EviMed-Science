/**
 * Append-only results ledger for the capsule-proving harness.
 *
 * A number counts only when it has a ledger row. This module owns the row
 * shape, its validation, the Wilson interval used for proportions, the
 * deterministic row id (so a rerun is idempotent) and the translation from a
 * scorer summary into one row per set and metric.
 *
 * Plain Node 22 ESM, no dependencies.
 *
 * @module capsule-proving/run/ledger
 */

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Default ledger path, resolved next to this module rather than from the caller's cwd. */
export const DEFAULT_LEDGER_PATH = fileURLToPath(new URL('../results/ledger.jsonl', import.meta.url));

/**
 * Default share of extraction prompt tokens billed at the cached-input price.
 * The scorer records extraction usage but not how much of it the engine served
 * from cache, so the caller states the assumption (and the row records it).
 */
export const DEFAULT_EXTRACTION_CACHED_SHARE = 0.9;

/** A string that looks like an API key: `sk-` followed by at least 16 key characters. */
const API_KEY_PATTERN = /sk-[A-Za-z0-9_-]{16,}/;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} value @returns {boolean} */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/** @param {unknown} value @returns {boolean} */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** @param {unknown} value @returns {boolean} */
function isNonNegativeNumber(value) {
  return isFiniteNumber(value) && value >= 0;
}

/** @param {unknown} value @returns {boolean} */
function isNonNegativeInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Collect every API-key-shaped string in a value, including nested objects,
 * arrays and object keys. The walk is deliberately independent of the row
 * schema: no field is exempt.
 *
 * @param {unknown} value
 * @param {string} path
 * @param {string[]} problems
 */
function findApiKeys(value, path, problems) {
  if (typeof value === 'string') {
    if (API_KEY_PATTERN.test(value)) problems.push(`${path} looks like an API key`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => findApiKeys(entry, `${path}[${index}]`, problems));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (API_KEY_PATTERN.test(key)) problems.push(`${path}.${key} (key) looks like an API key`);
      findApiKeys(entry, `${path}.${key}`, problems);
    }
  }
}

/**
 * Sort object keys recursively so the same row always produces the same bytes.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function canonicalValue(value) {
  if (Array.isArray(value)) return value.map((entry) => canonicalValue(entry));
  if (isPlainObject(value)) {
    /** @type {Record<string, unknown>} */
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue;
      sorted[key] = canonicalValue(value[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Canonical JSON: recursively sorted keys, no insignificant whitespace.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

/**
 * The ledger id of a row: first 12 hex characters of sha256 over the canonical
 * JSON of the row without `ledgerId` and `at`.
 *
 * @param {Record<string, unknown>} row
 * @returns {string}
 */
export function ledgerIdForRow(row) {
  if (!isPlainObject(row)) throw new TypeError('ledgerIdForRow expects a row object');
  const { ledgerId: _ledgerId, at: _at, ...rest } = row;
  return createHash('sha256').update(canonicalJson(rest)).digest('hex').slice(0, 12);
}

/**
 * Validate a ledger row against the shared contract.
 *
 * `ledgerId` and `at` are assigned by {@link appendLedgerRows}, so a caller may
 * omit them; when present they must have the contract's types. Everything else
 * in the contract row is required.
 *
 * @param {unknown} row
 * @returns {string[]} human-readable problems; empty means valid
 */
export function validateLedgerRow(row) {
  if (!isPlainObject(row)) return ['row must be an object'];

  /** @type {string[]} */
  const problems = [];

  for (const field of ['runId', 'commit', 'arm', 'set', 'split', 'metric', 'scorer', 'rawPath']) {
    if (!isNonEmptyString(row[field])) problems.push(`${field} must be a non-empty string`);
  }

  if ('ledgerId' in row && row.ledgerId !== undefined) {
    if (typeof row.ledgerId !== 'string' || !/^[0-9a-f]{12}$/.test(row.ledgerId)) {
      problems.push('ledgerId must be 12 lowercase hexadecimal characters');
    }
  }

  if ('at' in row && row.at !== undefined) {
    if (!isNonEmptyString(row.at) || Number.isNaN(Date.parse(String(row.at)))) {
      problems.push('at must be an ISO date-time string');
    }
  }

  if (!isPlainObject(row.engine)) {
    problems.push('engine must be an object');
  } else {
    if (!isNonEmptyString(row.engine.version)) problems.push('engine.version must be a non-empty string');
    if (!isNonEmptyString(row.engine.templatesDigest)) {
      problems.push('engine.templatesDigest must be a non-empty string');
    }
  }

  if (!isPlainObject(row.flags)) problems.push('flags must be an object');
  if (!isNonNegativeInteger(row.n)) problems.push('n must be a non-negative integer');
  if (!isFiniteNumber(row.value)) problems.push('value must be a finite number');

  if (row.ci95 !== null) {
    if (!Array.isArray(row.ci95) || row.ci95.length !== 2 || !row.ci95.every(isFiniteNumber)) {
      problems.push('ci95 must be null or an array of two finite numbers');
    }
  }

  if (!isPlainObject(row.judged)) {
    problems.push('judged must be an object');
  } else {
    for (const field of ['code', 'judge', 'unknown', 'error']) {
      if (!isNonNegativeInteger(row.judged[field])) problems.push(`judged.${field} must be a non-negative integer`);
    }
  }

  if (!isPlainObject(row.tokens)) {
    problems.push('tokens must be an object');
  } else {
    for (const field of ['prompt', 'completion', 'cached', 'extractionPrompt', 'extractionCompletion']) {
      if (!isNonNegativeNumber(row.tokens[field])) problems.push(`tokens.${field} must be a non-negative number`);
    }
  }

  if (row.costCny !== null && !isNonNegativeNumber(row.costCny)) {
    problems.push('costCny must be null or a non-negative finite number');
  }
  if (!isNonNegativeNumber(row.wallSeconds)) problems.push('wallSeconds must be a non-negative finite number');

  if (row.valueValid !== undefined && row.valueValid !== null && !isFiniteNumber(row.valueValid)) {
    problems.push('valueValid must be null or a finite number when present');
  }
  if (row.ci95Valid !== undefined && row.ci95Valid !== null) {
    if (!Array.isArray(row.ci95Valid) || row.ci95Valid.length !== 2 || !row.ci95Valid.every(isFiniteNumber)) {
      problems.push('ci95Valid must be null or an array of two finite numbers when present');
    }
  }
  for (const field of ['nValid', 'invalid', 'disputed']) {
    if (row[field] !== undefined && !isNonNegativeInteger(row[field])) {
      problems.push(`${field} must be a non-negative integer when present`);
    }
  }
  if (row.byStep !== undefined) {
    if (!isPlainObject(row.byStep)) {
      problems.push('byStep must be an object when present');
    } else {
      for (const [name, count] of Object.entries(row.byStep)) {
        if (!isNonNegativeInteger(count)) problems.push(`byStep.${name} must be a non-negative integer`);
      }
    }
  }
  if (row.label !== undefined && !isNonEmptyString(row.label)) problems.push('label must be a non-empty string when present');

  for (const field of ['byGenerator', 'byCategory']) {
    const breakdown = row[field];
    if (breakdown === undefined) continue;
    if (!isPlainObject(breakdown)) {
      problems.push(`${field} must be an object when present`);
      continue;
    }
    for (const [name, entry] of Object.entries(breakdown)) {
      if (!isPlainObject(entry)) {
        problems.push(`${field}.${name} must be an object`);
        continue;
      }
      if (!isNonNegativeInteger(entry.n)) problems.push(`${field}.${name}.n must be a non-negative integer`);
      if (!isFiniteNumber(entry.value)) problems.push(`${field}.${name}.value must be a finite number`);
    }
  }

  if (row.notes !== undefined && typeof row.notes !== 'string') problems.push('notes must be a string when present');

  findApiKeys(row, 'row', problems);

  return problems;
}

/**
 * Wilson score interval for a binomial proportion.
 *
 * @param {number} pass number of successes
 * @param {number} n number of trials
 * @param {number} [z=1.96] normal quantile (1.96 ≈ 95% confidence)
 * @returns {[number, number] | null} `[lo, hi]`, or null when `n === 0`
 */
export function wilson(pass, n, z = 1.96) {
  if (!Number.isInteger(n) || n < 0) throw new RangeError('n must be a non-negative integer');
  if (n === 0) return null;
  if (!Number.isInteger(pass) || pass < 0 || pass > n) throw new RangeError('pass must be an integer between 0 and n');
  if (!isFiniteNumber(z) || z <= 0) throw new RangeError('z must be a positive finite number');

  const p = pass / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
  return [Math.max(0, centre - margin), Math.min(1, centre + margin)];
}

/**
 * Wilson interval for summary values that may be inconsistent; never throws.
 *
 * @param {number} pass
 * @param {number} n
 * @returns {[number, number] | null}
 */
function safeWilson(pass, n) {
  if (!isNonNegativeInteger(n) || n === 0) return null;
  if (!isNonNegativeInteger(pass) || pass > n) return null;
  return wilson(pass, n);
}

/**
 * Read a `[lo, hi]` interval from a summary value, or null.
 *
 * @param {unknown} value
 * @returns {[number, number] | null}
 */
function interval(value) {
  return Array.isArray(value) && value.length === 2 && value.every(isFiniteNumber)
    ? /** @type {[number, number]} */ ([value[0], value[1]])
    : null;
}

/**
 * Read the ledger ids already on disk. A malformed line is an error: silently
 * ignoring it would make idempotency and the append-only guarantee unreliable.
 *
 * @param {string} file
 * @returns {Set<string>}
 */
function existingLedgerIds(file) {
  if (!existsSync(file)) return new Set();
  const text = readFileSync(file, 'utf8');
  const ids = new Set();
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (line.trim() === '') return;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`ledger ${file} line ${index + 1} is not JSON: ${error.message}`);
    }
    if (isPlainObject(parsed) && typeof parsed.ledgerId === 'string') ids.add(parsed.ledgerId);
  });
  return ids;
}

/**
 * Validate rows, assign `at`/`ledgerId`, skip rows already present and append
 * one JSON object per line. Nothing is written unless every new row is valid.
 *
 * @param {string} file ledger path
 * @param {Array<Record<string, unknown>>} rows
 * @returns {{ appended: number, skipped: number }}
 */
export function appendLedgerRows(file, rows) {
  if (!isNonEmptyString(file)) throw new TypeError('file must be a non-empty path');
  if (!Array.isArray(rows)) throw new TypeError('rows must be an array');

  const target = resolve(file);
  const seen = existingLedgerIds(target);
  const lines = [];
  let appended = 0;
  let skipped = 0;

  rows.forEach((row, index) => {
    if (!isPlainObject(row)) throw new TypeError(`ledger row ${index} must be an object`);

    const at = Object.hasOwn(row, 'at') && row.at !== undefined ? row.at : new Date().toISOString();
    const ledgerId = ledgerIdForRow(row);
    const candidate = { ...row, at, ledgerId };
    const problems = validateLedgerRow(candidate);
    if (problems.length > 0) throw new Error(`ledger row ${index} is invalid: ${problems.join('; ')}`);

    if (seen.has(ledgerId)) {
      skipped += 1;
      return;
    }
    seen.add(ledgerId);
    lines.push(`${JSON.stringify(candidate)}\n`);
    appended += 1;
  });

  if (lines.length > 0) {
    mkdirSync(dirname(target), { recursive: true });
    let prefix = '';
    if (existsSync(target)) {
      const current = readFileSync(target, 'utf8');
      if (current.length > 0 && !current.endsWith('\n')) prefix = '\n';
    }
    appendFileSync(target, prefix + lines.join(''), 'utf8');
  }

  return { appended, skipped };
}

/** @param {unknown} value @returns {number} */
function toCount(value) {
  return isNonNegativeInteger(value) ? value : 0;
}

/** @param {unknown} value @param {number} fallback @returns {number} */
function toNonNegativeNumber(value, fallback) {
  return isNonNegativeNumber(value) ? value : fallback;
}

/**
 * Normalise a `byCategory`/`byGenerator` map into `{ name: { n, value } }`.
 *
 * @param {unknown} map
 * @returns {Record<string, { n: number, value: number }> | undefined}
 */
function breakdown(map) {
  if (!isPlainObject(map)) return undefined;
  /** @type {Record<string, { n: number, value: number }>} */
  const out = {};
  for (const [name, entry] of Object.entries(map)) {
    if (!isPlainObject(entry)) continue;
    const n = toCount(entry.n);
    const value = isFiniteNumber(entry.value)
      ? entry.value
      : isFiniteNumber(entry.accuracy)
        ? entry.accuracy
        : n === 0
          ? 0
          : toCount(entry.pass) / n;
    out[name] = { n, value };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Normalise `byStep` counts. The scorer writes four non-negative integers
 * describing why a failed answer failed.
 *
 * @param {unknown} map
 * @returns {Record<string, number> | undefined}
 */
function stepCounts(map) {
  if (!isPlainObject(map)) return undefined;
  /** @type {Record<string, number>} */
  const out = {};
  for (const [name, count] of Object.entries(map)) {
    if (isNonNegativeInteger(count)) out[name] = count;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Normalise the judged counts; when a scorer did not write them, derive a
 * sensible code/judge split from the pass/fail/needsJudge counters.
 *
 * @param {unknown} judged
 * @param {Record<string, unknown>} set
 * @returns {{ code: number, judge: number, unknown: number, error: number }}
 */
function judgedCounts(judged, set) {
  if (isPlainObject(judged)) {
    return {
      code: toCount(judged.code),
      judge: toCount(judged.judge),
      unknown: toCount(judged.unknown),
      error: toCount(judged.error),
    };
  }
  return {
    code: toCount(set.pass) + toCount(set.fail),
    judge: toCount(set.needsJudge ?? set['needs-judge']),
    unknown: toCount(set.unknown),
    error: toCount(set.error),
  };
}

/**
 * Token totals in the ledger's five-field shape.
 *
 * The scorer writes `tokens.extraction.{prompt,completion}`,
 * `tokens.answer.{prompt,completion,cached}` and the aggregate
 * `tokens.{prompt,completion}`; an older run.json may carry only prompt and
 * completion. Every emitted row carries all five fields.
 *
 * @param {unknown} summaryTokens
 * @param {unknown} legacyTokens
 * @returns {{ prompt: number, completion: number, cached: number, extractionPrompt: number, extractionCompletion: number }}
 */
function tokenTotals(summaryTokens, legacyTokens) {
  const source = isPlainObject(summaryTokens)
    ? summaryTokens
    : isPlainObject(legacyTokens)
      ? legacyTokens
      : {};
  const extraction = isPlainObject(source.extraction) ? source.extraction : {};
  const answer = isPlainObject(source.answer) ? source.answer : {};

  // Accept both the scorer's nested shape and the ledger's flat five-field
  // shape, so an already-normalised row can be priced again.
  const extractionPrompt = toNonNegativeNumber(
    extraction.prompt,
    toNonNegativeNumber(source.extractionPrompt, 0),
  );
  const extractionCompletion = toNonNegativeNumber(
    extraction.completion,
    toNonNegativeNumber(source.extractionCompletion, 0),
  );
  const answerPrompt = toNonNegativeNumber(answer.prompt, 0);
  const answerCompletion = toNonNegativeNumber(answer.completion, 0);
  const answerCached = toNonNegativeNumber(answer.cached, 0);

  const prompt = isNonNegativeNumber(source.prompt) ? source.prompt : extractionPrompt + answerPrompt;
  const completion = isNonNegativeNumber(source.completion)
    ? source.completion
    : extractionCompletion + answerCompletion;
  const cached = isNonNegativeNumber(source.cached) ? source.cached : answerCached;

  return { prompt, completion, cached, extractionPrompt, extractionCompletion };
}

/**
 * Normalise a caller-supplied price object. Returns null when no usable price
 * is present, so a caller that names no price never gets a fabricated 0.
 *
 * @param {unknown} prices
 * @returns {{ inputPerMTok: number | null, cachedInputPerMTok: number | null, outputPerMTok: number | null } | null}
 */
function normalisePrices(prices) {
  if (!isPlainObject(prices)) return null;
  const pick = (value) => (isNonNegativeNumber(value) ? value : null);
  const out = {
    inputPerMTok: pick(prices.inputPerMTok),
    cachedInputPerMTok: pick(prices.cachedInputPerMTok),
    outputPerMTok: pick(prices.outputPerMTok),
  };
  return out.inputPerMTok === null && out.cachedInputPerMTok === null && out.outputPerMTok === null ? null : out;
}

/**
 * Estimate a run's cost in CNY from its token totals and caller-supplied prices.
 *
 * Prices are per million tokens. There is deliberately no built-in price table:
 * prices change and an old table would silently misprice old rows. The
 * extraction prompt is split into cached and uncached input by
 * `extractionCachedShare` because the scorer records extraction usage without a
 * cached-token counter. When no usable price is supplied the result is null,
 * never 0.
 *
 * @param {object} input
 * @param {Record<string, unknown>} [input.tokens] the row's five token fields
 * @param {{ inputPerMTok?: number, cachedInputPerMTok?: number, outputPerMTok?: number } | null} [input.prices]
 * @param {number} [input.extractionCachedShare=0.9] 0..1
 * @returns {number | null} CNY, or null when no usable price was supplied
 */
export function estimateCostCny({ tokens, prices, extractionCachedShare = DEFAULT_EXTRACTION_CACHED_SHARE } = {}) {
  const normalised = normalisePrices(prices);
  if (!normalised) return null;

  const totals = tokenTotals(tokens, null);
  const share = isFiniteNumber(extractionCachedShare)
    ? Math.min(1, Math.max(0, extractionCachedShare))
    : DEFAULT_EXTRACTION_CACHED_SHARE;

  // Keep the split inside the prompt total when a caller supplies inconsistent
  // token records: the sum of billed input tokens never exceeds the prompt.
  const extractionPrompt = Math.min(totals.extractionPrompt, totals.prompt);
  const cachedAnswer = Math.min(totals.cached, totals.prompt - extractionPrompt);
  const extractionCached = extractionPrompt * share;
  const extractionUncached = extractionPrompt - extractionCached;
  const regularPrompt = totals.prompt - extractionPrompt - cachedAnswer;

  const inputTokens = regularPrompt + extractionUncached;
  const cachedTokens = cachedAnswer + extractionCached;

  let cost = 0;
  if (normalised.inputPerMTok !== null) cost += (inputTokens / 1_000_000) * normalised.inputPerMTok;
  if (normalised.cachedInputPerMTok !== null) cost += (cachedTokens / 1_000_000) * normalised.cachedInputPerMTok;
  if (normalised.outputPerMTok !== null) cost += (totals.completion / 1_000_000) * normalised.outputPerMTok;
  // Six decimal places is a micro-CNY; it keeps float noise out of the ledger
  // without rounding a real per-token charge away.
  return Number(cost.toFixed(6));
}

/**
 * A note stating the extraction-cache assumption, or null when it did not
 * affect the cost or no cost was estimated.
 *
 * @param {{ extractionPrompt: number }} tokens
 * @param {number | null} costCny
 * @param {number} share
 * @returns {string | null}
 */
function costAssumptionNote(tokens, costCny, share) {
  if (costCny === null || tokens.extractionPrompt <= 0 || share <= 0) return null;
  const percentCached = Number((share * 100).toFixed(1));
  return `cost assumption: extraction prompt tokens are costed as ${percentCached}% cached input (--extraction-cached-share=${share})`;
}

/**
 * Join optional notes without leaving empty separators.
 *
 * @param {Array<string | null | undefined>} notes
 * @returns {string | undefined}
 */
function joinNotes(notes) {
  const present = notes.filter((note) => typeof note === 'string' && note.length > 0);
  return present.length > 0 ? present.join('; ') : undefined;
}

/**
 * Count the disputed items of one set. The scorer writes a top-level
 * `disputed` array of `{ set, split, caseId, id, reason }`; a summary may also
 * carry a per-set count.
 *
 * @param {Record<string, unknown>} summary
 * @param {string} setName
 * @param {Record<string, unknown>} set
 * @returns {number}
 */
function disputedCount(summary, setName, set) {
  if (isNonNegativeInteger(set.disputed)) return set.disputed;
  if (isNonNegativeInteger(summary.disputed)) return summary.disputed;
  if (!Array.isArray(summary.disputed)) return 0;
  return summary.disputed.filter((entry) => isPlainObject(entry) && entry.set === setName).length;
}

/** @param {Record<string, any>} run @returns {number} */
function wallSecondsBetween(run) {
  const start = Date.parse(String(run.startedAt ?? ''));
  const end = Date.parse(String(run.finishedAt ?? run.endedAt ?? ''));
  if (!Number.isNaN(start) && !Number.isNaN(end) && end >= start) return (end - start) / 1000;
  return 0;
}

/**
 * Turn a run's `run.json` and a scorer's `summary.json` into ledger rows.
 *
 * This reads the summary the scorer actually writes (`run/score.mjs`,
 * `summarize` and `scoreRun`): per set `n`, `pass`, `fail`, `unknown`, `error`,
 * `invalid-item`, `nValid`, `accuracy`, `ci95`, `accuracyValid`, `ci95Valid`,
 * `judged`, `byCategory`, `byGenerator`, `byStep`, `store` and `redlines`; and
 * top-level `disputed`, `wallSeconds`, `tokens` and `redLines`.
 *
 * One row is emitted per set for `accuracy`; a `store_recall` row is emitted
 * when the set has store results, and one `redline_count` row per red line.
 * Every row carries the five token fields and the run's wall time.
 *
 * @param {object} input
 * @param {Record<string, any>} input.run the run.json object; `rawPath` may be
 *   set by the caller to the run directory
 * @param {Record<string, any>} input.summary the scorer summary
 * @param {string} [input.scorer] commit or version tag of the scorer
 * @param {number | null} [input.costCny] total run cost in CNY; when omitted it
 *   is estimated from `prices`, and null when no usable price is supplied
 * @param {number} [input.wallSeconds] total run wall time in seconds
 * @param {{ inputPerMTok?: number, cachedInputPerMTok?: number, outputPerMTok?: number } | null} [input.prices]
 * @param {number} [input.extractionCachedShare=0.9]
 * @returns {Array<Record<string, unknown>>}
 */
export function rowsFromSummary({
  run,
  summary,
  scorer,
  costCny,
  wallSeconds,
  prices,
  extractionCachedShare = DEFAULT_EXTRACTION_CACHED_SHARE,
} = {}) {
  if (!isPlainObject(run)) throw new TypeError('run must be an object');
  if (!isPlainObject(summary)) throw new TypeError('summary must be an object');

  // The scorer writes `summary.sets`; `bySet` is the older aggregate view kept
  // beside it. Prefer the set view and read the other only as a fallback.
  const contractSets = isPlainObject(summary.sets) && Object.keys(summary.sets).length > 0 ? summary.sets : null;
  const sets = contractSets ?? (isPlainObject(summary.bySet) ? summary.bySet : null);
  if (!sets) return [];

  const engine = isPlainObject(run.engine)
    ? {
        version: isNonEmptyString(run.engine.version) ? run.engine.version : 'unknown',
        templatesDigest: isNonEmptyString(run.engine.templatesDigest) ? run.engine.templatesDigest : 'unknown',
      }
    : { version: 'unknown', templatesDigest: 'unknown' };

  const tokens = tokenTotals(summary.tokens, run.tokens);
  const share = isFiniteNumber(extractionCachedShare)
    ? Math.min(1, Math.max(0, extractionCachedShare))
    : DEFAULT_EXTRACTION_CACHED_SHARE;
  const explicitCost = isNonNegativeNumber(costCny);
  const estimatedCost = explicitCost
    ? null
    : estimateCostCny({ tokens, prices, extractionCachedShare: share });
  const resolvedCost = explicitCost ? costCny : estimatedCost;
  const costNote = joinNotes([explicitCost ? null : costAssumptionNote(tokens, resolvedCost, share), summary.judge?.comparability,
    summary.judge?.answerJudgeSameFamily ? 'Answerer and judge are the same model family (Qwen).' : null]);

  const at = isNonEmptyString(run.finishedAt)
    ? run.finishedAt
    : isNonEmptyString(run.endedAt)
      ? run.endedAt
      : isNonEmptyString(run.startedAt)
        ? run.startedAt
        : new Date().toISOString();

  const resolvedWallSeconds = isNonNegativeNumber(wallSeconds)
    ? wallSeconds
    : isNonNegativeNumber(summary.wallSeconds)
      ? summary.wallSeconds
      : isNonNegativeNumber(run.wallSeconds)
        ? run.wallSeconds
        : wallSecondsBetween(run);

  const base = {
    at,
    runId: isNonEmptyString(run.runId) ? run.runId : 'unknown',
    commit: isNonEmptyString(run.commit) ? run.commit : 'unknown',
    engine,
    arm: isNonEmptyString(run.arm) ? run.arm : 'unknown',
    flags: { ...(isPlainObject(run.flags) ? run.flags : {}), ...(summary.rubric ? { rubric: summary.rubric } : {}) },
    set: isNonEmptyString(run.set) ? run.set : 'unknown',
    split: isNonEmptyString(run.split) ? run.split : 'unknown',
    ...(isNonEmptyString(run.label) ? { label: run.label } : {}),
    tokens,
    costCny: resolvedCost,
    wallSeconds: resolvedWallSeconds,
    scorer: isNonEmptyString(scorer)
      ? scorer
      : isNonEmptyString(run.scorer)
        ? run.scorer
        : isNonEmptyString(run.commit)
          ? run.commit
          : 'unknown',
    rawPath: isNonEmptyString(run.rawPath)
      ? run.rawPath
      : isNonEmptyString(run.runDir)
        ? run.runDir
        : isNonEmptyString(run.path)
          ? run.path
          : '.',
  };

  /** @type {Array<Record<string, unknown>>} */
  const rows = [];

  // `summary.redLines.byType` is global to the summary, so its per-type n is a
  // per-set denominator only when the summary has one set.
  const singleSet = Object.keys(sets).length === 1;

  for (const [setName, set] of Object.entries(sets)) {
    if (!isPlainObject(set)) continue;

    const n = toCount(set.n);
    const pass = toCount(set.pass);
    const invalid = toCount(set['invalid-item']);
    const nValid = isNonNegativeInteger(set.nValid) ? set.nValid : Math.max(0, n - invalid);
    const accuracy = isFiniteNumber(set.accuracy) ? set.accuracy : n === 0 ? 0 : pass / n;
    const valueValid = isFiniteNumber(set.accuracyValid)
      ? set.accuracyValid
      : nValid === 0
        ? null
        : pass / nValid;
    const ci95 = set.ci95 === null ? null : interval(set.ci95) ?? safeWilson(pass, n);
    const ci95Valid = set.ci95Valid === null ? null : interval(set.ci95Valid) ?? safeWilson(pass, nValid);

    const accuracyRow = {
      ...base,
      set: setName,
      metric: 'accuracy',
      n,
      value: accuracy,
      ci95,
      valueValid,
      ci95Valid,
      nValid,
      invalid,
      disputed: disputedCount(summary, setName, set),
      judged: judgedCounts(set.judged, set),
    };

    const byCategory = breakdown(set.byCategory);
    if (byCategory) accuracyRow.byCategory = byCategory;
    const byGenerator = breakdown(set.byGenerator);
    if (byGenerator) accuracyRow.byGenerator = byGenerator;
    const byStep = stepCounts(set.byStep);
    if (byStep) accuracyRow.byStep = byStep;
    if (costNote) accuracyRow.notes = costNote;

    rows.push(accuracyRow);

    if (isPlainObject(set.store)) {
      const storeN = toCount(set.store.n);
      const storePass = toCount(set.store.pass);
      if (storeN > 0 || storePass > 0 || isFiniteNumber(set.store.value)) {
        const storeValue = isFiniteNumber(set.store.value)
          ? set.store.value
          : storeN === 0
            ? 0
            : storePass / storeN;
        rows.push({
          ...base,
          set: setName,
          metric: 'store_recall',
          n: storeN,
          value: storeValue,
          ci95: interval(set.store.ci95) ?? safeWilson(storePass, storeN),
          judged: { code: storeN, judge: 0, unknown: 0, error: 0 },
          ...(costNote ? { notes: costNote } : {}),
        });
      }
    }

    if (isPlainObject(set.redlines)) {
      const byType = isPlainObject(summary.redLines) && isPlainObject(summary.redLines.byType)
        ? summary.redLines.byType
        : null;
      for (const [type, count] of Object.entries(set.redlines)) {
        if (!isNonNegativeNumber(count)) continue;
        const typeStats = singleSet && byType && isPlainObject(byType[type]) ? byType[type] : null;
        const typeN = typeStats && isNonNegativeInteger(typeStats.n) ? typeStats.n : n;
        rows.push({
          ...base,
          set: setName,
          metric: 'redline_count',
          n: typeN,
          value: count,
          ci95: null,
          judged: typeStats ? judgedCounts(typeStats.judged, typeStats) : { code: typeN, judge: 0, unknown: 0, error: 0 },
          notes: joinNotes([`redline=${type}`, costNote]),
        });
      }
    }
  }

  // Compatibility with summaries that carry only the run-level blocks. The
  // scorer itself writes both, but an external harness may supply only these.
  if (contractSets === null) {
    const fallbackSet = isNonEmptyString(run.set) ? run.set : 'all';
    if (isPlainObject(summary.storeRecall)) {
      const storeN = toCount(summary.storeRecall.n);
      const storePass = toCount(summary.storeRecall.pass);
      if (storeN > 0 || storePass > 0 || isFiniteNumber(summary.storeRecall.value)) {
        rows.push({
          ...base,
          set: fallbackSet,
          metric: 'store_recall',
          n: storeN,
          value: isFiniteNumber(summary.storeRecall.value)
            ? summary.storeRecall.value
            : storeN === 0
              ? 0
              : storePass / storeN,
          ci95: interval(summary.storeRecall.ci95) ?? safeWilson(storePass, storeN),
          judged: { code: storeN, judge: 0, unknown: toCount(summary.storeRecall.unknown), error: 0 },
          ...(costNote ? { notes: costNote } : {}),
        });
      }
    }
    if (isPlainObject(summary.redLines)) {
      const byType = isPlainObject(summary.redLines.byType) ? summary.redLines.byType : null;
      if (byType && Object.keys(byType).length > 0) {
        for (const [type, stats] of Object.entries(byType)) {
          if (!isPlainObject(stats)) continue;
          const typeN = toCount(stats.n);
          rows.push({
            ...base,
            set: fallbackSet,
            metric: 'redline_count',
            n: typeN,
            value: toCount(stats.fail),
            ci95: null,
            judged: judgedCounts(stats.judged, stats),
            notes: joinNotes([`redline=${type}`, costNote]),
          });
        }
      } else {
        const redN = toCount(summary.redLines.n);
        rows.push({
          ...base,
          set: fallbackSet,
          metric: 'redline_count',
          n: redN,
          value: toCount(summary.redLines.count),
          ci95: null,
          judged: { code: redN, judge: 0, unknown: toCount(summary.redLines.unknown), error: 0 },
          notes: joinNotes([`redLines.count=${toCount(summary.redLines.count)}`, costNote]),
        });
      }
    }
  }

  return rows;
}

/** @returns {{ command: string | null, run: string | null, ledger: string | null, json: string | null, variant: string | null, costCny: number | null, prices: object | null, extractionCachedShare: number }} */
function parseArgs(argv) {
  const options = {
    command: null,
    run: null,
    ledger: null,
    json: null,
    variant: null,
    costCny: null,
    prices: null,
    extractionCachedShare: DEFAULT_EXTRACTION_CACHED_SHARE,
  };
  if (argv.length === 0) return options;
  options.command = argv[0];

  /** @type {{ inputPerMTok?: number, cachedInputPerMTok?: number, outputPerMTok?: number }} */
  const prices = {};
  const numberFlag = (flag, raw) => {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) throw new Error(`${flag} must be a non-negative number, got ${raw}`);
    return value;
  };

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--run') options.run = argv[++index] ?? null;
    else if (arg === '--ledger') options.ledger = argv[++index] ?? null;
    else if (arg === '--rubric') options.rubric = argv[++index] ?? null;
    else if (arg === '--variant') options.variant = argv[++index] ?? null;
    else if (arg === '--json') options.json = argv[++index] ?? null;
    else if (arg === '--cost-cny') options.costCny = numberFlag(arg, argv[++index]);
    else if (arg === '--price-input') prices.inputPerMTok = numberFlag(arg, argv[++index]);
    else if (arg === '--price-cached') prices.cachedInputPerMTok = numberFlag(arg, argv[++index]);
    else if (arg === '--price-output') prices.outputPerMTok = numberFlag(arg, argv[++index]);
    else if (arg === '--extraction-cached-share') {
      const raw = argv[++index];
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error(`--extraction-cached-share must be a number between 0 and 1, got ${raw}`);
      }
      options.extractionCachedShare = value;
    } else if (arg === '--help' || arg === '-h') {
      options.command = 'help';
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (Object.keys(prices).length > 0) options.prices = prices;
  return options;
}

const USAGE = [
  'usage: node run/ledger.mjs append --run <run dir> [--variant <name>] [--ledger <file>] [--cost-cny N]',
  '       [--price-input N] [--price-cached N] [--price-output N] [--extraction-cached-share 0..1]',
  '       node run/ledger.mjs add --json <file> [--ledger <file>]',
].join('\n');

/** CLI entry point. */
function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (options.command !== 'append' && options.command !== 'add') throw new Error(USAGE);

  const ledger = resolve(options.ledger ?? DEFAULT_LEDGER_PATH);

  if (options.command === 'add') {
    if (!isNonEmptyString(options.json)) throw new Error(`--json is required for add\n${USAGE}`);
    const parsed = JSON.parse(readFileSync(resolve(options.json), 'utf8'));
    const rows = Array.isArray(parsed) ? parsed : isPlainObject(parsed) ? [parsed] : null;
    if (!rows) throw new Error('--json must hold one ledger row or an array of rows');
    const result = appendLedgerRows(ledger, rows);
    process.stdout.write(`${JSON.stringify({ ...result, ledger, rows: rows.length })}\n`);
    return;
  }

  if (!isNonEmptyString(options.run)) throw new Error(`--run is required\n${USAGE}`);
  if (options.variant !== null && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.variant)) {
    throw new Error('--variant must be a directory-safe name');
  }

  const runDir = resolve(options.run);
  const run = JSON.parse(readFileSync(resolve(runDir, 'run.json'), 'utf8'));
  if (options.rubric && !['official', 'approximate'].includes(options.rubric)) throw new Error('rubric_invalid');
  const summaryFile = resolve(runDir, `${options.variant ? `scores.${options.variant}` : 'scores'}${options.rubric === 'official' ? '.official' : ''}`, 'summary.json');
  const summary = JSON.parse(readFileSync(summaryFile, 'utf8'));
  const arm = options.variant
    ? `${isNonEmptyString(run.arm) ? run.arm : 'unknown'}+${options.variant}`
    : undefined;

  const rows = rowsFromSummary({
    run: { ...run, ...(arm ? { arm } : {}), rawPath: runDir },
    summary,
    scorer: run.scorer ?? run.scorerVersion ?? run.commit ?? 'unknown',
    costCny: options.costCny,
    prices: options.prices,
    extractionCachedShare: options.extractionCachedShare,
  });
  const result = appendLedgerRows(ledger, rows);
  process.stdout.write(`${JSON.stringify({ ...result, ledger, rows: rows.length })}\n`);
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`ledger: ${error.message}\n`);
    process.exitCode = 1;
  }
}
