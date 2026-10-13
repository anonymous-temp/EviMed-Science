/**
 * What kind of work a finished conversation was (2026-10-13), for the memory map's 「在做什么」 radar.
 *
 * The radar used to be drawn from the capability that answered a conversation, so it said something only about an account that
 * used a named capability: a researcher who asked for a slide deck, a spreadsheet or a script in an ordinary conversation had no
 * radar. What a piece of work *was* is a language judgement (principle 1), so one small Flash call makes it — the question, the
 * capability that answered when one did, and the kinds of file it left — and picks one of a short fixed list. The list is the
 * radar's axes, so the model's open reading of the task is collapsed to something a polygon can stand on; code keeps the answer
 * only if it is on the list (principle 5: a failed verdict is dropped, not softened).
 *
 * Hidden knowledge:
 *
 * - **Recorded once, on the run ledger** (`recordRunLabels({ taskType })`, a field of the `notice` event): a conversation is not
 *   judged again, and a judgement is never rewritten, so the radar of a past month does not move.
 * - **Never on the critical path.** `consider` is called from the ledger's state-change listener and from the map's read; it
 *   returns at once and the call runs beside whatever is happening. A failure leaves the run unlabelled and the radar counts it by
 *   the capability that answered, or not at all. A conversation is tried once per process (`attempted`), so a model that keeps
 *   failing cannot be asked without end.
 * - **Bounded by the account's day**: `taskTypeDailyCalls` calls per account, counted from the usage ledger's own rows of purpose
 *   `task-type` the first time an account is seen in a day, then in memory. Three at a time; a conversation that finds no free
 *   place is not marked tried, and a later read picks it up.
 * - **Charged to the researcher** like a run title (purpose `task-type`, caps included).
 *
 * Deletable when the kernel states the kind of work it did in a form the control plane can read.
 *
 * @module runTaskType
 */

import { CAPABILITY_DISPLAY } from "@evimed/domain";

import { isResearcherRun } from "./agentRuns.mjs";
import { callModelForControlPlane } from "./modelGateway.mjs";
import { OPEN_DOMAIN_ANSWER_AGENT_ID } from "./specialistRouting.mjs";
import { TASK_TYPES, TASK_TYPE_IDS, TASK_TYPE_OF_CATEGORY } from "./taskTypes.mjs";

const INSTRUCTIONS = [
  "You say what kind of work one finished conversation between a person and an assistant was, from the person's request.",
  "Choose exactly one of these kinds, by its id:",
  ...TASK_TYPES.map((type) => `- ${type.id}: ${type.meaning}.`),
  "Judge the work the person asked for, not the topic it happens to be about: a request to turn clinical results into slides is documents; a request to analyse a spreadsheet of sales is data; a request to write a Python script that cleans a trial dataset is code.",
  "When two kinds fit, take the one that names what the person wanted made or done. When nothing fits, or the request is too short to tell, answer other.",
  "The request may be in any language. `capability` names the specialist tool that answered, when one did, and `files` the kinds of file the conversation left; both are hints, not the answer.",
  "Answer only with JSON: {\"type\": \"<id>\"}.",
].join("\n");

/**
 * The model's answer, if it is on the list: `{"type": "<id>"}` in the content, or in the reasoning text when a reasoning model wrote
 * its answer there. Anything else is no answer.
 * @param {unknown} content @returns {string | null}
 */
export function taskTypeFrom(content) {
  if (typeof content !== "string" || !content.trim()) return null;
  const raw = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const candidates = [raw, ...[...raw.matchAll(/\{[^{}]*\}/g)].map((match) => match[0]).reverse()];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const type = typeof parsed?.type === "string" ? parsed.type.trim().toLowerCase() : "";
      if (TASK_TYPE_IDS.has(type)) return type;
    } catch { /* keep looking */ }
  }
  return null;
}

/** The extensions of the files a run left, at most six, without a path: a hint about what was made. @param {unknown} artifacts */
function fileKinds(artifacts) {
  const kinds = new Set();
  for (const artifact of Array.isArray(artifacts) ? artifacts : []) {
    const name = String(typeof artifact === "string" ? artifact : artifact?.path ?? "");
    const extension = /\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1]?.toLowerCase();
    if (extension) kinds.add(extension);
    if (kinds.size >= 6) break;
  }
  return [...kinds];
}

export class TaskTyper {
  /**
   * @param {Record<string, any>} config
   * @param {{ usageLedger?: any, fetchImpl?: typeof fetch, callModel?: typeof callModelForControlPlane }} [options]
   */
  constructor(config, { usageLedger = null, fetchImpl = globalThis.fetch, callModel = callModelForControlPlane } = {}) {
    this.config = config;
    this.usageLedger = usageLedger;
    this.fetchImpl = fetchImpl;
    this.callModel = callModel;
    this.timeoutMs = Math.max(1_000, Math.min(60_000, Number(config?.modelGatewayTimeoutMs ?? 30_000)));
  }

  get available() {
    return this.config?.taskTypeEnabled !== false && Number(this.config?.taskTypeDailyCalls ?? 0) > 0
      && this.config?.deepseekProviderEnabled === true && Boolean(this.config?.deepseekApiKey);
  }

  /**
   * The kind of work one conversation was, or null — never a throw.
   * @param {{ question: string, capability?: string | null, files?: unknown }} work
   * @param {{ userId: string, projectId: string, runId: string }} owner
   * @returns {Promise<string | null>}
   */
  async typeOf({ question, capability = null, files = [] }, { userId, projectId, runId }) {
    if (!this.available || typeof question !== "string" || !question.trim()) return null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const body = await this.callModel({ config: this.config, usageLedger: this.usageLedger, fetchImpl: this.fetchImpl }, {
        userId, projectId, runId, purpose: "task-type", signal: controller.signal,
        body: {
          model: this.config.deepseekModel,
          temperature: 0,
          // A choice among seven words needs no reasoning (the run title's measurement applies: thinking off is the same answer in a
          // fraction of the time); the budget still leaves room for a model that thinks anyway.
          thinking: { type: "disabled" },
          max_tokens: 2_000,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: INSTRUCTIONS },
            { role: "user", content: JSON.stringify({ request: question.slice(0, 1_500), capability, files: fileKinds(files) }) },
          ],
        },
      });
      const message = body?.choices?.[0]?.message;
      return taskTypeFrom(message?.content) ?? taskTypeFrom(message?.reasoning_content);
    } catch (error) {
      process.stderr.write(`task type failed for ${runId}: ${/** @type {any} */ (error)?.name === "AbortError" ? "timeout" : /** @type {any} */ (error)?.code ?? "error"}\n`);
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** The most judgements in flight at once. */
const MAX_IN_FLIGHT = 3;
/** The oldest conversation judged: the radar reads two periods of thirty days. */
const MAX_AGE_MS = 62 * 86_400_000;

/** Decides which finished conversations get judged and records the answer on the ledger. */
export class TaskTypeScheduler {
  /**
   * @param {{ typer: TaskTyper, recordType: (project: any, runId: string, type: string) => Promise<unknown>, dailyCalls: () => number,
   *   usageLedger?: any, now?: () => number }} options
   */
  constructor({ typer, recordType, dailyCalls, usageLedger = null, now = () => Date.now() }) {
    this.typer = typer;
    this.recordType = recordType;
    this.dailyCalls = dailyCalls;
    this.usageLedger = usageLedger;
    this.now = now;
    /** Conversations already tried, oldest first. @type {Set<string>} */
    this.attempted = new Set();
    /** @type {Set<Promise<void>>} */
    this.pending = new Set();
    /** The calls an account has made today, by account. @type {Map<string, { day: string, calls: number }>} */
    this.days = new Map();
  }

  /** Whether a conversation is one this feature judges: a researcher's own, finished, asked, and not judged. @param {Record<string, any>} run */
  wants(run) {
    if (!run?.id || run.taskType || run.deleted === true || run.status !== "succeeded" || !run.question || !isResearcherRun(run)) return false;
    // A named capability's category already says what its work is (the product's own catalogue): nothing to ask a model.
    if (TASK_TYPE_OF_CATEGORY[CAPABILITY_DISPLAY[String(run.effectiveAgentId ?? run.agentId ?? "")]?.category ?? ""]) return false;
    const finished = Date.parse(run.finishedAt ?? run.startedAt ?? run.createdAt ?? "");
    return Number.isFinite(finished) && this.now() - finished <= MAX_AGE_MS;
  }

  /**
   * Judge one conversation beside whatever is happening. Returns whether a judgement was started.
   * @param {any} project @param {Record<string, any>} run
   */
  consider(project, run) {
    if (!this.typer.available || !this.wants(run) || this.attempted.has(run.id) || this.pending.size >= MAX_IN_FLIGHT) return false;
    this.attempted.add(run.id);
    if (this.attempted.size > 5_000) this.attempted.delete(/** @type {string} */ (this.attempted.values().next().value));
    const work = (async () => {
      if (!await this.#withinDay(project.userId)) return;
      // The capability that answered, when a named one did: a hint, since the open-domain line answers everything.
      const agent = String(run.effectiveAgentId ?? run.agentId ?? "");
      const type = await this.typer.typeOf(
        { question: run.question, capability: agent && agent !== OPEN_DOMAIN_ANSWER_AGENT_ID ? CAPABILITY_DISPLAY[agent]?.title ?? agent : null, files: run.artifacts },
        { userId: project.userId, projectId: project.id, runId: run.id },
      );
      if (type) await this.recordType(project, run.id, type);
    })().catch(() => {
      // isolated: the run stays unlabelled, and the radar counts it by the capability that answered, or not at all.
    });
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work));
    return true;
  }

  /** Counts the call against the account's day, or says the day is spent. @param {string} userId */
  async #withinDay(userId) {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    let entry = this.days.get(userId);
    if (!entry || entry.day !== day) {
      // The first time an account is seen today: what the usage ledger already holds, so a restart does not give the day back.
      let calls = 0;
      try {
        calls = (await this.usageLedger?.summary?.(userId, { since: new Date(`${day}T00:00:00Z`), purposes: ["task-type"] }))?.totalCalls ?? 0;
      } catch { /* an unreadable ledger counts from here */ }
      entry = { day, calls: Number(calls) || 0 };
      this.days.set(userId, entry);
    }
    if (entry.calls >= this.dailyCalls()) return false;
    entry.calls += 1;
    return true;
  }

  /** Every judgement still being made, for shutdown and tests. */
  async settle() {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }
}
