import { createHash } from "node:crypto";
import { carriesPlatformContext, identifierShapesIn, platformIdentifiersIn } from "@evimed/domain";
import { filterCapturedMessage } from "./memoryGateway.mjs";
import { contentHash, lineFingerprint, memoryLines, nativeMemoryRejectionType } from "./nativeMemoryOverlay.mjs";
import { HttpError } from './security.mjs';
import {
  recordNativeCheck, recordNativeCommit, recordNativeOperations, recordNativePass, recordNativeWrite,
} from "./nativeMemoryMetrics.mjs";
import { SOURCE_LABEL_PREFIX, sourcesNamedIn } from "./nativeMemoryStore.mjs";
import { PROJECT_MEMORY_TYPES, nativeMemoryFile, parseArchiveUri } from "./openVikingSessions.mjs";

/**
 * The overlay's worker: what the native memory engine did, read into the overlay, and what it cannot do for itself, done.
 *
 * Each pass, for every account on the native engine:
 *  1. **Registration.** An account the engine's admin routes do not know cannot have its settings changed or be deleted;
 *     the gateway registers on first sight, this catches what it could not.
 *  2. **The commit ledger.** The gateway writes a row for every commit it forwarded; the engine's own idle commits never
 *     pass it, so registered namespace archives are scanned and an archive the ledger lacks is entered. At most eight
 *     namespaces per account are scanned per pass, rotating fairly; already recorded commits are processed independently.
 *  3. **Ingestion.** A finished commit's `memory_diff.json` becomes revisions (before / after: the timeline, 「刚记住了」, the
 *     undo), the files' project tags (a pack restore loses tags, so the overlay keeps them too), and the sources a memory names.
 *  4. **The deterministic checks after the fact.** A line the engine wrote that carries an identifier's shape (a phone, an ID
 *     or card number, an e-mail, a key), platform-injected text or a platform identifier, or that the person removed before
 *     and the engine wrote back verbatim (unless the person said it again themselves, word for word, in that conversation: their
 *     words win over their deletion), is taken out again — the file restored or deleted when nothing else is left — and
 *     the revision says why. The templates are the first line (the "never keep" block); this is the code that holds the
 *     closed half of it, seconds after the write rather than before (README §5.3 of the course correction).
 *  5. **Replay.** A failed extraction is never retried upstream: its archive keeps the messages and a `.failed.json`. The
 *     messages are committed again as a new session, with a cap and a back-off, so one rate-limited minute does not lose a
 *     conversation for good.
 *  6. **Runtimes.** An idle runtime launched for the engine its account is no longer on is let go, so the next one is right.
 *
 * Source labels (`labelSource`) are written here too, on the call of whoever learns that a source changed.
 *
 * @module nativeMemoryWorker
 */

/** How long a commit may stay without a diff, a failure marker or a task before it is treated as failed and replayed. */
const LOST_AFTER_MS = 30 * 60_000;
/** The back-off between replays: one minute, doubled each time, an hour at most. */
const replayDelay = (/** @type {number} */ attempts) => Math.min(3_600_000, 60_000 * 2 ** Math.max(0, attempts));

/** What a label line says about a source's state, in the person's language. */
const LABEL_WORDS = Object.freeze({ retracted: "已撤稿", changed: "已更正", removed: "已从资料库删除", expired: "已过期" });

const isLabelLine = (/** @type {string} */ line) => line.trim().startsWith(SOURCE_LABEL_PREFIX.trim());
const statementOf = (/** @type {string} */ line) => line.trim().replace(/^(?:[-*+]|\d+[.)])\s+/, "");

/**
 * Why one line may not stay, or null. Closed, decidable checks only (principle 5): an identifier's shape, a platform tag or
 * identifier, or a line the person removed.
 * @param {string} line @param {Set<string>} rejected fingerprints
 * @returns {"identifier_shape" | "platform_text" | "rejected_line" | null}
 */
export function lineRefusal(line, rejected) {
  const text = statementOf(line);
  if (!text || isLabelLine(line) || /^#{1,6}\s/.test(line.trim())) return null;
  if (identifierShapesIn(text).length) return "identifier_shape";
  if (carriesPlatformContext(text) || platformIdentifiersIn(text).length) return "platform_text";
  if (rejected.has(lineFingerprint(text))) return "rejected_line";
  return null;
}

/** A body without the lines `refused` names, and whether a statement is left. @param {string} body @param {Set<string>} rejected */
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

export class NativeMemoryWorker {
  /**
   * @param {{ config: any, researchMemory: any, sessions: import("./openVikingSessions.mjs").OpenVikingSessions,
   *   overlay: import("./nativeMemoryOverlay.mjs").NativeMemoryOverlay, runtimeManager?: any,
   *   projectOfSession?: ((userId: string, sessionId: string) => Promise<string | null>) | null,
   *   memoryContexts?: import('./geoNativeMemoryContext.mjs').GeoNativeMemoryContext | null,
   *   now?: () => Date, report?: (line: string) => void }} dependencies
   *   `projectOfSession` names the project a platform conversation belongs to, for a commit the gateway never saw.
   */
  constructor({ config, researchMemory, sessions, overlay, runtimeManager = null, projectOfSession = null, memoryContexts = null, now = () => new Date(), report = () => {} }) {
    this.config = config ?? {};
    this.researchMemory = researchMemory;
    this.sessions = sessions;
    this.overlay = overlay;
    this.runtimeManager = runtimeManager;
    this.projectOfSession = projectOfSession;
    this.memoryContexts = memoryContexts;
    /** Namespace scans rotate independently of pending commits. @type {Map<string, string>} */
    this.scanCursors = new Map();
    this.now = now;
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
    return this.config.ovNativeMemoryEnabled === true && Boolean(this.sessions?.configured && this.overlay?.configured && this.researchMemory?.configured);
  }

  /** What readiness reports: whether the worker applies here, whether it is running, and what its last pass did. */
  status() {
    return { applicable: this.applicable, running: Boolean(this.timer), last: { ...this.last } };
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
      const native = await this.researchMemory.accountsOnEngine("native");
      for (const { userId } of native) {
        accounts += 1;
        try {
          await this.#register(userId);
          await this.scanArchives(userId);
        } catch (error) {
          this.report(`native memory worker: ${userId.slice(0, 8)}… ${String(/** @type {any} */ (error)?.code ?? /** @type {any} */ (error)?.message ?? error).slice(0, 120)}`);
        }
        // An unavailable namespace scan cannot strand other already-recorded
        // commits for the same account.
        commits += await this.processCommits({ userId });
      }
      await this.runtimeManager?.releaseMemoryEngineRuntimes?.().catch(() => []);
      this.last = { at: this.now().toISOString(), ok: true, accounts, commits, error: null };
      recordNativePass(true);
    } catch (error) {
      this.last = { at: this.now().toISOString(), ok: false, accounts, commits, error: String(/** @type {any} */ (error)?.code ?? "native_memory_pass_failed") };
      recordNativePass(false);
    }
    return this.last;
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
      const recorded = await this.overlay.recordCommit({ userId, archiveUri, engineSession: entry.session, projectId, origin: "scan",
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
    for (const commit of await this.overlay.openCommits({ userId, limit, now: this.now() })) {
      try {
        if (commit.state === "pending") settled += await this.#settle(commit) ? 1 : 0;
        else if (commit.state === "failed") settled += await this.#replay(commit) ? 1 : 0;
      } catch (error) {
        this.report(`native memory commit: ${String(/** @type {any} */ (error)?.code ?? /** @type {any} */ (error)?.message ?? error).slice(0, 120)}`);
      }
    }
    return settled;
  }

  /** A pending commit: its diff ingested, its failure noted, or left to finish. @param {any} commit */
  async #settle(commit) {
    const resolved = await this.#commitContext(commit);
    commit = resolved.commit;
    const context = resolved.context, sessions = context.sessions;
    const diffText = await sessions.read(commit.userId, `${commit.archiveUri}/memory_diff.json`);
    if (diffText !== null) {
      let diff;
      try { diff = JSON.parse(diffText); } catch { diff = null; }
      if (diff && typeof diff === "object") {
        const operations = await this.ingest(commit, diff, { context });
        await this.overlay.completeCommit(commit.userId, commit.archiveUri, { operations });
        recordNativeCommit(operations ? "ingested" : "empty");
        return true;
      }
    }
    const failed = await sessions.read(commit.userId, `${commit.archiveUri}/.failed.json`);
    let reason = failed !== null ? "the extraction failed" : "";
    if (!reason && commit.taskId) {
      const task = await sessions.task(commit.userId, commit.taskId);
      if (task?.status === "failed") reason = String(task.error ?? "the extraction failed").slice(0, 300);
      else if (task?.status === "running" || task?.status === "pending") return false;
    }
    if (!reason && Date.now() - Date.parse(String(commit.createdAt)) > LOST_AFTER_MS) reason = "no diff, no failure and no task after thirty minutes";
    if (!reason) return false;
    await this.overlay.failCommit(commit.userId, commit.archiveUri, { error: reason, nextAttemptAt: this.now() });
    recordNativeCommit("failed");
    return false;
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
    if (await this.researchMemory.memoryEngine(userId) !== "native") {
      await this.overlay.abandonCommit(userId, commit.archiveUri, "the account is no longer on the native engine");
      recordNativeCommit("abandoned");
      return true;
    }
    const settings = await this.researchMemory.settings(userId);
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
      if (context.kind === 'geo-project') {
        await this.memoryContexts.configure(context);
        await this.memoryContexts.noteInternal(context, session, { kind: 'replay', sourceArchiveUri: commit.archiveUri });
      }
      await sessions.createSession(userId, session, { timeoutMs: sessions.timeoutMs });
      const state = await sessions.readSession(userId, session).catch(() => null);
      // A replay session that already holds the messages (an earlier attempt that failed after writing them) is committed as it is.
      if (!(Number(state?.result?.message_count) > 0)) for (const message of messages) await sessions.addMessage(userId, session, message);
      const answer = await sessions.commit(userId, session);
      const result = answer?.result ?? {};
      if (result.status !== "accepted" || typeof result.archive_uri !== "string") throw Object.assign(new Error("the replay commit was not accepted"), { code: "native_replay_not_accepted" });
      const archive = parseArchiveUri(result.archive_uri);
      if (!archive || archive.userRoot !== context.userRoot || archive.session !== session || archive.rest || archive.archiveUri !== result.archive_uri) {
        throw new HttpError(403, 'memory_scope_denied', 'The replay archive does not match its original namespace.');
      }
      await this.overlay.recordCommit({ userId, archiveUri: result.archive_uri, engineSession: session, projectId: commit.projectId, origin: "replay",
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

  /**
   * One commit's diff into the overlay, with the checks after the fact. Idempotent: a diff read twice writes each revision once.
   * @param {any} commit @param {any} diff @param {{context?:any}} [options] @returns {Promise<number>} operations read
   */
  async ingest(commit, diff, { context = null } = {}) {
    const resolved = await this.#commitContext(commit, context);
    commit = resolved.commit; context = resolved.context;
    const userId = commit.userId;
    const root = context.sessions.memoryRoot(userId);
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
    const counts = { added: 0, updated: 0, deleted: 0 };
    const changedAt = typeof diff?.extracted_at === "string" && Number.isFinite(Date.parse(diff.extracted_at)) ? new Date(diff.extracted_at).toISOString() : null;
    const base = { userId, archiveUri: commit.archiveUri, engineSession: commit.engineSession, changedAt };
    for (const [list, change] of /** @type {const} */ ([["adds", "added"], ["updates", "updated"], ["deletes", "deleted"]])) {
      for (const operation of Array.isArray(operations[list]) ? operations[list] : []) {
        const uri = String(operation?.uri ?? "");
        const file = nativeMemoryFile(uri, root);
        if (!file) continue;
        counts[change] += 1;
        const projectId = context.kind === 'geo-project' ? context.projectId : PROJECT_MEMORY_TYPES.includes(file.type) ? commit.projectId ?? null : null;
        if (change === "deleted") {
          await this.overlay.addRevision({ ...base, uri, memoryType: file.type, change, actor: "engine", reason: "", before: operation?.deleted_content ?? operation?.before ?? null, after: null, projectId });
          await this.overlay.removeFile(userId, uri);
          continue;
        }
        const after = String(operation?.after ?? "");
        const recorded = await this.overlay.addRevision({ ...base, uri, memoryType: file.type, change, actor: "engine", reason: "",
          before: change === "updated" ? String(operation?.before ?? "") : null, after, projectId });
        await this.#afterWrite(userId, uri, file.type, { projectId, diffAfter: after, fresh: recorded !== null, archiveUri: commit.archiveUri, memoryContext: context });
      }
    }
    recordNativeOperations(counts);
    return counts.added + counts.updated + counts.deleted;
  }

  /**
   * What follows an engine write of one file: the checks, the project tag, the sources and their labels, the overlay's copy.
   * Acts on the file as it is now, not as the diff says: a later commit may already have changed it.
   * @param {string} userId @param {string} uri @param {string} type @param {{ projectId: string | null, diffAfter: string, fresh: boolean, archiveUri: string, memoryContext:any }} context
   */
  async #afterWrite(userId, uri, type, { projectId, diffAfter, fresh, archiveUri, memoryContext }) {
    const sessions = memoryContext.sessions;
    const current = await sessions.read(userId, uri);
    if (current === null) return;
    const rejectionType = nativeMemoryRejectionType(type, memoryContext.kind === 'geo-project' ? memoryContext.namespaceId : null);
    const rejected = await this.overlay.rejectedFingerprints(userId, rejectionType);
    // Only what this write brought is held to the checks.
    const broughtLines = memoryLines(diffAfter);
    const brought = new Set(broughtLines.map(lineFingerprint));
    const relevant = new Set([...rejected].filter((print) => brought.has(print)));
    // The person's own words win over their earlier deletion: a line they said again in this very conversation, word for word,
    // is theirs, and is taken off the rejection list. Exact containment of the line in one of their messages and nothing looser
    // — whether a reworded line means the same is language, and the engine's own extraction already decided that.
    const stated = relevant.size ? await this.#statedByThePerson(userId, archiveUri, broughtLines.filter((line) => relevant.has(lineFingerprint(line))), memoryContext) : [];
    if (stated.length) {
      for (const line of stated) relevant.delete(lineFingerprint(line));
      await this.overlay.unreject(userId, rejectionType, stated);
    }
    const cleaned = cleanBody(current, relevant);
    const reasons = [...new Set(cleaned.reasons)];
    let body = current;
    if (reasons.length) {
      for (const reason of cleaned.reasons) recordNativeCheck(reason);
      if (cleaned.hasStatements) {
        await sessions.replace(userId, uri, cleaned.text);
        await this.overlay.addRevision({ userId, uri, memoryType: type, change: "updated", actor: "platform", reason: reasons.join(","), before: current, after: cleaned.text, projectId });
        body = cleaned.text;
      } else {
        await sessions.remove(userId, uri);
        await this.overlay.addRevision({ userId, uri, memoryType: type, change: "deleted", actor: "platform", reason: reasons.join(","), before: null, after: null, projectId });
        await this.overlay.forgetText(userId, uri);
        await this.overlay.removeFile(userId, uri);
        return;
      }
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
  }

  /**
   * Which of these lines one of the person's own messages of an archive carries word for word.
   * @param {string} userId @param {string} archiveUri @param {readonly string[]} lines @param {any} context @returns {Promise<string[]>}
   */
  async #statedByThePerson(userId, archiveUri, lines, context) {
    const raw = await context.sessions.read(userId, `${archiveUri}/messages.jsonl`);
    if (!raw) return [];
    const flat = (/** @type {string} */ text) => text.replace(/\s*[(（]as of \d{4}-\d{2}-\d{2}[)）]\s*$/i, "").replace(/\s+/g, " ").trim().toLowerCase();
    const said = [];
    for (const line of raw.split("\n")) {
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message?.role !== "user") continue;
      const text = typeof message.content === "string" ? message.content
        : Array.isArray(message.parts) ? message.parts.filter((/** @type {any} */ part) => part?.type === "text").map((/** @type {any} */ part) => String(part.text ?? "")).join("\n") : "";
      said.push(flat(text));
    }
    return lines.filter((line) => { const own = flat(line); return own.length >= 4 && said.some((text) => text.includes(own)); });
  }

  /**
   * A source changed state (retracted, corrected, removed from the knowledge base) or came back to current: every native
   * memory of the account that names it gains or loses the label line. A label, never a verdict: nothing is hidden or
   * deleted for it.
   * @param {string} userId @param {{ type: string, id: string }} source @param {string} state
   * @returns {Promise<number>} files labelled or unlabelled
   */
  async labelSource(userId, source, state) {
    if (!this.applicable || await this.researchMemory.memoryEngine(userId) !== "native") return 0;
    let touched = 0;
    for (const link of await this.overlay.filesNaming(source, { userId })) {
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
    if (changed) await sessions.replace(userId, uri, next);
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
