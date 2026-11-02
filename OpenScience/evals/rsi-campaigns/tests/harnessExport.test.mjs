import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHarnessCampaign, readChecked } from '../harness_assemble.mjs';
import { harnessArmsIssues } from '../harness_campaign.mjs';
import { runToVerdict, runnerEnvironment } from '../profiles/benign_fixture.mjs';
import { GOOD, IMAGE, generator } from '../profiles/harness_fixture.mjs';

// The Python exporter and registrar write what this consumer reads: synthetic bench-driver/3 result folders, through
// export_harness_arms.py and register_round.py (python3 -I), into the assembler, the runner, the evaluator and the statistics.
const tools = fileURLToPath(new URL('../../public-benchmarks/tools/', import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'rsi-export-'));
const assembler = fileURLToPath(new URL('../harness_assemble.mjs', import.meta.url));
const python = (script, args) => spawnSync('python3', ['-I', join(tools, script), ...args], { encoding: 'utf8' });

const DEV_IDS = Array.from({ length: 30 }, (_, i) => String(1000 + i)), CONF_IDS = Array.from({ length: 32 }, (_, i) => String(2000 + i));
const calculator = (id, index) => (index < Math.round((id.startsWith('1') ? 30 : 32) * (id.startsWith('1') ? 0.6 : 0.85)) ? (index % 2 ? 3 : 2) : 5);
const item = (id, index, bench) => ({ key: `${bench}/${id}`, bench, id, gold: { calculator_id: calculator(id, index), answer: '10.0', lower: '9.5', upper: '10.5', output_type: 'decimal' }, meta: { calculator_id: calculator(id, index) } });
const itemsFile = async (name, ids) => { const path = join(scratch, name); await writeFile(path, ids.map((id, i) => JSON.stringify(item(id, i, 'medcalc'))).join('\n') + '\n'); return path; };

/** Result folders as bench-driver/3 writes them: <key with / as __>/result.json and answer.md. */
async function results(name, arm, ids, repeats, { p, seed, status = () => 'succeeded', cost = { cost: 0.1, openCost: 0, uncertain: 0 }, errorCode = () => null }) {
  const dir = join(scratch, name);
  const random = generator(seed);
  const token = arm === 'baseline' ? 'base' : arm;
  for (const [index, id] of ids.entries()) for (let repeat = 0; repeat < repeats; repeat += 1) {
    const key = `medcalc-rsi/${token}/${id}${repeats > 1 ? `#r${repeat}` : ''}`;
    const folder = join(dir, key.replace('/', '__').replace('/', '__').replace(/[^A-Za-z0-9_.-]/g, '_'));
    await mkdir(folder, { recursive: true });
    const state = status(id, repeat), good = random() < p(calculator(id, index) !== 5);
    const record = state === 'dispatch_refused' || state === 'driver_error' ? { key, status: state, driver: 'bench-driver/3', errorCode: errorCode(id, repeat) }
      : { key, bench: 'medcalc-rsi', id, status: state, driver: 'bench-driver/3', runId: `run-${token}-${id}-${repeat}`, errorCode: errorCode(id, repeat), runStatus: state === 'succeeded' ? 'succeeded' : 'failed', cost: { ...cost, cost: Math.round(0.1 * (0.85 + 0.3 * random()) * 1e6) / 1e6 } };
    await writeFile(join(folder, 'result.json'), JSON.stringify(record));
    if (state === 'succeeded') await writeFile(join(folder, 'answer.md'), good ? 'Working.\nFinal answer: 10.1\n' : 'Working.\nFinal answer: 14\n');
  }
  return dir;
}

async function writeInputs() {
  const bundles = join(scratch, 'bundles.json');
  await writeFile(bundles, JSON.stringify({ candidates: [{ title: GOOD.harness.title, bundle: GOOD.harness.bundle }] }));
  const baseline = (name, ids, repeats, seed, extra = {}) => results(name, 'baseline', ids, repeats, { p: (slice) => (slice ? 0.35 : 0.85), seed, ...extra });
  const arms = { dev: {}, conf: {} };
  arms.dev.baseline = await baseline('dev-base', DEV_IDS, 1, 7);
  arms.dev.aa = await results('dev-aa', 'aa', DEV_IDS, 1, { p: (slice) => (slice ? 0.35 : 0.85), seed: 8 });
  arms.dev.cand = await results('dev-cand', GOOD.arm, DEV_IDS, 1, { p: (slice) => (slice ? 0.8 : 0.85), seed: 9 });
  arms.conf.baseline = await baseline('conf-base', CONF_IDS, 3, 11);
  arms.conf.cand = await results('conf-cand', GOOD.arm, CONF_IDS, 3, { p: (slice) => (slice ? 0.8 : 0.85), seed: 12 });
  const pools = join(scratch, 'pools.json');
  await writeFile(pools, JSON.stringify({ schema: 'bench-pools/1', bench: 'medcalc', salt: 'rsi-test', pools: { main: { development: DEV_IDS, confirmation: CONF_IDS } } }));
  const registration = join(scratch, 'registration.json');
  const registered = python('register_round.py', ['--round', 'rsi1-test', '--family', 'medcalc', '--benchmark', 'medcalc-bench', '--scorer', 'medcalc', '--pools', pools, '--failure-slice', '2,3', '--out', registration, '--force']);
  assert.equal(registered.status, 0, registered.stderr);
  return { bundles, arms, registration };
}

const exportArgs = (role, inputs, extra = []) => {
  const side = role === 'development' ? 'dev' : 'conf';
  const items = role === 'development' ? join(scratch, 'items-dev.jsonl') : join(scratch, 'items-conf.jsonl');
  return ['--role', role, '--benchmark', 'medcalc-bench', '--items', items, '--row-ids', inputs.registration, '--bundles', inputs.bundles, '--image-id', IMAGE.id, '--image-digest', IMAGE.digest,
    '--bench-key', 'medcalc-rsi', '--repeats', role === 'development' ? '1' : '3', '--arm', `baseline=${inputs.arms[side].baseline}`,
    ...(role === 'development' ? ['--arm', `aa=${inputs.arms.dev.aa}`] : []), '--arm', `${GOOD.arm}=${inputs.arms[side].cand}`, ...extra];
};

test('what the exporter and the registrar write is a campaign the lab assembles, runs and qualifies', async () => {
  await writeFile(join(scratch, 'items-dev.jsonl'), DEV_IDS.map((id, i) => JSON.stringify(item(id, i, 'medcalc'))).join('\n') + '\n');
  await writeFile(join(scratch, 'items-conf.jsonl'), CONF_IDS.map((id, i) => JSON.stringify(item(id, i, 'medcalc'))).join('\n') + '\n');
  const inputs = await writeInputs();
  const out = join(scratch, 'out');
  const dev = python('export_harness_arms.py', [...exportArgs('development', inputs), '--out', join(out, 'development.json')]);
  assert.equal(dev.status, 0, dev.stderr);
  const conf = python('export_harness_arms.py', [...exportArgs('confirmation', inputs), '--out', join(out, 'confirmation.json')]);
  assert.equal(conf.status, 0, conf.stderr);
  // The seal: the confirmation file carries no gold, the gold travels apart, and no output prints a score.
  const sealed = JSON.parse(await readFile(join(out, 'confirmation.json'), 'utf8'));
  assert.ok(sealed.rows.every((row) => !('gold' in row)));
  assert.doesNotMatch(`${conf.stdout}${conf.stderr}`, /score|accuracy|correct/i);
  const goldFile = JSON.parse(await readChecked(join(out, 'confirmation.gold.json')));
  assert.equal(goldFile.kind, 'harness-gold');
  const development = JSON.parse(await readChecked(join(out, 'development.json')));
  assert.ok(development.rows.every((row) => row.gold), 'development rows carry their gold');
  assert.deepEqual(Object.keys(development.arms).sort(), ['aa', 'baseline', GOOD.arm].sort());
  assert.equal(development.arms[GOOD.arm].harness.digest, GOOD.harness.digest, 'Python and JS digest the same patch the same way');
  const round = JSON.parse(await readChecked(join(scratch, 'registration.json')));
  const built = await buildHarnessCampaign({ development, confirmation: JSON.parse(await readChecked(join(out, 'confirmation.json'))), registration: round, confirmationGold: goldFile, month: '2026-11', pilotRationale: 'Synthetic.' });
  assert.equal(built.supply.developmentChoice.frozen.arm, GOOD.arm);
  const { completed } = await runToVerdict({ manifest: built.manifest, inputs: built.inputs }, { dir: join(scratch, 'verdict') });
  assert.equal(completed.qualification, 'qualified', JSON.stringify(completed.checkpoint?.evaluation?.reasons ?? completed).slice(0, 300));
  // The command line the lab script calls builds the same campaign from the files, checking each against its digest first.
  const cli = (args) => spawnSync('node', [assembler, ...args], { encoding: 'utf8', env: process.env });
  const common = ['--registration', inputs.registration, '--month', '2026-11'];
  const assembled = cli(['--development', join(out, 'development.json'), '--confirmation', join(out, 'confirmation.json'), '--confirmation-gold', join(out, 'confirmation.gold.json'), ...common,
    '--out-dir', join(out, 'cli'), '--pilot-rationale', 'Synthetic.']);
  assert.equal(assembled.status, 0, assembled.stderr);
  const fromFiles = JSON.parse(await readFile(join(out, 'cli', 'manifest.json'), 'utf8'));
  assert.deepEqual(fromFiles.data.sources, built.manifest.data.sources, 'the same sources, byte for byte');
  assert.equal(fromFiles.registration.digest, built.manifest.registration.digest);
  const preview = cli(['--preview', '--development', join(out, 'development.json'), ...common]);
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).developmentChoice.frozen.arm, GOOD.arm);
  assert.equal(cli(['--preview', '--development', join(out, 'confirmation.json'), ...common]).status, 1, 'a confirmation source is not previewed');
  // A file that changed after its digest is not read.
  await writeFile(join(out, 'confirmation.gold.json'), `${await readFile(join(out, 'confirmation.gold.json'), 'utf8')} `);
  const changed = cli(['--development', join(out, 'development.json'), '--confirmation', join(out, 'confirmation.json'), '--confirmation-gold', join(out, 'confirmation.gold.json'), ...common,
    '--out-dir', join(out, 'cli2'), '--pilot-rationale', 'Synthetic.']);
  assert.equal(changed.status, 1);
  assert.match(changed.stderr, /campaign_input_checksum_mismatch/);
});

test('an infrastructure failure or a missing result is incomplete at the exporter, never a zero; a solver\'s non-delivery is a run', async () => {
  const inputs = await writeInputs();
  const out = join(scratch, 'out-incomplete');
  const make = async (name, status, errorCode) => results(name, GOOD.arm, CONF_IDS, 3, { p: (slice) => (slice ? 0.8 : 0.85), seed: 12, status: (id, repeat) => (id === '2003' && repeat === 1 ? status : 'succeeded'), errorCode: (id, repeat) => (id === '2003' && repeat === 1 ? errorCode : null) });
  for (const [status, errorCode] of [['dispatch_refused', 'internal_error'], ['driver_error', null], ['failed', 'runtime_stopped'], ['failed', 'runtime_session_not_found']]) {
    const cand = await make(`conf-cand-${status}-${errorCode}`, status, errorCode);
    const run = python('export_harness_arms.py', [...exportArgs('confirmation', { ...inputs, arms: { ...inputs.arms, conf: { ...inputs.arms.conf, cand } } }), '--out', join(out, `${status}-${errorCode}.json`)]);
    assert.equal(run.status, 3, `${status}/${errorCode}: ${run.stderr}`);
    await assert.rejects(readFile(join(out, `${status}-${errorCode}.json`)), { code: 'ENOENT' }, 'nothing is written by default');
  }
  // --allow-incomplete writes what exists, lists what is missing, and the lab refuses the source as incomplete
  const cand = await make('conf-cand-refused', 'dispatch_refused', 'internal_error');
  const written = python('export_harness_arms.py', [...exportArgs('confirmation', { ...inputs, arms: { ...inputs.arms, conf: { ...inputs.arms.conf, cand } } }), '--allow-incomplete', '--out', join(out, 'partial.json')]);
  assert.equal(written.status, 3);
  const partial = JSON.parse(await readFile(join(out, 'partial.json'), 'utf8'));
  const incomplete = JSON.parse(await readFile(join(out, 'partial.json.incomplete.json'), 'utf8'));
  assert.equal(incomplete.length, 1);
  assert.equal(partial.runs.length, 2 * 32 * 3 - 1, 'the missing run is missing, not zero');
  assert.ok(!partial.runs.some((r) => r.arm === GOOD.arm && r.row === '2003' && r.repeat === 1));
  assert.deepEqual(harnessArmsIssues({ ...partial, rows: partial.rows.map((row) => ({ ...row, gold: { answer: '10.0', lower: '9.5', upper: '10.5' } })) }, { scorer: 'medcalc', failureCalculators: [2, 3] }), ['harness_arms_runs_incomplete']);
  // the solver's own non-delivery (a timeout, a failure with a solver code) is exported as a run with its status
  const timed = await make('conf-cand-timeout', 'timeout', 'runtime_canceled');
  const kept = python('export_harness_arms.py', [...exportArgs('confirmation', { ...inputs, arms: { ...inputs.arms, conf: { ...inputs.arms.conf, cand: timed } } }), '--out', join(out, 'timeout.json')]);
  assert.equal(kept.status, 0, kept.stderr);
  const source = JSON.parse(await readFile(join(out, 'timeout.json'), 'utf8'));
  assert.equal(source.runs.find((r) => r.arm === GOOD.arm && r.row === '2003' && r.repeat === 1).status, 'timeout');
  assert.equal(source.runs.find((r) => r.arm === GOOD.arm && r.row === '2003' && r.repeat === 1).answer, null);
});

// A judged family end to end: raw verdict lines in three passes, through the exporter (digested records, the judge named), the
// registrar (the judge's qualification) and the assembly (the records joined only from the digested file) into the runner.
const DRB_IDS = Array.from({ length: 30 }, (_, i) => String(i + 1)), DRB_CONF = Array.from({ length: 32 }, (_, i) => String(i + 101));
const DRB_SLICE_SHARE = { dev: 0.6, conf: 0.85 };
const category = (side, index, ids) => (index < Math.round(ids.length * DRB_SLICE_SHARE[side]) ? 'Science' : 'Health');
const drbItem = (side, ids) => ids.map((id, index) => JSON.stringify({ key: `drb-rsi/${id}`, bench: 'drb', id, meta: { topic: category(side, index, ids), language: 'en' } })).join('\n') + '\n';

test('a judged export is digested records the lab joins, and the judge it names is the one registered', async () => {
  const dir = join(scratch, 'judged');
  await mkdir(dir, { recursive: true });
  const bundles = join(dir, 'bundles.json');
  await writeFile(bundles, JSON.stringify({ candidates: [{ title: GOOD.harness.title, bundle: GOOD.harness.bundle }] }));
  await writeFile(join(dir, 'items-dev.jsonl'), drbItem('dev', DRB_IDS));
  await writeFile(join(dir, 'items-conf.jsonl'), drbItem('conf', DRB_CONF));
  const JUDGE = 'claude-judge-test';
  const spec = { dev: { ids: DRB_IDS, repeats: 1, arms: ['baseline', 'aa', GOOD.arm], seed: 5 }, conf: { ids: DRB_CONF, repeats: 3, arms: ['baseline', GOOD.arm], seed: 24 } };
  const mean = (arm) => (arm === GOOD.arm ? 0.7 : 0.5);
  const verdictFiles = { dev: [], conf: [] }, armDirs = { dev: {}, conf: {} };
  for (const [side, { ids, repeats, arms, seed }] of Object.entries(spec)) {
    const random = generator(seed);
    const lines = [[], [], []];
    for (const arm of arms) {
      const token = arm === 'baseline' ? 'base' : arm, root = join(dir, `${side}-${arm}`);
      armDirs[side][arm] = root;
      for (const id of ids) for (let repeat = 0; repeat < repeats; repeat += 1) {
        const key = `drb-rsi/${token}/${id}${repeats > 1 ? `#r${repeat}` : ''}`, folder = join(root, key.replace('/', '__').replace('/', '__').replace(/[^A-Za-z0-9_.-]/g, '_'));
        await mkdir(folder, { recursive: true });
        await writeFile(join(folder, 'result.json'), JSON.stringify({ key, status: 'succeeded', driver: 'bench-driver/3', runId: `run-${token}-${id}-${repeat}`, errorCode: null, cost: { cost: Math.round(0.1 * (0.85 + 0.3 * random()) * 1e6) / 1e6, openCost: 0, uncertain: 0 } }));
        await writeFile(join(folder, 'answer.md'), `# Report ${id} by ${token} (${repeat})\n\nBody.\n`);
        for (let pass = 0; pass < 3; pass += 1) lines[pass].push(JSON.stringify({ key, score: Math.round(Math.min(1, Math.max(0, mean(arm) + (random() - 0.5) * 0.4)) * 1e6) / 1e6, judge: JUDGE }));
      }
    }
    for (const [pass, rows] of lines.entries()) {
      const file = join(dir, `${side}${pass === 0 ? '' : `.p${pass + 1}`}.jsonl`);
      await writeFile(file, `${rows.join('\n')}\n`);
      verdictFiles[side].push(file);
    }
  }
  const pools = join(dir, 'pools.json'), registration = join(dir, 'registration.json');
  await writeFile(pools, JSON.stringify({ schema: 'bench-pools/1', bench: 'drb', salt: 'rsi-test', pools: { main: { development: DRB_IDS, confirmation: DRB_CONF } } }));
  const judgeArgs = ['--judge-id', JUDGE, '--judge-provider', 'anthropic', '--judge-form', 'absolute', '--judge-passes', '3', '--judge-max-calls', '5000', '--judge-agreement', '0.96',
    '--judge-noise-sd', '0.0155', '--judge-noise-band', '0.0304', '--judge-measured-on', 'judge-noise.txt (synthetic)', '--judge-min-agreement', '0.9', '--judge-max-noise-band', '0.05'];
  const registered = python('register_round.py', ['--round', 'rsi1-test', '--family', 'drb', '--benchmark', 'deepresearchbench', '--scorer', 'judged-verdicts', '--pools', pools, '--failure-slice', 'Science', ...judgeArgs, '--out', registration]);
  assert.equal(registered.status, 0, registered.stderr);
  const exportRole = (role) => {
    const side = role === 'development' ? 'dev' : 'conf';
    return python('export_harness_arms.py', ['--role', role, '--benchmark', 'deepresearchbench', '--items', join(dir, `items-${side}.jsonl`), '--row-ids', registration, '--bundles', bundles, '--image-id', IMAGE.id, '--image-digest', IMAGE.digest,
      '--bench-key', 'drb-rsi', '--repeats', String(spec[side].repeats), ...Object.entries(armDirs[side]).flatMap(([arm, root]) => ['--arm', `${arm}=${root}`]),
      '--verdicts', ...verdictFiles[side], '--dialect', 'unit', '--judge-id', JUDGE, '--judge-provider', 'anthropic', '--judge-form', 'absolute', '--judge-passes', '3', '--out', join(dir, `${side}-export`, `${role}.json`)]);
  };
  for (const role of ['development', 'confirmation']) { const made = exportRole(role); assert.equal(made.status, 0, made.stderr); }
  const exported = (role) => join(dir, `${role === 'development' ? 'dev' : 'conf'}-export`, `${role}.json`);
  const development = JSON.parse(await readChecked(exported('development'))), confirmation = JSON.parse(await readChecked(exported('confirmation')));
  assert.ok(confirmation.rows.every((row) => !('gold' in row)) && confirmation.judged.records === undefined && development.judged.records === undefined, 'no scores in an export');
  assert.equal(confirmation.runs.every((r) => r.answer === null && /^[a-f0-9]{64}$/.test(r.reportSha256)), true);
  assert.deepEqual(development.judged.judge, { id: JUDGE, provider: 'anthropic', form: 'absolute', passes: 3 });
  assert.equal(development.judged.cost.settledCny, 0);
  const round = JSON.parse(await readChecked(registration));
  const verdicts = { development: await readChecked(join(dir, 'dev-export', 'development.verdicts.jsonl')), confirmation: await readChecked(join(dir, 'conf-export', 'confirmation.verdicts.jsonl')) };
  const built = await buildHarnessCampaign({ development, confirmation, registration: round, developmentVerdicts: verdicts.development, confirmationVerdicts: verdicts.confirmation, month: '2026-11', pilotRationale: 'Synthetic.' });
  assert.equal(built.supply.developmentChoice.frozen.arm, GOOD.arm);
  assert.equal(built.supply.judge.calls, development.judged.calls + confirmation.judged.calls);
  const { completed } = await runToVerdict({ manifest: built.manifest, inputs: built.inputs }, { dir: join(dir, 'verdict') });
  assert.equal(completed.qualification, 'qualified', JSON.stringify(completed.checkpoint?.evaluation?.reasons ?? completed).slice(0, 300));
  // A record changed after the export is not the file the export digested.
  await assert.rejects(buildHarnessCampaign({ development, confirmation, registration: round, developmentVerdicts: verdicts.development.replace('0.', '0.1'), confirmationVerdicts: verdicts.confirmation, month: '2026-11', pilotRationale: 'x' }), { message: 'campaign_judge_verdicts_changed' });
  // A judge on the solver's family is refused by the exporter before a record is written.
  const refused = python('export_harness_arms.py', ['--role', 'development', '--benchmark', 'deepresearchbench', '--items', join(dir, 'items-dev.jsonl'), '--bundles', bundles, '--image-id', IMAGE.id, '--image-digest', IMAGE.digest, '--bench-key', 'drb-rsi', '--repeats', '1',
    ...Object.entries(armDirs.dev).flatMap(([arm, root]) => ['--arm', `${arm}=${root}`]), '--verdicts', ...verdictFiles.dev, '--dialect', 'unit', '--judge-id', 'deepseek-v4-pro', '--judge-provider', 'deepseek', '--judge-form', 'absolute', '--judge-passes', '3', '--out', join(dir, 'refused', 'development.json')]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /deepseek/i);
});

// BixBench through the judged path (2026-11-02): capsules too few for the procedure (a directional campaign), scored by a judge's per-question
// verdicts. The exporter turns the verdict lines into one score per run and pass; the registrar admits the benchmark under `judged-verdicts`;
// the assembly takes it; the runner opens the corpus directionally and the campaign cannot be qualified.
test('a judged BixBench export assembles under judged-verdicts, and below the procedure\'s groups it is a directional reference', async () => {
  const dir = join(scratch, 'bix-judged');
  await mkdir(dir, { recursive: true });
  const BIX_DEV = Array.from({ length: 8 }, (_, i) => `bix-${i + 1}`), BIX_CONF = Array.from({ length: 7 }, (_, i) => `bix-${i + 21}`);
  const questionsOf = (id) => Array.from({ length: 1 + (Number(id.slice(4)) % 3) }, (_, i) => `${id}-q${i + 1}`);
  const bundles = join(dir, 'bundles.json');
  await writeFile(bundles, JSON.stringify({ candidates: [{ title: GOOD.harness.title, bundle: GOOD.harness.bundle }] }));
  const bixItem = (ids) => ids.map((id, index) => JSON.stringify({ key: `bixbench/${id}`, bench: 'bixbench', id, gold: { questions: [] }, meta: { topic: index % 2 ? 'imaging' : 'transcriptomics' } })).join('\n') + '\n';
  await writeFile(join(dir, 'items-dev.jsonl'), bixItem(BIX_DEV));
  await writeFile(join(dir, 'items-conf.jsonl'), bixItem(BIX_CONF));
  await writeFile(join(dir, 'question-ids.json'), JSON.stringify(Object.fromEntries([...BIX_DEV, ...BIX_CONF].map((id) => [id, questionsOf(id)]))));
  const JUDGE = 'claude-bix-judge-test';
  const spec = { dev: { ids: BIX_DEV, repeats: 1, arms: ['baseline', 'aa', GOOD.arm] }, conf: { ids: BIX_CONF, repeats: 3, arms: ['baseline', GOOD.arm] } };
  const verdictFiles = { dev: [], conf: [] }, armDirs = { dev: {}, conf: {} };
  for (const [side, { ids, repeats, arms }] of Object.entries(spec)) {
    const lines = [[], []];
    for (const arm of arms) {
      const token = arm === 'baseline' ? 'base' : arm, root = join(dir, `${side}-${arm}`);
      armDirs[side][arm] = root;
      for (const id of ids) for (let repeat = 0; repeat < repeats; repeat += 1) {
        const key = `bix-rsi/${token}/${id}${repeats > 1 ? `#r${repeat}` : ''}`, folder = join(root, key.replace('/', '__').replace('/', '__').replace(/[^A-Za-z0-9_.-]/g, '_'));
        await mkdir(folder, { recursive: true });
        await writeFile(join(folder, 'result.json'), JSON.stringify({ key, status: 'succeeded', driver: 'bench-driver/3', runId: `run-${token}-${id}-${repeat}`, errorCode: null, cost: { cost: 0.4, openCost: 0, uncertain: 0 } }));
        await writeFile(join(folder, 'answer.md'), 'Final answers:\n1. 3\n');
        for (const pass of [0, 1]) for (const question of questionsOf(id)) lines[pass].push(JSON.stringify({ key: `${key}#${question}`, verdict: arm === GOOD.arm || question.endsWith('q1') ? 'correct' : 'incorrect', judge: JUDGE }));
      }
    }
    for (const [pass, rows] of lines.entries()) {
      const file = join(dir, `${side}${pass === 0 ? '' : `.p${pass + 1}`}.jsonl`);
      await writeFile(file, `${rows.join('\n')}\n`);
      verdictFiles[side].push(file);
    }
  }
  const pools = join(dir, 'pools.json'), registration = join(dir, 'registration.json');
  await writeFile(pools, JSON.stringify({ schema: 'bench-pools/1', bench: 'bixbench', salt: 'rsi-test', pools: { main: { development: BIX_DEV, confirmation: BIX_CONF } } }));
  const judgeArgs = ['--judge-id', JUDGE, '--judge-provider', 'anthropic', '--judge-form', 'absolute', '--judge-passes', '2', '--judge-max-calls', '400', '--judge-agreement', '0.95',
    '--judge-noise-sd', '0.06', '--judge-noise-band', '0.12', '--judge-measured-on', 'synthetic', '--judge-min-agreement', '0.9', '--judge-max-noise-band', '0.15'];
  const registered = python('register_round.py', ['--round', 'rsi2-test', '--family', 'bixbench', '--benchmark', 'bixbench', '--scorer', 'judged-verdicts', '--pools', pools, '--failure-slice', 'imaging,transcriptomics',
    '--development-rows', '8', '--confirmation-rows', '7', '--candidates-max', '1', ...judgeArgs, '--out', registration]);
  assert.equal(registered.status, 0, registered.stderr);
  const exportRole = (role) => {
    const side = role === 'development' ? 'dev' : 'conf';
    return python('export_harness_arms.py', ['--role', role, '--benchmark', 'bixbench-judged', '--items', join(dir, `items-${side}.jsonl`), '--row-ids', registration, '--bundles', bundles, '--image-id', IMAGE.id, '--image-digest', IMAGE.digest,
      '--bench-key', 'bix-rsi', '--repeats', String(spec[side].repeats), ...Object.entries(armDirs[side]).flatMap(([arm, root]) => ['--arm', `${arm}=${root}`]),
      '--verdicts', ...verdictFiles[side], '--dialect', 'questions', '--question-ids', join(dir, 'question-ids.json'), '--judge-id', JUDGE, '--judge-provider', 'anthropic', '--judge-form', 'absolute', '--judge-passes', '2',
      '--out', join(dir, `${side}-export`, `${role}.json`)]);
  };
  for (const role of ['development', 'confirmation']) { const made = exportRole(role); assert.equal(made.status, 0, made.stderr); }
  const exported = (role) => join(dir, `${role === 'development' ? 'dev' : 'conf'}-export`, `${role}.json`);
  const development = JSON.parse(await readChecked(exported('development'))), confirmation = JSON.parse(await readChecked(exported('confirmation')));
  assert.equal(confirmation.benchmark, 'bixbench');
  assert.deepEqual(confirmation.rows.map((row) => Object.keys(row).sort()), BIX_CONF.map(() => ['category', 'id']), 'rows carry a category and no gold');
  const round = JSON.parse(await readChecked(registration));
  assert.equal(round.judge.callsRequired, (8 * 3 + 7 * 3 * 2) * 2);
  const verdicts = { development: await readChecked(join(dir, 'dev-export', 'development.verdicts.jsonl')), confirmation: await readChecked(join(dir, 'conf-export', 'confirmation.verdicts.jsonl')) };
  const built = await buildHarnessCampaign({ development, confirmation, registration: round, developmentVerdicts: verdicts.development, confirmationVerdicts: verdicts.confirmation, month: '2026-11', pilotRationale: 'Synthetic.' });
  assert.equal(built.supply.directional, true, '7 capsules are below the procedure\'s 25 groups');
  assert.equal(built.supply.judge.calls, development.judged.calls + confirmation.judged.calls);
  const { completed } = await runToVerdict({ manifest: built.manifest, inputs: built.inputs }, { dir: join(dir, 'verdict') });
  assert.equal(completed.qualification, 'inconclusive', 'a directional campaign cannot be qualified');
  assert.equal(completed.checkpoint.evaluation.scope, 'directional-reference');
  // the deterministic scorer does not take judged rows: the same capsules registered under it are refused by name
  const codeRegistration = join(dir, 'registration-code.json');
  const asCode = python('register_round.py', ['--round', 'rsi2-test', '--family', 'bixbench', '--benchmark', 'bixbench', '--scorer', 'bixbench-deterministic', '--pools', pools, '--failure-slice', 'imaging',
    '--development-rows', '8', '--confirmation-rows', '7', '--candidates-max', '1', '--out', codeRegistration]);
  assert.equal(asCode.status, 0, asCode.stderr);
  await assert.rejects(buildHarnessCampaign({ development, confirmation, registration: JSON.parse(await readChecked(codeRegistration)), month: '2026-11', pilotRationale: 'x' }), { message: /^(harness_arms_rows_invalid|campaign_source_invalid|harness_confirmation_gold_missing|harness_confirmation_not_sealed)$/ });
});
