#!/usr/bin/env node
/**
 * The official n2c2 test gold as the scorer's labels, once, after the prompts are frozen: the training labels and the 86 test patients' tags in one private file,
 * so `score.py f --split test --unseal` can read the test patients and take the majority baseline from the training ones as it does for the other splits.
 *
 *   node unseal_f.mjs --n2c2-root <dir> --labels <training labels dir> --out <private dir>
 *
 * Written once: an existing file is never replaced. The gold is unpacked into a private directory and removed; nothing here prints a tag.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { openSealedGold } from '../vcr-matching/n2c2/gold.mjs';
import { fail } from './board_cases.mjs';

/** @param {string} root @param {string} labels @param {string} out */
export async function unsealLabels(root, labels, out) {
  const training = fs.readFileSync(path.join(labels, 'F-n2c2', 'labels.jsonl'), 'utf8').split('\n').filter((line) => line.trim());
  const gold = await openSealedGold(root);
  try {
    const rows = Object.entries(gold.tags).map(([id, tags]) => JSON.stringify({ patientId: `n2c2-${id}`, split: 'test', tags }));
    if (!rows.length) throw fail('The sealed archive holds no patient.', 'no_labels');
    const file = path.join(out, 'F-n2c2', 'labels.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, `${[...training, ...rows].join('\n')}\n`, { flag: 'wx', mode: 0o600 });
    return { training: training.length, test: rows.length };
  } finally {
    await gold.cleanup();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { 'n2c2-root': { type: 'string' }, labels: { type: 'string' }, out: { type: 'string' } } });
  if (!values['n2c2-root'] || !values.labels || !values.out) throw fail('--n2c2-root, --labels and --out are required.', 'option_missing');
  process.stdout.write(`${JSON.stringify(await unsealLabels(values['n2c2-root'], values.labels, values.out))}\n`);
}
