/**
 * Reading the n2c2 2018 Track 1 files, and the paths of the local, gitignored data they come from.
 *
 * The data are real clinical notes. They live under `.evimed-local/acceptance/n2c2-2018-t1/` and nothing here copies, prints or
 * writes patient text anywhere else: the runner caches the model's raw answers (which quote the notes) beside the data, never in
 * the repository, and every file in this directory that reaches the repository carries aggregates only.
 *
 * The sealed test gold is not read in this file. `gold.mjs` is the one module that knows its path, and `run_n2c2.mjs` imports it
 * only in the `score-test` mode, after the frozen manifest has been checked.
 *
 * @module n2c2/data
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { TAGS } from './criteria.mjs';

/** The directory holding `raw/`, `sealed/`, `work/` and `runs/`. @param {string | undefined} [override] */
export function dataRoot(override) {
  const configured = override ?? process.env.EVIMED_N2C2_ROOT;
  if (configured) return path.resolve(configured);
  // Two levels above OpenScience/ is the workspace root, where `.evimed-local/` sits in a main checkout.
  return path.resolve(import.meta.dirname, '../../../../.evimed-local/acceptance/n2c2-2018-t1');
}

/** @param {string} root */
export function dataPaths(root) {
  return {
    root,
    trainDir: path.join(root, 'work', 'train', 'train'),
    testDir: path.join(root, 'work', 'test', 'test_notags'),
    scorer: path.join(root, 'work', 'eval', 'track1_eval.py'),
    runs: path.join(root, 'runs'),
    sums: path.join(root, 'SHA256SUMS'),
  };
}

/** True when the unpacked train and test directories are there; the tests skip without them. @param {string} root */
export function dataAvailable(root) {
  const paths = dataPaths(root);
  return existsSync(paths.trainDir) && existsSync(paths.testDir);
}

const OPEN = '<TEXT><![CDATA[';
const CLOSE = ']]></TEXT>';
const TAG_ATTRIBUTE = /<([A-Z0-9-]+)\s+[^>]*?\bmet="([^"]*)"/g;
const TAG_ATTRIBUTE_TEST = /<[A-Z0-9-]+\s+[^>]*?\bmet="/;

/** The sealed gold archive's name, as `SHA256SUMS` lists it. Where the file is, only `gold.mjs` knows. */
export const SEALED_ARCHIVE = 'n2c2-t1_gold_standard_test_data.zip';

/**
 * One patient file: the text exactly as the CDATA block holds it, and the gold tags when the file has them.
 * @param {string} xml
 * @returns {{ text: string, tags: Record<string, 'met' | 'not met'> | null }}
 */
export function parsePatientXml(xml) {
  const from = xml.indexOf(OPEN);
  const to = xml.lastIndexOf(CLOSE);
  if (from < 0 || to < from) throw new Error('The file has no TEXT block.');
  const text = xml.slice(from + OPEN.length, to);
  const block = /<TAGS>([\s\S]*?)<\/TAGS>/.exec(xml.slice(to));
  if (!block) return { text, tags: null };
  /** @type {Record<string, 'met' | 'not met'>} */
  const tags = {};
  // An unannotated file carries an empty TAGS block.
  if (!TAG_ATTRIBUTE_TEST.test(block[1])) return { text, tags: null };
  for (const match of block[1].matchAll(TAG_ATTRIBUTE)) {
    if (match[2] !== 'met' && match[2] !== 'not met') throw new Error(`Unexpected value for ${match[1]}: only met and not met are scored.`);
    tags[match[1]] = match[2];
  }
  const missing = TAGS.filter((tag) => !tags[tag]);
  if (missing.length) throw new Error(`The file lacks tags: ${missing.join(', ')}`);
  return { text, tags };
}

/**
 * The dates of the records in a patient file. Each record opens with a `Record date: YYYY-MM-DD` line; that line is the
 * dataset's own format, and its date is the only one read by code.
 * @param {string} text
 */
export function recordDates(text) {
  return [...text.matchAll(/^Record date: (\d{4}-\d{2}-\d{2})[ \t]*$/gm)].map((match) => match[1]).filter((date) => Number.isFinite(Date.parse(date)));
}

/**
 * "Now" for a patient: the guide (section 2) says the most recent record is now, whatever its calendar date.
 * @param {string} text @returns {string | null}
 */
export function evaluationDate(text) {
  const dates = recordDates(text).sort();
  return dates.length ? dates[dates.length - 1] : null;
}

/** @param {string} directory @returns {Promise<string[]>} patient ids (file names without .xml), sorted */
export async function patientIds(directory) {
  return (await readdir(directory)).filter((name) => name.endsWith('.xml')).map((name) => name.slice(0, -4)).sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
}

/** @param {string} directory @param {string} id */
export async function readPatient(directory, id) {
  const parsed = parsePatientXml(await readFile(path.join(directory, `${id}.xml`), 'utf8'));
  return { id, ...parsed, asOf: evaluationDate(parsed.text) };
}

/** The development split's rule: a salted hash orders the training patients and the first 40 are the development set. */
export const DEV_SPLIT = Object.freeze({ salt: 'n2c2-dev-v1', size: 40 });

/**
 * Forty of the training patients, chosen by a fixed hash so the choice is reproducible and made before any note is read.
 * @param {readonly string[]} trainIds @param {{ salt: string, size: number }} [rule]
 */
export function developmentIds(trainIds, rule = DEV_SPLIT) {
  const rank = (/** @type {string} */ id) => createHash('sha256').update(`${rule.salt}:${id}`).digest('hex');
  return [...trainIds].sort((a, b) => (rank(a) < rank(b) ? -1 : rank(a) > rank(b) ? 1 : 0)).slice(0, rule.size).sort((a, b) => Number(a) - Number(b));
}

/** A digest of a list of ids, for the manifest. @param {readonly string[]} ids */
export function idsDigest(ids) {
  return createHash('sha256').update([...ids].sort().join('\n')).digest('hex');
}

/** @param {string | Buffer} bytes */
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
