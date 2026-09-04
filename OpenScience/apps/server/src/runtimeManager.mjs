import { Buffer } from "node:buffer";
import { spawn, spawnSync } from "node:child_process";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { lstatSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { workspaceLayout } from "@evimed/domain";
import {
  dockerRuntimeMount,
  dockerWorkspaceMount,
} from "./dockerMounts.mjs";
import { supportedDeepSeekModels } from "./modelGateway.mjs";
import { startMockDshRuntime } from "./mockDshRuntime.mjs";
import { browserSessionCookie, generateBrowserSessionSecret } from "./dshBrowserAuth.mjs";
import { renderCredentialsFile, renderProfilePatch, runtimeEnvironment } from "./dshProfilePatch.mjs";
import { runtimeReleasePolicyError } from "./releaseManifest.mjs";
import { RuntimeControllerClient } from "./runtimeControllerClient.mjs";
import {
  isAllowedWireMethod,
  mapWireError,
  normalizeTranscript,
  transcriptToLedgerMessages,
} from "./dshRuntimeAdapter.mjs";
import {
  HttpError,
  appendJsonLineNoFollow,
  assertNoSymlinkPath,
  assertProjectUsageWithinQuota,
  ensureDir,
  randomId,
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
function proxiedRuntimeLocation(value, runtime, project) {
  if (!value) return null;
  try {
    const runtimeOrigin = new URL(runtime.url).origin;
    const target = new URL(value, runtime.url);
    if (target.origin !== runtimeOrigin) return null;
    target.searchParams.delete("directory");
    target.searchParams.delete("auth_token");
    return `/api/runtime/${encodeURIComponent(project.id)}${target.pathname}${target.search}${target.hash}`;
  } catch {
    return null;
  }
}

function sanitizedRuntimeResponseHeaders(upstreamRes, runtime, project) {
  const responseHeaders = {};
  const connectionTokens = connectionHeaderTokens(upstreamRes.headers);
  upstreamRes.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower === "location") {
      const location = proxiedRuntimeLocation(value, runtime, project);
      if (location) responseHeaders[lower] = location;
      return;
    }
    if (blockedRuntimeResponseHeaders.has(lower) || connectionTokens.has(lower)) return;
    responseHeaders[lower] = value;
  });
  return responseHeaders;
}

/**
 * One audit row per asset kind rather than per asset.
 *
 * The kernel's application requests hashed bundle names, so auditing the raw
 * path would make every deploy of it a new route in the metrics.
 */
function uiProxyAuditTarget(suffix) {
  const pathname = suffix.split("?")[0] || "/";
  if (pathname === "/" || pathname === "/index.html") return "/";
  if (/^\/api(?:\/|$)/.test(pathname)) return pathname.replace(/^(\/api\/[^/]+).*$/, "$1");
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

function runtimeStateFile(project) {
  return path.join(project.metaDir, "runtime-state.json");
}

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
    error: fields.error ?? null,
  };
}

function publicRuntimeStatusFromState(state) {
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
    error: typeof state?.error === "string" ? state.error : wasRunning ? "runtime_not_attached" : null,
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
      Object.keys(payload).sort().join(",") !== "aud,iat,jti,projectId,userId,v" ||
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
  } = {},
) {
  const token = issueEviMedWorkloadToken({
    secret: config.evimedWorkloadSigningSecret,
    userId: String(project.userId),
    projectId: String(project.id),
    nowSeconds,
    ttlSeconds: config.evimedWorkloadTokenTtlSeconds ?? 300,
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
  const publicSourceGatewayUrl = String(config.publicSourceGatewayInternalUrl ?? "").trim();
  if (publicSourceGatewayUrl) {
    let parsed;
    try {
      parsed = new URL(publicSourceGatewayUrl);
    } catch {
      throw runtimeMcpError(
        "runtime_public_source_gateway_url_invalid",
        "The public-source gateway URL must be an absolute HTTP(S) URL.",
      );
    }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw runtimeMcpError(
        "runtime_public_source_gateway_url_invalid",
        "The public-source gateway URL must be an HTTP(S) URL without embedded credentials.",
      );
    }
    environment.EVIMED_PUBLIC_SOURCE_GATEWAY_URL = publicSourceGatewayUrl;
    // Open-web search rides the same runtime token as the source gateway, and
    // is only offered when the deployment actually has a metasearch backend.
    // Its URL is the server's own route: the runtime never learns which
    // aggregator, or which engines, sit behind it.
    if (String(config.webSearchUrl ?? "").trim()) {
      const webSearchGatewayUrl = String(config.webSearchGatewayInternalUrl ?? "").trim();
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
      const geoProbeGatewayUrl = String(config.geoProbeGatewayInternalUrl ?? "").trim();
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
    if (plan.sandboxMode === "docker") {
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
    if (plan.sandboxMode === "docker") {
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
    if (plan.sandboxMode === "docker") {
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
  environment.EVIMED_MODEL_GATEWAY_TOKEN_FILE = `${runtimeDshHome}/${modelGatewayTokenFileName}`;
  environment.EVIMED_MODEL_GATEWAY_URL = modelGatewayProviderUrl(config);
  environment.EVIMED_MODEL_GATEWAY_MODEL = String(config.deepseekModel ?? "");
  // Set even when empty, unlike the adapter URLs below. A container that keeps
  // a value from a previous deployment because the new one had nothing to say
  // is the shape of "the lever was moved and nothing happened"; an explicit
  // empty string is the deployment saying "everything is offered".
  environment.EVIMED_DISABLED_TOOLS = String(config.evimedDisabledTools ?? "");
  for (const [key, envName] of Object.entries(evimedAdapterEnvironment)) {
    const value = String(configured[key] ?? "").trim();
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

/**
 * The one description of a runtime's deployment settings.
 *
 * The patch and the container environment are two halves of it: rows the host
 * composition owns are written into the patch, and the settings of the plugins
 * a preset mounts travel as environment, because a profile patch cannot reach a
 * preset's rows. Deriving both from this function is what keeps the halves from
 * describing different deployments.
 *
 * @param {any} config @param {any} project @param {any} plan @param {string} model @param {string} workloadTokenPath
 * @returns {import("./dshProfilePatch.mjs").ProfilePatchInput}
 */
function dshProfileInput(config, project, plan, model, workloadTokenPath) {
  return {
    modelGatewayUrl: modelGatewayProviderUrl(config),
    model,
    contextWindow: 1_000_000,
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
    capabilitySkillsDir: "/opt/evimed/capability-skills",
    // The capsule product ledger and its recall endpoint are not built yet
    // (§16 #20's own tracked gap list). An empty URL is not a placeholder that
    // silently does the wrong thing: `evimed-capsule`'s plugin already checks
    // for exactly this and disables its own tools with a named diagnostic
    // rather than erroring, so a deployment without capsule support fails
    // closed and visibly, not open and silently.
    capsuleMethodsDir: "",
    capsuleGatewayUrl: "",
    workloadTokenFile: workloadTokenPath,
    bundleVersion: String(config.socketBundleVersion ?? ""),
    dshVersion: String(config.dshVersion ?? ""),
    limits: {
      deliveryAttemptLimit: config.deliveryAttemptLimit,
      maxParallelChildren: config.maxParallelChildren,
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
      capsule: false,
      requiredEnforcement: /** @type {'full'|'partial'} */ (config.runtimeSandboxEnforcement),
    },
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
 * @param {any} config
 * @param {any} project
 * @param {any} plan
 * @param {{ nowSeconds?: number, jti?: string, writeFile?: typeof writeFileAtomicNoFollow }} [options]
 * @returns {Promise<{ configured: boolean, workloadTokenFile: string | null, workloadTokenRefreshMs: number | null, token: string | null, payload: Record<string, any> | null, browserSessionSecret?: string | null }>}
 */
export async function syncRuntimeDshProfile(
  config,
  project,
  plan,
  { nowSeconds = Math.floor(Date.now() / 1000), jti = randomId("mgw_"), writeFile = writeFileAtomicNoFollow } = {},
) {
  if (!config.deepseekProviderEnabled) return { configured: false, workloadTokenFile: null, workloadTokenRefreshMs: null, token: null, payload: null, browserSessionSecret: null };
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
  await assertNoSymlinkPath(project.rootDir, plan.dshHomeDir, { allowMissingTail: true });
  await fs.mkdir(plan.dshHomeDir, { recursive: true, mode: 0o700 });
  await assertNoSymlinkPath(project.rootDir, plan.dshHomeDir);

  const modelGatewayToken = issueModelGatewayRuntimeToken({
    secret: config.modelGatewaySigningSecret,
    userId: String(project.userId),
    projectId: String(project.id),
    nowSeconds,
    jti,
  });
  // Verified here because the caller needs the payload to register the token as
  // active, and the gateway rejects any token whose jti it has not been told
  // about.
  const modelGatewayPayload = verifyModelGatewayRuntimeToken(modelGatewayToken, {
    secret: config.modelGatewaySigningSecret,
    userId: String(project.userId),
    projectId: String(project.id),
    nowSeconds,
  });
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
  const browserSessionSecret = generateBrowserSessionSecret();
  const credentials = renderCredentialsFile({ token: modelGatewayToken, browserSessionSecret });
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
    `${modelGatewayToken}\n`,
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
    await refreshEviMedWorkloadToken(config, project, workloadTokenFile, { nowSeconds, writeToken: writeFile });
  }

  return {
    configured: true,
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

export function buildRuntimeLaunchPlan(config, project, port) {
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
    const runtimeRoot = path.join(project.runtimeDir, "container-runtime");
    const xdgConfigDir = path.join(runtimeRoot, "xdg-config");
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
        "--mount",
        dockerRuntimeMount(config, runtimeRoot),
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
          capabilitySkillsDir: "/opt/evimed/capability-skills",
          capsuleMethodsDir: "",
          capsuleGatewayUrl: "",
          workloadTokenFile: `${runtimeDshHome}/${evimedWorkloadTokenFileName}`,
          bundleVersion: String(config.socketBundleVersion ?? ""),
          flags: {
            hosted: Boolean(config.production),
            // Same two settings as `dshProfileInput`; see there.
            askUser: Boolean(config.runtimeAskUserEnabled),
            review: Boolean(config.runtimeReviewEnabled),
            capsule: false,
            requiredEnforcement: /** @type {'full'|'partial'} */ (config.runtimeSandboxEnforcement),
          },
          limits: {
            deliveryAttemptLimit: config.deliveryAttemptLimit,
            maxParallelChildren: config.maxParallelChildren,
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

export class RuntimeManager {
  constructor(config, {
    agentRegistry = null,
    workloadTokenWriter = refreshEviMedWorkloadToken,
    setWorkloadTimer = setTimeout,
    clearWorkloadTimer = clearTimeout,
    onRuntimeStop = async () => {},
    onSessionAbort = async () => {},
    onRuntimeStart = () => {},
  } = {}) {
    this.config = config;
    this.agentRegistry = agentRegistry;
    this.runtimeControllerMode = config.runtimeControllerMode ?? "direct";
    this.runtimeController = this.runtimeControllerMode === "socket"
      ? new RuntimeControllerClient(config)
      : null;
    this.runtimes = new Map();
    this.starts = new Map();
    this.runtimeActivity = new Map();
    this.runtimeQuotaMonitors = new Map();
    this.runtimeQuotaStops = new Map();
    this.evimedWorkloadRefreshTimers = new Map();
    this.activeModelGatewayTokens = new Map();
    this.workloadTokenWriter = workloadTokenWriter;
    this.setWorkloadTimer = setWorkloadTimer;
    this.clearWorkloadTimer = clearWorkloadTimer;
    /** @type {(project: any, status: any) => any} */
    this.onRuntimeStop = onRuntimeStop;
    /** @type {(project: any, sessionId: any) => any} */
    this.onSessionAbort = onSessionAbort;
    /** @type {(project: any, runtime: any) => any} */
    this.onRuntimeStart = onRuntimeStart;
    this.lastOrphanCleanup = null;
  }

  usesRuntimeController() {
    return this.runtimeController != null;
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

  assertDockerControlBoundary() {
    const mode = this.runtimeControllerMode;
    if (!["direct", "socket"].includes(mode)) {
      throw new HttpError(503, "runtime_controller_mode_invalid", "Runtime controller mode is invalid.");
    }
    if (
      this.config.production &&
      (
        this.config.runtimeSandboxMode === "docker" ||
        (this.config.enableKernel && this.config.kernelSandboxMode === "docker")
      ) &&
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
    const expectedKernels = positiveLimit(this.config.maxConcurrentKernels);
    const expectedKernelsPerUser = positiveLimit(this.config.maxConcurrentKernelsPerUser);
    if (
      health.maxRunningRuntimes !== expectedGlobal ||
      health.maxRunningRuntimesPerUser !== expectedPerUser ||
      health.maxConcurrentKernels !== expectedKernels ||
      health.maxConcurrentKernelsPerUser !== expectedKernelsPerUser
    ) {
      throw new HttpError(
        503,
        "runtime_controller_limit_mismatch",
        "Runtime controller capacity limits do not match the Web API.",
      );
    }
    return health;
  }

  async assertDockerSupport(code = "runtime_volume_subpath_unsupported") {
    this.assertDockerControlBoundary();
    if (!this.runtimeController && !this.config.runtimeDataVolume) return null;
    const info = await this.dockerInfo();
    if (this.config.runtimeDataVolume && (!Number.isSafeInteger(info.major) || info.major < 26)) {
      throw new HttpError(503, code, "Docker Engine 26 or newer is required for project volume subpath mounts.");
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

  async runControlledKernel(project, code, signal, language = "python") {
    if (!this.runtimeController) {
      throw new HttpError(503, "runtime_controller_required", "Docker kernel execution requires the runtime controller.");
    }
    await this.assertDockerSupport("kernel_volume_subpath_unsupported");
    return this.runtimeController.runKernel(project, code, signal, language);
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

  async start(project) {
    const key = this.key(project);
    await this.runtimeQuotaStops.get(key);
    await this.enforceProjectQuota(project);
    let existing = this.runtimes.get(key);
    if (existing && existing.workspaceDir !== project.workspaceDir) {
      await this.stop(project);
      existing = null;
    }
    if (existing) {
      this.scheduleIdleStop(project);
      return existing;
    }
    const pending = this.starts.get(key);
    if (pending) return pending;
    this.enforceRuntimeCapacity(project);

    const started = (async () => {
      if (this.config.runtimeMode === "kernel") {
        const runtime = await this.startKernel(project);
        this.runtimes.set(key, runtime);
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
      };
      this.runtimes.set(key, runtime);
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
      try {
        this.onRuntimeStart(project, runtime);
      } catch {
        // isolated: evimed_runtime_start_hook_failures_total — a live-stream
        // attachment failure must not fail the run itself; request/response
        // calls never depend on it.
      }
      return runtime;
    } finally {
      this.starts.delete(key);
    }
  }

  async startKernel(project) {
    const key = this.key(project);
    const port = await freePort();
    // Only the controller protocol still carries this: its `startRuntime` field
    // is validated on the privileged side and the launch plan no longer uses
    // it. The retired kernel's HTTP server authenticated with it; this one
    // authenticates with the browser-session cookie minted in
    // `syncRuntimeDshProfile`, so nothing inside the container reads a password.
    const password = randomId("pw_");
    if (this.config.runtimeSandboxMode === "docker") {
      await this.assertDockerSupport();
    }
    const plan = buildRuntimeLaunchPlan(this.config, project, port);
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
      const cleanup = await this.cleanupDocker(plan, project);
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
          error: "runtime_cleanup_failed",
        });
        throw new HttpError(502, "runtime_cleanup_failed", "Runtime container cleanup failed before startup.");
      }
    }
    if (plan.socketPath && socketStat) await fs.rm(plan.socketPath, { force: true });

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
      const dshSync = await syncRuntimeDshProfile(this.config, project, plan);
      mcpSync = {
        copied: 0,
        configured: dshSync.configured ? 1 : 0,
        workloadTokenFile: dshSync.workloadTokenFile,
        workloadTokenRefreshMs: dshSync.workloadTokenRefreshMs,
      };
      modelGatewaySync = {
        configured: dshSync.configured ? 1 : 0,
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
      mcpServersCopied: mcpSync.copied,
      mcpServersConfigured: mcpSync.configured,
    });
    let child;
    if (plan.sandboxMode === "docker" && this.runtimeController) {
      await this.runtimeController.startRuntime(project, port, password);
      child = new RemoteRuntimeProcess(
        this.runtimeController,
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
    const runtime = {
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
      networkMode: this.config.runtimeNetworkMode,
      workspaceDir: project.workspaceDir,
      proxyWorkspaceDir: plan.proxyWorkspaceDir ?? project.workspaceDir,
      child,
      startedAt: new Date().toISOString(),
      pid: child.pid,
      containerName: plan.containerName ?? null,
      skillsCopied,
      agentSkillsCopied,
      agentsGenerated,
      workloadTokenFile: mcpSync.workloadTokenFile,
      workloadTokenRefreshMs: mcpSync.workloadTokenRefreshMs,
      modelGatewayToken: modelGatewaySync.token,
      modelGatewayTokenJti: modelGatewaySync.payload?.jti ?? null,
      exitedAt: null,
      spawnError: null,
      project,
      close: async () => {
        if (plan.sandboxMode === "docker" && this.runtimeController) {
          await /** @type {any} */ (child).stop();
        } else {
          if (plan.sandboxMode === "docker") await cleanupDockerContainer(plan);
          await terminateChild(child);
        }
        if (plan.socketPath) await fs.rm(plan.socketPath, { force: true }).catch(() => {});
      },
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
      if (plan.sandboxMode === "docker" && !this.runtimeController) {
        void cleanupDockerContainer(plan).catch(() => {
          // isolated: a container that cannot be removed is a leak worth a
          // metric, not a reason to fail a run that has already ended.
        });
      }
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
      });
    });
    try {
      await this.waitUntilReady(runtime);
      if (runtime.workloadTokenFile) {
        await this.workloadTokenWriter(this.config, project, runtime.workloadTokenFile);
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
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    return runtime;
  }

  async waitUntilReady(runtime) {
    // Not the per-call connect timeout: starting is not calling. See the note
    // on `runtimeReadyTimeoutMs` in config.mjs.
    //
    // The longer allowance is for a container, which is where composing a
    // plugin tree takes a minute. A host runtime starts a process that either
    // binds a port or does not, and giving it three minutes to do so would turn
    // "the binary is missing" into a three-minute wait.
    const timeoutMs = runtime.sandboxMode === "docker"
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
    const runtime = this.runtimes.get(this.key(project));
    if (runtime) {
      return publicRuntimeStatus(runtime, {
        stale: false,
        lastEvent: "started",
        lastUpdatedAt: runtime.startedAt,
        skillsCopied: runtime.skillsCopied,
        agentSkillsCopied: runtime.agentSkillsCopied,
        agentsGenerated: runtime.agentsGenerated,
      });
    }
    const state = await readRuntimeState(project);
    if (state) return publicRuntimeStatusFromState(state);
    return publicRuntimeStatus(null);
  }

  runtimeWorkspaceRoot(project) {
    const runtime = this.runtimes.get(this.key(project));
    return runtime?.proxyWorkspaceDir ?? project.workspaceDir;
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
  async sessionMessages(project, sessionId, { wake = true } = {}) {
    const transcript = await this.sessionTranscript(project, sessionId, { wake });
    return transcriptToLedgerMessages(transcript);
  }

  /**
   * The run as `@evimed/domain` describes it: the kernel's event log,
   * normalized into the one vocabulary every caller reads.
   * @param {Record<string, any>} project @param {string} sessionId @param {{ wake?: boolean }} options
   * @returns {Promise<import('@evimed/domain').RunTranscript>}
   */
  async sessionTranscript(project, sessionId, { wake = true } = {}) {
    const runtime = wake ? await this.start(project) : this.runtimes.get(this.key(project));
    if (!runtime) {
      throw new HttpError(409, "runtime_not_running", "Runtime is not running for session history monitoring.");
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
      const head = (Array.isArray(listed?.items) ? listed.items : [])
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
      // 200 pages x 25 messages bounds a transcript at 5000 messages -- the
      // page shrink above must not quietly shrink the whole readable run.
      for (let page = 0; page < 200; page += 1) {
        let value;
        try {
          value = await this.withRuntimeDeadline(
            (signal) => this.callKernel(runtime, project, "session/page", {
              request: {
                address: { kind: "session", sessionId },
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
        if (!value?.hasMore || !pageEntries.length) break;
        const firstSeq = Number(pageEntries[0]?.event?.seq ?? NaN);
        if (!Number.isFinite(firstSeq)) break;
        beforeSeq = firstSeq;
      }
      return normalizeTranscript(sessionId, pages.flat());
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
      const items = Array.isArray(value?.items) ? value.items : [];
      const entry = items.find((item) => String(item?.sessionId) === String(sessionId));
      return entry?.running ? "busy" : "idle";
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
   * written into the workspace before dispatch and injected by the socket at
   * session start, where it becomes a first-class logged message.
   *
   * @param {Record<string, any>} project @param {string} sessionId
   * @param {{ text: string, system?: string | null, agent?: string | null, model?: string | null, runId?: string | null }} input
   * @returns {Promise<void>}
   */
  async dispatchPrompt(project, sessionId, { text, system = null, runId = null }) {
    const runtime = this.runtimes.get(this.key(project));
    if (!runtime) {
      const error = new HttpError(409, "runtime_prompt_rejected", "Runtime was not available to accept the prompt.");
      error.definitivelyRejected = true;
      throw error;
    }
    if (typeof system === "string" && system.trim()) {
      await this.writeRunContextFile(project, system);
    }
    if (typeof runId === "string" && runId) {
      await this.writeRunBriefIndex(project, runId);
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
            // local echo. Two dispatches sharing one id would be
            // indistinguishable in the queue, so it is minted per call.
            requestId: randomId("req_"),
            sessionId,
            mode: "queue",
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
  async writeRunContextFile(project, context) {
    // isolated: evimed_run_context_write_failures_total
    try {
      const briefDir = path.join(project.workspaceDir, ".evimed-brief");
      await fs.mkdir(briefDir, { recursive: true, mode: 0o700 });
      await writeFileAtomicNoFollow(project.workspaceDir, path.join(briefDir, "context.md"), context, {
        encoding: "utf8",
        mode: 0o444,
      });
    } catch { /* isolated: evimed_run_context_write_failures_total */ }
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
  async writeRunBriefIndex(project, runId) {
    // isolated: evimed_run_brief_index_write_failures_total
    try {
      const briefDir = path.join(project.workspaceDir, workspaceLayout.briefDir);
      await fs.mkdir(briefDir, { recursive: true, mode: 0o700 });
      await writeFileAtomicNoFollow(project.workspaceDir, path.join(project.workspaceDir, workspaceLayout.briefIndexFile), `${JSON.stringify({ runId }, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o444,
      });
    } catch { /* isolated: evimed_run_brief_index_write_failures_total */ }
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

  enforceRuntimeCapacity(project) {
    const maxGlobal = positiveLimit(this.config.maxRunningRuntimes);
    if (maxGlobal != null && this.runtimeCount() >= maxGlobal) {
      throw new HttpError(429, "runtime_limit_exceeded", `Too many running runtimes for the server; limit is ${maxGlobal}.`, {
        retryAfterSeconds: 5,
      });
    }
    const maxPerUser = positiveLimit(this.config.maxRunningRuntimesPerUser);
    if (maxPerUser != null && this.runtimeCountForUser(project.userId) >= maxPerUser) {
      throw new HttpError(429, "runtime_limit_exceeded", `Too many running runtimes for this user; limit is ${maxPerUser}.`, {
        retryAfterSeconds: 5,
      });
    }
  }

  runtimeCount() {
    return this.runtimes.size + this.starts.size;
  }

  runtimeCountForUser(userId) {
    const prefix = `${userId}:`;
    let count = 0;
    for (const key of this.runtimes.keys()) {
      if (key.startsWith(prefix)) count++;
    }
    for (const key of this.starts.keys()) {
      if (key.startsWith(prefix)) count++;
    }
    return count;
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
      return;
    }
    this.runtimes.delete(key);
    this.deactivateModelGatewayRuntime(runtime);
    this.clearIdleTimer(key);
    this.clearQuotaMonitor(key);
    this.clearEviMedWorkloadRefresh(key);
    this.runtimeActivity.delete(key);
    runtime.closedByManager = true;
    try {
      await runtime.close();
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
      if (state.sandboxMode === "docker" && typeof state.containerName === "string" && state.containerName) {
        const plan = {
          command: this.config.runtimeContainerBin,
          containerName: state.containerName,
          cwd: project.workspaceDir,
          env: process.env,
        };
        const cleanup = await this.cleanupDocker(plan, project);
        if (cleanup.cleaned || cleanup.missing) {
          if (cleanup.cleaned) summary.cleaned += 1;
          else summary.missing += 1;
          await appendRuntimeEvent(project, "startup_orphan_cleanup", {
            kind: state.kind ?? RUNTIME_KERNEL_NAME,
            sandboxMode: "docker",
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
            sandboxMode: "docker",
            networkMode: state.networkMode ?? this.config.runtimeNetworkMode,
            containerName: state.containerName,
            skillsCopied: state.skillsCopied,
          });
          continue;
        }
        summary.failed += 1;
        await appendRuntimeEvent(project, "startup_orphan_cleanup_failed", {
          kind: state.kind ?? RUNTIME_KERNEL_NAME,
          sandboxMode: "docker",
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
          sandboxMode: "docker",
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
    const runtime = await this.start(project);
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
   * @param {string} suffix @param {{ surface?: string }} [options]
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
  async proxy(req, res, project, suffix, { surface = "runtime" } = {}) {
    const startedAt = Date.now();
    const method = req.method ?? "GET";
    const target = surface === "ui" ? uiProxyAuditTarget(suffix) : proxyAuditTarget(suffix);
    let status = null;
    let streaming = false;
    let error = null;
    let proxyActive = false;
    let requestBytes = requestContentLength(req) ?? 0;
    let responseBytes = 0;
    let postResponseQuotaChecked = false;
    const abortedSessionId = abortedRuntimeSession(method, suffix);
    try {
      this.beginProxy(project);
      proxyActive = true;
      if (surface === "ui") this.enforceUiProxyEnabled();
      else this.enforceProxyAllowlist(req, suffix);
      await bufferProxyRequestBody(req, method, this.config.maxJsonBytes);
      requestBytes = Buffer.isBuffer(req.__openScienceProxyBody) ? req.__openScienceProxyBody.length : requestBytes;
      await this.enforcePreStartProxyPolicy(req, suffix);
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
      await this.enforceRuntimeProxyPolicy(req, suffix, runtime);
      const incoming = new URL(req.url ?? "/", "http://open-science.local");
      const upstream = new URL(`${runtime.url}${suffix}`);
      for (const [key, value] of incoming.searchParams) {
        if (surface === "ui") upstream.searchParams.append(key, value);
        else if (key !== "directory" && key !== "auth_token") upstream.searchParams.append(key, value);
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

      status = upstreamRes.status;
      if (abortedSessionId && upstreamRes.status >= 200 && upstreamRes.status < 300) {
        await this.onSessionAbort(project, abortedSessionId);
      }
      streaming = (upstreamRes.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream");
      const responseHeaders = sanitizedRuntimeResponseHeaders(upstreamRes, runtime, project);
      if (!upstreamRes.body) {
        try {
          await this.stopRuntimeIfProjectQuotaExceeded(project);
          postResponseQuotaChecked = true;
        } catch { /* a quota probe must not break a response already in flight */ }
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
            try {
              await this.stopRuntimeIfProjectQuotaExceeded(project);
              postResponseQuotaChecked = true;
            } catch { /* a quota probe must not break a response already in flight */ }
            res.writeHead(upstreamRes.status, responseHeaders);
            responseEnded = true;
            res.end(method === "HEAD" ? undefined : payload);
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
      if (error !== "project_quota_exceeded" && !postResponseQuotaChecked) {
        await this.stopRuntimeIfProjectQuotaExceeded(project).catch(() => {});
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
    const activity = { activeProxies: 0, idleTimer: null };
    this.runtimeActivity.set(key, activity);
    return activity;
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
      await this.workloadTokenWriter(this.config, project, runtime.workloadTokenFile);
      await appendRuntimeEvent(project, "workload_token_refreshed", {
        kind: runtime.kind,
        sandboxMode: runtime.sandboxMode,
      }, this.config);
      return true;
    } catch (error) {
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
      void this.stopIdleRuntime(project);
    }, timeoutMs);
    activity.idleTimer.unref?.();
  }

  async stopIdleRuntime(project) {
    const key = this.key(project);
    const activity = this.runtimeActivity.get(key);
    if (activity?.activeProxies > 0) {
      this.scheduleIdleStop(project);
      return;
    }
    const runtime = this.runtimes.get(key);
    if (!runtime) {
      this.clearIdleTimer(key);
      this.runtimeActivity.delete(key);
      return;
    }
    this.runtimes.delete(key);
    this.deactivateModelGatewayRuntime(runtime);
    this.clearIdleTimer(key);
    this.clearQuotaMonitor(key);
    this.runtimeActivity.delete(key);
    runtime.closedByManager = true;
    try {
      await runtime.close();
    } finally {
      await this.notifyRuntimeStop(project, runtime, "canceled");
    }
    await appendRuntimeEvent(project, "idle_timeout", {
      kind: runtime.kind,
      sandboxMode: runtime.sandboxMode ?? "mock",
      networkMode: runtime.networkMode ?? null,
      pid: runtime.pid,
      containerName: runtime.containerName ?? null,
      idleTimeoutMs: Number(this.config.runtimeIdleTimeoutMs),
    }, this.config);
    await recordRuntimeState(project, "idle_timeout", {
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

  async enforcePreStartProxyPolicy(req, suffix) {
    const method = req.method ?? "GET";
    if (method === "POST" && /^\/session\/[^/]+\/shell$/.test(suffix)) {
      if (!this.config.allowDirectShell) {
        throw new HttpError(403, "direct_shell_disabled", "Direct browser shell execution is disabled on the server.");
      }
    }
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
