/**
 * The `vcr-engine` channel (build contract 2026-09-28 §3.3): submit a frozen
 * job, watch it, cancel it, read its result, ask what the engine is.
 *
 * Hidden knowledge:
 *
 * - **Not composed is a named answer, not a crash** (plan §10.5). With
 *   `OPEN_SCIENCE_VCR_ENGINE_URL` unset every call answers `engine_unavailable`
 *   with a sentence a reader can act on, and only the step that needed the
 *   engine reports 「暂不可用」 — the conversation and every other step carry on.
 * - **The workload token is the engine's only credential**, sent as
 *   `Authorization: Bearer`. It is a function, not a string, because the
 *   deployment may rotate it under a long-running worker; a call reads it at
 *   the moment it makes the request.
 * - **A result is verified before it is believed.** The engine signs a receipt
 *   over three fields that identify the run — the job id, the scenario hash
 *   and the output hash — with the shared receipt key, and this client checks
 *   it in constant time before handing the result on. An unsigned result from
 *   a deployment that configured a key is refused by name
 *   (`vcr_engine_receipt_invalid`): a result nobody signed is a result anyone
 *   on the path could have written, and these numbers end up in a submission.
 *   A deployment with no key configured gets `signed: false` on the result and
 *   the caller records that rather than pretending otherwise.
 * - **The shape is checked by the domain, not here** (`validateEngineResult`):
 *   the control plane and the engine run the same validator, so a field
 *   neither side knows is refused by name rather than ignored.
 * - Every call has a deadline and every failure carries a code the job queue
 *   classifies. A timeout is `vcr_engine_timeout` and is retryable; a 4xx that
 *   is not 408/429 is the job's own fault and is not.
 *
 * @module vcrEngineClient
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { validateEngineJob, validateEngineResult } from "@evimed/domain";

/** The engine's five routes, as the contract names them. */
export const VCR_ENGINE_ROUTES = Object.freeze({
  submit: "/jobs", status: "/jobs/:id", cancel: "/jobs/:id/cancel", result: "/jobs/:id/result", health: "/health",
});

/** Codes this client answers with. The job queue classifies each one. */
export const VCR_ENGINE_ERROR_CODES = Object.freeze([
  "engine_unavailable",
  "vcr_engine_job_invalid",
  "vcr_engine_rejected",
  "vcr_engine_timeout",
  "vcr_engine_unreachable",
  "vcr_engine_response_invalid",
  "vcr_engine_result_invalid",
  "vcr_engine_receipt_invalid",
  "vcr_engine_not_found",
]);

/** Failures that clear by waiting: the engine is busy, restarting or unreachable. */
export const VCR_ENGINE_RETRYABLE_CODES = Object.freeze(["vcr_engine_timeout", "vcr_engine_unreachable"]);

const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

export class VcrEngineError extends Error {
  /** @param {string} code @param {string} message @param {{ status?: number, detail?: unknown }} [extra] */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "VcrEngineError";
    this.code = code;
    this.status = extra.status ?? 0;
    this.detail = extra.detail ?? null;
    this.retryable = VCR_ENGINE_RETRYABLE_CODES.includes(code);
  }
}

/**
 * The bytes a receipt signs: the three fields that identify one run. Kept
 * short and ordered so the engine's R implementation can reproduce them
 * without a JSON canonicalizer.
 * @param {{ jobId: string, scenarioHash: string, outputHash?: string | null }} result
 */
export function vcrReceiptPayload(result) {
  return `${String(result.jobId ?? "")}\n${String(result.scenarioHash ?? "")}\n${String(result.outputHash ?? "")}`;
}

/** @param {string} key @param {{ jobId: string, scenarioHash: string, outputHash?: string | null }} result */
export function vcrReceiptSignature(key, result) {
  return createHmac("sha256", String(key)).update(vcrReceiptPayload(result)).digest("hex");
}

/** @param {string} a @param {string} b */
function sameSecret(a, b) {
  const left = Buffer.from(String(a), "utf8");
  const right = Buffer.from(String(b), "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Verify a result's receipt. Answers `{ signed, ok, reason }`: `signed` says
 * whether this deployment asks for one at all.
 * @param {any} result @param {string} receiptKey
 */
export function verifyVcrReceipt(result, receiptKey) {
  if (!receiptKey) return { signed: false, ok: true, reason: "no_receipt_key" };
  const signature = String(result?.manifest?.signature ?? "");
  if (!/^[a-f0-9]{64}$/.test(signature)) return { signed: true, ok: false, reason: "signature_missing" };
  const expected = vcrReceiptSignature(receiptKey, {
    jobId: String(result?.jobId ?? ""),
    scenarioHash: String(result?.scenarioHash ?? ""),
    outputHash: result?.manifest?.outputHash ?? null,
  });
  return { signed: true, ok: sameSecret(signature, expected), reason: sameSecret(signature, expected) ? "ok" : "signature_mismatch" };
}

/** @param {unknown} value */
const idShape = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,120}$/.test(value);

/**
 * @param {{ baseUrl?: string, timeoutMs?: number, token?: (() => string | null) | string | null,
 *   receiptKey?: (() => string | null) | string | null, fetchImpl?: typeof fetch }} options
 */
export function createVcrEngineClient({ baseUrl = "", timeoutMs = 120_000, token = null, receiptKey = null, fetchImpl } = {}) {
  const origin = String(baseUrl ?? "").trim().replace(/\/$/, "");
  const call = fetchImpl ?? globalThis.fetch;
  const secretOf = (/** @type {any} */ source) => {
    const value = typeof source === "function" ? source() : source;
    return value == null ? "" : String(value);
  };

  const configured = () => Boolean(origin) && typeof call === "function";

  /** @param {string} path @param {{ method?: string, body?: unknown, timeout?: number }} [options] */
  async function request(path, { method = "GET", body, timeout = timeoutMs } = {}) {
    if (!configured()) {
      throw new VcrEngineError("engine_unavailable",
        "计算引擎未接入本部署：需要它的那一步暂不可用，其余步骤照常。");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1_000, timeout));
    timer.unref?.();
    let response;
    try {
      const authorization = secretOf(token);
      response = await call(`${origin}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(authorization ? { authorization: `Bearer ${authorization}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      const aborted = /** @type {any} */ (error)?.name === "AbortError";
      throw new VcrEngineError(aborted ? "vcr_engine_timeout" : "vcr_engine_unreachable",
        aborted ? "计算引擎在超时前没有回答。" : "计算引擎连不上。");
    } finally {
      clearTimeout(timer);
    }
    const raw = await response.text().catch(() => "");
    if (raw.length > MAX_RESPONSE_BYTES) {
      throw new VcrEngineError("vcr_engine_response_invalid", "计算引擎的回答超过了客户端上限。");
    }
    let parsed = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = undefined; }
    if (!response.ok) {
      if (response.status === 404) throw new VcrEngineError("vcr_engine_not_found", "计算引擎不认识这个作业。", { status: 404 });
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      throw new VcrEngineError(retryable ? "vcr_engine_unreachable" : "vcr_engine_rejected",
        `计算引擎拒绝了这次调用（HTTP ${response.status}）。`,
        { status: response.status, detail: parsed && typeof parsed === "object" ? /** @type {any} */ (parsed).error ?? null : null });
    }
    if (parsed === undefined || parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new VcrEngineError("vcr_engine_response_invalid", "计算引擎的回答不是一个 JSON 对象。", { status: response.status });
    }
    return /** @type {Record<string, any>} */ (parsed);
  }

  return {
    /** Whether the engine is composed at all. Read by readiness and by the steps that need it. */
    configured,
    baseUrl: origin,

    /**
     * Hand the engine a frozen job. The domain validates it first: a job the
     * engine would refuse is refused here, with the field named, so the
     * refusal reaches the study rather than a log.
     * @param {Record<string, any>} job
     */
    async submit(job) {
      // Not composed is answered before the job is looked at: a deployment
      // without an engine says so whatever the job holds, so the step that
      // needed it reports 「暂不可用」 rather than a validation complaint about
      // a job nothing was ever going to run (plan §10.5).
      if (!configured()) {
        throw new VcrEngineError("engine_unavailable", "计算引擎未接入本部署：需要它的那一步暂不可用，其余步骤照常。");
      }
      const issues = validateEngineJob(job);
      if (issues.length) {
        throw new VcrEngineError("vcr_engine_job_invalid",
          `作业不符合引擎协议：${issues.map((issue) => `${issue.field || issue.code}`).join("、")}。`, { detail: issues });
      }
      const answer = await request(VCR_ENGINE_ROUTES.submit, { method: "POST", body: job, timeout: Math.min(timeoutMs, 30_000) });
      if (answer.accepted !== true || !idShape(answer.jobId)) {
        throw new VcrEngineError("vcr_engine_response_invalid", "计算引擎没有确认接收这个作业。", { detail: answer });
      }
      return { jobId: String(answer.jobId), accepted: true };
    },

    /** @param {string} jobId */
    async status(jobId) {
      if (!idShape(jobId)) throw new VcrEngineError("vcr_engine_job_invalid", "作业号不合法。");
      const answer = await request(`/jobs/${encodeURIComponent(jobId)}`, { timeout: Math.min(timeoutMs, 30_000) });
      const progress = answer.progress && typeof answer.progress === "object" ? answer.progress : {};
      return {
        jobId: String(answer.jobId ?? jobId),
        state: String(answer.state ?? "running"),
        progress: { done: Number(progress.done ?? 0), total: Number(progress.total ?? 0) },
        cpuSeconds: Number.isFinite(Number(answer.cpuSeconds)) ? Number(answer.cpuSeconds) : null,
      };
    },

    /** @param {string} jobId */
    async cancel(jobId) {
      if (!idShape(jobId)) throw new VcrEngineError("vcr_engine_job_invalid", "作业号不合法。");
      const answer = await request(`/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST", body: {}, timeout: Math.min(timeoutMs, 15_000) });
      return { canceled: answer.canceled === true };
    },

    /**
     * The finished result, shape-checked by the domain and receipt-checked
     * here. The caller gets `{ result, signed }` and records both.
     * @param {string} jobId
     */
    async result(jobId) {
      if (!idShape(jobId)) throw new VcrEngineError("vcr_engine_job_invalid", "作业号不合法。");
      const answer = await request(`/jobs/${encodeURIComponent(jobId)}/result`);
      const issues = validateEngineResult(answer);
      if (issues.length) {
        throw new VcrEngineError("vcr_engine_result_invalid",
          `引擎结果不符合协议：${issues.slice(0, 6).map((issue) => issue.field || issue.code).join("、")}。`, { detail: issues });
      }
      if (String(answer.jobId) !== String(jobId)) {
        throw new VcrEngineError("vcr_engine_result_invalid", "引擎回的是另一个作业的结果。", { detail: { jobId: answer.jobId } });
      }
      const receipt = verifyVcrReceipt(answer, secretOf(receiptKey));
      if (!receipt.ok) {
        throw new VcrEngineError("vcr_engine_receipt_invalid",
          "引擎回执的签名核对不通过：这份结果不予采信。", { detail: { reason: receipt.reason } });
      }
      return { result: /** @type {Record<string, any>} */ (answer), signed: receipt.signed };
    },

    /** What this engine is, for readiness and for the method catalogue. */
    async health() {
      const answer = await request(VCR_ENGINE_ROUTES.health, { timeout: Math.min(timeoutMs, 10_000) });
      return {
        ok: answer.ok === true,
        engineVersion: String(answer.engineVersion ?? ""),
        rVersion: String(answer.rVersion ?? ""),
        methods: Array.isArray(answer.methods) ? answer.methods.map(String) : [],
        packageLockHash: String(answer.packageLockHash ?? ""),
      };
    },
  };
}
