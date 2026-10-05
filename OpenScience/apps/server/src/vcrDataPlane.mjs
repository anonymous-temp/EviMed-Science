/**
 * 「虚拟临研」's data plane: registering a source, taking a file into it,
 * confirming what its columns mean, freezing it into a hashed snapshot with a
 * quality profile, deriving the three ADaM-shaped analysis tables in code,
 * sealing outcome fields, and handing the engine — and only the engine — the
 * bytes it may read (build plan 2026-09-28 §8.1, §6.5; integration contract
 * §3.2 and §6; AC-03/06/22/26/32).
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
 * - **A file is named by what it holds.** An upload lands at
 *   `studies/<study>/sources/<source>/<sha256>.<ext>`: the name the uploader
 *   chose is display text and never a path, the same bytes are the same file,
 *   and a stored file cannot be swapped for another under its name — the hash
 *   is recomputed at freeze and again by the engine. Encodings are normalised
 *   at the door (a hospital's Excel "CSV" is GBK) so that the profiler, this
 *   file and R all read the same characters.
 * - **A record's conversion works in the plane too, and only there.** A PDF or
 *   Word upload is copied for its conversion into the study's scratch area,
 *   `studies/<study>/.intake/<attempt>/` (0700, removed after each attempt, swept
 *   by age after a crash), and bound from there into the converter's container
 *   by host path; no byte of it passes through the data volume that engines,
 *   backups and project runtimes reach (`vcrIntakeStage.mjs`). The hidden
 *   segment is one no engine location can spell (`vcrLocationIsValid`), and
 *   `assertDataPlaneLocation` refuses it as well.
 * - **The control plane may read the bytes; the model may not.** Deriving and
 *   validating an analysis table means parsing it here, in the tenant
 *   boundary, in memory, discarded when the call returns. Nothing parsed is
 *   written into `evimed_vcr`, into a run's workspace, or into a reply.
 * - **Only the control plane builds an engine input** (contract §3.2). A caller
 *   names `{ kind: "snapshot", id }`; `resolveEngineInputs` checks that the
 *   snapshot is this study's, asks the access judge for the acting principal,
 *   withholds what is sealed, not granted or identifying, and answers the
 *   location, hash and value source the engine will verify. A column the seal
 *   holds is removed from the file before the engine sees it — a view written
 *   into the plane under its own hash — never merely hidden from a listing.
 * - **The subject key never leaves the plane as it arrived.** Analysis tables
 *   and views carry `USUBJID = P + HMAC(study secret, source id)`; the secret
 *   lives in the study's own directory, so deleting the study destroys the
 *   link, and the mapping back is a file in the plane read only through an
 *   audited call. The model never sees a source id, and two studies never see
 *   the same person under the same key.
 * - **Small-cell suppression suppresses more than the small cell.** Hiding
 *   exactly one cell below the floor reproduces it from the total, and hiding
 *   its count while keeping its mean reproduces the people. The rule lives once,
 *   in `@evimed/domain`'s `suppressForModel`; the Python profiler applies the
 *   same rule to a column's vocabulary when it writes it, so nothing below the
 *   floor is ever stored.
 * - **A bad analysis table is refused, not registered with a warning.** This
 *   is not a delivery gate (principle 4's budget is untouched) — it is input
 *   validity at the operation that needs it (principle 14). A table whose CNSR
 *   is not a censoring indicator is not a censoring table, and an engine that
 *   accepts it computes a survival curve out of something else. The refusal
 *   names each defect and the audit row records it, so the failure is
 *   traceable rather than silent (principle 19); only that one table is
 *   refused, never the study.
 * - **The seal is a fact recorded twice and enforced once.** Outcome columns
 *   are sealed on every snapshot of a study whose intended use asks for it, and
 *   lifted, as of the instant the analysis plan was frozen, by `liftStudySeal`.
 *   `reconcileSeal` brings a snapshot in line with the study as it stands
 *   *before* any read is judged, so a study whose use was raised after its
 *   snapshot was frozen is sealed by the next read and never by luck.
 * - **`visible_at <= asOf`, and the three clocks are not interchangeable.** A
 *   historical replay reads what the platform could see then, not what
 *   happened then: a lab drawn on the 1st, entered on the 5th and shared with
 *   us on the 12th is invisible to a replay dated the 8th, and filtering on
 *   the event date instead is exactly the leak AC-15 exists to catch.
 * - **Unknown treatment is not absent treatment.** A blank in a column whose
 *   missing reason is `not_shared` or `restricted_in_trial` is a question the
 *   data cannot answer; `treatmentEvidence` returns `unknown` for it and never
 *   `none`. The partner's data is precisely this case (plan §3.2).
 * - **A snapshot's as-of is applied where the engine's bytes are written, not
 *   only where the profiler counts.** Freezing "as of 2026-01-20" stores that
 *   instant on the snapshot and every table derived from it — and every raw-file
 *   view the engine is handed — keeps the rows `rowsVisibleAsOf` admits, so the
 *   row count of a replay is what the engine reads. The first build accepted the
 *   date on the freeze route and only the profiler saw it: the profile counted
 *   the visible rows and the engine read them all. A file that cannot say when
 *   its rows became visible cannot be replayed, and the freeze names which one
 *   (`as_of_needs_visible_at`) rather than admitting its rows as if they had
 *   always been visible.
 * - **A value source is a fact about a column, not only about a file.** A field
 *   map entry may name the source of its own column (`valueSource`: observed,
 *   extracted, calculated or imputed — a column of a real source is still a real
 *   person's value); a column that says nothing has its source's. The analysis
 *   tables keep each column's source (`derivedFrom.columnSources`), because a
 *   result that rests on an imputed baseline must not read as observed for
 *   sharing a table with observed columns (plan §3.5). The engine's input has
 *   room for one source per table, so the table is labelled with the weakest of
 *   its columns' (`weakestSource`): a mixed table is never called `observed`.
 *
 * @module vcrDataPlane
 */

import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  RUNTIME_WORKSPACE_ROOT, VCR_ANALYSIS_TABLES, VCR_JOB_METHODS, VCR_MEMBER_ROLES, VCR_MIN_CELL_SIZE, VCR_MISSING_REASONS,
  VCR_QUALITY_CATEGORIES, VCR_REAL_PATIENT_SOURCES, VCR_SOURCE_FORMATS, VCR_TIME_KINDS, VCR_VALUE_SOURCES, canonicalScenarioJson,
  suppressForModel, vcrTierSupportedBy, workspaceLayout,
} from "@evimed/domain";

import { HttpError, openScopedFileNoFollow, readStableFileHandle } from "./security.mjs";
import { VcrAccess } from "./vcrAccess.mjs";
import { VCR_IMPORT_FORMATS, VCR_INTAKE_SCRATCH, VCR_TABLE_LIMITS, isVcrIntakeScratchLocation } from "./vcrIntakeLayout.mjs";
import { VCR_FIELD_ROLES, VCR_SOURCE_FILE_ROLES } from "./vcrPersistence.mjs";
import { vcrEffectiveSeal, vcrOutcomeColumns, vcrSealRequired } from "./vcrSeal.mjs";

/** Every way the data plane refuses, by name. A refusal with no name is one nobody can act on. */
export const VCR_DATA_PLANE_CODES = Object.freeze({
  notConfigured: "vcr_data_plane_not_configured",
  locationOutside: "vcr_data_plane_location_outside",
  locationRuntimeReadable: "vcr_data_plane_location_runtime_readable",
  locationMissing: "vcr_data_plane_location_missing",
  snapshotNotFound: "vcr_snapshot_not_found",
  sourceNotFound: "vcr_source_not_found",
  studyNotFound: "vcr_study_not_found",
  analysisTableInvalid: "vcr_analysis_table_invalid",
  profilerFailed: "vcr_snapshot_profile_failed",
  profilerTimeout: "vcr_snapshot_profile_timeout",
  profilerTooLarge: "vcr_snapshot_profile_too_large",
  payloadInvalid: "vcr_payload_invalid",
  fileTooLarge: "vcr_data_file_too_large",
  formatUnsupported: "vcr_data_format_unsupported",
  fileUnreadable: "vcr_data_file_unreadable",
  fileNameInvalid: "vcr_data_file_name_invalid",
  fileNotFound: "vcr_source_file_not_found",
  fileFrozen: "vcr_source_file_frozen",
  fileChanged: "vcr_source_file_changed",
  fieldMapInvalid: "vcr_field_map_invalid",
  fieldMapChanged: "vcr_field_map_changed",
  fieldMapUnconfirmed: "vcr_field_map_unconfirmed",
  snapshotNoTables: "vcr_snapshot_no_tables",
  snapshotWithheld: "vcr_snapshot_withheld",
  grantInvalid: "vcr_grant_invalid",
  grantOwnerOnly: "vcr_grant_owner_only",
  grantNotFound: "vcr_grant_not_found",
  documentNotFound: "vcr_document_not_found",
  documentNeedsText: "vcr_document_needs_text",
  documentConverterUnavailable: "vcr_document_converter_unavailable",
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
  // The conversion's scratch is inside the plane and is not a file the plane keeps:
  // no snapshot, table or view may be located in it.
  if (isVcrIntakeScratchLocation(path.relative(root, resolved))) {
    throw refuse(400, VCR_DATA_PLANE_CODES.locationOutside,
      "A snapshot location cannot be in the intake scratch area.", { segment: VCR_INTAKE_SCRATCH });
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Small-cell suppression (AC-26)
// ---------------------------------------------------------------------------

/**
 * Suppress what a model must not read from an aggregate: the domain's
 * `suppressForModel`, answered in the `{ aggregate, suppression }` shape the
 * first build's callers read. There is one rule and it lives in the domain
 * (contract §4); this wrapper exists only so a caller written against the old
 * walker still runs, and it is deleted when the last of them is. A payload that
 * has already passed the boundary must not be passed again: a hidden cell reads
 * as size zero, and the second pass tops the hidden set up with cells the first
 * one showed.
 *
 * @param {any} aggregate
 * @param {{ minCellSize?: number }} [options]
 * @returns {{ aggregate: any, suppression: { cellsSuppressed: number, minCellSize: number } }}
 */
export function suppressSmallCells(aggregate, options = {}) {
  const floor = Number.isSafeInteger(options.minCellSize) && /** @type {number} */ (options.minCellSize) > 1
    ? Number(options.minCellSize) : VCR_MIN_CELL_SIZE;
  const safe = suppressForModel(aggregate, { minCell: floor });
  let cellsSuppressed = 0;
  /** @param {any} node */
  const count = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(count); return; }
    if (Array.isArray(node.suppressed) && node.suppressed.length) cellsSuppressed += 1;
    Object.values(node).forEach(count);
  };
  count(safe);
  return { aggregate: safe, suppression: { cellsSuppressed, minCellSize: floor } };
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
  "missing-required-column", "duplicate-subject-id", "duplicate-event-row", "cnsr-not-binary", "aval-negative",
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
 * What an audit line may say of a refused analysis table: the defects, named and
 * counted, and never their example values — those are cells of people's rows,
 * and an audit row outlives the study it describes. The caller who uploaded the
 * data is told the examples in the refusal itself.
 * @param {string} shape @param {{ issue: string, column: string | null, rows: number }[]} blocking
 */
export function refusedTableAuditDetail(shape, blocking) {
  return { shape, issues: blocking.map(({ issue, column, rows }) => ({ issue, column, rows })) };
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
    // The engine reads one row per person and parameter and stops on a second.
    /** @type {Map<string, number>} */
    const perParameter = new Map();
    for (const row of list) {
      if (blank(row.USUBJID)) continue;
      const pair = `${String(row.USUBJID).trim()}\u0000${String(row.PARAMCD ?? "").trim()}`;
      perParameter.set(pair, (perParameter.get(pair) ?? 0) + 1);
    }
    const repeated = [...perParameter.entries()].filter(([, count]) => count > 1);
    add("duplicate-event-row", "PARAMCD", repeated.length, [], "An event table is one row per subject and parameter; some subjects have several rows for one parameter.");
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

/**
 * How directly a real person's value was recorded, most direct first. The order
 * is a judgment, made once: a recorded value beats a transcription of one, a
 * transcription beats a deterministic computation from others, and a computed
 * value beats one filled in by a declared method.
 */
export const VCR_COLUMN_SOURCE_ORDER = Object.freeze(["observed", "extracted", "calculated", "imputed"]);

/**
 * The source a table of mixed columns is labelled with: the least direct of
 * them. A table is never called `observed` because most of its columns are.
 * A source outside the real-patient four (a synthetic or aggregate source has no
 * per-column sources) is returned as it is, so a caller cannot launder it.
 * @param {Iterable<string>} sources @param {string} fallback what an empty table is labelled with
 */
export function weakestSource(sources, fallback) {
  const list = [...sources];
  if (!list.length) return fallback;
  const outside = list.find((source) => !VCR_COLUMN_SOURCE_ORDER.includes(source));
  if (outside) return outside;
  return list.reduce((weakest, source) => (VCR_COLUMN_SOURCE_ORDER.indexOf(source) > VCR_COLUMN_SOURCE_ORDER.indexOf(weakest) ? source : weakest));
}

/**
 * The source of one mapped column: its own when the map names one, else its
 * file's.
 * @param {{ valueSource?: string | null } | null | undefined} entry @param {string} fileSource
 */
export const columnSourceOf = (entry, fileSource) => entry?.valueSource ?? fileSource;

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

/** @param {Buffer | string} bytes */
export function sha256OfBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * A minimal RFC 4180 reader, to arrays: the header row, and every non-blank row
 * after it as a list of cells in header order. Uploads are normalised to UTF-8
 * before they reach it, and the profiler reads the same bytes with Python's
 * `csv`, so the two agree on what a cell is.
 * @param {string} body @param {string} [delimiter]
 * @returns {{ header: string[], rows: string[][] }}
 */
export function parseTable(body, delimiter = ",") {
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
    .map((cells) => header.map((_name, index) => cells[index] ?? ""));
  return { header, rows: body_ };
}

/**
 * The same reader, to row objects — for the tables this module derives itself,
 * whose header names are unique by construction. (A file with two columns of
 * one name is refused at upload: an object cannot hold both.)
 * @param {string} body @param {string} [delimiter]
 */
export function parseDelimited(body, delimiter = ",") {
  const { header, rows } = parseTable(body, delimiter);
  return {
    header,
    rows: rows.map((cells) => Object.fromEntries(header.map((name, index) => [name, cells[index] ?? ""]))),
  };
}

/**
 * A table as RFC 4180 text, `\n`-terminated, UTF-8. A cell is quoted when it
 * has to be, so what `parseTable` reads back is what was written.
 * @param {readonly string[]} header @param {readonly (readonly string[])[]} rows
 */
export function toCsv(header, rows) {
  /** @param {unknown} value */
  const cell = (value) => {
    const text = value == null ? "" : String(value);
    return /[",\n\r]/.test(text) || text !== text.trim() ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return `${[header, ...rows].map((row) => row.map(cell).join(",")).join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// The field map: what each column of a source is for
// ---------------------------------------------------------------------------

/** What a field map may hold. */
export const VCR_FIELD_MAP_LIMITS = Object.freeze({ entries: 500, concept: 80, unit: 32, codingSystem: 40, name: 128 });
/** A name a column carries in the analysis tables: the row-rule grammar's `Col` (contract §2.1). */
export const VCR_ANALYSIS_COLUMN = /^[A-Za-z_][A-Za-z0-9_.]{0,63}$/;
/** An outcome or measurement parameter: ADaM's PARAMCD, a little wider. */
export const VCR_PARAMETER = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
/** Column names the analysis tables use for themselves. */
const RESERVED_ANALYSIS_NAMES = Object.freeze(["USUBJID", "PARAMCD", "AVAL", "CNSR", "STARTDT", "ADT"]);
/** What a column may declare its values to be (the profiler's `infer_type` vocabulary). */
export const VCR_DECLARED_TYPES = Object.freeze(["integer", "number", "date", "text"]);
/** Roles that put a column into a derived table. */
const DERIVING_ROLES = Object.freeze(["arm", "covariate", "outcome_time", "outcome_event", "time_zero", "measurement", "visit_date"]);
const FIELD_ENTRY_KEYS = Object.freeze([
  "table", "column", "role", "concept", "unit", "codingSystem", "timeKind", "missingReason", "identifier", "parameter",
  "alias", "type", "range", "required", "outcome", "codes", "valueSource",
]);
/** What an event indicator's cell may say when the map names no codes. */
const EVENT_YES = Object.freeze(["1", "true", "yes", "y", "是"]);
const EVENT_NO = Object.freeze(["0", "false", "no", "n", "否"]);

/** @param {unknown} value @returns {value is Record<string, any>} */
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
/** @param {unknown} value */
const text = (value) => (typeof value === "string" ? value.trim() : "");
/** Whether a string holds a control character — spelled without a regex, which the linter reads as a mistake. @param {string} value */
const hasControl = (value) => [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);

/**
 * @typedef {{ table: string, column: string, role: string, concept: string, unit: string | null,
 *   codingSystem: string | null, timeKind: string | null, missingReason: string | null, identifier: boolean,
 *   parameter: string | null, alias: string | null, type: string | null, range: number[] | null, required: boolean,
 *   outcome: boolean, codes: { event?: string[], censored?: string[], treated?: string[], control?: string[] },
 *   valueSource?: string | null }} VcrFieldEntry
 * @typedef {{ index?: number, code: string, field?: string, table?: string, column?: string, message: string }} VcrFieldIssue
 */

/**
 * The map as the routes and the run send it — a list of column entries — checked
 * one entry at a time, closed vocabularies and all. An entry with a problem is
 * left out and named; the rest are kept (the run's proposals are written per
 * item, and a person told which entry was refused can mend that one).
 *
 * @param {unknown} input
 * @returns {{ columns: VcrFieldEntry[], issues: VcrFieldIssue[] }}
 */
export function normalizeFieldMap(input) {
  /** @type {VcrFieldIssue[]} */
  const issues = [];
  if (!Array.isArray(input)) {
    return { columns: [], issues: [{ code: "field_map_not_list", message: "字段映射是一个列表，每一项对应一列。" }] };
  }
  if (input.length > VCR_FIELD_MAP_LIMITS.entries) {
    issues.push({ code: "field_map_too_long", message: `字段映射最多 ${VCR_FIELD_MAP_LIMITS.entries} 项，多出的没有读取。` });
  }
  /** @type {VcrFieldEntry[]} */
  const columns = [];
  const seen = new Set();
  input.slice(0, VCR_FIELD_MAP_LIMITS.entries).forEach((raw, index) => {
    /** @type {(field: string, code: string, message: string) => void} */
    const bad = (field, code, message) => { issues.push({ index, field, code, message }); };
    if (!isObject(raw)) { bad("", "entry_not_object", "每一项是一个对象。"); return; }
    const before = issues.length;
    for (const key of Object.keys(raw)) {
      if (!FIELD_ENTRY_KEYS.includes(key)) bad(key, "field_unknown", `字段映射的一项不含「${key}」。`);
    }
    const column = text(raw.column);
    if (!column || column.length > VCR_FIELD_MAP_LIMITS.name || hasControl(column)) bad("column", "column_invalid", "列名是 1 到 128 个字符的一行文字。");
    const table = raw.table == null ? "" : text(raw.table);
    if (table.length > 120) bad("table", "table_invalid", "文件名太长。");
    const role = raw.role == null ? "other" : text(raw.role);
    if (!VCR_FIELD_ROLES.includes(role)) bad("role", "role_unknown", `这一列的作用必须是：${VCR_FIELD_ROLES.join("、")}。`);
    const concept = raw.concept == null ? "" : text(raw.concept);
    if (concept.length > VCR_FIELD_MAP_LIMITS.concept) bad("concept", "concept_invalid", "概念说明最长 80 个字符。");
    const unit = raw.unit == null || raw.unit === "" ? null : text(raw.unit);
    if (unit !== null && (!unit || unit.length > VCR_FIELD_MAP_LIMITS.unit)) bad("unit", "unit_invalid", "单位最长 32 个字符。");
    const codingSystem = raw.codingSystem == null || raw.codingSystem === "" ? null : text(raw.codingSystem);
    if (codingSystem !== null && (!codingSystem || codingSystem.length > VCR_FIELD_MAP_LIMITS.codingSystem)) bad("codingSystem", "coding_system_invalid", "编码体系最长 40 个字符。");
    const timeKind = raw.timeKind == null || raw.timeKind === "" ? null : text(raw.timeKind);
    if (timeKind !== null && !VCR_TIME_KINDS.includes(timeKind)) bad("timeKind", "time_kind_unknown", `时间种类必须是：${VCR_TIME_KINDS.join("、")}。`);
    const missingReason = raw.missingReason == null || raw.missingReason === "" ? null : text(raw.missingReason);
    if (missingReason !== null && !VCR_MISSING_REASONS.includes(missingReason)) bad("missingReason", "missing_reason_unknown", "缺失原因不在词表内。");
    if (raw.identifier != null && typeof raw.identifier !== "boolean") bad("identifier", "identifier_invalid", "是否直接标识是 true 或 false。");
    const parameter = raw.parameter == null || raw.parameter === "" ? null : text(raw.parameter);
    if (parameter !== null && !VCR_PARAMETER.test(parameter)) bad("parameter", "parameter_invalid", "参数代码以字母开头，只含字母、数字和下划线，最长 32 个字符。");
    const alias = raw.alias == null || raw.alias === "" ? null : text(raw.alias);
    if (alias !== null && !VCR_ANALYSIS_COLUMN.test(alias)) bad("alias", "alias_invalid", "分析表里的列名以字母或下划线开头，只含字母、数字、下划线和点，最长 64 个字符。");
    const type = raw.type == null || raw.type === "" ? null : text(raw.type);
    if (type !== null && !VCR_DECLARED_TYPES.includes(type)) bad("type", "type_unknown", `取值类型必须是：${VCR_DECLARED_TYPES.join("、")}。`);
    /** @type {number[] | null} */
    let range = null;
    if (raw.range != null) {
      const bounds = raw.range;
      if (Array.isArray(bounds) && bounds.length === 2 && bounds.every((bound) => typeof bound === "number" && Number.isFinite(bound)) && bounds[0] <= bounds[1]) {
        range = [bounds[0], bounds[1]];
      } else bad("range", "range_invalid", "取值范围是 [下限, 上限]，两个有限的数，下限不大于上限。");
    }
    if (raw.required != null && typeof raw.required !== "boolean") bad("required", "required_invalid", "是否必填是 true 或 false。");
    if (raw.outcome != null && typeof raw.outcome !== "boolean") bad("outcome", "outcome_invalid", "是否结局是 true 或 false。");
    const valueSource = raw.valueSource == null || raw.valueSource === "" ? null : text(raw.valueSource);
    if (valueSource !== null && !VCR_VALUE_SOURCES.includes(valueSource)) {
      bad("valueSource", "value_source_unknown", `值的来源必须是：${VCR_VALUE_SOURCES.join("、")}。`);
    } else if (valueSource !== null && !VCR_REAL_PATIENT_SOURCES.includes(valueSource)) {
      // A column of a real source is a real person's value; "synthetic" or
      // "aggregate" belongs to the whole source, which is registered as such.
      bad("valueSource", "value_source_not_individual", `一列真实数据的来源只能是：${VCR_REAL_PATIENT_SOURCES.join("、")}。`);
    }
    /** @type {{ event?: string[], censored?: string[], treated?: string[], control?: string[] }} */
    const codes = {};
    if (raw.codes != null) {
      const given = raw.codes;
      const words = (/** @type {unknown} */ value) => Array.isArray(value) && value.length >= 1 && value.length <= 10
        && value.every((word) => typeof word === "string" && word.trim() && word.length <= 40);
      const known = ["event", "censored", "treated", "control"];
      if (!isObject(given) || Object.keys(given).some((key) => !known.includes(key))
        || known.some((key) => given[key] !== undefined && !words(given[key]))) {
        bad("codes", "codes_invalid", "编码写作 { event: [...], censored: [...] }（事件列）或 { treated: [...], control: [...] }（分组列），每个最多 10 个短词。");
      } else {
        for (const key of known) if (given[key]) /** @type {any} */ (codes)[key] = given[key].map((/** @type {string} */ word) => word.trim());
      }
    }
    if (issues.length > before) return;
    const key = `${table}\u0000${column}`;
    if (seen.has(key)) { bad("column", "column_duplicate", `「${column}」在映射里出现了不止一次，只保留第一项。`); return; }
    seen.add(key);
    columns.push({
      table, column, role, concept, unit, codingSystem, timeKind, missingReason, identifier: raw.identifier === true,
      parameter, alias, type, range, required: raw.required === true, outcome: raw.outcome === true, codes,
      // Left out when the column says nothing, so a map that never names one hashes as it always did.
      ...(valueSource ? { valueSource } : {}),
    });
  });
  columns.sort((a, b) => a.table.localeCompare(b.table) || a.column.localeCompare(b.column));
  return { columns, issues };
}

/** The hash of a map: what a person confirms is exactly this. @param {readonly VcrFieldEntry[]} columns */
export function fieldMapHash(columns) {
  return sha256OfBytes(canonicalScenarioJson(columns));
}

/**
 * Whether a mapped column is an outcome: a time-to-event pair, or a baseline or
 * measurement column the map calls one (a binary response, a continuous change).
 * @param {Pick<VcrFieldEntry, "role" | "outcome">} entry
 */
export const isOutcomeEntry = (entry) => entry.role === "outcome_time" || entry.role === "outcome_event" || entry.outcome === true;

/** The name a column carries in the analysis tables. @param {Pick<VcrFieldEntry, "alias" | "column">} entry */
export const analysisNameOf = (entry) => entry.alias ?? entry.column;

/**
 * The whole map, against the files it describes: every entry names a real
 * column, the roles fit together (a subject key wherever there is anything to
 * derive, both halves of an outcome, one meaning per analysis name), and nothing
 * that identifies a person is used as data. These are the things without which
 * the analysis tables cannot be derived, so a map that fails them is not
 * confirmed and a snapshot is not frozen from it (CS-40).
 *
 * @param {readonly VcrFieldEntry[]} columns
 * @param {readonly { name: string, header: readonly string[] }[]} tables the files' display names and headers
 * @returns {{ columns: VcrFieldEntry[], issues: VcrFieldIssue[] }} the entries with `table` resolved, and what is wrong
 */
export function validateFieldMap(columns, tables) {
  /** @type {VcrFieldIssue[]} */
  const issues = [];
  const add = (/** @type {string} */ code, /** @type {string} */ message, /** @type {Partial<VcrFieldEntry>} */ where = {}) => {
    issues.push({ code, message, ...(where.table ? { table: where.table } : {}), ...(where.column ? { column: where.column } : {}) });
  };
  if (!tables.length && columns.length) add("no_files", "先上传数据文件，字段映射才能对上具体的列。");
  /** @type {VcrFieldEntry[]} */
  const resolved = [];
  const claimed = new Set();
  for (const entry of columns) {
    let table = entry.table;
    if (tables.length) {
      if (table) {
        const found = tables.find((candidate) => candidate.name === table);
        if (!found) { add("table_unknown", `文件「${table}」不在这个数据源里。`, entry); continue; }
        if (!found.header.includes(entry.column)) { add("column_unknown", `文件「${table}」里没有「${entry.column}」这一列。`, entry); continue; }
      } else {
        const holders = tables.filter((candidate) => candidate.header.includes(entry.column));
        if (!holders.length) { add("column_unknown", `没有哪个文件里有「${entry.column}」这一列。`, entry); continue; }
        if (holders.length > 1) { add("column_ambiguous", `「${entry.column}」在多个文件里都有，请写明是哪个文件的。`, entry); continue; }
        table = holders[0].name;
      }
    }
    const key = `${table}\u0000${entry.column}`;
    if (claimed.has(key)) { add("column_duplicate", `「${entry.column}」在映射里出现了不止一次。`, { ...entry, table }); continue; }
    claimed.add(key);
    resolved.push({ ...entry, table });
  }

  /** @type {Map<string, VcrFieldEntry[]>} */
  const byTable = new Map();
  for (const entry of resolved) byTable.set(entry.table, [...(byTable.get(entry.table) ?? []), entry]);
  /** @type {Map<string, string>} */
  const subjectNames = new Map();
  for (const [table, entries] of byTable) {
    const label = table || "数据文件";
    const keys = entries.filter((entry) => entry.role === "subject_key");
    if (keys.length > 1) add("subject_key_multiple", `${label} 里标了 ${keys.length} 列受试者编号，只能有一列。`, { table });
    const deriving = entries.filter((entry) => DERIVING_ROLES.includes(entry.role));
    if (deriving.length && !keys.length) add("subject_key_missing", `${label} 要派生分析表，需要标出哪一列是受试者编号。`, { table });
    for (const entry of entries) {
      if (entry.identifier && DERIVING_ROLES.includes(entry.role)) {
        add("identifier_used_as_data", `「${entry.column}」是直接标识，不能作为分析数据；请把它的作用改为「其他」。`, entry);
      }
      if (entry.outcome && !["measurement", "covariate"].includes(entry.role)) add("outcome_flag_invalid", `「${entry.column}」的结局标记只用于基线协变量列和纵向测量列；时间与事件列本身就是结局。`, entry);
      if (entry.codes.event || entry.codes.censored) {
        if (entry.role !== "outcome_event") add("codes_misplaced", `「${entry.column}」的事件编码只用于结局事件列。`, entry);
      }
      if (entry.codes.treated || entry.codes.control) {
        if (entry.role !== "arm") add("codes_misplaced", `「${entry.column}」的分组编码只用于「治疗分组」列。`, entry);
        else if ((entry.codes.treated ?? []).some((word) => (entry.codes.control ?? []).includes(word))) {
          add("codes_overlap", `「${entry.column}」的同一个取值不能既是试验组又是对照组。`, entry);
        }
      }
      if (["outcome_time", "outcome_event", "measurement"].includes(entry.role) && !entry.parameter) {
        add("parameter_missing", `「${entry.column}」需要一个参数代码（例如 OS、SBP）。`, entry);
      }
    }
    for (const role of ["time_zero", "visit_date"]) {
      if (entries.filter((entry) => entry.role === role).length > 1) add("role_repeated", `${label} 里「${role === "time_zero" ? "时间零点" : "访视日期"}」只能标一列。`, { table });
    }
    /** @type {Map<string, { time: number, event: number }>} */
    const pairs = new Map();
    /** @type {Set<string>} */
    const measured = new Set();
    for (const entry of entries) {
      if (entry.role === "outcome_time" || entry.role === "outcome_event") {
        const at = entry.parameter ?? "";
        const pair = pairs.get(at) ?? { time: 0, event: 0 };
        pair[entry.role === "outcome_time" ? "time" : "event"] += 1;
        pairs.set(at, pair);
      }
      if (entry.role === "measurement" && entry.parameter) {
        if (measured.has(entry.parameter)) add("parameter_duplicate", `参数 ${entry.parameter} 在 ${label} 里被两列使用。`, entry);
        measured.add(entry.parameter);
      }
    }
    for (const [parameter, pair] of pairs) {
      if (parameter && (pair.time !== 1 || pair.event !== 1)) {
        add("outcome_pair_incomplete", `结局 ${parameter} 需要恰好一列时间和一列事件（现在是 ${pair.time} 列时间、${pair.event} 列事件）。`, { table });
      }
    }
    for (const entry of entries) {
      if (entry.role !== "arm" && entry.role !== "covariate") continue;
      const name = analysisNameOf(entry);
      if (!VCR_ANALYSIS_COLUMN.test(name)) {
        add("alias_invalid", `「${entry.column}」在分析表里需要一个英文列名（字母、数字、下划线），请填写。`, entry);
        continue;
      }
      if (RESERVED_ANALYSIS_NAMES.includes(name)) { add("alias_reserved", `「${name}」是分析表自用的列名，请换一个。`, entry); continue; }
      const previous = subjectNames.get(name);
      if (previous !== undefined) add("alias_duplicate", `分析表里有两列都叫「${name}」，请给其中一列另起名字。`, entry);
      subjectNames.set(name, entry.column);
    }
  }
  return { columns: resolved, issues };
}

/** Whether a file's mapped columns put any of its rows into a derived table. @param {readonly VcrFieldEntry[]} own */
const derivesRows = (own) => own.some((entry) => entry.role === "subject_key" || DERIVING_ROLES.includes(entry.role));

/**
 * What a snapshot frozen as of a date needs of its map: every file that derives
 * anything says, in exactly one column, when its rows became visible to the
 * platform. Without it the freeze cannot tell which rows a replay may see, and
 * admitting them all would be the leak the replay exists to prevent (AC-15).
 * Nothing here applies when no date was given.
 * @param {readonly VcrFieldEntry[]} entries the map, tables resolved @param {string | null} asOf
 * @returns {VcrFieldIssue[]}
 */
export function asOfIssues(entries, asOf) {
  if (!asOf) return [];
  /** @type {VcrFieldIssue[]} */
  const issues = [];
  /** @type {Map<string, VcrFieldEntry[]>} */
  const byTable = new Map();
  for (const entry of entries) byTable.set(entry.table, [...(byTable.get(entry.table) ?? []), entry]);
  for (const [table, own] of byTable) {
    if (!derivesRows(own)) continue;
    const label = table || "数据文件";
    const clocks = own.filter((entry) => entry.timeKind === "visible_at");
    if (!clocks.length) {
      issues.push({ code: "as_of_needs_visible_at", ...(table ? { table } : {}),
        message: `${label} 没有标为「平台可见时间」的列，按 ${asOf.slice(0, 10)} 回放时无法判断哪些行当时已经看得到；请在字段映射里标出这一列。` });
    } else if (clocks.length > 1) {
      issues.push({ code: "as_of_visible_at_repeated", ...(table ? { table } : {}),
        message: `${label} 里有 ${clocks.length} 列标为「平台可见时间」，回放只能依据一列；请只保留一列。` });
    }
  }
  return issues;
}

/**
 * A column may declare its own value source only on a source of real people: on
 * a synthetic or aggregate source the whole source is what it is, and a column
 * that claimed to be `observed` would launder it.
 * @param {readonly VcrFieldEntry[]} entries @param {string} fileSource
 * @returns {VcrFieldIssue[]}
 */
export function columnSourceIssues(entries, fileSource) {
  if (VCR_REAL_PATIENT_SOURCES.includes(fileSource)) return [];
  return entries.filter((entry) => entry.valueSource).map((entry) => ({
    code: "column_source_on_non_individual_source", table: entry.table, column: entry.column,
    message: `这个数据源的值是「${fileSource}」，不是真实个体记录；「${entry.column}」不能单独声明另一种来源。`,
  }));
}

/**
 * The map in the shape the Python profiler reads: `table.column` keys, so two
 * files may disagree about a column of the same name.
 * @param {readonly VcrFieldEntry[]} columns
 */
export function profilerFieldMap(columns) {
  /** @type {Record<string, Record<string, any>>} */
  const out = {};
  for (const entry of columns) {
    const key = entry.table ? `${entry.table}.${entry.column}` : entry.column;
    out[key] = {
      concept: entry.role === "subject_key" ? "subject" : entry.concept, unit: entry.unit, codingSystem: entry.codingSystem,
      timeKind: entry.timeKind, missingReason: entry.missingReason, identifier: entry.identifier || entry.role === "subject_key",
      required: entry.required, range: entry.range, type: entry.type, subjectKey: entry.role === "subject_key",
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pseudonyms: the study's own key for every person
// ---------------------------------------------------------------------------

/**
 * The extension an import is staged under, from the name the uploader gave: one
 * the claimed standard is uploaded as. The name itself is never kept.
 * @param {unknown} raw @param {string} format
 * @returns {string}
 */
export function importExtensionOf(raw, format) {
  const base = String(raw ?? "").split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  const extension = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  if (!base || !extension) throw refuse(400, VCR_DATA_PLANE_CODES.fileNameInvalid, "A file name is a name with an extension, like export.zip.");
  const allowed = /** @type {readonly string[]} */ (/** @type {any} */ (VCR_IMPORT_FORMATS)[format] ?? []);
  if (!allowed.includes(extension)) {
    throw refuse(415, VCR_DATA_PLANE_CODES.formatUnsupported, `A ${format} import is uploaded as one of: ${allowed.join(", ")}.`, { ext: extension });
  }
  return extension;
}

/**
 * The map a source holds after an import: what it already held for other files,
 * and the import's entries for its own. Pure.
 *
 * - **A re-import replaces its own tables' entries**, never another file's.
 * - **Analysis names stay unique across the source**: the map is refused when two
 *   tables carry the same covariate name, so an incoming `SEX` that meets a held
 *   `SEX` becomes `SEX_2`.
 * - **Column sources are declared only where the plane takes them**: a source of
 *   real people's rows takes per-column sources, a synthetic or aggregate source
 *   is what it is as a whole and would have them refused at freeze, so there the
 *   import's entries leave them out (`sourcesDeclared` says which).
 * - **The map has a ceiling** (`VCR_FIELD_MAP_LIMITS.entries`): what does not fit
 *   is the entries that say least — a column left as 「其他」 with nothing but its
 *   source — and the count is returned, never silent.
 * @param {{ existing: readonly any[], incoming: readonly any[], sourceValueSource: string }} input
 * @returns {{ columns: any[], trimmed: number, sourcesDeclared: boolean }}
 */
export function mergeImportedFieldMap({ existing, incoming, sourceValueSource }) {
  const sourcesDeclared = VCR_REAL_PATIENT_SOURCES.includes(sourceValueSource);
  const tables = new Set(incoming.map((entry) => String(entry.table)));
  const kept = existing.filter((entry) => !tables.has(String(entry.table)));
  const used = new Set(kept.filter((entry) => entry.role === "arm" || entry.role === "covariate").map((entry) => analysisNameOf(entry)));
  const prepared = incoming.map((entry) => {
    const { valueSource, ...rest } = entry;
    const out = sourcesDeclared ? { ...rest, valueSource } : rest;
    if (out.role === "arm" || out.role === "covariate") {
      const base = analysisNameOf(out);
      let name = base;
      for (let n = 2; used.has(name); n += 1) name = `${base.slice(0, 60)}_${n}`;
      used.add(name);
      if (name !== base) out.alias = name;
    }
    return out;
  });
  // A column that says only that it is source data: the first to go when the map is full.
  const says = (/** @type {any} */ entry) => entry.role !== "other" || entry.concept || entry.unit || entry.parameter || entry.alias
    || (entry.valueSource && entry.valueSource !== "observed") || entry.outcome === true;
  const room = Math.max(0, VCR_FIELD_MAP_LIMITS.entries - kept.length);
  const ordered = prepared.length > room ? [...prepared.filter(says), ...prepared.filter((entry) => !says(entry))].slice(0, room) : prepared;
  return { columns: [...kept, ...ordered], trimmed: prepared.length - ordered.length, sourcesDeclared };
}

/** A study's directory inside the plane, relative to the root. @param {string} studyId */
export const studyRelative = (studyId) => path.posix.join("studies", studyId);

/**
 * The study's pseudonym secret: 32 random bytes in a file inside the study's own
 * directory, made once (`wx`) and read ever after. It is deliberately not a
 * function of a deployment key: the study's key dies with its directory, which
 * is what turns a deletion into unlinkability, and nothing else in the platform
 * ever holds it. The engine mounts the plane read-only as another user and the
 * file's mode is 0600, and a location naming it is refused twice over (a hidden
 * segment, and no job's input is ever named `.pseudonym-key`).
 * @param {string} root @param {string} studyId
 */
export async function studyPseudonymKey(root, studyId) {
  const directory = path.join(root, studyRelative(studyId));
  const file = path.join(directory, ".pseudonym-key");
  await fs.mkdir(directory, { recursive: true, mode: 0o755 });
  try {
    return Buffer.from((await fs.readFile(file, "utf8")).trim(), "hex");
  } catch (error) {
    if (/** @type {any} */ (error)?.code !== "ENOENT") throw error;
  }
  try {
    await fs.writeFile(file, `${randomBytes(32).toString("hex")}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (/** @type {any} */ (error)?.code !== "EEXIST") throw error;
  }
  const key = Buffer.from((await fs.readFile(file, "utf8")).trim(), "hex");
  if (key.length !== 32) throw refuse(500, VCR_DATA_PLANE_CODES.notConfigured, "The study's pseudonym key is unreadable.");
  return key;
}

/**
 * `P` and sixteen hex digits of an HMAC of the source's subject id. The same id
 * gives the same key inside one study — that is what lets a baseline file and a
 * visits file join — and different keys in different studies.
 * @param {Buffer} key @param {unknown} subjectId
 */
export function pseudonymOf(key, subjectId) {
  return `P${createHmac("sha256", key).update(String(subjectId ?? "").trim()).digest("hex").slice(0, 16)}`;
}

// ---------------------------------------------------------------------------
// What may be uploaded, and how it is made readable
// ---------------------------------------------------------------------------

/** The extensions each file role accepts, and the format an extension is. */
export const VCR_UPLOAD_FORMATS = Object.freeze({
  data: Object.freeze({ csv: "csv", tsv: "tsv", json: "json", xlsx: "xlsx" }),
  dictionary: Object.freeze({ csv: "csv", tsv: "tsv", json: "json", xlsx: "xlsx" }),
  // A record document is text as it arrives, or a PDF or Word file converted to
  // text inside the deployment (vcrRecordExtract.mjs). What is stored, and what
  // the matching step reads, is the text either way.
  document: Object.freeze({ txt: "txt", md: "txt", pdf: "pdf", docx: "docx" }),
});
/** Extensions of a document that is a picture: it has no text to extract, and says so by name. */
const IMAGE_DOCUMENT_EXTENSIONS = Object.freeze(["png", "jpg", "jpeg", "gif", "bmp", "tif", "tiff", "webp", "heic", "heif"]);
/** The formats a record document is converted from rather than read. */
const CONVERTED_DOCUMENT_FORMATS = Object.freeze(["pdf", "docx"]);
/**
 * Extensions refused with a reason a person can act on. The browser says the
 * same sentence before an upload is sent (`intakeState.ts`), and a test holds the
 * two equal: the form's refusal and the plane's are one answer.
 */
export const VCR_UNSUPPORTED_FORMAT_HINTS = Object.freeze({
  parquet: "Parquet 文件目前不能直接接入：请在导出时改为 CSV，或用 Excel、Python 转成 CSV 后上传。",
  xls: "旧版 .xls 不能接入：请另存为 .xlsx 或 CSV 后上传。",
  zip: "请先解压，再逐个上传数据文件。",
  doc: "旧版 .doc 不能直接转换：请另存为 .docx、可复制文字的 PDF 或 .txt 后上传。",
});
/** A file's size ceiling by role, beyond the deployment's own. */
export const VCR_UPLOAD_ROLE_CAPS = Object.freeze({ dictionary: 2 * 1024 * 1024, document: 1024 * 1024 });
/** The default ceiling for a data file; a deployment lowers or raises it with `vcrDataMaxBytes`. */
export const VCR_UPLOAD_DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
/** Columns and rows a data file may have (one definition, shared with the import container's table ceilings). */
export const VCR_UPLOAD_LIMITS = VCR_TABLE_LIMITS;

/**
 * The name an uploader gave a file, as display text: no path, no control
 * characters, no commas (a profile names its tables with it), and an extension
 * the role accepts. It is never used as a path.
 * @param {unknown} raw @param {string} role
 * @returns {{ name: string, ext: string, format: string }}
 */
export function safeUploadName(raw, role) {
  const original = typeof raw === "string" ? raw.normalize("NFC") : "";
  const base = original.split(/[\\/]/).pop() ?? "";
  const cleaned = [...base].map((character) => (character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 || character === "," || character === '"' ? "_" : character)).join("").trim();
  const dot = cleaned.lastIndexOf(".");
  const ext = dot > 0 ? cleaned.slice(dot + 1).toLowerCase() : "";
  if (!cleaned || cleaned.startsWith(".") || !ext) {
    throw refuse(400, VCR_DATA_PLANE_CODES.fileNameInvalid, "A file name is a name with an extension, like cohort.csv.");
  }
  const formats = /** @type {Record<string, string>} */ (/** @type {any} */ (VCR_UPLOAD_FORMATS)[role] ?? {});
  if (role === "document" && IMAGE_DOCUMENT_EXTENSIONS.includes(ext)) {
    // A picture of a record has no text layer: it is refused for that, by name, and
    // the reader is told what to bring instead (never sent anywhere to be read).
    throw refuse(422, VCR_DATA_PLANE_CODES.documentNeedsText, "A picture has no text to extract; supply a text version.", { ext });
  }
  if (!Object.hasOwn(formats, ext)) {
    const hint = /** @type {Record<string, string>} */ (VCR_UNSUPPORTED_FORMAT_HINTS)[ext];
    throw refuse(415, VCR_DATA_PLANE_CODES.formatUnsupported,
      hint ?? `A ${role} file is one of: ${Object.keys(formats).join(", ")}.`, { ext });
  }
  const shown = cleaned.length > 100 ? `${cleaned.slice(0, 100 - ext.length - 1)}.${ext}` : cleaned;
  return { name: shown, ext, format: formats[ext] };
}

/**
 * Bytes to text, whatever a hospital's Excel wrote: UTF-8 (with or without a
 * byte-order mark), UTF-16 with one, or GB18030 — the "CSV" Excel saves in a
 * Chinese locale. Anything else that is not UTF-8 is refused rather than
 * guessed at: a wrong guess is a column of mojibake that nobody sees until a
 * vocabulary is read.
 * @param {Buffer} bytes
 * @returns {{ text: string, encoding: string }}
 */
export function decodeUploadText(bytes) {
  if (bytes.includes(0) && !(bytes[0] === 0xff && bytes[1] === 0xfe) && !(bytes[0] === 0xfe && bytes[1] === 0xff)) {
    throw refuse(422, VCR_DATA_PLANE_CODES.fileUnreadable, "The file holds binary data, not text.");
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: new TextDecoder("utf-16le").decode(bytes.subarray(2)), encoding: "utf-16le" };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: new TextDecoder("utf-16be").decode(bytes.subarray(2)), encoding: "utf-16be" };
  try {
    return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes).replace(/^\uFEFF/, ""), encoding: "utf-8" };
  } catch {
    // fall through to the Chinese locale's own encoding
  }
  try {
    return { text: new TextDecoder("gb18030", { fatal: true }).decode(bytes), encoding: "gb18030" };
  } catch {
    throw refuse(422, VCR_DATA_PLANE_CODES.fileUnreadable, "The file is neither UTF-8 nor GB18030 text; save it as UTF-8 CSV and upload it again.");
  }
}

/**
 * A JSON upload is an array of flat records; it becomes the table it describes.
 * @param {string} body
 * @returns {{ header: string[], rows: string[][] }}
 */
export function jsonTable(body) {
  /** @type {unknown} */
  let parsed;
  try { parsed = JSON.parse(body); } catch { throw refuse(422, VCR_DATA_PLANE_CODES.fileUnreadable, "The file is not valid JSON."); }
  if (!Array.isArray(parsed) || !parsed.length || !parsed.every(isObject)) {
    throw refuse(422, VCR_DATA_PLANE_CODES.fileUnreadable, "A JSON data file is a list of records, one object per row.");
  }
  /** @type {string[]} */
  const header = [];
  const seen = new Set();
  for (const record of parsed) {
    for (const key of Object.keys(record)) {
      if (!seen.has(key)) { seen.add(key); header.push(key); }
      if (header.length > VCR_UPLOAD_LIMITS.columns) throw refuse(422, VCR_DATA_PLANE_CODES.fileUnreadable, `A data file has at most ${VCR_UPLOAD_LIMITS.columns} columns.`);
    }
  }
  const rows = parsed.map((record) => header.map((key) => {
    const value = record[key];
    if (value == null) return "";
    if (typeof value === "object") throw refuse(422, VCR_DATA_PLANE_CODES.fileUnreadable, `The record has a nested value in "${key}"; a table cell is one value.`);
    return String(value);
  }));
  return { header, rows };
}

/**
 * The table a delimited file holds, checked: a header, no column twice (an
 * object row could not hold both), no more columns and rows than the plane
 * takes. A blank header cell is named `col_<position>` — Excel writes them for
 * an index column — and the rename is reported, not hidden.
 * @param {string} body @param {string} delimiter
 * @returns {{ header: string[], rows: string[][], renamed: number }}
 */
export function checkedTable(body, delimiter) {
  const { header, rows } = parseTable(body, delimiter);
  if (!header.length || header.every((name) => !name)) throw refuse(422, VCR_DATA_PLANE_CODES.fileUnreadable, "The file has no header row.");
  if (header.length > VCR_UPLOAD_LIMITS.columns) throw refuse(422, VCR_DATA_PLANE_CODES.fileUnreadable, `A data file has at most ${VCR_UPLOAD_LIMITS.columns} columns.`);
  if (rows.length > VCR_UPLOAD_LIMITS.rows) throw refuse(422, VCR_DATA_PLANE_CODES.fileUnreadable, `A data file has at most ${VCR_UPLOAD_LIMITS.rows} rows.`);
  let renamed = 0;
  const named = header.map((name, index) => {
    if (name) return name;
    renamed += 1;
    return `col_${index + 1}`;
  });
  const counts = new Map();
  for (const name of named) counts.set(name, (counts.get(name) ?? 0) + 1);
  const repeated = [...counts.entries()].filter(([, count]) => count > 1).map(([name]) => name);
  if (repeated.length) {
    throw refuse(422, VCR_DATA_PLANE_CODES.fileUnreadable, `The file has columns of the same name: ${repeated.slice(0, 5).join(", ")}. Rename them and upload again.`, { columns: repeated.slice(0, 20) });
  }
  return { header: named, rows, renamed };
}

/**
 * A data dictionary's entries — column, label, unit — from its table. Only
 * those three are read, and each is clipped: a dictionary describes columns, it
 * is shown to a model, and a "dictionary" that is really a patient list gets
 * nothing out of this but its first three columns' worth of short text.
 * @param {{ header: string[], rows: string[][] }} table
 * @returns {{ column: string, label: string, unit: string }[]}
 */
export function dictionaryEntries(table) {
  const lower = table.header.map((name) => name.trim().toLowerCase());
  const at = (/** @type {string[]} */ names) => lower.findIndex((name) => names.includes(name));
  const name = at(["column", "name", "variable", "field", "变量", "变量名", "字段", "字段名", "列名", "列"]);
  if (name < 0) throw refuse(422, VCR_DATA_PLANE_CODES.fileUnreadable, "A data dictionary needs a column holding the variable names (column, name, variable or 变量名).");
  const label = at(["label", "description", "desc", "meaning", "说明", "含义", "描述", "变量说明", "标签"]);
  const unit = at(["unit", "units", "单位"]);
  const clip = (/** @type {string | undefined} */ value) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  return table.rows.slice(0, 500)
    .map((row) => ({ column: clip(row[name]), label: label >= 0 ? clip(row[label]) : "", unit: unit >= 0 ? clip(row[unit]) : "" }))
    .filter((entry) => entry.column);
}

// ---------------------------------------------------------------------------
// The three analysis tables, derived in code from the confirmed map
// ---------------------------------------------------------------------------

/**
 * @typedef {{ name: string, header: string[], rows: string[][] }} VcrTableData
 * @typedef {{ source: string, name: string, valueSource: string }} VcrDerivedColumn
 * @typedef {{ header: string[], rows: string[][], columns: VcrDerivedColumn[], outcomeBearing: boolean,
 *   parameters: string[], files: string[], columnSources?: Record<string, string>, valueSource?: string }} VcrDerivedShape
 * @typedef {{ file: string, column: string | null, decidable: boolean, visible: number, hidden: number, undated: number }} VcrAsOfFile
 */

/**
 * A file's rows as a replay dated `asOf` may see them, and what was left out and
 * why. `rowsVisibleAsOf` decides; this only carries its answer back to the
 * array-of-cells shape the derivation works in. A file with no `visible_at`
 * column has no visible rows: "we do not know when we could see this" is not
 * "we could always see it".
 * @param {VcrTableData} table @param {readonly VcrFieldEntry[]} entries @param {string} asOf
 * @returns {{ table: VcrTableData, report: VcrAsOfFile }}
 */
export function tableVisibleAsOf(table, entries, asOf) {
  const maps = entries.filter((entry) => entry.table === table.name).map((entry) => ({ columnName: entry.column, timeKind: entry.timeKind }));
  const column = snapshotClocks(maps).visible_at[0] ?? null;
  const index = column === null ? -1 : table.header.indexOf(column);
  // One small object per row, holding only the date the answer turns on; the
  // answer hands the same objects back, which is how each is tied to its row.
  const probes = table.rows.map((row) => ({ [column ?? ""]: index >= 0 ? row[index] : "" }));
  const byProbe = new Map(probes.map((probe, position) => [probe, table.rows[position]]));
  const answer = rowsVisibleAsOf(probes, maps, asOf);
  const rows = answer.decidable ? answer.rows.map((probe) => /** @type {string[]} */ (byProbe.get(probe))) : [];
  return {
    table: { ...table, rows },
    report: { file: table.name, column, decidable: answer.decidable, visible: rows.length, hidden: answer.hidden, undated: answer.undated },
  };
}

/**
 * A treatment-arm cell as the engine reads it: 1 for the trial arm, 0 for the
 * control, when the map names which is which. A value the map does not name is
 * blank — unknown is not control — and is counted. Without codes the cell
 * passes as it is, and an engine that needs 0 and 1 says so by name.
 *
 * A blank is judged by `treatmentEvidence` and stays blank: what the partner did
 * not tell us is `unknown`, and it is counted under its missing reason so the
 * page can say how much of the arm assignment is not known (AC-06).
 * @param {string} raw @param {VcrFieldEntry} entry @param {(reason: string) => void} drop
 * @param {(evidence: string, reason: string | null) => void} [note]
 */
function armCoded(raw, entry, drop, note = () => {}) {
  if (entry.role !== "arm") return raw;
  const evidence = treatmentEvidence(raw, { missingReason: entry.missingReason });
  note(evidence.evidence, evidence.missingReason);
  if (evidence.evidence !== "recorded") return "";
  if (!entry.codes.treated && !entry.codes.control) return raw;
  const word = raw.toLowerCase();
  if ((entry.codes.treated ?? []).some((code) => code.toLowerCase() === word)) return "1";
  if ((entry.codes.control ?? []).some((code) => code.toLowerCase() === word)) return "0";
  if (raw) drop("arm_value_not_coded");
  return "";
}

/** @param {string} raw @param {VcrFieldEntry} entry */
function eventFlag(raw, entry) {
  const word = raw.trim().toLowerCase();
  if (!word) return null;
  const yes = (entry.codes.event ?? EVENT_YES).map((/** @type {string} */ code) => code.toLowerCase());
  const no = (entry.codes.censored ?? EVENT_NO).map((/** @type {string} */ code) => code.toLowerCase());
  if (yes.includes(word)) return 1;
  if (no.includes(word)) return 0;
  return "invalid";
}

/**
 * Derive the subject, longitudinal and events tables from the files and the
 * confirmed map. The subject key becomes the study's pseudonym; a column the map
 * (or the profiler) calls an identifier is never carried; a row with no subject
 * key is not a person and is counted rather than kept. Deterministic: rows are
 * sorted, so the same files and the same map give the same bytes.
 *
 * With `asOf`, each file is cut to the rows visible then before anything else
 * reads it — nobody hidden by the date reaches the roster, the identity map or
 * an outcome — and what was cut is counted (`not_yet_visible`,
 * `visible_date_missing`, `as_of_undecidable`). Each shape reports the source of
 * every column it carries and is labelled with the weakest of them.
 *
 * @param {{ tables: readonly VcrTableData[], entries: readonly VcrFieldEntry[], key: Buffer,
 *   identifying?: ReadonlySet<string>, asOf?: string | null, fileSource?: string }} input
 * @returns {{ shapes: Partial<Record<"subject" | "longitudinal" | "events", VcrDerivedShape>>,
 *   identity: [string, string][], dropped: Record<string, number>, excluded: { column: string, reason: string }[],
 *   asOf: { at: string, files: VcrAsOfFile[] } | null,
 *   treatment: Record<string, { recorded: number, unknown: number, notApplicable: number, missingReason: string | null }> }}
 */
export function deriveAnalysisShapes({ tables, entries, key, identifying = new Set(), asOf = null, fileSource = "observed" }) {
  /** @type {Record<string, number>} */
  const dropped = {};
  const drop = (/** @type {string} */ reason, count = 1) => { if (count > 0) dropped[reason] = (dropped[reason] ?? 0) + count; };
  /** @type {VcrAsOfFile[]} */
  const replay = [];
  /** @type {Record<string, { recorded: number, unknown: number, notApplicable: number, missingReason: string | null }>} */
  const treatment = {};
  /** @type {{ column: string, reason: string }[]} */
  const excluded = [];
  /** @type {Map<string, string>} */
  const identity = new Map();
  const subjectColumns = /** @type {{ table: string, entry: VcrFieldEntry, name: string }[]} */ ([]);
  /** @type {Map<string, Map<string, Map<string, string>[]>>} id → file → that file's rows for the person */
  const subjectRows = new Map();
  /** Everyone with a key, carried columns or not. @type {Set<string>} */
  const roster = new Set();
  /** @type {VcrDerivedShape} */
  const events = { header: [], rows: [], columns: [], outcomeBearing: true, parameters: [], files: [] };
  /** @type {VcrDerivedShape} */
  const longitudinal = { header: [], rows: [], columns: [], outcomeBearing: false, parameters: [], files: [] };
  /** @type {string[]} */
  const subjectFiles = [];
  let withZero = false;
  let withVisit = false;
  /** @type {string[][]} */
  const eventRows = [];
  /** @type {string[][]} */
  const longRows = [];

  const ordered = [...tables].sort((a, b) => a.name.localeCompare(b.name));
  for (const whole of ordered) {
    const mapped = entries.filter((entry) => entry.table === whole.name);
    const keyEntry = mapped.find((entry) => entry.role === "subject_key");
    let table = whole;
    // A file that derives nothing has nothing to hide, and counting its rows as
    // "not yet visible" would only be noise on the page.
    if (asOf && keyEntry) {
      const replayed = tableVisibleAsOf(whole, entries, asOf);
      table = replayed.table;
      replay.push(replayed.report);
      if (replayed.report.decidable) {
        drop("not_yet_visible", replayed.report.hidden);
        drop("visible_date_missing", replayed.report.undated);
      } else drop("as_of_undecidable", whole.rows.length);
    }
    const at = new Map(table.header.map((name, index) => [name, index]));
    const cell = (/** @type {string[]} */ row, /** @type {VcrFieldEntry | undefined} */ entry) => (entry ? row[at.get(entry.column) ?? -1] ?? "" : "");
    if (!keyEntry) continue;

    const carried = mapped.filter((entry) => {
      if (entry.role !== "arm" && entry.role !== "covariate") return false;
      if (entry.identifier) { excluded.push({ column: entry.column, reason: "identifier" }); return false; }
      if (identifying.has(entry.column)) { excluded.push({ column: entry.column, reason: "identifying" }); return false; }
      return true;
    });
    for (const entry of carried) subjectColumns.push({ table: table.name, entry, name: analysisNameOf(entry) });
    if (carried.length) subjectFiles.push(table.name);
    const pairs = mapped.filter((entry) => entry.role === "outcome_time").map((time) => ({
      time, event: mapped.find((entry) => entry.role === "outcome_event" && entry.parameter === time.parameter),
    })).filter((pair) => pair.event);
    const measures = mapped.filter((entry) => entry.role === "measurement" && !entry.identifier);
    const zero = mapped.find((entry) => entry.role === "time_zero");
    const visit = mapped.find((entry) => entry.role === "visit_date");
    if (zero && pairs.length) withZero = true;
    if (visit && measures.length) withVisit = true;
    if (pairs.length) events.files.push(table.name);
    if (measures.length) longitudinal.files.push(table.name);
    for (const pair of pairs) {
      events.parameters.push(String(pair.time.parameter));
      const eventEntry = /** @type {VcrFieldEntry} */ (pair.event);
      events.columns.push(
        { source: pair.time.column, name: "AVAL", valueSource: columnSourceOf(pair.time, fileSource) },
        { source: eventEntry.column, name: "CNSR", valueSource: columnSourceOf(eventEntry, fileSource) },
      );
    }
    if (zero && pairs.length) events.columns.push({ source: zero.column, name: "STARTDT", valueSource: columnSourceOf(zero, fileSource) });
    for (const measure of measures) {
      longitudinal.parameters.push(String(measure.parameter));
      longitudinal.columns.push({ source: measure.column, name: "AVAL", valueSource: columnSourceOf(measure, fileSource) });
      if (measure.outcome) longitudinal.outcomeBearing = true;
    }
    if (visit && measures.length) longitudinal.columns.push({ source: visit.column, name: "ADT", valueSource: columnSourceOf(visit, fileSource) });

    for (const row of table.rows) {
      const rawId = cell(row, keyEntry).trim();
      if (!rawId) { drop("blank_subject_key"); continue; }
      const id = pseudonymOf(key, rawId);
      identity.set(id, rawId);
      roster.add(id);
      if (carried.length) {
        const values = new Map(carried.map((entry) => [analysisNameOf(entry), armCoded(cell(row, entry).trim(), entry, drop, (evidence, reason) => {
          if (entry.role !== "arm") return;
          const tally = treatment[analysisNameOf(entry)] ??= { recorded: 0, unknown: 0, notApplicable: 0, missingReason: null };
          if (evidence === "recorded") tally.recorded += 1;
          else if (evidence === "not_applicable") tally.notApplicable += 1;
          else { tally.unknown += 1; tally.missingReason = reason; }
        })]));
        const perFile = subjectRows.get(id) ?? new Map();
        perFile.set(table.name, [...(perFile.get(table.name) ?? []), values]);
        subjectRows.set(id, perFile);
      }
      for (const pair of pairs) {
        const time = cell(row, pair.time).trim();
        const flag = eventFlag(cell(row, pair.event), /** @type {VcrFieldEntry} */ (pair.event));
        if (!time || flag === null) { drop("outcome_incomplete"); continue; }
        const censor = flag === 1 ? "0" : flag === 0 ? "1" : cell(row, pair.event).trim();
        eventRows.push([id, String(pair.time.parameter), time, censor, ...(zero ? [cell(row, zero).trim()] : [])]);
      }
      for (const measure of measures) {
        const value = cell(row, measure).trim();
        if (!value) continue;
        longRows.push([id, String(measure.parameter), value, ...(visit ? [cell(row, visit).trim()] : [])]);
      }
    }
  }

  /** @type {Partial<Record<"subject" | "longitudinal" | "events", VcrDerivedShape>>} */
  const shapes = {};
  // A replay that leaves nobody visible leaves no tables: a registered table of
  // zero rows would read as "the cohort is empty", and the reason is not that.
  if (asOf && roster.size === 0) {
    return { shapes, identity: [], dropped, excluded, treatment, asOf: { at: asOf, files: replay } };
  }
  if (subjectColumns.length) {
    const names = subjectColumns.map((entry) => entry.name);
    /** @type {string[][]} */
    const rows = [];
    for (const id of [...roster].sort()) {
      const perFile = [...(subjectRows.get(id)?.values() ?? [])];
      // One row per person, its columns joined across files. A file that repeats
      // a person keeps the repeats as rows of their own — the table then says
      // `duplicate-subject-id` and is refused — and every other file's values
      // join each of them.
      const count = Math.max(1, ...perFile.map((versions) => versions.length));
      for (let index = 0; index < count; index += 1) {
        const joined = new Map();
        for (const versions of perFile) for (const [name, value] of versions[Math.min(index, versions.length - 1)]) joined.set(name, value);
        rows.push([id, ...names.map((name) => joined.get(name) ?? "")]);
      }
    }
    shapes.subject = {
      header: ["USUBJID", ...names], rows, outcomeBearing: subjectColumns.some((item) => item.entry.outcome === true), parameters: [], files: subjectFiles,
      columns: subjectColumns.map((entry) => ({ source: entry.entry.column, name: entry.name, valueSource: columnSourceOf(entry.entry, fileSource) })),
    };
  } else if (roster.size) {
    // Subjects with a key and nothing carried: the subject table is the roster.
    shapes.subject = {
      header: ["USUBJID"], rows: [...roster].sort().map((id) => [id]), outcomeBearing: false, parameters: [], files: [], columns: [],
    };
  }
  if (eventRows.length) {
    events.header = ["USUBJID", "PARAMCD", "AVAL", "CNSR", ...(withZero ? ["STARTDT"] : [])];
    events.rows = eventRows.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
    shapes.events = events;
  }
  if (longRows.length) {
    longitudinal.header = ["USUBJID", "PARAMCD", "AVAL", ...(withVisit ? ["ADT"] : [])];
    longitudinal.rows = longRows.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]) || (a[3] ?? "").localeCompare(b[3] ?? ""));
    shapes.longitudinal = longitudinal;
  }
  // Each shape says what every value column of it is, and is labelled with the
  // weakest of them. The key and the parameter code are identifiers, not values.
  for (const shape of Object.values(shapes)) {
    /** @type {Record<string, string>} */
    const columnSources = {};
    for (const column of shape.columns) {
      columnSources[column.name] = column.name in columnSources ? weakestSource([columnSources[column.name], column.valueSource], fileSource) : column.valueSource;
    }
    shape.columnSources = columnSources;
    shape.valueSource = weakestSource(Object.values(columnSources), fileSource);
  }
  return {
    shapes, identity: [...identity.entries()].sort((a, b) => a[0].localeCompare(b[0])), dropped, excluded, treatment,
    asOf: asOf ? { at: asOf, files: replay } : null,
  };
}

// ---------------------------------------------------------------------------
// Writing content-addressed files
// ---------------------------------------------------------------------------

/**
 * Write bytes into the plane under their own hash, once. The same bytes are the
 * same file, so a repeat costs nothing and an earlier job's input is never
 * rewritten.
 * @param {string} root @param {string} directory relative, POSIX @param {string} extension @param {Buffer | string} bytes
 * @returns {Promise<{ location: string, sha256: string, bytes: number }>}
 */
export async function writeContentAddressed(root, directory, extension, bytes) {
  const buffer = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
  const sha256 = sha256OfBytes(buffer);
  const location = path.posix.join(directory, `${sha256}.${extension}`);
  const file = assertDataPlaneLocation(root, location);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o755 });
  const present = await fs.stat(file).then((stat) => stat.isFile() && stat.size === buffer.length, () => false);
  if (!present) {
    const partial = `${file}.${randomUUID()}.part`;
    try {
      await fs.writeFile(partial, buffer, { mode: 0o644 });
      await fs.rename(partial, file);
    } catch (error) {
      await fs.rm(partial, { force: true }).catch(() => {});
      throw error;
    }
  }
  return { location, sha256, bytes: buffer.length };
}

/**
 * A copy of a table with some columns dropped, some renamed and the subject key
 * pseudonymised — what the engine reads when the file itself may not be read
 * whole. The key column, when the table has one, always becomes `USUBJID`.
 * @param {{ header: string[], rows: string[][] }} table
 * @param {{ keep: readonly string[], rename?: Record<string, string>, keyColumn?: string | null, key?: Buffer | null }} options
 */
export function projectTable(table, { keep, rename = {}, keyColumn = null, key = null }) {
  const at = new Map(table.header.map((name, index) => [name, index]));
  const kept = table.header.filter((name) => keep.includes(name) && name !== keyColumn);
  const header = [...(keyColumn && key ? ["USUBJID"] : []), ...kept.map((name) => rename[name] ?? name)];
  const keyAt = keyColumn ? at.get(keyColumn) ?? -1 : -1;
  const rows = [];
  for (const row of table.rows) {
    const cells = kept.map((name) => row[at.get(name) ?? -1] ?? "");
    if (keyColumn && key) {
      const rawId = String(row[keyAt] ?? "").trim();
      // A row that belongs to nobody is not carried: there is no person to key it to.
      if (!rawId) continue;
      cells.unshift(pseudonymOf(key, rawId));
    }
    rows.push(cells);
  }
  return { header, rows };
}

// ---------------------------------------------------------------------------
// The profiler and the workbook reader: separate processes, bounded
// ---------------------------------------------------------------------------

/** What a child process the plane starts may take. */
export const VCR_PROFILER_LIMITS = Object.freeze({ timeoutMs: 120_000, maxOutputBytes: 16 * 1024 * 1024, maxErrorBytes: 64 * 1024 });

/** The environment a helper process gets: no secret of the control plane, nothing it does not need. */
function helperEnv() {
  return { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" };
}

/**
 * Run the helper script and answer its stdout — under a clock and an output
 * ceiling, and killed when either is passed. A profile of a 50 MB file takes
 * seconds; one that takes two minutes, or writes sixteen megabytes of JSON, is
 * not a profile.
 * @param {string[]} args @param {string} stdin @param {{ python?: string, timeoutMs?: number, maxOutputBytes?: number }} [options]
 * @returns {Promise<{ code: number, out: string, err: string }>}
 */
function runPython(args, stdin, options = {}) {
  const python = options.python ?? process.env.OPEN_SCIENCE_PYTHON ?? "python3";
  const timeoutMs = options.timeoutMs ?? VCR_PROFILER_LIMITS.timeoutMs;
  const maxOut = options.maxOutputBytes ?? VCR_PROFILER_LIMITS.maxOutputBytes;
  return new Promise((resolve, reject) => {
    const child = spawn(python, args, { stdio: ["pipe", "pipe", "pipe"], env: helperEnv() });
    let out = "";
    let outBytes = 0;
    let err = "";
    let settled = false;
    /** @param {(value: any) => void} done @param {any} value */
    const finish = (done, value) => { if (settled) return; settled = true; clearTimeout(timer); done(value); };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(reject, refuse(504, VCR_DATA_PLANE_CODES.profilerTimeout, `The snapshot profiler ran longer than ${Math.round(timeoutMs / 1000)} seconds and was stopped.`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      outBytes += Buffer.byteLength(chunk);
      if (outBytes > maxOut) {
        child.kill("SIGKILL");
        finish(reject, refuse(500, VCR_DATA_PLANE_CODES.profilerTooLarge, "The snapshot profiler wrote more output than a profile can hold."));
        return;
      }
      out += chunk;
    });
    child.stderr.on("data", (chunk) => { if (err.length < VCR_PROFILER_LIMITS.maxErrorBytes) err += chunk; });
    child.on("error", (error) => finish(reject, refuse(500, VCR_DATA_PLANE_CODES.profilerFailed, `The snapshot profiler could not start: ${error.message}`)));
    child.on("close", (code) => finish(resolve, { code: code ?? -1, out, err }));
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });
}

/**
 * Run `scripts/vcr/profile_snapshot.py` and parse its JSON. The profiler is a
 * separate process on purpose: it is the same deterministic code the capability
 * already uses for dataset scoping, it holds no database handle, and it is the
 * only thing in this module that ever looks at a cell's value.
 * @param {{ files: string[], tableNames?: string[], fieldMap: any, sealedFields: string[], asOf: string | null, script?: string,
 *   python?: string, timeoutMs?: number, maxOutputBytes?: number }} input
 */
export async function runSnapshotProfiler(input) {
  const script = input.script ?? VCR_PROFILER_SCRIPT;
  const args = [script, ...input.files, "--json", "-", "--min-cell-size", String(VCR_MIN_CELL_SIZE)];
  for (const name of input.tableNames ?? []) args.push(`--table-name=${name}`);
  if (input.sealedFields?.length) args.push(`--sealed-fields=${input.sealedFields.join(",")}`);
  if (input.asOf) args.push(`--as-of=${input.asOf}`);
  const { code, out, err } = await runPython(args, JSON.stringify(input.fieldMap ?? {}), input);
  if (code !== 0) {
    throw refuse(500, VCR_DATA_PLANE_CODES.profilerFailed, `The snapshot profiler failed (exit ${code}): ${err.trim().slice(0, 400)}`);
  }
  try { return JSON.parse(out); } catch (error) {
    throw refuse(500, VCR_DATA_PLANE_CODES.profilerFailed, `The snapshot profiler wrote no JSON: ${String(error)}`);
  }
}

/**
 * One worksheet of a workbook, as CSV text. Standard-library Python only (the
 * web image has nothing else); see the converter's own notes for what it reads.
 * @param {{ file: string, sheet?: string | null, python?: string, script?: string }} input
 * @returns {Promise<{ csv: string, sheets: string[], used: string }>}
 */
export async function convertWorkbook(input) {
  const target = `${input.file}.converted.csv`;
  try {
    const args = [input.script ?? VCR_PROFILER_SCRIPT, `--convert-xlsx=${input.file}`, `--to=${target}`, ...(input.sheet ? [`--sheet=${input.sheet}`] : [])];
    const { code, out, err } = await runPython(args, "", input);
    if (code !== 0) {
      throw refuse(422, VCR_DATA_PLANE_CODES.fileUnreadable, err.replace(/^xlsx:\s*/, "").trim().slice(0, 300) || "The workbook could not be read.");
    }
    const info = JSON.parse(out || "{}");
    return { csv: await fs.readFile(target, "utf8"), sheets: Array.isArray(info.sheets) ? info.sheets : [], used: String(info.used ?? "") };
  } finally {
    await fs.rm(target, { force: true }).catch(() => {});
  }
}

/**
 * What the model may know of a column of the stored profile: its name, its
 * shape, and a vocabulary as levels of at least the floor. Nothing here is a
 * value below the floor: the profiler never stored one, and a fill count that
 * would give a small group away is withheld with its complement.
 * @param {string} table @param {any} column @param {number} rows @param {Set<string>} declaredIdentifiers @param {number} floor
 */
function columnForModel(table, column, rows, declaredIdentifiers, floor) {
  const identifying = column.vocabulary?.identifying === true || declaredIdentifiers.has(column.name);
  const filled = typeof column.filled === "number" ? column.filled : null;
  const total = typeof column.rows === "number" ? column.rows : rows;
  // A count of people in [1, floor - 1] is not shown, and neither is its
  // complement: with the rows published, one gives the other.
  const small = filled !== null && ((filled >= 1 && filled < floor) || (total - filled >= 1 && total - filled < floor));
  return {
    table, name: column.name, sealed: false,
    inferredType: column.inferredType ?? null,
    filled: small ? null : filled, rows: total >= floor || total === 0 ? total : null,
    densityCompleteness: small ? null : (column.densityCompleteness ?? null),
    distinct: column.distinct ?? null,
    identifying,
    levels: identifying ? [] : (column.vocabulary?.values ?? []).map((/** @type {any[]} */ pair) => ({ level: String(pair[0]), n: Number(pair[1]) })),
    levelsHidden: identifying ? 0 : Number(column.vocabulary?.suppressedValues ?? 0),
    levelsWithheld: column.vocabulary?.withheld === true,
  };
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

/**
 * @typedef {{ vcrDataPlaneDir?: string, vcrDataMaxBytes?: number, maxFileBytes?: number, vcrIntakeMaxBytes?: number }} VcrDataPlaneConfig
 * @typedef {(input: { files: string[], tableNames?: string[], fieldMap: any, sealedFields: string[], asOf: string | null }) => Promise<any>} VcrProfiler
 */

/** @param {readonly VcrFieldIssue[]} issues */
function issueSummary(issues) {
  return issues.slice(0, 4).map((issue) => issue.message).join(" ") + (issues.length > 4 ? ` 另有 ${issues.length - 4} 处。` : "");
}

/**
 * The field map rows of a snapshot, as the entries they were frozen from. A
 * column's own value source is not a column of `field_maps`; it is read from
 * what the snapshot was frozen with.
 * @param {any[]} rows @param {ReturnType<typeof snapshotFreezeNotes> | null} [frozen] @returns {VcrFieldEntry[]}
 */
function entriesOfRows(rows, frozen = null) {
  const sources = new Map((frozen?.columnSources ?? []).map((/** @type {any} */ item) => [`${item.table}\u0000${item.column}`, String(item.valueSource)]));
  return rows.map((row) => ({
    table: row.tableName ?? "", column: row.columnName, role: row.role ?? "other", concept: row.concept ?? "", unit: row.unit ?? null,
    codingSystem: row.codingSystem ?? null, timeKind: row.timeKind ?? null, missingReason: row.missingReason ?? null,
    identifier: row.identifier === true && row.role !== "subject_key", parameter: row.parameter ?? null, alias: row.alias ?? null,
    type: row.declaredType ?? null, range: Array.isArray(row.range) ? row.range : null, required: row.required === true,
    outcome: row.outcome === true, codes: row.codes ?? {}, valueSource: sources.get(`${row.tableName ?? ""}\u0000${row.columnName}`) ?? null,
  }));
}

/**
 * What a snapshot was frozen with beyond its files: the instant it replays
 * (`asOf`) and the source each column declared for itself. Both live in the
 * snapshot's own profile, which is immutable after the freeze, so a table
 * derived a week later is derived under the same as-of and the same sources.
 * @param {any} snapshot
 * @returns {{ asOf: string | null, asOfFilter: Record<string, unknown> | null, columnSources: { table: string, column: string, valueSource: string }[] }}
 */
export function snapshotFreezeNotes(snapshot) {
  const frozen = snapshot?.profile?.frozen;
  const asOf = typeof frozen?.asOf === "string" && Number.isFinite(Date.parse(frozen.asOf)) ? new Date(Date.parse(frozen.asOf)).toISOString() : null;
  const columnSources = (Array.isArray(frozen?.columnSources) ? frozen.columnSources : [])
    .filter((/** @type {any} */ item) => item && typeof item.column === "string" && VCR_VALUE_SOURCES.includes(item.valueSource))
    .map((/** @type {any} */ item) => ({ table: String(item.table ?? ""), column: item.column, valueSource: item.valueSource }));
  return { asOf, asOfFilter: isObject(frozen?.asOfFilter) ? frozen.asOfFilter : null, columnSources };
}

/**
 * Remove everything the plane holds for one study — uploads, views, derived
 * tables, the identity maps and the pseudonym key (which is what makes a deletion
 * unlinkable) — and nothing else. A study id that is not an id, a directory that
 * is a symlink, and one that does not resolve to a direct child of `studies/` are
 * left alone: a deletion path never follows a link out of the plane.
 * @param {string} root the plane's root @param {string} studyId
 * @returns {Promise<{ removed: boolean }>}
 */
export async function removeStudyDirectory(root, studyId) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(String(studyId ?? ""))) return { removed: false };
  const directory = path.join(root, "studies", studyId);
  const stat = await fs.lstat(directory).catch(() => null);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) return { removed: false };
  const real = await fs.realpath(directory).catch(() => null);
  const realRoot = await fs.realpath(path.join(root, "studies")).catch(() => null);
  if (!real || !realRoot || path.dirname(real) !== realRoot) return { removed: false };
  await fs.rm(directory, { recursive: true, force: true });
  return { removed: true };
}

/**
 * What a method reads of a snapshot, by the engine's own handlers: the raw files
 * to profile, the subject table for a cohort, a synthesis, a MAIC or a
 * weighting, and the events table besides for a time-to-event comparison. A
 * snapshot with no derived table for the shape a method needs is read as its raw
 * files — the engine takes either — and a method this file does not know reads
 * the subject table.
 * @param {string} method @param {string | null} endpointType @param {readonly string[]} derived the shapes the snapshot has
 * @returns {("subject" | "longitudinal" | "events" | "files")[]}
 */
export function tablesNeededBy(method, endpointType, derived) {
  if (method === "profile.snapshot") return ["files"];
  /** @type {("subject" | "events")[]} */
  const wanted = ["subject"];
  // Methods whose outcome is always an event time, and the weighting methods that read one when the endpoint says so.
  const timeToEvent = ["comparator.rmst", "comparator.weighted_cox", "comparator.maic_time_to_event"].includes(method)
    || (["comparator.entropy_balance", "comparator.propensity_weight", "comparator.covariate_sets", "comparator.prognostic_adjustment", "comparator.tipping_point"].includes(method)
      && endpointType === "time_to_event");
  if (timeToEvent) wanted.push("events");
  return wanted.every((shape) => derived.includes(shape)) ? wanted : ["files"];
}

/**
 * The data files of a source as a snapshot sees them: one per name, the latest
 * upload of that name (files come oldest first).
 * @param {any[]} files
 */
export function latestDataFiles(files) {
  /** @type {Map<string, any>} */
  const byName = new Map();
  for (const file of files) if (file.role === "data") byName.set(file.name, file);
  return [...byName.values()];
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const USE_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
/** What a grantee may be: an account id, `role:<role>` or `study:<id>`. */
const ACCOUNT_PATTERN = /^[A-Za-z0-9_.@-]{1,120}$/;

export class VcrDataPlane {
  /**
   * @param {{ store: import("./vcrDataStore.mjs").VcrDataStore, config: VcrDataPlaneConfig, profiler?: VcrProfiler | null,
   *   access?: VcrAccess | null, seal?: { recordOutcomeAccess?: (input: any) => Promise<unknown> } | null,
   *   extractor?: { available: boolean, counters?: Record<string, number>, describe?: () => any, extract: (input: { root: string, studyId: string, path: string, format: string, signal?: AbortSignal }) => Promise<{ text: string, extraction: Record<string, any> }> } | null,
   *   importer?: { available: boolean, counters?: Record<string, number>, describe?: () => any, run: (input: any, consume: (done: any) => Promise<any>) => Promise<any> } | null,
   *   now?: () => Date }} options
   *   `access` judges every operation (one is made from the store when none is
   *   given); `seal` records the first outcome read — it is composed after the
   *   plane, so `attach` also takes it. `extractor` turns a PDF or Word record
   *   into text inside the deployment; without one those two formats are refused
   *   by name and plain text is unaffected. `importer` does the same for a source
   *   held in FHIR, OMOP or ADaM (`importStandard`); without one the import is
   *   refused by name and ordinary uploads are unaffected.
   */
  constructor({ store, config, profiler = null, access = null, seal = null, extractor = null, importer = null, now = () => new Date() }) {
    if (!store) throw new TypeError("The VCR data plane needs its store.");
    this.store = store;
    this.config = config ?? {};
    this.now = now;
    this.profiler = profiler ?? ((input) => runSnapshotProfiler(input));
    this.access = access ?? new VcrAccess({ store, now });
    // A page reads what a member may see without writing a ledger row per source
    // per load; the judgments that matter (a read of rows, a write) go through `access`.
    this.pageAccess = new VcrAccess({ store, now, audit: false });
    this.seal = seal;
    this.extractor = extractor;
    this.importer = importer;
  }

  /** Attach a package composed after the plane (the seal). @param {{ seal?: any }} packages */
  attach(packages) {
    if (packages?.seal) this.seal = packages.seal;
    return this;
  }

  /** Is the data plane composed at all? Unset means every tier above T0 says so by name. */
  get configured() {
    return Boolean(String(this.config.vcrDataPlaneDir ?? "").trim());
  }

  /** The most a data file may hold, in bytes. */
  get maxBytes() {
    const configured = Number(this.config.vcrDataMaxBytes ?? this.config.maxFileBytes);
    return Number.isSafeInteger(configured) && configured > 0 ? configured : VCR_UPLOAD_DEFAULT_MAX_BYTES;
  }

  /**
   * What a patient record document may be on this deployment: text always, PDF
   * and Word when a converter is composed. The page offers only what would be taken.
   */
  documentUpload() {
    const converter = Boolean(this.extractor?.available);
    const configured = Number(this.config.vcrIntakeMaxBytes);
    return {
      formats: converter ? Object.keys(VCR_UPLOAD_FORMATS.document) : Object.keys(VCR_UPLOAD_FORMATS.document).filter((format) => !CONVERTED_DOCUMENT_FORMATS.includes(format)),
      textMaxBytes: Math.min(this.maxBytes, VCR_UPLOAD_ROLE_CAPS.document),
      convertedMaxBytes: converter ? Math.min(this.maxBytes, configured > 0 ? configured : 25 * 1024 * 1024) : null,
      converter,
    };
  }

  /**
   * What a source may be imported from on this deployment: the three standards
   * when a converter is composed, and what each is uploaded as. The page offers
   * only what would be taken.
   */
  importUpload() {
    const described = this.importer?.available ? this.importer.describe?.() : null;
    return {
      available: Boolean(described?.available),
      formats: described?.available ? described.formats : [],
      maxBytes: described?.available ? described.maxBytes : null,
    };
  }

  /** The resolved root, or a named refusal. */
  root() {
    return assertDataPlaneRoot(this.config.vcrDataPlaneDir ?? "");
  }

  /** @param {string} location */
  resolve(location) {
    return assertDataPlaneLocation(this.config.vcrDataPlaneDir ?? "", location);
  }

  // -------------------------------------------------------------------------
  // Who may do what, and to what
  // -------------------------------------------------------------------------

  /**
   * The study for an operation that manages data: the caller must hold
   * `manage_data` in it. A study that is another account's answers exactly as
   * one that does not exist (AC-17).
   * @param {string} studyId @param {string} actor
   */
  async #manager(studyId, actor) {
    if (!ID_PATTERN.test(String(studyId ?? ""))) throw refuse(404, VCR_DATA_PLANE_CODES.studyNotFound, "Study not found.");
    await this.access.require({ actor: String(actor ?? ""), studyId, ability: "manage_data" });
    const study = await this.store.studyForAccess(studyId);
    if (!study) throw refuse(404, VCR_DATA_PLANE_CODES.studyNotFound, "Study not found.");
    return study;
  }

  /** A source of this study, or the refusal a source that does not exist gets. @param {string} studyId @param {string} sourceId */
  async #source(studyId, sourceId) {
    const source = ID_PATTERN.test(String(sourceId ?? "")) ? await this.store.sourceInStudy(studyId, sourceId) : null;
    if (!source) throw refuse(404, VCR_DATA_PLANE_CODES.sourceNotFound, "Data source not found.");
    return source;
  }

  /** A snapshot of this study, or the same refusal. @param {string} studyId @param {string} snapshotId */
  async #snapshot(studyId, snapshotId) {
    const snapshot = ID_PATTERN.test(String(snapshotId ?? "")) ? await this.store.getSnapshot(snapshotId) : null;
    if (!snapshot || snapshot.studyId !== studyId) throw refuse(404, VCR_DATA_PLANE_CODES.snapshotNotFound, "Snapshot not found.");
    return snapshot;
  }

  /** @param {any} source */
  #assertOpen(source) {
    if (source.status === "withdrawn") throw refuse(403, "vcr_source_withdrawn", "The data source was withdrawn and takes no more files.");
  }

  // -------------------------------------------------------------------------
  // Step 1: the source
  // -------------------------------------------------------------------------

  /**
   * Register a data source: whose it is, what it may be used for, what window
   * is visible and how long it is kept (plan §8.1 step 1). The account that
   * registers it is its owner — the one who may grant others a read of its rows.
   * @param {{ userId: string, studyId: string, name: string, ownerParty?: string, allowedUses?: string[],
   *   visibleWindow?: Record<string, unknown>, retention?: Record<string, unknown>, format?: string,
   *   valueSource?: string, actor?: string }} entry
   */
  async registerSource(entry) {
    this.root();
    await this.#manager(entry.studyId, entry.userId);
    const name = text(entry.name);
    if (!name || name.length > 80 || hasControl(name)) throw refuse(400, VCR_DATA_PLANE_CODES.payloadInvalid, "A source name is one line of 1 to 80 characters.");
    const ownerParty = entry.ownerParty == null ? "" : text(entry.ownerParty);
    if (ownerParty.length > 80) throw refuse(400, VCR_DATA_PLANE_CODES.payloadInvalid, "ownerParty is at most 80 characters.");
    const uses = entry.allowedUses == null ? ["vcr"] : entry.allowedUses;
    if (!Array.isArray(uses) || uses.length > 20 || uses.some((use) => typeof use !== "string" || !USE_PATTERN.test(use))) {
      throw refuse(400, VCR_DATA_PLANE_CODES.payloadInvalid, "allowedUses is up to 20 lowercase words, like vcr or matching.");
    }
    const format = entry.format == null ? "csv" : entry.format;
    if (!VCR_SOURCE_FORMATS.includes(format)) throw refuse(400, VCR_DATA_PLANE_CODES.payloadInvalid, `format is one of: ${VCR_SOURCE_FORMATS.join(", ")}.`);
    const valueSource = entry.valueSource == null ? "observed" : entry.valueSource;
    if (!VCR_VALUE_SOURCES.includes(valueSource)) throw refuse(400, VCR_DATA_PLANE_CODES.payloadInvalid, `valueSource is one of: ${VCR_VALUE_SOURCES.join(", ")}.`);
    const window = isObject(entry.visibleWindow) ? entry.visibleWindow : {};
    const retention = isObject(entry.retention) ? entry.retention : {};
    /** @param {unknown} value @param {string} field */
    const instant = (value, field) => {
      if (value == null || value === "") return null;
      const parsed = typeof value === "string" ? Date.parse(value) : Number.NaN;
      if (!Number.isFinite(parsed)) throw refuse(400, VCR_DATA_PLANE_CODES.payloadInvalid, `${field} is a date.`);
      return new Date(parsed).toISOString();
    };
    const start = instant(window.start, "visibleWindow.start");
    const end = instant(window.end, "visibleWindow.end");
    if (start && end && Date.parse(start) > Date.parse(end)) throw refuse(400, VCR_DATA_PLANE_CODES.payloadInvalid, "The visible window ends before it starts.");
    const until = instant(retention.until, "retention.until");
    const note = retention.note == null ? "" : text(retention.note).slice(0, 200);
    return this.store.createSource({
      userId: String(entry.userId), studyId: entry.studyId, name, ownerParty, allowedUses: uses, format, valueSource,
      visibleWindow: { ...(start ? { start } : {}), ...(end ? { end } : {}) },
      retention: { ...(until ? { until } : {}), ...(note ? { note } : {}) },
      actor: entry.actor ?? String(entry.userId),
    });
  }

  // -------------------------------------------------------------------------
  // Step 2: a file
  // -------------------------------------------------------------------------

  /**
   * Take one file into a source. The bytes are streamed to the plane under a cap
   * (never buffered whole on the way in), made readable (encoding, JSON, a
   * workbook's first sheet), checked to be a table with a header and no column
   * twice, profiled once so the run has the shape to propose a field map from,
   * and stored under their own hash. The same bytes twice are the same file.
   *
   * Answers the stored file and whether it is new, and `upload`: what THIS request
   * delivered — its role, the format it arrived in, its size and the SHA-256 of
   * its bytes. They can differ from the stored row's (a re-saved PDF with the same
   * text is the file already held), and they are what an audit line may say of the
   * upload (`uploadAuditDetail`), since it may not say the file's name.
   *
   * @param {{ actor: string, studyId: string, sourceId: string, name: string, role?: string,
   *   stream: AsyncIterable<Buffer | Uint8Array>, declaredLength?: number | null, subject?: string | null,
   *   visibleAt?: string | null, sheet?: string | null, importedFrom?: Record<string, any> | null }} entry
   */
  async storeUpload(entry) {
    this.root();
    await this.#manager(entry.studyId, entry.actor);
    const source = await this.#source(entry.studyId, entry.sourceId);
    this.#assertOpen(source);
    return this.#storeChecked(entry, source);
  }

  /**
   * The body of `storeUpload`, after the caller has been judged and the source
   * found: a standard-format import stores each converted table through it, one
   * judgment for the import and not one per table.
   * @param {Parameters<VcrDataPlane["storeUpload"]>[0]} entry @param {any} source
   */
  async #storeChecked(entry, source) {
    const root = this.root();
    const role = entry.role == null ? "data" : entry.role;
    if (!VCR_SOURCE_FILE_ROLES.includes(role)) throw refuse(400, VCR_DATA_PLANE_CODES.payloadInvalid, `role is one of: ${VCR_SOURCE_FILE_ROLES.join(", ")}.`);
    const named = safeUploadName(entry.name, role);
    const needsConversion = role === "document" && CONVERTED_DOCUMENT_FORMATS.includes(named.format);
    // A PDF or Word file is bigger than the text in it: it has its own ceiling
    // (`vcrIntakeMaxBytes`), and the text that comes out is held to the document cap below.
    const cap = needsConversion
      ? Math.min(this.maxBytes, Number(this.config.vcrIntakeMaxBytes) > 0 ? Number(this.config.vcrIntakeMaxBytes) : 25 * 1024 * 1024)
      : Math.min(this.maxBytes, /** @type {Record<string, number>} */ (VCR_UPLOAD_ROLE_CAPS)[role] ?? this.maxBytes);
    // A PDF or Word file refused for its size is counted with the conversions' other outcomes.
    const countTooLarge = () => { if (needsConversion && this.extractor?.counters) this.extractor.counters.tooLarge = (this.extractor.counters.tooLarge ?? 0) + 1; };
    if (entry.declaredLength != null && entry.declaredLength > cap) {
      countTooLarge();
      throw refuse(413, VCR_DATA_PLANE_CODES.fileTooLarge, `A ${role} file is at most ${cap} bytes.`, { cap });
    }

    const incoming = path.join(root, studyRelative(entry.studyId), "incoming");
    await fs.mkdir(incoming, { recursive: true, mode: 0o755 });
    const stem = randomUUID();
    const raw = path.join(incoming, `${stem}.upload`);
    /** @type {string[]} */
    const scratch = [raw];
    try {
      const handle = await fs.open(raw, "wx", 0o600);
      const digest = createHash("sha256");
      let total = 0;
      try {
        for await (const chunk of entry.stream) {
          total += chunk.length;
          if (total > cap) { countTooLarge(); throw refuse(413, VCR_DATA_PLANE_CODES.fileTooLarge, `A ${role} file is at most ${cap} bytes.`, { cap }); }
          digest.update(chunk);
          await handle.write(chunk);
        }
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw refuse(400, VCR_DATA_PLANE_CODES.fileUnreadable, "The upload was interrupted before it finished.");
      } finally {
        await handle.close();
      }
      if (!total) throw refuse(422, VCR_DATA_PLANE_CODES.fileUnreadable, "The file is empty.");
      const originalSha256 = digest.digest("hex");

      /** @type {Record<string, any>} */
      const detail = { originalName: named.name, originalSha256, originalBytes: total };
      // A table a standard-format import produced says so, and of what: the standard, the converter and the upload's hash.
      if (entry.importedFrom) detail.import = entry.importedFrom;
      /** @type {Buffer} */
      let bytes;
      let extension = "csv";
      /** @type {{ header: string[], rows: string[][], renamed?: number } | null} */
      let table = null;
      /** The converted original's place in the plane, when there is one. @type {string | null} */
      let originalLocation = null;
      if (role === "document") {
        /** @type {string} */
        let documentText;
        if (needsConversion) {
          // Converted inside the deployment, never sent to the external parsing
          // service: the original goes to a container with no network and comes back
          // as text (vcrRecordExtract.mjs). The original's bytes stay here, in the
          // plane, beside the text — provenance, never read by a runtime.
          if (!this.extractor?.available) {
            throw refuse(503, VCR_DATA_PLANE_CODES.documentConverterUnavailable, "This deployment cannot convert PDF or Word files; supply a text version.");
          }
          const got = await this.extractor.extract({ root, studyId: entry.studyId, path: raw, format: named.format });
          documentText = got.text;
          const originalBytes = await fs.readFile(raw);
          const original = await writeContentAddressed(root, path.posix.join(studyRelative(entry.studyId), "documents"), named.format, originalBytes);
          originalLocation = original.location;
          detail.original = { sha256: original.sha256, bytes: original.bytes, format: named.format, location: original.location };
          detail.extraction = got.extraction;
        } else {
          const decoded = decodeUploadText(await fs.readFile(raw));
          documentText = decoded.text;
          detail.encoding = decoded.encoding;
        }
        if (Buffer.byteLength(documentText, "utf8") > VCR_UPLOAD_ROLE_CAPS.document) {
          throw refuse(413, VCR_DATA_PLANE_CODES.fileTooLarge, `The text of a document is at most ${VCR_UPLOAD_ROLE_CAPS.document} bytes.`, { cap: VCR_UPLOAD_ROLE_CAPS.document });
        }
        bytes = Buffer.from(documentText, "utf8");
        extension = "txt";
        detail.chars = documentText.length;
        if (entry.subject != null && entry.subject !== "") {
          detail.subjectKey = pseudonymOf(await studyPseudonymKey(root, entry.studyId), entry.subject);
        }
        if (entry.visibleAt != null && entry.visibleAt !== "") {
          const stamp = Date.parse(String(entry.visibleAt));
          if (!Number.isFinite(stamp)) throw refuse(400, VCR_DATA_PLANE_CODES.payloadInvalid, "visibleAt is a date.");
          detail.visibleAt = new Date(stamp).toISOString();
        }
      } else {
        /** @type {string} */
        let body;
        if (named.format === "xlsx") {
          const workbook = `${raw}.xlsx`;
          scratch.push(workbook);
          await fs.rename(raw, workbook);
          const converted = await convertWorkbook({ file: workbook, sheet: entry.sheet ?? null });
          body = converted.csv;
          Object.assign(detail, { sheets: converted.sheets, sheetUsed: converted.used });
          scratch.push(`${workbook}.converted.csv`);
        } else {
          const decoded = decodeUploadText(await fs.readFile(raw));
          detail.encoding = decoded.encoding;
          body = named.format === "json" ? toCsv(...(() => { const parsed = jsonTable(decoded.text); return /** @type {[string[], string[][]]} */ ([parsed.header, parsed.rows]); })()) : decoded.text;
          if (named.format === "tsv") detail.delimiter = "tab";
        }
        table = checkedTable(body, named.format === "tsv" ? "\t" : ",");
        if (table.renamed) detail.renamedBlankHeaders = table.renamed;
        bytes = Buffer.from(toCsv(table.header, table.rows), "utf8");
      }

      const directory = role === "document"
        ? path.posix.join(studyRelative(entry.studyId), "documents")
        : path.posix.join(studyRelative(entry.studyId), "sources", entry.sourceId);
      const written = await writeContentAddressed(root, directory, extension, bytes);
      // A corrected re-upload under the same name is a new version of that file
      // (its own bytes, its own row); a snapshot takes the latest of each name
      // unless it is told which files, so the field map — which names files by
      // display name — keeps meaning the same table.
      // A patient document is the one file whose name is not kept: a chart's file
      // name is the patient's name or number more often than not, and the name is
      // shown on the page, kept in the ledger and read by every member.
      const displayName = role === "document" ? `document-${written.sha256.slice(0, 8)}.txt` : named.name;
      if (role === "document") delete detail.originalName;

      let rowCount = null;
      let columnCount = null;
      /** @type {Record<string, any>} */
      let profile = {};
      if (role === "data") {
        const profiled = path.join(incoming, `${stem}.csv`);
        scratch.push(profiled);
        await fs.writeFile(profiled, bytes, { mode: 0o600 });
        const result = await this.profiler({ files: [profiled], tableNames: [displayName], fieldMap: {}, sealedFields: [], asOf: null });
        rowCount = result?.snapshot?.rowCount ?? table?.rows.length ?? null;
        columnCount = result?.snapshot?.columnCount ?? table?.header.length ?? null;
        profile = slimProfile(result);
      } else if (role === "dictionary" && table) {
        detail.dictionary = dictionaryEntries(table);
        rowCount = table.rows.length;
        columnCount = table.header.length;
      }
      const stored = await this.store.addSourceFile({
        sourceId: entry.sourceId, studyId: entry.studyId, userId: String(entry.actor), role, name: displayName,
        // What is stored is text, whatever it was converted from: a document row's format is the stored bytes'.
        format: role === "document" ? "txt" : named.format, location: written.location, sha256: written.sha256, bytes: written.bytes, rowCount, columnCount,
        profile, detail, actor: String(entry.actor),
      });
      if (source.status === "registered" && role === "data") {
        await this.store.setSourceStatus({ sourceId: entry.sourceId, status: "profiled", actor: String(entry.actor), userId: source.userId });
      }
      // The same text from a different file (a re-saved PDF) is the file already
      // held: the original written for this attempt is then not named by any row.
      if (originalLocation && stored.file.detail?.original?.location !== originalLocation) {
        await this.#dropUnnamedOriginal(entry.studyId, originalLocation);
      }
      return { ...stored, upload: { role, format: named.format, bytes: total, sha256: originalSha256 } };
    } finally {
      for (const file of scratch) await fs.rm(file, { force: true }).catch(() => {});
    }
  }

  /**
   * Forget a file no snapshot names. Its bytes go with the row: an upload that
   * was a mistake should not outlive the correction.
   * @param {{ actor: string, studyId: string, fileId: string }} entry
   */
  async removeUpload(entry) {
    const root = this.root();
    await this.#manager(entry.studyId, entry.actor);
    if (!ID_PATTERN.test(String(entry.fileId ?? ""))) throw refuse(404, VCR_DATA_PLANE_CODES.fileNotFound, "File not found.");
    const { removed, frozen } = await this.store.deleteSourceFile({ studyId: entry.studyId, fileId: entry.fileId, actor: String(entry.actor) });
    if (frozen) throw refuse(409, VCR_DATA_PLANE_CODES.fileFrozen, "A snapshot holds this file; a frozen snapshot's files are its own record.");
    if (!removed) throw refuse(404, VCR_DATA_PLANE_CODES.fileNotFound, "File not found.");
    // The same bytes may be another source's file (a re-upload elsewhere): only
    // this row's path is removed, and it is this source's own.
    const stillNamed = (await this.store.listSourceFilesForStudy(entry.studyId)).some((file) => file.location === removed.location);
    if (!stillNamed) await fs.rm(path.join(root, removed.location), { force: true }).catch(() => {});
    // A converted record's original goes with it, unless another row still names it.
    if (removed.detail?.original?.location) await this.#dropUnnamedOriginal(entry.studyId, String(removed.detail.original.location));
    return { removed: true, fileId: removed.id };
  }

  // -------------------------------------------------------------------------
  // Step 2, from a standard: a FHIR, OMOP or ADaM source
  // -------------------------------------------------------------------------

  /**
   * Import a source held in a standard format. The upload is staged in the
   * plane's scratch area, converted in the intake container (no network, no
   * model, no workspace; `vcrImport.mjs`), and what comes back — flat tables,
   * a dictionary generated from the standard and a field map that names each
   * column's concept, unit, code system and VALUE SOURCE — is stored the way a
   * person's own files are: every table goes through the same checks, profile and
   * ledger row as an upload, the field map is a proposal a person confirms, and
   * the original bytes are not kept.
   *
   * A table the plane cannot take is named and the others still land (principle
   * 19): the answer carries, per table, whether it was stored and why not. An
   * import that stores nothing refuses with the first table's own refusal.
   *
   * @param {{ actor: string, studyId: string, sourceId: string, name: string, format: string,
   *   stream: AsyncIterable<Buffer | Uint8Array>, declaredLength?: number | null, signal?: AbortSignal }} entry
   */
  async importStandard(entry) {
    const root = this.root();
    await this.#manager(entry.studyId, entry.actor);
    const source = await this.#source(entry.studyId, entry.sourceId);
    this.#assertOpen(source);
    const format = String(entry.format ?? "");
    if (!Object.hasOwn(VCR_IMPORT_FORMATS, format)) {
      throw refuse(400, VCR_DATA_PLANE_CODES.payloadInvalid, `format is one of: ${Object.keys(VCR_IMPORT_FORMATS).join(", ")}.`);
    }
    if (!this.importer?.available) {
      throw refuse(503, "vcr_import_converter_unavailable", "This deployment cannot convert this format; export it as CSV and upload it as a data file.");
    }
    const extension = importExtensionOf(entry.name, format);
    const ceiling = Number(this.importer.describe?.()?.maxBytes);
    if (entry.declaredLength != null && Number.isFinite(ceiling) && ceiling > 0 && entry.declaredLength > ceiling) {
      throw refuse(413, VCR_DATA_PLANE_CODES.fileTooLarge, `An import file is at most ${ceiling} bytes.`, { cap: ceiling });
    }
    return this.importer.run({ root, studyId: entry.studyId, format, extension, stream: entry.stream, signal: entry.signal }, async (done) => {
      const actor = String(entry.actor);
      // What every table and the dictionary say of where they came from: the standard, the converter and the upload's hash.
      const importedFrom = { format, standard: done.standard, converter: `${done.converter.name} ${done.converter.version}`.trim(), uploadSha256: done.input.sha256 };
      /** @type {{ name: string, file: string, rows: number, bytes: number, columns: number, stored: boolean, created?: boolean, fileId?: string, reason?: string }[]} */
      const tables = [];
      /** @type {any[]} */
      const stored = [];
      for (const table of done.tables) {
        const shown = { name: table.name, file: table.file, rows: table.rows, bytes: table.bytes, columns: table.columns.length };
        const opened = await done.table(table.name);
        try {
          const result = await this.#storeChecked({
            actor, studyId: entry.studyId, sourceId: entry.sourceId, name: table.file, role: "data", stream: opened.stream(), declaredLength: table.bytes,
            importedFrom,
          }, source);
          stored.push(result);
          tables.push({ ...shown, stored: true, created: result.created, fileId: result.file.id });
        } catch (error) {
          if (!(error instanceof HttpError) || error.status >= 500) throw error;
          tables.push({ ...shown, stored: false, reason: String(error.code) });
        } finally {
          await opened.close();
        }
      }
      if (!stored.length) {
        const first = tables.find((table) => !table.stored);
        throw refuse(422, VCR_DATA_PLANE_CODES.fileUnreadable, "No table of the import could be taken into the data plane.", { tables, reason: first?.reason ?? null });
      }
      const keptFiles = new Set(tables.filter((table) => table.stored).map((table) => table.file));
      const keptNames = [...keptFiles].map((file) => `${file.replace(/\.csv$/, "")}.`);
      /** The dictionary's rows of the tables that were taken: a row names `table.column`. */
      const described = done.dictionary.filter((/** @type {any} */ item) => keptNames.some((prefix) => String(item.column).startsWith(prefix)));
      if (described.length) {
        const csv = toCsv(["column", "label", "unit"], described.map((/** @type {any} */ item) => [item.column, item.label, item.unit]));
        await this.#storeChecked({
          actor, studyId: entry.studyId, sourceId: entry.sourceId, name: `${format}-dictionary.csv`, role: "dictionary",
          stream: (async function* () { yield Buffer.from(csv, "utf8"); })(), importedFrom,
        }, source);
      }
      const merged = mergeImportedFieldMap({
        existing: source.fieldMap?.columns ?? [], incoming: done.fieldMap.filter((/** @type {any} */ item) => keptFiles.has(String(item.table))),
        sourceValueSource: source.valueSource,
      });
      const proposed = await this.proposeFieldMap({
        actor, studyId: entry.studyId, sourceId: entry.sourceId, columns: merged.columns, by: "import",
        reason: `Generated from ${done.standard.name ?? format} ${done.standard.release ?? done.standard.version ?? ""}`.trim(),
      });
      return {
        format, standard: done.standard, converter: done.converter, input: { ...done.input, format },
        tables, files: stored.map((result) => result.file), created: stored.filter((result) => result.created).length,
        fieldMap: { hash: proposed.hash, state: proposed.source.fieldMapState, entries: merged.columns.length, trimmed: merged.trimmed,
          columnSourcesDeclared: merged.sourcesDeclared, entryIssues: proposed.entryIssues, mapIssues: proposed.mapIssues },
        coverage: done.coverage,
      };
    });
  }

  /**
   * Remove a converted record's original bytes when no file of the study names them.
   * @param {string} studyId @param {string} location
   */
  async #dropUnnamedOriginal(studyId, location) {
    const root = this.root();
    const named = (await this.store.listSourceFilesForStudy(studyId)).some((file) => file.detail?.original?.location === location);
    if (!named) await fs.rm(assertDataPlaneLocation(root, location), { force: true }).catch(() => {});
  }

  // -------------------------------------------------------------------------
  // Step 3: what the columns mean
  // -------------------------------------------------------------------------

  /**
   * The headers of a source's data files, from what was profiled at upload.
   * @param {any[]} files
   * @returns {{ name: string, header: string[] }[]}
   */
  #tablesOf(files) {
    return latestDataFiles(files).map((file) => ({
      name: file.name,
      header: (file.profile?.tables?.[0]?.columns ?? []).map((/** @type {any} */ column) => String(column.name)),
    }));
  }

  /**
   * Store a proposed field map — by the run or by a person — for a source. Every
   * entry is checked on its own (closed vocabularies, names, ranges) and the
   * whole is checked against the files; a proposal with problems is still
   * stored, with the problems named, because the person confirming it is who
   * fixes them. Nothing is confirmed by being proposed, and an edit withdraws an
   * earlier confirmation.
   * @param {{ actor: string, studyId: string, sourceId: string, columns: unknown, by?: string, reason?: string }} entry
   *   `by` is `run` for the run's proposal, `import` for the map a standard-format import generated, else the person.
   */
  async proposeFieldMap(entry) {
    this.root();
    await this.#manager(entry.studyId, entry.actor);
    const source = await this.#source(entry.studyId, entry.sourceId);
    this.#assertOpen(source);
    const { columns, issues } = normalizeFieldMap(entry.columns);
    const tables = this.#tablesOf(await this.store.listSourceFiles(source.id));
    const whole = validateFieldMap(columns, tables);
    const hash = fieldMapHash(whole.columns.length ? whole.columns : columns);
    const saved = await this.store.saveFieldMapDraft({
      sourceId: source.id, columns: whole.columns.length ? whole.columns : columns, hash,
      by: entry.by === "run" ? "run" : entry.by === "import" ? "import" : String(entry.actor), actor: String(entry.actor), reason: entry.reason ?? "",
    });
    return { source: saved, hash, entryIssues: issues, mapIssues: whole.issues };
  }

  /**
   * A person confirms the map they read: the hash they were shown must still be
   * the map's, and the whole map must hold together against the files. The
   * profiler is run once with the map, so the conformance findings — a declared
   * type the values do not have, a value outside a declared range, a code that is
   * not the coding system's shape — come back with the confirmation. They are
   * advice: the map is confirmed, and each finding is a thing to look at.
   * @param {{ actor: string, studyId: string, sourceId: string, hash: string }} entry
   */
  async confirmFieldMap(entry) {
    const root = this.root();
    await this.#manager(entry.studyId, entry.actor);
    const source = await this.#source(entry.studyId, entry.sourceId);
    this.#assertOpen(source);
    if (source.fieldMapState === "none" || !source.fieldMapHash) {
      throw refuse(409, VCR_DATA_PLANE_CODES.fieldMapUnconfirmed, "There is no field map to confirm yet.");
    }
    if (source.fieldMapHash !== entry.hash) {
      throw refuse(409, VCR_DATA_PLANE_CODES.fieldMapChanged, "The field map changed since it was shown; read it again before confirming.");
    }
    const files = await this.store.listSourceFiles(source.id);
    const data = latestDataFiles(files);
    const whole = validateFieldMap(source.fieldMap.columns, this.#tablesOf(files));
    if (whole.issues.length) {
      throw refuse(422, VCR_DATA_PLANE_CODES.fieldMapInvalid, issueSummary(whole.issues), { issues: whole.issues });
    }
    /** @type {Record<string, number>} */
    let checks = {};
    if (data.length) {
      const result = await this.profiler({
        files: data.map((file) => path.join(root, file.location)), tableNames: data.map((file) => file.name),
        fieldMap: profilerFieldMap(whole.columns), sealedFields: [], asOf: null,
      });
      checks = Object.fromEntries(VCR_QUALITY_CATEGORIES.map((category) => [category, Array.isArray(result?.quality?.[category]) ? result.quality[category].length : 0]));
    }
    const confirmed = await this.store.confirmFieldMapDraft({ sourceId: source.id, hash: entry.hash, by: String(entry.actor), actor: String(entry.actor) });
    if (!confirmed) throw refuse(409, VCR_DATA_PLANE_CODES.fieldMapChanged, "The field map changed since it was shown; read it again before confirming.");
    return { source: confirmed, checks };
  }

  // -------------------------------------------------------------------------
  // Step 4: freeze
  // -------------------------------------------------------------------------

  /**
   * Freeze a source into an immutable snapshot: verify every file's bytes,
   * validate the whole confirmed map, profile once, hash, and write the snapshot,
   * its field map, its seal and its audit rows in one transaction — then derive
   * the three analysis tables (plan §8.1 step 6). The tables are derived after
   * the snapshot and never roll it back: a snapshot with a table refused by name
   * is a snapshot, and the refusal is what a person acts on.
   *
   * @param {{ userId: string, studyId: string, sourceId: string, fileIds?: string[] | null, asOf?: string | null,
   *   derive?: boolean, actor?: string }} entry
   */
  async freezeSnapshot(entry) {
    this.root();
    const study = await this.#manager(entry.studyId, entry.userId);
    const source = await this.#source(entry.studyId, entry.sourceId);
    this.#assertOpen(source);
    if (source.fieldMapState !== "confirmed") {
      throw refuse(409, VCR_DATA_PLANE_CODES.fieldMapUnconfirmed, "Confirm the field map before freezing a snapshot: a snapshot is read through what its columns mean.");
    }
    const all = await this.store.listSourceFiles(source.id);
    const data = all.filter((file) => file.role === "data");
    /** @type {any[]} */
    let chosen = latestDataFiles(all);
    if (entry.fileIds?.length) {
      chosen = entry.fileIds.map((id) => {
        const found = data.find((file) => file.id === id);
        if (!found) throw refuse(404, VCR_DATA_PLANE_CODES.fileNotFound, "File not found.");
        return found;
      });
      if (new Set(chosen.map((file) => file.name)).size !== chosen.length) {
        throw refuse(400, VCR_DATA_PLANE_CODES.payloadInvalid, "A snapshot takes one version of each file: two of the chosen files have the same name.");
      }
    }
    if (!chosen.length) throw refuse(400, VCR_DATA_PLANE_CODES.locationMissing, "A snapshot needs at least one file.");
    // The whole map first, before anything is profiled or written (CS-40).
    const whole = validateFieldMap(source.fieldMap.columns, this.#tablesOf(chosen));
    if (whole.issues.length) throw refuse(422, VCR_DATA_PLANE_CODES.fieldMapInvalid, issueSummary(whole.issues), { issues: whole.issues });
    const files = [];
    for (const file of chosen) {
      const absolute = this.resolve(file.location);
      const sha256 = await sha256OfFile(absolute).catch(() => null);
      if (sha256 === null) throw refuse(400, VCR_DATA_PLANE_CODES.locationMissing, `The file ${file.name} is not in the data plane.`);
      if (sha256 !== file.sha256) throw refuse(409, VCR_DATA_PLANE_CODES.fileChanged, `The bytes of ${file.name} are not the ones that were uploaded.`);
      files.push({ file, absolute });
    }
    const entries = whole.columns;
    const outcomeColumns = [...new Set(entries.filter(isOutcomeEntry).map((entryOf) => entryOf.column))].sort();
    const planFrozenAt = typeof study.outcomeSeal?.planFrozenAt === "string" ? study.outcomeSeal.planFrozenAt : null;
    const sealedFields = vcrSealRequired(study.intendedUse) ? outcomeColumns : [];
    // A snapshot frozen after the plan was frozen is sealed on the record and
    // already lifted: what was sealed is a fact, and so is when it stopped.
    const sealedUntil = sealedFields.length && planFrozenAt ? planFrozenAt : null;
    // A malformed date is the caller's mistake, not a crash: `toISOString` throws on NaN.
    const asOfMs = entry.asOf == null || entry.asOf === "" ? null : Date.parse(String(entry.asOf));
    if (asOfMs !== null && !Number.isFinite(asOfMs)) throw refuse(400, VCR_DATA_PLANE_CODES.payloadInvalid, "asOf is a date.");
    const asOf = asOfMs === null ? null : new Date(asOfMs).toISOString();
    const replayIssues = [...asOfIssues(entries, asOf), ...columnSourceIssues(entries, source.valueSource)];
    if (replayIssues.length) throw refuse(422, VCR_DATA_PLANE_CODES.fieldMapInvalid, issueSummary(replayIssues), { issues: replayIssues });

    const profile = await this.profiler({
      files: files.map((item) => item.absolute), tableNames: files.map((item) => item.file.name),
      fieldMap: profilerFieldMap(entries), sealedFields, asOf,
    });
    // One hash over every file of the snapshot, in the order the profiler saw
    // them: two files whose contents swap places are a different snapshot.
    const digest = createHash("sha256");
    for (const { file } of files) digest.update(`${file.location}\u0000${file.sha256}\u0000`);
    const snapshot = await this.store.freezeSnapshot({
      sourceId: source.id, studyId: entry.studyId, userId: source.userId, actor: String(entry.userId),
      location: files.map((item) => item.file.location).join("\n"), sha256: digest.digest("hex"),
      rowCount: profile?.snapshot?.rowCount ?? null, columnCount: profile?.snapshot?.columnCount ?? null,
      profile: {
        ...(profile?.profile ?? {}),
        // What this snapshot replays and what its columns declare for themselves:
        // read back by every derivation and every raw-file view.
        frozen: {
          asOf, asOfFilter: profile?.asOfFilter ?? null,
          columnSources: entries.filter((mapped) => mapped.valueSource).map((mapped) => ({ table: mapped.table, column: mapped.column, valueSource: mapped.valueSource })),
        },
      },
      quality: profile?.quality ?? {},
      sealedFields, sealedUntil, valueSource: source.valueSource, fieldMapHash: source.fieldMapHash,
      fileHashes: files.map(({ file }) => ({ id: file.id, name: file.name, location: file.location, sha256: file.sha256, bytes: file.bytes, role: file.role })),
      fieldMaps: entries.map((mapped) => ({
        tableName: mapped.table, columnName: mapped.column, concept: mapped.concept, unit: mapped.unit, codingSystem: mapped.codingSystem,
        timeKind: mapped.timeKind, missingReason: mapped.missingReason, identifier: mapped.identifier || mapped.role === "subject_key",
        reviewState: "reviewed", role: mapped.role, parameter: mapped.parameter, alias: mapped.alias, declaredType: mapped.type,
        range: mapped.range, required: mapped.required, outcome: isOutcomeEntry(mapped), codes: mapped.codes,
      })),
    });
    /** @type {any} */
    let tables = null;
    if (entry.derive !== false) {
      tables = await this.deriveAnalysisTables({ userId: entry.userId, studyId: entry.studyId, snapshotId: snapshot.id })
        .catch((/** @type {any} */ error) => {
          if (error instanceof HttpError && error.code === VCR_DATA_PLANE_CODES.analysisTableInvalid) {
            return { registered: [], refused: /** @type {any} */ (error).vcrDetail?.refused ?? [], skipped: [], failed: error.code };
          }
          throw error;
        });
    }
    return { snapshot, profile, tables };
  }

  // -------------------------------------------------------------------------
  // Step 5: the three analysis tables
  // -------------------------------------------------------------------------

  /**
   * Derive and register the subject, longitudinal and events tables of a frozen
   * snapshot from its confirmed field map (plan §8.1). A table whose shape is not
   * what it says it is is refused by name and not registered; the others are. A
   * shape the map has nothing for is skipped, not an error.
   * @param {{ userId: string, studyId: string, snapshotId: string, actor?: string }} entry
   */
  async deriveAnalysisTables(entry) {
    const root = this.root();
    await this.#manager(entry.studyId, entry.userId);
    const snapshot = await this.#snapshot(entry.studyId, entry.snapshotId);
    const frozen = snapshotFreezeNotes(snapshot);
    const entries = entriesOfRows(await this.store.listFieldMaps(snapshot.id), frozen);
    const data = snapshot.fileHashes.filter((/** @type {any} */ file) => file.role === "data");
    /** @type {VcrTableData[]} */
    const tables = [];
    for (const file of data) {
      const absolute = this.resolve(file.location);
      const body = await fs.readFile(absolute, "utf8").catch(() => null);
      if (body === null) throw refuse(400, VCR_DATA_PLANE_CODES.locationMissing, `The file ${file.name} is not in the data plane.`);
      if (sha256OfBytes(body) !== file.sha256) throw refuse(409, VCR_DATA_PLANE_CODES.fileChanged, `The bytes of ${file.name} are not the ones the snapshot froze.`);
      const parsed = parseTable(body);
      tables.push({ name: file.name, header: parsed.header, rows: parsed.rows });
    }
    const identifying = new Set(
      (snapshot.profile?.tables ?? []).flatMap((/** @type {any} */ table) => (table.columns ?? [])
        .filter((/** @type {any} */ column) => column?.vocabulary?.identifying === true).map((/** @type {any} */ column) => String(column.name))));
    const key = await studyPseudonymKey(root, entry.studyId);
    const derived = deriveAnalysisShapes({ tables, entries, key, identifying, asOf: frozen.asOf, fileSource: snapshot.valueSource });
    // The way back from a pseudonym to a source id is a file in the plane, mode
    // 0600 (the engine runs as another user), read only through `identityOf`.
    const identityFile = path.join(root, studyRelative(entry.studyId), "identity", `${snapshot.id}.csv`);
    await fs.mkdir(path.dirname(identityFile), { recursive: true, mode: 0o700 });
    // Replaced by rename, never truncated in place: the plane is archived while it
    // is written (`scripts/ops/vcr-backup.mjs`), and a copy taken between a
    // truncate and the write would restore a way back that is half a map.
    const partialIdentity = `${identityFile}.${randomUUID()}.part`;
    try {
      await fs.writeFile(partialIdentity, toCsv(["pseudonym", "source_id"], derived.identity), { mode: 0o600 });
      await fs.rename(partialIdentity, identityFile);
    } catch (error) {
      await fs.rm(partialIdentity, { force: true }).catch(() => {});
      throw error;
    }

    /** @type {any[]} */
    const registered = [];
    /** @type {any[]} */
    const refused = [];
    /** @type {string[]} */
    const skipped = [];
    for (const shape of VCR_ANALYSIS_TABLES) {
      const built = derived.shapes[/** @type {"subject" | "longitudinal" | "events"} */ (shape)];
      if (!built) { skipped.push(shape); continue; }
      const objects = built.rows.map((cells) => Object.fromEntries(built.header.map((name, index) => [name, cells[index] ?? ""])));
      const issues = analysisTableIssues(shape, objects);
      const blocking = issues.filter((issue) => issue.blocking);
      if (blocking.length) {
        await this.store.audit({
          studyId: entry.studyId, userId: snapshot.userId, actor: String(entry.userId),
          action: "analysis_table.refused", object: `${snapshot.id}:${shape}`, outcome: "denied",
          reason: blocking.map((issue) => issue.issue).join(","), detail: refusedTableAuditDetail(shape, blocking),
        });
        refused.push({ shape, issues });
        continue;
      }
      const written = await writeContentAddressed(root, path.posix.join(studyRelative(entry.studyId), "tables", snapshot.id, shape), "csv", toCsv(built.header, built.rows));
      registered.push(await this.store.putAnalysisTable({
        snapshotId: snapshot.id, studyId: entry.studyId, userId: snapshot.userId, shape, location: written.location, sha256: written.sha256,
        rowCount: built.rows.length, columns: built.header, issues, outcomeBearing: built.outcomeBearing,
        valueSource: built.valueSource ?? snapshot.valueSource,
        derivedFrom: {
          files: built.files, columns: built.columns, parameters: [...new Set(built.parameters)].sort(),
          columnSources: built.columnSources ?? {},
          ...(derived.asOf ? { asOf: derived.asOf.at, asOfFiles: derived.asOf.files } : {}),
          ...(shape === "subject" && Object.keys(derived.treatment).length ? { treatment: derived.treatment } : {}),
        },
        actor: String(entry.userId),
      }));
    }
    if (refused.length && !registered.length) {
      throw refuse(422, VCR_DATA_PLANE_CODES.analysisTableInvalid, "The analysis tables do not hold the shape they declare.", { refused });
    }
    return {
      registered, refused, skipped, subjects: derived.identity.length,
      excluded: derived.excluded, dropped: derived.dropped, asOf: derived.asOf, treatment: derived.treatment,
    };
  }

  // -------------------------------------------------------------------------
  // The seal
  // -------------------------------------------------------------------------

  /**
   * Bring a snapshot's seal in line with the study as it stands: sealed while a
   * confirmatory study's plan is not frozen, lifted as of the freeze once it is,
   * and lifted for a study that is no longer confirmatory. Idempotent, and
   * read before every judged read so that a study whose use changed after its
   * snapshot was frozen is sealed by the next read rather than by luck.
   * @param {{ study: any, snapshot: any, entries: VcrFieldEntry[] }} input
   * @returns {Promise<any>} the snapshot as it stands now
   */
  async #reconcile({ study, snapshot, entries }) {
    const outcomeColumns = [...new Set(entries.filter(isOutcomeEntry).map((entry) => entry.column))].sort();
    if (!outcomeColumns.length) return snapshot;
    const required = vcrSealRequired(study.intendedUse);
    const planFrozenAt = typeof study.outcomeSeal?.planFrozenAt === "string" ? study.outcomeSeal.planFrozenAt : null;
    const nowMs = this.now().getTime();
    const holds = snapshot.sealedFields.length > 0 && (!snapshot.sealedUntil || Date.parse(snapshot.sealedUntil) > nowMs);
    if (required && !planFrozenAt) {
      const complete = outcomeColumns.every((column) => snapshot.sealedFields.includes(column)) && snapshot.sealedUntil === null;
      if (!complete) {
        await this.store.sealStudySnapshots({ studyId: study.id, fields: outcomeColumns, snapshotIds: [snapshot.id], actor: "platform", reason: "分析计划冻结前，结局字段封存" });
        return (await this.store.getSnapshot(snapshot.id)) ?? snapshot;
      }
    } else if (holds) {
      await this.store.liftStudySeal({
        studyId: study.id, at: planFrozenAt ?? this.now().toISOString(), actor: "platform",
        reason: required ? "分析计划已冻结，封存解除" : "本研究的预期用途不要求封存",
      });
      return (await this.store.getSnapshot(snapshot.id)) ?? snapshot;
    }
    return snapshot;
  }

  /**
   * Lift the seal on every snapshot of a study as of `at` — the instant the
   * analysis plan was frozen. The seal module's port.
   * @param {{ studyId: string, at: string | Date, actor?: string, reason?: string }} entry
   */
  async liftStudySeal(entry) {
    return this.store.liftStudySeal({
      studyId: entry.studyId, at: entry.at, actor: entry.actor ?? "platform", reason: entry.reason ?? "分析计划冻结，封存解除",
    });
  }

  /**
   * Seal the outcome columns of every snapshot of a study now — for a study
   * whose intended use has just become confirmatory before its plan was frozen.
   * @param {{ studyId: string, actor?: string, reason?: string }} entry
   */
  async sealStudy(entry) {
    const study = await this.store.studyForAccess(entry.studyId);
    if (!study) throw refuse(404, VCR_DATA_PLANE_CODES.studyNotFound, "Study not found.");
    if (!vcrSealRequired(study.intendedUse) || study.outcomeSeal?.planFrozenAt) return [];
    const changed = [];
    for (const snapshot of await this.store.listSnapshots({ studyId: entry.studyId })) {
      if (!snapshot) continue;
      const entries = entriesOfRows(await this.store.listFieldMaps(snapshot.id));
      const outcomeColumns = [...new Set(entries.filter(isOutcomeEntry).map((mapped) => mapped.column))].sort();
      if (!outcomeColumns.length) continue;
      changed.push(...await this.store.sealStudySnapshots({
        studyId: entry.studyId, fields: outcomeColumns, snapshotIds: [snapshot.id], actor: entry.actor ?? "platform",
        reason: entry.reason ?? "分析计划冻结前，结局字段封存",
      }));
    }
    return changed;
  }

  // -------------------------------------------------------------------------
  // The engine's inputs (contract §3.2)
  // -------------------------------------------------------------------------

  /**
   * Turn `{ kind: "snapshot", id }` into the inputs an engine may read.
   *
   * The snapshot must be this study's (404 otherwise, for every reason alike);
   * the access judge decides, for the acting principal, whether the columns may
   * be read at all (`read_patient_level`, the grant, the purpose, the window, the
   * seal); a table is handed over only if every column it is derived from is
   * allowed, except the subject table, which is projected to the columns that
   * are. A raw file is handed over as a view without its sealed, denied and
   * identifying columns and with its subject key pseudonymised. Each input
   * carries its location relative to the plane, the sha256 of exactly those
   * bytes and the value source the snapshot's source declared. The first read of
   * an outcome column is recorded before anything is returned.
   *
   * Which tables a job is given follows from its method, not from what exists:
   * a cohort or a weighting reads the subject table, a time-to-event comparison
   * adds the events table, a profile reads the raw files. A job that is not
   * handed the events table has not read the outcome, and the seal's second
   * timestamp says so.
   *
   * @param {{ studyId: string, snapshotId: string, principal: string, purpose?: string | null, fields?: string[] | null,
   *   kind?: string | null, jobKind?: string | null, method?: string | null, endpointType?: string | null,
   *   include?: ("subject" | "longitudinal" | "events" | "files")[] | null }} input
   * @returns {Promise<{ snapshotId: string,
   *   inputs: { kind: string, id: string, shape?: string, location: string, hash: string, valueSource: string }[],
   *   withheld: { id: string, kind: string, shape?: string, reason: string, fields: string[] }[],
   *   outcomeFieldsRead: string[], grantId: string | null }>}
   */
  async resolveSnapshotInputs(input) {
    const root = this.root();
    const studyId = String(input.studyId ?? "");
    const principal = String(input.principal ?? "");
    const study = ID_PATTERN.test(studyId) ? await this.store.studyForAccess(studyId) : null;
    if (!study) throw refuse(404, VCR_DATA_PLANE_CODES.studyNotFound, "Study not found.");
    let snapshot = await this.#snapshot(studyId, String(input.snapshotId ?? ""));
    const fieldMaps = await this.store.listFieldMaps(snapshot.id);
    const frozen = snapshotFreezeNotes(snapshot);
    const entries = entriesOfRows(fieldMaps, frozen);
    snapshot = await this.#reconcile({ study, snapshot, entries });

    const tables = await this.store.listAnalysisTables({ snapshotId: snapshot.id, studyId });
    const kind = String(input.kind ?? input.jobKind ?? "");
    const method = String(input.method ?? (/** @type {Record<string, string>} */ (VCR_JOB_METHODS))[kind] ?? "");
    const wants = input.include ?? tablesNeededBy(method, input.endpointType ?? null, tables.map((table) => table.shape));
    const dataFiles = snapshot.fileHashes.filter((/** @type {any} */ file) => file.role === "data");
    const identifyingNames = new Set(
      (snapshot.profile?.tables ?? []).flatMap((/** @type {any} */ table) => (table.columns ?? [])
        .filter((/** @type {any} */ column) => column?.vocabulary?.identifying === true).map((/** @type {any} */ column) => String(column.name))));
    const identifierNames = new Set(entries.filter((entry) => entry.identifier || entry.role === "subject_key").map((entry) => entry.column));
    /** @param {string} name */
    const judgeable = (name) => !identifierNames.has(name) && !identifyingNames.has(name);

    /** @type {{ table: any }[]} */
    const wantedTables = tables.filter((table) => wants.includes(/** @type {any} */ (table.shape))).map((table) => ({ table }));
    /** @type {Map<string, string[]>} raw file name → its judged columns */
    const fileColumns = new Map();
    if (wants.includes("files")) {
      for (const file of dataFiles) {
        const profiled = (snapshot.profile?.tables ?? []).find((/** @type {any} */ table) => table.name === file.name);
        fileColumns.set(file.name, (profiled?.columns ?? []).map((/** @type {any} */ column) => String(column.name)).filter(judgeable));
      }
    }
    // A scenario names columns of the analysis tables (`age`); the seal and the
    // grants are about the source's columns (`AGE`), so an alias is translated to
    // the column it was derived from before anything is judged.
    const sourceOfAlias = new Map(wantedTables.flatMap(({ table }) => (table.derivedFrom?.columns ?? []).map((/** @type {any} */ mapped) => [String(mapped.name), String(mapped.source)])));
    const requestedFields = [...new Set((Array.isArray(input.fields) ? input.fields.map(String) : []).map((name) => sourceOfAlias.get(name) ?? name))];
    const judged = [...new Set([
      ...wantedTables.flatMap(({ table }) => (table.derivedFrom?.columns ?? []).map((/** @type {any} */ mapped) => String(mapped.source))),
      ...[...fileColumns.values()].flat(),
      ...requestedFields,
    ])].filter(judgeable).sort();

    const decision = await this.access.require({
      actor: principal, studyId, ability: "read_patient_level", snapshotId: snapshot.id,
      ...(judged.length ? { fields: judged } : {}), purpose: input.purpose ?? null, note: kind || "engine input",
    });
    const allowed = new Set(judged.length ? decision.fields.allowed : judged);
    /** @type {Map<string, string>} */
    const why = new Map(decision.fields.denied.map((denial) => [denial.field, denial.code === "vcr_field_sealed" ? "sealed" : denial.code === "vcr_field_identifying" ? "identifying" : "not_granted"]));

    /** @type {{ kind: string, id: string, shape?: string, location: string, hash: string, valueSource: string }[]} */
    const inputs = [];
    /** @type {{ id: string, kind: string, shape?: string, reason: string, fields: string[] }[]} */
    const withheld = [];
    /** @type {Set<string>} */
    const outcomeRead = new Set(requestedFields.filter((name) => allowed.has(name) && entries.some((entry) => entry.column === name && isOutcomeEntry(entry))));
    const outcomeColumns = new Set(entries.filter(isOutcomeEntry).map((entry) => entry.column));

    for (const { table } of wantedTables) {
      const id = `${snapshot.id}:${table.shape}`;
      /** @type {{ source: string, name: string, valueSource?: string }[]} */
      const mapped = table.derivedFrom?.columns ?? [];
      const missing = [...new Set(mapped.map((column) => column.source).filter((name) => judgeable(name) && !allowed.has(name)))];
      if (!missing.length) {
        inputs.push({ kind: "analysis_table", id, shape: table.shape, location: table.location, hash: table.sha256, valueSource: table.valueSource });
        if (table.outcomeBearing) for (const column of mapped.map((item) => item.source)) if (outcomeColumns.has(column)) outcomeRead.add(column);
        continue;
      }
      const carried = mapped.filter((column) => !missing.includes(column.source));
      if (table.shape === "subject" && carried.length) {
        const parsed = parseTable(await fs.readFile(this.resolve(table.location), "utf8"));
        const projection = projectTable(parsed, { keep: ["USUBJID", ...carried.map((column) => column.name)] });
        const written = await writeContentAddressed(root, path.posix.join(studyRelative(studyId), "views", snapshot.id), "csv", toCsv(projection.header, projection.rows));
        // The view holds fewer columns than the table, so it is labelled by the columns it holds.
        const viewSource = weakestSource(carried.map((column) => column.valueSource ?? table.valueSource), table.valueSource);
        inputs.push({ kind: "analysis_table", id, shape: table.shape, location: written.location, hash: written.sha256, valueSource: viewSource });
        continue;
      }
      withheld.push({ id, kind: "analysis_table", shape: table.shape, reason: why.get(missing[0]) ?? "not_granted", fields: missing });
    }

    if (wants.includes("files")) {
      const key = await studyPseudonymKey(root, studyId);
      let position = 0;
      for (const file of dataFiles) {
        position += 1;
        const id = `${snapshot.id}:${position}`;
        const columns = fileColumns.get(file.name) ?? [];
        const missing = columns.filter((name) => !allowed.has(name));
        const keep = columns.filter((name) => allowed.has(name));
        if (!keep.length && columns.length) {
          withheld.push({ id, kind: "snapshot_file", reason: why.get(missing[0]) ?? "not_granted", fields: missing });
          continue;
        }
        const own = entries.filter((entry) => entry.table === file.name);
        const keyEntry = own.find((entry) => entry.role === "subject_key");
        const whole = parseTable(await fs.readFile(this.resolve(file.location), "utf8"));
        // A replay's raw files are cut like its derived tables: the rows the
        // platform could see then, and no others.
        const parsed = frozen.asOf && derivesRows(own) ? tableVisibleAsOf({ name: file.name, ...whole }, entries, frozen.asOf).table : whole;
        /** @type {Record<string, string>} */
        const rename = {};
        const used = new Set(["USUBJID"]);
        parsed.header.forEach((name, index) => {
          if (!keep.includes(name)) return;
          const mapped = own.find((entry) => entry.column === name);
          let wanted = mapped?.alias ?? (VCR_ANALYSIS_COLUMN.test(name) ? name : `col_${index + 1}`);
          for (let attempt = 2; used.has(wanted); attempt += 1) wanted = `${mapped?.alias ?? name}_${attempt}`;
          used.add(wanted);
          if (wanted !== name) rename[name] = wanted;
        });
        const projection = projectTable(parsed, { keep, rename, keyColumn: keyEntry?.column ?? null, key });
        const written = await writeContentAddressed(root, path.posix.join(studyRelative(studyId), "views", snapshot.id), "csv", toCsv(projection.header, projection.rows));
        const viewSource = weakestSource(keep.map((name) => columnSourceOf(own.find((entry) => entry.column === name), snapshot.valueSource)), snapshot.valueSource);
        inputs.push({ kind: "snapshot_file", id, location: written.location, hash: written.sha256, valueSource: viewSource });
        for (const name of keep) if (outcomeColumns.has(name)) outcomeRead.add(name);
      }
    }

    if (!inputs.length) {
      if (withheld.length) {
        throw refuse(403, VCR_DATA_PLANE_CODES.snapshotWithheld,
          `Every table of this snapshot is withheld (${[...new Set(withheld.map((item) => item.reason))].join(", ")}).`, { withheld });
      }
      throw refuse(409, VCR_DATA_PLANE_CODES.snapshotNoTables, "This snapshot has no analysis tables yet; derive them from its field map first.");
    }
    if (outcomeRead.size && this.seal?.recordOutcomeAccess) {
      await this.seal.recordOutcomeAccess({ studyId, fields: [...outcomeRead].sort(), actor: principal, reason: kind || String(input.purpose ?? "engine input") });
    }
    return { snapshotId: snapshot.id, inputs, withheld, outcomeFieldsRead: [...outcomeRead].sort(), grantId: decision.grantId };
  }

  /**
   * The inputs the engine may read for one snapshot, as the job queue attaches
   * them: `[{ kind: "analysis_table" | "snapshot_file", id, shape?, location,
   * hash, valueSource }]` (contract §3.2). A refusal is thrown — 404 for a
   * snapshot that is not the study's, 403 for a principal who may not read it or
   * a snapshot every table of which is withheld — never an empty answer a caller
   * could read as 「没有数据」. {@link resolveSnapshotInputs} has the same call
   * with what was withheld and which outcome columns were read.
   * @param {Parameters<VcrDataPlane["resolveSnapshotInputs"]>[0]} input
   */
  async resolveEngineInputs(input) {
    return (await this.resolveSnapshotInputs(input)).inputs;
  }

  // -------------------------------------------------------------------------
  // Grants
  // -------------------------------------------------------------------------

  /**
   * Let somebody read a source's rows. Only the source's own account may: the
   * partner who registered the data decides who else sees it, and a study lead
   * who could grant themselves a partner's rows would make the partner's
   * registration a note rather than a control.
   * @param {{ actor: string, studyId: string, sourceId: string, grantee: string, role?: string | null, fields?: string[],
   *   fieldMode?: string, windowStart?: string | null, windowEnd?: string | null, purposes?: string[] }} entry
   */
  async createGrant(entry) {
    await this.#manager(entry.studyId, entry.actor);
    const source = await this.#source(entry.studyId, entry.sourceId);
    this.#assertOpen(source);
    if (source.userId !== String(entry.actor)) throw refuse(403, VCR_DATA_PLANE_CODES.grantOwnerOnly, "Only the account that registered a source may grant a read of it.");
    const grantee = text(entry.grantee);
    if (grantee.startsWith("role:")) {
      if (!VCR_MEMBER_ROLES.includes(grantee.slice(5))) throw refuse(400, VCR_DATA_PLANE_CODES.grantInvalid, "A role grantee is role:<a member role>.");
    } else if (grantee.startsWith("study:")) {
      if (grantee.slice(6) !== entry.studyId) throw refuse(400, VCR_DATA_PLANE_CODES.grantInvalid, "A study grantee is this study.");
    } else {
      const owner = (await this.store.studyForAccess(entry.studyId))?.userId;
      const held = ACCOUNT_PATTERN.test(grantee) ? await this.store.rolesOf(entry.studyId, grantee) : [];
      if (!ACCOUNT_PATTERN.test(grantee) || (grantee !== owner && !held.length)) {
        throw refuse(400, VCR_DATA_PLANE_CODES.grantInvalid, "A grantee is an account that is a member of this study, role:<role> or study:<id>.");
      }
    }
    const role = entry.role == null || entry.role === "" ? null : entry.role;
    if (role !== null && !VCR_MEMBER_ROLES.includes(role)) throw refuse(400, VCR_DATA_PLANE_CODES.grantInvalid, "role is a member role.");
    const fields = entry.fields ?? [];
    if (!Array.isArray(fields) || fields.length > 300 || fields.some((field) => typeof field !== "string" || !field.trim() || field.length > VCR_FIELD_MAP_LIMITS.name)) {
      throw refuse(400, VCR_DATA_PLANE_CODES.grantInvalid, "fields is up to 300 column names.");
    }
    const purposes = entry.purposes ?? [];
    if (!Array.isArray(purposes) || purposes.length > 20 || purposes.some((use) => typeof use !== "string" || !USE_PATTERN.test(use))) {
      throw refuse(400, VCR_DATA_PLANE_CODES.grantInvalid, "purposes is up to 20 lowercase words.");
    }
    /** @param {unknown} value */
    const at = (value) => {
      if (value == null || value === "") return null;
      const stamp = typeof value === "string" ? Date.parse(value) : Number.NaN;
      if (!Number.isFinite(stamp)) throw refuse(400, VCR_DATA_PLANE_CODES.grantInvalid, "A grant window is dates.");
      return new Date(stamp).toISOString();
    };
    const windowStart = at(entry.windowStart);
    const windowEnd = at(entry.windowEnd);
    if (windowStart && windowEnd && Date.parse(windowStart) > Date.parse(windowEnd)) throw refuse(400, VCR_DATA_PLANE_CODES.grantInvalid, "The grant window ends before it starts.");
    if (entry.fieldMode != null && !["allow", "deny"].includes(entry.fieldMode)) throw refuse(400, VCR_DATA_PLANE_CODES.grantInvalid, "fieldMode is allow or deny.");
    return this.store.createGrant({
      sourceId: source.id, studyId: entry.studyId, userId: source.userId, grantee, role,
      fields: fields.map((field) => field.trim()), fieldMode: entry.fieldMode ?? "allow", windowStart, windowEnd, purposes,
      actor: String(entry.actor),
    });
  }

  /** @param {{ actor: string, studyId: string, grantId: string }} entry */
  async revokeGrant(entry) {
    await this.#manager(entry.studyId, entry.actor);
    const grant = ID_PATTERN.test(String(entry.grantId ?? "")) ? await this.store.getGrant(entry.grantId) : null;
    if (!grant || grant.studyId !== entry.studyId) throw refuse(404, VCR_DATA_PLANE_CODES.grantNotFound, "Grant not found.");
    const source = await this.store.sourceFor(grant.sourceId);
    if (!source || source.userId !== String(entry.actor)) throw refuse(403, VCR_DATA_PLANE_CODES.grantOwnerOnly, "Only the account that registered a source may revoke a grant on it.");
    const revoked = await this.store.revokeGrant({ grantId: grant.id, studyId: entry.studyId, actor: String(entry.actor) });
    return revoked ?? grant;
  }

  // -------------------------------------------------------------------------
  // What a model may be told
  // -------------------------------------------------------------------------

  /**
   * What a model may be told about a snapshot: the structure, the data
   * dictionary, the quality profile and nothing that is a row. Sealed columns
   * appear by name with no statistics — a sealed outcome's fill rate is an event
   * rate — identifying columns carry no vocabulary, a vocabulary is levels of at
   * least the floor, and a count that would give a small group away is withheld.
   * With `principal`, the read is judged and audited first; the snapshot must be
   * the study's either way.
   * @param {{ studyId: string, snapshotId: string, principal?: string | null }} entry
   */
  async snapshotProfileForModel(entry) {
    const studyId = String(entry.studyId ?? "");
    if (entry.principal != null) {
      await this.access.require({ actor: String(entry.principal), studyId, ability: "read", snapshotId: String(entry.snapshotId ?? ""), note: "snapshot profile" });
    }
    const study = ID_PATTERN.test(studyId) ? await this.store.studyForAccess(studyId) : null;
    if (!study) throw refuse(404, VCR_DATA_PLANE_CODES.studyNotFound, "Study not found.");
    let snapshot = await this.#snapshot(studyId, String(entry.snapshotId ?? ""));
    const fieldMaps = await this.store.listFieldMaps(snapshot.id);
    snapshot = await this.#reconcile({ study, snapshot, entries: entriesOfRows(fieldMaps) });
    const sealed = new Set(snapshot.sealedFields);
    const now = this.now().getTime();
    const sealActive = sealed.size > 0 && (!snapshot.sealedUntil || Date.parse(snapshot.sealedUntil) > now);
    const floor = VCR_MIN_CELL_SIZE;
    const tables = Array.isArray(snapshot.profile?.tables) ? snapshot.profile.tables : [];
    // The field map is the study's own declaration of which columns identify a
    // person, and it wins over the profiler's name and value heuristics: a
    // column called `USUBJID` is one token with no id-shaped suffix, so the
    // heuristics pass it and it hands over its subject ids.
    const declaredIdentifiers = new Set(fieldMaps.filter((map) => map.identifier === true).map((map) => map.columnName));
    const columns = [];
    for (const table of tables) {
      for (const column of table.columns ?? []) {
        if ((sealActive && sealed.has(column.name)) || (column.sealed === true && sealActive)) {
          columns.push({ table: table.name, name: column.name, sealed: true });
        } else if (column.sealed === true) {
          columns.push({ table: table.name, name: column.name, sealed: false, unprofiled: true });
        } else columns.push(columnForModel(table.name, column, Number(table.rows ?? 0), declaredIdentifiers, floor));
      }
    }
    const files = (await this.store.listSourceFiles(snapshot.sourceId)).filter((file) => snapshot.fileHashes.some((/** @type {any} */ frozen) => frozen.id === file.id));
    const dictionary = (await this.store.listSourceFiles(snapshot.sourceId)).filter((file) => file.role === "dictionary").flatMap((file) => file.detail?.dictionary ?? []);
    return {
      snapshotId: snapshot.id, sourceId: snapshot.sourceId, version: snapshot.version,
      sha256: snapshot.sha256, rowCount: snapshot.rowCount != null && snapshot.rowCount < floor ? null : snapshot.rowCount,
      columnCount: snapshot.columnCount, frozenAt: snapshot.frozenAt, valueSource: snapshot.valueSource,
      ...(snapshotFreezeNotes(snapshot).asOf ? { asOf: snapshotFreezeNotes(snapshot).asOf } : {}),
      files: files.map((file) => ({ name: file.name, format: file.format })),
      sealedFields: sealActive ? [...sealed].sort() : [],
      sealedUntil: snapshot.sealedUntil,
      clocks: snapshotClocks(fieldMaps),
      fieldMap: fieldMaps.map((map) => ({
        table: map.tableName, column: map.columnName, role: map.role, parameter: map.parameter, alias: map.alias, concept: map.concept,
        unit: map.unit, codingSystem: map.codingSystem, timeKind: map.timeKind, missingReason: map.missingReason,
        identifier: map.identifier, outcome: map.outcome, reviewState: map.reviewState,
      })),
      dictionary,
      columns,
      quality: qualitySummary(snapshot.quality),
    };
  }

  /**
   * What a model may be told about a source that has no snapshot yet: its files'
   * columns as profiled at upload, the data dictionary, and where the field map
   * stands — enough to propose the map from. The same rules as a snapshot's.
   * @param {{ studyId: string, sourceId: string, principal?: string | null }} entry
   */
  async sourceProfileForModel(entry) {
    const studyId = String(entry.studyId ?? "");
    const source = await this.#source(studyId, String(entry.sourceId ?? ""));
    if (entry.principal != null) {
      await this.access.require({ actor: String(entry.principal), studyId, ability: "read", sourceId: source.id, note: "source profile" });
    }
    const floor = VCR_MIN_CELL_SIZE;
    const files = await this.store.listSourceFiles(source.id);
    const declared = new Set(source.fieldMap.columns.filter((column) => column.identifier || column.role === "subject_key").map((column) => column.column));
    return {
      sourceId: source.id, name: source.name, valueSource: source.valueSource, status: source.status,
      files: files.filter((file) => file.role === "data").map((file) => {
        const table = file.profile?.tables?.[0];
        return {
          name: file.name, format: file.format, rowCount: file.rowCount != null && file.rowCount < floor ? null : file.rowCount,
          columnCount: file.columnCount,
          columns: (table?.columns ?? []).map((/** @type {any} */ column) => columnForModel(file.name, column, Number(table?.rows ?? 0), declared, floor)),
        };
      }),
      dictionary: files.filter((file) => file.role === "dictionary").flatMap((file) => file.detail?.dictionary ?? []),
      fieldMap: { state: source.fieldMapState, hash: source.fieldMapHash, columns: source.fieldMap.columns },
    };
  }

  // -------------------------------------------------------------------------
  // Documents and identities: the two reads behind an audited judgment
  // -------------------------------------------------------------------------

  /**
   * The text of a patient document, for the matching side. Judged as a
   * patient-level read of the source that holds it, and audited.
   * @param {{ studyId: string, documentId: string, principal: string, purpose?: string | null, maxBytes?:number }} entry
   */
  async documentText(entry) {
    const root = this.root();
    const studyId = String(entry.studyId ?? "");
    const file = ID_PATTERN.test(String(entry.documentId ?? "")) ? await this.store.getSourceFile(studyId, entry.documentId) : null;
    if (!file || file.role !== "document") throw refuse(404, VCR_DATA_PLANE_CODES.documentNotFound, "Document not found.");
    await this.access.require({ actor: String(entry.principal), studyId, ability: "read_patient_level", sourceId: file.sourceId, purpose: entry.purpose ?? null, note: "document" });
    const opened = await openScopedFileNoFollow(root, assertDataPlaneLocation(root, file.location));
    let body;
    try {
      if (opened.stat.size !== Number(file.bytes)) throw refuse(409, VCR_DATA_PLANE_CODES.fileChanged, 'The document byte length changed.');
      if (entry.maxBytes != null && opened.stat.size > entry.maxBytes) throw refuse(413, VCR_DATA_PLANE_CODES.fileTooLarge, 'The document exceeds this operation’s bound.');
      body = (await readStableFileHandle(opened.handle, opened.stat)).toString('utf8');
    } finally { await opened.handle.close(); }
    if (sha256OfBytes(body) !== file.sha256) throw refuse(409, VCR_DATA_PLANE_CODES.fileChanged, "The document's bytes are not the ones that were uploaded.");
    return { id: file.id, name: file.name, text: body, subjectKey: file.detail?.subjectKey ?? null, visibleAt: file.detail?.visibleAt ?? null };
  }

  /**
   * The documents a study holds, by subject key: metadata only, no text.
   * @param {{ studyId: string, principal: string, subjectKey?: string | null }} entry
   */
  async listDocuments(entry) {
    await this.access.require({ actor: String(entry.principal), studyId: String(entry.studyId), ability: "read_patient_level", note: "document list" });
    return (await this.store.listSourceFilesForStudy(entry.studyId))
      .filter((file) => file.role === "document" && (!entry.subjectKey || file.detail?.subjectKey === entry.subjectKey))
      .map((file) => ({ id: file.id, sourceId: file.sourceId, name: file.name, chars: file.detail?.chars ?? null,
        subjectKey: file.detail?.subjectKey ?? null, visibleAt: file.detail?.visibleAt ?? null }));
  }

  /**
   * The source id behind a pseudonym — for the partner's own coordinator who has
   * to find the person a referral is about. Needs `manage_data`, and is audited.
   * @param {{ studyId: string, snapshotId: string, pseudonym: string, actor: string }} entry
   */
  async identityOf(entry) {
    const root = this.root();
    await this.#manager(entry.studyId, entry.actor);
    const snapshot = await this.#snapshot(entry.studyId, entry.snapshotId);
    const body = await fs.readFile(path.join(root, studyRelative(entry.studyId), "identity", `${snapshot.id}.csv`), "utf8").catch(() => null);
    const found = body === null ? null : parseTable(body).rows.find((row) => row[0] === entry.pseudonym)?.[1] ?? null;
    await this.store.audit({
      studyId: entry.studyId, userId: snapshot.userId, actor: String(entry.actor), action: "identity.lookup",
      object: `${snapshot.id}:${entry.pseudonym}`, outcome: found === null ? "denied" : "ok", reason: found === null ? "not_found" : "",
    });
    return found === null ? null : { pseudonym: entry.pseudonym, sourceSubjectId: found };
  }

  // -------------------------------------------------------------------------
  // Deletion
  // -------------------------------------------------------------------------

  /**
   * Remove everything the plane holds for a study: uploads, views, derived
   * tables, the identity maps and the pseudonym key (which is what makes a
   * deletion unlinkable). Never follows a symlink and never leaves the
   * plane's `studies/` directory.
   * @param {string} studyId
   */
  async deleteStudyFiles(studyId) {
    if (!this.configured) return { removed: false };
    return removeStudyDirectory(this.root(), studyId);
  }

  /** @param {{ studyIds: readonly string[] }} entry */
  async deleteUserFiles(entry) {
    let removed = 0;
    for (const studyId of entry.studyIds ?? []) if ((await this.deleteStudyFiles(studyId)).removed) removed += 1;
    return { removed };
  }

  // -------------------------------------------------------------------------
  // What the page shows
  // -------------------------------------------------------------------------

  /**
   * The data tier this study's frozen sources can claim, from the analysis
   * tables the plane registered when it derived them: their shapes, row counts,
   * whether treatment was recorded and whether one carries an outcome
   * (`vcrTierSupportedBy`). Metadata the plane already holds — no file is opened,
   * no value of a sealed column is consulted, and nothing is written. The study
   * page offers the move and the study route refuses a rise this does not
   * support; neither lowers a tier.
   * @param {string} studyId
   */
  async tierSupport(studyId) {
    return vcrTierSupportedBy(await this.store.listAnalysisTables({ studyId }));
  }

  /**
   * The intake half of the data tab for one viewer: every source of the study
   * with its files, its field map (and what is wrong with it), its grants and
   * its snapshots with their tables. A source the viewer may not read shows its
   * name, owner and state and nothing of its columns.
   * @param {{ id: string, dataTier?: string }} study @param {{ id: string }} viewer
   */
  async tabFor(study, viewer) {
    const [sources, files, snapshots, tables] = await Promise.all([
      this.store.listSourcesForStudy(study.id), this.store.listSourceFilesForStudy(study.id),
      this.store.listSnapshots({ studyId: study.id }), this.store.listAnalysisTables({ studyId: study.id }),
    ]);
    const grants = await this.store.grantsForSources(sources.map((source) => source.id));
    const openings = new Map();
    for (const source of sources) {
      const mine = source.userId === String(viewer.id);
      const decision = mine ? null : await this.pageAccess.judge({ actor: String(viewer.id), studyId: study.id, ability: "read", sourceId: source.id }).catch(() => null);
      openings.set(source.id, mine || Boolean(decision?.allowed));
    }
    return {
      available: true,
      formats: Object.keys(VCR_UPLOAD_FORMATS.data),
      maxBytes: this.maxBytes,
      sources: sources.map((source) => {
        const readable = openings.get(source.id) === true;
        const own = files.filter((file) => file.sourceId === source.id);
        const tablesOf = this.#tablesOf(own);
        const whole = validateFieldMap(source.fieldMap.columns, tablesOf);
        return {
          id: source.id, name: source.name, ownerParty: source.ownerParty, registeredBy: source.userId, mine: source.userId === String(viewer.id),
          readable, allowedUses: source.allowedUses, visibleWindow: source.visibleWindow, retention: source.retention,
          valueSource: source.valueSource, status: source.status, createdAt: source.createdAt,
          upload: { formats: Object.keys(VCR_UPLOAD_FORMATS.data), maxBytes: this.maxBytes, documents: this.documentUpload(), imports: this.importUpload() },
          // A source the viewer holds no grant on is a name and a state: its files' names, its map and who may read it are not theirs to see.
          files: readable ? own.map((file) => fileView(file)) : [],
          fieldMap: {
            state: source.fieldMapState, hash: source.fieldMapHash, by: source.fieldMapBy || null,
            confirmedBy: source.fieldMapConfirmedBy, confirmedAt: source.fieldMapConfirmedAt,
            columns: readable ? source.fieldMap.columns : [], issues: readable ? whole.issues : [],
          },
          grants: !readable ? [] : grants.filter((grant) => grant.sourceId === source.id).map((grant) => ({
            id: grant.id, grantee: grant.grantee, role: grant.role, fields: grant.fields, fieldMode: grant.fieldMode,
            windowStart: grant.windowStart, windowEnd: grant.windowEnd, purposes: grant.purposes, revokedAt: grant.revokedAt,
            createdAt: grant.createdAt,
          })),
        };
      }),
      // The seal as the judge would find it now, not as the snapshot row last said
      // it: a study raised to a confirmatory use after its snapshot was frozen shows
      // its outcome columns sealed before anyone has read them.
      snapshots: await Promise.all(snapshots.map(async (snapshot) => {
        const outcomeColumns = vcrOutcomeColumns(await this.store.listFieldMaps(snapshot.id));
        const { sealed } = vcrEffectiveSeal({ study: /** @type {any} */ (study), snapshot, outcomeColumns, now: this.now().getTime() });
        return {
          ...snapshotView(snapshot, this.now().getTime(), {
            sealed: sealed.size > 0,
            fields: [...new Set([...snapshot.sealedFields, ...outcomeColumns.filter((column) => sealed.has(column))])].sort(),
          }),
          tables: tables.filter((table) => table.snapshotId === snapshot.id).map(tableView),
        };
      })),
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
 * The part of a profiler run worth keeping beside an uploaded file: each column's
 * name, shape and (already suppressed) vocabulary, not the joins and type
 * conflicts that only make sense across a snapshot.
 * @param {any} result
 */
function slimProfile(result) {
  const tables = Array.isArray(result?.profile?.tables) ? result.profile.tables : [];
  return {
    tables: tables.map((/** @type {any} */ table) => ({
      name: table.name, rows: table.rows,
      columns: (table.columns ?? []).map((/** @type {any} */ column) => ({
        name: column.name, rows: column.rows, filled: column.filled, densityCompleteness: column.densityCompleteness,
        distinct: column.distinct, inferredType: column.inferredType, vocabulary: column.vocabulary,
      })),
    })),
    counts: result?.counts ?? null,
  };
}

// ---------------------------------------------------------------------------
// What leaves through a route or the page: views without a path of the server
// ---------------------------------------------------------------------------

/**
 * A source as a route answers it. No location, no other account's field map: the
 * map's columns are the study's own and travel in the page's tab.
 * @param {any} source
 */
export function sourceView(source) {
  return {
    id: source.id, name: source.name, ownerParty: source.ownerParty, allowedUses: source.allowedUses,
    visibleWindow: source.visibleWindow, retention: source.retention, valueSource: source.valueSource, status: source.status,
    fieldMapState: source.fieldMapState, fieldMapHash: source.fieldMapHash, createdAt: source.createdAt,
  };
}

/**
 * What an audit line may say of an upload: its role, the format it arrived in,
 * its size and the SHA-256 of its bytes — never its name. A file's name is the
 * uploader's, and a chart's is the patient's name or number more often than not;
 * the plane discards a document's (`document-<hash>.txt`), and audit rows outlive
 * the study they describe, so no role's name is written there. The ledger row,
 * which goes with the study, is where a data file's display name is kept. Every
 * part is checked against its own closed shape, so nothing a caller typed can
 * pass through this.
 * @param {{ upload?: { role?: unknown, format?: unknown, bytes?: unknown, sha256?: unknown }, file?: any } | null | undefined} stored
 */
export function uploadAuditDetail(stored) {
  const file = stored?.file ?? {};
  const upload = stored?.upload ?? {};
  const role = upload.role ?? file.role;
  const format = upload.format ?? file.detail?.original?.format ?? file.format;
  const bytes = upload.bytes ?? file.detail?.originalBytes;
  const sha256 = upload.sha256 ?? file.detail?.originalSha256;
  return [
    VCR_SOURCE_FILE_ROLES.includes(/** @type {any} */ (role)) ? role : null,
    typeof format === "string" && /^[a-z0-9]{1,8}$/.test(format) ? format : null,
    Number.isSafeInteger(bytes) ? `${bytes}B` : null,
    typeof sha256 === "string" && /^[a-f0-9]{64}$/.test(sha256) ? `sha256:${sha256}` : null,
  ].filter(Boolean).join(" ");
}

/**
 * What an audit line may say of an upload that did not complete: its role, when
 * that is one of the three, and the length the client declared. Nothing the
 * caller typed is passed through (see `uploadAuditDetail`).
 * @param {unknown} role @param {unknown} declaredLength
 */
export function uploadAttemptAuditDetail(role, declaredLength) {
  return [
    VCR_SOURCE_FILE_ROLES.includes(/** @type {any} */ (role)) ? role : "other",
    Number.isSafeInteger(declaredLength) && /** @type {number} */ (declaredLength) >= 0 ? `${declaredLength}B declared` : null,
  ].filter(Boolean).join(" ");
}

/**
 * What an audit line may say of an import: the standard, how many tables came
 * back and were taken, and the SHA-256 of the upload — never its name, and never
 * a row. Every part is checked against its own closed shape.
 * @param {{ format?: unknown, input?: { sha256?: unknown, bytes?: unknown }, tables?: { stored?: unknown }[] } | null | undefined} imported
 */
export function importAuditDetail(imported) {
  const format = Object.hasOwn(VCR_IMPORT_FORMATS, String(imported?.format)) ? String(imported?.format) : null;
  const tables = Array.isArray(imported?.tables) ? imported.tables : [];
  const sha256 = imported?.input?.sha256;
  return [
    format, tables.length ? `${tables.filter((table) => table?.stored === true).length}/${tables.length} tables` : null,
    Number.isSafeInteger(imported?.input?.bytes) ? `${imported?.input?.bytes}B` : null,
    typeof sha256 === "string" && /^[a-f0-9]{64}$/.test(sha256) ? `sha256:${sha256}` : null,
  ].filter(Boolean).join(" ");
}

/**
 * What an audit line may say of an import that did not complete: the standard,
 * when it is one of the three, and the length the client declared.
 * @param {unknown} format @param {unknown} declaredLength
 */
export function importAttemptAuditDetail(format, declaredLength) {
  return [
    Object.hasOwn(VCR_IMPORT_FORMATS, String(format)) ? String(format) : "other",
    Number.isSafeInteger(declaredLength) && /** @type {number} */ (declaredLength) >= 0 ? `${declaredLength}B declared` : null,
  ].filter(Boolean).join(" ");
}

/** A stored file as a route answers it. @param {any} file @param {boolean} [withColumns] */
export function fileView(file, withColumns = true) {
  return {
    id: file.id, sourceId: file.sourceId, name: file.name, role: file.role, format: file.format, bytes: file.bytes,
    sha256: file.sha256, rowCount: file.rowCount, columnCount: file.columnCount, createdAt: file.createdAt,
    ...(withColumns && file.role === "data" ? {
      columns: (file.profile?.tables?.[0]?.columns ?? []).slice(0, VCR_UPLOAD_LIMITS.columns).map((/** @type {any} */ column) => ({
        name: column.name, type: column.inferredType ?? null, filled: column.densityCompleteness ?? null, distinct: column.distinct ?? null,
        identifying: column.vocabulary?.identifying === true,
      })),
    } : {}),
    ...(file.role === "dictionary" ? { entries: (file.detail?.dictionary ?? []).length } : {}),
    ...(file.role === "document" ? { subjectKey: file.detail?.subjectKey ?? null, visibleAt: file.detail?.visibleAt ?? null, chars: file.detail?.chars ?? null,
      // A converted record says what it was converted from and how much of it had no text layer.
      ...(file.detail?.extraction ? { sourceFormat: file.detail.extraction.sourceFormat ?? null, pages: file.detail.extraction.pages ?? null, blankPages: file.detail.extraction.blankPages ?? 0 } : {}) } : {}),
    ...(file.detail?.sheets ? { sheets: file.detail.sheets, sheetUsed: file.detail.sheetUsed ?? null } : {}),
    // A table (or a dictionary) a standard-format import produced: which standard it was imported from.
    ...(file.detail?.import?.format ? { importFormat: String(file.detail.import.format) } : {}),
  };
}

/**
 * A snapshot as a route answers it. `effective` is the seal as the judge finds it
 * now (the study's use and plan decide it, not only the row); without it the
 * row's own seal is read.
 * @param {any} snapshot @param {number} [now] @param {{ sealed: boolean, fields: string[] }} [effective]
 */
export function snapshotView(snapshot, now = Date.now(), effective = undefined) {
  const sealed = effective ? effective.sealed : snapshot.sealedFields.length > 0 && (!snapshot.sealedUntil || Date.parse(snapshot.sealedUntil) > now);
  return {
    id: snapshot.id, sourceId: snapshot.sourceId, version: snapshot.version, sha256: snapshot.sha256, rowCount: snapshot.rowCount,
    columnCount: snapshot.columnCount, frozenAt: snapshot.frozenAt, valueSource: snapshot.valueSource,
    files: snapshot.fileHashes.map((/** @type {any} */ file) => ({ name: file.name, sha256: file.sha256, bytes: file.bytes })),
    sealedFields: effective ? effective.fields : snapshot.sealedFields, sealedUntil: snapshot.sealedUntil, sealed,
    quality: qualitySummary(snapshot.quality),
    ...(snapshotFreezeNotes(snapshot).asOf ? { asOf: snapshotFreezeNotes(snapshot).asOf } : {}),
  };
}

/** An analysis table as a route answers it. @param {any} table */
export function tableView(table) {
  return {
    shape: table.shape, rowCount: table.rowCount, sha256: table.sha256, columns: table.columns, issues: table.issues.length,
    outcomeBearing: table.outcomeBearing, valueSource: table.valueSource,
    ...(table.derivedFrom?.columnSources && Object.keys(table.derivedFrom.columnSources).length ? { columnSources: table.derivedFrom.columnSources } : {}),
    ...(typeof table.derivedFrom?.asOf === "string" ? { asOf: table.derivedFrom.asOf } : {}),
  };
}
