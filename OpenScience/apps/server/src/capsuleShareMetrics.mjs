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
const REFUSALS = Object.freeze(["not_text_only", "link_expired", "link_revoked", "link_exhausted", "taken_down", "rate_limited"]);
const TAKEDOWN_BY = Object.freeze(["author", "operator"]);
const SUBSCRIPTION_EVENTS = Object.freeze(["subscribed", "unsubscribed", "recalled"]);
const LEARNING_EVENTS = Object.freeze(["kept_from_platform", "counted"]);

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

/** The test hook: counters are process state. */
export function resetCapsuleShareMetrics() {
  for (const map of [shared, imported, trials, declined, takedowns, takedownCopies, refusals, subscriptions, learning]) {
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
  ];
}
