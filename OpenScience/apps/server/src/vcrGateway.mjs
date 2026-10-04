// 「虚拟临研」 for the runtime's `vcr_read`, `vcr_write`, `vcr_simulate`,
// `trial_registry_record` and `evidence_pool` tools (build contract §3.2).
//
// The same shape as every internal gateway (layer 3): one path prefix, one
// handler, closed fields, and the runtime's own model-gateway token as the
// only credential. **The token names the account and the project, and the
// project names the study** — there is no id parameter a run could point at
// another account's data.
//
//   POST /internal/vcr/v1/read      {what, filter?}                 → aggregates and structure only
//   POST /internal/vcr/v1/write     {what, items? | data?}          → {ok, ids, issues[]}
//   POST /internal/vcr/v1/simulate  {action, kind?, scenario?, …}   → {jobId, state, progress}
//
// Hidden knowledge:
//
// - **A read never carries a small cell.** Every read passes through the
//   service's `runtimeRead`, which applies the domain's `suppressForModel`
//   exactly once (a cell speaking for fewer than ten people is hidden with its
//   neighbours; integration contract §4), and so does a simulate answer that
//   carries a result. The runtime holds no database credential and no
//   data-plane mount; this is the whole surface.
// - **A write refuses item by item.** A 200 with `ok: false` and the issues is
//   a write that wrote nothing, not an error. An error code means the call
//   itself could not be read — a `what` outside the vocabulary, a payload of
//   the wrong shape. Inside an item, every field is checked before anything of
//   that item is written: a field outside the item's closed list, a value
//   outside its vocabulary, an id that is not this study's — each refuses the
//   item by name, and nothing is coerced into something it was not (a criterion
//   kind that is neither inclusion nor exclusion used to become inclusion).
//   What the store refuses underneath (a constraint, a lock timeout) is one
//   item's issue too, never a failed batch.
// - **A model may not write a number it did not compute.** `results`,
//   `counts`, `measures`, `waterfall`, `cells`, `prediction` and their kin are
//   not writable at any depth, and an item that smuggles one is refused by name
//   rather than having it quietly dropped: a silently ignored field is a silent
//   parameter change (principle 1 — numbers come from the engine, never from
//   the model). The fields a page fills from a result — a population's counts,
//   waterfall, quality report and profile, a design grid's cells, a forecast's
//   prediction — are not fields of any write at all; an assumption drawn from
//   the literature is made by the platform from the engine's pooling of this
//   study's verified extractions, and a value a run reads out of a record is
//   checked in code against the record's preserved text before it is stored.
// - **A changed assumption propagates on the way in.** The write path calls
//   the orchestrator's `recomputeAfterChange`, so 「改一处，自动知道哪些结果要
//   重算」 happens whether the edit came from a person or from a run (§6.3).
// - **Simulate is start/status, the same shape as `meta_analysis`.** A run
//   queues a frozen scenario and polls; it never waits on a socket for a
//   simulation, and a job outliving the run is normal — the study collects it.
//   Two kinds are not a scenario a run states: `pool_evidence` names a
//   parameter, and the platform builds the engine's job from this study's
//   verified extractions; `match_criteria` names nothing, and the platform
//   freezes the protocol's criteria itself.
// - What failed underneath (a database's SQLSTATE) is the operator's to know
//   and never the run's: its code goes to `report`, the run hears
//   `vcr_gateway_unavailable`.

import { createHash } from "node:crypto";

import {
  VCR_ASSUMPTION_KEY, VCR_CRITERION_TYPES, VCR_DISTRIBUTIONS, VCR_ENDPOINT_TYPES, VCR_ESTIMANDS, VCR_EXPORT_KINDS, VCR_EXPORT_KIND_LABELS_ZH,
  VCR_FOLLOWUP_KINDS, VCR_INTENDED_USES, VCR_JOB_KINDS, VCR_MODEL_RISKS, VCR_POPULATION_KINDS, VCR_SCENARIO_SCHEMAS,
  VCR_STEPS, VCR_SYNTHETIC_USES, VCR_TRIAL_DESIGNS, canonicalScenarioJson, findExpressionFields, validateRequirement,
} from "@evimed/domain";

import { HttpError } from "./security.mjs";
import { VCR_READ_WHATS, VCR_READ_MAX_ITEMS, VCR_WRITE_WHATS, vcrRouteOptions } from "./vcrService.mjs";
import { renderVcrNumbers } from "./vcrRender.mjs";
import { EVIDENCE_ARM_ROLES } from "./vcrEvidenceStore.mjs";
import { VCR_TRIAL_RESTRICTED_FIELDS, deriveFromExit, followupFidelityFindings, postExitEpisode, trialPeriodEpisode } from "./vcrRecruit.mjs";
import { VCR_MATCHING_VOCABULARY_VERSION } from "./vcrMatching.mjs";
import { VCR_RECONSTRUCTION_REFERENCE } from "./vcrJobs.mjs";
import { readPoolResult, distributionFromPooled, naturalOf, parameterKindOf, poolTargetOf, defaultScaleOf, defaultArmRoleOf, VCR_POOL_MAX_STUDIES } from "./vcrEvidence.mjs";

const gatewayPath = "/internal/vcr/v1";
const operations = Object.freeze(["read", "write", "simulate"]);
/** Calls one study may make per minute, per operation: the ceiling of a loop, not of a run. */
const windowLimits = Object.freeze({ read: 120, write: 60, simulate: 60 });
const requestLimits = Object.freeze({ read: 16 * 1024, write: 512 * 1024, simulate: 256 * 1024 });
/** Reads, writes and job submissions answer within ten seconds; the engine runs elsewhere. */
const answerBudgetMs = 10_000;
/**
 * A registry read waits on a registry that may take its time: the gateway's
 * budget for it is the client's own deadline plus a margin, never less (a
 * gateway that gave up first would answer 「超时」 for a read that was about to
 * succeed and leave the run retrying into the same wall — review E-8).
 */
const REGISTRY_MARGIN_MS = 3_000;
/** The registry client's default deadline (its own default), when the deployment names none: `OPEN_SCIENCE_VCR_REGISTRY_TIMEOUT_MS`. */
const REGISTRY_DEADLINE_MS = 20_000;
const readFilterFields = Object.freeze(["kind", "limit", "offset", "registryId", "registry", "snapshotId", "sourceId", "subjectKey", "documentId", "query"]);
const WRITE_MAX_ITEMS = 200;

/**
 * Keys no runtime write may carry, at any depth (integration contract §3.2):
 * the engine's outputs and the fields a page fills from them. A key spelled
 * like a result is refused wherever it is nested, because a number smuggled one
 * level down is still a number nobody computed.
 */
export const VCR_FORBIDDEN_WRITE_KEYS = Object.freeze([
  "counts", "measures", "results", "resultId", "execution", "executionId", "cpuSeconds", "outputHash", "manifest", "mcse",
  "waterfall", "cells", "prediction", "effectiveSampleSize", "realPatients", "generatedRecords", "notEstimableRule", "gapList",
]);

/** Codes this gateway answers with. */
export const VCR_GATEWAY_ERROR_CODES = Object.freeze([
  "vcr_disabled", "vcr_no_study", "vcr_gateway_token_missing", "vcr_gateway_token_invalid", "vcr_gateway_rate_limited",
  "vcr_gateway_timeout", "vcr_gateway_unavailable", "vcr_request_invalid", "vcr_request_too_large",
  "vcr_read_what_invalid", "vcr_read_filter_invalid", "vcr_write_what_invalid", "vcr_write_payload_invalid",
  "vcr_curve_provenance_unavailable", "vcr_curve_provenance_invalid", "vcr_curve_source_changed",
  "vcr_simulate_action_invalid", "vcr_simulate_payload_invalid", "vcr_job_not_found", "registry_unavailable",
]);

class VcrGatewayError extends Error {
  /** @param {number} status @param {string} code @param {string} message */
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
    /** @type {Array<{kind:string,label:string}> | undefined} */
    this.alternatives = undefined;
  }
}

/** @param {number} status @param {string} code @param {string} message */
const gatewayError = (status, code, message) => new VcrGatewayError(status, code, message);

/** @param {any} res @param {number} status @param {unknown} payload */
function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": String(body.length), "cache-control": "no-store" });
  res.end(body);
}

/** Past this, a body is not drained but cut off. */
const drainLimit = 4 * 1024 * 1024;

/**
 * A request body as one JSON object. A body over the limit is drained before
 * the 413 goes out: answering mid-upload resets the connection, and a run
 * reads a reset as an unreachable gateway — a retry — instead of a write it
 * has to make smaller.
 * @param {any} req @param {number} maxBytes
 */
async function readJsonBody(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > drainLimit) throw gatewayError(413, "vcr_request_too_large", "The 虚拟临研 request was too large.");
    if (total <= maxBytes) chunks.push(chunk);
  }
  if (total > maxBytes) throw gatewayError(413, "vcr_request_too_large", "The 虚拟临研 request was too large.");
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (value == null || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return /** @type {Record<string, any>} */ (value);
  } catch {
    throw gatewayError(400, "vcr_request_invalid", "The 虚拟临研 request was not a JSON object.");
  }
}

/** @param {Record<string, any>} body @param {readonly string[]} allowed */
function onlyFields(body, allowed) {
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    throw gatewayError(400, "vcr_request_invalid", `The 虚拟临研 request takes only: ${allowed.join(", ")}.`);
  }
}

/** @param {unknown} value */
const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {});
/** @param {unknown} value */
const list = (value) => (Array.isArray(value) ? value : []);
const ID = /^[A-Za-z0-9_.:@-]{1,160}$/;

/** @param {Record<string, any>} body */
function readRequest(body) {
  onlyFields(body, ["what", "filter"]);
  if (typeof body.what !== "string" || !VCR_READ_WHATS.includes(body.what)) {
    throw gatewayError(400, "vcr_read_what_invalid", `what must be one of: ${VCR_READ_WHATS.join(", ")}.`);
  }
  const raw = object(body.filter);
  if (body.filter != null && (typeof body.filter !== "object" || Array.isArray(body.filter)
    || Object.keys(raw).some((key) => !readFilterFields.includes(key)))) {
    throw gatewayError(400, "vcr_read_filter_invalid", `filter takes only: ${readFilterFields.join(", ")}.`);
  }
  /** @type {Record<string, any>} */
  const filter = {};
  for (const key of ["kind", "registryId", "registry", "snapshotId", "sourceId", "subjectKey", "documentId"]) {
    if (raw[key] == null) continue;
    if (!ID.test(String(raw[key]))) throw gatewayError(400, "vcr_read_filter_invalid", `filter.${key} is not an id.`);
    filter[key] = String(raw[key]);
  }
  if (raw.query != null) {
    const query = String(raw.query).replace(/\s+/g, " ").trim();
    if (!query || query.length > 200) throw gatewayError(400, "vcr_read_filter_invalid", "filter.query is text of 1 to 200 characters.");
    filter.query = query;
  }
  if (raw.limit != null) {
    if (!Number.isSafeInteger(raw.limit) || raw.limit < 1 || raw.limit > VCR_READ_MAX_ITEMS) {
      throw gatewayError(400, "vcr_read_filter_invalid", `filter.limit must be a whole number from 1 to ${VCR_READ_MAX_ITEMS}.`);
    }
    filter.limit = raw.limit;
  }
  if (raw.offset != null) {
    if (!Number.isSafeInteger(raw.offset) || raw.offset < 0 || raw.offset > 10_000) {
      throw gatewayError(400, "vcr_read_filter_invalid", "filter.offset must be a whole number from 0 to 10000.");
    }
    filter.offset = raw.offset;
  }
  return { what: body.what, filter };
}

/** @param {Record<string, any>} body */
function writeRequest(body) {
  onlyFields(body, ["what", "items", "data"]);
  if (typeof body.what !== "string" || !VCR_WRITE_WHATS.includes(body.what)) {
    throw gatewayError(400, "vcr_write_what_invalid", `what must be one of: ${VCR_WRITE_WHATS.join(", ")}.`);
  }
  if (body.items != null && body.data != null) throw gatewayError(400, "vcr_write_payload_invalid", "A write carries items or data, not both.");
  if (body.items != null && (!Array.isArray(body.items) || !body.items.length || body.items.length > WRITE_MAX_ITEMS)) {
    throw gatewayError(400, "vcr_write_payload_invalid", `items is a list of 1 to ${WRITE_MAX_ITEMS} objects.`);
  }
  if (body.data != null && (typeof body.data !== "object" || Array.isArray(body.data))) {
    throw gatewayError(400, "vcr_write_payload_invalid", "data is an object.");
  }
  return { what: body.what, items: body.items ?? null, data: body.data ?? null };
}

/** The scenario keys a pooling request may carry: what is pooled, never the engine's own fields. */
const POOL_REQUEST_FIELDS = Object.freeze(["parameter", "endpointKey", "calibres", "armRole", "target", "method"]);
/** The keys an accrual request may carry: the target and horizon are the study's to state; the sites' rates come from the ledger. */
const ACCRUAL_REQUEST_FIELDS = Object.freeze(["target", "eventTarget", "eventHazard", "byTimes"]);

/** @param {Record<string, any>} body */
function simulateRequest(body) {
  onlyFields(body, ["action", "kind", "scenario", "inputs", "seed", "replicates", "cpuSecondsLimit", "jobId", "subjectId", "reconstructionResultId"]);
  const action = body.action ?? "start";
  if (!["start", "status", "cancel"].includes(action)) {
    throw gatewayError(400, "vcr_simulate_action_invalid", "action must be start, status or cancel.");
  }
  if (action === "start") {
    if (typeof body.kind !== "string" || !VCR_JOB_KINDS.includes(body.kind)) {
      throw gatewayError(400, "vcr_simulate_payload_invalid", `kind must be one of: ${VCR_JOB_KINDS.join(", ")}.`);
    }
    if (body.scenario != null && (typeof body.scenario !== "object" || Array.isArray(body.scenario))) {
      throw gatewayError(400, "vcr_simulate_payload_invalid", "scenario is an object.");
    }
    if (body.inputs != null && !Array.isArray(body.inputs)) {
      throw gatewayError(400, "vcr_simulate_payload_invalid", "inputs is an array.");
    }
    // A time-to-event MAIC's comparator is a reconstruction RESULT of this study, named by its id; the rows are the platform's.
    if (body.reconstructionResultId != null) {
      if (body.kind !== VCR_RECONSTRUCTION_REFERENCE.kind) {
        throw gatewayError(400, "vcr_simulate_payload_invalid", `reconstructionResultId 只用于 ${VCR_RECONSTRUCTION_REFERENCE.kind}：它指向一次生存曲线重建的结果。`);
      }
      if (typeof body.reconstructionResultId !== "string" || !ID.test(body.reconstructionResultId)) {
        throw gatewayError(400, "vcr_simulate_payload_invalid", "reconstructionResultId 是本研究一次曲线重建结果的 id。");
      }
    }
    return { action, kind: body.kind, scenario: object(body.scenario), inputs: list(body.inputs),
      reconstructionResultId: body.reconstructionResultId == null ? null : body.reconstructionResultId,
      seed: Number.isInteger(body.seed) ? body.seed : null,
      replicates: Number.isInteger(body.replicates) ? body.replicates : null,
      cpuSecondsLimit: Number.isInteger(body.cpuSecondsLimit) ? body.cpuSecondsLimit : null,
      subjectId: body.subjectId == null ? null : String(body.subjectId).slice(0, 120) };
  }
  if (typeof body.jobId !== "string" || !ID.test(body.jobId)) {
    throw gatewayError(400, "vcr_simulate_payload_invalid", "jobId is the id start answered with.");
  }
  return { action, jobId: body.jobId };
}

/** One refused item, as the run reads it. @param {number | null} index @param {string} field @param {string} code @param {string} message */
const issue = (index, field, code, message) => ({ ...(index == null ? {} : { index }), field, code, message });

// ---------------------------------------------------------------------------
// The write half
// ---------------------------------------------------------------------------

/**
 * A comparison goal's `measures`: the names of the measures it compares and
 * which way is better, `[{ name: "power", direction: "higher" }]` — words, no
 * number. That is a list of names, not a result, so the rule against writing a
 * `measures` (an engine output) does not apply to it; a `measures` at that
 * path that carries anything else (a value, an interval, a standard error) is
 * still one. Scoped by path and by shape, never by the key's spelling alone.
 * @param {string} where the path of the object that holds the key @param {unknown} measures
 */
function isGoalMeasureNames(where, measures) {
  if (where !== "comparisonGoal" && !where.endsWith(".comparisonGoal")) return false;
  if (!Array.isArray(measures) || measures.length > 20) return false;
  return measures.every((entry) => typeof entry === "string" || (entry !== null && typeof entry === "object" && !Array.isArray(entry)
    && Object.keys(entry).every((key) => key === "name" || key === "direction")
    && typeof entry.name === "string" && (entry.direction === undefined || typeof entry.direction === "string")));
}

/**
 * The first key, at any depth, that a runtime write may not carry. Bounded and
 * cycle-safe: the input is parsed JSON, so neither is expected, and a bound is
 * still what makes the check a check.
 * @param {unknown} value @param {string} [path]
 * @returns {string | null} the path of the key
 */
export function forbiddenWriteKey(value, path = "") {
  const seen = new Set();
  /** @param {any} node @param {string} where @param {number} depth @returns {string | null} */
  const walk = (node, where, depth) => {
    if (node === null || typeof node !== "object" || seen.has(node)) return null;
    if (depth > 40) return where || "(too deep)";
    seen.add(node);
    if (Array.isArray(node)) {
      for (const [at, item] of node.entries()) { const found = walk(item, `${where}[${at}]`, depth + 1); if (found) return found; }
      return null;
    }
    for (const key of Object.keys(node)) {
      const here = where ? `${where}.${key}` : key;
      if (key === "measures" && isGoalMeasureNames(where, node[key])) continue;
      if (VCR_FORBIDDEN_WRITE_KEYS.includes(key)) return here;
      const found = walk(node[key], here, depth + 1);
      if (found) return found;
    }
    return null;
  };
  return walk(value, path, 0);
}

/** A database's own error: five characters of SQLSTATE. @param {unknown} error */
const isDatabaseError = (error) => typeof /** @type {any} */ (error)?.code === "string" && /^[0-9A-Z]{5}$/.test(/** @type {any} */ (error).code);

/** The tables a reference may point at, each checked against the study. */
const OWNED_TABLES = Object.freeze({
  snapshot: "snapshots", population: "populations", comparator: "comparator_designs", result: "results",
});

/** A protocol variable, a subject's pseudonym and the like: one token of plain characters. */
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/;
/** An ISO date or instant. */
const ISO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/;

/**
 * The refusal and validation kit of one item. Every check that fails records
 * the issue and marks the item refused; the item is written only when none did.
 */
class Item {
  /**
   * @param {{ row: Record<string, any>, index: number, issues: any[], study: any, store: any }} input
   */
  constructor({ row, index, issues, study, store }) {
    this.row = row;
    this.index = index;
    this.issues = issues;
    this.study = study;
    this.store = store;
    this.ok = true;
    /** Where this item sits inside its row, when it is a part of one (`criteria[2].`). */
    this.prefix = "";
  }

  /** @param {string} field @param {string} message @param {string} [code] */
  bad(field, message, code = "vcr_write_value_invalid") {
    this.issues.push(issue(this.index, `${this.prefix}${field}`, code, message));
    this.ok = false;
  }

  /**
   * The item's fields must all be in the closed list, and no key of it, at any
   * depth, may be an engine output. `ids` are top-level fields that are spelled
   * like an engine output but are a reference to one — the id of a result of this
   * study (`forecast.resultId`): they are exempt from the scan at the top level
   * only, and only as a plain string; the writer checks the id belongs to the study.
   * @param {readonly string[]} allowed @param {{ ids?: readonly string[] }} [options]
   */
  only(allowed, { ids = [] } = {}) {
    for (const key of Object.keys(this.row)) {
      if (!allowed.includes(key)) {
        this.bad(key, `${key} 不是这类写入的字段（可写：${allowed.join("、")}）。`, "vcr_write_field_forbidden");
        return false;
      }
    }
    const scanned = Object.fromEntries(Object.entries(this.row).filter(([key, value]) => !(ids.includes(key) && typeof value === "string")));
    const smuggled = forbiddenWriteKey(scanned);
    if (smuggled) {
      this.bad(smuggled, `${smuggled} 不可由模型写入：结果数字与计数只来自引擎作业。`, "vcr_write_field_forbidden");
      return false;
    }
    const expressions = findExpressionFields(this.row, { limit: 1 });
    if (expressions.length) {
      this.bad(expressions[0] || "expression", "不接受表达式：条件和规则用规定的结构写。", "vcr_write_field_forbidden");
      return false;
    }
    return true;
  }

  /** @param {string} field @param {{ max?: number, required?: boolean }} [options] @returns {string | undefined} */
  str(field, { max = 200, required = false } = {}) {
    const value = this.row[field];
    if (value == null || value === "") {
      if (required) this.bad(field, `${field} 必填。`);
      return undefined;
    }
    if (typeof value !== "string" || [...value].length > max) {
      this.bad(field, `${field} 是不超过 ${max} 个字符的文字。`);
      return undefined;
    }
    return value.trim();
  }

  /** @param {string} field @param {readonly string[]} vocabulary @param {{ required?: boolean, fallback?: string }} [options] @returns {string | undefined} */
  choice(field, vocabulary, { required = false, fallback = undefined } = {}) {
    const value = this.row[field];
    if (value == null) {
      if (required) this.bad(field, `${field} 必填，取值：${vocabulary.join("、")}。`);
      return fallback;
    }
    if (typeof value !== "string" || !vocabulary.includes(value)) {
      this.bad(field, `${field} 必须是：${vocabulary.join("、")}。`);
      return undefined;
    }
    return value;
  }

  /** @param {string} field @param {{ required?: boolean, bytes?: number }} [options] @returns {Record<string, any> | undefined} */
  obj(field, { required = false, bytes = 48 * 1024 } = {}) {
    const value = this.row[field];
    if (value == null) {
      if (required) this.bad(field, `${field} 必填。`);
      return undefined;
    }
    if (typeof value !== "object" || Array.isArray(value)) {
      this.bad(field, `${field} 是一个对象。`);
      return undefined;
    }
    if (JSON.stringify(value).length > bytes) {
      this.bad(field, `${field} 过大（上限 ${Math.round(bytes / 1024)} KB）。`);
      return undefined;
    }
    return /** @type {Record<string, any>} */ (value);
  }

  /** @param {string} field @param {{ max?: number, required?: boolean }} [options] @returns {any[] | undefined} */
  arr(field, { max = 100, required = false } = {}) {
    const value = this.row[field];
    if (value == null) {
      if (required) this.bad(field, `${field} 必填。`);
      return undefined;
    }
    if (!Array.isArray(value) || value.length > max) {
      this.bad(field, `${field} 是最多 ${max} 项的列表。`);
      return undefined;
    }
    return value;
  }

  /** @param {string} field @param {{ min?: number, max?: number, integer?: boolean, required?: boolean }} [options] @returns {number | null | undefined} */
  num(field, { min = -1e12, max = 1e12, integer = false, required = false } = {}) {
    const value = this.row[field];
    if (value == null) {
      if (required) this.bad(field, `${field} 必填。`);
      return value === null ? null : undefined;
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
      this.bad(field, `${field} 是${integer ? "整数" : "数"}，范围 ${min} 到 ${max}。`);
      return undefined;
    }
    return value;
  }

  /** @param {string} field @param {{ required?: boolean }} [options] @returns {string | undefined} */
  iso(field, { required = false } = {}) {
    const value = this.row[field];
    if (value == null || value === "") {
      if (required) this.bad(field, `${field} 必填（ISO 日期或时间）。`);
      return undefined;
    }
    if (typeof value !== "string" || !ISO.test(value) || !Number.isFinite(Date.parse(value))) {
      this.bad(field, `${field} 是 ISO 日期或时间（例如 2026-09-28 或 2026-09-28T08:00:00Z）。`);
      return undefined;
    }
    return value;
  }

  /** @param {string} field @param {RegExp} pattern @param {string} what @param {{ required?: boolean }} [options] @returns {string | undefined} */
  token(field, pattern, what, { required = false } = {}) {
    const value = this.row[field];
    if (value == null || value === "") {
      if (required) this.bad(field, `${field} 必填：${what}。`);
      return undefined;
    }
    if (typeof value !== "string" || !pattern.test(value)) {
      this.bad(field, `${field} 应是${what}。`);
      return undefined;
    }
    return value;
  }

  /**
   * An id that has to be this study's. Another study's id, and one that does not
   * exist, read the same: not found.
   * @param {string} field @param {keyof typeof OWNED_TABLES} kind @param {unknown} id
   */
  async owned(field, kind, id) {
    if (id == null || id === "") return true;
    const table = OWNED_TABLES[kind];
    const found = typeof id === "string" && ID.test(id)
      ? await this.store.one(`SELECT 1 FROM evimed_vcr.${table} WHERE id = $1 AND study_id = $2`, [id, this.study.id]) : null;
    if (!found) this.bad(field, `${field} 里的 ${String(id).slice(0, 60)} 不是本研究的对象。`);
    return Boolean(found);
  }
}

/** The numbers a distribution's parameters are: finite, bounded. @param {Item} item @param {string} field @param {unknown} value */
function distributionOf(item, field, value) {
  if (value == null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) { item.bad(field, `${field} 是一个对象。`); return undefined; }
  const raw = /** @type {Record<string, any>} */ (value);
  const family = raw.family ?? raw.kind;
  if (family !== undefined && !VCR_DISTRIBUTIONS.includes(String(family))) {
    item.bad(`${field}.family`, `分布必须是：${VCR_DISTRIBUTIONS.join("、")}。`);
    return undefined;
  }
  const params = object(raw.params);
  for (const [key, number] of Object.entries(params)) {
    if (!Number.isFinite(number) && !(Array.isArray(number) && number.every((entry) => Number.isFinite(entry)))) {
      item.bad(`${field}.params.${key}`, "分布参数是有限的数。");
      return undefined;
    }
  }
  const range = raw.range == null ? null : object(raw.range);
  if (range && !(Number.isFinite(range.low) && Number.isFinite(range.high) && range.low <= range.high)) {
    item.bad(`${field}.range`, "范围写成 { low, high }，low 不大于 high。");
    return undefined;
  }
  const { kind: _kind, ...rest } = raw;
  return { ...rest, ...(family === undefined ? {} : { family: String(family) }), params, ...(range ? { range } : {}) };
}

/**
 * Everything a write of one kind needs, passed once. `caller` is what the
 * gateway knows of who is calling beyond the study: the dispatch the calling
 * runtime is reserved for, when it is a bounded one (`runtimeRunId`).
 * @typedef {{ store: any, service: any, orchestrator: any, study: any, evidence?: any, evidenceStore?: any, matchStore?: any,
 *   matching?: any, seal?: any, dataPlane?: any, documents?: any, report?: (code: string) => void,
 *   caller?: { runtimeRunId?: string | null } | null }} WriteDeps
 */

/** The criterion fields a protocol write takes. */
const CRITERION_FIELDS = Object.freeze(["kind", "criterionType", "requirement", "applicability", "sourceText", "sourceLocator", "evidenceNeeded"]);

/**
 * The criteria of a protocol or criteria write, checked one by one: the
 * requirement and the applicability each against the domain's grammar, the
 * closed words by name. A criterion that fails is refused alone (`vcr_criterion_malformed` for a
 * requirement outside the grammar) and the rest are kept — and are written as
 * ONE protocol version, never one version per row.
 *
 * @param {WriteDeps} deps @param {any[]} rows @param {any[]} issues @param {string} what
 * @returns {Promise<{ criteria: any[], versionRow: Record<string, any> }>}
 */
async function checkedCriteria(deps, rows, issues, what) {
  /** @type {any[]} */
  const criteria = [];
  /** @type {Record<string, any>} */
  let versionRow = {};
  for (const [index, raw] of rows.entries()) {
    const row = object(raw);
    const candidates = what === "criteria" && Array.isArray(row.criteria) ? row.criteria : what === "protocol" ? (Array.isArray(row.criteria) ? row.criteria : []) : [row];
    if (what === "protocol" || Array.isArray(row.criteria)) {
      const rest = Object.fromEntries(Object.entries(row).filter(([key]) => key !== "criteria"));
      versionRow = { ...versionRow, ...rest };
    }
    for (const [at, candidate] of candidates.entries()) {
      const where = candidates === rows ? "" : `criteria[${at}].`;
      const own = (/** @type {string} */ field) => `${where}${field}`;
      const item = new Item({ row: object(candidate), index, issues, study: deps.study, store: deps.store });
      item.prefix = where;
      if (!item.only(CRITERION_FIELDS)) continue;
      const kind = item.choice("kind", ["inclusion", "exclusion"], { required: true });
      const criterionType = item.choice("criterionType", VCR_CRITERION_TYPES, { fallback: "other" });
      const sourceText = item.str("sourceText", { max: 4000 }) ?? "";
      const sourceLocator = item.obj("sourceLocator", { bytes: 4096 }) ?? {};
      const evidenceNeeded = item.arr("evidenceNeeded", { max: 30 }) ?? [];
      const requirement = item.obj("requirement", { required: true, bytes: 32 * 1024 });
      const applicability = item.obj("applicability", { bytes: 8 * 1024 });
      /** @type {Array<[string, Record<string, any> | undefined]>} */
      const nodes = [["requirement", requirement], ["applicability", applicability]];
      for (const [field, node] of nodes) {
        if (!node) continue;
        const problems = validateRequirement(node, { path: field });
        if (problems.length) {
          issues.push(issue(index, own(field), "vcr_criterion_malformed",
            `${own(field)} 不符合入排条件的规定结构：${problems.slice(0, 3).map((problem) => `${problem.field || field}（${problem.detail}）`).join("；")}。`));
          item.ok = false;
        }
      }
      if (!item.ok) continue;
      criteria.push({
        kind, criterionType, sourceText, sourceLocator, evidenceNeeded, reviewState: "ai_set",
        // Applicability is its own column, beside the requirement: the evaluator
        // reads it from there, and the grammar would refuse it inside the
        // requirement. A criterion that does not apply is not an unknown.
        requirement, applicability: applicability ?? null,
      });
    }
  }
  return { criteria, versionRow };
}

/**
 * The writers, one per kind. Each takes the item's kit and the deps, validates
 * every field it uses first, and returns the id it wrote — or nothing, having
 * recorded why.
 * @type {Record<string, (item: Item, deps: WriteDeps, extra: { changed: string[], results: any[] }) => Promise<string | null | undefined>>}
 */
const WRITERS = {
  async definition(item, { store, study }) {
    if (!item.only(["pico", "estimand", "endpointType", "intendedUse", "fieldSources"])) return null;
    const pico = item.obj("pico") ?? {};
    const estimand = item.obj("estimand") ?? {};
    const endpointType = item.choice("endpointType", VCR_ENDPOINT_TYPES);
    const intendedUse = item.choice("intendedUse", VCR_INTENDED_USES, { fallback: "exploratory" });
    const fieldSources = item.obj("fieldSources") ?? {};
    if (!item.ok) return null;
    const saved = await store.saveDefinition({
      studyId: study.id, userId: study.userId, pico, estimand, endpointType: endpointType ?? null, intendedUse, fieldSources, reviewState: "ai_set",
    });
    return saved.id;
  },

  async assumption(item, deps, extra) {
    const { store, study, evidence, evidenceStore } = deps;
    if (!item.only(["key", "name", "endpoint", "unit", "pointValue", "distribution", "sensitivity", "sourceKind", "valueSource",
      "evidenceIds", "applicability", "note", "parameter", "fromPooling", "expertFrom"])) return null;
    const key = item.str("key", { max: 64, required: true });
    if (key && !VCR_ASSUMPTION_KEY.test(key)) {
      item.bad("key", "key 是小写英文字母开头、只含小写字母、数字和下划线的参数名（最多 64 个字符），例如 control_median_pfs。");
    }
    const name = item.str("name", { max: 120 }) ?? key;
    const endpoint = item.str("endpoint", { max: 160 }) ?? null;
    const unit = item.str("unit", { max: 40 }) ?? null;
    const note = item.str("note", { max: 1000 }) ?? "";
    const applicability = item.obj("applicability", { bytes: 8 * 1024 }) ?? {};
    const parameter = item.str("parameter", { max: 120 });
    const sourceKind = item.choice("sourceKind", ["expert_set", "scenario", "external_evidence"], { fallback: "expert_set" });
    const derived = item.row.fromPooling != null || item.row.expertFrom != null || sourceKind === "external_evidence";
    if (!item.ok) return null;

    // 1. An assumption made from the engine's pooling of this study's verified values.
    if (item.row.fromPooling != null) {
      const from = object(item.row.fromPooling);
      const typed = ["pointValue", "distribution", "sensitivity", "evidenceIds", "valueSource"].filter((field) => item.row[field] != null);
      if (typed.length) return void item.bad(typed[0], `${typed.join("、")} 由合并结果生成，不可手填。`, "vcr_write_field_forbidden");
      if (item.row.expertFrom != null) return void item.bad("expertFrom", "fromPooling 和 expertFrom 二选一。");
      if (!evidence?.saveAssumptionFromPooling) return void item.bad("fromPooling", "证据参数化未接入本部署。", "vcr_write_refused");
      const poolParameter = String(from.parameter ?? parameter ?? "");
      if (!poolParameter) return void item.bad("fromPooling.parameter", "fromPooling.parameter 必填：被合并的参数名。");
      const jobIds = object(from.jobIds);
      const wantedCalibres = Object.keys(jobIds);
      if (!wantedCalibres.length || wantedCalibres.some((calibre) => !["closest", "overall", "next_closest"].includes(calibre))) {
        return void item.bad("fromPooling.jobIds", "fromPooling.jobIds 写成 { closest, overall, next_closest } 里的一项或几项，值是合并作业的 id。");
      }
      /** @type {Record<string, any>} */
      const results = {};
      /** @type {Record<string, string[]>} */
      const evidenceIdsByCalibre = {};
      for (const calibre of wantedCalibres) {
        const loaded = await loadPoolJob(store, study, String(jobIds[calibre]), poolParameter);
        if (loaded.error) return void item.bad(`fromPooling.jobIds.${calibre}`, loaded.error);
        results[calibre] = loaded.result;
        evidenceIdsByCalibre[calibre] = loaded.evidenceIds;
      }
      const saved = await evidence.saveAssumptionFromPooling({
        userId: study.userId, studyId: study.id, key, name, parameter: poolParameter, endpoint: endpoint ?? "", unit: unit ?? "",
        results, evidenceIdsByCalibre, applicability, note,
      });
      if (!saved.assumption) {
        return void item.bad("fromPooling", saved.reason === "no_pool_succeeded"
          ? "这些合并作业没有一个成功，没有可写的卡：先读作业状态。" : `没有写出假设卡（${saved.reason}）。`);
      }
      extra.changed.push(`assumption:${saved.assumption.key}@${saved.assumption.version}`);
      extra.results.push({ index: item.index, status: saved.status, calibre: saved.card?.pooling?.calibre ?? null,
        ...(saved.status === "expert_set" ? { note: "合并结果没有预测区间（少于三项研究），已写成加宽后的专家设定·待补证。" } : {}) });
      return saved.assumption.id;
    }

    // 2. An expert setting made from the nearest verified evidence, widened.
    if (item.row.expertFrom != null) {
      const from = object(item.row.expertFrom);
      if (!evidence?.saveExpertSet || !evidenceStore) return void item.bad("expertFrom", "证据参数化未接入本部署。", "vcr_write_refused");
      const typed = ["pointValue", "distribution", "sensitivity", "evidenceIds", "valueSource", "sourceKind"].filter((field) => item.row[field] != null);
      if (typed.length) return void item.bad(typed[0], `${typed.join("、")} 由证据推出，不可手填。`, "vcr_write_field_forbidden");
      const reason = String(from.reason ?? "").trim();
      if (!reason || reason.length > 300) return void item.bad("expertFrom.reason", "expertFrom.reason 必填：一句话说明为什么只能加宽取用。");
      let nearest = null;
      const evidenceId = from.evidenceId == null ? null : String(from.evidenceId);
      if (evidenceId) {
        const [row] = await evidenceStore.verifiedItemsById({ userId: study.userId, studyId: study.id, ids: [evidenceId] });
        if (!row) return void item.bad("expertFrom.evidenceId", "这条抽取值不是本研究通过核对的证据。", "vcr_evidence_unverified");
        nearest = { pointValue: Number(row.value), range: row.ci_low !== null && row.ci_high !== null ? { low: Number(row.ci_low), high: Number(row.ci_high) } : null,
          source: `evidence:${row.id}` };
      } else if (from.jobId) {
        const loaded = await loadPoolJob(store, study, String(from.jobId), String(from.parameter ?? parameter ?? ""));
        if (loaded.error) return void item.bad("expertFrom.jobId", loaded.error);
        const pool = readPoolResult(loaded.result);
        if (!pool.ok) return void item.bad("expertFrom.jobId", "这个合并作业没有可用的合并值。");
        const scale = String(pool.scale ?? "identity");
        nearest = { pointValue: naturalOf(/** @type {number} */ (pool.pooled), scale),
          range: pool.confidence ? { low: naturalOf(pool.confidence.low, scale), high: naturalOf(pool.confidence.high, scale) } : null,
          source: `job:${from.jobId}` };
      } else {
        return void item.bad("expertFrom", "expertFrom 写 { evidenceId } 或 { jobId }，再加 reason。");
      }
      const saved = await evidence.saveExpertSet({ userId: study.userId, studyId: study.id, key, name, parameter: parameter ?? "", unit: unit ?? "",
        nearest, reason, applicability });
      extra.changed.push(`assumption:${saved.assumption.key}@${saved.assumption.version}`);
      return saved.assumption.id;
    }

    // 3. One verified value, taken as it is (「单项研究直接取值」).
    if (sourceKind === "external_evidence") {
      const ids = item.arr("evidenceIds", { max: 20, required: true });
      if (!ids) return null;
      const typed = ["pointValue", "distribution", "sensitivity", "valueSource"].filter((field) => item.row[field] != null);
      if (typed.length) return void item.bad(typed[0], `${typed.join("、")} 由被引用的证据推出，不可手填；多项证据用 fromPooling。`, "vcr_write_field_forbidden");
      if (!parameter) return void item.bad("parameter", "外部证据的假设卡要写明是哪个参数的证据（parameter）。");
      if (!evidenceStore) return void item.bad("evidenceIds", "证据参数化未接入本部署。", "vcr_write_refused");
      const verified = new Set(await evidenceStore.verifiedEvidenceIds({ userId: study.userId, studyId: study.id, parameter }));
      const cited = ids.map(String);
      const unverified = cited.filter((id) => !verified.has(id));
      if (unverified.length) {
        return void item.bad("evidenceIds", `这些证据不是本研究关于「${parameter}」的、通过原文核对的抽取值：${unverified.slice(0, 5).join("、")}。`, "vcr_evidence_unverified");
      }
      if (cited.length !== 1) return void item.bad("evidenceIds", "直接取值只引用一条证据；多项证据用 fromPooling 交给引擎合并。");
      const [row] = await evidenceStore.verifiedItemsById({ userId: study.userId, studyId: study.id, ids: cited });
      // The arm the parameter is a quantity of, the same rule the pool takes its
      // studies by: a control-arm median is not the treatment arm's, and a card
      // built from the wrong arm's row would carry a true number for the wrong thing.
      const needed = defaultArmRoleOf(parameter);
      if (row.arm_role !== needed) {
        return void item.bad("evidenceIds", `这条抽取值属于「${row.arm_role}」组；「${parameter}」要的是「${needed}」组的值。`);
      }
      const range = row.ci_low !== null && row.ci_high !== null ? { kind: "confidence", low: Number(row.ci_low), high: Number(row.ci_high) } : null;
      const saved = await evidenceStore.saveAssumption({ userId: study.userId, studyId: study.id, card: {
        key, name, endpoint, unit, pointValue: Number(row.value),
        distribution: { family: "point", params: { point: Number(row.value) }, range },
        sensitivity: { range, calibres: [] }, sourceKind: "external_evidence", valueSource: "extracted", poolingMethod: "single_study",
        pooling: { k: 1, note: "单项研究直接取值，没有预测区间" }, evidenceIds: cited, applicability, reviewState: "ai_set", note,
      } });
      extra.changed.push(`assumption:${saved.key}@${saved.version}`);
      return saved.id;
    }

    // 4. An expert setting or a scenario the run states: its number is its own,
    //    labelled as assumed, citing nothing.
    if (derived) return null;
    if (item.row.evidenceIds != null && list(item.row.evidenceIds).length) {
      return void item.bad("evidenceIds", "专家设定和情景假设不引用证据；引用证据的假设卡用 sourceKind external_evidence 或 fromPooling。");
    }
    const valueSource = item.choice("valueSource", ["assumed"], { fallback: "assumed" });
    const pointValue = item.num("pointValue");
    const distribution = distributionOf(item, "distribution", item.row.distribution) ?? {};
    const sensitivity = item.obj("sensitivity", { bytes: 8 * 1024 }) ?? {};
    if (!item.ok) return null;
    const card = { key, name, endpoint, unit, pointValue: pointValue ?? null, distribution, sensitivity, sourceKind, valueSource,
      poolingMethod: null, pooling: {}, evidenceIds: [], applicability, reviewState: "ai_set", note };
    const saved = evidenceStore ? await evidenceStore.saveAssumption({ userId: study.userId, studyId: study.id, card })
      : await store.saveAssumption({ studyId: study.id, userId: study.userId, ...card });
    extra.changed.push(`assumption:${saved.key}@${saved.version}`);
    return saved.id;
  },

  async precedent(item, { evidence, study }, extra) {
    if (!item.only(["registry", "registryId", "endpointKeys", "armRoles", "line", "biomarker"])) return null;
    const registry = item.choice("registry", ["clinicaltrials.gov", "chictr"], { fallback: "clinicaltrials.gov" });
    const registryId = item.token("registryId", /^[A-Za-z][A-Za-z0-9-]{2,63}$/, "登记号，例如 NCT02296125", { required: true });
    const endpointKeys = item.obj("endpointKeys", { bytes: 8 * 1024 }) ?? {};
    const armRoles = item.obj("armRoles", { bytes: 8 * 1024 }) ?? {};
    for (const [outcome, key] of Object.entries(endpointKeys)) {
      if (typeof key !== "string" || !TOKEN.test(key)) item.bad(`endpointKeys.${outcome.slice(0, 40)}`, "endpointKey 是一个短标识，例如 pfs-blinded。");
    }
    for (const [arm, role] of Object.entries(armRoles)) {
      if (!EVIDENCE_ARM_ROLES.includes(String(role))) item.bad(`armRoles.${arm.slice(0, 40)}`, `arm 角色必须是：${EVIDENCE_ARM_ROLES.join("、")}。`);
    }
    const line = item.str("line", { max: 40 });
    const biomarker = item.str("biomarker", { max: 80 });
    if (!item.ok) return null;
    if (!evidence?.extractPrecedent) return void item.bad("registryId", "试验登记检索未接入本部署。", "registry_unavailable");
    const extracted = await evidence.extractPrecedent({
      userId: study.userId, studyId: study.id, registry, registryId, endpointKeys, armRoles,
      applicability: { ...(line ? { line } : {}), ...(biomarker ? { biomarker } : {}) },
    });
    if (extracted.status !== "ok") {
      return void item.bad("registryId", extracted.status === "registry_not_found" ? "登记平台没有这个登记号的记录。"
        : `没能取回这条登记记录（${extracted.reason ?? extracted.status}）。`,
      extracted.status === "registry_not_found" ? "registry_not_found" : "registry_unavailable");
    }
    extra.results.push({ index: item.index, registryId, extracted: extracted.counts.extracted, verified: extracted.counts.verified, refused: extracted.counts.refused });
    return extracted.precedent?.id ?? null;
  },

  async evidence_item(item, { evidence, study }, extra) {
    if (!item.only(["registry", "registryId", "parameter", "arm", "armRole", "value", "valueText", "unit", "ciLow", "ciHigh", "sampleSize",
      "events", "valueSource", "quote", "locator", "endpointKey", "enrollmentKind", "historicalBaseline", "line", "biomarker", "outcome", "note"])) return null;
    const registry = item.choice("registry", ["clinicaltrials.gov", "chictr"], { fallback: "clinicaltrials.gov" });
    const registryId = item.token("registryId", /^[A-Za-z][A-Za-z0-9-]{2,63}$/, "这条数所在的登记记录的登记号", { required: true });
    const parameter = item.str("parameter", { max: 120, required: true });
    const arm = item.str("arm", { max: 200 });
    const armRole = item.choice("armRole", EVIDENCE_ARM_ROLES, { required: true });
    const value = item.num("value");
    const valueText = item.str("valueText", { max: 200 });
    if (value == null && !valueText) item.bad("value", "value（数）和 valueText（文字）至少写一个。");
    const unit = item.str("unit", { max: 40 });
    const ciLow = item.num("ciLow");
    const ciHigh = item.num("ciHigh");
    const sampleSize = item.num("sampleSize", { min: 0, integer: true });
    const events = item.num("events", { min: 0, integer: true });
    if (ciLow != null && ciHigh != null && ciLow >= ciHigh) item.bad("ciLow", "ciLow 要小于 ciHigh。");
    const valueSource = item.choice("valueSource", ["extracted", "calculated"], { fallback: "extracted" });
    const quote = item.str("quote", { max: 3000, required: true });
    const locator = item.obj("locator", { bytes: 4096 });
    const endpointKey = item.token("endpointKey", TOKEN, "终点口径的短标识，例如 pfs-blinded");
    const enrollmentKind = item.choice("enrollmentKind", ["estimated", "actual"]);
    if (item.row.historicalBaseline != null && typeof item.row.historicalBaseline !== "boolean") item.bad("historicalBaseline", "historicalBaseline 是 true 或 false。");
    const line = item.str("line", { max: 40 });
    const biomarker = item.str("biomarker", { max: 80 });
    if (!item.ok) return null;
    if (!evidence?.addEvidenceItem) return void item.bad("registryId", "证据参数化未接入本部署。", "vcr_write_refused");
    const written = await evidence.addEvidenceItem({ userId: study.userId, studyId: study.id, item: {
      registry, registryId, parameter, arm, armRole, value, valueText, unit, ciLow, ciHigh, sampleSize, events, valueSource, quote, locator,
      endpointKey, enrollmentKind, historicalBaseline: item.row.historicalBaseline === true, line, biomarker, outcome: item.row.outcome, note: item.row.note,
    } });
    if (written.status !== "ok") return void item.bad(written.code === "vcr_precedent_not_in_study" ? "registryId" : "quote", written.message ?? "没有写入。",
      written.code === "vcr_precedent_not_in_study" ? "vcr_write_value_invalid" : "vcr_evidence_unverified");
    const verified = written.state === "verified";
    extra.results.push({ index: item.index, id: written.id, verified, state: written.state });
    if (!verified) {
      item.issues.push(issue(item.index, "quote", "vcr_evidence_unverified",
        `已记录，但没有通过原文核对（${written.state}），不会进入假设卡：引文要逐字出现在登记记录里，值、区间和样本量都要出现在引文里。`));
    }
    return written.id;
  },

  async population(item, { store, study }) {
    if (!item.only(["kind", "name", "definition", "snapshotId", "allowedUses"])) return null;
    const kind = item.choice("kind", VCR_POPULATION_KINDS, { required: true });
    const name = item.str("name", { max: 120 }) ?? "";
    const definition = item.obj("definition") ?? {};
    const allowedUses = item.arr("allowedUses", { max: 10 }) ?? [];
    for (const use of allowedUses) {
      if (!VCR_SYNTHETIC_USES.includes(String(use))) item.bad("allowedUses", `allowedUses 只能是：${VCR_SYNTHETIC_USES.join("、")}。`);
    }
    const snapshotId = item.row.snapshotId == null ? null : String(item.row.snapshotId);
    if (snapshotId) await item.owned("snapshotId", "snapshot", snapshotId);
    if (!item.ok) return null;
    const saved = await store.savePopulation({
      studyId: study.id, userId: study.userId, name, kind, definition, snapshotId, allowedUses: allowedUses.map(String),
      reviewState: "ai_set", profile: {}, quality: {}, waterfall: [],
    });
    return saved.id;
  },

  async patient_set(item, { store, study }) {
    if (!item.only(["populationId", "name", "modelId", "modelVersion", "scenario"])) return null;
    const name = item.str("name", { max: 120 }) ?? "";
    const modelId = item.str("modelId", { max: 160 });
    const modelVersion = item.str("modelVersion", { max: 40 });
    const scenario = item.obj("scenario") ?? {};
    const populationId = item.row.populationId == null ? null : String(item.row.populationId);
    if (populationId) await item.owned("populationId", "population", populationId);
    let selected = null;
    if (modelVersion && !modelId) item.bad('modelId', '指定模型版本时必须同时指定模型。');
    if (modelId) {
      const models = await store.models(study.userId);
      const exactId = models.filter(model => model.id === modelId);
      const candidates = (exactId.length ? exactId : models.filter(model => model.name === modelId))
        .filter(model => !modelVersion || String(model.version) === modelVersion);
      if (candidates.length !== 1) item.bad('modelVersion', '无法唯一确定这个模型版本；请先用 mcp__evimed__vcr_read 读取 models 并选择其中的模型与版本。');
      else selected = candidates[0];
    }
    if (!item.ok) return null;
    const saved = await store.savePatientSet({
      studyId: study.id, userId: study.userId, populationId, name, modelId: selected?.id ?? null, modelVersion: selected?.version ?? null, scenario, twinLabel: null,
    });
    return saved.id;
  },

  async comparator(item, { store, study }) {
    if (!item.only(["route", "estimand", "targetTrial", "configuration"])) return null;
    const route = item.choice("route", vcrRouteOptions(study.dataTier).map((option) => option.route), { required: true });
    const estimand = item.choice("estimand", VCR_ESTIMANDS, { fallback: "ATT" });
    const targetTrial = item.obj("targetTrial") ?? {};
    const configuration = item.obj("configuration") ?? {};
    if (configuration.snapshotId != null) await item.owned("configuration.snapshotId", "snapshot", configuration.snapshotId);
    if (!item.ok) return null;
    const saved = await store.saveComparatorDesign({
      studyId: study.id, userId: study.userId, route, estimand, targetTrial, configuration, conclusion: null, gapList: [], reviewState: "ai_set",
    });
    return saved.id;
  },

  async trial_scenario(item, { store, study }) {
    if (!item.only(["label", "design", "endpointType", "configuration", "assumptionIds", "comparatorId"])) return null;
    const label = item.str("label", { max: 120 }) ?? "";
    const design = item.choice("design", VCR_TRIAL_DESIGNS, { required: true });
    const endpointType = item.choice("endpointType", VCR_ENDPOINT_TYPES, { required: true });
    const configuration = item.obj("configuration") ?? {};
    const assumptionIds = (item.arr("assumptionIds", { max: 60 }) ?? []).map(String);
    const comparatorId = item.row.comparatorId == null ? null : String(item.row.comparatorId);
    if (comparatorId) await item.owned("comparatorId", "comparator", comparatorId);
    if (assumptionIds.length) {
      const held = await store.assumptions(study.id);
      for (const id of assumptionIds) {
        if (!held.some((card) => card.key === id || card.id === id)) item.bad("assumptionIds", `本研究没有假设卡「${id.slice(0, 60)}」。`);
      }
    }
    if (!item.ok) return null;
    const saved = await store.saveTrialScenario({
      studyId: study.id, userId: study.userId, label, design, endpointType, configuration, assumptionIds, comparatorId,
    });
    return saved.id;
  },

  async design_grid(item, { store, study }) {
    if (!item.only(["dimensions", "truthScenarios", "comparisonGoal"])) return null;
    const dimensions = item.obj("dimensions") ?? {};
    const truthScenarios = item.arr("truthScenarios", { max: 50 }) ?? [];
    const comparisonGoal = item.obj("comparisonGoal", { bytes: 8 * 1024 });
    if (!item.ok) return null;
    const saved = await store.saveDesignGrid({
      studyId: study.id, userId: study.userId, dimensions, truthScenarios, comparisonGoal: comparisonGoal ?? null, cells: [],
    });
    return saved.id;
  },

  async decision(item, { store, study }) {
    if (!item.only(["question", "chosen", "alternatives", "rationale"])) return null;
    const question = item.str("question", { max: 400, required: true });
    const chosen = item.obj("chosen") ?? {};
    const alternatives = item.arr("alternatives", { max: 20 }) ?? [];
    const rationale = item.str("rationale", { max: 2000 }) ?? "";
    if (!item.ok) return null;
    const saved = await store.addDecision({
      studyId: study.id, userId: study.userId, question, chosen, alternatives, rationale, decidedBy: "ai_set",
    });
    return saved.id;
  },

  /**
   * A prediction registered before the outcome it predicts (AC-23). The run
   * names the result it is about; the prediction is that result's own measures,
   * read by the platform — a run cannot type the number it is later compared to.
   */
  async forecast(item, { store, study }) {
    if (!item.only(["kind", "resultId"], { ids: ["resultId"] })) return null;
    const kind = item.str("kind", { max: 60 }) ?? "accrual";
    const resultId = item.token("resultId", ID, "一个已保存结果的 id", { required: true });
    if (!item.ok) return null;
    const result = await store.result(study.id, String(resultId));
    if (!result) return void item.bad("resultId", "这个结果不属于本研究。");
    const saved = await store.registerForecast({
      studyId: study.id, userId: study.userId, kind,
      prediction: { resultId: result.id, version: result.version, measures: result.measures, counts: result.counts },
      public: false,
    });
    return saved.id;
  },

  async model(item, { service, study }) {
    if (!item.only(["name", "version", "endpointType", "risk", "card", "sources"])) return null;
    const name = item.str("name", { max: 120, required: true });
    const version = item.str("version", { max: 40 }) ?? "1.0.0";
    const endpointType = item.choice("endpointType", VCR_ENDPOINT_TYPES);
    const risk = item.choice("risk", VCR_MODEL_RISKS, { fallback: "low" });
    const card = item.obj("card") ?? {};
    const sources = (item.arr("sources", { max: 30 }) ?? []).map((source) => String(typeof source === "object" ? object(source).label : source).slice(0, 200));
    if (!item.ok) return null;
    const saved = await service.adoptModel({ id: study.userId }, { name, version, endpointType, risk, card, sources, studyId: study.id });
    return saved?.id ?? null;
  },

  async step(item, { store, study }) {
    if (!item.only(["step", "requested", "note"])) return null;
    const step = item.choice("step", VCR_STEPS, { required: true });
    if (item.row.requested != null && typeof item.row.requested !== "boolean") item.bad("requested", "requested 是 true 或 false。");
    const note = item.str("note", { max: 300 });
    if (!item.ok) return null;
    // A run may say what it is doing and ask for a step; it may not declare a
    // step finished — completion is read from the data (§4).
    await store.setStep(study.id, step, {
      ...(item.row.requested === true ? { requested: true } : {}),
      ...(note == null ? {} : { note }),
    });
    return `${study.id}:${step}`;
  },

  /**
   * The analysis plan, frozen: the platform hashes what it holds (the estimand,
   * the endpoint, the population and comparator definitions, the assumption
   * versions) with the analysis the run states, and lifts the outcome seal
   * (plan §6.5). A run cannot type the two timestamps or the hash.
   */
  async plan(item, { store, study, seal }) {
    if (!item.only(["analysis", "sensitivity", "sealedFields"])) return null;
    const analysis = item.obj("analysis", { bytes: 16 * 1024 }) ?? {};
    const sensitivity = item.obj("sensitivity", { bytes: 16 * 1024 }) ?? {};
    const sealedFields = (item.arr("sealedFields", { max: 100 }) ?? []).map(String);
    for (const field of sealedFields) if (!/^[A-Za-z_][A-Za-z0-9_.]{0,63}$/.test(field)) item.bad("sealedFields", `「${field.slice(0, 40)}」不是列名。`);
    if (!item.ok) return null;
    if (!seal?.freezePlan) return void item.bad("analysis", "结局封存未接入本部署。", "vcr_write_refused");
    const [definition, population, comparator, assumptions] = await Promise.all([
      store.latestDefinition(study.id), store.latestPopulation(study.id), store.latestComparatorDesign(study.id), store.assumptions(study.id),
    ]);
    if (!definition) return void item.bad("analysis", "还没有研究定义：先写定义，再冻结分析计划。");
    const frozen = await seal.freezePlan({
      studyId: study.id, actor: "runtime", sealedFields,
      plan: {
        estimand: definition.estimand, endpoint: { type: definition.endpointType, outcome: object(definition.pico).outcome ?? null },
        population: population?.definition ?? null,
        comparator: comparator ? { route: comparator.route, estimand: comparator.estimand, targetTrial: comparator.targetTrial } : null,
        analysis, assumptions: assumptions.map((card) => `${card.key}@${card.version}`), sensitivity, intendedUse: study.intendedUse,
      },
    });
    if (!frozen) return void item.bad("analysis", "没有冻结成功。", "vcr_write_refused");
    return `${study.id}:plan@${frozen.planVersion ?? 0}`;
  },

  /**
   * The run's proposal of a field map for one source: which column is which
   * (subject key, arm, covariate, outcome, time zero …), each entry checked on its
   * own by the plane, the whole against the files. A proposal is not a
   * confirmation — a person confirms the map they read, and only then is a
   * snapshot frozen from it; a proposal with problems is stored with the problems
   * named, because the person confirming is who fixes them.
   */
  async field_map(item, { dataPlane, study }) {
    if (!item.only(["sourceId", "columns", "reason"])) return null;
    const sourceId = item.token("sourceId", ID, "数据源的 id（vcr_read what:snapshot_profile 的 filter.sourceId 先读它）", { required: true });
    const columns = item.arr("columns", { max: 500, required: true });
    const reason = item.str("reason", { max: 500 });
    if (!item.ok) return null;
    if (typeof dataPlane?.proposeFieldMap !== "function") return void item.bad("sourceId", "数据平面未接入本部署：字段映射暂不可用。", "vcr_write_refused");
    const proposed = await dataPlane.proposeFieldMap(study, { sourceId, columns, reason });
    const problems = [...list(proposed?.entryIssues), ...list(proposed?.mapIssues)];
    for (const problem of problems.slice(0, 20)) {
      item.issues.push(issue(item.index, String(object(problem).field ?? object(problem).column ?? "columns"), "vcr_write_value_invalid",
        String(object(problem).message ?? object(problem).detail ?? object(problem).code ?? "字段映射的这一项有问题。")));
    }
    return String(proposed?.source?.id ?? sourceId);
  },

  async fact(item, { matchStore, documents, study }, extra) {
    if (!item.only(["subjectKey", "variable", "value", "unit", "polarity", "occurredAt", "recordedAt", "visibleAt", "surface", "dateSurface",
      "documentId", "start", "end", "quote", "vocabularyVersion"])) return null;
    const subjectKey = item.token("subjectKey", TOKEN, "受试者的假名编号（vcr_read what:subject_document 给出）", { required: true });
    const vocabularyVersion = item.str('vocabularyVersion', { max: 80 }) ?? VCR_MATCHING_VOCABULARY_VERSION;
    if (vocabularyVersion !== VCR_MATCHING_VOCABULARY_VERSION) item.bad('vocabularyVersion', '这个编码词表版本未接入，不能按当前映射解释。');
    const variable = item.token("variable", /^[a-z][a-z0-9_]{0,63}$/, "小写英文变量名，与入排条件里的 variable 一致", { required: true });
    let value = item.row.value;
    if (value != null && !(typeof value === "string" ? value.length <= 200 : Number.isFinite(value))) { item.bad("value", "value 是一个数或不超过 200 字的文字。"); value = undefined; }
    const unit = item.str("unit", { max: 40 });
    const polarity = item.choice("polarity", ["affirmed", "negated", "hypothetical", "family"], { fallback: "affirmed" });
    const occurredAt = item.iso("occurredAt");
    const recordedAt = item.iso("recordedAt");
    const visibleAt = item.iso("visibleAt");
    const surface = item.str("surface", { max: 400, required: true });
    const dateSurface = item.str("dateSurface", { max: 80 });
    const documentId = item.token("documentId", ID, "vcr_read what:subject_document 给出的文档 id", { required: true });
    const start = item.num("start", { min: 0, integer: true });
    const end = item.num("end", { min: 1, integer: true });
    if ((start == null) !== (end == null)) item.bad(start == null ? "start" : "end", "start 和 end 要一起写，或者都不写（由平台在原文里定位只出现一次的引文）。");
    const quote = item.str("quote", { max: 3000, required: true });
    if (!item.ok) return null;
    const verified = await verifySourceSpan({ item, documents, study, subjectKey: String(subjectKey), documentId: String(documentId),
      span: { start: start ?? null, end: end ?? null, quote: String(quote) },
      fact: { surface, dateSurface, value: typeof value === "number" ? value : undefined } });
    if (!verified) return null;
    // The platform's own clock for the document is the floor of the fact's: a
    // fact cannot have been visible before the record it was read from (a
    // replay as of an earlier date would otherwise read the future — AC-15).
    const floor = verified.document.visibleAt ? Date.parse(verified.document.visibleAt) : null;
    const asked = visibleAt ? Date.parse(visibleAt) : null;
    if (floor != null && asked != null && asked < floor) {
      return void item.bad("visibleAt", `visibleAt 不能早于这份文档进入平台的时间（${verified.document.visibleAt}）。`);
    }
    if (!matchStore?.saveFact) return void item.bad("subjectKey", "匹配未接入本部署。", "vcr_write_refused");
    const saved = await matchStore.saveFact({ studyId: study.id, userId: study.userId, fact: {
      subjectKey, variable, value: value ?? null, unit: unit ?? null, polarity, occurredAt: occurredAt ?? null, recordedAt: recordedAt ?? null,
      visibleAt: visibleAt ?? verified.document.visibleAt ?? new Date().toISOString(), surface, dateSurface: dateSurface ?? null,
      source: { documentId, start: verified.span.start, end: verified.span.end, quote: verified.span.quote, vocabularyVersion }, extractedBy: "model",
    } });
    extra.results.push({ index: item.index, id: saved.id, subjectKey });
    return saved.id;
  },

  async language_judgment(item, { matchStore, matching, documents, study }, extra) {
    if (!item.only(["subjectKey", "criterionKey", "state", "evidence"])) return null;
    const subjectKey = item.token("subjectKey", TOKEN, "受试者的假名编号", { required: true });
    const criterionKey = item.token("criterionKey", TOKEN, "入排条件里 language 节点的 key（没写 key 时用条件的 id）", { required: true });
    const state = item.choice("state", ["satisfied", "not_satisfied", "unknown"], { required: true });
    const evidence = item.arr("evidence", { max: 10 }) ?? [];
    if (!item.ok) return null;
    if (!matching?.languageKeys) return void item.bad("criterionKey", "匹配未接入本部署。", "vcr_write_refused");
    const known = await matching.languageKeys(study);
    if (!known.includes(String(criterionKey))) {
      return void item.bad("criterionKey", `最新方案版本里没有 key 为「${String(criterionKey).slice(0, 60)}」的 language 条件${known.length ? `（有：${known.slice(0, 8).join("、")}）` : ""}。`);
    }
    if (state !== "unknown" && !evidence.length) {
      return void item.bad("evidence", "判为满足或不满足必须带原句证据；判断不了就写 unknown。");
    }
    /** @type {any[]} */
    const anchored = [];
    for (const [at, entry] of evidence.entries()) {
      const span = object(entry);
      for (const key of Object.keys(span)) if (!["documentId", "start", "end", "quote"].includes(key)) return void item.bad(`evidence[${at}].${key}`, "证据只写 documentId、start、end、quote。", "vcr_write_field_forbidden");
      const positioned = Number.isInteger(span.start) && Number.isInteger(span.end);
      if (typeof span.documentId !== "string" || !ID.test(span.documentId) || typeof span.quote !== "string"
        || (span.start != null || span.end != null) && !positioned) {
        return void item.bad(`evidence[${at}]`, "每条证据要有 documentId 和原句 quote；start 和 end 要么都是整数、要么都不写。");
      }
      const verified = await verifySourceSpan({ item, documents, study, subjectKey: String(subjectKey), documentId: span.documentId,
        span: { start: positioned ? span.start : null, end: positioned ? span.end : null, quote: span.quote }, fact: { surface: span.quote.slice(0, 400) }, field: `evidence[${at}]` });
      if (!verified) return null;
      anchored.push({ documentId: span.documentId, start: verified.span.start, end: verified.span.end, quote: verified.span.quote, visibleAt: verified.document.visibleAt ?? null });
    }
    const saved = await matchStore.saveLanguageJudgment({ studyId: study.id, userId: study.userId, subjectKey, criterionKey, state, evidence: anchored });
    extra.results.push({ index: item.index, id: saved.id });
    return saved.id;
  },

  async site(item, { matchStore, study }) {
    if (!item.only(["id", "name", "capability", "capacity", "competing", "contacts", "activatedOn", "accrualPrior"])) return null;
    const id = item.token("id", ID, "已有中心的 id（新建时不写）");
    const name = item.str("name", { max: 120, required: true });
    const capability = item.obj("capability") ?? {};
    const capacity = item.obj("capacity") ?? {};
    const competing = item.arr("competing", { max: 30 }) ?? [];
    const contacts = item.arr("contacts", { max: 20 }) ?? [];
    const activatedOn = item.iso("activatedOn");
    const prior = item.obj("accrualPrior", { bytes: 2048 }) ?? {};
    for (const key of Object.keys(prior)) if (!["alpha", "beta", "screenFailureRate"].includes(key)) item.bad(`accrualPrior.${key}`, "accrualPrior 只写 alpha、beta、screenFailureRate；历史入组数由台账算出，不可手填。", "vcr_write_field_forbidden");
    for (const key of ["alpha", "beta"]) if (prior[key] != null && !(Number.isFinite(prior[key]) && prior[key] > 0)) item.bad(`accrualPrior.${key}`, `${key} 是大于 0 的数。`);
    if (prior.screenFailureRate != null && !(Number.isFinite(prior.screenFailureRate) && prior.screenFailureRate >= 0 && prior.screenFailureRate < 1)) item.bad("accrualPrior.screenFailureRate", "screenFailureRate 是 0 到 1 之间的数。");
    if (!item.ok) return null;
    if (!matchStore?.upsertSite) return void item.bad("name", "匹配与招募未接入本部署。", "vcr_write_refused");
    // An id names a site this study already has; a run does not choose the id of a new one.
    if (id && !(await matchStore.getSite(id, study.id))) return void item.bad("id", "这个中心不属于本研究：新建中心不写 id。");
    // A run never says a site was verified: 「最后核实时间」 is a person's, and
    // a profile with none makes no capacity claim (plan §7.2).
    const saved = await matchStore.upsertSite({ userId: study.userId, site: {
      id: id ?? undefined, studyId: study.id, name, capability, capacity, competing, contacts, activatedOn: activatedOn ?? null,
      accrualPrior: prior, verifiedAt: null,
    } });
    if (!saved) return void item.bad("id", "这个中心不属于本研究。");
    return saved.id;
  },

  async followup(item, { matchStore, study }) {
    if (!item.only(["subjectKey", "kind", "windowStart", "windowEnd", "observations", "exitDate", "exitReason"])) return null;
    const subjectKey = item.token("subjectKey", TOKEN, "受试者的假名编号", { required: true });
    const kind = item.choice("kind", VCR_FOLLOWUP_KINDS, { required: true });
    const windowStart = item.iso("windowStart");
    const windowEnd = item.iso("windowEnd");
    const exitDate = item.iso("exitDate");
    const exitReason = item.str("exitReason", { max: 300 });
    const observations = item.arr("observations", { max: 50 }) ?? [];
    for (const [at, entry] of observations.entries()) {
      const row = object(entry);
      if (Object.keys(row).some((key) => !["variable", "value", "unit", "at"].includes(key))) item.bad(`observations[${at}]`, "观察写成 { variable, value, unit, at }。");
      else if (typeof row.variable !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(row.variable)) item.bad(`observations[${at}].variable`, "variable 是小写英文变量名。");
      else if (kind === "study_specific" && VCR_TRIAL_RESTRICTED_FIELDS.includes(row.variable)) {
        // An observation of a field the partner cannot see is an exit turned into a trial fact.
        const refusal = deriveFromExit({ field: row.variable });
        item.bad(`observations[${at}].variable`, refusal.message, refusal.code);
      }
    }
    if (kind === "study_specific" && (!exitDate || !exitReason)) item.bad("exitDate", "试验期间的片段要写出组日期 exitDate 和原因 exitReason，照原样，不转换。");
    // The trial-period window ends on the exit date: a different end would leave the exit date recorded nowhere.
    if (kind === "study_specific" && exitDate && windowEnd && new Date(windowEnd).getTime() !== new Date(exitDate).getTime()) {
      item.bad("windowEnd", "试验期间的片段在出组日结束：windowEnd 不写，或与 exitDate 相同。");
    }
    if (kind === "post_exit" && !windowStart) item.bad("windowStart", "出组后观察要写起点 windowStart。");
    if (!item.ok) return null;
    if (!matchStore?.saveFollowupEpisode) return void item.bad("subjectKey", "匹配与招募未接入本部署。", "vcr_write_refused");
    /** @type {Record<string, any>} */
    const episode = kind === "study_specific"
      ? trialPeriodEpisode({ studyId: study.id, subjectKey: String(subjectKey), exitDate: String(exitDate), exitReason: String(exitReason), observations, windowStart: windowStart ?? null, windowEnd: windowEnd ?? null })
      : kind === "post_exit"
        ? postExitEpisode({ studyId: study.id, subjectKey: String(subjectKey), from: String(windowStart), to: windowEnd ?? null, observations })
        : { studyId: study.id, subjectKey: String(subjectKey), kind, windowStart: windowStart ?? null, windowEnd: windowEnd ?? null, observations, restricted: {}, exitReason: exitReason ?? null };
    // The exit stands as first recorded: what this subject's trial-period episode already says, read back,
    // is what the new exit is held to. A different one is appended and reported, never written over.
    const recorded = kind === "study_specific" && matchStore.listFollowupEpisodes
      ? (await matchStore.listFollowupEpisodes({ studyId: study.id, subjectKey: String(subjectKey) })).find((/** @type {any} */ row) => row.kind === "study_specific") ?? null
      : null;
    const saved = await matchStore.saveFollowupEpisode({ userId: study.userId, episode });
    if (recorded) {
      /** @param {unknown} value */
      const instant = (value) => (value ? new Date(/** @type {any} */ (value)).toISOString() : "");
      for (const finding of followupFidelityFindings({ ...recorded, exitDate: instant(recorded.windowEnd) }, { exitDate: instant(exitDate), exitReason: exitReason ?? "" })) {
        item.issues.push(issue(item.index, finding.code === "vcr_exit_date_rewritten" ? "exitDate" : finding.code === "vcr_exit_reason_rewritten" ? "exitReason" : "kind",
          finding.code, finding.message));
      }
    }
    return saved.id;
  },

  /**
   * The words of a report, with `{{n:…}}` references in them: the platform
   * renders every number from the study's own results and stores the rendered
   * text as the package's report (plan §8.3, principle 10c). The run is told what
   * did not resolve, never what it rendered to: a rendered number can be an exact
   * small count, which a model does not read.
   *
   * **Which export a report goes into is the dispatch's to say, never the kind a
   * run types.** A run the orchestrator sent out for one export fills that export
   * and nothing else: the kind it names has to be that export's (or be left out),
   * and a different one is refused by name with nothing created. The export used
   * to be picked by the typed kind, 「研究包」 when none was typed, and made when
   * none was open — so a run sent to write a 模拟报告 that typed `study_package`
   * left its own export to end 「未完成」 and made an orphan 研究包 nobody had
   * asked for, which the next 导出研究包 then answered with (pilot acceptance,
   * 2026-10-03). Only a write no export dispatch is out for — the researcher's own
   * conversation — still opens a row of the kind it names.
   */
  async report(item, { store, service, study, orchestrator, caller }) {
    if (!item.only(["kind", "section", "template", "text"])) return null;
    const template = item.str("template", { max: 200_000 }) ?? item.str("text", { max: 200_000 });
    if (!template?.trim()) return void item.bad("template", "报告文字不能为空。");
    const named = item.choice("kind", VCR_EXPORT_KINDS);
    const section = item.str("section", { max: 60 }) ?? "main";
    if (!item.ok) return null;
    const dispatched = typeof orchestrator?.exportDispatch === "function" ? await orchestrator.exportDispatch(study.id, caller ?? {}) : null;
    /** @type {any} */
    let target;
    if (dispatched) {
      target = await store.exportRow(study.id, dispatched.exportId);
      if (!target) return void item.bad("kind", "这次运行要写的那份导出已经不在了，报告没有保存。", "vcr_write_refused");
      if (named && named !== target.kind) {
        const label = (/** @type {string} */ kind) => /** @type {Record<string, string>} */ (VCR_EXPORT_KIND_LABELS_ZH)[kind] ?? kind;
        return void item.bad("kind", `这次运行是为导出「${label(target.kind)}」派发的，报告只能写进这一份：kind 写 ${target.kind}，或者不写 kind，再提交一次。`
          + `没有另建「${label(named)}」，这次提交的正文也没有保存。`);
      }
    } else {
      const kind = named ?? "study_package";
      const open = (await store.exports(study.id)).find((/** @type {any} */ row) => ["queued", "running"].includes(row.state) && row.kind === kind);
      target = open ?? await store.createExport({ studyId: study.id, userId: study.userId, kind, cover: {} });
    }
    // The first section freezes the numerical and review snapshot. Later
    // sections bind to that model under the export row lock, including two
    // report writes arriving while a calculation changes the live study.
    const candidate = object(target.cover).results ?? (service.reportModel ? await service.reportModel(study) : {});
    let rendered = renderVcrNumbers(template, candidate);
    const update = (cover) => {
      const model = cover.results ?? candidate;
      rendered = renderVcrNumbers(template, model);
      const reports = Array.isArray(cover.reports) ? [...cover.reports] : [];
      const report = { section, template, rendered: rendered.text, bindings: rendered.bindings };
      const index = reports.findIndex(entry => entry.section === section);
      if (index < 0) reports.push(report); else reports[index] = report;
      return { ...cover, reports, report, results: model, intendedUse: model.intendedUse ?? study.intendedUse,
        reviews: model.review?.records ?? [], staleResults: model.stale?.length ?? 0, seal: model.seal ?? null };
    };
    if (store.updateExportCover) {
      if (!await store.updateExportCover(target.id, update)) throw new HttpError(404, "vcr_export_not_found", "Export not found.");
    } else await store.updateExport(target.id, { cover: update(object(target.cover)) });
    for (const found of rendered.issues) item.issues.push(issue(item.index, found.path, found.code, found.message.replace(/（AC-\d+）|（方案 §[\d.]+）|方案 §[\d.]+[，。；]?/g, "")));
    return target.id;
  },
};

/**
 * The runtime's write. Every `what` validates its own fields, refuses item by
 * item and never fails the batch; `ids` are what was written.
 *
 * @param {WriteDeps & { what: string, items: any[] | null, data: any | null }} input
 */
export async function vcrRuntimeWrite({ store, service, orchestrator, study, what, items, data, evidence = null, evidenceStore = null,
  matchStore = null, matching = null, seal = null, dataPlane = null, documents = null, report = () => {}, caller = null }) {
  /** @type {string[]} */
  const ids = [];
  /** @type {Array<Record<string, any>>} */
  const issues = [];
  /** @type {string[]} */
  const changed = [];
  /** @type {any[]} */
  const results = [];
  const rows = items ?? (data ? [data] : []);
  if (!rows.length) {
    return { ok: false, ids, issues: [issue(null, "", "vcr_write_empty", "这次写入没有任何内容。")] };
  }
  /** @type {WriteDeps} */
  const deps = { store, service, orchestrator, study, evidence, evidenceStore, matchStore, matching, seal, dataPlane, documents, report, caller };

  if (what === "protocol" || what === "criteria") {
    try {
      const { criteria, versionRow } = await checkedCriteria(deps, rows, issues, what);
      if (criteria.length) {
        const previous = await store.latestProtocolVersion(study.id);
        // The matching store writes the version with its criteria and their
        // applicability in one transaction; a store without it (a test double)
        // writes what the study store can.
        const writer = matchStore?.saveProtocolVersion ? matchStore : store;
        const saved = await writer.saveProtocolVersion({
          studyId: study.id, userId: study.userId, title: String(versionRow.title ?? previous?.title ?? "").slice(0, 300),
          sourceRef: versionRow.sourceRef ?? previous?.sourceRef ?? null, usdm: object(versionRow.usdm ?? previous?.usdm), criteria,
        });
        changed.push(`protocol_version:${saved.id}@${saved.version}`);
        ids.push(saved.id);
        // A version written without the criteria that were refused is a version that
        // asks less than the protocol does: the run is told that the whole set is
        // what a corrected write must carry, not only the refused ones.
        if (issues.length) {
          results.push({ protocolVersion: saved.version, written: criteria.length, refused: issues.length,
            note: "这一版没有包含被拒的条件。改好后把全部条件整套再写一次（新版本）；只补写被拒的几条会得到一个只有那几条的版本。" });
        }
      } else if (what === "criteria") {
        issues.push(issue(null, "criteria", "vcr_write_value_invalid", "入排条件至少要有一条能写入的。"));
      }
    } catch (error) {
      if (error instanceof HttpError) issues.push(issue(null, "", "vcr_write_refused", error.message));
      else if (isDatabaseError(error)) { report(/** @type {any} */ (error).code); issues.push(issue(null, "", "vcr_write_refused", "存储没有接受这次写入，其余不受影响。")); }
      else throw error;
    }
  } else {
    const writer = WRITERS[what];
    for (const [index, raw] of rows.entries()) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        issues.push(issue(index, "", "vcr_write_value_invalid", "每一项是一个对象。"));
        continue;
      }
      const item = new Item({ row: /** @type {Record<string, any>} */ (raw), index, issues, study, store });
      try {
        const written = await writer(item, deps, { changed, results });
        if (written && item.ok) ids.push(written);
      } catch (error) {
        if (error instanceof HttpError) issues.push(issue(index, "", "vcr_write_refused", error.message));
        else if (isDatabaseError(error)) {
          // What failed underneath is the operator's to know; the run hears that
          // this one item was not written and that the others were not affected.
          report(/** @type {any} */ (error).code);
          issues.push(issue(index, "", "vcr_write_refused", "存储没有接受这一项，其余不受影响。"));
        } else throw error;
      }
    }
  }

  if (changed.length && orchestrator?.recomputeAfterChange) {
    await orchestrator.recomputeAfterChange({
      studyId: study.id, changed, reason: what === "criteria" || what === "protocol" ? "criterion_changed" : "assumption_changed",
      detail: { by: "runtime", what },
    }).catch(() => null);
  }
  return { ok: ids.length > 0, ids, issues, ...(results.length ? { results } : {}) };
}

/**
 * A pooling job of this study, as the card needs it: succeeded, about the
 * parameter named, with the result the engine wrote and the evidence ids the
 * job froze. Anything else is a reason, in words.
 *
 * @param {any} store @param {any} study @param {string} jobId @param {string} parameter
 * @returns {Promise<{ error: string, result?: undefined, evidenceIds?: undefined } | { error?: undefined, result: any, evidenceIds: string[] }>}
 */
async function loadPoolJob(store, study, jobId, parameter) {
  const row = ID.test(jobId)
    ? await store.one("SELECT id, kind, state, scenario, checkpoint FROM evimed_vcr.jobs WHERE id = $1 AND study_id = $2", [jobId, study.id]) : null;
  if (!row) return { error: "这个作业不属于本研究。" };
  if (row.kind !== "pool_evidence") return { error: "这不是一个合并作业。" };
  if (row.state !== "succeeded") return { error: `这个合并作业还没有成功（${row.state}）：先读作业状态。` };
  const about = object(object(row.checkpoint).parameter ? row.checkpoint : {});
  if (parameter && about.parameter && about.parameter !== parameter) return { error: `这个作业合并的是「${about.parameter}」，不是「${parameter}」。` };
  const execution = await store.one("SELECT id FROM evimed_vcr.executions WHERE job_id = $1 ORDER BY created_at DESC LIMIT 1", [jobId]);
  const result = execution ? (await store.allResults(study.id)).find((/** @type {any} */ entry) => entry.executionId === String(execution.id)) ?? null : null;
  if (!result) return { error: "这个作业没有留下结果。" };
  return { result, evidenceIds: list(object(row.scenario).studies).map((/** @type {any} */ entry) => String(entry?.studyId ?? "")).filter(Boolean) };
}

/**
 * Re-read a patient's document and check the span a run says it read: the
 * document is this study's and this subject's, the quotation is the document's
 * bytes between `start` and `end`, and the surface and any value are in it
 * (`verifyFactEvidence`, the same check the evaluator applies again when it
 * judges). Records the refusal on the item and answers `null` when any of it fails.
 *
 * @param {{ item: Item, documents: any, study: any, subjectKey: string, documentId: string,
 *   span: { start: number | null, end: number | null, quote: string },
 *   fact: { surface?: string, dateSurface?: string, value?: number }, field?: string }} input
 * @returns {Promise<{ document: { id: string, text: string, visibleAt: string | null }, span: { start: number, end: number, quote: string } } | null>}
 */
async function verifySourceSpan({ item, documents, study, subjectKey, documentId, span, fact, field = "documentId" }) {
  if (typeof documents?.read !== "function") {
    item.bad(field, "病历文档未接入本部署：事实无法在原文里核对，没有写入。", "vcr_write_refused");
    return null;
  }
  const document = await documents.read(study, { subjectKey, documentId }).catch(() => null);
  if (!document) {
    item.bad(field, `文档「${documentId.slice(0, 60)}」不是本研究里这位受试者的。`);
    return null;
  }
  // A run counts characters badly. Without an offset the platform finds the
  // quotation itself — exactly, and only where the document has it once; with
  // one, the bytes there must be the quotation.
  let { start, end } = span;
  if (start == null || end == null) {
    const at = [];
    for (let from = document.text.indexOf(span.quote); from >= 0 && at.length < 6; from = document.text.indexOf(span.quote, from + 1)) at.push(from);
    if (at.length === 0) {
      item.bad(field, "原文里找不到这句引文：quote 要逐字出现在文档里。", "vcr_evidence_unverified");
      return null;
    }
    if (at.length > 1) {
      item.bad(field, `这句引文在文档里出现了不止一次（起点 ${at.join("、")}）：写上 start 和 end，指明是哪一处。`);
      return null;
    }
    start = at[0];
    end = at[0] + span.quote.length;
  }
  const { verifyFactEvidence } = await import("./vcrMatching.mjs");
  const verdict = verifyFactEvidence({
    id: "check", polarity: "affirmed", extractedBy: "model", surface: fact.surface ?? span.quote, value: fact.value, dateSurface: fact.dateSurface,
    source: { documentId, start, end, quote: span.quote },
  }, { documents: new Map([[documentId, { text: document.text }]]) });
  if (!verdict.ok) {
    item.bad(field, `原文里核对不上（${verdict.reason}）：start 到 end 之间的字要和 quote 逐字一致，quote 要包含 surface，数值要出现在这段里。`, "vcr_evidence_unverified");
    return null;
  }
  return { document, span: { start: /** @type {number} */ (start), end: /** @type {number} */ (end), quote: span.quote } };
}

/**
 * The gateway's base address as the runtime may know it: empty when the
 * module is off, so the tools answer 「关闭」 without a request. Derived from
 * the model gateway's address, as GEO's and the frontier's are.
 * @param {any} config @returns {string}
 */
export function vcrGatewayProviderUrl(config) {
  if (!config?.vcrEnabled) return "";
  let url;
  try { url = new URL(String(config.modelGatewayInternalUrl ?? "")); } catch { return ""; }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "";
  url.pathname = gatewayPath;
  url.search = "";
  url.hash = "";
  return url.href;
}

/** The bounded metric label of a gateway path. @param {string} pathname */
export function vcrGatewayRoutePattern(pathname) {
  const operation = pathname.slice(gatewayPath.length + 1);
  return operations.includes(operation) ? pathname : `${gatewayPath}/:operation`;
}

/**
 * What a run is told of a pooling job that has finished: the pooled value on
 * the natural scale the run reads, the range a simulation may use and what it
 * rests on — derived by the platform from the engine's own numbers, never by the
 * run.
 * @param {any} result @param {{ parameter?: string }} about
 */
function poolingSummary(result, about) {
  const pool = readPoolResult(result);
  if (!pool.ok) return { ok: false, reason: pool.reason };
  const scale = String(pool.scale ?? "identity");
  const kind = parameterKindOf(String(about.parameter ?? ""));
  const natural = {
    pooled: naturalOf(/** @type {number} */ (pool.pooled), scale),
    confidenceInterval: pool.confidence ? { kind: "confidence", low: naturalOf(pool.confidence.low, scale), high: naturalOf(pool.confidence.high, scale) } : null,
  };
  const distribution = pool.prediction
    ? distributionFromPooled({ kind, pooled: /** @type {number} */ (pool.pooled), prediction: pool.prediction, scale }) : null;
  return {
    ok: true, scale: scale || defaultScaleOf(kind), k: pool.k ?? null, i2: pool.i2 ?? null, tau2: pool.tau2 ?? null,
    method: pool.poolingMethod ?? null, ...natural,
    predictionInterval: distribution?.predictionInterval ?? null,
    predictionAvailable: Boolean(pool.prediction),
    ...(pool.prediction ? {} : { note: "少于三项研究，没有预测区间；写假设卡时会按加宽后的专家设定·待补证处理。" }),
  };
}

/**
 * @param {any} config @param {any} runtimeManager
 * @param {{ vcr: { service: any, store: any, jobs?: any, orchestrator?: any, evidence?: any, evidenceStore?: any, matchStore?: any,
 *   matching?: any, seal?: any, dataPlaneSeam?: any, documents?: any } | null,
 *   report?: (code: string) => void, budgetMs?: number }} dependencies
 */
export function createVcrGatewayHandler(config, runtimeManager, { vcr, report = () => {}, budgetMs = answerBudgetMs }) {
  /** @type {Map<string, { until: number, count: number }>} */
  const windows = new Map();
  const registryDeadline = Number(config?.vcrRegistryTimeoutMs) > 0 ? Number(config.vcrRegistryTimeoutMs) : REGISTRY_DEADLINE_MS;
  return async function vcrGatewayHandler(/** @type {any} */ req, /** @type {any} */ res, /** @type {any} */ onFailure) {
    try {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      const operation = pathname.startsWith(`${gatewayPath}/`) ? pathname.slice(gatewayPath.length + 1) : "";
      if (req.method !== "POST" || !operations.includes(operation)) throw gatewayError(404, "not_found", "Not found.");
      const header = String(req.headers?.authorization ?? "").trim();
      const token = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim();
      if (!token) throw gatewayError(401, "vcr_gateway_token_missing", "虚拟临研 gateway authentication failed.");
      let identity;
      try { identity = runtimeManager.assertActiveModelGatewayToken(token); } catch {
        throw gatewayError(401, "vcr_gateway_token_invalid", "虚拟临研 gateway authentication failed.");
      }
      if (!config.vcrEnabled || !vcr?.service) {
        throw gatewayError(503, "vcr_disabled", "虚拟临研 is switched off for this deployment; answer without the platform's study data.");
      }
      const user = { id: String(identity.userId) };
      if (!vcr.service.allows(user)) {
        throw gatewayError(503, "vcr_disabled", "虚拟临研 is not open to this account; answer without the platform's study data.");
      }
      const now = Date.now();
      for (const [key, window] of windows) if (window.until <= now) windows.delete(key);
      const key = `${identity.userId}\u0000${identity.projectId}\u0000${operation}`;
      const window = windows.get(key) ?? { until: now + 60_000, count: 0 };
      windows.set(key, window);
      if (++window.count > /** @type {Record<string, number>} */ (windowLimits)[operation]) {
        throw gatewayError(429, "vcr_gateway_rate_limited", "Too many 虚拟临研 calls in a minute.");
      }
      const body = await readJsonBody(req, /** @type {Record<string, number>} */ (requestLimits)[operation]);
      const study = await vcr.store.studyByControlProject(String(identity.userId), String(identity.projectId));
      if (!study) {
        throw gatewayError(404, "vcr_no_study",
          "This conversation is not in a 虚拟临研 study; open the study's own conversation to read or write its data.");
      }

      /** @type {() => Promise<any>} */
      let work;
      let budget = budgetMs;
      if (operation === "read") {
        const request = readRequest(body);
        // A registry read waits on a registry: its budget is its client's deadline
        // and a margin, so the gateway never gives up before the client does.
        if (request.what === "trial_registry_record") budget = Math.max(budgetMs, registryDeadline + REGISTRY_MARGIN_MS);
        work = async () => ({ what: request.what, ...(await vcr.service.runtimeRead(study, request.what, request.filter)) });
      } else if (operation === "write") {
        const request = writeRequest(body);
        // The token names the runtime, and a runtime reserved for one dispatch names that dispatch: with the
        // study's own run slot, that is which run is calling — nothing the run sends says so.
        const runtimeRunId = runtimeManager.boundedRuntimeScope?.({ userId: String(identity.userId), id: String(identity.projectId) })?.runId ?? null;
        work = async () => {
          const result = await vcrRuntimeWrite({
            store: vcr.store, service: vcr.service, orchestrator: vcr.orchestrator ?? null, study,
            what: request.what, items: request.items, data: request.data,
            evidence: vcr.evidence ?? null, evidenceStore: vcr.evidenceStore ?? null, matchStore: vcr.matchStore ?? null,
            matching: vcr.matching ?? null, seal: vcr.seal ?? null, dataPlane: vcr.dataPlaneSeam ?? null, documents: vcr.documents ?? null, report,
            caller: { runtimeRunId: runtimeRunId == null ? null : String(runtimeRunId) },
          });
          vcr.service.counters.writes += 1;
          vcr.service.counters.writeIssues += result.issues.length;
          return { what: request.what, ...result };
        };
        // A write that fetches a registry record waits on the registry too.
        if (request.what === "precedent") budget = Math.max(budgetMs, registryDeadline + REGISTRY_MARGIN_MS);
      } else {
        const request = simulateRequest(body);
        work = async () => {
          if (!vcr.jobs) {
            throw gatewayError(503, "vcr_gateway_unavailable", "作业队列在本部署尚未接入：这一步暂不可用。");
          }
          if (request.action === "start") return startJob(vcr, study, /** @type {any} */ (request));
          if (request.action === "cancel") {
            const result = await vcr.jobs.cancel(study.id, request.jobId, { actor: "runtime" });
            return { action: "cancel", jobId: request.jobId, state: result.job?.state ?? "canceled", canceled: result.canceled };
          }
          // A service without the boundary is a wiring fault, and the raw
          // answer is never the fallback: it would carry every small cell.
          if (typeof vcr.service.forModel !== "function") {
            throw gatewayError(503, "vcr_gateway_unavailable", "这份读取结果无法确认不含小样本格子，已整体拒绝。");
          }
          const job = await vcr.jobs.get(study.id, request.jobId);
          if (!job) throw gatewayError(404, "vcr_job_not_found", "这个作业不属于本研究。");
          // The result this job produced, found through the execution it wrote
          // — never 「the newest result of this study」, which would hand a run
          // somebody else's numbers under its own job id.
          const execution = job.state === "succeeded" || job.state === "failed"
            ? await vcr.store.one("SELECT id FROM evimed_vcr.executions WHERE job_id = $1 ORDER BY created_at DESC LIMIT 1", [job.id])
            : null;
          const result = execution
            ? (await vcr.store.allResults(study.id)).find((/** @type {any} */ row) => row.executionId === String(execution.id)) ?? null
            : null;
          const pooling = result && job.method === "evidence.pool"
            ? poolingSummary(result, object(await vcr.store.one("SELECT checkpoint FROM evimed_vcr.jobs WHERE id = $1", [job.id]).then((/** @type {any} */ row) => row?.checkpoint))) : null;
          // What a run reads of a result is what a page shows a member, less
          // its small cells (contract §4): the answer passes the boundary once.
          const answer = { action: "status", jobId: job.id, state: job.state, progress: job.progress,
            cpuSeconds: job.cpuSecondsUsed, error: job.error, result, ...(pooling ? { pooling } : {}) };
          return vcr.service.forModel(answer);
        };
      }

      /** @type {any} */
      let timer;
      const result = await Promise.race([
        work(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(gatewayError(504, "vcr_gateway_timeout", "The 虚拟临研 gateway timed out.")), budget);
          timer.unref?.();
        }),
      ]).finally(() => clearTimeout(timer));
      sendJson(res, 200, { data: result });
    } catch (caught) {
      let error = caught;
      // The service speaks in HttpErrors. The ones about the call's own shape
      // pass through; a filter naming something the study does not have is the
      // filter being wrong; nothing else of the service's is a code the run's
      // verdict knows.
      if (error instanceof HttpError) {
        if (VCR_GATEWAY_ERROR_CODES.includes(error.code)) error = gatewayError(error.status, error.code, error.message);
        else if (error.status === 404) error = gatewayError(400, "vcr_read_filter_invalid", error.message);
        else if (error.status === 400) error = gatewayError(400, "vcr_request_invalid", error.message);
      }
      const known = error instanceof VcrGatewayError;
      const status = known ? /** @type {any} */ (error).status : 503;
      const code = known ? /** @type {any} */ (error).code : "vcr_gateway_unavailable";
      if (!known) {
        report(typeof /** @type {any} */ (error)?.code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(/** @type {any} */ (error).code)
          ? /** @type {any} */ (error).code : /** @type {any} */ (error)?.name ?? "error");
      }
      onFailure?.({ code, status });
      sendJson(res, status, {
        error: known ? /** @type {any} */ (error).message : "The 虚拟临研 gateway is unavailable; go on without the platform's study data.",
        code,
        ...(known && error.alternatives ? { alternatives: error.alternatives } : {}),
      });
    }
  };
}

/**
 * `simulate start`. Two kinds are not the run's scenario: a pooling job is
 * built by the platform from this study's verified extractions of the parameter
 * the run names, and a matching job freezes the protocol's own criteria. Every
 * other kind is the run's frozen scenario, validated by the queue against the
 * engine's own schema.
 *
 * @param {any} vcr @param {any} study
 * @param {{ kind: string, scenario: Record<string, any>, inputs: unknown[], seed: number | null, replicates: number | null,
 *   cpuSecondsLimit: number | null, subjectId: string | null, reconstructionResultId?: string | null }} request
 */
async function startJob(vcr, study, request) {
  if (request.kind === "pool_evidence") {
    if (!vcr.evidence?.poolParameter) throw gatewayError(503, "vcr_gateway_unavailable", "证据参数化未接入本部署：这一步暂不可用。");
    const unknown = Object.keys(request.scenario).filter((key) => !POOL_REQUEST_FIELDS.includes(key));
    if (unknown.length || request.inputs.length) {
      throw gatewayError(400, "vcr_simulate_payload_invalid",
        `合并只写 ${POOL_REQUEST_FIELDS.join("、")}：要合并的值来自本研究已通过核对的抽取值，不要自己带数。`);
    }
    const scenario = request.scenario;
    if (typeof scenario.parameter !== "string" || !scenario.parameter.trim() || scenario.parameter.length > 120) {
      throw gatewayError(400, "vcr_simulate_payload_invalid", "parameter 是被合并的参数名。");
    }
    if (typeof scenario.endpointKey !== "string" || !TOKEN.test(scenario.endpointKey)) {
      throw gatewayError(400, "vcr_simulate_payload_invalid", "endpointKey 是终点口径的短标识（不能为空）。");
    }
    if (scenario.calibres != null && (!Array.isArray(scenario.calibres) || scenario.calibres.some((/** @type {any} */ calibre) => !["closest", "overall", "next_closest"].includes(calibre)))) {
      throw gatewayError(400, "vcr_simulate_payload_invalid", "calibres 是 closest、overall、next_closest 里的几项。");
    }
    if (scenario.armRole != null && !EVIDENCE_ARM_ROLES.includes(String(scenario.armRole))) {
      throw gatewayError(400, "vcr_simulate_payload_invalid", `armRole 必须是：${EVIDENCE_ARM_ROLES.join("、")}。`);
    }
    const pooled = await vcr.evidence.poolParameter({
      userId: study.userId, studyId: study.id, parameter: scenario.parameter.trim(), endpointKey: scenario.endpointKey,
      armRole: scenario.armRole ?? "", target: poolTargetOf(scenario.target), poolingMethod: scenario.method ?? "random_effects_reml",
      calibres: scenario.calibres ?? null,
    });
    const started = list(pooled.jobs).filter((/** @type {any} */ job) => job.jobId);
    // Every study the pool left out, with why: the list is as long as the pool can be (a run that
    // is told 「20 项」 of 60 excluded has been told nothing about the other 40).
    const refused = list(pooled.refused);
    const left = { refused: refused.slice(0, VCR_POOL_MAX_STUDIES), refusedCount: refused.length };
    if (!started.length) {
      return { action: "start", state: "not_started", jobs: list(pooled.jobs), reason: pooled.code ?? pooled.status, message: pooled.message ?? null, ...left };
    }
    return { action: "start", jobId: started[0].jobId, state: started[0].status, progress: {}, jobs: list(pooled.jobs), ...left };
  }

  /** @type {Record<string, any>} */
  let scenario = request.scenario;
  /** @type {unknown[]} */
  let inputs = request.inputs;
  /** @type {Record<string, any>} */
  let detail = { subjectId: request.subjectId, origin: "runtime" };
  /** @type {Record<string, any> | null} */
  let notes = null;
  if (request.kind === "match_criteria") {
    if (!vcr.matching?.matchScenario) throw gatewayError(503, "vcr_gateway_unavailable", "匹配未接入本部署：这一步暂不可用。");
    if (Object.keys(request.scenario).length || request.inputs.length) {
      throw gatewayError(400, "vcr_simulate_payload_invalid", "匹配评估不接受场景：平台按最新方案版本的入排条件和已写入的事实自己冻结它。");
    }
    const built = await vcr.matching.matchScenario(study);
    if (!built.ok) throw gatewayError(400, "vcr_simulate_payload_invalid", built.message);
    scenario = built.scenario;
    inputs = built.inputs;
    detail = { ...detail, protocolVersionId: built.protocolVersionId };
  } else if (request.kind === "accrual_forecast") {
    if (!vcr.matching?.accrualScenario) throw gatewayError(503, "vcr_gateway_unavailable", "入组预测未接入本部署：这一步暂不可用。");
    const unknown = Object.keys(request.scenario).filter((key) => !ACCRUAL_REQUEST_FIELDS.includes(key));
    if (unknown.length || request.inputs.length) {
      throw gatewayError(400, "vcr_simulate_payload_invalid", `入组预测只写 ${ACCRUAL_REQUEST_FIELDS.join("、")}：各中心的入组率来自台账和中心档案。`);
    }
    const built = await vcr.matching.accrualScenario(study, request.scenario);
    if (!built.ok) throw gatewayError(400, "vcr_simulate_payload_invalid", built.message);
    scenario = built.scenario;
    notes = built.notes ?? null;
    // The table the probability curve is drawn from is kept in the data plane.
    detail = { ...detail, keepTables: ["probability_by_month"] };
  }
  if (request.kind === VCR_RECONSTRUCTION_REFERENCE.kind && !request.reconstructionResultId) {
    throw gatewayError(400, "vcr_simulate_payload_invalid",
      "事件时间终点的匹配调整间接比较要比较臂的伪个体数据：用 reconstructionResultId 指向本研究一次曲线重建的结果，不要自己写数据行。");
  }
  // The reference rides beside the scenario: the queue resolves it through the data plane and writes the comparator's
  // input id into the scenario itself, so it is part of what makes the same request the same job.
  const derived = request.reconstructionResultId
    ? [{ resultId: request.reconstructionResultId, table: VCR_RECONSTRUCTION_REFERENCE.table, bindTo: VCR_RECONSTRUCTION_REFERENCE.bindTo }] : [];
  const scenarioHash = createHash("sha256").update(canonicalScenarioJson({ scenario, reconstruction: request.reconstructionResultId ?? null })).digest("hex").slice(0, 16);
  const { job } = await vcr.jobs.enqueue({
    studyId: study.id, userId: study.userId, kind: request.kind, scenario, inputs, ...(derived.length ? { derived } : {}),
    seed: request.seed, replicates: request.replicates, cpuSecondsLimit: request.cpuSecondsLimit,
    // The same frozen scenario asked for twice is the same job; a changed one is not.
    idempotencyKey: `vcr:${study.id}:runtime:${request.kind}:${request.subjectId ?? ""}:${scenarioHash}`,
    detail,
  }).catch(error => {
    if (error?.status === 400 && ['generate_population', 'literature_population', 'synthesize_population',
      'generate_patients', 'generate_patients_continuous', 'generate_patients_binary'].includes(request.kind)) {
      const refusal = gatewayError(400, 'vcr_simulate_payload_invalid', String(error.message));
      refusal.alternatives = [
        { kind: 'reference_scenario', label: '使用明确分布参数的参考情景' },
        { kind: 'registered_model', label: '查询已登记模型及其适用范围' },
        { kind: 'authorized_data', label: '补充已授权数据后再计算' },
      ];
      throw refusal;
    }
    throw error;
  });
  return { action: "start", jobId: job.id, state: job.state, progress: job.progress, ...(notes ? { notes } : {}),
    // A job stopped for budget is the second human stop: the run is
    // told plainly so it goes on with what it can do (§10.1).
    ...(job.state === "awaiting_budget"
      ? { awaitingBudget: true, message: "这项计算超出研究的计算预算，已停在确认处；确认后会自动继续。" } : {}) };
}

export const VCR_GATEWAY_PATH = gatewayPath;
export const VCR_GATEWAY_OPERATIONS = operations;
export const VCR_GATEWAY_WINDOW_LIMITS = windowLimits;
export { VCR_SCENARIO_SCHEMAS };
