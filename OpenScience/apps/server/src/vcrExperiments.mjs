/**
 * 「虚拟实验室」's experiments and design-search campaigns (plan T09, T10): persisted, advanced one unit at a time through the existing
 * job queue, and read back as the page and the conversation see them.
 *
 *   design experiment — named arms of existing design methods (or saved results attached by id, never rerun) over one frozen
 *                       endpoint and analysis, compared measure by measure against a reference arm
 *   campaign          — a frozen search manifest (`@evimed/domain` vcrExperimentSearch): analytic pre-check, screening, finalists
 *                       re-evaluated at the method's floor on independent streams, one stop reason
 *
 * Hidden knowledge:
 *
 * - **No second scheduler.** A campaign has at most one unit in flight. The next unit is decided under the row's lock, written down
 *   (`state.inFlight`, with its deterministic idempotency key) and only then enqueued; the job's finish hook (`'experiments'`, the
 *   jobs queue's durable hook, retried and reconciled by the completion loop) records it and decides the next. A crash between the
 *   decision and the enqueue leaves a decided unit with no job: `repair()` (run by the completion loop) enqueues it again under the
 *   same key, which the queue deduplicates, so a restart never runs a finished unit again and never charges twice.
 * - **The engine's global concurrency is untouched.** Units are ordinary jobs: the queue claims them like any other, under the
 *   study's CPU budget (a unit beyond it waits `awaiting_budget` like any job). Each unit's CPU ceiling is what the campaign's own
 *   budget has left, never more than the deployment's per-job ceiling.
 * - **Results are filed out of every card's way.** A unit's result is kind `experiment_candidate` under the subject
 *   `<campaign>:<unit>`, so a screening run never supersedes or decorates a design card and no two units share a subject.
 * - **A refusal is a candidate's outcome, not the campaign's.** A unit the job queue refuses on its scenario (an unsupported design,
 *   a value out of range) marks that candidate unsupported and the campaign goes on; an infrastructure failure (the queue or the
 *   database) leaves the decided unit for `repair()`.
 * - **The model proposes and reads; code decides.** Nothing here interprets text. The view's sentences are fixed Chinese words for
 *   closed codes; every number is the engine's, judged by the domain's bounds.
 * - **An experiment attaches designs, never people** (review eng P0-1). A saved result joins an experiment only when it is a design's
 *   (`VCR_EXPERIMENT_ATTACHABLE_KINDS`) and was computed at its method's normal precision: a population, a matching or a data profile
 *   holds head counts the comparison would hand on as numbers, and a campaign's screening run is not a result (stats P2-5). Every
 *   compared value keeps its measure's name, so the model boundary's by-name rule can judge it.
 * - **A comparison may run every arm on one record of virtual people** (plan R23). The record is made once by the engine's `instantiate` step
 *   (`instantiatePeople`, `vcrPeople.mjs`) and filed in the data plane with its hash; a disease experiment that names it (`people: { recordId,
 *   mode }`) hands the same table to every arm's job as an input and gives every arm the same seed, so the same people, the same dropout times
 *   and the same residual draws stand in each arm by construction. `paired_counterfactual` runs every person under the arm (a per-person contrast,
 *   model-implied); `resampled_trials` draws each simulated trial's people from the record. The record is checked when the comparison starts, so
 *   an unknown or foreign id is refused by name and nothing is frozen; a record made for an earlier parameter file still runs and says so.
 * - **A cancelled unit stops its campaign** (review eng P1-2). Whoever cancelled it — the campaign's own cancel, the study's 「停止」,
 *   a job cancel from a run or the page — the campaign stops with `user_cancellation` once the unit is recorded; it never moves on
 *   to the next candidate, and the cancelled unit is not a model failure. A decided unit that has no job yet when a cancel arrives is
 *   never started.
 *
 * @module vcrExperiments
 */

import { createHash } from "node:crypto";
import {
  VCR_ENGINE_METHODS, VCR_CAMPAIGN_METHODS, VCR_JOB_METHODS, vcrCampaignAdvance, vcrCampaignCandidates, vcrCampaignCanonical,
  vcrCampaignInitialState, vcrCampaignFromInput, vcrCampaignRecord, vcrCampaignVerdict, vcrCampaignDrawKey, vcrCampaignSeed, vcrCandidateVerdicts,
  vcrDesignExperiment, vcrDesignExperimentCanonical, vcrDiseaseHypothesis, vcrEvaluationContrast, vcrEvaluationMeasure, vcrExperimentAlignment,
  VCR_DISEASE_EXPERIMENT_ALIGNED_FIELDS, vcrEvaluationAllowed,
} from "@evimed/domain";
import { HttpError } from "./security.mjs";
import { finishPremises } from "./vcrPremises.mjs";
import { ALZHEIMER_PARAMETERS_TEXT, ALZHEIMER_REGULATORY_TEXT, ALZHEIMER_REPRODUCTION_TEXT, alzheimerScopeText } from "./vcrProgression.mjs";
import { measureLabel, measureValue } from "./vcrViewsKit.mjs";
import { VCR_PEOPLE_TABLE, vcrPeopleInstantiateRequest, vcrPeopleRecordView, vcrPeopleStartBinding } from "./vcrPeople.mjs";
import { vcrPopulationGenerationInput } from "./vcrSubjects.mjs";

const SCHEMA = "evimed_vcr";
/**
 * The saved results an experiment may attach: what a design states about itself (trial scenarios, grids, the confirmatory, dose,
 * Bayesian and win-ratio designs, the disease-response trial, and a campaign's final evaluations). None counts a study's people.
 */
export const VCR_EXPERIMENT_ATTACHABLE_KINDS = Object.freeze(["trial_scenario", "design_grid", "design_confirmatory", "design_dose", "design_bayesian",
  "design_win_ratio", "progression_simulation", "experiment_candidate"]);
const TERMINAL = new Set(["succeeded", "failed", "canceled"]);
/** @param {unknown} value @returns {Record<string, any>} */
const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {});
/** @param {unknown} value @returns {any[]} */
const list = (value) => (Array.isArray(value) ? value : []);
/** @param {string} text */
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
/** @param {unknown} value */
const iso = (value) => (value instanceof Date ? value.toISOString() : value == null ? null : String(value));
/** @param {unknown} a @param {unknown} b */
const seconds = (a, b) => (a && b ? Math.max(0, (new Date(String(b)).getTime() - new Date(String(a)).getTime()) / 1000) : 0);

/** What a person reads for each closed code. */
export const VCR_CAMPAIGN_STOP_TEXT_ZH = Object.freeze({
  budget_exhausted: "计算预算已用完；已完成的方案保留。",
  acceptable_precision: "找到了在预先设定的约束下全部满足的方案，并已另做一批独立模拟、按正常次数复核。",
  no_useful_improvement: "有满足约束的方案，但比参照方案的改进小于预先设定的最小改进。",
  unsupported_candidate: "要比较的方案都无法用所选方法计算。",
  persistent_model_failure: "计算连续失败，已停止，未完成的方案没有结果。",
  user_cancellation: "已按要求停止，已完成的方案保留。",
  no_feasible_beneficial_candidate: "没有找到在预先设定的约束下可行且优于参照的方案。",
  // no finalist failed a constraint, but at least one could not be decided at the precision used: never worded as “no feasible design”
  // what would decide it differs by constraint (more replicates, or none at all), so the one sentence here says only what happened;
  // the advice is `undecided.advice` of the campaign view, from each undecided constraint's `needed`
  inconclusive_at_precision: "没有方案被确认不满足约束，但有方案在现有复核次数下无法确定是否满足。",
  // the study was paused, archived or deleted while the campaign ran: its next unit cannot be queued, so the campaign ends here
  study_unavailable: "研究已暂停、归档或删除，计算已停止；已完成的方案保留。",
});
export const VCR_CANDIDATE_STATUS_TEXT_ZH = Object.freeze({
  pending: "待评估", screened: "已初筛", finalist: "入围复核", evaluated: "已复核", eliminated: "已排除", failed: "计算失败", unsupported: "无法计算",
});
export const VCR_CONSTRAINT_STATUS_TEXT_ZH = Object.freeze({ pass: "满足", fail: "不满足", inconclusive: "无法确定", not_judged: "未判断" });
const CONSTRAINT_KIND_TEXT_ZH = Object.freeze({ error_control: "错误率控制", design: "设计要求", safety: "安全性" });
const COUPLING_TEXT_ZH = Object.freeze({
  paired: "同一批模拟患者上的配对比较", independent: "独立随机数上的比较", exact: "精确计算的差", same_seed_different_draws: "随机数不一致，不给出差值的误差",
  paired_without_replicates: "配对，但这个指标没有逐次结果，不给出误差", unavailable: "缺少这个指标",
  unknown_dependence: "两次计算用的随机数不明，不给出差值的误差", reference_unavailable: "对照方案没有算出结果，这一项没有比较",
});

/**
 * Why a candidate was set aside, in a sentence, for the closed reason codes; anything else reads as a plain failure.
 * @param {string | null} reason
 */
function reasonText(reason) {
  if (!reason) return null;
  if (reason.startsWith("screening_violates:")) return `初筛时${measureLabel(reason.slice(19))}已明显不满足约束（最有利的界值也不满足）。`;
  if (reason.startsWith("analytic_below:")) return `解析计算表明样本量低于达到目标所需（${measureLabel(reason.slice(15))}），未进入模拟。`;
  if (reason === "analytic_check_failed") return "解析预检没有算出结果，未进入模拟。";
  if (reason === "cpu_budget_exhausted") return "这次计算用完了分到的计算预算，只保留了已完成的部分。";
  return "这个方案的计算没有成功。";
}

/** The sentences a person reads for the codes a refused arm carries; any other code reads as the general one. */
const REFUSED_TEXT_ZH = Object.freeze({
  invalid_parameters: "这一组的参数不合法，无法计算。", units_not_convertible: "这一组里有单位无法换算，无法计算。",
  experiment_result_kind_unsupported: "这个已保存的结果不能放进实验比较。", experiment_result_screening: "初筛的结果不能放进实验比较。",
  experiment_measure_unsupported: "这个指标不能用于实验比较。",
});
const REFUSED_FALLBACK_ZH = "这一组的设置无法用所选方法计算。";
/** @param {unknown} codes @returns {string[]} */
export const refusedText = (codes) => [...new Set(list(codes).map((code) => /** @type {Record<string, string>} */ (REFUSED_TEXT_ZH)[String(code)] ?? REFUSED_FALLBACK_ZH))];

export class VcrExperiments {
  /**
   * @param {{ store: any, jobs: any, config?: Record<string, any>, now?: () => Date, report?: (code: string) => void }} dependencies
   */
  constructor({ store, jobs, config = {}, now = () => new Date(), report = () => {} }) {
    if (!store) throw new TypeError("Experiments need the VCR store.");
    this.store = store;
    this.jobs = jobs;
    this.config = config;
    this.now = now;
    this.report = report;
    this.counters = { campaigns: 0, experiments: 0, units: 0, unsupported: 0, repaired: 0, stopped: 0, enqueueFailed: 0, orphansCanceled: 0 };
    if (jobs?.addFinishHook) jobs.addFinishHook((/** @type {any} */ outcome) => this.onJobFinished(outcome), "experiments");
  }

  /** The deployment's per-job CPU ceiling. */
  get #jobCeiling() { return Math.max(1, Number(this.jobs?.jobCpuSeconds ?? this.config.vcrJobCpuSeconds ?? 600)); }

  // --- campaigns ------------------------------------------------------------------------------------------------------------

  /**
   * Freeze a campaign and start it. The same manifest in the same study is the same campaign: the existing row is returned.
   * @param {{ id: string, userId: string }} study @param {unknown} input @param {{ userId: string, origin?: Record<string, any> | null }} who
   */
  async startCampaign(study, input, { userId, origin = null }) {
    const { manifest, issues } = vcrCampaignFromInput(input);
    if (!manifest) throw invalid("vcr_campaign_invalid", "实验方案不完整或不允许：", issues);
    // a search ranks candidates by power and type I error; an effect stated as a distribution reports an assurance, and a record of people is an
    // input a unit's job would not carry: both are comparisons' (startExperiment), and refused here by name instead of searched on nothing
    const unsupported = campaignScenarioIssues(manifest);
    if (unsupported.length) throw invalid("vcr_campaign_invalid", "实验方案不完整或不允许：", unsupported);
    const identity = sha256(vcrCampaignCanonical(manifest));
    const id = `cmp_${sha256(`${study.id}:${identity}`).slice(0, 24)}`;
    const inserted = await this.store.one(`INSERT INTO ${SCHEMA}.experiments (id, study_id, user_id, kind, identity, manifest, state, origin)
      VALUES ($1, $2, $3, 'campaign', $4, $5::jsonb, $6::jsonb, $7::jsonb) ON CONFLICT (study_id, kind, identity) DO NOTHING RETURNING id`,
    [id, study.id, String(userId), identity, JSON.stringify(manifest), JSON.stringify(vcrCampaignInitialState(manifest)), JSON.stringify(originOf(origin))]);
    if (inserted) this.counters.campaigns += 1;
    await this.advance(study.id, id);
    return { created: Boolean(inserted), ...(await this.view(study, id)) };
  }

  /**
   * Decide and enqueue the next unit of a campaign, recording inline the units the queue refuses, until a unit is in flight or the
   * campaign stops. Bounded: a campaign of refusals is at most its candidates' units.
   * @param {string} studyId @param {string} id
   */
  async advance(studyId, id) {
    for (let step = 0; step < 2_000; step++) {
      const decided = await this.store.transaction(async (/** @type {any} */ client) => {
        const row = (await client.query(`SELECT * FROM ${SCHEMA}.experiments WHERE id = $1 AND study_id = $2 FOR UPDATE`, [id, studyId])).rows[0];
        if (!row || row.kind !== "campaign" || row.status !== "running") return null;
        let state = object(row.state);
        if (state.inFlight?.jobId) return null;
        // a decided unit with no job is enqueued again, unless the campaign was cancelled meanwhile: then it is never started (review eng P2-2)
        if (state.inFlight && state.cancelRequested !== true) return { row, unit: state.inFlight.unit, state };
        if (state.inFlight) state = { ...state, inFlight: null };
        const { state: next, action } = vcrCampaignAdvance(row.manifest, state, { identity: row.identity });
        if (action.type === "evaluate") {
          next.inFlight = { unitKey: action.unit.key, unit: action.unit, jobId: null, decidedAt: this.now().toISOString() };
          await save(client, row, next, "running");
          return { row, unit: action.unit, state: next };
        }
        if (action.type === "stop" || next.stop) {
          next.stop = { ...object(next.stop), at: this.now().toISOString() };
          await save(client, row, next, "stopped");
          this.counters.stopped += 1;
        }
        return null;
      });
      if (!decided) return;
      const { row, unit, state } = decided;
      let job;
      try {
        job = (await this.jobs.enqueue({
          studyId, userId: String(row.user_id), kind: unit.kind, scenario: unit.scenario, inputs: [], seed: unit.seed,
          replicates: unit.replicates ?? null, idempotencyKey: unit.idempotencyKey, internal: true,
          cpuSecondsLimit: Math.max(1, Math.min(this.#jobCeiling, Math.ceil(Number(row.manifest.budget.cpuSeconds) - Number(object(state.usage).cpuSeconds ?? 0)))),
          detail: { resultKind: "experiment_candidate", subjectId: `${id}:${unit.key}`.slice(0, 120), experiment: { id, unitKey: unit.key } },
        })).job;
      } catch (error) {
        const status = Number(/** @type {any} */ (error)?.status);
        if (status === 400) {
          // refused on its scenario: this candidate cannot be computed by the method, and the campaign goes on
          this.counters.unsupported += 1;
          const codes = list(/** @type {any} */ (error)?.issues).map((issue) => String(object(issue).code)).filter(Boolean);
          await this.#settleOutcome(studyId, id, unit.key, null, { jobId: null, state: "failed", unsupported: true,
            issues: codes.length ? codes : [String(/** @type {any} */ (error)?.code ?? "candidate_unsupported")] });
          continue;
        }
        const code = String(/** @type {any} */ (error)?.code ?? "");
        if ((status === 404 && code === "vcr_study_not_found") || (status === 409 && code === "vcr_study_paused")) {
          // the study will not take this unit now or on any later tick: stop with a closed reason instead of retrying it forever
          await this.store.transaction(async (/** @type {any} */ client) => {
            const held = (await client.query(`SELECT * FROM ${SCHEMA}.experiments WHERE id = $1 AND study_id = $2 FOR UPDATE`, [id, studyId])).rows[0];
            if (!held || held.status !== "running") return;
            await save(client, held, { ...object(held.state), inFlight: null, stop: { reason: "study_unavailable", verdict: null, at: this.now().toISOString() } }, "stopped");
          });
          this.counters.stopped += 1;
          return;
        }
        this.counters.enqueueFailed += 1;
        this.report(code || "vcr_experiment_enqueue_failed");
        return;
      }
      this.counters.units += 1;
      // The job is attached only if this unit is still the one in flight and has no job. A cancel that raced past the enqueue has
      // cleared the flight and stopped the campaign: the job it returned belongs to nobody, so it is cancelled here (F03).
      const link = await this.#link(studyId, id, unit, job);
      if (link === "lost" || link === "linked_canceled") { await this.#cancelOrphan(studyId, job); return; }
      // a unit deduplicated onto a job that already ended (a restart after the job finished) is recorded now
      if (TERMINAL.has(String(job.state))) { await this.#settle(studyId, id, unit.key, job.id); continue; }
      return;
    }
  }

  /**
   * Attach an enqueued job to the unit in flight, under the row's lock. `linked`: attached; `linked_canceled`: attached, but a cancel
   * had already been asked (it read the flight before the job id was there), so the caller cancels the job; `ours`: the unit already
   * carries this very job (a deduplicated enqueue); `lost`: the flight is gone or holds another job (cancelled or stopped meanwhile).
   * @param {string} studyId @param {string} id @param {Record<string, any>} unit @param {{ id: string }} job
   * @returns {Promise<"linked" | "linked_canceled" | "ours" | "lost">}
   */
  async #link(studyId, id, unit, job) {
    return this.store.transaction(async (/** @type {any} */ client) => {
      const row = (await client.query(`SELECT * FROM ${SCHEMA}.experiments WHERE id = $1 AND study_id = $2 FOR UPDATE`, [id, studyId])).rows[0];
      const state = object(row?.state);
      const flight = object(state.inFlight);
      if (!row || row.status !== "running" || flight.unitKey !== unit.key) return "lost";
      if (flight.jobId) return flight.jobId === job.id ? "ours" : "lost";
      await save(client, row, { ...state, inFlight: { ...flight, jobId: job.id } }, row.status);
      return state.cancelRequested === true ? "linked_canceled" : "linked";
    });
  }

  /**
   * Cancel a job no experiment row owns. A failure is reported and left for `repair()`, which finds the job again by the experiment
   * it names; the job's idempotency key means a retry never makes a second one.
   * @param {string} studyId @param {{ id: string }} job
   */
  async #cancelOrphan(studyId, job) {
    try {
      await this.jobs.cancel(studyId, String(job.id), { actor: "platform" });
      this.counters.orphansCanceled += 1;
    } catch (error) { this.report(String(/** @type {any} */ (error)?.code ?? "vcr_experiment_orphan_cancel_failed")); }
  }

  /** The finish hook: a campaign unit's job ended (or was cancelled). Idempotent: a unit is recorded once. @param {any} outcome */
  async onJobFinished(outcome) {
    const job = object(outcome?.job);
    const ref = object(object(job.checkpoint).experiment);
    if (!ref.id || !job.studyId) return;
    await this.#settle(String(job.studyId), String(ref.id), String(ref.unitKey), String(job.id));
    await this.advance(String(job.studyId), String(ref.id));
  }

  /**
   * Record the outcome of a finished job for the unit it ran, if that unit is still the one in flight.
   * @param {string} studyId @param {string} id @param {string} unitKey @param {string} jobId
   */
  async #settle(studyId, id, unitKey, jobId) {
    const job = await this.store.one(`SELECT * FROM ${SCHEMA}.jobs WHERE id = $1 AND study_id = $2`, [jobId, studyId]);
    if (!job || !TERMINAL.has(String(job.state))) return;
    const execution = await this.store.one(`SELECT * FROM ${SCHEMA}.executions WHERE job_id = $1 ORDER BY created_at DESC LIMIT 1`, [jobId]);
    // every attempt of a resubmitted job spent CPU, not only the last one (review eng P2-5)
    const spent = await this.store.one(`SELECT COALESCE(SUM(cpu_seconds), 0) AS cpu, COUNT(*) AS runs FROM ${SCHEMA}.executions WHERE job_id = $1`, [jobId]);
    const result = await this.store.resultOfJob(studyId, jobId);
    const evaluation = object(object(result?.diagnostics).evaluation);
    await this.#settleOutcome(studyId, id, unitKey, jobId, {
      jobId, resultId: result?.id ?? null, state: String(job.state), seed: job.seed == null ? null : Number(job.seed),
      replicates: execution?.replicates == null ? (Number.isInteger(evaluation.replicates) ? evaluation.replicates : null) : Number(execution.replicates),
      precision: evaluation.purpose ?? undefined, measures: list(result?.measures),
      cpuSeconds: Number(Number(spent?.runs ?? 0) > 0 ? spent?.cpu : job.cpu_seconds_used ?? 0) || 0,
      queueSeconds: seconds(job.created_at, execution?.started_at ?? job.finished_at), wallSeconds: seconds(job.created_at, job.finished_at),
      issues: [object(job.error).code].filter(Boolean), drawSignature: evaluation.drawSignature ?? null, rejects: evaluation.rejects ?? null,
    });
  }

  /** @param {string} studyId @param {string} id @param {string} unitKey @param {string | null} jobId @param {Record<string, any>} outcome */
  async #settleOutcome(studyId, id, unitKey, jobId, outcome) {
    await this.store.transaction(async (/** @type {any} */ client) => {
      const row = (await client.query(`SELECT * FROM ${SCHEMA}.experiments WHERE id = $1 AND study_id = $2 FOR UPDATE`, [id, studyId])).rows[0];
      const state = object(row?.state);
      const flight = object(state.inFlight);
      if (!row || flight.unitKey !== unitKey || (jobId && flight.jobId && flight.jobId !== jobId)) return;
      await save(client, row, vcrCampaignRecord(row.manifest, state, flight.unit, outcome), row.status);
    });
  }

  /**
   * Repair what a crash or a refused write left: a decided unit with no job, a unit whose job ended unrecorded, a running campaign
   * with nothing in flight. Run by the completion loop; a bounded number per call.
   */
  async repair() {
    // Only campaigns that need work: nothing in flight, a decided unit with no job, or a unit whose job ended. One waiting on a running
    // or budget-held job is not read at all, and one that could not be moved goes to the back of the queue, so a crashed campaign is
    // never starved behind parked ones (review eng P2-1).
    const rows = await this.store.rows(`SELECT e.id, e.study_id, e.state FROM ${SCHEMA}.experiments e
      LEFT JOIN ${SCHEMA}.jobs j ON j.id = e.state->'inFlight'->>'jobId'
      WHERE e.kind = 'campaign' AND e.status = 'running'
        AND (jsonb_typeof(e.state->'inFlight') IS DISTINCT FROM 'object' OR e.state->'inFlight'->>'jobId' IS NULL OR j.id IS NULL
          OR j.state IN ('succeeded', 'failed', 'canceled'))
      ORDER BY e.updated_at LIMIT $1`, [Number(this.config.vcrCompletionReconcileBatch ?? 20)]);
    let repaired = 0;
    for (const row of rows) {
      const flight = object(object(row.state).inFlight);
      try {
        if (flight.jobId) {
          const job = await this.store.one(`SELECT state FROM ${SCHEMA}.jobs WHERE id = $1`, [flight.jobId]);
          if (job && !TERMINAL.has(String(job.state))) continue;
          if (job) await this.#settle(String(row.study_id), String(row.id), String(flight.unitKey), String(flight.jobId));
        }
        await this.advance(String(row.study_id), String(row.id));
        // repaired only when the campaign moved: a unit queued, or a stop recorded; an enqueue that failed again is not a repair
        const after = await this.store.one(`SELECT status, state FROM ${SCHEMA}.experiments WHERE id = $1`, [row.id]);
        const moved = after && (after.status !== "running" || object(object(after.state).inFlight).jobId);
        if (moved) repaired += 1;
        else await this.store.query(`UPDATE ${SCHEMA}.experiments SET updated_at = now() WHERE id = $1 AND status = 'running'`, [row.id]);
      } catch (error) { this.report(String(/** @type {any} */ (error)?.code ?? "vcr_experiment_repair_failed")); }
    }
    this.counters.repaired += repaired;
    const orphans = await this.#cancelOrphans();
    const resumed = await this.#resumeStarts();
    return { campaigns: rows.length, repaired, orphans, resumed };
  }

  /**
   * Open jobs that name an experiment which does not own them: a campaign unit that is no longer the one in flight (the link lost to a
   * cancel, or a crash between the enqueue and the cancel of such a job), a campaign arm of a comparison whose cancel was asked.
   * Cancelling is idempotent, so a job that a concurrent tick is about to link and finds terminal is simply left alone.
   */
  async #cancelOrphans() {
    const rows = await this.store.rows(`SELECT j.id, j.study_id FROM ${SCHEMA}.jobs j
      JOIN ${SCHEMA}.experiments e ON e.id = j.checkpoint->'experiment'->>'id' AND e.study_id = j.study_id
      WHERE j.state IN ('queued', 'running', 'awaiting_budget') AND (
        (e.kind = 'campaign' AND NOT (e.status = 'running' AND e.state->'inFlight'->>'unitKey' = j.checkpoint->'experiment'->>'unitKey'
          AND (e.state->'inFlight'->>'jobId' IS NULL OR e.state->'inFlight'->>'jobId' = j.id)))
        OR (e.kind = 'experiment' AND e.state->>'cancelRequested' = 'true'))
      ORDER BY j.created_at LIMIT $1`, [Number(this.config.vcrCompletionReconcileBatch ?? 20)]);
    for (const row of rows) await this.#cancelOrphan(String(row.study_id), { id: String(row.id) });
    return rows.length;
  }

  /**
   * Stop a campaign: the unit in flight is cancelled (its finished batches stay with its job), and the campaign stops with
   * `user_cancellation` once that unit is recorded.
   * @param {{ id: string }} study @param {string} id @param {{ actor?: string }} [options]
   */
  async cancel(study, id, { actor = "runtime" } = {}) {
    const row = await this.store.one(`UPDATE ${SCHEMA}.experiments SET state = jsonb_set(state, '{cancelRequested}', 'true'::jsonb),
      revision = revision + 1, updated_at = now() WHERE id = $1 AND study_id = $2 RETURNING *`, [id, study.id]);
    if (!row) throw new HttpError(404, "vcr_experiment_not_found", "这个实验方案不属于本研究。");
    if (row.kind === "experiment") {
      // a design experiment's arms are ordinary jobs: each one still open is cancelled, and what finished stays (review eng P2-4)
      for (const entry of Object.values(object(object(row.state).arms)).map(object)) {
        if (!entry.jobId) continue;
        const job = await this.store.one(`SELECT state FROM ${SCHEMA}.jobs WHERE id = $1 AND study_id = $2`, [entry.jobId, study.id]);
        if (job && !TERMINAL.has(String(job.state))) await this.jobs.cancel(study.id, String(entry.jobId), { actor }).catch(() => null);
      }
      return this.view(study, id);
    }
    const jobId = object(object(row.state).inFlight).jobId;
    if (jobId && row.status === "running") await this.jobs.cancel(study.id, String(jobId), { actor });
    await this.advance(study.id, id);
    return this.view(study, id);
  }

  /**
   * The study's 「停止」: every running campaign of the study is asked to stop before its jobs are cancelled, so a unit that was decided
   * and not yet queued is never started and none moves on to its next candidate (review eng P1-2). Returns how many were asked.
   * @param {{ id: string }} study
   */
  async cancelStudy(study) {
    const rows = await this.store.rows(`UPDATE ${SCHEMA}.experiments SET state = jsonb_set(state, '{cancelRequested}', 'true'::jsonb),
      revision = revision + 1, updated_at = now() WHERE study_id = $1 AND kind = 'campaign' AND status = 'running' RETURNING id`, [study.id]);
    for (const row of rows) await this.advance(study.id, String(row.id)).catch((error) => this.report(String(/** @type {any} */ (error)?.code ?? "vcr_experiment_cancel_failed")));
    return rows.length;
  }

  // --- virtual people -----------------------------------------------------------------------------------------------------------

  /**
   * Ask the engine to make a record of virtual people: n people from the model's covariate model, or the covariates a generated population
   * version names by column. Returns the job; the record is its result, and asking again with the same request is the same job.
   * @param {{ id: string, userId: string }} study @param {unknown} input @param {{ userId: string }} who
   */
  async instantiatePeople(study, input, { userId }) {
    const asked = object(input);
    let generation = null;
    if (asked.populationId !== undefined) {
      const population = (await this.store.populations(study.id, 1000)).find((/** @type {any} */ row) => row.id === asked.populationId);
      if (!population) throw new HttpError(404, "vcr_population_not_found", "这个研究里没有这份人群。");
      const result = population.resultId ? await this.store.result(study.id, population.resultId) : null;
      const execution = result?.executionId ? await this.store.one(`SELECT method FROM ${SCHEMA}.executions WHERE id = $1 AND study_id = $2`, [result.executionId, study.id]) : null;
      generation = vcrPopulationGenerationInput(population, result, execution);
    }
    const { request, issues } = vcrPeopleInstantiateRequest(input, generation);
    if (!request) throw invalid("vcr_people_invalid", "虚拟患者记录的设置不完整：", issues);
    const { job, created } = await this.jobs.enqueue({ studyId: study.id, userId: String(userId), kind: "generate_progression", scenario: request.scenario, inputs: [],
      derived: request.derived, seed: request.seed, internal: true, detail: request.detail });
    return { jobId: String(job.id), state: String(job.state), created: Boolean(created), identity: request.identity };
  }

  /** The records of virtual people the study holds, newest first, as `vcrPeopleRecordView` reads them. @param {{ id: string }} study */
  async peopleRecords(study) {
    const rows = await this.store.rows(`SELECT id FROM ${SCHEMA}.results WHERE study_id = $1 AND kind = 'experiment_candidate' AND subject_id LIKE 'people:%'
      AND diagnostics->'progression'->>'instantiate' = 'true' ORDER BY created_at DESC LIMIT 50`, [study.id]);
    const views = [];
    for (const row of rows) { const view = vcrPeopleRecordView(await this.store.result(study.id, String(row.id))); if (view) views.push(view); }
    return views;
  }

  /**
   * A record of people of this study, or a refusal by name: an id that is not a result of the study, or a result that is not a record.
   * @param {{ id: string }} study @param {string} recordId
   */
  async #peopleRecord(study, recordId) {
    const result = await this.store.result(study.id, recordId);
    const view = vcrPeopleRecordView(result);
    if (!result || !view) throw invalid("vcr_experiment_invalid", "实验设置不完整：", [{ code: "experiment_people_unknown", field: "people.recordId", detail: "This study has no such record of virtual people." }]);
    return view;
  }

  /**
   * A plain start of a progression simulation on a record of people: the record must be this study's own (the same read a comparison makes),
   * then the start is bound the way an arm is (`vcrPeopleStartBinding`).
   * @param {{ id: string }} study @param {Record<string, any>} scenario @param {unknown} people
   */
  async bindPeopleStart(study, scenario, people) {
    const bound = vcrPeopleStartBinding(scenario, people);
    if (!bound.ok) throw invalid("vcr_people_invalid", "虚拟患者记录的设置不完整：", bound.issues);
    await this.#peopleRecord(study, bound.recordId);
    return bound;
  }

  // --- design experiments ------------------------------------------------------------------------------------------------------

  /**
   * Freeze a design experiment and enqueue the arms it runs (attached results are read, never rerun). The same experiment in the
   * same study is the same row.
   * @param {{ id: string, userId: string }} study @param {unknown} input @param {{ userId: string, origin?: Record<string, any> | null }} who
   */
  async startExperiment(study, input, { userId, origin = null }) {
    const { record, issues } = vcrDesignExperiment(input, { methods: VCR_ENGINE_METHODS, measures: VCR_CAMPAIGN_METHODS });
    if (!record) throw invalid("vcr_experiment_invalid", "实验设置不完整：", issues);
    for (const [index, arm] of record.arms.entries()) {
      if (!arm.resultId) continue;
      const field = `arms[${index}].resultId`;
      const held = await this.store.result(study.id, arm.resultId);
      if (!held) throw invalid("vcr_experiment_invalid", "实验设置不完整：", [{ code: "experiment_result_unknown", field, detail: "This study has no such result." }]);
      if (!VCR_EXPERIMENT_ATTACHABLE_KINDS.includes(String(held.kind))) {
        throw invalid("vcr_experiment_invalid", "实验设置不完整：", [{ code: "experiment_result_kind_unsupported", field, detail: `An experiment attaches a design's result (${VCR_EXPERIMENT_ATTACHABLE_KINDS.join(", ")}), never a ${held.kind}.` }]);
      }
      if (object(object(held.diagnostics).evaluation).purpose === "screening" || list(held.measures).some((measure) => object(measure).precision === "screening")) {
        throw invalid("vcr_experiment_invalid", "实验设置不完整：", [{ code: "experiment_result_screening", field, detail: "A screening run is not a result: attach a design computed at its method's normal precision." }]);
      }
    }
    if (record.people) await this.#peopleRecord(study, record.people.recordId);
    const identity = sha256(vcrDesignExperimentCanonical(record));
    const id = `exp_${sha256(`${study.id}:${identity}`).slice(0, 24)}`;
    const inserted = await this.store.one(`INSERT INTO ${SCHEMA}.experiments (id, study_id, user_id, kind, identity, manifest, state, origin)
      VALUES ($1, $2, $3, 'experiment', $4, $5::jsonb, '{"arms":{}}'::jsonb, $6::jsonb) ON CONFLICT (study_id, kind, identity) DO NOTHING RETURNING id`,
    [id, study.id, String(userId), identity, JSON.stringify(record), JSON.stringify(originOf(origin))]);
    if (inserted) this.counters.experiments += 1;
    await this.#queueArms(study, id, identity, record, String(userId));
    return { created: Boolean(inserted), ...(await this.view(study, id)) };
  }

  /** How a design experiment ended, for the conversation's one completion and for the run that reads it; see `experimentOutcome`. @param {string} studyId @param {string} id */
  async completionOf(studyId, id) {
    const row = await this.store.one(`SELECT * FROM ${SCHEMA}.experiments WHERE id = $1 AND study_id = $2 AND kind = 'experiment'`, [id, studyId]);
    return row ? experimentOutcome(this.store, row) : null;
  }

  /**
   * Queue the arms of a frozen comparison that have no record yet, each under its own idempotency key. Safe to run again at any time
   * (a start that died part-way, a restart, two callers at once): an arm whose job was enqueued is reattached to that very job, never
   * duplicated, and a cancel asked meanwhile stops the queuing. It is the start's body and the resume of an interrupted start.
   * @param {{ id: string }} study @param {string} id @param {string} identity @param {Record<string, any>} record the frozen comparison @param {string} userId
   */
  async #queueArms(study, id, identity, record, userId) {
    // Each arm is written into the row's state the moment it is enqueued, merged into what is there and never over it, and the cancel
    // flag is read from the same write: a cancel that arrives while the arms are being queued either finds the arm's job (and cancels
    // it) or is seen here (and the job just queued is cancelled), so no arm runs untracked (F03b). A failed start keeps what it began.
    /** @param {string} name @param {Record<string, any>} entry @returns {Promise<boolean>} whether a cancel has been asked */
    const note = async (name, entry) => (await this.store.one(`UPDATE ${SCHEMA}.experiments SET revision = revision + 1, updated_at = now(),
      state = jsonb_set(state, '{arms}', COALESCE(state->'arms', '{}'::jsonb) || jsonb_build_object($3::text, $4::jsonb))
      WHERE id = $1 AND study_id = $2 RETURNING state->>'cancelRequested' AS cancel`, [id, study.id, name, JSON.stringify(entry)]))?.cancel === "true";
    const stopped = async () => (await this.store.one(`SELECT state->>'cancelRequested' AS cancel FROM ${SCHEMA}.experiments WHERE id = $1 AND study_id = $2`, [id, study.id]))?.cancel === "true";
    for (const arm of record.arms) {
      if (arm.resultId) { await note(arm.name, { resultId: arm.resultId }); continue; }
      if (await stopped()) break;
      const kind = Object.entries(/** @type {Record<string, string>} */ (VCR_JOB_METHODS)).find(([, method]) => method === arm.method)?.[0];
      const campaignInfo = /** @type {Record<string, any>} */ (VCR_CAMPAIGN_METHODS)[arm.method];
      const runsWithBlock = Boolean(campaignInfo) && campaignInfo.exact !== true && campaignInfo.precisionBlock !== false;
      const scenario = runsWithBlock && vcrEvaluationAllowed(arm.method, arm.scenario) ? { ...arm.scenario, evaluation: { version: 1 } } : arm.scenario;
      // arms that draw identically share a seed, so their comparison can be paired; the engine's draw signature confirms it
      // on a record of people every arm has the same seed too: the same people, dropout and residual draws, whatever the drug
      const people = record.people ? { ...record.people, inputId: `${record.people.recordId}:${VCR_PEOPLE_TABLE}` } : null;
      const drawKey = people ? `people:${people.recordId}:${people.mode}` : arm.method === "design.simulate" ? vcrCampaignDrawKey({ space: { method: arm.method, scenario: arm.scenario } }, { key: arm.name, set: {} }) : `own:${arm.name}`;
      // a paired run is on everyone in the record, so an arm's own group sizes are not used and not carried
      const { design: _groupSizes, ...withoutSizes } = /** @type {Record<string, any>} */ (scenario);
      const armScenario = people ? { ...(people.mode === "paired_counterfactual" ? withoutSizes : scenario), people: { inputId: people.inputId, mode: people.mode } } : scenario;
      let job;
      try {
        // the arms carry no conversation origin: the comparison's own origin wakes the conversation once, when every arm is terminal (R04)
        job = (await this.jobs.enqueue({ studyId: study.id, userId: String(userId), kind, scenario: armScenario, inputs: [], internal: true,
          ...(people ? { derived: [{ resultId: people.recordId, table: VCR_PEOPLE_TABLE, shape: "subject" }] } : {}),
          seed: vcrCampaignSeed(identity, "experiment", "arm", drawKey), idempotencyKey: `vcr-experiment:${identity.slice(0, 24)}:${sha256(arm.name).slice(0, 12)}`,
          detail: { resultKind: "experiment_candidate", subjectId: `${id}:${sha256(arm.name).slice(0, 12)}`, experiment: { id, arm: arm.name } } })).job;
      } catch (error) {
        if (Number(/** @type {any} */ (error)?.status) !== 400) throw error;
        await note(arm.name, { refused: list(/** @type {any} */ (error)?.issues).map((issue) => String(object(issue).code)).slice(0, 5) });
        continue;
      }
      if (await note(arm.name, { jobId: job.id })) {
        await this.jobs.cancel(study.id, String(job.id), { actor: "platform" }).catch((/** @type {any} */ error) => this.report(String(error?.code ?? "vcr_experiment_orphan_cancel_failed")));
        break;
      }
    }
  }

  /**
   * Resume the comparisons whose start was interrupted (the process died after some arms were queued): the arms with no record are
   * queued now, from the frozen manifest, under the same keys. A comparison that was cancelled is not resumed: it has no arm left to
   * wait for and settles as canceled. A study that cannot take a job any more refuses the remaining arms with a closed reason, so the
   * comparison still ends. An infrastructure failure leaves it for the next call.
   */
  async #resumeStarts() {
    const rows = await this.store.rows(`SELECT * FROM ${SCHEMA}.experiments WHERE kind = 'experiment' AND COALESCE(state->>'cancelRequested', 'false') <> 'true'
      AND updated_at < now() - make_interval(secs => $2)
      AND (SELECT count(*) FROM jsonb_object_keys(COALESCE(state->'arms', '{}'::jsonb))) < jsonb_array_length(manifest->'arms')
      ORDER BY updated_at LIMIT $1`, [Number(this.config.vcrCompletionReconcileBatch ?? 20), Number(this.config.vcrExperimentResumeAfterMs ?? 30000) / 1000]);
    let resumed = 0;
    for (const row of rows) {
      const study = { id: String(row.study_id) };
      try {
        await this.#queueArms(study, String(row.id), String(row.identity), object(row.manifest), String(row.user_id));
        resumed += 1;
      } catch (error) {
        const status = Number(/** @type {any} */ (error)?.status), code = String(/** @type {any} */ (error)?.code ?? "");
        if ((status === 404 && code === "vcr_study_not_found") || (status === 409 && code === "vcr_study_paused")) {
          const held = object(object((await this.store.one(`SELECT state FROM ${SCHEMA}.experiments WHERE id = $1`, [row.id]))?.state).arms);
          for (const arm of list(object(row.manifest).arms)) {
            if (!held[arm.name]) await this.store.query(`UPDATE ${SCHEMA}.experiments SET revision = revision + 1, updated_at = now(),
              state = jsonb_set(state, '{arms}', COALESCE(state->'arms', '{}'::jsonb) || jsonb_build_object($2::text, $3::jsonb)) WHERE id = $1`,
            [row.id, arm.name, JSON.stringify({ refused: ["study_unavailable"] })]);
          }
        } else this.report(code || "vcr_experiment_resume_failed");
      }
    }
    return resumed;
  }

  // --- reading ------------------------------------------------------------------------------------------------------------------

  /** The study's experiments and campaigns, newest first, as summaries. @param {{ id: string }} study */
  async list(study) {
    const rows = await this.store.rows(`SELECT * FROM ${SCHEMA}.experiments WHERE study_id = $1 ORDER BY created_at DESC LIMIT 100`, [study.id]);
    // An experiment's own row never leaves its insert default, `running`: its status is read from its arms, as its page reads it (live D12).
    const statuses = new Map();
    for (const row of rows) if (row.kind === "experiment") statuses.set(String(row.id), String((await this.#presentExperiment(study, row)).status));
    return rows.map((row) => ({ id: String(row.id), kind: String(row.kind), question: String(object(row.manifest).question ?? ""), status: statuses.get(String(row.id)) ?? String(row.status),
      stopReason: object(object(row.state).stop).reason ?? null, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }));
  }

  /** One experiment or campaign as the page and the conversation read it. @param {{ id: string }} study @param {string} id */
  async view(study, id) {
    const row = await this.store.one(`SELECT * FROM ${SCHEMA}.experiments WHERE id = $1 AND study_id = $2`, [id, study.id]);
    if (!row) throw new HttpError(404, "vcr_experiment_not_found", "这个实验不属于本研究。");
    return row.kind === "campaign" ? presentCampaign(row) : this.#presentExperiment(study, row);
  }

  /**
   * The study's lab as its report and export model carry it (F4): every experiment and campaign, newest first, each with the one
   * premises block it is read under and every result next to the design it was computed for. A campaign gives its stop, its best and
   * its undecided designs and its finalists (each finalist's own setting, objective and verdicts; the candidates set aside stay on the
   * page); an experiment gives each arm's method, scenario and result id, the comparison and the alignment. Numbers are the engine's, in
   * the read model's own words; nothing is judged here. No new document: the report's templates bind to this block like any other.
   * @param {{ id: string }} study @param {any} [store] the snapshot the rest of the report was read from, when it has the reads this needs
   * @param {number} [limit]
   */
  async reportBlock(study, store = null, limit = 20) {
    const reader = store && store !== this.store && typeof store.rows === "function" && typeof store.one === "function" && typeof store.result === "function"
      && typeof store.resultOfJob === "function" ? new VcrExperiments({ store, jobs: null, config: this.config }) : this;
    const rows = await reader.store.rows(`SELECT * FROM ${SCHEMA}.experiments WHERE study_id = $1 ORDER BY created_at DESC, id LIMIT $2`, [study.id, limit]);
    const out = [];
    for (const row of rows) {
      if (row.kind === "campaign") {
        const view = presentCampaign(row);
        const finalists = list(view.finalists).map((key) => view.candidates.find((candidate) => candidate.key === key)).filter(Boolean).map((candidate) => ({
          index: candidate.index + 1, design: candidate.set, status: candidate.status, objective: candidate.objective.final,
          constraints: candidate.constraints.map((constraint) => ({ measure: constraint.measure, label: constraint.label, op: constraint.op, bound: constraint.bound, verdict: constraint.final })),
          resultIds: candidate.resultIds }));
        const at = (/** @type {string | null} */ key) => (key ? view.candidates.find((candidate) => candidate.key === key) ?? null : null);
        const best = at(view.best);
        out.push({ id: view.id, kind: "campaign", question: view.question, method: view.method, methodVersion: view.methodVersion, status: view.status,
          stop: view.stop, objective: view.objective, constraints: view.constraints,
          best: best ? { index: best.index + 1, design: best.set, objective: best.objective.final } : null,
          undecided: view.undecided ? { closest: view.undecided.closest, advice: view.undecided.advice } : null,
          robust: view.robust ? { ...view.robust, rows: view.robust.rows.map((/** @type {any} */ entry) => ({ ...entry, index: entry.index + 1, design: at(entry.key)?.set ?? {} })) } : null,
          finalists, budget: view.budget, premises: view.premises, createdAt: view.createdAt });
      } else {
        const view = await reader.#presentExperiment(study, row, { design: true });
        out.push({ id: view.id, kind: "experiment", experimentKind: view.experimentKind, question: view.question, purpose: view.purpose, status: view.status,
          arms: view.arms, comparison: view.comparison, alignment: view.alignment, incomplete: view.incomplete, premises: view.premises, createdAt: view.createdAt });
      }
    }
    return out;
  }

  /** @param {{ id: string }} study @param {any} row @param {{ design?: boolean }} [options] `design`: keep each arm's scenario (the report's pairing of a result with its design) */
  async #presentExperiment(study, row, { design = false } = {}) {
    const record = object(row.manifest);
    const disease = record.kind === "disease";
    const held = object(object(row.state).arms);
    const arms = [];
    for (const arm of list(record.arms)) {
      const entry = object(held[arm.name]);
      let job = entry.jobId ? await this.store.one(`SELECT * FROM ${SCHEMA}.jobs WHERE id = $1 AND study_id = $2`, [entry.jobId, study.id]) : null;
      const result = entry.resultId ? await this.store.result(study.id, entry.resultId) : job && TERMINAL.has(String(job.state)) ? await this.store.resultOfJob(study.id, String(job.id)) : null;
      if (!job && result?.executionId) job = await this.store.one(`SELECT j.* FROM ${SCHEMA}.jobs j JOIN ${SCHEMA}.executions e ON e.job_id = j.id WHERE e.id = $1 AND j.study_id = $2`, [result.executionId, study.id]);
      const execution = job ? await this.store.one(`SELECT replicates, cpu_seconds FROM ${SCHEMA}.executions WHERE job_id = $1 ORDER BY created_at DESC LIMIT 1`, [job.id]) : null;
      const evaluation = object(object(result?.diagnostics).evaluation);
      const status = entry.refused ? "unsupported" : result && (!job || job.state === "succeeded") ? "complete" : job && TERMINAL.has(String(job.state)) ? "failed" : job ? "running" : "incomplete";
      const progression = object(object(result?.diagnostics).progression);
      const armScenario = arm.scenario ?? (job ? object(job.scenario) : null);
      arms.push({ name: arm.name, hypothesis: disease && armScenario ? hypothesisView(armScenario) : null, trajectory: disease ? trajectoryOf(progression) : null,
        beyond: progression.extrapolation?.beyond === true, method: arm.method ?? job?.method ?? null, methodVersion: arm.version ?? job?.method_version ?? null, attached: Boolean(arm.resultId),
        status, refused: entry.refused ? refusedText(entry.refused) : null, resultId: result?.id ?? null, scenario: arm.scenario ?? (job ? object(job.scenario) : null),
        evaluation: result ? { state: status === "complete" ? "succeeded" : "failed", seed: job?.seed == null ? null : Number(job.seed), replicates: execution?.replicates == null ? null : Number(execution.replicates),
          measures: list(result.measures), drawSignature: evaluation.drawSignature ?? null, rejects: evaluation.rejects ?? null } : null });
    }
    const reference = arms.find((arm) => arm.name === record.comparison?.reference) ?? null;
    // A disease arm's difference from the reference arm at each visit, said by code from the two calculated courses (live D6, 2026-11-07: a
    // reply compared three Alzheimer arms by subtracting their means itself). Exact in the typical study, like the courses; only at the
    // visits both arms have.
    if (disease && reference?.trajectory) {
      for (const arm of arms) {
        if (arm === reference || !arm.trajectory) continue;
        arm.trajectory = arm.trajectory.map((/** @type {any} */ point) => {
          const against = /** @type {any[]} */ (reference.trajectory).find((/** @type {any} */ entry) => entry.visit === point.visit);
          return against && point.treated !== null && against.treated !== null ? { ...point, againstReference: point.treated - against.treated } : point;
        });
      }
    }
    const comparison = list(record.comparison?.measures).map((name) => ({
      measure: name, label: measureLabel(name),
      arms: arms.map((arm) => {
        const measure = arm.evaluation ? vcrEvaluationMeasure(arm.evaluation, name) : null;
        // the measure's name rides with its value, so the model boundary's by-name rule can judge it
        return { name: arm.name, status: arm.status, value: measure ? { name, ...measureValue(measure, { kind: "experiment_candidate" }) } : null, precision: measure?.precision ?? null };
      }),
      // A reference that was refused or failed leaves every arm's contrast unassessed, said so; it never leaves the contrast list empty as if
      // there were nothing to compare (F06, same class as the search's screened-out reference).
      contrasts: reference && !reference.evaluation ? arms.filter((arm) => arm !== reference).map((arm) => ({ arm: arm.name, against: reference.name,
        coupling: "reference_unavailable", couplingText: COUPLING_TEXT_ZH.reference_unavailable, difference: null })) : reference?.evaluation ? arms.filter((arm) => arm !== reference && arm.evaluation).map((arm) => {
        const contrast = vcrEvaluationContrast(/** @type {any} */ (arm.evaluation), reference.evaluation, name);
        return { arm: arm.name, against: reference.name, coupling: contrast.coupling, couplingText: COUPLING_TEXT_ZH[/** @type {keyof typeof COUPLING_TEXT_ZH} */ (contrast.coupling)] ?? null,
          difference: contrast.difference == null ? null : { name, ...measureValue({ name, value: contrast.difference, mcse: contrast.mcse ?? undefined, simulated: contrast.mcse != null }, { kind: "experiment_candidate" }) } };
      }) : [],
    }));
    const alignment = vcrExperimentAlignment(arms.map((arm) => ({ name: arm.name, scenario: arm.scenario })), disease ? VCR_DISEASE_EXPERIMENT_ALIGNED_FIELDS : undefined);
    const incomplete = arms.filter((arm) => arm.status !== "complete").map((arm) => arm.name);
    // A requested measure the compared designs do not carry is an execution issue of that measure alone (live D13, 2026-11-07: `expected_sample_size`
    // asked of analytic results answered complete with every value empty, and the model subtracted the designs itself). The measures they do carry
    // are named, so the next call can ask for one; the measures that exist keep their values. The page reads the same text.
    const carried = [...new Set(arms.flatMap((arm) => list(arm.evaluation?.measures).map((measure) => String(object(measure).name ?? ""))).filter(Boolean))];
    const measureIssues = comparison.flatMap((entry) => {
      const lacking = entry.arms.filter((cell) => cell.status === "complete" && !cell.value).map((cell) => cell.name);
      if (!lacking.length) return [];
      const carriedText = carried.filter((name) => name !== entry.measure).map(measureLabel).join("、");
      return [{ code: "comparison_measure_not_carried", measure: entry.measure, label: entry.label, arms: lacking,
        carried: carried.filter((name) => name !== entry.measure),
        text: `“${entry.label}”这些方案的结果里没有（${lacking.join("、")}），这一项没有比较。${carriedText ? `它们有的指标：${carriedText}。` : ""}` }];
    });
    return {
      id: String(row.id), kind: "experiment", experimentKind: disease ? "disease" : "design", question: String(record.question ?? ""), purpose: String(record.purpose ?? ""),
      people: record.people ? { recordId: String(record.people.recordId), mode: String(record.people.mode), modeText: PEOPLE_MODE_TEXT_ZH[/** @type {keyof typeof PEOPLE_MODE_TEXT_ZH} */ (record.people.mode)] ?? null } : null,
      status: incomplete.some((name) => arms.find((arm) => arm.name === name)?.status === "running") ? "running" : "complete",
      arms: arms.map(({ evaluation: _e, scenario, beyond: _b, ...arm }) => (design ? { ...arm, design: scenario } : arm)), comparison, measureIssues, alignment: alignment.map(({ values: _v, ...rest }) => rest), incomplete,
      premises: finishPremises([
        { key: "lab:aligned", label: "比较的前提", value: alignment.every((entry) => entry.aligned) ? "各组用同一个终点和同一套分析设置。"
          : `各组的${alignment.filter((entry) => !entry.aligned).map((entry) => ALIGNED_FIELD_TEXT_ZH[/** @type {keyof typeof ALIGNED_FIELD_TEXT_ZH} */ (entry.field)]).join("、")}不一致或未知，差值只能对照着看。`,
          source: "given", decisive: true },
        // no general disclaimer: the comparison's alignment and each arm's own scenario already say what it rests on
        ...(record.people ? [{ key: "lab:people", label: "比较用的虚拟患者", value: PEOPLE_MODE_TEXT_ZH[/** @type {keyof typeof PEOPLE_MODE_TEXT_ZH} */ (record.people.mode)] ?? "", source: /** @type {const} */ ("given"), decisive: true }] : []),
        ...(disease ? diseasePremises(arms.some((arm) => arm.beyond), arms.map((arm) => object(arm.scenario))) : []),
        ...(measureIssues.length ? [{ key: "lab:measure_missing", label: "没有比较的指标", value: measureIssues.map((issue) => issue.text).join(""), source: /** @type {const} */ ("given"), decisive: true }] : []),
        ...(incomplete.length ? [{ key: "lab:incomplete", label: "未完成的组", value: `${incomplete.join("、")}还没有可比较的结果，比较中缺少它们。`, source: /** @type {const} */ ("given"), decisive: true }] : []),
      ]),
      createdAt: iso(row.created_at),
    };
  }
}

/**
 * What a search cannot run: a record of people or an effect stated as a distribution in the base scenario or in any value a variable takes.
 * @param {Record<string, any>} manifest
 * @returns {Array<{ code: string, field: string, detail: string }>}
 */
export function campaignScenarioIssues(manifest) {
  const space = object(manifest.space);
  if (space.method !== "patients.progression") return [];
  const text = JSON.stringify(space);
  const found = [];
  if (/"people"|"instantiate"/.test(text)) found.push({ code: "campaign_people_unsupported", field: "space.scenario.people", detail: "A search runs on the model's own people; a record of virtual people is a comparison's (startExperiment)." });
  if (/"distribution"/.test(text)) found.push({ code: "campaign_effect_distribution_unsupported", field: "space.scenario.treatment", detail: "A search ranks designs by power; an effect stated as a distribution reports an assurance, which a comparison reads." });
  return found;
}

const ALIGNED_FIELD_TEXT_ZH = Object.freeze({ endpoint: "终点", "analysis.alpha": "检验水准", "analysis.sided": "单双侧", hypothesis: "假设类型", timeUnit: "时间单位",
  visits: "随访时间点", design: "每组人数", model: "模型设置", population: "入组人群", placebo: "安慰剂反应设置", dropoutModel: "脱落设置",
  "analysis.kind": "分析方法", "analysis.visit": "分析所在的随访点" });
const PEOPLE_MODE_TEXT_ZH = Object.freeze({
  paired_counterfactual: "每一组都用同一批虚拟患者：每个人在各组里个体特征、脱落时间和测量误差的随机数都相同，只有药物不同。结果是模型推算的“同一批人换一种治疗会怎样”，不是任何试验观察到的个体疗效。",
  resampled_trials: "每一组的每次模拟试验都从同一份虚拟患者记录里抽人并随机分组，各组抽到的人相同；记录里的研究层面差异是固定的，没有再抽。",
});
const HYPOTHESIS_TEXT_ZH = Object.freeze({ none: "没有药物效果（只看检验会不会误判有效）", symptomatic: "改善症状的假设", disease_modifying: "减慢病情恶化的假设", both: "改善症状并减慢恶化的假设" });

/** The drug hypothesis of a disease arm, in a word and in the closed sentence. @param {Record<string, any>} scenario */
function hypothesisView(scenario) {
  const kind = vcrDiseaseHypothesis(scenario);
  return { kind, text: HYPOTHESIS_TEXT_ZH[kind] };
}

/**
 * The calculated mean course of a disease arm, one row per visit: the untreated and the treated group's ADAS-cog score in the typical
 * study. Numbers only; null when the arm has no result.
 * @param {Record<string, any>} progression the result's `diagnostics.progression`
 */
function trajectoryOf(progression) {
  const curves = list(progression.curves).map(object);
  if (!curves.length) return null;
  const value = (/** @type {any} */ measure) => (Number.isFinite(Number(object(measure).value)) ? Number(object(measure).value) : null);
  return curves.map((curve) => ({ visit: Number(curve.visit), control: value(object(curve.control).mean), treated: value(object(curve.treated).mean) }));
}

/**
 * What a person must know to read an Alzheimer experiment or search: the drug effects are the researcher's hypotheses, the parameters are
 * a published model's, no regulatory status comes with them and the scope is mild to moderate disease on ADAS-cog 11 for up to two years.
 * Three or four decisive rows; the regulatory sentence is folded.
 * @param {boolean} beyond @param {Array<Record<string, any>>} scenarios
 */
function diseasePremises(beyond, scenarios) {
  const last = Math.max(0, ...scenarios.flatMap((scenario) => list(scenario.visits).map(Number).filter(Number.isFinite)));
  return [
    { key: "progression:ad:effect", label: "药物效果", value: "各组的药物效果都是你设定的假设，不是对某个药物疗效的预测；比较的是“如果效果是这样，试验会看到什么”。", source: /** @type {const} */ ("assumed"), decisive: true },
    { key: "progression:ad:parameters", label: "模型参数", value: ALZHEIMER_PARAMETERS_TEXT, source: /** @type {const} */ ("literature"), decisive: true },
    { key: "progression:ad:scope", label: "适用范围", value: alzheimerScopeText(beyond || last > ALZHEIMER_DATA_WEEKS, last,
      scenarios.map((scenario) => list(object(scenario.population).mmseRange)).find((range) => range.length === 2) ?? null), source: /** @type {const} */ ("literature"), decisive: true },
    { key: "progression:ad:reproduction", label: "复现情况", value: ALZHEIMER_REPRODUCTION_TEXT, source: /** @type {const} */ ("literature"), decisive: false },
    { key: "progression:ad:regulatory", label: "监管认可", value: ALZHEIMER_REGULATORY_TEXT, source: /** @type {const} */ ("literature"), decisive: false },
  ];
}
/** The two years of data the Alzheimer parameter set rests on, in weeks (the engine's own constant). */
const ALZHEIMER_DATA_WEEKS = 104;

/**
 * Whether a design experiment's arms have all ended, and how, for the one completion it sends to the conversation that started it
 * (R04). Read from the arms' own jobs, never from the experiment row's `status` (which never leaves its insert default). An arm is
 * terminal when it holds an attached result, a refusal, or a job that ended; an arm with no record yet is still being queued, unless a
 * cancel was asked, in which case it will never run. `state` is the job-path vocabulary (`succeeded` / `failed` / `canceled`) and
 * `partial` says that some arms have no result; `outcome` is the four-way word: succeeded, partial, failed, canceled.
 * @param {any} store anything with `rows`
 * @param {{ id: string, study_id: string, manifest: any, state: any }} row the experiment's row
 * @returns {Promise<{ terminal: boolean, outcome: "succeeded" | "partial" | "failed" | "canceled" | null, state: "succeeded" | "failed" | "canceled" | null,
 *   partial: boolean, arms: { total: number, complete: number, failed: number, canceled: number, refused: number, pending: number }, finishedAt: string | null }>}
 */
export async function experimentOutcome(store, row) {
  const state = object(row.state);
  const held = object(state.arms);
  const names = list(object(row.manifest).arms).map((arm) => String(object(arm).name));
  const jobIds = names.map((name) => object(held[name]).jobId).filter(Boolean).map(String);
  const jobs = jobIds.length ? await store.rows(`SELECT id, state, finished_at FROM ${SCHEMA}.jobs WHERE study_id = $1 AND id = ANY($2::text[])`, [row.study_id, jobIds]) : [];
  const byId = new Map(jobs.map((/** @type {any} */ job) => [String(job.id), job]));
  const arms = { total: names.length, complete: 0, failed: 0, canceled: 0, refused: 0, pending: 0 };
  let finished = 0;
  for (const name of names) {
    const entry = object(held[name]);
    if (entry.refused) arms.refused += 1;
    else if (entry.resultId) arms.complete += 1;
    else if (entry.jobId) {
      const job = byId.get(String(entry.jobId));
      // a job row that is gone cannot produce a result: that arm ended without one
      const jobState = job ? String(job.state) : "failed";
      if (job?.finished_at) finished = Math.max(finished, new Date(job.finished_at).getTime());
      if (jobState === "succeeded") arms.complete += 1;
      else if (jobState === "canceled") arms.canceled += 1;
      else if (jobState === "failed") arms.failed += 1;
      else arms.pending += 1;
    } else if (state.cancelRequested === true) arms.canceled += 1;
    else arms.pending += 1;
  }
  const ended = arms.total > 0 && arms.pending === 0;
  if (!ended) return { terminal: false, outcome: null, state: null, partial: false, arms, finishedAt: null };
  const withoutResult = arms.total - arms.complete;
  const asked = state.cancelRequested === true && withoutResult > 0;
  const outcome = withoutResult === 0 ? "succeeded" : asked || (arms.failed === 0 && arms.refused === 0) ? "canceled" : arms.complete === 0 ? "failed" : "partial";
  return { terminal: true, outcome, state: outcome === "canceled" ? "canceled" : outcome === "failed" ? "failed" : "succeeded",
    partial: arms.complete > 0 && withoutResult > 0, arms, finishedAt: finished ? new Date(finished).toISOString() : null };
}

/** @param {Record<string, any> | null} origin */
function originOf(origin) {
  const value = object(origin);
  return { runId: value.runId ?? null, rootSessionId: value.rootSessionId ?? null, callId: value.callId ?? null };
}

/** @param {any} client @param {any} row @param {Record<string, any>} state @param {string} status */
async function save(client, row, state, status) {
  await client.query(`UPDATE ${SCHEMA}.experiments SET state = $3::jsonb, status = $4, revision = revision + 1, updated_at = now()
    WHERE id = $1 AND study_id = $2 AND revision = $5`, [row.id, row.study_id, JSON.stringify(state), status, Number(row.revision)]);
}

/** @param {string} code @param {string} lead @param {Array<{ code: string, field: string, detail?: string }>} issues */
function invalid(code, lead, issues) {
  const error = new HttpError(400, code, `${lead}${issues.slice(0, 6).map((issue) => `${issue.field || issue.code}（${issue.code}）`).join("、")}。`);
  /** @type {any} */ (error).issues = issues.slice(0, 20);
  return error;
}

/**
 * A measure's number as the page shows it, labelled with its precision.
 * @param {Record<string, any> | null} evaluation @param {string} name
 */
function shown(evaluation, name) {
  const measure = vcrEvaluationMeasure(evaluation, name);
  if (!measure || evaluation?.state !== "succeeded") return null;
  return { ...measureValue(measure, { kind: "experiment_candidate" }), stage: evaluation.precision === "screening" ? "screening" : "final" };
}

/**
 * The campaign's read model: what was frozen, every candidate with its stage, objective and verdicts, the finalists, the stop and
 * the budget used, and the premises of its conclusion. Pure over the stored row.
 * @param {any} row
 */
export function presentCampaign(row) {
  const manifest = object(row.manifest);
  const state = object(row.state);
  const truthOf = (/** @type {string} */ stage, /** @type {string} */ truth) => `${stage}:${truth}`;
  const candidates = vcrCampaignCandidates(manifest).map((candidate) => {
    const entry = object(object(state.candidates)[candidate.key]);
    const evaluations = object(entry.evaluations);
    const objective = manifest.objective;
    const screening = shown(evaluations[truthOf("screening", objective.truth)] ?? null, objective.measure);
    const final = shown(evaluations[truthOf("final", objective.truth)] ?? null, objective.measure);
    const screenVerdicts = manifest.stages?.screening ? vcrCandidateVerdicts(manifest, entry, "screening") : [];
    const finalVerdicts = vcrCandidateVerdicts(manifest, entry, "final");
    const all = Object.values(evaluations).map(object);
    return {
      key: candidate.key, index: candidate.index, set: candidate.set, status: String(entry.status ?? "pending"),
      statusText: entry.role === "reference_only" ? "仅作对照" : VCR_CANDIDATE_STATUS_TEXT_ZH[/** @type {keyof typeof VCR_CANDIDATE_STATUS_TEXT_ZH} */ (entry.status)] ?? "待评估",
      stage: final ? "final" : screening ? "screening" : null, reason: entry.reason ?? null, reasonText: reasonText(entry.reason ?? null),
      objective: { screening, final },
      constraints: list(manifest.constraints).map((constraint, index) => ({
        index, measure: constraint.measure, label: measureLabel(constraint.measure), kind: constraint.kind, op: constraint.op, bound: constraint.bound,
        screening: verdictView(screenVerdicts[index], constraint), final: verdictView(finalVerdicts[index], constraint),
      })),
      resultIds: all.map((evaluation) => evaluation.resultId).filter(Boolean),
      usage: { cpuSeconds: sum(all, "cpuSeconds"), queueSeconds: sum(all, "queueSeconds"), wallSeconds: sum(all, "wallSeconds"), replicates: sum(all, "replicates") },
    };
  });
  const verdict = state.finalists ? vcrCampaignVerdict(manifest, state) : null;
  const usage = object(state.usage);
  // the best design against the declared reference, on their final evaluations, with the error the coupling of the two runs allows
  const finalOf = (/** @type {string | null} */ key) => (key ? object(object(object(state.candidates)[key]).evaluations)[`final:${manifest.objective?.truth}`] ?? null : null);
  const versus = verdict?.best && verdict.reference && verdict.best !== verdict.reference && finalOf(verdict.best) && finalOf(verdict.reference)
    ? vcrEvaluationContrast(finalOf(verdict.best), finalOf(verdict.reference), manifest.objective.measure) : null;
  const stop = state.stop ? { reason: state.stop.reason, text: VCR_CAMPAIGN_STOP_TEXT_ZH[/** @type {keyof typeof VCR_CAMPAIGN_STOP_TEXT_ZH} */ (state.stop.reason)] ?? null, at: state.stop.at ?? null } : null;
  const disease = manifest.space?.method === "patients.progression";
  const alpha = Number(object(object(manifest.space).scenario).analysis?.alpha ?? (disease ? 0.05 : 0.025));
  const errorControl = list(manifest.constraints).filter((c) => c.kind === "error_control");
  const searchesLevel = searchesAnalysisLevel(manifest);
  const screeningSize = manifest.stages?.screening?.replicates ?? null;
  return {
    id: String(row.id), kind: "campaign", question: String(manifest.question ?? ""), status: String(row.status), method: manifest.space?.method, methodVersion: manifest.space?.version,
    identity: String(row.identity),
    objective: { ...manifest.objective, label: measureLabel(manifest.objective?.measure) },
    constraints: list(manifest.constraints).map((c) => ({ ...c, label: measureLabel(c.measure), kindText: CONSTRAINT_KIND_TEXT_ZH[/** @type {keyof typeof CONSTRAINT_KIND_TEXT_ZH} */ (c.kind)] ?? c.kind })),
    truths: list(manifest.space?.truths).map((truth) => truth.name),
    stages: manifest.stages, budget: { declared: manifest.budget, used: { ...usage, units: Number(state.unitsEvaluated ?? 0),
      candidatesEvaluated: candidates.filter((c) => c.stage).length, candidatesPlanned: candidates.length } },
    candidates, finalists: list(state.finalists), best: verdict?.best ?? null, inconclusive: verdict?.inconclusive ?? [], feasible: verdict?.feasible ?? [],
    reference: verdict?.reference ?? null, improvement: verdict?.improvement ?? null,
    // the improvement's bound the stop was decided on, and how many finalists the best was picked among (stats P2-1)
    improvementBound: verdict?.improvementBound ? { lower: verdict.improvementBound.lower, upper: verdict.improvementBound.upper, confidence: verdict.improvementBound.confidence,
      basis: verdict.improvementBound.basis } : null,
    selection: verdict?.selection ?? null,
    // the robust reading of a campaign that compares two or more effect scenarios; null for one that does not
    robust: verdict?.robust ? presentRobust(manifest, verdict.robust, candidates) : null,
    // the closest design no constraint failed and what would decide each undecided constraint (only when nothing passed everything)
    undecided: verdict && !verdict.best ? undecidedView(manifest, verdict, candidates) : null,
    againstReference: versus ? { coupling: versus.coupling, couplingText: COUPLING_TEXT_ZH[/** @type {keyof typeof COUPLING_TEXT_ZH} */ (versus.coupling)] ?? null,
      difference: versus.difference == null ? null : measureValue({ name: manifest.objective.measure, value: versus.difference, mcse: versus.mcse ?? undefined, simulated: versus.mcse != null }, { kind: "experiment_candidate" }) } : null,
    inFlight: state.inFlight ? { unit: state.inFlight.unitKey, stage: object(state.inFlight.unit).stage ?? null } : null,
    cancelRequested: state.cancelRequested === true, stop,
    premises: finishPremises([
      ...(errorControl.length ? [{ key: "alpha", label: "第一类错误", value: searchesLevel
        ? `约束固定为 ${percentWord(Math.min(...errorControl.map((c) => Number(c.bound))))}，搜索中不能放宽；检验水准也在搜索范围内，只取不高于约束的值，用来给模拟结果留出余量。`
        : `固定为 ${percentWord(alpha)}，搜索中不能放宽。`, source: /** @type {const} */ ("given"), decisive: true }] : []),
      { key: "campaign:precision", label: "初筛与复核", value: screeningSize
        ? `初筛每个方案模拟 ${screeningSize} 次，只用来排序和排除明显不满足的方案；入围方案另做一批独立模拟、按方法的正常次数重算后，才判断是否满足约束。`
        : "每个方案按方法的正常精度计算一次，直接判断是否满足约束。", source: "given", decisive: !disease },
      { key: "campaign:bound", label: "约束怎样算满足", value: boundPremiseText(list(manifest.constraints)), source: "given", decisive: true },
      ...(disease
        ? diseasePremises(false, [object(object(manifest.space).scenario), ...vcrCampaignCandidates(manifest).map((candidate) => object(candidate.set))])
        : (() => {
          // the one sentence that decides this result: which efficacy hypotheses were simulated
          const names = list(manifest.space?.truths).map((truth) => String(truth.name)).filter(Boolean);
          return names.length ? [{ key: "campaign:conditional", label: "疗效假设", value: `结果是在“${names.join("”“")}”这 ${names.length} 个疗效假设下模拟的；疗效假设变了，结论可能不同。`, source: /** @type {const} */ ("assumed"), decisive: true }] : [];
        })()),
      { key: "campaign:frozen", label: "开始前已固定的评价方式", value: "目标、约束、疗效假设和每个阶段的模拟次数在开始前已固定；改动任何一项就是一个新的实验方案。", source: "given", decisive: false },
    ]),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

const ROBUST_GUARD_TEXT_ZH = Object.freeze({ pass: "错误率与安全性约束满足", inconclusive: "错误率或安全性约束无法确定", fail: "不满足错误率或安全性约束", none: "没有错误率或安全性约束" });
const ROBUST_ACCEPTABLE_TEXT_ZH = Object.freeze({ pass: "每个假设下都达到", fail: "有假设下没达到", inconclusive: "有假设下无法确定", unknown: "有假设没有结果" });
const ROBUST_TAG_TEXT_ZH = Object.freeze({ pareto: "帕累托集合", near_optimal: "接近最优集合", maximin: "最差情形功效最高", minimax_regret: "最大遗憾最小",
  cheapest_acceptable: "各假设下都达标的最省方案", cheapest_base: "仅看基准情形的最省方案" });
const ROBUST_OC_LABELS_ZH = Object.freeze({ exposure: "累计暴露（人数 × 时长）" });

/**
 * The robust reading as the page and the conversation read it (R34): the scenarios, one row per finalist with its power in every scenario,
 * its worst case, its largest regret and the sets it belongs to, the two cheapest designs side by side and the rule the sets were drawn by.
 * No row is marked best: the leaders of a criterion are named as leaders of that criterion. Pure over the domain's `vcrCampaignRobust`.
 * @param {Record<string, any>} manifest @param {Record<string, any>} robust @param {Array<Record<string, any>>} candidates the view's candidates
 */
function presentRobust(manifest, robust, candidates) {
  const percentOf = (/** @type {number} */ x) => percentWord(x);
  const num = (/** @type {string} */ name, /** @type {{ value: number, mcse?: number | null } | null | undefined} */ one) => (one
    ? measureValue({ name, value: one.value, mcse: one.mcse ?? undefined, simulated: one.mcse != null }, { kind: "experiment_candidate" }) : null);
  const scenarios = list(robust.scenarios).map((entry) => String(entry.name));
  const indexOf = (/** @type {string | null} */ key) => (key ? (candidates.find((candidate) => candidate.key === key)?.index ?? null) : null);
  const tags = (/** @type {Record<string, any>} */ row) => [
    ...(row.pareto ? ["pareto"] : []), ...(row.nearOptimal ? ["near_optimal"] : []),
    ...(robust.maximin === row.key ? ["maximin"] : []), ...(robust.minimaxRegret === row.key ? ["minimax_regret"] : []),
    ...(robust.cheapestAcceptable === row.key ? ["cheapest_acceptable"] : []), ...(robust.cheapestUnderBase === row.key ? ["cheapest_base"] : []),
  ];
  const rows = list(robust.rows).map((row) => ({
    key: row.key, index: indexOf(row.key) ?? row.index, complete: row.complete, eligible: row.eligible, referenceOnly: row.referenceOnly,
    guard: row.guard, guardText: ROBUST_GUARD_TEXT_ZH[/** @type {keyof typeof ROBUST_GUARD_TEXT_ZH} */ (row.guard)] ?? null,
    acceptable: row.acceptable, acceptableText: ROBUST_ACCEPTABLE_TEXT_ZH[/** @type {keyof typeof ROBUST_ACCEPTABLE_TEXT_ZH} */ (row.acceptable)] ?? null,
    worstCase: row.worstCase ? { ...num("power", row.worstCase), scenario: row.worstCase.scenario } : null,
    maxRegret: row.regret ? { ...num("power", row.regret.max), scenario: row.regret.max.scenario } : null,
    expectedPower: num("power", row.expectedPower),
    n: num(robust.measures.n ?? "expected_sample_size", row.n), duration: num(robust.measures.duration ?? "duration_months", row.duration),
    scenarios: Object.entries(object(row.oc)).map(([name, oc]) => ({
      name, weight: list(robust.scenarios).find((entry) => entry.name === name)?.weight ?? null,
      compared: scenarios.includes(name),
      power: object(row.scenarios)[name]?.power ? { ...num("power", object(row.scenarios)[name].power), status: object(row.scenarios)[name].power.status,
        statusText: VCR_CONSTRAINT_STATUS_TEXT_ZH[/** @type {keyof typeof VCR_CONSTRAINT_STATUS_TEXT_ZH} */ (object(row.scenarios)[name].power.status)] ?? null,
        regret: row.regret?.byScenario?.[name] ? num("power", row.regret.byScenario[name]) : null } : null,
      oc: Object.entries(object(oc)).filter(([measure]) => measure !== "power").map(([measure, value]) => ({ measure, label: ROBUST_OC_LABELS_ZH[/** @type {keyof typeof ROBUST_OC_LABELS_ZH} */ (measure)] ?? measureLabel(measure),
        ...num(measure === "exposure" ? "exposure_patient_time" : measure, /** @type {any} */ (value)) })),
    })),
    tags: tags(row),
  }));
  const pick = (/** @type {string | null} */ key) => { const row = rows.find((entry) => entry.key === key); return row ? { key: row.key, index: row.index, n: row.n, worstCase: row.worstCase } : null; };
  const cheapestAcceptable = pick(robust.cheapestAcceptable);
  const cheapestUnderBase = pick(robust.cheapestUnderBase);
  const names = scenarios.map((name) => `“${name}”`).join("、");
  const floor = percentOf(Number(robust.rule.floor));
  const baseName = String(manifest.objective?.truth ?? "");
  /** @type {string[]} */
  const sentences = [`在这些假设下（${names}）：`];
  if (cheapestAcceptable) {
    sentences.push(`每个假设下功效都确认不低于 ${floor} 的最省方案是第 ${cheapestAcceptable.index + 1} 个`);
    sentences.push(cheapestUnderBase ? (robust.sameDesign ? `；只看基准情形“${baseName}”，最省的也是它。` : `；只看基准情形“${baseName}”，最省的是第 ${cheapestUnderBase.index + 1} 个，它在别的假设下未必够用。`) : "。");
  } else if (list(robust.inconclusive).length) {
    sentences.push(`没有方案在每个假设下都确认功效不低于 ${floor}；有 ${list(robust.inconclusive).length} 个方案在某个假设下无法确定。`);
  } else sentences.push(`没有方案在每个假设下都达到功效 ${floor}。`);
  const weighted = robust.weighted === true;
  const choiceRule = [
    `${scenarios.length} 个假设下每个方案都用同一批随机数模拟，差别只来自假设本身。`,
    `最差情形功效取各假设中最低的一个；遗憾是它与该假设下功效最高的方案之差，取各假设中最大的一个。`,
    `帕累托集合按样本量、研究时长和最差情形功效三项比较，没有别的方案在三项上都不差、又至少一项更好；接近最优集合还包括每一项至多比某个帕累托方案差“功效 ${percentOf(Number(robust.rule.tolerance.power))}、样本量和时长各 ${percentOf(Number(robust.rule.tolerance.relative))}”加模拟误差的方案。`,
    weighted ? "你给了各假设的权重，所以另给按权重平均的功效。" : "你没有给各假设的权重，所以不给平均功效。",
  ];
  return {
    scenarios: list(robust.scenarios).map((entry) => ({ name: String(entry.name), weight: entry.weight ?? null })), weighted,
    floor: Number(robust.rule.floor), confidence: Number(robust.rule.confidence), tolerance: robust.rule.tolerance,
    criteria: robust.criteria, rows,
    sets: { pareto: robust.pareto, nearOptimal: robust.nearOptimal, acceptable: robust.acceptable, inconclusive: robust.inconclusive },
    leaders: { maximin: robust.maximin, minimaxRegret: robust.minimaxRegret },
    cheapestAcceptable, cheapestUnderBase, sameDesign: robust.sameDesign,
    statement: sentences.join(""), choiceRule: choiceRule.join(""),
    tagText: ROBUST_TAG_TEXT_ZH,
  };
}

/** Whether a campaign names the analysis level among its search variables (F4). @param {Record<string, any>} manifest */
const searchesAnalysisLevel = (manifest) => list(manifest.space?.variables).some((entry) => entry.path === "analysis.alpha")
  || list(manifest.space?.candidates).some((entry) => Object.hasOwn(object(entry.set), "analysis.alpha"));

/**
 * What an `inconclusive_at_precision` stop says about the closest designs, in the words a person reads (F4). Pure over the domain's verdict.
 * The constraint stays as frozen; for a simulated rate sitting on its bound the advice is a lower analysis level in a NEW campaign, for a
 * rate near it the replicates that would decide it, with the number.
 * @param {Record<string, any>} manifest @param {Record<string, any>} verdict the domain's `vcrCampaignVerdict`
 * @param {Array<Record<string, any>>} candidates the view's candidates (for the index and the shown objective)
 */
function undecidedView(manifest, verdict, candidates) {
  if (!verdict?.undecided?.length) return null;
  const method = String(manifest.space?.method ?? "");
  const types = /** @type {Record<string, any>} */ (VCR_CAMPAIGN_METHODS)[method]?.measures ?? {};
  const rate = (/** @type {string} */ name) => types[name] === "proportion" || types[name] === "error_rate";
  const plain = (/** @type {string} */ name, /** @type {number} */ value) => (rate(name) ? percentWord(value) : String(Number(value.toPrecision(4))));
  const searchesLevel = searchesAnalysisLevel(manifest);
  const levelCan = ["design.simulate", "patients.progression"].includes(method);
  const items = verdict.undecided.map((/** @type {any} */ row) => {
    const candidate = candidates.find((c) => c.key === row.key);
    return { key: row.key, index: candidate?.index ?? row.index, objective: candidate?.objective?.final ?? null,
      constraints: row.constraints.map((/** @type {any} */ c) => {
        const needed = c.needed ?? null;
        const label = measureLabel(c.measure);
        const value = c.estimate == null ? "" : `${plain(c.measure, Number(c.estimate))}${c.mcse ? `（模拟误差约 ${rate(c.measure) ? `${Number((Number(c.mcse) * 100).toPrecision(2))}%` : Number(Number(c.mcse).toPrecision(2))}）` : ""}`;
        const at = `“${label}”的模拟值是 ${value}，要求${c.op === "<=" ? "不超过" : "不低于"} ${plain(c.measure, Number(c.bound))}`;
        const kind = list(manifest.constraints)[c.index]?.kind;
        /** @type {string} */
        let advice;
        if (needed?.reason === "estimate_at_bound") {
          // the level that would leave the simulated rate its own margin: the constraint less how far the conservative bound sits above the
          // estimate, down to a tenth of a percent (an asymptotic test's simulated rate sits at its own level), never a fixed fraction
          const margin = c.op === "<=" && Number.isFinite(c.upper) && Number.isFinite(c.estimate) ? Number(c.upper) - Number(c.estimate) : null;
          const stepped = margin == null ? NaN : Math.floor((Number(c.bound) - margin) * 1000 + 1e-9) / 1000;
          const lower = stepped > 0 ? stepped : Number((Number(c.bound) * 0.9).toPrecision(2));
          advice = kind === "error_control" && levelCan && !searchesLevel
            ? `${at}，正好在界上：再多模拟几次也判断不出来。这个设计可以把检验水准定得更低（例如 ${percentWord(lower)}，约束仍是 ${plain(c.measure, Number(c.bound))}）来留出余量；这个值只是按这次模拟的余量估出来的，不是对所有设计都成立的结论，要作为一个新的实验方案重新开始、由它的模拟来判断，约束本身不改。`
            : kind === "error_control" && levelCan
              ? `${at}，正好在界上：再多模拟几次也判断不出来。这次搜索里的检验水准没有给它留出余量；可以再试更低的检验水准，作为新的实验方案重新开始，约束本身不改。`
              : `${at}，正好在界上：再多模拟几次也判断不出来。需要调整设计，让它离界值远一些，作为新的实验方案重新开始。`;
        } else if (Number.isFinite(needed?.replicates)) {
          advice = `${at}，离界值很近：约需 ${numberWord(needed.replicates)} 次复核模拟才可能判断。`;
        } else {
          advice = `${at}：现有信息不足以估计需要多少次复核；增加复核次数才可能判断。`;
        }
        return { index: c.index, measure: c.measure, label, op: c.op, bound: c.bound, status: "inconclusive",
          estimate: c.estimate == null ? null : { name: c.measure, ...measureValue({ name: c.measure, value: c.estimate, mcse: c.mcse ?? undefined, simulated: true }, { kind: "experiment_candidate" }) },
          needed: needed ? { replicates: needed.replicates ?? null, reason: needed.reason ?? null } : null, advice };
      }) };
  });
  const closest = verdict.bestUndecided ? items.find((item) => item.key === verdict.bestUndecided) ?? null : null;
  const advice = [...new Set(items.flatMap((item) => item.constraints.map((c) => c.advice)))];
  return { closest, items, advice };
}
/** @param {number} n */
const numberWord = (n) => new Intl.NumberFormat("zh-CN").format(n);

/** @param {number} confidence */
/**
 * How the constraints are judged, one sentence: the confidence of each (one confidence says it once, several name their measure).
 * @param {Array<Record<string, any>>} constraints
 */
function boundPremiseText(constraints) {
  const confidences = constraints.map((constraint) => Number(constraint.confidence ?? 0.975));
  const rule = "最不利情况下的值也满足才算满足；接近界值记为“无法确定”，不算通过。";
  if (new Set(confidences).size <= 1) return `每个约束按预先声明的单侧 ${percentWord(confidences[0] ?? 0.975)} 置信界判断：${rule}`;
  return `${constraints.map((constraint, index) => `${measureLabel(constraint.measure)}按单侧 ${percentWord(confidences[index])}`).join("，")}置信界判断：${rule}`;
}
const percentWord = (confidence) => `${String(Number((confidence * 100).toPrecision(4)))}%`;

/** @param {any[]} rows @param {string} field */
const sum = (rows, field) => rows.reduce((total, row) => total + (Number(row[field]) || 0), 0);

/** @param {Record<string, any> | undefined} verdict @param {Record<string, any>} constraint */
function verdictView(verdict, constraint) {
  if (!verdict || verdict.reason === "not_evaluated") return null;
  const bound = object(verdict.bound);
  const side = constraint.op === "<=" ? bound.upper : bound.lower;
  return { status: verdict.status, statusText: VCR_CONSTRAINT_STATUS_TEXT_ZH[/** @type {keyof typeof VCR_CONSTRAINT_STATUS_TEXT_ZH} */ (verdict.status)] ?? null,
    final: verdict.final === true, reason: verdict.reason ?? null, boundKind: bound.kind ?? null, confidence: bound.confidence ?? null,
    // which exact calibration a nominal pass rests on, and whether a nominal level was asked for a test that has none (stats P1-2)
    calibration: bound.calibration ?? null, nominalNotExact: bound.nominalNotExact === true,
    // what precision would decide an inconclusive verdict: replicates, or the reason none would (stats P1-1)
    needed: verdict.needed ? { replicates: verdict.needed.replicates ?? null, reason: verdict.needed.reason ?? null } : null,
    judgedAt: side == null ? null : measureValue({ name: constraint.measure, value: side, source: "calculated" }, { kind: "experiment_candidate" }) };
}
