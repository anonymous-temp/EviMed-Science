// Pure decisions of the red-line runners: what a finding means for a delete path (red line, retained by design, or a flag),
// what a G4 or G5 trial row says, the run summaries, and the exact one-sided upper bound on a failure rate.
//
// The rule (stated once, here, and reported with every summary):
//  - RED LINE = the deleted marker can reach a later answer: a memory file the product serves, the overlay's copy of a file's body
//    (the page, the export and the capsule read it), the memory page's active records and search, the model-facing `search`
//    (with its capsule and original-conversation blocks), `list`/`read`, the plugin's own recall route, the resident block, the
//    account export and the capsule export preview. For the deletions that destroy the source (conversation deletion, memory
//    reset, account deletion) also the source copies the design deletes with it: the conversation's engine archive, its raw
//    history text, its privacy configuration and the vectors indexed from them.
//  - BY DESIGN = a record the product keeps on purpose after that kind of deletion; each carries the code reference that says so.
//  - FLAG = anything else that still holds the marker: not reachable by an answer through any surface probed, but kept where the
//    design does not say it is kept (or kept as a fingerprint only). Flags are reported, never counted as red lines.

export const G4_PLACES = Object.freeze(["engine-files", "engine-summaries", "archive", "raw-history", "privacy-tree", "engine-other", "vectors", "ledger",
  "capsule-entries", "export", "line-origin-index", "page", "page-history", "model-search", "model-list-read", "plugin-recall", "resident"]);

/** Deletions that destroy the source the marker came from (the conversation, every conversation, the account). */
export const SOURCE_DELETES = new Set(["delete-conversation", "memory-reset", "delete-account"]);

const ALWAYS_REDLINE = new Set(["engine-files", "page", "model-search", "model-list-read", "plugin-recall", "resident", "export", "capsule-entries"]);

/** Records kept on purpose, by place key, with the code that says why. */
export const BY_DESIGN = Object.freeze({
  "archive:conversation": "apps/server/src/nativeMemoryStore.mjs remove()/forget(): deleting a memory removes the file and its lines, not the conversation it came from; the conversation's engine archive goes only with the conversation (removeConversationSource deletes `dsh-` sessions)",
  "raw-history:conversation": "plan §4.2 + apps/server/src/memoryHistory.mjs: the original-conversation index is kept with its conversation; after a forget the hits are filtered (rejection list / fences), which the model-search probe checks",
  "vectors:conversation": "the engine indexes the retained conversation text (archive, raw history); reachable only through the probed search routes",
  "ledger:evimed_memory.native_rejections.text": "apps/server/src/nativeMemoryPersistence.mjs native_rejections.text: \"The line's normalised words, so that a reworded repeat can be recognised\" (kept so the engine cannot write the line back)",
  "ledger:evimed_memory.native_revisions:forget": "apps/server/src/nativeMemoryStore.mjs forget(): the conversation's forget is `keepText: true` — \"what the person asked a conversation to forget they can bring back from the page\"",
  "ledger:evimed_memory.native_revisions:edit": "apps/server/src/nativeMemoryPersistence.mjs native_rejections.origin 'edit': \"its old words stay in the file's history, and the map may draw them as what the memory used to say\"",
  "page-history:forget": "apps/server/src/nativeMemoryStore.mjs forgotten()/restore: a conversation's forget can be undone from the page, so the page lists it as forgotten",
  "page-history:edit": "apps/server/src/memoryRoutes.mjs DELETE /api/memory/records/:id/replaced/:sid: a memory's old words are drawn in grey under it until the person removes them",
});

/** The key of one session archive path: the deleted conversation's own `dsh-` session, a page/import/tool write session, or other. @param {string} rel */
export function archiveSessionKind(rel) {
  const session = String(rel).split("/")[1] ?? "";
  if (session.startsWith("dsh-")) return "conversation";
  if (/^(evimed-page-|evimed-import-|evimed-promote-|mcp-store-)/.test(session)) return "write-session";
  return "other";
}

/**
 * What one place holding the marker means after a delete path. `where` is the list of paths/columns/kinds it was found at.
 * @param {string} place @param {readonly string[]} where @param {{ deleteVia: string }} trial
 * @returns {{ class: "redline" | "by-design" | "flag", reasons: string[] }}
 */
export function classifyPlace(place, where, { deleteVia }) {
  const source = SOURCE_DELETES.has(deleteVia);
  if (ALWAYS_REDLINE.has(place)) return { class: "redline", reasons: [] };
  if (place === "ledger") {
    let worst = "by-design";
    /** @type {string[]} */
    const reasons = [];
    for (const column of where) {
      const verdict = classifyColumn(column, deleteVia);
      if (verdict.class === "redline") worst = "redline";
      else if (verdict.class === "flag" && worst !== "redline") worst = "flag";
      if (verdict.reason) reasons.push(verdict.reason);
    }
    return { class: /** @type {any} */ (worst), reasons: [...new Set(reasons)] };
  }
  if (place === "archive" || place === "engine-summaries" || place === "vectors" || place === "raw-history" || place === "privacy-tree") {
    if (source && place !== "engine-summaries") {
      // A side write session (a page add, the `remember` tool) is not part of a deleted conversation; reset/account deletion take it too.
      if (deleteVia === "delete-conversation" && place === "archive" && where.every((rel) => archiveSessionKind(rel) !== "conversation")) {
        return { class: "flag", reasons: ["a page or tool write session still holds the words after the conversation was deleted"] };
      }
      return { class: "redline", reasons: [] };
    }
    if (place === "raw-history") return { class: "by-design", reasons: [BY_DESIGN["raw-history:conversation"]] };
    if (place === "privacy-tree") return { class: "flag", reasons: ["privacy configuration holds the marker"] };
    const kinds = where.map((rel) => (rel.startsWith("sessions/") ? archiveSessionKind(rel) : rel.startsWith("resources/history") ? "conversation" : "memory"));
    if (kinds.every((kind) => kind === "conversation")) return { class: "by-design", reasons: [BY_DESIGN[place === "vectors" ? "vectors:conversation" : "archive:conversation"]] };
    if (kinds.some((kind) => kind === "write-session")) return { class: "flag", reasons: ["a page or tool write session (evimed-page-/mcp-store-) keeps the deleted words; nothing deletes it with the memory"] };
    return { class: "flag", reasons: [place === "vectors" ? "a stale vector of a deleted memory" : "an engine summary still names the deleted memory"] };
  }
  if (place === "page-history") {
    if (deleteVia === "forget-in-conversation") return { class: "by-design", reasons: [BY_DESIGN["page-history:forget"]] };
    if (deleteVia === "memory-page-edit") return { class: "by-design", reasons: [BY_DESIGN["page-history:edit"]] };
    return { class: "flag", reasons: ["the page still carries the deleted words outside the active records"] };
  }
  if (place === "line-origin-index") return { class: "flag", reasons: ["a line-origin fingerprint of a deleted line remains (hash only)"] };
  return { class: "flag", reasons: [] };
}

/** @param {string} column `schema.table.column` @param {string} deleteVia @returns {{ class: "redline" | "by-design" | "flag", reason: string }} */
export function classifyColumn(column, deleteVia) {
  const destroyed = deleteVia === "memory-reset" || deleteVia === "delete-account";
  if (column === "evimed_memory.native_files.body") return { class: "redline", reason: "the overlay copy of a served file still holds it" };
  if (column === "evimed_memory.native_rejections.text") {
    return destroyed ? { class: "flag", reason: "rejection text survived a reset/account deletion" } : { class: "by-design", reason: BY_DESIGN["ledger:evimed_memory.native_rejections.text"] };
  }
  if (column === "evimed_memory.native_revisions.before" || column === "evimed_memory.native_revisions.after") {
    if (deleteVia === "forget-in-conversation") return { class: "by-design", reason: BY_DESIGN["ledger:evimed_memory.native_revisions:forget"] };
    if (deleteVia === "memory-page-edit") return { class: "by-design", reason: BY_DESIGN["ledger:evimed_memory.native_revisions:edit"] };
    return { class: "flag", reason: `revision text kept after ${deleteVia} (forgetText/scrubLines should remove it)` };
  }
  return { class: "flag", reason: `${column} holds it in clear text` };
}

/**
 * The places of one trial, classified. `findings` maps a place to the list of where it was found (empty = not found) or null
 * when the place does not apply (an account that is gone has no page).
 * @param {Record<string, string[] | null>} findings @param {{ deleteVia: string }} trial
 */
export function classifyFindings(findings, trial) {
  /** @type {Record<string, { found: boolean | null, where: string[], class: string | null, reasons?: string[] }>} */
  const places = {};
  const redline = [], byDesign = [], flags = [];
  for (const place of Object.keys(findings)) {
    const where = findings[place];
    if (where === null || where === undefined) { places[place] = { found: null, where: [], class: null }; continue; }
    if (!where.length) { places[place] = { found: false, where: [], class: null }; continue; }
    const verdict = classifyPlace(place, where, trial);
    places[place] = { found: true, where: [...where], class: verdict.class, ...(verdict.reasons.length ? { reasons: verdict.reasons } : {}) };
    if (verdict.class === "redline") redline.push(place); else if (verdict.class === "by-design") byDesign.push(place); else flags.push(place);
  }
  return { places, reappeared: redline.length > 0, redline, byDesign, flags };
}

// ------------------------------------------------------------------------------------------------------------ statistics

/** log of n choose k. @param {number} n @param {number} k */
function logChoose(n, k) {
  let sum = 0;
  for (let i = 1; i <= k; i += 1) sum += Math.log(n - k + i) - Math.log(i);
  return sum;
}

/** P(X <= x) for X ~ Binomial(n, p), summed in log space. @param {number} x @param {number} n @param {number} p */
export function binomialCdf(x, n, p) {
  if (p <= 0) return 1;
  if (p >= 1) return x >= n ? 1 : 0;
  let total = 0;
  for (let k = 0; k <= Math.min(x, n); k += 1) total += Math.exp(logChoose(n, k) + k * Math.log(p) + (n - k) * Math.log1p(-p));
  return Math.min(1, total);
}

/**
 * The exact (Clopper-Pearson) one-sided upper confidence bound on a failure rate after `failures` in `n` trials: the p at which
 * seeing this few or fewer has probability `alpha`. With no failure it is 1 - alpha^(1/n) (3,000 clean trials: about 0.000998).
 * @param {number} failures @param {number} n @param {number} [confidence]
 */
export function upperBound(failures, n, confidence = 0.95) {
  if (!Number.isInteger(n) || n <= 0) return null;
  if (failures >= n) return 1;
  const alpha = 1 - confidence;
  if (failures === 0) return 1 - alpha ** (1 / n);
  let lo = failures / n, hi = 1;
  for (let step = 0; step < 200; step += 1) {
    const mid = (lo + hi) / 2;
    if (binomialCdf(failures, n, mid) > alpha) lo = mid; else hi = mid;
  }
  return hi;
}

// ------------------------------------------------------------------------------------------------------------ G4 summary

/** Whether a G4 row counts toward the red-line denominator: planted, deleted, no error, the path drivable. @param {any} row */
export function g4Counted(row) {
  return row && row.planted === true && row.deleted === true && !row.error && !row.notDrivable;
}

/**
 * The G4 run summary: red lines first, then counts per plant × delete cell, by-design residues and flags per place, and the
 * upper bound on the reappearance rate from the counted trials.
 * @param {any[]} rows the last row of every trial
 */
export function summarizeG4(rows) {
  /** @type {Record<string, any>} */
  const cells = {};
  /** @type {Record<string, any>} */
  const byDelete = {};
  const redLines = [];
  let counted = 0, reappeared = 0, notPlanted = 0, notDrivable = 0, deleteFailed = 0, errors = 0;
  const failedDeletes = [];
  const flagTotals = {}, designTotals = {};
  for (const row of rows) {
    const key = `${row.plantVia}×${row.deleteVia}`;
    const cell = cells[key] ??= { n: 0, reappeared: 0, notPlanted: 0, notDrivable: 0, deleteFailed: 0, errors: 0, controlsChecked: 0, controlsSurvived: 0,
      relearn: {}, byDesign: {}, flags: {} };
    const path = byDelete[row.deleteVia] ??= { n: 0, reappeared: 0 };
    if (row.error) { cell.errors += 1; errors += 1; continue; }
    if (row.notDrivable) { cell.notDrivable += 1; notDrivable += 1; continue; }
    if (row.planted !== true) { cell.notPlanted += 1; notPlanted += 1; continue; }
    // A delete the product did not finish is a failure of that path, reported apart: nothing was deleted to come back.
    if (row.deleted !== true) {
      cell.deleteFailed += 1; deleteFailed += 1; failedDeletes.push({ trialId: row.trialId, cell: key, outcomes: row.deletion?.outcomes ?? [] });
      // Accepted and never finished while the marker still reaches an answer: listed with the red lines, not counted in the rate.
      if (row.unfinishedDelete) {
        cell.unfinishedDeletes = (cell.unfinishedDeletes ?? 0) + 1;
        redLines.push({ trialId: row.trialId, cell: key, kind: "unfinished-delete", outcomes: row.deletion?.outcomes ?? [],
          places: Object.entries(row.places ?? {}).filter(([, value]) => value?.class === "redline").map(([place, value]) => ({ place, where: value.where })) });
      }
      continue;
    }
    if (!g4Counted(row)) { cell.errors += 1; errors += 1; continue; }
    counted += 1; cell.n += 1; path.n += 1;
    if (row.reappeared) {
      reappeared += 1; cell.reappeared += 1; path.reappeared += 1;
      redLines.push({ trialId: row.trialId, cell: key, kind: "reappeared", relearn: row.relearn, places: Object.entries(row.places ?? {}).filter(([, value]) => value?.class === "redline").map(([place, value]) => ({ place, where: value.where })) });
    }
    if (typeof row.controlsSurvived === "boolean") { cell.controlsChecked += 1; if (row.controlsSurvived) cell.controlsSurvived += 1; }
    const relearnOutcome = row.relearnOutcome?.outcome ?? (row.relearn === "none" ? "none" : "unknown");
    cell.relearn[`${row.relearn}:${relearnOutcome}`] = (cell.relearn[`${row.relearn}:${relearnOutcome}`] ?? 0) + 1;
    for (const [place, value] of Object.entries(row.places ?? {})) {
      const tag = value?.class === "by-design" ? "byDesign" : value?.class === "flag" ? "flags" : null;
      if (!tag) continue;
      cell[tag][place] = (cell[tag][place] ?? 0) + 1;
      const totals = tag === "byDesign" ? designTotals : flagTotals;
      /** @type {any} */ (totals)[place] = (/** @type {any} */ (totals)[place] ?? 0) + 1;
    }
  }
  const bound = upperBound(reappeared, counted);
  return {
    rule: "red line = the deleted marker can reach a later answer (classify.mjs header); by-design and flag residues are listed, never counted",
    redLines,
    totals: { trials: rows.length, counted, reappeared, notPlanted, notDrivable, deleteFailed, errors,
      upperBound95: bound, upperBound95Text: bound === null ? "no counted trial" : `${(bound * 100).toFixed(4)}% (exact one-sided, ${reappeared}/${counted})` },
    byDelete: Object.fromEntries(Object.entries(byDelete).map(([key, value]) => [key, { ...value, upperBound95: upperBound(value.reappeared, value.n) }])),
    failedDeletes, cells, byDesignTotals: designTotals, flagTotals,
  };
}

// ------------------------------------------------------------------------------------------------------------ G5

/** Readers in another account than the writer's: a visible marker where none is expected is the cross-account red line. */
export const CROSS_ACCOUNT_READERS = new Set(["other-account", "geo-member", "geo-nonmember", "after-member-removed"]);

/**
 * What one probe is expected to show a reader. The account export is the reader's own account's, so it is expected to show a
 * marker only when that account wrote it (and it is not a project-scoped read at all: same-account readers are `n/a`). The capsule
 * half of a search returns capsule facts, never the account's memory files: in another account it must show nothing; in the same
 * account it is not counted. Every other probe follows the trial's expectation.
 * @param {{ reader: string, expectVisible: boolean }} trial @param {string} probe @returns {boolean | "n/a" | "any"}
 */
export function probeExpectation(trial, probe) {
  const cross = CROSS_ACCOUNT_READERS.has(trial.reader);
  if (probe === "export") return cross ? false : "n/a";
  if (probe === "capsule-search") return cross ? false : "any";
  return trial.expectVisible;
}

/**
 * One G5 trial's verdict from its probe outcomes (`true` visible, `false` not, `"refused"` the reader could not reach it, `null`
 * not run). A refusal is "not visible".
 * @param {{ reader: string, expectVisible: boolean }} trial @param {Record<string, boolean | "refused" | null>} probes
 */
export function g5Verdict(trial, probes) {
  const cross = CROSS_ACCOUNT_READERS.has(trial.reader);
  /** @type {Record<string, { visible: boolean | null, expected: boolean | "n/a" | "any", outcome: string }>} */
  const perProbe = {};
  const leaks = [];
  for (const [probe, value] of Object.entries(probes)) {
    const expected = probeExpectation(trial, probe);
    const visible = value === null || value === undefined ? null : value === true;
    let outcome = "ok";
    if (visible === null || expected === "n/a" || expected === "any") outcome = visible === null ? "not-run" : "not-counted";
    else if (visible && !expected) { outcome = cross ? "cross-account-leak" : "same-account-leak"; leaks.push(probe); }
    else if (!visible && expected) outcome = "miss";
    perProbe[probe] = { visible, expected, outcome };
  }
  const core = ["search", "read", "list"].filter((probe) => perProbe[probe]?.visible !== null && perProbe[probe] !== undefined);
  const functionalMiss = trial.expectVisible === true && core.length > 0 && core.every((probe) => perProbe[probe].visible === false);
  return { perProbe, redLine: cross && leaks.length > 0, sameAccountLeak: !cross && leaks.length > 0, leaks, functionalMiss };
}

/**
 * The G5 run summary: red lines first, then reader × probe cells and reader × concurrency cells.
 * @param {any[]} rows
 */
export function summarizeG5(rows) {
  const redLines = [], sameAccount = [];
  /** @type {Record<string, any>} */
  const cells = {};
  /** @type {Record<string, any>} */
  const readers = {};
  let counted = 0, red = 0, notPlanted = 0, errors = 0, misses = 0, crossCounted = 0;
  for (const row of rows) {
    const reader = readers[`${row.reader}×${row.concurrent ? "concurrent" : "sequential"}`] ??= { n: 0, redLines: 0, sameAccountLeaks: 0, functionalMisses: 0, notPlanted: 0, errors: 0 };
    if (row.error) { errors += 1; reader.errors += 1; continue; }
    if (row.planted !== true) { notPlanted += 1; reader.notPlanted += 1; continue; }
    counted += 1; reader.n += 1;
    if (CROSS_ACCOUNT_READERS.has(row.reader) && row.expectVisible === false) crossCounted += 1;
    if (row.verdict?.redLine) { red += 1; reader.redLines += 1; redLines.push({ trialId: row.trialId, reader: row.reader, concurrent: row.concurrent, probes: row.verdict.leaks }); }
    if (row.verdict?.sameAccountLeak) { reader.sameAccountLeaks += 1; sameAccount.push({ trialId: row.trialId, reader: row.reader, probes: row.verdict.leaks }); }
    if (row.verdict?.functionalMiss) { misses += 1; reader.functionalMisses += 1; }
    for (const [probe, value] of Object.entries(row.verdict?.perProbe ?? {})) {
      const cell = cells[`${row.reader}×${probe}`] ??= { n: 0, visible: 0, refusedOrHidden: 0, leaks: 0, misses: 0, notCounted: 0 };
      cell.n += 1;
      if (value.visible) cell.visible += 1; else cell.refusedOrHidden += 1;
      if (value.outcome.endsWith("leak")) cell.leaks += 1;
      if (value.outcome === "miss") cell.misses += 1;
      if (value.outcome === "not-counted" || value.outcome === "not-run") cell.notCounted += 1;
    }
  }
  const crossTrials = rows.filter((row) => !row.error && row.planted === true && CROSS_ACCOUNT_READERS.has(row.reader)).length;
  const bound = upperBound(red, crossTrials);
  return {
    rule: "red line = a marker visible to another account where the rule table says it must not be; same-account leaks and functional misses are reported apart",
    redLines,
    sameAccountLeaks: sameAccount,
    totals: { trials: rows.length, counted, redLines: red, notPlanted, errors, functionalMisses: misses, crossAccountTrials: crossTrials, crossAccountExpectedHidden: crossCounted,
      upperBound95: bound, upperBound95Text: bound === null ? "no counted cross-account trial" : `${(bound * 100).toFixed(4)}% (exact one-sided, ${red}/${crossTrials} cross-account trials)` },
    readers, cells,
  };
}
