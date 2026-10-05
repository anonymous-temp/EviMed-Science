import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { vcrBackupReadiness } from '../src/vcrBackupReadiness.mjs';

test('VCR-off and non-production deployments do not need VCR recovery storage', async () => {
  assert.deepEqual(await vcrBackupReadiness({ production: true, vcrEnabled: false }), { required: false });
  assert.deepEqual(await vcrBackupReadiness({ production: false, vcrEnabled: true }), { required: false });
});

test('production VCR cannot report covered from the unrelated ordinary backup alone', async t => {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'vcr-backup-status-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'state.json');
  const config = { production: true, vcrEnabled: true, vcrDataPlaneDir: root, vcrBackupStateFile: file, vcrBackupMaxAgeSeconds: 90000 };
  await assert.rejects(vcrBackupReadiness(config), { code: 'vcr_backup_status_unavailable' });
  const now = new Date().toISOString();
  const plane = await stat(root);
  const healthy = { schemaVersion: 1, status: 'healthy', recoverySet: 'vcr-backup-12345678-1234-1234-1234-123456789012',
    lastSuccessAt: now, lastDrillAt: now, coverage: ['data-plane', 'jobs'], numericOwnersVerified: true,
    consistency: 'maintenance-held', atomicAcrossComponents: false, postgresSnapshotId: '00000001-00000001-1',
    receiptSha256: 'a'.repeat(64), dataPlaneIdentity: createHash('sha256').update(`${plane.dev}:${plane.ino}`).digest('hex') };
  await writeFile(file, JSON.stringify(healthy), { mode: 0o644 });
  assert.equal((await vcrBackupReadiness(config)).required, true);
  for (const change of [{ coverage: ['jobs'] }, { numericOwnersVerified: false }, { status: 'failed' },
    { lastSuccessAt: '2000-01-01T00:00:00.000Z' }, { postgresSnapshotId: '' }, { consistency: 'uncoordinated' }, { dataPlaneIdentity: 'changed' }]) {
    await writeFile(file, JSON.stringify({ ...healthy, ...change }));
    await assert.rejects(vcrBackupReadiness(config), { code: 'vcr_backup_unhealthy' });
  }
  await rm(file); await symlink(path.join(root, 'outside'), file);
  await assert.rejects(vcrBackupReadiness(config), { code: 'vcr_backup_status_unavailable' });
  // The ordinary backup container gets neither patient data nor host authority.
  const overlay = await readFile(new URL('../../../deploy/web/docker-compose.vcr-backup.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(overlay, /docker\.sock|\/data-plane|evimed-vcr-jobs|operator.*token/i);
  assert.match(overlay, /read_only: true/);
});

test('a set the cycle deferred is a detail while it is recent, and a failure once it has stopped being a race', async t => {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'vcr-backup-deferred-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'state.json');
  const config = { production: true, vcrEnabled: true, vcrDataPlaneDir: root, vcrBackupStateFile: file, vcrBackupMaxAgeSeconds: 90000 };
  const ago = hours => new Date(Date.now() - hours * 3_600_000).toISOString();
  const deferred = { schemaVersion: 1, status: 'deferred', code: 'vcr_backup_references_missing', missing: 2, attempts: 3,
    lastAttemptAt: ago(1), lastSuccessAt: ago(25) };
  await writeFile(file, JSON.stringify(deferred), { mode: 0o644 });
  const answer = await vcrBackupReadiness(config);
  assert.equal(answer.deferred, true);
  assert.equal(answer.code, 'vcr_backup_references_missing');
  assert.equal(answer.lastSuccessAt, deferred.lastSuccessAt);
  // A first-ever set that is deferred has no earlier one to lean on, and is still a detail for a day.
  await writeFile(file, JSON.stringify({ ...deferred, lastSuccessAt: null }));
  assert.equal((await vcrBackupReadiness(config)).deferred, true);
  // Three maximum ages without a healthy set, an attempt that is itself stale, or a code
  // this state does not mean: all of them read as the unhealthy set they are.
  for (const change of [{ lastSuccessAt: ago(80) }, { lastAttemptAt: ago(30) }, { code: 'vcr_backup_cycle_failed' }]) {
    await writeFile(file, JSON.stringify({ ...deferred, ...change }));
    await assert.rejects(vcrBackupReadiness(config), { code: 'vcr_backup_unhealthy' });
  }
});

test('sets that verified their files against the dump are healthy, and so are yesterday\'s maintenance-held ones', async t => {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'vcr-backup-label-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'state.json');
  const config = { production: true, vcrEnabled: true, vcrDataPlaneDir: root, vcrBackupStateFile: file, vcrBackupMaxAgeSeconds: 90000 };
  const now = new Date().toISOString();
  const plane = await stat(root);
  const healthy = { schemaVersion: 1, status: 'healthy', recoverySet: 'vcr-backup-12345678-1234-1234-1234-123456789012',
    lastSuccessAt: now, lastDrillAt: now, coverage: ['data-plane', 'jobs'], numericOwnersVerified: true,
    consistency: 'references-verified', atomicAcrossComponents: false, postgresSnapshotId: '00000001-00000001-1',
    receiptSha256: 'a'.repeat(64), dataPlaneIdentity: createHash('sha256').update(`${plane.dev}:${plane.ino}`).digest('hex') };
  for (const consistency of ['references-verified', 'maintenance-held']) {
    await writeFile(file, JSON.stringify({ ...healthy, consistency }), { mode: 0o644 });
    assert.equal((await vcrBackupReadiness(config)).consistency, consistency);
  }
});
