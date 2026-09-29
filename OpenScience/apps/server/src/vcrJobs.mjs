/**
 * 「虚拟临研」's deterministic work: the job queue in front of `vcr-engine`
 * (build plan 2026-09-28 §11.4, build contract §3.3).
 *
 * A job is not a run. It does not take the study's one run slot, it is not
 * dispatched to a kernel, and a two-hour simulation never blocks the
 * researcher's conversation — that division is the one thing 「循证 GEO」 said
 * was most worth copying here (attachment E §2.2): the steps that *think* run
 * as AI runs, the steps that *compute* run as platform jobs.
 *
 * Hidden knowledge:
 *
 * - **A job is frozen, never referenced.** Every assumption value, population
 *   version, snapshot hash, method version, seed and replicate count is
 *   copied into the row at enqueue. Re-reading an assumption at run time would
 *   make a result unreproducible the moment anyone edits one, which is exactly
 *   the moment reproducibility matters (AC-04).
 * - **The seed is derived from the scenario, not drawn.** Two enqueues of the
 *   same frozen scenario ask for the same numbers, and a rerun after a restart
 *   is the same run rather than a second sample. A caller that wants a second
 *   independent sample says so with its own seed.
 * - **Over budget stops, everything else does not** (plan §10.1: 人只在三处停).
 *   A job whose CPU-second ceiling would take the study past its budget is
 *   written `awaiting_budget` and waits for one confirmation; it is not
 *   refused, not silently shrunk, and nothing else in the study waits for it.
 * - **Cancel is immediate** (AC-38): the row moves to `canceled` in the same
 *   statement that records the request, and the engine is told afterwards on a
 *   best-effort basis. A cancel that waited for the engine to answer would be
 *   a cancel the user watched spin.
 * - **Failure keeps what was computed** (principle 19, AC-19): the checkpoint
 *   stays on the row, and measures the engine managed to return before it
 *   failed are recorded as a result marked `partial` with the conclusion
 *   `limited`. A failed job never writes a zero.
 * - **`matching.evaluate` does not go to the engine.** Criterion evaluation is
 *   Kleene three-valued logic over structured facts — code, not statistics —
 *   and it runs in the control plane through an injected local executor (the
 *   matching package's). The queue is the same so the study reads one ledger.
 *
 * @module vcrJobs
 */

import { createHash } from "node:crypto";

import {
  VCR_ENGINE_METHODS, VCR_ENGINE_PROTOCOL_VERSION, VCR_JOB_KINDS, VCR_JOB_METHODS, VCR_JOB_STATES,
  canonicalScenarioJson, replicateFloor, validateEngineJob,
} from "@evimed/domain";

import { VCR_SCHEMA } from "./vcrPersistence.mjs";
import { vcrId } from "./vcrStoreBase.mjs";
import { jobSummaryFromRow } from "./vcrStore.mjs";
import { HttpError } from "./security.mjs";

/** States a job may still move out of. */
export const VCR_JOB_OPEN_STATES = Object.freeze(["queued", "running", "awaiting_budget"]);
/** States nothing moves out of. */
export const VCR_JOB_TERMINAL_STATES = Object.freeze(["succeeded", "failed", "canceled"]);
/** How long a claimed job may run before another worker may take it. */
export const VCR_JOB_DEFAULT_LEASE_MS = 900_000;
/** Attempts before a job stops retrying on a failure that waiting could clear. */
export const VCR_JOB_MAX_ATTEMPTS = 3;

/** @param {unknown} value */
const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {});
/** @param {unknown} value */
const list = (value) => (Array.isArray(value) ? value : []);
/** @param {unknown} error */
const codeOf = (error) => (typeof /** @type {any} */ (error)?.code === "string" ? /** @type {any} */ (error).code : "vcr_job_failed");

/** The sha256 of a scenario's canonical bytes — the same bytes the engine hashes. @param {unknown} scenario */
export function vcrScenarioHash(scenario) {
  return createHash("sha256").update(canonicalScenarioJson(scenario ?? {})).digest("hex");
}

/**
 * The seed a scenario gets when the caller does not name one: the first 31
 * bits of its own hash. Deterministic, inside the protocol's range, and it
 * makes 「同一个冻结场景 = 同一次运行」 true without a counter anyone keeps.
 * @param {string} scenarioHash
 */
export function vcrSeedFor(scenarioHash) {
  return Number.parseInt(String(scenarioHash).slice(0, 8), 16) % 2_147_483_647;
}

/** How many replicates a simulation scenario needs, when the caller named none. @param {Record<string, any>} scenario */
export function vcrReplicatesFor(scenario) {
  const truth = object(scenario?.truth);
  const isNull = truth.isNull === true || truth.effect === 0;
  const target = Number(scenario?.targetMcse);
  return replicateFloor({ isNull, targetMcse: Number.isFinite(target) && target > 0 ? target : null });
}

/** Job kinds whose work is heavy enough to be the study's budget question. */
const HEAVY_KINDS = new Set(["design_simulation", "design_grid", "assurance", "synthesize_population", "generate_patients"]);

export class VcrJobs {
  /**
   * @param {{ store: import("./vcrStore.mjs").VcrStore, config?: Record<string, any>, engine?: any,
   *   localExecutors?: Record<string, (input: { job: Record<string, any>, onProgress: (progress: { done: number, total: number }) => Promise<unknown> }) => Promise<any>>,
   *   notifier?: { budgetConfirm?: (study: any, job: any) => Promise<unknown> } | null,
   *   now?: () => Date, report?: (code: string) => void }} dependencies
   *   `localExecutors` is keyed by method id (`matching.evaluate` is the
   *   matching package's); anything not named there goes to the engine.
   */
  constructor({ store, config = {}, engine = null, localExecutors = {}, notifier = null, now = () => new Date(), report = () => {} }) {
    if (!store) throw new TypeError("The VCR job queue needs the VCR store.");
    this.store = store;
    this.config = config;
    this.engine = engine;
    this.localExecutors = localExecutors ?? {};
    this.notifier = notifier;
    this.now = now;
    this.report = report;
    this.owner = `vcr-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
    this.counters = { enqueued: 0, deduplicated: 0, claimed: 0, dispatched: 0, succeeded: 0, failed: 0, canceled: 0,
      awaitingBudget: 0, partial: 0 };
    /** @type {string | null} */
    this.lastError = null;
  }

  get maxConcurrent() { return Math.max(1, Number(this.config.vcrMaxConcurrentJobs ?? 1)); }
  get jobCpuSeconds() { return Math.max(10, Number(this.config.vcrJobCpuSeconds ?? 600)); }
  get leaseMs() { return Math.max(60_000, Number(this.config.vcrLeaseMs ?? VCR_JOB_DEFAULT_LEASE_MS)); }

  // --- budget -----------------------------------------------------------------------

  /**
   * A study's compute budget in CPU-seconds: the deployment's default, plus
   * whatever a person has confirmed on top of it. Used is what finished jobs
   * spent; committed is what open jobs may still spend.
   * @param {string} studyId
   */
  async budgetOf(studyId) {
    const study = await this.store.studyById(studyId);
    const confirmed = Number(object(study?.budget).cpuSecondsConfirmed ?? 0);
    const limitSeconds = Math.max(0, Number(this.config.vcrStudyCpuBudget ?? 7_200)) + (Number.isFinite(confirmed) ? confirmed : 0);
    const row = await this.store.one(`SELECT
        COALESCE(SUM(cpu_seconds_used), 0)::numeric AS used,
        COALESCE(SUM(CASE WHEN state IN ('queued', 'running') THEN cpu_seconds_limit ELSE 0 END), 0)::numeric AS committed,
        COUNT(*) FILTER (WHERE state = 'awaiting_budget')::integer AS awaiting
      FROM ${VCR_SCHEMA}.jobs WHERE study_id = $1`, [studyId]);
    const used = Number(row?.used ?? 0);
    const committed = Number(row?.committed ?? 0);
    return {
      limitSeconds, usedSeconds: used, committedSeconds: committed,
      remainingSeconds: Math.max(0, limitSeconds - used - committed),
      awaitingBudget: Number(row?.awaiting ?? 0),
    };
  }

  // --- enqueue ----------------------------------------------------------------------

  /**
   * Freeze a scenario into a job row.
   *
   * @param {{ studyId: string, userId: string, kind: string, scenario?: Record<string, any>, inputs?: unknown[],
   *   seed?: number | null, replicates?: number | null, cpuSecondsLimit?: number | null, idempotencyKey?: string | null,
   *   runId?: string | null, maxAttempts?: number, detail?: Record<string, any> }} input
   * @returns {Promise<{ job: any, created: boolean }>}
   */
  async enqueue(input) {
    const kind = String(input.kind);
    if (!VCR_JOB_KINDS.includes(kind)) {
      throw new HttpError(400, "vcr_job_kind_invalid", `kind must be one of: ${VCR_JOB_KINDS.join(", ")}.`);
    }
    const method = /** @type {Record<string, string>} */ (VCR_JOB_METHODS)[kind];
    const methodVersion = /** @type {Record<string, any>} */ (VCR_ENGINE_METHODS)[method]?.version ?? "";
    const scenario = object(input.scenario);
    const scenarioHash = vcrScenarioHash(scenario);
    const seed = Number.isInteger(input.seed) ? Number(input.seed) : vcrSeedFor(scenarioHash);
    const replicates = Number.isInteger(input.replicates) && Number(input.replicates) > 0
      ? Number(input.replicates)
      : (kind === "design_simulation" || kind === "assurance" ? vcrReplicatesFor(scenario) : null);
    const cpuSecondsLimit = Math.min(this.jobCpuSeconds,
      Math.max(1, Number(input.cpuSecondsLimit ?? this.jobCpuSeconds)));
    const id = vcrId("job");
    const job = {
      jobId: id, studyId: String(input.studyId), kind, method, methodVersion,
      protocolVersion: VCR_ENGINE_PROTOCOL_VERSION, seed, replicates, cpuSecondsLimit,
      inputs: list(input.inputs), scenario,
    };
    const issues = validateEngineJob(job);
    if (issues.length) {
      throw new HttpError(400, "vcr_job_scenario_invalid",
        `作业不符合引擎协议：${issues.slice(0, 6).map((issue) => issue.field || issue.code).join("、")}。`);
    }

    const budget = await this.budgetOf(String(input.studyId));
    const overBudget = cpuSecondsLimit > budget.remainingSeconds;
    const state = overBudget ? "awaiting_budget" : "queued";

    const key = input.idempotencyKey == null ? null : String(input.idempotencyKey).slice(0, 200);
    const row = await this.store.one(`INSERT INTO ${VCR_SCHEMA}.jobs
      (id, study_id, user_id, kind, method, method_version, state, scenario, scenario_hash, inputs, seed, replicates,
       cpu_seconds_limit, max_attempts, run_id, idempotency_key, checkpoint)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb, $11, $12, $13, $14, $15, $16, $17::jsonb)
      ON CONFLICT (user_id, idempotency_key) DO UPDATE SET updated_at = now()
      RETURNING *, (xmax = 0) AS inserted`,
    [id, String(input.studyId), String(input.userId), kind, method, methodVersion, state, JSON.stringify(scenario), scenarioHash,
      JSON.stringify(list(input.inputs)), seed, replicates, cpuSecondsLimit,
      Math.max(1, Number(input.maxAttempts ?? VCR_JOB_MAX_ATTEMPTS)), input.runId ?? null, key,
      JSON.stringify({ ...object(input.detail), cost: HEAVY_KINDS.has(kind) ? "heavy" : "light" })]);
    const created = row?.inserted === true;
    if (created) {
      this.counters.enqueued += 1;
      if (overBudget) this.counters.awaitingBudget += 1;
      await this.store.audit({ studyId: String(input.studyId), userId: String(input.userId), action: "vcr.job.enqueue",
        object: String(row.id), detail: { kind, method, state, cpuSecondsLimit, scenarioHash } });
      if (overBudget && this.notifier?.budgetConfirm) {
        const study = await this.store.studyById(String(input.studyId));
        if (study) await this.notifier.budgetConfirm(study, jobSummaryFromRow(row)).catch(() => null);
      }
    } else {
      this.counters.deduplicated += 1;
    }
    return { job: jobSummaryFromRow(row), created };
  }

  /** @param {string} studyId @param {number} [limit] */
  async listForStudy(studyId, limit = 50) {
    return this.store.jobs(studyId, limit);
  }

  /** @param {string} studyId @param {string} jobId */
  async get(studyId, jobId) {
    return this.store.job(studyId, jobId);
  }

  /** The whole row, engine job id included, for the worker. @param {string} jobId */
  async #row(jobId) {
    return this.store.one(`SELECT * FROM ${VCR_SCHEMA}.jobs WHERE id = $1`, [jobId]);
  }

  // --- claim and lease ----------------------------------------------------------------

  /**
   * Take up to `limit` queued jobs, honouring the deployment's global
   * concurrency. `FOR UPDATE SKIP LOCKED`, so two control planes never take
   * the same row.
   * @param {{ workerId?: string, leaseMs?: number, limit?: number }} [options]
   */
  async claim({ workerId = this.owner, leaseMs = this.leaseMs, limit = 1 } = {}) {
    const rows = await this.store.transaction(async (client) => {
      const running = Number((await client.query(`SELECT count(*)::integer AS n FROM ${VCR_SCHEMA}.jobs
        WHERE state = 'running' AND (lease_until IS NULL OR lease_until > now())`)).rows[0]?.n ?? 0);
      const free = Math.max(0, this.maxConcurrent - running);
      if (!free) return [];
      const take = Math.min(free, Math.max(1, limit));
      const picked = await client.query(`SELECT id FROM ${VCR_SCHEMA}.jobs
        WHERE (state = 'queued' AND run_after <= now())
           OR (state = 'running' AND lease_until IS NOT NULL AND lease_until < now())
        ORDER BY run_after, created_at LIMIT $1 FOR UPDATE SKIP LOCKED`, [take]);
      if (!picked.rows.length) return [];
      const ids = picked.rows.map((/** @type {any} */ row) => String(row.id));
      const claimed = await client.query(`UPDATE ${VCR_SCHEMA}.jobs
        SET state = 'running', lease_owner = $2, lease_until = now() + make_interval(secs => $3),
            attempts = attempts + 1, updated_at = now()
        WHERE id = ANY($1::text[]) RETURNING *`, [ids, workerId, Math.round(leaseMs / 1000)]);
      return claimed.rows;
    });
    this.counters.claimed += rows.length;
    return rows.map(jobSummaryFromRow);
  }

  /** Hold a claimed job's lease while it runs. @param {string} jobId @param {number} [leaseMs] */
  async renew(jobId, leaseMs = this.leaseMs) {
    return this.store.query(`UPDATE ${VCR_SCHEMA}.jobs SET lease_until = now() + make_interval(secs => $2), updated_at = now()
      WHERE id = $1 AND state = 'running'`, [jobId, Math.round(leaseMs / 1000)]);
  }

  /**
   * How far along, and the lease renewed with it: progress is what tells a
   * study that a job that died in its first minute is not one still working.
   * @param {string} jobId @param {{ done?: number, total?: number, note?: string }} progress
   */
  async progress(jobId, progress) {
    const value = {
      done: Math.max(0, Number(progress?.done ?? 0)),
      total: Math.max(0, Number(progress?.total ?? 0)),
      ...(progress?.note ? { note: String(progress.note).slice(0, 200) } : {}),
      at: this.now().toISOString(),
    };
    const row = await this.store.one(`UPDATE ${VCR_SCHEMA}.jobs
      SET progress = $2::jsonb, lease_until = now() + make_interval(secs => $3), updated_at = now()
      WHERE id = $1 AND state = 'running' RETURNING *`, [jobId, JSON.stringify(value), Math.round(this.leaseMs / 1000)]);
    return jobSummaryFromRow(row);
  }

  /**
   * A restart point. The engine writes one per batch of replicates; a job that
   * fails resumes here instead of starting over, and a job that is cancelled
   * keeps whatever this holds (plan §10.5).
   * @param {string} jobId @param {Record<string, any>} checkpoint
   */
  async checkpoint(jobId, checkpoint) {
    const row = await this.store.one(`UPDATE ${VCR_SCHEMA}.jobs
      SET checkpoint = checkpoint || $2::jsonb, lease_until = now() + make_interval(secs => $3), updated_at = now()
      WHERE id = $1 RETURNING *`, [jobId, JSON.stringify(object(checkpoint)), Math.round(this.leaseMs / 1000)]);
    return jobSummaryFromRow(row);
  }

  // --- cancel and budget --------------------------------------------------------------

  /**
   * Cancel now. The row moves in the same statement that records the request;
   * the engine is told afterwards and a failure to reach it does not un-cancel
   * anything (AC-38).
   * @param {string} studyId @param {string} jobId @param {{ actor?: string }} [options]
   */
  async cancel(studyId, jobId, { actor = "" } = {}) {
    const row = await this.store.one(`UPDATE ${VCR_SCHEMA}.jobs
      SET state = 'canceled', cancel_requested = true, finished_at = now(), updated_at = now(),
          error = COALESCE(error, '{}'::jsonb) || jsonb_build_object('code', 'vcr_job_canceled', 'actor', $3::text)
      WHERE study_id = $1 AND id = $2 AND state = ANY($4::text[]) RETURNING *`,
    [studyId, jobId, String(actor), [...VCR_JOB_OPEN_STATES]]);
    if (!row) {
      const existing = await this.store.job(studyId, jobId);
      if (!existing) throw new HttpError(404, "vcr_job_not_found", "Job not found.");
      return { job: existing, canceled: false };
    }
    this.counters.canceled += 1;
    await this.store.audit({ studyId, userId: String(row.user_id), actor, action: "vcr.job.cancel", object: jobId,
      detail: { keptCheckpoint: Object.keys(object(row.checkpoint)).length > 0 } });
    const engineJobId = object(row.checkpoint).engineJobId;
    if (engineJobId && this.engine?.cancel) await this.engine.cancel(String(engineJobId)).catch(() => null);
    return { job: jobSummaryFromRow(row), canceled: true };
  }

  /**
   * The second human stop, cleared: the confirmed CPU-seconds are added to the
   * study's budget and every job waiting on it is released in one go — a
   * person confirms a study's compute once, not once per job (plan §10.1).
   * @param {string} studyId @param {{ actor: string, cpuSeconds?: number, jobId?: string | null }} input
   */
  async confirmBudget(studyId, input) {
    const study = await this.store.studyById(studyId);
    if (!study) throw new HttpError(404, "vcr_study_not_found", "Study not found.");
    const waiting = await this.store.rows(`SELECT id, cpu_seconds_limit FROM ${VCR_SCHEMA}.jobs
      WHERE study_id = $1 AND state = 'awaiting_budget'${input.jobId ? " AND id = $2" : ""}
      ORDER BY created_at`, input.jobId ? [studyId, String(input.jobId)] : [studyId]);
    const needed = waiting.reduce((total, row) => total + Number(row.cpu_seconds_limit ?? 0), 0);
    const grant = Math.max(needed, Math.max(0, Number(input.cpuSeconds ?? 0)));
    const budget = object(study.budget);
    const confirmed = Number(budget.cpuSecondsConfirmed ?? 0) + grant;
    await this.store.updateStudy(studyId, {
      budget: { ...budget, cpuSecondsConfirmed: confirmed, lastConfirmedAt: this.now().toISOString(), lastConfirmedBy: String(input.actor) },
    }, String(input.actor));
    const released = waiting.length
      ? await this.store.rows(`UPDATE ${VCR_SCHEMA}.jobs SET state = 'queued', run_after = now(), updated_at = now()
          WHERE id = ANY($1::text[]) AND state = 'awaiting_budget' RETURNING *`, [waiting.map((row) => String(row.id))])
      : [];
    await this.store.audit({ studyId, userId: study.userId, actor: String(input.actor), action: "vcr.job.budget_confirm",
      object: studyId, detail: { grantedCpuSeconds: grant, released: released.length } });
    return { released: released.map(jobSummaryFromRow), budget: await this.budgetOf(studyId) };
  }

  // --- running one job ------------------------------------------------------------------

  /**
   * Move a claimed job one step: submit it if it has not been submitted,
   * otherwise read where it got to and finish it when it is done. Answers
   * what it did, so the worker can count.
   * @param {any} job a row shape from {@link claim}
   */
  async advance(job) {
    const row = await this.#row(job.id);
    if (!row || row.state !== "running") return { action: "skipped", state: row?.state ?? "gone" };
    if (row.cancel_requested === true) return { action: "canceled", state: "canceled" };
    const frozen = this.#engineJob(row);
    const local = this.localExecutors[String(row.method)];
    if (local) return this.#runLocal(row, frozen, local);
    if (!this.engine?.configured?.()) {
      return this.finish(String(row.id), { status: "failed", error: { code: "engine_unavailable",
        message: "计算引擎未接入本部署，这一步暂不可用。" } });
    }
    const engineJobId = object(row.checkpoint).engineJobId;
    if (!engineJobId) {
      try {
        const accepted = await this.engine.submit(frozen);
        await this.checkpoint(String(row.id), { engineJobId: accepted.jobId, submittedAt: this.now().toISOString() });
        this.counters.dispatched += 1;
        return { action: "submitted", engineJobId: accepted.jobId };
      } catch (error) {
        return this.#fail(row, error);
      }
    }
    try {
      const status = await this.engine.status(String(engineJobId));
      if (status.progress) await this.progress(String(row.id), status.progress);
      if (["queued", "running"].includes(status.state)) return { action: "waiting", state: status.state, progress: status.progress };
      const { result, signed } = await this.engine.result(String(engineJobId));
      return this.finish(String(row.id), {
        status: String(result.status), result, signed, cpuSeconds: Number(result?.manifest?.cpuSeconds ?? status.cpuSeconds ?? 0),
      });
    } catch (error) {
      return this.#fail(row, error);
    }
  }

  /**
   * A method the control plane computes itself (`matching.evaluate`). The
   * executor gets the same frozen job the engine would, so the two paths
   * cannot drift in what a result was computed from.
   * @param {any} row @param {Record<string, any>} frozen @param {Function} executor
   */
  async #runLocal(row, frozen, executor) {
    const startedAt = this.now().toISOString();
    try {
      const result = await executor({
        job: frozen,
        onProgress: (/** @type {any} */ progress) => this.progress(String(row.id), progress ?? {}),
      });
      return this.finish(String(row.id), {
        status: String(result?.status ?? "succeeded"),
        result: { ...object(result), jobId: frozen.jobId, scenarioHash: String(row.scenario_hash ?? "") },
        signed: false,
        local: true,
        startedAt,
        cpuSeconds: Number(result?.manifest?.cpuSeconds ?? 0),
      });
    } catch (error) {
      return this.#fail(row, error);
    }
  }

  /** The job as the engine protocol carries it. @param {any} row */
  #engineJob(row) {
    return {
      jobId: String(row.id), studyId: String(row.study_id), kind: String(row.kind), method: String(row.method),
      methodVersion: String(row.method_version ?? ""), protocolVersion: VCR_ENGINE_PROTOCOL_VERSION,
      seed: Number(row.seed ?? 0), replicates: row.replicates == null ? null : Number(row.replicates),
      cpuSecondsLimit: Number(row.cpu_seconds_limit ?? this.jobCpuSeconds),
      inputs: list(row.inputs), scenario: object(row.scenario),
      ...(Object.keys(object(row.checkpoint)).length ? { resumeFrom: object(row.checkpoint) } : {}),
    };
  }

  /**
   * A failure. Retryable and with tries left goes back to the queue with a
   * back-off; anything else is final — and either way the checkpoint stays,
   * because what was computed was computed (principle 19).
   * @param {any} row @param {unknown} error
   */
  async #fail(row, error) {
    const code = codeOf(error);
    const retryable = /** @type {any} */ (error)?.retryable === true;
    const attempts = Number(row.attempts ?? 0);
    this.lastError = code;
    this.report(code);
    if (retryable && attempts < Number(row.max_attempts ?? VCR_JOB_MAX_ATTEMPTS)) {
      const backoffSeconds = Math.min(600, 15 * 2 ** Math.max(0, attempts - 1));
      const requeued = await this.store.one(`UPDATE ${VCR_SCHEMA}.jobs
        SET state = 'queued', lease_owner = NULL, lease_until = NULL, run_after = now() + make_interval(secs => $2),
            error = jsonb_build_object('code', $3::text, 'message', $4::text, 'attempt', $5::integer), updated_at = now()
        WHERE id = $1 RETURNING *`,
      [String(row.id), backoffSeconds, code, String(/** @type {any} */ (error)?.message ?? "").slice(0, 400), attempts]);
      return { action: "requeued", code, job: jobSummaryFromRow(requeued) };
    }
    return this.finish(String(row.id), {
      status: "failed",
      error: { code, message: String(/** @type {any} */ (error)?.message ?? "").slice(0, 400) },
    });
  }

  /**
   * Record what a job produced and close it. A `succeeded` or `not_estimable`
   * result becomes an execution row and a result row; a `failed` one with
   * partial measures becomes a result marked partial with the conclusion
   * `limited`, so the study keeps what was computed and says what it is.
   *
   * @param {string} jobId
   * @param {{ status: string, result?: Record<string, any> | null, error?: Record<string, any> | null, signed?: boolean,
   *   local?: boolean, cpuSeconds?: number, startedAt?: string | null }} outcome
   */
  async finish(jobId, outcome) {
    const row = await this.#row(jobId);
    if (!row) throw new HttpError(404, "vcr_job_not_found", "Job not found.");
    const status = VCR_JOB_STATES.includes(String(outcome.status)) || outcome.status === "not_estimable"
      ? String(outcome.status) : "failed";
    const result = object(outcome.result);
    const measures = list(result.measures);
    const partial = status === "failed" && measures.length > 0;
    const state = status === "not_estimable" ? "succeeded" : (VCR_JOB_TERMINAL_STATES.includes(status) ? status : "failed");

    /** @type {any} */
    let execution = null;
    /** @type {any} */
    let recorded = null;
    if (measures.length || status === "succeeded" || status === "not_estimable") {
      execution = await this.store.recordExecution({
        jobId, studyId: String(row.study_id), userId: String(row.user_id), method: String(row.method),
        methodVersion: String(row.method_version ?? ""), scenarioHash: String(row.scenario_hash ?? ""),
        inputs: list(row.inputs), environment: object(result.manifest), seed: Number(row.seed ?? 0),
        replicates: row.replicates == null ? null : Number(row.replicates), outputHash: result?.manifest?.outputHash ?? null,
        receipt: { signed: outcome.signed === true, local: outcome.local === true, status },
        cpuSeconds: Number(outcome.cpuSeconds ?? result?.manifest?.cpuSeconds ?? 0),
        startedAt: outcome.startedAt ?? result?.manifest?.startedAt ?? null,
        finishedAt: result?.manifest?.finishedAt ?? this.now().toISOString(),
      });
      const study = await this.store.studyById(String(row.study_id));
      recorded = await this.store.recordResult({
        studyId: String(row.study_id), userId: String(row.user_id), executionId: execution?.id ?? null,
        // The enqueuer names the object this result belongs to when it knows
        // one; the method's own default answers for everything else.
        kind: String(object(row.checkpoint).resultKind || this.#resultKind(String(row.kind))),
        subjectId: object(row.checkpoint).subjectId ?? object(row.scenario).subjectId ?? null,
        conclusion: status === "not_estimable" ? "not_estimable" : (partial ? "limited" : (result.conclusion ?? "estimable")),
        notEstimableRule: result.notEstimableRule ?? null,
        counts: object(result.counts), measures, diagnostics: { ...object(result.diagnostics), ...(partial ? { partial: true } : {}) },
        tables: list(result.tables), models: list(result.models),
        requestedUse: study?.intendedUse ?? "exploratory",
      });
      if (partial) this.counters.partial += 1;
    }

    const finished = await this.store.one(`UPDATE ${VCR_SCHEMA}.jobs
      SET state = $2, finished_at = now(), lease_owner = NULL, lease_until = NULL, updated_at = now(),
          cpu_seconds_used = GREATEST(cpu_seconds_used, $3::numeric),
          error = $4::jsonb
      WHERE id = $1 RETURNING *`,
    [jobId, state, Number(outcome.cpuSeconds ?? 0),
      outcome.error == null && !partial ? null : JSON.stringify({ ...object(outcome.error), ...(partial ? { partial: true } : {}) })]);

    if (state === "succeeded") this.counters.succeeded += 1;
    else if (state === "failed") this.counters.failed += 1;
    await this.store.audit({ studyId: String(row.study_id), userId: String(row.user_id), action: "vcr.job.finish", object: jobId,
      outcome: state === "succeeded" ? "ok" : state,
      reason: outcome.error ? String(object(outcome.error).code ?? "") : "",
      detail: { kind: String(row.kind), resultId: recorded?.id ?? null, partial, signed: outcome.signed === true } });
    return { action: "finished", state, job: jobSummaryFromRow(finished), result: recorded, execution, partial };
  }

  /** Which `results.kind` a job kind files under. @param {string} kind */
  #resultKind(kind) {
    if (["build_cohort", "generate_population", "synthesize_population"].includes(kind)) return "population";
    if (kind === "generate_patients") return "patient_set";
    if (["weight_comparator", "rmst", "map_prior"].includes(kind)) return "comparator";
    if (["design_analytic", "design_simulation", "assurance"].includes(kind)) return "trial_scenario";
    if (kind === "design_grid") return "design_grid";
    if (kind === "match_criteria") return "matching";
    if (kind === "accrual_forecast") return "accrual_forecast";
    if (["pool_evidence", "reconstruct_km"].includes(kind)) return "evidence_pool";
    return "snapshot_profile";
  }

  /** What the worker's status line says. */
  status() {
    return {
      engine: this.engine?.configured?.() ? "wired" : "missing",
      localExecutors: Object.keys(this.localExecutors),
      maxConcurrent: this.maxConcurrent,
      lastError: this.lastError,
      counters: { ...this.counters },
    };
  }
}
