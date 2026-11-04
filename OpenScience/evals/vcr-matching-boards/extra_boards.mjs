/**
 * Boards added after the first three (A, B, C), kept apart so nothing about those changes: F, the n2c2 2018 Track 1 cohort-selection
 * notes (real, de-identified; one protocol of thirteen criteria against a roster of patients), and G, Chinese robustness (the notes
 * of the SIGIR and TREC dev topics translated once into Simplified Chinese, the trials left in English, the same qrels).
 *
 * Their prepared inputs live in their own private directories, apart from the first boards' (whose digests `prepare.py` checks):
 * `--n2c2-boards` / `VCR_BOARDS_N2C2` and `--zh-boards` / `VCR_BOARDS_ZH`. The collections and the scorer's qrels stay the first boards'.
 */
import fs from 'node:fs';
import path from 'node:path';
import { BOARDS, fail } from './board_cases.mjs';

export const N2C2_SPLITS = Object.freeze(['train-dev', 'train-heldout', 'test']);

/** @type {Readonly<Record<string, { dir: string, scorer: 'a' | 'f', cohort: string, answer: 'ranking' | 'protocol', source: 'n2c2' | 'zh', splits: readonly string[], of?: keyof typeof BOARDS }>>} */
export const EXTRA_BOARDS = Object.freeze({
  n2c2: Object.freeze({ dir: 'F-n2c2', scorer: 'f', cohort: 'n2c2', answer: 'protocol', source: 'n2c2', splits: N2C2_SPLITS }),
  'sigir-zh': Object.freeze({ dir: 'A-sigir-zh', scorer: 'a', cohort: 'sigir', answer: 'ranking', source: 'zh', splits: ['dev', 'all'], of: 'sigir' }),
  'trec2021-zh-dev': Object.freeze({ dir: 'A-trec2021-zh-dev', scorer: 'a', cohort: 'trec_2021', answer: 'ranking', source: 'zh', splits: ['dev', 'all'], of: 'trec2021' }),
  'trec2022-zh-dev': Object.freeze({ dir: 'A-trec2022-zh-dev', scorer: 'a', cohort: 'trec_2022', answer: 'ranking', source: 'zh', splits: ['dev', 'all'], of: 'trec2022' }),
});

/** The spec of a board by name, from the first boards or these. @param {string} name */
export const boardSpec = (name) => (Object.hasOwn(BOARDS, name) ? BOARDS[/** @type {keyof typeof BOARDS} */ (name)] : Object.hasOwn(EXTRA_BOARDS, name) ? EXTRA_BOARDS[name] : null);
export const boardNames = () => [...Object.keys(BOARDS), ...Object.keys(EXTRA_BOARDS)];

/**
 * The cases of an extra board. The n2c2 test split is sealed: it is refused unless the caller says it is unsealed, which no run of
 * this stream does, and its notes are read from a file of their own that `prepare_f.mjs` writes only on request.
 * @param {string} root the board's prepared directory @param {string} name
 * @param {{ split: string, limit?: number | null, unseal?: boolean }} options
 * @returns {Array<Record<string, any>>}
 */
export function loadExtraCases(root, name, { split, limit = null, unseal = false }) {
  const spec = EXTRA_BOARDS[name];
  if (!spec) throw fail(`Unknown board ${name}.`, 'board_unknown');
  if (!spec.splits.includes(split)) throw fail(`The ${name} board has the splits ${spec.splits.join(', ')}.`, 'split_unknown');
  if (name === 'n2c2' && split === 'test' && !unseal) throw fail('The n2c2 test split is sealed: it is run once, by the owner, with --unseal. Nothing in this stream passes it.', 'test_sealed');
  const file = path.join(root, spec.dir, name === 'n2c2' && split === 'test' ? 'cases-test.jsonl' : 'cases.jsonl');
  const rows = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
  const chosen = rows.filter((row) => split === 'all' || row.split === split);
  const cut = limit == null ? chosen : chosen.slice(0, Math.max(0, limit));
  for (const row of cut) if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(row.patientId ?? ''))) throw fail('A case has an unsafe patient id.', 'case_invalid');
  return cut;
}
