import { randomUUID } from "node:crypto";

const TERMINAL_ERRORS = new Set([
  "source_job_invalid", "source_path_invalid", "source_digest_invalid", "source_format_unsupported",
  "source_generation_stale", "source_state_conflict", "source_changed", "openlist_source_changed",
  "source_parser_input_too_large", "source_understanding_invalid", "source_understanding_run_failed", "source_understanding_usage_invalid", "source_understanding_input_too_large",
  "source_not_found", "source_account_changed", "source_cleanup_unconfigured", "source_cleanup_platform_unsupported", "source_cleanup_path_invalid",
]);

/** Leased ingestion worker. ProductJobs owns retries; source generations make
 * an old lease unable to overwrite a newer user correction. */
export class SourceIngestionWorker {
  /** @param {{jobs:any,sources:any,parser:any,resolveSource:(job:any,source:any)=>Promise<string|{localPath:string,parserPath:string,stagingPath?:string}>,releaseResolved?:(job:any,source:any,file:any)=>Promise<void>,materialize:(job:any,source:any,result:any)=>Promise<string>,discardMaterialized?:(job:any,source:any,artifactPath:string)=>Promise<void>,cleanupSource?:(job:any,source:any,jobIds:string[],scope:any)=>Promise<void>,prepareCleanup?:(job:any)=>Promise<any>,understandingRuns?:any,cancelUnderstanding?:any,pollMs?:number,leaseMs?:number,reconcileMs?:number}} dependencies */
  constructor({ jobs, sources, parser, resolveSource, releaseResolved = async () => {}, materialize, discardMaterialized = async () => {}, cleanupSource = null, prepareCleanup = async () => null, understandingRuns = null, cancelUnderstanding = null, pollMs = 1000, leaseMs = 900_000, reconcileMs = 60_000 }) {
    if (![jobs, sources, parser, resolveSource, materialize].every(Boolean)) throw new TypeError("SourceIngestionWorker dependencies are required.");
    if (!Number.isSafeInteger(pollMs) || pollMs < 100 || pollMs > 86_400_000
      || !Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 3_600_000
      || !Number.isSafeInteger(reconcileMs) || reconcileMs < 1000 || reconcileMs > 86_400_000) {
      throw new TypeError("Invalid source ingestion worker interval.");
    }
    this.jobs = jobs;
    this.sources = sources;
    this.parser = parser;
    this.resolveSource = resolveSource;
    this.releaseResolved = releaseResolved;
    this.materialize = materialize;
    this.discardMaterialized = discardMaterialized;
    this.cleanupSource = cleanupSource;
    this.prepareCleanup = prepareCleanup;
    this.understandingRuns = understandingRuns;
    this.cancelUnderstanding = cancelUnderstanding;
    this.pollMs = pollMs;
    this.leaseMs = leaseMs;
    this.reconcileMs = reconcileMs;
    this.workerId = `source-ingest-${randomUUID()}`;
    this.timer = null;
    this.reconcileTimer = null;
    this.running = null;
    this.lastError = null;
    this.lastCompletedAt = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.pollMs);
    this.reconcileTimer = setInterval(() => { void this.sources.reconcileJobs?.().catch(() => {}); }, this.reconcileMs);
    this.timer.unref();
    this.reconcileTimer.unref();
    void this.sources.reconcileJobs?.().catch(() => {});
    void this.tick();
  }

  async tick() {
    if (this.running) return this.running;
    this.running = this.#tick().catch((error) => {
      this.lastError = typeof error?.code === "string" ? error.code : "source_worker_failed";
      return null;
    }).finally(() => { this.running = null; });
    return this.running;
  }

  async #tick() {
    const job = await this.jobs.claim(["ingest"], this.workerId, { leaseMs: this.leaseMs });
    if (!job) return null;
    let leaseLost = false;
    let renewing = false;
    const renewal = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void this.jobs.renew(job.userId, job.id, job.leaseToken, this.leaseMs)
        .then((renewed) => { if (!renewed) leaseLost = true; })
        .catch(() => { leaseLost = true; }).finally(() => { renewing = false; });
    }, Math.max(1000, Math.floor(this.leaseMs / 3)));
    renewal.unref();
    let processing = null;
    let resolvedFile = null;
    let artifactPath = null;
    let extractionRecorded = false;
    try {
      if (job.payload?.action === "source-run-cancel") {
        if (!this.cancelUnderstanding) throw Object.assign(new Error("Source run cancellation is unavailable."), { code: "source_cancel_unconfigured" });
        return await this.sources.consumeRunCancellation(job, this.cancelUnderstanding);
      }
      if (job.payload?.action === "source-delete") {
        if (!this.cleanupSource) throw Object.assign(new Error("Source deletion cleanup is unavailable."), { code: "source_cleanup_unconfigured" });
        const scope = await this.prepareCleanup(job);
        const finished = await this.sources.consumeDeletion(job, async (ownedJob, source, ids) => {
          const runs = [...(source.payload.pendingRunCancellations ?? []), ...(source.payload.analysis?.run ? [source.payload.analysis.run] : [])];
          for (const run of runs) {
            if (!this.cancelUnderstanding) throw Object.assign(new Error("Source run cancellation is unavailable."), { code: "source_cancel_unconfigured" });
            await this.cancelUnderstanding({ userId: job.userId, projectId: job.projectId, runId: run.id, sessionId: run.sessionId, dispatchId: run.dispatchId,
              workspaceName: run.workspaceName, artifactDirectory: run.artifactDirectory });
          }
          await this.cleanupSource(ownedJob, source, ids, scope);
        });
        this.lastError = null;
        this.lastCompletedAt = new Date().toISOString();
        return finished;
      }
      if (job.payload?.action != null) throw Object.assign(new Error("Unknown source lifecycle action."), { code: "source_job_invalid" });
      const source = await this.sources.get(job.userId, job.payload?.sourceId);
      const expectedGeneration = Number(job.payload?.sourceGeneration ?? job.payload?.sourceRevision);
      const actualGeneration = Number(source?.payload?.generation ?? source?.revision);
      if (!source || source.projectId !== job.projectId
        || !Number.isSafeInteger(expectedGeneration) || expectedGeneration !== actualGeneration) {
        return await this.jobs.finish(job.userId, job.id, job.leaseToken, { skipped: true, reason: "source_superseded" });
      }
      if (!["queued", "parsing", "failed"].includes(source.payload.status)) {
        return await this.jobs.finish(job.userId, job.id, job.leaseToken, { skipped: true, reason: "source_no_longer_processing" });
      }
      processing = await this.sources.beginIngestion(job.userId, source.id, { generation: actualGeneration, job });
      if (processing.payload.depth === "skip") {
        const finished = await this.sources.publishUnderstanding(job, null);
        this.lastError = null;
        this.lastCompletedAt = new Date().toISOString();
        return finished;
      }
      let parsed = await this.sources.loadCapture(job.userId, processing);
      if (!parsed) {
        const resolved = await this.resolveSource(job, processing);
        resolvedFile = resolved;
        const file = typeof resolved === "string" ? resolved : resolved.parserPath;
        const result = await this.parser.parse({
          path: file,
          mimeType: processing.payload.fingerprint.mimeType,
          sha256: processing.payload.fingerprint.sha256,
          sourceId: processing.id,
        });
        parsed = await this.sources.freezeCapture(job, result);
      }
      let completed = null;
      if (["structured", "deep"].includes(processing.payload.depth)) {
        if (!this.understandingRuns) throw Object.assign(new Error("Source understanding is unavailable."), { code: "source_understanding_unconfigured" });
        completed = await this.understandingRuns.execute({ job, source: processing, parsed });
        if (completed.state === "pending") {
          await this.sources.deferIngestion(job, completed);
          this.lastError = null;
          return { deferred: true, runId: completed.runId };
        }
      }
      const result = { ...parsed, text: parsed.input.text, units: parsed.input.units, facts: [], methods: [] };
      if (leaseLost || !(await this.jobs.renew(job.userId, job.id, job.leaseToken, this.leaseMs))) {
        const error = /** @type {Error & {code:string}} */ (Object.assign(new Error("Source ingestion lease was lost before materialization."), { code: "product_job_lease_lost" })); throw error;
      }
      await this.#assertCurrent(job.userId, processing.id, actualGeneration);
      artifactPath = await this.sources.withIngestionLease(job, () => this.materialize(job, processing, result));
      if (leaseLost || !(await this.jobs.renew(job.userId, job.id, job.leaseToken, this.leaseMs))) {
        const error = /** @type {Error & {code:string}} */ (Object.assign(new Error("Source ingestion lease was lost before commit."), { code: "product_job_lease_lost" })); throw error;
      }
      await this.#assertCurrent(job.userId, processing.id, actualGeneration);
      const finished = await this.sources.publishUnderstanding(job, parsed, completed, artifactPath);
      extractionRecorded = true;
      this.lastError = null;
      this.lastCompletedAt = new Date().toISOString();
      return finished;
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : "source_ingestion_failed";
      this.lastError = code;
      if (processing && ["project_runtime_busy", "runtime_busy", "runtime_session_busy", "source_understanding_busy"].includes(code) && !leaseLost) {
        await this.sources.deferIngestion(job);
        this.lastError = null;
        return { deferred: true };
      }
      if (job.payload?.action === "source-delete" && !leaseLost && code !== "product_job_lease_lost") {
        await this.sources.recordDeletionFailure(job, code).catch(() => {});
      }
      if (artifactPath && !extractionRecorded) {
        await this.sources.withAttemptCleanup(job, () => this.discardMaterialized(job, processing, artifactPath)).catch(() => {});
      }
      if (processing && code !== "source_generation_stale" && code !== "product_job_lease_lost") {
        await this.sources.recordFailure(job.userId, processing.id, {
          expectedRevision: processing.revision, generation: processing.payload.generation, job,
          code, message: "Source analysis failed.",
        }).catch(() => {});
      }
      if (!leaseLost && code !== "product_job_lease_lost") {
        try {
          await this.jobs.fail(job.userId, job.id, job.leaseToken,
            { code, message: "Source analysis failed." },
            { retry: !TERMINAL_ERRORS.has(code), delayMs: TERMINAL_ERRORS.has(code) ? 0 : Math.min(60_000, 1000 * 2 ** Math.min(job.attempts, 6)) });
        } catch (failure) {
          if (failure?.code !== "product_job_lease_lost") throw failure;
        }
      }
      return null;
    } finally {
      clearInterval(renewal);
      if (resolvedFile && processing) await this.sources.withAttemptCleanup(job, () => this.releaseResolved(job, processing, resolvedFile)).catch(() => {});
    }
  }

  async #assertCurrent(userId, sourceId, generation) {
    const current = await this.sources.get(userId, sourceId);
    if (!current || current.payload?.status !== "parsing" || current.payload?.generation !== generation) {
      const error = /** @type {Error & {code:string}} */ (Object.assign(
        new Error("A newer source state superseded this ingestion result."),
        { code: "source_generation_stale" },
      ));
      throw error;
    }
    return current;
  }

  status() { return { running: Boolean(this.running), lastError: this.lastError, lastCompletedAt: this.lastCompletedAt }; }

  async close() {
    if (this.timer) clearInterval(this.timer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.timer = null;
    this.reconcileTimer = null;
    await this.running;
  }
}
