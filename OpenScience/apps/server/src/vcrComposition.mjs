/**
 * 「虚拟临研」, composed: the seven packages joined into the one object the
 * control plane registers (build plan 2026-09-28 §11.2, build contract §2).
 *
 * Hidden knowledge:
 *
 * - **One line in `createWebApiApp`, everything else here.** The core never
 *   imports a feature module (the layer-2 rule), and seven packages built in
 *   parallel each own their own file. This is the only place that knows all of
 *   them, so a package added later is a row in this file rather than a change
 *   to the server.
 * - **The adapters exist because the packages were written against each
 *   other's ideas, not each other's code.** The service asks its data-plane
 *   package for `tab`, `note`, `runtimeProfile` and `suppressSmallCells`; the
 *   data-plane package publishes a snapshot API and a pure suppression
 *   function. Rather than edit either side into the other's shape — two
 *   packages that would then have to be merged together forever — the seam is
 *   named and kept here, where a mismatch is one function wide. The
 *   suppression adapter is the one that matters: `suppressSmallCells` answers
 *   `{ aggregate, suppression }`, and a caller that forwarded that whole
 *   object would hand a model a wrapper it does not understand *and* lose the
 *   suppression it asked for.
 * - **A package that is off is absent, not broken.** With no data-plane
 *   directory configured, `dataPlane` is null and every tier above T0 answers
 *   「数据平面未接入」 by name (the service's own `unavailable` shape); with no
 *   engine URL, `engine` is null and the deterministic steps say so. Nothing
 *   here throws because a deployment is partial — the conversation and the
 *   evidence work carry on (plan §10.5).
 * - **The module composes only with a product database.** Like GEO: the
 *   schema is the module, and a deployment without PostgreSQL answers 404
 *   `vcr_not_enabled` on every route rather than half-running.
 * - **The routes are handed the module's own store, not the platform's.**
 *   `composeVcr` returns `store` (the study side of the schema) and the
 *   routes' data calls — roles, assumptions, reviews, decisions, exports,
 *   members — go there. The platform's store is for the session and the CSRF
 *   check; handing it to both was the defect the review of 2026-09-29 named
 *   first (CS-1).
 * - **An engine that would answer anybody is not composed.** With the engine's
 *   URL set and its token or receipt key missing, unreadable or short, the
 *   client is not created and readiness says why (`vcrEngineStatus`): a
 *   deployment that reaches an unauthenticated engine, or accepts a result no
 *   key signed, has a number nobody can vouch for.
 * - **Metrics beside GEO's, in the platform's prefix.** `vcrMetricFamilies`
 *   reads a snapshot (`vcrMetricsSnapshot`) and answers `open_science_vcr_*`
 *   families in `addMetric`'s shape, queue gauges included: a study waiting
 *   on the budget confirmation, the second human stop, is a queue an operator
 *   must be able to see.
 *
 * @module vcrComposition
 */

import { createHash } from "node:crypto";

import { VCR_MIN_CELL_SIZE, VCR_ENGINE_PROTOCOL_VERSION, canonicalScenarioJson, vcrResultOutputPayload } from "@evimed/domain";

import { VcrAccess } from "./vcrAccess.mjs";
import { VcrDataPlane, suppressSmallCells as suppressCells } from "./vcrDataPlane.mjs";
import { VcrDataStore } from "./vcrDataStore.mjs";
import { createVcrEngineClient } from "./vcrEngineClient.mjs";
import { createVcrEvidencePipeline } from "./vcrEvidence.mjs";
import { VcrEvidenceStore } from "./vcrEvidenceStore.mjs";
import { VcrJobs } from "./vcrJobs.mjs";
import { createVcrContact } from "./vcrContact.mjs";
import { VcrMatchStore } from "./vcrMatchStore.mjs";
import { VcrMembers } from "./vcrMembers.mjs";
import { createVcrSeal } from "./vcrSeal.mjs";
import { VcrService } from "./vcrService.mjs";
import { VcrStore } from "./vcrStore.mjs";
import { createTrialRegistryClient } from "./trialRegistryClient.mjs";
import {
  candidateReferrals, referralFunnel, screenFailuresByCriterion, siteProfileStatus,
} from "./vcrRecruit.mjs";
import {
  admissibleFacts, eligibilityCounts, evaluateCriterion, factsVisibleAt, summarizeEligibility,
} from "./vcrMatching.mjs";

/**
 * The data-plane seam the service reads through: the page's tab, the one-line
 * note it shows when the plane is not configured, the profile a model may see,
 * and the suppression every aggregate leaving the gateway passes through.
 *
 * @param {{ dataPlane: VcrDataPlane, dataStore: VcrDataStore, access: VcrAccess }} parts
 */
export function vcrDataPlaneSeam({ dataPlane, dataStore, access }) {
  return {
    /** @param {any} study @param {{ id: string }} user */
    async tab(study, user) {
      const decision = await access.judge({
        studyId: study.id, actor: user.id, ability: "read", purpose: "page",
      }).catch(() => ({ allowed: false, code: "vcr_access_unavailable" }));
      if (!decision.allowed) {
        const refusal = /** @type {any} */ (decision);
        return { available: false, unavailable: { code: refusal.code, message: refusal.reasonZh ?? refusal.reason ?? "" } };
      }
      const [sources, snapshots] = await Promise.all([
        dataStore.listSources({ userId: study.userId, studyId: study.id }).catch(() => []),
        dataStore.listSnapshots({ studyId: study.id }).catch(() => []),
      ]);
      // No filesystem path of the server leaves through this page: a location
      // is the data plane's own business, and a reader of the tab needs the
      // source and the snapshot, not where the bytes sit (CS-49).
      return {
        available: true,
        sources,
        snapshots: snapshots.map((snapshot) => ({
          id: snapshot.id, sourceId: snapshot.sourceId, version: snapshot.version, sha256: snapshot.sha256,
          rowCount: snapshot.rowCount, columnCount: snapshot.columnCount, frozenAt: snapshot.frozenAt,
          sealedFields: snapshot.sealedFields ?? [], sealedUntil: snapshot.sealedUntil ?? null,
          quality: snapshot.quality ?? null,
        })),
      };
    },
    /** The one sentence a study at T0 sees where no data plane is configured. */
    async note(study) {
      if (dataPlane.root()) return { available: true, tier: study.dataTier };
      return { available: false, code: "vcr_data_plane_unconfigured", message: "本部署未接入数据平面；T0 档（公开资料）的全部步骤照常。" };
    },
    /** What a model may read of a snapshot: structure, quality, aggregates — never a row. */
    async runtimeProfile(study, filter) {
      const snapshotId = String(filter?.snapshotId ?? "");
      if (!snapshotId) return { available: false, code: "vcr_snapshot_not_named" };
      const profile = await dataPlane.snapshotProfileForModel({ snapshotId });
      return { available: true, ...profile };
    },
    /**
     * The suppression every aggregate leaving the gateway passes through.
     *
     * This adapter is the seam: `suppressSmallCells` answers
     * `{ aggregate, suppression }`, and the service forwards what it is given
     * straight to a model — so a caller that passed the wrapper through would
     * hand the model a shape it does not understand and, worse, would look
     * exactly like suppression having happened. Here the aggregate is
     * unwrapped and the report ridealong is attached only when something was
     * actually withheld, so a reader is told rather than shown a hole.
     * @param {any} aggregate
     */
    suppressSmallCells(aggregate) {
      const { aggregate: safe, suppression } = suppressCells(aggregate, { minCellSize: VCR_MIN_CELL_SIZE });
      return suppression.cellsSuppressed > 0 ? { ...safe, suppression } : safe;
    },
  };
}

/**
 * What a result from the control plane's own executor names as its "package
 * lock": there is no R library here, so the lock is the executor itself — a
 * fixed digest of its name, present because a manifest without one is not a
 * manifest, and never all zeros, which the contract refuses.
 */
const LOCAL_EXECUTOR_LOCK_HASH = createHash("sha256").update("evimed-control-plane:matching.evaluate:1.0.0").digest("hex");

/**
 * The one method the job queue runs in the control plane rather than in
 * `vcr-engine`: a three-valued eligibility verdict is deterministic, cheap and
 * needs the facts the data plane holds, so shipping it to a container would
 * buy nothing and cost a data crossing. Everything else goes to the engine.
 *
 * @param {{ matchStore: VcrMatchStore }} parts
 */
export function vcrMatchingExecutor({ matchStore }) {
  /** @param {{ job: Record<string, any>, onProgress: (progress: { done: number, total: number }) => Promise<unknown> }} input */
  return async ({ job, onProgress }) => {
    const startedAt = new Date().toISOString();
    const scenario = job?.scenario ?? {};
    const asOf = scenario.asOf ? new Date(scenario.asOf) : new Date();
    const criteria = Array.isArray(scenario.criteria) && scenario.criteria.length
      ? scenario.criteria
      : await matchStore.listCriteria({ studyId: String(job.studyId), protocolVersionId: scenario.protocolVersionId ?? null });
    const subjects = Array.isArray(scenario.subjects) ? scenario.subjects : [];
    const summaries = [];
    let done = 0;
    for (const subject of subjects) {
      // Both halves come back: a fact voided by the span check is a measurable
      // event, and dropping it silently would hide the extraction's error rate
      // (AC-36 counts it).
      const { facts, voided } = admissibleFacts(factsVisibleAt(subject.facts ?? [], asOf), { documents: subject.documents ?? {}, asOf });
      const judgments = criteria.map((criterion) => evaluateCriterion(criterion, { facts, asOf: asOf.getTime(), subject }));
      summaries.push({ subjectKey: String(subject.subjectKey ?? ""), summary: summarizeEligibility(judgments),
        counts: eligibilityCounts(judgments), judgments, voidedFacts: voided });
      done += 1;
      if (done % 10 === 0) await onProgress({ done, total: subjects.length });
    }
    await onProgress({ done, total: subjects.length });
    const tally = summaries.reduce((acc, row) => { acc[row.summary] = (acc[row.summary] ?? 0) + 1; return acc; }, /** @type {Record<string, number>} */({}));
    // Deterministic tallies, not a score: how many subjects each summary
    // holds, and nothing a model produced (plan §7.1). Each says where it came
    // from — counted by code (`calculated`) — and the result carries what a
    // result of any method carries (contract §3.4): a conclusion, the echo of
    // the frozen job, and the hash of its own output.
    const scenarioHash = /^[a-f0-9]{64}$/.test(String(job.scenarioHash ?? ""))
      ? String(job.scenarioHash)
      : createHash("sha256").update(canonicalScenarioJson(scenario)).digest("hex");
    /** @type {Record<string, any>} */
    const result = {
      jobId: String(job.id ?? job.jobId ?? ""), protocolVersion: VCR_ENGINE_PROTOCOL_VERSION, status: "succeeded",
      method: "matching.evaluate", methodVersion: "1.0.0", scenarioHash, seed: Number(job.seed ?? 0), replicates: null,
      conclusion: "estimable",
      counts: { realPatients: subjects.length, events: null, effectiveSampleSize: null, generatedRecords: 0 },
      measures: Object.entries(tally).map(([name, value]) => ({ name, value, simulated: false, source: "calculated" })),
      diagnostics: { criteria: criteria.length, subjects: subjects.length, asOf: asOf.toISOString() },
      tables: [],
      assessments: summaries,
      manifest: {
        engineVersion: "control-plane", rVersion: `node ${process.version}`, packageLockHash: LOCAL_EXECUTOR_LOCK_HASH,
        startedAt, finishedAt: new Date().toISOString(), cpuSeconds: 0,
      },
    };
    result.manifest.outputHash = createHash("sha256").update(vcrResultOutputPayload(result)).digest("hex");
    return result;
  };
}

/**
 * The matching seam: the page's tab and the runtime's read. Both are built
 * from package E's store and its pure judgments — E publishes functions on
 * purpose (a verdict is not a service), so the object the service reads
 * through is assembled here.
 *
 * @param {{ matchStore: VcrMatchStore, store: VcrStore }} parts
 */
export function vcrMatchingSeam({ matchStore, store }) {
  return {
    /** @param {any} study */
    async tab(study) {
      const protocol = await store.latestProtocolVersion(study.id).catch(() => null);
      const [criteria, assessments, referrals, sites] = await Promise.all([
        protocol ? matchStore.listCriteria({ studyId: study.id, protocolVersionId: protocol.id }).catch(() => []) : [],
        matchStore.listAssessments({ studyId: study.id, limit: 100 }).catch(() => []),
        matchStore.listReferrals({ studyId: study.id }).catch(() => []),
        matchStore.listSites(study.id).catch(() => []),
      ]);
      const funnelRows = await matchStore.siteFunnel(study.id).catch(() => []);
      return {
        available: true,
        protocol,
        criteria,
        assessments: assessments.map((assessment) => ({
          ...assessment,
          counts: assessment.counts ?? eligibilityCounts(assessment.judgments ?? []),
        })),
        candidates: candidateReferrals({ studyId: study.id, assessments }),
        // The ledger's own rows, ids included: the contact stop is asked of a
        // referral (`POST …/referrals/:id/contact`), and a candidate that is only
        // an assessment has no id to ask it of.
        referrals: referrals.slice(0, 200),
        funnel: referralFunnel(referrals),
        screenFailures: screenFailuresByCriterion(referrals, criteria),
        sites: sites.map((site) => ({ ...site, verification: siteProfileStatus(site) })),
        siteFunnel: funnelRows,
      };
    },
    /** What a run may read: judgments and their evidence, never a chart. */
    async runtimeRead(study, filter) {
      const what = String(filter?.what ?? "assessments");
      if (what === "criteria") {
        const protocol = await store.latestProtocolVersion(study.id).catch(() => null);
        if (!protocol) return { criteria: [] };
        return { criteria: await matchStore.listCriteria({ studyId: study.id, protocolVersionId: protocol.id }) };
      }
      if (what === "referrals") {
        return { referrals: await matchStore.listReferrals({ studyId: study.id, state: filter?.state ?? null, limit: 200 }) };
      }
      const assessments = await matchStore.listAssessments({
        studyId: study.id, summary: filter?.summary ?? null, subjectKey: filter?.subjectKey ?? null, limit: 100,
      });
      return { assessments };
    },
  };
}

/**
 * Whether the engine is composed, and if it is not, why — never the secret.
 * `configured` is what decides whether a client is made; `reason` is one of
 * `not_configured` (no URL: the module simply has no engine, which is a valid
 * deployment), or a secret file's own failure code (`vcr_engine_token_file_short`,
 * `vcr_engine_receipt_key_file_unavailable`, …), or `vcr_engine_secret_missing`
 * when the URL is set and no file was named.
 * @param {Record<string, any>} config
 * @returns {{ configured: boolean, reason: string | null }}
 */
export function vcrEngineStatus(config) {
  if (!String(config?.vcrEngineUrl ?? "").trim()) return { configured: false, reason: "not_configured" };
  const error = config.vcrEngineTokenError || config.vcrEngineReceiptKeyError || null;
  if (error) return { configured: false, reason: String(error) };
  if (!config.vcrEngineToken || !config.vcrEngineReceiptKey) return { configured: false, reason: "vcr_engine_secret_missing" };
  return { configured: true, reason: null };
}

/**
 * Readiness with the engine's reason added when it is set but not composed. The
 * base check (`vcrReadiness`) says the engine is missing; this says why, so an
 * operator who set the URL and forgot a mount is told which one.
 * @param {any} readiness @param {Record<string, any>} config
 */
export function withVcrEngineWarnings(readiness, config) {
  if (!readiness || readiness.enabled === false) return readiness;
  const status = vcrEngineStatus(config);
  if (status.configured || status.reason === "not_configured") return readiness;
  const warnings = [...new Set([...(readiness.warnings ?? []), "vcr_engine_unconfigured"])];
  return { ...readiness, engine: "unconfigured", engineReason: status.reason, warning: readiness.warning ?? warnings[0], warnings };
}

/**
 * Delete one job's directory from the engine's work volume: `DELETE /jobs/:id`,
 * best effort. Answers `null` when the engine is not composed, so a caller
 * asks it without checking. A job the engine does not know (404) is deleted.
 * @param {{ config: Record<string, any>, fetchImpl?: typeof fetch }} input
 * @returns {((jobId: string) => Promise<void>) | null}
 */
export function createVcrEngineJobRemover({ config, fetchImpl }) {
  if (!vcrEngineStatus(config).configured) return null;
  const origin = String(config.vcrEngineUrl).replace(/\/$/, "");
  const call = fetchImpl ?? globalThis.fetch;
  return async (jobId) => {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(jobId)) return;
    const response = await call(`${origin}/jobs/${encodeURIComponent(jobId)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${config.vcrEngineToken}` },
      signal: AbortSignal.timeout(Math.min(30_000, Number(config.vcrEngineTimeoutMs) || 30_000)),
    });
    if (!response.ok && response.status !== 404) throw new Error(`vcr_engine_delete_${response.status}`);
  };
}

/**
 * Compose the module, or answer `null` where it is off.
 *
 * @param {{
 *   config: Record<string, any>,
 *   productDatabase: any,
 *   audit?: (event: string, status: string, details: Record<string, any>) => Promise<unknown>,
 *   fetchImpl?: typeof fetch,
 *   report?: (code: string) => void,
 * }} input
 */
export function composeVcr({ config, productDatabase, audit = async () => {}, fetchImpl, report = () => {} }) {
  if (!config?.vcrEnabled || !productDatabase) return null;

  const store = new VcrStore({ database: productDatabase });
  const dataStore = new VcrDataStore({ database: productDatabase });
  const matchStore = new VcrMatchStore({ database: productDatabase });
  const evidenceStore = new VcrEvidenceStore({ database: productDatabase });

  const access = new VcrAccess({ store: dataStore });
  const members = new VcrMembers({ store: dataStore, access });
  const contact = createVcrContact({ store: matchStore });
  const dataPlane = String(config.vcrDataPlaneDir ?? "").trim()
    ? new VcrDataPlane({ store: dataStore, config })
    : null;

  const engineStatus = vcrEngineStatus(config);
  const engine = engineStatus.configured
    ? createVcrEngineClient({
      baseUrl: config.vcrEngineUrl, timeoutMs: config.vcrEngineTimeoutMs,
      token: config.vcrEngineToken,
      receiptKey: config.vcrEngineReceiptKey,
      fetchImpl: fetchImpl ?? globalThis.fetch,
    })
    : null;
  if (!engine && engineStatus.reason && engineStatus.reason !== "not_configured") report(engineStatus.reason);
  const removeEngineJob = createVcrEngineJobRemover({ config, fetchImpl });

  const jobs = new VcrJobs({
    store, config, engine, report,
    localExecutors: { "matching.evaluate": vcrMatchingExecutor({ matchStore }) },
  });
  // The seal takes the narrow port it actually uses (`sealFields`), not the
  // whole data plane: it is what withholds the columns, and nothing else of
  // the plane is the seal's business.
  const seal = createVcrSeal({
    store,
    dataPlane: dataPlane
      ? { sealFields: (/** @type {any} */ input) => dataPlane.sealFields({
        snapshotId: String(input.snapshotId ?? ""), fields: [...(input.fields ?? [])],
        until: input.until ?? undefined, actor: String(input.actor ?? "orchestrator"), reason: input.reason ?? "analysis plan frozen",
      }) }
      : null,
    audit: (event, status, details) => store.audit({ action: event, outcome: status, detail: details }),
  });
  const registry = createTrialRegistryClient({ fetchImpl: fetchImpl ?? globalThis.fetch });
  const evidence = createVcrEvidencePipeline({ store: evidenceStore, registry, jobs });

  const matching = vcrMatchingSeam({ matchStore, store });
  const dataPlaneSeam = dataPlane ? vcrDataPlaneSeam({ dataPlane, dataStore, access }) : null;

  const service = new VcrService({
    store, config, engine, access, dataPlane: dataPlaneSeam, evidence, matching, jobs, seal, matchStore, evidenceStore,
  });

  return {
    store, dataStore, matchStore, evidenceStore,
    access, members, contact, dataPlane, dataPlaneSeam, engine, engineStatus, removeEngineJob, jobs, seal, evidence, matching, registry, service,
    // Composed later, beside the other modules' workers (server.mjs).
    notifier: null, orchestrator: null, worker: null, exporter: null,
    audit,
  };
}

/**
 * What the metrics read: the schema's queue and study counts and the counters
 * each part keeps, in one snapshot. `tables` is `null` when the schema did not
 * answer — the gauges are then absent and `tables_readable` says so, rather
 * than reading as zero.
 * @param {any} vcr the composed module
 */
export async function vcrMetricsSnapshot(vcr) {
  /** @type {{ jobs: Record<string, number>, studies: number, active: number } | null} */
  let tables = null;
  try {
    const [jobs, studies] = await Promise.all([
      vcr.store.rows(`SELECT state, count(*)::int AS n FROM evimed_vcr.jobs
        WHERE state IN ('queued', 'running', 'awaiting_budget') GROUP BY state`),
      vcr.store.one(`SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'active')::int AS active
        FROM evimed_vcr.studies WHERE deleted_at IS NULL`),
    ]);
    tables = {
      jobs: Object.fromEntries(jobs.map((/** @type {any} */ row) => [String(row.state), Number(row.n)])),
      studies: Number(studies?.total ?? 0), active: Number(studies?.active ?? 0),
    };
  } catch {
    tables = null;
  }
  return {
    tables,
    service: vcr.service?.counters ?? {},
    jobs: vcr.jobs?.status?.() ?? null,
    orchestrator: vcr.orchestrator?.status?.() ?? null,
    worker: vcr.worker?.status?.() ?? null,
    engine: vcr.engineStatus ?? null,
  };
}

/**
 * The module's metric families, `open_science_vcr_*`, in the shape
 * `addMetric` takes. Off, it is the one gauge that says so.
 * @param {boolean} enabled @param {Awaited<ReturnType<typeof vcrMetricsSnapshot>> | null} snapshot
 */
export function vcrMetricFamilies(enabled, snapshot) {
  /** @type {{ name: string, help: string, type: "gauge" | "counter", series: { value: number, labels?: Record<string, string> }[] }[]} */
  const families = [{ name: "open_science_vcr_enabled", help: "Whether the 虚拟临研 module is composed in this process.", type: "gauge",
    series: [{ value: enabled && snapshot ? 1 : 0 }] }];
  if (!enabled || !snapshot) return families;
  /** @param {string} name @param {string} help @param {"gauge" | "counter"} type @param {{ value: number, labels?: Record<string, string> }[]} series */
  const add = (name, help, type, series) => families.push({ name: `open_science_vcr_${name}`, help, type, series });
  add("tables_readable", "Whether the module's tables answered the metrics read.", "gauge", [{ value: snapshot.tables ? 1 : 0 }]);
  if (snapshot.tables) {
    add("studies", "Studies by state (not deleted).", "gauge", [
      { labels: { state: "all" }, value: snapshot.tables.studies },
      { labels: { state: "active" }, value: snapshot.tables.active },
    ]);
    add("jobs", "Compute jobs waiting or running, by state; awaiting_budget is the second human stop.", "gauge",
      ["queued", "running", "awaiting_budget"].map((state) => ({ labels: { state }, value: snapshot.tables?.jobs[state] ?? 0 })));
  }
  add("engine_configured", "Whether the compute engine is composed (URL set and both secrets readable).", "gauge",
    [{ value: snapshot.engine?.configured ? 1 : 0 }]);
  add("service_total", "What the service did since this process started.", "counter",
    ["studiesCreated", "reads", "writes", "writeIssues", "notFound", "tabs"].map((kind) => ({
      labels: { kind }, value: Number(/** @type {any} */ (snapshot.service)[kind] ?? 0) })));
  if (snapshot.jobs?.counters) {
    add("jobs_total", "What the job queue did since this process started.", "counter",
      Object.entries(snapshot.jobs.counters).map(([outcome, value]) => ({ labels: { outcome }, value: Number(value) })));
  }
  if (snapshot.orchestrator?.counters) {
    add("orchestrator_total", "What the orchestrator did since this process started.", "counter",
      Object.entries(snapshot.orchestrator.counters).map(([kind, value]) => ({ labels: { kind }, value: Number(value) })));
  }
  const loops = Object.entries(snapshot.worker?.loops ?? {}).filter(([, loop]) => loop?.wired);
  if (loops.length) {
    add("loop_last_ok_timestamp_seconds", "When each 虚拟临研 worker loop last finished without an error (Unix seconds; 0 = not since this process started).",
      "gauge", loops.map(([loop, state]) => ({ labels: { loop }, value: state.lastOkAt ? Math.floor(Date.parse(state.lastOkAt) / 1000) : 0 })));
    add("loop_stalled", "Whether a 虚拟临研 worker loop is still running past its lease (OPEN_SCIENCE_VCR_LEASE_MS).", "gauge",
      loops.map(([loop, state]) => ({ labels: { loop }, value: state.stalled ? 1 : 0 })));
  }
  return families;
}
