// A specialist engine's model spend, reported by the service that ran the job.
//
// The six engines call the model provider themselves, from their own
// containers, and until now nothing of what they spent reached
// `evimed_usage.model_requests`: a meta-analysis's hours of extraction were
// invisible next to the kernel's calls. The runtime talks to an engine's
// adapter directly, so the control plane never sees a job finish; the adapter
// does, and reports once per job attempt, here. One settled ledger row per
// report, purpose `engine`, priced by the reference price list — observability
// for us, not a charge: the flat per-job prices in `metering.mjs` are untouched.
//
// Authenticated by an HMAC under a key derived from the workload signing
// secret, which the control plane, the adapters and the MetaAgent service hold
// and a runtime never does (it holds only tokens signed with it). The derivation
// label keeps a report signature from ever verifying as a workload token or the
// other way round. The Python signers mirror `engineUsageSignature` exactly
// (deploy/specialist-adapter/evimed_specialist_adapter/usage_report.py,
// 项目代码/meta/new_meta/evimed_usage_report.py); one pinned vector in all three
// test suites keeps them in step.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { isPeak, priceUsage, REFERENCE_PRICE_LIST } from "@evimed/domain";
import { HttpError, readBody, sendError, sendJson } from "./security.mjs";

export const ENGINE_USAGE_PATH = "/internal/usage/v1/engine";

/** The engines that report, by the kind their adapter serves. Closed: a kind
 *  is a column an operator groups by, and a free string would split one engine
 *  across spellings. */
export const ENGINE_KINDS = Object.freeze([
  "meta-analysis",
  "mendelian-randomization",
  "bibliometric-analysis",
  "research-topic-selection",
  "peer-review",
  "drug-safety-analysis",
]);

export const ENGINE_USAGE_SIGNATURE_HEADER = "x-evimed-engine-usage-signature";
const KEY_DOMAIN = "evimed/engine-usage/key/v1";
const MAX_REPORT_BYTES = 8 * 1024;
const MAX_TOKENS = 1e12;

/** The signature a specialist service puts on a usage report.
 *  @param {string} secret the workload signing secret @param {Buffer | string} body
 *  @returns {string} lowercase hex */
export function engineUsageSignature(secret, body) {
  const key = createHmac("sha256", String(secret)).update(KEY_DOMAIN).digest();
  return createHmac("sha256", key).update(body).digest("hex");
}

/** @param {unknown} value @param {string} field */
function count(value, field) {
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < 0 || /** @type {number} */ (value) > MAX_TOKENS) {
    throw new HttpError(400, "engine_usage_invalid", `${field} must be a non-negative whole number.`);
  }
  return /** @type {number} */ (value);
}

/**
 * The report, or a refusal naming the field. What an adapter sends is checked
 * like any other input at the boundary: signed does not mean well-formed.
 * @param {Buffer} raw @param {Date} now
 */
export function parseEngineUsageReport(raw, now) {
  let report;
  try { report = JSON.parse(raw.toString("utf8")); } catch { report = null; }
  if (!report || typeof report !== "object" || Array.isArray(report) || report.v !== 1) {
    throw new HttpError(400, "engine_usage_invalid", "The report must be a version 1 JSON object.");
  }
  if (!ENGINE_KINDS.includes(report.kind)) throw new HttpError(400, "engine_usage_invalid", "Unknown engine kind.");
  if (typeof report.jobId !== "string" || !/^[a-z][a-z0-9-]{7,100}$/.test(report.jobId)) {
    throw new HttpError(400, "engine_usage_invalid", "Invalid job id.");
  }
  const attempt = report.attempt ?? 1;
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > 100) throw new HttpError(400, "engine_usage_invalid", "Invalid attempt.");
  for (const field of ["userId", "projectId"]) {
    if (typeof report[field] !== "string" || !report[field] || report[field].length > 200
      || [...report[field]].some((char) => char.charCodeAt(0) < 32)) {
      throw new HttpError(400, "engine_usage_invalid", `Invalid ${field}.`);
    }
  }
  if (!["succeeded", "failed"].includes(report.status)) throw new HttpError(400, "engine_usage_invalid", "Invalid job status.");
  const finishedAt = new Date(typeof report.finishedAt === "string" ? report.finishedAt : NaN);
  // A report is sent when a job ends, so a finish more than a month back or in
  // the future is a clock or a replay, not a job.
  if (!Number.isFinite(finishedAt.getTime()) || finishedAt.getTime() > now.getTime() + 5 * 60_000
    || finishedAt.getTime() < now.getTime() - 30 * 24 * 60 * 60_000) {
    throw new HttpError(400, "engine_usage_invalid", "Invalid finish time.");
  }
  const usage = report.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) throw new HttpError(400, "engine_usage_invalid", "Missing usage.");
  const model = typeof usage.model === "string" ? usage.model : "";
  if (!/^[A-Za-z0-9._:-]{1,100}$/.test(model) && !(model === "" && usage.requests === 0)) {
    throw new HttpError(400, "engine_usage_invalid", "Invalid model.");
  }
  return {
    kind: report.kind, jobId: report.jobId, attempt, userId: report.userId, projectId: report.projectId,
    status: report.status, finishedAt,
    usage: {
      requests: count(usage.requests, "usage.requests"),
      cacheHitTokens: count(usage.cacheHitTokens, "usage.cacheHitTokens"),
      cacheMissTokens: count(usage.cacheMissTokens, "usage.cacheMissTokens"),
      outputTokens: count(usage.outputTokens, "usage.outputTokens"),
      model,
    },
  };
}

/**
 * @param {{ config: Record<string, any>, usageLedger: any,
 *   attributeRun?: ((owner: { userId: string, projectId: string }) => Promise<string | null>) | null,
 *   now?: () => Date }} dependencies
 */
export function createEngineUsageHandler({ config, usageLedger, attributeRun = null, now = () => new Date() }) {
  /** @param {any} req @param {any} res @param {(failure: any) => void} [onFailure] */
  return async (req, res, onFailure) => {
    try {
      if (req.method !== "POST" || new URL(req.url ?? "/", "http://evimed.local").pathname !== ENGINE_USAGE_PATH) {
        throw new HttpError(404, "not_found", "Engine usage operation not found.");
      }
      const secret = String(config.evimedWorkloadSigningSecret ?? "");
      if (secret.length < 32) throw new HttpError(503, "engine_usage_unconfigured", "Engine usage reports cannot be verified here.");
      if (!usageLedger) throw new HttpError(503, "usage_ledger_unavailable", "Durable usage accounting is unavailable.");
      if (String(req.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase() !== "application/json") {
        throw new HttpError(415, "engine_usage_content_type_invalid", "Content-Type must be application/json.");
      }
      const raw = await readBody(req, MAX_REPORT_BYTES);
      const supplied = /^v1=([0-9a-f]{64})$/.exec(String(req.headers[ENGINE_USAGE_SIGNATURE_HEADER] ?? ""))?.[1];
      const expected = Buffer.from(engineUsageSignature(secret, raw), "hex");
      if (!supplied || !timingSafeEqual(Buffer.from(supplied, "hex"), expected)) {
        throw new HttpError(401, "engine_usage_signature_invalid", "The usage report is not signed by a specialist service.");
      }
      const report = parseEngineUsageReport(raw, now());
      // A job that never reached the model cost nothing, and a row of zeros
      // would read as a call that was made.
      if (report.usage.requests === 0) {
        sendJson(res, 200, { data: { recorded: false } });
        return;
      }
      // The run in the project when the job ended, when exactly one is going:
      // the one polling the job, in the ordinary case. Two at once, or none
      // (the run gave up waiting), stay unattributed rather than guessed.
      const runId = attributeRun
        ? await attributeRun({ userId: report.userId, projectId: report.projectId }).catch(() => null)
        : null;
      // Priced at the rate of the job's finishing instant. A job straddling a
      // peak boundary is priced whole at its end's rate — this row reads what
      // an engine cost us, it never charges anyone.
      const price = priceUsage({
        resourceType: "model", model: report.usage.model, cacheHit: report.usage.cacheHitTokens,
        cacheMiss: report.usage.cacheMissTokens, output: report.usage.outputTokens, peak: isPeak(report.finishedAt),
      });
      const identity = `${report.kind}:${report.jobId}#${report.attempt}`;
      let row;
      try {
        row = await usageLedger.recordSettled({
          id: `engine_${createHash("sha256").update(`${report.userId}\u0000${report.projectId}\u0000${identity}`).digest("hex").slice(0, 40)}`,
          userId: report.userId, projectId: report.projectId, runId, purpose: "engine",
          model: report.usage.model, priceVersion: REFERENCE_PRICE_LIST.version, currency: price.currency || "CNY",
          requestFingerprint: createHash("sha256").update(raw).digest("hex"),
          usage: {
            cacheHitTokens: report.usage.cacheHitTokens,
            cacheMissTokens: report.usage.cacheMissTokens,
            completionTokens: report.usage.outputTokens,
          },
          actualCost: price.cost, priced: price.priced, providerRequestId: identity, now: report.finishedAt,
        });
      } catch (error) {
        // The account or project is gone: nothing can ever record this, so the
        // adapter is told not to retry rather than to try again later.
        if (/** @type {any} */ (error)?.code === "23503") {
          throw new HttpError(404, "engine_usage_owner_unknown", "The job's account or project no longer exists.");
        }
        throw error;
      }
      sendJson(res, 200, { data: { recorded: true, id: row.id, runId: row.runId, costCny: row.actualCost, priced: row.priced } });
    } catch (error) {
      const safe = error instanceof HttpError ? error : new HttpError(503, "engine_usage_unavailable", "The usage report could not be recorded.");
      onFailure?.({ code: safe.code, status: safe.status });
      sendError(res, safe);
    }
  };
}
