/** Label-free inputs and exact source-clause projection for the native acceptance replay. */
import assert from 'node:assert/strict';
import { validateMatchingResult } from '../../packages/patient-matching-core/index.mjs';

const CASE_KEYS = new Set(['caseId', 'patientId', 'cohort', 'collection', 'split', 'note', 'candidateIds', 'candidateCount', 'dataClass']);
export function assertAcceptanceCase(row) {
  assert.ok(Object.keys(row).every(key => CASE_KEYS.has(key)), 'Runtime inputs may contain only the declared source fields');
  assert.ok(['incidents', 'criterion', 'n2c2'].includes(row.cohort), 'Only the declared non-TREC streams may be prepared');
  assert.ok(/^[a-z0-9-]+$/i.test(row.patientId) && typeof row.note === 'string' && row.note.length);
  assert.ok(['public-synthetic', 'public-benchmark-vignette', 'deidentified-clinical'].includes(row.dataClass));
  if (row.cohort === 'n2c2') assert.ok(row.candidateIds.length === 0 && row.candidateCount === 1, 'n2c2 judges one original guide protocol, not a fabricated registry trial');
  else assert.ok(row.candidateIds.length && row.candidateIds.length === row.candidateCount);
  assert.ok(row.candidateIds.every(id => /^NCT\d{8}$/.test(id)) && new Set(row.candidateIds).size === row.candidateIds.length);
  return row;
}
export function incidentInputs(cases) {
  return cases.map((one, index) => assertAcceptanceCase({ caseId: `inc-${one.id}`, patientId: `inc-${one.id}`,
    cohort: 'incidents', collection: 'tg2-sigir', split: 'regression', note: one.note,
    candidateIds: [`NCT9${String(index + 1).padStart(7, '0')}`], candidateCount: 1, dataClass: 'public-synthetic' }));
}
/** A continuation processes remaining frozen pairs; an unsuccessful segment is retained, never resampled. */
export function acceptanceStep(state) {
  if (state.ended || state.stopReason) return {};
  if (!state.context) return { tool: 'match_context', args: { messageSeq: 1 } };
  if (state.board === 'n2c2' && !state.protocol) return { tool: 'match_context', args: { messageSeq: 2, protocolText: state.protocolText, title: 'n2c2 2018 Track 1 cohort-selection annotation guide' } };
  if (state.result?.rows.every(row => row.current)) return {};
  if (state.nativeSegments > (state.lastSavedSegment ?? 0)) { state.stopReason = 'native_assessment_no_saved_progress'; return {}; }
  return { tool: 'match_assess', args: { taskId: state.protocol?.taskId ?? state.context.taskId, subjectKey: state.context.subjectKey,
    ...(state.protocol ? {} : { searchId: state.discovery.searchId }) } };
}
export const normalClause = text => typeof text === 'string' ? text.replace(/\s+/gu, ' ').trim() : null;
export function sixLabel(item) {
  if (item.verdict === 'unknown') return 'not enough information';
  if (item.verdict === 'not-applicable') return 'not applicable';
  if (item.kind === 'inclusion') return item.verdict === 'satisfied' ? 'included' : item.verdict === 'not-satisfied' ? 'not included' : null;
  if (item.kind === 'exclusion') return item.verdict === 'satisfied' ? 'excluded' : item.verdict === 'not-satisfied' ? 'not excluded' : null;
  return null;
}
/** Only unique, same-kind, whitespace-normalized literal clause equality may bridge annotations to native IDs. */
export function annotationMapping(clauses, profile) {
  return clauses.map(clause => {
    const text = normalClause(clause.text), matches = text ? profile.criteria.filter(item => item.kind === clause.kind && normalClause(item.text) === text) : [];
    const match = matches.length === 1 ? matches[0] : null;
    return { annotationId: clause.annotationId, kind: clause.kind, number: clause.number, text: clause.text,
      criterionId: match?.criterionId ?? null, backendNumber: match ? profile.criteria.filter(item => item.kind === clause.kind).indexOf(match) + 1 : null,
      nativePositionOneBased: match ? profile.criteria.indexOf(match) + 1 : null,
      state: match ? 'literal' : matches.length > 1 ? 'ambiguous' : 'unmapped' };
  });
}
/** The saved native decision owns every label. Mapping failures remain absent, which the official C scorer counts wrong. */
export function projectAcceptance({ patientId, result, profiles, requestedTrials }) {
  validateMatchingResult(result);
  const mappings = [], ranking = [];
  for (const trial of requestedTrials) {
    const profile = profiles.find(item => item.trialId === trial.registryId || trial.trialId && item.trialId === trial.trialId);
    const saved = profile && result.rows.find(row => row.trialId === profile.trialId);
    const mapping = profile ? annotationMapping(trial.clauses ?? [], profile) : (trial.clauses ?? []).map(clause => ({ ...clause, criterionId: null, backendNumber: null, state: 'profile-missing' }));
    mappings.push(...mapping.map(row => ({ patientId, registryId: trial.registryId, ...row })));
    const criteria = mapping.flatMap(clause => {
      const item = saved?.current && saved.criteria.find(value => value.criterionId === clause.criterionId);
      return item ? [{ number: clause.number, kind: item.kind, label: sixLabel(item), basis: item.basis, text: clause.text, clause: clause.text,
        evidenceIds: item.evidenceIds, sentenceIds: [], nativeCriterionId: item.criterionId }] : [];
    });
    // The incident instrument uses every native source clause, not an annotation list.
    if (!(trial.clauses?.length) && saved?.current) for (const item of saved.criteria) {
      const source = profile.criteria.find(value => value.criterionId === item.criterionId);
      criteria.push({ number: profile.criteria.indexOf(source), kind: item.kind, label: sixLabel(item), basis: item.basis, text: source?.text, clause: source?.text,
        evidenceIds: item.evidenceIds, sentenceIds: [] });
    }
    ranking.push({ registryId: trial.registryId, fit: saved?.recommendation.priority == null ? null : saved.recommendation.priority * 100,
      verdict: saved?.current ? ({ eligible: 'eligible', ineligible: 'ineligible', uncertain: 'insufficient', 'not-assessed': null })[saved.clinicalEligibility] : null,
      criteria, native: { current: saved?.current ?? false, state: saved?.state ?? 'missing', resultId: result.resultId, producer: saved?.producer ?? null } });
  }
  return { judgment: { patientId, status: ranking.every(row => row.native.current) ? 'complete' : 'partial', ranking }, mappings };
}
/** Frozen incident expectations; evidence checks refer to real saved passage IDs, never invented sentence numbers. */
export function incidentFindings(expect, entry) {
  if (!entry?.native.current) return ['no current native judgment'];
  const failures = [];
  if (expect.fit?.min != null && !(entry.fit != null && entry.fit >= expect.fit.min)) failures.push('recommendation_below_minimum_or_unset');
  if (expect.fit?.max != null && !(entry.fit != null && entry.fit <= expect.fit.max)) failures.push('recommendation_above_maximum_or_unset');
  if (expect.verdict && !expect.verdict.includes(entry.verdict)) failures.push('overall_verdict_mismatch');
  if (expect.verdictNot?.includes(entry.verdict)) failures.push('forbidden_overall_verdict');
  for (const want of expect.clauses ?? []) {
    const item = entry.criteria.find(row => row.text?.toLowerCase().includes(want.contains.toLowerCase()));
    if (!item) failures.push(`missing_clause:${want.contains}`);
    else {
      if (!want.labels.includes(item.label)) failures.push(`clause_label:${want.contains}`);
      if (want.evidence && !item.evidenceIds.length) failures.push(`missing_evidence:${want.contains}`);
    }
  }
  return failures;
}
