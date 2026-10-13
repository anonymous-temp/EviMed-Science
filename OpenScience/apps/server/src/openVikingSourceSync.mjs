import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { sourceOriginOf } from "@evimed/domain";
import { resourcesRoot } from "./openVikingLayout.mjs";
import { sourceIndexDocument, sourceReadable } from "./sourceService.mjs";

/**
 * Every readable document of the knowledge base, kept in OpenViking as the file its Compile reads.
 *
 * Hidden knowledge:
 *
 * - **The copy is derived and rebuildable.** PostgreSQL holds the document, its captured text and every fact about
 *   it; what is pushed is that text rendered the way a run reads it (`sourceIndexDocument`: a bibliographic header,
 *   then the text with a marker line where each page begins), so a quotation the engine copies out of its file is a
 *   quotation of the text the platform checks against. Losing the engine's copy loses nothing:
 *   `scripts/ops/rebuild-ov-resources.mjs` writes it again.
 * - **One job converges one document, whichever way it has to go.** A job carries a document id and nothing about
 *   what happened to it; the worker reads what PostgreSQL says now and makes the engine agree — pushed when the
 *   document is readable, removed when it is gone, withdrawn or no longer readable. So a job that arrives late, twice
 *   or out of order still ends in the right state, and the same function serves a new upload, a replacement, a
 *   removal and a retry. (The memory index learned this the hard way: a write-only publisher leaves what was deleted
 *   searchable for ever.)
 * - **The tag is the proof.** Each file carries `sha=<the captured text's digest>`; reconciliation lists a project's
 *   `sources/` with tags and compares it with the readable documents PostgreSQL holds — the same ids, the same
 *   digests, nothing else — and repairs what differs. It runs on a timer, before every compile, and as the backfill.
 * - **A compiled page is not a document to push.** The mirror of the wiki and of the graph lives in the same ledger
 *   (`knowledge-base/wiki/**`, `knowledge-base/kg/**`); pushing it back would feed the compile its own output.
 * - **The engine being down is a queue that waits.** Nothing here is on the path of an upload, a search or a
 *   conversation: a failed push is retried with a backoff, and the timer's reconciliation catches what a lost job
 *   missed.
 *
 * @module openVikingSourceSync
 */

export const SOURCE_SYNC_JOB_KIND = "ov-resource-sync";
const SCAN_LIMIT = 5000;

/** @param {unknown} error @returns {string} */
const codeOf = (error) => (typeof /** @type {any} */ (error)?.code === "string" ? /** @type {any} */ (error).code : "ov_resource_sync_failed");

/** Whether a source record is a mirrored page of a compiled tree. @param {any} source */
export function isCompiledPage(source) {
  return sourceOriginOf({ connectorType: source?.payload?.connector?.type, path: source?.payload?.paths?.[0] }) === "wiki";
}

/**
 * Every (account, project) that holds a document, for the timer's reconciliation; the project a document was read in
 * most recently first, so a pass that is cut short has done the ones in use.
 * @param {any} database @param {{ limit?: number }} [options] @returns {Promise<Array<{ userId: string, projectId: string }>>}
 */
export async function readableSourceProjects(database, { limit = 200 } = {}) {
  if (!database) return [];
  const result = await database.query(`SELECT user_id, project_id FROM evimed_product.documents
    WHERE kind='source' AND deleted_at IS NULL AND project_id IS NOT NULL
    GROUP BY user_id, project_id ORDER BY max(updated_at) DESC LIMIT $1`, [limit]);
  return result.rows.map((/** @type {any} */ row) => ({ userId: row.user_id, projectId: row.project_id }));
}

export class OpenVikingSourceSync {
  /**
   * @param {{ config: any, sources: any, resources: any, jobs: any, library?: any, engine?: any, now?: () => Date, report?: (code: string) => void }} dependencies
   *   `library`: the account library (`LibraryService`), or null where there is none
   */
  constructor({ config, sources, resources, jobs, library = null, engine = null, now = () => new Date(), report = () => {} }) {
    this.config = config; this.sources = sources; this.resources = resources; this.jobs = jobs; this.library = library; this.engine = engine;
    this.now = now; this.report = report;
    this.counters = { queued: 0, pushed: 0, removed: 0, unchanged: 0, reconciled: 0, failed: 0 };
    /** @type {{ at: string, projects: number, pushed: number, removed: number, error: string | null } | null} */
    this.lastReconcile = null;
  }

  get enabled() { return this.config.ovKnowledgeEnabled === true && Boolean(this.resources?.configured); }

  /**
   * Something happened to a document (it became readable, was replaced, was removed): queue its convergence. Never throws.
   * @param {string} userId @param {string | null | undefined} projectId @param {string | null | undefined} sourceId @param {{ library?: boolean }} [options]
   */
  async note(userId, projectId, sourceId, { library = false } = {}) {
    if (!this.enabled || !userId || !sourceId) return null;
    try {
      // A mirrored page of a compiled tree is never pushed, so its versions ask for nothing (a compile mirrors a hundred).
      if (!library && isCompiledPage(await this.#current(userId, sourceId).catch(() => null))) return null;
      // A key of its own per event: a job that already ran read the state as it was then, and this event is later.
      const job = await this.jobs.enqueue(userId, SOURCE_SYNC_JOB_KIND, { action: library ? "library" : "source", sourceId, projectId: projectId ?? null }, {
        idempotencyKey: `${library ? "ov-library" : "ov-source"}:${sourceId}:${this.now().getTime().toString(36)}-${randomUUID().slice(0, 8)}`,
        projectId: library ? null : projectId ?? null, maxAttempts: 8,
      });
      this.counters.queued += 1;
      return job;
    } catch (error) { this.report(codeOf(error)); return null; }
  }

  /**
   * A project was deleted: everything of it in the engine — its documents, its wiki, its graph — is owed a removal. A job of
   * the account's (the project is gone, so the job names it in its payload), retried until the engine has answered. Never throws.
   * @param {string} userId @param {string} projectId
   */
  async forgetProject(userId, projectId) {
    if (!this.enabled || !userId || !projectId) return null;
    try {
      return await this.jobs.enqueue(userId, SOURCE_SYNC_JOB_KIND, { action: "forget-project", forgottenProjectId: projectId }, { idempotencyKey: `ov-forget:${projectId}`, maxAttempts: 10, rearmFailed: true });
    } catch (error) { this.report(codeOf(error)); return null; }
  }

  /**
   * An account is being erased: one attempt at its whole resources subtree, never waited on. Its jobs go with the account, so
   * there is no queue to leave this in; what an unreachable engine keeps is unreadable by anyone else (the subtree is the
   * account's own) and is found by the operator's listing of `viking://user/`.
   * @param {string} userId
   */
  async forgetAccount(userId) {
    if (!this.enabled || !userId) return false;
    try { return await this.resources.removeTree(userId, resourcesRoot(userId)); }
    catch (error) { this.report(codeOf(error)); return false; }
  }

  /** What a readable document is pushed as. @param {string} userId @param {any} source the full record @returns {Promise<{ text: string, sha: string } | null>} */
  async #rendition(userId, source) {
    const capture = await this.sources.loadCapture(userId, source);
    if (!capture) return null;
    return {
      text: sourceIndexDocument({ original: source.payload.paths?.[0] ?? source.id, sha256: source.payload.fingerprint?.sha256 ?? "", extractor: capture.extractor ?? {},
        text: capture.input.text, pageMap: capture.pageMap, metadata: capture.metadata }),
      sha: String(source.payload.analysis.textSha256),
    };
  }

  /** The source as PostgreSQL holds it now, or null when it is gone. @param {string} userId @param {string} sourceId */
  async #current(userId, sourceId) {
    try {
      const source = await this.sources.get(userId, sourceId);
      return source && !source.deletedAt ? source : null;
    } catch (error) {
      if (/** @type {any} */ (error)?.status === 404 || codeOf(error) === "source_not_found") return null;
      throw error;
    }
  }

  /** Whether a document belongs under `sources/`: readable, of a project, and not a page of a compiled tree. @param {any} source */
  static pushable(source) {
    return Boolean(source && !source.deletedAt && source.projectId && sourceReadable(source.payload) && !isCompiledPage(source) && source.payload.analysis?.textSha256);
  }

  /**
   * Make the engine agree with PostgreSQL about one document of a project.
   * @param {string} userId @param {string} sourceId @param {string | null} [projectId] where the document was, for one that is gone
   * @returns {Promise<{ action: "pushed" | "removed" | "unchanged" | "absent", sourceId: string }>}
   */
  async convergeSource(userId, sourceId, projectId = null) {
    const source = await this.#current(userId, sourceId);
    const project = source?.projectId ?? projectId;
    // A mirrored page was never pushed, so there is nothing of it to converge.
    if (!project || (source && isCompiledPage(source))) return { action: "absent", sourceId };
    const uri = this.resources.sourceUri(userId, project, sourceId);
    if (!OpenVikingSourceSync.pushable(source)) {
      const removed = await this.resources.removeSource(userId, uri);
      if (removed) this.counters.removed += 1;
      return { action: removed ? "removed" : "absent", sourceId };
    }
    const sha = String(source.payload.analysis.textSha256);
    if ((await this.resources.attrs(userId, uri))?.sha === sha) { this.counters.unchanged += 1; return { action: "unchanged", sourceId }; }
    const rendition = await this.#rendition(userId, source);
    if (!rendition) return { action: "absent", sourceId };
    await this.resources.pushSource(userId, uri, rendition.text, { sourceId, sha: rendition.sha, docType: source.payload.docType ?? null });
    this.counters.pushed += 1;
    return { action: "pushed", sourceId };
  }

  /** The readable documents of a project that belong in the engine: id → the digest of the captured text. @param {string} userId @param {string} projectId */
  async expected(userId, projectId) {
    /** @type {Map<string, { sha: string, docType: string | null }>} */
    const expected = new Map();
    let cursor = null;
    for (let scanned = 0; scanned < SCAN_LIMIT;) {
      const page = await this.sources.list(userId, { projectId, state: "ready", limit: 100, cursor });
      for (const item of page.items) {
        scanned += 1;
        if (isCompiledPage(item) || item.deletedAt) continue;
        // The list's projection leaves the text digest out; the record itself has it.
        const source = await this.#current(userId, item.id);
        if (OpenVikingSourceSync.pushable(source)) expected.set(item.id, { sha: String(source.payload.analysis.textSha256), docType: source.payload.docType ?? null });
      }
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    return expected;
  }

  /**
   * Compare a project's readable documents with the files under its `sources/` and repair what differs, both ways.
   * `apply: false` only reports. The proof of "PostgreSQL = engine" is a report with nothing missing, stale or extra.
   * @param {string} userId @param {string} projectId @param {{ apply?: boolean }} [options]
   */
  async reconcileProject(userId, projectId, { apply = true } = {}) {
    const expected = await this.expected(userId, projectId);
    const present = new Map((await this.resources.listSources(userId, this.resources.roots(userId, projectId).sources)).map((/** @type {any} */ entry) => [entry.sourceId, entry]));
    const missing = [...expected.keys()].filter((id) => !present.has(id));
    const stale = [...expected.keys()].filter((id) => present.has(id) && present.get(id).sha !== expected.get(id)?.sha);
    const extra = [...present.keys()].filter((id) => !expected.has(id));
    const report = { projectId, expected: expected.size, present: present.size, missing, stale, extra, pushed: 0, removed: 0, failed: /** @type {{ sourceId: string, code: string }[]} */ ([]) };
    if (!apply) return report;
    for (const sourceId of [...missing, ...stale, ...extra]) {
      try {
        const outcome = await this.convergeSource(userId, sourceId, projectId);
        if (outcome.action === "pushed") report.pushed += 1;
        if (outcome.action === "removed") report.removed += 1;
      } catch (error) { report.failed.push({ sourceId, code: codeOf(error) }); this.counters.failed += 1; }
    }
    this.counters.reconciled += 1;
    return report;
  }

  /**
   * Make the engine agree with the account's library: one file per document whose read-only copy exists, the copy's own text.
   * @param {string} userId @param {{ apply?: boolean }} [options]
   */
  async reconcileLibrary(userId, { apply = true } = {}) {
    const report = { expected: 0, present: 0, missing: /** @type {string[]} */ ([]), stale: /** @type {string[]} */ ([]), extra: /** @type {string[]} */ ([]), pushed: 0, removed: 0, failed: /** @type {{ sourceId: string, code: string }[]} */ ([]) };
    if (!this.library) return report;
    const entries = (await this.library.searchScope(userId)).filter((/** @type {any} */ entry) => entry.status === "ready" && entry.textSha256);
    const expected = new Map(entries.map((/** @type {any} */ entry) => [entry.sourceId, entry]));
    const present = new Map((await this.resources.listSources(userId, this.resources.roots(userId, "-").library)).map((/** @type {any} */ entry) => [entry.sourceId, entry]));
    report.expected = expected.size; report.present = present.size;
    report.missing = [...expected.keys()].filter((id) => !present.has(id));
    report.stale = [...expected.keys()].filter((id) => present.has(id) && present.get(id).sha !== expected.get(id).textSha256);
    report.extra = [...present.keys()].filter((id) => !expected.has(id));
    if (!apply) return report;
    for (const sourceId of [...report.missing, ...report.stale]) {
      try {
        const text = await readFile(path.join(this.library.libraryDir(userId), sourceId, "index.md"), "utf8");
        await this.resources.pushSource(userId, this.resources.libraryUri(userId, sourceId), text, { sourceId, sha: expected.get(sourceId).textSha256, docType: "library" });
        report.pushed += 1; this.counters.pushed += 1;
      } catch (error) { report.failed.push({ sourceId, code: codeOf(error) }); this.counters.failed += 1; }
    }
    for (const sourceId of report.extra) {
      try { if (await this.resources.removeSource(userId, this.resources.libraryUri(userId, sourceId))) { report.removed += 1; this.counters.removed += 1; } }
      catch (error) { report.failed.push({ sourceId, code: codeOf(error) }); this.counters.failed += 1; }
    }
    return report;
  }

  /** Run one queued job. @param {{ userId: string, projectId?: string | null, payload: any }} job */
  async runJob(job) {
    if (!this.enabled) return { skipped: "disabled" };
    const ready = this.engine?.ready?.("knowledge");
    // Pushing needs the engine to answer, not its Compile: only "no answer" postpones a push.
    if (ready && !ready.ok && /^memory_index_|_api_key_/.test(String(ready.code))) throw Object.assign(new Error("The engine is not answering."), { code: ready.code });
    if (job.payload?.action === "library") return this.reconcileLibrary(job.userId);
    if (job.payload?.action === "forget-project") {
      const removed = await this.resources.removeTree(job.userId, this.resources.roots(job.userId, String(job.payload.forgottenProjectId)).project);
      return { action: removed ? "removed" : "absent", projectId: job.payload.forgottenProjectId };
    }
    return this.convergeSource(job.userId, String(job.payload?.sourceId ?? ""), job.payload?.projectId ?? job.projectId ?? null);
  }

  /**
   * The timer's pass: every project that has readable documents, a bounded number per pass, oldest check first.
   * @param {{ projects: () => Promise<Array<{ userId: string, projectId: string }>>, limit?: number }} options
   */
  async reconcileAll({ projects, limit = 50 }) {
    if (!this.enabled) return null;
    const summary = { at: this.now().toISOString(), projects: 0, pushed: 0, removed: 0, error: /** @type {string | null} */ (null) };
    try {
      const users = new Set();
      for (const { userId, projectId } of (await projects()).slice(0, limit)) {
        const report = await this.reconcileProject(userId, projectId);
        summary.projects += 1; summary.pushed += report.pushed; summary.removed += report.removed;
        users.add(userId);
      }
      for (const userId of users) {
        const report = await this.reconcileLibrary(userId);
        summary.pushed += report.pushed; summary.removed += report.removed;
      }
    } catch (error) { summary.error = codeOf(error); this.report(summary.error); }
    this.lastReconcile = summary;
    return summary;
  }

  status() { return { enabled: this.enabled, ...this.counters, lastReconcile: this.lastReconcile }; }
}

/** The leased worker of `ov-resource-sync` jobs, and the timer of the reconciliation. */
export class OpenVikingSourceSyncWorker {
  /** @param {{ jobs: any, service: OpenVikingSourceSync, projects?: (() => Promise<Array<{ userId: string, projectId: string }>>) | null, pollMs?: number, leaseMs?: number, reconcileMs?: number }} dependencies */
  constructor({ jobs, service, projects = null, pollMs = 2000, leaseMs = 300_000, reconcileMs = 900_000 }) {
    if (!jobs || !service) throw new TypeError("OpenVikingSourceSyncWorker dependencies are required.");
    this.jobs = jobs; this.service = service; this.projects = projects; this.pollMs = pollMs; this.leaseMs = leaseMs; this.reconcileMs = reconcileMs;
    this.workerId = `ov-resource-sync-${randomUUID()}`;
    /** @type {any} */ this.timer = null;
    /** @type {any} */ this.reconcileTimer = null;
    /** @type {Promise<any> | null} */ this.running = null;
    /** @type {Promise<any> | null} */ this.reconciling = null;
    /** @type {string | null} */ this.lastError = null;
    /** @type {string | null} */ this.lastCompletedAt = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.pollMs);
    this.timer.unref();
    if (this.projects) {
      this.reconcileTimer = setInterval(() => { void this.reconcile(); }, this.reconcileMs);
      this.reconcileTimer.unref();
    }
    void this.tick();
  }

  reconcile() {
    if (this.reconciling || !this.projects) return this.reconciling;
    this.reconciling = this.service.reconcileAll({ projects: this.projects }).catch(() => null).finally(() => { this.reconciling = null; });
    return this.reconciling;
  }

  async tick() {
    if (this.running) return this.running;
    this.running = this.#tick().catch((/** @type {any} */ error) => { this.lastError = codeOf(error); return null; }).finally(() => { this.running = null; });
    return this.running;
  }

  async #tick() {
    if (!this.service.enabled) return null;
    const job = await this.jobs.claim([SOURCE_SYNC_JOB_KIND], this.workerId, { leaseMs: this.leaseMs });
    if (!job) return null;
    try {
      const result = await this.service.runJob(job);
      await this.jobs.finish(job.userId, job.id, job.leaseToken, result);
      this.lastError = null;
      this.lastCompletedAt = new Date().toISOString();
      return result;
    } catch (error) {
      const code = codeOf(error);
      this.lastError = code;
      this.service.counters.failed += 1;
      // A document id that cannot be a path will not become one by waiting.
      const terminal = code === "source_id_invalid";
      try {
        await this.jobs.fail(job.userId, job.id, job.leaseToken, { code, message: "The document could not be synchronised with the engine." },
          { retry: !terminal, delayMs: terminal ? 0 : Math.min(600_000, 5000 * 2 ** Math.min(job.attempts, 7)) });
      } catch (/** @type {any} */ failure) {
        if (failure?.code !== "product_job_lease_lost") throw failure;
      }
      return null;
    }
  }

  status() { return { running: Boolean(this.running), lastError: this.lastError, lastCompletedAt: this.lastCompletedAt }; }

  async close() {
    if (this.timer) clearInterval(this.timer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.timer = null; this.reconcileTimer = null;
    await Promise.all([this.running, this.reconciling].filter(Boolean));
  }
}
