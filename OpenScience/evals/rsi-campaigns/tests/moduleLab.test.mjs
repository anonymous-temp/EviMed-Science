// A module-policy round on the lab, as scripts with nothing run on a host: the real rsi-lab-harness.sh against the stand-in docker (fixtures/fake_docker.mjs), which runs the real assembly and the
// real report and stubs the steps that need a database or a key, and its own dry run. The same two commands and the same inbox as a harness-patch family; no provider credential, no model.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { rsiCampaignIssues } from '../../../packages/domain/src/rsiCampaign.mjs';
import { memoryCampaignStore, runToVerdict, tickingClock } from '../profiles/benign_fixture.mjs';
import { harnessFixture, improvementOf } from '../profiles/harness_fixture.mjs';
import { moduleFixture } from '../profiles/module_fixture.mjs';

const run = promisify(execFile);
const repo = fileURLToPath(new URL('../../../', import.meta.url)), script = join(repo, 'deploy/rsi-campaign/rsi-lab-harness.sh');
// The assembly stamps its campaign with the clock it runs at, inside the month it is told.
const MONTH = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 7);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const scratch = await mkdtemp(join(tmpdir(), 'rsi-module-lab-'));
after(() => rm(scratch, { recursive: true, force: true }));
let dirs = 0;

/** A lab's tree with a module round's files in its inbox, each with its sidecar, as the operator copies them. `omit` leaves files out. */
async function labTree(fixture, family, { omit = [] } = {}) {
  const dir = join(scratch, String(dirs += 1)), root = join(dir, 'lab'), etc = join(dir, 'etc'), bin = join(dir, 'bin'), inbox = join(root, 'inbox', `harness-${family}-${MONTH}`), state = join(root, 'state', `harness-${family}-${MONTH}`);
  for (const path of [inbox, join(root, 'outbox'), join(etc, 'secrets'), join(etc, 'owner-inputs'), join(etc, 'keys'), bin]) await mkdir(path, { recursive: true });
  await writeFile(join(etc, 'image'), 'evimed-rsi-lab:test\n');
  await writeFile(join(etc, 'secrets', 'lab.env'), 'RSI_LAB_DATABASE_URL=postgres://unused\n');
  await symlink(fileURLToPath(new URL('./fixtures/fake_docker.sh', import.meta.url)), join(bin, 'fake-docker'));
  const { development, confirmation } = fixture.exports;
  const files = { 'registration.json': JSON.stringify(fixture.round), 'improvement.json': JSON.stringify(improvementOf()), 'development.json': JSON.stringify(development.source), 'confirmation.json': JSON.stringify(confirmation.source),
    ...(confirmation.gold ? { 'confirmation.gold.json': JSON.stringify(confirmation.gold) } : {}), ...(development.verdicts ? { 'development.verdicts.jsonl': development.verdicts, 'confirmation.verdicts.jsonl': confirmation.verdicts } : {}) };
  const seed = async (name, text) => { await writeFile(join(inbox, name), text); await writeFile(join(inbox, `${name}.sha256`), `${sha(text)}  ${name}\n`); };
  for (const [name, text] of Object.entries(files)) if (!omit.includes(name)) await seed(name, text);
  const log = join(dir, 'docker.jsonl');
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: dir, TMPDIR: dir, RSI_LAB_ROOT: root, RSI_LAB_ETC: etc, RSI_LAB_DOCKER: join(bin, 'fake-docker'), RSI_LAB_OWNER: `${process.getuid()}:${process.getgid()}`, RSI_LAB_POLL_SECONDS: '0', FAKE_DOCKER_REPO: repo, FAKE_DOCKER_LOG: log };
  const lab = (command, extra = {}) => run('bash', [script, MONTH, family, command], { cwd: dir, env: { ...env, ...extra }, maxBuffer: 1 << 24 }).then((done) => ({ code: 0, ...done }), (error) => error);
  const dry = (command) => run('bash', [script, MONTH, family, command], { cwd: dir, env: { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, RSI_LAB_DRY_RUN: '1', RSI_LAB_ROOT: root, RSI_LAB_ETC: etc }, maxBuffer: 1 << 24 }).then((done) => ({ code: 0, ...done }), (error) => error);
  const calls = async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { root, state, seed, files, lab, dry, calls, outbox: join(root, 'outbox', `harness-${family}-${MONTH}`) };
}
const named = (calls, name) => calls.filter((call) => call.script?.endsWith(name));

test('develop: the same command on the same inbox recomputes the module\'s gate, opens nothing and signs a report under its own title', async () => {
  const fixture = await moduleFixture('frontier-edit'), t = await labTree(fixture, 'frontier-edit');
  const done = await t.lab('develop');
  assert.equal(done.code, 0, done.stderr);
  const calls = await t.calls();
  assert.deepEqual(calls.map((call) => call.script.split('/').pop()), ['harness_assemble.mjs', 'harness_report.mjs', 'evaluator.mjs']);
  assert.ok(named(calls, 'harness_assemble.mjs')[0].args.includes('--development-only'));
  assert.equal(named(calls, 'harness_assemble.mjs')[0].network, 'none');
  const outcome = JSON.parse(await readFile(join(t.state, 'development-only.json'), 'utf8'));
  assert.equal(outcome.supply.developmentChoice.frozen.arm, fixture.good.arm);
  const report = JSON.parse(await readFile(join(t.outbox, 'report.json'), 'utf8'));
  assert.deepEqual([report.type, report.surface, report.developmentGate], ['rsi-module-policy-report-v1', 'frontier-edit', 'passed']);
  assert.match(await readFile(join(t.outbox, 'report.md'), 'utf8'), /^# 模块策略 RSI 活动报告 · frontier-edit/);
});

test('run: the assembly takes the sealed confirmation and its gold, the receipt is the one evaluator command, and no step holds a provider credential', async () => {
  const fixture = await moduleFixture('autopilot-planner', { developmentRows: 6, confirmationRows: 3, sliceShareDevelopment: 0.7, sliceShareConfirmation: 0.7 }), t = await labTree(fixture, 'autopilot-planner');
  const first = await t.lab('run');
  assert.equal(first.code, 0, first.stderr);
  const manifest = JSON.parse(await readFile(join(t.state, 'manifest.json'), 'utf8'));
  assert.deepEqual(rsiCampaignIssues(manifest), []);
  assert.deepEqual([manifest.surface, manifest.candidateKind, manifest.target.baselineRevision], ['autopilot-planner', 'policy', fixture.manifest.target.baselineRevision]);
  const sealed = JSON.parse(await readFile(join(t.state, 'inputs.json'), 'utf8')).sources[`confirmation-${MONTH}`];
  assert.ok(sealed.rows.every((row) => row.gold), 'the gold joined in the lab');
  assert.ok(JSON.parse(await readFile(join(t.root, 'inbox', `harness-autopilot-planner-${MONTH}`, 'confirmation.json'), 'utf8')).rows.every((row) => !row.gold), 'and only there');
  // The stand-in runner ended it there; a campaign the runner parks for its receipt goes on with the command every surface's receipt takes.
  await appendFile(join(t.state, 'STATUS'), 'run ok 2026-11-05T00:00:00Z\n');
  await writeFile(join(t.state, 'run', 'run.json'), JSON.stringify({ status: 'awaiting-evaluation' }));
  const second = await t.lab('run');
  assert.equal(second.code, 0, second.stderr);
  const calls = await t.calls();
  const receipt = named(calls, 'evaluator.mjs').find((call) => call.args[0] === 'receipt');
  assert.ok(receipt, 'the receipt step ran');
  assert.equal(receipt.network, 'none');
  assert.ok(receipt.args[1].endsWith('manifest.json') && receipt.args[3].endsWith('run/request.json'));
  assert.ok(named(calls, 'run.mjs').some((call) => call.args[0] === 'resume'));
  assert.ok(calls.every((call) => !call.mounts.some((mount) => /credential|dashscope|deepseek/i.test(mount))), 'no provider credential in any step');
  assert.ok(!(await readFile(join(t.root, '..', 'etc', 'secrets', 'lab.env'), 'utf8')).match(/KEY|TOKEN/), 'nor a provider key in what the steps read');
  assert.ok(calls.every((call) => !/module_arms/.test(call.script)), 'no model on the lab: the arms ran on the operator\'s box');
  assert.match(await readFile(join(t.outbox, 'report.md'), 'utf8'), /^# 模块策略 RSI 活动报告 · autopilot-planner/);
});

test('improvement.json is required as for any family, a module judged scorer needs both its gold and its records, and a code scorer needs no records', async () => {
  const code = await moduleFixture('autopilot-planner', { developmentRows: 6, confirmationRows: 3, sliceShareDevelopment: 0.7, sliceShareConfirmation: 0.7 });
  const noRecord = await (await labTree(code, 'planner-a', { omit: ['improvement.json'] })).lab('develop');
  assert.equal(noRecord.code, 3);
  assert.match(noRecord.stderr, /inputs missing or checksum mismatch/);
  const noGold = await (await labTree(code, 'planner-b', { omit: ['confirmation.gold.json'] })).lab('run');
  assert.equal(noGold.code, 3, 'a code scorer\'s sealed confirmation needs its gold');
  const judged = await moduleFixture('frontier-edit', { scorer: 'frontier-source', seeds: { confirmation: 12 } });
  const t = await labTree(judged, 'source', { omit: ['confirmation.gold.json'] });
  const shortOfGold = await t.dry('run');
  assert.equal(shortOfGold.code, 3, 'frontier-source needs the gold as well as the records');
  await t.seed('confirmation.gold.json', t.files['confirmation.gold.json']);
  const complete = await t.dry('run');
  assert.equal(complete.code, 0, complete.stderr);
  const assembly = complete.stderr.split('\n').find((line) => line.includes('[dry-run] docker run') && line.includes('harness_assemble.mjs'));
  for (const flag of ['--confirmation-gold', '--development-verdicts', '--confirmation-verdicts', '--improvement']) assert.ok(assembly.includes(flag), flag);
  const noVerdicts = await (await labTree(judged, 'source-b', { omit: ['development.verdicts.jsonl'] })).dry('develop');
  assert.equal(noVerdicts.code, 3, 'and develop its development records');
  const gate = await (await labTree(judged, 'source-c', { omit: ['confirmation.json', 'confirmation.gold.json', 'confirmation.verdicts.jsonl'] })).lab('develop');
  assert.equal(gate.code, 0, `develop reads development data alone: ${gate.stderr}`);
});

// ---------------------------------------------------------------------------------------------------------- the end of a module round

/** A round at the point where its verdict is known: every earlier step marked, the campaign's records in its directory, the real script over the stand-in docker. */
async function atVerdict(fixture, resume, { family = 'round' } = {}) {
  const t = await labTree(fixture, family);
  await mkdir(join(t.state, 'run'), { recursive: true });
  await writeFile(join(t.state, 'STATUS'), ['inputs', 'bootstrap', 'assemble', 'run', 'checkpoint', 'receipt', 'resume'].map((step) => `${step} ok 2026-11-05T00:00:00Z\n`).join(''));
  for (const [name, value] of [['manifest.json', fixture.manifest], ['inputs.json', fixture.inputs], ['supply.json', fixture.supply], ['run/run.json', { status: 'awaiting-evaluation' }], ['run/resume.json', resume]]) await writeFile(join(t.state, name), JSON.stringify(value));
  return { ...t, bundles: join(t.root, 'outbox', 'bundles') };
}
const noImport = async (t) => {
  const calls = await t.calls();
  assert.ok(!named(calls, 'evaluator.mjs').some((call) => call.args[0] === 'evidence'), 'no evidence step');
  assert.deepEqual(named(calls, 'finalize.mjs'), [], 'no finalize step');
  await assert.rejects(stat(t.bundles), { code: 'ENOENT' }, 'nothing in the directory production pulls from');
};

test('a qualified module round ends at the signed report, a pull-request proposal that names the component and the text: no evidence, no finalize, no bundle', async () => {
  const fixture = await moduleFixture('frontier-edit', { scorer: 'frontier-source', seeds: { confirmation: 12 } });
  const { completed } = await runToVerdict(fixture, { dir: join(scratch, 'verdict-q'), store: memoryCampaignStore(), now: tickingClock() });
  assert.equal(completed.qualification, 'qualified', JSON.stringify(completed.checkpoint.evaluation.reasons));
  const t = await atVerdict(fixture, completed, { family: 'frontier-edit' });
  const done = await t.lab('run');
  assert.equal(done.code, 0, done.stderr);
  await noImport(t);
  assert.ok(named(await t.calls(), 'evaluator.mjs').some((call) => call.args[0] === 'report'), 'the report is signed');
  const report = JSON.parse(await readFile(join(t.outbox, 'report.json'), 'utf8')), text = await readFile(join(t.outbox, 'report.md'), 'utf8');
  const digest = sha(fixture.good.harness.policy.text);
  assert.deepEqual([report.qualification, report.frozen.component, report.frozen.textSha256], ['qualified', 'editInstructions', digest]);
  assert.match(text, /以 PR 形式改进代码里的默认值/);
  assert.ok(text.includes(digest) && text.includes('editInstructions'));
});

test('a directional round ends the same way, and its report says 方向性参考', async () => {
  const fixture = await moduleFixture('autopilot-planner', { developmentRows: 6, confirmationRows: 3, sliceShareDevelopment: 0.7, sliceShareConfirmation: 0.7 });
  const { completed } = await runToVerdict(fixture, { dir: join(scratch, 'verdict-d'), store: memoryCampaignStore(), now: tickingClock() });
  assert.equal(completed.qualification, 'inconclusive');
  const t = await atVerdict(fixture, completed, { family: 'autopilot-planner' });
  const done = await t.lab('run');
  assert.equal(done.code, 0, done.stderr);
  await noImport(t);
  assert.match(await readFile(join(t.outbox, 'report.md'), 'utf8'), /结论：方向性参考，不是合格结论/);
});

test('the harness script holds no import step for any surface, and a harness patch reads as it did', async () => {
  const code = (await readFile(script, 'utf8')).replace(/^\s*#.*$/gm, '');
  assert.ok(!/finalize\.mjs|publish_bundle|evaluator\.mjs evidence/.test(code));
  const fixture = await harnessFixture('medcalc');
  const { completed } = await runToVerdict(fixture, { dir: join(scratch, 'verdict-h'), store: memoryCampaignStore(), now: tickingClock() });
  assert.equal(completed.qualification, 'qualified');
  const t = await atVerdict({ ...fixture, exports: { development: { source: fixture.exports.development.source }, confirmation: { source: fixture.exports.confirmation.source, gold: fixture.exports.confirmation.gold } } }, completed, { family: 'medcalc' });
  assert.equal((await t.lab('run')).code, 0);
  await noImport(t);
  assert.match(await readFile(join(t.outbox, 'report.md'), 'utf8'), /把该补丁以 PR 形式提出/);
});
