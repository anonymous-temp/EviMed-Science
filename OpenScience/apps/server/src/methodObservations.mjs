/**
 * What a finished run says about the methods it was given.
 *
 * Hidden knowledge: this is the half of the learning loop that was missing, and
 * its absence was invisible. Every other piece existed and was tested — the
 * counters, the promotion truth table, the paired-evaluation gate, the
 * retirement rule — and `recordObservation` had no caller anywhere in
 * production. So `learning.counts` stayed at zero for every method, which makes
 * `evaluationEligible` false forever, which makes `promotionVerdict` return
 * `candidate` forever. A loop that distilled candidates nightly and could never
 * promote one looked exactly like a loop with nothing worth promoting.
 *
 * The composition test did not catch it either, because it asserted every
 * service was constructed and started. Constructed is not fed.
 *
 * Attribution is per deliverable rather than per run, which is what the
 * delegation receipt already supports: `recordSubagent` keys children by
 * `runId:deliverableId` and a redelegation replaces its first attempt, so one
 * deliverable is one trajectory however many times it was tried. A run that
 * produced four packages is four readings of a method, and each has its own
 * verdict — collapsing them to one run-level outcome would throw away the only
 * signal that says *which* of the four the method helped.
 *
 * What it refuses to attribute matters as much as what it counts:
 *
 * - a deliverable that never reached a verdict (planned, delegated, still
 *   running when the run ended) is not evidence either way;
 * - a method whose mounted digest is not the digest the ledger holds today was
 *   amended between the mount and the read, and counting it would credit new
 *   text with old text's outcome — the exact confusion `(method, digest)`
 *   keying exists to prevent;
 * - a name in the receipt that resolves to no approved method is another
 *   source's entry sharing the same mount directory, and is passed through to
 *   the ledger's receipt without being counted as anything.
 *
 * @module
 */

import { toSkillName } from "@evimed/harness-port";

/**
 * How a deliverable ended, in the observation vocabulary.
 *
 * `accepted` on the first submission and `accepted` after three repairs are
 * different facts about a method: the second says the method was in the room
 * while the gate refused the work twice. Both count as successes — the package
 * shipped — but only one of them is what a method should be promoted for, and
 * keeping them apart is what lets a later rule tell them apart.
 *
 * Anything that never reached a verdict returns null: no verdict, no evidence.
 *
 * @param {{status?: string, attempts?: number} | null | undefined} item
 * @returns {string | null}
 */
export function deliverableOutcome(item) {
  if (!item) return null;
  if (item.status === "accepted") return (Number(item.attempts) || 0) > 1 ? "repaired" : "accepted";
  // `submitted` is the projection's word for "asked for a verdict and was
  // refused"; a run can end there. `planned` and `delegated` never asked.
  if (item.status === "submitted" || item.status === "rejected" || item.status === "failed") return "rejected";
  return null;
}

/**
 * The skills each session actually invoked, by session.
 *
 * Kept per session rather than merged, because a method invoked while producing
 * one deliverable says nothing about a sibling deliverable that was handed the
 * same text and ignored it.
 *
 * Reads the normalized transcript vocabulary — a completed tool part named
 * `skill` carrying `input.name`. `agentRuns` scans for the same thing one level
 * deeper because it reads ledger messages, which are a different shape of the
 * same facts. A method reaches
 * the model twice: inlined into the child's prompt by the delegation, and
 * registered as a callable skill by the capsule plugin. Only the second leaves
 * a trace, so `invoked` means "the model went and read it deliberately", which
 * is a stronger claim than `loaded` and is why they are separate counters.
 *
 * @param {readonly {sessionId?: string, transcript?: any}[]} sessions
 * @returns {Map<string, Set<string>>}
 */
export function invokedSkillsBySession(sessions) {
  /** @type {Map<string, Set<string>>} */
  const bySession = new Map();
  for (const session of sessions ?? []) {
    const sessionId = String(session?.sessionId ?? "");
    if (!sessionId) continue;
    const names = bySession.get(sessionId) ?? new Set();
    for (const message of session?.transcript?.messages ?? []) {
      for (const part of message?.parts ?? []) {
        // The normalized `RunTranscript` shape, which is what
        // `collectRunTranscripts` produces: `part.status` and `part.input`, not
        // `part.state.*`. The nested spelling is the ledger's, built by
        // `transcriptToLedgerMessages` for a different reader, and using it here
        // matches nothing in any real run while a test written to the same
        // wrong shape passes.
        if (part?.type !== "tool" || part?.tool !== "skill" || part?.status !== "completed") continue;
        const name = part?.input?.name;
        if (typeof name === "string" && name.trim()) names.add(name.trim());
      }
    }
    bySession.set(sessionId, names);
  }
  return bySession;
}

/**
 * @typedef {object} KnownMethod
 * @property {string} id
 * @property {string} name       the frontmatter name, which is what the receipt carries
 * @property {string} digest     the digest of the document as mounted
 */

/**
 * @typedef {object} RunMethodObservations
 * @property {{methodId: string, observation: {runId: string, family: string, outcome: string, at: string, invoked: boolean}}[]} observations
 * @property {string[]} eligible   approved methods that were available and not mounted
 * @property {{name: string, digest: string}[]} methodsLoaded
 * @property {{name: string, digest: string}[]} methodsInvoked
 * @property {{name: string, mounted: string, current: string}[]} mismatched
 */

/**
 * Derive every counter movement one finished run earns.
 *
 * Pure: it reads a projection, a transcript and a list of approved methods, and
 * returns what should be recorded. The caller does the recording, so the rule
 * is testable without a store, a container or a run.
 *
 * @param {{run: {id: string}, projection: any, methods: readonly KnownMethod[], sessions?: readonly any[], at?: string}} input
 * @returns {RunMethodObservations}
 */
export function runMethodObservations(input) {
  const runId = String(input.run?.id ?? "");
  const at = input.at ?? new Date().toISOString();
  const byName = new Map((input.methods ?? []).map((method) => [method.name, method]));
  const invokedBySession = invokedSkillsBySession(input.sessions ?? []);
  const items = Array.isArray(input.projection?.plan?.items) ? input.projection.plan.items : [];
  const subagents = Array.isArray(input.projection?.subagents) ? input.projection.subagents : [];

  /** @type {RunMethodObservations["observations"]} */
  const observations = [];
  /** @type {Map<string, string>} */
  const loaded = new Map();
  /** @type {Map<string, string>} */
  const invoked = new Map();
  /** @type {RunMethodObservations["mismatched"]} */
  const mismatched = [];
  const seenFamilies = new Set();

  for (const record of subagents) {
    const deliverableId = String(record?.deliverableId ?? "");
    if (!deliverableId) continue;
    const entries = Array.isArray(record?.methods) ? record.methods : [];
    const invokedHere = invokedBySession.get(String(record?.childSessionId ?? "")) ?? new Set();
    const outcome = deliverableOutcome(items.find((item) => String(item?.id ?? "") === deliverableId));
    // The mounted set is recorded whatever the deliverable did with it: the
    // ledger's job is to say what text was in the room, and a run that ended
    // without a verdict still had the text in it.
    for (const entry of entries) {
      const name = String(entry?.name ?? "");
      const digest = String(entry?.digest ?? "");
      if (!name || !digest) continue;
      loaded.set(name, digest);
      const known = byName.get(name);
      if (known && invokedHere.has(toSkillName(name, "capsule"))) invoked.set(name, digest);
      if (!known || !outcome) continue;
      if (known.digest !== digest) {
        if (!mismatched.some((item) => item.name === name)) {
          mismatched.push({ name, mounted: digest, current: known.digest });
        }
        continue;
      }
      const family = `${runId}:${deliverableId}`;
      const key = `${known.id}\u0000${family}`;
      if (seenFamilies.has(key)) continue;
      seenFamilies.add(key);
      observations.push({
        methodId: known.id,
        observation: { runId, family, outcome, at, invoked: invokedHere.has(toSkillName(name, "capsule")) },
      });
    }
  }

  // Available and not chosen. Counted once per run, because the mount is a
  // property of the run — every child of a run is handed the same directory —
  // so "not chosen" is a decision the selection made once, not per deliverable.
  const eligible = (input.methods ?? [])
    .filter((method) => !loaded.has(method.name))
    .map((method) => method.id);

  return {
    observations,
    eligible,
    methodsLoaded: [...loaded.entries()].map(([name, digest]) => ({ name, digest })),
    methodsInvoked: [...invoked.entries()].map(([name, digest]) => ({ name, digest })),
    mismatched,
  };
}
