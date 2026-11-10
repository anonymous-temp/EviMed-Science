#!/usr/bin/env node
// Offline report only: preserve the original rows. Legacy g4.mjs scanned places before calling relearn().
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { g4DeletionVerdict, summarizeG4 } from './classify.mjs';
import { readRows } from './common.mjs';

const runDir = process.argv[2];
if (!runDir) throw new Error('Usage: node reclassify-g4.mjs <run-directory>');
const rows = await readRows(path.join(runDir, 'trials.jsonl'));
const corrected = rows.map((row) => {
  const verdict = g4DeletionVerdict(row);
  const outcome = row.relearnOutcome?.outcome;
  return { ...verdict, deletionScanEvidence: row.beforeRestatement ? 'explicit-before-restatement' : 'legacy-places-before-relearn-call',
    relearnedAfterRestatement: row.relearnedAfterRestatement ?? (outcome === 'stored' ? true : ['refused', 'not-stored'].includes(outcome) ? false : null),
    relearnPlaces: row.relearnPlaces ?? (Array.isArray(row.relearnOutcome?.files) ? { 'engine-files': { where: row.relearnOutcome.files } } : null) };
});
const report = {
  runId: path.basename(runDir), writtenAt: new Date().toISOString(),
  source: 'trials.jsonl (unchanged)',
  limitation: 'Legacy places are pre-restatement by runner control flow; no separate full post-restatement scan was saved. Stored outcomes/files support legacy relearning rates. A stored outcome cannot invalidate an earlier positive scan.',
  ...summarizeG4(corrected),
};
await writeFile(path.join(runDir, 'restatement-corrected-trials.jsonl'), corrected.map((row) => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
await writeFile(path.join(runDir, 'restatement-corrected-summary.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
process.stdout.write(JSON.stringify({ totals: report.totals, redLines: report.redLines }) + '\n');
