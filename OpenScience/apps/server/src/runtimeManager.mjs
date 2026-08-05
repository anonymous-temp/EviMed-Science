import { Buffer } from "node:buffer";
import { spawn, spawnSync } from "node:child_process";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { constants as fsConstants, existsSync, lstatSync } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  dockerRuntimeMount,
  dockerWorkspaceMount,
} from "./dockerMounts.mjs";
import { deepSeekModelDisplayName, supportedDeepSeekModels } from "./modelGateway.mjs";
import { startMockOpenCodeRuntime } from "./mockRuntime.mjs";
import { runtimeReleasePolicyError } from "./releaseManifest.mjs";
import { RuntimeControllerClient } from "./runtimeControllerClient.mjs";
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
const bundledEviMedMcpDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../runtime/mcp/evimed-research",
);

class RemoteRuntimeProcess extends EventEmitter {
  constructor(client, project, pollMs) {
    super();
    this.client = client;
    this.project = project;
    this.pollMs = Math.max(100, Number(pollMs) || 500);
    this.pid = null;
    this.exitCode = null;
    this.signalCode = null;
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

function basicAuth(password) {
  return `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
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
  const socketOptions = runtime.socketPath
    ? {
        ...requestOptions,
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

function proxiedRuntimeLocation(value, runtime, project) {
  if (!value) return null;
  try {
    const runtimeOrigin = new URL(runtime.url).origin;
    const target = new URL(value, runtime.url);
    if (target.origin !== runtimeOrigin) return null;
    target.searchParams.delete("directory");
    target.searchParams.delete("auth_token");
    return `/api/opencode/${encodeURIComponent(project.id)}${target.pathname}${target.search}${target.hash}`;
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

function appendCappedOutput(current, chunk, maxBytes) {
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

async function waitForPidExit(pid, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if (err?.code === "ESRCH") return true;
      if (err?.code === "EPERM") return false;
      return true;
    }
    await sleep(50);
  }
  return false;
}

function processCommandLine(pid) {
  if (process.platform === "win32") return "";
  const out = spawnSync("ps", ["-o", "command=", "-p", String(pid)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return out.status === 0 ? out.stdout.trim() : "";
}

function isLikelyOpenCodeServe(commandLine, command) {
  if (!commandLine) return false;
  const commandName = path.basename(command || "opencode");
  return commandLine.includes(commandName) && /(^|\s)serve(\s|$)/.test(commandLine);
}

export async function cleanupHostRuntimeProcess(plan, previousState, hooks = {}) {
  const commandLineForPid = hooks.commandLine ?? processCommandLine;
  const kill = hooks.kill ?? ((pid, signal) => process.kill(pid, signal));
  const waitForExit = hooks.waitForExit ?? waitForPidExit;
  if (plan.sandboxMode !== "host") return { cleaned: false, reason: "not_host" };
  if (
    previousState?.kind !== "opencode" ||
    previousState?.sandboxMode !== "host" ||
    (previousState.running !== true && previousState.event !== "starting")
  ) {
    return { cleaned: false, reason: "not_stale" };
  }
  const pid = previousState.pid;
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) {
    return { cleaned: false, reason: "invalid_pid" };
  }

  const commandLine = commandLineForPid(pid);
  if (!isLikelyOpenCodeServe(commandLine, plan.command)) {
    return { cleaned: false, reason: "pid_mismatch" };
  }

  try {
    kill(pid, "SIGTERM");
  } catch (err) {
    if (err?.code === "ESRCH") return { cleaned: false, reason: "not_running" };
    return { cleaned: false, failed: true, reason: "kill_failed", error: err instanceof Error ? err.message : String(err), pid };
  }
  if (!(await waitForExit(pid))) {
    try {
      kill(pid, "SIGKILL");
    } catch (err) {
      if (err?.code === "ESRCH") return { cleaned: true, pid };
      return { cleaned: false, failed: true, reason: "kill_failed", error: err instanceof Error ? err.message : String(err), pid };
    }
    if (!(await waitForExit(pid, 1_000))) {
      return {
        cleaned: false,
        failed: true,
        reason: "kill_unconfirmed",
        error: "Host runtime did not exit after SIGKILL.",
        pid,
      };
    }
  }
  return { cleaned: true, pid };
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

async function readRuntimeResponseBody(body, limit, onReader, onBytes) {
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

async function skillDirHasManifest(dir) {
  try {
    const stat = await fs.lstat(path.join(dir, "SKILL.md"));
    return stat.isFile();
  } catch (err) {
    if (err?.code === "ENOENT") return false;
    throw err;
  }
}

async function runtimeSkillDelivery(sourceRoot) {
  const inventoryFile = path.join(sourceRoot, "inventory.json");
  let inventoryText;
  try {
    inventoryText = await fs.readFile(inventoryFile, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { enabledSkills: null, supportDirs: [] };
    throw error;
  }
  let inventory;
  try {
    inventory = JSON.parse(inventoryText);
  } catch {
    throw new HttpError(500, "runtime_skill_inventory_invalid", "Runtime skill inventory is not valid JSON.");
  }
  const delivery = inventory?.policy?.delivery;
  if (delivery?.contractVersion !== 1 || delivery?.defaultEnabledTier !== "executable") {
    throw new HttpError(500, "runtime_skill_inventory_invalid", "Runtime skill delivery contract is missing or unsupported.");
  }
  const executable = delivery.executable;
  if (executable == null || typeof executable !== "object" || Array.isArray(executable)) {
    throw new HttpError(500, "runtime_skill_inventory_invalid", "Runtime executable skill inventory is invalid.");
  }
  const supportDirs = delivery.supportDirs ?? [];
  if (
    !Array.isArray(supportDirs) ||
    supportDirs.some((value) => typeof value !== "string" || !/^_[a-z0-9][a-z0-9-]{0,62}$/.test(value))
  ) {
    throw new HttpError(500, "runtime_skill_inventory_invalid", "Runtime skill support directories are invalid.");
  }
  return { enabledSkills: new Set(Object.keys(executable)), supportDirs: [...new Set(supportDirs)] };
}

async function copyDirNoSymlinks(src, dst) {
  const stat = await fs.lstat(src);
  if (stat.isSymbolicLink()) {
    throw new HttpError(403, "runtime_skill_symlink", "Runtime skill bundles must not contain symbolic links.");
  }
  if (!stat.isDirectory()) return;

  await fs.mkdir(dst, { recursive: true, mode: 0o700 });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new HttpError(403, "runtime_skill_symlink", "Runtime skill bundles must not contain symbolic links.");
    }
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      await copyDirNoSymlinks(from, to);
      continue;
    }
    if (!entry.isFile()) continue;
    await fs.copyFile(from, to);
    const fileStat = await fs.lstat(from);
    await fs.chmod(to, fileStat.mode & 0o777);
  }
}

const runtimePackageIdPattern = /^[a-z0-9][a-z0-9-]{1,62}$/;
const runtimeAgentIdPattern = /^evimed-[a-z0-9][a-z0-9-]{1,62}$/;
const runtimeAgentInventoryFile = ".evimed-agent-packages.json";
const runtimeSkillMarkerFile = ".evimed-package.json";

function managedAgentMarker(skill, agent) {
  return `<!-- evimed-managed-agent: ${agent}; skill: ${skill} -->`;
}

/** The delegate form of a package.
 *
 * The same capability, reachable from another agent's `task` tool instead of
 * from the router. It returns its findings as text rather than owning the
 * user's reply, and it may not delegate further: one level keeps the fan-out
 * countable, and every request a delegate makes still crosses the same metered
 * model gateway as its parent's. */
export function generatedRuntimeSubagent(manifest) {
  const tools = [...manifest.requiredTools, ...manifest.optionalTools];
  const skills = [...(manifest.companionSkills ?? []), manifest.skill];
  return `---
description: ${JSON.stringify(`EviMed ${manifest.title} (delegate): ${manifest.description}`)}
mode: subagent
permission:
  bash: allow
  edit: allow
  write: allow
---

You are handling one bounded piece of work delegated by another EviMed agent.

Load and follow every required skill below, in order:
${skills.map((skill, index) => `${index + 1}. \`${skill}\``).join("\n")}

Use only these declared EviMed research tools:
${tools.map((tool) => `- \`${tool}\``).join("\n")}

Do not delegate any part of this work further; you are the last step in the chain.

Answer the question you were given and nothing beyond it. Your reply is read by
the agent that called you, not by the user, so return the findings themselves —
the numbers, the sources, and what you could not establish. State what you were
unable to determine rather than filling the gap, because the caller cannot see
your tool results and has no way to check an inference you present as a finding.

${managedAgentMarker(manifest.skill, `${manifest.runtimeAgent}-delegate`)}
`;
}

export function generatedRuntimeAgent(manifest) {
  const description = `EviMed ${manifest.title}: ${manifest.description}`;
  const skills = [...(manifest.companionSkills ?? []), manifest.skill];
  const skillLines = skills.map((skill, index) => `${index + 1}. \`${skill}\``).join("\n");
  const tools = [...manifest.requiredTools, ...manifest.optionalTools];
  const toolLines = tools.map((tool) => `- \`${tool}\``).join("\n");
  const outputLines = manifest.outputs
    .map((output) => `- \`${output.path}\` (${output.required ? "required" : "optional"})`)
    .join("\n");
  // Writing the files is not delivering the work. Without this the reply comes
  // back as running commentary plus a table of file names, and the reader never
  // sees the report at all.
  const replyContract = manifest.outputs.length > 0
    ? `Your reply is what the reader receives. Write it in the user's language as the report's own summary:

1. Open with the conclusion — the bottom line in one to three sentences, including any action or safety implication.
2. Give the findings that carry that conclusion, with the same numbered citations the report uses, and say how strong the evidence is and what it rests on.
3. State the material uncertainty, the evidence gaps, and anything that still needs human review.
4. Close with one short list of the files you wrote.

Never open with a plan, a restatement of the question, or search narration. Never paste a tool log, a JSON artifact, a hash, or an internal marker into the reply. A list of file names is not an answer.`
    : "";
  const outputContract = manifest.outputs.length > 0
    ? `Write package outputs only to these declared workspace-relative paths:\n${outputLines}\n\nDo not call undeclared EviMed tools or write package outputs outside the declared paths.\n\n${replyContract}`
    : "This package delivers its answer directly in the assistant reply. Do not write package output files, and do not call undeclared EviMed tools.";
  return `---
description: ${JSON.stringify(description)}
mode: primary
permission:
  bash: allow
  edit: allow
  write: allow
---

Load and follow every required skill below, in order, for every turn handled by this agent:
${skillLines}

Do not claim completion if any required skill was not loaded successfully.

Use only these declared EviMed research tools:
${toolLines}

A search result large enough to be written to a tool-output file still has to be
read by you. Open it with \`read\`. Do not delegate reading retrieved evidence to
a subagent: a subagent answers in prose, so what comes back is a description of
the records rather than the records, and a quotation taken from that description
is no longer the source's wording. One run delegated six such reads, and its
quotations could not be found in the documents they were attributed to.

Delegate a question, never a document.

${outputContract}

${managedAgentMarker(manifest.skill, manifest.runtimeAgent)}
`;
}

function runtimeAgentInventoryError(message) {
  return new HttpError(500, "runtime_agent_inventory_invalid", message);
}

function validateRuntimeAgentInventory(raw) {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw runtimeAgentInventoryError("Runtime agent inventory must be an object.");
  }
  const fields = Object.keys(raw).sort();
  if (fields.length !== 2 || fields[0] !== "packages" || fields[1] !== "version" || raw.version !== 1) {
    throw runtimeAgentInventoryError("Runtime agent inventory has an unsupported schema.");
  }
  if (!Array.isArray(raw.packages) || raw.packages.length > 256) {
    throw runtimeAgentInventoryError("Runtime agent inventory packages are invalid.");
  }
  const seenSkills = new Set();
  const seenAgents = new Set();
  const packages = raw.packages.map((entry) => {
    if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
      throw runtimeAgentInventoryError("Runtime agent inventory entry must be an object.");
    }
    const entryFields = Object.keys(entry).sort();
    if (entryFields.length !== 2 || entryFields[0] !== "agent" || entryFields[1] !== "skill") {
      throw runtimeAgentInventoryError("Runtime agent inventory entry has unknown fields.");
    }
    if (!runtimePackageIdPattern.test(entry.skill) || !runtimeAgentIdPattern.test(entry.agent)) {
      throw runtimeAgentInventoryError("Runtime agent inventory contains an invalid identifier.");
    }
    if (seenSkills.has(entry.skill) || seenAgents.has(entry.agent)) {
      throw runtimeAgentInventoryError("Runtime agent inventory contains duplicate identifiers.");
    }
    seenSkills.add(entry.skill);
    seenAgents.add(entry.agent);
    return Object.freeze({ skill: entry.skill, agent: entry.agent });
  });
  return Object.freeze({ version: 1, packages: Object.freeze(packages) });
}

async function readRuntimeAgentInventory(project, opencodeRoot) {
  const file = path.join(opencodeRoot, runtimeAgentInventoryFile);
  const text = await readTextFileNoFollow(project.rootDir, file, "");
  if (!text) return Object.freeze({ version: 1, packages: Object.freeze([]) });
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw runtimeAgentInventoryError("Runtime agent inventory is not valid JSON.");
  }
  return validateRuntimeAgentInventory(parsed);
}

async function assertSourcePathNoSymlinks(sourceRoot, target) {
  const root = path.resolve(sourceRoot);
  const resolved = path.resolve(target);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new HttpError(403, "runtime_skill_path_forbidden", "Runtime skill source escapes its package directory.");
  }
  const relative = path.relative(root, resolved);
  let current = root;
  for (const part of ["", ...relative.split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) {
      throw new HttpError(403, "runtime_skill_symlink", "Runtime skill bundles must not contain symbolic links.");
    }
  }
}

async function readSourceFileNoFollow(sourceRoot, file) {
  let handle;
  try {
    await assertSourcePathNoSymlinks(sourceRoot, file);
    handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    await assertSourcePathNoSymlinks(sourceRoot, file);
    const before = await handle.stat();
    if (!before.isFile()) {
      throw new HttpError(403, "runtime_skill_invalid_file", "Runtime skill bundles may contain only regular files and directories.");
    }
    const data = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new HttpError(409, "runtime_skill_source_changed", "Runtime skill bundle changed while it was copied.");
    }
    return { data, mode: before.mode & 0o777 };
  } catch (error) {
    if (error?.code === "ELOOP") {
      throw new HttpError(403, "runtime_skill_symlink", "Runtime skill bundles must not contain symbolic links.");
    }
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function copyPackageToStaging(projectRoot, sourceRoot, source, target) {
  await assertSourcePathNoSymlinks(sourceRoot, source);
  const sourceStat = await fs.lstat(source);
  if (sourceStat.isSymbolicLink()) {
    throw new HttpError(403, "runtime_skill_symlink", "Runtime skill bundles must not contain symbolic links.");
  }
  if (!sourceStat.isDirectory()) {
    throw new HttpError(403, "runtime_skill_invalid_file", "Runtime agent packages must be directories.");
  }
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  const entries = await fs.readdir(source, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const entry of entries) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    const stat = await fs.lstat(from);
    if (entry.isSymbolicLink() || stat.isSymbolicLink()) {
      throw new HttpError(403, "runtime_skill_symlink", "Runtime skill bundles must not contain symbolic links.");
    }
    if (stat.isDirectory()) {
      await copyPackageToStaging(projectRoot, sourceRoot, from, to);
      continue;
    }
    if (!stat.isFile()) {
      throw new HttpError(403, "runtime_skill_invalid_file", "Runtime skill bundles may contain only regular files and directories.");
    }
    const copied = await readSourceFileNoFollow(sourceRoot, from);
    await writeFileAtomicNoFollow(projectRoot, to, copied.data, { mode: copied.mode });
  }
}

async function readManagedSkillMarker(project, target) {
  const markerPath = path.join(target, runtimeSkillMarkerFile);
  const text = await readTextFileNoFollow(project.rootDir, markerPath, "");
  if (!text) return null;
  try {
    const marker = JSON.parse(text);
    const fields = Object.keys(marker ?? {}).sort();
    if (
      fields.length !== 3 ||
      fields[0] !== "agent" ||
      fields[1] !== "skill" ||
      fields[2] !== "version" ||
      marker.version !== 1 ||
      !runtimePackageIdPattern.test(marker.skill) ||
      !runtimeAgentIdPattern.test(marker.agent)
    ) return null;
    return marker;
  } catch {
    return null;
  }
}

async function managedSkillMatches(project, target, entry) {
  const stat = await fs.lstat(target).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return false;
  await assertNoSymlinkPath(project.rootDir, target);
  if (!stat.isDirectory()) return false;
  const marker = await readManagedSkillMarker(project, target);
  return marker?.skill === entry.skill && marker?.agent === entry.agent;
}

/** TypeScript infers a destructured parameter as exactly the shape its
 *  defaults name, which rejects every other property a caller passes.
 *  @param {any} project
 *  @param {any} target
 *  @param {any} entry
 */
async function managedAgentMatches(project, target, entry) {
  const stat = await fs.lstat(target).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return false;
  await assertNoSymlinkPath(project.rootDir, target);
  if (!stat.isFile()) return false;
  const text = await readTextFileNoFollow(project.rootDir, target, "");
  return text.endsWith(`${managedAgentMarker(entry.skill, entry.agent)}\n`);
}

function runtimeAgentPruneOwnershipError(entry) {
  return new HttpError(
    409,
    "runtime_agent_prune_ownership_mismatch",
    `Previously managed runtime package "${entry.agent}" no longer has valid ownership markers.`,
  );
}

async function preflightManagedPrune(project, target, entry, matches) {
  const stat = await fs.lstat(target).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return null;
  let owned = false;
  try {
    owned = await matches(project, target, entry);
  } catch {
    throw runtimeAgentPruneOwnershipError(entry);
  }
  if (!owned) throw runtimeAgentPruneOwnershipError(entry);
  return target;
}

async function replaceManagedSkill(project, skillRoot, loadedPackage, manifest) {
  const target = path.join(skillRoot, manifest.skill);
  const entry = { skill: manifest.skill, agent: manifest.runtimeAgent };
  const existing = await fs.lstat(target).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (existing && !(await managedSkillMatches(project, target, entry))) {
    throw new HttpError(409, "runtime_agent_skill_collision", `Runtime skill "${manifest.skill}" is not EviMed-managed.`);
  }

  const token = randomId("pkg_").replace(/[^a-zA-Z0-9_-]/g, "");
  const staging = path.join(skillRoot, `.${manifest.skill}.staging.${token}`);
  const backup = path.join(skillRoot, `.${manifest.skill}.backup.${token}`);
  let backupCreated = false;
  let committed = false;
  try {
    await assertNoSymlinkPath(project.rootDir, staging, { allowMissingTail: true });
    await fs.mkdir(staging, { mode: 0o700 });
    await copyPackageToStaging(project.rootDir, loadedPackage.packageDir, loadedPackage.packageDir, staging);
    await writeJsonFileAtomicNoFollow(project.rootDir, path.join(staging, runtimeSkillMarkerFile), {
      version: 1,
      skill: manifest.skill,
      agent: manifest.runtimeAgent,
    });
    await assertNoSymlinkPath(project.rootDir, staging);

    if (existing) {
      await fs.rename(target, backup);
      backupCreated = true;
    }
    try {
      await fs.rename(staging, target);
      committed = true;
    } catch (error) {
      if (backupCreated) {
        await fs.rename(backup, target);
        backupCreated = false;
      }
      throw error;
    }
    await assertNoSymlinkPath(project.rootDir, target);
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    if (backupCreated) {
      if (!committed) {
        const targetExists = await fs.lstat(target).then(() => true).catch(() => false);
        if (!targetExists) {
          await fs.rename(backup, target).catch(() => {});
          backupCreated = await fs.lstat(backup).then(() => true).catch(() => false);
        }
      }
      if (committed) {
        await fs.rm(backup, { recursive: true, force: true }).catch(() => {});
      }
    }
  }
}

export async function syncRuntimeAgentPackages(project, plan, agentRegistry) {
  if (!agentRegistry || !plan.xdgConfigDir) return { skills: 0, agents: 0, delegates: 0 };
  if (typeof agentRegistry.list !== "function" || typeof agentRegistry.getPackage !== "function") {
    throw new TypeError("Runtime agent bootstrap requires a loaded AgentRegistry.");
  }

  const opencodeRoot = path.join(plan.xdgConfigDir, "opencode");
  const skillRoot = path.join(opencodeRoot, "skills");
  const agentRoot = path.join(opencodeRoot, "agents");
  await assertNoSymlinkPath(project.rootDir, skillRoot, { allowMissingTail: true });
  await assertNoSymlinkPath(project.rootDir, agentRoot, { allowMissingTail: true });
  await Promise.all([
    fs.mkdir(skillRoot, { recursive: true, mode: 0o700 }),
    fs.mkdir(agentRoot, { recursive: true, mode: 0o700 }),
  ]);
  await assertNoSymlinkPath(project.rootDir, skillRoot);
  await assertNoSymlinkPath(project.rootDir, agentRoot);

  const previousInventory = await readRuntimeAgentInventory(project, opencodeRoot);
  const currentInventory = agentRegistry.list().map((manifest) => ({
    skill: manifest.skill,
    agent: manifest.runtimeAgent,
  }));
  const currentSkills = new Set(currentInventory.map((entry) => entry.skill));
  const currentAgents = new Set(currentInventory.map((entry) => entry.agent));
  const skillsToPrune = [];
  const agentsToPrune = [];
  for (const entry of previousInventory.packages) {
    if (!currentSkills.has(entry.skill)) {
      const target = await preflightManagedPrune(
        project,
        path.join(skillRoot, entry.skill),
        entry,
        managedSkillMatches,
      );
      if (target) skillsToPrune.push(target);
    }
    if (!currentAgents.has(entry.agent)) {
      const target = await preflightManagedPrune(
        project,
        path.join(agentRoot, `${entry.agent}.md`),
        entry,
        managedAgentMatches,
      );
      if (target) agentsToPrune.push(target);
      // Its delegate goes with it; otherwise a removed package stays callable.
      const delegate = await preflightManagedPrune(
        project,
        path.join(agentRoot, `${entry.agent}-delegate.md`),
        { ...entry, agent: `${entry.agent}-delegate` },
        managedAgentMatches,
      );
      if (delegate) agentsToPrune.push(delegate);
    }
  }

  let skills = 0;
  let agents = 0;
  let delegates = 0;
  for (const manifest of agentRegistry.list()) {
    const loadedPackage = agentRegistry.getPackage(manifest.id);
    if (!loadedPackage?.packageDir) {
      throw new HttpError(500, "runtime_agent_package_missing", `Loaded package for agent "${manifest.id}" is unavailable.`);
    }

    await replaceManagedSkill(project, skillRoot, loadedPackage, manifest);
    skills += 1;

    const targetAgent = path.join(agentRoot, `${manifest.runtimeAgent}.md`);
    const targetStat = await fs.lstat(targetAgent).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (targetStat && !(await managedAgentMatches(project, targetAgent, {
      skill: manifest.skill,
      agent: manifest.runtimeAgent,
    }))) {
      throw new HttpError(409, "runtime_agent_definition_collision", `Runtime agent "${manifest.runtimeAgent}" is not EviMed-managed.`);
    }
    await writeFileAtomicNoFollow(project.rootDir, targetAgent, generatedRuntimeAgent(manifest), {
      encoding: "utf8",
      mode: 0o600,
    });
    agents += 1;

    // The same package, reachable as a delegate. Emitting it is what makes the
    // capability available to another agent's task tool at all; without it the
    // runtime has subagent support and nothing to call.
    const targetDelegate = path.join(agentRoot, `${manifest.runtimeAgent}-delegate.md`);
    const delegateStat = await fs.lstat(targetDelegate).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (delegateStat && !(await managedAgentMatches(project, targetDelegate, {
      skill: manifest.skill,
      agent: `${manifest.runtimeAgent}-delegate`,
    }))) {
      throw new HttpError(
        409,
        "runtime_agent_definition_collision",
        `Runtime agent "${manifest.runtimeAgent}-delegate" is not EviMed-managed.`,
      );
    }
    await writeFileAtomicNoFollow(project.rootDir, targetDelegate, generatedRuntimeSubagent(manifest), {
      encoding: "utf8",
      mode: 0o600,
    });
    delegates += 1;
  }

  for (const target of skillsToPrune) await fs.rm(target, { recursive: true, force: true });
  for (const target of agentsToPrune) await fs.rm(target, { force: true });

  await writeJsonFileAtomicNoFollow(project.rootDir, path.join(opencodeRoot, runtimeAgentInventoryFile), {
    version: 1,
    packages: currentInventory,
  });

  return { skills, agents, delegates };
}

const evimedMcpName = "evimed-research";
const scienceConnectors = Object.freeze([
  "paper-search",
  "biomcp",
  "materials-project",
  "fred",
  "spaceweather",
  "open-meteo",
  "usgs-water",
]);
const evimedMcpMarkerFile = ".evimed-mcp.json";
const evimedWorkloadAudience = "evimed-adapter";
const modelGatewayAudience = "evimed-model-gateway";
const modelGatewayProviderName = "deepseek";
const modelGatewayMarkerFile = ".evimed-model-provider.json";
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

async function copyMcpSourceToStaging(project, sourceDir, staging) {
  try {
    await copyPackageToStaging(project.rootDir, sourceDir, sourceDir, staging);
  } catch (error) {
    if (error?.code === "runtime_skill_symlink" || error?.code === "ELOOP") {
      throw runtimeMcpError("runtime_mcp_symlink", "EviMed MCP source must not contain symbolic links.", 403);
    }
    if (error?.code === "runtime_skill_invalid_file") {
      throw runtimeMcpError("runtime_mcp_invalid_file", "EviMed MCP source may contain only regular files and directories.", 403);
    }
    if (error?.code === "runtime_skill_source_changed") {
      throw runtimeMcpError("runtime_mcp_source_changed", "EviMed MCP source changed while it was copied.", 409);
    }
    if (error?.code === "ENOENT") {
      throw runtimeMcpError("runtime_mcp_source_missing", "EviMed MCP source directory is unavailable.");
    }
    throw error;
  }
}

async function assertManagedMcpTarget(project, target) {
  const stat = await fs.lstat(target).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return false;
  await assertNoSymlinkPath(project.rootDir, target);
  if (!stat.isDirectory()) {
    throw runtimeMcpError("runtime_mcp_collision", "Reserved EviMed MCP target is not a managed directory.", 409);
  }
  const markerText = await readTextFileNoFollow(
    project.rootDir,
    path.join(target, evimedMcpMarkerFile),
    "",
  );
  let marker;
  try {
    marker = JSON.parse(markerText);
  } catch {
    throw runtimeMcpError("runtime_mcp_collision", "Reserved EviMed MCP target has no valid ownership marker.", 409);
  }
  if (marker?.version !== 1 || marker?.service !== evimedMcpName) {
    throw runtimeMcpError("runtime_mcp_collision", "Reserved EviMed MCP target is not platform-managed.", 409);
  }
  return true;
}

function workloadTokenHostPath(plan) {
  return path.join(plan.xdgConfigDir, "opencode", evimedWorkloadTokenFileName);
}

function workloadTokenRuntimePath(plan) {
  return plan.sandboxMode === "docker"
    ? `/runtime/xdg-config/opencode/${evimedWorkloadTokenFileName}`
    : workloadTokenHostPath(plan);
}

function modelConfigRuntimePath(plan) {
  return plan.sandboxMode === "docker"
    ? "/runtime/xdg-config/opencode/opencode.json"
    : path.join(plan.xdgConfigDir, "opencode", "opencode.json");
}

function evimedMcpEnvironment(config, project, plan) {
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
    environment.EVIMED_MODEL_CONFIG_FILE = modelConfigRuntimePath(plan);
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
      environment.EVIMED_MODEL_CONFIG_FILE = modelConfigRuntimePath(plan);
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
    environment.EVIMED_MODEL_CONFIG_FILE = modelConfigRuntimePath(plan);
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
    environment.EVIMED_WORKLOAD_TOKEN_FILE = workloadTokenRuntimePath(plan);
  }
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

function readOpenCodeConfig(text) {
  if (!text) return {};
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    throw runtimeMcpError("runtime_opencode_config_invalid", "Runtime opencode.json is not valid JSON.");
  }
  if (config == null || typeof config !== "object" || Array.isArray(config)) {
    throw runtimeMcpError("runtime_opencode_config_invalid", "Runtime opencode.json must contain an object.");
  }
  if (config.mcp != null && (typeof config.mcp !== "object" || Array.isArray(config.mcp))) {
    throw runtimeMcpError("runtime_opencode_config_invalid", "Runtime opencode.json mcp field must contain an object.");
  }
  if (config.provider != null && (typeof config.provider !== "object" || Array.isArray(config.provider))) {
    throw runtimeMcpError("runtime_opencode_config_invalid", "Runtime opencode.json provider field must contain an object.");
  }
  return config;
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

/** TypeScript infers a destructured parameter as exactly the shape its
 *  defaults name, which rejects every other property a caller passes.
 *  @param {any} config
 *  @param {any} project
 *  @param {any} plan
 *  @param {Record<string, any>} options3
 */
export async function syncRuntimeModelProvider(
  config,
  project,
  plan,
  {
    nowSeconds = Math.floor(Date.now() / 1000),
    jti = randomId("mgw_"),
    writeConfig = writeJsonFileAtomicNoFollow,
  } = {},
) {
  if (!config.deepseekProviderEnabled) return { configured: 0, token: null, payload: null };
  if (!plan.xdgConfigDir) {
    throw new HttpError(500, "runtime_model_gateway_plan_invalid", "Runtime launch plan is missing its config directory.");
  }
  if (config.modelGatewaySigningSecretError) {
    throw new HttpError(500, config.modelGatewaySigningSecretError, "Model gateway signing secret could not be loaded.");
  }
  const model = String(config.deepseekModel ?? "").trim();
  if (!supportedDeepSeekModels.has(model)) {
    throw new HttpError(500, "runtime_model_gateway_model_invalid",
      `The managed DeepSeek model must be one of ${[...supportedDeepSeekModels].join(", ")}.`);
  }
  const opencodeRoot = path.join(plan.xdgConfigDir, "opencode");
  const configFile = path.join(opencodeRoot, "opencode.json");
  const markerFile = path.join(opencodeRoot, modelGatewayMarkerFile);
  await assertNoSymlinkPath(project.rootDir, opencodeRoot, { allowMissingTail: true });
  await fs.mkdir(opencodeRoot, { recursive: true, mode: 0o700 });
  await assertNoSymlinkPath(project.rootDir, opencodeRoot);
  const configStat = await fs.lstat(configFile).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  const markerStat = await fs.lstat(markerFile).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (configStat?.isSymbolicLink() || markerStat?.isSymbolicLink()) {
    throw new HttpError(409, "runtime_model_provider_collision", "Managed model provider paths must not be symbolic links.");
  }
  const existingText = configStat ? await readTextFileNoFollow(project.rootDir, configFile, "") : "";
  const existing = readOpenCodeConfig(existingText);
  const markerText = markerStat ? await readTextFileNoFollow(project.rootDir, markerFile, "") : "";
  let marker = null;
  if (markerText) {
    try {
      marker = JSON.parse(markerText);
    } catch {
      throw new HttpError(409, "runtime_model_provider_collision", "Managed model provider marker is invalid.");
    }
  }
  const reserved = existing.provider?.[modelGatewayProviderName];
  const markerOwned = marker?.version === 1 && marker?.provider === modelGatewayProviderName && marker?.model === model;
  if ((reserved != null || marker != null) && !(reserved != null && markerOwned)) {
    throw new HttpError(409, "runtime_model_provider_collision", "Reserved DeepSeek provider is not platform-managed.");
  }
  const token = issueModelGatewayRuntimeToken({
    secret: config.modelGatewaySigningSecret,
    userId: String(project.userId),
    projectId: String(project.id),
    nowSeconds,
    jti,
  });
  const payload = verifyModelGatewayRuntimeToken(token, {
    secret: config.modelGatewaySigningSecret,
    userId: String(project.userId),
    projectId: String(project.id),
    nowSeconds,
  });
  const managedProvider = {
    name: "DeepSeek",
    npm: "@ai-sdk/openai-compatible",
    options: {
      baseURL: modelGatewayProviderUrl(config),
      apiKey: token,
    },
    models: {
      // Derived from the model that is actually certified and running. Hardcoded
      // as "DeepSeek V4 Pro", this labelled every runtime with the wrong model
      // name the moment the deployment moved to Flash.
      [model]: { name: deepSeekModelDisplayName(model) },
    },
  };
  const merged = {
    ...existing,
    permission: {
      ...(existing.permission ?? {}),
      bash: "allow",
      edit: "allow",
      write: "allow",
      webfetch: plan.sandboxMode === "docker" ? "deny" : "allow",
    },
    provider: {
      ...(existing.provider ?? {}),
      [modelGatewayProviderName]: managedProvider,
    },
    model: `${modelGatewayProviderName}/${model}`,
  };
  let configWritten = false;
  try {
    await writeConfig(project.rootDir, configFile, merged);
    configWritten = true;
    await writeJsonFileAtomicNoFollow(project.rootDir, markerFile, {
      version: 1,
      provider: modelGatewayProviderName,
      model,
    });
  } catch (error) {
    if (configWritten) {
      if (configStat) {
        await writeFileAtomicNoFollow(project.rootDir, configFile, existingText, {
          encoding: "utf8",
          mode: configStat.mode & 0o777,
        }).catch(() => {});
      } else {
        await fs.rm(configFile, { force: true }).catch(() => {});
      }
    }
    throw error;
  }
  return { configured: 1, token, payload };
}

function runtimeMcpServerPath(plan, target) {
  return plan.sandboxMode === "docker"
    ? "/runtime/xdg-config/opencode/mcp/evimed-research/server.py"
    : path.join(target, "server.py");
}

function runtimeScienceConnectorPath(plan, target) {
  return plan.sandboxMode === "docker"
    ? "/runtime/xdg-config/opencode/mcp/evimed-research/science_connectors.py"
    : path.join(target, "science_connectors.py");
}

function scienceConnectorEnvironment(config, project, plan, connector) {
  const base = evimedMcpEnvironment(config, project, plan);
  return {
    OPEN_SCIENCE_CONNECTOR_ID: connector,
    ...(base.EVIMED_PUBLIC_SOURCE_GATEWAY_URL
      ? { EVIMED_PUBLIC_SOURCE_GATEWAY_URL: base.EVIMED_PUBLIC_SOURCE_GATEWAY_URL }
      : {}),
    ...(base.EVIMED_MODEL_CONFIG_FILE
      ? { EVIMED_MODEL_CONFIG_FILE: base.EVIMED_MODEL_CONFIG_FILE }
      : {}),
  };
}

function assertScienceConnectorOwnership(existing, targetExists) {
  for (const connector of scienceConnectors) {
    const name = `science-${connector}`;
    const entry = existing.mcp?.[name];
    if (entry == null) continue;
    const fields = Object.keys(entry).sort().join(",");
    const environment = entry.environment;
    const environmentFields = environment && typeof environment === "object" && !Array.isArray(environment)
      ? Object.keys(environment).sort()
      : [];
    const allowedEnvironmentFields = new Set([
      "EVIMED_MODEL_CONFIG_FILE",
      "EVIMED_PUBLIC_SOURCE_GATEWAY_URL",
      "OPEN_SCIENCE_CONNECTOR_ID",
    ]);
    const commandPath = Array.isArray(entry.command) ? entry.command[1] : "";
    if (
      !targetExists ||
      fields !== "command,enabled,environment,type" ||
      entry.type !== "local" ||
      entry.enabled !== true ||
      !Array.isArray(entry.command) ||
      entry.command.length !== 2 ||
      entry.command[0] !== "python3" ||
      typeof commandPath !== "string" ||
      !commandPath.replaceAll("\\", "/").endsWith("/opencode/mcp/evimed-research/science_connectors.py") ||
      environment.OPEN_SCIENCE_CONNECTOR_ID !== connector ||
      environmentFields.some((field) => !allowedEnvironmentFields.has(field))
    ) {
      throw runtimeMcpError("runtime_mcp_config_collision", `Reserved science connector ${name} is not platform-managed.`, 409);
    }
  }
}

function isManagedProjectWorkspace(value, project, plan) {
  if (value === String(plan.proxyWorkspaceDir)) return true;
  if (plan.sandboxMode !== "host" || typeof value !== "string" || !path.isAbsolute(value)) {
    return false;
  }
  const baseDir = path.resolve(project.baseDir ?? project.workspaceDir);
  const candidate = path.resolve(value);
  // Hosted projects switch between the workspace root and one server-created
  // direct child.  A previously managed entry may therefore legitimately
  // point at the prior active folder; sync rewrites it to the current one.
  return candidate === baseDir || path.dirname(candidate) === baseDir;
}

function detectManagedRootRelocation(storedPath, expectedPath, plan, targetExists) {
  if (
    !targetExists ||
    plan.sandboxMode !== "host" ||
    typeof storedPath !== "string" ||
    typeof expectedPath !== "string" ||
    !path.isAbsolute(storedPath) ||
    !path.isAbsolute(expectedPath) ||
    path.resolve(storedPath) === path.resolve(expectedPath) ||
    existsSync(storedPath)
  ) return null;

  const storedParts = path.resolve(storedPath).split(path.sep).filter(Boolean);
  const expectedParts = path.resolve(expectedPath).split(path.sep).filter(Boolean);
  let suffixLength = 0;
  while (
    suffixLength < storedParts.length &&
    suffixLength < expectedParts.length &&
    storedParts[storedParts.length - 1 - suffixLength] === expectedParts[expectedParts.length - 1 - suffixLength]
  ) suffixLength += 1;
  if (suffixLength < 4) return null;

  const storedPrefix = storedParts.slice(0, storedParts.length - suffixLength);
  const expectedPrefix = expectedParts.slice(0, expectedParts.length - suffixLength);
  if (!storedPrefix.length || !expectedPrefix.length) return null;
  const root = path.parse(path.resolve(storedPath)).root;
  const from = path.join(root, ...storedPrefix);
  const to = path.join(path.parse(path.resolve(expectedPath)).root, ...expectedPrefix);
  const portableName = (value) => path.basename(value).replace(/[\s_-]+/g, "").toLowerCase();
  if (!portableName(from) || portableName(from) !== portableName(to)) return null;
  return { from, to };
}

function managedPathMatches(storedPath, expectedPath, relocation) {
  if (storedPath === expectedPath) return true;
  if (
    !relocation ||
    typeof storedPath !== "string" ||
    typeof expectedPath !== "string" ||
    !path.isAbsolute(storedPath) ||
    !path.isAbsolute(expectedPath)
  ) return false;
  const relative = path.relative(relocation.from, path.resolve(storedPath));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return false;
  }
  return path.resolve(relocation.to, relative) === path.resolve(expectedPath);
}

function assertReservedMcpOwnership(existing, targetExists, config, project, plan, target) {
  const entry = existing.mcp?.[evimedMcpName];
  if (!targetExists && entry == null) return;
  if (!targetExists || entry == null || typeof entry !== "object" || Array.isArray(entry)) {
    throw runtimeMcpError(
      "runtime_mcp_config_collision",
      "Reserved EviMed MCP source and config ownership do not match.",
      409,
    );
  }
  const expectedServerPath = runtimeMcpServerPath(plan, target);
  const storedServerPath = Array.isArray(entry.command) ? entry.command[1] : "";
  const relocation = detectManagedRootRelocation(storedServerPath, expectedServerPath, plan, targetExists);
  if (
    Object.keys(entry).sort().join(",") !== "command,enabled,environment,type" ||
    entry.type !== "local" ||
    entry.enabled !== true ||
    !Array.isArray(entry.command) ||
    entry.command.length !== 2 ||
    entry.command[0] !== "python3" ||
    !managedPathMatches(entry.command[1], expectedServerPath, relocation) ||
    entry.environment == null ||
    typeof entry.environment !== "object" ||
    Array.isArray(entry.environment)
  ) {
    throw runtimeMcpError(
      "runtime_mcp_config_collision",
      "Reserved EviMed MCP config entry is not platform-managed.",
      409,
    );
  }
  const environment = entry.environment;
  const allowed = new Set([
    "OPEN_SCIENCE_TENANT_ID",
    "OPEN_SCIENCE_USER_ID",
    "OPEN_SCIENCE_PROJECT_ID",
    "OPEN_SCIENCE_WORKSPACE_DIR",
    "EVIMED_PUBLIC_SOURCE_GATEWAY_URL",
    "EVIMED_UNPAYWALL_EMAIL",
    "EVIMED_WORKLOAD_TOKEN_FILE",
    "EVIMED_META_AGENT_ROOT",
    "EVIMED_META_AGENT_PYTHON",
    "EVIMED_MODEL_CONFIG_FILE",
    "EVIMED_PHARMACY_REFERENCE_DB",
    ...Object.values(evimedSpecialistEnvironment).flatMap((specialist) => [specialist.root, specialist.python]),
    ...Object.values(evimedAdapterEnvironment),
  ]);
  if (
    Object.keys(environment).some((key) => !allowed.has(key)) ||
    (environment.OPEN_SCIENCE_TENANT_ID != null &&
      environment.OPEN_SCIENCE_TENANT_ID !== String(project.tenantId ?? project.userId)) ||
    environment.OPEN_SCIENCE_USER_ID !== String(project.userId) ||
    environment.OPEN_SCIENCE_PROJECT_ID !== String(project.id) ||
    !(
      isManagedProjectWorkspace(environment.OPEN_SCIENCE_WORKSPACE_DIR, project, plan) ||
      managedPathMatches(environment.OPEN_SCIENCE_WORKSPACE_DIR, String(plan.proxyWorkspaceDir), relocation)
    )
  ) {
    throw runtimeMcpError(
      "runtime_mcp_config_collision",
      "Reserved EviMed MCP environment is not bound to this project.",
      409,
    );
  }
  for (const envName of Object.values(evimedAdapterEnvironment)) {
    if (!(envName in environment)) continue;
    let url;
    try {
      url = new URL(environment[envName]);
    } catch {
      throw runtimeMcpError("runtime_mcp_config_collision", "Reserved EviMed MCP adapter URL is invalid.", 409);
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw runtimeMcpError("runtime_mcp_config_collision", "Reserved EviMed MCP adapter URL is invalid.", 409);
    }
  }
  if (
    environment.EVIMED_PHARMACY_REFERENCE_DB != null &&
    !managedPathMatches(
      environment.EVIMED_PHARMACY_REFERENCE_DB,
      String(config.pharmacyReferenceDb ?? ""),
      relocation,
    )
  ) {
    throw runtimeMcpError("runtime_mcp_config_collision", "Reserved pharmacy reference database is invalid.", 409);
  }
  if (
    environment.EVIMED_META_AGENT_ROOT != null &&
    !managedPathMatches(environment.EVIMED_META_AGENT_ROOT, String(config.metaAgentRoot ?? ""), relocation)
  ) {
    throw runtimeMcpError("runtime_mcp_config_collision", "Reserved MetaAgent root is invalid.", 409);
  }
  if (
    environment.EVIMED_META_AGENT_PYTHON != null &&
    !managedPathMatches(environment.EVIMED_META_AGENT_PYTHON, String(config.metaAgentPython ?? ""), relocation)
  ) {
    throw runtimeMcpError("runtime_mcp_config_collision", "Reserved MetaAgent Python is invalid.", 409);
  }
  for (const [key, names] of Object.entries(evimedSpecialistEnvironment)) {
    const specialist = config.specialistAgents?.[key] ?? {};
    if (
      environment[names.root] != null &&
      !managedPathMatches(environment[names.root], String(specialist.root ?? ""), relocation)
    ) {
      throw runtimeMcpError("runtime_mcp_config_collision", `Reserved ${key} root is invalid.`, 409);
    }
    if (
      environment[names.python] != null &&
      !managedPathMatches(environment[names.python], String(specialist.python ?? ""), relocation)
    ) {
      throw runtimeMcpError("runtime_mcp_config_collision", `Reserved ${key} Python is invalid.`, 409);
    }
  }
  if (
    environment.EVIMED_MODEL_CONFIG_FILE != null &&
    !managedPathMatches(environment.EVIMED_MODEL_CONFIG_FILE, modelConfigRuntimePath(plan), relocation)
  ) {
    throw runtimeMcpError("runtime_mcp_config_collision", "Reserved model configuration path is invalid.", 409);
  }
  const signingSecret = String(config.evimedWorkloadSigningSecret ?? "");
  if (signingSecret) {
    if (
      environment.EVIMED_WORKLOAD_TOKEN_FILE != null &&
      !managedPathMatches(environment.EVIMED_WORKLOAD_TOKEN_FILE, workloadTokenRuntimePath(plan), relocation)
    ) {
      throw runtimeMcpError("runtime_mcp_config_collision", "Reserved EviMed MCP token file is invalid.", 409);
    }
  } else if (environment.EVIMED_WORKLOAD_TOKEN_FILE != null) {
    if (!managedPathMatches(environment.EVIMED_WORKLOAD_TOKEN_FILE, workloadTokenRuntimePath(plan), relocation)) {
      throw runtimeMcpError("runtime_mcp_config_collision", "Reserved EviMed MCP token file is invalid.", 409);
    }
  }
}

export async function syncRuntimeEviMedMcp(
  config,
  project,
  plan,
  { writeConfig = writeJsonFileAtomicNoFollow } = {},
) {
  const sourceDir = String(config.evimedMcpSourceDir ?? bundledEviMedMcpDir).trim();
  if (!sourceDir) {
    throw runtimeMcpError("runtime_mcp_source_missing", "EviMed MCP source directory is not configured.");
  }
  if (!plan.xdgConfigDir || !plan.proxyWorkspaceDir) {
    throw runtimeMcpError("runtime_mcp_plan_invalid", "Runtime launch plan is missing MCP bootstrap paths.");
  }

  const opencodeRoot = path.join(plan.xdgConfigDir, "opencode");
  const mcpRoot = path.join(opencodeRoot, "mcp");
  const target = path.join(mcpRoot, evimedMcpName);
  const configFile = path.join(opencodeRoot, "opencode.json");
  const workloadTokenFile = workloadTokenHostPath(plan);
  const configStat = await fs.lstat(configFile).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (configStat?.isSymbolicLink()) {
    throw runtimeMcpError("runtime_opencode_config_invalid", "Runtime opencode.json must not be a symbolic link.");
  }
  const existingText = configStat
    ? await readTextFileNoFollow(project.rootDir, configFile, "")
    : "";
  const existing = readOpenCodeConfig(existingText);
  const workloadTokenStat = await fs.lstat(workloadTokenFile).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (
    workloadTokenStat?.isSymbolicLink() ||
    (
      workloadTokenStat &&
      (
        !workloadTokenStat.isFile() ||
        workloadTokenStat.size > 8 * 1024 ||
        (workloadTokenStat.mode & 0o077) !== 0
      )
    )
  ) {
    throw runtimeMcpError(
      "runtime_mcp_workload_token_file_invalid",
      "Managed EviMed workload token path must be a regular file.",
      409,
    );
  }
  const existingWorkloadToken = workloadTokenStat
    ? await readTextFileNoFollow(project.rootDir, workloadTokenFile, "")
    : "";
  const targetExists = await assertManagedMcpTarget(project, target);
  assertReservedMcpOwnership(existing, targetExists, config, project, plan, target);
  assertScienceConnectorOwnership(existing, targetExists);
  const managedEntry = {
    type: "local",
    command: ["python3", runtimeMcpServerPath(plan, target)],
    enabled: true,
    environment: evimedMcpEnvironment(config, project, plan),
  };
  const scienceEntries = Object.fromEntries(scienceConnectors.map((connector) => [
    `science-${connector}`,
    {
      type: "local",
      command: ["python3", runtimeScienceConnectorPath(plan, target)],
      enabled: true,
      environment: scienceConnectorEnvironment(config, project, plan, connector),
    },
  ]));
  const merged = {
    ...existing,
    mcp: {
      ...(existing.mcp ?? {}),
      [evimedMcpName]: managedEntry,
      ...scienceEntries,
    },
  };

  for (const sourceName of ["server.py", "science_connectors.py", "public_sources.py"]) {
    const sourceFile = path.join(sourceDir, sourceName);
    let sourceFileStat;
    try {
      await assertSourcePathNoSymlinks(sourceDir, sourceFile);
      sourceFileStat = await fs.lstat(sourceFile);
    } catch (error) {
      if (error?.code === "runtime_skill_symlink") {
        throw runtimeMcpError("runtime_mcp_symlink", "EviMed MCP source must not contain symbolic links.", 403);
      }
      if (error?.code === "ENOENT") {
        throw runtimeMcpError("runtime_mcp_source_missing", `EviMed MCP ${sourceName} is unavailable.`);
      }
      throw error;
    }
    if (!sourceFileStat.isFile() || sourceFileStat.isSymbolicLink()) {
      throw runtimeMcpError("runtime_mcp_invalid_file", `EviMed MCP ${sourceName} must be a regular file.`, 403);
    }
  }

  await assertNoSymlinkPath(project.rootDir, mcpRoot, { allowMissingTail: true });
  await fs.mkdir(mcpRoot, { recursive: true, mode: 0o700 });
  await assertNoSymlinkPath(project.rootDir, mcpRoot);

  const token = randomId("mcp_").replace(/[^a-zA-Z0-9_-]/g, "");
  const staging = path.join(mcpRoot, `.${evimedMcpName}.staging.${token}`);
  const backup = path.join(mcpRoot, `.${evimedMcpName}.backup.${token}`);
  let backupCreated = false;
  let sourceCommitted = false;
  let configCommitted = false;
  let workloadTokenWritten = false;
  try {
    await assertNoSymlinkPath(project.rootDir, staging, { allowMissingTail: true });
    await fs.mkdir(staging, { mode: 0o700 });
    await copyMcpSourceToStaging(project, sourceDir, staging);
    await writeJsonFileAtomicNoFollow(project.rootDir, path.join(staging, evimedMcpMarkerFile), {
      version: 1,
      service: evimedMcpName,
    });
    if (config.evimedWorkloadSigningSecret) {
      await refreshEviMedWorkloadToken(config, project, workloadTokenFile);
      workloadTokenWritten = true;
    }
    if (targetExists) {
      await fs.rename(target, backup);
      backupCreated = true;
    }
    try {
      await fs.rename(staging, target);
      sourceCommitted = true;
    } catch (error) {
      if (backupCreated) {
        await fs.rename(backup, target);
        backupCreated = false;
      }
      throw error;
    }
    await assertNoSymlinkPath(project.rootDir, target);
    await writeConfig(project.rootDir, configFile, merged);
    configCommitted = true;
    if (backupCreated) {
      await fs.rm(backup, { recursive: true, force: true });
      backupCreated = false;
    }
  } catch (error) {
    if (sourceCommitted) await fs.rm(target, { recursive: true, force: true }).catch(() => {});
    if (backupCreated) {
      await fs.rename(backup, target).catch(() => {});
      backupCreated = false;
    }
    if (!configCommitted) {
      if (configStat) {
        await writeFileAtomicNoFollow(project.rootDir, configFile, existingText, {
          encoding: "utf8",
          mode: configStat.mode & 0o777,
        }).catch(() => {});
      } else {
        await assertNoSymlinkPath(project.rootDir, configFile, { allowMissingTail: true }).catch(() => {});
        await fs.rm(configFile, { force: true }).catch(() => {});
      }
    }
    if (workloadTokenWritten) {
      if (workloadTokenStat) {
        await writeFileAtomicNoFollow(project.rootDir, workloadTokenFile, existingWorkloadToken, {
          encoding: "utf8",
          mode: workloadTokenStat.mode & 0o777,
        }).catch(() => {});
      } else {
        await assertNoSymlinkPath(project.rootDir, workloadTokenFile, { allowMissingTail: true }).catch(() => {});
        await fs.rm(workloadTokenFile, { force: true }).catch(() => {});
      }
    }
    throw error;
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    if (backupCreated) await fs.rename(backup, target).catch(() => {});
  }
  return {
    copied: 1,
    configured: 1 + scienceConnectors.length,
    workloadTokenFile: config.evimedWorkloadSigningSecret ? workloadTokenFile : null,
    workloadTokenRefreshMs: config.evimedWorkloadSigningSecret
      ? evimedWorkloadRefreshIntervalMs(config)
      : null,
  };
}

export async function syncRuntimeSkills(config, project, plan) {
  const skillDirs = Array.isArray(config.runtimeSkillDirs) ? config.runtimeSkillDirs : [];
  if (!skillDirs.length || !plan.xdgConfigDir) return { copied: 0, skipped: 0 };

  const dstRoot = path.join(plan.xdgConfigDir, "opencode", "skills");
  await assertNoSymlinkPath(project.rootDir, dstRoot, { allowMissingTail: true });
  await fs.mkdir(dstRoot, { recursive: true, mode: 0o700 });
  await assertNoSymlinkPath(project.rootDir, dstRoot);

  let copied = 0;
  let skipped = 0;
  for (const sourceRoot of skillDirs) {
    const { enabledSkills, supportDirs } = await runtimeSkillDelivery(sourceRoot);
    let entries;
    try {
      entries = await fs.readdir(sourceRoot, { withFileTypes: true });
    } catch (err) {
      if (err?.code === "ENOENT") {
        skipped += 1;
        continue;
      }
      throw err;
    }

    for (const supportName of supportDirs) {
      const sourceSupport = path.join(sourceRoot, supportName);
      const targetSupport = path.join(dstRoot, supportName);
      await assertNoSymlinkPath(project.rootDir, targetSupport, { allowMissingTail: true });
      await fs.rm(targetSupport, { recursive: true, force: true });
      await copyDirNoSymlinks(sourceSupport, targetSupport);
      await assertNoSymlinkPath(project.rootDir, targetSupport);
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        skipped += 1;
        continue;
      }
      if (supportDirs.includes(entry.name)) continue;
      const sourceSkill = path.join(sourceRoot, entry.name);
      if (!(await skillDirHasManifest(sourceSkill))) {
        skipped += 1;
        continue;
      }
      const targetSkill = path.join(dstRoot, entry.name);
      if (enabledSkills && !enabledSkills.has(entry.name)) {
        await assertNoSymlinkPath(project.rootDir, targetSkill, { allowMissingTail: true });
        await fs.rm(targetSkill, { recursive: true, force: true });
        skipped += 1;
        continue;
      }
      await assertNoSymlinkPath(project.rootDir, targetSkill, { allowMissingTail: true });
      await fs.rm(targetSkill, { recursive: true, force: true });
      await copyDirNoSymlinks(sourceSkill, targetSkill);
      await assertNoSymlinkPath(project.rootDir, targetSkill);
      copied += 1;
    }
  }

  return { copied, skipped };
}

export function buildOpenCodeLaunchPlan(config, project, port, password) {
  const sandboxMode = config.runtimeSandboxMode;
  const commonEnv = {
    OPENCODE_SERVER_PASSWORD: password,
  };
  if (sandboxMode === "docker") {
    const transport = String(config.runtimeTransport ?? "unix").trim().toLowerCase();
    if (transport !== "unix" && transport !== "tcp") {
      throw new HttpError(400, "invalid_runtime_transport", "Unsupported runtime transport.");
    }
    if (config.runtimeDataVolume && transport !== "unix") {
      throw new HttpError(
        500,
        "runtime_transport_volume_mismatch",
        "Docker volume-backed runtimes require the Unix socket transport.",
      );
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
    const isolatedControlMount = transport === "unix" && Boolean(config.runtimeDataVolume);
    const controlDir = isolatedControlMount
      ? path.join(
          config.dataDir,
          ".runtime-sockets",
          createHash("sha256")
            .update(`${project.userId}\0${project.id}`, "utf8")
            .digest("hex")
            .slice(0, 24),
        )
      : (transport === "unix" ? path.join(runtimeRoot, "control") : null);
    const socketPath = transport === "unix" ? path.join(controlDir, "opencode.sock") : null;
    const containerName = runtimeContainerName(project);
    return {
      sandboxMode,
      containerName,
      command: config.runtimeContainerBin,
      args: [
        "run",
        "--rm",
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
        ...(transport === "tcp" ? ["--publish", `127.0.0.1:${port}:${port}`] : []),
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
        `OPENCODE_SERVER_PASSWORD=${password}`,
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
        ...(transport === "unix"
          ? [
              "--env",
              `OPEN_SCIENCE_RUNTIME_PORT=${port}`,
              "--env",
              `OPEN_SCIENCE_RUNTIME_SOCKET=${isolatedControlMount ? "/runtime-control" : "/runtime/control"}/opencode.sock`,
              config.runtimeContainerImage,
              "open-science-opencode-serve",
            ]
          : [
              config.runtimeContainerImage,
              "opencode",
              "serve",
              "--hostname",
              "0.0.0.0",
              "--port",
              String(port),
            ]),
      ],
      cwd: project.workspaceDir,
      env: process.env,
      proxyWorkspaceDir: "/workspace",
      runtimeUrl: transport === "unix" ? "http://opencode.runtime" : `http://127.0.0.1:${port}`,
      socketPath,
      socketTrustRoot: isolatedControlMount ? config.dataDir : project.rootDir,
      xdgConfigDir,
      runtimeDirs: [
        runtimeRoot,
        ...(transport === "unix" ? [controlDir] : []),
        xdgConfigDir,
        path.join(runtimeRoot, "xdg-data"),
        path.join(runtimeRoot, "xdg-cache"),
        path.join(runtimeRoot, "xdg-state"),
        path.join(runtimeRoot, "home"),
      ],
    };
  }

  if (sandboxMode !== "host") {
    throw new HttpError(400, "invalid_runtime_sandbox", "Unsupported runtime sandbox mode.");
  }
  // Production refuses the host runtime whatever the opt-in says, matching the
  // kernel guard in commands.mjs. A host runtime is handed the server's own
  // environment below, so the opt-in would surrender the workspace boundary and
  // the upstream API key together.
  if (config.production || !config.allowUnsandboxedRuntime) {
    throw new HttpError(
      403,
      "runtime_sandbox_required",
      "Real OpenCode runtime requires OPEN_SCIENCE_RUNTIME_SANDBOX_MODE=docker or explicit unsandboxed opt-in.",
    );
  }
  const cfg = path.join(project.runtimeDir, "xdg-config");
  const data = path.join(project.runtimeDir, "xdg-data");
  const cache = path.join(project.runtimeDir, "xdg-cache");
  const state = path.join(project.runtimeDir, "xdg-state");
  return {
    sandboxMode,
    command: config.opencodeBin,
    args: ["serve", "--hostname", "127.0.0.1", "--port", String(port)],
    cwd: project.workspaceDir,
    env: {
      ...process.env,
      ...commonEnv,
      XDG_CONFIG_HOME: cfg,
      XDG_DATA_HOME: data,
      XDG_CACHE_HOME: cache,
      XDG_STATE_HOME: state,
    },
    proxyWorkspaceDir: project.workspaceDir,
    xdgConfigDir: cfg,
    runtimeDirs: [cfg, data, cache, state],
  };
}

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

  async cleanupHostRuntime(plan, previousState) {
    return cleanupHostRuntimeProcess(plan, previousState);
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
      if (this.config.runtimeMode === "opencode" && (this.config.opencodeBin || this.config.runtimeSandboxMode === "docker")) {
        const runtime = await this.startOpenCode(project);
        this.runtimes.set(key, runtime);
        this.scheduleEviMedWorkloadRefresh(project, runtime);
        this.scheduleIdleStop(project);
        this.scheduleQuotaMonitor(project);
        return runtime;
      }

      if (this.config.production && !this.config.allowMockRuntime) {
        throw new HttpError(503, "runtime_mock_forbidden", "Mock runtime is not allowed in production mode.");
      }

      const mock = await startMockOpenCodeRuntime();
      const runtime = {
        kind: "mock",
        url: mock.url,
        close: mock.close,
        password: null,
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
      return await started;
    } finally {
      this.starts.delete(key);
    }
  }

  async startOpenCode(project) {
    const key = this.key(project);
    const port = await freePort();
    const password = randomId("pw_");
    if (this.config.runtimeSandboxMode === "docker") {
      await this.assertDockerSupport();
    }
    const plan = buildOpenCodeLaunchPlan(this.config, project, port, password);
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
    const previousState = await readRuntimeState(project);
    if (plan.sandboxMode === "host") {
      const cleanup = await this.cleanupHostRuntime(plan, previousState);
      if (cleanup.cleaned) {
        await appendRuntimeEvent(project, "cleaned_orphan", {
          kind: "opencode",
          sandboxMode: plan.sandboxMode,
          pid: cleanup.pid,
        }, this.config);
      } else if (cleanup.failed) {
        await appendRuntimeEvent(project, "cleanup_failed", {
          kind: "opencode",
          sandboxMode: plan.sandboxMode,
          pid: cleanup.pid ?? previousState?.pid ?? null,
          reason: cleanup.reason,
          error: cleanup.error,
        }, this.config);
        await recordRuntimeState(project, "failed", {
          running: false,
          kind: "opencode",
          startedAt: previousState?.startedAt ?? null,
          pid: cleanup.pid ?? previousState?.pid ?? null,
          exitedAt: null,
          sandboxMode: plan.sandboxMode,
          networkMode: this.config.runtimeNetworkMode,
          containerName: null,
          skillsCopied: 0,
          agentSkillsCopied: 0,
          agentsGenerated: 0,
          error: "runtime_cleanup_failed",
        });
        throw new HttpError(502, "runtime_cleanup_failed", "Host runtime cleanup could not be confirmed before startup.");
      }
    }
    if (plan.sandboxMode === "docker") {
      const cleanup = await this.cleanupDocker(plan, project);
      if (cleanup.cleaned) {
        await appendRuntimeEvent(project, "cleaned_orphan", {
          kind: "opencode",
          sandboxMode: plan.sandboxMode,
          containerName: plan.containerName,
        }, this.config);
      } else if (cleanup.failed) {
        await appendRuntimeEvent(project, "cleanup_failed", {
          kind: "opencode",
          sandboxMode: plan.sandboxMode,
          containerName: plan.containerName,
          error: cleanup.error,
        }, this.config);
        await recordRuntimeState(project, "failed", {
          running: false,
          kind: "opencode",
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

    let skillSync = { copied: 0, skipped: 0 };
    let agentPackageSync = { skills: 0, agents: 0 };
    let mcpSync = {
      copied: 0,
      configured: 0,
      workloadTokenFile: null,
      workloadTokenRefreshMs: null,
    };
    let modelGatewaySync = { configured: 0, token: null, payload: null };
    try {
      skillSync = await syncRuntimeSkills(this.config, project, plan);
      const loadedAgentRegistry = this.agentRegistry ? await this.agentRegistry : null;
      agentPackageSync = await syncRuntimeAgentPackages(project, plan, loadedAgentRegistry);
      mcpSync = await syncRuntimeEviMedMcp(this.config, project, plan);
      modelGatewaySync = await syncRuntimeModelProvider(this.config, project, plan);
    } catch (error) {
      await appendRuntimeEvent(project, "bootstrap_failed", {
        kind: "opencode",
        sandboxMode: plan.sandboxMode,
        networkMode: this.config.runtimeNetworkMode,
        containerName: plan.containerName ?? null,
        error: error?.code ?? "runtime_bootstrap_failed",
      }, this.config);
      await recordRuntimeState(project, "failed", {
        running: false,
        kind: "opencode",
        startedAt: null,
        pid: null,
        exitedAt: null,
        sandboxMode: plan.sandboxMode,
        networkMode: this.config.runtimeNetworkMode,
        containerName: plan.containerName ?? null,
        skillsCopied: skillSync.copied,
        agentSkillsCopied: agentPackageSync.skills,
        agentsGenerated: agentPackageSync.agents,
        mcpServersCopied: mcpSync.copied,
        mcpServersConfigured: mcpSync.configured,
        error: "runtime_bootstrap_failed",
      });
      throw new HttpError(500, "runtime_bootstrap_failed", "Runtime configuration bootstrap failed before startup.");
    }
    await appendRuntimeEvent(project, "starting", {
      kind: "opencode",
      sandboxMode: plan.sandboxMode,
      networkMode: this.config.runtimeNetworkMode,
      cpuLimit: this.config.runtimeCpuLimit,
      memoryLimit: this.config.runtimeMemoryLimit,
      containerName: plan.containerName ?? null,
      skillsCopied: skillSync.copied,
      agentSkillsCopied: agentPackageSync.skills,
      agentsGenerated: agentPackageSync.agents,
      mcpServersCopied: mcpSync.copied,
      mcpServersConfigured: mcpSync.configured,
    }, this.config);
    await recordRuntimeState(project, "starting", {
      running: false,
      kind: "opencode",
      startedAt: null,
      pid: null,
      exitedAt: null,
      sandboxMode: plan.sandboxMode,
      networkMode: this.config.runtimeNetworkMode,
      containerName: plan.containerName ?? null,
      skillsCopied: skillSync.copied,
      agentSkillsCopied: agentPackageSync.skills,
      agentsGenerated: agentPackageSync.agents,
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
        stdio: "ignore",
        env: plan.env,
      });
    }
    const runtime = {
      kind: "opencode",
      url: plan.runtimeUrl ?? `http://127.0.0.1:${port}`,
      socketPath: plan.socketPath ?? null,
      password,
      sandboxMode: plan.sandboxMode,
      networkMode: this.config.runtimeNetworkMode,
      workspaceDir: project.workspaceDir,
      proxyWorkspaceDir: plan.proxyWorkspaceDir ?? project.workspaceDir,
      child,
      startedAt: new Date().toISOString(),
      pid: child.pid,
      containerName: plan.containerName ?? null,
      skillsCopied: skillSync.copied,
      agentSkillsCopied: agentPackageSync.skills,
      agentsGenerated: agentPackageSync.agents,
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
    /** @type {any} */ (child).once("exit", () => {
      runtime.exitedAt = new Date().toISOString();
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
      }, this.config);
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
    const timeoutMs = this.config.runtimeProxyConnectTimeoutMs;
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
        const headers = runtime.password ? { authorization: basicAuth(runtime.password) } : {};
        const res = await requestRuntime(runtime, `${runtime.url}/config`, {
          headers,
          signal: probeController.signal,
        });
        const status = res.status;
        await res.body?.cancel().catch(() => {});
        if (status < 500) return;
        lastError = new Error(`runtime returned HTTP ${status}`);
      } catch (err) {
        lastError = err;
      } finally {
        clearTimeout(probeTimer);
      }
      if (runtime.child?.exitCode != null || runtime.child?.signalCode != null) {
        throw new HttpError(502, "runtime_exited", "Runtime exited before it became ready.");
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

  async sessionMessages(project, sessionId, { wake = true } = {}) {
    const runtime = wake
      ? await this.start(project)
      : this.runtimes.get(this.key(project));
    if (!runtime) {
      throw new HttpError(409, "runtime_not_running", "Runtime is not running for session history monitoring.");
    }
    try {
      this.beginProxy(project);
    } catch (error) {
      throw new HttpError(error?.status ?? 429, "runtime_history_unavailable", "Runtime session history is unavailable.");
    }
    try {
      const target = new URL(`${runtime.url}/session/${encodeURIComponent(sessionId)}/message`);
      target.searchParams.set("directory", runtime.proxyWorkspaceDir ?? project.workspaceDir);
      const headers = runtime.password ? { authorization: basicAuth(runtime.password) } : {};
      const response = await requestRuntime(runtime, target, { headers });
      if (response.status !== 200) {
        // The runtime said why and this discarded it, so every cause — an
        // unknown session, a workspace the runtime does not have, a rejected
        // password — arrived as the same sentence with nothing to act on.
        let detail = "";
        try {
          detail = (await readRuntimeResponseBody(response.body, 2_048)).toString("utf8").replace(/\s+/g, " ").slice(0, 300);
        } catch {
          await response.body?.cancel().catch(() => {});
        }
        throw new HttpError(
          502,
          "runtime_history_unavailable",
          `Runtime session history is unavailable (runtime answered HTTP ${response.status}${detail ? `: ${detail}` : ""}).`,
        );
      }
      const payload = await readRuntimeResponseBody(response.body, this.config.maxJsonBytes);
      let value;
      try {
        value = JSON.parse(payload.toString("utf8"));
      } catch {
        throw new HttpError(502, "runtime_history_invalid", "Runtime session history is invalid.");
      }
      if (!Array.isArray(value)) throw new HttpError(502, "runtime_history_invalid", "Runtime session history is invalid.");
      return value;
    } finally {
      this.endProxy(project);
    }
  }

  async sessionStatus(project, sessionId, { wake = true } = {}) {
    const runtime = wake
      ? await this.start(project)
      : this.runtimes.get(this.key(project));
    if (!runtime) {
      throw new HttpError(409, "runtime_not_running", "Runtime is not running for session status monitoring.");
    }
    try {
      this.beginProxy(project);
    } catch (error) {
      throw new HttpError(error?.status ?? 429, "runtime_status_unavailable", "Runtime session status is unavailable.");
    }
    try {
      const target = new URL(`${runtime.url}/session/status`);
      target.searchParams.set("directory", runtime.proxyWorkspaceDir ?? project.workspaceDir);
      const headers = runtime.password ? { authorization: basicAuth(runtime.password) } : {};
      const response = await requestRuntime(runtime, target, { headers });
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => {});
        throw new HttpError(502, "runtime_status_unavailable", "Runtime session status is unavailable.");
      }
      const payload = await readRuntimeResponseBody(response.body, this.config.maxJsonBytes);
      let value;
      try {
        value = JSON.parse(payload.toString("utf8"));
      } catch {
        throw new HttpError(502, "runtime_status_invalid", "Runtime session status is invalid.");
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new HttpError(502, "runtime_status_invalid", "Runtime session status is invalid.");
      }
      if (!Object.hasOwn(value, sessionId)) return "idle";
      const status = value[sessionId];
      if (!status || typeof status !== "object" || Array.isArray(status)) {
        throw new HttpError(502, "runtime_status_invalid", "Runtime session status is invalid.");
      }
      if (!["idle", "busy", "retry"].includes(status.type)) {
        throw new HttpError(502, "runtime_status_invalid", "Runtime session status is invalid.");
      }
      return status.type;
    } finally {
      this.endProxy(project);
    }
  }

  /** @param {Record<string, any>} project @param {string} sessionId
   *  @param {Record<string, any>} options */
  async dispatchPrompt(project, sessionId, { text, system = null, agent = null, model = null } = {}) {
    const runtime = this.runtimes.get(this.key(project));
    if (!runtime) {
      const error = new HttpError(409, "runtime_prompt_rejected", "Runtime was not available to accept the prompt.");
      error.definitivelyRejected = true;
      throw error;
    }
    const modelParts = typeof model === "string" ? model.split("/") : [];
    const payload = {
      parts: [{ type: "text", text }],
      ...(typeof system === "string" && system.trim() ? { system } : {}),
      ...(agent ? { agent } : {}),
      ...(modelParts.length === 2 && modelParts.every(Boolean)
        ? { model: { providerID: modelParts[0], modelID: modelParts[1] } }
        : {}),
    };
    const target = new URL(`${runtime.url}/session/${encodeURIComponent(sessionId)}/prompt_async`);
    target.searchParams.set("directory", runtime.proxyWorkspaceDir ?? project.workspaceDir);
    const headers = {
      "content-type": "application/json",
      ...(runtime.password ? { authorization: basicAuth(runtime.password) } : {}),
    };
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    try {
      await this.enforceProjectQuota(project);
      this.beginProxy(project);
    } catch (error) {
      error.definitivelyRejected = true;
      throw error;
    }
    const startedAt = Date.now();
    let status = 502;
    let errorCode = null;
    let response;
    try {
      const controller = new AbortController();
      const timeoutMs = positiveLimit(this.config.runtimeProxyRequestTimeoutMs)
        ?? positiveLimit(this.config.runtimeProxyConnectTimeoutMs);
      const timer = timeoutMs == null ? null : setTimeout(() => controller.abort(), timeoutMs);
      try {
        response = await requestRuntime(runtime, target, {
          method: "POST",
          headers,
          body,
          signal: controller.signal,
        });
      } catch {
        errorCode = "runtime_prompt_acceptance_unknown";
        throw new HttpError(502, errorCode, "Runtime prompt acceptance could not be confirmed.");
      } finally {
        if (timer) clearTimeout(timer);
      }
      status = response.status;
      if (response.status < 200 || response.status >= 300) {
        await response.body?.cancel().catch(() => {});
        const error = new HttpError(502, "runtime_prompt_rejected", "Runtime rejected the prompt before accepting it.");
        error.definitivelyRejected = true;
        errorCode = error.code;
        throw error;
      }
      await readRuntimeResponseBody(response.body, this.config.maxJsonBytes).catch(async () => {
        await response.body?.cancel().catch(() => {});
      });
      await this.stopRuntimeIfProjectQuotaExceeded(project).catch(() => {});
      return { accepted: true };
    } finally {
      this.endProxy(project);
      await appendRuntimeEvent(project, "proxy", {
        method: "POST",
        target: `/session/${sessionId}/prompt_async`,
        status,
        durationMs: Date.now() - startedAt,
        requestBytes: body.length,
        responseBytes: 0,
        streaming: false,
        error: errorCode,
      }, this.config).catch(() => {});
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

  async cleanupOrphanedRuntimes(projects, { includeHost = true } = {}) {
    const summary = {
      scanned: 0,
      skipped: 0,
      cleaned: 0,
      missing: 0,
      failed: 0,
    };
    if (this.config.runtimeMode !== "opencode") {
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
            kind: state.kind ?? "opencode",
            sandboxMode: "docker",
            networkMode: state.networkMode ?? this.config.runtimeNetworkMode,
            containerName: state.containerName,
            result: cleanup.reason,
          }, this.config);
          await recordRuntimeState(project, "orphan_cleanup", {
            running: false,
            kind: state.kind ?? "opencode",
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
          kind: state.kind ?? "opencode",
          sandboxMode: "docker",
          networkMode: state.networkMode ?? this.config.runtimeNetworkMode,
          containerName: state.containerName,
          error: cleanup.error,
        }, this.config);
        await recordRuntimeState(project, "failed", {
          running: false,
          kind: state.kind ?? "opencode",
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

      if (includeHost && state.sandboxMode === "host") {
        const cleanup = await cleanupHostRuntimeProcess({
          sandboxMode: "host",
          command: this.config.opencodeBin,
        }, state);
        if (cleanup.cleaned) {
          summary.cleaned += 1;
          await appendRuntimeEvent(project, "startup_orphan_cleanup", {
            kind: state.kind ?? "opencode",
            sandboxMode: "host",
            pid: cleanup.pid,
            result: "removed",
          }, this.config);
          await recordRuntimeState(project, "orphan_cleanup", {
            running: false,
            kind: state.kind ?? "opencode",
            startedAt: state.startedAt ?? null,
            pid: cleanup.pid,
            exitedAt: new Date().toISOString(),
            sandboxMode: "host",
            networkMode: state.networkMode ?? null,
            containerName: null,
            skillsCopied: state.skillsCopied,
          });
        } else {
          summary.skipped += 1;
        }
        continue;
      }

      summary.skipped += 1;
    }

    this.lastOrphanCleanup = { ...summary, completedAt: new Date().toISOString() };
    return summary;
  }

  async proxy(req, res, project, suffix) {
    const startedAt = Date.now();
    const method = req.method ?? "GET";
    const target = proxyAuditTarget(suffix);
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
      this.enforceProxyAllowlist(req, suffix);
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
        if (key !== "directory" && key !== "auth_token") upstream.searchParams.append(key, value);
      }
      upstream.searchParams.set("directory", runtime.proxyWorkspaceDir ?? project.workspaceDir);

      const headers = {};
      for (const [key, value] of Object.entries(req.headers)) {
        const lower = key.toLowerCase();
        if (isHopByHopHeader(lower)) continue;
        if (Array.isArray(value)) headers[key] = value.join(", ");
        else if (value != null) headers[key] = value;
      }
      if (runtime.password) {
        headers.authorization = basicAuth(runtime.password);
      }
      headers["accept-encoding"] = "identity";

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

  async checkRuntimeQuota(project, monitor) {
    const key = this.key(project);
    if (this.runtimeQuotaMonitors.get(key) !== monitor || !this.runtimes.has(key)) return;
    try {
      await assertProjectUsageWithinQuota(project, this.config);
    } catch (err) {
      if (this.runtimeQuotaMonitors.get(key) !== monitor || !this.runtimes.has(key)) return;
      if (err instanceof HttpError && err.code === "project_quota_exceeded") {
        await this.stopQuotaExceededRuntime(project, { recordMissing: false });
        return;
      }
      const error = err instanceof HttpError ? err.code : "runtime_quota_check_failed";
      await this.stopQuotaGuardRuntime(project, "quota_check_failed", error);
    }
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
