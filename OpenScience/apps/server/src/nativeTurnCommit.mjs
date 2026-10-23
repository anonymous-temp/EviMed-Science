import { isInternalProjectOf } from "./internalProjects.mjs";
import { isPlatformStartedRun } from "./memoryAdmission.mjs";
import { recordRuntimeWithoutGateway, recordTurnCommit } from "./nativeMemoryMetrics.mjs";
import { endedBeforeReset } from "./researchMemory.mjs";
import { PLUGIN_SESSION_PREFIX } from "./openVikingSessions.mjs";

/**
 * Commits a native account's conversation to the memory engine a few seconds after each attended turn.
 *
 * Hidden knowledge: the unmodified memory plugin writes every message of a conversation into its engine session as it is
 * said, and asks the engine to extract memories from them — a commit — in exactly two cases: at the end of a turn when the
 * session holds `commitTokenThreshold` (20000, the upstream default; measured by the engine's own estimate, which counts
 * Chinese at about twice DeepSeek's) pending tokens, and when its session is disposed, which for a running runtime is the
 * kernel's shutdown or a release of the container. An ordinary conversation is a few hundred to a few thousand tokens and a
 * runtime lives for hours, so on production (2026-10-14, thirteen one-conversation cases) everything left to automatic
 * extraction was missing or late: a stated profession and city and three project facts did not appear in twenty minutes, a
 * coding preference after about ten, and `native_commits` held no row of a session at all. The engine's own idle commit
 * (`auto_commit_policy.idle_timeout_seconds: 900`, checked every 300 s) is the net under that, not the way a person's
 * statement is learned. Only what the model chose to `remember` was stored at once, and the tool's own description tells it
 * not to for ordinary statements.
 *
 * So the one place that knows a turn ended — the run ledger's `onRunFinished` — asks for the commit, and this module is
 * what makes that safe to do for every attended turn:
 *  - **After the plugin's writes.** Its writes are asynchronous. The commit waits for a quiet (`debounceMs`), then reads the
 *    engine's session until two reads agree and something is pending (`settleMs`, `attempts`); nothing pending after all of
 *    them is "nothing pending", counted and not an error. A person who writes again within the quiet re-arms the same
 *    timer: two quick turns are one commit. A turn that is already running again is left to its own end.
 *  - **Through the gateway's commit path** (`memoryGateway.mjs` `commitSession`), not around it: the same admission rule
 *    (a paused account or project, a trial, a conversation that read a patient record, the platform's own projects and a
 *    sub-agent are withheld), the same hourly bound, and the ledger row (`native_commits`, origin `gateway`) that the
 *    worker settles, replays and ingests.
 *  - **Never for a turn the platform started.** An automated run, a scheduled task (`autopilot:*`) and a LoopX continuation
 *    start no commit. The gateway lets a commit pass while such a turn is running — what the session holds is only the
 *    person's earlier words, since a platform-started turn's own messages are never forwarded — so a continuation that
 *    starts inside the quiet does not strand the attended turn before it.
 *  - **Bounded.** Commits in flight at once, conversations waiting for their quiet, and the reads are each a key in
 *    `config.mjs` with a counter (`open_science_native_memory_turn_commits_total`).
 *
 * A legacy account is untouched: the engine is asked once, when the turn ends, and nothing is armed. An engine that does
 * not answer is a counted `failed`, never a fake commit and never a reason for the conversation to wait: the messages stay
 * pending in the engine's session, and the next turn's commit, the plugin's disposal commit or the engine's idle commit
 * archives them. A restart of the control plane forgets what was armed, and the idle commit is the net for that too.
 *
 * Why not lower the plugin's `commitTokenThreshold` instead: it is a token count, so a one-line statement and its answer
 * (a hundred tokens) would still wait, and a second trigger would make two commit paths race for the same messages. This
 * is the one trigger; the plugin's threshold stays as the net for a single very long run.
 *
 * Cost: one extraction call per attended turn that left something pending (about 6.8 K input tokens, mostly the cached
 * system prompt, and 0.15 K output with thinking off: ¥0.003; with thinking on ¥0.013), under purpose `memory-extraction`,
 * booked to the platform's `evimed-openviking` project within `OPEN_SCIENCE_OPENVIKING_MODEL_DAILY_BUDGET_CNY`. A spent
 * budget fails the extraction, and the overlay's worker replays it (`nativeMemoryWorker.mjs`).
 *
 * @module nativeTurnCommit
 */

const CONVERSATION = /^[A-Za-z0-9_-]{1,160}$/;

/**
 * @typedef {{
 *   userId: string, project: any, engineSessionId: string, sessionId: string, timer: any, endedAt: string | null,
 * }} Armed
 */

export class NativeTurnCommit {
  /**
   * @param {{
   *   config: any,
   *   researchMemory: { configured?: boolean, memoryEngine: (userId: string) => Promise<string>, resetInstant?: (userId: string) => Promise<string | null> },
   *   sessions: { configured?: boolean, readSession: (userId: string, sessionId: string) => Promise<any> },
   *   admission: { admit: (caller: { user: any, project: any, engineSessionId?: string | null }) => Promise<import("./memoryAdmission.mjs").MemoryAdmission> },
   *   conversations: { runsOf: (project: any, sessionId: string) => Promise<any[]> },
   *   commit: import("./memoryGateway.mjs").MemoryGatewayCommitSession,
   *   setTimer?: (fn: () => void, ms: number) => any, clearTimer?: (timer: any) => void, wait?: (ms: number) => Promise<void>,
   *   runtimeWithoutGateway?: ((project: any) => boolean) | null,
   *   report?: (line: string) => void,
   * }} dependencies
   *   `setTimer`, `clearTimer` and `wait` are the clock, replaceable by a test. `runtimeWithoutGateway` says whether the
   *   project's live runtime was launched without the memory gateway's address, which only counts (D2 of the 2026-10-23 review:
   *   an account switched to the engine under an open runtime is learned from by nobody, and nothing said so).
   */
  constructor({ config, researchMemory, sessions, admission, conversations, commit, setTimer = null, clearTimer = null, wait = null, runtimeWithoutGateway = null, report = () => {} }) {
    this.config = config ?? {};
    this.researchMemory = researchMemory;
    this.sessions = sessions;
    this.admission = admission;
    this.conversations = conversations;
    this.commit = commit;
    this.runtimeWithoutGateway = runtimeWithoutGateway;
    this.setTimer = setTimer ?? ((fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer; });
    this.clearTimer = clearTimer ?? ((timer) => clearTimeout(timer));
    this.wait = wait ?? ((ms) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); }));
    this.report = report;
    this.debounceMs = Math.max(0, Number(this.config.nativeMemoryTurnCommitDebounceMs ?? 8_000));
    this.settleMs = Math.max(0, Number(this.config.nativeMemoryTurnCommitSettleMs ?? 2_000));
    this.attempts = Math.max(1, Math.trunc(Number(this.config.nativeMemoryTurnCommitAttempts ?? 4)));
    this.concurrency = Math.max(1, Math.trunc(Number(this.config.nativeMemoryTurnCommitConcurrency ?? 2)));
    this.maxScheduled = Math.max(1, Math.trunc(Number(this.config.nativeMemoryTurnCommitMaxScheduled ?? 1_000)));
    /** Conversations waiting for their quiet, by account and conversation. @type {Map<string, Armed>} */
    this.armed = new Map();
    /** Conversations whose quiet has passed and that wait for a free slot, oldest first. @type {Armed[]} */
    this.queue = [];
    this.inFlight = 0;
    /** The commits in progress, so a shutdown and a test can wait for them. @type {Set<Promise<void>>} */
    this.running = new Set();
    this.closed = false;
  }

  get applicable() {
    return this.config.ovNativeMemoryEnabled === true && this.config.nativeMemoryTurnCommitEnabled !== false && this.config.memoryEnabled !== false
      && Boolean(this.sessions?.configured && this.researchMemory?.configured);
  }

  /** Whether the engine session of a conversation is waiting for its quiet, for readiness and tests. @param {string} userId @param {string} sessionId */
  isArmed(userId, sessionId) { return this.armed.has(`${userId}\u0000${sessionId}`); }

  /**
   * A run reached a terminal state. Arms (or re-arms) the commit of its conversation when it was an attended turn of an
   * account on the native engine. Never throws and never waits for the commit.
   * @param {any} project @param {any} run
   * @returns {Promise<void>}
   */
  async noteRunFinished(project, run) {
    try {
      if (this.closed || !this.applicable || !project?.userId || !project?.id) return;
      const sessionId = String(run?.sessionId ?? "");
      if (!CONVERSATION.test(sessionId)) return;
      if (isInternalProjectOf(this.config, project.userId, project.id)) return;
      // A turn the platform started — an automated run, a scheduled task, a LoopX continuation — is not the person's.
      if (isPlatformStartedRun(run)) { recordTurnCommit("platform_started"); return; }
      // A legacy account is untouched; the answer is one settings read, cached by the store's row.
      if (await this.researchMemory.memoryEngine(String(project.userId)) !== "native") return;
      // The turn that just ended may have had no memory plugin at all: its runtime was launched before the account moved to
      // the engine. Counted here for the turns that pass through no dispatch (typed in the kernel's own frame); the next
      // dispatch replaces such a runtime.
      if (this.runtimeWithoutGateway?.(project) === true) recordRuntimeWithoutGateway("turn_end");
      this.#arm(project, sessionId, String(run?.finishedAt ?? run?.startedAt ?? "") || null);
    } catch (error) {
      this.report(`native turn commit: ${this.#codeOf(error)}`);
    }
  }

  /** @param {any} project @param {string} sessionId @param {string | null} endedAt when the turn that armed it ended */
  #arm(project, sessionId, endedAt) {
    const userId = String(project.userId);
    const key = `${userId}\u0000${sessionId}`;
    const held = this.armed.get(key);
    if (held) {
      // The person went on within the quiet: one commit for both turns.
      this.clearTimer(held.timer);
      this.armed.delete(key);
      recordTurnCommit("debounced");
    } else if (this.armed.size >= this.maxScheduled) {
      recordTurnCommit("dropped");
      return;
    }
    /** @type {Armed} */
    const entry = { userId, project, sessionId, engineSessionId: `${PLUGIN_SESSION_PREFIX}${sessionId}`, timer: null, endedAt };
    entry.timer = this.setTimer(() => { this.armed.delete(key); this.queue.push(entry); this.#pump(); }, this.debounceMs);
    this.armed.set(key, entry);
    recordTurnCommit("scheduled");
  }

  #pump() {
    while (!this.closed && this.inFlight < this.concurrency && this.queue.length) {
      const entry = /** @type {Armed} */ (this.queue.shift());
      this.inFlight += 1;
      const work = this.#run(entry)
        .catch((error) => { recordTurnCommit("failed"); this.report(`native turn commit: ${this.#codeOf(error)}`); })
        .finally(() => { this.inFlight -= 1; this.running.delete(work); this.#pump(); });
      this.running.add(work);
    }
  }

  /** @param {unknown} error */
  #codeOf(error) { return String(/** @type {any} */ (error)?.code ?? /** @type {any} */ (error)?.message ?? error).slice(0, 120); }

  /**
   * Whether a person's own turn is going on in this conversation: it commits at its own end, and what it has said so far
   * is not a finished exchange. A platform-started turn running does not hold the commit (see the header).
   * @param {Armed} entry
   */
  async #personIsTyping(entry) {
    const runs = await this.conversations.runsOf(entry.project, entry.sessionId).catch(() => []);
    const running = runs.find((run) => run?.status === "running");
    return Boolean(running) && !isPlatformStartedRun(running);
  }

  /** @param {Armed} entry */
  async #endedBeforeReset(entry) {
    if (typeof this.researchMemory.resetInstant !== "function") return false;
    const resetAt = await this.researchMemory.resetInstant(entry.userId).catch(() => null);
    return endedBeforeReset({ finishedAt: entry.endedAt }, resetAt);
  }

  /** @param {Armed} entry */
  async #run(entry) {
    if (this.closed) return;
    if (await this.#personIsTyping(entry)) { recordTurnCommit("conversation_running"); return; }
    // A turn that was over before the account reset its memory is not committed after it: the reset deleted the engine's sessions
    // (and with them what was pending), and the plugin's replay of an old message must not make a session to commit from.
    if (await this.#endedBeforeReset(entry)) { recordTurnCommit("before_reset"); return; }
    const user = { id: entry.userId };
    // The admission decides who is learned from. Asked before the engine is read so that a paused account, a trial, a
    // conversation that read a patient record and the platform's own projects cost the engine nothing; the gateway's commit
    // asks again at the moment it commits.
    const admitted = await this.admission.admit({ user, project: entry.project, engineSessionId: entry.engineSessionId });
    if (!admitted.native || (!admitted.learn && admitted.learnReason !== "automated_run")) { recordTurnCommit("not_learning"); return; }

    /** @type {{ pending: number, count: number } | null} */
    let previous = null;
    /** @type {unknown} */
    let failure = null;
    for (let attempt = 0; attempt < this.attempts; attempt += 1) {
      if (attempt) await this.wait(this.settleMs);
      if (this.closed) return;
      let pending = 0;
      let count = 0;
      try {
        const state = (await this.sessions.readSession(entry.userId, entry.engineSessionId))?.result ?? {};
        pending = Number(state.pending_tokens) || 0;
        count = Number(state.message_count) || 0;
        failure = null;
      } catch (error) {
        // The engine has no such session: no message of this conversation was ever forwarded to it.
        if (/** @type {any} */ (error)?.code === "memory_index_not_found") { recordTurnCommit("nothing_pending"); return; }
        failure = error;
        previous = null;
        continue;
      }
      const last = attempt === this.attempts - 1;
      const settled = previous !== null && previous.pending === pending && previous.count === count;
      previous = { pending, count };
      // Something is pending and two reads agree (the plugin's writes have landed) — or these were the last reads.
      if (pending > 0 && (settled || last)) return this.#commitNow(entry, user);
    }
    if (failure) throw failure;
    recordTurnCommit("nothing_pending");
  }

  /** @param {Armed} entry @param {{ id: string }} user */
  async #commitNow(entry, user) {
    // The person may have written again while the reads settled: that turn's own end commits it.
    if (await this.#personIsTyping(entry)) { recordTurnCommit("conversation_running"); return; }
    const answer = await this.commit({ user, project: entry.project, engineSessionId: entry.engineSessionId });
    recordTurnCommit(answer.commit === "accepted" ? "committed" : answer.commit);
  }

  /** Resolves when every commit that has started has finished. A test and a shutdown wait on it. */
  async idle() {
    while (this.running.size) await Promise.allSettled([...this.running]);
  }

  /** Stops waiting: nothing armed will fire. A commit in progress finishes. */
  close() {
    this.closed = true;
    for (const entry of this.armed.values()) this.clearTimer(entry.timer);
    this.armed.clear();
    this.queue.length = 0;
  }
}
