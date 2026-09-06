import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { HttpError } from "./security.mjs";
import { migrateProductStore, productInteger, productPayload, productTime } from "./productPersistence.mjs";
import { normalizeSourceText, sourceUnderstandingSchema, validateSourceUnderstanding, projectSourceUnderstandingOutput } from "@evimed/domain";

function projectRun(run) { return run ? { id: run.id, sessionId: run.sessionId, dispatchId: run.dispatchId } : null; }
function projectUnit(unit) { return { id: unit.id, unitType: unit.unitType, start: unit.start, end: unit.end,
  ...(typeof unit.text === "string" ? { text: unit.text } : {}), status: unit.status,
  ...(Array.isArray(unit.itemIds) ? { itemIds: unit.itemIds.map(String) } : {}) }; }
export function projectSourceManifestRecord(row) {
  const { analysis, pendingRunCancellations: _pending, outputs, ...payload } = row.payload;
  const { artifactPath: _path, ...publicOutputs } = outputs ?? {};
  if (outputs?.artifactPath != null) publicOutputs.artifactPath = sourcePath(outputs.artifactPath);
  return { ...row, payload: { ...payload, outputs: publicOutputs, ...(analysis ? { analysis: {
    generation: analysis.generation, phase: analysis.phase, schemaVersion: analysis.schemaVersion, unitCount: analysis.unitCount,
    run: projectRun(analysis.run),
  } } : {}) } };
}

/** Explicit source-derived projection shared by the API and account export. */
export function projectSourceDerivedRecord(row) {
  const p = row.payload;
  const base = { id: row.id, sourceId: p.sourceId, generation: p.generation, createdAt: row.createdAt };
  if (p.recordType === "source-understanding") return { ...base, ...projectSourceUnderstandingOutput(p.output), run: projectRun(p.run), usage: p.usage ? {
    currency: p.usage.currency, modelId: p.usage.modelId, providerId: p.usage.providerId, actualCost: p.usage.actualCost,
    inputTokens: p.usage.inputTokens, outputTokens: p.usage.outputTokens,
  } : null, units: p.units.map(projectUnit) };
  if (p.recordType === "source-capture" || row.kind === "source-unit") return { ...base, recordType: p.recordType,
    ...(p.unit ? { unit: projectUnit(p.unit) } : { content: String(p.content ?? ""), status: p.status ?? null }) };
  if (p.recordType === "source-method") return { ...base, recordType: p.recordType, status: "draft", method: projectSourceUnderstandingOutput({
    slots: {}, claims: [], methods: [p.method], omissionAudit: { reason: "Not audited." },
  }).methods[0], run: projectRun(p.run) };
  return null;
}

async function insertSourceRecords(client, userId, projectId, records) {
  if (!records.length) return;
  const payload = records.map(item => ({ kind: item.kind, id: item.id, payload: JSON.parse(productPayload(item.payload)) }));
  const result = await client.query(`WITH inserted AS (
    INSERT INTO evimed_product.documents(user_id,project_id,kind,id,payload)
    SELECT $1,$2,kind,id,payload FROM jsonb_to_recordset($3::jsonb) AS x(kind text,id text,payload jsonb)
    RETURNING user_id,kind,id,revision,payload,deleted_at
  ) INSERT INTO evimed_product.revisions(user_id,kind,id,revision,payload,deleted_at) SELECT * FROM inserted`, [userId, projectId, JSON.stringify(payload)]);
  return result;
}

function sourceRecord(row) {
  return { id: row.id, kind: row.kind, projectId: row.project_id, payload: row.payload, revision: row.revision,
    createdAt: productTime(row.created_at), updatedAt: productTime(row.updated_at), deletedAt: productTime(row.deleted_at) };
}
async function recordRevision(client, row) {
  await client.query(`INSERT INTO evimed_product.revisions(user_id,kind,id,revision,payload,deleted_at)
    VALUES ($1,$2,$3,$4,$5,$6)`, [row.user_id, row.kind, row.id, row.revision, row.payload, row.deleted_at]);
}

export const SOURCE_TYPES = Object.freeze([
  "published-paper", "preprint-manuscript", "review-guideline", "book-chapter",
  "conference-material", "grant-proposal", "research-protocol", "peer-review",
  "medical-case", "patient-record", "cohort-data", "statistical-output",
  "lecture-slides", "audio-recording", "video-recording", "course-bundle",
  "note-memo", "message-export", "administrative-record", "certificate-scan",
  "image-figure", "other",
]);

export const SOURCE_DEPTHS = Object.freeze(["skip", "index_only", "structured", "deep"]);
const CONNECTOR_TYPES = Object.freeze(["upload", "openlist", "local-agent", "internal"]);
const UNIT_TYPES = Object.freeze(["page", "slide", "segment", "column", "chunk", "row_group"]);
const UNIT_STATUSES = Object.freeze(["extracted", "indexed_only", "no_content", "failed"]);
const shaPattern = /^[a-f0-9]{64}$/;
const registrationLocks = new Map();

/** @param {unknown} value @param {string} field @param {number} max */
function text(value, field, max = 512) {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) {
    throw new HttpError(400, "source_payload_invalid", `${field} is invalid.`);
  }
  return value.trim();
}

/** @param {unknown} value @param {string} field */
function timestamp(value, field) {
  const result = text(value, field, 80);
  if (!Number.isFinite(Date.parse(result))) throw new HttpError(400, "source_payload_invalid", `${field} is invalid.`);
  return new Date(result).toISOString();
}

/** @param {string} value */
function digest(value) { return createHash("sha256").update(value).digest("hex"); }

/** @param {unknown} value */
function sourcePath(value) {
  const result = text(value, "source path", 2048).replaceAll("\\", "/").replace(/^\.\//, "");
  if (path.posix.isAbsolute(result) || result.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new HttpError(400, "source_path_invalid", "Source path must be a safe relative path.");
  }
  return result;
}

/** @param {unknown} value */
function connector(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !["type", "id"].includes(key))) {
    throw new HttpError(400, "source_connector_invalid", "Source connector is invalid.");
  }
  const candidate = /** @type {Record<string, unknown>} */ (value);
  const type = text(candidate.type, "connector type", 32);
  if (!CONNECTOR_TYPES.includes(type)) throw new HttpError(400, "source_connector_invalid", "Source connector type is unsupported.");
  return { type, id: text(candidate.id, "connector id", 160) };
}

/** A deterministic, explainable first pass. A later classifier may refine it,
 * but a source never waits for a model before it is indexed. @param {string} file */
function classify(file) {
  const lower = file.toLowerCase();
  const extension = path.posix.extname(lower);
  const name = path.posix.basename(lower, extension);
  if (/(方案|protocol|sop|checklist|检查表)/i.test(name)) return ["research-protocol", "deep", "The file name identifies a protocol, SOP or checklist."];
  if (/(grant|标书|申请书|课题申请)/i.test(name)) return ["grant-proposal", "deep", "The file name identifies a grant proposal."];
  if (/(review|审稿|peer.?review)/i.test(name)) return ["peer-review", "deep", "The file name identifies peer-review material."];
  if ([".ppt", ".pptx", ".odp"].includes(extension)) return ["lecture-slides", "structured", "The presentation format is indexed slide by slide."];
  if ([".csv", ".tsv", ".xlsx", ".xls", ".parquet", ".sav", ".dta"].includes(extension)) return ["cohort-data", "structured", "The tabular format is profiled as research data."];
  if ([".mp3", ".wav", ".m4a", ".flac"].includes(extension)) return ["audio-recording", "structured", "The audio format requires transcription and segment coverage."];
  if ([".mp4", ".mov", ".mkv", ".webm"].includes(extension)) return ["video-recording", "structured", "The video format requires aligned segment coverage."];
  if ([".png", ".jpg", ".jpeg", ".tif", ".tiff", ".svg"].includes(extension)) return ["image-figure", "index_only", "The image is indexed before optional visual extraction."];
  if ([".md", ".txt", ".rtf"].includes(extension)) return ["note-memo", "structured", "The text document can be indexed and distilled directly."];
  if ([".pdf", ".doc", ".docx", ".odt"].includes(extension)) return ["published-paper", "structured", "The document format is parsed into traceable units."];
  return ["other", "index_only", "Unknown formats enter the searchable index before deeper processing."];
}

function defaultValueVector(docType) {
  const deep = ["research-protocol", "grant-proposal", "peer-review", "medical-case", "patient-record"].includes(docType);
  const data = ["cohort-data", "statistical-output", "medical-case", "patient-record"].includes(docType);
  return {
    profileValue: deep ? 0.7 : 0.2,
    methodValue: deep ? 0.9 : 0.3,
    knowledgeValue: data ? 0.8 : 0.6,
    evidenceValue: ["published-paper", "review-guideline"].includes(docType) ? 0.9 : 0.4,
    dataValue: data ? 0.9 : 0.1,
    risk: 0,
  };
}

function isConflict(error) { return error?.code === "product_revision_conflict"; }

function retiredSourceRun(payload) {
  const pending = [...(payload.pendingRunCancellations ?? [])];
  const run = payload.analysis?.run?.id ? payload.analysis.run
    : payload.analysis?.launch ? { id: null, ...payload.analysis.launch } : null;
  if (run && !pending.some(item => item.dispatchId === run.dispatchId && item.sessionId === run.sessionId)) pending.push(run);
  return { pendingRunCancellations: pending };
}

/** Durable source manifests and coverage, built on the account-scoped product
 * document ledger and its leased job queue. */
export class SourceService {
  /** @param {any} documents @param {any} jobs @param {{extractorVersion?:string,now?:()=>Date}} options */
  constructor(documents, jobs, { extractorVersion = "evimed-analysis-1.0.0", now = () => new Date() } = {}) {
    if (!documents || !jobs) throw new TypeError("SourceService requires product documents and jobs.");
    this.documents = documents;
    this.jobs = jobs;
    this.extractorVersion = text(extractorVersion, "extractor version", 80);
    this.now = now;
  }

  /** @param {string} userId @param {Record<string,any>} input */
  async register(userId, input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new HttpError(400, "source_payload_invalid", "Source manifest is invalid.");
    const projectId = text(input.projectId, "project id", 160);
    const sourceConnector = connector(input.connector);
    const file = sourcePath(input.path);
    const sha256 = text(input.sha256, "sha256", 64).toLowerCase();
    if (!shaPattern.test(sha256)) throw new HttpError(400, "source_digest_invalid", "Source SHA-256 is invalid.");
    const size = Number(input.size);
    if (!Number.isSafeInteger(size) || size < 0 || size > 2 * 1024 * 1024 * 1024) throw new HttpError(400, "source_size_invalid", "Source size is invalid.");
    const mtime = timestamp(input.mtime, "source mtime");
    const mimeType = text(input.mimeType ?? "application/octet-stream", "MIME type", 160);
    const providerHash = input.providerHash == null ? null : text(input.providerHash, "provider hash", 256);
    const sourceId = `src_${digest(`${projectId}\0${sha256}`).slice(0, 32)}`;
    const familyId = `fam_${digest(`${projectId}\0${sourceConnector.type}\0${sourceConnector.id}\0${file}`).slice(0, 32)}`;
    return this.withRegistrationLocks([`source:${userId}:${sourceId}`, `family:${userId}:${familyId}`], async () => {
    let exact = await this.documents.get(userId, "source", sourceId);
    if (exact) {
      if (exact.projectId !== projectId) throw new HttpError(409, "source_scope_conflict", "Source digest belongs to another project.");
      if (!exact.payload.paths.includes(file)) {
        try {
          exact = await this.documents.put(userId, "source", sourceId,
            { ...exact.payload, paths: [...exact.payload.paths, file].sort(), updatedAt: this.now().toISOString() },
            { expectedRevision: exact.revision, projectId });
        } catch (error) {
          if (!isConflict(error)) throw error;
          exact = await this.documents.get(userId, "source", sourceId);
        }
      }
      const job = ["queued", "parsing"].includes(exact.payload.status)
        ? await this.enqueue(exact, userId) : null;
      return { source: exact, duplicate: true, job };
    }
    const family = await this.documents.list(userId, "source", { projectId, filter: { familyId }, limit: 100 });
    const [docType, depth, reason] = classify(file);
    const now = this.now().toISOString();
    const payload = {
      schemaVersion: 1,
      connector: sourceConnector,
      paths: [file],
      fingerprint: { sha256, size, mtime, providerHash, mimeType },
      familyId,
      version: Math.max(0, ...family.items.map((item) => Number(item.payload.version) || 0)) + 1,
      generation: 1,
      docType,
      depth,
      valueVector: defaultValueVector(docType),
      reasons: [reason],
      status: "queued",
      extractorVersion: this.extractorVersion,
      coverage: null,
      outputs: {},
      override: null,
      createdAt: now,
      updatedAt: now,
    };
    try {
      exact = await this.documents.put(userId, "source", sourceId, payload, { expectedRevision: 0, projectId });
    } catch (error) {
      if (!isConflict(error)) throw error;
      exact = await this.documents.get(userId, "source", sourceId);
      if (!exact) throw error;
      return { source: exact, duplicate: true, job: null };
    }
    const job = await this.enqueue(exact, userId);
    return { source: exact, duplicate: false, job };
    });
  }

  /** @param {string} userId @param {string} sourceId @param {Record<string,any>} input */
  async recordExtraction(userId, sourceId, input) {
    return this.mutateIngestion(userId, sourceId, input.job, current => {
      if (current.payload.status !== "parsing") throw new HttpError(409, "source_state_conflict", "The source is no longer being parsed.");
      if (input.generation != null) {
        if (input.generation !== current.payload.generation) throw new HttpError(409, "source_generation_stale", "A newer source analysis superseded this result.");
      } else if (input.expectedRevision !== current.revision) {
        throw new HttpError(409, "source_revision_conflict", "The source changed before extraction completed.");
      }
      if (!Array.isArray(input.units) || input.units.length < 1 || input.units.length > 100_000) {
        throw new HttpError(400, "source_coverage_invalid", "Extraction must account for every source unit.");
      }
      const seen = new Set();
      const units = input.units.map((unit) => {
        if (!unit || typeof unit !== "object" || Array.isArray(unit)) throw new HttpError(400, "source_coverage_invalid", "Source unit is invalid.");
        const id = text(unit.id, "unit id", 160);
        if (seen.has(id)) throw new HttpError(400, "source_coverage_invalid", "Source unit ids must be unique.");
        seen.add(id);
        const unitType = text(unit.unitType, "unit type", 32);
        const status = text(unit.status, "unit status", 32);
        if (!UNIT_TYPES.includes(unitType) || !UNIT_STATUSES.includes(status)) throw new HttpError(400, "source_coverage_invalid", "Source unit classification is invalid.");
        if (!Array.isArray(unit.itemIds) || unit.itemIds.length > 500 || unit.itemIds.some((value) => typeof value !== "string" || !value || value.length > 160)) {
          throw new HttpError(400, "source_coverage_invalid", "Source unit output ids are invalid.");
        }
        return { id, unitType, status, itemIds: [...new Set(unit.itemIds)] };
      });
      const failed = units.filter((unit) => unit.status === "failed").length;
      const parserFailureRate = Number((failed / units.length).toFixed(4));
      const threshold = current.payload.depth === "deep" ? 0.05 : current.payload.depth === "structured" ? 0.15 : 1;
      const status = parserFailureRate <= threshold ? "complete" : "needs_attention";
      const extractor = input.extractor;
      if (!extractor || typeof extractor !== "object" || Array.isArray(extractor)) throw new HttpError(400, "source_extractor_invalid", "Extractor identity is required.");
      const payload = {
        ...current.payload,
        status,
        extractor: {
          name: text(extractor.name, "extractor name", 80),
          version: text(extractor.version, "extractor version", 80),
          parser: text(extractor.parser, "parser type", 32),
        },
        coverage: {
          total: units.length,
          accounted: units.length,
          accountedPercent: 100,
          extracted: units.filter((unit) => unit.status === "extracted").length,
          indexedOnly: units.filter((unit) => unit.status === "indexed_only").length,
          noContent: units.filter((unit) => unit.status === "no_content").length,
          failed,
          percent: Number((((units.length - failed) / units.length) * 100).toFixed(2)),
          omissionRate: null,
          parserFailureRate,
          units,
          parsedAt: this.now().toISOString(),
        },
        outputs: {
          summary: text(input.summary, "source summary", 16_000),
          facts: this.count(input.facts, "facts"),
          methods: this.count(input.methods, "methods"),
          ...(input.artifactPath == null ? {} : { artifactPath: sourcePath(input.artifactPath) }),
        },
        error: null,
        omissionAudit: { status: "not_run", omissionRate: null, reason: "Question-based understanding audit has not run." },
        updatedAt: this.now().toISOString(),
      };
      return payload;
    });
  }

  /** The parser snapshot is immutable across retries and process recovery.
   * Pending capture records are not published source units or knowledge claims. */
  async freezeCapture(job, parsed) {
    return this.withSourceLease(job, async (source, client) => {
      if (source.payload.analysis?.generation === source.payload.generation) return this.loadCapture(job.userId, source, client);
      const input = normalizeSourceText({ sourceId: source.id, generation: source.payload.generation,
        docType: source.payload.docType, depth: source.payload.depth, text: parsed.text });
      const units = parsed.units ?? [];
      const failed = units.filter(unit => unit.status === "failed").length;
      const parserCoverage = { total: units.length, accounted: units.length, accountedPercent: 100,
        extracted: units.filter(unit => unit.status === "extracted").length,
        indexedOnly: units.filter(unit => unit.status === "indexed_only").length,
        noContent: units.filter(unit => unit.status === "no_content").length, failed,
        percent: units.length ? Number((100 * (units.length - failed) / units.length).toFixed(2)) : 0,
        parserFailureRate: units.length ? failed / units.length : null, omissionRate: null, parsedAt: this.now().toISOString() };
      const analysis = { generation: input.generation, phase: "indexed", schemaVersion: 1, unitCount: input.units.length,
        textSha256: digest(input.text),
        extractor: parsed.extractor, summary: String(parsed.summary).slice(0, 16000), parserCoverage };
      await insertSourceRecords(client, job.userId, job.projectId, input.units.map(unit => ({ kind: "knowledge", id: `capture:${unit.id}`,
        payload: { recordType: "source-capture", sourceId: source.id, generation: input.generation, status: "pending", unit } })));
      await this.documents.put(job.userId, "source", source.id, { ...source.payload, analysis, coverage: parserCoverage },
        { expectedRevision: source.revision, projectId: source.projectId, transactionClient: client });
      return { input, extractor: parsed.extractor, summary: parsed.summary, parserCoverage };
    });
  }

  async loadCapture(userId, source, client = this.documents.database) {
    const analysis = source.payload.analysis;
    if (analysis?.generation !== source.payload.generation) return null;
    const result = await client.query(`SELECT payload FROM evimed_product.documents WHERE user_id=$1 AND project_id=$2 AND kind='knowledge'
      AND deleted_at IS NULL AND payload->>'recordType'='source-capture' AND payload->>'sourceId'=$3 AND payload->>'generation'=$4
      ORDER BY (payload->'unit'->>'start')::integer`, [userId, source.projectId, source.id, String(source.payload.generation)]);
    const units = result.rows.map(row => row.payload.unit);
    if (units.length !== analysis.unitCount || units.some((unit, index) => unit.start !== (units[index - 1]?.end ?? 0) || unit.end - unit.start !== unit.text.length
      || unit.id !== `${source.id}:g${source.payload.generation}:u${index + 1}`)
      || digest(units.map(unit => unit.text).join("")) !== analysis.textSha256) {
      throw new HttpError(409, "source_capture_invalid", "The immutable source capture is incomplete.");
    }
    return { input: { schemaVersion: 1, sourceId: source.id, generation: source.payload.generation,
      docType: source.payload.docType, depth: source.payload.depth, schema: sourceUnderstandingSchema(source.payload.docType), units, text: units.map(unit => unit.text).join("") },
    extractor: analysis.extractor, summary: analysis.summary, parserCoverage: analysis.parserCoverage };
  }

  /** Waiting for a bounded runtime is not a failed parse or a retry attempt. */
  async deferIngestion(job, run = null, delayMs = 5000) {
    return this.withSourceLease(job, async (source, client) => {
      const bound = source.payload.analysis?.run;
      if (run && (!bound || bound.id !== run.runId || bound.sessionId !== run.sessionId || bound.dispatchId !== run.dispatchId)) {
        throw new HttpError(409, "source_run_binding_conflict", "A waiting source must already own its run binding.");
      }
      if (run) await this.documents.put(job.userId, "source", source.id, { ...source.payload,
        analysis: { ...source.payload.analysis, phase: "understanding", run: { ...source.payload.analysis?.run, id: run.runId, sessionId: run.sessionId, dispatchId: run.dispatchId } } },
      { expectedRevision: source.revision, projectId: source.projectId, transactionClient: client });
      // Validate the lease after source-row waits; the final update both checks
      // and relinquishes it. withSourceLease's normal post-operation test cannot
      // apply after deliberate release, so it is handled outside that wrapper.
      return { deferred: true, delayMs };
    }).then(async result => {
      const changed = await this.jobs.withLease(job.userId, job.id, job.leaseToken, client => client.query(`UPDATE evimed_product.jobs
        SET status='queued',attempts=greatest(0,attempts-1),run_after=clock_timestamp()+($4::integer*interval '1 millisecond'),
        lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE user_id=$1 AND id=$2 AND lease_token=$3
        AND status='running' AND lease_expires_at>clock_timestamp() RETURNING id`, [job.userId, job.id, job.leaseToken, delayMs]));
      if (!changed?.rowCount) throw new HttpError(409, "product_job_lease_lost", "Source waiting lease was lost.");
      return result;
    });
  }

  /** Persist reservation scope before the run ledger can append or prompt.
   * Recovery may bind the same ledger entry; it must not infer a new scope. */
  async bindUnderstandingLaunch(job, launch) {
    const expected = `source-understanding-${digest(`${job.payload.sourceId}\0${job.payload.sourceGeneration ?? job.payload.sourceRevision}`).slice(0, 32)}`;
    if (!launch || launch.dispatchId !== expected || typeof launch.sessionId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(launch.sessionId)) {
      throw new HttpError(400, "source_run_binding_invalid", "Invalid source understanding launch identity.");
    }
    const identity = { sessionId: launch.sessionId, dispatchId: launch.dispatchId,
      workspaceName: launch.workspaceName === "" ? "" : text(launch.workspaceName, "workspace name", 160),
      artifactDirectory: sourcePath(launch.artifactDirectory) };
    return this.mutateIngestion(job.userId, job.payload.sourceId, job, current => {
      if (current.payload.analysis?.generation !== current.payload.generation) throw new HttpError(409, "source_capture_invalid", "A source launch requires its frozen capture.");
      const previous = current.payload.analysis.launch ?? current.payload.analysis.run;
      if (previous && Object.keys(identity).some(key => identity[key] !== previous[key])) {
        throw new HttpError(409, "source_run_binding_conflict", "This source generation already owns another launch scope.");
      }
      if (current.payload.analysis.launch) return current.payload;
      return { ...current.payload, analysis: { ...current.payload.analysis, launch: identity } };
    });
  }

  async bindUnderstandingRun(job, run) {
    const expected = `source-understanding-${digest(`${job.payload.sourceId}\0${job.payload.sourceGeneration ?? job.payload.sourceRevision}`).slice(0, 32)}`;
    if (!run || run.dispatchId !== expected || typeof run.runId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(run.runId)
      || typeof run.sessionId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(run.sessionId)) throw new HttpError(400, "source_run_binding_invalid", "Invalid source understanding run binding.");
    return this.mutateIngestion(job.userId, job.payload.sourceId, job, current => {
      const bound = current.payload.analysis?.run;
      if (bound && (bound.id !== run.runId || bound.sessionId !== run.sessionId || bound.dispatchId !== run.dispatchId)) {
        throw new HttpError(409, "source_run_binding_conflict", "This source generation is already bound to a run.");
      }
      const launch = current.payload.analysis?.launch;
      if ((!bound && !launch) || (launch && ["sessionId", "dispatchId", "workspaceName", "artifactDirectory"].some(key => launch[key] !== run[key]))) {
        throw new HttpError(409, "source_run_binding_conflict", "The run must match its protected pre-dispatch launch intent.");
      }
      if (bound) return current.payload;
      return { ...current.payload, analysis: { ...current.payload.analysis, phase: "understanding",
        run: { id: run.runId, sessionId: run.sessionId, dispatchId: run.dispatchId,
          ...(run.workspaceName != null ? { workspaceName: run.workspaceName === "" ? "" : text(run.workspaceName, "workspace name", 160) } : {}),
          ...(run.artifactDirectory ? { artifactDirectory: sourcePath(run.artifactDirectory) } : {}),
        } } };
    });
  }

  /** Resolve the durable owner rather than trusting run route labels. Includes
   * tombstoned sources until their owned runtime and bytes are cleaned up. */
  async understandingRunForRun(userId, projectId, runId) {
    const result = await this.documents.database.query(`SELECT payload,deleted_at FROM evimed_product.documents
      WHERE user_id=$1 AND project_id=$2 AND kind='source' AND
        (payload->'analysis'->'run'->>'id'=$3 OR payload @> jsonb_build_object('pendingRunCancellations',jsonb_build_array(jsonb_build_object('id',$3::text))))`,
    [userId, projectId, runId]);
    const matches = result.rows.flatMap(row => [row.payload.analysis?.run, ...(row.payload.pendingRunCancellations ?? [])].filter(Boolean)
      .map(run => ({ ...run, sourceStatus: row.payload.status, sourceDeleted: Boolean(row.deleted_at),
        recoverable: !row.deleted_at && ["queued", "parsing", "failed"].includes(row.payload.status)
          && row.payload.analysis?.generation === row.payload.generation && row.payload.analysis?.run?.id === run.id
          && !(row.payload.pendingRunCancellations ?? []).some(pending => pending.id === run.id),
      })))
      .filter(run => run?.id === runId);
    if (!matches.length) return null;
    if (matches.some(run => run.sessionId !== matches[0].sessionId || run.dispatchId !== matches[0].dispatchId)) {
      throw new HttpError(409, "source_run_binding_conflict", "The source run has ambiguous durable ownership.");
    }
    return matches[0];
  }

  async understandingLaunchForDispatch(userId, projectId, dispatchId) {
    const result = await this.documents.database.query(`SELECT payload,deleted_at FROM evimed_product.documents
      WHERE user_id=$1 AND project_id=$2 AND kind='source' AND
        (payload->'analysis'->'launch'->>'dispatchId'=$3 OR payload @> jsonb_build_object('pendingRunCancellations',jsonb_build_array(jsonb_build_object('dispatchId',$3::text))))`,
    [userId, projectId, dispatchId]);
    const matches = result.rows.flatMap(row => [row.payload.analysis?.launch, ...(row.payload.pendingRunCancellations ?? []).filter(item => item.id == null)]
      .filter(launch => launch?.dispatchId === dispatchId).map(launch => ({ sessionId: launch.sessionId, dispatchId: launch.dispatchId,
        workspaceName: launch.workspaceName, artifactDirectory: launch.artifactDirectory,
        sourceStatus: row.payload.status, sourceDeleted: Boolean(row.deleted_at),
        recoverable: !row.deleted_at && ["queued", "parsing", "failed"].includes(row.payload.status)
          && row.payload.analysis?.generation === row.payload.generation && row.payload.analysis?.launch?.dispatchId === dispatchId
          && !(row.payload.pendingRunCancellations ?? []).some(pending => pending.dispatchId === dispatchId),
      })));
    if (!matches.length) return null;
    if (matches.some(launch => ["sessionId", "dispatchId", "workspaceName", "artifactDirectory"].some(key => launch[key] !== matches[0][key]))) {
      throw new HttpError(409, "source_run_binding_conflict", "The source launch has ambiguous durable ownership.");
    }
    return matches[0];
  }

  async enqueueRunCancellations(userId, source) {
    for (const run of source.payload.pendingRunCancellations ?? []) {
      const account = await this.documents.database.query("SELECT created_at::text AS generation FROM evimed_control.users WHERE id=$1", [userId]);
      // The run being canceled stays the same across later source corrections.
      // Its queue identity cannot include the source's changing generation.
      await this.jobs.enqueue(userId, "ingest", { action: "source-run-cancel", sourceId: source.id,
        accountCreatedAt: account.rows[0]?.generation, run },
      { projectId: source.projectId, idempotencyKey: `source-run-cancel:${source.id}:${run.id ?? run.dispatchId}`, rearmFailed: true });
    }
  }

  async consumeRunCancellation(job, cancel) {
    return this.withSourceLease(job, async (source, client) => {
      const run = (source.payload.pendingRunCancellations ?? []).find(item => item.id === job.payload.run?.id
        && item.sessionId === job.payload.run?.sessionId && item.dispatchId === job.payload.run?.dispatchId);
      if (!run) return { sourceId: source.id, canceled: false, reason: "already_canceled" };
      await cancel({ userId: job.userId, projectId: job.projectId, runId: run.id, sessionId: run.sessionId, dispatchId: run.dispatchId,
        workspaceName: run.workspaceName, artifactDirectory: run.artifactDirectory });
      await this.documents.put(job.userId, "source", source.id, { ...source.payload,
        pendingRunCancellations: source.payload.pendingRunCancellations.filter(item => item.sessionId !== run.sessionId || item.dispatchId !== run.dispatchId) },
      { expectedRevision: source.revision, projectId: source.projectId, transactionClient: client });
      return { sourceId: source.id, canceled: true, runId: run.id };
    }, false, true);
  }

  /** Units, structured knowledge, method drafts and current pointer are one
   * account/project/generation/lease-checked publication transaction. */
  async publishUnderstanding(job, parsed, completed = null, artifactPath = null) {
    return this.withSourceLease(job, async (source, client) => {
      const generation = source.payload.generation;
      const isSkip = source.payload.depth === "skip";
      const input = isSkip ? null : (await this.loadCapture(job.userId, source, client))?.input;
      if (!isSkip && !input) throw new HttpError(409, "source_capture_invalid", "Source capture is missing.");
      const deep = ["structured", "deep"].includes(source.payload.depth);
      if (deep && !completed?.output) throw new HttpError(409, "source_understanding_missing", "Structured depth requires its bounded understanding result.");
      if (completed) {
        const bound = source.payload.analysis?.run;
        if (!bound || bound.id !== completed.runId || bound.sessionId !== completed.sessionId || bound.dispatchId !== completed.dispatchId) {
          throw new HttpError(409, "source_run_binding_conflict", "The result belongs to a different source run.");
        }
        const issues = validateSourceUnderstanding(completed.output, input);
        if (issues.length) throw new HttpError(422, "source_understanding_invalid", issues[0]);
      }
      const id = `understanding:${source.id}:g${generation}`;
      const output = completed ? projectSourceUnderstandingOutput(completed.output) : null;
      const run = completed ? { id: completed.runId, sessionId: completed.sessionId, dispatchId: completed.dispatchId } : null;
      const units = input?.units ?? [];
      const cited = new Set(output ? [...Object.values(output.slots).flatMap(slot => slot.evidence ?? []), ...output.claims.flatMap(claim => claim.evidence), ...output.methods.flatMap(method => method.evidence)].map(anchor => anchor.unitId) : []);
      const links = output ? [
        ...Object.entries(output.slots).filter(([, slot]) => slot.state === "known").map(([key, slot]) => ({ id: `${id}:slot:${key}`, evidence: slot.evidence })),
        ...output.claims.map(claim => ({ id: `${id}:claim:${claim.id}`, evidence: claim.evidence })),
        ...output.methods.map(method => ({ id: `method:${source.id}:g${generation}:${method.id}`, evidence: method.evidence })),
      ] : [];
      const publishedUnits = units.map(unit => ({ ...unit, status: cited.has(unit.id) ? "extracted" : unit.status,
        itemIds: links.filter(link => link.evidence.some(anchor => anchor.unitId === unit.id)).map(link => link.id) }));
      const records = publishedUnits.map(unit => ({ kind: "source-unit", id: unit.id,
        payload: { recordType: "source-unit", sourceId: source.id, generation, unit, status: "indexed", provenance: [{ type: "source", id: source.id }] } }));
      if (output) {
        records.push({ kind: "knowledge", id, payload: { recordType: "source-understanding", sourceId: source.id, generation,
          status: "current", output, run, usage: completed.usage, units: publishedUnits.filter(unit => cited.has(unit.id)).map(({ text: _text, ...unit }) => unit) } });
        for (const method of output.methods) records.push({ kind: "method", id: `method:${source.id}:g${generation}:${method.id}`,
          payload: { recordType: "source-method", sourceId: source.id, generation, status: "draft", method, run } });
      }
      await insertSourceRecords(client, job.userId, job.projectId, records);
      const coverage = isSkip ? null : source.payload.analysis.parserCoverage;
      const status = coverage?.failed > 0 ? "needs_attention" : "complete";
      const payload = { ...source.payload, status, currentUnderstandingId: output ? id : null, coverage,
        omissionAudit: { status: "not_run", omissionRate: null, reason: "Question-based understanding audit has not run." },
        analysis: { ...(source.payload.analysis ?? {}), generation, phase: isSkip ? "skipped" : output ? "understood" : "indexed", run: run ? { ...source.payload.analysis?.run, ...run } : null },
        outputs: { summary: output?.summary ?? (isSkip ? "Skipped by the selected analysis depth." : parsed.summary),
          facts: output?.claims.length ?? 0, methods: output?.methods.length ?? 0,
          ...(artifactPath ? { artifactPath: sourcePath(artifactPath) } : {}) },
        extractor: isSkip ? null : parsed.extractor, error: null, updatedAt: this.now().toISOString() };
      const updated = await this.documents.put(job.userId, "source", source.id, payload, { expectedRevision: source.revision, projectId: source.projectId, transactionClient: client });
      return { sourceId: source.id, sourceRevision: updated.revision, status, understandingId: output ? id : null };
    }, false, true);
  }

  async getUnderstanding(userId, sourceId) {
    const source = await this.requireSource(userId, sourceId);
    const row = source.payload.currentUnderstandingId ? await this.documents.get(userId, "knowledge", source.payload.currentUnderstandingId) : null;
    return { sourceId, generation: source.payload.generation, depth: source.payload.depth, status: source.payload.status,
      current: row?.projectId === source.projectId && row.payload.sourceId === sourceId && row.payload.generation === source.payload.generation
        ? projectSourceDerivedRecord(await this.hydrateUnderstanding(userId, row)) : null };
  }

  async hydrateUnderstanding(userId, row) {
    const ids = row.payload.units.map(unit => unit.id);
    if (!ids.length) return row;
    const result = await this.documents.database.query(`SELECT payload->'unit' AS unit FROM evimed_product.documents
      WHERE user_id=$1 AND project_id=$2 AND kind='source-unit' AND id=ANY($3::text[]) AND deleted_at IS NULL
      AND payload->>'sourceId'=$4 AND payload->>'generation'=$5`, [userId, row.projectId, ids, row.payload.sourceId, String(row.payload.generation)]);
    if (result.rows.length !== ids.length) throw new HttpError(409, "source_capture_invalid", "Understanding source anchors are unavailable.");
    const byId = new Map(result.rows.map(item => [item.unit.id, item.unit]));
    return { ...row, payload: { ...row.payload, units: ids.map(id => byId.get(id)) } };
  }

  async understandingHistory(userId, sourceId, { limit = 20, cursor = null } = {}) {
    const source = await this.requireSource(userId, sourceId);
    const page = await this.documents.list(userId, "knowledge", { projectId: source.projectId, limit: Math.min(limit, 20), cursor,
      filter: { recordType: "source-understanding", sourceId } });
    // A bounded page never silently drops anchors or part of an understanding.
    // The cursor resumes from the last complete record returned.
    const items = [];
    let bytes = 0;
    let last = null;
    for (const row of page.items) {
      const item = projectSourceDerivedRecord(await this.hydrateUnderstanding(userId, row));
      const size = Buffer.byteLength(JSON.stringify(item));
      if (items.length && bytes + size > 2 * 1024 * 1024) return { items,
        nextCursor: Buffer.from(JSON.stringify([last.createdAt, last.id])).toString("base64url") };
      items.push(item); bytes += size; last = row;
    }
    return { items, nextCursor: page.nextCursor };
  }

  /** @param {string} userId @param {string} sourceId @param {Record<string,any>} input */
  async override(userId, sourceId, input) {
    const current = await this.requireSource(userId, sourceId);
    if (input.expectedRevision !== current.revision) throw new HttpError(409, "source_revision_conflict", "The source changed; reload before overriding it.");
    const docType = text(input.docType, "document type", 80);
    const depth = text(input.depth, "source depth", 32);
    if (!SOURCE_TYPES.includes(docType) || !SOURCE_DEPTHS.includes(depth)) throw new HttpError(400, "source_override_invalid", "Source type or depth is invalid.");
    const reason = text(input.reason, "override reason", 1000);
    const updated = await this.documents.put(userId, "source", sourceId, {
      ...current.payload, docType, depth, status: "queued", generation: (Number(current.payload.generation) || 1) + 1,
      ...retiredSourceRun(current.payload),
      reasons: [`User override: ${reason}`, ...current.payload.reasons].slice(0, 20),
      override: { docType, depth, reason, at: this.now().toISOString() },
      updatedAt: this.now().toISOString(),
    }, { expectedRevision: current.revision, projectId: current.projectId });
    await this.enqueue(updated, userId);
    if (this.documents.database) await this.enqueueRunCancellations(userId, updated);
    return updated;
  }

  /** @param {string} userId @param {string} sourceId @param {{expectedRevision:number}} input */
  async markMissing(userId, sourceId, input) {
    const current = await this.requireSource(userId, sourceId);
    if (input.expectedRevision !== current.revision) throw new HttpError(409, "source_revision_conflict", "The source changed; reload before updating it.");
    const at = this.now().toISOString();
    return this.documents.put(userId, "source", sourceId, {
      ...current.payload, status: "missing", generation: (Number(current.payload.generation) || 1) + 1,
      ...retiredSourceRun(current.payload),
      missingAt: at, updatedAt: at,
    }, { expectedRevision: current.revision, projectId: current.projectId });
  }

  /** Worker transition guarded by the user-visible processing generation.
   * @param {string} userId @param {string} sourceId @param {{generation:number,job?:any}} input */
  async beginIngestion(userId, sourceId, input) {
    return this.mutateIngestion(userId, sourceId, input.job, current => {
      if (input.generation !== current.payload.generation) throw new HttpError(409, "source_generation_stale", "A newer source analysis superseded this job.");
      if (current.payload.status === "parsing") return current.payload;
      if (!["queued", "failed"].includes(current.payload.status)) throw new HttpError(409, "source_state_conflict", "This source is not ready for processing.");
      return {
        ...current.payload, status: "parsing", error: null, updatedAt: this.now().toISOString(),
      };
    });
  }

  /** @param {string} userId @param {string} sourceId @param {{expectedRevision:number,generation?:number,code:string,message?:string,job?:any}} input */
  async recordFailure(userId, sourceId, input) {
    return this.mutateIngestion(userId, sourceId, input.job, current => {
      if (current.payload.status !== "parsing") throw new HttpError(409, "source_state_conflict", "The source is no longer being parsed.");
      if (input.generation != null) {
        if (input.generation !== current.payload.generation) throw new HttpError(409, "source_generation_stale", "A newer source analysis superseded this failure.");
      } else if (input.expectedRevision !== current.revision) {
        throw new HttpError(409, "source_revision_conflict", "A newer source analysis superseded this failure.");
      }
      return {
        ...current.payload,
        status: "failed",
        error: { code: text(input.code, "source error code", 100), message: String(input.message ?? "Source analysis failed.").slice(0, 500) },
        updatedAt: this.now().toISOString(),
      };
    });
  }

  /** @param {string} userId @param {{projectId:string,status?:string|null,limit?:number,cursor?:string|null}} options */
  async list(userId, { projectId, status = null, limit = 50, cursor = null }) {
    const selectedStatus = status == null || status === "" ? null : text(status, "source status", 40);
    return this.documents.list(userId, "source", {
      projectId: text(projectId, "project id", 160), limit, cursor,
      filter: selectedStatus ? { status: selectedStatus } : {},
    });
  }

  /** @param {string} userId @param {string} sourceId */
  async get(userId, sourceId, options = {}) { return this.requireSource(userId, sourceId, options); }

  /** @param {string} userId @param {string} sourceId @param {{expectedRevision:number}} input */
  async cancel(userId, sourceId, input) {
    const current = await this.requireSource(userId, sourceId);
    if (input.expectedRevision !== current.revision) throw new HttpError(409, "source_revision_conflict", "The source changed; reload before canceling it.");
    if (["complete", "missing", "canceled"].includes(current.payload.status)) {
      if (current.payload.status === "canceled") return current;
      throw new HttpError(409, "source_state_conflict", "This source is no longer processing.");
    }
    const updated = await this.documents.put(userId, "source", sourceId, {
      ...current.payload, status: "canceled", generation: (Number(current.payload.generation) || 1) + 1,
      ...retiredSourceRun(current.payload),
      updatedAt: this.now().toISOString(),
    }, { expectedRevision: current.revision, projectId: current.projectId });
    if (this.documents.database) await this.enqueueRunCancellations(userId, updated);
    return updated;
  }

  /** @param {string} userId @param {string} sourceId @param {{expectedRevision:number}} input */
  async retry(userId, sourceId, input) {
    const current = await this.requireSource(userId, sourceId);
    if (input.expectedRevision !== current.revision) throw new HttpError(409, "source_revision_conflict", "The source changed; reload before retrying it.");
    if (!["canceled", "failed", "needs_attention", "complete"].includes(current.payload.status)) {
      throw new HttpError(409, "source_state_conflict", "This source is already processing.");
    }
    const updated = await this.documents.put(userId, "source", sourceId, {
      ...current.payload, status: "queued", error: null,
      ...retiredSourceRun(current.payload),
      generation: (Number(current.payload.generation) || 1) + 1,
      updatedAt: this.now().toISOString(),
    }, { expectedRevision: current.revision, projectId: current.projectId });
    await this.enqueue(updated, userId, { rearmFailed: true });
    if (this.documents.database) await this.enqueueRunCancellations(userId, updated);
    return updated;
  }

  /** @param {string} userId @param {string} sourceId @param {{expectedRevision:number,accountCreatedAt?:string}} input */
  async remove(userId, sourceId, input) {
    const database = this.documents.database;
    if (!database) throw new HttpError(503, "source_state_unavailable", "Source deletion requires durable shared storage.");
    productInteger(input.expectedRevision, 1, 2_147_483_646);
    await migrateProductStore(database);
    return database.transaction(async client => {
      const account = await client.query("SELECT created_at::text AS generation FROM evimed_control.users WHERE id=$1 FOR SHARE", [userId]);
      const generation = account.rows[0]?.generation;
      if (!generation || (input.accountCreatedAt && input.accountCreatedAt !== generation)) throw new HttpError(409, "source_account_changed", "The source account changed.");
      // Workers take job locks before source locks. Preserve that order while
      // invalidating every outstanding lease and publishing the deletion job.
      const jobs = await client.query(`SELECT * FROM evimed_product.jobs WHERE user_id=$1 AND payload->>'sourceId'=$2
        AND (kind='ingest' OR (kind='consolidate' AND payload->>'action'='source-delete')) ORDER BY id FOR UPDATE`, [userId, sourceId]);
      const found = await client.query("SELECT * FROM evimed_product.documents WHERE user_id=$1 AND kind='source' AND id=$2 FOR UPDATE", [userId, sourceId]);
      const current = found.rows[0];
      if (!current) throw new HttpError(404, "source_not_found", "The source is unavailable.");
      const previous = current.payload.deletion;
      if (input.expectedRevision !== current.revision && !(current.deleted_at && input.expectedRevision === previous?.requestedRevision)) {
        throw new HttpError(409, "source_revision_conflict", "The source changed; reload before deleting it.");
      }
      if (current.deleted_at && previous?.jobId) {
        const existing = jobs.rows.find(job => job.id === previous.jobId && job.kind === "ingest" && job.payload.action === "source-delete");
        if (existing && existing.status !== "failed") return sourceRecord(current);
        if (existing) {
          await client.query(`UPDATE evimed_product.jobs SET status='queued',attempts=0,error=NULL,result=NULL,finished_at=NULL,
            run_after=clock_timestamp(),updated_at=clock_timestamp(),lease_token=NULL,lease_expires_at=NULL WHERE id=$1 AND user_id=$2`, [existing.id, userId]);
          const payload = { ...current.payload, deletion: { ...previous, status: "pending", error: null } };
          const retried = await client.query(`UPDATE evimed_product.documents SET payload=$3::jsonb,revision=revision+1,updated_at=clock_timestamp()
            WHERE user_id=$1 AND kind='source' AND id=$2 RETURNING *`, [userId, sourceId, JSON.stringify(payload)]);
          await recordRevision(client, retried.rows[0]);
          return sourceRecord(retried.rows[0]);
        }
      }
      const deletionRevision = previous?.revision ?? (current.deleted_at ? current.revision : current.revision + 1);
      const key = `source-delete:${sourceId}:${deletionRevision}`;
      const legacy = jobs.rows.find(job => job.kind === "consolidate" && job.payload.action === "source-delete" && job.idempotency_key === key);
      const jobId = previous?.jobId ?? legacy?.id ?? randomUUID();
      const sourceGeneration = previous?.sourceGeneration ?? (Number(current.payload.generation) || 1) + 1;
      const payload = { ...current.payload,
        ...(!current.payload.analysis?.run && current.payload.analysis?.launch ? retiredSourceRun(current.payload) : {}),
        generation: sourceGeneration, updatedAt: this.now().toISOString(), deletion: {
        jobId, revision: deletionRevision, requestedRevision: previous?.requestedRevision ?? input.expectedRevision,
        sourceGeneration, status: "pending", requestedAt: previous?.requestedAt ?? this.now().toISOString(),
      } };
      const updated = await client.query(`UPDATE evimed_product.documents SET payload=$3::jsonb,deleted_at=coalesce(deleted_at,clock_timestamp()),
        revision=revision+1,updated_at=clock_timestamp() WHERE user_id=$1 AND kind='source' AND id=$2 RETURNING *`, [userId, sourceId, JSON.stringify(payload)]);
      await recordRevision(client, updated.rows[0]);
      await client.query(`UPDATE evimed_product.jobs SET status='canceled',finished_at=clock_timestamp(),updated_at=clock_timestamp(),lease_token=NULL,lease_expires_at=NULL
        WHERE user_id=$1 AND kind='ingest' AND payload->>'sourceId'=$2 AND payload->>'action' IS DISTINCT FROM 'source-delete' AND status IN ('queued','running')`, [userId, sourceId]);
      // Keep audit content, but hide units and retire all explicitly linked
      // understanding. Fact revisions enqueue the existing memory-index outbox.
      await client.query(`WITH changed AS (
        UPDATE evimed_product.documents SET revision=revision+1,updated_at=clock_timestamp(),
          deleted_at=CASE WHEN kind='source-unit' THEN clock_timestamp() ELSE deleted_at END,
          payload=payload || jsonb_build_object('sourceDeleted',jsonb_build_object('sourceId',$2::text,'at',clock_timestamp()))
            || CASE WHEN kind='source-unit' THEN '{}'::jsonb ELSE '{"status":"retired"}'::jsonb END
        WHERE user_id=$1 AND kind=ANY($3::text[]) AND deleted_at IS NULL
          AND (payload->>'sourceId'=$2 OR payload @> jsonb_build_object('provenance',jsonb_build_array(jsonb_build_object('type','source','id',$2::text))))
        RETURNING user_id,kind,id,revision,payload,deleted_at
      ) INSERT INTO evimed_product.revisions(user_id,kind,id,revision,payload,deleted_at) SELECT * FROM changed`,
      [userId, sourceId, ["source-unit", "fact", "method", "knowledge", "profile"]]);
      const deletionPayload = JSON.stringify({ action: "source-delete", sourceId, sourceGeneration, deletionRevision, accountCreatedAt: generation });
      if (legacy) {
        await client.query(`UPDATE evimed_product.jobs SET kind='ingest',payload=$3::jsonb,status='queued',attempts=0,error=NULL,result=NULL,
          finished_at=NULL,run_after=clock_timestamp(),updated_at=clock_timestamp(),lease_token=NULL,lease_expires_at=NULL WHERE user_id=$1 AND id=$2`, [userId, jobId, deletionPayload]);
      } else {
        await client.query(`INSERT INTO evimed_product.jobs(id,user_id,project_id,kind,payload,idempotency_key)
          VALUES ($1,$2,$3,'ingest',$4::jsonb,$5)`, [jobId, userId, current.project_id, deletionPayload, key]);
      }
      return sourceRecord(updated.rows[0]);
    });
  }

  /** @param {any} job @param {(source:any,client:any)=>Promise<any>} operation @param {boolean} deleting @param {boolean} finish */
  async withSourceLease(job, operation, deleting = false, finish = false) {
    const database = this.documents.database;
    await migrateProductStore(database);
    const result = await database.transaction(async client => {
      // Account deletion locks this row before cascading to jobs and sources.
      // Take the same order, and check wall-clock lease validity after waiting.
      const account = await client.query("SELECT created_at::text AS generation FROM evimed_control.users WHERE id=$1 FOR SHARE", [job.userId]);
      await client.query("SELECT id FROM evimed_product.jobs WHERE user_id=$1 AND id=$2 FOR UPDATE", [job.userId, job.id]);
      const lease = await client.query(`SELECT 1 FROM evimed_product.jobs WHERE user_id=$1 AND id=$2 AND lease_token=$3
        AND status='running' AND lease_expires_at>clock_timestamp() AND kind='ingest' AND project_id=$4 AND payload=$5::jsonb`,
      [job.userId, job.id, job.leaseToken, job.projectId, JSON.stringify(job.payload)]);
      if (!lease.rowCount) throw new HttpError(409, "product_job_lease_lost", "The source job lease was lost.");
      const generation = account.rows[0]?.generation;
      if (!generation || (job.payload.accountCreatedAt && job.payload.accountCreatedAt !== generation)) throw new HttpError(409, "source_account_changed", "The source account changed.");
      const found = await client.query("SELECT * FROM evimed_product.documents WHERE user_id=$1 AND kind='source' AND id=$2 FOR UPDATE", [job.userId, job.payload.sourceId]);
      const row = found.rows[0];
      const cancelling = job.payload.action === "source-run-cancel";
      if (!row || row.project_id !== job.projectId || (!cancelling && Number(row.payload.generation) !== Number(job.payload.sourceGeneration ?? job.payload.sourceRevision))
        || (deleting ? !row.deleted_at || row.payload.deletion?.jobId !== job.id || row.payload.deletion?.revision !== job.payload.deletionRevision
          : row.deleted_at || (!cancelling && !["queued", "parsing", "failed"].includes(row.payload.status)))) throw new HttpError(409, "source_generation_stale", "This source job was superseded.");
      const output = await operation(sourceRecord(row), client);
      const live = await client.query("SELECT 1 FROM evimed_product.jobs WHERE id=$1 AND user_id=$2 AND lease_token=$3 AND status='running' AND lease_expires_at>clock_timestamp()", [job.id, job.userId, job.leaseToken]);
      if (!live.rowCount) throw new HttpError(409, "product_job_lease_lost", "The source job lease expired.");
      if (finish) {
        const completed = await client.query(`UPDATE evimed_product.jobs SET status='succeeded',result=$4::jsonb,error=NULL,finished_at=clock_timestamp(),
          updated_at=clock_timestamp(),lease_token=NULL,lease_expires_at=NULL WHERE id=$1 AND user_id=$2 AND lease_token=$3 AND status='running'
          AND lease_expires_at>clock_timestamp() RETURNING id`, [job.id, job.userId, job.leaseToken, JSON.stringify(output)]);
        if (!completed.rowCount) throw new HttpError(409, "product_job_lease_lost", "The source deletion lease expired before completion.");
      }
      return { output: finish ? { ...job, status: "succeeded", result: output, leaseToken: null } : output };
    });
    if (result == null) throw new HttpError(409, "product_job_lease_lost", "The source job lease was lost.");
    return result.output;
  }

  /** @param {any} job @param {()=>Promise<any>} operation */
  async withIngestionLease(job, operation) {
    return this.withSourceLease(job, source => {
      if (source.payload.status !== "parsing") throw new HttpError(409, "source_state_conflict", "The source is no longer being parsed.");
      return operation();
    });
  }

  /** The worker's metadata and bytes share the same durable authority boundary.
   * @param {string} userId @param {string} sourceId @param {any} job
   * @param {(source:any)=>Record<string,any>} prepare */
  async mutateIngestion(userId, sourceId, job, prepare) {
    const mutate = async (current, client = null) => {
      const payload = prepare(current);
      if (payload === current.payload) return current;
      if (!client) return this.documents.put(userId, "source", sourceId, payload, { expectedRevision: current.revision, projectId: current.projectId });
      const changed = await client.query(`UPDATE evimed_product.documents SET payload=$3::jsonb,revision=revision+1,updated_at=clock_timestamp()
        WHERE user_id=$1 AND kind='source' AND id=$2 AND revision=$4 AND deleted_at IS NULL RETURNING *`,
      [userId, sourceId, productPayload(payload), current.revision]);
      if (!changed.rowCount) throw new HttpError(409, "source_revision_conflict", "The source changed during ingestion.");
      await recordRevision(client, changed.rows[0]);
      return sourceRecord(changed.rows[0]);
    };
    if (!job) return mutate(await this.requireSource(userId, sourceId));
    if (job.userId !== userId || job.payload?.sourceId !== sourceId || job.payload.action != null) throw new HttpError(400, "source_job_invalid", "Invalid ingestion job identity.");
    return this.withSourceLease(job, mutate);
  }

  /** Stale leases may clean their own immutable attempt, never a replacement
   * account or another job. Completion has already cleared the current lease.
   * @param {any} job @param {()=>Promise<any>} operation */
  async withAttemptCleanup(job, operation) {
    if (typeof job.leaseToken !== "string" || !job.leaseToken || job.payload?.action != null) throw new HttpError(400, "source_job_invalid", "Invalid source cleanup attempt.");
    return this.documents.database.transaction(async client => {
      const account = await client.query("SELECT created_at::text AS generation FROM evimed_control.users WHERE id=$1 FOR SHARE", [job.userId]);
      const generation = account.rows[0]?.generation;
      if (!generation || (job.payload.accountCreatedAt && job.payload.accountCreatedAt !== generation)) throw new HttpError(409, "source_account_changed", "The source cleanup account changed.");
      const owned = await client.query(`SELECT 1 FROM evimed_product.jobs WHERE user_id=$1 AND id=$2 AND kind='ingest' AND project_id=$3 AND payload=$4::jsonb FOR SHARE`,
      [job.userId, job.id, job.projectId, JSON.stringify(job.payload)]);
      if (!owned.rowCount) throw new HttpError(409, "product_job_lease_lost", "The source cleanup job is no longer owned.");
      const source = await client.query("SELECT 1 FROM evimed_product.documents WHERE user_id=$1 AND kind='source' AND id=$2 AND project_id=$3 FOR SHARE", [job.userId, job.payload.sourceId, job.projectId]);
      if (!source.rowCount) throw new HttpError(409, "source_generation_stale", "The source cleanup target no longer exists.");
      return operation();
    });
  }

  /** @param {any} job @param {(job:any,source:any,jobIds:string[])=>Promise<void>} cleanup */
  async consumeDeletion(job, cleanup) {
    if (job.kind !== "ingest" || job.payload?.action !== "source-delete" || typeof job.payload.accountCreatedAt !== "string"
      || !job.payload.accountCreatedAt || !Number.isSafeInteger(job.payload.sourceGeneration) || !Number.isSafeInteger(job.payload.deletionRevision)) {
      throw new HttpError(400, "source_job_invalid", "Source deletion requires a complete owned job identity.");
    }
    return this.withSourceLease(job, async (source, client) => {
      const associated = await client.query(`SELECT id FROM evimed_product.jobs WHERE user_id=$1 AND project_id=$2 AND kind='ingest'
        AND payload->>'sourceId'=$3 AND payload->>'action' IS DISTINCT FROM 'source-delete' ORDER BY id`, [job.userId, job.projectId, source.id]);
      await cleanup(job, source, associated.rows.map(row => row.id));
      const payload = { ...source.payload, deletion: { ...source.payload.deletion, status: "complete", error: null, completedAt: this.now().toISOString() } };
      const updated = await client.query(`UPDATE evimed_product.documents SET payload=$3::jsonb,revision=revision+1,updated_at=clock_timestamp()
        WHERE user_id=$1 AND kind='source' AND id=$2 RETURNING *`, [job.userId, source.id, JSON.stringify(payload)]);
      await recordRevision(client, updated.rows[0]);
      return { sourceId: source.id, deleted: true };
    }, true, true);
  }

  /** @param {any} job @param {string} code */
  async recordDeletionFailure(job, code) {
    return this.withSourceLease(job, async (source, client) => {
      const payload = { ...source.payload, deletion: { ...source.payload.deletion, status: "failed", error: { code } } };
      const updated = await client.query(`UPDATE evimed_product.documents SET payload=$3::jsonb,revision=revision+1,updated_at=clock_timestamp()
        WHERE user_id=$1 AND kind='source' AND id=$2 RETURNING *`, [job.userId, source.id, JSON.stringify(payload)]);
      await recordRevision(client, updated.rows[0]);
    }, true);
  }

  /** @param {string} userId @param {string} sourceId @param {{includeDeleted?:boolean}} options */
  async requireSource(userId, sourceId, options = {}) {
    const source = await this.documents.get(userId, "source", text(sourceId, "source id", 160), options);
    if (!source) throw new HttpError(404, "source_not_found", "The source is unavailable.");
    return source;
  }

  /** @param {unknown} value @param {string} field */
  count(value, field) {
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result < 0 || result > 1_000_000) throw new HttpError(400, "source_output_invalid", `${field} count is invalid.`);
    return result;
  }

  async enqueue(source, userId, { rearmFailed = false } = {}) {
    const account = this.documents.database ? await this.documents.database.query("SELECT created_at::text AS generation FROM evimed_control.users WHERE id=$1", [userId]) : null;
    return this.jobs.enqueue(userId, "ingest", {
      sourceId: source.id, sourceGeneration: source.payload.generation,
      ...(account?.rows[0]?.generation ? { accountCreatedAt: account.rows[0].generation } : {}),
      extractorVersion: this.extractorVersion,
    }, { idempotencyKey: `ingest:${source.id}:generation:${source.payload.generation}`, projectId: source.projectId, rearmFailed });
  }

  async withRegistrationLocks(keys, operation) {
    const held = [];
    for (const key of [...new Set(keys)].sort()) {
      const previous = registrationLocks.get(key) ?? Promise.resolve();
      /** @type {() => void} */
      let release = () => {};
      const gate = new Promise((resolve) => { release = () => resolve(undefined); });
      const tail = previous.then(() => gate);
      registrationLocks.set(key, tail);
      await previous;
      held.push({ key, tail, release });
    }
    try { return await operation(); }
    finally {
      for (const item of held.reverse()) {
        item.release();
        void item.tail.finally(() => { if (registrationLocks.get(item.key) === item.tail) registrationLocks.delete(item.key); });
      }
    }
  }

  /** Repair missing intake jobs; an exhausted generation remains stopped until
   * explicit retry advances it. Cancellation/deletion retain their own outbox. */
  async reconcileJobs() {
    const database = this.documents.database;
    if (!database) return { scanned: 0, enqueued: 0 };
    const cancellations = await database.query(`SELECT user_id,id,project_id,payload FROM evimed_product.documents
      WHERE kind='source' AND deleted_at IS NULL AND jsonb_array_length(coalesce(payload->'pendingRunCancellations','[]'::jsonb))>0 LIMIT 100`);
    for (const row of cancellations.rows) await this.enqueueRunCancellations(row.user_id, sourceRecord(row));
    const deleted = await database.query(`SELECT d.user_id,d.id,d.revision,u.created_at::text AS account_created_at
      FROM evimed_product.documents d JOIN evimed_control.users u ON u.id=d.user_id WHERE d.kind='source' AND d.deleted_at IS NOT NULL
      AND (payload->'deletion'->>'jobId' IS NULL OR NOT EXISTS (SELECT 1 FROM evimed_product.jobs j WHERE j.user_id=d.user_id AND j.id=d.payload->'deletion'->>'jobId'))
      ORDER BY d.updated_at,d.id LIMIT 100`);
    for (const row of deleted.rows) await this.remove(row.user_id, row.id, { expectedRevision: row.revision, accountCreatedAt: row.account_created_at });
    await database.query(`UPDATE evimed_product.jobs j SET status='canceled',finished_at=clock_timestamp(),updated_at=clock_timestamp(),
      lease_token=NULL,lease_expires_at=NULL WHERE kind='consolidate' AND payload->>'action'='source-delete' AND status IN ('queued','running')
      AND NOT EXISTS (SELECT 1 FROM evimed_product.documents d WHERE d.user_id=j.user_id AND d.kind='source' AND d.id=j.payload->>'sourceId'
        AND d.deleted_at IS NOT NULL AND (d.payload->'deletion'->>'jobId' IS NULL OR d.payload->'deletion'->>'jobId'=j.id))`);
    const stalled = await database.query(`SELECT d.user_id,d.id,d.project_id,d.payload,d.revision,u.created_at::text AS account_created_at
      FROM evimed_product.documents d JOIN evimed_control.users u ON u.id=d.user_id
      WHERE d.kind='source' AND d.deleted_at IS NULL AND d.payload->>'status' IN ('queued','parsing')
      AND EXISTS (SELECT 1 FROM evimed_product.jobs j WHERE j.user_id=d.user_id AND j.project_id=d.project_id
        AND j.kind='ingest' AND j.payload->>'action' IS NULL AND j.payload->>'sourceId'=d.id
        AND j.payload->>'sourceGeneration'=d.payload->>'generation' AND j.status='failed')
      AND NOT EXISTS (SELECT 1 FROM evimed_product.jobs j WHERE j.user_id=d.user_id AND j.project_id=d.project_id
        AND j.kind='ingest' AND j.payload->>'action' IS NULL AND j.payload->>'sourceId'=d.id
        AND j.payload->>'sourceGeneration'=d.payload->>'generation' AND j.status IN ('queued','running','succeeded'))
      ORDER BY d.updated_at,d.id LIMIT 100`);
    for (const row of stalled.rows) {
      try {
        await database.transaction(async client => {
          const account = await client.query("SELECT created_at::text AS generation FROM evimed_control.users WHERE id=$1 FOR SHARE", [row.user_id]);
          if (account.rows[0]?.generation !== row.account_created_at) return;
          // Preserve the account -> jobs -> source lock order. A still-queued
          // retry or a concurrent user correction must not be terminalized.
          const generationJobs = await client.query(`SELECT status,error FROM evimed_product.jobs
            WHERE user_id=$1 AND project_id=$2 AND kind='ingest' AND payload->>'action' IS NULL
              AND payload->>'sourceId'=$3 AND payload->>'sourceGeneration'=$4 ORDER BY updated_at DESC,id FOR SHARE`,
          [row.user_id, row.project_id, row.id, String(row.payload.generation)]);
          const failed = generationJobs.rows.find(job => job.status === "failed");
          if (!failed || generationJobs.rows.some(job => ["queued", "running", "succeeded"].includes(job.status))) return;
          await this.documents.put(row.user_id, "source", row.id, { ...row.payload, status: "failed",
            error: { code: String(failed.error?.code ?? "product_job_attempts_exhausted").slice(0, 100),
              message: "Source analysis stopped. Retry starts a new source generation." }, updatedAt: this.now().toISOString() },
          { expectedRevision: row.revision, projectId: row.project_id, transactionClient: client });
        });
      } catch (error) { if (!isConflict(error)) throw error; }
    }
    const result = await database.query(`SELECT user_id,id,project_id,payload,revision FROM evimed_product.documents d
      WHERE kind='source' AND deleted_at IS NULL AND payload->>'status'=ANY($1::text[])
      AND NOT EXISTS (SELECT 1 FROM evimed_product.jobs j WHERE j.user_id=d.user_id AND j.kind='ingest'
        AND j.payload->>'action' IS NULL
        AND j.payload->>'sourceId'=d.id AND j.payload->>'sourceGeneration'=d.payload->>'generation')
      ORDER BY updated_at,id LIMIT 100`, [["queued", "parsing"]]);
    let enqueued = deleted.rows.length;
    for (const row of result.rows) {
      await this.enqueue({ id: row.id, projectId: row.project_id, revision: row.revision, payload: row.payload }, row.user_id);
      enqueued += 1;
    }
    return { scanned: result.rows.length + stalled.rows.length + deleted.rows.length, enqueued };
  }
}
