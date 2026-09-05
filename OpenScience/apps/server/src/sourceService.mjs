import { createHash } from "node:crypto";
import path from "node:path";
import { HttpError } from "./security.mjs";

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
      return { source: exact, duplicate: true, job: null };
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
    const job = await this.jobs.enqueue(userId, "ingest", {
      sourceId, sourceRevision: exact.revision, extractorVersion: this.extractorVersion,
    }, { idempotencyKey: `ingest:${sourceId}:${this.extractorVersion}`, projectId });
    return { source: exact, duplicate: false, job };
  }

  /** @param {string} userId @param {string} sourceId @param {Record<string,any>} input */
  async recordExtraction(userId, sourceId, input) {
    const current = await this.requireSource(userId, sourceId);
    if (input.expectedRevision !== current.revision) throw new HttpError(409, "source_revision_conflict", "The source changed before extraction completed.");
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
    const omissionRate = Number((failed / units.length).toFixed(4));
    const threshold = current.payload.depth === "deep" ? 0.05 : current.payload.depth === "structured" ? 0.15 : 1;
    const status = omissionRate <= threshold ? "complete" : "needs_attention";
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
        extracted: units.filter((unit) => unit.status === "extracted").length,
        indexedOnly: units.filter((unit) => unit.status === "indexed_only").length,
        noContent: units.filter((unit) => unit.status === "no_content").length,
        failed,
        percent: 100,
        omissionRate,
        units,
        auditedAt: this.now().toISOString(),
      },
      outputs: {
        summary: text(input.summary, "source summary", 16_000),
        facts: this.count(input.facts, "facts"),
        methods: this.count(input.methods, "methods"),
      },
      error: null,
      updatedAt: this.now().toISOString(),
    };
    return this.documents.put(userId, "source", sourceId, payload, { expectedRevision: current.revision, projectId: current.projectId });
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
      ...current.payload, docType, depth, status: "queued",
      reasons: [`User override: ${reason}`, ...current.payload.reasons].slice(0, 20),
      override: { docType, depth, reason, at: this.now().toISOString() },
      updatedAt: this.now().toISOString(),
    }, { expectedRevision: current.revision, projectId: current.projectId });
    await this.jobs.enqueue(userId, "ingest", {
      sourceId, sourceRevision: updated.revision, extractorVersion: this.extractorVersion, reason: "override",
    }, { idempotencyKey: `ingest:${sourceId}:override:${updated.revision}`, projectId: current.projectId });
    return updated;
  }

  /** @param {string} userId @param {string} sourceId @param {{expectedRevision:number}} input */
  async markMissing(userId, sourceId, input) {
    const current = await this.requireSource(userId, sourceId);
    if (input.expectedRevision !== current.revision) throw new HttpError(409, "source_revision_conflict", "The source changed; reload before updating it.");
    const at = this.now().toISOString();
    return this.documents.put(userId, "source", sourceId, {
      ...current.payload, status: "missing", missingAt: at, updatedAt: at,
    }, { expectedRevision: current.revision, projectId: current.projectId });
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
  async get(userId, sourceId) { return this.requireSource(userId, sourceId); }

  /** @param {string} userId @param {string} sourceId @param {{expectedRevision:number}} input */
  async cancel(userId, sourceId, input) {
    const current = await this.requireSource(userId, sourceId);
    if (input.expectedRevision !== current.revision) throw new HttpError(409, "source_revision_conflict", "The source changed; reload before canceling it.");
    if (["complete", "missing", "canceled"].includes(current.payload.status)) {
      if (current.payload.status === "canceled") return current;
      throw new HttpError(409, "source_state_conflict", "This source is no longer processing.");
    }
    return this.documents.put(userId, "source", sourceId, {
      ...current.payload, status: "canceled", updatedAt: this.now().toISOString(),
    }, { expectedRevision: current.revision, projectId: current.projectId });
  }

  /** @param {string} userId @param {string} sourceId @param {{expectedRevision:number}} input */
  async retry(userId, sourceId, input) {
    const current = await this.requireSource(userId, sourceId);
    if (input.expectedRevision !== current.revision) throw new HttpError(409, "source_revision_conflict", "The source changed; reload before retrying it.");
    if (!["canceled", "failed", "needs_attention", "complete"].includes(current.payload.status)) {
      throw new HttpError(409, "source_state_conflict", "This source is already processing.");
    }
    const updated = await this.documents.put(userId, "source", sourceId, {
      ...current.payload, status: "queued", error: null, updatedAt: this.now().toISOString(),
    }, { expectedRevision: current.revision, projectId: current.projectId });
    await this.jobs.enqueue(userId, "ingest", {
      sourceId, sourceRevision: updated.revision, extractorVersion: this.extractorVersion, reason: "retry",
    }, { idempotencyKey: `ingest:${sourceId}:retry:${updated.revision}`, projectId: current.projectId, rearmFailed: true });
    return updated;
  }

  /** @param {string} userId @param {string} sourceId @param {{expectedRevision:number}} input */
  async remove(userId, sourceId, input) {
    const current = await this.requireSource(userId, sourceId);
    if (input.expectedRevision !== current.revision) throw new HttpError(409, "source_revision_conflict", "The source changed; reload before deleting it.");
    const removed = await this.documents.remove(userId, "source", sourceId, current.revision);
    await this.jobs.enqueue(userId, "consolidate", { action: "source-delete", sourceId }, {
      idempotencyKey: `source-delete:${sourceId}:${removed.revision}`, projectId: current.projectId,
    });
    return removed;
  }

  /** @param {string} userId @param {string} sourceId */
  async requireSource(userId, sourceId) {
    const source = await this.documents.get(userId, "source", text(sourceId, "source id", 160));
    if (!source) throw new HttpError(404, "source_not_found", "The source is unavailable.");
    return source;
  }

  /** @param {unknown} value @param {string} field */
  count(value, field) {
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result < 0 || result > 1_000_000) throw new HttpError(400, "source_output_invalid", `${field} count is invalid.`);
    return result;
  }
}
