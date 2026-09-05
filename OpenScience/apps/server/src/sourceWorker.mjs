import { randomUUID } from "node:crypto";

const TERMINAL_ERRORS = new Set(["source_job_invalid", "source_path_invalid", "source_digest_invalid", "source_format_unsupported"]);

/** Leased ingestion worker. ProductJobs owns retries; source generations make
 * an old lease unable to overwrite a newer user correction. */
export class SourceIngestionWorker {
  /** @param {{jobs:any,sources:any,parser:any,resolveSource:(job:any,source:any)=>Promise<string>,materialize:(job:any,source:any,result:any)=>Promise<string>,pollMs?:number,leaseMs?:number}} dependencies */
  constructor({ jobs, sources, parser, resolveSource, materialize, pollMs = 1000, leaseMs = 900_000 }) {
    if (![jobs, sources, parser, resolveSource, materialize].every(Boolean)) throw new TypeError("SourceIngestionWorker dependencies are required.");
    if (!Number.isSafeInteger(pollMs) || pollMs < 100 || pollMs > 86_400_000
      || !Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 3_600_000) {
      throw new TypeError("Invalid source ingestion worker interval.");
    }
    this.jobs = jobs;
    this.sources = sources;
    this.parser = parser;
    this.resolveSource = resolveSource;
    this.materialize = materialize;
    this.pollMs = pollMs;
    this.leaseMs = leaseMs;
    this.workerId = `source-ingest-${randomUUID()}`;
    this.timer = null;
    this.running = null;
    this.lastError = null;
    this.lastCompletedAt = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.pollMs);
    this.timer.unref();
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
    const renewal = setInterval(() => {
      void this.jobs.renew(job.userId, job.id, job.leaseToken, this.leaseMs)
        .then((renewed) => { if (!renewed) leaseLost = true; })
        .catch(() => { leaseLost = true; });
    }, Math.max(1000, Math.floor(this.leaseMs / 3)));
    renewal.unref();
    let processing = null;
    try {
      const source = await this.sources.get(job.userId, job.payload?.sourceId);
      const expectedGeneration = Number(job.payload?.sourceGeneration ?? job.payload?.sourceRevision);
      const actualGeneration = Number(source?.payload?.generation ?? source?.revision);
      if (!source || source.projectId !== job.projectId || source.payload.status === "canceled"
        || !Number.isSafeInteger(expectedGeneration) || expectedGeneration !== actualGeneration) {
        return await this.jobs.finish(job.userId, job.id, job.leaseToken, { skipped: true, reason: "source_superseded" });
      }
      processing = await this.sources.beginIngestion(job.userId, source.id, { generation: actualGeneration });
      const file = await this.resolveSource(job, processing);
      const result = await this.parser.parse({
        path: file,
        mimeType: processing.payload.fingerprint.mimeType,
        sha256: processing.payload.fingerprint.sha256,
        sourceId: processing.id,
      });
      const artifactPath = await this.materialize(job, processing, result);
      const completed = await this.sources.recordExtraction(job.userId, processing.id, {
        expectedRevision: processing.revision,
        generation: actualGeneration,
        extractor: result.extractor,
        units: result.units,
        summary: result.summary,
        facts: Array.isArray(result.facts) ? result.facts.length : 0,
        methods: Array.isArray(result.methods) ? result.methods.length : 0,
        artifactPath,
      });
      const finished = await this.jobs.finish(job.userId, job.id, job.leaseToken, {
        sourceId: processing.id, sourceRevision: completed.revision, status: completed.payload.status, artifactPath,
      });
      this.lastError = null;
      this.lastCompletedAt = new Date().toISOString();
      return finished;
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : "source_ingestion_failed";
      this.lastError = code;
      if (processing && code !== "source_generation_stale" && code !== "product_job_lease_lost") {
        await this.sources.recordFailure(job.userId, processing.id, {
          expectedRevision: processing.revision, generation: processing.payload.generation,
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
    }
  }

  status() { return { running: Boolean(this.running), lastError: this.lastError, lastCompletedAt: this.lastCompletedAt }; }

  async close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }
}
