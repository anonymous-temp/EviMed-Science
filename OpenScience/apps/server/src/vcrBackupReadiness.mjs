import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertNoSymlinkPath } from './security.mjs';

/** Operational backup readiness, never a scientific delivery condition.
 * @param {Record<string, any>} config */
export async function vcrBackupReadiness(config) {
  if (!config.production || !config.vcrEnabled) return { required: false };
  const failure = code => Object.assign(new Error(code), { code });
  const file = config.vcrBackupStateFile;
  let state;
  try {
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('missing');
    const root = path.parse(file).root;
    await assertNoSymlinkPath(path.join(root, file.slice(root.length).split(path.sep)[0]), file);
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > 65536 || stat.mode & 0o022) throw new Error('invalid');
      state = JSON.parse(await handle.readFile('utf8'));
    } finally { await handle.close(); }
  } catch { throw failure('vcr_backup_status_unavailable'); }
  const now = Date.now();
  let dataPlaneIdentity;
  try {
    const plane = await fs.lstat(config.vcrDataPlaneDir);
    if (!plane.isDirectory() || plane.isSymbolicLink()) throw new Error('invalid');
    dataPlaneIdentity = createHash('sha256').update(`${plane.dev}:${plane.ino}`).digest('hex');
  } catch { throw failure('vcr_backup_unhealthy'); }
  const fresh = value => Number.isFinite(Date.parse(value)) && Date.parse(value) <= now + 300000
    && now - Date.parse(value) <= (config.vcrBackupMaxAgeSeconds ?? 90000) * 1000;
  if (state?.schemaVersion !== 1 || state.status !== 'healthy' || state.numericOwnersVerified !== true
    || state.consistency !== 'maintenance-held' || state.atomicAcrossComponents !== false
    || !Array.isArray(state.coverage) || state.coverage.length !== 2 || !state.coverage.includes('data-plane') || !state.coverage.includes('jobs')
    || !/^vcr-backup-[a-f0-9-]{36}$/.test(state.recoverySet ?? '') || !/^[a-f0-9]{64}$/.test(state.receiptSha256 ?? '')
    || state.dataPlaneIdentity !== dataPlaneIdentity
    || !/^[0-9a-f]+-[0-9a-f]+-\d+$/i.test(state.postgresSnapshotId ?? '') || !fresh(state.lastSuccessAt) || !fresh(state.lastDrillAt)) {
    throw failure('vcr_backup_unhealthy');
  }
  return { required: true, encrypted: true, coverage: state.coverage, numericOwnersVerified: true,
    consistency: state.consistency, atomicAcrossComponents: false, lastSuccessAt: state.lastSuccessAt };
}
