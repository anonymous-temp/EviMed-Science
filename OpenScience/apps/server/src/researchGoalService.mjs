/**
 * 主动科研's long research goals, as the control plane keeps them: what LoopX cannot do from inside a kernel.
 *
 * LoopX's driver lives in the kernel's memory. It starts the next round while the kernel is up and the goal is active, and it is gone with the
 * kernel: a release, a crash or a restart of the control plane ended a goal without a word, and only a person writing to the conversation
 * started it again (drills D03 to D06, 2026-11-03). And a goal that had done its work could go on asking for rounds that said so (D02, D22).
 *
 * So one document per goal (`research-goal`, in the product ledger, gone with its project) and three things that act on it:
 *
 * - `observeRound`, from `onRunFinished`: a person's stop, and the guard. Rounds in a row that left no file, or a goal's spend past its
 *   limit, pause the goal through LoopX's own bar, and the person is told. A count and a sum: the words of a round decide nothing.
 * - `tick`, from a timer: a goal with no round running. A round the platform ended, or a kernel that came back without the driver armed, is
 *   taken up again with one automated turn, a bounded number of times with a backoff; the state LoopX's bar reports says what became of
 *   the rest (finished, or waiting for someone). What a project connected meanwhile is said to the running round, which reads it only if told.
 * - `pause` and `resume`, for the page. A pause that could not be confirmed on the bar stops the next automatic round instead.
 *
 * LoopX still owns the goal: its state is read and changed through `loopx.goalbar`, the door its own bar uses, and nothing here parses its
 * files. Off (`OPEN_SCIENCE_RESEARCH_GOAL_WATCH_ENABLED`, or no PostgreSQL) a goal behaves as it did before.
 *
 * @module researchGoalService
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import { HttpError } from "./security.mjs";
import { GOAL_RESUME_ROUTE, GOAL_RETRY_ROUTE, goalBarState, goalRounds, goalSpendCny, guardVerdict, isGoalContinuation, roundProducedFiles,
  roundStoppedByPerson, roundWasInterrupted, roundsWithoutProgress, setsResearchGoal, statusFromGoalBar } from "./researchGoalState.mjs";
import { researchGoalBlock, researchGoalPrompt } from "./researchGoal.mjs";
import { recordResearchGoalEvent } from "./researchGoalMetrics.mjs";

const KIND = "research-goal";
const SOURCE_DIRECTORY = "knowledge-base";
/** How many names of newly connected files one note carries, and how many names a goal remembers. */
const NOTE_NAMES = 5;
const KNOWN_SOURCES = 500;
/** How long after a round of LoopX's that began after a pause its driver is taken to be still trying: well past its 18-second cycle, and no longer. */
const LATE_ROUND_WINDOW_MS = 120_000;
/** What a goal that has been taken up again is told. It reads as the platform's, because it is. */
const RESUME_TEXT = "请接着做这项研究：上一轮被中断了。先看已有的产出，只做没做完的部分，不要从头重做。";
const PERSON_RESUME_TEXT = "继续这项研究。先看已有的产出，只做没做完的部分。";

/** @param {string} sessionId */
const documentId = (sessionId) => `goal-${sessionId}`;
/** @param {any} run */
const isLive = (run) => run?.status === "running" || run?.status === "queued";
/** @param {any} run */
const endOf = (run) => Date.parse(run?.finishedAt ?? run?.startedAt ?? run?.createdAt ?? 0);
/** @param {any} run */
const goalQuestion = (run) => String(run?.question ?? "").replace(/^\/loopx\s*/i, "").trim();

export class ResearchGoals {
  /**
   * @param {{ documents: any, database: any, agentRuns: any, runtimeManager: any, store: any,
   *   dispatchTurn: (project: any, turn: { sessionId: string, text: string, route: string, question: string, system?: string }) => Promise<any>,
   *   steerRound: (project: any, run: any, text: string) => Promise<any>,
   *   cancelRound: (project: any, run: any) => Promise<any>,
   *   notify?: (userId: string, item: any) => Promise<any>,
   *   claimingAllowed?: () => boolean,
   *   limits: { quietMs: number, maxRoundsWithoutProgress: number, maxCny: number, reviveAttempts: number, reviveBackoffMs: readonly number[], staleMs: number, tickMs: number },
   *   now?: () => Date, log?: (line: string) => void }} dependencies
   */
  constructor({ documents, database, agentRuns, runtimeManager, store, dispatchTurn, steerRound, cancelRound, notify = async () => {}, claimingAllowed = () => true,
    limits, now = () => new Date(), log = () => {} }) {
    this.documents = documents;
    this.database = database;
    this.agentRuns = agentRuns;
    this.runtimeManager = runtimeManager;
    this.store = store;
    this.dispatchTurn = dispatchTurn;
    this.steerRound = steerRound;
    this.cancelRound = cancelRound;
    this.notify = notify;
    this.claimingAllowed = claimingAllowed;
    this.limits = limits;
    this.now = now;
    this.log = log;
    /** @type {NodeJS.Timeout | null} */ this.timer = null;
    /** @type {Promise<void> | null} */ this.ticking = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.limits.tickMs);
    this.timer.unref?.();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.ticking?.catch(() => {});
  }

  /** @param {any} project @param {string} sessionId */
  async #read(project, sessionId) { return this.documents.get(project.userId, KIND, documentId(sessionId)); }

  /**
   * Change a goal's document, from what is there now. A conflict is a second writer: read again.
   * @param {any} project @param {string} sessionId @param {(payload: Record<string, any>) => Record<string, any> | null} change
   */
  async #update(project, sessionId, change) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = await this.#read(project, sessionId);
      const next = change(current?.payload ?? this.#fresh(sessionId));
      if (!next) return current;
      try {
        return await this.documents.put(project.userId, KIND, documentId(sessionId), next, { expectedRevision: current?.revision ?? 0, projectId: project.id });
      } catch (error) {
        if (/** @type {any} */ (error)?.status !== 409 && /** @type {any} */ (error)?.statusCode !== 409) throw error;
      }
    }
    throw new HttpError(409, "research_goal_conflict", "The research goal changed while it was being updated.");
  }

  /** @param {string} sessionId */
  #fresh(sessionId) {
    const at = this.now().toISOString();
    return { sessionId, status: "active", reason: null, statusAt: at, createdAt: at, guardSince: null, revive: { attempts: 0, lastAt: null }, knownSources: null, pauseUnconfirmed: false };
  }

  /** A goal 「发起研究」 has just set. @param {any} project @param {{ sessionId: string }} goal */
  async register(project, { sessionId }) {
    const known = await this.#sources(project);
    await this.#update(project, sessionId, (payload) => (payload.knownSources ? null : { ...payload, knownSources: known }));
  }

  /**
   * What the page reads, for each goal of a project that has a document.
   * @param {any} project
   */
  async list(project) {
    const page = await this.documents.list(project.userId, KIND, { limit: 100, projectId: project.id });
    return page.items.map((/** @type {any} */ item) => ({
      sessionId: item.payload.sessionId, status: item.payload.status, reason: item.payload.reason ?? null, statusAt: item.payload.statusAt ?? null,
      goalId: item.payload.goalId ?? null, progress: item.payload.progress ?? null,
    }));
  }

  /** A round ended. Never throws: a goal's bookkeeping must not cost the run's completion anything. @param {any} project @param {any} run */
  async observeRound(project, run) {
    try {
      if (typeof run?.sessionId !== "string") return;
      const runs = await this.agentRuns.list(project);
      const rounds = goalRounds(runs, run.sessionId);
      if (rounds.length === 0) return;
      const at = this.now().toISOString();
      const document = await this.#update(project, run.sessionId, (payload) => {
        const taken = run.goal?.id && payload.goalId !== run.goal.id ? { goalId: run.goal.id } : {};
        // Whatever a pause left unconfirmed no longer matters: a stopped goal is at rest and is not looked at again.
        if (roundStoppedByPerson(run)) return { ...payload, ...taken, status: "stopped", reason: "person", statusAt: at, pauseUnconfirmed: false };
        // A round that began after a goal came to rest means someone took it up (a person's message, LoopX's bar): it is going again. Except a
        // round of LoopX's own on a goal someone paused or stopped: its driver goes on trying to close a round the pause left open.
        const held = payload.status === "paused" || payload.status === "stopped";
        const resumed = payload.status !== "active" && !(held && isGoalContinuation(run)) && Date.parse(run.startedAt ?? 0) >= Date.parse(payload.statusAt ?? 0);
        const revive = run.status === "succeeded" ? { attempts: 0, lastAt: null } : payload.revive;
        return { ...payload, ...taken, ...(resumed ? { status: "active", reason: null, statusAt: at, pauseUnconfirmed: false } : {}), revive };
      });
      if (document?.payload?.status !== "active" || isLive(run)) return;
      const verdict = guardVerdict({ rounds, since: document.payload.guardSince ?? null,
        maxRoundsWithoutProgress: this.limits.maxRoundsWithoutProgress, maxCny: this.limits.maxCny });
      if (verdict) await this.#guardPause(project, run.sessionId, rounds, verdict);
    } catch (error) {
      recordResearchGoalEvent("observe_failed");
      this.log(`research goal: round not observed: ${/** @type {any} */ (error)?.code ?? "research_goal_failed"}`);
    }
  }

  /** @param {any} project @param {string} sessionId @param {readonly any[]} rounds @param {"no_progress" | "budget"} reason */
  async #guardPause(project, sessionId, rounds, reason) {
    const confirmed = await this.#pauseOnBar(project, sessionId);
    const at = this.now().toISOString();
    await this.#update(project, sessionId, (payload) => ({ ...payload, status: "paused", reason, statusAt: at, pauseUnconfirmed: !confirmed }));
    recordResearchGoalEvent(reason === "budget" ? "paused_budget" : "paused_no_progress");
    const title = goalQuestion(rounds.find(setsResearchGoal) ?? rounds[0]);
    const body = reason === "budget"
      ? `已花费约 ¥${goalSpendCny(rounds).toFixed(2)}，到了这项研究的花费上限，已自动暂停：${title}`
      : `连续 ${roundsWithoutProgress(rounds)} 轮没有新的产出，已自动暂停：${title}`;
    await this.#tell(project, sessionId, rounds, "研究已暂停", body, `research-goal-paused:${sessionId}:${at}`);
  }

  /** @param {any} project @param {string} sessionId @param {readonly any[]} rounds @param {string} title @param {string} body @param {string} key */
  async #tell(project, sessionId, rounds, title, body, key) {
    const last = rounds.at(-1);
    await this.notify(project.userId, { noticeType: "notify", projectId: project.id, title, body, groupKey: `goal-state:${sessionId}`, idempotencyKey: key,
      severity: "info", actions: [{ id: "open", label: "打开对话", style: "primary" }], ...(last ? { source: { type: "run", id: last.id } } : {}) }).catch(() => {});
  }

  /** @param {any} project @param {any} payload */
  async #bar(project, payload) {
    try { return await this.runtimeManager.goalBar(project, { v: "loopx_goalbar_request_v2", ...payload }); }
    catch (error) { return { result: { kind: "fault", code: /** @type {any} */ (error)?.code ?? "goalbar_unreachable" } }; }
  }

  /** LoopX's state of one session's goal. @param {any} project @param {string} sessionId */
  async #readBar(project, sessionId) { return goalBarState(await this.#bar(project, { op: "read", sessionId })); }

  /** @param {any} project @param {string} sessionId @returns {Promise<boolean>} whether LoopX now says the goal is stopped */
  async #pauseOnBar(project, sessionId) {
    const read = await this.#readBar(project, sessionId);
    if (read.kind === "hidden" || (read.kind === "present" && read.activation === "stopped")) return true;
    if (read.kind !== "present") return false;
    const answer = await this.#bar(project, { op: "pause", sessionId, expected: { goalId: read.goalId, loopxAgentId: read.loopxAgentId } });
    const kind = answer?.result?.kind;
    if (kind === "succeeded" || kind === "applied_with_warning") return true;
    const after = await this.#readBar(project, sessionId);
    return after.kind === "present" && after.activation === "stopped";
  }

  /** The page's pause. @param {any} project @param {string} sessionId */
  async pause(project, sessionId) {
    const document = await this.#requireGoal(project, sessionId);
    const confirmed = await this.#pauseOnBar(project, sessionId);
    const at = this.now().toISOString();
    recordResearchGoalEvent("paused_person");
    await this.#update(project, sessionId, (payload) => ({ ...payload, status: "paused", reason: "person", statusAt: at, pauseUnconfirmed: !confirmed }));
    return { sessionId, status: "paused", reason: "person", wasStatus: document.payload.status };
  }

  /**
   * LoopX's own bar, in the kernel's page, paused or started a goal: the same state as the page's buttons, at once. Never throws, and a
   * session with no goal is no concern of this.
   * @param {any} project @param {string} sessionId @param {"pause" | "start"} op
   */
  async noteBarAction(project, sessionId, op) {
    try {
      if (goalRounds(await this.agentRuns.list(project), sessionId).length === 0) return;
      const at = this.now().toISOString();
      recordResearchGoalEvent(op === "pause" ? "paused_person" : "resumed_person");
      await this.#update(project, sessionId, (payload) => (op === "pause"
        ? { ...payload, status: "paused", reason: "person", statusAt: at, pauseUnconfirmed: false }
        : { ...payload, status: "active", reason: null, statusAt: at, guardSince: at, pauseUnconfirmed: false, startOnBar: false, revive: { attempts: 0, lastAt: null } }));
    } catch (error) {
      recordResearchGoalEvent("observe_failed");
      this.log(`research goal: bar action not noted: ${/** @type {any} */ (error)?.code ?? "research_goal_failed"}`);
    }
  }

  /**
   * The page's 继续, from any state a goal can rest in. A goal LoopX has stopped is started again on its bar, which is what brings its rounds
   * back; any other is told to go on, which arms the driver in the kernel that is up now. A person asked, so the limits count from here.
   * @param {any} project @param {string} sessionId
   */
  async resume(project, sessionId) {
    await this.#requireGoal(project, sessionId);
    const rounds = goalRounds(await this.agentRuns.list(project), sessionId);
    if (rounds.some(isLive)) throw new HttpError(409, "agent_run_active", "This research session already has an active run.");
    const at = this.now().toISOString();
    const read = await this.#readBar(project, sessionId);
    let started = false;
    if (read.kind === "present" && read.activation === "stopped") {
      const answer = await this.#bar(project, { op: "start", sessionId, expected: { goalId: read.goalId, loopxAgentId: read.loopxAgentId } });
      started = answer?.result?.kind === "succeeded" || answer?.result?.kind === "applied_with_warning";
    }
    if (!started) {
      await this.dispatchTurn(project, { sessionId, text: PERSON_RESUME_TEXT, route: GOAL_RESUME_ROUTE, question: goalQuestion(rounds.find(setsResearchGoal) ?? rounds[0]) });
    }
    recordResearchGoalEvent("resumed_person");
    await this.#update(project, sessionId, (payload) => ({ ...payload, status: "active", reason: null, statusAt: at, guardSince: at, pauseUnconfirmed: false,
      // The bar could not say (no session loaded yet) or could not start it (a turn was going): it is started there as soon as it can be.
      startOnBar: !started, revive: { attempts: 0, lastAt: null } }));
    return { sessionId, status: "active" };
  }

  /** @param {any} project @param {string} sessionId */
  async #requireGoal(project, sessionId) {
    const document = await this.#read(project, sessionId);
    if (document) return document;
    const rounds = goalRounds(await this.agentRuns.list(project), sessionId);
    if (rounds.length === 0) throw new HttpError(404, "research_goal_not_found", "The research goal is unavailable.");
    return this.#update(project, sessionId, (payload) => payload);
  }

  /** One pass over every goal that may need something. Never overlaps itself, and stands down while the deployment is held for a release. */
  async tick() {
    if (this.ticking || !this.claimingAllowed()) return;
    this.ticking = this.#pass().catch((error) => {
      recordResearchGoalEvent("tick_failed");
      this.log(`research goal: pass failed: ${/** @type {any} */ (error)?.code ?? "research_goal_failed"}`);
    }).finally(() => { this.ticking = null; });
    await this.ticking;
  }

  async #pass() {
    const { rows } = await this.database.query(`SELECT user_id, project_id, payload->>'sessionId' AS session_id FROM evimed_product.documents
      WHERE kind = 'research-goal' AND deleted_at IS NULL AND (payload->>'status' = 'active' OR payload->>'pauseUnconfirmed' = 'true'
        OR (payload->>'status' = 'paused' AND (payload->>'statusAt')::timestamptz > now() - interval '6 hours'))
      ORDER BY updated_at LIMIT 200`);
    for (const row of rows) {
      try {
        const user = await this.store.userById(row.user_id);
        if (!user) continue;
        await this.#review(await this.store.requireProject(user, row.project_id), row.session_id);
      } catch (error) {
        recordResearchGoalEvent("review_failed");
        this.log(`research goal: review failed: ${/** @type {any} */ (error)?.code ?? "research_goal_failed"}`);
      }
    }
  }

  /** @param {any} project @param {string} sessionId */
  async #review(project, sessionId) {
    const document = await this.#read(project, sessionId);
    if (!document) return;
    const payload = document.payload;
    const rounds = goalRounds(await this.agentRuns.list(project), sessionId);
    if (rounds.length === 0) return;
    if (payload.status === "paused") { await this.#enforcePause(project, sessionId, payload, rounds); return; }
    // A goal at rest waits for a person, whatever a pause before it left unconfirmed: going on from here would read a person's stop as an interruption.
    if (payload.status !== "active") return;
    if (payload.startOnBar) await this.#startOnBar(project, sessionId);
    const live = rounds.find(isLive);
    // Only a turn nobody is at: what is written into a person's own turn reads as their statement to memory and to the learning loop.
    if (live) { if (live.automated === true) await this.#noteNewSources(project, sessionId, payload, live); return; }
    const last = rounds.at(-1);
    // From the later of the last round and a person taking the goal up: one just started has not been quiet since a round of an hour ago.
    const quiet = this.now().getTime() - Math.max(endOf(last), Date.parse(payload.guardSince ?? 0) || 0);
    if (roundWasInterrupted(last)) { await this.#takeUp(project, sessionId, payload, rounds, quiet); return; }
    if (last.status !== "succeeded") {
      // A failure that going on would not mend: no credits, a refused start. It waits for a person.
      await this.#rest(project, sessionId, rounds, "interrupted", String(last.errorCode ?? "failed"));
      return;
    }
    if (quiet < this.limits.quietMs) return;
    const status = await this.runtimeManager.status(project).catch(() => null);
    const up = status?.running === true;
    const startedAt = Date.parse(status?.startedAt ?? 0);
    const rearmNeeded = !up || (Number.isFinite(startedAt) && startedAt > endOf(last));
    if (!rearmNeeded) { await this.#settle(project, sessionId, rounds, await this.#readBar(project, sessionId)); return; }
    if (quiet > this.limits.staleMs) { await this.#rest(project, sessionId, rounds, "interrupted", "stale"); return; }
    // The kernel that held the driver is gone. Only LoopX can say whether work is left, so its bar is asked before anything is spent on going on.
    await this.runtimeManager.startWhenRoom(project);
    const read = await this.#readBar(project, sessionId);
    const said = read.kind === "present" ? statusFromGoalBar(read) : null;
    if (said && said.status !== "waiting") { await this.#settle(project, sessionId, rounds, read); return; }
    await this.#takeUp(project, sessionId, payload, rounds, quiet);
  }

  /** @param {any} project @param {string} sessionId @param {readonly any[]} rounds @param {any} read */
  async #settle(project, sessionId, rounds, read) {
    // The kernel is at a turn the ledger has not caught up with.
    if (read.kind === "present" && read.agentStatus === "running") return;
    const said = statusFromGoalBar(read);
    const faults = said ? 0 : Number((await this.#read(project, sessionId))?.payload.barFaults ?? 0) + 1;
    if (!said && faults < 5) {
      await this.#update(project, sessionId, (payload) => ({ ...payload, barFaults: faults }));
      return;
    }
    const status = said?.status ?? "waiting";
    const progress = read.kind === "present" ? { processed: read.processed, total: read.total } : null;
    await this.#rest(project, sessionId, rounds, status, said?.reason ?? null, progress);
  }

  /** A goal comes to rest, and the person hears of it when that is news. */
  async #rest(/** @type {any} */ project, /** @type {string} */ sessionId, /** @type {readonly any[]} */ rounds, /** @type {string} */ status, /** @type {string | null} */ reason, /** @type {any} */ progress = null) {
    const at = this.now().toISOString();
    await this.#update(project, sessionId, (payload) => ({ ...payload, status, reason, statusAt: at, barFaults: 0, ...(progress ? { progress } : {}) }));
    recordResearchGoalEvent(status === "finished" ? "finished" : status === "waiting" ? "waiting" : status === "interrupted" ? "interrupted" : "paused_person");
    const title = goalQuestion(rounds.find(setsResearchGoal) ?? rounds[0]);
    if (status === "finished") await this.#tell(project, sessionId, rounds, "研究完成了", title, `research-goal-finished:${sessionId}:${rounds.at(-1)?.id}`);
    if (status === "interrupted") await this.#tell(project, sessionId, rounds, "研究中断了", `没能自动接着做，可以在主动科研里点“继续”：${title}`, `research-goal-interrupted:${sessionId}:${rounds.at(-1)?.id}`);
    if (status === "waiting") await this.#tell(project, sessionId, rounds, "研究停下了", `还有没做完的部分，可以在主动科研里点“继续”：${title}`, `research-goal-waiting:${sessionId}:${rounds.at(-1)?.id}`);
  }

  /** A round the platform ended, or a driver lost with its kernel: one automated turn, bounded, with a backoff the provider's bad minutes can pass in. */
  async #takeUp(/** @type {any} */ project, /** @type {string} */ sessionId, /** @type {any} */ payload, /** @type {readonly any[]} */ rounds, /** @type {number} */ quiet) {
    const attempts = Number(payload.revive?.attempts ?? 0);
    if (attempts >= this.limits.reviveAttempts) { await this.#rest(project, sessionId, rounds, "interrupted", String(rounds.at(-1)?.errorCode ?? "not_revived")); return; }
    const wait = this.limits.reviveBackoffMs[Math.min(attempts, this.limits.reviveBackoffMs.length - 1)];
    const lastAt = Date.parse(payload.revive?.lastAt ?? 0);
    if (quiet < wait || (Number.isFinite(lastAt) && this.now().getTime() - lastAt < wait)) return;
    const first = rounds.find(setsResearchGoal) ?? rounds[0];
    const question = goalQuestion(first);
    // A goal LoopX never heard of (its first turn came back with nothing) is set again; one it knows is told to go on.
    const begun = rounds.some(isGoalContinuation) || (first.status === "succeeded" && roundProducedFiles(first));
    const at = this.now().toISOString();
    await this.#update(project, sessionId, (current) => ({ ...current, revive: { attempts: attempts + 1, lastAt: at } }));
    try {
      await this.dispatchTurn(project, begun
        ? { sessionId, text: RESUME_TEXT, route: GOAL_RESUME_ROUTE, question }
        : { sessionId, text: researchGoalPrompt(question), route: GOAL_RETRY_ROUTE, question, system: researchGoalBlock() });
      recordResearchGoalEvent(begun ? "revived" : "retried");
    } catch (error) {
      recordResearchGoalEvent("revive_failed");
      this.log(`research goal: not taken up: ${/** @type {any} */ (error)?.code ?? "research_goal_failed"}`);
    }
  }

  /**
   * What holds a paused goal. A round that was going when the pause came is let finish. But a pause can leave a round LoopX cannot close, because
   * a stopped goal may not spend, and its driver then starts a round every 18 seconds to close it, for ever (drill D02, 2026-11-03: 80 rounds in
   * 25 minutes saying the goal is paused); and a pause the bar did not confirm has nothing holding it at all. Those rounds last 13 seconds, too
   * short to be seen running on a 30-second pass, so a round of LoopX's that began after the pause is itself the sign, and the kernel's turn
   * is stopped whether the ledger has it yet or not. A stopped turn ends the driver's trying until someone starts the goal.
   */
  async #enforcePause(/** @type {any} */ project, /** @type {string} */ sessionId, /** @type {any} */ payload, /** @type {readonly any[]} */ rounds) {
    const last = rounds.at(-1);
    if (!isGoalContinuation(last)) return;
    const late = Date.parse(last.startedAt ?? 0) > Date.parse(payload.statusAt ?? 0);
    const recent = isLive(last) || this.now().getTime() - endOf(last) < LATE_ROUND_WINDOW_MS;
    if (recent && (late || (payload.pauseUnconfirmed && isLive(last)))) {
      // Unless someone started it on the bar and the news did not reach here.
      if (!payload.pauseUnconfirmed) {
        const read = await this.#readBar(project, sessionId);
        if (read.kind === "present" && read.activation === "active") {
          await this.noteBarAction(project, sessionId, "start");
          return;
        }
      }
      recordResearchGoalEvent("held_pause");
      await this.cancelRound(project, last).catch(() => {});
    }
    if (payload.pauseUnconfirmed && await this.#pauseOnBar(project, sessionId)) await this.#update(project, sessionId, (current) => ({ ...current, pauseUnconfirmed: false }));
  }

  /** @param {any} project @param {string} sessionId */
  async #startOnBar(project, sessionId) {
    const read = await this.#readBar(project, sessionId);
    if (read.kind !== "present") return;
    if (read.activation === "stopped") {
      const answer = await this.#bar(project, { op: "start", sessionId, expected: { goalId: read.goalId, loopxAgentId: read.loopxAgentId } });
      // A turn is going: the next pass asks again.
      if (answer?.result?.kind !== "succeeded" && answer?.result?.kind !== "applied_with_warning") return;
    }
    await this.#update(project, sessionId, (payload) => ({ ...payload, startOnBar: false }));
  }

  /** The files in the project's knowledge base, by name. Every way in (a page, a table, a conversation) lands there. @param {any} project */
  async #sources(project) {
    try {
      const entries = await readdir(path.join(project.workspaceDir, SOURCE_DIRECTORY));
      return entries.filter((name) => !name.startsWith(".")).sort().slice(0, KNOWN_SOURCES);
    } catch { return []; }
  }

  /** A running goal reads the knowledge base when it starts and not again, so what arrives later is said to the round at work. */
  async #noteNewSources(/** @type {any} */ project, /** @type {string} */ sessionId, /** @type {any} */ payload, /** @type {any} */ live) {
    const present = await this.#sources(project);
    if (!Array.isArray(payload.knownSources)) { await this.#update(project, sessionId, (current) => ({ ...current, knownSources: present })); return; }
    const known = new Set(payload.knownSources);
    const fresh = present.filter((name) => !known.has(name));
    if (fresh.length === 0) return;
    await this.steerRound(project, live, `项目知识库里新接入了资料：${fresh.slice(0, NOTE_NAMES).join("、")}${fresh.length > NOTE_NAMES ? ` 等 ${fresh.length} 份` : ""}。看一下是否和这项研究相关，相关就用上。`);
    recordResearchGoalEvent("noted_sources");
    await this.#update(project, sessionId, (current) => ({ ...current, knownSources: present }));
  }
}
