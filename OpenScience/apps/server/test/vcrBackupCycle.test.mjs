import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runVcrBackupCycle, vcrBackupConfig } from '../../../scripts/ops/vcr-backup.mjs';

test('disabled VCR backup needs no host authority or storage paths', async () => {
  assert.equal(vcrBackupConfig({}).enabled, false);
  const result = await runVcrBackupCycle({ enabled: false });
  assert.deepEqual(result, { status: 'off' });
});

test('configured VCR backup refuses partial configuration and non-loopback operator URLs', () => {
  assert.throws(() => vcrBackupConfig({ OPEN_SCIENCE_VCR_BACKUP_ENABLED: 'true' }), /configuration/);
  const env = { OPEN_SCIENCE_VCR_BACKUP_ENABLED: 'true', OPEN_SCIENCE_VCR_DATA_PLANE_HOST_DIR: '/plane',
    OPEN_SCIENCE_VCR_BACKUP_DIR: '/backup', OPEN_SCIENCE_VCR_BACKUP_STATUS_HOST_DIR: '/status',
    OPEN_SCIENCE_OPERATOR_METRICS_TOKEN_HOST_FILE: '/token', OPEN_SCIENCE_BACKUP_PASSPHRASE_FILE: '/phrase',
    OPEN_SCIENCE_VCR_BACKUP_OPERATOR_URL: 'https://public.example' };
  assert.throws(() => vcrBackupConfig(env), /loopback/);
  assert.throws(() => vcrBackupConfig({ ...env, OPEN_SCIENCE_VCR_BACKUP_OPERATOR_URL: 'http://127.0.0.1:8787',
    OPEN_SCIENCE_VCR_BACKUP_DIR: '/plane/archives' }), /separate/);
  assert.equal(vcrBackupConfig({ ...env, OPEN_SCIENCE_VCR_BACKUP_OPERATOR_URL: '', OPEN_SCIENCE_API_PORT: '18887' }).operatorUrl,
    'http://127.0.0.1:18887');
});

async function fixture(t, { busy = false, leaseLost = false, drillFails = false } = {}) {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'vcr-backup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { enabled: true, dataPlaneDir: path.join(root, 'plane'), backupDir: path.join(root, 'backups'),
    statusDir: path.join(root, 'status'), jobsVolume: 'web_evimed-vcr-jobs', tokenFile: path.join(root, 'token'),
    passphraseFile: path.join(root, 'phrase'), operatorUrl: 'http://127.0.0.1:8787', drainSeconds: 0 };
  await mkdir(config.dataPlaneDir);
  await writeFile(config.tokenFile, 'fixture-token-for-scoped-operator-api', { mode: 0o600 });
  await writeFile(config.passphraseFile, 'fixture-passphrase-for-encrypted-backups', { mode: 0o400 });
  const jobs = path.join(root, 'jobs'); await mkdir(jobs);
  const calls = []; let requestId; let captures = 0;
  const run = async (command, args, options) => {
    calls.push({ command, args, env: options?.env });
    if (command === 'docker') return { stdout: args[0] === 'inspect' ? '1'.repeat(64) : JSON.stringify([{ Name: config.jobsVolume, Mountpoint: jobs }]) };
    if (args.includes('fence-capture')) return { stdout: JSON.stringify({ status: 'stopped',
      container: args[args.indexOf('--container') + 1], operation: args[args.indexOf('--operation') + 1], admissionFenced: true }) };
    if (args.includes('capture-member')) {
      const directory = args.at(-1); await mkdir(directory, { recursive: true });
      const archive = path.join(directory, 'postgres.dump.enc'); await writeFile(archive, 'encrypted-fixture', { mode: 0o600 });
      const receipt = path.join(directory, 'postgres.dump.enc.capture.json');
      await writeFile(receipt, JSON.stringify({ schemaVersion: 1, status: 'captured', archive: 'postgres.dump.enc',
        archiveSha256: createHash('sha256').update('encrypted-fixture').digest('hex'), snapshotId: '00000001-00000001-1',
        sourceIdentity: { database: 'evimed', databaseOid: '1', systemIdentifier: '2' }, atomicAcrossComponents: false }), { mode: 0o600 });
      return { stdout: JSON.stringify({ status: 'captured', archive, receipt }) };
    }
    if (args[0].endsWith('backup-data.sh')) {
      captures += 1;
      const directory = args.at(-1); await mkdir(directory, { recursive: true });
      const archive = path.join(directory, 'open-science-data-20261001T080000Z.tar.gz.enc');
      await writeFile(archive, 'encrypted-member', { mode: 0o600 }); await writeFile(`${archive}.sha256`,
        `${createHash('sha256').update('encrypted-member').digest('hex')}  ${path.basename(archive)}\n`, { mode: 0o600 });
      return { stdout: `${archive}\n`, stderr: '' };
    }
    if (args[0].endsWith('vcr-restore-drill.mjs')) {
      if (drillFails) throw new Error('fixture-drill-failed');
      return { stdout: JSON.stringify({ verification: 'inventory-v1', numericOwnersVerified: true, files: 2 }) };
    }
    throw new Error('Unexpected fixture command');
  };
  const maintenance = async (action, body) => {
    calls.push({ action, body });
    if (action === 'request') { requestId = body.requestId; return { lease: { requestId } }; }
    if (action === 'hold') return { lease: { requestId, durableHold: true } };
    if (action === 'release') return { state: 'open' };
    return { state: busy ? 'draining' : 'idle', lease: { requestId: leaseLost && captures ? 'different' : requestId },
      blockers: { unknown: 0, runningAgentRuns: busy ? 1 : 0 } };
  };
  return { config, calls, dependencies: { run, maintenance, rootCheck: () => {}, jobsOwnerCheck: async () => {} } };
}

test('one maintenance-held recovery set captures the actual PG snapshot and both encrypted roots', async t => {
  const { config, calls, dependencies } = await fixture(t);
  const result = await runVcrBackupCycle(config, dependencies);
  assert.equal(result.status, 'healthy');
  assert.equal(result.atomicAcrossComponents, false);
  assert.equal(result.consistency, 'maintenance-held');
  assert.equal(result.postgres.snapshotId, '00000001-00000001-1');
  assert.deepEqual(Object.keys(result.members), ['data-plane', 'jobs']);
  const backups = calls.filter(call => call.args?.[0]?.endsWith('backup-data.sh'));
  assert.equal(backups.length, 2);
  assert.ok(backups.every(call => call.env.OPEN_SCIENCE_BACKUP_STRICT === 'true'));
  assert.ok(backups.every(call => call.env.OPEN_SCIENCE_BACKUP_PASSPHRASE_FILE === config.passphraseFile));
  assert.equal(calls.filter(call => call.args?.includes('capture-member')).length, 1);
  assert.ok(calls.findIndex(call => call.action === 'hold') < calls.findIndex(call => call.args?.includes('capture-member')));
  const capture = calls.find(call => call.args?.includes('capture-member'));
  assert.equal(capture.env.EVIMED_RECOVERY_SET_STAGING_ROOT, path.join(config.backupDir, result.recoverySet));
  assert.equal(calls.at(-1).action, 'release');
  const state = JSON.parse(await readFile(path.join(config.statusDir, 'state.json'), 'utf8'));
  assert.equal(state.status, 'healthy');
  assert.deepEqual(state.coverage, ['data-plane', 'jobs']);
  assert.equal(JSON.stringify(state).includes(config.dataPlaneDir), false);
});

for (const setting of ['busy', 'leaseLost', 'drillFails']) test(`failed ${setting} never publishes healthy coverage and releases its lease`, async t => {
  const { config, calls, dependencies } = await fixture(t, { [setting]: true });
  await assert.rejects(runVcrBackupCycle(config, dependencies));
  const state = JSON.parse(await readFile(path.join(config.statusDir, 'state.json'), 'utf8'));
  assert.equal(state.status, 'failed');
  assert.equal(calls.at(-1).action, 'release');
  if (setting === 'busy') assert.equal(calls.filter(call => call.args?.includes('capture-member')).length, 0);
});

test('retention preserves the latest two complete recovery sets and incomplete usable captures', async t => {
  const { config, dependencies } = await fixture(t);
  await mkdir(path.join(config.backupDir, 'vcr-backup-00000000-0000-0000-0000-000000000000'), { recursive: true });
  const results = [];
  for (let i = 0; i < 3; i += 1) {
    results.push(await runVcrBackupCycle({ ...config, maxSets: 2 }, dependencies));
    await new Promise(resolve => setTimeout(resolve, 3));
  }
  const directories = await readdir(config.backupDir);
  assert.equal(directories.includes(results[0].recoverySet), false);
  assert.ok(directories.includes(results[1].recoverySet));
  assert.ok(directories.includes(results[2].recoverySet));
  assert.ok(directories.includes('vcr-backup-00000000-0000-0000-0000-000000000000'));
});

for (const redirected of [false, true]) test(`operator requests use direct loopback and ${redirected ? 'refuse redirects' : 'ignore proxy configuration'}`, async t => {
  const { config, dependencies } = await fixture(t);
  const requests = []; let requestId;
  const server = createServer(async (req, res) => {
    requests.push({ path: req.url, authorization: req.headers.authorization });
    if (redirected) { res.writeHead(307, { location: 'http://127.0.0.1:1/never-follow' }); res.end(); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const parsed = body ? JSON.parse(body) : null;
    if (parsed?.action === 'request') requestId = parsed.requestId;
    const data = req.method === 'GET' ? { state: 'idle', lease: { requestId }, blockers: { unknown: 0 } }
      : parsed?.action === 'request' ? { lease: { requestId } } : parsed?.action === 'hold' ? { lease: { requestId, durableHold: true } } : { state: 'open' };
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  config.operatorUrl = `http://127.0.0.1:${server.address().port}`;
  delete dependencies.maintenance;
  const oldProxy = process.env.HTTP_PROXY;
  process.env.HTTP_PROXY = 'http://127.0.0.1:1';
  t.after(() => { if (oldProxy === undefined) delete process.env.HTTP_PROXY; else process.env.HTTP_PROXY = oldProxy; });
  if (redirected) {
    await assert.rejects(runVcrBackupCycle(config, dependencies));
    assert.ok(requests.length <= 2);
  } else assert.equal((await runVcrBackupCycle(config, dependencies)).status, 'healthy');
  assert.ok(requests.every(row => row.path === '/api/ops/maintenance'));
  assert.ok(requests.every(row => row.authorization === 'Bearer fixture-token-for-scoped-operator-api'));
});

test('stopping during capture cancels the process, records failure and releases the lease without another renewal', async t => {
  const { config, calls, dependencies } = await fixture(t);
  const controller = new AbortController();
  let captureStarted;
  const started = new Promise(resolve => { captureStarted = resolve; });
  const previousRun = dependencies.run;
  let heartbeat; let cleared = false;
  const run = async (command, args, options) => {
    if (!args.includes('capture-member')) return previousRun(command, args, options);
    calls.push({ command, args }); captureStarted();
    assert.ok(options?.signal, 'the physical capture must receive the stop signal');
    return new Promise((resolve, reject) => {
      const abort = () => reject(Object.assign(new Error('stopped fixture process'), { code: 'ABORT_ERR' }));
      if (options?.signal?.aborted) abort();
      else options?.signal?.addEventListener('abort', abort, { once: true });
    });
  };
  const task = runVcrBackupCycle(config, { ...dependencies, run, signal: controller.signal,
    setInterval: callback => { heartbeat = callback; return 1; }, clearInterval: () => { cleared = true; } });
  const rejected = assert.rejects(task, { code: 'vcr_backup_canceled' });
  await started;
  controller.abort();
  await rejected;
  assert.equal(cleared, true);
  assert.equal(calls.at(-1).action, 'release');
  const state = JSON.parse(await readFile(path.join(config.statusDir, 'state.json'), 'utf8'));
  assert.equal(state.status, 'failed');
  assert.equal(state.code, 'vcr_backup_canceled');
  const requests = calls.filter(row => row.action === 'request').length;
  await heartbeat();
  assert.equal(calls.filter(row => row.action === 'request').length, requests);
});

test('stopping while draining ends the wait and releases maintenance before any capture', async t => {
  const { config, calls, dependencies } = await fixture(t, { busy: true });
  const controller = new AbortController();
  let statusRead;
  const draining = new Promise(resolve => { statusRead = resolve; });
  const previousMaintenance = dependencies.maintenance;
  const maintenance = async (action, body) => {
    const result = await previousMaintenance(action, body);
    if (action === 'status') statusRead();
    return result;
  };
  const task = runVcrBackupCycle({ ...config, drainSeconds: 60 }, { ...dependencies, maintenance, signal: controller.signal });
  const rejected = assert.rejects(task, { code: 'vcr_backup_canceled' });
  await draining;
  controller.abort();
  await rejected;
  assert.equal(calls.at(-1).action, 'release');
  assert.equal(calls.filter(row => row.args?.includes('capture-member')).length, 0);
});

test('an unconfirmed daemon-side stop retains maintenance and exposes failure instead of releasing into live capture', async t => {
  const { config, calls, dependencies } = await fixture(t);
  const original = dependencies.run;
  const run = async (command, args, options) => {
    if (args.includes('fence-capture')) throw new Error('fixture-daemon-unavailable');
    return original(command, args, options);
  };
  await assert.rejects(runVcrBackupCycle(config, { ...dependencies, run }), { code: 'vcr_backup_capture_stop_unconfirmed' });
  assert.equal(calls.some(row => row.action === 'release'), false);
  const state = JSON.parse(await readFile(path.join(config.statusDir, 'state.json'), 'utf8'));
  assert.equal(state.maintenanceHeld, true);
  assert.equal(state.status, 'failed');
});
