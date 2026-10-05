// Restore one scoped encrypted member using the existing descriptor-held
// numeric-owner restorer. No users/ shape assumption applies to these roots.
//
//   vcr-restore-drill.mjs <archive> [--references <capture receipt>]
//
// With a capture receipt, the restored tree is also held against the files that
// receipt's database dump names (`vcr-backup-references.mjs`): the answer then
// carries `references` — how many were checked and how many were missing or had
// other bytes — and the caller decides what a missing file means. The drill's own
// verdict is only that the member restores.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parseFileReferences, verifyFileReferences } from './vcr-backup-references.mjs';

const execute = promisify(execFile);
const ops = path.dirname(fileURLToPath(import.meta.url));
const archive = process.argv[2];
const receiptFile = process.argv[3] === '--references' ? process.argv[4] : null;
if (!archive || !path.isAbsolute(archive) || process.getuid?.() !== 0) throw new Error('vcr_restore_drill_host_root_required');
if (process.argv.length > 3 && (!receiptFile || !path.isAbsolute(receiptFile) || process.argv.length !== 5)) throw new Error('vcr_restore_drill_arguments_invalid');
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
  if (receiptFile) {
    const references = parseFileReferences(JSON.parse(await fs.readFile(receiptFile, 'utf8')));
    result.references = await verifyFileReferences(path.join(scratch, 'payload'), references);
  }
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
