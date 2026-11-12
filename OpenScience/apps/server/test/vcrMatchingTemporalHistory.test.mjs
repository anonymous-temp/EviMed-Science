import assert from 'node:assert/strict';
import test from 'node:test';
import { assessSubject, evaluateRequirement, frozenAsOf, patientMatchingMetrics, storedExclusion, windowStart, VCR_MATCHING_EVALUATOR_VERSION, NOT_SATISFIED, SATISFIED, UNKNOWN } from '../src/vcrMatching.mjs';

const asOf = '2026-11-01T00:00:00.000Z';
const window = { months: 6 };
const event = (id, occurredAt, extra = {}) => ({ id, variable: 'event_history', polarity: 'affirmed', extractedBy: 'structured', occurredAt, ...extra });
const judge = (op, facts, selectedWindow = window) => evaluateRequirement({ op, variable: 'event_history', ...(selectedWindow ? { window: selectedWindow } : {}) }, { facts, asOf: Date.parse(asOf) });

test('one or several historical events do not establish absence within a later window', () => {
  const old = [event('first', '2020-01-01'), event('second', '2024-01-01')];
  for (const facts of [old.slice(0, 1), old]) {
    for (const op of ['present', 'absent']) {
      assert.equal(judge(op, facts).state, UNKNOWN, `${op}: older events leave later history incomplete`);
    }
    const assessment = assessSubject({ asOf, facts, criteria: [{ id: 'recent', kind: 'inclusion', requirement: { op: 'present', variable: 'event_history', window } }] });
    assert.equal(assessment.summary, 'insufficient_evidence');
  }
});

test('a later occurrence inside the window decides presence despite older occurrences', () => {
  const facts = [event('old', '2020-01-01'), event('recurrence', '2026-10-01')];
  assert.equal(judge('present', facts).state, SATISFIED);
  assert.equal(judge('absent', facts).state, NOT_SATISFIED);
  assert.deepEqual(judge('present', facts).evidence.map(row => row.factId), ['recurrence']);
  // No window asks about history of any occurrence, so the old event remains sufficient.
  assert.equal(judge('present', facts.slice(0, 1), null).state, SATISFIED);
  assert.equal(judge('absent', facts.slice(0, 1), null).state, NOT_SATISFIED);
});

test('future and undated events cannot establish windowed absence or presence', () => {
  const old = event('old', '2020-01-01');
  const future = event('future', '2027-01-01');
  const undated = event('undated', null);
  for (const facts of [[future], [old, future], [undated], [old, undated]]) {
    for (const op of ['present', 'absent']) assert.equal(judge(op, facts).state, UNKNOWN);
  }
  assert.equal(judge('present', [undated]).missing[0].reason, 'undated');
});

test('explicit valid negation remains decisive and scoped medication denials must cover the window', () => {
  const old = event('old', '2020-01-01');
  const denied = event('denied', null, { polarity: 'negated' });
  assert.equal(judge('absent', [old, denied]).state, UNKNOWN, 'an unscoped denial cannot cover a window');
  assert.equal(judge('present', [old, denied]).state, UNKNOWN);
  assert.equal(judge('absent', [denied], null).state, SATISFIED, 'unwindowed explicit negation remains decisive');
  const clinical = { schema: 1, assertion: 'negated', experiencer: 'patient', medication: { state: 'unknown', absenceScope: 'interval' }, occurredInterval: { start: '2026-05-01', end: '2026-11-01' } };
  const covered = { ...denied, clinical };
  assert.equal(judge('absent', [old, covered]).state, SATISFIED);
  assert.equal(judge('present', [old, covered]).state, NOT_SATISFIED);
  for (const incomplete of [
    { ...clinical, medication: { state: 'unknown', absenceScope: 'current' } },
    { ...clinical, occurredInterval: { start: '2026-06-01', end: '2026-11-01' } },
    { ...clinical, occurredInterval: { start: '2026-05-01', end: '2026-10-31' } },
  ]) {
    for (const op of ['present', 'absent']) assert.equal(judge(op, [old, { ...denied, clinical: incomplete }]).state, UNKNOWN);
  }
});

test('generic negative observations must cover the full requested interval, not just one date or a partial interval', () => {
  const clinical = { schema: 1, assertion: 'negated', experiencer: 'patient' };
  const denied = event('denied', '2020-01-01', { polarity: 'negated', clinical });
  const partial = { ...denied, occurredAt: '2026-11-01', clinical: { ...clinical, occurredInterval: { start: '2026-10-01', end: '2026-11-01' } } };
  const full = { ...partial, clinical: { ...clinical, occurredInterval: { start: '2026-05-01', end: '2026-11-01' } } };
  for (const fact of [denied, { ...denied, clinical: null }, { ...denied, occurredAt: null }, partial,
    { ...full, clinical: { ...full.clinical, occurredInterval: { start: '2026-05-01', end: '2026-10-31' } } }]) {
    for (const op of ['present', 'absent']) assert.equal(judge(op, [fact]).state, UNKNOWN);
  }
  assert.equal(judge('absent', [full]).state, SATISFIED);
  assert.equal(judge('present', [full]).state, NOT_SATISFIED);
  assert.equal(judge('present', [full, event('recurrence', '2026-10-15')]).state, SATISFIED);
});

test('source-bound MI denials preserve the difference between old, partial and full-window evidence', () => {
  const criteria = [{ id: 'no_recent_event', kind: 'inclusion', requirement: { op: 'absent', variable: 'myocardial_infarction', window } }];
  for (const [quote, occurredAt, occurredInterval, expected] of [
    ['2020-01-01: no MI.', '2020-01-01', null, 'insufficient_evidence'],
    ['From 2026-10-01 through 2026-11-01: no MI.', '2026-11-01', { start: '2026-10-01', end: '2026-11-01' }, 'insufficient_evidence'],
    ['From 2026-05-01 through 2026-11-01: no MI.', '2026-11-01', { start: '2026-05-01', end: '2026-11-01' }, 'eligible'],
  ]) {
    const fact = { id: 'fact', variable: 'myocardial_infarction', polarity: 'negated', extractedBy: 'model', surface: 'MI', occurredAt,
      clinical: { schema: 1, assertion: 'negated', experiencer: 'patient', ...(occurredInterval ? { occurredInterval } : {}) },
      provenance: { factSchema: 2 }, source: { documentId: 'record', start: 0, end: quote.length, quote } };
    const assessment = assessSubject({ asOf, criteria, facts: [fact], documents: { record: { text: quote } } });
    assert.deepEqual(assessment.voidedFacts, [], 'all examples have valid source quotations and printed dates');
    assert.equal(assessment.summary, expected, quote);
  }
});

test('calendar windows clamp missing UTC dates and keep both endpoints inclusive', () => {
  const asIso = (duration, anchor) => new Date(windowStart(duration, Date.parse(anchor))).toISOString();
  assert.equal(asIso({ months: 1 }, '2026-03-31T09:15:00.123Z'), '2026-02-28T09:15:00.123Z');
  assert.equal(asIso({ months: 1 }, '2024-03-31T09:15:00.123Z'), '2024-02-29T09:15:00.123Z');
  assert.equal(asIso({ months: 1 }, '2026-01-31'), '2025-12-31T00:00:00.000Z');
  assert.equal(asIso({ months: 6 }, '2026-08-31'), '2026-02-28T00:00:00.000Z');
  assert.equal(asIso({ years: 1 }, '2024-02-29'), '2023-02-28T00:00:00.000Z');

  const anchorDate = '2024-03-31T09:15:00.123Z';
  const criterion = { id: 'recent', kind: 'exclusion', requirement: storedExclusion({ op: 'present', variable: 'event_history', window: { months: 1, anchorDate } }) };
  const assess = (date) => assessSubject({ subjectKey: 'P', asOf, criteria: [criterion], facts: [event('event', date)] });
  for (const date of ['2024-02-29T09:15:00.123Z', '2024-02-29T09:15:00.124Z', anchorDate]) {
    assert.equal(assess(date).summary, 'ineligible', date);
  }
  for (const date of ['2024-02-29T09:15:00.122Z', '2024-03-31T09:15:00.124Z', null]) {
    assert.equal(assess(date).summary, 'insufficient_evidence', date ?? 'undated');
  }
  assert.equal(assess(anchorDate).provenance.matchingEvaluatorVersion, VCR_MATCHING_EVALUATOR_VERSION);
});

test('clamped calendar windows require a source-derived denial covering both boundaries', () => {
  const anchorDate = '2024-03-31';
  const selectedWindow = { months: 1, anchorDate };
  const clinical = { schema: 1, assertion: 'negated', experiencer: 'patient' };
  const denial = (start, end) => event('denial', end, { polarity: 'negated', clinical: { ...clinical, occurredInterval: { start, end } } });
  assert.equal(judge('absent', [denial('2024-02-29', anchorDate)], selectedWindow).state, SATISFIED);
  assert.equal(judge('absent', [denial('2024-03-01', anchorDate)], selectedWindow).state, UNKNOWN);
  assert.equal(judge('absent', [denial('2024-02-29', '2024-03-30')], selectedWindow).state, UNKNOWN);
});

test('an impossible source anchor does not roll into another calendar date', () => {
  const anchorDate = '2026-02-29';
  assert.throws(() => frozenAsOf(anchorDate), { code: 'vcr_asof_invalid' });
  assert.equal(frozenAsOf('2024-02-29T09:15'), '2024-02-29T09:15:00.000Z');
  const invalid = judge('present', [event('recent', '2026-02-25')], { months: 1, anchorDate });
  assert.equal(invalid.state, UNKNOWN);
  assert.equal(invalid.missing[0].reason, 'criterion_malformed');
});

test('source-bound washout requires dated lifetime denial or a denial covering the whole interval', () => {
  const asOf = '2026-11-04';
  const criteria = [{ id: 'washout', kind: 'inclusion', requirement: { op: 'elapsed_since', variable: 'prednisone', days: 14 } }];
  const examine = (text, occurredAt, clinical, factSchema = 2) => assessSubject({
    subjectKey: 'P', asOf, criteria, documents: { doc: { text } },
    facts: [{ id: 'denial', variable: 'prednisone', extractedBy: 'model', polarity: 'negated', surface: 'prednisone',
      occurredAt, clinical, provenance: { factSchema }, source: { documentId: 'doc', start: 0, end: text.length, quote: text } }],
  });
  const denial = { schema: 1, assertion: 'negated', experiencer: 'patient' };
  const lifetime = { ...denial, medication: { state: 'unknown', absenceScope: 'never' } };
  const interval = { ...denial, occurredInterval: { start: '2026-10-21', end: asOf } };
  for (const [text, date, clinical, schema, expected] of [
    ['2026-11-04: not taking prednisone today.', asOf, null, 2, 'insufficient_evidence'],
    ['2026-11-04: not taking prednisone today.', asOf, null, 1, 'insufficient_evidence'],
    ['Never received prednisone.', null, null, 1, 'eligible'],
    ['Never received prednisone.', null, lifetime, 2, 'insufficient_evidence'],
    ['2026-11-04: never received prednisone.', asOf, lifetime, 2, 'eligible'],
    ['2026-11-03: never received prednisone.', '2026-11-03', lifetime, 2, 'insufficient_evidence'],
    ['No prednisone from 2026-10-21 through 2026-11-04.', asOf, interval, 2, 'eligible'],
    ['No prednisone from 2026-10-22 through 2026-11-04.', asOf,
      { ...interval, occurredInterval: { ...interval.occurredInterval, start: '2026-10-22' } }, 2, 'insufficient_evidence'],
  ]) {
    const result = examine(text, date, clinical, schema);
    assert.deepEqual(result.voidedFacts, []);
    assert.equal(result.summary, expected, text);
  }
});

test('unresolved eligible patients reduce recall but are not measured as explicit exclusions', () => {
  const metrics = patientMatchingMetrics([
    { gold: 'eligible', predicted: 'eligible' },
    { gold: 'eligible', predicted: 'ineligible' },
    { gold: 'eligible', predicted: 'insufficient_evidence' },
    { gold: 'eligible', predicted: 'pending' },
  ]);
  assert.equal(metrics.eligibleRecall, 1 / 4);
  assert.equal(metrics.falseExclusionRate, 1 / 4);
  assert.equal(metrics.falseExclusions, 1);
  assert.equal(metrics.missedEligibleIncludingUnknown, 3);
  assert.equal(metrics.unknownEligibleRate, 2 / 4);
  assert.equal(metrics.falseNegative, 3, 'the established binary recall counter retains all nonsurfaced positives');
});
