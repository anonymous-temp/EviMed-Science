import { backgroundRuntimeLimit, isInternalProject } from "./internalProjects.mjs";
import { Buffer } from "node:buffer";
import { spawn, spawnSync } from "node:child_process";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { constants as fsConstants, lstatSync, readdirSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { workspaceLayout } from "@evimed/domain";
import { compactionConfigFromEnv, compactionRuntimeEnv } from "@evimed/harness-port";
import {
  dockerRuntimeMount,
  dockerWorkspaceMount,
} from "./dockerMounts.mjs";
import { capsuleMethodsDirName, materializeCapsuleMethods } from "./capsuleMethods.mjs";
import { KNOWLEDGE_BASE_DIR } from "./researchContext.mjs";
import { CAPSULE_PROFILE_FACT_KINDS, renderCapsuleProfile } from "./capsuleProfile.mjs";
import { supportedDeepSeekModels } from "./modelGateway.mjs";
import { startMockDshRuntime } from "./mockDshRuntime.mjs";
import { proxyRuntimeUiMux } from "./runtimeUiMuxProxy.mjs";
import { rebaseRuntimeUiDocument } from "./runtimeUiDocument.mjs";
import { browserSessionCookie, generateBrowserSessionSecret } from "./dshBrowserAuth.mjs";
import { renderCredentialsFile, renderProfilePatch, runtimeEnvironment } from "./dshProfilePatch.mjs";
import { PLUGIN_ID, pluginEntry } from "./pluginService.mjs";
import { runtimeReleasePolicyError } from "./releaseManifest.mjs";
import { RuntimeControllerClient } from "./runtimeControllerClient.mjs";
// Knowledge-base search reaches the MCP server by this one variable (2026-09-20).
import { kbSearchGatewayProviderUrl } from "./kbSearchGateway.mjs";
// So does 「前沿动态」 search (2026-09-22), for an account the module is open to.
import { frontierGatewayProviderUrl } from "./frontierGateway.mjs";
import { frontierAudienceAllows } from "./frontierService.mjs";
import { geoGatewayProviderUrl } from "./geoGateway.mjs";
import { geoAudienceAllows } from "./geoService.mjs";
import { createAgentBayClient } from "./agentbay/client.mjs";
// A cycle, on purpose and safe: the provider module reads this one's exports
// only when a method runs, never while either module is being evaluated.
import { AgentBayRuntimeProvider } from "./agentbay/runtimeProvider.mjs";
import {
  isAllowedWireMethod,
  mapWireError,
  normalizeTranscript,
  transcriptToLedgerMessages,
  sessionListItems,
  subagentAddress,
  subagentListItems,
} from "./dshRuntimeAdapter.mjs";
import {
  HttpError,
  appendJsonLineNoFollow,
  assertNoSymlinkPath,
  assertProjectUsageWithinQuota,
  ensureDir,
  openScopedDirectoryNoFollow,
  randomId,
  safeId,
  readBody,
  readTextFileNoFollow,
  sendJson,
  writeFileAtomicNoFollow,
  writeJsonFileAtomicNoFollow,
} from "./security.mjs";

async function freePort() {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
      server.close(() => resolve(port));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const RUNTIME_READINESS_PROBE_TIMEOUT_MS = 500;

class RemoteRuntimeProcess extends EventEmitter {
  constructor(client, project, pollMs) {
    super();
    this.client = client;
    this.project = project;
    this.pollMs = Math.max(100, Number(pollMs) || 500);
    this.pid = null;
    this.exitCode = null;
    this.signalCode = null;
    /** What the container said before it died, as reported by the controller.
     *  Read by `waitUntilReady` so the 502 a caller receives names a cause. */
    this.exitOutput = "";
    this.startedAt = Date.now();
    this.consecutiveErrors = 0;
    this.timer = null;
    this.setTimer();
  }

  setTimer() {
    if (this.exitCode != null || this.signalCode != null) return;
    this.timer = setTimeout(() => void this.poll(), this.pollMs);
    this.timer.unref?.();
  }

  markExited(code = 0, signal = null) {
    if (this.exitCode != null || this.signalCode != null) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.exitCode = Number.isSafeInteger(code) ? code : 1;
    this.signalCode = signal;
    this.emit("exit", this.exitCode, this.signalCode);
  }

  async poll() {
    try {
      const status = await this.client.runtimeStatus(this.project);
      this.consecutiveErrors = 0;
      if (status.running) {
        this.setTimer();
        return;
      }
      if (status.state === "missing" && Date.now() - this.startedAt < 3_000) {
        this.setTimer();
        return;
      }
      this.exitOutput = typeof status.output === "string" ? status.output : "";
      this.markExited(status.exitCode ?? 1);
    } catch {
      this.consecutiveErrors += 1;
      this.setTimer();
    }
  }

  async stop(signal = "SIGTERM") {
    if (this.exitCode != null || this.signalCode != null) return;
    await this.client.cleanupRuntime(this.project);
    this.markExited(0, signal);
  }

  kill(signal = "SIGTERM") {
    void this.stop(signal).catch((error) => this.emit("error", error));
    return true;
  }

  unref() {
    this.timer?.unref?.();
  }
}

function incomingResponseHeaders(response) {
  const headers = new Headers();
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    headers.append(response.rawHeaders[index], response.rawHeaders[index + 1]);
  }
  return headers;
}

function incomingResponseBody(response) {
  let settled = false;
  return new ReadableStream({
    start(controller) {
      const fail = (error) => {
        if (settled) return;
        settled = true;
        controller.error(error instanceof Error ? error : new Error("Runtime response stream failed."));
      };
      response.on("data", (chunk) => {
        if (settled) return;
        controller.enqueue(chunk);
        if ((controller.desiredSize ?? 1) <= 0) response.pause();
      });
      response.once("end", () => {
        if (settled) return;
        settled = true;
        controller.close();
      });
      response.once("error", fail);
      response.once("aborted", () => fail(new DOMException("Runtime response aborted.", "AbortError")));
      response.once("close", () => {
        if (!response.complete) fail(new DOMException("Runtime response closed early.", "AbortError"));
      });
    },
    pull() {
      response.resume();
    },
    cancel(reason) {
      settled = true;
      response.destroy(reason instanceof Error ? reason : undefined);
    },
  });
}

/** TypeScript infers a destructured parameter as exactly the shape its
 *  defaults name, which rejects every other property a caller passes.
 *  @param {any} runtime
 *  @param {any} target
 *  @param {Record<string, any>} options2
 */
export function requestRuntime(runtime, target, { method = "GET", headers = {}, body, signal } = {}) {
  const url = target instanceof URL ? target : new URL(target, runtime.url);
  if (url.protocol !== "http:") {
    return Promise.reject(new Error("Hosted runtime transport only supports HTTP."));
  }
  const requestOptions = {
    method,
    headers,
  };
  // `Host`, explicitly, on the socket path. `http.request` derives it from the
  // URL only when it dials one; given a `socketPath` it has no host to derive
  // from and sends `Host: localhost`. The kernel derives the browser-session
  // cookie's NAME from the Host it receives, so every call over the socket
  // arrived looking for a cookie named for `localhost`, found none, and
  // answered 401 — with a correctly signed cookie for `dsh.runtime` sitting
  // unread in the request. That is every runtime call this control plane
  // makes: the socket is the only transport a hosted runtime has.
  //
  // Not overridden when a caller already set one in any spelling: the proxy
  // forwards a browser's headers and its choice has to win.
  const hasHostHeader = Object.keys(headers).some((name) => name.toLowerCase() === "host");
  const socketOptions = runtime.socketPath
    ? {
        ...requestOptions,
        headers: hasHostHeader ? headers : { host: url.host, ...headers },
        socketPath: runtime.socketPath,
        path: `${url.pathname}${url.search}`,
      }
    : null;

  return new Promise((resolve, reject) => {
    const request = socketOptions
      ? http.request(socketOptions)
      : http.request(url, requestOptions);
    let response = null;
    const abortRequest = () => {
      const reason = signal?.reason instanceof Error
        ? signal.reason
        : new DOMException("Runtime request aborted.", "AbortError");
      response?.destroy(reason);
      request.destroy(reason);
    };
    request.once("error", (error) => {
      signal?.removeEventListener("abort", abortRequest);
      reject(error);
    });
    if (signal) {
      if (signal.aborted) abortRequest();
      else signal.addEventListener("abort", abortRequest, { once: true });
    }
    request.once("response", (incoming) => {
      response = incoming;
      if (signal) {
        if (signal.aborted) abortRequest();
        incoming.once("close", () => signal.removeEventListener("abort", abortRequest));
      }
      resolve({
        status: incoming.statusCode ?? 502,
        headers: incomingResponseHeaders(incoming),
        body: method === "HEAD" ? null : incomingResponseBody(incoming),
      });
      if (method === "HEAD") incoming.resume();
    });
    if (body == null) {
      request.end();
    } else if (Buffer.isBuffer(body) || typeof body === "string" || body instanceof Uint8Array) {
      request.end(body);
    } else if (typeof body.pipe === "function") {
      body.once("error", (error) => request.destroy(error));
      body.pipe(request);
    } else {
      request.destroy(new TypeError("Unsupported runtime request body."));
    }
  });
}

function positiveLimit(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

function proxyLimitExceeded(scope, limit) {
  return new HttpError(429, "runtime_proxy_limit_exceeded", `Too many active runtime proxy connections for ${scope}; limit is ${limit}.`, {
    retryAfterSeconds: 5,
  });
}

function isHopByHopHeader(header) {
  return [
    "host",
    "connection",
    "content-length",
    "accept-encoding",
    "cookie",
    "authorization",
    "x-open-science-project",
    "x-open-science-csrf",
    "origin",
    "referer",
  ].includes(header);
}

const blockedRuntimeResponseHeaders = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "set-cookie2",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "www-authenticate",
]);

function connectionHeaderTokens(headers) {
  const connection = headers.get("connection");
  if (!connection) return new Set();
  return new Set(
    connection
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Rewrites a redirect a kernel emitted so it can never point a caller at the
 * kernel's own origin.
 *
 * There is no browser-facing pass-through any more, so this is only reached by
 * the control plane's own calls — but a redirect that leaks a kernel origin
 * would leak it into a log or a stored location just as effectively, so the
 * rewrite stays.
 */
function proxiedRuntimeLocation(value, runtime, project, surface = "runtime", uiBasePath = "/") {
  if (!value) return null;
  try {
    const runtimeOrigin = new URL(runtime.url).origin;
    const target = new URL(value, runtime.url);
    if (target.origin !== runtimeOrigin) return null;
    target.searchParams.delete("directory");
    target.searchParams.delete("auth_token");
    // Native redirects retain this document's immutable frame prefix.
    if (surface === "ui") return `${uiBasePath}${target.pathname.slice(1)}${target.search}${target.hash}`;
    return `/api/runtime/${encodeURIComponent(project.id)}${target.pathname}${target.search}${target.hash}`;
  } catch {
    return null;
  }
}

/**
 * A kernel application file whose URL names its content: a build asset whose
 * file name carries its hash (`/assets/index-Df-65__b.js`), or a plugin bundle
 * addressed by revision (`/plugins/??…&rev=<12 hex>`, which the kernel itself
 * serves as `immutable`: "versioned code is immutable; mismatched revisions
 * are rejected instead of serving newer bytes"). The bytes behind such a URL
 * never change, so a browser may keep them for a year instead of fetching
 * the whole application again on every session it opens (2026-09-18 plan,
 * session open). A format check of our own kernel's URLs, nothing more.
 * @param {string} suffix the request target below the frame prefix
 */
export function isImmutableRuntimeUiAsset(suffix) {
  const target = String(suffix ?? "");
  const cut = target.indexOf("?");
  const pathname = cut < 0 ? target : target.slice(0, cut);
  const query = cut < 0 ? "" : target.slice(cut + 1);
  if (/^\/assets\/[A-Za-z0-9._-]+-[A-Za-z0-9_-]{8,}\.(?:js|mjs|css|woff2?|ttf|otf|svg|png|jpe?g|gif|webp|avif|ico|wasm)$/.test(pathname)) return true;
  return pathname.startsWith("/plugins/") && /(?:^|[?&])rev=[A-Za-z0-9._-]{6,}(?:&|$)/.test(query);
}

/** What a browser may keep of an immutable kernel file: this account's copy, for a year. */
export const IMMUTABLE_UI_CACHE = "private, max-age=31536000, immutable";

/**
 * Where every frame, of every project, loads the kernel application's files.
 *
 * One address for all of them, because the files are one application: the
 * runtime image is the same for every project, a build asset's name carries
 * its hash and a combo bundle's `rev` is a hash of its bytes
 * (`dsh-client-modules`: `framedHash("combo", …)`), so a URL names exactly one
 * content wherever it is fetched. The previous address carried the project id
 * and the one before it the frame id, and each new address is a download: on
 * 2026-09-19 opening a conversation fetched 4.5 MB again — a 3.1 MB plugin
 * bundle under the frame's path — and switching project fetched it all once
 * more. Not a valid project id (`k` is one character short of none, and the
 * project routes live under `/__evimed/a/`), so it cannot collide with one.
 */
export const SHARED_UI_ASSET_PREFIX = "/__evimed/k/";

/** Bytes of kernel application files the control plane keeps in memory: the
 *  whole application is about 5 MB; this leaves room for a release overlap. */
const SHARED_UI_ASSET_CACHE_BYTES = 64 * 1024 * 1024;
/** The largest single file taken into that cache. */
const SHARED_UI_ASSET_MAX_BYTES = 16 * 1024 * 1024;

function sanitizedRuntimeResponseHeaders(upstreamRes, runtime, project, options = {}) {
  const surface = options.surface ?? "runtime";
  const responseHeaders = {};
  const connectionTokens = connectionHeaderTokens(upstreamRes.headers);
  upstreamRes.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower === "location") {
      const location = proxiedRuntimeLocation(value, runtime, project, surface, options.uiBasePath);
      if (location) responseHeaders[lower] = location;
      return;
    }
    // Who may frame this application is a decision of the deployment that
    // embeds it, not of the kernel that has no idea it is embedded. Whatever
    // it said is dropped and replaced below, so the two cannot disagree.
    if (surface === "ui" && (lower === "x-frame-options" || lower === "content-security-policy")) return;
    if (blockedRuntimeResponseHeaders.has(lower) || connectionTokens.has(lower)) return;
    responseHeaders[lower] = value;
  });
  if (surface === "ui") {
    const embedder = options.frameAncestors ? String(options.frameAncestors) : "'none'";
    responseHeaders["content-security-policy"] = `frame-ancestors ${embedder}`;
    responseHeaders["x-content-type-options"] = "nosniff";
    // A file whose URL names its content is kept, privately, and revalidated
    // by its validators when the browser asks; everything else — the
    // document, the bootstrap, every answer — is fetched fresh, as before.
    // Immutable when the caller knows the URL is (`isImmutableRuntimeUiAsset`)
    // or the kernel says so itself, and only for a successful answer.
    const immutable = upstreamRes.status >= 200 && upstreamRes.status < 300
      && (options.immutable === true || /\bimmutable\b/i.test(String(upstreamRes.headers.get("cache-control") ?? "")));
    if (immutable) {
      responseHeaders["cache-control"] = IMMUTABLE_UI_CACHE;
    } else {
      responseHeaders["cache-control"] = "private, no-store";
      delete responseHeaders.etag;
      delete responseHeaders["last-modified"];
    }
  }
  return responseHeaders;
}

export { rebaseRuntimeUiDocument as rebasedUiDocumentForTest };

/**
 * The one origin allowed to embed the kernel's application: this deployment's
 * own page. Written from the public URL rather than configured separately, so
 * a deployment cannot end up embeddable by a origin it never named.
 *
 * @param {Record<string, any>} config
 */
function frameAncestorsFor(config) {
  const value = String(config?.publicUrl ?? "").trim();
  if (!value) return "'self'";
  try {
    return new URL(value).origin;
  } catch {
    return "'none'";
  }
}

function uiProxyAuditTarget(suffix) {
  const pathname = suffix.split("?")[0] || "/";
  if (pathname === "/" || pathname === "/index.html") return "/";
  // Both segments of a method, not just its namespace. The allow half of this
  // surface is a deny list today, so the audit row is where the set of methods
  // the application actually calls is observed -- and a row naming only
  // `/api/session` cannot tell `session/prompt` from `session/selectModel`.
  if (/^\/api(?:\/|$)/.test(pathname)) return pathname.replace(/^(\/api\/[^/]+\/[^/]+).*$/, "$1");
  return `/asset${pathname.replace(/\/[^/]*$/, "/*")}`;
}

function proxyAuditTarget(suffix) {
  const pathname = suffix.split("?")[0] || "/";
  return pathname
    .replace(/^\/session\/[^/]+/, "/session/:id")
    .replace(/^\/question\/[^/]+/, "/question/:id")
    .replace(/^\/permission\/[^/]+/, "/permission/:id")
    .replace(/^\/auth\/[^/]+/, "/auth/:provider")
    .replace(/^\/provider\/[^/]+\/oauth\//, "/provider/:provider/oauth/");
}

function canRead(method) {
  return method === "GET" || method === "HEAD";
}

function isNonProductionDiagnosticRuntimeRoute(method, pathname, config) {
  if (config.production || !canRead(method)) return false;
  return ["/echo", "/redirect", "/slow-body", "/large-response"].includes(pathname);
}

function isAllowedRuntimeProxyRoute(method, suffix, config) {
  const pathname = suffix.split("?")[0] || "/";
  if (isNonProductionDiagnosticRuntimeRoute(method, pathname, config)) return true;

  if (canRead(method)) {
    return (
      pathname === "/event" ||
      pathname === "/config" ||
      pathname === "/config/providers" ||
      pathname === "/provider" ||
      pathname === "/provider/auth" ||
      pathname === "/agent" ||
      pathname === "/api/agent" ||
      pathname === "/command" ||
      pathname === "/mcp" ||
      pathname === "/session" ||
      pathname === "/session/status" ||
      pathname === "/experimental/session" ||
      pathname === "/question" ||
      pathname === "/permission" ||
      /^\/api\/skill(?:\/|$)/.test(pathname) ||
      /^\/session\/[^/]+\/message$/.test(pathname)
    );
  }

  if (method === "POST") {
    return (
      pathname === "/session" ||
      /^\/session\/[^/]+\/(?:prompt_async|command|abort|shell)$/.test(pathname) ||
      /^\/question\/[^/]+\/(?:reply|reject)$/.test(pathname) ||
      /^\/permission\/[^/]+\/reply$/.test(pathname)
    );
  }

  if (method === "DELETE") {
    return /^\/session\/[^/]+$/.test(pathname);
  }

  return false;
}

function runtimeProxyPayloadError(message) {
  return new HttpError(400, "invalid_runtime_proxy_payload", message);
}

function parseRuntimeProxyJsonBody(req) {
  const body = req.__openScienceProxyBody;
  if (!body || body.length === 0) return {};
  let parsed;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw runtimeProxyPayloadError("Runtime proxy request body must be a JSON object.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw runtimeProxyPayloadError("Runtime proxy request body must be a JSON object.");
  }
  return parsed;
}

function runtimeString(value, label, { optional = false, max = 4096 } = {}) {
  if (value == null && optional) return undefined;
  if (typeof value !== "string") {
    throw runtimeProxyPayloadError(`${label} must be a string.`);
  }
  if (value.length > max) {
    throw runtimeProxyPayloadError(`${label} is too long.`);
  }
  return value;
}

function runtimeArray(value, label, { max = 64 } = {}) {
  if (!Array.isArray(value)) {
    throw runtimeProxyPayloadError(`${label} must be an array.`);
  }
  if (value.length > max) {
    throw runtimeProxyPayloadError(`${label} has too many items.`);
  }
  return value;
}

function validatePromptPayload(body) {
  if ("prompt" in body) runtimeString(body.prompt, "prompt", { max: 256 * 1024 });
  if ("parts" in body) {
    const parts = runtimeArray(body.parts, "parts", { max: 64 });
    for (const part of parts) {
      if (!part || typeof part !== "object" || Array.isArray(part)) {
        throw runtimeProxyPayloadError("prompt parts must be objects.");
      }
      const type = runtimeString(part.type, "part.type", { max: 64 });
      if (type === "text") runtimeString(part.text, "part.text", { max: 256 * 1024 });
    }
  }
}

function validateQuestionReplyPayload(body) {
  const answers = runtimeArray(body.answers, "answers", { max: 64 });
  for (const group of answers) {
    const values = runtimeArray(group, "answers[]", { max: 64 });
    for (const value of values) runtimeString(value, "answer", { max: 1024 });
  }
}

function validateRuntimeProxyPayload(req, suffix) {
  const method = req.method ?? "GET";
  if (method !== "POST") return null;

  const pathname = suffix.split("?")[0] || "/";
  const body = parseRuntimeProxyJsonBody(req);

  if (pathname === "/session") return body;
  if (/^\/session\/[^/]+\/prompt_async$/.test(pathname)) {
    validatePromptPayload(body);
    return body;
  }
  if (/^\/session\/[^/]+\/command$/.test(pathname)) {
    runtimeString(body.command, "command", { max: 128 });
    runtimeString(body.arguments, "arguments", { optional: true, max: 64 * 1024 });
    return body;
  }
  if (/^\/session\/[^/]+\/shell$/.test(pathname)) {
    runtimeString(body.command, "command", { max: 16 * 1024 });
    runtimeString(body.agent, "agent", { optional: true, max: 128 });
    return body;
  }
  if (/^\/session\/[^/]+\/abort$/.test(pathname)) return body;
  if (/^\/question\/[^/]+\/reply$/.test(pathname)) {
    validateQuestionReplyPayload(body);
    return body;
  }
  if (/^\/question\/[^/]+\/reject$/.test(pathname)) return body;
  if (/^\/permission\/[^/]+\/reply$/.test(pathname)) {
    const reply = runtimeString(body.reply, "reply", { max: 16 });
    if (!["once", "always", "reject"].includes(reply)) {
      throw runtimeProxyPayloadError("reply must be once, always, or reject.");
    }
    return body;
  }

  return body;
}

function noWakeRuntimeProxyControl(method, suffix) {
  const pathname = suffix.split("?")[0] || "/";
  if (method === "POST" && /^\/session\/[^/]+\/abort$/.test(pathname)) {
    return { status: 200, body: true };
  }
  if (method === "DELETE" && /^\/session\/[^/]+$/.test(pathname)) {
    return { status: 200, body: true };
  }
  if (
    method === "POST" &&
    (
      /^\/question\/[^/]+\/(?:reply|reject)$/.test(pathname) ||
      /^\/permission\/[^/]+\/reply$/.test(pathname)
    )
  ) {
    return {
      status: 409,
      error: "runtime_not_running",
      message: "Runtime is not running for this project.",
    };
  }
  return null;
}

function abortedRuntimeSession(method, suffix) {
  if (method !== "POST") return null;
  const match = suffix.split("?")[0].match(/^\/session\/([^/]+)\/abort$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    throw runtimeProxyPayloadError("Runtime session id is invalid.");
  }
}

function requestContentLength(req) {
  const raw = req.headers["content-length"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function terminateChild(child, graceMs = 5_000) {
  return new Promise((resolve) => {
    if (!child || child.exitCode != null || child.signalCode != null) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, graceMs);
    child.once("exit", done);
    child.kill("SIGTERM");
  });
}

function waitForProcess(child, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: null, signal: "SIGKILL", error: null });
    }, timeoutMs);
    child.once("error", (error) => finish({ code: null, signal: null, error }));
    child.once("exit", (code, signal) => finish({ code, signal, error: null }));
  });
}

/** Tail size for a runtime's dying words. Shared with the runtime controller,
 *  which keeps one of these per container. */
export const RUNTIME_EXIT_OUTPUT_BYTES = 4096;

/** Keep the LAST `maxBytes` of a stream, not the first.
 *
 *  `appendCappedOutput` keeps the head, which is right for a short-lived
 *  process whose whole output fits. It is wrong for a runtime container: one
 *  that boots, prints a minute of startup chatter and then dies has its cause
 *  at the end, and a head-keeping buffer throws exactly that away — leaving a
 *  4KB tail full of "SQLite is an experimental feature".
 *  @param {string} current @param {unknown} chunk @param {number} maxBytes
 *  @returns {string} */
export function appendTailOutput(current, chunk, maxBytes) {
  const text = `${current}${Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)}`;
  const bytes = Buffer.from(text, "utf8");
  if (bytes.byteLength <= maxBytes) return text;
  // Decode from a byte offset that may split a character; `toString` replaces
  // the partial one, which costs a character and keeps the rest readable.
  return bytes.subarray(bytes.byteLength - maxBytes).toString("utf8");
}

export function appendCappedOutput(current, chunk, maxBytes) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  const existing = Buffer.byteLength(current);
  const remaining = maxBytes - existing;
  if (remaining <= 0) return current;
  return `${current}${buffer.subarray(0, remaining).toString("utf8")}`;
}

function waitForProcessWithOutput(child, timeoutMs = 10_000, maxOutputBytes = 4096) {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout = appendCappedOutput(stdout, chunk, maxOutputBytes);
  });
  child.stderr?.on("data", (chunk) => {
    stderr = appendCappedOutput(stderr, chunk, maxOutputBytes);
  });
  return waitForProcess(child, timeoutMs).then((result) => ({ ...result, stdout, stderr }));
}

async function appendRuntimeEvent(project, event, fields = {}, config = null) {
  const file = path.join(project.metaDir, "runtime.jsonl");
  await appendJsonLineNoFollow(project.rootDir, file, {
    createdAt: new Date().toISOString(),
    userId: project.userId,
    projectId: project.id,
    event,
    ...fields,
  }, {
    maxBytes: config?.maxLogFileBytes,
  }).catch(() => {});
}

/** The runtime ledger row writer, for a provider's own events. */
export const appendRuntimeEventForProvider = (project, event, fields = {}, config = null) => appendRuntimeEvent(project, event, fields, config);

function runtimeStateFile(project) {
  return path.join(project.metaDir, "runtime-state.json");
}

/**
 * The moments a runtime start goes through, in order (plan §3.1 #8):
 * `environment` (a container or a cloud session, and room made for it),
 * `sync` (the project's files carried into a remote session — a local
 * container mounts them, so the Docker provider has no such moment and never
 * reports it) and `kernel` (the kernel composing its plugin tree until its
 * first wire call answers). The shell times its wait by them, each moment
 * restarting the allowance, so a slow start that is moving is not a failure.
 * It no longer shows them: since 2026-09-23 the reader sees the
 * conversation's title and 「正在打开…」 (UI plan §2.2).
 */
export const RUNTIME_START_STAGES = Object.freeze(["environment", "sync", "kernel"]);

/** How long a refused start stays on the status the shell polls. Long enough
 *  for a frame that is still waiting to read it; short enough that a refusal
 *  from an earlier visit is not reported against a later one. */
const START_FAILURE_VISIBLE_MS = 60_000;

function publicRuntimeStatus(runtime, fields = {}) {
  return {
    running: Boolean(runtime),
    kind: runtime?.kind ?? null,
    startedAt: runtime?.startedAt ?? null,
    pid: runtime?.pid ?? null,
    exitedAt: runtime?.exitedAt ?? null,
    sandboxMode: runtime?.sandboxMode ?? null,
    networkMode: runtime?.networkMode ?? null,
    containerName: runtime?.containerName ?? null,
    stale: fields.stale ?? false,
    lastEvent: fields.lastEvent ?? null,
    lastUpdatedAt: fields.lastUpdatedAt ?? null,
    skillsCopied: Number.isSafeInteger(fields.skillsCopied) ? fields.skillsCopied : null,
    agentSkillsCopied: Number.isSafeInteger(fields.agentSkillsCopied) ? fields.agentSkillsCopied : null,
    agentsGenerated: Number.isSafeInteger(fields.agentsGenerated) ? fields.agentsGenerated : null,
    capsuleMethodsMounted: Number.isSafeInteger(fields.capsuleMethodsMounted) ? fields.capsuleMethodsMounted : null,
    error: fields.error ?? null,
    provider: fields.provider ?? null,
    startStage: fields.startStage ?? null,
    startError: fields.startError ?? null,
    // What a remote runtime's guest reported at start: its kernel release and
    // the Landlock level the kernel's write fence got there (plan §3.1 #9).
    sandbox: runtime?.sandbox ?? null,
  };
}

function publicRuntimeStatusFromState(state, fields = {}) {
  const wasRunning = state?.running === true || state?.event === "starting";
  return {
    running: false,
    kind: typeof state?.kind === "string" ? state.kind : null,
    startedAt: typeof state?.startedAt === "string" ? state.startedAt : null,
    pid: Number.isSafeInteger(state?.pid) ? state.pid : null,
    exitedAt: typeof state?.exitedAt === "string" ? state.exitedAt : null,
    sandboxMode: typeof state?.sandboxMode === "string" ? state.sandboxMode : null,
    networkMode: typeof state?.networkMode === "string" ? state.networkMode : null,
    containerName: typeof state?.containerName === "string" ? state.containerName : null,
    stale: wasRunning,
    lastEvent: typeof state?.event === "string" ? state.event : null,
    lastUpdatedAt: typeof state?.updatedAt === "string" ? state.updatedAt : null,
    skillsCopied: Number.isSafeInteger(state?.skillsCopied) ? state.skillsCopied : null,
    agentSkillsCopied: Number.isSafeInteger(state?.agentSkillsCopied) ? state.agentSkillsCopied : null,
    agentsGenerated: Number.isSafeInteger(state?.agentsGenerated) ? state.agentsGenerated : null,
    capsuleMethodsMounted: Number.isSafeInteger(state?.capsuleMethodsMounted) ? state.capsuleMethodsMounted : null,
    error: typeof state?.error === "string" ? state.error : wasRunning ? "runtime_not_attached" : null,
    provider: fields.provider ?? null,
    startStage: fields.startStage ?? null,
    startError: fields.startError ?? null,
    sandbox: state?.sandbox && typeof state.sandbox === "object" ? state.sandbox : null,
  };
}

function runtimeStateWasAttached(state) {
  return state?.running === true || state?.event === "starting";
}

async function readRuntimeState(project) {
  try {
    const raw = await readTextFileNoFollow(project.rootDir, runtimeStateFile(project), "");
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 1 || typeof parsed !== "object") return null;
    return parsed;
  } catch (err) {
    if (err?.code === "ENOENT" || err instanceof SyntaxError) return null;
    if (err instanceof HttpError) throw err;
    return null;
  }
}

async function writeRuntimeState(project, event, fields = {}) {
  const file = runtimeStateFile(project);
  await ensureDir(path.dirname(file));
  const state = {
    version: 1,
    updatedAt: new Date().toISOString(),
    userId: project.userId,
    projectId: project.id,
    event,
    running: fields.running === true,
    kind: fields.kind ?? null,
    startedAt: fields.startedAt ?? null,
    pid: fields.pid ?? null,
    exitedAt: fields.exitedAt ?? null,
    sandboxMode: fields.sandboxMode ?? null,
    networkMode: fields.networkMode ?? null,
    containerName: fields.containerName ?? null,
    skillsCopied: Number.isSafeInteger(fields.skillsCopied) ? fields.skillsCopied : null,
    agentSkillsCopied: Number.isSafeInteger(fields.agentSkillsCopied) ? fields.agentSkillsCopied : null,
    agentsGenerated: Number.isSafeInteger(fields.agentsGenerated) ? fields.agentsGenerated : null,
    // How many capsule methods this launch actually mounted. Recorded because
    // "the feature is dark" is otherwise invisible from outside the container:
    // an unassigned `capsuleService`, a capsule whose entries are all
    // candidates and a working mount all look identical from the API, and the
    // sibling plugin `guidance.mjs` reports the same class of fact through
    // `evimedDiagnostics.degrade` for the same reason.
    capsuleMethodsMounted: Number.isSafeInteger(fields.capsuleMethodsMounted) ? fields.capsuleMethodsMounted : null,
    // What a remote runtime's guest reported at start (plan §3.1 #9): its
    // kernel release and the Landlock level DSH's write fence gets there.
    sandbox: fields.sandbox && typeof fields.sandbox === "object" ? fields.sandbox : null,
    error: fields.error ?? null,
  };
  await writeJsonFileAtomicNoFollow(project.rootDir, file, state);
  return state;
}

async function recordRuntimeState(project, event, fields = {}) {
  await writeRuntimeState(project, event, fields).catch(() => {});
}

async function bufferProxyRequestBody(req, method, limit) {
  if (["GET", "HEAD"].includes(method)) return;
  const length = requestContentLength(req);
  if (length !== null && length > limit) {
    throw new HttpError(413, "runtime_proxy_body_too_large", "Runtime proxy request body is too large.");
  }
  // A policy may already have inspected the body. Keep those exact bytes;
  // rereading the drained stream would silently replace a valid RPC with empty input.
  if (Buffer.isBuffer(req.__openScienceProxyBody)) {
    if (req.__openScienceProxyBody.length > limit) throw new HttpError(413, "runtime_proxy_body_too_large", "Runtime proxy request body is too large.");
    return;
  }
  try {
    req.__openScienceProxyBody = await readBody(req, limit);
  } catch (err) {
    if (err instanceof HttpError && err.code === "body_too_large") {
      throw new HttpError(413, "runtime_proxy_body_too_large", "Runtime proxy request body is too large.");
    }
    throw err;
  }
}

/** One transcript page's byte ceiling. Transcript pages are the one payload
 *  that legitimately dwarfs every other kernel response — see the note at the
 *  session.history call — so they get their own bound instead of a global
 *  raise, which would let every OTHER endpoint balloon unnoticed. */
const HISTORY_PAGE_MAX_BYTES = 64 * 1024 * 1024;

export async function readRuntimeResponseBody(body, limit, onReader, onBytes) {
  const reader = body.getReader();
  onReader?.(reader);
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      onBytes?.(chunk.length, total);
      if (Number.isFinite(limit) && limit > 0 && total > limit) {
        throw new HttpError(413, "runtime_proxy_response_too_large", "Runtime proxy response body is too large.");
      }
      chunks.push(chunk);
    }
  } catch (error) {
    // A read this function abandons must die with it. `releaseLock()` alone
    // detaches the reader and leaves the response paused forever: the socket
    // under it never closes, and on a unix-socket runtime that is one leaked
    // fd on this side and one live `socat` fork inside the container.
    //
    // That was not hypothetical. A run's `session.history` grows with its
    // transcript; once it crossed `maxJsonBytes`, every poll threw 413 here,
    // the caller retried, and each retry parked another connection — measured
    // at 1368 leaked fds on the control plane and 555/665 socat forks in the
    // two containers they belonged to, still open after the containers died,
    // climbing at 87/min near the end. The pids ceiling those forks hit was
    // raised twice (256 -> 1024) before this line existed; the ceiling was
    // never the problem.
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    onReader?.(null);
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

export function runtimeContainerName(project) {
  const hash = createHash("sha256").update(project.rootDir ?? project.runtimeDir).digest("hex").slice(0, 10);
  const base = `open-science-${project.userId}-${project.id}-${hash}`
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, "-");
  return base.slice(0, 120);
}

function isMissingDockerContainer(stderr) {
  const text = String(stderr ?? "").toLowerCase();
  return (
    text.includes("no such container") ||
    text.includes("does not exist") ||
    text.includes("no container with name or id") ||
    text.includes("no container with name")
  );
}

function compactProcessError(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 512);
}

/** What a dying runtime said, with the parts that are never the answer removed.
 *
 *  A kernel's last words open with Node's experimental warnings and close with
 *  a stack trace repeated once per `cause` level; the sentence that names the
 *  cause sits between them. Compacting the raw text to 512 characters returned
 *  the warnings and cut off before the cause — the first real diagnosis this
 *  produced still had to be read by re-running the container by hand.
 *  @param {unknown} value @returns {string} */
function compactRuntimeOutput(value) {
  const lines = String(value ?? "")
    .split("\n")
    .filter((line) => !/^\s+at /.test(line))
    .filter((line) => !/ExperimentalWarning|--trace-warnings|^\s*\.\.\. \d+ lines/.test(line))
    .filter((line) => line.trim().length > 0);
  // Deduplicated because `cause` chains restate the same message at every level,
  // and three copies of one sentence crowd out everything else.
  return [...new Set(lines.map((line) => line.trim()))].join(" ").slice(0, 1200);
}

/** Why a runtime container died, in the message the caller actually receives.
 *
 *  This used to be the fixed sentence "Runtime exited before it became ready",
 *  which is the one fact the caller could already infer from the status code.
 *  Everything that would identify the cause — the exit status, whatever the
 *  container printed on its way out, the last readiness probe's complaint — was
 *  collected and then dropped. Diagnosing a container that refused to start
 *  meant re-running its `docker run` argv by hand off a `ps` capture, because
 *  the deployment keeps no other copy of it.
 *  @param {{ child?: { exitCode?: number|null, signalCode?: string|null, exitOutput?: string }|null }} runtime
 *  @param {unknown} lastError the last readiness probe failure, if there was one
 *  @returns {string} */
function runtimeExitDiagnosis(runtime, lastError) {
  const child = runtime.child;
  const how = child?.signalCode
    ? `on ${child.signalCode}`
    : `with exit code ${child?.exitCode ?? "unknown"}`;
  const said = compactRuntimeOutput(child?.exitOutput);
  const probe = lastError instanceof Error ? compactProcessError(lastError.message) : "";
  return [
    `Runtime exited ${how} before it became ready.`,
    said ? `Runtime output: ${said}` : "",
    // Only when the container said nothing: a probe error next to a real
    // message is noise, since a container that died mid-probe always produces
    // one and it is always the same connection failure.
    !said && probe ? `Last readiness probe: ${probe}` : "",
  ].filter(Boolean).join(" ");
}

export async function cleanupDockerContainer(plan) {
  if (!plan.containerName) {
    return { cleaned: false, missing: false, failed: false, reason: "no_container_name", code: null, signal: null, error: null };
  }
  const child = spawn(plan.command, ["rm", "-f", plan.containerName], {
    cwd: plan.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: plan.env,
  });
  const result = await waitForProcessWithOutput(child);
  const stderr = compactProcessError(result.stderr);
  const stdout = compactProcessError(result.stdout);
  if (result.error) {
    return {
      cleaned: false,
      missing: false,
      failed: true,
      reason: "spawn_failed",
      code: result.code,
      signal: result.signal,
      error: result.error instanceof Error ? result.error.message : String(result.error),
      stderr,
      stdout,
    };
  }
  if (result.code === 0) {
    return { cleaned: true, missing: false, failed: false, reason: "removed", code: result.code, signal: result.signal, error: null, stderr, stdout };
  }
  if (isMissingDockerContainer(stderr)) {
    return { cleaned: false, missing: true, failed: false, reason: "missing", code: result.code, signal: result.signal, error: null, stderr, stdout };
  }
  return {
    cleaned: false,
    missing: false,
    failed: true,
    reason: "rm_failed",
    code: result.code,
    signal: result.signal,
    error: stderr || stdout || `container cleanup failed with exit code ${result.code}`,
    stderr,
    stdout,
  };
}

function dockerSecurityArgs(config) {
  const args = [];
  if (config.runtimeNoNewPrivileges !== false) {
    args.push("--security-opt", "no-new-privileges");
  }
  if (config.runtimeCapDrop) {
    args.push("--cap-drop", String(config.runtimeCapDrop));
  }
  if (Number.isFinite(config.runtimePidsLimit) && config.runtimePidsLimit > 0) {
    args.push("--pids-limit", String(config.runtimePidsLimit));
  }
  if (config.runtimeReadOnlyRoot !== false) {
    args.push("--read-only");
  }
  if (config.runtimeTmpfs) {
    args.push("--tmpfs", String(config.runtimeTmpfs));
  }
  if (config.runtimeContainerUser) {
    args.push("--user", String(config.runtimeContainerUser));
  }
  return args;
}

// How many consecutive quota measurements must fail before the guard stops a
// runtime. One failure is a busy workspace; three in a row is a workspace the
// server genuinely cannot read.
const quotaCheckFailureTolerance = 3;
/**
 * The seven science connectors, as this server declares them.
 *
 * Exported, and this is not tidiness: nothing in this module calls it, so
 * ESLint reported it as an unused variable and it was deleted on that basis —
 * which broke `hosted_science_connector_chain` in the source audit, because
 * `scripts/ops/audit-hosted-compliance.mjs` reads this file **as text** and
 * requires the roster to be here so that the server and
 * `runtime/mcp/evimed-research/science_connectors.py` cannot silently disagree
 * about which seven exist. A linter sees code references; it cannot see a
 * cross-file audit, so "unused" was true of this module and false of the
 * system. Exporting it gives the roster a real consumer — the test below
 * cross-checks it against the Python source — so the next reader finds a
 * declaration with a purpose rather than one that only survives a grep.
 */
export const SCIENCE_CONNECTORS = Object.freeze([
  "paper-search",
  "biomcp",
  "materials-project",
  "fred",
  "spaceweather",
  "open-meteo",
  "usgs-water",
]);

const evimedWorkloadAudience = "evimed-adapter";
const modelGatewayAudience = "evimed-model-gateway";
const evimedWorkloadTokenFileName = "evimed-workload.token";
const evimedAdapterEnvironment = Object.freeze({
  biomedicalSourceSearch: "EVIMED_BIOMEDICAL_SOURCE_SEARCH_URL",
  literatureSearch: "EVIMED_LITERATURE_SEARCH_URL",
  guidelineSearch: "EVIMED_GUIDELINE_SEARCH_URL",
  clinicalTrialSearch: "EVIMED_CLINICAL_TRIAL_SEARCH_URL",
  patentSearch: "EVIMED_PATENT_SEARCH_URL",
  pharmacyReferenceSearch: "EVIMED_PHARMACY_REFERENCE_SEARCH_URL",
  drugLabelSearch: "EVIMED_DRUG_LABEL_SEARCH_URL",
  adrCaseQuery: "EVIMED_ADR_CASE_QUERY_URL",
  adrSignalAnalysis: "EVIMED_ADR_SIGNAL_ANALYSIS_URL",
  offlabelEvidencePacket: "EVIMED_OFFLABEL_EVIDENCE_PACKET_URL",
  comprehensiveDrugEvaluation: "EVIMED_COMPREHENSIVE_DRUG_EVALUATION_URL",
  drugSelectionEvaluation: "EVIMED_DRUG_SELECTION_EVALUATION_URL",
  metaAnalysis: "EVIMED_META_ANALYSIS_URL",
  mendelianRandomization: "EVIMED_MR_ANALYSIS_URL",
  bibliometricAnalysis: "EVIMED_BIBLIOMETRIC_ANALYSIS_URL",
  researchTopicSelection: "EVIMED_RESEARCH_TOPIC_SELECTION_URL",
  peerReview: "EVIMED_PEER_REVIEW_URL",
  drugSafetyAnalysis: "EVIMED_DRUG_SAFETY_ANALYSIS_URL",
});
const evimedRequiredSpecialistAdapters = Object.freeze([
  "adrCaseQuery",
  "adrSignalAnalysis",
  "offlabelEvidencePacket",
  "comprehensiveDrugEvaluation",
  "drugSelectionEvaluation",
  "metaAnalysis",
  "mendelianRandomization",
  "bibliometricAnalysis",
  "researchTopicSelection",
  "peerReview",
  "drugSafetyAnalysis",
]);
const evimedSpecialistEnvironment = Object.freeze({
  mendelianRandomization: {
    root: "EVIMED_MR_AGENT_ROOT",
    python: "EVIMED_MR_AGENT_PYTHON",
  },
  bibliometricAnalysis: {
    root: "EVIMED_BIBLIOMETRIC_AGENT_ROOT",
    python: "EVIMED_BIBLIOMETRIC_AGENT_PYTHON",
  },
  researchTopicSelection: {
    root: "EVIMED_RESEARCH_TOPIC_AGENT_ROOT",
    python: "EVIMED_RESEARCH_TOPIC_AGENT_PYTHON",
  },
  peerReview: {
    root: "EVIMED_PEER_REVIEW_AGENT_ROOT",
    python: "EVIMED_PEER_REVIEW_AGENT_PYTHON",
  },
  drugSafetyAnalysis: {
    root: "EVIMED_DRUG_SAFETY_AGENT_ROOT",
    python: "EVIMED_DRUG_SAFETY_AGENT_PYTHON",
  },
});

function runtimeMcpError(code, message, status = 500) {
  return new HttpError(status, code, message);
}

function workloadTokenError() {
  return runtimeMcpError(
    "evimed_workload_token_invalid",
    "EviMed workload token is invalid for the requested runtime scope.",
    401,
  );
}

function validatedWorkloadSecret(secret) {
  if (
    typeof secret !== "string" ||
    secret !== secret.trim() ||
    /[\r\n\0]/.test(secret) ||
    Buffer.byteLength(secret, "utf8") < 32
  ) {
    throw runtimeMcpError(
      "runtime_mcp_workload_secret_invalid",
      "EviMed workload signing secret must contain at least 32 valid bytes.",
    );
  }
  return secret;
}

function workloadSignature(input, secret) {
  return createHmac("sha256", secret).update(input).digest("base64url");
}

export function issueEviMedWorkloadToken({
  secret,
  userId,
  projectId,
  nowSeconds = Math.floor(Date.now() / 1000),
  ttlSeconds = 300,
  jti = randomId("jwt_"),
}) {
  const signingSecret = validatedWorkloadSecret(secret);
  const issuedAt = Math.floor(Number(nowSeconds));
  const ttl = Math.floor(Number(ttlSeconds));
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(ttl) || ttl < 30 || ttl > 900) {
    throw runtimeMcpError("runtime_mcp_workload_ttl_invalid", "EviMed workload token TTL must be 30 to 900 seconds.");
  }
  if (typeof userId !== "string" || !userId || typeof projectId !== "string" || !projectId) {
    throw runtimeMcpError("runtime_mcp_workload_scope_invalid", "EviMed workload token scope is invalid.");
  }
  if (typeof jti !== "string" || !/^[A-Za-z0-9_-]{3,256}$/.test(jti)) {
    throw runtimeMcpError("runtime_mcp_workload_jti_invalid", "EviMed workload token id is invalid.");
  }
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = {
    v: 1,
    aud: evimedWorkloadAudience,
    userId,
    projectId,
    iat: issuedAt,
    exp: issuedAt + ttl,
    jti,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signed = `${header}.${body}`;
  return `${signed}.${workloadSignature(signed, signingSecret)}`;
}

/** TypeScript infers a destructured parameter as exactly the shape its
 *  defaults name, which rejects every other property a caller passes.
 *  @param {any} token
 *  @param {Record<string, any>} options1
 */
export function verifyEviMedWorkloadToken(token, {
  secret,
  audience = evimedWorkloadAudience,
  userId,
  projectId,
  nowSeconds = Math.floor(Date.now() / 1000),
  allowExpired = false,
} = {}) {
  try {
    const signingSecret = validatedWorkloadSecret(secret);
    if (typeof token !== "string" || token.length > 8 * 1024) throw workloadTokenError();
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some((part) => !part)) throw workloadTokenError();
    const [headerPart, bodyPart, signaturePart] = parts;
    const expectedSignature = workloadSignature(`${headerPart}.${bodyPart}`, signingSecret);
    const actual = Buffer.from(signaturePart);
    const expected = Buffer.from(expectedSignature);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw workloadTokenError();
    const header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8"));
    const payload = JSON.parse(Buffer.from(bodyPart, "base64url").toString("utf8"));
    if (
      header?.alg !== "HS256" ||
      header?.typ !== "JWT" ||
      Object.keys(header).length !== 2 ||
      payload == null ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      Object.keys(payload).sort().join(",") !== "aud,exp,iat,jti,projectId,userId,v" ||
      payload.v !== 1 ||
      payload.aud !== audience ||
      payload.userId !== userId ||
      payload.projectId !== projectId ||
      !Number.isSafeInteger(payload.iat) ||
      !Number.isSafeInteger(payload.exp) ||
      payload.exp <= payload.iat ||
      payload.exp - payload.iat > 900 ||
      typeof payload.jti !== "string" ||
      !/^[A-Za-z0-9_-]{3,256}$/.test(payload.jti)
    ) throw workloadTokenError();
    const now = Math.floor(Number(nowSeconds));
    if (!Number.isSafeInteger(now) || payload.iat > now + 30 || (!allowExpired && payload.exp <= now)) {
      throw workloadTokenError();
    }
    return payload;
  } catch (error) {
    if (error?.code === "evimed_workload_token_invalid") throw error;
    throw workloadTokenError();
  }
}

function modelGatewayTokenError() {
  return new HttpError(401, "model_gateway_token_invalid", "Model gateway token is invalid or inactive.");
}

function validatedModelGatewaySecret(secret) {
  if (
    typeof secret !== "string" ||
    secret !== secret.trim() ||
    /[\r\n\0]/.test(secret) ||
    Buffer.byteLength(secret, "utf8") < 32
  ) {
    throw new HttpError(
      500,
      "runtime_model_gateway_signing_secret_invalid",
      "Model gateway signing secret must contain at least 32 valid bytes.",
    );
  }
  return secret;
}

export function issueModelGatewayRuntimeToken({
  secret,
  userId,
  projectId,
  budgetScope = null,
  nowSeconds = Math.floor(Date.now() / 1000),
  jti = randomId("mgw_"),
}) {
  const signingSecret = validatedModelGatewaySecret(secret);
  const issuedAt = Math.floor(Number(nowSeconds));
  if (!Number.isSafeInteger(issuedAt)) throw new HttpError(500, "runtime_model_gateway_time_invalid", "Model gateway token time is invalid.");
  if (typeof userId !== "string" || !userId || typeof projectId !== "string" || !projectId) {
    throw new HttpError(500, "runtime_model_gateway_scope_invalid", "Model gateway token scope is invalid.");
  }
  if (typeof jti !== "string" || !/^[A-Za-z0-9_-]{3,256}$/.test(jti)) {
    throw new HttpError(500, "runtime_model_gateway_jti_invalid", "Model gateway token id is invalid.");
  }
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = {
    v: 1,
    aud: modelGatewayAudience,
    userId,
    projectId,
    iat: issuedAt,
    jti,
    ...(budgetScope ? {
      runId: safeId(budgetScope.runId, "bounded run id"),
      dailyLimit: Number(budgetScope.dailyLimit),
      weeklyLimit: Number(budgetScope.weeklyLimit),
      runLimit: Number(budgetScope.runLimit),
    } : {}),
  };
  if (budgetScope && [payload.dailyLimit, payload.weeklyLimit, payload.runLimit].some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new HttpError(500, "runtime_model_gateway_scope_invalid", "Model gateway budget scope is invalid.");
  }
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signed = `${header}.${body}`;
  return `${signed}.${workloadSignature(signed, signingSecret)}`;
}

/** TypeScript infers a destructured parameter as exactly the shape its
 *  defaults name, which rejects every other property a caller passes.
 *  @param {any} token
 *  @param {Record<string, any>} options1
 */
export function verifyModelGatewayRuntimeToken(token, {
  secret,
  userId,
  projectId,
  nowSeconds = Math.floor(Date.now() / 1000),
} = {}) {
  try {
    const signingSecret = validatedModelGatewaySecret(secret);
    if (typeof token !== "string" || token.length > 8 * 1024) throw modelGatewayTokenError();
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some((part) => !part)) throw modelGatewayTokenError();
    const [headerPart, bodyPart, signaturePart] = parts;
    const expectedSignature = workloadSignature(`${headerPart}.${bodyPart}`, signingSecret);
    const actual = Buffer.from(signaturePart);
    const expected = Buffer.from(expectedSignature);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw modelGatewayTokenError();
    const header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8"));
    const payload = JSON.parse(Buffer.from(bodyPart, "base64url").toString("utf8"));
    if (
      header?.alg !== "HS256" ||
      header?.typ !== "JWT" ||
      Object.keys(header).length !== 2 ||
      payload == null ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      !["aud,iat,jti,projectId,userId,v", "aud,dailyLimit,iat,jti,projectId,runId,runLimit,userId,v,weeklyLimit"]
        .includes(Object.keys(payload).sort().join(",")) ||
      payload.v !== 1 ||
      payload.aud !== modelGatewayAudience ||
      (userId != null && payload.userId !== userId) ||
      (projectId != null && payload.projectId !== projectId) ||
      typeof payload.userId !== "string" ||
      !payload.userId ||
      typeof payload.projectId !== "string" ||
      !payload.projectId ||
      !Number.isSafeInteger(payload.iat) ||
      typeof payload.jti !== "string" ||
      !/^[A-Za-z0-9_-]{3,256}$/.test(payload.jti)
    ) throw modelGatewayTokenError();
    if (payload.runId != null && (typeof payload.runId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(payload.runId)
      || [payload.dailyLimit, payload.weeklyLimit, payload.runLimit].some((value) => !Number.isFinite(value) || value <= 0))) {
      throw modelGatewayTokenError();
    }
    const now = Math.floor(Number(nowSeconds));
    if (!Number.isSafeInteger(now) || payload.iat > now + 30) throw modelGatewayTokenError();
    return payload;
  } catch (error) {
    if (error?.code === "model_gateway_token_invalid") throw error;
    throw modelGatewayTokenError();
  }
}

export function evimedWorkloadRefreshIntervalMs(config) {
  const ttl = Math.floor(Number(config.evimedWorkloadTokenTtlSeconds ?? 300));
  if (!Number.isSafeInteger(ttl) || ttl < 30 || ttl > 900) {
    throw runtimeMcpError(
      "runtime_mcp_workload_ttl_invalid",
      "EviMed workload token TTL must be 30 to 900 seconds.",
    );
  }
  return Math.floor(ttl * 1000 / 2);
}

/** TypeScript infers a destructured parameter as exactly the shape its
 *  defaults name, which rejects every other property a caller passes.
 *  @param {any} config
 *  @param {any} project
 *  @param {any} tokenFile
 *  @param {Record<string, any>} options3
 */
export async function refreshEviMedWorkloadToken(
  config,
  project,
  tokenFile,
  {
    nowSeconds = Math.floor(Date.now() / 1000),
    jti = randomId("jwt_"),
    writeToken = writeFileAtomicNoFollow,
    ttlSeconds = config.evimedWorkloadTokenTtlSeconds ?? 300,
  } = {},
) {
  const token = issueEviMedWorkloadToken({
    secret: config.evimedWorkloadSigningSecret,
    userId: String(project.userId),
    projectId: String(project.id),
    nowSeconds,
    ttlSeconds,
    jti,
  });
  await writeToken(project.rootDir, tokenFile, `${token}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return {
    token,
    payload: verifyEviMedWorkloadToken(token, {
      secret: config.evimedWorkloadSigningSecret,
      userId: String(project.userId),
      projectId: String(project.id),
      nowSeconds,
    }),
  };
}

/**
 * `EVIMED_DISABLED_TOOLS` for the kernel process, which the guidance row reads
 * to keep a capability out of the catalogue when its module's tools are off.
 * The value is the MCP server's own (`evimedMcpEnvironment`), so the two cannot
 * disagree. A configuration that makes that function throw fails the launch
 * where the profile is written (`dshProfileInput`), with its own error; here
 * the plain configured list stands in so the argv can still be built.
 * @param {Record<string, any>} config @param {Record<string, any>} project @param {string} sandboxMode
 */
function kernelDisabledTools(config, project, sandboxMode) {
  try {
    return evimedMcpEnvironment(config, project, { proxyWorkspaceDir: "/workspace", sandboxMode, gateways: null }).EVIMED_DISABLED_TOOLS ?? "";
  } catch {
    return String(config.evimedDisabledTools ?? "");
  }
}

/**
 * @param {any} config @param {any} project @param {any} plan
 * @param {{ workloadTokenPath?: string }} [options] `workloadTokenPath` is the
 *   container path of the MCP's workload token file. It is passed in rather
 *   than derived here because it lives under `$DSH_HOME`, which only the
 *   launch plan knows.
 */
function evimedMcpEnvironment(config, project, plan, { workloadTokenPath } = {}) {
  const environment = {
    OPEN_SCIENCE_TENANT_ID: String(project.tenantId ?? project.userId),
    OPEN_SCIENCE_USER_ID: String(project.userId),
    OPEN_SCIENCE_PROJECT_ID: String(project.id),
    OPEN_SCIENCE_WORKSPACE_DIR: String(plan.proxyWorkspaceDir),
  };
  // A remote session reaches every gateway through the public prefix
  // (`plan.gateways`, plan §3.1 #5); a container reaches them by name.
  const gateways = plan.gateways ?? null;
  // Neither a container nor a remote session can see a path on this host.
  const containerized = plan.sandboxMode === "docker" || plan.sandboxMode === "agentbay";
  const publicSourceGatewayUrl = gateways ? String(gateways.publicSource ?? "") : publicSourceGatewayProviderUrl(config);
  if (publicSourceGatewayUrl) {
    environment.EVIMED_PUBLIC_SOURCE_GATEWAY_URL = publicSourceGatewayUrl;
    // Open-web search rides the same runtime token as the source gateway, and
    // is only offered when the deployment actually has a metasearch backend.
    // Its URL is the server's own route: the runtime never learns which
    // aggregator, or which engines, sit behind it.
    if (String(config.webSearchUrl ?? "").trim()) {
      const webSearchGatewayUrl = String(gateways ? gateways.webSearch ?? "" : config.webSearchGatewayInternalUrl ?? "").trim();
      let parsedSearch;
      try {
        parsedSearch = new URL(webSearchGatewayUrl);
      } catch {
        throw runtimeMcpError(
          "runtime_web_search_gateway_url_invalid",
          "The web-search gateway URL must be an absolute HTTP(S) URL.",
        );
      }
      if (!["http:", "https:"].includes(parsedSearch.protocol) || parsedSearch.username || parsedSearch.password) {
        throw runtimeMcpError(
          "runtime_web_search_gateway_url_invalid",
          "The web-search gateway URL must be an HTTP(S) URL without embedded credentials.",
        );
      }
      environment.EVIMED_WEB_SEARCH_GATEWAY_URL = webSearchGatewayUrl;
    }
    // The GEO probe rides the same runtime token. It is offered only when the
    // deployment actually runs a probe host, because a runtime that can call
    // the tool but gets nothing back is worse than one that cannot: a run
    // reads an unreachable channel as a channel where nobody mentions the
    // product.
    if (String(config.geoProbeUrl ?? "").trim()) {
      const geoProbeGatewayUrl = String(gateways ? gateways.geoProbe ?? "" : config.geoProbeGatewayInternalUrl ?? "").trim();
      let parsedProbe;
      try {
        parsedProbe = new URL(geoProbeGatewayUrl);
      } catch {
        throw runtimeMcpError(
          "runtime_geo_probe_gateway_url_invalid",
          "The GEO probe gateway URL must be an absolute HTTP(S) URL.",
        );
      }
      if (!["http:", "https:"].includes(parsedProbe.protocol) || parsedProbe.username || parsedProbe.password) {
        throw runtimeMcpError(
          "runtime_geo_probe_gateway_url_invalid",
          "The GEO probe gateway URL must be an HTTP(S) URL without embedded credentials.",
        );
      }
      environment.EVIMED_GEO_PROBE_GATEWAY_URL = geoProbeGatewayUrl;
    }
    // Knowledge-base search rides the same runtime token. Absent when the
    // switch is off, so the tool says "disabled" without asking.
    const kbSearchGatewayUrl = gateways ? String(gateways.kbSearch ?? "") : kbSearchGatewayProviderUrl(config);
    if (kbSearchGatewayUrl) environment.EVIMED_KB_SEARCH_GATEWAY_URL = kbSearchGatewayUrl;
    // So does 「前沿动态」 search, and it is absent for the same reason — and
    // also for an account the module is not open to yet (the operators-only
    // dry run): that runtime's tool answers `frontier_disabled` without asking
    // rather than asking to be refused.
    const frontierGatewayUrl = gateways ? String(gateways.frontier ?? "") : frontierGatewayProviderUrl(config);
    if (frontierGatewayUrl && frontierAudienceAllows(config, { id: String(project.userId ?? "") })) {
      environment.EVIMED_FRONTIER_GATEWAY_URL = frontierGatewayUrl;
    }
    // 「循证 GEO」's three tools ride the same token, and are given an address
    // on the same terms as the frontier's: the module on and open to this
    // account. Whether the project is a GEO project is the gateway's answer
    // (`geo_no_project`), not a reason to leave the address out.
    const geoGatewayUrl = gateways ? String(gateways.geo ?? "") : geoGatewayProviderUrl(config);
    if (geoGatewayUrl && geoAudienceAllows(config, { id: String(project.userId ?? "") })) {
      environment.EVIMED_GEO_GATEWAY_URL = geoGatewayUrl;
    }
  }
  // Keyless-public Unpaywall tier: when the operator configured an email, the
  // runtime MCP may query Unpaywall anonymously (email param) even without a
  // managed gateway credential.
  const unpaywallEmail = String(config.publicSourceCredentials?.unpaywall ?? "").trim();
  if (unpaywallEmail) {
    if (/[\r\n\0]/.test(unpaywallEmail)) {
      throw runtimeMcpError("runtime_unpaywall_email_invalid", "The Unpaywall email must not contain control characters.");
    }
    environment.EVIMED_UNPAYWALL_EMAIL = unpaywallEmail;
  }
  const configured = config.evimedAdapterUrls ?? {};
  const pharmacyReferenceDb = String(config.pharmacyReferenceDb ?? "").trim();
  if (pharmacyReferenceDb) {
    if (!path.isAbsolute(pharmacyReferenceDb) || /[\r\n\0]/.test(pharmacyReferenceDb)) {
      throw runtimeMcpError(
        "runtime_pharmacy_reference_invalid",
        "The pharmacy reference database must be an absolute path.",
      );
    }
    if (containerized) {
      if (!String(configured.pharmacyReferenceSearch ?? "").trim()) {
        throw runtimeMcpError(
          "runtime_pharmacy_reference_adapter_required",
          "Docker runtimes require EVIMED_PHARMACY_REFERENCE_SEARCH_URL; a host database is not container-visible.",
        );
      }
    } else {
      let metadata;
      try {
        metadata = lstatSync(pharmacyReferenceDb);
      } catch {
        throw runtimeMcpError(
          "runtime_pharmacy_reference_invalid",
          "The pharmacy reference database is unavailable.",
        );
      }
      if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size <= 0 || metadata.size > 256 * 1024 * 1024) {
        throw runtimeMcpError(
          "runtime_pharmacy_reference_invalid",
          "The pharmacy reference database must be a bounded regular file.",
        );
      }
      environment.EVIMED_PHARMACY_REFERENCE_DB = pharmacyReferenceDb;
    }
  }
  const metaAgentRoot = String(config.metaAgentRoot ?? "").trim();
  if (metaAgentRoot) {
    if (!path.isAbsolute(metaAgentRoot) || /[\r\n\0]/.test(metaAgentRoot)) {
      throw runtimeMcpError("runtime_meta_agent_root_invalid", "MetaAgent root must be an absolute path.");
    }
    if (containerized) {
      if (!String(configured.metaAnalysis ?? "").trim()) {
        throw runtimeMcpError(
          "runtime_meta_agent_adapter_required",
          "Docker runtimes require EVIMED_META_ANALYSIS_URL; a host MetaAgent path is not container-visible.",
        );
      }
    } else {
      environment.EVIMED_META_AGENT_ROOT = metaAgentRoot;
      const metaAgentPython = String(config.metaAgentPython ?? "").trim();
      if (metaAgentPython) {
        if (!path.isAbsolute(metaAgentPython) || /[\r\n\0]/.test(metaAgentPython)) {
          throw runtimeMcpError("runtime_meta_agent_python_invalid", "MetaAgent Python must be an absolute path.");
        }
        environment.EVIMED_META_AGENT_PYTHON = metaAgentPython;
      }
    }
  }
  for (const [key, names] of Object.entries(evimedSpecialistEnvironment)) {
    const specialist = config.specialistAgents?.[key] ?? {};
    const specialistRoot = String(specialist.root ?? "").trim();
    if (!specialistRoot) continue;
    if (!path.isAbsolute(specialistRoot) || /[\r\n\0]/.test(specialistRoot)) {
      throw runtimeMcpError("runtime_specialist_agent_root_invalid", `${key} root must be an absolute path.`);
    }
    if (containerized) {
      if (!String(configured[key] ?? "").trim()) {
        throw runtimeMcpError(
          "runtime_specialist_agent_adapter_required",
          `Docker runtimes require ${evimedAdapterEnvironment[key]}; a host specialist path is not container-visible.`,
        );
      }
      continue;
    }
    environment[names.root] = specialistRoot;
    const specialistPython = String(specialist.python ?? "").trim();
    if (specialistPython) {
      if (!path.isAbsolute(specialistPython) || /[\r\n\0]/.test(specialistPython)) {
        throw runtimeMcpError("runtime_specialist_agent_python_invalid", `${key} Python must be an absolute path.`);
      }
      environment[names.python] = specialistPython;
    }
  }
  validateEviMedAdapterConfig(config);
  const signingSecret = String(config.evimedWorkloadSigningSecret ?? "");
  if (signingSecret) {
    if (!workloadTokenPath) {
      throw runtimeMcpError("runtime_mcp_workload_token_path_missing", "The MCP workload token path was not supplied.");
    }
    environment.EVIMED_WORKLOAD_TOKEN_FILE = workloadTokenPath;
  }
  // The gateway token travels in a file of its own. The retired kernel wrote a
  // config file the MCP parsed for the same three facts; naming them separately
  // means the MCP never has to parse a kernel's configuration to learn which
  // gateway it is talking to.
  if (config.modelGatewaySigningSecret) {
    environment.EVIMED_MODEL_GATEWAY_TOKEN_FILE = `${runtimeDshHome}/${modelGatewayTokenFileName}`;
  }
  environment.EVIMED_MODEL_GATEWAY_URL = gateways ? String(gateways.model) : modelGatewayProviderUrl(config);
  environment.EVIMED_MODEL_GATEWAY_MODEL = String(config.deepseekModel ?? "");
  // Set even when empty, unlike the adapter URLs below. A container that keeps
  // a value from a previous deployment because the new one had nothing to say
  // is the shape of "the lever was moved and nothing happened"; an explicit
  // empty string is the deployment saying "everything is offered".
  environment.EVIMED_DISABLED_TOOLS = String(config.evimedDisabledTools ?? "");
  // `OPEN_SCIENCE_WEB_READ_ENABLED=false` is the one switch for web reading
  // (plan §3.5): the gateway refuses the mode, and the tool is not offered.
  if (config.webReadEnabled === false) {
    environment.EVIMED_DISABLED_TOOLS = [...new Set([...environment.EVIMED_DISABLED_TOOLS.split(",").filter(Boolean), "web_read"])].join(",");
  }
  // 「前沿动态」 search is offered only where its gateway address was given
  // above: the module on and the account in its audience. Listed anyway, its
  // schema cost every root request about 1,400 characters (the first
  // request's prefill pays for the whole catalogue) for a tool that could only
  // answer `frontier_disabled`. `OPTIONAL_TOOLS` in the MCP server lets the
  // release audit count it as not offered.
  if (!environment.EVIMED_FRONTIER_GATEWAY_URL) {
    environment.EVIMED_DISABLED_TOOLS = [...new Set([...environment.EVIMED_DISABLED_TOOLS.split(",").filter(Boolean), "frontier_search"])].join(",");
  }
  // 「循证 GEO」's tools likewise: offered only where their gateway address
  // was given above, and the social search only where the deployment has a
  // social channel — a tool that can only answer 「无信号」 is not offered.
  // `OPTIONAL_TOOLS` in the MCP server lets the release audit count them.
  const geoDisabled = !environment.EVIMED_GEO_GATEWAY_URL
    ? ["geo_read", "geo_write", "social_posts_search"]
    : String(config.geoSocialUrl ?? "").trim() ? [] : ["social_posts_search"];
  if (geoDisabled.length) {
    environment.EVIMED_DISABLED_TOOLS = [...new Set([...environment.EVIMED_DISABLED_TOOLS.split(",").filter(Boolean), ...geoDisabled])].join(",");
  }
  for (const [key, envName] of Object.entries(evimedAdapterEnvironment)) {
    const value = String((gateways ? gateways.adapters?.[key] : configured[key]) ?? "").trim();
    if (!value) continue;
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw runtimeMcpError("runtime_mcp_adapter_url_invalid", `${envName} must be an absolute HTTP(S) URL.`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw runtimeMcpError(
        "runtime_mcp_adapter_url_invalid",
        `${envName} must be an HTTP(S) URL without embedded credentials.`,
      );
    }
    environment[envName] = value;
  }
  return environment;
}

export function validateEviMedAdapterConfig(config) {
  const configured = config.evimedAdapterUrls ?? {};
  const enabledAdapters = Object.entries(evimedAdapterEnvironment)
    .filter(([key]) => String(configured[key] ?? "").trim());
  const missingSpecialistAdapters = config.requireAllSpecialistAdapters
    ? evimedRequiredSpecialistAdapters.filter((key) => !String(configured[key] ?? "").trim())
    : [];
  if (missingSpecialistAdapters.length) {
    const missingEnvironment = missingSpecialistAdapters.map((key) => evimedAdapterEnvironment[key]);
    throw runtimeMcpError(
      "runtime_specialist_adapters_missing",
      `Production specialist release requires: ${missingEnvironment.join(", ")}`,
    );
  }
  if (enabledAdapters.length && config.evimedWorkloadSigningSecretError) {
    throw runtimeMcpError(
      config.evimedWorkloadSigningSecretError,
      "EviMed workload signing secret could not be loaded.",
    );
  }
  const signingSecret = String(config.evimedWorkloadSigningSecret ?? "");
  if (enabledAdapters.length && config.production && !signingSecret) {
    throw runtimeMcpError(
      "runtime_mcp_workload_secret_missing",
      "Production EviMed adapters require a workload signing secret.",
    );
  }
  if (signingSecret) validatedWorkloadSecret(signingSecret);
  const ttl = Math.floor(Number(config.evimedWorkloadTokenTtlSeconds ?? 300));
  if (signingSecret && (!Number.isSafeInteger(ttl) || ttl < 30 || ttl > 900)) {
    throw runtimeMcpError(
      "runtime_mcp_workload_ttl_invalid",
      "EviMed workload token TTL must be 30 to 900 seconds.",
    );
  }
  return {
    enabledAdapters: enabledAdapters.length,
    specialistAdaptersRequired: Boolean(config.requireAllSpecialistAdapters),
    tokenRequired: enabledAdapters.length > 0,
  };
}

function modelGatewayProviderUrl(config) {
  let url;
  try {
    url = new URL(String(config.modelGatewayInternalUrl ?? ""));
  } catch {
    throw new HttpError(500, "runtime_model_gateway_url_invalid", "Model gateway internal URL is invalid.");
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new HttpError(500, "runtime_model_gateway_url_invalid", "Model gateway internal URL is invalid.");
  }
  return url.toString().replace(/\/$/, "");
}

/** @param {any} config */
/**
 * The open-web search gateway, as the runtime is allowed to know it.
 *
 * Empty unless the deployment actually has a metasearch backend: a runtime that
 * can reach the route but gets nothing back is worse than one that cannot,
 * because a run reads an unreachable channel as a channel where nobody said
 * anything. Same rule the MCP environment already applied — this exists because
 * the *container* environment did not apply it and did not carry the variable
 * at all, so `evimed-web` registered its fetch provider and silently never
 * registered its search one.
 *
 * @param {any} config @returns {string}
 */
export function webSearchGatewayProviderUrl(config) {
  if (!String(config.webSearchUrl ?? "").trim()) return "";
  const value = String(config.webSearchGatewayInternalUrl ?? "").trim();
  if (!value) return "";
  let url;
  try { url = new URL(value); } catch {
    throw new HttpError(500, "runtime_web_search_gateway_url_invalid", "Web-search gateway internal URL is invalid.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new HttpError(500, "runtime_web_search_gateway_url_invalid", "Web-search gateway internal URL is invalid.");
  }
  return url.href;
}

export function publicSourceGatewayProviderUrl(config) {
  const value = String(config.publicSourceGatewayInternalUrl ?? "").trim();
  if (!value) return "";
  let url;
  try { url = new URL(value); } catch {
    throw new HttpError(500, "runtime_public_source_gateway_url_invalid", "Public-source gateway internal URL is invalid.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/internal/sources/v1/fetch") {
    throw new HttpError(500, "runtime_public_source_gateway_url_invalid", "Public-source gateway internal URL is invalid.");
  }
  return url.href;
}

/** @param {any} config */
export function capsuleGatewayEndpointUrl(config) {
  const url = new URL(modelGatewayProviderUrl(config));
  url.pathname = "/internal/capsules/v1";
  return url.toString().replace(/\/$/, "");
}

/** @param {any} config */
export function capsuleGatewayProviderUrl(config) {
  if (config.stateStore !== "postgres" || !config.evimedWorkloadSigningSecret) return "";
  return capsuleGatewayEndpointUrl(config);
}

/** @param {any} config */
export function revisionGatewayEndpointUrl(config) {
  const url = new URL(modelGatewayProviderUrl(config));
  url.pathname = "/internal/revisions/v1/authorize";
  return url.toString().replace(/\/$/, "");
}

/** @param {any} config */
export function revisionGatewayProviderUrl(config) {
  if (config.stateStore !== "postgres" || !config.evimedWorkloadSigningSecret) return "";
  return revisionGatewayEndpointUrl(config);
}

/**
 * The compaction settings a launched runtime receives, derived from this
 * process's environment by the same function the container-side rows use.
 *
 * One derivation for the launch plan and for readiness, so the value an
 * operator reads back is the value a runtime is started with. The policy comes
 * from config (which may be overridden in tests); the gateway's body limit
 * does too, because the byte guard is a share of it and a limit the gateway
 * enforces but the guard never heard of is the 413 the guard exists to avoid.
 * @param {Record<string, any>} config @param {Record<string, string | undefined>} [env]
 */
export function runtimeCompactionSettings(config, env = process.env) {
  return compactionConfigFromEnv({
    ...env,
    OPEN_SCIENCE_RUNTIME_COMPACTION_POLICY: String(config.runtimeCompactionPolicy ?? "basic"),
    ...(Number(config.modelGatewayMaxBodyBytes) > 0
      ? { OPEN_SCIENCE_MODEL_GATEWAY_MAX_BODY_BYTES: String(Math.floor(Number(config.modelGatewayMaxBodyBytes))) }
      : {}),
  });
}

/**
 * The one description of a runtime's deployment settings.
 *
 * The patch and the container environment are two halves of it: rows the host
 * composition owns are written into the patch, and the settings of the plugins
 * a preset mounts travel as environment, because a profile patch cannot reach a
 * preset's rows. Deriving both from this function is what keeps the halves from
 * describing different deployments.
 *
 * Exported for one reason: a test can then hold this half and the `--env` list
 * built in `buildRuntimeLaunchPlan` to the same value. They are the pair whose
 * disagreement this function exists to prevent, and a disagreement is invisible
 * from either side alone.
 *
 * @param {any} config @param {any} project @param {any} plan @param {string} model @param {string} workloadTokenPath
 * @returns {import("./dshProfilePatch.mjs").ProfilePatchInput}
 */
export function dshProfileInput(config, project, plan, model, workloadTokenPath) {
  // The public prefix for a remote session (plan §3.1 #5): the kernel's
  // `baseURL` is then our gateway at an address the session can reach, which
  // is the only thing about the model provider that differs.
  const gateways = plan.gateways ?? null;
  const capsuleGatewayUrl = gateways ? String(gateways.capsule ?? "") : capsuleGatewayProviderUrl(config);
  return {
    modelGatewayUrl: gateways ? String(gateways.model) : modelGatewayProviderUrl(config),
    model,
    // Rendered into the profile so the kernel asks for what the gateway will
    // send anyway; the gateway is the one that decides.
    reasoningEffort: String(config.deepseekReasoningEffort ?? "high"),
    contextWindow: Number(config.runtimeContextWindow) || Number(config.runMaxTokens) || 400_000,
    sessionsDir: "/runtime/dsh-home/sessions",
    mcpServerPath: "/opt/evimed/mcp/evimed-research/server.py",
    mcpEnvironment: evimedMcpEnvironment(config, project, plan, { workloadTokenPath: workloadTokenPath }),
    // Empty when no sidecar is deployed, and then no row is emitted -- a
    // deployment without one behaves exactly as it did before.
    toolUniverseUrl: String(config.toolUniverseMcpUrl ?? "").trim(),
    // The directory that CONTAINS the presets, not the preset. `roots` is
    // scanned for preset directories, so naming the preset itself gives the
    // kernel a root with no presets under it and `agent-presets: preset
    // "evimed-universal" not found (available: standard, ptc, minimal, cordis,
    // skills)` — a message that lists the built-ins and reads like ours was
    // never built. The image's own build smoke proves this exact value.
    presetRoot: "/opt/evimed/dsh/presets",
    presetSkillsDir: "/opt/evimed/socket/presets/evimed-universal/skills",
    capabilitiesDir: "/opt/evimed/capabilities",
    answerPersonaDir: RUNTIME_ANSWER_PERSONA_DIR,
    capabilitySkillsDir: RUNTIME_CAPABILITY_SKILLS_DIR,
    // The same rule the launch plan's `--env` list used, applied to the same
    // plan: the methods the container mounts and the methods the profile names
    // are one directory or the feature is dark in whichever half is wrong.
    capsuleMethodsDir: capsuleMethodsRuntimePath(plan),
    capsuleGatewayUrl,
    revisionGatewayUrl: gateways ? String(gateways.revision ?? "") : revisionGatewayProviderUrl(config),
    publicSourceGatewayUrl: gateways ? String(gateways.publicSource ?? "") : publicSourceGatewayProviderUrl(config),
    webSearchGatewayUrl: gateways ? String(gateways.webSearch ?? "") : webSearchGatewayProviderUrl(config),
    pluginConfig: plan.pluginConfig,
    modelGatewayTokenFile: config.modelGatewaySigningSecret
      ? (plan.sandboxMode === "docker" ? `${runtimeDshHome}/${modelGatewayTokenFileName}` : path.join(plan.dshHomeDir, modelGatewayTokenFileName))
      : "",
    workloadTokenFile: workloadTokenPath,
    bundleVersion: String(config.socketBundleVersion ?? ""),
    dshVersion: String(config.dshVersion ?? ""),
    limits: {
      deliveryAttemptLimit: config.deliveryAttemptLimit,
      maxChildrenTotal: config.maxChildrenTotal,
      maxConcurrentChildren: config.maxConcurrentChildren,
      maxSteps: config.runMaxSteps,
      maxTokens: config.runMaxTokens,
      evidenceStaleMinutes: config.evidenceStaleMinutes,
      screeningBatchSize: config.screeningBatchSize,
    },
    flags: {
      hosted: Boolean(config.production),
      // Read from config, not written as literals. `requiredEnforcement` in
      // this same object literal already did, which is what makes this a local
      // omission rather than an architectural one: an operator could set
      // OPEN_SCIENCE_RUNTIME_ASK_USER or ..._REVIEW_ENABLED and nothing
      // downstream would ever look at the result.
      askUser: Boolean(config.runtimeAskUserEnabled),
      review: Boolean(config.runtimeReviewEnabled),
      // Not a setting: the capsule is active when a recall endpoint is
      // configured, and the plugin reports its own absence.
      capsule: Boolean(capsuleGatewayUrl),
      // Who this runtime belongs to decides whether the kernel's trajectory
      // panel is mounted. It renders the assembled system prompt, the injected
      // run context and every tool's raw JSON; useful for diagnosing a run,
      // and not something a researcher account should be handed. The same list
      // `/api/me` reads to decide which menu the shell draws.
      operator: Array.isArray(config.operatorUsers) && config.operatorUsers.includes(String(project.userId ?? "")),
      // Per provider (plan §3.1 #9): a remote session may run `partial` when
      // its guest kernel says so and the deployment accepted it by name.
      requiredEnforcement: /** @type {'full'|'partial'} */ (plan.sandboxMode === "agentbay"
        ? config.agentbaySandboxEnforcement ?? "full"
        : config.runtimeSandboxEnforcement),
    },
    // The community client bundles a deployment switched off (rt, plan §3.9).
    disabledClientBundles: [
      ...(config.runtimeAnnotationEnabled === false ? ["annotation"] : []),
      ...(config.runtimeMermaidEnabled === false ? ["mermaid"] : []),
    ],
  };
}

/**
 * The skills, the MCP command and the model provider, written as rows of one
 * generated file. They arrive together because the kernel takes them together.
 *
 * Hidden knowledge: what was missing before this existed. `dshProfilePatch.mjs`
 * renders correct, tested YAML; nothing called it. A container built from the
 * image alone boots with no gateway address, no MCP command, and no way to
 * reach the model — every row `renderProfilePatch` exists to generate — so it
 * would start, answer its own health probe, and satisfy nothing a real run
 * needs. This is the seam that makes the render actually reach the container:
 * write the patch and the credentials file to the host path that becomes
 * `$DSH_HOME` once the runtime volume mounts, before the container starts.
 *
 * The model-gateway token and the MCP workload token are two different
 * credentials for two different consumers (the kernel's own LLM calls; the MCP
 * subprocess's HTTP calls to the platform's connectors); the issuance
 * functions they use are not kernel-specific, only where the result is written
 * is.
 *
 * `configured` describes the common profile and MCP bootstrap. Model access is
 * separate: `providerConfigured` and the LLM credential reference follow the
 * provider switch; platform tokens follow their own signing configuration.
 *
 * @param {any} config
 * @param {any} project
 * @param {any} plan
 * `hostHome: false` is a remote runtime's bootstrap (the AgentBay provider):
 * `plan.dshHomeDir` is a path inside the session, never created on this host,
 * and `writeFile` carries each file there. It may keep the browser-session
 * secret a running kernel already holds (`browserSessionSecret`) and give the
 * workload token the provider's own lifetime (`workloadTokenTtlSeconds`).
 *
 * @param {{ nowSeconds?: number, jti?: string, writeFile?: (root: string, file: string, content: string, options?: any) => Promise<any>, budgetScope?: Record<string, any>|null,
 *   hostHome?: boolean, browserSessionSecret?: string, workloadTokenTtlSeconds?: number, modelGatewayIssuedAt?: number }} [options]
 * @returns {Promise<{ configured: boolean, providerConfigured: boolean, workloadTokenFile: string | null, workloadTokenRefreshMs: number | null, token: string | null, payload: Record<string, any> | null, browserSessionSecret: string }>}
 */
export async function syncRuntimeDshProfile(
  config,
  project,
  plan,
  {
    nowSeconds = Math.floor(Date.now() / 1000), jti = randomId("mgw_"), writeFile = writeFileAtomicNoFollow, budgetScope = null,
    hostHome = true, browserSessionSecret: keptBrowserSessionSecret = undefined, workloadTokenTtlSeconds = undefined,
    modelGatewayIssuedAt = nowSeconds,
  } = {},
) {
  const providerConfigured = Boolean(config.deepseekProviderEnabled);
  if (!plan.dshHomeDir || !plan.proxyWorkspaceDir) {
    throw new HttpError(500, "runtime_dsh_profile_plan_invalid", "Runtime launch plan is missing its DSH bootstrap paths.");
  }
  const model = String(config.deepseekModel ?? "").trim();
  if (!supportedDeepSeekModels.has(model)) {
    throw new HttpError(500, "runtime_model_gateway_model_invalid",
      `The managed DeepSeek model must be one of ${[...supportedDeepSeekModels].join(", ")}.`);
  }
  if (config.modelGatewaySigningSecretError) {
    throw new HttpError(500, config.modelGatewaySigningSecretError, "Model gateway signing secret could not be loaded.");
  }
  if (hostHome) {
    await assertNoSymlinkPath(project.rootDir, plan.dshHomeDir, { allowMissingTail: true });
    await fs.mkdir(plan.dshHomeDir, { recursive: true, mode: 0o700 });
    await assertNoSymlinkPath(project.rootDir, plan.dshHomeDir);
    const dshHome = await fs.open(plan.dshHomeDir, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    try {
      await dshHome.chmod(0o700);
    } finally {
      await dshHome.close();
    }
  }

  // Public-source retrieval authenticates with this token too. Disabling
  // DeepSeek must not revoke the platform identity needed by those tools.
  // `modelGatewayIssuedAt` with the same `jti` and scope re-renders a token a
  // running kernel already holds, byte for byte: how a remote session that
  // outlived its control plane keeps the credential it booted with.
  const modelGatewayToken = providerConfigured || config.modelGatewaySigningSecret ? issueModelGatewayRuntimeToken({
    secret: config.modelGatewaySigningSecret,
    userId: String(project.userId),
    projectId: String(project.id),
    nowSeconds: modelGatewayIssuedAt,
    jti,
    budgetScope,
  }) : null;
  // Verified here because the caller needs the payload to register the token as
  // active, and the gateway rejects any token whose jti it has not been told
  // about.
  const modelGatewayPayload = modelGatewayToken ? verifyModelGatewayRuntimeToken(modelGatewayToken, {
    secret: config.modelGatewaySigningSecret,
    userId: String(project.userId),
    projectId: String(project.id),
    nowSeconds,
  }) : null;
  // No signing secret means no workload token, and therefore no row naming one.
  // Decided here rather than downstream because `environmentRows` merges the
  // row unconditionally: a path handed in without a token behind it produces a
  // profile that tells the MCP to read a file nobody wrote.
  const signingSecret = String(config.evimedWorkloadSigningSecret ?? "");
  const workloadTokenRuntimePathForDsh = signingSecret ? dshWorkloadTokenRuntimePath(plan) : null;
  const profileInput = dshProfileInput(config, project, plan, model, workloadTokenRuntimePathForDsh);
  const patch = renderProfilePatch(profileInput);
  await writeFile(project.rootDir, path.join(plan.dshHomeDir, "control-plane-patch.yml"), patch, { encoding: "utf8", mode: 0o600 });

  // The kernel's browser-session signing secret, chosen here rather than by the
  // kernel. 0.1.2 authenticates every `/api` request, including on loopback,
  // and the kernel's own route to a credential is a launch token printed on
  // stdout — which would mean scraping a container's log for a secret and
  // racing its boot. Seeding it into the credentials file this function already
  // writes lets the control plane mint the cookie before the container exists.
  const browserSessionSecret = keptBrowserSessionSecret ?? generateBrowserSessionSecret();
  // Keep model metadata pinned to the managed gateway even while disabled:
  // This preserves session creation, and omitting the patch would restore the
  // upstream baseURL and DEEPSEEK_API_KEY reference. No LLM credential is
  // installed while the provider is disabled; the gateway also denies calls.
  const credentials = renderCredentialsFile({ token: providerConfigured ? modelGatewayToken : null, browserSessionSecret });
  await writeFile(project.rootDir, path.join(plan.dshHomeDir, ".credentials.yaml"), credentials, { encoding: "utf8", mode: 0o600 });

  // The same gateway token, in a file the MCP server can read.
  //
  // The kernel resolves it from `.credentials.yaml`; the research MCP is a
  // separate process that has always taken it from `EVIMED_MODEL_CONFIG_FILE` —
  // which under the OpenCode kernel meant reading `provider.deepseek.options
  // .apiKey` out of `opencode.json`. There is no `opencode.json` under this
  // kernel, so that read fails and every source fetch returns
  // `public_source_gateway_unconfigured`: a runtime that boots cleanly and then
  // cannot retrieve a single source. Written as a bare token rather than as an
  // imitation of the other kernel's config file, because a file whose shape is
  // a lie about who wrote it is worse than a second reader.
  await writeFile(
    project.rootDir,
    path.join(plan.dshHomeDir, modelGatewayTokenFileName),
    modelGatewayToken ? `${modelGatewayToken}\n` : "",
    { encoding: "utf8", mode: 0o600 },
  );

  // Guarded, because a deployment without the workload signing secret is a
  // configuration this runtime supports: `dshProfileInput` omits
  // `EVIMED_WORKLOAD_TOKEN_FILE` when the secret is absent, and
  // `scheduleEviMedWorkloadRefresh` returns on the same condition. Minting
  // unconditionally here made the third site disagree with the other two —
  // `refreshEviMedWorkloadToken` throws on a short secret, so a runtime that
  // was meant to start with no token row could not start at all. The retired
  // kernel's sync guarded this call; the rewrite dropped the guard.
  const workloadTokenFile = signingSecret ? dshWorkloadTokenHostPath(plan) : null;
  if (workloadTokenFile) {
    await refreshEviMedWorkloadToken(config, project, workloadTokenFile, {
      nowSeconds, writeToken: writeFile, ...(workloadTokenTtlSeconds ? { ttlSeconds: workloadTokenTtlSeconds } : {}),
    });
  } else {
    // Clear a previous deployment's token without following a replaced path.
    await writeFile(project.rootDir, dshWorkloadTokenHostPath(plan), "", { encoding: "utf8", mode: 0o600 });
  }

  return {
    configured: true,
    providerConfigured,
    browserSessionSecret,
    workloadTokenFile,
    workloadTokenRefreshMs: workloadTokenFile ? evimedWorkloadRefreshIntervalMs(config) : null,
    // Handed back, not just written to the credentials file. The gateway
    // authenticates on an *active* jti, and only the caller can register one —
    // returning `token: null` here meant `activateModelGatewayRuntime` returned
    // on its first line, no jti was ever registered, and every model call the
    // runtime made came back 401 `model_gateway_token_invalid` while the
    // credentials file on disk held a perfectly valid token.
    token: modelGatewayToken,
    payload: modelGatewayPayload,
  };
}

/** The file `EVIMED_MODEL_GATEWAY_TOKEN_FILE` names inside a DSH runtime: the
 *  model-gateway token on its own, one line, mode 0600. */
export const modelGatewayTokenFileName = "model-gateway.token";

/** Host path for the MCP workload token file DSH's `EVIMED_WORKLOAD_TOKEN_FILE` names — the `dsh-home` analogue of `workloadTokenHostPath`. */
function dshWorkloadTokenHostPath(plan) {
  return path.join(plan.dshHomeDir, evimedWorkloadTokenFileName);
}

/** Container-internal path to the same file, read by the MCP subprocess. */
function dshWorkloadTokenRuntimePath(plan) {
  return plan.sandboxMode === "docker"
    ? `${runtimeDshHome}/${evimedWorkloadTokenFileName}`
    : dshWorkloadTokenHostPath(plan);
}

/** What a plugin proof has to have registered, read from the registry entry.
 *
 *  No tool name is written here. There used to be one list, for the case this
 *  file could not derive: `deploy/web/Dockerfile` does not copy
 *  `runtime/skills/community/` into the web image, so a released control plane
 *  derives its registry from `PLUGIN_SUPPORT_SNAPSHOT`, and that snapshot
 *  carried no tools. It carries them now -- `pluginService.test.mjs` holds
 *  every field of the snapshot equal to the record -- so both deployment
 *  shapes state a bundle's tools and the fallback is gone with the copy.
 *
 *  A plugin whose tools this deployment cannot state is still not a plugin
 *  whose proof it can check: it fails the probe it is being asked to certify
 *  rather than passing on an empty expectation.
 *  @param {any} entry @returns {string[]} */
export function expectedPluginTools(entry) {
  if (entry.tools.length) return [...entry.tools];
  throw new HttpError(502, "plugin_probe_invalid", "The runtime did not prove the expected plugin configuration.");
}

/**
 * The settings a kernel proof restates.
 *
 * `evimedPlugins/verify` takes no arguments and has one implementation --
 * `verifyCitationAgent` in `packages/harness-port/src/pluginProbe.mjs` -- and
 * the proof it returns is one fixed shape: a binary version, an enabled bit, a
 * revision, a `timeoutMs` and a tool list. `timeoutMs` is therefore the only
 * per-project setting anything reads back out of a container, so it is the only
 * one a proof can be held to.
 */
const PROVEN_PLUGIN_SETTINGS = Object.freeze(["timeoutMs"]);

/**
 * The settings of one plugin this deployment can hold a proof to -- or no
 * verdict at all.
 *
 * The names come from the registry entry rather than from the comparison
 * itself, so a schema edited in `pluginService.mjs` moves the probe with it.
 * The refusal is the honest half of that: this probe covers exactly the plugins
 * declaring the settings the proof restates, and a plugin declaring others --
 * more, fewer, or different -- gets `plugin_probe_invalid` instead of a
 * verdict. With no `timeoutMs` of its own, the `timeoutMs` the kernel proves
 * belongs to some other registration, and certifying it would report a
 * configuration this plugin was never given.
 *
 * Nothing that used to pass now fails: the line this replaced compared
 * `proof.timeoutMs` against an `expected.settings.timeoutMs` such a plugin does
 * not have, so it already refused every one of them. What is new is that the
 * refusal is stated, carries its own reason, and happens before the kernel is
 * asked to prove something this control plane could not read. Widening it means
 * teaching the kernel's proof first, which is the point.
 *
 * @param {any} entry @returns {string[]}
 */
export function provenPluginSettings(entry) {
  const declared = Object.keys(entry.settings);
  if (declared.length !== PROVEN_PLUGIN_SETTINGS.length || declared.some((name) => !PROVEN_PLUGIN_SETTINGS.includes(name))) {
    throw new HttpError(502, "plugin_probe_invalid",
      `This deployment can prove only ${PROVEN_PLUGIN_SETTINGS.join(", ")}, and this plugin declares ${declared.join(", ") || "no settings"}.`);
  }
  return declared;
}

/**
 * One plugin's configuration per launch plan, deliberately.
 *
 * Not generalised to every enabled plugin, because nothing downstream of this
 * function could carry a second one: `runtimeEnvironment` names exactly three
 * per-project variables and they are dsh-cite's (`EVIMED_CITE_ENABLED`,
 * `_TIMEOUT_MS`, `_CONFIG_REVISION`); the only preset row that reads them is
 * `evimed-citation-bridge` in `packages/socket/presets/evimed-universal/agent.cordis.yml`;
 * the privileged controller's `startRuntime` takes one `pluginConfig` and
 * refuses any object whose keys are not exactly `enabled,revision,settings`;
 * and `evimedPlugins/verify` is a parameterless wire method returning a proof
 * with no plugin id in it. A `pluginConfigs` map here would be a plan the
 * container cannot read, a controller call that 400s and a proof that names
 * the wrong bundle.
 *
 * `runtimeManager.test.mjs` pins the narrow fact rather than a count of
 * registered plugins: the environment this plan renders carries dsh-cite's
 * three variables, moves only those three when the one configuration changes,
 * and refuses a configuration shaped like a second bundle's -- which, with
 * `PLUGIN_SETTINGS_SCHEMAS` naming dsh-cite alone, is one with no settings at
 * all. Whether a second bundle may be registered is not this file's to say:
 * `APPLY_PATH_PLUGIN_IDS` in `pluginService.mjs` refuses such a record
 * outright, and `pluginService.test.mjs` is where that is held.
 */
export function buildRuntimeLaunchPlan(config, project, port, {
  capsuleGatewayUrl = capsuleGatewayProviderUrl(config),
  revisionGatewayUrl = revisionGatewayProviderUrl(config),
  publicSourceGatewayUrl = publicSourceGatewayProviderUrl(config),
  webSearchGatewayUrl = webSearchGatewayProviderUrl(config),
  pluginConfig = { revision: 0, enabled: true, settings: { timeoutMs: 15000 } },
} = {}) {
  const sandboxMode = config.runtimeSandboxMode;
  if (sandboxMode === "docker") {
    // Unix only. The kernel's web host binds loopback inside the container, so
    // a published port maps to an interface nothing listens on, and the
    // entrypoint that seeds the profile is the same script that runs the socat
    // bridge — a TCP runtime skipped it and died during boot saying it had no
    // profile. `loadConfig` refuses anything else; this refuses it again for
    // the hand-built configs that reach this function without it.
    const transport = String(config.runtimeTransport ?? "unix").trim().toLowerCase();
    if (transport !== "unix") {
      throw new HttpError(400, "invalid_runtime_transport", "Unsupported runtime transport.");
    }
    const networkMode = String(config.runtimeNetworkMode ?? "").trim();
    if (!config.allowRuntimeHostNetwork && runtimeNetworkUsesHostOrContainer(networkMode)) {
      throw new HttpError(
        403,
        "runtime_network_forbidden",
        "Host or shared-container networking is disabled for hosted runtimes.",
      );
    }
    if (
      config.production &&
      runtimeNetworkRequiresEgressOptIn(networkMode, config.runtimeInternalNetworkName) &&
      !config.allowRuntimeNetworkEgress
    ) {
      throw new HttpError(
        403,
        "runtime_network_egress_forbidden",
        "Runtime container network egress requires OPEN_SCIENCE_ALLOW_RUNTIME_NETWORK_EGRESS=true in production.",
      );
    }
    if (
      config.production &&
      runtimeNetworkRequiresEgressOptIn(networkMode, config.runtimeInternalNetworkName) &&
      !config.runtimeNetworkEgressPolicyAck
    ) {
      throw new HttpError(
        403,
        "runtime_network_egress_policy_unconfirmed",
        "Runtime container network egress requires OPEN_SCIENCE_RUNTIME_NETWORK_EGRESS_POLICY_ACK=true in production.",
      );
    }
    const releasePolicy = runtimeReleasePolicyError(config);
    if (releasePolicy) {
      throw new HttpError(503, releasePolicy.code, "Runtime release provenance is missing or does not match deployment configuration.");
    }
    const runtimeRoot = containerRuntimeRoot(project);
    const xdgConfigDir = path.join(runtimeRoot, "xdg-config");
    // Written by the control plane before either side builds a plan; read here
    // so the hosted controller, which builds its own, reaches the same answer.
    const capsuleMethodsDir = capsuleMethodsHostDir(project);
    const capsuleMethodCount = mountedCapsuleMethodCount(capsuleMethodsDir);
    const capsuleMethodsRuntimeDir = capsuleMethodsRuntimePath({ capsuleMethodCount });
    const isolatedControlMount = Boolean(config.runtimeDataVolume);
    const controlDir = isolatedControlMount
      ? path.join(
          config.dataDir,
          ".runtime-sockets",
          createHash("sha256")
            .update(`${project.userId}\0${project.id}`, "utf8")
            .digest("hex")
            .slice(0, 24),
        )
      : path.join(runtimeRoot, "control");
    const socketPath = path.join(controlDir, RUNTIME_SOCKET_FILE_NAME);
    assertConnectableSocketPath(socketPath, Boolean(config.runtimeDataVolume));
    const containerName = runtimeContainerName(project);
    const readOnlyViews = readOnlyWorkspaceViews(config, project);
    return {
      sandboxMode,
      containerName,
      command: config.runtimeContainerBin,
      args: [
        "run",
        // No `--rm`. Docker deletes the container the instant it dies, so by
        // the time anything polls `docker inspect` there is no corpse: the
        // exit code, the OOM flag and the last output are gone before the
        // question is asked. That is the mechanism behind an `exited` ledger
        // record carrying a pid, a name and a timestamp and nothing about why
        // — a run 19 minutes long that ended with no explanation available
        // even from `docker events`, whose history this host does not retain.
        //
        // `cleanupDockerContainer` already removes it explicitly with `rm -f`,
        // so the container is still cleaned; it is cleaned AFTER it has been
        // asked what happened.
        "--init",
        "--name",
        containerName,
        "--label",
        "open-science.web.runtime=true",
        "--label",
        `open-science.user=${project.userId}`,
        "--label",
        `open-science.project=${project.id}`,
        ...dockerSecurityArgs(config),
        "--network",
        networkMode,
        "--cpus",
        String(config.runtimeCpuLimit),
        "--memory",
        String(config.runtimeMemoryLimit),
        "--mount",
        dockerWorkspaceMount(config, project),
        // Nested over the workspace mount, so the same directory is reachable
        // only through the read-only view (see `readOnlyWorkspaceViews`).
        ...(readOnlyViews.knowledgeBase
          ? ["--mount", `${dockerRuntimeMount(config, readOnlyViews.knowledgeBase, RUNTIME_KNOWLEDGE_BASE_DIR)},readonly`]
          : []),
        ...(readOnlyViews.library
          ? ["--mount", `${dockerRuntimeMount(config, readOnlyViews.library, RUNTIME_LIBRARY_DIR)},readonly`]
          : []),
        "--mount",
        dockerRuntimeMount(config, runtimeRoot),
        // Only when something was written. `--mount type=bind` refuses a source
        // that does not exist -- `docker run` fails before the kernel starts --
        // and a project with no approved method has no directory, so the mount
        // is conditional on the same count the plugin's directory name is.
        ...(capsuleMethodCount > 0
          ? [
              "--mount",
              `${dockerRuntimeMount(config, capsuleMethodsDir, runtimeCapsuleMethodsDir)},readonly`,
            ]
          : []),
        ...(isolatedControlMount
          ? [
              "--mount",
              dockerRuntimeMount(config, controlDir, "/runtime-control"),
            ]
          : []),
        "--workdir",
        "/workspace",
        "--env",
        "XDG_CONFIG_HOME=/runtime/xdg-config",
        "--env",
        "XDG_DATA_HOME=/runtime/xdg-data",
        "--env",
        "XDG_CACHE_HOME=/runtime/xdg-cache",
        "--env",
        "XDG_STATE_HOME=/runtime/xdg-state",
        "--env",
        "HOME=/runtime/home",
        // The kernel decides only the entrypoint and the socket name. Everything
        // above it — the mounts, the capability drops, the network policy, the
        // read-only root — is EviMed's isolation, and none of it was ever about
        // which agent ran inside.
        "--env",
        `OPEN_SCIENCE_RUNTIME_PORT=${port}`,
        "--env",
        `OPEN_SCIENCE_RUNTIME_SOCKET=${isolatedControlMount ? "/runtime-control" : "/runtime/control"}/${RUNTIME_SOCKET_FILE_NAME}`,
        // Telemetry has no redaction rules; it is disabled in the
        // image, in the patch and here, because any one of the three
        // being undone is a leak of message bodies.
        "--env",
        "DSH_TELEMETRY_DISABLED=1",
        "--env",
        "DSH_PERMISSION_MODE=workspace-write",
        "--env",
        `DSH_HOME=${runtimeDshHome}`,
        // The kernel's temp root, off the 64 MiB tmpfs.
        //
        // `--tmpfs /tmp:...size=64m` is a security bound, and both
        // spill writers resolve their directory from `os.tmpdir()`:
        // `dsh-spill-local` writes the FULL text of every tool
        // result over `maxInlineBytes` there, and
        // `dsh-subprocess-local` writes captured bash output there.
        // Neither is ever pruned and the container is long-lived
        // per project, so exhaustion accumulates across a whole
        // session history.
        //
        // What happens when it fills is the part that matters:
        // `spill-policy` catches the failed write, logs a warning
        // INSIDE the container — where nothing reads it, since the
        // container's logs die with it and telemetry is off — and
        // returns, which keeps the full untruncated text inline.
        // The inline cap stops applying, silently, and every
        // oversized tool result goes into the model's context whole.
        //
        // `/runtime` is a per-project rw mount, quota-accounted and
        // deleted with the project. `dsh-sandbox`'s `writableRoots()`
        // follows `os.tmpdir()`, so the landlock grant moves with it
        // and covers only this subtree.
        "--env",
        `TMPDIR=${runtimeTmpDir}`,
        // The authority the control plane will send as `Host`. DSH
        // refuses every `/api` request whose Host is neither
        // loopback nor a declared trusted host — not just browser
        // requests — so a container that declares a different one
        // accepts nothing, while looking perfectly healthy.
        "--env",
        `OPEN_SCIENCE_RUNTIME_AUTHORITY=${RUNTIME_AUTHORITY}`,
        // Every deployment-owned setting of the plugins the preset
        // mounts. A profile patch cannot reach a preset's rows —
        // DSH reports the target as unmatched on stderr and drops
        // it — so the rows read these with `!!js`, and a name
        // missing here leaves a plugin on its schema default while
        // the deployment believes it configured one.
        ...Object.entries(runtimeEnvironment({
          presetSkillsDir: "/opt/evimed/socket/presets/evimed-universal/skills",
          capabilitiesDir: "/opt/evimed/capabilities",
          answerPersonaDir: RUNTIME_ANSWER_PERSONA_DIR,
          capabilitySkillsDir: RUNTIME_CAPABILITY_SKILLS_DIR,
          capsuleMethodsDir: capsuleMethodsRuntimeDir,
          capsuleGatewayUrl,
          revisionGatewayUrl,
          publicSourceGatewayUrl,
          webSearchGatewayUrl,
          pluginConfig,
          // Derived by the same function that tells the MCP server, so the
          // catalogue the kernel offers and the tools it can call agree.
          disabledTools: kernelDisabledTools(config, project, sandboxMode),
          // The API owns issuance; the isolated controller owns this argv and
          // deliberately has no signing keys. Both processes name the same
          // fixed files. Bootstrap writes them empty when signing is absent.
          modelGatewayTokenFile: `${runtimeDshHome}/${modelGatewayTokenFileName}`,
          workloadTokenFile: `${runtimeDshHome}/${evimedWorkloadTokenFileName}`,
          bundleVersion: String(config.socketBundleVersion ?? ""),
          // Derived once, out here, from the same definitions the preset row
          // reads inside the container. A compaction knob that is not on this
          // list does nothing and says nothing.
          compaction: compactionRuntimeEnv(runtimeCompactionSettings(config)),
          // `retainTokens` is a port-level option with no row to read it, so it
          // never crosses the boundary. Sending it would put a name on the
          // container's env that nothing reads, which is the same defect as a
          // row reading a name nobody sends, pointing the other way.
          flags: {
            hosted: Boolean(config.production),
            // Same two settings as `dshProfileInput`; see there.
            askUser: Boolean(config.runtimeAskUserEnabled),
            review: Boolean(config.runtimeReviewEnabled),
            capsule: Boolean(capsuleGatewayUrl),
            operator: Array.isArray(config.operatorUsers) && config.operatorUsers.includes(String(project.userId ?? "")),
            requiredEnforcement: /** @type {'full'|'partial'} */ (config.runtimeSandboxEnforcement),
          },
          limits: {
            deliveryAttemptLimit: config.deliveryAttemptLimit,
            maxChildrenTotal: config.maxChildrenTotal,
            maxConcurrentChildren: config.maxConcurrentChildren,
            maxSteps: config.runMaxSteps,
            maxTokens: config.runMaxTokens,
            evidenceStaleMinutes: config.evidenceStaleMinutes,
            screeningBatchSize: config.screeningBatchSize,
          },
        }))
          .flatMap(([key, value]) => ["--env", `${key}=${value}`]),
        config.runtimeContainerImage,
        "open-science-dsh-serve",
      ],
      cwd: project.workspaceDir,
      env: process.env,
      proxyWorkspaceDir: "/workspace",
      runtimeUrl: `http://${RUNTIME_AUTHORITY}`,
      socketPath,
      socketTrustRoot: isolatedControlMount ? config.dataDir : project.rootDir,
      xdgConfigDir,
      // Host path for `/runtime/dsh-home` (see `runtimeDshHome`): the control
      // plane writes the generated profile patch and credentials file here,
      // host-side, before the container ever starts.
      dshHomeDir: path.join(runtimeRoot, "dsh-home"),
      // The count this argv was built from, so `dshProfileInput` derives the
      // other half of the deployment -- the directory the profile names -- from
      // the same number that decided whether anything is mounted at all.
      capsuleMethodCount,
      readOnlyViews,
      runtimeDirs: [
        runtimeRoot,
        controlDir,
        xdgConfigDir,
        path.join(runtimeRoot, "xdg-data"),
        path.join(runtimeRoot, "xdg-cache"),
        path.join(runtimeRoot, "xdg-state"),
        path.join(runtimeRoot, "home"),
        path.join(runtimeRoot, "dsh-home"),
        path.join(runtimeRoot, "tmp"),
      ],
    };
  }

  // Every other sandbox mode is refused, `host` included.
  //
  // The kernel's EviMed composition — the `evimed-universal` preset, the
  // research MCP, the capability trees — is baked into the runtime image at
  // `/opt/evimed`, and the generated profile patch names those paths. A kernel
  // started from a host binary finds none of them: it boots, serves, answers
  // its own health probe and can satisfy nothing a real run needs, which is a
  // failure that looks exactly like nothing having happened. The previous
  // kernel had a host mode and this is where it was built; it is refused by
  // name rather than left as a launch that silently produces an empty runtime.
  throw new HttpError(
    400,
    "invalid_runtime_sandbox",
    "The agent runtime runs only from the runtime image: set OPEN_SCIENCE_RUNTIME_SANDBOX_MODE=docker.",
  );
}

/**
 * `$DSH_HOME` inside a runtime container. It sits on the project's own data
 * volume, so session logs, attachments and plugin storage are backed up,
 * exported and deleted with the project rather than with the container.
 */
/**
 * Fold one process-count sample into a runtime's record, and say whether it is
 * worth reporting.
 *
 * Separated from the cgroup read so the decision can be tested against the real
 * function rather than a copy of it: a test that reimplements the rule proves
 * the test, and this rule exists because three runs died at a ceiling nothing
 * announced.
 *
 * Four fifths — far enough from the ceiling to act on, close enough not to fire
 * on an ordinary run. Reported once per runtime, because the monitor wakes on a
 * fixed cycle and a line per wake buries the ledger in one repeated sentence.
 *
 * @param {Record<string, any>} runtime mutated: `peakPids`, `pidPressureReported`
 * @param {number} current @param {number} limit
 * @returns {boolean} whether this sample should be recorded as pressure
 */
/** Docker's own size grammar, as a number of bytes. `runtimeMemoryLimit` is a
 *  string like "4g" because that is what `docker run --memory` takes, and a
 *  comparison against it needs the number.
 *  @param {unknown} value @returns {number} bytes, or 0 when unreadable */
export function parseByteSize(value) {
  const text = String(value ?? "").trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)\s*([kmgt]?)b?$/.exec(text);
  if (!match) return 0;
  const scale = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }[match[2]] ?? 1;
  const bytes = Number(match[1]) * scale;
  // `Number.isFinite` is the load-bearing half: the pattern puts no bound on
  // digit count, so a long enough literal overflows to Infinity, and an
  // infinite ceiling makes the pressure check silently unreachable — every real
  // reading is below it. `> 0` is belt: the pattern accepts no sign, so a zero
  // already maps to zero. Both kept, and only the first has a case.
  return Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
}

export function recordPidSample(runtime, current, limit) {
  if (!Number.isFinite(current) || !Number.isFinite(limit) || limit <= 0) return false;
  runtime.peakPids = Math.max(Number(runtime.peakPids ?? 0), current);
  if (current * 5 < limit * 4) return false;
  if (runtime.pidPressureReported) return false;
  runtime.pidPressureReported = true;
  return true;
}

export const runtimeDshHome = "/runtime/dsh-home";

/** Where the kernel spills, so the 64 MiB `--tmpfs /tmp` stays a security
 *  bound rather than a capacity one. Both spill writers resolve from
 *  `os.tmpdir()`, so one variable moves both. */
export const runtimeTmpDir = "/runtime/tmp";

/**
 * Where the active capsules' work-style methods are mounted, read-only.
 *
 * Under `/runtime` because that is where the runtime's own state already lives,
 * and a container path is a naming choice: the mount decides what is really
 * there. `--mount type=bind,...,readonly` is the only way in, so the run reads
 * its methods and can never write one -- a method the model could edit is a
 * method the user never approved.
 */
export const runtimeCapsuleMethodsDir = `/runtime/${capsuleMethodsDirName}`;

/** Host directory of the container's `/runtime` mount. */
function containerRuntimeRoot(project) {
  return path.join(project.runtimeDir, "container-runtime");
}

/**
 * Host directory the control plane materializes the project's methods into.
 *
 * Beside the container's runtime root, not inside it. Inside it, the same
 * directory would also be reachable at `/runtime/capsule-methods` through the
 * read-write `/runtime` mount, and on a launch that mounts nothing -- a project
 * whose capsules hold no approved method -- nothing would shadow it: the design
 * says read-only and the run would have a writable path to it. Outside that
 * root there is exactly one way in, and it is the read-only bind.
 */
export function capsuleMethodsHostDir(project) {
  return path.join(project.runtimeDir, capsuleMethodsDirName);
}

/**
 * How many methods this project has mounted, read from the directory rather
 * than passed in.
 *
 * The privileged runtime controller builds its own launch plan from a payload
 * whose field list is fixed by `RUNTIME_CONTROLLER_PROTOCOL_VERSION`, so a
 * count carried as an argument would be present on the direct-Docker path and
 * absent on the hosted one -- the deployment that has capsules would be the
 * deployment where they never load, and nothing would say so. The control plane
 * writes this directory before either side builds a plan (it owns the database;
 * the controller does not), exactly as it already writes the profile patch and
 * the credentials both sides rely on.
 *
 * `withFileTypes` reports a symlink as a symlink, so only real directories
 * count.
 *
 * @param {string} directory @returns {number}
 */
function mountedCapsuleMethodCount(directory) {
  try {
    return readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
  } catch {
    // No directory is the ordinary case: a project with no capsule has never
    // had one written.
    return 0;
  }
}

/**
 * The directory the capsule plugin is told to read, from one rule.
 *
 * Two values, not three: the container path when something was materialized,
 * and the empty string when nothing was -- the plugin's schema default and its
 * documented "no capsule is mounted" value. There is no host-path form because
 * there is no host-run form: `buildRuntimeLaunchPlan` refuses every sandbox mode
 * but `docker` by name (`invalid_runtime_sandbox`), so a branch for one would be
 * a branch no launch can reach and a claim that a mode still exists.
 *
 * @param {{ capsuleMethodCount?: number, capsuleMethodsRuntimeDir?: string }} plan
 * @returns {string}
 */
export function capsuleMethodsRuntimePath(plan) {
  // A remote session keeps its methods where its launcher installs them
  // read-only (`capsuleMethodsRuntimeDir`); a container mounts them here.
  return plan.capsuleMethodCount ? (plan.capsuleMethodsRuntimeDir ?? runtimeCapsuleMethodsDir) : "";
}

/** Where a runtime sees the project's knowledge base: inside its workspace,
 *  where the source pipeline has always written it, but read-only. */
export const RUNTIME_KNOWLEDGE_BASE_DIR = `/workspace/${KNOWLEDGE_BASE_DIR}`;

/** Where a runtime sees its account's personal library (plan §3.2 #4). */
export const RUNTIME_LIBRARY_DIR = "/workspace/library";

/**
 * The host directory of an account's personal library, shared by every project
 * of the account and read-only in all of them.
 *
 * Derived from the data directory the same way the account's own root is
 * (`<dataDir>/users/<userId>`), because the library is the account's and not a
 * project's. The knowledge-base stream owns the library itself
 * (`libraryService.mjs`, `userLibraryDir`); this is the path the runtime side
 * mounts, and the two must name one directory.
 *
 * @param {Record<string, any>} config @param {string} userId
 */
export function personalLibraryDir(config, userId) {
  return path.join(config.dataDir, "users", safeId(String(userId), "user id"), "library");
}

/** A real directory, not a symlink to one: a mount source the run could have
 *  redirected would be a way out of the project. */
function realDirectory(target) {
  try {
    const stat = lstatSync(target);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * The two read-only views a runtime gets into its workspace, as host paths, or
 * null for a view this launch does not mount.
 *
 * The knowledge base is the project's source material (plan §3.2 #3, §3.1 #4):
 * a run reads it and cites it, and a run that could rewrite it could make a
 * quotation true after the fact — the verbatim-quote gate reads the same
 * bytes. It is mounted only where it already sits inside the mounted
 * workspace (a scratch sub-workspace for a verification or a source reading
 * never contained it and gains no view of it here).
 *
 * The library is mounted only once it exists; the knowledge-base stream creates
 * it with the first entry. Both sides of the controller boundary decide from
 * the filesystem, the way the capsule methods mount does, so the privileged
 * controller and the API build the same argv from the same facts.
 *
 * @param {Record<string, any>} config @param {Record<string, any>} project
 * @returns {{ knowledgeBase: string | null, library: string | null }}
 */
export function readOnlyWorkspaceViews(config, project) {
  const inBaseWorkspace = Boolean(project.baseDir)
    && path.resolve(String(project.workspaceDir)) === path.resolve(String(project.baseDir));
  const knowledgeBase = inBaseWorkspace ? path.join(project.baseDir, KNOWLEDGE_BASE_DIR) : null;
  const library = config.dataDir && project.userId ? personalLibraryDir(config, project.userId) : null;
  return {
    knowledgeBase: knowledgeBase && realDirectory(knowledgeBase) ? knowledgeBase : null,
    library: library && realDirectory(library) ? library : null,
  };
}

/** `sockaddr_un.sun_path` is a fixed 108-byte field on Linux, NUL included, so
 *  a socket path at or past that length cannot be connected to. Not a limit
 *  anything reports usefully: the container binds its own short path inside the
 *  mount and comes up healthy — its log even says `dsh web: http://127.0.0.1:
 *  <port>` — while the control plane's connect fails with ENAMETOOLONG inside a
 *  readiness probe whose errors were being discarded. The observable result was
 *  a runtime that starts, serves, and is unreachable.
 *
 *  The volume-backed layout puts the socket in a short hashed directory and
 *  never comes near this; a deployment without it puts the socket under the
 *  project, where the length depends on how deep the operator put the data
 *  directory. */
const UNIX_SOCKET_PATH_LIMIT = 108;

/** @param {string} socketPath @param {boolean} volumeBacked */
function assertConnectableSocketPath(socketPath, volumeBacked) {
  const bytes = Buffer.byteLength(socketPath, "utf8") + 1; // the terminating NUL counts
  if (bytes <= UNIX_SOCKET_PATH_LIMIT) return;
  throw new HttpError(
    500,
    "runtime_socket_path_too_long",
    `The runtime control socket path needs ${bytes} bytes and the kernel allows ${UNIX_SOCKET_PATH_LIMIT}. ` +
      (volumeBacked
        ? "Shorten OPEN_SCIENCE_DATA_DIR."
        : "Shorten OPEN_SCIENCE_DATA_DIR, or set OPEN_SCIENCE_RUNTIME_DATA_VOLUME, which places the socket in a short hashed directory instead of under the project."),
  );
}

/**
 * The one agent kernel. Named rather than spelled out at each site so that a
 * ledger record, a socket name and an authority cannot drift apart.
 */
export const RUNTIME_KERNEL_NAME = "dsh";
/**
 * Where the image keeps the capability skill bodies delegation injects.
 *
 * Named once because a paired evaluation declares it as part of an arm and
 * readiness reports it, so the two have to be the same string; it was written
 * out twice here and nowhere else, which is how a declared arm and a running
 * deployment come to disagree with nothing able to notice.
 */
export const RUNTIME_CAPABILITY_SKILLS_DIR = "/opt/evimed/capability-skills";
/**
 * Where the image puts the answer line's persona package.
 *
 * The Dockerfile copies exactly this one package out of `runtime/skills/evimed`
 * (the specialists ship as capability bodies instead), and the guidance plugin
 * reads `SKILL.md` from here to put it in the session's own context. A path
 * that does not exist leaves the model to load the skill itself, which is what
 * it did before.
 */
export const RUNTIME_ANSWER_PERSONA_DIR = "/opt/evimed/skills/evimed/open-domain-answer";

/**
 * The authority the control plane sends as `Host` over the unix transport.
 *
 * There is no real hostname on a unix socket, so this is a label — but it is a
 * label DSH enforces: its `/api` fence refuses any request whose `Host` is
 * neither loopback nor one of the container's declared trusted hosts, and that
 * applies to every request, not only ones carrying browser markers. So the same
 * value has to reach both sides, and it is written once here.
 */
export const RUNTIME_AUTHORITY = `${RUNTIME_KERNEL_NAME}.runtime`;

/**
 * The control socket's file name.
 *
 * It carries the kernel's name so a container restarted after a kernel change
 * cannot be reached through a previous kernel's socket: two kernels speak
 * different protocols, and a stale socket that still accepts connections is a
 * runtime that looks alive and answers nothing the caller understands.
 */
export const RUNTIME_SOCKET_FILE_NAME = `${RUNTIME_KERNEL_NAME}.sock`;

/** The one agent composition. A second one would be a design change (§9.2). */
export const EVIMED_AGENT_PRESET = "evimed-universal";

export function runtimeNetworkUsesHostOrContainer(mode) {
  const value = String(mode ?? "").trim().toLowerCase();
  return value === "host" || value.startsWith("container:");
}

/** TypeScript infers a destructured parameter as exactly the shape its
 *  defaults name, which rejects every other property a caller passes.
 *  @param {any} mode
 *  @param {any} internalNetworkName
 */
export function runtimeNetworkRequiresEgressOptIn(mode, internalNetworkName = "") {
  const value = String(mode ?? "").trim().toLowerCase();
  if (!value || value === "none") return false;
  const internal = String(internalNetworkName ?? "").trim().toLowerCase();
  if (internal && value === internal) return false;
  return true;
}

/**
 * Where a project's runtime runs, behind one interface (plan §3.1 #1).
 *
 * The manager owns a runtime's lifecycle — admission, the ledger rows, the
 * readiness wait, the tokens it activates, the reaper — and asks its provider
 * only for what differs between a container on this host and a session in the
 * cloud: preparing the environment, writing the kernel's bootstrap files,
 * launching the kernel, stopping it, and what to read or clean up around it.
 * `OPEN_SCIENCE_RUNTIME_PROVIDER` picks one; `docker` is the default and what
 * production runs until an operator switches.
 *
 * @typedef {object} RuntimeProvider
 * @property {'docker'|'agentbay'} name
 * @property {(project: Record<string, any>, input: { port: number, pluginConfig: any, capsuleMethodsMounted: number }) => Promise<Record<string, any>>} prepare
 *   the launch plan: `sandboxMode`, `runtimeUrl`, `socketPath`, `proxyWorkspaceDir`, `containerName`, …
 * @property {(project: Record<string, any>, plan: Record<string, any>, options: { budgetScope?: any }) => Promise<Record<string, any>>} bootstrap
 *   writes the profile patch, the credentials and the tokens where the kernel reads them
 * @property {(project: Record<string, any>, plan: Record<string, any>, input: { port: number, password: string }) => Promise<any>} launch
 *   starts the kernel; returns the process handle whose `exit` the manager watches
 * @property {(project: Record<string, any>, plan: Record<string, any>, child: any) => Promise<void>} close
 * @property {(project: Record<string, any>, plan: Record<string, any>) => void} afterExit
 * @property {(project: Record<string, any>, runtime: Record<string, any>) => Promise<void>} sampleResources
 * @property {(project: Record<string, any>, state: Record<string, any>) => Promise<{ cleaned: boolean, missing: boolean, failed?: boolean, reason?: string, error?: string | null, reattached?: boolean, skipped?: boolean }>} cleanupOrphan
 * @property {(project: Record<string, any>, runtime: Record<string, any>) => Promise<any>} writeWorkloadToken
 * @property {(project: Record<string, any>) => Promise<void>} [beforeDelivery] brings the host copy up to date before the gate reads it
 * @property {(project: Record<string, any>, relative: string, content: string) => Promise<void>} [mirrorWrite] a control-plane write the running kernel must see
 * @property {(project: Record<string, any>, plan: Record<string, any>) => Promise<void>} [abandon] lets go of what a failed launch prepared outside this process
 * @property {(project: Record<string, any>) => string[]} [acceptedWorkloadTokens] the workload tokens a runtime whose token file is not on this host may present
 * @property {(runtime: Record<string, any>) => boolean} [tolerateTokenRefreshFailure] whether a failed renewal can wait for the next one
 * @property {(project: Record<string, any>, relative: string, content: Buffer) => Promise<boolean>} [mirrorUpload] a researcher's upload the running kernel should see now
 * @property {(child: any) => Record<string, any> | null} [describe] what the runtime's own machine reported at start
 * @property {() => Promise<Record<string, any>>} [readiness] the provider's readiness, when it is not the Docker controller's
 * @property {() => Promise<void> | void} [preflight] what the provider cannot start without, checked before anything is written
 */

/**
 * The runtime as a container on this host, started through the runtime
 * controller (or directly, outside production). Today's code, moved here from
 * the manager unchanged in behaviour.
 */
export class DockerRuntimeProvider {
  /** @param {any} manager */
  constructor(manager) {
    this.manager = manager;
    /** @type {'docker'} */
    this.name = "docker";
  }

  get config() { return this.manager.config; }

  /** A daemon that is not there, refused before the launch writes anything. */
  async preflight() {
    if (this.config.runtimeSandboxMode === "docker") {
      await this.manager.assertDockerSupport();
    }
  }

  /** @param {Record<string, any>} project @param {{ port: number, pluginConfig: any, capsuleMethodsMounted: number }} input */
  async prepare(project, { port, pluginConfig, capsuleMethodsMounted }) {
    const manager = this.manager;
    // Before the plan, for the same reason as the capsule methods: the
    // read-only view of the knowledge base is mounted when the directory
    // exists, and a project whose first source arrives while its runtime runs
    // must not find it writable then.
    await manager.ensureKnowledgeBaseDir(project);
    const plan = buildRuntimeLaunchPlan(this.config, project, port, { pluginConfig });
    plan.pluginConfig = pluginConfig;
    await Promise.all(plan.runtimeDirs.map((dir) => fs.mkdir(dir, { recursive: true, mode: 0o700 })));
    let socketStat = null;
    if (plan.socketPath) {
      await assertNoSymlinkPath(plan.socketTrustRoot ?? project.rootDir, path.dirname(plan.socketPath));
      socketStat = await fs.lstat(plan.socketPath).catch((error) => {
        if (error?.code === "ENOENT") return null;
        throw error;
      });
      if (socketStat?.isSymbolicLink()) {
        throw new HttpError(403, "runtime_socket_symlink", "Runtime sockets must not be symbolic links.");
      }
    }
    if (plan.sandboxMode === "docker") {
      const cleanup = await manager.cleanupDocker(plan, project);
      if (cleanup.cleaned) {
        await appendRuntimeEvent(project, "cleaned_orphan", {
          kind: RUNTIME_KERNEL_NAME,
          sandboxMode: plan.sandboxMode,
          containerName: plan.containerName,
        }, this.config);
      } else if (cleanup.failed) {
        await appendRuntimeEvent(project, "cleanup_failed", {
          kind: RUNTIME_KERNEL_NAME,
          sandboxMode: plan.sandboxMode,
          containerName: plan.containerName,
          error: cleanup.error,
        }, this.config);
        await recordRuntimeState(project, "failed", {
          running: false,
          kind: RUNTIME_KERNEL_NAME,
          startedAt: null,
          pid: null,
          exitedAt: null,
          sandboxMode: plan.sandboxMode,
          networkMode: this.config.runtimeNetworkMode,
          containerName: plan.containerName ?? null,
          skillsCopied: 0,
          agentSkillsCopied: 0,
          agentsGenerated: 0,
          capsuleMethodsMounted,
          error: "runtime_cleanup_failed",
        });
        throw new HttpError(502, "runtime_cleanup_failed", "Runtime container cleanup failed before startup.");
      }
    }
    if (plan.socketPath && socketStat) await fs.rm(plan.socketPath, { force: true });
    return plan;
  }

  /** The kernel's bootstrap files, written host-side into the directory the
   *  container mounts as `$DSH_HOME` before it starts. */
  bootstrap(project, plan, { budgetScope = null } = {}) {
    return syncRuntimeDshProfile(this.config, project, plan, { budgetScope });
  }

  async launch(project, plan, { port, password }) {
    const manager = this.manager;
    let child;
    if (plan.sandboxMode === "docker" && manager.runtimeController) {
      await manager.runtimeController.startRuntime(
        project,
        port,
        password,
        capsuleGatewayProviderUrl(this.config),
        revisionGatewayProviderUrl(this.config),
        publicSourceGatewayProviderUrl(this.config),
        plan.pluginConfig,
      );
      child = new RemoteRuntimeProcess(
        manager.runtimeController,
        project,
        this.config.runtimeControllerPollMs,
      );
    } else {
      child = spawn(plan.command, plan.args, {
        cwd: plan.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: plan.env,
      });
      // The unsandboxed path needs the same last words as the controller path,
      // and gets them the same way: a small tail, both streams, read by
      // `runtimeExitDiagnosis`. Piping rather than ignoring also means a
      // runtime that writes faster than anyone reads no longer blocks — these
      // handlers drain it.
      const local = /** @type {any} */ (child);
      local.exitOutput = "";
      const collect = (chunk) => {
        local.exitOutput = appendTailOutput(local.exitOutput, chunk, RUNTIME_EXIT_OUTPUT_BYTES);
      };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
    }
    return child;
  }

  async close(project, plan, child) {
    if (plan.sandboxMode === "docker" && this.manager.runtimeController) {
      await /** @type {any} */ (child).stop();
    } else {
      if (plan.sandboxMode === "docker") await cleanupDockerContainer(plan);
      await terminateChild(child);
    }
    if (plan.socketPath) await fs.rm(plan.socketPath, { force: true }).catch(() => {});
  }

  /** Removed here, after the exit record has been written. `close()` cleans up
   *  when the manager stops a runtime, but a container that dies on its own
   *  never reaches it — that was `--rm`'s job, and `--rm` is what deleted the
   *  evidence before anyone could read it. The order is the whole point: ask,
   *  then remove. */
  afterExit(project, plan) {
    if (plan.sandboxMode === "docker" && !this.manager.runtimeController) {
      void cleanupDockerContainer(plan).catch(() => {
        // isolated: a container that cannot be removed is a leak worth a
        // metric, not a reason to fail a run that has already ended.
      });
    }
  }

  sampleResources(project) {
    return this.manager.sampleDockerResources(project);
  }

  /** One stale container, named by the state a previous control plane left. */
  async cleanupOrphan(project, state) {
    if (state.sandboxMode !== "docker" || typeof state.containerName !== "string" || !state.containerName) {
      return { cleaned: false, missing: false, failed: false, reason: "not_docker", skipped: true };
    }
    const plan = {
      command: this.config.runtimeContainerBin,
      containerName: state.containerName,
      cwd: project.workspaceDir,
      env: process.env,
    };
    return this.manager.cleanupDocker(plan, project);
  }

  /** Docker's token lives in a host file the container mounts: rewritten in
   *  place, which is the whole renewal (`refreshEviMedWorkloadToken`). */
  writeWorkloadToken(project, runtime) {
    return this.manager.workloadTokenWriter(this.config, project, runtime.workloadTokenFile);
  }
}

/**
 * The provider a configuration names.
 * @param {any} manager
 * @param {{ agentbay?: (manager: any) => RuntimeProvider }} [factories]
 * @returns {RuntimeProvider}
 */
export function createRuntimeProvider(manager, { agentbay = null } = {}) {
  const name = String(manager.config.runtimeProvider ?? "docker");
  if (name === "agentbay") {
    if (!agentbay) throw new HttpError(503, "runtime_provider_unavailable", "The AgentBay runtime provider is not available in this build.");
    return agentbay(manager);
  }
  return new DockerRuntimeProvider(manager);
}

export class RuntimeManager {
  constructor(config, {
    agentRegistry = null,
    workloadTokenWriter = refreshEviMedWorkloadToken,
    setWorkloadTimer = setTimeout,
    clearWorkloadTimer = clearTimeout,
    onRuntimeStop = async () => {},
    onRuntimeStopping = async () => {},
    onSessionAbort = async () => {},
    onRuntimeStart = () => {},
    hasRunningRuns = async () => false,
    agentbayClient = null,
  } = {}) {
    this.config = config;
    /** @type {any} */ this.pluginService = null;
    /**
     * The account's memory capsules — the seam this manager reads a project's
     * approved work-style methods through.
     *
     * The composition root must assign it: `server.mjs` builds the
     * `CapsuleService` and owns the product database, and this class must not
     * reach for either. One line, beside the plugin service it already writes:
     * `runtimeManager.capsuleService = capsuleService;`. Nothing else in this
     * file sets it, so an unassigned field is a deployment whose capsules are
     * never mounted — which is why `startKernel` records the mounted count on
     * the runtime ledger row rather than leaving that state invisible.
     *
     * Null is a supported value, not a bug: a deployment without a product
     * database has no capsules, and a runtime there starts with no methods
     * mounted instead of failing to start.
     *
     * @type {any}
     */
    this.capsuleService = null;
    /** @type {any} the learning ledger, assigned by the composition root beside `capsuleService` */
    this.learningService = null;
    /** Frozen methods for private evaluation projects only; never a user-controlled override. */
    this.evaluationMethodSnapshots = new Map();
    this.pluginOverrides = new Map();
    this.agentRegistry = agentRegistry;
    this.runtimeControllerMode = config.runtimeControllerMode ?? "direct";
    // The privileged Docker controller exists only for the Docker provider: an
    // AgentBay deployment has no container on this host to control.
    this.runtimeController = this.runtimeControllerMode === "socket" && String(config.runtimeProvider ?? "docker") === "docker"
      ? new RuntimeControllerClient(config)
      : null;
    /** @type {RuntimeProvider} */
    this.provider = createRuntimeProvider(this, {
      agentbay: (manager) => new AgentBayRuntimeProvider(manager, { client: agentbayClient ?? createAgentBayClient(config) }),
    });
    this.runtimes = new Map();
    // Which learned methods the last launch of each project mounted, by
    // project key. Read by the observation producer, which otherwise knows only
    // about approved methods and would record nothing for a candidate on trial
    // -- the exact gap that makes a candidate unpromotable forever.
    this.lastMountedLearnedMethods = new Map();
    // And which capsule methods, by project key: what the conversation panel
    // lists as mounted, instead of selecting every capsule again per read.
    this.lastMountedCapsuleMethods = new Map();
    this.starts = new Map();
    this.runtimeActivity = new Map();
    this.runtimeQuotaMonitors = new Map();
    this.runtimeQuotaStops = new Map();
    /** Background quota measurements in flight, by project key. */
    this.backgroundQuotaChecks = new Map();
    /** Kernel application files by request suffix, oldest first (see `sharedUiAsset`). */
    this.sharedUiAssets = new Map();
    this.sharedUiAssetBytes = 0;
    this.evimedWorkloadRefreshTimers = new Map();
    this.activeModelGatewayTokens = new Map();
    this.pendingModelGatewayScopes = new Map();
    this.workloadTokenWriter = workloadTokenWriter;
    this.setWorkloadTimer = setWorkloadTimer;
    this.clearWorkloadTimer = clearWorkloadTimer;
    /** @type {(project: any, status: any) => any} */
    this.onRuntimeStop = onRuntimeStop;
    /** @type {(project: Record<string, any>) => Promise<void>} */
    this.onRuntimeStopping = onRuntimeStopping;
    /** @type {(project: any, sessionId: any) => any} */
    this.onSessionAbort = onSessionAbort;
    /** @type {(project: any, runtime: any) => any} */
    this.onRuntimeStart = onRuntimeStart;
    /**
     * Whether the run ledger still holds a `running` run of this project.
     * Asked before a runtime yields its slot (`makeRoomFor`): a stop closes
     * such a run as cancelled, and between the kernel going idle and the
     * monitor finishing a run there is a window in which the kernel alone
     * would call a run that just delivered fair game.
     * @type {(project: Record<string, any>) => Promise<boolean>}
     */
    this.hasRunningRuns = hasRunningRuns;
    this.lastOrphanCleanup = null;
    /** Where each pending start is, by project key (`RUNTIME_START_STAGES`). */
    this.startProgress = new Map();
    /** Pending starts an opening has asked for or joined, by project key:
     *  read when that start makes room (`makeRoomFor`), so an opening that
     *  finds a warm-up's start under way still counts as one. */
    this.openingStarts = new Set();
    /** Pending starts only a speculative warm-up has asked for, by project
     *  key: `makeRoomFor` retires nothing for them. Any other caller that
     *  joins takes its key out. */
    this.speculativeStarts = new Set();
    /** The last start of each project that was refused, by project key, for
     *  the status the waiting shell polls: `{ code, status, at }`. */
    this.startFailures = new Map();
  }

  /** The runtime provider this deployment runs (`OPEN_SCIENCE_RUNTIME_PROVIDER`). */
  providerName() {
    return String(this.config.runtimeProvider ?? "docker");
  }

  /** @param {Record<string, any>} project @param {string} stage one of `RUNTIME_START_STAGES` */
  noteStartStage(project, stage) {
    this.startProgress.set(this.key(project), { stage, at: Date.now() });
  }

  usesRuntimeController() {
    return this.runtimeController != null;
  }

  /**
   * Materialize the methods this project's runs may read: the approved
   * work-style entries of its active capsules, and the learned methods the
   * distillation loop has admitted.
   *
   * The whole point of a work-style pack: it is exported, signed, encrypted,
   * transferred, imported and approved, and until this ran it was never
   * executed, because the directory the plugin loads methods from was the empty
   * string at every launch site. The learned half had the same shape of hole
   * one layer up — a selector with no caller — and it is closed here.
   *
   * Reads `this.capsuleService` and `this.learningService`, which only the
   * composition root assigns; either being null simply drops that source.
   *
   * A trial is read per launch rather than cached: the evaluation harness sets
   * it immediately before it dispatches, and a cached answer would measure the
   * previous arm.
   *
   * @param {any} project
   * @returns {Promise<{ directory: string, count: number, bytes: number,
   *   learned: {id: string, name: string, digest: string, trial?: boolean}[],
   *   capsule: {id: string, directoryName: string, capsuleId: string, factKind: string, content: string}[] }>}
   */
  async syncCapsuleMethods(project) {
    let trialMethodIds = [];
    if (this.learningService) {
      // A trial that cannot be read is not a reason to refuse a launch: the
      // researcher's own run does not depend on it, and failing here would
      // make an evaluation-only feature able to take the product down.
      try {
        const trial = await this.learningService.methodTrial(String(project.userId), String(project.id));
        trialMethodIds = trial?.methodIds ?? [];
      } catch { trialMethodIds = []; }
    }
    return materializeCapsuleMethods({
      capsules: this.capsuleService,
      learning: this.learningService ?? null,
      frozenMethods: this.evaluationMethodSnapshots.get(this.key(project)) ?? null,
      trialMethodIds,
      project,
      directory: capsuleMethodsHostDir(project),
    });
  }

  activateModelGatewayRuntime(project, runtime) {
    if (!runtime?.modelGatewayToken || !runtime?.modelGatewayTokenJti) return null;
    const payload = verifyModelGatewayRuntimeToken(runtime.modelGatewayToken, {
      secret: this.config.modelGatewaySigningSecret,
      userId: String(project.userId),
      projectId: String(project.id),
    });
    if (payload.jti !== runtime.modelGatewayTokenJti) throw modelGatewayTokenError();
    for (const [jti, active] of this.activeModelGatewayTokens) {
      if (active.userId === payload.userId && active.projectId === payload.projectId) {
        this.activeModelGatewayTokens.delete(jti);
      }
    }
    this.activeModelGatewayTokens.set(payload.jti, {
      userId: payload.userId,
      projectId: payload.projectId,
      runtime,
    });
    return payload;
  }

  deactivateModelGatewayRuntime(runtime) {
    if (!runtime?.modelGatewayTokenJti) return;
    const active = this.activeModelGatewayTokens.get(runtime.modelGatewayTokenJti);
    if (active?.runtime === runtime) this.activeModelGatewayTokens.delete(runtime.modelGatewayTokenJti);
  }

  assertActiveModelGatewayToken(token, { nowSeconds = Math.floor(Date.now() / 1000) } = {}) {
    const payload = verifyModelGatewayRuntimeToken(token, {
      secret: this.config.modelGatewaySigningSecret,
      nowSeconds,
    });
    const active = this.activeModelGatewayTokens.get(payload.jti);
    if (
      !active ||
      active.userId !== payload.userId ||
      active.projectId !== payload.projectId ||
      active.runtime?.modelGatewayToken !== token
    ) throw modelGatewayTokenError();
    return payload;
  }

  /** Verify the current bounded token file and recheck liveness after I/O.
   * @param {unknown} token */
  async assertActiveEviMedWorkloadToken(token) {
    try {
      if (typeof token !== "string" || token.length > 8192) throw workloadTokenError();
      const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
      if (typeof claims.userId !== "string" || typeof claims.projectId !== "string") throw workloadTokenError();
      const payload = verifyEviMedWorkloadToken(token, { secret: this.config.evimedWorkloadSigningSecret,
        userId: claims.userId, projectId: claims.projectId });
      const key = this.key({ userId: payload.userId, id: payload.projectId });
      const runtime = this.runtimes.get(key);
      if (!runtime?.workloadTokenFile || runtime.closedByManager || runtime.exitedAt) throw workloadTokenError();
      if (typeof this.provider.acceptedWorkloadTokens === "function") {
        // A remote runtime's token file is in its session, not on this host:
        // the provider holds what it installed there (and the one it is
        // installing, and the one that one replaces until it expires).
        const actual = Buffer.from(token);
        const accepted = this.provider.acceptedWorkloadTokens({ userId: payload.userId, id: payload.projectId })
          .some((candidate) => {
            const expected = Buffer.from(String(candidate));
            return expected.length === actual.length && timingSafeEqual(expected, actual);
          });
        if (!accepted || this.runtimes.get(key) !== runtime || runtime.closedByManager || runtime.exitedAt) throw workloadTokenError();
        return {
          ...payload,
          runtimeGeneration: typeof runtime.modelGatewayTokenJti === "string" ? runtime.modelGatewayTokenJti : null,
        };
      }
      const handle = await fs.open(runtime.workloadTokenFile, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
      let current;
      try {
        if (!(await handle.stat()).isFile()) throw workloadTokenError();
        const buffer = Buffer.alloc(8193);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        current = buffer.subarray(0, bytesRead).toString("utf8").trim();
      } finally { await handle.close(); }
      const actual = Buffer.from(token);
      const expected = Buffer.from(current);
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)
        || this.runtimes.get(key) !== runtime || runtime.closedByManager || runtime.exitedAt) throw workloadTokenError();
      return {
        ...payload,
        runtimeGeneration: typeof runtime.modelGatewayTokenJti === "string" ? runtime.modelGatewayTokenJti : null,
      };
    } catch { throw workloadTokenError(); }
  }

  assertDockerControlBoundary() {
    const mode = this.runtimeControllerMode;
    if (!["direct", "socket"].includes(mode)) {
      throw new HttpError(503, "runtime_controller_mode_invalid", "Runtime controller mode is invalid.");
    }
    if (
      this.config.production &&
      this.config.runtimeSandboxMode === "docker" &&
      mode !== "socket" &&
      !this.config.allowDirectDockerControl
    ) {
      throw new HttpError(
        503,
        "runtime_controller_required",
        "Production Docker runtimes require the isolated runtime controller.",
      );
    }
  }

  async controllerHealth() {
    if (!this.runtimeController) return null;
    const health = await this.runtimeController.health();
    if (this.config.production && health.releaseId !== this.config.releaseId) {
      throw new HttpError(
        503,
        "runtime_controller_release_mismatch",
        "Runtime controller release does not match the Web API release.",
      );
    }
    // Where the control socket lives is decided by this, on both sides, and a
    // disagreement is not a capacity question: the caller makes one directory
    // and the controller mounts another, so the container is created and never
    // starts. Compared here, with the other things both sides must agree on,
    // rather than discovered as a timeout.
    if (String(health.runtimeDataVolume ?? "") !== String(this.config.runtimeDataVolume ?? "")) {
      throw new HttpError(
        503,
        "runtime_controller_data_volume_mismatch",
        "Runtime controller and Web API disagree about the runtime data volume.",
      );
    }
    const expectedGlobal = positiveLimit(this.config.maxRunningRuntimes);
    const expectedPerUser = positiveLimit(this.config.maxRunningRuntimesPerUser);
    if (
      health.maxRunningRuntimes !== expectedGlobal ||
      health.maxRunningRuntimesPerUser !== expectedPerUser
    ) {
      throw new HttpError(
        503,
        "runtime_controller_limit_mismatch",
        "Runtime controller capacity limits do not match the Web API.",
      );
    }
    return health;
  }

  async assertDockerSupport() {
    this.assertDockerControlBoundary();
    if (!this.runtimeController && !this.config.runtimeDataVolume) return null;
    const info = await this.dockerInfo();
    if (this.config.runtimeDataVolume && (!Number.isSafeInteger(info.major) || info.major < 26)) {
      throw new HttpError(503, "runtime_volume_subpath_unsupported", "Docker Engine 26 or newer is required for project volume subpath mounts.");
    }
    return info;
  }

  async dockerInfo() {
    if (this.runtimeController) {
      await this.controllerHealth();
      return this.runtimeController.dockerInfo();
    }
    const result = spawnSync(
      this.config.runtimeContainerBin,
      ["info", "--format", "{{.ServerVersion}}"],
      { encoding: "utf8", timeout: 5_000 },
    );
    if (result.status !== 0) {
      throw new HttpError(503, "runtime_docker_unavailable", "Docker is unavailable for hosted runtime control.");
    }
    const version = result.stdout.trim();
    const major = Number(version.match(/^(\d+)/)?.[1]);
    if (!Number.isSafeInteger(major)) {
      throw new HttpError(503, "runtime_docker_version_invalid", "Docker returned an invalid server version.");
    }
    return { version, major };
  }

  async inspectRuntimeImage() {
    if (!this.runtimeController) return null;
    return this.runtimeController.inspectRuntimeImage();
  }

  async cleanupDocker(plan, project) {
    if (!this.runtimeController) return cleanupDockerContainer(plan);
    try {
      return await this.runtimeController.cleanupRuntime(project);
    } catch (error) {
      if (error?.code === "runtime_cleanup_failed") {
        return {
          cleaned: false,
          missing: false,
          failed: true,
          reason: "rm_failed",
          error: "Runtime controller container cleanup failed.",
        };
      }
      throw error;
    }
  }

  key(project) {
    return `${project.userId}:${project.id}`;
  }

  runtimeGeneration(project) {
    const runtime = this.runtimes.get(this.key(project));
    return runtime && !runtime.closedByManager && !runtime.exitedAt && typeof runtime.modelGatewayTokenJti === "string"
      ? runtime.modelGatewayTokenJti
      : null;
  }

  boundedRuntimeScope(project) {
    const key = this.key(project);
    return this.runtimes.get(key)?.modelGatewayScope ?? this.pendingModelGatewayScopes.get(key) ?? null;
  }

  assertInteractiveRuntimeAvailable(project) {
    if (this.boundedRuntimeScope(project)) {
      throw new HttpError(423, "runtime_reserved_for_autopilot", "This project runtime is completing bounded proactive research.");
    }
  }

  async reserveBoundedRuntimeSession(project, budgetScope) {
    const key = this.key(project);
    if (this.runtimes.has(key) || this.starts.has(key) || this.pendingModelGatewayScopes.has(key)) {
      throw new HttpError(409, "runtime_busy", "The project runtime is already in use; proactive research will retry later.");
    }
    const scope = {
      runId: safeId(budgetScope?.runId, "bounded run id"),
      dailyLimit: Number(budgetScope?.dailyLimit), weeklyLimit: Number(budgetScope?.weeklyLimit), runLimit: Number(budgetScope?.runLimit),
    };
    if ([scope.dailyLimit, scope.weeklyLimit, scope.runLimit].some((value) => !Number.isFinite(value) || value <= 0)) {
      throw new HttpError(400, "runtime_model_gateway_scope_invalid", "A bounded runtime needs positive spending limits.");
    }
    this.pendingModelGatewayScopes.set(key, scope);
    try {
      const runtime = await this.start(project);
      if (runtime.modelGatewayScope?.runId !== scope.runId) throw new HttpError(500, "runtime_model_gateway_scope_invalid", "Bounded runtime scope was not applied.");
      return { id: randomId("session_"), kernel: RUNTIME_KERNEL_NAME };
    } catch (error) {
      this.pendingModelGatewayScopes.delete(key);
      throw error;
    }
  }

  async endBoundedRuntime(project, runId) {
    const scope = this.boundedRuntimeScope(project);
    if (scope?.runId !== runId) return false;
    this.pendingModelGatewayScopes.delete(this.key(project));
    await this.stop(project);
    return true;
  }

  /**
   * @param {Record<string, any>} project
   * @param {{ opening?: boolean }} [options] `opening`: the researcher is
   *   opening a conversation in this project (the shell's own start of its
   *   frame) rather than a request of a surface that is already open — see
   *   `makeRoomFor`. It shapes only a start this call begins; one already
   *   under way is joined as it is.
   *   `speculative`: the shell guessing a project will be opened (a pointer
   *   over it in the sidebar) — a start that takes free room only. It must
   *   not retire the researcher's other idle runtime: on 2026-09-24 opening
   *   one project's group in the sidebar stopped the warm runtime of another,
   *   and the click into that other one was refused (429) and not usable in
   *   60 s. A caller that is not speculative joining the start lifts it.
   */
  async start(project, options = {}) {
    return this.pluginService ? this.pluginService.withAdmission(project, () => this.startAdmitted(project, options)) : this.startAdmitted(project, options);
  }

  /** @param {Record<string, any>} project @param {{ opening?: boolean, speculative?: boolean }} [options] */
  async startAdmitted(project, { opening = false, speculative = false } = {}) {
    const key = this.key(project);
    await this.runtimeQuotaStops.get(key);
    let existing = this.runtimes.get(key);
    if (existing && existing.workspaceDir !== project.workspaceDir) {
      // Opening the interactive workspace is not permission to interrupt a
      // bounded source/agenda run. Only its owning workflow releases it.
      this.assertInteractiveRuntimeAvailable(project);
      await this.stop(project);
      existing = null;
    }
    // A running runtime is returned without measuring the project. Every
    // proxied request of the session page comes through here, and the walk
    // below used to run on each of them, inside the plugin admission's
    // database transaction: opening one conversation is about thirty requests,
    // and on a project of 3,552 entries they queued behind one another's walks
    // and pool connections until each took 4–6 s (2026-09-19, live, runtime
    // already warm: 29 s to a usable composer). A running runtime is watched by
    // its quota monitor (`runtimeQuotaCheckIntervalMs`), which is what stops it
    // when the project goes over, whoever wrote the bytes.
    if (existing) {
      this.scheduleIdleStop(project);
      return existing;
    }
    if (opening) this.openingStarts.add(key);
    const pending = this.starts.get(key);
    if (pending) {
      if (!speculative) this.speculativeStarts.delete(key);
      return pending;
    }
    if (speculative && !opening) this.speculativeStarts.add(key);

    const started = (async () => {
      this.noteStartStage(project, "environment");
      // Measured, and room made, inside the pending start: registered before
      // the first wait, it is what a second caller arriving meanwhile joins
      // instead of beginning a second container. Its own entry in `starts` is
      // not counted against the ceilings it checks.
      await this.enforceProjectQuota(project);
      await this.makeRoomFor(project, { opening: this.openingStarts.has(key), speculative: this.speculativeStarts.has(key) });
      this.enforceRuntimeCapacity(project, { starting: true });
      const modelGatewayScope = this.pendingModelGatewayScopes.get(key) ?? null;
      if (this.config.runtimeMode === "kernel") {
        const runtime = await this.startKernel(project, modelGatewayScope);
        this.runtimes.set(key, runtime);
        this.pendingModelGatewayScopes.delete(key);
        this.scheduleEviMedWorkloadRefresh(project, runtime);
        this.scheduleIdleStop(project);
        this.scheduleQuotaMonitor(project);
        return runtime;
      }

      if (this.config.production && !this.config.allowMockRuntime) {
        throw new HttpError(503, "runtime_mock_forbidden", "Mock runtime is not allowed in production mode.");
      }

      // The fake speaks the kernel's protocol. A fake that spoke any other
      // would make every test in the suite exercise a code path production
      // does not have.
      this.noteStartStage(project, "kernel");
      const mock = await startMockDshRuntime();
      const runtime = {
        kind: "mock",
        url: mock.url,
        close: mock.close,
        // The mock authenticates exactly as the real 0.1.2 kernel does,
        // including on loopback, and it mints its own browser-session cookie
        // for us. Leaving it off the record here would answer 401 to every
        // call, which arrives at a caller as a bare 502 — the whole suite
        // failing on a missing credential and reporting a protocol mismatch.
        cookie: mock.cookie ?? null,
        sandboxMode: "mock",
        networkMode: null,
        workspaceDir: project.workspaceDir,
        proxyWorkspaceDir: project.workspaceDir,
        startedAt: new Date().toISOString(),
        pid: null,
        exitedAt: null,
        project,
        modelGatewayScope,
      };
      this.runtimes.set(key, runtime);
      this.pendingModelGatewayScopes.delete(key);
      this.scheduleIdleStop(project);
      await appendRuntimeEvent(project, "started", {
        kind: "mock",
        sandboxMode: "mock",
        networkMode: null,
      }, this.config);
      await recordRuntimeState(project, "started", {
        running: true,
        kind: runtime.kind,
        startedAt: runtime.startedAt,
        pid: runtime.pid,
        exitedAt: runtime.exitedAt,
        sandboxMode: runtime.sandboxMode,
        networkMode: runtime.networkMode,
        containerName: null,
      });
      this.scheduleQuotaMonitor(project);
      return runtime;
    })();
    this.starts.set(key, started);
    try {
      const runtime = await started;
      this.startFailures.delete(key);
      try {
        this.onRuntimeStart(project, runtime);
      } catch {
        // isolated: evimed_runtime_start_hook_failures_total — a live-stream
        // attachment failure must not fail the run itself; request/response
        // calls never depend on it.
      }
      return runtime;
    } catch (error) {
      // Kept for the waiting shell. The start that failed is usually the one a
      // frame document triggered, and a refusal served into a frame is a page
      // the shell cannot read the status of: on 2026-09-15 a 429 for the one
      // runtime slot this deployment had was shown as "cold starts sometimes
      // take longer", and the retry looped forever. The status it polls says
      // what happened instead.
      // A guess refused for want of room is no answer to anyone waiting: the
      // frame that opens this project next makes its own room.
      if (!(this.speculativeStarts.has(key) && error?.code === "runtime_limit_exceeded")) {
        this.startFailures.set(key, {
          code: typeof error?.code === "string" ? error.code : "runtime_start_failed",
          status: Number.isSafeInteger(error?.status) ? error.status : 502,
          at: Date.now(),
        });
      }
      throw error;
    } finally {
      this.starts.delete(key);
      this.startProgress.delete(key);
      this.openingStarts.delete(key);
      this.speculativeStarts.delete(key);
    }
  }

  async startKernel(project, modelGatewayScope = null) {
    const key = this.key(project);
    const port = await freePort();
    // Only the controller protocol still carries this: its `startRuntime` field
    // is validated on the privileged side and the launch plan no longer uses
    // it. The retired kernel's HTTP server authenticated with it; this one
    // authenticates with the browser-session cookie minted in
    // `syncRuntimeDshProfile`, so nothing inside the container reads a password.
    const password = randomId("pw_");
    // What the provider cannot start without, refused before anything is
    // written: Docker's daemon, AgentBay's settings.
    await this.provider.preflight?.();
    const pluginConfig = this.pluginOverrides?.get(key) ?? (this.pluginService ? (await this.pluginService.get(project.userId, project)).desired
      : { revision: 0, enabled: true, settings: { timeoutMs: 15000 } });
    // Before the plan, because the plan reads the result: both this side and
    // the privileged controller decide whether to mount the directory by
    // looking at it. Rebuilt every launch, so a method retired between two runs
    // is gone from the next one.
    const mountedMethods = await this.syncCapsuleMethods(project);
    const capsuleMethodsMounted = mountedMethods.count;
    // What the learned half contributed, kept on the runtime so the run ledger
    // can say which revision of which method was in the room. A digest recorded
    // at mount time is the only record that survives the container.
    this.lastMountedLearnedMethods.set(this.key(project), mountedMethods.learned ?? []);
    this.lastMountedCapsuleMethods.set(this.key(project), mountedMethods.capsule ?? []);
    // The provider's own preparation: a container's plan, directories and
    // orphan cleanup, or a cloud session with the project's files carried in.
    const plan = await this.provider.prepare(project, { port, pluginConfig, capsuleMethodsMounted });

    // Nothing is copied into a project any more: the image carries the skill
    // roots and the agent packages read-only, shared across every project. The
    // three counters below stay in the ledger because a record written before
    // this change carries them, and a reader that stops finding a field cannot
    // tell "zero" from "an older record".
    const skillsCopied = 0;
    const agentSkillsCopied = 0;
    const agentsGenerated = 0;
    let mcpSync = {
      copied: 0,
      configured: 0,
      workloadTokenFile: null,
      workloadTokenRefreshMs: null,
    };
    let modelGatewaySync = { configured: 0, token: null, payload: null };
    // Declared beside the other sync results rather than inside the `try`
    // below: the runtime record that mints the cookie from it is built after
    // that block closes, and a `let` inside it is simply not in scope there.
    // Tests never caught it because they take the mock path, which carries its
    // own cookie; lint did.
    /** @type {string | null} */
    let browserSessionSecret = null;
    try {
      // The kernel takes the general skills, the specialist packages and the
      // MCP command as rows of one generated file (`renderProfilePatch`)
      // rather than as separate managed config trees copied per project — the
      // general skills and the MCP source are baked into the image instead
      // (read-only, shared across every project), so there is nothing to copy
      // here. The retired kernel needed three copying passes at this point;
      // they are gone with it.
      const dshSync = await this.provider.bootstrap(project, plan, { budgetScope: modelGatewayScope });
      mcpSync = {
        copied: 0,
        configured: dshSync.configured ? 1 : 0,
        workloadTokenFile: dshSync.workloadTokenFile,
        workloadTokenRefreshMs: dshSync.workloadTokenRefreshMs,
      };
      modelGatewaySync = {
        configured: dshSync.providerConfigured ? 1 : 0,
        token: dshSync.token ?? null,
        payload: dshSync.payload ?? null,
      };
      browserSessionSecret = dshSync.browserSessionSecret ?? null;
    } catch (error) {
      await appendRuntimeEvent(project, "bootstrap_failed", {
        kind: RUNTIME_KERNEL_NAME,
        sandboxMode: plan.sandboxMode,
        networkMode: this.config.runtimeNetworkMode,
        containerName: plan.containerName ?? null,
        error: error?.code ?? "runtime_bootstrap_failed",
      }, this.config);
      await recordRuntimeState(project, "failed", {
        running: false,
        kind: RUNTIME_KERNEL_NAME,
        startedAt: null,
        pid: null,
        exitedAt: null,
        sandboxMode: plan.sandboxMode,
        networkMode: this.config.runtimeNetworkMode,
        containerName: plan.containerName ?? null,
        skillsCopied,
        agentSkillsCopied,
        agentsGenerated,
        capsuleMethodsMounted,
        mcpServersCopied: mcpSync.copied,
        mcpServersConfigured: mcpSync.configured,
        error: "runtime_bootstrap_failed",
      });
      // Carry the specific cause. Bootstrap has half a dozen distinct failures —
      // a config entry that does not look platform-managed, a skill directory
      // that will not copy, a missing model config — and collapsing them all to
      // runtime_bootstrap_failed left the real code only in a ledger file inside
      // a Docker volume. A project that could not start its runtime reported the
      // same sentence whatever was wrong with it.
      const cause = typeof error?.code === "string" && error.code ? error.code : "runtime_bootstrap_failed";
      throw new HttpError(
        error?.status === 409 ? 409 : 500,
        cause,
        `Runtime configuration bootstrap failed before startup (${cause}).`,
      );
    }
    await appendRuntimeEvent(project, "starting", {
      kind: RUNTIME_KERNEL_NAME,
      sandboxMode: plan.sandboxMode,
      networkMode: this.config.runtimeNetworkMode,
      cpuLimit: this.config.runtimeCpuLimit,
      memoryLimit: this.config.runtimeMemoryLimit,
      containerName: plan.containerName ?? null,
      skillsCopied,
      agentSkillsCopied,
      agentsGenerated,
      capsuleMethodsMounted,
      mcpServersCopied: mcpSync.copied,
      mcpServersConfigured: mcpSync.configured,
    }, this.config);
    await recordRuntimeState(project, "starting", {
      running: false,
      kind: RUNTIME_KERNEL_NAME,
      startedAt: null,
      pid: null,
      exitedAt: null,
      sandboxMode: plan.sandboxMode,
      networkMode: this.config.runtimeNetworkMode,
      containerName: plan.containerName ?? null,
      skillsCopied,
      agentSkillsCopied,
      agentsGenerated,
      capsuleMethodsMounted,
      mcpServersCopied: mcpSync.copied,
      mcpServersConfigured: mcpSync.configured,
    });
    this.noteStartStage(project, "kernel");
    let child;
    try {
      child = await this.provider.launch(project, plan, { port, password });
    } catch (error) {
      // A provider that holds something outside this process — a cloud
      // session — lets it go and says why; the Docker provider has nothing to
      // abandon and fails exactly as it always did.
      if (typeof this.provider.abandon === "function") {
        await this.provider.abandon(project, plan).catch(() => {});
        await appendRuntimeEvent(project, "failed", {
          kind: RUNTIME_KERNEL_NAME,
          sandboxMode: plan.sandboxMode,
          containerName: plan.containerName ?? null,
          error: typeof error?.code === "string" ? error.code : "runtime_launch_failed",
        }, this.config);
        await recordRuntimeState(project, "failed", {
          running: false, kind: RUNTIME_KERNEL_NAME, startedAt: null, pid: null, exitedAt: null,
          sandboxMode: plan.sandboxMode, networkMode: plan.networkMode ?? null, containerName: plan.containerName ?? null,
          capsuleMethodsMounted, error: typeof error?.code === "string" ? error.code : "runtime_launch_failed",
        });
      }
      throw error;
    }
    const runtime = {
      pluginConfig: plan.pluginConfig,
      // The kernel that is actually running, from one binding. This was once
      // the literal `opencode` written out in twelve places, so every `exited`,
      // `cleaned_orphan` and state record a DSH container produced was labelled
      // with a kernel that had not run it — harmless on its own, and
      // kernel-blind for any reader that branches on it.
      kind: RUNTIME_KERNEL_NAME,
      url: plan.runtimeUrl ?? `http://127.0.0.1:${port}`,
      socketPath: plan.socketPath ?? null,
      // Bound to the authority the kernel will actually receive in the `Host`
      // header, which is the URL's host even when the connection is dialled
      // over a unix socket. The kernel derives its cookie name from what it
      // received, so a cookie minted for anything else is not a weaker
      // credential — it is a different cookie the kernel never looks for.
      cookie: browserSessionSecret
        ? browserSessionCookie({
          secret: browserSessionSecret,
          authority: new URL(plan.runtimeUrl ?? `http://127.0.0.1:${port}`).host,
        })
        : null,
      sandboxMode: plan.sandboxMode,
      networkMode: plan.networkMode ?? this.config.runtimeNetworkMode,
      workspaceDir: project.workspaceDir,
      proxyWorkspaceDir: plan.proxyWorkspaceDir ?? project.workspaceDir,
      // What a remote session's guest reported: kernel release, Landlock.
      sandbox: this.provider.describe?.(child) ?? null,
      child,
      startedAt: new Date().toISOString(),
      pid: child.pid,
      containerName: plan.containerName ?? null,
      skillsCopied,
      agentSkillsCopied,
      agentsGenerated,
      capsuleMethodsMounted,
      workloadTokenFile: mcpSync.workloadTokenFile,
      workloadTokenRefreshMs: mcpSync.workloadTokenRefreshMs,
      modelGatewayToken: modelGatewaySync.token,
      modelGatewayTokenJti: modelGatewaySync.payload?.jti ?? null,
      modelGatewayScope: modelGatewaySync.payload?.runId ? {
        runId: modelGatewaySync.payload.runId,
        dailyLimit: modelGatewaySync.payload.dailyLimit,
        weeklyLimit: modelGatewaySync.payload.weeklyLimit,
        runLimit: modelGatewaySync.payload.runLimit,
      } : null,
      exitedAt: null,
      spawnError: null,
      project,
      close: async () => this.provider.close(project, plan, child),
    };
    /** @type {any} */ (child).once("error", (err) => {
      runtime.spawnError = err;
      runtime.exitedAt = new Date().toISOString();
      const current = this.runtimes.get(key);
      if (current === runtime) this.runtimes.delete(key);
      this.deactivateModelGatewayRuntime(runtime);
      this.clearIdleTimer(key);
      this.clearQuotaMonitor(key);
      this.clearEviMedWorkloadRefresh(key);
      this.runtimeActivity.delete(key);
      void this.notifyRuntimeStop(project, runtime, "failed");
      void recordRuntimeState(project, "failed", {
        running: false,
        kind: runtime.kind,
        startedAt: runtime.startedAt,
        pid: runtime.pid,
        exitedAt: runtime.exitedAt,
        sandboxMode: runtime.sandboxMode,
        networkMode: runtime.networkMode,
        containerName: runtime.containerName,
        skillsCopied: runtime.skillsCopied,
        agentSkillsCopied: runtime.agentSkillsCopied,
        agentsGenerated: runtime.agentsGenerated,
        capsuleMethodsMounted: runtime.capsuleMethodsMounted,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    // `(code, signal)`, not `()`.
    //
    // Node hands the exit status to this callback and it was discarded, so the
    // ledger's `exited` record carried a pid, a container name and a timestamp
    // and nothing about why. A 19-minute run ended with no explanation
    // available anywhere: the container was started `--rm` so docker had
    // already deleted it, and this host's `docker events` does not retain
    // history. The status was in the argument list the whole time.
    /** @type {any} */ (child).once("exit", (/** @type {number|null} */ code, /** @type {string|null} */ signal) => {
      runtime.exitedAt = new Date().toISOString();
      runtime.exitCode = typeof code === "number" ? code : null;
      runtime.exitSignal = signal ?? null;
      runtime.exitOutput = String(/** @type {any} */ (child).exitOutput ?? "");
      const current = this.runtimes.get(key);
      if (current === runtime) this.runtimes.delete(key);
      this.deactivateModelGatewayRuntime(runtime);
      this.clearIdleTimer(key);
      this.clearQuotaMonitor(key);
      this.clearEviMedWorkloadRefresh(key);
      this.runtimeActivity.delete(key);
      if (runtime.closedByManager) return;
      void this.notifyRuntimeStop(project, runtime, "failed");
      void appendRuntimeEvent(project, "exited", {
        kind: runtime.kind,
        sandboxMode: runtime.sandboxMode,
        pid: runtime.pid,
        containerName: runtime.containerName,
        exitedAt: runtime.exitedAt,
        // Why, not just when. 137 with a signal is a kill; 137 without one is
        // usually the kernel's OOM killer, and the two lead to opposite fixes.
        exitCode: runtime.exitCode,
        exitSignal: runtime.exitSignal,
        // The container's last words, already bounded by the tail buffer. A
        // run whose kernel refused to start says so here and nowhere else.
        exitOutput: runtime.exitOutput ? String(runtime.exitOutput).slice(-RUNTIME_EXIT_OUTPUT_BYTES) : "",
        // What the run reached before it stopped. 137 is SIGKILL and says
        // nothing about who sent it: the cgroup OOM killer and an operator's
        // `docker kill` produce the same code, and the peaks are what tell
        // them apart. Both ceilings killed a run on consecutive attempts.
        peakPids: runtime.peakPids ?? null,
        peakMemoryBytes: runtime.peakMemoryBytes ?? null,
      }, this.config);
      // Removed here, after the record above has been written.
      //
      // `close()` cleans up when the manager stops a runtime, but a container
      // that dies on its own never reaches it — that was `--rm`'s job, and
      // `--rm` is what deleted the evidence before anyone could read it. The
      // order is the whole point: ask, then remove.
      this.provider.afterExit(project, plan);
      void recordRuntimeState(project, "exited", {
        running: false,
        kind: runtime.kind,
        startedAt: runtime.startedAt,
        pid: runtime.pid,
        exitedAt: runtime.exitedAt,
        sandboxMode: runtime.sandboxMode,
        networkMode: runtime.networkMode,
        containerName: runtime.containerName,
        skillsCopied: runtime.skillsCopied,
        agentSkillsCopied: runtime.agentSkillsCopied,
        agentsGenerated: runtime.agentsGenerated,
        capsuleMethodsMounted: runtime.capsuleMethodsMounted,
      });
    });
    try {
      await this.waitUntilReady(runtime);
      if (runtime.workloadTokenFile) {
        await this.provider.writeWorkloadToken(project, runtime);
      }
      this.activateModelGatewayRuntime(project, runtime);
      await appendRuntimeEvent(project, "started", {
        kind: runtime.kind,
        sandboxMode: runtime.sandboxMode,
        networkMode: runtime.networkMode,
        pid: runtime.pid,
        containerName: runtime.containerName,
        skillsCopied: runtime.skillsCopied,
        agentSkillsCopied: runtime.agentSkillsCopied,
        agentsGenerated: runtime.agentsGenerated,
        capsuleMethodsMounted: runtime.capsuleMethodsMounted,
      }, this.config);
      await recordRuntimeState(project, "started", {
        running: true,
        kind: runtime.kind,
        startedAt: runtime.startedAt,
        pid: runtime.pid,
        exitedAt: runtime.exitedAt,
        sandboxMode: runtime.sandboxMode,
        networkMode: runtime.networkMode,
        containerName: runtime.containerName,
        skillsCopied: runtime.skillsCopied,
        agentSkillsCopied: runtime.agentSkillsCopied,
        agentsGenerated: runtime.agentsGenerated,
        capsuleMethodsMounted: runtime.capsuleMethodsMounted,
        sandbox: runtime.sandbox,
      });
    } catch (err) {
      this.deactivateModelGatewayRuntime(runtime);
      await runtime.close();
      await appendRuntimeEvent(project, "failed", {
        kind: runtime.kind,
        sandboxMode: runtime.sandboxMode,
        containerName: runtime.containerName,
        error: err instanceof Error ? err.message : String(err),
      }, this.config);
      await recordRuntimeState(project, "failed", {
        running: false,
        kind: runtime.kind,
        startedAt: runtime.startedAt,
        pid: runtime.pid,
        exitedAt: runtime.exitedAt,
        sandboxMode: runtime.sandboxMode,
        networkMode: runtime.networkMode,
        containerName: runtime.containerName,
        skillsCopied: runtime.skillsCopied,
        agentSkillsCopied: runtime.agentSkillsCopied,
        agentsGenerated: runtime.agentsGenerated,
        capsuleMethodsMounted: runtime.capsuleMethodsMounted,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    return runtime;
  }

  /**
   * The project's knowledge-base directory, created empty when missing, so the
   * launch can mount it read-only (`readOnlyWorkspaceViews`). A failure leaves
   * the launch without that view rather than without a runtime.
   * @param {Record<string, any>} project
   */
  async ensureKnowledgeBaseDir(project) {
    if (!project.baseDir || path.resolve(String(project.workspaceDir)) !== path.resolve(String(project.baseDir))) return;
    const opened = await openScopedDirectoryNoFollow(project.baseDir, path.join(project.baseDir, KNOWLEDGE_BASE_DIR), { create: true })
      .catch(() => null);
    await opened?.handle.close();
  }

  async waitUntilReady(runtime) {
    // Not the per-call connect timeout: starting is not calling. See the note
    // on `runtimeReadyTimeoutMs` in config.mjs.
    //
    // The longer allowance is for a container, which is where composing a
    // plugin tree takes a minute. A host runtime starts a process that either
    // binds a port or does not, and giving it three minutes to do so would turn
    // "the binary is missing" into a three-minute wait.
    const timeoutMs = runtime.sandboxMode === "docker" || runtime.sandboxMode === "agentbay"
      ? (this.config.runtimeReadyTimeoutMs ?? this.config.runtimeProxyConnectTimeoutMs)
      : this.config.runtimeProxyConnectTimeoutMs;
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      const probeController = new AbortController();
      const probeTimeoutMs = Math.min(
        RUNTIME_READINESS_PROBE_TIMEOUT_MS,
        Math.max(1, deadline - Date.now()),
      );
      const probeTimer = setTimeout(() => {
        probeController.abort(new DOMException("Runtime readiness probe timed out.", "TimeoutError"));
      }, probeTimeoutMs);
      probeTimer.unref?.();
      try {
        // The probe is one real wire call, so it answers the question the
        // caller actually has — is the protocol up — rather than whether
        // something is listening.
        //
        // The retired kernel was probed on `/config`, which DSH does not serve
        // at all: the probe got a permanent 404, accepting anything under 500
        // hid that, and it hid the real race too — DSH binds its port before
        // mounting `/api`, so the first session call after readiness could
        // still come back `runtime_wire_protocol_mismatch`.
        //
        // 0.1.2 removed `host.describe` with the rest of ApiProxy and renamed
        // every method from dotted to slashed. `session/list` is the probe now,
        // and because 0.1.2 authenticates on loopback where 0.1.1 did not, it
        // also proves the browser-session cookie. A probe that only found a
        // listening port would pass against a kernel that refuses every call.
        const target = `${runtime.url}/api/session/list`;
        const res = await requestRuntime(runtime, target, {
          method: "POST",
          headers: {
            ...(runtime.cookie ? { cookie: runtime.cookie } : {}),
            "content-type": "application/json",
          },
          body: Buffer.from(JSON.stringify({
            type: "client-request",
            rpcId: randomId("rpc_"),
            method: "session/list",
            payload: { args: { _request: {} } },
          }), "utf8"),
          signal: probeController.signal,
        });
        const status = res.status;
        await res.body?.cancel().catch(() => {});
        if (status === 404) {
          lastError = new Error("runtime is listening but its /api routes are not mounted yet");
        } else if (status === 401) {
          // Distinct from "not up yet" on purpose: retrying will never fix it,
          // and before the cookie existed this arrived as a three-minute
          // timeout with nothing said about authentication.
          lastError = new Error("runtime refused the probe as unauthenticated (HTTP 401); its browser-session cookie is missing or was minted for another authority");
        } else if (status < 500) {
          return;
        } else {
          lastError = new Error(`runtime returned HTTP ${status}`);
        }
      } catch (err) {
        lastError = err;
      } finally {
        clearTimeout(probeTimer);
      }
      if (runtime.child?.exitCode != null || runtime.child?.signalCode != null) {
        throw new HttpError(502, "runtime_exited", runtimeExitDiagnosis(runtime, lastError));
      }
      if (runtime.spawnError) {
        throw new HttpError(502, "runtime_spawn_failed", runtime.spawnError.message);
      }
      await sleep(100);
    }
    throw new HttpError(
      504,
      "runtime_start_timeout",
      lastError instanceof Error ? lastError.message : "Runtime did not become ready in time.",
    );
  }

  async status(project) {
    const key = this.key(project);
    const runtime = this.runtimes.get(key);
    const provider = this.providerName();
    if (runtime) {
      return publicRuntimeStatus(runtime, {
        stale: false,
        lastEvent: "started",
        lastUpdatedAt: runtime.startedAt,
        skillsCopied: runtime.skillsCopied,
        agentSkillsCopied: runtime.agentSkillsCopied,
        agentsGenerated: runtime.agentsGenerated,
        capsuleMethodsMounted: runtime.capsuleMethodsMounted,
        provider,
      });
    }
    // Where a start is, or why the last one did not happen, for the shell that
    // is waiting on it. A refusal is reported only while it is recent and no
    // start is under way: a start that followed it is the newer answer.
    const startStage = this.starts.has(key) ? this.startProgress.get(key)?.stage ?? "environment" : null;
    const failure = startStage ? null : this.startFailures.get(key);
    const startError = failure && Date.now() - failure.at < START_FAILURE_VISIBLE_MS
      ? { code: failure.code, status: failure.status, at: new Date(failure.at).toISOString() }
      : null;
    const fields = { provider, startStage, startError };
    const state = await readRuntimeState(project);
    if (state) return publicRuntimeStatusFromState(state, fields);
    return publicRuntimeStatus(null, fields);
  }

  runtimeWorkspaceRoot(project) {
    const runtime = this.runtimes.get(this.key(project));
    return runtime?.proxyWorkspaceDir ?? project.workspaceDir;
  }

  /**
   * The same root, asked by the run ledger right before the delivery gate
   * reads a finished run's files: a provider whose runtime writes somewhere
   * other than the host copy brings that copy up to date first (plan §3.1
   * #4). A sync that fails or does not finish leaves the gate the host copy
   * as it is — the gate still runs, and the Context's own upload is the net.
   * @param {Record<string, any>} project
   */
  async workspaceRootForDelivery(project) {
    await this.provider.beforeDelivery?.(project)?.catch?.(() => {});
    return this.runtimeWorkspaceRoot(project);
  }

  /**
   * A control-plane write into the workspace that a running remote kernel
   * must see too. The host copy is already written; this carries it over.
   * @param {Record<string, any>} project @param {string} relative @param {string} content @param {boolean} required
   */
  async mirrorWorkspaceWrite(project, relative, content, required = false) {
    if (typeof this.provider.mirrorWrite !== "function") return;
    try {
      await this.provider.mirrorWrite(project, relative, content);
    } catch (error) {
      if (required) throw error;
      // isolated: evimed_runtime_mirror_write_failures_total
    }
  }

  /**
   * A researcher's upload that a running remote kernel should see now; the
   * host copy is already written. Only a file inside the project's workspace
   * is carried, and a failure waits for the next start's push.
   * @param {Record<string, any>} project @param {string} file absolute host path @param {Buffer} content
   */
  async mirrorWorkspaceUpload(project, file, content) {
    if (typeof this.provider.mirrorUpload !== "function") return false;
    const relative = path.relative(path.resolve(project.workspaceDir), path.resolve(file));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false;
    try {
      return await this.provider.mirrorUpload(project, relative.split(path.sep).join("/"), content);
    } catch {
      // isolated: evimed_runtime_mirror_upload_failures_total
      return false;
    }
  }

  /** Every call into a runtime container needs a deadline. Without one, a socket
   *  that accepts and never answers parks the caller forever, and every guard
   *  built on counting polls stops counting. The connect timeout is the right
   *  scale here: these are local reads of a container's own state, not model
   *  work.
   *  @param {(signal: AbortSignal) => Promise<any>} operation
   *  @param {string} code @param {string} message */
  async withRuntimeDeadline(operation, code, message) {
    const timeoutMs = positiveLimit(this.config.runtimeProxyConnectTimeoutMs) ?? 30_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(message)), timeoutMs);
    timer.unref?.();
    try {
      return await operation(controller.signal);
    } catch (error) {
      if (controller.signal.aborted) {
        process.stderr.write(`${code}: no answer within ${timeoutMs}ms\n`);
        throw new HttpError(504, code, message);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The whole run, as the ledger reads it.
   *
   * The history arrives as a session event log, is normalized by
   * `sessionTranscript`, then projected into the message shape the ledger has
   * always read. The projection is a migration step with a stated end (see
   * `transcriptToLedgerMessages`), not a permanent compatibility layer.
   */
  async sessionMessages(project, sessionId, { wake = true, parentSessionId = null } = {}) {
    const transcript = await this.sessionTranscript(project, sessionId, { wake, parentSessionId });
    return transcriptToLedgerMessages(transcript);
  }

  /**
   * The kernel's catalogue of one session's direct children, with the address
   * each one must be read at.
   *
   * @param {Record<string, any>} project @param {string} parentSessionId
   * @returns {Promise<Record<string, any>[]>}
   */
  async subagentCatalogue(project, parentSessionId) {
    const runtime = this.runtimes.get(this.key(project));
    if (!runtime) return [];
    this.beginProxy(project);
    try {
      return await this.withRuntimeDeadline(
        (signal) => this.callKernel(runtime, project, "subagents/list", { parentSessionId }, signal),
        "runtime_history_unavailable",
        "Runtime subagent catalogue did not answer in time.",
      ).then(subagentListItems);
    } finally {
      this.endProxy(project);
    }
  }

  /**
   * The address a direct child of `parentSessionId` must be read at, or null
   * when the kernel's catalogue does not list it. Never composed from a guess:
   * the kernel checks the mode against the child's descriptor.
   *
   * @param {Record<string, any>} project @param {string} parentSessionId @param {string} childSessionId
   */
  async subagentAddressFor(project, parentSessionId, childSessionId) {
    const rows = await this.subagentCatalogue(project, parentSessionId);
    const row = rows.find((item) => String(item?.id ?? item?.childSessionId ?? "") === String(childSessionId));
    return row ? subagentAddress(parentSessionId, row) : null;
  }

  /**
   * The run as `@evimed/domain` describes it: the kernel's event log,
   * normalized into the one vocabulary every caller reads.
   *
   * A subagent session cannot be read at its own id — the kernel refuses it with
   * "subagent Sessions require their durable parent address" — so a caller that
   * knows the session's parent passes `parentSessionId` and the address is
   * resolved here, from the kernel's own `subagents/list`. Resolved in ONE place
   * on purpose: the first fix composed the address inside the transcript
   * collector only, and the delivery gate's own reader of delegated sessions
   * kept asking at the bare id, swallowed the refusal, and so never saw a single
   * source file a child had preserved. Every clinical-evidence run that
   * delegated its full-text retrieval was refused for "a path no evidence tool
   * reported preserving" that a child had in fact preserved.
   */
  async sessionTranscript(project, sessionId, { wake = true, address = null, parentSessionId = null } = {}) {
    const runtime = wake ? await this.start(project) : this.runtimes.get(this.key(project));
    if (!runtime) {
      throw new HttpError(409, "runtime_not_running", "Runtime is not running for session history monitoring.");
    }
    // Before this call's own proxy slot is taken: the catalogue read takes one
    // of its own, and a nested pair would count double against the capacity.
    if (!address && parentSessionId) {
      address = await this.subagentAddressFor(project, parentSessionId, sessionId);
    }
    this.beginProxy(project);
    try {
      // Pages, not one flat array, because they are joined with `flat()` at the
      // end rather than spread into `unshift`. Spreading passes every element
      // as a call argument, and the comment below records pages of 130k chunk
      // events: `entries.unshift(...pageEntries)` threw `Maximum call stack
      // size exceeded` on exactly such a page, every poll, so a finished run
      // sat `running` forever while the monitor logged the same line each time.
      // The engine's argument limit is not a number this code should be near.
      // 0.1.2 makes the caller name the sequence it is reading through, and a
      // number past the end returns NOTHING rather than the tail — so asking
      // for "everything" with a large constant would read as an empty run,
      // which is the exact failure this whole transcript path exists to make
      // impossible. The head sequence is published per session by
      // `session/list` as `projections.asOfSeq`.
      const listed = await this.withRuntimeDeadline(
        (signal) => this.callKernel(runtime, project, "session/list", { _request: {} }, signal),
        "runtime_history_unavailable",
        "Runtime session list did not answer in time.",
      );
      const head = sessionListItems(listed)
        .find((item) => String(item?.sessionId) === String(sessionId));
      const throughSeq = Number(head?.projections?.asOfSeq ?? NaN);
      if (!Number.isFinite(throughSeq)) {
        // A session the kernel has not created yet has produced nothing, and
        // that is the baseline every run starts from rather than a failure —
        // the paging loop below has always treated `runtime_session_not_found`
        // exactly this way, and reading the head sequence first must not turn
        // the same fact into an error one step earlier. It did: every dispatch
        // began by reading a transcript for a session that does not exist yet,
        // so the whole ledger answered 502 before any gate ran.
        //
        // The adapter's own `transcript()` throws on the same condition on
        // purpose, and the two are not in conflict: it is read once a run has
        // finished, where "the kernel never heard of this session" really is an
        // error, while this path is read from the first moment of a run.
        return normalizeTranscript(sessionId, []);
      }
      /** @type {Record<string, any>[][]} */
      const pages = [];
      /** @type {number | undefined} */
      let beforeSeq;
      // Whether the walk backwards reached the start of the session. See the
      // note on the adapter's copy: this is the only truthful truncation
      // signal, and deriving one by comparing sequence numbers instead
      // reported every finished run as truncated.
      let exhausted = false;
      // 200 pages x 25 messages bounds a transcript at 5000 messages -- the
      // page shrink above must not quietly shrink the whole readable run.
      for (let page = 0; page < 200; page += 1) {
        let value;
        try {
          value = await this.withRuntimeDeadline(
            (signal) => this.callKernel(runtime, project, "session/page", {
              request: {
                // A subagent session cannot be read at its own id. The kernel
                // refuses it by name — `session/agent-busy`, "subagent Sessions
                // require their durable parent address" — and wants
                // `{kind:'subagent', parentSessionId, childSessionId, mode}`
                // instead. Every delegated child read as `child_unreadable`
                // until 2026-09-16 for exactly this, which made every run that
                // delegated report `completeness: partial` and dropped every
                // cell of a paired evaluation. The address is the one the
                // kernel's own `subagents/list` publishes, never one composed
                // here, because `mode` has to match the descriptor.
                address: address ?? { kind: "session", sessionId },
                throughSeq,
              // The kernel pages by MESSAGE, but each page carries every
              // assistant/chunk delta between its messages. A real run's
              // single 74-step turn put 130k chunk events under 49 messages:
              // one 200-message page weighed 24MB, every read of it threw 413
              // against maxJsonBytes, and the ledger went blind mid-run — no
              // progress events, no turn/end, a finished run left running.
              // Small pages bound the per-read weight; the raised byte cap
              // below absorbs the worst single page.
                maxMessages: 25,
                ...(beforeSeq == null ? {} : { beforeSeq }),
              },
            }, signal, { maxBytes: HISTORY_PAGE_MAX_BYTES }),
            "runtime_history_unavailable",
            "Runtime session history did not answer in time.",
          );
        } catch (error) {
          // A session the kernel has not created yet has produced nothing. That
          // is the baseline every run starts from, not a failure — treating it
          // as one would make the first read of every run an error.
          if (error?.code === "runtime_session_not_found") break;
          throw error;
        }
        const pageEntries = Array.isArray(value?.records) ? value.records : [];
        pages.unshift(pageEntries);
        if (!value?.hasMore || !pageEntries.length) { exhausted = true; break; }
        const firstSeq = Number(pageEntries[0]?.event?.seq ?? NaN);
        if (!Number.isFinite(firstSeq)) break;
        beforeSeq = firstSeq;
      }
      return { ...normalizeTranscript(sessionId, pages.flat()), exhausted };
    } finally {
      this.endProxy(project);
    }
  }

  /**
   * Running state under the DSH kernel.
   *
   * There is no `session.status` method — the kernel publishes running-state
   * flips on its host event stream instead. `session.list` carries the same bit
   * per session and is a request rather than a subscription, which is what a
   * monitor poll needs. A session the kernel has never heard of is `idle`, not
   * an error: that is the state every run starts in.
   * @param {Record<string, any>} project @param {string} sessionId @param {{ wake?: boolean }} options
   * @returns {Promise<'idle'|'busy'>}
   */
  async sessionStatus(project, sessionId, { wake = true } = {}) {
    const runtime = wake ? await this.start(project) : this.runtimes.get(this.key(project));
    if (!runtime) {
      throw new HttpError(409, "runtime_not_running", "Runtime is not running for session status monitoring.");
    }
    this.beginProxy(project);
    try {
      const value = await this.withRuntimeDeadline(
        (signal) => this.callKernel(runtime, project, "session/list", { _request: {} }, signal),
        "runtime_status_unavailable",
        "Runtime session status did not answer in time.",
      );
      const items = sessionListItems(value);
      const entry = items.find((item) => String(item?.sessionId) === String(sessionId));
      return entry?.running ? "busy" : "idle";
    } finally {
      this.endProxy(project);
    }
  }

  /** Authenticated sequence heads for declared direct children of one root.
   * Candidate ids come from the run projection; the kernel catalogue must
   * independently confirm their parent before they can count as activity.
   *
   * With `discoverSince`, also every direct child the kernel lists under this
   * parent that was created after that moment, marked `discovered`: the
   * kernel's own `origin: 'subagent'` and `parentSessionId` are what make it
   * this run's child, so no model-written record has to name it first.
   * @param {Record<string, any>} project @param {string} parentSessionId
   * @param {readonly string[]} childSessionIds
   * @param {{ discoverSince?: number }} [options]
   * @returns {Promise<{ sessionId: string, asOfSeq: number, running: boolean, discovered?: boolean }[]>}
   */
  async childSessionActivity(project, parentSessionId, childSessionIds, { discoverSince } = {}) {
    const runtime = this.runtimes.get(this.key(project));
    const discovering = Number.isFinite(discoverSince);
    if (!runtime || !Array.isArray(childSessionIds) || (childSessionIds.length === 0 && !discovering)) return [];
    const parent = safeId(parentSessionId, "parent session id");
    const candidates = childSessionIds.slice(0, 64).map((value) => safeId(value, "child session id"));
    this.beginProxy(project);
    try {
      const value = await this.withRuntimeDeadline(
        (signal) => this.callKernel(runtime, project, "session/list", { _request: {} }, signal),
        "runtime_history_unavailable",
        "Runtime child session status did not answer in time.",
      );
      return childSessionHeads(sessionListItems(value), parent, candidates, discovering ? { discoverSince } : {});
    } finally {
      this.endProxy(project);
    }
  }

  /** Cancel one DSH session without stopping other interactive work in the project. */
  async cancelRuntimeSession(project, sessionId) {
    const runtime = this.runtimes.get(this.key(project));
    if (!runtime) return false;
    this.beginProxy(project);
    try {
      await this.withRuntimeDeadline(
        (signal) => this.callKernel(runtime, project, "session/cancel", { request: { sessionId: safeId(sessionId, "session id") } }, signal),
        "runtime_cancel_unavailable",
        "Runtime session cancellation did not answer in time.",
      );
      return true;
    } finally {
      this.endProxy(project);
    }
  }

  /**
   * Sends a prompt to a session, creating it if the kernel has not seen it yet.
   *
   * The research context does not travel with the prompt: this protocol has no
   * `system` field, and inventing a side channel for it would have broken the
   * runtime's own invariant that everything the model sees is in the log. It is
   * written into the session-scoped workspace before dispatch. The brief index
   * commits that write with this request's id, and the socket injects every new
   * revision as a first-class logged message before the corresponding step.
   *
   * @param {Record<string, any>} project @param {string} sessionId
   * `mode` is the kernel's own delivery vocabulary. `queue` hands the message
   * to `agent.followup`, which the agent reads after the turn it is in; `steer`
   * hands it to `agent.steer`, which the running turn reads at its next
   * boundary. Both are accepted while the agent is busy — that was verified on
   * the pinned kernel rather than read from its documentation.
   *
   * @param {Record<string, any>} project @param {string} sessionId
   * @param {{ text: string, system?: string | null, memoryContext?: string | null, residentProfile?: boolean, agent?: string | null, model?: string | null, runId?: string | null, requestId?: string, strictContext?: boolean, allowBounded?: boolean, mode?: 'queue' | 'steer' }} input
   * @returns {Promise<void>}
   */
  async dispatchPrompt(project, sessionId, input) {
    try {
      return this.pluginService ? await this.pluginService.withAdmission(project, () => this.dispatchAdmittedPrompt(project, sessionId, input), { prompt: true })
        : await this.dispatchAdmittedPrompt(project, sessionId, input);
    } catch (error) {
      if (error?.code === "plugin_apply_in_progress") error.definitivelyRejected = true;
      throw error;
    }
  }

  async dispatchAdmittedPrompt(project, sessionId, { text, system = null, memoryContext = null, residentProfile = false, runId = null, requestId = randomId("req_"), strictContext = false, allowBounded = false, mode = "queue" }) {
    const runtime = this.runtimes.get(this.key(project));
    if (!runtime) {
      const error = new HttpError(409, "runtime_prompt_rejected", "Runtime was not available to accept the prompt.");
      error.definitivelyRejected = true;
      throw error;
    }
    if (runtime.modelGatewayScope && !allowBounded) this.assertInteractiveRuntimeAvailable(project);
    if (typeof system === "string" && system.trim()) {
      await this.writeRunContextFile(project, system, { sessionId: strictContext ? sessionId : null, required: strictContext });
    }
    // Written even when empty: on the shared path a dispatch that recalled
    // nothing must not leave the previous dispatch's memories for a child to
    // inherit.
    if (typeof memoryContext === "string") {
      await this.writeRunMemoryFile(project, memoryContext, { sessionId: strictContext ? sessionId : null, required: strictContext });
    }
    // Only where the researcher's own context belongs: a dispatch into the
    // project's workspace that also recalled memories. A verification, a
    // source reading or a learning run works in a directory of its own and
    // passes no memories on purpose; it does not ask for this either.
    if (residentProfile) await this.syncCapsuleProfile(project);
    if (typeof runId === "string" && runId) {
      await this.writeRunBriefIndex(project, runId, {
        sessionId: strictContext ? sessionId : null,
        required: strictContext,
        contextRevision: requestId,
      });
    }
    await this.enforceProjectQuota(project);
    this.beginProxy(project);
    try {
      await this.withRuntimeDeadline(
        (signal) => this.callKernel(runtime, project, "session/create", {
          request: {
            sessionId,
            cwd: runtime.proxyWorkspaceDir ?? project.workspaceDir,
            agentPreset: EVIMED_AGENT_PRESET,
          },
        }, signal),
        "runtime_prompt_rejected",
        "The runtime did not create the session in time.",
      );
      await this.withRuntimeDeadline(
        (signal) => this.callKernel(runtime, project, "session/prompt", {
          request: {
            // 0.1.2 requires the client's own identity for this submission; the
            // kernel echoes it on the queued message so a client can retire its
            // local echo. Ledger dispatches reserve this identity before
            // sending; other callers use the per-call default above.
            requestId: safeId(requestId, "runtime request id"),
            sessionId,
            // `queue` unless the caller is correcting a turn that is already
            // running. The kernel routes the two to different methods and the
            // difference is visible to the model: a queued message arrives
            // after the current turn, a steered one inside it.
            mode: mode === "steer" ? "steer" : "queue",
            content: [{ type: "text", text }],
          },
        }, signal),
        "runtime_prompt_acceptance_unknown",
        "Runtime prompt acceptance could not be confirmed.",
      );
    } finally {
      this.endProxy(project);
    }
  }

  /**
   * Materializes the research context into the workspace.
   *
   * Failure is not a reason to refuse a dispatch: the run still has the brief
   * itself, and losing the knowledge slices degrades the answer rather than
   * invalidating the run.
   * @param {Record<string, any>} project @param {string} context
   * @returns {Promise<void>}
   */
  async writeRunContextFile(project, context, { sessionId = null, required = false } = {}) {
    const write = async () => {
      const session = sessionId == null ? null : safeId(sessionId, "session id");
      const relative = session ? `.evimed-brief/sessions/${session}/context.md` : ".evimed-brief/context.md";
      const file = path.join(project.workspaceDir, relative);
      await writeFileAtomicNoFollow(project.workspaceDir, file, context, { encoding: "utf8", mode: 0o444 });
      await this.mirrorWorkspaceWrite(project, relative, context, required);
    };
    if (required) return write();
    // isolated: evimed_run_context_write_failures_total
    try {
      await write();
    } catch { /* isolated: evimed_run_context_write_failures_total */ }
  }

  /**
   * Writes the resident capsule profile (`workspaceLayout.capsuleProfileFile`)
   * the socket injects at the start of every run in this workspace — including
   * the turns typed into the kernel's own window, which no dispatch precedes;
   * that is why the frame route calls this too.
   *
   * Rendered from the researcher's own capsule, and empty when recall is off
   * (`OPEN_SCIENCE_MEMORY_RECALL_ENABLED`): a profile left from before the
   * switch was thrown would keep reaching runs the operator meant to run
   * without memory. Empty with no file on disk writes nothing, so a project
   * that never had a capsule gains no directory. Isolated like the other
   * context files — a run without the block is degraded, not invalid.
   *
   * @param {Record<string, any>} project
   * @returns {Promise<{ written: boolean, chars: number, error?: string }>}
   */
  async syncCapsuleProfile(project) {
    try {
      const profile = this.capsuleService && this.config.memoryRecallEnabled !== false
        ? renderCapsuleProfile(await this.capsuleService.profileFacts(String(project.userId), String(project.id), CAPSULE_PROFILE_FACT_KINDS))
        : "";
      const file = path.join(project.workspaceDir, workspaceLayout.capsuleProfileFile);
      if (!profile && !(await fs.lstat(file).catch(() => null))) return { written: false, chars: 0 };
      await writeFileAtomicNoFollow(project.workspaceDir, file, profile, { encoding: "utf8", mode: 0o444 });
      await this.mirrorWorkspaceWrite(project, workspaceLayout.capsuleProfileFile, profile);
      return { written: true, chars: profile.length };
    } catch (error) {
      // isolated: evimed_capsule_profile_write_failures_total
      return { written: false, chars: 0, error: typeof error?.code === "string" ? error.code : "capsule_profile_write_failed" };
    }
  }

  /**
   * Materializes the recalled memories beside the research context.
   *
   * The context already carries them, for the root. This copy is for the
   * socket's delegation: a child never sees `context.md`, and until this file
   * existed the only memory a child got was whatever its parent paraphrased
   * into the brief excerpt. Same isolation rule as the context file — losing
   * it degrades the child's context rather than invalidating the run.
   * @param {Record<string, any>} project @param {string} memoryContext
   * @returns {Promise<void>}
   */
  async writeRunMemoryFile(project, memoryContext, { sessionId = null, required = false } = {}) {
    const write = async () => {
      const session = sessionId == null ? null : safeId(sessionId, "session id");
      const relative = session ? `.evimed-brief/sessions/${session}/memory.md` : workspaceLayout.briefMemoryFile;
      const file = path.join(project.workspaceDir, relative);
      await writeFileAtomicNoFollow(project.workspaceDir, file, memoryContext, { encoding: "utf8", mode: 0o444 });
      await this.mirrorWorkspaceWrite(project, relative, memoryContext, required);
    };
    if (required) return write();
    // isolated: evimed_run_memory_write_failures_total
    try {
      await write();
    } catch { /* isolated: evimed_run_memory_write_failures_total */ }
  }

  /**
   * Writes the run's own id into the workspace.
   *
   * The `evimed-run-policy` plugin has no other way to learn it: the wire
   * protocol's `session.create`/`session.prompt` carry a session id, never the
   * ledger's run id, so absent this file the plugin's own `runId` stays empty
   * and every write it makes to the run-mirror tables (`runMirror`, `planIndex`,
   * `gateRuns`) is gated on that id and silently never happens — which in turn
   * means `.evimed-run/state.json`, the projection the control plane and the
   * browser read for evidence, plan and gate state, is never produced either.
   * Failure here is isolated for the same reason `writeRunContextFile`'s is:
   * the run still has its ledger entry, and losing the projection degrades
   * what a live viewer sees rather than invalidating the run.
   * @param {Record<string, any>} project @param {string} runId
   * @returns {Promise<void>}
   */
  async writeRunBriefIndex(project, runId, { sessionId = null, required = false, contextRevision = null } = {}) {
    const write = async () => {
      const session = sessionId == null ? null : safeId(sessionId, "session id");
      const relative = session ? `.evimed-brief/sessions/${session}/index.json` : workspaceLayout.briefIndexFile;
      const index = {
        runId,
        ...(typeof contextRevision === "string" && contextRevision ? { contextRevision } : {}),
      };
      const text = `${JSON.stringify(index, null, 2)}\n`;
      await writeFileAtomicNoFollow(project.workspaceDir, path.join(project.workspaceDir, relative), text, {
        encoding: "utf8", mode: 0o444,
      });
      await this.mirrorWorkspaceWrite(project, relative, text, required);
    };
    if (required) return write();
    // isolated: evimed_run_brief_index_write_failures_total
    try {
      await write();
    } catch { /* isolated: evimed_run_brief_index_write_failures_total */ }
  }

  /**
   * Start, in the background of a sign-in, the runtime of the project this
   * account used last (plan §3.1 #8), so the project the reader opens next is
   * already running when they reach it.
   *
   * "Last" is read from each project's own runtime state file — the time its
   * runtime last changed state — because nothing else in the control plane
   * remembers which project an account used: the browser's remembered project
   * is wiped on sign-out, which is exactly the moment before this runs. A
   * project that never had a runtime is older than any that did, and among
   * those `default` wins, which is where a first sign-in lands.
   *
   * Returns the id it started, or null. The caller does not wait on it: a warm
   * start is a head start, never a precondition, and the start it triggers is
   * the same admitted, capped start any request would make.
   *
   * @param {Record<string, any>[]} projects the account's open projects
   * @returns {Promise<string | null>}
   */
  async warmMostRecent(projects) {
    if (!this.config.runtimeWarmOnSignIn || !Array.isArray(projects) || projects.length === 0) return null;
    let chosen = null;
    let chosenAt = -1;
    for (const project of projects) {
      const state = await readRuntimeState(project).catch(() => null);
      const at = Date.parse(String(state?.updatedAt ?? "")) || (project.id === "default" ? 0.5 : 0);
      if (at > chosenAt) {
        chosen = project;
        chosenAt = at;
      }
    }
    if (!chosen) return null;
    await this.start(chosen);
    return String(chosen.id);
  }

  /** Reserve a control-plane session id without starting it in DSH. The caller
   * can then place session-bound context before the first session/create. */
  async reserveRuntimeSession(project) {
    await this.start(project);
    return { id: randomId("session_"), kernel: RUNTIME_KERNEL_NAME };
  }

  /**
   * Last call before a deliberate stop takes the container away.
   *
   * `notifyRuntimeStop` is the wrong moment for anything that has to *read* the
   * runtime: by then this manager has already dropped the runtime from its map
   * and closed the container, so `sessionTranscript` refuses. That ordering is
   * correct — the finish pipeline it drives makes model calls, and holding a
   * container open for those would be worse — but it left the run transcripts
   * of every stopped run unreadable.
   *
   * So this fires one step earlier: the runtime is still in the map and the
   * container is still answering. Only deliberate stops call it. A crashed or
   * exited container is genuinely unreadable and says so.
   *
   * The hook is awaited, so it owes the caller its own bound; a stop must not
   * wait on it indefinitely. Failure is isolated: a stop that cannot pre-read
   * still has to stop.
   * @param {Record<string, any>} project
   * @returns {Promise<void>}
   */
  async notifyRuntimeStopping(project) {
    try {
      await this.onRuntimeStopping(project);
    } catch {
      /* isolated: evimed_runtime_stopping_notify_failures_total */
    }
  }

  notifyRuntimeStop(project, runtime, status) {
    if (!runtime.stopNotification) {
      runtime.stopNotification = Promise.resolve()
        .then(() => this.onRuntimeStop(project, status))
        .catch(() => {});
    }
    return runtime.stopNotification;
  }

  statsAll() {
    const proxy = {
      active: this.activeProxyCount(),
      limits: {
        maxGlobal: positiveLimit(this.config.maxRuntimeProxyConnections),
        maxPerProject: positiveLimit(this.config.maxRuntimeProxyConnectionsPerProject),
      },
    };
    return {
      running: this.runtimes.size,
      starting: this.starts.size,
      proxy,
      quota: {
        monitored: this.runtimeQuotaMonitors.size,
        intervalMs: positiveLimit(this.config.runtimeQuotaCheckIntervalMs),
      },
      limits: {
        maxGlobal: positiveLimit(this.config.maxRunningRuntimes),
        maxPerUser: positiveLimit(this.config.maxRunningRuntimesPerUser),
      },
    };
  }

  /**
   * @param {Record<string, any>} project
   * @param {{ starting?: boolean }} [options] `starting`: this project's own
   *   start is already registered in `starts` and is not one of the others
   */
  enforceRuntimeCapacity(project, { starting = false } = {}) {
    const own = starting && this.starts.has(this.key(project)) ? 1 : 0;
    const maxGlobal = positiveLimit(this.config.maxRunningRuntimes);
    if (maxGlobal != null && this.runtimeCount() - own >= maxGlobal) {
      throw new HttpError(429, "runtime_limit_exceeded", `Too many running runtimes for the server; limit is ${maxGlobal}.`, {
        retryAfterSeconds: 5,
      });
    }
    const maxPerUser = positiveLimit(this.config.maxRunningRuntimesPerUser);
    // Background work holds at most its share of the deployment, so a
    // researcher opening a project always finds room (`backgroundRuntimeLimit`).
    const maxBackground = isInternalProject(project.id) ? backgroundRuntimeLimit(maxGlobal, maxPerUser) : null;
    if (maxBackground != null && this.backgroundRuntimeCount() - own >= maxBackground) {
      throw new HttpError(429, "runtime_limit_exceeded", `Background work is holding its share of runtimes (${maxBackground}); it waits so researchers keep theirs.`, {
        retryAfterSeconds: 60,
      });
    }
    // A background project is never one of the researcher's slots
    // (`runtimeCountForUser`), so it is not held to their ceiling either.
    if (maxPerUser != null && !isInternalProject(project.id) && this.runtimeCountForUser(project.userId) - own >= maxPerUser) {
      throw new HttpError(429, "runtime_limit_exceeded", `Too many running runtimes for this user; limit is ${maxPerUser}.`, {
        retryAfterSeconds: 5,
      });
    }
  }

  /**
   * Room for this project's runtime, made from idle runtimes nothing needs.
   *
   * A project is a container, so a researcher who moves between three
   * projects meets the per-user ceiling on the third and used to be refused
   * with 「已达本部署上限」 — while the first project's runtime sat idle behind
   * a tab they had already left. DSH's own client moves between workspaces
   * freely because one kernel serves them all; the equivalent here is to
   * retire the least recently used runtime of the same user that nothing
   * needs: no open connection (a tab still showing it), no session mid-turn
   * (the kernel is asked, as the idle sweep does), no bounded run holding it.
   *
   * Since runtimes stay warm for hours (`runtimeIdleTimeoutMs`, 2026-09-22),
   * a deployment at its global ceiling is also asked of other researchers'
   * runtimes, but only those idle past `runtimeIdleYieldAfterMs` — the
   * thirty minutes the idle reaper used to wait anyway — least recently used
   * first. A warm runtime is a convenience to its owner, never a reason
   * another researcher cannot start. When nothing qualifies the ceiling
   * refuses exactly as before.
   *
   * An `opening` — the researcher opening a conversation in this project —
   * may also take their own idle runtime that a tab still holds open; see
   * the second pass below. A `speculative` start takes free room only and
   * retires nothing (see `start`).
   * @param {Record<string, any>} project
   * @param {{ opening?: boolean, speculative?: boolean }} [options]
   */
  async makeRoomFor(project, { opening = false, speculative = false } = {}) {
    // Background work waits for room; it never takes a researcher's idle
    // runtime to make some. The capacity check refuses it and its job defers.
    if (isInternalProject(project.id)) return;
    const maxGlobal = positiveLimit(this.config.maxRunningRuntimes);
    const maxPerUser = positiveLimit(this.config.maxRunningRuntimesPerUser);
    const own = this.key(project);
    // This project's own pending start is not one of the others.
    const self = () => (this.starts.has(own) ? 1 : 0);
    const globalFull = () => maxGlobal != null && this.runtimeCount() - self() >= maxGlobal;
    const userFull = () => maxPerUser != null && this.runtimeCountForUser(project.userId) - self() >= maxPerUser;
    const full = () => globalFull() || userFull();
    if (!full() || speculative) return;
    const prefix = `${project.userId}:`;
    const lastUse = (/** @type {string} */ key) => Number(this.runtimeActivity.get(key)?.lastUseAt ?? 0);
    // Unset, the thirty minutes `loadConfig` defaults to: a manager built from
    // a partial config must not read "no age" as "any age".
    const configuredYield = Number(this.config.runtimeIdleYieldAfterMs);
    const yieldAfterMs = this.config.runtimeIdleYieldAfterMs != null && Number.isFinite(configuredYield)
      ? Math.max(0, configuredYield) : 30 * 60_000;
    /** @param {[string, any]} entry */
    const eligible = ([key, runtime]) => key !== own && Boolean(runtime.project) && !runtime.modelGatewayScope
      && !isInternalProject(key.slice(key.indexOf(":") + 1));
    /** @param {[string, any]} left @param {[string, any]} right */
    const byAge = ([a], [b]) => lastUse(a) - lastUse(b);
    const mine = [...this.runtimes.entries()].filter((entry) => eligible(entry) && entry[0].startsWith(prefix)).sort(byAge);
    // Idle since its last recorded use, else since it started; a runtime this
    // manager knows neither of is not known to be idle, and keeps its slot.
    /** @param {[string, any]} entry */
    const idleSince = ([key, runtime]) => {
      const used = Number(this.runtimeActivity.get(key)?.lastUseAt ?? 0);
      if (used > 0) return used;
      const started = Date.parse(String(runtime?.startedAt ?? ""));
      return Number.isFinite(started) ? started : Date.now();
    };
    const others = [...this.runtimes.entries()]
      .filter((entry) => eligible(entry) && !entry[0].startsWith(prefix) && Date.now() - idleSince(entry) >= yieldAfterMs)
      .sort((left, right) => idleSince(left) - idleSince(right));
    /** Whether a tab holds this runtime: a connection proxied to it right now. */
    const connected = (/** @type {string} */ key) => (this.runtimeActivity.get(key)?.activeProxies ?? 0) > 0;
    /**
     * Stop one runtime if nothing needs it: no session mid-turn, no run the
     * ledger still holds, and — unless `evenIfConnected` — no open connection.
     * @param {[string, any]} entry @param {boolean} evenIfConnected
     */
    const yieldIfIdle = async ([key, runtime], evenIfConnected) => {
      if (this.runtimes.get(key) !== runtime || (!evenIfConnected && connected(key))) return;
      let busy;
      try {
        busy = await this.runtimeBusy(runtime.project);
      } catch {
        // Unknown is not idle — the idle sweep's rule.
        return;
      }
      if (busy || this.runtimes.get(key) !== runtime || (!evenIfConnected && connected(key))) return;
      // The ledger's view too: a run it still calls running is closed as
      // cancelled by the stop, whatever the kernel says (see `hasRunningRuns`).
      if (await this.hasRunningRuns(runtime.project).catch(() => true)) return;
      await this.stopIdleRuntime(runtime.project, { event: "yielded", evenIfConnected }).catch(() => {});
    };
    for (const entry of mine) {
      await yieldIfIdle(entry, false);
      if (!full()) return;
    }
    // Another researcher's runtime makes room only for the global ceiling;
    // the per-user one is this researcher's own to spend — so an opening held
    // by its own ceiling goes straight to its own runtimes below.
    if (!(opening && userFull())) {
      for (const entry of others) {
        if (!globalFull()) break;
        await yieldIfIdle(entry, false);
        if (!full()) return;
      }
    }
    if (!opening) return;
    // Last, for an opening only: the researcher's own idle runtime that a tab
    // still holds. The shell keeps the last project's conversation connected
    // but hidden, and refusing on that connection made a project switch a 429
    // and a retry seven seconds later (2026-09-23 UI plan §2.2). Idle still
    // means idle — a turn under way or a run the ledger holds keeps its
    // runtime — and another researcher's is never taken this way. Not for
    // other starts: a frame reconnecting to a runtime that just yielded must
    // not take one back, or two open tabs would retire each other in turn.
    for (const entry of mine) {
      if (!connected(entry[0])) continue;
      await yieldIfIdle(entry, true);
      if (!full()) return;
    }
  }

  runtimeCount() {
    return this.runtimes.size + this.starts.size;
  }

  /** Running and starting runtimes of the platform's own background projects. */
  backgroundRuntimeCount() {
    const background = (/** @type {string} */ key) => isInternalProject(key.slice(key.indexOf(":") + 1));
    return [...this.runtimes.keys(), ...this.starts.keys()].filter(background).length;
  }

  runtimeCountForUser(userId) {
    const prefix = `${userId}:`;
    // The platform's own background projects (`internalProjects.mjs`) do not
    // take one of the researcher's slots: a lesson being distilled must never
    // be why they cannot open a second project. The global ceiling still
    // counts them.
    const counted = (/** @type {string} */ key) => key.startsWith(prefix) && !isInternalProject(key.slice(prefix.length));
    let count = 0;
    for (const key of this.runtimes.keys()) {
      if (counted(key)) count++;
    }
    for (const key of this.starts.keys()) {
      if (counted(key)) count++;
    }
    return count;
  }

  async pluginRuntimeBusy(project) {
    if (this.starts.has(this.key(project)) || this.boundedRuntimeScope(project)) return true;
    const runtime = this.runtimes.get(this.key(project));
    if (!runtime) return false;
    const value = await this.callKernel(runtime, project, "evimedPlugins/status", {}, AbortSignal.timeout(10000));
    if (typeof value?.busy !== "boolean") throw new HttpError(502, "plugin_probe_invalid", "Kernel activity proof is unavailable.");
    return value.busy;
  }

  runtimePluginConfig(project) { return this.runtimes.get(this.key(project))?.pluginConfig ?? null; }

  async replacePluginRuntime(project, pluginConfig) {
    const key = this.key(project);
    this.pluginOverrides.set(key, pluginConfig);
    try {
      await this.stop(project);
      return await this.startAdmitted(project);
    } finally { this.pluginOverrides.delete(key); }
  }

  /** The live proof that the plugin the apply path named is the plugin the
   *  container is running, at the configuration it was told to run.
   *
   *  The binary version, the tool names and the settings compared all come
   *  from the registry entry -- `plugin-support.json` is the record the runtime
   *  image's install line is asserted equal to, so a version bump is one edit
   *  there and not two. A released web image has no record to read, and its
   *  fallback is `PLUGIN_SUPPORT_SNAPSHOT`, which states the same fields.
   *
   *  What this deliberately cannot do is certify a plugin whose configuration
   *  the kernel's proof does not restate. `evimedPlugins/verify` is
   *  parameterless and answers in one fixed shape, so `provenPluginSettings`
   *  covers plugins declaring exactly the settings that shape carries -- today
   *  `timeoutMs`, which is dsh-cite -- and refuses a verdict for any other
   *  rather than certifying another bundle's registration under its name.
   *  Both that refusal and an unregistered id are answered before the kernel is
   *  asked. The plugin id defaults to dsh-cite, which is what every existing
   *  caller passes by passing nothing.
   *  @param {any} project @param {any} expected @param {string} pluginId */
  async probePlugin(project, expected, pluginId = PLUGIN_ID) {
    const runtime = this.runtimes.get(this.key(project));
    const generation = this.runtimeGeneration(project);
    if (!runtime || !generation) throw new HttpError(409, "plugin_runtime_unavailable", "The runtime is unavailable.");
    const entry = this.pluginService ? this.pluginService.entry(pluginId) : pluginEntry(pluginId);
    const tools = expectedPluginTools(entry);
    const settings = provenPluginSettings(entry);
    const proof = await this.callKernel(runtime, project, "evimedPlugins/verify", {}, AbortSignal.timeout(45000));
    if (this.runtimeGeneration(project) !== generation || proof?.binaryVersion !== entry.version
      || proof.revision !== expected.revision || proof.enabled !== expected.enabled
      || settings.some((name) => proof[name] !== expected.settings[name])
      || !Array.isArray(proof.tools) || JSON.stringify([...proof.tools].sort()) !== JSON.stringify(expected.enabled ? tools.sort() : [])) {
      throw new HttpError(502, "plugin_probe_invalid", "The runtime did not prove the expected plugin configuration.");
    }
    return { generation };
  }

  async restart(project) {
    await this.stop(project);
    return this.start(project);
  }

  async stop(project) {
    const key = this.key(project);
    const pending = this.starts.get(key);
    if (pending) {
      pending
        .then((runtime) => {
          if (this.runtimes.get(key) === runtime) {
            void this.stop(project).catch(() => {});
          }
        })
        .catch(() => {});
    }
    const runtime = this.runtimes.get(key);
    if (!runtime) {
      await this.runtimeQuotaStops.get(key);
      await this.pluginService?.clearPromptAdmissions(project);
      return;
    }
    // Before the delete: `sessionTranscript` resolves the runtime through this
    // map, so a reader one line further down already has nothing to read.
    await this.notifyRuntimeStopping(project);
    this.runtimes.delete(key);
    this.deactivateModelGatewayRuntime(runtime);
    this.clearIdleTimer(key);
    this.clearQuotaMonitor(key);
    this.clearEviMedWorkloadRefresh(key);
    this.runtimeActivity.delete(key);
    runtime.closedByManager = true;
    try {
      await runtime.close();
      await this.pluginService?.clearPromptAdmissions(project);
    } finally {
      await this.notifyRuntimeStop(project, runtime, "canceled");
    }
    await appendRuntimeEvent(project, "stopped", {
      kind: runtime.kind,
      sandboxMode: runtime.sandboxMode ?? "mock",
      pid: runtime.pid,
      containerName: runtime.containerName ?? null,
    }, this.config);
    await recordRuntimeState(project, "stopped", {
      running: false,
      kind: runtime.kind,
      startedAt: runtime.startedAt,
      pid: runtime.pid,
      exitedAt: runtime.exitedAt,
      sandboxMode: runtime.sandboxMode ?? "mock",
      networkMode: runtime.networkMode ?? null,
      containerName: runtime.containerName ?? null,
    });
  }

  async closeAll() {
    for (const key of this.runtimeActivity.keys()) this.clearIdleTimer(key);
    this.runtimeActivity.clear();
    for (const key of this.runtimeQuotaMonitors.keys()) this.clearQuotaMonitor(key);
    for (const key of this.evimedWorkloadRefreshTimers.keys()) this.clearEviMedWorkloadRefresh(key);
    const pending = [...this.starts.values()];
    this.starts.clear();
    await Promise.allSettled(pending);
    for (const key of this.runtimeActivity.keys()) this.clearIdleTimer(key);
    this.runtimeActivity.clear();
    for (const key of this.runtimeQuotaMonitors.keys()) this.clearQuotaMonitor(key);
    for (const key of this.evimedWorkloadRefreshTimers.keys()) this.clearEviMedWorkloadRefresh(key);
    const runtimes = [...this.runtimes.values()];
    await Promise.allSettled(runtimes.map((runtime) => this.notifyRuntimeStopping(runtime.project)));
    this.runtimes.clear();
    for (const runtime of runtimes) {
      runtime.closedByManager = true;
      this.deactivateModelGatewayRuntime(runtime);
    }
    this.activeModelGatewayTokens.clear();
    const quotaStops = [...this.runtimeQuotaStops.values()];
    await Promise.allSettled([
      ...runtimes.map((runtime) => this.notifyRuntimeStop(runtime.project, runtime, "canceled")),
      ...runtimes.map((runtime) => runtime.close()),
      ...quotaStops,
    ]);
    this.runtimeQuotaStops.clear();
  }

  async cleanupOrphanedRuntimes(projects) {
    const summary = {
      scanned: 0,
      skipped: 0,
      cleaned: 0,
      missing: 0,
      failed: 0,
    };
    if (this.config.runtimeMode !== "kernel") {
      summary.skipped = Array.isArray(projects) ? projects.length : 0;
      this.lastOrphanCleanup = { ...summary, completedAt: new Date().toISOString() };
      return summary;
    }

    for (const project of projects) {
      const state = await readRuntimeState(project);
      if (!runtimeStateWasAttached(state)) {
        summary.skipped += 1;
        continue;
      }
      summary.scanned += 1;
      if (state.sandboxMode === this.provider.name) {
        const cleanup = await this.provider.cleanupOrphan(project, state);
        if (cleanup.reattached) {
          // A cloud session outlives the control plane that started it; the
          // provider took it back rather than removing it (plan §3.1 #7).
          summary.reattached = (summary.reattached ?? 0) + 1;
          continue;
        }
        if (cleanup.skipped) {
          summary.skipped += 1;
          continue;
        }
        if (cleanup.cleaned || cleanup.missing) {
          if (cleanup.cleaned) summary.cleaned += 1;
          else summary.missing += 1;
          await appendRuntimeEvent(project, "startup_orphan_cleanup", {
            kind: state.kind ?? RUNTIME_KERNEL_NAME,
            sandboxMode: state.sandboxMode,
            networkMode: state.networkMode ?? this.config.runtimeNetworkMode,
            containerName: state.containerName,
            result: cleanup.reason,
          }, this.config);
          await recordRuntimeState(project, "orphan_cleanup", {
            running: false,
            kind: state.kind ?? RUNTIME_KERNEL_NAME,
            startedAt: state.startedAt ?? null,
            pid: Number.isSafeInteger(state.pid) ? state.pid : null,
            exitedAt: new Date().toISOString(),
            sandboxMode: state.sandboxMode,
            networkMode: state.networkMode ?? this.config.runtimeNetworkMode,
            containerName: state.containerName,
            skillsCopied: state.skillsCopied,
          });
          continue;
        }
        summary.failed += 1;
        await appendRuntimeEvent(project, "startup_orphan_cleanup_failed", {
          kind: state.kind ?? RUNTIME_KERNEL_NAME,
          sandboxMode: state.sandboxMode,
          networkMode: state.networkMode ?? this.config.runtimeNetworkMode,
          containerName: state.containerName,
          error: cleanup.error,
        }, this.config);
        await recordRuntimeState(project, "failed", {
          running: false,
          kind: state.kind ?? RUNTIME_KERNEL_NAME,
          startedAt: state.startedAt ?? null,
          pid: Number.isSafeInteger(state.pid) ? state.pid : null,
          exitedAt: new Date().toISOString(),
          sandboxMode: state.sandboxMode,
          networkMode: state.networkMode ?? this.config.runtimeNetworkMode,
          containerName: state.containerName,
          skillsCopied: state.skillsCopied,
          error: "runtime_cleanup_failed",
        });
        continue;
      }

      summary.skipped += 1;
    }

    this.lastOrphanCleanup = { ...summary, completedAt: new Date().toISOString() };
    return summary;
  }

  /**
   * Creates a kernel session for this project and returns its id.
   *
   * The browser asks the control plane for a session; it never asks a kernel.
   * That is what lets the kernel change without the frontend changing, and what
   * keeps the kernel's own settings and credentials methods — pinned to
   * loopback for exactly this reason — out of reach of a remote caller.
   *
   * @param {Record<string, any>} project
   * @returns {Promise<{ id: string, kernel: string }>}
   */
  async createRuntimeSession(project) {
    this.assertInteractiveRuntimeAvailable(project);
    const runtime = await this.start(project);
    if (runtime.modelGatewayScope) this.assertInteractiveRuntimeAvailable(project);
    this.beginProxy(project);
    try {
      const value = await this.withRuntimeDeadline(
        (signal) => this.callKernel(runtime, project, "session/create", {
          request: {
            cwd: runtime.proxyWorkspaceDir ?? project.workspaceDir,
            agentPreset: EVIMED_AGENT_PRESET,
          },
        }, signal),
        "runtime_session_create_failed",
        "The runtime did not create a session in time.",
      );
      return { id: String(value?.sessionId ?? ""), kernel: RUNTIME_KERNEL_NAME };
    } finally {
      this.endProxy(project);
    }
  }

  /**
   * One file of the kernel's published browser application, for any frame of
   * this user's, whichever project it shows (`SHARED_UI_ASSET_PREFIX`).
   *
   * A file whose URL names its content (`isImmutableRuntimeUiAsset`) is kept in
   * memory after its first fetch, with its gzip form, so the next frame — any
   * project, any account — is answered without a runtime round trip and in a
   * quarter of the bytes. Anything else is fetched each time and never kept.
   * A miss is fetched from one of THIS user's running runtimes, never another
   * tenant's container: the files are the same, the boundary is not ours to
   * blur. The frame that asks has just been served by one of them, so there
   * is one; when there is not, the frame's own retry starts it.
   *
   * Not every one of them can answer, though. A kernel serves only the plugin
   * bundles it composed itself, and two runtimes of one account need not have
   * composed the same one; a URL another kernel built is a 404 here. The
   * request says nothing of which frame asked, and on 2026-09-21 asking only
   * the most recently used runtime meant asking an evaluation cell's, busy
   * every few seconds: every conversation of the account then stopped at
   * 「对话界面 60 秒内没有载入完成」 on a 404 for its own plugin bundle. So
   * each runtime is asked in turn — conversations first, background work
   * last, most recently used first within each — until one has the file.
   *
   * @param {string} userId
   * @param {string} suffix `/assets/<file>` or `/plugins/??<list>&rev=<rev>`, validated by the caller
   * @returns {Promise<{ status: number, contentType: string, body: Buffer, gzip: Buffer | null, immutable: boolean }>}
   */
  async sharedUiAsset(userId, suffix) {
    const immutable = isImmutableRuntimeUiAsset(suffix);
    const cached = immutable ? this.sharedUiAssets.get(suffix) : null;
    if (cached) {
      // Most recently used moves to the end; eviction takes from the front.
      this.sharedUiAssets.delete(suffix);
      this.sharedUiAssets.set(suffix, cached);
      return cached;
    }
    const prefix = `${userId}:`;
    const candidates = [...this.runtimes]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, runtime]) => ({
        runtime,
        background: isInternalProject(key.slice(prefix.length)),
        lastUseAt: Number(this.runtimeActivity.get(key)?.lastUseAt ?? 0),
      }))
      .sort((left, right) => Number(left.background) - Number(right.background) || right.lastUseAt - left.lastUseAt);
    if (candidates.length === 0) throw new HttpError(503, "runtime_not_running", "No research runtime of this account is running.");
    const timeoutMs = positiveLimit(this.config.runtimeProxyRequestTimeoutMs) ?? 60_000;
    /** @type {{ status: number, contentType: string, body: Buffer, gzip: Buffer | null, immutable: boolean } | null} */
    let asset = null;
    for (const { runtime } of candidates) {
      const response = await requestRuntime(runtime, new URL(`${runtime.url}${suffix}`), {
        method: "GET",
        headers: { ...(runtime.cookie ? { cookie: runtime.cookie } : {}), "accept-encoding": "identity" },
        signal: AbortSignal.timeout(timeoutMs),
      }).catch((error) => {
        // One runtime that cannot be reached is not an answer while another
        // may still have the file; the last one's failure is.
        if (runtime === candidates[candidates.length - 1].runtime) throw error;
        return null;
      });
      if (!response) continue;
      const body = response.body
        ? await readRuntimeResponseBody(response.body, SHARED_UI_ASSET_MAX_BYTES)
        : Buffer.alloc(0);
      asset = {
        status: response.status,
        contentType: response.headers.get("content-type") ?? "application/octet-stream",
        body,
        gzip: null,
        immutable: immutable && response.status === 200,
      };
      if (response.status !== 404) break;
    }
    if (!asset) throw new HttpError(503, "runtime_not_running", "No research runtime of this account answered.");
    const { body, contentType } = asset;
    if (!asset.immutable) return asset;
    // Text compresses to about a quarter; fonts and images are already packed.
    if (body.length > 1024 && /^(?:text\/|application\/(?:javascript|json|wasm)|image\/svg)/i.test(contentType)) {
      asset.gzip = gzipSync(body, { level: 6 });
    }
    this.sharedUiAssets.set(suffix, asset);
    this.sharedUiAssetBytes += body.length + (asset.gzip?.length ?? 0);
    for (const [key, entry] of this.sharedUiAssets) {
      if (this.sharedUiAssetBytes <= SHARED_UI_ASSET_CACHE_BYTES || key === suffix) break;
      this.sharedUiAssets.delete(key);
      this.sharedUiAssetBytes -= entry.body.length + (entry.gzip?.length ?? 0);
    }
    return asset;
  }

  /**
   * One unary call into the DSH kernel over the project's control socket.
   * The allow-list is checked by the adapter that owns it; this is the carrier.
   * @param {Record<string, any>} runtime @param {Record<string, any>} project
   * @param {string} method @param {Record<string, unknown>} payload @param {AbortSignal} signal
   * @param {{ maxBytes?: number }} [options]
   * @returns {Promise<any>}
   */
  async callKernel(runtime, project, method, payload, signal, { maxBytes } = {}) {
    if (!isAllowedWireMethod(method)) {
      throw new HttpError(403, "runtime_method_forbidden", `Kernel method ${method} is not on the allow-list.`);
    }
    const target = new URL(`${runtime.url}/api/${method}`);
    const rpcId = randomId("rpc_");
    // The envelope belongs to the carrier, not to the caller: 0.1.2 requires
    // `payload.args` to be exactly one plain object, and a caller that had to
    // remember to wrap would be one forgetful call site away from
    // `gateway/internal: Remote payload must contain exactly one plain-object
    // args field` — an error that names the wire and not the caller. Callers
    // pass the arguments; this wraps them.
    const body = Buffer.from(JSON.stringify({ type: "client-request", rpcId, method, payload: { args: payload ?? {} } }), "utf8");
    const response = await requestRuntime(runtime, target, {
      method: "POST",
      headers: {
        ...(runtime.cookie ? { cookie: runtime.cookie } : {}),
        "content-type": "application/json",
      },
      body,
      signal,
    });
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel().catch(() => {});
      throw new HttpError(502, "runtime_wire_protocol_mismatch", `Kernel answered HTTP ${response.status} for ${method}.`);
    }
    const payloadBytes = await readRuntimeResponseBody(response.body, maxBytes ?? this.config.maxJsonBytes);
    let envelope;
    try {
      envelope = JSON.parse(payloadBytes.toString("utf8"));
    } catch {
      throw new HttpError(502, "runtime_wire_protocol_mismatch", `Kernel answer for ${method} is not JSON.`);
    }
    const result = envelope?.result;
    if (result?.ok) return result.value;
    const mapped = mapWireError(result?.error ?? {});
    throw new HttpError(502, mapped.code, mapped.message);
  }

  /**
   * @param {any} req @param {any} res @param {Record<string, any>} project
   * @param {string} suffix @param {{ surface?: string, uiBasePath?: string, revalidate?: () => Promise<void> }} [options]
   *
   * `surface: "ui"` forwards the kernel's own browser application instead of
   * the retired route vocabulary. Three things differ and nothing else does:
   * which routes are allowed, whether the OpenCode-era `directory` and
   * `auth_token` query parameters are rewritten, and whether the minted
   * browser-session cookie is attached. Everything the hosted proxy already
   * does -- the project's quota accounting, the connect and request deadlines,
   * response-header sanitising, the audit row -- is the same code, because a
   * second proxy would be a second set of those decisions to keep in step.
   */
  /**
   * @param {any} req @param {any} res @param {Record<string, any>} project @param {string} suffix
   * @param {{ surface?: string, uiBasePath?: string, revalidate?: () => Promise<void>, uiAssetPrefix?: string | null,
   *           immutable?: boolean, rebaseDocument?: boolean, fileBody?: boolean }} [options]
   *   `uiAssetPrefix` is the project's stable path for build assets the document
   *   is rewritten to reference; `immutable` marks a URL that names its content;
   *   `rebaseDocument: false` serves bytes as they are (an asset route);
   *   `fileBody` says the request carries a file, not an RPC: it is held to
   *   `maxFileBytes` instead of the JSON ceiling, and never parsed as JSON.
   */
  async proxy(req, res, project, suffix, { surface = "runtime", uiBasePath = "/api/runtime-ui/", revalidate = undefined, uiAssetPrefix = null, immutable = false, rebaseDocument = true, fileBody = false } = {}) {
    const startedAt = Date.now();
    const method = req.method ?? "GET";
    const target = surface === "ui" ? uiProxyAuditTarget(suffix) : proxyAuditTarget(suffix);
    let status = null;
    let streaming = false;
    let error = null;
    let proxyActive = false;
    let requestBytes = requestContentLength(req) ?? 0;
    let responseBytes = 0;
    const abortedSessionId = abortedRuntimeSession(method, suffix);
    try {
      this.beginProxy(project);
      proxyActive = true;
      if (surface === "ui") this.enforceUiProxyEnabled();
      else this.enforceProxyAllowlist(req, suffix);
      // A file (the composer's attachment route) is held to the file ceiling
      // and passed through as bytes; everything else is JSON.
      await bufferProxyRequestBody(req, method, fileBody ? Number(this.config.maxFileBytes) : this.config.maxJsonBytes);
      requestBytes = Buffer.isBuffer(req.__openScienceProxyBody) ? req.__openScienceProxyBody.length : requestBytes;
      await this.enforcePreStartProxyPolicy(req, suffix, { fileBody });
      const noWake = this.noWakeProxyControlResult(project, method, suffix);
      if (noWake) {
        status = noWake.status;
        if (noWake.error) throw new HttpError(noWake.status, noWake.error, noWake.message);
        if (abortedSessionId) await this.onSessionAbort(project, abortedSessionId);
        const payload = JSON.stringify(noWake.body);
        responseBytes = Buffer.byteLength(payload);
        sendJson(res, noWake.status, noWake.body);
        return;
      }
      const runtime = await this.start(project);
      if (revalidate) await revalidate();
      await this.enforceRuntimeProxyPolicy(req, suffix, runtime);
      const incoming = new URL(req.url ?? "/", "http://open-science.local");
      const upstream = new URL(`${runtime.url}${suffix}`);
      // UI suffix is the complete raw path and query, including native combo-bundle syntax.
      if (surface !== "ui") for (const [key, value] of incoming.searchParams) {
        if (key !== "directory" && key !== "auth_token") upstream.searchParams.append(key, value);
      }
      if (surface !== "ui") {
        upstream.searchParams.set("directory", runtime.proxyWorkspaceDir ?? project.workspaceDir);
      }

      const headers = {};
      for (const [key, value] of Object.entries(req.headers)) {
        const lower = key.toLowerCase();
        if (isHopByHopHeader(lower)) continue;
        if (Array.isArray(value)) headers[key] = value.join(", ");
        else if (value != null) headers[key] = value;
      }
      headers["accept-encoding"] = "identity";
      // The browser's own cookies are stripped as hop-by-hop; the kernel's
      // application needs the browser-session cookie this control plane minted
      // for it, and the runtime record is where that cookie lives. Without it
      // every request is answered "dsh web authentication required", which
      // reads as the UI being broken rather than unauthenticated.
      if (surface === "ui" && runtime.cookie) headers.cookie = runtime.cookie;

      const body = req.__openScienceProxyBody ?? (["GET", "HEAD"].includes(method) ? undefined : req);
      const controller = new AbortController();
      let connectTimedOut = false;
      let responseEnded = false;
      let responseClosed = false;
      let upstreamReader = null;
      const connectTimer = setTimeout(() => {
        connectTimedOut = true;
        controller.abort();
      }, this.config.runtimeProxyConnectTimeoutMs);
      req.on("aborted", () => controller.abort());
      res.on("close", () => {
        if (!responseEnded) controller.abort();
        responseClosed = true;
        void upstreamReader?.cancel().catch(() => {});
      });
      let upstreamRes;
      try {
        upstreamRes = await requestRuntime(runtime, upstream, {
          method,
          headers,
          body,
          signal: controller.signal,
        });
        clearTimeout(connectTimer);
      } catch (err) {
        clearTimeout(connectTimer);
        if (connectTimedOut) {
          throw new HttpError(504, "runtime_proxy_timeout", "Runtime did not respond before the proxy timeout.");
        }
        throw new HttpError(502, "runtime_unavailable", err instanceof Error ? err.message : "runtime unavailable");
      }

      if (revalidate) await revalidate();
      status = upstreamRes.status;
      if (abortedSessionId && upstreamRes.status >= 200 && upstreamRes.status < 300) {
        await this.onSessionAbort(project, abortedSessionId);
      }
      streaming = (upstreamRes.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream");
      const responseHeaders = sanitizedRuntimeResponseHeaders(upstreamRes, runtime, project, {
        surface,
        frameAncestors: frameAncestorsFor(this.config),
        uiBasePath,
        immutable,
      });
      if (!upstreamRes.body) {
        res.writeHead(upstreamRes.status, responseHeaders);
        responseEnded = true;
        res.end();
        return;
      }
      if (!streaming) {
        let requestTimedOut = false;
        const timeoutMs = positiveLimit(this.config.runtimeProxyRequestTimeoutMs);
        const requestTimer = timeoutMs == null
          ? null
          : setTimeout(() => {
              requestTimedOut = true;
              controller.abort();
              void upstreamReader?.cancel().catch(() => {});
            }, timeoutMs);
        try {
          const payload = await readRuntimeResponseBody(upstreamRes.body, this.config.maxJsonBytes, (reader) => {
            upstreamReader = reader;
          }, (bytes) => {
            responseBytes += bytes;
          });
          if (!responseClosed && !res.destroyed && !res.writableEnded) {
            const served = surface === "ui" && rebaseDocument
              ? rebaseRuntimeUiDocument(payload, responseHeaders, uiBasePath, uiAssetPrefix)
              : payload;
            if (served !== payload) responseHeaders["content-length"] = String(served.length);
            res.writeHead(upstreamRes.status, responseHeaders);
            responseEnded = true;
            res.end(method === "HEAD" ? undefined : served);
          }
        } catch (err) {
          if (requestTimedOut) {
            throw new HttpError(504, "runtime_proxy_timeout", "Runtime proxy request exceeded timeout.");
          }
          throw err;
        } finally {
          if (requestTimer) clearTimeout(requestTimer);
          upstreamReader = null;
        }
        return;
      }
      res.writeHead(upstreamRes.status, responseHeaders);
      const reader = upstreamRes.body.getReader();
      upstreamReader = reader;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (responseClosed || res.destroyed || res.writableEnded) break;
          responseBytes += value.byteLength;
          if (!res.write(Buffer.from(value))) {
            await new Promise((resolve) => {
              if (responseClosed || res.destroyed || res.writableEnded) {
                resolve();
                return;
              }
              const finish = () => {
                res.off("close", finish);
                res.off("drain", finish);
                resolve();
              };
              res.once("close", finish);
              res.once("drain", finish);
            });
          }
        }
        if (!responseClosed && !res.destroyed && !res.writableEnded) {
          responseEnded = true;
          res.end();
        }
      } catch (err) {
        if (!responseClosed) throw err;
      } finally {
        upstreamReader = null;
        reader.releaseLock();
      }
    } catch (err) {
      if (err instanceof HttpError) {
        status = err.status;
        error = err.code;
      } else {
        status = status ?? 502;
        error = "runtime_proxy_error";
      }
      throw err;
    } finally {
      if (proxyActive) this.endProxy(project);
      // A request that could have written to the workspace — an upload, a
      // mutation — is followed by one measurement, in the background and never
      // two at once. It used to run after EVERY response and before it was
      // sent, reads included: each asset and list call of the session page
      // waited for a walk of the whole project (see `startAdmitted`).
      if (error !== "project_quota_exceeded" && !["GET", "HEAD", "OPTIONS"].includes(String(method).toUpperCase())) {
        this.checkQuotaInBackground(project);
      }
      await appendRuntimeEvent(project, "proxy", {
        method,
        target,
        status,
        durationMs: Date.now() - startedAt,
        requestBytes,
        responseBytes,
        streaming,
        error,
      }, this.config).catch(() => {});
    }
  }

  activityFor(key) {
    const existing = this.runtimeActivity.get(key);
    if (existing) return existing;
    const activity = { activeProxies: 0, idleTimer: null, lastUseAt: Date.now() };
    this.runtimeActivity.set(key, activity);
    return activity;
  }

  /**
   * That someone actually used this runtime, just now.
   *
   * Separate from `activeProxies`, which counts open connections. The session
   * surface holds one multiplexed WebSocket for as long as its tab is open, so
   * `activeProxies` never reaches zero while a browser is parked on the page
   * and the idle timer below is therefore never even scheduled: on 2026-09-15
   * the only runtime this deployment can run sat `Up` for four hours after its
   * last model call, holding the single slot, and nothing reclaimed it (walk,
   * B1'). An open connection is not use; a request through it is.
   *
   * @param {Record<string, any>} project
   */
  noteRuntimeUse(project) {
    this.activityFor(this.key(project)).lastUseAt = Date.now();
  }

  /**
   * Stop runtimes whose last use is older than the idle timeout, even when a
   * connection is still open.
   *
   * Guarded twice over: a runtime with work in flight is skipped (the kernel is
   * asked, this does not infer it), and a runtime whose last use is inside the
   * window is left alone. Called on a timer; safe to call at any time, and a
   * no-op when no idle timeout is configured.
   *
   * @returns {Promise<number>} how many were stopped
   */
  async sweepIdleRuntimes() {
    const timeoutMs = Number(this.config.runtimeIdleTimeoutMs);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return 0;
    let stopped = 0;
    for (const [key, runtime] of [...this.runtimes.entries()]) {
      const activity = this.runtimeActivity.get(key);
      if (!activity) continue;
      if (Date.now() - Number(activity.lastUseAt ?? 0) < timeoutMs) continue;
      const project = runtime.project;
      if (!project) continue;
      const verdict = await this.idleVerdict(project);
      // Unreadable means unknown, and unknown is not idle. A runtime whose
      // kernel cannot be asked stays up; the next sweep asks again.
      if (verdict === "unknown") continue;
      if (verdict === "working") {
        activity.lastUseAt = Date.now();
        continue;
      }
      await this.stopIdleRuntime(project).catch(() => {});
      stopped++;
    }
    return stopped;
  }

  /**
   * Whether this runtime is idle by both accounts that can tell: the kernel's
   * (no session mid-turn) and the run ledger's (no run it still calls
   * `running`).
   *
   * The ledger's half is the rule `makeRoomFor` already applied, and the idle
   * reaper did not (plan §3.1 #8, spec G16): a nightly proactive-research run
   * sits between two turns — the monitor finishing one delivery, the repair
   * the next — with its kernel idle, and a stop in that window closes the run
   * as cancelled at 03:00 with nobody watching. The ledger is asked second
   * because it is the more expensive read.
   *
   * @param {Record<string, any>} project
   * @returns {Promise<'idle'|'working'|'unknown'>}
   */
  async idleVerdict(project) {
    try {
      if (await this.runtimeBusy(project)) return "working";
    } catch {
      return "unknown";
    }
    try {
      return (await this.hasRunningRuns(project)) ? "working" : "idle";
    } catch {
      return "unknown";
    }
  }

  /**
   * Whether any session in this runtime is mid-turn.
   * @param {Record<string, any>} project @returns {Promise<boolean>}
   */
  async runtimeBusy(project) {
    const runtime = this.runtimes.get(this.key(project));
    if (!runtime) return false;
    const value = await this.withRuntimeDeadline(
      (signal) => this.callKernel(runtime, project, "session/list", { _request: {} }, signal),
      "runtime_status_unavailable",
      "Runtime session status did not answer in time.",
    );
    return sessionListItems(value).some((item) => item?.running);
  }

  clearIdleTimer(key) {
    const activity = this.runtimeActivity.get(key);
    if (activity?.idleTimer) {
      clearTimeout(activity.idleTimer);
      activity.idleTimer = null;
    }
  }

  clearQuotaMonitor(key) {
    const monitor = this.runtimeQuotaMonitors.get(key);
    if (monitor?.timer) clearTimeout(monitor.timer);
    this.runtimeQuotaMonitors.delete(key);
  }

  clearEviMedWorkloadRefresh(key) {
    const monitor = this.evimedWorkloadRefreshTimers.get(key);
    if (monitor?.timer) this.clearWorkloadTimer(monitor.timer);
    this.evimedWorkloadRefreshTimers.delete(key);
  }

  scheduleEviMedWorkloadRefresh(project, runtime) {
    const key = this.key(project);
    this.clearEviMedWorkloadRefresh(key);
    if (!runtime?.workloadTokenFile || !this.config.evimedWorkloadSigningSecret) return;
    const intervalMs = runtime.workloadTokenRefreshMs ?? evimedWorkloadRefreshIntervalMs(this.config);
    const monitor = { timer: null, intervalMs };
    const schedule = () => {
      if (
        this.evimedWorkloadRefreshTimers.get(key) !== monitor ||
        this.runtimes.get(key) !== runtime
      ) return;
      monitor.timer = this.setWorkloadTimer(() => {
        monitor.timer = null;
        void this.refreshEviMedRuntimeToken(project, monitor).then((refreshed) => {
          if (refreshed) schedule();
        });
      }, intervalMs);
      monitor.timer?.unref?.();
    };
    this.evimedWorkloadRefreshTimers.set(key, monitor);
    schedule();
  }

  async refreshEviMedRuntimeToken(project, monitor) {
    const key = this.key(project);
    const runtime = this.runtimes.get(key);
    if (
      !runtime ||
      !runtime.workloadTokenFile ||
      this.evimedWorkloadRefreshTimers.get(key) !== monitor
    ) return false;
    try {
      await this.provider.writeWorkloadToken(project, runtime);
      await appendRuntimeEvent(project, "workload_token_refreshed", {
        kind: runtime.kind,
        sandboxMode: runtime.sandboxMode,
      }, this.config);
      return true;
    } catch (error) {
      // A remote runtime's renewal goes through the session's file API, which
      // can fail for a moment; its token outlives two renewals (900 s against
      // 300 s), so a failure that the next attempt can still cover is waited
      // out rather than ending the run.
      if (this.provider.tolerateTokenRefreshFailure?.(runtime)) {
        await appendRuntimeEvent(project, "workload_token_refresh_failed", {
          kind: runtime.kind,
          sandboxMode: runtime.sandboxMode,
          error: typeof error?.code === "string" ? error.code : "runtime_workload_token_refresh_failed",
          stopping: false,
        }, this.config);
        return true;
      }
      await this.notifyRuntimeStopping(project);
      this.runtimes.delete(key);
      this.clearIdleTimer(key);
      this.clearQuotaMonitor(key);
      this.clearEviMedWorkloadRefresh(key);
      this.runtimeActivity.delete(key);
      runtime.closedByManager = true;
      await runtime.close().catch(() => {});
      await this.notifyRuntimeStop(project, runtime, "failed");
      await appendRuntimeEvent(project, "workload_token_refresh_failed", {
        kind: runtime.kind,
        sandboxMode: runtime.sandboxMode,
        error: "runtime_workload_token_refresh_failed",
      }, this.config);
      await recordRuntimeState(project, "failed", {
        running: false,
        kind: runtime.kind,
        startedAt: runtime.startedAt,
        pid: runtime.pid,
        exitedAt: runtime.exitedAt,
        sandboxMode: runtime.sandboxMode,
        networkMode: runtime.networkMode,
        containerName: runtime.containerName,
        error: "runtime_workload_token_refresh_failed",
      });
      return false;
    }
  }

  scheduleQuotaMonitor(project) {
    const intervalMs = Number(this.config.runtimeQuotaCheckIntervalMs);
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;
    const key = this.key(project);
    this.clearQuotaMonitor(key);
    const monitor = { timer: null };
    const schedule = () => {
      if (this.runtimeQuotaMonitors.get(key) !== monitor || !this.runtimes.has(key)) return;
      monitor.timer = setTimeout(() => {
        monitor.timer = null;
        void this.checkRuntimeQuota(project, monitor).catch(() => {}).finally(schedule);
      }, intervalMs);
      monitor.timer.unref?.();
    };
    this.runtimeQuotaMonitors.set(key, monitor);
    schedule();
  }

  /** Sample the container's process count against its ceiling, and record it
   *  when it gets close. Reading the cgroup directly is the only way: docker's
   *  own stats round-trip is slower than the monitor's cycle and reports the
   *  same number.
   *  @param {any} project @returns {Promise<void>} */
  async recordRuntimePidPressure(project) {
    const runtime = this.runtimes.get(this.key(project));
    if (!runtime) return;
    await this.provider.sampleResources(project, runtime);
  }

  /** The Docker provider's sample: both cgroup ceilings, read on one exec.
   *  @param {any} project @returns {Promise<void>} */
  async sampleDockerResources(project) {
    const runtime = this.runtimes.get(this.key(project));
    const containerName = runtime?.containerName;
    if (!containerName || runtime.sandboxMode !== "docker") return;
    const limit = Number(this.config.runtimePidsLimit);
    if (!Number.isFinite(limit) || limit <= 0) return;
    // Both ceilings on one exec. A run died at each of them on consecutive
    // attempts — pids at 256 with `socat: E fork(): EAGAIN`, then memory at
    // 4 GiB with the cgroup OOM killer taking the kernel — and neither left
    // anything readable behind. Sampling them together also records the SHAPE:
    // a working set that plateaus is a limit set too low, one that climbs
    // without settling is a leak, and raising the ceiling only helps the first.
    const result = spawnSync(
      this.config.runtimeContainerBin,
      ["exec", containerName, "sh", "-c", "cat /sys/fs/cgroup/pids.current; cat /sys/fs/cgroup/memory.current"],
      { encoding: "utf8", timeout: 5_000 },
    );
    if (result.status !== 0) return;
    const [pidsRaw, memoryRaw] = String(result.stdout).trim().split("\n");
    const current = Number(String(pidsRaw ?? "").trim());
    const memoryBytes = Number(String(memoryRaw ?? "").trim());
    if (Number.isFinite(memoryBytes)) {
      runtime.peakMemoryBytes = Math.max(Number(runtime.peakMemoryBytes ?? 0), memoryBytes);
      // Every sample, not just the peak: the curve is the diagnosis.
      runtime.memorySamples = [...(runtime.memorySamples ?? []).slice(-59), memoryBytes];
      const memoryLimit = parseByteSize(this.config.runtimeMemoryLimit);
      if (memoryLimit > 0 && !runtime.memoryPressureReported && memoryBytes * 5 >= memoryLimit * 4) {
        runtime.memoryPressureReported = true;
        void appendRuntimeEvent(project, "memory_pressure", {
          kind: runtime.kind,
          containerName,
          memoryBytes,
          memoryLimitBytes: memoryLimit,
        }, this.config);
      }
    }
    if (!Number.isFinite(current)) return;
    if (!recordPidSample(runtime, current, limit)) return;
    void appendRuntimeEvent(project, "pid_pressure", {
      kind: runtime.kind,
      containerName,
      pidsCurrent: current,
      pidsLimit: limit,
      memoryBytes: Number.isFinite(memoryBytes) ? memoryBytes : null,
    }, this.config);
  }

  async checkRuntimeQuota(project, monitor) {
    const key = this.key(project);
    if (this.runtimeQuotaMonitors.get(key) !== monitor || !this.runtimes.has(key)) return;
    // Say it before it bites.
    //
    // The pids ceiling killed three runs and left nothing behind: no OOM, no
    // signal, no dmesg line, and the container gone. The only trace was one
    // line of container output -- `socat: E fork(): Resource temporarily
    // unavailable` -- which the ledger did not carry until today. This puts the
    // approach on the record while the run is still alive, so a ceiling that is
    // too low is a warning rather than a post-mortem.
    //
    // Sampled on the quota monitor's existing cycle; the cgroup counts THREADS,
    // which is why a five-minute reading of 17 of 256 told us nothing about the
    // peak.
    void this.recordRuntimePidPressure(project).catch(() => {
      // isolated: evimed_runtime_pid_sample_failures_total -- a cgroup file
      // this kernel does not expose must not end a healthy run.
    });
    try {
      await assertProjectUsageWithinQuota(project, this.config);
    } catch (err) {
      if (this.runtimeQuotaMonitors.get(key) !== monitor || !this.runtimes.has(key)) return;
      if (err instanceof HttpError && err.code === "project_quota_exceeded") {
        await this.stopQuotaExceededRuntime(project, { recordMissing: false });
        return;
      }
      const error = err instanceof HttpError ? err.code : "runtime_quota_check_failed";
      // Failing to measure is not the same as being over the limit. A transient
      // read error — a file removed mid-walk, a momentary EMFILE — used to stop
      // the runtime exactly as an exceeded quota does, and the runtime does not
      // come back on its own. The guard still fires, but only once the same
      // measurement has failed repeatedly, which is what distinguishes a
      // genuinely unreadable workspace from a busy one.
      const consecutive = (monitor.consecutiveCheckFailures ?? 0) + 1;
      monitor.consecutiveCheckFailures = consecutive;
      await appendRuntimeEvent(project, "quota_check_failed", {
        kind: RUNTIME_KERNEL_NAME,
        error,
        consecutive,
        stopping: consecutive >= quotaCheckFailureTolerance,
      }, this.config);
      if (consecutive < quotaCheckFailureTolerance) return;
      await this.stopQuotaGuardRuntime(project, "quota_check_failed", error);
      return;
    }
    monitor.consecutiveCheckFailures = 0;
  }

  beginProxy(project) {
    this.noteRuntimeUse(project);
    this.enforceProxyCapacity(project);
    const key = this.key(project);
    const activity = this.activityFor(key);
    activity.activeProxies++;
    this.clearIdleTimer(key);
  }

  endProxy(project) {
    const key = this.key(project);
    const activity = this.activityFor(key);
    activity.activeProxies = Math.max(0, activity.activeProxies - 1);
    if (activity.activeProxies === 0) this.scheduleIdleStop(project);
  }

  scheduleIdleStop(project) {
    const timeoutMs = Number(this.config.runtimeIdleTimeoutMs);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return;
    const key = this.key(project);
    const activity = this.activityFor(key);
    if (!this.runtimes.has(key)) {
      if (activity.activeProxies === 0) this.runtimeActivity.delete(key);
      return;
    }
    if (activity.activeProxies > 0) return;
    this.clearIdleTimer(key);
    activity.idleTimer = setTimeout(() => {
      void this.reapIdleRuntime(project).catch(() => {});
    }, timeoutMs);
    activity.idleTimer.unref?.();
  }

  /**
   * The per-runtime idle timer's stop, held to the sweep's rule
   * (`idleVerdict`): a runtime whose kernel or ledger is still working is
   * asked again one idle period later instead of being stopped.
   * @param {Record<string, any>} project
   */
  async reapIdleRuntime(project) {
    const key = this.key(project);
    if (this.runtimes.has(key) && (this.runtimeActivity.get(key)?.activeProxies ?? 0) === 0) {
      if (await this.idleVerdict(project) !== "idle") {
        if (this.runtimes.has(key)) this.scheduleIdleStop(project);
        return;
      }
    }
    await this.stopIdleRuntime(project);
  }

  /**
   * @param {Record<string, any>} project
   * @param {{ event?: string, evenIfConnected?: boolean }} [options] `event`
   *   is what the ledger calls this stop: `idle_timeout` from the idle sweep,
   *   `yielded` when the same user's next project needed the slot
   *   (`makeRoomFor`). `evenIfConnected` stops it with a tab's connection
   *   still open — an opening's yield — instead of waiting for it to close.
   */
  async stopIdleRuntime(project, { event = "idle_timeout", evenIfConnected = false } = {}) {
    const key = this.key(project);
    const activity = this.runtimeActivity.get(key);
    const openConnections = activity?.activeProxies ?? 0;
    if (openConnections > 0 && !evenIfConnected) {
      this.scheduleIdleStop(project);
      return;
    }
    const runtime = this.runtimes.get(key);
    if (!runtime) {
      this.clearIdleTimer(key);
      this.runtimeActivity.delete(key);
      return;
    }
    await this.notifyRuntimeStopping(project);
    this.runtimes.delete(key);
    this.deactivateModelGatewayRuntime(runtime);
    this.clearIdleTimer(key);
    this.clearQuotaMonitor(key);
    this.runtimeActivity.delete(key);
    runtime.closedByManager = true;
    try {
      await runtime.close();
      await this.pluginService?.clearPromptAdmissions(project);
    } finally {
      await this.notifyRuntimeStop(project, runtime, "canceled");
    }
    await appendRuntimeEvent(project, event, {
      kind: runtime.kind,
      sandboxMode: runtime.sandboxMode ?? "mock",
      networkMode: runtime.networkMode ?? null,
      pid: runtime.pid,
      containerName: runtime.containerName ?? null,
      idleTimeoutMs: Number(this.config.runtimeIdleTimeoutMs),
      // A stop that closed a tab's connection says so: that tab is the one
      // that will next show 连接中断.
      ...(openConnections > 0 ? { openConnections } : {}),
    }, this.config);
    await recordRuntimeState(project, event, {
      running: false,
      kind: runtime.kind,
      startedAt: runtime.startedAt,
      pid: runtime.pid,
      exitedAt: runtime.exitedAt ?? new Date().toISOString(),
      sandboxMode: runtime.sandboxMode ?? "mock",
      networkMode: runtime.networkMode ?? null,
      containerName: runtime.containerName ?? null,
      skillsCopied: runtime.skillsCopied,
    });
  }

  activeProxyCount() {
    let count = 0;
    for (const activity of this.runtimeActivity.values()) {
      count += activity.activeProxies ?? 0;
    }
    return count;
  }

  activeProxyCountForProject(project) {
    return this.runtimeActivity.get(this.key(project))?.activeProxies ?? 0;
  }

  hasAttachedOrStartingRuntime(project) {
    const key = this.key(project);
    return this.runtimes.has(key) || this.starts.has(key);
  }

  noWakeProxyControlResult(project, method, suffix) {
    const control = noWakeRuntimeProxyControl(method, suffix);
    if (!control || this.hasAttachedOrStartingRuntime(project)) return null;
    return control;
  }

  enforceProxyCapacity(project) {
    const maxGlobal = positiveLimit(this.config.maxRuntimeProxyConnections);
    if (maxGlobal != null && this.activeProxyCount() >= maxGlobal) {
      throw proxyLimitExceeded("the server", maxGlobal);
    }
    const maxProject = positiveLimit(this.config.maxRuntimeProxyConnectionsPerProject);
    if (maxProject != null && this.activeProxyCountForProject(project) >= maxProject) {
      throw proxyLimitExceeded("this project", maxProject);
    }
  }

  /**
   * The kernel's own browser application is off unless an operator turns it on.
   *
   * Turning it on is a real change of exposure: an authenticated, project-scoped
   * browser reaches that kernel's whole surface, which is what makes its UI
   * usable and is also what the "the browser never reaches a kernel" rule was
   * written to prevent. Shipping it dark means the code can land and be
   * reviewed without moving anybody's boundary on the day it merges.
   */
  /**
   * Upgrade only the pinned project's native mux, with the browser boundary's
   * session and endpoint policies. Capacity is reserved through socket close.
   * @param {any} req @param {any} socket @param {Buffer} head
   * @param {Record<string, any>} project @param {string} suffix
   * @param {{ revalidate: () => Promise<void>, authorize: (endpoint: string) => Promise<void> }} policy
   */
  async proxyUpgrade(req, socket, head, project, suffix, policy) {
    this.enforceUiProxyEnabled();
    if (new URL(suffix, "http://runtime.local").pathname !== "/api/remote.mux" || !policy?.revalidate || !policy?.authorize) {
      throw new HttpError(403, "runtime_ui_upgrade_denied", "A policy-checked mux is required.");
    }
    this.beginProxy(project);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.endProxy(project);
    };
    socket.once("close", release);
    socket.on("error", () => socket.destroy());
    try {
      const runtime = await this.start(project);
      if (socket.destroyed) { release(); return; }
      await proxyRuntimeUiMux({
        req, socket, head, runtime,
        maxPayload: Math.max(1024, Number(this.config.maxJsonBytes) || 12 * 1024 * 1024),
        ...policy,
        admit: (endpoint, operation) => endpoint === "session/prompt" && this.pluginService
          ? this.pluginService.withAdmission(project, operation, { prompt: true }) : operation(),
      });
    } catch (error) {
      release();
      throw error;
    }
  }

  enforceUiProxyEnabled() {
    if (!this.config.runtimeUiProxyEnabled) {
      throw new HttpError(404, "runtime_ui_not_enabled", "The runtime browser application is not enabled on this deployment.");
    }
  }

  enforceProxyAllowlist(req, suffix) {
    const method = (req.method ?? "GET").toUpperCase();
    if (!isAllowedRuntimeProxyRoute(method, suffix, this.config)) {
      throw new HttpError(403, "runtime_proxy_forbidden", "Runtime proxy route is not exposed by the hosted server.");
    }
  }

  async enforceProjectQuota(project) {
    try {
      return await assertProjectUsageWithinQuota(project, this.config);
    } catch (err) {
      if (err instanceof HttpError && err.code === "project_quota_exceeded") {
        await this.stopQuotaExceededRuntime(project);
      }
      throw err;
    }
  }

  /**
   * One quota measurement for this project, started now unless one is already
   * running, and not awaited: the caller's response has been sent or is
   * streaming. A failed measurement is left to the quota monitor, which
   * distinguishes "over the limit" from "could not measure".
   * @param {any} project
   */
  checkQuotaInBackground(project) {
    const key = this.key(project);
    if (this.backgroundQuotaChecks.has(key)) return;
    const check = this.stopRuntimeIfProjectQuotaExceeded(project)
      .catch(() => {})
      .finally(() => this.backgroundQuotaChecks.delete(key));
    this.backgroundQuotaChecks.set(key, check);
  }

  async stopRuntimeIfProjectQuotaExceeded(project) {
    try {
      await assertProjectUsageWithinQuota(project, this.config);
      return false;
    } catch (err) {
      if (err instanceof HttpError && err.code === "project_quota_exceeded") {
        return this.stopQuotaExceededRuntime(project, { recordMissing: false });
      }
      throw err;
    }
  }

  async stopQuotaExceededRuntime(project, { recordMissing = true } = {}) {
    const key = this.key(project);
    const pending = this.runtimeQuotaStops.get(key);
    if (pending) return pending;
    const runtime = this.runtimes.get(key);
    if (!runtime) {
      this.clearQuotaMonitor(key);
      if (!recordMissing) return false;
      await appendRuntimeEvent(project, "quota_exceeded", {
        kind: null,
        sandboxMode: null,
        networkMode: null,
        maxProjectBytes: Number.isFinite(project.maxBytes) && project.maxBytes > 0
          ? project.maxBytes
          : this.config.maxProjectBytes,
      }, this.config);
      await recordRuntimeState(project, "quota_exceeded", {
        running: false,
        kind: null,
        startedAt: null,
        pid: null,
        exitedAt: new Date().toISOString(),
        sandboxMode: null,
        networkMode: null,
        containerName: null,
        error: "project_quota_exceeded",
      });
      return false;
    }
    return this.stopQuotaGuardRuntime(project, "quota_exceeded", "project_quota_exceeded");
  }

  async stopQuotaGuardRuntime(project, event, error) {
    const key = this.key(project);
    const pending = this.runtimeQuotaStops.get(key);
    if (pending) return pending;
    const stopping = (async () => {
      const runtime = this.runtimes.get(key);
      if (!runtime) return false;
      await this.notifyRuntimeStopping(project);
      this.runtimes.delete(key);
      this.deactivateModelGatewayRuntime(runtime);
      this.clearIdleTimer(key);
      this.clearQuotaMonitor(key);
      this.runtimeActivity.delete(key);
      runtime.closedByManager = true;
      try {
        await runtime.close();
      } finally {
        await this.notifyRuntimeStop(project, runtime, "failed");
      }
      await appendRuntimeEvent(project, event, {
        kind: runtime.kind,
        sandboxMode: runtime.sandboxMode ?? "mock",
        networkMode: runtime.networkMode ?? null,
        pid: runtime.pid,
        containerName: runtime.containerName ?? null,
        maxProjectBytes: Number.isFinite(project.maxBytes) && project.maxBytes > 0
          ? project.maxBytes
          : this.config.maxProjectBytes,
        error,
      }, this.config);
      await recordRuntimeState(project, event, {
        running: false,
        kind: runtime.kind,
        startedAt: runtime.startedAt,
        pid: runtime.pid,
        exitedAt: runtime.exitedAt ?? new Date().toISOString(),
        sandboxMode: runtime.sandboxMode ?? "mock",
        networkMode: runtime.networkMode ?? null,
        containerName: runtime.containerName ?? null,
        skillsCopied: runtime.skillsCopied,
        error,
      });
      return true;
    })();
    this.runtimeQuotaStops.set(key, stopping);
    try {
      return await stopping;
    } finally {
      if (this.runtimeQuotaStops.get(key) === stopping) this.runtimeQuotaStops.delete(key);
    }
  }

  /**
   * @param {any} req @param {string} suffix
   * @param {{ fileBody?: boolean }} [options] `fileBody`: the body is a file's
   *   bytes. Every POST was parsed as a JSON RPC here, so the composer's first
   *   attachment was refused as `invalid_runtime_proxy_payload` (2026-09-22).
   */
  async enforcePreStartProxyPolicy(req, suffix, { fileBody = false } = {}) {
    const method = req.method ?? "GET";
    if (method === "POST" && /^\/session\/[^/]+\/shell$/.test(suffix)) {
      if (!this.config.allowDirectShell) {
        throw new HttpError(403, "direct_shell_disabled", "Direct browser shell execution is disabled on the server.");
      }
    }
    if (fileBody) return;
    const body = validateRuntimeProxyPayload(req, suffix);
    if (method === "POST" && /^\/permission\/[^/]+\/reply$/.test(suffix)) {
      if (body?.reply === "always" && !this.config.allowPersistentApprovals) {
        throw new HttpError(403, "persistent_approval_disabled", "Persistent approvals are disabled on the server.");
      }
    }
  }

  async enforceRuntimeProxyPolicy(req, suffix, runtime) {
    const method = req.method ?? "GET";
    if (method === "POST" && /^\/session\/[^/]+\/shell$/.test(suffix)) {
      if (runtime.sandboxMode !== "docker" && !this.config.allowHostShell) {
        throw new HttpError(403, "host_shell_disabled", "Direct shell execution requires a sandboxed runtime.");
      }
    }
  }
}

/** Kernel-confirmed direct child heads, isolated for contract testing.
 *
 * A candidate counts only when the kernel's own summary says it is a subagent
 * of this parent. With `discoverSince`, an uncandidated child counts too when
 * the kernel says the same and its `updatedAt` — a child's creation time, since
 * nobody prompts a child directly — is not older than that moment: a native
 * session keeps every turn's children under one root, and an earlier turn's
 * child is an earlier run's work.
 * @param {readonly Record<string, any>[]} summaries @param {string} parentSessionId
 * @param {readonly string[]} childSessionIds
 * @param {{ discoverSince?: number }} [options]
 * @returns {{ sessionId: string, asOfSeq: number, running: boolean, discovered?: boolean }[]}
 */
export function childSessionHeads(summaries, parentSessionId, childSessionIds, { discoverSince } = {}) {
  const wanted = new Set(childSessionIds.map(String));
  const discovering = Number.isFinite(discoverSince);
  return summaries.flatMap((summary) => {
    const sessionId = String(summary?.sessionId ?? summary?.id ?? "");
    const parent = String(summary?.parentSessionId ?? summary?.parentSession ?? summary?.header?.parentSession ?? "");
    const origin = String(summary?.origin ?? summary?.header?.origin ?? "");
    const asOfSeq = Number(summary?.projections?.asOfSeq ?? summary?.asOfSeq ?? NaN);
    if (!sessionId || parent !== parentSessionId || origin !== "subagent" || !Number.isSafeInteger(asOfSeq) || asOfSeq < 0) return [];
    if (wanted.has(sessionId)) return [{ sessionId, asOfSeq, running: summary?.running === true }];
    const createdAt = Number(summary?.updatedAt ?? NaN);
    if (!discovering || !Number.isFinite(createdAt) || createdAt < Number(discoverSince)) return [];
    return [{ sessionId, asOfSeq, running: summary?.running === true, discovered: true }];
  }).sort((left, right) => left.sessionId.localeCompare(right.sessionId, "en"));
}
