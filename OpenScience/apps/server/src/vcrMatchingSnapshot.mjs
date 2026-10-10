/** Frozen matching inputs contain references, not a second copy of patient text. */
import { matchingInputDigest } from './vcrMatching.mjs';
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

/** @param {{studyId:string, protocolVersionId:string, asOf:string, criteria:any[], facts:any[], languages:Map<string,Record<string,any>>, subjects:string[], direction?:string, offset?:number, limit?:number}} input */
export function freezeMatchingInputs(input) {
  const { studyId, protocolVersionId, asOf, criteria, facts, languages } = input;
  const payload = {
    schema: 1, studyId, protocolVersionId, asOf,
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
    if (!row || matchingInputDigest(row) !== ref.hash) throw new HttpError(409, 'vcr_matching_input_changed', 'A frozen fact is unavailable or changed.');
    return row;
  });
  /** @type {Map<string,Record<string,any>>} */
  const languages = new Map();
  for (const ref of snapshot.languages) {
    const row = languageMap.get(ref.id);
    if (!row || row.subjectKey !== ref.subjectKey || row.criterionKey !== ref.key
      || row.protocolVersionId !== snapshot.protocolVersionId || matchingInputDigest(languageInput(row)) !== ref.hash) {
      throw new HttpError(409, 'vcr_matching_input_changed', 'A frozen language judgment is unavailable or changed.');
    }
    const entries = languages.get(ref.subjectKey) ?? {};
    entries[ref.key] = languageInput(row);
    languages.set(ref.subjectKey, entries);
  }
  return { facts: selected, languages };
}
