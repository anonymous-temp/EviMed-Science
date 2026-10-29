import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LOOPX_PROJECT_EDITS, adaptLoopxProjectSkill, hashSkillTree, installLoopx, keptLoopxSkills, pruneSkillInstallReadback, refreshSkillInstallReadback, verifyLoopxArchive, verifyLoopxWorkflowSkills } from '../../../deploy/runtime-dsh/install-loopx.mjs';
import { verifyHostedLoopx, registerHostedLoopx } from '../../harness-port/src/loopxBootstrap.mjs';
import { runtimeUiMethodFromPath } from '../../domain/src/runtimeUiSurface.mjs';
import { isSuccessfulLoopxSkillResult } from '../../harness-port/src/loopxEvents.mjs';
import { explainLoopxPause } from '../../harness-port/src/loopxPause.mjs';
import { adaptLoopxDriver, grantLoopxVersionExemption, orderLoopxProfileBundles } from '../../../deploy/runtime-dsh/loopx-compat.mjs';

const root = new URL('../../../', import.meta.url);
const read = file => readFile(new URL(file, root), 'utf8');
const deps = JSON.parse(await read('deps-version.json'));

const sha = body => createHash('sha256').update(body).digest('hex');
/** A stand-in for the pinned CLI's `loopx-project` skill: the three places that name the dropped skill, in the shapes the real file has them. */
const projectSkillBody = [
  '---',
  'name: loopx-project',
  `description: "Use for LoopX project lifecycle work. Ordinary task execution does not require this skill.${LOOPX_PROJECT_EDITS[0].from}"`,
  '---',
  '',
  '# LoopX Project Workflow',
  '',
  LOOPX_PROJECT_EDITS[1].from + 'LoopX has two layers:',
  '',
  'When a project agent discovers a durable design document that future agents may need, ' + LOOPX_PROJECT_EDITS[2].from + ' Identify the target project first;',
  '',
  '```bash',
  'loopx import-doc-registry-authority --goal-id <STABLE_GOAL_ID> ...',
  '```',
  '',
].join('\n');
/** What the build makes of it. */
const editedProjectSkill = LOOPX_PROJECT_EDITS.reduce((text, { from, to }) => text.replace(from, () => to), projectSkillBody);

test('the complete official distribution is pinned and installed before the immutable profile is sealed', async () => {
  const pin = deps.loopx;
  assert.equal(pin.contractDir, 'packages/contracts/loopx');
  for (const artifact of [pin.wheel, pin.plugin]) {
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
    assert.ok(artifact.url.endsWith(artifact.filename));
  }
  assert.equal(new URL(pin.wheel.url).host, 'files.pythonhosted.org');
  assert.ok(pin.plugin.url.startsWith('https://github.com/loopx-project/loopx/releases/download/'));
  for (const file of ['deploy/runtime-dsh/Dockerfile', 'deploy/runtime-dsh/Dockerfile.agentbay']) {
    const body = await read(file);
    assert.ok(body.includes('install-loopx.mjs'));
    assert.ok(body.indexOf('install-runtime.sh loopx') < body.indexOf('install-runtime.sh profile-seed'));
    assert.ok(body.includes(`ARG NODE_VERSION=${deps.$runtimeTools.node.version}`));
  }
  const compose = await read('deploy/web/docker-compose.yml');
  const environment = await read('deploy/web/.env.example');
  assert.ok(compose.includes('NODE_VERSION: ${OPEN_SCIENCE_NODE_VERSION:-' + deps.$runtimeTools.node.version + '}'),
    'Compose must not override the pinned runtime Node version with a stale default');
  assert.ok(environment.includes(`OPEN_SCIENCE_NODE_VERSION=${deps.$runtimeTools.node.version}\n`));
  const install = await read('deploy/runtime-dsh/install-runtime.sh');
  assert.match(install, /loopx\) loopx ;;/);
  assert.match(install, /loopx\.plugin\.filename/);
  assert.ok(install.indexOf('loopx-compat.mjs --order-profile') < install.indexOf('> /opt/evimed/dump-config.baseline.json'));
  const bundle = await read('packages/socket/cordis.patch.yml');
  assert.match(bundle, /id: loopx-init-command\n  disabled: true/);
  assert.match(bundle, /name: '@evimed\/dsh-socket\/plugins\/loopx-bootstrap'/);
  const composition = await read('deploy/runtime-dsh/dump-config.baseline.json');
  for (const id of ['loopx-goalbar', 'loopx-driver', 'loopx-shadow-observer', 'evimed-loopx-bootstrap']) assert.ok(composition.includes(`- id: ${id}\n`));
});

test('image preparation restores patch order after native package reconciliation and preserves every other bundle', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'loopx-profile-order-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'package.json');
  const bundles = ['@deepseek-ai/dsh-base', '@changfenhuang/dsh-annotation', '@deepseek-ai/dsh-web-app',
    '@evimed/dsh-socket', 'dsh-cite', 'dsh-loopx-plugin', 'dsh-mermaid'];
  const manifest = { private: true, dependencies: { 'dsh-loopx-plugin': 'file:official.tgz' }, dsh: { profile: { bundles } } };
  await writeFile(file, JSON.stringify(manifest));
  const ordered = orderLoopxProfileBundles(file);
  assert.deepEqual(ordered, [...bundles.slice(0, 3), 'dsh-loopx-plugin', '@evimed/dsh-socket', 'dsh-cite', 'dsh-mermaid']);
  const first = await readFile(file, 'utf8');
  assert.deepEqual(JSON.parse(first).dependencies, manifest.dependencies);
  assert.deepEqual(orderLoopxProfileBundles(file), ordered);
  assert.equal(await readFile(file, 'utf8'), first);
  await writeFile(file, JSON.stringify({ dsh: { profile: { bundles: bundles.filter(name => name !== 'dsh-loopx-plugin') } } }));
  assert.throws(() => orderLoopxProfileBundles(file), /exactly one/);
});

test('archive integrity is checked before any package is executed', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'loopx-archive-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'archive');
  await writeFile(file, 'original');
  const sha = createHash('sha256').update('original').digest('hex');
  assert.equal(verifyLoopxArchive(file, sha), sha);
  await writeFile(file, 'changed');
  assert.throws(() => verifyLoopxArchive(file, sha), /digest mismatch/);
});

test('hosted bootstrap verifies the CLI and skill without modifying the installation; missing LoopX leaves the host usable', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'loopx-bootstrap-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cli = path.join(dir, 'loopx');
  await writeFile(cli, '#!/bin/sh\nprintf "loopx 1.3.1\\n"\n', { mode: 0o755 });
  await mkdir(path.join(dir, 'skills/loopx'), { recursive: true });
  await writeFile(path.join(dir, 'skills/loopx/SKILL.md'), 'entry skill');
  await writeFile(path.join(dir, 'installation.json'), JSON.stringify({ schemaVersion: 1, version: '1.3.1', pluginVersion: deps.loopx.plugin.version }));
  assert.equal((await verifyHostedLoopx({ root: dir, cli })).state, 'ready');
  await writeFile(cli, '#!/bin/sh\nprintf "loopx 0.0.0\\n"\n');
  assert.equal((await verifyHostedLoopx({ root: dir, cli })).state, 'failed');
  const registered = [], services = [];
  await registerHostedLoopx({ provide: (...args) => services.push(args), logger: { warn() {} }, effect: fn => fn(),
    commands: { register: command => registered.push(command) } }, { root: dir, cli, enabled: true });
  assert.equal(services[0][1].state, 'failed');
  assert.equal(registered[0].name, 'loopx-init');
  assert.equal((await registered[0].handler({ rawInput: '' })).kind, 'error');
});

test('only the pinned dotted endpoint joins the hosted HTTP surface', () => {
  assert.equal(runtimeUiMethodFromPath('/api/loopx.goalbar'), 'loopx.goalbar');
  assert.equal(runtimeUiMethodFromPath('/api/loopx.install'), null);
  assert.equal(runtimeUiMethodFromPath('/api/loopx%2egoalbar'), null);
});

test('skill activation accepts the recorded DSH 0.1.7 result and the upstream envelope, never a failed or different call', async () => {
  const golden = JSON.parse(await read('apps/server/test/fixtures/dsh/golden-frames.json'));
  const find = value => {
    if (value?.type === 'tool/result' && value.data?.message?.role === 'tool') return value.data;
    if (value && typeof value === 'object') for (const child of Object.values(value)) { const found = find(child); if (found) return found; }
  };
  const data = find(golden);
  assert.ok(data, 'the recorded wire must supply the shape');
  const callId = data.message.source.callId;
  assert.equal(isSuccessfulLoopxSkillResult(data, callId), true);
  assert.equal(isSuccessfulLoopxSkillResult(data, 'another-call'), false);
  assert.equal(isSuccessfulLoopxSkillResult({ ...data, error: { code: 'failed' } }, callId), false);
  assert.equal(isSuccessfulLoopxSkillResult({ message: { ...data.message, isError: true } }, callId), false);
  const native = { message: { role: 'user', source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId }] } };
  assert.equal(isSuccessfulLoopxSkillResult(native, callId), true);
  native.message.content[0].isError = true;
  assert.equal(isSuccessfulLoopxSkillResult(native, callId), false);
});

test('a pause explains the user action to the current step and never wakes or queues work for an idle session', () => {
  const messages = [];
  const agent = { status: 'running', inject: message => messages.push(message) };
  assert.equal(explainLoopxPause(agent), true);
  // Machine text, never the researcher's bubble or their steering (kind 'user').
  assert.equal(messages[0].source.kind, 'plugin:evimed-loopx-pause');
  assert.match(messages[0].content[0].text, /user just pressed Pause/);
  assert.match(messages[0].content[0].text, /no diagnosis or repair/);
  agent.status = 'idle';
  assert.equal(explainLoopxPause(agent), false);
  assert.equal(messages.length, 1);
  assert.equal(explainLoopxPause({ status: 'running', inject() { throw new Error('disposed'); } }), false);
});

test('build-time adaptation is idempotent and rejects any unreviewed bytes before writing either file', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'loopx-adaptation-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'lib'));
  // Minimal upstream fragments exercise the archive-to-profile transformation.
  const driver = 'const successful = source?.kind === "tool" && message?.role === "user" && block?.type === "tool-result" && block.toolCallId === callId && (block.isError === void 0 || block.isError === false) && data?.error === void 0;';
  const goalbar = '\t\treturn {\n\t\t\tkind: "succeeded",\n\t\t\tsnapshot: postRead.snapshot,\n};';
  const hash = text => createHash('sha256').update(text).digest('hex');
  const pin = { plugin: deps.loopx.plugin, compatibility: { driverFile: 'lib/driver.js', driverSha256: hash(driver), goalbarFile: 'lib/index.js', goalbarSha256: hash(goalbar) } };
  await writeFile(path.join(dir, pin.compatibility.driverFile), driver);
  await writeFile(path.join(dir, pin.compatibility.goalbarFile), goalbar);
  const options = { pluginDir: dir, pin, helper: new URL('../../harness-port/src/loopxEvents.mjs', import.meta.url).pathname };
  const receipt = adaptLoopxDriver(options);
  assert.deepEqual(adaptLoopxDriver(options), receipt);
  const adaptedDriver = await readFile(path.join(dir, pin.compatibility.driverFile), 'utf8');
  assert.notEqual(hash(adaptedDriver), hash(driver));
  await writeFile(path.join(dir, pin.compatibility.goalbarFile), goalbar + '\n// unreviewed');
  assert.throws(() => adaptLoopxDriver(options), /GoalBar differs/);
  assert.equal(await readFile(path.join(dir, pin.compatibility.driverFile), 'utf8'), adaptedDriver);
});

// 0.2.1 skips a bundle outside its declared DSH range unless the profile's compatibility.json exempts that exact pair.
// The grant is the kernel's own CLI; what is ours is that it is made only for the reviewed pair and the pinned bytes, and
// that the record it leaves is that one grant (r19-dsh021).
test('the version exemption is granted only for the reviewed pair, the pinned archive, and leaves exactly one grant', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'loopx-exemption-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const archive = path.join(dir, 'plugin.tgz');
  await writeFile(archive, 'reviewed bytes');
  const sha256 = createHash('sha256').update('reviewed bytes').digest('hex');
  // A stand-in for `dsh plugin --profile P allow-version NAME@V --dsh-version D --accept-risk`, writing what the kernel writes.
  const dsh = path.join(dir, 'dsh');
  await writeFile(dsh, `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');const a=process.argv.slice(2);` +
    `if(a[0]!=='plugin'||a[3]!=='allow-version'||!a.includes('--accept-risk'))process.exit(2);` +
    `const f=path.join(process.env.DSH_HOME,'profiles',a[2],'compatibility.json');fs.mkdirSync(path.dirname(f),{recursive:true});` +
    `const r=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):{};r[a[4]]=[...new Set([...(r[a[4]]??[]),a[6]])];fs.writeFileSync(f,JSON.stringify(r,null,2),{mode:0o600});\n`, { mode: 0o755 });
  const exemption = deps.loopx.compatibility.dshVersionExemption;
  assert.equal(exemption.plugin, `dsh-loopx-plugin@${deps.loopx.plugin.version}`, 'the record names the pinned plugin');
  assert.equal(exemption.dsh, deps.dsh.version, 'the record names the pinned kernel');
  const pins = { dsh: { version: exemption.dsh }, loopx: { plugin: { version: deps.loopx.plugin.version, sha256 }, compatibility: { dshVersionExemption: exemption } } };
  const seedHome = path.join(dir, 'seed');
  assert.deepEqual(grantLoopxVersionExemption({ seedHome, archive, pins, dsh }), { [exemption.plugin]: [exemption.dsh] });
  assert.throws(() => grantLoopxVersionExemption({ seedHome, archive, dsh, pins: { ...pins, dsh: { version: '9.9.9' } } }), new RegExp(`reviewed for .* on DSH ${exemption.dsh.replaceAll('.', '\\.')}`));
  assert.throws(() => grantLoopxVersionExemption({ seedHome, archive, dsh, pins: { ...pins, loopx: { ...pins.loopx, plugin: { ...pins.loopx.plugin, sha256: '0'.repeat(64) } } } }), /differs from the pinned digest/);
  assert.throws(() => grantLoopxVersionExemption({ seedHome, archive, dsh, pins: { ...pins, loopx: { ...pins.loopx, compatibility: {} } } }), /no reviewed/);
  // A second grant already in the profile is not the reviewed record.
  const file = path.join(seedHome, 'profiles', 'evimed-runtime', 'compatibility.json');
  await writeFile(file, JSON.stringify({ 'other-plugin@1.0.0': [exemption.dsh] }));
  assert.throws(() => grantLoopxVersionExemption({ seedHome, archive, pins, dsh }), /not the one reviewed grant/);
  const install = await read('deploy/runtime-dsh/install-runtime.sh');
  assert.ok(install.indexOf('loopx-compat.mjs --grant-exemption') < install.indexOf('dsh plugin --profile evimed-runtime add'),
    'granted before the add, which the kernel refuses without it');
});

// The folders the pinned CLI installs are a recorded fact, so the plugins page can list what the image carries and a CLI bump
// that adds or drops one is a decision made at the build, by name (R19, runtime inventory).
test('the recorded workflow skills are the pinned CLI\'s, the build holds the installed folders equal to them and names a difference', async () => {
  const record = JSON.parse(await read('packages/contracts/loopx/workflow-skills.json'));
  assert.equal(record.version, deps.loopx.version, 're-record workflow-skills.json when the CLI pin moves');
  assert.equal(record.wheelSha256, deps.loopx.wheel.sha256);
  assert.equal(record.entry, 'loopx');
  assert.ok(record.installed.includes('loopx') && record.installed.includes('loopx-project'));
  assert.deepEqual([...record.installed].sort(), record.installed, 'sorted, so a diff reads');
  assert.ok(record.kept.every(name => record.installed.includes(name)), 'the catalogue keeps only what the CLI installed');
  assert.ok(record.kept.includes('loopx'), 'the entry skill is never filtered out');
  assert.ok(record.packagedNotInstalled.every(name => !record.installed.includes(name)));

  assert.deepEqual(verifyLoopxWorkflowSkills([...record.installed].reverse(), record), record.installed);
  assert.throws(() => verifyLoopxWorkflowSkills(record.installed.filter(name => name !== 'loopx-pr-review'), record), /missing: loopx-pr-review/);
  assert.throws(() => verifyLoopxWorkflowSkills([...record.installed, 'loopx-change-quality'], record), /not recorded: loopx-change-quality/);
  assert.throws(() => verifyLoopxWorkflowSkills([], { installed: [] }), /names no installed skill/);

  for (const file of ['deploy/runtime-dsh/Dockerfile', 'deploy/runtime-dsh/Dockerfile.agentbay']) {
    const body = await read(file);
    assert.ok(body.includes('COPY packages/contracts/loopx/workflow-skills.json /usr/local/lib/evimed/loopx-workflow-skills.json'), `${file} carries the record to the build step that holds the folders to it`);
    assert.ok(body.indexOf('loopx-workflow-skills.json') < body.indexOf('install-runtime.sh loopx'));
  }
});

test('the model\'s catalogue keeps the entry skill and the goal lifecycle, and the other LoopX folders never reach the image', async t => {
  const record = JSON.parse(await read('packages/contracts/loopx/workflow-skills.json'));
  // The pinned record: six of the eight folders are the repository-management workflows nothing on this platform starts.
  assert.deepEqual(keptLoopxSkills(record), ['loopx', 'loopx-project']);
  assert.throws(() => keptLoopxSkills({ ...record, kept: [] }), /keeps no skill/);
  assert.throws(() => keptLoopxSkills({ ...record, kept: ['loopx', 'loopx-unknown'] }), /does not install: loopx-unknown/);
  assert.throws(() => keptLoopxSkills({ ...record, kept: ['loopx-project'] }), /must keep the entry skill/);

  // The build itself, against a CLI that writes the recorded folders: what is not kept is removed, the receipt names both.
  const dir = await mkdtemp(path.join(tmpdir(), 'loopx-install-'));
  // The kept folders stay as read-only as the CLI copied them.
  t.after(() => { execFileSync('chmod', ['-R', 'u+w', dir]); return rm(dir, { recursive: true, force: true }); });
  const bin = path.join(dir, 'bin');
  await mkdir(bin);
  await writeFile(path.join(bin, 'uv'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const cli = path.join(bin, 'loopx');
  await writeFile(cli, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const argv = process.argv.slice(2);
if (argv[0] === '--version') { console.log('loopx ${deps.loopx.version}'); process.exit(0); }
if (argv[0] === 'workflow-skills') {
  const target = argv[argv.indexOf('--skills-dir') + 1];
  const names = ${JSON.stringify(record.installed)};
  for (const name of names) {
    fs.mkdirSync(path.join(target, name), { recursive: true });
    fs.writeFileSync(path.join(target, name, 'SKILL.md'), name === 'loopx-project' ? ${JSON.stringify(projectSkillBody)} : 'skill ' + name);
    // What the real CLI does when it copies out of a read-only package: the copies keep their modes.
    fs.chmodSync(path.join(target, name, 'SKILL.md'), 0o444);
    fs.chmodSync(path.join(target, name), 0o555);
  }
  const items = Object.fromEntries(names.map(name => [name, { available: true, file_count: 1, sha256: name.length.toString(16).padStart(64, '0') }]));
  fs.writeFileSync(path.join(target, '.loopx-skill-install.json'), JSON.stringify({ schema_version: 'loopx_skill_install_readback_v1',
    materialized_skill_ids: names, skills: { digest: 'stale', items } }));
  console.log(JSON.stringify({ ok: true }));
  process.exit(0);
}
process.exit(2);
`, { mode: 0o755 });
  const archives = path.join(dir, 'archives');
  await mkdir(archives);
  // The edit is bound to the pinned CLI's real file, which the fake CLI does not write; its own file is bound the same way.
  const pins = { loopx: { ...deps.loopx, compatibility: { ...deps.loopx.compatibility, skillEdit: { ...deps.loopx.compatibility.skillEdit, sha256: sha(projectSkillBody), adaptedSha256: sha(editedProjectSkill) } } } };
  for (const key of ['wheel', 'plugin']) {
    const body = `archive ${key}`;
    await writeFile(path.join(archives, pins.loopx[key].filename), body);
    pins.loopx[key] = { ...pins.loopx[key], sha256: createHash('sha256').update(body).digest('hex') };
  }
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  let receipt;
  try {
    receipt = installLoopx({ pins, root: path.join(dir, 'loopx-root'), archives, python: path.join(bin, 'python'), cli });
  } finally { process.env.PATH = saved; }
  const present = (await readdir(path.join(dir, 'loopx-root', 'skills'))).filter(name => !name.startsWith('.')).sort();
  assert.deepEqual(present, ['loopx', 'loopx-project'], 'only the kept folders are on disk');
  assert.deepEqual(receipt.skills.map(skill => skill.name), ['loopx', 'loopx-project']);
  assert.deepEqual(receipt.shipped.map(skill => skill.name), record.installed, 'the receipt still says what upstream shipped');
  // The kept lifecycle skill is what the build made of it: the receipt carries the digest of the edited file and, beside it, the
  // digest upstream shipped it with; the pointers to the skill the image leaves out are gone from the folder.
  const edited = await readFile(path.join(dir, 'loopx-root', 'skills', 'loopx-project', 'SKILL.md'), 'utf8');
  assert.equal(edited, editedProjectSkill);
  assert.equal(receipt.skills.find(skill => skill.name === 'loopx-project').sha256, sha(editedProjectSkill));
  assert.equal(receipt.shipped.find(skill => skill.name === 'loopx-project').sha256, sha(projectSkillBody));
  assert.deepEqual(receipt.edits, [{ skill: 'loopx-project', file: 'SKILL.md', sourceSha256: sha(projectSkillBody), adaptedSha256: sha(editedProjectSkill), edits: LOOPX_PROJECT_EDITS.length }]);
  assert.equal((await stat(path.join(dir, 'loopx-root', 'skills', 'loopx-project', 'SKILL.md'))).mode & 0o777, 0o444, 'the kept folder is as read-only as the CLI left it');
  assert.deepEqual(receipt.kept, ['loopx', 'loopx-project']);
  assert.deepEqual(receipt.dropped, record.installed.filter(name => !['loopx', 'loopx-project'].includes(name)));
  assert.ok(receipt.shipped.every(skill => /^[a-f0-9]{64}$/.test(skill.sha256)));
  const written = JSON.parse(await readFile(path.join(dir, 'loopx-root', 'installation.json'), 'utf8'));
  assert.deepEqual(written, receipt);
  // The hosted bootstrap reads the same receipt and the entry skill, and both are still there.
  assert.equal((await verifyHostedLoopx({ root: path.join(dir, 'loopx-root'), cli })).state, 'ready');
  // The CLI's own readback manifest is pruned to what is left, as the CLI prunes it itself, so a check of this root does not
  // report six folders missing.
  const manifest = JSON.parse(await readFile(path.join(dir, 'loopx-root', 'skills', '.loopx-skill-install.json'), 'utf8'));
  assert.deepEqual(manifest.materialized_skill_ids, ['loopx', 'loopx-project']);
  assert.deepEqual(Object.keys(manifest.skills.items).sort(), ['loopx', 'loopx-project']);
  assert.notEqual(manifest.skills.digest, 'stale');
  // The edited folder is written back to the manifest as the CLI itself would hash it, so the CLI's own readback check of this
  // root does not find `loopx-project` modified; the folder the build left alone keeps what the CLI recorded.
  assert.deepEqual(manifest.skills.items['loopx-project'], hashSkillTree(path.join(dir, 'loopx-root', 'skills', 'loopx-project')));
  assert.equal(manifest.skills.items.loopx.sha256, 'loopx'.length.toString(16).padStart(64, '0'));
});

test('the readback manifest digest is the CLI\'s own: the hash of Python\'s sorted json of the items that are left', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'loopx-readback-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const item = (file_count, fill) => ({ available: true, file_count, sha256: fill.repeat(64) });
  await writeFile(path.join(dir, '.loopx-skill-install.json'), JSON.stringify({ owner: 'x', materialized_skill_ids: ['loopx', 'loopx-pr-review', 'loopx-project'],
    skills: { digest: 'old', items: { loopx: item(2, 'a'), 'loopx-project': item(3, 'b'), 'loopx-pr-review': item(4, 'c') } } }));
  assert.equal(pruneSkillInstallReadback(dir, ['loopx', 'loopx-project']), true);
  const pruned = JSON.parse(await readFile(path.join(dir, '.loopx-skill-install.json'), 'utf8'));
  // Computed once with `json.dumps(items, ensure_ascii=False, sort_keys=True)` and sha256, in the CLI's own interpreter.
  assert.equal(pruned.skills.digest, 'bc1932eba58b08d5710aa3ab4f9ecf06c9db7e8e9ed21aca38b04bbabec0f424');
  assert.deepEqual(pruned.materialized_skill_ids, ['loopx', 'loopx-project']);
  assert.equal(pruned.owner, 'x', 'what is not about the skills is left as it was');
  assert.equal(pruneSkillInstallReadback(path.join(dir, 'nowhere'), ['loopx']), false, 'no manifest, nothing to prune');
});

// Found by the integrated acceptance of 2026-10-17 (r19-accepta, finding 7): the kept `loopx-project` skill told the model to
// prefer a skill the build leaves out.
test('the kept loopx-project skill names no skill the image leaves out, and the edit is bound to the pinned CLI\'s bytes', async t => {
  const pin = deps.loopx.compatibility.skillEdit;
  assert.equal(pin.skill, 'loopx-project');
  assert.match(pin.sha256, /^[a-f0-9]{64}$/);
  assert.match(pin.adaptedSha256, /^[a-f0-9]{64}$/);
  assert.notEqual(pin.sha256, pin.adaptedSha256);
  assert.ok(pin.reason.length > 200 && pin.upgradePath.length > 200, 'recorded with the reason and the way out, as the other build-time edits are');
  const record = JSON.parse(await read('packages/contracts/loopx/workflow-skills.json'));
  assert.ok(record.kept.includes(pin.skill) && !record.kept.includes('loopx-doc-registry'), 'the edit exists because the other skill is not kept; keeping it makes the edit obsolete');
  // Each fragment is one pointer to the dropped skill, and none of the replacements names it.
  for (const { from, to } of LOOPX_PROJECT_EDITS) {
    assert.match(from, /doc-registry/);
    assert.doesNotMatch(to, /doc-registry/);
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'loopx-skill-edit-'));
  // The folders stay as read-only as the CLI copied them.
  t.after(() => { execFileSync('chmod', ['-R', 'u+w', dir]); return rm(dir, { recursive: true, force: true }); });
  const make = async (body) => {
    const skillsDir = path.join(dir, `skills-${Math.random().toString(16).slice(2)}`);
    await mkdir(path.join(skillsDir, 'loopx-project'), { recursive: true });
    await writeFile(path.join(skillsDir, 'loopx-project', 'SKILL.md'), body);
    await chmod(path.join(skillsDir, 'loopx-project', 'SKILL.md'), 0o444);
    await chmod(path.join(skillsDir, 'loopx-project'), 0o555);
    return skillsDir;
  };
  const edit = { ...pin, sha256: sha(projectSkillBody), adaptedSha256: sha(editedProjectSkill) };

  const ok = await make(projectSkillBody);
  const done = adaptLoopxProjectSkill({ skillsDir: ok, edit });
  assert.equal(done.adaptedSha256, sha(editedProjectSkill));
  assert.equal(await readFile(path.join(ok, 'loopx-project', 'SKILL.md'), 'utf8'), editedProjectSkill);
  assert.doesNotMatch(editedProjectSkill, /prefer loopx-doc-registry|load `loopx-doc-registry`|doc-registry skill trigger/);
  assert.match(editedProjectSkill, /loopx import-doc-registry-authority/, 'the CLI\'s own command stays');
  assert.equal((await stat(path.join(ok, 'loopx-project'))).mode & 0o777, 0o555, 'the folder is put back as it was');
  // A file that is not the reviewed one is refused whole, whatever it says; so is one that lost a fragment, or an edit that
  // does not produce the reviewed result.
  await assert.rejects(async () => adaptLoopxProjectSkill({ skillsDir: await make(projectSkillBody + 'x'), edit }), /differs from the reviewed compatibility input/);
  const lost = projectSkillBody.replace(LOOPX_PROJECT_EDITS[1].from, '');
  await assert.rejects(async () => adaptLoopxProjectSkill({ skillsDir: await make(lost), edit: { ...edit, sha256: sha(lost) } }), /exactly once/);
  await assert.rejects(async () => adaptLoopxProjectSkill({ skillsDir: await make(projectSkillBody), edit: { ...edit, adaptedSha256: 'f'.repeat(64) } }), /not the reviewed one/);
  assert.equal(adaptLoopxProjectSkill({ skillsDir: ok, edit: undefined }), null, 'a pin that records no edit changes nothing');
});

test('the readback manifest holds an edited folder as the CLI hashes it (the tree hash is the CLI\'s own)', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'loopx-tree-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const folder = path.join(dir, 'loopx-project');
  await mkdir(path.join(folder, 'agents'), { recursive: true });
  await mkdir(path.join(folder, 'references'));
  for (const [name, body] of [['.loopx-skill-scope', 'x'], ['.loopx-skill-version.json', '{"a": 1}\n'], ['SKILL.md', '# Skill\n\nbody\n'], ['agents/openai.yaml', 'name: x\n'], ['references/a.md', 'one\n'], ['references.txt', 'two\n']]) {
    await writeFile(path.join(folder, name), body);
  }
  // Computed once with `loopx.skill_install_readback.hash_skill_tree` of the pinned CLI on this exact tree. The layout is the
  // one that tells Python's Path ordering (component by component: `references/a.md` before `references.txt`) from a string sort.
  const golden = { available: true, file_count: 6, sha256: 'b5794dad333508d71e9988c5ab919bd1f757c8df23ae579338f163a820e5686d' };
  assert.deepEqual(hashSkillTree(folder), golden);
  assert.deepEqual(hashSkillTree(path.join(dir, 'nowhere')), { available: false, file_count: 0, sha256: null });

  const item = (file_count, fill) => ({ available: true, file_count, sha256: fill.repeat(64) });
  await writeFile(path.join(dir, '.loopx-skill-install.json'), JSON.stringify({ owner: 'x', skills: { digest: 'old', items: { loopx: item(2, 'a'), 'loopx-project': item(3, 'b') } } }));
  assert.equal(refreshSkillInstallReadback(dir, ['loopx-project']), true);
  const manifest = JSON.parse(await readFile(path.join(dir, '.loopx-skill-install.json'), 'utf8'));
  assert.deepEqual(manifest.skills.items['loopx-project'], golden);
  assert.deepEqual(manifest.skills.items.loopx, item(2, 'a'));
  assert.equal(manifest.owner, 'x');
  assert.equal(manifest.skills.digest, sha(`{"loopx": {"available": true, "file_count": 2, "sha256": "${'a'.repeat(64)}"}, "loopx-project": {"available": true, "file_count": 6, "sha256": "${golden.sha256}"}}`));
  assert.equal(refreshSkillInstallReadback(path.join(dir, 'nowhere'), ['loopx-project']), false);
});
