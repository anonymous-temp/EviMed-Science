import { createHash, createHmac, randomUUID } from "node:crypto";
import { HttpError } from "./security.mjs";

/** Recipes have bounded integer parameters; canonical bytes agree with the
 * fixed Python dispatcher's sort_keys/UTF-8 encoding. */
export function replayCanonical(value) {
  if (Array.isArray(value)) return `[${value.map(replayCanonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${replayCanonical(value[key])}`).join(",")}}`;
  if (value === undefined || typeof value === "number" && !Number.isFinite(value)) throw new Error("Invalid recipe value.");
  return JSON.stringify(value);
}
export const replayDigest = value => createHash("sha256").update(replayCanonical(value)).digest("hex");

export function issueResultReplayToken(secret, scope, now = Math.floor(Date.now() / 1000)) {
  if (typeof secret !== "string" || secret.length < 32) throw new HttpError(503, "result_replay_unavailable", "Calculation authentication is unavailable.");
  for (const key of ["userId", "projectId", "jobId"]) {
    if (typeof scope[key] !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(scope[key])) throw new HttpError(400, "result_replay_scope_invalid", "Invalid calculation scope.");
  }
  if (!/^[a-f0-9]{64}$/.test(scope.recipeDigest)) throw new HttpError(400, "result_recipe_invalid", "Invalid calculation recipe.");
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ v: 1, aud: "evimed-result-replay", userId: scope.userId,
    projectId: scope.projectId, jobId: scope.jobId, recipeDigest: scope.recipeDigest, iat: now, exp: now + 300, jti: randomUUID() })).toString("base64url");
  return `${header}.${payload}.${createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url")}`;
}

/** Server-configured engine only; no caller URL, redirect, provider credential
 * or arbitrary script is accepted. The deadline covers streamed response bytes. */
export class ResultReplayClient {
  constructor({ config, fetchImpl = globalThis.fetch, maxBytes = 8 * 1024 * 1024 }) {
    this.config = config; this.fetchImpl = fetchImpl; this.maxBytes = maxBytes;
  }
  configured() { return Boolean(this.config.resultEngineUrl && this.config.evimedWorkloadSigningSecret); }
  async request(scope, suffix, { method = "GET", body = undefined, signal = undefined } = {}) {
    if (!this.configured()) throw new HttpError(503, "result_replay_unavailable", "The calculation engine is unavailable.");
    const url = new URL(this.config.resultEngineUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new HttpError(503, "result_engine_configuration_invalid", "The calculation engine is unavailable.");
    url.pathname = `/api/v1/evimed/result-replays${suffix}`;
    const abort = new AbortController();
    let reader;
    const cancel = () => { abort.abort(signal?.reason); void reader?.cancel().catch(() => {}); };
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => {
      reject(new HttpError(504, "result_engine_timeout", "The calculation engine did not respond in time.")); cancel();
    }, this.config.resultEngineRequestTimeoutMs ?? 15000); });
    const operation = async () => {
      const response = await this.fetchImpl(url, { method, redirect: "error", signal: abort.signal,
        headers: { Authorization: `Bearer ${issueResultReplayToken(this.config.evimedWorkloadSigningSecret, scope)}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (abort.signal.aborted) { await response.body?.cancel().catch(() => {}); throw new HttpError(499, "result_calculation_canceled", "The calculation request was canceled."); }
      if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new HttpError(response.status === 404 ? 404 : 502, "result_engine_rejected", "The calculation engine refused this operation."); }
      if (!response.body) throw new HttpError(502, "result_engine_response_invalid", "The calculation engine returned an empty response.");
      reader = response.body.getReader(); const chunks = []; let size = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > this.maxBytes) throw new HttpError(502, "result_engine_response_limit", "The calculation response exceeds its limit.");
          chunks.push(Buffer.from(next.value));
        }
      } finally { await reader.cancel().catch(() => {}); }
      let value;
      try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new HttpError(502, "result_engine_response_invalid", "The calculation response is invalid."); }
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(502, "result_engine_response_invalid", "The calculation response is invalid.");
      return value;
    };
    try { return await Promise.race([operation(), timeout]); }
    finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); abort.abort(); }
  }
  capabilities(scope) { return this.request(scope, "/capabilities"); }
  start(scope, recipe, options = {}) { return this.request(scope, "", { ...options, method: "POST", body: { jobId: scope.jobId, recipe } }); }
  status(scope, options = {}) { return this.request(scope, `/${encodeURIComponent(scope.jobId)}`, options); }
  cancel(scope) { return this.request(scope, `/${encodeURIComponent(scope.jobId)}/cancel`, { method: "POST", body: {} }); }
}
