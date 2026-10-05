import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseFileReferences, verifyFileReferences } from '../../../scripts/ops/vcr-backup-references.mjs';

const execute = promisify(execFile);
const ops = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../scripts/ops');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('a capture receipt names files by relative location, and anything that could leave the plane is refused', () => {
  const good = parseFileReferences({ fileReferences: [{ location: `studies/s1/sources/a/${sha('x')}.csv`, sha256: sha('x') },
    { location: 'studies/s1/.pseudonym-key', sha256: null }] });
  assert.equal(good.length, 2);
  for (const location of ['../escape', '/absolute', 'studies/../x', 'studies//x', 'studies\\x', 'a\0b', '', './x']) {
    assert.throws(() => parseFileReferences({ fileReferences: [{ location, sha256: null }] }), { code: 'vcr_backup_references_invalid' }, location);
  }
  assert.throws(() => parseFileReferences({ fileReferences: [{ location: 'a/b', sha256: 'not-a-hash' }] }), { code: 'vcr_backup_references_invalid' });
  assert.throws(() => parseFileReferences({}), { code: 'vcr_backup_references_invalid' });
  assert.throws(() => parseFileReferences({ fileReferences: 'studies/x' }), { code: 'vcr_backup_references_invalid' });
});

async function plane(t) {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'vcr-refs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('verification tells a missing file from a file with other bytes, and does not follow a link', async t => {
  const root = await plane(t);
  const body = 'subject,age\nP1,41\n';
  const location = `studies/s1/sources/a/${sha(body)}.csv`;
  await mkdir(path.join(root, 'studies/s1/sources/a'), { recursive: true });
  await writeFile(path.join(root, location), body);
  await writeFile(path.join(root, 'studies/s1/.pseudonym-key'), 'key\n');
  const named = [{ location, sha256: sha(body) }, { location: 'studies/s1/.pseudonym-key', sha256: null }];
  assert.deepEqual(await verifyFileReferences(root, named), { checked: 2, missing: 0, mismatched: 0, sample: [] });

  const gone = [...named, { location: 'studies/s1/identity/snap.csv', sha256: null }, { location: 'studies/s2/x/y.csv', sha256: sha('y') }];
  assert.deepEqual(await verifyFileReferences(root, gone), { checked: 4, missing: 2, mismatched: 0,
    sample: ['studies/s1/identity/snap.csv', 'studies/s2/x/y.csv'] });

  await writeFile(path.join(root, location), 'subject,age\nP1,99\n');
  assert.equal((await verifyFileReferences(root, named)).mismatched, 1);

  const elsewhere = path.join(root, 'elsewhere');
  await writeFile(elsewhere, body);
  await rm(path.join(root, location));
  await symlink(elsewhere, path.join(root, location));
  assert.equal((await verifyFileReferences(root, named)).mismatched, 1, 'a link is not the file the row names');
  await rm(path.join(root, 'studies/s1/.pseudonym-key'));
  await mkdir(path.join(root, 'studies/s1/.pseudonym-key'));
  assert.equal((await verifyFileReferences(root, [named[1]])).mismatched, 1, 'a directory is not the file the row names');
});

// The restore the cycle's drill performs, with the real archive and restore scripts (the
// numeric-owner restorer needs root, so this restores through the ordinary path — the bytes
// and the inventory check are the same). A plane that is written while it is archived, a
// dump taken before the archive, and the archive held against what the dump names.
async function archiveAndRestore(t, root) {
  const work = await mkdtemp(path.join(await realpath(os.tmpdir()), 'vcr-refs-work-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const phrase = path.join(work, 'phrase');
  await writeFile(phrase, 'fixture-passphrase-for-live-plane-archive\n', { mode: 0o400 });
  const env = { ...process.env, OPEN_SCIENCE_BACKUP_STRICT: 'false', OPEN_SCIENCE_BACKUP_PASSPHRASE_FILE: phrase,
    OPEN_SCIENCE_BACKUP_RETENTION_DAYS: '', OPEN_SCIENCE_OBJECT_BACKUP_URI: '' };
  const backups = path.join(work, 'backups');
  const archive = (await execute('bash', [path.join(ops, 'backup-data.sh'), root, backups], { env })).stdout.trim().split(/\r?\n/).at(-1);
  const restored = path.join(work, 'restored');
  await execute('bash', [path.join(ops, 'restore-data.sh'), archive, restored], { env });
  return restored;
}

test('a plane archived while it is written restores every file the dump names, and leaves its scratch behind', async t => {
  const root = await plane(t);
  const files = { census: 'subject,age\nP1,41\nP2,52\n', events: 'subject,time\nP1,5\n' };
  const named = [];
  for (const [name, body] of Object.entries(files)) {
    const location = `studies/s1/tables/snap1/${name}/${sha(body)}.csv`;
    await mkdir(path.dirname(path.join(root, location)), { recursive: true });
    await writeFile(path.join(root, location), body);
    named.push({ location, sha256: sha(body) });
  }
  await writeFile(path.join(root, 'studies/s1/.pseudonym-key'), 'key\n');
  named.push({ location: 'studies/s1/.pseudonym-key', sha256: null });
  // What the writers do while the capture runs: a record in conversion, a file mid-write, a new upload.
  await mkdir(path.join(root, 'studies/s1/.intake/0f0f0f0f-0000-0000-0000-000000000000/in'), { recursive: true });
  await writeFile(path.join(root, 'studies/s1/.intake/0f0f0f0f-0000-0000-0000-000000000000/in/document.pdf'), 'a patient record');
  await writeFile(path.join(root, `studies/s1/tables/snap1/census/${sha('next')}.csv.0f0f0f0f-1111-2222-3333-444444444444.part`), 'half');
  await mkdir(path.join(root, 'studies/s1/sources/b'), { recursive: true });
  await writeFile(path.join(root, `studies/s1/sources/b/${sha('new upload')}.csv`), 'new upload');

  const restored = await archiveAndRestore(t, root);
  assert.deepEqual(await verifyFileReferences(restored, named), { checked: 3, missing: 0, mismatched: 0, sample: [] });
  assert.equal((await readdir(path.join(restored, 'studies/s1'))).includes('.intake'), false, 'conversion scratch never reaches the archive');
  const census = await readdir(path.join(restored, 'studies/s1/tables/snap1/census'));
  assert.deepEqual(census, [`${sha(files.census)}.csv`], 'a half-written file is not archived');
});

test('a file deleted between the dump and the archive is found by the check, which is what makes the set retry', async t => {
  const root = await plane(t);
  const body = 'subject,age\nP1,41\n';
  const location = `studies/s1/sources/a/${sha(body)}.csv`;
  await mkdir(path.dirname(path.join(root, location)), { recursive: true });
  await writeFile(path.join(root, location), body);
  await writeFile(path.join(root, 'keep.txt'), 'unrelated');
  const named = [{ location, sha256: sha(body) }];
  // The dump named it; the researcher then removed the upload; the archive is taken.
  await rm(path.join(root, location));
  const restored = await archiveAndRestore(t, root);
  assert.deepEqual(await verifyFileReferences(restored, named), { checked: 1, missing: 1, mismatched: 0, sample: [location] });
});
