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
 *   the ledger's receipt without being counted as anything;
 * - a method read in a session that produced no deliverable has no mounted
 *   digest and no verdict, so it is reported as read and attributed to nothing.
 *   It still counts as "not passed over", which is the one claim it supports.
 *
 * @module
 */

import { toSkillName } from "@evimed/harness-port";

import { learnedMethodDirectoryName } from "./learnedMethodMount.mjs";

/** A mounted learned method's own file, as the `read` tool is handed it:
 *  absolute (`/runtime/capsule-methods/_lm…/SKILL.md`) or relative to the
 *  methods directory. */
const MOUNTED_METHOD_FILE = /(?:^|\/)(_lm[0-9a-f]{32})\/SKILL\.md$/;

/** The same file named anywhere inside a shell command. */
const MOUNTED_METHOD_FILE_IN_COMMAND = /(?:^|[\s/'"=])(_lm[0-9a-f]{32})\/SKILL\.md(?=$|[\s'";|&)<>])/g;

/**
 * The shell programs that print a file's text, a closed vocabulary. A command
 * that names a method's file with anything else — `ls`, `wc -l`, `stat`,
 * `sha256sum` — looked at the file and did not read it. Under-counting a use
 * costs a method one observation of its harm test; over-counting charges it
 * with a run it never shaped, which is the worse error.
 */
const READING_PROGRAMS = new Set([
  "cat", "head", "tail", "sed", "awk", "less", "more", "nl", "grep", "egrep", "rg", "cut", "tac", "bat", "python", "python3", "node",
]);

/**
 * The mounted methods a shell command read, by directory name.
 *
 * Split on the shell's own separators, and each segment judged by the program
 * it runs (past `sudo`, `env` and leading `VAR=value` assignments). The model
 * reaches for `bash` as often as for `read`: on the 2026-09-28 production runs
 * it opened its capability's own method with `wc -l` through the shell and
 * then read it with `read` — so both tools have to be understood, and `wc -l`
 * must not be mistaken for the reading.
 * @param {unknown} command @returns {string[]}
 */
export function methodFilesReadByCommand(command) {
  const text = String(command ?? "");
  if (!text.includes("/SKILL.md")) return [];
  /** @type {Set<string>} */
  const read = new Set();
  for (const segment of text.split(/&&|\|\||[;|\n]/)) {
    const directories = [...segment.matchAll(MOUNTED_METHOD_FILE_IN_COMMAND)].map((match) => match[1]);
    if (!directories.length) continue;
    const words = segment.trim().split(/\s+/);
    let index = 0;
    while (index < words.length && (words[index] === "sudo" || words[index] === "env" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]))) index += 1;
    const program = (words[index] ?? "").split("/").pop() ?? "";
    if (!READING_PROGRAMS.has(program)) continue;
    for (const directory of directories) read.add(directory);
  }
  return [...read];
}

/**
 * Whether a session used a method: called it through the `skill` tool, or
 * opened its mounted file — with `read`, or with a shell program that prints
 * it. A learned method reaches the model as a card naming that file
 * (`packages/socket/src/learnedMethods.mjs`), never as its body, so opening
 * the file is the model deciding the method applies: the same act a skill call
 * was in the spec (§8.5), and the one an agent-scoped row can offer at this
 * pin (2026-09-21).
 * @param {Set<string>} invoked @param {{id?: string, name: string}} method @returns {boolean}
 */
function usedIn(invoked, method) {
  return invoked.has(toSkillName(method.name, "capsule"))
    || (Boolean(method.id) && invoked.has(`file:${learnedMethodDirectoryName(String(method.id))}`));
}

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
 * same facts. A learned method reaches the model as a card — in the session's
 * system prompt and in the delegation or inline method block — that names its
 * file, and the body only when the model opens that file. So `invoked` means
 * "the model judged it applied and went and read it", which is a stronger claim
 * than `loaded` and is why they are separate counters.
 *
 * Until 2026-09-28 the delegation and the inline method carried every learned
 * body whole, the model had no reason to open a file it already held, and this
 * reader found nothing to count: all three approved methods in production were
 * `loaded` 34 times and `invoked` 0 while the transcripts show the model
 * working by them (evals/method-quality/incidents/2026-09-28-learned-method-invoked-zero.json).
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
        if (part?.type !== "tool" || part?.status !== "completed") continue;
        if (part?.tool === "read") {
          const target = String(part?.input?.path ?? part?.input?.file_path ?? part?.input?.filePath ?? "");
          const mounted = MOUNTED_METHOD_FILE.exec(target);
          if (mounted) names.add(`file:${mounted[1]}`);
          continue;
        }
        if (part?.tool === "bash") {
          for (const directory of methodFilesReadByCommand(part?.input?.command ?? part?.input?.cmd)) names.add(`file:${directory}`);
          continue;
        }
        if (part?.tool !== "skill") continue;
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
 * @property {string} [contentDigest] the frozen payload whose observations may be updated
 */

/**
 * @typedef {object} RunMethodObservations
 * @property {{methodId: string, observation: {runId: string, family: string, outcome: string, at: string, invoked: boolean}}[]} observations
 * @property {string[]} eligible   approved methods that were available and not mounted
 * @property {{name: string, digest: string}[]} methodsLoaded
 * @property {{name: string, digest: string}[]} methodsInvoked
 * @property {{name: string, mounted: string, current: string}[]} mismatched
 * @property {{id: string, name: string}[]} invokedWithoutMount
 */

/**
 * Derive every counter movement one finished run earns.
 *
 * Pure: it reads a projection, a transcript and a list of approved methods, and
 * returns what should be recorded. The caller does the recording, so the rule
 * is testable without a store, a container or a run.
 *
 * Two sources of attribution, one per way a deliverable is made:
 *
 *  - **Delegated** — the child's delegation receipt names the methods it was
 *    handed and their mounted digests; the child's own session says whether it
 *    used one.
 *  - **Done in the root session** — no receipt, because nothing was
 *    delegated, but the capsule plugin reports what the runtime mounted for
 *    every session (`projection.mountedMethods`), and the deliverable still has
 *    a verdict. Its methods are those, and "used" is read off the root session.
 *    Until 2026-09-27 such a deliverable earned nothing: the meta-analysis runs
 *    the loop learnt from recorded zero observations, and nine successful runs
 *    that carried a method produced two (audit 2026-09-26, L-G2).
 *
 * @param {{run: {id: string, sessionId?: string}, projection: any, methods: readonly KnownMethod[], sessions?: readonly any[], at?: string}} input
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
      if (known && usedIn(invokedHere, known)) invoked.set(name, digest);
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
        observation: { runId, family, outcome, at, invoked: usedIn(invokedHere, known),
          ...(known.contentDigest ? { contentDigest: known.contentDigest } : {}) },
      });
    }
  }

  // Deliverables the root session made itself: no receipt, so their methods
  // are the ones the runtime mounted for every session, and whether one was
  // used is read off the root session.
  const delegated = new Set(subagents.map((record) => String(record?.deliverableId ?? "")).filter(Boolean));
  const rootInvoked = invokedBySession.get(String(input.run?.sessionId ?? "")) ?? new Set();
  const mountedForRoot = (Array.isArray(input.projection?.mountedMethods) ? input.projection.mountedMethods : [])
    .map((entry) => ({ name: String(entry?.name ?? ""), digest: String(entry?.digest ?? "") }))
    .filter((entry) => entry.name && entry.digest);
  for (const item of items) {
    const deliverableId = String(item?.id ?? "");
    if (!deliverableId || delegated.has(deliverableId)) continue;
    const outcome = deliverableOutcome(item);
    if (!outcome) continue;
    for (const entry of mountedForRoot) {
      const known = byName.get(entry.name);
      if (!known) continue;
      if (known.digest !== entry.digest) {
        if (!mismatched.some((mismatch) => mismatch.name === entry.name)) {
          mismatched.push({ name: entry.name, mounted: entry.digest, current: known.digest });
        }
        continue;
      }
      loaded.set(entry.name, entry.digest);
      const used = usedIn(rootInvoked, known);
      if (used) invoked.set(entry.name, entry.digest);
      const family = `${runId}:${deliverableId}`;
      const key = `${known.id}\u0000${family}`;
      if (seenFamilies.has(key)) continue;
      seenFamilies.add(key);
      observations.push({
        methodId: known.id,
        observation: { runId, family, outcome, at, invoked: used,
          ...(known.contentDigest ? { contentDigest: known.contentDigest } : {}) },
      });
    }
  }

  // Read in a session that produced no deliverable.
  //
  // The mount is recorded on the delegation receipt, so a run that never
  // delegates has no receipt and every loop above skips it — while the root
  // session may well have called the `skill` tool on a learned method and read
  // it. The whole open-domain answer line works that way, and for it this
  // module reported nothing at all *and* counted every approved method as
  // "available and passed over", which is the opposite of what happened.
  //
  // MemOS's local plugin takes the same signal at the moment of the load, from
  // `skill_get`, and calls it a use. Ours is read back off the transcript,
  // which costs nothing extra and cannot be forgotten by a caller.
  //
  // It is not an attribution and never becomes one: with no receipt there is no
  // mounted digest, so there is no text to credit and no deliverable verdict to
  // credit it with. It is a name that was read, which is enough to say the
  // method was not passed over — and enough, through `foldRead`, to keep the
  // retirement rule from reading a method the answer line uses daily as idle.
  const invokedAnywhere = new Set([...invokedBySession.values()].flatMap((names) => [...names]));
  // Carries the id as well as the name, because the name is what the receipt
  // speaks and the id is what the ledger is keyed by. Returning only the name
  // is why this signal reached an audit line and stopped there.
  const invokedWithoutMount = (input.methods ?? [])
    .filter((method) => !loaded.has(method.name) && usedIn(invokedAnywhere, method))
    .map((method) => ({ id: method.id, name: method.name }));

  // Available and not chosen. Counted once per run, because the mount is a
  // property of the run — every child of a run is handed the same directory —
  // so "not chosen" is a decision the selection made once, not per deliverable.
  const used = new Set([...loaded.keys(), ...invokedWithoutMount.map((entry) => entry.name)]);
  const eligible = (input.methods ?? [])
    .filter((method) => !used.has(method.name))
    .map((method) => method.id);

  // The root session's own receipt: the methods the runtime put in front of
  // every session, reported by the capsule plugin (`mountedMethods`). Part of
  // what the run carried, so part of `methodsLoaded`; not a choice, so it
  // moves neither an observation nor the denominator above. A run that did
  // its work without delegating had no record of its methods at all, and every
  // paired-evaluation cell was excluded as `arm_not_applied` (2026-09-21).
  const carried = new Map(loaded);
  for (const entry of Array.isArray(input.projection?.mountedMethods) ? input.projection.mountedMethods : []) {
    const name = String(entry?.name ?? "");
    const digest = String(entry?.digest ?? "");
    if (name && digest && !carried.has(name)) carried.set(name, digest);
  }

  return {
    observations,
    eligible,
    methodsLoaded: [...carried.entries()].map(([name, digest]) => ({ name, digest })),
    methodsInvoked: [...invoked.entries()].map(([name, digest]) => ({ name, digest })),
    mismatched,
    invokedWithoutMount,
  };
}
