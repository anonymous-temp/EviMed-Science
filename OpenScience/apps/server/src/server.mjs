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
import { LEARNING_PROJECT_ID, SOURCES_PROJECT_ID, isInternalProject } from "./internalProjects.mjs";
import { loadAgentRegistry } from "./agentRegistry.mjs";
import { AgentRunStore, isResearcherRun, readRunStateProjection, runNotice } from "./agentRuns.mjs";
import { PreStopTranscripts, collectRunTranscripts, persistRunTranscript, pruneRunTranscripts, readRunTranscript } from "./runTranscripts.mjs";
import { resolveGatewayFetch } from "./recordedGateway.mjs";
import { LearningService } from "./learningService.mjs";
import { LearningTriggers } from "./learningTriggers.mjs";
import { createLearningRuntime } from "./learningRuntime.mjs";
import { EVALUATION_JUDGE_LIMITS, evaluateLearnedMethod } from "./learningEvaluation.mjs";
import { freezeLearningBaseline } from "./learningBaseline.mjs";
import { MethodDistillationRuns } from "./methodDistillationRuns.mjs";
import { MethodConsolidation } from "./methodConsolidation.mjs";
import { LearningWorker } from "./learningWorker.mjs";
import { runMethodObservations } from "./methodObservations.mjs";
import { persistExecutedToolEdges, persistGoldenTraces } from "./toolExecutionEdges.mjs";
import { CONNECTOR_CREDENTIAL_IDS, autopilotEpisodeCapability, deliverableIdOfPath, geoMetricDefinition, mountedMethodDigest, usagePurposeOfRun } from "@evimed/domain";
import { ResearchSessionStore } from "./researchSessions.mjs";
import { prepareResearchContext } from "./researchContext.mjs";
import {
  OPEN_DOMAIN_ANSWER_AGENT_ID,
  classifierFailureReason,
  routeNamedSpecialist,
  routeOpenDomainSpecialist,
} from "./specialistRouting.mjs";
import { SpecialistClassifier } from "./specialistClassifier.mjs";
import { RunTitleScheduler, RunTitler } from "./runTitles.mjs";
import { runEstimate } from "./runRoute.mjs";
import { BUNDLED_EXAMPLES, createCommandRegistry } from "./commands.mjs";
import { loadConfig } from "./config.mjs";
import { assertDockerVolumeName } from "./dockerMounts.mjs";
import { createModelGatewayHandler, issueModelGatewayBudgetMarker, MODEL_GATEWAY_PATH, supportedDeepSeekModels } from "./modelGateway.mjs";
import { createRuntimeGatewayEntry } from "./runtimeGatewayEntry.mjs";
import { assertSpendWithinLimits, readUsageEvents, summarizeUsage } from "./usageMetering.mjs";
import { UsageLedger } from "./usageLedger.mjs";
import { accountUsageRuns } from "./accountUsageRuns.mjs";
import { NotificationService, runFinishedInboxItem, runFinishedReachesInbox } from "./notificationService.mjs";
import { createNotificationRoutes } from "./notificationRoutes.mjs";
import { withdrawProjectDerivedMemory } from "./derivedMemory.mjs";
import { createLearningRoutes } from "./learningRoutes.mjs";
import { createMemoryRoutes } from "./memoryRoutes.mjs";
import { sessionDispatchNotes } from "./memorySessions.mjs";
import { createMemoryTimelineRoutes } from "./memoryTimeline.mjs";
import { AgentApiKeyStore } from "./agentApiKeys.mjs";
import { createAgentMemoryRoutes } from "./agentMemoryRoutes.mjs";
import { createAgentKeyRoutes } from "./agentKeyRoutes.mjs";
import {
  createPublicSourceGatewayHandler,
  PUBLIC_SOURCE_GATEWAY_PATH,
  publicSourceCredentialReadiness,
} from "./publicSourceGateway.mjs";
import { WEB_SEARCH_GATEWAY_PATH, createWebSearchGatewayHandler } from "./webSearchGateway.mjs";
import { GEO_PROBE_GATEWAY_PATH, createGeoProbeGatewayHandler } from "./geoProbeGateway.mjs";
import { ResearchMemoryStore } from "./researchMemory.mjs";
import { MEMORY_KIND_LABELS_ZH, migrateResearchMemory } from "./researchMemoryPersistence.mjs";
import { MemorySubstrate, selectedMemoryIndexProvider } from "./memorySubstrate.mjs";
import { MemoryRerank } from "./memoryRerank.mjs";
import { OpenVikingClient } from "./openVikingClient.mjs";
import { ProductDocuments, ProductJobs } from "./productStore.mjs";
import { FeedbackEvents, deliverableSubjectId } from "./feedbackEvents.mjs";
import { withAccountExportSnapshot, appendAccountStateArchiveEntry } from "./accountExport.mjs";
import { migrateProductStore } from "./productPersistence.mjs";
import { CONNECTOR_CREDENTIAL_GATEWAY_PATH, ConnectorCredentialStore, createConnectorCredentialGatewayHandler } from "./connectorCredentials.mjs";
import { createEngineUsageHandler, ENGINE_USAGE_PATH } from "./engineUsage.mjs";
import { RunMetrics, runCapabilityLabel } from "./runMetrics.mjs";
import { relationalIntegrity } from "./relationalIntegrity.mjs";
import { MemoryIndexing } from "./memoryIndexing.mjs";
import { MemoryIndexWorker } from "./memoryIndexWorker.mjs";
import { MaintenanceService } from "./maintenanceService.mjs";
import { CapsuleService } from "./capsuleService.mjs";
import { CapsuleIdentityStore } from "./capsuleIdentityStore.mjs";
import { CapsuleTransferService } from "./capsuleTransferService.mjs";
import { createCapsuleRoutes } from "./capsuleRoutes.mjs";
import { SourceService, assertKnowledgeBaseFormat, projectSourceManifestRecord, sourceIndexDocument } from "./sourceService.mjs";
import { verifySourceMetadata } from "./sourceMetadata.mjs";
// Knowledge-base search (2026-09-20): the index, its embedder and its gateway.
import { KB_RERANK_INSTRUCT, KnowledgeBaseIndex } from "./kbIndex.mjs";
import { createLibrary } from "./libraryService.mjs";
import { KbEmbedder } from "./kbEmbedding.mjs";
import { KB_SEARCH_GATEWAY_PATH, createKbSearchGatewayHandler } from "./kbSearchGateway.mjs";
// 「前沿动态」 search for the runtime's `frontier_search` tool (2026-09-22).
import { FRONTIER_GATEWAY_PATH, createFrontierGatewayHandler } from "./frontierGateway.mjs";
// The independent reviewer (plan 2026-09-22, tiered review): the gateway a
// run's submission asks, the module that reviews, and its reply-check worker.
import { REVIEW_GATEWAY_PREFIX, createReviewGatewayHandler } from "./reviewGateway.mjs";
import { ReviewService, replyOfRun, reviewMetricFamilies } from "./reviewService.mjs";
import { providerRefusalMetricFamily } from "./providerRefusals.mjs";
import { ReviewWorker } from "./reviewWorker.mjs";
import { createReviewRoutes, reviewRoutePattern } from "./reviewRoutes.mjs";
import { CapsuleScanner } from "./capsuleScan.mjs";
import { createSourceRoutes } from "./sourceRoutes.mjs";
import { SourceIngestionWorker } from "./sourceWorker.mjs";
import { SourceUnderstandingRuns } from "./sourceUnderstandingRuns.mjs";
import { createSourceUnderstandingRuntime } from "./sourceUnderstandingRuntime.mjs";
import { MethodDescriber } from "./methodDisplay.mjs";
import { removeSourceCopies, sourceAttemptId, sourceReadCopyDirectory } from "./sourceFiles.mjs";
import { DocumentParserClient } from "./documentParserClient.mjs";
import { createWebRenderer } from "./agentbay/browser.mjs";
import { createWebReader, webReadMetricFamilies, webReadTransportFor, webReadUserAgent } from "./webRead.mjs";
import { edgeMetricFamilies, edgeProxyFromConfig, fetchWithEdge } from "./edgeProxy.mjs";
import { pagesReadFromSessions } from "./webReadPages.mjs";
import { createSourceUpdateLookup, sourceUpdateMetricFamilies } from "./sourceUpdates.mjs";
import { OpenListClient } from "./openListClient.mjs";
import { OpenListSourceConnector } from "./openListSourceConnector.mjs";
import { AutopilotService, VERIFICATION_ARTIFACT, VERIFICATION_ROUTE_REASON, parseVerificationResult, verificationBrief,
  verificationEpisodeId, verificationPrompt, verificationWorkspacePath } from "./autopilotService.mjs";
import { createAutopilotRoutes } from "./autopilotRoutes.mjs";
import { AutopilotWorker } from "./autopilotWorker.mjs";
// 「前沿动态」, the frontier feed (plan 2026-09-21 §7): the plugin client, the
// ingest, package E's editor and pipeline, the reader's service and routes, and
// the worker that turns them.
import { KnowledgePluginClient } from "./knowledgePluginClient.mjs";
import { FrontierIngest } from "./frontierIngest.mjs";
import { FrontierEditor } from "./frontierEditor.mjs";
import { FrontierPipeline } from "./frontierPipeline.mjs";
import { FrontierService, frontierAudienceAllows, frontierDomainVocabulary, frontierMetricFamilies, frontierMetricsSnapshot,
  frontierReadiness } from "./frontierService.mjs";
import { createFrontierRoutes, frontierRoutePattern } from "./frontierRoutes.mjs";
import { FrontierWorker, ensureFrontierProject } from "./frontierWorker.mjs";
// Its second wave: events and the hot list, the daily and its push, 与你相关,
// the two reader actions, and the composer the worker ticks.
import { FrontierEvents } from "./frontierEvents.mjs";
import { FrontierDaily } from "./frontierDaily.mjs";
import { FrontierProfiles } from "./frontierProfiles.mjs";
import { FrontierActions } from "./frontierActions.mjs";
import { FrontierComposer } from "./frontierComposer.mjs";
// 「循证 GEO」 (build spec 2026-09-25): the schema's content store, the pages'
// service and routes, the runtime tools' gateway and the social channel. The
// measurement, market and orchestration packages attach to the composed
// `geo` object (`geo.worker`, `geo.orchestrator`, `geo.market`, `geo.exporter`).
import { GeoStore, deleteGeoProjectRows, deleteGeoUserRows, removeGeoScreenshotFiles } from "./geoStore.mjs";
import { createGeoDeliveryImport } from "./geoDeliveryImport.mjs";
import { geoArticleGateOf } from "./geoWrites.mjs";
import { GEO_DEFAULT_PROJECT_NAME, GeoService, geoAudienceAllows, geoMetricFamilies, geoMetricsSnapshot, geoReadiness } from "./geoService.mjs";
import { createGeoRoutes, geoRoutePattern } from "./geoRoutes.mjs";
import { GEO_GATEWAY_PATH, createGeoGatewayHandler, geoGatewayRoutePattern } from "./geoGateway.mjs";
import { createSocialCrawlClient } from "./socialCrawlClient.mjs";
// The moving parts (packages B, C and F): measurement ticks and rounds, the
// marketplace's ticks and hooks, the orchestrator, the worker and the notices.
import { GeoOrchestrator } from "./geoOrchestrator.mjs";
import { GeoWorker, withGeoWorkerWarnings } from "./geoWorker.mjs";
import { createGeoNotifier } from "./geoNotify.mjs";
import { GeoMeasureStore } from "./geoMeasureStore.mjs";
import { enqueueRound as enqueueGeoRound, geoMeasureState, tickProbe as tickGeoProbe } from "./geoProbeQueue.mjs";
import { tickParse as tickGeoParse } from "./geoJudge.mjs";
import { tickMetrics as tickGeoMetrics } from "./geoMetricsJob.mjs";
import { tickErrors as tickGeoErrors } from "./geoErrors.mjs";
import { GeoMarketStore } from "./geoMarketStore.mjs";
import { cancelOrder as cancelGeoOrder, clearStop as clearGeoMarketStop, confirmTopup as confirmGeoTopup, markOrderLost as markGeoOrderLost,
  marketStatus as geoMarketStatus, noteCitation as noteGeoCitation, resolveUnknownOrder as resolveGeoUnknownOrder, setBudget as setGeoBudget,
  tickCatalogue as tickGeoCatalogue, tickOrders as tickGeoOrders, tickPoll as tickGeoPoll, tickReconcile as tickGeoReconcile,
  tickTopups as tickGeoTopups, tickVerify as tickGeoVerify } from "./geoMarket.mjs";
import { createMediaMarketClient } from "./mediaMarketClient.mjs";
import { GeoInclusionClient, inclusionEnabled } from "./geoInclusionClient.mjs";
import { assertBoundedRunAffordable, boundedRunBudget } from "./boundedRunBudget.mjs";
import { createImModule } from "./imService.mjs";
import { CAPSULE_GATEWAY_PATH, createCapsuleGatewayHandler } from "./capsuleGateway.mjs";
import { REVISION_GATEWAY_PATH, createRevisionGatewayHandler } from "./revisionGateway.mjs";
import { MEMORY_WRITE_SKIPPED_SOURCES, MemoryIntelligence } from "./memoryIntelligence.mjs";
import { OidcService, validateOidcSettings } from "./oidc.mjs";
import { runtimeReleasePolicyError } from "./releaseManifest.mjs";
import {
  RUNTIME_CAPABILITY_SKILLS_DIR,
  RUNTIME_KERNEL_NAME,
  RuntimeManager,
  runtimeCompactionSettings,
  runtimeNetworkRequiresEgressOptIn,
  runtimeNetworkUsesHostOrContainer,
  validateEviMedAdapterConfig,
} from "./runtimeManager.mjs";
import { createStore, projectDisplayName, projectIdFromName } from "./store.mjs";
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
      // `'self'` is the file preview: a PDF or a page is shown in a frame of
      // `/api/files/preview/…` on this origin. Without it every preview drawer
      // in the product showed Chrome's 「该内容被屏蔽了」 (2026-09-24). What
      // that frame may do is the preview response's own policy
      // (`previewContentSecurityPolicy`); the shell itself stays unframeable.
      ["frame-src 'self'", uiOrigin].filter(Boolean).join(" "),
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
  if (pathname === "/api/account" || pathname === "/api/account/export" || pathname === "/api/account/usage" || pathname === "/api/account/usage/runs") return pathname;
  if (pathname === "/api/connectors") return pathname;
  if (pathname.startsWith("/api/connectors/")) return "/api/connectors/:connector";
  if (pathname === "/api/ops/metrics") return pathname;
  if (pathname === "/api/ops/usage/by-purpose") return pathname;
  if (pathname.startsWith("/api/auth/oidc/")) return "/api/auth/oidc/:action";
  if (
    pathname === "/api/auth/login" ||
    pathname === "/api/auth/logout" ||
    pathname === "/api/auth/password" ||
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
  if (pathname.startsWith("/api/memory/")) return "/api/memory/:route";
  if (pathname.startsWith("/api/agent-memory/v1")) return "/api/agent-memory/v1/:action";
  if (pathname.startsWith("/api/agent-keys/")) return "/api/agent-keys/:keyId";
  if (pathname === "/api/agent-keys") return pathname;
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
  if (pathname === "/api/frontier" || pathname.startsWith("/api/frontier/")) return frontierRoutePattern(pathname);
  if (pathname === "/api/review" || pathname.startsWith("/api/review/")) return reviewRoutePattern(pathname);
  if (pathname === "/api/geo" || pathname.startsWith("/api/geo/")) return geoRoutePattern(pathname);
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
    pathname === CONNECTOR_CREDENTIAL_GATEWAY_PATH ||
    pathname === ENGINE_USAGE_PATH ||
    pathname === KB_SEARCH_GATEWAY_PATH ||
    pathname === FRONTIER_GATEWAY_PATH
  ) return pathname;
  if (pathname.startsWith(REVIEW_GATEWAY_PREFIX)) return pathname.startsWith(`${REVIEW_GATEWAY_PREFIX}deliverables/`) ? `${REVIEW_GATEWAY_PREFIX}deliverables/:id` : pathname;
  if (pathname.startsWith(`${GEO_GATEWAY_PATH}/`)) return geoGatewayRoutePattern(pathname);
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

/**
 * A failed recall, for a dispatch that must not answer without memories.
 *
 * A research-memory store exists exactly when the control-plane database does,
 * so a store that is there and cannot answer is a fault rather than a
 * deployment choice: the agent would otherwise reply as if the researcher had
 * never told it anything, and nothing in the reply would say so. The only other
 * way a recall throws is a strict index that is down, which is the operator
 * asking for exactly this. Definitive, because a repair attempt would run the
 * same broken recall again.
 *
 * @param {any} error
 */
/**
 * A dispatch's explicit line (`line` on `POST /api/agent-runs/dispatch`):
 * `"answer"` for the answer line, or the id of a public capability. Null when
 * the caller chose nothing. A choice is only meaningful where the platform
 * would otherwise route — an open conversation; one bound to a capability
 * already has its line, and a choice there is refused rather than ignored.
 *
 * @param {unknown} value
 * @param {any} boundSession
 * @param {readonly any[]} routableAgents public capabilities, answer line excluded
 * @returns {{ agent: any | null } | null}
 */
function chosenDispatchLine(value, boundSession, routableAgents) {
  if (value == null) return null;
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(value)) {
    throw new HttpError(400, "invalid_agent_run", "line must be \"answer\" or a capability id.");
  }
  if (boundSession?.mode !== "open-domain") {
    throw new HttpError(400, "invalid_agent_run", "A line can be chosen only in an open conversation; this one is bound to a capability.");
  }
  if (value === "answer") return { agent: null };
  const agent = routableAgents.find((candidate) => candidate.id === value);
  if (!agent) throw new HttpError(400, "invalid_agent_run", "line names no capability this deployment offers.");
  return { agent };
}

function memoryRecallRejection(error) {
  /** @type {any} */
  const rejection = error instanceof HttpError
    ? error
    : new HttpError(503, "memory_unavailable", "Required research memory is unavailable.");
  rejection.definitivelyRejected = true;
  return rejection;
}

/**
 * Whether a run was started by a machine rather than a person: an evaluation
 * or acceptance harness that said so at dispatch, an autopilot episode (its
 * route reason is minted by the dispatcher, `autopilot:<task>`), or an
 * independent verification (its dispatch id is a shape `/runs` refuses from a
 * client). Such a run's completion is recorded in the inbox without notifying
 * anyone (C1).
 * @param {Record<string, any>} run
 */
/**
 * One run's usage from the ledger's per-run aggregate (C3 `usage`). A run is
 * stamped under its own id by the model gateway, and a bounded run (autopilot,
 * verification) under the id its runtime was minted for, which is the run's
 * dispatch id; both are read and added. Null when nothing was attributed.
 * @param {Map<string, any>} summaries @param {Record<string, any>} run
 */
/**
 * How long after a run started its first attributed model call may come and
 * the run still count as measured. A run's first call follows its start by
 * seconds; one whose first attributed call came later than this began before
 * calls were attributed (2026-09-18), and the sum of what was attributed
 * afterwards — a title, a memory pass — would read as the run's whole cost.
 */
export const RUN_USAGE_START_SLACK_MS = 10 * 60_000;

export function runUsageFrom(summaries, run) {
  const parts = [summaries.get(run.id), run.dispatchId && run.dispatchId !== run.id ? summaries.get(run.dispatchId) : null].filter(Boolean);
  if (parts.length === 0) return null;
  const started = Date.parse(run.startedAt ?? run.createdAt ?? "");
  const firsts = parts.map((part) => Date.parse(part.firstRequestAt ?? "")).filter(Number.isFinite);
  if (Number.isFinite(started) && firsts.length > 0 && Math.min(...firsts) - started > RUN_USAGE_START_SLACK_MS) return null;
  const sum = (field) => parts.reduce((total, part) => total + (Number(part[field]) || 0), 0);
  return {
    requests: sum("requests"), inputTokens: sum("inputTokens"), cachedInputTokens: sum("cachedInputTokens"),
    outputTokens: sum("outputTokens"), costCny: Math.round(sum("costCny") * 1e6) / 1e6,
  };
}

export function automatedRun(run) {
  return run?.automated === true
    || String(run?.effectiveRouteReason ?? "").startsWith("autopilot:")
    || Boolean(verificationEpisodeId(run?.dispatchId));
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
  const connectorCredentials = overrides.connectorCredentials
    ?? (productDatabase && typeof config.modelGatewaySigningSecret === "string" && config.modelGatewaySigningSecret.length >= 32
      ? new ConnectorCredentialStore({ database: productDatabase, secret: config.modelGatewaySigningSecret, config })
      : null);
  let maintenanceService = null;
  const maintenanceMutation = (operation) => maintenanceService ? maintenanceService.withMutation(operation) : operation();
  const productDocuments = productDatabase ? new ProductDocuments(productDatabase) : null;
  const productJobs = productDatabase ? new ProductJobs(productDatabase) : null;
  const pluginService = productDatabase ? new PluginService(productDatabase, { jobs: productJobs, maxTimeoutMs: config.publicSourceGatewayTimeoutMs }) : null;
  const pluginRoutes = createPluginRoutes({ store, service: pluginService, maxJsonBytes: config.maxJsonBytes });
  // `overrides.usageLedger` is for tests that need the ledger's interface
  // without a database, as `researchMemory` and `connectorCredentials` are.
  const usageLedger = overrides.usageLedger ?? (productDatabase ? new UsageLedger(productDatabase) : null);
  const notificationService = productDatabase ? new NotificationService(productDatabase) : null;
  const notificationRoutes = createNotificationRoutes({ store, service: notificationService, maxJsonBytes: config.maxJsonBytes });
  let notificationTimer = null;
  let notificationRun = null;
  let inboxPrunedAt = 0;
  const applyNotificationDefaults = () => {
    if (!notificationService) return Promise.resolve([]);
    if (notificationRun) return notificationRun;
    notificationRun = maintenanceMutation(async () => {
      const applied = await notificationService.applyDueDefaults();
      // The retention sweep rides the same tick, at most hourly: read items
      // leave 90 days after they were read (C1). Its own failure is reported
      // on its own line, and never costs the defaults that were applied.
      if (Date.now() - inboxPrunedAt >= 3_600_000) {
        inboxPrunedAt = Date.now();
        await notificationService.pruneRead().catch((/** @type {any} */ error) => {
          process.stderr.write(`inbox retention sweep failed: ${typeof error?.code === "string" ? error.code : "notification_unavailable"}\n`);
        });
      }
      return applied;
    }).catch((error) => {
      if (error?.code === "maintenance_active") return [];
      process.stderr.write(`inbox default processing failed: ${typeof error?.code === "string" ? error.code : "notification_unavailable"}\n`);
      return [];
    }).finally(() => { notificationRun = null; });
    return notificationRun;
  };
  // Research memory — the structured records and the manual notes — is a schema
  // of the control-plane database, so the store exists exactly when that
  // database does. `overrides.researchMemory` is for tests that need the
  // interface without one.
  const openVikingClient = overrides.openVikingClient
    ?? new OpenVikingClient(config, { fetchImpl: overrides.openVikingFetch ?? globalThis.fetch });
  // Whether a memory write has an index to tell about it. Decided before the
  // store is built, because the store is handed the outbox only when something
  // will claim from it, and decided by the same function the substrate reads so
  // that the writer and the reader cannot disagree about which provider is on.
  const memoryIndexActive = selectedMemoryIndexProvider(config) === "openviking"
    && Boolean(openVikingClient.configured) && Boolean(productDatabase && productJobs);
  const researchMemory = overrides.researchMemory
    ?? new ResearchMemoryStore(config, {
      database: productDatabase, jobs: memoryIndexActive ? productJobs : null,
    });
  // One reranker for both recall paths. It orders candidates that have already
  // been hydrated from the authoritative store, because the index's own
  // reranked endpoint navigates by directory abstracts that nothing generates
  // for this layout. Unconfigured it is inert: the vector order stands.
  const memoryRerank = overrides.memoryRerank ?? new MemoryRerank({
    apiKey: config.dashscopeApiKey,
    model: config.memoryRerankModel,
    apiBase: config.memoryRerankApiBase,
    timeoutMs: config.memoryRerankTimeoutMs,
  }, { fetchImpl: overrides.memoryRerankFetch ?? globalThis.fetch });
  // Which component ranks a recall. The records themselves stay in the
  // control-plane database whichever provider is selected.
  const memorySubstrate = new MemorySubstrate(config, {
    store: researchMemory, openViking: openVikingClient, rerank: memoryRerank,
    jobs: memoryIndexActive ? productJobs : null,
  });
  // One switch governs both recall paths: the capsule index is the same
  // OpenViking the research recall uses, so it exists exactly when that
  // provider is selected and reachable — never as a second thing to configure.
  const memoryIndexing = productDatabase && productJobs && memorySubstrate.active
    ? new MemoryIndexing({ database: productDatabase, openViking: openVikingClient, jobs: productJobs, rerank: memoryRerank }) : null;
  // Composed whenever there is a queue, not only when there is an index. The
  // database trigger that enqueues `memory-index` jobs fires on every capsule
  // and fact write — a Postgres trigger cannot read this config — so a
  // `builtin` deployment produced jobs nobody would ever claim. With no
  // indexing the worker drains them and records why (M5, 2026-09-16).
  const memoryIndexWorker = productJobs
    ? new MemoryIndexWorker({ jobs: productJobs, indexing: memoryIndexing,
      substrate: memoryIndexing ? memorySubstrate : null,
      pollMs: config.memoryIndexPollMs, leaseMs: config.memoryIndexLeaseMs,
      reconcileMs: config.memoryIndexReconcileMs }) : null;
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
    ? new LearningService({ documents: productDocuments, jobs: productJobs,
      resolveBaselineDigest: async (userId, projectId) => {
        const user = await store.userById(userId);
        if (!user) throw new HttpError(404, "learning_account_unavailable", "The evaluation owner is unavailable.");
        await store.requireProject(user, projectId);
        return (await freezeLearningBaseline({ learning: learningService, capsules: capsuleService, userId, projectId })).baselineDigest;
      } })
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
    // The whole library: a researcher's methods follow them across projects
    // (`selectLearnedMethods`), so a use is attributed wherever it happens.
    const approved = await learningService.approvedMethods(project.userId);
    /** @type {any[]} */
    const accountWide = [];
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
  /** What queues a lesson when a run finishes (learningTriggers.mjs). */
  /** @type {LearningTriggers | null} */
  let learningTriggers = null;
  // Strictness reaches the capsules too. An operator who asked for a failing
  // index to be visible must not be given the lexical fallback in silence on
  // one of the two recall paths.
  // The automatic scan a shared capsule passes (capsuleScan.mjs), metered like
  // every control-plane model call.
  const capsuleScanner = new CapsuleScanner(config, { usageLedger, fetchImpl: overrides.capsuleScanFetch ?? globalThis.fetch });
  const capsuleService = productDocuments
    ? new CapsuleService(productDocuments, { indexing: memoryIndexing, strictIndex: config.memoryIndexStrict, scanner: capsuleScanner })
    : null;
  const capsuleTransferService = productDocuments ? new CapsuleTransferService({ documents: productDocuments, capsules: capsuleService, identities: new CapsuleIdentityStore(config.dataDir), dataDir: config.dataDir, scanner: capsuleScanner }) : null;
  const capsuleRoutes = createCapsuleRoutes({ store, service: capsuleService, transferService: capsuleTransferService, maxJsonBytes: config.maxJsonBytes,
    // A 「试用一次」 conversation is marked in its own memory state.
    trials: researchMemory.configured ? { mark: (userId, projectId, sessionId, capsuleId) => researchMemory.updateSessionState(userId, projectId, sessionId,
      { trialCapsuleId: capsuleId }) } : null });
  const memoryRoutes = createMemoryRoutes({
    config, researchMemory, memorySubstrate, feedbackEvents, store, context, audit, recordFeedback, decodeRouteComponent,
  });
  const agentApiKeys = productDatabase ? new AgentApiKeyStore(productDatabase) : null;
  const agentKeyRoutes = createAgentKeyRoutes({ config, apiKeys: agentApiKeys, context, audit });
  const sourceService = productDocuments && productJobs ? new SourceService(productDocuments, productJobs) : null;
  const documentParser = new DocumentParserClient({
    baseUrl: config.documentParserUrl,
    token: config.documentParserToken,
    revision: config.documentParserRevision,
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
  // One admission for every way a file reaches `knowledge-base/`: the upload
  // route and the upload command both refuse a format the knowledge base
  // cannot read before a byte is written, and both register what they wrote.
  // The web page uploads through the command, which until 2026-09-20 wrote
  // the file and registered nothing — a researcher's upload never became a
  // source, and the knowledge base stayed empty however much was uploaded.
  const knowledgeBaseUploads = {
    /** @param {string} root @param {string} rel */
    covers: (root, rel) => root === "base" && (rel === "knowledge-base" || rel.startsWith("knowledge-base/")),
    /** @param {string} rel */
    admit: (rel) => assertKnowledgeBaseFormat(rel),
    /** @param {any} ctx @param {string} rel @param {Buffer} buffer */
    register: async (ctx, rel, buffer) => {
      if (!sourceService) return null;
      const registered = await sourceService.register(ctx.user.id, {
        projectId: ctx.project.id,
        connector: { type: "upload", id: `${ctx.project.id}-library` },
        path: rel,
        size: buffer.length,
        mtime: new Date().toISOString(),
        mimeType: mimeFor(rel),
        sha256: createHash("sha256").update(buffer).digest("hex"),
      });
      await audit(ctx, "source.register", "completed", { target: registered.source.id, duplicate: registered.duplicate });
      return registered;
    },
  };
  /**
   * Write one file into a project the way an upload writes it — the one path
   * `/api/files/upload` and 「前沿动态」's 存入知识库 (frontierActions.mjs) share,
   * so a saved item is a source like any upload: the size limit, the knowledge
   * base's format admission, the project's capacity, an atomic no-follow
   * write, the mirror into a running runtime, the audit line, and the source
   * registration that parses and indexes it. Returns the registration, or null
   * outside `knowledge-base/`.
   * @param {{ config: any, user: any, project: any }} ctx @param {{ root: string, rel: string, buffer: Buffer }} file
   */
  const writeProjectUpload = async (ctx, { root, rel, buffer }) => {
    if (buffer.length > config.maxFileBytes) throw new HttpError(413, "file_too_large", "file is too large.");
    const base = root === "base" ? ctx.project.baseDir : ctx.project.workspaceDir;
    const full = resolveScopedPath(base, rel);
    const knowledge = knowledgeBaseUploads.covers(root, rel);
    if (knowledge) knowledgeBaseUploads.admit(rel);
    await withProjectStorageMutation(ctx.project, async () => {
      await assertProjectCapacity(ctx.project, full, buffer.length, config);
      await writeFileAtomicNoFollow(base, full, buffer, { mode: 0o600 });
    });
    // rt: a running remote runtime sees the upload now (plan §3.1 #4).
    await runtimeManager.mirrorWorkspaceUpload(ctx.project, full, buffer);
    await audit(ctx, "file.upload", "completed", { target: root === "base" ? `${root}:${rel}` : rel, bytes: buffer.length });
    return knowledge ? knowledgeBaseUploads.register(ctx, rel, buffer) : null;
  };
  const sourceProject = async (job) => {
    const user = await store.userById(job.userId);
    if (!user) throw new HttpError(404, "source_account_unavailable", "Source account is unavailable.");
    return store.requireProject(user, job.projectId);
  };
  let sourceUnderstandingRuntime = null;
  /** @type {KnowledgeBaseIndex | null} */
  let kbIndex = null;
  /** @type {import("./libraryService.mjs").LibraryService | null} */
  let libraryService = null;
  const sourceWorker = sourceService && config.sourceIngestionEnabled ? new SourceIngestionWorker({
    jobs: productJobs,
    sources: sourceService,
    parser: documentParser,
    pollMs: config.sourceIngestionPollMs,
    leaseMs: config.sourceIngestionLeaseMs,
    // The orphan sweep's own line: what it withdrew, or why it could not.
    report: (event, detail) => {
      const failed = event === "derived_memory_sweep_failed";
      void securityAudit(config, "memory.derived.sweep", failed ? "failed" : "completed", failed
        ? { code: detail.code }
        : { code: event, detail: `sources=${detail.sources} projects=${detail.projects} entries=${detail.entries} ledgers=${detail.ledgers}` });
    },
    understandingRuns: new SourceUnderstandingRuns({
      dispatch: request => sourceUnderstandingRuntime.dispatch(request),
      readResult: identity => sourceUnderstandingRuntime.readResult(identity),
    }),
    cancelUnderstanding: identity => sourceUnderstandingRuntime.cancel(identity),
    verifyMetadata: (metadata) => verifySourceMetadata(metadata, {
      fetchImpl: overrides.sourceMetadataFetch ?? globalThis.fetch, timeoutMs: config.sourceDoiCheckTimeoutMs,
    }),
    onPublished: (job) => {
      kbIndex?.wake();
      void libraryService?.refreshSource(job.userId, job.payload?.sourceId);
      // What the platform read out of the document goes into the researcher's
      // capsule here, labelled 来自资料 and reversible — the replacement for
      // the 「放进胶囊」 button that used to ask them to do it once per file
      // (plan §3.10). Never awaited and never able to fail the ingestion: a
      // document is parsed and indexed whatever the capsule is doing, and the
      // publication is idempotent, so the next understanding of the same
      // document retries it.
      void libraryService?.publishSourceUnderstanding(job.userId, job.payload?.sourceId)
        .catch(() => securityAudit(config, "library.publish.failed", "failed", { target: job.payload?.sourceId }));
    },
    // The document's text is written out ahead of its understanding: the
    // index and the library's copy can take it now, so it is searchable and
    // readable while the understanding still runs.
    onReadable: (job) => {
      kbIndex?.wake();
      void libraryService?.refreshSource(job.userId, job.payload?.sourceId);
    },
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
      // The parser reads these bytes once, without following a link, and
      // refuses them unless they hash to the digest the source was registered
      // under — the check that used to sit here before a staging copy.
      return localPath;
    },
    releaseResolved: async (job, source, _resolved) => {
      const project = job.sourceProject;
      if (!project) throw new HttpError(409, "source_scope_unavailable", "The source workspace was not resolved.");
      await withProjectStorageMutation(project, () => removeSourceCopies({ projectRoot: project.baseDir, sourceId: source.id,
        jobIds: [job.id], generation: source.payload.generation, attemptId: sourceAttemptId(job), stagingOnly: true }));
    },
    materialize: async (job, source, result) => {
      const project = job.sourceProject ?? await sourceProject(job);
      const generation = Number(source.payload?.generation);
      if (!Number.isSafeInteger(generation) || generation < 1) throw new HttpError(409, "source_generation_stale", "Source generation is invalid.");
      // Beside the attempt's run directory, never in it: the run's cleanup
      // removes that one, and this text is read while the run still works.
      const relative = `${sourceReadCopyDirectory({ sourceId: source.id, generation, jobId: job.id, attemptId: sourceAttemptId(job) })}/index.md`;
      const full = resolveScopedPath(project.baseDir, relative);
      const value = sourceIndexDocument({ original: source.payload.paths?.[0] ?? source.id, sha256: source.payload.fingerprint.sha256,
        extractor: result.extractor, text: result.text, pageMap: result.pageMap, metadata: result.metadata });
      await withProjectStorageMutation(project, async () => {
        await assertProjectCapacity(project, full, Buffer.byteLength(value), config);
        await writeFileAtomicNoFollow(project.baseDir, full, value, { encoding: "utf8", mode: 0o600 });
      });
      return relative;
    },
    discardMaterialized: async (job, source, _artifactPath) => {
      const project = job.sourceProject ?? await sourceProject(job);
      await withProjectStorageMutation(project, () => removeSourceCopies({ projectRoot: project.baseDir, sourceId: source.id,
        jobIds: [job.id], generation: source.payload.generation, attemptId: sourceAttemptId(job), readCopy: true }));
    },
    prepareCleanup: sourceProject,
    cleanupSource: async (_job, source, jobIds, project) => {
      await withProjectStorageMutation(project, () => removeSourceCopies({ projectRoot: project.baseDir, sourceId: source.id,
        jobIds }));
    },
  }) : null;
  // The knowledge-base index: derived from the sources, switched with
  // `kb_search`. Built only where there is a product database to derive from.
  kbIndex = productDatabase && sourceService && config.kbSearchEnabled ? new KnowledgeBaseIndex({
    database: productDatabase,
    sources: sourceService,
    embedder: overrides.kbEmbedder ?? new KbEmbedder({
      apiKey: config.dashscopeApiKey, model: config.kbEmbeddingModel, dimension: config.kbEmbeddingDimension,
      apiBase: config.kbEmbeddingApiBase, timeoutMs: config.kbEmbeddingTimeoutMs,
    }, { fetchImpl: overrides.kbEmbeddingFetch ?? globalThis.fetch }),
    rerank: overrides.kbRerank ?? new MemoryRerank({
      apiKey: config.dashscopeApiKey, model: config.memoryRerankModel, apiBase: config.memoryRerankApiBase,
      timeoutMs: config.memoryRerankTimeoutMs, instruct: KB_RERANK_INSTRUCT,
    }, { fetchImpl: overrides.memoryRerankFetch ?? globalThis.fetch }),
    dimension: config.kbEmbeddingDimension,
    smallLibraryTokens: config.kbSmallLibraryTokens,
    reconcileMs: config.kbIndexReconcileMs,
    canRun: () => !maintenanceService || maintenanceService.claimingAllowed(),
    report: (code) => process.stderr.write(`knowledge-base index: ${code}\n`),
  }) : null;
  // The personal library: an account's documents across projects, read-only
  // in every run, searched beside the project's own (plan §3.2 #4–5).
  const library = createLibrary({ config, store, documents: productDocuments, sources: sourceService, capsules: capsuleService,
    kbIndex, report: (code) => process.stderr.write(`personal library: ${code}\n`) });
  libraryService = library.service;
  const autopilotService = productDocuments && productJobs ? new AutopilotService({
    documents: productDocuments, jobs: productJobs, usage: usageLedger, notifications: notificationService,
    capsules: capsuleService,
  }) : null;
  const autopilotRoutes = createAutopilotRoutes({ store, service: autopilotService, maxJsonBytes: config.maxJsonBytes });
  // 「前沿动态」 (frontierService.mjs): composed only when switched on and a
  // product database exists; otherwise its routes answer 404
  // `frontier_not_enabled` and nothing of it runs. Its model calls are billed
  // to the first operator's internal project, which the worker makes before
  // its first batch and hands to the editor then.
  /** @type {{ client: KnowledgePluginClient, ingest: FrontierIngest, editor: any, pipeline: any, service: FrontierService, worker: FrontierWorker,
   *   composer: FrontierComposer, actions: FrontierActions, profiles: FrontierProfiles } | null} */
  let frontier = null;
  if (config.frontierEnabled && productDatabase) {
    const client = new KnowledgePluginClient({
      baseUrl: config.knowledgePluginUrl, tokenFile: config.knowledgePluginTokenFile, timeoutMs: config.knowledgePluginTimeoutMs,
      minContract: config.knowledgePluginMinContract, fetchImpl: overrides.knowledgePluginFetch ?? globalThis.fetch,
    });
    const vocabulary = frontierDomainVocabulary();
    // The knowledge base's embedder, model and width: one key and one price
    // cover both, and the vectors are comparable with the pin's.
    const embedder = overrides.frontierEmbedder ?? new KbEmbedder({
      apiKey: config.dashscopeApiKey, model: config.kbEmbeddingModel, dimension: config.kbEmbeddingDimension,
      apiBase: config.kbEmbeddingApiBase, timeoutMs: config.kbEmbeddingTimeoutMs,
    }, { fetchImpl: overrides.kbEmbeddingFetch ?? globalThis.fetch });
    const ingest = new FrontierIngest({ database: productDatabase, plugin: client, vocabulary,
      dimension: config.kbEmbeddingDimension, pollMs: config.knowledgePluginPollMs });
    const editor = new FrontierEditor(config, { usageLedger, fetchImpl: overrides.frontierModelFetch ?? globalThis.fetch });
    const pipeline = new FrontierPipeline({ database: productDatabase, editor, plugin: client, embedder, config,
      workerId: randomId("frontier-") });
    // One implementation of "today's spend": the pipeline's, which it gates on.
    const budget = typeof pipeline.budget === "function" ? () => pipeline.budget(new Date()) : null;
    // The second wave (build spec D): events and the hot list, the daily and
    // its push, 与你相关, and the two reader actions — every model call the
    // editor's, under the pipeline's budget; the worker's compose hook ticks them.
    const events = new FrontierEvents({ database: productDatabase, editor, embedder, config, budget });
    const daily = new FrontierDaily({ database: productDatabase, jobs: productJobs, notifications: notificationService, editor, events, config,
      owner: () => editor.owner, budget, workerId: randomId("frontier-daily-") });
    const profiles = new FrontierProfiles({ database: productDatabase, researchMemory, editor, embedder, config, budget,
      // 与我相关 reads a reader's own recent questions: their runs across
      // their projects, the platform's internal ones left out. Asked in the
      // background, a few readers a round, never on a request.
      conversations: async (userId) => {
        const user = await store.userById(userId);
        if (!user || !agentRuns) return [];
        const runs = [];
        for (const listed of await store.listProjects(user)) {
          if (isInternalProject(listed.id)) continue;
          const project = await store.requireProject(user, listed.id);
          for (const run of await agentRuns.researcherRuns(project)) runs.push({ projectId: project.id, run });
        }
        return runs;
      } });
    const actions = new FrontierActions({ database: productDatabase, editor, config, budget,
      // 存入知识库 writes the way an upload writes (`writeProjectUpload`).
      library: sourceService ? {
        project: (user, projectId) => store.requireProject(user, projectId),
        save: ({ user, project, rel, buffer }) => writeProjectUpload({ config, user, project }, { root: "base", rel, buffer }),
      } : null,
      ...(overrides.frontierPdfTransport ? { pdfTransport: overrides.frontierPdfTransport } : {}) });
    const service = new FrontierService({ database: productDatabase, config, vocabulary, ingest, embedder,
      dimension: config.kbEmbeddingDimension, budget, events, daily, profiles, actions });
    const composer = new FrontierComposer({ events, daily, profiles,
      canRun: () => !maintenanceService || maintenanceService.claimingAllowed(),
      report: (loop, code) => process.stderr.write(`frontier ${loop}: ${code}\n`) });
    const worker = new FrontierWorker({
      ingest, pipeline, composer, database: productDatabase,
      ensureOwner: async () => {
        const owner = await ensureFrontierProject({ store, config });
        editor.owner = owner;
        return owner;
      },
      pollMs: config.frontierPollMs, leaseMs: config.frontierLeaseMs, pluginPollMs: config.knowledgePluginPollMs,
      concurrency: config.frontierProcessConcurrency,
      canRun: () => !maintenanceService || maintenanceService.claimingAllowed(),
      report: (loop, code) => process.stderr.write(`frontier ${loop}: ${code}\n`),
    });
    frontier = { client, ingest, editor, pipeline, service, worker, composer, actions, profiles };
  }
  const frontierRoutes = createFrontierRoutes({ store, service: frontier?.service ?? null, config, maxJsonBytes: config.maxJsonBytes,
    audit: (event, status, details) => securityAudit(config, event, status, details) });
  /**
   * A researcher's new project, as `POST /api/projects` makes it and as a new
   * GEO project makes its own: a name in any language and an id the
   * researcher never has to see (C4) — the id is a path segment under
   * projects/, so it stays ASCII and is derived; a caller that still sends one
   * keeps it. Counted against the account's project limit before the create.
   * @param {any} user @param {{ id?: unknown, name?: unknown }} body
   */
  async function createResearcherProject(user, body) {
    const existing = (await store.listProjects(user)).filter((project) => !isInternalProject(project.id));
    if (body.id == null && body.name == null) throw new HttpError(400, "invalid_payload", "A project needs a name.");
    const id = body.id == null
      ? projectIdFromName(String(body.name), new Set(existing.map((project) => project.id)))
      : safeId(assertString(body.id, "id", { max: 64 }), "project id");
    // The learning loop's project is made by the loop; the paired
    // evaluation still makes its own through this route.
    // Not `isInternalProject`: the paired evaluation makes its `eval-method-*`
    // projects through this very route.
    if (id === LEARNING_PROJECT_ID || id === SOURCES_PROJECT_ID) {
      throw new HttpError(409, "project_id_reserved", "This project id is reserved for the platform's own work.");
    }
    const name = projectDisplayName(body.name ?? id);
    // Counted before the create, and only for a project that is new: a
    // per-project storage quota and a per-user runtime limit bound nothing
    // on their own, because an account at the limit can make another
    // project and have another of each. Archived projects count: they
    // still hold their storage.
    if (
      config.maxProjectsPerUser > 0 &&
      existing.length >= config.maxProjectsPerUser &&
      !existing.some((project) => project.id === id)
    ) {
      throw new HttpError(
        409,
        "project_limit_reached",
        `This account already holds ${existing.length} projects, which is its limit: each has its own storage and research runtime. Export and delete one to make another.`,
      );
    }
    const data = await store.createProject(user, id, name);
    const project = await store.requireProject(user, id);
    await audit({ config, user, project }, "project.create", "completed", { target: id });
    return data;
  }
  // 「循证 GEO」 (geoService.mjs): composed only when switched on and a
  // product database exists; otherwise its routes answer 404 `geo_not_enabled`,
  // its tools are not offered and nothing of it runs. The other packages attach
  // here: `geo.worker` (the leased loops, started and stopped with the rest),
  // `geo.orchestrator` (「让 AI 做」), `geo.market` (budget, orders, top-ups)
  // and `geo.exporter` (导出). Each is null until its package composes it, and
  // each route or loop that needs one reads it at the moment it is needed.
  /** @type {{ store: GeoStore, service: GeoService, social: ReturnType<typeof createSocialCrawlClient>, worker: any, orchestrator: any,
   *   market: any, exporter: any, renameProject: (userId: string, projectId: string, name: string) => Promise<unknown>,
   *   articleGate: (project: any, ref: { runId: string | null, deliverableId: string | null, path: string }) => Promise<string>,
   *   articleRunId: (project: any, deliverableId: string) => Promise<string | null>,
   *   importDelivery: ReturnType<typeof createGeoDeliveryImport> } | null} */
  let geo = null;
  if (config.geoEnabled && productDatabase) {
    const geoStore = new GeoStore({ database: productDatabase });
    const social = createSocialCrawlClient({ baseUrl: config.geoSocialUrl, timeoutMs: config.geoSocialTimeoutMs,
      fetchImpl: overrides.geoSocialFetch ?? globalThis.fetch });
    geo = {
      store: geoStore,
      service: new GeoService({ store: geoStore, config, social, metricName: (id) => geoMetricDefinition(id)?.name ?? null }),
      social,
      worker: null,
      orchestrator: null,
      market: null,
      exporter: null,
      importDelivery: createGeoDeliveryImport({ store: geoStore, report: (code) => process.stderr.write(`geo import: ${code}\n`),
        articleGate: (project, ref) => geo?.articleGate(project, ref) ?? Promise.resolve("unverified"),
        articleRunId: (project, deliverableId) => geo?.articleRunId(project, deliverableId) ?? Promise.resolve(null) }),
      // A project made before its brand was known is named by the brand once
      // the run writes it; a name the researcher chose is left alone.
      renameProject: async (userId, projectId, name) => {
        const owner = await store.userById(userId);
        if (!owner) return;
        const current = (await store.listProjects(owner)).find((project) => project.id === projectId);
        if (current?.name === GEO_DEFAULT_PROJECT_NAME) await store.renameProject(owner, projectId, [...name].slice(0, 40).join(""));
      },
      // An article's gate is the run ledger's verdict on the deliverable it
      // was written in — the newest run of the project holding that
      // deliverable (or the run named) — never the run's own claim.
      articleGate: async (project, { runId, deliverableId, path: articlePath }) => {
        const id = deliverableId ?? deliverableIdOfPath(articlePath);
        const run = id ? await geoDeliverableRun(project, id, runId) : null;
        return run ? geoArticleGateOf(run, id) : "unverified";
      },
      articleRunId: async (project, deliverableId) => (await geoDeliverableRun(project, deliverableId, null))?.id ?? null,
    };
  }
  /**
   * The newest run of a GEO project's control-plane project that holds the
   * deliverable (or the run named, when it does).
   * @param {any} project @param {string} deliverableId @param {string | null} runId
   */
  async function geoDeliverableRun(project, deliverableId, runId) {
    const owner = agentRuns ? await store.userById(project.userId) : null;
    if (!owner) return null;
    const runs = (await agentRuns.list(await store.requireProject(owner, project.projectId)))
      .filter((run) => (!runId || run.id === runId) && (run.deliverables ?? []).some((/** @type {any} */ item) => item?.id === deliverableId))
      .sort((left, right) => String(right.startedAt ?? "").localeCompare(String(left.startedAt ?? "")));
    return runs[0] ?? null;
  }
  const geoRoutes = createGeoRoutes({
    store, service: geo?.service ?? null, config, maxJsonBytes: config.maxJsonBytes,
    audit: (event, status, details) => securityAudit(config, event, status, details),
    projects: {
      create: (user, name) => createResearcherProject(user, { name }),
      // The new project's first conversation, bound to `geo-insight` before it
      // exists: the binding is what makes the router honour the choice. A
      // registry without the capability (a build before it shipped) leaves the
      // conversation unbound and says so (`bound: false`).
      bindSession: async (user, projectId) => {
        const sessionId = randomId("geo-");
        const agent = (await agentRegistry)?.get?.("geo-insight") ?? null;
        if (!agent) return { sessionId, bound: false };
        const project = await store.requireProject(user, projectId);
        await researchSessions.put(project, sessionId, { mode: "specialist", agentId: agent.id, agentVersion: agent.version });
        return { sessionId, bound: true };
      },
      latestSessionId: async (user, projectId) => {
        const project = await store.requireProject(user, projectId);
        return (await researchSessions.list(project))[0]?.sessionId ?? null;
      },
    },
    get orchestrator() { return geo?.orchestrator ?? null; },
    get market() { return geo?.market ?? null; },
    get exporter() { return geo?.exporter ?? null; },
  });
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
  const memoryIntelligence = new MemoryIntelligence(config, researchMemory, {
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
    // Extraction is a model call on the user's behalf and is billed as one.
    usageLedger,
    // What the researcher removed or undid, so an inference cannot write it
    // straight back (memoryIntelligence.mjs #rejectedKeys).
    feedbackEvents,
  });
  // Registered after `memoryIntelligence` because the episodes endpoint feeds
  // it: an external agent posts turns and the same extractor decides what is
  // worth remembering, through the same quote-integrity checks a run of ours
  // goes through. There is no route that writes a record directly.
  const agentMemoryRoutes = createAgentMemoryRoutes({
    config, apiKeys: agentApiKeys, store, researchMemory, capsules: capsuleService, memoryIntelligence, memorySubstrate,
  });
  const specialistClassifier = new SpecialistClassifier(config, {
    fetchImpl: overrides.specialistClassifierFetch ?? globalThis.fetch,
    usageLedger,
  });
  // Which run an interactive runtime's model request belongs to (E §9.4).
  //
  // By conversation, when the request says which one it is: the kernel stamps
  // its session id on every model call, and the run ledger knows which run each
  // conversation — and each of its subagents — belongs to. Without it, the old
  // rule: the run in this project, when exactly one is running. That rule is
  // why two conversations in the default project both read 「约 ¥0.00」 on
  // 2026-09-20; the catch-all project makes concurrency the normal case.
  //
  // The running list is remembered for a few seconds because the gateway asks
  // on every model call, and forgotten the moment any run of the project
  // changes state. The session is resolved per request against that list, so a
  // conversation never inherits another's cached answer.
  /** @type {Map<string, { at: number, running: { id: string, sessionId: string }[] }>} */
  const runAttribution = new Map();
  const attributeRun = async ({ userId, projectId, sessionId = null }) => {
    const key = `${userId}\0${projectId}`;
    const known = runAttribution.get(key);
    let running = known && Date.now() - known.at < 3_000 ? known.running : null;
    if (!running) {
      const user = await store.userById(userId);
      if (!user) return null;
      running = await agentRuns.activeRuns(await store.requireProject(user, projectId));
      runAttribution.set(key, { at: Date.now(), running });
      if (runAttribution.size > 5_000) runAttribution.delete(runAttribution.keys().next().value);
    }
    // Scoped to this project's own running runs, because the session id is a
    // hint from inside the container.
    return agentRuns.runIdForSession(sessionId, running) ?? (running.length === 1 ? running[0].id : null);
  };
  // Run outcomes for /api/ops/metrics (plan §3.8): counted in memory as each
  // run ends, never read back from a project's run ledger, which can be wiped.
  const runMetrics = new RunMetrics();
  const observeRunMetrics = async (project, run) => {
    try {
      const registry = await agentRegistry;
      // Settled spend at the moment the run ended, under both of its ids: a
      // bounded runtime's calls carry its dispatch id, everything else the run's.
      const spent = usageLedger
        ? await usageLedger.summaryRuns(project.userId, [run.id, run.dispatchId].filter(Boolean))
        : null;
      const read = await readRunStateProjection(project, project.workspaceDir, run);
      const evidence = read.state === "read" ? read.projection?.evidence?.byStatus ?? {} : {};
      runMetrics.observe({
        capability: runCapabilityLabel(run.effectiveAgentId, (id) => Boolean(registry?.get?.(id))),
        status: run.status,
        errorCode: run.errorCode ?? null,
        durationMs: run.durationMs ?? null,
        costCny: spent ? [...spent.values()].reduce((sum, row) => sum + row.costCny, 0) : null,
        claims: run.claimSummary ?? null,
        // `ready` and `verified` are the evidence records with a preserved,
        // readable artifact; a `queued` or `stale` one is a lead never read.
        sources: { resolved: Number(evidence.ready ?? 0) + Number(evidence.verified ?? 0) },
      });
    } catch {
      // Counted, not thrown: a metric must never hold up a run that has ended.
      runMetrics.failed();
    }
  };
  // What a runtime's model request is for in the usage ledger (X1): the
  // kernel's, unless its run is source understanding. A bounded runtime's
  // token names its dispatch id, an interactive one's attribution the run id,
  // so either matches. A run's capability never changes, so the answer is kept
  // for the process's life; a run not found yet is asked about again.
  /** @type {Map<string, string>} */
  const runPurposes = new Map();
  const runPurpose = async ({ userId, projectId, runId }) => {
    if (!runId) return "kernel";
    const key = `${userId}\u0000${projectId}\u0000${runId}`;
    const known = runPurposes.get(key);
    if (known) return known;
    const user = await store.userById(userId);
    if (!user) return "kernel";
    const run = (await agentRuns.list(await store.requireProject(user, projectId)))
      .find((item) => item.id === runId || item.dispatchId === runId);
    if (!run) return "kernel";
    const purpose = usagePurposeOfRun(run);
    runPurposes.set(key, purpose);
    if (runPurposes.size > 5_000) runPurposes.delete(runPurposes.keys().next().value);
    return purpose;
  };
  // What a run is called (C3): one metered flash call per new run, off the
  // critical path, never over a title the researcher gave it.
  const runTitles = new RunTitleScheduler({
    titler: new RunTitler(config, { usageLedger, fetchImpl: overrides.runTitleFetch ?? globalThis.fetch }),
    recordTitle: (project, runId, title) => agentRuns.recordRunLabels(project, runId, { title, titleSource: "auto" }),
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
    adoptSession: async (project, sessionId, summary = null) => {
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
      // A fork names its source as its parent and is no subagent: the
      // kernel's own parentage, which is what makes this a branch (decision 6).
      const parent = String(summary?.parentSessionId ?? summary?.parentSession ?? summary?.header?.parentSession ?? "");
      const origin = String(summary?.origin ?? summary?.header?.origin ?? "");
      return agentRuns.adoptRuntimeSession(full, sessionId, {
        transcript,
        routeTurn: (text) => routeAdoptedInput(full, sessionId, text),
        ...(parent && origin !== "subagent" ? { forkedFrom: parent } : {}),
      });
    },
    // The pump has already authenticated the runtime and attributed root and
    // child sessions to one project-scoped run. Feed that kernel-owned
    // sequence directly to the stall monitor; the model's workspace
    // projection remains useful UI detail, but is not the heartbeat.
    onRunActivity: (project, runId, activity) => agentRuns?.noteKernelActivity(project, runId, activity),
    // The same events, into the run's progress aggregate (`run/progress`): a
    // delegated child's tool calls reach the count within a second instead of
    // at the monitor's next read of the child's own history.
    onRunEvent: (project, runId, observed) => agentRuns?.noteRunEvent(project, runId, observed),
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
  // Transcripts read by `onRuntimeStopping` and drained by `onRunFinished`.
  // Declared beside the store they belong to rather than inside either hook:
  // the two halves are a handoff, and a Map owned by one of them would read as
  // that one's private state.
  const preStopTranscripts = new PreStopTranscripts();
  const runtimeManager = new RuntimeManager(config, {
    agentRegistry,
    // Read the conversations while the container is still answering.
    //
    // `onRuntimeStop` below is what finishes these runs, and it runs after the
    // container is gone — so the capture inside `onRunFinished` found nothing
    // and every stopped run recorded `unavailable`. This is the same read, one
    // step earlier, held until that finish takes it.
    //
    // Bounded here rather than in the manager: the manager guarantees only that
    // the hook is awaited before the container goes, and a stop that waited on
    // a pathological history would hold a container open for minutes. On
    // timeout the capture is abandoned and the run records `history_unavailable`
    // exactly as it did before — the failure mode is the old behaviour, never a
    // stuck stop.
    onRuntimeStopping: async (project) => {
      if (!agentRuns) return;
      let running = [];
      try {
        running = (await agentRuns.list(project)).filter((run) => run.status === "running");
      } catch {
        return;
      }
      if (!running.length) return;
      let timer;
      const deadline = new Promise((resolve) => {
        timer = setTimeout(() => resolve("timeout"), config.runtimePreStopTranscriptTimeoutMs);
        timer.unref?.();
      });
      const capture = (async () => {
        for (const run of running) {
          // Final by construction: the container this was read from is being
          // killed, so the run cannot produce another message.
          const children = await agentRuns.childSessionsOf(project, run).catch(() => []);
          preStopTranscripts.put(run.id, await collectRunTranscripts(runtimeManager, project, run, { children }));
        }
        return "captured";
      })();
      try {
        const outcome = await Promise.race([capture, deadline]);
        if (outcome === "timeout") {
          await securityAudit(config, "run.transcript.prestop", "failed", {
            userId: project.userId, projectId: project.id,
            code: `timeout:${running.length}`,
          });
        }
      } catch (error) {
        await securityAudit(config, "run.transcript.prestop", "failed", {
          userId: project.userId, projectId: project.id,
          code: typeof error?.code === "string" ? error.code : "transcript_unreadable",
        });
      } finally {
        clearTimeout(timer);
      }
    },
    onRuntimeStop: (project, status) => {
      runtimeEventPump.detach(project);
      // Returned, not fired-and-forgotten here: `notifyRuntimeStop` already
      // wraps this call in its own `.catch()`, and returning the promise is
      // what keeps a rejection — a project whose ledger cannot be read,
      // oversized or corrupted — flowing through that existing handling
      // instead of becoming a second, unguarded unhandled rejection.
      return agentRuns?.closeProject(project, status);
    },
    // The researcher's own stop, relayed through the runtime proxy.
    onSessionAbort: (project, sessionId) => agentRuns?.cancelSession(project, sessionId, { by: "user" }),
    // A runtime whose project still has a run in the ledger never yields its
    // slot to another project: the stop would close that run as cancelled.
    hasRunningRuns: async (project) => Boolean(agentRuns) && (await agentRuns.list(project)).some((run) => run.status === "running"),
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
  // The independent reviewer (reviewService.mjs): composed when switched on and
  // a product database exists; otherwise the gateway answers `review_disabled`,
  // the routes `review_not_enabled`, and runtimes are not told to ask. Later
  // collaborators (run attribution, the web reader, the IM module) are reached
  // through closures because they are built further down this function.
  /** @type {{ service: ReviewService, worker: ReviewWorker } | null} */
  let review = null;
  if (config.reviewEnabled && productDatabase) {
    const service = new ReviewService({
      config, database: productDatabase, usageLedger, runtimeManager, store, agentRegistry,
      attributeRun: (input) => attributeRun(input),
      notifications: notificationService,
      imService: { sendRunCorrection: (userId, projectId, runId, text) => im?.service?.sendRunCorrection?.(userId, projectId, runId, text) },
      webReader: { read: (url, options) => webReader.read(url, options) },
      fetchImpl: overrides.reviewFetch ?? globalThis.fetch,
      ...(overrides.reviewReferenceResolver ? { referenceResolver: overrides.reviewReferenceResolver } : {}),
      report: (code) => process.stderr.write(`review: ${code}\n`),
    });
    const worker = new ReviewWorker({
      service, pollMs: config.reviewPollMs,
      canRun: () => !maintenanceService || maintenanceService.claimingAllowed(),
      report: (code) => process.stderr.write(`review worker: ${code}\n`),
    });
    review = { service, worker };
  }
  const reviewRoutes = createReviewRoutes({ store, service: review?.service ?? null, config });
  agentRuns = new AgentRunStore(researchSessions, {
    agentRegistry,
    maxClinicalRepairAttempts: config.gateRepairRounds,
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
    readChildSessionActivity: (project, parentSessionId, childSessionIds, options) =>
      runtimeManager.childSessionActivity(project, parentSessionId, childSessionIds, options),
    // What the run has spent so far, for its progress aggregate (C5).
    readRunUsage: async (project, run) => (usageLedger
      ? runUsageFrom(await usageLedger.summaryRuns(project.userId, [run.id, run.dispatchId].filter(Boolean)), run)
      : null),
    // rt: asked right before the delivery gate reads a run's files, so a
    // remote runtime's host copy is brought up to date first (plan §3.1 #4).
    runtimeWorkspaceRoot: (project) => runtimeManager.workspaceRootForDelivery(project),
    // The independent reviewer's findings, first in a finished run's notices.
    ...(review ? { reviewNotices: (project, runId) => review.service.reviewNoticesForRun(project.userId, project.id, runId) } : {}),
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
        // A rename, automatic or by hand, reaches every open surface on the
        // same frame as the state it belongs to.
        title: run.title ?? null,
        titleSource: run.titleSource ?? null,
      });
      // The event pump's own session map, kept current on the same signal:
      // a fresh run's session becomes routable the moment the ledger knows
      // it, and a finished run's stops being routed at all.
      runtimeEventPump.noteRun(project, run);
      runTitles.consider(project, run);
      // A run started or ended: which one a model request belongs to may
      // have changed.
      runAttribution.delete(`${project.userId}\0${project.id}`);
      // A researcher's new question, or a conversation deleted, is what
      // 与我相关 is read from: their profile is due at the next round.
      if (frontier && !isInternalProject(project.id) && isResearcherRun(run)) frontier.profiles.noteConversation(project.userId, run);
      // A finished run in a GEO project: the claim library its geo-insight
      // deliverable holds is registered from the file (geoDeliveryImport.mjs).
      if (geo && !isInternalProject(project.id)) {
        geo.importDelivery(project, run).catch((error) => process.stderr.write(`geo import: ${error?.code ?? error?.name ?? "failed"}\n`));
      }
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
      await observeRunMetrics(project, run);
      if (sourceUnderstandingRuntime) {
        await sourceUnderstandingRuntime.complete(project, run).catch(async error => {
          await securityAudit(config, "source.runtime.release", "failed", {
            userId: project.userId, projectId: project.id, runId: run.id,
            code: typeof error?.code === "string" ? error.code : "runtime_stop_failed",
          });
        });
      }
      // A finished learning step lets go of the runtime it held. `complete`
      // existed and nothing called it, so a distillation's bounded scope
      // outlived its run and the project answered 423 until someone stopped
      // the container by hand (2026-09-21, the first live distillations).
      if (learningRuntime) {
        await learningRuntime.complete(project, run).catch(async (error) => {
          await securityAudit(config, "learning.runtime.release", "failed", {
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
      const autopilotOwned = await completeOwnedAutopilotRun({
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
      // A GEO run (dispatch id `geo-…`): its bounded runtime is let go, then
      // the orchestrator folds it into the program's steps.
      if (geo?.orchestrator && String(run.dispatchId ?? "").startsWith("geo-")) {
        if (runtimeManager.boundedRuntimeScope(project)?.runId === run.dispatchId) {
          await runtimeManager.endBoundedRuntime(project, run.dispatchId).catch(error => securityAudit(config, "geo.runtime.release", "failed", {
            userId: project.userId, projectId: project.id, runId: run.id,
            code: typeof error?.code === "string" ? error.code : "runtime_stop_failed",
          }));
        }
        await geo.orchestrator.onRunFinished(project, run).catch((/** @type {any} */ error) => securityAudit(config, "geo.run.complete", "failed", {
          userId: project.userId, projectId: project.id, runId: run.id,
          code: typeof error?.code === "string" ? error.code : "geo_run_completion_failed",
        }));
      }
      // Background work is not a person's research: a lesson, a source being
      // read and an evaluation cell run in the account's internal projects,
      // and each reports where it belongs (the knowledge base's own row). On
      // 2026-09-21 their runs were 20 of the acceptance account's 24 unread
      // items — 「9月21日完成 8 项研究：从已完成运行中提炼可复用方法」,
      // 「研究运行已被平台终止」 for a lesson nobody asked for. Automated work
      // leaves no item either, not even a quiet one (plan 2026-09-23 §5.8):
      // an evaluation harness says so at dispatch (`automated`), and an
      // autopilot episode or its verification is known here — the episode's
      // digest is its result, and that is an ordinary notice.
      if (notificationService && runFinishedReachesInbox(run, {
        internalProject: isInternalProject(project.id), evaluation: evaluationRun,
        automated: automatedRun(run), autopilotOwned: autopilotOwned === true,
      })) {
        try {
          // Say what happened, in the notice itself. The mapping lives in
          // `notificationService.runFinishedInboxItem` so it is a tested pure
          // function rather than inline copy in a completion callback.
          const peers = (await agentRuns.list(project).catch(() => []))
            .filter((other) => other.id !== run.id && !automatedRun(other));
          await notificationService.create(project.userId, runFinishedInboxItem(project, run, { peers }));
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
      // afterwards. It sits above the memory branch deliberately — that branch
      // returns early on a deployment with no memory store, and a deployment
      // without one is still a deployment whose runs should be learnable.
      //
      // Best effort, and it audits its own failure: a throw in this callback is
      // caught by `finishInternal` and then caught again, so a step that does
      // not report for itself fails invisibly.
      await trackLearningWrite((async () => {
        try {
          // A stop already read this one while its container was alive. That
          // snapshot is the whole conversation; a live read here would answer
          // `runtime_not_running` and record a gap that does not exist.
          // The children come from the run's own projection, not from the
          // parent's event log — see `collectRunTranscripts`. Read before the
          // capture so both the live path and the pre-stop path get them.
          const children = await agentRuns.childSessionsOf(project, run).catch(() => []);
          const sessions = preStopTranscripts.take(run.id)
            ?? await collectRunTranscripts(runtimeManager, project, run, { children });
          const receipt = await persistRunTranscript({ project, run, sessions });
          await agentRuns.recordLearning(project, run.id, { transcript: receipt });
          // The web pages the run read (contract X5), off the same transcript:
          // each `web_read` result carries the gateway's receipt. A write of
          // its own, so a ledger at its ceiling costs this list and never the
          // transcript receipt above.
          const reading = pagesReadFromSessions(sessions);
          if (reading.pages.length) {
            await agentRuns.recordLearning(project, run.id, { pagesRead: reading.pages, pagesReadTotal: reading.total }).catch((error) => securityAudit(config, "run.pages_read.record", "failed", {
              userId: project.userId, projectId: project.id, runId: run.id,
              code: typeof error?.code === "string" ? error.code : "pages_read_unrecorded",
            }));
          }
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
      // The project says so as well as the runtime: `evaluationRun` is read
      // from memory the web process loses on every release, and a cell that
      // finishes after one would otherwise be read as the researcher's own run.
      if (evaluationRun || isInternalProject(project.id)) return;
      // Nor does the platform's own background work: a distillation, a
      // relations pass or a source being understood reads excerpts of the
      // researcher's runs, and extracting memory from it paid a model call to
      // re-read what was already extracted (the first live distillation,
      // 2026-09-21: 206 messages read, an empty-extraction notice on the run).
      const agentId = String(run.effectiveAgentId ?? run.agentId ?? "");
      if (agentId && (await agentRegistry)?.get?.(agentId)?.visibility === "internal") return;
      // The reply check (L1, reviewService.mjs): a finished answer that cites or
      // names a medicine is checked after it was shown — never held, never
      // rewritten — off the transcript persisted above. Queued, not awaited: a
      // check that fails is a row that says so, never a reason this hook stops.
      if (review && run.status === "succeeded") {
        void (async () => {
          const stored = await readRunTranscript(project, run.id);
          const reply = stored ? replyOfRun(stored.messages.filter((/** @type {any} */ message) => message.sessionId === run.sessionId), run) : null;
          if (reply) await review.service.considerReply({ userId: project.userId, projectId: project.id }, run, reply);
        })().catch((error) => process.stderr.write(`review reply check not queued: ${typeof error?.code === "string" ? error.code : error?.name ?? "error"}\n`));
      }
      // Queue the lessons this run is evidence for — a finished delivery, a
      // correction, a repeated routine (learningTriggers.mjs). After the
      // memory write when there is one, because the extractor is what says the
      // researcher corrected the assistant.
      const queueLessons = (memoryResult) => (learningWorker && learningTriggers
        ? learningTriggers.afterRun(project, run, memoryResult).catch(() => null)
        : null);
      // A deployment with no control-plane database has no research memory, so
      // there is nothing to record the run into. It is still a deployment whose
      // runs are learnable, which is why the transcript above is written first.
      if (!researchMemory.configured) {
        await queueLessons(null);
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
      // A skipped write is not "extracted nothing": the deployment asked for no
      // memory writes here and got none, which is a setting rather than an
      // outcome worth a notice on every single run — and the notice marks the
      // run unchecked. `MEMORY_WRITE_SKIPPED_SOURCES` names both skip sources;
      // testing for one of them is how every run of an excluded evaluation
      // project came to be stamped with it.
      if (memoryResult.extracted === 0 && !MEMORY_WRITE_SKIPPED_SOURCES.has(memoryResult.source)) {
        const sentence = `记忆抽取未产出记录：消息 ${messages.length} 条、候选 ${memoryResult.proposed} 条、`
          + `采纳 ${memoryResult.extracted} 条、驳回 ${memoryResult.rejected} 条`
          // A third cause of the same zero: the transcript was mostly our own
          // injected context, which the extractor refuses to read back as if
          // the user had said it.
          + `${memoryResult.excluded?.length ? `、未读取 ${memoryResult.excluded.map((item) => `${item.count} 条（${item.reason === "injected" ? "系统注入" : "回合未完成"}）`).join("")}` : ""}`
          + `${memoryResult.extractionError ? `（抽取报错：${memoryResult.extractionError}）` : ""}`
          + "。空对话与抽取失效在结果上一样，这行区分它们。";
        await agentRuns.appendQualityNotices(project, run.id, [
          runNotice("memory_extraction_empty", sentence, { detail: sentence }),
        // A notice, not a verification downgrade. `unchecked` means a layer of
        // the delivery gate did not run, and the researcher's inbox renders it
        // as 「有质量检查没有运行，无法确认是否达标」. Memory extraction is not a
        // gate layer, and extracting nothing is — in this block's own words — a
        // legitimate outcome, so every clean, fully-gated run whose conversation
        // held no durable fact was being told its checks had not run. It also
        // zeroed evidenceCompleteness in paired evaluations that score "accepted
        // and not unchecked".
        ]).catch(() => {});
      }
      // The one kind of record held for its owner (checkpointReason in
      // memoryIntelligence.mjs): a lasting memory naming a clinical-safety
      // medicine. Everything else takes effect at once, labelled. Said on the
      // run because a held record is not recalled, and silence would read as
      // memory not learning. No `unchecked` flag: holding a memory says nothing
      // about whether the run's own deliverables were checked.
      if (memoryResult.pending > 0) {
        const sentence = `有 ${memoryResult.pending} 条长期记忆等你看过再用：`
          + memoryResult.pendingReasons.map((item) => `${item.count} 条${item.text}`).join("；")
          + "。记录与证据都已保存，可在记忆胶囊中确认或删除。";
        await agentRuns.appendQualityNotices(project, run.id, [
          runNotice("memory_pending", sentence, { detail: sentence }),
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
          `一条「${MEMORY_KIND_LABELS_ZH[item.kind] ?? "记忆"}」由「${item.previousValue.slice(0, 30)}」改为「${item.nextValue.slice(0, 30)}」`);
        const sentence = `本次对话改写了 ${memoryResult.conflicts.length} 条你确认过的记忆：${changed.join("；")}`
          + `${memoryResult.conflicts.length > changed.length ? "等" : ""}`
          + "。新值已生效，原值保留在该记忆的修订记录中，可在记忆管理中改回。";
        await agentRuns.appendQualityNotices(project, run.id, [
          runNotice("memory_conflicts", sentence, { detail: sentence }),
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
      await queueLessons(memoryResult);
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
    const methodDescriber = new MethodDescriber(config, { usageLedger });
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
      learning: learningService, jobs: productJobs,
      // A step waits for its run as long as the run monitor lets a run live.
      stepWaitMs: config.agentRunMonitorTimeoutMs,
      // The line a researcher reads for a method that came without one.
      describe: (document, owner) => methodDescriber.describe(document, owner),
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
            if (cell.judgeCalls >= EVALUATION_JUDGE_LIMITS.calls || typeof input?.system !== "string" || typeof input?.user !== "string") {
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
              body: JSON.stringify({ model: config.deepseekModel, stream: false, max_tokens: EVALUATION_JUDGE_LIMITS.maxTokens,
                messages: [{ role: "system", content: input.system }, { role: "user", content: input.user }] }),
              signal: AbortSignal.timeout(EVALUATION_JUDGE_LIMITS.timeoutMs),
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
    learningTriggers = new LearningTriggers({
      jobs: productJobs, agentRuns, memory: researchMemory,
      // A conversation trying someone else's capsule teaches the loop nothing.
      sessionState: researchMemory.configured
        ? (userId, projectId, sessionId) => researchMemory.sessionState(userId, projectId, sessionId) : null,
      // The loop's own bounded runs and source understanding are internal
      // capabilities: a lesson distilled from a distillation is the loop
      // grading its own homework.
      internalAgent: async (agentId) => (await agentRegistry)?.get?.(agentId)?.visibility === "internal",
      audit: (event, detail) => securityAudit(config, event, "failed", detail),
    });
    learningWorker = new LearningWorker({
      jobs: productJobs, distillation, consolidation,
      enabled: config.learningEnabled,
      window: config.learningWindow,
      windowTimeZone: config.learningWindowTimeZone,
      concurrency: Math.max(1, Math.min(8, Math.trunc(Number(config.learningConcurrency) || 1))),
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
    autopilotWorker = new AutopilotWorker({
      jobs: productJobs,
    service: autopilotService,
    pollMs: config.autopilotPollMs,
    leaseMs: config.autopilotLeaseMs,
    // A busy runtime is a researcher at work; the episode asks again once a
    // runtime idle that long would yield its slot. Not the idle timeout: that
    // is how long a runtime stays warm (twelve hours), not how long work lasts.
    busyDelayMs: Math.min(86_400_000, Math.max(5 * 60_000, Number(config.runtimeIdleYieldAfterMs) + 60_000)),
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
            query: prompt, memories: [], specialists: [],
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
            // The question first: the kernel names a session after the start
            // of its first message, and a marker first named it
            // 「<evimed-budget-scope>e…」 (2026-09-21 walk). The gateway finds
            // and strips the markers wherever they are.
            text: `${prompt}\n\n<evimed-autopilot-verification>${verification.verificationId}</evimed-autopilot-verification>\n${budgetMarker}`,
            system: prepared.system, memoryContext: prepared.memoryContext, agent: selected.runtimeAgent, strictContext: true,
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
        // One table in the domain, held against every capability's declared
        // task types by a test: GEO monitoring used to ride `signal-monitoring`
        // here and ran adverse-event analysis instead.
        const selected = registry.get(autopilotEpisodeCapability(episode.taskType) ?? "");
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
            ...(runEstimate(selected) ? { estimatedMinutes: runEstimate(selected) } : {}),
          }, async (binding, dispatchedRun, repairText = null) => {
            try {
              await autopilotService.markEpisodeDispatched(user.id, episode.episodeId, { runId: dispatchedRun.id, sessionId: session.id });
            } catch (error) {
              await autopilotService.queueDispatchedCancellation(user.id, episode.episodeId, { runId: dispatchedRun.id, sessionId: session.id });
              throw error;
            }
            const promptText = typeof repairText === "string" && repairText.trim() ? repairText : episode.prompt;
            let memories = [];
            try { memories = await memorySubstrate.recall(user.id, episode.prompt, { projectId: project.id, sessionId: session.id }); }
            catch (error) {
              // The same gate the chat path applies, and for the same reason: an
              // autopilot episode that answers from an empty memory is a worse
              // outcome than an episode that did not run.
              throw memoryRecallRejection(error);
            }
            const prepared = await prepareResearchContext(project, binding, config, {
              query: episode.prompt,
              memories,
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
              // The question first, markers last (see the verification above).
              text: `${promptText}\n\n<evimed-autopilot-episode>${episode.episodeId}</evimed-autopilot-episode>\n${budgetMarker}`,
              system: prepared.system, memoryContext: prepared.memoryContext, residentProfile: true, agent: selected.runtimeAgent, strictContext: true,
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
  // IM: Feishu, the channel port and the own-app reservations (imService.mjs).
  const im = createImModule({
    config, database: productDatabase, credentials: connectorCredentials, notifications: notificationService,
    users: store, agentRuns, runtimeManager, usageLedger, maxJsonBytes: config.maxJsonBytes,
    audit: (event, status, details) => securityAudit(config, event, status, details),
    dispatchRun: ({ user, project, sessionId, dispatchId, text }) => dispatchChannelRun(user, project, sessionId, dispatchId, text),
    steerRun: ({ project, runId, text }) => steerChannelRun(project, runId, text),
    loadSdk: overrides.loadFeishuSdk,
  });
  const capsuleGatewayHandler = createCapsuleGatewayHandler({ runtimeManager, store, service: capsuleService, memorySubstrate,
    // Whose conversation a runtime's recall is (capsuleGateway.mjs): the
    // project's running runs, each conversation's own state, and the run
    // ledger line that records what it was handed.
    sessions: researchMemory.configured ? {
      running: (_user, project) => agentRuns.activeRuns(project),
      state: (userId, projectId, sessionId) => researchMemory.sessionState(userId, projectId, sessionId),
      recordRecall: (project, runId, items) => agentRuns.recordLearning(project, runId, {
        appendRecalledMemories: items.map((item) => (item.source === "capsule"
          ? { id: `capsule:${item.id}`, kind: item.factKind ?? "capsule", scope: "capsule" }
          : { id: item.id, kind: item.kind ?? "note", scope: item.scope ?? "user" })),
      }),
    } : null });
  // 「最近变化」, derived when read from the records, the ledger and the methods.
  const memoryTimelineRoutes = createMemoryTimelineRoutes({ config, researchMemory, agentRuns, feedbackEvents, learning: learningService, context });
  const revisionGatewayHandler = createRevisionGatewayHandler({ runtimeManager, store, agentRuns });
  const modelGatewayHandler = createModelGatewayHandler(config, runtimeManager, {
    fetchImpl: overrides.modelGatewayFetch ?? globalThis.fetch,
    usageLedger,
    attributeRun,
    runPurpose,
  });
  // A specialist engine's spend, reported by its adapter when a job ends (X1
  // purpose `engine`): the runtime calls engines directly, so this is the one
  // place the control plane hears that a job finished.
  const engineUsageHandler = createEngineUsageHandler({ config, usageLedger, attributeRun });
  // The evaluation corpus needs both arms to see byte-identical upstream
  // answers, so the gateway's fetch is replaceable by a fixture reader. Neither
  // knob is set in production, and setting the replay one makes a miss a named
  // failure rather than a live request.
  // The Tokyo node (edgeProxy.mjs), for what this host is refused. Never in the
  // evaluation corpus's replay or record modes: there every upstream answer
  // comes from the fixture set, and a live detour would make an arm partly live.
  const gatewayReplaying = Boolean(String(process.env.OPEN_SCIENCE_GATEWAY_FIXTURES ?? "").trim() || String(process.env.OPEN_SCIENCE_GATEWAY_RECORD ?? "").trim());
  const edgeProxy = gatewayReplaying ? null : (overrides.edgeProxy ?? edgeProxyFromConfig(config));
  const directGatewayFetch = resolveGatewayFetch(process.env, overrides.publicSourceFetch ?? globalThis.fetch);
  // Only the hosts the node is configured for leave through it; the rest go
  // direct exactly as before.
  const gatewayFetch = edgeProxy ? fetchWithEdge(edgeProxy, directGatewayFetch) : directGatewayFetch;
  // Web reading (plan §3.5): the gateway's web-read mode, AgentBay's browser
  // behind it for pages drawn in script, the parser for PDFs.
  const webReader = createWebReader(config, {
    transport: overrides.webReadTransport ?? webReadTransportFor(process.env, gatewayFetch, {
      edge: edgeProxy,
      directTimeoutMs: config.webReadDirectTimeoutMs,
      edgeFallback: config.webReadEdgeFallback !== false,
    }),
    renderer: overrides.webRenderer ?? createWebRenderer(config),
    documentParser,
  });
  const publicSourceGatewayHandler = createPublicSourceGatewayHandler(config, runtimeManager, {
    fetchImpl: gatewayFetch,
    connectorCredentials,
    webReader,
    documentParser,
  });
  const connectorCredentialGatewayHandler = createConnectorCredentialGatewayHandler({ runtimeManager, store: connectorCredentials });
  const webSearchGatewayHandler = createWebSearchGatewayHandler(config, runtimeManager, {
    fetchImpl: overrides.webSearchFetch ?? globalThis.fetch,
    edge: edgeProxy,
  });
  const geoProbeGatewayHandler = createGeoProbeGatewayHandler(config, runtimeManager, {
    fetchImpl: overrides.geoProbeFetch ?? globalThis.fetch,
  });
  // rt: the same gateways at https://<domain>/runtime-gateway/… for a runtime
  // outside this host (plan §3.1 #5).
  const runtimeGatewayEntry = createRuntimeGatewayEntry({ config, runtimeManager });
  // Retraction and correction notices on cited sources (plan §3.9), for the
  // 「依据」 popover; off leaves the source cards without them.
  const sourceUpdates = config.sourceUpdatesEnabled === false ? null : createSourceUpdateLookup({
    userAgent: webReadUserAgent(config),
    timeoutMs: config.sourceUpdatesTimeoutMs,
    fetchImpl: overrides.sourceUpdatesFetch ?? globalThis.fetch,
  });
  const kbSearchGatewayHandler = createKbSearchGatewayHandler(config, runtimeManager, { index: kbIndex });
  // `frontier_search`: the page's own list, read for the runtime's account;
  // with the module off it answers `frontier_disabled` (frontierGateway.mjs).
  const frontierGatewayHandler = createFrontierGatewayHandler(config, runtimeManager, {
    service: frontier?.service ?? null,
    report: (code) => process.stderr.write(`frontier search: ${code}\n`),
  });
  // `geo_read` / `geo_write` / `social_posts_search`: the GEO project the
  // runtime's own project is; off, they answer `geo_disabled` (geoGateway.mjs).
  const geoGatewayHandler = createGeoGatewayHandler(config, runtimeManager, {
    geo, report: (code) => process.stderr.write(`geo gateway: ${code}\n`),
  });
  // 「循证 GEO」's moving parts, composed into the slots the routes read at
  // request time: the market's hooks (C), the orchestrator (F) that dispatches
  // runs inside the GEO project and enqueues the measurement's rounds (B), the
  // exporter, and one worker whose loops are B's, C's and F's ticks. Off, none
  // of it exists.
  if (geo && productDatabase) {
    const geoParts = geo;
    const geoTimeZone = String(config.geoTimeZone || "Asia/Shanghai");
    const geoAudit = (/** @type {string} */ event, /** @type {string} */ status, /** @type {Record<string, any>} */ details) => securityAudit(config, event, status, details);
    const notifier = createGeoNotifier({ notifications: notificationService, store: geoParts.store, config, audit: geoAudit });
    const marketClient = overrides.mediaMarketClient ?? createMediaMarketClient(config, overrides.mediaMarketFetch ? { fetchImpl: overrides.mediaMarketFetch } : {});
    const inclusion = inclusionEnabled(config, marketClient) ? new GeoInclusionClient({ market: marketClient, config }) : null;
    /** The reviewed file behind an article, read from its project's workspace (what the market sends). @param {any} article @param {any} geoProject */
    const articleBody = async (article, geoProject) => {
      const owner = await store.userById(geoProject.userId);
      if (!owner || !article?.path) throw new HttpError(404, "geo_article_not_found", "The article's file is not available.");
      const project = await store.requireProject(owner, geoProject.projectId);
      const file = resolveScopedPath(project.workspaceDir, article.path);
      return { markdown: String(await readFileNoFollow(project.workspaceDir, file, "utf8")) };
    };
    const marketDeps = {
      store: new GeoMarketStore(productDatabase), market: marketClient, webReader, articleBody, config, timeZone: geoTimeZone,
      notify: (/** @type {any} */ event) => notifier.textChanged(event),
      alertOperator: (/** @type {any} */ event) => notifier.alertOperator(event),
    };
    /** @type {GeoOrchestrator | null} */
    let orchestrator = null;
    const measureDeps = {
      store: new GeoMeasureStore(productDatabase), config, usageLedger, inclusion, state: geoMeasureState(),
      notify: (/** @type {any} */ event) => notifier.measurement(event),
      alertOperator: (/** @type {any} */ event) => notifier.alertOperator(event),
      // A measured round moves its project on now rather than at the next tick.
      onRoundMeasured: (/** @type {{ geoProjectId: string }} */ round) => { void orchestrator?.advance(round.geoProjectId).catch(() => {}); },
    };
    orchestrator = new GeoOrchestrator({
      store: geoParts.store, config, notifier,
      dispatchRun: overrides.geoDispatchRun ?? dispatchGeoRun,
      runStatus: async ({ userId, projectId, runId }) => {
        const owner = await store.userById(userId);
        if (!owner) return null;
        const run = (await agentRuns.list(await store.requireProject(owner, projectId))).find((entry) => entry.id === runId);
        return run ? { status: run.status } : null;
      },
      latestSessionId: async ({ userId, projectId }) => {
        const owner = await store.userById(userId);
        if (!owner) return null;
        return (await researchSessions.list(await store.requireProject(owner, projectId)))[0]?.sessionId ?? null;
      },
      enqueueRound: (spec) => enqueueGeoRound(measureDeps, spec),
      noteCitation: (input) => noteGeoCitation(marketDeps, input),
      report: (code) => process.stderr.write(`geo orchestrator: ${code}\n`),
    });
    const running = /** @type {GeoOrchestrator} */ (orchestrator);
    geoParts.orchestrator = running;
    geoParts.exporter = { export: (/** @type {any} */ user, /** @type {any} */ project, /** @type {string} */ kind) => running.requestExport(user, project, kind) };
    geoParts.market = {
      configured: () => marketClient.configured === true,
      balance: () => marketClient.balance(),
      status: () => geoMarketStatus(marketDeps),
      setBudget: (/** @type {any} */ user, /** @type {any} */ project, /** @type {{ totalCny: number, dailyCny: number }} */ budget) =>
        setGeoBudget(marketDeps, { userId: String(user.id), geoProjectId: project.id, ...budget }),
      cancelOrder: (/** @type {any} */ user, /** @type {any} */ project, /** @type {string} */ orderId) =>
        cancelGeoOrder(marketDeps, { userId: String(user.id), geoProjectId: project.id, orderId }),
      confirmTopup: (/** @type {any} */ user, /** @type {string} */ topupId, /** @type {number | undefined} */ amountCny) =>
        confirmGeoTopup(marketDeps, { topupId, operatorId: String(user.id), ...(amountCny == null ? {} : { amountCny }) }),
      resolveUnknownOrder: (/** @type {any} */ user, /** @type {string} */ orderId, /** @type {{ created: boolean, vendorOrderNid?: string }} */ input) =>
        resolveGeoUnknownOrder(marketDeps, { orderId, operatorId: String(user.id), ...input }),
      markOrderLost: (/** @type {any} */ user, /** @type {string} */ orderId, /** @type {string} */ reason) =>
        markGeoOrderLost(marketDeps, { orderId, operatorId: String(user.id), reason }),
      clearStop: (/** @type {any} */ user, /** @type {string | undefined} */ note) => clearGeoMarketStop(marketDeps, { operatorId: String(user.id), note }),
    };
    geoParts.worker = new GeoWorker({
      pollMs: config.geoPollMs ?? 5_000, leaseMs: config.geoLeaseMs ?? 600_000, timeZone: geoTimeZone,
      canRun: () => !maintenanceService || maintenanceService.claimingAllowed(),
      report: (loop, code) => process.stderr.write(`geo ${loop}: ${code}\n`),
      lease: (loop, work) => running.leaseLoop(loop, work),
      claimDay: (loop, day) => running.claimDay(loop, day),
      loops: {
        probe: () => tickGeoProbe(measureDeps),
        parse: () => tickGeoParse(measureDeps),
        metrics: () => tickGeoMetrics(measureDeps),
        errors: () => tickGeoErrors(measureDeps),
        orchestrator: () => running.tick(),
        schedules: () => running.tickSchedules(),
        catalogue: () => tickGeoCatalogue(marketDeps),
        orders: () => tickGeoOrders(marketDeps),
        poll: () => tickGeoPoll(marketDeps),
        verify: () => tickGeoVerify(marketDeps),
        reconcile: () => tickGeoReconcile(marketDeps),
        topups: () => tickGeoTopups(marketDeps),
      },
    });
  }

  /**
   * One GEO run, dispatched the way an autopilot episode is (bounded runtime,
   * a session bound to the capability, `automated`) but in the GEO project
   * itself, so it shows under that project. A project whose runtime is
   * already open for the researcher takes the run in that runtime instead —
   * the conversation they are looking at — rather than waiting for it to go
   * idle. Any run already running in the project refuses with `runtime_busy`
   * (one GEO run per project; the orchestrator retries next tick), as does a
   * full runtime quota.
   * @param {{ userId: string, projectId: string, capabilityId: string, dispatchId: string, reason: string, brief: string }} input
   */
  async function dispatchGeoRun({ userId, projectId, capabilityId, dispatchId, reason, brief }) {
    const user = await store.userById(userId);
    if (!user) throw new HttpError(404, "geo_project_not_found", "The GEO project's account is unavailable.");
    const project = await store.requireProject(user, projectId);
    const ledger = await agentRuns.list(project);
    const replay = ledger.find((run) => run.dispatchId === dispatchId);
    if (replay) return { runId: replay.id, sessionId: replay.sessionId ?? null, status: replay.status };
    if (ledger.some((run) => run.status === "running")) throw new HttpError(409, "runtime_busy", "The project has a run in progress; the GEO step waits.");
    if (config.runtimeMode === "kernel" && !config.deepseekProviderEnabled) {
      throw new HttpError(503, "model_provider_not_configured", "The research model provider is not configured on this EviMed server.");
    }
    const selected = (await agentRegistry)?.get?.(capabilityId) ?? null;
    if (!selected) throw new HttpError(503, "geo_unavailable", "This GEO capability is not installed on this deployment.");
    const budget = boundedRunBudget({ runLimitCny: 0, dailyLimitCny: 0, weeklyLimitCny: 0, purpose: "geo", invalidCode: "geo_unavailable" }, config);
    if (usageLedger) await assertBoundedRunAffordable(usageLedger, user.id, budget);
    const interactive = runtimeManager.runtimes.has(runtimeManager.key(project)) && !runtimeManager.boundedRuntimeScope(project);
    const session = interactive ? { id: randomId("session_") } : await runtimeManager.reserveBoundedRuntimeSession(project, { runId: dispatchId, ...budget.scope });
    try {
      await researchSessions.put(project, session.id, { mode: "specialist", agentId: selected.id, agentVersion: selected.version });
      const run = await agentRuns.dispatch(project, {
        sessionId: session.id, dispatchId, automated: true, question: brief,
        effectiveAgentId: selected.id, effectiveAgentVersion: selected.version, effectiveRuntimeAgent: selected.runtimeAgent, effectiveRouteReason: reason,
        ...(runEstimate(selected) ? { estimatedMinutes: runEstimate(selected) } : {}),
      }, async (binding, dispatchedRun, repairText = null) => {
        const promptText = typeof repairText === "string" && repairText.trim() ? repairText : brief;
        let memories = [];
        try { memories = await memorySubstrate.recall(user.id, brief, { projectId: project.id, sessionId: session.id }); }
        catch (error) { throw memoryRecallRejection(error); }
        const prepared = await prepareResearchContext(project, binding, config, {
          query: brief, memories, specialists: [],
          routedSpecialist: { agentId: selected.id, agentVersion: selected.version, runtimeAgent: selected.runtimeAgent,
            skill: selected.skill, companionSkills: selected.companionSkills },
        });
        const marker = interactive ? null : issueModelGatewayBudgetMarker({
          secret: config.modelGatewaySigningSecret, userId: user.id, projectId: project.id, runId: dispatchId, ...budget.scope,
        });
        return runtimeManager.dispatchPrompt(project, session.id, {
          // The brief first: the kernel names a session after its first message.
          text: marker ? `${promptText}\n\n${marker}` : promptText,
          system: prepared.system, memoryContext: prepared.memoryContext, residentProfile: true, agent: selected.runtimeAgent, strictContext: true,
          model: `deepseek/${config.deepseekModel}`, runId: dispatchedRun.id, allowBounded: !interactive,
          requestId: dispatchedRun.kernelRequestIds?.at(-1),
        });
      });
      return { runId: run.id, sessionId: session.id, status: run.status };
    } catch (error) {
      const recorded = (await agentRuns.list(project).catch(() => [])).find((run) => run.dispatchId === dispatchId);
      if (recorded?.status === "running") return { runId: recorded.id, sessionId: recorded.sessionId ?? session.id, status: recorded.status };
      if (!interactive) await runtimeManager.endBoundedRuntime(project, dispatchId).catch(() => {});
      if (recorded) return { runId: recorded.id, sessionId: recorded.sessionId ?? session.id, status: recorded.status };
      throw error;
    }
  }
  // A submission's independent review: started, asked after, answered
  // (reviewGateway.mjs); off, it answers `review_disabled`.
  const reviewGatewayHandler = createReviewGatewayHandler({
    runtimeManager, service: review?.service ?? null, config,
    report: (code) => process.stderr.write(`review gateway: ${code}\n`),
  });
  const commands =createCommandRegistry({ config, runtimeManager, sourceUpdates, knowledgeBaseUploads });
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
          frontier?.worker.status().running,
          review?.worker.status().running,
          geo?.worker?.status?.().running,
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
    const registry = await agentRegistry;
    if (binding?.mode === "specialist") return {
      effectiveAgentId: binding.agentId, effectiveAgentVersion: binding.agentVersion,
      effectiveRuntimeAgent: binding.runtimeAgent, effectiveRouteReason: "session-binding",
      estimatedMinutes: runEstimate(registry.get(binding.agentId)),
    };
    const routableAgents = registry.list().filter((agent) => agent.id !== OPEN_DOMAIN_ANSWER_AGENT_ID);
    const named = routeNamedSpecialist(text, routableAgents);
    /** @type {{ failure?: string, verdict?: string }} */
    const trace = {};
    const specialist = named ?? await specialistClassifier.classify(text, routableAgents, trace,
      { userId: project.userId, projectId: project.id })
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
      estimatedMinutes: runEstimate(effective?.agentId ? registry.get(effective.agentId) : null),
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

  /**
   * A question that arrived through a messaging channel (imService), dispatched
   * the way the page's own question is: the same provider and spend checks as
   * `POST /api/agent-runs/dispatch`, the same routing an adopted conversation
   * gets (`routeAdoptedInput`: named capability, classifier, net, answer line),
   * the same recall, context and `session/prompt`. Wired here, like autopilot's
   * episodes, because this is where the kernel wire lives; the module itself
   * never reaches a kernel.
   * @param {any} user @param {any} project @param {string} sessionId @param {string} dispatchId @param {string} text
   */
  async function dispatchChannelRun(user, project, sessionId, dispatchId, text) {
    if (config.runtimeMode === "kernel" && !config.deepseekProviderEnabled) {
      throw new HttpError(503, "model_provider_not_configured", "The research model provider is not configured on this EviMed server.");
    }
    if (usageLedger) await usageLedger.assertWithinLimits(user.id, {
      dailyLimit: Number(config.userDailySpendLimit) || 0,
      weeklyLimit: Number(config.userWeeklySpendLimit) || 0,
    });
    else await assertSpendWithinLimits(config, user.id);
    if (!(await researchSessions.get(project, sessionId))) await researchSessions.put(project, sessionId, { mode: "open-domain" });
    const registry = await agentRegistry;
    const route = await routeAdoptedInput(project, sessionId, text);
    const routed = route.effectiveAgentId && route.effectiveAgentId !== OPEN_DOMAIN_ANSWER_AGENT_ID
      ? registry.get(route.effectiveAgentId) : null;
    const answerAgent = routed ? null : registry.get(OPEN_DOMAIN_ANSWER_AGENT_ID);
    const answerPackage = answerAgent ? registry.getPackage(OPEN_DOMAIN_ANSWER_AGENT_ID) : null;
    const routableAgents = registry.list().filter((agent) => agent.id !== OPEN_DOMAIN_ANSWER_AGENT_ID);
    const dispatch = () => agentRuns.dispatch(project, {
      sessionId,
      dispatchId,
      ...(route.estimatedMinutes ? { estimatedMinutes: route.estimatedMinutes } : {}),
      question: text,
      effectiveAgentId: route.effectiveAgentId ?? null,
      effectiveAgentVersion: route.effectiveAgentVersion ?? null,
      effectiveRuntimeAgent: route.effectiveRuntimeAgent ?? null,
      effectiveRouteReason: route.effectiveRouteReason ?? null,
    }, async (session, dispatchedRun, repairText = null) => {
      const promptText = typeof repairText === "string" && repairText.trim() ? repairText : text;
      let memories = [];
      try {
        memories = await memorySubstrate.recall(user.id, text, { projectId: project.id, sessionId: session.sessionId });
      } catch (error) {
        throw memoryRecallRejection(error);
      }
      const prepared = await prepareResearchContext(project, session, config, {
        query: text,
        memories,
        specialists: routableAgents,
        mountableSkills: answerPackage?.skillText ? [{ name: answerPackage.manifest.skill, body: answerPackage.skillText }] : [],
        routedSpecialist: routed
          ? { agentId: routed.id, agentVersion: routed.version, runtimeAgent: routed.runtimeAgent,
            skill: routed.skill, companionSkills: routed.companionSkills }
          : null,
      });
      if (prepared.mountedSkills.length > 0 || prepared.memories.length > 0) {
        await agentRuns.recordLearning(project, dispatchedRun.id, {
          ...(prepared.mountedSkills.length > 0 ? { mountedSkills: prepared.mountedSkills } : {}),
          ...(prepared.memories.length > 0 ? { recalledMemories: prepared.memories } : {}),
        });
      }
      return runtimeManager.dispatchPrompt(project, session.sessionId, {
        text: promptText,
        system: prepared.system,
        memoryContext: prepared.memoryContext,
        residentProfile: true,
        agent: routed?.runtimeAgent ?? session.runtimeAgent ?? answerAgent?.runtimeAgent ?? null,
        model: `deepseek/${config.deepseekModel}`,
        runId: dispatchedRun.id,
        requestId: dispatchedRun.kernelRequestIds?.at(-1),
        strictContext: true,
      });
    });
    return pluginService ? pluginService.withAdmission(project, dispatch) : dispatch();
  }

  /**
   * A chat message the model judged to add to the task already running: the
   * page's 「补充」 route, same run, same contract (`/api/agent-runs/:id/steer`).
   * @param {any} project @param {string} runId @param {string} text
   */
  async function steerChannelRun(project, runId, text) {
    const run = (await agentRuns.list(project)).find((item) => item.id === runId);
    if (!run) throw new HttpError(404, "agent_run_not_found", "The run is unavailable.");
    const correctionRequestId = randomId("req_");
    const updated = await agentRuns.recordCorrection(project, runId, correctionRequestId);
    await runtimeManager.dispatchPrompt(project, run.sessionId, {
      text: `<evimed-correction>${String(text).slice(0, 4000)}</evimed-correction>`,
      runId,
      requestId: correctionRequestId,
      mode: "steer",
      strictContext: true,
    });
    return { corrections: updated?.corrections ?? 0 };
  }

  // rt: warm the most recently used project's runtime at sign-in (plan §3.1 #8).
  // Kernel mode only: the mock runtime is the suite's fake, and a fake started
  // on every sign-in would be a runtime no test asked for.
  function warmAfterSignIn(userId) {
    if (!config.runtimeWarmOnSignIn || config.runtimeMode !== "kernel") return;
    void (async () => {
      const user = await store.userById(String(userId));
      if (!user) return;
      const listed = (await store.listProjects(user)).filter((entry) => !entry.archivedAt && !isInternalProject(entry.id));
      await runtimeManager.warmMostRecent(await Promise.all(listed.map((entry) => store.requireProject(user, entry.id))));
    })().catch(() => {
      // isolated: a warm start is a head start, never a precondition.
    });
  }

  async function context(req, res) {
    const user = await store.ensureUser(req, res);
    const project = await store.selectedProject(req, user);
    const tenant = { id: user.tenantId ?? user.id, model: "individual-account", role: "owner" };
    return { config, store, runtimeManager, commands, req, res, user, tenant, project };
  }

  async function handle(req, res) {
    // rt: a public gateway request is answered here or rewritten to the
    // internal gateway path the dispatch below knows (plan §3.1 #5).
    if (runtimeGatewayEntry.matches(req) && await runtimeGatewayEntry.handle(req, res)) return;
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
        upstream: failure?.upstream ?? null,
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
      : pathname === ENGINE_USAGE_PATH
        ? engineUsageHandler
        : pathname === WEB_SEARCH_GATEWAY_PATH
          ? webSearchGatewayHandler
          : pathname === GEO_PROBE_GATEWAY_PATH
            ? geoProbeGatewayHandler
            : pathname === KB_SEARCH_GATEWAY_PATH
              ? kbSearchGatewayHandler
              : pathname === FRONTIER_GATEWAY_PATH
                ? frontierGatewayHandler
                : pathname.startsWith(REVIEW_GATEWAY_PREFIX)
                  ? reviewGatewayHandler
                  : pathname.startsWith(`${GEO_GATEWAY_PATH}/`)
                    ? geoGatewayHandler
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
      // Before the CSRF gate, deliberately. This surface carries no cookie: it
      // is authenticated by an account API key in an Authorization header, and
      // a browser cannot be made to attach one cross-site the way it attaches
      // a cookie — so the attack CSRF defends against does not exist here,
      // while the gate itself would refuse every external agent with
      // "Authentication required" for want of a session it was never going to
      // have.
      if (await agentMemoryRoutes(req, res)) return;
      // A device token (own-app reservation, off by default) is read here, so
      // the store's session and CSRF checks below recognise the request.
      await im.authenticateDevice(req, pathname);
      await store.assertCsrf(req, pathname);
      if (maintenanceService && requestStartsMutation(req, pathname)) {
        releaseMutation = await maintenanceService.admitMutation();
      }
      if (await pluginRoutes(req, res)) return;
      if (await capsuleRoutes(req, res)) return;
      if (await notificationRoutes(req, res)) return;
      if (await learningRoutes(req, res)) return;
      if (await sourceRoutes(req, res)) return;
      if (await library.routes(req, res)) return;
      if (await autopilotRoutes(req, res)) return;
      if (await frontierRoutes(req, res)) return;
      if (await reviewRoutes(req, res)) return;
      if (await geoRoutes(req, res)) return;
      if (await im.routes(req, res)) return;

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
        const readiness = await readinessStatus(config, store, runtimeManager, researchMemory, memoryIndexWorker, usageLedger, notificationService, documentParser, openListConnector, productDatabase, memorySubstrate, frontier, review, geo);
        sendJson(res, readiness.ok ? 200 : 503, { data: readiness });
        return;
      }

      if (pathname === "/api/ops/metrics" && (req.method === "GET" || req.method === "HEAD")) {
        await sendOperatorMetrics(req, res, {
          config,
          store,
          taskManager,
          runtimeManager,
          researchMemory,
          memorySubstrate,
          memoryIndexWorker,
          usageLedger,
          notificationService,
          documentParser,
          openList: openListConnector,
          productDatabase,
          operationalMetrics,
          activeCommands,
          runMetrics,
          imMetrics: im.service ? () => im.service.metrics() : null,
          webReader,
          sourceUpdates,
          edgeProxy,
          frontier,
          review,
          geo,
        });
        return;
      }

      // What each purpose cost across every account (X1): the operator's cost
      // report, behind the scrape token the metrics above use. Money is read
      // from the ledger here rather than exported as a metric, because a price
      // summed in Prometheus would be summed again on every scrape window.
      if (pathname === "/api/ops/usage/by-purpose" && req.method === "GET") {
        assertOperatorMetricsAccess(req, config);
        if (!usageLedger) throw new HttpError(503, "usage_ledger_unavailable", "Durable usage accounting is unavailable.");
        const url = new URL(req.url ?? "/", apiBaseFromRequest(req, config));
        const days = Number(url.searchParams.get("days") ?? 7);
        if (!Number.isSafeInteger(days) || days < 1 || days > 366) {
          throw new HttpError(400, "usage_report_days_invalid", "days must be a whole number from 1 to 366.");
        }
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        sendJson(res, 200, { data: {
          days, since: since.toISOString(), currency: "CNY", rows: await usageLedger.usageByPurpose({ since }),
        } });
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
          warmAfterSignIn(user.id);
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
          warmAfterSignIn(login.user.id);
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
          warmAfterSignIn(login.user.id);
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

      if (pathname === "/api/auth/password" && req.method === "POST") {
        // The account's own password, changed by the account: the current
        // one proves it is the owner asking, as deletion does, and the CSRF
        // token proves the request is the shell's. Other browser sessions of
        // the account stay signed in; a password change is not a sign-out.
        const { user, session } = await store.ensureSessionUser(req, res);
        if (session?.csrfToken && req.headers["x-open-science-csrf"] !== session.csrfToken) {
          throw new HttpError(403, "csrf_required", "A valid CSRF token is required.");
        }
        const body = await readJson(req, config.maxJsonBytes);
        const currentPassword = assertString(body.currentPassword, "currentPassword", { max: 4096 });
        const nextPassword = assertString(body.newPassword, "newPassword", { max: 4096 });
        try {
          await store.changePassword(user.id, currentPassword, nextPassword);
          await securityAudit(config, "auth.password", "completed", { userId: user.id });
        } catch (err) {
          await securityAudit(config, "auth.password", "failed", {
            userId: user.id,
            code: err instanceof HttpError ? err.code : "internal_error",
          });
          throw err;
        }
        sendJson(res, 200, { data: true });
        return;
      }

      if (pathname === "/api/auth/dev-login" && req.method === "POST") {
        if (config.authMode !== "development") {
          throw new HttpError(404, "auth_method_disabled", "Development authentication is disabled.");
        }
        const ctx = await context(req, res);
        sendJson(res, 200, { data: { user: { id: ctx.user.id, name: ctx.user.name } } });
        warmAfterSignIn(ctx.user.id);
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
            projects: (await store.listProjects(user)).filter((item) => !isInternalProject(item.id)),
            // The conversation to reopen in this project (C4), or null when
            // the researcher has not worked here yet — or the ledger cannot be
            // read, which is not a reason the shell should fail to render.
            lastSessionId: await agentRuns.lastSessionId(project).catch(() => null),
            // How many data sources nothing serves for this researcher and
            // that need a key — the badge on the account page. 0 where the
            // deployment keeps no personal credentials or cannot say now: the
            // shell must render either way.
            missingConnectorCredentials: connectorCredentials
              ? await connectorCredentials.status(user.id)
                .then((entries) => entries.filter((entry) => entry.needsAttention).length)
                .catch(() => 0)
              : 0,
            csrfToken: session.csrfToken,
            // Whether this account sees the operations page. Presentation
            // only: `config.operatorUsers` decides which menu the shell draws,
            // and every route the page calls keeps its own authorization, so a
            // browser that sets this to true by hand gains a link, not access.
            operator: config.operatorUsers.includes(user.id),
            // Which optional modules this account sees. Presentation too: the
            // module's own routes answer 404 to anyone it does not.
            features: { frontier: Boolean(frontier) && frontierAudienceAllows(config, user), review: Boolean(review),
              geo: Boolean(geo) && geoAudienceAllows(config, user) },
            runtime: {
              kernel: RUNTIME_KERNEL_NAME,
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
        // A turn typed into this window reaches the kernel without a dispatch,
        // so this is the last moment the control plane sees before it: bring
        // the resident capsule profile up to date here. Not awaited — opening
        // the window must not wait on the product database — and the window's
        // own boot takes far longer than the write.
        void runtimeManager.syncCapsuleProfile(project);
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
        const { user, session } = await store.ensureSessionUser(req, res, { allowDevAuth: false });
        if (req.headers["x-open-science-csrf"] !== session.csrfToken) throw new HttpError(403, "csrf_required", "A valid CSRF token is required.");
        const frameId = pathname.slice("/api/runtime-ui/frames/".length);
        // This expires the browser's exact Path cookie, not the signed ticket:
        // logout stays the authority boundary, and other frames' cookies are
        // untouched. The frame's own connections are closed before the answer,
        // so a release the shell waits for has freed its runtime's slot by
        // the time the shell starts the next project (UI plan §2.2).
        const expired = releaseRuntimeUiFrameCookie(config, frameId);
        await runtimeUi.releaseFrame(frameId, user.id);
        res.setHeader("Set-Cookie", expired);
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

      if (await memoryRoutes(req, res)) return;
      if (await memoryTimelineRoutes(req, res)) return;
      if (await agentKeyRoutes(req, res)) return;

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
        let runs = await agentRuns.withPlanProgress(ctx.project, await agentRuns.recover(ctx.project));
        // The platform's own background runs — a source being understood, a
        // method being distilled — are not the researcher's conversations;
        // listed, they read as conversations nobody started (2026-09-21, the
        // first live distillations appeared in 「我的研究」).
        const registry = await agentRegistry;
        runs = runs.filter((run) => registry?.get?.(String(run.effectiveAgentId ?? run.agentId ?? ""))?.visibility !== "internal");
        // Put away or removed by the researcher: out of the lists, still in
        // the ledger for everything that reads a run by its id. `archived=1`
        // asks for the shelf instead of the desk.
        const shelf = new URL(req.url ?? "/", "http://evimed.local").searchParams.get("archived") === "1";
        runs = runs.filter((run) => !run.deleted && Boolean(run.archived) === shelf);
        // Runs adopted before their first message could be read learn it in
        // the background; this answer does not wait for that (C3).
        agentRuns.backfillQuestions(ctx.project, runs);
        // What each run has spent (C3 `usage`), one query for the whole list.
        // A ledger that cannot be read leaves the runs without the field
        // rather than the list without its runs.
        if (usageLedger && runs.length > 0) {
          const summaries = await usageLedger.summaryRuns(ctx.project.userId, runs.flatMap((run) => [run.id, run.dispatchId]).filter(Boolean))
            .catch(() => null);
          if (summaries) runs = runs.map((run) => { const usage = runUsageFrom(summaries, run); return usage ? { ...run, usage } : run; });
        }
        sendJson(res, 200, { data: runs });
        return;
      }

      // A researcher names a run (C3). Locked from then on: no automatic
      // title replaces it, and the next rename by hand does.
      if (pathname.startsWith("/api/agent-runs/") && req.method === "PATCH") {
        const rawRunId = pathname.slice("/api/agent-runs/".length);
        if (!rawRunId || rawRunId.includes("/")) throw new HttpError(404, "not_found", "Route not found.");
        const runId = decodeRouteComponent(rawRunId, "agent run id");
        const ctx = await context(req, res);
        const body = assertObject(await readJson(req, config.maxJsonBytes), "agent run update");
        // Three things a researcher does to a conversation from its row:
        // rename it, put it away, remove it (2026-09-22). One field per call.
        const fields = Object.keys(body);
        const unknown = fields.filter((field) => !["title", "archived", "deleted"].includes(field));
        if (unknown.length > 0) {
          throw new HttpError(400, "invalid_payload", `Unknown agent run field(s): ${unknown.sort().join(", ")}.`);
        }
        if (fields.length !== 1) throw new HttpError(400, "invalid_payload", "One agent run field per update.");
        if ("title" in body) {
          if (typeof body.title !== "string") throw new HttpError(400, "invalid_payload", "title must be a string.");
          sendJson(res, 200, { data: await agentRuns.recordRunLabels(ctx.project, runId, { title: body.title, titleSource: "user" }) });
          return;
        }
        if ("archived" in body) {
          if (typeof body.archived !== "boolean") throw new HttpError(400, "invalid_payload", "archived must be a boolean.");
          sendJson(res, 200, { data: await agentRuns.recordRunLabels(ctx.project, runId, { archived: body.archived }) });
          return;
        }
        if (body.deleted !== true) throw new HttpError(400, "invalid_payload", "deleted can only be set to true.");
        // A conversation still working is stopped first: a hidden run that
        // keeps spending is the one thing a reader could never find again.
        const current = (await agentRuns.list(ctx.project)).find((run) => run.id === runId);
        if (current && current.status === "running") await agentRuns.cancelRun(ctx.project, runId, { by: ctx.user.id });
        sendJson(res, 200, { data: await agentRuns.recordRunLabels(ctx.project, runId, { deleted: true }) });
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

      // A question, dispatched as a run.
      //
      //   POST /api/agent-runs/dispatch
      //     { sessionId, dispatchId?, text, automated?: boolean, line?: "answer" | "<capability id>" }
      //   202 { data: run }   run.routeReason (zh) and run.estimatedMinutes say where it went (C3)
      //   400 invalid_agent_run — an unknown field; a `line` that is neither `answer` nor a public
      //       capability id; a `line` on a conversation already bound to a capability
      //
      // `line` is the researcher's own choice and replaces the router and the
      // classifier: `answer` pins the answer line (「改为普通问答」), an id pins
      // that capability; the run records `choice:<line>`.
      if (pathname === "/api/agent-runs/dispatch" && req.method === "POST") {
        const ctx = await context(req, res);
        const body = assertObject(await readJson(req, config.maxJsonBytes), "agent run dispatch");
        const unknown = Object.keys(body).filter((field) => !["sessionId", "dispatchId", "text", "automated", "line"].includes(field));
        if (unknown.length > 0) {
          throw new HttpError(400, "invalid_agent_run", `Unknown agent run field(s): ${unknown.sort().join(", ")}.`);
        }
        // An evaluation or acceptance harness says so, and its run's completion
        // is then recorded in the inbox without notifying anyone (C1). 29 of the
        // 31 unread items the 2026-09-17 walk found were eval cells.
        if (body.automated != null && typeof body.automated !== "boolean") {
          throw new HttpError(400, "invalid_agent_run", "automated must be a boolean.");
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
        // The researcher's own choice of line (2026-09-18): `line: "answer"`
        // for the answer line — the shell's 「改为普通问答」 — or the id of a
        // public capability. A choice is an instruction, not a hint: it
        // replaces the router and the classifier outright, and is recorded as
        // `choice:<line>` so the ledger and the reader both see it was chosen.
        const chosenLine = chosenDispatchLine(body.line, boundSession, routableAgents);
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
        /** @type {{ agentId: string, agentVersion: string, runtimeAgent: string, reason: string } | null} */
        let routedSpecialist = chosenLine?.agent
          ? { agentId: chosenLine.agent.id, agentVersion: chosenLine.agent.version, runtimeAgent: chosenLine.agent.runtimeAgent, reason: `choice:${chosenLine.agent.id}` }
          : null;
        /** @type {{ failure?: string, verdict?: string }} */
        const classifierTrace = {};
        if (boundSession?.mode === "open-domain" && !chosenLine) {
          const named = routeNamedSpecialist(text, routableAgents);
          // Naming the package is an instruction, not a guess at intent.
          routedSpecialist = named ?? await specialistClassifier.classify(text, routableAgents, classifierTrace,
            { userId: ctx.project.userId, projectId: ctx.project.id });
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
              reason: chosenLine
                ? "choice:answer"
                : classifierTrace.failure
                  ? classifierFailureReason("unrouted:open-domain", classifierTrace.failure)
                  : "unrouted:open-domain",
            }
          : null);
        // How long the route taken should take (C3): the bound capability's, the
        // routed one's, or the answer line's own estimate.
        const estimate = runEstimate(boundSession?.mode === "specialist"
          ? registry.get(boundSession.agentId)
          : (routedSpecialist ? registry.get(routedSpecialist.agentId) : answerAgent));
        const dispatch = () => agentRuns.dispatch(ctx.project, {
          sessionId: body.sessionId,
          dispatchId: body.dispatchId,
          ...(body.automated === true ? { automated: true } : {}),
          ...(estimate ? { estimatedMinutes: estimate } : {}),
          question: text,
          effectiveAgentId: effectiveAgent?.agentId ?? null,
          effectiveAgentVersion: effectiveAgent?.agentVersion ?? null,
          effectiveRuntimeAgent: effectiveAgent?.runtimeAgent ?? null,
          effectiveRouteReason: effectiveAgent?.reason ?? null,
        }, async (session, dispatchedRun, repairText = null) => {
          const promptText = typeof repairText === "string" && repairText.trim() ? repairText : text;
          let memories = [];
          try {
            memories = await memorySubstrate.recall(ctx.user.id, text, {
              projectId: ctx.project.id,
              sessionId: session.sessionId,
            });
          } catch (error) {
            // A recall that throws has exactly two causes, and neither is a
            // footnote to put in the prompt. Either the authoritative store is
            // unreachable — it is a schema of the control-plane database, so the
            // run could not be recorded anyway — or the operator set
            // `OPEN_SCIENCE_MEMORY_INDEX_STRICT`, which is the statement that
            // they would rather see the index failure than an answer built on a
            // silent fallback. A deployment with no store at all never arrives
            // here: an unconfigured store returns no memories instead of
            // failing, which is why there is no "answer anyway" branch left.
            throw memoryRecallRejection(error);
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
          // What this conversation's own state adds (memorySessions.mjs): the
          // capsule a 「试用一次」 conversation is trying.
          const sessionNotes = await sessionDispatchNotes({ researchMemory, capsules: capsuleService }, ctx.user.id, ctx.project.id, session.sessionId);
          // Before the prompt goes out, like the brief: a mount the ledger has
          // not recorded cannot be told apart from one that never happened.
          // The same rule for what was recalled: a memory this dispatch used
          // and the ledger never named is one the researcher cannot audit.
          if (prepared.mountedSkills.length > 0 || prepared.memories.length > 0) {
            await agentRuns.recordLearning(ctx.project, dispatchedRun.id, {
              ...(prepared.mountedSkills.length > 0 ? { mountedSkills: prepared.mountedSkills } : {}),
              ...(prepared.memories.length > 0 ? { recalledMemories: prepared.memories } : {}),
            });
          }
          return runtimeManager.dispatchPrompt(ctx.project, session.sessionId, {
            text: promptText,
            system: sessionNotes.length ? `${prepared.system}\n\n${sessionNotes.join("\n\n")}` : prepared.system,
            memoryContext: prepared.memoryContext,
            residentProfile: true,
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
      //   POST /api/agent-runs/:id/steer   { text: string }   (1–4000 chars, not blank; no other field)
      //   202 { data: { id, corrections } }                   corrections = how many this run has taken
      //   404 agent_run_not_found · 400 invalid_payload
      //   409 agent_run_not_running · 409 agent_run_correction_limit (MAX_RUN_CORRECTIONS per run)
      // The text reaches the running turn at its next step boundary (kernel
      // `steer` delivery), wrapped in <evimed-correction> so a compaction keeps it.
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

      // Stops a run (C3). A researcher who saw at minute three that a run was
      // going the wrong way had no way to stop it from the runs page (E §9.2).
      //
      // The kernel first, then the ledger, and in that order on purpose: a
      // ledger that says 「已取消」 while the kernel keeps spending is the one
      // outcome worse than no button. So a kernel that cannot be reached with
      // a runtime running is an error the caller can retry, and the run stays
      // running; with no runtime running there is nothing left to stop.
      //
      // What reaches a child. `session/cancel` stops the root's current turn;
      // the kernel refuses it for a subagent-owned session, and its
      // `subagents/interruptByParent` interrupts only continuable children
      // (every child the socket starts is one-shot, and the method is on the
      // seam manifest's deny list). A one-shot child ends with its owner: the
      // socket cancels the children a cancelled root turn orphans. The answer
      // lists the children this control plane knew of, marked `with-root`.
      if (pathname.startsWith("/api/agent-runs/") && pathname.endsWith("/cancel") && req.method === "POST") {
        const rawRunId = pathname.slice("/api/agent-runs/".length, -"/cancel".length);
        if (!rawRunId || rawRunId.includes("/")) throw new HttpError(404, "not_found", "Route not found.");
        const runId = decodeRouteComponent(rawRunId, "agent run id");
        const ctx = await context(req, res);
        const body = assertObject(await readJson(req, config.maxJsonBytes), "agent run cancellation");
        const unknown = Object.keys(body);
        if (unknown.length > 0) {
          throw new HttpError(400, "invalid_payload", `Unknown cancellation field(s): ${unknown.sort().join(", ")}.`);
        }
        const run = (await agentRuns.list(ctx.project)).find((item) => item.id === runId);
        if (!run) throw new HttpError(404, "agent_run_not_found", "The run is unavailable.");
        if (run.status !== "running") {
          sendJson(res, 200, { data: { run, cancellation: { root: "not-running", children: [] } } });
          return;
        }
        let root = "canceled";
        try {
          if (!(await runtimeManager.cancelRuntimeSession(ctx.project, run.sessionId))) root = "runtime-not-running";
        } catch (error) {
          // A session the kernel no longer holds is not running either.
          if (error?.code !== "runtime_session_not_found") throw error;
          root = "session-not-found";
        }
        const children = agentRuns.knownChildSessions(run).map((childSessionId) => ({ childSessionId, stop: "with-root" }));
        const canceled = await agentRuns.cancelRun(ctx.project, runId, { by: "user" });
        await audit(ctx, "agent_run.cancel", "completed", { target: runId });
        sendJson(res, 200, { data: { run: canceled, cancellation: { root, children } } });
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

      // The same month, one row per research run: date, conversation, cost —
      // the settings page's 明细 (2026-09-23 plan §5.9). Read-only. A
      // deployment without the durable ledger has no run attribution, so all
      // of its spend is `other`.
      if (pathname === "/api/account/usage/runs" && req.method === "GET") {
        const user = await store.ensureUser(req, res);
        const now = new Date();
        const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
        if (!usageLedger) {
          const summary = summarizeUsage(await readServerUsageJsonl(config, user), { userId: user.id, since });
          sendJson(res, 200, { data: { since: since.toISOString(), currency: summary.currency, items: [], other: { calls: summary.calls, cost: summary.cost } } });
          return;
        }
        const groups = await usageLedger.runsSince(user.id, { since });
        const runs = [];
        if (groups.some((group) => group.runId)) {
          const registry = await agentRegistry;
          for (const listed of await store.listProjects(user)) {
            const project = await store.requireProject(user, listed.id);
            for (const run of await agentRuns.list(project)) {
              const agent = String(run.effectiveAgentId ?? run.agentId ?? "");
              runs.push({ run, projectId: project.id, internal: registry?.get?.(agent)?.visibility === "internal" });
            }
          }
        }
        sendJson(res, 200, { data: { since: since.toISOString(), currency: "CNY", ...accountUsageRuns(groups, runs) } });
        return;
      }

      if (pathname === "/api/account/export" && req.method === "GET") {
        const user = await store.ensureUser(req, res);
        await withAccountExportSnapshot(productDatabase, user, config, async snapshot => {
          const projects = snapshot?.projects ?? await store.listProjects(user);
          // Written as `memory/memory.json`, from the store itself rather than
          // from the account-state snapshot: the export is the researcher's own
          // copy of their memory, and a deployment without a store has none to
          // carry rather than an empty one to claim.
          const memory = researchMemory.configured ? await researchMemory.exportUserMemory(user.id) : null;
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
        // The purge still runs first, for the counts the audit line carries.
        // Completeness no longer depends on it: the memory tables reference the
        // account with ON DELETE CASCADE, so `store.deleteUser` below removes
        // whatever a failed purge would have left.
        // The derived copies go first. Either order can fail halfway; only this
        // one fails harmlessly. An index emptied for an account whose rows are
        // still there costs a degraded recall until the next rebuild, and the
        // caller can simply try again. The other order destroys the memory and
        // then answers 500, leaving an account that still exists and a
        // researcher whose memory is gone because a component that holds no
        // original data was unreachable for a moment.
        await memorySubstrate.forgetUser(user.id);
        // Counted, not deleted. The memory tables reference the account with ON
        // DELETE CASCADE, so `store.deleteUser` below removes them inside the
        // transaction that can still fail — where deleting them here would mean
        // a deletion that failed halfway had already destroyed the memory of an
        // account that still exists.
        const memoryPurge = researchMemory.configured
          ? await researchMemory.countUserMemory(user.id)
          : { structured: 0, manual: 0 };
        let memoryIndexPurge = null;
        /** @type {string[]} */
        let geoScreenshots = [];
        const data = await store.deleteUser(user, {
          beforeLock: memoryIndexing ? (id, client) => memoryIndexing.lockAccountDeletion(id, client) : null,
          beforeDelete: async (id, client) => {
            if (memoryIndexing) {
              memoryIndexPurge = await memoryIndexing.prepareAccountDeletion(id, user.accountCreatedAt, client);
            }
            if (capsuleTransferService) await capsuleTransferService.prepareAccountDeletion(id, client);
            // The account's GEO rows, whether or not the module is on today.
            if (client) geoScreenshots = (await deleteGeoUserRows(client, id)).screenshots;
          },
        });
        // The screenshots only those rows referenced, now that they are gone.
        await removeGeoScreenshotFiles(config.dataDir, geoScreenshots, (code) => process.stderr.write(`geo screenshot cleanup: ${code}\n`));
        taskManager.purgeUser(user);
        clearSessionCookie(res, config.sessionCookieName);
        if (capsuleTransferService) await capsuleTransferService.finishAccountDeletion(user.id);
        await securityAudit(config, "account.delete", "completed", { userId: user.id, memoryPurge, memoryIndexPurge });
        sendJson(res, 200, { data });
        return;
      }

      if (pathname === "/api/projects" && req.method === "GET") {
        const user = await store.ensureUser(req, res);
        // With how much each has been used (C4): runs and the last moment
        // anything happened in one. A ledger that cannot be read is reported
        // as unknown activity for that row, never as a failed list.
        // The platform's own background projects are not the researcher's
        // (`internalProjects.mjs`).
        const projects = (await store.listProjects(user)).filter((item) => !isInternalProject(item.id));
        const data = await Promise.all(projects.map(async (item) => {
          try {
            return { ...item, ...(await agentRuns.activitySummary(await store.requireProject(user, item.id))) };
          } catch {
            return { ...item, runCount: 0, lastActivityAt: null };
          }
        }));
        sendJson(res, 200, { data });
        return;
      }

      if (pathname === "/api/projects" && req.method === "POST") {
        const user = await store.ensureUser(req, res);
        const body = assertObject(await readJson(req, config.maxJsonBytes), "project");
        const unknown = Object.keys(body).filter((field) => field !== "id" && field !== "name");
        if (unknown.length > 0) throw new HttpError(400, "invalid_payload", `Unknown project field(s): ${unknown.sort().join(", ")}.`);
        const data = await createResearcherProject(user, body);
        sendJson(res, 200, { data: { ...data, runCount: 0, lastActivityAt: null } });
        return;
      }

      if (pathname.startsWith("/api/projects/")) {
        const [rawProjectId, action, ...extra] = pathname.slice("/api/projects/".length).split("/");
        if (!rawProjectId || extra.length > 0) throw new HttpError(404, "not_found", "Route not found.");
        const projectId = decodeRouteComponent(rawProjectId, "project id");
        // Renamed by its name only (C4); the id is a path and does not move.
        if (!action && req.method === "PATCH") {
          const user = await store.ensureUser(req, res);
          const body = assertObject(await readJson(req, config.maxJsonBytes), "project update");
          const unknown = Object.keys(body).filter((field) => field !== "name");
          if (unknown.length > 0) throw new HttpError(400, "invalid_payload", `Unknown project field(s): ${unknown.sort().join(", ")}.`);
          const data = await store.renameProject(user, projectId, body.name);
          const project = await store.requireProject(user, projectId);
          await audit({ config, user, project }, "project.rename", "completed", { target: projectId });
          sendJson(res, 200, { data: { ...data, ...(await agentRuns.activitySummary(project).catch(() => ({ runCount: 0, lastActivityAt: null }))) } });
          return;
        }
        // Archived rather than deleted: out of the way, still whole and
        // exportable, and back with `{ archived: false }` (C4).
        if (action === "archive" && req.method === "POST") {
          const user = await store.ensureUser(req, res);
          const body = assertObject(await readJson(req, config.maxJsonBytes), "project archive");
          const unknown = Object.keys(body).filter((field) => field !== "archived");
          if (unknown.length > 0) throw new HttpError(400, "invalid_payload", `Unknown project field(s): ${unknown.sort().join(", ")}.`);
          if (body.archived != null && typeof body.archived !== "boolean") throw new HttpError(400, "invalid_payload", "archived must be a boolean.");
          const data = await store.archiveProject(user, projectId, body.archived !== false);
          const project = await store.requireProject(user, projectId);
          await audit({ config, user, project }, data.archivedAt ? "project.archive" : "project.unarchive", "completed", { target: projectId });
          sendJson(res, 200, { data: { ...data, ...(await agentRuns.activitySummary(project).catch(() => ({ runCount: 0, lastActivityAt: null }))) } });
          return;
        }
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
          // Derived copies go first, and go with the record they were derived
          // from. Awaited and not swallowed: an index that still answers with a
          // deleted project's memories is a copy of deleted data, so a failure
          // here fails the delete rather than reporting a deletion that did not
          // happen. Before the rows rather than after, so that failure leaves
          // the project and its memory both intact and the request retryable —
          // the reverse order answers 500 with the memory already destroyed.
          await memorySubstrate.forgetProject(user.id, project.id);
          if (researchMemory.configured) await researchMemory.deleteProjectMemory(user.id, project.id);
          // Again, now that the rows are gone. Between the removal above and
          // the delete, a queued index job for one of those records still finds
          // its row and republishes the copy; a second pass removes what that
          // window let back in. Not awaited for the request's verdict: the
          // deletion the researcher asked for has happened by this line, and a
          // derived copy that survives holds no original data and goes with the
          // next rebuild, so failing here would report a deletion that did.
          await memorySubstrate.forgetProject(user.id, project.id).catch(() => false);
          // What the project's documents and runs put in the account's own
          // capsule — 「来自资料」 above all — is account-level and outlived
          // every project deletion until 2026-09-24 (62 such memories were
          // cleared by hand on production the day before). Withdrawn inside
          // the deletion's own transaction, so the two commit together; the
          // update is also what tells the recall index (`derivedMemory.mjs`).
          if (productDatabase) await migrateProductStore(productDatabase);
          /** @type {string[]} */
          let geoScreenshots = [];
          const data = await store.deleteProject(user, projectId, {
            beforeDelete: async (client) => {
              if (client) await withdrawProjectDerivedMemory(client, user.id, project.id);
              // A GEO project's rows go with it, whether or not the module is
              // on today (its money rows stay; geoStore.mjs).
              if (client) geoScreenshots = (await deleteGeoProjectRows(client, user.id, project.id)).screenshots;
            },
          });
          // The screenshots only those rows referenced, once the deletion has committed.
          await removeGeoScreenshotFiles(config.dataDir, geoScreenshots, (code) => process.stderr.write(`geo screenshot cleanup: ${code}\n`));
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
        // Under both ids a run's calls can carry: its own, which the gateway
        // stamps on an interactive run's calls, and its dispatch id, which a
        // bounded runtime (autopilot, verification) was minted for.
        const summaries = await Promise.all([...new Set([run.id, run.dispatchId].filter(Boolean))]
          .map((id) => usageLedger.summaryRun(ctx.project.userId, id)));
        const total = (field) => summaries.reduce((sum, item) => sum + (Number(item[field]) || 0), 0);
        const models = [...new Set(summaries.map((item) => item.modelId).filter(Boolean))];
        sendJson(res, 200, { data: {
          runId: run.id,
          cost: Math.round(total("actualCost") * 1e6) / 1e6,
          openCost: Math.round(total("openCost") * 1e6) / 1e6,
          currency: summaries[0]?.currency ?? "CNY",
          calls: total("settledCalls"),
          uncertain: total("uncertain"),
          cacheHitTokens: null,
          cacheMissTokens: null,
          inputTokens: total("inputTokens"),
          outputTokens: total("outputTokens"),
          modelId: models.length === 1 ? models[0] : null,
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
        const registered = await writeProjectUpload(ctx, { root, rel, buffer });
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
    agentRegistry,
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
   * One pass per researcher per `learningConsolidationIntervalMs` (an hour),
   * plus the one distillation queues after every method it writes. It was
   * once a night per project, inside the learning window, and in production
   * it never ran: a method learnt at noon could not be related, promoted or
   * retired until the next night (2026-09-21, owner: 「你当然得触发整理呀」).
   *
   * Per researcher rather than per project, since a researcher's methods follow
   * them across projects (`selectLearnedMethods`): `sleep` reads the whole
   * library. The job is filed under the project whose method changed last,
   * which is where its model steps run.
   */
  const scheduleConsolidation = async () => {
    if (!learningService || !productJobs || !config.learningEnabled || consolidationScheduleRun) {
      return consolidationScheduleRun;
    }
    const schedule = async () => {
      // Researchers holding at least one method that is not already retired,
      // each with the project whose method changed last. A library of nothing
      // has nothing to consolidate, and enqueueing for it would put a job on
      // every account in the deployment every hour.
      const result = await productDatabase.query(`SELECT DISTINCT ON (user_id) user_id,project_id FROM evimed_product.documents
        WHERE kind='method' AND deleted_at IS NULL AND project_id IS NOT NULL
          AND payload->>'status' IS DISTINCT FROM 'retired'
        ORDER BY user_id,updated_at DESC LIMIT 200`);
      const interval = Math.max(60_000, Number(config.learningConsolidationIntervalMs) || 3_600_000);
      const period = Math.floor(Date.now() / interval);
      const date = new Date(period * interval).toISOString();
      for (const row of result.rows) {
        try {
          await productJobs.enqueue(row.user_id, "consolidate", { action: "sleep", date }, {
            // One pass per researcher per interval however often this timer fires.
            idempotencyKey: `consolidate:sleep:${interval}:${period}`,
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
  let idleRuntimeSweepTimer = null;
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
    for (const worker of [pluginApplyWorker, memoryIndexWorker, sourceWorker, autopilotWorker, learningWorker, im.worker, kbIndex, frontier?.worker, review?.worker,
      geo?.worker]) {
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
    if (idleRuntimeSweepTimer) clearInterval(idleRuntimeSweepTimer);
    capsuleCleanupTimer = null;
    autopilotScheduleTimer = null;
    consolidationScheduleTimer = null;
    notificationTimer = null;
    usageReconcileTimer = null;
    idleRuntimeSweepTimer = null;
  };

  const startRecurringWork = async () => {
    if (recurringWorkStarted || (maintenanceService && !maintenanceService.claimingAllowed())) return;
    recurringWorkStarted = true;
    try {
      pluginApplyWorker?.start();
      memoryIndexWorker?.start();
      sourceWorker?.start();
      kbIndex?.start();
      autopilotWorker?.start();
      learningWorker?.start();
      im.worker?.start();
      frontier?.worker.start();
      review?.worker.start();
      geo?.worker?.start?.();
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
      // Once per consolidation interval: the job it enqueues is idempotent per
      // researcher per interval, so a faster tick buys only queries.
      if (learningWorker && !consolidationScheduleTimer) {
        consolidationScheduleTimer = setInterval(() => { void scheduleConsolidation(); },
          Math.max(60_000, Number(config.learningConsolidationIntervalMs) || 3_600_000));
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
      // Reclaiming runtimes nobody is using.
      //
      // The per-runtime idle timer only ever starts when the last connection
      // closes, and the session surface holds one for as long as its tab is
      // open, so a parked tab pinned the runtime — and with the deployment's
      // ceiling at one, pinned every other account out (2026-09-15 walk, B1').
      // This sweep measures the last request rather than the last connection,
      // and asks the kernel before stopping anything.
      if (!idleRuntimeSweepTimer) {
        idleRuntimeSweepTimer = setInterval(() => { void runtimeManager.sweepIdleRuntimes().catch(() => {}); }, 60_000);
        idleRuntimeSweepTimer.unref();
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
    researchMemory,
    memorySubstrate,
    memoryRerank,
    openVikingClient,
    memoryIndexing,
    memoryIndexWorker,
    sourceService,
    sourceWorker,
    kbIndex,
    libraryService,
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
    // 「前沿动态」: null when the module is off or there is no product database.
    frontier,
    frontierService: frontier?.service ?? null,
    frontierWorker: frontier?.worker ?? null,
    // The independent reviewer: null when the module is off or there is no product database.
    review,
    reviewService: review?.service ?? null,
    reviewWorker: review?.worker ?? null,
    // 「循证 GEO」: null when the module is off or there is no product database.
    geo,
    geoService: geo?.service ?? null,
    capsuleService,
    pluginService,
    pluginApplyWorker,
    im,
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
      // Optional module: a failed migration is named here and turns the
      // `frontier` readiness check red; it does not stop the control plane.
      if (frontier) {
        await frontier.service.ready().catch((error) => {
          process.stderr.write(`frontier migration failed: ${typeof error?.code === "string" ? error.code : error?.name ?? "frontier_migration_failed"}\n`);
        });
      }
      // The same for 循证 GEO: a failed migration turns `geo` red.
      if (geo) {
        await geo.service.ready().catch((error) => {
          process.stderr.write(`geo migration failed: ${typeof error?.code === "string" ? error.code : error?.name ?? "geo_migration_failed"}\n`);
        });
      }
      // The same for the reviewer: a failed migration turns `review` red.
      if (review) {
        await review.service.ready().catch((error) => {
          process.stderr.write(`review migration failed: ${typeof error?.code === "string" ? error.code : error?.name ?? "review_migration_failed"}\n`);
        });
      }
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
      // First, so the evaluation the abort below ends is handed back as a
      // restart and not counted against its three attempts.
      learningWorker?.interrupt();
      for (const controller of evaluationAbortControllers) controller.abort();
      if (capsuleCleanupTimer) clearInterval(capsuleCleanupTimer);
      await capsuleCleanupRun;
      await pluginApplyWorker?.close();
      await memoryIndexWorker?.close();
      await sourceWorker?.close();
      await kbIndex?.close();
      await autopilotWorker?.close();
      await learningWorker?.close();
      await im.worker?.close();
      await frontier?.worker.close();
      await review?.worker.close();
      await geo?.worker?.close?.();
      if (autopilotScheduleTimer) clearInterval(autopilotScheduleTimer);
      await autopilotScheduleRun;
      if (consolidationScheduleTimer) clearInterval(consolidationScheduleTimer);
      await consolidationScheduleRun;
      if (notificationTimer) clearInterval(notificationTimer);
      await notificationRun;
      if (usageReconcileTimer) clearInterval(usageReconcileTimer);
      if (idleRuntimeSweepTimer) clearInterval(idleRuntimeSweepTimer);
      await usageReconcileRun;
      await runtimeUi.close();
      await taskManager.close();
      // Before the runtimes, because stopping a runtime the pump is still
      // following makes it reconnect to a kernel that is going away.
      await runtimeEventPump.closeAll();
      await runTitles.settle();
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
      // Releases the warm AgentBay browser session, if one is held.
      await webReader.close();
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
      // A preview is shown in a frame of the shell, and only there: framed by
      // this origin and no other.
      headers["X-Frame-Options"] = "SAMEORIGIN";
      headers["Content-Security-Policy"] = previewContentSecurityPolicy(headers["Content-Type"]);
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

/**
 * The policy a previewed file is served under.
 *
 * Everything but a PDF is sandboxed with no scripts, no requests and no
 * plugins: an uploaded or generated page renders as inert markup. A PDF
 * cannot be: the browser draws it with its own viewer, a plugin, and a
 * sandboxed document or one whose policy refuses plugins (`object-src`,
 * falling back to `default-src`) shows an empty frame instead — which is what
 * every PDF preview did until 2026-09-24. Its bytes are served as
 * `application/pdf` with `nosniff`, so it is never read as a page, and its
 * viewer runs outside this origin's documents.
 * @param {string} contentType
 */
function previewContentSecurityPolicy(contentType) {
  if (/^application\/pdf\b/i.test(String(contentType))) return "frame-ancestors 'self'";
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
    "frame-ancestors 'self'",
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

async function appendErrorRecord(config, req, pathname, { status, code, requestId = null, truncated = false, upstream = null }) {
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
    // Which outside service refused, for a gateway failure that was one: its
    // host and HTTP status, checked here because a ledger line is forever.
    ...(upstream && typeof upstream.host === "string" && /^[a-z0-9.-]{1,253}$/i.test(upstream.host)
      && Number.isSafeInteger(upstream.status)
      ? { upstream: { host: upstream.host.toLowerCase(), status: upstream.status } } : {}),
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

async function operatorMetricsText({ config, store, taskManager, runtimeManager, researchMemory, memoryIndexWorker, usageLedger, notificationService, documentParser, openList, productDatabase, operationalMetrics, activeCommands, memorySubstrate = null, runMetrics = null, imMetrics = null, webReader = null, sourceUpdates = null, edgeProxy = null, frontier = null, review = null, geo = null }) {
  const readiness = await readinessStatus(config, store, runtimeManager, researchMemory, memoryIndexWorker, usageLedger, notificationService, documentParser, openList, productDatabase, memorySubstrate, frontier, review, geo);
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
  // The index answers its own health endpoint from its own process, so "up"
  // says nothing about whether it can embed. A wrong model id, a revoked key or
  // a vector of the wrong width fails every write while `/health` keeps saying
  // ok: readiness stays green, the deployment pays for an index and gets term
  // matching, and the only trace is a field of the readiness body that nothing
  // scrapes. These two scrape it. The alternative on offer was
  // `MEMORY_INDEX_STRICT`, which turns a ranking outage into a product outage.
  const memoryIndex = readiness.checks.memoryIndex ?? {};
  addMetric(lines, "open_science_memory_index_writing",
    "Whether the recall index accepted the work last given to it (0 when the index worker's last job failed).",
    "gauge", {
      value: memoryIndex.worker?.lastError ? 0 : 1,
      labels: { provider: String(memoryIndex.provider ?? "builtin"), code: String(memoryIndex.worker?.lastError ?? "ok") },
    });
  addMetric(lines, "open_science_memory_recall_degraded",
    "Whether a recall last had to fall back to the term matcher because the index could not answer.",
    "gauge", {
      value: memoryIndex.recall?.lastError ? 1 : 0,
      labels: { code: String(memoryIndex.recall?.lastError ?? "none") },
    });
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
  // Web reading's outcomes and limits (webRead.mjs).
  for (const family of webReadMetricFamilies(webReader?.stats())) addMetric(lines, family.name, family.help, family.type, family.series);
  for (const family of sourceUpdateMetricFamilies(sourceUpdates?.stats())) addMetric(lines, family.name, family.help, family.type, family.series);
  for (const family of edgeMetricFamilies(edgeProxy)) addMetric(lines, family.name, family.help, family.type, family.series);
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
  if (runMetrics) lines.push(...runMetrics.lines());
  // The IM module's counters (inbound, dispatches, card updates, pushes,
  // refusals), by kind. Absent when the module is not composed.
  if (imMetrics) {
    addMetric(lines, "open_science_im_events_total", "IM module events by kind (Feishu inbound, dispatches, card updates, pushes).",
      "counter", imMetrics());
  }
  // 「前沿动态」: pull results, lag, entries by state, today's items, the
  // number check's outcomes, the budget, unknown vocabulary, the plugin's
  // contract (frontierService.mjs `frontierMetricFamilies`).
  const frontierSnapshot = frontier ? await frontierMetricsSnapshot(frontier) : null;
  for (const family of frontierMetricFamilies(Boolean(frontier), frontierSnapshot)) addMetric(lines, family.name, family.help, family.type, family.series);
  // 循证 GEO: `open_science_geo_enabled 0` when off (geoService.mjs `geoMetricFamilies`).
  const geoSnapshot = geo ? await geoMetricsSnapshot(geo) : null;
  for (const family of geoMetricFamilies(Boolean(geo), geoSnapshot)) addMetric(lines, family.name, family.help, family.type, family.series);
  // The independent reviewer: reviews, findings by kind, answers, reply
  // checks and safety alerts (reviewService.mjs `reviewMetricFamilies`).
  for (const family of reviewMetricFamilies(Boolean(review), review ? review.service.stats() : null)) addMetric(lines, family.name, family.help, family.type, family.series);
  // Refusals by model provider and status; 402 is an exhausted balance and
  // pages (providerRefusals.mjs, alert ModelProviderBalanceExhausted).
  const refusals = providerRefusalMetricFamily();
  addMetric(lines, refusals.name, refusals.help, refusals.type, refusals.series);

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

async function readinessStatus(config, store, runtimeManager, researchMemory = null, memoryIndexWorker = null, usageLedger = null, notificationService = null, documentParser = null, openList = null, productDatabase = null, memorySubstrate = null, frontier = null, review = null, geo = null) {
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
    memory: await readinessCheck(async () => readinessMemory(researchMemory, config)),
    memoryIndex: await readinessCheck(async () => readinessMemoryIndex(config, memorySubstrate, memoryIndexWorker)),
    usageLedger: await readinessCheck(async () => readinessUsageLedger(config, usageLedger)),
    inbox: await readinessCheck(async () => readinessInbox(config, notificationService)),
    documentParser: await readinessCheck(async () => readinessDocumentParser(config, documentParser)),
    openList: await readinessCheck(async () => readinessOpenList(config, openList)),
    relationalIntegrity: await readinessCheck(async () => readinessRelationalIntegrity(config, productDatabase)),
    security: await readinessCheck(() => readinessSecurity(config)),
    observability: await readinessCheck(() => readinessObservability(config)),
    evimedAdapters: await readinessCheck(() => readinessEviMedAdapters(config)),
    scienceConnectors: await readinessCheck(() => readinessScienceConnectors(config)),
    publicSourceCredentials: await readinessCheck(() => publicSourceCredentialReadiness(config)),
    modelGateway: await readinessCheck(() => readinessModelGateway(config)),
    release: await readinessCheck(() => readinessRelease(config)),
    resources: await readinessCheck(() => readinessResources(config)),
    backup: await readinessCheck(async () => readinessBackup(config, productDatabase)),
    runtime: await readinessCheck(async () => readinessRuntime(config, runtimeManager)),
    // 「前沿动态」: red only for the module's own invariants; a plugin outside
    // the platform that cannot be reached is a warning on a green check.
    frontier: await readinessCheck(async () => frontierReadiness({ config, frontier, database: productDatabase })),
    // The independent reviewer: red only for its own invariants (reviewService.mjs).
    review: await readinessCheck(async () => (review ? review.service.readiness() : config.reviewEnabled
      ? Promise.reject(readinessFailure("review_unavailable", { reason: productDatabase ? "not_composed" : "no_product_database" }))
      : { required: false, enabled: false })),
    // 循证 GEO: red only for its own invariants (geoService.mjs `geoReadiness`).
    geo: await readinessCheck(async () => withGeoWorkerWarnings(await geoReadiness({ config, geo, database: productDatabase }), geo?.worker ?? null)),
  };
  checks.saasProfile = await readinessCheck(() => readinessSaasProfile(config, checks));
  return {
    ok: Object.values(checks).every((check) => check.ok),
    checks,
  };
}

/** The parser is the parser team's own service. Required means configured and
 *  answering healthy. A key is not part of it: the service answers without one
 *  (measured 2026-09-22 — parse and extract both 200 with no Authorization
 *  header), and one is sent only if the deployment has a key file with
 *  something in it. Until then readiness demanded a key the service does not
 *  ask for, so production switched the check off and the parser's health went
 *  unwatched, and `authenticated: false` read as "cannot parse" — it never
 *  meant that. `credential` says what is sent, `none` or `file`. */
async function readinessDocumentParser(config, parser) {
  const credential = config.documentParserToken ? "file" : "none";
  if (!config.requireDocumentParser) {
    return { required: false, configured: Boolean(config.documentParserUrl), credential };
  }
  if (config.documentParserTokenError) throw readinessFailure(config.documentParserTokenError);
  if (!config.documentParserUrl || !parser) throw readinessFailure("document_parser_unconfigured");
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
  // The audit registers the research-memory tables, and the store creates them
  // lazily on its first query. Migrating here means the audit meets a schema
  // that exists rather than a missing table it would have to be taught to
  // tolerate — a tolerance that then hides a genuinely dropped table.
  await migrateResearchMemory(database);
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

/** Whether research memory can be read and written.
 *
 * There is no requirement flag any more: the store is a schema of the
 * control-plane database, so it exists exactly when that database does. A
 * deployment with none — local development on the file-backed state store — has
 * no research memory at all, which is a configuration rather than a fault and
 * says so as `required: false`. A store that exists and cannot answer IS a
 * fault, because every recall and every extraction goes through it. */
/** Whether the memory store answers, and whether recall is on at all
 *  (`OPEN_SCIENCE_MEMORY_RECALL_ENABLED`). The switch is reported with the
 *  store rather than as a check of its own: an evaluation keeps `/api/ready`
 *  verbatim, and "memory off" has to be readable there as a setting, not
 *  inferred from runs that happened to recall nothing. */
async function readinessMemory(researchMemory, config) {
  const recallEnabled = config?.memoryRecallEnabled !== false;
  if (!researchMemory?.configured) return { required: false, configured: false, recallEnabled };
  const status = await researchMemory.status();
  if (!status.connected) {
    throw readinessFailure(status.code ?? "memory_unavailable", {
      configured: Boolean(status.configured),
      connected: false,
      recallEnabled,
    });
  }
  return { required: true, connected: true, recallEnabled };
}

/** Which component ranks a recall, whether it can be reached, and what the
 *  capsule index worker is doing.
 *
 * One check rather than two, because there is one index: research recall and
 * capsule recall address the same OpenViking, and an operator reading two rows
 * that can only ever agree learns nothing from the second.
 *
 * Reported, not required, by default. A deployment whose index is down still
 * answers — research recall falls back to the term matcher and capsule recall to
 * the lexical search — so failing readiness would take a working product offline
 * over a degraded one. `OPEN_SCIENCE_MEMORY_INDEX_STRICT` is the operator's
 * statement that they would rather see the failure, and it is the same switch
 * that makes those recalls fail instead of degrade. */
async function readinessMemoryIndex(config, substrate, worker) {
  const required = Boolean(config.memoryIndexStrict);
  const status = substrate
    ? await substrate.status()
    : { provider: "builtin", configured: false, connected: false, code: "memory_index_client_missing" };
  // The reranker rides this check rather than one of its own: it improves the
  // order this provider produced, and it is off unless a key is configured.
  // Reported because "off" and "misconfigured" are indistinguishable from the
  // outside — an unreadable key file leaves recall working, in vector order,
  // with nothing anywhere saying the reranker was never asked.
  //
  // A reranker only ever runs behind a provider that ranks: research recall
  // reranks inside the index arm, and on `builtin` the capsule index is not
  // built at all. So a key configured on a term-matcher deployment is reported
  // as not reached rather than as on, because a row that reads "configured"
  // where nothing reranks is exactly the third state this report exists to
  // keep out.
  const rerankStatus = typeof substrate?.rerank?.status === "function" ? substrate.rerank.status() : null;
  const rerank = !rerankStatus
    ? null
    : substrate?.active
      ? { configured: rerankStatus.configured, code: config.dashscopeApiKeyError ?? rerankStatus.code ?? null }
      : { configured: false, code: "memory_rerank_not_reached" };
  // Why this provider: every memory evaluation recorded `builtin` from a
  // deployment whose compose file said `openviking`, and the bare name could
  // not tell a pin from an accident (E §10.5). `indexConfigured` beside a
  // `builtin` provider is the pin, visible.
  const selection = substrate?.selection ?? null;
  const details = {
    required,
    provider: status.provider,
    ...(selection ? { providerSource: selection.source, indexConfigured: selection.indexConfigured } : {}),
    configured: Boolean(status.configured),
    connected: Boolean(status.connected),
    ...(status.code ? { code: status.code } : {}),
    ...(worker ? { worker: worker.status() } : {}),
    ...(rerank ? { rerank } : {}),
    // Whether recall has had to answer without the index. It is the one symptom
    // of "up but refusing" that the reader of a recall can observe, and it was
    // computed and then kept to itself.
    ...(substrate?.lastError ? { recall: { lastError: substrate.lastError } } : {}),
  };
  if (required && !(status.configured && status.connected)) {
    throw readinessFailure(status.code ?? "memory_index_unavailable", details);
  }
  return details;
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
    "rateLimitWindowMs",
    "rateLimitMaxRequests",
    "authRateLimitWindowMs",
    "authRateLimitMaxRequests",
    "commandRateLimitWindowMs",
    "commandRateLimitMaxRequests",
    "maxConcurrentCommands",
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
    "runtimeIdleYieldAfterMs",
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
  if (usesDockerRuntime) {
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

async function inspectRuntimeImage(config, runtimeManager) {
  let imageId;
  let kernelVersion;
  let uvVersion;
  if (runtimeManager.usesRuntimeController()) {
    let image;
    try {
      image = await runtimeManager.inspectRuntimeImage();
    } catch (error) {
      throw readinessFailure(error?.code ?? "runtime_image_unavailable");
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
    if (image.status !== 0) throw readinessFailure("runtime_image_unavailable");
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
  // The threshold and the request-size guard are what a launched runtime is
  // given (runtimeCompactionSettings), read back here so a lever set in .env
  // can be seen to have reached the launch plan.
  const compaction = runtimeCompactionSettings(config);
  const kernel = {
    kernel: RUNTIME_KERNEL_NAME,
    kernelVersion: config.dshVersion,
    compactionPolicy: config.runtimeCompactionPolicy,
    compactionThresholdRatio: compaction.config.thresholdRatio,
    compactionMaxRequestBytes: compaction.maxRequestBytes,
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
  // rt: an AgentBay deployment has no container on this host and no runtime
  // controller to ask; its provider states what it needs (plan §3.1 #1).
  if (config.runtimeProvider === "agentbay") {
    try {
      return { mode: "kernel", ...(await runtimeManager.provider.readiness()), ...kernel };
    } catch (error) {
      throw readinessFailure(error?.code ?? "agentbay_unconfigured");
    }
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
      const image = await inspectRuntimeImage(config, runtimeManager);
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

async function serveStatic(req, res, config, pathname) {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  let candidate = await staticFileCandidate(config.staticDir, rel);
  if (!candidate || candidate.stat.isDirectory()) {
    // A build file is that file or nothing. A release renames every hashed
    // chunk, and a tab opened before it still asks for the old names: answered
    // with index.html (200, text/html), the browser refused the page's code on
    // its MIME type and the router swapped the whole shell for its English
    // error page (2026-09-23 plan §2.1). A 404 is what the shell's reload-once
    // handler expects. Every other path keeps the single-page fallback, and the
    // rule is the directory rather than a file extension, because routes such
    // as /app/runs/:id/files/deliverables/report.md end in one.
    if (rel === "assets" || rel.startsWith("assets/")) {
      throw new HttpError(404, "not_found", "Static asset not found.");
    }
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
