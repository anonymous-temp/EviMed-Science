import { createHash } from "node:crypto";
import path from "node:path";
import { projectResultInput, projectResultVersion, normalizeResultPath, RESULT_PRODUCER_KINDS } from "@evimed/domain/result-provenance";
import { claimEvidenceSources } from "@evimed/domain/clinical-evidence";
import { HttpError, assertProjectCapacity, mimeFor, openScopedFileNoFollow, readStableFileHandle,
  resolveScopedPath, withProjectStorageMutation, writeFileExclusiveNoFollow } from "./security.mjs";

/** @param {string|Buffer} value */
function digestOf(value) { return createHash("sha256").update(value).digest("hex"); }
/** @param {any} error */
function unavailable(error) { return error?.code === "ENOENT" || error?.code === "product_document_not_found"; }

/** Only the owned workspace is eligible; data-plane paths cannot enter through
 * arbitrary absolute paths, links, imported manifests or runtime assertions. */
export class ResultProvenanceService {
  /** @param {{documents:any,authorizeProject:(userId:string,projectId:string)=>Promise<any>,
   * authorizeReference?:(userId:string,project:any,reference:any)=>Promise<any>,
   * deriveEligibility?:(userId:string,version:any)=>Promise<any>,config?:any,maxSnapshotBytes?:number,
   * resolveCaptureContext?:(project:any,input:any)=>Promise<any>,
   * now?:()=>Date}} dependencies */
  constructor({ documents, authorizeProject, authorizeReference = null, deriveEligibility = null,
    config = {}, maxSnapshotBytes = 64 * 1024 * 1024, now = () => new Date(), resolveCaptureContext = async () => null }) {
    this.documents = documents; this.authorizeProject = authorizeProject;
    this.authorizeReference = authorizeReference; this.deriveEligibility = deriveEligibility;
    this.config = config; this.maxSnapshotBytes = maxSnapshotBytes; this.now = now;
    this.resolveCaptureContext = resolveCaptureContext;
  }

  /** @param {string} userId @param {string} projectId */
  async scope(userId, projectId) {
    const project = await this.authorizeProject(userId, projectId);
    if (!project || project.id !== projectId || typeof project.userId !== "string"
      || !project.workspaceDir || !project.metaDir || !project.rootDir || !project.baseDir) {
      throw new HttpError(403, "result_project_forbidden", "The result project is unavailable.");
    }
    resolveScopedPath(project.rootDir, path.relative(project.rootDir, project.workspaceDir));
    resolveScopedPath(project.rootDir, path.relative(project.rootDir, project.metaDir));
    return project;
  }

  /** Reauthorize captured references at read time. Without a source-specific
   * resolver, only their identity is exposed, never source bytes or authority.
   * @param {string} userId @param {any} project @param {any} reference */
  async reference(userId, project, reference) {
    const projected = projectResultInput(reference);
    if (!this.authorizeReference) return { ...projected, path: null,
      availability: projected.availability === "deleted" || projected.availability === "restricted" ? projected.availability : "reference" };
    const authorized = await this.authorizeReference(userId, project, projected);
    if (!authorized) return { ...projected, path: null, availability: "restricted" };
    return projectResultInput(authorized);
  }

  /** Capture is an internal server API, absent from browser routes. expectedDigest
   * binds an owned producer receipt to these bytes; observations without that
   * receipt remain explicitly observed, since a path may have changed already.
   * @param {{userId:string,project:any,relativePath:string,producer?:any,expectedDigest?:string,
   * inputs?:any[],code?:any,environment?:any,findings?:any[],machineValues?:any[],review?:any,supersedesVersionId?:string}} input */
  async captureFile(input) {
    const project = await this.scope(input.userId, input.project.id);
    if (project.userId !== input.project.userId || project.workspaceDir !== input.project.workspaceDir) {
      throw new HttpError(403, "result_project_forbidden", "Capture does not own this workspace.");
    }
    const relativePath = normalizeResultPath(input.relativePath);
    const context = await this.resolveCaptureContext(project, { ...input, relativePath });
    if (context) input = { ...input, inputs: [...(input.inputs ?? []), ...(context.inputs ?? [])],
      supersedesVersionId: context.supersedesVersionId ?? input.supersedesVersionId };
    const full = resolveScopedPath(project.workspaceDir, relativePath);
    const rawProducer = input.producer ?? {};
    const producer = { kind: RESULT_PRODUCER_KINDS.includes(rawProducer.kind) ? rawProducer.kind : "workspace" };
    for (const field of ["sessionId", "runId", "callId", "eventId", "parentSessionId", "branchId"]) {
      if (rawProducer[field] != null && (typeof rawProducer[field] !== "string" || rawProducer[field].length > 256)) {
        throw new HttpError(400, "result_producer_invalid", "Invalid producer identity.");
      }
      producer[field] = rawProducer[field] ?? null;
    }
    if (input.inputs && (!Array.isArray(input.inputs) || input.inputs.length > 256)) {
      throw new HttpError(413, "result_inputs_too_large", "Too many result input references.");
    }
    const inputs = await Promise.all((input.inputs ?? []).map(reference => this.reference(input.userId, project, reference)));
    const code = input.code ? await this.reference(input.userId, project, input.code) : null;
    const environment = input.environment ? await this.reference(input.userId, project, input.environment) : null;
    return withProjectStorageMutation(project, async () => {
      let opened;
      let bytes;
      try {
        opened = await openScopedFileNoFollow(project.workspaceDir, full);
        if (opened.stat.size > this.maxSnapshotBytes) throw new HttpError(413, "result_snapshot_too_large", "Result exceeds the snapshot size limit.");
        bytes = await readStableFileHandle(opened.handle, opened.stat);
      } finally { await opened?.handle.close(); }
      const digest = digestOf(bytes);
      if (input.expectedDigest && input.expectedDigest !== digest) {
        throw new HttpError(409, "result_capture_changed", "Result bytes no longer match the owned producer receipt.");
      }
      const artifactId = `ra_${digestOf(JSON.stringify([project.userId, project.id, relativePath]))}`;
      const versionId = `rv_${digestOf(JSON.stringify([project.userId, project.id, producer.sessionId, producer.runId,
        producer.callId ?? producer.eventId, relativePath, digest]))}`;
      const existing = await this.documents.get(project.userId, "result-version", versionId);
      if (existing) return this.project(input.userId, project, existing.payload);
      if (input.supersedesVersionId) await this.get(input.userId, project.id, input.supersedesVersionId);
      const storagePath = `result-snapshots/${digest}`;
      const snapshot = resolveScopedPath(project.metaDir, storagePath);
      // The store's baseDir is workspaceRoot; metadata is its sibling. Count
      // the owned project root so immutable history consumes the same quota.
      await assertProjectCapacity({ ...project, baseDir: project.rootDir }, snapshot, bytes.length, this.config);
      try { await writeFileExclusiveNoFollow(project.rootDir, snapshot, bytes); }
      catch (error) {
        if (error?.code !== "EEXIST") throw error;
        // Another process may have published this same content; verify its bytes.
        await this.readSnapshot(project, { storagePath, digest, size: bytes.length });
      }
      const producerStatus = input.expectedDigest ? "bound" : producer.callId || producer.eventId || producer.runId ? "observed" : "unknown";
      const coverage = { snapshot: "complete", producer: producerStatus,
        inputs: inputs.length && inputs.every(reference => reference.digest && reference.availability === "captured") ? "captured" : "unknown",
        code: code?.digest && code.availability === "captured" ? "captured" : "unknown",
        environment: environment?.digest && environment.availability === "captured" ? "captured" : "unknown", gaps: [] };
      if (producerStatus !== "bound") coverage.gaps.push("producer_bytes_not_bound");
      if (coverage.inputs !== "captured") coverage.gaps.push("inputs_not_fully_captured");
      if (coverage.code !== "captured") coverage.gaps.push("code_not_captured");
      if (coverage.environment !== "captured") coverage.gaps.push("environment_not_captured");
      const payload = { recordType: "result-version", artifactId, versionId, projectId: project.id,
        path: relativePath, digest, size: bytes.length, mimeType: mimeFor(full), capturedAt: this.now().toISOString(),
        producer, inputs, code, environment, findings: input.findings ?? [], machineValues: input.machineValues ?? [],
        review: input.review ?? null, coverage, supersedesVersionId: input.supersedesVersionId ?? null, storagePath };
      // Validate before publication; ProductDocuments bounds serialized metadata.
      projectResultVersion(payload);
      try { await this.documents.put(project.userId, "result-version", versionId, payload, { expectedRevision: 0, projectId: project.id }); }
      catch (error) {
        if (error?.code !== "product_revision_conflict") throw error;
        const raced = await this.documents.get(project.userId, "result-version", versionId);
        if (!raced || raced.payload.digest !== digest) throw error;
        return this.project(input.userId, project, raced.payload);
      }
      return this.project(input.userId, project, payload);
    });
  }

  /** Partial files survive an unavailable sibling; each failure is explicit.
   * @param {any} input @param {string[]} paths */
  async captureFiles(input, paths) {
    const items = []; const failures = [];
    for (const relativePath of [...new Set(paths)]) {
      try { items.push(await this.captureFile({ ...input, relativePath })); }
      catch (error) { failures.push({ path: relativePath, code: error?.code ?? "result_capture_failed" }); }
    }
    return { items, failures };
  }

  /** @param {string} userId @param {any} project @param {any} payload */
  async project(userId, project, payload) {
    const value = projectResultVersion(payload);
    value.coverage = { ...value.coverage, gaps: [...(value.coverage?.gaps ?? [])] };
    value.inputs = await Promise.all(value.inputs.map(reference => this.reference(userId, project, reference)));
    value.code = value.code ? await this.reference(userId, project, value.code) : null;
    value.environment = value.environment ? await this.reference(userId, project, value.environment) : null;
    value.findings = await Promise.all(value.findings.map(async finding => ({ ...finding,
      sourceRefs: await Promise.all((Array.isArray(finding.sourceRefs) ? finding.sourceRefs : []).map(reference =>
        this.reference(userId, project, { kind: "source", ...reference }))),
    })));
    const denied = value.inputs.some(reference => reference.availability === "restricted")
      || value.findings.some(finding => finding.sourceRefs.some(reference => reference.availability === "restricted"));
    if (denied && !value.coverage.gaps.includes("inputs_restricted")) value.coverage.gaps.push("inputs_restricted");
    if (value.review) {
      const review = value.review;
      let bound = false;
      if (review.matrixVersionId && review.matrixDigest && !denied) {
        const matrix = await this.reference(userId, project, { kind: "artifact", id: review.matrixVersionId,
          versionId: review.matrixVersionId, digest: review.matrixDigest, availability: "captured" });
        bound = matrix.availability === "captured" && (!review.matrixText || digestOf(Buffer.from(review.matrixText)) === review.matrixDigest);
      }
      if (!bound) value.review = { ...review, status: denied ? "unavailable" : "unknown", matrixText: null, verification: null };
    }
    value.reuseEligibility = this.deriveEligibility ? await this.deriveEligibility(userId, value) : {
      replay: { status: "unavailable", reasons: ["no_owned_deterministic_recipe"] },
      export: { status: "partial", reasons: value.coverage.gaps },
    };
    return value;
  }

  /** @param {string} userId @param {string} projectId @param {string} versionId */
  async get(userId, projectId, versionId) {
    const project = await this.scope(userId, projectId);
    const row = await this.documents.get(project.userId, "result-version", versionId);
    if (!row || row.projectId !== project.id || row.payload.recordType !== "result-version") {
      throw new HttpError(404, "result_version_unavailable", "Result version is unavailable.");
    }
    return this.project(userId, project, row.payload);
  }

  /** @param {string} userId @param {{projectId:string,path?:string,runId?:string,limit?:number,cursor?:string|null}} options */
  async list(userId, { projectId, path: selectedPath, runId, limit = 50, cursor = null }) {
    const project = await this.scope(userId, projectId);
    const filter = { recordType: "result-version", ...(selectedPath ? { path: normalizeResultPath(selectedPath) } : {}),
      ...(runId ? { producer: { runId } } : {}) };
    const page = await this.documents.list(project.userId, "result-version", { projectId, filter, limit, cursor });
    return { items: await Promise.all(page.items.map(row => this.project(userId, project, row.payload))), nextCursor: page.nextCursor };
  }

  /** Directly recorded successors and the exact parent, never filename similarity. */
  async related(userId, { projectId, versionId, limit = 50, cursor = null }) {
    const project = await this.scope(userId, projectId);
    const selected = await this.get(userId, projectId, versionId);
    const page = await this.documents.list(project.userId, "result-version", { projectId, limit, cursor,
      filter: { recordType: "result-version", supersedesVersionId: selected.versionId } });
    const items = await Promise.all(page.items.map(row => this.project(userId, project, row.payload)));
    if (!cursor && selected.supersedesVersionId) {
      try { items.push(await this.get(userId, projectId, selected.supersedesVersionId)); }
      catch (error) { if (![403, 404].includes(error?.status)) throw error; }
    }
    return { items, nextCursor: page.nextCursor };
  }

  /** @param {any} project @param {any} payload */
  async readSnapshot(project, payload) {
    if (payload.storagePath !== `result-snapshots/${payload.digest}`) throw new HttpError(409, "result_snapshot_invalid", "Invalid snapshot location.");
    let opened;
    try {
      opened = await openScopedFileNoFollow(project.rootDir, resolveScopedPath(project.metaDir, payload.storagePath));
      if (opened.stat.size !== payload.size || opened.stat.size > this.maxSnapshotBytes) throw new HttpError(409, "result_snapshot_changed", "Preserved result bytes changed.");
      const bytes = await readStableFileHandle(opened.handle, opened.stat);
      if (digestOf(bytes) !== payload.digest) throw new HttpError(409, "result_snapshot_changed", "Preserved result bytes changed.");
      return bytes;
    } catch (error) {
      if (unavailable(error)) throw new HttpError(404, "result_snapshot_unavailable", "Preserved result bytes are unavailable.");
      throw error;
    } finally { await opened?.handle.close(); }
  }

  /** @param {string} userId @param {string} projectId @param {string} versionId */
  async raw(userId, projectId, versionId) {
    const project = await this.scope(userId, projectId);
    const version = await this.get(userId, projectId, versionId);
    const bytes = await this.readSnapshot(project, { ...version, storagePath: `result-snapshots/${version.digest}` });
    if (version.coverage.gaps.includes("inputs_restricted")) {
      const row = await this.documents.get(project.userId, "result-version", versionId);
      const denied = [...version.inputs, ...version.findings.flatMap(finding => finding.sourceRefs)]
        .filter(reference => reference.availability === "restricted");
      const matches = source => denied.some(reference => source.versionId && source.versionId === reference.versionId
        || source.artifactPath && source.artifactPath === row.payload.inputs?.find(input => input.id === reference.id)?.path
        || typeof source.identifier === "string" && source.identifier.replace(/^(?:doi:|https?:\/\/doi\.org\/)/i, "").toLowerCase() === reference.id.toLowerCase());
      const quotes = row.payload.findings?.flatMap(finding => (finding.sourceRefs ?? [])
        .filter(reference => denied.some(item => item.id === reference.id)).flatMap(reference => [reference.quote, reference.supportQuote])) ?? [];
      const matrices = [row.payload.review?.matrixText, bytes.toString("utf8")];
      let embeddedRestrictedMatrix = false;
      // The recorded matrix relation lets a report's exact embedded quotes be
      // protected without denying unrelated outputs merely naming an input.
      for (const input of version.inputs.filter(reference => reference.kind === "artifact" && reference.versionId && reference.availability === "captured")) {
        const matrix = await this.documents.get(project.userId, "result-version", input.versionId);
        if (matrix?.projectId === project.id && matrix.payload.digest === input.digest && /clinical-evidence-matrix\.json$/.test(matrix.payload.path)) {
          try { matrices.push((await this.readSnapshot(project, matrix.payload)).toString("utf8")); }
          catch (error) { if (error?.code !== "result_snapshot_unavailable") throw error; }
        }
      }
      for (const text of matrices.filter(Boolean)) {
        try {
          const matrix = JSON.parse(text);
          for (const claim of Array.isArray(matrix.claims) ? matrix.claims : []) {
            for (const source of claimEvidenceSources(claim).filter(matches)) {
              quotes.push(source.supportQuote, source.quote);
              if (text === bytes.toString("utf8") && [source.supportQuote, source.quote].some(quote => typeof quote === "string" && quote.length > 0)) embeddedRestrictedMatrix = true;
            }
          }
        } catch { /* Non-matrix output retains its independently authorized bytes. */ }
      }
      if (embeddedRestrictedMatrix || quotes.some(quote => typeof quote === "string" && quote.length > 0 && bytes.includes(Buffer.from(quote)))) {
        throw new HttpError(403, "result_input_restricted", "The result embeds a quotation from a currently restricted source.");
      }
    }
    return { version, bytes };
  }
}
