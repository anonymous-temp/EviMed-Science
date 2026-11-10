/**
 * Markdown scoreboard for the capsule-proving ledger.
 *
 * The pure renderer takes the rows and the generation time, so its output is
 * reproducible in a test. The CLI reads the append-only ledger and writes the
 * generated scoreboard at run time; no Markdown file is checked into the repo.
 *
 * Plain Node 22 ESM, no dependencies.
 *
 * @module capsule-proving/run/scoreboard
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Default ledger path, resolved next to this module rather than from the caller's cwd. */
export const DEFAULT_LEDGER_PATH = fileURLToPath(new URL('../results/ledger.jsonl', import.meta.url));

/** Default scoreboard path, next to the ledger. */
export const DEFAULT_OUT_PATH = fileURLToPath(new URL('../results/SCOREBOARD.md', import.meta.url));

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} value @returns {string} */
function text(value) {
  return value === undefined || value === null ? '' : String(value);
}

/** Escape a value for a Markdown table cell. @param {unknown} value @returns {string} */
function cell(value) {
  return text(value).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

/** @param {unknown} value @returns {string} */
function flagValue(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);
  return JSON.stringify(value);
}

/**
 * Compact, stable `k=v` flags: keys sorted, one comma-separated line.
 *
 * @param {unknown} flags
 * @returns {string}
 */
function formatFlags(flags) {
  if (!isPlainObject(flags)) return '—';
  const keys = Object.keys(flags).sort();
  if (keys.length === 0) return '—';
  return keys.map((key) => `${key}=${flagValue(flags[key])}`).join(', ');
}

/** @param {unknown} value @returns {string} */
function formatCount(value) {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '0';
}

/** @param {unknown} value @returns {number | null} */
function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** @param {number} value @returns {string} */
function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * A plain number for a non-proportion metric: integers stay integers and
 * decimals keep up to four places without a percent sign.
 *
 * @param {unknown} value
 * @returns {string}
 */
function formatNumber(value) {
  const number = finiteNumber(value);
  if (number === null) return '0';
  return Number.isInteger(number) ? String(number) : String(Number(number.toFixed(4)));
}

/** @param {unknown} ci95 @returns {string | null} */
function formatInterval(ci95, formatter) {
  if (!Array.isArray(ci95) || ci95.length !== 2 || !ci95.every((entry) => finiteNumber(entry) !== null)) return null;
  return `[${formatter(ci95[0])}, ${formatter(ci95[1])}]`;
}

/**
 * A metric is a proportion when its name is one of the harness's known
 * proportions. Counts and mean scores are printed as plain numbers.
 *
 * @param {string} metric
 * @returns {boolean}
 */
function isProportionMetric(metric) {
  if (metric.endsWith('_count')) return false;
  if (/(^|_)(mean|median|avg|average)(_|$)/.test(metric)) return false;
  if (metric === 'score' || metric.endsWith('_score')) return false;
  return true;
}

/**
 * A proportion with its interval, or a number for a count/mean metric. When the
 * scorer's valid-item denominator produces a different proportion, that value
 * is shown beside the all-item value with the invalid-item count.
 *
 * @param {Record<string, unknown>} row
 * @returns {string}
 */
function formatValue(row) {
  const metric = text(row.metric);
  const value = finiteNumber(row.value) ?? 0;

  if (!isProportionMetric(metric)) {
    const interval = formatInterval(row.ci95, formatNumber);
    return interval ? `${formatNumber(value)} ${interval}` : formatNumber(value);
  }

  let rendered = percent(value);
  const valid = finiteNumber(row.valueValid);
  if (valid !== null && valid !== value) {
    const invalid = typeof row.invalid === 'number' && Number.isInteger(row.invalid) && row.invalid >= 0 ? row.invalid : 0;
    rendered += ` (${percent(valid)} without ${invalid} invalid item${invalid === 1 ? '' : 's'})`;
  }
  const interval = formatInterval(row.ci95, percent);
  return interval ? `${rendered} ${interval}` : rendered;
}

/** @param {unknown} judged @returns {string} */
function formatJudged(judged) {
  if (!isPlainObject(judged)) return '0/0/0/0';
  return ['code', 'judge', 'unknown', 'error'].map((field) => formatCount(judged[field])).join('/');
}

/** @param {unknown} tokens @returns {string} */
function formatTokens(tokens) {
  if (!isPlainObject(tokens)) return '0 / 0';
  return `${formatCount(tokens.prompt)} / ${formatCount(tokens.completion)}`;
}

/** @param {unknown} value @returns {string} */
function formatCost(value) {
  const number = finiteNumber(value);
  return number === null ? '—' : number.toFixed(2);
}

/** @param {Record<string, unknown>} row @returns {string} */
function formatCommit(row) {
  return text(row.commit).slice(0, 7) || '—';
}

/** Labels for the scorer's `byStep` failure stages. */
const STEP_LABELS = {
  not_stored: 'not stored',
  not_searched: 'not searched',
  not_retrieved: 'not retrieved',
  retrieved_but_wrong: 'misused',
  misused: 'misused',
};

/** @type {string[]} */
const STEP_ORDER = ['not_stored', 'not_searched', 'not_retrieved', 'retrieved_but_wrong'];

/**
 * Render `byStep` as `not stored 3 · not searched 40 · …`. Unknown keys keep
 * their order after the known stages. Returns an em dash when the row has none.
 *
 * @param {unknown} byStep
 * @returns {string}
 */
function formatByStep(byStep) {
  if (!isPlainObject(byStep)) return '—';
  const keys = Object.keys(byStep);
  if (keys.length === 0) return '—';
  const ordered = [
    ...STEP_ORDER.filter((key) => Object.hasOwn(byStep, key)),
    ...keys.filter((key) => !STEP_ORDER.includes(key)).sort(),
  ];
  return ordered
    .map((key) => `${STEP_LABELS[key] ?? key.replace(/_/g, ' ')} ${formatCount(byStep[key])}`)
    .join(' · ');
}

/**
 * Stable order required by the scoreboard: set, split, arm, then time. The
 * metric and run id make ties deterministic so the renderer is a pure function
 * of the rows.
 *
 * @param {Record<string, unknown>} left
 * @param {Record<string, unknown>} right
 * @returns {number}
 */
function compareRows(left, right) {
  for (const field of ['set', 'split', 'arm', 'at', 'metric', 'runId']) {
    const a = text(left[field]);
    const b = text(right[field]);
    if (a < b) return -1;
    if (a > b) return 1;
  }
  return 0;
}

/**
 * Group rows by set, then by split, so the arms of one set+split sit together.
 *
 * @param {Array<Record<string, unknown>>} rows sorted rows
 * @returns {Map<string, Map<string, Array<Record<string, unknown>>>>}
 */
function groupRows(rows) {
  /** @type {Map<string, Map<string, Array<Record<string, unknown>>>>} */
  const groups = new Map();
  for (const row of rows) {
    const setName = text(row.set) || '(no set)';
    const split = text(row.split) || '(no split)';
    if (!groups.has(setName)) groups.set(setName, new Map());
    const splits = groups.get(setName);
    if (!splits.has(split)) splits.set(split, []);
    splits.get(split).push(row);
  }
  return groups;
}

/**
 * Render the scoreboard. Pure: the caller supplies the generation time.
 *
 * @param {Array<Record<string, unknown>>} rows ledger rows
 * @param {string | { generatedAt?: string }} [generatedAt] ISO time (or an object carrying it)
 * @returns {string} Markdown
 */
export function renderScoreboard(rows, generatedAt = 'unspecified') {
  if (!Array.isArray(rows)) throw new TypeError('rows must be an array');
  const generated = generatedAt instanceof Date
    ? generatedAt.toISOString()
    : isPlainObject(generatedAt)
      ? text(generatedAt.generatedAt ?? generatedAt.at ?? 'unspecified')
      : text(generatedAt);

  const sorted = rows.filter(isPlainObject).sort(compareRows);
  const groups = groupRows(sorted);

  /** @type {string[]} */
  const lines = [];
  lines.push('# Capsule proving scoreboard');
  lines.push('');
  lines.push(`_Rule: a number without a ledger row does not count. Generated at ${generated}._`);
  lines.push('');

  if (groups.size === 0) {
    lines.push('No ledger rows.');
    lines.push('');
    return lines.join('\n');
  }

  for (const [setName, splits] of groups) {
    lines.push(`## ${cell(setName)}`);
    lines.push('');
    for (const [split, splitRows] of splits) {
      lines.push(`### ${cell(split)}`);
      lines.push('');
      lines.push('| arm | flags | n | metric | value (95% CI) | wrong because | disputed | judged (code/judge/unknown/error) | tokens (prompt/completion) | cost (CNY) | commit | runId |');
      lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
      for (const row of splitRows) {
        lines.push(
          `| ${cell(row.arm)} | ${cell(formatFlags(row.flags))} | ${formatCount(row.n)} | ${cell(row.metric)} | ${cell(formatValue(row))} | ${cell(formatByStep(row.byStep))} | ${formatCount(row.disputed)} | ${formatJudged(row.judged)} | ${formatTokens(row.tokens)} | ${formatCost(row.costCny)} | ${cell(formatCommit(row))} | ${cell(row.runId)} |`,
        );
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

/** @returns {{ ledger: string | null, out: string | null, help: boolean }} */
function parseArgs(argv) {
  const options = { ledger: null, out: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--ledger') options.ledger = argv[++index] ?? null;
    else if (arg === '--out') options.out = argv[++index] ?? null;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

/**
 * Read a JSONL ledger. Blank lines are ignored; a malformed line is an error.
 *
 * @param {string} file
 * @returns {Array<Record<string, unknown>>}
 */
function readLedger(file) {
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  /** @type {Array<Record<string, unknown>>} */
  const rows = [];
  lines.forEach((line, index) => {
    if (line.trim() === '') return;
    try {
      const parsed = JSON.parse(line);
      if (!isPlainObject(parsed)) throw new Error('row is not an object');
      rows.push(parsed);
    } catch (error) {
      throw new Error(`ledger ${file} line ${index + 1} is not JSON: ${error.message}`);
    }
  });
  return rows;
}

const USAGE = 'usage: node run/scoreboard.mjs [--ledger <file>] [--out results/SCOREBOARD.md]';

/** CLI entry point. */
function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const ledger = resolve(options.ledger ?? DEFAULT_LEDGER_PATH);
  const out = resolve(options.out ?? DEFAULT_OUT_PATH);
  const rows = readLedger(ledger);
  const markdown = renderScoreboard(rows, new Date().toISOString());
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, markdown, 'utf8');
  process.stdout.write(`${JSON.stringify({ out, ledger, rows: rows.length })}\n`);
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`scoreboard: ${error.message}\n`);
    process.exitCode = 1;
  }
}
