import { completeOwnedAutopilotRun } from "./autopilotRunCompletion.mjs";
import { PluginService } from "./pluginService.mjs";
import { PluginApplyWorker } from "./pluginApplyWorker.mjs";
import { createPluginRoutes } from "./pluginRoutes.mjs";
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
import { postgresBackupReadiness } from "./postgresBackupReadiness.mjs";
import { loadAgentRegistry } from "./agentRegistry.mjs";
import { AgentRunStore } from "./agentRuns.mjs";
import { collectRunTranscripts, persistRunTranscript, pruneRunTranscripts } from "./runTranscripts.mjs";
import { resolveGatewayFetch } from "./recordedGateway.mjs";
import { LearningService } from "./learningService.mjs";
import { createLearningRuntime } from "./learningRuntime.mjs";
import { evaluateLearnedMethod } from "./learningEvaluation.mjs";
import { MethodDistillationRuns } from "./methodDistillationRuns.mjs";
import { MethodConsolidation } from "./methodConsolidation.mjs";
import { LearningWorker } from "./learningWorker.mjs";
import { runMethodObservations } from "./methodObservations.mjs";
import { persistExecutedToolEdges, persistGoldenTraces } from "./toolExecutionEdges.mjs";
import { CONNECTOR_CREDENTIAL_IDS, mountedMethodDigest } from "@evimed/domain";
import { ResearchSessionStore } from "./researchSessions.mjs";
import { prepareResearchContext } from "./researchContext.mjs";
import {
  OPEN_DOMAIN_ANSWER_AGENT_ID,
  classifierFailureReason,
  routeNamedSpecialist,
  routeOpenDomainSpecialist,
} from "./specialistRouting.mjs";
import { SpecialistClassifier } from "./specialistClassifier.mjs";
import { CoverageJudge } from "./coverageJudge.mjs";
import { BUNDLED_EXAMPLES, createCommandRegistry } from "./commands.mjs";
import { loadConfig } from "./config.mjs";
import { assertDockerVolumeName } from "./dockerMounts.mjs";
import { createModelGatewayHandler, issueModelGatewayBudgetMarker, MODEL_GATEWAY_PATH, supportedDeepSeekModels } from "./modelGateway.mjs";
import { assertSpendWithinLimits, readUsageEvents, summarizeUsage } from "./usageMetering.mjs";
import { UsageLedger } from "./usageLedger.mjs";
import { NotificationService, runFinishedNotice } from "./notificationService.mjs";
import { createNotificationRoutes } from "./notificationRoutes.mjs";
import { createLearningRoutes } from "./learningRoutes.mjs";
import {
  createPublicSourceGatewayHandler,
  PUBLIC_SOURCE_GATEWAY_PATH,
} from "./publicSourceGateway.mjs";
import { WEB_SEARCH_GATEWAY_PATH, createWebSearchGatewayHandler } from "./webSearchGateway.mjs";
import { GEO_PROBE_GATEWAY_PATH, createGeoProbeGatewayHandler } from "./geoProbeGateway.mjs";
import { MemosClient } from "./memosClient.mjs";
import { MemorySubstrate } from "./memorySubstrate.mjs";
import { OpenVikingClient } from "./openVikingClient.mjs";
import { ProductDocuments, ProductJobs } from "./productStore.mjs";
import { FeedbackEvents, deliverableSubjectId } from "./feedbackEvents.mjs";
import { withAccountExportSnapshot, appendAccountStateArchiveEntry } from "./accountExport.mjs";
import { migrateProductStore } from "./productPersistence.mjs";
import { CONNECTOR_CREDENTIAL_GATEWAY_PATH, ConnectorCredentialStore, createConnectorCredentialGatewayHandler } from "./connectorCredentials.mjs";
import { relationalIntegrity } from "./relationalIntegrity.mjs";
import { MemOsClient } from "./memOsEngineClient.mjs";
import { MemoryIndexing } from "./memoryIndexing.mjs";
import { MemoryIndexWorker } from "./memoryIndexWorker.mjs";
import { MaintenanceService } from "./maintenanceService.mjs";
import { CapsuleService } from "./capsuleService.mjs";
import { CapsuleIdentityStore } from "./capsuleIdentityStore.mjs";
import { CapsuleTransferService } from "./capsuleTransferService.mjs";
import { createCapsuleRoutes } from "./capsuleRoutes.mjs";
import { SourceService, projectSourceManifestRecord } from "./sourceService.mjs";
import { createSourceRoutes } from "./sourceRoutes.mjs";
import { SourceIngestionWorker } from "./sourceWorker.mjs";
import { SourceUnderstandingRuns } from "./sourceUnderstandingRuns.mjs";
import { createSourceUnderstandingRuntime } from "./sourceUnderstandingRuntime.mjs";
import { removeSourceCopies, sourceAttemptId, stageParserInput } from "./sourceFiles.mjs";
import { DocumentParserClient } from "./documentParserClient.mjs";
import { OpenListClient } from "./openListClient.mjs";
import { OpenListSourceConnector } from "./openListSourceConnector.mjs";
import { AutopilotService, VERIFICATION_ARTIFACT, VERIFICATION_ROUTE_REASON, parseVerificationResult, verificationBrief,
  verificationEpisodeId, verificationPrompt, verificationWorkspacePath } from "./autopilotService.mjs";
import { createAutopilotRoutes } from "./autopilotRoutes.mjs";
import { AutopilotWorker } from "./autopilotWorker.mjs";
import { CAPSULE_GATEWAY_PATH, createCapsuleGatewayHandler } from "./capsuleGateway.mjs";
import { REVISION_GATEWAY_PATH, createRevisionGatewayHandler } from "./revisionGateway.mjs";
import { MemoryIntelligence } from "./memoryIntelligence.mjs";
import { OidcService, validateOidcSettings } from "./oidc.mjs";
import { runtimeReleasePolicyError } from "./releaseManifest.mjs";
import {
  RUNTIME_CAPABILITY_SKILLS_DIR,
  RUNTIME_KERNEL_NAME,
  RuntimeManager,
  runtimeNetworkRequiresEgressOptIn,
  runtimeNetworkUsesHostOrContainer,
  validateEviMedAdapterConfig,
} from "./runtimeManager.mjs";
import { createStore } from "./store.mjs";
import { readinessSaasProfile } from "./saasProfile.mjs";
import { TaskManager } from "./taskManager.mjs";
import { RunEventHub, attachRunStream, resumePosition } from "./runEventStream.mjs";
import { RuntimeEventPump } from "./dshEventPump.mjs";
import { createRuntimeUiServer } from "./runtimeUiServer.mjs";
import { assertRuntimeUiFrameConfiguration, issueRuntimeUiFrame, releaseRuntimeUiFrameCookie, renewRuntimeUiFrame } from "./runtimeUiFrames.mjs";
import { DEEPSEEK_RECEIPT_RENEWAL_COMMAND, deepSeekReleaseReceiptFreshness, readDeepSeekReleaseReceiptFile } from "../../../scripts/ops/deepseek-kernel-release-gate.mjs";
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
  readFileNoFollow,
  readJsonWithSize,
  resolveScopedPath,
  safeId,
  sendError,
  sendJson,
  withProjectStorageMutation,
  writeFileAtomicNoFollow,
} from "./security.mjs";

// How often a running agent is polled for progress. The run monitor's limits are
// expressed as counts of this interval, so it has to be stated once rather than
// repeated as a literal at each call site.
const AGENT_RUN_MONITOR_INTERVAL_MS = 500;

function originFor(value) {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * The project a verification run sees: a scratch workspace of its own under the
 * project's workspace root.
 *
 * The same shape `sourceRunProject` builds for a source-understanding run — the
 * project with `workspaceDir` moved. What that buys is bounded, and the bound
 * is stated here because it was previously stated wrongly ("the report is not
 * in its filesystem at all"):
 *
 * - A launch plan built from this object mounts the scratch directory at
 *   `/workspace`, so the episode's report, its delta and its notes are not
 *   reachable by any tool the verifier has. `serverComposition.test.mjs` reads
 *   that off a real `buildRuntimeLaunchPlan` rather than off `workspaceDir`,
 *   because this argument looked right for the whole time the mounts did not.
 * - `runtimeDir` is deliberately NOT moved. A container mounts two host
 *   directories, and the second — the project's runtime root at `/runtime`,
 *   read-write, holding `$DSH_HOME` and therefore the kernel's sessions, logs
 *   and attachments — comes from `project.runtimeDir`. So the verifier does
 *   share the episode's DSH home. Scoping it from here would not isolate it
 *   and would break the hosted deployment: the privileged runtime controller
 *   rebuilds the project from `{userId, projectId, activeWorkspace}` alone
 *   (`projectFromReference`, and `/v1/runtime/start` refuses any other key), so
 *   it would mount the project's own runtime root while the control plane wrote
 *   this run's profile and credentials into the scoped one — a verification
 *   whose kernel cannot authenticate. Isolating `/runtime` is a
 *   `RUNTIME_CONTROLLER_PROTOCOL_VERSION` change carrying the runtime root on
 *   both sides at once, not an edit here.
 * - For the same reason the workspace move does not reach the container on the
 *   hosted path either: `activeWorkspace` is the only workspace selector the
 *   protocol carries, and `.evimed-verification/<id>` is not a workspace name.
 *   There, what separates the verifier from the run it is checking is the
 *   projection in `verificationBrief` and the prompt — which is a prompt, not
 *   an enforcement.
 *
 * `baseDir` is deliberately left as the project's workspace root, so this
 * function answers the same for the interactive project object and for one
 * already scoped — which is what lets the completion fold rebuild the path, and
 * what lets the sweep below rebuild it from the id alone.
 *
 * @param {any} project @param {string} verificationId
 */
function verificationRunProject(project, verificationId) {
  return { ...project, activeWorkspace: "",
    workspaceDir: resolveScopedPath(project.baseDir, verificationWorkspacePath(verificationId)) };
}

/**
 * Delete one verification's scratch directory, once its run is over.
 *
 * A verification writes into `.evimed-verification/<id>` under the project's
 * workspace root — the tree `assertProjectCapacity` and the runtime quota
 * monitor both walk — and nothing ever removed it. A nightly agenda therefore
 * filled the researcher's own quota with the platform's scratch, one directory
 * per verification, until the usage walk hit its entry ceiling.
 *
 * Removal never decides whether a verification counts. A scratch directory that
 * outlives its run is a leak; a fold that died trying to delete one would lose
 * a verdict already paid for. So this runs after the verdict is recorded and
 * after the bounded runtime is released, and every caller records a failure
 * instead of raising it.
 *
 * `verificationRunProject` refuses an id that is not a verification id and
 * `resolveScopedPath` refuses one that would leave the workspace root, so the
 * path this removes is always inside the project.
 *
 * @param {any} project @param {string} verificationId
 */
async function discardVerificationScratch(project, verificationId) {
  const scoped = verificationRunProject(project, verificationId);
  await withProjectStorageMutation(project, async () => {
    await assertNoSymlinkPath(project.baseDir, scoped.workspaceDir, { allowMissingTail: true });
    await fsp.rm(scoped.workspaceDir, { recursive: true, force: true });
  });
}

/**
 * What one independent verification concluded, read from the one file it writes.
 *
 * The original report is not opened here and its path is not resolved: the only
 * artifact this reads is the verifier's own answer, out of the verifier's own
 * scratch workspace. A run that failed, wrote nothing, or wrote something
 * unreadable returns a code rather than a verdict, and the claim keeps the tier
 * its own episode's gate gave it.
 *
 * Anchored at the project's workspace root rather than at the scratch
 * directory, for the reason `readOwnedJson` states for source artifacts: the
 * scratch directory is written by the run, so anchoring there checks no-follow
 * on the file and on nothing above it — a link left in place of the scratch
 * directory would have been read through, out of the project. Every ancestor
 * has to pass, and the sweep below refuses the same shape.
 */
async function readVerificationVerdict(project, run) {
  if (run.status !== "succeeded") return { errorCode: "verification_run_failed" };
  const artifact = (run.artifacts ?? []).find((item) => typeof item === "string" && item.endsWith(VERIFICATION_ARTIFACT));
  if (!artifact) return { errorCode: "verification_result_missing" };
  try {
    const scoped = verificationRunProject(project, run.dispatchId);
    const file = resolveScopedPath(scoped.workspaceDir, artifact);
    return parseVerificationResult(JSON.parse(String(await readFileNoFollow(project.baseDir, file, "utf8"))));
  } catch {
    return { errorCode: "verification_result_unreadable" };
  }
}

function minimumPositive(...values) {
  const positive = values.map(Number).filter((value) => Number.isFinite(value) && value > 0);
  return positive.length ? Math.min(...positive) : 0;
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
  const publicOrigin = originFor(config.publicUrl);
  // The kernel's browser application is the product's session surface and it
  // is served on an origin of its own, so `default-src 'self'` would refuse to
  // frame it. Named rather than widened: only that origin.
  const uiOrigin = config.runtimeUiProxyEnabled ? originFor(config.runtimeUiPublicOrigin) : null;
  // …and `connect-src` has to name it too. The shell asks whether that origin
  // is reachable before it frames it, because an iframe cannot report a
  // network failure and a frame pointed at a blocked port spins forever. That
  // question is a `fetch`, which `connect-src` governs — so with only
  // `frame-src` widened, our own policy refused the probe, the probe reported
  // the origin unreachable, and the frame was never rendered even when the
  // origin was fine. Observed in a real browser on 2026-09-04; the unit tests
  // could not see it, because a test browser has no CSP.
  const connectSrc = [
    config.production ? "connect-src 'self'" : "connect-src 'self' http://127.0.0.1:* http://localhost:* ws: wss:",
    uiOrigin,
  ].filter(Boolean).join(" ");
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
      uiOrigin ? `frame-src ${uiOrigin}` : "frame-src 'none'",
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

/**
 * Turns a browser's answer into the outcome the kernel accepts.
 *
 * The kernel's own vocabulary is not exposed to the client, deliberately. Its
 * gateway validates outcomes with exact-key equality and its approval service
 * normalizes anything outside a four-word vocabulary to `unavailable` — so a
 * pass-through would let a caller mint a shape that is either refused at the
 * boundary or silently downgraded into a refusal, and in both cases the person
 * who clicked "allow" would be told it worked. Two decisions go over the wire;
 * this is where they become the kernel's words.
 *
 * `question` answers carry the person's text, which the kernel takes verbatim.
 *
 * @param {Record<string, any>} body
 * @returns {{ kind: 'result', value: unknown }}
 */
function interactionOutcome(body) {
  const decision = String(body?.decision ?? "");
  if (decision === "allow") return { kind: "result", value: "allowed-once" };
  if (decision === "deny") return { kind: "result", value: "rejected" };
  if (decision === "answer") {
    const answer = body?.answer;
    if (typeof answer !== "string" || !answer.trim()) {
      throw new HttpError(400, "interaction_answer_missing", "An answer decision needs the text to send back.");
    }
    return { kind: "result", value: answer };
  }
  throw new HttpError(400, "interaction_decision_invalid", 'Decision must be one of "allow", "deny" or "answer".');
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
  if (pathname.startsWith(`${CAPSULE_GATEWAY_PATH}/`)) return `${CAPSULE_GATEWAY_PATH}/:action`;
  if (pathname === "/api/capsules") return pathname;
  if (pathname.startsWith("/api/capsules/")) return "/api/capsules/:id/:action";
  if (pathname === "/api/inbox") return pathname;
  if (pathname.startsWith("/api/inbox/")) return "/api/inbox/:id/:action";
  if (pathname === "/api/auth/register") return pathname;
  if (pathname === "/api/account" || pathname === "/api/account/export" || pathname === "/api/account/usage") return pathname;
  if (pathname === "/api/connectors") return pathname;
  if (pathname.startsWith("/api/connectors/")) return "/api/connectors/:connector";
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
  if (pathname === "/api/feedback/events") return pathname;
  if (pathname.startsWith("/api/memory/memos/")) return "/api/memory/memos/:memoId";
  if (pathname.startsWith("/api/memory/")) return "/api/memory/:route";
  if (pathname.startsWith("/api/runtime-ui/")) return "/api/runtime-ui/:projectId/*";
  if (pathname.startsWith("/api/opencode/")) return "/api/opencode/:projectId/* (retired)";
  if (pathname.startsWith("/api/runs/") && pathname.includes("/interactions/")) return "/api/runs/:id/interactions/:eventId";
  if (pathname.startsWith("/api/runs/") && pathname.endsWith("/events")) return "/api/runs/:id/events";
  if (pathname.startsWith("/api/runs/") && pathname.endsWith("/usage")) return "/api/runs/:id/usage";
  if (pathname === "/api/runtime/sessions") return "/api/runtime/sessions";
  if (pathname.startsWith("/api/runtime/sessions/") && pathname.endsWith("/transcript")) return "/api/runtime/sessions/:id/transcript";
  if (pathname.startsWith("/api/files/preview/")) return "/api/files/preview/:path";
  if (pathname.startsWith("/api/files/download/")) return "/api/files/download/:path";
  if (pathname === "/api/files/upload") return pathname;
  if (pathname.startsWith("/api/")) return "/api/:route";
  // The internal gateways carry the runtime's entire outbound traffic —
  // every model call, every source fetch, every search, every probe. They used
  // to fall through to "/static", so a provider 401 storm and a wave of images
  // were the same line on the dashboard. The probe keeps its own label rather
  // than sharing the source gateway's: it is metered and audited separately
  // because it is a different kind of traffic with a different failure mode.
  if (
    pathname === MODEL_GATEWAY_PATH ||
    pathname === PUBLIC_SOURCE_GATEWAY_PATH ||
    pathname === WEB_SEARCH_GATEWAY_PATH ||
    pathname === GEO_PROBE_GATEWAY_PATH ||
    pathname === REVISION_GATEWAY_PATH ||
    pathname === CONNECTOR_CREDENTIAL_GATEWAY_PATH
  ) return pathname;
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

function requestStartsMutation(req, pathname) {
  const method = String(req.method ?? "GET").toUpperCase();
  return ["POST", "PUT", "PATCH", "DELETE"].includes(method)
    || (method === "GET" && ["/api/auth/oidc/start", "/api/auth/oidc/callback"].includes(pathname));
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

/** TypeScript infers a destructured parameter as exactly the shape its
 *  defaults name, which rejects every other property a caller passes.
 *  @param {any} overrides
 */
export function createWebApiApp(overrides = {}) {
  const config = loadConfig(overrides);
  const agentRegistry = loadAgentRegistry({ packageDirs: config.agentPackageDirs, capabilityDirs: config.capabilityDirs });
  const store = createStore(config, { databasePool: overrides.databasePool });
  const productDatabase = "database" in store ? store.database : null;
  // A researcher's own connector credentials. Postgres-backed and keyed under
  // the gateway signing secret; a file-store deployment has neither the table
  // nor a reason to hold personal keys, and answers 503 by name.
  const connectorCredentials = productDatabase && typeof config.modelGatewaySigningSecret === "string" && config.modelGatewaySigningSecret.length >= 32
    ? new ConnectorCredentialStore({ database: productDatabase, secret: config.modelGatewaySigningSecret, config })
    : null;
  let maintenanceService = null;
  const maintenanceMutation = (operation) => maintenanceService ? maintenanceService.withMutation(operation) : operation();
  const productDocuments = productDatabase ? new ProductDocuments(productDatabase) : null;
  const productJobs = productDatabase ? new ProductJobs(productDatabase) : null;
  const pluginService = productDatabase ? new PluginService(productDatabase, { jobs: productJobs, maxTimeoutMs: config.publicSourceGatewayTimeoutMs }) : null;
  const pluginRoutes = createPluginRoutes({ store, service: pluginService, maxJsonBytes: config.maxJsonBytes });
  const usageLedger = productDatabase ? new UsageLedger(productDatabase) : null;
  const notificationService = productDatabase ? new NotificationService(productDatabase) : null;
  const notificationRoutes = createNotificationRoutes({ store, service: notificationService, maxJsonBytes: config.maxJsonBytes });
  let notificationTimer = null;
  let notificationRun = null;
  const applyNotificationDefaults = () => {
    if (!notificationService) return Promise.resolve([]);
    if (notificationRun) return notificationRun;
    notificationRun = maintenanceMutation(() => notificationService.applyDueDefaults()).catch((error) => {
      if (error?.code === "maintenance_active") return [];
      process.stderr.write(`inbox default processing failed: ${typeof error?.code === "string" ? error.code : "notification_unavailable"}\n`);
      return [];
    }).finally(() => { notificationRun = null; });
    return notificationRun;
  };
  const memOsEngine = config.memOsEngineUrl
    ? overrides.memOsEngineClient ?? new MemOsClient({ memOsBaseUrl: config.memOsEngineUrl, memOsWriteMode: "sync-fast" })
    : null;
  const memoryIndexing = productDatabase && productJobs && memOsEngine
    ? new MemoryIndexing({ database: productDatabase, engine: memOsEngine, jobs: productJobs }) : null;
  const memoryIndexWorker = memoryIndexing
    ? new MemoryIndexWorker({ jobs: productJobs, indexing: memoryIndexing, pollMs: config.memoryIndexPollMs,
      leaseMs: config.memoryIndexLeaseMs, reconcileMs: config.memoryIndexReconcileMs }) : null;
  // What the researcher did, and the one producer that reads it back. Both
  // exist exactly when the product ledger does; without it the memory routes
  // below record nothing and say so by being null rather than by pretending.
  // The queue is handed over only when something will claim from it.
  //
  // `distill` has exactly one claimer, `LearningWorker`, and that worker is
  // composed only when `learningEnabled`. Passing the queue unconditionally
  // would enqueue a lesson per adopted-then-edited deliverable on a deployment
  // that has nothing to run it — jobs that sit `queued` forever while
  // `POST /api/feedback/events` reports a `distillJobId` for work that will
  // never happen. With no queue the ledger still records the fact, which is the
  // half of this that stands on its own, and answers `null` for the job.
  const feedbackEvents = productDatabase
    ? new FeedbackEvents({ database: productDatabase, jobs: config.learningEnabled ? productJobs : null }) : null;
  /** Optional infrastructure says so, rather than answering 500 to a valid request. */
  function requireFeedbackEvents() {
    if (!feedbackEvents) throw new HttpError(503, "feedback_unavailable", "Recording feedback requires the shared product store.");
    return feedbackEvents;
  }

  /**
   * Feedback is recorded beside the researcher's action, never instead of it.
   *
   * The memory update has already been written and audited by the time this
   * runs, so an unreachable ledger must not turn a successful PATCH into an
   * error the user sees. It is not swallowed either: the failure lands in the
   * security ledger with its code, which is where "the loop stopped closing"
   * has to be visible.
   *
   * @param {any} ctx @param {() => any} operation
   */
  async function recordFeedback(ctx, operation) {
    try {
      return await operation();
    } catch (error) {
      await securityAudit(config, "feedback.record", "failed", {
        userId: ctx.user.id,
        code: typeof error?.code === "string" ? error.code : "feedback_unavailable",
        detail: String(error?.message ?? "").slice(0, 200),
      });
      return null;
    }
  }

  const learningService = productDocuments
    ? new LearningService({ documents: productDocuments, jobs: productJobs, notifications: notificationService })
    : null;
  const learningRoutes = createLearningRoutes({
    store, service: learningService, maxJsonBytes: config.maxJsonBytes,
    evaluationUsers: config.learningEvaluationUsers,
    trialTtlMs: config.learningTrialTtlMs,
  });
  // Terminal-hook writes still in flight.
  //
  // `onRunFinished` fires from the run store's own monitor, so a transcript
  // write can land after the process has been asked to stop — and in a test
  // that is a write racing the temp directory's removal. Held here so `close`
  // can wait for them, the way it already waits for the capsule cleanup and the
  // inbox default pass.
  /** @type {Set<Promise<unknown>>} */
  const learningWrites = new Set();
  const evaluationAbortControllers = new Set();
  /** @param {Promise<unknown>} work @returns {Promise<unknown>} */
  const trackLearningWrite = (work) => {
    const tracked = work.finally(() => learningWrites.delete(tracked));
    learningWrites.add(tracked);
    return tracked;
  };
  /**
   * Fold one finished run into the counters of every method it was given.
   *
   * Best effort and self-auditing, like everything else in the terminal hook: a
   * counter that could not be written must not be the reason a run reports
   * failure, and must not be silent either.
   *
   * @param {{project: any, run: any, sessions: readonly any[]}} input
   * @returns {Promise<void>}
   */
  /** @param {string} text @returns {string} */
  const sha256Hex = (text) => createHash("sha256").update(text, "utf8").digest("hex");
  const recordMethodUse = async ({ project, run, sessions }) => {
    if (!learningService || !config.learningEnabled) return;
    const projection = await agentRuns.runWorkflowProjection(project, run);
    if (!projection) return;
    const approved = await learningService.approvedMethods(project.userId, { projectId: project.id });
    const accountWide = await learningService.approvedMethods(project.userId, { projectId: null });
    // The candidates this project is mounting under trial, which are the whole
    // reason the trial exists: a candidate is promoted on observed
    // trajectories, and reading only the approved list meant a mounted
    // candidate earned none of them. It stays unpromotable forever, and the
    // symptom is a loop that looks like it is running and never learns.
    //
    // A trial that cannot be read costs the approved methods nothing.
    /** @type {any[]} */
    let trialled = [];
    try {
      const trial = await learningService.methodTrial(project.userId, project.id);
      for (const methodId of trial.methodIds ?? []) {
        const document = await learningService.getMethod(project.userId, methodId).catch(() => null);
        if (document) trialled.push(document);
      }
    } catch { trialled = []; }
    /** @type {{id: string, name: string, digest: string, contentDigest?: string, trial?: boolean}[]} */
    const methods = [];
    const evaluationSnapshot = runtimeManager.evaluationMethodSnapshots.get(runtimeManager.key(project));
    if (evaluationSnapshot) trialled = evaluationSnapshot.documents.filter((document) => document.payload.status === "candidate");
    for (const document of evaluationSnapshot?.documents ?? [...trialled, ...approved, ...accountWide]) {
      if (methods.some((method) => method.id === document.id)) continue;
      const name = String(document.payload?.frontmatter?.name ?? "");
      if (!name) continue;
      methods.push({
        id: String(document.id),
        name,
        digest: mountedMethodDigest(document.payload, sha256Hex),
        contentDigest: document.payload.contentDigest,
        ...(trialled.some((candidate) => candidate.id === document.id) ? { trial: true } : {}),
      });
    }
    const derived = runMethodObservations({ run, projection, methods, sessions });
    if (derived.methodsLoaded.length || derived.methodsInvoked.length) {
      // A run that carried an unproven method has to say so on its own row.
      // Without it a reader of the ledger cannot tell a measured arm from an
      // ordinary run, and every later comparison silently mixes the two.
      const trialNames = new Set(methods.filter((method) => method.trial).map((method) => method.name));
      const mark = (/** @type {{name: string, digest: string}[]} */ entries) => entries.map((entry) => (
        trialNames.has(entry.name) ? { ...entry, trial: true } : entry));
      await agentRuns.recordLearning(project, run.id, {
        methodsLoaded: mark(derived.methodsLoaded),
        methodsInvoked: mark(derived.methodsInvoked),
      });
    }
    // A method the run read without any delegation to hang it on. It earns no
    // observation — no mounted digest, no deliverable verdict — but a run that
    // answered directly out of a learned method and left no trace of it is how
    // a whole product line comes to look like it never uses the library.
    if (derived.invokedWithoutMount.length) {
      await securityAudit(config, "learning.observation.record", "unmounted", {
        userId: project.userId, projectId: project.id, runId: run.id,
        code: `read_without_receipt:${derived.invokedWithoutMount.length}`,
      });
      // And into the method's own ledger, which is where the loop reads it.
      // The audit line alone showed the reading to an operator and hid it from
      // `retirementProposal`, so a method the answer line opened daily still
      // arrived at the nightly job with a strength of 0 and could be proposed
      // for retirement as unused. One timestamp for the run, so several methods
      // read by the same run are read at the same moment.
      const readAt = new Date().toISOString();
      for (const entry of derived.invokedWithoutMount) {
        await learningService.recordRead(project.userId, entry.id, readAt).catch(async (error) => {
          await securityAudit(config, "learning.observation.record", "failed", {
            userId: project.userId, projectId: project.id, runId: run.id,
            code: typeof error?.code === "string" ? error.code : "method_read_failed",
          });
        });
      }
    }
    if (!methods.length) return;
    for (const { methodId, observation } of derived.observations) {
      await learningService.recordObservation(project.userId, methodId, observation).catch(async (error) => {
        await securityAudit(config, "learning.observation.record", "failed", {
          userId: project.userId, projectId: project.id, runId: run.id,
          code: typeof error?.code === "string" ? error.code : "method_observation_failed",
        });
      });
    }
    for (const methodId of derived.eligible) {
      await learningService.recordEligible(project.userId, methodId).catch(() => {});
    }
    // A mounted digest that is not the stored one is worth a line. It is not an
    // error — a method amended mid-run is legitimate — but it is the one way
    // this producer can silently record nothing while everything looks healthy,
    // which is the failure the whole module exists to have ended.
    if (derived.mismatched.length) {
      await securityAudit(config, "learning.observation.record", "stale", {
        userId: project.userId, projectId: project.id, runId: run.id,
        code: `digest_moved:${derived.mismatched.length}`,
      });
    }
  };
  // Constructed after the runtime exists, and left null when the loop is off
  // so that a deployment that has not opted in has no claimer for the two
  // learning job kinds rather than a claimer that declines every job.
  let learningRuntime = null;
  /** @type {any} */
  let learningWorker = null;
  const capsuleService = productDocuments ? new CapsuleService(productDocuments, { indexing: memoryIndexing }) : null;
  const capsuleTransferService = productDocuments ? new CapsuleTransferService({ documents: productDocuments, capsules: capsuleService, identities: new CapsuleIdentityStore(config.dataDir), dataDir: config.dataDir }) : null;
  const capsuleRoutes = createCapsuleRoutes({ store, service: capsuleService, transferService: capsuleTransferService, maxJsonBytes: config.maxJsonBytes });
  const sourceService = productDocuments && productJobs ? new SourceService(productDocuments, productJobs) : null;
  const documentParser = new DocumentParserClient({
    baseUrl: config.documentParserUrl,
    token: config.documentParserToken,
    timeoutMs: config.documentParserTimeoutMs,
    fetchImpl: overrides.documentParserFetch ?? globalThis.fetch,
  });
  const openListClient = config.openListUrl && config.openListToken && !config.openListTokenError
    ? new OpenListClient({
      baseUrl: config.openListUrl, token: config.openListToken, timeoutMs: Math.min(300_000, config.documentParserTimeoutMs),
      maxDownloadBytes: config.openListMaxDownloadBytes, fetchImpl: overrides.openListFetch ?? globalThis.fetch,
    }) : null;
  const openListConnector = openListClient
    ? new OpenListSourceConnector(openListClient, { tenantRoot: config.openListTenantRoot }) : null;
  const sourceRoutes = createSourceRoutes({ store, service: sourceService, openList: openListConnector, maxJsonBytes: config.maxJsonBytes });
  const sourceProject = async (job) => {
    const user = await store.userById(job.userId);
    if (!user) throw new HttpError(404, "source_account_unavailable", "Source account is unavailable.");
    return store.requireProject(user, job.projectId);
  };
  let sourceUnderstandingRuntime = null;
  const sourceWorker = sourceService && config.sourceIngestionEnabled ? new SourceIngestionWorker({
    jobs: productJobs,
    sources: sourceService,
    parser: documentParser,
    pollMs: config.sourceIngestionPollMs,
    leaseMs: config.sourceIngestionLeaseMs,
    understandingRuns: new SourceUnderstandingRuns({
      dispatch: request => sourceUnderstandingRuntime.dispatch(request),
      readResult: identity => sourceUnderstandingRuntime.readResult(identity),
    }),
    cancelUnderstanding: identity => sourceUnderstandingRuntime.cancel(identity),
    resolveSource: async (job, source) => {
      const connectorType = source.payload.connector?.type;
      if (!["upload", "internal", "openlist"].includes(connectorType)) {
        throw new HttpError(503, "source_connector_unavailable", "This source connector is not available to the ingestion worker.");
      }
      const project = await sourceProject(job);
      job.sourceProject = project;
      let localPath;
      if (connectorType === "openlist") {
        if (!openListConnector) throw new HttpError(503, "openlist_unavailable", "OpenList is not configured for this deployment.");
        const remotePath = source.payload.connector?.id;
        const buffer = await openListConnector.read(job.userId, remotePath);
        const expectedSize = Number(source.payload.fingerprint?.size);
        const actualHash = createHash("sha256").update(buffer).digest("hex");
        if (buffer.length !== expectedSize || actualHash !== source.payload.fingerprint?.sha256) {
          throw new HttpError(409, "openlist_source_changed", "The OpenList file changed after it was registered; refresh the source before analysis.");
        }
        const name = path.posix.basename(String(remotePath));
        const relative = `knowledge-base/.evimed-openlist-staging/${source.id}/${job.id}-${sourceAttemptId(job)}/${name}`;
        const full = resolveScopedPath(project.baseDir, relative);
        await sourceService.withIngestionLease(job, () => withProjectStorageMutation(project, async () => {
          await assertProjectCapacity(project, full, buffer.length, config);
          await writeFileAtomicNoFollow(project.baseDir, full, buffer, { mode: 0o600 });
        }));
        localPath = full;
      } else {
        const relative = source.payload.paths?.[0];
        if (typeof relative !== "string") throw new HttpError(400, "source_path_invalid", "Source path is invalid.");
        localPath = resolveScopedPath(project.baseDir, relative);
        await assertNoSymlinkPath(project.baseDir, localPath);
      }
      if (!config.documentParserUrl) return localPath;
      if (!config.documentParserStagingDir) throw new HttpError(503, "document_parser_staging_unconfigured", "Document parser staging is unavailable.");
      const opened = await openScopedFileNoFollow(project.baseDir, localPath);
      let bytes;
      try {
        if (opened.stat.size > config.openListMaxDownloadBytes) {
          throw new HttpError(413, "source_parser_input_too_large", "Use the local analysis agent for files above the hosted parser limit.");
        }
        bytes = await opened.handle.readFile();
      } finally { await opened.handle.close(); }
      const actualHash = createHash("sha256").update(bytes).digest("hex");
      if (actualHash !== source.payload.fingerprint?.sha256 || bytes.length !== Number(source.payload.fingerprint?.size)) {
        throw new HttpError(409, "source_changed", "The source changed after it was registered; refresh it before analysis.");
      }
      const stagingRoot = path.resolve(config.documentParserStagingDir);
      const stagingRelative = `${job.id}-${sourceAttemptId(job)}/${path.basename(localPath)}`;
      const stagingPath = resolveScopedPath(stagingRoot, stagingRelative);
      await sourceService.withIngestionLease(job, async () => {
        await stageParserInput({ stagingRoot, relative: stagingRelative, bytes, parserGid: config.documentParserGid });
      });
      return { localPath, stagingPath, parserPath: `/data/${stagingRelative}` };
    },
    releaseResolved: async (job, source, _resolved) => {
      const project = job.sourceProject;
      if (!project) throw new HttpError(409, "source_scope_unavailable", "The source workspace was not resolved.");
      await withProjectStorageMutation(project, () => removeSourceCopies({ projectRoot: project.baseDir, sourceId: source.id,
        jobIds: [job.id], generation: source.payload.generation, attemptId: sourceAttemptId(job), stagingOnly: true, parserStagingRoot: config.documentParserStagingDir }));
    },
    materialize: async (job, source, result) => {
      const project = job.sourceProject ?? await sourceProject(job);
      const generation = Number(source.payload?.generation);
      if (!Number.isSafeInteger(generation) || generation < 1) throw new HttpError(409, "source_generation_stale", "Source generation is invalid.");
      const relative = `knowledge-base/.evimed-derived/${source.id}/generation-${generation}-${job.id}-${sourceAttemptId(job)}/index.md`;
      const full = resolveScopedPath(project.baseDir, relative);
      const original = source.payload.paths?.[0] ?? source.id;
      const value = [
        `# ${path.posix.basename(String(original))}`,
        "",
        `Source: ${String(original)}`,
        `SHA-256: ${source.payload.fingerprint.sha256}`,
        `Extractor: ${result.extractor.name} ${result.extractor.version} (${result.extractor.parser})`,
        "",
        result.text,
        "",
      ].join("\n");
      await withProjectStorageMutation(project, async () => {
        await assertProjectCapacity(project, full, Buffer.byteLength(value), config);
        await writeFileAtomicNoFollow(project.baseDir, full, value, { encoding: "utf8", mode: 0o600 });
      });
      return relative;
    },
    discardMaterialized: async (job, source, _artifactPath) => {
      const project = job.sourceProject ?? await sourceProject(job);
      await withProjectStorageMutation(project, () => removeSourceCopies({ projectRoot: project.baseDir, sourceId: source.id,
        jobIds: [job.id], generation: source.payload.generation, attemptId: sourceAttemptId(job), parserStagingRoot: config.documentParserStagingDir }));
    },
    prepareCleanup: sourceProject,
    cleanupSource: async (_job, source, jobIds, project) => {
      await withProjectStorageMutation(project, () => removeSourceCopies({ projectRoot: project.baseDir, sourceId: source.id,
        jobIds, parserStagingRoot: config.documentParserStagingDir }));
    },
  }) : null;
  const autopilotService = productDocuments && productJobs ? new AutopilotService({
    documents: productDocuments, jobs: productJobs, usage: usageLedger, notifications: notificationService,
    capsules: capsuleService,
  }) : null;
  const autopilotRoutes = createAutopilotRoutes({ store, service: autopilotService, maxJsonBytes: config.maxJsonBytes });
  let autopilotWorker = null;
  let autopilotScheduleTimer = null;
  let autopilotScheduleRun = null;
  let consolidationScheduleTimer = null;
  let consolidationScheduleRun = null;
  let capsuleCleanupTimer = null;
  let capsuleCleanupRun = null;
  const retryCapsuleCleanup = () => {
    if (!capsuleTransferService) return Promise.resolve();
    if (capsuleCleanupRun) return capsuleCleanupRun;
    capsuleCleanupRun = maintenanceMutation(() => capsuleTransferService.recoverPendingDeletions())
      .then(async result => { if (result.pending) await securityAudit(config, "capsule.cleanup", "pending", result); })
      .catch((error) => {
        if (error?.code !== "maintenance_active") console.error("Capsule cleanup retry failed; protected pending state was retained.");
      })
      .finally(() => { capsuleCleanupRun = null; });
    return capsuleCleanupRun;
  };
  const researchSessions = new ResearchSessionStore(agentRegistry, { stateStore: store });
  const oidcService = new OidcService(config, store);
  const memosClient = new MemosClient(config, { fetchImpl: overrides.memosFetch ?? globalThis.fetch });
  const openVikingClient = overrides.openVikingClient
    ?? new OpenVikingClient(config, { fetchImpl: overrides.openVikingFetch ?? globalThis.fetch });
  // Which component ranks a recall. The records themselves stay in the
  // research-memory service whichever provider is selected.
  const memorySubstrate = new MemorySubstrate(config, { memos: memosClient, openViking: openVikingClient });
  const memoryIntelligence = new MemoryIntelligence(config, memosClient, {
    // A conversation that changes a memory the researcher confirmed is worth
    // telling them about, and the inbox is where that is told. It never holds
    // the write back: see contradictedValue in memoryIntelligence.mjs.
    notifications: notificationService,
    // The inbox failing must not cost the run its memory, and must not be
    // invisible either — the same pair the run-finished notice above takes.
    audit: async (event, error) => securityAudit(config, event, "failed", {
      code: typeof error?.code === "string" ? error.code : "notification_unavailable",
    }),
    fetchImpl: overrides.memoryExtractionFetch ?? globalThis.fetch,
  });
  const specialistClassifier = new SpecialistClassifier(config, {
    fetchImpl: overrides.specialistClassifierFetch ?? globalThis.fetch,
  });
  const coverageJudge = new CoverageJudge(config, {
    fetchImpl: overrides.coverageJudgeFetch ?? globalThis.fetch,
  });
  // One fan-out per live run. The browser subscribes here, never to a kernel.
  const runEvents = new RunEventHub();
  // The kernel's own live stream, decoded onto the same fan-out. The flag is
  // what the pump was given when a second kernel without a downlink could be
  // selected; there is one kernel now and it always publishes one.
  const runtimeEventPump = new RuntimeEventPump({
    runEvents,
    isDshKernel: true,
    // Sessions the runtime's own browser application creates. `agentRuns` is
    // assigned just below, so this reads it at call time rather than closing
    // over the binding before it exists.
    //
    // The pump holds only `{ userId, id }`; the ledger and the research-session
    // store both read from a project's directories, so they need the full
    // record. Handing them the pump's stub made both lookups fail quietly, and
    // a check that cannot see the research session adopts every session the
    // control plane is in the middle of starting.
    adoptSession: async (project, sessionId) => {
      const user = await store.userById(project.userId);
      if (!user) return null;
      const full = await store.requireProject(user, project.id);
      // Routed on what the person actually asked, exactly as a dispatch is.
      // Adoption used to file the run with no agent at all, which meant no
      // deliverable contract and so nothing for the delivery gate to check --
      // work that ran outside the evidence rules and was only labelled as such.
      // Each committed user turn carries its own input and request identity;
      // an existing conversation is not a permanent ownership exemption.
      const transcript = await runtimeManager.sessionTranscript(full, sessionId, { wake: false });
      return agentRuns.adoptRuntimeSession(full, sessionId, {
        transcript,
        routeTurn: (text) => routeAdoptedInput(full, sessionId, text),
      });
    },
    // The pump has already authenticated the runtime and attributed root and
    // child sessions to one project-scoped run. Feed that kernel-owned
    // sequence directly to the stall monitor; the model's workspace
    // projection remains useful UI detail, but is not the heartbeat.
    onRunActivity: (project, runId, activity) => agentRuns?.noteKernelActivity(project, runId, activity),
    // Recorded, not merely published: the browser shows a compaction card and
    // forgets it, while "does compaction ever fire, and what does it cost"
    // needs the ledger. Today the answer is expected to be "never" — the
    // control plane declares a 1,000,000-token window against a 400,000-token
    // run budget — and an empty column is exactly the measurement §6.5 asks for
    // before any threshold is touched.
    onCompaction: (project, runId, record) => {
      void agentRuns?.recordLearning(project, runId, {
        appendCompaction: {
          at: new Date().toISOString(),
          seq: record.seq,
          replaced: record.replaced,
          tokens: record.tokens,
          policy: config.runtimeCompactionPolicy ?? "basic",
        },
      }).catch(() => {});
    },
  });
  let agentRuns;
  const runtimeManager = new RuntimeManager(config, {
    agentRegistry,
    onRuntimeStop: (project, status) => {
      runtimeEventPump.detach(project);
      // Returned, not fired-and-forgotten here: `notifyRuntimeStop` already
      // wraps this call in its own `.catch()`, and returning the promise is
      // what keeps a rejection — a project whose ledger cannot be read,
      // oversized or corrupted — flowing through that existing handling
      // instead of becoming a second, unguarded unhandled rejection.
      return agentRuns?.closeProject(project, status);
    },
    onSessionAbort: (project, sessionId) => agentRuns?.cancelSession(project, sessionId),
    onRuntimeStart: (project, runtime) => {
      runtimeEventPump.attach(project, runtime);
      if (!runtimeManager.pluginOverrides.has(runtimeManager.key(project))) {
        void pluginService?.runtimeStarted(project).catch(() => { process.stderr.write("plugin first-launch verification enqueue failed\n"); });
      }
    },
  });
  runtimeManager.pluginService = pluginService;
  // The other half of the same seam. `syncCapsuleMethods` reads this before
  // every launch, and left unassigned it materializes an empty directory: the
  // work-style pack a user exported, imported and approved would reach no run,
  // and nothing would say so. Assigned beside `pluginService` because the two
  // have the same lifetime -- both are null exactly when no product database is
  // configured.
  runtimeManager.capsuleService = capsuleService;
  // And the other source of mountable methods. Without this assignment
  // `materializeCapsuleMethods` writes only capsule entries, which is what the
  // deployment did until 2026-09-10: approving a learned method changed nothing
  // anywhere, and the counters that decide whether one may be approved could
  // never move, because moving them requires the method to have been in a run.
  runtimeManager.learningService = learningService;
  if (pluginService) pluginService.runtimeGeneration = project => runtimeManager.runtimeGeneration(project);
  const pluginApplyWorker = pluginService ? new PluginApplyWorker({
    service: pluginService, runtime: runtimeManager,
    resolveProject: sourceProject,
    ledgerBusy: async project => (await agentRuns.list(project)).some(run => run.status === "running"),
  }) : null;
  agentRuns = new AgentRunStore(researchSessions, {
    agentRegistry,
    coverageJudge,
    model: `deepseek/${config.deepseekModel}`,
    // Both poll counts are periods of this interval. It was assumed rather than
    // passed, so the stall threshold silently meant a different amount of time
    // than its name suggested.
    monitorIntervalMs: AGENT_RUN_MONITOR_INTERVAL_MS,
    monitorMaxPolls: Math.max(1, Math.ceil(config.agentRunMonitorTimeoutMs / AGENT_RUN_MONITOR_INTERVAL_MS)),
    monitorStallPolls: Math.max(
      0,
      Math.ceil(Number(config.agentRunMonitorStallMs) / AGENT_RUN_MONITOR_INTERVAL_MS) || 0,
    ),
    readSessionHistory: (project, sessionId, options) => runtimeManager.sessionMessages(project, sessionId, options),
    readSessionStatus: (project, sessionId, options) => runtimeManager.sessionStatus(project, sessionId, options),
    readChildSessionActivity: (project, parentSessionId, childSessionIds) =>
      runtimeManager.childSessionActivity(project, parentSessionId, childSessionIds),
    runtimeWorkspaceRoot: (project) => runtimeManager.runtimeWorkspaceRoot(project),
    runtimeGeneration: (project) => runtimeManager.runtimeGeneration(project),
    // Which workspace a run belongs to, re-derived rather than remembered. It
    // is asked on recovery, so a verification in flight when the control plane
    // restarted has to answer the same as when it was dispatched — otherwise the
    // monitor looks for its verdict in the project workspace, finds nothing, and
    // records a verification that did run as one that never did. The id is
    // enough: the scratch path is a pure function of it.
    resolveRunProject: (project, run) => {
      if (autopilotService && verificationEpisodeId(run.dispatchId)) {
        return Promise.resolve(verificationRunProject(project, run.dispatchId));
      }
      return sourceUnderstandingRuntime
        ? sourceUnderstandingRuntime.resolveRunProject(project, run) : Promise.resolve(project);
    },
    // A run's own state changes ride the same stream as the kernel's events,
    // because from a user's point of view they are one story: "it is running",
    // "the second deliverable came back with three fixes", "it finished".
    onRunStateChanged: (project, run) => {
      runEvents.publish(run.id, "run/state", {
        state: run.status,
        // The nine-state projection (§7.1.1): `state` stays the ledger's own
        // four values so nothing that already reads it has to change; `phase`
        // is the added, richer read for whatever wants it — today's frontend
        // grouping among them.
        phase: run.phase ?? null,
        errorCode: run.errorCode ?? null,
        verification: run.verification ?? null,
        attempts: run.attempts ?? 0,
      });
      // The event pump's own session map, kept current on the same signal:
      // a fresh run's session becomes routable the moment the ledger knows
      // it, and a finished run's stops being routed at all.
      runtimeEventPump.noteRun(project, run);
    },
    // The run's own projection of itself — evidence counts and budget — read
    // off the monitor's existing cycle and forwarded on the same channel as
    // everything else about the run. Debounced on content by the store, so a
    // fixed-interval poll does not send the same frame forever.
    onRunProjection: (project, run, type, data) => {
      runEvents.publish(run.id, type, data);
    },
    onRunFinished: async (project, run) => {
      const evaluationRun = runtimeManager.evaluationMethodSnapshots.has(runtimeManager.key(project));
      runEvents.publish(run.id, "run/state", {
        state: run.status,
        phase: run.phase ?? null,
        errorCode: run.errorCode ?? null,
        verification: run.verification ?? null,
        attempts: run.attempts ?? 0,
      });
      runtimeEventPump.noteRun(project, run);
      if (sourceUnderstandingRuntime) {
        await sourceUnderstandingRuntime.complete(project, run).catch(async error => {
          await securityAudit(config, "source.runtime.release", "failed", {
            userId: project.userId, projectId: project.id, runId: run.id,
            code: typeof error?.code === "string" ? error.code : "runtime_stop_failed",
          });
        });
      }
      // An independent verification is not an episode: it owns its own bounded
      // runtime scope and folds into one claim, not into a digest fold.
      //
      // It is identified by its dispatch id, which is the one thing about the
      // run the dispatch layer cannot rewrite. The route reason cannot be used:
      // `AgentRunStore.dispatch` replaces the caller's value with
      // "session-binding" for every specialist-mode session, so keying on it
      // meant this whole fold never ran. The id is a reserved shape
      // (`episode-<32 hex>-v<n>`) that `/runs` refuses from a client, and
      // `recordVerification` still requires the named episode to hold a claim
      // carrying exactly this verification id, which is the ownership evidence.
      const verifiedEpisodeId = autopilotService ? verificationEpisodeId(run.dispatchId) : null;
      if (verifiedEpisodeId) {
        const verdict = await readVerificationVerdict(project, run);
        const spent = usageLedger ? await usageLedger.summaryRun(project.userId, run.dispatchId).catch(() => null) : null;
        await autopilotService.recordVerification(project.userId, {
          episodeId: verifiedEpisodeId, verificationId: run.dispatchId, runId: run.id,
          costCny: spent?.actualCost ?? 0,
          // Whether the separation was a fence or only a prompt. The scratch
          // workspace reaches the container on the direct path and not through
          // the privileged controller, whose start payload carries only
          // `{userId, projectId, activeWorkspace}` — so this deployment's mode
          // is what decides, and the tier a claim may reach follows it.
          isolated: config.runtimeControllerMode !== "socket",
          ...verdict,
        }).catch(error => securityAudit(config, "autopilot.verification.record", "failed", {
          userId: project.userId, projectId: project.id, runId: run.id,
          code: typeof error?.code === "string" ? error.code : "autopilot_verification_failed",
        }));
        if (runtimeManager.boundedRuntimeScope(project)?.runId === run.dispatchId) {
          await runtimeManager.endBoundedRuntime(project, run.dispatchId).catch(error => securityAudit(config, "autopilot.runtime.release", "failed", {
            userId: project.userId, projectId: project.id, runId: run.id,
            code: typeof error?.code === "string" ? error.code : "runtime_stop_failed",
          }));
        }
        // Last, and only after the verdict is in the claim: the scratch the run
        // was given exists to be thrown away, and it is inside the tree the
        // project's quota measures.
        await discardVerificationScratch(project, run.dispatchId).catch(error => securityAudit(config, "autopilot.verification.scratch", "failed", {
          userId: project.userId, projectId: project.id, runId: run.id,
          code: typeof error?.code === "string" ? error.code : "verification_scratch_remove_failed",
        }));
      }
      await completeOwnedAutopilotRun({
        service: autopilotService, runtimeManager, usageLedger,
        readDelta: async () => {
          let claims = [];
          let deltaSchemaVersion = null;
          let deltaErrorCode = null;
          const delta = (run.artifacts ?? []).find((artifact) => typeof artifact === "string" && artifact.endsWith("agenda-delta.json"));
          if (delta) {
            try {
              const file = resolveScopedPath(project.workspaceDir, delta);
              const parsed = JSON.parse(String(await readFileNoFollow(project.workspaceDir, file, "utf8")));
              deltaSchemaVersion = Number(parsed?.schemaVersion);
              if (Array.isArray(parsed?.claims)) claims = parsed.claims.slice(0, 500);
              else deltaErrorCode = "agenda_delta_claims_invalid";
            } catch { deltaErrorCode = "agenda_delta_unreadable"; }
          }
          return { claims, deltaSchemaVersion, deltaErrorCode };
        },
        audit: async (event, error) => securityAudit(config, event, "failed", {
          userId: project.userId, projectId: project.id, runId: run.id,
          code: typeof error?.code === "string" ? error.code
            : event === "autopilot.runtime.release" ? "runtime_stop_failed" : "autopilot_completion_failed",
        }),
      }, project, run);
      if (notificationService && !evaluationRun) {
        try {
          // Say what happened, in the notice itself. The mapping lives in
          // `notificationService.runFinishedNotice` so it is a tested pure
          // function rather than inline copy in a completion callback.
          const notice = runFinishedNotice(run);
          await notificationService.create(project.userId, {
            noticeType: "notify",
            title: notice.title,
            body: notice.body,
            // Without an action the card renders no control at all, so a
            // notice that names a run still could not open one. The frontend
            // turns this id into `/app/runs?run=<id>` rather than resolving it
            // server-side: an inbox action that resolves on the server would
            // have to know the frontend's routes.
            actions: [{ id: "open", label: "查看运行", style: "primary" }],
            projectId: project.id,
            source: { type: "run", id: run.id },
            idempotencyKey: `run-finished:${run.id}`,
          });
        } catch (error) {
          await securityAudit(config, "notification.agent_run.create", "failed", {
            userId: project.userId, projectId: project.id, runId: run.id,
            code: typeof error?.code === "string" ? error.code : "notification_unavailable",
          });
        }
      }
      // Write the run down before anything else can decide not to.
      //
      // This is the only moment the conversation is still readable: the
      // container is alive because the terminal write has not released it yet,
      // and `sessionTranscript` starts answering `runtime_not_running` shortly
      // afterwards. It sits above the Memos branch deliberately — that branch
      // returns early on a deployment with no memory service, and a deployment
      // without Memos is still a deployment whose runs should be learnable.
      //
      // Best effort, and it audits its own failure: a throw in this callback is
      // caught by `finishInternal` and then caught again, so a step that does
      // not report for itself fails invisibly.
      await trackLearningWrite((async () => {
        try {
          const sessions = await collectRunTranscripts(runtimeManager, project, run);
          const receipt = await persistRunTranscript({ project, run, sessions });
          await agentRuns.recordLearning(project, run.id, { transcript: receipt });
          if (receipt.completeness !== "complete") {
            await securityAudit(config, "run.transcript.persist", "partial", {
              userId: project.userId, projectId: project.id, runId: run.id,
              code: receipt.missing[0]?.reason ?? "incomplete",
            });
          }
          // What actually fed what, for the evaluation corpus.
          //
          // Every edge in all fifteen tool graphs is `via: "schema"` — a type
          // that *could* flow — and only an executed edge may carry a task, so
          // the brief generator honestly produced nothing. This is the receipt
          // that was missing; it costs one pass over the transcript already in
          // hand.
          try {
            const written = await persistExecutedToolEdges({ project, run, sessions });
            // The call sequence itself, not only the pairs it implies. The plan
            // builds the corpus "execute first, write the task second", and the
            // run that established the edges is the execution — so the golden
            // trace it asks for is read off the transcript rather than waiting
            // for a fixture harness that would only ever be a claim about it.
            const traced = await persistGoldenTraces({ project, run, sessions });
            if (written.edges || traced.traces) {
              await securityAudit(config, "run.tool.edges", "ok", {
                userId: project.userId, projectId: project.id, runId: run.id,
                code: `edges:${written.edges} traces:${traced.traces} steps:${traced.steps}`,
              });
            }
          } catch (error) {
            await securityAudit(config, "run.tool.edges", "failed", {
              userId: project.userId, projectId: project.id, runId: run.id,
              code: typeof error?.code === "string" ? error.code : "tool_edges_unavailable",
            });
          }
          // The counters the whole loop turns on.
          //
          // This is the producer `recordObservation` never had. Without it the
          // ledger's `learning` row records what was mounted and nothing about
          // what came of it, `learning.counts` stays at zero for every method,
          // and no inferred method can ever reach a paired evaluation — a
          // library that only ever grows candidates, which is indistinguishable
          // from a library with nothing worth promoting.
          //
          // It runs inside the transcript write on purpose: it needs the same
          // sessions, and both must finish before the run's container is let go.
          await recordMethodUse({ project, run, sessions });
        } catch (error) {
          await securityAudit(config, "run.transcript.persist", "failed", {
            userId: project.userId, projectId: project.id, runId: run.id,
            code: typeof error?.code === "string" ? error.code : "run_transcript_unavailable",
          });
        }
      })());
      // Evaluation receipts feed only the measured method. They must not
      // recursively distil benchmark answers or seed the researcher's memory.
      if (evaluationRun) return;
      // Queue the run for distillation when it is worth learning from.
      //
      // Trigger (b) of the plan's three: a package that needed at least one
      // repair round and was then accepted. That is the cheapest honest signal
      // the system has — the run was wrong in a specific, recorded way and then
      // became right — and unlike the other two triggers it needs no feedback
      // event, so it works on the day this ships.
      //
      // A run with no repair rounds is not queued. A loop that learns from
      // every success learns mostly that things usually work.
      if (learningWorker && productJobs && run.status === "succeeded") {
        const rounds = (run.repairRounds?.content ?? 0) + (run.repairRounds?.structural ?? 0);
        if (rounds >= 1 && run.transcript?.completeness === "complete") {
          await productJobs.enqueue(project.userId, "distill", {
            runId: run.id,
            trigger: "repair_accepted",
            repairRounds: run.repairRounds,
          }, {
            idempotencyKey: `distill:${run.id}:repair_accepted`,
            projectId: project.id,
          }).catch(async (error) => {
            await securityAudit(config, "learning.distill.enqueue", "failed", {
              userId: project.userId, projectId: project.id, runId: run.id,
              code: typeof error?.code === "string" ? error.code : "learning_enqueue_failed",
            });
          });
        }
      }
      if (!memosClient.configured) {
        if (config.requireMemos) {
          /** @type {Error & Record<string, any>} */
          const error = new Error("Required Memos run recording is unavailable.");
          error.code = "memory_required_unavailable";
          throw error;
        }
        return;
      }
      let messages = [];
      let historyError = null;
      try {
        messages = await runtimeManager.sessionMessages(project, run.sessionId, { wake: false });
      } catch (error) {
        // A structured run summary stays durable without the transcript, so this
        // is not fatal — but it was swallowed whole, and no transcript means no
        // memory sources, which means recordRun extracts nothing and reports
        // `source: "none"` as if the conversation simply held nothing worth
        // keeping. The two are indistinguishable in the audit line unless the
        // reason travels with it.
        historyError = error?.code ?? error?.name ?? "runtime_history_unavailable";
      }
      const memoryResult = await memoryIntelligence.recordRun(project, run, messages);
      // A run that extracted nothing, said so on the run itself.
      //
      // Extracting nothing is a legitimate outcome — twenty-three messages can
      // hold no durable fact — and it is also what a broken extractor looks
      // like. The counts separate them, and they were only in the security
      // ledger, which no API exposes. Appended only when the count is zero, so
      // an ordinary run gains no notice, and readable through /api/agent-runs
      // where the batch can collect the distribution.
      if (memoryResult.extracted === 0) {
        await agentRuns.appendQualityNotices(project, run.id, [
          `记忆抽取未产出记录：消息 ${messages.length} 条、候选 ${memoryResult.proposed} 条、`
          + `采纳 ${memoryResult.extracted} 条、驳回 ${memoryResult.rejected} 条`
          // A third cause of the same zero: the transcript was mostly our own
          // injected context, which the extractor refuses to read back as if
          // the user had said it.
          + `${memoryResult.excluded?.length ? `、未读取 ${memoryResult.excluded.map((item) => `${item.count} 条（${item.reason === "injected" ? "系统注入" : "回合未完成"}）`).join("")}` : ""}`
          + `${memoryResult.extractionError ? `（抽取报错：${memoryResult.extractionError}）` : ""}`
          + "。空对话与抽取失效在结果上一样，这行区分它们。",
        ], { unchecked: true }).catch(() => {});
      }
      // A record that was stored and then parked as `pending` looks, from the
      // outside, exactly like memory that is not learning: it is not recalled,
      // and nothing anywhere said why. The demotion is unchanged — see
      // demotionReason in memoryIntelligence.mjs for why it stays — this only
      // makes it legible. No `unchecked` flag: parking a memory says nothing
      // about whether the run's own deliverables were checked.
      if (memoryResult.pending > 0) {
        await agentRuns.appendQualityNotices(project, run.id, [
          `记忆已记录但暂缓生效 ${memoryResult.pending} 条：`
          + memoryResult.pendingReasons.map((item) => `${item.count} 条因${item.text}`).join("；")
          + "。记录与证据都已保存，可在记忆管理中确认后启用。",
        ]).catch(() => {});
      }
      // A memory the researcher had confirmed, changed by this conversation.
      // The change is in force — holding it back would refuse the researcher
      // their own restatement — so this is a notice, not a gate: it is how the
      // person finds out, and it is the distribution any later decision to hold
      // such a write back would have to be argued from. The inbox says the same
      // thing, and this says it where a deployment without a product database
      // can still read it.
      if ((memoryResult.conflicts?.length ?? 0) > 0) {
        // Two changes named and the rest counted, with short excerpts: a run
        // notice is truncated at 300 characters, and a line that is cut off
        // mid-sentence loses the part that says the old value is recoverable.
        // The inbox notice carries the full excerpts.
        const changed = memoryResult.conflicts.slice(0, 2).map((item) =>
          `「${item.key.slice(0, 40)}」由「${item.previousValue.slice(0, 30)}」改为「${item.nextValue.slice(0, 30)}」`);
        await agentRuns.appendQualityNotices(project, run.id, [
          `本次对话改写了 ${memoryResult.conflicts.length} 条你确认过的记忆：${changed.join("；")}`
          + `${memoryResult.conflicts.length > changed.length ? "等" : ""}`
          + "。新值已生效，原值保留在该记忆的修订记录中，可在记忆管理中改回。",
        ]).catch(() => {});
      }
      securityAudit(config, "memory.agent_run.record", "completed", {
        userId: project.userId,
        projectId: project.id,
        runId: run.id,
        runStatus: run.status,
        extracted: memoryResult.extracted,
        activated: memoryResult.activated,
        // The counts this handler already computes, in the one field the ledger
        // keeps. `extracted: 0` has several causes — no transcript, no
        // candidates proposed, every candidate rejected — and they were
        // indistinguishable.
        detail: [
          `messages=${messages.length}`,
          `source=${memoryResult.source}`,
          `proposed=${memoryResult.proposed}`,
          `extracted=${memoryResult.extracted}`,
          `rejected=${memoryResult.rejected}`,
          `pending=${memoryResult.pending ?? 0}`,
          `conflicts=${memoryResult.conflicts?.length ?? 0}`,
          ...(memoryResult.pendingReasons?.length
            ? [`parked=${memoryResult.pendingReasons.map((item) => `${item.reason}:${item.count}`).join("|")}`]
            : []),
          ...(memoryResult.excluded?.length
            ? [`excluded=${memoryResult.excluded.map((item) => `${item.reason}:${item.count}`).join("|")}`]
            : []),
          ...(memoryResult.rejectionReasons?.length ? [`why=${memoryResult.rejectionReasons.slice(0, 3).join("|")}`] : []),
          ...(memoryResult.extractionError ? [`error=${memoryResult.extractionError}`] : []),
          ...(historyError ? [`history=${historyError}`] : []),
        ].join(" "),
        extractionSource: memoryResult.source,
        proposed: memoryResult.proposed,
        rejected: memoryResult.rejected,
        rejectionReasons: memoryResult.rejectionReasons,
        pending: memoryResult.pending ?? 0,
        pendingReasons: memoryResult.pendingReasons ?? [],
        extractionError: memoryResult.extractionError,
      }).catch(() => {});
    },
    onRunFinishedError: async (error, project, run) => {
      await securityAudit(config, "memory.agent_run.record", "failed", {
        userId: project.userId,
        projectId: project.id,
        runId: run.id,
        runStatus: run.status,
        code: typeof error?.code === "string" ? error.code : "memory_unavailable",
        // The code alone says a call was rejected, not which one. Six different
        // requests reach this handler under one code, so without the message
        // the only way to find the failing endpoint is to probe each by hand.
        detail: String(error?.message ?? "").slice(0, 300),
      });
    },
  });
  if (sourceService) sourceUnderstandingRuntime = createSourceUnderstandingRuntime({
    config, store, sources: sourceService, agentRuns, runtimeManager, researchSessions,
    registry: agentRegistry, usageLedger, prepareContext: prepareResearchContext,
    cleanup: async (project, binding) => {
      const relative = binding.artifactDirectory;
      const match = /^knowledge-base\/\.evimed-derived\/(src_[a-f0-9]{32})\/generation-([1-9][0-9]*)-([A-Za-z0-9_-]+)-([a-f0-9]{24})$/.exec(relative ?? "");
      if (!match) throw new HttpError(409, "source_run_scope_unavailable", "The source cleanup scope is invalid.");
      await withProjectStorageMutation(project, () => removeSourceCopies({ projectRoot: project.baseDir,
        sourceId: match[1], generation: Number(match[2]), jobIds: [match[3]], attemptId: match[4] }));
    },
  });
  if (learningService && productJobs && config.learningEnabled) {
    learningRuntime = createLearningRuntime({
      config, store, agentRuns, runtimeManager, researchSessions,
      registry: agentRegistry, usageLedger, prepareContext: prepareResearchContext,
    });
    const dispatchLearningRun = (request) => learningRuntime.dispatch(request);
    const readLearningResult = (identity) => learningRuntime.readResult(identity);
    const distillation = new MethodDistillationRuns({
      dispatch: dispatchLearningRun,
      readResult: (identity) => readLearningResult({ ...identity, capabilityId: "method-distillation" }),
      learning: learningService, jobs: productJobs, notifications: notificationService,
    });
    const consolidation = new MethodConsolidation({
      dispatch: dispatchLearningRun,
      readResult: (identity) => readLearningResult({ ...identity, capabilityId: "method-relations" }),
      learning: learningService, jobs: productJobs, notifications: notificationService,
      // A paired evaluation dispatches hundreds of real runs, so it is opt-in:
      // with no command configured an `evaluate` job fails by name rather than
      // succeeding without having evaluated anything. When an operator does
      // configure one, it is spawned as its own process with the job's own
      // budget, and its stdout is expected to be the report the runner writes.
      evaluate: config.learningEvaluationCommand
        ? async (request) => {
          const controller = new AbortController();
          evaluationAbortControllers.add(controller);
          try { return await evaluateLearnedMethod({
          config, store, learning: learningService, capsules: capsuleService, runtimeManager,
          agentRuns, learningRuntime, commands, usageLedger,
          judge: async (cell, input) => {
            if (cell.judgeCalls >= 2 || typeof input?.system !== "string" || typeof input?.user !== "string") {
              throw new HttpError(400, "method_evaluation_judge_invalid", "Invalid or exhausted evaluation judge request.");
            }
            cell.judgeCalls += 1;
            const runtime = runtimeManager.runtimes.get(runtimeManager.key(cell.project));
            const address = server.address();
            if (!runtime?.modelGatewayToken || !runtime.modelGatewayScope || !address || typeof address === "string") {
              throw new HttpError(503, "method_evaluation_judge_unavailable", "The bounded judge runtime is unavailable.");
            }
            const response = await fetch(`http://127.0.0.1:${address.port}${MODEL_GATEWAY_PATH}`, {
              method: "POST", headers: { authorization: `Bearer ${runtime.modelGatewayToken}`, "content-type": "application/json" },
              body: JSON.stringify({ model: config.deepseekModel, stream: false, max_tokens: 4096,
                messages: [{ role: "system", content: input.system }, { role: "user", content: input.user }] }),
              signal: AbortSignal.timeout(120_000),
            });
            if (!response.ok) throw new HttpError(502, "method_evaluation_judge_failed", "The bounded evaluation judge failed.");
            const payload = /** @type {any} */ (await response.json());
            return { content: payload.choices?.[0]?.message?.content ?? "" };
          },
        }, request, { signal: controller.signal }); }
          finally { evaluationAbortControllers.delete(controller); }
        }
        : null,
      audit: (job, event, detail) => securityAudit(config, event, "recorded", {
        userId: job.userId, projectId: job.projectId,
        code: typeof detail?.verdict === "string" ? detail.verdict : "unknown",
        detail: `method=${detail?.methodId ?? ""}`,
      }),
    });
    learningWorker = new LearningWorker({
      jobs: productJobs, distillation, consolidation,
      enabled: config.learningEnabled,
      window: config.learningWindow,
      pollMs: config.learningPollMs,
      leaseMs: config.learningLeaseMs,
      resolveProject: async (job) => {
        const user = await store.userById(job.userId);
        return user ? store.requireProject(user, job.projectId) : null;
      },
      resolveRun: async (project, job) => {
        if (!project) return null;
        const runId = String(job.payload?.runId ?? "");
        return (await agentRuns.list(project)).find((run) => run.id === runId) ?? null;
      },
      // Transcript retention, which `config.transcriptRetentionDays` promised
      // and nothing delivered: `pruneRunTranscripts` had no caller, so the knob
      // read like a policy and behaved like a comment.
      maintain: async () => {
        await store.loadUsers();
        for (const user of [...store.users.values()]) {
          // One project's unreadable directory must not stop the sweep: the
          // point of a retention policy is that it runs, and a policy that
          // stops at the first awkward project is a policy that protects the
          // projects nobody looks at least of all.
          const projects = await store.listProjects(user).catch(() => []);
          for (const summary of projects) {
            try {
              const project = await store.requireProject(user, summary.id);
              const { removed } = await pruneRunTranscripts(project, { retentionDays: config.transcriptRetentionDays });
              if (removed.length) {
                await securityAudit(config, "run.transcript.prune", "ok", {
                  userId: user.id, projectId: project.id, code: `removed:${removed.length}`,
                });
              }
            } catch {
              // isolated: evimed_run_transcript_prune_failed_total
            }
          }
        }
      },
    });
  }
  if (autopilotService && config.autopilotEnabled) {
    const episodeAgents = {
      "literature-sentinel": "clinical-evidence-synthesis",
      "evidence-update": "clinical-evidence-synthesis",
      "data-prospecting": "dataset-research-scoping",
      "hypothesis-suggestion": "research-topic-selection",
      "writing-pipeline": "manuscript-support",
      "signal-monitoring": "adr-analysis",
    };
    autopilotWorker = new AutopilotWorker({
      jobs: productJobs,
    service: autopilotService,
    pollMs: config.autopilotPollMs,
    leaseMs: config.autopilotLeaseMs,
    busyDelayMs: Math.min(86_400_000, Math.max(5 * 60_000, Number(config.runtimeIdleTimeoutMs) + 60_000)),
    cancelDispatched: async ({ userId, projectId, sessionId, episodeId }) => {
      const user = await store.userById(userId);
      if (!user) return;
      const project = await store.requireProject(user, projectId);
      let cancellationError = null;
      try { await runtimeManager.cancelRuntimeSession(project, sessionId); }
      catch (error) { cancellationError = error; }
      let ledgerError = null;
      try { await agentRuns.cancelSession(project, sessionId); }
      catch (error) { ledgerError = error; }
      const boundedScope = runtimeManager.boundedRuntimeScope(project);
      let stopError = null;
      if (boundedScope && boundedScope.runId === episodeId) {
        try { await runtimeManager.endBoundedRuntime(project, episodeId); }
        catch (error) { stopError = error; }
        if (!stopError) cancellationError = null;
      }
      const failures = [cancellationError, ledgerError, stopError].filter(Boolean);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        const combined = /** @type {AggregateError & {code?:string}} */ (new AggregateError(failures, "Autopilot cancellation did not complete."));
        combined.code = failures[0]?.code ?? "autopilot_cancellation_failed";
        throw combined;
      }
    },
    // The second process: an independent re-check of one claim, in a fresh
    // session that was never told what the first run concluded or how, and in a
    // workspace that does not contain it. It is dispatched to the answer line
    // rather than to the capability that made the claim, and `verificationBrief`
    // re-projects the job payload here, at the last moment before a prompt
    // exists, so the only things that can reach the verifier are the claim and
    // its sources. The artifact its provenance names is carried in the payload
    // for the ledger and is never opened.
    //
    // Two separations, because a prompt is not an enforcement: the projection
    // bounds what the instructions say, and the scratch workspace bounds what
    // the run can open. The container mounts one directory, and this is it.
    // Memories are not attached and the knowledge base is not synchronized into
    // it for the same reason — the original run's own notes and its project's
    // library would put its reasoning back into the room. The verifier resolves
    // the sources it was given through the public source gateway, which is what
    // the claim's DOIs and PMIDs are for.
    dispatchVerification: async (verification) => {
      const user = await store.userById(verification.userId);
      if (!user) throw new HttpError(404, "autopilot_account_unavailable", "Autopilot account is unavailable.");
      const project = await store.requireProject(user, verification.projectId);
      const agenda = await autopilotService.get(user.id, verification.agendaId);
      const brief = verificationBrief(verification);
      const prompt = verificationPrompt(brief);
      const dailyLimit = minimumPositive(agenda.payload.dailyBudgetCny, config.userDailySpendLimit);
      const weeklyLimit = minimumPositive(agenda.payload.weeklyBudgetCny, config.userWeeklySpendLimit);
      const runLimit = Number(verification.budgetCny);
      if (!Number.isFinite(runLimit) || runLimit <= 0) {
        throw new HttpError(400, "autopilot_payload_invalid", "A verification needs a positive share of the episode budget.");
      }
      // Verification spends money, so it asks the same question the episode
      // asked before it spent any: an account already at its ceiling leaves the
      // claim at "gated" instead of promoting it unchecked. The share it spends
      // was held back from the episode's own budget at schedule time, so a night
      // that used everything it was given has not eaten its own second opinion.
      if (usageLedger) await usageLedger.assertWithinLimits(user.id, { dailyLimit, weeklyLimit });
      const registry = await agentRegistry;
      const selected = registry.get(OPEN_DOMAIN_ANSWER_AGENT_ID);
      if (!selected) throw new HttpError(503, "autopilot_capability_unavailable", "Autopilot capability is unavailable.");
      const scoped = verificationRunProject(project, verification.verificationId);
      await withProjectStorageMutation(project, async () => {
        // `docker run --mount type=bind` refuses a source that does not exist,
        // so the directory is made before the runtime is reserved.
        //
        // No capacity check of its own: `reserveBoundedRuntimeSession` starts
        // the runtime on the next line and `startAdmitted` refuses an
        // over-quota project there, walking the same tree for the same verdict.
        // What the directory needs is not a second gate but an owner, and the
        // sweep below is it -- including on the failure path, so a dispatch
        // refused for quota does not leave the empty directory it just made.
        const opened = await openScopedDirectoryNoFollow(project.baseDir, scoped.workspaceDir, { create: true });
        await opened.handle.close();
      });
      // The reservation is inside the try, not before it: the failures a nightly
      // agenda actually hits -- the project's runtime busy with something else,
      // the project over its storage quota -- are raised by this call, and a
      // handler that started after it swept nothing on exactly those.
      try {
        const session = await runtimeManager.reserveBoundedRuntimeSession(scoped, {
          runId: verification.verificationId, dailyLimit, weeklyLimit, runLimit,
        });
        await researchSessions.put(scoped, session.id, {
          mode: "specialist", agentId: selected.id, agentVersion: selected.version,
        });
        const run = await agentRuns.dispatch(scoped, {
          sessionId: session.id,
          dispatchId: verification.verificationId,
          question: prompt,
          effectiveAgentId: selected.id,
          effectiveAgentVersion: selected.version,
          effectiveRuntimeAgent: selected.runtimeAgent,
          // Recorded only if the session is not specialist-bound; the dispatch
          // layer substitutes "session-binding" for one that is. Nothing reads
          // it back — the completion fold identifies a verification by its
          // dispatch id — but the caller still says what it dispatched.
          effectiveRouteReason: VERIFICATION_ROUTE_REASON,
        }, async (binding, dispatchedRun) => {
          const prepared = await prepareResearchContext({ ...scoped, baseDir: scoped.workspaceDir }, binding, config, {
            query: prompt, memories: [], memoryError: null, specialists: [],
            routedSpecialist: {
              agentId: selected.id, agentVersion: selected.version, runtimeAgent: selected.runtimeAgent,
              skill: selected.skill, companionSkills: selected.companionSkills,
            },
          });
          const budgetMarker = issueModelGatewayBudgetMarker({
            secret: config.modelGatewaySigningSecret, userId: user.id, projectId: project.id,
            runId: verification.verificationId, dailyLimit, weeklyLimit, runLimit,
          });
          return runtimeManager.dispatchPrompt(scoped, session.id, {
            text: `<evimed-autopilot-verification>${verification.verificationId}</evimed-autopilot-verification>\n${budgetMarker}\n${prompt}`,
            system: prepared.system, agent: selected.runtimeAgent, strictContext: true,
            model: `deepseek/${config.deepseekModel}`, runId: dispatchedRun.id, allowBounded: true,
            requestId: dispatchedRun.kernelRequestIds?.at(-1),
          });
        });
        return { runId: run.id, sessionId: session.id };
      } catch (error) {
        await runtimeManager.endBoundedRuntime(scoped, verification.verificationId).catch(() => {});
        // A dispatch that failed leaves the same directory behind as one that
        // ran, and no completion fold is ever called for it. The dispatch
        // failure is the one that travels; this one is recorded, because a
        // scratch directory nobody removed is invisible until the quota walk
        // trips over it.
        await discardVerificationScratch(project, verification.verificationId)
          .catch(scratchError => securityAudit(config, "autopilot.verification.scratch", "failed", {
            userId: project.userId, projectId: project.id,
            code: typeof scratchError?.code === "string" ? scratchError.code : "verification_scratch_remove_failed",
          }));
        throw error;
      }
    },
    dispatchEpisode: async (episode) => {
        const user = await store.userById(episode.userId);
        if (!user) throw new HttpError(404, "autopilot_account_unavailable", "Autopilot account is unavailable.");
        const project = await store.requireProject(user, episode.projectId);
        const agenda = await autopilotService.get(user.id, episode.agendaId);
        if (usageLedger) await usageLedger.assertWithinLimits(user.id, {
          dailyLimit: Number(agenda.payload.dailyBudgetCny) || 0,
          weeklyLimit: Number(agenda.payload.weeklyBudgetCny) || 0,
        });
        const registry = await agentRegistry;
        const selected = registry.get(episodeAgents[episode.taskType]);
        if (!selected) throw new HttpError(503, "autopilot_capability_unavailable", "Autopilot capability is unavailable.");
        const dailyLimit = minimumPositive(agenda.payload.dailyBudgetCny, config.userDailySpendLimit);
        const weeklyLimit = minimumPositive(agenda.payload.weeklyBudgetCny, config.userWeeklySpendLimit);
        const session = await runtimeManager.reserveBoundedRuntimeSession(project, {
          runId: episode.episodeId,
          dailyLimit,
          weeklyLimit,
          runLimit: Number(episode.budgetCny),
        });
        try {
          await researchSessions.put(project, session.id, {
            mode: "specialist", agentId: selected.id, agentVersion: selected.version,
          });
          const run = await agentRuns.dispatch(project, {
            sessionId: session.id,
            dispatchId: episode.dispatchId,
            question: episode.prompt,
            effectiveAgentId: selected.id,
            effectiveAgentVersion: selected.version,
            effectiveRuntimeAgent: selected.runtimeAgent,
            effectiveRouteReason: `autopilot:${episode.taskType}`,
          }, async (binding, dispatchedRun, repairText = null) => {
            try {
              await autopilotService.markEpisodeDispatched(user.id, episode.episodeId, { runId: dispatchedRun.id, sessionId: session.id });
            } catch (error) {
              await autopilotService.queueDispatchedCancellation(user.id, episode.episodeId, { runId: dispatchedRun.id, sessionId: session.id });
              throw error;
            }
            const promptText = typeof repairText === "string" && repairText.trim() ? repairText : episode.prompt;
            let memories = [];
            let memoryError = null;
            try { memories = await memorySubstrate.recall(user.id, episode.prompt, { projectId: project.id, sessionId: session.id }); }
            catch (error) {
              memoryError = error instanceof HttpError ? error.code : "memory_unavailable";
              if (config.requireMemos) throw error;
            }
            const prepared = await prepareResearchContext(project, binding, config, {
              query: episode.prompt,
              memories,
              memoryError,
              specialists: [],
              routedSpecialist: {
                agentId: selected.id,
                agentVersion: selected.version,
                runtimeAgent: selected.runtimeAgent,
                skill: selected.skill,
                companionSkills: selected.companionSkills,
              },
            });
            const budgetMarker = issueModelGatewayBudgetMarker({
              secret: config.modelGatewaySigningSecret, userId: user.id, projectId: project.id,
              runId: episode.episodeId, dailyLimit,
              weeklyLimit, runLimit: Number(episode.budgetCny),
            });
            return runtimeManager.dispatchPrompt(project, session.id, {
              text: `<evimed-autopilot-episode>${episode.episodeId}</evimed-autopilot-episode>\n${budgetMarker}\n${promptText}`,
              system: prepared.system, agent: selected.runtimeAgent, strictContext: true,
              model: `deepseek/${config.deepseekModel}`, runId: dispatchedRun.id, allowBounded: true,
              requestId: dispatchedRun.kernelRequestIds?.at(-1),
            });
          });
          if (run.status === "running") {
            await autopilotService.markEpisodeDispatched(user.id, episode.episodeId, { runId: run.id, sessionId: session.id });
          }
          return { runId: run.id, sessionId: session.id };
        } catch (error) {
          const existing = (await agentRuns.list(project)).find((run) => run.dispatchId === episode.dispatchId);
          if (existing) {
            if (existing.status !== "running") return { runId: existing.id, sessionId: session.id };
            const currentEpisode = await autopilotService.getEpisode(user.id, episode.episodeId).catch(() => null);
            if (currentEpisode && ["merged", "failed", "canceled", "verifying"].includes(currentEpisode.payload.status)
              && currentEpisode.payload.runId === existing.id) {
              return { runId: existing.id, sessionId: session.id };
            }
            try {
              await autopilotService.markEpisodeDispatched(user.id, episode.episodeId, { runId: existing.id, sessionId: session.id });
              return { runId: existing.id, sessionId: session.id };
            } catch (bindingError) {
              try {
                await autopilotService.queueDispatchedCancellation(user.id, episode.episodeId, { runId: existing.id, sessionId: session.id });
                return { runId: existing.id, sessionId: session.id };
              } catch (queueError) {
                let releaseError = null;
                try { await runtimeManager.endBoundedRuntime(project, episode.episodeId); }
                catch (failure) { releaseError = failure; }
                const failures = [bindingError, queueError, releaseError].filter(Boolean);
                const combined = /** @type {AggregateError & {code?:string}} */ (new AggregateError(failures, "Autopilot run identity could not be persisted."));
                combined.code = failures[0]?.code ?? "autopilot_dispatch_identity_failed";
                throw combined;
              }
            }
          }
          let releaseError = null;
          try { await runtimeManager.endBoundedRuntime(project, episode.episodeId); }
          catch (failure) { releaseError = failure; }
          if (releaseError) {
            const combined = /** @type {AggregateError & {code?:string}} */ (new AggregateError([error, releaseError], "Autopilot initialization and runtime release failed."));
            combined.code = error?.code ?? "autopilot_initialization_failed";
            throw combined;
          }
          throw error;
        }
      },
    });
  }
  const capsuleGatewayHandler = createCapsuleGatewayHandler({ runtimeManager, store, service: capsuleService });
  const revisionGatewayHandler = createRevisionGatewayHandler({ runtimeManager, store, agentRuns });
  const modelGatewayHandler = createModelGatewayHandler(config, runtimeManager, {
    fetchImpl: overrides.modelGatewayFetch ?? globalThis.fetch,
    usageLedger,
  });
  // The evaluation corpus needs both arms to see byte-identical upstream
  // answers, so the gateway's fetch is replaceable by a fixture reader. Neither
  // knob is set in production, and setting the replay one makes a miss a named
  // failure rather than a live request.
  const gatewayFetch = resolveGatewayFetch(process.env, overrides.publicSourceFetch ?? globalThis.fetch);
  const publicSourceGatewayHandler = createPublicSourceGatewayHandler(config, runtimeManager, {
    fetchImpl: gatewayFetch,
    connectorCredentials,
  });
  const connectorCredentialGatewayHandler = createConnectorCredentialGatewayHandler({ runtimeManager, store: connectorCredentials });
  const webSearchGatewayHandler = createWebSearchGatewayHandler(config, runtimeManager, {
    fetchImpl: overrides.webSearchFetch ?? globalThis.fetch,
  });
  const geoProbeGatewayHandler = createGeoProbeGatewayHandler(config, runtimeManager, {
    fetchImpl: overrides.geoProbeFetch ?? globalThis.fetch,
  });
  const commands = createCommandRegistry({ config, runtimeManager });
  const taskManager = new TaskManager(config, (command, args, ctx) => commands.invoke(command, args, ctx), {
    claimAllowed: () => maintenanceService ? maintenanceService.claimingAllowed() : !productDatabase,
  });
  const rateLimiter = new FixedWindowRateLimiter();
  const authRateLimiter = new FixedWindowRateLimiter();
  const commandRateLimiter = new FixedWindowRateLimiter();
  const operationalMetrics = new OperationalMetrics();
  let activeCommands = 0;
  let startupRuntimeCleanup = null;
  let backgroundReady = false;
  let recurringWorkStarted = false;
  if (productDatabase) {
    maintenanceService = new MaintenanceService(productDatabase, {
      inspectActivity: async () => {
        const projects = await store.listStoredProjects();
        const runtimeStats = runtimeManager.statsAll();
        let runningAgentRuns = 0;
        let busy = 0;
        let idle = 0;
        let unknown = Number(runtimeStats.starting) || 0;
        const observations = await Promise.all(projects.map(async (project) => {
          const running = (await agentRuns.list(project)).filter((run) => run.status === "running").length;
          if (!runtimeManager.runtimeGeneration(project)) return { running, busy: 0, idle: 0, unknown: 0 };
          try {
            const runtimeBusy = await runtimeManager.pluginRuntimeBusy(project);
            return { running, busy: runtimeBusy ? 1 : 0, idle: runtimeBusy ? 0 : 1, unknown: 0 };
          } catch { return { running, busy: 0, idle: 0, unknown: 1 }; }
        }));
        for (const observation of observations) {
          runningAgentRuns += observation.running;
          busy += observation.busy;
          idle += observation.idle;
          unknown += observation.unknown;
        }
        const classified = busy + idle + Math.max(0, unknown - (Number(runtimeStats.starting) || 0));
        unknown += Math.max(0, (Number(runtimeStats.running) || 0) - classified);
        const backgroundOperations = [
          notificationRun,
          capsuleCleanupRun,
          autopilotScheduleRun,
          pluginApplyWorker?.running,
          memoryIndexWorker?.status?.().running,
          memoryIndexWorker?.reconciling,
          sourceWorker?.status?.().running,
          autopilotWorker?.status?.().running,
          learningWorker?.status?.().running,
        ].filter(Boolean).length;
        return {
          activeCommands,
          activeTasks: taskManager.statsAll().active,
          backgroundOperations,
          runningAgentRuns,
          runtimes: { busy, idle, unknown },
        };
      },
    });
    maintenanceService.subscribe((state) => {
      if (state === "open") {
        taskManager.resumeClaims();
        if (backgroundReady) {
          void startRecurringWork().catch(() => { process.stderr.write("background work did not resume after maintenance\n"); });
        }
      } else pauseRecurringWork();
    });
  }

  /**
   * The contract an adopted session should be graded against.
   *
   * The same two steps a dispatch takes -- the named/regex router and the model
   * classifier, then the answer line for anything they do not claim -- reading
   * the question out of the session's own transcript instead of a request body.
   * @param {Record<string, any>} project @param {string} sessionId @param {string} text
   */
  async function routeAdoptedInput(project, sessionId, text) {
    if (!text) return {};
    const binding = await researchSessions.get(project, sessionId);
    await assertPublicSessionPrompt(project, sessionId, binding);
    if (binding?.mode === "specialist") return {
      effectiveAgentId: binding.agentId, effectiveAgentVersion: binding.agentVersion,
      effectiveRuntimeAgent: binding.runtimeAgent, effectiveRouteReason: "session-binding",
    };
    const registry = await agentRegistry;
    const routableAgents = registry.list().filter((agent) => agent.id !== OPEN_DOMAIN_ANSWER_AGENT_ID);
    const named = routeNamedSpecialist(text, routableAgents);
    /** @type {{ failure?: string, verdict?: string }} */
    const trace = {};
    const specialist = named ?? await specialistClassifier.classify(text, routableAgents, trace)
      ?? routeOpenDomainSpecialist(text, routableAgents, { afterCleanNone: trace.verdict === "none" });
    const answerAgent = specialist ? null : registry.get(OPEN_DOMAIN_ANSWER_AGENT_ID);
    const effective = specialist ?? (answerAgent
      ? {
          agentId: answerAgent.id,
          agentVersion: answerAgent.version,
          runtimeAgent: answerAgent.runtimeAgent,
          reason: "unrouted:open-domain",
        }
      : null);
    return {
      question: text,
      effectiveAgentId: effective?.agentId ?? null,
      effectiveAgentVersion: effective?.agentVersion ?? null,
      effectiveRuntimeAgent: effective?.runtimeAgent ?? null,
      effectiveRouteReason: effective?.reason ?? null,
    };
  }

  async function assertPublicAgent(agentId) {
    if ((await agentRegistry).get(agentId)?.visibility === "internal") {
      throw new HttpError(403, "agent_background_only", "Source understanding is managed from Sources; adjust or retry the source there.");
    }
  }

  async function assertPublicSessionPrompt(project, sessionId, knownBinding = undefined) {
    const binding = knownBinding ?? await researchSessions.get(project, sessionId);
    if (binding?.mode === "specialist") await assertPublicAgent(binding.agentId);
  }

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
    let releaseMutation = null;
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
    // The gateways answer before the try block below, so nothing they do
    // reaches errorAudit. Give them the same ledger and the same metric label
    // the API routes get, through the one funnel each of them already has.
    const recordGatewayFailure = (failure) => {
      operationErrorCode = typeof failure?.code === "string" ? failure.code : "gateway_failed";
      void appendErrorRecord(config, req, pathname, {
        status: Number.isSafeInteger(failure?.status) ? failure.status : 502,
        code: operationErrorCode,
        requestId,
        truncated: failure?.truncated === true,
      });
    };
    const gateway = pathname.startsWith(`${CAPSULE_GATEWAY_PATH}/`)
      ? capsuleGatewayHandler
      : pathname === MODEL_GATEWAY_PATH
      ? modelGatewayHandler
      : pathname === REVISION_GATEWAY_PATH
        ? revisionGatewayHandler
      : pathname === PUBLIC_SOURCE_GATEWAY_PATH
        ? publicSourceGatewayHandler
      : pathname === CONNECTOR_CREDENTIAL_GATEWAY_PATH
        ? connectorCredentialGatewayHandler
        : pathname === WEB_SEARCH_GATEWAY_PATH
          ? webSearchGatewayHandler
          : pathname === GEO_PROBE_GATEWAY_PATH
            ? geoProbeGatewayHandler
            : null;
    if (gateway) {
      try {
        await gateway(req, res, recordGatewayFailure);
      } catch (error) {
        // These handlers answer before the try below, so anything they throw
        // past their own catch used to land as an unhandled rejection on
        // `void handle(req, res)` — the process exiting rather than a 502.
        recordGatewayFailure({
          code: "gateway_handler_failed",
          status: 502,
          truncated: res.headersSent && !res.writableEnded,
        });
        if (res.headersSent || res.destroyed) {
          if (!res.destroyed) res.destroy();
        } else {
          sendJson(res, 502, { error: { code: "gateway_handler_failed", message: "The gateway failed." } });
        }
      }
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    try {
      enforceRequestRateLimits(req, pathname);
      if (pathname === "/api/ops/maintenance" && ["GET", "POST"].includes(req.method)) {
        if (!maintenanceService) throw new HttpError(404, "not_found", "Route not found.");
        assertMaintenanceAccess(req, config);
        if (req.method === "GET") {
          sendJson(res, 200, { data: await maintenanceService.status() });
          return;
        }
        const body = assertObject(await readJson(req, config.maxJsonBytes), "maintenance request");
        const action = assertString(body.action, "maintenance action", { max: 16 });
        let data;
        if (action === "request") {
          data = await maintenanceService.request({ requestId: body.requestId, ttlSeconds: body.ttlSeconds });
        } else if (action === "release") {
          data = await maintenanceService.release({ requestId: body.requestId });
        } else {
          throw new HttpError(400, "maintenance_request_invalid", "Maintenance action must be request or release.");
        }
        sendJson(res, 200, { data });
        return;
      }
      await store.assertCsrf(req, pathname);
      if (maintenanceService && requestStartsMutation(req, pathname)) {
        releaseMutation = await maintenanceService.admitMutation();
      }
      if (await pluginRoutes(req, res)) return;
      if (await capsuleRoutes(req, res)) return;
      if (await notificationRoutes(req, res)) return;
      if (await learningRoutes(req, res)) return;
      if (await sourceRoutes(req, res)) return;
      if (await autopilotRoutes(req, res)) return;

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
        if (maintenanceService && (await maintenanceService.status()).state !== "open") {
          throw new HttpError(503, "maintenance_active", "The service is temporarily draining for maintenance.");
        }
        const readiness = await readinessStatus(config, store, runtimeManager, memosClient, memOsEngine, memoryIndexWorker, usageLedger, notificationService, documentParser, openListConnector, productDatabase, memorySubstrate);
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
          memorySubstrate,
          memOsEngine,
          memoryIndexWorker,
          usageLedger,
          notificationService,
          documentParser,
          openList: openListConnector,
          productDatabase,
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

      if (pathname === "/api/auth/register" && req.method === "POST") {
        // Registration exists only where a password is the credential. Under
        // OIDC the identity provider owns the account, and under development
        // auth there is nothing to register into.
        if (config.authMode !== "local") {
          throw new HttpError(404, "auth_method_disabled", "Local password authentication is disabled.");
        }
        if (!config.selfRegistrationEnabled) {
          throw new HttpError(403, "self_registration_disabled", "This deployment does not accept new accounts.");
        }
        let username = "";
        try {
          const body = await readJson(req, config.maxJsonBytes);
          username = assertString(body.username, "username", { max: 64 });
          const password = assertString(body.password, "password", { max: 4096 });
          const name = body.name === undefined ? username : assertString(body.name, "name", { max: 64 });
          await store.createUser(username, password, name);
          // Signed in by the same call. A registration that leaves someone on
          // the login page has them type the credential they just chose, and
          // the first thing they learn about the product is that it did not
          // notice.
          const login = await store.login(username, password, req, res);
          await securityAudit(config, "auth.register", "completed", { username });
          sendJson(res, 201, { data: login });
        } catch (err) {
          await securityAudit(config, "auth.register", "failed", {
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
        // A browser remembers its project and sends it on every request,
        // including this one. Deleting that project — from another device, or
        // from this one with the tab still open — used to make this route 404,
        // and this route is what the shell asks before it renders anything: the
        // account became unopenable, and logging in again did not help because
        // the browser sent the same dead id. Falling back to the default here
        // is what lets the answer say which project was actually selected, so
        // the browser can correct itself.
        const project = await store.selectedProject(req, user).catch(async (error) => {
          if (error?.code !== "project_not_found") throw error;
          return store.defaultProject(user);
        });
        sendJson(res, 200, {
          data: {
            user: store.publicUser(user),
            tenant: { id: user.tenantId ?? user.id, model: "individual-account", role: "owner" },
            project: { id: project.id, name: project.name },
            projects: await store.listProjects(user),
            csrfToken: session.csrfToken,
            // Which session view this deployment serves. The browser must not
            // infer it from a build flag: the view reads the control plane's
            // own `RunEvent` stream, and it is the server that knows what it
            // serves. The field stayed after the second view was retired
            // because a browser bundle older than this server still asks.
            runtime: {
              kernel: RUNTIME_KERNEL_NAME,
              sessionView: "run-stream",
              // Where the kernel's own browser application is served. Empty
              // when this deployment does not serve it, which is how the shell
              // knows to render its own session view instead of a frame.
              uiOrigin: config.runtimeUiProxyEnabled ? String(config.runtimeUiPublicOrigin ?? "") : "",
            },
          },
        });
        return;
      }

      if (pathname === "/api/runtime-ui/frames" && req.method === "POST") {
        if (!config.runtimeUiProxyEnabled) throw new HttpError(404, "runtime_ui_not_enabled", "The native UI is not enabled.");
        const { user, session } = await store.ensureSessionUser(req, res, { allowDevAuth: false });
        if (req.headers["x-open-science-csrf"] !== session.csrfToken) throw new HttpError(403, "csrf_required", "A valid CSRF token is required.");
        const body = assertObject(await readJson(req, config.maxJsonBytes), "runtime UI frame");
        if (Object.keys(body).some((key) => key !== "projectId")) throw new HttpError(400, "runtime_ui_frame_payload_invalid", "Only projectId is accepted.");
        const projectId = assertString(body.projectId, "projectId", { max: 128 });
        const project = await store.requireProject(user, projectId);
        const frame = issueRuntimeUiFrame({ config, req, user, session, project });
        res.setHeader("Set-Cookie", frame.cookie);
        res.setHeader("Cache-Control", "no-store");
        sendJson(res, 201, { data: { frameId: frame.frameId, frameUrl: frame.frameUrl, expiresAt: frame.expiresAt, renewalToken: frame.renewalToken } });
        return;
      }

      if (pathname.startsWith("/api/runtime-ui/frames/") && pathname.endsWith("/renew") && req.method === "POST") {
        if (!config.runtimeUiProxyEnabled) throw new HttpError(404, "runtime_ui_not_enabled", "The native UI is not enabled.");
        const { user, session } = await store.ensureSessionUser(req, res, { allowDevAuth: false });
        if (req.headers["x-open-science-csrf"] !== session.csrfToken) throw new HttpError(403, "csrf_required", "A valid CSRF token is required.");
        const body = assertObject(await readJson(req, 8192), "runtime UI frame renewal");
        if (Object.keys(body).some((key) => key !== "renewalToken")) throw new HttpError(400, "runtime_ui_frame_payload_invalid", "Only the original renewal proof is accepted.");
        const frameId = pathname.slice("/api/runtime-ui/frames/".length, -"/renew".length);
        const renewalToken = assertString(body.renewalToken, "renewalToken", { max: 4096 });
        const frame = renewRuntimeUiFrame({ config, req, user, session, frameId, renewalToken });
        await store.requireProject(user, frame.claims.projectId);
        runtimeUi.refreshFrameBinding(frame);
        res.setHeader("Set-Cookie", frame.cookie);
        res.setHeader("Cache-Control", "no-store");
        sendJson(res, 200, { data: { frameId: frame.frameId, frameUrl: frame.frameUrl, expiresAt: frame.expiresAt, renewalToken: frame.renewalToken } });
        return;
      }

      if (pathname.startsWith("/api/runtime-ui/frames/") && req.method === "DELETE") {
        const { session } = await store.ensureSessionUser(req, res, { allowDevAuth: false });
        if (req.headers["x-open-science-csrf"] !== session.csrfToken) throw new HttpError(403, "csrf_required", "A valid CSRF token is required.");
        const frameId = pathname.slice("/api/runtime-ui/frames/".length);
        // This expires the browser's exact Path cookie, not the signed ticket.
        // Existing connections and other frame cookies remain untouched.
        res.setHeader("Set-Cookie", releaseRuntimeUiFrameCookie(config, frameId));
        sendJson(res, 200, { data: true });
        return;
      }

      if (pathname === "/api/agents" && req.method === "GET") {
        await store.ensureUser(req, res);
        // The default open-domain answer handler is not a user-selectable specialist.
        sendJson(res, 200, {
          data: (await agentRegistry).list().filter((agent) => agent.id !== OPEN_DOMAIN_ANSWER_AGENT_ID),
        });
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
          // The decision itself, as an event. An audit line records that a
          // request happened; this records what the researcher decided, in a
          // form later steps can count and read.
          await recordFeedback(ctx, () => feedbackEvents?.recordMemoryUpdate(ctx.user.id, {
            before: existing, after: updated, projectId: ctx.project.id,
          }));
          sendJson(res, 200, { data: updated });
          return;
        }
        if (req.method === "DELETE") {
          // Read before deleting: what was rejected is the whole content of the
          // event, and after the delete there is nothing left to name it by.
          const rejected = await memosClient.getRecord(ctx.user.id, recordId);
          await memosClient.deleteRecord(ctx.user.id, recordId);
          await audit(ctx, "memory.record.delete", "completed", { target: recordId });
          await recordFeedback(ctx, () => feedbackEvents?.recordMemoryDeletion(ctx.user.id, {
            record: rejected, projectId: ctx.project.id,
          }));
          sendJson(res, 200, { data: true });
          return;
        }
      }

      if (pathname === "/api/feedback/events" && req.method === "GET") {
        const ctx = await context(req, res);
        const service = requireFeedbackEvents();
        const url = new URL(req.url ?? "/", apiBaseFromRequest(req, config));
        const subjectType = url.searchParams.get("subjectType");
        const subjectId = url.searchParams.get("subjectId");
        sendJson(res, 200, { data: await service.list(ctx.user.id, {
          trigger: url.searchParams.get("trigger") || null,
          subject: subjectType && subjectId ? { type: subjectType, id: subjectId } : null,
          limit: Number(url.searchParams.get("limit") ?? 50) || 50,
          cursor: url.searchParams.get("cursor"),
        }) });
        return;
      }

      // Only the two deliverable triggers. The memory triggers are recorded by
      // the memory routes above from what actually changed, and a client that
      // could post "the user accepted this inference" could manufacture the
      // evidence the extractor is supposed to earn.
      if (pathname === "/api/feedback/events" && req.method === "POST") {
        const ctx = await context(req, res);
        const service = requireFeedbackEvents();
        const body = assertObject(await readJson(req, config.maxJsonBytes), "feedback event");
        const unknown = Object.keys(body).filter((field) => !["trigger", "runId", "path", "summary"].includes(field));
        if (unknown.length > 0) {
          throw new HttpError(400, "feedback_event_invalid", `Unknown feedback field(s): ${unknown.sort().join(", ")}.`);
        }
        const trigger = assertString(body.trigger, "trigger", { max: 64 });
        if (!["deliverable-adopted", "deliverable-edited"].includes(trigger)) {
          throw new HttpError(400, "feedback_event_invalid", "A client reports a deliverable adoption or a deliverable edit.");
        }
        const runId = safeId(assertString(body.runId, "runId", { max: 120 }), "runId");
        // The run is resolved from the caller's own project first, the way
        // every other run-addressed route here does it. This id is not
        // decoration: it is copied into the distillation payload, into the
        // `method` document the lesson becomes and into its rendered body, so
        // an id no run answers to would attribute a lesson to a run nobody can
        // open — and it is entirely client-chosen.
        const projectRuns = await agentRuns.list(ctx.project);
        if (!projectRuns.some((candidate) => candidate.id === runId)) {
          throw new HttpError(404, "agent_run_not_found", "Agent run not found.");
        }
        const relative = normalizeWorkspaceRelativePath(body.path, "path");
        const summary = assertString(body.summary, "summary", { optional: true, max: 2_000 }) ?? "";
        // The content is the identity: the digest is computed here, from the
        // deliverable the workspace actually holds, so an edit that changed
        // nothing cannot be reported as one and the same edit reported twice is
        // one event.
        const opened = await openScopedFileNoFollow(ctx.project.workspaceDir, resolveScopedPath(ctx.project.workspaceDir, relative))
          .catch((error) => {
            if (error?.code !== "ENOENT") throw error;
            throw new HttpError(404, "file_not_found", "File not found.");
          });
        let contentSha256;
        try {
          if (opened.stat.size > config.maxFileBytes) throw new HttpError(413, "file_too_large", "file is too large.");
          contentSha256 = createHash("sha256").update(await opened.handle.readFile()).digest("hex");
        } finally { await opened.handle.close(); }
        const recorded = await service.record(ctx.user.id, {
          trigger,
          subject: { type: "deliverable", id: deliverableSubjectId(runId, relative) },
          identity: trigger === "deliverable-edited" ? [contentSha256] : [],
          projectId: ctx.project.id,
          runId,
          detail: { path: relative, runId, contentSha256, ...(summary ? { summary } : {}) },
        });
        await audit(ctx, "feedback.record", "completed", { target: recorded.event.id });
        sendJson(res, recorded.created ? 201 : 200, { data: {
          event: recorded.event, distillJobId: recorded.distillJob?.id ?? null,
        } });
        return;
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
        if (body?.mode === "specialist") await assertPublicAgent(body.agentId);
        sendJson(res, 200, { data: await researchSessions.put(ctx.project, sessionId, body) });
        return;
      }

      if (pathname === "/api/agent-runs" && req.method === "GET") {
        const ctx = await context(req, res);
        sendJson(res, 200, { data: await agentRuns.recover(ctx.project) });
        return;
      }

      // The accepted version of a package, before the repair loop touched it.
      //
      // Read-only, and the only reader these snapshots have ever had. The
      // writer has existed since the repair loop was built; without this a run
      // that was accepted and then edited left its accepted bytes on disk with
      // no way to reach them, which is how 38 minutes of gate-clean work became
      // unrecoverable on 2026-08-31.
      if (pathname.startsWith("/api/agent-runs/") && pathname.endsWith("/repair-revisions") && req.method === "GET") {
        const rawRunId = pathname.slice("/api/agent-runs/".length, -"/repair-revisions".length);
        if (!rawRunId || rawRunId.includes("/")) throw new HttpError(404, "not_found", "Route not found.");
        const ctx = await context(req, res);
        const runId = decodeRouteComponent(rawRunId, "agent run id");
        sendJson(res, 200, { data: await agentRuns.listRepairRevisions(ctx.project, runId) });
        return;
      }

      if (pathname.startsWith("/api/agent-runs/") && pathname.includes("/repair-revisions/") && req.method === "GET") {
        const rest = pathname.slice("/api/agent-runs/".length);
        const [rawRunId, marker, rawDigest, ...extra] = rest.split("/");
        if (!rawRunId || marker !== "repair-revisions" || !rawDigest || extra.length > 0) {
          throw new HttpError(404, "not_found", "Route not found.");
        }
        const ctx = await context(req, res);
        const runId = decodeRouteComponent(rawRunId, "agent run id");
        const digest = decodeRouteComponent(rawDigest, "accepted digest");
        // The path is a query parameter, not a path segment: it contains
        // slashes by construction, and encoding them into one segment is the
        // shape every route in this file refuses.
        const relative = new URL(req.url ?? "/", "http://localhost").searchParams.get("path") ?? "";
        sendJson(res, 200, { data: await agentRuns.readRepairRevisionFile(ctx.project, runId, digest, relative) });
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
        // `episode-<32 hex>-v<n>` is how the completion fold recognizes an
        // independent verification of a proactive claim. A browser that could
        // name one would be dispatching a run whose own workspace decides the
        // verdict of a claim it authored — the self-grading the second process
        // exists to remove. The shape is reserved for the system that mints it.
        if (verificationEpisodeId(body.dispatchId)) {
          throw new HttpError(400, "invalid_agent_run", "This dispatch id is reserved for independent verification.");
        }
        const registry = await agentRegistry;
        const boundSession = await researchSessions.get(ctx.project, body.sessionId);
        await assertPublicSessionPrompt(ctx.project, body.sessionId, boundSession);
        if (config.runtimeMode === "kernel" && !config.deepseekProviderEnabled) {
          throw new HttpError(
            503,
            "model_provider_not_configured",
            "The research model provider is not configured on this EviMed server.",
          );
        }
        if (usageLedger) await usageLedger.assertWithinLimits(ctx.user.id, {
          dailyLimit: Number(config.userDailySpendLimit) || 0,
          weeklyLimit: Number(config.userWeeklySpendLimit) || 0,
        });
        else await assertSpendWithinLimits(config, ctx.user.id);
        // The default open-domain answer agent is the fallback handler, never
        // a routable specialist: exclude it from router/classifier candidates.
        const routableAgents = registry.list().filter((agent) => agent.id !== OPEN_DOMAIN_ANSWER_AGENT_ID);
        // Routing is a judgement about what deliverable the request commissions,
        // and a word list cannot make it. Deciding by regex first sent six real
        // requests for a clinical evidence review to other pipelines because
        // they mentioned meta-analyses, adverse reactions, or a dataset — the
        // classifier was never consulted, because a rule had already matched.
        //
        // So the model decides, and the regex keeps exactly one job: a safety
        // net under the decision. It runs when the model declines or is not
        // available, and it may only ADD a route, never replace one the model
        // made. That preserves the property the old order was built for — a
        // high-risk medicine asked about in a report request always reaches the
        // clinical gate — without letting keyword matching outrank judgement.
        let routedSpecialist = null;
        /** @type {{ failure?: string, verdict?: string }} */
        const classifierTrace = {};
        if (boundSession?.mode === "open-domain") {
          const named = routeNamedSpecialist(text, routableAgents);
          // Naming the package is an instruction, not a guess at intent.
          routedSpecialist = named ?? await specialistClassifier.classify(text, routableAgents, classifierTrace);
          if (!routedSpecialist) {
            const net = routeOpenDomainSpecialist(text, routableAgents, {
              afterCleanNone: classifierTrace.verdict === "none",
            });
            // The net catching a request is normal after the model has said "no
            // specialist fits". It is a different event after the model never
            // answered, and the two are the same string in the ledger unless
            // this says so: one is the design working, the other is the design
            // not running.
            routedSpecialist = net && classifierTrace.failure
              ? { ...net, reason: classifierFailureReason(net.reason, classifierTrace.failure) }
              : net;
          }
        }
        // Unrouted open-domain questions still run on a managed EviMed agent
        // (persona + proportional quality floor) instead of the bare coding
        // agent the runtime ships with.
        const answerAgent = boundSession?.mode === "open-domain" && !routedSpecialist
          ? registry.get(OPEN_DOMAIN_ANSWER_AGENT_ID)
          : null;
        const effectiveAgent = routedSpecialist ?? (answerAgent
          ? {
              agentId: answerAgent.id,
              agentVersion: answerAgent.version,
              runtimeAgent: answerAgent.runtimeAgent,
              // Falling through to the answer line is a routing outcome like any
              // other, and the one most often mistaken for a failure to route.
              // So when the classifier never got to decide, the ledger says so:
              // a batch cannot be read afterwards if a timed-out routing and a
              // genuinely open-domain question leave the same record.
              reason: classifierTrace.failure
                ? classifierFailureReason("unrouted:open-domain", classifierTrace.failure)
                : "unrouted:open-domain",
            }
          : null);
        const dispatch = () => agentRuns.dispatch(ctx.project, {
          sessionId: body.sessionId,
          dispatchId: body.dispatchId,
          question: text,
          effectiveAgentId: effectiveAgent?.agentId ?? null,
          effectiveAgentVersion: effectiveAgent?.agentVersion ?? null,
          effectiveRuntimeAgent: effectiveAgent?.runtimeAgent ?? null,
          effectiveRouteReason: effectiveAgent?.reason ?? null,
        }, async (session, dispatchedRun, repairText = null) => {
          const promptText = typeof repairText === "string" && repairText.trim() ? repairText : text;
          let memories = [];
          let memoryError = null;
          if (config.requireMemos && !memosClient.configured) {
            const error = new HttpError(503, "memory_required_unavailable", "Required research memory is not configured.");
            error.definitivelyRejected = true;
            throw error;
          }
          try {
            memories = await memorySubstrate.recall(ctx.user.id, text, {
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
          const contextSpecialist = routedSpecialist
            ? registry.get(routedSpecialist.agentId)
            : session.mode === "specialist"
              ? registry.get(session.agentId)
              : null;
          // The answer line does not delegate, so nothing injects its persona
          // the way a capability child gets one. Hand it the body the registry
          // is already holding instead of instructing the model to fetch it.
          const answerPackage = !contextSpecialist && !routedSpecialist && session.mode === "open-domain"
            ? registry.getPackage(OPEN_DOMAIN_ANSWER_AGENT_ID)
            : null;
          const prepared = await prepareResearchContext(ctx.project, session, config, {
            query: text,
            memories,
            memoryError,
            specialists: session.mode === "open-domain" ? routableAgents : [],
            mountableSkills: answerPackage?.skillText
              ? [{ name: answerPackage.manifest.skill, body: answerPackage.skillText }]
              : [],
            routedSpecialist: contextSpecialist
              ? {
                  agentId: contextSpecialist.id,
                  agentVersion: contextSpecialist.version,
                  runtimeAgent: contextSpecialist.runtimeAgent,
                  skill: contextSpecialist.skill,
                  companionSkills: contextSpecialist.companionSkills,
                }
              : routedSpecialist,
          });
          // Before the prompt goes out, like the brief: a mount the ledger has
          // not recorded cannot be told apart from one that never happened.
          if (prepared.mountedSkills.length > 0) {
            await agentRuns.recordLearning(ctx.project, dispatchedRun.id, { mountedSkills: prepared.mountedSkills });
          }
          return runtimeManager.dispatchPrompt(ctx.project, session.sessionId, {
            text: promptText,
            system: prepared.system,
            agent: routedSpecialist?.runtimeAgent ?? session.runtimeAgent ?? answerAgent?.runtimeAgent ?? null,
            model: `deepseek/${config.deepseekModel}`,
            runId: dispatchedRun.id,
            requestId: dispatchedRun.kernelRequestIds?.at(-1),
            strictContext: true,
          });
        });
        const run = pluginService ? await pluginService.withAdmission(ctx.project, dispatch) : await dispatch();
        sendJson(res, 202, { data: run });
        return;
      }

      // A correction to a run that is already going.
      //
      // Deliberately its own route rather than an exemption in the dispatch
      // rule. A dispatch creates a run, a run binds a deliverable contract, and
      // one research session may have one active run — so relaxing
      // `agent_run_active` would have produced two runs, two contracts and two
      // verdicts for one conversation. A correction is input to the run that is
      // already going: same run, same contract, same gate, and the ledger says
      // how many corrections it took.
      if (pathname.startsWith("/api/agent-runs/") && pathname.endsWith("/steer") && req.method === "POST") {
        const rawRunId = pathname.slice("/api/agent-runs/".length, -"/steer".length);
        if (!rawRunId || rawRunId.includes("/")) throw new HttpError(404, "not_found", "Route not found.");
        const runId = decodeRouteComponent(rawRunId, "agent run id");
        const ctx = await context(req, res);
        const body = assertObject(await readJson(req, config.maxJsonBytes), "agent run correction");
        const unknown = Object.keys(body).filter((field) => field !== "text");
        if (unknown.length > 0) {
          throw new HttpError(400, "invalid_payload", `Unknown correction field(s): ${unknown.sort().join(", ")}.`);
        }
        const text = assertString(body.text, "text", { max: 4000 });
        if (!text.trim()) throw new HttpError(400, "invalid_payload", "text must not be empty.");
        const run = (await agentRuns.list(ctx.project)).find((item) => item.id === runId);
        if (!run) throw new HttpError(404, "agent_run_not_found", "The run is unavailable.");
        const correctionRequestId = randomId("req_");
        // Recorded before the kernel is told, like the repair path: a request
        // id the ledger has not seen cannot be matched to the run it belongs to.
        const updated = await agentRuns.recordCorrection(ctx.project, runId, correctionRequestId);
        await runtimeManager.dispatchPrompt(ctx.project, run.sessionId, {
          // Marked, so a compaction can carry it as a handle rather than
          // summarising away one half of a modified instruction — the failure
          // the published implementations of this feature all name.
          text: `<evimed-correction>${text}</evimed-correction>`,
          runId,
          requestId: correctionRequestId,
          mode: "steer",
          strictContext: true,
        });
        sendJson(res, 202, { data: { id: runId, corrections: updated?.corrections ?? 0 } });
        return;
      }

      // A researcher's own credentials for the external data sources: which
      // connectors the deployment serves, which they have filled in, which are
      // waiting. Values travel one way — in — and are never read back.
      if (pathname === "/api/connectors" && req.method === "GET") {
        const user = await store.ensureUser(req, res);
        if (!connectorCredentials) throw new HttpError(503, "connector_credentials_unavailable", "Connector credentials are not available on this deployment.");
        sendJson(res, 200, { data: await connectorCredentials.status(user.id) });
        return;
      }
      if (pathname.startsWith("/api/connectors/") && (req.method === "PUT" || req.method === "DELETE")) {
        const user = await store.ensureUser(req, res);
        const connector = decodeRouteComponent(pathname.slice("/api/connectors/".length), "connector");
        if (!CONNECTOR_CREDENTIAL_IDS.has(connector)) throw new HttpError(404, "connector_unknown", "The connector is not one a credential can be held for.");
        if (!connectorCredentials) throw new HttpError(503, "connector_credentials_unavailable", "Connector credentials are not available on this deployment.");
        if (req.method === "PUT") {
          const body = await readJson(req, 16 * 1024);
          const saved = await connectorCredentials.set(user.id, connector, body?.value);
          await securityAudit(config, "connector.credential.set", "completed", { userId: user.id, connector, expiresAt: saved.expiresAt });
          sendJson(res, 200, { data: { connector, source: "user", expiresAt: saved.expiresAt } });
          return;
        }
        const removed = await connectorCredentials.remove(user.id, connector);
        await securityAudit(config, "connector.credential.removed", removed ? "completed" : "noop", { userId: user.id, connector });
        sendJson(res, 200, { data: { connector, removed } });
        return;
      }

      if (pathname === "/api/account/usage" && req.method === "GET") {
        const user = await store.ensureUser(req, res);
        // This month, because that is the period a person is asked to pay for
        // and the one they can still change their behaviour within.
        const now = new Date();
        const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
        if (usageLedger) {
          const summary = await usageLedger.summary(user.id, { since });
          sendJson(res, 200, { data: {
            ...summary,
            calls: summary.settledCalls,
            cost: summary.actualCost,
            promptTokens: summary.cacheHitTokens + summary.cacheMissTokens,
          } });
        } else {
          const rows = await readServerUsageJsonl(config, user);
          sendJson(res, 200, { data: { since: since.toISOString(), ...summarizeUsage(rows, { userId: user.id, since }) } });
        }
        return;
      }

      if (pathname === "/api/account/export" && req.method === "GET") {
        const user = await store.ensureUser(req, res);
        await withAccountExportSnapshot(productDatabase, user, config, async snapshot => {
          const projects = snapshot?.projects ?? await store.listProjects(user);
          if (config.requireMemos && !memosClient.configured) {
            throw new HttpError(503, "memory_required_unavailable", "Required research memory is unavailable for account export.");
          }
          const memory = memosClient.configured ? await memosClient.exportUserMemory(user.id) : null;
          let entries = appendMemoryArchiveEntry(await collectUserArchiveEntries(user, projects, config), memory, config);
          if (snapshot) entries = appendAccountStateArchiveEntry(entries, snapshot.data, config);
          await securityAudit(config, "account.export", "completed", { userId: user.id });
          await sendUserArchive(res, user, entries);
        });
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
        await memorySubstrate.forgetUser(user.id);
        let memoryIndexPurge = null;
        const data = await store.deleteUser(user, {
          beforeLock: memoryIndexing ? (id, client) => memoryIndexing.lockAccountDeletion(id, client) : null,
          beforeDelete: capsuleTransferService || memoryIndexing ? async (id, client) => {
              if (memoryIndexing) {
                memoryIndexPurge = await memoryIndexing.prepareAccountDeletion(id, user.accountCreatedAt, client);
              }
              if (capsuleTransferService) await capsuleTransferService.prepareAccountDeletion(id, client);
            }
            : null,
        });
        taskManager.purgeUser(user);
        clearSessionCookie(res, config.sessionCookieName);
        if (capsuleTransferService) await capsuleTransferService.finishAccountDeletion(user.id);
        await securityAudit(config, "account.delete", "completed", { userId: user.id, memoryPurge, memoryIndexPurge });
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
        // Counted before the create, and only for a project that is new: a
        // per-project storage quota and a per-user runtime limit bound nothing
        // on their own, because an account at the limit can make another
        // project and have another of each.
        const existing = await store.listProjects(user);
        if (
          config.maxProjectsPerUser > 0 &&
          existing.length >= config.maxProjectsPerUser &&
          !existing.some((project) => project.id === id)
        ) {
          throw new HttpError(
            409,
            "project_limit_reached",
            `This account already holds ${existing.length} projects, which is its limit. Delete one to make another.`,
          );
        }
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
          // Derived copies go with the record they were derived from. Awaited
          // and not swallowed: an index that still answers with a deleted
          // project's memories is a copy of deleted data, so a failure here
          // fails the delete rather than reporting a deletion that did not
          // happen.
          await memorySubstrate.forgetProject(user.id, project.id);
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
        const data = await withCommandSlot(async () => {
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

      // The browser-to-kernel pass-through is gone. It was the one route that
      // put a kernel's own protocol in front of a user's browser, which meant
      // the frontend knew that kernel's message shapes and every kernel change
      // was a frontend change. Under the DSH kernel it would also have exposed
      // the host's settings and credentials methods, which are pinned to
      // loopback precisely because they are not for remote callers. A request
      // to it now says what replaced it rather than 404ing into silence.
      //
      // The path keeps the retired kernel's name on purpose. A URL is what an
      // already-deployed client types; renaming it would turn each of those
      // requests into an anonymous 404 and lose the one chance to name the
      // replacement. The vendor word survives here as a wire identifier, not
      // as a live dependency.
      // The kernel's own browser application, per project, behind this
      // session. `/api/opencode/` above is the retired route that let a browser
      // talk to a kernel directly and answers 410; this is not that. It is the
      // control plane forwarding, with the caller's project resolved here, the
      // browser-session cookie minted here, and the same quota accounting,
      // deadlines and response-header sanitising every runtime call gets. It is
      // off unless the deployment turns it on.
      // The path form of this surface is retired, and by name rather than by
      // 404: it was linked to, and a bookmark that opens it should say what
      // happened. It could serve the document and every asset and still not
      // work, because the application's plugin bundles and method calls are
      // absolute paths built from `location.origin` — under a prefix they
      // arrived here and were answered with this control plane's own page, so
      // the application died at boot while every request read 200. It is
      // served on an origin of its own now; `/api/me` names it.
      if (pathname.startsWith("/api/runtime-ui/")) {
        throw new HttpError(
          410,
          "runtime_ui_path_retired",
          "The kernel browser application is served on its own origin; read runtime.uiOrigin from /api/me.",
        );
      }

      if (pathname.startsWith("/api/opencode/")) {
        throw new HttpError(
          410,
          "runtime_passthrough_retired",
          "The runtime pass-through route has been retired. Subscribe to GET /api/runs/:id/events instead.",
        );
      }

      // Creating a run session is the control plane's job. The browser used to
      // POST straight through to the kernel; that route is gone, and this is
      // what replaced it — one shape whatever kernel is running.
      if (pathname === "/api/runtime/sessions" && req.method === "POST") {
        const ctx = await context(req, res);
        const created = await runtimeManager.createRuntimeSession(ctx.project);
        if (!created.id) throw new HttpError(502, "runtime_session_create_failed", "The runtime returned no session id.");
        sendJson(res, 200, { data: created });
        return;
      }

      if (pathname.startsWith("/api/runtime/sessions/") && pathname.endsWith("/transcript") && req.method === "GET") {
        const ctx = await context(req, res);
        // `safeId` after decoding, not before: a percent-encoded separator is
        // exactly how a caller smuggles one past a route match.
        const sessionId = safeId(
          decodeRouteComponent(pathname.slice("/api/runtime/sessions/".length, -"/transcript".length), "session id"),
          "session id",
        );
        sendJson(res, 200, { data: await runtimeManager.sessionTranscript(ctx.project, sessionId, { wake: false }) });
        return;
      }

      if (pathname.startsWith("/api/runs/") && pathname.includes("/interactions/") && req.method === "POST") {
        const ctx = await context(req, res);
        const tail = pathname.slice("/api/runs/".length);
        const split = tail.indexOf("/interactions/");
        const runId = decodeRouteComponent(tail.slice(0, split), "run id");
        const eventId = decodeRouteComponent(tail.slice(split + "/interactions/".length), "interaction id");
        // The run is proved from the caller's own project before the pump is
        // asked anything: the event id is the kernel's, so without this a
        // caller could answer a question raised in a project they cannot see.
        const runs = await agentRuns.list(ctx.project);
        if (!runs.some((candidate) => candidate.id === runId)) {
          throw new HttpError(404, "agent_run_not_found", "Agent run not found.");
        }
        const body = assertObject(await readJson(req, config.maxJsonBytes), "interaction answer");
        await runtimeEventPump.answerInteraction(ctx.project, {
          runId,
          eventId,
          outcome: interactionOutcome(body),
        });
        sendJson(res, 202, { data: { eventId, accepted: true } });
        return;
      }

      // What one run cost, for the person or the harness that ran it.
      //
      // `usageLedger.summaryRun` existed and had no route, so the only way to
      // join a cost to a run was to export the whole account and match by id
      // offline. The paired evaluation did exactly that and reported "cost
      // unavailable" whenever nobody had exported anything, which is most of
      // the time. Scoped to the caller's own project like every other run
      // route, so it discloses nothing an account holder cannot already read.
      if (pathname.startsWith("/api/runs/") && pathname.endsWith("/usage") && req.method === "GET") {
        const ctx = await context(req, res);
        const runId = decodeRouteComponent(pathname.slice("/api/runs/".length, -"/usage".length), "run id");
        const run = (await agentRuns.list(ctx.project)).find((candidate) => candidate.id === runId);
        if (!run) throw new HttpError(404, "agent_run_not_found", "Agent run not found.");
        if (!usageLedger) throw new HttpError(503, "usage_ledger_unavailable", "The usage ledger is unavailable.");
        // Keyed by `dispatchId`, which is what the gateway stamps on each call;
        // the same key `finishInternal` uses, so the two agree by construction.
        const summary = await usageLedger.summaryRun(ctx.project.userId, run.dispatchId ?? run.id);
        sendJson(res, 200, { data: {
          runId: run.id,
          cost: summary.actualCost,
          openCost: summary.openCost,
          currency: summary.currency,
          calls: summary.settledCalls,
          uncertain: summary.uncertain,
          cacheHitTokens: null,
          cacheMissTokens: null,
          inputTokens: summary.inputTokens,
          outputTokens: summary.outputTokens,
          modelId: summary.modelId,
        } });
        return;
      }
      if (pathname.startsWith("/api/runs/") && pathname.endsWith("/events") && req.method === "GET") {
        const ctx = await context(req, res);
        const runId = decodeRouteComponent(
          pathname.slice("/api/runs/".length, -"/events".length),
          "run id",
        );
        const runs = await agentRuns.list(ctx.project);
        const run = runs.find((candidate) => candidate.id === runId);
        if (!run) throw new HttpError(404, "agent_run_not_found", "Agent run not found.");
        const channel = runEvents.channel(runId);
        // The current state goes out before anything else, so a tab that
        // attaches to a finished run sees its outcome rather than an empty
        // stream that never speaks again.
        channel.publish("run/state", {
          state: run.status,
          phase: run.phase ?? null,
          errorCode: run.errorCode ?? null,
          verification: run.verification ?? null,
          attempts: run.attempts ?? 0,
        });
        // A reconnecting browser sends Last-Event-ID; a client managing its own
        // connection sends ?since=. Both are read, so neither has to know which
        // the other uses.
        const streamUrl = new URL(req.url ?? "/", apiBaseFromRequest(req, config));
        attachRunStream(res, channel, { since: resumePosition(req, streamUrl) });
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
        let registered = null;
        if (sourceService && root === "base" && (rel === "knowledge-base" || rel.startsWith("knowledge-base/"))) {
          registered = await sourceService.register(ctx.user.id, {
            projectId: ctx.project.id,
            connector: { type: "upload", id: `${ctx.project.id}-library` },
            path: rel,
            size: buffer.length,
            mtime: new Date().toISOString(),
            mimeType: mimeFor(rel),
            sha256: createHash("sha256").update(buffer).digest("hex"),
          });
          await audit(ctx, "source.register", "completed", {
            target: registered.source.id,
            duplicate: registered.duplicate,
          });
        }
        sendJson(res, 200, { data: { path: rel, ...(registered
          ? { ...registered, source: projectSourceManifestRecord(registered.source) } : {}) } });
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
    } finally {
      releaseMutation?.();
    }
  }

  async function withCommandSlot(fn) {
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
      // Registration is the other way an anonymous caller reaches the account
      // store, and the cheaper one to abuse: a login attempt costs a hash, a
      // registration costs a user directory.
      (pathname === "/api/auth/register" && req.method === "POST") ||
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

  // The kernel's browser application, on an origin of its own. It is a
  // listener rather than a route because the application builds every URL it
  // fetches from `location.origin`; see `runtimeUiServer.mjs`.
  const runtimeUi = createRuntimeUiServer({
    config,
    store,
    runtimeManager,
    usageLedger,
    authorizePrompt: assertPublicSessionPrompt,
    authorizeMutation: maintenanceService ? (operation) => maintenanceService.withMutation(operation) : null,
  });

  // No `upgrade` handler here on purpose. The only WebSocket this deployment
  // serves belongs to the kernel's browser application, and that application
  // has an origin of its own; a handshake arriving on the control plane's
  // origin has nowhere to go, and node's default -- close the socket -- is the
  // right answer rather than one worth writing.

  async function runStartupRuntimeCleanup() {
    if (startupRuntimeCleanup) return startupRuntimeCleanup;
    startupRuntimeCleanup = (async () => {
      try {
        const projects = await store.listStoredProjects();
        const summary = await runtimeManager.cleanupOrphanedRuntimes(projects);
        // After the sweep, not before: these monitors read the world the sweep
        // is done rearranging. Each one either resumes a live run or walks the
        // durable bridge for a dead one; without this, a restart left every
        // in-flight run "running" forever with its container gone.
        const adoption = await agentRuns.adoptRunningRuns(projects);
        return { ...summary, adoptedRuns: adoption.adopted };
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

  const scheduleAutopilot = async () => {
    if (!autopilotService || !productDatabase || autopilotScheduleRun) return autopilotScheduleRun;
    const schedule = async () => {
      const result = await productDatabase.query(`SELECT user_id,id,payload FROM evimed_product.documents
        WHERE kind='agenda' AND deleted_at IS NULL AND payload->>'status'='active' AND payload->>'enabled'='true'
        ORDER BY updated_at,id LIMIT 100`);
      const now = new Date();
      for (const row of result.rows) {
        try {
          const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
            timeZone: row.payload.timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
          }).formatToParts(now).map((part) => [part.type, part.value]));
          const date = `${parts.year}-${parts.month}-${parts.day}`;
          if (Number(parts.hour) >= Number(row.payload.scheduleHour) && row.payload.lastScheduledDate !== date) {
            await autopilotService.schedule(row.user_id, row.id, { date });
          }
        } catch (error) {
          await securityAudit(config, "autopilot.schedule", "failed", {
            userId: row.user_id, agendaId: row.id,
            code: typeof error?.code === "string" ? error.code : "autopilot_schedule_failed",
          });
        }
      }
    };
    autopilotScheduleRun = maintenanceMutation(schedule)
      .catch((error) => {
        if (error?.code === "maintenance_active") return null;
        // This runs from a timer under `void`. Rethrowing here made a Postgres
        // connection timeout on 2026-09-09 an unhandled rejection, which Node
        // treats as fatal: the whole control plane died mid-battery and came
        // back only because the container restarts. A scheduler that cannot
        // reach the ledger this minute says so and tries again next minute.
        process.stderr.write(`autopilot scheduling failed: ${typeof error?.code === "string" ? error.code : error?.name ?? "autopilot_schedule_failed"}\n`);
        return null;
      })
      .finally(() => { autopilotScheduleRun = null; });
    return autopilotScheduleRun;
  };

  /**
   * Enqueue one night's consolidation per project that has methods to consolidate.
   *
   * This did not exist, and its absence made the whole learning loop a one-way
   * street. `MethodConsolidation.sleep` is the only code path that calls
   * `learning.approve`, and `approve` is the only way a `candidate` method ever
   * becomes `approved` — which is the only status `capsuleMethods.mjs` will
   * mount. It is also the only caller of `retirementProposals`. Distillation
   * therefore wrote candidates forever, nothing was ever promoted, nothing was
   * ever retired, and every test of the promotion rule passed because they all
   * call `sleep` directly. A producer nobody writes is invisible to unit tests
   * by construction: there is no assertion to fail.
   *
   * Enqueued whenever the day turns over, not on a schedule of its own. The
   * spending window is `LearningWorker`'s to enforce — it declines to claim
   * outside it — so a job queued at noon simply waits for the evening rather
   * than being dropped, and a deployment whose window never opens accumulates
   * exactly one job per project per day instead of losing the day entirely.
   *
   * Per project rather than per user, because `sleep` reads and writes one
   * project's library: `listMethods`, `approve` and `retirementProposals` are
   * all scoped by `job.projectId`, so a single account-wide job would
   * consolidate whichever project it happened to name and silently skip the
   * rest.
   */
  const scheduleConsolidation = async () => {
    if (!learningService || !productJobs || !config.learningEnabled || consolidationScheduleRun) {
      return consolidationScheduleRun;
    }
    const schedule = async () => {
      // Projects holding at least one method that is not already retired. A
      // library of nothing has nothing to consolidate, and enqueueing for it
      // would put a job on every project in the deployment every night.
      const result = await productDatabase.query(`SELECT DISTINCT user_id,project_id FROM evimed_product.documents
        WHERE kind='method' AND deleted_at IS NULL AND project_id IS NOT NULL
          AND payload->>'status' IS DISTINCT FROM 'retired'
        ORDER BY user_id,project_id LIMIT 200`);
      const date = new Date().toISOString().slice(0, 10);
      for (const row of result.rows) {
        try {
          await productJobs.enqueue(row.user_id, "consolidate", { action: "sleep", date }, {
            // One pass per project per day however often this timer fires.
            idempotencyKey: `consolidate:sleep:${row.project_id}:${date}`,
            projectId: row.project_id,
          });
        } catch (error) {
          await securityAudit(config, "learning.consolidate.enqueue", "failed", {
            userId: row.user_id, projectId: row.project_id,
            code: typeof error?.code === "string" ? error.code : "learning_enqueue_failed",
          });
        }
      }
    };
    consolidationScheduleRun = maintenanceMutation(schedule)
      .catch((error) => {
        if (error?.code === "maintenance_active") return null;
        // Same timer-under-`void` shape as the autopilot scheduler above.
        process.stderr.write(`consolidation scheduling failed: ${typeof error?.code === "string" ? error.code : error?.name ?? "consolidation_schedule_failed"}\n`);
        return null;
      })
      .finally(() => { consolidationScheduleRun = null; });
    return consolidationScheduleRun;
  };

  let usageReconcileTimer = null;
  let usageReconcileRun = null;
  // A reservation whose settlement never arrived would otherwise stay 'reserved'
  // forever: nothing else in the system reads reservation_expires_at, so the row
  // simply falls out of the budget window and is never accounted for again.
  const reconcileUsageReservations = () => {
    if (!usageLedger) return Promise.resolve(null);
    if (usageReconcileRun) return usageReconcileRun;
    usageReconcileRun = maintenanceMutation(() => usageLedger.reconcileExpiredReservations({ limit: 200 }))
      .then(async (result) => {
        if (result?.reconciled) {
          await securityAudit(config, "usage.reservation.reconcile", "expired", {
            code: "reservation_expired", detail: `reconciled=${result.reconciled} remaining=${result.remaining}`,
          });
        }
        return result;
      })
      .catch((error) => {
        if (error?.code === "maintenance_active") return null;
        process.stderr.write(`usage reservation reconciliation failed: ${typeof error?.code === "string" ? error.code : "usage_reconcile_failed"}\n`);
        return null;
      })
      .finally(() => { usageReconcileRun = null; });
    return usageReconcileRun;
  };

  const pauseRecurringWork = () => {
    recurringWorkStarted = false;
    for (const worker of [pluginApplyWorker, memoryIndexWorker, sourceWorker, autopilotWorker, learningWorker]) {
      if (worker?.timer) clearInterval(worker.timer);
      if (worker) worker.timer = null;
    }
    for (const worker of [memoryIndexWorker, sourceWorker, autopilotWorker, learningWorker]) {
      if (worker?.reconcileTimer) clearInterval(worker.reconcileTimer);
      if (worker) worker.reconcileTimer = null;
    }
    if (capsuleCleanupTimer) clearInterval(capsuleCleanupTimer);
    if (autopilotScheduleTimer) clearInterval(autopilotScheduleTimer);
    if (consolidationScheduleTimer) clearInterval(consolidationScheduleTimer);
    if (notificationTimer) clearInterval(notificationTimer);
    if (usageReconcileTimer) clearInterval(usageReconcileTimer);
    capsuleCleanupTimer = null;
    autopilotScheduleTimer = null;
    consolidationScheduleTimer = null;
    notificationTimer = null;
    usageReconcileTimer = null;
  };

  const startRecurringWork = async () => {
    if (recurringWorkStarted || (maintenanceService && !maintenanceService.claimingAllowed())) return;
    recurringWorkStarted = true;
    try {
      pluginApplyWorker?.start();
      memoryIndexWorker?.start();
      sourceWorker?.start();
      autopilotWorker?.start();
      learningWorker?.start();
      await retryCapsuleCleanup();
      if (maintenanceService && !maintenanceService.claimingAllowed()) { pauseRecurringWork(); return; }
      if (capsuleTransferService && !capsuleCleanupTimer) {
        capsuleCleanupTimer = setInterval(() => { void retryCapsuleCleanup(); }, 30_000);
        capsuleCleanupTimer.unref();
      }
      await scheduleAutopilot();
      if (maintenanceService && !maintenanceService.claimingAllowed()) { pauseRecurringWork(); return; }
      if (autopilotService && !autopilotScheduleTimer) {
        autopilotScheduleTimer = setInterval(() => { void scheduleAutopilot(); }, 60_000);
        autopilotScheduleTimer.unref();
      }
      // Hourly, not minutely: the job it enqueues is idempotent per project per
      // day, so the only thing a faster tick buys is 60 times the queries.
      if (learningWorker && !consolidationScheduleTimer) {
        consolidationScheduleTimer = setInterval(() => { void scheduleConsolidation(); }, 3_600_000);
        consolidationScheduleTimer.unref();
        void scheduleConsolidation();
      }
      await applyNotificationDefaults();
      if (maintenanceService && !maintenanceService.claimingAllowed()) { pauseRecurringWork(); return; }
      if (notificationService && !notificationTimer) {
        notificationTimer = setInterval(() => { void applyNotificationDefaults(); }, 30_000);
        notificationTimer.unref();
      }
      await reconcileUsageReservations();
      if (maintenanceService && !maintenanceService.claimingAllowed()) { pauseRecurringWork(); return; }
      if (usageLedger && !usageReconcileTimer) {
        usageReconcileTimer = setInterval(() => { void reconcileUsageReservations(); }, 60_000);
        usageReconcileTimer.unref();
      }
    } catch (error) {
      recurringWorkStarted = false;
      throw error;
    }
  };

  return {
    config,
    store,
    runtimeManager,
    memosClient,
    memorySubstrate,
    openVikingClient,
    memOsEngine,
    memoryIndexing,
    memoryIndexWorker,
    sourceService,
    sourceWorker,
    sourceUnderstandingRuntime,
    autopilotService,
    autopilotWorker,
    usageLedger,
    notificationService,
    // Returned so the composition root can be asserted at the composition root.
    // It was reachable only through `recordRun`'s call site, so cutting its
    // inbox dependency here left every test green and the notices dark.
    memoryIntelligence,
    feedbackEvents,
    // The only claimer of `distill` and `consolidate`. Returned for the same
    // reason as the line above it, and the absence was not theoretical: the
    // composition assertion that `distill` has at most one claimer read
    // `app.learningWorker`, got `undefined`, filtered it out and passed on an
    // empty list — a test of a collision that could not see either side of it.
    learningWorker,
    capsuleService,
    pluginService,
    pluginApplyWorker,
    commands,
    taskManager,
    maintenanceService,
    operationalMetrics,
    agentRegistry,
    researchSessions,
    agentRuns,
    server,
    runtimeUi,
    async listen(port = config.port, host = config.host) {
      await agentRegistry;
      if (productDatabase) await migrateProductStore(productDatabase);
      await connectorCredentials?.migrate();
      await maintenanceService?.initialize();
      await retryCapsuleCleanup();
      await runStartupRuntimeCleanup();
      const address = await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => resolve(server.address()));
      });
      // After the control plane, and only if it came up: a listener that
      // survived a failed main listen would hold the port open and make the
      // restart look like a port conflict.
      await runtimeUi.listen();
      backgroundReady = true;
      await startRecurringWork();
      return address;
    },
    async close() {
      for (const controller of evaluationAbortControllers) controller.abort();
      if (capsuleCleanupTimer) clearInterval(capsuleCleanupTimer);
      await capsuleCleanupRun;
      await pluginApplyWorker?.close();
      await memoryIndexWorker?.close();
      await sourceWorker?.close();
      await autopilotWorker?.close();
      await learningWorker?.close();
      if (autopilotScheduleTimer) clearInterval(autopilotScheduleTimer);
      await autopilotScheduleRun;
      if (consolidationScheduleTimer) clearInterval(consolidationScheduleTimer);
      await consolidationScheduleRun;
      if (notificationTimer) clearInterval(notificationTimer);
      await notificationRun;
      if (usageReconcileTimer) clearInterval(usageReconcileTimer);
      await usageReconcileRun;
      await runtimeUi.close();
      await taskManager.close();
      // Before the runtimes, because stopping a runtime the pump is still
      // following makes it reconnect to a kernel that is going away.
      await runtimeEventPump.closeAll();
      await agentRuns.closeAll();
      // After the run store, before the runtimes — and that order is the whole
      // point rather than a detail.
      //
      // `onRunFinished` fires from the run store's own monitor, so draining
      // before `agentRuns.closeAll()` drains a set the producer is still adding
      // to: the wait finishes, the monitor delivers one more terminal hook, and
      // that write lands after the directory it writes into has been removed.
      // Looping over the set was not enough for the same reason. The store has
      // to stop first. It still has to happen before `runtimeManager.closeAll()`
      // because the write reads the run's sessions out of a live container.
      //
      // The bound ends a shutdown that cannot finish rather than holding it
      // forever; no new runs are accepted by this point, so reaching it means
      // something else is wrong.
      for (let drain = 0; learningWrites.size && drain < 100; drain += 1) {
        await Promise.allSettled([...learningWrites]);
      }
      await runtimeManager.closeAll();
      await maintenanceService?.close();
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      await flushLedgerWrites();
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
  return collectScopedArchiveEntries(project.rootDir, "project", projectArchivePathType, config?.maxArchiveEntries, config?.maxArchiveBytes);
}

/** @param {string} relative @returns {"file" | "directory" | "content" | null} */
function projectArchivePathType(relative) {
  if (relative === "project.json") return "file";
  if (relative === "workspace") return "directory";
  if (relative.startsWith("workspace/")) return "content";
  if (relative === ".openscience") return "directory";
  if (/^\.openscience\/(?:runs|provenance|tasks|audit|usage)\.jsonl(?:\.[1-9]\d*)?$/.test(relative)
    || relative === ".openscience/research-sessions.json"
    || relative === ".openscience/tasks-state.json") return "file";

  // Only session history belongs to the customer. The surrounding runtime home
  // holds credentials and image-managed profile/dependency symlinks; those
  // siblings must never be inspected, followed, or included in a customer export.
  const sessions = "runtime/container-runtime/dsh-home/sessions";
  if (relative === sessions || sessions.startsWith(`${relative}/`)) return "directory";
  if (relative.startsWith(`${sessions}/`)) return "content";
  return null;
}

async function collectUserArchiveEntries(user, projects = null, config = null) {
  const listedProjects = projects ?? [];
  const projectIds = new Set(listedProjects.map((project) => safeId(project.id, "project id")));
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
  const entries = await collectScopedArchiveEntries(user.rootDir, "account", (relative) => {
    if (relative === "projects") return "directory";
    const [container, projectId, ...parts] = relative.split("/");
    if (container !== "projects" || !projectIds.has(projectId)) return null;
    return parts.length === 0 ? "directory" : projectArchivePathType(parts.join("/"));
  }, config?.maxArchiveEntries, config?.maxArchiveBytes);
  assertArchiveEntryLimit(entries.length + 1, config?.maxArchiveEntries, "account");
  assertArchiveByteLimit(metadata.size + archiveEntryBytes(entries), config?.maxArchiveBytes, "account");
  return [
    metadata,
    ...entries,
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

/** @param {(relative: string) => "file" | "directory" | "content" | null} pathType */
async function collectScopedArchiveEntries(rootDir, scope, pathType, maxEntries = null, maxBytes = null) {
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
        const allowedType = pathType(childRel);
        if (allowedType === null) continue;
        const stat = await fsp.lstat(path.join(opened.path, entry.name));
        if (stat.isSymbolicLink()) {
          throw new HttpError(403, "path_forbidden", `symbolic links are not allowed in ${scope} exports.`);
        }
        if (stat.isDirectory()) {
          if (allowedType === "file") {
            throw new HttpError(403, "path_forbidden", `${scope} export expected a regular file.`);
          }
          await walk(child, childRel);
          continue;
        }
        if (!stat.isFile() || allowedType === "directory") {
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
    // The audit used to say "completed" here, before a single byte had moved,
    // and a read error further down answered with a bare res.destroy(). The
    // reader got a truncated report while the ledger and the audit both
    // recorded a successful delivery. Settle the audit on what actually left.
    const action = download ? "file.download" : "file.preview";
    let settled = false;
    let delivered = 0;
    const settle = (status, error = null) => {
      if (settled) return;
      settled = true;
      void audit(ctx, action, status, { target: rel, bytes: delivered, error });
    };
    res.writeHead(200, headers);
    if (stat.size === 0) {
      await opened.handle.close();
      opened = null;
      res.end();
      settle("completed");
      return;
    }
    const stream = opened.handle.createReadStream({ start: 0, end: stat.size - 1, autoClose: true });
    opened = null;
    stream.on("data", (chunk) => {
      delivered += chunk.length;
    });
    stream.on("error", (error) => {
      settle("failed", /** @type {NodeJS.ErrnoException} */ (error)?.code ?? "stream_error");
      res.destroy();
    });
    res.once("finish", () => {
      settle(delivered === stat.size ? "completed" : "failed", delivered === stat.size ? null : "short_read");
    });
    res.once("close", () => {
      settle("failed", "delivery_incomplete");
    });
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
  // eslint-disable-next-line no-control-regex -- stripping control characters is the intent
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
  await trackLedgerWrite(
    appendJsonLineNoFollow(ctx.project.rootDir, file, record, { maxBytes: ctx.config.maxLogFileBytes })
      .catch((error) => recordLedgerWriteFailure("audit", error)),
  );
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

// The three ledgers below each swallowed their own write failure. A full disk,
// a lost EACCES, a rotation that did not complete — the request succeeded, and
// the one failure the audit chain cannot record is its own. Count them and put
// the count where an operator already looks.
const ledgerWriteFailures = { audit: 0, security: 0, errors: 0 };
// A ledger append can outlive the request it describes -- a download is
// audited on what actually left, which is known only after the response ends.
// Shutdown must wait for those, or the last thing that happened is the one
// thing never recorded.
const pendingLedgerWrites = new Set();

function trackLedgerWrite(promise) {
  pendingLedgerWrites.add(promise);
  return promise.finally(() => pendingLedgerWrites.delete(promise));
}

async function flushLedgerWrites() {
  while (pendingLedgerWrites.size) {
    await Promise.allSettled([...pendingLedgerWrites]);
  }
}

function recordLedgerWriteFailure(ledger, error) {
  ledgerWriteFailures[ledger] += 1;
  const count = ledgerWriteFailures[ledger];
  // Loud once, then sparse: a failing disk would otherwise write the storm it
  // is failing to write.
  if (count === 1 || count % 100 === 0) {
    process.stderr.write(`${ledger}.jsonl write failed (${count} so far): ${error?.code ?? error?.message ?? "unknown"}\n`);
  }
}

export function ledgerWriteFailureCounts() {
  return { ...ledgerWriteFailures };
}

/**
 * One line in the security ledger.
 *
 * The record shape is fixed on purpose — this is an audit log, not a debug
 * stream — but it was fixed at six fields while call sites passed run ids,
 * project ids, counters and error text, all of which were silently dropped.
 * Every caller looked like it was recording context and none of it was written,
 * which is how `memory_upstream_error` stayed unattributable across six
 * different requests: the answer had been passed in and thrown away.
 *
 * `detail` is the one addition: bounded, and it must never carry a credential —
 * callers put the failing method, path and upstream status there, not headers.
 */
async function securityAudit(config, action, status, details = {}) {
  const detail = String(details.detail ?? "").slice(0, 300);
  const record = {
    createdAt: new Date().toISOString(),
    action,
    status,
    username: details.username ?? null,
    userId: details.userId ?? null,
    code: details.code ?? null,
    ...(detail ? { detail } : {}),
  };
  const file = path.join(config.dataDir, ".openscience", "security.jsonl");
  await trackLedgerWrite(
    appendJsonLineNoFollow(config.dataDir, file, record, { maxBytes: config.maxLogFileBytes })
      .catch((error) => recordLedgerWriteFailure("security", error)),
  );
}

function safeLogId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value) ? value : null;
}

async function appendErrorRecord(config, req, pathname, { status, code, requestId = null, truncated = false }) {
  const projectHeader = req.headers["x-open-science-project"];
  const projectId = safeLogId(Array.isArray(projectHeader) ? projectHeader[0] : projectHeader);
  const record = {
    createdAt: new Date().toISOString(),
    requestId,
    method: req.method ?? null,
    route: routePattern(pathname),
    status,
    code,
    projectId,
    // A stream that was cut after its 200 is the one failure a caller cannot
    // tell from success, so it is recorded as a property of the record rather
    // than left to be inferred from the status.
    ...(truncated ? { truncated: true } : {}),
  };
  const file = path.join(config.dataDir, ".openscience", "errors.jsonl");
  await trackLedgerWrite(
    appendJsonLineNoFollow(config.dataDir, file, record, { maxBytes: config.maxLogFileBytes })
      .catch((error) => recordLedgerWriteFailure("errors", error)),
  );
}

async function errorAudit(config, req, pathname, err, details = {}) {
  if (!pathname.startsWith("/api/")) return;
  await appendErrorRecord(config, req, pathname, {
    status: err instanceof HttpError ? err.status : 500,
    code: err instanceof HttpError ? err.code : "internal_error",
    requestId: details.requestId ?? null,
  });
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

function assertMaintenanceAccess(req, config) {
  assertOperatorMetricsAccess(req, config);
  const direct = normalizeClientAddress(req.socket?.remoteAddress);
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(direct)) {
    throw new HttpError(403, "maintenance_operator_forbidden", "Maintenance control is available only on loopback.");
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

async function operatorMetricsText({ config, store, taskManager, runtimeManager, memosClient, memOsEngine, memoryIndexWorker, usageLedger, notificationService, documentParser, openList, productDatabase, operationalMetrics, activeCommands, memorySubstrate = null }) {
  const readiness = await readinessStatus(config, store, runtimeManager, memosClient, memOsEngine, memoryIndexWorker, usageLedger, notificationService, documentParser, openList, productDatabase, memorySubstrate);
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
  addMetric(
    lines,
    "open_science_ledger_write_failures_total",
    "Appends the audit, security, and error ledgers could not write. Nonzero means this process is no longer producing the record an operator would read to find out what went wrong.",
    "counter",
    Object.entries(ledgerWriteFailureCounts()).map(([ledger, value]) => ({ labels: { ledger }, value })),
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
  addMetric(lines, "open_science_runtime_proxy_active", "Active runtime proxy requests and streams.", "gauge", {
    value: runtimeStats.proxy?.active ?? 0,
  });
  addMetric(
    lines,
    "open_science_runtime_proxy_limit",
    "Configured runtime proxy connection limits. Zero means disabled.",
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

/**
 * This account's usage events.
 *
 * Read with the byte-bounded reader, not the log reader the other ledgers use:
 * that one keeps the last hundred rows, which is right for "show me recent
 * audit lines" and wrong for a total. A hundred rows is a hundred model calls
 * across every account on the deployment, so a month's spend would have been
 * understated by however much traffic the other accounts made — a partial sum
 * presented as a total, which is the kind of number people act on.
 *
 * Filtered by user here as well as in the summary: the file holds every
 * account's events, and a read that returned another account's rows would be
 * a leak whether or not the caller's arithmetic happened to drop them.
 */
async function readServerUsageJsonl(config, user) {
  return (await readUsageEvents(config)).filter((row) => row.userId === user.id);
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

async function readinessStatus(config, store, runtimeManager, memosClient = null, memOsEngine = null, memoryIndexWorker = null, usageLedger = null, notificationService = null, documentParser = null, openList = null, productDatabase = null, memorySubstrate = null) {
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
    memoryIndex: await readinessCheck(async () => readinessMemoryIndex(config, memOsEngine, memoryIndexWorker)),
    memoryRecall: await readinessCheck(async () => readinessMemoryRecall(memorySubstrate)),
    usageLedger: await readinessCheck(async () => readinessUsageLedger(config, usageLedger)),
    inbox: await readinessCheck(async () => readinessInbox(config, notificationService)),
    documentParser: await readinessCheck(async () => readinessDocumentParser(config, documentParser)),
    openList: await readinessCheck(async () => readinessOpenList(config, openList)),
    relationalIntegrity: await readinessCheck(async () => readinessRelationalIntegrity(config, productDatabase)),
    security: await readinessCheck(() => readinessSecurity(config)),
    observability: await readinessCheck(() => readinessObservability(config)),
    evimedAdapters: await readinessCheck(() => readinessEviMedAdapters(config)),
    scienceConnectors: await readinessCheck(() => readinessScienceConnectors(config)),
    modelGateway: await readinessCheck(() => readinessModelGateway(config)),
    release: await readinessCheck(() => readinessRelease(config)),
    resources: await readinessCheck(() => readinessResources(config)),
    backup: await readinessCheck(async () => readinessBackup(config, productDatabase)),
    runtime: await readinessCheck(async () => readinessRuntime(config, runtimeManager)),
    kernel: await readinessCheck(async () => readinessKernel(config, runtimeManager)),
  };
  checks.saasProfile = await readinessCheck(() => readinessSaasProfile(config, checks));
  return {
    ok: Object.values(checks).every((check) => check.ok),
    checks,
  };
}

async function readinessDocumentParser(config, parser) {
  if (!config.requireDocumentParser) return { required: false, configured: Boolean(config.documentParserUrl) };
  if (config.documentParserTokenError) throw readinessFailure(config.documentParserTokenError);
  if (![config.documentParserUid, config.documentParserGid].every((value) => Number.isSafeInteger(value) && value > 0 && value <= 65_535)) {
    throw readinessFailure("document_parser_identity_invalid");
  }
  if (!config.documentParserUrl || !config.documentParserToken || !config.documentParserStagingDir || !parser) throw readinessFailure("document_parser_unconfigured");
  return { required: true, ...(await parser.health()) };
}

async function readinessOpenList(config, connector) {
  if (!config.requireOpenList) return { required: false, configured: Boolean(config.openListUrl && config.openListToken) };
  if (config.openListTokenError) throw readinessFailure(config.openListTokenError);
  if (!config.openListUrl || !config.openListToken || !connector) throw readinessFailure("openlist_unconfigured");
  return { required: true, ...(await connector.health()) };
}

async function readinessRelationalIntegrity(config, database) {
  if (!database) return { required: false, configured: false };
  const status = await relationalIntegrity(database);
  if (config.production && !status.ok) {
    throw readinessFailure("relational_integrity_unverified", {
      orphanTotal: status.orphanTotal, missing: status.missing, unvalidated: status.unvalidated,
    });
  }
  return { required: config.production, configured: true, validated: status.ok, orphanTotal: status.orphanTotal };
}

async function readinessUsageLedger(config, ledger) {
  if (!config.requireDurableUsageLedger) return { required: false, configured: Boolean(ledger) };
  if (!ledger) throw readinessFailure("usage_ledger_unconfigured");
  return { required: true, ...(await ledger.health()) };
}

async function readinessInbox(config, service) {
  if (!service) {
    if (config.requireInbox) throw readinessFailure("notification_unconfigured");
    return { required: false, configured: false };
  }
  return { required: Boolean(config.requireInbox), ...(await service.health()) };
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

/** Which component ranks a recall, and whether it can be reached.
 *
 * Reported, never required. A deployment that selected an index and cannot
 * reach it still answers — recall falls back to the term matcher — so failing
 * readiness would take a working product offline over a degraded one. What the
 * operator needs is to see that it is degraded, which is what this is for. */
async function readinessMemoryRecall(substrate) {
  if (!substrate) return { required: false, provider: "builtin" };
  const status = await substrate.status();
  return {
    required: false,
    provider: status.provider,
    configured: Boolean(status.configured),
    connected: Boolean(status.connected),
    ...(status.code ? { code: status.code } : {}),
  };
}

async function readinessMemoryIndex(config, memOsEngine, worker) {
  if (!config.requireMemoryIndex) return { required: false, configured: Boolean(memOsEngine) };
  if (!memOsEngine || !worker) throw readinessFailure("memory_index_unconfigured");
  const health = await memOsEngine.health();
  return { required: true, connected: health.status === "healthy", worker: worker.status() };
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

/** @returns {Error & Record<string, any>} An Error carrying the extra fields its
 *  callers read; a bare Error type rejects every one of them. */
function readinessFailure(code, details = null) {
  /** @type {Error & Record<string, any>} */
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
    // Six, not sixteen. Lowered on 2026-09-04 at the operator's instruction,
    // knowing what it allows: this deployment answers on a bare public IP with
    // a valid certificate, so the bootstrap account is reachable by anything
    // that scans the address space, and six bytes is inside every dictionary.
    // The floor is kept rather than removed because an empty or one-character
    // password is a different thing from a short one somebody chose.
    if (Buffer.byteLength(config.bootstrapPassword, "utf8") < 6) {
      throw readinessFailure("bootstrap_password_too_short", { minimumBytes: 6 });
    }
  }
  const users = await store.loginUserCount();
  if (users === 0) throw readinessFailure("no_login_users");
  // A non-zero count is not the same as "the configured administrator can log
  // in". Production ran with three unrelated accounts and OPEN_SCIENCE_BOOTSTRAP_USER
  // naming one that had been deleted: seeding refuses to resurrect a deleted id,
  // by design, so the account never came back, every login as that user returned
  // invalid_credentials, and this check reported ok throughout. "absent" means
  // seeding should have created it and did not, which is a fault; "deleted"
  // means an operator removed it on purpose, which is not — but both have to be
  // visible, because either way the configured administrator does not exist.
  const bootstrapUser = await store.bootstrapUserState();
  if (bootstrapUser === "absent") throw readinessFailure("bootstrap_user_missing", { bootstrapUser });
  return { mode: "local", sessionTtlMs, bootstrapPasswordSource: config.bootstrapPasswordSource, bootstrapUser };
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
  // `runtimeMode` names the runtime's *shape* — a managed kernel container vs
  // the mock. The gateway's requirement is that a real runtime exists to hold a
  // workload token.
  if (config.runtimeMode === "mock") throw readinessFailure("model_gateway_runtime_mode_invalid");
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
  if (!supportedDeepSeekModels.has(config.deepseekModel)) throw readinessFailure("deepseek_model_invalid");
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
    ["modelGatewayReservationMaxOutputTokens", config.modelGatewayReservationMaxOutputTokens, 1, 384_000],
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
  let receiptFreshness = null;
  if (config.production) {
    let receipt;
    try {
      receipt = readDeepSeekReleaseReceiptFile(config.deepseekReleaseReceiptFile, {
        requireProduction: true,
        signingSecret: config.modelGatewaySigningSecret,
        maxAgeMs: config.deepseekReleaseReceiptMaxAgeMs,
        receiptId: config.deepseekReleaseReceiptId,
        sourceRevision: config.sourceRevision,
        configRevision: config.deepseekConfigRevision,
        model: config.deepseekModel,
      });
    } catch (error) {
      throw readinessFailure(error?.code ?? "deepseek_release_receipt_invalid");
    }
    // Reported while the receipt is still valid, which is the only time the
    // report is worth anything. The receipt attests what the model did when it
    // was probed, so it cannot be renewed by re-stamping — renewal means
    // running the gate again. What was missing was never the expiry: it was
    // that the first and only signal arrived at the moment it had already
    // expired, and production then sat red for eight days.
    const freshness = deepSeekReleaseReceiptFreshness(receipt, {
      nowMs: Date.now(),
      maxAgeMs: config.deepseekReleaseReceiptMaxAgeMs,
    });
    receiptFreshness = {
      receiptExpiresInMs: Math.max(0, freshness.remainingMs),
      receiptRenewalDue: freshness.renewalDue,
      ...(freshness.renewalDue ? { receiptRenewalCommand: DEEPSEEK_RECEIPT_RENEWAL_COMMAND } : {}),
    };
  }
  return {
    enabled: true,
    model: config.deepseekModel,
    keySource: config.deepseekApiKeySource,
    signingSecretSource: config.modelGatewaySigningSecretSource,
    ...(receiptFreshness ?? {}),
  };
}

function readinessRelease(config) {
  if (config.releaseManifestError) throw readinessFailure(config.releaseManifestError);
  const manifest = config.releaseManifest;
  if (!manifest) {
    if (config.production) throw readinessFailure("release_manifest_missing");
    return { required: false, tracked: false };
  }

  // One kernel, one manifest shape. This comparison and the one in
  // `releaseManifest.mjs` are parallel readings of the same rows: when the
  // manifest could name either of two kernels, only one of them had learned it,
  // and the other compared against `undefined` and failed
  // `release_manifest_mismatch` on every deployment of the newer kernel.
  //
  // A manifest from before the kernel change needs no guard here: its runtime
  // row has no `dshVersion`, and `releaseManifest.mjs` requires that key by
  // name, so it is refused at parse as `release_manifest_runtime_fields_invalid`
  // and never reaches this comparison. The rollback work added a check for it
  // here; it could not fire, and an unreachable guard reads as protection the
  // deployment does not get from it.
  const mismatches = [
    ["releaseId", config.releaseId, manifest.app.releaseId],
    ["appVersion", config.appVersion, manifest.app.version],
    ["sourceRevision", config.sourceRevision, manifest.source.revision],
    ["buildCreatedAt", config.buildCreatedAt, manifest.source.createdAt],
    ["webContainerImage", config.webContainerImage, manifest.web.image],
    ["runtimeContainerImage", config.runtimeContainerImage, manifest.runtime.image],
    ["dshVersion", config.dshVersion, manifest.runtime.dshVersion],
    ["socketBundleVersion", config.socketBundleVersion, manifest.runtime.socketVersion],
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

  const usesDockerRuntime = config.runtimeMode === "kernel" && config.runtimeSandboxMode === "docker";
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

export async function readinessBackup(config, database = null) {
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
    return { ...summary, external: true, postgres: await postgresBackupReadiness(config, database) };
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
    postgres: await postgresBackupReadiness(config, database),
  };
}

async function inspectRuntimeImage(config, unavailableCode, runtimeManager) {
  let imageId;
  let kernelVersion;
  let uvVersion;
  if (runtimeManager.usesRuntimeController()) {
    let image;
    try {
      image = await runtimeManager.inspectRuntimeImage();
    } catch (error) {
      throw readinessFailure(error?.code ?? unavailableCode);
    }
    ({ imageId, kernelVersion, uvVersion } = image);
  } else {
    // The kernel-neutral label, which is the only one the runtime image
    // publishes. This used to read a kernel-specific one as well
    // (`io.open-science.opencode.version`), which the DSH image does not carry,
    // so production readiness failed `runtime_image_metadata_missing` on every
    // DSH deployment: a check that could not survive the kernel it was gating.
    const format = [
      "{{.Id}}",
      '{{index .Config.Labels "io.open-science.runtime.version"}}',
      '{{index .Config.Labels "io.open-science.uv.version"}}',
    ].join("|");
    const image = spawnSync(
      config.runtimeContainerBin,
      ["image", "inspect", "--format", format, config.runtimeContainerImage],
      { encoding: "utf8", timeout: 5_000 },
    );
    if (image.status !== 0) throw readinessFailure(unavailableCode);
    const [id, neutralVersion, uv] = image.stdout.trim().split("|");
    imageId = id;
    kernelVersion = neutralVersion;
    uvVersion = uv;
  }
  if (!config.production) return { imageLocal: true, imageVerified: false };

  if (!imageId || !kernelVersion || !uvVersion) {
    throw readinessFailure("runtime_image_metadata_missing");
  }
  const recorded = config.releaseManifest?.runtime;
  if (!recorded) throw readinessFailure("release_manifest_missing");
  const mismatch = [
    ["imageId", imageId, recorded.imageId],
    ["kernelVersion", kernelVersion, recorded.dshVersion],
    ["uvVersion", uvVersion, recorded.uvVersion],
  ].find(([, actual, expected]) => actual !== expected);
  if (mismatch) throw readinessFailure("runtime_image_provenance_mismatch", { field: mismatch[0] });
  return { imageLocal: true, imageVerified: true };
}

async function readinessRuntime(config, runtimeManager) {
  // Which kernel this deployment is on and at which version, reported on every
  // branch. There is one kernel now, but "what am I actually running" is still
  // a question an operator must be able to answer without reading env files.
  //
  // `compactionPolicy` and `capabilitySkillsDir` ride along because they are
  // the two settings a paired evaluation declares about the deployment it ran
  // on and cannot set over HTTP. Without them in readiness the harness could
  // only write the word "declaredOnly" in its report, which reads like a
  // result and is an admission that nobody checked.
  const kernel = {
    kernel: RUNTIME_KERNEL_NAME,
    kernelVersion: config.dshVersion,
    compactionPolicy: config.runtimeCompactionPolicy,
    capabilitySkillsDir: RUNTIME_CAPABILITY_SKILLS_DIR,
  };
  // The kernel's browser application is this product's session surface, so a
  // production deployment that switches it on and leaves it unaddressable has
  // no session surface at all -- and would say nothing about it. Both halves
  // are required: a listener on an arbitrary free port is unreachable from the
  // outside, and a page that cannot name the origin cannot frame it.
  if (config.production && config.runtimeUiProxyEnabled) {
    if (!Number(config.runtimeUiPort)) throw readinessFailure("runtime_ui_port_required");
    if (!originFor(config.runtimeUiPublicOrigin)) throw readinessFailure("runtime_ui_public_origin_required");
    assertRuntimeUiFrameConfiguration(config);
  }
  if (config.runtimeMode === "mock") {
    if (config.production && !config.allowMockRuntime) throw readinessFailure("runtime_mock_forbidden");
    return { mode: "mock", sandboxMode: "mock", explicit: Boolean(config.allowMockRuntime), ...kernel };
  }
  if (config.runtimeMode !== "kernel") {
    throw readinessFailure("runtime_mode_invalid");
  }
  if (config.runtimeSandboxMode === "docker") {
    if (!config.runtimeContainerBin) throw readinessFailure("runtime_container_bin_missing");
    if (!config.runtimeContainerImage) throw readinessFailure("runtime_container_image_missing");
    const transport = String(config.runtimeTransport ?? "").trim().toLowerCase();
    if (transport !== "unix") throw readinessFailure("runtime_transport_invalid");
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
        mode: "kernel",
        sandboxMode: "docker",
        controlPlane,
        transport,
        dataMount: config.runtimeDataVolume ? "volume" : "bind",
        ...kernel,
        ...image,
        ...network,
      };
    }
    return {
      mode: "kernel",
      sandboxMode: "docker",
      controlPlane,
      transport,
      dataMount: config.runtimeDataVolume ? "volume" : "bind",
      imageLocal: false,
      imageCheck: "skipped",
      ...kernel,
      ...network,
    };
  }
  // No host mode: the kernel's EviMed composition lives in the runtime image,
  // so a host binary would serve a runtime that can satisfy nothing (see
  // `buildRuntimeLaunchPlan`). Readiness says so rather than passing a
  // deployment that would refuse at the first run.
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
