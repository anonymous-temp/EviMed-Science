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
 *
 * @module vcrComposition
 */

import { VCR_MIN_CELL_SIZE } from "@evimed/domain";

import { VCR_ENGINE_PROTOCOL_VERSION } from "@evimed/domain";

import { VcrAccess } from "./vcrAccess.mjs";
import { VcrDataPlane, suppressSmallCells as suppressCells } from "./vcrDataPlane.mjs";
import { VcrDataStore } from "./vcrDataStore.mjs";
import { createVcrEngineClient } from "./vcrEngineClient.mjs";
import { createVcrEvidencePipeline } from "./vcrEvidence.mjs";
import { VcrEvidenceStore } from "./vcrEvidenceStore.mjs";
import { VcrJobs } from "./vcrJobs.mjs";
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
      return {
        available: true,
        root: dataPlane.root(),
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
    return {
      jobId: String(job.id ?? job.jobId ?? ""), protocolVersion: VCR_ENGINE_PROTOCOL_VERSION, status: "succeeded",
      method: "matching.evaluate", methodVersion: "1.0.0", scenarioHash: String(job.scenarioHash ?? ""), seed: Number(job.seed ?? 0),
      counts: { realPatients: subjects.length, events: null, effectiveSampleSize: null, generatedRecords: 0 },
      // Deterministic tallies, not a score: how many subjects each summary
      // holds, and nothing a model produced (plan §7.1).
      measures: Object.entries(tally).map(([name, value]) => ({ name, value, simulated: false })),
      diagnostics: { criteria: criteria.length, subjects: subjects.length, asOf: asOf.toISOString() },
      tables: [],
      assessments: summaries,
      manifest: {
        engineVersion: "control-plane", rVersion: `node ${process.version}`, packageLockHash: "local",
        startedAt, finishedAt: new Date().toISOString(), cpuSeconds: 0,
      },
    };
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
  const dataPlane = String(config.vcrDataPlaneDir ?? "").trim()
    ? new VcrDataPlane({ store: dataStore, config })
    : null;

  const engine = String(config.vcrEngineUrl ?? "").trim()
    ? createVcrEngineClient({
      baseUrl: config.vcrEngineUrl, timeoutMs: config.vcrEngineTimeoutMs,
      token: config.vcrEngineToken || null,
      receiptKey: config.vcrEngineReceiptKey || null,
      fetchImpl: fetchImpl ?? globalThis.fetch,
    })
    : null;

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
    store, config, engine, access, dataPlane: dataPlaneSeam, evidence, matching, jobs, seal,
  });

  return {
    store, dataStore, matchStore, evidenceStore,
    access, members, dataPlane, dataPlaneSeam, engine, jobs, seal, evidence, matching, registry, service,
    // Composed later, beside the other modules' workers (server.mjs).
    notifier: null, orchestrator: null, worker: null, exporter: null,
    audit,
  };
}
