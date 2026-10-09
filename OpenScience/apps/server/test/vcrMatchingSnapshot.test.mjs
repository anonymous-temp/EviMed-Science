import assert from 'node:assert/strict';
import test from 'node:test';
import { freezeMatchingInputs, hydrateMatchingInputs, languageCriterionHash, languageInput, MATCHING_SNAPSHOT_PREFIX, verifyMatchingSnapshot } from '../src/vcrMatchingSnapshot.mjs';
import { vcrMatchingExecutor } from '../src/vcrComposition.mjs';

const asOf = '2026-10-09T00:00:00.000Z';
const criteria = [{ id: 'crt_age', kind: 'inclusion', criterionType: 'demographic', requirement: { op: 'compare', variable: 'age', comparator: 'gte', value: 18 } }];
const fact = { id: 'fac_1', subjectKey: 'P-1', variable: 'age', value: 40, unit: 'year', polarity: 'affirmed', visibleAt: asOf, extractedBy: 'code' };
const judgment = { id: 'jdg_1', subjectKey: 'P-1', criterionKey: 'consent', state: 'satisfied', evidence: [], protocolVersionId: 'prt_1', criterionHash: 'binding' };
const freeze = (overrides = {}) => freezeMatchingInputs({ studyId: 'std_1', protocolVersionId: 'prt_1', asOf, criteria, facts: [fact],
  languages: new Map([['P-1', { consent: languageInput(judgment) }]]), subjects: ['P-1', 'P-empty'], ...overrides });

test('frozen references retain no patient text and reject changed facts, protocol, scope and manifest', () => {
  const snapshot = freeze();
  assert.equal(verifyMatchingSnapshot(snapshot.payload, 'std_1', snapshot.id), snapshot.payload);
  assert.throws(() => verifyMatchingSnapshot(snapshot.payload, 'std_other', snapshot.id), { code: 'vcr_matching_snapshot_unavailable' });
  assert.throws(() => verifyMatchingSnapshot({ ...snapshot.payload, subjects: [] }, 'std_1', snapshot.id), { code: 'vcr_matching_snapshot_unavailable' });
  assert.equal(snapshot.payload.facts[0].value, undefined);
  assert.equal(snapshot.payload.languages[0].evidence, undefined);
  const hydrated = hydrateMatchingInputs(snapshot.payload, [fact, { ...fact, id: 'fac_later' }], [judgment]);
  assert.deepEqual(hydrated.facts, [fact]);
  assert.throws(() => hydrateMatchingInputs(snapshot.payload, [{ ...fact, value: 17 }], [judgment]), { code: 'vcr_matching_input_changed' });
  assert.throws(() => hydrateMatchingInputs(snapshot.payload, [fact], [{ ...judgment, protocolVersionId: 'prt_other' }]), { code: 'vcr_matching_input_changed' });
  assert.notEqual(languageCriterionHash(criteria, 'consent'), languageCriterionHash([{ ...criteria[0], requirement: { op: 'language', text: 'new condition' } }], 'consent'));
});

test('executor accounts for an empty extraction, uses frozen facts and exposes continuation', async () => {
  const snapshot = freeze({ languages: new Map(), subjects: ['P-1', 'P-empty', 'P-next'], limit: 2, direction: 'patient_to_trial' });
  const matchStore = {
    async matchingSnapshot() { return snapshot.payload; },
    async matchingFactsByIds() { return [fact]; },
    async languageJudgmentsByIds() { return []; },
    async listFacts() { throw new Error('The live fact list must not be read'); },
  };
  const execute = vcrMatchingExecutor({ matchStore, store: { async studyById() { return { id: 'std_1' }; } } });
  const result = await execute({ job: { id: 'job_1', studyId: 'std_1', scenario: { criteria }, inputs: [
    { id: `matching:asof:${asOf}` }, { id: 'matching:protocol:prt_1' }, { id: `${MATCHING_SNAPSHOT_PREFIX}${snapshot.id}` },
  ] }, onProgress: async () => {} });
  assert.equal(result.assessments.length, 2);
  assert.equal(result.assessments[0].direction, 'patient_to_trial');
  assert.equal(result.assessments.find(row => row.subjectKey === 'P-empty').summary, 'insufficient_evidence');
  assert.equal(result.diagnostics.requestedSubjects, 3);
  assert.equal(result.diagnostics.nextOffset, 2);
  assert.equal(result.diagnostics.subjectsNotEvaluated, 1);
});
