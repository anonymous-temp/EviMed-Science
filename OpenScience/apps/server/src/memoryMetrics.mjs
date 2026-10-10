// The operator's counters for what the memory does and refuses to do (review of 2026-10-10, items M5-M7).
//
// What a reset and a deletion promise (conversations that ended before a reset are not learned from; a deleted project
// retires what was learned only from it; an erased account takes the retired usememos rows with it), how the resident
// profile was handed to conversations, what the recall tool answered, and what extraction did with a run. A counter is a
// label: counting never changes the operation counted, and a counter that cannot be read costs the scrape one gauge and the
// operation nothing.
//
// Module-level like `capsuleShareMetrics.mjs`: one process, one table, read by `/api/ops/metrics`. Every series exists from
// the start at zero, so the first event is an increase `increase()` can see; an unknown label is ignored, never counted
// under a made-up one.

/** Where a conversation that ended before a reset was refused: memory extraction, a lesson of the learning loop, or a peer run of a routine lesson. */
export const BEFORE_RESET_STAGES = Object.freeze(["extraction", "lesson", "routine_peer"]);
/** What a reset removed beyond the records themselves. */
const RESET_REMOVED = Object.freeze(["jobs_canceled", "feedback_events_deleted"]);
/** Why a learned method was stopped without the researcher choosing it. */
const METHOD_RETIREMENTS = Object.freeze(["project_deleted"]);
/** The retired usememos tables whose rows an account's deletion removes. */
const RETIRED_TABLES = Object.freeze(["memory_record", "memo"]);

/** @param {readonly string[]} labels */
const table = (labels) => new Map(labels.map((label) => [label, 0]));
/** @param {Map<string, number>} map @param {string} key @param {number} [by] */
function bump(map, key, by = 1) { if (map.has(key)) map.set(key, (map.get(key) ?? 0) + Math.max(0, Math.trunc(by) || 0)); }

const beforeReset = table(BEFORE_RESET_STAGES);
const resetRemoved = table(RESET_REMOVED);
const methodRetirements = table(METHOD_RETIREMENTS);
const retiredTables = table(RETIRED_TABLES);

/** A conversation that ended before the account's reset was not learned from. @param {string} stage */
export function recordSkippedBeforeReset(stage) { bump(beforeReset, stage); }
/** What one reset removed besides the memory records. @param {{ jobs?: number, feedback?: number }} removed */
export function recordResetRemoved({ jobs = 0, feedback = 0 }) {
  bump(resetRemoved, "jobs_canceled", jobs);
  bump(resetRemoved, "feedback_events_deleted", feedback);
}
/** Learned methods stopped because the only project they were learned in was deleted. @param {string} reason @param {number} count */
export function recordMethodsRetired(reason, count) { bump(methodRetirements, reason, count); }
/** Rows of a retired usememos table removed with an erased account. @param {string} name @param {number} count */
export function recordRetiredTableRows(name, count) { bump(retiredTables, name, count); }

/** The test hook: counters are process state. */
export function resetMemoryMetrics() {
  for (const map of [beforeReset, resetRemoved, methodRetirements, retiredTables]) {
    for (const key of map.keys()) map.set(key, 0);
  }
}

/** @param {Map<string, number>} map @param {string} label */
const series = (map, label) => [...map].map(([key, value]) => ({ value, labels: { [label]: key } }));

/**
 * @returns {Array<{ name: string, help: string, type: "counter" | "gauge", series: Array<{ value: number, labels?: Record<string, string> }> }>}
 */
export function memoryMetricFamilies() {
  return [
    { name: "open_science_memory_skipped_before_reset_total", type: "counter", series: series(beforeReset, "stage"),
      help: "Conversations that ended before the account's last memory reset and were not learned from, by where they were refused: memory extraction, a lesson of the learning loop, or a peer run of a routine lesson." },
    { name: "open_science_memory_reset_removed_total", type: "counter", series: series(resetRemoved, "what"),
      help: "What memory resets removed besides the records: queued or running learning jobs cancelled, and feedback events deleted." },
    { name: "open_science_learned_methods_retired_total", type: "counter", series: series(methodRetirements, "reason"),
      help: "Learned methods stopped without the researcher choosing it: the only project they were learned in was deleted." },
    { name: "open_science_retired_memos_erased_total", type: "counter", series: series(retiredTables, "table"),
      help: "Rows of the retired usememos tables removed with an erased account, by table." },
  ];
}
