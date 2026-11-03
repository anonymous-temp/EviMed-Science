import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, verify } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rsiDigest as digest, canonicalRsiJson } from '../../../apps/server/src/rsiCampaignBundle.mjs';
import { runCampaign } from '../campaign_runner.mjs';
import { evaluatorReceiptPayload, signEnvelope } from '../evaluator.mjs';
import { closurePayload, closureCosts } from '../harness_closure.mjs';
import { harnessReport } from '../harness_report.mjs';
import { STATISTICS_MODULE_PATH, STATISTICS_PYTHON, generateEvaluatorKey, memoryCampaignStore, runToVerdict, runnerEnvironment, tickingClock } from '../profiles/benign_fixture.mjs';
import { harnessFixture, rebind } from '../profiles/harness_fixture.mjs';

const scratch = await mkdtemp(join(tmpdir(), 'rsi-closure-'));
after(() => rm(scratch, { recursive: true, force: true }));
let dirs = 0;
const nextDir = () => join(scratch, String(dirs += 1));
const CONF = 'confirmation-2026-11';
const statistics = { statisticsPython: STATISTICS_PYTHON, statisticsModulePath: STATISTICS_MODULE_PATH };
/** The two runs round 1 left without a settled cost: baseline arm, rows picked from the fixture's own confirmation source. */
const PRICES = [{ cost: 0.108506, openCost: 0.005, uncertain: 1, calls: 23 }, { cost: 0.09403, openCost: 0.174, uncertain: 0, calls: 16 }];

/** A campaign whose confirmation export has `count` baseline runs with no settled cost, and the ledger records the lab would be given for them. */
async function unsettled(options = {}, count = 2) {
  const campaign = await harnessFixture('medcalc', { ...options, mutateExports: (exports) => {
    const baseline = exports.confirmation.source.runs.filter((run) => run.arm === 'baseline');
    for (let i = 0; i < count; i += 1) baseline[i * 7].cost = null;
  } });
  const missing = campaign.inputs.sources[CONF].runs.filter((run) => run.cost === null);
  const closure = { kind: 'harness-cost-closure', schema: 1, benchmark: 'medcalc-bench', runs: missing.map((run, i) => ({ row: run.row, arm: run.arm, repeat: run.repeat, runId: run.runId, status: run.status, ledger: PRICES[i % PRICES.length], resultSha256: 'a'.repeat(64) })) };
  return { campaign, missing, closure };
}

/** The same campaign with those costs already in the sealed export: what the receipt path would have done with a complete source. */
async function complete(options = {}, count = 2) {
  const { missing } = await unsettled(options, count);
  return harnessFixture('medcalc', { ...options, mutateExports: (exports) => {
    const baseline = exports.confirmation.source.runs.filter((run) => run.arm === 'baseline');
    for (let i = 0; i < count; i += 1) baseline[i * 7].cost = PRICES[i % PRICES.length].cost;
    assert.equal(baseline[0].runId, missing[0].runId);
  } });
}

async function awaiting(campaign, store = memoryCampaignStore(), now = tickingClock()) {
  const environment = runnerEnvironment({ store, now });
  const result = await runCampaign({ manifest: campaign.manifest, inputs: campaign.inputs, ...environment });
  assert.equal(result.status, 'awaiting-evaluation');
  return { result, checkpoint: store.state(campaign.manifest.id), store, now };
}

test('the receipt refuses a campaign with runs that have no settled cost, and says why; a source with no such run needs no closure', async () => {
  const { campaign, closure } = await unsettled();
  const { result, checkpoint } = await awaiting(campaign);
  await assert.rejects(evaluatorReceiptPayload({ manifest: campaign.manifest, inputs: campaign.inputs, request: result.request, checkpoint, now: '2026-11-02T00:00:00Z' }), { message: 'campaign_cost_measurement_missing' });
  const full = await complete();
  assert.throws(() => closureCosts(full.inputs.sources[CONF], closure), { message: 'campaign_cost_closure_not_needed' });
});

test('the closure recomputes the same scores, records the deviation and gives the procedure the ledger costs as what they are, lower bounds: no verdict, where a complete source would have qualified', async () => {
  const { campaign, missing, closure } = await unsettled();
  const store = memoryCampaignStore();
  const { checkpoint } = await awaiting(campaign, store);
  const ledgerBefore = structuredClone([...store.ledger.entries()]);
  const corporaBefore = structuredClone([...store.corpora.entries()]);
  const payload = await closurePayload({ manifest: campaign.manifest, inputs: campaign.inputs, checkpoint, closure, now: '2026-11-02T08:00:00Z', ...statistics });
  assert.equal(payload.type, 'rsi-campaign-closure-v1');
  assert.equal(payload.binding, checkpoint.binding);
  assert.equal(payload.confirmationResultDigest, checkpoint.stages.confirmation.resultDigest, 'not one score moved');
  assert.equal(payload.corpusDigest, campaign.manifest.data.sources.find((row) => row.role === 'confirmation').digest);
  assert.equal(payload.look, 1);
  assert.match(payload.alpha.reservation, /unchanged/);
  assert.deepEqual(payload.alpha.claims, campaign.inputs.registration.statistics.claims);
  assert.equal(payload.deviation.code, 'cost_closed_from_ledger_record');
  assert.deepEqual(payload.deviation.runs.map((run) => [run.row, run.arm, run.repeat, run.runId, run.usedCost]), missing.map((run, i) => [run.row, run.arm, run.repeat, run.runId, PRICES[i].cost]));
  assert.deepEqual(payload.deviation.runs[0].ledger, PRICES[0], 'what the ledger said, including the open reservation and the uncertain call');
  // nothing in the ledger or the opened-corpus records moved
  assert.deepEqual([...store.ledger.entries()], ledgerBefore);
  assert.deepEqual([...store.corpora.entries()], corporaBefore);
  // The same observations and costs in a source that had the costs from the start qualify; the closure's costs are lower bounds, so the
  // procedure is told the costs are incomplete and refuses before it reads a score (2026-11-03: a closure attested complete costs before).
  const whole = await complete();
  const standard = await runToVerdict(whole, { dir: nextDir() });
  assert.equal(standard.completed.status, 'completed');
  assert.equal(standard.completed.qualification, 'qualified');
  assert.equal(payload.observationDigest, digest(standard.checkpoint.stages.confirmation.result.observations));
  assert.deepEqual([payload.statistics.decision, payload.statistics.reasons, payload.statistics.quantities], ['inconclusive', ['complete cost identity not attested'], {}]);
  assert.equal(payload.statistics.scope, 'registered-population-task-family');
  assert.match(payload.deviation.effect, /complete_costs false, so the procedure gives no verdict/);
  assert.ok(payload.statistics.costTotals.baseline > 0 && payload.statistics.costTotals.candidate > 0);
});

test('the closure is signed by the evaluator\'s key over the canonical payload, from the files, and the report says the deviation', async () => {
  const { campaign, closure } = await unsettled();
  const { checkpoint } = await awaiting(campaign);
  const dir = nextDir();
  await mkdir(join(dir, 'run'), { recursive: true });
  const key = generateEvaluatorKey();
  await writeFile(join(dir, 'key.pem'), key.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(campaign.manifest));
  await writeFile(join(dir, 'inputs.json'), JSON.stringify(campaign.inputs));
  await writeFile(join(dir, 'run', 'report.json'), JSON.stringify({ status: 'checkpoint', checkpoint }));
  await writeFile(join(dir, 'cost-closure.json'), JSON.stringify(closure));
  const closureFile = fileURLToPath(new URL('../harness_closure.mjs', import.meta.url));
  const done = spawnSync('node', [closureFile, join(dir, 'manifest.json'), join(dir, 'inputs.json'), join(dir, 'run', 'report.json'), join(dir, 'cost-closure.json'), join(dir, 'key.pem'), join(dir, 'closure.signed.json')],
    { encoding: 'utf8', env: { PATH: process.env.PATH, RSI_STATISTICS_PYTHONPATH: STATISTICS_MODULE_PATH } });
  assert.equal(done.status, 0, done.stderr);
  const summary = JSON.parse(done.stdout);
  assert.equal(summary.status, 'signed');
  assert.equal(summary.publicKeySha256, key.publicKeySha256);
  assert.equal(summary.deviationRuns, 2);
  const envelope = JSON.parse(await readFile(join(dir, 'closure.signed.json'), 'utf8'));
  assert.ok(verify(null, Buffer.from(canonicalRsiJson(envelope.payload)), key.publicKey, Buffer.from(envelope.signature, 'base64')), 'a valid Ed25519 signature');
  assert.equal(envelope.payload.deviation.costRecords, createHash('sha256').update(await readFile(join(dir, 'cost-closure.json'))).digest('hex'), 'the cost records are named by digest');
  // the report: the conclusion is the closure's, and the deviation is a section of its own
  const supply = campaign.supply;
  await writeFile(join(dir, 'supply.json'), JSON.stringify(supply));
  await writeFile(join(dir, 'run', 'run.json'), JSON.stringify({ status: 'awaiting-evaluation' }));
  const report = await harnessReport(dir, '2026-11');
  assert.equal(report.closure.deviation.code, 'cost_closed_from_ledger_record');
  assert.equal(report.qualification, envelope.payload.statistics.decision);
  const text = await readFile(join(dir, 'report.md'), 'utf8');
  assert.match(text, /本结论由签名的成本收尾记录给出/);
  assert.match(text, /## 偏差/);
  assert.match(text, /成本取账本已结算部分 0\.108506 元（下限）/);
  assert.match(text, /没有任何分数、行、重复或臂被改动/);
  assert.match(text, /这些成本只是下限，登记的统计程序被如实告知成本不完整，因此不给出判定/);
  assert.match(text, /结论：未通过（inconclusive），原因 complete cost identity not attested/);
  assert.match(text, /本季度 α 的预留不变/);
});

test('the closure refuses what is not the campaign, its scores, or exactly its missing costs', async () => {
  const { campaign, closure } = await unsettled();
  const { checkpoint } = await awaiting(campaign);
  const base = { manifest: campaign.manifest, inputs: campaign.inputs, checkpoint, closure, now: '2026-11-02T08:00:00Z', ...statistics };
  const refused = (changes, reason) => assert.rejects(closurePayload({ ...base, ...changes }), { message: reason }, reason);
  // other records than the missing ones: one short, one more, a run id that is not the source's, a status that is not
  await refused({ closure: { ...closure, runs: closure.runs.slice(1) } }, 'campaign_cost_closure_runs_differ');
  const other = campaign.inputs.sources[CONF].runs.find((run) => run.cost !== null);
  await refused({ closure: { ...closure, runs: [...closure.runs, { ...closure.runs[0], row: other.row, arm: other.arm, repeat: other.repeat, runId: other.runId }] } }, 'campaign_cost_closure_runs_differ');
  await refused({ closure: { ...closure, runs: [{ ...closure.runs[0], runId: 'run-other' }, closure.runs[1]] } }, 'campaign_cost_closure_runs_differ');
  await refused({ closure: { ...closure, runs: [{ ...closure.runs[0], status: 'timeout' }, closure.runs[1]] } }, 'campaign_cost_closure_runs_differ');
  await refused({ closure: { ...closure, runs: [closure.runs[0], closure.runs[0]] } }, 'campaign_cost_closure_invalid');
  await refused({ closure: { ...closure, runs: [{ ...closure.runs[0], ledger: { cost: null } }, closure.runs[1]] } }, 'campaign_cost_closure_invalid');
  await refused({ closure: { ...closure, kind: 'something-else' } }, 'campaign_cost_closure_invalid');
  // another campaign's checkpoint, an input changed after the checkpoint, a checkpoint that already has its verdict
  await refused({ checkpoint: { ...checkpoint, binding: 'f'.repeat(64) } }, 'campaign_evaluator_binding_changed');
  const edited = rebind(campaign, ({ inputs }) => { inputs.sources[CONF].runs.find((run) => run.arm === 'baseline' && run.cost !== null).cost += 0.01; });
  await refused({ manifest: edited.manifest, inputs: edited.inputs }, 'campaign_evaluator_binding_changed');
  await refused({ checkpoint: { ...checkpoint, evaluation: { decision: 'qualified' } } }, 'campaign_closure_not_awaiting');
  await refused({ checkpoint: { ...checkpoint, outcome: { status: 'not-qualified' } } }, 'campaign_closure_not_awaiting');
  await refused({ checkpoint: { ...checkpoint, confirmationLooks: 2 } }, 'campaign_evaluator_repeated_look');
  // a checkpoint whose recorded confirmation result is not what the recorded runs score to, or whose frozen policy is not what development chooses
  const confirmationStage = checkpoint.stages.confirmation;
  await refused({ checkpoint: { ...checkpoint, stages: { ...checkpoint.stages, confirmation: { ...confirmationStage, resultDigest: 'e'.repeat(64) } } } }, 'campaign_evaluator_recomputation_differs');
  await refused({ checkpoint: { ...checkpoint, frozenPolicy: { ...checkpoint.frozenPolicy, arm: 'cand-000000000000' } } }, 'campaign_evaluator_development_differs');
  // a registration pinned to another consumer
  const pinned = rebind(campaign, ({ inputs }) => { inputs.registration.statistics.consumer_id = 'f'.repeat(64); });
  await refused({ manifest: pinned.manifest, inputs: pinned.inputs, checkpoint: { ...checkpoint, binding: digest({ manifest: pinned.manifest, inputs: pinned.inputs }) } }, 'campaign_evaluation_consumer_or_corpus_changed');
});

test('the closure cannot make a verdict that the procedure refuses: a directional campaign stays inconclusive and so does a late one', async () => {
  const short = await unsettled({ confirmationRows: 12, sliceShareConf: 0.9 });
  const shortCheckpoint = (await awaiting(short.campaign)).checkpoint;
  const directional = await closurePayload({ manifest: short.campaign.manifest, inputs: short.campaign.inputs, checkpoint: shortCheckpoint, closure: short.closure, now: '2026-11-02T08:00:00Z', ...statistics });
  assert.equal(directional.statistics.decision, 'inconclusive');
  assert.equal(directional.statistics.scope, 'directional-reference');
  assert.equal(directional.statistics.reasons[0], 'campaign_directional_below_minimum_groups');
  const { campaign, closure } = await unsettled();
  const { checkpoint } = await awaiting(campaign);
  const late = await closurePayload({ manifest: campaign.manifest, inputs: campaign.inputs, checkpoint, closure, now: '2026-12-02T00:00:00Z', ...statistics });
  // the procedure stops at the first refusal, and a closure's is always the incomplete cost, before the date is read
  assert.equal(late.statistics.decision, 'inconclusive');
  assert.deepEqual(late.statistics.reasons, ['complete cost identity not attested']);
});

test('a tool-patch campaign is closed the same way, under its own consumer identity', async () => {
  const { campaign, closure } = await unsettled({ surface: 'tool-patch' });
  const { checkpoint } = await awaiting(campaign);
  const payload = await closurePayload({ manifest: campaign.manifest, inputs: campaign.inputs, checkpoint, closure, now: '2026-11-02T08:00:00Z', ...statistics });
  assert.equal(payload.surface, 'tool-patch');
  assert.equal(payload.consumer.revision, 'tool-patch-arms-v1');
  assert.equal(payload.statistics.decision, 'inconclusive', 'lower-bound costs are not complete costs');
  assert.ok(signEnvelope(payload, generateEvaluatorKey().privateKey).signature);
});

test('the closure module uses only what the round-1 lab image already has, because the lab runs it in the image the campaign ran in', async () => {
  // The registered consumer identity digests that image's files, so the closure must run on them: it may import these names from these modules and nothing
  // else (the tool-patch and directional modules are loaded dynamically, only when present). Checked against the round-1 image's exports on 2026-11-02.
  const source = await readFile(new URL('../harness_closure.mjs', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/^import \{([^}]*)\} from '(\.\/[^']+)';$/gm)].map(([, names, from]) => [from, names.split(',').map((name) => name.trim()).sort()]);
  assert.deepEqual(Object.fromEntries(imports), {
    './evaluator.mjs': ['evaluatorKey', 'signEnvelope'],
    './campaign_runner.mjs': ['digest', 'evaluateStatistics'],
    './harness_campaign.mjs': ['HARNESS_COST_IDENTITY', 'chooseHarnessCandidate', 'harnessCampaignConsumerIdentity', 'harnessDevelopmentResult', 'harnessObservations'].sort(),
  });
  assert.deepEqual([...source.matchAll(/await import\('(\.\/[^']+)'\)/g)].map((match) => match[1]).sort(), ['./directional.mjs', './tool_patch_campaign.mjs']);
});
