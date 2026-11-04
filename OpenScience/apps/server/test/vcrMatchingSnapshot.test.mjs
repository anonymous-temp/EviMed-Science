import assert from 'node:assert/strict';
import test from 'node:test';
import { freezeMatchingInputs, hydrateMatchingInputs, languageCriterionHash, languageInput, MATCHING_SNAPSHOT_PREFIX, readCriterionEvaluation, storedCriterionEvaluation, verifyMatchingSnapshot } from '../src/vcrMatchingSnapshot.mjs';
import { vcrMatchingExecutor } from '../src/vcrComposition.mjs';
import { matchingInputDigest, VCR_MATCHING_EVALUATOR_VERSION } from '../src/vcrMatching.mjs';
import { redactedEvidence } from '../src/vcrErasureStore.mjs';
import { vcrSchemaSql } from '../src/vcrPersistence.mjs';

const asOf = '2026-10-09T00:00:00.000Z';
const criteria = [{ id: 'crt_age', kind: 'inclusion', criterionType: 'demographic', requirement: { op: 'compare', variable: 'age', comparator: 'gte', value: 18 } }];
const fact = { id: 'fac_1', subjectKey: 'P-1', variable: 'age', value: 40, unit: 'year', polarity: 'affirmed', visibleAt: asOf, extractedBy: 'code' };
const judgment = { id: 'jdg_1', subjectKey: 'P-1', criterionKey: 'consent', state: 'satisfied', evidence: [], protocolVersionId: 'prt_1', criterionHash: 'binding' };
const freeze = (overrides = {}) => freezeMatchingInputs({ studyId: 'std_1', protocolVersionId: 'prt_1', asOf, criteria, facts: [fact],
  languages: new Map([['P-1', { consent: languageInput(judgment) }]]), subjects: ['P-1', 'P-empty'], ...overrides });

test('frozen references retain no patient text and reject changed facts, protocol, scope and manifest', () => {
  const snapshot = freeze();
  const { matchingEvaluatorVersion, ...legacy } = snapshot.payload;
  assert.equal(matchingEvaluatorVersion, VCR_MATCHING_EVALUATOR_VERSION);
  assert.notEqual(matchingInputDigest(legacy), snapshot.id);
  assert.equal(verifyMatchingSnapshot(legacy, 'std_1', matchingInputDigest(legacy)), legacy, 'historical manifests remain readable');
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

test('applicability wording belongs to the language answer binding independently of ordinal', () => {
  const withPremise = [{ ...criteria[0], ordinal: 1, applicability: { op: 'language', key: 'premise', text: 'Has the subtype been established?' } }];
  const binding = languageCriterionHash(withPremise, 'premise');
  assert.equal(languageCriterionHash([{ ...withPremise[0], ordinal: 2 }], 'premise'), binding);
  assert.notEqual(languageCriterionHash([{ ...withPremise[0], applicability: { ...withPremise[0].applicability, text: 'Is the subtype suspected?' } }], 'premise'), binding);
});

test('persisted judgment axes preserve legacy rows and applicability citations obey withdrawal', () => {
  const sql = vcrSchemaSql();
  for (const table of ['criterion_judgments', 'candidate_trial_judgments']) {
    assert.ok(sql.includes(`ALTER TABLE evimed_vcr.${table} ADD COLUMN IF NOT EXISTS evaluation jsonb;`));
  }
  const evidence = [{ quote: 'Requirement evidence', locator: { documentId: 'requirement' } }];
  const applicabilityEvidence = [{ quote: 'Premise evidence', locator: { documentId: 'premise' } }];
  const axes = { requirementState: 'not_satisfied', applicabilityState: 'unknown',
    requirementMissing: [], applicabilityMissing: [{ variable: 'subtype', reason: 'not_recorded' }],
    missing: [{ variable: 'subtype', reason: 'not_recorded' }] };
  const stored = storedCriterionEvaluation({ evidence, applicabilityEvidence, ...axes });
  assert.deepEqual(readCriterionEvaluation({ evidence, evaluation: null }), { evidence });
  assert.deepEqual(readCriterionEvaluation({ evidence: JSON.parse(stored.evidence), evaluation: JSON.parse(stored.evaluation) }),
    { ...axes, evidence, applicabilityEvidence });
  const withdrawn = redactedEvidence(JSON.parse(stored.evidence), item => item.locator.documentId === 'premise');
  const restored = readCriterionEvaluation({ evidence: withdrawn.evidence, evaluation: JSON.parse(stored.evaluation) });
  assert.deepEqual(restored.evidence, evidence);
  assert.equal(restored.applicabilityEvidence[0].quote, '');
  assert.equal(restored.applicabilityEvidence[0].withdrawn, true);
  assert.doesNotMatch(stored.evaluation, /Premise evidence/);
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

test('a frozen reference to a fact or a judgment whose words were erased still verifies, under the digest it was frozen with, and reads as withdrawn', () => {
  const snapshot = freeze();
  // What the erasure writes: the words are gone, the digest of what the row was is kept beside them.
  const erasedFact = { ...fact, value: null, surface: '', withdrawn: { at: asOf, digest: snapshot.payload.facts[0].hash, cause: 'withdrawn' } };
  const erasedJudgment = { ...judgment, evidence: [{ documentId: 'sfl_1', quote: '', quoteHash: 'a'.repeat(64), withdrawn: true }], withdrawn: { at: asOf, digest: snapshot.payload.languages[0].hash, cause: 'withdrawn' } };
  const hydrated = hydrateMatchingInputs(snapshot.payload, [erasedFact], [erasedJudgment]);
  assert.equal(hydrated.facts[0].withdrawn.cause, 'withdrawn');
  assert.equal(hydrated.languages.get('P-1').consent.state, 'satisfied');
  // The kept digest is the only thing that makes it verify: a withdrawn row that carries another one is a changed input.
  assert.throws(() => hydrateMatchingInputs(snapshot.payload, [{ ...erasedFact, withdrawn: { ...erasedFact.withdrawn, digest: 'b'.repeat(64) } }], [erasedJudgment]), { code: 'vcr_matching_input_changed' });
  assert.throws(() => hydrateMatchingInputs(snapshot.payload, [erasedFact], [{ ...erasedJudgment, withdrawn: { ...erasedJudgment.withdrawn, digest: 'b'.repeat(64) } }]), { code: 'vcr_matching_input_changed' });
});
