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
// - **A read never carries a row of a person.** Every shape here is an
//   aggregate or a definition, and anything the data plane produces passes
//   through its `suppressSmallCells` first, so a cell speaking for fewer than
//   ten people is merged or withheld (plan §8.1, AC-26). The runtime holds no
//   database credential and no data-plane mount; this is the whole surface.
// - **A write refuses item by item.** A 200 with `ok: false` and the issues is
//   a write that wrote nothing, not an error. An error code means the call
//   itself could not be read — a `what` outside the vocabulary, a payload of
//   the wrong shape.
// - **A model may not write a number it did not compute.** `results`,
//   `counts`, `measures` and `executions` are not writable at all, and an item
//   that smuggles one of those fields is refused by name rather than having it
//   quietly dropped: a silently ignored field is a silent parameter change
//   (principle 1 — numbers come from the engine, never from the model).
// - **A changed assumption propagates on the way in.** The write path calls
//   the orchestrator's `recomputeAfterChange`, so 「改一处，自动知道哪些结果要
//   重算」 happens whether the edit came from a person or from a run (§6.3).
// - **Simulate is start/status, the same shape as `meta_analysis`.** A run
//   queues a frozen scenario and polls; it never waits on a socket for a
//   simulation, and a job outliving the run is normal — the study collects it.
// - What failed underneath (a database's SQLSTATE) is the operator's to know
//   and never the run's: its code goes to `report`, the run hears
//   `vcr_gateway_unavailable`.

import {
  VCR_ASSUMPTION_SOURCE_KINDS, VCR_COMPARATOR_ROUTES, VCR_CRITERION_TYPES, VCR_DISTRIBUTIONS, VCR_ENDPOINT_TYPES,
  VCR_ESTIMANDS, VCR_EXPORT_KINDS, VCR_JOB_KINDS, VCR_POPULATION_KINDS, VCR_STEPS, VCR_TRIAL_DESIGNS, VCR_VALUE_SOURCES,
} from "@evimed/domain";

import { HttpError } from "./security.mjs";
import { VCR_READ_WHATS, VCR_READ_MAX_ITEMS, VCR_WRITE_WHATS } from "./vcrService.mjs";
import { renderVcrNumbers, vcrReportModel } from "./vcrRender.mjs";

const gatewayPath = "/internal/vcr/v1";
const operations = Object.freeze(["read", "write", "simulate"]);
/** Calls one study may make per minute, per operation: the ceiling of a loop, not of a run. */
const windowLimits = Object.freeze({ read: 120, write: 60, simulate: 60 });
const requestLimits = Object.freeze({ read: 16 * 1024, write: 512 * 1024, simulate: 256 * 1024 });
/** Reads, writes and job submissions all answer within ten seconds; the engine runs elsewhere. */
const answerBudgetMs = 10_000;
const readFilterFields = Object.freeze(["kind", "limit", "offset", "registryId", "registry", "snapshotId", "subjectKey", "query"]);
const WRITE_MAX_ITEMS = 200;
/** Fields no runtime write may carry, whichever `what` it is (contract §3.2). */
const FORBIDDEN_FIELDS = Object.freeze(["counts", "measures", "results", "resultId", "execution", "executionId", "cpuSeconds"]);

/** Codes this gateway answers with. */
export const VCR_GATEWAY_ERROR_CODES = Object.freeze([
  "vcr_disabled", "vcr_no_study", "vcr_gateway_token_missing", "vcr_gateway_token_invalid", "vcr_gateway_rate_limited",
  "vcr_gateway_timeout", "vcr_gateway_unavailable", "vcr_request_invalid", "vcr_request_too_large",
  "vcr_read_what_invalid", "vcr_read_filter_invalid", "vcr_write_what_invalid", "vcr_write_payload_invalid",
  "vcr_simulate_action_invalid", "vcr_simulate_payload_invalid", "vcr_job_not_found", "registry_unavailable",
]);

class VcrGatewayError extends Error {
  /** @param {number} status @param {string} code @param {string} message */
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
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
  for (const key of ["kind", "registryId", "registry", "snapshotId", "subjectKey"]) {
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

/** @param {Record<string, any>} body */
function simulateRequest(body) {
  onlyFields(body, ["action", "kind", "scenario", "inputs", "seed", "replicates", "cpuSecondsLimit", "jobId", "subjectId"]);
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
    return { action, kind: body.kind, scenario: object(body.scenario), inputs: list(body.inputs),
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

/**
 * The write half. Every `what` validates its own fields, refuses item by item
 * and never fails the batch; `ids` are what was written.
 *
 * @param {{ store: any, service: any, orchestrator: any, study: any, what: string, items: any[] | null, data: any | null }} input
 */
export async function vcrRuntimeWrite({ store, service, orchestrator, study, what, items, data }) {
  /** @type {string[]} */
  const ids = [];
  /** @type {Array<Record<string, any>>} */
  const issues = [];
  /** @type {string[]} */
  const changed = [];
  const rows = items ?? (data ? [data] : []);
  if (!rows.length) {
    return { ok: false, ids, issues: [issue(null, "", "vcr_write_empty", "这次写入没有任何内容。")] };
  }

  for (const [index, raw] of rows.entries()) {
    const row = object(raw);
    const smuggled = FORBIDDEN_FIELDS.filter((field) => row[field] !== undefined);
    if (smuggled.length) {
      issues.push(issue(index, smuggled[0], "vcr_write_field_forbidden",
        `${smuggled.join("、")} 不可由模型写入：结果数字与计数只来自引擎作业（方案 §11.2 第 3 层）。`));
      continue;
    }
    try {
      const written = await writeOne({ store, service, orchestrator, study, what, row, index, issues, changed });
      if (written) ids.push(written);
    } catch (error) {
      if (error instanceof HttpError) issues.push(issue(index, "", "vcr_write_refused", error.message));
      else throw error;
    }
  }

  if (changed.length && orchestrator?.recomputeAfterChange) {
    await orchestrator.recomputeAfterChange({
      studyId: study.id, changed, reason: what === "criteria" || what === "protocol" ? "criterion_changed" : "assumption_changed",
      detail: { by: "runtime", what },
    }).catch(() => null);
  }
  return { ok: ids.length > 0, ids, issues };
}

/** @param {{ store: any, service: any, orchestrator: any, study: any, what: string, row: Record<string, any>, index: number, issues: any[], changed: string[] }} input */
async function writeOne({ store, service, orchestrator, study, what, row, index, issues, changed }) {
  const userId = study.userId;
  /** @param {string} field @param {unknown} value @param {readonly string[]} vocabulary */
  const vocab = (field, value, vocabulary) => {
    if (typeof value !== "string" || !vocabulary.includes(value)) {
      issues.push(issue(index, field, "vcr_write_value_invalid", `${field} 必须是：${vocabulary.join("、")}。`));
      return null;
    }
    return value;
  };

  switch (what) {
    case "definition": {
      const saved = await store.saveDefinition({
        studyId: study.id, userId, pico: object(row.pico), estimand: object(row.estimand),
        endpointType: row.endpointType == null ? null : vocab("endpointType", row.endpointType, VCR_ENDPOINT_TYPES),
        intendedUse: row.intendedUse, fieldSources: object(row.fieldSources), reviewState: "ai_set",
      });
      return saved.id;
    }
    case "protocol":
    case "criteria": {
      const previous = what === "criteria" ? await store.latestProtocolVersion(study.id) : null;
      const criteria = list(what === "criteria" ? (row.criteria ?? [row]) : row.criteria).map((item) => {
        const criterion = object(item);
        return {
          kind: criterion.kind === "exclusion" ? "exclusion" : "inclusion",
          criterionType: VCR_CRITERION_TYPES.includes(criterion.criterionType) ? criterion.criterionType : "other",
          requirement: object(criterion.requirement), sourceText: String(criterion.sourceText ?? ""),
          sourceLocator: object(criterion.sourceLocator), evidenceNeeded: list(criterion.evidenceNeeded), reviewState: "ai_set",
        };
      });
      if (!criteria.length && what === "criteria") {
        issues.push(issue(index, "criteria", "vcr_write_value_invalid", "入排条件至少要有一条。"));
        return null;
      }
      const saved = await store.saveProtocolVersion({
        studyId: study.id, userId, title: String(row.title ?? previous?.title ?? ""),
        sourceRef: row.sourceRef ?? previous?.sourceRef ?? null, usdm: object(row.usdm ?? previous?.usdm), criteria,
      });
      changed.push(`protocol_version:${saved.id}@${saved.version}`);
      return saved.id;
    }
    case "assumption": {
      const key = String(row.key ?? "").trim();
      if (!key || key.length > 80) {
        issues.push(issue(index, "key", "vcr_write_value_invalid", "key 是 1 到 80 个字符的参数名。"));
        return null;
      }
      if (row.sourceKind != null && !vocab("sourceKind", row.sourceKind, VCR_ASSUMPTION_SOURCE_KINDS)) return null;
      if (row.valueSource != null && !vocab("valueSource", row.valueSource, VCR_VALUE_SOURCES)) return null;
      const distributionKind = object(row.distribution).kind;
      if (distributionKind != null && !VCR_DISTRIBUTIONS.includes(String(distributionKind))) {
        issues.push(issue(index, "distribution.kind", "vcr_write_value_invalid", `分布必须是：${VCR_DISTRIBUTIONS.join("、")}。`));
        return null;
      }
      // An assumption drawn from the literature has to name where it came
      // from: a number with no locator never becomes an assumption (AC-25).
      if (row.sourceKind === "external_evidence" && !list(row.evidenceIds).length && !object(row.pooling).sources) {
        issues.push(issue(index, "evidenceIds", "vcr_write_value_invalid",
          "标为外部证据的假设卡要指向带原文位置的抽取值（AC-25）。"));
        return null;
      }
      const saved = await store.saveAssumption({
        studyId: study.id, userId, key, name: String(row.name ?? key), endpoint: row.endpoint ?? null, unit: row.unit ?? null,
        pointValue: row.pointValue ?? null, distribution: object(row.distribution), sensitivity: object(row.sensitivity),
        sourceKind: row.sourceKind ?? "expert_set", valueSource: row.valueSource ?? "assumed",
        poolingMethod: row.poolingMethod ?? null, pooling: object(row.pooling),
        evidenceIds: list(row.evidenceIds), applicability: object(row.applicability),
        reviewState: "ai_set", note: String(row.note ?? ""),
      });
      changed.push(`assumption:${saved.key}@${saved.version}`);
      return saved.id;
    }
    case "population": {
      if (!vocab("kind", row.kind, VCR_POPULATION_KINDS)) return null;
      const saved = await store.savePopulation({
        studyId: study.id, userId, name: String(row.name ?? ""), kind: row.kind, definition: object(row.definition),
        snapshotId: row.snapshotId ?? null, allowedUses: list(row.allowedUses), reviewState: "ai_set",
        profile: object(row.profile), quality: object(row.quality), waterfall: list(row.waterfall),
      });
      return saved.id;
    }
    case "patient_set": {
      const saved = await store.savePatientSet({
        studyId: study.id, userId, populationId: row.populationId ?? null, name: String(row.name ?? ""),
        modelId: row.modelId ?? null, modelVersion: row.modelVersion ?? null, scenario: object(row.scenario),
        twinLabel: row.twinLabel === "digital_twin" || row.twinLabel === "baseline_conditioned_prediction" ? row.twinLabel : null,
      });
      return saved.id;
    }
    case "comparator": {
      if (!vocab("route", row.route, VCR_COMPARATOR_ROUTES)) return null;
      if (row.estimand != null && !vocab("estimand", row.estimand, VCR_ESTIMANDS)) return null;
      const saved = await store.saveComparatorDesign({
        studyId: study.id, userId, route: row.route, estimand: row.estimand ?? "ATT",
        targetTrial: object(row.targetTrial), configuration: object(row.configuration),
        // A route the run has already judged unusable is a finished result:
        // the conclusion and the gap list travel together (plan §5.3).
        conclusion: row.conclusion === "not_estimable" ? "not_estimable" : null,
        gapList: list(row.gapList), reviewState: "ai_set",
      });
      return saved.id;
    }
    case "trial_scenario": {
      if (!vocab("design", row.design, VCR_TRIAL_DESIGNS)) return null;
      if (!vocab("endpointType", row.endpointType, VCR_ENDPOINT_TYPES)) return null;
      const saved = await store.saveTrialScenario({
        studyId: study.id, userId, label: String(row.label ?? ""), design: row.design, endpointType: row.endpointType,
        configuration: object(row.configuration), assumptionIds: list(row.assumptionIds), comparatorId: row.comparatorId ?? null,
      });
      return saved.id;
    }
    case "design_grid": {
      const saved = await store.saveDesignGrid({
        studyId: study.id, userId, dimensions: object(row.dimensions), truthScenarios: list(row.truthScenarios),
        comparisonGoal: row.comparisonGoal ?? null, cells: list(row.cells),
      });
      return saved.id;
    }
    case "decision": {
      const question = String(row.question ?? "").trim();
      if (!question) {
        issues.push(issue(index, "question", "vcr_write_value_invalid", "决策记录要写明决定的是什么。"));
        return null;
      }
      const saved = await store.addDecision({
        studyId: study.id, userId, question, chosen: object(row.chosen), alternatives: list(row.alternatives),
        rationale: String(row.rationale ?? ""), decidedBy: "ai_set",
      });
      return saved.id;
    }
    case "forecast": {
      // A prediction registered before the outcome it predicts (AC-23).
      const saved = await store.registerForecast({
        studyId: study.id, userId, kind: String(row.kind ?? "accrual"), prediction: object(row.prediction),
        public: row.public === true,
      });
      return saved.id;
    }
    case "model": {
      if (!row.name) {
        issues.push(issue(index, "name", "vcr_write_value_invalid", "模型要有名字。"));
        return null;
      }
      const saved = await service.adoptModel({ id: userId }, { ...row, studyId: study.id });
      return saved?.id ?? null;
    }
    case "step": {
      const step = vocab("step", row.step, VCR_STEPS);
      if (!step) return null;
      // A run may say what it is doing and ask for a step; it may not declare
      // a step finished — completion is read from the data (§4).
      await store.setStep(study.id, step, {
        ...(row.requested === true ? { requested: true } : {}),
        ...(row.note == null ? {} : { note: String(row.note).slice(0, 300) }),
      });
      return `${study.id}:${step}`;
    }
    default: {
      // `report`: the run writes the words with `{{n:…}}` references in them,
      // and the platform renders every number from the study's own results
      // (plan §8.3, AC-20). The model never types a number into a report.
      const template = String(row.template ?? row.text ?? "");
      if (!template.trim()) {
        issues.push(issue(index, "template", "vcr_write_value_invalid", "报告文字不能为空。"));
        return null;
      }
      const kind = VCR_EXPORT_KINDS.includes(row.kind) ? row.kind : "study_package";
      const [definition, assumptions, results, reviews, stale, population, comparator, scenarios, models] = await Promise.all([
        store.latestDefinition(study.id), store.assumptions(study.id), store.results(study.id), store.reviews(study.id),
        store.staleMarks(study.id), store.latestPopulation(study.id), store.latestComparatorDesign(study.id),
        store.trialScenarios(study.id, 20), store.models(userId),
      ]);
      const model = vcrReportModel({ study, definition, assumptions, results, reviews, staleMarks: stale, population,
        comparator, scenarios, models });
      const rendered = renderVcrNumbers(template, model);
      const open = (await store.exports(study.id)).find((row2) => ["queued", "running"].includes(row2.state) && row2.kind === kind);
      const target = open ?? await store.createExport({ studyId: study.id, userId, kind, cover: {} });
      await store.updateExport(target.id, {
        cover: {
          ...object(target.cover),
          report: { section: String(row.section ?? "main"), template, rendered: rendered.text, bindings: rendered.bindings },
          results: model,
        },
      });
      for (const item of rendered.issues) issues.push(issue(index, item.path, item.code, item.message));
      if (orchestrator) void orchestrator;
      return target.id;
    }
  }
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
 * @param {any} config @param {any} runtimeManager
 * @param {{ vcr: { service: any, store: any, jobs?: any, orchestrator?: any } | null,
 *   report?: (code: string) => void, budgetMs?: number }} dependencies
 */
export function createVcrGatewayHandler(config, runtimeManager, { vcr, report = () => {}, budgetMs = answerBudgetMs }) {
  /** @type {Map<string, { until: number, count: number }>} */
  const windows = new Map();
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
      if (operation === "read") {
        const request = readRequest(body);
        work = async () => ({ what: request.what, ...(await vcr.service.runtimeRead(study, request.what, request.filter)) });
      } else if (operation === "write") {
        const request = writeRequest(body);
        work = async () => {
          const result = await vcrRuntimeWrite({
            store: vcr.store, service: vcr.service, orchestrator: vcr.orchestrator ?? null, study,
            what: request.what, items: request.items, data: request.data,
          });
          vcr.service.counters.writes += 1;
          vcr.service.counters.writeIssues += result.issues.length;
          return { what: request.what, ...result };
        };
      } else {
        const request = simulateRequest(body);
        work = async () => {
          if (!vcr.jobs) {
            throw gatewayError(503, "vcr_gateway_unavailable", "作业队列在本部署尚未接入：这一步暂不可用。");
          }
          if (request.action === "start") {
            const { job } = await vcr.jobs.enqueue({
              studyId: study.id, userId: study.userId, kind: request.kind, scenario: request.scenario, inputs: request.inputs,
              seed: request.seed, replicates: request.replicates, cpuSecondsLimit: request.cpuSecondsLimit,
              idempotencyKey: `vcr:${study.id}:runtime:${request.kind}:${request.subjectId ?? ""}`,
              detail: { subjectId: request.subjectId, origin: "runtime" },
            });
            return { action: "start", jobId: job.id, state: job.state, progress: job.progress,
              // A job stopped for budget is the second human stop: the run is
              // told plainly so it goes on with what it can do (§10.1).
              ...(job.state === "awaiting_budget"
                ? { awaitingBudget: true, message: "这项计算超出研究的计算预算，已停在确认处；确认后会自动继续。" } : {}) };
          }
          if (request.action === "cancel") {
            const result = await vcr.jobs.cancel(study.id, request.jobId, { actor: "runtime" });
            return { action: "cancel", jobId: request.jobId, state: result.job?.state ?? "canceled", canceled: result.canceled };
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
            ? (await vcr.store.allResults(study.id)).find((row) => row.executionId === String(execution.id)) ?? null
            : null;
          return {
            action: "status", jobId: job.id, state: job.state, progress: job.progress,
            cpuSeconds: job.cpuSecondsUsed, error: job.error, result,
          };
        };
      }

      /** @type {any} */
      let timer;
      const result = await Promise.race([
        work(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(gatewayError(504, "vcr_gateway_timeout", "The 虚拟临研 gateway timed out.")), budgetMs);
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
      });
    }
  };
}

export const VCR_GATEWAY_PATH = gatewayPath;
export const VCR_GATEWAY_OPERATIONS = operations;
export const VCR_GATEWAY_WINDOW_LIMITS = windowLimits;
