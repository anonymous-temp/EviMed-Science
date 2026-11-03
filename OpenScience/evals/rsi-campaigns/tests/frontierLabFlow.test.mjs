// The frontier jury's operator flow end to end, against stand-ins for the lab host (docker, ssh, sudo, systemd) and for the operator's `claude` CLI:
// the lab's monthly script runs the deterministic steps and stops at a named wait; the operator's script answers the wait; the lab continues.
// The real node entries run (plan, items, decide, merge-labels, build, calibrate, label, the report); only the database, the runner and the keys are stubs.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rsiCampaignIssues } from '../../../packages/domain/src/rsiCampaign.mjs';
import { rsiIncumbent, rsiPolicyDefaults } from '../../../apps/server/src/rsiServingAdapters.mjs';
import { replayFrontierPool } from '../frontier_selection.mjs';
import { frontierDayPool, frontierDaysSource } from '../profiles/benign_fixture.mjs';
import { shiftMonth } from '../frontier_assemble.mjs';

const execFileAsync = promisify(execFile);
const repo = new URL('../../../', import.meta.url).pathname;
const fixtures = new URL('./fixtures/', import.meta.url).pathname;
const goldPath = new URL('../../frontier-selection/gold.jsonl', import.meta.url).pathname;
const labScript = join(repo, 'deploy/rsi-campaign/rsi-lab-monthly.sh');
const operatorScript = join(repo, 'deploy/rsi-campaign/operator/rsi-frontier-label.sh');
const BASELINE = 64;
const CURRENT = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 7);
const INCUMBENT = { revisionId: rsiIncumbent('frontier', null, rsiPolicyDefaults('frontier', { frontierSelectThreshold: BASELINE })).revisionId, threshold: BASELINE };
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** Every scratch tree a test makes is removed when the file is done: a tree holds an export, a labelled corpus and the run's state. */
const scratch = [];
after(() => Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true }))));

/** An export of the two months before `month`, with the source text of every row; `titleOf(row, worth)` is the title the stand-in jury reads its label from. */
function exportFor(month, { perfectBaseline = false } = {}) {
  const dev = shiftMonth(month, -2), conf = shiftMonth(month, -1);
  const development = frontierDaysSource({ start: `${dev}-01`, days: 14, rowsPerDay: 26, seed: 11, prefix: 'dev', cutoffs: [72, 72, 74, 76] }).days;
  const confirmation = frontierDaysSource({ start: `${conf}-01`, days: 12, rowsPerDay: 26, seed: 12, prefix: 'conf', cutoffs: [72, 72, 74, 76] }).days;
  const days = [...development, ...confirmation];
  const baselineSelects = new Set(days.flatMap((day) => replayFrontierPool(day, BASELINE).selectedIds.map(String)));
  const texts = {};
  for (const day of days) for (const row of day.rows) {
    const worth = perfectBaseline ? (baselineSelects.has(String(row.id)) ? 'pick' : 'ok') : row.safety_alert === true || row.score_total >= 72 ? 'pick' : row.score_total >= 68 ? 'ok' : 'no';
    texts[row.id] = { title_raw: `Row ${row.id} [${worth}]`, source_name: 'Source', source_type: 'media', journal: null, publication_types: [], published_at: `${day.day}T01:00:00.000Z`, date_precision: 'day', lang: 'en',
      excerpt: `Text of ${row.id}`, title_zh: 'PLATFORM-WRITTEN', summary_zh: 'PLATFORM-SUMMARY' };
  }
  return { schema: 'rsi-frontier-export-v1', exportedAt: `${month}-01T00:00:00Z`, releaseId: 'release-flow.1', from: `${dev}-01`, to: `${conf}-28`,
    settings: { threshold: BASELINE, thresholdSource: 'config', preprintPlaces: 2, preprintMinScore: 50, scoreVersion: 'current', timeZone: 'Asia/Shanghai' },
    incumbent: INCUMBENT, consumer: [], days, texts, signals: {} };
}

/** A lab host's tree and the operator's box, as directories: the lab's state, inbox and outbox, its owner inputs, and the stand-in commands on PATH. */
async function tree(document, month = CURRENT) {
  const dir = await mkdtemp(join(tmpdir(), 'rsi-flow-'));
  scratch.push(dir);
  const root = join(dir, 'lab'), etc = join(dir, 'etc'), bin = join(dir, 'bin'), work = join(dir, 'operator');
  for (const path of [join(root, 'state'), join(root, 'inbox'), join(root, 'outbox'), join(etc, 'secrets'), join(etc, 'owner-inputs'), join(etc, 'keys'), bin]) await mkdir(path, { recursive: true });
  await writeFile(join(etc, 'image'), 'evimed-rsi-lab:test\n');
  const bytes = gzipSync(JSON.stringify(document));
  const name = `frontier-${month}.json.gz`;
  await writeFile(join(root, 'inbox', name), bytes);
  await writeFile(join(root, 'inbox', `${name}.sha256`), `${sha(bytes)}  ${name}\n`);
  for (const [command, target] of [['claude', 'fake_claude_cli.mjs'], ['ssh', 'fake_ssh.sh'], ['fake-docker', 'fake_docker.sh']]) await symlink(join(fixtures, target), join(bin, command));
  const runLab = join(bin, 'run-lab.sh');
  await writeFile(runLab, `#!/usr/bin/env bash\nexec bash ${labScript} "$@"\n`); await chmod(runLab, 0o755);
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: dir, TMPDIR: dir, RSI_LAB_ROOT: root, RSI_LAB_ETC: etc, RSI_LAB_DOCKER: join(bin, 'fake-docker'), RSI_LAB_OWNER: `${process.getuid()}:${process.getgid()}`,
    RSI_LAB_POLL_SECONDS: '0', RSI_LAB_SSH: 'evimed-test', RSI_LABEL_DIR: work, FAKE_DOCKER_REPO: repo, FAKE_DOCKER_LOG: join(dir, 'docker.jsonl'), FAKE_SSH_LOG: join(dir, 'ssh.log'), FAKE_LAB_ROOT: root,
    FAKE_LAB_SCRIPT: runLab, FAKE_CLAUDE_LOG: join(dir, 'claude.jsonl'), FAKE_CLAUDE_WORTH: 'by-title', FAKE_CLAUDE_GOLD: goldPath, FAKE_CLAUDE_MODE: 'ok' };
  const lines = async (file) => (await readFile(file, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
  return {
    dir, root, env, month, work,
    lab: (args = [], over = {}) => execFileAsync('bash', [labScript, ...args], { cwd: dir, env: { ...env, ...over }, maxBuffer: 1 << 24 }).catch((error) => error),
    operator: (args = [], over = {}) => execFileAsync('bash', [operatorScript, ...args], { cwd: dir, env: { ...env, ...over }, maxBuffer: 1 << 24 }).catch((error) => error),
    status: async (key = month) => (await lines(join(root, 'state', key, 'STATUS'))),
    docker: async () => (await lines(env.FAKE_DOCKER_LOG)).map((line) => JSON.parse(line)),
    claude: async () => (await lines(env.FAKE_CLAUDE_LOG)).map((line) => JSON.parse(line)),
    ssh: () => lines(env.FAKE_SSH_LOG),
    read: async (...path) => JSON.parse(await readFile(join(root, ...path), 'utf8')),
    ls: (...path) => readdir(join(root, ...path)).catch(() => []),
  };
}
const ok = (result, what) => assert.ok(!(result instanceof Error) || result.code === 0, `${what}: ${result.stderr ?? result.message}`);

test('the unattended run plans, publishes the development label-items and stops at a named wait without labelling anything', async () => {
  const t = await tree(exportFor(CURRENT));
  const result = await t.lab();
  ok(result, 'lab');
  const status = await t.status();
  assert.deepEqual(status.map((line) => line.split(' ')[0]), ['export', 'bootstrap', 'plan', 'items-development', 'wait']);
  assert.match(status.at(-1), new RegExp(`^wait labels-development \\S+ ${CURRENT}$`));
  assert.deepEqual(await t.read('state', CURRENT, 'outcome.json'), { outcome: 'waiting', reason: 'labels-development' });
  // The label-items are in the outbox with their digest, and carry the plan's development ids and only the source text.
  assert.deepEqual((await t.ls('outbox', CURRENT)).sort(), ['label-items-development.json', 'label-items-development.json.sha256']);
  const items = await t.read('outbox', CURRENT, 'label-items-development.json');
  const plan = await t.read('state', CURRENT, 'plan.json');
  assert.deepEqual([items.schema, items.phase, items.month, items.exportSha256], ['rsi-frontier-label-items-v1', 'development', CURRENT, plan.exportSha256]);
  assert.deepEqual(items.items.map((item) => item.id).sort(), plan.idsByRole.development.slice().sort());
  assert.ok(!JSON.stringify(items).includes('PLATFORM-'), 'nothing a platform model wrote');
  assert.ok(items.items.every((item) => /^\d{4}-\d{2}-\d{2}$/.test(item.today)));
  assert.equal(await readFile(join(t.root, 'outbox', CURRENT, 'label-items-development.json.sha256'), 'utf8'), `${sha(await readFile(join(t.root, 'outbox', CURRENT, 'label-items-development.json')))}  label-items-development.json\n`);
  // The lab image was asked for the deterministic steps only: none with a provider credential, none with a network but the database's.
  const calls = await t.docker();
  assert.deepEqual(calls.map((call) => call.script.split('/').pop()), ['lab_bootstrap.mjs', 'frontier_assemble.mjs', 'frontier_labels.mjs']);
  assert.deepEqual(calls.map((call) => call.network), ['rsi-lab-net', 'none', 'none']);
  assert.ok(calls.every((call) => !call.mounts.some((mount) => /credential|dashscope|anthropic|claude/i.test(mount))), 'no step mounts a credential');
  assert.equal((await t.claude()).length, 0, 'the lab never calls a model');
  // A second start changes nothing: every finished step is skipped and the wait is recorded once.
  ok(await t.lab(), 'lab again');
  assert.equal((await t.status()).length, status.length);
  assert.equal((await t.docker()).length, calls.length);
});

test('the operator answers each wait: development, then (development having found a candidate) confirmation, and the lab runs to the runner', async () => {
  const t = await tree(exportFor(CURRENT));
  ok(await t.lab(), 'lab');

  // A digest that does not match the bytes is refused by the lab, not read.
  const inbox = join(t.root, 'inbox', `frontier-labels-${CURRENT}`);
  await mkdir(inbox, { recursive: true });
  await writeFile(join(inbox, 'calibration.json'), '{"qualification":{"qualified":true}}'); await writeFile(join(inbox, 'calibration.json.sha256'), `${'0'.repeat(64)}  calibration.json\n`);
  await writeFile(join(inbox, 'labels-development.json'), '{}'); await writeFile(join(inbox, 'labels-development.json.sha256'), `${'0'.repeat(64)}  labels-development.json\n`);
  const bad = await t.lab();
  assert.equal(bad.code, 3);
  assert.deepEqual(await t.read('state', CURRENT, 'outcome.json'), { outcome: 'waiting', reason: 'labels-checksum' });
  assert.ok(!(await t.status()).some((line) => line.startsWith('decide ok')));

  // 1. development: a spent usage window stops the operator before anything is uploaded; the same command after the reset goes through.
  const spent = await t.operator([CURRENT], { FAKE_CLAUDE_MODE: 'quota' });
  assert.equal(spent.code, 2);
  assert.match(spent.stderr, /run again after the reset/);
  assert.ok(!spent.stderr.includes('LEAK') && !spent.stdout.includes('LEAK'));
  assert.match(await readFile(join(inbox, 'calibration.json'), 'utf8'), /^\{"qualification"/, 'nothing was uploaded over the old files');
  const first = await t.operator([CURRENT]);
  ok(first, 'operator development');
  assert.match(first.stderr, /the lab waits for the development labels/);
  assert.match(first.stderr, /calibration: claude-sonnet-5-5 medium: kappa 1,/);
  const sshLog = await t.ssh();
  assert.ok(sshLog.some((line) => /sudo tail -n 1 .*\/state\/.*\/STATUS/.test(line)), 'the phase is read from the lab\'s status');
  assert.ok(sshLog.some((line) => line.includes('systemctl start --no-block evimed-rsi-campaign.service')) && sshLog.includes('lab exit 0'));
  assert.ok(sshLog.every((line) => !/sudo (rm|mv|chmod|tee) (?!.*\.part)/.test(line.split(' :: ')[1] ?? '')), 'the lab outbox is only read');
  // The jury: the box's CLI, the pinned model at the measured effort, no tools, and no provider variable in its environment.
  const calls = await t.claude();
  assert.ok(calls.length > 248, 'the calibration rows and the development items, two passes each');
  assert.ok(calls.every((call) => call.argv.includes('claude-sonnet-5-5') && call.argv[call.argv.indexOf('--effort') + 1] === 'medium' && call.argv[call.argv.indexOf('--tools') + 1] === ''));
  assert.ok(calls.every((call) => call.env.every((name) => !/^(ANTHROPIC_|CLAUDE_CODE_|DEEPSEEK_|DASHSCOPE_)/.test(name) || name === 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')));
  // What was uploaded: the calibration and the development labels, each with a digest that matches.
  assert.deepEqual((await readdir(inbox)).sort(), ['calibration.json', 'calibration.json.sha256', 'labels-development.json', 'labels-development.json.sha256']);
  for (const file of ['calibration.json', 'labels-development.json']) assert.equal((await readFile(join(inbox, `${file}.sha256`), 'utf8')).split('  ')[0], sha(await readFile(join(inbox, file))));
  const calibration = JSON.parse(await readFile(join(inbox, 'calibration.json'), 'utf8')), development = JSON.parse(await readFile(join(inbox, 'labels-development.json'), 'utf8'));
  assert.deepEqual([calibration.qualification.qualified, calibration.model, calibration.effort, calibration.costCny, calibration.costBasis], [true, 'claude-sonnet-5-5', 'medium', 0, 'subscription']);
  assert.deepEqual([development.phase, development.stopped, development.incomplete, development.costBasis, development.exportSha256], ['development', null, 0, 'subscription', (await t.read('state', CURRENT, 'plan.json')).exportSha256]);

  // The lab, started by the operator, verified the digests, decided from development alone and published the confirmation items: and waits again.
  let status = await t.status();
  assert.ok(status.some((line) => line.startsWith('decide ok')) && status.some((line) => line.startsWith('items-confirmation ok')));
  assert.match(status.at(-1), /^wait labels-confirmation /);
  assert.equal((await t.read('state', CURRENT, 'decision.json')).status, 'confirmation-needed');
  assert.ok((await t.ls('outbox', CURRENT)).includes('label-items-confirmation.json'));
  const confirmItems = await t.read('outbox', CURRENT, 'label-items-confirmation.json');
  const plan = await t.read('state', CURRENT, 'plan.json');
  assert.deepEqual(confirmItems.items.map((item) => item.id).sort(), plan.idsByRole.confirmation.slice().sort());

  // 2. confirmation: the calibration is not redone, the cache and the work directory are the same.
  const before = (await t.claude()).length;
  const second = await t.operator([CURRENT]);
  ok(second, 'operator confirmation');
  assert.match(second.stderr, /the lab waits for the confirmation labels/);
  const after = await t.claude();
  assert.ok(after.length > before && after.slice(before).every((call) => !call.stdin.includes('Row dev-')), 'only confirmation items were sent');
  assert.deepEqual((await readdir(inbox)).sort(), ['calibration.json', 'calibration.json.sha256', 'labels-confirmation.json', 'labels-confirmation.json.sha256', 'labels-development.json', 'labels-development.json.sha256']);

  // The lab merged the two phases, built the campaign from them and ran to the (stubbed) runner.
  status = await t.status();
  assert.deepEqual(status.filter((line) => /^(merge|build|run) ok/.test(line)).map((line) => line.split(' ')[0]), ['merge', 'build', 'run']);
  const merged = await t.read('state', CURRENT, 'labels.json');
  assert.deepEqual([merged.phase, merged.costCny, merged.costBasis, merged.model, merged.effort], ['all', 0, 'subscription', 'claude-sonnet-5-5', 'medium']);
  assert.equal(merged.labelled, plan.ids.length);
  const manifest = await t.read('state', CURRENT, 'manifest.json');
  assert.deepEqual(rsiCampaignIssues(manifest), []);
  assert.equal(manifest.target.baselineRevision, INCUMBENT.revisionId, 'the baseline is the incumbent identity production exported');
  assert.deepEqual(manifest.models.judges, [{ role: 'jury', provider: 'anthropic', model: 'claude-sonnet-5-5', id: calibration.juryVersion }]);
  assert.deepEqual(manifest.models.improvers, []);
  assert.equal((await t.read('state', CURRENT, 'inputs.json')).registration.labelling.effort, 'medium');
  assert.deepEqual(await t.read('state', CURRENT, 'outcome.json'), { outcome: 'not-qualified', reason: 'campaign_stubbed_runner' });
  assert.ok((await t.ls('outbox', CURRENT)).includes('report.md'));
  const scripts = (await t.docker()).map((call) => call.script.split('/').pop());
  assert.deepEqual(scripts.filter((name) => name === 'frontier_assemble.mjs').length, 4, 'plan, decide, merge-labels, build');
  assert.equal(scripts.filter((name) => name === 'frontier_labels.mjs').length, 2, 'the two label-items');
  assert.ok(scripts.includes('run.mjs'));

  // The operator has nothing to answer once the lab has gone on.
  const idle = await t.operator([CURRENT]);
  assert.equal(idle.code, 3);
  assert.match(idle.stderr, /the lab is not waiting for labels/);
});

test('a month whose development finds no candidate never labels, nor opens, its confirmation month', async () => {
  const t = await tree(exportFor(CURRENT, { perfectBaseline: true }));
  ok(await t.lab(), 'lab');
  ok(await t.operator([CURRENT]), 'operator');
  const status = await t.status();
  assert.ok(status.some((line) => line.startsWith('decide ok')));
  assert.ok(!status.some((line) => /^(items-confirmation|merge|build|run) /.test(line)) && !status.some((line) => line.startsWith('wait labels-confirmation')));
  assert.deepEqual(await t.read('state', CURRENT, 'outcome.json'), { outcome: 'not-qualified', reason: 'campaign_no_improving_candidate' });
  const outbox = await t.ls('outbox', CURRENT);
  assert.ok(!outbox.includes('label-items-confirmation.json') && outbox.includes('report.md') && outbox.includes('report.json'));
  const supply = await t.read('state', CURRENT, 'supply.json');
  assert.equal(supply.developmentChoice.frozen, null);
  assert.deepEqual([supply.confirmation.labelled, supply.confirmation.measuredDays], [null, null]);
  // Only development items were ever sent to the jury.
  const sent = await t.claude();
  assert.ok(sent.filter((call) => call.stdin.includes('Row ')).every((call) => call.stdin.includes('Row dev-')));
  assert.ok(sent.some((call) => call.stdin.includes('Row dev-')));
  const idle = await t.operator([CURRENT]);
  assert.equal(idle.code, 3);
  assert.deepEqual((await t.docker()).map((call) => call.script.split('/').pop()).filter((name) => name === 'run.mjs'), []);
});

test('a calibration that does not qualify ends the month before a single item is labelled', async () => {
  const t = await tree(exportFor(CURRENT));
  ok(await t.lab(), 'lab');
  // A jury that calls everything ok against the anchor has no kappa: not qualified.
  const result = await t.operator([CURRENT], { FAKE_CLAUDE_WORTH: 'ok' });
  ok(result, 'operator');
  assert.match(result.stderr, /the calibration does not qualify/);
  const inbox = join(t.root, 'inbox', `frontier-labels-${CURRENT}`);
  assert.deepEqual((await readdir(inbox)).sort(), ['calibration.json', 'calibration.json.sha256']);
  assert.deepEqual(await t.read('state', CURRENT, 'outcome.json'), { outcome: 'not-run', reason: 'campaign_labels_unqualified' });
  assert.equal((await t.read('state', CURRENT, 'refusal.json')).reason, 'campaign_labels_unqualified');
  assert.ok(!(await t.ls('state', CURRENT)).includes('supply.json'), 'a refusal is not a supply');
  assert.ok(!(await t.claude()).some((call) => call.stdin.includes('Row dev-')), 'no item of the month was sent to the jury');
  assert.ok((await t.ls('outbox', CURRENT)).includes('report.md'));
});

test('a rehearsal keeps its own ids and flags through the wait and the restart', async () => {
  const t = await tree(exportFor(CURRENT));
  const dev = shiftMonth(CURRENT, -2), conf = shiftMonth(CURRENT, -1);
  const flags = ['--development-days', `${dev}-01..${dev}-10`, '--confirmation-days', `${conf}-01..${conf}-10`, '--id-prefix', 'rehearsal-'];
  ok(await t.lab([CURRENT, ...flags]), 'lab');
  const key = `rehearsal-${CURRENT}`;
  assert.match((await t.status(key)).at(-1), new RegExp(`^wait labels-development \\S+ ${key}$`));
  ok(await t.operator([CURRENT, '--prefix', 'rehearsal-', '--', ...flags]), 'operator');
  const log = await t.ssh();
  const run = log.find((line) => line.includes('systemd-run'));
  assert.ok(run && run.includes(`--unit=evimed-rsi-labels-${key}-`) && run.includes('/usr/local/lib/evimed-rsi/rsi-lab-monthly.sh') && run.includes(`${CURRENT} ${flags.join(' ')}`), run);
  assert.ok(!log.some((line) => line.includes('systemctl start')));
  assert.ok((await t.status(key)).some((line) => line.startsWith('decide ok')));
  assert.deepEqual((await t.ls('inbox')).filter((name) => name.startsWith('frontier-labels-')), [`frontier-labels-${key}`]);
});

test('the dry runs print what they would do and change nothing', async () => {
  const t = await tree(exportFor(CURRENT));
  const dry = await t.operator([CURRENT, '--dry-run', '--phase', 'development']);
  ok(dry, 'operator dry run');
  assert.match(dry.stderr, /\[dry-run\] ssh evimed-test sudo cat .*label-items-development\.json/);
  assert.match(dry.stderr, /\[dry-run\] node .*frontier_labels\.mjs calibrate/);
  assert.match(dry.stderr, /\[dry-run\] node .*frontier_labels\.mjs label --items/);
  assert.match(dry.stderr, /\[dry-run\] ssh evimed-test sudo \(cat > .*labels-development\.json\.sha256\)/);
  assert.match(dry.stderr, /\[dry-run\] remote sudo systemctl start --no-block evimed-rsi-campaign\.service/);
  assert.deepEqual([await t.ssh(), await t.claude()], [[], []]);
  assert.deepEqual(await readdir(t.work).catch(() => []), []);
  // The lab's own dry run walks the steps against a scratch tree with a docker that prints, up to the first wait, and leaves no scratch behind.
  const tmp = join(t.dir, 'tmp');
  await mkdir(tmp);
  const lab = await execFileAsync('bash', [labScript, CURRENT], { cwd: t.dir, env: { PATH: process.env.PATH, HOME: t.dir, TMPDIR: tmp, RSI_LAB_DRY_RUN: '1' } });
  assert.match(lab.stderr, /\[dry-run\] docker run .* evals\/rsi-campaigns\/frontier_assemble\.mjs plan /);
  assert.match(lab.stderr, /wait labels-development/);
  assert.deepEqual((await t.ls('state', CURRENT)).length, 0, 'the real tree is untouched');
  assert.deepEqual(await readdir(tmp), [], 'the scratch trees are removed');
  // Against a real tree (RSI_LAB_ROOT) a dry run reads its inbox and writes nothing in it: no STATUS line, no outcome, no log, no link.
  ok(await t.lab(), 'the real run, up to its wait');
  const before = await readFile(join(t.root, 'state', CURRENT, 'STATUS'), 'utf8');
  const listing = await t.ls('state', CURRENT);
  await symlink('elsewhere', join(t.root, 'state', 'current-probe'));
  const real = await execFileAsync('bash', [labScript, CURRENT], { cwd: t.dir, env: { PATH: process.env.PATH, HOME: t.dir, TMPDIR: tmp, RSI_LAB_DRY_RUN: '1', RSI_LAB_ROOT: t.root, RSI_LAB_ETC: join(t.dir, 'etc') } });
  assert.match(real.stderr, /\[dry-run\] docker run .*lab_bootstrap\.mjs/, 'it walks the steps from the start');
  assert.equal(await readFile(join(t.root, 'state', CURRENT, 'STATUS'), 'utf8'), before, 'no bootstrap ok or plan ok written into the real STATUS');
  assert.deepEqual(await t.ls('state', CURRENT), listing);
  assert.equal(await readlink(join(t.root, 'state', 'current')), CURRENT, 'the link the evaluator reads is the real run\'s');
  assert.deepEqual(await readdir(tmp), []);
  // The harness and skill scripts' dry runs leave nothing behind either.
  for (const [script, args] of [['rsi-lab-harness.sh', ['2026-11', 'medcalc', 'develop']], ['rsi-lab-skill.sh', ['2026-11', 'run']]]) {
    const done = await execFileAsync('bash', [join(repo, 'deploy/rsi-campaign', script), ...args], { cwd: t.dir, env: { PATH: process.env.PATH, HOME: t.dir, TMPDIR: tmp, RSI_LAB_DRY_RUN: '1' } }).catch((error) => error);
    assert.equal(done.code, 3, `${script}: no inputs in its own scratch inbox`);
    assert.deepEqual(await readdir(tmp), [], `${script} removed its scratch trees`);
  }
});

/** Holds `lock` (flock) in another process until the returned function releases it. @param {string} lock */
async function holdLock(lock) {
  const holder = spawn('bash', ['-c', 'exec 8>"$1"; flock 8; echo locked; exec sleep 60', 'hold', lock], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((resolve) => holder.stdout.once('data', resolve));
  return () => { holder.kill('SIGKILL'); return new Promise((resolve) => holder.once('exit', resolve)); };
}

test('a second run started while a month holds the lock changes nothing: no directory, no moved link, exit 75', async () => {
  const t = await tree(exportFor(CURRENT));
  await symlink(CURRENT, join(t.root, 'state', 'current'));
  const release = await holdLock(join(t.root, 'state', 'monthly.lock'));
  try {
    const dev = shiftMonth(CURRENT, -2), conf = shiftMonth(CURRENT, -1);
    const rehearsal = await t.lab([CURRENT, '--development-days', `${dev}-01..${dev}-10`, '--confirmation-days', `${conf}-01..${conf}-10`, '--id-prefix', 'rehearsal-']);
    assert.equal(rehearsal.code, 75);
    const other = await t.lab([shiftMonth(CURRENT, 1)]);
    assert.equal(other.code, 75);
    assert.equal(await readlink(join(t.root, 'state', 'current')), CURRENT, 'the receipt path still points at the month that holds the lock');
    assert.deepEqual((await t.ls('state')).sort(), ['current', 'monthly.lock']);
    assert.deepEqual(await t.ls('outbox'), []);
  } finally { await release(); }
  // The skill campaign's link is held the same way.
  await symlink('skill-2026-10', join(t.root, 'state', 'skill-current'));
  const skill = join(repo, 'deploy/rsi-campaign/rsi-lab-skill.sh');
  const releaseSkill = await holdLock(join(t.root, 'state', 'skill.lock'));
  try {
    const held = await execFileAsync('bash', [skill, '2026-11', 'run'], { cwd: t.dir, env: t.env }).catch((error) => error);
    assert.equal(held.code, 75);
    assert.equal(await readlink(join(t.root, 'state', 'skill-current')), 'skill-2026-10');
    assert.ok(!(await t.ls('state')).includes('skill-2026-11'));
  } finally { await releaseSkill(); }
  const free = await execFileAsync('bash', [skill, '2026-11', 'run'], { cwd: t.dir, env: t.env }).catch((error) => error);
  assert.equal(free.code, 3, 'with the lock free it runs (and waits for inputs it does not have)');
  assert.equal(await readlink(join(t.root, 'state', 'skill-current')), 'skill-2026-11');
});

test('the rehearsal prefix is checked before it names a path: only rehearsal-[<a-z0-9->-], from --id-prefix', async () => {
  const t = await tree(exportFor(CURRENT));
  for (const prefix of ['rehearsal-../../escape-', 'rehearsal-a b-', 'prod-', 'rehearsal-X-', 'rehearsal-x']) {
    const result = await t.lab([CURRENT, '--id-prefix', prefix]);
    assert.equal(result.code, 2, prefix);
    assert.match(result.stderr, /id prefix is a rehearsal's/);
  }
  assert.deepEqual(await t.ls('state'), [], 'nothing was created, not even the lock');
  ok(await t.lab([CURRENT, '--id-prefix=rehearsal-b2-']), 'the = form');
  assert.ok((await t.ls('state')).includes(`rehearsal-b2-${CURRENT}`));
  for (const args of [[CURRENT, '--prefix', 'rehearsal-../'], [CURRENT, '--prefix', 'rehearsal-', '--', '--id-prefix', 'rehearsal-b2-']]) {
    const result = await t.operator(args);
    assert.equal(result.code, 2, args.join(' '));
  }
});

test('the operator restarts a rehearsal as the rehearsal, with or without its flags, and its flags reach the lab as arguments, never as commands', async () => {
  const t = await tree(exportFor(CURRENT));
  const dev = shiftMonth(CURRENT, -2), conf = shiftMonth(CURRENT, -1);
  const flags = ['--development-days', `${dev}-01..${dev}-10`, '--confirmation-days', `${conf}-01..${conf}-10`, '--id-prefix', 'rehearsal-'];
  ok(await t.lab([CURRENT, ...flags]), 'lab');
  const key = `rehearsal-${CURRENT}`;
  // --prefix alone: the lab is started for the rehearsal, never for the real month
  ok(await t.operator([CURRENT, '--prefix', 'rehearsal-']), 'operator');
  const run = (await t.ssh()).find((line) => line.includes('systemd-run'));
  assert.ok(run.endsWith(`rsi-lab-monthly.sh ${CURRENT} --id-prefix rehearsal-`), run);
  assert.ok((await t.status(key)).some((line) => line.startsWith('decide ok')));
  assert.deepEqual(await t.status(CURRENT), [], 'the real month was not started');
  assert.ok(!(await t.ls('state')).includes(CURRENT));
  // a flag value with shell syntax is one argument on the lab's root shell
  const marker = join(t.dir, 'MARKER');
  const hostile = [...flags.slice(0, 3), `${conf}-10;touch ${marker}`, ...flags.slice(4)];
  ok(await t.operator([CURRENT, '--phase', 'confirmation', '--', ...hostile]), 'operator with a hostile flag');
  // the remote command line as sent: the value quoted for the shell (printf %q), and the lab received it as one argument
  const sent = (await t.ssh()).filter((line) => line.includes(' :: sudo systemd-run')).at(-1);
  assert.ok(sent.includes(` --confirmation-days ${conf}-10\\;touch\\ ${marker} --id-prefix rehearsal-`), sent);
  await assert.rejects(readFile(marker), 'no command ran');
  assert.ok((await t.status(key)).some((line) => line.startsWith('merge ok')), 'the lab went on with the rehearsal');
});

test('a month begun before 2026-11-03 is refused as it is: nothing in it changes, its signed report stays', async () => {
  const t = await tree(exportFor(CURRENT));
  const dir = join(t.root, 'state', CURRENT);
  await mkdir(dir, { recursive: true });
  const files = { STATUS: 'export ok 2026-11-01T00:00:00Z\nbootstrap ok 2026-11-01T00:00:01Z\nplan ok 2026-11-01T00:00:02Z\nids ok 2026-11-01T00:00:03Z\ncalibrate ok 2026-11-01T00:00:04Z\n',
    'plan.json': JSON.stringify({ month: CURRENT, ids: ['1'] }), 'report.signed.json': '{"signed":true}', 'report.md': '# signed\n' };
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  for (const variant of ['legacy steps', 'a plan without idsByRole']) {
    if (variant === 'a plan without idsByRole') await writeFile(join(dir, 'STATUS'), (files.STATUS = 'export ok 2026-11-01T00:00:00Z\nplan ok 2026-11-01T00:00:02Z\n'));
    const result = await t.lab();
    assert.equal(result.code, 5, variant);
    assert.match(result.stderr, /campaign_run_directory_legacy/);
    assert.deepEqual((await readdir(dir)).sort(), Object.keys(files).sort(), variant);
    for (const [name, text] of Object.entries(files)) assert.equal(await readFile(join(dir, name), 'utf8'), text, `${variant}: ${name}`);
    assert.ok(!(await t.ls('state')).includes('current'), 'the receipt link was not moved to it');
    assert.equal((await t.docker()).length, 0);
  }
});

/** A run directory that has reached its receipt (every earlier step marked), for a resume the stubbed runner refuses. */
async function atResume(t, dir, steps, files = {}) {
  await mkdir(join(dir, 'run'), { recursive: true });
  await writeFile(join(dir, 'STATUS'), steps.map((step) => `${step} ok 2026-11-03T00:00:00Z\n`).join(''));
  await writeFile(join(dir, 'run', 'run.json'), JSON.stringify({ status: 'awaiting-evaluation' }));
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
}

test('a resume that fails ends the run with exit 9 and no report in the monthly, harness and skill campaigns', async () => {
  const t = await tree(exportFor(CURRENT));
  const refuse = { ...t.env, FAKE_RESUME_EXIT: '2' };
  const reported = async () => (await t.docker()).filter((call) => /_report\.mjs$|monthly_report\.mjs$/.test(call.script) || (call.script.endsWith('evaluator.mjs') && call.args[0] === 'report'));
  // the month: through merge, build, run, checkpoint and receipt
  const month = join(t.root, 'state', CURRENT);
  await atResume(t, month, ['export', 'bootstrap', 'plan', 'items-development', 'decide', 'items-confirmation', 'merge', 'build', 'run', 'checkpoint', 'receipt'],
    { 'plan.json': JSON.stringify({ idsByRole: { development: [], confirmation: [] } }), 'decision.json': JSON.stringify({ status: 'confirmation-needed' }), 'manifest.json': '{}',
      'label-items-development.json': '{}', 'label-items-confirmation.json': '{}' });
  const monthly = await execFileAsync('bash', [labScript, CURRENT], { cwd: t.dir, env: refuse }).catch((error) => error);
  assert.equal(monthly.code, 9, monthly.stderr);
  assert.match(monthly.stderr, /resume failed \(campaign_stubbed_resume_refused\): no verdict and no report/);
  assert.ok(!(await readdir(month)).some((name) => name.startsWith('report')), 'no report claims a verdict');
  assert.ok(!(await t.ls('outbox', CURRENT)).some((name) => name.startsWith('report')));
  assert.ok(!(await t.status()).some((line) => line.startsWith('resume ok')), 'the resume is not marked done: the next start asks again');
  // the harness family and the skill month
  const harness = join(t.root, 'state', 'harness-medcalc-2026-11'), skill = join(t.root, 'state', 'skill-2026-11');
  await atResume(t, harness, ['inputs', 'bootstrap', 'assemble', 'run', 'checkpoint', 'receipt']);
  await mkdir(join(t.root, 'inbox', 'skill-2026-11'), { recursive: true });
  await writeFile(join(t.root, 'inbox', 'skill-2026-11', 'registration.json'), JSON.stringify({ failureCalculators: [2] }));
  await atResume(t, skill, ['inputs', 'assemble', 'run', 'checkpoint', 'receipt']);
  for (const [script, args, dir] of [['rsi-lab-harness.sh', ['2026-11', 'medcalc', 'run'], harness], ['rsi-lab-skill.sh', ['2026-11', 'run'], skill]]) {
    const result = await execFileAsync('bash', [join(repo, 'deploy/rsi-campaign', script), ...args], { cwd: t.dir, env: refuse }).catch((error) => error);
    assert.equal(result.code, 9, `${script}: ${result.stderr}`);
    assert.match(result.stderr, /resume failed: no verdict and no report/);
    assert.ok(!(await readdir(dir)).some((name) => name.startsWith('report')), script);
  }
  assert.deepEqual(await reported(), [], 'no report step ran, and nothing was signed as one');
  assert.deepEqual((await t.ls('outbox')).filter((name) => name !== CURRENT).flatMap(() => []), []);
});

test('the scripts take no more than they should: month, phase, model and prefix are checked before anything runs', async () => {
  const t = await tree(exportFor(CURRENT));
  for (const args of [['2026-1'], [CURRENT, '--model', 'qwen3.8-max'], [CURRENT, '--model', 'gpt-5'], [CURRENT, '--phase', 'all'], [CURRENT, '--prefix', 'prod-'], [CURRENT, '--bogus']]) {
    const result = await t.operator(args);
    assert.equal(result.code, 2, args.join(' '));
  }
  assert.deepEqual(await t.ssh(), []);
  const lab = await t.lab(['October']);
  assert.equal(lab.code, 2);
});

test('nothing the lab runs names a provider credential, a Qwen model or the retired improver; the skill script has the one command', async () => {
  const deploy = join(repo, 'deploy/rsi-campaign');
  for (const file of ['rsi-lab-monthly.sh', 'rsi-lab-skill.sh', 'rsi-lab-harness.sh', 'rsi-lab-install.sh', 'config.example.json', 'Dockerfile']) {
    const text = await readFile(join(deploy, file), 'utf8');
    assert.ok(!/dashscope|qwen|DEEPSEEK_API|credentials\//i.test(text.replace(/^\s*#.*$/gm, '')), `${file} names a provider credential or a Qwen model`);
  }
  assert.deepEqual((await readdir(join(repo, 'evals/rsi-campaigns'))).filter((name) => /improver/.test(name)), [], 'the retired improver is gone');
  const skill = await readFile(join(deploy, 'rsi-lab-skill.sh'), 'utf8');
  assert.ok(!/improve2?\b/.test(skill.replace(/^\s*#.*$/gm, '').replace(/the improver is gone/g, '')), 'no improve step');
  const install = await readFile(join(deploy, 'rsi-lab-install.sh'), 'utf8');
  assert.ok(!/providers/.test(install.replace(/^\s*#.*$/gm, '')), 'the lab configuration the installer writes names no provider');
  const config = JSON.parse(await readFile(join(deploy, 'config.example.json'), 'utf8'));
  assert.deepEqual(Object.keys(config), ['host', 'transport', 'signer', 'authority', 'budget']);
  // Idempotent install: the owner inputs are rewritten, not appended to.
  assert.ok(!/>>\s*\$O\//.test(install));
});

test('the harness script requires its improvement record and always passes it', async () => {
  const script = await readFile(join(repo, 'deploy/rsi-campaign/rsi-lab-harness.sh'), 'utf8');
  assert.match(script, /local files=\(registration\.json development\.json improvement\.json\)/);
  assert.match(script, /^VERDICTS\+=\(--improvement "\$IN\/improvement\.json"\)$/m);
  assert.ok(!/\[ -s "\$INBOX\/\$NAME\/improvement\.json" \]/.test(script), 'no longer optional');
  // Without it the inputs are missing: the run stops before the assembly, in the lab\'s own dry-run tree.
  const dir = await mkdtemp(join(tmpdir(), 'rsi-harness-'));
  scratch.push(dir);
  const root = join(dir, 'lab'), etc = join(dir, 'etc');
  await mkdir(join(root, 'inbox', 'harness-medcalc-2026-11'), { recursive: true }); await mkdir(etc, { recursive: true });
  const folder = join(root, 'inbox', 'harness-medcalc-2026-11');
  for (const name of ['registration.json', 'development.json']) {
    const bytes = Buffer.from(JSON.stringify({ scorer: 'medcalc' }));
    await writeFile(join(folder, name), bytes); await writeFile(join(folder, `${name}.sha256`), `${sha(bytes)}  ${name}\n`);
  }
  const result = await execFileAsync('bash', [join(repo, 'deploy/rsi-campaign/rsi-lab-harness.sh'), '2026-11', 'medcalc', 'develop'], { env: { PATH: process.env.PATH, RSI_LAB_DRY_RUN: '1', RSI_LAB_ROOT: root, RSI_LAB_ETC: etc } }).catch((error) => error);
  assert.equal(result.code, 3);
  assert.match(result.stderr, /inputs missing or checksum mismatch/);
  const bytes = Buffer.from(JSON.stringify({ improvers: [{ role: 'lead', provider: 'anthropic', model: 'claude-opus-5-5' }] }));
  await writeFile(join(folder, 'improvement.json'), bytes); await writeFile(join(folder, 'improvement.json.sha256'), `${sha(bytes)}  improvement.json\n`);
  const complete = await execFileAsync('bash', [join(repo, 'deploy/rsi-campaign/rsi-lab-harness.sh'), '2026-11', 'medcalc', 'develop'], { env: { PATH: process.env.PATH, RSI_LAB_DRY_RUN: '1', RSI_LAB_ROOT: root, RSI_LAB_ETC: etc } }).catch((error) => error);
  assert.match(complete.stderr, /\[dry-run\] docker run .*harness_assemble\.mjs --development-only --development \/srv\/rsi-lab\/inbox\/harness-medcalc-2026-11\/development\.json --improvement \/srv\/rsi-lab\/inbox\/harness-medcalc-2026-11\/improvement\.json/);
});

test('an export from before the incumbent identity does not stop the month: it is measured against an unbound baseline, reported as not importable', async () => {
  const document = exportFor(CURRENT);
  delete document.incumbent;
  const t = await tree(document);
  ok(await t.lab(), 'lab');
  assert.equal((await t.read('state', CURRENT, 'plan.json')).incumbent, null);
  assert.match((await t.status()).at(-1), /^wait labels-development /, 'the same wait as with an incumbent: the operator labels the same rows');
  ok(await t.operator([CURRENT]), 'operator development');
  ok(await t.operator([CURRENT]), 'operator confirmation');
  const status = await t.status();
  assert.deepEqual(status.filter((line) => /^(decide|merge|build|run) ok/.test(line)).map((line) => line.split(' ')[0]), ['decide', 'merge', 'build', 'run']);
  const manifest = await t.read('state', CURRENT, 'manifest.json');
  assert.deepEqual(rsiCampaignIssues(manifest), []);
  assert.equal(manifest.target.baselineRevision, 'unbound:release-flow.1');
  assert.equal((await t.read('state', CURRENT, 'supply.json')).incumbent, null);
  assert.deepEqual(await t.read('state', CURRENT, 'outcome.json'), { outcome: 'not-qualified', reason: 'campaign_stubbed_runner' });
  const report = await t.read('outbox', CURRENT, 'report.json');
  assert.equal(report.baselineBound, false);
  const text = await readFile(join(t.root, 'outbox', CURRENT, 'report.md'), 'utf8');
  assert.equal(text.split('\n').filter((line) => line.includes('生产导出缺少基线身份，本月结论只作实验机参考，不能导入')).length, 1, 'said once, in one line');
  assert.ok(!/null|undefined/.test(text), 'no raw null in the report');
});

test('a month with no candidate from development and no incumbent ends there and still says the export carried no baseline', async () => {
  const document = exportFor(CURRENT, { perfectBaseline: true });
  delete document.incumbent;
  const t = await tree(document);
  ok(await t.lab(), 'lab');
  ok(await t.operator([CURRENT]), 'operator');
  assert.deepEqual(await t.read('state', CURRENT, 'outcome.json'), { outcome: 'not-qualified', reason: 'campaign_no_improving_candidate' });
  const text = await readFile(join(t.root, 'outbox', CURRENT, 'report.md'), 'utf8');
  assert.match(text, /- 生产导出缺少基线身份，本月结论只作实验机参考，不能导入/);
  assert.match(text, /确认期 \d+ 天（可测 未标注，最少 25）/, 'confirmation was never labelled: unknown, not null');
  assert.ok(!/null|undefined/.test(text));
});

test('an incumbent the export carries but that is malformed ends the month at the plan, by its closed reason, before anything is asked of the operator', async () => {
  const document = exportFor(CURRENT);
  document.incumbent = { revisionId: 'threshold-64-release-flow.1', threshold: BASELINE };
  const t = await tree(document);
  const result = await t.lab();
  assert.equal(result.code, 4);
  assert.deepEqual(await t.read('state', CURRENT, 'outcome.json'), { outcome: 'not-run', reason: 'campaign_export_incumbent_invalid' });
  assert.ok(!(await t.ls('outbox', CURRENT)).includes('label-items-development.json'));
  assert.ok((await t.ls('outbox', CURRENT)).includes('report.md'), 'the report says why');
  assert.equal((await t.claude()).length, 0);
});
