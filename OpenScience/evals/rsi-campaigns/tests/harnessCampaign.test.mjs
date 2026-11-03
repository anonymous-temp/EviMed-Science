import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rsiDigest as digest } from '../../../apps/server/src/rsiCampaignBundle.mjs';
import { confirmationDecision, runCampaign } from '../campaign_runner.mjs';
import { evaluatorReceiptPayload } from '../evaluator.mjs';
import { attachGold, attachVerdicts, buildHarnessCampaign, developmentOnly, judgeCallsRequired, readChecked, roundRegistrationDigest } from '../harness_assemble.mjs';
import { HARNESS_ALWAYS_ON_MAX_CHARS, chooseHarnessCandidate, harnessArmsIssues, harnessCampaignConsumerIdentity, harnessObservations, harnessPatchDigest, harnessPatchSizes, normalizeHarnessBundle, normalizeToolPatchCode } from '../harness_campaign.mjs';
import { harnessReport } from '../harness_report.mjs';
import { skillCampaignConsumerIdentity } from '../skill_campaign.mjs';
import { memoryCampaignStore, runToVerdict, runnerEnvironment, tickingClock } from '../profiles/benign_fixture.mjs';
import { AA, BASE, GOOD, IMAGE, IMPROVEMENT, TOOL_GOOD, TOOL_WEAK, WEAK, bundleOf, candidate, harnessFixture, improvementOf, judgeOf, rebind, sha256, toolCodeOf } from '../profiles/harness_fixture.mjs';
import { toolPatchCampaignConsumerIdentity } from '../tool_patch_campaign.mjs';

const scratch = await mkdtemp(join(tmpdir(), 'rsi-harness-'));
after(() => rm(scratch, { recursive: true, force: true }));
let dirs = 0;
const nextDir = () => join(scratch, String(dirs += 1));
const vectors = JSON.parse(await readFile(new URL('./fixtures/scorer-vectors.json', import.meta.url), 'utf8'));
const DEV = 'development-2026-11', CONF = 'confirmation-2026-11';
const run = (campaign, environment = runnerEnvironment()) => runCampaign({ manifest: campaign.manifest, inputs: campaign.inputs, ...environment });

// ------------------------------------------------------------------------------------------------------------------ tool-patch

test('the tool-patch digest binds the code as well as the text, the same in Python and in JS, and a harness patch\'s digest is what it was', () => {
  assert.ok(vectors.toolPatchDigest.length >= 7);
  for (const { name, bundle, image, code, digest: expected, chars, alwaysOnChars } of vectors.toolPatchDigest) {
    assert.equal(harnessPatchDigest(bundle, image, code), expected, name);
    assert.deepEqual(harnessPatchSizes(bundle, code), { chars, alwaysOnChars }, name);
  }
  const text = { guidanceSupplement: 'Call the scale tool for any named score.', skills: [] };
  const code = toolCodeOf('scale-tool');
  const base = harnessPatchDigest(text, IMAGE, code);
  assert.notEqual(harnessPatchDigest(text, IMAGE), base, 'the same text without its code is another candidate');
  for (const change of [{ patchSha256: 'f'.repeat(64) }, { toolCatalogueChars: 301 }, { image: { ...code.image, id: 'another-delta' } }, { files: code.files.slice(0, 1) }]) {
    assert.notEqual(harnessPatchDigest(text, IMAGE, { ...code, ...change }), base, JSON.stringify(Object.keys(change)));
  }
  assert.equal(harnessPatchDigest(text, IMAGE, { ...code, files: [...code.files].reverse() }), base, 'files are digested sorted by path');
  assert.deepEqual(harnessPatchSizes(text, code), { chars: text.guidanceSupplement.length + 300, alwaysOnChars: text.guidanceSupplement.length + 300 }, 'the tool catalogue is always-on growth');
  assert.equal(normalizeToolPatchCode({ ...code, extra: 1 }), null);
  assert.equal(normalizeToolPatchCode({ ...code, files: [] }), null);
  assert.equal(normalizeToolPatchCode({ ...code, files: [{ path: '../x.py', sha256: 'a'.repeat(64) }] }), null);
  assert.throws(() => harnessPatchDigest(text, IMAGE, { ...code, patchSha256: 'nope' }), { message: 'harness_bundle_invalid' });
  assert.throws(() => harnessPatchDigest({ guidanceSupplement: '', skills: [] }, IMAGE), { message: 'harness_bundle_invalid' }, 'an empty bundle is a patch only if its code is');
  assert.equal(harnessPatchDigest({ guidanceSupplement: '', skills: [] }, IMAGE, code).length, 64);
});

test('tool-patch: a candidate that holds code is qualified end to end under its own surface and consumer identity, on the runtime image\'s one error budget; the harness-patch pins are untouched', async () => {
  const tool = await harnessFixture('medcalc', { surface: 'tool-patch' });
  assert.equal(tool.manifest.surface, 'tool-patch');
  assert.equal(tool.manifest.candidateKind, 'tool-patch');
  assert.equal(tool.manifest.target.surface, 'tool-patch');
  assert.equal(tool.manifest.id, 'tool-patch-medcalc-2026-11');
  assert.equal(tool.inputs.registration.surface, 'tool-patch');
  const toolIdentity = await toolPatchCampaignConsumerIdentity(tool.inputs.registration);
  assert.equal(tool.inputs.registration.statistics.consumer_id, toolIdentity.implementationSha256);
  assert.equal(tool.manifest.target.dependencyDigest, toolIdentity.implementationSha256);
  const harness = await harnessFixture('medcalc');
  const harnessIdentity = await harnessCampaignConsumerIdentity(harness.inputs.registration);
  assert.notEqual(toolIdentity.implementationSha256, harnessIdentity.implementationSha256, 'its own consumer identity');
  assert.ok(toolIdentity.components.some((component) => component.path.endsWith('tool_patch_campaign.mjs')));
  assert.equal(toolIdentity.revision, 'tool-patch-arms-v1');
  assert.equal(harnessIdentity.revision, 'harness-arms-v1');
  assert.equal(harness.inputs.registration.surface, undefined, 'a harness-patch registration is what it was: no surface field');
  assert.equal(harness.manifest.surface, 'harness-patch');
  assert.equal(harness.manifest.id, 'harness-patch-medcalc-2026-11');
  assert.deepEqual(tool.supply.developmentChoice.frozen.arm, TOOL_GOOD.arm);
  // the whole lifecycle through the runner, the statistics and a signed receipt: qualified, in the runtime image's ledger
  const store = memoryCampaignStore();
  const now = tickingClock();
  const toolVerdict = await runToVerdict(tool, { dir: nextDir(), store, now });
  assert.equal(toolVerdict.completed.qualification, 'qualified');
  assert.equal(toolVerdict.completed.releaseEligible, false);
  assert.equal(toolVerdict.signed.payload.consumer.revision, 'tool-patch-arms-v1');
  const harnessVerdict = await runToVerdict(harness, { dir: nextDir(), store, now });
  assert.equal(harnessVerdict.completed.qualification, 'qualified');
  // One consumer, one ledger (2026-11-03): a tool patch and a harness patch both change the runtime image and draw on its quarter between them.
  assert.deepEqual([...store.ledger.keys()], ['dsh-harness:2026-Q4']);
  assert.deepEqual(store.ledger.get('dsh-harness:2026-Q4').reservations.map((row) => [row.campaignId, row.surface]), [['tool-patch-medcalc-2026-11', 'tool-patch'], ['harness-patch-medcalc-2026-11', 'harness-patch']]);
});

test('tool-patch: the surfaces never accept each other\'s candidates or registrations', async () => {
  const tool = await harnessFixture('medcalc', { surface: 'tool-patch' });
  const dev = tool.inputs.sources['development-2026-11'], registration = tool.inputs.registration;
  assert.deepEqual(harnessArmsIssues(dev, registration), []);
  // an arm without code under a tool-patch registration, and an arm with code under a harness-patch one
  const withoutCode = structuredClone(dev);
  delete withoutCode.arms[TOOL_GOOD.arm].harness.code;
  assert.deepEqual(harnessArmsIssues(withoutCode, registration), ['harness_arms_candidate_invalid']);
  const { surface, ...asHarness } = registration;
  assert.deepEqual(harnessArmsIssues(dev, asHarness), ['harness_arms_candidate_invalid'], 'a harness patch holds no code');
  // code that is not the digested code
  const changedCode = structuredClone(dev);
  changedCode.arms[TOOL_GOOD.arm].harness.code.patchSha256 = 'f'.repeat(64);
  assert.deepEqual(harnessArmsIssues(changedCode, registration), ['harness_arms_candidate_invalid']);
  // the always-on cap counts the tool catalogue
  const bulky = structuredClone(dev);
  bulky.arms[TOOL_GOOD.arm].harness.code.toolCatalogueChars = 4001;
  assert.deepEqual(harnessArmsIssues(bulky, registration), ['harness_arms_candidate_invalid']);
  // the runner: a manifest and a registration that name different surfaces
  const mismatch = rebind(tool, ({ inputs }) => { delete inputs.registration.surface; });
  assert.equal((await run(mismatch)).reason, 'campaign_surface_registration_mismatch', 'the manifest names the tool surface, the registration no longer does');
  const crossed = rebind(await harnessFixture('medcalc'), ({ manifest, inputs }) => { inputs.registration.surface = 'tool-patch'; manifest.surface = 'harness-patch'; });
  assert.equal((await run(crossed)).reason, 'campaign_surface_registration_mismatch');
  const agree = await harnessFixture('medcalc');
  const unknown = rebind(agree, ({ inputs }) => { inputs.registration.surface = 'skill-patch'; });
  assert.equal((await run(unknown)).reason, 'campaign_surface_registration_mismatch');
  // a registration for neither surface is refused at assembly
  await assert.rejects(harnessFixture('medcalc', { mutateRound: (round) => { round.surface = 'skill-patch'; } }), { message: 'campaign_surface_invalid' });
  assert.ok(TOOL_WEAK.harness.code, 'both fixture tool candidates hold code');
});

// ------------------------------------------------------------------------------------------------- the preview applies what run applies

test('the preview and the development-only gate refuse what the run refuses on the development side (round 1: a preview said eligible, run said campaign_control_arm_missing)', async () => {
  const campaign = await harnessFixture('medcalc');
  const input = { development: campaign.exports.development.source, registration: campaign.round, improvement: IMPROVEMENT, month: '2026-11' };
  assert.equal(developmentOnly(input).status, 'development-only', 'a complete source is eligible');
  const reregistered = (change) => { const round = structuredClone(campaign.round); change(round); round.digest = roundRegistrationDigest(round); return round; };
  // no A/A arm in the development source: the source itself is well formed, the runner has no control to hold a candidate to
  const noControl = structuredClone(input.development);
  delete noControl.arms.aa;
  noControl.runs = noControl.runs.filter((run) => run.arm !== 'aa');
  assert.deepEqual(harnessArmsIssues(noControl, { ...campaign.inputs.registration }), [], 'well formed, and still not a development source the run accepts');
  assert.throws(() => developmentOnly({ ...input, development: noControl }), { message: 'campaign_control_arm_missing' });
  // the same refusal from the assembly of a whole campaign and from the runner
  await assert.rejects(buildHarnessCampaign({ development: noControl, confirmation: campaign.exports.confirmation.source, registration: campaign.round, confirmationGold: campaign.exports.confirmation.gold,
    improvement: IMPROVEMENT, month: '2026-11', pilotRationale: 'test' }), { message: 'campaign_control_arm_missing' });
  const refused = rebind(campaign, ({ inputs }) => { const s = inputs.sources[DEV]; delete s.arms.aa; s.runs = s.runs.filter((r) => r.arm !== 'aa'); });
  assert.equal((await run(refused)).reason, 'campaign_control_arm_missing');
  // more candidates than K, rows or repeats other than the registered ones, a control that was never registered, a margin outside (0, 1)
  assert.throws(() => developmentOnly({ ...input, registration: reregistered((r) => { r.candidatesMax = 1; }) }), { message: 'campaign_candidates_exceed_registration' });
  assert.throws(() => developmentOnly({ ...input, registration: reregistered((r) => { r.rows.development = r.rows.development.slice(1); }) }), { message: 'campaign_rows_unregistered' });
  assert.throws(() => developmentOnly({ ...input, registration: reregistered((r) => { r.repeats.development = 2; }) }), { message: 'campaign_repeats_unregistered' });
  assert.throws(() => developmentOnly({ ...input, registration: reregistered((r) => { r.control.arm = 'a-a'; }) }), { message: 'campaign_control_unregistered' });
  assert.throws(() => developmentOnly({ ...input, registration: reregistered((r) => { r.margin = 1.5; }) }), { message: 'campaign_registration_invalid' });
  assert.throws(() => developmentOnly({ ...input, registration: reregistered((r) => { r.alpha.perCampaign = 0.04; }) }), { message: 'campaign_alpha_registration_invalid' });
});

test('a judged registration whose call maximum is below what its own rows, repeats, passes and candidates need is refused by the preview as by the assembly', async () => {
  const judged = await harnessFixture('judged');
  const required = judgeCallsRequired(judged.round);
  // development: baseline + control + K candidates; confirmation: baseline + one candidate; absolute judging records every arm
  const { round } = judged;
  assert.equal(required, (round.rows.development.length * round.repeats.development * (1 + 1 + round.candidatesMax) + round.rows.confirmation.length * round.repeats.confirmation * 2) * round.judge.passes);
  const pairwise = { ...round, judge: { ...round.judge, form: 'pairwise', passes: 2 } };
  assert.equal(judgeCallsRequired(pairwise), (round.rows.development.length * round.repeats.development * (1 + round.candidatesMax) + round.rows.confirmation.length * round.repeats.confirmation) * 2, 'pairwise judging records the arms that are not the baseline');
  const low = structuredClone(round);
  low.judge.maxCalls = required - 1;
  low.digest = roundRegistrationDigest(low);
  assert.throws(() => developmentOnly({ development: judged.exports.development.source, registration: low, developmentVerdicts: judged.exports.development.verdicts, improvement: IMPROVEMENT, month: '2026-11' }), { message: 'campaign_judge_budget_below_registration' });
  const enough = structuredClone(round);
  enough.judge.maxCalls = required;
  enough.digest = roundRegistrationDigest(enough);
  assert.equal(developmentOnly({ development: judged.exports.development.source, registration: enough, developmentVerdicts: judged.exports.development.verdicts, improvement: IMPROVEMENT, month: '2026-11' }).status, 'development-only');
});

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
  const common = { development: campaign.exports.development.source, registration: campaign.round, improvement: IMPROVEMENT, month: '2026-11', pilotRationale: 'Synthetic.' };
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
  const only = developmentOnly({ development: flat.exports.development.source, registration: flat.round, improvement: IMPROVEMENT, month: '2026-11' });
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
  const base = { development: development.source, confirmation: confirmation.source, registration: campaign.round, improvement: IMPROVEMENT, month: '2026-11', pilotRationale: 'Synthetic.', developmentVerdicts: development.verdicts, confirmationVerdicts: confirmation.verdicts };
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

test('judged: a judge that is not Claude (Anthropic, a pinned claude-* model) is refused before any verdict is read, whatever its id says', async () => {
  for (const changes of [{ provider: 'deepseek', model: 'deepseek-v4-pro' }, { provider: 'dashscope', model: 'qwen3.8-max' }, { model: 'qwen3.8-max' }, { provider: 'deepseek' },
    { model: 'claude' }, { model: 'claude-3.5-sonnet' }, { provider: 'Anthropic' }]) {
    await assert.rejects(harnessFixture('judged', { judge: judgeOf(changes) }), { message: 'campaign_judge_refused' }, JSON.stringify(changes));
  }
  const { model, ...unpinned } = judgeOf();
  await assert.rejects(harnessFixture('judged', { judge: unpinned }), { message: 'campaign_judge_unregistered' }, `a judge without a pinned model (${model} removed) is not registered`);
  // A hand-built inputs.json that names such a judge (consistently, in the registration, the sources and the manifest) is refused by the runner by name.
  const campaign = await harnessFixture('judged');
  for (const judge of [{ provider: 'deepseek', model: 'deepseek-v4-pro' }, { provider: 'dashscope', model: 'qwen3.8-max' }]) {
    const hostile = rebind(campaign, ({ manifest, inputs }) => {
      Object.assign(inputs.registration.judge, judge);
      for (const key of [DEV, CONF]) Object.assign(inputs.sources[key].judged.judge, judge);
      manifest.models.judges = [{ ...manifest.models.judges[0], ...judge }];
    });
    const store = memoryCampaignStore();
    assert.deepEqual(await run(hostile, runnerEnvironment({ store })), { status: 'not-qualified', reason: 'campaign_judge_refused' }, judge.provider);
    assert.equal(store.writes(), 0);
  }
  // The same campaign with its Claude judge runs, and its manifest names that judge.
  const claude = await harnessFixture('judged');
  assert.deepEqual(claude.manifest.models.judges, [{ role: 'judge', provider: 'anthropic', model: 'claude-sonnet-5-5', id: 'claude-judge-test' }]);
  assert.equal(claude.supply.judge.model, 'claude-sonnet-5-5');
  assert.equal((await run(claude, runnerEnvironment({ store: memoryCampaignStore() }))).status, 'awaiting-evaluation');
});

test('judged: a judge is registered with its identity, its passes, its call budget and a qualification that meets the procedure\'s thresholds, which no registration sets', async () => {
  const q = judgeOf().qualification;
  for (const [changes, code] of [
    [{ qualification: null }, 'campaign_judge_unqualified'],
    [{ qualification: { ...q, agreement: 0.8 } }, 'campaign_judge_unqualified'],
    [{ qualification: { ...q, agreement: 0.8999 } }, 'campaign_judge_unqualified'],
    [{ qualification: { ...q, noiseBand95: 0.2 } }, 'campaign_judge_unqualified'],
    // round 2's BixBench judge as registered: band95 0.1166 over 2 passes is 0.0824, above the 0.05 margin (it was admitted by a registered maximum of 0.12)
    [{ passes: 2, qualification: { ...q, agreement: 0.9583, noiseBand95: 0.1166 } }, 'campaign_judge_unqualified'],
    // averaging is what the procedure uses: 0.08 is above the margin over 2 passes (0.0566), within it over 3 (0.0462)
    [{ passes: 2, qualification: { ...q, noiseBand95: 0.08 } }, 'campaign_judge_unqualified'],
    // a threshold of the registrant's own is no longer a field of the qualification
    [{ qualification: { ...q, agreement: 0.8, minimumAgreement: 0.7 } }, 'campaign_judge_unqualified'],
    [{ qualification: { ...q, maximumNoiseBand: 0.2 } }, 'campaign_judge_unqualified'],
    [{ qualification: { ...judgeOf().qualification, measuredOn: ' ' } }, 'campaign_judge_unqualified'],
    [{ qualification: { ...judgeOf().qualification, noiseSd: 'high' } }, 'campaign_judge_unqualified'],
    // the measurement is of this judge's form and on the verdict's 0-1 scale (2026-11-03): DRB's absolute RACE band is no pairwise judge's, rubric points
    // are not a 0-1 band, and a record that does not say its scale is not read
    [{ form: 'pairwise', passes: 2, qualification: { ...q, form: 'absolute' } }, 'campaign_judge_unqualified'],
    [{ qualification: { ...q, scale: 'rubric-points', noiseSd: 2.26, noiseBand95: 4.43 } }, 'campaign_judge_unqualified'],
    [{ qualification: (({ scale, ...rest }) => rest)(q) }, 'campaign_judge_unqualified'],
    [{ qualification: (({ form, ...rest }) => rest)(q) }, 'campaign_judge_unqualified'],
    [{ qualification: { ...q, agreement: null } }, 'campaign_judge_unqualified'],
    [{ passes: 1 }, 'campaign_judge_unregistered'], [{ form: 'ranking' }, 'campaign_judge_unregistered'], [{ maxCalls: 0 }, 'campaign_judge_unregistered'],
    [{ id: '' }, 'campaign_judge_unregistered'], [{ form: 'pairwise', passes: 3 }, 'campaign_judge_unregistered'],
    // the same model at another effort is another judge: the effort is registered, one of the CLI's levels
    [{ effort: null }, 'campaign_judge_unregistered'], [{ effort: 'turbo' }, 'campaign_judge_unregistered'],
  ]) {
    await assert.rejects(harnessFixture('judged', { judge: judgeOf(changes) }), { message: code }, JSON.stringify(changes));
  }
  // At the thresholds: agreement exactly 0.9, and a band that is within the margin only once three passes are averaged.
  assert.equal((await harnessFixture('judged', { judge: judgeOf({ qualification: { ...q, agreement: 0.9, noiseBand95: 0.08 } }) })).supply.judge.qualification.noiseBand95, 0.08);
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
  // a source judged at another effort than the registered one is another judge's
  const registeredEffort = await harnessFixture('judged');
  const otherEffort = rebind(registeredEffort, ({ inputs }) => { inputs.sources[DEV].judged.judge.effort = 'high'; });
  assert.deepEqual(harnessArmsIssues(otherEffort.inputs.sources[DEV], otherEffort.inputs.registration), ['harness_judge_identity_mismatch']);
  await bad({ mutate: (record) => (record.row === '1003' && record.pass === 1 ? { ...record, score: 1.5 } : record) }, 'harness_judge_verdicts_invalid');
  await bad({ mutate: (record) => (record.row === '1003' && record.pass === 1 ? { ...record, row: '9999' } : record) }, 'harness_judge_verdicts_invalid');
  // a registered maximum below what the registration itself needs is refused by the registration; calls beyond a sufficient maximum are refused in the source
  const needed = judgeCallsRequired((await harnessFixture('judged')).round);
  await bad({ extraCalls: needed }, 'harness_judge_budget_exceeded', { judge: judgeOf({ maxCalls: needed }) });
  await assert.rejects(harnessFixture('judged', { judge: judgeOf({ maxCalls: needed - 1 }) }), { message: 'campaign_judge_budget_below_registration' });
  await assert.rejects(harnessFixture('judged', { judge: judgeOf({ maxCalls: 100 }) }), { message: 'campaign_judge_budget_below_registration' });
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
  // a registration of another form (measured in that form) than the one the sources were judged in
  assert.equal((await run(rebind(pairwise, ({ inputs }) => { inputs.registration.judge.form = 'absolute'; inputs.registration.judge.qualification.form = 'absolute'; }))).reason, 'campaign_source_invalid');
  // a registration whose measurement is of another form than its judge is not qualified at all
  assert.equal((await run(rebind(pairwise, ({ inputs }) => { inputs.registration.judge.form = 'absolute'; }))).reason, 'campaign_judge_unqualified');
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
  // Who wrote the candidates is part of what the manifest digests, and is what the manifest names as its improvers.
  const improvement = improvementOf({ improvers: [{ role: 'composing', provider: 'anthropic', model: 'claude-opus-5-5' }, { role: 'selecting', provider: 'anthropic', model: 'claude-sonnet-5-5' }], note: 'two roles' });
  const recorded = await harnessFixture('medcalc', { improvement });
  assert.deepEqual(recorded.inputs.registration.improvement, improvement);
  assert.deepEqual(recorded.manifest.models, { solver: { provider: 'deepseek', model: 'deepseek-flash' }, improvers: improvement.improvers, judges: [] });
  assert.notEqual(recorded.manifest.registration.digest, campaign.manifest.registration.digest);
});

test('the improvement record is required and names Claude improvers only; the manifest\'s models are the registration\'s, never written by hand', async () => {
  // round 1's record named a DeepSeek domain editor in free form: neither the free form nor the editor is an improver any more
  for (const [improvement, code] of [
    [null, 'campaign_improvement_missing'], [{ writtenBy: 'the lead (Claude)' }, 'campaign_improvement_missing'], [improvementOf({ improvers: [] }), 'campaign_improvement_missing'],
    [improvementOf({ improvers: [{ role: 'domain-editor', provider: 'deepseek', model: 'deepseek-v4-pro' }] }), 'campaign_improver_refused'],
    [improvementOf({ improvers: [{ role: 'proposing', provider: 'dashscope', model: 'qwen3.8-max' }] }), 'campaign_improver_refused'],
    [improvementOf({ improvers: [{ role: 'proposing', provider: 'anthropic' }] }), 'campaign_model_invalid'],
  ]) {
    await assert.rejects(harnessFixture('medcalc', { improvement }), { message: code }, JSON.stringify(improvement));
    const campaign = await harnessFixture('medcalc');
    assert.throws(() => developmentOnly({ development: campaign.exports.development.source, registration: campaign.round, improvement, month: '2026-11' }), { message: code });
  }
  // The runner holds the manifest's models to the registration: improvers to the improvement record, judges to the registered judge.
  const campaign = await harnessFixture('judged');
  const refused = async (mutate, reason) => assert.equal((await run(rebind(campaign, mutate))).reason, reason, reason);
  await refused(({ manifest }) => { manifest.models.improvers = [{ role: 'proposing', provider: 'anthropic', model: 'claude-sonnet-5-5' }]; }, 'campaign_models_registration_mismatch');
  await refused(({ manifest }) => { manifest.models.judges = [{ ...manifest.models.judges[0], model: 'claude-opus-5-5' }]; }, 'campaign_models_registration_mismatch');
  await refused(({ manifest }) => { manifest.models.judges = []; }, 'campaign_models_registration_mismatch');
  await refused(({ inputs }) => { inputs.registration.improvement.improvers[0].model = 'claude-sonnet-5-5'; }, 'campaign_models_registration_mismatch');
  await refused(({ inputs }) => { delete inputs.registration.improvement; }, 'campaign_improvement_missing');
  const plain = await harnessFixture('medcalc');
  assert.equal((await run(rebind(plain, ({ manifest }) => { manifest.models.judges = [{ role: 'judge', provider: 'anthropic', model: 'claude-sonnet-5-5' }]; }))).reason, 'campaign_models_registration_mismatch', 'a deterministic scorer has no judge');
});

test('the alpha allocation cannot exceed the quarter, and every campaign draws its own share from the consumer\'s ledger', async () => {
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
  assert.deepEqual([...store.ledger.keys()], ['dsh-harness:2026-Q4'], 'the runtime image\'s ledger, not capability-skill\'s');
});

// ---------------------------------------------------------------------------- fewer than 25 groups: directional, never qualified

test('a family below the procedure\'s 25 groups is answered by the procedure\'s own refusal, and the report says directional', async () => {
  const campaign = await harnessFixture('mbc', { confirmationRows: 15, sliceShareConf: 0.9 });
  assert.equal(campaign.supply.directional, true);
  const store = memoryCampaignStore();
  const { completed } = await runToVerdict(campaign, { dir: nextDir(), store });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.qualification, 'inconclusive', 'not qualified, whatever the arms scored');
  assert.equal(completed.checkpoint.evaluation.reasons[0], 'campaign_directional_below_minimum_groups');
  assert.match(completed.checkpoint.evaluation.reasons[1], /sparse population: paired-t requires at least 25 independent groups/);
  assert.equal(completed.checkpoint.evaluation.scope, 'directional-reference');
  assert.deepEqual(completed.checkpoint.evaluation.directional, { groups: 15, sliceGroups: campaign.supply.confirmation.sliceGroups, minimum: 25 });
  // it drew no error budget and opened its corpus as a directional one
  assert.equal(store.ledger.size, 0, 'the quarter\'s ledger was not written');
  const corpus = store.corpora.get(campaign.manifest.data.sources.find((source) => source.role === 'confirmation').digest);
  assert.equal(corpus.directional, true);
  assert.equal(corpus.campaignId, campaign.manifest.id);
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

test('a directional campaign spends no error budget, whatever the arms scored, and its corpus is opened once, directionally', async () => {
  // the same arms on 12 groups and on 32: the candidate repairs its slice in both
  const directional = await harnessFixture('medcalc', { confirmationRows: 12, sliceShareConf: 0.9, id: 'short-' });
  assert.equal(directional.supply.directional, true);
  const qualifying = await harnessFixture('medcalc', { id: 'full-' });
  assert.equal(qualifying.supply.directional, false);
  const store = memoryCampaignStore();
  const now = tickingClock();
  const first = await runToVerdict(directional, { dir: nextDir(), store, now });
  assert.equal(first.completed.qualification, 'inconclusive', 'a directional campaign cannot be qualified');
  assert.equal(first.completed.releaseEligible, false);
  assert.equal(first.completed.checkpoint.evaluation.scope, 'directional-reference');
  assert.equal(store.ledger.size, 0, 'no error budget drawn');
  // the quarter's whole budget is still there for a campaign that can qualify
  const second = await runToVerdict(qualifying, { dir: nextDir(), store, now });
  assert.equal(second.completed.qualification, 'qualified', 'the same arms, with the groups the procedure needs, qualify');
  const ledger = [...store.ledger.values()];
  assert.equal(ledger.length, 1);
  assert.deepEqual(ledger[0].reservations.map((row) => row.campaignId), [qualifying.manifest.id], 'only the qualifying campaign is in the ledger');
  // a directional run of the same campaign resumes against its own record; another campaign cannot open the corpus again
  const rerun = await runToVerdict(directional, { dir: nextDir(), store: memoryCampaignStore({ ledger: store.ledger, corpora: store.corpora }), now });
  assert.equal(rerun.awaiting.status, 'awaiting-evaluation');
  const intruder = rebind(directional, ({ manifest }) => { manifest.id = 'intruder-medcalc-2026-11'; });
  const refused = await runCampaign({ manifest: intruder.manifest, inputs: intruder.inputs, ...runnerEnvironment({ store: memoryCampaignStore({ ledger: store.ledger, corpora: store.corpora }), now }) });
  assert.equal(refused.reason, 'campaign_confirmation_corpus_already_opened');
});

test('the ledger rule for a directional corpus: alpha must be 0, nothing is written to the quarter, and the record cannot be turned into a spend', () => {
  const request = { ledger: 'dsh-harness', legacy: ['harness-patch', 'tool-patch'], surface: 'harness-patch', quarter: '2026-Q4', campaignId: 'c1', alpha: 0, corpusDigest: 'a'.repeat(64), at: '2026-11-02T00:00:00Z', directional: true };
  const opened = confirmationDecision(undefined, undefined, request);
  assert.deepEqual(opened.result, { authorized: true, look: 1, reused: false, directional: true });
  assert.equal(opened.ledger, undefined);
  assert.deepEqual(opened.corpus, { recordType: 'rsi-opened-corpus', corpusDigest: request.corpusDigest, campaignId: 'c1', surface: 'harness-patch', ledger: 'dsh-harness', openedAt: request.at, directional: true });
  assert.deepEqual(confirmationDecision(undefined, opened.corpus, request), { write: false, result: { authorized: true, look: 1, reused: true, directional: true } });
  const spend = { ...request, alpha: 0.0166, directional: false };
  assert.equal(confirmationDecision(undefined, opened.corpus, spend).result.reason, 'campaign_confirmation_reservation_changed', 'a directional record is not a spend');
  assert.equal(confirmationDecision(undefined, undefined, { ...request, alpha: 0.01 }).result.reason, 'campaign_confirmation_reservation_changed', 'a directional request carries no alpha');
  assert.equal(confirmationDecision(undefined, opened.corpus, { ...request, campaignId: 'c2' }).result.reason, 'campaign_confirmation_corpus_already_opened');
  // an ordinary reservation is unchanged
  const ordinary = confirmationDecision(undefined, undefined, { ...request, alpha: 0.0166, directional: false });
  assert.equal(ordinary.write, true);
  assert.equal(ordinary.ledger.reservations[0].alpha, 0.0166);
  assert.equal(ordinary.corpus.directional, undefined);
});

test('a development-only report says whether the gate passed, and a later assembly supersedes it', async () => {
  const write = async (dir, files) => { await mkdir(join(dir, 'run'), { recursive: true }); for (const [name, value] of Object.entries(files)) await writeFile(join(dir, name), JSON.stringify(value)); };
  const good = await harnessFixture('medcalc'), flat = await harnessFixture('medcalc', { p: () => 0.5 });
  const passed = nextDir(), failed = nextDir();
  const onlyGood = developmentOnly({ development: good.exports.development.source, registration: good.round, improvement: IMPROVEMENT, month: '2026-11' });
  const onlyFlat = developmentOnly({ development: flat.exports.development.source, registration: flat.round, improvement: IMPROVEMENT, month: '2026-11' });
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
