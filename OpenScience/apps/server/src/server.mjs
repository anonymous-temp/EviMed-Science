import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { createGzip } from "node:zlib";
import { loadAgentRegistry } from "./agentRegistry.mjs";
import { AgentRunStore } from "./agentRuns.mjs";
import { ResearchSessionStore } from "./researchSessions.mjs";
import { prepareResearchContext } from "./researchContext.mjs";
import { routeOpenDomainSpecialist } from "./specialistRouting.mjs";
import { BUNDLED_EXAMPLES, createCommandRegistry } from "./commands.mjs";
import { loadConfig } from "./config.mjs";
import { assertDockerVolumeName } from "./dockerMounts.mjs";
import { createModelGatewayHandler, MODEL_GATEWAY_PATH } from "./modelGateway.mjs";
import {
  createPublicSourceGatewayHandler,
  PUBLIC_SOURCE_GATEWAY_PATH,
} from "./publicSourceGateway.mjs";
import { MemosClient } from "./memosClient.mjs";
import { MemoryIntelligence } from "./memoryIntelligence.mjs";
import { OidcService, validateOidcSettings } from "./oidc.mjs";
import { runtimeReleasePolicyError } from "./releaseManifest.mjs";
import {
  RuntimeManager,
  runtimeNetworkRequiresEgressOptIn,
  runtimeNetworkUsesHostOrContainer,
  validateEviMedAdapterConfig,
} from "./runtimeManager.mjs";
import { createStore } from "./store.mjs";
import { readinessSaasProfile } from "./saasProfile.mjs";
import { TaskManager } from "./taskManager.mjs";
import { readDeepSeekReleaseReceiptFile } from "../../../scripts/ops/deepseek-opencode-release-gate.mjs";
import {
  HttpError,
  apiBaseFromRequest,
  appendJsonLineNoFollow,
  assertNoSymlinkPath,
  assertObject,
  assertProjectCapacity,
  assertString,
  clearSessionCookie,
  directorySize,
  mimeFor,
  normalizeRoot,
  normalizeWorkspaceRelativePath,
  openScopedDirectoryNoFollow,
  openScopedFileNoFollow,
  randomId,
  readJson,
  readJsonWithSize,
  resolveScopedPath,
  sendError,
  sendJson,
  withProjectStorageMutation,
  writeFileAtomicNoFollow,
} from "./security.mjs";

function originFor(value) {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function isLocalDevelopmentOrigin(origin) {
  try {
    const url = new URL(origin);
    return ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

function isAllowedCorsOrigin(origin, config) {
  if (config.corsOrigins.includes(origin)) return true;
  const publicOrigin = originFor(config.publicUrl);
  if (publicOrigin && publicOrigin === origin) return true;
  return !config.production && isLocalDevelopmentOrigin(origin);
}

function applyCors(req, res, config) {
  const origin = req.headers.origin;
  if (!origin) return;
  if (isAllowedCorsOrigin(origin, config)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-Open-Science-Project, X-Open-Science-CSRF",
    );
    res.setHeader("Access-Control-Expose-Headers", "X-Open-Science-Request-Id");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  }
}

function applySecurityHeaders(res, config) {
  if (!config.securityHeaders) return;
  const connectSrc = config.production
    ? "connect-src 'self'"
    : "connect-src 'self' http://127.0.0.1:* http://localhost:* ws: wss:";
  const publicOrigin = originFor(config.publicUrl);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  if (publicOrigin?.startsWith("https://")) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000");
  }
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      connectSrc,
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "font-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self' 'unsafe-eval'",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
  );
}

function routePath(req) {
  return new URL(req.url ?? "/", "http://open-science.local").pathname;
}

function decodeRouteComponent(value, label) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, "invalid_encoding", `${label} contains invalid percent encoding.`);
  }
}

function decodeTail(pathname, prefix, label = "path") {
  const tail = pathname.slice(prefix.length).replace(/^\/+/, "");
  return decodeRouteComponent(tail, label);
}

function requestIdFor(req) {
  const header = req.headers["x-request-id"];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value)) return value;
  return randomId("req_");
}

function routePattern(pathname) {
  if (pathname === "/api/health" || pathname === "/api/ready" || pathname === "/api/me") return pathname;
  if (pathname === "/api/account" || pathname === "/api/account/export") return pathname;
  if (pathname === "/api/ops/metrics") return pathname;
  if (pathname.startsWith("/api/auth/oidc/")) return "/api/auth/oidc/:action";
  if (
    pathname === "/api/auth/login" ||
    pathname === "/api/auth/logout" ||
    pathname === "/api/auth/dev-login" ||
    pathname === "/api/auth/methods"
  ) return pathname;
  if (pathname === "/api/projects" || pathname === "/api/tasks" || pathname === "/api/commands") return pathname;
  if (pathname.startsWith("/api/projects/")) {
    return pathname.endsWith("/export") ? "/api/projects/:projectId/export" : "/api/projects/:projectId";
  }
  if (pathname.startsWith("/api/commands/")) return "/api/commands/:command";
  if (pathname.startsWith("/api/tasks/")) return "/api/tasks/:taskId";
  if (pathname.startsWith("/api/logs/")) return "/api/logs/:kind";
  if (pathname.startsWith("/api/memory/memos/")) return "/api/memory/memos/:memoId";
  if (pathname.startsWith("/api/memory/")) return "/api/memory/:route";
  if (pathname.startsWith("/api/opencode/")) return "/api/opencode/:projectId/*";
  if (pathname.startsWith("/api/files/preview/")) return "/api/files/preview/:path";
  if (pathname.startsWith("/api/files/download/")) return "/api/files/download/:path";
  if (pathname === "/api/files/upload") return pathname;
  if (pathname.startsWith("/api/")) return "/api/:route";
  return pathname === "/" ? "/" : "/static";
}

function uploadJsonLimit(config) {
  return Math.max(config.maxJsonBytes, Math.ceil(config.maxFileBytes * 1.4) + 8192);
}

function commandJsonLimit(config, command) {
  return command === "upload_file" ? uploadJsonLimit(config) : config.maxJsonBytes;
}

const runtimeLifecycleCommands = new Map([
  ["start_runtime", "start"],
  ["stop_runtime", "stop"],
  ["restart_runtime", "restart"],
]);

class FixedWindowRateLimiter {
  constructor() {
    this.buckets = new Map();
  }

  check(key, { max, windowMs, code = "rate_limited", label = "requests" }) {
    if (!Number.isFinite(max) || max <= 0 || !Number.isFinite(windowMs) || windowMs <= 0) return;
    const now = Date.now();
    const current = this.buckets.get(key);
    const bucket = !current || current.resetAt <= now ? { count: 0, resetAt: now + windowMs } : current;
    bucket.count += 1;
    this.buckets.set(key, bucket);
    if (bucket.count > max) {
      throw new HttpError(429, code, `Too many ${label}.`, {
        retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1000),
      });
    }
    if (this.buckets.size > 10_000) this.prune(now);
  }

  prune(now = Date.now()) {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}

const httpDurationBuckets = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120];
const knownHttpMethods = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

function metricHttpMethod(value) {
  const method = String(value ?? "").toUpperCase();
  return knownHttpMethods.has(method) ? method : "OTHER";
}

function metricErrorCode(value) {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : "unknown_error";
}

class OperationalMetrics {
  constructor() {
    this.activeRequests = 0;
    this.requests = new Map();
    this.errors = new Map();
    this.durations = new Map();
  }

  start(req, pathname) {
    this.activeRequests += 1;
    return {
      method: metricHttpMethod(req.method),
      route: routePattern(pathname),
      startedAt: process.hrtime.bigint(),
    };
  }

  finish(operation, { statusCode, errorCode = null }) {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    const status = Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599 ? statusCode : 499;
    const statusClass = `${Math.floor(status / 100)}xx`;
    const labels = {
      method: operation.method,
      route: operation.route,
      status_code: String(status),
      status_class: statusClass,
    };
    const requestKey = JSON.stringify(labels);
    const request = this.requests.get(requestKey) ?? { labels, value: 0 };
    request.value += 1;
    this.requests.set(requestKey, request);

    const duration = Number(process.hrtime.bigint() - operation.startedAt) / 1_000_000_000;
    const durationLabels = { method: operation.method, route: operation.route };
    const durationKey = JSON.stringify(durationLabels);
    const series = this.durations.get(durationKey) ?? {
      labels: durationLabels,
      count: 0,
      sum: 0,
      buckets: httpDurationBuckets.map(() => 0),
    };
    series.count += 1;
    series.sum += duration;
    for (let index = 0; index < httpDurationBuckets.length; index++) {
      if (duration <= httpDurationBuckets[index]) series.buckets[index] += 1;
    }
    this.durations.set(durationKey, series);

    if (errorCode) {
      const errorLabels = { route: operation.route, code: metricErrorCode(errorCode) };
      const errorKey = JSON.stringify(errorLabels);
      const error = this.errors.get(errorKey) ?? { labels: errorLabels, value: 0 };
      error.value += 1;
      this.errors.set(errorKey, error);
    }
  }

  snapshot() {
    return {
      activeRequests: this.activeRequests,
      requests: [...this.requests.values()],
      errors: [...this.errors.values()],
      durations: [...this.durations.values()],
    };
  }
}

function normalizeClientAddress(value) {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (!candidate || candidate.length > 64 || isIP(candidate) === 0) return null;
  return candidate.toLowerCase();
}

function clientAddress(req, config) {
  const direct = normalizeClientAddress(req.socket.remoteAddress) ?? "unknown";
  if (config.trustProxy) {
    const forwarded = req.headers["x-forwarded-for"];
    const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const first = normalizeClientAddress(value?.split(",")[0]);
    if (first) return first;
  }
  return direct;
}

export function createWebApiApp(overrides = {}) {
  const config = loadConfig(overrides);
  const agentRegistry = loadAgentRegistry({ packageDirs: config.agentPackageDirs });
  const store = createStore(config, { databasePool: overrides.databasePool });
  const researchSessions = new ResearchSessionStore(agentRegistry, { stateStore: store });
  const oidcService = new OidcService(config, store);
  const memosClient = new MemosClient(config, { fetchImpl: overrides.memosFetch ?? globalThis.fetch });
  const memoryIntelligence = new MemoryIntelligence(config, memosClient, {
    fetchImpl: overrides.memoryExtractionFetch ?? globalThis.fetch,
  });
  let agentRuns;
  const runtimeManager = new RuntimeManager(config, {
    agentRegistry,
    onRuntimeStop: (project, status) => agentRuns?.closeProject(project, status),
    onSessionAbort: (project, sessionId) => agentRuns?.cancelSession(project, sessionId),
  });
  agentRuns = new AgentRunStore(researchSessions, {
    agentRegistry,
    model: `deepseek/${config.deepseekModel}`,
    readSessionHistory: (project, sessionId, options) => runtimeManager.sessionMessages(project, sessionId, options),
    readSessionStatus: (project, sessionId, options) => runtimeManager.sessionStatus(project, sessionId, options),
    runtimeWorkspaceRoot: (project) => runtimeManager.runtimeWorkspaceRoot(project),
    onRunFinished: async (project, run) => {
      if (!memosClient.configured) {
        if (config.requireMemos) {
          const error = new Error("Required Memos run recording is unavailable.");
          error.code = "memory_required_unavailable";
          throw error;
        }
        return;
      }
      let messages = [];
      try {
        messages = await runtimeManager.sessionMessages(project, run.sessionId, { wake: false });
      } catch { /* a structured run summary remains durable even if runtime history is unavailable */ }
      const memoryResult = await memoryIntelligence.recordRun(project, run, messages);
      securityAudit(config, "memory.agent_run.record", "completed", {
        userId: project.userId,
        projectId: project.id,
        runId: run.id,
        runStatus: run.status,
        extracted: memoryResult.extracted,
        activated: memoryResult.activated,
        extractionSource: memoryResult.source,
      }).catch(() => {});
    },
    onRunFinishedError: async (error, project, run) => {
      await securityAudit(config, "memory.agent_run.record", "failed", {
        userId: project.userId,
        projectId: project.id,
        runId: run.id,
        runStatus: run.status,
        code: typeof error?.code === "string" ? error.code : "memory_unavailable",
      });
    },
  });
  const modelGatewayHandler = createModelGatewayHandler(config, runtimeManager);
  const publicSourceGatewayHandler = createPublicSourceGatewayHandler(config, runtimeManager, {
    fetchImpl: overrides.publicSourceFetch ?? globalThis.fetch,
  });
  const commands = createCommandRegistry({ config, runtimeManager });
  const taskManager = new TaskManager(config, (command, args, ctx) => commands.invoke(command, args, ctx));
  const rateLimiter = new FixedWindowRateLimiter();
  const authRateLimiter = new FixedWindowRateLimiter();
  const commandRateLimiter = new FixedWindowRateLimiter();
  const operationalMetrics = new OperationalMetrics();
  let activeCommands = 0;
  let startupRuntimeCleanup = null;

  async function context(req, res) {
    const user = await store.ensureUser(req, res);
    const project = await store.selectedProject(req, user);
    const tenant = { id: user.tenantId ?? user.id, model: "individual-account", role: "owner" };
    return { config, store, runtimeManager, commands, req, res, user, tenant, project };
  }

  async function handle(req, res) {
    const requestId = requestIdFor(req);
    const pathname = routePath(req);
    const operation = operationalMetrics.start(req, pathname);
    let operationErrorCode = null;
    let operationFinished = false;
    const finishOperation = (disconnected = false) => {
      if (operationFinished) return;
      operationFinished = true;
      operationalMetrics.finish(operation, {
        statusCode: disconnected && !res.headersSent ? 499 : res.statusCode,
        errorCode: operationErrorCode,
      });
    };
    res.once("finish", () => finishOperation(false));
    res.once("close", () => finishOperation(true));
    res.setHeader("X-Open-Science-Request-Id", requestId);
    applySecurityHeaders(res, config);
    applyCors(req, res, config);
    if (pathname === MODEL_GATEWAY_PATH) {
      await modelGatewayHandler(req, res);
      return;
    }
    if (pathname === PUBLIC_SOURCE_GATEWAY_PATH) {
      await publicSourceGatewayHandler(req, res);
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    try {
      enforceRequestRateLimits(req, pathname);
      await store.assertCsrf(req, pathname);

      if (pathname === "/api/health") {
        sendJson(res, 200, {
          data: {
            ok: true,
            runtimeMode: config.runtimeMode,
            runtimeControlPlane: config.runtimeControllerMode,
            releaseId: config.releaseManifest?.app.releaseId ?? null,
          },
        });
        return;
      }

      if (pathname === "/api/ready") {
        const readiness = await readinessStatus(config, store, runtimeManager, memosClient);
        sendJson(res, readiness.ok ? 200 : 503, { data: readiness });
        return;
      }

      if (pathname === "/api/ops/metrics" && (req.method === "GET" || req.method === "HEAD")) {
        await sendOperatorMetrics(req, res, {
          config,
          store,
          taskManager,
          runtimeManager,
          memosClient,
          operationalMetrics,
          activeCommands,
        });
        return;
      }

      if (pathname === "/api/auth/methods" && req.method === "GET") {
        sendJson(res, 200, { data: oidcService.methods() });
        return;
      }

      if (pathname === "/api/auth/oidc/start" && req.method === "GET") {
        try {
          await oidcService.start(req, res);
          await securityAudit(config, "auth.oidc.start", "completed", {});
        } catch (err) {
          await securityAudit(config, "auth.oidc.start", "failed", {
            code: err instanceof HttpError ? err.code : "internal_error",
          });
          throw err;
        }
        return;
      }

      if (pathname === "/api/auth/oidc/callback" && req.method === "GET") {
        try {
          const user = await oidcService.callback(req, res);
          await securityAudit(config, "auth.oidc.callback", "completed", { userId: user.id });
        } catch (err) {
          await securityAudit(config, "auth.oidc.callback", "failed", {
            code: err instanceof HttpError ? err.code : "internal_error",
          });
          throw err;
        }
        return;
      }

      if (pathname === "/api/auth/login" && req.method === "POST") {
        if (config.authMode !== "local") {
          throw new HttpError(404, "auth_method_disabled", "Local password authentication is disabled.");
        }
        let username = "";
        try {
          const body = await readJson(req, config.maxJsonBytes);
          username = assertString(body.username, "username", { max: 64 });
          const password = assertString(body.password, "password", { max: 4096 });
          const login = await store.login(username, password, req, res);
          await securityAudit(config, "auth.login", "completed", { username });
          sendJson(res, 200, { data: login });
        } catch (err) {
          await securityAudit(config, "auth.login", "failed", {
            username,
            code: err instanceof HttpError ? err.code : "internal_error",
          });
          throw err;
        }
        return;
      }

      if (pathname === "/api/auth/logout" && req.method === "POST") {
        const { user } = await store.ensureSessionUser(req, res);
        await store.logout(req);
        clearSessionCookie(res, config.sessionCookieName);
        await securityAudit(config, "auth.logout", "completed", { userId: user.id });
        sendJson(res, 200, { data: true });
        return;
      }

      if (pathname === "/api/auth/dev-login" && req.method === "POST") {
        if (config.authMode !== "development") {
          throw new HttpError(404, "auth_method_disabled", "Development authentication is disabled.");
        }
        const ctx = await context(req, res);
        sendJson(res, 200, { data: { user: { id: ctx.user.id, name: ctx.user.name } } });
        return;
      }

      if (pathname === "/api/me" && req.method === "GET") {
        const { user, session } = await store.ensureSessionUser(req, res);
        const project = await store.selectedProject(req, user);
        sendJson(res, 200, {
          data: {
            user: store.publicUser(user),
            tenant: { id: user.tenantId ?? user.id, model: "individual-account", role: "owner" },
            project: { id: project.id, name: project.name },
            projects: await store.listProjects(user),
            csrfToken: session.csrfToken,
          },
        });
        return;
      }

      if (pathname === "/api/agents" && req.method === "GET") {
        await store.ensureUser(req, res);
        sendJson(res, 200, { data: (await agentRegistry).list() });
        return;
      }

      if (pathname === "/api/memory/status" && req.method === "GET") {
        await store.ensureUser(req, res);
        sendJson(res, 200, { data: await memosClient.status() });
        return;
      }

      if (pathname === "/api/memory/memos" && req.method === "GET") {
        const ctx = await context(req, res);
        const url = new URL(req.url ?? "/", apiBaseFromRequest(req, config));
        const state = url.searchParams.get("state") === "archived" ? "archived" : "normal";
        sendJson(res, 200, { data: await memosClient.list(ctx.user.id, { state }) });
        return;
      }

      if (pathname === "/api/memory/memos" && req.method === "POST") {
        const ctx = await context(req, res);
        const body = assertObject(await readJson(req, config.maxJsonBytes), "research memory");
        const unknown = Object.keys(body).filter((field) => field !== "content");
        if (unknown.length > 0) {
          throw new HttpError(400, "memory_payload_invalid", `Unknown memory field(s): ${unknown.sort().join(", ")}.`);
        }
        const content = assertString(body.content, "content", { max: Math.min(config.maxJsonBytes, 100_000) }).trim();
        if (!content) throw new HttpError(400, "memory_content_empty", "Memory content must not be empty.");
        const memo = await memosClient.create(ctx.user.id, content);
        await audit(ctx, "memory.create", "completed", { target: memo.id });
        sendJson(res, 201, { data: memo });
        return;
      }

      if (pathname.startsWith("/api/memory/memos/")) {
        const rawMemoId = pathname.slice("/api/memory/memos/".length);
        if (!rawMemoId || rawMemoId.includes("/")) throw new HttpError(404, "not_found", "Route not found.");
        const memoId = decodeRouteComponent(rawMemoId, "memo id");
        const ctx = await context(req, res);
        if (req.method === "PATCH") {
          const body = assertObject(await readJson(req, config.maxJsonBytes), "research memory update");
          const unknown = Object.keys(body).filter((field) => !["content", "pinned", "state"].includes(field));
          if (unknown.length > 0) {
            throw new HttpError(400, "memory_payload_invalid", `Unknown memory field(s): ${unknown.sort().join(", ")}.`);
          }
          const update = {};
          if (Object.hasOwn(body, "content")) {
            const content = assertString(body.content, "content", { max: Math.min(config.maxJsonBytes, 100_000) }).trim();
            if (!content) throw new HttpError(400, "memory_content_empty", "Memory content must not be empty.");
            update.content = content;
          }
          if (Object.hasOwn(body, "pinned")) {
            if (typeof body.pinned !== "boolean") throw new HttpError(400, "memory_pinned_invalid", "pinned must be a boolean.");
            update.pinned = body.pinned;
          }
          if (Object.hasOwn(body, "state")) {
            if (!["normal", "archived"].includes(body.state)) {
              throw new HttpError(400, "memory_state_invalid", "state must be normal or archived.");
            }
            update.state = body.state;
          }
          const memo = await memosClient.update(ctx.user.id, memoId, update);
          await audit(ctx, "memory.update", "completed", { target: memo.id });
          sendJson(res, 200, { data: memo });
          return;
        }
        if (req.method === "DELETE") {
          await memosClient.delete(ctx.user.id, memoId);
          await audit(ctx, "memory.delete", "completed", { target: memoId });
          sendJson(res, 200, { data: true });
          return;
        }
      }

      if (pathname === "/api/memory/records" && req.method === "GET") {
        const ctx = await context(req, res);
        const url = new URL(req.url ?? "/", apiBaseFromRequest(req, config));
        const allowedScopes = new Set(["user", "project", "session", "organization"]);
        const allowedKinds = new Set([
          "profile", "preference", "behavior", "project_fact", "analysis",
          "decision", "correction", "follow_up", "run_summary",
        ]);
        const allowedStatuses = new Set(["active", "pending", "superseded", "archived"]);
        const readFilters = (name, allowed) => url.searchParams.getAll(name)
          .flatMap((value) => value.split(","))
          .map((value) => value.trim())
          .filter((value) => allowed.has(value));
        const records = await memosClient.listRecords(ctx.user.id, {
          scopes: readFilters("scope", allowedScopes),
          kinds: readFilters("kind", allowedKinds),
          statuses: readFilters("status", allowedStatuses),
          scopeId: url.searchParams.get("scopeId") ?? "",
          query: url.searchParams.get("query") ?? "",
          pageSize: Number(url.searchParams.get("pageSize") ?? 100),
        });
        sendJson(res, 200, { data: records });
        return;
      }

      if (pathname === "/api/memory/profile" && req.method === "GET") {
        const ctx = await context(req, res);
        sendJson(res, 200, { data: await memosClient.profile(ctx.user.id, { projectId: ctx.project.id }) });
        return;
      }

      if (pathname.startsWith("/api/memory/records/")) {
        const rawRecordId = pathname.slice("/api/memory/records/".length);
        if (!rawRecordId || rawRecordId.includes("/")) throw new HttpError(404, "not_found", "Route not found.");
        const recordId = decodeRouteComponent(rawRecordId, "structured memory id");
        const ctx = await context(req, res);
        if (req.method === "PATCH") {
          const body = assertObject(await readJson(req, config.maxJsonBytes), "structured memory update");
          const allowed = new Set(["value", "summary", "status", "importance", "sensitive", "expectedVersion"]);
          const unknown = Object.keys(body).filter((field) => !allowed.has(field));
          if (unknown.length > 0) {
            throw new HttpError(400, "memory_payload_invalid", `Unknown memory field(s): ${unknown.sort().join(", ")}.`);
          }
          const existing = await memosClient.getRecord(ctx.user.id, recordId);
          const expectedVersion = Number(body.expectedVersion);
          if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
            throw new HttpError(400, "memory_version_invalid", "expectedVersion must be a positive integer.");
          }
          if (expectedVersion !== existing.version) {
            throw new HttpError(409, "memory_conflict", "Structured memory changed before this update was applied.");
          }
          const next = { ...existing };
          if (Object.hasOwn(body, "value")) {
            next.value = assertString(body.value, "value", { max: 100_000 }).trim();
            if (!next.value) throw new HttpError(400, "memory_content_empty", "Structured memory value must not be empty.");
          }
          if (Object.hasOwn(body, "summary")) next.summary = assertString(body.summary, "summary", { max: 2_000 }).trim();
          if (Object.hasOwn(body, "status")) {
            if (!["active", "pending", "superseded", "archived"].includes(body.status)) {
              throw new HttpError(400, "memory_status_invalid", "status is invalid.");
            }
            next.status = body.status;
          }
          if (Object.hasOwn(body, "importance")) {
            const importance = Number(body.importance);
            if (!Number.isFinite(importance) || importance < 0 || importance > 1) {
              throw new HttpError(400, "memory_importance_invalid", "importance must be between zero and one.");
            }
            next.importance = importance;
          }
          if (Object.hasOwn(body, "sensitive")) {
            if (typeof body.sensitive !== "boolean") {
              throw new HttpError(400, "memory_sensitive_invalid", "sensitive must be a boolean.");
            }
            next.sensitive = body.sensitive;
          }
          const acceptedInference = existing.status === "pending" && next.status === "active";
          next.origin = acceptedInference ? "explicit" : "manual";
          next.confidence = acceptedInference ? 1 : next.confidence;
          next.lastConfirmedAt = new Date().toISOString();
          const updated = await memosClient.upsertRecord(ctx.user.id, next, null, {
            expectedVersion,
            reason: acceptedInference ? "user confirmed a pending memory" : "user updated structured memory",
          });
          await audit(ctx, "memory.record.update", "completed", { target: updated.id, version: updated.version });
          sendJson(res, 200, { data: updated });
          return;
        }
        if (req.method === "DELETE") {
          await memosClient.deleteRecord(ctx.user.id, recordId);
          await audit(ctx, "memory.record.delete", "completed", { target: recordId });
          sendJson(res, 200, { data: true });
          return;
        }
      }

      if (pathname === "/api/research-sessions" && req.method === "GET") {
        const ctx = await context(req, res);
        sendJson(res, 200, { data: await researchSessions.list(ctx.project) });
        return;
      }

      if (pathname.startsWith("/api/research-sessions/") && req.method === "PUT") {
        const rawSessionId = pathname.slice("/api/research-sessions/".length);
        if (!rawSessionId || rawSessionId.includes("/")) {
          throw new HttpError(404, "not_found", "Route not found.");
        }
        const sessionId = decodeRouteComponent(rawSessionId, "research session id");
        const ctx = await context(req, res);
        const body = await readJson(req, config.maxJsonBytes);
        sendJson(res, 200, { data: await researchSessions.put(ctx.project, sessionId, body) });
        return;
      }

      if (pathname === "/api/agent-runs" && req.method === "GET") {
        const ctx = await context(req, res);
        sendJson(res, 200, { data: await agentRuns.recover(ctx.project) });
        return;
      }

      if (pathname === "/api/agent-runs/dispatch" && req.method === "POST") {
        const ctx = await context(req, res);
        const body = assertObject(await readJson(req, config.maxJsonBytes), "agent run dispatch");
        const unknown = Object.keys(body).filter((field) => !["sessionId", "dispatchId", "text"].includes(field));
        if (unknown.length > 0) {
          throw new HttpError(400, "invalid_agent_run", `Unknown agent run field(s): ${unknown.sort().join(", ")}.`);
        }
        const text = assertString(body.text, "text", { max: config.maxJsonBytes });
        if (!text.trim()) throw new HttpError(400, "invalid_payload", "text must not be empty.");
        if (config.runtimeMode === "opencode" && !config.deepseekProviderEnabled) {
          throw new HttpError(
            503,
            "model_provider_not_configured",
            "DeepSeek V4 Pro is not configured on this EviMed server.",
          );
        }
        const registry = await agentRegistry;
        const boundSession = await researchSessions.get(ctx.project, body.sessionId);
        const routedSpecialist = boundSession?.mode === "open-domain"
          ? routeOpenDomainSpecialist(text, registry.list())
          : null;
        const run = await agentRuns.dispatch(ctx.project, {
          sessionId: body.sessionId,
          dispatchId: body.dispatchId,
          effectiveAgentId: routedSpecialist?.agentId ?? null,
          effectiveAgentVersion: routedSpecialist?.agentVersion ?? null,
          effectiveRuntimeAgent: routedSpecialist?.runtimeAgent ?? null,
        }, async (session, _run, repairText = null) => {
          const promptText = typeof repairText === "string" && repairText.trim() ? repairText : text;
          let memories = [];
          let memoryError = null;
          if (config.requireMemos && !memosClient.configured) {
            const error = new HttpError(503, "memory_required_unavailable", "Required research memory is not configured.");
            error.definitivelyRejected = true;
            throw error;
          }
          try {
            memories = await memosClient.relevant(ctx.user.id, text, {
              projectId: ctx.project.id,
              sessionId: session.sessionId,
            });
          } catch (error) {
            memoryError = error instanceof HttpError ? error.code : "memory_unavailable";
            if (config.requireMemos) {
              if (error instanceof HttpError) {
                error.definitivelyRejected = true;
                throw error;
              }
              const unavailable = new HttpError(503, memoryError, "Required research memory is unavailable.");
              unavailable.definitivelyRejected = true;
              throw unavailable;
            }
          }
          const prepared = await prepareResearchContext(ctx.project, session, config, {
            query: text,
            memories,
            memoryError,
            specialists: session.mode === "open-domain" ? registry.list() : [],
            routedSpecialist,
          });
          return runtimeManager.dispatchPrompt(ctx.project, session.sessionId, {
            text: promptText,
            system: prepared.system,
            agent: routedSpecialist?.runtimeAgent ?? session.runtimeAgent,
            model: `deepseek/${config.deepseekModel}`,
          });
        });
        sendJson(res, 202, { data: run });
        return;
      }

      if (pathname === "/api/account/export" && req.method === "GET") {
        const user = await store.ensureUser(req, res);
        const projects = await store.listProjects(user);
        if (config.requireMemos && !memosClient.configured) {
          throw new HttpError(503, "memory_required_unavailable", "Required research memory is unavailable for account export.");
        }
        const memory = memosClient.configured ? await memosClient.exportUserMemory(user.id) : null;
        const entries = appendMemoryArchiveEntry(
          await collectUserArchiveEntries(user, projects, config),
          memory,
          config,
        );
        await securityAudit(config, "account.export", "completed", { userId: user.id });
        await sendUserArchive(res, user, entries);
        return;
      }

      if (pathname === "/api/account" && req.method === "DELETE") {
        const user = await store.ensureUser(req, res);
        const body = await readJson(req, config.maxJsonBytes);
        const confirm = assertString(body.confirm, "confirm", { max: 64 });
        if (confirm !== user.id) {
          throw new HttpError(400, "account_delete_confirmation_required", "Account deletion requires an exact user id confirmation.");
        }
        if (user.passwordHash) {
          const password = assertString(body.password, "password", { max: 4096 });
          if (!store.verifyUserPassword(user, password)) {
            throw new HttpError(403, "invalid_password", "Current password is required to delete this account.");
          }
        }

        const listedProjects = await store.listProjects(user);
        const projects = [];
        for (const item of listedProjects) projects.push(await store.requireProject(user, item.id));
        for (const project of projects) {
          if (await taskManager.hasActiveProject(project)) {
            throw new HttpError(409, "account_busy", "Account has queued or running tasks.");
          }
        }
        await Promise.all(projects.map((project) => runtimeManager.stop(project)));
        if (config.requireMemos && !memosClient.configured) {
          throw new HttpError(503, "memory_required_unavailable", "Required research memory is unavailable for account deletion.");
        }
        const memoryPurge = memosClient.configured
          ? await memosClient.purgeUserMemory(user.id)
          : { structured: 0, manual: 0 };
        await securityAudit(config, "account.delete", "completed", { userId: user.id, memoryPurge });
        const data = await store.deleteUser(user);
        taskManager.purgeUser(user);
        clearSessionCookie(res, config.sessionCookieName);
        sendJson(res, 200, { data });
        return;
      }

      if (pathname === "/api/projects" && req.method === "GET") {
        const user = await store.ensureUser(req, res);
        sendJson(res, 200, { data: await store.listProjects(user) });
        return;
      }

      if (pathname === "/api/projects" && req.method === "POST") {
        const user = await store.ensureUser(req, res);
        const body = await readJson(req, config.maxJsonBytes);
        const id = assertString(body.id, "id", { max: 64 });
        const name = assertString(body.name ?? id, "name", { max: 128 });
        const data = await store.createProject(user, id, name);
        const project = await store.requireProject(user, id);
        await audit({ config, user, project }, "project.create", "completed", { target: id });
        sendJson(res, 200, { data });
        return;
      }

      if (pathname.startsWith("/api/projects/")) {
        const [rawProjectId, action, ...extra] = pathname.slice("/api/projects/".length).split("/");
        if (!rawProjectId || extra.length > 0) throw new HttpError(404, "not_found", "Route not found.");
        const projectId = decodeRouteComponent(rawProjectId, "project id");
        if (action === "export" && req.method === "GET") {
          const user = await store.ensureUser(req, res);
          const project = await store.requireProject(user, projectId);
          await audit({ config, user, project }, "project.export", "completed", { target: project.id });
          const entries = await collectProjectArchiveEntries(project, config);
          await sendProjectArchive(res, project, entries);
          return;
        }
        if (!action && req.method === "DELETE") {
          const user = await store.ensureUser(req, res);
          const body = await readJson(req, config.maxJsonBytes);
          if (projectId === "default") {
            throw new HttpError(400, "default_project_protected", "The default project cannot be deleted.");
          }
          const confirm = assertString(body.confirm, "confirm", { max: 64 });
          if (confirm !== projectId) {
            throw new HttpError(400, "delete_confirmation_required", "Project deletion requires an exact project id confirmation.");
          }
          const project = await store.requireProject(user, projectId);
          if (await taskManager.hasActiveProject(project)) {
            throw new HttpError(409, "project_busy", "Project has queued or running tasks.");
          }
          await runtimeManager.stop(project);
          await audit({ config, user, project }, "project.delete", "completed", { target: project.id });
          if (memosClient.configured) await memosClient.deleteProjectMemory(user.id, project.id);
          const data = await store.deleteProject(user, projectId);
          taskManager.purgeProject(project);
          sendJson(res, 200, { data });
          return;
        }
      }

      if (pathname.startsWith("/api/commands/") && req.method === "POST") {
        const command = decodeRouteComponent(pathname.slice("/api/commands/".length), "command");
        const commandKey = commands.has(command) ? command : "unknown";
        const ctx = await context(req, res);
        const args = await readJson(req, commandJsonLimit(config, command));
        commandRateLimiter.check(`command:${ctx.user.id}:${ctx.project.id}:${commandKey}`, {
          max: config.commandRateLimitMaxRequests,
          windowMs: config.commandRateLimitWindowMs,
          code: "command_rate_limited",
          label: "command requests",
        });
        const data = await withCommandSlot(config, async () => {
          await audit(ctx, `command.${commandKey}`, "started", { command: commandKey });
          try {
            const result = await invokeWithTimeout(command, args, ctx);
            await audit(ctx, `command.${commandKey}`, "completed", { command: commandKey });
            await auditRuntimeLifecycle(ctx, command, "completed");
            return result;
          } catch (err) {
            await audit(ctx, `command.${commandKey}`, "failed", {
              command: commandKey,
              error: err instanceof HttpError ? err.code : "command_failed",
            });
            await auditRuntimeLifecycle(ctx, command, "failed", err);
            throw err;
          }
        });
        sendJson(res, 200, { data });
        return;
      }

      if (pathname === "/api/tasks" && req.method === "POST") {
        const ctx = await context(req, res);
        const { body, bytes } = await readJsonWithSize(req, uploadJsonLimit(config));
        const command = assertString(body.command, "command", { max: 128 });
        if (bytes > commandJsonLimit(config, command)) {
          throw new HttpError(413, "body_too_large", "Request body is too large.");
        }
        if (!commands.has(command)) {
          throw new HttpError(404, "unknown_command", `Command "${command}" is not available.`);
        }
        if (!commands.canEnqueue(command)) {
          throw new HttpError(403, "task_command_forbidden", `Command "${command}" cannot be queued as an async task.`);
        }
        const args = assertObject(body.args ?? {}, "args");
        const task = await taskManager.enqueue(command, args, ctx);
        await audit(ctx, "task.create", "completed", { command, target: task.id });
        sendJson(res, 202, { data: task });
        return;
      }

      if (pathname === "/api/tasks" && req.method === "GET") {
        const ctx = await context(req, res);
        sendJson(res, 200, { data: await taskManager.list(ctx) });
        return;
      }

      if (pathname === "/api/logs/audit" && req.method === "GET") {
        const ctx = await context(req, res);
        sendJson(res, 200, { data: await readProjectJsonl(req, ctx, "audit.jsonl") });
        return;
      }

      if (pathname === "/api/logs/tasks" && req.method === "GET") {
        const ctx = await context(req, res);
        sendJson(res, 200, { data: await readProjectJsonl(req, ctx, "tasks.jsonl") });
        return;
      }

      if (pathname === "/api/logs/runtime" && req.method === "GET") {
        const ctx = await context(req, res);
        sendJson(res, 200, { data: await readProjectJsonl(req, ctx, "runtime.jsonl") });
        return;
      }

      if (pathname === "/api/logs/errors" && req.method === "GET") {
        const ctx = await context(req, res);
        sendJson(res, 200, { data: await readServerErrorJsonl(req, ctx) });
        return;
      }

      if (pathname === "/api/logs/security" && req.method === "GET") {
        const ctx = await context(req, res);
        sendJson(res, 200, { data: await readServerSecurityJsonl(req, ctx) });
        return;
      }

      if (pathname === "/api/metrics" && req.method === "GET") {
        const ctx = await context(req, res);
        sendJson(res, 200, { data: await metricsSnapshot(ctx, taskManager) });
        return;
      }

      if (pathname.startsWith("/api/tasks/")) {
        const [rawTaskId, action, ...extra] = pathname.slice("/api/tasks/".length).split("/");
        if (!rawTaskId || extra.length > 0) throw new HttpError(404, "not_found", "Route not found.");
        const taskId = decodeRouteComponent(rawTaskId, "task id");
        const ctx = await context(req, res);
        if (!action && req.method === "GET") {
          sendJson(res, 200, { data: await taskManager.get(ctx, taskId) });
          return;
        }
        if (action === "cancel" && req.method === "POST") {
          const task = await taskManager.cancel(ctx, taskId);
          await audit(ctx, "task.cancel", "completed", { target: taskId, command: task.command });
          sendJson(res, 200, { data: task });
          return;
        }
      }

      if (pathname === "/api/commands" && req.method === "GET") {
        const ctx = await context(req, res);
        sendJson(res, 200, { data: ctx.commands.list() });
        return;
      }

      if (pathname.startsWith("/api/opencode/")) {
        const [rawProjectId, ...rest] = pathname.slice("/api/opencode/".length).split("/");
        if (!rawProjectId) throw new HttpError(404, "not_found", "Route not found.");
        const projectId = decodeRouteComponent(rawProjectId, "project id");
        const user = await store.ensureUser(req, res);
        const project = await store.requireProject(user, projectId);
        const ctx = { config, store, runtimeManager, commands, req, res, user, project };
        await runtimeManager.proxy(req, res, ctx.project, `/${rest.join("/")}`);
        return;
      }

      if (pathname.startsWith("/api/files/preview/") && req.method === "GET") {
        const ctx = await context(req, res);
        await sendWorkspaceFile(req, res, ctx, decodeTail(pathname, "/api/files/preview/"), false);
        return;
      }

      if (pathname.startsWith("/api/files/download/") && req.method === "GET") {
        const ctx = await context(req, res);
        await sendWorkspaceFile(req, res, ctx, decodeTail(pathname, "/api/files/download/"), true);
        return;
      }

      if (pathname === "/api/files/upload" && req.method === "POST") {
        const ctx = await context(req, res);
        const args = await readJson(req, uploadJsonLimit(config));
        const root = normalizeRoot(args.root);
        const rel = normalizeWorkspaceRelativePath(args.path ?? args.filename, "filename");
        const data = assertString(args.data, "data", { max: Math.ceil(config.maxFileBytes * 1.4) });
        const encoding = args.encoding === "base64" ? "base64" : "utf8";
        const buffer = encoding === "base64" ? Buffer.from(data, "base64") : Buffer.from(data, "utf8");
        if (buffer.length > config.maxFileBytes) throw new HttpError(413, "file_too_large", "file is too large.");
        const base = root === "base" ? ctx.project.baseDir : ctx.project.workspaceDir;
        const full = resolveScopedPath(base, rel);
        await withProjectStorageMutation(ctx.project, async () => {
          await assertProjectCapacity(ctx.project, full, buffer.length, config);
          await writeFileAtomicNoFollow(base, full, buffer, { mode: 0o600 });
        });
        await audit(ctx, "file.upload", "completed", {
          target: root === "base" ? `${root}:${rel}` : rel,
          bytes: buffer.length,
        });
        sendJson(res, 200, { data: { path: rel } });
        return;
      }

      if ((req.method === "GET" || req.method === "HEAD") && config.staticDir) {
        await serveStatic(req, res, config, pathname);
        return;
      }

      throw new HttpError(404, "not_found", "Route not found.");
    } catch (err) {
      operationErrorCode = err instanceof HttpError ? err.code : "internal_error";
      if (res.headersSent) {
        if (!res.writableEnded) res.end();
        return;
      }
      await errorAudit(config, req, pathname, err, { requestId });
      sendError(res, err, { requestId });
    }
  }

  async function withCommandSlot(config, fn) {
    if (activeCommands >= config.maxConcurrentCommands) {
      throw new HttpError(429, "too_many_commands", "Too many commands are running.");
    }
    activeCommands++;
    try {
      return await fn();
    } finally {
      activeCommands--;
    }
  }

  function enforceRequestRateLimits(req, pathname) {
    if (!pathname.startsWith("/api/") || pathname === "/api/health" || pathname === "/api/ready") return;
    const ip = clientAddress(req, config);
    rateLimiter.check(`ip:${ip}`, {
      max: config.rateLimitMaxRequests,
      windowMs: config.rateLimitWindowMs,
      code: "rate_limited",
      label: "API requests",
    });
    if (
      (pathname === "/api/auth/login" && req.method === "POST") ||
      (pathname.startsWith("/api/auth/oidc/") && req.method === "GET")
    ) {
      authRateLimiter.check(`auth:${ip}`, {
        max: config.authRateLimitMaxRequests,
        windowMs: config.authRateLimitWindowMs,
        code: "auth_rate_limited",
        label: "login attempts",
      });
    }
  }

  const server = createServer((req, res) => {
    void handle(req, res);
  });

  async function runStartupRuntimeCleanup() {
    if (startupRuntimeCleanup) return startupRuntimeCleanup;
    startupRuntimeCleanup = (async () => {
      try {
        const projects = await store.listStoredProjects();
        return runtimeManager.cleanupOrphanedRuntimes(projects, { includeHost: false });
      } catch (err) {
        const summary = {
          scanned: 0,
          skipped: 0,
          cleaned: 0,
          missing: 0,
          failed: 1,
          error: err instanceof HttpError ? err.code : "startup_runtime_cleanup_failed",
          completedAt: new Date().toISOString(),
        };
        runtimeManager.lastOrphanCleanup = summary;
        return summary;
      }
    })();
    return startupRuntimeCleanup;
  }

  return {
    config,
    store,
    runtimeManager,
    memosClient,
    commands,
    taskManager,
    operationalMetrics,
    agentRegistry,
    researchSessions,
    server,
    async listen(port = config.port, host = config.host) {
      await agentRegistry;
      await runStartupRuntimeCleanup();
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => resolve(server.address()));
      });
    },
    async close() {
      await taskManager.close();
      await agentRuns.closeAll();
      await runtimeManager.closeAll();
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      await store.close();
    },
  };

  function invokeWithTimeout(command, args, ctx) {
    const timeoutMs = config.commandTimeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return commands.invoke(command, args, ctx);
    const controller = new AbortController();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        controller.abort();
        reject(new HttpError(504, "command_timeout", `Command exceeded ${timeoutMs}ms timeout.`));
      }, timeoutMs);
      Promise.resolve(commands.invoke(command, args, { ...ctx, signal: controller.signal })).then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }
}

async function sendProjectArchive(res, project, entries = null, config = null) {
  const archiveEntries = entries ?? await collectProjectArchiveEntries(project, config);
  res.writeHead(200, {
    "Content-Type": "application/gzip",
    "Content-Disposition": `attachment; filename="evimed-project-${safeDownloadFilename(project.id)}.tar.gz"`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  const gzip = createGzip();
  gzip.on("error", () => {
    if (!res.destroyed) res.destroy();
  });
  gzip.pipe(res);
  try {
    await writeTarArchive(gzip, archiveEntries, project.rootDir);
    gzip.end();
  } catch (err) {
    gzip.destroy(err);
    throw err;
  }
}

async function sendUserArchive(res, user, entries = null, config = null) {
  const archiveEntries = entries ?? await collectUserArchiveEntries(user, null, config);
  res.writeHead(200, {
    "Content-Type": "application/gzip",
    "Content-Disposition": `attachment; filename="evimed-account-${safeDownloadFilename(user.id)}.tar.gz"`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  const gzip = createGzip();
  gzip.on("error", () => {
    if (!res.destroyed) res.destroy();
  });
  gzip.pipe(res);
  try {
    await writeTarArchive(gzip, archiveEntries, user.rootDir);
    gzip.end();
  } catch (err) {
    gzip.destroy(err);
    throw err;
  }
}

async function collectProjectArchiveEntries(project, config = null) {
  return collectScopedArchiveEntries(project.rootDir, "project", config?.maxArchiveEntries, config?.maxArchiveBytes);
}

async function collectUserArchiveEntries(user, projects = null, config = null) {
  const listedProjects = projects ?? [];
  const metadataData = Buffer.from(`${JSON.stringify({
    version: 1,
    exportedAt: new Date().toISOString(),
    user: { id: user.id, name: user.name },
    projects: listedProjects.map((project) => ({ id: project.id, name: project.name })),
  }, null, 2)}\n`, "utf8");
  const metadata = {
    rel: "account.json",
    type: "file",
    data: metadataData,
    size: metadataData.length,
    mode: 0o600,
    mtime: new Date(),
  };
  const entries = await collectScopedArchiveEntries(user.rootDir, "account", config?.maxArchiveEntries, config?.maxArchiveBytes);
  const filteredEntries = entries.filter((entry) => entry.rel !== "account.json");
  assertArchiveByteLimit(metadata.size + archiveEntryBytes(filteredEntries), config?.maxArchiveBytes, "account");
  return [
    metadata,
    ...filteredEntries,
  ];
}

function appendMemoryArchiveEntry(entries, memory, config = null) {
  if (memory == null) return entries;
  const data = Buffer.from(`${JSON.stringify({
    ...memory,
    exportedAt: new Date().toISOString(),
  }, null, 2)}\n`, "utf8");
  const entry = {
    rel: "memory/memory.json",
    type: "file",
    data,
    size: data.length,
    mode: 0o600,
    mtime: new Date(),
  };
  assertArchiveEntryLimit(entries.length + 1, config?.maxArchiveEntries, "account");
  assertArchiveByteLimit(archiveEntryBytes(entries) + entry.size, config?.maxArchiveBytes, "account");
  return [...entries, entry];
}

function assertArchiveEntryLimit(count, limit, scope) {
  if (Number.isFinite(limit) && limit > 0 && count > limit) {
    throw new HttpError(413, "archive_too_large", `${scope} export exceeded ${Math.floor(limit)} entries.`);
  }
}

function assertArchiveByteLimit(bytes, limit, scope) {
  if (Number.isFinite(limit) && limit > 0 && bytes > limit) {
    throw new HttpError(413, "archive_too_large", `${scope} export exceeded ${Math.floor(limit)} bytes.`);
  }
}

function archiveEntryBytes(entries) {
  return entries.reduce((total, entry) => total + (Number.isSafeInteger(entry.size) ? entry.size : 0), 0);
}

async function collectScopedArchiveEntries(rootDir, scope, maxEntries = null, maxBytes = null) {
  const entries = [];
  let bytes = 0;

  async function walk(dir, rel = "") {
    const opened = await openScopedDirectoryNoFollow(rootDir, dir);
    try {
      if (rel) {
        const tarPath = rel.replace(/\\/g, "/");
        validateTarPath(`${tarPath}/`);
        assertArchiveEntryLimit(entries.length + 1, maxEntries, scope);
        entries.push({ full: dir, rel: tarPath, type: "directory", size: 0 });
      }
      const dirents = await fsp.readdir(opened.path, { withFileTypes: true });
      dirents.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of dirents) {
        const child = path.join(dir, entry.name);
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        const stat = await fsp.lstat(path.join(opened.path, entry.name));
        if (stat.isSymbolicLink()) {
          throw new HttpError(403, "path_forbidden", `symbolic links are not allowed in ${scope} exports.`);
        }
        if (stat.isDirectory()) {
          await walk(child, childRel);
          continue;
        }
        if (!stat.isFile()) {
          throw new HttpError(403, "path_forbidden", `${scope} export supports only regular files and directories.`);
        }
        const tarPath = childRel.replace(/\\/g, "/");
        validateTarPath(tarPath);
        assertArchiveEntryLimit(entries.length + 1, maxEntries, scope);
        bytes += stat.size;
        assertArchiveByteLimit(bytes, maxBytes, scope);
        entries.push({ full: child, rel: tarPath, type: "file", size: stat.size });
      }
    } finally {
      await opened.handle.close();
    }
  }

  await walk(rootDir);
  return entries;
}

async function writeTarArchive(output, entries, rootDir) {
  for (const entry of entries) {
    if (entry.data != null) {
      const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), "utf8");
      await writeTarChunk(output, tarHeader(entry.rel, {
        mode: entry.mode ?? 0o600,
        mtime: entry.mtime ?? new Date(),
        size: data.length,
        type: "file",
      }));
      await writeTarChunk(output, data);
      const padding = tarPadding(data.length);
      if (padding > 0) await writeTarChunk(output, Buffer.alloc(padding));
      continue;
    }

    if (entry.type === "directory") {
      const opened = await openScopedDirectoryNoFollow(rootDir, entry.full);
      try {
        const stat = opened.stat;
        await writeTarChunk(output, tarHeader(`${entry.rel}/`, {
          mode: stat.mode & 0o777,
          mtime: stat.mtime,
          size: 0,
          type: "directory",
        }));
      } finally {
        await opened.handle.close();
      }
      continue;
    }

    const opened = await openScopedFileNoFollow(rootDir, entry.full);
    const handle = opened.handle;
    try {
      const stat = opened.stat;
      if (!stat.isFile()) {
        throw new HttpError(403, "path_forbidden", "project export supports only regular files and directories.");
      }
      if (stat.size !== entry.size) {
        throw new HttpError(409, "archive_source_changed", "project export source changed while the archive was being created.");
      }
      await writeTarChunk(output, tarHeader(entry.rel, {
        mode: stat.mode & 0o777,
        mtime: stat.mtime,
        size: stat.size,
        type: "file",
      }));
      let written = 0;
      if (stat.size > 0) {
        for await (const chunk of handle.createReadStream({ start: 0, end: stat.size - 1, autoClose: false })) {
          written += chunk.length;
          await writeTarChunk(output, chunk);
        }
      }
      if (written !== stat.size) {
        throw new HttpError(409, "archive_source_changed", "project export source changed while the archive was being created.");
      }
      const padding = tarPadding(written);
      if (padding > 0) await writeTarChunk(output, Buffer.alloc(padding));
    } finally {
      await handle.close();
    }
  }
  await writeTarChunk(output, Buffer.alloc(1024));
}

async function writeTarChunk(output, chunk) {
  if (output.destroyed) throw new Error("archive stream closed");
  if (!output.write(chunk)) await once(output, "drain");
}

function tarPadding(size) {
  return (512 - (size % 512)) % 512;
}

function tarHeader(tarPath, { mode, mtime, size, type }) {
  if (!Number.isSafeInteger(size) || size < 0 || size > 0o77777777777) {
    throw new HttpError(413, "project_export_file_too_large", "Project export contains a file too large for the tar format.");
  }
  const header = Buffer.alloc(512);
  const { name, prefix } = splitTarPath(tarPath);
  writeTarString(header, 0, 100, name);
  writeTarOctal(header, 100, 8, mode || (type === "directory" ? 0o700 : 0o600));
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, size);
  writeTarOctal(header, 136, 12, Math.floor(new Date(mtime).getTime() / 1000));
  header.fill(0x20, 148, 156);
  header[156] = type === "directory" ? "5".charCodeAt(0) : "0".charCodeAt(0);
  writeTarString(header, 257, 6, "ustar");
  writeTarString(header, 263, 2, "00");
  writeTarString(header, 265, 32, "open-science");
  writeTarString(header, 297, 32, "open-science");
  writeTarString(header, 345, 155, prefix);

  let checksum = 0;
  for (const byte of header) checksum += byte;
  const checksumText = checksum.toString(8).padStart(6, "0");
  writeTarString(header, 148, 6, checksumText);
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function writeTarString(header, offset, length, value) {
  const bytes = Buffer.from(String(value), "utf8");
  if (bytes.length > length) throw new HttpError(400, "project_export_path_too_long", "Project export contains a path too long for the tar format.");
  bytes.copy(header, offset);
}

function writeTarOctal(header, offset, length, value) {
  const text = Math.trunc(value).toString(8).padStart(length - 1, "0");
  writeTarString(header, offset, length - 1, text);
  header[offset + length - 1] = 0;
}

function validateTarPath(tarPath) {
  splitTarPath(tarPath);
}

function splitTarPath(tarPath) {
  const normalized = tarPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const base = normalized.replace(/\/+$/, "");
  if (!base || base.includes("\0")) {
    throw new HttpError(400, "invalid_path", "Project export path is invalid.");
  }
  const parts = base.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new HttpError(400, "invalid_path", "Project export path is invalid.");
  }
  if (Buffer.byteLength(normalized, "utf8") <= 100) return { name: normalized, prefix: "" };
  for (let i = 1; i < parts.length; i++) {
    const prefix = parts.slice(0, i).join("/");
    const name = `${parts.slice(i).join("/")}${normalized.endsWith("/") ? "/" : ""}`;
    if (Buffer.byteLength(prefix, "utf8") <= 155 && Buffer.byteLength(name, "utf8") <= 100) {
      return { name, prefix };
    }
  }
  throw new HttpError(400, "project_export_path_too_long", "Project export contains a path too long for the tar format.");
}

async function sendWorkspaceFile(req, res, ctx, rel, download) {
  const url = new URL(req.url ?? "/", apiBaseFromRequest(req, ctx.config));
  const root = normalizeRoot(url.searchParams.get("root"));
  const base = root === "base" ? ctx.project.baseDir : ctx.project.workspaceDir;
  const full = resolveScopedPath(base, rel);
  let opened;
  try {
    opened = await openScopedFileNoFollow(base, full).catch((err) => {
      if (err?.code === "ENOENT") throw new HttpError(404, "file_not_found", "File not found.");
      throw err;
    });
    const { stat } = opened;
    if (!stat.isFile()) throw new HttpError(400, "not_a_file", "path is not a file.");
    if (stat.size > ctx.config.maxFileBytes && !download) {
      throw new HttpError(413, "file_too_large", "file is too large to preview.");
    }
    const headers = {
      "Content-Type": mimeFor(full),
      "Content-Length": String(stat.size),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    };
    if (download) {
      headers["Content-Disposition"] = `attachment; filename="${safeDownloadFilename(path.basename(full))}"`;
    } else {
      headers["Content-Security-Policy"] = previewSandboxCsp();
    }
    await audit(ctx, download ? "file.download" : "file.preview", "completed", {
      target: rel,
      bytes: stat.size,
    });
    res.writeHead(200, headers);
    if (stat.size === 0) {
      await opened.handle.close();
      opened = null;
      res.end();
      return;
    }
    const stream = opened.handle.createReadStream({ start: 0, end: stat.size - 1, autoClose: true });
    opened = null;
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  } finally {
    await opened?.handle.close();
  }
}

function previewSandboxCsp() {
  return [
    "sandbox",
    "default-src 'none'",
    "script-src 'none'",
    "connect-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "img-src data: blob:",
    "media-src data: blob:",
    "font-src data:",
    "style-src 'unsafe-inline'",
  ].join("; ");
}

function safeDownloadFilename(name) {
  const cleaned = name.replace(/[\x00-\x1f\x7f"\\]/g, "_").trim();
  return cleaned || "download";
}

async function audit(ctx, action, status, details = {}) {
  const record = {
    createdAt: new Date().toISOString(),
    userId: ctx.user.id,
    projectId: ctx.project.id,
    action,
    command: details.command ?? (action.startsWith("command.") ? action.slice("command.".length) : null),
    status,
    target: details.target ?? null,
    bytes: details.bytes ?? null,
    runtimeAction: details.runtimeAction ?? null,
    runtimeKind: details.runtimeKind ?? null,
    runtimeSandboxMode: details.runtimeSandboxMode ?? null,
    runtimeRunning: typeof details.runtimeRunning === "boolean" ? details.runtimeRunning : null,
    runtimeStale: typeof details.runtimeStale === "boolean" ? details.runtimeStale : null,
    error: details.error ?? null,
  };
  const file = path.join(ctx.project.metaDir, "audit.jsonl");
  await appendJsonLineNoFollow(ctx.project.rootDir, file, record, { maxBytes: ctx.config.maxLogFileBytes }).catch(() => {});
}

async function auditRuntimeLifecycle(ctx, command, status, err = null) {
  const runtimeAction = runtimeLifecycleCommands.get(command);
  if (!runtimeAction) return;
  let runtime = null;
  try {
    runtime = await ctx.runtimeManager.status(ctx.project);
  } catch {
    runtime = null;
  }
  await audit(ctx, `runtime.${runtimeAction}`, status, {
    command,
    target: "runtime",
    runtimeAction,
    runtimeKind: runtime?.kind ?? null,
    runtimeSandboxMode: runtime?.sandboxMode ?? null,
    runtimeRunning: runtime?.running,
    runtimeStale: runtime?.stale,
    error: err ? (err instanceof HttpError ? err.code : "runtime_error") : null,
  });
}

async function securityAudit(config, action, status, details = {}) {
  const record = {
    createdAt: new Date().toISOString(),
    action,
    status,
    username: details.username ?? null,
    userId: details.userId ?? null,
    code: details.code ?? null,
  };
  const file = path.join(config.dataDir, ".openscience", "security.jsonl");
  await appendJsonLineNoFollow(config.dataDir, file, record, { maxBytes: config.maxLogFileBytes }).catch(() => {});
}

function safeLogId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value) ? value : null;
}

async function errorAudit(config, req, pathname, err, details = {}) {
  if (!pathname.startsWith("/api/")) return;
  const status = err instanceof HttpError ? err.status : 500;
  const code = err instanceof HttpError ? err.code : "internal_error";
  const projectHeader = req.headers["x-open-science-project"];
  const projectId = safeLogId(Array.isArray(projectHeader) ? projectHeader[0] : projectHeader);
  const record = {
    createdAt: new Date().toISOString(),
    requestId: details.requestId ?? null,
    method: req.method ?? null,
    route: routePattern(pathname),
    status,
    code,
    projectId,
  };
  const file = path.join(config.dataDir, ".openscience", "errors.jsonl");
  await appendJsonLineNoFollow(config.dataDir, file, record, { maxBytes: config.maxLogFileBytes }).catch(() => {});
}

async function metricsSnapshot(ctx, taskManager) {
  const projectStorage = await projectStorageSnapshot(ctx);
  const maxProjectBytes = Number.isFinite(ctx.project.maxBytes) && ctx.project.maxBytes > 0
    ? ctx.project.maxBytes
    : ctx.config.maxProjectBytes;
  const memory = process.memoryUsage();
  const cpu = process.resourceUsage();
  return {
    createdAt: new Date().toISOString(),
    server: {
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
      memory: {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
        externalBytes: memory.external,
      },
      cpu: {
        userMicros: cpu.userCPUTime,
        systemMicros: cpu.systemCPUTime,
      },
      loadAverage: typeof os.loadavg === "function" ? os.loadavg() : [],
    },
    project: {
      id: ctx.project.id,
      name: ctx.project.name,
      storage: {
        usedBytes: projectStorage.usedBytes,
        maxBytes: Number.isFinite(maxProjectBytes) && maxProjectBytes > 0 ? maxProjectBytes : null,
        scanLimited: projectStorage.scanLimited,
        error: projectStorage.error,
      },
    },
    tasks: await taskManager.stats(ctx),
    runtime: await ctx.runtimeManager.status(ctx.project),
  };
}

async function projectStorageSnapshot(ctx) {
  try {
    return {
      usedBytes: await directorySize(ctx.project.baseDir, { maxEntries: ctx.config.maxProjectUsageScanEntries }),
      scanLimited: false,
      error: null,
    };
  } catch (err) {
    if (err instanceof HttpError && err.code === "project_scan_too_large") {
      return { usedBytes: null, scanLimited: true, error: err.code };
    }
    throw err;
  }
}

function headerString(req, name) {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function operatorTokenFromRequest(req) {
  const authorization = headerString(req, "authorization");
  if (typeof authorization === "string") {
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (match) return match[1].trim();
  }
  const header = headerString(req, "x-open-science-operator-token");
  return typeof header === "string" ? header.trim() : "";
}

function tokenDigest(value) {
  return createHash("sha256").update(String(value)).digest();
}

function tokenMatches(expected, actual) {
  if (!expected || !actual) return false;
  return timingSafeEqual(tokenDigest(expected), tokenDigest(actual));
}

function assertOperatorMetricsAccess(req, config) {
  if (!config.operatorMetricsToken) {
    throw new HttpError(404, "not_found", "Route not found.");
  }
  if (!tokenMatches(config.operatorMetricsToken, operatorTokenFromRequest(req))) {
    throw new HttpError(401, "operator_metrics_unauthorized", "Operator metrics token is required.");
  }
}

function prometheusLabelValue(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/"/g, "\\\"");
}

function metricLine(name, value, labels = {}) {
  const numeric = Number.isFinite(value) ? value : 0;
  const labelEntries = Object.entries(labels).filter(([, labelValue]) => labelValue != null);
  const labelText = labelEntries.length
    ? `{${labelEntries.map(([key, labelValue]) => `${key}="${prometheusLabelValue(labelValue)}"`).join(",")}}`
    : "";
  return `${name}${labelText} ${numeric}`;
}

function addMetric(lines, name, help, type, samples) {
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} ${type}`);
  if (Array.isArray(samples)) {
    for (const sample of samples) lines.push(metricLine(name, sample.value, sample.labels));
  } else {
    lines.push(metricLine(name, samples.value, samples.labels));
  }
}

function addHistogramMetric(lines, name, help, series) {
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} histogram`);
  for (const item of series) {
    for (let index = 0; index < httpDurationBuckets.length; index++) {
      lines.push(metricLine(`${name}_bucket`, item.buckets[index], {
        ...item.labels,
        le: String(httpDurationBuckets[index]),
      }));
    }
    lines.push(metricLine(`${name}_bucket`, item.count, { ...item.labels, le: "+Inf" }));
    lines.push(metricLine(`${name}_sum`, item.sum, item.labels));
    lines.push(metricLine(`${name}_count`, item.count, item.labels));
  }
}

async function operatorMetricsText({ config, store, taskManager, runtimeManager, memosClient, operationalMetrics, activeCommands }) {
  const readiness = await readinessStatus(config, store, runtimeManager, memosClient);
  const memory = process.memoryUsage();
  const cpu = process.resourceUsage();
  const loadAverage = typeof os.loadavg === "function" ? os.loadavg() : [];
  const taskStats = taskManager.statsAll();
  const runtimeStats = runtimeManager.statsAll();
  const httpStats = operationalMetrics.snapshot();
  const lines = [];

  addMetric(lines, "open_science_up", "EviMed Web API process liveness.", "gauge", { value: 1 });
  addMetric(lines, "open_science_ready", "EviMed Web API readiness status.", "gauge", {
    value: readiness.ok ? 1 : 0,
  });
  addMetric(
    lines,
    "open_science_readiness_check",
    "Readiness sub-check status by check name and result code.",
    "gauge",
    Object.entries(readiness.checks).map(([check, result]) => ({
      value: result.ok ? 1 : 0,
      labels: { check, code: result.ok ? "ok" : result.code ?? "check_failed" },
    })),
  );
  addMetric(lines, "open_science_process_uptime_seconds", "EviMed Web API process uptime.", "gauge", {
    value: process.uptime(),
  });
  addMetric(
    lines,
    "open_science_process_memory_bytes",
    "EviMed Web API process memory usage by kind.",
    "gauge",
    [
      { value: memory.rss, labels: { kind: "rss" } },
      { value: memory.heapUsed, labels: { kind: "heap_used" } },
      { value: memory.heapTotal, labels: { kind: "heap_total" } },
      { value: memory.external, labels: { kind: "external" } },
    ],
  );
  addMetric(
    lines,
    "open_science_process_cpu_seconds_total",
    "EviMed Web API process CPU time by kind.",
    "counter",
    [
      { value: cpu.userCPUTime / 1_000_000, labels: { kind: "user" } },
      { value: cpu.systemCPUTime / 1_000_000, labels: { kind: "system" } },
    ],
  );
  addMetric(
    lines,
    "open_science_system_load_average",
    "Host load average visible to the Web API process.",
    "gauge",
    [
      { value: loadAverage[0] ?? 0, labels: { window: "1m" } },
      { value: loadAverage[1] ?? 0, labels: { window: "5m" } },
      { value: loadAverage[2] ?? 0, labels: { window: "15m" } },
    ],
  );
  addMetric(lines, "open_science_http_active_requests", "HTTP requests currently handled by this API process.", "gauge", {
    value: httpStats.activeRequests,
  });
  addMetric(
    lines,
    "open_science_http_requests_total",
    "Completed HTTP requests by normalized route, method, and status.",
    "counter",
    httpStats.requests,
  );
  addMetric(
    lines,
    "open_science_http_errors_total",
    "API errors by normalized route and stable error code.",
    "counter",
    httpStats.errors,
  );
  addHistogramMetric(
    lines,
    "open_science_http_request_duration_seconds",
    "HTTP request duration by normalized route and method.",
    httpStats.durations,
  );
  addMetric(lines, "open_science_command_active", "Synchronous command requests currently running.", "gauge", {
    value: activeCommands,
  });
  addMetric(lines, "open_science_task_total", "Known task records in the current process.", "gauge", {
    value: taskStats.total,
  });
  addMetric(
    lines,
    "open_science_task_status_total",
    "Known task records by status in the current process.",
    "gauge",
    Object.entries(taskStats.byStatus).map(([status, value]) => ({ value, labels: { status } })),
  );
  addMetric(lines, "open_science_task_active", "Task runner active task count.", "gauge", {
    value: taskStats.active,
  });
  addMetric(lines, "open_science_task_queued", "Task runner queued task count.", "gauge", {
    value: taskStats.queued,
  });
  addMetric(
    lines,
    "open_science_task_concurrency_limit",
    "Configured task concurrency limits.",
    "gauge",
    [
      { value: taskStats.concurrency.maxGlobal, labels: { scope: "global" } },
      { value: taskStats.concurrency.maxPerProject, labels: { scope: "project" } },
    ],
  );
  addMetric(
    lines,
    "open_science_task_queue_limit",
    "Configured queued task limits. Zero means disabled.",
    "gauge",
    [
      { value: taskStats.queueLimits.maxGlobal ?? 0, labels: { scope: "global" } },
      { value: taskStats.queueLimits.maxPerProject ?? 0, labels: { scope: "project" } },
    ],
  );
  addMetric(lines, "open_science_runtime_running", "Runtime instances attached to the current Web API process.", "gauge", {
    value: runtimeStats.running,
  });
  addMetric(lines, "open_science_runtime_starting", "Runtime start operations currently in flight.", "gauge", {
    value: runtimeStats.starting,
  });
  addMetric(
    lines,
    "open_science_runtime_quota_monitored",
    "Runtime instances with active project quota monitoring.",
    "gauge",
    { value: runtimeStats.quota?.monitored ?? 0 },
  );
  addMetric(
    lines,
    "open_science_runtime_quota_monitor_interval_seconds",
    "Configured runtime project quota monitor interval in seconds. Zero means disabled.",
    "gauge",
    { value: (runtimeStats.quota?.intervalMs ?? 0) / 1000 },
  );
  addMetric(
    lines,
    "open_science_runtime_limit",
    "Configured attached runtime limits. Zero means disabled.",
    "gauge",
    [
      { value: runtimeStats.limits.maxGlobal ?? 0, labels: { scope: "global" } },
      { value: runtimeStats.limits.maxPerUser ?? 0, labels: { scope: "user" } },
    ],
  );
  addMetric(lines, "open_science_runtime_proxy_active", "Active OpenCode runtime proxy requests and streams.", "gauge", {
    value: runtimeStats.proxy?.active ?? 0,
  });
  addMetric(
    lines,
    "open_science_runtime_proxy_limit",
    "Configured OpenCode runtime proxy connection limits. Zero means disabled.",
    "gauge",
    [
      { value: runtimeStats.proxy?.limits?.maxGlobal ?? 0, labels: { scope: "global" } },
      { value: runtimeStats.proxy?.limits?.maxPerProject ?? 0, labels: { scope: "project" } },
    ],
  );
  addMetric(
    lines,
    "open_science_server_info",
    "Static EviMed Web API configuration metadata.",
    "gauge",
    {
      value: 1,
      labels: {
        runtime_mode: config.runtimeMode,
        runtime_sandbox_mode: config.runtimeSandboxMode,
        runtime_control_plane: config.runtimeControllerMode,
        auth_mode: config.authMode,
        production: config.production ? "true" : "false",
        app_version: config.appVersion,
        release_id: config.releaseManifest?.app.releaseId ?? "untracked",
        source_revision: config.releaseManifest?.source.revision.slice(0, 12) ?? "untracked",
      },
    },
  );

  return `${lines.join("\n")}\n`;
}

async function sendOperatorMetrics(req, res, snapshotArgs) {
  assertOperatorMetricsAccess(req, snapshotArgs.config);
  const body = await operatorMetricsText(snapshotArgs);
  res.writeHead(200, {
    "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
    "Cache-Control": "no-store",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  res.end(body);
}

async function readProjectJsonl(req, ctx, filename) {
  const file = path.join(ctx.project.metaDir, filename);
  return readJsonlTail(req, ctx.config, ctx.project.rootDir, file);
}

async function readServerErrorJsonl(req, ctx) {
  const file = path.join(ctx.config.dataDir, ".openscience", "errors.jsonl");
  return (await readJsonlTail(req, ctx.config, ctx.config.dataDir, file)).filter(
    (row) => row.projectId == null || row.projectId === ctx.project.id,
  );
}

async function readServerSecurityJsonl(req, ctx) {
  const file = path.join(ctx.config.dataDir, ".openscience", "security.jsonl");
  return (await readJsonlTail(req, ctx.config, ctx.config.dataDir, file)).filter(
    (row) => row.userId === ctx.user.id || row.username === ctx.user.id,
  );
}

async function readJsonlTail(req, config, rootDir, file) {
  const url = new URL(req.url ?? "/", apiBaseFromRequest(req, config));
  const requestedLimit = Number(url.searchParams.get("limit") ?? 100);
  const limit = Math.max(1, Math.min(Number.isFinite(requestedLimit) ? requestedLimit : 100, 500));
  const maxBytes = Number.isFinite(config.maxLogReadBytes) && config.maxLogReadBytes > 0
    ? Math.floor(config.maxLogReadBytes)
    : 1024 * 1024;
  const currentText = await readTailText(rootDir, file, maxBytes);
  const remainingBytes = Math.max(0, maxBytes - Buffer.byteLength(currentText));
  const rotatedText = remainingBytes > 0 ? await readTailText(rootDir, `${file}.1`, remainingBytes) : "";
  const joinedText = rotatedText && currentText && !rotatedText.endsWith("\n")
    ? `${rotatedText}\n${currentText}`
    : `${rotatedText}${currentText}`;
  return joinedText
    .split("\n")
    .filter(Boolean)
    .slice(-limit)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .reverse();
}

async function readTailText(rootDir, file, maxBytes) {
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : 1024 * 1024;
  const opened = await openScopedFileNoFollow(rootDir, file).catch((err) => {
    if (err?.code === "ENOENT") return null;
    throw err;
  });
  if (!opened) return "";
  const { handle, stat } = opened;
  try {
    if (!stat.isFile()) {
      throw new HttpError(403, "path_forbidden", "log files must be regular files.");
    }
    if (stat.size <= limit) return await handle.readFile("utf8");
    const length = Math.min(stat.size, limit);
    const start = stat.size - length;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function readinessStatus(config, store, runtimeManager, memosClient = null) {
  const checks = {
    dataDir: await readinessCheck(async () => readinessDataDir(config)),
    examples: await readinessCheck(async () => readinessExamples(config)),
    staticDir: config.staticDir
      ? await readinessCheck(async () => {
          const index = await staticFileCandidate(config.staticDir, "index.html");
          if (!index?.stat.isFile()) throw readinessFailure("static_asset_unavailable");
        })
      : { ok: true, skipped: true },
    publicUrl: await readinessCheck(() => readinessPublicUrl(config)),
    auth: await readinessCheck(async () => readinessAuth(config, store)),
    stateStore: await readinessCheck(async () => readinessStateStore(config, store)),
    memory: await readinessCheck(async () => readinessMemory(config, memosClient)),
    security: await readinessCheck(() => readinessSecurity(config)),
    observability: await readinessCheck(() => readinessObservability(config)),
    evimedAdapters: await readinessCheck(() => readinessEviMedAdapters(config)),
    scienceConnectors: await readinessCheck(() => readinessScienceConnectors(config)),
    modelGateway: await readinessCheck(() => readinessModelGateway(config)),
    release: await readinessCheck(() => readinessRelease(config)),
    resources: await readinessCheck(() => readinessResources(config)),
    backup: await readinessCheck(async () => readinessBackup(config)),
    runtime: await readinessCheck(async () => readinessRuntime(config, runtimeManager)),
    kernel: await readinessCheck(async () => readinessKernel(config, runtimeManager)),
  };
  checks.saasProfile = await readinessCheck(() => readinessSaasProfile(config, checks));
  return {
    ok: Object.values(checks).every((check) => check.ok),
    checks,
  };
}

async function readinessStateStore(config, store) {
  const status = await store.readiness();
  if (config.requireSharedStateStore && status.mode !== "postgres") {
    throw readinessFailure("production_state_store_not_shared", { mode: status.mode });
  }
  return { ...status, required: Boolean(config.requireSharedStateStore) };
}

async function readinessMemory(config, memosClient) {
  if (!config.requireMemos) return { required: false };
  if (!memosClient) throw readinessFailure("memory_client_missing");
  const status = await memosClient.status();
  if (!status.configured || !status.connected) {
    throw readinessFailure(status.code ?? "memory_unavailable", {
      configured: Boolean(status.configured),
      connected: Boolean(status.connected),
    });
  }
  return { required: true, connected: true };
}

async function readinessExamples(config) {
  const root = path.resolve(config.examplesDir);
  let openedRoot;
  try {
    openedRoot = await openScopedDirectoryNoFollow(root, root);
    for (const [name, files] of Object.entries(BUNDLED_EXAMPLES)) {
      for (const relative of files) {
        const file = await openScopedFileNoFollow(root, resolveScopedPath(root, `${name}/${relative}`));
        try {
          if (!file.stat.isFile() || file.stat.size > config.maxFileBytes) {
            throw readinessFailure("example_bundle_invalid");
          }
        } finally {
          await file.handle.close();
        }
      }
    }
    return { bundles: Object.keys(BUNDLED_EXAMPLES).length };
  } catch (err) {
    if (err?.code === "example_bundle_invalid") throw err;
    throw readinessFailure("example_bundle_unavailable");
  } finally {
    await openedRoot?.handle.close();
  }
}

async function readinessCheck(fn) {
  try {
    const details = await fn();
    return { ok: true, ...(details && typeof details === "object" ? details : {}) };
  } catch (err) {
    return {
      ok: false,
      code: err?.code ?? "check_failed",
      ...(err?.details && typeof err.details === "object" ? err.details : {}),
    };
  }
}

function readinessFailure(code, details = null) {
  const err = new Error(code);
  err.code = code;
  if (details && typeof details === "object") err.details = details;
  return err;
}

async function readinessDataDir(config) {
  try {
    await fsp.mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  } catch (err) {
    if (err?.code !== "EEXIST") throw readinessFailure("data_dir_unavailable");
  }
  let stat;
  try {
    stat = await fsp.lstat(config.dataDir);
  } catch {
    throw readinessFailure("data_dir_unavailable");
  }
  if (stat.isSymbolicLink()) throw readinessFailure("data_dir_symlink");
  if (!stat.isDirectory()) throw readinessFailure("data_dir_not_directory");
  try {
    await fsp.access(config.dataDir, fs.constants.R_OK | fs.constants.W_OK);
  } catch {
    throw readinessFailure("data_dir_unavailable");
  }
  return { symlink: false };
}

function readinessPublicUrl(config) {
  if (!config.production) {
    const origin = originFor(config.publicUrl);
    return origin ? { required: false, origin } : { required: false, skipped: true };
  }
  const value = typeof config.publicUrl === "string" ? config.publicUrl.trim() : "";
  if (!value) throw readinessFailure("public_url_missing");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw readinessFailure("public_url_invalid");
  }
  if (url.protocol !== "https:") throw readinessFailure("public_url_https_required");
  if (url.username || url.password || (url.pathname && url.pathname !== "/") || url.search || url.hash) {
    throw readinessFailure("public_url_origin_required");
  }
  return { required: true, origin: url.origin, secure: true };
}

async function readinessAuth(config, store) {
  const sessionTtlMs = Math.floor(Number(config.sessionTtlMs));
  if (!Number.isFinite(sessionTtlMs) || sessionTtlMs <= 0) {
    throw readinessFailure("session_ttl_invalid");
  }
  if (config.authMode === "development") {
    if (config.production) throw readinessFailure("dev_auth_enabled");
    return { mode: "development", sessionTtlMs };
  }
  if (config.authMode === "oidc") {
    let settings;
    try {
      settings = validateOidcSettings(config);
    } catch (error) {
      throw readinessFailure(error?.code ?? "oidc_configuration_invalid");
    }
    return {
      mode: "oidc",
      sessionTtlMs,
      callbackPath: "/api/auth/oidc/callback",
      allowedGroups: settings.allowedGroups.length,
      allowedEmailDomains: settings.allowedEmailDomains.length,
      clientSecretSource: config.oidcClientSecretSource,
      flowSecretSource: config.oidcFlowSecretSource,
    };
  }
  if (config.authMode !== "local") throw readinessFailure("auth_mode_invalid");
  if (config.bootstrapPasswordError) throw readinessFailure(config.bootstrapPasswordError);
  if (config.production && config.bootstrapPasswordSource === "environment") {
    throw readinessFailure("bootstrap_password_environment_forbidden");
  }
  if (config.production && config.bootstrapPassword) {
    if (config.bootstrapPassword !== config.bootstrapPassword.trim() || /[\r\n\0]/.test(config.bootstrapPassword)) {
      throw readinessFailure("bootstrap_password_invalid");
    }
    if (/^(?:replace(?:-with)?|change-?me|example|placeholder|test)(?:[-_ ]|$)/i.test(config.bootstrapPassword)) {
      throw readinessFailure("bootstrap_password_placeholder");
    }
    if (Buffer.byteLength(config.bootstrapPassword, "utf8") < 16) {
      throw readinessFailure("bootstrap_password_too_short", { minimumBytes: 16 });
    }
  }
  const users = await store.loginUserCount();
  if (users === 0) throw readinessFailure("no_login_users");
  return { mode: "local", sessionTtlMs, bootstrapPasswordSource: config.bootstrapPasswordSource };
}

function readinessSecurity(config) {
  const details = {
    securityHeaders: Boolean(config.securityHeaders),
    corsOriginCount: config.corsOrigins.length,
    hostShellAllowed: Boolean(config.allowHostShell),
    directShellAllowed: Boolean(config.allowDirectShell),
    persistentApprovalsAllowed: Boolean(config.allowPersistentApprovals),
    fullApprovalAllowed: Boolean(config.allowFullApproval),
    trustedProxy: Boolean(config.trustProxy),
  };
  if (!config.production) return { ...details, production: false };
  if (!config.securityHeaders) throw readinessFailure("security_headers_disabled");
  for (const origin of config.corsOrigins) {
    const value = typeof origin === "string" ? origin.trim() : "";
    if (!value || value === "*" || value.toLowerCase() === "null") {
      throw readinessFailure("cors_origin_forbidden");
    }
    let url;
    try {
      url = new URL(value);
    } catch {
      throw readinessFailure("cors_origin_invalid");
    }
    if (url.origin !== value) throw readinessFailure("cors_origin_not_exact");
    if (url.protocol !== "https:") throw readinessFailure("cors_origin_https_required");
    if (isLocalDevelopmentOrigin(value)) throw readinessFailure("cors_origin_local_forbidden");
  }
  if (config.allowHostShell) throw readinessFailure("host_shell_enabled");
  if (config.allowDirectShell) throw readinessFailure("direct_shell_enabled");
  if (config.allowPersistentApprovals) throw readinessFailure("persistent_approvals_enabled");
  if (config.allowFullApproval || config.approvalMode === "full") throw readinessFailure("full_approval_enabled");
  if (!config.trustProxy) throw readinessFailure("trusted_proxy_required");
  return { ...details, production: true };
}

function readinessObservability(config) {
  if (config.operatorMetricsTokenError) {
    throw readinessFailure(config.operatorMetricsTokenError);
  }
  const token = typeof config.operatorMetricsToken === "string" ? config.operatorMetricsToken : "";
  if (!config.production) {
    return {
      required: false,
      mode: token ? "protected" : "disabled",
      source: token ? config.operatorMetricsTokenSource : "none",
    };
  }
  if (!token) throw readinessFailure("operator_metrics_token_missing");
  if (token !== token.trim()) throw readinessFailure("operator_metrics_token_invalid");
  if (/^(?:replace(?:-with)?|change-?me|example)(?:[-_]|$)/i.test(token)) {
    throw readinessFailure("operator_metrics_token_placeholder");
  }
  if (Buffer.byteLength(token, "utf8") < 32) {
    throw readinessFailure("operator_metrics_token_too_short", { minimumBytes: 32 });
  }
  return { required: true, mode: "protected", source: config.operatorMetricsTokenSource };
}

function readinessEviMedAdapters(config) {
  try {
    const validation = validateEviMedAdapterConfig(config);
    return {
      enabled: validation.enabledAdapters,
      specialistAdaptersRequired: validation.specialistAdaptersRequired,
      workloadTokenRequired: validation.tokenRequired,
      signingSecretSource: config.evimedWorkloadSigningSecret
        ? config.evimedWorkloadSigningSecretSource
        : "none",
    };
  } catch (error) {
    throw readinessFailure(error?.code ?? "evimed_adapter_configuration_invalid");
  }
}

function readinessScienceConnectors(config) {
  if (config.materialsProjectApiKeyError && config.requireMaterialsProject) {
    throw readinessFailure(config.materialsProjectApiKeyError);
  }
  const key = String(config.materialsProjectApiKey ?? "");
  if (
    config.production
    && config.requireMaterialsProject
    && (!key || key !== key.trim() || /[\r\n\0]/.test(key))
  ) {
    throw readinessFailure("materials_project_api_key_missing");
  }
  if (config.production && key && config.materialsProjectApiKeySource === "environment") {
    throw readinessFailure("materials_project_api_key_environment_forbidden");
  }
  return {
    enabled: key ? 7 : 6,
    gateway: "server-managed",
    materialsProjectEnabled: Boolean(key),
    materialsProjectRequired: Boolean(config.requireMaterialsProject),
    materialsProjectKeySource: key ? config.materialsProjectApiKeySource : "none",
  };
}

function readinessModelGateway(config) {
  if (!config.deepseekProviderEnabled) return { enabled: false, skipped: true };
  if (config.runtimeMode !== "opencode") throw readinessFailure("model_gateway_runtime_mode_invalid");
  if (config.deepseekApiKeyError) throw readinessFailure(config.deepseekApiKeyError);
  if (config.modelGatewaySigningSecretError) throw readinessFailure(config.modelGatewaySigningSecretError);
  const apiKey = String(config.deepseekApiKey ?? "");
  if (!apiKey || apiKey !== apiKey.trim() || /[\r\n\0]/.test(apiKey)) {
    throw readinessFailure("deepseek_api_key_missing");
  }
  const signingSecret = String(config.modelGatewaySigningSecret ?? "");
  if (
    !signingSecret ||
    signingSecret !== signingSecret.trim() ||
    /[\r\n\0]/.test(signingSecret) ||
    Buffer.byteLength(signingSecret, "utf8") < 32
  ) throw readinessFailure("model_gateway_signing_secret_invalid");
  if (config.deepseekModel !== "deepseek-v4-pro") throw readinessFailure("deepseek_model_invalid");
  let upstream;
  let internal;
  try {
    upstream = new URL(config.deepseekBaseUrl);
    internal = new URL(config.modelGatewayInternalUrl);
  } catch {
    throw readinessFailure("model_gateway_url_invalid");
  }
  if (
    !['http:', 'https:'].includes(upstream.protocol) ||
    upstream.username ||
    upstream.password ||
    upstream.search ||
    upstream.hash ||
    (config.production && (upstream.origin !== "https://api.deepseek.com" || upstream.pathname !== "/"))
  ) throw readinessFailure("deepseek_base_url_invalid");
  if (!['http:', 'https:'].includes(internal.protocol) || internal.username || internal.password) {
    throw readinessFailure("model_gateway_internal_url_invalid");
  }
  for (const [field, value, min, max] of [
    ["modelGatewayTimeoutMs", config.modelGatewayTimeoutMs, 100, 10 * 60_000],
    ["modelGatewayMaxBodyBytes", config.modelGatewayMaxBodyBytes, 1024, 16 * 1024 * 1024],
    ["modelGatewayMaxResponseBytes", config.modelGatewayMaxResponseBytes, 1024, 256 * 1024 * 1024],
  ]) {
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw readinessFailure("model_gateway_limit_invalid", { field });
    }
  }
  if (config.production && config.runtimeSandboxMode === "docker") {
    const internalNetwork = String(config.runtimeInternalNetworkName ?? "").trim();
    if (!internalNetwork || String(config.runtimeNetworkMode ?? "").trim() !== internalNetwork) {
      throw readinessFailure("runtime_internal_network_required");
    }
  }
  if (config.production) {
    try {
      readDeepSeekReleaseReceiptFile(config.deepseekReleaseReceiptFile, {
        requireProduction: true,
        signingSecret: config.modelGatewaySigningSecret,
        maxAgeMs: config.deepseekReleaseReceiptMaxAgeMs,
        receiptId: config.deepseekReleaseReceiptId,
        sourceRevision: config.sourceRevision,
        configRevision: config.deepseekConfigRevision,
      });
    } catch (error) {
      throw readinessFailure(error?.code ?? "deepseek_release_receipt_invalid");
    }
  }
  return {
    enabled: true,
    model: config.deepseekModel,
    keySource: config.deepseekApiKeySource,
    signingSecretSource: config.modelGatewaySigningSecretSource,
  };
}

function readinessRelease(config) {
  if (config.releaseManifestError) throw readinessFailure(config.releaseManifestError);
  const manifest = config.releaseManifest;
  if (!manifest) {
    if (config.production) throw readinessFailure("release_manifest_missing");
    return { required: false, tracked: false };
  }

  const mismatches = [
    ["releaseId", config.releaseId, manifest.app.releaseId],
    ["appVersion", config.appVersion, manifest.app.version],
    ["sourceRevision", config.sourceRevision, manifest.source.revision],
    ["buildCreatedAt", config.buildCreatedAt, manifest.source.createdAt],
    ["webContainerImage", config.webContainerImage, manifest.web.image],
    ["runtimeContainerImage", config.runtimeContainerImage, manifest.runtime.image],
    ["opencodeVersion", config.opencodeVersion, manifest.runtime.opencodeVersion],
    ["uvVersion", config.uvVersion, manifest.runtime.uvVersion],
  ];
  const mismatch = mismatches.find(([, actual, expected]) => actual !== expected);
  if (mismatch) throw readinessFailure("release_manifest_mismatch", { field: mismatch[0] });
  const runtimePolicy = runtimeReleasePolicyError(config);
  if (runtimePolicy) throw readinessFailure(runtimePolicy.code, { field: runtimePolicy.field });

  return {
    required: Boolean(config.production),
    tracked: true,
    releaseId: manifest.app.releaseId,
    appVersion: manifest.app.version,
    revision: manifest.source.revision.slice(0, 12),
    createdAt: manifest.source.createdAt,
    skills: manifest.skills.length,
    images: 2,
    source: config.releaseManifestSource,
  };
}

function assertPositiveIntegerLimit(config, field) {
  const value = Number(config[field]);
  if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    throw readinessFailure("resource_limit_invalid", { field });
  }
  return value;
}

function assertPositiveDockerCpuLimit(config, field) {
  const raw = String(config[field] ?? "").trim();
  const value = Number(raw);
  if (!raw || !Number.isFinite(value) || value <= 0) {
    throw readinessFailure("resource_limit_invalid", { field });
  }
  return raw;
}

function assertDockerMemoryLimit(config, field) {
  const raw = String(config[field] ?? "").trim();
  if (!/^[1-9]\d*[bBkKmMgG]?$/.test(raw)) {
    throw readinessFailure("resource_limit_invalid", { field });
  }
  return raw;
}

function readinessResources(config) {
  const summary = {
    production: Boolean(config.production),
    maxFileBytes: config.maxFileBytes,
    maxProjectBytes: config.maxProjectBytes,
    maxConcurrentTasks: config.maxConcurrentTasks,
    maxQueuedTasks: config.maxQueuedTasks,
    maxRuntimeProxyConnections: config.maxRuntimeProxyConnections,
    runtimeQuotaCheckIntervalMs: config.runtimeQuotaCheckIntervalMs,
  };
  if (!config.production) return summary;

  const positiveIntegerFields = [
    "maxJsonBytes",
    "maxFileBytes",
    "maxProjectBytes",
    "maxWorkspaceScanEntries",
    "maxArchiveEntries",
    "maxArchiveBytes",
    "maxProjectUsageScanEntries",
    "maxLogReadBytes",
    "maxLogFileBytes",
    "maxKernelOutputBytes",
    "kernelTimeoutMs",
    "rateLimitWindowMs",
    "rateLimitMaxRequests",
    "authRateLimitWindowMs",
    "authRateLimitMaxRequests",
    "commandRateLimitWindowMs",
    "commandRateLimitMaxRequests",
    "maxConcurrentCommands",
    "maxConcurrentKernels",
    "maxConcurrentKernelsPerUser",
    "maxConcurrentTasks",
    "maxConcurrentTasksPerProject",
    "maxQueuedTasks",
    "maxQueuedTasksPerProject",
    "commandTimeoutMs",
    "runtimeProxyConnectTimeoutMs",
    "runtimeProxyRequestTimeoutMs",
    "runtimeControllerTimeoutMs",
    "runtimeControllerPollMs",
    "runtimeIdleTimeoutMs",
    "runtimeQuotaCheckIntervalMs",
    "maxRuntimeProxyConnections",
    "maxRuntimeProxyConnectionsPerProject",
    "maxRunningRuntimes",
    "maxRunningRuntimesPerUser",
  ];
  const values = Object.fromEntries(positiveIntegerFields.map((field) => [field, assertPositiveIntegerLimit(config, field)]));

  if (values.maxFileBytes > values.maxProjectBytes) {
    throw readinessFailure("resource_limit_inconsistent", { field: "maxFileBytes", maximum: "maxProjectBytes" });
  }
  if (values.maxQueuedTasksPerProject > values.maxQueuedTasks) {
    throw readinessFailure("resource_limit_inconsistent", { field: "maxQueuedTasksPerProject", maximum: "maxQueuedTasks" });
  }
  if (values.maxConcurrentKernelsPerUser > values.maxConcurrentKernels) {
    throw readinessFailure("resource_limit_inconsistent", {
      field: "maxConcurrentKernelsPerUser",
      maximum: "maxConcurrentKernels",
    });
  }
  if (values.maxRuntimeProxyConnectionsPerProject > values.maxRuntimeProxyConnections) {
    throw readinessFailure("resource_limit_inconsistent", {
      field: "maxRuntimeProxyConnectionsPerProject",
      maximum: "maxRuntimeProxyConnections",
    });
  }
  if (values.maxRunningRuntimesPerUser > values.maxRunningRuntimes) {
    throw readinessFailure("resource_limit_inconsistent", { field: "maxRunningRuntimesPerUser", maximum: "maxRunningRuntimes" });
  }

  const usesDockerRuntime = config.runtimeMode === "opencode" && config.runtimeSandboxMode === "docker";
  const usesDockerKernel = config.enableKernel && config.kernelSandboxMode === "docker";
  if (usesDockerRuntime || usesDockerKernel) {
    assertPositiveIntegerLimit(config, "runtimePidsLimit");
    assertPositiveDockerCpuLimit(config, "runtimeCpuLimit");
    assertDockerMemoryLimit(config, "runtimeMemoryLimit");
  }

  return summary;
}

function isPathInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function assertBackupPathNoSymlink(backupDir, options = {}) {
  const allowMissingTail = Boolean(options.allowMissingTail);
  const missingCode = options.missingCode ?? "backup_dir_unavailable";
  const symlinkCode = options.symlinkCode ?? "backup_dir_symlink";
  const full = path.resolve(backupDir);
  const parsed = path.parse(full);
  const parts = path.relative(parsed.root, full).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (const part of parts) {
    current = path.join(current, part);
    let stat;
    try {
      stat = await fsp.lstat(current);
    } catch (err) {
      if (err?.code === "ENOENT" && allowMissingTail) return;
      if (err?.code === "ENOENT") throw readinessFailure(missingCode);
      throw err;
    }
    if (stat.isSymbolicLink()) {
      throw readinessFailure(symlinkCode);
    }
  }
}

async function readinessBackup(config) {
  const mode = String(config.backupMode ?? "disabled").trim().toLowerCase();
  const summary = {
    production: Boolean(config.production),
    mode,
    restoreDrill: Boolean(config.restoreDrillAck),
  };
  if (!config.production) return { ...summary, required: false };

  if (!mode || mode === "disabled") {
    throw readinessFailure("backup_not_configured");
  }
  if (!["local", "external"].includes(mode)) {
    throw readinessFailure("backup_mode_invalid", { mode });
  }

  if (mode === "external") {
    if (!config.backupExternalAck) throw readinessFailure("backup_external_unconfirmed");
    if (!config.restoreDrillAck) throw readinessFailure("restore_drill_unconfirmed");
    return { ...summary, external: true };
  }

  const backupDir = String(config.backupDir ?? "").trim();
  if (!backupDir) throw readinessFailure("backup_dir_missing");
  if (!path.isAbsolute(backupDir)) throw readinessFailure("backup_dir_not_absolute");
  if (isPathInside(config.dataDir, backupDir)) throw readinessFailure("backup_dir_inside_data_dir");

  const retentionDays = Number(config.backupRetentionDays);
  if (!Number.isSafeInteger(retentionDays) || retentionDays <= 0) {
    throw readinessFailure("backup_retention_invalid");
  }
  if (!config.backupPassphraseConfigured) {
    throw readinessFailure("backup_encryption_missing");
  }
  if (!config.restoreDrillAck) throw readinessFailure("restore_drill_unconfirmed");

  await assertBackupPathNoSymlink(backupDir, { allowMissingTail: true });
  await assertBackupPathNoSymlink(backupDir);
  let stat;
  try {
    stat = await fsp.lstat(backupDir);
  } catch {
    throw readinessFailure("backup_dir_unavailable");
  }
  if (stat.isSymbolicLink()) throw readinessFailure("backup_dir_symlink");
  if (!stat.isDirectory()) throw readinessFailure("backup_dir_not_directory");
  try {
    await fsp.access(backupDir, fs.constants.R_OK);
  } catch {
    throw readinessFailure("backup_dir_unavailable");
  }

  const intervalSeconds = Number(config.backupIntervalSeconds);
  const graceSeconds = Number(config.backupHealthGraceSeconds);
  if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds < 60) {
    throw readinessFailure("backup_interval_invalid");
  }
  if (!Number.isSafeInteger(graceSeconds) || graceSeconds < 60) {
    throw readinessFailure("backup_health_grace_invalid");
  }
  const stateFile = String(config.backupStateFile ?? "").trim();
  if (!stateFile || !path.isAbsolute(stateFile) || !isPathInside(backupDir, stateFile) || stateFile === backupDir) {
    throw readinessFailure("backup_state_path_invalid");
  }
  await assertBackupPathNoSymlink(stateFile, {
    missingCode: "backup_state_missing",
    symlinkCode: "backup_state_symlink",
  });
  let stateStat;
  try {
    stateStat = await fsp.lstat(stateFile);
  } catch {
    throw readinessFailure("backup_state_missing");
  }
  if (stateStat.isSymbolicLink()) throw readinessFailure("backup_state_symlink");
  if (!stateStat.isFile() || stateStat.size <= 0 || stateStat.size > 64 * 1024) {
    throw readinessFailure("backup_state_invalid");
  }
  const stateHandle = await fsp.open(stateFile, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)).catch(() => null);
  if (!stateHandle) throw readinessFailure("backup_state_unavailable");
  let backupState;
  try {
    backupState = JSON.parse(await stateHandle.readFile("utf8"));
  } catch {
    throw readinessFailure("backup_state_invalid");
  } finally {
    await stateHandle.close();
  }
  if (!backupState || typeof backupState !== "object" || Array.isArray(backupState) || backupState.schemaVersion !== 1) {
    throw readinessFailure("backup_state_invalid");
  }
  if (backupState.status !== "healthy") throw readinessFailure("backup_scheduler_unhealthy");
  const lastSuccess = Date.parse(backupState.lastSuccessAt ?? "");
  const lastDrill = Date.parse(backupState.lastDrillAt ?? "");
  const now = Date.now();
  if (!Number.isFinite(lastSuccess) || lastSuccess > now + 5 * 60_000) {
    throw readinessFailure("backup_state_invalid");
  }
  if (now - lastSuccess > (intervalSeconds + graceSeconds) * 1000) {
    throw readinessFailure("backup_scheduler_stale");
  }
  if (!Number.isFinite(lastDrill) || lastDrill > now + 5 * 60_000) {
    throw readinessFailure("backup_restore_drill_missing");
  }

  return {
    ...summary,
    retentionDays,
    encrypted: true,
    schedulerHealthy: true,
  };
}

async function inspectRuntimeImage(config, unavailableCode, runtimeManager) {
  let imageId;
  let opencodeVersion;
  let uvVersion;
  if (runtimeManager.usesRuntimeController()) {
    let image;
    try {
      image = await runtimeManager.inspectRuntimeImage();
    } catch (error) {
      throw readinessFailure(error?.code ?? unavailableCode);
    }
    ({ imageId, opencodeVersion, uvVersion } = image);
  } else {
    const format = [
      "{{.Id}}",
      '{{index .Config.Labels "io.open-science.opencode.version"}}',
      '{{index .Config.Labels "io.open-science.uv.version"}}',
    ].join("|");
    const image = spawnSync(
      config.runtimeContainerBin,
      ["image", "inspect", "--format", format, config.runtimeContainerImage],
      { encoding: "utf8", timeout: 5_000 },
    );
    if (image.status !== 0) throw readinessFailure(unavailableCode);
    [imageId, opencodeVersion, uvVersion] = image.stdout.trim().split("|");
  }
  if (!config.production) return { imageLocal: true, imageVerified: false };

  if (!imageId || !opencodeVersion || !uvVersion) {
    throw readinessFailure("runtime_image_metadata_missing");
  }
  const recorded = config.releaseManifest?.runtime;
  if (!recorded) throw readinessFailure("release_manifest_missing");
  const mismatch = [
    ["imageId", imageId, recorded.imageId],
    ["opencodeVersion", opencodeVersion, recorded.opencodeVersion],
    ["uvVersion", uvVersion, recorded.uvVersion],
  ].find(([, actual, expected]) => actual !== expected);
  if (mismatch) throw readinessFailure("runtime_image_provenance_mismatch", { field: mismatch[0] });
  return { imageLocal: true, imageVerified: true };
}

async function readinessRuntime(config, runtimeManager) {
  if (config.runtimeMode === "mock") {
    if (config.production && !config.allowMockRuntime) throw readinessFailure("runtime_mock_forbidden");
    return { mode: "mock", sandboxMode: "mock", explicit: Boolean(config.allowMockRuntime) };
  }
  if (config.runtimeMode !== "opencode") {
    throw readinessFailure("runtime_mode_invalid");
  }
  if (config.runtimeSandboxMode === "docker") {
    if (!config.runtimeContainerBin) throw readinessFailure("runtime_container_bin_missing");
    if (!config.runtimeContainerImage) throw readinessFailure("runtime_container_image_missing");
    const transport = String(config.runtimeTransport ?? "").trim().toLowerCase();
    if (transport !== "unix" && transport !== "tcp") {
      throw readinessFailure("runtime_transport_invalid");
    }
    try {
      runtimeManager.assertDockerControlBoundary();
    } catch (error) {
      throw readinessFailure(error?.code ?? "runtime_controller_required");
    }
    if (config.runtimeDataVolume) {
      try {
        assertDockerVolumeName(config.runtimeDataVolume);
      } catch {
        throw readinessFailure("runtime_data_volume_invalid");
      }
      if (transport !== "unix") throw readinessFailure("runtime_transport_volume_mismatch");
    }
    if (!config.allowRuntimeHostNetwork && runtimeNetworkUsesHostOrContainer(config.runtimeNetworkMode)) {
      throw readinessFailure("runtime_network_forbidden");
    }
    const networkRequiresEgress = runtimeNetworkRequiresEgressOptIn(
      config.runtimeNetworkMode,
      config.runtimeInternalNetworkName,
    );
    if (
      config.production &&
      networkRequiresEgress &&
      !config.allowRuntimeNetworkEgress
    ) {
      throw readinessFailure("runtime_network_egress_forbidden");
    }
    if (config.production && networkRequiresEgress && !config.runtimeNetworkEgressPolicyAck) {
      throw readinessFailure("runtime_network_egress_policy_unconfirmed");
    }
    const network = {
      networkMode: config.runtimeNetworkMode,
      networkEgress: networkRequiresEgress ? "explicitly_allowed" : "disabled",
      networkPolicy: networkRequiresEgress
        ? config.production
          ? "acknowledged"
          : "development_only"
        : "not_required",
    };
    try {
      await runtimeManager.assertDockerSupport();
    } catch (error) {
      throw readinessFailure(error?.code ?? "runtime_docker_unavailable");
    }
    const controlPlane = runtimeManager.usesRuntimeController() ? "controller_socket" : "direct_override";
    if (config.runtimeRequireImageLocal) {
      const image = await inspectRuntimeImage(config, "runtime_image_unavailable", runtimeManager);
      return {
        mode: "opencode",
        sandboxMode: "docker",
        controlPlane,
        transport,
        dataMount: config.runtimeDataVolume ? "volume" : "bind",
        ...image,
        ...network,
      };
    }
    return {
      mode: "opencode",
      sandboxMode: "docker",
      controlPlane,
      transport,
      dataMount: config.runtimeDataVolume ? "volume" : "bind",
      imageLocal: false,
      imageCheck: "skipped",
      ...network,
    };
  }
  if (config.runtimeSandboxMode === "host") {
    if (!config.allowUnsandboxedRuntime) throw readinessFailure("runtime_sandbox_required");
    if (!config.opencodeBin) throw readinessFailure("opencode_bin_missing");
    await fsp.access(config.opencodeBin, fs.constants.X_OK);
    return { mode: "opencode", sandboxMode: "host" };
  }
  throw readinessFailure("runtime_sandbox_invalid");
}

async function readinessKernel(config, runtimeManager) {
  if (!config.enableKernel) {
    return { enabled: false, sandboxMode: "disabled" };
  }
  if (config.kernelSandboxMode === "docker") {
    try {
      runtimeManager.assertDockerControlBoundary();
      await runtimeManager.assertDockerSupport("kernel_volume_subpath_unsupported");
    } catch (error) {
      throw readinessFailure(error?.code ?? "kernel_volume_subpath_unsupported");
    }
    if (config.runtimeRequireImageLocal) {
      const image = await inspectRuntimeImage(config, "kernel_image_unavailable", runtimeManager);
      return {
        enabled: true,
        sandboxMode: "docker",
        controlPlane: runtimeManager.usesRuntimeController() ? "controller_socket" : "direct_override",
        networkMode: "none",
        ...image,
      };
    }
    return {
      enabled: true,
      sandboxMode: "docker",
      controlPlane: runtimeManager.usesRuntimeController() ? "controller_socket" : "direct_override",
      networkMode: "none",
      imageLocal: false,
      imageCheck: "skipped",
    };
  }
  if (config.kernelSandboxMode === "host") {
    if (config.production || !config.allowUnsandboxedKernel) {
      throw readinessFailure("kernel_sandbox_required");
    }
    const python = spawnSync(config.kernelPythonBin, ["--version"], {
      stdio: "ignore",
      timeout: 5_000,
    });
    if (python.status !== 0) throw readinessFailure("kernel_python_unavailable");
    return { enabled: true, sandboxMode: "host" };
  }
  throw readinessFailure("kernel_sandbox_invalid");
}

async function serveStatic(req, res, config, pathname) {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  let candidate = await staticFileCandidate(config.staticDir, rel);
  if (!candidate || candidate.stat.isDirectory()) {
    candidate = await staticFileCandidate(config.staticDir, "index.html");
  }
  if (!candidate?.stat.isFile()) {
    throw new HttpError(404, "not_found", "Static asset not found.");
  }
  const { full, stat } = candidate;
  res.writeHead(200, {
    "Content-Type": mimeFor(full),
    "Content-Length": String(stat.size),
    "Cache-Control": path.basename(full) === "index.html" ? "no-cache" : "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  fs.createReadStream(full).pipe(res);
}

async function staticFileCandidate(staticDir, rel) {
  const full = resolveScopedPath(staticDir, rel);
  try {
    await assertNoSymlinkPath(staticDir, full, {
      missingCode: "not_found",
      missingMessage: "Static asset not found.",
    });
    const stat = await fsp.stat(full);
    return { full, stat };
  } catch (err) {
    if (err instanceof HttpError && err.code === "not_found") return null;
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}
