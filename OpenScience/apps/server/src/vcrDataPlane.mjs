/**
 * 「虚拟临研」's data plane: registering a source, freezing it into a hashed
 * snapshot with a quality profile, mapping its columns, deriving the three
 * ADaM-shaped analysis tables, sealing fields, and suppressing small cells in
 * anything handed to a model (build plan 2026-09-28 §8.1, AC-03/06/22/26/32).
 *
 * Hidden knowledge:
 *
 * - **The data-plane directory is never mounted into a runtime, and this file
 *   is where that stops being a promise.** Today the knowledge base is mounted
 *   read-only at `/workspace/knowledge-base` and the kernel has `bash`
 *   (inventory E §2.5), so a patient-level file placed anywhere under a
 *   project workspace is readable by the model within one tool call. So
 *   `assertDataPlaneLocation` refuses a location whose resolved path is not
 *   under `config.vcrDataPlaneDir`, and refuses the directory itself if it
 *   sits under a workspace root or carries a `knowledge-base` segment. A
 *   comment saying "do not mount this" would have been the fourth such
 *   convention in the inventory's list of four, all of which were conventions.
 * - **The control plane may read the bytes; the model may not.** Hashing and
 *   validating an analysis table means parsing it here, in the tenant
 *   boundary, in memory, discarded when the call returns. Nothing parsed is
 *   written into `evimed_vcr`, into a run's workspace, or into a reply.
 * - **Small-cell suppression suppresses more than the small cell.** Hiding
 *   exactly one cell below the floor reproduces it from the total, and hiding
 *   its count while keeping its mean reproduces the people. So the walker
 *   absorbs further cells (smallest first) until the merged bucket is itself
 *   at or above the floor, and a suppressed cell keeps its key and loses every
 *   number it carried. A zero cell is suppressed too: the complement of a
 *   published zero in a published total is an exact count of somebody.
 * - **A bad analysis table is refused, not registered with a warning.** This
 *   is not a delivery gate (principle 4's budget is untouched) — it is input
 *   validity at the operation that needs it (principle 14). A table whose CNSR
 *   is not a censoring indicator is not a censoring table, and an engine that
 *   accepts it computes a survival curve out of something else. The refusal
 *   names each defect and the audit row records it, so the failure is
 *   traceable rather than silent (principle 19); only that one table is
 *   refused, never the study.
 * - **`visible_at <= asOf`, and the three clocks are not interchangeable.** A
 *   historical replay reads what the platform could see then, not what
 *   happened then: a lab drawn on the 1st, entered on the 5th and shared with
 *   us on the 12th is invisible to a replay dated the 8th, and filtering on
 *   the event date instead is exactly the leak AC-15 exists to catch.
 * - **Unknown treatment is not absent treatment.** A blank in a column whose
 *   missing reason is `not_shared` or `restricted_in_trial` is a question the
 *   data cannot answer; `treatmentEvidence` returns `unknown` for it and never
 *   `none`. The partner's data is precisely this case (plan §3.2).
 *
 * @module vcrDataPlane
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  RUNTIME_WORKSPACE_ROOT, VCR_ANALYSIS_TABLES, VCR_MIN_CELL_SIZE, VCR_QUALITY_CATEGORIES, workspaceLayout,
} from "@evimed/domain";

import { HttpError } from "./security.mjs";

/** Every way the data plane refuses, by name. A refusal with no name is one nobody can act on. */
export const VCR_DATA_PLANE_CODES = Object.freeze({
  notConfigured: "vcr_data_plane_not_configured",
  locationOutside: "vcr_data_plane_location_outside",
  locationRuntimeReadable: "vcr_data_plane_location_runtime_readable",
  locationMissing: "vcr_data_plane_location_missing",
  snapshotNotFound: "vcr_snapshot_not_found",
  sourceNotFound: "vcr_source_not_found",
  analysisTableInvalid: "vcr_analysis_table_invalid",
  profilerFailed: "vcr_snapshot_profile_failed",
});

/**
 * Path segments that mean "a runtime can read this". `/workspace` is the
 * container's mount root and `knowledge-base` is the read-only knowledge mount
 * under it; a data-plane directory under either is a data plane in name only.
 */
const RUNTIME_READABLE_SEGMENTS = Object.freeze([
  "workspace", workspaceLayout.knowledgeDir, "knowledge-base",
]);

/** The profiler that computes a snapshot's quality profile. */
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const VCR_PROFILER_SCRIPT = path.resolve(HERE, "../../../scripts/vcr/profile_snapshot.py");

/** @param {number} value */
const round4 = (value) => Math.round(value * 10_000) / 10_000;

/** @param {number} status @param {string} code @param {string} message @param {Record<string, any>} [detail] */
function refuse(status, code, message, detail = {}) {
  const error = new HttpError(status, code, message);
  /** @type {any} */ (error).vcrDetail = detail;
  return error;
}

// ---------------------------------------------------------------------------
// Where patient-level bytes may live
// ---------------------------------------------------------------------------

/**
 * The data plane's root, checked once. Throws when it is unset, relative, or
 * somewhere a runtime can read.
 * @param {string} dir the configured `vcrDataPlaneDir`
 */
export function assertDataPlaneRoot(dir) {
  const root = String(dir ?? "").trim();
  if (!root) {
    throw refuse(503, VCR_DATA_PLANE_CODES.notConfigured,
      "The data plane directory is not configured; patient-level data cannot be accepted.");
  }
  if (!path.isAbsolute(root)) {
    throw refuse(500, VCR_DATA_PLANE_CODES.locationOutside,
      `The data plane directory must be an absolute path, got ${JSON.stringify(root)}.`);
  }
  const resolved = path.resolve(root);
  if (resolved === RUNTIME_WORKSPACE_ROOT || resolved.startsWith(`${RUNTIME_WORKSPACE_ROOT}${path.sep}`)) {
    throw refuse(500, VCR_DATA_PLANE_CODES.locationRuntimeReadable,
      `The data plane directory cannot be under ${RUNTIME_WORKSPACE_ROOT}: a runtime mounts that path.`,
      { segment: "workspace" });
  }
  const segments = resolved.split(path.sep).filter(Boolean);
  const offending = segments.find((segment) => RUNTIME_READABLE_SEGMENTS.includes(segment));
  if (offending) {
    throw refuse(500, VCR_DATA_PLANE_CODES.locationRuntimeReadable,
      `The data plane directory cannot contain a ${JSON.stringify(offending)} segment: a runtime mounts those paths.`,
      { segment: offending });
  }
  return resolved;
}

/**
 * A file's absolute path inside the data plane, or a named refusal.
 * @param {string} dir @param {string} location
 */
export function assertDataPlaneLocation(dir, location) {
  const root = assertDataPlaneRoot(dir);
  const candidate = String(location ?? "").trim();
  if (!candidate) {
    throw refuse(400, VCR_DATA_PLANE_CODES.locationOutside, "A snapshot location is required.");
  }
  const resolved = path.resolve(root, candidate);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw refuse(400, VCR_DATA_PLANE_CODES.locationOutside,
      "A snapshot location must be inside the data plane directory.", { location: candidate });
  }
  const relativeSegments = path.relative(root, resolved).split(path.sep).filter(Boolean);
  const offending = relativeSegments.find((segment) => RUNTIME_READABLE_SEGMENTS.includes(segment));
  if (offending) {
    throw refuse(400, VCR_DATA_PLANE_CODES.locationRuntimeReadable,
      `A snapshot location cannot contain a ${JSON.stringify(offending)} segment.`, { segment: offending });
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Small-cell suppression (AC-26)
// ---------------------------------------------------------------------------

/** The keys a cell's head count may be called. `events` is not one: an event count is not a head count. */
/**
 * The keys a cell's headcount may be under. `events` is here on the main
 * thread's ruling (2026-09-28): one event is at least one person, so a cell of
 * three events discloses as much as a cell of three patients, and the plan's
 * 「人数少于 10 的格子」 is about disclosure rather than about the word 人数.
 * Simulation output is never walked by this function — it holds no people —
 * so the cost of the wider list falls only where it should.
 */
export const VCR_CELL_COUNT_KEYS = Object.freeze(["n", "count", "patients", "realPatients", "subjects", "events"]);

/** @param {any} cell */
function cellCount(cell) {
  if (!cell || typeof cell !== "object") return null;
  for (const key of VCR_CELL_COUNT_KEYS) {
    const value = /** @type {any} */ (cell)[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

/** Everything a cell keeps when it is suppressed: what it is, never how many. */
const CELL_IDENTITY_KEYS = Object.freeze(["key", "label", "name", "group", "stratum", "arm", "level", "cell"]);

/** @param {any} cell */
function suppressedCell(cell) {
  /** @type {Record<string, any>} */
  const kept = {};
  for (const key of CELL_IDENTITY_KEYS) {
    if (cell && Object.hasOwn(cell, key)) kept[key] = cell[key];
  }
  return { ...kept, suppressed: true, n: null };
}

/**
 * Merge or hide every cell holding fewer than `minCellSize` people, anywhere
 * in an aggregate handed to a model.
 *
 * Walks plain objects and arrays looking for a `cells` array; each such array
 * is treated as one table. Returns a new structure and never mutates the
 * caller's. Reports what it did in `suppression`, so a reader is told a cell
 * was withheld rather than shown a hole.
 *
 * @param {any} aggregate
 * @param {{ minCellSize?: number }} [options]
 * @returns {{ aggregate: any, suppression: { tables: number, cellsSuppressed: number, cellsShown: number, minCellSize: number } }}
 */
export function suppressSmallCells(aggregate, options = {}) {
  const floor = Number.isSafeInteger(options.minCellSize) && /** @type {number} */ (options.minCellSize) > 0
    ? Number(options.minCellSize) : VCR_MIN_CELL_SIZE;
  const report = { tables: 0, cellsSuppressed: 0, cellsShown: 0, minCellSize: floor };

  /** @param {any[]} cells */
  const suppressTable = (cells) => {
    report.tables += 1;
    const counted = cells.map((cell, index) => ({ index, count: cellCount(cell) }));
    const withCounts = counted.filter((entry) => entry.count != null);
    // Nothing declares a head count: there is nothing to suppress, and
    // inventing a rule over an unknown shape would suppress by superstition.
    if (!withCounts.length) {
      report.cellsShown += cells.length;
      return cells.map((cell) => (cell && typeof cell === "object" ? { ...cell } : cell));
    }
    const hidden = new Set(withCounts.filter((entry) => /** @type {number} */ (entry.count) < floor).map((entry) => entry.index));
    // One hidden cell is recoverable from the published total, and so is a
    // bucket that is itself below the floor. Absorb the smallest remaining
    // cells until the bucket carries at least `floor` people and at least two
    // cells — or until nothing is left to absorb, in which case the whole
    // table is withheld.
    const bucketCount = () => withCounts.filter((entry) => hidden.has(entry.index))
      .reduce((total, entry) => total + /** @type {number} */ (entry.count), 0);
    if (hidden.size) {
      const remaining = withCounts.filter((entry) => !hidden.has(entry.index))
        .sort((a, b) => /** @type {number} */ (a.count) - /** @type {number} */ (b.count) || a.index - b.index);
      while (remaining.length && (hidden.size < 2 || bucketCount() < floor)) {
        hidden.add(/** @type {any} */ (remaining.shift()).index);
      }
    }
    const out = cells.map((cell, index) => {
      if (!hidden.has(index)) {
        report.cellsShown += 1;
        return cell && typeof cell === "object" ? { ...cell } : cell;
      }
      report.cellsSuppressed += 1;
      return suppressedCell(cell);
    });
    return out;
  };

  /** @param {any} node @param {number} depth */
  const walk = (node, depth) => {
    if (depth > 12 || node == null || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map((entry) => walk(entry, depth + 1));
    /** @type {Record<string, any>} */
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "cells" && Array.isArray(value)) out[key] = suppressTable(value);
      else out[key] = walk(value, depth + 1);
    }
    return out;
  };

  return { aggregate: walk(aggregate, 0), suppression: report };
}

// ---------------------------------------------------------------------------
// The three ADaM shapes (C2-23)
// ---------------------------------------------------------------------------

/**
 * What each shape must carry. Names are ADaM's, because the engine only ever
 * reads these three shapes and a sponsor's statistician already knows them
 * (plan §8.1); using the shape is not a claim of submission-grade ADaM.
 */
export const VCR_ANALYSIS_TABLE_COLUMNS = Object.freeze({
  subject: Object.freeze({ required: Object.freeze(["USUBJID"]), unique: "USUBJID" }),
  longitudinal: Object.freeze({ required: Object.freeze(["USUBJID", "PARAMCD", "AVAL"]), unique: null }),
  events: Object.freeze({ required: Object.freeze(["USUBJID", "PARAMCD", "AVAL", "CNSR"]), unique: null }),
});

/** The defects that make a table not the table it says it is. */
export const VCR_ANALYSIS_TABLE_BLOCKING_ISSUES = Object.freeze([
  "missing-required-column", "duplicate-subject-id", "cnsr-not-binary", "aval-negative",
  "aval-not-numeric", "adt-before-startdt", "empty-subject-id",
]);

/** @param {unknown} value */
const blank = (value) => value == null || String(value).trim() === "";
/** @param {unknown} value */
function numberOf(value) {
  if (blank(value)) return null;
  const parsed = Number(String(value).trim());
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}
/** @param {unknown} value */
function dateOf(value) {
  if (blank(value)) return null;
  const parsed = Date.parse(String(value).trim());
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/**
 * Every defect of one analysis table, each named and counted, worst first.
 * Pure: the caller decides what to do with them.
 * @param {string} shape one of `subject` | `longitudinal` | `events`
 * @param {Record<string, unknown>[]} rows
 * @returns {{ issue: string, blocking: boolean, column: string | null, rows: number, examples: (string|number)[], message: string }[]}
 */
export function analysisTableIssues(shape, rows) {
  if (!VCR_ANALYSIS_TABLES.includes(shape)) {
    throw new TypeError(`An analysis table shape is one of ${VCR_ANALYSIS_TABLES.join(", ")}, got ${JSON.stringify(shape)}`);
  }
  const spec = /** @type {any} */ (VCR_ANALYSIS_TABLE_COLUMNS)[shape];
  const list = Array.isArray(rows) ? rows : [];
  /** @type {{ issue: string, blocking: boolean, column: string | null, rows: number, examples: (string|number)[], message: string }[]} */
  const issues = [];
  /** @param {string} issue @param {string | null} column @param {number} count @param {(string|number)[]} examples @param {string} message */
  const add = (issue, column, count, examples, message) => {
    if (count <= 0) return;
    issues.push({
      issue, blocking: VCR_ANALYSIS_TABLE_BLOCKING_ISSUES.includes(issue), column,
      rows: count, examples: examples.slice(0, 3), message,
    });
  };

  const present = new Set(list.length ? Object.keys(list[0] ?? {}) : []);
  for (const row of list) for (const key of Object.keys(row ?? {})) present.add(key);
  const missing = spec.required.filter((/** @type {string} */ column) => !present.has(column));
  if (missing.length) {
    add("missing-required-column", missing.join(","), missing.length, missing,
      `A ${shape} table must carry ${spec.required.join(", ")}; missing ${missing.join(", ")}.`);
    // Without the columns there is nothing further to decide about the values.
    return issues;
  }
  if (!list.length) {
    add("empty-table", null, 1, [], `The ${shape} table has no rows.`);
    return issues;
  }

  // USUBJID is the spine of all three shapes: blank means the row belongs to
  // nobody, and a duplicate in ADSL means "one row per subject" is not true.
  let blankSubjects = 0;
  /** @type {Map<string, number>} */
  const subjectCounts = new Map();
  for (const row of list) {
    const subject = row.USUBJID;
    if (blank(subject)) { blankSubjects += 1; continue; }
    const key = String(subject).trim();
    subjectCounts.set(key, (subjectCounts.get(key) ?? 0) + 1);
  }
  add("empty-subject-id", "USUBJID", blankSubjects, [], "Every row must name the subject it belongs to.");
  if (spec.unique === "USUBJID") {
    const duplicates = [...subjectCounts.entries()].filter(([, count]) => count > 1);
    add("duplicate-subject-id", "USUBJID", duplicates.length, duplicates.map(([key]) => key),
      "A subject-level table is one row per subject; these subject ids appear more than once.");
  }

  if (shape === "longitudinal" || shape === "events") {
    let notNumeric = 0;
    let negative = 0;
    /** @type {(string|number)[]} */
    const negativeExamples = [];
    for (const row of list) {
      const value = numberOf(row.AVAL);
      if (value == null) continue;
      if (Number.isNaN(value)) { notNumeric += 1; continue; }
      // AVAL is an elapsed time in ADTTE and can never run backwards.
      if (shape === "events" && value < 0) { negative += 1; if (negativeExamples.length < 3) negativeExamples.push(value); }
    }
    add("aval-not-numeric", "AVAL", notNumeric, [], "AVAL is an analysis value and must be a number.");
    add("aval-negative", "AVAL", negative, negativeExamples, "AVAL in a time-to-event table is an elapsed time and cannot be negative.");
    let missingParam = 0;
    for (const row of list) if (blank(row.PARAMCD)) missingParam += 1;
    add("missing-paramcd", "PARAMCD", missingParam, [], "Every measurement names the parameter it measures.");
  }

  if (shape === "events") {
    let badCensor = 0;
    /** @type {(string|number)[]} */
    const badCensorExamples = [];
    for (const row of list) {
      const raw = row.CNSR;
      const value = numberOf(raw);
      if (value === 0 || value === 1) continue;
      badCensor += 1;
      if (badCensorExamples.length < 3) badCensorExamples.push(blank(raw) ? "" : String(raw));
    }
    add("cnsr-not-binary", "CNSR", badCensor, badCensorExamples,
      "CNSR is the censoring indicator and is 0 (event) or 1 (censored); nothing else is a censoring table.");
    let outOfOrder = 0;
    /** @type {(string|number)[]} */
    const outOfOrderExamples = [];
    for (const row of list) {
      const start = dateOf(row.STARTDT);
      const end = dateOf(row.ADT);
      if (start == null || end == null) continue;
      if (Number.isNaN(start) || Number.isNaN(end)) continue;
      if (end < start) {
        outOfOrder += 1;
        if (outOfOrderExamples.length < 3) outOfOrderExamples.push(`${row.USUBJID}: ${row.STARTDT} → ${row.ADT}`);
      }
    }
    add("adt-before-startdt", "ADT", outOfOrder, outOfOrderExamples,
      "The analysis date cannot precede the time origin: time zero is frozen before the analysis, not after it.");
  }

  issues.sort((a, b) => Number(b.blocking) - Number(a.blocking) || a.issue.localeCompare(b.issue));
  return issues;
}

// ---------------------------------------------------------------------------
// The three clocks, and what a blank means (§8.1)
// ---------------------------------------------------------------------------

/**
 * Which column carries which clock, from the snapshot's field maps.
 * @param {{ columnName: string, timeKind: string | null }[]} fieldMaps
 * @returns {{ occurred_at: string[], recorded_at: string[], visible_at: string[], unmapped: string[] }}
 */
export function snapshotClocks(fieldMaps) {
  /** @type {Record<string, string[]>} */
  const clocks = { occurred_at: [], recorded_at: [], visible_at: [] };
  const unmapped = [];
  for (const map of fieldMaps ?? []) {
    if (map.timeKind && Object.hasOwn(clocks, map.timeKind)) clocks[map.timeKind].push(map.columnName);
    else unmapped.push(map.columnName);
  }
  for (const key of Object.keys(clocks)) clocks[key].sort();
  return {
    occurred_at: clocks.occurred_at, recorded_at: clocks.recorded_at, visible_at: clocks.visible_at,
    unmapped: unmapped.sort(),
  };
}

/**
 * The rows a replay dated `asOf` may see: those the platform could already see
 * then. A snapshot with no `visible_at` column cannot answer the question and
 * says so rather than guessing with the event date (AC-15, data side).
 * @param {Record<string, unknown>[]} rows
 * @param {{ columnName: string, timeKind: string | null }[]} fieldMaps
 * @param {string | Date} asOf
 */
export function rowsVisibleAsOf(rows, fieldMaps, asOf) {
  const clocks = snapshotClocks(fieldMaps);
  const cutoff = Date.parse(typeof asOf === "string" ? asOf : new Date(asOf).toISOString());
  if (!Number.isFinite(cutoff)) throw new TypeError(`rowsVisibleAsOf needs a date, got ${JSON.stringify(asOf)}`);
  if (!clocks.visible_at.length) {
    return { decidable: false, reason: "no-visible-at-column", rows: [], hidden: 0, undated: 0 };
  }
  const column = clocks.visible_at[0];
  const visible = [];
  let hidden = 0;
  let undated = 0;
  for (const row of rows ?? []) {
    const stamp = dateOf(row[column]);
    // A row whose visibility date is missing or unparseable is withheld, not
    // admitted: "we do not know when we could see this" is not "we could
    // always see it", and admitting it is the leak this function prevents.
    if (stamp == null || Number.isNaN(stamp)) { undated += 1; continue; }
    if (stamp <= cutoff) visible.push(row);
    else hidden += 1;
  }
  return { decidable: true, reason: "", rows: visible, hidden, undated, column, asOf: new Date(cutoff).toISOString() };
}

/** Missing reasons that mean "the data cannot answer", not "it did not happen". */
export const VCR_UNKNOWN_MISSING_REASONS = Object.freeze([
  "not_shared", "restricted_in_trial", "out_of_window", "pending_result", "not_recorded", "not_measured",
]);

/**
 * What a blank treatment cell means. Never `none` unless the field map says
 * the absence itself was observed — the partner's trial-period data is exactly
 * the case where "we were not told" would otherwise become "no treatment"
 * (plan §3.2, §7.4, AC-06).
 * @param {unknown} value @param {{ missingReason: string | null } | null} fieldMap
 */
export function treatmentEvidence(value, fieldMap) {
  if (!blank(value)) return { evidence: "recorded", value: String(value).trim(), missingReason: null };
  const reason = fieldMap?.missingReason ?? null;
  if (reason === "not_applicable") return { evidence: "not_applicable", value: null, missingReason: reason };
  return {
    evidence: "unknown",
    value: null,
    missingReason: reason ?? "not_recorded",
    note: "未知的治疗不等于没有治疗。",
  };
}

// ---------------------------------------------------------------------------
// Hashing and reading bytes (the control plane may; the model may not)
// ---------------------------------------------------------------------------

/** @param {string} file */
export async function sha256OfFile(file) {
  const digest = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(null));
  });
  return digest.digest("hex");
}

/**
 * A minimal RFC 4180 reader for the tables we ourselves derive. Deliberately
 * small: this parses artifacts the platform wrote, not arbitrary customer
 * uploads — those go to the profiler, which reads with Python's `csv`.
 * @param {string} body
 */
export function parseDelimited(body, delimiter = ",") {
  /** @type {string[][]} */
  const rows = [];
  /** @type {string[]} */
  let row = [];
  let field = "";
  let quoted = false;
  let sawField = false;
  // The byte-order mark, written as an escape: a literal one in the source is
  // invisible to a reviewer and to the linter it is an irregular whitespace.
  const text = body.replace(/^\uFEFF/, "");
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') { field += '"'; index += 1; }
        else quoted = false;
      } else field += character;
      continue;
    }
    if (character === '"') { quoted = true; sawField = true; continue; }
    if (character === delimiter) { row.push(field); field = ""; sawField = true; continue; }
    if (character === "\r") continue;
    if (character === "\n") { row.push(field); rows.push(row); row = []; field = ""; sawField = false; continue; }
    field += character;
    sawField = true;
  }
  if (sawField || field) { row.push(field); rows.push(row); }
  if (!rows.length) return { header: [], rows: [] };
  const header = rows[0].map((name) => name.trim());
  const body_ = rows.slice(1)
    .filter((cells) => cells.some((cell) => cell.trim() !== ""))
    .map((cells) => Object.fromEntries(header.map((name, index) => [name, cells[index] ?? ""])));
  return { header, rows: body_ };
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

/**
 * @typedef {{ vcrDataPlaneDir?: string }} VcrDataPlaneConfig
 */

export class VcrDataPlane {
  /**
   * @param {{ store: import("./vcrDataStore.mjs").VcrDataStore, config: VcrDataPlaneConfig,
   *   profiler?: (input: { files: string[], fieldMap: any, sealedFields: string[], asOf: string | null }) => Promise<any>,
   *   now?: () => Date }} options
   */
  constructor({ store, config, profiler = null, now = () => new Date() }) {
    if (!store) throw new TypeError("The VCR data plane needs its store.");
    this.store = store;
    this.config = config ?? {};
    this.now = now;
    this.profiler = profiler ?? ((input) => runSnapshotProfiler(input));
  }

  /** Is the data plane composed at all? Unset means every tier above T0 says so by name. */
  get configured() {
    return Boolean(String(this.config.vcrDataPlaneDir ?? "").trim());
  }

  /** The resolved root, or a named refusal. */
  root() {
    return assertDataPlaneRoot(this.config.vcrDataPlaneDir ?? "");
  }

  /** @param {string} location */
  resolve(location) {
    return assertDataPlaneLocation(this.config.vcrDataPlaneDir ?? "", location);
  }

  /**
   * Register a data source: whose it is, what it may be used for, what window
   * is visible and how long it is kept (plan §8.1 step 1).
   * @param {{ userId: string, studyId?: string | null, name: string, ownerParty?: string, allowedUses?: string[],
   *   visibleWindow?: Record<string, unknown>, retention?: Record<string, unknown>, format?: string, actor?: string }} entry
   */
  async registerSource(entry) {
    this.root();
    return this.store.createSource(entry);
  }

  /**
   * Freeze a registered source into an immutable snapshot: hash the bytes,
   * count the rows and columns, profile the quality, and write **only** that
   * metadata into `evimed_vcr` (plan §8.1 step 6).
   * @param {{ userId: string, sourceId: string, studyId?: string | null, files: string[],
   *   sealedFields?: string[], sealedUntil?: string | Date | null, fieldMap?: Record<string, any>,
   *   asOf?: string | null, actor?: string }} entry
   */
  async freezeSnapshot(entry) {
    const root = this.root();
    const source = await this.store.sourceFor(entry.sourceId);
    if (!source || source.userId !== entry.userId) {
      throw refuse(404, VCR_DATA_PLANE_CODES.sourceNotFound, "Data source not found.");
    }
    const files = (entry.files ?? []).map((file) => this.resolve(file));
    if (!files.length) throw refuse(400, VCR_DATA_PLANE_CODES.locationMissing, "A snapshot needs at least one file.");
    for (const file of files) {
      const stat = await fs.stat(file).catch(() => null);
      if (!stat?.isFile()) {
        throw refuse(400, VCR_DATA_PLANE_CODES.locationMissing,
          `The snapshot file does not exist inside the data plane: ${path.relative(root, file)}`);
      }
    }
    const sealedFields = (entry.sealedFields ?? []).map((field) => String(field));
    const profile = await this.profiler({
      files, fieldMap: entry.fieldMap ?? {}, sealedFields, asOf: entry.asOf ?? null,
    });
    // One hash over every file of the snapshot, in the order the profiler saw
    // them: two files whose contents swap places are a different snapshot.
    const digest = createHash("sha256");
    for (const file of files) digest.update(`${path.relative(root, file)}\u0000${await sha256OfFile(file)}\u0000`);
    const sha256 = digest.digest("hex");
    const snapshot = await this.store.freezeSnapshot({
      sourceId: entry.sourceId, studyId: entry.studyId ?? source.studyId ?? null, userId: entry.userId,
      location: files.map((file) => path.relative(root, file)).join("\n"),
      sha256,
      rowCount: profile?.snapshot?.rowCount ?? null,
      columnCount: profile?.snapshot?.columnCount ?? null,
      profile: profile?.profile ?? profile?.base ?? {},
      quality: profile?.quality ?? {},
      sealedFields, sealedUntil: entry.sealedUntil ?? null,
      actor: entry.actor ?? entry.userId,
    });
    // The field map the profiler was handed is the study's own answer to 「这
    // 一列是什么」; storing it beside the snapshot is what lets a later replay
    // and a later engine job read the same columns the profile describes.
    for (const [column, map] of Object.entries(entry.fieldMap ?? {})) {
      await this.store.putFieldMap({
        snapshotId: snapshot.id, userId: entry.userId, columnName: column,
        concept: map?.concept ?? "", unit: map?.unit ?? null, codingSystem: map?.codingSystem ?? null,
        timeKind: map?.timeKind ?? null, missingReason: map?.missingReason ?? null,
        identifier: map?.identifier === true, reviewState: map?.reviewState ?? "ai_set", actor: entry.actor ?? entry.userId,
      });
    }
    return { snapshot, profile };
  }

  /**
   * Derive and register the three analysis tables. A table whose shape is not
   * what it says it is is refused by name and not registered; the others are.
   * @param {{ userId: string, studyId: string, snapshotId: string,
   *   tables: { shape: string, file: string }[], actor?: string }} entry
   */
  async deriveAnalysisTables(entry) {
    const snapshot = await this.store.getSnapshot(entry.snapshotId);
    if (!snapshot) throw refuse(404, VCR_DATA_PLANE_CODES.snapshotNotFound, "Snapshot not found.");
    /** @type {any[]} */
    const registered = [];
    /** @type {any[]} */
    const refused = [];
    for (const table of entry.tables ?? []) {
      const file = this.resolve(table.file);
      const body = await fs.readFile(file, "utf8").catch(() => null);
      if (body == null) {
        refused.push({ shape: table.shape, issues: [{ issue: "missing-file", blocking: true, column: null, rows: 1, examples: [], message: "The derived table is not in the data plane." }] });
        continue;
      }
      const parsed = parseDelimited(body);
      const issues = analysisTableIssues(table.shape, parsed.rows);
      const blocking = issues.filter((issue) => issue.blocking);
      if (blocking.length) {
        await this.store.audit({
          studyId: entry.studyId, userId: entry.userId, actor: entry.actor ?? entry.userId,
          action: "analysis_table.refused", object: `${entry.snapshotId}:${table.shape}`, outcome: "denied",
          reason: blocking.map((issue) => issue.issue).join(","),
          detail: { shape: table.shape, issues: blocking },
        });
        refused.push({ shape: table.shape, issues });
        continue;
      }
      registered.push(await this.store.putAnalysisTable({
        snapshotId: entry.snapshotId, studyId: entry.studyId, userId: entry.userId, shape: table.shape,
        location: path.relative(this.root(), file), sha256: await sha256OfFile(file),
        rowCount: parsed.rows.length, columns: parsed.header, issues, actor: entry.actor ?? entry.userId,
      }));
    }
    if (refused.length && !registered.length) {
      throw refuse(422, VCR_DATA_PLANE_CODES.analysisTableInvalid,
        "The analysis tables do not hold the shape they declare.", { refused });
    }
    return { registered, refused };
  }

  /**
   * Seal outcome fields (AC-32) or lift the seal. Both write an audit row
   * carrying the wall clock: the study package's proof that the plan was
   * frozen before the outcome could be read is those two timestamps, and a
   * boolean cannot carry it.
   * @param {{ snapshotId: string, fields: string[], until?: string | Date | null, actor: string, reason?: string }} entry
   */
  async sealFields(entry) {
    const snapshot = await this.store.getSnapshot(entry.snapshotId);
    if (!snapshot) throw refuse(404, VCR_DATA_PLANE_CODES.snapshotNotFound, "Snapshot not found.");
    const fields = [...new Set([...(snapshot.sealedFields ?? []), ...(entry.fields ?? []).map(String)])].sort();
    const sealed = await this.store.setSeal({
      snapshotId: entry.snapshotId, sealedFields: fields, sealedUntil: entry.until ?? null,
      actor: entry.actor, reason: entry.reason ?? "", action: "snapshot.seal",
    });
    return { snapshot: sealed, sealedAt: this.now().toISOString() };
  }

  /** @param {{ snapshotId: string, fields?: string[] | null, actor: string, reason?: string }} entry */
  async unsealFields(entry) {
    const snapshot = await this.store.getSnapshot(entry.snapshotId);
    if (!snapshot) throw refuse(404, VCR_DATA_PLANE_CODES.snapshotNotFound, "Snapshot not found.");
    const dropping = new Set((entry.fields ?? snapshot.sealedFields ?? []).map(String));
    const fields = (snapshot.sealedFields ?? []).filter((field) => !dropping.has(field)).sort();
    const sealed = await this.store.setSeal({
      snapshotId: entry.snapshotId, sealedFields: fields, sealedUntil: fields.length ? snapshot.sealedUntil : null,
      actor: entry.actor, reason: entry.reason ?? "", action: "snapshot.unseal",
    });
    return { snapshot: sealed, unsealedAt: this.now().toISOString() };
  }

  /**
   * What a model may be told about a snapshot: the structure, the data
   * dictionary, the quality profile and nothing that is a row. Sealed columns
   * appear by name with no statistics — a sealed outcome's fill rate is an
   * event rate — and identifying columns carry no vocabulary.
   * @param {{ snapshotId: string }} entry
   */
  async snapshotProfileForModel(entry) {
    const snapshot = await this.store.getSnapshot(entry.snapshotId);
    if (!snapshot) throw refuse(404, VCR_DATA_PLANE_CODES.snapshotNotFound, "Snapshot not found.");
    const fieldMaps = await this.store.listFieldMaps(entry.snapshotId);
    const sealed = new Set(snapshot.sealedFields ?? []);
    const now = this.now().getTime();
    const sealActive = sealed.size > 0 && (!snapshot.sealedUntil || Date.parse(snapshot.sealedUntil) > now);
    const tables = Array.isArray(/** @type {any} */ (snapshot.profile)?.tables) ? /** @type {any} */ (snapshot.profile).tables : [];
    // The field map is the study's own declaration of which columns identify a
    // person, and it wins over the profiler's name and value heuristics: a
    // column called `USUBJID` is one token with no id-shaped suffix, so the
    // heuristics pass it and it hands over its subject ids.
    const declaredIdentifiers = new Set(fieldMaps.filter((map) => map.identifier === true).map((map) => map.columnName));
    const columns = [];
    for (const table of tables) {
      for (const column of table.columns ?? []) {
        if (sealActive && sealed.has(column.name)) {
          columns.push({ table: table.name, name: column.name, sealed: true });
          continue;
        }
        const identifying = column.vocabulary?.identifying === true || declaredIdentifiers.has(column.name);
        columns.push({
          table: table.name, name: column.name, sealed: false,
          inferredType: column.inferredType ?? null,
          filled: column.filled ?? null, rows: column.rows ?? null,
          densityCompleteness: column.densityCompleteness ?? null,
          distinct: column.distinct ?? null,
          identifying,
          vocabulary: identifying ? [] : (column.vocabulary?.values ?? []),
        });
      }
    }
    return {
      snapshotId: snapshot.id, sourceId: snapshot.sourceId, version: snapshot.version,
      sha256: snapshot.sha256, rowCount: snapshot.rowCount, columnCount: snapshot.columnCount,
      frozenAt: snapshot.frozenAt,
      sealedFields: sealActive ? [...sealed].sort() : [],
      sealedUntil: snapshot.sealedUntil,
      clocks: snapshotClocks(fieldMaps),
      fieldMap: fieldMaps.map((map) => ({
        column: map.columnName, concept: map.concept, unit: map.unit, codingSystem: map.codingSystem,
        timeKind: map.timeKind, missingReason: map.missingReason, identifier: map.identifier, reviewState: map.reviewState,
      })),
      columns,
      quality: qualitySummary(snapshot.quality),
    };
  }
}

/** Findings per Kahn category, counted. The findings themselves stay in the snapshot row. */
export function qualitySummary(quality) {
  /** @type {Record<string, number>} */
  const counts = {};
  let total = 0;
  for (const category of VCR_QUALITY_CATEGORIES) {
    const findings = Array.isArray(quality?.[category]) ? quality[category] : [];
    counts[category] = findings.length;
    total += findings.length;
  }
  return { categories: counts, findings: total, worstShare: total ? round4(Math.max(...Object.values(counts)) / total) : 0 };
}

/**
 * Run `scripts/vcr/profile_snapshot.py` and parse its JSON. The profiler is a
 * separate process on purpose: it is the same deterministic code the capability
 * already uses for dataset scoping, it holds no database handle, and it is the
 * only thing in this module that ever looks at a cell's value.
 * @param {{ files: string[], fieldMap: any, sealedFields: string[], asOf: string | null, script?: string, python?: string }} input
 */
export async function runSnapshotProfiler(input) {
  const script = input.script ?? VCR_PROFILER_SCRIPT;
  const python = input.python ?? process.env.OPEN_SCIENCE_PYTHON ?? "python3";
  const args = [script, ...input.files, "--json", "-", "--min-cell-size", String(VCR_MIN_CELL_SIZE)];
  if (input.sealedFields?.length) args.push("--sealed-fields", input.sealedFields.join(","));
  if (input.asOf) args.push("--as-of", input.asOf);
  const payload = JSON.stringify(input.fieldMap ?? {});
  return new Promise((resolve, reject) => {
    const child = spawn(python, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.on("error", (error) => reject(refuse(500, VCR_DATA_PLANE_CODES.profilerFailed, `The snapshot profiler could not start: ${error.message}`)));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(refuse(500, VCR_DATA_PLANE_CODES.profilerFailed, `The snapshot profiler failed (exit ${code}): ${err.trim().slice(0, 400)}`));
        return;
      }
      try { resolve(JSON.parse(out)); }
      catch (error) { reject(refuse(500, VCR_DATA_PLANE_CODES.profilerFailed, `The snapshot profiler wrote no JSON: ${String(error)}`)); }
    });
    child.stdin.end(payload);
  });
}
