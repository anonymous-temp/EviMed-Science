// The operator's counters for sharing memory inside the platform (evidence-flywheel plan §7, F17-F19, 2026-10-05).
//
// What is shared, imported, tried, declined and taken down, by channel, and what the write-side defences refused: a pack
// that carried more than text, a uses-exhausted or expired link, an uncorroborated guest pack that was kept out of platform
// learning, an evidence-zone subscription recalled. A counter is a label: counting never changes the operation counted, and
// a counter that cannot be read costs the scrape one gauge and the operation nothing.
//
// Module-level like `evidenceCardMetrics.mjs`: one process, one table, read by `/api/ops/metrics`. Every series exists from the
// start at zero, so the first event is an increase `increase()` can see; an unknown label is ignored, never counted under a
// made-up one.

export const CAPSULE_SHARE_CHANNELS = Object.freeze(["file", "delivery", "link"]);
const REFUSALS = Object.freeze(["not_text_only", "link_expired", "link_revoked", "link_exhausted", "taken_down", "rate_limited", "snapshot_limit"]);
const TAKEDOWN_BY = Object.freeze(["author", "operator"]);
const SUBSCRIPTION_EVENTS = Object.freeze(["subscribed", "unsubscribed", "recalled"]);
const LEARNING_EVENTS = Object.freeze(["kept_from_platform", "counted"]);
// How the keepers of a shared pack stood when corroboration was judged: counted, or left out because the account was too new or had
// finished too few runs (capsuleShareTrust.mjs). Left out is a label on the count, never a refusal of the keeper.
const KEEPER_OUTCOMES = Object.freeze(["counted", "account_too_new", "too_few_runs"]);
// What keeps the capsule store bounded and honest whether or not sharing is on (review C-10, C-11): the password derivation's
// refusals, the snapshot files taken off the disk, and how an account's capsule cleanup ended.
const KDF_REFUSALS = Object.freeze(["account_busy", "queue_full", "waited_out", "params_unsupported"]);
const SNAPSHOT_FILES = Object.freeze(["orphan", "revoked", "temporary", "discarded", "failed"]);
const ACCOUNT_CLEANUP = Object.freeze(["completed", "rolled_back", "failed"]);
// A pack enabled or disabled while a runtime is up: the runtimes were asked to take the new set (`asked`), or the ask failed and the
// click stood (`failed`) — the next launch mounts the right set either way.
const RUNTIME_REFRESH = Object.freeze(["asked", "failed"]);

/** @param {readonly string[]} labels */
const table = (labels) => new Map(labels.map((label) => [label, 0]));
/** @param {Map<string, number>} map @param {string} key */
function bump(map, key, by = 1) { if (map.has(key)) map.set(key, (map.get(key) ?? 0) + by); }

const shared = table(CAPSULE_SHARE_CHANNELS);
const imported = table(CAPSULE_SHARE_CHANNELS);
const trials = table(CAPSULE_SHARE_CHANNELS);
const declined = table(["delivery"]);
const takedowns = table(TAKEDOWN_BY);
const takedownCopies = table(TAKEDOWN_BY);
const refusals = table(REFUSALS);
const subscriptions = table(SUBSCRIPTION_EVENTS);
const learning = table(LEARNING_EVENTS);
const keepers = table(KEEPER_OUTCOMES);
const kdfRefusals = table(KDF_REFUSALS);
const snapshotFiles = table(SNAPSHOT_FILES);
const accountCleanup = table(ACCOUNT_CLEANUP);
const runtimeRefresh = table(RUNTIME_REFRESH);

/** A pack handed to others. @param {string} channel */
export function recordShared(channel) { bump(shared, channel); }
/** A shared pack imported by a recipient. @param {string} channel */
export function recordShareImported(channel) { bump(imported, channel); }
/** A shared pack tried once. @param {string} channel */
export function recordShareTrial(channel) { bump(trials, channel); }
/** A delivery declined by its recipient. */
export function recordShareDeclined() { bump(declined, "delivery"); }
/** A take-down and how many recipients' copies it disabled. @param {string} by @param {number} copies */
export function recordTakedown(by, copies) { bump(takedowns, by); bump(takedownCopies, by, Math.max(0, Math.trunc(copies) || 0)); }
/** A share operation refused by one of the write-side defences. @param {string} reason */
export function recordShareRefused(reason) { bump(refusals, reason); }
/** An evidence-zone subscription event. @param {string} event */
export function recordSubscriptionEvent(event) { bump(subscriptions, event); }
/** A finished run's guest-capsule influence, as learning handled it. @param {string} event */
export function recordShareLearning(event) { bump(learning, event); }
/** Keepers of a shared pack as one corroboration judgement saw them: how many counted, or were left out and why. @param {string} outcome @param {number} count */
export function recordCorroborationKeepers(outcome, count) { bump(keepers, outcome, Math.max(0, Math.trunc(count) || 0)); }

/** A password key derivation refused: this account already has one, the line is full, the wait ran out, or the container asked for a cost the platform never wrote. @param {string} reason */
export function recordKdfRefused(reason) { bump(kdfRefusals, reason); }
/** A snapshot file taken off the disk, or one that could not be. @param {string} event @param {number} [count] */
export function recordSnapshotFile(event, count = 1) { bump(snapshotFiles, event, Math.max(0, Math.trunc(count) || 0)); }
/** How one account's capsule cleanup after a deletion attempt ended. @param {string} outcome */
export function recordAccountCleanup(outcome) { bump(accountCleanup, outcome); }
/** Running runtimes asked to take the capsules now in force, or that could not be asked. @param {string} outcome */
export function recordCapsuleRuntimeRefresh(outcome) { bump(runtimeRefresh, outcome); }

/** The test hook: counters are process state. */
export function resetCapsuleShareMetrics() {
  for (const map of [shared, imported, trials, declined, takedowns, takedownCopies, refusals, subscriptions, learning, keepers, kdfRefusals, snapshotFiles, accountCleanup, runtimeRefresh]) {
    for (const key of map.keys()) map.set(key, 0);
  }
}

/** @param {Map<string, number>} map @param {string} label */
const series = (map, label) => [...map].map(([key, value]) => ({ value, labels: { [label]: key } }));

/**
 * @returns {Array<{ name: string, help: string, type: "counter" | "gauge", series: Array<{ value: number, labels?: Record<string, string> }> }>}
 */
export function capsuleShareMetricFamilies() {
  return [
    { name: "open_science_capsule_shares_total", type: "counter", series: series(shared, "channel"),
      help: "Packs handed to other accounts, by channel: a file, a delivery to a named account, or a share link." },
    { name: "open_science_capsule_share_imports_total", type: "counter", series: series(imported, "channel"),
      help: "Shared packs a recipient imported, by channel." },
    { name: "open_science_capsule_share_trials_total", type: "counter", series: series(trials, "channel"),
      help: "Shared packs a recipient tried once (a conversation that reads only the pack), by channel." },
    { name: "open_science_capsule_share_declines_total", type: "counter", series: series(declined, "channel"),
      help: "Deliveries a recipient declined." },
    { name: "open_science_capsule_takedowns_total", type: "counter", series: series(takedowns, "by"),
      help: "Take-downs of shared packs, by who took them down: the author of one snapshot, or the operator of everything an author shared." },
    { name: "open_science_capsule_takedown_copies_total", type: "counter", series: series(takedownCopies, "by"),
      help: "Recipients' copies a take-down disabled, by who took it down." },
    { name: "open_science_capsule_share_refused_total", type: "counter", series: series(refusals, "reason"),
      help: "Share operations the write-side defences refused: an archive with more than text, a link past its expiry, its uses or its revocation, a taken-down pack, a sender past the daily ceiling." },
    { name: "open_science_evidence_zone_subscription_events_total", type: "counter", series: series(subscriptions, "event"),
      help: "Evidence-zone subscriptions of a project: subscribed, unsubscribed, and recalls that carried a zone's cards as index-only context." },
    { name: "open_science_capsule_share_learning_total", type: "counter", series: series(learning, "event"),
      help: "Finished runs that used a guest capsule: kept from platform-level learning because the share is not yet corroborated, or counted because it is." },
    { name: "open_science_capsule_share_keepers_total", type: "counter", series: series(keepers, "outcome"),
      help: "Accounts that kept a shared pack for the corroboration period, as each judgement of it saw them (summed over judgements): counted toward the minimum, or left out because the account was too new or had too few finished runs." },
  ];
}

/**
 * The counters that bound the capsule store itself, exported with or without sharing: file export, import and an account's
 * deletion all pass through them.
 * @returns {Array<{ name: string, help: string, type: "counter" | "gauge", series: Array<{ value: number, labels?: Record<string, string> }> }>}
 */
export function capsuleStewardshipMetricFamilies() {
  return [
    { name: "open_science_capsule_password_refused_total", type: "counter", series: series(kdfRefusals, "reason"),
      help: "Capsule password key derivations refused, by why: the account already had one in progress, the line was full, the wait ran out, or the container named a cost this platform never wrote." },
    { name: "open_science_capsule_snapshot_files_total", type: "counter", series: series(snapshotFiles, "event"),
      help: "Snapshot files taken off the disk, by why: no snapshot record names them, their snapshot was revoked, they were a crashed write's leftover, or a revoke discarded them; and the ones that could not be removed." },
    { name: "open_science_capsule_account_cleanup_total", type: "counter", series: series(accountCleanup, "outcome"),
      help: "Capsule cleanup after an account's deletion attempt, by how it ended: finished, rolled back (the account stayed and its capsules were released), or failed and retried later." },
    { name: "open_science_capsule_runtime_refresh_total", type: "counter", series: series(runtimeRefresh, "outcome"),
      help: "Enabling or disabling a received pack, as it reached the running runtimes: asked to take the new set of capsule methods, or the ask failed and the next launch carries it." },
  ];
}
