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
// What the runtime may ask for is a closed vocabulary of three operations. It
// never composes an upstream path and never names the probe host, exactly as
// it never names a bibliographic host.
//
// The upstream contract this speaks to, verified against a live host:
//   GET  /providers            -> readiness per vendor ("tab_found" = logged in)
//   POST /ask                  -> {question, provider|providers, deep, new_chat}
//   GET  /screenshots/<name>   -> the PNG referenced by an answer
// It serves one request at a time and answers HTTP 409 when busy; a single
// call can take five minutes.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const gatewayPath = "/internal/geo-probe/v1";

// Closed vocabularies. A runtime that asks for anything outside them is asking
// for something this deployment does not do, and gets told so.
const allowedOperations = new Set(["providers", "ask", "screenshot"]);
const allowedProviders = new Set(["deepseek", "doubao", "yuanbao", "qianwen", "kimi"]);
// `(?![\s\S])` rather than `$`: in JavaScript `$` matches before a trailing
// newline, so "run-1.png\n" satisfied the pattern and went straight into a URL
// path. The test that caught it is in geoProbeGateway.test.mjs.
const screenshotName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(?:png|jpg|jpeg|webp)(?![\s\S])/;

const maxQuestionLength = 2_000;
const maxAnswerLength = 200_000;
const maxJsonResponseBytes = 8 * 1024 * 1024;
const maxScreenshotBytes = 8 * 1024 * 1024;

class GeoProbeGatewayError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function gatewayError(status, code, message) {
  return new GeoProbeGatewayError(status, code, message);
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

  if (op === "screenshot") {
    // Not trimmed. Trimming would validate one string and use another, and a
    // caller sending "run-1.png\n" would get a working answer while its own
    // name-building bug stayed invisible. The name is machine-generated; there
    // is no whitespace to be liberal about.
    const name = String(body.name ?? "");
    // The name is pasted into a URL path, so it is matched against a whole
    // pattern rather than scanned for "..": a denylist here is a traversal
    // waiting for an encoding nobody thought of.
    if (!screenshotName.test(name)) {
      throw gatewayError(400, "geo_probe_screenshot_name_invalid", "The GEO probe screenshot name is invalid.");
    }
    return { op, name };
  }

  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question || question.length > maxQuestionLength || /[\0]/.test(question)) {
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
  const flag = (value, fallback) => {
    if (value == null) return fallback;
    if (value === 0 || value === 1) return value;
    if (value === true) return 1;
    if (value === false) return 0;
    throw gatewayError(400, "geo_probe_flag_invalid", "The GEO probe deep and newChat flags must be 0 or 1.");
  };
  // new_chat defaults to 1 because a measurement that inherits a previous
  // turn's context is measuring the conversation, not the question.
  return { op, question, providers, deep: flag(body.deep, 0), newChat: flag(body.newChat, 1) };
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
  const host = String(hostname ?? "").toLowerCase();
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (host === "::1" || host.startsWith("fd") || host.startsWith("fe80:")) return true;
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

async function readBoundedText(response, maxBytes, code) {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw gatewayError(502, code, "The GEO probe response exceeded the gateway limit.");
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw gatewayError(502, code, "The GEO probe response exceeded the gateway limit.");
  }
  return text;
}

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
function normalizeAnswer(row, provider) {
  const status = String(row?.status ?? "").trim().toLowerCase();
  const answer = String(row?.answer ?? "");
  const truncated = answer.length > maxAnswerLength;
  const citations = Array.isArray(row?.search_results) ? row.search_results : [];
  const screenshotUrl = String(row?.screenshot_url ?? "").trim();
  // Only the file name crosses back. The runtime asks for a screenshot by name
  // through this gateway; it never learns a host it could reach directly.
  const shot = screenshotUrl ? screenshotUrl.split("/").pop() ?? "" : "";
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
    error: status === "ok" ? null : String(row?.error ?? "").slice(0, 400) || "the probe returned no answer",
  };
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
      if (allowedProviders.has(key)) rows.push({ provider: key, state: String(state?.status ?? state ?? "").trim() });
    }
  }
  rows.sort((left, right) => left.provider.localeCompare(right.provider));
  // "ready" is tab_found: the vendor page is open and logged in. A vendor that
  // is not ready has not declined to answer — it was never asked, and a run
  // that treats the two alike reports a competitor as absent from a platform it
  // never reached.
  return rows.map((row) => ({ ...row, ready: row.state.toLowerCase() === "tab_found" }));
}

export function createGeoProbeGatewayHandler(config, runtimeManager, { fetchImpl = fetch } = {}) {
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
      try {
        runtimeManager.assertActiveModelGatewayToken(token);
      } catch {
        throw gatewayError(401, "geo_probe_gateway_token_invalid", "GEO probe authentication failed.");
      }
      const request = validatedRequest(await readJsonBody(req, 64 * 1024));
      const origin = probeOrigin(config);
      const secret = String(config.geoProbeSigningSecret ?? "");
      const plaintext = origin.protocol === "http:";

      if (request.op === "screenshot") {
        const target = new URL(`screenshots/${request.name}`, origin.pathname.endsWith("/") ? origin : new URL(`${origin.pathname}/`, origin));
        const upstream = await fetchImpl(target, {
          method: "GET",
          headers: { accept: "image/png,image/jpeg,image/webp", ...signedHeaders(secret, { method: "GET", path: target.pathname, bodyDigest: sha256("") }) },
          redirect: "error",
          signal: controller.signal,
        });
        if (!upstream.ok) throw upstreamError(upstream.status);
        const declared = Number(upstream.headers.get("content-length") ?? 0);
        if (Number.isFinite(declared) && declared > maxScreenshotBytes) {
          await upstream.body?.cancel().catch(() => {});
          throw gatewayError(502, "geo_probe_screenshot_too_large", "The GEO probe screenshot exceeded the gateway limit.");
        }
        const bytes = Buffer.from(await upstream.arrayBuffer());
        if (bytes.length > maxScreenshotBytes) {
          throw gatewayError(502, "geo_probe_screenshot_too_large", "The GEO probe screenshot exceeded the gateway limit.");
        }
        sendJson(res, 200, {
          data: {
            name: request.name,
            contentType: String(upstream.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim(),
            bytes: bytes.length,
            // The digest is what a report cites and what a recount verifies;
            // the base64 is what a run embeds. Both, so neither has to be
            // recomputed from the other later and get it wrong.
            sha256: sha256(bytes),
            dataBase64: bytes.toString("base64"),
          },
          measurement: "ok",
        });
        return;
      }

      const path = request.op === "providers" ? "/providers" : "/ask";
      const payload = request.op === "providers" ? null : JSON.stringify({
        question: request.question,
        providers: request.providers,
        deep: request.deep,
        new_chat: request.newChat,
      });
      const bodyDigest = sha256(payload ?? "");
      const target = new URL(path.slice(1), origin.pathname.endsWith("/") ? origin : new URL(`${origin.pathname}/`, origin));
      let upstream;
      try {
        upstream = await fetchImpl(target, {
          method: request.op === "providers" ? "GET" : "POST",
          headers: {
            accept: "application/json",
            ...(payload ? { "content-type": "application/json" } : {}),
            ...signedHeaders(secret, { method: request.op === "providers" ? "GET" : "POST", path: target.pathname, bodyDigest }),
          },
          body: payload ?? undefined,
          redirect: "error",
          signal: controller.signal,
        });
      } catch {
        if (controller.signal.reason?.name === "TimeoutError") {
          throw gatewayError(504, "geo_probe_timeout", "The GEO probe timed out. This is a measurement failure, not a result.");
        }
        throw gatewayError(502, "geo_probe_unavailable", "The GEO probe is unreachable. This is a measurement failure, not a result.");
      }
      if (!upstream.ok) throw upstreamError(upstream.status);

      const text = await readBoundedText(upstream, maxJsonResponseBytes, "geo_probe_response_too_large");
      let body;
      try {
        body = JSON.parse(text);
        // Valid JSON that is not an object is a protocol violation, not an
        // answer. Reading it as "zero vendors ready" would turn a broken probe
        // into the finding that no vendor mentions the brand.
        if (body == null || typeof body !== "object") throw new Error("not an object");
      } catch {
        throw gatewayError(502, "geo_probe_response_invalid", "The GEO probe returned a malformed response.");
      }
      // A digest of exactly what arrived. Over an unauthenticated hop it is the
      // difference between "this number is wrong" and "this number is wrong and
      // here is the record that proves it changed".
      const responseDigest = sha256(text);

      if (request.op === "providers") {
        const providers = normalizeProviders(body);
        sendJson(res, 200, {
          data: { providers, ready: providers.filter((row) => row.ready).map((row) => row.provider) },
          measurement: "ok",
          integrity: { responseDigest, signed: Boolean(secret), transport: plaintext ? "plaintext" : "tls" },
          warnings: providers.some((row) => !row.ready)
            ? ["A vendor that is not ready was never asked; that is not evidence the brand is absent from it."]
            : [],
        });
        return;
      }

      const rows = Array.isArray(body?.results) ? body.results : [body];
      const results = rows.map((row, index) => normalizeAnswer(row, String(row?.provider ?? request.providers[index] ?? request.providers[0])));
      sendJson(res, 200, {
        data: {
          question: request.question,
          // The probe surface is part of the finding, not diagnostics: an answer
          // from a fresh chat in deep mode is a different claim about the
          // vendor than one from a warm chat in fast mode, and a report that
          // omits which it was cannot be reproduced by a client with a phone.
          surface: { mode: request.deep === 1 ? "deep" : "default", session: request.newChat === 1 ? "new_chat" : "continued" },
          results,
          inDenominator: results.filter((row) => row.inDenominator).map((row) => row.provider),
        },
        measurement: results.some((row) => row.inDenominator) ? "ok" : "failed",
        integrity: { responseDigest, requestDigest: bodyDigest, signed: Boolean(secret), transport: plaintext ? "plaintext" : "tls" },
        warnings: [
          ...(results.some((row) => !row.inDenominator)
            ? ["A failed probe is not a measurement: it must be retried, and must not enter the denominator or be cached as a result."]
            : []),
          ...(plaintext && !secret
            ? ["This measurement crossed an unauthenticated plaintext hop. The response digest is recorded, but nothing prevented it from being altered in transit."]
            : []),
        ],
      });
    } catch (error) {
      sendError(res, error, onFailure);
    } finally {
      clearTimeout(timeout);
    }
  };
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
