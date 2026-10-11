import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { verifyLoopxArchive } from '../../../deploy/runtime-dsh/install-loopx.mjs';
import { verifyHostedLoopx, registerHostedLoopx } from '../../harness-port/src/loopxBootstrap.mjs';
import { runtimeUiMethodFromPath } from '../../domain/src/runtimeUiSurface.mjs';
import { isSuccessfulLoopxSkillResult } from '../../harness-port/src/loopxEvents.mjs';
import { explainLoopxPause } from '../../harness-port/src/loopxPause.mjs';
import { adaptLoopxDriver } from '../../../deploy/runtime-dsh/loopx-compat.mjs';

const root = new URL('../../../', import.meta.url);
const read = file => readFile(new URL(file, root), 'utf8');
const deps = JSON.parse(await read('deps-version.json'));

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
  const install = await read('deploy/runtime-dsh/install-runtime.sh');
  assert.match(install, /loopx\) loopx ;;/);
  assert.match(install, /loopx\.plugin\.filename/);
  const bundle = await read('packages/socket/cordis.patch.yml');
  assert.match(bundle, /id: loopx-init-command\n  disabled: true/);
  assert.match(bundle, /name: '@evimed\/dsh-socket\/plugins\/loopx-bootstrap'/);
  const composition = await read('deploy/runtime-dsh/dump-config.baseline.json');
  for (const id of ['loopx-goalbar', 'loopx-driver', 'loopx-shadow-observer', 'evimed-loopx-bootstrap']) assert.ok(composition.includes(`- id: ${id}\n`));
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
  assert.equal(messages[0].source.kind, 'user');
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
