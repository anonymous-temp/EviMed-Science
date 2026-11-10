// The bundle's way from the lab to the serving host, as scripts and units, with nothing run on a host: the real monthly script publishes against the stand-in docker
// (fixtures/fake_docker.mjs), the real installer writes the channel and the deployment records with stand-ins for ssh, scp, sudo, systemd and docker, and the real pull
// crosses the real `rrsync -ro` of the authorized_keys line it wrote, with a stand-in playing sshd's part (run the forced command, hand it the client's). No network, no host.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { accessSync, constants } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { computeRsiDependencyClosure } from '../../../apps/server/src/rsiDependencyClosure.mjs';
import { rsiClosureSettings } from '../../../apps/server/src/rsiClosureSettings.mjs';
import { createRsiDirectoryTransport } from '../../../apps/server/src/rsiDirectoryTransport.mjs';
import { createRsiTrustRegistry, validateRsiActivationPolicies } from '../../../apps/server/src/rsiDeploymentAuthority.mjs';
import { rsiOnlineConfigurationIssues } from '../../../apps/server/src/rsiOnlineConfiguration.mjs';

const run = promisify(execFile);
const repo = new URL('../../../', import.meta.url).pathname;
const fixtures = new URL('./fixtures/', import.meta.url).pathname;
const deploy = join(repo, 'deploy/rsi-campaign');
const labScript = join(deploy, 'rsi-lab-monthly.sh'), install = join(deploy, 'rsi-lab-install.sh'), pull = join(deploy, 'production/rsi-bundle-pull.sh');
const MONTH = '2026-11';
/** A month measured to its verdict, with nothing signed yet. */
const MEASURED = ['export', 'bootstrap', 'plan', 'calibrate', 'label-development', 'decide', 'label-confirmation', 'merge', 'build', 'run', 'checkpoint', 'receipt', 'resume'];
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const scratch = [];
after(() => Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true }))));
const fresh = async (label) => { const dir = await mkdtemp(join(tmpdir(), `rsi-carrier-${label}-`)); scratch.push(dir); return dir; };
const exec = (command, args, options) => run(command, args, { maxBuffer: 1 << 24, ...options }).catch((error) => error);
const ok = (result, what) => assert.ok(!(result instanceof Error), `${what}: ${result.stderr ?? result.message}`);
const mode = async (path) => (await stat(path)).mode & 0o777;

let rrsyncPath = null;
for (const candidate of ['/usr/bin/rrsync', '/usr/local/bin/rrsync', '/usr/share/doc/rsync/scripts/rrsync']) { try { accessSync(candidate, constants.X_OK); rrsyncPath = candidate; break; } catch { /* the next place */ } }
const withRrsync = { skip: !rrsyncPath && 'rrsync is not installed' };

/** A lab's tree with the month at the point the monthly script decides what a qualified verdict publishes: every earlier step marked, `steps` overriding the list. */
async function month({ qualification = 'qualified', bundle = '{"schemaVersion":1,"keyId":"publisher","payload":"signed"}\n', steps, prefix = '', baseline = `default:${'a'.repeat(64)}` } = {}) {
  const dir = await fresh('month');
  const root = join(dir, 'lab'), etc = join(dir, 'etc'), bin = join(dir, 'bin'), key = `${prefix}${MONTH}`, state = join(root, 'state', key);
  for (const path of [join(state, 'run'), join(root, 'inbox'), join(root, 'outbox'), join(etc, 'secrets'), join(etc, 'owner-inputs'), join(etc, 'keys'), bin]) await mkdir(path, { recursive: true });
  await writeFile(join(etc, 'image'), 'evimed-rsi-lab:test\n');
  await writeFile(join(etc, 'secrets', 'lab.env'), 'RSI_LAB_DATABASE_URL=postgres://unused\n');
  await symlink(join(fixtures, 'fake_docker.sh'), join(bin, 'fake-docker'));
  const marked = steps ?? ['export', 'bootstrap', 'plan', 'calibrate', 'label-development', 'decide', 'label-confirmation', 'merge', 'build', 'run', 'checkpoint', 'receipt', 'resume', 'evidence', 'finalize'];
  await writeFile(join(state, 'STATUS'), marked.map((step) => `${step} ok 2026-11-01T00:00:00Z\n`).join(''));
  const files = { 'plan.json': { idsByRole: { development: [], confirmation: [] } }, 'decision.json': { status: 'confirmation-needed' }, 'calibration.json': { qualification: { qualified: true } }, 'manifest.json': { id: 'frontier-selection', deadline: '2026-11-30T16:00:00.000Z', target: { baselineRevision: baseline } }, 'inputs.json': {},
    'run/run.json': { status: 'awaiting-evaluation' }, 'run/resume.json': { status: 'completed', qualification, checkpoint: { campaignId: 'frontier-selection' } } };
  for (const [name, value] of Object.entries(files)) await writeFile(join(state, name), JSON.stringify(value));
  if (bundle) await writeFile(join(state, 'bundle.json'), bundle);
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: dir, TMPDIR: dir, RSI_LAB_ROOT: root, RSI_LAB_ETC: etc, RSI_LAB_DOCKER: join(bin, 'fake-docker'), RSI_LAB_OWNER: `${process.getuid()}:${process.getgid()}`, RSI_LAB_POLL_SECONDS: '0',
    FAKE_DOCKER_REPO: repo, FAKE_DOCKER_LOG: join(dir, 'docker.jsonl') };
  return { root, state, env, bundles: join(root, 'outbox', 'bundles'), bundle, lab: (args = [MONTH], over = {}) => exec('bash', [labScript, ...args], { cwd: dir, env: { ...env, ...over } }) };
}

test('a qualified month publishes its bundle under the name of its bytes, whole, once: a restart changes nothing, and the month\'s own directory stays the lab\'s', async () => {
  const t = await month();
  ok(await t.lab(), 'lab');
  const name = `${sha(t.bundle)}.json`;
  assert.deepEqual(await readdir(t.bundles), [name], 'no hidden temporary name is left');
  assert.equal(await readFile(join(t.bundles, name), 'utf8'), t.bundle);
  assert.deepEqual([await mode(t.bundles), await mode(join(t.bundles, name))], [0o755, 0o644], 'the channel\'s account reads the bundle');
  assert.equal(await readFile(join(t.root, 'outbox', MONTH, 'bundle.json'), 'utf8'), t.bundle, 'the month keeps its own copy');
  assert.equal(await mode(join(t.root, 'outbox', MONTH)), 0o750);
  const before = await stat(join(t.bundles, name));
  await chmod(join(t.bundles, name), 0o444);
  const again = await t.lab();
  ok(again, 'the month again');
  assert.match(again.stderr, new RegExp(`bundle published: outbox/bundles/${name}`));
  assert.equal((await stat(join(t.bundles, name))).ino, before.ino, 'the file already there is not rewritten');
  assert.deepEqual(await readdir(t.bundles), [name]);
});

test('a refused finalize is seen: an outcome of its own, a failed unit, a report that says so, and the next start signs the evidence anew and publishes', async () => {
  const bytes = '{"schemaVersion":1,"keyId":"publisher","payload":"signed"}\n';
  const t = await month({ bundle: null, steps: MEASURED });
  const refused = await t.lab([MONTH], { FAKE_FINALIZE: 'refuse:campaign_statistics_timeout' });
  assert.equal(refused.code, 8, refused.stderr);
  assert.deepEqual(JSON.parse(await readFile(join(t.state, 'outcome.json'), 'utf8')), { outcome: 'finalize-refused', reason: 'campaign_statistics_timeout' });
  await assert.rejects(readdir(t.bundles), { code: 'ENOENT' });
  const status = await readFile(join(t.state, 'STATUS'), 'utf8');
  assert.ok(!/^(evidence|finalize) ok/m.test(status), 'neither is done: the evidence is signed for a week, and the next start signs it anew');
  const report = JSON.parse(await readFile(join(t.state, 'report.json'), 'utf8'));
  assert.deepEqual([report.outcome, report.reason, report.published, report.releaseEligible], ['finalize-refused', 'campaign_statistics_timeout', null, false]);
  const text = await readFile(join(t.state, 'report.md'), 'utf8');
  assert.match(text, /候选通过统计，但定稿被拒，本月尚未发布/);
  assert.match(text, /campaign_statistics_timeout/);
  assert.ok(!text.includes('已发布 bundle'));
  // The next start: the evidence again, then the signature, then the bundle, and the report says what went out.
  const evidenceCalls = async () => (await readFile(t.env.FAKE_DOCKER_LOG, 'utf8')).split('\n').filter((line) => line.includes('evaluator.mjs') && line.includes('"evidence"')).length;
  assert.equal(await evidenceCalls(), 1);
  const recovered = await t.lab([MONTH], { FAKE_FINALIZE: `sign:${bytes}` });
  ok(recovered, 'the next start');
  assert.equal(await evidenceCalls(), 2, 'the evidence was signed again');
  assert.deepEqual(JSON.parse(await readFile(join(t.state, 'outcome.json'), 'utf8')).outcome, 'qualified');
  const digest = sha(bytes);
  assert.deepEqual(await readdir(t.bundles), [`${digest}.json`]);
  const signed = JSON.parse(await readFile(join(t.state, 'report.json'), 'utf8'));
  assert.deepEqual([signed.outcome, signed.published, signed.releaseEligible], ['qualified', { bundleSha256: digest, path: `outbox/bundles/${digest}.json` }, true]);
  const said = await readFile(join(t.state, 'report.md'), 'utf8');
  assert.ok(said.includes(digest), 'the report names the digest');
  assert.match(said, /生产只有安装了导入层才会取走它/);
  assert.ok(!/仅实验机|未导入生产|不向生产导入/.test(said), 'and no longer says the opposite');
});

test('nothing else is published: no verdict, a refused finalize, a rehearsal, a month the export says cannot be imported', async () => {
  const notQualified = await month({ qualification: 'not-qualified' });
  ok(await notQualified.lab(), 'not qualified');
  await assert.rejects(readdir(notQualified.bundles), { code: 'ENOENT' });
  // Measured against no baseline, or another consumer: the verdict stands, no signature is asked for, and the month ended as designed.
  for (const [baseline, reason] of [['unbound-consumer:release-1', 'campaign_export_consumer_changed'], ['unbound:release-1', 'campaign_export_incumbent_missing']]) {
    const unbound = await month({ steps: MEASURED, baseline });
    ok(await unbound.lab(), reason);
    await assert.rejects(readdir(unbound.bundles), { code: 'ENOENT' });
    assert.deepEqual(JSON.parse(await readFile(join(unbound.state, 'outcome.json'), 'utf8')), { outcome: 'not-importable', reason });
    assert.ok(!(await readFile(join(unbound.state, 'STATUS'), 'utf8')).includes('evidence ok'), 'nothing to sign');
    assert.match(await readFile(join(unbound.state, 'report.md'), 'utf8'), /候选通过统计，但本月不能导入生产/);
  }
  // The real finalize.mjs under the stand-in refuses a path that is not the owner's mount: no bundle.json, so nothing to publish.
  const refused = await month({ bundle: null, steps: MEASURED });
  const result = await refused.lab();
  assert.equal(result.code, 8, 'the timer shows it failed');
  assert.match(result.stderr, /finalize refused/);
  await assert.rejects(readdir(refused.bundles), { code: 'ENOENT' });
  // A rehearsal's verdict may read qualified and its bundle is no bundle of production's.
  const rehearsal = await month({ prefix: 'rehearsal-' });
  ok(await rehearsal.lab([MONTH, '--id-prefix', 'rehearsal-']), 'rehearsal');
  await assert.rejects(readdir(rehearsal.bundles), { code: 'ENOENT' });
});

/** What the installer's remote scripts need of a host, as stand-ins on PATH, in one stand-in root (the two hosts' paths do not overlap). */
async function hosts({ consumer = 'c'.repeat(64) } = {}) {
  const dir = await fresh('hosts');
  const root = join(dir, 'root'), bin = join(dir, 'bin'), log = join(dir, 'calls.log');
  for (const path of [bin, join(root, 'tmp')]) await mkdir(path, { recursive: true });
  const stand = async (name, body) => { await writeFile(join(bin, name), `#!/usr/bin/env bash\necho "${name} $*" >> "${log}"\n${body}\n`); await chmod(join(bin, name), 0o755); };
  // ssh runs its command through a shell, as the remote end does; the hosts are told apart only by what the scripts do.
  await stand('ssh', 'shift; exec bash -c "$*"');
  await stand('scp', 'args=("$@"); last=${args[-1]}; dest=${last#*:}; unset "args[-1]"; for arg in "${args[@]}"; do [ "$arg" = -q ] || cp "$arg" "$dest"; done');
  await stand('sudo', 'exec "$@"');
  await stand('id', 'exit 1');
  for (const name of ['useradd', 'usermod', 'chown']) await stand(name, 'exit 0');
  await stand('systemctl', 'exit 0');
  await stand('docker', `cat > /dev/null; echo "\${FAKE_CONSUMER:-${consumer}}"`);
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: dir, RSI_INSTALL_ROOT: root, RSI_PRODUCTION_ADDRESS: '203.0.113.7', RSI_LAB_ADDRESS: '203.0.113.8' };
  return { dir, root, bin, log, env, calls: async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean), install: (mode, over = {}) => exec('bash', [install, mode], { cwd: dir, env: { ...env, ...over } }) };
}

/** The forced command of the channel's authorized_keys line, with a stand-in in sshd's place: no ssh, no network, the real rrsync and the real rsync server. */
async function sshdStandIn(h, authorized) {
  const bin = join(h.dir, 'sshd-bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'ssh'), `#!/usr/bin/env bash
echo "$*" >> "${h.dir}/ssh.log"
while [ $# -gt 0 ]; do case $1 in -i|-o|-l) shift 2 ;; -*) shift ;; *) break ;; esac; done
shift
forced=$(sed -n 's/^command="\\([^"]*\\)".*/\\1/p' "${authorized}")
SSH_ORIGINAL_COMMAND="$*" exec bash -c "$forced"
`);
  await chmod(join(bin, 'ssh'), 0o755);
  return bin;
}

test('the channel: the pull key stays on production, the lab\'s line forces rrsync -ro on the one directory from production\'s address, and a second run is the same line', withRrsync, async () => {
  const h = await hosts();
  await mkdir(join(h.root, 'srv/rsi-lab/outbox'), { recursive: true });
  await chmod(join(h.root, 'srv/rsi-lab/outbox'), 0o750);
  const result = await h.install('channel');
  ok(result, 'channel');
  const key = join(h.root, 'etc/evimed-rsi/pull_ed25519');
  assert.equal(await mode(key), 0o600);
  const publicKey = (await readFile(`${key}.pub`, 'utf8')).trim();
  const authorized = join(h.root, 'home/rsi-outbox/.ssh/authorized_keys');
  const line = await readFile(authorized, 'utf8');
  assert.equal(line, `command="${rrsyncPath} -ro ${join(h.root, 'srv/rsi-lab/outbox/bundles')}",from="203.0.113.7",restrict ${publicKey}\n`);
  assert.equal(await mode(authorized), 0o600);
  assert.equal(await mode(join(h.root, 'home/rsi-outbox/.ssh')), 0o700);
  assert.equal(await mode(join(h.root, 'srv/rsi-lab/outbox/bundles')), 0o755);
  assert.equal(await mode(join(h.root, 'srv/rsi-lab/outbox')) & 0o001, 0o001, 'the account may pass through the outbox to the one directory');
  assert.ok(!(await readFile(authorized, 'utf8')).includes('PRIVATE'));
  assert.ok((await h.calls()).some((call) => call.startsWith('useradd --system') && call.endsWith('rsi-outbox')));
  // Again: the same key, the same line, one line.
  const privateBytes = await readFile(key);
  ok(await h.install('channel'), 'channel again');
  assert.equal(await readFile(authorized, 'utf8'), line);
  assert.deepEqual(await readFile(key), privateBytes);
  assert.deepEqual((await readdir(join(h.root, 'home/rsi-outbox/.ssh'))), ['authorized_keys']);
});

test('the pull crosses the real rrsync -ro: new bundles arrive whole and readable, an existing name is never overwritten, nothing but a bundle comes, and the key can write nothing', withRrsync, async () => {
  const h = await hosts();
  await mkdir(join(h.root, 'srv/rsi-lab/outbox/2026-11'), { recursive: true });
  await writeFile(join(h.root, 'srv/rsi-lab/outbox/2026-11/report.json'), '{"private":"to the lab"}');
  ok(await h.install('channel'), 'channel');
  const outbox = join(h.root, 'srv/rsi-lab/outbox/bundles'), authorized = join(h.root, 'home/rsi-outbox/.ssh/authorized_keys');
  const conf = join(h.root, 'etc/evimed-rsi'), dest = join(h.root, 'var/lib/evimed-rsi/online/bundles');
  await mkdir(dest, { recursive: true });
  await writeFile(join(conf, 'lab-host'), 'lab.example\n');
  const bin = await sshdStandIn(h, authorized);
  const env = { PATH: `${bin}:${process.env.PATH}`, RSI_CONFIG_DIR: conf, RSI_BUNDLE_DIR: dest };
  const pullNow = () => exec('bash', [pull], { cwd: h.dir, env });
  const first = '{"bundle":1}\n', second = '{"bundle":2}\n', firstName = `${sha(first)}.json`, secondName = `${sha(second)}.json`;
  await writeFile(join(outbox, firstName), first, { mode: 0o644 });
  // What is no bundle: a name mid-publish, another file, a link, a directory, and a file over the bound.
  await writeFile(join(outbox, `.${secondName}.tmp`), 'partial');
  await writeFile(join(outbox, 'notes.txt'), 'notes');
  await symlink(join(h.root, 'srv/rsi-lab/outbox/2026-11/report.json'), join(outbox, `${sha('link')}.json`));
  await mkdir(join(outbox, `${sha('directory')}.json`));
  await writeFile(join(outbox, `${sha('large')}.json`), '');
  await truncate(join(outbox, `${sha('large')}.json`), 5 * 1024 * 1024 + 1);
  const pulled = await pullNow();
  ok(pulled, 'pull');
  assert.match(pulled.stdout, /pulled 1 new bundle\(s\) from lab\.example/);
  assert.deepEqual((await readdir(dest)).sort(), [firstName]);
  assert.equal(await mode(join(dest, firstName)), 0o644, 'the web container reads it');
  assert.match(await readFile(join(h.dir, 'ssh.log'), 'utf8'), /-i \S*pull_ed25519 -o UserKnownHostsFile=\S*known_hosts -o StrictHostKeyChecking=yes -o IdentitiesOnly=yes -o BatchMode=yes .*-l rsi-outbox lab\.example rsync --server --sender/);
  // Nothing new: nothing copied. A later bundle comes; the name already here keeps its bytes even when the lab's file changed, and the reader judges those bytes by their name.
  assert.match((await pullNow()).stdout, /pulled 0 new/);
  await writeFile(join(outbox, firstName), 'overwritten at the lab');
  await writeFile(join(outbox, secondName), second, { mode: 0o644 });
  assert.match((await pullNow()).stdout, /pulled 1 new/);
  assert.deepEqual((await readdir(dest)).sort(), [firstName, secondName].sort());
  assert.equal(await readFile(join(dest, firstName), 'utf8'), first);
  const transport = await createRsiDirectoryTransport({ kind: 'directory', role: 'production', path: dest });
  assert.deepEqual((await transport.listBundles()).keys.length, 2);
  assert.equal((await transport.readBundle(sha(second))).bytes.toString(), second);
  // A bundle whose bytes the lab mangled before the pull arrives and is refused where it is read.
  const named = sha('what it promised');
  await writeFile(join(outbox, `${named}.json`), 'what it holds', { mode: 0o644 });
  ok(await pullNow(), 'pull a mangled one');
  await assert.rejects(transport.readBundle(named), { message: 'rsi_oss_object_changed' });
  // The other direction, and everything beside the one directory, are refused by the forced command itself.
  const write = await exec('rsync', ['-e', 'ssh', join(dest, firstName), 'rsi-outbox@lab.example:./planted.json'], { cwd: h.dir, env });
  assert.ok(write instanceof Error, 'a write through the key fails');
  assert.match(write.stderr, /read-only/);
  assert.deepEqual((await readdir(outbox)).filter((name) => name.includes('planted')), []);
  const escape = await exec('rsync', ['-e', 'ssh', 'rsi-outbox@lab.example:../2026-11/report.json', join(h.dir, 'stolen.json')], { cwd: h.dir, env });
  assert.ok(escape instanceof Error, 'a path out of the directory fails');
  assert.match(escape.stderr, /\.\./);
  await assert.rejects(stat(join(h.dir, 'stolen.json')), { code: 'ENOENT' });
});

test('the pull\'s dry run prints the command and changes nothing, and a host that was never installed is told so', async () => {
  const dir = await fresh('pull-dry');
  const dest = join(dir, 'bundles');
  const dry = await exec('bash', [pull], { cwd: dir, env: { PATH: process.env.PATH, RSI_LAB_DRY_RUN: '1', RSI_CONFIG_DIR: join(dir, 'conf'), RSI_BUNDLE_DIR: dest } });
  ok(dry, 'dry');
  assert.match(dry.stderr, /\[dry-run\] rsync -e ssh -i \S+pull_ed25519 .* --ignore-existing .* rsi-outbox@lab\.example:\.\/ \S+bundles\//);
  assert.deepEqual(await readdir(dir), []);
  await mkdir(join(dir, 'conf'));
  await writeFile(join(dir, 'conf', 'lab-host'), 'lab.example\n');
  const missing = await exec('bash', [pull], { cwd: dir, env: { PATH: process.env.PATH, RSI_CONFIG_DIR: join(dir, 'conf'), RSI_BUNDLE_DIR: dest } });
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /run rsi-lab-install\.sh production/);
});

/** What `production` reads on the lab and needs on the serving host. */
async function installedHosts(h, { labConsumer = 'c'.repeat(64) } = {}) {
  const inputs = join(h.root, 'etc/rsi-lab/owner-inputs'), etc = join(h.root, 'etc/evimed-rsi');
  await mkdir(inputs, { recursive: true }); await mkdir(etc, { recursive: true });
  const pem = () => generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
  await writeFile(join(inputs, 'publisher.pub.pem'), pem());
  await writeFile(join(inputs, 'evaluator.pub.pem'), pem());
  await writeFile(join(inputs, 'consumer-digest'), `${labConsumer}\n`);
  await writeFile(join(inputs, 'finalize.json'), JSON.stringify({ publisher: { provider: 'file', keyId: 'rsi-lab-publisher-2026-10', path: '/run/rsi-keys/publisher.pem' }, evaluator: { provider: 'file', keyId: 'rsi-lab-evaluator-2026-10', path: '/run/rsi-keys/evaluator.pem' } }));
  await writeFile(join(inputs, 'finalizer-profile.json'), JSON.stringify({ procedureDigests: ['d'.repeat(64)], qualificationDigests: ['e'.repeat(64)] }));
  await writeFile(join(etc, 'push_ed25519'), 'the push key');
  await writeFile(join(etc, 'pull_ed25519'), 'the pull key');
}

test('`production` installs the pull, its timer and the deployment records the web container verifies by: public identities only, private files, inert until the deployment names the directory', async () => {
  const h = await hosts();
  await installedHosts(h);
  const result = await h.install('production');
  ok(result, 'production');
  const online = join(h.root, 'var/lib/evimed-rsi/online'), lib = join(h.root, 'usr/local/lib/evimed-rsi'), units = join(h.root, 'etc/systemd/system');
  assert.equal(await mode(join(lib, 'rsi-bundle-pull.sh')), 0o755);
  for (const script of ['rsi-frontier-export.mjs', 'rsi-signals-export.mjs']) assert.equal(await mode(join(lib, script)), 0o644, script);
  for (const unit of ['evimed-rsi-bundle-pull.service', 'evimed-rsi-bundle-pull.timer', 'evimed-rsi-frontier-push.service', 'evimed-rsi-frontier-push.timer']) await stat(join(units, unit));
  assert.equal((await readFile(join(h.root, 'etc/evimed-rsi/lab-host'), 'utf8')).trim(), '203.0.113.8');
  assert.deepEqual(await readdir(join(h.root, 'tmp')), [], 'what was copied up is gone');
  assert.ok((await h.calls()).some((call) => call === 'systemctl enable --now evimed-rsi-frontier-push.timer evimed-rsi-bundle-pull.timer'));
  assert.match(result.stdout, /the import is off until the deployment's \.env names OPEN_SCIENCE_RSI_CONFIG_HOST_DIR=\/var\/lib\/evimed-rsi\/online/);
  assert.ok(!/NOTE: the lab image/.test(result.stderr), 'the two consumers agree');
  // The records: the deployment file the runtime accepts, naming the container's paths, and the trust it loads.
  for (const name of ['online.json', 'publisher.json', 'evaluators.json']) assert.equal(await mode(join(online, name)), 0o600, name);
  assert.equal(await mode(join(online, 'bundles')), 0o755);
  const file = JSON.parse(await readFile(join(online, 'online.json'), 'utf8'));
  assert.deepEqual(rsiOnlineConfigurationIssues(file), []);
  assert.deepEqual(file, { schemaVersion: 1, transport: { kind: 'directory', role: 'production', path: '/run/evimed-rsi/bundles' }, trustedKeyRefs: ['/run/evimed-rsi/publisher.json'], evaluatorRegistryRef: '/run/evimed-rsi/evaluators.json' });
  const overlay = await readFile(join(repo, 'deploy/web/docker-compose.rsi.yml'), 'utf8');
  assert.match(overlay, /target: \/run\/evimed-rsi\n\s+read_only: true\n\s+bind:\n\s+create_host_path: false/, 'mounted where the file says, read-only');
  const trust = await createRsiTrustRegistry({ trustedKeyRefs: [join(online, 'publisher.json')], evaluatorRegistryRef: join(online, 'evaluators.json') }, { currentTarget: async () => null });
  assert.equal(trust.registryVersion, 1);
  const registry = JSON.parse(await readFile(join(online, 'evaluators.json'), 'utf8'));
  assert.deepEqual(registry.evaluators[0].consumerDigests, ['c'.repeat(64)], 'the running release\'s digest');
  assert.deepEqual(registry.evaluators[0].procedureDigests, ['d'.repeat(64)]);
  // Shadow first, as the example registry has it: the deployment's activation is that example's, and valid by the server's own rule.
  const example = JSON.parse(await readFile(join(repo, 'deploy/web/rsi-evaluator-registry.example.json'), 'utf8'));
  assert.deepEqual(validateRsiActivationPolicies(registry.activationPolicies), validateRsiActivationPolicies(example.activationPolicies));
  assert.equal(registry.activationPolicies['frontier-selection'].mode, 'shadow');
  const { RSI_FRONTIER_VOLUME_BOUND } = await import('../../../packages/domain/src/rsiCampaign.mjs');
  assert.deepEqual(registry.activationPolicies['frontier-selection'].volumeBound, RSI_FRONTIER_VOLUME_BOUND, 'the installed bound is the one the development choice applied');
  // Module surfaces never reach the importer: a qualified module round is a pull-request proposal.
  assert.deepEqual([Object.keys(registry.activationPolicies), registry.evaluators[0].surfaces, JSON.parse(await readFile(join(online, 'publisher.json'), 'utf8')).surfaces], [['frontier-selection'], ['frontier-selection'], ['frontier-selection']]);
  for (const name of ['online.json', 'publisher.json', 'evaluators.json']) assert.ok(!(await readFile(join(online, name), 'utf8')).includes('PRIVATE'), name);
  for (const entry of await readdir(online)) assert.ok(!/pull_ed25519|push_ed25519/.test(entry), 'no ssh key is where the container can see it');
  // Again: not one byte of the registry changes, or the campaign holding the surface would read as revoked.
  const bytes = await readFile(join(online, 'evaluators.json'));
  ok(await h.install('production'), 'again');
  assert.deepEqual(await readFile(join(online, 'evaluators.json')), bytes);
  // A release that moved the consumer: a new registry version naming it, and it says the lab's image no longer matches.
  const moved = await h.install('production', { FAKE_CONSUMER: 'f'.repeat(64) });
  ok(moved, 'moved');
  assert.match(moved.stderr, new RegExp(`NOTE: the lab image's frontier consumer is ${'c'.repeat(64)} and the serving release's is ${'f'.repeat(64)}`));
  const after = JSON.parse(await readFile(join(online, 'evaluators.json'), 'utf8'));
  assert.deepEqual([after.version, after.evaluators[0].consumerDigests], [2, ['f'.repeat(64)]]);
});

test('`production` runs nothing as root from a name another local user could have taken: its files go to a private directory, and a planted file is never read', async () => {
  const h = await hosts();
  await installedHosts(h);
  const planted = join(h.dir, 'planted-ran');
  await mkdir(join(h.root, 'tmp'), { recursive: true });
  for (const name of ['rsi-online-records.py', 'rsi-consumer-digest.mjs', 'rsi-bundle-pull.sh', 'rsi-frontier-push.sh', 'rsi-frontier-export.mjs']) await writeFile(join(h.root, 'tmp', name), `import os\nopen(${JSON.stringify(planted)}, 'w').write('ran')\n`);
  await writeFile(join(h.root, 'tmp', 'rsi-lab-facts.json'), '{"planted":true}');
  const result = await h.install('production');
  ok(result, 'production');
  await assert.rejects(stat(planted), { code: 'ENOENT' }, 'the planted script never ran');
  const calls = await h.calls();
  const records = calls.find((call) => call.includes('rsi-online-records.py') && call.startsWith('sudo python3'));
  assert.match(records, /^sudo python3 -I \S*\/tmp\/rsi-install\.[A-Za-z0-9]{8,}\/rsi-online-records\.py /);
  const copied = calls.find((call) => call.startsWith('scp '));
  assert.match(copied, /:\S*\/tmp\/rsi-install\.[A-Za-z0-9]{8,}\/$/, 'the destination is the private directory');
  assert.ok(!(await readFile(join(h.root, 'usr/local/lib/evimed-rsi/rsi-bundle-pull.sh'), 'utf8')).includes('planted-ran'), 'what is installed is what was sent');
  assert.deepEqual((await readdir(join(h.root, 'tmp'))).filter((name) => name.startsWith('rsi-install.')), [], 'and it is gone afterwards');
  assert.ok((await readdir(join(h.root, 'tmp'))).includes('rsi-online-records.py'), 'the planted name was left alone');
});

test('`production` refuses before it binds anything when the channel or the lab\'s records are not there, and the dry run reaches nothing', async () => {
  const h = await hosts();
  await installedHosts(h);
  await rm(join(h.root, 'etc/evimed-rsi/pull_ed25519'));
  const noKey = await h.install('production');
  assert.equal(noKey.code, 2);
  assert.match(noKey.stderr, /pull key missing: run rsi-lab-install\.sh channel first/);
  await assert.rejects(stat(join(h.root, 'var/lib/evimed-rsi/online')), { code: 'ENOENT' });
  const bare = await hosts();
  const noRecords = await bare.install('production');
  assert.ok(noRecords instanceof Error, 'a lab that was never installed');
  await assert.rejects(stat(join(bare.root, 'var/lib/evimed-rsi/online')), { code: 'ENOENT' });
  // The dry run: only messages, with no stand-in on PATH to reach anything.
  for (const mode of ['production', 'channel']) {
    const dry = await exec('bash', [install, mode], { env: { PATH: process.env.PATH, HOME: h.dir, RSI_LAB_DRY_RUN: '1' } });
    ok(dry, `dry ${mode}`);
    assert.match(dry.stderr, /\[dry-run\] ssh /);
    assert.doesNotMatch(dry.stdout, /installed/);
  }
});

test('the scripts parse, and the digest production records is the serving adapters\' own: what a bundle\'s target is compared with', async () => {
  for (const script of [install, labScript, pull]) execFileSync('bash', ['-n', script]);
  const reader = await readFile(join(deploy, 'production/rsi-consumer-digest.mjs'));
  const { spawnSync } = await import('node:child_process');
  const done = spawnSync(process.execPath, ['--input-type=module', '-'], { input: reader, encoding: 'utf8', cwd: repo, env: { PATH: process.env.PATH, RSI_EXPORT_APP_ROOT: repo.replace(/\/$/, '') } });
  assert.equal(done.status, 0, done.stderr);
  const closure = await computeRsiDependencyClosure({ rootDir: repo, surface: 'frontier-selection', settings: rsiClosureSettings('frontier-selection') });
  assert.equal(closure.qualified, true, JSON.stringify(closure.issues));
  assert.equal(done.stdout.trim(), closure.dependencyDigest, 'the lab\'s finalize computes the same closure with the same settings');
});
