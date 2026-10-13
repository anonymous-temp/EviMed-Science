import { randomUUID } from "node:crypto";
import path from "node:path";
import { RUNTIME_ROOM_REFUSAL_CODES, SOURCE_ORIGINAL_CODES, sourceFormatRoute } from "@evimed/domain";
import { RUNTIME_YIELDED_CODE } from "./internalProjects.mjs";
import { extractorRevision, readCopyOf, understandingPending } from "./sourceService.mjs";

/** Codes that mean no runtime or budget was available yet, and how long a
 *  document waits before asking again. `runtime_yielded` is the same wait from
 *  the other side: the document's run had a runtime, and a researcher's start
 *  took it back (`RuntimeManager.makeRoomFor`); its run is released first
 *  (`SourceUnderstandingRuns`), so the next claim launches a new one. */
const CAPACITY_DEFERRALS = new Map([
  ...RUNTIME_ROOM_REFUSAL_CODES.map((code) => /** @type {[string, number]} */ ([code, 60_000])),
  ["runtime_proxy_limit_exceeded", 60_000],
  [RUNTIME_YIELDED_CODE, 60_000],
  ["usage_budget_exceeded", 3_600_000],
]);

const TERMINAL_ERRORS = new Set([
  "source_job_invalid", "source_path_invalid", "source_digest_invalid", "source_format_unsupported",
  "source_generation_stale", "source_state_conflict", "source_changed", "openlist_source_changed",
  "source_parser_input_too_large",
  // The understanding's answers that the same capture would get again: it is not
  // installed here, its input is over the limit, the run ended without one, or
  // what it delivered does not stand against the text. None of them is the
  // document's: the text is in before any of them can happen (`#tick`).
  "source_understanding_unconfigured", "source_understanding_invalid", "source_understanding_run_failed", "source_understanding_input_too_large",
  // The parser's answers that the same bytes would get again: a file over its
  // limit, a refused request, and the two that wait on an operator (a key, a
  // quota). Retrying them only spends the backoff; the card says what to do and
  // 「重新分析」 starts over once it is done.
  "source_parser_payload_too_large", "source_parser_checksum_failed", "source_parser_rejected",
  "source_parser_auth_failed", "source_parser_quota_exhausted", "source_parser_unconfigured",
  "source_not_found", "source_account_changed", "source_cleanup_unconfigured", "source_cleanup_platform_unsupported", "source_cleanup_path_invalid",
  "source_folder_not_found", "source_folder_invalid", "source_folder_conflict",
]);

/**
 * Why a parse that ended without text leaves a document kept as an original
 * (`SOURCE_ORIGINAL_CODES`), or null for an answer that is a failure. A parser
 * that says nothing here reads the format — no engine on this deployment, or
 * the parsing API's own 415 — is the `unread` one; the engine's own failure
 * names itself. A size limit is not among them: it stays a refusal that says so.
 * @param {any} error @returns {string | null}
 */
function originalReason(error) {
  if (error?.code === "source_format_unsupported" && error.status === 415) return "source_original_unread";
  return SOURCE_ORIGINAL_CODES.includes(error?.code) ? error.code : null;
}

/**
 * Leased ingestion worker. ProductJobs owns retries; source generations make
 * an old lease unable to overwrite a newer user correction.
 *
 * A job has two legs, and a document's outcome is decided by the first alone
 * (2026-10-13). The first captures the text and writes it out; from that
 * moment the record says the document is usable (`recordReadable`), and a file
 * nothing could read text out of is kept as an original instead of failing
 * (`SOURCE_ORIGINAL_CODES`). The second is the understanding, for a depth that
 * asks for one: a background enhancement that the same job carries on with,
 * behind every document still waiting for its first leg, and whose waiting,
 * failing or never running is recorded as a fact about the understanding and
 * changes nothing about the document.
 */
export class SourceIngestionWorker {
  /**
   * `engineParser` reads a file neither the local reader nor the parsing API takes — the engine's own parsers
   * (`OpenVikingResources.parseWithEngine`) — and is null where the deployment has no engine to ask.
   * @param {{jobs:any,sources:any,parser:any,resolveSource:(job:any,source:any)=>Promise<string|{localPath:string}>,releaseResolved?:(job:any,source:any,file:any)=>Promise<void>,verifyMetadata?:(metadata:any)=>Promise<any>,onPublished?:(job:any)=>void,onReadable?:(job:any)=>void,materialize:(job:any,source:any,result:any)=>Promise<string>,discardMaterialized?:(job:any,source:any,artifactPath:string)=>Promise<void>,cleanupSource?:(job:any,source:any,jobIds:string[],scope:any)=>Promise<void>,prepareCleanup?:(job:any)=>Promise<any>,understandingRuns?:any,cancelUnderstanding?:any,materials?:{extract:Function}|null,engineParser?:((userId:string,file:{name:string,bytes:Buffer,token:string,signal?:AbortSignal|null})=>Promise<{text?:string}>)|null,pollMs?:number,leaseMs?:number,reconcileMs?:number,report?:(event:string,detail:Record<string,any>)=>void}} dependencies */
  constructor({ jobs, sources, parser, resolveSource, releaseResolved = async () => {}, verifyMetadata = async (metadata) => metadata, onPublished = () => {}, onReadable = () => {}, materialize, discardMaterialized = async () => {}, cleanupSource = null, prepareCleanup = async () => null, understandingRuns = null, cancelUnderstanding = null, materials = null, engineParser = null, pollMs = 1000, leaseMs = 900_000, reconcileMs = 60_000, report = () => {} }) {
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
    /** Structured materials of a parsed source (tables, cells, pages): an extension of the parse that never fails it. */
    this.materials = materials;
    this.engineParser = engineParser;
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
    let parseController = null;
    let renewing = false;
    const renewal = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void this.jobs.renew(job.userId, job.id, job.leaseToken, this.leaseMs)
        .then((renewed) => { if (!renewed) { leaseLost = true; parseController?.abort(Object.assign(new Error("The ingestion lease was lost."), { code: "product_job_lease_lost" })); } })
        .catch(() => { leaseLost = true; parseController?.abort(Object.assign(new Error("The ingestion lease was lost."), { code: "product_job_lease_lost" })); }).finally(() => { renewing = false; });
    }, Math.max(1000, Math.floor(this.leaseMs / 3)));
    renewal.unref();
    let processing = null;
    let resolvedFile = null;
    /** A copy this attempt wrote and has not recorded on the source yet. */
    let materialized = null;
    let extractionRecorded = false;
    /** The capture and the written copy of the text, and whether the record already says it is in: what a failure
     *  after that point leaves standing. */
    let parsed = null;
    let artifactPath = null;
    let textIn = false;
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
      if (!["queued", "parsing", "failed"].includes(source.payload.status) && !understandingPending(source.payload)) {
        return await this.jobs.finish(job.userId, job.id, job.leaseToken, { skipped: true, reason: "source_no_longer_processing" });
      }
      processing = await this.sources.beginIngestion(job.userId, source.id, { generation: actualGeneration, job });
      textIn = understandingPending(processing.payload);
      // Nothing is read: a depth of `skip` asks for nothing, and a recording is known by its name to hold no text
      // anything here reads, so it is kept as an original before a byte of it is fetched.
      const recording = sourceFormatRoute(processing.payload.paths?.[0]) === "media";
      if (processing.payload.depth === "skip" || recording) {
        const finished = await this.sources.publishUnderstanding(job, null, null, null, recording ? { original: "source_original_media" } : {});
        this.#published(job);
        this.lastError = null;
        this.lastCompletedAt = new Date().toISOString();
        return finished;
      }
      parsed = await this.sources.loadCapture(job.userId, processing);
      if (!parsed) {
        const resolved = await this.resolveSource(job, processing);
        resolvedFile = resolved;
        const file = typeof resolved === "string" ? resolved : resolved.localPath;
        const controller = new AbortController();
        parseController = controller;
        let checking = false;
        const cancellationCheck = setInterval(() => {
          if (checking || controller.signal.aborted) return;
          checking = true;
          void this.#assertCurrent(job.userId, processing.id, actualGeneration)
            .catch(error => controller.abort(error)).finally(() => { checking = false; });
        }, Math.max(100, Math.min(1000, this.pollMs)));
        cancellationCheck.unref();
        let result;
        let materials = null;
        /** Why the parse yielded no text, when it yielded none (`SOURCE_ORIGINAL_CODES`). */
        let original = null;
        try {
          result = await this.parser.parse({ path: file,
            mimeType: processing.payload.fingerprint.mimeType,
            sha256: processing.payload.fingerprint.sha256,
            sourceId: processing.id, signal: controller.signal,
            // A file neither the local reader nor the parsing API takes is the engine's parsers' to try, where there
            // is an engine: staged under the document's own id, read back as Markdown, removed.
            engine: this.engineParser ? (/** @type {any} */ document) => this.engineParser(job.userId, { ...document, token: processing.id }) : null,
          });
          if (!String(result.text ?? "").trim()) original = "source_original_no_text";
          // The tables, cells and pages of what was just parsed, under the same
          // cancellation and lease checks as the parse. A failure here is the
          // ledger's (`coverage.materials`), never the ingestion's: only the
          // caller's own cancellation propagates.
          else if (this.materials) {
            try {
              materials = await this.materials.extract({ text: result.text, file, name: path.basename(file),
                sha256: processing.payload.fingerprint.sha256, parserRevision: extractorRevision(result.extractor), signal: controller.signal });
            } catch (error) {
              // `extract` answers with a ledger instead of throwing; this is the
              // net under it, so a defect in the extension is a source with no
              // structure and a report, not a document that could not be read.
              if (controller.signal.aborted) throw error;
              try { this.report("source_materials_failed", { code: typeof error?.code === "string" ? error.code : "source_materials_failed" }); } catch { /* a report never fails an ingestion */ }
            }
          }
        } catch (error) {
          if (controller.signal.aborted) throw controller.signal.reason;
          // Nothing here reads this file, or the engine could not: that is a document without text, not a failed one.
          original = originalReason(error);
          if (!original) throw error;
        } finally {
          clearInterval(cancellationCheck);
          parseController = null;
        }
        if (original) {
          // No text to capture. The file is kept as it is — listed and opened like any other, searched by nothing,
          // nothing pushed to the engine for it — with the reason on its record, and the job ends here.
          await this.#renewOrThrow(job, () => leaseLost, "before commit");
          const finished = await this.sources.publishUnderstanding(job, null, null, null, { original });
          this.#published(job);
          this.lastError = null;
          this.lastCompletedAt = new Date().toISOString();
          return finished;
        }
        // A model wrote the parser's metadata; the DOI is checked against
        // Crossref here, outside the capture's transaction, so a slow lookup
        // never holds a row lock. It cannot fail the parse: an unreachable
        // Crossref leaves the DOI unconfirmed.
        const metadata = result.metadata ? await this.verifyMetadata(result.metadata).catch(() => null) : null;
        parsed = await this.sources.freezeCapture(job, { ...result, metadata, ...(materials ? { materials } : {}) });
      }
      const understands = ["structured", "deep"].includes(processing.payload.depth);
      const result = { ...parsed, text: parsed.input.text, units: parsed.input.units, facts: [], methods: [] };
      // The text is written out as soon as it is captured: a PDF used to stay
      // unsearchable for the one to four minutes the understanding run takes
      // (2026-09-24). A generation already written out — a deferred or retried
      // attempt — is not written again.
      artifactPath = readCopyOf(await this.#assertCurrent(job.userId, processing.id, actualGeneration));
      if (!artifactPath) {
        await this.#renewOrThrow(job, () => leaseLost, "before materialization");
        artifactPath = await this.sources.withIngestionLease(job, () => this.materialize(job, processing, result));
        materialized = artifactPath;
        await this.#renewOrThrow(job, () => leaseLost, "before commit");
        await this.#assertCurrent(job.userId, processing.id, actualGeneration);
      }
      if (understands && !textIn) {
        // The first leg ends here, and with it everything that decides the document: the record says it is usable,
        // and nothing the understanding does or fails to do moves that (2026-10-13 — until then the document stayed
        // `parsing` for as long as its understanding ran or waited, and read `failed` when it could not run).
        await this.sources.recordReadable(job, artifactPath);
        // Recorded: the copy is the source's now, not this attempt's to discard.
        materialized = null;
        textIn = true;
        this.#readable(job);
        // The second leg is taken up from the queue, behind every document whose text is still to be read: launching
        // an understanding takes seconds, and no document's reading waits for another's understanding.
        await this.sources.deferIngestion(job, null, 0);
        this.lastError = null;
        return { deferred: true, readable: true };
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
      // A document nobody understands is written out and published in one step: this is when its text can be taken.
      if (!understands) this.#readable(job);
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
      // the document either: the job waits for room instead of failing. A
      // knowledge-base upload failed in 21 s this way while the account's
      // background work held the slots (2026-09-21). Only an understanding
      // asks for a runtime or spends, so the document itself is not waiting:
      // its text was in before this could be answered.
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
      const superseded = code === "source_generation_stale" || code === "product_job_lease_lost";
      // The text is in, so this is the understanding's failure and never the document's. When nothing will try
      // again — the same capture would get the same answer, or this was the job's last attempt — the job ends as a
      // finished document: its units published as an indexed document's are, and what became of the understanding
      // on the record. Until then the document stays as it is and only the job is retried.
      if (textIn && parsed && !superseded && !leaseLost && (TERMINAL_ERRORS.has(code) || job.attempts >= job.maxAttempts)) {
        try {
          const finished = await this.sources.publishUnderstanding(job, parsed, null, artifactPath, { understandingError: code });
          this.#published(job);
          this.lastCompletedAt = new Date().toISOString();
          return finished;
        } catch { /* the job fails below, and the repair cycle records the understanding's end (`reconcileJobs`) */ }
      }
      if (processing && !textIn && !superseded) {
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

  /** A source's job ended in a finished document — understood, indexed, read
   *  without an understanding, or kept as an original: tell whoever keeps a
   *  derivation of it (the knowledge-base index, the library, the capsule)
   *  without letting its failure touch this job. @param {any} job */
  #published(job) {
    try { this.onPublished(job); } catch { /* the index converges on its own timer */ }
  }

  /** A source's text is in — written out ahead of its understanding, or published
   *  with nothing to follow: the index, the engine's copy and the project's pages
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
    if (!current || (current.payload?.status !== "parsing" && !understandingPending(current.payload)) || current.payload?.generation !== generation) {
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
