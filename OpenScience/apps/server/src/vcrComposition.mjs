import { CLINICAL_FACT_CONTRACT, FACT_EVIDENCE_RULE, VCR_REQUIREMENT_CONTRACT, VCR_CRITERION_TYPES, clinicalTerminologyContext } from '@evimed/domain';
import { clinicalSemanticFields } from '@evimed/domain';
import { clinicalDocumentWindow } from './vcrDocumentWindow.mjs';
import { locatePassages, passageWindow } from './vcrPassages.mjs';
/**
 * 「虚拟临床研究」, composed: the seven packages joined into the one object the
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
 *   `suppressForModel` once, to every `what` (but for the study owner's own
 *   conversation, which the gateway marks `ownerView` and which reads exact
 *   counts); nothing in this file suppresses anything, and nothing a seam
 *   returns reaches a model without passing the service's boundary.
 * - **Matching is a flow, and this file joins its ends.** A run writes located
 *   facts and answers to language-only criteria; the platform freezes the
 *   protocol's criteria and the instant into a `match_criteria` job; a local
 *   executor loads the facts and the documents **server-side by study** (never
 *   from the job's scenario, which a run could write); and when the job has
 *   finished a hook persists each subject's scientific assessment. Matching has no recruitment side effects.
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
import { createVcrLongitudinal } from './vcrLongitudinal.mjs';
import { VCR_LONGITUDINAL_METHODS } from '@evimed/domain';

import { PLATFORM_PUBLISHER_USER_ID, VCR_DRAFT_STUDY_NAME, VCR_ENGINE_PROTOCOL_VERSION, VCR_LEGACY_DEFAULT_STUDY_NAME, canonicalScenarioJson, vcrResultOutputPayload } from "@evimed/domain";

import { HttpError } from "./security.mjs";
import { VcrAccess } from "./vcrAccess.mjs";
import { VcrDataPlane } from "./vcrDataPlane.mjs";
import { VcrDataStore } from "./vcrDataStore.mjs";
import { VcrErasureStore } from "./vcrErasureStore.mjs";
import { createVcrEngineClient } from "./vcrEngineClient.mjs";
import { createVcrEngineProbe } from "./vcrEngineProbe.mjs";
import { matchingVariablesOf, subjectTableFacts } from "./vcrMatchingTable.mjs";
import { ensureTableMeaning, readTableMeaning, tableMeaningDatasetId } from "./vcrTableMeaning.mjs";
import { createVcrTrialCorpus } from "./vcrTrialCorpus.mjs";
import { createVcrEvidencePipeline } from "./vcrEvidence.mjs";
import { createVcrCorrectionCases } from "./vcrCorrectionCases.mjs";
import { createVcrCurveEvidence } from "./vcrCurveEvidence.mjs";
import { createVcrPublicationSources } from "./vcrPublicationSources.mjs";
import { createIntakeCounters, createVcrRecordExtractor, createVcrScanReader } from "./vcrRecordExtract.mjs";
import { createVcrCurveDigitizer } from "./vcrCurveDigitizer.mjs";
import { VcrEvidenceStore } from "./vcrEvidenceStore.mjs";
import { VcrJobs } from "./vcrJobs.mjs";
import { VcrKnowledge } from "./vcrKnowledge.mjs";
import { VcrKnowledgeStore } from "./vcrKnowledgeStore.mjs";
import { VcrMatchStore } from "./vcrMatchStore.mjs";
import { VcrCandidateTrialStore } from "./vcrCandidateTrialStore.mjs";
import { createPatientTrials } from "./vcrPatientTrials.mjs";
import { matchingAssessmentEvidence } from "./vcrMatchingEvidence.mjs";
import { VcrMembers } from "./vcrMembers.mjs";
import { createVcrModelPlans } from "./vcrModelDocuments.mjs";
import { createVcrSeal } from "./vcrSeal.mjs";
import { VcrService } from "./vcrService.mjs";
import { createVcrPublications, createVcrPublicSimulations } from "./vcrPublications.mjs";
import { createVcrFrontierEvents } from "./vcrFrontierEvents.mjs";
import { createVcrPredictions } from "./vcrPredictions.mjs";
import { createVcrRecords } from "./vcrRecords.mjs";
import { VcrStore } from "./vcrStore.mjs";
import { createChictrAdapter, createTrialRegistryClient } from "./trialRegistryClient.mjs";
import { createVcrImporter } from "./vcrImport.mjs";
import { parseProbabilityByMonth, readAccrualForecast } from "./vcrAccrual.mjs";
import { matchingCandidates } from "./vcrMatchingCandidates.mjs";
import {
  VCR_MATCHING_VOCABULARY_VERSION, VCR_MATCHING_EVALUATOR_VERSION, matchingInputDigest, assessSubject, eligibilityCounts, frozenAsOf, criterionLanguageKeys, requiresLanguageJudgment,
} from "./vcrMatching.mjs";
import { VCR_JOB_PURPOSE } from "./vcrJobs.mjs";
import { matchBatchMinCell } from "./vcrMatchBatch.mjs";
import { createRecordsImport, createRecordsImportExecutor } from "./vcrRecordsImport.mjs";
import { createPatientDocumentRead } from "./vcrPatientContext.mjs";
import { createLongTableReader } from "./vcrLongTables.mjs";
import { VcrCandidateRerank, createRerankMeter } from "./vcrCandidateRerank.mjs";
import { VcrCandidateSearchStore } from "./vcrCandidateSearchStore.mjs";
import { VcrClauseDefinitionStore, createClauseDefinitionCounters, createClauseDefinitions } from "./vcrClauseDefinitions.mjs";
import { createMatchJudge, createMatchJudgeCounters, createMatchJudgeExecutor, createMatchJudgmentReads, createPairJudge, judgmentTargets, tableFieldsOf } from "./vcrMatchJudge.mjs";
import { VcrMatchJudgmentStore } from "./vcrMatchJudgmentStore.mjs";
import { VcrRegistryPageStore, createRegistryPageCounters, createRegistryPages } from "./vcrRegistryPages.mjs";
import { createRegistryWatch, createRegistryWatchCounters } from "./vcrRegistryWatch.mjs";
import { VcrMatchResults } from "./vcrMatchResults.mjs";
import { MATCHING_SNAPSHOT_PREFIX, freezeMatchingInputs, hydrateMatchingInputs, languageCriteriaByKey, matchingSelection, verifyMatchingSnapshot } from "./vcrMatchingSnapshot.mjs";

/**
 * The data-plane seam the service reads through: the page's tab, the one-line
 * note it shows when the plane is not configured, the profile a model may see,
 * and the suppression every aggregate leaving the gateway passes through.
 *
 * @param {{ dataPlane: VcrDataPlane, dataStore?: VcrDataStore, access: VcrAccess }} parts `dataStore` is no longer read: the plane builds its own page
 */
export function vcrDataPlaneSeam({ dataPlane, access }) {
  return {
    /** @param {any} study @param {{id:string}} user */
    async taskInputs(study, user) {
      await access.require({ studyId: study.id, actor: user.id, ability: "read", purpose: "page" });
      return dataPlane.taskInputAvailability(study, user);
    },
    /**
     * The rows the study's overview reads its data-intake waits from (`intakeNeedsOf`): the sources, their files and the snapshots frozen
     * from them. Metadata only; the plane's own judgement of who may read is not asked, because no column and no value leaves here.
     * @param {any} study
     */
    async intakeRows(study) {
      const [sources, files, snapshots] = await Promise.all([
        dataPlane.store.listSourcesForStudy(study.id), dataPlane.store.listSourceFilesForStudy(study.id), dataPlane.store.listSnapshots({ studyId: study.id }),
      ]);
      return { sources, files, snapshots };
    },
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
     * here), judged for the study's owner and audited (CS-5). `options.exact` is the owner's own conversation: the row and fill counts
     * are printed whatever their size (the service passes it from the gateway's decision, never from the filter).
     * @param {any} study @param {any} filter @param {{ exact?: boolean }} [options]
     */
    async runtimeProfile(study, filter, { exact = false } = {}) {
      const snapshotId = String(filter?.snapshotId ?? "");
      const sourceId = String(filter?.sourceId ?? "");
      if (snapshotId) {
        return { available: true, ...await dataPlane.snapshotProfileForModel({ studyId: study.id, snapshotId, principal: study.userId, exact }) };
      }
      if (sourceId) {
        return { available: true, ...await dataPlane.sourceProfileForModel({ studyId: study.id, sourceId, principal: study.userId, exact }) };
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

/** The most subjects one evaluation takes; coverage names the next explicit offset. */
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
 * **A study whose subjects are rows of the data plane's subject table is matched from that table** (`vcrMatchingTable.mjs`):
 * each row is a candidate, and the columns the field map and the dictionary describe are read as facts for the same
 * evaluator — judged for the study's owner for this purpose like every other read of patient-level data, held in memory
 * for this evaluation only, and never written down. A person who is a row of the table and has documents is one candidate
 * with both kinds of fact (the two keys are the same pseudonym); a row with no documents is a candidate who is table-only.
 *
 * @param {{ matchStore: VcrMatchStore, store: VcrStore,
 *   documents?: { read: (study: any, input: { subjectKey: string, documentId: string }) => Promise<{ text: string } | null> } | null,
 *   subjectTable?: { read: (study: any, options?: { variables?: readonly string[] | null, propose?: boolean }) => Promise<any> } | null }} parts
 */
export function vcrMatchingExecutor({ matchStore, store, documents = null, subjectTable = null }) {
  /** @param {{ job: Record<string, any>, onProgress: (progress: { done: number, total: number }) => Promise<unknown> }} input */
  return async ({ job, onProgress }) => {
    const startedAt = new Date().toISOString();
    const studyId = String(job?.studyId ?? "");
    const study = await store.studyById(studyId);
    if (!study) throw Object.assign(new Error("The study of this job is gone."), { code: "vcr_study_not_found" });
    const { asOf, protocolVersionId, vocabularyVersion } = matchingContextOf(job?.inputs);

    const snapshotId = list(job.inputs).map(input => String(input.id ?? '')).find(id => id.startsWith(MATCHING_SNAPSHOT_PREFIX))?.slice(MATCHING_SNAPSHOT_PREFIX.length);
    if (!snapshotId) throw new HttpError(409, 'vcr_matching_snapshot_missing', 'This older job has no frozen matching inputs. Queue a new evaluation.');
    const snapshot = verifyMatchingSnapshot(await matchStore.matchingSnapshot(studyId, snapshotId), studyId, snapshotId);
    if (snapshot.matchingEvaluatorVersion !== VCR_MATCHING_EVALUATOR_VERSION) throw new HttpError(409, 'vcr_matching_evaluator_changed', 'The matching evaluator changed. Queue a new evaluation.');
    if (snapshot.protocolVersionId !== protocolVersionId || snapshot.asOf !== asOf) throw new HttpError(409, 'vcr_matching_input_changed', 'The job and its frozen inputs disagree.');
    const frozenIds = list(object(job?.scenario).criteria).map((criterion) => String(object(criterion).id ?? ''));
    const criteria = snapshot.criteria;
    if (!criteria.length || criteria.length !== frozenIds.length || criteria.some((/** @type {any} */ c) => !frozenIds.includes(c.id))) {
      throw new HttpError(409, 'vcr_criteria_missing', 'The scenario and its frozen criteria disagree.');
    }
    const [frozenFacts, frozenJudgments, withdrawn] = await Promise.all([
      matchStore.matchingFactsByIds(studyId, snapshot.facts.map((/** @type {any} */ row) => row.id)),
      matchStore.languageJudgmentsByIds(studyId, snapshot.languages.map((/** @type {any} */ row) => row.id)),
      matchStore.withdrawnSubjects?.(studyId) ?? new Set(),
    ]);
    const { facts: allFacts, languages: languageBySubject } = hydrateMatchingInputs(snapshot, frozenFacts, frozenJudgments);
    /** @type {Map<string, any[]>} */
    const factsBySubject = new Map();
    for (const fact of allFacts) factsBySubject.set(fact.subjectKey, [...(factsBySubject.get(fact.subjectKey) ?? []), fact]);
    // The subject table, when the study has one: every row a candidate. Read through the plane's judged reader; a refusal
    // (no grant, sealed columns, a table that changed under its hash) leaves the other sources as they were and is said in
    // the result's diagnostics by its code.
    /** @type {any} */
    let tableRead = null;
    if (subjectTable) {
      // What the table's codes mean was settled when the inputs were frozen; a running job reads it and never asks the model.
      try { tableRead = await subjectTable.read(study, { variables: matchingVariablesOf(criteria), propose: false }); }
      catch (error) { tableRead = { available: false, reason: String(/** @type {any} */ (error)?.code ?? "vcr_subject_table_unreadable") }; }
    }
    if (snapshot.subjectTable && tableRead?.available && matchingTableIdentity(tableRead) !== snapshot.subjectTable.identity) {
      throw new HttpError(409, 'vcr_matching_input_changed', 'The frozen subject table or its field definitions changed. Queue a new evaluation.');
    }
    const tableFacts = tableRead?.available
      ? subjectTableFacts({ ...tableRead, variables: matchingVariablesOf(criteria), limit: Number.POSITIVE_INFINITY })
      : null;
    /** @type {Set<string>} candidates that exist only as a row of the table */
    const tableOnly = new Set((snapshot.subjectTable?.subjects ?? []).filter(subjectKey => !factsBySubject.has(subjectKey) && !languageBySubject.has(subjectKey)));
    for (const { subjectKey, facts } of snapshot.subjectTable ? tableFacts?.subjects ?? [] : []) {
      if (!factsBySubject.has(subjectKey) && !languageBySubject.has(subjectKey)) tableOnly.add(subjectKey);
      factsBySubject.set(subjectKey, [...(factsBySubject.get(subjectKey) ?? []), ...facts]);
    }
    const subjects = snapshot.subjects.slice(snapshot.offset, snapshot.offset + snapshot.limit);

    /** @type {any[]} */
    const assessments = [];
    /** @type {string[]} */
    const errors = [];
    /** @type {Record<string, any>} */
    const outcomes = {};
    let voidedTotal = 0;
    let done = 0;
    for (const subjectKey of subjects) {
      // A subject who withdrew consent after this batch was frozen is no longer evaluated; the roster counts them unavailable.
      if (withdrawn.has(subjectKey)) {
        errors.push("vcr_subject_withdrawn");
        outcomes[subjectKey] = { state: "unavailable", code: "vcr_subject_withdrawn", jobId: job.id };
        done += 1;
        continue;
      }
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
          studyId, protocolVersionId, subjectKey, asOf, direction: snapshot.direction, criteria, facts, documents: loaded, modelJudgments,
          provenance: { vocabularyVersion, inputSnapshotId: snapshotId },
        });
        voidedTotal += assessment.voidedFacts.length;
        outcomes[subjectKey] = { state: "evaluated", jobId: job.id };
        assessments.push({ ...assessment, counts: { ...assessment.counts, voidedFacts: assessment.voidedFacts.length },
          ...(tableOnly.has(subjectKey) ? { source: "subject_table" } : {}) });
      } catch (error) {
        const code = String(/** @type {any} */ (error)?.code ?? "vcr_evaluation_failed");
        errors.push(code);
        outcomes[subjectKey] = { state: "unavailable", code, jobId: job.id };
      }
      done += 1;
      if (done % 10 === 0) await onProgress({ done, total: subjects.length });
    }
    await onProgress({ done, total: subjects.length });
    await matchStore.recordMatchingOutcomes?.(studyId, snapshotId, outcomes);

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
        requestedSubjects: snapshot.subjects.length, batchOffset: snapshot.offset, batchSubjects: subjects.length,
        subjectsNotEvaluated: Math.max(0, snapshot.subjects.length - assessments.length),
        batchEvaluated: assessments.length, batchUnavailable: errors.length,
        outsideBatch: Math.max(0, snapshot.subjects.length - subjects.length), inputSnapshotId: snapshotId,
        nextOffset: snapshot.offset + subjects.length < snapshot.subjects.length ? snapshot.offset + subjects.length : null,
        // The subject table, by what it was and what of it answered: names and counts, never a cell.
        ...(subjectTable ? { subjectTable: tableFacts
          ? { snapshotId: tableRead.snapshotId, rows: tableFacts.rows, subjects: tableFacts.subjects.length, notEvaluated: tableFacts.notEvaluated,
            variablesMapped: tableFacts.mapped, variablesUnmapped: tableFacts.unmapped, variablesAmbiguous: tableFacts.ambiguous, withheld: tableRead.withheld,
            // Whether the meaning of the table's codes could be proposed when the inputs were frozen (`vcrTableMeaning.mjs`).
            ...(snapshot.subjectTable?.meaning ? { meaning: snapshot.subjectTable.meaning } : {}) }
          : { available: false, reason: String(tableRead?.reason ?? "unavailable"), ...(tableRead?.fields?.length ? { fields: tableRead.fields } : {}) } } : {}),
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

/** What every passage answer says: the passages are found by shared words, so a missing one proves nothing. */
const PASSAGES_NOTE = "这些是按条件的用词在病历里找出的候选片段（位置是 UTF-16 字符偏移），是检索线索，不是判断：没出现不等于病历没写。" +
  "找不到相关片段时，事实不写，条件保持未知，不能写成 negated；需要上下文就用 offset 读那一段的前后。事实仍要带逐字引文，写入时照常核对。";

/**
 * The documents seam of the matching flow: a patient document read through the
 * data plane's own reader, which judges the read as a patient-level read of the
 * source that holds it and audits it. The runtime reaches it only as the study's
 * owner and only for a document of the study; the subject key a run names must be
 * the document's own (the pseudonym the plane stored with it), or the document is
 * not found — a run that guessed another patient's document id gets nothing.
 *
 * @param {{ dataPlane: VcrDataPlane | null, passagesMinChars?: number }} parts
 */
export function vcrDocumentsSeam({ dataPlane, passagesMinChars = 40_000 }) {
  return {
    /** Characters of one document a read returns: the window a run reads a chart through. */
    windowChars: 20_000,
    /** A document longer than this is offered by the passages that bear on a criterion (`vcrPassages`), not only window after window. */
    passagesMinChars,
    /**
     * One document with its text, or `null`.
     * @param {any} study @param {{ subjectKey: string, documentId: string }} input
     */
    async read(study, { subjectKey, documentId }) {
      if (!dataPlane) return null;
      const document = await dataPlane.documentText({ studyId: study.id, documentId, principal: study.userId, purpose: VCR_JOB_PURPOSE });
      if (!document || String(document.subjectKey ?? "") !== String(subjectKey)) return null;
      return { id: document.id, text: String(document.text), visibleAt: document.visibleAt ?? null, subjectKey: String(document.subjectKey),
        sourceHash: document.sourceHash ?? null, projectionHash: document.projectionHash ?? null };
    },
    /**
     * Every record of the study with its owner and length, no text: what the batch reading plans from (D4). A record whose person
     * the plane did not note is not a record of anyone and is left out.
     * @param {any} study @param {string | null} [subjectKey] one person's, when a job has to read them again
     * @returns {Promise<Array<{ id: string, subjectKey: string, chars: number | null }>>}
     */
    async roster(study, subjectKey = null) {
      if (!dataPlane) return [];
      const listed = await dataPlane.listDocuments({ studyId: study.id, principal: study.userId, subjectKey });
      return listed.filter((/** @type {any} */ entry) => entry.subjectKey)
        .map((/** @type {any} */ entry) => ({ id: String(entry.id), subjectKey: String(entry.subjectKey), chars: Number.isFinite(Number(entry.chars)) ? Number(entry.chars) : null, visibleAt: entry.visibleAt ?? null }));
    },
    /** What this study's long tables say, for reading as lines, or null when it has none. @param {any} study */
    async longTables(study) {
      const opened = await dataPlane?.openLongTables?.({ studyId: study.id, principal: study.userId, purpose: VCR_JOB_PURPOSE, cloudContext: study.cloudContext ?? null });
      return opened ? createLongTableReader(opened) : null;
    },
    /** Whether what was read of this person may still go to a model: null when it may, otherwise why not (`VcrDataPlane.recordStands`).
     * @param {any} study @param {{ subjectKey: string, documentIds?: readonly string[], snapshotIds?: readonly string[] }} input */
    async recordStands(study, input) {
      return dataPlane ? dataPlane.recordStands({ studyId: study.id, ...input }) : null;
    },
    /** What this reader may see of saved judgments, by what each read (`VcrDataPlane.judgeRecordReads`).
     * @param {any} study @param {{ id: string } | null} viewer @param {ReadonlyArray<{ documentIds?: readonly string[], snapshots?: ReadonlyArray<{ id: string, fields?: readonly string[] }> }>} records */
    async judgeReads(study, viewer, records) {
      if (!dataPlane || !viewer) return { patientLevel: false, permitted: records.map(() => false) };
      return dataPlane.judgeRecordReads({ studyId: study.id, principal: viewer.id, records, purpose: VCR_JOB_PURPOSE });
    },
    /** What a run was shown of a document, for the reading it has been through: the same record a window read writes.
     * @param {any} study @param {string} documentId @param {string} text @param {number} start @param {number} end */
    async recordWindow(study, documentId, text, start, end) {
      if (!study.cloudContext || !dataPlane?.recordDocumentWindow) return;
      await dataPlane.recordDocumentWindow(study.id, documentId, study.cloudContext, clinicalDocumentWindow(text, start, Math.max(1, end - start)));
    },
    /** The only document reader used by a cloud run. @param {any} study @param {any} input */
    async runtimeRead(study, { subjectKey, documentId }) {
      if (!dataPlane) return null;
      const document = await dataPlane.projectionText({ studyId: study.id, documentId, principal: study.userId, purpose: VCR_JOB_PURPOSE, cloudContext: study.cloudContext }, true);
      if (!document || document.subjectKey !== subjectKey) return null;
      return document;
    },
    /** A quote or fact is sent back out only from a document the cloud may have now: one read under a permission since revoked,
     * or from a document that now has a reviewed projection (its own text is what a run reads), is not.
     * @param {any} study @param {any[]} entries @param {string} subjectKey */
    async runtimeEvidence(study, entries, subjectKey) {
      return this.projectEvidence(study, entries, subjectKey, null);
    },
    /** @param {any} study @param {any[]} entries @param {string} subjectKey @param {{id:string}} viewer */
    async viewEvidence(study, entries, subjectKey, viewer) {
      return this.projectEvidence(study, entries, subjectKey, viewer);
    },
    /** Each selected cell is re-read from its immutable snapshot under the current viewer's grant.
     * @param {any} study @param {any[]} entries @param {string} subjectKey @param {{id:string}|null} viewer */
    async projectEvidence(study, entries, subjectKey, viewer) {
      const decisions = new Map();
      const result = [];
      for (const entry of entries) {
        const source = entry.source ?? entry.locator ?? entry;
        if (source.snapshotId && source.long && dataPlane?.longEvidenceAllowed) {
          const key = `long:${source.snapshotId}`;
          if (!decisions.has(key)) decisions.set(key, await dataPlane.longEvidenceAllowed({ studyId: study.id, snapshotId: source.snapshotId, subjectKey, principal: viewer?.id ?? study.userId, purpose: VCR_JOB_PURPOSE, external: !viewer }).catch(() => false));
          if (decisions.get(key)) result.push(entry);
          continue;
        }
        if (source.snapshotId && source.field && dataPlane?.subjectTableEvidenceBatch) {
          const key = `snapshot:${source.snapshotId}`;
          if (!decisions.has(key)) {
            const fields = [...new Set(entries.map(item => item.source ?? item.locator ?? item)
              .filter(item => item.snapshotId === source.snapshotId && item.field).map(item => String(item.field)))];
            decisions.set(key, await dataPlane.subjectTableEvidenceBatch({ studyId: study.id, snapshotId: source.snapshotId,
              fields, subjectKey, principal: viewer?.id ?? study.userId, purpose: VCR_JOB_PURPOSE,
              external: !viewer, cloudContext: viewer ? null : study.cloudContext, session: study.tableSession ?? null }).catch(() => ({})));
          }
          const cell = decisions.get(key)?.[source.field];
          if (cell && (!source.sourceHash || source.sourceHash === cell.locator.sourceHash)) result.push({ ...entry, ...cell, quoteKind: "snapshot_cell" });
          continue;
        }
        const id = String(source.documentId ?? '');
        if (!id) continue;
        if (!decisions.has(id)) decisions.set(id, await (viewer ? this.read({ ...study, userId: viewer.id }, { subjectKey, documentId: id })
          : this.runtimeRead(study, { subjectKey, documentId: id })).catch(() => null));
        const document = decisions.get(id);
        const quote = source.quote ?? entry.quote;
        if (document?.id === id && typeof quote === 'string' && document.text.slice(source.start, source.end) === quote) result.push(entry);
      }
      return result;
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
        let document;
        try { document = await this.runtimeRead(study, { subjectKey, documentId: String(filter.documentId) }); }
        catch (error) {
          const code = String(/** @type {any} */ (error)?.code ?? 'vcr_projection_unavailable');
          return { available: false, code, message: code === 'vcr_document_withdrawn' ? '这份病历已撤回，文本已清除；其他工作可以继续。'
            : '这份病历现在不能交给云端模型读取（云端处理被限制或尚未授权，或它已不在这项研究里）；其他工作可以继续。' };
        }
        if (!document) return { available: false, code: "vcr_document_not_found", message: "这位受试者没有这份文档。" };
        const offset = Math.max(0, Number(filter?.offset ?? 0));
        const chars = document.text.length;
        const long = chars > this.passagesMinChars;
        const asked = /** @type {{ terms: import('./vcrPassages.mjs').PassageTerms, criterionId: string | null } | undefined} */ (filter?.passages);
        if (asked && long) {
          // The passages of a long record that carry the criterion's words, each with where it stands (a retrieval hint, never a verdict).
          const found = locatePassages(document.text, asked.terms);
          if (study.cloudContext && dataPlane.recordDocumentWindow) {
            for (const passage of found.passages) await dataPlane.recordDocumentWindow(study.id, document.id, study.cloudContext, passageWindow(passage, chars));
          }
          return { available: true,
            document: { id: document.id, subjectKey, chars, visibleAt: document.visibleAt, offsetUnit: "utf16", projectionHash: document.projectionHash },
            passages: found.passages,
            passageSearch: { criterionId: asked.criterionId, variables: asked.terms.variables, terminologyTerms: asked.terms.fromTerminology, queryWords: found.queryTokens,
              searchedChars: chars, units: found.units, returned: found.passages.length },
            note: PASSAGES_NOTE };
        }
        const window = clinicalDocumentWindow(document.text, offset, this.windowChars);
        if (study.cloudContext && dataPlane.recordDocumentWindow) await dataPlane.recordDocumentWindow(study.id, document.id, study.cloudContext, window);
        return { available: true, document: { id: document.id, subjectKey, chars, visibleAt: document.visibleAt,
          ...window, projectionHash: document.projectionHash },
        // A record this long is not read in order: say how to ask for the part a criterion bears on. A short one is read as it always was.
        ...(long && !asked && offset === 0 ? { long: { chars, threshold: this.passagesMinChars,
          how: "这份病历很长，不必一段段读完：同样的读取里再写 id（一条入排条件的 id）或 query（几个检索词），平台会按条件找出相关片段并给出位置；" +
            "找不到片段的条件，事实不写（条件保持未知），不要写成否认。" } } : {}),
        ...(asked && !long ? { passages: [], passageSearch: { searchedChars: chars, note: `这份病历只有 ${chars} 字，不超过 ${this.passagesMinChars} 字：直接读窗口就行。` } } : {}) };
      }
      const documents = await dataPlane.listDocuments({ studyId: study.id, principal: study.userId, subjectKey });
      if (subjectKey) {
        return { available: true, documents: documents.map((entry) => ({ id: entry.id, name: "病历文档", chars: entry.chars, visibleAt: entry.visibleAt })) };
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

/**
 * The subject-table seam of the matching flow: the plane's judged read of the study's subject table for the study's
 * owner, and the identity (snapshot and hash) a job freezes so a changed table is a different job. A refusal is an
 * answer — `{ available: false, reason }` — never an error that stops the other sources.
 *
 * Asked for the `variables` of a set of criteria, a read also carries what the table's columns mean for them (`meaning`, its
 * `meaningDigest` and `meaningStatus`; `vcrTableMeaning.mjs`): what is recorded, and with `propose` one model call for what is
 * not. `semantics` is the dataset-semantics service, given as a function because it is built after this module.
 * @param {{ dataPlane: VcrDataPlane | null, semantics?: (() => any) | null, config?: Record<string, any>, usageLedger?: any, fetchImpl?: typeof fetch, callModel?: typeof import('./modelGateway.mjs').callModelForControlPlane }} parts
 */
export function vcrSubjectTableSeam({ dataPlane, semantics = null, config = {}, usageLedger = null, fetchImpl = undefined, callModel = undefined }) {
  return {
    /** @param {any} study @param {{ variables?: readonly string[] | null, propose?: boolean }} [options] */
    async read(study, { variables = null, propose = false } = {}) {
      if (!dataPlane) return { available: false, reason: "vcr_data_plane_unavailable" };
      const table = await dataPlane.subjectTableForMatching({ studyId: study.id, principal: study.userId, purpose: VCR_JOB_PURPOSE });
      if (!table.available || !variables?.length) return table;
      const found = await ensureTableMeaning({
        study, table, variables, semantics: semantics?.() ?? null, config, usageLedger, fetchImpl, callModel, propose,
        authorizeCloud: ({ fields }) => dataPlane.authorizeSubjectTableCloudRead({ studyId: study.id, snapshotId: table.snapshotId, principal: study.userId, fields }),
      });
      return { ...table, meaning: found.meaning, meaningDigest: found.digest,
        meaningStatus: { status: found.status, ...(found.code ? { code: found.code } : {}), ...(found.message ? { message: found.message } : {}) } };
    },
    /** What the table's codes were read to mean, and how to correct one: a correction outranks the model's reading, and screening reads it next time. @param {any} study */
    async meaningRead(study) {
      const table = dataPlane ? await dataPlane.subjectTableForMatching({ studyId: study.id, principal: study.userId, purpose: VCR_JOB_PURPOSE }).catch(() => null) : null;
      if (!table?.available || !table.snapshotId) return { available: false, note: "这个研究没有受试者表。" };
      const datasetId = tableMeaningDatasetId(String(table.snapshotId));
      const record = await semantics?.()?.get(String(study.userId), String(study.projectId), datasetId).catch(() => null);
      const meaning = readTableMeaning(record?.asset);
      return { available: true, datasetId, columns: list(table.columns).filter((column) => column?.name && column.name !== "USUBJID").map((column) => ({ name: String(column.name), ...(meaning.columns[column.name] ?? {}) })),
        correct: { tool: "dataset_semantics", action: "write", datasetId, note: "A code read wrongly, or a column with no map: write the variable's valueMap as the researcher states it, basis statement." } };
    },
    /** @param {any} study */
    async identity(study) {
      if (!dataPlane) return null;
      return dataPlane.subjectTableIdentity(study.id).catch(() => null);
    },
  };
}

/** A table version includes the field definitions used to interpret its cells, never the cells themselves. @param {any} table */
function matchingTableIdentity(table) {
  // What the columns' codes mean joins the identity only when a meaning is recorded for the criteria's variables: a study without one keeps the identity it had.
  return matchingInputDigest({snapshotId:table.snapshotId,sha256:table.sha256??null,header:table.header,columns:table.columns,withheld:table.withheld??[],...(table.meaningDigest?{meaning:table.meaningDigest}:{})});
}

/** The frozen inputs of one matching job, and the facts token that keeps two runs of different facts apart. */
function matchingInputs({ asOf, protocolVersionId, facts, judgments, table = null }) {
  // The table's identity joins the token only when there is a table, so a study without one keeps the token it had.
  const token = createHash("sha256").update(JSON.stringify([
    facts.map((/** @type {any} */ fact) => fact.id), judgments, ...(table ? [table.snapshotId, table.sha256] : []),
  ])).digest("hex").slice(0, 16);
  return [
    { kind: "evidence", id: `${CONTEXT_INPUT.asOf}${asOf}` },
    { kind: "evidence", id: `${CONTEXT_INPUT.protocol}${protocolVersionId}` },
    { kind: "evidence", id: `${CONTEXT_INPUT.facts}${token}` },
    { kind: "evidence", id: `${CONTEXT_INPUT.vocabulary}${VCR_MATCHING_VOCABULARY_VERSION}` },
  ];
}

/**
 * Whether a study is given the clinical fact contract and the terminology that goes with it (2026-10-10 owner ruling: every
 * VCR feature takes effect). Every study is, unless the deployment lists study ids, which then restricts it to those: the list
 * is an optional restriction, no longer the way in.
 * @param {unknown} studyIds `OPEN_SCIENCE_VCR_CLINICAL_STUDY_IDS` @param {string} studyId
 */
export function clinicalEnrichmentOn(studyIds, studyId) {
  const listed = list(studyIds);
  return listed.length === 0 || listed.includes(studyId);
}

/**
 * The matching seam: the page's tab, the runtime's read, and the flow's own
 * steps — freezing a job, persisting its assessments, re-evaluating what has
 * come due. Built from
 * the store and the evaluator's pure functions (a verdict is not a service), so
 * the object the service and the gateway read through is assembled here.
 *
 * @param {{ matchStore: VcrMatchStore, store: VcrStore, jobs?: VcrJobs | null,
 *   report?: (code: string) => void, now?: () => Date, dataPlaneDir?: string, subjectTable?:any, documents?:any, clinicalEnabled?:(study:any)=>boolean, clinicalContext?:(study:any,criteria:any[])=>Promise<any> }} parts
 */
export function vcrMatchingSeam({ matchStore, store, documents = null, subjectTable = null, jobs = null, report = () => {}, now = () => new Date(), dataPlaneDir = "", clinicalEnabled = () => true, clinicalContext = async () => null }) {
  /** @param {any} study */
  const languageKeys = async (study, /** @type {string|null} */ protocolVersionId = null) => {
    const criteria = await matchStore.listCriteria({ studyId: study.id, protocolVersionId }).catch(() => []);
    return [...languageCriteriaByKey(criteria).keys()];
  };

  const seam = {
    languageKeys,

    /**
     * A criterion of any of the study's protocol versions, by id — what the passages of a long record are looked for with (M4).
     * @param {any} study @param {string} id
     */
    async criterionById(study, id) {
      if (!study?.id) return null;
      return (await matchStore.listCriteria({ studyId: study.id, allVersions: true }).catch(() => [])).find((criterion) => criterion.id === id) ?? null;
    },

    /**
     * The terminology the deployment's disease pack holds for the variables a criterion names (labels, Chinese labels, synonyms), or null:
     * words for a lexical search of a long record. Selected pack definitions, never a patient diagnosis.
     * @param {any} study @param {any} criterion
     */
    async passageTerminology(study, criterion) {
      return clinicalEnabled(study) ? clinicalContext(study, [criterion]).catch(() => null) : null;
    },

    /** @param {any} study */
    async tab(study) {
      const protocol = await store.latestProtocolVersion(study.id).catch(() => null);
      const [criteria, assessments, tallies, criterionFunnel] = await Promise.all([
        protocol ? matchStore.listCriteria({ studyId: study.id, protocolVersionId: protocol.id }).catch(() => []) : [],
        matchStore.listAssessments({ studyId: study.id, limit: 200, latestOnly: true }).catch(() => []),
        matchStore.assessmentTallies(study.id, protocol?.id ?? null).catch(() => ({})),
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
        candidates: matchingCandidates({ studyId: study.id, assessments }),
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
      // What a study's table means, under its own name: the dataset's id, each column's concept and codes, and how to correct one.
      if(filter.kind==='table_meaning') return subjectTable?.meaningRead ? subjectTable.meaningRead(study) : {available:false,note:'这个研究没有受试者表。'};
      if(filter.kind==='contract') return {
        factContract:clinicalEnabled(study) ? CLINICAL_FACT_CONTRACT : null,
        // The rule holds for every fact, whether or not the clinical metadata is on for this study.
        factRule: FACT_EVIDENCE_RULE,
        requirementGrammar: VCR_REQUIREMENT_CONTRACT, criterionTypes: VCR_CRITERION_TYPES,
        writeEnvelope: 'Single: {what,data:<one object>}; batch: {what,items:[<object>]}. Never nest items inside data; never use writes as schema probes.',
        note:'Examples describe syntax only. Use only criteria and facts supported by the supplied protocol and preserved patient material. Do not guess internal message sequence numbers.',
        patientContext:{tool:'vcr_write',what:'patient_context',data:{}},
        protocolTextWrite:{tool:'vcr_write',what:'protocol',data:{title:'Protocol title',protocolText:'The eligibility section as written; the platform numbers its clauses'},note:'Enough for judging. A criterion always has sourceText; requirement is for screening a table.'},
        protocolWrite:{tool:'vcr_write',what:'protocol',data:{criteria:[{kind:'inclusion',criterionType:'demographic',sourceText:'Exact protocol wording',requirement:{op:'compare',variable:'age',comparator:'between',value:18,highValue:65,unit:'year'}}]}},
        factWrite:{tool:'vcr_write',what:'fact',items:[{subjectKey:'returned subjectKey',documentId:'returned documentId',variable:'age',value:45,unit:'year',surface:'45 years',quote:'Exact preserved original quote'}]},
        evaluate:{tool:'vcr_simulate',action:'start',kind:'match_criteria'},
        terminologyRead:{what:'matching',filter:{kind:'terminology'}},
        tableMeaningRead:{what:'matching',filter:{kind:'table_meaning'}},
      };
      if (filter.snapshotId) {
        const snapshot = await matchStore.matchingSnapshot(study.id, String(filter.snapshotId));
        const progress = await matchStore.matchingProgress(study.id, String(filter.snapshotId));
        // Counts of people leave through the one boundary like every other: the roster size under a name it knows, the
        // states as sibling cells so a small one is hidden together with the neighbour that would reproduce it.
        return { inputSnapshotId: String(filter.snapshotId), protocolVersionId: snapshot.protocolVersionId,
          asOf: snapshot.asOf, requestedSubjects: progress.length,
          subjects: progress.slice(Number(filter.offset ?? 0), Number(filter.offset ?? 0) + Number(filter.limit ?? 20)),
          more: Number(filter.offset ?? 0) + Number(filter.limit ?? 20) < progress.length,
          coverageCells: ['evaluated', 'pending', 'unavailable'].map(state => ({ key: state, n: progress.filter(row => row.state === state).length })) };
      }
      const protocol = filter.protocolVersionId ? (await matchStore.protocols(study.id, String(filter.protocolVersionId)))[0] ?? null
        : await matchStore.latestProtocol(study.id).catch(() => null);
      if (!protocol) {
        return {protocol:null,criteria:[],subjects:[],contractRead:{what:'matching',filter:{kind:'contract'}},note:'No criteria are saved. Read the contract, then structure only the supplied protocol with vcr_write; a separate study-definition workflow is not required.'};
      }
      const criteria = await matchStore.listCriteria({ studyId: study.id, protocolVersionId: protocol.id });
      const validLanguageKeys = languageCriteriaByKey(criteria);
      const subjectKey = filter?.subjectKey ? String(filter.subjectKey) : null;
      const withdrawn = await matchStore.withdrawnSubjects?.(study.id) ?? new Set();
      const view = {
        protocol,
        contractRead:{what:'matching',filter:{kind:'contract'}},
        criteria: criteria.map((criterion) => ({
          id: criterion.id, ordinal: criterion.ordinal, kind: criterion.kind, criterionType: criterion.criterionType,
          sourceText: criterion.sourceText, requirement: criterion.requirement, applicability: criterion.applicability,
          decidedBy: requiresLanguageJudgment(criterion.requirement) || requiresLanguageJudgment(criterion.applicability) ? "model" : "code",
          languageKeys: criterionLanguageKeys(criterion).filter(key => validLanguageKeys.has(key)),
        })),
      };
      if(filter.kind==='terminology') return {protocol,terminology:clinicalEnabled(study) ? await clinicalContext(study,criteria).catch(()=>null) : null};
      // A subject whose consent was withdrawn is read as that and nothing else: no assessment, no facts, no work to owe.
      if (subjectKey && withdrawn.has(subjectKey)) return { ...view, subjectKey, withdrawn: true, assessment: null, semanticFields: [], facts: [], requests: [] };
      if (subjectKey) {
        const [assessment, facts, judgments] = await Promise.all([
          matchStore.latestAssessment({ studyId: study.id, subjectKey, protocolVersionId: protocol.id }),
          matchStore.listFacts({ studyId: study.id, subjectKey }),
          matchStore.latestLanguageJudgments({ studyId: study.id, protocolVersionId: protocol.id }),
        ]);
        const full = assessment ? await matchStore.getAssessment(assessment.id, study.id) : null;
        const answered = Object.keys(judgments.get(subjectKey) ?? {});
        const cloudFacts = documents ? await documents.runtimeEvidence(study, facts, subjectKey) : [];
        const projectedAssessment = await matchingAssessmentEvidence({ documents, study, assessment: full, subjectKey });
        return {
          subjectKey,
          assessment: projectedAssessment && filter.id ? {...projectedAssessment,judgments:projectedAssessment.judgments.filter(row=>row.criterionId===String(filter.id)),judgmentsTotal:projectedAssessment.judgments.length,criterionFound:view.criteria.some(row=>row.id===String(filter.id))} : projectedAssessment,
          ...view,
          ...(filter.id ? {criteria:view.criteria.filter(row=>row.id===String(filter.id)),criterionId:String(filter.id)} : {}),
          semanticFields: clinicalSemanticFields(cloudFacts),
          facts: cloudFacts.map((fact) => ({ id: fact.id, variable: fact.variable, value: fact.value, unit: fact.unit, polarity: fact.polarity,
            occurredAt: fact.occurredAt, visibleAt: fact.visibleAt, surface: fact.surface, source: fact.source, clinical: fact.clinical ?? null })),
          // The language criteria this subject still has no answer for: what the run owes.
          requests: view.criteria.filter((criterion) => criterion.languageKeys.length)
            .flatMap((criterion) => criterion.languageKeys.filter((key) => !answered.includes(key)).map((key) => ({ criterionKey: key, criterionId: criterion.id }))),
        };
      }
      const [tallies, funnel, subjects, gaps] = await Promise.all([
        matchStore.assessmentTallies(study.id, protocol?.id ?? null),
        matchStore.criterionFunnelRows(study.id, protocol.id),
        matchStore.subjectSummaries(study.id, protocol?.id ?? null),
        matchStore.evidenceGapCounts(study.id, protocol?.id ?? null),
      ]);
      const offset = Math.max(0, Number(filter?.offset ?? 0));
      const limit = Math.max(1, Number(filter?.limit ?? 20));
      const factSubjects = await matchStore.factSubjects(study.id);
      const roster = await matchStore.candidateSubjects({ studyId: study.id });
      const known = new Map(subjects.map((row) => [row.subjectKey, row.summary]));
      const keys = [...new Set([...roster, ...known.keys(), ...factSubjects.map((entry) => entry.subjectKey)])].filter((key) => !withdrawn.has(key)).sort();
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
     * never reads it), the exact instant, and immutable references to the facts and language judgments.
     * @param {any} study @param {{protocolVersionId?:string,subjectKeys?:string[],direction?:string,offset?:number,asOf?:string,snapshotId?:string}} [selection]
     */
    async matchScenario(study, selection = {}) {
      selection = matchingSelection(selection);
      if (selection.snapshotId) {
        const previous = verifyMatchingSnapshot(await matchStore.matchingSnapshot(study.id, selection.snapshotId), study.id, selection.snapshotId);
        if (previous?.matchingEvaluatorVersion !== VCR_MATCHING_EVALUATOR_VERSION) throw new HttpError(409, 'vcr_matching_evaluator_changed', 'The matching evaluator changed. Queue a new evaluation.');
        const offset = selection.offset ?? previous.offset;
        if (offset < 0 || offset >= previous.subjects.length) throw new HttpError(400, 'vcr_matching_selection_invalid', 'Offset is outside the frozen candidate roster.');
        const payload = { ...previous, offset };
        const id = createHash('sha256').update(canonicalScenarioJson(payload)).digest('hex');
        await matchStore.saveMatchingSnapshot({ id, payload });
        return { ok: true, protocolVersionId: payload.protocolVersionId,
          scenario: { criteria: payload.criteria.map(criterion => ({ id: criterion.id, kind: criterion.kind, type: criterion.criterionType, state: 'unknown' })) },
          inputs: [{ kind: 'evidence', id: `matching:asof:${payload.asOf}` }, { kind: 'evidence', id: `matching:protocol:${payload.protocolVersionId}` },
            { kind: 'evidence', id: `${MATCHING_SNAPSHOT_PREFIX}${id}` }] };
      }
      const latest = await matchStore.latestProtocol(study.id);
      const protocol = selection.protocolVersionId ? { id: selection.protocolVersionId } : latest;
      const criteria = protocol ? await matchStore.listCriteria({ studyId: study.id, protocolVersionId: protocol.id }) : [];
      if (!protocol || !criteria.length) {
        return { ok: false, message: "还没有入排条件：先在方案步骤里写入排条件，再评估。" };
      }
      if (criteria.length > 500) return { ok: false, message: "入排条件超过 500 条，一次评估放不下。" };
      const minute = selection.asOf ? frozenAsOf(selection.asOf) : now().toISOString();
      const [facts, languages, roster] = await Promise.all([
        matchStore.listFacts({ studyId: study.id, visibleBy: minute }), matchStore.latestLanguageJudgments({ studyId: study.id, visibleBy: minute, protocolVersionId: protocol.id }),
        matchStore.candidateSubjects({ studyId: study.id, visibleBy: minute }),
      ]);
      let frozenTable = null;
      const tableIdentity = subjectTable?.identity ? await subjectTable.identity(study).catch(() => null) : null;
      if (subjectTable?.read) {
        // Freezing is where the meaning of the table's codes is settled: asked once, recorded, and the job runs on what was recorded.
        const table = await subjectTable.read(study, { variables: matchingVariablesOf(criteria), propose: true }).catch(() => null);
        if (table?.available) {
          const candidates = subjectTableFacts({...table,variables:[],limit:Number.POSITIVE_INFINITY}).subjects.map(row=>row.subjectKey);
          const withdrawn = await matchStore.withdrawnSubjects?.(study.id) ?? new Set();
          roster.push(...candidates.filter(key=>!roster.includes(key) && !withdrawn.has(key)));
          frozenTable = {snapshotId:table.snapshotId,sha256:table.sha256??null,identity:matchingTableIdentity(table),subjects:candidates,...(table.meaningStatus?{meaning:table.meaningStatus}:{})};
        }
      }
      if (selection.subjectKeys?.some(key => !roster.includes(key))) throw new HttpError(404, 'vcr_subject_not_found', 'A requested subject is not in this study at this time.');
      const subjects = selection.subjectKeys ?? roster;
      const offset = selection.offset ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0 || (subjects.length && offset >= subjects.length)) throw new HttpError(400, 'vcr_read_filter_invalid', 'The candidate offset is outside this roster.');
      const snapshot = freezeMatchingInputs({ studyId: study.id, protocolVersionId: protocol.id, asOf: minute, criteria, facts, languages,
        subjects, direction: selection.direction, offset, limit: VCR_MATCHING_MAX_SUBJECTS });
      if (frozenTable) {
        snapshot.payload.subjectTable = frozenTable;
        snapshot.id = matchingInputDigest(snapshot.payload);
      }
      await matchStore.saveMatchingSnapshot(snapshot);
      const judgments = [...languages.entries()].map(([subject, entry]) => [subject, Object.entries(entry).map(([key, value]) => [key, value.state, list(value.evidence).length])]);
      return {
        ok: true, protocolVersionId: protocol.id,
        scenario: { criteria: criteria.map((criterion) => ({
          id: criterion.id, kind: criterion.kind, type: criterion.criterionType, state: "unknown",
        })) },
        inputs: [...matchingInputs({ asOf: minute, protocolVersionId: protocol.id, facts, judgments, table: frozenTable ?? tableIdentity }), { kind: 'evidence', id: `${MATCHING_SNAPSHOT_PREFIX}${snapshot.id}` }],
      };
    },

    /** @param {any} study @param {any} raw @param {string} [actor] */
    async enqueuePanel(study, raw, actor = 'runtime') {
      if (!jobs) throw new HttpError(503, 'vcr_gateway_unavailable', 'Matching jobs are unavailable.');
      const selection = matchingSelection(raw);
      const protocols = selection.protocolVersionIds ?? [selection.protocolVersionId ?? null];
      const at = selection.asOf ?? now().toISOString();
      const queued = []; const unavailable = [];
      for (const protocolVersionId of protocols) {
        try {
          const { protocolVersionIds: _panel, ...single } = selection;
          const built = await this.matchScenario(study, selection.snapshotId ? single : { ...single, asOf: at, protocolVersionId });
          if (!built.ok) throw new HttpError(409, 'vcr_criteria_missing', built.message);
          const { job } = await jobs.enqueue({ studyId: study.id, userId: study.userId, kind: 'match_criteria',
            scenario: built.scenario, inputs: built.inputs, runId:study.executionOrigin?.runId ?? null,
            detail: { origin: actor, protocolVersionId: built.protocolVersionId,...(study.completionOrigin ? {conversationOrigin:study.completionOrigin} : {}) },
            idempotencyKey: `vcr:${study.id}:matching:${built.protocolVersionId}` });
          queued.push({ jobId: job.id, state: job.state, protocolVersionId: built.protocolVersionId });
        } catch (error) { unavailable.push({ protocolVersionId, code: String(/** @type {any} */ (error)?.code ?? 'vcr_matching_unavailable') }); }
      }
      return { jobs: queued, unavailable, requested: protocols.length, asOf: at };
    },

    /**
     * The finish hook of the job queue (`jobs.addFinishHook`): a `match_criteria`
     * job that succeeded has its per-subject assessments persisted, its
     * scientific assessments preserved without recruitment side effects. Every step isolates its own errors:
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
      /** @type {any[]} */
      const saved = [];
      let failed = 0;
      for (const assessment of list(result.assessments)) {
        try {
          saved.push(await matchStore.saveAssessment({
            userId: study.userId,
            assessment: {
              studyId: study.id, protocolVersionId: assessment.protocolVersionId ?? diagnostics.protocolVersionId ?? null,
              subjectKey: assessment.subjectKey, direction: assessment.direction, asOf: assessment.asOf, summary: assessment.summary,
              counts: assessment.counts, evidenceGaps: assessment.evidenceGaps, judgments: assessment.judgments, provenance: assessment.provenance,
            },
          }));
        } catch (error) {
          failed++;
          report(String(/** @type {any} */ (error)?.code ?? "vcr_assessment_save_failed"));
        }
      }
      if (failed) throw Object.assign(new Error('Matching assessments remain to be filed.'),{code:'vcr_assessment_save_failed'});
      return { persisted: saved.length, candidates: matchingCandidates({ studyId: study.id, assessments: saved }).length };
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
 *   entityVocabulary?: { tag: (input: { texts: string[] }) => Promise<string[] | null>, frontierItemsMatching?: (query: any) => Promise<any[]> } | null,
 *   sourceChanges?: { getMany?: (identifiers: unknown[]) => Promise<Map<string, any>> } | null,
 *   officialZoneForKeys?: ((keys: string[]) => Promise<string | null>) | null,
 *   predictionRegistry?: { register: (prediction: Record<string, any>) => Promise<any> } | null,
 *   usageLedger?: any,
 *   dataSemantics?: (() => any) | null,
 *   webReader?: { read: (url: string, options?: any) => Promise<{ text: string }> } | null,
 *   documentParser?: { configured: boolean, parseBytes: Function } | null,
 * }} input `dataSemantics`: the dataset-semantics service, as a function (it is built after this module); where it is off, the codes of a table stay unread.
 */
export function composeVcr({ config, productDatabase, projectStore = null, audit = async () => {}, fetchImpl, report = () => {}, connectorCredentials = null, intakeController = null, entityVocabulary = null, sourceChanges = null, officialZoneForKeys = null, predictionRegistry = null, usageLedger = null, dataSemantics = null, documentParser = null, webReader = null }) {
  if (!config?.vcrEnabled || !productDatabase) return null;

  // The shared entity vocabulary tags a study with what it is about (`entityVocabulary.mjs`).
  const store = new VcrStore({ database: productDatabase, entityVocabulary });
  const dataStore = new VcrDataStore({ database: productDatabase });
  const matchStore = new VcrMatchStore({ database: productDatabase });
  // Withdrawal, the retirement of a projection, and the marks on what was derived from a basis that has since changed.
  const erasure = new VcrErasureStore({ database: productDatabase, matchStore });
  // The trials a run found for a patient (「给患者找试验」): their own tables, never the study's protocol versions.
  const candidateStore = new VcrCandidateTrialStore({ database: productDatabase });
  const evidenceStore = new VcrEvidenceStore({ database: productDatabase });

  const access = new VcrAccess({ store: dataStore });
  const members = new VcrMembers({ store: dataStore, access });
  // One judge for the plane and the members' service: a decision the plane makes
  // is the decision the page shows.
  // The two intake conversions (a record document to text, a figure to curve
  // points) run in the runtime controller's disposable container. One counter
  // set serves both, so an operator reads one family of numbers.
  const intakeCounters = createIntakeCounters();
  const extractor = createVcrRecordExtractor({ config, controller: intakeController, counters: intakeCounters, report });
  // A source held in FHIR, OMOP or ADaM is converted in the same container (operation `convert`).
  const importer = createVcrImporter({ config, controller: intakeController, counters: intakeCounters, report });
  const dataPlane = String(config.vcrDataPlaneDir ?? "").trim()
    ? new VcrDataPlane({ store: dataStore, config, access, extractor, importer, erasure, scanReader: createVcrScanReader({ parser: documentParser, counters: intakeCounters, report }) })
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
  // One reading of whether the engine answers, for the job the page shows, readiness and the capability's label.
  const engineProbe = createVcrEngineProbe({ engine });

  // Patient documents are read through the plane's own judged, audited reader;
  // with no plane there are none, and a fact a run wrote about a document is void.
  const documents = vcrDocumentsSeam({ dataPlane, passagesMinChars: Number(config.vcrPassagesMinChars) > 0 ? Number(config.vcrPassagesMinChars) : undefined });
  const subjectTable = dataPlane ? vcrSubjectTableSeam({ dataPlane, semantics: dataSemantics, config, usageLedger, fetchImpl }) : null;
  const jobs = new VcrJobs({
    store, config, engine, report, dataPlane, engineObserver: engineProbe,
    localExecutors: { "matching.evaluate": vcrMatchingExecutor({ matchStore, store, documents, subjectTable }) },
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
    // The registries' public interfaces limit a caller's rate, and one search asks one of them dozens of times.
    paceMs: Number(config.vcrRegistryPaceMs) >= 0 ? Number(config.vcrRegistryPaceMs) : 250,
  });
  const trialCorpus = createVcrTrialCorpus(String(config.vcrTrialCorpusManifest ?? ""), { timeoutMs: Number(config.vcrRegistryTimeoutMs) || 20_000 });
  // A list of trials found for a patient is reordered against the run's summary of the patient (DashScope's reranker, the memory reranker's key and model; on where
  // the key exists) and kept as a receipt a judging job reads its trials from.
  const candidateSearches = new VcrCandidateSearchStore({ database: productDatabase });
  // Its spend is the platform's key's and is booked to the study's owner under purpose `vcr`, at the provider's own token count; where the deployment requires a durable ledger and
  // has none, the reranker is left off (the registries' order stands) rather than spending where nobody records it.
  const rerankMeter = createRerankMeter(usageLedger);
  const rerankAllowed = rerankMeter !== null || config.requireDurableUsageLedger !== true;
  const candidateReranker = new VcrCandidateRerank({
    apiKey: config.dashscopeApiKey, model: config.memoryRerankModel, apiBase: config.memoryRerankApiBase, enabled: rerankAllowed && (config.vcrMatchRerankEnabled ?? Boolean(config.dashscopeApiKey)),
    timeoutMs: config.vcrMatchRerankTimeoutMs, budgetMs: config.vcrMatchRerankBudgetMs, batchSize: config.vcrMatchRerankBatchSize,
  }, { fetchImpl: call, report });
  const evidence = createVcrEvidencePipeline({
    store: evidenceStore, registry, jobs, trialCorpus, reranker: candidateReranker, searches: candidateSearches, meter: rerankMeter,
    summaryCloudAllowed: dataPlane ? (/** @type {{ studyId: string, subjectKey?: string | null }} */ entry) => dataPlane.subjectCloudAllowed(entry) : null,
    retrieval: { retrieveMax: config.vcrCandidateRetrieveMax, deadlineMs: config.vcrCandidateRetrieveDeadlineMs, concurrency: config.vcrCandidateRetrieveConcurrency },
  });
  jobs.baselineVerifier = input => evidence.verifyBaselineTable(input);
  // A number a paper reports is held against the text the platform itself read of that paper (a capture in the project's workspace).
  if (projectStore) {
    evidence.attachPublications(createVcrPublicationSources({ resolveProject: async (userId, projectId) => {
      const owner = await projectStore.userById(userId);
      return projectStore.requireProject(owner, projectId);
    } }));
  }
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
    matchStore, store, documents, subjectTable, jobs, report, dataPlaneDir: String(config.vcrDataPlaneDir ?? ""),
    clinicalEnabled: study => clinicalEnrichmentOn(config.vcrClinicalStudyIds, study.id),
    clinicalContext: async (study,criteria) => clinicalTerminologyContext((await knowledge.studyPack(study))?.pack,criteria),
  });
  // Persist scientific assessments after the job commits, without recruitment side effects.
  jobs.addFinishHook((done) => matching.onJobFinished(done),'matching');
  const dataPlaneSeam = dataPlane ? vcrDataPlaneSeam({ dataPlane, dataStore, access }) : null;

  const patientTrials = createPatientTrials({ candidateStore, matchStore, documents, subjectTable, report });
  const service = new VcrService({
    store, config, engine, access, dataPlane: dataPlaneSeam, evidence, matching, jobs, seal, matchStore, evidenceStore, documents, patientTrials,
  });

  const longitudinal = createVcrLongitudinal({store,dataStore,dataPlane,matchStore,access,jobs,config,fetchImpl});
  if (longitudinal) {
    for (const method of Object.keys(VCR_LONGITUDINAL_METHODS)) jobs.localExecutors[method] = longitudinal.execute;
    service.attach({longitudinal});
  }

  // Judging patients against trials (owner decisions 2026-11-04): one job and one record for both directions; a conversation writes the same record through `trial_judgment`.
  const matchJudgments = new VcrMatchJudgmentStore({ database: productDatabase });
  const matchJudgeCounters = createMatchJudgeCounters();
  // A ChiCTR listing carries no eligibility text; its page is read through the platform's web reader (vcrRegistryPages), and a page that gives nothing is a pair judged on the listing.
  const registryPageCounters = createRegistryPageCounters();
  const registryPages = config.vcrRegistryPagesEnabled !== false && webReader
    ? createRegistryPages({ store: new VcrRegistryPageStore({ database: productDatabase }), webReader, config, report, counters: registryPageCounters }) : null;
  const judgeTargets = judgmentTargets({ evidence, matchStore, pages: registryPages });
  // Definition cards (`match_judge` selection `definitions: true`, off until measured): one model call a trial, kept by the trial's text.
  const pairJudge = createPairJudge({ config, usageLedger, fetchImpl: call, counters: matchJudgeCounters });
  const clauseDefinitionCounters = createClauseDefinitionCounters();
  const clauseDefinitions = createClauseDefinitions({ store: new VcrClauseDefinitionStore({ database: productDatabase }), judge: pairJudge, counters: clauseDefinitionCounters, report });
  jobs.localExecutors["matching.judge"] = createMatchJudgeExecutor({
    store, matchStore, judgments: matchJudgments, documents, subjectTable, targets: judgeTargets, config, report, counters: matchJudgeCounters, clauseDefinitions,
    judge: pairJudge,
  });
  const matchJudge = createMatchJudge({ jobs, matchStore, documents, subjectTable, judgments: matchJudgments, config, counters: matchJudgeCounters });
  /** @type {ReturnType<typeof createPatientDocumentRead> | null} */
  const patientDocuments = dataPlane ? createPatientDocumentRead({ store, dataStore, dataPlane, jobs, receipts: () => recordsOriginals.receipts, rejudge: (target, input) => matchJudge.rejudge(target, input) }) : null;
  // Many patients' records taken in as a job. The originals are the upload receipts', which the server builds after this module: until it says so, nothing can be located.
  const recordsOriginals = { receipts: /** @type {any} */ (null) };
  if (dataPlane) {
    dataPlane.attach({ originals: { forget: (/** @type {{ userId: string, projectId: string }} */ owner, /** @type {readonly string[]} */ digests) => recordsOriginals.receipts?.forgetOriginals?.(owner, digests) ?? 0 } });
    const importRecords = createRecordsImportExecutor({ store, dataStore, dataPlane, config, usageLedger, fetchImpl: call, report,
      locate: async (owner, handle) => recordsOriginals.receipts?.locate(owner, handle) ?? null });
    // One conversation's attachment rides the same job kind: same queue, same notice, same way back to the conversation.
    jobs.localExecutors["matching.import_records"] = (/** @type {any} */ work) => (work?.job?.scenario?.mode === "document" ? patientDocuments?.run(work) : importRecords(work));
  }
  const recordsImport = dataPlane ? createRecordsImport({ jobs, receipts: () => recordsOriginals.receipts }) : null;
  // Whether a pseudonym is a person of this study who may be added to: a document, a table row or a judgment says they are, and a withdrawal says they are not any more.
  const subjectKnown = async (/** @type {any} */ study, /** @type {string} */ subjectKey) => {
    if ((await matchStore.withdrawnSubjects?.(study.id) ?? new Set()).has(subjectKey)) return false;
    if ((await documents.roster(study)).some((/** @type {any} */ row) => row.subjectKey === subjectKey)) return true;
    if ((await tableFieldsOf(subjectTable, study))?.subjects.includes(subjectKey)) return true;
    return (await matchJudgments.list({ studyId: study.id, subjectKey, limit: 1 })).length > 0;
  };
  const matchJudgmentReads = createMatchJudgmentReads({ judgments: matchJudgments, documents, subjectTable, targets: judgeTargets, matchStore, rejudge: matchJudge });
  // The trials a person holds a verdict about, read again a few at a time; a verdict made of a record that has since changed is marked (G15).
  const registryWatchCounters = createRegistryWatchCounters();
  const registryWatch = config.vcrRegistryWatchEnabled !== false
    ? createRegistryWatch({ judgments: matchJudgments, targets: judgeTargets, config, report, counters: registryWatchCounters }) : null;

  const corrections = createVcrCorrectionCases({ store, matchStore, dataPlane, access });
  // The disease packs and the account's library of population definitions: read and written by the study's pages,
  // by the runtime's `pack` and `library` and by the population writer; the job queue is the comparison's.
  const knowledgeStore = new VcrKnowledgeStore({ database: productDatabase });
  const knowledge = new VcrKnowledge({ store: knowledgeStore, studyStore: store, dataStore, jobs,
    // Platform packs (flywheel F26): off, no platform row is read and the request is a 404 by its own code.
    platform: { enabled: Boolean(config.vcrPlatformPacksEnabled), publisherId: PLATFORM_PUBLISHER_USER_ID, sourceChanges, entityVocabulary, officialZoneForKeys,
      people: (ids) => store.personNames(ids) } });
  // The matching page's reader of the saved judgments, and the start of the judging job from the page.
  const matchResults = new VcrMatchResults({ database: productDatabase, judgments: matchJudgments, documents, matchStore, searches: candidateSearches, minCell: matchBatchMinCell(config) });
  service.attach({ corrections, knowledge, engineProbe, erasure, matchJudgments: matchJudgmentReads, matchJudge, matchResults, subjectKnown });
  // The study's project carries the study's name: the first definition names a draft, and the sidebar lists projects. A project the
  // researcher renamed since is left alone, like GEO's — the old name is the study's own, or one nobody gave.
  if (projectStore?.renameProject) {
    store.onStudyNamed = async ({ study, previousName }) => {
      if (study.scope === "conversation") return;
      const owner = await projectStore.userById(study.userId);
      if (!owner) return;
      const current = (await projectStore.listProjects(owner)).find((/** @type {any} */ project) => project.id === study.projectId);
      if (current && [previousName, VCR_DRAFT_STUDY_NAME, VCR_LEGACY_DEFAULT_STUDY_NAME].includes(current.name)) {
        await projectStore.renameProject(owner, study.projectId, [...String(study.name)].slice(0, 40).join(""));
      }
    };
  }
  // The public 「模拟研究」 column: the lead's publish and withdraw, and the reader the public pages package takes. Neither exists
  // while the switch is off, so nothing reads the table and the routes answer 404 by their own code.
  const publications = config.vcrPublicSimulationsEnabled ? createVcrPublications({ store, service, matchStore }) : null;
  const simulations = config.vcrPublicSimulationsEnabled ? createVcrPublicSimulations({ store }) : null;
  // The frontier feed's trial events (flywheel F24): a consumer the module's worker ticks, composed where the feed it reads is on. The
  // orchestrator and the notifier are composed later, so it asks for them when it needs them.
  const frontierEvents = config.vcrFrontierEventsEnabled && config.frontierEnabled !== false
    ? createVcrFrontierEvents({
      store, entityVocabulary, sourceChanges, report: (code) => report(code),
      orchestrator: () => composed?.orchestrator ?? null, notifier: () => composed?.notifier ?? null,
      levers: { studiesPerTick: config.vcrFrontierEventsStudiesPerTick, windowDays: config.vcrFrontierEventsWindowDays },
    }) : null;
  if (frontierEvents) service.attach({ frontierEvents });
  // Filing a prediction with the learning package's registry (flywheel F25): absent without one.
  const predictions = createVcrPredictions({ store, registry: predictionRegistry });
  // The generated records as a file (R10): read from the data plane, held to the hash the result recorded, synthetic rows only.
  const records = createVcrRecords({ store, config });
  service.attach({ records });
  composed = {
    publications, simulations, frontierEvents, predictions, records,
    store, dataStore, matchStore, erasure, candidateStore, candidateSearches, candidateReranker, clauseDefinitionCounters, patientTrials, evidenceStore, corrections, knowledge, knowledgeStore, longitudinal, matchJudge, matchJudgeCounters, matchJudgments, matchJudgmentReads, matchResults, registryWatch, registryWatchCounters, registryPages, registryPageCounters, subjectKnown, recordsImport, recordsOriginals, patientDocuments,
    access, members, dataPlane, dataPlaneSeam, documents, engine, engineProbe, engineStatus, removeEngineJob, jobs, seal, evidence, matching, registry, service,
    intake: { counters: intakeCounters, extractor, importer, digitizer },
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
  let matching = null;
  try {
    matching = await vcr.store.one(`SELECT ${MATCHING_RECORD_COUNTS.map(({ kind, from }) => `(SELECT count(*)::int FROM evimed_vcr.${from}) AS ${kind}`).join(", ")}`);
  } catch { /* Missing metrics never stop research or masquerade as zero. */ }
  // The receipts behind stored facts and judgments, by the model that answered the producing run's latest call (the run's own
  // ledger could say nothing for the rest). The operator's view of which model the study's evidence rests on; no run, request or hash.
  /** @type {Array<{ model: string, receipts: number }> | null} */
  let matchingProducers = null;
  try {
    matchingProducers = (await vcr.store.rows(`SELECT coalesce(NULLIF(provenance->'requests'->0->>'observedModel', ''), 'unrecorded') AS model, count(*)::int AS receipts
      FROM evimed_vcr.matching_producers GROUP BY 1 ORDER BY receipts DESC, model LIMIT ${MATCHING_PRODUCER_MODELS_SHOWN}`))
      .map((/** @type {any} */ row) => ({ model: String(row.model), receipts: Number(row.receipts) }));
  } catch { /* As above. */ }
  return {
    tables,
    matching,
    matchingProducers,
    service: vcr.service?.counters ?? {},
    jobs: vcr.jobs?.status?.() ?? null,
    completions:vcr.completions?.status?.() ?? null,
    orchestrator: vcr.orchestrator?.status?.() ?? null,
    worker: vcr.worker?.status?.() ?? null,
    engine: vcr.engineStatus ?? null,
    intake: vcr.intake ? { counters: { ...vcr.intake.counters } } : null,
    cloud: vcr.dataPlane?.counters ? { ...vcr.dataPlane.counters } : null,
    evidence: vcr.evidence?.counters ? { ...vcr.evidence.counters } : null,
    publications: vcr.publications ? { ...vcr.publications.counters, reads: Number(vcr.simulations?.counters?.reads ?? 0) } : null,
    predictions: vcr.predictions ? { ...vcr.predictions.counters } : null,
    patientTrials: vcr.patientTrials?.counters ? { ...vcr.patientTrials.counters } : null,
    candidateRerank: vcr.candidateReranker ? vcr.candidateReranker.counts() : null,
    clauseDefinitions: vcr.clauseDefinitionCounters ? { ...vcr.clauseDefinitionCounters } : null,
    matchJudge: vcr.matchJudgeCounters ? { ...vcr.matchJudgeCounters } : null,
    registryWatch: vcr.registryWatch ? { ...vcr.registryWatchCounters } : null,
    registryPages: vcr.registryPages ? { ...vcr.registryPageCounters } : null,
    frontierEvents: vcr.frontierEvents ? { ...vcr.frontierEvents.counters } : null,
    platformPacks: vcr.knowledge?.platform?.enabled
      ? Object.fromEntries(Object.entries(vcr.knowledge.counters).filter(([kind]) => kind.startsWith("platform"))) : null,
  };
}

/**
 * What the matching gauge counts, one row per `kind`: what it counts (in the words the runbook uses) and where it is counted from.
 * The query, the gauge's help and the runbook's paragraph all read these rows — `vcrMetricsRunbook.test.mjs` holds the runbook to them —
 * so the three cannot name different things. They are counts of stored rows over every revision; recall, latency and spend are not
 * here (the runbook says where each is read).
 * @type {ReadonlyArray<{ kind: string, counts: string, from: string }>}
 */
const MATCHING_RECORD_COUNTS = Object.freeze([
  { kind: "contextual_facts", counts: "facts written with the clinical block", from: "matching_facts WHERE clinical IS NOT NULL" },
  { kind: "legacy_facts", counts: "facts written without it", from: "matching_facts WHERE clinical IS NULL" },
  { kind: "producer_receipts", counts: "the model-call receipts behind facts and language judgments", from: "matching_producers" },
  { kind: "incomplete_assessments", counts: "assessments that ended insufficient_evidence", from: "matching_assessments WHERE summary='insufficient_evidence'" },
  { kind: "frozen_batches", counts: "frozen matching inputs", from: "matching_inputs" },
  { kind: "reviewed_projections", counts: "reviewed text projections of documents", from: "document_projections" },
]);
/** The most models the producer split names: the models behind a study's evidence are few, and a label set stays bounded. */
const MATCHING_PRODUCER_MODELS_SHOWN = 20;
/** The kinds of `open_science_vcr_matching_records` and what each counts. */
export const VCR_MATCHING_RECORD_KINDS = Object.freeze(Object.fromEntries(MATCHING_RECORD_COUNTS.map(({ kind, counts }) => [kind, counts])));

/**
 * The module's metric families, `open_science_vcr_*`, in the shape
 * `addMetric` takes. Off, it is the one gauge that says so.
 * @param {boolean} enabled @param {Awaited<ReturnType<typeof vcrMetricsSnapshot>> | null} snapshot
 */
export function vcrMetricFamilies(enabled, snapshot) {
  /** @type {{ name: string, help: string, type: "gauge" | "counter", series: { value: number, labels?: Record<string, string> }[] }[]} */
  const families = [{ name: "open_science_vcr_enabled", help: "Whether the 虚拟临床研究 module is composed in this process.", type: "gauge",
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
  if (snapshot.completions) add("completions_total", "Durable calculation result delivery outcomes since process start.", "counter",
    Object.entries(snapshot.completions).map(([outcome,value])=>({labels:{outcome},value:Number(value)})));
  if (snapshot.orchestrator?.counters) {
    add("orchestrator_total", "What the orchestrator did since this process started.", "counter",
      Object.entries(snapshot.orchestrator.counters).map(([kind, value]) => ({ labels: { kind }, value: Number(value) })));
  }
  if (snapshot.intake?.counters) {
    add("intake_total", "What the intake conversions did since this process started: record documents converted or refused (needsText, unreadable, tooLong, tooLarge), conversions that timed out, failed or had no converter, and figures digitized or refused.", "counter",
      Object.entries(snapshot.intake.counters).map(([kind, value]) => ({ labels: { kind }, value: Number(value) })));
  }
  if (snapshot.cloud) {
    add("cloud_reads_total", "Study documents authorized for a cloud model since this process started, by the basis they stood on (the deployment's provider agreements, or a permission recorded for the source), and the ones refused.", "counter",
      [{ labels: { basis: "deployment_agreements" }, value: Number(snapshot.cloud.cloudReadsDeploymentAgreements ?? 0) },
        { labels: { basis: "source_permission" }, value: Number(snapshot.cloud.cloudReadsSourcePermission ?? 0) },
        { labels: { basis: "refused" }, value: Number(snapshot.cloud.cloudReadsRefused ?? 0) }]);
  }
  if (snapshot.cloud) {
    add("erasure_total", "What withdrawal and the marks on changed bases did since this process started: subjects withdrawn, records and reviewed texts erased or retired, files overwritten (and the ones that could not be), and marks written on what was derived from a changed basis (and the ones that could not be).", "counter",
      [["withdrawals", "withdrawals"], ["documentsErased", "documentsErased"], ["projectionsRetired", "projectionsRetired"], ["filesOverwritten", "filesOverwritten"],
        ["overwriteFailures", "overwriteFailures"], ["marksWritten", "marksWritten"], ["marksFailed", "marksFailed"]]
        .map(([kind, key]) => ({ labels: { kind }, value: Number(/** @type {any} */ (snapshot.cloud)[key] ?? 0) })));
  }
  if (snapshot.evidence) {
    add("card_candidates_total", "Evidence items a run wrote as candidates it found through an evidence card (flywheel F23): written, and the ones that passed the quote and number check.", "counter",
      [{ labels: { outcome: "written" }, value: Number(snapshot.evidence.cardCandidates ?? 0) },
        { labels: { outcome: "verified" }, value: Number(snapshot.evidence.cardCandidatesVerified ?? 0) }]);
  }
  if (snapshot.predictions) {
    add("predictions_total", "Predictions of a registered trial's primary endpoint filed with the registry from a study's trial scenario (flywheel F25): filed, asked again, refused, and filings the registry did not take.", "counter",
      Object.entries(snapshot.predictions).map(([outcome, value]) => ({ labels: { outcome }, value: Number(value) })));
  }
  if (snapshot.patientTrials) {
    add("patient_trials_total", "What 「给患者找试验」 did since this process started: patients evaluated against a trial, evaluations that could not be made, the searches the page asked for.", "counter",
      Object.entries(snapshot.patientTrials).map(([kind, value]) => ({ labels: { kind }, value: Number(value) })));
  }
  if (snapshot.candidateRerank) {
    add("candidate_rerank_total", "What the reordering of a candidate list against the run's patient summary did since this process started (G11): batches that scored, documents scored, tokens booked to the usage ledger under purpose vcr, requests that came back with no token count, bookings that failed, and batches that failed by code (the list then keeps the registries' order).", "counter", [
      { labels: { kind: "batches" }, value: snapshot.candidateRerank.succeeded }, { labels: { kind: "documents" }, value: snapshot.candidateRerank.documents },
      { labels: { kind: "billed_tokens" }, value: snapshot.candidateRerank.billedTokens ?? 0 }, { labels: { kind: "unmetered_requests" }, value: snapshot.candidateRerank.unmetered ?? 0 }, { labels: { kind: "billing_failed" }, value: snapshot.candidateRerank.billingFailed ?? 0 },
      ...Object.entries(snapshot.candidateRerank.failed).map(([code, value]) => ({ labels: { kind: `failed:${code}` }, value: Number(value) }))]);
  }
  if (snapshot.clauseDefinitions) {
    add("clause_definitions_total", "What the definition cards of a trial's clauses did since this process started (built, off until measured): cards written by a model call, cards read from the cache, calls that failed (the pair is then read without a card), and clauses that got a card.", "counter",
      Object.entries(snapshot.clauseDefinitions).map(([kind, value]) => ({ labels: { kind }, value: Number(value) })));
  }
  if (snapshot.matchJudge) {
    add("match_judge_total", "What judging patients against trials did since this process started: jobs started, pairs judged and failed, model calls retried, jobs stopped by a budget, a ceiling or a run of upstream failures, jobs canceled, and records that changed under a job.", "counter",
      Object.entries(snapshot.matchJudge).map(([kind, value]) => ({ labels: { kind }, value: Number(value) })));
  }
  if (snapshot.registryWatch) {
    add("registry_watch_total", "What the registry watch did since this process started (G15): ticks, trials read again, trials whose record had changed, verdicts marked and marks cleared (the record went back), records the registry no longer has, reads that failed, and trials left for the next tick.", "counter",
      Object.entries(snapshot.registryWatch).map(([kind, value]) => ({ labels: { kind }, value: Number(value) })));
  }
  if (snapshot.registryPages) {
    add("registry_pages_total", "What the reading of ChiCTR record pages did since this process started (G10): pages read and their eligibility text kept, answers from the kept text, pages read that held no eligibility section, reads that failed, attempts not repeated because a recent one gave nothing, and old text kept when a new read failed.", "counter",
      Object.entries(snapshot.registryPages).map(([kind, value]) => ({ labels: { kind }, value: Number(value) })));
  }
  if (snapshot.platformPacks) {
    add("platform_packs_total", "What the platform knowledge packs did since this process started (flywheel F26): packs that passed the re-check and were copied, requests that failed it, authors who took their name off, and platform packs labelled 来源有变更.", "counter",
      Object.entries(snapshot.platformPacks).map(([kind, value]) => ({ labels: { kind: kind.replace(/^platform/, "").replace(/^./, (letter) => letter.toLowerCase()) }, value: Number(value) })));
  }
  if (snapshot.frontierEvents) {
    add("frontier_events_total", "What the frontier-events consumer did since this process started (flywheel F24): studies scanned, feed items read, precedent candidates raised or already in the library, cards labelled 有新证据, new-version runs requested, versions that took the news in (and those written after the plan froze), and scans that failed.", "counter",
      Object.entries(snapshot.frontierEvents).map(([kind, value]) => ({ labels: { kind }, value: Number(value) })));
  }
  if (snapshot.publications) {
    add("publications_total", "What the public 「模拟研究」 column did since this process started: reports published, publishes that found the live one, reports withdrawn, publications refused (the report not written, a subject named, not the lead's), and reads by the public reader.", "counter",
      Object.entries(snapshot.publications).map(([outcome, value]) => ({ labels: { outcome }, value: Number(value) })));
  }
  if (snapshot.matching) {
    add('matching_records', `Stored clinical matching records, counted over every revision, with no patient or study label. By kind: ${
      MATCHING_RECORD_COUNTS.map(({ kind, counts }) => `${kind} = ${counts}`).join('; ')}.`, 'gauge',
    MATCHING_RECORD_COUNTS.filter(({ kind }) => kind in snapshot.matching).map(({ kind }) => ({ labels: { kind }, value: Number(/** @type {any} */ (snapshot.matching)[kind]) })));
  }
  if (snapshot.matchingProducers?.length) {
    add('matching_producers', 'The model-call receipts behind stored matching facts and language judgments, by the model that answered the producing run\'s latest call (unrecorded where the run ledger could not say); no run, request or study label.', 'gauge',
      snapshot.matchingProducers.map(({ model, receipts }) => ({ labels: { model }, value: receipts })));
  }
  const loops = Object.entries(snapshot.worker?.loops ?? {}).filter(([, loop]) => loop?.wired);
  if (loops.length) {
    add("loop_last_ok_timestamp_seconds", "When each 虚拟临床研究 worker loop last finished without an error (Unix seconds; 0 = not since this process started).",
      "gauge", loops.map(([loop, state]) => ({ labels: { loop }, value: state.lastOkAt ? Math.floor(Date.parse(state.lastOkAt) / 1000) : 0 })));
    add("loop_stalled", "Whether a 虚拟临床研究 worker loop is still running past its lease (OPEN_SCIENCE_VCR_LEASE_MS).", "gauge",
      loops.map(([loop, state]) => ({ labels: { loop }, value: state.stalled ? 1 : 0 })));
  }
  return families;
}
