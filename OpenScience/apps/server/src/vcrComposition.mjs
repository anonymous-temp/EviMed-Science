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
 *   package for `tab`, `note` and `runtimeProfile`; the data-plane package
 *   publishes a snapshot API. Rather than edit either side into the other's
 *   shape — two packages that would then have to be merged together forever —
 *   the seam is named and kept here, where a mismatch is one function wide.
 * - **One boundary for what a model reads, and it is not here.** Small-cell
 *   suppression is the service's `runtimeRead` applying the domain's
 *   `suppressForModel` once, to every `what`; nothing in this file suppresses
 *   anything, and nothing a seam returns reaches a model without passing it.
 * - **Matching is a flow, and this file joins its ends.** A run writes located
 *   facts and answers to language-only criteria; the platform freezes the
 *   protocol's criteria and the instant into a `match_criteria` job; a local
 *   executor loads the facts and the documents **server-side by study** (never
 *   from the job's scenario, which a run could write); and when the job has
 *   finished a hook persists each subject's assessment, turns the candidates
 *   into referrals in `candidate` (the control plane, never the model) and tells
 *   the coordinators. The contact stop is not in this flow at all
 *   (`vcrContact.mjs`).
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
 *   URL set and its token missing, unreadable or short, the client is not
 *   created and readiness says why (`vcrEngineStatus`): a deployment that
 *   reaches an unauthenticated engine has a number nobody can vouch for. The
 *   receipt key is the other secret and is not like that: a receipt is our own
 *   evidence, so a key that is configured and unusable is a failed readiness
 *   check and a log line, and the engine stays composed on the output-hash
 *   check that always runs (`verifyVcrReceipt`, recorded `signed: false`).
 * - **Metrics beside GEO's, in the platform's prefix.** `vcrMetricFamilies`
 *   reads a snapshot (`vcrMetricsSnapshot`) and answers `open_science_vcr_*`
 *   families in `addMetric`'s shape, queue gauges included: a study waiting
 *   on the budget confirmation, the second human stop, is a queue an operator
 *   must be able to see.
 *
 * @module vcrComposition
 */

import { createHash } from "node:crypto";

import { VCR_ENGINE_PROTOCOL_VERSION, canonicalScenarioJson, vcrResultOutputPayload } from "@evimed/domain";

import { HttpError } from "./security.mjs";
import { VcrAccess } from "./vcrAccess.mjs";
import { VcrDataPlane } from "./vcrDataPlane.mjs";
import { VcrDataStore } from "./vcrDataStore.mjs";
import { createVcrEngineClient } from "./vcrEngineClient.mjs";
import { createVcrEvidencePipeline } from "./vcrEvidence.mjs";
import { createVcrCorrectionCases } from "./vcrCorrectionCases.mjs";
import { createVcrCurveEvidence } from "./vcrCurveEvidence.mjs";
import { createIntakeCounters, createVcrRecordExtractor } from "./vcrRecordExtract.mjs";
import { createVcrCurveDigitizer } from "./vcrCurveDigitizer.mjs";
import { VcrEvidenceStore } from "./vcrEvidenceStore.mjs";
import { VcrJobs } from "./vcrJobs.mjs";
import { VcrKnowledge } from "./vcrKnowledge.mjs";
import { VcrKnowledgeStore } from "./vcrKnowledgeStore.mjs";
import { createVcrContact } from "./vcrContact.mjs";
import { VcrMatchStore } from "./vcrMatchStore.mjs";
import { VcrMembers } from "./vcrMembers.mjs";
import { createVcrModelPlans } from "./vcrModelDocuments.mjs";
import { createVcrSeal } from "./vcrSeal.mjs";
import { VcrService } from "./vcrService.mjs";
import { VcrStore } from "./vcrStore.mjs";
import { createChictrAdapter, createTrialRegistryClient } from "./trialRegistryClient.mjs";
import {
  VCR_ACCRUAL_MEASURES, accrualBacktestSlices, accrualForecastScenario, backtestAccrualCoverage, candidateReferrals,
  parseProbabilityByMonth, readAccrualForecast, referralFunnel, screenFailuresByCriterion, siteProfileStatus,
} from "./vcrRecruit.mjs";
import {
  VCR_MATCHING_VOCABULARY_VERSION, assessSubject, eligibilityCounts, frozenAsOf, languageKeysOf, requiresLanguageJudgment,
} from "./vcrMatching.mjs";
import { VCR_JOB_PURPOSE } from "./vcrJobs.mjs";

/**
 * The data-plane seam the service reads through: the page's tab, the one-line
 * note it shows when the plane is not configured, the profile a model may see,
 * and the suppression every aggregate leaving the gateway passes through.
 *
 * @param {{ dataPlane: VcrDataPlane, dataStore?: VcrDataStore, access: VcrAccess }} parts `dataStore` is no longer read: the plane builds its own page
 */
export function vcrDataPlaneSeam({ dataPlane, access }) {
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
      // The plane builds the page's half: every source of the study with its
      // files, field map and grants, and its snapshots with their tables. No
      // filesystem path of the server leaves through it — a location is the
      // data plane's own business (CS-49).
      return dataPlane.tabFor(study, user);
    },
    /**
     * The tier the study's frozen sources support (`vcrTierSupportedBy`): what the
     * study header offers and what the study route holds a rise to. Derived from
     * registered analysis tables, never from a file.
     * @param {any} study
     */
    async tierSupport(study) {
      return dataPlane.tierSupport(study.id);
    },
    /** The whole plane, for the routes' intake operations (`vcrRoutes.mjs`). */
    intake: dataPlane,
    /**
     * The run's proposal of a field map (per item; nothing is confirmed by being
     * proposed — a person confirms).
     * @param {any} study @param {{ sourceId: string, columns: unknown, reason?: string }} proposal
     */
    async proposeFieldMap(study, proposal) {
      return dataPlane.proposeFieldMap({
        actor: study.userId, studyId: study.id, sourceId: proposal.sourceId, columns: proposal.columns, by: "run", reason: proposal.reason,
      });
    },
    /** The one sentence a study at T0 sees where no data plane is configured. */
    async note(study) {
      if (dataPlane.root()) return { available: true, tier: study.dataTier };
      return { available: false, code: "vcr_data_plane_unconfigured", message: "本部署未接入数据平面；T0 档（公开资料）的全部步骤照常。" };
    },
    /**
     * What a model may read of a snapshot — or, before there is one, of a
     * source: structure, quality, the dictionary; never a row. Bound to the
     * study that asks (a snapshot or source of another study does not exist
     * here), judged for the study's owner and audited (CS-5).
     * @param {any} study @param {any} filter
     */
    async runtimeProfile(study, filter) {
      const snapshotId = String(filter?.snapshotId ?? "");
      const sourceId = String(filter?.sourceId ?? "");
      if (snapshotId) {
        return { available: true, ...await dataPlane.snapshotProfileForModel({ studyId: study.id, snapshotId, principal: study.userId }) };
      }
      if (sourceId) {
        return { available: true, ...await dataPlane.sourceProfileForModel({ studyId: study.id, sourceId, principal: study.userId }) };
      }
      return { available: false, code: "vcr_snapshot_not_named" };
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

/** The most subjects one evaluation takes; a study larger than this is evaluated in the next run of the recheck loop. */
export const VCR_MATCHING_MAX_SUBJECTS = 5_000;

/** How the frozen context of a matching job rides in its `inputs` (contract §3.1 has no scenario key for it). */
const CONTEXT_INPUT = Object.freeze({ asOf: "matching:asof:", protocol: "matching:protocol:", facts: "matching:facts:", vocabulary: "matching:vocabulary:" });

/** @param {unknown} value */
const object = (value) => (value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {});
/** @param {unknown} value */
const list = (value) => (Array.isArray(value) ? value : []);

/**
 * The frozen context of a matching job, read back from its inputs: the instant
 * it is made as of, the protocol version it evaluates and a token of the facts it
 * saw. The domain's `matching.evaluate` scenario has room for the criteria and
 * nothing else, so these three are frozen as inputs — they are hashed into the
 * job's idempotency key and copied into the execution row, which is exactly what
 * an input is. `asOf` is a valid ISO instant or the job is refused (CS-34).
 * @param {readonly any[]} inputs
 */
export function matchingContextOf(inputs) {
  const idOf = (/** @type {string} */ prefix) => {
    const found = list(inputs).map((input) => String(object(input).id ?? "")).find((id) => id.startsWith(prefix));
    return found ? found.slice(prefix.length) : null;
  };
  const asOf = idOf(CONTEXT_INPUT.asOf);
  if (!asOf) throw Object.assign(new Error("A matching job carries the instant it is made as of."), { code: "vcr_asof_invalid" });
  const vocabularyVersion = idOf(CONTEXT_INPUT.vocabulary) ?? VCR_MATCHING_VOCABULARY_VERSION;
  if (vocabularyVersion !== VCR_MATCHING_VOCABULARY_VERSION) throw Object.assign(new Error('The matching vocabulary version is unsupported.'), { code: 'vcr_matching_vocabulary_unavailable' });
  return { vocabularyVersion, asOf: frozenAsOf(asOf), protocolVersionId: idOf(CONTEXT_INPUT.protocol), factsToken: idOf(CONTEXT_INPUT.facts) };
}

/**
 * The one method the job queue runs in the control plane rather than in
 * `vcr-engine`: a three-valued eligibility verdict is deterministic, cheap and
 * needs the facts the data plane holds, so shipping it to a container would buy
 * nothing and cost a data crossing. Everything else goes to the engine.
 *
 * What it evaluates is loaded **here, by study**: the criteria the job froze (by
 * id, out of the study's own protocol), every fact and every answer to a
 * language criterion the study holds and that was visible at the instant, and
 * the documents those facts point into, read through the data plane's judged
 * and audited reader. Nothing patient-level comes from the job's scenario — a
 * scenario is a thing a run can write, and a fact it wrote there would skip the
 * span check the facts of a `fact` write pass (CS-31).
 *
 * One subject that cannot be evaluated is one subject counted in
 * `diagnostics.errors`; it never stops the others (CS-34).
 *
 * @param {{ matchStore: VcrMatchStore, store: VcrStore,
 *   documents?: { read: (study: any, input: { subjectKey: string, documentId: string }) => Promise<{ text: string } | null> } | null }} parts
 */
export function vcrMatchingExecutor({ matchStore, store, documents = null }) {
  /** @param {{ job: Record<string, any>, onProgress: (progress: { done: number, total: number }) => Promise<unknown> }} input */
  return async ({ job, onProgress }) => {
    const startedAt = new Date().toISOString();
    const studyId = String(job?.studyId ?? "");
    const study = await store.studyById(studyId);
    if (!study) throw Object.assign(new Error("The study of this job is gone."), { code: "vcr_study_not_found" });
    const { asOf, protocolVersionId, vocabularyVersion } = matchingContextOf(job?.inputs);

    const frozenIds = list(object(job?.scenario).criteria).map((criterion) => String(object(criterion).id ?? ""));
    const criteria = (await matchStore.listCriteria({ studyId, protocolVersionId })).filter((criterion) => frozenIds.includes(criterion.id));
    if (!criteria.length) throw Object.assign(new Error("None of the job's criteria is a criterion of this study."), { code: "vcr_criteria_missing" });

    const visibleBy = asOf;
    const [allFacts, languageBySubject] = await Promise.all([
      matchStore.listFacts({ studyId, visibleBy }), matchStore.latestLanguageJudgments({ studyId, visibleBy }),
    ]);
    /** @type {Map<string, any[]>} */
    const factsBySubject = new Map();
    for (const fact of allFacts) factsBySubject.set(fact.subjectKey, [...(factsBySubject.get(fact.subjectKey) ?? []), fact]);
    const subjects = [...new Set([...factsBySubject.keys(), ...languageBySubject.keys()])].sort().slice(0, VCR_MATCHING_MAX_SUBJECTS);

    /** @type {any[]} */
    const assessments = [];
    /** @type {string[]} */
    const errors = [];
    let voidedTotal = 0;
    let done = 0;
    for (const subjectKey of subjects) {
      try {
        const facts = factsBySubject.get(subjectKey) ?? [];
        const modelJudgments = languageBySubject.get(subjectKey) ?? {};
        const documentIds = new Set([
          ...facts.map((fact) => String(fact.source?.documentId ?? "")),
          ...Object.values(modelJudgments).flatMap((entry) => list(object(entry).evidence).map((item) => String(object(item).documentId ?? ""))),
        ].filter(Boolean));
        /** @type {Record<string, { text: string }>} */
        const loaded = {};
        for (const documentId of documentIds) {
          const document = documents ? await documents.read(study, { subjectKey, documentId }).catch(() => null) : null;
          if (document) loaded[documentId] = { text: document.text };
        }
        const assessment = assessSubject({
          studyId, protocolVersionId, subjectKey, asOf, direction: "trial_to_patient", criteria, facts, documents: loaded, modelJudgments, provenance: { vocabularyVersion },
        });
        voidedTotal += assessment.voidedFacts.length;
        assessments.push({ ...assessment, counts: { ...assessment.counts, voidedFacts: assessment.voidedFacts.length } });
      } catch (error) {
        errors.push(String(/** @type {any} */ (error)?.code ?? "vcr_evaluation_failed"));
      }
      done += 1;
      if (done % 10 === 0) await onProgress({ done, total: subjects.length });
    }
    await onProgress({ done, total: subjects.length });

    const tally = assessments.reduce((acc, row) => { acc[row.summary] = (acc[row.summary] ?? 0) + 1; return acc; }, /** @type {Record<string, number>} */ ({}));
    // Deterministic tallies, not a score: how many subjects each summary holds,
    // and nothing a model produced (plan §7.1). Each says where it came from —
    // counted by code (`calculated`) — and the result carries what a result of
    // any method carries (contract §3.4): a conclusion, the echo of the frozen
    // job, and the hash of its own output.
    const scenarioHash = /^[a-f0-9]{64}$/.test(String(job.scenarioHash ?? ""))
      ? String(job.scenarioHash)
      : createHash("sha256").update(canonicalScenarioJson(job?.scenario ?? {})).digest("hex");
    /** @type {Record<string, any>} */
    const result = {
      jobId: String(job.id ?? job.jobId ?? ""), protocolVersion: VCR_ENGINE_PROTOCOL_VERSION, status: "succeeded",
      method: "matching.evaluate", methodVersion: "1.0.0", scenarioHash, seed: Number(job.seed ?? 0), replicates: null,
      conclusion: "estimable",
      counts: { realPatients: assessments.length, events: null, effectiveSampleSize: null, generatedRecords: 0 },
      measures: Object.entries(tally).map(([name, value]) => ({ name, value, simulated: false, source: "calculated" })),
      diagnostics: {
        criteria: criteria.length, subjects: assessments.length, asOf, protocolVersionId, voidedFacts: voidedTotal,
        errors: errors.length, ...(errors.length ? { errorCodes: [...new Set(errors)] } : {}),
        // What this run did not see: subjects past the cap wait for the next run.
        subjectsNotEvaluated: Math.max(0, new Set([...factsBySubject.keys(), ...languageBySubject.keys()]).size - subjects.length),
      },
      tables: [],
      // Per-subject rows leave through the finish hook only: a result row
      // stores measures, counts and diagnostics, never these.
      assessments,
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
 * The documents seam of the matching flow: a patient document read through the
 * data plane's own reader, which judges the read as a patient-level read of the
 * source that holds it and audits it. The runtime reaches it only as the study's
 * owner and only for a document of the study; the subject key a run names must be
 * the document's own (the pseudonym the plane stored with it), or the document is
 * not found — a run that guessed another patient's document id gets nothing.
 *
 * @param {{ dataPlane: VcrDataPlane | null }} parts
 */
export function vcrDocumentsSeam({ dataPlane }) {
  return {
    /** Characters of one document a read returns: the window a run reads a chart through. */
    windowChars: 20_000,
    /**
     * One document with its text, or `null`.
     * @param {any} study @param {{ subjectKey: string, documentId: string }} input
     */
    async read(study, { subjectKey, documentId }) {
      if (!dataPlane) return null;
      const document = await dataPlane.documentText({ studyId: study.id, documentId, principal: study.userId, purpose: VCR_JOB_PURPOSE });
      if (!document || String(document.subjectKey ?? "") !== String(subjectKey)) return null;
      return { id: document.id, text: String(document.text), visibleAt: document.visibleAt ?? null, subjectKey: String(document.subjectKey) };
    },
    /**
     * `vcr_read what: "subject_document"`. With no filter, the subjects that have
     * documents (pseudonymous keys and counts); with a `subjectKey`, that
     * subject's documents (id, name, length, visible time, no text); with a
     * `documentId` as well, a window of the text. Judged and audited by the plane.
     * @param {any} study @param {Record<string, any>} filter
     */
    async subjectDocuments(study, filter) {
      if (!dataPlane) return { available: false, code: "vcr_data_plane_unavailable", message: "数据平面未接入病历文档：这一步暂不可用，其余步骤照常。" };
      const subjectKey = filter?.subjectKey ? String(filter.subjectKey) : null;
      if (filter?.documentId) {
        if (!subjectKey) return { available: false, code: "vcr_read_filter_invalid", message: "读取一份文档要同时写 subjectKey 和 documentId。" };
        const document = await this.read(study, { subjectKey, documentId: String(filter.documentId) }).catch(() => null);
        if (!document) return { available: false, code: "vcr_document_not_found", message: "这位受试者没有这份文档。" };
        const offset = Math.max(0, Number(filter?.offset ?? 0));
        const text = document.text.slice(offset, offset + this.windowChars);
        return { available: true, document: { id: document.id, subjectKey, chars: document.text.length, offset, visibleAt: document.visibleAt,
          text, more: offset + text.length < document.text.length } };
      }
      const documents = await dataPlane.listDocuments({ studyId: study.id, principal: study.userId, subjectKey });
      if (subjectKey) {
        return { available: true, documents: documents.map((entry) => ({ id: entry.id, name: entry.name, chars: entry.chars, visibleAt: entry.visibleAt })) };
      }
      /** @type {Map<string, number>} */
      const bySubject = new Map();
      for (const entry of documents) if (entry.subjectKey) bySubject.set(entry.subjectKey, (bySubject.get(entry.subjectKey) ?? 0) + 1);
      const offset = Math.max(0, Number(filter?.offset ?? 0));
      const limit = Math.max(1, Number(filter?.limit ?? 20));
      const keys = [...bySubject.keys()].sort();
      return { available: true, subjects: keys.slice(offset, offset + limit).map((key) => ({ subjectKey: key, documents: bySubject.get(key) ?? 0 })),
        more: keys.length > offset + limit };
    },
  };
}

/** The frozen inputs of one matching job, and the facts token that keeps two runs of different facts apart. */
function matchingInputs({ asOf, protocolVersionId, facts, judgments }) {
  const token = createHash("sha256").update(JSON.stringify([
    facts.map((/** @type {any} */ fact) => fact.id), judgments,
  ])).digest("hex").slice(0, 16);
  return [
    { kind: "evidence", id: `${CONTEXT_INPUT.asOf}${asOf}` },
    { kind: "evidence", id: `${CONTEXT_INPUT.protocol}${protocolVersionId}` },
    { kind: "evidence", id: `${CONTEXT_INPUT.facts}${token}` },
    { kind: "evidence", id: `${CONTEXT_INPUT.vocabulary}${VCR_MATCHING_VOCABULARY_VERSION}` },
  ];
}

/**
 * The matching seam: the page's tab, the runtime's read, and the flow's own
 * steps — freezing a job, persisting its assessments, re-evaluating what has
 * come due, and the accrual forecast built from the referral ledger. Built from
 * the store and the evaluator's pure functions (a verdict is not a service), so
 * the object the service and the gateway read through is assembled here.
 *
 * @param {{ matchStore: VcrMatchStore, store: VcrStore, jobs?: VcrJobs | null,
 *   getNotifier?: (() => any) | null, report?: (code: string) => void, now?: () => Date, dataPlaneDir?: string }} parts
 */
export function vcrMatchingSeam({ matchStore, store, jobs = null, getNotifier = null, report = () => {}, now = () => new Date(), dataPlaneDir = "" }) {
  /** @param {any} study */
  const languageKeys = async (study) => {
    const criteria = await matchStore.listCriteria({ studyId: study.id }).catch(() => []);
    return [...new Set(criteria.flatMap((criterion) => languageKeysOf(criterion.requirement, criterion.id)))];
  };

  const seam = {
    languageKeys,

    /** @param {any} study */
    async tab(study) {
      const protocol = await store.latestProtocolVersion(study.id).catch(() => null);
      const [criteria, assessments, referrals, sites, progress, funnelRows, tallies, criterionFunnel] = await Promise.all([
        protocol ? matchStore.listCriteria({ studyId: study.id, protocolVersionId: protocol.id }).catch(() => []) : [],
        matchStore.listAssessments({ studyId: study.id, limit: 200, latestOnly: true }).catch(() => []),
        matchStore.listReferrals({ studyId: study.id }).catch(() => []),
        matchStore.listSites(study.id).catch(() => []),
        matchStore.referralProgress(study.id).catch(() => new Map()),
        matchStore.siteFunnel(study.id).catch(() => []),
        matchStore.assessmentTallies(study.id).catch(() => ({})),
        matchStore.criterionFunnelRows(study.id, protocol?.id ?? null).catch(() => []),
      ]);
      return {
        available: true,
        protocol,
        criteria,
        assessments: assessments.map((assessment) => ({
          ...assessment,
          counts: assessment.counts ?? eligibilityCounts(assessment.judgments ?? []),
        })),
        tallies,
        criterionFunnel,
        candidates: candidateReferrals({ studyId: study.id, assessments }),
        // The ledger's own rows, ids included: the contact stop is asked of a
        // referral (`POST …/referrals/:id/contact`), and a candidate that is only
        // an assessment has no id to ask it of.
        referrals: referrals.slice(0, 200),
        funnel: referralFunnel(referrals, progress),
        screenFailures: screenFailuresByCriterion(referrals, criteria),
        sites: sites.map((site) => ({ ...site, verification: siteProfileStatus(site, now()) })),
        siteFunnel: funnelRows,
      };
    },

    /**
     * What a run may read of matching: **criterion-level aggregates**, the
     * pseudonymous keys of the subjects it has to work on, and — for one subject
     * it names — that subject's own assessment. Never a reviewer's name, an
     * override note or a referral's approver, and no person's identity: a subject
     * is the study's pseudonym, and every count leaves through the service's one
     * suppression boundary, so a cell of a few people is hidden, not printed.
     *
     * The assessment of one subject is here because the run writes `matching.json`
     * from it and must not compute a verdict itself (plan §7.1); the counts are
     * cells (`{ state, n }`) so that the boundary can hide a small one together
     * with its neighbour.
     * @param {any} study @param {Record<string, any>} filter
     */
    async runtimeRead(study, filter) {
      const protocol = await matchStore.latestProtocol(study.id).catch(() => null);
      if (!protocol) {
        return { protocol: null, criteria: [], subjects: [], note: "还没有入排条件：先在方案步骤里写入排条件。" };
      }
      const criteria = await matchStore.listCriteria({ studyId: study.id, protocolVersionId: protocol.id });
      const subjectKey = filter?.subjectKey ? String(filter.subjectKey) : null;
      const view = {
        protocol,
        criteria: criteria.map((criterion) => ({
          id: criterion.id, ordinal: criterion.ordinal, kind: criterion.kind, criterionType: criterion.criterionType,
          sourceText: criterion.sourceText, requirement: criterion.requirement, applicability: criterion.applicability,
          decidedBy: requiresLanguageJudgment(criterion.requirement) ? "model" : "code",
          languageKeys: languageKeysOf(criterion.requirement, criterion.id),
        })),
      };
      if (subjectKey) {
        const [assessment, facts, judgments] = await Promise.all([
          matchStore.latestAssessment({ studyId: study.id, subjectKey }),
          matchStore.listFacts({ studyId: study.id, subjectKey }),
          matchStore.latestLanguageJudgments({ studyId: study.id }),
        ]);
        const full = assessment ? await matchStore.getAssessment(assessment.id, study.id) : null;
        const answered = Object.keys(judgments.get(subjectKey) ?? {});
        return {
          ...view, subjectKey,
          assessment: full ? {
            summary: full.summary, asOf: full.asOf, protocolVersionId: full.protocolVersionId,
            // How many of the criteria stand where — counts of criteria for this one subject,
            // not of people, so they are a plain object and not cells.
            criteriaCounts: Object.fromEntries(Object.entries(object(full.counts))
              .filter(([key]) => ["satisfied", "not_satisfied", "unknown", "pending_recheck", "notApplicable"].includes(key))),
            evidenceGaps: full.evidenceGaps,
            judgments: full.judgments.map((judgment) => ({
              criterionId: judgment.criterionId, state: judgment.state, applicable: judgment.applicable, decidedBy: judgment.decidedBy,
              recheckAt: judgment.recheckAt,
              // The state a person set is a fact about the criterion; who set it, and what they wrote, are not the run's.
              overrideState: judgment.overrideState,
              evidence: list(judgment.evidence).map((item) => ({ quote: object(item).quote ?? "", locator: object(item).locator ?? null })),
            })),
          } : null,
          facts: facts.map((fact) => ({ id: fact.id, variable: fact.variable, value: fact.value, unit: fact.unit, polarity: fact.polarity,
            occurredAt: fact.occurredAt, visibleAt: fact.visibleAt, surface: fact.surface, source: fact.source })),
          // The language criteria this subject still has no answer for: what the run owes.
          requests: view.criteria.filter((criterion) => criterion.languageKeys.length)
            .flatMap((criterion) => criterion.languageKeys.filter((key) => !answered.includes(key)).map((key) => ({ criterionKey: key, criterionId: criterion.id }))),
        };
      }
      const [tallies, funnel, subjects, gaps] = await Promise.all([
        matchStore.assessmentTallies(study.id),
        matchStore.criterionFunnelRows(study.id, protocol.id),
        matchStore.subjectSummaries(study.id),
        matchStore.evidenceGapCounts(study.id),
      ]);
      const offset = Math.max(0, Number(filter?.offset ?? 0));
      const limit = Math.max(1, Number(filter?.limit ?? 20));
      const factSubjects = await matchStore.factSubjects(study.id);
      const known = new Map(subjects.map((row) => [row.subjectKey, row.summary]));
      const keys = [...new Set([...known.keys(), ...factSubjects.map((entry) => entry.subjectKey)])].sort();
      return {
        ...view,
        // Cells of siblings, so the boundary can hide the small ones together with the next-smallest.
        summaryCells: Object.entries(tallies).map(([key, n]) => ({ key, n })),
        criterionFunnel: funnel.map((row) => ({
          criterionId: row.criterionId, kind: row.kind, criterionType: row.criterionType,
          cells: [["satisfied", row.satisfied], ["not_satisfied", row.not_satisfied], ["unknown", row.unknown],
            ["pending_recheck", row.pending_recheck], ["not_applicable", row.notApplicable], ["sole_reason", row.soleReason]]
            .map(([key, n]) => ({ key, n })),
        })),
        // `variable` and `category` are the words a hidden cell keeps (the boundary's own list of identity keys).
        gaps: gaps.map((row) => ({ variable: row.variable, category: row.reason, n: row.n })),
        // The subjects a run works on: the study's own pseudonyms, and where each stands.
        subjects: keys.slice(offset, offset + limit).map((key) => ({
          subjectKey: key, summary: known.get(key) ?? null, facts: factSubjects.find((entry) => entry.subjectKey === key)?.facts ?? 0,
        })),
        more: keys.length > offset + limit,
      };
    },

    /**
     * Freeze a `match_criteria` job's scenario and inputs from what the study
     * holds now: the newest protocol's criteria (by id, with the placeholder
     * state the domain's schema asks of the engine variant — the local executor
     * never reads it), the instant to the minute, and a token of the facts.
     * @param {any} study
     */
    async matchScenario(study) {
      const protocol = await matchStore.latestProtocol(study.id);
      const criteria = protocol ? await matchStore.listCriteria({ studyId: study.id, protocolVersionId: protocol.id }) : [];
      if (!protocol || !criteria.length) {
        return { ok: false, message: "还没有入排条件：先在方案步骤里写入排条件，再评估。" };
      }
      if (criteria.length > 500) return { ok: false, message: "入排条件超过 500 条，一次评估放不下。" };
      const minute = new Date(Math.floor(now().getTime() / 60_000) * 60_000).toISOString();
      const [facts, languages] = await Promise.all([
        matchStore.listFacts({ studyId: study.id, visibleBy: minute }), matchStore.latestLanguageJudgments({ studyId: study.id, visibleBy: minute }),
      ]);
      const judgments = [...languages.entries()].map(([subject, entry]) => [subject, Object.entries(entry).map(([key, value]) => [key, value.state, list(value.evidence).length])]);
      return {
        ok: true, protocolVersionId: protocol.id,
        scenario: { criteria: criteria.map((criterion) => ({
          id: criterion.id, kind: criterion.kind, type: criterion.criterionType, state: "unknown",
        })) },
        inputs: matchingInputs({ asOf: minute, protocolVersionId: protocol.id, facts, judgments }),
      };
    },

    /**
     * The finish hook of the job queue (`jobs.addFinishHook`): a `match_criteria`
     * job that succeeded has its per-subject assessments persisted, its
     * candidates turned into referrals in `candidate` (the control plane; never
     * the model) and the coordinators told. Every step isolates its own errors:
     * a subject whose row cannot be written is reported and the rest are kept.
     * @param {Record<string, any>} done what `jobs.finish` answered
     */
    async onJobFinished(done) {
      const job = done?.job;
      if (!job || job.kind !== "match_criteria" || done.state !== "succeeded") return { persisted: 0 };
      const study = await store.studyById(String(job.studyId));
      if (!study) return { persisted: 0 };
      const result = object(done.engineResult);
      const diagnostics = object(result.diagnostics);
      const held = await matchStore.listReferrals({ studyId: study.id, limit: 5000 }).catch(() => []);
      const live = new Set(held.filter((referral) => referral.state !== "screen_failed").map((referral) => referral.subjectKey));

      /** @type {any[]} */
      const saved = [];
      for (const assessment of list(result.assessments)) {
        try {
          saved.push(await matchStore.saveAssessment({
            userId: study.userId,
            assessment: {
              studyId: study.id, protocolVersionId: assessment.protocolVersionId ?? diagnostics.protocolVersionId ?? null,
              subjectKey: assessment.subjectKey, direction: assessment.direction, asOf: assessment.asOf, summary: assessment.summary,
              counts: assessment.counts, priority: null, evidenceGaps: assessment.evidenceGaps, judgments: assessment.judgments,
            },
          }));
        } catch (error) {
          report(String(/** @type {any} */ (error)?.code ?? "vcr_assessment_save_failed"));
        }
      }
      let created = 0;
      let needsEvidence = 0;
      for (const candidate of candidateReferrals({ studyId: study.id, assessments: saved })) {
        try {
          const referral = await matchStore.createReferral({
            userId: study.userId,
            referral: { studyId: study.id, subjectKey: candidate.subjectKey, assessmentId: candidate.assessmentId, state: candidate.state,
              actor: "control-plane", note: "由匹配评估生成" },
          });
          if (!live.has(candidate.subjectKey)) {
            created += 1;
            if (referral?.state === "needs_evidence") needsEvidence += 1;
          }
        } catch (error) {
          report(String(/** @type {any} */ (error)?.code ?? "vcr_referral_create_failed"));
        }
      }
      const notifier = getNotifier?.();
      if (created > 0 && notifier?.newCandidates) {
        await notifier.newCandidates(study, { batchKey: String(job.id), candidates: created, needsEvidence }).catch(() => null);
      }
      return { persisted: saved.length, candidates: created };
    },

    /**
     * Re-evaluate what has come due: the subjects whose newest assessment carries
     * a deferral date that has passed (a washout that ended). One matching job per
     * study with something due, frozen like any other; a due date never
     * evaluates as satisfied early, and never waits for a person to remember.
     * Called from a worker loop.
     * @param {{ now?: Date }} [options]
     */
    async recheckDue({ now: at = now() } = {}) {
      if (!jobs?.enqueue) return { studies: 0, enqueued: 0 };
      const due = await matchStore.dueRecheckSubjects({ now: at });
      const studies = [...new Set(due.map((entry) => entry.studyId))];
      let enqueued = 0;
      for (const studyId of studies) {
        const study = await store.studyById(studyId);
        if (!study) continue;
        const built = await seam.matchScenario(study);
        if (!built.ok) continue;
        try {
          const { created } = await jobs.enqueue({
            studyId: study.id, userId: study.userId, kind: "match_criteria", scenario: built.scenario, inputs: built.inputs,
            idempotencyKey: `vcr:${study.id}:recheck`, detail: { origin: "recheck", protocolVersionId: built.protocolVersionId },
          });
          if (created) enqueued += 1;
        } catch (error) {
          report(String(/** @type {any} */ (error)?.code ?? "vcr_recheck_failed"));
        }
      }
      return { studies: studies.length, enqueued };
    },

    /**
     * A coordinator's re-judgment of one criterion, by the session's account: the
     * platform's answer and the person's are both kept (plan §7.5). Called from a
     * browser route — a run never overrides a person's judgment, so this is not a
     * runtime write.
     * @param {{ id: string | number }} user @param {any} study @param {{ assessmentId: string, criterionId: string, state: string, note?: string }} input
     */
    async overrideJudgment(user, study, input) {
      const judgment = await matchStore.overrideJudgment({
        assessmentId: String(input.assessmentId), criterionId: String(input.criterionId), state: String(input.state),
        by: String(user.id), note: String(input.note ?? "").slice(0, 1000), userId: study.userId, studyId: study.id,
      });
      if (!judgment) throw new HttpError(404, "vcr_assessment_not_found", "这个评估不属于本研究。");
      return judgment;
    },

    /**
     * Countersign an assessment, by the session's account (a signature, not a gate).
     * @param {{ id: string | number }} user @param {any} study @param {{ assessmentId: string }} input
     */
    async reviewAssessment(user, study, input) {
      const assessment = await matchStore.reviewAssessment({ id: String(input.assessmentId), reviewedBy: String(user.id), userId: study.userId, studyId: study.id });
      if (!assessment) throw new HttpError(404, "vcr_assessment_not_found", "这个评估不属于本研究。");
      return assessment;
    },

    /**
     * The accrual forecast's scenario, from the referral ledger: each site's
     * posterior is its prior plus what the ledger says it enrolled and the months
     * it has been open (`accrualForecastScenario`); the screen failure prior is
     * the ledger's own screen failures against its enrolments. What the run states
     * is only the target, the event target and hazard, and the months it wants a
     * probability for.
     * @param {any} study @param {Record<string, any>} request
     */
    async accrualScenario(study, request) {
      const target = request?.target;
      if (!Number.isInteger(target) || target < 1 || target > 10_000_000) return { ok: false, message: "target 是入组目标的例数（1 到 10000000 的整数）。" };
      if ((request?.eventTarget != null) !== (request?.eventHazard != null)) return { ok: false, message: "eventTarget 和 eventHazard 要一起写。" };
      if (request?.eventTarget != null && !(Number.isInteger(request.eventTarget) && request.eventTarget >= 1 && request.eventTarget <= target)) {
        return { ok: false, message: "eventTarget 是 1 到 target 之间的整数。" };
      }
      if (request?.eventHazard != null && !(Number.isFinite(request.eventHazard) && request.eventHazard > 0)) return { ok: false, message: "eventHazard 是每例每月的事件风险，大于 0。" };
      if (request?.byTimes != null && !(Array.isArray(request.byTimes) && request.byTimes.length >= 1 && request.byTimes.length <= 100
        && request.byTimes.every((/** @type {unknown} */ month, /** @type {number} */ at) => Number.isFinite(month) && Number(month) > 0 && (at === 0 || Number(month) > Number(request.byTimes[at - 1]))))) {
        return { ok: false, message: "byTimes 是递增的月数列表（最多 100 个）。" };
      }
      const [sites, referrals] = await Promise.all([matchStore.listSites(study.id), matchStore.listReferrals({ studyId: study.id, limit: 5000 })]);
      if (!sites.length) return { ok: false, message: "还没有中心档案：先写入中心（vcr_write what:site），再做入组预测。" };
      const at = now();
      /** @type {Record<string, { enrolled: number, monthsOpen: number }>} */
      const histories = {};
      for (const site of sites) {
        const opened = site.activatedOn ? Date.parse(String(site.activatedOn)) : Number.NaN;
        const monthsOpen = Number.isFinite(opened) && opened < at.getTime() ? (at.getTime() - opened) / (30.4375 * 86_400_000) : 0;
        if (monthsOpen > 0) histories[site.id] = { enrolled: referrals.filter((referral) => referral.siteId === site.id && referral.state === "enrolled").length, monthsOpen };
      }
      const built = accrualForecastScenario({
        sites, target, asOf: at, eventTarget: request?.eventTarget ?? null, eventHazard: request?.eventHazard ?? null,
        byTimes: request?.byTimes ?? null, siteHistories: histories,
        screenFailure: { failed: referrals.filter((referral) => referral.state === "screen_failed").length,
          passed: referrals.filter((referral) => referral.state === "enrolled").length },
      });
      return { ok: true, scenario: built.scenario, notes: built.notes };
    },

    /**
     * The registered accrual forecasts scored against the ledger's enrolments:
     * the measured coverage of their 80% prediction intervals, with its Wilson
     * bounds and no pass mark (AC-37).
     * @param {any} study
     */
    async accrualBacktest(study) {
      const [forecasts, timeline] = await Promise.all([store.forecasts(study.id), matchStore.enrollmentTimeline(study.id)]);
      const slices = accrualBacktestSlices({
        now: now(), enrollments: timeline,
        forecasts: forecasts.filter((forecast) => forecast.kind === "accrual").map((forecast) => {
          const prediction = object(forecast.prediction);
          const measure = list(prediction.measures).find((entry) => object(entry).name === VCR_ACCRUAL_MEASURES.lastPatientIn);
          return { asOf: forecast.createdAt, target: prediction.target, interval: object(measure).interval ?? prediction.interval ?? null };
        }),
      });
      return backtestAccrualCoverage({ slices });
    },

    /** The dated enrolments the forecast is compared with. @param {any} study */
    async enrollmentTimeline(study) {
      return matchStore.enrollmentTimeline(study.id);
    },

    /**
     * An accrual result read back with its probability table, when the table was
     * kept in the data plane.
     * @param {any} result a `results` row of an accrual forecast
     */
    async readAccrual(result) {
      const table = list(result?.tables).map(object).find((entry) => entry.name === "probability_by_month");
      let rows = null;
      if (table?.location && dataPlaneDir) {
        const { promises: fs } = await import("node:fs");
        const path = await import("node:path");
        const root = path.resolve(dataPlaneDir);
        const file = path.resolve(root, String(table.location));
        if (file.startsWith(`${root}${path.sep}`)) rows = parseProbabilityByMonth(await fs.readFile(file, "utf8").catch(() => ""));
      }
      return readAccrualForecast(result, { probabilityByMonth: rows });
    },
  };
  return seam;
}

/**
 * Whether the engine is composed, and if it is not, why — never the secret.
 * `configured` is what decides whether a client is made; `reason` is one of
 * `not_configured` (no URL: the module simply has no engine, which is a valid
 * deployment), or the request token file's own failure code
 * (`vcr_engine_token_file_short`, …), or `vcr_engine_secret_missing` when the
 * URL is set and no token file was named.
 *
 * The receipt key is not one of those. It is optional, and a configured one
 * that cannot be read leaves the engine composed — results are still checked by
 * their output hash — and is named apart in `receiptKeyError` for readiness and
 * the log, the way a receipt is always treated: a label on a result, never a
 * reason a person cannot have one.
 * @param {Record<string, any>} config
 * @returns {{ configured: boolean, reason: string | null, receiptKeyError: string | null }}
 */
export function vcrEngineStatus(config) {
  const receiptKeyError = config?.vcrEngineReceiptKeyError ? String(config.vcrEngineReceiptKeyError) : null;
  if (!String(config?.vcrEngineUrl ?? "").trim()) return { configured: false, reason: "not_configured", receiptKeyError };
  const error = config.vcrEngineTokenError || null;
  if (error) return { configured: false, reason: String(error), receiptKeyError };
  if (!config.vcrEngineToken) return { configured: false, reason: "vcr_engine_secret_missing", receiptKeyError };
  return { configured: true, reason: null, receiptKeyError };
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
 * @param {{ config: Record<string, any>, fetchImpl?: typeof fetch, engine?: { deleteJob: (jobId: string) => Promise<unknown> } | null }} input
 * @returns {((jobId: string) => Promise<void>) | null}
 */
export function createVcrEngineJobRemover({ config, fetchImpl, engine = null }) {
  if (!vcrEngineStatus(config).configured) return null;
  // One engine client, one way to talk to the engine: the deletion path goes
  // through the client's own `deleteJob` (its token, its deadline, 404 as done).
  const client = engine ?? createVcrEngineClient({
    baseUrl: config.vcrEngineUrl, timeoutMs: config.vcrEngineTimeoutMs,
    token: config.vcrEngineToken, receiptKey: config.vcrEngineReceiptKey,
    fetchImpl: fetchImpl ?? globalThis.fetch,
  });
  return async (/** @type {string} */ jobId) => {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(jobId)) return;
    await client.deleteJob(jobId);
  };
}

/**
 * Compose the module, or answer `null` where it is off.
 *
 * @param {{
 *   config: Record<string, any>,
 *   productDatabase: any, projectStore?: any,
 *   audit?: (event: string, status: string, details: Record<string, any>) => Promise<unknown>,
 *   fetchImpl?: typeof fetch,
 *   report?: (code: string) => void,
 *   connectorCredentials?: { resolveOwn(userId: string, connector: string): Promise<string | null> } | null,
 *   intakeController?: { runVcrIntake?: Function } | null,
 * }} input
 */
export function composeVcr({ config, productDatabase, projectStore = null, audit = async () => {}, fetchImpl, report = () => {}, connectorCredentials = null, intakeController = null }) {
  if (!config?.vcrEnabled || !productDatabase) return null;

  const store = new VcrStore({ database: productDatabase });
  const dataStore = new VcrDataStore({ database: productDatabase });
  const matchStore = new VcrMatchStore({ database: productDatabase });
  const evidenceStore = new VcrEvidenceStore({ database: productDatabase });

  const access = new VcrAccess({ store: dataStore });
  const members = new VcrMembers({ store: dataStore, access });
  const contact = createVcrContact({ store: matchStore });
  // One judge for the plane and the members' service: a decision the plane makes
  // is the decision the page shows.
  // The two intake conversions (a record document to text, a figure to curve
  // points) run in the runtime controller's disposable container. One counter
  // set serves both, so an operator reads one family of numbers.
  const intakeCounters = createIntakeCounters();
  const extractor = createVcrRecordExtractor({ config, controller: intakeController, counters: intakeCounters, report });
  const dataPlane = String(config.vcrDataPlaneDir ?? "").trim()
    ? new VcrDataPlane({ store: dataStore, config, access, extractor })
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
  // The engine runs on the output-hash check alone; the log says why results are unsigned, once, at composition.
  if (engine && engineStatus.receiptKeyError) report(`vcr_engine_receipt_key_unusable:${engineStatus.receiptKeyError}`);
  const removeEngineJob = createVcrEngineJobRemover({ config, fetchImpl, engine });

  // Patient documents are read through the plane's own judged, audited reader;
  // with no plane there are none, and a fact a run wrote about a document is void.
  const documents = vcrDocumentsSeam({ dataPlane });
  const jobs = new VcrJobs({
    store, config, engine, report, dataPlane,
    localExecutors: { "matching.evaluate": vcrMatchingExecutor({ matchStore, store, documents }) },
  });
  // The seal asks the plane to lift, per study, as of the instant the plan froze
  // (`liftStudySeal`); the plane records the first outcome read through the seal
  // (`attach`). Both ports are narrow on purpose: nothing else of either is the
  // other's business.
  const seal = createVcrSeal({
    store,
    // The model analysis plan freezes at the instant the analysis plan does, before the outcome columns lift.
    modelPlans: createVcrModelPlans({ store }),
    dataPlane: dataPlane ? { liftStudySeal: (/** @type {any} */ input) => dataPlane.liftStudySeal(input) } : null,
    audit: (event, status, details) => store.audit({ action: event, outcome: status, detail: details }),
  });
  dataPlane?.attach({ seal });
  const call = fetchImpl ?? globalThis.fetch;
  // The client's deadline and the gateway's budget for a registry read are one key: a
  // gateway that gave up before its client would answer 「超时」 for a read about to succeed.
  const registry = createTrialRegistryClient({
    fetchImpl: call,
    timeoutMs: Number(config.vcrRegistryTimeoutMs) > 0 ? Number(config.vcrRegistryTimeoutMs) : 20_000,
    chictrAdapter: vcrChictrAdapter({ config, fetchImpl: call, connectorCredentials }),
  });
  const evidence = createVcrEvidencePipeline({ store: evidenceStore, registry, jobs });
  const digitizer = createVcrCurveDigitizer({ config, controller: intakeController, counters: intakeCounters, report });
  const curves = createVcrCurveEvidence({ store: evidenceStore, studyStore: store, access, digitizer, resolveProject: async study => {
    if (!projectStore) throw new HttpError(503, 'vcr_curve_provenance_unavailable', 'Source image access is unavailable.');
    const owner = await projectStore.userById(study.userId);
    return projectStore.requireProject(owner, study.projectId);
  } });
  Object.assign(evidence, { curves, verifyCurveRequest: curves.curveVerifier });
  jobs.curveVerifier = curves.curveVerifier;

  /** @type {any} */
  let composed = null;
  const matching = vcrMatchingSeam({
    matchStore, store, jobs, report, getNotifier: () => composed?.notifier ?? null, dataPlaneDir: String(config.vcrDataPlaneDir ?? ""),
  });
  // A matching job that has finished has its assessments persisted, its
  // candidates made referrals and its coordinators told — by the control plane,
  // after the job's own rows have committed, and never undoing them.
  jobs.addFinishHook((done) => matching.onJobFinished(done));
  const dataPlaneSeam = dataPlane ? vcrDataPlaneSeam({ dataPlane, dataStore, access }) : null;

  const service = new VcrService({
    store, config, engine, access, dataPlane: dataPlaneSeam, evidence, matching, jobs, seal, matchStore, evidenceStore, documents,
  });

  const corrections = createVcrCorrectionCases({ store, matchStore, dataPlane, access });
  // The disease packs and the account's library of population definitions: read and written by the study's pages,
  // by the runtime's `pack` and `library` and by the population writer; the job queue is the comparison's.
  const knowledgeStore = new VcrKnowledgeStore({ database: productDatabase });
  const knowledge = new VcrKnowledge({ store: knowledgeStore, studyStore: store, dataStore, jobs });
  service.attach({ corrections, knowledge });
  composed = {
    store, dataStore, matchStore, evidenceStore, corrections, knowledge, knowledgeStore,
    access, members, contact, dataPlane, dataPlaneSeam, documents, engine, engineStatus, removeEngineJob, jobs, seal, evidence, matching, registry, service,
    intake: { counters: intakeCounters, extractor, digitizer },
    // Composed later, beside the other modules' workers (server.mjs).
    notifier: null, orchestrator: null, worker: null, exporter: null, review: null,
    audit,
  };
  return composed;
}

/** The evidence API's own base, as the public-source gateway names it. */
const EVIMED_EVIDENCE_API = "https://www.evimed.com/api-evimed/medicine-api/ai-api/";

/**
 * ChiCTR through EviMed's shared evidence API (`POST review/api/clinical-trial`,
 * `registry: 0`) — the only door, because ChiCTR's own site refuses direct
 * requests. The key is resolved like every other connector's: the deployment's
 * first and, where it has none, the requesting researcher's own, saved under
 * 设置 → 数据源 (`evimed-evidence`, a connector since 2026-10-04) — so a
 * researcher who brought one gets the ChiCTR listing, and one who did not gets
 * `registry_not_configured` by name for that read. With neither a deployment key
 * nor a store to read the researcher's from, the seat stays empty and the
 * registry client answers `registry_not_configured`, as it always did; the
 * credential is the control plane's, and the runtime never holds it. What the API
 * returns is a listing (registration number, title, status, sample size), so a
 * ChiCTR precedent is a candidate and a stub, and its sample size is never a
 * baseline (the API does not say planned or actual).
 * @param {{ config: Record<string, any>, fetchImpl: typeof fetch,
 *   connectorCredentials?: { resolveOwn(userId: string, connector: string): Promise<string | null> } | null }} input
 */
export function vcrChictrAdapter({ config, fetchImpl, connectorCredentials = null }) {
  const deploymentKey = String(config?.publicSourceCredentials?.evimedEvidence ?? "").trim();
  if (typeof fetchImpl !== "function" || (!deploymentKey && !connectorCredentials)) return null;
  const timeoutMs = Math.max(5_000, Math.min(60_000, Number(config?.vcrRegistryTimeoutMs) || 20_000));
  /** @param {string} key */
  const searchWith = (key) => createChictrAdapter({
    search: async (body) => {
      const response = await fetchImpl(`${EVIMED_EVIDENCE_API}review/api/clinical-trial`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw Object.assign(new Error("The evidence API refused the ChiCTR search."), { code: `http_${response.status}` });
      return response.json();
    },
  });
  /** @param {string} userId */
  const keyFor = async (userId) => {
    if (deploymentKey) return deploymentKey;
    if (!connectorCredentials || !userId) return "";
    // A store that cannot be read is "no key for this researcher", never a thrown fault.
    return String(await connectorCredentials.resolveOwn(userId, "evimed-evidence").catch(() => null) ?? "").trim();
  };
  return Object.assign(
    async (/** @type {{ query: string, limit: number, userId?: string }} */ { query, limit, userId = "" }) => {
      const key = await keyFor(userId);
      if (!key) throw Object.assign(new Error("No EviMed evidence credential is configured for this deployment or this researcher."), { code: "registry_not_configured" });
      return searchWith(key)({ query, limit });
    },
    {
      /** Whether this researcher can read ChiCTR at all: the coverage page says so (`coverageFor`). */
      availableFor: async (/** @type {string} */ userId) => Boolean(await keyFor(userId)),
    },
  );
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
    intake: vcr.intake ? { counters: { ...vcr.intake.counters } } : null,
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
  add("engine_configured", "Whether the compute engine is composed (URL and request token set; any configured receipt key is valid).", "gauge",
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
  if (snapshot.intake?.counters) {
    add("intake_total", "What the intake conversions did since this process started: record documents converted or refused (needsText, unreadable, tooLong, tooLarge), conversions that timed out, failed or had no converter, and figures digitized or refused.", "counter",
      Object.entries(snapshot.intake.counters).map(([kind, value]) => ({ labels: { kind }, value: Number(value) })));
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
