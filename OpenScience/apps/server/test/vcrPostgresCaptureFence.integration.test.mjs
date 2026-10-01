import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const execute = promisify(execFile);
const context = process.env.OPEN_SCIENCE_TEST_VCR_DOCKER_CONTEXT;
const ops = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../scripts/ops');
const script = path.join(ops, 'postgres-backup.py');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('real Docker exec writers and PostgreSQL backends stop before the fence acknowledges, and late admission stays refused',
  { skip: !context ? 'OPEN_SCIENCE_TEST_VCR_DOCKER_CONTEXT is not configured' : false, timeout: 30000 }, async t => {
    const nonce = randomUUID().replaceAll('-', '');
    const docker = async args => execute('docker', ['--context', context, ...args], { timeout: 10000, maxBuffer: 65536 });
    const container = (await docker(['run', '-d', '--name', `evimed-vcr-fence-test-${nonce.slice(0, 12)}`,
      '--label', `evimed.vcr-fence-test=${nonce}`, '--network', 'none', '--cpus', '0.5', '--memory', '256m', '--pids-limit', '128',
      '--tmpfs', '/var/lib/postgresql/data:rw,nosuid,nodev,size=128m', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust',
      '-e', 'POSTGRES_DB=evimed', '-e', 'POSTGRES_USER=evimed', 'postgres:16.14-bookworm'])).stdout.trim();
    assert.match(container, /^[a-f0-9]{64}$/);
    t.after(async () => {
      const label = (await docker(['inspect', '--format', '{{index .Config.Labels "evimed.vcr-fence-test"}}', container])).stdout.trim();
      assert.equal(label, nonce);
      await docker(['rm', '-f', container]);
    });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        const logs = await docker(['logs', container]);
        if (!logs.stdout.includes('PostgreSQL init process complete; ready for start up')) throw new Error('initializing');
        await docker(['exec', container, 'pg_isready', '-U', 'evimed', '-d', 'evimed']); break;
      }
      catch { await pause(100); }
    }
    const constants = JSON.parse((await execute('python3', ['-c',
      'import importlib.util,json,sys; s=importlib.util.spec_from_file_location("pg",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(json.dumps({"init":m.CAPTURE_INIT,"admit":m.CAPTURE_ADMIT,"supervisor":m.CAPTURE_SUPERVISOR}))', script])).stdout);
    await docker(['exec', container, 'psql', '-X', '-qAt', '-U', 'evimed', '-d', 'evimed', '-c',
      'CREATE TABLE public.capture_fixture(id integer PRIMARY KEY); INSERT INTO public.capture_fixture VALUES (1),(2);']);
    const recoveryRoot = await mkdtemp(path.join(await realpath(os.tmpdir()), 'vcr-pg-capture-'));
    t.after(() => rm(recoveryRoot, { recursive: true, force: true }));
    const output = path.join(recoveryRoot, 'postgres'); await mkdir(output);
    const phrase = path.join(recoveryRoot, 'phrase');
    await writeFile(phrase, 'synthetic isolated PostgreSQL capture fixture passphrase\n', { mode: 0o400 });
    const successOperation = randomUUID().replaceAll('-', '');
    const captureEnvironment = { ...process.env, DOCKER_CONTEXT: context, EVIMED_POSTGRES_CONTAINER: container,
      EVIMED_POSTGRES_DATABASE: 'evimed', EVIMED_POSTGRES_USER: 'evimed', EVIMED_POSTGRES_PASSPHRASE_FILE: phrase,
      EVIMED_RECOVERY_SET_STAGING_ROOT: recoveryRoot, EVIMED_POSTGRES_CAPTURE_OPERATION_ID: successOperation };
    const captured = JSON.parse((await execute('python3', [script, 'capture-member', '--output-dir', output],
      { env: captureEnvironment, timeout: 10000, maxBuffer: 65536 })).stdout);
    assert.equal(captured.status, 'captured');
    const receipt = JSON.parse(await readFile(captured.receipt, 'utf8'));
    assert.ok(receipt.tables.some(row => row.table === 'capture_fixture' && row.rows === '2'));
    assert.match(receipt.archiveSha256, /^[a-f0-9]{64}$/);
    await execute('python3', [script, 'fence-capture', '--container', container, '--operation', successOperation],
      { env: captureEnvironment, timeout: 10000, maxBuffer: 65536 });
    const operation = randomUUID().replaceAll('-', '');
    const app = `evimed_vcr_capture_${operation}`;
    const sentinelApp = `unrelated_fixture_${nonce.slice(0, 12)}`;
    const sentinel = spawn('docker', ['--context', context, 'exec', '--env', `PGAPPNAME=${sentinelApp}`, container,
      'psql', '-X', '-qAt', '-U', 'evimed', '-d', 'evimed', '-c', 'SELECT pg_sleep(60);'], { stdio: ['ignore', 'ignore', 'pipe'] });
    t.after(() => sentinel.kill('SIGKILL'));
    let sentinelDiagnostics = '';
    sentinel.stderr.on('data', chunk => { sentinelDiagnostics = (sentinelDiagnostics + chunk.toString()).slice(-2000); });
    const sql = async text => (await docker(['exec', container, 'psql', '-X', '-qAt', '-U', 'evimed', '-d', 'evimed', '-c', text])).stdout.trim();
    const sentinelCount = async () => Number(await sql(`SELECT count(*) FROM pg_stat_activity WHERE application_name='${sentinelApp}';`));
    for (let attempt = 0; attempt < 30 && await sentinelCount() !== 1; attempt += 1) await pause(50);
    assert.equal(await sentinelCount(), 1, sentinelDiagnostics);
    const postmasterBefore = await sql('SELECT pg_postmaster_start_time()::text;');
    const postmasterPidBefore = (await docker(['exec', container, 'head', '-n', '1', '/var/lib/postgresql/data/postmaster.pid'])).stdout.trim();
    await docker(['exec', '--user', '0:0', container, 'sh', '-c', constants.init, 'fixture-init', operation]);
    const marker = `/tmp/vcr-fence-marker-${operation}`;
    const managed = ['--context', context, 'exec', '--user', '0:0', '--env', `PGAPPNAME=${app}`, '--env', `EVIMED_CAPTURE_SUPERVISOR=${operation}`, container,
      'sh', '-c', constants.admit, 'evimed-managed-capture', operation, constants.supervisor];
    const clients = [
      spawn('docker', [...managed, 'sh', '-c', 'trap "" TERM; while :; do printf x >> "$1"; sleep 0.02; done', 'writer', marker], { stdio: ['ignore', 'ignore', 'pipe'] }),
      spawn('docker', [...managed, 'psql', '-X', '-qAt', '-U', 'evimed', '-d', 'evimed', '-c', 'SELECT pg_sleep(60);'], { stdio: ['ignore', 'ignore', 'pipe'] }),
    ];
    let diagnostics = '';
    for (const child of clients) child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-4000); });
    t.after(() => { for (const child of clients) child.kill('SIGKILL'); });
    const markerSize = async () => Number((await docker(['exec', container, 'stat', '-c', '%s', marker])).stdout.trim());
    const active = async () => Number((await docker(['exec', container, 'psql', '-X', '-qAt', '-U', 'evimed', '-d', 'evimed', '-c',
      `SELECT count(*) FROM pg_stat_activity WHERE application_name='${app}';`])).stdout.trim());
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try { if (await markerSize() > 0 && await active() > 0) break; } catch { /* Wait for the two actual execs. */ }
      await pause(50);
    }
    assert.ok(await active() > 0, diagnostics);
    for (const child of clients) child.kill('SIGKILL');
    const beforeFence = await markerSize(); await pause(100);
    assert.ok(await markerSize() > beforeFence, 'killing docker clients alone must reproduce a live daemon-side writer');
    const result = await execute('python3', [script, 'fence-capture', '--container', container, '--operation', operation], {
      env: { ...process.env, DOCKER_CONTEXT: context, EVIMED_POSTGRES_DATABASE: 'evimed', EVIMED_POSTGRES_USER: 'evimed' },
      timeout: 15000, maxBuffer: 65536,
    });
    assert.deepEqual(JSON.parse(result.stdout), { status: 'stopped', container, operation, admissionFenced: true });
    assert.equal(await active(), 0);
    assert.equal(await sentinelCount(), 1, sentinelDiagnostics);
    assert.equal(sentinel.exitCode, null, 'the unrelated live Docker client must survive');
    assert.equal(await sql('SELECT pg_postmaster_start_time()::text;'), postmasterBefore);
    assert.equal((await docker(['exec', container, 'head', '-n', '1', '/var/lib/postgresql/data/postmaster.pid'])).stdout.trim(), postmasterPidBefore);
    const finalLogs = await docker(['logs', container]);
    assert.doesNotMatch(finalLogs.stdout + finalLogs.stderr, /terminating any other active server processes|was terminated by signal|database system was interrupted|automatic recovery in progress/);
    const stoppedSize = await markerSize(); await pause(100);
    assert.equal(await markerSize(), stoppedSize);
    await assert.rejects(docker(['exec', '--user', '0:0', '--env', `PGAPPNAME=${app}`, '--env', `EVIMED_CAPTURE_SUPERVISOR=${operation}`, container,
      'sh', '-c', constants.admit, 'evimed-managed-capture', operation, constants.supervisor, 'sh', '-c', 'printf bad >> "$1"', 'late', marker]));
    assert.equal(await markerSize(), stoppedSize);
  });
