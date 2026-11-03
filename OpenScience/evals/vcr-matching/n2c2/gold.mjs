/**
 * The sealed test gold. This is the only module that knows where it is, and `run_n2c2.mjs` imports it dynamically in
 * `score-test` alone, after the frozen manifest has been checked and the test predictions have been written. No other mode
 * reaches this file, so nothing that tunes, predicts or reports on the development set can open the gold.
 *
 * The archive is unpacked into a private directory made for the call and removed when the caller is done; the unpacked copy
 * never goes anywhere near the repository.
 *
 * @module n2c2/gold
 */
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readdir, readFile, rm, copyFile, mkdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SEALED_ARCHIVE, parsePatientXml, sha256 } from './data.mjs';

/** @param {string} directory @returns {Promise<string[]>} */
async function xmlFilesUnder(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.name === '__MACOSX') continue;
    if (entry.isDirectory()) found.push(...await xmlFilesUnder(full));
    else if (entry.name.endsWith('.xml')) found.push(full);
  }
  return found;
}

/** The digest of the sealed archive, to be compared with the one the manifest recorded. @param {string} root */
export async function sealedDigest(root) {
  return sha256(await readFile(path.join(root, 'sealed', SEALED_ARCHIVE)));
}

/**
 * Unpack the gold and read its tags. Returns a flat folder of the gold files (what the official scorer takes) and the tags by id.
 * @param {string} root the data root
 * @returns {Promise<{ folder: string, tags: Record<string, Record<string, 'met' | 'not met'>>, cleanup: () => Promise<void> }>}
 */
export async function openSealedGold(root) {
  const archive = path.join(root, 'sealed', SEALED_ARCHIVE);
  await stat(archive);
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'n2c2-gold-'));
  await chmod(scratch, 0o700);
  const unpacked = path.join(scratch, 'unpacked');
  const folder = path.join(scratch, 'flat');
  await mkdir(unpacked);
  await mkdir(folder);
  const ran = spawnSync('unzip', ['-q', '-o', archive, '-d', unpacked, '-x', '__MACOSX/*'], { encoding: 'utf8' });
  if (ran.status !== 0) { await rm(scratch, { recursive: true, force: true }); throw new Error('The sealed archive could not be unpacked.'); }
  /** @type {Record<string, Record<string, 'met' | 'not met'>>} */
  const tags = {};
  for (const file of await xmlFilesUnder(unpacked)) {
    const id = path.basename(file, '.xml');
    const parsed = parsePatientXml(await readFile(file, 'utf8'));
    if (!parsed.tags) throw new Error(`The gold file ${id} has no tags.`);
    tags[id] = parsed.tags;
    await copyFile(file, path.join(folder, `${id}.xml`));
  }
  return { folder, tags, cleanup: () => rm(scratch, { recursive: true, force: true }) };
}
