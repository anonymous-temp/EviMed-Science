#!/usr/bin/env node
/**
 * Evaluate a labelled matching set with the evaluator production runs (OpenMed B03).
 *
 * The day an independently labelled Chinese set arrives - patient-level cases in the shape of
 * `matching-eval-sample.json`, gold criterion states from two raters, `"synthetic": false` - this is the
 * whole procedure:
 *
 *   node evals/vcr-matching/run_matching_evaluation.mjs --dataset <set.json> [--out <report.json>]
 *
 * - The cases go through `assessSubject`, the code a study's matching runs, so the report cannot score a
 *   different path than production (`runMatchingEvaluation`).
 * - The report carries the SHA-256 of the file as read: the freeze. Write the digest down before any prompt
 *   is tuned; a later report with another digest was not run on the same holdout.
 * - It reports unknown, not applicable and not satisfied apart, the subject-level recall and false-exclusion
 *   rate, and the agreement between the two raters as a property of that set. It has no pass mark.
 * - It makes no model call and reads no other file. A file that is not a labelled set is refused by name,
 *   never scored as an empty report.
 *
 * The facts in the set are whatever extraction produced them; running the extraction itself over chart
 * text is the clinical extraction runners' job, under the terms of the set's data class.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runMatchingEvaluation } from '../../apps/server/src/vcrMatching.mjs';

/**
 * @param {Buffer} bytes the dataset file as read
 * @returns {{ report: any, dataset: { sha256: string, cases: number, criteria: number } }}
 */
export function evaluateDataset(bytes) {
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('The file is not valid JSON, so it is not a labelled matching set.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.cases) || !parsed.cases.length) {
    throw new Error('The file is not a labelled matching set: it needs a non-empty "cases" array (see evals/vcr-matching/matching-eval-sample.json).');
  }
  for (const [index, item] of parsed.cases.entries()) {
    if (!item || typeof item !== 'object' || !String(item.subjectKey ?? '').trim()) {
      throw new Error(`Case ${index + 1} has no subjectKey; every case of a labelled matching set names its subject.`);
    }
  }
  return {
    report: runMatchingEvaluation(parsed),
    dataset: {
      sha256: createHash('sha256').update(bytes).digest('hex'),
      cases: parsed.cases.length,
      criteria: Array.isArray(parsed.criteria) ? parsed.criteria.length : 0,
    },
  };
}

async function main() {
  let values;
  try {
    ({ values } = parseArgs({ options: { dataset: { type: 'string' }, out: { type: 'string' } }, strict: true }));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  if (!values.dataset) {
    process.stderr.write('Name the labelled set with --dataset <file>; --out <file> writes the report there instead of printing it.\n');
    return 2;
  }
  let bytes;
  try {
    bytes = await readFile(values.dataset);
  } catch (error) {
    process.stderr.write(`Cannot read ${values.dataset}: ${error instanceof Error && 'code' in error ? error.code : 'unreadable'}\n`);
    return 2;
  }
  let result;
  try {
    result = evaluateDataset(bytes);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const text = `${JSON.stringify({ ...result.report, dataset: result.dataset }, null, 2)}\n`;
  if (values.out) {
    await writeFile(values.out, text);
    process.stdout.write(`${values.out}  (dataset sha256 ${result.dataset.sha256})\n`);
  } else {
    process.stdout.write(text);
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
