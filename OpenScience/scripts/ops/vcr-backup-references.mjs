// The data-plane files a PostgreSQL capture names, and the check that a restored
// file archive holds every one of them with the bytes it names.
//
// Hidden knowledge:
//
// - **This check is what replaces the quiet window.** A recovery set is three
//   members taken at three moments: the database dump (one exported snapshot),
//   the data-plane archive and the jobs archive. The set used to be made
//   consistent by stopping the whole platform for the duration, which a busy
//   platform never allowed. What a restore of the set needs is narrower: every
//   file a row of the dump names is in the file archive, with the bytes the row
//   names. That is decidable, so it is decided here, on the restored files,
//   instead of being assumed from a quiet minute.
// - **Why it holds without stopping anything** (the argument the cycle's own
//   comment makes at the point of decision): the plane's files are written
//   before the row that names them and are never rewritten in place (each is
//   named by the hash of its bytes, and what is not — the study's key, a
//   snapshot's identity map — is created once or replaced by rename). So a file
//   the dump names already existed when the snapshot was exported, and the
//   archive is taken after the dump. The one thing that can break it is a
//   deletion between the two, and a deletion is exactly what this check finds.
// - **Missing and wrong are different findings.** A file that is gone is a
//   deletion that raced the capture: the set is retried (and, if it keeps
//   happening, deferred). A file that is there with other bytes is not a race —
//   no writer produces it — so it is a failure, never retried into silence.
// - Locations come out of a database, so each is treated as untrusted input:
//   anything that is not a relative path inside the root, or that reaches its
//   file through a link, is a wrong file, not a path to follow.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const SHA256 = /^[a-f0-9]{64}$/;
/** The most a capture receipt may carry; the Python writer refuses more. */
export const VCR_REFERENCES_LIMIT = 200_000;

/** Validate the `fileReferences` of a capture receipt into `{ location, sha256|null }` rows. */
export function parseFileReferences(receipt) {
  const rows = receipt?.fileReferences;
  if (!Array.isArray(rows) || rows.length > VCR_REFERENCES_LIMIT) {
    throw Object.assign(new Error('vcr_backup_references_invalid'), { code: 'vcr_backup_references_invalid' });
  }
  return rows.map(row => {
    const location = row?.location;
    const sha256 = row?.sha256 ?? null;
    if (typeof location !== 'string' || !location || location.includes('\0') || location.includes('\\')
      || location.startsWith('/') || location.split('/').some(part => part === '' || part === '.' || part === '..')
      || !(sha256 === null || (typeof sha256 === 'string' && SHA256.test(sha256)))) {
      throw Object.assign(new Error('vcr_backup_references_invalid'), { code: 'vcr_backup_references_invalid' });
    }
    return { location, sha256 };
  });
}

async function sha256Of(handle) {
  const digest = createHash('sha256');
  for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk);
  return digest.digest('hex');
}

/**
 * Check every reference against a restored tree.
 * @param {string} root the restored data-plane root
 * @param {{ location: string, sha256: string | null }[]} references
 * @returns {Promise<{ checked: number, missing: number, mismatched: number, sample: string[] }>}
 *   `sample` names at most five locations that were missing or wrong, for the log
 *   of an operator; a location is a path inside the plane, never patient content.
 */
export async function verifyFileReferences(root, references) {
  let missing = 0;
  let mismatched = 0;
  const sample = [];
  const note = location => { if (sample.length < 5) sample.push(location); };
  for (const { location, sha256 } of references) {
    const file = path.join(root, ...location.split('/'));
    let handle;
    try {
      // O_NOFOLLOW: a link in the archive is not the file the row names.
      handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (failure) {
      if (failure.code === 'ENOENT' || failure.code === 'ENOTDIR') { missing += 1; note(location); continue; }
      mismatched += 1; note(location); continue;
    }
    try {
      const info = await handle.stat();
      if (!info.isFile()) { mismatched += 1; note(location); continue; }
      if (sha256 !== null && await sha256Of(handle) !== sha256) { mismatched += 1; note(location); }
    } finally { await handle.close(); }
  }
  return { checked: references.length, missing, mismatched, sample };
}
