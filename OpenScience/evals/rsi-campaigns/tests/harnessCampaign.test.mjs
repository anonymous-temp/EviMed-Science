import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rsiDigest as digest } from '../../../apps/server/src/rsiCampaignBundle.mjs';
import { runCampaign } from '../campaign_runner.mjs';
import { evaluatorReceiptPayload } from '../evaluator.mjs';
import { attachGold, attachVerdicts, buildHarnessCampaign, developmentOnly, readChecked } from '../harness_assemble.mjs';
import { HARNESS_ALWAYS_ON_MAX_CHARS, chooseHarnessCandidate, harnessArmsIssues, harnessCampaignConsumerIdentity, harnessObservations, harnessPatchDigest, harnessPatchSizes, normalizeHarnessBundle } from '../harness_campaign.mjs';
import { harnessReport } from '../harness_report.mjs';
import { skillCampaignConsumerIdentity } from '../skill_campaign.mjs';
import { memoryCampaignStore, runToVerdict, runnerEnvironment, tickingClock } from '../profiles/benign_fixture.mjs';
import { AA, BASE, GOOD, IMAGE, WEAK, bundleOf, candidate, harnessFixture, judgeOf, rebind, sha256 } from '../profiles/harness_fixture.mjs';

const scratch = await mkdtemp(join(tmpdir(), 'rsi-harness-'));
let dirs = 0;
const nextDir = () => join(scratch, String(dirs += 1));
const vectors = JSON.parse(await readFile(new URL('./fixtures/scorer-vectors.json', import.meta.url), 'utf8'));
const DEV = 'development-2026-11', CONF = 'confirmation-2026-11';
const run = (campaign, environment = runnerEnvironment()) => runCampaign({ manifest: campaign.manifest, inputs: campaign.inputs, ...environment });

// -------------------------------------------------------------------------------------------------------------- the candidate

test('the patch digest is the canonical JSON of the bundle and the image, the same in Python and in JS', () => {
  assert.ok(vectors.harnessDigest.length >= 8);
  for (const { name, bundle, image, digest: expected, chars, alwaysOnChars } of vectors.harnessDigest) {
    assert.equal(harnessPatchDigest(bundle, image), expected, name);
    assert.deepEqual(harnessPatchSizes(bundle), { chars, alwaysOnChars }, name);
  }
});

test('the digest binds every part of the patch and the image it was measured on, and not the order of the skills', () => {
  const bundle = { guidanceSupplement: 'G', skills: [{ name: 'b-skill', description: 'd2', body: 'x2' }, { name: 'a-skill', description: 'd1', body: 'x1' }] };
  const base = harnessPatchDigest(bundle, IMAGE);
  assert.equal(harnessPatchDigest({ ...bundle, skills: [...bundle.skills].reverse() }, IMAGE), base);
  assert.notEqual(harnessPatchDigest({ ...bundle, guidanceSupplement: 'G ' }, IMAGE), base);
  assert.notEqual(harnessPatchDigest({ ...bundle, skills: [{ ...bundle.skills[0], body: 'x3' }, bundle.skills[1]] }, IMAGE), base);
  assert.notEqual(harnessPatchDigest(bundle, { ...IMAGE, digest: 'cd'.repeat(32) }), base, 'the same patch on another image is another candidate');
  assert.notEqual(harnessPatchDigest(bundle, { ...IMAGE, id: 'other-release' }), base);
  for (const bad of [null, {}, { guidanceSupplement: '', skills: [] }, { guidanceSupplement: 'G' }, { guidanceSupplement: 'G', skills: [], extra: 1 },
    { guidanceSupplement: 'G', skills: [{ name: 'Bad Name', description: 'd', body: 'b' }] }, { guidanceSupplement: 'G', skills: [{ name: 'a', description: 'd', body: 'b' }, { name: 'a', description: 'd', body: 'b' }] },
    { guidanceSupplement: 'G', skills: [{ name: 'a', description: 'd', body: 'b', extra: 1 }] }, { guidanceSupplement: 7, skills: [] }]) {
    assert.equal(normalizeHarnessBundle(bad), null, JSON.stringify(bad));
    assert.throws(() => harnessPatchDigest(bad, IMAGE), { message: 'harness_bundle_invalid' });
  }
  assert.throws(() => harnessPatchDigest(bundle, { id: 'x', digest: 'short' }), { message: 'harness_bundle_invalid' });
});

test('a candidate arm is admitted only with its digest recomputed from its bundle on its image, and within the always-on cap', async () => {
  const campaign = await harnessFixture('medcalc');
  const [development, , registration] = [campaign.inputs.sources[DEV], campaign.inputs.sources[CONF], campaign.inputs.registration];
  assert.deepEqual(harnessArmsIssues(development, registration), []);
  const withArm = (mutate) => { const copy = structuredClone(development); mutate(copy); return harnessArmsIssues(copy, registration); };
  assert.deepEqual(withArm((s) => { s.arms[GOOD.arm].harness.bundle.guidanceSupplement += ' changed'; }), ['harness_arms_candidate_invalid'], 'the bundle is not the digested one');
  assert.deepEqual(withArm((s) => { s.arms[GOOD.arm].harness.digest = 'f'.repeat(64); }), ['harness_arms_candidate_invalid']);
  assert.deepEqual(withArm((s) => { s.image = { ...s.image, digest: 'cd'.repeat(32) }; }), ['harness_arms_candidate_invalid'], 'measured on another image');
  assert.deepEqual(withArm((s) => { s.arms[GOOD.arm].harness.alwaysOnChars += 1; }), ['harness_arms_candidate_invalid']);
  assert.deepEqual(withArm((s) => { s.arms['cand-000000000000'] = structuredClone(s.arms[GOOD.arm]); }), ['harness_arms_candidate_invalid'], 'the id is the digest');
  // An always-on growth beyond the cap is refused although its digest is honest.
  const fat = (() => { const bundle = bundleOf('fat-skill', 'G'.repeat(HARNESS_ALWAYS_ON_MAX_CHARS)); const digestValue = harnessPatchDigest(bundle, IMAGE); return { arm: `cand-${digestValue.slice(0, 12)}`, harness: { digest: digestValue, ...harnessPatchSizes(bundle), title: 'fat', bundle } }; })();
  assert.ok(fat.harness.alwaysOnChars > HARNESS_ALWAYS_ON_MAX_CHARS);
  assert.deepEqual(withArm((s) => { s.arms[fat.arm] = { harness: fat.harness }; s.runs.push(...s.runs.filter((r) => r.arm === GOOD.arm).map((r) => ({ ...r, arm: fat.arm, runId: `${r.runId}-fat` }))); }), ['harness_arms_candidate_invalid']);
  assert.deepEqual(withArm((s) => { s.arms[GOOD.arm].extra = true; }), ['harness_arms_candidate_invalid']);
  assert.deepEqual(withArm((s) => { s.arms.baseline = { harness: GOOD.harness }; }), ['harness_arms_baseline_missing']);
});

test('the harness consumer identity binds the scorer id and every file it is made of, and is not the skill consumer\'s', async () => {
  const mbc = await harnessCampaignConsumerIdentity({ scorer: 'mbc-normalized' }), medcalc = await harnessCampaignConsumerIdentity({ scorer: 'medcalc' });
  assert.notEqual(mbc.implementationSha256, medcalc.implementationSha256);
  assert.deepEqual(mbc.components.map((c) => c.path), ['skill_campaign.mjs', 'skill_scorers.mjs', 'harness_scorers.mjs', 'harness_campaign.mjs'].map((n) => `evals/rsi-campaigns/${n}`));
  assert.notEqual(medcalc.implementationSha256, (await skillCampaignConsumerIdentity({ scorer: 'medcalc' })).implementationSha256);
  await assert.rejects(harnessCampaignConsumerIdentity({}), { message: 'campaign_scorer_not_qualified' }, 'a harness registration names its scorer');
  await assert.rejects(harnessCampaignConsumerIdentity({ scorer: 'judge' }), { message: 'campaign_scorer_not_qualified' });
});

// ----------------------------------------------------------------------------------------------------------- end to end

for (const kitId of ['medcalc', 'mbc', 'judged']) {
  test(`${kitId}: a patch that repairs its failure slice is qualified end to end on recorded lane runs, with attested settled costs`, async () => {
    const campaign = await harnessFixture(kitId);
    assert.equal(campaign.supply.developmentChoice.frozen.arm, GOOD.arm);
    assert.ok(campaign.supply.developmentChoice.controls.length === 1 && campaign.supply.developmentChoice.controls[0].arm === 'aa');
    const { awaiting, completed, signed } = await runToVerdict(campaign, { dir: nextDir() });
    assert.equal(awaiting.status, 'awaiting-evaluation', JSON.stringify(awaiting).slice(0, 300));
    assert.equal(completed.status, 'completed', JSON.stringify(completed).slice(0, 400));
    assert.equal(completed.qualification, 'qualified', JSON.stringify(completed.checkpoint.evaluation?.reasons ?? completed).slice(0, 400));
    assert.equal(completed.checkpoint.frozenPolicy.arm, GOOD.arm);
    assert.equal(completed.checkpoint.frozenPolicy.imageDigest, IMAGE.digest);
    assert.equal(signed.payload.consumer.scorer, campaign.kit.scorer);
    assert.equal(signed.payload.consumer.revision, 'harness-arms-v1');
    assert.equal(signed.payload.consumer.implementationSha256, campaign.inputs.registration.statistics.consumer_id);
    assert.equal(signed.payload.receipt.deterministic_qualification, null);
    assert.ok(signed.payload.costs.every((row) => row.cost > 0));
    assert.match(signed.payload.costProvenance.receiptId, /^lane-usage-ledger:/);
    assert.equal(completed.checkpoint.evaluation.quantities['targeted-repair'].failure_slice_quality.n_groups, campaign.inputs.registration.statistics.groups.filter((g) => g.failure_slice).length);
    assert.equal(completed.checkpoint.stages.development.result.noiseFloor, campaign.supply.developmentChoice.noiseFloor);
  });
}

// --------------------------------------------------------------------------------- the closed registry, the control arm

test('only a registered consumer is admitted: an id outside the closed registries answers campaign_consumer_not_qualified or is refused by name', async () => {
  const campaign = await harnessFixture('medcalc');
  // A surface the domain knows and the lab has no consumer for.
  const unqualified = structuredClone(campaign.manifest);
  unqualified.surface = 'geo-supplements'; unqualified.candidateKind = 'policy'; unqualified.target = { ...unqualified.target, surface: 'geo-supplements' };
  assert.deepEqual(await run({ ...campaign, manifest: unqualified }), { status: 'not-qualified', reason: 'campaign_consumer_not_qualified' });
  // A surface nobody registered at all.
  for (const surface of ['harness-patches', 'harness', '__proto__', 'Harness-Patch']) {
    const stray = structuredClone(campaign.manifest);
    stray.surface = surface; stray.target = { ...stray.target, surface };
    assert.equal((await run({ ...campaign, manifest: stray })).reason, 'campaign_surface_invalid', surface);
  }
  // The kind is the surface's: a harness-patch campaign cannot say it is a skill.
  const wrongKind = structuredClone(campaign.manifest); wrongKind.candidateKind = 'skill';
  assert.equal((await run({ ...campaign, manifest: wrongKind })).reason, 'campaign_surface_invalid');
  // Scorers: a harness registration names one of the six, and the personal-skill surface still admits only its four.
  for (const scorer of [undefined, 'judge', 'MEDCALC', '', null, 7, ['medcalc'], '__proto__', 'constructor', '../harness_scorers.mjs']) {
    const hostile = rebind(campaign, ({ inputs }) => { if (scorer === undefined) delete inputs.registration.scorer; else inputs.registration.scorer = scorer; });
    const store = memoryCampaignStore();
    assert.deepEqual(await run(hostile, runnerEnvironment({ store })), { status: 'not-qualified', reason: 'campaign_scorer_not_qualified' }, JSON.stringify(scorer));
    assert.equal(store.writes(), 0);
  }
  const mbc = await harnessFixture('mbc');
  const asSkill = rebind(mbc, ({ manifest, inputs }) => { manifest.surface = 'capability-skill'; manifest.candidateKind = 'skill'; manifest.target = { ...manifest.target, surface: 'capability-skill' }; inputs.target = manifest.target; });
  assert.equal((await run(asSkill)).reason, 'campaign_scorer_not_qualified', 'mbc-normalized is not a personal-skill scorer');
});

test('the A/A control is never a candidate: it cannot be frozen, promoted or carried into confirmation', async () => {
  // The control happens to repair the slice better than any patch (noise), and the patches repair it too.
  const noisy = (arm, inSlice) => (arm === 'aa' ? (inSlice ? 0.95 : 0.85) : arm === GOOD.arm ? (inSlice ? 0.8 : 0.85) : inSlice ? 0.35 : 0.85);
  const campaign = await harnessFixture('medcalc', { p: noisy });
  // Nothing beats the noise the control shows, so there is nothing to freeze: the assembler reports it and the campaign ends honestly.
  assert.equal(campaign.supply?.developmentChoice.frozen ?? null, null);
  assert.equal(campaign.supply.developmentChoice.reason, 'campaign_no_improving_candidate');
  const control = campaign.supply.developmentChoice.controls[0];
  assert.ok(control.sliceDifference > 0.3, 'the control repairs the slice as much as any patch does');
  assert.ok(campaign.supply.developmentChoice.candidates.every((c) => c.sliceDifference <= control.sliceDifference), 'no patch beats it');
  assert.equal(campaign.supply.developmentChoice.noiseFloor, Math.abs(control.sliceDifference));
  const store = memoryCampaignStore();
  const ended = await run(campaign, runnerEnvironment({ store, now: tickingClock() }));
  assert.equal(ended.reason, 'campaign_no_improving_candidate');
  assert.equal(store.ledger.size, 0, 'nothing is opened');
  // Only the control improves: still nothing to promote.
  const onlyControl = await harnessFixture('medcalc', { p: (arm, inSlice) => (arm === 'aa' ? (inSlice ? 0.95 : 0.85) : inSlice ? 0.35 : 0.85) });
  assert.equal(onlyControl.supply.developmentChoice.frozen, null);
  const choice = chooseHarnessCandidate(onlyControl.inputs.sources[DEV], onlyControl.inputs.registration);
  assert.ok(choice.candidates.every((c) => c.arm !== 'aa'), 'the control is listed as a control, not as a candidate');
  assert.deepEqual(choice.controls.map((c) => c.arm), ['aa']);
  // A candidate whose gain exceeds the control's apparent difference is eligible, and still is not the control.
  const fair = await harnessFixture('medcalc');
  assert.equal(fair.supply.developmentChoice.frozen.arm, GOOD.arm);
  assert.ok(fair.supply.developmentChoice.candidates.find((c) => c.arm === GOOD.arm).sliceDifference > fair.supply.developmentChoice.noiseFloor);
  // A frozen policy that names the control is not one the evaluator signs.
  const store2 = memoryCampaignStore(), now = tickingClock();
  const awaiting = await run(fair, runnerEnvironment({ store: store2, now }));
  assert.equal(awaiting.status, 'awaiting-evaluation');
  const forged = store2.state(fair.manifest.id);
  forged.frozenPolicy.arm = 'aa'; forged.frozenPolicyDigest = digest(forged.frozenPolicy);
  await assert.rejects(evaluatorReceiptPayload({ ...fair, request: { ...awaiting.request, frozenPolicyDigest: forged.frozenPolicyDigest }, checkpoint: forged, now: now() }), { message: 'campaign_evaluator_development_differs' });
  // The confirmation scoring refuses a frozen control and a source that carries one.
  const confirmation = fair.inputs.sources[CONF];
  assert.equal(harnessObservations(confirmation, fair.inputs.registration, { arm: 'aa', harnessDigest: GOOD.harness.digest, imageDigest: IMAGE.digest }).reason, 'campaign_confirmation_candidate_mismatch');
  const withControl = rebind(fair, ({ inputs }) => { const source = inputs.sources[CONF]; source.arms.aa = { harness: null, control: 'A/A' }; source.runs.push(...source.runs.filter((r) => r.arm === 'baseline').map((r) => ({ ...r, arm: 'aa', runId: `${r.runId}-aa` }))); });
  assert.equal((await run(withControl)).reason, 'campaign_source_invalid', 'the control is a development arm only');
  // A development source without a control, or one that names the control something else, is not the registered design.
  assert.equal((await run(rebind(fair, ({ inputs }) => { const s = inputs.sources[DEV]; delete s.arms.aa; s.runs = s.runs.filter((r) => r.arm !== 'aa'); }))).reason, 'campaign_control_arm_missing');
  assert.deepEqual(harnessArmsIssues({ ...fair.inputs.sources[DEV], arms: { ...fair.inputs.sources[DEV].arms, aa: { harness: null, control: 'B/B' } } }, fair.inputs.registration), ['harness_arms_control_invalid']);
  assert.equal((await run(rebind(fair, ({ inputs }) => { inputs.registration.control = { arm: 'aa', kind: 'B/B' }; }))).reason, 'campaign_control_unregistered');
});

// ------------------------------------------------------------------------------------------------------------- the seal

test('a confirmation export is not scorable on its own: no gold in its rows, and nothing scores it before the runner opens it', async () => {
  const campaign = await harnessFixture('medcalc');
  const sealed = campaign.exports.confirmation.source, goldFile = campaign.exports.confirmation.gold;
  assert.ok(sealed.rows.every((row) => !Object.hasOwn(row, 'gold')) && sealed.runs.length > 0 && sealed.runs.every((r) => r.answer !== undefined && r.cost !== undefined));
  assert.equal(goldFile.kind, 'harness-gold');
  assert.deepEqual(harnessArmsIssues(sealed, campaign.inputs.registration), ['harness_arms_rows_invalid'], 'as exported it is not a source the consumer can score');
  // The development choice reads a development source only; the confirmation scoring a confirmation source only.
  assert.throws(() => chooseHarnessCandidate(campaign.inputs.sources[CONF], campaign.inputs.registration), { message: 'harness_confirmation_scored_before_opening' });
  assert.throws(() => developmentOnly({ development: campaign.inputs.sources[CONF], registration: campaign.round }), { message: 'harness_confirmation_scored_before_opening' });
  const frozen = campaign.supply.developmentChoice.frozen;
  assert.equal(harnessObservations(campaign.inputs.sources[DEV], campaign.inputs.registration, frozen).reason, 'campaign_source_role_mismatch');
  // The assembly joins the gold only from the gold file, checked against these rows.
  const joined = attachGold(sealed, goldFile);
  assert.deepEqual(harnessArmsIssues(joined, campaign.inputs.registration), []);
  assert.throws(() => attachGold(joined, goldFile), { message: 'harness_confirmation_not_sealed' }, 'rows that already carry gold are not a sealed export');
  assert.throws(() => attachGold(sealed, { ...goldFile, benchmark: 'bixbench' }), { message: 'harness_gold_invalid' });
  const dropped = structuredClone(goldFile); delete dropped.gold[Object.keys(dropped.gold)[0]];
  assert.throws(() => attachGold(sealed, dropped), { message: 'harness_gold_rows_differ' });
  const common = { development: campaign.exports.development.source, registration: campaign.round, month: '2026-11', pilotRationale: 'Synthetic.' };
  await assert.rejects(buildHarnessCampaign({ ...common, confirmation: sealed }), { message: 'harness_confirmation_gold_missing' });
  await assert.rejects(buildHarnessCampaign({ ...common, confirmation: joined }), { message: 'harness_confirmation_not_sealed' });
  await assert.rejects(buildHarnessCampaign({ ...common, confirmation: joined, confirmationGold: goldFile }), { message: 'harness_confirmation_not_sealed' });
});

test('a campaign whose development finds nothing opens nothing: no corpus, no alpha, no confirmation stage', async () => {
  const flat = await harnessFixture('mbc', { p: () => 0.5 });
  assert.equal(flat.supply.developmentChoice.frozen, null);
  const store = memoryCampaignStore();
  const result = await run(flat, runnerEnvironment({ store, now: tickingClock() }));
  assert.equal(result.status, 'not-qualified');
  assert.equal(result.reason, 'campaign_no_improving_candidate');
  assert.equal(store.ledger.size, 0);
  assert.equal(store.corpora.size, 0);
  assert.equal(store.state(flat.manifest.id).stages.confirmation, undefined, 'the confirmation source was not scored');
  // The development-only recomputation reads no confirmation file at all.
  const only = developmentOnly({ development: flat.exports.development.source, registration: flat.round, month: '2026-11' });
  assert.equal(only.status, 'development-only');
  assert.equal(only.supply.developmentChoice.frozen, null);
  assert.equal(only.supply.developmentChoice.reason, 'campaign_no_improving_candidate');
});

test('an input file is checked against its digest before it is read', async () => {
  const dir = nextDir();
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'confirmation.gold.json');
  await writeFile(path, '{"kind":"harness-gold"}\n');
  await assert.rejects(readChecked(path), { message: 'campaign_input_checksum_missing' });
  await writeFile(`${path}.sha256`, `${sha256('{"kind":"harness-gold"}\n')}  confirmation.gold.json\n`);
  assert.equal(await readChecked(path), '{"kind":"harness-gold"}\n');
  await writeFile(path, '{"kind":"harness-gold","gold":{"1":1}}\n');
  await assert.rejects(readChecked(path), { message: 'campaign_input_checksum_mismatch' });
  assert.equal(await readChecked(path, false), '{"kind":"harness-gold","gold":{"1":1}}\n');
});

// ----------------------------------------------------------------------------------------------- infrastructure, not zeros

test('an infrastructure failure or a missing run is never scored as a zero; a solver\'s own non-delivery is', async () => {
  for (const status of ['driver_error', 'dispatch_refused', 'interrupted', 'canceled', 'unknown']) {
    await assert.rejects(harnessFixture('medcalc', { confirmationStatus: (arm, row, repeat) => (arm === GOOD.arm && row.id === '2003' && repeat === 1 ? status : 'succeeded') }), { message: 'harness_arms_runs_infrastructure' }, status);
  }
  await assert.rejects(harnessFixture('medcalc', { mutateExports: ({ confirmation }) => { confirmation.source.runs.pop(); } }), { message: 'harness_arms_runs_incomplete' });
  await assert.rejects(harnessFixture('medcalc', { mutateExports: ({ development }) => { development.source.runs.splice(3, 1); } }), { message: 'harness_arms_runs_incomplete' });
  // A hand-edited inputs.json is refused by the runner by the same names.
  const campaign = await harnessFixture('medcalc');
  const incomplete = rebind(campaign, ({ inputs }) => { inputs.sources[CONF].runs.pop(); });
  assert.equal((await run(incomplete)).reason, 'campaign_source_invalid');
  assert.deepEqual(harnessArmsIssues(incomplete.inputs.sources[CONF], incomplete.inputs.registration), ['harness_arms_runs_incomplete']);
  // A timeout, or a run that failed for the solver's own reasons, is a run: it scores 0 and the measurement stands.
  const timed = await harnessFixture('medcalc', { confirmationStatus: (arm, row, repeat) => (arm === GOOD.arm && ['2001', '2002'].includes(row.id) ? (repeat === 0 ? 'timeout' : 'failed') : 'succeeded') });
  const frozen = timed.supply.developmentChoice.frozen;
  const measured = harnessObservations(timed.inputs.sources[CONF], timed.inputs.registration, frozen);
  const lost = measured.observations.filter((o) => o.arm === 'candidate' && ['row-2001', 'row-2002'].includes(o.group) && o.repeat < 2);
  assert.equal(lost.length, 4);
  assert.ok(lost.every((o) => o.quality === 0));
  const { completed } = await runToVerdict(timed, { dir: nextDir() });
  assert.equal(completed.status, 'completed');
});

// ------------------------------------------------------------------------------------------------------------- judged

test('judged: a verdict file that changes after its digest is refused, in the assembly and in the lab, and a rewritten source is another source', async () => {
  const campaign = await harnessFixture('judged');
  const { development, confirmation } = campaign.exports;
  const edited = (text) => text.replace(/"score":([0-9.]+)/, (_, score) => `"score":${Number(score) === 0.5 ? 0.6 : 0.5}`);
  assert.notEqual(edited(confirmation.verdicts), confirmation.verdicts);
  const base = { development: development.source, confirmation: confirmation.source, registration: campaign.round, month: '2026-11', pilotRationale: 'Synthetic.', developmentVerdicts: development.verdicts, confirmationVerdicts: confirmation.verdicts };
  await assert.rejects(buildHarnessCampaign({ ...base, confirmationVerdicts: edited(confirmation.verdicts) }), { message: 'campaign_judge_verdicts_changed' });
  await assert.rejects(buildHarnessCampaign({ ...base, developmentVerdicts: `${development.verdicts}\n` }), { message: 'campaign_judge_verdicts_changed' });
  await assert.rejects(buildHarnessCampaign({ ...base, developmentVerdicts: development.verdicts.split('\n').slice(1).join('\n') }), { message: 'campaign_judge_verdicts_changed' });
  await assert.rejects(buildHarnessCampaign({ ...base, confirmationVerdicts: undefined }), { message: 'campaign_judge_verdicts_missing' });
  assert.throws(() => attachVerdicts(confirmation.source, edited(confirmation.verdicts)), { message: 'campaign_judge_verdicts_changed' });
  // A verdict export that already carries its scores is not sealed.
  await assert.rejects(buildHarnessCampaign({ ...base, confirmation: { ...confirmation.source, judged: { ...confirmation.source.judged, records: [] } } }), { message: 'harness_confirmation_not_sealed' });
  // Once assembled, the records are part of the source the manifest digests: changing one is another source, and the runner stops on it.
  const tampered = structuredClone(campaign.inputs);
  tampered.sources[CONF].judged.records[0].score = tampered.sources[CONF].judged.records[0].score === 0.9 ? 0.1 : 0.9;
  assert.deepEqual(await run({ manifest: campaign.manifest, inputs: tampered }), { status: 'not-qualified', reason: 'campaign_source_changed' });
  // The evaluator recomputes from the same records: a result that is not the one the records give is not signed.
  const store = memoryCampaignStore(), now = tickingClock();
  const awaiting = await run(campaign, runnerEnvironment({ store, now }));
  const checkpoint = store.state(campaign.manifest.id);
  const other = rebind(campaign, ({ inputs }) => { const r = inputs.sources[CONF].judged.records; r[0].score = r[0].score === 0.9 ? 0.1 : 0.9; });
  await assert.rejects(evaluatorReceiptPayload({ ...other, request: awaiting.request, checkpoint, now: now() }), { message: 'campaign_evaluator_binding_changed' });
});

test('judged: a judge on the solver\'s family is refused before any verdict is read', async () => {
  for (const changes of [{ id: 'deepseek-v4-pro' }, { id: 'DeepSeek-judge' }, { provider: 'deepseek' }, { provider: 'DeepSeek' }, { id: 'claude-judge-test', provider: 'deepseek' }]) {
    await assert.rejects(harnessFixture('judged', { judge: judgeOf(changes) }), { message: 'campaign_judge_family_refused' }, JSON.stringify(changes));
  }
  // A hand-built inputs.json that names such a judge (consistently, in the registration, the sources and every record) is refused by the runner by name.
  const campaign = await harnessFixture('judged');
  for (const [field, value] of [['id', 'deepseek-v4-pro'], ['provider', 'deepseek']]) {
    const hostile = rebind(campaign, ({ inputs }) => {
      inputs.registration.judge[field] = value;
      for (const key of [DEV, CONF]) { inputs.sources[key].judged.judge[field] = value; if (field === 'id') for (const r of inputs.sources[key].judged.records) r.judge = value; }
    });
    const store = memoryCampaignStore();
    assert.deepEqual(await run(hostile, runnerEnvironment({ store })), { status: 'not-qualified', reason: 'campaign_judge_family_refused' }, field);
    assert.equal(store.writes(), 0);
  }
  // The same campaign with a Claude judge runs.
  const claude = await harnessFixture('judged');
  assert.equal((await run(claude, runnerEnvironment({ store: memoryCampaignStore() }))).status, 'awaiting-evaluation');
});

test('judged: a judge is registered with its identity, its passes, its call budget and a qualification it meets', async () => {
  for (const [changes, code] of [
    [{ qualification: null }, 'campaign_judge_unqualified'],
    [{ qualification: { ...judgeOf().qualification, agreement: 0.8 } }, 'campaign_judge_unqualified'],
    [{ qualification: { ...judgeOf().qualification, noiseBand95: 0.2 } }, 'campaign_judge_unqualified'],
    [{ qualification: { ...judgeOf().qualification, measuredOn: ' ' } }, 'campaign_judge_unqualified'],
    [{ qualification: { ...judgeOf().qualification, noiseSd: 'high' } }, 'campaign_judge_unqualified'],
    [{ passes: 1 }, 'campaign_judge_unregistered'], [{ form: 'ranking' }, 'campaign_judge_unregistered'], [{ maxCalls: 0 }, 'campaign_judge_unregistered'],
    [{ id: '' }, 'campaign_judge_unregistered'], [{ form: 'pairwise', passes: 3 }, 'campaign_judge_unregistered'],
  ]) {
    await assert.rejects(harnessFixture('judged', { judge: judgeOf(changes) }), { message: code }, JSON.stringify(changes));
  }
  // Registered for a deterministic scorer, a judge is a mistake; a judged scorer without one is another.
  const campaign = await harnessFixture('judged');
  assert.equal((await run(rebind(campaign, ({ inputs }) => { delete inputs.registration.judge; }))).reason, 'campaign_judge_unregistered');
  const plain = await harnessFixture('medcalc');
  assert.equal((await run(rebind(plain, ({ inputs }) => { inputs.registration.judge = judgeOf(); }))).reason, 'campaign_judge_unexpected');
});

test('judged: the verdicts are the judge\'s, complete, within budget, on delivered runs, and costed at 0 CNY by a note that says so', async () => {
  // a pass missing, a record naming a run that does not exist or did not deliver, a different judge on one line, a score outside [0, 1]
  const bad = async (verdictShape, message, options = {}) => assert.rejects(harnessFixture('judged', { verdictShape, ...options }), { message }, message);
  let dropped = false;
  await bad({ keep: (record) => { if (!dropped && record.pass === 2) { dropped = true; return false; } return true; } }, 'harness_judge_verdicts_incomplete');
  await bad({ mutate: (record) => (record.row === '1003' && record.pass === 1 ? { ...record, judge: 'another-judge' } : record) }, 'harness_judge_identity_mismatch');
  await bad({ mutate: (record) => (record.row === '1003' && record.pass === 1 ? { ...record, score: 1.5 } : record) }, 'harness_judge_verdicts_invalid');
  await bad({ mutate: (record) => (record.row === '1003' && record.pass === 1 ? { ...record, row: '9999' } : record) }, 'harness_judge_verdicts_invalid');
  await bad({ extraCalls: 10 }, 'harness_judge_budget_exceeded', { judge: judgeOf({ maxCalls: 100 }) });
  await assert.rejects(harnessFixture('judged', { judge: judgeOf({ maxCalls: 100 }) }), { message: 'harness_judge_budget_exceeded' });
  // a verdict for a run that did not deliver is not a verdict
  const campaign = await harnessFixture('judged', { developmentStatus: (arm, row) => (arm === GOOD.arm && row.id === '1004' ? 'timeout' : 'succeeded') });
  assert.equal(campaign.supply.judge.costCny, 0);
  assert.match(campaign.supply.judge.costNote, /not metered in CNY/);
  assert.ok(campaign.supply.judge.calls > 0 && campaign.supply.judge.calls <= campaign.supply.judge.maxCalls);
  const undelivered = rebind(campaign, ({ inputs }) => { const s = inputs.sources[DEV]; s.runs.find((r) => r.arm === GOOD.arm && r.row === '1004').status = 'succeeded'; });
  assert.deepEqual(harnessArmsIssues(undelivered.inputs.sources[DEV], undelivered.inputs.registration), ['harness_judge_verdicts_incomplete']);
  const phantom = rebind(campaign, ({ inputs }) => { const s = inputs.sources[DEV]; s.judged.records.push({ row: '1004', arm: GOOD.arm, repeat: 0, pass: 1, score: 0.5, judge: s.judged.judge.id }); s.judged.recordsFile.lines += 1; s.judged.calls += 1; });
  assert.deepEqual(harnessArmsIssues(phantom.inputs.sources[DEV], phantom.inputs.registration), ['harness_judge_verdicts_invalid']);
  // the cost is said, not hidden
  for (const cost of [{ settledCny: 0.3, note: 'x' }, { settledCny: 0, note: '' }, { settledCny: 0 }]) {
    const hidden = rebind(campaign, ({ inputs }) => { inputs.sources[DEV].judged.cost = cost; });
    assert.deepEqual(harnessArmsIssues(hidden.inputs.sources[DEV], hidden.inputs.registration), ['harness_judge_cost_invalid'], JSON.stringify(cost));
  }
});

test('judged: repeated verdicts are averaged per run, an undelivered run scores 0, and a pairwise baseline is parity', async () => {
  const campaign = await harnessFixture('judged', { developmentStatus: (arm, row) => (arm === GOOD.arm && row.id === '1004' ? 'timeout' : 'succeeded') });
  const source = campaign.inputs.sources[DEV];
  const choice = chooseHarnessCandidate(source, campaign.inputs.registration);
  const mean = (arm, row) => { const own = source.judged.records.filter((r) => r.arm === arm && r.row === row); return own.reduce((s, r) => s + r.score, 0) / own.length; };
  assert.equal(source.judged.records.filter((r) => r.arm === 'baseline' && r.row === '1000').length, 3, 'three passes of one run');
  assert.ok(Math.abs(choice.scores.baseline.perRow['1000'] - mean('baseline', '1000')) < 1e-12);
  assert.equal(choice.scores[GOOD.arm].perRow['1004'], 0, 'a timeout is 0 and has no verdict');
  const pairwise = await harnessFixture('judged', { judge: judgeOf({ form: 'pairwise', passes: 2 }) });
  const dev = pairwise.inputs.sources[DEV], pchoice = chooseHarnessCandidate(dev, pairwise.inputs.registration);
  assert.ok(dev.judged.records.every((r) => r.arm !== 'baseline'));
  assert.equal(pchoice.scores.baseline.overall, 0.5);
  assert.ok(pchoice.scores[GOOD.arm].overall > 0.55);
  const { completed } = await runToVerdict(pairwise, { dir: nextDir() });
  assert.equal(completed.qualification, 'qualified', JSON.stringify(completed.checkpoint.evaluation?.reasons));
  // a pairwise verdict about the baseline is not a verdict
  const hand = rebind(pairwise, ({ inputs }) => { const s = inputs.sources[DEV]; s.judged.records.push({ row: '1000', arm: 'baseline', repeat: 0, pass: 1, score: 0.5, judge: s.judged.judge.id }); s.judged.recordsFile.lines += 1; s.judged.calls += 1; });
  assert.deepEqual(harnessArmsIssues(hand.inputs.sources[DEV], hand.inputs.registration), ['harness_judge_verdicts_invalid']);
  // the judged form registered is the form the sources say
  assert.equal((await run(rebind(pairwise, ({ inputs }) => { inputs.registration.judge.form = 'absolute'; }))).reason, 'campaign_source_invalid');
});

// ------------------------------------------------------------------------------------------------------ the registration

test('the registration is held to its design: choice rule, cost ratio, K, rows, image, repeats, alpha', async () => {
  const campaign = await harnessFixture('medcalc');
  const refused = async (mutate, reason) => assert.equal((await run(rebind(campaign, mutate))).reason, reason, reason);
  await refused(({ inputs }) => { inputs.registration.costRatio = 1.2; }, 'campaign_cost_ratio_unsupported');
  await refused(({ inputs }) => { inputs.registration.selection.tieBreak = 'shorter-skill'; }, 'campaign_selection_registration_missing');
  await refused(({ inputs }) => { delete inputs.registration.selection.noiseControl; }, 'campaign_selection_registration_missing');
  await refused(({ inputs }) => { inputs.registration.candidatesMax = 1; }, 'campaign_candidates_exceed_registration');
  await refused(({ inputs }) => { inputs.registration.rows.confirmation.pop(); }, 'campaign_rows_unregistered');
  await refused(({ inputs }) => { inputs.registration.rows.development.push('1999'); }, 'campaign_rows_unregistered');
  await refused(({ inputs }) => { inputs.registration.repeats.confirmation = 5; }, 'campaign_repeats_unregistered');
  await refused(({ inputs }) => { inputs.registration.image = { ...inputs.registration.image, id: 'another-release' }; }, 'campaign_image_changed');
  await refused(({ inputs }) => { inputs.registration.alpha.perCampaign = 0.02; }, 'campaign_alpha_registration_invalid');
  await refused(({ inputs }) => { inputs.registration.margin = 0; }, 'campaign_registration_invalid');
  await refused(({ inputs }) => { inputs.registration.failureCalculators = ['2']; }, 'campaign_registration_invalid');
  await refused(({ inputs }) => { inputs.registration.statistics.deterministicConsumer = true; }, 'campaign_statistics_registration_invalid');
  // a confirmation that is not the corpus development never saw
  const overlap = await harnessFixture('medcalc', { confirmationIds: Array.from({ length: 32 }, (_, i) => 1010 + i) });
  assert.equal((await run(overlap)).reason, 'campaign_confirmation_not_independent');
  // a confirmation that is not the development candidate on the same image
  const swapped = await harnessFixture('medcalc', { confirmationArms: [BASE, WEAK] });
  assert.equal((await run(swapped)).reason, 'campaign_confirmation_candidate_mismatch');
  // development and confirmation on two images
  const split = await harnessFixture('medcalc').then((c) => rebind(c, ({ inputs }) => { inputs.sources[CONF].image = { id: IMAGE.id, digest: 'cd'.repeat(32) }; }));
  assert.equal((await run(split)).reason, 'campaign_source_invalid', 'the confirmation candidate was digested on another image');
  const candidates = campaign.inputs.registration.candidates.map((c) => c.arm).sort();
  assert.deepEqual(candidates, [GOOD.arm, WEAK.arm].sort());
  assert.deepEqual(campaign.inputs.registration.roundRegistration, { round: 'rsi1-test', digest: campaign.round.digest });
  // Who wrote the candidates is part of what the manifest digests.
  const improvement = { composer: 'claude', editors: [{ stage: 'domain-editor', model: 'deepseek', route: 'anthropic-compatible endpoint' }] };
  const recorded = await harnessFixture('medcalc', { improvement });
  assert.deepEqual(recorded.inputs.registration.improvement, improvement);
  assert.notEqual(recorded.manifest.registration.digest, campaign.manifest.registration.digest);
});

test('the alpha allocation cannot exceed the quarter, and every campaign draws its own share from the surface\'s ledger', async () => {
  await assert.rejects(harnessFixture('medcalc', { mutateRound: (round) => { round.alpha.perCampaign = 0.03; } }), { message: 'campaign_alpha_registration_invalid' });
  const store = memoryCampaignStore(), now = tickingClock();
  const opened = [];
  for (const [n, prefix] of [[1, 'a-'], [2, 'b-'], [3, 'c-']]) {
    const campaign = await harnessFixture('medcalc', { id: prefix, confirmationIds: Array.from({ length: 32 }, (_, i) => 3000 * n + i), campaignsPerQuarter: 3 });
    const result = await run(campaign, runnerEnvironment({ store, now }));
    opened.push(result.status);
  }
  assert.deepEqual(opened, ['awaiting-evaluation', 'awaiting-evaluation', 'awaiting-evaluation']);
  const fourth = await harnessFixture('medcalc', { id: 'd-', confirmationIds: Array.from({ length: 32 }, (_, i) => 12000 + i) });
  assert.equal((await run(fourth, runnerEnvironment({ store, now }))).reason, 'campaign_alpha_budget_exhausted');
  assert.deepEqual([...store.ledger.keys()], ['harness-patch:2026-Q4'], 'its own surface\'s ledger, not capability-skill\'s');
});

// ---------------------------------------------------------------------------- fewer than 25 groups: directional, never qualified

test('a family below the procedure\'s 25 groups is answered by the procedure\'s own refusal, and the report says directional', async () => {
  const campaign = await harnessFixture('mbc', { confirmationRows: 15, sliceShareConf: 0.9 });
  assert.equal(campaign.supply.directional, true);
  const { completed } = await runToVerdict(campaign, { dir: nextDir() });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.qualification, 'inconclusive', 'not qualified, whatever the arms scored');
  assert.match(completed.checkpoint.evaluation.reasons[0], /sparse population: paired-t requires at least 25 independent groups/);
  const dir = nextDir();
  await mkdir(join(dir, 'run'), { recursive: true });
  await writeFile(join(dir, 'supply.json'), JSON.stringify(campaign.supply));
  await writeFile(join(dir, 'inputs.json'), JSON.stringify(campaign.inputs));
  await writeFile(join(dir, 'run', 'resume.json'), JSON.stringify(completed));
  const report = await harnessReport(dir, '2026-11');
  assert.equal(report.qualification, 'inconclusive');
  assert.deepEqual(report.directional, { groups: 15, sliceGroups: campaign.supply.confirmation.sliceGroups, minimum: 25 });
  const text = await readFile(join(dir, 'report.md'), 'utf8');
  assert.match(text, /结论：方向性参考，不是合格结论/);
  assert.doesNotMatch(text, /通过确认/);
  assert.match(text, /A\/A 对照 aa/);
  // 25 groups and more are not directional, qualified or not
  const full = await harnessFixture('mbc');
  assert.equal(full.supply.directional, false);
  const fullDir = nextDir();
  await mkdir(join(fullDir, 'run'), { recursive: true });
  const verdict = await runToVerdict(full, { dir: nextDir() });
  await writeFile(join(fullDir, 'supply.json'), JSON.stringify(full.supply));
  await writeFile(join(fullDir, 'inputs.json'), JSON.stringify(full.inputs));
  await writeFile(join(fullDir, 'run', 'resume.json'), JSON.stringify(verdict.completed));
  const qualified = await harnessReport(fullDir, '2026-11');
  assert.equal(qualified.directional, null);
  assert.match(await readFile(join(fullDir, 'report.md'), 'utf8'), /结论：候选补丁通过确认/);
});

test('a development-only report says whether the gate passed, and a later assembly supersedes it', async () => {
  const write = async (dir, files) => { await mkdir(join(dir, 'run'), { recursive: true }); for (const [name, value] of Object.entries(files)) await writeFile(join(dir, name), JSON.stringify(value)); };
  const good = await harnessFixture('medcalc'), flat = await harnessFixture('medcalc', { p: () => 0.5 });
  const passed = nextDir(), failed = nextDir();
  const onlyGood = developmentOnly({ development: good.exports.development.source, registration: good.round, month: '2026-11' });
  const onlyFlat = developmentOnly({ development: flat.exports.development.source, registration: flat.round, month: '2026-11' });
  await write(passed, { 'development-only.json': onlyGood, 'supply.json': onlyGood.supply });
  await write(failed, { 'development-only.json': onlyFlat, 'supply.json': onlyFlat.supply });
  const gate = await harnessReport(passed, '2026-11'), end = await harnessReport(failed, '2026-11');
  assert.equal(gate.developmentGate, 'passed');
  assert.equal(gate.qualification, null, 'a development gate is not a qualification');
  assert.match(await readFile(join(passed, 'report.md'), 'utf8'), /结论：开发门通过：候选 cand-[a-f0-9]{12} .*确认集未开启，目前没有任何合格结论/);
  assert.equal(end.developmentGate, 'failed');
  assert.equal(end.qualification, 'not-qualified');
  assert.equal(end.reason, 'campaign_no_improving_candidate');
  assert.match(await readFile(join(failed, 'report.md'), 'utf8'), /结论：未通过（not-qualified），原因 campaign_no_improving_candidate/);
  // The same directory later holds an assembled campaign: the old development-only record is not its report.
  await write(passed, { 'supply.json': good.supply, 'inputs.json': good.inputs });
  const later = await harnessReport(passed, '2026-11');
  assert.equal(later.developmentGate, null);
  assert.equal(later.status, 'not-run');
});

test('the capability-skill report says the same when its confirmation is short of groups', async () => {
  const here = fileURLToPath(new URL('../skill_report.mjs', import.meta.url));
  const write = async (statistics, supply, resume) => {
    const dir = nextDir();
    await mkdir(join(dir, 'run'), { recursive: true });
    await writeFile(join(dir, 'inputs.json'), JSON.stringify({ registration: { statistics, candidates: [{ arm: 'cand-aaaaaaaaaaaa', title: 'skill' }] } }));
    await writeFile(join(dir, 'supply.json'), JSON.stringify(supply));
    await writeFile(join(dir, 'run', 'resume.json'), JSON.stringify(resume));
    const result = spawnSync('node', [here, dir, '2026-11'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return readFile(join(dir, 'report.md'), 'utf8');
  };
  const checkpoint = (decision, reasons) => ({ status: 'completed', qualification: decision, checkpoint: { campaignId: 'c', frozenPolicy: { arm: 'cand-aaaaaaaaaaaa' }, evaluation: { decision, reasons },
    stages: { confirmation: { result: { scores: { baseline: { overall: 0.5, slice: 0.4 }, 'cand-aaaaaaaaaaaa': { overall: 0.6, slice: 0.6 } } } } } } });
  const short = await write({ G_target: 15, procedure: { minimum_slice_groups: 25 } }, { confirmation: { sliceGroups: 13, repeats: 3, costCny: {} } }, checkpoint('inconclusive', ['sparse population: paired-t requires at least 25 independent groups']));
  assert.match(short, /结论：方向性参考，不是合格结论（确认集 15 组、失败子集 13 组，低于登记统计程序的 25 组下限）/);
  const enough = await write({ G_target: 30, procedure: { minimum_slice_groups: 25 } }, { confirmation: { sliceGroups: 27, repeats: 3, costCny: {} } }, checkpoint('not-qualified', []));
  assert.doesNotMatch(enough, /方向性/);
  assert.match(enough, /结论：未通过（not-qualified）/);
});

// ------------------------------------------------------------------------------------ the pre-registration, from Python

test('the pre-registration register_round.py writes is the one the assembly accepts (digest included)', async () => {
  const dir = nextDir();
  await mkdir(dir, { recursive: true });
  const pools = { schema: 'bench-pools/1', bench: 'drb', salt: '20261028', pools: { main: { development: Array.from({ length: 40 }, (_, i) => String(i + 1)), confirmation: Array.from({ length: 40 }, (_, i) => String(i + 101)) } } };
  await writeFile(join(dir, 'pools.json'), JSON.stringify(pools));
  const tool = fileURLToPath(new URL('../../public-benchmarks/tools/register_round.py', import.meta.url));
  const out = join(dir, 'registration.json');
  const result = spawnSync('python3', ['-I', tool, '--round', 'rsi1-test', '--family', 'mbc', '--benchmark', 'medbrowsecomp', '--scorer', 'mbc-normalized', '--pools', join(dir, 'pools.json'),
    '--development-rows', '12', '--confirmation-rows', '30', '--failure-slice', 'Ingredient,Open_on_Approval', '--out', out], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const round = JSON.parse(await readFile(out, 'utf8'));
  assert.equal(round.scorer, 'mbc-normalized');
  assert.deepEqual(round.failureSlice, ['Ingredient', 'Open_on_Approval']);
  assert.equal(round.control.arm, 'aa');
  assert.equal(round.costRatio, 1.1);
  assert.equal(round.candidatesMax, 3);
  assert.equal(round.rows.development.length, 12);
  assert.equal(round.groupsBelowMinimum, false);
  const { roundRegistrationDigest } = await import('../harness_assemble.mjs');
  assert.equal(roundRegistrationDigest(round), round.digest, 'the JS digest of the file is the digest Python wrote');
  // an altered pre-registration is refused by the assembly
  const altered = { ...round, margin: 0.2 };
  await assert.rejects(buildHarnessCampaign({ development: {}, confirmation: {}, registration: altered, month: '2026-11', pilotRationale: 'x' }), { message: 'campaign_registration_digest_mismatch' });
});
