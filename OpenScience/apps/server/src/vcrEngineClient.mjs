/**
 * The `vcr-engine` channel (build contract 2026-09-28 §3.3, integration
 * contract 2026-09-29 §3.4–3.5): submit a frozen job, watch it, cancel it, read
 * its result, fetch the tables it wrote, discard its directory, ask what the
 * engine is.
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
 * - **A result is verified before it is believed, and the hash it is verified
 *   against is one this side computes.** The engine signs a receipt over three
 *   fields that identify the run — the job id, the scenario hash and the
 *   output hash — with the shared receipt key. Checking that signature against
 *   the `outputHash` the engine *wrote* proves only that the engine signed its
 *   own claim; a result whose numbers were changed after signing, or that never
 *   matched its hash, would still pass. So the output hash is recomputed here
 *   from the numbers themselves (`vcrResultOutputPayload`, the domain's
 *   canonical bytes) and both the written hash and the signature must agree
 *   with it. A result nobody signed is refused by name
 *   (`vcr_engine_receipt_invalid`) when a key is configured: these numbers end
 *   up in a submission.
 * - **A refusal is not a mismatch.** When the engine refuses a job it cannot
 *   identify (a malformed id or method) it has no identity to echo, no hash and
 *   no signature — and a `failed` result carries no numbers to trust. It comes
 *   back as `{ refused: true }` with the engine's own issue, so the job fails
 *   with the reason the engine gave instead of a validation complaint about the
 *   engine's answer.
 * - **The result echoes what it ran, and the control plane holds it against
 *   what was frozen** (`vcrResultEchoIssues`): method, method version, scenario
 *   hash, seed, replicate count. A result for another scenario under this
 *   job's id is not this job's answer (`vcr_engine_result_mismatch`).
 * - **The shape is checked by the domain, not here** (`validateEngineResult`):
 *   the control plane and the engine run the same validator, so a field
 *   neither side knows is refused by name rather than ignored.
 * - **Every call has one deadline that covers the whole exchange.** The timer
 *   is not cleared when the headers arrive: a body that stalls is aborted with
 *   the same signal, and the body is read as a stream that stops at a byte cap,
 *   so an engine that never stops talking costs a bounded read.
 * - Every failure carries a code the job queue classifies. A timeout is
 *   `vcr_engine_timeout` and is retryable; a 4xx that is not 408/429 is the
 *   job's own fault and is not; a 404 is the engine having lost the job
 *   (`vcr_engine_not_found`), which the queue answers by submitting it again.
 *
 * @module vcrEngineClient
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";

import { validateEngineJob, validateEngineResult, vcrResultOutputPayload } from "@evimed/domain";

/** The engine's routes, as the contract names them. */
export const VCR_ENGINE_ROUTES = Object.freeze({
  submit: "/jobs", status: "/jobs/:id", cancel: "/jobs/:id/cancel", result: "/jobs/:id/result",
  table: "/jobs/:id/tables/:name", discard: "/jobs/:id", health: "/health",
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
  "vcr_engine_result_mismatch",
  "vcr_engine_receipt_invalid",
  "vcr_engine_not_found",
  "vcr_engine_table_invalid",
]);

/** Failures that clear by waiting: the engine is busy, restarting or unreachable. */
export const VCR_ENGINE_RETRYABLE_CODES = Object.freeze(["vcr_engine_timeout", "vcr_engine_unreachable"]);

/** The largest answer a JSON call reads: a design grid's result is the big one. */
export const VCR_ENGINE_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
/** The largest table this side downloads unless the caller says otherwise. */
export const VCR_ENGINE_MAX_TABLE_BYTES = 256 * 1024 * 1024;

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
 * short and ordered so the engine's implementation can reproduce them without
 * a JSON canonicalizer.
 * @param {{ jobId: string, scenarioHash: string, outputHash?: string | null }} result
 */
export function vcrReceiptPayload(result) {
  return `${String(result.jobId ?? "")}\n${String(result.scenarioHash ?? "")}\n${String(result.outputHash ?? "")}`;
}

/** @param {string} key @param {{ jobId: string, scenarioHash: string, outputHash?: string | null }} result */
export function vcrReceiptSignature(key, result) {
  return createHmac("sha256", String(key)).update(vcrReceiptPayload(result)).digest("hex");
}

/** The sha256 of what a result says, from the domain's canonical bytes. @param {unknown} result */
export function vcrComputedOutputHash(result) {
  return createHash("sha256").update(vcrResultOutputPayload(result)).digest("hex");
}

/** @param {string} a @param {string} b */
function sameSecret(a, b) {
  const left = Buffer.from(String(a), "utf8");
  const right = Buffer.from(String(b), "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Verify a result's receipt. Answers `{ signed, ok, reason, outputHash }`:
 * `signed` says whether this deployment asks for one at all, `outputHash` is
 * the hash computed from the numbers.
 *
 * With no key the hash is still checked against what the engine wrote — a
 * result that disagrees with its own hash is damaged whoever signed it — and the
 * caller records `signed: false`.
 * @param {any} result @param {string} receiptKey
 */
export function verifyVcrReceipt(result, receiptKey) {
  const computed = vcrComputedOutputHash(result);
  const written = result?.manifest?.outputHash;
  if (written !== undefined && written !== null && !sameSecret(String(written), computed)) {
    return { signed: Boolean(receiptKey), ok: false, reason: "output_hash_mismatch", outputHash: computed };
  }
  if (!receiptKey) return { signed: false, ok: true, reason: "no_receipt_key", outputHash: computed };
  const signature = String(result?.manifest?.signature ?? "");
  if (!/^[a-f0-9]{64}$/.test(signature)) return { signed: true, ok: false, reason: "signature_missing", outputHash: computed };
  const expected = vcrReceiptSignature(receiptKey, {
    jobId: String(result?.jobId ?? ""), scenarioHash: String(result?.scenarioHash ?? ""), outputHash: computed,
  });
  const ok = sameSecret(signature, expected);
  return { signed: true, ok, reason: ok ? "ok" : "signature_mismatch", outputHash: computed };
}

/**
 * How a result differs from the job it answers: the fields an engine echoes
 * (`method`, `methodVersion`, `scenarioHash`, `seed`, `replicates`) held
 * against what was frozen.
 *
 * The replicate count is the one field that can legitimately differ: a run
 * stopped by a cancel or a spent CPU budget completed fewer, and a design grid
 * echoes the total over its cells. So it is compared only for a run that
 * finished cleanly on a method with one count, and for any other run it may be
 * lower than asked but never higher.
 * @param {{ method: string, methodVersion: string, scenarioHash: string, seed: number, replicates: number | null }} frozen
 * @param {any} result
 * @returns {string[]} the names of the fields that differ
 */
export function vcrResultEchoIssues(frozen, result) {
  /** @type {string[]} */
  const differ = [];
  if (String(result?.method) !== String(frozen.method)) differ.push("method");
  if (String(result?.methodVersion) !== String(frozen.methodVersion)) differ.push("methodVersion");
  if (String(result?.scenarioHash) !== String(frozen.scenarioHash)) differ.push("scenarioHash");
  if (Number(result?.seed) !== Number(frozen.seed)) differ.push("seed");
  const asked = frozen.replicates == null ? null : Number(frozen.replicates);
  const ran = result?.replicates == null ? null : Number(result.replicates);
  if (asked !== null && ran !== null && frozen.method !== "design.grid") {
    const clean = result?.status === "succeeded" && result?.conclusion !== "limited";
    if (clean ? ran !== asked : ran > asked) differ.push("replicates");
  }
  return differ;
}

/** @param {unknown} value */
const idShape = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,120}$/.test(value);
/** @param {unknown} value */
const tableNameShape = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$/.test(value) && !value.includes("..");

/**
 * Read a response body as a stream up to `limit` bytes. A double that answers
 * with no stream is read whole and checked afterwards.
 * @param {Response} response @param {number} limit @param {(chunk: Buffer) => void | Promise<void>} onChunk
 * @returns {Promise<number>} the bytes read
 */
async function readBody(response, limit, onChunk) {
  let total = 0;
  if (response.body && typeof /** @type {any} */ (response.body)[Symbol.asyncIterator] === "function") {
    for await (const chunk of /** @type {AsyncIterable<Uint8Array>} */ (/** @type {unknown} */ (response.body))) {
      total += chunk.byteLength;
      if (total > limit) throw new VcrEngineError("vcr_engine_response_invalid", "计算引擎的回答超过了客户端上限。", { status: response.status });
      await onChunk(Buffer.from(chunk));
    }
    return total;
  }
  const whole = Buffer.from(await response.arrayBuffer());
  if (whole.length > limit) throw new VcrEngineError("vcr_engine_response_invalid", "计算引擎的回答超过了客户端上限。", { status: response.status });
  await onChunk(whole);
  return whole.length;
}

/**
 * @param {{ baseUrl?: string, timeoutMs?: number, token?: (() => string | null) | string | null,
 *   receiptKey?: (() => string | null) | string | null, fetchImpl?: typeof fetch,
 *   maxResponseBytes?: number }} options
 */
export function createVcrEngineClient({ baseUrl = "", timeoutMs = 120_000, token = null, receiptKey = null, fetchImpl,
  maxResponseBytes = VCR_ENGINE_MAX_RESPONSE_BYTES } = {}) {
  const origin = String(baseUrl ?? "").trim().replace(/\/$/, "");
  const call = fetchImpl ?? globalThis.fetch;
  const secretOf = (/** @type {any} */ source) => {
    const value = typeof source === "function" ? source() : source;
    return value == null ? "" : String(value);
  };

  const configured = () => Boolean(origin) && typeof call === "function";

  const unavailable = () => new VcrEngineError("engine_unavailable",
    "计算引擎未接入本部署：需要它的那一步暂不可用，其余步骤照常。");

  /**
   * One exchange: the request, the status check and the body, all under one
   * deadline. `consume` reads the body of an OK answer; a refusal's body is
   * read (capped) for its error field only.
   * @template T
   * @param {string} path
   * @param {{ method?: string, body?: unknown, timeout?: number, accept?: string,
   *   consume: (response: Response, signal: AbortSignal) => Promise<T> }} options
   * @returns {Promise<T>}
   */
  async function exchange(path, { method = "GET", body, timeout = timeoutMs, accept = "application/json", consume }) {
    if (!configured()) throw unavailable();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1_000, timeout));
    timer.unref?.();
    try {
      let response;
      try {
        const authorization = secretOf(token);
        response = await call(`${origin}${path}`, {
          method,
          signal: controller.signal,
          headers: {
            accept,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
            ...(authorization ? { authorization: `Bearer ${authorization}` } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch (error) {
        throw transport(error, controller.signal);
      }
      if (!response.ok) {
        /** @type {unknown} */
        let detail = null;
        try {
          const chunks = /** @type {Buffer[]} */ ([]);
          await readBody(response, 64 * 1024, (chunk) => { chunks.push(chunk); });
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          detail = parsed && typeof parsed === "object" ? parsed.detail ?? parsed.error ?? null : null;
        } catch { detail = null; }
        if (response.status === 404) throw new VcrEngineError("vcr_engine_not_found", "计算引擎不认识这个作业。", { status: 404, detail });
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        throw new VcrEngineError(retryable ? "vcr_engine_unreachable" : "vcr_engine_rejected",
          `计算引擎拒绝了这次调用（HTTP ${response.status}）。`, { status: response.status, detail });
      }
      try {
        return await consume(response, controller.signal);
      } catch (error) {
        throw error instanceof VcrEngineError ? error : transport(error, controller.signal);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /** @param {unknown} error @param {AbortSignal} signal */
  function transport(error, signal) {
    if (error instanceof VcrEngineError) return error;
    const aborted = signal.aborted || /** @type {any} */ (error)?.name === "AbortError";
    return new VcrEngineError(aborted ? "vcr_engine_timeout" : "vcr_engine_unreachable",
      aborted ? "计算引擎在超时前没有回答。" : "计算引擎连不上。");
  }

  /** The body as one JSON object, or a named refusal. @param {Response} response */
  async function jsonObject(response) {
    /** @type {Buffer[]} */
    const chunks = [];
    await readBody(response, maxResponseBytes, (chunk) => { chunks.push(chunk); });
    let parsed;
    try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { parsed = undefined; }
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
      if (!configured()) throw unavailable();
      const issues = validateEngineJob(job);
      if (issues.length) {
        throw new VcrEngineError("vcr_engine_job_invalid",
          `作业不符合引擎协议：${issues.map((issue) => `${issue.field || issue.code}`).join("、")}。`, { detail: issues });
      }
      const answer = await exchange(VCR_ENGINE_ROUTES.submit, {
        method: "POST", body: job, timeout: Math.min(timeoutMs, 30_000), consume: (response) => jsonObject(response),
      });
      if (answer.accepted !== true || !idShape(answer.jobId)) {
        throw new VcrEngineError("vcr_engine_response_invalid", "计算引擎没有确认接收这个作业。", { detail: answer });
      }
      return { jobId: String(answer.jobId), accepted: true };
    },

    /** @param {string} jobId */
    async status(jobId) {
      if (!idShape(jobId)) throw new VcrEngineError("vcr_engine_job_invalid", "作业号不合法。");
      const answer = await exchange(`/jobs/${encodeURIComponent(jobId)}`, {
        timeout: Math.min(timeoutMs, 30_000), consume: (response) => jsonObject(response),
      });
      const progress = answer.progress && typeof answer.progress === "object" ? answer.progress : {};
      return {
        jobId: String(answer.jobId ?? jobId),
        state: String(answer.state ?? "running"),
        progress: { done: Number(progress.done ?? 0), total: Number(progress.total ?? 0) },
        cpuSeconds: Number.isFinite(Number(answer.cpuSeconds)) ? Number(answer.cpuSeconds) : null,
        error: typeof answer.error === "string" ? answer.error : null,
      };
    },

    /** @param {string} jobId */
    async cancel(jobId) {
      if (!idShape(jobId)) throw new VcrEngineError("vcr_engine_job_invalid", "作业号不合法。");
      const answer = await exchange(`/jobs/${encodeURIComponent(jobId)}/cancel`, {
        method: "POST", body: {}, timeout: Math.min(timeoutMs, 15_000), consume: (response) => jsonObject(response),
      });
      return { canceled: answer.canceled === true };
    },

    /**
     * Discard a job's directory on the engine's work volume. A job the engine
     * does not know is discarded already.
     * @param {string} jobId
     */
    async deleteJob(jobId) {
      if (!idShape(jobId)) throw new VcrEngineError("vcr_engine_job_invalid", "作业号不合法。");
      try {
        await exchange(`/jobs/${encodeURIComponent(jobId)}`, {
          method: "DELETE", timeout: Math.min(timeoutMs, 30_000), consume: (response) => jsonObject(response),
        });
      } catch (error) {
        if (/** @type {any} */ (error)?.code !== "vcr_engine_not_found") throw error;
      }
      return { discarded: true };
    },

    /**
     * The finished result, shape-checked by the domain, held against the job it
     * answers and receipt-checked here. The caller gets `{ result, signed }` and
     * records both — or `{ result, refused: true }` for an engine refusal that
     * carries no numbers, which is a failure with the engine's own reason.
     *
     * @param {string} jobId
     * @param {{ expected?: { method: string, methodVersion: string, scenarioHash: string, seed: number, replicates: number | null } }} [options]
     */
    async result(jobId, { expected } = {}) {
      if (!idShape(jobId)) throw new VcrEngineError("vcr_engine_job_invalid", "作业号不合法。");
      const answer = await exchange(`/jobs/${encodeURIComponent(jobId)}/result`, { consume: (response) => jsonObject(response) });
      if (String(answer.jobId) !== String(jobId)) {
        throw new VcrEngineError("vcr_engine_result_invalid", "引擎回的是另一个作业的结果。", { detail: { jobId: answer.jobId } });
      }
      const issues = validateEngineResult(answer);
      const measures = Array.isArray(answer.measures) ? answer.measures : [];
      const finished = answer.status === "succeeded" || answer.status === "not_estimable";
      if (issues.length) {
        // A failure the engine could not even describe in protocol terms: it
        // recorded nothing, so there is nothing to trust or to refuse but the
        // reason it gives.
        if (answer.status === "failed" && !measures.length) return { result: /** @type {Record<string, any>} */ (answer), signed: false, refused: true, issues };
        throw new VcrEngineError("vcr_engine_result_invalid",
          `引擎结果不符合协议：${issues.slice(0, 6).map((issue) => issue.field || issue.code).join("、")}。`, { detail: issues });
      }
      // A refusal with no numbers and no hash is unsigned by construction.
      if (!finished && !measures.length && !answer.manifest?.signature && answer.manifest?.outputHash == null) {
        return { result: /** @type {Record<string, any>} */ (answer), signed: false, refused: true, issues: [] };
      }
      if (expected) {
        const differ = vcrResultEchoIssues(expected, answer);
        if (differ.length) {
          throw new VcrEngineError("vcr_engine_result_mismatch",
            `引擎返回的结果和提交的作业对不上：${differ.join("、")}。`, { detail: { fields: differ } });
        }
      }
      const receipt = verifyVcrReceipt(answer, secretOf(receiptKey));
      if (!receipt.ok) {
        throw new VcrEngineError("vcr_engine_receipt_invalid",
          "引擎回执的签名核对不通过：这份结果不予采信。", { detail: { reason: receipt.reason } });
      }
      return { result: /** @type {Record<string, any>} */ (answer), signed: receipt.signed, refused: false, outputHash: receipt.outputHash };
    },

    /**
     * Download one table a finished result lists, into `destination`, checking
     * the sha256 the result carries while the bytes stream in. The file is
     * written under a temporary name and renamed only when the hash agrees, so
     * a torn or substituted download never sits at a name something reads.
     *
     * @param {string} jobId @param {string} name
     * @param {{ destination: string, sha256: string, maxBytes?: number }} options
     * @returns {Promise<{ bytes: number, sha256: string }>}
     */
    async downloadTable(jobId, name, { destination, sha256, maxBytes = VCR_ENGINE_MAX_TABLE_BYTES }) {
      if (!idShape(jobId) || !tableNameShape(name)) throw new VcrEngineError("vcr_engine_job_invalid", "作业号或表名不合法。");
      if (!/^[a-f0-9]{64}$/.test(String(sha256))) throw new VcrEngineError("vcr_engine_table_invalid", "结果没有给出这张表的 sha256。");
      const temporary = `${destination}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.part`;
      const hash = createHash("sha256");
      const handle = await fs.open(temporary, "wx", 0o600);
      try {
        const bytes = await exchange(`/jobs/${encodeURIComponent(jobId)}/tables/${encodeURIComponent(name)}`, {
          accept: "text/csv", timeout: Math.max(timeoutMs, 300_000),
          consume: (response) => readBody(response, maxBytes, async (chunk) => {
            hash.update(chunk);
            await handle.write(chunk);
          }),
        });
        await handle.close();
        const got = hash.digest("hex");
        if (got !== sha256) {
          throw new VcrEngineError("vcr_engine_table_invalid", "引擎给出的表和结果里登记的哈希对不上，这张表没有采用。", { detail: { table: name } });
        }
        await fs.rename(temporary, destination);
        return { bytes, sha256: got };
      } catch (error) {
        await handle.close().catch(() => {});
        await fs.rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
    },

    /** What this engine is, for readiness and for the method catalogue. */
    async health() {
      const answer = await exchange(VCR_ENGINE_ROUTES.health, { timeout: Math.min(timeoutMs, 10_000), consume: (response) => jsonObject(response) });
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
