import { withMemorySummaryInvalidation, drainMemorySummaryInvalidations } from './nativeMemorySummaries.mjs';
import { withNativeMemoryWrite } from './nativeMemoryWriteFence.mjs';
import { createHash } from "node:crypto";
import { carriesPlatformContext, identifierShapesIn, linkStatesLeftFor, platformIdentifiersIn } from "@evimed/domain";
import { filterCapturedMessage } from "./memoryGateway.mjs";
import { contentHash, lineFingerprint, memoryLines } from "./nativeMemoryOverlay.mjs";
import { HttpError } from './security.mjs';
import {
  recordNativeCheck, recordNativeCommit, recordNativeExtraction, recordNativeExtractionFailure, recordNativeOperations, recordNativePass, recordNativeWrite,
  recordPolicySync, recordRejectionLines, recordResetSweep, recordVerificationLines, recordPastedInstructionCheck,
} from "./nativeMemoryMetrics.mjs";
import { NativeMemoryObservations } from "./nativeMemoryObservations.mjs";
import { neutralMemoryUri, removalLines, removalRefusals, removalText } from "./nativeMemoryRejections.mjs";
import { memoryNameVariants } from './nativeMemoryHardTokens.mjs';
import { NativeMemoryVerification, originalSources, replaceStatement } from './nativeMemoryVerification.mjs';
import { SOURCE_LABEL_PREFIX, sourcesNamedIn } from "./nativeMemoryStore.mjs";
import { OPENVIKING_MEMORY_TYPES } from "./openVikingLayout.mjs";
import { PROJECT_MEMORY_TYPES, nativeMemoryFile, observationFile, parseArchiveUri } from "./openVikingSessions.mjs";

/**
 * The overlay's worker: what the native memory engine did, read into the overlay, and what it cannot do for itself, done.
 *
 * Each pass, for every account the memory plane knows (`overlay.accounts()`):
 *  1. **Registration.** An account the engine's admin routes do not know cannot have its settings changed or be deleted;
 *     the gateway registers on first sight, this catches what it could not.
 *  2. **The commit ledger.** The gateway writes a row for every commit it forwarded; the engine's own idle commits never
 *     pass it, so registered namespace archives are scanned and an archive the ledger lacks is entered. At most eight
 *     namespaces per account are scanned per pass, rotating fairly; already recorded commits are processed independently.
 *  3. **Ingestion.** A finished commit's `memory_diff.json` becomes revisions (before / after: the timeline, 「刚记住了」, the
 *     undo), the files' project tags (a pack restore loses tags, so the overlay keeps them too), and the sources a memory names.
 *     What the extraction said about itself — the operations it skipped and the engine's reason for each, what it extracted, the
 *     types it was allowed — goes on the ledger row and into the metrics (`extractionFacts`), read from the task when the diff is
 *     empty: a commit that wrote no file was either a model that proposed nothing or an engine that refused what it proposed.
 *  4. **The deterministic checks after the fact.** A line the engine wrote that carries an identifier's shape (a phone, an ID
 *     or card number, an e-mail, a key), platform-injected text or a platform identifier, or that the person removed before
 *     and the engine wrote back verbatim (unless the person said it again themselves, word for word, in that conversation: their
 *     words win over their deletion), is taken out again — the file restored or deleted when nothing else is left — and
 *     the revision says why. The templates are the first line (the "never keep" block); this is the code that holds the
 *     closed half of it, seconds after the write rather than before (README §5.3 of the course correction).
 *  4b. **What a reset could not wait for.** An extraction the engine had accepted before the person reset their memory still writes files
 *     after it. The reset wrote down the commits it found running (`native_reset_tombstones`); each pass asks the engine about them, and
 *     whenever one finishes, the files it wrote that still hold exactly what its diff says are taken out again, however late that is
 *     (`#sweepTombstones`; an archive the reset had in its ledger and the scan finds again is settled the same way). A task the engine
 *     no longer holds is closed as `unknown` after a day: nothing could be said of it, and it is counted.
 *  4c. **Where each line came from.** The first commit that brought a line is kept per line (`native_line_origins`), beyond the 32
 *     revisions a file holds; an account's older revisions are read into it once (`#indexOrigins`).
 *  4d. **The type allowlist.** An account whose settings were stored before a memory type was added keeps the old list (a settings PATCH
 *     stores one; the deployment's default applies only to an account never PATCHed): the pass checks the list against the deployment's
 *     and rewrites it, restating the account's learning switch (`#syncPolicy`, idempotent, every six hours at most).
 *  4e. **A repeated choice.** After a commit that wrote a note of the `observations` type, the notes two different conversations wrote
 *     are promoted to preferences (`nativeMemoryObservations.mjs`).
 *  5. **Replay.** A failed extraction is never retried upstream: its archive keeps the messages and a `.failed.json`. The
 *     messages are committed again as a new session, with a cap and a back-off, so one rate-limited minute does not lose a
 *     conversation for good.
 *
 * Source labels (`labelSource`) are written here too, on the call of whoever learns that a source changed.
 *
 * @module nativeMemoryWorker
 */

/** How long a commit may stay without a diff, a failure marker or a task before it is treated as failed and replayed. */
const LOST_AFTER_MS = 30 * 60_000;
/** How long a reset's tombstone waits for an extraction before it is closed as unknown: the engine keeps a task a day. */
const TOMBSTONE_MAX_AGE_MS = 24 * 3_600_000;
/** The catch-all project: it has no subject of its own, and so no card and no recent work (`residentProfile.mjs`). */
const CATCH_ALL_PROJECT_ID = "default";
/** The back-off between replays: one minute, doubled each time, an hour at most. */
const replayDelay = (/** @type {number} */ attempts) => Math.min(3_600_000, 60_000 * 2 ** Math.max(0, attempts));

/** What a label line says about a source's state, in the person's language. */
const LABEL_WORDS = Object.freeze({ retracted: "已撤稿", changed: "已更正", removed: "已从资料库删除", expired: "已过期" });

const isLabelLine = (/** @type {string} */ line) => line.trim().startsWith(SOURCE_LABEL_PREFIX.trim());
const statementOf = (/** @type {string} */ line) => line.trim().replace(/^(?:[-*+]|\d+[.)])\s+/, "");

/**
 * Why one line may not stay, or null. Closed, decidable checks only (principle 5): an identifier's shape, a platform tag or
 * identifier, or a line the person removed — a verbatim repeat (`rejected` a set of fingerprints), or one decided by
 * `nativeMemoryRejections.mjs` (`rejected` a map from fingerprint to the reason: a removed line with something added, or one a model
 * judged to say the same).
 * @param {string} line @param {Set<string> | Map<string, string>} rejected
 * @returns {"identifier_shape" | "platform_text" | "rejected_line" | "rejected_reworded" | "rejected_judged" | "pasted_instruction" | null}
 */
export function lineRefusal(line, rejected) {
  const text = statementOf(line);
  if (!text || isLabelLine(line) || /^#{1,6}\s/.test(line.trim())) {
    return rejected instanceof Map ? /** @type {any} */ (rejected.get(lineFingerprint(removalText(line))) ?? null) : null;
  }
  if (identifierShapesIn(text).length) return "identifier_shape";
  if (carriesPlatformContext(text) || platformIdentifiersIn(text).length) return "platform_text";
  const print = lineFingerprint(text);
  if (rejected instanceof Map) return /** @type {any} */ (rejected.get(print) ?? null);
  return rejected.has(print) ? "rejected_line" : null;
}

/** A body without the lines `refused` names, and whether a statement is left. @param {string} body @param {Set<string> | Map<string, string>} rejected */
export function cleanBody(body, rejected) {
  const kept = [];
  /** @type {string[]} */
  const reasons = [];
  for (const line of String(body ?? "").split("\n")) {
    const reason = lineRefusal(line, rejected);
    if (reason) { reasons.push(reason); continue; }
    kept.push(line);
  }
  const text = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text, reasons, hasStatements: memoryLines(kept.filter((line) => !isLabelLine(line)).join("\n")).some((line) => !/^#/.test(line)) };
}

/** Whether a commit's diff wrote (or changed) a note of the `observations` type. @param {any} diff @param {string} root `nativeMemoryRoot(userId)` */
export function touchesObservations(diff, root) {
  return ["adds", "updates"].some((list) => (Array.isArray(diff?.operations?.[list]) ? diff.operations[list] : []).some((/** @type {any} */ operation) => observationFile(String(operation?.uri ?? ""), root) !== null));
}

const REASON_CODE = /^[a-z][a-z0-9_]{0,59}$/;

/**
 * What an extraction said about itself, from the two places the engine says it (both present on v0.5.0 and v0.5.1.1): the
 * archive's `memory_diff.json` (`skipped_operations[].reason_code` and `summary.total_skipped`) and the commit's task result
 * (`memories_extracted` per category, `memory_extraction.skipped_operations`, `effective_memory_types`). Counts and the
 * engine's reason codes only: a skipped operation's own text is never kept. The diff is the record of the commit; the task's
 * list is read only for a reason the diff does not give (a diff written with nothing in it still comes with its reasons).
 * @param {any} diff the parsed `memory_diff.json` @param {any} [task] `OpenVikingSessions.task()`: `{ status, result }`, or null
 * @returns {{ skipped: number, skipReasons: Record<string, number>, extracted: Record<string, number>, memoryTypes: string[], fromTask: boolean }}
 */
export function extractionFacts(diff, task = null) {
  const list = (/** @type {any} */ value) => (Array.isArray(value) ? value : []);
  const fromDiff = list(diff?.skipped_operations);
  const result = task?.result && typeof task.result === "object" ? task.result : null;
  const fromTask = list(result?.memory_extraction?.skipped_operations);
  const named = fromDiff.length ? fromDiff : fromTask;
  /** @type {Record<string, number>} */
  const skipReasons = {};
  for (const item of named) {
    const code = typeof item?.reason_code === "string" && REASON_CODE.test(item.reason_code) ? item.reason_code : "unknown";
    skipReasons[code] = (skipReasons[code] ?? 0) + 1;
  }
  const count = (/** @type {unknown} */ value) => Math.max(0, Math.trunc(Number(value)) || 0);
  const skipped = Math.max(count(diff?.summary?.total_skipped), count(result?.memory_extraction?.skipped), named.length);
  /** @type {Record<string, number>} */
  const extracted = {};
  for (const [category, amount] of Object.entries(result?.memories_extracted && typeof result.memories_extracted === "object" ? result.memories_extracted : {}).slice(0, 12)) {
    if (REASON_CODE.test(category) && count(amount)) extracted[category] = count(amount);
  }
  const memoryTypes = list(result?.effective_memory_types).filter((/** @type {unknown} */ type) => typeof type === "string" && REASON_CODE.test(type)).slice(0, 16);
  return { skipped, skipReasons, extracted, memoryTypes, fromTask: Boolean(result) };
}

export class NativeMemoryWorker {
  /**
   * @param {{ config: any, memorySettings: any, sessions: import("./openVikingSessions.mjs").OpenVikingSessions,
   *   overlay: import("./nativeMemoryOverlay.mjs").NativeMemoryOverlay, nativeMemory?: any,
   *   projectOfSession?: ((userId: string, sessionId: string) => Promise<string | null>) | null,
   *   memoryContexts?: import('./geoNativeMemoryContext.mjs').GeoNativeMemoryContext | null,
   *   rejectionJudge?: ReturnType<typeof import("./nativeMemoryRejections.mjs").createRejectionJudge> | null,
   *   pastedInstructionJudge?: ReturnType<typeof import("./nativeMemoryPastedInstructions.mjs").createPastedInstructionJudge> | null,
   *   now?: () => Date, report?: (line: string) => void }} dependencies
   *   `projectOfSession` names the project a platform conversation belongs to, for a commit the gateway never saw.
   *   `rejectionJudge` says whether a line near one the person removed repeats it (`nativeMemoryRejections.mjs`); absent, only a verbatim
   *   repeat and a line that contains a removed one are met.
   */
  constructor({ config, memorySettings, sessions, overlay, nativeMemory = null, projectOfSession = null, memoryContexts = null, rejectionJudge = null, pastedInstructionJudge = null, now = null, report = () => {} }) {
    this.config = config ?? {};
    this.memorySettings = memorySettings;
    this.sessions = sessions;
    this.overlay = overlay;
    this.nativeMemory = nativeMemory;
    /** Private history indexing; composed after the authoritative run ledger. */
    this.history = null;
    this.projectOfSession = projectOfSession;
    this.memoryContexts = memoryContexts;
    this.verification = new NativeMemoryVerification({ config: this.config, sessions, overlay, memoryContexts, rejectionJudge });
    /** Namespace scans rotate independently of pending commits. @type {Map<string, string>} */
    this.scanCursors = new Map();
    this.rejectionJudge = rejectionJudge;
    this.pastedInstructionJudge = pastedInstructionJudge;
    /** The consolidation of an account's memories, set by the composition root beside this worker (it reads files back through `ingestConsolidation`). @type {import("./nativeMemoryConsolidation.mjs").NativeMemoryConsolidation | null} */
    this.consolidation = null;
    /** What promotes a choice two conversations repeated (`nativeMemoryObservations.mjs`); built from the store when there is one. @type {{ promote: (userId: string) => Promise<any> } | null} */
    this.observations = nativeMemory && typeof nativeMemory.keepRepeatedChoice === "function"
      ? new NativeMemoryObservations({ overlay, sessions, memorySettings, keepRepeatedChoice: (userId, choice, origins) => nativeMemory.keepRepeatedChoice(userId, choice, origins), report }) : null;
    /** When each account's type allowlist was last checked against the deployment's (`#syncPolicy`). @type {Map<string, number>} */
    this.policyChecked = new Map();
    this.now = now ?? (() => new Date());
    // Due times are written by PostgreSQL. Its own clock decides readiness by
    // default; an explicitly injected evaluation clock remains authoritative.
    this.commitClock = now;
    this.report = report;
    this.replayAttempts = Math.max(0, Math.trunc(Number(this.config.nativeMemoryReplayAttempts ?? 5)));
    /** @type {ReturnType<typeof setInterval> | null} */
    this.timer = null;
    /** @type {Promise<any> | null} */
    this.running = null;
    /** What the last pass did, for readiness. */
    this.last = { at: /** @type {string | null} */ (null), ok: true, accounts: 0, commits: 0, error: /** @type {string | null} */ (null) };
  }

  get applicable() {
    return this.config.memoryEngineEnabled === true && Boolean(this.sessions?.configured && this.overlay?.configured && this.memorySettings?.configured);
  }

  /** What readiness reports: whether the worker applies here, whether it is running, and what its last pass did. */
  status() {
    return { applicable: this.applicable, running: Boolean(this.timer), last: { ...this.last }, ...(this.history ? { history: this.history.status() } : {}) };
  }

  start() {
    if (this.timer || !this.applicable) return;
    const every = Math.max(5_000, Number(this.config.nativeMemoryScanMs) || 60_000);
    this.timer = setInterval(() => { void this.pass().catch(() => {}); }, every);
    this.timer.unref?.();
    void this.pass().catch(() => {});
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass over every native account. Never throws: a failure is the pass's result. */
  async pass() {
    if (this.running) return this.running;
    this.running = this.#pass().finally(() => { this.running = null; });
    return this.running;
  }

  async #pass() {
    let commits = 0;
    let accounts = 0;
    try {
      if (this.history) { await this.history.drainDeletes(); await this.history.backfill(); }
      // The offers of the page's import that nobody saved are not kept past their hour (a saved one a day: what was saved is the engine's).
      await this.overlay.deleteExpiredImports().catch(() => 0);
      for (const userId of await this.overlay.accounts()) {
        accounts += 1;
        try {
          await this.drainSummaryInvalidations(userId);
          await this.#register(userId);
          await this.#syncPolicy(userId);
          await this.#indexOrigins(userId);
          await this.#sweepTombstones(userId);
          await this.scanArchives(userId);
        } catch (error) {
          this.report(`native memory worker: ${userId.slice(0, 8)}… ${String(/** @type {any} */ (error)?.code ?? /** @type {any} */ (error)?.message ?? error).slice(0, 120)}`);
        }
        // An unavailable namespace scan cannot strand other already-recorded
        // commits for the same account.
        try {
          commits += await this.processCommits({ userId });
          await this.nativeMemory?.processAdmissions(userId);
          // The weekly consolidation of the account's memories, where it is switched on (`nativeMemoryConsolidation.mjs`).
          // The account scheduler owns only the personal namespace. Project
          // consolidation needs a namespace-specific task ledger before scheduling.
          await this.consolidation?.tick(userId);
        } catch (error) {
          this.report(`native memory worker: ${userId.slice(0, 8)}… ${String(/** @type {any} */ (error)?.code ?? /** @type {any} */ (error)?.message ?? error).slice(0, 120)}`);
        }
      }
      this.last = { at: this.now().toISOString(), ok: true, accounts, commits, error: null };
      recordNativePass(true);
    } catch (error) {
      this.last = { at: this.now().toISOString(), ok: false, accounts, commits, error: String(/** @type {any} */ (error)?.code ?? "native_memory_pass_failed") };
      recordNativePass(false);
    }
    return this.last;
  }

  /** Maintenance waits for active writers, including a crashed writer's expiring lease. */
  async drainSummaryInvalidations(userId) {
    if (!(await this.overlay.pendingSummaryInvalidations(userId)).length) return 0;
    return withNativeMemoryWrite(this.overlay.database, userId, () => drainMemorySummaryInvalidations(this.sessions, this.overlay, userId,
      this.memoryContexts ? async uri => (await this.memoryContexts.forUri(userId, uri)).sessions : null), { exclusive: true });
  }

  async #assertSummariesSettled(userId) {
    if ((await this.overlay.pendingSummaryInvalidations(userId)).length) {
      throw new HttpError(503, 'memory_summary_rebuild_failed', 'Native memory directory maintenance is incomplete.');
    }
  }

  /** @param {string} userId */
  async #register(userId) {
    const held = await this.overlay.account(userId);
    if (held.registeredAt) return;
    await this.sessions.register(userId);
    await this.overlay.noteRegistered(userId);
    recordNativeWrite("registration");
  }

  #personalContext(userId) {
    return { kind: 'owned', ownerId: userId, namespaceId: this.sessions.engineUser(userId), projectId: null,
      userRoot: this.sessions.userRoot(userId), sessions: this.sessions };
  }

  async #contextForUri(userId, uri) {
    if (this.memoryContexts) return this.memoryContexts.forUri(userId, uri);
    const context = this.#personalContext(userId);
    if (typeof uri !== 'string' || !uri.startsWith(`${context.userRoot}/`)) throw new HttpError(403, 'memory_scope_denied', 'The archive is outside the native memory account.');
    return context;
  }

  async #commitContext(commit, known = null) {
    const context = known ?? await this.#contextForUri(commit.userId, commit.archiveUri);
    if (this.memoryContexts) await this.memoryContexts.assertKnown(context);
    const parsed = parseArchiveUri(commit.archiveUri);
    if (context.ownerId !== commit.userId || !parsed || parsed.rest || parsed.archiveUri !== commit.archiveUri
      || parsed.userRoot !== context.userRoot || parsed.session !== commit.engineSession
      || context.kind === 'geo-project' && commit.projectId != null && commit.projectId !== context.projectId) {
      throw new HttpError(403, 'memory_scope_denied', 'The native commit does not match its registered context.');
    }
    if (context.kind === 'geo-project' && commit.projectId == null) {
      commit = { ...commit, projectId: context.projectId };
      await this.overlay.recordCommit(commit);
    }
    return { context, commit };
  }

  /**
   * The account's type allowlist in the engine is the deployment's. The engine applies `server.user_config_defaults` to an account whose
   * settings were never stored; a settings PATCH stores them (every PATCH of ours restates the list), so an account that was PATCHed
   * before `observations` and `recent_work` existed would never extract them. Idempotent: an account already on the list is left alone, and
   * the check is made at most once in six hours per account in a process. The account's own learning switch is restated, not changed.
   * @param {string} userId
   */
  async #syncPolicy(userId) {
    const checked = this.policyChecked.get(userId);
    if (checked !== undefined && this.now().getTime() - checked < 6 * 3_600_000) return;
    try {
      const held = await this.sessions.settings(userId);
      // An account the engine's admin routes do not know yet has the default; it is looked at again at the next pass.
      if (!held) return;
      const expected = [...(this.sessions?.memoryTypes ?? OPENVIKING_MEMORY_TYPES)].sort();
      if (held.memoryTypes.length === expected.length && held.memoryTypes.every((type, index) => type === expected[index])) {
        recordPolicySync("current");
      } else {
        const settings = await this.memorySettings.settings(userId);
        await this.sessions.setLearning(userId, !settings.learningPaused);
        recordPolicySync("rewritten");
      }
      this.policyChecked.set(userId, this.now().getTime());
    } catch (error) {
      recordPolicySync("failed");
      this.report(`native memory policy: ${userId.slice(0, 8)}… ${String(/** @type {any} */ (error)?.code ?? /** @type {any} */ (error)?.message ?? error).slice(0, 120)}`);
    }
  }

  /**
   * Once per account: the lines of the revisions the overlay already holds are read into the per-line origin index, oldest first, so that a
   * line brought before the index existed still names the commit that brought it. A person's edit or a platform check takes lines out
   * of the index as it takes them out of the file; the file's present text has the last word.
   * @param {string} userId
   */
  async #indexOrigins(userId) {
    if (await this.overlay.originsIndexed(userId)) return;
    let after = "0";
    for (;;) {
      const page = await this.overlay.revisionsForIndex(userId, { afterId: after, limit: 500 });
      if (!page.length) break;
      for (const revision of page) {
        after = revision.id;
        const brought = revision.actor === "engine" && revision.reason !== "consolidation" && revision.change !== "deleted" && revision.after !== null;
        await this.overlay.syncOrigins(userId, revision.uri, {
          after: revision.change === "deleted" || revision.after === null ? "" : String(revision.after),
          before: String(revision.before ?? ""),
          origin: brought ? { revisionId: revision.id, engineSession: revision.engineSession, archiveUri: revision.archiveUri, projectId: revision.projectId, at: revision.changedAt } : null,
        });
      }
      if (page.length < 500) break;
    }
    // What the files say now has the last word: a line that left them by a route no revision records is not in the index either.
    for (const file of (await this.overlay.files(userId)).values()) {
      if (file.body !== null) await this.overlay.syncOrigins(userId, file.uri, { after: file.body });
    }
    await this.overlay.noteOriginsIndexed(userId);
  }

  /**
   * The extractions a reset found still running (`native_reset_tombstones`): when one has finished, the files it wrote after the reset are
   * taken out. The engine's task says whether it is still running and where its diff is; a task it no longer holds (it keeps one a day) is
   * closed as unknown, and an archive with no task is looked for where it was.
   * @param {string} userId
   */
  async #sweepTombstones(userId) {
    for (const tombstone of await this.overlay.openTombstones(userId)) {
      try {
        const age = this.now().getTime() - Date.parse(String(tombstone.resetAt));
        // The namespace the archive is in (the account's own, or a shared GEO project's): its engine user is the one that can read it.
        const sessions = (await this.#contextForUri(userId, tombstone.archiveUri)).sessions;
        const task = tombstone.taskId ? await sessions.task(userId, tombstone.taskId) : null;
        if (task && (task.status === "running" || task.status === "pending") && age < TOMBSTONE_MAX_AGE_MS) { recordResetSweep("waiting"); continue; }
        const diffUri = typeof task?.result?.memory_diff_uri === "string" ? task.result.memory_diff_uri : `${tombstone.archiveUri}/memory_diff.json`;
        const diffText = await sessions.read(userId, diffUri);
        let diff = null;
        try { diff = diffText ? JSON.parse(diffText) : null; } catch { diff = null; }
        if (diff && typeof diff === "object") {
          const removed = await this.#removeWrittenBy(userId, diff, sessions);
          await this.#assertSummariesSettled(userId);
          await this.overlay.closeTombstone(userId, tombstone.archiveUri, "swept", removed);
          recordResetSweep("swept", removed);
        } else if (task && ["completed", "failed", "cancelled"].includes(String(task.status))) {
          // It ended and wrote nothing to take out.
          await this.overlay.closeTombstone(userId, tombstone.archiveUri, "swept", 0);
          recordResetSweep("swept");
        } else if (age >= TOMBSTONE_MAX_AGE_MS) {
          await this.overlay.closeTombstone(userId, tombstone.archiveUri, "unknown", 0);
          recordResetSweep("unknown");
        } else {
          recordResetSweep("waiting");
        }
      } catch (error) {
        this.report(`native memory reset sweep: ${userId.slice(0, 8)}… ${String(/** @type {any} */ (error)?.code ?? /** @type {any} */ (error)?.message ?? error).slice(0, 120)}`);
      }
    }
  }

  /**
   * The files an extraction's diff added or updated that still hold exactly what the diff says it left — a file that says anything else
   * was written since, by a later conversation or by the person, and is theirs — removed from the engine and the overlay.
   * @param {string} userId @param {any} diff @returns {Promise<number>} files removed
   */
  async #removeWrittenBy(userId, diff, sessions = this.sessions) {
    const root = sessions.memoryRoot(userId);
    let removed = 0;
    for (const list of ["adds", "updates"]) {
      for (const operation of Array.isArray(diff?.operations?.[list]) ? diff.operations[list] : []) {
        const uri = String(operation?.uri ?? "");
        if (!nativeMemoryFile(uri, root) && !observationFile(uri, root)) continue;
        const current = await sessions.read(userId, uri).catch(() => null);
        if (current === null || contentHash(current) !== contentHash(String(operation?.after ?? ""))) continue;
        await withMemorySummaryInvalidation(sessions, this.overlay, userId, uri, () => sessions.remove(userId, uri));
        await this.overlay.removeFile(userId, uri);
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * Enter in the ledger every archive of the account it does not hold: the engine's idle commits, and any commit whose ledger
   * row the gateway could not write.
   * @param {string} userId @returns {Promise<number>} archives entered
   */
  async scanArchives(userId, { context = null } = {}) {
    const views = context ? [context] : this.memoryContexts ? await this.memoryContexts.all(userId) : [this.#personalContext(userId)];
    const cursor = context ? null : this.scanCursors.get(userId);
    const start = cursor ? views.findIndex(view => view.namespaceId === cursor) + 1 : 0;
    const ordered = [...views.slice(start), ...views.slice(0, start)].slice(0, 8);
    let entered = 0; const errors = [];
    for (const view of ordered) {
      try { entered += await this.#scanView(userId, view); }
      catch (error) { errors.push(error); }
      if (!context) {
        if (this.scanCursors.size >= 10000 && !this.scanCursors.has(userId)) this.scanCursors.delete(this.scanCursors.keys().next().value);
        this.scanCursors.set(userId, view.namespaceId);
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Some native memory namespace scans could not finish.');
    await this.overlay.noteScanned(userId);
    return entered;
  }

  async #scanView(userId, context) {
    if (context.ownerId !== userId) throw new HttpError(403, 'memory_scope_denied', 'The scan owner does not match.');
    if (this.memoryContexts) await this.memoryContexts.assertKnown(context);
    if (context.kind === 'geo-project') await this.memoryContexts.configure(context);
    const sessions = context.sessions, root = `${context.userRoot}/sessions`;
    const nodes = await sessions.tree(userId, root, { levelLimit: 4, showHidden: true });
    const known = await this.overlay.knownArchives(userId, { userRoot: context.userRoot });
    /** @type {Map<string, { session: string, failed: boolean, finished: boolean }>} */
    const archives = new Map();
    for (const node of nodes) {
      const parsed = parseArchiveUri(node.uri);
      if (!parsed) continue;
      if (parsed.userRoot !== context.userRoot) throw new HttpError(403, 'memory_scope_denied', 'The scan returned another memory namespace.');
      const entry = archives.get(parsed.archiveUri) ?? { session: parsed.session, failed: false, finished: false };
      if (parsed.rest === ".failed.json") entry.failed = true;
      if (parsed.rest === "memory_diff.json" || parsed.rest === ".done") entry.finished = true;
      archives.set(parsed.archiveUri, entry);
    }
    let entered = 0;
    for (const [archiveUri, entry] of archives) {
      if (known.has(archiveUri)) continue;
      const projectId = context.kind === 'geo-project' ? context.projectId : await this.#projectOf(userId, entry.session);
      const projectCreatedAt=context.kind==='geo-project'?context.projectCreatedAt??context.policy.projectCreatedAt:await this.overlay.projectEpochOfSession(userId,entry.session,{userRoot:context.userRoot});
      const recorded = await this.overlay.recordCommit({ userId, archiveUri, engineSession: entry.session, projectId,projectCreatedAt, origin: "scan",
        state: entry.failed && !entry.finished ? "failed" : "pending", error: entry.failed ? "found failed by the archive scan" : "" });
      if (recorded.inserted) { entered += 1; recordNativeCommit("found_by_scan"); }
    }
    return entered;
  }

  /** The platform project an engine session belongs to: from the ledger's earlier rows of it, else from the conversation. */
  async #projectOf(userId, engineSession) {
    const earlier = await this.overlay.projectOfSession(userId, engineSession).catch(() => null);
    if (earlier) return earlier;
    const conversation = /^dsh-([A-Za-z0-9_-]{1,160})$/.exec(engineSession)?.[1];
    if (conversation && this.projectOfSession) return this.projectOfSession(userId, conversation).catch(() => null);
    return null;
  }

  /**
   * Work off what the ledger is owed: diffs to read, failures to replay.
   * @param {{ userId?: string | null, limit?: number }} [options] @returns {Promise<number>} commits settled
   */
  async processCommits({ userId = null, limit = 50 } = {}) {
    let settled = 0;
    for (const commit of await this.overlay.openCommits({ userId, limit, now: this.commitClock ? this.commitClock() : null })) {
      try {
        if (commit.state === "pending") settled += await withNativeMemoryWrite(this.overlay.database,commit.userId,()=>this.#settle(commit)) ? 1 : 0;
        else if (commit.state === "failed") settled += await withNativeMemoryWrite(this.overlay.database,commit.userId,()=>this.#replay(commit)) ? 1 : 0;
      } catch (error) {
        this.report(`native memory commit: ${String(/** @type {any} */ (error)?.code ?? /** @type {any} */ (error)?.message ?? error).slice(0, 120)}`);
      }
    }
    return settled;
  }

  /** Native source authority is frozen on the archive, independent from whichever project now owns its public id. */
  async #sourceAuthorized(commit,context,{abandon=true}={}) {
    if(!this.overlay.sourceDeletion||!commit.projectId)return true;
    const source=await this.overlay.conversationOf(commit.userId,commit.engineSession,commit.archiveUri);
    if(!source)return true;
    const ledger=this.overlay.sourceDeletion.ledger;
    const fence=typeof ledger.nativeSource==='function'?await ledger.nativeSource(commit.userId,commit.projectId,commit.projectCreatedAt??null,source,context.userRoot):await ledger.get({userId:commit.userId,id:commit.projectId},source);
    if(!fence||fence.memoryUserRoot&&!(fence.nativeRoots??[fence.memoryUserRoot]).includes(context.userRoot))return true;
    if(typeof ledger.nativeSource==='function'&&!commit.projectCreatedAt)throw new HttpError(409,'memory_source_lineage_unverified','The archive source incarnation is unknown.');
    if(abandon)await this.overlay.abandonCommit(commit.userId,commit.archiveUri,'source_conversation_deleted');return false;
  }

  /** A pending commit: its diff ingested, its failure noted, or left to finish. @param {any} commit */
  async #settle(commit) {
    const resolved = await this.#commitContext(commit);
    commit = resolved.commit;
    const context = resolved.context, sessions = context.sessions;
    const sourceAllowed=await this.#sourceAuthorized(commit,context,{abandon:false});
    const diffText = await sessions.read(commit.userId, `${commit.archiveUri}/memory_diff.json`);
    if (diffText !== null) {
      let diff;
      try { diff = JSON.parse(diffText); } catch { diff = null; }
      if (diff && typeof diff === "object") {
        this.#assertDiffContext(commit, diff, context);
        if(!sourceAllowed) {
          const task=commit.taskId?await sessions.task(commit.userId,commit.taskId):null;
          // A failed or cancelled task that still wrote a diff is ingested as cleanup authority too; only a task still working waits.
          if(task&&!['completed','failed','cancelled','canceled'].includes(String(task.status).toLowerCase()))return false;
          // Keep the exact typed effects as cleanup authority; no deleted source is judged, recalled or promoted as learning.
          await this.ingest(commit,diff,{context,sourceDeleted:true});
          await this.#assertSummariesSettled(commit.userId);
          await this.overlay.noteNativeIngested(commit.userId,commit.archiveUri);
          await this.overlay.abandonCommit(commit.userId,commit.archiveUri,'source_conversation_deleted');return true;
        }
        // An extraction the engine had accepted before the account reset its memory finishes after it: its files are what the
        // person asked to forget, and they are taken out again instead of being read into the overlay as new memories. A reset
        // that found this very archive running wrote it down, and then no message needs to be readable to know.
        const tombstone = await this.overlay.tombstone(commit.userId, commit.archiveUri);
        const removed = tombstone ? await this.#removeWrittenBy(commit.userId, diff, sessions) : await this.#undoBeforeReset(commit, diff, context);
        await this.#assertSummariesSettled(commit.userId);
        if (tombstone && tombstone.state === "open") await this.overlay.closeTombstone(commit.userId, commit.archiveUri, "swept", removed ?? 0);
        if (removed !== null) {
          await this.overlay.completeCommit(commit.userId, commit.archiveUri, { operations: 0, extraction: { skipped: 0, skipReasons: {}, extracted: {}, memoryTypes: [], fromTask: false, beforeReset: removed } });
          recordNativeCommit("before_reset");
          return true;
        }
        const operations = await this.ingest(commit, diff, { context });
        await this.overlay.noteNativeIngested(commit.userId,commit.archiveUri);
        // A note of the observations type may have just been written by a second conversation. The account's own namespace only: a shared
        // GEO project's keeps no observations (`OPENVIKING_PROJECT_MEMORY_TYPES`) and no preferences to promote them to.
        if (this.observations && context.kind !== 'geo-project' && touchesObservations(diff, sessions.memoryRoot(commit.userId))) await this.observations.promote(commit.userId);
        // A commit that wrote nothing is the one worth asking about: the engine's task result says what the extraction did and
        // what it refused. A task that is gone (the engine keeps them a day) or unreadable leaves the diff's own account.
        const task = operations === 0 && commit.taskId ? await sessions.task(commit.userId, commit.taskId).catch(() => null) : null;
        const extraction = extractionFacts(diff, task);
        await this.#assertSummariesSettled(commit.userId);
        await this.overlay.completeCommit(commit.userId, commit.archiveUri, { operations, extraction });
        recordNativeCommit(operations ? "ingested" : "empty");
        recordNativeExtraction(operations, extraction);
        // Raw-history indexing is optional and best effort: the commit is settled first, so an index that cannot be written never
        // holds the commit queue; the history backfill retries the archive with a backoff and an attempt cap.
        if (this.history) { try { await this.history.ingestArchive(commit, context); } catch { /* recorded on the archive's own ledger row */ } }
        return true;
      }
    }
    if(!sourceAllowed) {
      // The source conversation was deleted and the engine wrote no diff: a commit that is proven failed (the marker, or a failed or
      // cancelled task) is terminal. Left pending it would hide the account's whole memory and fail every cleanup retry.
      let terminal = await sessions.read(commit.userId, `${commit.archiveUri}/.failed.json`) !== null;
      if (!terminal && commit.taskId) {
        const task = await sessions.task(commit.userId, commit.taskId);
        if (['failed', 'cancelled', 'canceled'].includes(String(task?.status ?? '').toLowerCase())) terminal = true;
        else if (task?.status === 'running' || task?.status === 'pending') return false;
      }
      // Positive proof only: a marker or a failed/cancelled task. A timer alone is not proof (an archive found by a scan has no task id and
      // the engine may still write a diff), so such a commit stays pending until the engine says something.
      if (!terminal) return false;
      await this.overlay.abandonCommit(commit.userId, commit.archiveUri, 'source_conversation_deleted');
      return true;
    }
    const failed = await sessions.read(commit.userId, `${commit.archiveUri}/.failed.json`);
    let reason = failed !== null ? "the extraction failed" : "";
    // Why, as far as the engine's own marker says (v0.5.2 fails an extraction whose output ran out of room as `budget_exhausted` and does not retry it).
    if (failed !== null) {
      let detail = failed;
      try { detail = String(JSON.parse(failed)?.error ?? failed); } catch { /* the marker's text is the detail */ }
      recordNativeExtractionFailure(detail);
    }
    if (!reason && commit.taskId) {
      const task = await sessions.task(commit.userId, commit.taskId);
      if (task?.status === "failed") { reason = String(task.error ?? "the extraction failed").slice(0, 300); recordNativeExtractionFailure(task.error); }
      else if (task?.status === "running" || task?.status === "pending") return false;
    }
    if (!reason && Date.now() - Date.parse(String(commit.createdAt)) > LOST_AFTER_MS) reason = "no diff, no failure and no task after thirty minutes";
    if (!reason) return false;
    await this.overlay.failCommit(commit.userId, commit.archiveUri, { error: reason, nextAttemptAt: this.now() });
    recordNativeCommit("failed");
    return false;
  }

  /**
   * Whether this commit's conversation was over before the account last reset its memory — every message of its archive carries a
   * time and the latest is earlier than the reset — and, when it was, what it wrote is removed: the files its diff added or updated
   * that still hold exactly the text the diff says it left (a file that says anything else has been written since, by a later
   * conversation or by the person, and is theirs). A message with no time places the commit nowhere: a rule that needs the metadata
   * to be there before it lets anything through is one missing field away from a platform that stops learning.
   * @param {any} commit @param {any} diff @param {any} context @returns {Promise<number | null>} files removed, or null when the commit is not from before a reset
   */
  async #undoBeforeReset(commit, diff, context) {
    const sessions = context.sessions;
    if (typeof this.memorySettings?.resetInstant !== "function") return null;
    const resetAt = await this.memorySettings.resetInstant(commit.userId).catch(() => null);
    if (!resetAt) return null;
    const raw = await sessions.read(commit.userId, `${commit.archiveUri}/messages.jsonl`).catch(() => null);
    let latest = Number.NEGATIVE_INFINITY;
    let timed = 0;
    for (const line of String(raw ?? "").split("\n")) {
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const at = Date.parse(String(message?.created_at ?? ""));
      if (!Number.isFinite(at)) return null;
      timed += 1;
      latest = Math.max(latest, at);
    }
    if (!timed || latest >= Date.parse(resetAt)) return null;
    return this.#removeWrittenBy(commit.userId, diff, sessions);
  }

  /**
   * A failed commit, committed again from its archive's messages as a new session. The account must still be on the engine
   * and learning; the cap and the back-off bound what one conversation can cost.
   * @param {any} commit
   */
  async #replay(commit) {
    const resolved = await this.#commitContext(commit);
    commit = resolved.commit;
    const context = resolved.context, sessions = context.sessions;
    const userId = commit.userId;
    const external = typeof this.overlay.admissionOfCommit === "function" ? await this.overlay.admissionOfCommit(userId, commit) : null;
    const authorized = async () => {
      if(!await this.#sourceAuthorized(commit,context))return false;
      if (!external) return true;
      const policy = await this.overlay.admissionAuthority(userId, external);
      if (policy.allowed) return true;
      await this.overlay.updateAdmission(userId, external.candidateId, external.revision, { state: policy.state, error: policy.reason, release: true });
      if (policy.state === "cancelled") await this.overlay.abandonCommit(userId, commit.archiveUri, policy.reason);
      return false;
    };
    if (!await authorized()) return false;
    const settings = await this.memorySettings.settings(userId);
    if (settings.learningPaused || (commit.projectId && settings.pausedProjects.includes(commit.projectId))) {
      await this.overlay.abandonCommit(userId, commit.archiveUri, "learning is paused");
      recordNativeCommit("abandoned");
      return true;
    }
    if (commit.attempts >= this.replayAttempts) {
      await this.overlay.abandonCommit(userId, commit.archiveUri, `replayed ${commit.attempts} times without success`);
      recordNativeCommit("abandoned");
      return true;
    }
    const raw = await sessions.read(userId, `${commit.archiveUri}/messages.jsonl`);
    const messages = [];
    for (const line of String(raw ?? "").split("\n")) {
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      // The archive holds what the engine stored: the role and the parts. The same door as the gateway's, again.
      const text = typeof message?.content === "string" ? message.content
        : Array.isArray(message?.parts) ? message.parts.filter((/** @type {any} */ part) => part?.type === "text").map((/** @type {any} */ part) => String(part.text ?? "")).join("\n") : "";
      const decision = filterCapturedMessage({ role: message?.role, content: text, ...(typeof message?.created_at === "string" ? { created_at: message.created_at } : {}) });
      if ("forward" in decision) messages.push(decision.forward);
    }
    if (!messages.length) {
      await this.overlay.abandonCommit(userId, commit.archiveUri, "the archive holds nothing to replay");
      recordNativeCommit("abandoned");
      return true;
    }
    const session = `evimed-replay-${createHash("sha256").update(commit.archiveUri).digest("hex").slice(0, 16)}-${commit.attempts + 1}`;
    try {
      if (!await authorized()) return false;
      if (context.kind === 'geo-project') {
        await this.memoryContexts.configure(context);
        await this.memoryContexts.noteInternal(context, session, { kind: 'replay', sourceArchiveUri: commit.archiveUri });
      }
      await sessions.createSession(userId, session, { timeoutMs: sessions.timeoutMs });
      const state = await sessions.readSession(userId, session).catch(() => null);
      // A replay session that already holds the messages (an earlier attempt that failed after writing them) is committed as it is.
      if (!(Number(state?.result?.message_count) > 0)) for (const message of messages) {
        if (!await authorized()) return false;
        await sessions.addMessage(userId, session, message);
      }
      if (!await authorized()) return false;
      const answer = await sessions.commit(userId, session);
      const result = answer?.result ?? {};
      if (result.status !== "accepted" || typeof result.archive_uri !== "string") throw Object.assign(new Error("the replay commit was not accepted"), { code: "native_replay_not_accepted" });
      const archive = parseArchiveUri(result.archive_uri);
      if (!archive || archive.userRoot !== context.userRoot || archive.session !== session || archive.rest || archive.archiveUri !== result.archive_uri) {
        throw new HttpError(403, 'memory_scope_denied', 'The replay archive does not match its original namespace.');
      }
      await this.overlay.recordCommit({ userId, archiveUri: result.archive_uri, engineSession: session, sourceSession: commit.sourceSession ?? null, projectId: commit.projectId,projectCreatedAt:commit.projectCreatedAt??null, origin: "replay",
        taskId: typeof result.task_id === "string" ? result.task_id : null, pendingText: commit.pendingText, attempts: commit.attempts + 1 });
      await this.overlay.markReplayed(userId, commit.archiveUri, result.archive_uri);
      recordNativeCommit("replayed");
      return true;
    } catch (error) {
      const attempts = await this.overlay.noteReplayAttempt(userId, commit.archiveUri, {
        nextAttemptAt: new Date(this.now().getTime() + replayDelay(commit.attempts)), error: String(/** @type {any} */ (error)?.code ?? /** @type {any} */ (error)?.message ?? "replay failed"),
      });
      if (attempts >= this.replayAttempts) {
        await this.overlay.abandonCommit(userId, commit.archiveUri, `replayed ${attempts} times without success`);
        recordNativeCommit("abandoned");
      }
      return false;
    }
  }

  /** @param {any} commit @param {any} diff @param {any} context */
  #assertDiffContext(commit, diff, context) {
    const root = context.sessions.memoryRoot(commit.userId);
    const operations = diff?.operations ?? {};
    if (context.kind === 'geo-project') {
      if (diff?.archive_uri !== commit.archiveUri) throw new HttpError(403, 'memory_scope_denied', 'The memory diff does not identify its accepted archive.');
      const entries = ['adds', 'updates', 'deletes'].flatMap(key => Array.isArray(operations[key]) ? operations[key] : []);
      if (entries.length > 20000) throw new HttpError(502, 'memory_index_listing_too_large', 'The memory diff exceeds its operation bound.');
      for (const entry of entries) {
        const file = nativeMemoryFile(entry?.uri, root);
        this.memoryContexts.assertUri(context, entry?.uri);
        if (!file || !context.sessions.memoryTypes.includes(file.type)) throw new HttpError(403, 'memory_scope_denied', 'The memory diff contains an unapproved project file.');
      }
    }
  }

  /**
   * One commit's diff into the overlay, with the checks after the fact. Idempotent: a diff read twice writes each revision once.
   * @param {any} commit @param {any} diff @param {{context?:any,sourceDeleted?:boolean}} [options] @returns {Promise<number>} operations read
   */
  async ingest(commit, diff, { context = null,sourceDeleted=false } = {}) {
    const resolved = await this.#commitContext(commit, context);
    commit = resolved.commit; context = resolved.context;
    const userId = commit.userId;
    const root = context.sessions.memoryRoot(userId);
    const operations = diff?.operations ?? {};
    this.#assertDiffContext(commit, diff, context);
    if(sourceDeleted){
      const entries=['adds','updates','deletes'];
      if(diff?.archive_uri!==commit.archiveUri||entries.some(key=>!Array.isArray(operations[key]))||entries.reduce((count,key)=>count+operations[key].length,0)>20000)throw new HttpError(409,'memory_source_lineage_unverified','The native source has no complete typed cleanup receipt.');
      for(const key of entries)for(const operation of operations[key]){
        const file=nativeMemoryFile(operation?.uri,root)??observationFile(operation?.uri,root);
        if(!file||operation.memory_type!==file.type||key!=='deletes'&&typeof operation.after!=='string'||key==='updates'&&typeof operation.before!=='string'||key==='deletes'&&typeof(operation.deleted_content??operation.before)!=='string')throw new HttpError(409,'memory_source_lineage_unverified','A native source effect cannot be verified for cleanup.');
      }
    }
    const counts = { added: 0, updated: 0, deleted: 0 };
    const changedAt = typeof diff?.extracted_at === "string" && Number.isFinite(Date.parse(diff.extracted_at)) ? new Date(diff.extracted_at).toISOString() : null;
    const base = { userId, archiveUri: commit.archiveUri, engineSession: commit.engineSession, changedAt,sourceProjectId:commit.projectId??null,sourceProjectCreatedAt:commit.projectCreatedAt??null };
    const pastedInstructions = sourceDeleted ? new Set() : await this.#pastedInstructions(commit, operations, context).catch(() => {
      recordPastedInstructionCheck("failed"); return new Set();
    });
    for (const [list, change] of /** @type {const} */ ([["adds", "added"], ["updates", "updated"], ["deletes", "deleted"]])) {
      for (const operation of Array.isArray(operations[list]) ? operations[list] : []) {
        const uri = String(operation?.uri ?? "");
        // A note of the observations type is written and counted like a memory file; nothing but `nativeMemoryObservations.mjs` reads it back.
        const file = nativeMemoryFile(uri, root) ?? observationFile(uri, root);
        if (!file) continue;
        counts[change] += 1;
        const projectId = context.kind === 'geo-project' ? context.projectId : PROJECT_MEMORY_TYPES.includes(file.type) ? commit.projectId ?? null : null;
        if (change === "deleted") {
          await withMemorySummaryInvalidation(context.sessions, this.overlay, userId, uri, async () => {});
          await this.overlay.addRevision({ ...base, uri, memoryType: file.type, change, actor: "engine", reason: "", before: operation?.deleted_content ?? operation?.before ?? null, after: null, projectId });
          if(!sourceDeleted)await this.overlay.removeFile(userId, uri);
          continue;
        }
        const after = String(operation?.after ?? "");
        if (change === 'updated' && String(operation?.before ?? '') !== after) {
          await withMemorySummaryInvalidation(context.sessions, this.overlay, userId, uri, async () => {});
        }
        const settledBefore = sourceDeleted ? String(operation?.before ?? "") : (await this.overlay.file(userId, uri))?.body ?? "";
        const recorded = await this.overlay.addRevision({ ...base, uri, memoryType: file.type, change, actor: "engine", reason: "",
          before: change === "updated" ? String(operation?.before ?? "") : null, after, projectId });
        const body = sourceDeleted?await context.sessions.read(userId,uri):await this.#afterWrite(userId, uri, file.type, { projectId, diffAfter: after, diffBefore: change === "updated" ? String(operation?.before ?? "") : "", fresh: recorded !== null, archiveUri: commit.archiveUri, memoryContext: context, pastedInstructions });
        // The lines this commit brought are recorded as its own, beyond the revisions a file keeps (what the checks took out is not).
        if (body !== null) {
          // A later extraction may already have changed this shared file. Never attribute its unrelated lines to this diff.
          const written=new Set(memoryLines(after).map(lineFingerprint));
          const live=new Set(memoryLines(body).map(lineFingerprint)),prior=new Set(memoryLines(operation?.before??'').map(lineFingerprint));
          if(sourceDeleted&&[...written].some(print=>!prior.has(print)&&!live.has(print)))throw new HttpError(409,'memory_source_lineage_unverified','The completed native source text was rewritten without verifiable lineage.');
          const otherLines=memoryLines(body).filter(line=>!written.has(lineFingerprint(line)));
          const engineBefore = new Set(memoryLines(operation?.before ?? '').map(lineFingerprint));
          const originBefore = sourceDeleted ? settledBefore : memoryLines(settledBefore).filter(line => engineBefore.has(lineFingerprint(line))).join('\n');
          await this.overlay.syncOrigins(userId, uri, { after: body, before: [originBefore,...otherLines].join('\n'),
            origin: { revisionId: recorded?.id ?? null, engineSession: commit.engineSession, archiveUri: commit.archiveUri, projectId: commit.projectId ?? projectId,projectCreatedAt:commit.projectCreatedAt??null, at: changedAt } });
        }
      }
    }
    recordNativeOperations(counts);
    return counts.added + counts.updated + counts.deleted;
  }

  /**
   * What the engine's consolidation of an account's memories did, read into the overlay (`nativeMemoryConsolidation.mjs`). The engine
   * lists the files it added, updated and deleted and no content, so each file is read as it is now and set beside what the overlay held:
   * a revision by the engine (`reason: "consolidation"`, one per file and task) with the text before and after, which is what the
   * memory page's undo restores from. The checks after the fact hold what a consolidation wrote as they hold what an extraction wrote —
   * a merge can bring back a line the person removed, in its words or in others' — and a file that is unchanged from what the overlay
   * held is not a change however the engine lists it.
   * @param {string} userId @param {{ taskId: string, adds?: readonly string[], updates?: readonly string[], deletes?: readonly string[], mode?: string }} task
   * @param {{ context?: any }} [options]
   * @returns {Promise<{ added: number, updated: number, deleted: number }>}
   */
  async ingestConsolidation(userId, { taskId, adds = [], updates = [], deletes = [], mode = this.config.nativeMemoryConsolidationMode }, { context = null } = {}) {
    context ??= await this.#contextForUri(userId, this.sessions.memoryRoot(userId));
    if (context.ownerId !== userId) throw new HttpError(403, 'memory_scope_denied', 'The consolidation owner does not match.');
    if (this.memoryContexts) await this.memoryContexts.assertKnown(context);
    const sessions = context.sessions;
    const root = sessions.memoryRoot(userId);
    // A task is bound before its result is read or judged. The account scheduler
    // supplies no project context; it may never consume a project namespace.
    for (const uri of [...adds, ...updates, ...deletes]) {
      const file = nativeMemoryFile(uri, root);
      if (!file || context.kind === 'geo-project' && !sessions.memoryTypes.includes(file.type)) {
        throw new HttpError(403, 'memory_scope_denied', 'The consolidation contains a file outside its memory context.');
      }
      if (this.memoryContexts) this.memoryContexts.assertUri(context, uri);
    }
    const held = await this.overlay.files(userId);
    const verify = mode === 'verify' && this.config.nativeMemoryConsolidationEnabled === true;
    const origins = await this.overlay.originsOf(userId, [...new Set([...adds, ...updates, ...deletes])]);
    const mergeOrigins = [...origins.values()].flatMap(lines => [...lines.values()].flatMap(originalSources));
    const removed = [];
    // One revision per file and task, however often the same task is read (the revisions' own uniqueness key).
    const archiveUri = `consolidation:${taskId}`;
    const counts = { added: 0, updated: 0, deleted: 0 };
    for (const uri of deletes) {
      const file = nativeMemoryFile(uri, root);
      if (!file || await sessions.read(userId, uri) !== null) continue;
      await withMemorySummaryInvalidation(sessions, this.overlay, userId, uri, async () => {});
      const prior = held.get(uri);
      const recorded = await this.overlay.addRevision({ userId, uri, memoryType: file.type, change: "deleted", actor: "engine", reason: "consolidation",
        before: prior?.body ?? null, after: null, archiveUri, projectId: context.kind === 'geo-project' ? context.projectId : PROJECT_MEMORY_TYPES.includes(file.type) ? prior?.projectId ?? null : null });
      await this.overlay.removeFile(userId, uri);
      if (verify && prior) removed.push({ uri, type: file.type, projectId: prior.projectId, body: prior.body });
      if (recorded) counts.deleted += 1;
    }
    /** @type {{ uri: string, type: string, projectId: string | null, before: string, after: string }[]} */
    const written = [];
    for (const uri of new Set([...adds, ...updates])) {
      const file = nativeMemoryFile(uri, root);
      if (!file) continue;
      const current = await sessions.read(userId, uri);
      if (current === null) continue;
      const prior = held.get(uri);
      const before = prior?.body ?? null;
      if (before !== null && contentHash(before) === contentHash(current)) continue;
      if (before !== null) await withMemorySummaryInvalidation(sessions, this.overlay, userId, uri, async () => {});
      const projectId = context.kind === 'geo-project' ? context.projectId : PROJECT_MEMORY_TYPES.includes(file.type) ? prior?.projectId ?? null : null;
      const recorded = await this.overlay.addRevision({ userId, uri, memoryType: file.type, change: before === null ? "added" : "updated", actor: "engine", reason: "consolidation",
        before, after: current, archiveUri, projectId });
      if (recorded) counts[before === null ? "added" : "updated"] += 1;
      written.push({ uri, type: file.type, projectId, before: before ?? "", after: current });
    }
    // The tag of a project's file is put back: a rewrite is not known to keep it.
    const candidates = [], archiveCache = new Map();
    for (const entry of written) {
      const body = await this.#afterWrite(userId, entry.uri, entry.type, { projectId: entry.projectId, diffAfter: entry.after, diffBefore: entry.before, fresh: true, archiveUri: null, memoryContext: context, extraOrigins: mergeOrigins });
      // A line the consolidation wrote anew names no conversation; a line it kept is already in the index with its own.
      if (body !== null && mergeOrigins.length) {
        const prior = new Set(memoryLines(entry.before).map(lineFingerprint));
        await this.overlay.inheritOrigins(userId, entry.uri, new Map(memoryLines(body).filter(line => !prior.has(lineFingerprint(line))).map(line => [lineFingerprint(line), mergeOrigins])));
      }
      if (!verify) {
        if (body !== null) await this.overlay.syncOrigins(userId, entry.uri, { after: body, before: entry.before, origin: { engineSession: null, archiveUri, projectId: entry.projectId } });
        continue;
      }
      if (body === null) continue;
      entry.after = body;
      const now = new Set(memoryLines(body).map(lineFingerprint));
      const before = new Set(memoryLines(entry.before).map(lineFingerprint));
      const departed = [
        ...memoryLines(entry.before).filter(line => !now.has(lineFingerprint(line))).flatMap(line => originalSources(origins.get(entry.uri)?.get(lineFingerprint(line)))),
        ...removed.flatMap(file => [...(origins.get(file.uri)?.values() ?? [])].flatMap(originalSources)),
      ];
      const unique = [...new Map(departed.filter(origin => origin.archiveUri).map(origin => [JSON.stringify(origin), origin])).values()];
      const inherited = new Map();
      for (const text of memoryLines(body).filter(line => !before.has(lineFingerprint(line)))) {
        const fingerprint = lineFingerprint(text);
        inherited.set(fingerprint, unique);
        candidates.push({ text, fingerprint, uri: entry.uri, sources: await this.verification.readSources(userId, unique, context, archiveCache), origins: unique });
      }
      await this.overlay.syncOrigins(userId, entry.uri, { after: body });
      await this.overlay.inheritOrigins(userId, entry.uri, inherited);
    }
    if (verify && candidates.length) {
      const assessed = await this.verification.assess(userId, candidates);
      for (const row of assessed.results) recordVerificationLines(row.corrected ? 'corrected' : row.status);
      let restoreDeleted = false;
      for (const entry of written) {
        const rows = assessed.results.filter(row => row.uri === entry.uri);
        const current = await sessions.read(userId, entry.uri);
        if (current === null || current !== entry.after) continue;
        let next = current;
        const unsupported = rows.some(row => row.status === 'unsupported');
        const inherited = new Map();
        if (unsupported && !entry.before) {
          // A new file has no pre-merge text. Undo its addition, retaining its full body in the deletion revision.
          await this.overlay.addRevision({ userId, uri: entry.uri, memoryType: entry.type, projectId: entry.projectId,
            actor: 'platform', change: 'deleted', reason: 'consolidation_unverified', before: current, after: null });
          await withMemorySummaryInvalidation(sessions, this.overlay, userId, entry.uri, () => sessions.remove(userId, entry.uri));
          await this.overlay.removeFile(userId, entry.uri);
          restoreDeleted = true;
          continue;
        }
        if (unsupported && entry.before) {
          next = entry.before;
          restoreDeleted = true;
          for (const [print, origin] of origins.get(entry.uri) ?? []) inherited.set(print, originalSources(origin));
        } else {
          if (unsupported) restoreDeleted = true;
          for (const row of rows) if (row.corrected) {
            next = replaceStatement(next, row.fingerprint, row.corrected);
            inherited.set(lineFingerprint(row.corrected), row.origins);
          }
        }
        await this.verification.write(userId, { ...entry, body: current }, next,
          unsupported ? 'consolidation_unverified' : 'consolidation_corrected', inherited, context);
      }
      // If a rejected merge consumed another file, restore that pre-image too. Its deletion revision remains undoable.
      if (restoreDeleted) for (const file of removed) {
        if (await sessions.read(userId, file.uri) !== null) continue;
        await withMemorySummaryInvalidation(sessions, this.overlay, userId, file.uri, () => sessions.replace(userId, file.uri, file.body));
        await this.overlay.addRevision({ userId, uri: file.uri, memoryType: file.type, projectId: file.projectId,
          actor: 'platform', change: 'added', reason: 'consolidation_unverified', before: null, after: file.body });
        await this.overlay.upsertFile({ userId, uri: file.uri, memoryType: file.type, projectId: file.projectId, body: file.body });
        await this.overlay.inheritOrigins(userId, file.uri, new Map([...(origins.get(file.uri) ?? [])].map(([print, origin]) => [print, originalSources(origin)])));
        await this.#afterWrite(userId, file.uri, file.type, { projectId: file.projectId, diffAfter: file.body, diffBefore: '', fresh: true, archiveUri: null, memoryContext: context, extraOrigins: mergeOrigins });
      }
    }
    return counts;
  }

  /**
   * What follows an engine write of one file: the checks, the project tag, the sources and their labels, the overlay's copy.
   * Acts on the file as it is now, not as the diff says: a later commit may already have changed it.
   * @param {string} userId @param {string} uri @param {string} type
   * @param {{ projectId: string | null, diffAfter: string, diffBefore?: string, fresh: boolean, archiveUri: string | null, memoryContext: any, extraOrigins?: any[], pastedInstructions?: Set<string> }} context
   * @returns {Promise<string | null>} the file's text after the checks, or null when the file is gone
   */
  async #afterWrite(userId, uri, type, { projectId, diffAfter, diffBefore = "", fresh, archiveUri, memoryContext, extraOrigins = [], pastedInstructions = new Set() }) {
    const sessions = memoryContext.sessions;
    const current = await sessions.read(userId, uri);
    if (current === null) return null;
    // What a project was last worked on is the project's: a conversation of the catch-all has no project to carry it, and a file written
    // from one is taken out (the project card is never handed over in the default project either).
    if (type === "recent_work" && projectId === CATCH_ALL_PROJECT_ID) {
      recordNativeCheck("recent_work_default_project");
      await withMemorySummaryInvalidation(sessions, this.overlay, userId, uri, () => sessions.remove(userId, uri));
      await this.overlay.addRevision({ userId, uri, memoryType: type, change: "deleted", actor: "platform", reason: "recent_work_default_project", before: null, after: null, projectId });
      await this.overlay.removeFile(userId, uri);
      return null;
    }
    const indexed = await this.overlay.file(userId, uri);
    const priorBody = diffBefore ? indexed?.body ?? '' : '';
    const broughtLines = [...new Set([...removalLines(diffAfter, priorBody), ...removalLines(diffAfter, diffBefore)])];
    const origins = (await this.overlay.originsOf(userId, [uri])).get(uri) ?? new Map();
    const archive = archiveUri
      ? await this.verification.readRemovalSources(userId, [{ archiveUri, projectId }], memoryContext) : [];
    const candidates = [];
    const cache = new Map();
    const inherited = await this.verification.readRemovalSources(userId, extraOrigins, memoryContext, cache);
    for (const text of broughtLines) {
      const sources = await this.verification.readRemovalSources(userId, originalSources(origins.get(lineFingerprint(text))), memoryContext, cache);
      // Material is never a human restatement that authorizes removed content, even when its words occur in a user message.
      candidates.push({ text, sources: pastedInstructions.has(`${uri}\u0000${lineFingerprint(text)}`) ? [] : [...archive, ...sources, ...inherited] });
    }
    const filenameVariants = memoryNameVariants(uri);
    // An existing path can outlive the content removed from it. Check names on updates too, using
    // this file's original sources so a later human restatement keeps its authority across edits.
    const nameSources = await this.verification.readRemovalSources(userId, [...origins.values()].flatMap(originalSources), memoryContext, cache);
    candidates.push(...filenameVariants.map(text => ({ text, sources: [...archive, ...inherited, ...nameSources] })));
    const matches = await removalRefusals({ userId, projectId, overlay: this.overlay,
      namespaceId: memoryContext.kind === 'geo-project' ? memoryContext.namespaceId : null,
      judge: this.rejectionJudge, candidates });
    const refused = new Map([...matches].map(([print, hit]) => [print, print === hit.rejected ? 'rejected_line' : hit.via === 'judged' ? 'rejected_judged' : 'rejected_reworded']));
    // A later write may have independently adopted these words. Apply this commit's attribution only to its exact result.
    const brought = new Set(broughtLines.map(lineFingerprint));
    if (current === diffAfter) {
      for (const print of brought) if (!refused.has(print) && pastedInstructions.has(`${uri}\u0000${print}`)) refused.set(print, "pasted_instruction");
    } else if ([...brought].some(print => pastedInstructions.has(`${uri}\u0000${print}`))) recordPastedInstructionCheck("stale");
    const cleaned = cleanBody(current, refused);
    const reasons = [...new Set(cleaned.reasons)];
    let body = current;
    if (reasons.length) {
      for (const reason of cleaned.reasons) recordNativeCheck(reason);
      const contained = cleaned.reasons.filter((reason) => reason === "rejected_reworded").length;
      if (contained) recordRejectionLines("contained", contained);
      const undoable = reasons.includes("pasted_instruction");
      if (undoable) {
        // Undo restores material only; removal and privacy refusals stay excluded from the recoverable pre-image.
        const before = cleanBody(current, new Map([...refused].filter(([, reason]) => reason !== "pasted_instruction"))).text;
        if (!cleaned.hasStatements && reasons.some(reason => reason === "identifier_shape" || reason === "platform_text")) await this.overlay.forgetText(userId, uri);
        await this.overlay.addRevision({ userId, uri, memoryType: type, change: cleaned.hasStatements ? "updated" : "deleted",
          actor: "platform", reason: reasons.join(","), before, after: cleaned.hasStatements ? cleaned.text : null, projectId });
        if (type === "observations") {
          const surviving = new Set(memoryLines(cleaned.text).map(lineFingerprint));
          if (!broughtLines.some(line => surviving.has(lineFingerprint(line)))) await this.#retireObservationEvidence(userId, uri, archiveUri);
        }
      }
      if (cleaned.hasStatements) {
        await withMemorySummaryInvalidation(sessions, this.overlay, userId, uri, () => sessions.replace(userId, uri, cleaned.text));
        if (!undoable) await this.overlay.addRevision({ userId, uri, memoryType: type, change: "updated", actor: "platform", reason: reasons.join(","), before: current, after: cleaned.text, projectId });
        body = cleaned.text;
      } else {
        await withMemorySummaryInvalidation(sessions, this.overlay, userId, uri, () => sessions.remove(userId, uri));
        if (!undoable) {
          await this.overlay.addRevision({ userId, uri, memoryType: type, change: "deleted", actor: "platform", reason: reasons.join(","), before: current, after: null, projectId });
          if (reasons.some(reason => reason === "identifier_shape" || reason === "platform_text")) await this.overlay.forgetText(userId, uri);
        }
        await this.overlay.removeFile(userId, uri);
        return null;
      }
    }
    if (filenameVariants.some(text => matches.has(lineFingerprint(text)))) {
      if (!cleaned.hasStatements) {
        await withMemorySummaryInvalidation(sessions, this.overlay, userId, uri, () => sessions.remove(userId, uri));
        await this.overlay.addRevision({ userId, uri, memoryType: type, change: 'deleted', actor: 'platform', reason: 'rejected_filename', before: current, after: null, projectId });
        await this.overlay.removeFile(userId, uri);
        return null;
      }
      const neutral = await neutralMemoryUri({ userId, projectId, overlay: this.overlay, uri,
        namespaceId: memoryContext.kind === 'geo-project' ? memoryContext.namespaceId : null, judge: this.rejectionJudge });
      await withMemorySummaryInvalidation(sessions, this.overlay, userId, neutral, () => sessions.replace(userId, neutral, body));
      await this.overlay.addRevision({ userId, uri: neutral, memoryType: type, change: 'added', actor: 'platform', reason: 'rejected_filename', before: null, after: body, projectId });
      await this.overlay.upsertFile({ userId, uri: neutral, memoryType: type, body, projectId });
      const inheritedOrigins = new Map(memoryLines(body).map(line => [lineFingerprint(line), [
        ...originalSources(origins.get(lineFingerprint(line))), ...extraOrigins, ...(archiveUri ? [{ archiveUri, projectId }] : []),
      ]]));
      await this.overlay.inheritOrigins(userId, neutral, inheritedOrigins);
      await this.overlay.syncOrigins(userId, neutral, { after: body, origin: { archiveUri, projectId } });
      await this.overlay.setSources(userId, neutral, sourcesNamedIn(body));
      if (projectId) await sessions.setTags(userId, neutral, [`project=${projectId}`]);
      await withMemorySummaryInvalidation(sessions, this.overlay, userId, uri, () => sessions.remove(userId, uri));
      await this.overlay.addRevision({ userId, uri, memoryType: type, change: 'deleted', actor: 'platform', reason: 'rejected_filename', before: current, after: null, projectId });
      await this.overlay.removeFile(userId, uri);
      return null;
    }
    if (projectId) {
      const held = await this.overlay.file(userId, uri);
      if (held?.projectId !== projectId || fresh) {
        await sessions.setTags(userId, uri, [`project=${projectId}`]).then(() => recordNativeWrite("project_tag")).catch(() => {});
      }
    }
    await this.overlay.upsertFile({ userId, uri, memoryType: type, body, ...(projectId ? { projectId } : {}) });
    await this.overlay.setSources(userId, uri, sourcesNamedIn(body));
    // A source already known to have changed: its label goes back into the file the engine just rewrote.
    for (const source of await this.overlay.sources(userId, [uri])) {
      if (source.state in LABEL_WORDS) await this.#writeLabel(userId, uri, type, source, source.state, memoryContext);
    }
    return body;
  }

  /** A wholly refused observation is not evidence that the person chose it; preserve its bytes, undo only its contribution.
   * @param {string} userId @param {string} uri @param {string|null} archiveUri
   */
  async #retireObservationEvidence(userId, uri, archiveUri) {
    if (!archiveUri) return;
    for (const revision of await this.overlay.admissionRevisions(userId, archiveUri)) {
      if (revision.uri === uri && revision.actor === "engine" && !revision.undoneAt) await this.overlay.markUndone(userId, revision.id);
    }
  }

  /** Only new personal lines, checked once against the complete captured conversation, never by paste markers.
   * @param {any} commit @param {any} operations @param {any} context @returns {Promise<Set<string>>}
   */
  async #pastedInstructions(commit, operations, context) {
    const refused = new Set();
    if (this.config.memoryPastedInstructionCheckEnabled !== true || !this.pastedInstructionJudge || !commit.archiveUri) return refused;
    const root = context.sessions.memoryRoot(commit.userId);
    /** @type {{key:string,text:string}[]} */
    const candidates = [];
    for (const list of ["adds", "updates"]) for (const operation of Array.isArray(operations?.[list]) ? operations[list] : []) {
      const file = nativeMemoryFile(String(operation?.uri ?? ""), root) ?? observationFile(String(operation?.uri ?? ""), root);
      if (!file || !["preferences", "corrections", "profile", "observations"].includes(file.type)) continue;
      const before = String(operation?.before ?? "");
      const prior = new Set(memoryLines(before).map(lineFingerprint));
      const settled = before ? (await this.overlay.file(commit.userId, String(operation.uri)))?.body ?? "" : "";
      const settledPrints = new Set(memoryLines(settled).map(lineFingerprint));
      for (const text of memoryLines(String(operation?.after ?? ""))) {
        const print = lineFingerprint(text);
        const key = `${operation.uri}\u0000${print}`;
        if ((!prior.has(print) || !settledPrints.has(print)) && lineRefusal(text, new Set()) === null && !candidates.some(row => row.key === key)) candidates.push({ key, text });
      }
    }
    if (!candidates.length) return refused;
    const raw = await context.sessions.read(commit.userId, `${commit.archiveUri}/messages.jsonl`);
    if (!raw || raw.length > 1_048_576) { recordPastedInstructionCheck("unavailable"); return refused; }
    const conversation = [];
    for (const line of raw.split("\n").filter(entry => entry.trim())) {
      let message;
      try { message = JSON.parse(line); } catch { recordPastedInstructionCheck("failed"); return refused; }
      const captured = filterCapturedMessage(message);
      if ("forward" in captured) conversation.push({ role: captured.forward.role, text: captured.forward.parts.map(part => part.text).join("\n") });
    }
    const judged = await this.pastedInstructionJudge.check({ userId: commit.userId, projectId: commit.projectId ?? null, candidates, conversation });
    for (const index of judged) if (candidates[index]) refused.add(candidates[index].key);
    return refused;
  }

  /**
   * A source changed state (retracted, corrected, removed from the knowledge base) or came back to current: every native
   * memory of the account that names it gains or loses the label line. A label, never a verdict: nothing is hidden or
   * deleted for it.
   * @param {string} userId @param {{ type: string, id: string }} source @param {string} state
   * @returns {Promise<number>} files labelled or unlabelled
   */
  async labelSource(userId,source,state) { return withNativeMemoryWrite(this.overlay.database,userId,()=>this.#labelSourceOwned(userId,source,state)); }
  async #labelSourceOwned(userId, source, state) {
    if (!this.applicable) return 0;
    let touched = 0;
    for (const link of await this.overlay.filesNaming(source, { userId })) {
      // A check moves a link only where it adds knowledge (`linkStatesLeftFor`, the rule the retired records engine kept): a correction
      // never lowers a retraction, a check that could not answer never undoes a finding, and a clean answer is only what a link nobody
      // had answered for becomes (or a document that is back in the library, `removed`): it never lifts a retraction, a correction
      // or an expiry. A link already in this state is read again, so that a label an interrupted pass missed is repaired.
      if (link.state !== state && !linkStatesLeftFor(state).includes(link.state)) continue;
      const held = await this.overlay.file(userId, link.uri);
      if (await this.#writeLabel(userId, link.uri, held?.memoryType ?? "project_facts", source, state)) touched += 1;
      // Do not mark a failed label write as delivered. Re-reading an already
      // marked link also repairs labels missed by earlier interrupted passes.
      if (link.state !== state) await this.overlay.markSource(userId, link.uri, source, state);
    }
    return touched;
  }

  /** @param {string} userId @param {string} uri @param {string} type @param {{ type: string, id: string }} source @param {string} state @param {any} [context] */
  async #writeLabel(userId, uri, type, source, state, context = null) {
    context ??= await this.#contextForUri(userId, uri);
    if (this.memoryContexts) await this.memoryContexts.assertKnown(context);
    const sessions = context.sessions, file = nativeMemoryFile(uri, sessions.memoryRoot(userId));
    if (!file || context.kind === 'geo-project' && !sessions.memoryTypes.includes(file.type)) throw new HttpError(403, 'memory_scope_denied', 'The source label is outside the approved memory files.');
    type = file.type;
    const held = await this.overlay.file(userId, uri);
    const projectId = context.kind === 'geo-project' ? context.projectId : held?.projectId ?? null;
    const current = await sessions.read(userId, uri);
    if (current === null) return false;
    const words = /** @type {Record<string, string>} */ (LABEL_WORDS)[state];
    let retained = false;
    const lines = current.split("\n").filter((line) => {
      // Compare the entire source identity and state suffix, never a DOI substring.
      const label = line.trim();
      const ownState = Object.values(LABEL_WORDS).find(value => {
        const prefix = `${SOURCE_LABEL_PREFIX}${source.id} ${value}（`;
        return label.startsWith(prefix) && /^\d{4}-\d{2}-\d{2}）$/.test(label.slice(prefix.length));
      });
      if (!ownState) return true;
      if (ownState === words && !retained) { retained = true; return true; }
      return false;
    });
    if (words && !retained) lines.push(`${SOURCE_LABEL_PREFIX}${source.id} ${words}（${this.now().toISOString().slice(0, 10)}）`);
    const next = lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
    const changed = contentHash(next) !== contentHash(current);
    if (changed) await withMemorySummaryInvalidation(sessions, this.overlay, userId, uri, () => sessions.replace(userId, uri, next));
    // A retry may find the engine write already complete while the overlay still
    // owes its revision, body or labels. Finish each step before marking the link.
    const before = changed ? current : held?.body;
    const reason = words ? `source ${state}` : "source current again";
    if (before != null && before !== next) {
      const latest = (await this.overlay.revisionsOf(userId, uri, { limit: 1 }))[0];
      if (latest?.actor !== "platform" || latest.reason !== reason || latest.before !== before || latest.after !== next) {
        await this.overlay.addRevision({ userId, uri, memoryType: type, change: "updated", actor: "platform", reason, before, after: next, projectId });
      }
    }
    if (!held || held.body !== next || held.contentHash !== contentHash(next) || held.memoryType !== type || held.projectId !== projectId) {
      await this.overlay.upsertFile({ userId, uri, memoryType: type, body: next, projectId });
    }
    const labels = next.split("\n").filter(isLabelLine).map((line) => line.slice(SOURCE_LABEL_PREFIX.length));
    if (!held || JSON.stringify(held.labels) !== JSON.stringify(labels.slice(0, 16))) await this.overlay.setLabels(userId, uri, labels);
    if (changed) recordNativeWrite(words ? "source_label_added" : "source_label_removed");
    return changed;
  }
}
