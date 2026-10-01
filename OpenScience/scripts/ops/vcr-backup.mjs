// Host-only member of the existing PostgreSQL backup timer. No Docker
// authority, patient rows or database credentials enter the web/backup image.
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { runVcrBackupProcess } from './vcr-backup-process.mjs';

const ops = path.dirname(fileURLToPath(import.meta.url));
const archiveName = /^open-science-data-\d{8}T\d{6}Z\.tar\.gz\.enc$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const error = code => Object.assign(new Error(code), { code });

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Read only host configuration; absent means no new backup path or authority. */
export function vcrBackupConfig(env = process.env) {
  if (!['1', 'true', 'yes'].includes(String(env.OPEN_SCIENCE_VCR_BACKUP_ENABLED ?? '').toLowerCase())) return { enabled: false };
  const required = name => {
    const value = String(env[name] ?? '').trim();
    if (!value || !path.isAbsolute(value) || path.resolve(value) !== value) throw error('vcr_backup_configuration_invalid');
    return value;
  };
  const config = { enabled: true,
    dataPlaneDir: required('OPEN_SCIENCE_VCR_DATA_PLANE_HOST_DIR'), backupDir: required('OPEN_SCIENCE_VCR_BACKUP_DIR'),
    statusDir: required('OPEN_SCIENCE_VCR_BACKUP_STATUS_HOST_DIR'), tokenFile: required('OPEN_SCIENCE_OPERATOR_METRICS_TOKEN_HOST_FILE'),
    passphraseFile: required('OPEN_SCIENCE_BACKUP_PASSPHRASE_FILE'),
    jobsVolume: String(env.OPEN_SCIENCE_VCR_JOBS_VOLUME ?? 'web_evimed-vcr-jobs'),
    operatorUrl: String(env.OPEN_SCIENCE_VCR_BACKUP_OPERATOR_URL || 'http://127.0.0.1:8787'),
    operatorProject: String(env.EVIMED_COMPOSE_PROJECT || 'web'), drainSeconds: 60,
    maxSets: Number(env.OPEN_SCIENCE_VCR_BACKUP_MAX_SETS ?? 2) };
  const url = new URL(config.operatorUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw error('vcr_backup_operator_loopback_required');
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(config.jobsVolume)) throw error('vcr_backup_configuration_invalid');
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(config.operatorProject)) throw error('vcr_backup_configuration_invalid');
  if (!Number.isSafeInteger(config.maxSets) || config.maxSets < 2 || config.maxSets > 32) throw error('vcr_backup_configuration_invalid');
  for (const left of [config.backupDir, config.statusDir]) {
    if (inside(config.dataPlaneDir, left) || inside(left, config.dataPlaneDir)) throw error('vcr_backup_paths_must_be_separate');
  }
  return config;
}

async function safeDirectory(directory, create = false) {
  let current = path.parse(directory).root;
  for (const part of directory.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (create) await fs.mkdir(current, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
    const info = await fs.lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw error('vcr_backup_directory_invalid');
    // A root-owned sticky ancestor such as /tmp cannot replace another
    // owner's private child. The configured directory itself stays private.
    if (info.mode & 0o022 && !(current !== directory && info.uid === 0 && info.mode & 0o1000)) throw error('vcr_backup_directory_writable');
  }
}

async function readRegular(file, { privateFile = false } = {}) {
  await safeDirectory(path.dirname(file));
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024 || info.size === 0
      || (info.mode & (privateFile ? 0o077 : 0o022))) throw error('vcr_backup_file_invalid');
    return await handle.readFile();
  } finally { await handle.close(); }
}

async function writeJson(file, value, mode = 0o600) {
  await safeDirectory(path.dirname(file), true);
  const present = await fs.lstat(file).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
  if (present && (!present.isFile() || present.nlink !== 1 || present.mode & 0o022)) throw error('vcr_backup_status_invalid');
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', mode);
  try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  await fs.rename(temporary, file);
  await fs.chmod(file, mode);
}

// The web instance already mounts its operator token. Docker authority stays
// with the host; this fixed program receives no credential bytes in argv and
// returns only maintenance state. Native HTTP follows no redirect or proxy.
export const VCR_OPERATOR_REQUEST_SCRIPT = String.raw`
const fs=require('node:fs'), http=require('node:http'), crypto=require('node:crypto');
const [url,action,encoded,expectedTokenHash,deadlineRaw]=process.argv.slice(1);
let ended=false,dispatched=false;
const fail=(acknowledged=false)=>{if(ended)return;ended=true;process.stdout.write(JSON.stringify({completed:acknowledged||!dispatched,code:'vcr_backup_maintenance_unavailable'}));};
try{
 const deadline=Number(deadlineRaw);
 if(!Number.isSafeInteger(deadline)||Date.now()>=deadline)throw Error();
 const parsed=new URL(url);
 if(parsed.protocol!=='http:'||parsed.hostname!=='127.0.0.1'||parsed.username||parsed.password||parsed.pathname!=='/'||parsed.search||parsed.hash)throw Error();
 if(!['status','request','hold','release'].includes(action))throw Error();
 const body=JSON.parse(encoded);
 if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['requestId','ttlSeconds'].includes(k)))throw Error();
 const file=process.env.OPEN_SCIENCE_OPERATOR_METRICS_TOKEN_FILE;
 if(!file||!file.startsWith('/'))throw Error();
 const token=fs.readFileSync(file,'utf8').trim();
 if(token.length<16||/[\r\n]/.test(token)||crypto.createHash('sha256').update(token).digest('hex')!==expectedTokenHash)throw Error();
 if(Date.now()>=deadline)throw Error();
 const req=http.request(new URL('/api/ops/maintenance',parsed),{method:action==='status'?'GET':'POST',
  headers:{authorization:'Bearer '+token,'content-type':'application/json'}},res=>{
  const chunks=[];let size=0;
  res.on('data',chunk=>{size+=chunk.length;if(size>65536)res.destroy();else chunks.push(chunk);});
  res.once('error',()=>fail());
  res.once('end',()=>{try{if(res.statusCode!==200){fail(true);return;}const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
   if(!value.data||typeof value.data!=='object'||Array.isArray(value.data))throw Error();
   if(!ended){ended=true;process.stdout.write(JSON.stringify({completed:true,data:value.data}));}
  }catch{fail(true);}});
 });
 const timer=setTimeout(()=>req.destroy(),Math.max(1,Math.min(10000,deadline-Date.now())));
 req.once('close',()=>clearTimeout(timer));req.once('error',()=>fail());
 dispatched=true;
 req.end(action==='status'?undefined:JSON.stringify({action,...body}));
}catch{fail();}`;

/** Pin one inspected live web identity for every request in a backup cycle. */
export async function createVcrBackupOperatorClient(config, signal, { run = runVcrBackupProcess, onUncertain = () => {} } = {}) {
  const token = (await readRegular(config.tokenFile, { privateFile: true })).toString('utf8').trim();
  if (token.length < 16 || /[\r\n]/.test(token)) throw error('vcr_backup_operator_token_invalid');
  const project = config.operatorProject ?? 'web';
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project)) throw error('vcr_backup_configuration_invalid');
  let identity;
  try {
    const inspected = await run('docker', ['inspect', '--type', 'container', '--format',
      '{"id":"{{.Id}}","running":{{.State.Running}},"service":"{{index .Config.Labels "com.docker.compose.service"}}","project":"{{index .Config.Labels "com.docker.compose.project"}}"}',
      `${project}-open-science-web-1`], { signal, timeout: 10000, maxBuffer: 4096 });
    identity = JSON.parse(inspected.stdout);
    if (!/^[a-f0-9]{64}$/.test(identity.id) || identity.running !== true
      || identity.service !== 'open-science-web' || identity.project !== project) throw Error();
  } catch (failure) {
    if (signal?.aborted) throw error('vcr_backup_canceled');
    if (failure.code === 'vcr_backup_process_stop_unconfirmed') throw failure;
    throw error('vcr_backup_maintenance_unavailable');
  }
  return async (action, body = {}) => {
    const actionSignal = action === 'release' ? null : signal;
    if (actionSignal?.aborted) throw error('vcr_backup_canceled');
    if (!['status', 'request', 'hold', 'release'].includes(action) || !body || typeof body !== 'object'
      || Array.isArray(body) || Object.keys(body).some(key => !['requestId', 'ttlSeconds'].includes(key))) throw error('vcr_backup_maintenance_invalid');
    let value;
    try {
      // Aborting Docker's client does not stop daemon-side exec. Await the
      // fixed program's bounded completion before cleanup can release a lease.
      const result = await run('docker', ['exec', identity.id, 'node', '-e', VCR_OPERATOR_REQUEST_SCRIPT,
        config.operatorUrl, action, JSON.stringify(body), hash(token), String(Date.now() + 10000)],
      { signal: null, timeout: 15000, maxBuffer: 65536 });
      value = JSON.parse(result.stdout);
      if (value.completed !== true) throw Error();
    } catch {
      onUncertain();
      throw error('vcr_backup_process_stop_unconfirmed');
    }
    if (actionSignal?.aborted) throw error('vcr_backup_canceled');
    if (value.code || !value.data || typeof value.data !== 'object' || Array.isArray(value.data)) throw error('vcr_backup_maintenance_unavailable');
    return value.data;
  };
}

function assertIdle(state, requestId) {
  if (state?.state !== 'idle' || state.lease?.requestId !== requestId || !state.blockers
    || Object.values(state.blockers).some(value => !Number.isSafeInteger(value) || value !== 0)) throw error('vcr_backup_not_quiescent');
}

async function jobsOwnerCheck(directory) {
  const info = await fs.stat(directory);
  if (info.uid !== 10001 || info.gid !== 10001) throw error('vcr_backup_jobs_owner_invalid');
}

async function archiveDigest(file) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size <= 0 || info.mode & 0o077) throw error('vcr_backup_archive_invalid');
    const digest = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk);
    const after = await handle.stat();
    if (info.size !== after.size || info.mtimeMs !== after.mtimeMs || info.ctimeMs !== after.ctimeMs) throw error('vcr_backup_archive_changed');
    return { sha256: digest.digest('hex'), bytes: info.size };
  } finally { await handle.close(); }
}

async function retainVerifiedSets(config, protectedSet) {
  const completed = [];
  for (const name of await fs.readdir(config.backupDir)) {
    if (!/^vcr-backup-[a-f0-9-]{36}$/.test(name)) continue;
    const directory = path.join(config.backupDir, name);
    await safeDirectory(directory);
    let receipt;
    try { receipt = JSON.parse((await readRegular(path.join(directory, 'recovery-set.json'), { privateFile: true })).toString('utf8')); }
    catch (failure) { if (failure.code === 'ENOENT') continue; throw failure; }
    if (receipt.status !== 'healthy' || receipt.recoverySet !== name || !Number.isFinite(Date.parse(receipt.captureFinishedAt))) {
      throw error('vcr_backup_retention_receipt_invalid');
    }
    completed.push({ name, directory, finishedAt: receipt.captureFinishedAt });
  }
  completed.sort((left, right) => right.finishedAt.localeCompare(left.finishedAt) || right.name.localeCompare(left.name));
  const keep = new Set([protectedSet, ...completed.slice(0, config.maxSets ?? 2).map(value => value.name)]);
  for (const entry of completed) if (!keep.has(entry.name)) await fs.rm(entry.directory, { recursive: true });
}

/** Test injections observe fixed operations; the production caller supplies none. */
export async function runVcrBackupCycle(config, dependencies = {}) {
  if (!config.enabled) return { status: 'off' };
  const rootCheck = dependencies.rootCheck ?? (() => { if (process.getuid?.() !== 0) throw error('vcr_backup_host_root_required'); });
  rootCheck();
  await safeDirectory(config.statusDir, true);
  const statusFile = path.join(config.statusDir, 'state.json');
  const started = new Date().toISOString();
  const signal = dependencies.signal ?? new AbortController().signal;
  let physicalStopUnconfirmed = false;
  const canceled = () => { if (signal.aborted) throw error('vcr_backup_canceled'); };
  const executeOperation = dependencies.run ?? runVcrBackupProcess;
  const run = async (command, args, options = {}) => {
    canceled();
    try { return await executeOperation(command, args, { ...options, signal }); }
    catch (failure) {
      if (failure.code === 'vcr_backup_process_stop_unconfirmed') physicalStopUnconfirmed = true;
      else canceled();
      throw failure;
    }
  };
  let jobsDir;
  let dataPlaneIdentity;
  let maintenance;
  try {
    await safeDirectory(config.dataPlaneDir);
    const planeStat = await fs.stat(config.dataPlaneDir);
    dataPlaneIdentity = hash(`${planeStat.dev}:${planeStat.ino}`);
    await safeDirectory(config.backupDir, true);
    await readRegular(config.passphraseFile, { privateFile: true });
    const volume = JSON.parse((await run('docker', ['volume', 'inspect', config.jobsVolume])).stdout);
    if (volume.length !== 1 || volume[0].Name !== config.jobsVolume || !path.isAbsolute(volume[0].Mountpoint)) throw error('vcr_backup_volume_invalid');
    jobsDir = volume[0].Mountpoint;
    await safeDirectory(jobsDir);
    await (dependencies.jobsOwnerCheck ?? jobsOwnerCheck)(jobsDir);
    if ([config.dataPlaneDir, config.backupDir, config.statusDir].some(root => inside(root, jobsDir) || inside(jobsDir, root))) throw error('vcr_backup_paths_must_be_separate');
    maintenance = dependencies.maintenance ?? await createVcrBackupOperatorClient(config, signal,
      { run: executeOperation, onUncertain: () => { physicalStopUnconfirmed = true; } });
  } catch (failure) {
    await writeJson(statusFile, { schemaVersion: 1, status: 'failed', lastAttemptAt: started, code: failure.code ?? 'vcr_backup_storage_unavailable' }, 0o644);
    throw failure;
  }
  const requestId = `vcr-backup-${randomUUID()}`;
  const directory = path.join(config.backupDir, requestId);
  let heartbeat;
  let heartbeatRunning = false;
  let heartbeatPending = null;
  let leaseError = null;
  let requested = false;
  let completed = null;
  const check = async () => { canceled(); if (leaseError) throw leaseError; assertIdle(await maintenance('status'), requestId); canceled(); };
  try {
    canceled();
    requested = true;
    const lease = await maintenance('request', { requestId, ttlSeconds: 3600 });
    if (lease?.lease?.requestId !== requestId) throw error('vcr_backup_lease_lost');
    heartbeat = (dependencies.setInterval ?? setInterval)(() => {
      if (heartbeatRunning || signal.aborted) return;
      heartbeatRunning = true;
      heartbeatPending = (async () => {
        try {
          const next = await maintenance('request', { requestId, ttlSeconds: 3600 });
          if (next?.lease?.requestId !== requestId) throw error('vcr_backup_lease_lost');
        } catch { leaseError = error('vcr_backup_lease_lost'); }
        finally { heartbeatRunning = false; }
      })();
    }, 30_000);
    const deadline = Date.now() + config.drainSeconds * 1000;
    while (true) {
      try { await check(); break; } catch (failure) {
        if (failure.code !== 'vcr_backup_not_quiescent' || Date.now() >= deadline) throw failure;
        await delay(1000, undefined, { signal });
      }
    }
    const protective = await maintenance('hold', { requestId });
    if (protective?.lease?.requestId !== requestId || protective.lease.durableHold !== true) throw error('vcr_backup_protective_hold_unconfirmed');
    await check();
    await safeDirectory(directory, true);
    const postgresDir = path.join(directory, 'postgres'); await safeDirectory(postgresDir, true);
    const container = (await run('docker', ['inspect', '--type', 'container', '--format', '{{.Id}}',
      process.env.EVIMED_POSTGRES_CONTAINER || 'web-evimed-postgres-1'])).stdout.trim();
    if (!/^[a-f0-9]{64}$/.test(container)) throw error('vcr_backup_postgres_container_invalid');
    const operation = randomUUID().replaceAll('-', '');
    // A crash-recovery operator can fence this exact physical intent before
    // releasing the persistent hold. No PID/name inference or new capture is
    // needed, and the private record contains no source rows or credentials.
    await writeJson(path.join(directory, 'capture-intent.json'), { schemaVersion: 1, requestId, container, operation });
    const captureEnv = { ...process.env, EVIMED_POSTGRES_PASSPHRASE_FILE: config.passphraseFile,
      EVIMED_RECOVERY_SET_STAGING_ROOT: directory, EVIMED_POSTGRES_CONTAINER: container, EVIMED_POSTGRES_CAPTURE_OPERATION_ID: operation };
    let postgres;
    try {
      postgres = JSON.parse((await run('python3', [path.join(ops, 'postgres-backup.py'), 'capture-member', '--output-dir', postgresDir],
        { env: captureEnv })).stdout);
    } finally {
      // Host group termination cannot prove that Docker's exec process or its
      // database backend stopped. Fence the admitted nonce in that exact
      // container even after cancellation; a late daemon exec must be refused.
      try {
        const fence = JSON.parse((await executeOperation('python3', [path.join(ops, 'postgres-backup.py'), 'fence-capture',
          '--container', container, '--operation', operation], { env: captureEnv, timeout: 60000 })).stdout);
        if (fence.status !== 'stopped' || fence.container !== container || fence.operation !== operation || fence.admissionFenced !== true) {
          throw error('vcr_backup_capture_stop_unconfirmed');
        }
      } catch {
        physicalStopUnconfirmed = true;
        throw error('vcr_backup_capture_stop_unconfirmed');
      }
    }
    if (postgres.status !== 'captured' || postgres.receipt !== path.join(postgresDir, 'postgres.dump.enc.capture.json')
      || postgres.archive !== path.join(postgresDir, 'postgres.dump.enc')) throw error('vcr_backup_postgres_capture_invalid');
    const pgReceipt = JSON.parse((await readRegular(postgres.receipt, { privateFile: true })).toString('utf8'));
    const pgDigest = await archiveDigest(postgres.archive);
    if (pgReceipt.status !== 'captured' || pgReceipt.archiveSha256 !== pgDigest.sha256 || !pgReceipt.snapshotId
      || !pgReceipt.sourceIdentity || pgReceipt.atomicAcrossComponents !== false) throw error('vcr_backup_postgres_capture_invalid');
    const members = {};
    for (const [name, root] of [['data-plane', config.dataPlaneDir], ['jobs', jobsDir]]) {
      await check();
      const target = path.join(directory, name); await safeDirectory(target, true);
      const env = { ...process.env, OPEN_SCIENCE_BACKUP_STRICT: 'true', OPEN_SCIENCE_BACKUP_PASSPHRASE: '',
        OPEN_SCIENCE_BACKUP_PASSPHRASE_FILE: config.passphraseFile, OPEN_SCIENCE_BACKUP_RETENTION_DAYS: '', OPEN_SCIENCE_OBJECT_BACKUP_URI: '' };
      const archive = (await run('bash', [path.join(ops, 'backup-data.sh'), root, target], { env })).stdout.trim().split(/\r?\n/).at(-1);
      if (path.dirname(archive) !== target || !archiveName.test(path.basename(archive))) throw error('vcr_backup_member_invalid');
      const digest = await archiveDigest(archive);
      const checksum = (await readRegular(`${archive}.sha256`, { privateFile: true })).toString('utf8');
      if (checksum !== `${digest.sha256}  ${path.basename(archive)}\n`) throw error('vcr_backup_member_invalid');
      const drill = JSON.parse((await run('node', [path.join(ops, 'vcr-restore-drill.mjs'), archive], { env })).stdout);
      if (drill.verification !== 'inventory-v1' || drill.numericOwnersVerified !== true) throw error('vcr_backup_drill_invalid');
      members[name] = { archive: `${name}/${path.basename(archive)}`, ...digest, drill };
    }
    await check();
    completed = { schemaVersion: 1, status: 'healthy', recoverySet: requestId, captureStartedAt: started,
      captureFinishedAt: new Date().toISOString(), consistency: 'maintenance-held', atomicAcrossComponents: false,
      postgres: { archive: 'postgres/postgres.dump.enc', ...pgDigest, sourceIdentity: pgReceipt.sourceIdentity, snapshotId: pgReceipt.snapshotId }, members };
    await writeJson(path.join(directory, 'recovery-set.json'), completed);
  } catch (failure) {
    const reason = signal.aborted && !physicalStopUnconfirmed ? error('vcr_backup_canceled') : failure;
    await writeJson(statusFile, { schemaVersion: 1, status: 'failed', lastAttemptAt: started, code: reason.code ?? 'vcr_backup_cycle_failed' }, 0o644);
    throw reason;
  } finally {
    (dependencies.clearInterval ?? clearInterval)(heartbeat);
    await heartbeatPending;
    if (requested && physicalStopUnconfirmed) {
      await writeJson(statusFile, { schemaVersion: 1, status: 'failed', lastAttemptAt: started,
        code: 'vcr_backup_capture_stop_unconfirmed', maintenanceHeld: true }, 0o644);
      throw error('vcr_backup_capture_stop_unconfirmed');
    }
    if (requested) {
      try { await maintenance('release', { requestId }); }
      catch {
        await writeJson(statusFile, { schemaVersion: 1, status: 'failed', lastAttemptAt: started, code: 'vcr_backup_lease_release_failed' }, 0o644);
        throw error('vcr_backup_lease_release_failed');
      }
    }
  }
  try { await retainVerifiedSets(config, requestId); }
  catch {
    await writeJson(statusFile, { schemaVersion: 1, status: 'failed', lastAttemptAt: started, code: 'vcr_backup_retention_failed' }, 0o644);
    throw error('vcr_backup_retention_failed');
  }
  await writeJson(statusFile, { schemaVersion: 1, status: 'healthy', recoverySet: requestId,
    lastSuccessAt: completed.captureFinishedAt, lastDrillAt: completed.captureFinishedAt, coverage: Object.keys(completed.members),
    numericOwnersVerified: true, consistency: completed.consistency, atomicAcrossComponents: false,
    postgresSnapshotId: completed.postgres.snapshotId, dataPlaneIdentity,
    receiptSha256: hash(Buffer.from(`${JSON.stringify(completed)}\n`)) }, 0o644);
  return completed;
}
