/** Study-local correction references and deterministic replay; patient inputs never enter global fixtures. */
import { createHash } from 'node:crypto';
import { HttpError } from './security.mjs';
import { assessSubject, matchingEvaluationReport, matchingInputDigest, VCR_MATCHING_VOCABULARY_VERSION } from './vcrMatching.mjs';
import { vcrOutcomeReadable } from './vcrSeal.mjs';

export const VCR_CORRECTION_SCHEMA = 'vcr-correction-cases-1';
/** @param {any} value */
export const correctionHash = matchingInputDigest;
/** Same subject, same split for every protocol/criterion. No subject identifier is exported.
 * @param {string} studyId @param {string} subjectKey */
export function correctionPartition(studyId, subjectKey) {
  return createHash('sha256').update(`${studyId}\0${subjectKey}`).digest().readUInt32BE(0) % 5 === 0 ? 'held_out' : 'development';
}
/** @param {any} row */
export function publicCorrectionCase(row) {
  return { caseId: row.caseId, inputDigest: row.inputDigest, assessmentId: row.assessmentId, criterionId: row.criterionId, protocolVersionId: row.protocolVersionId,
    asOf: row.asOf, originalState: row.originalState, expectedState: row.expectedState, reviewerId: row.reviewerId, capturedAt: row.capturedAt,
    partition: row.partition, groupId: row.groupId, ruleHash: row.ruleHash, vocabularyVersion: row.vocabularyVersion,
    inputs: { facts: row.facts, language: row.language, documents: row.documents } };
}
/** @param {string} code @param {string} message */
const refused = (code, message) => new HttpError(409, code, message);

/** @param {{store:any,matchStore:any,dataPlane:any,access:any}} deps */
export function createVcrCorrectionCases({ store, matchStore, dataPlane, access }) {
  /** @param {string} studyId @param {string} principal */
  async function authorize(studyId, principal) {
    await access.require({ actor: principal, studyId, ability: 'export', purpose: 'vcr' });
    await access.require({ actor: principal, studyId, ability: 'read_patient_level', purpose: 'vcr' });
    const study = await store.studyById(studyId);
    if (!study) throw new HttpError(404, 'vcr_study_not_found', 'Study not found.');
    if (!vcrOutcomeReadable(study).readable) throw refused('vcr_evaluation_input_restricted', 'Sealed inputs cannot be replayed through correction cases.');
    return study;
  }
  /** Authorization is checked now, while asOf selects the frozen historical inputs.
   * @param {any} item @param {string} principal */
  async function hydrate(item, principal) {
    if (item.unavailable || item.vocabularyVersion !== VCR_MATCHING_VOCABULARY_VERSION) throw refused('vcr_evaluation_input_unavailable', 'This case has no supported frozen input version.');
    if (correctionHash(item.criterion) !== item.ruleHash) throw refused('vcr_evaluation_input_changed', 'The frozen criterion changed.');
    const assessment = await matchStore.getAssessment(item.assessmentId, item.studyId);
    if (!assessment || assessment.protocolVersionId !== item.protocolVersionId || new Date(assessment.asOf).toISOString() !== item.asOf) throw refused('vcr_evaluation_input_changed', 'The assessment reference changed.');
    if (correctionHash({ studyId: item.studyId, subjectKey: assessment.subjectKey }) !== item.subjectDigest) throw refused('vcr_evaluation_input_changed', 'The case subject reference changed.');
    const loaded = await matchStore.correctionInputs(item);
    /** @type {Record<string,{text:string}>} */
    const documents = {};
    let documentBytes = 0;
    if (item.documents.length > 20) throw refused('vcr_evaluation_input_unavailable', 'This case exceeds the document limit.');
    for (const ref of item.documents) {
      const file = await dataPlane?.store?.getSourceFile(item.studyId, ref.id);
      if (!file || file.role !== 'document' || file.sha256 !== ref.sha256 || file.sourceId !== ref.sourceId || file.bytes > 4 * 1024 * 1024) throw refused('vcr_evaluation_input_changed', 'A referenced source document changed or is unavailable.');
      documentBytes += Number(file.bytes);
      if (documentBytes > 8 * 1024 * 1024) throw refused('vcr_evaluation_input_unavailable', 'This case exceeds the source-byte limit.');
      const decision = await access.require({ actor: principal, studyId: item.studyId, sourceId: file.sourceId, ability: 'read_patient_level', purpose: 'vcr' });
      if (decision.grantId) {
        const grant = await matchStore.one('SELECT fields FROM evimed_vcr.grants WHERE id=$1 AND study_id=$2 AND revoked_at IS NULL', [decision.grantId, item.studyId]);
        if (!grant || grant.fields?.length) throw refused('vcr_evaluation_input_restricted', 'A field-limited grant cannot authorize whole-document replay.');
      }
      const document = await dataPlane.documentText({ studyId: item.studyId, documentId: ref.id, principal, purpose: 'vcr', maxBytes: 4 * 1024 * 1024 });
      if (document?.subjectKey !== assessment.subjectKey || createHash('sha256').update(document.text).digest('hex') !== ref.sha256) throw refused('vcr_evaluation_input_changed', 'The referenced document no longer belongs to this case.');
      documents[ref.id] = { text: document.text };
    }
    // The active correction path is document-anchored extraction. A stored value
    // without a checked source cannot gain authority by being placed in a case.
    if (loaded.facts.some(fact => fact.extractedBy !== 'model' || !documents[fact.source?.documentId])) throw refused('vcr_evaluation_input_unavailable', 'A fact has no supported authorized document reference.');
    for (const judgment of Object.values(loaded.modelJudgments)) {
      if ((/** @type {any} */ (judgment)).evidence.some(entry => !documents[entry.documentId])) throw refused('vcr_evaluation_input_unavailable', 'A language judgment has no authorized source.');
    }
    return { subjectKey: assessment.subjectKey, asOf: item.asOf, criteria: [item.criterion], ...loaded, documents,
      provenance: { vocabularyVersion: item.vocabularyVersion } };
  }
  /** @param {any[]} items @param {string} principal */
  async function verifyAll(items, principal) { for (const item of items) await hydrate(item, principal); }
  /** @param {string} studyId @param {string} datasetId */
  async function stored(studyId, datasetId) {
    if (!/^eds_[a-f0-9]{64}$/.test(datasetId ?? '')) throw new HttpError(404, 'vcr_evaluation_dataset_not_found', 'Dataset not found.');
    const manifest = await matchStore.evaluationDataset(studyId, datasetId);
    if (!manifest) throw new HttpError(404, 'vcr_evaluation_dataset_not_found', 'Dataset not found.');
    const { datasetId: _id, createdAt: _time, ...core } = manifest;
    if (`eds_${correctionHash(core)}` !== datasetId) throw refused('vcr_evaluation_input_changed', 'The dataset manifest changed.');
    const items = await matchStore.correctionCasesById(studyId, manifest.cases.map(row => row.caseId));
    if (items.length !== manifest.cases.length || items.some((item, index) => correctionHash(publicCorrectionCase(item)) !== correctionHash(manifest.cases[index]))) throw refused('vcr_evaluation_input_changed', 'A correction case changed.');
    return { manifest, items };
  }
  return {
    /** @param {{studyId:string,principal:string,after?:string,limit?:number}} request */
    async exportDataset({ studyId, principal, after = '0', limit = 100 }) {
      const study = await authorize(studyId, principal);
      if (typeof after !== 'string' || !/^\d{1,19}$/.test(after) || BigInt(after) > 9223372036854775807n || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new HttpError(400, 'vcr_evaluation_request_invalid', 'A bounded case page is required.');
      const page = await matchStore.correctionCases({ studyId, after, limit });
      await verifyAll(page.items, principal);
      const core = { schemaVersion: VCR_CORRECTION_SCHEMA, studyId, vocabularyVersion: VCR_MATCHING_VOCABULARY_VERSION,
        scope: 'document-anchored deterministic correction replay', cases: page.items.map(publicCorrectionCase),
        selection: { after, limit, more: page.more, nextCursor: page.nextCursor, legacyUnfrozen: page.legacyUnfrozen } };
      const datasetId = `eds_${correctionHash(core)}`;
      const prior = await matchStore.evaluationDataset(studyId, datasetId);
      if (prior) return prior;
      const manifest = { ...core, datasetId, createdAt: new Date().toISOString() };
      await matchStore.audit({ studyId, userId: study.userId, actor: principal, action: 'vcr.evaluation.dataset', object: datasetId, detail: { manifest } });
      return manifest;
    },
    /** @param {{studyId:string,principal:string,datasetId:string}} request */
    async readDataset({ studyId, principal, datasetId }) {
      await authorize(studyId, principal);
      const { manifest, items } = await stored(studyId, datasetId);
      await verifyAll(items, principal); return manifest;
    },
    /** Gold stays outside assessSubject. Only counts/states/reference ids are retained.
     * @param {{studyId:string,principal:string,datasetId:string}} request */
    async replay({ studyId, principal, datasetId }) {
      const study = await authorize(studyId, principal);
      const { manifest, items } = await stored(studyId, datasetId);
      await verifyAll(items, principal);
      const selected = items.filter(item => item.partition === 'held_out');
      if (!selected.length) throw refused('vcr_evaluation_holdout_unavailable', 'No held-out correction case is available in this dataset page.');
      const cases = []; const pairs = [];
      for (const item of selected) {
        const inputs = await hydrate(item, principal);
        const assessment = assessSubject(inputs);
        const predicted = assessment.judgments.find(row => row.criterionId === item.criterionId)?.state ?? 'unknown';
        cases.push({ caseId: item.caseId, original: item.originalState, expected: item.expectedState, predicted, matched: predicted === item.expectedState });
        pairs.push({ criterionType: item.criterion.criterionType, gold: item.expectedState, predicted });
      }
      const metrics = matchingEvaluationReport({ label: 'Held-out correction cases', criterionPairs: pairs, subjectPairs: [], synthetic: false });
      const report = { schemaVersion: VCR_CORRECTION_SCHEMA, datasetId, partition: 'held_out', vocabularyVersion: VCR_MATCHING_VOCABULARY_VERSION,
        evaluated: cases.length, matched: cases.filter(row => row.matched).length, criterion: metrics.criterion, cases,
        inputDigest: correctionHash(manifest.cases), extractionRerun: false,
        note: 'Deterministic replay of frozen facts and language judgments; no clinical accuracy or independent rater agreement is inferred.' };
      await matchStore.audit({ studyId, userId: study.userId, actor: principal, action: 'vcr.evaluation.replay', object: datasetId, detail: { report } });
      return report;
    },
  };
}
