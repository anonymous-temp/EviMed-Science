import { randomUUID } from "node:crypto";
import { readCopyOf } from "./sourceService.mjs";

/** Codes that mean no runtime or budget was available yet, and how long a
 *  document waits before asking again. */
const CAPACITY_DEFERRALS = new Map([
  ["runtime_limit_exceeded", 60_000],
  ["runtime_proxy_limit_exceeded", 60_000],
  ["usage_budget_exceeded", 3_600_000],
]);

const TERMINAL_ERRORS = new Set([
  "source_job_invalid", "source_path_invalid", "source_digest_invalid", "source_format_unsupported",
  "source_generation_stale", "source_state_conflict", "source_changed", "openlist_source_changed",
  "source_parser_input_too_large", "source_understanding_invalid", "source_understanding_run_failed", "source_understanding_usage_invalid", "source_understanding_input_too_large",
  // The parser's answers that the same bytes would get again: a format it does
  // not read, a file over its limit, a refused request, and the two that wait
  // on an operator (a key, a quota). Retrying them only spends the backoff; the
  // card says what to do and 「重新分析」 starts over once it is done.
  "source_media_unsupported", "source_parser_payload_too_large", "source_parser_checksum_failed", "source_parser_rejected",
  "source_parser_auth_failed", "source_parser_quota_exhausted", "source_parser_unconfigured",
  "source_not_found", "source_account_changed", "source_cleanup_unconfigured", "source_cleanup_platform_unsupported", "source_cleanup_path_invalid",
  "source_folder_not_found", "source_folder_invalid", "source_folder_conflict",
]);

/** Leased ingestion worker. ProductJobs owns retries; source generations make
 * an old lease unable to overwrite a newer user correction. */
export class SourceIngestionWorker {
  /** @param {{jobs:any,sources:any,parser:any,resolveSource:(job:any,source:any)=>Promise<string|{localPath:string}>,releaseResolved?:(job:any,source:any,file:any)=>Promise<void>,verifyMetadata?:(metadata:any)=>Promise<any>,onPublished?:(job:any)=>void,onReadable?:(job:any)=>void,materialize:(job:any,source:any,result:any)=>Promise<string>,discardMaterialized?:(job:any,source:any,artifactPath:string)=>Promise<void>,cleanupSource?:(job:any,source:any,jobIds:string[],scope:any)=>Promise<void>,prepareCleanup?:(job:any)=>Promise<any>,understandingRuns?:any,cancelUnderstanding?:any,pollMs?:number,leaseMs?:number,reconcileMs?:number,report?:(event:string,detail:Record<string,any>)=>void}} dependencies */
  constructor({ jobs, sources, parser, resolveSource, releaseResolved = async () => {}, verifyMetadata = async (metadata) => metadata, onPublished = () => {}, onReadable = () => {}, materialize, discardMaterialized = async () => {}, cleanupSource = null, prepareCleanup = async () => null, understandingRuns = null, cancelUnderstanding = null, pollMs = 1000, leaseMs = 900_000, reconcileMs = 60_000, report = () => {} }) {
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
    this.verifyMetadata = verifyMetadata;
    this.onPublished = onPublished;
    this.onReadable = onReadable;
    this.materialize = materialize;
    this.discardMaterialized = discardMaterialized;
    this.cleanupSource = cleanupSource;
    this.prepareCleanup = prepareCleanup;
    this.understandingRuns = understandingRuns;
    this.cancelUnderstanding = cancelUnderstanding;
    this.pollMs = pollMs;
    this.leaseMs = leaseMs;
    this.reconcileMs = reconcileMs;
    this.kinds = ["ingest"];
    this.workerId = `source-ingest-${randomUUID()}`;
    this.timer = null;
    this.reconcileTimer = null;
    this.reconciling = null;
    this.running = null;
    this.lastError = null;
    this.lastCompletedAt = null;
    /** The last orphan sweep: when, what it withdrew, or the code it failed with. */
    this.orphanSweep = null;
    this.report = report;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.pollMs);
    this.reconcileTimer = setInterval(() => { void this.reconcile(); }, this.reconcileMs);
    this.timer.unref();
    this.reconcileTimer.unref();
    void this.reconcile();
    void this.tick();
  }

  /**
   * The repair cycle: intake jobs a crash left behind, then the memories still
   * derived from a document or project that is gone (plan 2026-09-23 §5.6).
   * The sweep reports for itself — on `status()` and through `report` — so one
   * that keeps failing is visible, and one that withdrew something says how
   * much; neither half's failure stops the other. One cycle at a time: a call
   * while one runs is that run.
   * @returns {Promise<void>}
   */
  reconcile() {
    if (this.reconciling) return this.reconciling;
    this.reconciling = (async () => {
      await this.sources.reconcileJobs?.().catch(() => {});
      if (typeof this.sources.withdrawOrphanedMemory !== "function") return;
      const at = new Date().toISOString();
      /** @param {string} event @param {Record<string, any>} detail */
      const report = (event, detail) => {
        try { this.report(event, detail); } catch { /* a report never fails the cycle it reports on */ }
      };
      try {
        const swept = await this.sources.withdrawOrphanedMemory();
        this.orphanSweep = { at, ...swept, error: null };
        if (swept.entries > 0 || swept.ledgers > 0) report("derived_memory_withdrawn", swept);
      } catch (error) {
        const code = typeof error?.code === "string" ? error.code : "derived_memory_sweep_failed";
        this.orphanSweep = { at, sources: 0, projects: 0, entries: 0, ledgers: 0, error: code };
        report("derived_memory_sweep_failed", { code });
      }
    })().finally(() => { this.reconciling = null; });
    return this.reconciling;
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
    const job = await this.jobs.claim(this.kinds, this.workerId, { leaseMs: this.leaseMs });
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
    /** A copy this attempt wrote and has not recorded on the source yet. */
    let materialized = null;
    let extractionRecorded = false;
    try {
      if (job.payload?.action === "source-run-cancel") {
        if (!this.cancelUnderstanding) throw Object.assign(new Error("Source run cancellation is unavailable."), { code: "source_cancel_unconfigured" });
        return await this.sources.consumeRunCancellation(job, this.cancelUnderstanding);
      }
      if (job.payload?.action === "source-folder-sync") {
        // A folder sync owns no source row, so it renews and finishes like any
        // other leased job instead of going through the source-lease wrapper.
        const summary = await this.sources.consumeFolderSync(job);
        await this.jobs.finish(job.userId, job.id, job.leaseToken, summary);
        this.lastError = null;
        this.lastCompletedAt = new Date().toISOString();
        return summary;
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
        this.#published(job);
        this.lastError = null;
        this.lastCompletedAt = new Date().toISOString();
        return finished;
      }
      let parsed = await this.sources.loadCapture(job.userId, processing);
      if (!parsed) {
        const resolved = await this.resolveSource(job, processing);
        resolvedFile = resolved;
        const file = typeof resolved === "string" ? resolved : resolved.localPath;
        const result = await this.parser.parse({
          path: file,
          mimeType: processing.payload.fingerprint.mimeType,
          sha256: processing.payload.fingerprint.sha256,
          sourceId: processing.id,
        });
        // A model wrote the parser's metadata; the DOI is checked against
        // Crossref here, outside the capture's transaction, so a slow lookup
        // never holds a row lock. It cannot fail the parse: an unreachable
        // Crossref leaves the DOI unconfirmed.
        const metadata = result.metadata ? await this.verifyMetadata(result.metadata).catch(() => null) : null;
        parsed = await this.sources.freezeCapture(job, { ...result, metadata });
      }
      const understands = ["structured", "deep"].includes(processing.payload.depth);
      const result = { ...parsed, text: parsed.input.text, units: parsed.input.units, facts: [], methods: [] };
      // The document is usable once its text is written out, before and
      // whatever its understanding does: a PDF used to stay unsearchable for
      // the one to four minutes the understanding run takes (2026-09-24). A
      // generation already written out — a deferred or retried attempt — is
      // not written again.
      let artifactPath = readCopyOf(await this.#assertCurrent(job.userId, processing.id, actualGeneration));
      if (!artifactPath) {
        await this.#renewOrThrow(job, () => leaseLost, "before materialization");
        artifactPath = await this.sources.withIngestionLease(job, () => this.materialize(job, processing, result));
        materialized = artifactPath;
        await this.#renewOrThrow(job, () => leaseLost, "before commit");
        await this.#assertCurrent(job.userId, processing.id, actualGeneration);
        if (understands) {
          await this.sources.recordReadable(job, artifactPath);
          // Recorded: the copy is the source's now, not this attempt's to discard.
          materialized = null;
          this.#readable(job);
        }
      }
      let completed = null;
      if (understands) {
        if (!this.understandingRuns) throw Object.assign(new Error("Source understanding is unavailable."), { code: "source_understanding_unconfigured" });
        completed = await this.understandingRuns.execute({ job, source: processing, parsed });
        if (completed.state === "pending") {
          await this.sources.deferIngestion(job, completed);
          this.lastError = null;
          return { deferred: true, runId: completed.runId };
        }
        await this.#renewOrThrow(job, () => leaseLost, "before commit");
        await this.#assertCurrent(job.userId, processing.id, actualGeneration);
      }
      const finished = await this.sources.publishUnderstanding(job, parsed, completed, artifactPath);
      extractionRecorded = true;
      this.#published(job);
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
      // Every runtime slot taken, or a spending cap reached, says nothing about
      // the document either: it waits for room instead of being marked failed.
      // A knowledge-base upload failed in 21 s this way while the account's
      // background work held the slots (2026-09-21).
      const capacityWait = CAPACITY_DEFERRALS.get(code);
      if (processing && capacityWait && !leaseLost) {
        await this.sources.deferIngestion(job, null, capacityWait);
        this.lastError = null;
        return { deferred: true };
      }
      if (job.payload?.action === "source-delete" && !leaseLost && code !== "product_job_lease_lost") {
        await this.sources.recordDeletionFailure(job, code).catch(() => {});
      }
      if (materialized && !extractionRecorded) {
        const discarded = materialized;
        await this.sources.withAttemptCleanup(job, () => this.discardMaterialized(job, processing, discarded)).catch(() => {});
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

  /** A source's understanding was published: tell whoever keeps a derivation
   *  of it (the knowledge-base index, the library, the capsule) without letting
   *  its failure touch this job. @param {any} job */
  #published(job) {
    try { this.onPublished(job); } catch { /* the index converges on its own timer */ }
  }

  /** A source's text was written out ahead of its understanding: the index
   *  can take it now. Never able to fail the job. @param {any} job */
  #readable(job) {
    try { this.onReadable(job); } catch { /* the index converges on its own timer */ }
  }

  /** @param {any} job @param {() => boolean} lost @param {string} when */
  async #renewOrThrow(job, lost, when) {
    if (lost() || !(await this.jobs.renew(job.userId, job.id, job.leaseToken, this.leaseMs))) {
      throw Object.assign(new Error(`Source ingestion lease was lost ${when}.`), { code: "product_job_lease_lost" });
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

  status() {
    return { running: Boolean(this.running), lastError: this.lastError, lastCompletedAt: this.lastCompletedAt, orphanSweep: this.orphanSweep };
  }

  async close() {
    if (this.timer) clearInterval(this.timer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.timer = null;
    this.reconcileTimer = null;
    await this.running;
    await this.reconciling;
  }
}
