import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RUNTIME_CONTROLLER_PROTOCOL_VERSION, RuntimeControllerClient } from '../src/runtimeControllerClient.mjs';
import { createRuntimeController } from '../src/runtimeControllerServer.mjs';
import {
  VCR_INTAKE_KINDS, VCR_INTAKE_SCRIPT_DIR, createVcrIntakeController, dockerMemoryBytes, vcrIntakeDirectory, vcrIntakePlan, vcrIntakeRoot,
} from '../src/vcrIntakeController.mjs';

const ATTEMPT = 'a1b2c3d4-0000-4000-8000-000000000001';
const DIGEST = 'f'.repeat(64);

function planConfig(extra = {}) {
  return {
    dataDir: '/srv/open-science-data', runtimeContainerBin: 'docker', runtimeContainerImage: 'open-science-runtime:test',
    runtimeContainerUser: '1000:1000', runtimeDataVolume: '', vcrIntakeMemory: '768m', vcrIntakeTimeoutMs: 60_000,
    vcrIntakeConcurrency: 2, vcrIntakeMaxBytes: 25 * 1024 * 1024, ...extra,
  };
}

/** The `--flag value` pairs of a Docker argument list, in order. @param {string[]} args @param {string} flag */
const valuesOf = (args, flag) => args.flatMap((arg, index) => (arg === flag ? [args[index + 1]] : []));

test('the intake container sees one read-only input, one empty output and nothing else', () => {
  for (const kind of VCR_INTAKE_KINDS) {
    const config = planConfig();
    const { args, dir, name } = vcrIntakePlan(config, kind, { attemptId: ATTEMPT, inputDigest: DIGEST });
    assert.equal(dir, path.join('/srv/open-science-data', 'vcr-intake', kind, ATTEMPT));
    assert.ok(name.startsWith(`evimed-vcr-intake-${kind}-`));

    // No network, no privileges, a read-only root, bounded.
    assert.ok(args.includes('--network=none'));
    assert.ok(args.includes('--read-only'));
    assert.ok(args.includes('--cap-drop=ALL'));
    assert.ok(args.includes('--security-opt=no-new-privileges'));
    assert.ok(args.includes('--memory=768m') && args.includes('--memory-swap=768m'));
    assert.ok(args.includes('--pids-limit=64') && args.includes('--cpus=1'));
    assert.deepEqual(valuesOf(args, '--user'), ['1000:1000']);

    // Exactly two mounts: the input, read-only, and the output. Nothing is bound
    // from a workspace, a data plane, a socket or a home directory.
    const mounts = valuesOf(args, '--mount');
    assert.equal(mounts.length, 2);
    assert.equal(mounts[0], `type=bind,src=${path.join(dir, 'input')},dst=/input,readonly`);
    assert.equal(mounts[1], `type=bind,src=${path.join(dir, 'output')},dst=/output`);
    for (const forbidden of ['-v', '--volume', '--volumes-from', '--device', '--privileged', '--network', '--net', '--pid', '--ipc', '--add-host', '--dns']) {
      assert.ok(!args.includes(forbidden), `${forbidden} is not part of the plan`);
    }
    // The shared image declares workspace and runtime volumes; both are shadowed
    // by empty read-only mounts, so there is no workspace to read or write.
    const tmpfs = valuesOf(args, '--tmpfs');
    assert.ok(tmpfs.includes('/workspace:ro,noexec,nosuid,nodev,size=1m'));
    assert.ok(tmpfs.includes('/runtime:ro,noexec,nosuid,nodev,size=1m'));

    // No model, no gateway, no credential: the environment is a fixed list of
    // scratch locations and thread counts.
    const environment = valuesOf(args, '--env');
    assert.deepEqual(environment.map(item => item.split('=')[0]).sort(), [
      'HOME', 'OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'PYTHONDONTWRITEBYTECODE', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME',
    ]);
    assert.ok(!environment.some(item => /OPEN_SCIENCE|EVIMED|KEY|TOKEN|SECRET|PASSWORD|GATEWAY|URL/i.test(item)));

    // A fixed operation: the image's own interpreter, one script, fixed flags.
    const image = args.indexOf('python3') + 1;
    assert.equal(args[image], 'open-science-runtime:test');
    assert.equal(args[image + 1], `${VCR_INTAKE_SCRIPT_DIR}/${kind === 'extract' ? 'vcr_record_extract.py' : 'vcr_curve_digitize.py'}`);
    assert.deepEqual(args.slice(image + 2, image + 8), ['--request', '/input/request.json', '--input-dir', '/input', '--output-dir', '/output']);
    assert.equal(args[image + 8], '--deadline');
    assert.equal(Number(args[image + 9]), 58);
    assert.equal(args.length, image + 10);
  }
});

test('the scratch is never a workspace, a project, a user directory or the data plane', () => {
  const config = planConfig({ vcrDataPlaneDir: '/data-plane' });
  const { args } = vcrIntakePlan(config, 'extract', { attemptId: ATTEMPT, inputDigest: DIGEST });
  for (const mount of valuesOf(args, '--mount')) {
    const source = /src=([^,]+)/.exec(mount)?.[1] ?? '';
    assert.ok(source.startsWith(`${vcrIntakeRoot(config)}${path.sep}`));
    assert.ok(!/\/(workspace|projects|users|knowledge-base)\b/.test(source));
    assert.ok(!source.startsWith('/data-plane'));
  }
});

test('with the shared data volume the two mounts are subpaths of it', () => {
  const config = planConfig({ runtimeDataVolume: 'open-science-data' });
  const { args } = vcrIntakePlan(config, 'digitize', { attemptId: ATTEMPT, inputDigest: DIGEST });
  assert.deepEqual(valuesOf(args, '--mount'), [
    `type=volume,src=open-science-data,dst=/input,volume-subpath=vcr-intake/digitize/${ATTEMPT}/input,readonly`,
    `type=volume,src=open-science-data,dst=/output,volume-subpath=vcr-intake/digitize/${ATTEMPT}/output`,
  ]);
});

test('a caller names an attempt and a digest and cannot steer a path, a command, a mount or an image', () => {
  const config = planConfig();
  const bad = [
    { attemptId: ATTEMPT, inputDigest: DIGEST, image: 'attacker/image' },
    { attemptId: ATTEMPT, inputDigest: DIGEST, command: 'sh' },
    { attemptId: ATTEMPT, inputDigest: DIGEST, mounts: ['/:/host'] },
    { attemptId: '../../etc', inputDigest: DIGEST },
    { attemptId: 'a/b', inputDigest: DIGEST },
    { attemptId: ATTEMPT, inputDigest: 'not-a-digest' },
    { attemptId: ATTEMPT },
    null, 'text', [],
  ];
  for (const reference of bad) assert.throws(() => vcrIntakePlan(config, 'extract', reference), { code: /^(vcr_intake_input_invalid|invalid_id)$/ });
  assert.throws(() => vcrIntakePlan(config, 'render', { attemptId: ATTEMPT, inputDigest: DIGEST }), { code: 'vcr_intake_input_invalid' });
  assert.throws(() => vcrIntakeDirectory(config, '../extract', ATTEMPT), { code: 'vcr_intake_input_invalid' });
});

test('docker sizes are whole megabytes or gigabytes', () => {
  assert.equal(dockerMemoryBytes('768m'), 768 * 1024 * 1024);
  assert.equal(dockerMemoryBytes('2g'), 2 * 1024 ** 3);
  for (const bad of ['', '0m', '1.5g', '512', '1t', '-1m']) assert.throws(() => dockerMemoryBytes(bad), { code: 'vcr_intake_failed' });
});

// --- the run, against a scripted docker ---------------------------------------

async function fixture(t, extra = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'vcr-intake-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const log = path.join(root, 'docker.log');
  const mode = path.join(root, 'mode');
  const bin = path.join(root, 'docker.mjs');
  await fs.writeFile(bin, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const mode = fs.existsSync(${JSON.stringify(mode)}) ? fs.readFileSync(${JSON.stringify(mode)}, 'utf8').trim() : 'ok';
if (args[0] === 'info') { console.log('26.1.4'); process.exit(0); }
if (args[0] === 'image') { if (mode === 'no-image') process.exit(1); console.log('sha256:feedface'); process.exit(0); }
if (args[0] === 'create') {
  if (mode === 'create-fails') { console.error('daemon refused'); process.exit(1); }
  if (mode === 'name-in-use') { console.error('Conflict. The container name is already in use'); process.exit(1); }
  process.exit(0);
}
if (args[0] === 'start') {
  if (mode === 'hang') { setInterval(() => {}, 1000); }
  else if (mode === 'exit-1') process.exit(1);
  else process.exit(0);
}
else process.exit(0);
`, { mode: 0o700 });
  const config = { ...planConfig({ dataDir: path.join(root, 'data'), runtimeContainerBin: bin }), ...extra };
  await fs.mkdir(config.dataDir, { recursive: true });
  const stage = async (attemptId = ATTEMPT, kind = 'extract', file = { name: 'document.pdf', body: Buffer.from('%PDF-1.4 test') }) => {
    const dir = vcrIntakeDirectory(config, kind, attemptId);
    await fs.mkdir(path.join(dir, 'input'), { recursive: true });
    await fs.mkdir(path.join(dir, 'output'));
    await fs.writeFile(path.join(dir, 'input', file.name), file.body);
    const request = Buffer.from(JSON.stringify({ format: 'pdf', file: { name: file.name, sha256: createHash('sha256').update(file.body).digest('hex'), bytes: file.body.length } }));
    await fs.writeFile(path.join(dir, 'input', 'request.json'), request);
    return { dir, reference: { attemptId, inputDigest: createHash('sha256').update(request).digest('hex') } };
  };
  const calls = async () => (await fs.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { root, config, stage, calls, setMode: value => fs.writeFile(mode, value) };
}
const roomy = { availableMemory: async () => 8 * 1024 ** 3 };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, limit = 4000) {
  const end = Date.now() + limit;
  while (Date.now() < end) { if (await predicate()) return true; await pause(15); }
  return false;
}

test('a conversion runs the fixed container from the resolved image id and removes it afterwards', async t => {
  const f = await fixture(t);
  const { reference } = await f.stage();
  const controller = createVcrIntakeController(f.config, roomy);
  t.after(() => controller.close());
  assert.deepEqual(await controller.run('extract', reference), { finished: true });
  const calls = await f.calls();
  const verbs = calls.map(call => (call[0] === 'container' ? 'prune' : call[0] === 'image' ? 'inspect' : call[0] === 'rm' ? 'remove' : call[0]));
  assert.deepEqual(verbs, ['inspect', 'prune', 'create', 'start', 'remove']);
  const create = calls.find(call => call[0] === 'create');
  assert.ok(create.includes('sha256:feedface'), 'the image id, not the tag that may move');
  assert.ok(!create.includes('open-science-runtime:test'));
  assert.deepEqual(calls.find(call => call[0] === 'start').slice(0, 2), ['start', '--attach']);
  assert.deepEqual(calls.find(call => call[0] === 'container'), ['container', 'prune', '-f', '--filter', 'label=open-science.vcr-intake', '--filter', 'until=10m']);
  assert.deepEqual(controller.status(), { running: 0, queued: 0 });
});

test('a container that fails, a daemon that refuses and a name in use are named, and the container is removed', async t => {
  const f = await fixture(t);
  const { reference } = await f.stage();
  const controller = createVcrIntakeController(f.config, roomy);
  t.after(() => controller.close());
  await f.setMode('exit-1');
  await assert.rejects(controller.run('extract', reference), { status: 502, code: 'vcr_intake_failed' });
  await f.setMode('create-fails');
  await assert.rejects(controller.run('extract', reference), { status: 503, code: 'vcr_intake_failed' });
  await f.setMode('name-in-use');
  await assert.rejects(controller.run('extract', reference), { status: 429, code: 'vcr_intake_busy' });
  await f.setMode('no-image');
  await assert.rejects(controller.run('extract', reference), { status: 503, code: 'vcr_intake_failed' });
  const removed = (await f.calls()).filter(call => call[0] === 'rm');
  assert.ok(removed.length >= 3 && removed.every(call => call.slice(0, 2).join(' ') === 'rm -f'));
});

test('the deadline stops the container and answers a timeout', async t => {
  let expire;
  const f = await fixture(t);
  const { reference } = await f.stage();
  const controller = createVcrIntakeController(f.config, { ...roomy, setTimer: callback => { expire = callback; return 1; }, clearTimer: () => {} });
  t.after(() => controller.close());
  await f.setMode('hang');
  const running = controller.run('extract', reference).then(() => null, error => error);
  assert.ok(await until(async () => (await f.calls()).some(call => call[0] === 'start')));
  expire();
  const error = await running;
  assert.equal(error.code, 'vcr_intake_timeout');
  assert.equal(error.status, 504);
  assert.ok((await f.calls()).filter(call => call[0] === 'rm').length >= 1);
  assert.deepEqual(controller.status(), { running: 0, queued: 0 });
});

test('a caller that goes away stops its container, and a waiting request leaves the queue without starting one', async t => {
  const f = await fixture(t, { vcrIntakeConcurrency: 1 });
  const first = await f.stage(ATTEMPT);
  const second = await f.stage('a1b2c3d4-0000-4000-8000-000000000002');
  const controller = createVcrIntakeController(f.config, roomy);
  t.after(() => controller.close());
  await f.setMode('hang');
  const abortFirst = new AbortController();
  const abortSecond = new AbortController();
  const one = controller.run('extract', first.reference, abortFirst.signal).then(() => null, error => error);
  assert.ok(await until(async () => (await f.calls()).some(call => call[0] === 'start')));
  const two = controller.run('extract', second.reference, abortSecond.signal).then(() => null, error => error);
  assert.ok(await until(() => controller.status().queued === 1), 'with one slot the second request waits');
  abortSecond.abort();
  assert.equal((await two).name, 'AbortError');
  assert.equal((await f.calls()).filter(call => call[0] === 'create').length, 1, 'the one that left never started a container');
  abortFirst.abort();
  assert.equal((await one).name, 'AbortError');
  assert.deepEqual(controller.status(), { running: 0, queued: 0 });
});

test('one slot runs one conversion at a time and the next starts when it ends', async t => {
  const f = await fixture(t, { vcrIntakeConcurrency: 1 });
  const first = await f.stage(ATTEMPT);
  const second = await f.stage('a1b2c3d4-0000-4000-8000-000000000002');
  const controller = createVcrIntakeController(f.config, roomy);
  t.after(() => controller.close());
  await f.setMode('hang');
  const abort = new AbortController();
  const one = controller.run('extract', first.reference, abort.signal).then(() => null, error => error);
  assert.ok(await until(async () => (await f.calls()).some(call => call[0] === 'start')));
  await f.setMode('ok');
  const two = controller.run('extract', second.reference);
  assert.ok(await until(() => controller.status().queued === 1));
  abort.abort();
  await one;
  assert.deepEqual(await two, { finished: true });
});

test('host memory below the container ceiling plus headroom is a busy answer, and nothing is created', async t => {
  const f = await fixture(t);
  const { reference } = await f.stage();
  const controller = createVcrIntakeController(f.config, { availableMemory: async () => 1024 * 1024 * 1024 });
  t.after(() => controller.close());
  await assert.rejects(controller.run('extract', reference), { status: 429, code: 'vcr_intake_busy' });
  assert.ok(!(await f.calls()).some(call => call[0] === 'create'));
});

test('an input that is not the one the digest names, a link, a missing file or a dirty output directory never starts a container', async t => {
  const f = await fixture(t);
  const controller = createVcrIntakeController(f.config, roomy);
  t.after(() => controller.close());
  const created = async () => (await f.calls()).some(call => call[0] === 'create');

  const changed = await f.stage();
  await assert.rejects(controller.run('extract', { ...changed.reference, inputDigest: '0'.repeat(64) }), { status: 409, code: 'vcr_intake_input_invalid' });

  const linked = await f.stage('a1b2c3d4-0000-4000-8000-000000000003');
  await fs.rm(path.join(linked.dir, 'input', 'document.pdf'));
  await fs.symlink('/etc/passwd', path.join(linked.dir, 'input', 'document.pdf'));
  await assert.rejects(controller.run('extract', linked.reference), { code: /^(vcr_intake_input_invalid|path_forbidden)$/ });

  const missing = await f.stage('a1b2c3d4-0000-4000-8000-000000000004');
  await fs.rm(path.join(missing.dir, 'input', 'document.pdf'));
  await assert.rejects(controller.run('extract', missing.reference), { code: 'vcr_intake_input_invalid' });

  const dirty = await f.stage('a1b2c3d4-0000-4000-8000-000000000005');
  await fs.writeFile(path.join(dirty.dir, 'output', 'left-over'), 'x');
  await assert.rejects(controller.run('extract', dirty.reference), { status: 409, code: 'vcr_intake_input_invalid' });

  const noRequest = await f.stage('a1b2c3d4-0000-4000-8000-000000000006');
  await fs.rm(path.join(noRequest.dir, 'input', 'request.json'));
  await assert.rejects(controller.run('extract', noRequest.reference), { code: 'vcr_intake_input_invalid' });

  assert.equal(await created(), false);
});

// --- the route, through the controller's own socket ---------------------------

test('the controller serves the two operations at protocol 9 and refuses anything else', async t => {
  const f = await fixture(t);
  const shortRoot = await fs.realpath(await fs.mkdtemp(path.join('/tmp', 'vi-')));
  t.after(() => fs.rm(shortRoot, { recursive: true, force: true }));
  const socketPath = path.join(shortRoot, 'c.sock');
  const server = createRuntimeController({
    ...f.config, production: false, runtimeMode: 'kernel', runtimeSandboxMode: 'docker', runtimeControllerMode: 'direct', runtimeControllerSocket: socketPath,
    deepseekProviderEnabled: false, deepseekApiKey: '', maxJsonBytes: 1024 * 1024,
  });
  t.after(() => server.close());
  await server.listen();
  const client = new RuntimeControllerClient({ runtimeControllerSocket: socketPath, runtimeControllerTimeoutMs: 5_000, vcrIntakeTimeoutMs: 20_000 });
  assert.equal(RUNTIME_CONTROLLER_PROTOCOL_VERSION, 9);
  assert.equal((await client.health()).protocolVersion, 9);

  const { reference } = await f.stage();
  assert.deepEqual(await client.runVcrIntake('extract', reference), { finished: true });
  assert.ok((await f.calls()).some(call => call[0] === 'create'));

  await assert.rejects(client.request('POST', '/v1/vcr/extract', { ...reference, image: 'x' }), { code: 'runtime_controller_payload_invalid' });
  await assert.rejects(client.request('POST', '/v1/vcr/extract', { attemptId: '../x', inputDigest: DIGEST }), { status: 400 });
  await assert.rejects(client.request('POST', '/v1/vcr/render', reference), { code: 'runtime_controller_route_not_found' });
  await assert.rejects(client.request('POST', '/v1/vcr/extract', { attemptId: ATTEMPT, inputDigest: DIGEST }), { code: 'vcr_intake_input_invalid' });
});
