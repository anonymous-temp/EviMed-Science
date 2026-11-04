#!/usr/bin/env node
/**
 * Prepare board F from the unpacked n2c2 2018 Track 1 files: the notes the runners read, apart from the labels only the scorer reads.
 *
 *   node prepare_f.mjs --n2c2-root <dir with work/train/train> --out <inputs dir> --labels-out <labels dir>
 *
 * `<out>/F-n2c2/cases.jsonl` holds one case per training patient, `{ caseId, patientId, cohort, split, records: [{ date, text }], chars }`, the
 * records being the file's own `Record date:` blocks; the labels go to `<labels-out>/F-n2c2/labels.jsonl`, `{ patientId, split, tags }`.
 * The split is the one the n2c2 README used: the 40 development patients chosen by the fixed salted hash of `n2c2/data.mjs`, the other
 * 162 held out. The sealed test archive is not read here. The unannotated test notes are written only with `--with-test`, to a file of
 * their own that no run reads without `--unseal`; this stream does not use it.
 *
 * Written once: an existing file is never replaced. The notes never leave the private directories and nothing here prints one.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { DEV_SPLIT, dataPaths, developmentIds, idsDigest, parsePatientXml, patientIds } from '../vcr-matching/n2c2/data.mjs';
import { fail } from './board_cases.mjs';
import { recordsOfNote } from './n2c2_board.mjs';

const digest = (/** @type {string | Buffer} */ bytes) => createHash('sha256').update(bytes).digest('hex');

/** @param {string} file @param {string} text */
function writeOnce(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { flag: 'wx', mode: 0o600 });
}

/**
 * @param {{ root: string, out: string, labelsOut: string, rule?: { salt: string, size: number }, withTest?: boolean }} input
 * @returns {Promise<{ train: number, dev: number, heldout: number, test: number | null, casesSha256: string, devDigest: string, heldoutDigest: string }>}
 */
export async function prepareF({ root, out, labelsOut, rule = DEV_SPLIT, withTest = false }) {
  const paths = dataPaths(root);
  const ids = await patientIds(paths.trainDir);
  if (!ids.length) throw fail('No training patients under the n2c2 root.', 'no_data');
  const dev = new Set(developmentIds(ids, rule));
  /** @type {string[]} */ const cases = [];
  /** @type {string[]} */ const labels = [];
  for (const id of ids) {
    const parsed = parsePatientXml(fs.readFileSync(path.join(paths.trainDir, `${id}.xml`), 'utf8'));
    if (!parsed.tags) throw fail(`Training patient ${id} has no tags.`, 'no_labels');
    const split = dev.has(id) ? 'train-dev' : 'train-heldout';
    const records = recordsOfNote(parsed.text);
    cases.push(JSON.stringify({ caseId: `n2c2-${id}`, patientId: `n2c2-${id}`, cohort: 'n2c2', split, records, chars: parsed.text.length }));
    labels.push(JSON.stringify({ patientId: `n2c2-${id}`, split, tags: parsed.tags }));
  }
  const casesText = `${cases.join('\n')}\n`;
  const board = path.join(out, 'F-n2c2');
  writeOnce(path.join(board, 'cases.jsonl'), casesText);
  writeOnce(path.join(labelsOut, 'F-n2c2', 'labels.jsonl'), `${labels.join('\n')}\n`);
  let test = null;
  if (withTest) {
    const testIds = await patientIds(paths.testDir);
    const rows = testIds.map((id) => {
      const parsed = parsePatientXml(fs.readFileSync(path.join(paths.testDir, `${id}.xml`), 'utf8'));
      return JSON.stringify({ caseId: `n2c2-${id}`, patientId: `n2c2-${id}`, cohort: 'n2c2', split: 'test', records: recordsOfNote(parsed.text), chars: parsed.text.length });
    });
    writeOnce(path.join(board, 'cases-test.jsonl'), `${rows.join('\n')}\n`);
    test = rows.length;
  }
  const heldoutIds = ids.filter((id) => !dev.has(id));
  const manifest = {
    board: 'F-n2c2', rule: { ...rule, how: 'sha256(salt:id) orders the training patients; the first size are the development set' }, counts: { train: ids.length, dev: dev.size, heldout: heldoutIds.length, test },
    casesSha256: digest(casesText), devDigest: idsDigest([...dev]), heldoutDigest: idsDigest(heldoutIds), testSealed: true, note: 'notes only; labels are in a separate directory; the sealed test archive was not opened',
  };
  writeOnce(path.join(board, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { train: ids.length, dev: dev.size, heldout: heldoutIds.length, test, casesSha256: manifest.casesSha256, devDigest: manifest.devDigest, heldoutDigest: manifest.heldoutDigest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { 'n2c2-root': { type: 'string' }, out: { type: 'string' }, 'labels-out': { type: 'string' }, 'with-test': { type: 'boolean', default: false } } });
  const root = values['n2c2-root'] ?? process.env.EVIMED_N2C2_ROOT;
  if (!root || !values.out || !values['labels-out']) { process.stderr.write('usage: prepare_f.mjs --n2c2-root <dir> --out <inputs dir> --labels-out <labels dir> [--with-test]\n'); process.exit(2); }
  const result = await prepareF({ root: path.resolve(root), out: path.resolve(values.out), labelsOut: path.resolve(values['labels-out']), withTest: values['with-test'] });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
