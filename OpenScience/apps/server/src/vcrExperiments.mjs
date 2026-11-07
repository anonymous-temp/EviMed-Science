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
  vcrCampaignInitialState, vcrCampaignManifest, vcrCampaignRecord, vcrCampaignVerdict, vcrCampaignDrawKey, vcrCampaignSeed, vcrCandidateVerdicts,
  vcrDesignExperiment, vcrDesignExperimentCanonical, vcrDiseaseHypothesis, vcrEvaluationContrast, vcrEvaluationMeasure, vcrExperimentAlignment,
  VCR_DISEASE_EXPERIMENT_ALIGNED_FIELDS,
} from "@evimed/domain";
import { HttpError } from "./security.mjs";
import { finishPremises } from "./vcrPremises.mjs";
import { ALZHEIMER_PARAMETERS_TEXT, ALZHEIMER_REGULATORY_TEXT, ALZHEIMER_REPRODUCTION_TEXT, alzheimerScopeText } from "./vcrProgression.mjs";
import { measureLabel, measureValue } from "./vcrViewsKit.mjs";

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
  unsupported_candidate: "候选方案都无法用所选方法计算。",
  persistent_model_failure: "计算连续失败，已停止，未完成的方案没有结果。",
  user_cancellation: "已按要求停止，已完成的方案保留。",
  no_feasible_beneficial_candidate: "没有找到在预先设定的约束下可行且优于参照的方案。",
  // no finalist failed a constraint, but at least one could not be decided at the precision used: never worded as “no feasible design”
  inconclusive_at_precision: "没有方案被确认不满足约束，但有方案在现有复核次数下无法确定是否满足；增加复核次数，才可能判断出来。",
});
export const VCR_CANDIDATE_STATUS_TEXT_ZH = Object.freeze({
  pending: "待评估", screened: "已初筛", finalist: "入围复核", evaluated: "已复核", eliminated: "已排除", failed: "计算失败", unsupported: "无法计算",
});
export const VCR_CONSTRAINT_STATUS_TEXT_ZH = Object.freeze({ pass: "满足", fail: "不满足", inconclusive: "无法确定", not_judged: "未判断" });
const CONSTRAINT_KIND_TEXT_ZH = Object.freeze({ error_control: "错误率控制", design: "设计要求", safety: "安全性" });
const COUPLING_TEXT_ZH = Object.freeze({
  paired: "同一批模拟患者上的配对比较", independent: "独立随机数上的比较", exact: "精确计算的差", same_seed_different_draws: "随机数不一致，不给出差值的误差",
  paired_without_replicates: "配对，但这个指标没有逐次结果，不给出误差", unavailable: "缺少这个指标",
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
    this.counters = { campaigns: 0, experiments: 0, units: 0, unsupported: 0, repaired: 0, stopped: 0, enqueueFailed: 0 };
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
    const { manifest, issues } = vcrCampaignManifest(input);
    if (!manifest) throw invalid("vcr_campaign_invalid", "实验方案不完整或不允许：", issues);
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
        this.counters.enqueueFailed += 1;
        this.report(String(/** @type {any} */ (error)?.code ?? "vcr_experiment_enqueue_failed"));
        return;
      }
      this.counters.units += 1;
      await this.store.query(`UPDATE ${SCHEMA}.experiments SET state = jsonb_set(state, '{inFlight,jobId}', to_jsonb($3::text)), revision = revision + 1, updated_at = now()
        WHERE id = $1 AND study_id = $2 AND state->'inFlight'->>'unitKey' = $4 AND state->'inFlight'->>'jobId' IS NULL`, [id, studyId, job.id, unit.key]);
      // a unit deduplicated onto a job that already ended (a restart after the job finished) is recorded now
      if (TERMINAL.has(String(job.state))) { await this.#settle(studyId, id, unit.key, job.id); continue; }
      return;
    }
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
    const rows = await this.store.rows(`SELECT id, study_id, state FROM ${SCHEMA}.experiments WHERE kind = 'campaign' AND status = 'running'
      ORDER BY updated_at LIMIT $1`, [Number(this.config.vcrCompletionReconcileBatch ?? 20)]);
    let repaired = 0;
    for (const row of rows) {
      const flight = object(object(row.state).inFlight);
      try {
        if (flight.jobId) {
          const job = await this.store.one(`SELECT state FROM ${SCHEMA}.jobs WHERE id = $1`, [flight.jobId]);
          if (!job || !TERMINAL.has(String(job.state))) continue;
          await this.#settle(String(row.study_id), String(row.id), String(flight.unitKey), String(flight.jobId));
        }
        await this.advance(String(row.study_id), String(row.id));
        repaired += 1;
      } catch (error) { this.report(String(/** @type {any} */ (error)?.code ?? "vcr_experiment_repair_failed")); }
    }
    this.counters.repaired += repaired;
    return { campaigns: rows.length, repaired };
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
    const identity = sha256(vcrDesignExperimentCanonical(record));
    const id = `exp_${sha256(`${study.id}:${identity}`).slice(0, 24)}`;
    const inserted = await this.store.one(`INSERT INTO ${SCHEMA}.experiments (id, study_id, user_id, kind, identity, manifest, state, origin)
      VALUES ($1, $2, $3, 'experiment', $4, $5::jsonb, '{"arms":{}}'::jsonb, $6::jsonb) ON CONFLICT (study_id, kind, identity) DO NOTHING RETURNING id`,
    [id, study.id, String(userId), identity, JSON.stringify(record), JSON.stringify(originOf(origin))]);
    if (inserted) this.counters.experiments += 1;
    /** @type {Record<string, any>} */
    const arms = {};
    // the arms queued so far are written down whatever happens to the next one, so a failed start keeps what it began (review eng P2-4)
    const keep = async () => this.store.query(`UPDATE ${SCHEMA}.experiments SET state = $3::jsonb, revision = revision + 1, updated_at = now() WHERE id = $1 AND study_id = $2`,
      [id, study.id, JSON.stringify({ arms })]);
    try {
      for (const arm of record.arms) {
        if (arm.resultId) { arms[arm.name] = { resultId: arm.resultId }; continue; }
        const kind = Object.entries(/** @type {Record<string, string>} */ (VCR_JOB_METHODS)).find(([, method]) => method === arm.method)?.[0];
        const campaignInfo = /** @type {Record<string, any>} */ (VCR_CAMPAIGN_METHODS)[arm.method];
        const runsWithBlock = Boolean(campaignInfo) && campaignInfo.exact !== true && campaignInfo.precisionBlock !== false;
        const scenario = runsWithBlock ? { ...arm.scenario, evaluation: { version: 1 } } : arm.scenario;
        // arms that draw identically share a seed, so their comparison can be paired; the engine's draw signature confirms it
        const drawKey = arm.method === "design.simulate" ? vcrCampaignDrawKey({ space: { method: arm.method, scenario: arm.scenario } }, { key: arm.name, set: {} }) : `own:${arm.name}`;
        try {
          const { job } = await this.jobs.enqueue({ studyId: study.id, userId: String(userId), kind, scenario, inputs: [], internal: true,
            seed: vcrCampaignSeed(identity, "experiment", "arm", drawKey), idempotencyKey: `vcr-experiment:${identity.slice(0, 24)}:${sha256(arm.name).slice(0, 12)}`,
            detail: { resultKind: "experiment_candidate", subjectId: `${id}:${sha256(arm.name).slice(0, 12)}`, experiment: { id, arm: arm.name } } });
          arms[arm.name] = { jobId: job.id };
        } catch (error) {
          if (Number(/** @type {any} */ (error)?.status) !== 400) throw error;
          arms[arm.name] = { refused: list(/** @type {any} */ (error)?.issues).map((issue) => String(object(issue).code)).slice(0, 5) };
        }
      }
    } finally {
      await keep();
    }
    return { created: Boolean(inserted), ...(await this.view(study, id)) };
  }

  // --- reading ------------------------------------------------------------------------------------------------------------------

  /** The study's experiments and campaigns, newest first, as summaries. @param {{ id: string }} study */
  async list(study) {
    const rows = await this.store.rows(`SELECT * FROM ${SCHEMA}.experiments WHERE study_id = $1 ORDER BY created_at DESC LIMIT 100`, [study.id]);
    return rows.map((row) => ({ id: String(row.id), kind: String(row.kind), question: String(object(row.manifest).question ?? ""), status: String(row.status),
      stopReason: object(object(row.state).stop).reason ?? null, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }));
  }

  /** One experiment or campaign as the page and the conversation read it. @param {{ id: string }} study @param {string} id */
  async view(study, id) {
    const row = await this.store.one(`SELECT * FROM ${SCHEMA}.experiments WHERE id = $1 AND study_id = $2`, [id, study.id]);
    if (!row) throw new HttpError(404, "vcr_experiment_not_found", "这个实验不属于本研究。");
    return row.kind === "campaign" ? presentCampaign(row) : this.#presentExperiment(study, row);
  }

  /** @param {{ id: string }} study @param {any} row */
  async #presentExperiment(study, row) {
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
    const comparison = list(record.comparison?.measures).map((name) => ({
      measure: name, label: measureLabel(name),
      arms: arms.map((arm) => {
        const measure = arm.evaluation ? vcrEvaluationMeasure(arm.evaluation, name) : null;
        // the measure's name rides with its value, so the model boundary's by-name rule can judge it
        return { name: arm.name, status: arm.status, value: measure ? { name, ...measureValue(measure, { kind: "experiment_candidate" }) } : null, precision: measure?.precision ?? null };
      }),
      contrasts: reference?.evaluation ? arms.filter((arm) => arm !== reference && arm.evaluation).map((arm) => {
        const contrast = vcrEvaluationContrast(/** @type {any} */ (arm.evaluation), reference.evaluation, name);
        return { arm: arm.name, against: reference.name, coupling: contrast.coupling, couplingText: COUPLING_TEXT_ZH[/** @type {keyof typeof COUPLING_TEXT_ZH} */ (contrast.coupling)] ?? null,
          difference: contrast.difference == null ? null : { name, ...measureValue({ name, value: contrast.difference, mcse: contrast.mcse ?? undefined, simulated: contrast.mcse != null }, { kind: "experiment_candidate" }) } };
      }) : [],
    }));
    const alignment = vcrExperimentAlignment(arms.map((arm) => ({ name: arm.name, scenario: arm.scenario })), disease ? VCR_DISEASE_EXPERIMENT_ALIGNED_FIELDS : undefined);
    const incomplete = arms.filter((arm) => arm.status !== "complete").map((arm) => arm.name);
    return {
      id: String(row.id), kind: "experiment", experimentKind: disease ? "disease" : "design", question: String(record.question ?? ""), purpose: String(record.purpose ?? ""),
      status: incomplete.some((name) => arms.find((arm) => arm.name === name)?.status === "running") ? "running" : "complete",
      arms: arms.map(({ evaluation: _e, scenario: _s, beyond: _b, ...arm }) => arm), comparison, alignment: alignment.map(({ values: _v, ...rest }) => rest), incomplete,
      premises: finishPremises([
        { key: "lab:aligned", label: "比较的前提", value: alignment.every((entry) => entry.aligned) ? "各组用同一个终点和同一套分析设置。"
          : `各组的${alignment.filter((entry) => !entry.aligned).map((entry) => ALIGNED_FIELD_TEXT_ZH[/** @type {keyof typeof ALIGNED_FIELD_TEXT_ZH} */ (entry.field)]).join("、")}不一致或未知，差值只能对照着看。`,
          source: "given", decisive: true },
        // no general disclaimer: the comparison's alignment and each arm's own scenario already say what it rests on
        ...(disease ? diseasePremises(arms.some((arm) => arm.beyond), arms.map((arm) => object(arm.scenario))) : []),
        ...(incomplete.length ? [{ key: "lab:incomplete", label: "未完成的组", value: `${incomplete.join("、")}还没有可比较的结果，比较中缺少它们。`, source: /** @type {const} */ ("given"), decisive: true }] : []),
      ]),
      createdAt: iso(row.created_at),
    };
  }
}

const ALIGNED_FIELD_TEXT_ZH = Object.freeze({ endpoint: "终点", "analysis.alpha": "检验水准", "analysis.sided": "单双侧", hypothesis: "假设类型", timeUnit: "时间单位",
  visits: "随访时间点", design: "每组人数", model: "模型设置", population: "入组人群", placebo: "安慰剂反应设置", dropoutModel: "脱落设置",
  "analysis.kind": "分析方法", "analysis.visit": "分析所在的随访点" });
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
    { key: "progression:ad:scope", label: "适用范围", value: alzheimerScopeText(beyond || last > ALZHEIMER_DATA_WEEKS, last), source: /** @type {const} */ ("literature"), decisive: true },
    { key: "progression:ad:reproduction", label: "复现情况", value: ALZHEIMER_REPRODUCTION_TEXT, source: /** @type {const} */ ("literature"), decisive: false },
    { key: "progression:ad:regulatory", label: "监管认可", value: ALZHEIMER_REGULATORY_TEXT, source: /** @type {const} */ ("literature"), decisive: false },
  ];
}
/** The two years of data the Alzheimer parameter set rests on, in weeks (the engine's own constant). */
const ALZHEIMER_DATA_WEEKS = 104;

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
      statusText: VCR_CANDIDATE_STATUS_TEXT_ZH[/** @type {keyof typeof VCR_CANDIDATE_STATUS_TEXT_ZH} */ (entry.status)] ?? "待评估",
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
    againstReference: versus ? { coupling: versus.coupling, couplingText: COUPLING_TEXT_ZH[/** @type {keyof typeof COUPLING_TEXT_ZH} */ (versus.coupling)] ?? null,
      difference: versus.difference == null ? null : measureValue({ name: manifest.objective.measure, value: versus.difference, mcse: versus.mcse ?? undefined, simulated: versus.mcse != null }, { kind: "experiment_candidate" }) } : null,
    inFlight: state.inFlight ? { unit: state.inFlight.unitKey, stage: object(state.inFlight.unit).stage ?? null } : null,
    cancelRequested: state.cancelRequested === true, stop,
    premises: finishPremises([
      ...(errorControl.length ? [{ key: "alpha", label: "第一类错误", value: `固定为 ${percentWord(alpha)}，搜索中不能放宽。`, source: /** @type {const} */ ("given"), decisive: true }] : []),
      { key: "campaign:precision", label: "初筛与复核", value: screeningSize
        ? `初筛每个方案模拟 ${screeningSize} 次，只用来排序和排除明显不满足的方案；入围方案另做一批独立模拟、按方法的正常次数重算后，才判断是否满足约束。`
        : "每个方案按方法的正常精度计算一次，直接判断是否满足约束。", source: "given", decisive: !disease },
      { key: "campaign:bound", label: "约束怎样算满足", value: boundPremiseText(list(manifest.constraints)), source: "given", decisive: true },
      ...(disease
        ? diseasePremises(false, [object(object(manifest.space).scenario), ...vcrCampaignCandidates(manifest).map((candidate) => object(candidate.set))])
        : (() => {
          // the one sentence that decides this result: which efficacy hypotheses were simulated
          const names = list(manifest.space?.truths).map((truth) => String(truth.name)).filter(Boolean);
          return names.length ? [{ key: "campaign:conditional", label: "疗效假设", value: `结果是在“${names.join("”“")}”这 ${names.length} 个疗效假设下模拟的；疗效假设变了，最优方案可能不同。`, source: /** @type {const} */ ("assumed"), decisive: true }] : [];
        })()),
      { key: "campaign:frozen", label: "开始前已固定的评价方式", value: "目标、约束、疗效假设和每个阶段的模拟次数在开始前已固定；改动任何一项就是一个新的实验方案。", source: "given", decisive: false },
    ]),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
  };
}

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
    judgedAt: side == null ? null : measureValue({ name: constraint.measure, value: side, source: "calculated" }, { kind: "experiment_candidate" }) };
}
