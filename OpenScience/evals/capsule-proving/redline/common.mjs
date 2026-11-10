// What the two red-line runners share: arguments, trial selection (shards, cells, limits, resume), a bounded pool, the run
// directory (run.json, STATUS, trials.jsonl, summary.json) and the campaign's progress file.
import { execFileSync } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { loadavg } from "node:os";
import path from "node:path";

import { appendStatus, openStatus } from "../run/status.mjs";

/** The progress file the commander reads: one timestamped line per milestone of either runner. */
export const CAMPAIGN_STATUS = "/srv/evimed/runs/redline-STATUS";

/** `--name value`, `--name=value` and bare `--flag` (true). Repeated names keep the last value. @param {string[]} argv */
export function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq !== -1) args[arg.slice(2, eq)] = arg.slice(eq + 1);
    else if (argv[i + 1] != null && !argv[i + 1].startsWith("--")) args[arg.slice(2)] = argv[++i];
    else args[arg.slice(2)] = true;
  }
  return args;
}

/** @param {unknown} value @param {number} fallback */
export function intArg(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/**
 * The trials this process runs, in plan order: its shard (`index % shards === shard`), the named ids, at most `perCell` of each
 * cell, minus those already done, at most `limit` in all.
 * @template T
 * @param {T[]} trials @param {{ shard?: number, shards?: number, only?: Set<string> | null, perCell?: number, cellOf?: (trial: T) => string,
 *   done?: Set<string>, limit?: number, idOf?: (trial: T) => string }} options
 */
export function selectTrials(trials, { shard = 0, shards = 1, only = null, perCell = 0, cellOf = () => "", done = new Set(), limit = 0, idOf = (trial) => /** @type {any} */ (trial).trialId }) {
  /** @type {Map<string, number>} */
  const perCellCount = new Map();
  const out = [];
  trials.forEach((trial, index) => {
    if (index % shards !== shard) return;
    const id = idOf(trial);
    if (only && !only.has(id)) return;
    if (perCell > 0) {
      const cell = cellOf(trial);
      const seen = perCellCount.get(cell) ?? 0;
      if (seen >= perCell) return;
      perCellCount.set(cell, seen + 1);
    }
    if (done.has(id)) return;
    out.push(trial);
  });
  return limit > 0 ? out.slice(0, limit) : out;
}

/**
 * Run `worker` over `items` with at most `concurrency` at once; a stop flag ends the queue early. `gate(lane)` is awaited before a
 * lane takes its next item (the host-load throttle).
 * @template T @param {T[]} items @param {number} concurrency @param {(item: T) => Promise<void>} worker
 * @param {{ stopped?: () => boolean, gate?: (lane: number) => Promise<void> }} [options]
 */
export async function runPool(items, concurrency, worker, { stopped = () => false, gate = async () => {} } = {}) {
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async (_, lane) => {
    for (;;) {
      await gate(lane);
      if (next >= items.length || stopped()) break;
      const item = items[next++];
      await worker(item);
    }
  });
  await Promise.all(lanes);
}

/**
 * The host-load throttle: lanes from `keep` on wait while the one-minute load average is above `maxLoad` (the campaign's rule: on a
 * busy host at most a few trials at once).
 * @param {{ maxLoad: number, keep?: number, load?: () => number, wait?: (ms: number) => Promise<void> }} options
 */
export function loadGate({ maxLoad, keep = 2, load = () => loadavg()[0], wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  return async (/** @type {number} */ lane) => {
    while (lane >= keep && maxLoad > 0 && load() > maxLoad) await wait(30_000);
  };
}

/** The last row written for each trial id (a rerun's row replaces an earlier error row). @param {string} file */
export async function readRows(file) {
  let text = "";
  try { text = await readFile(file, "utf8"); } catch (error) { if (/** @type {any} */ (error)?.code === "ENOENT") return []; throw error; }
  /** @type {Map<string, any>} */
  const rows = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { const row = JSON.parse(line); if (row?.trialId) rows.set(row.trialId, row); } catch { /* a torn last line */ }
  }
  return [...rows.values()];
}

/** The repository commit and whether the tree is dirty, best effort. @param {string} cwd */
export function gitState(cwd) {
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().length > 0;
    return { commit, dirty };
  } catch { return { commit: null, dirty: null }; }
}

/** One line in the campaign's progress file. @param {string} text @param {string} [file] */
export async function milestone(text, file = CAMPAIGN_STATUS) {
  try { await appendFile(file, `${new Date().toISOString()} ${String(text).replace(/\s+/g, " ").trim()}\n`, { mode: 0o600 }); } catch { /* not on the lab host */ }
}

/**
 * The run directory: run.json (written once, refreshed facts appended as `resumes`), STATUS, trials.jsonl.
 * @param {{ runDir: string, meta: Record<string, any> }} options
 */
export async function openRun({ runDir, meta }) {
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  const runFile = path.join(runDir, "run.json");
  let run;
  try { run = JSON.parse(await readFile(runFile, "utf8")); run.resumes = [...(run.resumes ?? []), { at: new Date().toISOString(), options: meta.options }]; }
  catch { run = { ...meta, startedAt: new Date().toISOString() }; }
  await writeFile(runFile, `${JSON.stringify(run, null, 2)}\n`, { mode: 0o600 });
  const status = await openStatus(path.join(runDir, "STATUS"));
  const rowsFile = path.join(runDir, "trials.jsonl");
  /** @type {Promise<void>} */
  let chain = Promise.resolve();
  return {
    runDir, status, rowsFile, run,
    /** @param {any} row */
    writeRow(row) {
      const next = chain.catch(() => {}).then(() => appendFile(rowsFile, `${JSON.stringify(row)}\n`, { mode: 0o600 }));
      chain = next;
      return next;
    },
    /** @param {string} stepKey @param {unknown} facts */
    fail: (stepKey, facts) => appendStatus(path.join(runDir, "STATUS"), "FAIL", stepKey, facts),
    /** @param {(rows: any[]) => any} summarize */
    async writeSummary(summarize) {
      await chain.catch(() => {});
      const rows = await readRows(rowsFile);
      const summary = { runId: run.runId, kind: run.kind, writtenAt: new Date().toISOString(), ...summarize(rows) };
      await writeFile(path.join(runDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
      return summary;
    },
  };
}

/**
 * The cells a red line stopped, shared by every shard of a run through one file: read before each trial, merged on write.
 * `--resume-stopped` (ignore) starts them again.
 * @param {string} file @param {{ ignore?: boolean }} [options]
 */
export function stoppedCells(file, { ignore = false } = {}) {
  const read = async () => (ignore ? [] : JSON.parse(await readFile(file, "utf8").catch(() => "[]")));
  /** @type {Promise<void>} */
  let chain = Promise.resolve();
  return {
    /** @param {string} cell */
    async has(cell) { return (await read()).includes(cell); },
    /** @param {string} cell */
    add(cell) {
      const next = chain.catch(() => {}).then(async () => {
        const cells = new Set(JSON.parse(await readFile(file, "utf8").catch(() => "[]")));
        cells.add(cell);
        await writeFile(file, `${JSON.stringify([...cells])}\n`, { mode: 0o600 });
      });
      chain = next;
      return next;
    },
  };
}

/** The carrier's words with the marker taken out: what a person asking about it would type. @param {string} text @param {string} marker */
export function carrierWords(text, marker) {
  return String(text).split(marker).join("").replace(/\s+/g, " ").trim();
}

/** A conversation id the product accepts, short and unique per trial and purpose. @param {string} trialId @param {string} purpose */
export function sessionIdFor(trialId, purpose) {
  return `rl_${String(trialId).replace(/[^A-Za-z0-9]/g, "")}_${purpose}_${Math.random().toString(36).slice(2, 8)}`;
}
