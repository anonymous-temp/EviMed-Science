import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createHash } from 'node:crypto';
import { ControlPlaneDatabase } from '../src/controlPlaneDatabase.mjs';
import { composeVcr } from '../src/vcrComposition.mjs';
import { createVcrEvidenceSources } from '../src/vcrEvidenceSources.mjs';
import { poolEligibility, poolJob } from '../src/vcrEvidence.mjs';
import { vcrRuntimeWrite } from '../src/vcrGateway.mjs';
import { literatureNumericCandidates } from '../src/vcrModelSources.mjs';
import { createGeoTestDatabase } from './helpers/geoTestDatabase.mjs';

const options = { skip: !process.env.OPEN_SCIENCE_TEST_POSTGRES_URL && 'Owned local PostgreSQL is required' };
const owner = 'evidence_review_owner';
const projectId = 'evidence_review_project';
const digest = text => createHash('sha256').update(text).digest('hex');
let isolated, database, vcr;
const captures = new Map();
before(async () => {
  if (options.skip) return;
  isolated = await createGeoTestDatabase(process.env.OPEN_SCIENCE_TEST_POSTGRES_URL, 'vcrevidence');
  database = new ControlPlaneDatabase({ databaseUrl: isolated.url, databasePoolMax: 6, databaseConnectionTimeoutMs: 2000 });
  vcr = composeVcr({ productDatabase: database, config: { vcrEnabled: true, vcrAudience: 'all' } });
  await vcr.store.ready();
  vcr.evidence.attachSources(createVcrEvidenceSources({ sources: {
    get: async (_user, id) => captures.get(id)?.source,
    loadCapture: async (_user, source) => ({ input: { text: captures.get(source.id).text } }),
  } }));
});
after(async () => { await database?.close(); await isolated?.drop(); });

async function context(session) {
  return vcr.store.taskContext({ userId: owner, projectId, rootSessionId: session, sessionId: session, runId: 'review_run', callId: 'review_call' });
}
function capture(name, text) {
  const source = { id: `src_${name}`, userId: owner, projectId, payload: { generation: 1, analysis: { textSha256: digest(text) } } };
  captures.set(source.id, { source, text });
  return { sourceId: source.id, generation: 1, textSha256: digest(text) };
}
function span(text, quote) {
  const start = text.indexOf(quote);
  assert.ok(start >= 0);
  return { start, end: start + quote.length, quote };
}
async function add(study, literatureSource, text, changes = {}) {
  return vcr.evidence.addEvidenceItem({ userId: owner, studyId: study.id, projectId, item: {
    literatureSource, parameter: 'control_event_rate', arm: 'control', armRole: 'control', value: 0.4,
    unit: 'proportion', ciLow: 0.3, ciHigh: 0.5, historicalBaseline: true, endpointKey: 'response',
    quote: text, locator: span(text, text), ...changes,
  } });
}
const evidenceRow = id => vcr.store.one('SELECT * FROM evimed_vcr.evidence_items WHERE id=$1', [id]);

test('the bounded model-candidate scan cannot turn a partially scanned source number into another parameter', () => {
  for (const literal of ['1234', '-1234', '1.2e-3']) {
    const text = `${' '.repeat(999998)}${literal} months`;
    assert.deepEqual(literatureNumericCandidates(text, digest(text)), [], literal);
  }
});

test('PostgreSQL latest-only selection counts a registry/article trial once and keeps both trials of one article', options, async () => {
  const study = await context('trial_identity');
  const registryText = 'Control response 0.4 proportion; confidence interval 0.3 to 0.5.';
  await vcr.evidenceStore.savePrecedent({ userId: owner, studyId: study.id,
    precedent: { registry: 'clinicaltrials.gov', registryId: 'NCT00000001' }, recordText: registryText, recordHash: digest(registryText) });
  const registry = await vcr.evidence.addEvidenceItem({ userId: owner, studyId: study.id, item: {
    registryId: 'NCT00000001', parameter: 'control_event_rate', arm: 'control', armRole: 'control', value: 0.4,
    unit: 'proportion', ciLow: 0.3, ciHigh: 0.5, historicalBaseline: true, endpointKey: 'response', quote: registryText,
  } });
  const text = 'Trials NCT00000001 and NCT00000002: control response 0.4 proportion, CI 0.3 to 0.5.';
  const source = capture('two_trials', text);
  const articles = [];
  for (const registryId of ['NCT00000001', 'NCT00000002']) {
    const saved = await add(study, source, text, { trialIdentity: { registry: 'ctgov', registryId },
      locator: { ...span(text, text), parts: { trialIdentity: span(text, registryId) } } });
    assert.equal(saved.state, 'verified'); articles.push(saved);
  }
  const query = { userId: owner, studyId: study.id, parameter: 'control_event_rate', verifiedOnly: true };
  const all = await vcr.evidenceStore.listEvidenceItems(query);
  assert.equal(all.length, 3, 'append-only source versions remain available');
  const latest = await vcr.evidenceStore.listEvidenceItems({ ...query, latestOnly: true });
  assert.equal(latest.length, 2);
  assert.deepEqual(latest.map(row => row.detail.trialIdentity).sort(), ['clinicaltrials.gov:NCT00000001', 'clinicaltrials.gov:NCT00000002']);
  assert.ok(latest.some(row => row.id === articles[1].id), 'a second trial in the same article is retained');
  const eligibility = poolEligibility({ items: all, endpointKey: 'response', armRole: 'control' });
  assert.equal(eligibility.eligible.length, 2);
  assert.ok(eligibility.refused.some(row => row.reasons.includes('duplicate_trial')));
  const pooled = poolJob({ studyId: study.id, parameter: 'control_event_rate', calibre: 'overall', items: all });
  assert.equal(pooled.valid, true); assert.equal(pooled.job.scenario.studies.length, 2);
  assert.ok(pooled.job.scenario.studies.some(row => row.studyId === registry.id));
  assert.deepEqual(await vcr.evidenceStore.listEvidenceItems({ ...query, userId: 'foreign', latestOnly: true }), []);
});

test('trial identities require their own exact current source span and unidentified literature cannot be pooled', options, async () => {
  const study = await context('identity_span');
  const text = 'Trial NCT00000001: control response 0.4 proportion, CI 0.3 to 0.5.';
  const source = capture('identity_span', text);
  const identified = { registry: 'clinicaltrials.gov', registryId: 'NCT00000001' };
  const missing = await add(study, source, text, { trialIdentity: identified });
  assert.equal(missing.status, 'refused');
  const absent = await add(study, source, text, { trialIdentity: { ...identified, registryId: 'NCT00000002' },
    locator: { ...span(text, text), parts: { trialIdentity: span(text, 'NCT00000001') } } });
  assert.equal(absent.status, 'refused');
  for (const registry of ['chictr', 'ctis']) {
    const mismatched = await add(study, source, text, { trialIdentity: { registry, registryId: 'NCT00000001' },
      locator: { ...span(text, text), parts: { trialIdentity: span(text, 'NCT00000001') } } });
    assert.equal(mismatched.status, 'refused', `${registry} cannot reinterpret an NCT identifier`);
  }
  const clipped = await add(study, source, text, { trialIdentity: { trialKey: 'NCT0000000' },
    locator: { ...span(text, text), parts: { trialIdentity: span(text, 'NCT00000001') } } });
  assert.equal(clipped.status, 'refused', 'a clipped identifier is not a separately named trial');
  const alias = await add(study, source, text, { trialIdentity: { trialKey: 'NCT00000001' },
    locator: { ...span(text, text), parts: { trialIdentity: span(text, 'NCT00000001') } } });
  assert.equal(alias.state, 'verified');
  assert.equal((await evidenceRow(alias.id)).detail.trialIdentity, 'clinicaltrials.gov:NCT00000001');
  await assert.rejects(add(study, source, text, { trialIdentity: identified,
    locator: { ...span(text, text), parts: { trialIdentity: { ...span(text, 'NCT00000001'), start: 0 } } } }), { code: 'vcr_evidence_unverified' });
  await assert.rejects(add(study, { ...source, generation: 2 }, text), { code: 'source_changed' });
  await assert.rejects(add(study, { ...source, textSha256: 'f'.repeat(64) }, text), { code: 'source_changed' });
  const unknown = await add(study, source, text);
  assert.equal(unknown.state, 'verified');
  const pooled = poolEligibility({ items: [await evidenceRow(unknown.id)], endpointKey: 'response', armRole: 'control' });
  assert.deepEqual(pooled.refused[0].reasons, ['trial_identity_missing']);
});

test('persisted literature baseline bindings reject unit fragments and symbol-case substitutions', options, async () => {
  const study = await context('literal_units');
  for (const [index, quote, value, unit, expected] of [
    [0, 'Mean BMI was 27.1 kg/m2.', 27.1, 'kg', false],
    [1, 'Mean BMI was 27.1 kg/m².', 27.1, 'kg/m2', true],
    [2, 'Mean concentration was 2.5 mM.', 2.5, 'mm', false],
    [3, 'Mean concentration was 2.5 mM.', 2.5, 'mM', true],
  ]) {
    const source = capture(`unit_${index}`, quote);
    const saved = await add(study, source, quote, { parameter: 'metric.mean', value, unit, ciLow: null, ciHigh: null, evidenceKind: 'baseline' });
    const row = await evidenceRow(saved.id);
    assert.equal(row.locator.unitVerification.status === 'verified', expected);
    const checked = await vcr.evidence.verifyBaselineTable({ userId: owner, studyId: study.id,
      baselineTable: [{ variable: 'metric', mean: value }], bindings: [{ variable: 'metric', field: 'mean', unit, evidenceId: saved.id }] });
    assert.equal(checked.ok, expected);
  }
});

test('a derived numeric input cannot change a source sign, decimal, exponent or value by clipping its span', options, async () => {
  const study = await context('clipped_inputs');
  const text = 'Mean change -12.4 points; alternate change −15.3 points; age 62.4 years; estimate 1.2e-3 ratio.';
  const source = capture('clipped_inputs', text);
  for (const [quote, value] of [['12.4', 12.4], ['15.3', 15.3], ['62', 62], ['1.2', 1.2], ['2e-3', 0.002], ['-3', -3], ['3', 3]]) {
    const saved = await add(study, source, text, { value: 1, ciLow: null, ciHigh: null, valueSource: 'calculated',
      locator: { ...span(text, text), inputs: [{ ...span(text, quote), value }] } });
    assert.equal(saved.state, 'derived_input_not_found', quote);
    const row = await evidenceRow(saved.id);
    assert.equal(row.value, null); assert.equal(row.locator.verification, 'quote_not_found');
    assert.equal(row.locator.verificationDetail, 'derived_input_not_found');
  }
  const wrong = await add(study, source, text, { value: 1, ciLow: null, ciHigh: null, valueSource: 'calculated',
    locator: { ...span(text, text), inputs: [{ ...span(text, '62.4'), value: 62.5 }] } });
  assert.equal(wrong.state, 'derived_input_not_found');
  const complete = await add(study, source, text, { value: 1, ciLow: null, ciHigh: null, valueSource: 'calculated',
    locator: { ...span(text, text), inputs: [['-12.4', -12.4], ['−15.3', -15.3], ['1.2e-3', 0.0012]].map(([quote, value]) => ({ ...span(text, quote), value })) } });
  assert.equal(complete.state, 'verified', 'complete signed/scientific source literals remain usable');
});

test('quoted-input-only derivations preserve provenance but cannot become direct-value cards or reported baselines', options, async () => {
  const study = await context('derived_card');
  const text = 'Mean age 62.4 years and sample size 100.';
  const source = capture('derived_card', text);
  const inputs = [{ ...span(text, '62.4'), value: 62.4 }, { ...span(text, '100'), value: 100 }];
  const saved = await add(study, source, text, { value: 0.45, ciLow: null, ciHigh: null, valueSource: 'calculated',
    locator: { ...span(text, text), inputs } });
  assert.equal(saved.state, 'verified');
  const row = await evidenceRow(saved.id);
  assert.equal(Number(row.value), 0.45); assert.equal(row.historical_baseline, false);
  assert.equal(row.detail.verificationScope, 'quoted_inputs_only');
  assert.equal(row.locator.sourceHash, source.textSha256); assert.equal(row.locator.generation, source.generation);
  assert.deepEqual(row.locator.inputs, inputs);
  const written = await vcrRuntimeWrite({ store: vcr.store, service: vcr.service, orchestrator: null, study,
    evidence: vcr.evidence, evidenceStore: vcr.evidenceStore, what: 'assumption', items: [{ key: 'derived_control',
      parameter: 'control_event_rate', unit: 'proportion', sourceKind: 'external_evidence', evidenceIds: [saved.id] }], data: null });
  assert.equal(written.ok, false); assert.equal(written.ids.length, 0);
  assert.ok(written.issues.some(issue => issue.code === 'vcr_evidence_unverified'));
  assert.equal((await vcr.store.one('SELECT count(*)::int AS n FROM evimed_vcr.assumptions WHERE study_id=$1', [study.id])).n, 0);
  const derivedBaseline = await add(study, source, text, { parameter: 'age.mean', value: 63, unit: 'year', evidenceKind: 'baseline',
    ciLow: null, ciHigh: null, valueSource: 'calculated', locator: { ...span(text, text), inputs } });
  const baseline = await vcr.evidence.verifyBaselineTable({ userId: owner, studyId: study.id,
    baselineTable: [{ variable: 'age', mean: 63 }], bindings: [{ variable: 'age', field: 'mean', unit: 'year', evidenceId: derivedBaseline.id }] });
  assert.equal(baseline.ok, false); assert.ok(baseline.issues.some(issue => issue.code === 'reported_baseline_required'));
  await assert.rejects(add(study, source, text, { valueSource: 'calculated', locator: { ...span(text, text), inputs: ['n'] } }), { code: 'vcr_evidence_unverified' });
});

test('literature-population jobs cannot claim cited correlation from verified marginals alone', options, async () => {
  const study = await context('correlation');
  const text = 'Mean age 62.4 years; SD 8 years.';
  const source = capture('correlation', text);
  const bindings = [];
  for (const [field, value] of [['mean', 62.4], ['sd', 8]]) {
    const saved = await add(study, source, text, { parameter: `age.${field}`, value, unit: 'year', ciLow: null, ciHigh: null, evidenceKind: 'baseline' });
    assert.equal(saved.state, 'verified'); bindings.push({ variable: 'age', field, unit: 'year', evidenceId: saved.id });
  }
  const scenario = { baselineTable: [{ variable: 'age', mean: 62.4, sd: 8 }], baselineBindings: bindings, n: 20, correlation: [[1]], correlationSource: 'cited' };
  await assert.rejects(vcr.jobs.enqueue({ studyId: study.id, userId: owner, kind: 'literature_population', scenario }), error => {
    assert.equal(error.code, 'vcr_job_scenario_invalid');
    assert.ok(error.issues.some(issue => issue.code === 'vcr_evidence_unverified' && issue.detail === 'correlation_source_unverified'));
    return true;
  });
  assert.equal((await vcr.store.one('SELECT count(*)::int AS n FROM evimed_vcr.jobs WHERE study_id=$1', [study.id])).n, 0);
  const queued = await vcr.jobs.enqueue({ studyId: study.id, userId: owner, kind: 'literature_population', scenario: { ...scenario, correlationSource: 'assumed' } });
  assert.equal(queued.job.checkpoint.literatureBaseline.verification, 'marginals_source_verified');
  assert.equal(queued.job.checkpoint.literatureBaseline.correlation, 'assumed');
  const frozen = await vcr.store.one('SELECT inputs FROM evimed_vcr.jobs WHERE id=$1', [queued.job.id]);
  assert.deepEqual(frozen.inputs.map(row => row.id).sort(), bindings.map(row => row.evidenceId).sort());
});
