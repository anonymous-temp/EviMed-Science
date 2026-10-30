// The GEO probe channel: what the five consumer LLM front-ends actually answer.
//
// This is not the eighty-first public source, and routing it through
// publicSourceGateway was never the right shape even if it could pass. That
// gateway is a boundary against the open internet — https only, no port, an
// allowlist of official endpoints — and it holds that line for eighty sources
// at once. The probe is a service this platform runs, on a host the operator
// owns, driving logged-in browser tabs over CDP. It belongs beside the model,
// source, and search gateways as a fourth internal channel with its own
// credentials, its own metering, and its own audit trail. Relaxing the public
// boundary to admit it would have traded eighty sources' safety for one
// source's convenience.
//
// What the runtime may ask for is a closed vocabulary of four operations
// (providers, ask, result, screenshot). It never composes an upstream path and
// never names the probe host, exactly as it never names a bibliographic host.
//
// Who may ask is the GEO gateway's admission (2026-10-10, Q-8): the runtime's
// token names the account and the project, and the module has to be on and open
// to that account. The probe host answers one request at a time, for minutes,
// through the platform's own logged-in accounts at the consumer vendors, so a
// token that opens the model gateway is not enough to reach it; and one
// project's runtime is held to a window of calls a minute
// (`OPEN_SCIENCE_GEO_PROBE_CALLS_PER_MINUTE`), the ceiling of a loop and not of
// a run. A refused call is `measurement: "failed"` like every other, and the
// tool tells the run the channel was not measured.
//
// The upstream contract this speaks to, verified against a live host:
//   GET  /providers -> per-vendor browser pool readiness
//   POST /ask -> HTTP 202 with request_id; GET /runs/<id> reads the result
//   Referenced screenshots use bounded, DNS-pinned public HTTPS downloads.
// Legacy synchronous responses and same-origin screenshot paths remain readable.
// The contract this client speaks names no cancel (and no priority flag or fallback switch): an abandoned task runs to its end on the host.
//
// A task is accepted before it is answered, and a five-engine task measured 487 s
// against the runtime tool's 150 s ceiling. So acceptance is a fact of its own:
// the moment the host takes a task its request id is recorded (the interactive
// gateway in `evimed_geo.probe_requests`, the measurement queue on the job's
// `external_ref`), a task that outlives the caller's deadline is `pending` and not
// an error, and it is read later by id (`op: "result"`) and never asked again.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { nodeWebTransport, validatedWebUrl } from "./webReadNetwork.mjs";

const gatewayPath = "/internal/geo-probe/v1";

// Closed vocabularies. A runtime that asks for anything outside them is asking
// for something this deployment does not do, and gets told so.
const allowedOperations = new Set(["providers", "ask", "result", "screenshot"]);
const allowedProviders = new Set(["deepseek", "doubao", "yuanbao", "qianwen", "kimi"]);
// `(?![\s\S])` rather than `$`: in JavaScript `$` matches before a trailing
// newline, so "run-1.png\n" satisfied the pattern and went straight into a URL
// path. The test that caught it is in geoProbeGateway.test.mjs.
const screenshotName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(?:png|jpg|jpeg|webp)(?![\s\S])/;
const requestIdPattern = /^[a-f0-9]{32}(?![\s\S])/i;

/** Calls one project's runtime may make to the probe in a minute, unless the deployment sets another (`OPEN_SCIENCE_GEO_PROBE_CALLS_PER_MINUTE`). */
export const GEO_PROBE_CALLS_PER_MINUTE = 12;

const maxQuestionLength = 4_000;
const maxAnswerLength = 200_000;
const maxJsonResponseBytes = 8 * 1024 * 1024;
const maxScreenshotBytes = 8 * 1024 * 1024;

class GeoProbeGatewayError extends Error {
  /** @param {number} status @param {string} code @param {string} message @param {string | null} [requestId] the host's id of the task this is about, once one was accepted */
  constructor(status, code, message, requestId = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

/** @param {number} status @param {string} code @param {string} message @param {string | null} [requestId] */
function gatewayError(status, code, message, requestId = null) {
  return new GeoProbeGatewayError(status, code, message, requestId);
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendError(res, error, onFailure) {
  const status = error instanceof GeoProbeGatewayError ? error.status : 500;
  const code = error instanceof GeoProbeGatewayError ? error.code : "geo_probe_gateway_failed";
  const message = error instanceof GeoProbeGatewayError ? error.message : "The GEO probe request failed.";
  if (typeof onFailure === "function") {
    onFailure({ code, status, truncated: res.headersSent && !res.writableEnded });
  }
  // `measurement: "failed"` is not decoration. A probe that could not run and a
  // probe that ran and found nothing are the same empty answer on the wire, and
  // treating the first as the second is how a batch reports full coverage
  // having measured half of it. Every error path says which one this was.
  sendJson(res, status, { error: message, code, measurement: "failed" });
}

function bearerToken(req) {
  const header = String(req.headers?.authorization ?? "");
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) throw gatewayError(401, "geo_probe_gateway_token_missing", "GEO probe authentication failed.");
  return match[1].trim();
}

async function readJsonBody(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw gatewayError(413, "geo_probe_request_too_large", "The GEO probe request was too large.");
    chunks.push(chunk);
  }
  if (total === 0) throw gatewayError(400, "geo_probe_request_invalid", "The GEO probe request body was empty.");
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (value == null || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value;
  } catch {
    throw gatewayError(400, "geo_probe_request_invalid", "The GEO probe request body was not a JSON object.");
  }
}

function validatedRequest(body) {
  const op = String(body.op ?? "").trim().toLowerCase();
  if (!allowedOperations.has(op)) {
    throw gatewayError(400, "geo_probe_op_invalid", `The GEO probe op must be one of: ${[...allowedOperations].join(", ")}.`);
  }
  if (op === "providers") return { op };
  if (op === "screenshot") return { op, name: validatedScreenshotName(body.name) };
  if (op === "result") return { op, requestId: validatedRequestId(body.requestId) };
  return { op, ...validatedAsk(body) };
}

/** The probe host's task id: 32 hex characters, the form it hands out. @param {unknown} value @returns {string} */
function validatedRequestId(value) {
  const id = typeof value === "string" ? value : "";
  if (!requestIdPattern.test(id)) {
    throw gatewayError(400, "geo_probe_request_id_invalid", "The GEO probe request id is missing or malformed.");
  }
  return id.toLowerCase();
}

/** A screenshot name the probe may be asked for.
 *  @param {unknown} value @returns {string} */
function validatedScreenshotName(value) {
  // Not trimmed. Trimming would validate one string and use another, and a
  // caller sending "run-1.png\n" would get a working answer while its own
  // name-building bug stayed invisible. The name is machine-generated; there
  // is no whitespace to be liberal about.
  const name = String(value ?? "");
  // The name is pasted into a URL path, so it is matched against a whole
  // pattern rather than scanned for "..": a denylist here is a traversal
  // waiting for an encoding nobody thought of.
  if (!screenshotName.test(name)) {
    throw gatewayError(400, "geo_probe_screenshot_name_invalid", "The GEO probe screenshot name is invalid.");
  }
  return name;
}

/** One ask, checked against the closed vocabulary: a question, one or more
 *  providers, and the two surface flags as 0 or 1.
 *  @param {{ question?: unknown, provider?: unknown, providers?: unknown, deep?: unknown, newChat?: unknown }} body
 *  @returns {{ question: string, providers: string[], deep: 0 | 1, newChat: 0 | 1 }} */
function validatedAsk(body) {
  const question = typeof body.question === "string" ? body.question : "";
  if (!question.trim() || question.length > maxQuestionLength || /[\0]/.test(question)) {
    throw gatewayError(400, "geo_probe_question_invalid", "The GEO probe question is missing or malformed.");
  }
  const requested = body.providers == null
    ? (body.provider == null ? ["deepseek"] : [body.provider])
    : (Array.isArray(body.providers) ? body.providers : [body.providers]);
  const providers = requested.map((value) => String(value).trim().toLowerCase());
  if (providers.length === 0 || providers.length > allowedProviders.size || providers.some((value) => !allowedProviders.has(value))) {
    throw gatewayError(400, "geo_probe_provider_invalid", `The GEO probe providers must be drawn from: ${[...allowedProviders].join(", ")}.`);
  }
  if (new Set(providers).size !== providers.length) {
    throw gatewayError(400, "geo_probe_provider_invalid", "The GEO probe providers contain a duplicate.");
  }
  /** @param {unknown} value @param {0 | 1} fallback @returns {0 | 1} */
  const flag = (value, fallback) => {
    if (value == null) return fallback;
    if (value === 0 || value === 1) return value;
    if (value === true) return 1;
    if (value === false) return 0;
    throw gatewayError(400, "geo_probe_flag_invalid", "The GEO probe deep and newChat flags must be 0 or 1.");
  };
  // new_chat defaults to 1 because a measurement that inherits a previous
  // turn's context is measuring the conversation, not the question.
  if (flag(body.newChat, 1) !== 1) throw gatewayError(400, "geo_probe_flag_invalid", "The GEO probe requires a fresh chat for each question.");
  return { question, providers, deep: flag(body.deep, 0), newChat: 1 };
}

/** The probe origin this deployment is configured with.
 *
 * Unlike the public-source gateway this deliberately accepts http and a port:
 * the probe is an internal service, and requiring TLS from it would mean either
 * no channel at all or a certificate on a box that may not have a name. What it
 * will not do is send plaintext to a publicly routable address without the
 * operator having said so, because "it works" and "it is unobserved" look
 * identical from here. */
function probeOrigin(config) {
  const raw = String(config.geoProbeUrl ?? "").trim();
  if (!raw) {
    throw gatewayError(
      503,
      "geo_probe_unconfigured",
      "The GEO probe channel is not configured for this deployment. Measured visibility is unavailable; nothing else is affected.",
    );
  }
  let base;
  try {
    base = new URL(raw);
  } catch {
    throw gatewayError(503, "geo_probe_endpoint_invalid", "The configured GEO probe endpoint is invalid.");
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw gatewayError(503, "geo_probe_endpoint_invalid", "The configured GEO probe endpoint is invalid.");
  }
  if (base.protocol === "http:" && !isPrivateHost(base.hostname) && config.geoProbeAllowPlaintext !== true) {
    throw gatewayError(
      503,
      "geo_probe_plaintext_forbidden",
      "The GEO probe endpoint is plaintext to a public address. Put it behind TLS or a private link, "
      + "or set OPEN_SCIENCE_GEO_PROBE_ALLOW_PLAINTEXT=1 to accept that measurements cross the internet unprotected.",
    );
  }
  return base;
}

/** Loopback, RFC1918, CGNAT, link-local, or a name with no public dot. */
export function isPrivateHost(hostname) {
  // The URL parser hands an IPv6 literal over in brackets.
  const host = String(hostname ?? "").toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  // An IPv6 literal is judged as an address: loopback, unique-local (fc00::/7) or link-local (fe80::/10). It is not a name, so
  // it never reaches the "no public dot" rule below, and a name that merely starts with `fd` (fda.gov) is not a unique-local address.
  if (host.includes(":")) return host === "::1" || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host);
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const octets = ipv4.slice(1, 5).map(Number);
    if (octets.some((part) => !Number.isInteger(part) || part > 255)) return false;
    return octets[0] === 127
      || octets[0] === 10
      || (octets[0] === 169 && octets[1] === 254)
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168)
      || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127);
  }
  // A bare name with no dot resolves inside the deployment's own network.
  return !host.includes(".");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** Sign the outbound call so the probe host can refuse anything that did not
 *  come from this gateway.
 *
 *  Over plaintext this is the only thing standing between a measurement and
 *  someone else's idea of one. It is not confidentiality — the questions are
 *  not secret — it is integrity, which is the property that actually matters
 *  when the output is a number a client will act on. */
function signedHeaders(secret, { method, path, bodyDigest }) {
  if (!secret) return {};
  const timestamp = String(Date.now());
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}\n${method}\n${path}\n${bodyDigest}`)
    .digest("hex");
  return {
    "x-evimed-timestamp": timestamp,
    "x-evimed-signature": signature,
    "x-evimed-key-id": sha256(secret).slice(0, 16),
  };
}

async function readBoundedBytes(response, maxBytes, code) {
  const fail = () => gatewayError(502, code, "The GEO probe response exceeded the gateway limit.");
  if (Number(response.headers.get("content-length") ?? 0) > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw fail();
  }
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) { await reader.cancel(); throw fail(); }
        chunks.push(Buffer.from(value));
      }
      return Buffer.concat(chunks, total);
    } finally { reader.releaseLock(); }
  }
  // Injectable legacy response doubles do not implement ReadableStream.
  const bytes = typeof response.arrayBuffer === "function" ? Buffer.from(await response.arrayBuffer()) : Buffer.from(await response.text());
  if (bytes.length > maxBytes) throw fail();
  return bytes;
}

async function readBoundedText(response, maxBytes, code) {
  return (await readBoundedBytes(response, maxBytes, code)).toString("utf8");
}

/**
 * The failure codes of a probe or inclusion job that prove its request never reached the provider: the probe host refused it
 * (busy, rate limited, misconfigured, a request it would not take), could not be connected to at all, or had no such route, and the
 * inclusion vendor refused the task before taking it. A one-shot cell that failed with one of these cost nothing and may be asked
 * again without the person's acknowledgement; any other failure of a one-shot cell (a timeout, an upstream error after the send, an
 * expired lease, a task the vendor took and never finished) may have been charged.
 */
export const GEO_UNDELIVERED_FAILURE_CODES = Object.freeze(["geo_probe_busy", "geo_probe_rate_limited", "probe_busy",
  "geo_probe_unconfigured", "geo_probe_endpoint_invalid", "geo_probe_plaintext_forbidden", "geo_probe_unavailable", "geo_probe_not_found",
  "geo_probe_question_invalid", "geo_probe_provider_invalid", "geo_probe_request_invalid", "geo_probe_request_too_large",
  "geo_probe_flag_invalid", "geo_probe_op_invalid",
  "media_market_request_invalid", "media_market_unconfigured", "geo_inclusion_disabled", "geo_inclusion_engine_not_allowed",
  "media_market_unauthorized", "media_market_rate_limited", "media_market_refused"]);

/** The transport's codes for a connection that failed after the request was written (undici and Node sockets). */
const POST_SEND_TRANSPORT_CODES = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_ABORTED"]);

/** Map upstream HTTP to a code that says what the caller should do next.
 *
 *  409 is the one that matters: the probe serves one request at a time, and a
 *  busy probe is a reason to wait, not a vendor that declined to answer. The
 *  geo package learned this the expensive way — caching a busy response makes a
 *  resumed batch replay the failure forever while the operator watches a
 *  progress bar advance. */
function upstreamError(status) {
  if (status === 409) {
    return gatewayError(429, "geo_probe_busy", "The GEO probe is serving another request. This is a measurement failure, not a result: retry, do not record it.");
  }
  if (status === 404) return gatewayError(404, "geo_probe_not_found", "The GEO probe has no such resource.");
  if (status === 429) return gatewayError(429, "geo_probe_rate_limited", "The GEO probe is rate limiting. Retry, do not record it.");
  return gatewayError(502, "geo_probe_upstream_error", `The GEO probe returned HTTP ${status}.`);
}

/** Keep the vendor answer, drop the transport. What survives is what a later
 *  recount needs: the text, its citations, the screenshot reference, and a
 *  digest of exactly what arrived. */
function normalizeAnswer(row, provider, requireBrowser = false) {
  const sourceAccepted = row?.source === "browser" || (!requireBrowser && row?.source == null);
  const status = sourceAccepted ? String(row?.status ?? "").trim().toLowerCase() : "failed";
  const answer = sourceAccepted ? String(row?.answer ?? "") : "";
  const truncated = answer.length > maxAnswerLength;
  const citations = sourceAccepted && Array.isArray(row?.search_results) ? row.search_results : [];
  const screenshotUrl = String(row?.screenshot_url ?? "").trim();
  // Only the file name crosses back. The runtime asks for a screenshot by name
  // through this gateway; it never learns a host it could reach directly. The
  // name is the path's last segment: a pre-signed URL carries a query after it.
  const shot = screenshotFileName(screenshotUrl);
  return {
    provider,
    // "ok" from the probe means a vendor answered. Anything else is a failed
    // measurement and must stay out of the denominator.
    status: status === "ok" ? "ok" : "failed",
    measurement: status === "ok" ? "ok" : "failed",
    inDenominator: status === "ok",
    answer: truncated ? answer.slice(0, maxAnswerLength) : answer,
    answerTruncated: truncated,
    answerDigest: sha256(answer),
    citations: citations.slice(0, 50).map((entry) => ({
      title: String(entry?.title ?? "").slice(0, 300),
      url: String(entry?.url ?? "").slice(0, 2_000),
    })),
    screenshotName: screenshotName.test(shot) ? shot : null,
    latencyMs: Number.isFinite(Number(row?.latency_ms)) ? Number(row.latency_ms) : null,
    error: !sourceAccepted ? CONSUMER_ANSWER_UNAVAILABLE : status === "ok" ? null : String(row?.error ?? "").slice(0, 400) || "the probe returned no answer",
  };
}

/**
 * The `error` of a row the host answered from somewhere other than the consumer page (its paid third-party fallback): not a consumer
 * answer, and asking again only triggers the fallback again, so it is never retried and never read as a login page or an empty shell.
 */
export const CONSUMER_ANSWER_UNAVAILABLE = "consumer_answer_unavailable";

/** The file name a screenshot reference ends in: the last segment of its path, query and fragment left out. Relative references are read as paths on the probe host. @param {string} reference */
function screenshotFileName(reference) {
  if (!reference) return "";
  try {
    return new URL(reference, "http://probe.invalid/").pathname.split("/").pop() ?? "";
  } catch {
    return "";
  }
}

/** The addresses a host names itself by: its bind address, loopback, or any private or link-local one. @param {string} hostname */
function isOwnAddress(hostname) {
  const host = String(hostname ?? "").toLowerCase().replace(/^\[(.*)\]$/, "$1");
  return host === "0.0.0.0" || host === "::" || isPrivateHost(host);
}

function normalizeProviders(payload) {
  const raw = Array.isArray(payload) ? payload : (payload?.providers ?? payload ?? {});
  const rows = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      const name = String(entry?.name ?? entry ?? "").trim().toLowerCase();
      if (allowedProviders.has(name)) rows.push({ provider: name, state: String(entry?.status ?? entry?.state ?? "").trim() });
    }
  } else if (raw && typeof raw === "object") {
    for (const [name, state] of Object.entries(raw)) {
      const key = String(name).trim().toLowerCase();
      if (!allowedProviders.has(key)) continue;
      if (state && typeof state === "object" && "total" in state) {
        const counts = [state.total, state.idle, state.busy, state.quarantined];
        const valid = counts.every((n) => Number.isSafeInteger(n) && n >= 0)
          && state.idle + state.busy + state.quarantined <= state.total;
        rows.push({ provider: key, state: !valid ? "unknown" : state.idle > 0 ? "tab_found" : state.busy > 0 ? "busy" : "unavailable" });
      } else rows.push({ provider: key, state: String(state?.status ?? state ?? "").trim() });
    }
  }
  rows.sort((left, right) => left.provider.localeCompare(right.provider));
  // "ready" is tab_found: the vendor page is open and logged in. A vendor that
  // is not ready has not declined to answer — it was never asked, and a run
  // that treats the two alike reports a competitor as absent from a platform it
  // never reached.
  return rows.map((row) => ({ ...row, ready: ["tab_found", "busy"].includes(row.state.toLowerCase()) }));
}

/** A directory URL of the origin, so a relative path resolves beneath it. @param {URL} origin */
function originDirectory(origin) {
  return origin.pathname.endsWith("/") ? origin : new URL(`${origin.pathname}/`, origin);
}

/** Job states of an accepted task that are not an answer yet, and the ones that are. */
const TASK_UNFINISHED = ["queued", "waiting", "running"];
const TASK_FINISHED = ["done", "partial", "failed"];

/**
 * The failures of reading an accepted task that say the host could not be reached just now, not that the task is gone or that what it
 * returned cannot be trusted: the task is read again later. Any other failure of a read (a host that has no such task, a reply that
 * disagrees with the ask) is final for that task, and it is never submitted again either way.
 */
export const GEO_PROBE_POLL_TRANSIENT_CODES = Object.freeze(["geo_probe_rate_limited", "geo_probe_busy", "geo_probe_unavailable",
  "geo_probe_upstream_error", "geo_probe_timeout"]);
const POLL_TRANSIENT = new Set(GEO_PROBE_POLL_TRANSIENT_CODES);

/**
 * The outcomes of a probe task, counted by whoever meets them (`onTask`; `open_science_geo_probe_tasks_total{outcome}`):
 * - `accepted`: the host took a task (HTTP 202, or a 200 that carries a job).
 * - `completed` / `partial` / `failed`: the task finished as done, partial or failed, and its result was read.
 * - `pending`: an interactive ask outlived its deadline; the task is kept for a later read by its id.
 * - `accepted_result_unavailable`: the task was accepted and its result cannot be established (unreadable, contradicting its ask, or
 *   still unfinished when the queue's age limit passed); it is never submitted again.
 * - `resubmit_prevented`: a queue job whose lease lapsed while it held an accepted task, which lease recovery would have asked again.
 * - `capacity_wait`: the queue found no idle slot on the host for an engine and asked nothing.
 */
export const GEO_PROBE_TASK_OUTCOMES = Object.freeze(["accepted", "completed", "partial", "failed", "pending", "accepted_result_unavailable",
  "resubmit_prevented", "capacity_wait"]);

/** Whether a reply is a job envelope: what the host answers an accepted ask with, even on a 200. @param {any} body */
function isJobEnvelope(body) {
  return typeof body?.request_id === "string" && typeof body?.job_status === "string";
}

/** @typedef {{ pending: true, requestId: string, jobStatus: string }} GeoProbePending  an accepted task that has not finished */
/** @typedef {{ question: string, surface: { mode: string, session: string }, results: any[], raw: any[], integrity: Record<string, any> }} GeoProbeAnswers */

/**
 * The probe host as a client: the operations of the upstream contract, with
 * the transport rules this module enforces (the origin check, the signature,
 * the size limits, the error codes that say whether a failure is a reason to
 * wait). The runtime's gateway below and the control plane's own measurement
 * queue (`geoProbeQueue.mjs`) both reach the probe through it, so there is one
 * account of what an answer from the probe is.
 *
 * Every method throws a `GeoProbeGatewayError` (`status`, `code`) on failure
 * and never reads a failure as an empty result. The caller passes its own
 * `signal`; an abort whose reason is a `TimeoutError` reads `geo_probe_timeout`.
 *
 * Acceptance is a fact of its own. Once the host has taken a task, nothing here
 * submits that question again; a failure after it carries the task's id
 * (`error.requestId`), and the id is handed to `onAccepted` at once.
 *
 * - `providers({ signal })` → `{ providers: [{ provider, state, ready }], ready: string[], integrity }`
 * - `ask({ question, providers | provider, deep, newChat, signal, onAccepted? })` →
 *   `{ question, surface, results, raw, integrity }`. `results` are the
 *   normalized answers the gateway hands a run; `raw` are the upstream's own
 *   result rows in the same order — their status word and per-citation
 *   fields, which the measurement queue reads and a run is never shown.
 *   `onAccepted({ requestId, question, providers, deep, newChat })` is awaited the moment the host accepts the task and before
 *   anything is waited for; if it throws the ask ends with that error. A task that is not finished when the caller's deadline passes
 *   throws `geo_probe_result_pending` (202, with `requestId`).
 * - `submit(...)`: the same ask, but it returns `{ pending: true, requestId, jobStatus }` as soon as the task is accepted (and
 *   `onAccepted` has run) instead of waiting: the caller reads the task itself. A host that answers in the request itself, or whose
 *   acceptance already carries the finished job, returns the answers.
 * - `read({ requestId, question, providers, deep, newChat, wait?, signal })` → the same result as `ask` for an accepted task, or
 *   `{ pending: true, requestId, jobStatus }` while it is unfinished (with `wait` it polls until the signal's deadline first). The
 *   ask's own fields are given back so the reply is checked against what was asked. A single read that cannot reach the host throws
 *   one of `GEO_PROBE_POLL_TRANSIENT_CODES`: the caller reads again later.
 * - `screenshot({ name, signal })` → `{ name, contentType, bytes: Buffer, sha256 }`
 *
 * The contract this client speaks names no cancel, so an abandoned task runs to its end on the host and its result stays readable.
 *
 * @param {Record<string, any>} config
 * @param {{ fetchImpl?: typeof fetch, pollIntervalMs?: number, screenshotTransport?: import("./webReadNetwork.mjs").WebTransport,
 *   onTask?: (outcome: string) => void }} [options]  `onTask` hears each task outcome (`GEO_PROBE_TASK_OUTCOMES`)
 */
export function probeUpstream(config, { fetchImpl = fetch, pollIntervalMs = 1_000, screenshotTransport = nodeWebTransport(), onTask = () => {} } = {}) {
  /** @type {Map<string, { url: URL, until: number }>} */
  const screenshots = new Map();
  // The queue has a longer night-batch deadline than the attended MCP gateway.
  // A caller-owned deadline must not be shortened to the runtime tool's ceiling.
  const signalFor = (signal) => signal ?? AbortSignal.timeout(Math.max(1_000, Number(config.geoProbeTimeoutMs) || 360_000));
  const secret = () => String(config.geoProbeSigningSecret ?? "");
  /** @param {string} outcome */
  const count = (outcome) => {
    try { onTask(outcome); } catch { /* a counter never fails a probe */ }
  };
  /** @param {string | null} [requestId] */
  const resultUnavailable = (requestId = null) => gatewayError(502, "geo_probe_result_unavailable",
    "The accepted GEO probe task could not be read. Delivery is unknown; do not submit the question again automatically.", requestId);
  /** @param {string} requestId */
  const pendingError = (requestId) => gatewayError(202, "geo_probe_result_pending",
    "The accepted GEO probe task has not finished. Read it later by its request id; do not ask the question again.", requestId);
  /** @param {AbortSignal} signal */
  const timedOut = (signal) => signal.aborted && /** @type {any} */ (signal.reason)?.name === "TimeoutError";
  /** The body the ask was sent with: the same bytes whenever the same ask is made again. @param {{ question: string, providers: string[], deep: 0 | 1, newChat: 0 | 1 }} spec */
  const askPayload = ({ question, providers, deep, newChat }) => JSON.stringify({ question, providers, deep, new_chat: newChat });

  /**
   * GET /providers, GET /runs/<id> or POST /ask: the parsed JSON object and the digests.
   * @param {string} op @param {string | null} payload @param {AbortSignal | undefined} signal
   */
  async function exchange(op, payload, signal) {
    const origin = probeOrigin(config);
    const method = op === "ask" ? "POST" : "GET";
    const bodyDigest = sha256(payload ?? "");
    const target = new URL(op, originDirectory(origin));
    let upstream;
    try {
      upstream = await fetchImpl(target, {
        method,
        headers: {
          accept: "application/json",
          ...(payload ? { "content-type": "application/json" } : {}),
          ...signedHeaders(secret(), { method, path: target.pathname, bodyDigest }),
        },
        body: payload ?? undefined,
        redirect: "error",
        signal,
      });
    } catch (error) {
      if (signal?.reason?.name === "TimeoutError") {
        throw gatewayError(504, "geo_probe_timeout", "The GEO probe timed out. This is a measurement failure, not a result.");
      }
      // A connection that broke after the request was written may have been asked of the engine: that is an upstream error (its
      // delivery unknown), never "unreachable", which says the ask was never put to it — a one-shot cell may be asked again for free.
      if (POST_SEND_TRANSPORT_CODES.has(String(/** @type {any} */ (error)?.cause?.code ?? ""))) {
        throw gatewayError(502, "geo_probe_upstream_error", "The connection to the GEO probe broke after the request was sent. This is a measurement failure, not a result.");
      }
      throw gatewayError(502, "geo_probe_unavailable", "The GEO probe is unreachable. This is a measurement failure, not a result.");
    }
    if (!upstream.ok) throw upstreamError(upstream.status);

    let text;
    let body;
    try {
      text = await readBoundedText(upstream, maxJsonResponseBytes, "geo_probe_response_too_large");
      body = JSON.parse(text);
      if (body == null || typeof body !== "object") throw new Error("not an object");
    } catch (error) {
      // Acceptance precedes parsing. Even an unreadable 202 may have spent the ask, and it names no task to read later.
      if (op === "ask" && upstream.status === 202) {
        count("accepted_result_unavailable");
        throw resultUnavailable();
      }
      if (error instanceof GeoProbeGatewayError) throw error;
      throw gatewayError(502, "geo_probe_response_invalid", "The GEO probe returned a malformed response.");
    }
    // A digest of exactly what arrived. Over an unauthenticated hop it is the
    // difference between "this number is wrong" and "this number is wrong and
    // here is the record that proves it changed".
    return { body, httpStatus: upstream.status, responseDigest: sha256(text), requestDigest: bodyDigest, transport: origin.protocol === "http:" ? "plaintext" : "tls" };
  }

  /**
   * Put the ask to the host. A task it accepts — a 202, or a 200 that carries a job — has an id; a synchronous host answers the ask
   * itself, and `requestId` is null.
   * @param {{ question: string, providers: string[], deep: 0 | 1, newChat: 0 | 1 }} spec @param {AbortSignal} signal
   */
  async function put(spec, signal) {
    const sent = await exchange("ask", askPayload(spec), signal);
    if (sent.httpStatus !== 202 && !isJobEnvelope(sent.body)) return { sent, requestId: null };
    const requestId = sent.body.request_id;
    if (typeof requestId !== "string" || !requestIdPattern.test(requestId)) {
      count("accepted_result_unavailable");
      throw resultUnavailable();
    }
    count("accepted");
    return { sent, requestId };
  }

  /**
   * A job reply, checked against the ask it answers. `null` while the task is unfinished; the job once it has finished; otherwise the
   * reply is not this ask's and the task's result cannot be established.
   * @param {any} job @param {string} requestId @param {{ question: string, providers: string[], deep: 0 | 1, newChat: 0 | 1 }} spec
   */
  function checkedJob(job, requestId, spec) {
    const { question, providers, deep, newChat } = spec;
    if (job.request_id !== requestId || (job.deep != null && job.deep !== deep) || (job.new_chat != null && job.new_chat !== newChat) || (job.question != null && job.question !== question)
      || (job.providers != null && (!Array.isArray(job.providers) || job.providers.length !== providers.length
        || job.providers.some((p) => !providers.includes(p))))) {
      throw resultUnavailable(requestId);
    }
    if (TASK_UNFINISHED.includes(job.job_status)) return null;
    if (!TASK_FINISHED.includes(job.job_status) || !job.result || !Array.isArray(job.result.results)) throw resultUnavailable(requestId);
    if (job.result.request_id !== requestId || (job.result.question != null && job.result.question !== question)) throw resultUnavailable(requestId);
    return job;
  }

  /**
   * Read an accepted task: once (`wait: false`), or until it finishes or the signal's deadline passes (`wait: true`). `first` is a job
   * the ask itself came back with. A deadline with the task unfinished is `geo_probe_result_pending`; a caller's own cancellation, a
   * host with no such task or a reply that disagrees with the ask is `geo_probe_result_unavailable`.
   * @param {{ requestId: string, spec: { question: string, providers: string[], deep: 0 | 1, newChat: 0 | 1 }, signal: AbortSignal, wait: boolean,
   *   first: Awaited<ReturnType<typeof exchange>> | null, delayFirst: boolean }} task
   * @returns {Promise<{ pending: true, jobStatus: string } | { pending: false, job: any, reply: Awaited<ReturnType<typeof exchange>> }>}
   */
  async function collect({ requestId, spec, signal, wait, first, delayFirst }) {
    let transientFailures = 0;
    let reply = first;
    let pause = delayFirst;
    for (;;) {
      if (reply === null) {
        try {
          if (wait && pause) await delay(Math.max(1, pollIntervalMs), undefined, { signal });
          reply = await exchange(`runs/${requestId}`, null, signal);
          transientFailures = 0;
        } catch (error) {
          const code = String(/** @type {any} */ (error)?.code ?? "");
          if (signal.aborted) {
            // The deadline passed with the task unfinished: it is still the host's, and its id is the way back to it.
            if (!timedOut(signal)) throw resultUnavailable(requestId);
            if (wait) throw pendingError(requestId);
            throw error;
          }
          if (POLL_TRANSIENT.has(code)) {
            if (!wait) throw error;
            if (++transientFailures < 3) { pause = true; continue; }
            // The host could not be reached three times running; the task is not known to be lost.
            throw pendingError(requestId);
          }
          throw resultUnavailable(requestId);
        }
      }
      const job = checkedJob(reply.body, requestId, spec);
      if (job === null) {
        if (!wait) return { pending: true, jobStatus: String(reply.body.job_status) };
        reply = null;
        pause = true;
        continue;
      }
      return { pending: false, job, reply: { ...reply, body: job.result } };
    }
  }

  /** What a task's id and failure add to the counters: a task whose deadline passed, or whose result cannot be established. @param {unknown} error */
  const accountedFor = (error) => {
    const code = /** @type {any} */ (error)?.code;
    if (code === "geo_probe_result_pending") count("pending");
    else if (code === "geo_probe_result_unavailable") count("accepted_result_unavailable");
    return error;
  };

  /**
   * The file a screenshot reference stands for, as the name this client serves it by. The probe host names its own screenshots, often
   * by its bind address (no port, 0.0.0.0, loopback) and not the address it is reached at: a reference to the host itself is the name
   * on the configured origin, and nothing from the reference but its name is ever requested. A public HTTPS address elsewhere (object
   * storage) is fetched by a DNS-pinned public download under an opaque name. Anything else is no screenshot, and says why.
   * @param {any} row @param {string | null} name the file name the reference ends in, when it is a valid one
   * @returns {{ name: string | null, warning?: string }}
   */
  function screenshotReference(row, name) {
    const reference = String(row?.screenshot_url ?? "").trim();
    if (!reference) return { name: null };
    if (!name) return { name: null, warning: "screenshot_unavailable:name_invalid" };
    const probe = probeOrigin(config);
    let url;
    try {
      url = new URL(reference, originDirectory(probe));
    } catch {
      return { name: null, warning: "screenshot_unavailable:url_invalid" };
    }
    if (url.origin === probe.origin || url.hostname === probe.hostname || isOwnAddress(url.hostname)) return { name };
    try {
      validatedWebUrl(url.href);
      if (url.protocol !== "https:") throw new Error("not TLS");
    } catch {
      return { name: null, warning: "screenshot_unavailable:foreign_origin" };
    }
    const remote = `remote-${sha256(url.href)}.${name.split(".").pop()}`;
    for (const [key, saved] of screenshots) if (saved.until < Date.now()) screenshots.delete(key);
    if (screenshots.size >= 1_000) screenshots.delete(screenshots.keys().next().value);
    screenshots.set(remote, { url, until: Date.now() + 3_600_000 });
    return { name: remote };
  }

  /**
   * A finished reply as the answers a caller is handed. `requestId` is null for a synchronous host.
   * @param {{ spec: { question: string, providers: string[], deep: 0 | 1, newChat: 0 | 1 }, requestId: string | null, requestDigest: string,
   *   reply: Awaited<ReturnType<typeof exchange>> }} finished
   */
  function answersOf({ spec, requestId, requestDigest, reply }) {
    const { question, providers, deep, newChat } = spec;
    try {
      const { body, responseDigest, transport } = reply;
      const rows = Array.isArray(body?.results) ? body.results : [body];
      // Fail closed on foreign or duplicate provider rows; missing vendors remain explicit failures.
      const invalidResult = () => requestId ? resultUnavailable(requestId) : gatewayError(502, "geo_probe_response_invalid", "The GEO probe returned inconsistent results.");
      const surfaceMatches = (value) => (value.deep == null || value.deep === deep) && (value.new_chat == null || value.new_chat === newChat);
      if (!surfaceMatches(body)) throw invalidResult();
      const seen = new Set();
      for (const row of rows) {
        if (row == null || typeof row !== "object" || Array.isArray(row)) throw invalidResult();
        const provider = row?.provider ?? (rows.length === 1 && providers.length === 1 ? providers[0] : null);
        if (!providers.includes(provider) || seen.has(provider) || !surfaceMatches(row)
          || (row.question != null && row.question !== question) || (requestId && row.request_id != null && row.request_id !== requestId)) throw invalidResult();
        seen.add(provider);
      }
      const ordered = providers.map((provider) => rows.find((r) => r.provider === provider || (!r.provider && providers.length === 1)) ?? { provider, status: "failed", error: "missing_provider_result" });
      const results = ordered.map((row, index) => {
        const answer = normalizeAnswer(row, providers[index], requestId != null);
        const shot = screenshotReference(row, answer.screenshotName);
        answer.screenshotName = shot.name;
        // A reference that could not be served is said, not dropped: the answer stands without its picture.
        if (shot.warning) answer.warnings = [shot.warning];
        return answer;
      });
      return {
        question,
        // The probe surface is part of the finding, not diagnostics: an answer
        // from a fresh chat in deep mode is a different claim about the
        // vendor than one from a warm chat in fast mode, and a report that
        // omits which it was cannot be reproduced by a client with a phone.
        surface: { mode: deep === 1 ? "deep" : "default", session: newChat === 1 ? "new_chat" : "continued" },
        results,
        raw: ordered,
        integrity: { responseDigest, requestDigest, signed: Boolean(secret()), transport, ...(requestId ? { upstreamRequestId: requestId } : {}) },
      };
    } catch (error) {
      if (requestId) throw resultUnavailable(requestId);
      throw error;
    }
  }

  /** A finished task's answers, counted by how it finished. */
  function finish(spec, requestId, requestDigest, read) {
    const answers = answersOf({ spec, requestId, requestDigest, reply: read.reply });
    count(read.job.job_status === "done" ? "completed" : read.job.job_status);
    return answers;
  }

  /**
   * The ask, put to the host and (unless `detach`) waited for. The task's id is handed to `onAccepted` first.
   * @param {Record<string, any>} request @param {boolean} detach
   * @returns {Promise<GeoProbeAnswers | GeoProbePending>}
   */
  async function putAndRead(request, detach) {
    const spec = validatedAsk(request);
    const signal = signalFor(request.signal);
    const { sent, requestId } = await put(spec, signal);
    if (requestId === null) return answersOf({ spec, requestId: null, requestDigest: sent.requestDigest, reply: sent });
    try {
      // The id is on record before anything is waited for: whatever happens to this call, the task is not lost and not asked again.
      await request.onAccepted?.({ requestId, ...spec });
      const first = isJobEnvelope(sent.body) ? sent : null;
      if (detach && first === null) return { pending: true, requestId, jobStatus: "queued" };
      const read = await collect({ requestId, spec, signal, wait: !detach, first, delayFirst: true });
      if (read.pending) return { pending: true, requestId, jobStatus: read.jobStatus };
      return finish(spec, requestId, sent.requestDigest, read);
    } catch (error) {
      throw accountedFor(error);
    }
  }

  return {
    /** @param {{ signal?: AbortSignal }} [options] */
    async providers({ signal } = {}) {
      const { body, responseDigest, transport } = await exchange("providers", null, signalFor(signal));
      const providers = normalizeProviders(body);
      return {
        providers,
        ready: providers.filter((row) => row.ready).map((row) => row.provider),
        integrity: { responseDigest, signed: Boolean(secret()), transport },
      };
    },

    /**
     * @param {{ question?: unknown, provider?: unknown, providers?: unknown, deep?: unknown, newChat?: unknown, signal?: AbortSignal,
     *   onAccepted?: (task: { requestId: string, question: string, providers: string[], deep: 0 | 1, newChat: 0 | 1 }) => unknown }} request
     * @returns {Promise<GeoProbeAnswers>}
     */
    ask(request) {
      return /** @type {Promise<GeoProbeAnswers>} */ (putAndRead(request, false));
    },

    /**
     * @param {Parameters<ReturnType<typeof probeUpstream>["ask"]>[0]} request
     * @returns {Promise<GeoProbeAnswers | GeoProbePending>}
     */
    submit(request) {
      return putAndRead(request, true);
    },

    /**
     * An accepted task's state or answers, by its id.
     * @param {{ requestId: unknown, question?: unknown, provider?: unknown, providers?: unknown, deep?: unknown, newChat?: unknown, wait?: boolean, signal?: AbortSignal }} request
     * @returns {Promise<GeoProbeAnswers | GeoProbePending>}
     */
    async read(request) {
      const requestId = validatedRequestId(request.requestId);
      const spec = validatedAsk(request);
      const signal = signalFor(request.signal);
      try {
        const read = await collect({ requestId, spec, signal, wait: request.wait === true, first: null, delayFirst: false });
        if (read.pending) return { pending: true, requestId, jobStatus: read.jobStatus };
        return finish(spec, requestId, sha256(askPayload(spec)), read);
      } catch (error) {
        if (/** @type {any} */ (error)?.code === "geo_probe_result_pending") {
          count("pending");
          return { pending: true, requestId, jobStatus: "running" };
        }
        throw accountedFor(error);
      }
    },

    /** @param {{ name?: unknown, signal?: AbortSignal }} request */
    async screenshot({ name: requested, signal }) {
      const name = validatedScreenshotName(requested);
      signal = signalFor(signal);
      if (name.startsWith("remote-")) {
        const saved = screenshots.get(name);
        if (!saved || saved.until < Date.now()) throw gatewayError(404, "geo_probe_screenshot_expired", "The screenshot reference expired; read the saved measurement instead.");
        const response = await screenshotTransport({ url: saved.url, headers: { accept: "image/png,image/jpeg,image/webp" }, signal, maxBytes: maxScreenshotBytes });
        if (response.status !== 200) throw upstreamError(response.status);
        const contentType = String(response.headers["content-type"] ?? "").split(";")[0].trim();
        if (!["image/png", "image/jpeg", "image/webp"].includes(contentType)) throw gatewayError(502, "geo_probe_screenshot_invalid", "The GEO probe screenshot was not an image.");
        if (response.body.length > maxScreenshotBytes) throw gatewayError(502, "geo_probe_screenshot_too_large", "The GEO probe screenshot exceeded the gateway limit.");
        return { name, contentType, bytes: response.body, sha256: sha256(response.body) };
      }
      const origin = probeOrigin(config);
      const target = new URL(`screenshots/${name}`, originDirectory(origin));
      const upstream = await fetchImpl(target, {
        method: "GET",
        headers: { accept: "image/png,image/jpeg,image/webp", ...signedHeaders(secret(), { method: "GET", path: target.pathname, bodyDigest: sha256("") }) },
        redirect: "error",
        signal,
      });
      if (!upstream.ok) throw upstreamError(upstream.status);
      const bytes = await readBoundedBytes(upstream, maxScreenshotBytes, "geo_probe_screenshot_too_large");
      return {
        name,
        contentType: String(upstream.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim(),
        bytes,
        sha256: sha256(bytes),
      };
    },
  };
}

/**
 * The interactive gateway's record of the tasks it accepted, so one that outlives the tool's deadline can be read later by its id:
 * `record` on acceptance, `lookup` for the account and project that asked (another account's or project's id is not found).
 * `GeoProbeRequests` (`geoProbeRequests.mjs`) is the durable one.
 * @typedef {{ record: (task: { requestId: string, userId: string, projectId: string, question: string, providers: string[], deep: 0 | 1, newChat: 0 | 1 }) => Promise<unknown>,
 *   lookup: (key: { requestId: string, userId: string, projectId: string }) => Promise<null | { requestId: string, question: string, providers: string[], deep: 0 | 1, newChat: 0 | 1, acceptedAt: string }> }} GeoProbeRequestLedger
 */

/**
 * @param {Record<string, any>} config
 * @param {any} runtimeManager
 * @param {{ fetchImpl?: typeof fetch, geo?: { service?: { allows: (user: { id: string }) => boolean } } | null, requests?: GeoProbeRequestLedger | null,
 *   onProbeTask?: (outcome: string) => void, pollIntervalMs?: number }} [dependencies]
 *   `geo` is the composed module or null when it is off (what the GEO gateway is given); `requests` is where accepted tasks are recorded
 *   (without it a task that outlives the deadline cannot be read later, and the ask answers as an unreadable one); `onProbeTask` hears each task outcome;
 *   `pollIntervalMs` is how often an accepted task is read while its ask waits.
 */
export function createGeoProbeGatewayHandler(config, runtimeManager, { fetchImpl = fetch, geo = null, requests = null, onProbeTask = () => {}, pollIntervalMs = 1_000 } = {}) {
  const upstream = probeUpstream(config, { fetchImpl, onTask: onProbeTask, pollIntervalMs });
  /** @type {Map<string, { until: number, count: number }>} */
  const windows = new Map();
  return async function geoProbeGatewayHandler(req, res, onFailure) {
    if (req.method !== "POST" || new URL(req.url ?? "/", "http://localhost").pathname !== gatewayPath) {
      sendError(res, gatewayError(404, "not_found", "Not found."), onFailure);
      return;
    }
    const controller = new AbortController();
    // A single probe drives a browser through a full answer; the upstream's own
    // ceiling is about five minutes.
    const timeoutMs = Math.max(1_000, Number(config.geoProbeTimeoutMs) || 360_000);
    const timeout = setTimeout(() => controller.abort(new DOMException("The GEO probe timed out.", "TimeoutError")), timeoutMs);
    timeout.unref?.();
    try {
      const token = bearerToken(req);
      let identity;
      try {
        identity = runtimeManager.assertActiveModelGatewayToken(token);
      } catch {
        throw gatewayError(401, "geo_probe_gateway_token_invalid", "GEO probe authentication failed.");
      }
      // The module's own admission, before anything of the request is read.
      if (!config.geoEnabled || !geo?.service) {
        throw gatewayError(
          503,
          "geo_probe_disabled",
          "循证 GEO is switched off for this deployment, so the GEO probe is not available. Measured visibility is unavailable; "
          + "state that in the report rather than presenting an estimate as a measurement.",
        );
      }
      if (!geo.service.allows({ id: String(identity?.userId ?? "") })) {
        throw gatewayError(
          503,
          "geo_probe_disabled",
          "循证 GEO is not open to this account, so the GEO probe is not available. Measured visibility is unavailable; "
          + "state that in the report rather than presenting an estimate as a measurement.",
        );
      }
      // A window per account and project, counted before the body is read and whatever the call turns out to be.
      const now = Date.now();
      for (const [key, window] of windows) if (window.until <= now) windows.delete(key);
      const windowKey = `${identity?.userId}\u0000${identity?.projectId}`;
      const window = windows.get(windowKey) ?? { until: now + 60_000, count: 0 };
      windows.set(windowKey, window);
      const limit = Number.isSafeInteger(config.geoProbeCallsPerMinute) && config.geoProbeCallsPerMinute > 0
        ? config.geoProbeCallsPerMinute : GEO_PROBE_CALLS_PER_MINUTE;
      if (++window.count > limit) {
        throw gatewayError(
          429,
          "geo_probe_gateway_rate_limited",
          "Too many GEO probe calls from this project in a minute. This is a measurement failure, not a result: wait, then retry; do not record it.",
        );
      }
      const request = validatedRequest(await readJsonBody(req, 64 * 1024));

      if (request.op === "screenshot") {
        const shot = await upstream.screenshot({ name: request.name, signal: controller.signal });
        sendJson(res, 200, {
          data: {
            name: shot.name,
            contentType: shot.contentType,
            bytes: shot.bytes.length,
            // The digest is what a report cites and what a recount verifies;
            // the base64 is what a run embeds. Both, so neither has to be
            // recomputed from the other later and get it wrong.
            sha256: shot.sha256,
            dataBase64: shot.bytes.toString("base64"),
          },
          measurement: "ok",
        });
        return;
      }

      if (request.op === "providers") {
        const { providers, ready, integrity } = await upstream.providers({ signal: controller.signal });
        sendJson(res, 200, {
          data: { providers, ready },
          measurement: "ok",
          integrity,
          warnings: providers.some((row) => !row.ready)
            ? ["A vendor that is not ready was never asked; that is not evidence the brand is absent from it."]
            : [],
        });
        return;
      }

      const owner = { userId: String(identity?.userId ?? ""), projectId: String(identity?.projectId ?? "") };

      if (request.op === "result") {
        // Only the account and project that asked can read a task: another one's id is no more found than one never accepted.
        const task = await requests?.lookup({ requestId: request.requestId, ...owner }) ?? null;
        if (!task) {
          throw gatewayError(404, "geo_probe_request_unknown", "This project has no accepted GEO probe task with that request id (or its record has expired). "
            + "Do not ask the question again to find out: that is a new measurement and a new charge.");
        }
        const read = await upstream.read({ requestId: task.requestId, question: task.question, providers: task.providers, deep: task.deep, newChat: task.newChat,
          wait: true, signal: controller.signal });
        if ("pending" in read) return sendPending(res, task);
        return sendAnswer(res, read);
      }

      // The task is on record the moment the host accepts it (`onAccepted`), before anything is waited for.
      let accepted = null;
      let answer;
      try {
        answer = await upstream.ask({ ...request, signal: controller.signal, onAccepted: async (task) => {
          try {
            await requests?.record({ ...task, ...owner });
            if (requests) accepted = { ...task, acceptedAt: new Date().toISOString() };
          } catch { accepted = null; /* the ask goes on; if it outlives its deadline it can only be reported as unreadable */ }
        } });
      } catch (error) {
        if (/** @type {any} */ (error)?.code === "geo_probe_result_pending") {
          // Not an error: the host has the task and is still working. The contract names no cancel, so an abandoned task runs to
          // its end and stays readable by its id (`op: "result"`) for the record's retention.
          if (accepted) return sendPending(res, accepted);
          throw gatewayError(502, "geo_probe_result_unavailable", "The accepted GEO probe task did not finish in time and could not be recorded for a later read. "
            + "Delivery is unknown; do not submit the question again automatically.");
        }
        throw error;
      }
      sendAnswer(res, answer);
    } catch (error) {
      sendError(res, error, onFailure);
    } finally {
      clearTimeout(timeout);
    }
  };
}

/**
 * A task the host has accepted and is still working on: not an error and not yet a measurement.
 * @param {any} res @param {{ requestId: string, question: string, providers: string[], acceptedAt: string }} task
 */
function sendPending(res, task) {
  sendJson(res, 202, {
    data: { status: "pending", requestId: task.requestId, question: task.question, providers: task.providers, acceptedAt: task.acceptedAt },
    measurement: "pending",
    warnings: ["The probe is still working on this question. It is not a measurement yet and not a failure: read it later with op=result and this request id. "
      + "Asking the question again starts a second measurement and a second charge."],
  });
}

/** @param {any} res @param {{ question: string, surface: unknown, results: any[], integrity: any }} answer */
function sendAnswer(res, answer) {
  const { results, integrity } = answer;
  sendJson(res, 200, {
    data: {
      question: answer.question,
      surface: answer.surface,
      results,
      inDenominator: results.filter((row) => row.inDenominator).map((row) => row.provider),
    },
    measurement: results.some((row) => row.inDenominator) ? "ok" : "failed",
    integrity,
    warnings: [
      ...(results.some((row) => !row.inDenominator && row.error !== CONSUMER_ANSWER_UNAVAILABLE)
        ? ["A failed probe is not a measurement: it must be retried, and must not enter the denominator or be cached as a result."]
        : []),
      // The host answered from its paid third-party fallback because the consumer page gave nothing. That is not this engine's
      // answer, and asking again only buys the fallback again.
      ...(results.some((row) => row.error === CONSUMER_ANSWER_UNAVAILABLE)
        ? ["An engine whose consumer page gave no answer was answered by a third-party fallback instead. That is not a consumer answer and is kept out of the denominator; "
          + "do not ask that engine again, since each ask triggers the paid fallback again."]
        : []),
      ...(integrity.transport === "plaintext" && !integrity.signed
        ? ["This measurement crossed an unauthenticated plaintext hop. The response digest is recorded, but nothing prevented it from being altered in transit."]
        : []),
    ],
  });
}

/** Verify a signature produced by signedHeaders. Exported for the probe host's
 *  own adapter and for the tests that prove the signing is not decorative. */
export function verifyProbeSignature(secret, { method, path, body, timestamp, signature, toleranceMs = 300_000 }) {
  if (!secret || !signature || !timestamp) return false;
  const age = Date.now() - Number(timestamp);
  if (!Number.isFinite(age) || age < -toleranceMs || age > toleranceMs) return false;
  const expected = createHmac("sha256", secret)
    .update(`${timestamp}\n${method}\n${path}\n${sha256(body ?? "")}`)
    .digest("hex");
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(String(signature), "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export const GEO_PROBE_GATEWAY_PATH = gatewayPath;
export const GEO_PROBE_ALLOWED_OPERATIONS = allowedOperations;
export const GEO_PROBE_ALLOWED_PROVIDERS = allowedProviders;
export { GeoProbeGatewayError };
