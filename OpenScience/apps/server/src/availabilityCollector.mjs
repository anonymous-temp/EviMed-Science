/**
 * The hosted receipt collector: finished runs, joined to what they used and
 * produced, folded into the availability records.
 *
 * Hidden knowledge: the platform already recorded what a deployment did — the
 * run ledger, the persisted transcripts, the result versions, the settled spend
 * — but each in its own place, and none of it reached the product's statement
 * about what is available. The release audit probed from outside and kept its
 * evidence to itself. This is the join, made afterwards and by the control
 * plane, from records that already existed: it adds no ledger for runs to
 * write and asks nothing of a run.
 *
 * One leased job per finished run, keyed by the run, so the same run is never
 * enqueued twice however often the finish hook fires or a sweep passes. The job
 * reads the run, its transcript, its result versions and its cost, and folds
 * the observations in the same transaction that completes the job
 * (`ProductJobs.finishWithLease`): a replay either finds the job done or rolls
 * the fold back whole, which is the whole of "idempotent across replays".
 *
 * A sweep per account catches the two things the hook cannot: the runs that
 * finished before this existed, and a finish whose enqueue failed. It only
 * enqueues the runs no job exists for; it never folds anything itself.
 *
 * Nothing here ever refuses, hides or delays a run: the hook swallows its own
 * failure, and a collector that is down leaves the labels `unverified`.
 *
 * @module availabilityCollector
 */

import { randomUUID } from "node:crypto";
import { HttpError } from "./security.mjs";
import { observationsOfRun } from "./availabilityObservation.mjs";
import { AVAILABILITY_JOB_KIND, availabilityRunKey } from "./availabilityStore.mjs";
import { isInternalProject, isSelfMeasurementProject } from "./internalProjects.mjs";

const TERMINAL = new Set(["succeeded", "failed", "canceled"]);

/** A run this recent ran under the skill bodies that are deployed now; an older one may not have. */
const FRESH_RUN_MS = 60 * 60 * 1000;

/** At most this many run jobs one sweep enqueues for one account; the rest wait for the next pass. */
const MAX_PER_SWEEP = 5_000;

/**
 * Whether a project's runs are evidence about the deployment. The platform's own
 * background work (the learning loop, document understanding, evaluation cells)
 * runs internal capabilities nobody chose and would double the jobs for nothing;
 * the acceptance and audit projects are the platform measuring itself *by
 * using it as an ordinary account does*, which is exactly the evidence wanted.
 * @param {string} projectId @returns {boolean}
 */
export function collectableProject(projectId) {
  return !isInternalProject(projectId) || isSelfMeasurementProject(projectId);
}

/** @param {any} value @returns {string} a bounded error code */
function codeOf(value) {
  return typeof value?.code === "string" && /^[a-z][a-z0-9_.-]{0,63}$/.test(value.code) ? value.code : "availability_collect_failed";
}

export class AvailabilityCollector {
  /**
   * @param {{
   *   jobs: any,
   *   store: import("./availabilityStore.mjs").AvailabilityStore,
   *   documents: any,
   *   resolveProject: (userId: string, projectId: string) => Promise<any | null>,
   *   readRuns: (project: any) => Promise<any[]>,
   *   readTranscript: (project: any, runId: string) => Promise<{ messages: any[] } | null>,
   *   costOf: (project: any, run: any) => Promise<number | null>,
   *   listFinishedRuns: (userId: string) => Promise<{ projectId: string, runId: string }[]>,
   *   manifestOf: (capabilityId: string) => Promise<{ manifest: any, bodyDigest: string | null } | null>,
   *   runtimeMode?: string,
   *   now?: () => Date,
   *   report?: (code: string) => void,
   * }} dependencies
   */
  constructor({ jobs, store, documents, resolveProject, readRuns, readTranscript, costOf, listFinishedRuns, manifestOf, runtimeMode = "kernel", now = () => new Date(), report = () => {} }) {
    this.jobs = jobs;
    this.store = store;
    this.documents = documents;
    this.resolveProject = resolveProject;
    this.readRuns = readRuns;
    this.readTranscript = readTranscript;
    this.costOf = costOf;
    this.listFinishedRuns = listFinishedRuns;
    this.manifestOf = manifestOf;
    this.runtimeMode = runtimeMode;
    this.now = now;
    this.report = report;
  }

  /**
   * The finish hook: queue the one job this run will ever have. Idempotent on
   * the run, never throws — a run that has ended is not held up by this.
   * @param {{ id: string, userId: string }} project @param {{ id?: string, status?: string }} run @returns {Promise<boolean>} whether a job exists for it now
   */
  async enqueueRun(project, run) {
    try {
      if (this.runtimeMode === "mock" || !run?.id || !TERMINAL.has(String(run.status)) || !collectableProject(project.id)) return false;
      await this.jobs.enqueue(project.userId, AVAILABILITY_JOB_KIND, { projectId: project.id, runId: run.id }, {
        idempotencyKey: availabilityRunKey(project.id, run.id), projectId: project.id, maxAttempts: 3,
      });
      return true;
    } catch (error) {
      this.report(codeOf(error));
      return false;
    }
  }

  /**
   * Queue the sweep of one account for one period. One per account per period
   * however often the timer fires, so two replicas do not sweep twice.
   * @param {string} userId @param {string} period
   */
  async enqueueSweep(userId, period) {
    return this.jobs.enqueue(userId, AVAILABILITY_JOB_KIND, { sweep: true, period }, {
      idempotencyKey: `availability:sweep:v1:${period}:${userId}`, maxAttempts: 2,
    });
  }

  /**
   * Do one claimed job. The caller owns the lease and its renewal.
   * @param {{ id: string, userId: string, leaseToken: string, payload: Record<string, any> }} job
   */
  async process(job) {
    return job.payload.sweep === true ? this.#sweep(job) : this.#collect(job);
  }

  /** @param {any} job */
  async #sweep(job) {
    const found = (await this.listFinishedRuns(job.userId)).filter((row) => collectableProject(row.projectId)).slice(0, MAX_PER_SWEEP);
    const known = await this.store.knownRunKeys(job.userId);
    let enqueued = 0;
    for (const row of found) {
      const key = availabilityRunKey(row.projectId, row.runId);
      if (known.has(key)) continue;
      await this.jobs.enqueue(job.userId, AVAILABILITY_JOB_KIND, { projectId: row.projectId, runId: row.runId }, {
        idempotencyKey: key, projectId: row.projectId, maxAttempts: 3,
      });
      enqueued += 1;
    }
    return this.jobs.finish(job.userId, job.id, job.leaseToken, { sweep: true, runs: found.length, enqueued });
  }

  /** @param {any} job */
  async #collect(job) {
    const projectId = String(job.payload.projectId ?? "");
    const runId = String(job.payload.runId ?? "");
    const closed = (/** @type {string} */ skipped) => this.jobs.finish(job.userId, job.id, job.leaseToken, { skipped });
    const project = projectId ? await this.resolveProject(job.userId, projectId) : null;
    if (!project) return closed("project_unavailable");
    const run = (await this.readRuns(project)).find((row) => row?.id === runId);
    if (!run) return closed("run_unavailable");
    if (!TERMINAL.has(String(run.status))) throw new HttpError(409, "availability_run_open", "The run has not finished.");

    // Each join is read on its own and a failure to read one leaves that half
    // unknown rather than failing the rest: a transcript that cannot be read
    // costs the tool observations of one run, and says so by recording none.
    const transcript = await this.readTranscript(project, runId).catch(() => null);
    const results = await this.#resultVersions(project, runId).catch(() => ({ total: 0, bound: 0 }));
    const costCny = await this.costOf(project, run).catch(() => null);
    const capability = typeof run.effectiveAgentId === "string" ? await this.manifestOf(run.effectiveAgentId) : null;
    const finishedAt = Date.parse(String(run.finishedAt ?? ""));
    const fresh = Number.isFinite(finishedAt) && this.now().getTime() - finishedAt < FRESH_RUN_MS;
    const observations = observationsOfRun({
      run, projectId, manifest: capability?.manifest ?? null, messages: transcript?.messages ?? null, results, costCny,
      bodyDigest: fresh ? capability?.bodyDigest ?? null : null,
    });
    return this.jobs.finishWithLease(job.userId, job.id, job.leaseToken, { runId, observations: observations.length, status: run.status },
      (/** @type {any} */ client) => this.store.foldMany(client, observations));
  }

  /**
   * The result versions this run produced, and how many of them have a digest
   * bound to their producer's own receipt. Joined on the run id the capture
   * recorded as the producer, through the product ledger's payload index.
   * @param {{ id: string, userId: string }} project @param {string} runId
   */
  async #resultVersions(project, runId) {
    const page = await this.documents.list(project.userId, "result-version", {
      limit: 100, projectId: project.id, filter: { producer: { runId } }, fields: { coverage: true },
    });
    const bound = page.items.filter((/** @type {any} */ item) => item.payload?.coverage?.producer === "bound").length;
    return { total: page.items.length, bound };
  }
}

/**
 * The worker: claims the collector's jobs, a bounded number per wake, and gives
 * each its lease and its retry. Durable jobs carry ownership across restarts;
 * timers only wake the next claim.
 */
export class AvailabilityWorker {
  /**
   * @param {{ jobs: any, collector: AvailabilityCollector, canRun?: () => boolean, pollMs?: number, leaseMs?: number,
   *   perTick?: number, report?: (code: string) => void }} dependencies
   */
  constructor({ jobs, collector, canRun = () => true, pollMs = 2_000, leaseMs = 120_000, perTick = 25, report = () => {} }) {
    this.jobs = jobs;
    this.collector = collector;
    this.canRun = canRun;
    this.pollMs = pollMs;
    this.leaseMs = leaseMs;
    this.perTick = perTick;
    this.report = report;
    this.workerId = `availability-${randomUUID()}`;
    /** @type {ReturnType<typeof setInterval> | null} */
    this.timer = null;
    /** @type {Promise<number> | null} */
    this.running = null;
    this.lastError = null;
    this.lastCompletedAt = null;
    this.processed = 0;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.pollMs);
    this.timer.unref?.();
    void this.tick();
  }

  async close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  /** @returns {Promise<number>} how many jobs this wake did */
  async tick() {
    if (this.running) return this.running;
    this.running = this.#drain().catch((error) => {
      this.lastError = codeOf(error);
      this.report(this.lastError);
      return 0;
    }).finally(() => { this.running = null; });
    return this.running;
  }

  async #drain() {
    let done = 0;
    while (done < this.perTick && this.canRun()) {
      const job = await this.jobs.claim([AVAILABILITY_JOB_KIND], this.workerId, { leaseMs: this.leaseMs });
      if (!job) break;
      await this.#run(job);
      done += 1;
    }
    return done;
  }

  /** @param {any} job */
  async #run(job) {
    let leaseLost = false;
    const renewal = setInterval(() => {
      void this.jobs.renew(job.userId, job.id, job.leaseToken, this.leaseMs)
        .then((/** @type {boolean} */ renewed) => { if (!renewed) leaseLost = true; })
        .catch(() => { leaseLost = true; });
    }, Math.max(1_000, Math.floor(this.leaseMs / 3)));
    renewal.unref?.();
    try {
      await this.collector.process(job);
      this.lastError = null;
      this.lastCompletedAt = new Date().toISOString();
      this.processed += 1;
    } catch (error) {
      const code = codeOf(error);
      this.lastError = code;
      if (!leaseLost && code !== "product_job_lease_lost") {
        // Retried by the job's own attempt budget and then given up; a sweep
        // finds a job that gave up and the hourly re-arm gives it another go.
        await this.jobs.fail(job.userId, job.id, job.leaseToken, { code, message: "The availability collection did not complete." },
          { retry: true, delayMs: code === "availability_run_open" ? 30_000 : 60_000 })
          .catch(() => {});
      }
    } finally {
      clearInterval(renewal);
    }
  }
}
