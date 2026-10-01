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
