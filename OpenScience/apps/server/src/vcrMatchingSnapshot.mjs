/** Frozen matching inputs contain references, not a second copy of patient text. */
import { ambiguousCriterionLanguageKeys, criterionLanguageKeys, matchingInputDigest, VCR_MATCHING_EVALUATOR_VERSION } from './vcrMatching.mjs';
import { HttpError } from './security.mjs';

export const MATCHING_SNAPSHOT_PREFIX = 'matching:snapshot:';

/** Selection names owned records; it never supplies facts or executable criteria.
 * @param {any} raw */
export function matchingSelection(raw = {}) {
  const fields = ['protocolVersionId', 'protocolVersionIds', 'subjectKeys', 'direction', 'asOf', 'offset', 'snapshotId'];
  const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
  const valid = raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).every(k => fields.includes(k))
    && (raw.protocolVersionId == null || id(raw.protocolVersionId))
    && (raw.protocolVersionIds == null || Array.isArray(raw.protocolVersionIds) && raw.protocolVersionIds.length > 0
      && raw.protocolVersionIds.length <= 10 && raw.protocolVersionIds.every(id))
    && !(raw.protocolVersionId && raw.protocolVersionIds)
    && (raw.subjectKeys == null || Array.isArray(raw.subjectKeys) && raw.subjectKeys.length > 0
      && raw.subjectKeys.length <= 5000 && raw.subjectKeys.every(id))
    && (raw.direction == null || ['trial_to_patient', 'patient_to_trial'].includes(raw.direction))
    && (raw.offset == null || Number.isSafeInteger(raw.offset) && raw.offset >= 0)
    && (raw.asOf == null || typeof raw.asOf === 'string' && Number.isFinite(Date.parse(raw.asOf)))
    && (raw.snapshotId == null || /^[a-f0-9]{64}$/.test(raw.snapshotId))
    && !(raw.snapshotId && Object.keys(raw).some(k => !['snapshotId', 'offset'].includes(k)));
  if (!valid) throw new HttpError(400, 'vcr_matching_selection_invalid', 'Select up to ten owned protocol versions and a bounded candidate roster.');
  return { ...raw, ...(raw.subjectKeys ? { subjectKeys: [...new Set(raw.subjectKeys)] } : {}),
    ...(raw.protocolVersionIds ? { protocolVersionIds: [...new Set(raw.protocolVersionIds)] } : {}) };
}

/** @param {any} row */
export function languageInput(row) {
  return { id: row.id, state: row.state, evidence: row.evidence ?? [],
    protocolVersionId: row.protocolVersionId ?? null, criterionHash: row.criterionHash ?? null,
    provenance: row.provenance ?? null };
}

/** A semantic binding survives an ordinal change, but not a changed requirement.
 * @param {readonly any[]} criteria @param {string} key */
export function languageCriterionHash(criteria, key) {
  return matchingInputDigest({ key, criteria: criteria.map(c => ({ id: c.id,
    requirement: c.requirement, applicability: c.applicability ?? null, sourceText: c.sourceText ?? '' })) });
}

/** Every unambiguous language key and the criteria hashed for its answers. @param {readonly any[]} criteria */
export function languageCriteriaByKey(criteria) {
  const ambiguous = ambiguousCriterionLanguageKeys(criteria);
  /** @type {Map<string, any[]>} */
  const bindings = new Map();
  for (const criterion of criteria) {
    for (const key of criterionLanguageKeys(criterion)) {
      if (ambiguous.has(key)) continue;
      const bound = bindings.get(key) ?? [];
      bound.push(criterion);
      bindings.set(key, bound);
    }
  }
  return bindings;
}

/** Keep both sets of quotations in the existing withdrawal-aware evidence column. @param {any} judgment */
export function storedCriterionEvaluation(judgment) {
  const evidence = [...(judgment.evidence ?? []),
    ...(judgment.applicabilityEvidence ?? []).map(item => ({ ...item, evaluationAxis: 'applicability' }))];
  const evaluation = judgment.applicabilityState == null ? null : {
    applicabilityState: judgment.applicabilityState, requirementState: judgment.requirementState,
    applicabilityMissing: judgment.applicabilityMissing, applicabilityRecheckAt: judgment.applicabilityRecheckAt,
    requirementMissing: judgment.requirementMissing,
    missing: judgment.missing,
  };
  return { evidence: JSON.stringify(evidence), evaluation: evaluation && JSON.stringify(evaluation) };
}

/** Historical rows carry their original evidence and do not acquire inferred axes. @param {any} row */
export function readCriterionEvaluation(row) {
  const evidence = Array.isArray(row.evidence) ? row.evidence : [];
  if (!row.evaluation) return { evidence };
  const applicabilityEvidence = evidence.filter(item => item?.evaluationAxis === 'applicability')
    .map(({ evaluationAxis: _axis, ...item }) => item);
  return { ...row.evaluation, evidence: evidence.filter(item => item?.evaluationAxis !== 'applicability'), applicabilityEvidence };
}

/** @param {{studyId:string, protocolVersionId:string, asOf:string, criteria:any[], facts:any[], languages:Map<string,Record<string,any>>, subjects:string[], direction?:string, offset?:number, limit?:number}} input */
export function freezeMatchingInputs(input) {
  const { studyId, protocolVersionId, asOf, criteria, facts, languages } = input;
  const payload = {
    schema: 1, studyId, protocolVersionId, asOf, matchingEvaluatorVersion: VCR_MATCHING_EVALUATOR_VERSION,
    direction: input.direction === 'patient_to_trial' ? 'patient_to_trial' : 'trial_to_patient',
    offset: input.offset ?? 0, limit: input.limit ?? 5000,
    criteria, subjects: [...new Set(input.subjects)].sort(),
    facts: facts.map(fact => ({ id: fact.id, hash: matchingInputDigest(fact) })).sort((a, b) => a.id.localeCompare(b.id)),
    languages: [...languages].flatMap(([subjectKey, rows]) => Object.entries(rows).map(([key, row]) => ({
      id: row.id, subjectKey, key, hash: matchingInputDigest(languageInput(row)),
    }))).sort((a, b) => a.id.localeCompare(b.id)),
  };
  return { id: matchingInputDigest(payload), payload };
}

/** @param {any} snapshot @param {string} studyId @param {string} id */
export function verifyMatchingSnapshot(snapshot, studyId, id) {
  if (!snapshot || snapshot.studyId !== studyId || snapshot.schema !== 1 || matchingInputDigest(snapshot) !== id) {
    throw new HttpError(409, 'vcr_matching_snapshot_unavailable', 'The frozen matching input is unavailable or changed. Queue a new evaluation.');
  }
  return snapshot;
}

/** @param {any} snapshot @param {any[]} facts @param {any[]} judgments */
export function hydrateMatchingInputs(snapshot, facts, judgments) {
  const factMap = new Map(facts.map(row => [row.id, row]));
  const languageMap = new Map(judgments.map(row => [row.id, row]));
  const selected = snapshot.facts.map((/** @type {any} */ ref) => {
    const row = factMap.get(ref.id);
    // A fact whose words were erased keeps the digest it was frozen under: the evaluation reads as withdrawn, not as changed.
    if (!row || (row.withdrawn?.digest ?? matchingInputDigest(row)) !== ref.hash) throw new HttpError(409, 'vcr_matching_input_changed', 'A frozen fact is unavailable or changed.');
    return row;
  });
  /** @type {Map<string,Record<string,any>>} */
  const languages = new Map();
  for (const ref of snapshot.languages) {
    const row = languageMap.get(ref.id);
    if (!row || row.subjectKey !== ref.subjectKey || row.criterionKey !== ref.key
      || row.protocolVersionId !== snapshot.protocolVersionId || (row.withdrawn?.digest ?? matchingInputDigest(languageInput(row))) !== ref.hash) {
      throw new HttpError(409, 'vcr_matching_input_changed', 'A frozen language judgment is unavailable or changed.');
    }
    const entries = languages.get(ref.subjectKey) ?? {};
    entries[ref.key] = languageInput(row);
    languages.set(ref.subjectKey, entries);
  }
  return { facts: selected, languages };
}
