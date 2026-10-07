import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

test('configured VCR backup refuses partial configuration and overlapping paths, and asks the running application for nothing', () => {
  assert.throws(() => vcrBackupConfig({ OPEN_SCIENCE_VCR_BACKUP_ENABLED: 'true' }), /configuration/);
  const env = { OPEN_SCIENCE_VCR_BACKUP_ENABLED: 'true', OPEN_SCIENCE_VCR_DATA_PLANE_HOST_DIR: '/plane',
    OPEN_SCIENCE_VCR_BACKUP_DIR: '/backup', OPEN_SCIENCE_VCR_BACKUP_STATUS_HOST_DIR: '/status',
    OPEN_SCIENCE_BACKUP_PASSPHRASE_FILE: '/phrase' };
  assert.throws(() => vcrBackupConfig({ ...env, OPEN_SCIENCE_VCR_BACKUP_DIR: '/plane/archives' }), /separate/);
  const config = vcrBackupConfig({ ...env, OPEN_SCIENCE_OPERATOR_METRICS_TOKEN_HOST_FILE: '/token', OPEN_SCIENCE_VCR_BACKUP_OPERATOR_URL: 'http://127.0.0.1:8787' });
  // A deployment's old operator settings are not read: there is no token, URL or lease left to configure.
  assert.deepEqual(Object.keys(config).sort(), ['backupDir', 'dataPlaneDir', 'enabled', 'jobsVolume', 'maxSets', 'passphraseFile', 'statusDir']);
});

const NAMED = [{ location: `studies/s1/sources/a/${'a'.repeat(64)}.csv`, sha256: 'a'.repeat(64) },
  { location: 'studies/s1/.pseudonym-key', sha256: null }];

/**
 * `drills`: what the data-plane restore drill finds on each attempt, in order (the last repeats).
 * `busy` is not a parameter any more: nothing in the cycle asks whether the platform is.
 */
async function fixture(t, { drillFails = false, drills = [{ checked: NAMED.length, missing: 0, mismatched: 0 }], fenceFails = false } = {}) {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'vcr-backup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { enabled: true, dataPlaneDir: path.join(root, 'plane'), backupDir: path.join(root, 'backups'),
    statusDir: path.join(root, 'status'), jobsVolume: 'web_evimed-vcr-jobs', passphraseFile: path.join(root, 'phrase') };
  await mkdir(config.dataPlaneDir, { mode: 0o700 });
  await writeFile(config.passphraseFile, 'fixture-passphrase-for-encrypted-backups', { mode: 0o400 });
  const jobs = path.join(root, 'jobs'); await mkdir(jobs, { mode: 0o700 });
  const calls = []; let dataPlaneDrills = 0;
  const run = async (command, args, options) => {
    calls.push({ command, args, env: options?.env });
    if (command === 'docker') return { stdout: args[0] === 'inspect' ? '1'.repeat(64) : JSON.stringify([{ Name: config.jobsVolume, Mountpoint: jobs }]) };
    if (args.includes('fence-capture')) {
      if (fenceFails) throw new Error('fixture-daemon-unavailable');
      return { stdout: JSON.stringify({ status: 'stopped',
        container: args[args.indexOf('--container') + 1], operation: args[args.indexOf('--operation') + 1], admissionFenced: true }) };
    }
    if (args.includes('capture-member')) {
      const directory = args.at(-1); await mkdir(directory, { recursive: true, mode: 0o700 });
      const archive = path.join(directory, 'postgres.dump.enc'); await writeFile(archive, 'encrypted-fixture', { mode: 0o600 });
      const receipt = path.join(directory, 'postgres.dump.enc.capture.json');
      await writeFile(receipt, JSON.stringify({ schemaVersion: 1, status: 'captured', archive: 'postgres.dump.enc',
        archiveSha256: createHash('sha256').update('encrypted-fixture').digest('hex'), snapshotId: '00000001-00000001-1',
        sourceIdentity: { database: 'evimed', databaseOid: '1', systemIdentifier: '2' }, atomicAcrossComponents: false,
        fileReferences: NAMED }), { mode: 0o600 });
      return { stdout: JSON.stringify({ status: 'captured', archive, receipt }) };
    }
    if (args[0].endsWith('backup-data.sh')) {
      const directory = args.at(-1); await mkdir(directory, { recursive: true, mode: 0o700 });
      const archive = path.join(directory, 'open-science-data-20261001T080000Z.tar.gz.enc');
      await writeFile(archive, 'encrypted-member', { mode: 0o600 }); await writeFile(`${archive}.sha256`,
        `${createHash('sha256').update('encrypted-member').digest('hex')}  ${path.basename(archive)}\n`, { mode: 0o600 });
      return { stdout: `${archive}\n`, stderr: '' };
    }
    if (args[0].endsWith('vcr-restore-drill.mjs')) {
      if (drillFails) throw new Error('fixture-drill-failed');
      const references = args.includes('--references') ? drills[Math.min(dataPlaneDrills++, drills.length - 1)] : undefined;
      return { stdout: JSON.stringify({ verification: 'inventory-v1', numericOwnersVerified: true, files: 2, ...(references ? { references } : {}) }) };
    }
    throw new Error('Unexpected fixture command');
  };
  return { config, calls, dependencies: { run, rootCheck: () => {}, jobsOwnerCheck: async () => {} },
    status: async () => JSON.parse(await readFile(path.join(config.statusDir, 'state.json'), 'utf8')) };
}

test('one recovery set takes the PG snapshot first, then both encrypted roots, and verifies the files against the dump', async t => {
  const { config, calls, dependencies, status } = await fixture(t);
  const result = await runVcrBackupCycle(config, dependencies);
  assert.equal(result.status, 'healthy');
  assert.equal(result.atomicAcrossComponents, false);
  assert.equal(result.consistency, 'references-verified');
  assert.deepEqual(result.references, { checked: NAMED.length, missing: 0, mismatched: 0 });
  assert.equal(result.postgres.snapshotId, '00000001-00000001-1');
  assert.deepEqual(Object.keys(result.members), ['data-plane', 'jobs']);
  const backups = calls.filter(call => call.args?.[0]?.endsWith('backup-data.sh'));
  assert.equal(backups.length, 2);
  // Both roots are written while the capture runs, and strict refuses a tree that changes.
  assert.ok(backups.every(call => call.env.OPEN_SCIENCE_BACKUP_STRICT === 'false'));
  assert.ok(backups.every(call => call.env.OPEN_SCIENCE_BACKUP_PASSPHRASE_FILE === config.passphraseFile));
  assert.equal(calls.filter(call => call.args?.includes('capture-member')).length, 1);
  assert.ok(calls.findIndex(call => call.args?.includes('capture-member')) < calls.findIndex(call => call.args?.[0]?.endsWith('backup-data.sh')),
    'the files are archived after the dump, never before it');
  const capture = calls.find(call => call.args?.includes('capture-member'));
  assert.equal(capture.env.EVIMED_RECOVERY_SET_STAGING_ROOT, path.join(config.backupDir, result.recoverySet));
  // Only the data-plane archive is held against the dump's references, and against that dump's receipt.
  const drills = calls.filter(call => call.args?.[0]?.endsWith('vcr-restore-drill.mjs'));
  assert.equal(drills.length, 2);
  assert.deepEqual(drills[0].args.slice(2), ['--references', path.join(config.backupDir, result.recoverySet, 'postgres', 'postgres.dump.enc.capture.json')]);
  assert.deepEqual(drills[1].args.slice(2), []);
  const state = await status();
  assert.equal(state.status, 'healthy');
  assert.equal(state.consistency, 'references-verified');
  assert.deepEqual(state.coverage, ['data-plane', 'jobs']);
  assert.equal(JSON.stringify(state).includes(config.dataPlaneDir), false);
});

// The 2026-10-05 failure: a research run or a learning consolidation in flight at
// 02:30 failed the unit, and with it readiness. Nothing in the cycle consults the
// platform any more, so there is no state of it that can fail the set.
test('a busy platform changes nothing: the cycle takes no lease, asks no question, and the set is healthy', async t => {
  const { config, calls, dependencies } = await fixture(t);
  assert.equal(Object.hasOwn(dependencies, 'maintenance'), false);
  assert.equal((await runVcrBackupCycle(config, dependencies)).status, 'healthy');
  assert.ok(calls.every(call => call.command !== 'docker' || ['inspect', 'volume'].includes(call.args[0])),
    'the only Docker calls are the container id and the volume path, never an exec into the application');
  assert.equal(calls.some(call => call.action), false);
});

test('a file the dump names that is gone from the archive is taken again, and the attempt that lost it is not kept', async t => {
  const { config, dependencies, status } = await fixture(t, { drills: [{ checked: NAMED.length, missing: 1, mismatched: 0 }, { checked: NAMED.length, missing: 0, mismatched: 0 }] });
  const result = await runVcrBackupCycle(config, dependencies);
  assert.equal(result.status, 'healthy');
  const directories = await readdir(config.backupDir);
  assert.deepEqual(directories, [result.recoverySet], 'the first attempt was incomplete by our own check and is removed');
  assert.equal((await status()).status, 'healthy');
});

test('files that keep being deleted defer the set: no failure, readiness-visible, the last good time carried, nothing kept', async t => {
  const { config, calls, dependencies, status } = await fixture(t, { drills: [{ checked: NAMED.length, missing: 2, mismatched: 0 }] });
  await runVcrBackupCycle(config, dependencies);
  const first = await status();
  assert.equal(first.status, 'deferred', 'the very first run, with nothing earlier to carry');
  assert.equal(first.lastSuccessAt, null);
  // An earlier healthy set's time rides through the deferral.
  await writeFile(path.join(config.statusDir, 'state.json'), JSON.stringify({ schemaVersion: 1, status: 'healthy', lastSuccessAt: '2026-10-04T18:40:00.000Z' }), { mode: 0o644 });
  const result = await runVcrBackupCycle(config, dependencies);
  assert.deepEqual(result, { status: 'deferred', missing: 2, attempts: 3 });
  const state = await status();
  assert.equal(state.status, 'deferred');
  assert.equal(state.code, 'vcr_backup_references_missing');
  assert.equal(state.lastSuccessAt, '2026-10-04T18:40:00.000Z');
  assert.equal(state.attempts, 3);
  assert.deepEqual(await readdir(config.backupDir), []);
  // Three captures per run, not an unbounded loop inside a unit with a timeout.
  assert.equal(calls.filter(call => call.args?.includes('capture-member')).length, 6);
});

test('a file with other bytes than its row names fails the cycle at once, and is never retried or deferred', async t => {
  const { config, calls, dependencies, status } = await fixture(t, { drills: [{ checked: NAMED.length, missing: 0, mismatched: 1 }] });
  await assert.rejects(runVcrBackupCycle(config, dependencies), { code: 'vcr_backup_reference_mismatch' });
  assert.equal(calls.filter(call => call.args?.includes('capture-member')).length, 1);
  assert.deepEqual(await status(), { schemaVersion: 1, status: 'failed', lastAttemptAt: (await status()).lastAttemptAt, code: 'vcr_backup_reference_mismatch' });
});

test('a drill that did not count the files the dump names is not a verification', async t => {
  const { config, dependencies, status } = await fixture(t, { drills: [{ checked: 1, missing: 0, mismatched: 0 }] });
  await assert.rejects(runVcrBackupCycle(config, dependencies), { code: 'vcr_backup_drill_invalid' });
  assert.equal((await status()).status, 'failed');
});

test('a dump whose receipt does not say which files it names is refused, not certified without the check', async t => {
  const { config, dependencies, status } = await fixture(t);
  const run = dependencies.run;
  dependencies.run = async (command, args, options) => {
    const result = await run(command, args, options);
    if (args.includes('capture-member')) {
      const receipt = JSON.parse(await readFile(args.at(-1) + '/postgres.dump.enc.capture.json', 'utf8'));
      delete receipt.fileReferences;
      await writeFile(args.at(-1) + '/postgres.dump.enc.capture.json', JSON.stringify(receipt), { mode: 0o600 });
    }
    return result;
  };
  await assert.rejects(runVcrBackupCycle(config, dependencies), { code: 'vcr_backup_references_invalid' });
  assert.equal((await status()).status, 'failed');
});

for (const setting of ['drillFails']) test(`failed ${setting} never publishes healthy coverage`, async t => {
  const { config, dependencies, status } = await fixture(t, { [setting]: true });
  await assert.rejects(runVcrBackupCycle(config, dependencies));
  assert.equal((await status()).status, 'failed');
});

test('retention preserves the latest two complete recovery sets and incomplete usable captures', async t => {
  const { config, dependencies } = await fixture(t);
  await mkdir(path.join(config.backupDir, 'vcr-backup-00000000-0000-0000-0000-000000000000'), { recursive: true, mode: 0o700 });
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

test('stopping during capture cancels the process and records failure', async t => {
  const { config, dependencies, status } = await fixture(t);
  const controller = new AbortController();
  let captureStarted;
  const started = new Promise(resolve => { captureStarted = resolve; });
  const previousRun = dependencies.run;
  const run = async (command, args, options) => {
    if (!args.includes('capture-member')) return previousRun(command, args, options);
    captureStarted();
    assert.ok(options?.signal, 'the physical capture must receive the stop signal');
    return new Promise((resolve, reject) => {
      const abort = () => reject(Object.assign(new Error('stopped fixture process'), { code: 'ABORT_ERR' }));
      if (options?.signal?.aborted) abort();
      else options?.signal?.addEventListener('abort', abort, { once: true });
    });
  };
  const task = runVcrBackupCycle(config, { ...dependencies, run, signal: controller.signal });
  const rejected = assert.rejects(task, { code: 'vcr_backup_canceled' });
  await started;
  controller.abort();
  await rejected;
  const state = await status();
  assert.equal(state.status, 'failed');
  assert.equal(state.code, 'vcr_backup_canceled');
});

test('an unconfirmed daemon-side stop is a failure that names it, and no deferral or retry hides it', async t => {
  const { config, calls, dependencies, status } = await fixture(t, { fenceFails: true });
  await assert.rejects(runVcrBackupCycle(config, dependencies), { code: 'vcr_backup_capture_stop_unconfirmed' });
  assert.equal(calls.filter(call => call.args?.includes('capture-member')).length, 1);
  const state = await status();
  assert.equal(state.status, 'failed');
  assert.equal(state.code, 'vcr_backup_capture_stop_unconfirmed');
});
