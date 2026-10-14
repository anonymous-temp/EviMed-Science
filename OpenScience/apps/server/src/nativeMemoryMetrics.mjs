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
export const MEMORY_GATEWAY_MESSAGE_OUTCOMES = Object.freeze(["forwarded", "platform_context", "no_text", "not_learning", "invalid"]);
/** What became of one commit. */
export const MEMORY_GATEWAY_COMMIT_OUTCOMES = Object.freeze(["accepted", "nothing_pending", "not_learning", "rate_limited", "failed"]);
/** Why a caller's conversation is not learned from or read (`memoryAdmission`). */
export const MEMORY_ADMISSION_REASONS = Object.freeze([
  "legacy_engine", "engine_unavailable", "internal_project", "automated_run", "paused", "trial", "clinical_context", "subagent",
]);
/** What the gateway refuses by name. */
export const MEMORY_GATEWAY_REFUSALS = Object.freeze([
  "memory_gateway_unauthenticated", "memory_gateway_role_refused", "memory_gateway_route_refused", "memory_gateway_uri_refused",
  "memory_gateway_body_invalid", "memory_gateway_payload_too_large", "memory_gateway_rate_limited", "memory_gateway_tool_refused",
  "memory_gateway_disabled",
]);
/** What became of the end of an attended turn (`nativeTurnCommit.mjs`): armed, folded into a later one (debounced), turned away
 *  (dropped at the bound, a platform-started turn, an attended turn already running again), or what the commit did. */
export const NATIVE_TURN_COMMIT_OUTCOMES = Object.freeze([
  "scheduled", "debounced", "dropped", "platform_started", "conversation_running",
  "committed", "nothing_pending", "not_learning", "rate_limited", "failed",
]);
/** What the worker did with a commit. */
export const NATIVE_COMMIT_OUTCOMES = Object.freeze(["ingested", "empty", "failed", "replayed", "abandoned", "found_by_scan"]);
/** What the deterministic after-the-fact checks did, by why. */
export const NATIVE_CHECK_ACTIONS = Object.freeze(["identifier_shape", "platform_text", "rejected_line"]);
/** What the worker wrote besides revisions. */
export const NATIVE_WORKER_WRITES = Object.freeze(["project_tag", "source_label_added", "source_label_removed", "registration"]);

/** @param {readonly string[]} labels */
const table = (labels) => new Map(labels.map((label) => [label, 0]));
/** @param {Map<string, number>} map @param {string} key @param {number} [by] */
function bump(map, key, by = 1) { if (map.has(key)) map.set(key, (map.get(key) ?? 0) + Math.max(0, Math.trunc(by) || 0)); }

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
const checkActions = table(NATIVE_CHECK_ACTIONS);
const workerWrites = table(NATIVE_WORKER_WRITES);
const workerPasses = table(["completed", "failed"]);

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
/** A memory the deterministic checks deleted or restored, by why. @param {string} reason */
export function recordNativeCheck(reason) { bump(checkActions, reason); }
/** @param {string} what */
export function recordNativeWrite(what) { bump(workerWrites, what); }
/** One pass of the worker. @param {boolean} ok */
export function recordNativePass(ok) { bump(workerPasses, ok ? "completed" : "failed"); }

/** The test hook: counters are process state. */
export function resetNativeMemoryMetrics() {
  for (const map of [requests, messages, masked, commits, withheld, refusals, upstreamFailures, ledgerFailures, turnCommits, workerCommits, workerOperations, checkActions, workerWrites, workerPasses]) {
    for (const key of map.keys()) map.set(key, 0);
  }
}

/** The counters as plain objects, for tests and for readiness. */
export function nativeMemoryCounters() {
  const plain = (/** @type {Map<string, number>} */ map) => Object.fromEntries(map);
  return {
    requests: Object.fromEntries([...requests].map(([key, value]) => [key.replace("\u0000", ":"), value])),
    messages: plain(messages), masked: plain(masked), commits: plain(commits), withheld: plain(withheld), refusals: plain(refusals),
    upstreamFailures: plain(upstreamFailures), ledgerFailures: plain(ledgerFailures), turnCommits: plain(turnCommits), workerCommits: plain(workerCommits),
    workerOperations: plain(workerOperations), checkActions: plain(checkActions), workerWrites: plain(workerWrites), workerPasses: plain(workerPasses),
  };
}

/** @param {Map<string, number>} map @param {string} label */
const series = (map, label) => [...map].map(([key, value]) => ({ value, labels: { [label]: key } }));

/**
 * @returns {Array<{ name: string, help: string, type: "counter" | "gauge", series: Array<{ value: number, labels?: Record<string, string> }> }>}
 */
export function nativeMemoryMetricFamilies() {
  return [
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
    { name: "open_science_native_memory_checks_total", type: "counter", series: series(checkActions, "reason"),
      help: "Memories the deterministic after-the-fact checks deleted or restored: an identifier shape, platform-injected text or a platform identifier, or a line the person had removed coming back verbatim." },
    { name: "open_science_native_memory_writes_total", type: "counter", series: series(workerWrites, "what"),
      help: "What the native memory worker wrote besides revisions: project tags, source labels added to and removed from memory files, account registrations." },
    { name: "open_science_native_memory_passes_total", type: "counter", series: series(workerPasses, "outcome"),
      help: "Passes of the native memory worker, by whether the pass finished." },
  ];
}
