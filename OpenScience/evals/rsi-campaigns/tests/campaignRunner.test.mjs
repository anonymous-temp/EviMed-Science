import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RSI_QUARTER_ALPHA, campaignPlan, confirmationDecision, digest, evaluateStatistics, evaluationRequest, labPreflight, rsiCampaignQuarter, runCampaign } from '../campaign_runner.mjs';
import { frontierCampaignConsumerIdentity } from '../frontier_campaign.mjs';
import {
  BENIGN_CLAIM_ALPHA, INCIDENT_AUTHORIZATION, STATISTICS_MODULE_PATH, STATISTICS_PYTHON, attachStatistics, attestationFrom, benignCampaignFixture, labAttest, labConfiguration, memoryCampaignStore,
  registeredCampaignFixture, runToVerdict, runnerEnvironment, tickingClock, withSource, writeSignedReceipt,
} from '../profiles/benign_fixture.mjs';

const workDir = await mkdtemp(join(tmpdir(), 'rsi-runner-'));
after(() => rm(workDir, { recursive: true, force: true }));
let counter = 0;
const nextDir = () => join(workDir, `case-${counter++}`);
const ISSUED = '2026-10-26T02:30:00.000Z';
const ID = 'benign-frontier-campaign';

/** Run a registered fixture through development and confirmation to the evaluator request, keeping what a later step forks from. */
async function atEvaluation(options = {}, { store = memoryCampaignStore(), now = tickingClock() } = {}) {
  const fixture = options.manifest ? options : await registeredCampaignFixture(options);
  const result = await runCampaign({ ...fixture, ...runnerEnvironment({ store, now }) });
  assert.equal(result.status, 'awaiting-evaluation', JSON.stringify(result).slice(0, 400));
  return { fixture, store, result, request: result.request, state: store.state(fixture.manifest.id) };
}
/** A new store holding what the snapshot's campaign had reached: a resume in another process. */
function fork(snapshot) {
  const store = memoryCampaignStore({ ledger: new Map(snapshot.store.ledger), corpora: new Map(snapshot.store.corpora) });
  store.putState(snapshot.fixture.manifest.id, snapshot.state);
  return store;
}
/** Resume a snapshot with a receipt the evaluator signed (optionally altered before signing). */
async function resume(snapshot, { mutatePayload, attestEvaluation, store = fork(snapshot), now = tickingClock('2026-10-26T03:00:00.000Z'), ...overrides } = {}) {
  if (!attestEvaluation) {
    const signed = await writeSignedReceipt({ manifest: snapshot.fixture.manifest, inputs: snapshot.fixture.inputs, request: snapshot.request, checkpoint: snapshot.state, dir: nextDir(), now: ISSUED, mutatePayload });
    attestEvaluation = await attestationFrom(signed.profile, ISSUED);
  }
  const result = await runCampaign({ ...snapshot.fixture, ...runnerEnvironment({ store, now }), attestEvaluation, ...overrides });
  return { result, store, state: store.state(snapshot.fixture.manifest.id) };
}
const recomputeRegistration = (fixture) => { fixture.manifest.registration.digest = digest(fixture.inputs.registration); return fixture; };

test('unbound runner performs no checkpoint or consumer effects', async () => {
  let touched = false;
  const result = await runCampaign({ configuration: {}, store: { withCampaign() { touched = true; } }, manifest: {} });
  assert.equal(result.reason, 'campaign_host_unavailable');
  assert.equal(touched, false);
});

test('the lab must prove its isolation before anything runs', async () => {
  assert.deepEqual(await labPreflight(labConfiguration, labAttest), { status: 'ready' });
  assert.deepEqual(await labPreflight(labConfiguration), { status: 'not-qualified', reason: 'campaign_isolation_unverified' });
  const cases = [{ role: 'someone_else' }, { database: 'evimed_product' }, { hostInstanceId: 'i-other' }, { hostPurpose: 'serving' }];
  for (const change of cases) assert.equal((await labPreflight(labConfiguration, async () => ({ ...(await labAttest()), ...change }))).reason, 'campaign_isolation_unverified', JSON.stringify(change));
  assert.equal((await labPreflight(labConfiguration, async () => { throw new Error('connection refused'); })).reason, 'campaign_isolation_unverified');
  const { host, ...withoutHost } = labConfiguration;
  assert.equal((await labPreflight(withoutHost, labAttest)).reason, 'campaign_host_unavailable');
  // Through the runner: a store that was never touched, nothing written.
  const fixture = await registeredCampaignFixture();
  const store = memoryCampaignStore();
  for (const attestLab of [undefined, async () => ({}), async () => { throw new Error('x'); }]) {
    const result = await runCampaign({ ...fixture, ...runnerEnvironment({ store }), attestLab });
    assert.deepEqual(result, { status: 'not-qualified', reason: 'campaign_isolation_unverified' });
  }
  assert.equal(store.writes(), 0);
});

test('the development and confirmation stages run once each and stop at the evaluator\'s request', async () => {
  const { fixture, store, result, state } = await atEvaluation();
  const { manifest, inputs } = fixture;
  const statistics = inputs.registration.statistics;
  assert.equal(result.binding, digest({ manifest, inputs }));
  assert.deepEqual([state.recordType, state.campaignId, state.automated, state.binding], ['rsi-campaign-checkpoint', ID, true, result.binding]);
  assert.equal(state.outcome, undefined, 'awaiting the evaluator is not an outcome');
  // Development froze the registered line that scored best on the development days (labels pick from 72 up).
  const development = state.stages.development;
  assert.deepEqual([development.status, development.paid, development.reason], ['completed', false, null]);
  assert.equal(development.resultDigest, digest(development.result));
  assert.deepEqual(state.frozenPolicy, { surface: 'frontier-selection', threshold: 72, baselineThreshold: 64, registrationDigest: manifest.registration.digest, developmentResultDigest: development.resultDigest });
  assert.equal(state.frozenPolicyDigest, digest(state.frozenPolicy));
  assert.ok(development.result.candidates.every((row) => row.eligible));
  assert.deepEqual(development.result.candidates.filter((row) => row.meanDifference > 0).map((row) => row.threshold), [68, 72, 76]);
  // Confirmation measured only the frozen line against the baseline, one baseline and one candidate row per registered day.
  const confirmation = state.stages.confirmation;
  assert.deepEqual([confirmation.status, confirmation.paid], ['completed', false]);
  assert.equal(confirmation.resultDigest, digest(confirmation.result));
  assert.deepEqual(confirmation.result.evaluation.thresholds, [64, 72]);
  assert.equal(confirmation.result.observations.length, 2 * statistics.G_target);
  assert.deepEqual(confirmation.result.observations.slice(0, 2).map((row) => [row.group, row.arm, row.cost, row.status]), [[statistics.groups[0].id, 'baseline', 0, 'measured'], [statistics.groups[0].id, 'candidate', 0, 'measured']]);
  assert.ok(confirmation.result.volumeRatio > 0 && confirmation.result.volumeRatio < 1);
  // The clock: the freeze strictly precedes the confirmation's opening, and one look was taken.
  assert.ok(Date.parse(state.frozenAt) < Date.parse(state.confirmationOpenedAt));
  assert.equal(state.confirmationLooks, 1);
  // The request is exactly what the evaluator must bind its receipt to, and it is kept for a resume.
  assert.deepEqual(result.request, {
    binding: result.binding, frozenPolicyDigest: state.frozenPolicyDigest, corpusDigest: manifest.data.sources.find((row) => row.role === 'confirmation').digest,
    registrationDigest: digest(statistics), confirmationResultDigest: confirmation.resultDigest, confirmationOpenedAt: state.confirmationOpenedAt, look: 1,
  });
  assert.deepEqual(state.evaluationRequest, result.request);
  assert.deepEqual(evaluationRequest(manifest, inputs, state, result.binding), result.request);
  assert.equal(state.evaluation, undefined);
  // The confirmation corpus was opened for this campaign, in the synthetic ledger so a rehearsal never spends the real budget.
  assert.deepEqual([...store.ledger.keys()], ['synthetic:frontier-selection:2026-Q4']);
  const [reservation] = store.ledger.get('synthetic:frontier-selection:2026-Q4').reservations;
  assert.deepEqual({ ...reservation, at: undefined }, { campaignId: ID, alpha: BENIGN_CLAIM_ALPHA, corpusDigest: result.request.corpusDigest, at: undefined, looks: 1 });
  assert.ok(Date.parse(reservation.at) <= Date.parse(state.confirmationOpenedAt), 'the corpus is reserved before it is read');
  assert.deepEqual(store.corpora.get(result.request.corpusDigest), { recordType: 'rsi-opened-corpus', corpusDigest: result.request.corpusDigest, campaignId: ID, surface: 'synthetic:frontier-selection', openedAt: reservation.at });
});

test('a real signed receipt and the real statistics give the verdict, which is a diagnostic, never a release', async () => {
  const fixture = await registeredCampaignFixture();
  const store = memoryCampaignStore(), now = tickingClock();
  const run = await runToVerdict(fixture, { dir: nextDir(), store, now });
  assert.equal(run.awaiting.status, 'awaiting-evaluation');
  const done = run.completed;
  assert.deepEqual([done.status, done.qualification, done.reason, done.purpose, done.releaseEligible], ['completed', 'qualified', null, 'lifecycle-diagnostic', false]);
  const state = done.checkpoint;
  assert.equal(state.automated, true);
  assert.equal(done.reportDigest, digest(state));
  assert.equal(done.binding, run.awaiting.binding);
  const evaluation = state.evaluation;
  assert.deepEqual([evaluation.decision, evaluation.scope, evaluation.evidenceScope], ['qualified', 'synthetic-finite-corpus-only', 'population-task-family']);
  const interval = evaluation.quantities.superiority.quality_superiority;
  assert.equal(interval.n_groups, 30);
  assert.ok(interval.lower > 0 && interval.lower < interval.mean && interval.mean < interval.upper, 'the lower bound keeps the between-day sampling uncertainty');
  assert.equal(evaluation.quantities.superiority.test_alpha, BENIGN_CLAIM_ALPHA / 2);
  assert.deepEqual(evaluation.statisticsInput.registration, fixture.inputs.registration.statistics);
  assert.ok(evaluation.statisticsInput.observations.every((row) => row.cost === 0));
  assert.equal(evaluation.observationDigest, digest(evaluation.statisticsInput.observations));
  assert.equal(evaluation.expiresAt, run.signed.payload.expiresAt);
  assert.equal(evaluation.authorityReceiptDigest, digest(await run.attestEvaluation(run.awaiting.request)));
  assert.equal(evaluation.costProvenance.type, 'measured-normalized-cny');
  assert.equal(evaluation.inputDigest, digest(evaluation.statisticsInput));
  assert.deepEqual(state.evaluatorReceipt, { campaignId: ID, binding: done.binding, frozenPolicyDigest: state.frozenPolicyDigest, registrationDigest: fixture.manifest.registration.digest, target: fixture.manifest.target,
    sourceDigests: fixture.manifest.data.sources, decision: 'qualified', evaluationDigest: digest(evaluation), scope: evaluation.scope, automated: true });
  assert.equal(state.evaluationDigest, digest(evaluation));
  assert.equal(state.evaluatorReceiptDigest, digest(state.evaluatorReceipt));
  // The same lifecycle on a public, sealed corpus is an offline evaluation of the registered population.
  const publicRun = await runToVerdict(await registeredCampaignFixture({ classification: 'public' }), { dir: nextDir() });
  assert.deepEqual([publicRun.completed.qualification, publicRun.completed.purpose, publicRun.completed.checkpoint.evaluation.scope, publicRun.completed.releaseEligible],
    ['qualified', 'offline-evaluation', 'registered-population-task-family', false]);
  assert.deepEqual([...publicRun.environment.store.ledger.keys()], ['frontier-selection:2026-Q4'], 'a real campaign draws on the real surface budget');
});

test('resuming makes no writes and repeats the answer, whether the evaluator has spoken or not', async () => {
  const { fixture, store, result } = await atEvaluation();
  const writes = store.writes();
  const again = await runCampaign({ ...fixture, ...runnerEnvironment({ store }) });
  assert.deepEqual(again, result);
  assert.equal(store.writes(), writes, 'the same request is not written twice');
  const run = await runToVerdict(fixture, { dir: nextDir() });
  const done = run.completed, finalWrites = run.environment.store.writes();
  const calls = [];
  const spy = async (request) => { calls.push(request); return run.attestEvaluation(request); };
  for (const extra of [{}, { attestEvaluation: spy }]) {
    assert.deepEqual(await runCampaign({ ...fixture, ...run.environment, ...extra }), done);
  }
  assert.equal(run.environment.store.writes(), finalWrites);
  assert.deepEqual(calls, [], 'an evaluated campaign never asks the authority again');
});

test('a changed campaign is refused before resume and writes nothing', async () => {
  const { fixture, store, result } = await atEvaluation();
  const writes = store.writes();
  const attempt = async (mutate) => {
    const changed = structuredClone(fixture);
    mutate(changed);
    return runCampaign({ ...changed, ...runnerEnvironment({ store }) });
  };
  const reason = async (mutate) => (await attempt(mutate)).reason;
  assert.equal(await reason((c) => { c.inputs.registration.thresholds = [...c.inputs.registration.thresholds, 78]; }), 'campaign_registration_changed');
  assert.equal(await reason((c) => { c.inputs.registration.statistics.G_target += 1; }), 'campaign_registration_changed');
  assert.equal(await reason((c) => { c.inputs.sources.confirmation.labels[0].worth = c.inputs.sources.confirmation.labels[0].worth === 'pick' ? 'no' : 'pick'; }), 'campaign_source_changed');
  assert.equal(await reason((c) => { delete c.inputs.sources.development; }), 'campaign_source_changed');
  assert.equal(await reason((c) => { c.inputs.target.baselineRevision = 'other-baseline'; }), 'campaign_target_changed');
  assert.equal(await reason((c) => { c.inputs = null; }), 'campaign_inputs_missing');
  assert.equal(await reason((c) => { delete c.inputs.sources; }), 'campaign_inputs_missing');
  // Everything validates but the manifest differs from the one the checkpoint was made for.
  assert.equal(await reason((c) => { c.manifest.createdAt = '2026-10-25T23:00:00Z'; }), 'campaign_checkpoint_input_changed');
  assert.equal(await reason((c) => { c.manifest.claim = 'bogus'; }), 'campaign_claim_invalid');
  assert.equal(store.writes(), writes);
  // The unchanged campaign still answers from the same checkpoint.
  assert.deepEqual(await runCampaign({ ...fixture, ...runnerEnvironment({ store }) }), result);
});

test('a tampered checkpoint is refused, and a deterministic stage interrupted mid-run is simply run again', async () => {
  const snapshot = await atEvaluation();
  const tamper = async (mutate) => {
    const state = structuredClone(snapshot.state);
    mutate(state);
    const store = fork(snapshot);
    store.putState(ID, state);
    return runCampaign({ ...snapshot.fixture, ...runnerEnvironment({ store }) });
  };
  assert.equal((await tamper((s) => { s.stages.development.result.candidates = []; })).reason, 'campaign_checkpoint_tampered');
  assert.equal((await tamper((s) => { s.stages.confirmation.result.volumeRatio = 0.1; })).reason, 'campaign_checkpoint_tampered');
  assert.equal((await tamper((s) => { s.stages.development.result = []; })).reason, 'campaign_checkpoint_tampered');
  // A frozen policy edited before confirmation is opened.
  assert.equal((await tamper((s) => { delete s.stages.confirmation; s.frozenPolicy.threshold = 60; })).reason, 'campaign_frozen_policy_tampered');
  assert.equal((await tamper((s) => { delete s.stages.confirmation; delete s.frozenPolicy; })).reason, 'campaign_frozen_policy_tampered');
  // A paid stage that did not finish is parked: it may have spent money.
  assert.equal((await tamper((s) => { s.stages.development.paid = true; s.stages.development.status = 'running'; })).reason, 'campaign_stage_uncertain');
  // An unpaid deterministic stage that stopped half way gives the same answer twice: it is re-run to the same request.
  const crashed = structuredClone(snapshot.state);
  crashed.stages = { development: { id: `${ID}:development`, status: 'running', paid: false } };
  for (const key of ['frozenPolicy', 'frozenPolicyDigest', 'frozenAt', 'confirmationOpenedAt', 'confirmationLooks', 'evaluationRequest']) delete crashed[key];
  const store = memoryCampaignStore({ ledger: new Map(snapshot.store.ledger), corpora: new Map(snapshot.store.corpora) });
  store.putState(ID, crashed);
  const recovered = await runCampaign({ ...snapshot.fixture, ...runnerEnvironment({ store, now: tickingClock('2026-10-26T04:00:00.000Z') }) });
  assert.equal(recovered.status, 'awaiting-evaluation');
  assert.deepEqual(store.state(ID).frozenPolicy, snapshot.state.frozenPolicy);
  assert.equal(recovered.request.confirmationResultDigest, snapshot.request.confirmationResultDigest, 'the same stage output');
  assert.equal(store.ledger.get('synthetic:frontier-selection:2026-Q4').reservations.length, 1, 'its own reservation was reused, not drawn twice');
});

test('a tampered evaluation record is refused after the verdict', async () => {
  const fixture = await registeredCampaignFixture();
  const run = await runToVerdict(fixture, { dir: nextDir() });
  const { store } = run.environment;
  for (const mutate of [(s) => { s.evaluation.decision = 'qualified'; s.evaluation.reasons = ['edited']; }, (s) => { s.evaluatorReceipt.decision = 'not-qualified'; }]) {
    const state = store.state(ID);
    mutate(state);
    const copy = memoryCampaignStore();
    copy.putState(ID, state);
    assert.equal((await runCampaign({ ...fixture, ...runnerEnvironment({ store: copy }) })).reason, 'campaign_evaluator_checkpoint_tampered');
  }
});

test('a development that finds nothing better ends the campaign, durably, before confirmation is opened', async () => {
  // Every label cutoff is the baseline's own line: any other line loses picks or adds adequate items.
  const fixture = await registeredCampaignFixture({ development: { cutoffs: [64] } });
  const store = memoryCampaignStore();
  const first = await runCampaign({ ...fixture, ...runnerEnvironment({ store }) });
  assert.deepEqual(first, { status: 'not-qualified', reason: 'campaign_no_improving_candidate' });
  const state = store.state(ID);
  assert.deepEqual(state.outcome, first);
  assert.deepEqual([state.stages.development.status, state.stages.development.reason], ['completed', 'campaign_no_improving_candidate']);
  assert.ok(state.stages.development.result.candidates.every((row) => !(row.meanDifference > 0) || !row.eligible), 'no registered line improved on the baseline');
  assert.equal(state.stages.confirmation, undefined);
  assert.equal(state.frozenPolicy, undefined);
  assert.equal(store.ledger.size + store.corpora.size, 0, 'the confirmation corpus was never opened and no alpha was reserved');
  // The outcome is the campaign's: a resume returns it without running or writing, with or without an evaluator.
  const writes = store.writes();
  assert.deepEqual(await runCampaign({ ...fixture, ...runnerEnvironment({ store }) }), first);
  assert.deepEqual(await runCampaign({ ...fixture, ...runnerEnvironment({ store }), attestEvaluation: async () => { throw new Error('unreachable'); } }), first);
  assert.equal(store.writes(), writes);
  // A registered volume ceiling no candidate meets is the same terminal answer: the guard removes the candidates, not the campaign.
  const tight = await registeredCampaignFixture({ maxVolumeRatio: 0.5 });
  assert.deepEqual(await runCampaign({ ...tight, ...runnerEnvironment() }), { status: 'not-qualified', reason: 'campaign_no_improving_candidate' });
});

test('a consumer exception is terminal and its confirmation stays opened', async () => {
  // A statistics registration with a claim but no groups gets through validation and breaks the confirmation consumer.
  const fixture = await registeredCampaignFixture();
  delete fixture.inputs.registration.statistics.groups;
  recomputeRegistration(fixture);
  const store = memoryCampaignStore();
  const result = await runCampaign({ ...fixture, ...runnerEnvironment({ store }) });
  assert.deepEqual(result, { status: 'not-qualified', reason: 'campaign_consumer_error' });
  const state = store.state(ID);
  assert.deepEqual(state.outcome, result);
  assert.deepEqual([state.stages.development.status, state.stages.confirmation.status, state.stages.confirmation.reason], ['completed', 'failed', 'campaign_consumer_error']);
  assert.equal(state.stages.confirmation.result, undefined);
  assert.ok(store.corpora.has(fixture.manifest.data.sources[1].digest), 'a corpus that was looked at is spent whatever happened after');
  assert.ok(!JSON.stringify(state).includes('Cannot read'), 'the error text never reaches the record');
  const writes = store.writes();
  assert.deepEqual(await runCampaign({ ...fixture, ...runnerEnvironment({ store }) }), result);
  assert.equal(store.writes(), writes);
});

test('a confirmation corpus is opened by one campaign only', async () => {
  const store = memoryCampaignStore();
  const first = await atEvaluation({}, { store });
  // Another campaign, another development, the same sealed confirmation days.
  const second = await registeredCampaignFixture({ id: 'second-campaign', development: { seed: 99 } });
  assert.equal(second.manifest.data.sources[1].digest, first.fixture.manifest.data.sources[1].digest);
  assert.notEqual(second.manifest.data.sources[0].digest, first.fixture.manifest.data.sources[0].digest);
  const refused = await runCampaign({ ...second, ...runnerEnvironment({ store }) });
  assert.deepEqual(refused, { status: 'not-qualified', reason: 'campaign_confirmation_corpus_already_opened' });
  const state = store.state('second-campaign');
  assert.deepEqual(state.outcome, refused, 'the refusal is persisted: the campaign is over');
  assert.equal(state.stages.development.status, 'completed', 'development, which reads no sealed data, ran');
  assert.equal(state.stages.confirmation, undefined);
  assert.equal(state.frozenPolicy.threshold, 72);
  // The first campaign keeps its own reservation and still resumes.
  const ledger = store.ledger.get('synthetic:frontier-selection:2026-Q4');
  assert.deepEqual(ledger.reservations.map((row) => row.campaignId), [ID]);
  assert.deepEqual(await runCampaign({ ...first.fixture, ...runnerEnvironment({ store }) }), first.result);
});

test('a surface\'s confirmations draw on one alpha budget per quarter', async () => {
  const store = memoryCampaignStore();
  const campaign = (n, extra = {}) => registeredCampaignFixture({ id: `quarter-${n}`, confirmation: { seed: 500 + n }, ...extra });
  for (const n of [1, 2, 3]) {
    const result = await runCampaign({ ...await campaign(n), ...runnerEnvironment({ store }) });
    assert.equal(result.status, 'awaiting-evaluation', `campaign ${n}`);
  }
  const used = store.ledger.get('synthetic:frontier-selection:2026-Q4').reservations.reduce((sum, row) => sum + row.alpha, 0);
  assert.ok(Math.abs(used - RSI_QUARTER_ALPHA) < 1e-12, 'three campaigns of a third each spend the quarter\'s 0.05');
  const fourth = await runCampaign({ ...await campaign(4), ...runnerEnvironment({ store }) });
  assert.deepEqual(fourth, { status: 'not-qualified', reason: 'campaign_alpha_budget_exhausted' });
  assert.deepEqual(store.state('quarter-4').outcome, fourth);
  assert.equal(store.state('quarter-4').stages.confirmation, undefined);
  assert.equal(store.corpora.size, 3, 'the refused campaign opened nothing');
  // A real campaign has its own surface ledger: a rehearsal cannot spend it.
  const real = await runCampaign({ ...await campaign(5, { classification: 'public' }), ...runnerEnvironment({ store }) });
  assert.equal(real.status, 'awaiting-evaluation');
  assert.deepEqual([...store.ledger.keys()].sort(), ['frontier-selection:2026-Q4', 'synthetic:frontier-selection:2026-Q4']);
  // The next quarter starts a new budget.
  const later = await registeredCampaignFixture({ id: 'quarter-6', createdAt: '2026-12-30T00:00:00Z', deadline: '2027-01-31T16:00:00Z', confirmation: { seed: 506 } });
  const next = await runCampaign({ ...later, ...runnerEnvironment({ store, now: tickingClock('2027-01-05T01:00:00Z') }) });
  assert.equal(next.status, 'awaiting-evaluation');
  assert.ok(store.ledger.has('synthetic:frontier-selection:2027-Q1'));
});

test('the confirmation ledger rule: reuse, change, another campaign\'s corpus and the budget', () => {
  const request = { surface: 'frontier-selection', quarter: '2026-Q4', campaignId: 'a', alpha: 0.02, corpusDigest: 'c1', at: '2026-10-26T01:00:00Z' };
  const first = confirmationDecision(undefined, undefined, request);
  assert.deepEqual(first.result, { authorized: true, look: 1, reused: false });
  assert.deepEqual(first.ledger, { recordType: 'rsi-alpha-ledger', surface: 'frontier-selection', quarter: '2026-Q4', reservations: [{ campaignId: 'a', alpha: 0.02, corpusDigest: 'c1', at: request.at, looks: 1 }] });
  assert.deepEqual(first.corpus, { recordType: 'rsi-opened-corpus', corpusDigest: 'c1', campaignId: 'a', surface: 'frontier-selection', openedAt: request.at });
  assert.equal(first.write, true);
  // Asking again for the same thing reuses the reservation and writes nothing.
  assert.deepEqual(confirmationDecision(first.ledger, first.corpus, request), { write: false, result: { authorized: true, look: 1, reused: true } });
  // The same campaign changing its alpha or corpus is refused.
  assert.equal(confirmationDecision(first.ledger, first.corpus, { ...request, alpha: 0.03 }).result.reason, 'campaign_confirmation_reservation_changed');
  assert.equal(confirmationDecision(first.ledger, undefined, { ...request, corpusDigest: 'c2' }).result.reason, 'campaign_confirmation_reservation_changed');
  // Another campaign over an opened corpus is refused, whatever its alpha.
  assert.deepEqual(confirmationDecision(first.ledger, first.corpus, { ...request, campaignId: 'b', alpha: 0.001 }), { write: false, result: { authorized: false, reason: 'campaign_confirmation_corpus_already_opened' } });
  // The budget: the quarter's 0.05 less what is reserved.
  const other = { ...request, campaignId: 'b', corpusDigest: 'c2' };
  assert.equal(confirmationDecision(first.ledger, undefined, { ...other, alpha: 0.03 }).result.authorized, true, '0.02 + 0.03 is exactly the budget');
  const over = confirmationDecision(first.ledger, undefined, { ...other, alpha: 0.031 });
  assert.deepEqual([over.write, over.result.reason, over.result.used], [false, 'campaign_alpha_budget_exhausted', 0.02]);
  for (const alpha of [0, -0.01, Number.NaN, undefined]) assert.equal(confirmationDecision(undefined, undefined, { ...request, alpha }).result.reason, 'campaign_alpha_budget_exhausted', `alpha ${alpha}`);
  assert.equal(confirmationDecision(undefined, undefined, { ...request, alpha: 0.05 }).result.authorized, true, 'the whole quarter in one campaign');
  assert.equal(confirmationDecision(undefined, undefined, { ...request, alpha: 0.05000000001 }).result.authorized, false);
});

test('the quarter is the Asia/Shanghai calendar quarter', () => {
  assert.equal(rsiCampaignQuarter('2026-10-26T01:00:00Z'), '2026-Q4');
  assert.equal(rsiCampaignQuarter('2026-09-30T15:59:59Z'), '2026-Q3');
  assert.equal(rsiCampaignQuarter('2026-09-30T16:00:00Z'), '2026-Q4', 'midnight in Beijing is already October');
  assert.equal(rsiCampaignQuarter('2026-12-31T16:00:00Z'), '2027-Q1');
  assert.equal(rsiCampaignQuarter('2026-03-31T15:59:59+00:00'), '2026-Q1');
  assert.throws(() => rsiCampaignQuarter('2026-10-26T01:00:00'), TypeError);
});

test('an evaluator that cannot be reached or does not match is retried, never recorded', async () => {
  const snapshot = await atEvaluation();
  const good = async () => (await resume(snapshot, {})).result;
  const retries = {
    'authority throws': { attestEvaluation: async () => { throw new Error('evaluator offline'); }, reason: 'campaign_evaluator_authority_unavailable' },
    'authority answers nothing': { attestEvaluation: async () => null, reason: 'campaign_evaluator_receipt_binding_changed' },
    'receipt for another binding': { attestEvaluation: async (request) => ({ ...request, binding: 'another' }), reason: 'campaign_evaluator_receipt_binding_changed' },
    'receipt for another look': { attestEvaluation: async (request) => ({ ...request, look: 2 }), reason: 'campaign_evaluator_receipt_binding_changed' },
    'cost provenance incomplete': { mutatePayload: (p) => { p.costProvenance.complete = false; }, reason: 'campaign_cost_provenance_unverified' },
    'cost provenance of another kind': { mutatePayload: (p) => { p.costProvenance.type = 'estimated'; }, reason: 'campaign_cost_provenance_unverified' },
    'cost provenance without a receipt id': { mutatePayload: (p) => { delete p.costProvenance.receiptId; }, reason: 'campaign_cost_provenance_unverified' },
    'costs missing': { mutatePayload: (p) => { delete p.costs; }, reason: 'campaign_cost_provenance_unverified' },
    'a cost row missing': { mutatePayload: (p) => { p.costs.pop(); }, reason: 'campaign_cost_measurement_missing' },
    'a cost not a number': { mutatePayload: (p) => { p.costs[0].cost = null; }, reason: 'campaign_cost_measurement_missing' },
    'a negative cost': { mutatePayload: (p) => { p.costs[0].cost = -1; }, reason: 'campaign_cost_measurement_missing' },
    'a cost for another form': { mutatePayload: (p) => { p.costs[0].form = 'equivalent'; }, reason: 'campaign_cost_measurement_missing' },
    'qualification of the wrong consumer': { mutatePayload: (p) => { p.receipt.deterministic_qualification.consumer_id = 'changed'; }, reason: 'campaign_statistical_consumer_not_qualified' },
    'qualification of a finite corpus': { mutatePayload: (p) => { p.receipt.deterministic_qualification.type = 'trusted-deterministic-finite-corpus'; }, reason: 'campaign_statistical_consumer_not_qualified' },
    'qualification not externally verified': { mutatePayload: (p) => { p.receipt.deterministic_qualification.externally_verified = false; }, reason: 'campaign_statistical_consumer_not_qualified' },
    'qualification of another corpus': { mutatePayload: (p) => { p.receipt.deterministic_qualification.corpus_digest = 'f'.repeat(64); }, reason: 'campaign_statistical_consumer_not_qualified' },
    'no qualification': { mutatePayload: (p) => { delete p.receipt.deterministic_qualification; }, reason: 'campaign_statistical_consumer_not_qualified' },
    'the statistics process missing': { statisticsPython: '/nonexistent/python3', reason: 'campaign_statistics_unavailable' },
  };
  const store = fork(snapshot);
  const writes = store.writes();
  for (const [name, { reason, ...options }] of Object.entries(retries)) {
    const { result, state } = await resume(snapshot, { store, ...options });
    assert.deepEqual([result.status, result.reason], ['awaiting-evaluation', reason], name);
    assert.deepEqual(result.request, snapshot.request, name);
    assert.equal(state.evaluation, undefined, name);
    assert.equal(state.evaluatorReceipt, undefined, name);
  }
  assert.equal(store.writes(), writes, 'not one retry wrote to the checkpoint');
  // After every failure the same campaign takes a good receipt and completes.
  const { result } = await resume(snapshot, { store });
  assert.deepEqual([result.status, result.qualification], ['completed', 'qualified']);
  assert.equal((await good()).qualification, 'qualified');
});

test('a receipt that disagrees with what the runner observed is a not-qualified verdict, and it is final', async () => {
  const snapshot = await atEvaluation();
  const verdicts = {
    'the evaluator recomputed other observations': { mutatePayload: (p) => { p.observationDigest = 'f'.repeat(64); }, reason: 'campaign_evaluator_recomputation_differs' },
    'another registration digest': { mutatePayload: (p) => { p.receipt.attestations.registration_digest = 'f'.repeat(64); }, reason: 'campaign_integrity_attestation_differs' },
    'confirmation exposed': { mutatePayload: (p) => { p.receipt.attestations.confirmation_exposed = true; }, reason: 'campaign_integrity_attestation_differs' },
    'a repeated look': { mutatePayload: (p) => { p.receipt.attestations.look = 2; }, reason: 'campaign_integrity_attestation_differs' },
    'incomplete costs': { mutatePayload: (p) => { p.receipt.attestations.complete_costs = false; }, reason: 'campaign_integrity_attestation_differs' },
    'another cost identity': { mutatePayload: (p) => { p.receipt.attestations.cost_identity = 'owner-metered'; }, reason: 'campaign_integrity_attestation_differs' },
    'an expired budget': { mutatePayload: (p) => { p.receipt.attestations.expired_budget = true; }, reason: 'campaign_integrity_attestation_differs' },
    'no attestations': { mutatePayload: (p) => { delete p.receipt.attestations; }, reason: 'campaign_integrity_attestation_differs' },
  };
  for (const [name, { reason, mutatePayload }] of Object.entries(verdicts)) {
    const { result, state, store } = await resume(snapshot, { mutatePayload });
    assert.deepEqual([result.status, result.qualification, result.reason, result.purpose, result.releaseEligible], ['completed', 'not-qualified', reason, 'lifecycle-diagnostic', false], name);
    assert.deepEqual([state.evaluation.decision, state.evaluation.reason, state.evaluation.scope], ['not-qualified', reason, 'undetermined'], name);
    assert.equal(state.evaluation.statisticsInput, undefined, 'the statistics never saw a disputed measurement');
    // The verdict is persisted: a later, correct receipt does not undo it.
    const good = await resume(snapshot, { store });
    assert.deepEqual([good.result.qualification, good.result.reason], ['not-qualified', reason], name);
  }
});

test('measured costs that are not zero make the superiority evidence inconclusive', async () => {
  const snapshot = await atEvaluation();
  const { result, state } = await resume(snapshot, { mutatePayload: (p) => { p.costs[0].cost = 0.5; } });
  assert.deepEqual([result.status, result.qualification], ['completed', 'inconclusive']);
  assert.match(state.evaluation.reasons.join(' '), /zero measured costs/);
  assert.equal(state.evaluation.quantities && Object.keys(state.evaluation.quantities).length, 0);
});

test('the volume guard stops a candidate that selects more than the registered share of the baseline on the confirmation days', async () => {
  // Development: the 72 line selects 0.72 of the baseline's rows, within the ceiling of 0.75. Confirmation days with higher scores
  // select 0.93 of them, over it.
  const fixture = await registeredCampaignFixture({ maxVolumeRatio: 0.75, confirmation: { scoreLow: 70, scoreHigh: 90 } });
  const snapshot = await atEvaluation(fixture);
  assert.equal(snapshot.state.frozenPolicy.threshold, 72);
  assert.ok(snapshot.state.stages.development.result.candidates.find((row) => row.threshold === 72).volumeRatio <= 0.75);
  const { result, state } = await resume(snapshot, {});
  assert.deepEqual([result.status, result.qualification, result.reason], ['completed', 'not-qualified', 'campaign_volume_guard']);
  assert.ok(state.evaluation.volumeRatio > 0.75 && state.evaluation.volumeRatio < 1);
  assert.equal(state.evaluation.volumeRatio, snapshot.state.stages.confirmation.result.volumeRatio);
  assert.equal(state.evaluation.statisticsInput, undefined);
});

test('a frozen policy that does not beat the baseline on the confirmation days is a persisted not-qualified verdict', async () => {
  // Development favours the 72 line; on the confirmation days every pick sits at 64, so the baseline is the better line.
  const fixture = await registeredCampaignFixture({ confirmation: { cutoffs: [64] } });
  const run = await runToVerdict(fixture, { dir: nextDir() });
  const done = run.completed;
  assert.equal(done.checkpoint.frozenPolicy.threshold, 72);
  assert.deepEqual([done.status, done.qualification, done.reason], ['completed', 'not-qualified', null]);
  const interval = done.checkpoint.evaluation.quantities.superiority.quality_superiority;
  assert.ok(interval.mean < 0 && interval.lower < 0);
  assert.deepEqual(await runCampaign({ ...fixture, ...run.environment, attestEvaluation: async () => { throw new Error('unreachable'); } }), done);
});

test('a registration the confirmation cannot honour never reaches the evaluator', async () => {
  const consumer = await registeredCampaignFixture();
  consumer.inputs.registration.statistics.consumer_id = 'f'.repeat(64);
  recomputeRegistration(consumer);
  const store = memoryCampaignStore();
  await runCampaign({ ...consumer, ...runnerEnvironment({ store }) });
  let asked = 0;
  const attestEvaluation = async () => { asked += 1; return null; };
  const verdict = await runCampaign({ ...consumer, ...runnerEnvironment({ store }), attestEvaluation });
  assert.deepEqual([verdict.status, verdict.qualification, verdict.reason], ['completed', 'not-qualified', 'campaign_evaluation_consumer_or_corpus_changed']);
  assert.equal(asked, 0);
  assert.equal(store.state(ID).evaluation.decision, 'not-qualified');
  // A public campaign must register the paired-t, deterministic-consumer procedure.
  const finite = await registeredCampaignFixture({ classification: 'public' });
  finite.inputs.registration.statistics.mode = 'deterministic';
  recomputeRegistration(finite);
  const other = memoryCampaignStore();
  await runCampaign({ ...finite, ...runnerEnvironment({ store: other }) });
  const refused = await runCampaign({ ...finite, ...runnerEnvironment({ store: other }), attestEvaluation });
  assert.deepEqual([refused.qualification, refused.reason], ['not-qualified', 'campaign_statistical_consumer_not_qualified']);
  assert.equal(asked, 0);
  // With no statistics registered the confirmation is never opened, and the reason says so.
  const bare = benignCampaignFixture();
  const none = memoryCampaignStore();
  assert.deepEqual(await runCampaign({ ...bare, ...runnerEnvironment({ store: none }) }), { status: 'not-qualified', reason: 'campaign_statistics_registration_missing' });
  assert.equal(none.corpora.size, 0);
});

test('a statistics process that fails is unknown, never a zero measurement', async () => {
  assert.deepEqual(Object.keys(await evaluateStatistics({})).sort(), ['decision', 'reason']);
  assert.deepEqual(await evaluateStatistics({}), { decision: 'unknown', reason: 'campaign_statistics_failed' });
  assert.deepEqual(await evaluateStatistics(1n), { decision: 'unknown', reason: 'campaign_statistics_input_invalid' });
  assert.deepEqual(await evaluateStatistics({ blob: 'x'.repeat(16 * 1024 * 1024 + 1) }), { decision: 'unknown', reason: 'campaign_statistics_input_invalid' });
  assert.deepEqual(await evaluateStatistics({}, { pythonExecutable: '/nonexistent/python3' }), { decision: 'unknown', reason: 'campaign_statistics_unavailable' });
  assert.deepEqual(await evaluateStatistics({}, { timeoutMs: 1, pythonExecutable: STATISTICS_PYTHON, modulePath: STATISTICS_MODULE_PATH }), { decision: 'unknown', reason: 'campaign_statistics_timeout' });
  // A real input: the verdict is bound to the input digest and is the same twice.
  const run = await runToVerdict(await registeredCampaignFixture(), { dir: nextDir() });
  const input = run.completed.checkpoint.evaluation.statisticsInput;
  const options = { pythonExecutable: STATISTICS_PYTHON, modulePath: STATISTICS_MODULE_PATH };
  const once = await evaluateStatistics(input, options), twice = await evaluateStatistics(input, options);
  assert.equal(once.decision, 'qualified');
  assert.deepEqual(once, twice);
  assert.equal(once.inputDigest, digest(input));
  assert.equal(once.registration_digest, digest(input.registration));
  // A registration changed after the receipt was made is the statistics' own refusal: inconclusive, not unknown.
  const changed = structuredClone(input);
  changed.registration.expires_at = '2030-01-01T00:00:00Z';
  const refused = await evaluateStatistics(changed, options);
  assert.equal(refused.decision, 'inconclusive');
  assert.match(refused.reasons.join(' '), /registration digest mismatch/);
});

test('cancellation, the deadline and the budget month stop a campaign without recording an outcome', async () => {
  const fixture = await registeredCampaignFixture({ createdAt: '2026-10-25T00:00:00Z', deadline: '2026-11-30T16:00:00Z' });
  const cancelled = memoryCampaignStore();
  assert.deepEqual(await runCampaign({ ...fixture, ...runnerEnvironment({ store: cancelled }), signal: { aborted: true } }), { status: 'not-qualified', reason: 'campaign_cancelled' });
  assert.equal(cancelled.writes() + cancelled.ledger.size, 0);
  const expired = memoryCampaignStore();
  for (const at of ['2026-11-30T16:00:00Z', '2026-12-05T00:00:00Z']) {
    assert.equal((await runCampaign({ ...fixture, ...runnerEnvironment({ store: expired, now: () => at }) })).reason, 'campaign_deadline_expired', at);
  }
  assert.equal(expired.writes(), 0);
  // A cancel that arrives once development is written parks the campaign before confirmation is opened.
  const afterDevelopment = (store) => ({ get aborted() { return store.writes() >= 2; } });
  const store = memoryCampaignStore();
  const parked = await runCampaign({ ...fixture, ...runnerEnvironment({ store }), signal: afterDevelopment(store) });
  assert.equal(parked.reason, 'campaign_cancelled');
  const state = store.state(ID);
  assert.deepEqual([state.stages.development.status, state.stages.confirmation, state.outcome], ['completed', undefined, undefined]);
  assert.equal(store.ledger.size, 0, 'no corpus was opened');
  // Nothing was recorded against it, so the next run, without a cancel, carries on to the evaluator.
  const carried = await runCampaign({ ...fixture, ...runnerEnvironment({ store, now: tickingClock('2026-10-26T06:00:00.000Z') }) });
  assert.equal(carried.status, 'awaiting-evaluation');
  // The budget month is the one the campaign began in: the next month refuses, and nothing is opened.
  const month = memoryCampaignStore();
  const began = await runCampaign({ ...fixture, ...runnerEnvironment({ store: month, now: tickingClock('2026-10-31T10:00:00.000Z') }), signal: afterDevelopment(month) });
  assert.equal(began.reason, 'campaign_cancelled');
  assert.equal(month.state(ID).month, '2026-10');
  const writes = month.writes();
  const nextMonth = await runCampaign({ ...fixture, ...runnerEnvironment({ store: month, now: () => '2026-10-31T16:00:00Z' }) });
  assert.deepEqual(nextMonth, { status: 'not-qualified', reason: 'campaign_budget_month_expired' }, 'midnight in Beijing is already November');
  assert.deepEqual([month.ledger.size, month.writes(), month.state(ID).outcome], [0, writes, undefined]);
  const inMonth = await runCampaign({ ...fixture, ...runnerEnvironment({ store: month, now: tickingClock('2026-10-31T11:00:00.000Z') }) });
  assert.equal(inMonth.status, 'awaiting-evaluation', 'the same campaign, still within its month, resumes');
  // A receipt that has lapsed by the time of a later resume is refused, still within the month, and nothing is rewritten.
  const early = await registeredCampaignFixture({ createdAt: '2026-10-09T00:00:00Z', deadline: '2026-10-31T16:00:00Z' });
  const run = await runToVerdict(early, { dir: nextDir(), now: tickingClock('2026-10-10T01:00:00.000Z') });
  assert.equal(run.completed.qualification, 'qualified');
  assert.equal(Date.parse(run.completed.checkpoint.evaluation.expiresAt), Date.parse(run.issuedAt) + 7 * 86400000);
  const writesBefore = run.environment.store.writes();
  const lapsed = await runCampaign({ ...early, ...run.environment, now: () => '2026-10-18T00:00:00Z' });
  assert.deepEqual(lapsed, { status: 'not-qualified', reason: 'campaign_evaluator_receipt_expired' });
  assert.equal(run.environment.store.writes(), writesBefore);
  assert.equal((await runCampaign({ ...early, ...run.environment, now: () => '2026-10-16T00:00:00Z' })).qualification, 'qualified', 'before its expiry the same record still answers');
});

test('an incident campaign runs only while its authorization is current, checked before every stage', async () => {
  const campaign = () => registeredCampaignFixture({ classification: 'authorized-incident', id: 'incident-campaign' });
  const withdrawals = [
    // call 1 is the entry, calls 2 and 3 precede each stage, call 4 precedes the evaluator request
    { at: 1, development: false, confirmation: false },
    { at: 2, development: false, confirmation: false },
    { at: 3, development: true, confirmation: false },
    { at: 4, development: true, confirmation: true },
  ];
  for (const { at, development, confirmation } of withdrawals) {
    const fixture = await campaign();
    const store = memoryCampaignStore();
    let calls = 0;
    const incidentTransport = { assertIncidentCurrent: async (authorization) => { assert.deepEqual(authorization, INCIDENT_AUTHORIZATION); if (++calls >= at) throw new Error('tenant secret must not leak'); } };
    const result = await runCampaign({ ...fixture, ...runnerEnvironment({ store }), incidentTransport });
    assert.deepEqual(result, { status: 'not-qualified', reason: 'campaign_incident_not_current' }, `withdrawn at call ${at}`);
    assert.ok(!JSON.stringify(result).includes('tenant secret'), 'the transport\'s error text never escapes');
    const state = store.state('incident-campaign');
    assert.equal(state?.stages.development?.status === 'completed', development, `development after withdrawal at ${at}`);
    assert.equal(state?.stages.confirmation?.status === 'completed', confirmation, `confirmation after withdrawal at ${at}`);
    assert.equal(state?.outcome, undefined, 'a withdrawal is not a verdict: nothing is recorded');
    assert.equal(store.ledger.size === 1, development && at >= 4, `the corpus is opened only once both gates passed (at ${at})`);
    // Reinstated, the same campaign resumes where it stopped.
    const resumed = await runCampaign({ ...fixture, ...runnerEnvironment({ store, now: tickingClock('2026-10-26T05:00:00.000Z') }), incidentTransport: { assertIncidentCurrent: async () => {} } });
    assert.equal(resumed.status, 'awaiting-evaluation', `resumed after withdrawal at ${at}`);
  }
  // Without a transport an incident cannot be confirmed current, and nothing is read.
  const fixture = await campaign();
  const store = memoryCampaignStore();
  assert.equal((await runCampaign({ ...fixture, ...runnerEnvironment({ store }) })).reason, 'campaign_incident_not_current');
  assert.equal((await runCampaign({ ...fixture, ...runnerEnvironment({ store }), incidentTransport: {} })).reason, 'campaign_incident_not_current');
  assert.equal(store.writes(), 0);
  // A synthetic or public campaign never asks the transport.
  const asked = [];
  const ordinary = await runCampaign({ ...await registeredCampaignFixture({ classification: 'public' }), ...runnerEnvironment(), incidentTransport: { assertIncidentCurrent: async () => { asked.push(1); } } });
  assert.equal(ordinary.status, 'awaiting-evaluation');
  assert.deepEqual(asked, []);
});

test('inputs the consumer cannot trust are refused by name before any stage runs', async () => {
  const refused = async (fixture, reason, label) => {
    const store = memoryCampaignStore();
    assert.deepEqual(await runCampaign({ ...fixture, ...runnerEnvironment({ store }) }), { status: 'not-qualified', reason }, label);
    assert.equal(store.writes(), 0, label);
  };
  const base = { classification: 'public' };
  // The base passes: independence is by calendar, so a confirmation starting the day after development ends is allowed.
  const adjacent = await registeredCampaignFixture({ ...base, confirmation: { start: '2026-07-31' } });
  assert.equal((await runCampaign({ ...adjacent, ...runnerEnvironment() })).status, 'awaiting-evaluation');
  await refused(await registeredCampaignFixture({ ...base, confirmation: { start: '2026-07-30' } }), 'campaign_confirmation_not_independent', 'a shared day');
  await refused(await registeredCampaignFixture({ ...base, confirmation: { start: '2026-06-20' } }), 'campaign_confirmation_not_independent', 'confirmation before development');
  await refused(await registeredCampaignFixture({ ...base, confirmationExposure: 'exposed' }), 'campaign_confirmation_not_independent', 'an exposed corpus');
  const sharedRow = await withSource(await registeredCampaignFixture(base), 'confirmation', (source) => {
    const devId = 'dev-2026-07-01-00';
    source.labels.find((label) => label.id === source.days[0].rows[0].id).id = devId;
    source.days[0].rows[0].id = devId;
  });
  await refused(sharedRow, 'campaign_confirmation_not_independent', 'a shared row id');
  // A rehearsal on synthetic data skips independence (the data is invented) but not the other checks.
  const overlapping = await registeredCampaignFixture({ confirmation: { start: '2026-07-20' } });
  assert.equal((await runCampaign({ ...overlapping, ...runnerEnvironment() })).status, 'awaiting-evaluation');
  const outside = await withSource(await registeredCampaignFixture(), 'development', (source) => { source.labels.push({ id: 'not-in-this-source', worth: 'pick' }); });
  await refused(outside, 'campaign_labels_outside_source', 'a label outside its source');
  const crossed = await withSource(await registeredCampaignFixture(), 'development', (source) => { source.labels.push({ id: 'conf-2026-09-01-00', worth: 'pick' }); });
  await refused(crossed, 'campaign_labels_outside_source', 'a label belonging to the other source');
  await refused(await withSource(await registeredCampaignFixture(), 'development', (source) => { source.kind = 'frontier-day'; }), 'campaign_source_invalid', 'a malformed source');
  await refused(await withSource(await registeredCampaignFixture(), 'confirmation', (source) => { source.band.pickWeight = 50; }), 'campaign_source_invalid', 'a band weight out of range');
  const twin = await registeredCampaignFixture();
  twin.inputs.sources.confirmation = structuredClone(twin.inputs.sources.development);
  twin.manifest.data.sources[1].digest = digest(twin.inputs.sources.confirmation);
  twin.inputs.registration.statistics.corpus_digest = twin.manifest.data.sources[1].digest;
  recomputeRegistration(twin);
  await refused(twin, 'campaign_independent_sources_missing', 'identical development and confirmation');
  const noConfirmation = await registeredCampaignFixture();
  noConfirmation.manifest.data.sources = noConfirmation.manifest.data.sources.slice(0, 1);
  await refused(noConfirmation, 'campaign_independent_sources_missing', 'no confirmation source');
  const registration = async (mutate, label, reason) => { const f = await registeredCampaignFixture(); mutate(f.inputs.registration); recomputeRegistration(f); await refused(f, reason, label); };
  await registration((r) => { r.thresholds = []; }, 'no thresholds', 'campaign_registration_invalid');
  await registration((r) => { r.baselineThreshold = '64'; }, 'a baseline that is not a number', 'campaign_registration_invalid');
  await registration((r) => { r.thresholds = [72, 'x']; }, 'a threshold that is not a number', 'campaign_registration_invalid');
  await registration((r) => { r.selection = { objective: 'precision-desc', tieBreak: 'nearest-baseline' }; }, 'another objective', 'campaign_selection_registration_missing');
  await registration((r) => { delete r.selection; }, 'no selection rule', 'campaign_selection_registration_missing');
  await registration((r) => { r.selection.tieBreak = 'threshold-asc'; }, 'another tie-break', 'campaign_selection_registration_missing');
});

test('a source with an incomplete day is not consumed: the campaign ends with the consumer\'s reason', async () => {
  const fixture = await withSource(await registeredCampaignFixture(), 'development', (source) => { source.days[3].complete = false; });
  const store = memoryCampaignStore();
  const result = await runCampaign({ ...fixture, ...runnerEnvironment({ store }) });
  assert.deepEqual(result, { status: 'not-qualified', reason: 'campaign_consumer_failed' });
  const state = store.state(ID);
  assert.equal(state.stages.development.status, 'completed');
  assert.deepEqual(state.stages.development.result.evaluation.issues, ['frontier_day_pool_incomplete']);
  assert.equal(state.stages.development.result.evaluation.day, '2026-07-04');
  assert.deepEqual(state.outcome, result);
  assert.equal(store.ledger.size, 0);
});

test('only a registered consumer is run, and the manifest contract is checked first', async () => {
  const fixture = await registeredCampaignFixture();
  const other = structuredClone(fixture);
  other.manifest.surface = 'frontier-screen';
  other.manifest.target.surface = 'frontier-screen';
  other.inputs.target = other.manifest.target;
  const store = memoryCampaignStore();
  assert.deepEqual(await runCampaign({ ...other, ...runnerEnvironment({ store }) }), { status: 'not-qualified', reason: 'campaign_consumer_not_qualified' });
  assert.equal(store.writes(), 0);
  assert.deepEqual(campaignPlan(other.manifest), { campaignId: ID, automated: true, stages: ['development', 'confirmation', 'evaluation'], unsupported: true });
  assert.deepEqual(campaignPlan(fixture.manifest), { campaignId: ID, automated: true, stages: ['development', 'confirmation', 'evaluation'], unsupported: false });
  for (const [mutate, reason] of [
    [(m) => { m.claim = 'bogus'; }, 'campaign_claim_invalid'],
    [(m) => { m.automated = false; }, 'campaign_automated_required'],
    [(m) => { m.deadline = m.createdAt; }, 'campaign_time_invalid'],
    [(m) => { m.models.improver = { provider: 'none', model: 'something-else' }; }, 'campaign_model_invalid'],
    [(m) => { m.registration.claim = 'efficiency'; }, 'campaign_registration_invalid'],
  ]) {
    const changed = structuredClone(fixture);
    mutate(changed.manifest);
    assert.equal((await runCampaign({ ...changed, ...runnerEnvironment() })).reason, reason);
  }
  // The same manifest with the grid improver and the claim the consumer supports is what passes.
  assert.equal((await runCampaign({ ...fixture, ...runnerEnvironment() })).status, 'awaiting-evaluation');
});

test('the confirmation request binds exactly the facts the evaluator must attest', async () => {
  const fixture = await registeredCampaignFixture();
  const state = { frozenPolicyDigest: 'f'.repeat(64), stages: { confirmation: { resultDigest: 'c'.repeat(64) } }, confirmationOpenedAt: '2026-10-26T01:00:03.000Z', confirmationLooks: 1 };
  const request = evaluationRequest(fixture.manifest, fixture.inputs, state, 'b'.repeat(64));
  assert.deepEqual(request, { binding: 'b'.repeat(64), frozenPolicyDigest: 'f'.repeat(64), corpusDigest: fixture.manifest.data.sources[1].digest, registrationDigest: digest(fixture.inputs.registration.statistics),
    confirmationResultDigest: 'c'.repeat(64), confirmationOpenedAt: '2026-10-26T01:00:03.000Z', look: 1 });
  const bare = structuredClone(fixture.inputs);
  delete bare.registration.statistics;
  assert.equal(evaluationRequest(fixture.manifest, bare, state, 'b').registrationDigest, digest(null), 'no statistics registered is bound as null');
  assert.deepEqual((await frontierCampaignConsumerIdentity()).implementationSha256, fixture.inputs.registration.statistics.consumer_id);
  const attached = await attachStatistics(benignCampaignFixture());
  assert.deepEqual(attached.inputs.registration.statistics.groups.length, 30);
});
