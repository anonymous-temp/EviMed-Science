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
    for (const field of ['prompt', 'completion']) {
      if (!isNonNegativeNumber(row.tokens[field])) problems.push(`tokens.${field} must be a non-negative number`);
    }
  }

  if (!isNonNegativeNumber(row.costCny)) problems.push('costCny must be a non-negative finite number');
  if (!isNonNegativeNumber(row.wallSeconds)) problems.push('wallSeconds must be a non-negative finite number');

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
    const value = isFiniteNumber(entry.value) ? entry.value : n === 0 ? 0 : toCount(entry.pass) / n;
    out[name] = { n, value };
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
 * Turn a run's `run.json` and a scorer's `summary.json` into ledger rows.
 *
 * One row is emitted per set for `accuracy`; a `store_recall` row is emitted
 * when the set has a `store` block, and a `redline_count` row when it has
 * `redlines`. Category and generator breakdowns are folded into the accuracy
 * row as `byCategory` and `byGenerator`.
 *
 * @param {object} input
 * @param {Record<string, any>} input.run the run.json object; `rawPath` may be
 *   set by the caller to the run directory
 * @param {Record<string, any>} input.summary the scorer summary
 * @param {string} [input.scorer] commit or version tag of the scorer
 * @param {number} [input.costCny] total run cost in CNY
 * @param {number} [input.wallSeconds] total run wall time in seconds
 * @returns {Array<Record<string, unknown>>}
 */
export function rowsFromSummary({ run, summary, scorer, costCny, wallSeconds } = {}) {
  if (!isPlainObject(run)) throw new TypeError('run must be an object');
  if (!isPlainObject(summary)) throw new TypeError('summary must be an object');

  // The contract's shape is `summary.sets`; the scorer's older/current shape is
  // `summary.bySet`. Prefer the contract and read the other one only as a
  // compatibility fallback, so one scorer version cannot silently produce an
  // empty ledger.
  const contractSets = isPlainObject(summary.sets) && Object.keys(summary.sets).length > 0 ? summary.sets : null;
  const sets = contractSets ?? (isPlainObject(summary.bySet) ? summary.bySet : null);
  if (!sets) return [];

  const engine = isPlainObject(run.engine)
    ? {
        version: isNonEmptyString(run.engine.version) ? run.engine.version : 'unknown',
        templatesDigest: isNonEmptyString(run.engine.templatesDigest) ? run.engine.templatesDigest : 'unknown',
      }
    : { version: 'unknown', templatesDigest: 'unknown' };

  const tokens = isPlainObject(summary.tokens)
    ? {
        prompt: toNonNegativeNumber(summary.tokens.prompt, 0),
        completion: toNonNegativeNumber(summary.tokens.completion, 0),
      }
    : isPlainObject(run.tokens)
      ? {
          prompt: toNonNegativeNumber(run.tokens.prompt, 0),
          completion: toNonNegativeNumber(run.tokens.completion, 0),
        }
      : { prompt: 0, completion: 0 };

  const at = isNonEmptyString(run.finishedAt)
    ? run.finishedAt
    : isNonEmptyString(run.endedAt)
      ? run.endedAt
      : isNonEmptyString(run.startedAt)
        ? run.startedAt
        : new Date().toISOString();

  const base = {
    at,
    runId: isNonEmptyString(run.runId) ? run.runId : 'unknown',
    commit: isNonEmptyString(run.commit) ? run.commit : 'unknown',
    engine,
    arm: isNonEmptyString(run.arm) ? run.arm : 'unknown',
    flags: isPlainObject(run.flags) ? { ...run.flags } : {},
    split: isNonEmptyString(run.split) ? run.split : 'unknown',
    tokens,
    costCny: toNonNegativeNumber(costCny ?? run.costCny, 0),
    wallSeconds: toNonNegativeNumber(wallSeconds ?? run.wallSeconds, 0),
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

  for (const [setName, set] of Object.entries(sets)) {
    if (!isPlainObject(set)) continue;

    const n = toCount(set.n);
    const pass = toCount(set.pass);
    const accuracy = isFiniteNumber(set.accuracy) ? set.accuracy : n === 0 ? 0 : pass / n;
    const ci95 = set.ci95 === null
      ? null
      : Array.isArray(set.ci95) && set.ci95.length === 2 && set.ci95.every(isFiniteNumber)
        ? /** @type {[number, number]} */ ([set.ci95[0], set.ci95[1]])
        : safeWilson(pass, n);

    const accuracyRow = {
      ...base,
      set: setName,
      metric: 'accuracy',
      n,
      value: accuracy,
      ci95,
      judged: judgedCounts(set.judged, set),
    };

    const byCategory = breakdown(set.byCategory);
    if (byCategory) accuracyRow.byCategory = byCategory;
    const byGenerator = breakdown(set.byGenerator);
    if (byGenerator) accuracyRow.byGenerator = byGenerator;

    rows.push(accuracyRow);

    if (isPlainObject(set.store)) {
      const storeN = toCount(set.store.n);
      const storePass = toCount(set.store.pass);
      rows.push({
        ...base,
        set: setName,
        metric: 'store_recall',
        n: storeN,
        value: storeN === 0 ? 0 : storePass / storeN,
        ci95: safeWilson(storePass, storeN),
        judged: { code: storeN, judge: 0, unknown: 0, error: 0 },
      });
    }

    if (isPlainObject(set.redlines)) {
      const entries = Object.entries(set.redlines).filter(([, count]) => isNonNegativeNumber(count));
      if (entries.length > 0) {
        const total = entries.reduce((sum, [, count]) => sum + count, 0);
        rows.push({
          ...base,
          set: setName,
          metric: 'redline_count',
          n,
          value: total,
          ci95: null,
          judged: { code: entries.length, judge: 0, unknown: 0, error: 0 },
          notes: entries.map(([name, count]) => `${name}=${count}`).join(', '),
        });
      }
    }
  }

  // Compatibility with the scorer's global store/red-line blocks. The contract
  // carries these per set; a summary with no `sets`/`bySet` breakdown still
  // contributes one run-level row for the run's own set.
  if (contractSets === null) {
    const fallbackSet = isNonEmptyString(run.set) ? run.set : 'all';
    if (isPlainObject(summary.storeRecall)) {
      const storeN = toCount(summary.storeRecall.n);
      const storePass = toCount(summary.storeRecall.pass);
      rows.push({
        ...base,
        set: fallbackSet,
        metric: 'store_recall',
        n: storeN,
        value: storeN === 0 ? 0 : storePass / storeN,
        ci95: safeWilson(storePass, storeN),
        judged: { code: storeN, judge: 0, unknown: 0, error: 0 },
      });
    }
    if (isPlainObject(summary.redLines)) {
      const redN = toCount(summary.redLines.n);
      rows.push({
        ...base,
        set: fallbackSet,
        metric: 'redline_count',
        n: redN,
        value: toCount(summary.redLines.count),
        ci95: null,
        judged: { code: redN, judge: 0, unknown: 0, error: 0 },
        notes: `redLines.count=${toCount(summary.redLines.count)}`,
      });
    }
  }

  return rows;
}

/** @returns {{ command: string | null, run: string | null, ledger: string | null, costCny: number | null }} */
function parseAppendArgs(argv) {
  const options = { command: null, run: null, ledger: null, costCny: null };
  if (argv.length === 0) return options;
  options.command = argv[0];
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--run') options.run = argv[++index] ?? null;
    else if (arg === '--ledger') options.ledger = argv[++index] ?? null;
    else if (arg === '--cost-cny') {
      const raw = argv[++index];
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0) throw new Error(`--cost-cny must be a non-negative number, got ${raw}`);
      options.costCny = value;
    } else if (arg === '--help' || arg === '-h') {
      options.command = 'help';
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

/** @param {Record<string, any>} run @returns {number} */
function wallSecondsOf(run) {
  if (isNonNegativeNumber(run.wallSeconds)) return run.wallSeconds;
  const start = Date.parse(String(run.startedAt ?? ''));
  const end = Date.parse(String(run.finishedAt ?? run.endedAt ?? ''));
  if (!Number.isNaN(start) && !Number.isNaN(end) && end >= start) return (end - start) / 1000;
  return 0;
}

const USAGE = 'usage: node run/ledger.mjs append --run <run dir> [--ledger <file>] [--cost-cny N]';

/** CLI entry point. */
function main() {
  const options = parseAppendArgs(process.argv.slice(2));
  if (options.command === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (options.command !== 'append') throw new Error(USAGE);
  if (!isNonEmptyString(options.run)) throw new Error(`--run is required\n${USAGE}`);

  const runDir = resolve(options.run);
  const run = JSON.parse(readFileSync(resolve(runDir, 'run.json'), 'utf8'));
  const summary = JSON.parse(readFileSync(resolve(runDir, 'scores', 'summary.json'), 'utf8'));
  const rows = rowsFromSummary({
    run: { ...run, rawPath: runDir },
    summary,
    scorer: run.scorer ?? run.scorerVersion ?? run.commit ?? 'unknown',
    costCny: options.costCny ?? run.costCny ?? 0,
    wallSeconds: wallSecondsOf(run),
  });
  const ledger = resolve(options.ledger ?? DEFAULT_LEDGER_PATH);
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
