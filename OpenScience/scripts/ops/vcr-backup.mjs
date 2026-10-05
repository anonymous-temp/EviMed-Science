// Host-only member of the existing PostgreSQL backup timer. No Docker
// authority, patient rows or database credentials enter the web/backup image.
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runVcrBackupProcess } from './vcr-backup-process.mjs';
import { parseFileReferences } from './vcr-backup-references.mjs';

const ops = path.dirname(fileURLToPath(import.meta.url));
const archiveName = /^open-science-data-\d{8}T\d{6}Z\.tar\.gz\.enc$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const error = code => Object.assign(new Error(code), { code });
/** A capture receipt carries every data-plane file its dump names (200 thousand at most, about 200 bytes each). */
const RECEIPT_LIMIT = 64 * 1024 * 1024;
/**
 * How many times one run of the cycle takes the set again when a file the dump
 * names was deleted before the file archive was read. A deletion is a researcher
 * removing an upload or a study, so two in a row is already unusual; past this the
 * set is deferred (see \`runVcrBackupCycle\`), not retried until the unit times out.
 */
export const VCR_BACKUP_ATTEMPTS = 3;

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
  // No operator token, URL or compose project: the cycle no longer asks the
  // running application for anything (see \`runVcrBackupCycle\`), so a deployment's
  // old values for them are simply not read.
  const config = { enabled: true,
    dataPlaneDir: required('OPEN_SCIENCE_VCR_DATA_PLANE_HOST_DIR'), backupDir: required('OPEN_SCIENCE_VCR_BACKUP_DIR'),
    statusDir: required('OPEN_SCIENCE_VCR_BACKUP_STATUS_HOST_DIR'),
    passphraseFile: required('OPEN_SCIENCE_BACKUP_PASSPHRASE_FILE'),
    jobsVolume: String(env.OPEN_SCIENCE_VCR_JOBS_VOLUME ?? 'web_evimed-vcr-jobs'),
    maxSets: Number(env.OPEN_SCIENCE_VCR_BACKUP_MAX_SETS ?? 2) };
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(config.jobsVolume)) throw error('vcr_backup_configuration_invalid');
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

async function readRegular(file, { privateFile = false, limit = 1024 * 1024 } = {}) {
  await safeDirectory(path.dirname(file));
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > limit || info.size === 0
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

/** The last status the cycle wrote, or null: only its `lastSuccessAt` is read, to carry it through a deferral. */
async function previousStatus(file) {
  try { return JSON.parse((await readRegular(file)).toString('utf8')); } catch { return null; }
}

/**
 * One recovery set: a PostgreSQL dump, then the data plane and the jobs volume,
 * with the files held against what the dump names. Runs while the platform runs.
 *
 * Why this no longer asks for a quiet platform, in two sentences. The dump is one
 * exported snapshot, and every file a row of it names was written before that row
 * (and is never rewritten in place: it is named by the hash of its bytes, or created
 * once, or replaced by rename), so a file archive taken *after* the dump holds
 * every file the dump names unless one was deleted in between. That one case is not
 * assumed away but checked: the dump records the files it names and the restore
 * drill of the data-plane archive confirms each is there with the bytes it names
 * (`vcr-backup-references.mjs`), so a set that is marked healthy is restorable
 * whatever the platform was doing, and a set where a deletion raced is taken again.
 *
 * What the quiet window used to be for, and why it is gone: it made all three
 * members one instant (and let the data-plane archive be strict, which refuses a
 * tree that changes), at the price of refusing every mutation platform-wide for the
 * duration and failing the whole unit — and with it readiness — whenever a
 * research run or a learning consolidation was in flight. The jobs volume needs
 * nothing from it: it is the engine's working state, not a record the dump names (a
 * job the restored database calls running and the engine no longer has is
 * submitted again; the engine answers 404 and the queue does that already). The
 * one thing the window did that this does not is stop the platform from deleting
 * a file mid-capture, and that costs a retry, not a lie.
 *
 * Outcomes, three and kept apart. \`healthy\`: a verified set. \`failed\`: something
 * this host owns did not work (a directory, the passphrase, Docker, an archive or a
 * file with the wrong bytes) and an operator should look. \`deferred\`: the set could
 * not be completed because files the dump names kept being deleted under it; the
 * PostgreSQL archive made by the unit's first step is untouched, readiness reports
 * the state as a detail rather than a failure, and the next run takes the set again.
 *
 * Test injections observe fixed operations; the production caller supplies none.
 */
export async function runVcrBackupCycle(config, dependencies = {}) {
  if (!config.enabled) return { status: 'off' };
  const rootCheck = dependencies.rootCheck ?? (() => { if (process.getuid?.() !== 0) throw error('vcr_backup_host_root_required'); });
  rootCheck();
  await safeDirectory(config.statusDir, true);
  const statusFile = path.join(config.statusDir, 'state.json');
  const previous = await previousStatus(statusFile);
  const started = new Date().toISOString();
  const signal = dependencies.signal ?? new AbortController().signal;
  const attempts = dependencies.attempts ?? VCR_BACKUP_ATTEMPTS;
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
  const failed = async failure => {
    const reason = signal.aborted && !physicalStopUnconfirmed ? error('vcr_backup_canceled') : failure;
    await writeJson(statusFile, { schemaVersion: 1, status: 'failed', lastAttemptAt: started, code: reason.code ?? 'vcr_backup_cycle_failed' }, 0o644);
    return reason;
  };
  let jobsDir;
  let dataPlaneIdentity;
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
  } catch (failure) {
    await writeJson(statusFile, { schemaVersion: 1, status: 'failed', lastAttemptAt: started, code: failure.code ?? 'vcr_backup_storage_unavailable' }, 0o644);
    throw failure;
  }

  /** One attempt at the whole set, in its own directory. */
  const captureSet = async (requestId, directory) => {
    await safeDirectory(directory, true);
    const postgresDir = path.join(directory, 'postgres'); await safeDirectory(postgresDir, true);
    const container = (await run('docker', ['inspect', '--type', 'container', '--format', '{{.Id}}',
      process.env.EVIMED_POSTGRES_CONTAINER || 'web-evimed-postgres-1'])).stdout.trim();
    if (!/^[a-f0-9]{64}$/.test(container)) throw error('vcr_backup_postgres_container_invalid');
    const operation = randomUUID().replaceAll('-', '');
    // A crash-recovery operator can fence this exact physical intent. No
    // PID/name inference or new capture is needed, and the private record
    // contains no source rows or credentials.
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
    const pgReceipt = JSON.parse((await readRegular(postgres.receipt, { privateFile: true, limit: RECEIPT_LIMIT })).toString('utf8'));
    const pgDigest = await archiveDigest(postgres.archive);
    if (pgReceipt.status !== 'captured' || pgReceipt.archiveSha256 !== pgDigest.sha256 || !pgReceipt.snapshotId
      || !pgReceipt.sourceIdentity || pgReceipt.atomicAcrossComponents !== false) throw error('vcr_backup_postgres_capture_invalid');
    // A receipt that cannot say which files its dump names cannot be held against
    // them: refused here rather than certified without the check.
    const named = parseFileReferences(pgReceipt);
    const members = {};
    let references = { checked: named.length, missing: 0, mismatched: 0 };
    // The files come after the dump, never before: a file the dump names was
    // already there, while one created since is simply not named by it.
    for (const [name, root] of [['data-plane', config.dataPlaneDir], ['jobs', jobsDir]]) {
      canceled();
      const target = path.join(directory, name); await safeDirectory(target, true);
      // Not strict: both roots are written while this runs, and strict refuses
      // a tree that changes. What would make a live copy wrong is checked
      // against the dump below instead of being excluded by stopping the writers.
      const env = { ...process.env, OPEN_SCIENCE_BACKUP_STRICT: 'false', OPEN_SCIENCE_BACKUP_PASSPHRASE: '',
        OPEN_SCIENCE_BACKUP_PASSPHRASE_FILE: config.passphraseFile, OPEN_SCIENCE_BACKUP_RETENTION_DAYS: '', OPEN_SCIENCE_OBJECT_BACKUP_URI: '' };
      const archive = (await run('bash', [path.join(ops, 'backup-data.sh'), root, target], { env })).stdout.trim().split(/\r?\n/).at(-1);
      if (path.dirname(archive) !== target || !archiveName.test(path.basename(archive))) throw error('vcr_backup_member_invalid');
      const digest = await archiveDigest(archive);
      const checksum = (await readRegular(`${archive}.sha256`, { privateFile: true })).toString('utf8');
      if (checksum !== `${digest.sha256}  ${path.basename(archive)}\n`) throw error('vcr_backup_member_invalid');
      const drill = JSON.parse((await run('node', [path.join(ops, 'vcr-restore-drill.mjs'), archive,
        ...(name === 'data-plane' ? ['--references', postgres.receipt] : [])], { env })).stdout);
      if (drill.verification !== 'inventory-v1' || drill.numericOwnersVerified !== true) throw error('vcr_backup_drill_invalid');
      if (name === 'data-plane') {
        const checked = drill.references;
        if (!checked || checked.checked !== named.length || !Number.isSafeInteger(checked.missing) || !Number.isSafeInteger(checked.mismatched)) {
          throw error('vcr_backup_drill_invalid');
        }
        references = { checked: checked.checked, missing: checked.missing, mismatched: checked.mismatched };
        // Bytes that are not the bytes a row names are not a race: nothing
        // writes such a file. The set is not certified and an operator is told.
        if (checked.mismatched > 0) throw error('vcr_backup_reference_mismatch');
        if (checked.missing > 0) throw Object.assign(error('vcr_backup_references_missing'), { missing: checked.missing });
      }
      members[name] = { archive: `${name}/${path.basename(archive)}`, ...digest, drill };
    }
    const completed = { schemaVersion: 1, status: 'healthy', recoverySet: requestId, captureStartedAt: started,
      captureFinishedAt: new Date().toISOString(), consistency: 'references-verified', atomicAcrossComponents: false,
      references,
      postgres: { archive: 'postgres/postgres.dump.enc', ...pgDigest, sourceIdentity: pgReceipt.sourceIdentity, snapshotId: pgReceipt.snapshotId }, members };
    await writeJson(path.join(directory, 'recovery-set.json'), completed);
    return completed;
  };

  let completed = null;
  let missing = 0;
  let taken = 0;
  while (!completed && taken < attempts) {
    canceled();
    taken += 1;
    const requestId = `vcr-backup-${randomUUID()}`;
    const directory = path.join(config.backupDir, requestId);
    try { completed = await captureSet(requestId, directory); }
    catch (failure) {
      if (failure.code !== 'vcr_backup_references_missing' || signal.aborted) {
        const reason = await failed(failure);
        throw reason;
      }
      // A set known to be incomplete is not kept: it is the attempt's own
      // directory, and the next one starts from a new dump.
      missing = failure.missing;
      await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }
  if (!completed) {
    await writeJson(statusFile, { schemaVersion: 1, status: 'deferred', lastAttemptAt: started, code: 'vcr_backup_references_missing',
      missing, attempts: taken, lastSuccessAt: previous?.lastSuccessAt ?? null }, 0o644);
    return { status: 'deferred', missing, attempts: taken };
  }
  try { await retainVerifiedSets(config, completed.recoverySet); }
  catch {
    await writeJson(statusFile, { schemaVersion: 1, status: 'failed', lastAttemptAt: started, code: 'vcr_backup_retention_failed' }, 0o644);
    throw error('vcr_backup_retention_failed');
  }
  await writeJson(statusFile, { schemaVersion: 1, status: 'healthy', recoverySet: completed.recoverySet,
    lastSuccessAt: completed.captureFinishedAt, lastDrillAt: completed.captureFinishedAt, coverage: Object.keys(completed.members),
    numericOwnersVerified: true, consistency: completed.consistency, atomicAcrossComponents: false,
    postgresSnapshotId: completed.postgres.snapshotId, dataPlaneIdentity, references: completed.references,
    receiptSha256: hash(Buffer.from(`${JSON.stringify(completed)}\n`)) }, 0o644);
  return completed;
}
