// Restore one scoped encrypted member using the existing descriptor-held
// numeric-owner restorer. No users/ shape assumption applies to these roots.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const ops = path.dirname(fileURLToPath(import.meta.url));
const archive = process.argv[2];
if (!archive || !path.isAbsolute(archive) || process.getuid?.() !== 0) throw new Error('vcr_restore_drill_host_root_required');
const parent = path.dirname(archive);
const scratch = await fs.mkdtemp(path.join(parent, '.vcr-restore-drill-'));
await fs.chmod(scratch, 0o700);
try {
  const receipt = path.join(scratch, 'verification.json');
  await execute('bash', [path.join(ops, 'restore-data.sh'), '--numeric-owner', archive, path.join(scratch, 'payload')], {
    env: { ...process.env, OPEN_SCIENCE_RESTORE_VERIFICATION_FILE: receipt }, timeout: 1800_000, maxBuffer: 65536,
  });
  const result = JSON.parse(await fs.readFile(receipt, 'utf8'));
  if (result.verification !== 'inventory-v1' || result.numericOwnersVerified !== true) throw new Error('vcr_restore_drill_incomplete');
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch {
  process.exitCode = 1;
  process.stderr.write('vcr_restore_drill_failed\n');
} finally {
  // The numeric-owner restorer already required root's DAC/FOWNER capabilities.
  // Ordinary prepare-cleanup refuses uid10001 entries, so remove only this
  // newly created root-owned private tree using those checked capabilities.
  try { await fs.rm(scratch, { recursive: true }); }
  catch { process.exitCode = 1; process.stderr.write('vcr_restore_cleanup_failed\n'); }
}
