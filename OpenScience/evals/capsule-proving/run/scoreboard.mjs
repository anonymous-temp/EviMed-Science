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

/** @param {number} value @returns {string} */
function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * A proportion with its interval, or an integer for a count metric.
 *
 * @param {Record<string, unknown>} row
 * @returns {string}
 */
function formatValue(row) {
  const metric = text(row.metric);
  const value = typeof row.value === 'number' && Number.isFinite(row.value) ? row.value : 0;
  if (metric.endsWith('_count')) {
    if (Array.isArray(row.ci95) && row.ci95.length === 2) {
      return `${formatCount(value)} [${formatCount(row.ci95[0])}, ${formatCount(row.ci95[1])}]`;
    }
    return formatCount(value);
  }
  const rendered = percent(value);
  if (Array.isArray(row.ci95) && row.ci95.length === 2 && row.ci95.every((entry) => typeof entry === 'number' && Number.isFinite(entry))) {
    return `${rendered} [${percent(row.ci95[0])}, ${percent(row.ci95[1])}]`;
  }
  return rendered;
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
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : '0.00';
}

/** @param {Record<string, unknown>} row @returns {string} */
function formatCommit(row) {
  return text(row.commit).slice(0, 7) || '—';
}

/**
 * Stable order required by the scoreboard: set, split, arm, at.
 *
 * @param {Record<string, unknown>} left
 * @param {Record<string, unknown>} right
 * @returns {number}
 */
function compareRows(left, right) {
  for (const field of ['set', 'split', 'arm', 'at']) {
    const a = text(left[field]);
    const b = text(right[field]);
    if (a < b) return -1;
    if (a > b) return 1;
  }
  return 0;
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

  const sorted = [...rows].sort(compareRows);
  const groups = new Map();
  for (const row of sorted) {
    if (!isPlainObject(row)) continue;
    const setName = text(row.set) || '(no set)';
    if (!groups.has(setName)) groups.set(setName, []);
    groups.get(setName).push(row);
  }

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

  for (const [setName, setRows] of groups) {
    lines.push(`## ${cell(setName)}`);
    lines.push('');
    lines.push('| split | arm | flags | n | metric | value (95% CI) | judged (code/judge/unknown/error) | tokens (prompt/completion) | cost (CNY) | commit | runId |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
    for (const row of setRows) {
      lines.push(
        `| ${cell(row.split)} | ${cell(row.arm)} | ${cell(formatFlags(row.flags))} | ${formatCount(row.n)} | ${cell(row.metric)} | ${formatValue(row)} | ${formatJudged(row.judged)} | ${formatTokens(row.tokens)} | ${formatCost(row.costCny)} | ${cell(formatCommit(row))} | ${cell(row.runId)} |`,
      );
    }
    lines.push('');
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
