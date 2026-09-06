import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { HttpError } from "./security.mjs";
import { migrateProductStore, productInteger, productPayload, productTime } from "./productPersistence.mjs";

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
      const job = ["queued", "parsing", "failed"].includes(exact.payload.status)
        ? await this.enqueue(exact, userId, { rearmFailed: true }) : null;
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
          accountedPercent: 100,
          extracted: units.filter((unit) => unit.status === "extracted").length,
          indexedOnly: units.filter((unit) => unit.status === "indexed_only").length,
          noContent: units.filter((unit) => unit.status === "no_content").length,
          failed,
          percent: Number((((units.length - failed) / units.length) * 100).toFixed(2)),
          omissionRate,
          units,
          auditedAt: this.now().toISOString(),
        },
        outputs: {
          summary: text(input.summary, "source summary", 16_000),
          facts: this.count(input.facts, "facts"),
          methods: this.count(input.methods, "methods"),
          ...(input.artifactPath == null ? {} : { artifactPath: sourcePath(input.artifactPath) }),
        },
        error: null,
        updatedAt: this.now().toISOString(),
      };
      return payload;
    });
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
      reasons: [`User override: ${reason}`, ...current.payload.reasons].slice(0, 20),
      override: { docType, depth, reason, at: this.now().toISOString() },
      updatedAt: this.now().toISOString(),
    }, { expectedRevision: current.revision, projectId: current.projectId });
    await this.enqueue(updated, userId);
    return updated;
  }

  /** @param {string} userId @param {string} sourceId @param {{expectedRevision:number}} input */
  async markMissing(userId, sourceId, input) {
    const current = await this.requireSource(userId, sourceId);
    if (input.expectedRevision !== current.revision) throw new HttpError(409, "source_revision_conflict", "The source changed; reload before updating it.");
    const at = this.now().toISOString();
    return this.documents.put(userId, "source", sourceId, {
      ...current.payload, status: "missing", generation: (Number(current.payload.generation) || 1) + 1,
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
    return this.documents.put(userId, "source", sourceId, {
      ...current.payload, status: "canceled", generation: (Number(current.payload.generation) || 1) + 1,
      updatedAt: this.now().toISOString(),
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
      ...current.payload, status: "queued", error: null,
      generation: (Number(current.payload.generation) || 1) + 1,
      updatedAt: this.now().toISOString(),
    }, { expectedRevision: current.revision, projectId: current.projectId });
    await this.enqueue(updated, userId, { rearmFailed: true });
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
      const payload = { ...current.payload, generation: sourceGeneration, updatedAt: this.now().toISOString(), deletion: {
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
      if (!row || row.project_id !== job.projectId || Number(row.payload.generation) !== Number(job.payload.sourceGeneration ?? job.payload.sourceRevision)
        || (deleting ? !row.deleted_at || row.payload.deletion?.jobId !== job.id || row.payload.deletion?.revision !== job.payload.deletionRevision
          : row.deleted_at || !["queued", "parsing", "failed"].includes(row.payload.status))) throw new HttpError(409, "source_generation_stale", "This source job was superseded.");
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

  async enqueue(source, userId, { rearmFailed = false, keySuffix = "" } = {}) {
    const account = this.documents.database ? await this.documents.database.query("SELECT created_at::text AS generation FROM evimed_control.users WHERE id=$1", [userId]) : null;
    return this.jobs.enqueue(userId, "ingest", {
      sourceId: source.id, sourceGeneration: source.payload.generation,
      ...(account?.rows[0]?.generation ? { accountCreatedAt: account.rows[0].generation } : {}),
      extractorVersion: this.extractorVersion,
    }, { idempotencyKey: `ingest:${source.id}:generation:${source.payload.generation}${keySuffix}`, projectId: source.projectId, rearmFailed });
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

  /** Repair the write-before-enqueue crash window and re-arm failed outbox jobs. */
  async reconcileJobs() {
    const database = this.documents.database;
    if (!database) return { scanned: 0, enqueued: 0 };
    const deleted = await database.query(`SELECT d.user_id,d.id,d.revision,u.created_at::text AS account_created_at
      FROM evimed_product.documents d JOIN evimed_control.users u ON u.id=d.user_id WHERE d.kind='source' AND d.deleted_at IS NOT NULL
      AND (payload->'deletion'->>'jobId' IS NULL OR NOT EXISTS (SELECT 1 FROM evimed_product.jobs j WHERE j.user_id=d.user_id AND j.id=d.payload->'deletion'->>'jobId'))
      ORDER BY d.updated_at,d.id LIMIT 100`);
    for (const row of deleted.rows) await this.remove(row.user_id, row.id, { expectedRevision: row.revision, accountCreatedAt: row.account_created_at });
    await database.query(`UPDATE evimed_product.jobs j SET status='canceled',finished_at=clock_timestamp(),updated_at=clock_timestamp(),
      lease_token=NULL,lease_expires_at=NULL WHERE kind='consolidate' AND payload->>'action'='source-delete' AND status IN ('queued','running')
      AND NOT EXISTS (SELECT 1 FROM evimed_product.documents d WHERE d.user_id=j.user_id AND d.kind='source' AND d.id=j.payload->>'sourceId'
        AND d.deleted_at IS NOT NULL AND (d.payload->'deletion'->>'jobId' IS NULL OR d.payload->'deletion'->>'jobId'=j.id))`);
    const result = await database.query(`SELECT user_id,id,project_id,payload,revision FROM evimed_product.documents d
      WHERE kind='source' AND deleted_at IS NULL AND payload->>'status'=ANY($1::text[])
      AND NOT EXISTS (SELECT 1 FROM evimed_product.jobs j WHERE j.user_id=d.user_id AND j.kind='ingest'
        AND j.payload->>'action' IS DISTINCT FROM 'source-delete'
        AND j.payload->>'sourceId'=d.id AND j.payload->>'sourceGeneration'=d.payload->>'generation'
        AND j.status IN ('queued','running','succeeded'))
      ORDER BY updated_at,id LIMIT 100`, [["queued", "parsing", "failed"]]);
    let enqueued = deleted.rows.length;
    for (const row of result.rows) {
      await this.enqueue({ id: row.id, projectId: row.project_id, revision: row.revision, payload: row.payload }, row.user_id,
        { rearmFailed: true, keySuffix: `:reconcile:${row.revision}` });
      enqueued += 1;
    }
    return { scanned: result.rows.length + deleted.rows.length, enqueued };
  }
}
