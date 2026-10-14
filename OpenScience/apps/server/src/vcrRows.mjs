/**
 * The rows of a generated table, as a page of a list (R3, 2026-10-14).
 *
 * The data plane has always held the virtual patients — a table of one row each — and the study's page showed one example patient
 * and no count: there were no people on the page that is called 「虚拟患者」. This module reads a result's table the way a list
 * is read: a page of rows, sorted and filtered by the server; one patient's own record; the distribution of every column; and the
 * numbers the page compares with what the study set (`vcrCalibration.mjs`). Every one of them is computed from the table by code.
 *
 * Hidden knowledge:
 *
 * - **The table is read through the same doors the download is** (`vcrRecords.locate`/`open`): a result's rows are only readable when
 *   the method that wrote them is one the control plane files as synthetic and no input was a real person's, a table made from real
 *   people travels with its leakage check, and the file must still be the bytes the result recorded. Nothing here opens a path.
 * - **The first read is a pass, the others are not.** A table up to `CACHE_CELLS` cells is held in memory (a small LRU keyed by the
 *   file's name, size and modification time), so paging, sorting and a patient's record are lookups; a longer one is streamed, which
 *   pages and filters but does not sort, and says so by name (`vcr_rows_too_large`) rather than answering a partial order.
 * - **A page is at most `PAGE_MAX` rows.** The list is a window on a table, never the table.
 * - **Identifiers and labels the engine writes per row** (`source`, `modelTier`) are the same on every row and are not columns of
 *   the page; the file a person downloads keeps them.
 *
 * @module vcrRows
 */

import { createReadStream } from "node:fs";
import fs from "node:fs/promises";

import { validatePopulationProfile } from "@evimed/domain";

/** The most rows one page may carry. */
export const VCR_ROWS_PAGE_MAX = 5_000;
/** The page a request that names no limit gets. */
export const VCR_ROWS_PAGE_DEFAULT = 100;
/** The cells (rows × columns) of a table that are kept in memory and sorted whole; a longer table is streamed. */
export const VCR_ROWS_CACHE_CELLS = 1_500_000;
/** How many tables the cache keeps. */
const CACHE_TABLES = 3;

/** Columns the engine writes on every row to say what the table is: constant, and not the person's to read. */
const LABEL_COLUMNS = new Set(["source", "modelTier"]);
/** The column that is the row's identity. */
export const VCR_ROWS_ID_COLUMN = "patientId";

/** What a column the engine knows is called to a person, and what its values say. */
const COLUMN_WORDS = Object.freeze(/** @type {Record<string, { label: string, values?: Record<string, string> }>} */ ({
  patientId: { label: "编号" },
  arm: { label: "分组", values: { 1: "试验", 0: "对照" } },
  time: { label: "时间" },
  status: { label: "结局事件", values: { 1: "发生事件", 0: "删失" } },
  entry: { label: "入组时间" },
  y: { label: "结局" },
  x: { label: "基线协变量" },
  visit: { label: "访视" },
}));

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// --- reading a CSV, as a stream -----------------------------------------------------------------------------------------

/**
 * The rows of a CSV file, one at a time, as arrays of strings — RFC 4180: a cell may be quoted, a quote inside one is doubled, a
 * newline inside one is the cell's own. A byte-order mark is dropped. The first row is the header; a blank line is not a row.
 * @param {string} file
 * @returns {AsyncGenerator<string[]>}
 */
export async function* readCsvRows(file) {
  const stream = createReadStream(file, { encoding: "utf8", highWaterMark: 1 << 20 });
  /** @type {string[]} */
  let row = [];
  let cell = "";
  let inQuotes = false;
  /** Whether the last character inside quotes was a quote: the end of the cell, or the first half of a doubled one. */
  let afterQuote = false;
  let first = true;
  for await (const chunk of stream) {
    const text = first ? String(chunk).replace(/^\uFEFF/, "") : String(chunk);
    first = false;
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      if (inQuotes) {
        if (afterQuote) {
          if (character === '"') { cell += '"'; afterQuote = false; continue; }
          // The quote before this character closed the cell: this one is read as the character after a cell.
          inQuotes = false;
          afterQuote = false;
        } else if (character === '"') { afterQuote = true; continue; } else { cell += character; continue; }
      }
      if (character === '"' && cell === "") { inQuotes = true; continue; }
      if (character === ",") { row.push(cell); cell = ""; continue; }
      if (character === "\r") continue;
      if (character === "\n") {
        row.push(cell);
        cell = "";
        if (row.length > 1 || row[0] !== "") yield row;
        row = [];
        continue;
      }
      cell += character;
    }
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    if (row.length > 1 || row[0] !== "") yield row;
  }
}

// --- a table held in memory -------------------------------------------------------------------------------------------

/**
 * @typedef {{ key: string, index: number, kind: "number" | "text", missing: number }} VcrRowColumn
 * @typedef {{ header: string[], rows: string[][], columns: VcrRowColumn[], complete: true }
 *   | { header: string[], rows: string[][], columns: VcrRowColumn[], complete: false }} VcrRowTable
 *   `complete: false` is a table longer than the cache holds: its rows are the first ones, read for a profile and never for an order.
 */

/** @type {Map<string, VcrRowTable>} */
const cache = new Map();

/** @param {string} value */
const isMissingCell = (value) => value === "" || value === "NA";

/**
 * The kind of every column: a number when every cell that has one is a finite number, text otherwise.
 * @param {string[]} header @param {readonly string[][]} rows @returns {VcrRowColumn[]}
 */
function columnsOf(header, rows) {
  return header.map((key, index) => {
    let numeric = true;
    let missing = 0;
    for (const row of rows) {
      const cell = row[index] ?? "";
      if (isMissingCell(cell)) { missing += 1; continue; }
      if (numeric && !Number.isFinite(Number(cell))) numeric = false;
    }
    return { key, index, kind: numeric && missing < rows.length ? "number" : "text", missing };
  });
}

/**
 * A table's rows, from the cache or one pass over the file.
 * @param {string} file @param {{ maxCells?: number }} [options]
 * @returns {Promise<VcrRowTable>}
 */
export async function loadRowTable(file, { maxCells = VCR_ROWS_CACHE_CELLS } = {}) {
  const stat = await fs.stat(file);
  const key = `${file}\u0000${stat.size}\u0000${stat.mtimeMs}\u0000${maxCells}`;
  const held = cache.get(key);
  if (held) {
    cache.delete(key);
    cache.set(key, held);
    return held;
  }
  /** @type {string[]} */
  let header = [];
  /** @type {string[][]} */
  const rows = [];
  let complete = true;
  for await (const row of readCsvRows(file)) {
    if (!header.length) { header = row.map((name) => name.trim()); continue; }
    if ((rows.length + 1) * Math.max(1, header.length) > maxCells) { complete = false; break; }
    rows.push(row);
  }
  const table = /** @type {VcrRowTable} */ ({ header, rows, columns: columnsOf(header, rows), complete });
  if (complete) {
    cache.set(key, table);
    while (cache.size > CACHE_TABLES) cache.delete(/** @type {string} */ (cache.keys().next().value));
  }
  return table;
}

/** Forget every held table: a test's, and a restore's. */
export function clearRowTableCache() { cache.clear(); }

// --- a page ---------------------------------------------------------------------------------------------------------------

/**
 * @typedef {{ offset?: number, limit?: number, sort?: string | null, arm?: string | null, filters?: Record<string, string> }} VcrRowsQuery
 * @typedef {{ error: string, column?: string }} VcrRowsQueryIssue
 */

/** @param {string} text @returns {string | null} the column of a `sort` value (`age`, `-age`), or null when it names none */
function sortColumn(text) {
  return String(text).replace(/^-/, "") || null;
}

/**
 * What a filter says of one column, as a predicate over the column's cell. A number column takes `a..b` (either end may be left
 * out) or one number; a text column a comma-separated list of values. A filter that cannot be read is refused by name.
 * @param {VcrRowColumn} column @param {string} text
 * @returns {((cell: string) => boolean) | null} null when the filter is not one this column can take
 */
function predicateOf(column, text) {
  if (column.kind === "number") {
    const range = /^\s*(-?\d+(?:\.\d+)?)?\s*\.\.\s*(-?\d+(?:\.\d+)?)?\s*$/.exec(text);
    if (range && (range[1] !== undefined || range[2] !== undefined)) {
      const low = range[1] === undefined ? -Infinity : Number(range[1]);
      const high = range[2] === undefined ? Infinity : Number(range[2]);
      return (cell) => !isMissingCell(cell) && Number(cell) >= low && Number(cell) <= high;
    }
    const one = Number(text);
    if (text.trim() !== "" && Number.isFinite(one)) return (cell) => !isMissingCell(cell) && Number(cell) === one;
    return null;
  }
  const wanted = new Set(text.split(",").map((value) => value.trim()).filter(Boolean));
  return wanted.size ? (cell) => wanted.has(cell) : null;
}

/**
 * The cell of a row as the page shows it: a number for a number column, the text otherwise, `null` for a missing cell.
 * @param {VcrRowColumn} column @param {string[]} row @returns {string | number | null}
 */
function cellOf(column, row) {
  const cell = row[column.index] ?? "";
  if (isMissingCell(cell)) return null;
  return column.kind === "number" ? Number(cell) : cell;
}

/**
 * The columns a page offers and what each is called.
 * @param {VcrRowTable} table
 */
export function pageColumns(table) {
  return table.columns.filter((column) => !LABEL_COLUMNS.has(column.key)).map((column) => {
    const words = COLUMN_WORDS[column.key];
    return {
      key: column.key,
      label: words?.label ?? null,
      kind: column.key === VCR_ROWS_ID_COLUMN ? "id" : column.kind,
      ...(words?.values ? { values: words.values } : {}),
    };
  });
}

/**
 * One page of a table: the rows that pass the filters, in the order asked, from `offset`, at most `limit` of them.
 *
 * @param {VcrRowTable} table @param {VcrRowsQuery} query
 * @returns {{ ok: true, columns: ReturnType<typeof pageColumns>, rows: Array<Record<string, string | number | null>>, total: number, all: number,
 *   offset: number, limit: number, sort: { column: string, descending: boolean } | null, arms: Array<{ value: string, label: string, n: number }> }
 *   | { ok: false, issue: VcrRowsQueryIssue }}
 */
export function pageOfTable(table, query) {
  const shown = table.columns.filter((column) => !LABEL_COLUMNS.has(column.key));
  const byKey = new Map(table.columns.map((column) => [column.key, column]));
  const limit = Math.max(1, Math.min(VCR_ROWS_PAGE_MAX, Math.trunc(Number(query.limit ?? VCR_ROWS_PAGE_DEFAULT)) || VCR_ROWS_PAGE_DEFAULT));
  const offset = Math.max(0, Math.trunc(Number(query.offset ?? 0)) || 0);
  /** @type {Array<[VcrRowColumn, (cell: string) => boolean]>} */
  const tests = [];
  /** @type {Record<string, string>} */
  const filters = { ...(query.filters ?? {}) };
  if (query.arm !== undefined && query.arm !== null && query.arm !== "") {
    const word = String(query.arm).trim();
    filters.arm = ({ treatment: "1", control: "0", 试验: "1", 对照: "0" }[/** @type {"treatment"} */ (word)] ?? word);
  }
  for (const [name, text] of Object.entries(filters)) {
    const column = byKey.get(name);
    const predicate = column ? predicateOf(column, String(text)) : null;
    if (!column || !predicate) return { ok: false, issue: { error: "filter", column: name } };
    tests.push([column, predicate]);
  }
  const sortKey = query.sort ? sortColumn(query.sort) : null;
  const sorter = sortKey ? byKey.get(sortKey) ?? null : null;
  if (sortKey && !sorter) return { ok: false, issue: { error: "sort", column: sortKey } };

  /** @type {number[]} */
  const matching = [];
  for (let index = 0; index < table.rows.length; index += 1) {
    const row = table.rows[index];
    if (tests.every(([column, predicate]) => predicate(row[column.index] ?? ""))) matching.push(index);
  }
  if (sorter) {
    const descending = String(query.sort).startsWith("-");
    const direction = descending ? -1 : 1;
    matching.sort((a, b) => {
      const left = table.rows[a][sorter.index] ?? "";
      const right = table.rows[b][sorter.index] ?? "";
      // Missing last, whichever way the order goes; ties keep the table's own order.
      if (isMissingCell(left) || isMissingCell(right)) return isMissingCell(left) === isMissingCell(right) ? a - b : isMissingCell(left) ? 1 : -1;
      const order = sorter.kind === "number" ? Number(left) - Number(right) : left < right ? -1 : left > right ? 1 : 0;
      return order === 0 ? a - b : order * direction;
    });
  }
  const armColumn = byKey.get("arm");
  /** @type {Map<string, number>} */
  const armCounts = new Map();
  if (armColumn) for (const row of table.rows) armCounts.set(row[armColumn.index] ?? "", (armCounts.get(row[armColumn.index] ?? "") ?? 0) + 1);
  return {
    ok: true,
    columns: pageColumns(table),
    rows: matching.slice(offset, offset + limit).map((index) => {
      const row = table.rows[index];
      return Object.fromEntries(shown.map((column) => [column.key, cellOf(column, row)]));
    }),
    total: matching.length,
    all: table.rows.length,
    offset,
    limit,
    sort: sorter ? { column: sorter.key, descending: String(query.sort).startsWith("-") } : null,
    arms: ["1", "0"].filter((value) => armCounts.has(value)).map((value) => ({ value, label: COLUMN_WORDS.arm.values?.[value] ?? value, n: armCounts.get(value) ?? 0 })),
  };
}

/**
 * One page of a table that is longer than the cache: streamed, filtered and counted, in the table's own order. A sort is refused by
 * name, not answered with the first rows in some order.
 * @param {string} file @param {VcrRowsQuery} query
 * @returns {Promise<ReturnType<typeof pageOfTable>>}
 */
export async function pageOfFile(file, query) {
  if (query.sort) return { ok: false, issue: { error: "too_large", column: String(query.sort) } };
  /** @type {string[]} */
  let header = [];
  /** @type {VcrRowColumn[]} */
  let columns = [];
  /** @type {Array<[VcrRowColumn, (cell: string) => boolean]>} */
  const tests = [];
  /** @type {string[][]} */
  const kept = [];
  const limit = Math.max(1, Math.min(VCR_ROWS_PAGE_MAX, Math.trunc(Number(query.limit ?? VCR_ROWS_PAGE_DEFAULT)) || VCR_ROWS_PAGE_DEFAULT));
  const offset = Math.max(0, Math.trunc(Number(query.offset ?? 0)) || 0);
  let total = 0;
  let all = 0;
  /** @type {Record<string, string>} */
  const filters = { ...(query.filters ?? {}) };
  if (query.arm) filters.arm = ({ treatment: "1", control: "0", 试验: "1", 对照: "0" }[/** @type {"treatment"} */ (String(query.arm))] ?? String(query.arm));
  for await (const row of readCsvRows(file)) {
    if (!header.length) {
      header = row.map((name) => name.trim());
      // The kind of a column of a table too long to hold: read from the first rows, which is what its page can say.
      columns = header.map((key, index) => ({ key, index, kind: "text", missing: 0 }));
      continue;
    }
    if (all === 0) {
      columns = columns.map((column) => ({ ...column, kind: isMissingCell(row[column.index] ?? "") || Number.isFinite(Number(row[column.index])) ? "number" : "text" }));
      for (const [name, text] of Object.entries(filters)) {
        const column = columns.find((entry) => entry.key === name);
        const predicate = column ? predicateOf(column, String(text)) : null;
        if (!column || !predicate) return { ok: false, issue: { error: "filter", column: name } };
        tests.push([column, predicate]);
      }
    }
    all += 1;
    if (!tests.every(([column, predicate]) => predicate(row[column.index] ?? ""))) continue;
    if (total >= offset && kept.length < limit) kept.push(row);
    total += 1;
  }
  const table = /** @type {VcrRowTable} */ ({ header, rows: kept, columns, complete: false });
  const shown = columns.filter((column) => !LABEL_COLUMNS.has(column.key));
  return {
    ok: true,
    columns: pageColumns(table),
    rows: kept.map((row) => Object.fromEntries(shown.map((column) => [column.key, cellOf(column, row)]))),
    total, all, offset, limit, sort: null, arms: [],
  };
}

// --- one patient --------------------------------------------------------------------------------------------------------------

/** The columns that say what happened to a patient, as opposed to who they are at baseline. */
const OUTCOME_COLUMNS = new Set(["time", "status", "y", "visit", "entry"]);

/**
 * Kaplan–Meier of one set of times and events: the curve's steps and the time at which the survival first reaches one half.
 * @param {ReadonlyArray<{ time: number, event: boolean }>} subjects
 * @returns {{ steps: Array<{ time: number, survival: number, atRisk: number }>, median: number | null }}
 */
export function kaplanMeier(subjects) {
  const sorted = [...subjects].sort((a, b) => a.time - b.time || Number(b.event) - Number(a.event));
  let atRisk = sorted.length;
  let survival = 1;
  /** @type {Array<{ time: number, survival: number, atRisk: number }>} */
  const steps = [];
  let median = null;
  for (let index = 0; index < sorted.length;) {
    const time = sorted[index].time;
    let events = 0;
    let leaving = 0;
    while (index < sorted.length && sorted[index].time === time) { if (sorted[index].event) events += 1; leaving += 1; index += 1; }
    if (events > 0 && atRisk > 0) {
      survival *= 1 - events / atRisk;
      steps.push({ time, survival, atRisk });
      if (median === null && survival <= 0.5) median = time;
    }
    atRisk -= leaving;
  }
  return { steps, median };
}

/** The survival of a Kaplan–Meier curve at a time (the curve's last step at or before it; 1 before the first). @param {ReturnType<typeof kaplanMeier>["steps"]} steps @param {number} time */
function survivalAt(steps, time) {
  let value = 1;
  for (const step of steps) { if (step.time <= time) value = step.survival; else break; }
  return value;
}

/**
 * A patient's own record: who they are at baseline, what happened to them, where they stand among their arm, and — only when the
 * table holds an outcome for each assumption — both trajectories.
 *
 * @param {VcrRowTable} table @param {string} patientId
 * @returns {Record<string, any> | null} null when the table holds no such patient
 */
export function patientRecord(table, patientId) {
  const idColumn = table.columns.find((column) => column.key === VCR_ROWS_ID_COLUMN);
  if (!idColumn) return null;
  const row = table.rows.find((candidate) => candidate[idColumn.index] === patientId);
  if (!row) return null;
  const word = (/** @type {string} */ key, /** @type {unknown} */ value) => {
    const map = COLUMN_WORDS[key]?.values;
    return map && value !== null && value !== undefined ? map[String(value)] ?? null : null;
  };
  const armColumn = table.columns.find((column) => column.key === "arm");
  const arm = armColumn ? String(row[armColumn.index] ?? "") : null;
  /** @type {Array<{ key: string, label: string | null, value: string | number | null, text?: string }>} */
  const baseline = [];
  /** @type {Array<{ key: string, label: string | null, value: string | number | null, text?: string }>} */
  const outcome = [];
  for (const column of table.columns) {
    if (LABEL_COLUMNS.has(column.key) || column.key === VCR_ROWS_ID_COLUMN || column.key === "arm") continue;
    const value = cellOf(column, row);
    const text = word(column.key, value);
    const entry = { key: column.key, label: COLUMN_WORDS[column.key]?.label ?? null, value, ...(text ? { text } : {}) };
    (OUTCOME_COLUMNS.has(column.key) ? outcome : baseline).push(entry);
  }
  const get = (/** @type {string} */ key) => {
    const column = table.columns.find((candidate) => candidate.key === key);
    return column ? cellOf(column, row) : null;
  };
  const inArm = (/** @type {string[]} */ other) => !armColumn || other[armColumn.index] === arm;
  /** @type {Record<string, any> | null} */
  let position = null;
  const timeColumn = table.columns.find((column) => column.key === "time");
  const statusColumn = table.columns.find((column) => column.key === "status");
  const yColumn = table.columns.find((column) => column.key === "y");
  if (timeColumn && statusColumn && table.columns.every((column) => column.key !== "visit")) {
    const subjects = table.rows.filter(inArm).map((other) => ({ time: Number(other[timeColumn.index]), event: other[statusColumn.index] === "1" }))
      .filter((entry) => Number.isFinite(entry.time));
    const curve = kaplanMeier(subjects);
    const time = Number(get("time"));
    position = {
      kind: "time_to_event", arm, time, event: get("status") === 1,
      survival: Number.isFinite(time) ? Math.round(survivalAt(curve.steps, time) * 1e4) / 1e4 : null,
      stillFollowed: subjects.filter((entry) => entry.time > time).length, armSize: subjects.length, armMedian: curve.median,
    };
  } else if (yColumn && table.columns.every((column) => column.key !== "visit")) {
    const values = table.rows.filter(inArm).map((other) => Number(other[yColumn.index])).filter(Number.isFinite);
    const value = Number(get("y"));
    const below = values.filter((entry) => entry < value).length + values.filter((entry) => entry === value).length / 2;
    const binary = values.every((entry) => entry === 0 || entry === 1);
    position = binary
      ? { kind: "binary", arm, value, armRate: values.length ? values.reduce((sum, entry) => sum + entry, 0) / values.length : null, armSize: values.length }
      : { kind: "continuous", arm, value, percentile: values.length ? Math.round((below / values.length) * 1e4) / 1e4 : null,
        armMean: values.length ? values.reduce((sum, entry) => sum + entry, 0) / values.length : null, armSize: values.length };
  }
  // Both assumptions' trajectories, only where the engine left both outcomes in the table: `y0`/`y1`, `time0`/`time1`.
  /** @type {Array<{ arm: string, label: string, values: Record<string, string | number | null> }> | null} */
  let trajectories = null;
  const pairs = ["y", "time", "status"].map((base) => {
    const names = [[`${base}0`, `${base}1`], [`${base}_0`, `${base}_1`]].find(([zero, one]) => table.columns.some((c) => c.key === zero) && table.columns.some((c) => c.key === one));
    return names ? { base, zero: names[0], one: names[1] } : null;
  }).filter((entry) => entry !== null);
  if (pairs.length) {
    trajectories = ["0", "1"].map((which) => ({
      arm: which, label: COLUMN_WORDS.arm.values?.[which] ?? which,
      values: Object.fromEntries(pairs.map((pair) => [/** @type {NonNullable<typeof pair>} */ (pair).base, get(which === "0" ? /** @type {NonNullable<typeof pair>} */ (pair).zero : /** @type {NonNullable<typeof pair>} */ (pair).one)])),
    }));
  }
  return {
    id: patientId,
    arm: arm === null ? null : { value: arm, label: COLUMN_WORDS.arm.values?.[arm] ?? arm },
    baseline, outcome, position, trajectories,
  };
}

// --- the distribution of every column ----------------------------------------------------------------------------------

/** A number to four significant digits, once (the engine's own rounding). @param {number} value */
const sig4 = (value) => (Number.isFinite(value) && value !== 0 ? Number(value.toPrecision(4)) : value);

/**
 * R's default quantile (type 7) of a sorted array.
 * @param {readonly number[]} sorted @param {number} p
 */
function quantile(sorted, p) {
  if (!sorted.length) return NaN;
  const position = (sorted.length - 1) * p;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

/**
 * What every column of a generated table looks like, in the shape the engine writes for its own populations
 * (`diagnostics.profile`, `validatePopulationProfile`): one entry per variable, in column order — the number of rows, how many are
 * missing, the summary and a seven-bin histogram of a number, the levels and their shares of a binary or categorical variable. The
 * identity column and the constant labels are not variables; a text column with more than twenty levels is an identifier and is
 * left out. Nothing is declared: `declared` is the scenario's to state, and is null here.
 *
 * A column that holds one value on every row says nothing about the people and is not described.
 *
 * @param {VcrRowTable} table @param {{ labels?: Record<string, string> }} [options] `labels`: what the study calls a variable
 * @returns {Array<Record<string, any>>} entries that pass the contract; one that does not is dropped
 */
export function profileOfTable(table, { labels = {} } = {}) {
  /** @type {Array<Record<string, any>>} */
  const entries = [];
  const n = table.rows.length;
  for (const column of table.columns) {
    if (LABEL_COLUMNS.has(column.key) || column.key === VCR_ROWS_ID_COLUMN) continue;
    const cells = table.rows.map((row) => row[column.index] ?? "");
    const present = cells.filter((cell) => !isMissingCell(cell));
    if (new Set(present).size < 2) continue;
    const label = labels[column.key] ?? COLUMN_WORDS[column.key]?.label ?? null;
    const base = { variable: column.key, label, declared: null, n, missing: n - present.length };
    if (column.kind === "number") {
      const values = present.map(Number);
      const distinct = new Set(values);
      if (column.key !== "arm" && column.key !== "status" && (distinct.size > 2 || [...distinct].some((value) => value !== 0 && value !== 1))) {
        const sorted = [...values].sort((a, b) => a - b);
        const min = sorted[0];
        const max = sorted[sorted.length - 1];
        const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
        const variance = values.length > 1 ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1) : 0;
        const bins = 7;
        const span = max > min ? max - min : 1;
        const origin = max > min ? min : min - 0.5;
        const breaks = Array.from({ length: bins + 1 }, (_unused, i) => sig4(origin + (span * i) / bins));
        /** @type {number[]} */
        const counts = Array(bins).fill(0);
        for (const value of values) counts[Math.min(bins - 1, Math.max(0, Math.floor(((value - origin) / span) * bins)))] += 1;
        // The edges are rounded, so equal neighbours (a very narrow range) collapse: such a column is a single value.
        const strict = breaks.every((edge, i) => i === 0 || edge > breaks[i - 1]);
        entries.push({
          ...base, kind: "continuous", mean: sig4(mean), sd: sig4(Math.sqrt(variance)), median: sig4(quantile(sorted, 0.5)),
          q1: sig4(quantile(sorted, 0.25)), q3: sig4(quantile(sorted, 0.75)), min: sig4(min), max: sig4(max),
          histogram: strict ? { breaks, counts } : { breaks: [sig4(min) - 0.5, sig4(min) - 0.25, sig4(min), sig4(min) + 0.25, sig4(min) + 0.5, sig4(min) + 0.75, sig4(min) + 1, sig4(min) + 1.25], counts: [0, 0, values.length, 0, 0, 0, 0] },
        });
        continue;
      }
    }
    const tally = new Map();
    for (const cell of present) tally.set(cell, (tally.get(cell) ?? 0) + 1);
    if (tally.size > 20) continue;
    const kind = column.key === "arm" || tally.size > 2 || column.kind === "text" ? "categorical" : "binary";
    entries.push({
      ...base, kind,
      levels: [...tally.entries()].sort((a, b) => (column.kind === "number" ? Number(a[0]) - Number(b[0]) : a[0] < b[0] ? -1 : 1))
        .map(([level, count]) => ({ level, n: count, p: present.length ? count / present.length : null })),
    });
  }
  return validatePopulationProfile(entries).length ? entries.filter((entry) => !validatePopulationProfile([entry]).length) : entries;
}

/**
 * The numbers of a table that is read as a trial's outcomes: per arm, the people, the events and the Kaplan–Meier median of a
 * time-to-event table; the mean and spread of a continuous outcome; the rate of a binary one — plus the log hazard ratio of the
 * treated arm against the control (Cox's partial likelihood, one binary covariate, Newton's method). `null` for a table that is
 * not a two-arm outcome table. What `vcrCalibration` sets beside what the study declared.
 *
 * @param {VcrRowTable} table
 */
export function outcomeStatistics(table) {
  const column = (/** @type {string} */ key) => table.columns.find((candidate) => candidate.key === key) ?? null;
  const arm = column("arm");
  if (!arm || column("visit")) return null;
  const rows = table.rows.filter((row) => row[arm.index] === "0" || row[arm.index] === "1");
  if (!rows.length) return null;
  const time = column("time");
  const status = column("status");
  const y = column("y");
  const byArm = (/** @type {"0" | "1"} */ which) => rows.filter((row) => row[arm.index] === which);
  if (time && status) {
    const subjects = (/** @type {string[][]} */ list) => list.map((row) => ({ time: Number(row[time.index]), event: row[status.index] === "1" })).filter((entry) => Number.isFinite(entry.time));
    const control = subjects(byArm("0"));
    const treated = subjects(byArm("1"));
    const describe = (/** @type {typeof control} */ list) => {
      const curve = kaplanMeier(list);
      const events = list.filter((entry) => entry.event).length;
      return { n: list.length, events, rate: list.length ? events / list.length : null, median: curve.median };
    };
    return { endpoint: "time_to_event", control: describe(control), treated: describe(treated), hazardRatio: control.length && treated.length ? coxHazardRatio(control, treated) : null };
  }
  if (y) {
    const values = (/** @type {string[][]} */ list) => list.map((row) => Number(row[y.index])).filter(Number.isFinite);
    const control = values(byArm("0"));
    const treated = values(byArm("1"));
    const binary = [...control, ...treated].every((value) => value === 0 || value === 1);
    const mean = (/** @type {number[]} */ list) => (list.length ? list.reduce((sum, value) => sum + value, 0) / list.length : null);
    const sd = (/** @type {number[]} */ list) => {
      const m = mean(list);
      return m === null || list.length < 2 ? null : Math.sqrt(list.reduce((sum, value) => sum + (value - m) ** 2, 0) / (list.length - 1));
    };
    if (binary) return { endpoint: "binary", control: { n: control.length, rate: mean(control) }, treated: { n: treated.length, rate: mean(treated) } };
    const pooled = control.length > 1 && treated.length > 1
      ? Math.sqrt((((control.length - 1) * (sd(control) ?? 0) ** 2) + ((treated.length - 1) * (sd(treated) ?? 0) ** 2)) / (control.length + treated.length - 2)) : null;
    return { endpoint: "continuous", control: { n: control.length, mean: mean(control), sd: sd(control) },
      treated: { n: treated.length, mean: mean(treated), sd: sd(treated) }, difference: mean(control) !== null && mean(treated) !== null ? /** @type {number} */ (mean(treated)) - /** @type {number} */ (mean(control)) : null, pooledSd: pooled };
  }
  return null;
}

/**
 * The hazard ratio of the treated arm against the control: Cox's partial likelihood with one binary covariate (Breslow's ties), by
 * Newton's method from zero. The score at a death time is the treated deaths less what the risk set expects of them; the
 * information is what the two arms' risk sets leave of it.
 * @param {ReadonlyArray<{ time: number, event: boolean }>} control @param {ReadonlyArray<{ time: number, event: boolean }>} treated
 * @returns {{ value: number, low: number | null, high: number | null } | null}
 */
export function coxHazardRatio(control, treated) {
  /** @type {Array<{ time: number, treated: boolean, event: boolean }>} */
  const all = [...control.map((entry) => ({ ...entry, treated: false })), ...treated.map((entry) => ({ ...entry, treated: true }))].sort((a, b) => a.time - b.time);
  if (!all.some((entry) => entry.event && entry.treated) || !all.some((entry) => entry.event && !entry.treated)) return null;
  /** Distinct death times with the treated deaths, all deaths and the risk sets at each. */
  /** @type {Array<{ deaths: number, treatedDeaths: number, riskTreated: number, riskControl: number }>} */
  const times = [];
  let riskTreated = all.filter((entry) => entry.treated).length;
  let riskControl = all.length - riskTreated;
  for (let index = 0; index < all.length;) {
    const time = all[index].time;
    let deaths = 0;
    let treatedDeaths = 0;
    let leavingTreated = 0;
    let leavingControl = 0;
    while (index < all.length && all[index].time === time) {
      const entry = all[index];
      if (entry.treated) leavingTreated += 1; else leavingControl += 1;
      if (entry.event) { deaths += 1; if (entry.treated) treatedDeaths += 1; }
      index += 1;
    }
    if (deaths > 0) times.push({ deaths, treatedDeaths, riskTreated, riskControl });
    riskTreated -= leavingTreated;
    riskControl -= leavingControl;
  }
  let beta = 0;
  let information = 0;
  for (let iteration = 0; iteration < 30; iteration += 1) {
    let score = 0;
    information = 0;
    const factor = Math.exp(beta);
    for (const point of times) {
      const denominator = point.riskControl + point.riskTreated * factor;
      if (denominator <= 0) continue;
      const share = (point.riskTreated * factor) / denominator;
      score += point.treatedDeaths - point.deaths * share;
      information += point.deaths * share * (1 - share);
    }
    if (!(information > 0)) return null;
    const step = score / information;
    beta += Math.max(-5, Math.min(5, step));
    if (Math.abs(step) < 1e-8) break;
  }
  const se = 1 / Math.sqrt(information);
  return { value: Math.exp(beta), low: Math.exp(beta - 1.959964 * se), high: Math.exp(beta + 1.959964 * se) };
}

/** Whether a value is a plain query record. @param {unknown} value */
export const isQueryRecord = (value) => isObject(value);
