/**
 * The guards a paid runner keeps, apart from any model call: the peak window, the balance floor (through `budget.py`, the one
 * place the key is read for a balance), and the campaign's cap, kept in one append-only ledger file across every arm.
 *
 * Nothing here prints a key. `budget.py` receives the key file by path; this module never reads the file.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isPeak } from '@evimed/domain';
import { fail } from './board_cases.mjs';

export const DEFAULT_FLOOR_CNY = 200;
export const DEFAULT_CAP_CNY = 3000;

/** A stop with a reason that is not a failure: the guard did its job and the run keeps what it has. */
export class GuardStop extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Is this instant inside the full-price window (weekdays 01-04 and 06-10 UTC)? @param {Date} [now] */
export const inPeakWindow = (now = new Date()) => isPeak(now);

/**
 * Ask `budget.py` for the balance. Exit 0 is fine, 2 is under the floor, 3 is unreadable; the balance is read off the one line it prints.
 * @param {{ python: string, script: string, keyFile: string, floor?: number, spawnImpl?: typeof spawn }} deps
 * @returns {() => Promise<{ code: number, balance: number | null, line: string }>}
 */
export function createBalanceChecker({ python, script, keyFile, floor = DEFAULT_FLOOR_CNY, spawnImpl = spawn }) {
  return () => new Promise((resolve) => {
    const child = spawnImpl(python, ['-I', '-B', script, '--key-file', keyFile, '--floor', String(floor)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { out += chunk; });
    child.once('error', (error) => resolve({ code: 3, balance: null, line: `budget check could not start: ${/** @type {any} */ (error)?.code ?? 'error'}` }));
    child.once('close', (code) => {
      const found = /balance CNY (-?\d+(?:\.\d+)?)/u.exec(out);
      resolve({ code: code ?? 3, balance: found ? Number(found[1]) : null, line: out.trim().split('\n').slice(0, 2).join(' ').slice(0, 200) });
    });
  });
}

/**
 * The campaign's spend, one JSON line per paid job or reconciliation, appended and never rewritten. `recorded()` is what every arm
 * together has spent; `append` takes a cost the run has already incurred.
 * @param {string} file
 */
export function createSpendLedger(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const read = () => {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  };
  return {
    file,
    /** Total CNY across every arm. */
    recorded: () => read().reduce((sum, entry) => sum + (Number(entry.costCny) || 0), 0),
    /** The job ids already in the file, so a start can find the ones a killed run never wrote. */
    jobIds: () => new Set(read().map((entry) => entry.jobId).filter(Boolean)),
    byArm: () => {
      /** @type {Record<string, number>} */
      const totals = {};
      for (const entry of read()) totals[`${entry.arm}/${entry.board}`] = (totals[`${entry.arm}/${entry.board}`] ?? 0) + (Number(entry.costCny) || 0);
      return totals;
    },
    /** @param {{ kind: 'job' | 'reconcile', arm: string, board: string, jobId: string, costCny: number, calls?: number, at?: string }} entry */
    append(entry) {
      if (!(Number.isFinite(entry.costCny) && entry.costCny >= 0)) throw fail('A spend entry carries a cost of zero or more.', 'spend_entry_invalid');
      fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry, costCny: Math.round(entry.costCny * 1e6) / 1e6 })}\n`, { mode: 0o600 });
    },
  };
}

/**
 * The checks before the first paid call. Throws a `GuardStop` with the reason; returns the balance it read.
 * @param {{ estimateCny: number, capCny: number, recordedCny: number, floor: number, allowPeak: boolean, now?: Date, balance?: (() => Promise<{ code: number, balance: number | null, line: string }>) | null }} input
 */
export async function preflight({ estimateCny, capCny, recordedCny, floor, allowPeak, now = new Date(), balance = null }) {
  if (!allowPeak && inPeakWindow(now)) throw new GuardStop('peak_window', 'It is the full-price window (weekdays 01-04 and 06-10 UTC): wait, or pass --allow-peak.');
  if (recordedCny + estimateCny > capCny) {
    throw new GuardStop('cap', `The estimate (CNY ${estimateCny.toFixed(2)}) and the recorded spend (CNY ${recordedCny.toFixed(2)}) pass the cap of CNY ${capCny.toFixed(2)}.`);
  }
  if (!balance) return null;
  const read = await balance();
  if (read.code === 2) throw new GuardStop('balance_floor', `The balance is under the floor of CNY ${floor}${read.balance == null ? '' : ` (CNY ${read.balance.toFixed(2)})`}.`);
  if (read.code !== 0) throw new GuardStop('balance_unreadable', `The balance could not be read (${read.line || `exit ${read.code}`}).`);
  return read.balance;
}

/**
 * What the run re-checks while it works: the window, the cap with what this run has spent so far, and the balance. Answers the
 * stop to make (a `GuardStop`) or null, and whether the balance could not be read this time; three unreadable answers in a row
 * are the caller's to count, because one is a network blip and a run within its cap is not stopped by it.
 * @param {{ spentThisRunCny: number, recordedBeforeCny: number, capCny: number, floor: number, allowPeak: boolean, now?: Date, balance?: (() => Promise<{ code: number, balance: number | null, line: string }>) | null }} input
 * @returns {Promise<{ stop: GuardStop | null, unreadable: boolean, balance: number | null }>}
 */
export async function watch({ spentThisRunCny, recordedBeforeCny, capCny, floor, allowPeak, now = new Date(), balance = null }) {
  if (!allowPeak && inPeakWindow(now)) return { stop: new GuardStop('peak_window', 'The full-price window began; the run stops cleanly and resumes from its ledger.'), unreadable: false, balance: null };
  if (recordedBeforeCny + spentThisRunCny >= capCny) return { stop: new GuardStop('cap', `The campaign's spend reached the cap of CNY ${capCny.toFixed(2)}.`), unreadable: false, balance: null };
  if (!balance) return { stop: null, unreadable: false, balance: null };
  const read = await balance();
  if (read.code === 2) return { stop: new GuardStop('balance_floor', `The balance fell under the floor of CNY ${floor}.`), unreadable: false, balance: read.balance };
  return { stop: null, unreadable: read.code !== 0, balance: read.balance };
}
