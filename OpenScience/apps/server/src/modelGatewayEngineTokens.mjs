// A specialist engine job's credential for the model gateway.
//
// The engines used to call DeepSeek from their own containers with the
// deployment's key: nothing was reserved before a call, the spend reached the
// usage ledger only as one after-the-fact row per job (engineUsage.mjs), and
// the account's caps and a bounded run's budget never applied to it. With
// `OPEN_SCIENCE_ENGINE_MODEL_GATEWAY_ENABLED` on, an adapter admitting a job
// asks here for a credential for that one job, hands it to the engine process
// as its API key, and the engine's calls go through `/internal/model/v1` like
// the kernel's: reserved, settled from the provider's own counts, on the
// certified model, under the owner's caps, attributed to the run that started
// the job.
//
// Two proofs are required to mint one, because either alone is not enough. The
// bearer is the runtime's own workload token, the one the runtime handed the
// adapter with the job: it names the account and project and proves a runtime
// of theirs is live now. But a runtime can print that token, and could then
// mint itself credentials that outlive it; so the body must also carry an HMAC
// under a key derived from the workload signing secret, which the control
// plane and the specialist services hold and a runtime never does (the same
// construction as engineUsage.mjs, under its own derivation label). The Python
// signer is `engine_model.py` in the specialist adapter; one pinned vector in
// both suites keeps them in step.
//
// The credential is stateless on purpose: an engine job runs for tens of
// minutes to hours and must survive a control-plane restart or release, which
// empties the gateway's registry of live runtime tokens. It is bounded instead
// by its expiry (`OPEN_SCIENCE_ENGINE_MODEL_TOKEN_TTL_SECONDS`), by the lever
// (off, the gateway refuses every engine credential at once), and by the
// same spend caps as every other call. Build to delete: an engine that could
// hold a per-call token the way the kernel does would need none of this.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { executionContext, reasoningEffort as validateReasoningEffort } from "./modelReasoningPolicy.mjs";
import { ENGINE_KINDS } from "./engineUsage.mjs";
import { HttpError, readBody, sendError, sendJson } from "./security.mjs";

export const ENGINE_MODEL_TOKEN_PATH = "/internal/engines/v1/model-token";
export const ENGINE_MODEL_SIGNATURE_HEADER = "x-evimed-engine-signature";
export const ENGINE_MODEL_AUDIENCE = "evimed-engine-model";
const KEY_DOMAIN = "evimed/engine-model-token/key/v1";
const MAX_REQUEST_BYTES = 4 * 1024;
const JOB_ID = /^[a-z][a-z0-9-]{7,100}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const OWNER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const MIN_TTL_SECONDS = 300;
const MAX_TTL_SECONDS = 24 * 60 * 60;

/** The signature a specialist service puts on a token request.
 *  @param {string} secret the workload signing secret @param {Buffer | string} body
 *  @returns {string} lowercase hex */
export function engineModelRequestSignature(secret, body) {
  const key = createHmac("sha256", String(secret)).update(KEY_DOMAIN).digest();
  return createHmac("sha256", key).update(body).digest("hex");
}

/** @param {unknown} secret */
function gatewaySecret(secret) {
  if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32 || secret !== secret.trim() || /[\r\n\0]/.test(secret)) {
    throw new HttpError(503, "engine_model_gateway_unconfigured", "The model gateway cannot issue engine credentials here.");
  }
  return secret;
}

/** @param {string} signed @param {string} secret */
function tokenSignature(signed, secret) {
  return createHmac("sha256", secret).update(signed).digest("base64url");
}

/**
 * One engine job's model credential.
 * @param {{ secret: string, userId: string, projectId: string, kind: string, jobId: string,
 *   runId?: string | null, sessionId?: string, reasoningEffort?: string, limits?: { dailyLimit?: number, weeklyLimit?: number, runLimit?: number } | null,
 *   ttlSeconds: number, nowSeconds?: number, jti?: string }} input
 */
export function issueEngineModelToken({
  secret, userId, projectId, kind, jobId, runId = null, sessionId, reasoningEffort, limits = null, ttlSeconds,
  nowSeconds = Math.floor(Date.now() / 1000), jti = `emt_${randomBytes(16).toString("hex")}`,
}) {
  const key = gatewaySecret(secret);
  const ttl = Math.floor(Number(ttlSeconds));
  if (!Number.isSafeInteger(ttl) || ttl < MIN_TTL_SECONDS || ttl > MAX_TTL_SECONDS) {
    throw new HttpError(500, "engine_model_token_ttl_invalid", "The engine credential lifetime is invalid.");
  }
  if (!OWNER_ID.test(String(userId)) || !OWNER_ID.test(String(projectId)) || !ENGINE_KINDS.includes(kind)
    || !JOB_ID.test(String(jobId)) || (runId != null && !RUN_ID.test(String(runId)))) {
    throw new HttpError(400, "engine_model_token_scope_invalid", "The engine credential scope is invalid.");
  }
  if ((reasoningEffort !== undefined && !["off", "low", "high", "max"].includes(reasoningEffort))
    || (sessionId !== undefined && (typeof sessionId !== "string" || !RUN_ID.test(sessionId)))) {
    throw new HttpError(400, "engine_model_token_scope_invalid", "The engine model policy is invalid.");
  }
  const payload = {
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    v: 1, aud: ENGINE_MODEL_AUDIENCE, userId, projectId, kind, jobId,
    ...(runId != null ? { runId } : {}),
    // A bounded run's own caps travel with its jobs; unset, the gateway
    // applies the deployment's per-account caps, as it does for the kernel.
    ...Object.fromEntries(["dailyLimit", "weeklyLimit", "runLimit"]
      .filter((field) => Number(limits?.[field]) > 0)
      .map((field) => [field, Number(limits?.[field])])),
    iat: nowSeconds, exp: nowSeconds + ttl, jti,
  };
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signed = `${header}.${body}`;
  return { token: `${signed}.${tokenSignature(signed, key)}`, payload };
}

const allowedClaims = new Set(["v", "aud", "userId", "projectId", "kind", "jobId", "runId", "sessionId", "reasoningEffort", "dailyLimit", "weeklyLimit", "runLimit", "iat", "exp", "jti"]);

/**
 * The caller an engine credential stands for, or a throw. Never a partial
 * answer: a claim this version does not write is a token this version did
 * not issue.
 * @param {unknown} token @param {{ secret: unknown, nowSeconds?: number }} options
 */
export function verifyEngineModelToken(token, { secret, nowSeconds = Math.floor(Date.now() / 1000) }) {
  const invalid = () => new HttpError(401, "model_gateway_token_invalid", "Model gateway authentication failed.");
  let key;
  try { key = gatewaySecret(secret); } catch { throw invalid(); }
  if (typeof token !== "string" || token.length > 8 * 1024) throw invalid();
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) throw invalid();
  const expected = Buffer.from(tokenSignature(`${parts[0]}.${parts[1]}`, key));
  const actual = Buffer.from(parts[2]);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw invalid();
  let header;
  let payload;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch { throw invalid(); }
  if (header?.alg !== "HS256" || header?.typ !== "JWT" || Object.keys(header).length !== 2
    || !payload || typeof payload !== "object" || Array.isArray(payload)
    || Object.keys(payload).some((field) => !allowedClaims.has(field))
    || payload.v !== 1 || payload.aud !== ENGINE_MODEL_AUDIENCE
    || !OWNER_ID.test(String(payload.userId)) || !OWNER_ID.test(String(payload.projectId))
    || typeof payload.userId !== "string" || typeof payload.projectId !== "string"
    || !ENGINE_KINDS.includes(payload.kind) || typeof payload.jobId !== "string" || !JOB_ID.test(payload.jobId)
    || (payload.runId !== undefined && (typeof payload.runId !== "string" || !RUN_ID.test(payload.runId)))
    || (payload.sessionId !== undefined && (typeof payload.sessionId !== "string" || !RUN_ID.test(payload.sessionId)))
    || (payload.reasoningEffort !== undefined && !["off", "low", "high", "max"].includes(payload.reasoningEffort))
    || ["dailyLimit", "weeklyLimit", "runLimit"].some((field) => payload[field] !== undefined && !(Number.isFinite(payload[field]) && payload[field] > 0))
    || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)
    || payload.exp <= payload.iat || payload.exp - payload.iat > MAX_TTL_SECONDS
    || typeof payload.jti !== "string" || !/^[A-Za-z0-9_-]{3,256}$/.test(payload.jti)) throw invalid();
  const now = Math.floor(Number(nowSeconds));
  if (payload.iat > now + 30 || payload.exp <= now) throw invalid();
  return {
    ...(payload.reasoningEffort !== undefined ? { reasoningEffort: payload.reasoningEffort } : {}),
    ...(payload.sessionId !== undefined ? { sessionId: payload.sessionId } : {}),
    userId: payload.userId,
    projectId: payload.projectId,
    runId: payload.runId ?? null,
    dailyLimit: payload.dailyLimit,
    weeklyLimit: payload.weeklyLimit,
    runLimit: payload.runLimit,
    engine: { kind: payload.kind, jobId: payload.jobId },
  };
}

/**
 * @param {unknown} raw @returns {{ kind: string, jobId: string, executionContext?: any }}
 */
function parseTokenRequest(raw) {
  let request;
  try { request = JSON.parse(Buffer.from(/** @type {Buffer} */ (raw)).toString("utf8")); } catch { request = null; }
  if (!request || typeof request !== "object" || Array.isArray(request) || request.v !== 1
    || Object.keys(request).some((field) => !["v", "kind", "jobId", "executionContext"].includes(field))) {
    throw new HttpError(400, "engine_model_token_request_invalid", "The request must be a version 1 JSON object naming kind and jobId.");
  }
  if (!ENGINE_KINDS.includes(request.kind)) throw new HttpError(400, "engine_model_token_request_invalid", "Unknown engine kind.");
  if (typeof request.jobId !== "string" || !JOB_ID.test(request.jobId)) {
    throw new HttpError(400, "engine_model_token_request_invalid", "Invalid job id.");
  }
  return { kind: request.kind, jobId: request.jobId, ...(request.executionContext !== undefined ? { executionContext: request.executionContext } : {}) };
}

/**
 * `POST /internal/engines/v1/model-token`, answered for a specialist adapter
 * admitting one job.
 * @param {{ config: Record<string, any>, runtimeManager: any,
 *   attributeRun?: ((owner: { userId: string, projectId: string }) => Promise<string | null>) | null,
 *   resolveExecutionContext?: ((owner: {userId:string,projectId:string}, context:any) => Promise<any>) | null,
 *   runScope?: ((request: { userId: string, projectId: string, runId: string }) => Promise<{ usageRunId: string, runLimit: number } | null>) | null }} dependencies
 *   `runScope`: the cap a scheduled execution in the researcher's own runtime is held to (`autopilotEpisodeScope.mjs`). A bounded
 *   runtime's engine job carries the runtime's scope; an interactive one's carries the same figures through this, so an engine's
 *   model calls are the episode's too and stop at its limit.
 */
export function createEngineModelTokenHandler({ config, runtimeManager, attributeRun = null, resolveExecutionContext = null, runScope = null }) {
  /** @param {any} req @param {any} res @param {(failure: any) => void} [onFailure] */
  return async (req, res, onFailure) => {
    try {
      if (req.method !== "POST" || new URL(req.url ?? "/", "http://evimed.local").pathname !== ENGINE_MODEL_TOKEN_PATH) {
        throw new HttpError(404, "not_found", "Engine model credential operation not found.");
      }
      if (config.engineModelGatewayEnabled !== true) {
        throw new HttpError(503, "engine_model_gateway_disabled", "Engine model calls do not go through the gateway on this deployment.");
      }
      if (config.deepseekProviderEnabled === false || !config.deepseekApiKey) {
        throw new HttpError(503, "model_gateway_unavailable", "The model gateway is not configured.");
      }
      const workloadSecret = String(config.evimedWorkloadSigningSecret ?? "");
      if (workloadSecret.length < 32) {
        throw new HttpError(503, "engine_model_gateway_unconfigured", "Engine credential requests cannot be verified here.");
      }
      if (String(req.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase() !== "application/json") {
        throw new HttpError(415, "engine_model_token_content_type_invalid", "Content-Type must be application/json.");
      }
      const raw = await readBody(req, MAX_REQUEST_BYTES);
      const supplied = /^v1=([0-9a-f]{64})$/.exec(String(req.headers[ENGINE_MODEL_SIGNATURE_HEADER] ?? ""))?.[1];
      const expected = Buffer.from(engineModelRequestSignature(workloadSecret, raw), "hex");
      if (!supplied || !timingSafeEqual(Buffer.from(supplied, "hex"), expected)) {
        throw new HttpError(401, "engine_model_signature_invalid", "The request is not signed by a specialist service.");
      }
      const request = parseTokenRequest(raw);
      const bearer = /^Bearer ([^\s]+)$/.exec(String(req.headers.authorization ?? ""))?.[1];
      let identity;
      try { identity = await runtimeManager.assertActiveEviMedWorkloadToken(bearer); }
      catch { throw new HttpError(401, "evimed_workload_token_invalid", "The workload is unavailable."); }
      // Whose run the job belongs to, decided now, while the run that started
      // it is the one running. A bounded runtime (autopilot, a GEO step, a
      // verification) says so itself, with its budget; an interactive one is
      // the project's single running run, and two at once stay unattributed
      // rather than guessed — they still count toward the account's caps.
      const bounded = runtimeManager.boundedRuntimeScope?.({ userId: identity.userId, id: identity.projectId }) ?? null;
      let runId = bounded?.runId ?? null;
      /** @type {{ dailyLimit?: number, weeklyLimit?: number, runLimit?: number } | null} */
      let limits = bounded ? { dailyLimit: bounded.dailyLimit, weeklyLimit: bounded.weeklyLimit, runLimit: bounded.runLimit } : null;
      let policy = { reasoningEffort: validateReasoningEffort(config.deepseekReasoningEffort ?? "high"), source: "deployment-default" };
      let sessionId;
      if (request.executionContext !== undefined) {
        const context = executionContext(request.executionContext, config.deepseekModel);
        if (!resolveExecutionContext) throw new HttpError(503, "engine_model_context_unavailable", "Engine session policy resolution is unavailable.");
        const resolved = await resolveExecutionContext({ userId: identity.userId, projectId: identity.projectId }, context);
        if (!resolved || resolved.sessionId !== context.sessionId || !RUN_ID.test(String(resolved.runId ?? ""))
          || (context.reasoningEffort !== undefined && resolved.reasoningEffort !== context.reasoningEffort)) {
          throw new HttpError(409, "engine_model_policy_mismatch", "The engine policy does not match its session.");
        }
        sessionId = context.sessionId;
        policy = { reasoningEffort: validateReasoningEffort(resolved.reasoningEffort), source: "session" };
        if (!bounded) { runId = resolved.runId; limits = { runLimit: Number(config.userRunSpendLimit) || 0 }; }
      } else if (!bounded && attributeRun) {
        runId = await attributeRun({ userId: identity.userId, projectId: identity.projectId }).catch(() => null);
        limits = runId ? { runLimit: Number(config.userRunSpendLimit) || 0 } : null;
      }
      // A scheduled execution in the researcher's runtime: booked under its episode and held to its limit, as the runtime's own calls are.
      // A scope that cannot be read issues no credential (the catch below answers 503), never an uncapped one.
      if (!bounded && runScope && runId) {
        const scope = await runScope({ userId: identity.userId, projectId: identity.projectId, runId });
        if (scope) { runId = scope.usageRunId; limits = { ...limits, runLimit: scope.runLimit }; }
      }
      const { token, payload } = issueEngineModelToken({
        secret: config.modelGatewaySigningSecret,
        userId: identity.userId, projectId: identity.projectId, kind: request.kind, jobId: request.jobId,
        runId, sessionId, reasoningEffort: policy.reasoningEffort, limits, ttlSeconds: config.engineModelTokenTtlSeconds,
      });
      res.setHeader("cache-control", "no-store");
      sendJson(res, 200, { data: {
        token,
        baseUrl: String(config.modelGatewayInternalUrl ?? "").replace(/\/+$/, ""),
        model: config.deepseekModel,
        modelPolicy: { ...policy, ...(sessionId ? { sessionId } : {}) },
        expiresAt: new Date(payload.exp * 1000).toISOString(),
        runId,
      } });
    } catch (error) {
      const safe = error instanceof HttpError ? error : new HttpError(503, "engine_model_token_unavailable", "The engine credential could not be issued.");
      onFailure?.({ code: safe.code, status: safe.status });
      sendError(res, safe);
    }
  };
}
