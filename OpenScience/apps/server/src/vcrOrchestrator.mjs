/**
 * 「虚拟临研」's seven-step program (build plan 2026-09-28 §4, §6.3, §10):
 * which step runs next, decided by platform rules and never by the model.
 *
 * The division of labour is the one 「循证 GEO」 paid for and proved: **the
 * steps that think run as AI runs; the steps that compute run as platform
 * jobs.** Drafting the research definition, structuring eligibility criteria,
 * extracting precedents, choosing a comparator route, writing the package —
 * those are runs. Profiling a snapshot, building a cohort, synthesising a
 * population, weighting a comparator, simulating a design, evaluating criteria
 * — those are jobs in `evimed_vcr.jobs`, which do not take the study's one run
 * slot and so never block the researcher's own conversation.
 *
 * Hidden knowledge:
 *
 * - **What is wanted is derived, not stored.** A step the user asked for is
 *   `requested`; whatever it needs upstream is wanted too, as a *minimal*
 *   version when it was not itself requested (plan §4: 「缺的上游由 AI 补一个
 *   最小版本」). So 「这个单臂试验能不能用外部对照？」 asks for one step and gets
 *   a minimal definition under it, marked as minimal, and asking for the full
 *   thing later does not redo what was done.
 * - **A step's completion is read from the data, never from a run's word**
 *   (attachment E §2.2): the definition step is done when a definition version
 *   exists, the comparator step when the design carries a result or a
 *   deterministic 「不可估计」 — which is a finished result, not a failure
 *   (plan §3.6). A failed run that wrote its object still counts (principle
 *   19); a finished run that wrote nothing fails its steps.
 * - **Every side effect is claimed first** in `evimed_vcr.schedule_marks` by a
 *   key that names it (`run:analysis`, `job:trial_scenario:scn_x@2`,
 *   `notice:not-estimable:<result>`, `recompute:<node>`). The key is what
 *   makes a tick, a restart and a second process idempotent, and a run's
 *   dispatch id is derived from its key and attempt so a dispatch that was
 *   accepted but not recorded returns the same run.
 * - **The worker's cross-process lease is an advisory lock, not a mark.**
 *   `schedule_marks.study_id` has a foreign key to `studies`, so the
 *   `_platform` row GEO uses for its leases cannot exist here; the lease is a
 *   session advisory lock on its own connection instead, which holds no pool
 *   connection while the work runs.
 * - **Nothing stops except the three stops** (§10.1). Over-budget compute
 *   waits in `awaiting_budget` for one confirmation; contacting a patient is
 *   the matching package's; clinical safety is the platform's existing rule.
 *   Everything else the AI decides takes effect at once, labelled `ai_set`.
 * - **A change recomputes, it does not delete** (§6.3, AC-16): `recomputePlan`
 *   splits what a change affects into light and heavy, both are marked stale
 *   with the reason, and the stale result keeps its numbers and its page until
 *   a new one supersedes it.
 *
 * @module vcrOrchestrator
 */

import {
  VCR_JOB_KINDS, VCR_PATIENT_LEVEL_JOB_KINDS, VCR_STALE_REASONS, VCR_STEPS, VCR_STEP_CAPABILITIES, VCR_STEP_NEEDS,
  lineageNode, recomputePlan,
} from "@evimed/domain";

import { HttpError, randomId } from "./security.mjs";
import { VCR_SCHEMA } from "./vcrPersistence.mjs";
import { vcrObjectNode } from "./vcrStore.mjs";

/** Which capability thinks each step (the domain's map, named here for readers). */
export const VCR_RUN_CAPABILITIES = VCR_STEP_CAPABILITIES;

/** Which `results.kind` each research object's result is filed under. */
export const VCR_OBJECT_RESULT_KINDS = Object.freeze({
  population: "population", patient_set: "patient_set", comparator: "comparator",
  trial_scenario: "trial_scenario", design_grid: "design_grid",
});

/** The four steps one `vcr-analysis` run covers, in order. */
export const VCR_ANALYSIS_STEPS = Object.freeze(["population", "patients", "comparator", "trial"]);

/** A step is finished when it is `done` or a deliberate `minimal`. */
const FINISHED = new Set(["done", "minimal"]);
const TERMINAL_RUN = new Set(["succeeded", "failed", "canceled", "cancelled"]);
/** Dispatch refusals that will not clear by waiting a minute. */
const TERMINAL_DISPATCH = new Set(["vcr_unavailable", "vcr_study_not_found", "project_not_found", "autopilot_capability_unavailable"]);

/** Runs: two tries a key, a claim that stalls for ten minutes is retried. */
export const VCR_RUN_RULES = Object.freeze({ attempts: 2, staleClaimMinutes: 10, studiesPerTick: 200, noticesPerTick: 20 });

/** How far actual accrual may drift from the registered forecast before a person hears about it. */
export const VCR_ACCRUAL_TOLERANCE = 0.2;

/** @param {unknown} error */
const codeOf = (error) => (typeof /** @type {any} */ (error)?.code === "string" ? /** @type {any} */ (error).code : "vcr_orchestrator_failed");
/** @param {unknown} value */
const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {});
/** @param {unknown} value */
const list = (value) => (Array.isArray(value) ? value : []);

/**
 * The lineage node of one version of one assumption card. Keyed by the card's
 * key rather than by its row id, because a new version is a new row: the whole
 * point of the graph is that 「脱落率 v2」 and 「脱落率 v1」 are versions of one
 * thing (plan §6.3).
 * @param {string} key @param {number} version
 */
export function vcrAssumptionNode(key, version) {
  return lineageNode("assumption", String(key), Number(version));
}

/**
 * The versions a change supersedes: every earlier version of the same object
 * that the graph knows about. A result was computed from 「脱落率 v1」, so
 * writing v2 is what makes that result stale — the traversal has to start at
 * v1, which is where the edges are.
 * @param {readonly { from: string, to: string }[]} edges @param {readonly string[]} changed
 * @returns {readonly string[]}
 */
export function vcrSupersededNodes(edges, changed) {
  const out = new Set(changed ?? []);
  for (const node of changed ?? []) {
    const at = node.lastIndexOf("@");
    if (at < 0) continue;
    const prefix = node.slice(0, at + 1);
    const version = Number(node.slice(at + 1));
    if (!Number.isFinite(version)) continue;
    for (const edge of edges ?? []) {
      for (const end of [edge?.from, edge?.to]) {
        if (typeof end !== "string" || !end.startsWith(prefix)) continue;
        if (Number(end.slice(at + 1)) < version) out.add(end);
      }
    }
  }
  return Object.freeze([...out]);
}

/**
 * A dispatch id as the mark carries it: one token, so the tag in a prompt
 * stays one tag whatever the id holds.
 * @param {string} dispatchId
 */
export function vcrRunId(dispatchId) {
  return String(dispatchId).replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 80);
}

/** The dispatch id of one attempt at one run key. @param {string} key @param {number} attempt */
export function vcrDispatchId(key, attempt) {
  return vcrRunId(`vcr-${key.replace(/[^A-Za-z0-9_-]+/g, "-")}-${attempt}`);
}

/**
 * The prompt a dispatched run gets: the brief, then the dispatch tag on its
 * own line so the run ledger can find the run again after a replay. The tag is
 * written here as a literal, the way `platformDispatchTags.test.mjs` reads it.
 * @param {string} brief @param {string} dispatchId
 */
export function vcrRunPrompt(brief, dispatchId) {
  return `${brief}\n\n<evimed-vcr-run>${vcrRunId(dispatchId)}</evimed-vcr-run>`;
}

/**
 * What the program wants from its steps: every requested step and, as a
 * minimal version, whatever it needs upstream (`VCR_STEP_NEEDS`).
 * @param {Record<string, { status: string, requested: boolean }>} steps
 */
export function wantedVcrSteps(steps) {
  const requested = new Set(VCR_STEPS.filter((step) => steps?.[step]?.requested === true));
  const full = VCR_STEPS.every((step) => requested.has(step));
  /** @type {Set<string>} */
  const want = new Set();
  /** @param {string} step */
  const add = (step) => {
    if (want.has(step)) return;
    want.add(step);
    for (const need of /** @type {Record<string, readonly string[]>} */ (VCR_STEP_NEEDS)[step] ?? []) add(need);
  };
  for (const step of requested) add(step);
  return {
    want, requested, full,
    /** @param {string} step @returns {"full" | "minimal"} */
    fidelity: (step) => (requested.has(step) ? "full" : "minimal"),
  };
}

/**
 * The steps as the program will read them on its next tick. A study whose
 * definition exists and which nobody asked anything of is running the whole
 * programme: 「一句话到研究包」 is the default path (plan §10.3), so a study
 * created from the home page's action cards does not sit still.
 * @param {Record<string, { status: string, requested: boolean }>} steps
 */
export function vcrProgramSteps(steps) {
  /** @type {Record<string, { status: string, requested: boolean }>} */
  const out = Object.fromEntries(VCR_STEPS.map((step) => {
    const entry = steps?.[step] ?? { status: "none", requested: false };
    return [step, { ...entry, requested: entry.requested === true || entry.status === "queued" }];
  }));
  if (VCR_STEPS.some((step) => out[step].requested)) return out;
  if (FINISHED.has(out.definition.status)) for (const step of VCR_STEPS) out[step].requested = true;
  return out;
}

/** Which engine job a research object needs. Deterministic; the model never picks. */
export function vcrJobKindFor(kind, row) {
  const configured = String(object(object(row).configuration).jobKind ?? "");
  if (VCR_JOB_KINDS.includes(configured)) return configured;
  if (kind === "population") {
    if (object(row).kind === "real") return "build_cohort";
    if (object(row).kind === "empirical_synthetic") return "synthesize_population";
    return "generate_population";
  }
  if (kind === "patient_set") return "generate_patients";
  if (kind === "comparator") {
    const route = String(object(row).route);
    // A literature control has no rows to read: its deterministic work is
    // rebuilding the published curve, which is why it is the one route a T0
    // study can actually compute (plan §10.3). A model comparator predicts
    // each treated patient's counterfactual and so does need their rows.
    if (route === "literature_control") return "reconstruct_km";
    if (route === "hybrid_control") return "map_prior";
    if (route === "model_comparator") return "rmst";
    return "weight_comparator";
  }
  if (kind === "trial_scenario") return object(object(row).configuration).analytic === true ? "design_analytic" : "design_simulation";
  if (kind === "design_grid") return "design_grid";
  return "profile_snapshot";
}

export class VcrOrchestrator {
  /**
   * @param {{ store: import("./vcrStore.mjs").VcrStore, jobs: import("./vcrJobs.mjs").VcrJobs, config?: Record<string, any>,
   *   notifier?: any, seal?: any,
   *   dispatchRun?: ((input: { userId: string, projectId: string, studyId: string, capabilityId: string, dispatchId: string,
   *     reason: string, brief: string }) => Promise<{ runId: string, sessionId: string | null, status?: string | null }>) | null,
   *   latestSessionId?: ((input: { userId: string, projectId: string }) => Promise<string | null>) | null,
   *   briefFor?: ((input: { study: any, key: string, scope: string[], detail: Record<string, any>,
   *     fidelity: (step: string) => string }) => string | Promise<string>) | null,
   *   now?: () => Date, report?: (code: string) => void }} dependencies
   */
  constructor({ store, jobs, config = {}, notifier = null, seal = null, dispatchRun = null, latestSessionId = null,
    briefFor = null, now = () => new Date(), report = () => {} }) {
    if (!store) throw new TypeError("The VCR orchestrator needs the VCR store.");
    if (!jobs) throw new TypeError("The VCR orchestrator needs the VCR job queue.");
    this.store = store;
    this.jobs = jobs;
    this.config = config;
    this.notifier = notifier;
    this.seal = seal;
    this.dispatchRun = dispatchRun;
    this.latestSessionId = latestSessionId;
    this.briefFor = briefFor;
    this.now = now;
    this.report = report;
    this.owner = `vcr-${process.pid}-${randomId().slice(0, 12)}`;
    this.leaseSeconds = Math.max(60, Math.round(Number(config.vcrLeaseMs ?? 900_000) / 1000));
    /** @type {Map<string, Promise<unknown>>} one advance per study at a time, in this process */
    this.locks = new Map();
    this.counters = { ticks: 0, dispatched: 0, deferred: 0, dispatchFailed: 0, runsFinished: 0, jobsEnqueued: 0,
      jobsSkipped: 0, recomputes: 0, notices: 0, studyErrors: 0 };
    /** @type {string | null} */
    this.lastDeferral = null;
    /** @type {string | null} */
    this.lastError = null;
    /** @type {string | null} */
    this.lastTickAt = null;
  }

  status() {
    return {
      dispatch: this.dispatchRun ? "wired" : "missing",
      engine: this.jobs.engine?.configured?.() ? "wired" : "missing",
      lastTickAt: this.lastTickAt, lastDeferral: this.lastDeferral, lastError: this.lastError,
      counters: { ...this.counters },
    };
  }

  // --- the worker's cross-process lease -----------------------------------------------

  /**
   * Run `work` holding one loop's lease. A session advisory lock on its own
   * connection: another control plane, or a tick that outlived its interval
   * here, answers `{ acquired: false }` and nothing runs twice. Without a
   * database that hands out clients (a unit test's double) the work runs
   * unleased — a single-process test needs no lock.
   * @param {string} loop @param {() => Promise<unknown>} work
   */
  async leaseLoop(loop, work) {
    const database = /** @type {any} */ (this.store).database;
    if (typeof database?.withClient !== "function") return { acquired: true, value: await work() };
    return database.withClient(async (/** @type {any} */ client) => {
      const got = await client.query("SELECT pg_try_advisory_lock(hashtext($1)) AS held", [`evimed-vcr-loop:${loop}`]);
      if (got.rows[0]?.held !== true) return { acquired: false };
      try {
        return { acquired: true, value: await work() };
      } finally {
        await client.query("SELECT pg_advisory_unlock(hashtext($1))", [`evimed-vcr-loop:${loop}`]).catch(() => {});
      }
    });
  }

  // --- marks -----------------------------------------------------------------------

  /** @param {string} studyId @param {string} key */
  async #mark(studyId, key) {
    return this.store.one(`SELECT * FROM ${VCR_SCHEMA}.schedule_marks WHERE study_id = $1 AND key = $2`, [studyId, key]);
  }

  /**
   * Insert a mark unless its key exists; a `claimed` mark left stale (a
   * process that died mid-claim) is taken over. Returns the row when this
   * caller holds it.
   * @param {any} study @param {string} key @param {string} kind @param {string} state
   * @param {{ step?: string | null, jobId?: string | null, detail?: Record<string, any> }} [fields]
   */
  async #claim(study, key, kind, state, fields = {}) {
    return this.store.one(`INSERT INTO ${VCR_SCHEMA}.schedule_marks (study_id, key, user_id, kind, state, step, job_id, detail, done_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, CASE WHEN $5 IN ('done', 'failed', 'skipped') THEN now() END)
      ON CONFLICT (study_id, key) DO UPDATE SET state = EXCLUDED.state, detail = schedule_marks.detail || EXCLUDED.detail, updated_at = now()
        WHERE schedule_marks.state = 'claimed' AND schedule_marks.updated_at < now() - make_interval(mins => $9)
      RETURNING *`,
    [study.id, key, study.userId, kind, state, fields.step ?? null, fields.jobId ?? null,
      JSON.stringify(fields.detail ?? {}), VCR_RUN_RULES.staleClaimMinutes]);
  }

  /**
   * Move a mark; only out of the states given when any are.
   * @param {string} studyId @param {string} key
   * @param {{ state?: string, runId?: string | null, sessionId?: string | null, dispatchId?: string | null,
   *   jobId?: string | null, attempts?: number, detail?: Record<string, any> }} patch @param {readonly string[]} [from]
   */
  async #update(studyId, key, patch, from) {
    /** @type {string[]} */
    const sets = [];
    /** @type {unknown[]} */
    const values = [studyId, key];
    const put = (/** @type {string} */ column, /** @type {unknown} */ value, cast = "") => {
      values.push(value);
      sets.push(`${column} = $${values.length}${cast}`);
    };
    if (patch.state !== undefined) {
      put("state", patch.state);
      sets.push(`done_at = CASE WHEN $${values.length} IN ('done', 'failed', 'skipped') THEN now() ELSE NULL END`);
    }
    if (patch.runId !== undefined) put("run_id", patch.runId);
    if (patch.sessionId !== undefined) put("session_id", patch.sessionId);
    if (patch.dispatchId !== undefined) put("dispatch_id", patch.dispatchId);
    if (patch.jobId !== undefined) put("job_id", patch.jobId);
    if (patch.attempts !== undefined) put("attempts", patch.attempts);
    if (patch.detail !== undefined) { values.push(JSON.stringify(patch.detail)); sets.push(`detail = detail || $${values.length}::jsonb`); }
    let guard = "";
    if (from?.length) { values.push([...from]); guard = ` AND state = ANY($${values.length}::text[])`; }
    return this.store.one(`UPDATE ${VCR_SCHEMA}.schedule_marks SET ${[...sets, "updated_at = now()"].join(", ")}
      WHERE study_id = $1 AND key = $2${guard} RETURNING *`, values);
  }

  /** @param {string} studyId @param {() => Promise<any>} work */
  async #exclusive(studyId, work) {
    const previous = this.locks.get(studyId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    const settled = next.catch(() => {});
    this.locks.set(studyId, settled);
    try { return await next; } finally { if (this.locks.get(studyId) === settled) this.locks.delete(studyId); }
  }

  /** @param {any} study @param {string} step @param {Record<string, any>} fields */
  async #step(study, step, fields) {
    const current = object(study.steps?.[step]);
    const changed = Object.entries(fields).some(([key, value]) => (current[key] ?? null) !== (value ?? null));
    if (!changed) return study;
    return (await this.store.setStep(study.id, step, fields)) ?? study;
  }

  // --- the route hooks ---------------------------------------------------------------

  /**
   * 「让 AI 做」: the step is requested, what serves it gets a fresh try, and
   * the study is advanced now — a run dispatched at once when one can be.
   * @param {{ id: string }} user @param {{ id: string }} input @param {string} step
   */
  async runStep(user, input, step) {
    if (!VCR_STEPS.includes(step)) throw new HttpError(400, "vcr_step_invalid", `step must be one of: ${VCR_STEPS.join(", ")}.`);
    const study = await this.store.getStudy(String(user.id), String(input.id));
    if (!study) throw new HttpError(404, "vcr_study_not_found", "Study not found.");
    if (study.status !== "active") throw new HttpError(409, "vcr_study_paused", "This study is paused.");
    const status = study.steps[step]?.status ?? "none";
    const again = ["none", "failed", "stale"].includes(status);
    await this.store.setStep(study.id, step, { requested: true, ...(again ? { status: "queued" } : {}) });
    await this.#allowRetries(study, step);
    const result = await this.advance(study.id);
    return this.#answer(study, result);
  }

  /**
   * 导出: a package run asked for now, dispatched when the study's run slot is
   * free. A review is not a condition — export is never withheld for want of
   * one (§10.2, AC-21); the cover states what is reviewed and what is not.
   * @param {{ id: string }} user @param {{ id: string }} input @param {string} kind
   */
  async requestExport(user, input, kind) {
    const study = await this.store.getStudy(String(user.id), String(input.id));
    if (!study) throw new HttpError(404, "vcr_study_not_found", "Study not found.");
    if (study.status !== "active") throw new HttpError(409, "vcr_study_paused", "This study is paused.");
    const row = await this.store.createExport({ studyId: study.id, userId: study.userId, kind, cover: await this.#cover(study) });
    await this.#claim(study, `run:export:${row.id}`, "run", "pending",
      { detail: { purpose: "export", kind, exportId: row.id, requestedBy: String(user.id) } });
    const result = await this.advance(study.id);
    return { export: row, ...this.#answerShape(result) };
  }

  /**
   * The cover of a package, written from what is true right now: the review
   * state of every kind, the intended use the evidence carries, the seal's two
   * timestamps and whether anything on the page is stale (plan §8.3, §10.2).
   * @param {any} study
   */
  async #cover(study) {
    const [reviews, stale, results] = await Promise.all([
      this.store.reviews(study.id), this.store.staleMarks(study.id), this.store.results(study.id),
    ]);
    return {
      reviewed: reviews.length > 0,
      reviews: reviews.map((review) => ({ kind: review.kind, reviewer: review.reviewer, nodes: review.nodes, at: review.createdAt })),
      staleResults: stale.length,
      intendedUse: study.intendedUse,
      conclusions: [...new Set(results.map((result) => result.conclusion).filter(Boolean))],
      seal: this.seal ? await this.seal.sealState(study).catch(() => null) : null,
      preparedAt: this.now().toISOString(),
    };
  }

  /** @param {any} study @param {any} result */
  #answer(study, result) {
    return this.#answerShape(result, study);
  }

  /** @param {any} result @param {any} [study] */
  #answerShape(result, study) {
    const dispatched = object(result).dispatched;
    if (dispatched?.runId) return { sessionId: dispatched.sessionId ?? null, runId: dispatched.runId, deferred: null };
    return {
      sessionId: null, runId: null,
      deferred: object(result).deferred ?? null,
      ...(study ? { studyId: study.id } : {}),
      enqueued: list(object(result).enqueued),
    };
  }

  /** A person asking again gives the runs that serve the step two more tries. @param {any} study @param {string} step */
  async #allowRetries(study, step) {
    const key = VCR_ANALYSIS_STEPS.includes(step) ? "run:analysis" : `run:${step}`;
    await this.store.query(`UPDATE ${VCR_SCHEMA}.schedule_marks
      SET detail = detail || jsonb_build_object('allowed', attempts + $3::integer), updated_at = now()
      WHERE study_id = $1 AND key = $2 AND state IN ('failed', 'done')`, [study.id, key, VCR_RUN_RULES.attempts]);
  }

  // --- the tick ------------------------------------------------------------------------

  /** Advance every active study once. The worker's `orchestrator` loop. */
  async tick() {
    this.counters.ticks += 1;
    this.lastTickAt = this.now().toISOString();
    const studies = await this.store.activeStudies(VCR_RUN_RULES.studiesPerTick);
    let advanced = 0;
    for (const study of studies) {
      try {
        await this.advance(study.id);
        advanced += 1;
      } catch (error) {
        this.counters.studyErrors += 1;
        this.lastError = codeOf(error);
        this.report(codeOf(error));
      }
    }
    return { studies: studies.length, advanced, dispatched: this.counters.dispatched, enqueued: this.counters.jobsEnqueued };
  }

  /**
   * One pass over one study: read what the data says each step is, enqueue the
   * deterministic work whose configuration is ready, dispatch at most one run,
   * and send whatever notices are due.
   * @param {string} studyId
   */
  async advance(studyId) {
    return this.#exclusive(studyId, async () => {
      let study = await this.store.studyById(studyId);
      if (!study || study.status !== "active") return { skipped: study ? "paused" : "gone" };
      // Two passes, because what the programme wants depends on what is
      // already finished: a study whose definition has just been written is a
      // study that wants the whole programme, and reading the plan before
      // observing would leave it waiting a whole tick for something already
      // on disk.
      study = await this.#observe(study, wantedVcrSteps(vcrProgramSteps(study.steps)));
      const plan = wantedVcrSteps(vcrProgramSteps(study.steps));
      /** @type {{ dispatched: any, deferred: string | null, enqueued: string[] }} */
      const result = { dispatched: null, deferred: null, enqueued: [] };
      study = await this.#observe(study, plan);
      await this.#enqueueWork(study, plan, result);
      study = await this.#observe(study, plan);
      await this.#nextRun(study, plan, result);
      await this.#notices(study);
      return result;
    });
  }

  // --- reading the steps from the data ---------------------------------------------------

  /**
   * Each step's status, read from what is stored. Never from a run's report:
   * a run that said it was done and wrote nothing has not done it.
   * @param {any} study @param {ReturnType<typeof wantedVcrSteps>} plan
   */
  async #observe(study, plan) {
    const [definition, assumptions, population, patientSet, comparator, scenarios, protocol, stale, openJobs] = await Promise.all([
      this.store.latestDefinition(study.id),
      this.store.assumptions(study.id),
      this.store.latestPopulation(study.id),
      this.store.latestPatientSet(study.id),
      this.store.latestComparatorDesign(study.id),
      this.store.trialScenarios(study.id, 20),
      this.store.latestProtocolVersion(study.id),
      this.store.staleMarks(study.id),
      this.store.rows(`SELECT kind, state FROM ${VCR_SCHEMA}.jobs WHERE study_id = $1 AND state IN ('queued', 'running', 'awaiting_budget')`, [study.id]),
    ]);
    const assessments = Number((await this.store.one(`SELECT count(*)::integer AS n FROM ${VCR_SCHEMA}.matching_assessments
      WHERE study_id = $1`, [study.id]))?.n ?? 0);
    const staleNodes = new Set(stale.map((mark) => String(mark.node)));
    const working = new Set(openJobs.map((job) => String(job.kind)));
    const awaiting = openJobs.some((job) => String(job.state) === "awaiting_budget");
    // A step whose compute could not be queued at all — a patient-level method
    // with no snapshot grant — is a visible gap, not a step that waits for
    // ever. Its note already says what is missing (plan §10.5).
    const blocked = new Set((await this.store.rows(`SELECT step FROM ${VCR_SCHEMA}.schedule_marks
      WHERE study_id = $1 AND kind = 'job' AND state = 'skipped' AND step IS NOT NULL`, [study.id]))
      .map((row) => String(row.step)));

    /** @param {string} step @param {{ has: boolean, complete: boolean, node?: string | null, kinds?: readonly string[] }} facts */
    const statusOf = (step, facts) => {
      if (facts.node && staleNodes.has(facts.node)) return "stale";
      if (facts.complete) return plan.fidelity(step) === "minimal" && !plan.requested.has(step) ? "minimal" : "done";
      if ((facts.kinds ?? []).some((kind) => working.has(kind))) return "running";
      if (facts.has && blocked.has(step)) return "failed";
      if (facts.has) return awaiting ? "queued" : "running";
      return null;
    };

    let current = study;
    /** @type {Array<[string, { has: boolean, complete: boolean, node?: string | null, kinds?: readonly string[] }]>} */
    const facts = [
      ["definition", { has: Boolean(definition), complete: Boolean(definition) }],
      ["evidence", { has: assumptions.length > 0, complete: assumptions.length > 0 }],
      ["population", { has: Boolean(population), complete: Boolean(population?.resultId),
        node: population ? vcrObjectNode("population", population) : null,
        kinds: ["build_cohort", "generate_population", "synthesize_population"] }],
      ["patients", { has: Boolean(patientSet), complete: Boolean(patientSet?.resultId),
        node: patientSet ? vcrObjectNode("patient_set", patientSet) : null, kinds: ["generate_patients"] }],
      // 「不可估计」 is a finished result: the step is done and the study says so.
      ["comparator", { has: Boolean(comparator), complete: Boolean(comparator?.resultId || comparator?.conclusion),
        node: comparator ? vcrObjectNode("comparator", comparator) : null,
        kinds: ["weight_comparator", "rmst", "map_prior"] }],
      ["trial", { has: scenarios.length > 0, complete: scenarios.some((scenario) => Boolean(scenario.resultId)),
        node: scenarios[0] ? vcrObjectNode("trial_scenario", scenarios[0]) : null,
        kinds: ["design_analytic", "design_simulation", "design_grid", "assurance"] }],
      ["matching", { has: Boolean(protocol), complete: assessments > 0, kinds: ["match_criteria"] }],
    ];
    for (const [step, fact] of facts) {
      const status = statusOf(step, fact);
      if (!status) continue;
      const stored = current.steps[step]?.status ?? "none";
      // A step a person has not asked for and which nothing has produced stays
      // where it is: observation never invents progress.
      if (stored === status) continue;
      if (!plan.want.has(step) && !FINISHED.has(status) && status !== "stale") continue;
      current = await this.#step(current, step, { status });
    }
    return current;
  }

  // --- the deterministic half: jobs -----------------------------------------------------

  /**
   * Enqueue the compute whose configuration exists and whose result does not.
   * This is the platform owning the numbers: a run writes a design, the
   * platform runs it (attachment E §2.2), and a run that forgot to queue its
   * own simulation still gets one.
   * @param {any} study @param {ReturnType<typeof wantedVcrSteps>} plan @param {{ enqueued: string[] }} result
   */
  async #enqueueWork(study, plan, result) {
    const [definition, assumptions, population, patientSet, comparator, scenarios] = await Promise.all([
      this.store.latestDefinition(study.id), this.store.assumptions(study.id), this.store.latestPopulation(study.id),
      this.store.latestPatientSet(study.id), this.store.latestComparatorDesign(study.id), this.store.trialScenarios(study.id, 20),
    ]);
    /** @type {Array<{ step: string, kind: string, row: any }>} */
    const pending = [];
    if (population && !population.resultId && plan.want.has("population")) pending.push({ step: "population", kind: "population", row: population });
    if (patientSet && !patientSet.resultId && plan.want.has("patients")) pending.push({ step: "patients", kind: "patient_set", row: patientSet });
    if (comparator && !comparator.resultId && !comparator.conclusion && plan.want.has("comparator")) {
      pending.push({ step: "comparator", kind: "comparator", row: comparator });
    }
    if (plan.want.has("trial")) {
      for (const scenario of scenarios) if (!scenario.resultId) pending.push({ step: "trial", kind: "trial_scenario", row: scenario });
    }
    for (const item of pending) {
      const enqueued = await this.#enqueueFor(study, item, { definition, assumptions, population, comparator });
      if (enqueued) result.enqueued.push(enqueued);
    }
  }

  /**
   * One object's job. The scenario is frozen here — every assumption value,
   * every version — because re-reading them later is what makes a result
   * unreproducible (AC-04).
   * @param {any} study @param {{ step: string, kind: string, row: any }} item
   * @param {{ definition: any, assumptions: any[], population: any, comparator: any }} context
   */
  async #enqueueFor(study, item, context) {
    const node = vcrObjectNode(item.kind, item.row);
    const key = `job:${node}`;
    if (await this.#mark(study.id, key)) return null;
    const jobKind = vcrJobKindFor(item.kind, item.row);
    const inputs = this.#freeze(item, context);
    if (VCR_PATIENT_LEVEL_JOB_KINDS.includes(jobKind) && !inputs.some((input) => input.kind === "snapshot")) {
      // A patient-level method with no snapshot grant is a data gap, not a
      // failure: the step says so and the rest of the study goes on (§10.5).
      await this.#claim(study, key, "job", "skipped", { step: item.step, detail: { reason: "no_snapshot", jobKind } });
      await this.#step(study, item.step, { note: "缺少数据快照：这一步需要患者级数据的访问授权。" });
      this.counters.jobsSkipped += 1;
      return null;
    }
    const claimed = await this.#claim(study, key, "job", "claimed", { step: item.step, detail: { jobKind, node } });
    if (!claimed) return null;
    try {
      const { job } = await this.jobs.enqueue({
        studyId: study.id, userId: study.userId, kind: jobKind,
        scenario: this.#scenarioFor(item, context),
        inputs, idempotencyKey: `vcr:${study.id}:${node}`,
        // The result this job files under is the object it was queued for, not
        // a guess from the method: a literature control computed by
        // `reconstruct_km` is still the comparator's result.
        detail: { node, step: item.step, resultKind: VCR_OBJECT_RESULT_KINDS[item.kind] ?? null },
      });
      await this.#update(study.id, key, { state: "running", jobId: job.id, detail: { jobId: job.id, state: job.state } });
      await this.store.addEdges(study.id, inputs
        .filter((input) => /^[a-z_]+:[^@]+@\d+$/.test(String(input.id)))
        .map((input) => ({ from: String(input.id), to: node, cost: ["design_simulation", "design_grid", "assurance"].includes(jobKind) ? "heavy" : "light" })));
      this.counters.jobsEnqueued += 1;
      await this.#step(study, item.step, { status: job.state === "awaiting_budget" ? "queued" : "running", jobId: job.id, note: null });
      return job.id;
    } catch (error) {
      await this.#claim(study, key, "job", "failed", { step: item.step, detail: { error: codeOf(error) } });
      await this.#update(study.id, key, { state: "failed", detail: { error: codeOf(error) } });
      this.lastError = codeOf(error);
      this.report(codeOf(error));
      return null;
    }
  }

  /**
   * Everything the job froze, as engine inputs. Assumption ids carry their
   * version (`asm_x@3`), which is what the lineage edge is built from.
   * @param {{ kind: string, row: any }} item
   * @param {{ definition: any, assumptions: any[], population: any, comparator: any }} context
   */
  #freeze(item, context) {
    /** @type {Array<{ kind: string, id: string, hash?: string | null, value?: unknown, location?: string }>} */
    const inputs = [];
    const used = item.kind === "trial_scenario" && list(item.row.assumptionIds).length
      ? context.assumptions.filter((assumption) => list(item.row.assumptionIds).includes(assumption.key) || list(item.row.assumptionIds).includes(assumption.id))
      : context.assumptions;
    for (const assumption of used) {
      // An assumption's lineage identity is its **key**, not its row id: every
      // version of 「脱落率」 is a new row with a new id, and a graph keyed by
      // the row id would make each edit a node with no history — which is
      // exactly the traversal §6.3 needs to work.
      inputs.push({ kind: "assumption", id: vcrAssumptionNode(assumption.key, assumption.version), hash: null,
        value: { key: assumption.key, pointValue: assumption.pointValue, distribution: assumption.distribution, unit: assumption.unit } });
    }
    if (context.definition) {
      inputs.push({ kind: "study_definition", id: lineageNode("study_definition", context.definition.id, context.definition.version),
        hash: null, value: { estimand: context.definition.estimand, endpointType: context.definition.endpointType } });
    }
    if (item.kind !== "population" && context.population) {
      inputs.push({ kind: "population", id: lineageNode("population", context.population.id, context.population.version), hash: null,
        value: { kind: context.population.kind, counts: context.population.counts } });
    }
    if (item.kind === "trial_scenario" && context.comparator) {
      inputs.push({ kind: "comparator_design", id: lineageNode("comparator_design", context.comparator.id, context.comparator.version),
        hash: null, value: { route: context.comparator.route, estimand: context.comparator.estimand } });
    }
    const snapshotId = item.row.snapshotId ?? context.population?.snapshotId ?? object(item.row.configuration).snapshotId ?? null;
    const snapshotHash = object(item.row.configuration).snapshotHash ?? null;
    if (snapshotId) {
      inputs.push({ kind: "snapshot", id: String(snapshotId), hash: snapshotHash,
        location: String(object(item.row.configuration).snapshotLocation ?? "") || undefined });
    }
    return inputs;
  }

  /** @param {{ kind: string, row: any }} item @param {{ definition: any, comparator: any }} context */
  #scenarioFor(item, context) {
    const configuration = object(item.row.configuration);
    if (item.kind === "trial_scenario") {
      return {
        design: { kind: item.row.design, ...object(configuration.design) },
        endpoint: { type: item.row.endpointType, ...object(configuration.endpoint) },
        truth: object(configuration.truth),
        analysis: object(configuration.analysis),
        accrual: object(configuration.accrual),
        performance: list(configuration.performance),
        ...(context.comparator ? { comparator: { route: context.comparator.route, estimand: context.comparator.estimand } } : {}),
        ...(configuration.targetMcse ? { targetMcse: Number(configuration.targetMcse) } : {}),
      };
    }
    if (item.kind === "comparator") {
      return { route: item.row.route, estimand: item.row.estimand, targetTrial: object(item.row.targetTrial), ...configuration,
        endpoint: { type: context.definition?.endpointType ?? "time_to_event", ...object(configuration.endpoint) } };
    }
    if (item.kind === "population") return { populationKind: item.row.kind, definition: object(item.row.definition), ...configuration };
    return { model: item.row.modelId ?? null, modelVersion: item.row.modelVersion ?? null, ...object(item.row.scenario) };
  }

  /**
   * A job the worker finished: point the object at its result, write the
   * lineage edge, clear the stale mark the recompute left, and let the step
   * status follow from the data on the next pass.
   * @param {{ job: any, result: any }} outcome
   */
  async onJobFinished({ job, result }) {
    if (!job) return false;
    const mark = await this.store.one(`SELECT * FROM ${VCR_SCHEMA}.schedule_marks
      WHERE study_id = $1 AND kind = 'job' AND job_id = $2`, [job.studyId, job.id]);
    const node = String(object(mark?.detail).node ?? "");
    if (result && node) {
      const [kind, rest] = [node.slice(0, node.indexOf(":")), node.slice(node.indexOf(":") + 1)];
      const id = rest.slice(0, rest.lastIndexOf("@"));
      const table = { population: "populations", patient_set: "patient_sets", comparator_design: "comparator_designs",
        trial_scenario: "trial_scenarios" }[kind];
      if (table) {
        await this.store.attachResult(table, id, result.id,
          table === "comparator_designs" ? { conclusion: result.conclusion, gapList: list(object(result.diagnostics).gaps) } : {});
      }
      await this.store.addEdges(job.studyId, [{ from: node, to: lineageNode("result", result.id, result.version), cost: "light" }]);
      await this.store.clearStale(job.studyId, [node]);
    }
    if (mark) {
      await this.#update(job.studyId, String(mark.key), {
        state: job.state === "succeeded" ? "done" : job.state === "canceled" ? "skipped" : "failed",
        detail: { jobState: job.state, resultId: result?.id ?? null },
      });
    }
    await this.advance(job.studyId);
    return true;
  }

  // --- the thinking half: one run ---------------------------------------------------------

  /** @param {any} study @param {ReturnType<typeof wantedVcrSteps>} plan @param {{ dispatched: any, deferred: string | null }} result */
  async #nextRun(study, plan, result) {
    if (!this.dispatchRun) return;
    const active = (await this.store.rows(`SELECT 1 FROM ${VCR_SCHEMA}.schedule_marks
      WHERE study_id = $1 AND kind = 'run' AND state IN ('claimed', 'running') LIMIT 1`, [study.id])).length > 0;
    if (active) return;
    const candidates = [
      () => this.#pendingExport(study),
      () => this.#stepRun(study, plan, "definition"),
      () => this.#stepRun(study, plan, "evidence"),
      () => this.#analysisRun(study, plan),
      () => this.#stepRun(study, plan, "matching"),
    ];
    for (const candidate of candidates) {
      const spec = await candidate();
      if (!spec) continue;
      const outcome = await this.#dispatch(study, spec);
      if (outcome.dispatched) result.dispatched = outcome.dispatched;
      if (outcome.deferred) result.deferred = outcome.deferred;
      if (outcome.dispatched || outcome.deferred || outcome.busy) return;
    }
  }

  /** @typedef {{ key: string, purpose: string, capabilityId: string, reason: string, brief: string, steps: string[], detail?: Record<string, any> }} VcrRunSpec */

  /** Whether a run key may be tried again. @param {any} mark */
  #allowed(mark) {
    if (!mark) return true;
    if (["claimed", "running"].includes(String(mark.state))) return false;
    return Number(mark.attempts ?? 0) < Number(object(mark.detail).allowed ?? VCR_RUN_RULES.attempts);
  }

  /** @param {any} study @returns {Promise<VcrRunSpec | null>} */
  async #pendingExport(study) {
    const mark = await this.store.one(`SELECT * FROM ${VCR_SCHEMA}.schedule_marks WHERE study_id = $1 AND kind = 'run'
      AND starts_with(key, 'run:export:') AND state = 'pending' ORDER BY created_at LIMIT 1`, [study.id]);
    if (!mark || !this.#allowed(mark)) return null;
    const detail = object(mark.detail);
    return {
      key: String(mark.key), purpose: "export", capabilityId: "vcr-package", reason: `vcr:export-${detail.kind ?? "study_package"}`,
      brief: await this.#brief(study, String(mark.key), [], { kind: detail.kind, exportId: detail.exportId }),
      steps: [], detail: { kind: detail.kind, exportId: detail.exportId },
    };
  }

  /** @param {any} study @param {ReturnType<typeof wantedVcrSteps>} plan @param {string} step @returns {Promise<VcrRunSpec | null>} */
  async #stepRun(study, plan, step) {
    if (!plan.want.has(step)) return null;
    const status = study.steps[step]?.status ?? "none";
    const wanted = ["none", "queued", "failed", "stale"].includes(status)
      || (status === "minimal" && plan.requested.has(step));
    if (!wanted) return null;
    const key = `run:${step}`;
    if (!this.#allowed(await this.#mark(study.id, key))) return null;
    return {
      key, purpose: step, capabilityId: /** @type {Record<string, string>} */ (VCR_STEP_CAPABILITIES)[step],
      reason: `vcr:${step}`,
      brief: await this.#brief(study, key, [step], { fidelity: plan.fidelity(step) }),
      steps: [step], detail: { scope: [{ step, fidelity: plan.fidelity(step) }] },
    };
  }

  /**
   * The four analysis steps in one run (plan §10.3's timeline is one
   * continuous stretch of work): the run writes each object and the platform
   * computes it, so the run's own order follows a real data dependency, never
   * a staged workflow (principle 12).
   * @param {any} study @param {ReturnType<typeof wantedVcrSteps>} plan @returns {Promise<VcrRunSpec | null>}
   */
  async #analysisRun(study, plan) {
    const scope = VCR_ANALYSIS_STEPS.filter((step) => {
      if (!plan.want.has(step)) return false;
      const status = study.steps[step]?.status ?? "none";
      if (["none", "queued", "failed", "stale"].includes(status)) return true;
      return status === "minimal" && plan.requested.has(step);
    }).map((step) => ({ step, fidelity: plan.fidelity(step) }));
    if (!scope.length) return null;
    // A step whose compute is already out does not need a run to write it again.
    const working = await this.store.rows(`SELECT 1 FROM ${VCR_SCHEMA}.jobs WHERE study_id = $1
      AND state IN ('queued', 'running') LIMIT 1`, [study.id]);
    const waiting = scope.every((entry) => (study.steps[entry.step]?.status ?? "none") === "running");
    if (working.length && waiting) return null;
    const key = "run:analysis";
    if (!this.#allowed(await this.#mark(study.id, key))) return null;
    return {
      key, purpose: "analysis", capabilityId: VCR_STEP_CAPABILITIES.population, reason: `vcr:${scope[0].step}`,
      brief: await this.#brief(study, key, scope.map((entry) => entry.step), { scope }),
      steps: scope.map((entry) => entry.step), detail: { scope },
    };
  }

  /**
   * What the run is told. A brief is text, injected by whoever composes the
   * module (so it stays editable prose, never a control flow — principle 7);
   * without one the run gets the study's own question and the steps asked of
   * it, which is enough for a capability whose SKILL.md carries the method.
   * @param {any} study @param {string} key @param {string[]} scope @param {Record<string, any>} detail
   */
  async #brief(study, key, scope, detail) {
    if (this.briefFor) {
      const custom = await this.briefFor({ study, key, scope, detail, fidelity: (/** @type {string} */ step) => (scope.includes(step) ? "full" : "minimal") });
      if (custom) return String(custom);
    }
    const steps = scope.length ? `本次要做的步骤：${scope.join("、")}。` : "";
    const minimal = object(detail).fidelity === "minimal" ? "上游缺的部分先补一个最小版本，并标明「AI 设定」。" : "";
    return [
      `研究：${study.name}。`,
      study.question ? `研究问题：${study.question}` : "",
      `数据档位：${study.dataTier}；预期用途：${study.intendedUse}。`,
      steps, minimal,
      "用 vcr_read 读研究已有的定义、假设与结果；用 vcr_write 写定义、条件、假设、设计与决策；确定性计算一律用 vcr_simulate 排作业，不要自己算数。",
    ].filter(Boolean).join("\n");
  }

  /**
   * Claim the run slot and the key, dispatch, record. A refusal that waiting
   * can clear leaves the key pending; one that cannot fails the steps it would
   * have served.
   * @param {any} study @param {VcrRunSpec} spec
   */
  async #dispatch(study, spec) {
    const claim = await this.store.transaction(async (/** @type {any} */ client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('evimed-vcr-run:' || $1))", [study.id]);
      const status = await client.query(`SELECT status FROM ${VCR_SCHEMA}.studies WHERE id = $1 AND deleted_at IS NULL FOR SHARE`, [study.id]);
      if (status.rows[0]?.status !== "active") return { busy: true };
      const active = await client.query(`SELECT key FROM ${VCR_SCHEMA}.schedule_marks WHERE study_id = $1 AND kind = 'run'
        AND (state = 'running' OR (state = 'claimed' AND updated_at > now() - make_interval(mins => $2))) LIMIT 1`,
      [study.id, VCR_RUN_RULES.staleClaimMinutes]);
      if (active.rows.length) return { busy: true };
      const existing = (await client.query(`SELECT * FROM ${VCR_SCHEMA}.schedule_marks WHERE study_id = $1 AND key = $2 FOR UPDATE`,
        [study.id, spec.key])).rows[0];
      if (existing && !this.#allowed(existing)) return { busy: true };
      const attempts = Number(existing?.attempts ?? 0);
      const reuse = existing && ["pending", "claimed"].includes(String(existing.state)) && existing.dispatch_id;
      const dispatchId = reuse ? String(existing.dispatch_id) : vcrDispatchId(spec.key, attempts + 1);
      const detail = { ...object(spec.detail), purpose: spec.purpose, capabilityId: spec.capabilityId };
      const row = (await client.query(`INSERT INTO ${VCR_SCHEMA}.schedule_marks (study_id, key, user_id, kind, state, dispatch_id, detail)
        VALUES ($1, $2, $3, 'run', 'claimed', $4, $5::jsonb)
        ON CONFLICT (study_id, key) DO UPDATE SET state = 'claimed', dispatch_id = EXCLUDED.dispatch_id,
          detail = schedule_marks.detail || EXCLUDED.detail, run_id = NULL, session_id = NULL, done_at = NULL, updated_at = now()
        RETURNING *`, [study.id, spec.key, study.userId, dispatchId, JSON.stringify(detail)])).rows[0];
      return { mark: row };
    });
    if (claim.busy) return { busy: true };
    const mark = claim.mark;
    let current = study;
    for (const step of spec.steps) {
      if ((current.steps[step]?.status ?? "none") !== "running") current = await this.#step(current, step, { status: "queued" });
    }
    try {
      const out = await /** @type {NonNullable<VcrOrchestrator["dispatchRun"]>} */ (this.dispatchRun)({
        userId: study.userId, projectId: study.projectId, studyId: study.id, capabilityId: spec.capabilityId,
        dispatchId: String(mark.dispatch_id), reason: spec.reason, brief: spec.brief,
      });
      const running = await this.#update(study.id, spec.key, {
        state: "running", runId: String(out.runId), sessionId: out.sessionId ?? null, attempts: Number(mark.attempts ?? 0) + 1,
      }, ["claimed"]);
      for (const step of spec.steps) current = await this.#step(current, step, { status: "running", runId: String(out.runId) });
      this.counters.dispatched += 1;
      if (running && out.status && TERMINAL_RUN.has(String(out.status))) await this.#finishRun(current, running, String(out.status));
      return { dispatched: { runId: String(out.runId), sessionId: out.sessionId ?? null } };
    } catch (error) {
      const code = codeOf(error);
      if (TERMINAL_DISPATCH.has(code)) {
        await this.#update(study.id, spec.key, { state: "failed", detail: { lastError: code, allowed: Number(mark.attempts ?? 0) } }, ["claimed"]);
        for (const step of spec.steps) current = await this.#step(current, step, { status: "failed" });
        this.counters.dispatchFailed += 1;
        this.lastError = code;
        return { failed: code };
      }
      await this.#update(study.id, spec.key, { state: "pending", detail: { lastError: code } }, ["claimed"]);
      this.counters.deferred += 1;
      this.lastDeferral = code;
      return { deferred: code };
    }
  }

  /**
   * The run ledger's completion, for every run of the platform: a run this
   * module dispatched (`vcr-…`) is folded into its steps.
   * @param {{ userId: string, id: string }} controlProject @param {{ id: string, dispatchId?: string | null, status: string }} run
   */
  async onRunFinished(controlProject, run) {
    if (!String(run?.dispatchId ?? "").startsWith("vcr-") || !TERMINAL_RUN.has(String(run.status))) return false;
    const row = await this.store.one(`SELECT m.* FROM ${VCR_SCHEMA}.schedule_marks m
      JOIN ${VCR_SCHEMA}.studies s ON s.id = m.study_id
      WHERE s.user_id = $1 AND s.project_id = $2 AND s.deleted_at IS NULL AND m.kind = 'run' AND m.dispatch_id = $3`,
    [String(controlProject.userId), String(controlProject.id), String(run.dispatchId)]);
    if (!row || ["done", "failed"].includes(String(row.state))) return false;
    await this.#exclusive(String(row.study_id), async () => {
      const study = await this.store.studyById(String(row.study_id));
      if (study) await this.#finishRun(study, { ...row, run_id: row.run_id ?? run.id }, String(run.status));
    });
    await this.advance(String(row.study_id));
    return true;
  }

  /** @param {any} study @param {any} mark @param {string} status */
  async #finishRun(study, mark, status) {
    const moved = await this.#update(study.id, String(mark.key), {
      state: status === "succeeded" ? "done" : "failed", detail: { runStatus: status },
    }, ["claimed", "running", "pending"]);
    if (!moved) return;
    this.counters.runsFinished += 1;
    const detail = object(mark.detail);
    if (detail.purpose === "export" && detail.exportId) {
      // The cover is merged, never replaced: the run wrote its rendered report
      // into this row while it worked, and the cover the platform adds is the
      // review state, the stale results and the seal — two writers, one row.
      const existing = (await this.store.exports(study.id)).find((row2) => row2.id === String(detail.exportId));
      const cover = { ...(existing?.cover ?? {}), ...(await this.#cover(study)) };
      const row = await this.store.updateExport(String(detail.exportId), {
        state: status === "succeeded" ? "ready" : "failed", runId: mark.run_id ?? null, cover,
      });
      if (row?.state === "ready" && this.notifier?.packageReady) {
        await this.#notice(study, `notice:package:${row.id}`, () => this.notifier.packageReady(study, {
          exportId: row.id, kind: row.kind, headline: object(cover).headline ?? null, gaps: Number(object(cover).staleResults ?? 0),
        }));
      }
      return;
    }
    // Everything else is read from the data on the next pass: a failed run
    // that wrote its object still counts, and a finished run that wrote
    // nothing leaves its step where it was for a person to ask again.
    const plan = wantedVcrSteps(vcrProgramSteps(study.steps));
    const observed = await this.#observe(study, plan);
    for (const entry of list(detail.scope)) {
      const step = String(object(entry).step ?? entry);
      if (!VCR_STEPS.includes(step)) continue;
      const now = observed.steps[step]?.status ?? "none";
      if (FINISHED.has(now) || now === "running") continue;
      if (status !== "succeeded") await this.#step(observed, step, { status: "failed" });
    }
  }

  // --- change propagation (plan §6.3) --------------------------------------------------

  /**
   * Something changed: work out what it makes stale, mark all of it with the
   * reason, recompute the light half now and queue the heavy half. Stale
   * results are never deleted or hidden (AC-16) — the page greys them and says
   * why, and a study package either recomputes them or says so on its cover.
   *
   * @param {{ studyId: string, changed: readonly string[], reason: string, detail?: Record<string, any> }} input
   */
  async recomputeAfterChange({ studyId, changed, reason, detail = {} }) {
    if (!VCR_STALE_REASONS.includes(reason)) throw new TypeError(`recomputeAfterChange: unknown reason ${JSON.stringify(reason)}`);
    const study = await this.store.studyById(studyId);
    if (!study) return { light: [], heavy: [], marked: 0 };
    const edges = await this.store.edges(studyId);
    const plan = recomputePlan({ edges, changed: [...vcrSupersededNodes(edges, changed)], reason });
    if (!plan.all.length) return { light: [], heavy: [], marked: 0, reason };
    await this.store.markStale(studyId, plan.all, reason, { ...detail, changed: [...changed] });
    this.counters.recomputes += 1;
    // A node whose object still exists is re-enqueued by the next pass (its
    // `result_id` is what `#observe` reads, and the stale mark is what makes
    // the step read `stale` until a new result supersedes it). The heavy ones
    // reach the queue the same way and stop at `awaiting_budget` if the
    // study's compute budget cannot carry them — the second human stop.
    for (const node of plan.all) {
      await this.#claim(study, `recompute:${node}`, "recompute", "pending", { detail: { reason } });
      await this.store.query(`DELETE FROM ${VCR_SCHEMA}.schedule_marks WHERE study_id = $1 AND key = $2`, [studyId, `job:${node}`]);
    }
    await this.advance(studyId);
    return { ...plan, marked: plan.all.length };
  }

  // --- notices (plan §10.4) --------------------------------------------------------------

  /**
   * Send a notice once per key: the mark is written only when the inbox took
   * it, so an inbox that was down is tried again.
   * @param {any} study @param {string} key @param {() => Promise<any> | undefined} send
   */
  async #notice(study, key, send) {
    if (!this.notifier || (await this.#mark(study.id, key))) return false;
    const sent = await send();
    if (!sent) return false;
    await this.#claim(study, key, "notice", "done", { detail: {} });
    this.counters.notices += 1;
    return true;
  }

  /** @param {any} study */
  async #notices(study) {
    if (!this.notifier) return;
    const results = await this.store.results(study.id);
    for (const result of results.filter((row) => row.conclusion === "not_estimable").slice(0, VCR_RUN_RULES.noticesPerTick)) {
      await this.#notice(study, `notice:not-estimable:${result.id}`, () => this.notifier.notEstimable?.(study, {
        resultId: result.id, rule: result.notEstimableRule,
        what: result.kind === "comparator" ? "对照分析" : result.kind === "trial_scenario" ? "试验仿真" : "分析",
        gaps: list(object(result.diagnostics).gaps).map(String),
      }));
    }
    const tolerance = Number(object(study.budget).accrualTolerance ?? VCR_ACCRUAL_TOLERANCE);
    for (const forecast of (await this.store.forecasts(study.id)).filter((row) => row.actual && row.comparedAt)) {
      const predicted = Number(object(forecast.prediction).enrolled ?? object(forecast.prediction).value);
      const actual = Number(object(forecast.actual).enrolled ?? object(forecast.actual).value);
      if (!Number.isFinite(predicted) || !Number.isFinite(actual) || predicted <= 0) continue;
      if (Math.abs(actual - predicted) / predicted <= tolerance) continue;
      await this.#notice(study, `notice:accrual:${forecast.id}:${forecast.comparedAt}`, () => this.notifier.accrualOffForecast?.(study, {
        forecastId: forecast.id, predicted, actual, byMonth: object(forecast.actual).asOf ?? null,
      }));
    }
  }
}
