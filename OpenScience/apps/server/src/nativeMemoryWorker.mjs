import { createHash } from "node:crypto";
import { carriesPlatformContext, identifierShapesIn, platformIdentifiersIn } from "@evimed/domain";
import { filterCapturedMessage } from "./memoryGateway.mjs";
import { contentHash, lineFingerprint, memoryLines } from "./nativeMemoryOverlay.mjs";
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
 *     pass it, so the account's session archives are scanned and an archive the ledger lacks is entered.
 *  3. **Ingestion.** A finished commit's `memory_diff.json` becomes revisions (before / after: the timeline, 「刚记住了」, the
 *     undo), the files' project tags (a pack restore loses tags, so the overlay keeps them too), and the sources a memory names.
 *  4. **The deterministic checks after the fact.** A line the engine wrote that carries an identifier's shape (a phone, an ID
 *     or card number, an e-mail, a key), platform-injected text or a platform identifier, or that the person removed before
 *     and the engine wrote back verbatim, is taken out again — the file restored or deleted when nothing else is left — and
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
   *   now?: () => Date, report?: (line: string) => void }} dependencies
   *   `projectOfSession` names the project a platform conversation belongs to, for a commit the gateway never saw.
   */
  constructor({ config, researchMemory, sessions, overlay, runtimeManager = null, projectOfSession = null, now = () => new Date(), report = () => {} }) {
    this.config = config ?? {};
    this.researchMemory = researchMemory;
    this.sessions = sessions;
    this.overlay = overlay;
    this.runtimeManager = runtimeManager;
    this.projectOfSession = projectOfSession;
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
          commits += await this.processCommits({ userId });
        } catch (error) {
          this.report(`native memory worker: ${userId.slice(0, 8)}… ${String(/** @type {any} */ (error)?.code ?? /** @type {any} */ (error)?.message ?? error).slice(0, 120)}`);
        }
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

  /**
   * Enter in the ledger every archive of the account it does not hold: the engine's idle commits, and any commit whose ledger
   * row the gateway could not write.
   * @param {string} userId @returns {Promise<number>} archives entered
   */
  async scanArchives(userId) {
    const root = `${this.sessions.userRoot(userId)}/sessions`;
    const nodes = await this.sessions.tree(userId, root, { levelLimit: 4, showHidden: true });
    const known = await this.overlay.knownArchives(userId);
    /** @type {Map<string, { session: string, failed: boolean, finished: boolean }>} */
    const archives = new Map();
    for (const node of nodes) {
      const parsed = parseArchiveUri(node.uri);
      if (!parsed) continue;
      const entry = archives.get(parsed.archiveUri) ?? { session: parsed.session, failed: false, finished: false };
      if (parsed.rest === ".failed.json") entry.failed = true;
      if (parsed.rest === "memory_diff.json" || parsed.rest === ".done") entry.finished = true;
      archives.set(parsed.archiveUri, entry);
    }
    let entered = 0;
    for (const [archiveUri, entry] of archives) {
      if (known.has(archiveUri)) continue;
      const projectId = await this.#projectOf(userId, entry.session);
      const recorded = await this.overlay.recordCommit({ userId, archiveUri, engineSession: entry.session, projectId, origin: "scan",
        state: entry.failed && !entry.finished ? "failed" : "pending", error: entry.failed ? "found failed by the archive scan" : "" });
      if (recorded.inserted) { entered += 1; recordNativeCommit("found_by_scan"); }
    }
    await this.overlay.noteScanned(userId);
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
    for (const commit of await this.overlay.openCommits({ userId, limit })) {
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
    const diffText = await this.sessions.read(commit.userId, `${commit.archiveUri}/memory_diff.json`);
    if (diffText !== null) {
      let diff;
      try { diff = JSON.parse(diffText); } catch { diff = null; }
      if (diff && typeof diff === "object") {
        const operations = await this.ingest(commit, diff);
        await this.overlay.completeCommit(commit.userId, commit.archiveUri, { operations });
        recordNativeCommit(operations ? "ingested" : "empty");
        return true;
      }
    }
    const failed = await this.sessions.read(commit.userId, `${commit.archiveUri}/.failed.json`);
    let reason = failed !== null ? "the extraction failed" : "";
    if (!reason && commit.taskId) {
      const task = await this.sessions.task(commit.userId, commit.taskId);
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
    const raw = await this.sessions.read(userId, `${commit.archiveUri}/messages.jsonl`);
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
      await this.sessions.createSession(userId, session, { timeoutMs: this.sessions.timeoutMs });
      const state = await this.sessions.readSession(userId, session).catch(() => null);
      // A replay session that already holds the messages (an earlier attempt that failed after writing them) is committed as it is.
      if (!(Number(state?.result?.message_count) > 0)) for (const message of messages) await this.sessions.addMessage(userId, session, message);
      const answer = await this.sessions.commit(userId, session);
      const result = answer?.result ?? {};
      if (result.status !== "accepted" || typeof result.archive_uri !== "string") throw Object.assign(new Error("the replay commit was not accepted"), { code: "native_replay_not_accepted" });
      await this.overlay.recordCommit({ userId, archiveUri: result.archive_uri, engineSession: session, projectId: commit.projectId, origin: "replay",
        taskId: typeof result.task_id === "string" ? result.task_id : null, pendingText: commit.pendingText });
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
   * @param {any} commit @param {any} diff @returns {Promise<number>} operations read
   */
  async ingest(commit, diff) {
    const userId = commit.userId;
    const root = this.sessions.memoryRoot(userId);
    const operations = diff?.operations ?? {};
    const counts = { added: 0, updated: 0, deleted: 0 };
    const changedAt = typeof diff?.extracted_at === "string" && Number.isFinite(Date.parse(diff.extracted_at)) ? new Date(diff.extracted_at).toISOString() : null;
    const base = { userId, archiveUri: commit.archiveUri, engineSession: commit.engineSession, changedAt };
    for (const [list, change] of /** @type {const} */ ([["adds", "added"], ["updates", "updated"], ["deletes", "deleted"]])) {
      for (const operation of Array.isArray(operations[list]) ? operations[list] : []) {
        const uri = String(operation?.uri ?? "");
        const file = nativeMemoryFile(uri, root);
        if (!file) continue;
        counts[change] += 1;
        const projectId = PROJECT_MEMORY_TYPES.includes(file.type) ? commit.projectId ?? null : null;
        if (change === "deleted") {
          await this.overlay.addRevision({ ...base, uri, memoryType: file.type, change, actor: "engine", reason: "", before: operation?.deleted_content ?? operation?.before ?? null, after: null, projectId });
          await this.overlay.removeFile(userId, uri);
          continue;
        }
        const after = String(operation?.after ?? "");
        const recorded = await this.overlay.addRevision({ ...base, uri, memoryType: file.type, change, actor: "engine", reason: "",
          before: change === "updated" ? String(operation?.before ?? "") : null, after, projectId });
        await this.#afterWrite(userId, uri, file.type, { projectId, diffAfter: after, fresh: recorded !== null });
      }
    }
    recordNativeOperations(counts);
    return counts.added + counts.updated + counts.deleted;
  }

  /**
   * What follows an engine write of one file: the checks, the project tag, the sources and their labels, the overlay's copy.
   * Acts on the file as it is now, not as the diff says: a later commit may already have changed it.
   * @param {string} userId @param {string} uri @param {string} type @param {{ projectId: string | null, diffAfter: string, fresh: boolean }} context
   */
  async #afterWrite(userId, uri, type, { projectId, diffAfter, fresh }) {
    const current = await this.sessions.read(userId, uri);
    if (current === null) return;
    const rejected = await this.overlay.rejectedFingerprints(userId, type);
    // Only what this write brought is held to the checks: a line the person wrote themselves is theirs (and is unrejected).
    const brought = new Set(memoryLines(diffAfter).map(lineFingerprint));
    const relevant = new Set([...rejected].filter((print) => brought.has(print)));
    const cleaned = cleanBody(current, relevant);
    const reasons = [...new Set(cleaned.reasons)];
    let body = current;
    if (reasons.length) {
      for (const reason of cleaned.reasons) recordNativeCheck(reason);
      if (cleaned.hasStatements) {
        await this.sessions.replace(userId, uri, cleaned.text);
        await this.overlay.addRevision({ userId, uri, memoryType: type, change: "updated", actor: "platform", reason: reasons.join(","), before: current, after: cleaned.text, projectId });
        body = cleaned.text;
      } else {
        await this.sessions.remove(userId, uri);
        await this.overlay.addRevision({ userId, uri, memoryType: type, change: "deleted", actor: "platform", reason: reasons.join(","), before: null, after: null, projectId });
        await this.overlay.forgetText(userId, uri);
        await this.overlay.removeFile(userId, uri);
        return;
      }
    }
    if (projectId) {
      const held = await this.overlay.file(userId, uri);
      if (held?.projectId !== projectId || fresh) {
        await this.sessions.setTags(userId, uri, [`project=${projectId}`]).then(() => recordNativeWrite("project_tag")).catch(() => {});
      }
    }
    await this.overlay.upsertFile({ userId, uri, memoryType: type, body, ...(projectId ? { projectId } : {}) });
    await this.overlay.setSources(userId, uri, sourcesNamedIn(body));
    // A source already known to have changed: its label goes back into the file the engine just rewrote.
    for (const source of await this.overlay.sources(userId, [uri])) {
      if (source.state in LABEL_WORDS) await this.#writeLabel(userId, uri, type, source, source.state);
    }
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
      if (link.state === state) continue;
      await this.overlay.markSource(userId, link.uri, source, state);
      const held = await this.overlay.file(userId, link.uri);
      if (await this.#writeLabel(userId, link.uri, held?.memoryType ?? "project_facts", source, state)) touched += 1;
    }
    return touched;
  }

  /** @param {string} userId @param {string} uri @param {string} type @param {{ type: string, id: string }} source @param {string} state */
  async #writeLabel(userId, uri, type, source, state) {
    const current = await this.sessions.read(userId, uri);
    if (current === null) return false;
    const lines = current.split("\n").filter((line) => !(isLabelLine(line) && line.includes(source.id)));
    const words = /** @type {Record<string, string>} */ (LABEL_WORDS)[state];
    if (words) lines.push(`${SOURCE_LABEL_PREFIX}${source.id} ${words}（${this.now().toISOString().slice(0, 10)}）`);
    const next = lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
    if (contentHash(next) === contentHash(current)) return false;
    await this.sessions.replace(userId, uri, next);
    await this.overlay.addRevision({ userId, uri, memoryType: type, change: "updated", actor: "platform", reason: words ? `source ${state}` : "source current again", before: current, after: next });
    await this.overlay.upsertFile({ userId, uri, memoryType: type, body: next });
    const labels = next.split("\n").filter(isLabelLine).map((line) => line.slice(SOURCE_LABEL_PREFIX.length));
    await this.overlay.setLabels(userId, uri, labels);
    recordNativeWrite(words ? "source_label_added" : "source_label_removed");
    return true;
  }
}
