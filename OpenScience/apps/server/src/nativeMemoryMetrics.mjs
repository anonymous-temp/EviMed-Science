// The operator's counters for memory on the native engine (2026-10-13): what the memory gateway forwarded, answered itself
// and refused, and what the overlay's worker read, replayed and took back.
//
// Module-level like `memoryMetrics.mjs`: one process, one table, read by `/api/ops/metrics`. Every series exists from the
// start at zero; an unknown label is ignored, never counted under a made-up one. Counting never changes what is counted.

/** The gateway's routes, by the name each handler has. */
export const MEMORY_GATEWAY_ROUTES = Object.freeze([
  "health", "status", "sessionCreate", "sessionRead", "messageWrite", "commit", "search", "read", "list", "skills", "mcp", "mcpClose", "unknown",
]);
/** What became of a request: sent to the engine, answered here, answered as nothing because the caller is not read or
 *  learned from, refused, or failed upstream. */
export const MEMORY_GATEWAY_OUTCOMES = Object.freeze(["forwarded", "local", "withheld", "refused", "failed"]);
/** What became of one captured message. */
export const MEMORY_GATEWAY_MESSAGE_OUTCOMES = Object.freeze(["forwarded", "platform_context", "no_text", "not_learning", "invalid", "project_line", "project_line_failed"]);
/** What became of one commit. */
export const MEMORY_GATEWAY_COMMIT_OUTCOMES = Object.freeze(["accepted", "nothing_pending", "not_learning", "rate_limited", "failed"]);
/** Why a caller's conversation is not learned from or read (`memoryAdmission`). */
export const MEMORY_ADMISSION_REASONS = Object.freeze([
  "memory_off", "engine_unavailable", "internal_project", "automated_run", "paused", "trial", "clinical_context", "subagent", "unproven_session", "before_reset",
]);
/** What the gateway refuses by name. */
export const MEMORY_GATEWAY_REFUSALS = Object.freeze([
  "memory_gateway_unauthenticated", "memory_gateway_role_refused", "memory_gateway_route_refused", "memory_gateway_uri_refused",
  "memory_gateway_body_invalid", "memory_gateway_payload_too_large", "memory_gateway_rate_limited", "memory_gateway_tool_refused",
  "memory_gateway_disabled", "memory_scope_denied",
]);
/** What became of the end of an attended turn (`nativeTurnCommit.mjs`): armed, folded into a later one (debounced), turned away
 *  (dropped at the bound, a platform-started turn, an attended turn already running again, an account being deleted), or what the
 *  commit did. */
export const NATIVE_TURN_COMMIT_OUTCOMES = Object.freeze([
  "scheduled", "debounced", "dropped", "platform_started", "conversation_running",
  "committed", "nothing_pending", "not_learning", "before_reset", "rate_limited", "failed", "account_deleted",
]);
/** What the worker did with a commit. */
export const NATIVE_COMMIT_OUTCOMES = Object.freeze(["ingested", "empty", "failed", "replayed", "abandoned", "found_by_scan", "before_reset"]);
/**
 * What a settled commit's extraction came to (`nativeMemoryWorker.extractionFacts`): wrote something, wrote some and was refused
 * some, was refused everything it proposed, or proposed nothing at all. The two zero-file outcomes are told apart on purpose: a
 * model that proposed nothing is a template or a conversation, an engine that refused is a policy.
 */
export const NATIVE_EXTRACTION_OUTCOMES = Object.freeze(["wrote", "wrote_and_skipped", "only_skipped", "proposed_nothing"]);
/** The engine's own reasons for skipping an operation it was proposed (`skipped_operations[].reason_code`); anything else is `other`. */
export const NATIVE_SKIP_REASONS = Object.freeze([
  "memory_type_filtered", "self_memory_disabled", "invalid_ranges", "ambiguous_target", "no_writable_target", "page_id_type_mismatch", "other",
]);
/**
 * What became of a pass of the memory consolidation over one account (`nativeMemoryConsolidation.mjs`): nothing to do yet (not due),
 * the files had not changed since the last one, too few to consolidate, held back (learning paused, a commit still working, another
 * worker's lease), a task submitted, one finished (and read in), failed or lost.
 */
export const NATIVE_CONSOLIDATION_OUTCOMES = Object.freeze(["not_due", "unchanged", "too_few", "held_back", "submitted", "completed", "failed", "lost"]);
/** What a finished consolidation did to the account's files. */
export const NATIVE_CONSOLIDATION_CHANGES = Object.freeze(["added", "updated", "deleted"]);
/** After-the-fact removals by reason. Attribution attempts are counted separately from removals. */
export const NATIVE_CHECK_ACTIONS = Object.freeze(["identifier_shape", "platform_text", "rejected_line", "rejected_reworded", "rejected_judged", "recent_work_default_project",
  "pasted_instruction"]);
/** Outcomes of the optional personal-line attribution check; an unsuccessful check keeps the line. */
export const NATIVE_PASTED_INSTRUCTION_CHECK_OUTCOMES = Object.freeze(["asked", "failed", "unavailable", "limited", "stale"]);
/** What became of a call to the model that judges whether a line repeats one the person removed: asked, failed (unreachable, or not the one shape), over the account's day, or no model here. */
export const NATIVE_REJECTION_JUDGE_OUTCOMES = Object.freeze(["asked", "failed", "over_budget", "unavailable"]);
/** What became of the lines that were near a removed one: held by containment (code), judged the same or not (the model), or kept because the judge could not say. */
export const NATIVE_REJECTION_LINE_VERDICTS = Object.freeze(["contained", "judged_same", "judged_kept", "judge_failed"]);
/** What became of a note of the `observations` type that two conversations may have written: promoted to a preference, held back because its words were empty, or a pass that failed. */
export const NATIVE_OBSERVATION_OUTCOMES = Object.freeze(["promoted", "empty", "failed"]);
/** What became of an extraction a reset found still running: its files taken out after it finished (`swept`), a task the engine no longer holds (`unknown`), or still running at this pass (`waiting`). */
export const NATIVE_RESET_SWEEP_OUTCOMES = Object.freeze(["swept", "unknown", "waiting"]);
/** Why a commit's extraction failed, as far as the engine's own error says: the output ran out of room (`budget_exhausted`, v0.5.2), the model budget was spent (`quota`), or anything else. */
export const NATIVE_EXTRACTION_FAILURES = Object.freeze(["budget_exhausted", "quota", "other"]);
/** What became of the deletion of a session's privacy configuration (v0.5.2's privacy tree) that follows a session's deletion: deleted, absent (404: none, or an engine that has no such route), or failed. */
export const NATIVE_PRIVACY_DELETE_OUTCOMES = Object.freeze(["deleted", "absent", "failed"]);
/** What the check of an account's memory policy against the deployment's list of types found: already the list, rewritten to it, or the engine could not say. */
export const NATIVE_POLICY_SYNC_OUTCOMES = Object.freeze(["current", "rewritten", "failed"]);
/** Lines removed because the person forgot another that says the same, and the judge's part in it. */
export const NATIVE_FORGET_DUPLICATE_OUTCOMES = Object.freeze(["removed", "judge_failed", "kept"]);
/** What became of a recall-statistics write (`last_recalled_at`): noted, or failed (never a reason for a recall to fail). */
export const NATIVE_RECALL_NOTE_OUTCOMES = Object.freeze(["noted", "failed", "receipt_failed"]);
/** What the page's import did: offered a list, saved it, was refused for the rate, or had no usable answer from the model. */
export const NATIVE_IMPORT_OUTCOMES = Object.freeze(["offered", "saved", "rate_limited", "model_failed"]);
/** The map's read of what the memories used to say: read, failed, or not finished inside its own deadline (the map is drawn without those marks and nothing else is lost). */
export const NATIVE_MAP_REPLACED_OUTCOMES = Object.freeze(["read", "failed", "timeout"]);
/** What the worker wrote besides revisions. */
export const NATIVE_WORKER_WRITES = Object.freeze(["project_tag", "source_label_added", "source_label_removed", "registration"]);

/** @param {readonly string[]} labels */
const table = (labels) => new Map(labels.map((label) => [label, 0]));
/** @param {Map<string, number>} map @param {string} key @param {number} [by] */
function bump(map, key, by = 1) { if (map.has(key)) map.set(key, (map.get(key) ?? 0) + Math.max(0, Math.trunc(by) || 0)); }

const maintenance = table(['summary_rebuilds', 'forget_scans', 'forget_scan_retries']);
/** @param {{summary_rebuilds:number,forget_scans:number,forget_scan_retries:number}} counts */
export function recordNativeMaintenance(counts) {
  for (const [key, value] of Object.entries(counts)) if (maintenance.has(key)) maintenance.set(key, Number(value) || 0);
}

const requests = new Map(MEMORY_GATEWAY_ROUTES.flatMap((route) => MEMORY_GATEWAY_OUTCOMES.map((outcome) => [`${route}\u0000${outcome}`, 0])));
const messages = table(MEMORY_GATEWAY_MESSAGE_OUTCOMES);
const masked = table(["messages"]);
const commits = table(MEMORY_GATEWAY_COMMIT_OUTCOMES);
const withheld = table(MEMORY_ADMISSION_REASONS);
const refusals = table(MEMORY_GATEWAY_REFUSALS);
const upstreamFailures = table(["timeout", "unavailable", "other"]);
const ledgerFailures = table(["commit_not_recorded"]);
const turnCommits = table(NATIVE_TURN_COMMIT_OUTCOMES);
const workerCommits = table(NATIVE_COMMIT_OUTCOMES);
const workerOperations = table(["added", "updated", "deleted"]);
const extractionOutcomes = table(NATIVE_EXTRACTION_OUTCOMES);
const skippedOperations = table(NATIVE_SKIP_REASONS);
const rejectionJudge = table(NATIVE_REJECTION_JUDGE_OUTCOMES);
const rejectionLines = table(NATIVE_REJECTION_LINE_VERDICTS);
const consolidations = table(NATIVE_CONSOLIDATION_OUTCOMES);
const consolidatedFiles = table(NATIVE_CONSOLIDATION_CHANGES);
const checkActions = table(NATIVE_CHECK_ACTIONS);
const pastedInstructionChecks = table(NATIVE_PASTED_INSTRUCTION_CHECK_OUTCOMES);
const workerWrites = table(NATIVE_WORKER_WRITES);
const workerPasses = table(["completed", "failed"]);
const observationOutcomes = table(NATIVE_OBSERVATION_OUTCOMES);
const resetSweeps = table(NATIVE_RESET_SWEEP_OUTCOMES);
const resetSweptFiles = table(["files"]);
const extractionFailures = table(NATIVE_EXTRACTION_FAILURES);
const privacyDeletes = table(NATIVE_PRIVACY_DELETE_OUTCOMES);
const policySyncs = table(NATIVE_POLICY_SYNC_OUTCOMES);
const forgetDuplicates = table(NATIVE_FORGET_DUPLICATE_OUTCOMES);
const recallNotes = table(NATIVE_RECALL_NOTE_OUTCOMES);
const imports = table(NATIVE_IMPORT_OUTCOMES);
const mapReplaced = table(NATIVE_MAP_REPLACED_OUTCOMES);
const verificationJudge = table(['asked', 'failed', 'over_budget', 'unavailable']);
const noteLabels = table(['checked', 'labelled', 'malformed']);
const verificationLines = table(['supported', 'corrected', 'unsupported', 'unverifiable']);

/** @param {string} outcome */
export function recordVerificationJudge(outcome) { bump(verificationJudge, outcome); }
/** @param {string} outcome @param {number} [count] */
export function recordVerificationLines(outcome, count = 1) { bump(verificationLines, outcome, count); }

/** Syntax-only NOTES coverage; no text, URI or account id is a metric label.
 * @param {{ checked: number, labelled: number, malformed: number }} result */
export function recordMemoryNoteLabels(result) {
  bump(noteLabels, 'checked', result.checked);
  bump(noteLabels, 'labelled', result.labelled);
  bump(noteLabels, 'malformed', result.malformed);
}

/** One gateway request. @param {string} route @param {string} outcome */
export function recordGatewayRequest(route, outcome) {
  const key = `${MEMORY_GATEWAY_ROUTES.includes(route) ? route : "unknown"}\u0000${outcome}`;
  if (requests.has(key)) requests.set(key, (requests.get(key) ?? 0) + 1);
}
/** One captured message. @param {string} outcome */
export function recordGatewayMessage(outcome) { bump(messages, outcome); }
/** A message whose identifier-shaped spans were masked before it was forwarded. */
export function recordGatewayMasked() { bump(masked, "messages"); }
/** One commit at the gateway. @param {string} outcome */
export function recordGatewayCommit(outcome) { bump(commits, outcome); }
/** A request answered as nothing, by why the caller is not read or learned from. @param {string} reason */
export function recordGatewayWithheld(reason) { bump(withheld, reason); }
/** A named refusal. @param {string} code */
export function recordGatewayRefusal(code) { bump(refusals, code); }
/** The engine did not answer the gateway. @param {string} code a `memory_index_*` code */
export function recordGatewayUpstreamFailure(code) {
  bump(upstreamFailures, code === "memory_index_timeout" ? "timeout" : code === "memory_index_unavailable" ? "unavailable" : "other");
}
/** A commit the engine accepted and the ledger could not record (the scan finds its archive). */
export function recordLedgerFailure() { bump(ledgerFailures, "commit_not_recorded"); }
/** One end of an attended turn at the turn committer. @param {string} outcome */
export function recordTurnCommit(outcome) { bump(turnCommits, outcome); }
/** What the worker did with a commit. @param {string} outcome */
export function recordNativeCommit(outcome) { bump(workerCommits, outcome); }
/** Operations of ingested diffs. @param {{ added?: number, updated?: number, deleted?: number }} operations */
export function recordNativeOperations({ added = 0, updated = 0, deleted = 0 }) {
  bump(workerOperations, "added", added); bump(workerOperations, "updated", updated); bump(workerOperations, "deleted", deleted);
}
/**
 * What one settled commit's extraction came to, and the reasons the engine gave for what it skipped.
 * @param {number} operations files the extraction added, updated and deleted
 * @param {{ skipped?: number, skipReasons?: Record<string, number> }} extraction
 */
export function recordNativeExtraction(operations, { skipped = 0, skipReasons = {} } = {}) {
  const skippedCount = Math.max(0, Math.trunc(Number(skipped)) || 0);
  bump(extractionOutcomes, operations > 0 ? (skippedCount > 0 ? "wrote_and_skipped" : "wrote") : (skippedCount > 0 ? "only_skipped" : "proposed_nothing"));
  for (const [reason, count] of Object.entries(skipReasons)) bump(skippedOperations, skippedOperations.has(reason) ? reason : "other", Number(count) || 0);
}
/** One pass of the consolidation over an account. @param {string} outcome */
export function recordNativeConsolidation(outcome) { bump(consolidations, outcome); }
/** The files a finished consolidation changed. @param {{ added?: number, updated?: number, deleted?: number }} changes */
export function recordNativeConsolidatedFiles({ added = 0, updated = 0, deleted = 0 }) {
  bump(consolidatedFiles, "added", added); bump(consolidatedFiles, "updated", updated); bump(consolidatedFiles, "deleted", deleted);
}
/** One call of the rejection judge. @param {string} outcome */
export function recordRejectionJudge(outcome) { bump(rejectionJudge, outcome); }
/** Lines that were near a removed one, by what became of them. @param {string} verdict @param {number} [count] */
export function recordRejectionLines(verdict, count = 1) { bump(rejectionLines, verdict, count); }
/** An after-the-fact removal, by its bounded reason code. @param {string} reason */
export function recordNativeCheck(reason) { bump(checkActions, reason); }
/** An attribution attempt, separate from the lines actually removed. @param {string} outcome */
export function recordPastedInstructionCheck(outcome) { bump(pastedInstructionChecks, outcome); }
/** @param {string} what */
export function recordNativeWrite(what) { bump(workerWrites, what); }
/** One pass of the worker. @param {boolean} ok */
export function recordNativePass(ok) { bump(workerPasses, ok ? "completed" : "failed"); }

/** A note of the observations type, by what became of it. @param {string} outcome */
export function recordObservationPromotion(outcome) { bump(observationOutcomes, outcome); }
/** An extraction a reset found running, by what the sweep did. @param {string} outcome @param {number} [files] files taken out */
export function recordResetSweep(outcome, files = 0) { bump(resetSweeps, outcome); if (files) bump(resetSweptFiles, "files", files); }
/** A failed extraction's error, classified. @param {unknown} error the task's error text */
export function recordNativeExtractionFailure(error) {
  const text = String(error ?? "");
  bump(extractionFailures, /budget_exhausted/i.test(text) ? "budget_exhausted" : /insufficient_quota/i.test(text) ? "quota" : "other");
}
/** A session's privacy configuration deletion. @param {string} outcome */
export function recordPrivacyDelete(outcome) { bump(privacyDeletes, outcome); }
/** An account's type allowlist checked against the deployment's. @param {string} outcome */
export function recordPolicySync(outcome) { bump(policySyncs, outcome); }
/** Lines removed with a forgotten one, by what the judge made of them. @param {string} outcome @param {number} [count] */
export function recordForgetDuplicates(outcome, count = 1) { bump(forgetDuplicates, outcome, count); }
/** The recall statistics write. @param {string} outcome */
export function recordRecallNote(outcome) { bump(recallNotes, outcome); }
/** One step of the page's import. @param {string} outcome */
export function recordImport(outcome) { bump(imports, outcome); }
/** One read of the map's grey marks. @param {string} outcome */
export function recordMapReplaced(outcome) { bump(mapReplaced, outcome); }

/** The test hook: counters are process state. */
export function resetNativeMemoryMetrics() {
  for (const map of [maintenance, requests, messages, masked, commits, withheld, refusals, upstreamFailures, ledgerFailures, turnCommits, workerCommits, workerOperations, extractionOutcomes, skippedOperations, rejectionJudge, rejectionLines, consolidations, consolidatedFiles, checkActions, pastedInstructionChecks, workerWrites, workerPasses, observationOutcomes, resetSweeps, resetSweptFiles, extractionFailures, privacyDeletes, policySyncs, forgetDuplicates, recallNotes, imports, mapReplaced, verificationJudge, verificationLines, noteLabels]) {
    for (const key of map.keys()) map.set(key, 0);
  }
}

/** The counters as plain objects, for tests and for readiness. */
export function nativeMemoryCounters() {
  const plain = (/** @type {Map<string, number>} */ map) => Object.fromEntries(map);
  return {
    maintenance: plain(maintenance),
    noteLabels: plain(noteLabels),
    requests: Object.fromEntries([...requests].map(([key, value]) => [key.replace("\u0000", ":"), value])),
    messages: plain(messages), masked: plain(masked), commits: plain(commits), withheld: plain(withheld), refusals: plain(refusals),
    upstreamFailures: plain(upstreamFailures), ledgerFailures: plain(ledgerFailures), turnCommits: plain(turnCommits), workerCommits: plain(workerCommits),
    workerOperations: plain(workerOperations), extractionOutcomes: plain(extractionOutcomes), skippedOperations: plain(skippedOperations),
    rejectionJudge: plain(rejectionJudge), rejectionLines: plain(rejectionLines), consolidations: plain(consolidations), consolidatedFiles: plain(consolidatedFiles), checkActions: plain(checkActions), pastedInstructionChecks: plain(pastedInstructionChecks), workerWrites: plain(workerWrites), workerPasses: plain(workerPasses),
    observationOutcomes: plain(observationOutcomes), resetSweeps: plain(resetSweeps), resetSweptFiles: plain(resetSweptFiles), extractionFailures: plain(extractionFailures),
    privacyDeletes: plain(privacyDeletes), policySyncs: plain(policySyncs), forgetDuplicates: plain(forgetDuplicates), recallNotes: plain(recallNotes), imports: plain(imports), mapReplaced: plain(mapReplaced), verificationJudge: plain(verificationJudge), verificationLines: plain(verificationLines),
  };
}

/** @param {Map<string, number>} map @param {string} label */
const series = (map, label) => [...map].map(([key, value]) => ({ value, labels: { [label]: key } }));

/**
 * @returns {Array<{ name: string, help: string, type: "counter" | "gauge", series: Array<{ value: number, labels?: Record<string, string> }> }>}
 */
export function nativeMemoryMetricFamilies() {
  return [
    { name: 'open_science_native_memory_maintenance_pending', type: 'gauge', series: series(maintenance, 'kind'),
      help: 'Durable summary rebuild and paraphrase scan obligations, including scans waiting to retry; refreshed by the native worker.' },
    { name: 'open_science_native_memory_note_labels_total', type: 'counter', series: series(noteLabels, 'outcome'),
      help: 'Extraction-v2 NOTES statement checks per fresh write: checked, labelled (a recognised source label; an unlabelled statement is not an error), malformed label/outcome/date; no content rewrite.' },
    { name: 'open_science_native_memory_verification_judge_total', type: 'counter', series: series(verificationJudge, 'outcome'),
      help: 'Source verification judge calls, including failed and unavailable calls and the daily cap.' },
    { name: 'open_science_native_memory_verification_lines_total', type: 'counter', series: series(verificationLines, 'outcome'),
      help: 'Memory lines checked against original conversation excerpts; unsupported without a pre-image remains report-only.' },
    { name: "open_science_memory_gateway_requests_total", type: "counter",
      series: [...requests].map(([key, value]) => { const [route, outcome] = key.split("\u0000"); return { value, labels: { route, outcome } }; }),
      help: "Requests the memory gateway answered, by route and by what became of them: forwarded to the engine, answered locally, withheld (answered as nothing because the caller is not read or learned from), refused by name, or failed upstream." },
    { name: "open_science_memory_gateway_messages_total", type: "counter", series: series(messages, "outcome"),
      help: "Captured conversation messages at the memory gateway: forwarded to the engine, dropped because they carry platform-injected text, dropped because they hold no text (tool calls), not forwarded because the caller is not learned from, or invalid." },
    { name: "open_science_memory_gateway_masked_total", type: "counter", series: series(masked, "what"),
      help: "Messages whose identifier-shaped spans (a phone, an ID number, a card, an e-mail, a key) were masked before the engine saw them." },
    { name: "open_science_memory_gateway_commits_total", type: "counter", series: series(commits, "outcome"),
      help: "Commits at the memory gateway: accepted by the engine and written to the ledger, nothing pending, not forwarded because the caller is not learned from, held by the hourly limit, or failed." },
    { name: "open_science_memory_gateway_withheld_total", type: "counter", series: series(withheld, "reason"),
      help: "Requests answered as nothing or accepted without forwarding, by why the caller's conversation is not read or learned from." },
    { name: "open_science_memory_gateway_refusals_total", type: "counter", series: series(refusals, "code"),
      help: "Requests the memory gateway refused, by the named code." },
    { name: "open_science_memory_gateway_upstream_failures_total", type: "counter", series: series(upstreamFailures, "kind"),
      help: "Engine calls of the memory gateway that got no answer in time (timeout), no connection (unavailable) or another failure. The gateway answers 5xx at once: a memory service that hangs delays a new conversation's first prompt." },
    { name: "open_science_memory_gateway_ledger_failures_total", type: "counter", series: series(ledgerFailures, "what"),
      help: "Commits the engine accepted that the commit ledger could not record at the gateway; the archive scan finds them." },
    { name: "open_science_native_memory_turn_commits_total", type: "counter", series: series(turnCommits, "outcome"),
      help: "Ends of an attended turn at the turn committer, which commits the conversation's engine session a few seconds after the turn so that a short conversation is learned from without waiting for the plugin's token threshold: scheduled, folded into a later turn (debounced), dropped at the bound, ignored because the platform started the turn or the person is already typing again, and what the commit did (committed, nothing pending, not learning, held by the hourly limit, failed). committed is one extraction call." },
    { name: "open_science_native_memory_commits_total", type: "counter", series: series(workerCommits, "outcome"),
      help: "What the native memory worker did with commits: ingested a diff, read an empty diff, found a failed extraction, replayed one, abandoned one after the replay cap, or found an archive only the scan could see." },
    { name: "open_science_native_memory_operations_total", type: "counter", series: series(workerOperations, "change"),
      help: "Memory operations read from ingested diffs: files added, updated and deleted by the engine's extraction." },
    { name: "open_science_native_memory_commit_operations_total", type: "counter", series: series(extractionOutcomes, "outcome"),
      help: "Settled native memory commits by what their extraction came to: wrote something, wrote some and was refused some by the engine, was refused everything it proposed, or proposed nothing. A commit that wrote no file is one of the last two: the model proposed nothing (the templates and the conversation), or the engine refused what it proposed (a policy)." },
    { name: "open_science_native_memory_skipped_operations_total", type: "counter", series: series(skippedOperations, "reason"),
      help: "Operations the engine skipped in settled native memory commits, by the engine's own reason code (memory_type_filtered: a type outside the account's allowlist; self_memory_disabled: learning paused; ambiguous_target, no_writable_target, invalid_ranges, page_id_type_mismatch: the proposal did not name a file it could write); any other code is other." },
    { name: "open_science_native_memory_rejection_judge_total", type: "counter", series: series(rejectionJudge, "outcome"),
      help: "Calls to the model that judges whether a line the engine wrote repeats one the person removed (one call a commit at most): asked, failed (unreachable, or not the one answer shape: the lines are kept), over the account's day, or unavailable." },
    { name: "open_science_native_memory_rejection_lines_total", type: "counter", series: series(rejectionLines, "verdict"),
      help: "Lines near one the person removed, by what became of them: contained (a removed line with something added, decided in code), judged the same by the model, judged different, or kept because the judge could not say." },
    { name: "open_science_native_memory_consolidation_total", type: "counter", series: series(consolidations, "outcome"),
      help: "Passes of the memory consolidation over a native account (OpenViking's own `compile --skill memory`, weekly at most and only after the files changed): not due, unchanged since the last one, too few files, held back (learning paused, a commit still working, another worker's lease), submitted, completed, failed or lost (the engine no longer holds the task)." },
    { name: "open_science_native_memory_consolidated_files_total", type: "counter", series: series(consolidatedFiles, "change"),
      help: "Memory files a finished consolidation added (a split), updated (a merge target, a compaction) and deleted (merged away); each is an overlay revision by the engine that the memory page can undo." },
    { name: "open_science_native_memory_checks_total", type: "counter", series: series(checkActions, "reason"),
      help: "After-the-fact memory removals by reason: identifier shapes, platform text, rejected repeats or an attributed material instruction." },
    { name: "open_science_native_memory_pasted_instruction_checks_total", type: "counter", series: series(pastedInstructionChecks, "outcome"),
      help: "Optional personal-line attribution checks: asked, failed, unavailable, limited, or a stale diff whose judgement was not applied. Unsuccessful checks keep the lines." },
    { name: "open_science_native_memory_writes_total", type: "counter", series: series(workerWrites, "what"),
      help: "What the native memory worker wrote besides revisions: project tags, source labels added to and removed from memory files, account registrations." },
    { name: "open_science_native_memory_passes_total", type: "counter", series: series(workerPasses, "outcome"),
      help: "Passes of the native memory worker, by whether the pass finished." },
    { name: "open_science_native_memory_observations_total", type: "counter", series: series(observationOutcomes, "outcome"),
      help: "Notes of the observations type that two different conversations wrote (a choice made in a request and never called a rule): promoted to a preference, held back because the note held no words, or a pass that failed. A note one conversation wrote is not counted here." },
    { name: "open_science_native_memory_reset_sweeps_total", type: "counter", series: series(resetSweeps, "outcome"),
      help: "Extractions a memory reset found still running, by what the sweep did when it looked: files the finished extraction wrote after the reset were taken out (swept), the engine no longer held the task (unknown), or it was still running (waiting)." },
    { name: "open_science_native_memory_reset_swept_files_total", type: "counter", series: series(resetSweptFiles, "what"),
      help: "Memory files taken out again because an extraction accepted before a reset wrote them after it." },
    { name: "open_science_native_memory_extraction_failures_total", type: "counter", series: series(extractionFailures, "reason"),
      help: "Failed extraction tasks by the engine's own error: budget_exhausted (the model's output ran out of room, v0.5.2 fails fast instead of retrying), quota (the model budget is spent) or other." },
    { name: "open_science_native_memory_privacy_config_deletes_total", type: "counter", series: series(privacyDeletes, "outcome"),
      help: "Deletions of a session's privacy configuration (OpenViking v0.5.2 keeps the credentials it replaced in a session beside the session) that follow a session's deletion: deleted, absent (none, or an engine without the route: v0.5.1.1) or failed." },
    { name: "open_science_native_memory_policy_syncs_total", type: "counter", series: series(policySyncs, "outcome"),
      help: "Checks of an account's memory-type allowlist in the engine against the deployment's list: already the list, rewritten to it (an account whose settings were stored before a type was added), or the engine could not say." },
    { name: "open_science_native_memory_forget_duplicates_total", type: "counter", series: series(forgetDuplicates, "outcome"),
      help: "Lines that state the same thing as one the person forgot, found in other memory files: removed with it, kept because the judge said they differ, or kept because the judge could not answer." },
    { name: "open_science_native_memory_recall_notes_total", type: "counter", series: series(recallNotes, "outcome"),
      help: "Writes of a memory file's last-recalled time and recall count after a search or read through the gateway returned it: noted, or failed (never a reason for the recall to fail)." },
    { name: "open_science_native_memory_imports_total", type: "counter", series: series(imports, "outcome"),
      help: "The page's import of what another assistant remembered: a list offered to the person, a list saved, refused for the account's rate, or the model gave no usable answer." },
    { name: "open_science_native_memory_map_replaced_total", type: "counter", series: series(mapReplaced, "outcome"),
      help: "The memory map's read of what the memories used to say (the revisions behind its grey marks): read, failed, or not finished inside its own deadline. A miss costs those marks and nothing else." },
  ];
}
