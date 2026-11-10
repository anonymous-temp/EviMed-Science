import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, createHash, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalRsiJson } from '../../../apps/server/src/rsiCampaignBundle.mjs';
import { rsiClosureSettings } from '../../../apps/server/src/rsiClosureSettings.mjs';
import { computeRsiDependencyClosure } from '../../../apps/server/src/rsiDependencyClosure.mjs';
import { parseRsiPolicyCandidate } from '../../../apps/server/src/rsiServingAdapters.mjs';
import { RSI_CAMPAIGN_SURFACES } from '../../../packages/domain/src/rsiCampaign.mjs';
import { alphaLedger, runCampaign, signedEvaluatorReceipt } from '../campaign_runner.mjs';
import { evaluatorReceiptPayload, finalizerEvidencePayload } from '../evaluator.mjs';
import { finalizeCampaign } from '../finalize.mjs';
import { developmentOnly } from '../harness_assemble.mjs';
import { chooseHarnessCandidate, harnessArmsIssues, harnessCampaignConsumerIdentity, harnessDevelopmentIssue, harnessJudgeRegistrationIssue } from '../harness_campaign.mjs';
import { harnessReport } from '../harness_report.mjs';
import { MODULE_KIT, MODULE_SURFACES, chooseModuleCandidate, isModuleSurface, moduleCampaignConsumerIdentity, moduleCandidateArm, moduleConfirmation, modulePolicyDigest, moduleRunCost } from '../module_campaign.mjs';
import { MODULE_SCORERS, frontierNumbersPassed, frontierUnitMet, incumbentNoiseBand, moduleDeterministicChecks, moduleScorer } from '../module_scorers.mjs';
import { STATISTICS_MODULE_PATH, STATISTICS_PYTHON, generateEvaluatorKey, memoryCampaignStore, procedureReport, runToVerdict, runnerEnvironment, tickingClock } from '../profiles/benign_fixture.mjs';
import { generator, improvementOf, rebind } from '../profiles/harness_fixture.mjs';
import { INCUMBENT, ROOT, candidateOn, closureImage, judgeOf, moduleFixture, sha256 } from '../profiles/module_fixture.mjs';
import { REFERENCE_PRICE_LIST } from '../../../packages/domain/src/metering.mjs';

const scratch = await mkdtemp(join(tmpdir(), 'rsi-module-'));
after(() => rm(scratch, { recursive: true, force: true }));
let dirs = 0;
const nextDir = () => join(scratch, String(dirs += 1));
const DEV = 'development-2026-11', CONF = 'confirmation-2026-11';
const run = (campaign, environment = runnerEnvironment()) => runCampaign({ manifest: campaign.manifest, inputs: campaign.inputs, ...environment });

// ------------------------------------------------------------------------------------------------------------------ the candidate

test('what the consumer calls a surface\'s component is what the serving layer lets that surface supply', () => {
  assert.deepEqual(Object.keys(MODULE_SURFACES).sort(), ['frontier-edit', 'frontier-screen']);
  for (const [surface, { component }] of Object.entries(MODULE_SURFACES)) {
    assert.ok(Object.hasOwn(RSI_CAMPAIGN_SURFACES, surface), surface);
    assert.deepEqual(parseRsiPolicyCandidate(surface, [{ path: 'policy.json', content: canonicalRsiJson({ [component]: 'text' }) }]), { [component]: 'text' });
  }
  assert.equal(isModuleSurface('geo-supplements'), false);
  assert.equal(isModuleSurface('harness-patch'), false);
  assert.equal(isModuleSurface('__proto__'), false);
});

test('one component, the surface\'s, valid by the serving validation and not the incumbent\'s: anything else is refused by a closed code', async () => {
  const image = await closureImage('frontier-edit'), ok = (policy, title = 'c') => moduleCandidateArm('frontier-edit', { title, policy }, image, INCUMBENT.componentSha256);
  const arm = ok({ editInstructions: 'A new text.' });
  assert.equal(arm.arm, `cand-${arm.harness.digest.slice(0, 12)}`);
  assert.deepEqual(arm.harness.policy, { surface: 'frontier-edit', component: 'editInstructions', text: 'A new text.' });
  assert.equal(arm.harness.chars, 11);
  for (const [label, policy] of [['two components', { editInstructions: 'a', screenInstructions: 'b' }], ['another surface\'s component', { screenInstructions: 'b' }], ['nothing', {}], ['a threshold', { selectionThreshold: 70 }]])
    assert.throws(() => ok(policy), { message: 'module_candidate_not_one_component' }, label);
  for (const [label, policy] of [['empty', { editInstructions: '  ' }], ['over the bound', { editInstructions: 'x'.repeat(24001) }], ['not text', { editInstructions: 7 }]])
    assert.throws(() => ok(policy), { message: 'module_candidate_invalid' }, label);
  assert.throws(() => moduleCandidateArm('frontier-edit', { policy: { editInstructions: 'a' }, extra: 1 }, image, INCUMBENT.componentSha256), { message: 'module_candidate_invalid' });
  assert.throws(() => moduleCandidateArm('geo-supplements', { policy: { supplements: [] } }, image, INCUMBENT.componentSha256), { message: 'module_candidate_invalid' });
  assert.throws(() => moduleCandidateArm('frontier-edit', { policy: { editInstructions: 'same' } }, image, sha256('same')), { message: 'module_candidate_unchanged' });
});

test('the digest binds surface, component, text and the consumer\'s dependency digest, and an arm is admitted only with it recomputed', async () => {
  const policy = { surface: 'frontier-edit', component: 'editInstructions', text: 'A new text.' }, image = { id: 'x', digest: 'a'.repeat(64) };
  const base = modulePolicyDigest(policy, image);
  assert.equal(base, createHash('sha256').update(canonicalRsiJson({ component: 'editInstructions', dependencyDigest: 'a'.repeat(64), surface: 'frontier-edit', text: 'A new text.' })).digest('hex'));
  for (const change of [{ surface: 'frontier-screen' }, { component: 'screenInstructions' }, { text: 'Another.' }]) assert.notEqual(modulePolicyDigest({ ...policy, ...change }, image), base);
  assert.notEqual(modulePolicyDigest(policy, { ...image, digest: 'b'.repeat(64) }), base, 'the same text over another consumer is another candidate');
  assert.equal(modulePolicyDigest(policy, { ...image, id: 'y' }), base, 'the id is a label');
  const campaign = await moduleFixture('frontier-edit'), source = campaign.inputs.sources[DEV], registration = campaign.inputs.registration;
  assert.deepEqual(harnessArmsIssues(source, registration, MODULE_KIT), []);
  const tampered = (mutate) => { const copy = structuredClone(source); mutate(copy.arms[campaign.good.arm].harness, copy); return harnessArmsIssues(copy, registration, MODULE_KIT); };
  assert.deepEqual(tampered((h) => { h.policy.text = 'Quietly changed.'; }), ['harness_arms_candidate_invalid']);
  assert.deepEqual(tampered((h) => { h.policy.surface = 'frontier-screen'; h.digest = modulePolicyDigest(h.policy, source.image); }), ['harness_arms_candidate_invalid']);
  assert.deepEqual(tampered((h) => { h.policy.component = 'screenInstructions'; }), ['harness_arms_candidate_invalid']);
  assert.deepEqual(tampered((h) => { h.policy.extra = 1; }), ['harness_arms_candidate_invalid']);
  assert.deepEqual(tampered((h, copy) => { copy.incumbent.componentSha256 = sha256(h.policy.text); }), ['harness_arms_candidate_invalid'], 'a candidate that is the incumbent changes nothing');
  assert.deepEqual(harnessArmsIssues({ ...source, kind: 'harness-arms' }, registration, MODULE_KIT), ['harness_arms_invalid'], 'the source is its own kind');
});

// ----------------------------------------------------------------------------------------------------------------------- the table

test('the scorer table is closed, a scorer measures only its surfaces, and the two consumers\' tables never cross', async () => {
  assert.deepEqual(Object.keys(MODULE_SCORERS).sort(), ['frontier-numbers', 'frontier-source']);
  assert.ok(Object.isFrozen(MODULE_SCORERS));
  assert.equal(moduleScorer({ scorer: 'frontier-numbers', surface: 'frontier-screen' }).id, 'frontier-numbers');
  for (const refused of [{ scorer: 'frontier-source', surface: 'frontier-screen' }, { scorer: 'medcalc', surface: 'frontier-edit' }, { scorer: 'frontier-numbers' }, { surface: 'frontier-edit' }, { scorer: '__proto__', surface: 'frontier-edit' }])
    assert.equal(moduleScorer(refused), null, JSON.stringify(refused));
  await assert.rejects(moduleFixture('frontier-edit', { mutateRound: (round) => { round.scorer = 'medcalc'; } }), { message: 'campaign_scorer_not_qualified' });
  await assert.rejects(harnessCampaignConsumerIdentity({ scorer: 'frontier-numbers' }), { message: 'campaign_scorer_not_qualified' }, 'a harness registration cannot name a module\'s scorer');
});

test('frontier-numbers: every number and unit in the source, the expected answer right, verification passed or repaired; abstention as the case says; a floor', () => {
  const good = { variant: 'case', inputSha256: 'a', verification: 'passed', numbers: { checked: 2, source: 2, missing: [], unitMismatches: [] }, output: { lane: 'safety', summaryZh: '写了', evidenceType: 'rct', flags: ['boxed-warning'], genre: 'industry', industryKind: 'deal' } };
  const with_ = (changes) => ({ ...good, ...changes }), out = (changes) => ({ ...good, output: { ...good.output, ...changes } });
  const lane = { kind: 'lane', expect: ['safety'] };
  assert.equal(frontierUnitMet(good, lane), true);
  assert.equal(frontierUnitMet(with_({ verification: 'repaired' }), lane), true, 'a rewrite the verification repaired counts');
  assert.equal(frontierUnitMet(with_({ verification: 'title-only' }), lane), false);
  assert.equal(frontierUnitMet(with_({ numbers: { checked: 2, source: 2, missing: ['12%'], unitMismatches: [] } }), lane), false);
  assert.equal(frontierUnitMet(with_({ numbers: { checked: 2, source: 2, missing: [], unitMismatches: ['5 mg'] } }), lane), false);
  assert.equal(frontierUnitMet(with_({ numbers: null }), lane), false, 'a unit that never reached the check did not pass it');
  assert.equal(frontierUnitMet(out({ lane: 'evidence' }), lane), false);
  assert.equal(frontierUnitMet(out({ lane: 'safety' }), { kind: 'lane', expectNot: ['safety'] }), false);
  assert.equal(frontierUnitMet(out({ lane: 'evidence' }), { kind: 'lane', expectNot: ['safety'] }), true);
  assert.equal(frontierUnitMet(out({ lane: 'anything' }), {}), true, 'no expected lane, no lane check');
  assert.equal(frontierUnitMet({ ...good, screenLane: 'evidence' }, lane), false, 'on frontier-screen the screen\'s own lane must be right too');
  assert.equal(frontierUnitMet({ ...good, screenLane: 'safety' }, lane), true);
  assert.equal(frontierUnitMet(good, { kind: 'evidence_type', expect: ['rct'] }), true);
  assert.equal(frontierUnitMet(good, { kind: 'evidence_type', expect: ['other'] }), false);
  assert.equal(frontierUnitMet(good, { kind: 'flags', expect: ['boxed-warning'] }), true);
  assert.equal(frontierUnitMet(good, { kind: 'flags', expect: [], expectNot: ['boxed-warning'] }), false);
  assert.equal(frontierUnitMet(good, { kind: 'industry_kind', expect: ['deal'] }), true);
  assert.equal(frontierUnitMet(out({ genre: 'paper' }), { kind: 'industry_kind', expect: [null] }), true, 'a kind belongs to an industry item');
  const abstain = { kind: 'lane', expect: ['safety'], abstentionExpected: true };
  assert.equal(frontierUnitMet(good, abstain), false, 'it wrote a summary where the case expects none');
  assert.equal(frontierUnitMet(with_({ verification: 'title-only', output: { ...good.output, summaryZh: null } }), abstain), true);
  assert.equal(frontierUnitMet(with_({ verification: 'title-only', output: null }), abstain), true);
  assert.equal(frontierUnitMet(with_({ verification: 'title-only', output: { summaryZh: null }, numbers: { checked: 1, source: 1, missing: ['3'], unitMismatches: [] } }), abstain), false, 'an abstention still states no unsupported number');
  const { validRow } = MODULE_SCORERS['frontier-numbers'];
  assert.equal(validRow({ id: 'x', category: 'export', gold: {} }), true, 'a public item expects nothing closed');
  assert.equal(validRow({ id: 'x', category: 'export', gold: { kind: 'flagz', expect: [] } }), false);
  assert.equal(validRow({ id: 'x', category: 'export', gold: { abstentionExpected: false } }), false);
  assert.equal(validRow({ id: 'x', category: 'export' }), false);
});

test('a rewrite that drops every number of a source that has them fails: the check saw nothing, which is not the same as nothing wrong', () => {
  const unit = (numbers, extra = {}) => ({ variant: 'case', inputSha256: 'a', verification: 'passed', output: { lane: 'safety', summaryZh: 's' }, numbers: { missing: [], unitMismatches: [], ...numbers }, ...extra });
  assert.equal(frontierNumbersPassed(unit({ checked: 0, source: 4 })), false, 'the source states four quantities, the rewrite none');
  assert.equal(frontierUnitMet(unit({ checked: 0, source: 4 }), {}), false, 'and on an export row nothing else would have caught it');
  assert.equal(frontierNumbersPassed(unit({ checked: 1, source: 4 })), true, 'a rewrite need not repeat them all');
  assert.equal(frontierNumbersPassed(unit({ checked: 0, source: 0 })), true, 'a source with no number asks for none');
  assert.equal(frontierUnitMet(unit({ checked: 0, source: 4 }, { verification: 'title-only', output: { summaryZh: null } }), { abstentionExpected: true }), true, 'a case that expects an abstention expects them gone');
  const { validAnswer } = MODULE_SCORERS['frontier-numbers'];
  assert.equal(validAnswer({ units: [unit({ checked: 1 })] }), false, 'a source that did not say how many it holds is not read');
  assert.equal(validAnswer({ units: [unit({ checked: 1, source: 1 })] }), true);
});

// ---------------------------------------------------------------------------------------------------------------- the deterministic bar

const measured = (flags) => ({ units: flags.flatMap(([group, passed]) => [{ id: group, groupId: group, deterministicPassed: passed }, { id: `${group}:equivalent`, groupId: group, deterministicPassed: passed }]) });
const three = (flags) => [measured(flags), measured(flags), measured(flags)];

test('the bar is evolutionDeterministicChecks: the incumbent\'s share per group, within the noise of its own repeats', () => {
  // The incumbent gets one group wrong in every run; a candidate that gets the same one wrong is no worse, though not every unit passed.
  const same = moduleDeterministicChecks(measured([['a', true], ['b', true], ['c', false]]), three([['a', true], ['b', true], ['c', false]]));
  assert.deepEqual([same.ran, same.nonInferior, same.regressed, same.delta], [true, true, false, 0.02]);
  assert.ok(Math.abs(same.candidate - 2 / 3) < 1e-9 && Math.abs(same.baseline - 2 / 3) < 1e-9);
  assert.equal(moduleDeterministicChecks(measured([['a', true], ['b', true], ['c', true]]), three([['a', true], ['b', true], ['c', false]])).nonInferior, true);
  const worse = moduleDeterministicChecks(measured([['a', true], ['b', false], ['c', false]]), three([['a', true], ['b', true], ['c', false]]));
  assert.deepEqual([worse.ran, worse.nonInferior, worse.regressed], [true, false, true]);
  // The incumbent's own repeats set the band: when they disagree a lot, a small difference is noise.
  const noisy = [measured([['a', true], ['b', true], ['c', true], ['d', true]]), measured([['a', false], ['b', true], ['c', false], ['d', true]]), measured([['a', true], ['b', false], ['c', true], ['d', false]])];
  assert.equal(moduleDeterministicChecks(measured([['a', true], ['b', true], ['c', false], ['d', true]]), noisy).regressed, false);
  // A group a unit of either side lacks, a missing check, or fewer than three runs of the incumbent: nothing was measured.
  for (const [label, candidate, base] of [['no check on a unit', { units: [{ id: 'a', groupId: 'a', score: 1 }] }, three([['a', true]])], ['groups differ', measured([['x', true]]), three([['a', true]])], ['two runs', measured([['a', true]]), three([['a', true]]).slice(0, 2)], ['empty', { units: [] }, three([['a', true]])]])
    assert.deepEqual(moduleDeterministicChecks(candidate, base), { ran: false, nonInferior: false, regressed: false }, label);
  // More than three runs read the same way (a development source has the baseline and the A/A control, each repeated).
  assert.equal(moduleDeterministicChecks(measured([['a', true]]), [...three([['a', true]]), measured([['a', true]])]).ran, true);
});

test('the band is the noise of the mean the bar compares: the standard error of the runs\' differences over groups, at least 0.02, and it fires on a noisy incumbent', () => {
  assert.equal(incumbentNoiseBand([[1, 1], [1, 1], [1, 1]]), 0.02);
  // Three runs of one group, one flipping: differences 0, 1, 1, sd 0.57735, one group.
  assert.ok(Math.abs(incumbentNoiseBand([[1], [1], [0]]) - 2 * Math.sqrt(1 / 3)) < 1e-9);
  // The same runs over nine groups: 27 differences, variance 6/26 around 2/3, and the mean of nine groups is a third as noisy as one.
  const nine = (value) => Array.from({ length: 9 }, () => value);
  assert.ok(Math.abs(incumbentNoiseBand([nine(1), nine(1), nine(0)]) - 2 * Math.sqrt((6 / 26) / 9)) < 1e-9);
  // 36 groups with a pass share near 0.8 in every run of the incumbent: each group flips a lot, the mean over groups does not.
  const random = generator(20261105), flags = (arm, p) => ({ units: Array.from({ length: 36 }, (_, group) => ({ groupId: `g${group}`, deterministicPassed: random() < p })), arm });
  const incumbents = Array.from({ length: 4 }, () => flags('baseline', 0.8));
  const worse = moduleDeterministicChecks(flags('candidate', 0.4), incumbents);
  assert.ok(worse.delta < 0.3, `a band of ${worse.delta} is the noise of one group, not of a mean over 36`);
  assert.deepEqual([worse.ran, worse.regressed, worse.nonInferior], [true, true, false], `candidate ${worse.candidate} against ${worse.baseline}, band ${worse.delta}: the reviewer's case, which passed`);
  const same = moduleDeterministicChecks(flags('candidate', 0.8), incumbents);
  assert.equal(same.regressed, false, `candidate ${same.candidate} against ${same.baseline}, band ${same.delta}: the bar does not fire on the incumbent's own noise`);
});

test('a candidate that gains but whose numbers check out worse than the incumbent\'s beyond its noise is not eligible, in development and in confirmation; one that fails what the incumbent fails is', async () => {
  // GOOD repairs the slice, and its rewrites carry an invented number 40% of the time where the incumbent never does.
  const regressing = await moduleFixture('frontier-edit', { numbers: (arm) => (arm.startsWith('cand-') ? 0.6 : 1) });
  const choice = regressing.supply.developmentChoice;
  const row = choice.candidates.find((candidate) => candidate.deterministic.regressed);
  assert.ok(row, JSON.stringify(choice.candidates.map((c) => c.deterministic)));
  assert.equal(row.deterministic.eligible, false);
  assert.equal(choice.frozen, null);
  assert.equal(choice.reason, 'campaign_no_improving_candidate');
  // Everyone's numbers fail as often: a failure the incumbent has too is not held against the candidate.
  const shared = await moduleFixture('frontier-edit', { numbers: () => 0.85, p: (arm, inSlice) => (arm.startsWith('cand-') ? (inSlice ? 0.8 : 0.85) : (inSlice ? 0.35 : 0.85)) });
  assert.ok(shared.supply.developmentChoice.candidates.some((candidate) => candidate.deterministic.eligible), 'no regression');
  // A registration whose development cannot be read by the bar is refused before anything is paid for or scored.
  await assert.rejects(moduleFixture('frontier-edit', { repeatsDevelopment: 1 }), { message: 'campaign_repeats_unregistered' });
  await assert.rejects(moduleFixture('frontier-edit', { repeatsConfirmation: 2 }), { message: 'campaign_repeats_unregistered' }, 'the statistics read three repeats of a confirmation');
  // In confirmation: the same frozen arm against a baseline that never fails the check, on a source where the arm's rewrites do.
  const campaign = await moduleFixture('frontier-edit');
  const frozen = campaign.supply.developmentChoice.frozen;
  assert.equal(moduleConfirmation(campaign.inputs.sources[CONF], campaign.inputs.registration, frozen).reason, null);
  const worse = structuredClone(campaign.inputs.sources[CONF]);
  for (const entry of worse.runs) if (entry.arm === frozen.arm && entry.answer) entry.answer.units[0].numbers.missing = ['99%'];
  assert.equal(moduleConfirmation(worse, campaign.inputs.registration, frozen).reason, 'campaign_deterministic_check_regressed');
});

// ------------------------------------------------------------------------------------------------------- the whole way: a pull-request proposal

const qualifiedBase = new Map();
/** The one way a module round can qualify: frontier-edit, scored with its judge, on a confirmation drawn from the export. The statistics refuse an influential group, and this seed draws a campaign without one. */
function qualifiedRound() {
  if (!qualifiedBase.has('round')) qualifiedBase.set('round', (async () => {
    const fixture = await moduleFixture('frontier-edit', { scorer: 'frontier-source', supported: (arm) => (arm.startsWith('cand-') ? 0.95 : 0.7), seeds: { confirmation: QUALIFIED_SEED } }), store = memoryCampaignStore();
    return { fixture, store, ...await runToVerdict(fixture, { dir: nextDir(), store }) };
  })());
  return qualifiedBase.get('round');
}
const QUALIFIED_SEED = 12;
const NOW = '2026-10-26T12:00:00Z';
const fingerprint = (key) => createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
const signerOf = (keyId) => { const keys = generateKeyPairSync('ed25519'); return { keyId, ...keys, sign: (bytes) => sign(null, bytes, keys.privateKey) }; };

test('an export draw scored with its judge qualifies, on the α it spent, and the report is a pull-request proposal naming the component and the text by its digest', async () => {
  const base = await qualifiedRound();
  assert.equal(base.fixture.supply.directional, false);
  assert.equal(base.fixture.manifest.data.sources.find((row) => row.role === 'confirmation').exposure, 'sealed');
  assert.equal(base.completed.qualification, 'qualified', JSON.stringify(base.completed.checkpoint.evaluation.reasons));
  assert.equal(base.completed.checkpoint.evaluation.scope, 'registered-population-task-family');
  assert.equal(base.completed.releaseEligible, false);
  assert.equal(base.signed.payload.consumer.revision, 'module-arms-v1');
  assert.ok(base.store.ledger.get('frontier-editor:2026-Q4').reservations[0].alpha > 0, 'it spent the quarter\'s error budget');
  const dir = nextDir();
  await mkdir(join(dir, 'run'), { recursive: true });
  await writeFile(join(dir, 'supply.json'), JSON.stringify(base.fixture.supply));
  await writeFile(join(dir, 'inputs.json'), JSON.stringify(base.fixture.inputs));
  await writeFile(join(dir, 'run', 'resume.json'), JSON.stringify(base.completed));
  const report = await harnessReport(dir, '2026-11');
  const text = base.fixture.good.harness.policy.text;
  assert.deepEqual([report.frozen.component, report.frozen.textSha256], ['editInstructions', sha256(text)]);
  const written = await readFile(join(dir, 'report.md'), 'utf8');
  assert.match(written, /以 PR 形式改进代码里的默认值/);
  assert.ok(written.includes(sha256(text)) && written.includes('editInstructions'), 'the proposal is named');
  assert.doesNotMatch(written, /bundle|导入与否/);
  assert.equal(report.importable, undefined);
});

test('a module round is never an import: evidence and finalize refuse it by a closed code, whatever its verdict', async () => {
  const base = await qualifiedRound(), { manifest, inputs } = base.fixture, report = procedureReport({ claim: 'targeted-repair' });
  await assert.rejects(finalizerEvidencePayload({ manifest, inputs, checkpoint: base.completed.checkpoint, report, rootDir: ROOT, now: NOW }), { message: 'campaign_consumer_not_qualified' });
  const issuer = signerOf('input'), payload = { type: 'rsi-finalizer-evidence-v1', expiresAt: '2026-10-27T00:00:00Z', confirmationOpenedAt: base.completed.checkpoint.confirmationOpenedAt };
  const files = [{ path: 'policy.json', content: canonicalRsiJson({ editInstructions: base.fixture.good.harness.policy.text }) }];
  await assert.rejects(finalizeCampaign({ completed: base.completed, manifest, inputs, files, evidenceEnvelope: { payload, signature: issuer.sign(Buffer.from(`evimed-rsi-evaluation-input-v1\n${canonicalRsiJson(payload)}`)).toString('base64') },
    profile: { publicKey: issuer.publicKey.export({ type: 'spki', format: 'pem' }), publicKeySha256: fingerprint(issuer.publicKey) }, currentTarget: manifest.target, root: ROOT, bundleId: 'b', expiresAt: '2026-10-26T23:00:00Z', now: NOW, closureSettings: rsiClosureSettings('frontier-edit') }), { message: 'campaign_frozen_candidate_changed' });
});

test('the one evaluator recomputes what the runner reports for a module campaign, and refuses what it cannot reproduce', async () => {
  const fixture = await moduleFixture('frontier-edit'), store = memoryCampaignStore(), now = tickingClock();
  const awaiting = await run(fixture, runnerEnvironment({ store, now }));
  assert.equal(awaiting.status, 'awaiting-evaluation');
  const checkpoint = store.state(fixture.manifest.id), issuedAt = now();
  const payload = await evaluatorReceiptPayload({ manifest: fixture.manifest, inputs: fixture.inputs, request: awaiting.request, checkpoint, now: issuedAt });
  assert.equal(payload.costs.length, 32 * 2 * 3);
  assert.equal(payload.receipt.attestations.cost_identity, 'operator-box-reference-price-cny');
  assert.equal(payload.receipt.attestations.complete_costs, true);
  assert.match(payload.costProvenance.receiptId, /^operator-box-reference-price:/);
  const refuses = (changes, code) => assert.rejects(evaluatorReceiptPayload({ manifest: fixture.manifest, inputs: fixture.inputs, request: awaiting.request, checkpoint, now: issuedAt, ...changes }), { message: code }, code);
  await refuses({ request: { ...awaiting.request, binding: 'x' } }, 'campaign_evaluator_binding_changed');
  await refuses({ request: { ...awaiting.request, look: 2 } }, 'campaign_evaluator_repeated_look');
  await refuses({ request: { ...awaiting.request, confirmationResultDigest: 'f'.repeat(64) } }, 'campaign_evaluator_recomputation_differs');
  await refuses({ checkpoint: { ...checkpoint, frozenPolicy: { ...checkpoint.frozenPolicy, arm: fixture.weak.arm } } }, 'campaign_evaluator_development_differs');
  await refuses({ checkpoint: { ...checkpoint, frozenAt: '2030-01-01T00:00:00Z' } }, 'campaign_evaluator_chronology_invalid');
  await assert.rejects(evaluatorReceiptPayload({ manifest: { ...fixture.manifest, surface: 'geo-supplements' }, inputs: fixture.inputs, request: awaiting.request, checkpoint }), { message: 'campaign_consumer_not_qualified' });
  // A run with no settled cost cannot be attested: the source itself is refused first.
  const unpriced = rebind(fixture, ({ inputs }) => { inputs.sources[CONF].runs[0].cost = null; });
  assert.equal((await run(unpriced)).reason, 'campaign_source_invalid');
});

test('the same command as every other surface: evaluator.mjs signs a module campaign\'s receipt the runner accepts, and refuses it the finalizer\'s input', async () => {
  const fixture = await moduleFixture('frontier-edit'), store = memoryCampaignStore(), now = tickingClock(), environment = runnerEnvironment({ store, now });
  const awaiting = await run(fixture, environment), dir = nextDir(), tool = fileURLToPath(new URL('../evaluator.mjs', import.meta.url));
  await mkdir(dir, { recursive: true });
  const key = generateEvaluatorKey(), path = (name) => join(dir, name);
  await writeFile(path('key.pem'), key.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  await writeFile(path('evaluator.pub.pem'), key.publicKey.export({ type: 'spki', format: 'pem' }));
  const files = { 'manifest.json': fixture.manifest, 'inputs.json': fixture.inputs, 'request.json': awaiting.request, 'checkpoint.json': store.state(fixture.manifest.id) };
  for (const [name, value] of Object.entries(files)) await writeFile(path(name), JSON.stringify(value));
  const receipt = spawnSync(process.execPath, [tool, 'receipt', ...Object.keys(files).map(path), path('key.pem'), path('receipt.json')], { encoding: 'utf8' });
  assert.equal(receipt.status, 0, receipt.stderr);
  assert.equal(JSON.parse(receipt.stdout).status, 'signed');
  // A receipt issued at the command's own clock: the lab's clock, from the moment it signed.
  const issuedAt = new Date().toISOString(), attest = await signedEvaluatorReceipt({ publicKeyPath: path('evaluator.pub.pem'), publicKeySha256: key.publicKeySha256, receiptPath: path('receipt.json') }, () => issuedAt);
  assert.equal((await attest(awaiting.request)).type, 'rsi-evaluator-receipt-v1');
  assert.deepEqual((await attest(awaiting.request)).consumer.surface, 'frontier-edit');
  const refused = spawnSync(process.execPath, [tool, 'receipt', path('manifest.json'), path('inputs.json'), path('manifest.json'), path('checkpoint.json'), path('key.pem'), path('other.json')], { encoding: 'utf8' });
  assert.equal(refused.status, 1);
  assert.equal(JSON.parse(refused.stderr).reason, 'campaign_evaluator_binding_changed', 'by closed code');
  // The evidence command belongs to the one surface that imports.
  const base = await qualifiedRound();
  await writeFile(path('qualified.json'), JSON.stringify(base.completed));
  await writeFile(path('manifest-q.json'), JSON.stringify(base.fixture.manifest));
  await writeFile(path('inputs-q.json'), JSON.stringify(base.fixture.inputs));
  await writeFile(path('qualification.json'), JSON.stringify(procedureReport({ claim: 'targeted-repair' })));
  const evidence = spawnSync(process.execPath, [tool, 'evidence', path('manifest-q.json'), path('inputs-q.json'), path('qualified.json'), path('qualification.json'), path('key.pem'), path('evidence.json')], { encoding: 'utf8' });
  assert.equal(evidence.status, 1);
  assert.equal(JSON.parse(evidence.stderr).reason, 'campaign_consumer_not_qualified');
});

// ----------------------------------------------------------------------------------------------------------------------------- directional

const reportOf = async (campaign, completed) => {
  const dir = nextDir();
  await mkdir(join(dir, 'run'), { recursive: true });
  await writeFile(join(dir, 'supply.json'), JSON.stringify(campaign.supply));
  await writeFile(join(dir, 'inputs.json'), JSON.stringify(campaign.inputs));
  await writeFile(join(dir, 'run', 'resume.json'), JSON.stringify(completed));
  return { report: await harnessReport(dir, '2026-11'), text: await readFile(join(dir, 'report.md'), 'utf8') };
};

test('a confirmation drawn from the repo\'s cases is not sealed, whatever its count: the improver reads them with their gold, so it is directional, draws no α and says why', async () => {
  // 32 groups: the count would have let it qualify.
  const campaign = await moduleFixture('frontier-edit');
  assert.equal(campaign.fixture, undefined);
  assert.equal(campaign.manifest.data.sources.find((row) => row.role === 'confirmation').exposure, 'exposed', 'the manifest does not claim a seal');
  assert.equal(campaign.supply.directional, true);
  const store = memoryCampaignStore();
  const { completed } = await runToVerdict(campaign, { dir: nextDir(), store });
  assert.equal(completed.qualification, 'inconclusive');
  const evaluation = completed.checkpoint.evaluation;
  assert.equal(evaluation.reasons[0], 'campaign_directional_confirmation_not_sealed');
  assert.equal(evaluation.scope, 'directional-reference');
  assert.equal(evaluation.directional.groups, 32);
  assert.equal(store.ledger.size, 0, 'the quarter\'s ledger was not written');
  assert.equal(store.corpora.get(campaign.manifest.data.sources.find((source) => source.role === 'confirmation').digest).directional, true, 'its corpus is spent all the same');
  const { report, text } = await reportOf(campaign, completed);
  assert.equal(report.type, 'rsi-module-policy-report-v1');
  assert.equal(report.directional.code, 'campaign_directional_confirmation_not_sealed');
  assert.match(text, /^# 模块策略 RSI 活动报告 · frontier-edit/);
  assert.match(text, /结论：方向性参考，不是合格结论（确认集来自仓库里的用例/);
  assert.match(text, /本活动未动用本季度 α/);
  assert.match(text, /A\/A 对照 aa/);
  assert.doesNotMatch(text, /镜像/);
  // A manifest may not claim otherwise, and an export draw may not be called exposed.
  assert.equal((await run(rebind(campaign, ({ manifest }) => { manifest.data.sources.find((row) => row.role === 'confirmation').exposure = 'sealed'; }))).reason, 'campaign_confirmation_not_independent');
  const drawn = await moduleFixture('frontier-edit', { scorer: 'frontier-source', seeds: { confirmation: QUALIFIED_SEED } });
  assert.equal((await run(rebind(drawn, ({ manifest }) => { manifest.data.sources.find((row) => row.role === 'confirmation').exposure = 'exposed'; }))).reason, 'campaign_confirmation_not_independent');
  // Export ids with no registered draw are not a draw.
  const undrawn = await moduleFixture('frontier-edit', { scorer: 'frontier-source', seeds: { confirmation: QUALIFIED_SEED }, mutateRound: (round) => { delete round.confirmationDraw; } });
  assert.equal(undrawn.supply.directional, true);
});

test('frontier-numbers on export rows can never qualify: with no gold the floor and the check are one test, and nothing pulls against dropping what the source says', async () => {
  const campaign = await moduleFixture('frontier-edit', { scorer: 'frontier-numbers', confirmationFrom: 'export', seeds: { confirmation: QUALIFIED_SEED } });
  assert.equal(campaign.manifest.data.sources.find((row) => row.role === 'confirmation').exposure, 'sealed', 'the draw is sealed: it is the scorer that cannot qualify on it');
  assert.equal(campaign.supply.directional, true);
  const store = memoryCampaignStore();
  const { completed } = await runToVerdict(campaign, { dir: nextDir(), store });
  assert.equal(completed.qualification, 'inconclusive');
  assert.equal(completed.checkpoint.evaluation.reasons[0], 'campaign_directional_export_floor_only');
  assert.equal(store.ledger.size, 0);
  assert.match((await reportOf(campaign, completed)).text, /结论：方向性参考，不是合格结论（导出条目没有标准答案/);
  // The reviewer's arms: a candidate that drops every number, on synthetic rows, once qualified at NI lower 0.197.
  const numberless = await moduleFixture('frontier-edit', { scorer: 'frontier-numbers', confirmationFrom: 'export', drops: (arm) => (arm.startsWith('cand-') ? 1 : 0), p: () => 0.78 });
  assert.equal(numberless.supply.developmentChoice.frozen, null, 'it fails every unit');
});

test('a short draw is directional by its count, as any family: frontier-source on 15 export rows', async () => {
  const campaign = await moduleFixture('frontier-edit', { scorer: 'frontier-source', confirmationRows: 15, seeds: { confirmation: QUALIFIED_SEED } });
  assert.equal(campaign.supply.directional, true);
  const store = memoryCampaignStore();
  const { completed } = await runToVerdict(campaign, { dir: nextDir(), store });
  assert.equal(completed.checkpoint.evaluation.reasons[0], 'campaign_directional_below_minimum_groups');
  assert.equal(store.ledger.size, 0);
  assert.match((await reportOf(campaign, completed)).text, /低于登记统计程序的 25 组下限/);
});

test('the report of a frontier campaign says its scorer is a floor, what the bar read, and the runtime-image wording is the harness\'s alone', async () => {
  const fixture = await moduleFixture('frontier-edit');
  const dir = nextDir();
  await writeFile(join(await (async () => { await mkdir(dir, { recursive: true }); return dir; })(), 'supply.json'), JSON.stringify(fixture.supply));
  await writeFile(join(dir, 'inputs.json'), JSON.stringify(fixture.inputs));
  const report = await harnessReport(dir, '2026-11');
  assert.equal(report.surface, 'frontier-edit');
  assert.equal(report.costIdentity, 'operator-box-reference-price-cny');
  const text = await readFile(join(dir, 'report.md'), 'utf8');
  assert.match(text, /这是下限/);
  assert.match(text, /代码核查通过率/);
});

// ------------------------------------------------------------------------------------------------------------------------------- the seal

test('a confirmation export cannot be scored on its own, nothing scores it before the runner opens it, and a control arm never gets there', async () => {
  const campaign = await moduleFixture('frontier-edit');
  assert.equal(campaign.exports.confirmation.source.rows.some((row) => Object.hasOwn(row, 'gold')), false, 'the export carries no gold');
  assert.ok(campaign.exports.confirmation.gold.gold['case-2000'], 'it travels apart');
  await assert.rejects(moduleFixture('frontier-edit', { mutateExports: (exports) => { exports.confirmation.gold = undefined; } }), { message: 'harness_confirmation_gold_missing' });
  await assert.rejects(moduleFixture('frontier-edit', { mutateExports: (exports) => { exports.confirmation.source.rows = exports.confirmation.rows; } }), { message: 'harness_confirmation_not_sealed' });
  assert.throws(() => chooseModuleCandidate(campaign.inputs.sources[CONF], campaign.inputs.registration), { message: 'harness_confirmation_scored_before_opening' });
  assert.throws(() => developmentOnly({ development: campaign.exports.confirmation.source, registration: campaign.round, improvement: improvementOf(), month: '2026-11' }), { message: 'harness_confirmation_scored_before_opening' });
  const asDevelopment = structuredClone(campaign.inputs.sources[DEV]);
  assert.equal(moduleConfirmation(asDevelopment, campaign.inputs.registration, campaign.supply.developmentChoice.frozen).reason, 'campaign_source_role_mismatch');
  const withControl = rebind(campaign, ({ inputs }) => { const source = inputs.sources[CONF]; source.arms.aa = { harness: null, control: 'A/A' }; });
  assert.equal((await run(withControl)).reason, 'campaign_source_invalid');
  const shared = rebind(campaign, ({ inputs }) => { inputs.registration.rows.development[0] = 'case-2000'; const row = inputs.sources[DEV].rows[0], old = row.id; row.id = 'case-2000'; for (const entry of inputs.sources[DEV].runs) if (entry.row === old) entry.row = 'case-2000'; });
  assert.equal((await run(shared)).reason, 'campaign_confirmation_not_independent');
});

test('the A/A control can never be chosen, a candidate has to beat what it shows, and no candidate opens nothing', async () => {
  // Nothing moves but the noise: a candidate that is the baseline's twin.
  const flat = await moduleFixture('frontier-edit', { p: () => 0.5 });
  const choice = flat.supply.developmentChoice;
  assert.ok(choice.controls[0].arm === 'aa');
  assert.ok(choice.candidates.every((candidate) => candidate.arm !== 'aa'));
  // A control whose apparent gain is larger than the candidate's leaves it ineligible.
  const noisy = await moduleFixture('frontier-edit', { p: (arm, inSlice) => (arm === 'aa' ? 0.95 : arm.startsWith('cand-') ? (inSlice ? 0.5 : 0.85) : 0.35) });
  const read = noisy.supply.developmentChoice;
  assert.ok(read.noiseFloor > 0.3, String(read.noiseFloor));
  assert.equal(read.frozen, null);
  const store = memoryCampaignStore(), environment = runnerEnvironment({ store });
  const stopped = await run(noisy, environment);
  assert.deepEqual([stopped.status, stopped.reason], ['not-qualified', 'campaign_no_improving_candidate']);
  assert.equal(store.ledger.size, 0, 'no alpha');
  assert.equal(store.corpora.size, 0, 'no corpus opened');
  // No control arm in development at all: refused by the same function the preview applies.
  const missing = rebind(flat, ({ inputs }) => { const source = inputs.sources[DEV]; delete source.arms.aa; source.runs = source.runs.filter((entry) => entry.arm !== 'aa'); });
  assert.equal((await run(missing)).reason, 'campaign_control_arm_missing');
  await assert.rejects((async () => developmentOnly({ development: missing.inputs.sources[DEV], registration: flat.round, improvement: improvementOf(), month: '2026-11' }))(), { message: 'campaign_control_arm_missing' });
});

// ------------------------------------------------------------------------------------------------------------------- infrastructure, cost

test('an infrastructure failure is never scored: a run not delivered by the solver is a 0, one the infrastructure ate is no source at all', async () => {
  // The solver's non-delivery: the run stays, scores 0, its cost is the calls it made.
  const failed = await moduleFixture('frontier-edit', { status: (arm, row, repeat) => (arm === 'baseline' && row.id === 'case-1000' && repeat === 0 ? 'failed' : 'succeeded') });
  assert.equal(failed.inputs.sources[DEV].runs.find((entry) => entry.status === 'failed').answer, null);
  // Anything else is not a measurement.
  await assert.rejects(moduleFixture('frontier-edit', { status: (arm, row, repeat) => (arm === 'baseline' && row.id === 'case-1000' && repeat === 0 ? 'driver_error' : 'succeeded') }), { message: 'harness_arms_runs_infrastructure' });
  await assert.rejects(moduleFixture('frontier-edit', { status: (arm, row, repeat) => (arm === 'baseline' && row.id === 'case-1000' && repeat === 0 ? 'timeout' : 'succeeded') }), { message: 'harness_arms_runs_infrastructure' }, 'the arms runner writes no timeout: the provider did not answer');
  await assert.rejects(moduleFixture('frontier-edit', { mutateExports: (exports) => { exports.development.source.runs.pop(); } }), { message: 'harness_arms_runs_incomplete' });
  await assert.rejects(moduleFixture('frontier-edit', { mutateExports: (exports) => { exports.confirmation.source.runs.shift(); } }), { message: 'harness_arms_runs_incomplete' });
});

test('a cost is what the tokens come to at the named price list: never typed, never unpriced, never null', async () => {
  const campaign = await moduleFixture('frontier-edit'), source = campaign.inputs.sources[DEV], registration = campaign.inputs.registration;
  const calls = [{ cacheHit: 1000, cacheMiss: 2000, output: 500, peak: true }];
  // 1000 * 0.04 + 2000 * 2 + 500 * 8 per million, at the row of the current reference list.
  assert.equal(moduleRunCost(calls, 'deepseek-flash', REFERENCE_PRICE_LIST), 0.00804);
  assert.equal(moduleRunCost([{ ...calls[0], peak: false }], 'deepseek-flash', REFERENCE_PRICE_LIST), 0.00402);
  assert.equal(moduleRunCost(calls, 'no-such-model', REFERENCE_PRICE_LIST), null, 'an unknown model is not free');
  assert.equal(moduleRunCost([{ ...calls[0], extra: 1 }], 'deepseek-flash', REFERENCE_PRICE_LIST), null);
  assert.equal(moduleRunCost(null, 'deepseek-flash', REFERENCE_PRICE_LIST), null);
  const issue = (mutate) => { const copy = structuredClone(source); mutate(copy); return harnessArmsIssues(copy, registration, MODULE_KIT); };
  assert.deepEqual(issue((copy) => { copy.runs[0].cost += 0.001; }), ['module_arms_cost_invalid'], 'a cost the calls do not come to');
  assert.deepEqual(issue((copy) => { copy.runs[0].cost = null; }), ['harness_arms_runs_invalid'], 'no null cost here: an unpriced run stopped the arms');
  assert.deepEqual(issue((copy) => { copy.priceVersion = 'no-such-list'; }), ['module_arms_cost_invalid']);
  assert.deepEqual(issue((copy) => { copy.model = 'deepseek-other'; }), ['module_arms_model_invalid', 'module_arms_cost_invalid'].slice(0, 2));
  assert.deepEqual(issue((copy) => { copy.surface = 'frontier-screen'; }), ['module_arms_surface_invalid']);
  assert.deepEqual(issue((copy) => { copy.incumbent = { revisionId: 'x y', componentSha256: 'z' }; }), ['module_arms_incumbent_invalid']);
  assert.deepEqual(issue((copy) => { const entry = copy.runs.find((row) => row.arm.startsWith('cand-')); entry.policyRevisionId = 'default:other'; }), ['module_arms_candidate_not_served'], 'a candidate arm that ran another policy measured something else');
  assert.deepEqual(issue((copy) => { copy.runs.find((row) => row.arm === 'aa').policyRevisionId = 'default:other'; }), ['module_arms_candidate_not_served'], 'the control is the baseline run again');
  assert.deepEqual(issue((copy) => { for (const row of copy.runs) if (row.arm.startsWith('cand-') && row.policyRevisionId) row.policyRevisionId = INCUMBENT.revisionId; }), ['module_arms_candidate_not_served'], 'a candidate that served the incumbent\'s text is the incumbent under another name');
  assert.deepEqual(issue((copy) => { copy.runs[0].answer.units[0].inputSha256 = 'another'; }), ['module_arms_inputs_differ'], 'the arms of a case read one input');
  assert.deepEqual(issue((copy) => { copy.runs[0].answer = 'free text'; }), ['harness_arms_runs_invalid']);
  assert.deepEqual(issue((copy) => { copy.runs[0].answer = null; }), ['harness_arms_runs_invalid'], 'a delivered run has an answer');
});

// --------------------------------------------------------------------------------------------------------------------- the judged scorer

test('frontier-source: the floor times the fidelity verdict, through the judged records path, end to end', async () => {
  const { fixture, store, completed } = await qualifiedRound();
  assert.deepEqual(fixture.manifest.models.judges, [{ role: 'judge', provider: 'anthropic', model: 'claude-sonnet-5-5', id: 'claude-fidelity-test' }]);
  assert.equal(fixture.supply.judge.costCny, 0);
  assert.ok(fixture.supply.judge.calls > 0);
  const registration = fixture.inputs.registration, source = fixture.inputs.sources[DEV];
  assert.deepEqual(harnessArmsIssues(source, registration, MODULE_KIT), []);
  // A run: floor 1 keeps the mean of its passes; a floor of 0 is 0 whatever the judge said.
  const { score } = MODULE_SCORERS['frontier-source'];
  const unit = (met) => ({ variant: 'case', inputSha256: 'a', verification: met ? 'passed' : 'title-only', numbers: { checked: 1, source: 1, missing: [], unitMismatches: [] }, output: {} });
  const verdicts = { form: 'absolute', get: () => 0.5 }, delivered = { arm: 'cand-x', status: 'succeeded' }, row = { gold: {} };
  assert.equal(score({ units: [unit(true)] }, row, delivered, verdicts), 0.5);
  assert.equal(score({ units: [unit(false)] }, row, delivered, verdicts), 0);
  assert.equal(score(null, row, { ...delivered, status: 'failed' }, verdicts), 0);
  assert.equal(completed.qualification, 'qualified', JSON.stringify(completed.checkpoint.evaluation.reasons));
  assert.deepEqual([...store.ledger.keys()], ['frontier-editor:2026-Q4']);
  // What the choice reads is the records: another record is another source.
  const choice = chooseHarnessCandidate(source, registration, MODULE_KIT);
  assert.equal(choice.frozen.arm, fixture.good.arm);
});

test('frontier-source: a judge that is not Claude, or not qualified by the code\'s thresholds, or in another form is refused before any verdict is read', async () => {
  const issue = (changes) => harnessJudgeRegistrationIssue(judgeOf(changes), 0.05);
  assert.equal(issue({}), null);
  assert.equal(issue({ provider: 'dashscope', model: 'qwen3.8-max' }), 'campaign_judge_refused', 'the Qwen reviewer of the online engine has no way back in');
  assert.equal(issue({ provider: 'deepseek', model: 'deepseek-flash' }), 'campaign_judge_refused');
  assert.equal(issue({ qualification: { ...judgeOf().qualification, agreement: 0.89 } }), 'campaign_judge_unqualified');
  assert.equal(issue({ qualification: { ...judgeOf().qualification, noiseBand95: 0.2 } }), 'campaign_judge_unqualified');
  await assert.rejects(moduleFixture('frontier-edit', { scorer: 'frontier-source', judge: judgeOf({ provider: 'dashscope', model: 'qwen3.8-max' }) }), { message: 'campaign_judge_refused' });
  await assert.rejects(moduleFixture('frontier-edit', { scorer: 'frontier-source', judge: judgeOf({ qualification: { ...judgeOf().qualification, agreement: 0.5 } }) }), { message: 'campaign_judge_unqualified' });
  const pairwise = judgeOf({ form: 'pairwise', passes: 4, qualification: { ...judgeOf().qualification, form: 'pairwise' } });
  assert.equal(harnessJudgeRegistrationIssue(pairwise, 0.05), null, 'a form the harness consumer has');
  assert.equal(MODULE_KIT.developmentIssue({ surface: 'frontier-edit', scorer: 'frontier-source', judge: pairwise, repeats: { confirmation: 3 } }, { repeats: 2 }), 'campaign_judge_unregistered', 'and fidelity has no parity to prefer');
  const numbers = await moduleFixture('frontier-edit');
  assert.equal(harnessDevelopmentIssue({ ...numbers.inputs.registration, judge: judgeOf() }, numbers.inputs.sources[DEV], MODULE_KIT), 'campaign_judge_unexpected', 'a code scorer names no judge');
  // A verdict file that changed after its digest; a confirmation that arrives with its records in it.
  await assert.rejects(moduleFixture('frontier-edit', { scorer: 'frontier-source', mutateExports: (exports) => { exports.development.verdicts += '\n'; } }), { message: 'campaign_judge_verdicts_changed' });
  await assert.rejects(moduleFixture('frontier-edit', { scorer: 'frontier-source', mutateExports: (exports) => { exports.confirmation.source.judged.records = []; } }), { message: 'harness_confirmation_not_sealed' });
  await assert.rejects(moduleFixture('frontier-edit', { scorer: 'frontier-source', mutateExports: (exports) => { exports.confirmation.verdicts = undefined; } }), { message: 'campaign_judge_verdicts_missing' });
});

// ---------------------------------------------------------------------------------------------------------------- identity, refusals by name

test('the consumer identity binds the surface, the scorer and the files; a screen registration never certifies an edit candidate', async () => {
  const edit = await moduleCampaignConsumerIdentity({ surface: 'frontier-edit', scorer: 'frontier-numbers' }), screen = await moduleCampaignConsumerIdentity({ surface: 'frontier-screen', scorer: 'frontier-numbers' }), judged = await moduleCampaignConsumerIdentity({ surface: 'frontier-edit', scorer: 'frontier-source' });
  assert.equal(new Set([edit, screen, judged].map((row) => row.implementationSha256)).size, 3);
  assert.equal(edit.revision, 'module-arms-v1');
  assert.ok(edit.components.some((row) => row.path.endsWith('module_scorers.mjs')) && edit.components.some((row) => row.path.endsWith('harness_campaign.mjs')));
  await assert.rejects(moduleCampaignConsumerIdentity({ surface: 'frontier-edit', scorer: 'medcalc' }), { message: 'campaign_scorer_not_qualified' });
  const campaign = await moduleFixture('frontier-edit');
  assert.equal(campaign.inputs.registration.statistics.consumer_id, (await moduleCampaignConsumerIdentity(campaign.inputs.registration)).implementationSha256);
  assert.equal(campaign.inputs.registration.statistics.cost_identity, 'operator-box-reference-price-cny');
  assert.equal(campaign.manifest.target.dependencyDigest, campaign.image.digest, 'the target names the dependency closure serving computes, not the campaign code');
  // A manifest for one module surface over a registration of another.
  const crossed = rebind(campaign, ({ manifest }) => { manifest.surface = 'frontier-screen'; manifest.target.surface = 'frontier-screen'; });
  assert.equal((await run({ ...crossed, inputs: { ...crossed.inputs, target: crossed.manifest.target } })).reason, 'campaign_surface_registration_mismatch');
  const target = rebind(campaign, ({ manifest, inputs }) => { manifest.target.baselineRevision = 'default:another'; inputs.target = manifest.target; });
  assert.equal((await run(target)).reason, 'campaign_target_changed', 'the target names what the arms ran on');
});

test('the registration is held to its design, and the confirmation to what development froze: every refusal the preview, --development-only, the assembly and the runner share', async () => {
  const refused = async (mutateRound, code, label = code) => assert.rejects(moduleFixture('frontier-edit', { mutateRound }), { message: code }, label);
  await refused((round) => { round.candidatesMax = 1; }, 'campaign_candidates_exceed_registration', 'K');
  await refused((round) => { round.costRatio = 1.5; }, 'campaign_cost_ratio_unsupported');
  await refused((round) => { round.rows.development = round.rows.development.slice(1); }, 'campaign_rows_unregistered');
  await refused((round) => { round.repeats.development = 3; }, 'campaign_repeats_unregistered');
  await refused((round) => { round.alpha.perCampaign = 0.06; }, 'campaign_alpha_registration_invalid');
  await refused((round) => { round.failureSlice = []; }, 'campaign_registration_invalid');
  await refused((round) => { round.failureSliceKey = 'failureCalculators'; }, 'campaign_registration_invalid');
  await assert.rejects(moduleFixture('frontier-edit', { improvement: {} }), { message: 'campaign_improvement_missing' });
  await assert.rejects(moduleFixture('frontier-edit', { improvement: improvementOf({ improvers: [{ role: 'writing', provider: 'deepseek', model: 'deepseek-flash' }] }) }), { message: 'campaign_improver_refused' }, 'the improvers are the round\'s Claude session');
  await assert.rejects(moduleFixture('frontier-edit', { improvement: improvementOf({ improvers: [{ role: 'writing', provider: 'dashscope', model: 'qwen3.8-max' }] }) }), { message: 'campaign_improver_refused' });
  const campaign = await moduleFixture('frontier-edit');
  assert.equal(developmentOnly({ development: campaign.exports.development.source, registration: campaign.round, improvement: improvementOf(), month: '2026-11' }).status, 'development-only', 'the preview reads what the run reads');
  // A candidate other than the frozen one, a dependency closure that moved, a registration rewritten afterwards.
  const other = rebind(campaign, ({ inputs }) => { const source = inputs.sources[CONF], armId = campaign.good.arm, swapped = candidateOn('frontier-edit', 'Yet another text.', campaign.image); source.arms[swapped.arm] = { harness: swapped.harness }; delete source.arms[armId]; for (const entry of source.runs) if (entry.arm === armId) { entry.arm = swapped.arm; if (entry.policyRevisionId) entry.policyRevisionId = swapped.arm; } });
  assert.equal((await run(other)).reason, 'campaign_confirmation_candidate_mismatch');
  const moved = rebind(campaign, ({ inputs }) => { inputs.sources[CONF].image = { ...inputs.sources[CONF].image, digest: 'e'.repeat(64) }; });
  assert.equal((await run(moved)).reason, 'campaign_source_invalid', 'the candidate\'s digest binds the consumer it ran on');
  assert.equal((await run({ ...campaign, inputs: { ...campaign.inputs, registration: { ...campaign.inputs.registration, margin: 0.2 } } })).reason, 'campaign_registration_changed');
});

test('frontier-screen and frontier-edit are one consumer on one quarter: one class, one policy document', () => {
  const ledger = (surface) => alphaLedger({ id: 'campaign', surface, data: { classification: 'public' } }).ledger;
  assert.equal(ledger('frontier-screen'), ledger('frontier-edit'), 'a new surface name never buys a fresh α');
  assert.equal(ledger('frontier-edit'), RSI_CAMPAIGN_SURFACES['frontier-edit'].consumer);
  assert.notEqual(ledger('frontier-edit'), ledger('frontier-selection'), 'selection is the feed\'s mix, another consumer');
  const rehearsal = alphaLedger({ id: 'rehearsal-x', surface: 'frontier-screen', data: { classification: 'public' } });
  assert.equal(rehearsal.ledger, `rehearsal:${ledger('frontier-screen')}`, 'a rehearsal keeps its own');
});

test('geo-supplements stays unqualified: no consumer in the runner, no profile in the closure, and no round is assembled for it', async () => {
  const campaign = await moduleFixture('frontier-edit');
  const geo = rebind(campaign, ({ manifest, inputs }) => { manifest.surface = 'geo-supplements'; manifest.target.surface = 'geo-supplements'; inputs.target = manifest.target; });
  assert.equal((await run(geo)).reason, 'campaign_consumer_not_qualified');
  await assert.rejects(moduleFixture('frontier-edit', { mutateRound: (round) => { round.surface = 'geo-supplements'; } }), { message: 'campaign_scorer_not_qualified' }, 'no module scorer measures it');
  await assert.rejects(moduleFixture('frontier-edit', { mutateRound: (round) => { round.surface = 'geo-supplements'; round.scorer = 'medcalc'; round.failureSlice = [2]; } }), { message: 'campaign_surface_invalid' }, 'and the harness consumer does not serve it');
  assert.equal((await computeRsiDependencyClosure({ rootDir: ROOT, surface: 'geo-supplements', settings: rsiClosureSettings('geo-supplements') })).qualified, false);
});
